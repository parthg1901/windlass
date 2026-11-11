/**
 * The durable event schema: every fact a session can record, versioned.
 *
 * SINGLE-OWNER FILE. Other tracks ask the spine owner for a new event type
 * rather than adding one, because every event must be handled by the reducer
 * in `message/reducer.ts` and by the request builder.
 *
 * Rules every event follows:
 * - It records one irreducible fact. State that can be derived by folding the
 *   log (which message is running, what the latest compaction is) lives in the
 *   projection, not in events.
 * - Only boundaries are durable. Streaming deltas are ephemeral (`ephemeral.ts`);
 *   the durable event carries the complete value.
 * - Text that the model will see is frozen in the event at write time and is
 *   never rendered again (storage rule 4).
 * - Nothing is deleted. Revert, compaction and fork are ranges of `seq`.
 *
 * Changing an event's data shape means bumping its `v`, keeping a decoder for
 * the old version, and converting old to new in `decodeEvent`. Adding a value
 * to an enum or adding a new event type needs no version bump.
 */
import { blobRef, content } from "../content.ts"
import { callId, executionId, messageId, sessionId, type SessionId } from "../id.ts"
import { interruptReason } from "../interrupt.ts"
import { providerError } from "../provider/error.ts"
import { usage } from "../provider/usage.ts"
import { toolEffect, toolSpec, truncation } from "../tool/tool.ts"
import {
  type Infer,
  type Validator,
  array,
  integer,
  json,
  literal,
  nonEmptyString,
  nullable,
  object,
  oneOf,
  string,
  variant,
} from "../validate.ts"

/**
 * How an inbox item reaches the model.
 * - `steer`: at the next step boundary, while the session is still working.
 * - `queue`: only once the session would otherwise go idle, one item at a time.
 */
export const delivery = oneOf(["steer", "queue"])
export type Delivery = Infer<typeof delivery>

/**
 * Where a session came from. A fork owns no copy of its parent's history: its
 * log is the parent's events 1..`throughSeq` followed by its own events, which
 * start at `throughSeq + 1`.
 */
export const lineage = variant("kind", {
  fork: object({ kind: literal("fork"), parentSessionId: sessionId, throughSeq: integer(1) }),
})
export type Lineage = Infer<typeof lineage>

export const finishReason = oneOf(["stop", "tool_calls", "length"])

/**
 * The one terminal result of a tool call (cancel rule 4).
 * - `success`: it ran and succeeded.
 * - `error`: it failed, or it was refused before running (malformed arguments,
 *   unknown tool, disallowed in this mode), or it was stopped and its outcome was observed.
 * - `not_started`: it never began, because the step was interrupted first. Safe to call again.
 * - `effect_unknown`: it began a side effect and nobody observed how it ended
 *   (crash, or a kill that returned nothing). The model must inspect before repeating it.
 */
export const toolOutcome = oneOf(["success", "error", "not_started", "effect_unknown"])
export type ToolOutcome = Infer<typeof toolOutcome>

/** Why a step or a compaction did not complete. */
export const stepError = variant("kind", {
  /** The model call failed with a classified provider error. */
  provider: object({ kind: literal("provider"), error: providerError }),
  /** The execution was interrupted while this step was open. */
  interrupted: object({ kind: literal("interrupted"), reason: interruptReason }),
  /** The process died while this step was open; recorded by recovery at the next start. */
  crashed: object({ kind: literal("crashed") }),
  /** The harness itself failed (a bug, a storage error). */
  internal: object({ kind: literal("internal"), message: string }),
})
export type StepError = Infer<typeof stepError>

function define<const V extends number, D>(v: V, data: Validator<D>) {
  return { v, data }
}

const empty = object({})

/** Every durable event type: its current version and the validator for its data. */
export const durableEvents = {
  // ---- session lifecycle ----

  /**
   * A session exists. Always the first event of a session's own log. For a
   * fork, `lineage` names the parent and the last inherited `seq`, and this
   * event's `seq` is `throughSeq + 1`.
   */
  "session.created": define(1, object({ cwd: nonEmptyString, title: nullable(string), lineage: nullable(lineage) })),
  /** The session's title was set. */
  "session.renamed": define(1, object({ title: string })),
  /** The session was hidden from the default list. Nothing is deleted. */
  "session.archived": define(1, empty),
  /** The session was restored to the default list. */
  "session.unarchived": define(1, empty),

  // ---- frozen request prefix ----

  /**
   * The system prompt and tool list every request uses from here on, with
   * their text frozen (context rule 2). Recorded before the session's first
   * step and again only after a compaction, which is the one place the prefix
   * may change.
   */
  "baseline.set": define(1, object({ instructions: string, tools: array(toolSpec) })),
  /**
   * An instruction that changed after the baseline (the date, an edited
   * AGENTS.md, a skill list) became part of history as a new message, with its
   * text frozen here (context rule 3). `source` names what it describes so a
   * later compaction can fold the newest text per source into the next baseline.
   */
  "instruction.appended": define(1, object({ messageId, source: nonEmptyString, text: string })),

  // ---- inbox ----

  /**
   * Input was admitted and is waiting to be delivered. `messageId` is the ID
   * the message will have once delivered. `origin` is `null` when the user
   * wrote it; otherwise it names the harness component that produced it
   * (a finished background command, a wake-up) and the item is synthetic.
   */
  "inbox.enqueued": define(1, object({ messageId, origin: nullable(nonEmptyString), delivery, content })),
  /** A waiting item was switched between steer and queue. */
  "inbox.delivery_changed": define(1, object({ messageId, delivery })),
  /** A waiting item was withdrawn before delivery. It never becomes a message. */
  "inbox.cancelled": define(1, object({ messageId })),
  /**
   * A waiting item became a message in history, at a step boundary
   * (cancel rule 8). The item leaves the inbox in the same transaction.
   */
  "inbox.delivered": define(1, object({ messageId })),
  /**
   * The harness itself added a message to history at a step boundary, without
   * going through the inbox: the marker that the previous response was
   * interrupted (cancel rule 6), the single empty-response nudge, a check
   * result. `origin` names the kind, e.g. `"interrupt"`.
   */
  "synthetic.appended": define(1, object({ messageId, origin: nonEmptyString, content })),

  // ---- execution ----

  /**
   * The write-ahead claim: this process started working on the session. A
   * session with a claim and no terminal event after a restart was cut off by
   * a crash and is recovered.
   */
  "execution.started": define(1, object({ executionId })),
  /**
   * Recovery took up a claimed execution again after a restart. Counting these
   * events is the durable resume-attempt accounting.
   */
  "execution.resumed": define(1, object({ executionId })),
  /** The session ran until it had nothing left to do. Releases the claim. */
  "execution.succeeded": define(1, object({ executionId })),
  /** The execution gave up (a non-retryable error, attempts exhausted). Releases the claim. */
  "execution.failed": define(1, object({ executionId, message: string })),
  /**
   * The execution was interrupted. `reason` is explicit and has no default:
   * `user` releases the claim, `shutdown` keeps it for the next start.
   */
  "execution.interrupted": define(1, object({ executionId, reason: interruptReason })),

  // ---- step: one model call ----

  /**
   * A model call began under assistant message `messageId`. `attempt` counts
   * within the step's single retry budget: a retry before any durable output
   * keeps the same message, while a retry after output starts a new message
   * with the next `attempt` (retry rule 2).
   */
  "step.started": define(1, object({ messageId, attempt: integer(1), model: nonEmptyString })),
  /** The model call completed. Every tool call of the step was settled before this. */
  "step.ended": define(1, object({ messageId, finish: finishReason, usage: nullable(usage) })),
  /**
   * The step ended without completing: provider failure, interruption, crash
   * or harness error. The single terminal event of the step; every tool call
   * was settled before it. Output recorded so far stays in history.
   */
  "step.failed": define(1, object({ messageId, error: stepError, usage: nullable(usage) })),
  /**
   * The provider refused. The step stays in the log, but every message from
   * `excludeFromSeq` up to this event is excluded from model history, so the
   * refused content cannot trip the filter again (retry rule 7). `message` is
   * the refusal text for display.
   */
  "step.refused": define(
    1,
    object({ messageId, message: string, excludeFromSeq: integer(1), usage: nullable(usage) }),
  ),
  /**
   * A retry of the model call was scheduled after `error`. `attempt` is the
   * number of the attempt that will run after `delayMs`.
   */
  "retry.scheduled": define(1, object({ messageId, attempt: integer(2), delayMs: integer(0), error: providerError })),

  // ---- model output ----

  /**
   * The model finished a piece of text; `text` is the whole piece. Also written
   * for the visible partial text of an interrupted step (cancel rule 3).
   */
  "text.ended": define(1, object({ messageId, text: string, providerData: nullable(json) })),
  /**
   * The model finished a reasoning item. `text` is the readable summary;
   * `providerData` is the provider's opaque payload, replayed verbatim. Partial
   * reasoning is never recorded.
   */
  "reasoning.ended": define(1, object({ messageId, text: string, providerData: nullable(json) })),

  // ---- tools ----

  /**
   * The model asked for a tool call. Written before anything runs; if this
   * write fails, nothing runs (cancel rule 1). `input` is the argument text
   * exactly as the model produced it. Keyed by `(messageId, callId)` because
   * providers reuse call IDs across steps.
   */
  "tool.called": define(
    1,
    object({ messageId, callId, name: nonEmptyString, input: string, providerData: nullable(json) }),
  ),
  /**
   * The tool began executing. From here a side effect may have happened, so a
   * call that is started but never settled is settled as `effect_unknown` (or
   * `error`), never as `not_started`. `effect` is the tool's effect class at
   * the moment it started: a `read` call has no side effect and can never
   * settle as `effect_unknown`, and crash recovery settles an orphan from this
   * field, never from the tool registry of the build that restarts.
   */
  "tool.started": define(1, object({ messageId, callId, effect: toolEffect })),
  /**
   * The call's one terminal result. `output` is the text for the model, capped
   * once when produced and replayed byte for byte, including the text that
   * explains a `not_started` or `effect_unknown` outcome.
   */
  "tool.settled": define(
    1,
    object({
      messageId,
      callId,
      outcome: toolOutcome,
      output: string,
      truncation: nullable(truncation),
      attachments: array(blobRef),
      display: nullable(json),
    }),
  ),

  // ---- compaction ----

  /** A compaction began under compaction message `messageId`. */
  "compaction.started": define(1, object({ messageId, trigger: oneOf(["auto", "manual", "overflow"]) })),
  /**
   * The compaction produced its checkpoint. From now on model history is
   * `summary` (rendered once, frozen here) followed by the messages from
   * `keepFromSeq` on. Earlier messages stay in the log and in the UI.
   */
  "compaction.ended": define(1, object({ messageId, summary: string, keepFromSeq: integer(1), usage: nullable(usage) })),
  /** The compaction did not complete. Model history is unchanged. */
  "compaction.failed": define(1, object({ messageId, error: stepError })),

  // ---- history ranges ----

  /**
   * The user rewound the session: every message from `fromSeq` up to this
   * event is excluded from model history. The rows stay.
   */
  "history.reverted": define(1, object({ fromSeq: integer(1) })),
} as const

export type EventType = keyof typeof durableEvents

export const EVENT_TYPES = Object.keys(durableEvents) as EventType[]

export type EventData<T extends EventType = EventType> = Infer<(typeof durableEvents)[T]["data"]>

/** An event as a caller hands it to the store: the fact, without its position in the log. */
export type NewEvent<T extends EventType = EventType> = {
  [K in T]: { readonly type: K; readonly v: (typeof durableEvents)[K]["v"]; readonly data: EventData<K> }
}[T]

/** Where an event sits in a session's log. Assigned by the store when it appends. */
export interface EventPosition {
  readonly sessionId: SessionId
  /** Dense per session, starting at 1 (or at `throughSeq + 1` for a fork). The only ordering key. */
  readonly seq: number
  /** Milliseconds since the Unix epoch, from the store's clock at append. For display, never for ordering. */
  readonly time: number
}

/** An event as it exists in the log. */
export type StoredEvent<T extends EventType = EventType> = NewEvent<T> & EventPosition

/** Builds an event at its current version. */
export function event<T extends EventType>(type: T, data: EventData<T>): NewEvent<T> {
  return { type, v: durableEvents[type].v, data } as NewEvent<T>
}
