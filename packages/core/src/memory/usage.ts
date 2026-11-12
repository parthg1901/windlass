/**
 * Usage records: what each session was given, what it looked up, and how its
 * turns ended. They are what scoring (`score.ts`) attributes outcomes from.
 *
 * Kept apart from the entries, one append-only JSON-lines file per session
 * (`usage/<session>.jsonl`): entry files stay small and calm for a person to
 * edit, a session has one writer (the process that holds it), so two
 * processes never append to one file, and deleting an entry by hand never
 * loses the record of what was delivered. Declared with the project's strict
 * validators, like every stored type.
 */
import { type Infer, array, integer, literal, nonEmptyString, nullable, object, oneOf, string, variant } from "../validate.ts"

/**
 * How a turn ended, as the caller observed it.
 * - `passed`: the turn ended with the project's checks passing (`execution.succeeded`, verification `passed`).
 * - `unchecked`: it ended with nothing to check (`not_needed`, `not_configured`).
 * - `unresolved`: it ended with checks failing (`unresolved`).
 * - `interrupted`: the user stopped it.
 * - `reverted`: the user reverted it.
 * - `corrected_again`: the user corrected the model again on a subject a note covers; `entries` names the notes.
 */
export const OUTCOMES = ["passed", "unchecked", "unresolved", "interrupted", "reverted", "corrected_again"] as const
export const outcome = oneOf(OUTCOMES)
export type Outcome = Infer<typeof outcome>

export const heldNote = object({ id: nonEmptyString, hash: nonEmptyString })
export type HeldNote = Infer<typeof heldNote>

const deliveredRecord = object({
  type: literal("delivered"),
  session: nonEmptyString,
  at: nonEmptyString,
  /** `start`: the whole block; `update`: a change appended during the session. */
  mode: oneOf(["start", "update"]),
  /** The fingerprint the instruction message carries: identifies `held`. */
  fingerprint: nonEmptyString,
  /** Every note the model holds once this message is in its history. */
  held: array(heldNote),
  added: array(nonEmptyString),
  withdrawn: array(nonEmptyString),
  replaced: array(nonEmptyString),
  /** Active notes left out of a `start` block by the budget. */
  dropped: array(nonEmptyString),
})

const readRecord = object({
  type: literal("read"),
  session: nonEmptyString,
  at: nonEmptyString,
  query: string,
  /** Notes the model was shown by `memory_search`, in the order shown. */
  ids: array(nonEmptyString),
})

const outcomeRecord = object({
  type: literal("outcome"),
  session: nonEmptyString,
  at: nonEmptyString,
  /** The `seq` of the event that ended the turn, when the caller has it; repeated records for one turn are counted once. */
  turn: nullable(integer(1)),
  outcome,
  /** For `corrected_again`: the notes whose subject the correction was about. Otherwise `null`. */
  entries: nullable(array(nonEmptyString)),
  note: nullable(string),
})

export const usageRecord = variant("type", { delivered: deliveredRecord, read: readRecord, outcome: outcomeRecord })
export type UsageRecord = Infer<typeof usageRecord>
export type DeliveredRecord = Infer<typeof deliveredRecord>
export type ReadRecord = Infer<typeof readRecord>
export type OutcomeRecord = Infer<typeof outcomeRecord>

/** The outcome of a turn the step loop ended, from what `execution.succeeded` / `turn.ended` say the gate found. */
export function outcomeOfVerification(verification: "passed" | "not_needed" | "not_configured" | "unresolved"): Outcome {
  if (verification === "passed") return "passed"
  if (verification === "unresolved") return "unresolved"
  return "unchecked"
}
