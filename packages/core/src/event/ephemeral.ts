/**
 * Ephemeral events: progress that is shown live and never stored (storage
 * rule 3). They have no `seq`. A client that misses them loses nothing,
 * because the durable event that ends each item carries the complete value.
 *
 * Within one assistant message, text and reasoning stream one item at a time,
 * so a client keeps one text buffer and one reasoning buffer per message and
 * clears each when the matching `text.ended` or `reasoning.ended` arrives.
 * Tool-call input and tool progress are told apart by `callId`.
 */
import type { CallId, MessageId, SessionId } from "../id.ts"
import type { EventType } from "./durable.ts"

export type EphemeralEvent =
  /** More of the text the model is writing. */
  | { readonly type: "text.delta"; readonly sessionId: SessionId; readonly messageId: MessageId; readonly text: string }
  /** More of the reasoning summary the model is writing. */
  | {
      readonly type: "reasoning.delta"
      readonly sessionId: SessionId
      readonly messageId: MessageId
      readonly text: string
    }
  /** More of a tool call's argument text. The call does not exist durably until `tool.called`. */
  | {
      readonly type: "tool.input.delta"
      readonly sessionId: SessionId
      readonly messageId: MessageId
      readonly callId: CallId
      readonly name: string
      readonly input: string
    }
  /** Progress from a running tool. `text` replaces the previous progress text of the call. */
  | {
      readonly type: "tool.progress"
      readonly sessionId: SessionId
      readonly messageId: MessageId
      readonly callId: CallId
      readonly text: string
    }

export type EphemeralEventType = EphemeralEvent["type"]

/** Compile-time check that no ephemeral type name is also a durable one. */
type Disjoint = Extract<EphemeralEventType, EventType> extends never ? true : never
export const EPHEMERAL_NAMES_ARE_DISJOINT: Disjoint = true
