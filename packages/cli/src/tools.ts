/**
 * How each tool call is described in one line: the most useful argument when
 * it starts, and a short summary of its result when it settles. Built from the
 * call's argument text and the tool's `display` data (see packages/core/src/tools),
 * falling back to the model-facing output for tools this file does not know.
 */
import type { EventData, Json } from "@light-harness/core"
import { formatBytes, plural } from "./text.ts"

/** The argument worth showing for a call, from its raw argument text (which may be malformed). */
export function callArgument(name: string, input: string): string {
  const args = parseObject(input)
  if (args === null) return input.trim() === "" ? "" : input.trim()
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : null)
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return str("path") ?? ""
    case "ls":
      return str("path") ?? "."
    case "glob":
    case "grep": {
      const pattern = str("pattern") ?? ""
      const where = str("path")
      const only = str("glob")
      return [pattern, where === null ? null : `in ${where}`, only === null ? null : `(${only})`].filter((part) => part !== null).join(" ")
    }
    case "shell":
      return str("command") ?? ""
    default: {
      const first = Object.values(args).find((value) => typeof value === "string")
      return typeof first === "string" ? first : ""
    }
  }
}

type Settled = EventData<"tool.settled">

/** The short result of a successful call: e.g. `12 lines`, `+3 -1`, `5 matches in 2 files`, `exit 0`. */
export function successSummary(name: string, settled: Settled): string {
  const display = asObject(settled.display)
  const num = (key: string) => (display !== null && typeof display[key] === "number" ? (display[key] as number) : null)
  switch (name) {
    case "read": {
      const lines = num("lines")
      const total = num("totalLines")
      if (lines === null) return plural(countLines(settled.output), "line")
      return total !== null && total !== lines ? `${plural(lines, "line")} of ${total.toLocaleString("en-US")}` : plural(lines, "line")
    }
    case "write": {
      const bytes = num("bytes")
      if (display === null || bytes === null) return firstLine(settled.output)
      return `${display.created === true ? "created" : "overwrote"} · ${formatBytes(bytes)}`
    }
    case "edit": {
      const diff = display !== null && typeof display.diff === "string" ? display.diff : null
      if (diff === null) return firstLine(settled.output)
      const stat = diffStat(diff)
      const replacements = num("replacements")
      return `+${stat.added} -${stat.removed}${replacements !== null && replacements > 1 ? ` · ${replacements} replacements` : ""}`
    }
    case "grep": {
      const matches = num("matches")
      const files = num("files")
      if (matches === null) return plural(countLines(settled.output), "line")
      if (matches === 0) return "no matches"
      return files === null ? plural(matches, "match", "matches") : `${plural(matches, "match", "matches")} in ${plural(files, "file")}`
    }
    case "glob": {
      const matches = num("matches")
      if (matches === null) return plural(countLines(settled.output), "line")
      return matches === 0 ? "no files" : plural(matches, "file")
    }
    case "ls": {
      const entries = num("entries")
      return entries === null ? plural(countLines(settled.output), "line") : plural(entries, "entry", "entries")
    }
    case "shell":
      return shellStatus(display) ?? ""
    default:
      return firstLine(settled.output)
  }
}

/** The short status of a failed call: a command's exit status, otherwise just "failed". The reason goes in `detailLines`. */
export function errorSummary(name: string, settled: Settled): string {
  return (name === "shell" ? shellStatus(asObject(settled.display)) : null) ?? "failed"
}

/**
 * Lines shown under the outcome line. A command shows the end of its output
 * (where results and errors are), a failed call the first lines of its error
 * text. Outcomes the loop decided (`not_started`, `effect_unknown`) have fixed
 * wording on the outcome line and no detail.
 */
export function detailLines(name: string, settled: Settled): string[] {
  if (settled.outcome === "not_started" || settled.outcome === "effect_unknown") return []
  const lines = settled.output.split("\n").filter((line) => line.trim() !== "" && line !== "(no output)")
  if (name === "shell") {
    // The bracketed status line ("[Exit code 1]") repeats what the outcome line says.
    const body = shellStatus(asObject(settled.display)) === null ? lines : lines.filter((line) => !/^\[.*\]$/.test(line.trim()))
    const keep = settled.outcome === "error" ? 4 : 2
    if (body.length <= keep + 1) return body
    return [`… ${plural(body.length - keep, "earlier line")}`, ...body.slice(-keep)]
  }
  if (settled.outcome !== "error") return []
  return lines.slice(0, 2)
}

function shellStatus(display: Record<string, Json> | null): string | null {
  if (display === null) return null
  if (display.timedOut === true) return "timed out"
  if (typeof display.interrupted === "string") return "stopped"
  if (typeof display.exitCode === "number") return `exit ${display.exitCode}`
  if (typeof display.signal === "string") return `killed by ${display.signal}`
  return null
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) added += 1
    else if (line.startsWith("-")) removed += 1
  }
  return { added, removed }
}

export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? ""
}

function countLines(text: string): number {
  if (text === "") return 0
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
}

function parseObject(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asObject(value: Json | null): Record<string, Json> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : null
}
