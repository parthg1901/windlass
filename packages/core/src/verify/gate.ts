/**
 * Whether a turn may end. Pure: the step loop calls it each time the model
 * stops without tool calls, and does what it says.
 *
 * Definitions the loop keeps:
 * - `selected`: `selectChecks(config.checks, files changed since the last
 *   verification in which every selected check passed)`, by name.
 * - `latest`: the results of the most recent run of checks in this turn, in run
 *   order; empty when none has run.
 * - `changedSinceLatest`: whether the model changed a file after `latest` was produced.
 * - `reportsSent`: how many times this turn the model was sent a failing report
 *   (`report_and_continue`). This, not the number of runs, is what `maxRounds` bounds:
 *   every run follows a change, and every change after the first run follows a report,
 *   so a turn runs checks at most `maxRounds + 1` times.
 * - `acknowledgement`: see `acknowledge.ts`.
 *
 * Results that were interrupted say nothing about the code, so `latest` with an
 * interrupted result is treated as if the checks had not run.
 */
import type { VerifyMode } from "../config/schema.ts"
import type { Acknowledgement } from "./acknowledge.ts"
import { type CheckStatus, isFailure } from "./run.ts"

export interface GateInput {
  readonly mode: VerifyMode
  readonly maxRounds: number
  readonly selected: readonly string[]
  readonly latest: readonly { readonly name: string; readonly status: CheckStatus }[]
  readonly changedSinceLatest: boolean
  readonly reportsSent: number
  readonly acknowledgement: Acknowledgement | null
}

export type GateDecision =
  /** End the turn. Either nothing needed checking or every check passed. */
  | { readonly kind: "finish" }
  /** Run these checks now, then call `decideGate` again with their results. */
  | { readonly kind: "run_checks"; readonly checks: readonly string[] }
  /** Send `renderReport(latest)` to the model as a message and continue the turn. */
  | { readonly kind: "report_and_continue"; readonly failing: readonly string[] }
  /** End the turn with these checks recorded as failing. */
  | { readonly kind: "finish_unresolved"; readonly reason: UnresolvedReason; readonly failing: readonly string[] }

/**
 * - `acknowledged`: the model reported, with the acknowledgement tool, every failing check as one it cannot fix.
 * - `max_rounds`: the model was already sent `maxRounds` failing reports this turn.
 * - `report_mode`: mode `report` records failures but never sends the model back.
 */
export type UnresolvedReason = "acknowledged" | "max_rounds" | "report_mode"

export function decideGate(input: GateInput): GateDecision {
  if (input.mode === "off") return { kind: "finish" }
  const current = input.latest.length > 0 && !input.changedSinceLatest && !input.latest.some((result) => result.status === "interrupted")
  if (!current) return input.selected.length === 0 ? { kind: "finish" } : { kind: "run_checks", checks: input.selected }
  const failing = input.latest.filter((result) => isFailure(result.status)).map((result) => result.name)
  if (failing.length === 0) return { kind: "finish" }
  if (input.mode === "report") return { kind: "finish_unresolved", reason: "report_mode", failing }
  if (acknowledges(input.acknowledgement, failing)) return { kind: "finish_unresolved", reason: "acknowledged", failing }
  if (input.reportsSent >= input.maxRounds) return { kind: "finish_unresolved", reason: "max_rounds", failing }
  return { kind: "report_and_continue", failing }
}

/** An acknowledgement counts only when it names every failing check; naming more is harmless. */
function acknowledges(acknowledgement: Acknowledgement | null, failing: readonly string[]) {
  return acknowledgement !== null && failing.every((name) => acknowledgement.checks.includes(name))
}
