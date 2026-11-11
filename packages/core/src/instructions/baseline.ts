/**
 * The session baseline: the instructions text and the tool list that every
 * request of a session starts with.
 *
 * The baseline is frozen in the log by `baseline.set` and is produced once
 * before the first step and once after each compaction. Between those points
 * nothing here is rendered again: a source that changes becomes an appended
 * message (`state.ts`), never a new baseline.
 *
 * Layout of the instructions text, most stable part first:
 *
 *   base system prompt          the same for every session of a harness version
 *   one section per source      in the order given (AGENTS.md files, environment, date)
 *
 * Parts are separated by one blank line.
 */
import type { EventData } from "../event/durable.ts"
import { type ToolSpec, sortTools, specOf } from "../tool/tool.ts"
import { type InstructionSource, fingerprint, parseSections, renderSection } from "./source.ts"
import systemPrompt from "./system-prompt.txt"

/**
 * The harness's base system prompt. It contains nothing that differs between
 * sessions of the same harness version: no date, no directory, no model name.
 */
export const BASE_SYSTEM_PROMPT: string = systemPrompt.replace(/\r\n?/g, "\n").trim()

export interface BaselineInput {
  /** The base system prompt. Defaults to `BASE_SYSTEM_PROMPT`. */
  readonly prompt?: string
  /** Every tool of the session, in any order. Only the model-facing part of each is kept. */
  readonly tools: readonly ToolSpec[]
  /** The instruction sources as discovered now, in the order the model should read them. */
  readonly sources: readonly InstructionSource[]
}

/** Builds the data of a `baseline.set` event. Pure: the same input gives the same text and the same tool order. */
export function buildBaseline(input: BaselineInput): EventData<"baseline.set"> {
  const prompt = input.prompt ?? BASE_SYSTEM_PROMPT
  // A section in the prompt would read to the model as a source, but no source is recorded for it.
  if (parseSections(prompt).length > 0) throw new Error("the base system prompt contains an instruction section")
  const tools = sortTools(input.tools.map(specOf))
  const repeatedTool = tools.find((tool, index) => tools[index - 1]?.name === tool.name)
  if (repeatedTool !== undefined) throw new Error(`two tools are named "${repeatedTool.name}"`)
  const keys = input.sources.map((source) => source.key)
  const repeatedKey = keys.find((key, index) => keys.indexOf(key) !== index)
  if (repeatedKey !== undefined) throw new Error(`two instruction sources have the key "${repeatedKey}"`)
  return {
    instructions: [prompt, ...input.sources.map(renderSection)].join("\n\n"),
    tools,
    // What the model is given per source, recorded beside the text so that change detection never parses it.
    sources: input.sources.map((source) => ({ source: source.key, fingerprint: fingerprint(source.value) })),
  }
}
