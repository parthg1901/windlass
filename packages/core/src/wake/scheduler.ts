/**
 * The scheduler: sleeps until the next wake-up is due, fires it, and hands the firing to the caller's `deliver`.
 *
 * Idle, it is one timer and, at most once a minute, one indexed read of the store (to notice wake-ups another
 * process created, and owners that died); `poke` wakes it early when this process creates or receives one. It
 * never polls faster than due times require: a failing check backs off, a delivery the session cannot take yet is
 * retried from 5 s doubling to 5 min, and a session over its hourly ceiling is held until the window has room.
 *
 * All work on a wake-up happens under its lease (`store.ts`), so several processes may run a scheduler on the
 * same store and each firing is recorded once and delivered by one of them at a time.
 */
import type { CheckOutcome, CheckRunner } from "./check.ts"
import { type WakeClock, systemClock } from "./clock.ts"
import { type CheckEvidence, firingText, noticeText } from "./message.ts"
import { type Firing, type RunAs, type WakeUp, WAKE_LIMITS, checkBackoff, isoTime, narrowRun, nextAfter } from "./record.ts"
import type { Claim, FireOutcome, WakeStore } from "./store.ts"

/**
 * What the engine did with a firing.
 * - `admitted`: it is in the session's inbox now (`inbox.enqueued` with `firing.key` as the message ID).
 * - `duplicate`: a message with that ID was already admitted earlier (a redelivery after a crash). Also success.
 * - `retry`: not now (the session is held by another process, or busy reverting); try again later.
 * - `rejected`: never (the session no longer exists, or is archived); the wake-up fails with the reason.
 */
export type DeliverResult =
  | { readonly kind: "admitted" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string }

/** Supplied by the engine. A throw counts as `retry`. It must not take long: it admits a message and returns. */
export type Deliver = (firing: Firing) => Promise<DeliverResult>

export type SchedulerEvent =
  | { readonly type: "fired"; readonly firing: Firing }
  | { readonly type: "delivered"; readonly firing: Firing; readonly duplicate: boolean }
  | { readonly type: "retry"; readonly firing: Firing; readonly reason: string }
  | { readonly type: "rejected"; readonly firing: Firing; readonly reason: string }
  | { readonly type: "checked"; readonly wakeId: string; readonly outcome: CheckOutcome }
  | { readonly type: "held"; readonly wakeId: string; readonly until: number }
  | { readonly type: "expired"; readonly wakeId: string }
  | { readonly type: "failed"; readonly wakeId: string; readonly reason: string }
  | { readonly type: "error"; readonly error: unknown }

export interface SchedulerOptions {
  readonly store: WakeStore
  readonly runCheck: CheckRunner
  readonly deliver: Deliver
  readonly clock?: WakeClock
  /**
   * What the approval layer would let this wake-up's session run a command under now, for example sandboxed once
   * the session is tainted; `null` for no further limit. The check runs under the narrower of this and what was
   * recorded at creation (`narrowRun`), never under more. `refused`: it may not run at all any more (the wake-up
   * fails with that reason and the session is told).
   */
  readonly currentRun?: (wake: WakeUp) => RunAs | null | { readonly refused: string }
  /** The longest sleep. Default 60 s. */
  readonly maxIdleMs?: number
  /** How soon to look again at a wake-up another live owner holds. Default 15 s. */
  readonly probeMs?: number
  readonly maxConcurrentChecks?: number
  /** How long `stop` waits for a delivery in progress. Default 5 s. */
  readonly stopGraceMs?: number
  readonly onEvent?: (event: SchedulerEvent) => void
}

export interface Scheduler {
  /** This scheduler's owner ID, as leases name it. */
  readonly owner: string
  /** Starts the loop. */
  readonly start: () => void
  /** Ends the loop, stops running checks (they run again later), waits for deliveries in progress, gives up its leases. */
  readonly stop: () => Promise<void>
  /** Look now: a wake-up was created, cancelled or received a webhook. */
  readonly poke: () => void
  /** One pass at the clock's current time: fires and delivers everything due, and resolves when that work is done. For tests and the demo; `start` runs passes by itself. */
  readonly runDue: () => Promise<void>
}

const HOUR = 60 * 60 * 1000
const PRUNE_EVERY_MS = 10 * 60 * 1000

export function createScheduler(options: SchedulerOptions): Scheduler {
  const store = options.store
  const clock = options.clock ?? systemClock
  const maxIdleMs = options.maxIdleMs ?? 60_000
  const probeMs = options.probeMs ?? 15_000
  const maxChecks = options.maxConcurrentChecks ?? 2
  const emit = (event: SchedulerEvent) => {
    try {
      options.onEvent?.(event)
    } catch {
      // A listener's failure is not the scheduler's.
    }
  }
  const owner = store.owner()
  const tasks = new Set<Promise<void>>()
  const shutdown = new AbortController()
  let checksRunning = 0
  let stopped = false
  let loop: Promise<void> | null = null
  let sleeper: AbortController | null = null
  let lastPrune = Number.NEGATIVE_INFINITY

  const poke = () => sleeper?.abort()

  const dispatch = () => {
    if (stopped) return
    const now = clock.now()
    if (now - lastPrune >= PRUNE_EVERY_MS) {
      store.prune(now)
      lastPrune = now
    }
    for (;;) {
      const claim = store.claimNext(owner.id, now, { skipChecks: checksRunning >= maxChecks })
      if (claim === null) return
      const check = claim.work === "evaluate" && claim.wake.trigger.kind === "check" && now < claim.wake.limits.expiresAt
      if (check) checksRunning += 1
      const task: Promise<void> = handle(claim)
        .catch((error) => emit({ type: "error", error }))
        .finally(() => {
          if (check) checksRunning -= 1
          tasks.delete(task)
          try {
            store.release(owner.id, claim.wake.id)
          } catch (error) {
            emit({ type: "error", error })
          }
          poke()
        })
      tasks.add(task)
    }
  }

  const handle = async (claim: Claim) => {
    if (claim.work === "deliver") return deliverAll(claim.open)
    const wake = claim.wake
    const now = clock.now()
    if (wake.state.kind !== "pending") return
    if (now >= wake.limits.expiresAt) {
      if (store.expire(owner.id, wake.id, now)) emit({ type: "expired", wakeId: wake.id })
      return
    }
    if (wake.trigger.kind === "check") return evaluateCheck(claim)
    if (wake.nextAt === null) return
    const dueAt = wake.nextAt
    await afterFire(
      wake.id,
      store.fire(owner.id, wake.id, {
        source: "timer",
        now,
        dueAt,
        untrusted: false,
        text: (current, n) => firingText({ wake: current, n, source: "timer", dueAt, now, shownBodyBytes: WAKE_LIMITS.webhook.shownBytes }),
      }),
    )
  }

  const afterFire = async (wakeId: string, outcome: FireOutcome) => {
    if (outcome.kind === "held") emit({ type: "held", wakeId, until: outcome.until })
    if (outcome.kind !== "fired") return
    emit({ type: "fired", firing: outcome.firing })
    await deliverAll([outcome.firing])
  }

  const deliverAll = async (firings: readonly Firing[]) => {
    for (const firing of firings) {
      store.renew(owner.id, firing.wakeId, clock.now())
      const result = await options.deliver(firing).catch((error): { kind: "retry"; reason: string } => ({ kind: "retry", reason: error instanceof Error ? error.message : String(error) }))
      const now = clock.now()
      switch (result.kind) {
        case "admitted":
        case "duplicate":
          store.delivered(owner.id, firing.key, now)
          emit({ type: "delivered", firing, duplicate: result.kind === "duplicate" })
          break
        case "retry":
          store.retry(owner.id, firing.key, now, result.reason)
          emit({ type: "retry", firing, reason: result.reason })
          return
        case "rejected":
          store.reject(owner.id, firing.key, now, result.reason)
          emit({ type: "rejected", firing, reason: result.reason })
          return
      }
    }
  }

  const evaluateCheck = async (claim: Claim) => {
    const wake = claim.wake
    if (wake.trigger.kind !== "check" || wake.run === null || wake.cwd === null) return
    const trigger = wake.trigger
    const window = store.hourly(wake.sessionId, clock.now())
    if (window.count >= store.hourlyCeiling) {
      // Running it would only find something that cannot be delivered yet.
      const until = window.oldest! + HOUR
      if (store.hold(owner.id, wake.id, until, `the session's ceiling of ${store.hourlyCeiling} firings per hour was reached`)) emit({ type: "held", wakeId: wake.id, until })
      return
    }
    const current = options.currentRun?.(wake) ?? null
    if (current !== null && "refused" in current) return failCheck(wake, `the approval layer no longer allows its command: ${current.refused}`)
    const run = narrowRun(wake.run, current)
    const keep = setInterval(() => store.renew(owner.id, wake.id, clock.now()), 30_000)
    const outcome = await options
      .runCheck({
        name: wake.id,
        command: trigger.command,
        cwd: wake.cwd,
        timeoutMs: trigger.timeoutMs,
        run,
        sessionId: wake.sessionId,
        signal: shutdown.signal,
      })
      .finally(() => clearInterval(keep))
    emit({ type: "checked", wakeId: wake.id, outcome })
    const now = clock.now()
    switch (outcome.kind) {
      case "interrupted":
        return
      case "error": {
        const errors = wake.errors + 1
        if (errors >= WAKE_LIMITS.check.maxConsecutiveErrors) return failCheck(wake, `its check could not complete ${errors} times in a row; the last time ${outcome.message}.`)
        store.recordRun(owner.id, wake.id, {
          now,
          nextAt: Math.min(now + checkBackoff(trigger.intervalMs, errors), wake.limits.expiresAt),
          errors,
          lastError: outcome.message,
          lastRun: `could not complete at ${isoTime(now)}: ${outcome.message}`,
        })
        return
      }
      case "exited": {
        const lastRun = `exit ${outcome.exitCode} at ${isoTime(now)}`
        const changed = trigger.fire === "on_change" && claim.observed !== null && claim.observed !== outcome.fingerprint
        const fires = trigger.fire === "until" ? outcome.exitCode === 0 : changed
        if (!fires) {
          store.recordRun(owner.id, wake.id, { now, nextAt: nextAfter(wake, now, false).nextAt, errors: 0, lastError: null, lastRun, observed: outcome.fingerprint })
          return
        }
        const untrusted: CheckEvidence["untrusted"] = run.kind === "unsandboxed" ? "unsandboxed" : run.network ? "network" : null
        const evidence = { exitCode: outcome.exitCode, output: outcome.output, totalBytes: outcome.totalBytes, ranAt: now, untrusted }
        await afterFire(
          wake.id,
          store.fire(owner.id, wake.id, {
            source: "check",
            now,
            dueAt: now,
            untrusted: untrusted !== null,
            lastRun,
            observed: outcome.fingerprint,
            ...(trigger.fire === "until" ? { completes: "its check passed" } : {}),
            text: (current, n) => firingText({ wake: current, n, source: "check", dueAt: now, now, check: evidence, shownBodyBytes: WAKE_LIMITS.webhook.shownBytes }),
          }),
        )
      }
    }
  }

  const failCheck = async (wake: WakeUp, reason: string) => {
    const now = clock.now()
    const notice = store.fail(owner.id, wake.id, reason, now, (current) => noticeText(current, reason, now))
    if (notice === null) return
    emit({ type: "failed", wakeId: wake.id, reason })
    await deliverAll([notice])
  }

  const runDue = async () => {
    for (;;) {
      dispatch()
      if (tasks.size === 0) return
      await Promise.all([...tasks])
    }
  }

  return {
    owner: owner.id,
    poke,
    runDue,
    start: () => {
      if (loop !== null || stopped) return
      loop = (async () => {
        while (!stopped) {
          const current = new AbortController()
          sleeper = current
          let wait = maxIdleMs
          try {
            dispatch()
            const now = clock.now()
            const next = store.nextDueAt(owner.id, now, probeMs)
            // Something due that could not be taken now (every check slot busy) is looked at when a task ends (it pokes), or in a second.
            if (next !== null) wait = Math.min(maxIdleMs, Math.max(next <= now ? 1000 : 0, next - now))
          } catch (error) {
            emit({ type: "error", error })
            wait = Math.min(maxIdleMs, 5000)
          }
          if (!current.signal.aborted && !stopped) await clock.sleep(wait, current.signal)
        }
      })()
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      sleeper?.abort()
      shutdown.abort()
      await loop
      const grace = options.stopGraceMs ?? 5000
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.all([...tasks]), new Promise<void>((resolve) => (timer = setTimeout(resolve, grace)))])
      clearTimeout(timer)
      // A firing recorded and not delivered stays open; whoever takes the lease next delivers it with the same key.
      store.releaseAll(owner.id)
      owner.close()
    },
  }
}
