/**
 * The pairs of consecutive requests the prefix gate checks, and the break
 * each pair is allowed.
 *
 * Every verified call of a session is paired with the verified call before
 * it. The pair may break the prefix only if a legitimate break event was
 * appended in between, and only as far as that event can reach:
 * - `compaction` (history restarts at the checkpoint, and a new baseline may
 *   follow) and `settings` (the model or effort is in the first block) may
 *   change anything;
 * - `revert` and `refusal` remove messages, so tools and instructions must
 *   survive.
 *
 * The allowance has the shape of prefixlens's `allowBreak` option.
 */
import type { PrefixBreakCause } from "../request/build-break.ts"
import type { ExportedCall, ExportResult } from "./export.ts"
import type { CanonicalTraceRequest } from "./format.ts"

export interface PrefixPair {
  readonly previous: ExportedCall & { readonly request: CanonicalTraceRequest }
  readonly next: ExportedCall & { readonly request: CanonicalTraceRequest }
  /** Legitimate breaks appended after `previous` started and up to `next`. */
  readonly causes: readonly PrefixBreakCause[]
  /** `undefined` when the pair must keep the prefix. */
  readonly allowBreak?: { readonly after: "start" | "system"; readonly reason: string }
}

export function prefixPairs(result: ExportResult): PrefixPair[] {
  const verified = (call: ExportedCall): call is PrefixPair["previous"] => call.request !== null
  return result.calls.flatMap((call, index): PrefixPair[] => {
    if (!verified(call)) return []
    const before = result.calls.slice(0, index)
    const previousIndex = before.findLastIndex(verified)
    if (previousIndex === -1) return []
    const previous = before[previousIndex] as PrefixPair["previous"]
    const causes = [...new Set(result.calls.slice(previousIndex + 1, index + 1).flatMap((between) => between.breaks))]
    return [{ previous, next: call, causes, ...(causes.length > 0 ? { allowBreak: allowance(causes) } : {}) }]
  })
}

function allowance(causes: readonly PrefixBreakCause[]): NonNullable<PrefixPair["allowBreak"]> {
  const anywhere = causes.includes("compaction") || causes.includes("settings")
  // prefixlens names a break whose reason is exactly "compaction" as a compaction.
  const reason = causes.length === 1 && causes[0] === "compaction" ? "compaction" : causes.join(", ")
  return { after: anywhere ? "start" : "system", reason }
}
