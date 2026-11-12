/**
 * When to compact, and how hard. Pure: the engine passes in what it knows and
 * acts on the decision.
 *
 * Sizes are in input tokens. The usable window is the model's context window
 * minus the output budget the next call reserves. The policy compares the
 * size estimate plus its safety margin (`estimate.ts`) against fractions of
 * the usable window:
 *
 *   below `soonRatio`                      nothing to do
 *   `soonRatio` to `triggerRatio`          compact at the next user-message boundary
 *                                          (`now` there, `soon` anywhere else)
 *   above `triggerRatio`                   compact now
 *   above the usable window                compact now, aggressively when a normal one
 *                                          already failed to free enough
 *
 * A normal compaction aims to bring the next request to `targetRatio` of the
 * usable window; an aggressive one to `aggressiveTargetRatio`, which mostly
 * means keeping a much shorter verbatim tail.
 *
 * ## Thrashing
 *
 * A compaction is ineffective when it freed less than `minFreedRatio` of the
 * size it started from (typically because the part that must be kept, the
 * latest user message and what follows, is itself most of the context).
 * Compacting again at once would summarise a summary and free nothing. After
 * an ineffective compaction:
 * - no proactive compaction happens until the context has grown by at least
 *   `minFreedRatio` of the usable window since then (`hold`): the work goes on
 *   in the headroom between `triggerRatio` and the window;
 * - if the next request would not fit at all, the next compaction is
 *   aggressive, once;
 * - if an aggressive compaction was itself ineffective, nothing more is tried
 *   (`give_up`): the request is sent as it is, and if the provider rejects it
 *   the overflow path ends the execution with the overflow failure text.
 *
 * ## Overflow
 *
 * The provider rejecting a request as too large is a fact, not an estimate,
 * and it overrides everything above: `decideAfterOverflow` always compacts
 * aggressively, against a target computed from the smaller of the usable
 * window and the estimate (the rejection proves at least one of them is wrong),
 * unless the rejected request was itself built right after an overflow or
 * aggressive compaction with no completed step since, in which case another
 * compaction cannot help and the execution fails (the rule the engine applies
 * today as `compactedInVain`).
 */
import type { CompactionMode } from "../event/durable.ts"
import type { SizeEstimate } from "./estimate.ts"

export type { CompactionMode }

export interface CompactionConfig {
  /** From this share of the usable window, compaction is due at the next user-message boundary. */
  readonly soonRatio: number
  /** From this share, compaction happens before the next request. */
  readonly triggerRatio: number
  /** A normal compaction aims for this share of the usable window. */
  readonly targetRatio: number
  /** An aggressive compaction (after an overflow or an ineffective compaction) aims for this share. */
  readonly aggressiveTargetRatio: number
  /** A compaction that freed less than this share of the size it started from was ineffective. */
  readonly minFreedRatio: number
  /** Upper bound of the summary the model writes; the validator enforces it. */
  readonly summaryMaxTokens: number
  /** Upper bound of the mechanical part of the checkpoint (identifier index, the list of images and quoted user messages). */
  readonly checkpointExtraMaxTokens: number
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  soonRatio: 0.65,
  triggerRatio: 0.8,
  targetRatio: 0.4,
  aggressiveTargetRatio: 0.2,
  minFreedRatio: 0.25,
  summaryMaxTokens: 2_500,
  checkpointExtraMaxTokens: 3_700,
}

/** What the latest compaction of the session achieved. The engine derives it from the log. */
export interface CompactionOutcome {
  readonly mode: CompactionMode
  /** The size estimate (total) that triggered it, or the rejected request's estimate after an overflow. */
  readonly before: number
  /** The size of the first request after it: measured when that call has run, otherwise estimated. */
  readonly after: number
}

export interface PolicyInput {
  /** The model's context window in tokens. */
  readonly contextWindow: number
  /** Output tokens the next call reserves (its output limit, or the provider's default budget). */
  readonly reservedOutput: number
  /** The estimate of the next request (`estimateNextInput`). */
  readonly estimate: SizeEstimate
  /** Tokens no compaction can remove: the instructions and the tool list. */
  readonly fixedTokens: number
  /** The latest compaction of the session, or `null` when there is none. */
  readonly lastCompaction: CompactionOutcome | null
  /** Whether the next model call is the first after new user input enters history. */
  readonly atUserBoundary: boolean
  readonly config?: CompactionConfig
}

export type CompactionDecision =
  /** Send the request. `share` is the estimate with its margin as a share of the usable window. */
  | { readonly kind: "none"; readonly share: number }
  /** Over `soonRatio`: compact at the next user-message boundary, not mid-turn. */
  | { readonly kind: "soon"; readonly share: number }
  /** Compact before sending. `tailBudget` goes to `chooseTail`. */
  | {
      readonly kind: "now"
      readonly mode: CompactionMode
      /** The value for `compaction.started.trigger`. */
      readonly trigger: "auto" | "overflow"
      readonly share: number
      /** The size the next request should have after the compaction. */
      readonly targetTokens: number
      /** Tokens of history to keep verbatim after the checkpoint. */
      readonly tailBudget: number
      readonly reason: string
    }
  /** Over the trigger, but the latest compaction was ineffective and the context has not grown enough since. */
  | { readonly kind: "hold"; readonly share: number; readonly reason: string }
  /** No compaction can help any more. Proactively: send as it is. After an overflow: fail the execution. */
  | { readonly kind: "give_up"; readonly share: number; readonly reason: string }

/** The proactive decision, made before each model call. */
export function decideCompaction(input: PolicyInput): CompactionDecision {
  const config = input.config ?? DEFAULT_COMPACTION_CONFIG
  const usable = usableWindow(input)
  const size = input.estimate.total + input.estimate.margin
  const share = size / usable
  if (share < config.soonRatio) return { kind: "none", share }
  if (share < config.triggerRatio && !input.atUserBoundary) return { kind: "soon", share }

  const last = input.lastCompaction
  const fits = size <= usable
  if (last !== null && ineffective(last, config)) {
    if (last.mode === "aggressive" && !fits)
      return { kind: "give_up", share, reason: "an aggressive compaction already freed too little; the request is sent as it is" }
    const grown = input.estimate.total - last.after >= config.minFreedRatio * usable
    if (fits && !grown)
      return { kind: "hold", share, reason: "the latest compaction freed too little and the context has not grown enough since" }
    if (!fits) return now(input, config, "aggressive", "auto", share, usable, "the request would not fit and the latest compaction freed too little")
  }
  const reason = share >= config.triggerRatio ? "the request is over the compaction trigger" : "over the early threshold at a user-message boundary"
  return now(input, config, "normal", "auto", share, usable, reason)
}

export interface OverflowInput extends Omit<PolicyInput, "atUserBoundary"> {
  /**
   * Whether a step completed after the latest compaction. When it did not, and
   * that compaction was an overflow or aggressive one, the rejected request was
   * built straight from it.
   */
  readonly completedStepSinceCompaction: boolean
  /** Whether the latest compaction was written with trigger `overflow`. */
  readonly lastCompactionWasOverflow: boolean
}

/** The decision after the provider rejected the request as too large. */
export function decideAfterOverflow(input: OverflowInput): CompactionDecision {
  const config = input.config ?? DEFAULT_COMPACTION_CONFIG
  const usable = usableWindow(input)
  const share = (input.estimate.total + input.estimate.margin) / usable
  const last = input.lastCompaction
  if (last !== null && (last.mode === "aggressive" || input.lastCompactionWasOverflow) && !input.completedStepSinceCompaction)
    return { kind: "give_up", share, reason: "the request built right after an aggressive compaction was rejected too" }
  // The rejection proves the window or the estimate wrong; aim below both.
  const basis = Math.min(usable, input.estimate.total)
  return now({ ...input, atUserBoundary: false }, config, "aggressive", "overflow", share, basis, "the provider rejected the request as too large")
}

/** The tokens of verbatim history a compaction of `mode` may keep. Never negative. */
export function tailBudget(targetTokens: number, fixedTokens: number, config: CompactionConfig = DEFAULT_COMPACTION_CONFIG): number {
  return Math.max(0, targetTokens - fixedTokens - config.summaryMaxTokens - config.checkpointExtraMaxTokens)
}

/** Whether a compaction freed less than `minFreedRatio` of what it started from. */
export function ineffective(outcome: CompactionOutcome, config: CompactionConfig = DEFAULT_COMPACTION_CONFIG): boolean {
  return outcome.before - outcome.after < config.minFreedRatio * outcome.before
}

function usableWindow(input: Pick<PolicyInput, "contextWindow" | "reservedOutput">) {
  const usable = input.contextWindow - input.reservedOutput
  if (!(usable > 0)) throw new RangeError(`the context window (${input.contextWindow}) must be larger than the reserved output (${input.reservedOutput})`)
  return usable
}

function now(
  input: PolicyInput,
  config: CompactionConfig,
  mode: CompactionMode,
  trigger: "auto" | "overflow",
  share: number,
  basis: number,
  reason: string,
): CompactionDecision {
  const targetTokens = Math.floor(basis * (mode === "normal" ? config.targetRatio : config.aggressiveTargetRatio))
  return { kind: "now", mode, trigger, share, targetTokens, tailBudget: tailBudget(targetTokens, input.fixedTokens, config), reason }
}
