/**
 * What a compaction keeps word for word: a suffix of the model's view of the
 * session (`selectModelHistory(...).messages`), chosen by token budget.
 *
 * Cuts fall only between messages. In this data model one assistant message
 * is one step attempt and holds its tool calls together with their settled
 * results, so a cut between messages can never separate a call from its
 * result. On top of that, a cut is not allowed where it would split one
 * logical step across messages:
 * - before a `continuation` note or before the assistant message that follows
 *   one (a step that failed after output continues under a new message);
 * - before an assistant message that follows a failed assistant message;
 * - before an interrupt marker, which refers to the response right before it.
 *
 * Rules, in order:
 * 1. The latest user message and everything after it are always kept, even
 *    over budget (`overBudget` says so; the policy's aggressive mode is what
 *    reacts to it).
 * 2. A leading checkpoint (the previous compaction) is never kept: it is what
 *    the new summary replaces.
 * 3. Among the allowed cuts whose suffix fits the budget, the one that keeps
 *    the most is the candidate; a cut right before a user message is preferred
 *    when it keeps at least `preferUserShare` of what the candidate keeps.
 */
import { HARNESS_ORIGIN } from "../event/durable.ts"
import type { Message } from "../message/message.ts"
import { estimateMessage } from "./estimate.ts"

export interface TailOptions {
  /** Tokens of history to keep verbatim. */
  readonly budget: number
  /** Cost of one message; defaults to `estimateMessage`. */
  readonly cost?: (message: Message) => number
  /** Default 0.5. */
  readonly preferUserShare?: number
}

export interface TailChoice {
  /**
   * Index into the message list of the first kept message. Messages before it
   * are summarised. Equal to the list's length when nothing is kept.
   */
  readonly keepFrom: number
  /** `seq` of the first kept message, for `compaction.ended.keepFromSeq`; `null` when nothing is kept. */
  readonly keepFromSeq: number | null
  /** What the cut sits before: a user message, another step boundary, or the end (nothing kept). */
  readonly boundary: "user" | "step" | "end"
  readonly keptTokens: number
  /** Tokens of the messages before the cut, the previous checkpoint included. */
  readonly removedTokens: number
  /** The mandatory part alone is larger than the budget. */
  readonly overBudget: boolean
  /** Nothing but a previous checkpoint (or nothing at all) is before the cut, so compacting cannot free anything. */
  readonly nothingToRemove: boolean
}

export function chooseTail(messages: readonly Message[], options: TailOptions): TailChoice {
  const cost = options.cost ?? estimateMessage
  const preferUserShare = options.preferUserShare ?? 0.5
  const costs = messages.map(cost)
  // suffix[i]: tokens of messages[i..].
  const suffix = costs.reduceRight<number[]>((sums, value, index) => {
    sums[index] = value + (sums[index + 1] ?? 0)
    return sums
  }, [])
  const total = suffix[0] ?? 0
  const kept = (index: number) => suffix[index] ?? 0

  const latestUser = messages.findLastIndex((message) => message.kind === "user")
  const mandatory = latestUser === -1 ? messages.length : latestUser
  const first = messages[0]?.kind === "compaction" ? 1 : 0
  const candidates = Array.from({ length: mandatory + 1 }, (_, index) => index).filter(
    (index) => index >= first && allowedCut(messages, index),
  )
  const fitting = candidates.filter((index) => kept(index) <= options.budget)
  const best = fitting[0]
  const bestUser = fitting.find((index) => messages[index]?.kind === "user")
  const keepFrom =
    best === undefined
      ? // Nothing fits: keep only what must be kept (the last candidate, which is `mandatory` when that is a user message).
        (candidates[candidates.length - 1] ?? mandatory)
      : bestUser !== undefined && kept(bestUser) >= preferUserShare * kept(best)
        ? bestUser
        : best
  const removed = messages.slice(0, keepFrom)
  return {
    keepFrom,
    keepFromSeq: messages[keepFrom]?.seq ?? null,
    boundary: keepFrom >= messages.length ? "end" : messages[keepFrom]!.kind === "user" ? "user" : "step",
    keptTokens: kept(keepFrom),
    removedTokens: total - kept(keepFrom),
    overBudget: best === undefined,
    nothingToRemove: !removed.some((message) => message.kind !== "compaction"),
  }
}

/** Whether history may be cut right before `messages[index]` without splitting a step. */
export function allowedCut(messages: readonly Message[], index: number): boolean {
  const next = messages[index]
  if (next === undefined) return true
  const previous = messages[index - 1]
  if (next.kind === "synthetic" && (next.origin === HARNESS_ORIGIN.continuation || next.origin === HARNESS_ORIGIN.interrupt)) return false
  if (next.kind === "assistant") {
    if (previous?.kind === "synthetic" && previous.origin === HARNESS_ORIGIN.continuation) return false
    if (previous?.kind === "assistant" && previous.status === "failed") return false
  }
  return true
}
