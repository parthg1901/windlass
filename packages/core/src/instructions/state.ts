/**
 * Instruction state and change detection.
 *
 * The state answers one question per source: what value was the model last
 * given? It is derived from the model's view of the log and nothing else, so
 * there is no memory to lose or to get out of step:
 *
 * - the sections of the baseline in force, then
 * - every visible instruction message newer than that baseline, in order.
 *   A message that carries a section for its source sets the value; one that
 *   carries none (a removal notice) marks the source as gone.
 *
 * Deriving it from the model's view makes the hard cases fall out by
 * themselves. A reverted or refused instruction message is no longer visible,
 * so the change is detected and appended again. A compaction that leaves an
 * instruction message behind the checkpoint has the same effect, unless the
 * new baseline already folded the change in. A fork inherits the state with
 * the parent's history.
 *
 * THE GAP. Events store instruction text only, so the value of a source is
 * read back out of that text with `parseSections`. That is exact, because
 * sections state their own length, but it ties detection to the text format.
 * `InstructionState` is the shape the log should store instead: when
 * `baseline.set` and `instruction.appended` carry a fingerprint per source,
 * `instructionState` becomes a fold over those fields and nothing else here changes.
 */
import { type EventData, type NewEvent, event } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import { type ModelHistory, selectModelHistory } from "../message/history.ts"
import type { Projection } from "../message/message.ts"
import { type BaselineInput, buildBaseline } from "./baseline.ts"
import {
  type InstructionSource,
  agentsPath,
  fingerprint,
  parseSections,
  renderRemoval,
  renderUpdate,
} from "./source.ts"

/**
 * Source key -> `fingerprint` of the value the model was last given, or `null`
 * when the last thing it was told is that the source is gone.
 */
export type InstructionState = ReadonlyMap<string, string | null>

/** What the model currently knows about each instruction source. */
export function instructionState(history: ModelHistory): InstructionState {
  const state = new Map<string, string | null>()
  const baseline = history.baseline
  if (baseline === null) return state
  for (const section of parseSections(baseline.instructions)) state.set(section.key, fingerprint(section.value))
  for (const message of history.messages) {
    // The request builder drops instruction messages older than the baseline, so they tell the model nothing.
    if (message.kind !== "instruction" || message.seq < baseline.seq) continue
    const section = parseSections(message.text).find((candidate) => candidate.key === message.source)
    state.set(message.source, section === undefined ? null : fingerprint(section.value))
  }
  return state
}

/**
 * The events to append so that the model's instructions match `sources`, the
 * sources as discovered now. Returns an empty list when nothing changed.
 *
 * - A source the model was never given (an AGENTS.md first seen in a
 *   subdirectory) is appended once, as an addition.
 * - A source whose value differs (the date, an edited AGENTS.md) is appended
 *   with its new value and a line saying that it replaces the earlier one.
 * - An AGENTS.md the model was given that is not among `sources` any more is
 *   withdrawn with a short notice. `sources` must therefore cover every file
 *   in `state`; `knownDirectories` tells discovery where to look.
 *
 * The baseline is never touched. Each event's text is final when it is
 * returned; `newMessageId` supplies the ID of each appended message.
 */
export function detectInstructionChanges(
  state: InstructionState,
  sources: readonly InstructionSource[],
  newMessageId: () => MessageId,
): NewEvent<"instruction.appended">[] {
  const appended = (source: string, text: string) => event("instruction.appended", { messageId: newMessageId(), source, text })
  const changed = sources.flatMap((source) => {
    const known = state.get(source.key) ?? null
    if (known === fingerprint(source.value)) return []
    return [appended(source.key, renderUpdate(source, known === null ? "added" : "replaced"))]
  })
  const present = new Set(sources.map((source) => source.key))
  const removed = [...state]
    .filter(([key, known]) => known !== null && agentsPath(key) !== null && !present.has(key))
    .map(([key]) => key)
    .sort()
    .map((key) => appended(key, renderRemoval(key)))
  return [...changed, ...removed]
}

/** The paths of the AGENTS.md files the model currently has. Discovery re-reads them so an edit or removal is noticed. */
export function knownAgentsFiles(state: InstructionState): string[] {
  return [...state].flatMap(([key, known]) => {
    const path = agentsPath(key)
    return known === null || path === null ? [] : [path]
  })
}

export interface PrepareInput extends BaselineInput {
  readonly newMessageId: () => MessageId
}

/**
 * What to append at a step boundary, before the next request is built, so
 * that the request carries current instructions:
 *
 * - no baseline yet, or a compaction completed since the baseline was set:
 *   one `baseline.set` built from `input` (the only two points where the
 *   baseline may be written);
 * - otherwise: one `instruction.appended` per changed source, or nothing.
 *
 * Between compactions `input.prompt` and `input.tools` are ignored: the
 * frozen baseline stays in force.
 */
export function prepareInstructions(
  projection: Projection,
  input: PrepareInput,
): NewEvent<"baseline.set" | "instruction.appended">[] {
  const baseline = projection.baseline
  if (baseline === null || (projection.session.compaction?.seq ?? 0) > baseline.seq) {
    const data: EventData<"baseline.set"> = buildBaseline(input)
    return [event("baseline.set", data)]
  }
  return detectInstructionChanges(instructionState(selectModelHistory(projection)), input.sources, input.newMessageId)
}
