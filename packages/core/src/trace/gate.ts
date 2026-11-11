/**
 * The pairs of consecutive requests the prefix gate checks, and the break
 * each pair is allowed.
 *
 * Every verified call of a session is paired with the verified call before
 * it. The pair may break the prefix only as far as the `prefix_break`
 * declarations the exporter wrote for the calls in between allow (SPEC 6.1),
 * so the gate and `prefixlens report` judge every break by the same
 * declaration:
 * - `compaction`, `model_switch` and `settings_change` may change anything;
 * - `revert` and `refusal` remove messages, so tools and instructions must
 *   survive (prefixlens's default for those reasons, or the declaration's
 *   explicit `after`).
 *
 * The allowance has the shape of prefixlens's `allowBreak` option: a reason,
 * and `after` only when the declaration states one.
 */
import type { PrefixBreakCause } from "../request/build-break.ts"
import type { ExportedCall, ExportResult } from "./export.ts"
import type { CanonicalTraceRequest, PrefixBreakHint } from "./format.ts"

export interface PrefixPair {
  readonly previous: ExportedCall & { readonly request: CanonicalTraceRequest }
  readonly next: ExportedCall & { readonly request: CanonicalTraceRequest }
  /** Legitimate breaks appended after `previous` started and up to `next`. */
  readonly causes: readonly PrefixBreakCause[]
  /** `undefined` when the pair must keep the prefix. */
  readonly allowBreak?: { readonly reason: PrefixBreakHint["reason"]; readonly after?: PrefixBreakHint["after"] }
}

export function prefixPairs(result: ExportResult): PrefixPair[] {
  const verified = (call: ExportedCall): call is PrefixPair["previous"] => call.request !== null
  return result.calls.flatMap((call, index): PrefixPair[] => {
    if (!verified(call)) return []
    const before = result.calls.slice(0, index)
    const previousIndex = before.findLastIndex(verified)
    if (previousIndex === -1) return []
    const previous = before[previousIndex] as PrefixPair["previous"]
    const between = result.calls.slice(previousIndex + 1, index + 1)
    const causes = [...new Set(between.flatMap((entry) => entry.breaks))]
    const widest = between.flatMap((entry) => entry.declared).toSorted((a, b) => reach(a) - reach(b))[0]
    const allowBreak = widest && { reason: widest.reason, ...(widest.after === undefined ? {} : { after: widest.after }) }
    return [{ previous, next: call, causes, ...(allowBreak ? { allowBreak } : {}) }]
  })
}

/** Orders declarations by how much they keep: fewer kept blocks reach further. A message position keeps at least the tools and system prompt. */
function reach(hint: PrefixBreakHint) {
  const after = hint.after ?? (hint.reason === "revert" || hint.reason === "refusal" ? "system" : "start")
  if (after === "start") return 0
  if (typeof after === "number") return after
  return { tools: 1e9, system: 1e9 + 1 }[after as "tools" | "system"] ?? 1e9 + 2
}
