/**
 * The projection: what a session looks like after folding its event log. The
 * store keeps it in rows and updates it in the same transaction as each
 * append; a test rebuilds it from the log and asserts equality.
 *
 * Every type here is declared as a validator, because projection rows are
 * also read back from SQLite JSON.
 */
import { blobRef, content } from "../content.ts"
import {
  delivery,
  finishReason,
  instructionFingerprint,
  lineage,
  sessionSettings,
  stepError,
  toolOutcome,
} from "../event/durable.ts"
import { callId, executionId, messageId, sessionId } from "../id.ts"
import { interruptReason } from "../interrupt.ts"
import { providerError } from "../provider/error.ts"
import { usage } from "../provider/usage.ts"
import { type ToolEffect, toolEffect, toolSpec, truncation } from "../tool/tool.ts"
import {
  type Infer,
  array,
  boolean,
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
 * Why a message is left out of model history although it is still in the log.
 * - `reverted`: the user rewound past it.
 * - `refused`: it belongs to a step the provider refused.
 */
export const exclusion = oneOf(["reverted", "refused"])
export type Exclusion = Infer<typeof exclusion>

const base = {
  id: messageId,
  /** `seq` of the event that created the message. Messages are ordered by it. */
  seq: integer(1),
  /** Time of the event that created the message. */
  time: integer(0),
  excluded: nullable(exclusion),
}

/**
 * The tool-call state machine. A call is created `pending` by `tool.called`,
 * may become `running` by `tool.started`, and ends `settled` exactly once.
 *
 *   pending --tool.started--> running
 *   pending --tool.settled--> settled   (outcome: not_started | error)
 *   running --tool.settled--> settled   (outcome: success | error | effect_unknown)
 *
 * A running call carries the effect class it started with. A `read` call has
 * no side effect, so it cannot settle as `effect_unknown`.
 *
 * A step cannot end while any of its calls is not settled.
 */
export const toolCallState = variant("status", {
  pending: object({ status: literal("pending") }),
  running: object({ status: literal("running"), effect: toolEffect }),
  settled: object({
    status: literal("settled"),
    outcome: toolOutcome,
    /** The text for the model, exactly as it is sent. */
    output: string,
    truncation: nullable(truncation),
    attachments: array(blobRef),
    display: nullable(json),
  }),
})
export type ToolCallState = Infer<typeof toolCallState>

/** The outcomes `tool.settled` may record from each unsettled state. */
export const SETTLE_FROM = {
  pending: ["not_started", "error"],
  running: ["success", "error", "effect_unknown"],
} as const satisfies Record<"pending" | "running", readonly Infer<typeof toolOutcome>[]>

/** The outcomes `tool.settled` may record for a call in `state`. Empty once it is settled. */
export function settleOutcomes(state: ToolCallState): readonly Infer<typeof toolOutcome>[] {
  if (state.status === "settled") return []
  if (state.status === "pending") return SETTLE_FROM.pending
  return SETTLE_FROM.running.filter((outcome) => outcome !== "effect_unknown" || hasSideEffect(state.effect))
}

/** Whether a started call of this effect class may have changed something. */
export function hasSideEffect(effect: ToolEffect): boolean {
  return effect !== "read"
}

/** One piece of an assistant message, in the order the model produced it. */
export const assistantPart = variant("type", {
  text: object({ type: literal("text"), text: string, providerData: nullable(json) }),
  reasoning: object({ type: literal("reasoning"), text: string, providerData: nullable(json) }),
  tool_call: object({
    type: literal("tool_call"),
    callId,
    name: nonEmptyString,
    /** The argument text exactly as the model produced it. */
    input: string,
    providerData: nullable(json),
    state: toolCallState,
  }),
})
export type AssistantPart = Infer<typeof assistantPart>
export type ToolCallPart = Extract<AssistantPart, { type: "tool_call" }>

export const message = variant("kind", {
  /** Something the user said, delivered from the inbox. */
  user: object({ kind: literal("user"), ...base, content, delivery }),
  /**
   * Something the harness said to the model. `delivery` is `null` when it was
   * appended directly rather than delivered from the inbox.
   */
  synthetic: object({ kind: literal("synthetic"), ...base, origin: nonEmptyString, content, delivery: nullable(delivery) }),
  /**
   * An instruction appended after the baseline, with its text frozen.
   * `fingerprint` identifies the value it gives the model for `source`, or is
   * `null` when it says the source is gone.
   */
  instruction: object({
    kind: literal("instruction"),
    ...base,
    source: nonEmptyString,
    text: string,
    fingerprint: nullable(nonEmptyString),
  }),
  /** The output of one step attempt. */
  assistant: object({
    kind: literal("assistant"),
    ...base,
    model: nonEmptyString,
    /** The latest attempt of the step's retry budget that ran under this message. */
    attempt: integer(1),
    /**
     * `running` until the step's single terminal event. `refused` messages are
     * always excluded from model history.
     */
    status: oneOf(["running", "completed", "failed", "refused"]),
    parts: array(assistantPart),
    finish: nullable(finishReason),
    usage: nullable(usage),
    /** Set when `status` is `failed`. */
    error: nullable(stepError),
    /** The refusal text, set when `status` is `refused`. */
    refusal: nullable(string),
    /**
     * The most recent retry scheduled for this message, kept for display. While
     * the message is `running`, `attempt` already equals this retry's attempt.
     */
    lastRetry: nullable(object({ attempt: integer(2), delayMs: integer(0), error: providerError, time: integer(0) })),
    /** Time of the terminal event. */
    endedAt: nullable(integer(0)),
  }),
  /** A compaction and, once completed, its checkpoint text. */
  compaction: object({
    kind: literal("compaction"),
    ...base,
    trigger: oneOf(["auto", "manual", "overflow"]),
    status: oneOf(["running", "completed", "failed"]),
    /** The checkpoint text for the model, set when `status` is `completed`. */
    summary: nullable(string),
    /** First `seq` kept verbatim after the checkpoint, set when `status` is `completed`. */
    keepFromSeq: nullable(integer(1)),
    usage: nullable(usage),
    error: nullable(stepError),
    endedAt: nullable(integer(0)),
  }),
})
export type Message = Infer<typeof message>
export type MessageKind = Message["kind"]
export type UserMessage = Extract<Message, { kind: "user" }>
export type SyntheticMessage = Extract<Message, { kind: "synthetic" }>
export type InstructionMessage = Extract<Message, { kind: "instruction" }>
export type AssistantMessage = Extract<Message, { kind: "assistant" }>
export type CompactionMessage = Extract<Message, { kind: "compaction" }>

/** An admitted input that has not been delivered yet. The inbox holds only these. */
export const inboxItem = object({
  /** The ID the message will have once delivered. */
  messageId,
  /** `seq` of the enqueue event. Items of equal delivery mode are delivered in this order. */
  seq: integer(1),
  time: integer(0),
  /** `null` for user input; otherwise the harness component that produced it. */
  origin: nullable(nonEmptyString),
  delivery,
  content,
})
export type InboxItem = Infer<typeof inboxItem>

/**
 * The frozen request prefix in force, and the `seq` of the event that set it.
 * `sources` is what the model was given per instruction source in
 * `instructions`; later `instruction` messages supersede it source by source.
 */
export const baseline = object({
  seq: integer(1),
  instructions: string,
  tools: array(toolSpec),
  sources: array(instructionFingerprint),
})
export type Baseline = Infer<typeof baseline>

export const sessionState = object({
  id: sessionId,
  cwd: nonEmptyString,
  title: nullable(string),
  lineage: nullable(lineage),
  /**
   * The first session of the fork chain this session belongs to: its own ID
   * for a root session, the parent's `rootId` for a fork. Requests use it as
   * the prompt-cache key, so a fork's first request is its parent's request
   * at the fork point and reads the same cached prefix.
   */
  rootId: sessionId,
  archived: boolean,
  createdAt: integer(0),
  /**
   * The model and reasoning effort in force: the request builder takes the
   * `params` of the next request from here, never from its caller.
   */
  settings: sessionSettings,
  /**
   * The crash-recovery claim. `null` when idle. `running` while a process
   * works on the session (after a crash it stays `running` until recovery).
   * `suspended` after a shutdown interruption: the claim is kept for the next start.
   */
  execution: nullable(
    object({
      id: executionId,
      status: oneOf(["running", "suspended"]),
      /**
       * How many times recovery took this execution up again after a crash.
       * A resume after a clean shutdown is not counted, so a long turn that
       * spans several restarts never reaches the crash-resume cap by itself.
       */
      crashResumes: integer(0),
      startedSeq: integer(1),
      /**
       * The `attempt` the next `step.started` must carry. 1, except after a
       * failed message was given a retry: then it is that retry's attempt, so
       * the new message continues the logical step's one attempt budget.
       */
      nextAttempt: integer(1),
      /**
       * Set by `execution.interrupt_requested` and cleared by the
       * `execution.interrupted` that completes it. While it is set the
       * execution only winds down, and it can end only as interrupted for
       * this reason, also when recovery finds it after a crash.
       */
      interrupting: nullable(interruptReason),
    }),
  ),
  /** The step or compaction that has started and not yet reached its terminal event. */
  open: nullable(object({ kind: oneOf(["step", "compaction"]), messageId })),
  /** The latest completed compaction. Model history starts from it. */
  compaction: nullable(object({ messageId, seq: integer(1), keepFromSeq: integer(1) })),
})
export type SessionState = Infer<typeof sessionState>

/**
 * The whole projected state of one session.
 *
 * `reduce` shares structure: any part an event did not touch is the same
 * object as before. `session` changes only on session, execution, step-open
 * and compaction events, so the store can skip rewriting it on most appends.
 */
export interface Projection {
  /** `seq` of the last folded event. */
  readonly lastSeq: number
  /** Time of the last folded event. */
  readonly updatedAt: number
  readonly session: SessionState
  readonly baseline: Baseline | null
  /** Every message, including excluded and pre-compaction ones, ordered by `seq`. */
  readonly messages: readonly Message[]
  /** Undelivered inbox items, ordered by `seq`. */
  readonly inbox: readonly InboxItem[]
}
