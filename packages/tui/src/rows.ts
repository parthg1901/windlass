/**
 * How each row of the conversation looks at a given width: a list of
 * terminal lines. Pure, so a frame can be checked as text, and cached by the
 * view per row until the row or the width changes.
 *
 * Tool calls are one line until expanded: the CLI's one-line summary of the
 * call (its argument, then its result). Expanded, a call shows its
 * arguments and its output in the form that suits the tool: a diff for an
 * edit, the tail of a command's output, the match list of a search. Output is
 * capped; a second expansion shows it in full up to `FULL_OUTPUT_LINES`.
 */
import { detailLines, diffStat, errorSummary, fileList, formatBytes, formatDuration, successSummary, unresolvedReason, usageText } from "./cli.ts"
import { truncate, wrapLine, wrapText, plural, sanitize, width as textWidth } from "./layout.ts"
import { markdown } from "./markdown.ts"
import { type Line, type Role, type Span, span } from "./theme.ts"
import { type NoticeRow, type OutcomeRow, type PendingItem, type ReasoningRow, type Row, type TextRow, type ToolRow, type UserRow, asObject } from "./transcript.ts"

/** Lines of output an expanded call shows before it says how many more there are. */
export const EXPANDED_OUTPUT_LINES = 24
/** Lines of output a fully expanded call shows at most. More than that is in the tool's spill file, or truncated. */
export const FULL_OUTPUT_LINES = 2000

export interface LayoutContext {
  /** The local clock, for the live duration of a running call. */
  readonly now: number
  readonly debug: boolean
  /** Colour is on: inline code is told apart by colour rather than by its backticks. */
  readonly color: boolean
}

const INDENT = "    "

export function layoutRow(row: Row, columns: number, context: LayoutContext): Span[][] {
  switch (row.kind) {
    case "user":
      return userLines(row, columns)
    case "text":
      return textLines(row, columns, context.color)
    case "reasoning":
      return reasoningLines(row, columns)
    case "tool":
      return toolLines(row, columns, context)
    case "notice":
      return noticeLines(row, columns)
    case "outcome":
      return outcomeLines(row, columns)
    case "debug":
      return context.debug ? wrapLine([span(`· event ${row.text}`, "dim")], columns, [span("  ")]).slice(0, 3) : []
  }
}

/** Whether a blank line separates this row from the one before it. */
export function gapBefore(row: Row, previous: Row | null): boolean {
  if (previous === null) return false
  if (row.kind === "debug") return false
  if (row.kind === "user" || row.kind === "outcome") return true
  if (row.kind === "text") return true
  if (row.kind === "reasoning") return previous.kind !== "reasoning"
  const work = (candidate: Row) => candidate.kind === "tool" || candidate.kind === "notice" || candidate.kind === "debug"
  return !work(previous)
}

/** Whether the row's look depends on the clock (a live duration). */
export function isLive(row: Row): boolean {
  return (row.kind === "tool" && row.phase === "running") || (row.kind === "reasoning" && row.streaming)
}

// ---------------------------------------------------------------- user and assistant

function userLines(row: UserRow, columns: number): Span[][] {
  const tag = row.delivered === null ? [] : [span(row.delivered === "steer" ? "  ↳ steered into the turn" : "  ↳ delivered from the queue", "dim")]
  const lines = row.text.split("\n").flatMap((line, index) => wrapLine([span(index === 0 ? "› " : "  ", "accent"), span(line, "user")], columns, [span("  ")]))
  if (tag.length > 0) lines[0] = [...lines[0]!, ...tag]
  return lines
}

function textLines(row: TextRow, columns: number, color: boolean): Span[][] {
  const blocks = markdown(row.text, !color)
  const lines = blocks.flatMap((block) => (block.code ? codeLines(block.spans, block.indent, columns) : wrapLine(block.spans, columns, block.indent)))
  if (row.continuation && lines[0] !== undefined) lines[0] = [span("… ", "dim"), ...lines[0]]
  if (row.streaming) {
    const last = lines.at(-1) ?? []
    lines[Math.max(0, lines.length - 1)] = [...last, span("▍", "dim")]
  }
  return lines
}

/** Code wraps by character with the gutter repeated, so indentation stays readable. */
function codeLines(spans: readonly Span[], indent: readonly Span[], columns: number): Span[][] {
  return wrapLine(spans.map((part) => ({ ...part, text: part.text.replace(/ /g, " ") })), columns, indent).map((line) => line.map((part) => ({ ...part, text: part.text.replace(/ /g, " ") })))
}

function reasoningLines(row: ReasoningRow, columns: number): Span[][] {
  if (row.expanded) {
    const head = [span("∴ ", "dim"), span(row.streaming ? "thinking…" : "thought", "dim", { italic: true })]
    const body = row.text.split("\n").flatMap((line) => wrapLine([span(`  ${line}`, "dim", { italic: true })], columns, [span("  ")]))
    return [head, ...body]
  }
  const excerpt = row.text
    .split("\n")
    .map((line) => line.replace(/\*\*|__|^#+\s*/g, "").trim())
    .find((line) => line !== "")
  const what = row.streaming ? "thinking…" : "thought"
  return [[span(`∴ ${what}`, "dim"), span(excerpt === undefined ? "" : ` · ${truncate(excerpt, Math.max(8, columns - textWidth(`∴ ${what} · `) - 1))}`, "dim")]]
}

// ---------------------------------------------------------------- tools

function toolLines(row: ToolRow, columns: number, context: LayoutContext): Span[][] {
  const head = toolHead(row, columns, context)
  const lines: Span[][] = [head]
  if (row.expand === 0) {
    if (row.phase === "running" && row.progress !== null) {
      const last = row.progress.split("\n").filter((line) => line.trim() !== "").at(-1)
      if (last !== undefined) lines.push([span(`${INDENT}${truncate(last, columns - INDENT.length)}`, "dim")])
    }
    if (row.phase === "settled" && row.outcome === "error") for (const detail of detailLines(row.name, settledData(row)).slice(-3)) lines.push([span(`${INDENT}${truncate(detail, columns - INDENT.length)}`, "dim")])
    return lines
  }
  lines.push(...argumentLines(row, columns))
  lines.push(...outputLines(row, columns))
  return lines
}

function toolHead(row: ToolRow, columns: number, context: LayoutContext): Span[] {
  const name = span(row.name || "tool", undefined, { bold: true })
  const fit = (before: Span[], after: Span[]) => {
    const fixed = textWidth([...before, ...after].map((part) => part.text).join(""))
    const room = Math.max(8, columns - fixed)
    return [...before, span(truncate(row.arg, room)), ...after]
  }
  switch (row.phase) {
    case "writing":
      return [span("▸ ", "accent"), name, span(` · writing arguments… ${plural(row.input.length, "character")}`, "dim")]
    case "called":
      return fit([span("▸ ", "accent"), name, span(row.arg === "" ? "" : " ")], [span(" · waiting to run", "dim")])
    case "running": {
      const elapsed = row.runningSince === null ? "" : ` · ${formatDuration(Math.max(0, context.now - row.runningSince))}`
      return fit([span("⋯ ", "accent"), name, span(row.arg === "" ? "" : " ")], [span(` · running${elapsed}`, "dim")])
    }
    case "settled": {
      const outcome = describeOutcome(row)
      const took = row.startedAt === null || row.settledAt === null ? "" : ` · ${formatDuration(row.settledAt - row.startedAt)}`
      const tail = [span(outcome.text === "" ? "" : ` · ${outcome.text}`, outcome.role === "ok" ? undefined : outcome.role), span(took, "dim")]
      return fit([span(`${outcome.symbol} `, outcome.role), name, span(row.arg === "" ? "" : " ")], tail)
    }
  }
}

function describeOutcome(row: ToolRow): { symbol: string; role: Role; text: string } {
  const data = settledData(row)
  switch (row.outcome) {
    case "success":
      return { symbol: "✓", role: "ok", text: successSummary(row.name, data) }
    case "error":
      return { symbol: "✗", role: "error", text: errorSummary(row.name, data) }
    case "not_started":
      return { symbol: "○", role: "warn", text: "not run · stopped before it started" }
    case "effect_unknown":
      return { symbol: "⚠", role: "warn", text: "outcome unknown · it may have taken effect" }
    case null:
      return { symbol: "?", role: "dim", text: "" }
  }
}

function settledData(row: ToolRow) {
  return {
    messageId: row.messageId,
    callId: row.key.split("/").at(-1) ?? "",
    outcome: row.outcome ?? "error",
    output: row.output,
    truncation: row.truncation,
    attachments: [],
    display: row.display,
  } as unknown as Parameters<typeof successSummary>[1]
}

/** The call's arguments, one per line; long text arguments are summarised (their content is shown as output). */
function argumentLines(row: ToolRow, columns: number): Span[][] {
  const args = parseObject(row.input)
  if (args === null) return row.input.trim() === "" ? [] : wrapLine([span(`${INDENT}args: ${sanitize(row.input)}`, "dim")], columns, [span(INDENT + "  ")]).slice(0, 6)
  const out: Span[][] = []
  for (const [name, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    const lines = sanitize(text).split("\n")
    const shown = lines.length > 1 ? `${lines[0]} … (${plural(lines.length, "line")})` : lines[0]!
    out.push(...wrapLine([span(`${INDENT}${name}: `, "dim"), span(shown)], columns, [span(INDENT + "  ")]).slice(0, 4))
  }
  return out
}

function outputLines(row: ToolRow, columns: number): Span[][] {
  if (row.phase !== "settled") {
    if (row.progress === null) return []
    return tail(row.progress.split("\n"), row.expand === 2 ? FULL_OUTPUT_LINES : EXPANDED_OUTPUT_LINES, columns, "dim")
  }
  if (row.outcome === "not_started" || row.outcome === "effect_unknown") return wrapText([span(`${INDENT}${row.output}`, "dim")], columns, [span(INDENT)])
  const display = asObject(row.display)
  const limit = row.expand === 2 ? FULL_OUTPUT_LINES : EXPANDED_OUTPUT_LINES
  const lines: Span[][] = []
  if (row.name === "edit" && typeof display?.diff === "string") lines.push(...diffLines(display.diff, limit, columns))
  else if (row.name === "write") {
    const content = parseObject(row.input)?.content
    if (typeof content === "string") lines.push(...head(sanitize(content).split("\n"), limit, columns, "added", "+ "))
    else lines.push(...head(row.output.split("\n"), limit, columns, "dim"))
  } else if (row.name === "shell") lines.push(...tail(row.output.split("\n").filter((line) => line !== "(no output)"), limit, columns, "text"))
  else lines.push(...head(row.output.split("\n"), limit, columns, row.outcome === "error" ? "error" : "text"))
  if (row.truncation !== null) {
    const where = row.truncation.spillPath === null ? "" : `: ${row.truncation.spillPath}`
    lines.push(...wrapLine([span(`${INDENT}output capped for the model · ${plural(row.truncation.originalLines, "line")} (${formatBytes(row.truncation.originalBytes)}) in full${where}`, "dim")], columns, [span(INDENT)]))
  }
  return lines
}

/** A unified diff, its added and removed lines marked by sign and colour. */
export function diffLines(diff: string, limit: number, columns: number): Span[][] {
  const source = sanitize(diff).split("\n")
  const stat = diffStat(diff)
  const lines: Span[][] = []
  for (const line of source.slice(0, limit)) {
    const role: Role = line.startsWith("+++") || line.startsWith("---") ? "dim" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "dim"
    lines.push(...wrapLine([span(INDENT), span(line, role)], columns, [span(`${INDENT}  `)]))
  }
  if (source.length > limit) lines.push([span(`${INDENT}… ${plural(source.length - limit, "more line")} (+${stat.added} -${stat.removed}) · Ctrl-O again shows all`, "dim")])
  return lines
}

function head(source: string[], limit: number, columns: number, role: Role, prefix = ""): Span[][] {
  const trimmed = source.at(-1) === "" ? source.slice(0, -1) : source
  const lines = trimmed.slice(0, limit).flatMap((line) => wrapLine([span(`${INDENT}${prefix}`, role === "added" ? "added" : "dim"), span(line, role)], columns, [span(INDENT + " ".repeat(prefix.length))]))
  if (trimmed.length > limit) lines.push([span(`${INDENT}… ${plural(trimmed.length - limit, "more line")} · Ctrl-O again shows all`, "dim")])
  return lines
}

function tail(source: string[], limit: number, columns: number, role: Role): Span[][] {
  const trimmed = source.filter((line, index) => line.trim() !== "" || index < source.length - 1)
  const skipped = Math.max(0, trimmed.length - limit)
  const lines = skipped > 0 ? [[span(`${INDENT}… ${plural(skipped, "earlier line")}${limit < FULL_OUTPUT_LINES ? " · Ctrl-O again shows all" : ""}`, "dim")]] : []
  return [...lines, ...trimmed.slice(skipped).flatMap((line) => wrapLine([span(INDENT), span(line, role)], columns, [span(INDENT)]))]
}

// ---------------------------------------------------------------- notices and outcomes

function noticeLines(row: NoticeRow, columns: number): Span[][] {
  const first = wrapLine([span(`${row.symbol} `, row.tone), ...row.text], columns, [span("  ")])
  const detail = row.detail.flatMap((line) => wrapLine([span("  "), ...line], columns, [span("    ")]))
  return [...first, ...detail]
}

function outcomeLines(row: OutcomeRow, columns: number): Span[][] {
  const parts = [row.steps > 0 ? plural(row.steps, "step") : null, row.durationMs === null ? null : formatDuration(row.durationMs)].filter((part) => part !== null)
  const after = parts.length === 0 ? "" : ` · ${parts.join(" · ")}`
  const lines: Span[][] = []
  const wrapped = (spans: Span[], indent = "  ") => lines.push(...wrapLine(spans, columns, [span(indent)]))
  switch (row.outcome) {
    case "succeeded": {
      const status = row.verification?.status
      if (status === "passed") wrapped([span("✓ ", "ok"), span("done", "ok", { bold: true }), span(" · checks passed", "ok"), span(after, "dim")])
      else if (status === "not_needed") wrapped([span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · checks not needed: nothing they cover changed", "dim"), span(after, "dim")])
      else wrapped([span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · no checks configured", "dim"), span(after, "dim")])
      break
    }
    case "unresolved": {
      const verification = row.verification
      const failing = verification?.status === "unresolved" ? verification.failing.join(", ") : ""
      wrapped([span("✗ ", "error"), span("unresolved", "error", { bold: true }), span(` · failing checks: ${failing}`, "error"), span(after, "dim")])
      if (verification?.status === "unresolved") wrapped([span(`  ${unresolvedReason(verification)}`, "warn")], "    ")
      break
    }
    case "failed":
      wrapped([span("✗ ", "error"), span(row.errorKind === null ? "failed" : `failed (${row.errorKind})`, "error", { bold: true }), span(`: ${row.message ?? ""}`, "error"), span(after, "dim")])
      if (row.requestId !== null) lines.push([span(`  request ${row.requestId}`, "dim")])
      break
    case "interrupted":
      wrapped([span("■ ", "warn"), span("interrupted", "warn", { bold: true }), span(after, "dim")])
      if (row.waiting > 0) lines.push([span(`  ${plural(row.waiting, "message")} still waiting · delivered when work starts again`, "dim")])
      break
    case "shutdown":
      wrapped([span("■ ", "warn"), span("stopped for shutdown", "warn", { bold: true }), span(" · the turn resumes at the next start", "dim")])
      break
  }
  lines.push(...changedLines(row, columns))
  if (row.usage !== null) lines.push([span(`  ${usageText(row.usage, columns - 2)}`, "dim")])
  return lines
}

function changedLines(row: OutcomeRow, columns: number): Span[][] {
  const known = row.changedFiles
  const edited = [...new Set([...row.diffs.keys(), ...row.written])]
  const paths = known ?? edited
  if (paths.length === 0) return []
  const source = known === null ? "edited" : "changed"
  const hint = `${known === null ? " (from its tool calls)" : ""}${row.expanded ? "" : " · Ctrl-O for diffs"}`
  const lines = wrapLine([span(`  ${source} ${plural(paths.length, "file")}: `, "dim"), span(fileList(paths, row.expanded ? paths.length : 6)), span(hint, "dim")], columns, [span("    ")])
  if (!row.expanded) return lines
  for (const path of paths) {
    const diffs = row.diffs.get(path)
    lines.push([span(`  ${path}`, undefined, { bold: true })])
    if (diffs !== undefined) for (const diff of diffs) lines.push(...diffLines(diff, FULL_OUTPUT_LINES, columns))
    else if (row.written.has(path)) lines.push([span(`${INDENT}written whole by the write tool; no diff was reported`, "dim")])
    else lines.push([span(`${INDENT}no diff: changed by a command, or the server does not send per-file diffs for a turn`, "dim")])
  }
  return lines
}

/** The messages admitted while the agent works and not delivered yet, under the conversation. */
export function pendingLines(items: readonly PendingItem[], columns: number): Span[][] {
  return items.flatMap((item) => {
    const queued = item.delivery === "queue"
    const label = queued ? "⏸ queued: " : "↳ steering: "
    const later = queued ? " · after this turn" : " · after the current step"
    const room = Math.max(8, columns - textWidth(label + later) - 2)
    return [[span(label, "mode"), span(`"${truncate(item.text.replace(/\s*\n\s*/g, " ⏎ "), room)}"`), span(later, "dim")]]
  })
}

function parseObject(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export type { Line }
