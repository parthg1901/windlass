/**
 * How a harness tool call looks to an ACP client: its kind, a one-line title,
 * the places it touches, and the content shown when it settles. Built from the
 * call's argument text and the tool's `display` data (see
 * packages/core/src/tools/), the same sources the CLI renderer reads, and
 * falling back to the model-facing output for tools this file does not know.
 */
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk"
import type { EventData, Json } from "@windlass/core"
import { fenced } from "./prompt.ts"

export function toolKind(name: string): ToolKind {
  switch (name) {
    case "read":
    case "ls":
      return "read"
    case "write":
    case "edit":
      return "edit"
    case "glob":
    case "grep":
      return "search"
    case "shell":
      return "execute"
    default:
      return "other"
  }
}

/** The tool's argument object, or `null` when the argument text is not a JSON object (it may be malformed or partial). */
export function parseInput(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The `rawInput` sent to the client: the parsed arguments, or the argument text as written when it does not parse. */
export function rawInput(input: string): unknown {
  return parseInput(input) ?? input
}

/** A one-line title. Without arguments (the call is still being written) it is just the action. */
export function toolTitle(name: string, args: Record<string, unknown> | null): string {
  const str = (key: string) => (args !== null && typeof args[key] === "string" ? oneLine(args[key] as string) : null)
  switch (name) {
    case "read":
      return withArg("Read", str("path"))
    case "write":
      return withArg("Write", str("path"))
    case "edit":
      return withArg("Edit", str("path"))
    case "ls":
      return withArg("List", str("path") ?? (args === null ? null : "."))
    case "glob":
      return withArg("Find files", [str("pattern"), where(str("path"))].filter((part) => part !== null).join(" ") || null)
    case "grep": {
      const pattern = str("pattern")
      const only = str("glob")
      return withArg("Search", [pattern === null ? null : JSON.stringify(pattern), where(str("path")), only === null ? null : `(${only})`].filter((part) => part !== null).join(" ") || null)
    }
    case "shell": {
      const command = str("command")
      return command === null ? "Run a command" : `\`${command.replaceAll("`", "'")}\``
    }
    case "run_code": {
      // The program's first line that says something; the program itself is in the call's raw input.
      const first = str("code") === null ? null : (args!.code as string).split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("//"))
      return withArg("Run a program", first === undefined || first === null ? null : oneLine(first))
    }
    default: {
      const first = args === null ? undefined : Object.values(args).find((value) => typeof value === "string")
      return withArg(name, typeof first === "string" ? oneLine(first) : null)
    }
  }
}

/** The files a call touches, as absolute paths, with the line it starts at when the arguments say. */
export function toolLocations(name: string, args: Record<string, unknown> | null, cwd: string): ToolCallLocation[] {
  if (args === null) return []
  const path = typeof args.path === "string" && args.path !== "" ? absolute(cwd, args.path) : null
  switch (name) {
    case "read": {
      if (path === null) return []
      const offset = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset >= 1 ? args.offset : null
      return [offset === null ? { path } : { path, line: offset }]
    }
    case "write":
    case "edit":
    case "ls":
      return path === null ? [] : [{ path }]
    case "glob":
    case "grep":
      return path === null ? [] : [{ path }]
    default:
      return []
  }
}

type Settled = EventData<"tool.settled">

/** What the client shows for a settled call, and the locations it updates (an edit knows the lines it changed). */
export function settledContent(
  name: string,
  args: Record<string, unknown> | null,
  settled: Settled,
  cwd: string,
): { content: ToolCallContent[]; locations: ToolCallLocation[] | null } {
  const display = asObject(settled.display)
  const text = (value: string): ToolCallContent => ({ type: "content", content: { type: "text", text: value } })
  // Outcomes the step loop decided carry a sentence written for people as well as for the model.
  if (settled.outcome === "not_started") return { content: [text(`Not started. ${settled.output}`)], locations: null }
  if (settled.outcome === "effect_unknown") return { content: [text(`Outcome unknown. ${settled.output}`)], locations: null }
  const output = settled.output
  if (settled.outcome === "error") return { content: [text(name === "shell" ? fenced(output) : output)], locations: null }
  switch (name) {
    case "edit": {
      const diff = display !== null && typeof display.diff === "string" ? display.diff : null
      const path = typeof args?.path === "string" ? absolute(cwd, args.path) : null
      if (diff === null || path === null) return { content: [text(output)], locations: null }
      const hunks = parseHunks(diff)
      if (hunks.length === 0) return { content: [text(output)], locations: null }
      return {
        content: hunks.map((hunk) => ({ type: "diff", path, oldText: hunk.oldText, newText: hunk.newText })),
        locations: hunks.map((hunk) => ({ path, line: hunk.firstChangedLine })),
      }
    }
    case "write": {
      const path = typeof args?.path === "string" ? absolute(cwd, args.path) : null
      const content = typeof args?.content === "string" ? args.content : null
      // A new file is a diff from nothing. An overwrite has no old text to show, so it is described instead.
      if (display?.created === true && path !== null && content !== null) return { content: [{ type: "diff", path, oldText: null, newText: content }], locations: null }
      return { content: [text(output)], locations: null }
    }
    case "read": {
      const lines = display !== null && typeof display.lines === "number" ? display.lines : null
      const total = display !== null && typeof display.totalLines === "number" ? display.totalLines : null
      if (lines === null) return { content: [], locations: null }
      return { content: [text(total !== null && total !== lines ? `${lines} of ${total} lines` : `${lines} ${lines === 1 ? "line" : "lines"}`)], locations: null }
    }
    case "shell":
    case "grep":
    case "glob":
    case "ls":
      return { content: [text(fenced(output))], locations: null }
    default:
      return { content: [text(output)], locations: null }
  }
}

/** Progress text from a running tool (a command's latest output lines). */
export function progressContent(name: string, progress: string): ToolCallContent[] {
  return [{ type: "content", content: { type: "text", text: name === "shell" ? fenced(progress) : progress } }]
}

/** The title suffix for outcomes ACP has no status for, so a list of calls shows them without opening each one. */
export function outcomeSuffix(outcome: Settled["outcome"]): string | null {
  if (outcome === "not_started") return "not started"
  if (outcome === "effect_unknown") return "outcome unknown"
  return null
}

interface Hunk {
  readonly oldText: string
  readonly newText: string
  readonly firstChangedLine: number
}

/** The hunks of the edit tool's unified diff, each as the old and new text of the lines it covers. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: { old: string[]; next: string[]; start: number; firstChange: number | null; offset: number } | null = null
  const finish = () => {
    if (current !== null)
      hunks.push({ oldText: current.old.join("\n"), newText: current.next.join("\n"), firstChangedLine: current.firstChange ?? current.start })
    current = null
  }
  for (const line of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header !== null) {
      finish()
      current = { old: [], next: [], start: Math.max(1, Number(header[1])), firstChange: null, offset: 0 }
      continue
    }
    if (current === null) continue
    const hunk: { old: string[]; next: string[]; start: number; firstChange: number | null; offset: number } = current
    if (line.startsWith(" ")) {
      hunk.old.push(line.slice(1))
      hunk.next.push(line.slice(1))
      hunk.offset += 1
    } else if (line.startsWith("-")) {
      hunk.old.push(line.slice(1))
      hunk.firstChange ??= hunk.start + hunk.offset
    } else if (line.startsWith("+")) {
      hunk.next.push(line.slice(1))
      hunk.firstChange ??= hunk.start + hunk.offset
      hunk.offset += 1
    } else if (line.startsWith("...")) break
  }
  finish()
  return hunks
}

/** Resolves a path from the model the way the tools do: against the working directory, `~` as the home directory. */
export function absolute(cwd: string, path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function withArg(action: string, arg: string | null): string {
  return arg === null || arg === "" ? action : `${action} ${arg}`
}

function where(path: string | null): string | null {
  return path === null ? null : `in ${path}`
}

function oneLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? ""
  const more = text.trim().includes("\n") ? " …" : ""
  return line.length > 120 ? `${line.slice(0, 119)}…` : `${line}${more}`
}

function asObject(value: Json | null): Record<string, Json> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : null
}
