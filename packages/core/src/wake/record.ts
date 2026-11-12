/**
 * The wake-up record: what it delivers, to which session, when, how often at most, and who asked for it. Pure:
 * validation of a new wake-up, the trigger arithmetic and the limits. The store (`store.ts`) keeps these rows.
 *
 * A wake-up says "deliver this message to this session when this condition is met". Its message is frozen when it
 * is created; what a firing adds (a check's output, a webhook's body) is frozen into the firing when it happens.
 */
import { type Infer, array, boolean, integer, nonEmptyString, nullable, object, oneOf, variant, literal } from "../validate.ts"
import { CronError, isTimeZone, localTimeZone, nextCronTime, parseCron } from "./cron.ts"

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Every limit, in one place. The listing shows the ones that apply to each wake-up. `model` limits apply to
 * wake-ups the model creates with the tool, `user` limits to ones the user creates through a client.
 */
export const WAKE_LIMITS = {
  /** Firings delivered to one session in any rolling hour, across all its wake-ups. Configurable up to `max`. */
  hourlyCeiling: { default: 12, max: 60 },
  model: {
    /** Wake-ups of one session that are still pending. */
    maxActive: 10,
    maxFirings: { default: 10, max: 100 },
    /** A wake-up stops (expires) this long after it was created, at the latest. */
    expiry: { defaultMs: DAY, maxMs: 7 * DAY },
  },
  user: {
    maxActive: 100,
    maxFirings: { default: 100, max: 10_000 },
    expiry: { defaultMs: 30 * DAY, maxMs: 365 * DAY },
  },
  /** The least time between two firings of one wake-up. */
  minInterval: { defaultMs: MINUTE, minMs: 10 * SECOND },
  /** A one-shot (`at`, `after`) missed while nothing ran is still delivered this long after its time. */
  lateGraceMs: DAY,
  every: { minMs: MINUTE, maxMs: 30 * DAY },
  check: {
    interval: { minMs: 15 * SECOND, maxMs: DAY },
    timeout: { defaultMs: 60 * SECOND, maxMs: 10 * MINUTE },
    /** Consecutive runs that could not complete (timed out, killed, could not start) before the wake-up fails. */
    maxConsecutiveErrors: 5,
    /** Backoff after such a run: the interval doubled per error, capped here. */
    maxBackoffMs: HOUR,
    /** What of the output a firing includes: the beginning and the end. */
    shownBytes: 4096,
  },
  webhook: {
    maxBodyBytes: 64 * 1024,
    /** What of the body a firing includes. */
    shownBytes: 8 * 1024,
    /** How far a signed timestamp may be from the listener's clock. */
    toleranceMs: 5 * MINUTE,
    requestsPerMinute: 30,
  },
  messageChars: 4000,
  commandChars: 2000,
  /** Delivery retries while the session cannot take the message: from `minMs`, doubling, to `maxMs`. */
  deliveryRetry: { minMs: 5 * SECOND, maxMs: 5 * MINUTE },
} as const

export type Author = "user" | "model"
export const author = oneOf(["user", "model"])

/**
 * How a check command is allowed to run: exactly what the approval decision gave when the wake-up was created.
 * `sandboxed` with `network: false` and no extra roots is the default for a model's command in `auto` mode.
 */
export const runAs = variant("kind", {
  sandboxed: object({ kind: literal("sandboxed"), network: boolean, writableRoots: array(nonEmptyString) }),
  unsandboxed: object({ kind: literal("unsandboxed") }),
})
export type RunAs = Infer<typeof runAs>

export const SANDBOXED_OFFLINE: RunAs = { kind: "sandboxed", network: false, writableRoots: [] }

/**
 * The narrower of two ways to run: the run recorded at creation, further limited by what the approval layer would
 * allow now (`current`, e.g. sandboxed because the session has since become tainted). Never wider than `recorded`.
 */
export function narrowRun(recorded: RunAs, current: RunAs | null): RunAs {
  if (current === null || current.kind === "unsandboxed") return recorded
  if (recorded.kind === "unsandboxed") return current
  return {
    kind: "sandboxed",
    network: recorded.network && current.network,
    writableRoots: recorded.writableRoots.filter((root) => current.writableRoots.includes(root)),
  }
}

export const checkFire = oneOf(["until", "on_change"])

/** A trigger as stored. Times in ms since the epoch, durations in ms. */
export const trigger = variant("kind", {
  /** Once, at `at`. `delayMs` is set when it was asked for as "after a delay". */
  at: object({ kind: literal("at"), at: integer(0), delayMs: nullable(integer(1)) }),
  /** At `anchor + k * intervalMs` for k = 1, 2, … */
  every: object({ kind: literal("every"), intervalMs: integer(1), anchor: integer(0) }),
  cron: object({ kind: literal("cron"), expression: nonEmptyString, timeZone: nonEmptyString }),
  /**
   * Run `command` every `intervalMs`, without the model. `until`: fire the first time it exits 0, then complete.
   * `on_change`: fire each time what it printed or its exit code differs from the run before (the first run only
   * records the starting point).
   */
  check: object({
    kind: literal("check"),
    command: nonEmptyString,
    intervalMs: integer(1),
    fire: checkFire,
    timeoutMs: integer(1),
    includeOutput: boolean,
  }),
  /** A signed HTTP request to the local listener. */
  webhook: object({ kind: literal("webhook"), includeBody: boolean }),
})
export type Trigger = Infer<typeof trigger>

/** Who asked for it, in which session and at which point of that session. */
export const provenance = object({
  author,
  sessionId: nonEmptyString,
  /** The assistant message and call that created it (the model), or `null` (the user). */
  messageId: nullable(nonEmptyString),
  callId: nullable(nonEmptyString),
  /** The session's `seq` at creation, when the caller knows it. */
  seq: nullable(integer(0)),
  /** The creating session had taken in untrusted content. */
  tainted: boolean,
  createdAt: integer(0),
})
export type Provenance = Infer<typeof provenance>

/** `wake`: start a turn if the session is idle, else wait until the turn in progress ends. `queue`: wait in the inbox, start nothing. */
export const wakeDelivery = oneOf(["wake", "queue"])
export type WakeDelivery = Infer<typeof wakeDelivery>

export type WakeStateKind = "pending" | "completed" | "cancelled" | "expired" | "failed"

export interface WakeState {
  readonly kind: WakeStateKind
  /** When it left `pending`. */
  readonly at: number | null
  /** Why: the last firing, the expiry, the canceller's reason, the failure. */
  readonly reason: string | null
  /** For `cancelled`: who. */
  readonly by: Author | null
}

export interface WakeLimitsOf {
  readonly maxFirings: number
  readonly expiresAt: number
  readonly minIntervalMs: number
}

export interface WakeUp {
  readonly id: string
  readonly sessionId: string
  /** Frozen at creation. */
  readonly message: string
  readonly trigger: Trigger
  readonly delivery: WakeDelivery
  readonly limits: WakeLimitsOf
  readonly provenance: Provenance
  /** For a check: how its command may run (see `narrowRun`) and where. `null` for other triggers. */
  readonly run: RunAs | null
  readonly cwd: string | null
  readonly state: WakeState
  /** Firings so far (each is one delivered message, or one waiting to be). */
  readonly fired: number
  /** When it is next due; `null` for a webhook, and once it has ended. */
  readonly nextAt: number | null
  readonly lastFiredAt: number | null
  /** Consecutive check runs that could not complete. */
  readonly errors: number
  readonly lastError: string | null
  /** The last check run, in words (`exit 1 at …`), for the listing. */
  readonly lastRun: string | null
  /** Why it is not due when it otherwise would be, e.g. the hourly ceiling. */
  readonly held: string | null
  readonly createdAt: number
}

/** One message a wake-up produced, waiting to be delivered or delivered. */
export interface Firing {
  /**
   * The idempotency key: the engine admits the message to the inbox with this as its message ID, so a firing that
   * is delivered again after a crash is recognised as already admitted (a reused message ID). Stable: derived
   * from the wake-up's ID and the firing's number.
   */
  readonly key: string
  readonly wakeId: string
  readonly sessionId: string
  /** 1, 2, … for firings; 0 for the notice that a wake-up stopped. */
  readonly n: number
  readonly source: "timer" | "check" | "webhook" | "notice"
  readonly delivery: WakeDelivery
  /** The whole message, frozen: the header that says where it comes from, the wake-up's message, any output or body. */
  readonly text: string
  /** It carries content from outside the harness (a webhook body, the output of a check that had the network). */
  readonly untrusted: boolean
  readonly createdAt: number
  /** When it was due (for a timer that fired late, earlier than `createdAt`). */
  readonly dueAt: number
  readonly attempts: number
  readonly deliveredAt: number | null
}

export function firingKey(wakeId: string, n: number): string {
  return n === 0 ? `msg_${wakeId}_notice` : `msg_${wakeId}_${n}`
}

export function newWakeId(): string {
  return `wk_${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`
}

// ---------------------------------------------------------------- new wake-ups

/** A trigger as a caller asks for it. */
export type TriggerRequest =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "after"; readonly delayMs: number }
  | { readonly kind: "every"; readonly intervalMs: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timeZone?: string }
  | { readonly kind: "check"; readonly command: string; readonly intervalMs: number; readonly fire: "until" | "on_change"; readonly timeoutMs?: number; readonly includeOutput?: boolean }
  | { readonly kind: "webhook"; readonly includeBody?: boolean }

export interface NewWake {
  readonly sessionId: string
  readonly message: string
  readonly trigger: TriggerRequest
  readonly delivery?: WakeDelivery
  readonly maxFirings?: number
  readonly expiresAt?: number
  readonly minIntervalMs?: number
  readonly author: Author
  readonly messageId?: string | null
  readonly callId?: string | null
  readonly seq?: number | null
  readonly tainted?: boolean
  /** Required for a check: how the command was approved to run, and the session's working directory. */
  readonly run?: RunAs
  readonly cwd?: string
}

export type Prepared = Omit<WakeUp, "id"> & { readonly webhook: boolean }

/** Validates a request and fills in the defaults. Returns a sentence for the model or the user when it is refused. */
export function prepareWake(input: NewWake, now: number): { readonly ok: true; readonly wake: Prepared } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, wake: prepare(input, now) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.message }
    if (error instanceof CronError) return { ok: false, error: `${error.message}.` }
    throw error
  }
}

class Refused extends Error {}

function refuse(message: string): never {
  throw new Refused(message)
}

function prepare(input: NewWake, now: number): Prepared {
  const bounds = WAKE_LIMITS[input.author]
  const message = input.message.trim()
  if (message === "") refuse("The message is empty: say what should happen when the wake-up fires.")
  if (message.length > WAKE_LIMITS.messageChars) refuse(`The message is ${message.length} characters long; the limit is ${WAKE_LIMITS.messageChars}.`)

  const built = buildTrigger(input.trigger, now)
  const oneShot = built.trigger.kind === "at" || (built.trigger.kind === "check" && built.trigger.fire === "until")
  const maxFirings = oneShot ? 1 : (input.maxFirings ?? bounds.maxFirings.default)
  if (!Number.isInteger(maxFirings) || maxFirings < 1 || maxFirings > bounds.maxFirings.max)
    refuse(`maxFirings must be a whole number from 1 to ${bounds.maxFirings.max}.`)
  const minIntervalMs = input.minIntervalMs ?? WAKE_LIMITS.minInterval.defaultMs
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < WAKE_LIMITS.minInterval.minMs)
    refuse(`The minimum interval between firings is at least ${WAKE_LIMITS.minInterval.minMs / SECOND} seconds.`)

  // A one-shot may be set up to the maximum expiry ahead; missed, it is still delivered for a grace period after its time.
  const latest = now + bounds.expiry.maxMs
  if (built.trigger.kind === "at" && built.trigger.at > latest) refuse(`That time is too far ahead: a wake-up can be set at most ${days(bounds.expiry.maxMs)} ahead.`)
  const expiresAt =
    input.expiresAt ?? (built.trigger.kind === "at" ? built.trigger.at + WAKE_LIMITS.lateGraceMs : now + bounds.expiry.defaultMs)
  if (!Number.isInteger(expiresAt) || expiresAt <= now) refuse("The expiry must be in the future.")
  if (built.trigger.kind !== "at" && expiresAt > latest) refuse(`A wake-up may run for at most ${days(bounds.expiry.maxMs)}; choose an earlier expiry.`)
  if (built.trigger.kind === "at" && expiresAt < built.trigger.at) refuse("The expiry is before the time the wake-up is set for.")

  if (built.trigger.kind === "check") {
    if (input.run === undefined || input.cwd === undefined) refuse("A check needs the decision it runs under and a working directory.")
  }
  return {
    sessionId: input.sessionId,
    message,
    trigger: built.trigger,
    delivery: input.delivery ?? "wake",
    limits: { maxFirings, expiresAt, minIntervalMs },
    provenance: {
      author: input.author,
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      callId: input.callId ?? null,
      seq: input.seq ?? null,
      tainted: input.tainted ?? false,
      createdAt: now,
    },
    run: built.trigger.kind === "check" ? input.run! : null,
    cwd: built.trigger.kind === "check" ? input.cwd! : null,
    state: { kind: "pending", at: null, reason: null, by: null },
    fired: 0,
    nextAt: built.first,
    lastFiredAt: null,
    errors: 0,
    lastError: null,
    lastRun: null,
    held: null,
    createdAt: now,
    webhook: built.trigger.kind === "webhook",
  }
}

function buildTrigger(request: TriggerRequest, now: number): { trigger: Trigger; first: number | null } {
  switch (request.kind) {
    case "at":
      if (!Number.isFinite(request.at)) refuse("The time is not valid.")
      if (request.at <= now) refuse("That time has already passed; give a time in the future.")
      return { trigger: { kind: "at", at: Math.round(request.at), delayMs: null }, first: Math.round(request.at) }
    case "after": {
      const delay = Math.round(request.delayMs)
      if (!Number.isFinite(delay) || delay < SECOND) refuse("The delay must be at least one second.")
      return { trigger: { kind: "at", at: now + delay, delayMs: delay }, first: now + delay }
    }
    case "every": {
      const interval = Math.round(request.intervalMs)
      if (!Number.isFinite(interval) || interval < WAKE_LIMITS.every.minMs || interval > WAKE_LIMITS.every.maxMs)
        refuse(`The interval must be from ${WAKE_LIMITS.every.minMs / SECOND} seconds to ${days(WAKE_LIMITS.every.maxMs)}.`)
      return { trigger: { kind: "every", intervalMs: interval, anchor: now }, first: now + interval }
    }
    case "cron": {
      const timeZone = request.timeZone ?? localTimeZone()
      if (!isTimeZone(timeZone)) refuse(`Unknown time zone "${timeZone}"; use an IANA name such as Europe/Berlin or UTC.`)
      const schedule = parseCron(request.expression)
      const first = nextCronTime(schedule, now, timeZone)
      if (first === null) refuse(`The cron expression "${request.expression}" does not match any time in the next eight years.`)
      return { trigger: { kind: "cron", expression: schedule.expression, timeZone }, first }
    }
    case "check": {
      const command = request.command.trim()
      if (command === "") refuse("The check command is empty.")
      if (command.length > WAKE_LIMITS.commandChars) refuse(`The check command is longer than ${WAKE_LIMITS.commandChars} characters.`)
      const interval = Math.round(request.intervalMs)
      const bounds = WAKE_LIMITS.check.interval
      if (!Number.isFinite(interval) || interval < bounds.minMs || interval > bounds.maxMs)
        refuse(`The check interval must be from ${bounds.minMs / SECOND} seconds to ${days(bounds.maxMs)}.`)
      const timeout = Math.round(request.timeoutMs ?? Math.min(WAKE_LIMITS.check.timeout.defaultMs, interval))
      if (!Number.isFinite(timeout) || timeout < SECOND || timeout > WAKE_LIMITS.check.timeout.maxMs)
        refuse(`The check timeout must be from 1 to ${WAKE_LIMITS.check.timeout.maxMs / SECOND} seconds.`)
      if (request.fire !== "until" && request.fire !== "on_change") refuse('The check must fire "until" it passes or "on_change".')
      // The first run is at once: what is waited for may already be the case.
      return { trigger: { kind: "check", command, intervalMs: interval, fire: request.fire, timeoutMs: timeout, includeOutput: request.includeOutput ?? true }, first: now }
    }
    case "webhook":
      return { trigger: { kind: "webhook", includeBody: request.includeBody ?? true }, first: null }
  }
}

function days(ms: number): string {
  return ms % DAY === 0 ? `${ms / DAY} ${ms === DAY ? "day" : "days"}` : `${Math.round(ms / HOUR)} hours`
}

// ---------------------------------------------------------------- when next

/**
 * When the wake-up is next due after firing (or after a check run) at `now`, and whether that firing was its last.
 * The catch-up rule lives here: the next time is always computed from `now`, never from the time that was
 * missed, so a wake-up that was due many times while nothing ran fires once and then resumes its schedule.
 */
export function nextAfter(wake: Pick<WakeUp, "trigger" | "limits" | "fired">, now: number, fired: boolean): { readonly nextAt: number | null; readonly last: boolean } {
  const count = wake.fired + (fired ? 1 : 0)
  if (fired && count >= wake.limits.maxFirings) return { nextAt: null, last: true }
  const floor = fired ? now + wake.limits.minIntervalMs : now
  const trigger = wake.trigger
  switch (trigger.kind) {
    case "at":
      return fired ? { nextAt: null, last: true } : { nextAt: trigger.at, last: false }
    case "every": {
      // Keep the phase: the first anchor + k * interval after the floor.
      const k = Math.floor((Math.max(floor, now) - trigger.anchor) / trigger.intervalMs) + 1
      return { nextAt: within(wake, trigger.anchor + k * trigger.intervalMs), last: false }
    }
    case "cron": {
      const next = nextCronTime(parseCron(trigger.expression), Math.max(now, floor - 1), trigger.timeZone)
      return { nextAt: next === null ? wake.limits.expiresAt : within(wake, next), last: false }
    }
    case "check":
      return { nextAt: within(wake, Math.max(now + trigger.intervalMs, floor)), last: false }
    case "webhook":
      return { nextAt: null, last: false }
  }
}

/** A next time past the expiry is the expiry: the wake-up is looked at then and expires. */
function within(wake: Pick<WakeUp, "limits">, at: number): number {
  return Math.min(at, wake.limits.expiresAt)
}

/** The wait before the next run of a check after `errors` consecutive runs that could not complete. */
export function checkBackoff(intervalMs: number, errors: number): number {
  return Math.min(intervalMs * 2 ** Math.max(0, errors), Math.max(WAKE_LIMITS.check.maxBackoffMs, intervalMs))
}

/** The wait before delivering a firing again after `attempts` attempts the session could not take. */
export function deliveryBackoff(attempts: number): number {
  return Math.min(WAKE_LIMITS.deliveryRetry.minMs * 2 ** Math.max(0, attempts - 1), WAKE_LIMITS.deliveryRetry.maxMs)
}

// ---------------------------------------------------------------- words

export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "at":
      return trigger.delayMs === null ? `at ${isoTime(trigger.at)}` : `after ${duration(trigger.delayMs)} (at ${isoTime(trigger.at)})`
    case "every":
      return `every ${duration(trigger.intervalMs)}`
    case "cron":
      return `cron "${trigger.expression}" (${trigger.timeZone})`
    case "check":
      return `run \`${trigger.command}\` every ${duration(trigger.intervalMs)} ${trigger.fire === "until" ? "until it exits 0" : "and fire when its output changes"} (timeout ${duration(trigger.timeoutMs)})`
    case "webhook":
      return `a signed webhook request${trigger.includeBody ? "" : " (body not included)"}`
  }
}

export function describeRun(run: RunAs): string {
  if (run.kind === "unsandboxed") return "without the sandbox"
  const extra = [run.network ? "with network" : "no network", ...(run.writableRoots.length === 0 ? [] : [`also writing ${run.writableRoots.join(", ")}`])]
  return `in the sandbox, ${extra.join(", ")}`
}

export function isoTime(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function duration(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY}d`
  if (ms % HOUR === 0) return `${ms / HOUR}h`
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`
  if (ms % SECOND === 0) return `${ms / SECOND}s`
  return `${ms}ms`
}

