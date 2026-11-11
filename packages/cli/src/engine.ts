/**
 * The narrow interface between the command-line interface and the engine (the
 * step loop and the store behind it). The CLI needs nothing else from the
 * engine, so wiring the real one in means implementing these three types.
 *
 * Everything the CLI shows comes from `Session.events`: the durable events the
 * engine appends and the ephemeral deltas it streams, in arrival order. The
 * CLI never asks the engine whether a turn is running; it reads that from the
 * `execution.*` events, the same way a reload of the log would.
 */
import type { EphemeralEvent, MessageId, SessionId, StoredEvent } from "@light-harness/core"

/** One item of a session's event stream. Durable and ephemeral type names are disjoint, so `type` tells them apart. */
export type EngineEvent = StoredEvent | EphemeralEvent

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
}

export interface Engine {
  /**
   * Opens or creates a session. If the session holds an execution claim from a
   * process that died or shut down, the engine recovers it here and the
   * recovery's events (`step.failed` crashed, `execution.resumed`, ...) are the
   * first items of `events`.
   */
  open(request: OpenRequest): Promise<Session>
}

export interface Session {
  readonly id: SessionId
  /**
   * Every event of this session from the moment it was opened, in arrival
   * order. One consumer. Ends after `close`.
   */
  readonly events: AsyncIterable<EngineEvent>
  /**
   * Admits a user prompt (`inbox.enqueued`, then the engine starts or steers an
   * execution). Resolves with the inbox item's message ID once it is admitted.
   */
  send(text: string): Promise<MessageId | null>
  /** Asks the running execution to stop with reason `user`. A no-op when nothing runs. */
  interrupt(): void
  /** Stops anything still running (as a shutdown) and ends `events`. */
  close(): Promise<void>
}

/** The terminal state of a turn, read from its `execution.*` event. */
export type TurnOutcome = "succeeded" | "failed" | "interrupted"

/** The process exit code for a turn's outcome. */
export function exitCodeOf(outcome: TurnOutcome): number {
  switch (outcome) {
    case "succeeded":
      return 0
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
      return "succeeded"
    case "execution.failed":
      return "failed"
    case "execution.interrupted":
      return "interrupted"
    default:
      return null
  }
}

/** Raised by `open` when no engine is available in this build. */
export class EngineUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineUnavailable"
  }
}
