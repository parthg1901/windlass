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
import { type SummaryProblem, describeProblem, summaryPrompt } from "../context/summary.ts"
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
   * Steps of one turn (from a user's input, or a queued item, to the answer)
   * before the loop makes one final call with tools forbidden. A message the
   * harness delivers in the middle of the turn does not start the count
   * again. A caller can lower or raise it per turn with `send(text, { maxSteps })`.
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
   * The longest one summary call of a compaction may take. Much shorter than
   * a step's limit: a summary is a bounded piece of text, and a call that is
   * still writing after this long is not going to end well (the first live
   * run met one that wrote for fifteen minutes). A call still running then is
   * not tried again: the compaction completes without a summary. `0` means
   * no limit.
   */
  readonly compactionCallTimeoutMs: number
  /**
   * Input tokens of the context window the compaction policy leaves free for
   * the model's answer. This provider takes no output limit, so it is the
   * harness's own allowance, and never more than a fifth of the window.
   */
  readonly reservedOutputTokens: number
  /**
   * Snapshot retention, per session: of the snapshots no revert or undo
   * could still need, the newest this many are kept ...
   */
  readonly snapshotKeepLast: number
  /** ... and none older than this. An archived session keeps none of them. */
  readonly snapshotMaxAgeMs: number
  /**
   * A compaction the user asks for is made only when it would take at least
   * this many tokens of history out of the model's view: below that the
   * checkpoint that replaces them is about as large as they are, and the
   * summary call would be spent for nothing.
   */
  readonly manualCompactionMinTokens: number
}

export const ENGINE_LIMITS: EngineLimits = {
  manualCompactionMinTokens: 2_000,
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
  compactionCallTimeoutMs: 5 * 60_000,
  reservedOutputTokens: 32_000,
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
/** What the loop answers about a program (`run_code`) and the calls it makes. Frozen into the log where they are results. */
export const CODE_TEXT = {
  /** The program's call, where nothing could keep the program to its calls. */
  noSandbox: "Not run: a program runs only in the sandbox, and commands cannot be sandboxed on this machine. Make the calls directly.",
  /** A call of a program that is being stopped (the program's call was stopped, the turn interrupted): answered to the program, not recorded. */
  stopped: "Not run: the program is being stopped.",
  /** A call of a program that was recorded and waited for an earlier one, and the program was stopped meanwhile. */
  notStarted: "Not run: the program was stopped before this call started.",
  /** The shell's `background` from a program: work that would outlive it. */
  background: "Not run: a program cannot start a command in the background. Start it with a direct shell call.",
} as const

export const TOOL_TEXT = {
  /** A recorded call that never began: the response was cut short, or it hit the output limit. */
  notStarted: "Not run: the response was stopped before this call started. It is safe to call it again.",
  /** A read that was stopped and returned nothing. */
  interruptedRead: "Stopped before it finished. Nothing was changed; it is safe to call it again.",
  /** A side-effecting call that was stopped and returned nothing. */
  effectUnknown:
    "Started, but stopped before it reported a result. It may or may not have taken effect: check the current state before repeating it.",
  /** A read the user stopped by itself (the turn went on) and that returned nothing. */
  cancelledRead: "Stopped by the user before it finished; the user stopped this call only, and the turn goes on. Nothing was changed.",
  /** A side-effecting call the user stopped by itself and that returned nothing. */
  cancelledEffectUnknown:
    "Stopped by the user before it reported a result; the user stopped this call only, and the turn goes on. It may or may not have taken effect: check the current state before repeating it.",
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
/** What a compaction the user asked for answers when it does not compact. */
export const MANUAL_COMPACTION_TEXT = {
  nothingYet: "There is nothing to compact: the conversation has not started.",
  nothingToRemove: "There is nothing to compact: what is in the model's view is what the next request needs (the latest input, or a checkpoint and what followed it).",
  /** The whole conversation is within what a compaction keeps word for word for this model's window (`budget`), so there is no part to summarise. */
  allRecent: (tokens: number, budget: number) =>
    `There is nothing to compact yet: the whole conversation, about ${Math.round(tokens).toLocaleString("en-US")} tokens, is within what a compaction keeps word for word (up to about ${Math.round(budget).toLocaleString("en-US")} tokens with this model's context window). Ask again when the conversation has grown.`,
  /**
   * `tokens`: what is before the cut; `minimum`: from where a compaction is made. `kept` says what the rest is
   * and why it stays word for word, so that the user knows what to do about it:
   * - `recent`: the most recent part, within the `budget` a compaction keeps for this model's window;
   * - `input`: input the model has not answered yet;
   * - `response`: the model's last response with the results of its calls, which the next request answers;
   * - `little`: there is no more: the conversation is short.
   * `checkpoint`: how many of `tokens` are an earlier checkpoint (0: none).
   */
  tooSmall: (tokens: number, minimum: number, kept?: { readonly tokens: number; readonly why: "recent" | "input" | "response" | "little"; readonly budget: number; readonly checkpoint: number }) => {
    const count = (value: number) => Math.round(value).toLocaleString("en-US")
    const rest =
      kept === undefined
        ? ""
        : kept.why === "little"
          ? ` The conversation is short: about ${count(tokens + kept.tokens)} tokens in all.`
          : kept.why === "recent"
            ? ` The other ${count(kept.tokens)} tokens are the most recent part of the conversation, which a compaction keeps word for word (up to about ${count(kept.budget)} tokens with this model's context window), so there is nothing to gain yet: ask again when the conversation has grown.`
            : kept.why === "input"
              ? ` The other ${count(kept.tokens)} tokens are input the model has not answered yet, which is kept word for word: ask again after its answer.`
              : ` The other ${count(kept.tokens)} tokens are the model's last response with the results of its calls, which is kept word for word because the next request answers it: ask again after the next turn.`
    const earlier = kept === undefined || kept.checkpoint === 0 ? "" : ` (About ${count(kept.checkpoint)} of them are an earlier checkpoint, which is a summary already.)`
    return `Not compacted: only about ${count(tokens)} tokens of the conversation could be summarised${earlier}, and a checkpoint takes about as much.${rest} A compaction is worth it from about ${minimum.toLocaleString("en-US")} tokens.`
  },
  replay: "A replay session is not compacted.",
  reverting: "The session is being reverted; ask again when that is done.",
  closed: "The session was closed before the conversation could be compacted.",
  interrupted: "The compaction was interrupted; the conversation is unchanged.",
  ended: (why: string) => `The conversation was not compacted: ${why}`,
} as const

/** What the user is told, once, about how a turn ended when the events alone would leave them guessing. */
export const NOTICE_TEXT = {
  noClosingAnswer: "The model returned an empty response twice after its work, so the turn ended without a closing answer. What it did is shown above; ask it to sum up if you need that.",
} as const

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
  /** The default agent of the user's configuration cannot be used, so the session does not start without it. */
  agent: (problem: string) => `The session could not start as its agent: ${problem}`,
  /** The session's settings name something the model does not offer; nothing was sent. */
  settings: (problem: string) => `Nothing was sent: ${problem}. Change the settings and send the message again.`,
  internal: (message: string) => `The harness failed: ${message}`,
  /** The run was ended because a call needed approval and nobody was there (`unattended: "stop"`). `refusal` is what the model was told. */
  approvalStop: (refusal: string) => `Stopped: a tool call needed your approval and nobody was there to give it. ${refusal}`,
} as const

/** The first few problems of a summary, for a person: the rest are counted. */
function listProblems(problems: readonly SummaryProblem[]): string {
  const shown = problems.slice(0, 2).map(describeProblem)
  return problems.length > shown.length ? `${shown.join("; ")}; and ${problems.length - shown.length} more` : shown.join("; ")
}

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
 * The one prompt a compaction's summary request adds to the step request
 * (context rule 7). It is frozen into `compaction.started` when a compaction
 * begins, so a stored session keeps the prompt it was summarised with.
 */
export const COMPACTION_PROMPT = summaryPrompt()

/** Why a compaction completed without a model-written summary, or with one that is not quite right: `compaction.ended.detail`, for a person. */
export const COMPACTION_TEXT = {
  timedOut: (limitMs: number) => `the model did not finish its summary within ${duration(limitMs)}`,
  tooLarge: "the part to summarise is itself too large for the model",
  refused: "the provider refused to summarise the conversation",
  empty: "the model returned an empty summary",
  invalid: (problems: readonly SummaryProblem[]) => `the model's summary was unusable, also after it was asked to fix it: ${listProblems(problems)}`,
  flawed: (problems: readonly SummaryProblem[]) => `the summary is used although ${listProblems(problems)}`,
  repeated: "the model repeated its summary; its first copy is used",
} as const
