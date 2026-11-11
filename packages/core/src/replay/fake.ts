/**
 * Scripted model responses that reproduce a tape, for tests and demos: the
 * fake provider then behaves exactly as the recorded model did, and a test
 * changes one step to see how the replay reports it.
 */
import type { Json } from "../json.ts"
import { type ScriptItem, type ScriptedResponse, script } from "../testing/fake-provider.ts"
import type { Tape } from "./tape.ts"

/**
 * One response per tape step: its text, then its calls with the recorded
 * argument text, then its usage. `overrides` replaces the response of a step
 * by its 0-based index; `null` removes it, and `extra` is appended at the end.
 */
export function responsesFromTape(
  tape: Tape,
  overrides: Readonly<Record<number, readonly ScriptItem[] | null>> = {},
  extra: readonly ScriptedResponse[] = [],
): ScriptedResponse[] {
  const recorded = tape.steps.map((step, index): readonly ScriptItem[] | null => {
    if (index in overrides) return overrides[index] ?? null
    return [
      ...(step.text === "" ? [] : [script.text(step.text)]),
      ...step.calls.map((call) => script.toolCall(call.callId, call.name, call.input as Json)),
      ...(step.usage === null ? [] : [script.usage(step.usage)]),
    ]
  })
  return [...recorded.filter((response) => response !== null), ...extra]
}
