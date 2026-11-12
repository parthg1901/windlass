/**
 * Replay as the engine runs it: what a caller may change, how the changed
 * baseline is made from the recording, and what a finished replay hands
 * back. The matching, the tape and the report are `replay/`; the loop that
 * drives them is `engine.ts`.
 *
 * A replay session (`lineage.kind = "replay"`):
 *
 * - starts with the recording's own baseline (its instructions with the
 *   sources as they were then, its tool list), changed only in what the
 *   caller overrides. Nothing is discovered again: today's date and today's
 *   AGENTS.md are not the recording's;
 * - is given the recording's inputs (the user's messages, the harness's
 *   notes, instruction updates) at the steps they arrived before;
 * - calls the real model, and answers each tool call that is on the tape
 *   from the tape. Nothing runs, nothing is asked, nothing is verified;
 * - at the first call that is not on the tape either stops (`stop`), or
 *   restores the recorded workspace into a copy and carries on there with
 *   real tools in the sandbox (`execute`, `execute-read-only`).
 *
 * What a replay cannot do is stated in `docs/replay.md`.
 */
import type { EventData, ReplayPolicyKind, SessionSettings, StoredEvent } from "../event/durable.ts"
import type { SessionId } from "../id.ts"
import { parseSections } from "../instructions/source.ts"
import type { Usage } from "../provider/usage.ts"
import { type Normaliser, normalise } from "../replay/match.ts"
import type { ReplayReport } from "../replay/report.ts"
import type { EngineSession } from "./engine.ts"

/** What a replay is asked to do. Everything is optional: with nothing changed it measures how often the model itself differs. */
export interface ReplayRequest {
  /** Replay the recording through this event. Default: all of it. */
  readonly throughSeq?: number
  /** The base system prompt, instead of the one the recording's baseline starts with. The recorded sections (AGENTS.md, environment, date) stay. */
  readonly systemPrompt?: string
  /** New descriptions, by tool name. The names and schemas stay the recording's. */
  readonly toolDescriptions?: Readonly<Record<string, string>>
  readonly model?: string
  /** `null` is the model's default effort. */
  readonly effort?: string | null
  /** What happens at the first call that is not on the tape. Default `stop`. */
  readonly policy?: ReplayPolicyKind
  /** No normalisers and exact step boundaries. */
  readonly strict?: boolean
  /** Per-tool normalisers, instead of `DEFAULT_NORMALISERS`. Ignored in strict mode. */
  readonly normalisers?: Readonly<Record<string, Normaliser>>
  /** Where the copy of the workspace is made, for the policies that run tools. Default `<dataDir>/replays/<replay session>`. */
  readonly workspace?: string
  /** Give up after this many model calls while on the tape. Default: the recording's steps plus 10. */
  readonly maxSteps?: number
}

/** A replay in progress. */
export interface ReplayRun {
  /** The replay session. Its events are the replay's progress; interrupting it ends the replay as incomplete. */
  readonly session: EngineSession
  /** Resolves when the replay is over, however it ended. */
  readonly done: Promise<ReplayOutcome>
}

export interface ReplayOutcome {
  readonly sessionId: SessionId
  readonly sourceSessionId: SessionId
  readonly report: ReplayReport
  /** The copy the replay carried on in after it left the recording; `null` when it never ran a tool for real. */
  readonly workspace: string | null
  /** What the replay's own model calls cost. */
  readonly usage: Usage | null
  /** How many model calls it made. */
  readonly requests: number
}

/**
 * The normalisers a replay uses unless told otherwise: a path given
 * relative to the working directory or absolute is the same path, and
 * trailing whitespace of a command changes nothing.
 */
export const DEFAULT_NORMALISERS: Readonly<Record<string, Normaliser>> = {
  read: normalise.paths("path"),
  write: normalise.paths("path"),
  edit: normalise.paths("path"),
  ls: normalise.paths("path"),
  glob: normalise.paths("path"),
  grep: normalise.paths("path"),
  shell: normalise.trimEnd("command"),
}

export const REPLAY_TEXT = {
  ended: (reason: string) => `The replay ended: ${reason}`,
  crashed: "the process that ran the replay stopped before the replay ended; a replay is not taken up again",
  interrupted: "the replay was interrupted",
  noPrompts: "a replay session takes no prompts: it replays its recording and ends",
} as const

/** The base system prompt of a baseline's instructions and the sections that follow it, as they are stored. */
export function splitInstructions(instructions: string): { readonly prompt: string; readonly sections: string } {
  const first = parseSections(instructions)[0]
  if (first === undefined) return { prompt: instructions, sections: "" }
  const lines = instructions.split("\n")
  // The first line that opens a section whose closing line is where its header says it is.
  const header = /^<(?:environment|date|instructions path=".+") lines="(\d+)">$/
  const index = lines.findIndex((line, at) => {
    const match = header.exec(line)
    return match !== null && /^<\/(?:environment|date|instructions)>$/.test(lines[at + Number(match[1]) + 1] ?? "")
  })
  if (index === -1) return { prompt: instructions, sections: "" }
  return { prompt: lines.slice(0, index).join("\n").trimEnd(), sections: lines.slice(index).join("\n") }
}

export interface ChangedBaseline {
  readonly baseline: EventData<"baseline.set">
  readonly settings: SessionSettings
  readonly changed: { readonly instructions: boolean; readonly tools: string[]; readonly settings: boolean }
}

/**
 * The baseline a replay starts with: the recording's first one, with the
 * base prompt and the tool descriptions the request overrides. Throws with a
 * plain message when the recording has no baseline or a tool is not in it.
 */
export function changedBaseline(events: readonly StoredEvent[], recorded: SessionSettings, request: ReplayRequest): ChangedBaseline {
  const first = events.find((item): item is StoredEvent<"baseline.set"> => item.type === "baseline.set")
  if (first === undefined) throw new Error("the recording never called the model, so there is nothing to replay")
  const descriptions = request.toolDescriptions ?? {}
  const unknown = Object.keys(descriptions).filter((name) => !first.data.tools.some((tool) => tool.name === name))
  if (unknown.length > 0) throw new Error(`the recording has no tool named ${unknown.join(", ")}; its tools are ${first.data.tools.map((tool) => tool.name).join(", ")}`)
  const { prompt, sections } = splitInstructions(first.data.instructions)
  const instructions = request.systemPrompt === undefined ? first.data.instructions : [request.systemPrompt.replace(/\r\n?/g, "\n").trim(), ...(sections === "" ? [] : [sections])].join("\n\n")
  const tools = first.data.tools.map((tool) => (descriptions[tool.name] === undefined ? tool : { ...tool, description: descriptions[tool.name]! }))
  const settings: SessionSettings = { model: request.model ?? recorded.model, reasoningEffort: request.effort === undefined ? recorded.reasoningEffort : request.effort }
  return {
    baseline: { instructions, tools, sources: first.data.sources },
    settings,
    changed: {
      instructions: request.systemPrompt !== undefined && instructions !== first.data.instructions && request.systemPrompt.trim() !== prompt,
      tools: first.data.tools.filter((tool) => descriptions[tool.name] !== undefined && descriptions[tool.name] !== tool.description).map((tool) => tool.name),
      settings: settings.model !== recorded.model || settings.reasoningEffort !== recorded.reasoningEffort,
    },
  }
}

/**
 * The snapshot of the recorded workspace that was current when the recording
 * reached the point a replay left it at: the last one recorded before the
 * tools of the recorded step `recordedStep` ran (`null`: past the end of the
 * recording, so the last one of all). `null` when the recording has none.
 */
export function snapshotAtDivergence(events: readonly StoredEvent[], stepSeq: number | null): string | null {
  const taken = events.filter((item): item is StoredEvent<"snapshot.taken"> => item.type === "snapshot.taken")
  if (stepSeq === null) return taken.at(-1)?.data.id ?? null
  // The step's own `step_start` snapshot, taken right before its tools, is the state its calls ran against.
  const step = events.find((item) => item.seq === stepSeq)
  const messageId = step?.type === "step.started" ? step.data.messageId : null
  const own = taken.find((item) => item.data.point === "step_start" && item.data.messageId === messageId)
  return (own ?? taken.findLast((item) => item.seq < stepSeq))?.data.id ?? null
}
