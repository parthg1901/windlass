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
 * 1. What the next model call answers is the mandatory part: at a
 *    user-message boundary, the input that arrived since the model last
 *    spoke; in the middle of a turn, the last step (its calls and their
 *    results) and whatever the harness said after it. A `normal` compaction
 *    keeps it even over budget (`overBudget` says so; the policy's aggressive
 *    mode is what reacts to it). An `aggressive` one keeps it only when it
 *    fits: the checkpoint and the history tools then stand in for it, which
 *    is what lets a request that was rejected as too large fit again.
 * 2. A leading checkpoint (the previous compaction) is never kept: it is what
 *    the new summary replaces.
 * 3. Among the allowed cuts whose suffix fits the budget, the one that keeps
 *    the most is the candidate; a cut right before a user message is preferred
 *    when it keeps at least `preferUserShare` of what the candidate keeps.
 *
 * A cut may therefore fall inside the turn in progress, between two of its
 * steps: a single turn that outgrows the window keeps its most recent steps
 * and the checkpoint carries the turn's request (quoted verbatim) and where
 * the work stands. `midTurn` says when that happened.
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
  /**
   * Whether the mandatory part (rule 1) is kept even when it is over budget.
   * `always` is the default (a normal compaction); `if_fits` is what an
   * aggressive compaction uses.
   */
  readonly mandatory?: "always" | "if_fits"
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
  /**
   * The latest user message is before the cut (or there is none in view), so
   * the kept tail does not say what was asked for: the cut fell inside the
   * turn in progress, or an aggressive compaction dropped the request itself.
   * The checkpoint then has to say that the work continues.
   */
  readonly midTurn: boolean
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
  // The last time the model said something: a step that failed before any output, or was refused, renders nothing.
  const lastStep = messages.findLastIndex(
    (message) => message.kind === "assistant" && message.status !== "running" && message.status !== "refused" && message.parts.length > 0,
  )
  const first = messages[0]?.kind === "compaction" ? 1 : 0
  // Rule 1: at a user-message boundary everything since the model last spoke, otherwise the last step and what follows it.
  const unanswered = latestUser > lastStep ? lastStep + 1 : lastStep === -1 ? messages.length : lastStep
  const allowed = Array.from({ length: messages.length + 1 }, (_, index) => index).filter((index) => index >= first && allowedCut(messages, index))
  // The mandatory part starts at the latest allowed cut that does not split it.
  const mandatory = allowed.findLast((index) => index <= Math.max(first, unanswered)) ?? first
  const candidates = allowed.filter((index) => index <= mandatory || options.mandatory === "if_fits")
  const fitting = candidates.filter((index) => kept(index) <= options.budget)
  const best = fitting[0]
  const bestUser = fitting.find((index) => messages[index]?.kind === "user")
  const keepFrom =
    best === undefined
      ? // Nothing fits: keep only what must be kept.
        mandatory
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
    midTurn: keepFrom > latestUser,
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
