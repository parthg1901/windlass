/**
 * The session directory: one SQLite database per session under the harness
 * data directory, so the unit of the single-writer rule is the session and
 * not the machine. Two terminals, an editor and the eval runner each work in
 * their own sessions at once.
 *
 *   <data>/sessions/<session id>.db          the session (`sqlite.ts`), with its -wal and -shm
 *   <data>/sessions/<session id>.db-lock     its writer lock (`sqlite-lock.ts`), never deleted
 *   <data>/sessions/<session id>.db-holder   the process that holds the lock, for the error message
 *   <data>/index.db                          the listing cache described below
 *   <data>/blobs/<aa>/<sha256>               media, content-addressed, shared (`blobs.ts`)
 *
 * Per file nothing changes: one writer, dense `seq`, the reducer inside the
 * append transaction, rebuild-from-log equals the live rows.
 *
 * ## Who may do what
 *
 * `create` and `open` return the session's one writer and hold its lock until
 * that store is closed. A session another live process holds is refused with
 * `SessionInUseError`, which names the process. The lock is the operating
 * system's, so a holder that died holds nothing and the session opens
 * normally. Everything else here only reads, through read-only connections
 * that take no lock: SQLite's WAL mode lets them run next to the writer and
 * shows them committed transactions only.
 *
 * ## Listing without opening every file
 *
 * The session files are the truth; `index.db` is a cache of each session's
 * summary row, and it is never trusted without a check. A listing reads the
 * directory and stats each session's database and write-ahead log. A cached
 * row is used only when its recorded signature (size and modification time,
 * in nanoseconds, of both files) still matches and was taken well after the
 * files last changed. Every other session is read from its own file (one
 * row, through a read-only connection) and the cache is updated. So:
 *
 * - writers do nothing for the index, and a listing cannot be stale because a
 *   writer died before updating it: there is no such update;
 * - a file that is new, changed, restored from a backup or edited with
 *   another tool is noticed, because its signature differs; a file that is
 *   gone is dropped from the listing;
 * - the signature is taken before the file is read, so a write that lands in
 *   between leaves the cache older than the file, never newer, and the next
 *   listing reads it again;
 * - a file changed within `RACY_MS` of the check is read again next time
 *   whatever its signature says, which covers file systems with coarse
 *   timestamps (the rule git's index uses for the same problem);
 * - several processes refreshing at once each write rows they read
 *   themselves, in one transaction; whichever wins, every row carries the
 *   signature it was read under, so a lost update only costs a re-read;
 * - a process killed inside the transaction leaves nothing (SQLite rolls it
 *   back), and an index that is missing, unreadable or from another version
 *   is deleted and rebuilt from the session files. If it cannot even be
 *   rebuilt, the listing is computed from the files alone.
 *
 * ## Forks
 *
 * A fork's log is its parent's events through the fork point plus its own,
 * and the parent is another file, possibly open for writing in another
 * process. The fork reads it through a read-only connection, and only events
 * at or before the fork point: those are committed, and the log is
 * append-only (triggers refuse updates and deletes), so they are the same
 * bytes whenever and however often they are read. When a fork is created its
 * inherited messages, baseline and compaction are copied into its own rows,
 * so a fork whose parent file is later missing still opens, runs and lists;
 * only reading its inherited events fails, with `parent_missing`. Creating a
 * fork of a session that cannot be found fails the same way.
 */
import { Database, SQLiteError } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../brand.ts"
import type { StoredEvent } from "../event/durable.ts"
import { type SessionId, sessionId as sessionIdValidator } from "../id.ts"
import { sessionState } from "../message/message.ts"
import { type BlobStore, createFileBlobStore } from "./blobs.ts"
import { SCHEMA_VERSION } from "./schema.ts"
import { StoreLockedError, isBusy } from "./sqlite-lock.ts"
import { type SqliteStore, openSqliteStore } from "./sqlite.ts"
import { type SessionQuery, type SessionStores, type SessionSummary, type Store, StoreError, resolveSessionId } from "./store.ts"

export const SESSIONS_DIRECTORY = "sessions"
export const BLOBS_DIRECTORY = "blobs"
export const INDEX_FILE = "index.db"
/** The single database every session used to share. Found once, it is moved aside; nothing is migrated. */
export const LEGACY_DATABASE = "sessions.db"
export const LEGACY_BACKUP_PREFIX = "backup-single-database-"

/** A session file changed this recently is read again at the next listing, whatever its signature says. */
export const RACY_MS = 2000

/**
 * Another live process (or another store in this process) holds the session
 * for writing. A `StoreError` with code `locked`.
 */
export class SessionInUseError extends StoreLockedError {
  constructor(
    readonly sessionId: SessionId,
    path: string,
    holderPid: number | null,
  ) {
    super(path, holderPid)
    const holder =
      holderPid === null
        ? `another ${brand.binary} process`
        : holderPid === process.pid
          ? "this process"
          : `another ${brand.binary} process (pid ${holderPid})`
    const advice =
      holderPid === null || holderPid === process.pid
        ? "close it there first, or start a new session"
        : `wait for it to finish or stop it (kill ${holderPid}), or start a new session`
    this.message = `session ${sessionId} is in use by ${holder}: ${advice}`
    this.name = "SessionInUseError"
  }
}

export interface SessionDirectoryOptions {
  /** The harness data directory. Created when missing. */
  readonly dataDir: string
  /** Clock for event and ledger times of the stores it opens. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Passed to each session's store: how long a write waits for SQLite's write lock. */
  readonly busyTimeoutMs?: number
  /** One line about something the user should know (the old database was moved aside). Defaults to standard error. */
  readonly notice?: (line: string) => void
}

export interface SessionDirectory extends SessionStores {
  readonly dataDir: string
  readonly blobs: BlobStore
  readonly create: (id: SessionId) => SqliteStore
  readonly open: (id: SessionId) => SqliteStore
  /** The database file of a session, whether or not it exists. */
  readonly pathOf: (id: SessionId) => string
  /** A session's effective log, read without holding the session. Throws `session_not_found` or `parent_missing`. */
  readonly readEvents: (id: SessionId, range?: { readonly afterSeq?: number; readonly limit?: number }) => readonly StoredEvent[]
  /** Throws the listing cache away and builds it again from the session files. */
  readonly rebuildIndex: () => void
}

const SESSION_FILE = /^(.+)\.db$/

export function openSessionDirectory(options: SessionDirectoryOptions): SessionDirectory {
  const dataDir = options.dataDir
  const sessionsDir = join(dataDir, SESSIONS_DIRECTORY)
  mkdirSync(sessionsDir, { recursive: true })
  moveLegacyDatabase(dataDir, options.notice ?? ((line) => void process.stderr.write(`${line}\n`)))
  const blobs = createFileBlobStore(join(dataDir, BLOBS_DIRECTORY))
  const held = new Map<SessionId, SqliteStore>()
  const index = new SessionIndex(join(dataDir, INDEX_FILE))
  let closed = false

  const pathOf = (id: SessionId) => {
    // A session ID becomes a file name: nothing in it may leave the directory.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionIdValidator(id, "sessionId"))) throw new StoreError("session_not_found", `${JSON.stringify(id)} is not a session ID`)
    return join(sessionsDir, `${id}.db`)
  }

  const parentLog = (parent: SessionId, range: { readonly afterSeq: number; readonly limit: number }) => {
    try {
      return readEvents(parent, range)
    } catch (error) {
      if (error instanceof StoreError && error.code === "session_not_found")
        throw new StoreError("parent_missing", `the history inherited from session ${parent} cannot be read: ${pathOf(parent)} is missing`, { cause: error })
      throw error
    }
  }

  const storeOptions = (id: SessionId) => ({
    path: pathOf(id),
    blobs,
    parentLog,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  })

  /** The session's writer: its store, with `close` also letting go of it here. */
  const hold = (id: SessionId): SqliteStore => {
    if (closed) throw new StoreError("locked", "the session directory is closed")
    if (held.has(id)) throw new SessionInUseError(id, pathOf(id), process.pid)
    const store = (() => {
      try {
        return openSqliteStore(storeOptions(id))
      } catch (error) {
        if (error instanceof StoreLockedError) throw new SessionInUseError(id, pathOf(id), error.holderPid)
        throw error
      }
    })()
    const session: SqliteStore = {
      ...store,
      close: () => {
        if (held.get(id) !== session) return
        held.delete(id)
        store.close()
      },
    }
    held.set(id, session)
    return session
  }

  /** Runs `work` on something that reads the session: its writer when it is held here, else a read-only connection. */
  const read = <T>(id: SessionId, work: (store: Store) => T): T => {
    const writer = held.get(id)
    if (writer !== undefined) return work(writer)
    const path = pathOf(id)
    if (!existsSync(path)) throw new StoreError("session_not_found", `there is no session ${id}`)
    const reader = openSqliteStore({ ...storeOptions(id), readOnly: true })
    try {
      if (reader.getSession(id) === null) throw new StoreError("session_not_found", `there is no session ${id}`)
      return work(reader)
    } finally {
      reader.close()
    }
  }

  const readEvents: SessionDirectory["readEvents"] = (id, range) => read(id, (store) => store.readEvents(id, range))

  const get = (id: SessionId): SessionSummary | null => {
    try {
      return read(id, (store) => store.getSession(id))
    } catch (error) {
      if (error instanceof StoreError && error.code === "session_not_found") return null
      throw error
    }
  }

  const ids = (): SessionId[] => {
    const names = (() => {
      try {
        return readdirSync(sessionsDir)
      } catch {
        return []
      }
    })()
    return names.flatMap((name) => {
      const match = SESSION_FILE.exec(name)
      return match === null ? [] : [match[1] as SessionId]
    })
  }

  /** One session's summary straight from its file, or `null` when the file holds no readable session (yet). */
  const summaryFromFile = (id: SessionId): SessionSummary | null => {
    try {
      return get(id)
    } catch (error) {
      // Being created right now, from another version, or not a store database: not a session this build can list.
      if (error instanceof StoreError || error instanceof SQLiteError) return null
      throw error
    }
  }

  const list = (query: SessionQuery = {}): readonly SessionSummary[] => index.list(ids(), pathOf, summaryFromFile, query)

  return {
    dataDir,
    blobs,
    pathOf,
    create: (id) => {
      if (existsSync(pathOf(id))) throw new StoreError("locked", `session ${id} already exists`)
      return hold(id)
    },
    open: (id) => {
      if (!existsSync(pathOf(id))) throw new StoreError("session_not_found", `there is no session ${id}`)
      const store = hold(id)
      if (store.getSession(id) !== null) return store
      store.close()
      throw new StoreError("session_not_found", `there is no session ${id}`)
    },
    get,
    list,
    read,
    readEvents,
    resolve: (idOrPrefix) => resolveSessionId(ids(), idOrPrefix),
    putBlob: (bytes, mediaType) => blobs.put(bytes, mediaType),
    getBlob: (hash) => blobs.get(hash),
    rebuildIndex: () => {
      index.reset()
      list({ includeArchived: true })
    },
    close: () => {
      closed = true
      for (const store of [...held.values()]) store.close()
      index.close()
    },
  }
}

/**
 * Moves the database of the layout before this one out of the way, once.
 * Nothing was released with it, so it is kept as a backup and not migrated.
 */
function moveLegacyDatabase(dataDir: string, notice: (line: string) => void): void {
  const legacy = join(dataDir, LEGACY_DATABASE)
  if (!existsSync(legacy)) return
  const backup = join(dataDir, `${LEGACY_BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}`)
  try {
    mkdirSync(backup, { recursive: true })
    // The database first: once it is gone, a process racing this one finds nothing to move.
    renameSync(legacy, join(backup, LEGACY_DATABASE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    rmSync(backup, { recursive: true, force: true })
    return
  }
  for (const suffix of ["-wal", "-shm", "-lock", "-holder"]) {
    try {
      renameSync(`${legacy}${suffix}`, join(backup, `${LEGACY_DATABASE}${suffix}`))
    } catch {}
  }
  notice(
    `${brand.binary}: sessions are now stored one file each, in ${join(dataDir, SESSIONS_DIRECTORY)}. The old database ${legacy} was not converted; it was moved to ${backup} and its sessions are no longer listed.`,
  )
}

// ---------------------------------------------------------------- the listing cache

/** Changes with the cache's own tables or with the shape of the summaries it holds. */
const INDEX_VERSION = SCHEMA_VERSION * 100 + 1

const INDEX_SQL = `
CREATE TABLE session_index (
  id           TEXT PRIMARY KEY,
  cwd          TEXT NOT NULL,
  archived     INTEGER NOT NULL,
  last_seq     INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  -- JSON of SessionState, as the session's own row has it.
  state        TEXT NOT NULL,
  -- The signature of the files this row was read from, and when it was taken (ms).
  signature    TEXT NOT NULL,
  checked_at   INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
`

interface IndexRow {
  readonly id: string
  readonly cwd: string
  readonly archived: number
  readonly last_seq: number
  readonly time_updated: number
  readonly signature: string
  readonly checked_at: number
}

interface Signature {
  /** Sizes and modification times of the database and its write-ahead log. */
  readonly text: string
  /** The latest modification time among them, in ms. */
  readonly modifiedMs: number
}

/** What the session's files look like from outside, or `null` when the database is gone. */
function signatureOf(path: string): Signature | null {
  const stat = (file: string) => {
    try {
      return statSync(file, { bigint: true })
    } catch {
      return null
    }
  }
  const database = stat(path)
  if (database === null) return null
  const wal = stat(`${path}-wal`)
  return {
    text: `${database.size}:${database.mtimeNs}:${wal === null ? "-" : `${wal.size}:${wal.mtimeNs}`}`,
    modifiedMs: Math.max(Number(database.mtimeMs), wal === null ? 0 : Number(wal.mtimeMs)),
  }
}

class SessionIndex {
  private database: Database | null = null
  /** The cache could not be opened or rebuilt: listings are computed from the files alone. */
  private unusable = false

  constructor(private readonly path: string) {}

  list(
    ids: readonly SessionId[],
    pathOf: (id: SessionId) => string,
    fromFile: (id: SessionId) => SessionSummary | null,
    query: SessionQuery,
  ): SessionSummary[] {
    const cached = new Map<string, IndexRow>(this.rows().map((row) => [row.id, row]))
    const fresh = new Map<SessionId, { readonly summary: SessionSummary; readonly signature: Signature; readonly checkedAt: number }>()
    const gone: string[] = []
    const entries: { readonly id: SessionId; readonly cwd: string; readonly archived: boolean; readonly updatedAt: number }[] = []
    const present = new Set<string>(ids)
    for (const id of cached.keys()) if (!present.has(id)) gone.push(id)

    for (const id of ids) {
      // The signature first, the content after: a write in between leaves the cache older than the file.
      const checkedAt = Date.now()
      const signature = signatureOf(pathOf(id))
      const row = cached.get(id)
      if (signature === null) {
        if (row !== undefined) gone.push(id)
        continue
      }
      if (row !== undefined && row.signature === signature.text && signature.modifiedMs + RACY_MS < row.checked_at) {
        entries.push({ id, cwd: row.cwd, archived: row.archived !== 0, updatedAt: row.time_updated })
        continue
      }
      const summary = fromFile(id)
      if (summary === null) {
        if (row !== undefined) gone.push(id)
        continue
      }
      fresh.set(id, { summary, signature, checkedAt })
      entries.push({ id, cwd: summary.session.cwd, archived: summary.session.archived, updatedAt: summary.updatedAt })
    }
    this.write(fresh, gone)

    const chosen = entries
      .filter((entry) => (query.includeArchived === true || !entry.archived) && (query.cwd === undefined || entry.cwd === query.cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
      .slice(0, query.limit ?? Number.MAX_SAFE_INTEGER)
    return chosen.flatMap((entry) => {
      const summary = fresh.get(entry.id)?.summary ?? this.summary(entry.id) ?? fromFile(entry.id)
      return summary === null ? [] : [summary]
    })
  }

  reset(): void {
    this.close()
    this.unusable = false
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.path}${suffix}`, { force: true })
  }

  close(): void {
    try {
      this.database?.close()
    } catch {}
    this.database = null
  }

  /** The cache, opened on first use. A file that is not this version's cache is deleted and started again. */
  private open(): Database | null {
    if (this.database !== null) return this.database
    if (this.unusable) return null
    for (const attempt of [1, 2]) {
      let database: Database | null = null
      try {
        database = new Database(this.path, { create: true })
        database.run("PRAGMA busy_timeout = 1000")
        database.run("PRAGMA journal_mode = WAL")
        // A cache: losing its last write to a power cut costs a re-read, so it need not wait for the disk.
        database.run("PRAGMA synchronous = NORMAL")
        const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
        if (version === 0) {
          const created = database
          created
            .transaction(() => {
              // Another process may have created it between the version check and this transaction.
              if (created.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version !== 0) return
              created.run(INDEX_SQL)
              created.run(`PRAGMA user_version = ${INDEX_VERSION}`)
            })
            .immediate()
        } else if (version !== INDEX_VERSION) throw new StaleIndex()
        database.query("SELECT id FROM session_index LIMIT 1").get()
        this.database = database
        return database
      } catch (error) {
        try {
          database?.close()
        } catch {}
        // Busy means another process is using a healthy cache: do without it this once.
        if (isBusy(error)) return null
        if (attempt === 2) break
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.path}${suffix}`, { force: true })
      }
    }
    this.unusable = true
    return null
  }

  private rows(): IndexRow[] {
    return this.guarded(
      (database) => database.query<IndexRow, []>("SELECT id, cwd, archived, last_seq, time_updated, signature, checked_at FROM session_index").all(),
      [],
    )
  }

  private summary(id: SessionId): SessionSummary | null {
    return this.guarded((database) => {
      const row = database.query<{ state: string; last_seq: number; time_updated: number }, [string]>("SELECT state, last_seq, time_updated FROM session_index WHERE id = ?").get(id)
      if (row === null) return null
      return { session: sessionState(JSON.parse(row.state), `index entry ${id}`), lastSeq: row.last_seq, updatedAt: row.time_updated }
    }, null)
  }

  private write(
    fresh: ReadonlyMap<SessionId, { readonly summary: SessionSummary; readonly signature: Signature; readonly checkedAt: number }>,
    gone: readonly string[],
  ): void {
    if (fresh.size === 0 && gone.length === 0) return
    this.guarded((database) => {
      const upsert = database.query(
        `INSERT INTO session_index (id, cwd, archived, last_seq, time_updated, state, signature, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET cwd = excluded.cwd, archived = excluded.archived, last_seq = excluded.last_seq,
           time_updated = excluded.time_updated, state = excluded.state, signature = excluded.signature, checked_at = excluded.checked_at`,
      )
      const remove = database.query("DELETE FROM session_index WHERE id = ?")
      database
        .transaction(() => {
          for (const id of gone) remove.run(id)
          for (const [id, entry] of fresh) {
            const { summary } = entry
            upsert.run(id, summary.session.cwd, summary.session.archived ? 1 : 0, summary.lastSeq, summary.updatedAt, JSON.stringify(summary.session), entry.signature.text, entry.checkedAt)
          }
        })
        .immediate()
      return null
    }, null)
  }

  /**
   * Runs `work` on the cache. A cache that is busy is skipped this once; one
   * that fails any other way (corrupt, deleted underneath, a row that does not
   * decode) is thrown away, and the listing reads the files instead.
   */
  private guarded<T>(work: (database: Database) => T, fallback: T): T {
    const database = this.open()
    if (database === null) return fallback
    try {
      return work(database)
    } catch (error) {
      if (isBusy(error)) return fallback
      this.reset()
      return fallback
    }
  }
}

class StaleIndex extends Error {}
