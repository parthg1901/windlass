/**
 * Pure views over a projection: what the model sees, and what an append changed.
 */
import type { SessionSettings } from "../event/durable.ts"
import type { MessageId, SessionId } from "../id.ts"
import type { Baseline, InboxItem, Message, Projection, SessionState } from "./message.ts"

/** What the request builder needs to build the next request. */
export interface ModelHistory {
  /** The root of the session's fork chain (`session.rootId`): the prompt-cache key of its requests. */
  readonly rootId: SessionId
  /** The model and reasoning effort in force, from `session.created` and `settings.changed`. */
  readonly settings: SessionSettings
  /** The frozen instructions and tool list, or `null` before the first `baseline.set`. */
  readonly baseline: Baseline | null
  /** Model-visible messages in request order. */
  readonly messages: readonly Message[]
}

/**
 * The model's view of a session. This is the definition of "history from the
 * latest compaction"; a store that answers the same question in SQL must
 * return exactly this.
 *
 * - Without a compaction: every message that is not excluded, in `seq` order.
 * - With one: the latest completed compaction message first (its `summary` is
 *   the checkpoint), then every non-excluded message with `seq >= keepFromSeq`.
 *   The kept messages have a lower `seq` than the compaction and still come after it.
 * - Compaction messages other than the latest completed one are never included.
 *
 * Because every tool call is settled durably before its step ends, the result
 * needs no repair: each message is rendered as it is stored (cancel rule 5).
 */
export function selectModelHistory(projection: Projection): ModelHistory {
  const compaction = projection.session.compaction
  const visible = projection.messages.filter(
    (message) =>
      message.excluded === null &&
      message.kind !== "compaction" &&
      (compaction === null || message.seq >= compaction.keepFromSeq),
  )
  const session = { rootId: projection.session.rootId, settings: projection.session.settings, baseline: projection.baseline }
  if (compaction === null) return { ...session, messages: visible }
  const checkpoint = projection.messages.find((message) => message.id === compaction.messageId)
  if (checkpoint === undefined) throw new Error(`compaction message ${compaction.messageId} is missing`)
  return { ...session, messages: [checkpoint, ...visible] }
}

/** The rows an append has to write. */
export interface ProjectionChanges {
  /** The new session state, or `null` when it did not change. */
  readonly session: SessionState | null
  /** `undefined` when the baseline did not change; otherwise its new value. */
  readonly baseline: Baseline | null | undefined
  /** Messages that were added or changed, to upsert by ID. */
  readonly messages: readonly Message[]
  /** Inbox items that were added or changed, to upsert by message ID. */
  readonly inbox: readonly InboxItem[]
  /** Inbox items that were delivered or cancelled, to remove. */
  readonly inboxRemoved: readonly MessageId[]
}

/**
 * Compares two projections by object identity, relying on the structure
 * sharing `reduce` guarantees. With `previous` as `null` it returns everything,
 * which is what a store needs when it first materialises a session or a fork.
 */
export function projectionChanges(previous: Projection | null, next: Projection): ProjectionChanges {
  if (previous === null)
    return { session: next.session, baseline: next.baseline, messages: next.messages, inbox: next.inbox, inboxRemoved: [] }
  const waiting = new Set(next.inbox.map((item) => item.messageId))
  return {
    session: previous.session === next.session ? null : next.session,
    baseline: previous.baseline === next.baseline ? undefined : next.baseline,
    messages: next.messages.filter((message, index) => previous.messages[index] !== message),
    inbox: next.inbox.filter((item) => !previous.inbox.includes(item)),
    inboxRemoved: previous.inbox.filter((item) => !waiting.has(item.messageId)).map((item) => item.messageId),
  }
}
