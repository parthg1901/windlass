/**
 * The step loop's numbers and the texts it freezes into the log, in one place.
 *
 * The numbers are the ones `docs/step-loop-scenarios.md` uses (an attempt
 * budget of 5, a crash-resume cap of 3, retry delays that double from 2 s).
 * The texts are what the model reads when the loop, not a tool or the model,
 * decides an outcome. They are written once, into the event, and replayed
 * byte for byte from then on, so changing one here never changes a stored
 * session.
 */
import type { ProviderError } from "../provider/error.ts"

export interface EngineLimits {
  /** Attempts of one logical step: the first call plus its retries. One budget, no nested retries (retry rule 1). */
  readonly attemptBudget: number
  /** Delay before the first retry. It doubles with every further attempt. */
  readonly retryBaseDelayMs: number
  /** The doubling stops here. */
  readonly retryMaxDelayMs: number
  /** Jitter added on top of the backoff, as a fraction of it: the delay is `backoff * (1 + retryJitter * random())`. */
  readonly retryJitter: number
  /** A provider's retry-after is a minimum delay, but never more than this (retry rule 4). */
  readonly retryAfterCapMs: number
  /** How many times recovery takes up the same execution again after a crash before it gives up. */
  readonly crashResumeCap: number
  /**
   * Steps of one turn (from a user's input to the answer) before the loop
   * makes one final call with tools forbidden. A caller can lower or raise it
   * per turn with `send(text, { maxSteps })`.
   */
  readonly stepLimit: number
  /** Tool calls of one step that are run. Calls beyond it are answered with an error and not run. */
  readonly maxToolCallsPerStep: number
  /**
   * How long the loop waits for running tools to stop after an interrupt.
   * A tool that has not returned by then is settled from its effect class and
   * abandoned. Longer than the shell's own grace period plus its drain.
   */
  readonly toolStopGraceMs: number
  /**
   * The longest one model call may take, from sending the request to its
   * terminal event. A call still running then is stopped and fails as a
   * `transport` error with reason `timeout`, which is retried like any other
   * within the step's attempt budget. Generous on purpose: a long answer at
   * high reasoning effort takes many minutes, and the provider's own idle
   * timeout already catches a connection that went quiet. `0` means no limit.
   */
  readonly modelCallTimeoutMs: number
  /**
   * Snapshot retention, per session: of the snapshots no revert or undo
   * could still need, the newest this many are kept ...
   */
  readonly snapshotKeepLast: number
  /** ... and none older than this. An archived session keeps none of them. */
  readonly snapshotMaxAgeMs: number
}

export const ENGINE_LIMITS: EngineLimits = {
  attemptBudget: 5,
  retryBaseDelayMs: 2000,
  retryMaxDelayMs: 32_000,
  retryJitter: 0.25,
  retryAfterCapMs: 120_000,
  crashResumeCap: 3,
  stepLimit: 60,
  maxToolCallsPerStep: 32,
  toolStopGraceMs: 10_000,
  modelCallTimeoutMs: 30 * 60_000,
  snapshotKeepLast: 100,
  snapshotMaxAgeMs: 30 * 24 * 3600_000,
}

/**
 * How long to wait before the attempt after `failedAttempt` (1 for the first
 * call). Exponential from the base, capped, with jitter that only ever adds;
 * a provider's retry-after is a minimum, itself capped.
 */
export function retryDelayMs(limits: EngineLimits, failedAttempt: number, error: ProviderError, random: () => number): number {
  const backoff = Math.min(limits.retryBaseDelayMs * 2 ** (failedAttempt - 1), limits.retryMaxDelayMs)
  const jittered = backoff * (1 + limits.retryJitter * random())
  const asked = error.retryAfterMs === null ? 0 : Math.min(error.retryAfterMs, limits.retryAfterCapMs)
  return Math.round(Math.max(jittered, asked))
}

/** The texts the loop freezes into `tool.settled.output` when it decides a call's outcome. */
export const TOOL_TEXT = {
  /** A recorded call that never began: the response was cut short, or it hit the output limit. */
  notStarted: "Not run: the response was stopped before this call started. It is safe to call it again.",
  /** A read that was stopped and returned nothing. */
  interruptedRead: "Stopped before it finished. Nothing was changed; it is safe to call it again.",
  /** A side-effecting call that was stopped and returned nothing. */
  effectUnknown:
    "Started, but stopped before it reported a result. It may or may not have taken effect: check the current state before repeating it.",
  /** A read the previous process died in. */
  crashRead: "Cut short by a restart before it finished. Nothing was changed; it is safe to call it again.",
  /** A side-effecting call the previous process died in, or died after before its result was written. */
  crashEffectUnknown:
    "Started, but the harness restarted before its result was recorded. It may or may not have taken effect: check the current state before repeating it.",
  /** The identical-call guard (retry rule 9). */
  identicalCall:
    "Not run: this exact call already ran twice in this turn with the same result. Use that result or try something else.",
  /** A call made in the final step of a turn, where tools are forbidden. */
  toolsDisabled: "Not run: tools are disabled for this response because the step limit for this turn was reached.",
  /** A call beyond `maxToolCallsPerStep`. */
  tooManyCalls: (limit: number) =>
    `Not run: one response may run at most ${limit} tool calls, and this one was past that. Call it again in your next response.`,
} as const

/** The texts of the harness messages the loop appends (`synthetic.appended`), by origin. */
export const NOTE_TEXT = {
  /** The interrupt marker after a user cancel. */
  interruptedByUser: "The user stopped the previous response before it finished.",
  /** The interrupt marker after a shutdown or a crash. */
  interruptedByRestart: "The previous response was cut short when the harness restarted.",
  continuation:
    "Your previous response was cut off by a provider error. Continue exactly where it stopped; do not repeat what you already wrote.",
  outputLimit:
    "Your last response reached the output limit while writing a tool call, so the call was not run. Split the work into smaller calls.",
  emptyResponse: "Your last response was empty. Continue with the task, or say that you are done.",
  stepLimit: "You have reached the step limit for this turn, so tools are disabled. Summarise what you did and what is left.",
} as const

/** The messages of `execution.failed`, written for a person. */
export const FAILURE_TEXT = {
  refused: "The provider refused the request.",
  emptyTwice: "The model returned an empty response twice.",
  signedOut: "Signed out: sign in again to continue.",
  budget: (attempts: number, error: ProviderError) => `The model call failed ${attempts} times: ${error.message}`,
  crashCap: (cap: number) => `Gave up after the harness restarted ${cap} times during this turn.`,
  overflow: "The conversation no longer fits the model's context window, even after compacting it.",
  compaction: (reason: string) => `Could not compact the conversation: ${reason}`,
  stepLimitIgnored: "The step limit was reached and the model kept asking for tools.",
  config: (problem: string) => `The configuration could not be loaded: ${problem}`,
  internal: (message: string) => `The harness failed: ${message}`,
} as const

/** The message for a model call that failed with an error that is never retried. */
export function failureText(error: ProviderError): string {
  if (error.kind === "auth") return FAILURE_TEXT.signedOut
  if (error.kind === "usage_limit" && error.retryAfterMs !== null) return `${error.message} It resets in ${duration(error.retryAfterMs)}.`
  return error.message
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? "" : "s"}`
}

/** The message of the error a model call fails with when it reaches `modelCallTimeoutMs`. */
export const modelCallTimedOut = (limitMs: number) => `The model call did not finish within ${duration(limitMs)}`

/** The message a provider stream gets when it ends with neither `finish` nor `error` and nobody aborted it. */
export const INCOMPLETE_STREAM = "The stream ended without a terminal event"

/**
 * The one prompt a compaction request adds to the step request (context rule
 * 7). The answer is the checkpoint text, rendered once and stored.
 */
export const COMPACTION_PROMPT = [
  "The conversation above is about to be replaced by a summary, because it no longer fits the context window. Write that summary now. Do not call tools.",
  "Whoever continues will see only your summary and the messages after it, so include everything they need:",
  "- what the user asked for, and every instruction or preference they gave, in their own words where it matters;",
  "- what was done: files read or changed (with paths), commands run and what they showed, decisions and why;",
  "- the current state: what works, what fails (with exact error text), what was being done when the summary was taken;",
  "- what is left to do.",
  "Be specific and plain. Do not address the user and do not add a preamble.",
].join("\n")
