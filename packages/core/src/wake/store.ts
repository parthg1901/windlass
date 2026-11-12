/**
 * Where wake-ups live: one SQLite database for the whole machine user, `<data dir>/wake/wake.db` (mode 0600, it
 * holds webhook secrets; the data directory is hidden from sandboxed commands). Not in the session files: those
 * have one writer each, and a wake-up must be found and fired while its session is closed or held by another
 * process. Every harness process opens it; writes are short transactions.
 *
 * Exactly one firing at a time. Work on a wake-up (running its check, recording a firing, delivering) happens
 * only under its lease: `lease_owner`, `lease_until` on its row, taken by a compare-and-set update. An owner is
 * one scheduler; while it lives it holds an operating-system lock on `owners/<owner id>-lock` (the store's writer
 * lock, `../store/sqlite-lock.ts`). Another process that finds a lease asks the operating system whether its owner
 * still holds that lock: if not, the owner died (also by SIGKILL) and the lease is free at once. A lease also
 * lapses at `lease_until` (two minutes, renewed while a check runs), for a holder that is alive but stuck; work
 * that finds its lease gone records nothing.
 *
 * Neither lost nor delivered twice. A firing is recorded (`firing` row, with its frozen text and its key) in the
 * same transaction that counts it, before anything is delivered. Delivery then hands it to the engine, which
 * admits it to the inbox with `Firing.key` as the message ID, and the firing is marked delivered. A process that
 * dies in between leaves the row open; whoever takes the lease next delivers the same row again, and the engine
 * recognises the key (the reducer refuses a reused message ID), so the message is in the session once.
 *
 * Catch-up: a wake-up that was due while nothing ran is due now and fires once; its next time is computed from now
 * (`nextAfter`). A one-shot is still delivered for a day after its time, then expires.
 */
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { StoreLockedError, acquireWriterLock } from "../store/sqlite-lock.ts"
import { type Infer, safeDecode } from "../validate.ts"
import { type WakeClock, systemClock } from "./clock.ts"
import {
  type Author,
  type Firing,
  type NewWake,
  type RunAs,
  type Trigger,
  type WakeDelivery,
  type WakeStateKind,
  type WakeUp,
  WAKE_LIMITS,
  deliveryBackoff,
  firingKey,
  newWakeId,
  nextAfter,
  prepareWake,
  provenance,
  runAs,
  trigger,
} from "./record.ts"

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wake (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  trigger TEXT NOT NULL,
  delivery TEXT NOT NULL,
  max_firings INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  min_interval_ms INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  run TEXT,
  cwd TEXT,
  secret TEXT,
  state TEXT NOT NULL,
  state_at INTEGER,
  state_reason TEXT,
  state_by TEXT,
  fired INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  last_fired_at INTEGER,
  errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_run TEXT,
  observed TEXT,
  held TEXT,
  created_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER
);
CREATE INDEX IF NOT EXISTS wake_session ON wake (session_id, state);
CREATE INDEX IF NOT EXISTS wake_due ON wake (state, next_at);
CREATE TABLE IF NOT EXISTS firing (
  key TEXT PRIMARY KEY,
  wake_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  source TEXT NOT NULL,
  delivery TEXT NOT NULL,
  text TEXT NOT NULL,
  untrusted INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL,
  last_error TEXT,
  delivered_at INTEGER,
  dropped_at INTEGER,
  drop_reason TEXT
);
CREATE INDEX IF NOT EXISTS firing_open ON firing (wake_id, n) WHERE delivered_at IS NULL AND dropped_at IS NULL;
CREATE INDEX IF NOT EXISTS firing_session ON firing (session_id, created_at);
CREATE TABLE IF NOT EXISTS seen (
  wake_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (wake_id, digest)
);
`

export interface WakeStoreOptions {
  /** The directory of the database and the owners' locks: `wakeDirectory(dataDir)`. */
  readonly dir: string
  readonly clock?: WakeClock
  /** Firings per session per rolling hour. Default and maximum in `WAKE_LIMITS.hourlyCeiling`. */
  readonly hourlyCeiling?: number
  /** Pending wake-ups per session, by who creates them. Never above `WAKE_LIMITS[author].maxActive`. */
  readonly maxActive?: { readonly model?: number; readonly user?: number }
  /** How long a lease lasts unless renewed. Default 2 minutes. */
  readonly leaseMs?: number
  readonly busyTimeoutMs?: number
}

export function wakeDirectory(dataDir: string): string {
  return join(dataDir, "wake")
}

/** One scheduler's identity. While it is open the operating system holds its lock; `close` lets it go. */
export interface WakeOwner {
  readonly id: string
  readonly close: () => void
}

/** A wake-up this owner now holds the lease of, and what to do with it. */
export interface Claim {
  readonly wake: WakeUp
  /** `deliver`: firings recorded earlier wait (oldest first). `evaluate`: it is due, or expired. */
  readonly work: "deliver" | "evaluate"
  readonly open: readonly Firing[]
  /** For an `on_change` check: the fingerprint of the run before, `null` before the first run. */
  readonly observed: string | null
}

export type CreateResult =
  | { readonly ok: true; readonly wake: WakeUp; /** A webhook's secret, for the user; `null` otherwise. */ readonly secret: string | null }
  /** `limit`: nothing is wrong with what was asked for; the session has no room for another wake-up. */
  | { readonly ok: false; readonly error: string; readonly limit?: true }

export type WebhookOutcome =
  | { readonly kind: "accepted"; readonly firing: Firing }
  /** The signature was valid once already. */
  | { readonly kind: "replayed" }
  /** No such pending webhook wake-up (unknown, ended, expired, or another trigger). */
  | { readonly kind: "unavailable" }
  /** Valid, but a limit holds it back: its minimum interval or the session's hourly ceiling. */
  | { readonly kind: "limited"; readonly retryAfterMs: number }

export interface WakeStore {
  readonly dir: string
  readonly hourlyCeiling: number
  // ---- for the engine, the tools and clients
  readonly create: (input: NewWake & { readonly secret?: string }) => CreateResult
  readonly get: (id: string) => WakeUp | null
  /** Newest first. Without `includeEnded`, pending wake-ups only. */
  readonly list: (filter?: { readonly sessionId?: string; readonly includeEnded?: boolean }) => WakeUp[]
  /** Stops a pending wake-up; firings not yet delivered are dropped. `sessionId` restricts it to that session's. */
  readonly cancel: (id: string, how: { readonly by: Author; readonly reason?: string; readonly sessionId?: string }) => { readonly ok: true; readonly wake: WakeUp } | { readonly ok: false; readonly error: string }
  /** A webhook wake-up's secret. For the user's eyes: never put it in the model's context. */
  readonly secret: (id: string) => string | null
  /** The latest firings of a wake-up, newest first. */
  readonly firings: (wakeId: string, limit?: number) => Firing[]
  /** Firings recorded for the session in the hour before `now`, and when the oldest of them was. */
  readonly hourly: (sessionId: string, now: number) => { readonly count: number; readonly oldest: number | null }
  readonly hasActiveWebhooks: () => boolean
  // ---- for the scheduler and the listener
  readonly owner: () => WakeOwner
  /** Whether the owner `id` still runs (holds its lock). */
  readonly ownerAlive: (id: string) => boolean
  readonly nextDueAt: (ownerId: string, now: number, probeMs: number) => number | null
  readonly claimNext: (ownerId: string, now: number, options?: { readonly skipChecks?: boolean }) => Claim | null
  readonly renew: (ownerId: string, id: string, now: number) => boolean
  readonly release: (ownerId: string, id: string) => void
  readonly releaseAll: (ownerId: string) => void
  /** Records a check run that did not fire, and when to look next. Returns false when the lease was lost. */
  readonly recordRun: (ownerId: string, id: string, patch: RunPatch) => boolean
  /**
   * Records firing number `fired + 1` and the next time, unless the session's hourly ceiling is reached (then the
   * wake-up is held until the window has room). `lost`: the lease was lost, or the wake-up may no longer fire.
   */
  readonly fire: (ownerId: string, id: string, firing: FiringInput) => FireOutcome
  /** Ends a pending wake-up as failed and records the notice that says so. */
  readonly fail: (ownerId: string, id: string, reason: string, now: number, notice: (wake: WakeUp) => string) => Firing | null
  readonly expire: (ownerId: string, id: string, now: number) => boolean
  /** Defers a pending wake-up to `until` for `reason` (shown in the listing). */
  readonly hold: (ownerId: string, id: string, until: number, reason: string) => boolean
  readonly delivered: (ownerId: string, key: string, now: number) => boolean
  readonly retry: (ownerId: string, key: string, now: number, error: string) => boolean
  /** The session refused the message for good: the firing and the rest are dropped and the wake-up fails. */
  readonly reject: (ownerId: string, key: string, now: number, reason: string) => boolean
  /** Records a verified webhook request as a firing, once per signature. */
  readonly recordWebhook: (id: string, request: WebhookRequest) => WebhookOutcome
  /** Deletes what nobody needs any more: delivered and dropped firings older than a day, ended wake-ups older than 30 days, expired replay records. */
  readonly prune: (now: number) => void
  readonly close: () => void
}

export type FireOutcome = { readonly kind: "fired"; readonly firing: Firing } | { readonly kind: "held"; readonly until: number } | { readonly kind: "lost" }

export interface RunPatch {
  readonly now: number
  readonly nextAt: number | null
  readonly errors: number
  readonly lastError: string | null
  readonly lastRun: string | null
  readonly observed?: string | null
}

export interface FiringInput {
  readonly source: "timer" | "check"
  readonly now: number
  readonly dueAt: number
  readonly text: (wake: WakeUp, n: number) => string
  readonly untrusted: boolean
  readonly lastRun?: string | null
  readonly observed?: string | null
  /** What `state_reason` says when this firing completes the wake-up. */
  readonly completes?: string
}

export interface WebhookRequest {
  /** Identifies the signature for replay detection. */
  readonly digest: string
  /** How long the digest must be remembered. */
  readonly seenUntil: number
  readonly now: number
  readonly text: (wake: WakeUp, n: number) => string
}

type Row = {
  id: string
  session_id: string
  kind: string
  message: string
  trigger: string
  delivery: string
  max_firings: number
  expires_at: number
  min_interval_ms: number
  provenance: string
  run: string | null
  cwd: string | null
  secret: string | null
  state: string
  state_at: number | null
  state_reason: string | null
  state_by: string | null
  fired: number
  next_at: number | null
  last_fired_at: number | null
  errors: number
  last_error: string | null
  last_run: string | null
  observed: string | null
  held: string | null
  created_at: number
  lease_owner: string | null
  lease_until: number | null
}

type FiringRow = {
  key: string
  wake_id: string
  session_id: string
  n: number
  source: string
  delivery: string
  text: string
  untrusted: number
  created_at: number
  due_at: number
  attempts: number
  retry_at: number
  delivered_at: number | null
}

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

export function openWakeStore(options: WakeStoreOptions): WakeStore {
  const clock = options.clock ?? systemClock
  const leaseMs = options.leaseMs ?? 2 * 60_000
  const hourlyCeiling = Math.min(options.hourlyCeiling ?? WAKE_LIMITS.hourlyCeiling.default, WAKE_LIMITS.hourlyCeiling.max)
  const maxActive = {
    model: Math.min(options.maxActive?.model ?? WAKE_LIMITS.model.maxActive, WAKE_LIMITS.model.maxActive),
    user: Math.min(options.maxActive?.user ?? WAKE_LIMITS.user.maxActive, WAKE_LIMITS.user.maxActive),
  }
  mkdirSync(join(options.dir, "owners"), { recursive: true, mode: 0o700 })
  const path = join(options.dir, "wake.db")
  const fresh = !existsSync(path)
  const db = new Database(path, { create: true })
  if (fresh) chmodSync(path, 0o600)
  db.run(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 10_000}`)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`${path} has schema version ${version}; this build knows ${SCHEMA_VERSION}`)
    db.run(SCHEMA)
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }).immediate()

  const ownLocks = new Map<string, Database>()
  const dead = new Set<string>()
  const immediate = <T>(fn: () => T): T => db.transaction(fn).immediate()

  const row = (id: string) => db.query<Row, [string]>("SELECT * FROM wake WHERE id = ?").get(id)
  const openFirings = (wakeId: string) =>
    db.query<FiringRow, [string]>("SELECT * FROM firing WHERE wake_id = ? AND delivered_at IS NULL AND dropped_at IS NULL ORDER BY n = 0, n").all(wakeId).map(toFiring)
  const holds = (ownerId: string, id: string) => {
    const found = row(id)
    return found !== null && found.lease_owner === ownerId ? found : null
  }

  const ownerAlive = (id: string): boolean => {
    if (ownLocks.has(id)) return true
    if (dead.has(id) || !/^own_[0-9a-f]+$/.test(id)) return false
    const lockPath = join(options.dir, "owners", id)
    try {
      acquireWriterLock(lockPath).close()
    } catch (error) {
      if (error instanceof StoreLockedError) return true
      throw error
    }
    // It was free, so its owner is gone. Nobody else ever uses this ID, so the files can go.
    dead.add(id)
    rmSync(`${lockPath}-lock`, { force: true })
    rmSync(`${lockPath}-holder`, { force: true })
    return false
  }

  const leaseFree = (found: Pick<Row, "lease_owner" | "lease_until">, ownerId: string, now: number) =>
    found.lease_owner === null || (found.lease_owner !== ownerId && ((found.lease_until ?? 0) <= now || !ownerAlive(found.lease_owner)))

  const candidates = () =>
    db
      .query<Row & { open_retry: number | null }, []>(
        `SELECT w.*, (SELECT MIN(f.retry_at) FROM firing f WHERE f.wake_id = w.id AND f.delivered_at IS NULL AND f.dropped_at IS NULL) AS open_retry
         FROM wake w
         WHERE w.state = 'pending' OR w.id IN (SELECT wake_id FROM firing WHERE delivered_at IS NULL AND dropped_at IS NULL)`,
      )
      .all()

  const dueOf = (found: Row & { open_retry: number | null }) => {
    if (found.open_retry !== null) return found.open_retry
    if (found.state !== "pending") return null
    return Math.min(found.next_at ?? Number.POSITIVE_INFINITY, found.expires_at)
  }

  const hourly = (sessionId: string, now: number) => {
    const found = db
      .query<{ count: number; oldest: number | null }, [string, number]>(
        "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM firing WHERE session_id = ? AND n > 0 AND dropped_at IS NULL AND created_at > ?",
      )
      .get(sessionId, now - HOUR)!
    return { count: found.count, oldest: found.oldest }
  }

  const insertFiring = (firing: Firing) =>
    db.run(
      `INSERT INTO firing (key, wake_id, session_id, n, source, delivery, text, untrusted, created_at, due_at, attempts, retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [firing.key, firing.wakeId, firing.sessionId, firing.n, firing.source, firing.delivery, firing.text, firing.untrusted ? 1 : 0, firing.createdAt, firing.dueAt, firing.createdAt],
    )

  const fireLocked = (found: Row, input: { source: Firing["source"]; now: number; dueAt: number; text: (wake: WakeUp, n: number) => string; untrusted: boolean; completes?: string }) => {
    const wake = toWake(found)
    const n = wake.fired + 1
    const next = nextAfter(wake, input.now, true)
    const firing: Firing = {
      key: firingKey(wake.id, n),
      wakeId: wake.id,
      sessionId: wake.sessionId,
      n,
      source: input.source,
      delivery: wake.delivery,
      text: input.text(wake, n),
      untrusted: input.untrusted,
      createdAt: input.now,
      dueAt: input.dueAt,
      attempts: 0,
      deliveredAt: null,
    }
    insertFiring(firing)
    const reason = input.completes ?? (wake.limits.maxFirings === 1 ? "fired" : `fired ${n} times, its maximum`)
    db.run(
      `UPDATE wake SET fired = ?, last_fired_at = ?, next_at = ?, held = NULL, errors = 0, last_error = NULL,
         state = ?, state_at = ?, state_reason = ? WHERE id = ?`,
      [n, input.now, next.nextAt, next.last ? "completed" : "pending", next.last ? input.now : null, next.last ? reason : null, wake.id],
    )
    return firing
  }

  const store: WakeStore = {
    dir: options.dir,
    hourlyCeiling,

    create: (input) => {
      const now = clock.now()
      const prepared = prepareWake(input, now)
      if (!prepared.ok) return prepared
      const wake = prepared.wake
      if (input.secret !== undefined && (!wake.webhook || input.secret.length < 16))
        return { ok: false, error: wake.webhook ? "A webhook secret must be at least 16 characters long." : "Only a webhook has a secret." }
      const secret = wake.webhook ? (input.secret ?? `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`) : null
      const id = newWakeId()
      const cap = maxActive[input.author]
      return immediate((): CreateResult => {
        const active = db
          .query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM wake WHERE session_id = ? AND state = 'pending' AND json_extract(provenance, '$.author') = ?")
          .get(wake.sessionId, input.author)!.count
        if (active >= cap)
          return { ok: false, limit: true, error: `This session already has ${active} pending wake-ups created by the ${input.author}, the most allowed. Cancel one that is no longer needed first.` }
        db.run(
          `INSERT INTO wake (id, session_id, kind, message, trigger, delivery, max_firings, expires_at, min_interval_ms, provenance, run, cwd, secret,
             state, fired, next_at, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?)`,
          [
            id,
            wake.sessionId,
            wake.trigger.kind,
            wake.message,
            JSON.stringify(wake.trigger),
            wake.delivery,
            wake.limits.maxFirings,
            wake.limits.expiresAt,
            wake.limits.minIntervalMs,
            JSON.stringify(wake.provenance),
            wake.run === null ? null : JSON.stringify(wake.run),
            wake.cwd,
            secret,
            wake.nextAt,
            now,
          ],
        )
        return { ok: true, wake: toWake(row(id)!), secret }
      })
    },

    get: (id) => {
      const found = row(id)
      return found === null ? null : toWake(found)
    },

    list: (filter = {}) => {
      const clauses = [...(filter.sessionId === undefined ? [] : ["session_id = $session"]), ...(filter.includeEnded ? [] : ["state = 'pending'"])]
      const sql = `SELECT * FROM wake ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`} ORDER BY created_at DESC, id`
      return db
        .query<Row, Record<string, string>>(sql)
        .all(filter.sessionId === undefined ? {} : { $session: filter.sessionId })
        .map(toWake)
    },

    cancel: (id, how) =>
      immediate(() => {
        const found = row(id)
        if (found === null || (how.sessionId !== undefined && found.session_id !== how.sessionId)) return { ok: false as const, error: `There is no wake-up ${id} in this session.` }
        if (found.state !== "pending") return { ok: false as const, error: `Wake-up ${id} has already ended (${found.state}).` }
        const now = clock.now()
        db.run("UPDATE wake SET state = 'cancelled', state_at = ?, state_reason = ?, state_by = ?, next_at = NULL WHERE id = ?", [now, how.reason ?? null, how.by, id])
        db.run("UPDATE firing SET dropped_at = ?, drop_reason = 'cancelled' WHERE wake_id = ? AND delivered_at IS NULL AND dropped_at IS NULL", [now, id])
        return { ok: true as const, wake: toWake(row(id)!) }
      }),

    secret: (id) => row(id)?.secret ?? null,

    firings: (wakeId, limit = 20) =>
      db.query<FiringRow, [string, number]>("SELECT * FROM firing WHERE wake_id = ? ORDER BY created_at DESC, n DESC LIMIT ?").all(wakeId, limit).map(toFiring),

    hourly,

    hasActiveWebhooks: () => db.query<{ one: number }, []>("SELECT 1 AS one FROM wake WHERE kind = 'webhook' AND state = 'pending' LIMIT 1").get() !== null,

    owner: () => {
      const id = `own_${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`
      ownLocks.set(id, acquireWriterLock(join(options.dir, "owners", id)))
      return {
        id,
        close: () => {
          const lock = ownLocks.get(id)
          if (lock === undefined) return
          ownLocks.delete(id)
          lock.close()
          rmSync(join(options.dir, "owners", `${id}-lock`), { force: true })
          rmSync(join(options.dir, "owners", `${id}-holder`), { force: true })
        },
      }
    },

    ownerAlive,

    nextDueAt: (ownerId, now, probeMs) => {
      let next: number | null = null
      for (const found of candidates()) {
        const due = dueOf(found)
        if (due === null || found.lease_owner === ownerId) continue
        // Someone else holds it: look again when the lease lapses, or soon, to notice that its owner died.
        const at = found.lease_owner !== null && (found.lease_until ?? 0) > now ? Math.max(due, Math.min(found.lease_until!, now + probeMs)) : due
        next = next === null ? at : Math.min(next, at)
      }
      return next
    },

    claimNext: (ownerId, now, claimOptions = {}) => {
      const due = candidates()
        .map((found) => ({ found, due: dueOf(found) }))
        .filter((item) => item.due !== null && item.due <= now)
        .sort((a, b) => a.due! - b.due!)
      for (const { found } of due) {
        const deliver = found.open_retry !== null
        if (!deliver && claimOptions.skipChecks && found.kind === "check" && found.expires_at > now) continue
        if (!leaseFree(found, ownerId, now)) continue
        const taken = db.run("UPDATE wake SET lease_owner = ?, lease_until = ? WHERE id = ? AND lease_owner IS ? AND lease_until IS ?", [
          ownerId,
          now + leaseMs,
          found.id,
          found.lease_owner,
          found.lease_until,
        ])
        if (taken.changes !== 1) continue
        const current = row(found.id)!
        const open = openFirings(found.id).filter((firing) => firing.retryAt <= now)
        if (open.length === 0 && deliver) {
          // Delivered or dropped in the meantime by someone else.
          store.release(ownerId, found.id)
          continue
        }
        return { wake: toWake(current), work: open.length > 0 ? "deliver" : "evaluate", open: open.map(withoutRetry), observed: current.observed }
      }
      return null
    },

    renew: (ownerId, id, now) => db.run("UPDATE wake SET lease_until = ? WHERE id = ? AND lease_owner = ?", [now + leaseMs, id, ownerId]).changes === 1,

    release: (ownerId, id) => void db.run("UPDATE wake SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?", [id, ownerId]),

    releaseAll: (ownerId) => void db.run("UPDATE wake SET lease_owner = NULL, lease_until = NULL WHERE lease_owner = ?", [ownerId]),

    recordRun: (ownerId, id, patch) =>
      immediate(() => {
        const found = holds(ownerId, id)
        if (found === null || found.state !== "pending") return false
        db.run("UPDATE wake SET next_at = ?, errors = ?, last_error = ?, last_run = ?, observed = ?, held = NULL WHERE id = ?", [
          patch.nextAt,
          patch.errors,
          patch.lastError,
          patch.lastRun,
          patch.observed === undefined ? found.observed : patch.observed,
          id,
        ])
        return true
      }),

    fire: (ownerId, id, input) =>
      immediate((): FireOutcome => {
        const found = holds(ownerId, id)
        if (found === null || found.state !== "pending" || found.fired >= found.max_firings || found.expires_at <= input.now) return { kind: "lost" }
        const window = hourly(found.session_id, input.now)
        if (window.count >= hourlyCeiling) {
          const until = Math.min(window.oldest! + HOUR, found.expires_at)
          db.run("UPDATE wake SET next_at = ?, held = ?, last_run = ?, observed = ? WHERE id = ?", [
            until,
            `the session's ceiling of ${hourlyCeiling} firings per hour was reached`,
            input.lastRun ?? found.last_run,
            // A change that is held back is still a change at the next run.
            found.observed,
            id,
          ])
          return { kind: "held", until }
        }
        const firing = fireLocked(found, input)
        if (input.lastRun !== undefined || input.observed !== undefined)
          db.run("UPDATE wake SET last_run = ?, observed = ? WHERE id = ?", [input.lastRun ?? found.last_run, input.observed === undefined ? found.observed : input.observed, id])
        return { kind: "fired", firing }
      }),

    fail: (ownerId, id, reason, now, notice) =>
      immediate(() => {
        const found = holds(ownerId, id)
        if (found === null || found.state !== "pending") return null
        db.run("UPDATE wake SET state = 'failed', state_at = ?, state_reason = ?, next_at = NULL WHERE id = ?", [now, reason, id])
        const wake = toWake(row(id)!)
        const firing: Firing = {
          key: firingKey(id, 0),
          wakeId: id,
          sessionId: wake.sessionId,
          n: 0,
          source: "notice",
          // It reports; it does not start a turn.
          delivery: "queue",
          text: notice(wake),
          untrusted: false,
          createdAt: now,
          dueAt: now,
          attempts: 0,
          deliveredAt: null,
        }
        insertFiring(firing)
        return firing
      }),

    expire: (ownerId, id, now) =>
      immediate(() => {
        const found = holds(ownerId, id)
        if (found === null || found.state !== "pending" || found.expires_at > now) return false
        db.run("UPDATE wake SET state = 'expired', state_at = ?, state_reason = ?, next_at = NULL WHERE id = ?", [now, `its expiry time passed after ${found.fired} ${found.fired === 1 ? "firing" : "firings"}`, id])
        return true
      }),

    hold: (ownerId, id, until, reason) =>
      immediate(() => {
        const found = holds(ownerId, id)
        if (found === null || found.state !== "pending") return false
        db.run("UPDATE wake SET next_at = ?, held = ? WHERE id = ?", [Math.min(until, found.expires_at), reason, id])
        return true
      }),

    delivered: (ownerId, key, now) =>
      immediate(() => {
        const firing = db.query<FiringRow, [string]>("SELECT * FROM firing WHERE key = ?").get(key)
        if (firing === null || holds(ownerId, firing.wake_id) === null) return false
        return db.run("UPDATE firing SET delivered_at = ?, attempts = attempts + 1 WHERE key = ? AND delivered_at IS NULL", [now, key]).changes === 1
      }),

    retry: (ownerId, key, now, error) =>
      immediate(() => {
        const firing = db.query<FiringRow, [string]>("SELECT * FROM firing WHERE key = ?").get(key)
        if (firing === null || holds(ownerId, firing.wake_id) === null) return false
        db.run("UPDATE firing SET attempts = attempts + 1, retry_at = ?, last_error = ? WHERE key = ?", [now + deliveryBackoff(firing.attempts + 1), error, key])
        return true
      }),

    reject: (ownerId, key, now, reason) =>
      immediate(() => {
        const firing = db.query<FiringRow, [string]>("SELECT * FROM firing WHERE key = ?").get(key)
        if (firing === null) return false
        const found = holds(ownerId, firing.wake_id)
        if (found === null) return false
        db.run("UPDATE firing SET dropped_at = ?, drop_reason = ? WHERE wake_id = ? AND delivered_at IS NULL AND dropped_at IS NULL", [now, reason, firing.wake_id])
        if (found.state === "pending" || found.state === "completed")
          db.run("UPDATE wake SET state = 'failed', state_at = ?, state_reason = ?, next_at = NULL WHERE id = ?", [now, `the session did not take its message: ${reason}`, firing.wake_id])
        return true
      }),

    recordWebhook: (id, request) =>
      immediate((): WebhookOutcome => {
        const found = row(id)
        if (found === null || found.kind !== "webhook" || found.state !== "pending" || found.expires_at <= request.now || found.fired >= found.max_firings) return { kind: "unavailable" }
        if (db.query("SELECT 1 FROM seen WHERE wake_id = ? AND digest = ?").get(id, request.digest) !== null) return { kind: "replayed" }
        if (found.last_fired_at !== null && request.now - found.last_fired_at < found.min_interval_ms)
          return { kind: "limited", retryAfterMs: found.last_fired_at + found.min_interval_ms - request.now }
        const window = hourly(found.session_id, request.now)
        if (window.count >= hourlyCeiling) return { kind: "limited", retryAfterMs: Math.max(1000, window.oldest! + HOUR - request.now) }
        db.run("INSERT INTO seen (wake_id, digest, expires_at) VALUES (?, ?, ?)", [id, request.digest, request.seenUntil])
        return { kind: "accepted", firing: fireLocked(found, { source: "webhook", now: request.now, dueAt: request.now, text: request.text, untrusted: true }) }
      }),

    prune: (now) =>
      immediate(() => {
        db.run("DELETE FROM firing WHERE (delivered_at IS NOT NULL AND delivered_at < ?) OR (dropped_at IS NOT NULL AND dropped_at < ?)", [now - DAY, now - DAY])
        const ended = db.query<{ id: string }, [number]>("SELECT id FROM wake WHERE state != 'pending' AND state_at < ?").all(now - 30 * DAY)
        for (const { id } of ended) {
          if (db.query("SELECT 1 FROM firing WHERE wake_id = ? AND delivered_at IS NULL AND dropped_at IS NULL").get(id) !== null) continue
          db.run("DELETE FROM firing WHERE wake_id = ?", [id])
          db.run("DELETE FROM seen WHERE wake_id = ?", [id])
          db.run("DELETE FROM wake WHERE id = ?", [id])
        }
        // A webhook's signatures are kept while it lives (a GitHub-style signature has no timestamp to go stale).
        db.run("DELETE FROM seen WHERE expires_at < ? AND wake_id IN (SELECT id FROM wake WHERE state = 'pending')", [now])
      }),

    close: () => {
      for (const lock of ownLocks.values()) lock.close()
      ownLocks.clear()
      db.close()
    },
  }
  return store
}

function decode<T>(validator: (input: unknown, path: string) => T, text: string, what: string): T {
  const decoded = safeDecode(validator, JSON.parse(text))
  if (!decoded.ok) throw new Error(`a stored wake-up has an invalid ${what}: ${decoded.error.message}`)
  return decoded.value
}

function toWake(found: Row): WakeUp {
  return {
    id: found.id,
    sessionId: found.session_id,
    message: found.message,
    trigger: decode(trigger, found.trigger, "trigger") as Trigger,
    delivery: found.delivery as WakeDelivery,
    limits: { maxFirings: found.max_firings, expiresAt: found.expires_at, minIntervalMs: found.min_interval_ms },
    provenance: decode(provenance, found.provenance, "provenance") as Infer<typeof provenance>,
    run: found.run === null ? null : (decode(runAs, found.run, "run") as RunAs),
    cwd: found.cwd,
    state: { kind: found.state as WakeStateKind, at: found.state_at, reason: found.state_reason, by: found.state_by as Author | null },
    fired: found.fired,
    nextAt: found.next_at,
    lastFiredAt: found.last_fired_at,
    errors: found.errors,
    lastError: found.last_error,
    lastRun: found.last_run,
    held: found.held,
    createdAt: found.created_at,
  }
}

type OpenFiring = Firing & { readonly retryAt: number }

function toFiring(found: FiringRow): OpenFiring {
  return {
    key: found.key,
    wakeId: found.wake_id,
    sessionId: found.session_id,
    n: found.n,
    source: found.source as Firing["source"],
    delivery: found.delivery as WakeDelivery,
    text: found.text,
    untrusted: found.untrusted === 1,
    createdAt: found.created_at,
    dueAt: found.due_at,
    attempts: found.attempts,
    deliveredAt: found.delivered_at,
    retryAt: found.retry_at,
  }
}

function withoutRetry(firing: OpenFiring): Firing {
  const { retryAt: _, ...rest } = firing
  return rest
}
