/**
 * Instruction sources: the things the model is told that can differ per
 * session or change during one (the environment, the date, AGENTS.md files),
 * and the one text form they take in a request.
 *
 * Everything here is pure. Reading the filesystem and the clock is `discover.ts`.
 *
 * A source is shown to the model as a section:
 *
 *   <instructions path="/repo/AGENTS.md" lines="2">
 *   Use bun.
 *   Run the tests before you report.
 *   </instructions>
 *
 * The header states how many lines the body has, so where a section ends
 * never depends on what the body contains (a closing tag, another header).
 * `parseSections` shows that: it takes the stated number of lines and never
 * searches the body. Change detection does not read sections back; it
 * compares the `fingerprint` the log stores for each source (see `state.ts`).
 */
import { createHash } from "node:crypto"

export interface InstructionSource {
  /**
   * Stable identity, and the `source` of the `instruction.appended` events
   * about it: `environment`, `date`, or `agents:<absolute path>`. Other keys
   * (`mcp`, `skills`, `memory`) belong to sources that are never part of the
   * baseline and are rendered by their own modules: see `AppendedSource` in
   * `state.ts`. `renderSection` refuses them, so one can never be folded
   * into a baseline by mistake.
   */
  readonly key: string
  /** The body the model is given. Never blank, and without a trailing newline. */
  readonly value: string
}

export const ENVIRONMENT_KEY = "environment"
export const DATE_KEY = "date"
const AGENTS_PREFIX = "agents:"

export function agentsKey(path: string) {
  return `${AGENTS_PREFIX}${path}`
}

/** The file path of an `agents:` key, or `null` for any other key. */
export function agentsPath(key: string): string | null {
  return key.startsWith(AGENTS_PREFIX) ? key.slice(AGENTS_PREFIX.length) : null
}

/** The environment block. Only facts that the session's tools depend on. */
export function environmentSource(input: {
  readonly cwd: string
  readonly platform: string
  readonly gitRepository: boolean
}): InstructionSource {
  return {
    key: ENVIRONMENT_KEY,
    value: [
      `Working directory: ${input.cwd}`,
      `Platform: ${input.platform}`,
      `Git repository: ${input.gitRepository ? "yes" : "no"}`,
    ].join("\n"),
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

/** A calendar date, e.g. `Wednesday, 2026-11-11`. `month` is 1 to 12. */
export function dateSource(year: number, month: number, day: number): InstructionSource {
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!
  const pad = (value: number, width: number) => String(value).padStart(width, "0")
  return { key: DATE_KEY, value: `${weekday}, ${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` }
}

/** An AGENTS.md file. `content` is normalised: LF line endings, no byte-order mark, no surrounding blank space. */
export function agentsSource(path: string, content: string): InstructionSource {
  return { key: agentsKey(path), value: content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim() }
}

/**
 * The identity of a source's value for change detection: lowercase hex
 * SHA-256 of its UTF-8 bytes. Stored in `baseline.set` and
 * `instruction.appended` next to the text that carries the value.
 */
export function fingerprint(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function tag(key: string) {
  if (key === ENVIRONMENT_KEY) return { name: "environment", attribute: "" }
  if (key === DATE_KEY) return { name: "date", attribute: "" }
  const path = agentsPath(key)
  if (path === null || path.includes("\n")) throw new Error(`"${key}" is not an instruction source key`)
  return { name: "instructions", attribute: ` path="${path}"` }
}

/** The section that shows a source to the model, in the baseline and in appended messages alike. */
export function renderSection(source: InstructionSource): string {
  const { name, attribute } = tag(source.key)
  return [`<${name}${attribute} lines="${source.value.split("\n").length}">`, source.value, `</${name}>`].join("\n")
}

const HEADER = /^<(?:(environment|date)|instructions path="(.+)") lines="(\d+)">$/

/**
 * Reads back every section in `text`, in order. The inverse of
 * `renderSection` for any text that contains sections between other lines,
 * as long as those other lines are not themselves section headers.
 */
export function parseSections(text: string): InstructionSource[] {
  const lines = text.split("\n")
  const sections: InstructionSource[] = []
  let index = 0
  while (index < lines.length) {
    const match = HEADER.exec(lines[index]!)
    const count = match === null ? 0 : Number(match[3])
    const name = match === null ? null : (match[1] ?? "instructions")
    // A header is only a header when its closing line is where it says it is.
    if (match === null || count < 1 || lines[index + count + 1] !== `</${name}>`) {
      index += 1
      continue
    }
    sections.push({
      key: match[1] ?? agentsKey(match[2]!),
      value: lines.slice(index + 1, index + 1 + count).join("\n"),
    })
    index += count + 2
  }
  return sections
}

/**
 * The message appended when a source the model has not been given appears
 * (`added`) or when one it has been given changed (`replaced`). The text is
 * frozen in the `instruction.appended` event.
 */
export function renderUpdate(source: InstructionSource, change: "added" | "replaced"): string {
  return `${notice(source.key, change)}\n${renderSection(source)}`
}

function notice(key: string, change: "added" | "replaced") {
  if (key === DATE_KEY)
    return change === "added" ? "Today's date:" : "The date has changed. This replaces the date you were given before:"
  if (key === ENVIRONMENT_KEY)
    return change === "added"
      ? "The environment you are working in:"
      : "The environment has changed. This replaces the environment block you were given before:"
  const path = agentsPath(key)
  return change === "added"
    ? `The instructions file ${path} now applies, in addition to the instructions you already have:`
    : `The instructions file ${path} was edited. This version replaces everything you were given from that file before:`
}

/** The message appended when an AGENTS.md file the model was given no longer exists. It contains no section. */
export function renderRemoval(key: string): string {
  return `The instructions file ${agentsPath(key)} no longer exists. Disregard everything you were given from that file.`
}
