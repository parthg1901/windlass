/**
 * How each tool call is described in one line: the most useful argument when
 * it starts, and a short summary of its result when it settles. Built from the
 * call's argument text and the tool's `display` data (see packages/core/src/tools),
 * falling back to the model-facing output for tools this file does not know.
 */
import type { EventData, Json, VerificationOutcome } from "@windlass/core"
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
    // An MCP call is named by the server's tool, as the approval question and the catalogue name it.
    case "mcp_call": {
      const server = str("server")
      const tool = str("tool")
      return server === null && tool === null ? "" : `${server ?? "?"}/${tool ?? "?"}`
    }
    case "mcp_search":
      return str("query") ?? ""
    // A subagent is named by the first line of its task, as everywhere else.
    case "subagent":
      return (str("task") ?? "").trim().split("\n")[0] ?? ""
    case "report_check_failure": {
      const checks = Array.isArray(args.checks) ? args.checks.filter((name) => typeof name === "string").join(", ") : ""
      return [checks, str("reason")].filter((part) => part !== null && part !== "").join(": ")
    }
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
      // An image is attached for the model to see: its type, size and dimensions, not a line count.
      const image = display !== null ? asObject(display.image ?? null) : null
      if (image !== null) {
        const bytes = typeof image.bytes === "number" ? formatBytes(image.bytes) : null
        const size = typeof image.width === "number" && typeof image.height === "number" ? `${image.width}×${image.height}` : null
        return ["image", typeof image.mediaType === "string" ? image.mediaType : null, size, bytes].filter((part) => part !== null).join(" · ")
      }
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

// ---------------------------------------------------------------- checks and files

type CheckEvidence = EventData<"checks.finished">["evidence"]["checks"][number]

const CHECK_STATUS_ORDER = ["passed", "failed", "timed_out", "could_not_start", "interrupted"] as const
const CHECK_STATUS_LABEL: Record<CheckEvidence["status"], string> = {
  passed: "passed",
  failed: "failed",
  timed_out: "timed out",
  could_not_start: "could not start",
  interrupted: "stopped",
}

/** The counts of a run of checks: `2 passed`, or `1 failed, 1 passed` with what did not pass first. */
export function checksSummary(checks: readonly CheckEvidence[]): string {
  const counts = CHECK_STATUS_ORDER.flatMap((status) => {
    const count = checks.filter((check) => check.status === status).length
    return count === 0 ? [] : [{ status, text: `${count} ${CHECK_STATUS_LABEL[status]}` }]
  })
  const order = [...counts.filter((entry) => entry.status !== "passed"), ...counts.filter((entry) => entry.status === "passed")]
  return order.length === 0 ? "none ran" : order.map((entry) => entry.text).join(", ")
}

/** One entry per check that did not pass: how it ended, its command, and where its full output is. */
export function checkLines(checks: readonly CheckEvidence[]): { name: string; status: string; command: string; output: string | null }[] {
  return checks
    .filter((check) => check.status !== "passed")
    .map((check) => ({
      name: check.name,
      status: check.status === "failed" ? (check.signal !== null ? `killed by ${check.signal}` : `exit ${check.exitCode ?? "?"}`) : CHECK_STATUS_LABEL[check.status],
      command: check.command,
      output: check.outputPath,
    }))
}

/** Why a turn ended with checks still failing, as a sentence. */
export function unresolvedReason(verification: Extract<VerificationOutcome, { status: "unresolved" }>): string {
  switch (verification.reason) {
    case "acknowledged":
      return `the agent reported that it cannot make them pass: ${verification.acknowledgement?.reason ?? "no reason given"}`
    case "max_rounds":
      return `still failing after ${plural(verification.evidence.run, "run")}; the agent was sent back as often as verify.maxRounds allows`
    case "report_mode":
      return "verify.mode is report: failures are recorded and the agent is not sent back"
  }
}

/**
 * The arguments of an MCP call, as they will be sent: what leaves the
 * machine, for the approval question. One line of JSON, cut at `limit`
 * characters with how much more there is.
 */
export function mcpArguments(input: string, limit = 600): string | null {
  const args = parseObject(input)
  if (args === null) return null
  const sent = args.arguments === undefined ? {} : args.arguments
  const text = JSON.stringify(sent)
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length - limit} more characters)`
}

/** The first `limit` paths, then how many more there are. */
export function fileList(paths: readonly string[], limit: number): string {
  const shown = paths.slice(0, limit).join(", ")
  return paths.length > limit ? `${shown} (+${paths.length - limit} more)` : shown
}
