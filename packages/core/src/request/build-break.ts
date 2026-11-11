/**
 * Which prefix breaks are legitimate.
 *
 * `comparePrefix` says whether a request extends the previous one; the request
 * ledger stores the block hashes but does not mark why a request was allowed
 * not to. The caller that sends requests knows which events it appended since
 * the previous step request, and this file turns those events into a verdict.
 *
 * A step request may legitimately not extend the previous step request of the
 * same session only when one of these was appended in between:
 * - `compaction.ended`: history now starts at the checkpoint (and the
 *   `baseline.set` that follows may change the instructions and tools);
 * - `history.reverted`: the user rewound, so sent messages are gone;
 * - `step.refused`: the refused range is excluded so it is not sent again.
 *
 * Anything else that changes an already-sent block is a bug in the harness,
 * except a `params` block the caller changed on purpose (another model or effort).
 */
import type { EventType } from "../event/durable.ts"
import { type BlockHash, type PrefixComparison, comparePrefix } from "./prefix.ts"

export const PREFIX_BREAK_CAUSES = {
  "compaction.ended": "compaction",
  "history.reverted": "revert",
  "step.refused": "refusal",
} as const satisfies Partial<Record<EventType, string>>

export type PrefixBreakCause = (typeof PREFIX_BREAK_CAUSES)[keyof typeof PREFIX_BREAK_CAUSES]

/** The distinct causes among `events`, in the order they first occur. */
export function prefixBreakCauses(events: Iterable<{ readonly type: EventType }>): PrefixBreakCause[] {
  const causes: readonly (PrefixBreakCause | undefined)[] = [...events].map(
    (event) => (PREFIX_BREAK_CAUSES as Partial<Record<EventType, PrefixBreakCause>>)[event.type],
  )
  return [...new Set(causes.filter((cause) => cause !== undefined))]
}

type Break = Extract<PrefixComparison, { extension: false }>

export type PrefixVerdict =
  /** There is no previous step request to compare with. */
  | { readonly status: "first" }
  /** The request is the previous one plus `appended` blocks. */
  | { readonly status: "extension"; readonly appended: number }
  /** The request does not extend the previous one, and an appended event explains it. */
  | { readonly status: "expected_break"; readonly causes: readonly PrefixBreakCause[]; readonly comparison: Break }
  /** The request does not extend the previous one and nothing allows that. `comparison` names the first changed block. */
  | { readonly status: "violation"; readonly comparison: Break }

/**
 * Checks a step request against the previous step request of the session.
 *
 * `previous` is the ledger's last `step` row (`null` for the first request).
 * `since` is every event appended after the `step.started` of the message that
 * row served, which is the state the previous request was built from.
 */
export function checkPrefix(
  previous: readonly BlockHash[] | null,
  next: readonly BlockHash[],
  since: Iterable<{ readonly type: EventType }>,
): PrefixVerdict {
  if (previous === null) return { status: "first" }
  const comparison = comparePrefix(previous, next)
  if (comparison.extension) return { status: "extension", appended: comparison.appended }
  const causes = prefixBreakCauses(since)
  return causes.length > 0 ? { status: "expected_break", causes, comparison } : { status: "violation", comparison }
}
