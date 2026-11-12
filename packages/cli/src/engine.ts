/**
 * The narrow interface between the command-line interface and the engine (the
 * step loop and the store behind it). The CLI needs nothing else from the
 * engine, so wiring the real one in means implementing these types.
 *
 * Everything the CLI shows comes from `Session.events`: the durable events the
 * engine appends and the ephemeral deltas it streams, in arrival order. The
 * CLI never asks the engine whether a turn is running; it reads that from the
 * `execution.*` events, the same way a reload of the log would.
 *
 * ## For the author of `real-engine.ts`
 *
 * The CLI loads `packages/cli/src/real-engine.ts` with a dynamic import and
 * calls its export `createRealEngine()` once, with no arguments, when a run is
 * not a `--demo` (see `select-engine.ts`). Everything per run arrives through
 * `Engine.open` and the optional listing methods. If the module is missing or
 * its import throws, the CLI prints one line and exits with code 2.
 *
 * What the CLI relies on, beyond the types below:
 * - `open` resolves once the session can take input; its recovery events, if
 *   any, are the first items of `events`.
 * - `send` may be called while an execution runs (steering). It must admit the
 *   item at once (`inbox.enqueued` with the given delivery) and resolve; the
 *   step loop delivers it later (`inbox.delivered`). A turn ends for the CLI
 *   only at `execution.succeeded`, `execution.failed` or `execution.interrupted`.
 * - `interrupt` must write `execution.interrupt_requested` (reason `user`)
 *   promptly: the CLI's "stopping" feedback is that event.
 * - `close` is called exactly once on every exit path (normal end, Ctrl-C at
 *   the prompt, SIGTERM, a closed stdout pipe), and the CLI waits for it for
 *   at most `CLOSE_TIMEOUT_MS` before exiting anyway. Anything still running
 *   is stopped as a `shutdown`, and `events` ends.
 * - `revert` and `undoRevert` are what `/undo` and `/redo` call. An engine
 *   that leaves them out has no undo, and the commands say so.
 */
import type { EphemeralEvent, HandEditPolicy, MessageId, RevertOptions, RevertPlan, RevertResult, SessionId, StoredEvent } from "@light-harness/core"

/** One item of a session's event stream. Durable and ephemeral type names are disjoint, so `type` tells them apart. */
export type EngineEvent = StoredEvent | EphemeralEvent

/**
 * What `/undo` and `/redo` ask when the restore would overwrite files edited
 * by hand: how to treat them, or `null` to change nothing.
 */
export type HandEditQuestion = (plan: RevertPlan) => Promise<HandEditPolicy | null>

/** The engine's `RevertOptions`, where `handEdits: "ask"` puts `confirm` to the user when it comes to that. */
export interface SessionRevertOptions extends Omit<RevertOptions, "handEdits"> {
  readonly handEdits?: HandEditPolicy | "ask"
  /** With `handEdits: "ask"`: asked once the engine finds files edited by hand that the restore would overwrite. */
  readonly confirm?: HandEditQuestion
}

/** What the CLI suggests when the saved sign-in is missing or rejected. */
export const SIGN_IN_ADVICE = "sign in with ChatGPT, then try again"

/** Which session to work in. */
export type SessionTarget =
  /** A new session. */
  | { readonly kind: "new" }
  /** A named session (`--session <id>`). */
  | { readonly kind: "resume"; readonly id: string }
  /** The most recently used session in the working directory (`--continue`). */
  | { readonly kind: "continue" }

export interface OpenRequest {
  readonly session: SessionTarget
  /** Absolute working directory. */
  readonly cwd: string
  /** `null` keeps the session's or the configuration's default. */
  readonly model: string | null
  /** Provider-interpreted reasoning effort such as `"low"` or `"high"`; `null` keeps the default. */
  readonly effort: string | null
  /**
   * `--max-steps <n>`: the most model calls one turn may make before the loop
   * asks for a final answer without tools (the `step_limit` note). A whole
   * number of at least 1; `null` keeps the engine's default.
   */
  readonly maxSteps: number | null
}

/** How a message sent with `Session.send` reaches the model; the `delivery` of its `inbox.enqueued`. */
export type SendDelivery = "steer" | "queue"

export interface SendOptions {
  /**
   * - `steer` (the default): delivered at the next step boundary of the running
   *   execution, or starts one when the session is idle.
   * - `queue`: delivered only when the session would otherwise go idle.
   */
  readonly delivery?: SendDelivery
}

/** One row of `--list-sessions`. */
export interface SessionSummary {
  readonly id: SessionId
  readonly title: string | null
  readonly cwd: string
  /** Milliseconds since the Unix epoch of the session's latest event. */
  readonly updatedAt: number
  /** The session's current model (`settings.model`). */
  readonly model: string
}

/** One row of `--models`. */
export interface ModelInfo {
  readonly id: string
  /** A short description for the listing, or `null`. */
  readonly description: string | null
  /** Reasoning efforts `--effort` accepts for this model; empty when it has none. */
  readonly efforts: readonly string[]
  /** Whether a new session uses this model when `--model` is not given. */
  readonly isDefault: boolean
}

export interface Engine {
  /**
   * Opens or creates a session. If the session holds an execution claim from a
   * process that died or shut down, the engine recovers it here and the
   * recovery's events (`step.failed` crashed, `execution.resumed`, ...) are the
   * first items of `events`.
   */
  open(request: OpenRequest): Promise<Session>
  /**
   * `--list-sessions`: sessions whose working directory is `cwd`, most recently
   * used first. Optional: without it the flag reports that this engine cannot list sessions.
   */
  listSessions?(request: { readonly cwd: string }): Promise<readonly SessionSummary[]>
  /** `--models`: the models `--model` accepts. Optional, like `listSessions`. */
  listModels?(): Promise<readonly ModelInfo[]>
}

export interface Session {
  readonly id: SessionId
  /**
   * Every event of this session from the moment it was opened, in arrival
   * order. One consumer. Ends after `close`.
   */
  readonly events: AsyncIterable<EngineEvent>
  /**
   * Admits a user message (`inbox.enqueued`). When the session is idle the
   * engine starts an execution for it; while one runs, the message waits for
   * its delivery point (see `SendOptions`). Resolves with the inbox item's
   * message ID once it is admitted, or `null` when it was not.
   */
  send(text: string, options?: SendOptions): Promise<MessageId | null>
  /** Asks the running execution to stop with reason `user`. A no-op when nothing runs. */
  interrupt(): void
  /** `/undo`: goes back to before a user message (the latest by default), files and conversation. Only while idle. */
  revert?(options?: SessionRevertOptions): Promise<RevertResult>
  /** `/redo`: undoes the latest revert. Only while idle. */
  undoRevert?(options?: Omit<SessionRevertOptions, "messageId">): Promise<RevertResult>
  /** Stops anything still running (as a shutdown) and ends `events`. */
  close(): Promise<void>
  /**
   * Why `events` ended without `close`, as a sentence for the user: the
   * engine went away (its process died). `null` while all is well. Engines
   * in this process never lose their sessions and leave it out.
   */
  lost?(): string | null
}

/** How long the CLI waits for `Session.close` before it exits anyway. */
export const CLOSE_TIMEOUT_MS = 3000

/**
 * The terminal state of a turn, read from its `execution.*` event.
 * `unresolved` is an execution that ended as done although the project's
 * checks still fail (`execution.succeeded` whose `verification.status` is
 * `unresolved`): the model said it cannot fix them, ran out of rounds, or the
 * checks only report. It is not a success a script should build on.
 */
export type TurnOutcome = "succeeded" | "unresolved" | "failed" | "interrupted"

/** The exit code of a turn that ended with failing checks left unresolved. Distinct from done (0) and failed (1). */
export const EXIT_UNRESOLVED = 3

/** The process exit code for a turn's outcome. */
export function exitCodeOf(outcome: TurnOutcome): number {
  switch (outcome) {
    case "succeeded":
      return 0
    case "unresolved":
      return EXIT_UNRESOLVED
    case "failed":
      return 1
    case "interrupted":
      return 130
  }
}

/** The outcome an event ends a turn with, or `null` when it does not end one. */
export function turnOutcomeOf(event: EngineEvent): TurnOutcome | null {
  switch (event.type) {
    case "execution.succeeded":
      return event.data.verification.status === "unresolved" ? "unresolved" : "succeeded"
    case "execution.failed":
      return "failed"
    case "execution.interrupted":
      return "interrupted"
    default:
      return null
  }
}

/** Raised by `open` when the engine cannot work in this environment (no sign-in, no store). */
export class EngineUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineUnavailable"
  }
}
