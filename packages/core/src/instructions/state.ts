/**
 * Instruction state and change detection.
 *
 * The state answers one question per source: what value was the model last
 * given? It is derived from the model's view of the log and nothing else, so
 * there is no memory to lose or to get out of step:
 *
 * - the sources of the baseline in force (`baseline.sources`), then
 * - every visible instruction message newer than that baseline, in order.
 *   Its `fingerprint` is the value the model now has for its source; `null`
 *   marks the source as gone.
 *
 * Both are fields the log stores (`baseline.set` and `instruction.appended`
 * carry them), so nothing here reads rendered text back: the text format of a
 * section can change without touching detection.
 *
 * Deriving it from the model's view makes the hard cases fall out by
 * themselves. A reverted or refused instruction message is no longer visible,
 * so the change is detected and appended again. A compaction that leaves an
 * instruction message behind the checkpoint has the same effect, unless the
 * new baseline already folded the change in. A fork inherits the state with
 * the parent's history.
 */
import { type EventData, type InstructionDetail, type NewEvent, event } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import { type ModelHistory, selectModelHistory } from "../message/history.ts"
import type { Projection } from "../message/message.ts"
import { type BaselineInput, buildBaseline } from "./baseline.ts"
import { type InstructionSource, agentsPath, fingerprint, renderRemoval, renderUpdate } from "./source.ts"

/**
 * Source key -> `fingerprint` of the value the model was last given, or `null`
 * when the last thing it was told is that the source is gone.
 */
export type InstructionState = ReadonlyMap<string, string | null>

/** What the model currently knows about each instruction source. */
export function instructionState(history: Pick<ModelHistory, "baseline" | "messages">): InstructionState {
  const state = new Map<string, string | null>()
  const baseline = history.baseline
  if (baseline === null) return state
  for (const entry of baseline.sources) state.set(entry.source, entry.fingerprint)
  for (const message of history.messages) {
    // The request builder drops instruction messages older than the baseline, so they tell the model nothing.
    if (message.kind !== "instruction" || message.seq < baseline.seq) continue
    state.set(message.source, message.fingerprint)
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
  const appended = (source: string, text: string, value: string | null) =>
    event("instruction.appended", { messageId: newMessageId(), source, text, fingerprint: value })
  const changed = sources.flatMap((source) => {
    const known = state.get(source.key) ?? null
    const current = fingerprint(source.value)
    if (known === current) return []
    return [appended(source.key, renderUpdate(source, known === null ? "added" : "replaced"), current)]
  })
  const present = new Set(sources.map((source) => source.key))
  const removed = [...state]
    .filter(([key, known]) => known !== null && agentsPath(key) !== null && !present.has(key))
    .map(([key]) => key)
    .sort()
    .map((key) => appended(key, renderRemoval(key), null))
  return [...changed, ...removed]
}

/**
 * A source that is never part of the baseline: the MCP catalogue (`mcp`),
 * the skill index (`skills`), memory (`memory`). What it has to say changes
 * with things outside the session (a server connects, a skill file is
 * edited), so it reaches the model only as appended messages: once when it
 * first has something to say, again when its fingerprint changes, and as a
 * short withdrawal (fingerprint `null`) when nothing is left. The module that
 * owns the source writes the texts; this file only routes its key.
 */
export interface AppendedSource {
  /** The `source` of its `instruction.appended` events. Never a key of `source.ts`. */
  readonly key: string
  /**
   * What to append so that the model's knowledge matches the source as it is
   * now, given the fingerprint the model last had for the key (`null` or
   * `undefined`: nothing, or that it is gone). `null` when nothing changed.
   * The text is final and is stored as returned.
   */
  readonly update: (known: string | null | undefined) => AppendedUpdate | null
}

export interface AppendedUpdate {
  readonly text: string
  readonly fingerprint: string | null
  /** What the text carries, as fields (`instructionDetail`). */
  readonly detail?: InstructionDetail
}

/**
 * The events to append for the sources that are never in the baseline, in
 * the order given. `state` is the instruction fold of the model's view, so a
 * message that was reverted, refused or left behind by a compaction is no
 * longer known and its source is appended again in full: after a compaction
 * the new baseline does not carry these sources, and the first boundary
 * after it gives the model the current catalogue, index and notes again.
 */
export function detectAppendedChanges(
  state: InstructionState,
  sources: readonly AppendedSource[],
  newMessageId: () => MessageId,
): NewEvent<"instruction.appended">[] {
  return sources.flatMap((source) => {
    const update = source.update(state.get(source.key))
    if (update === null) return []
    return [
      event("instruction.appended", {
        messageId: newMessageId(),
        source: source.key,
        text: update.text,
        fingerprint: update.fingerprint,
        ...(update.detail === undefined ? {} : { detail: update.detail }),
      }),
    ]
  })
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
 * that the request carries current instructions. The caller holds the
 * execution claim: an instruction message is accepted only under a running
 * execution, so a change noticed while the session is idle is appended once
 * the next execution has started.
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
