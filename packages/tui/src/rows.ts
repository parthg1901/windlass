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
import { SUBAGENT_NOTE } from "@windlass/core"
import { LEFT_TO_PARENT, TASK_MARK, TASK_TOOL, UNVERIFIED_HINT, detailLines, diagnosticsSummary, diffStat, hookCallLines, hookRefusal, objectionTexts, unsatisfiedText, errorSummary, fileList, formatBytes, formatDuration, requestsText, successSummary, tasksOf, tasksProgress, unresolvedReason, usageText } from "./cli.ts"
import { truncate, wrapLine, wrapText, plural, sanitize, width as textWidth } from "./layout.ts"
import { markdown } from "./markdown.ts"
import type { DiffFile } from "@windlass/acp/extensions"
import { type Line, type Role, type Span, span } from "./theme.ts"
import { type NoticeRow, type OutcomeRow, type PendingItem, type ReasoningRow, type Row, type SubagentView, type TextRow, type ToolRow, type UserRow, asObject, isUndoneRow } from "./transcript.ts"

/** Lines of output an expanded call shows before it says how many more there are. */
export const EXPANDED_OUTPUT_LINES = 24
/** Lines of output a fully expanded call shows at most. More than that is in the tool's spill file, or truncated. */
export const FULL_OUTPUT_LINES = 2000
/** Lines of a subagent's own work an expanded `subagent` row shows (its latest), before a second expansion shows all of it. */
export const SUBAGENT_LINES = 40

export interface LayoutContext {
  /** The local clock, for the live duration of a running call. */
  readonly now: number
  readonly debug: boolean
  /** Colour is on: inline code is told apart by colour rather than by its backticks. */
  readonly color: boolean
  /** Rows inside a subagent's row: they cannot be selected, so they offer no keys. */
  readonly nested?: boolean
}

const INDENT = "    "

export function layoutRow(row: Row, columns: number, context: LayoutContext): Span[][] {
  // A turn `/undo` took out of the conversation is one dim line where its prompt was; the rest of it is not shown.
  if (isUndoneRow(row)) {
    if (row.kind !== "user") return []
    // A steer is drawn undone only where an undo went back to (the latest one that took it out): inside a turn
    // that was undone whole, the turn's own line says it.
    if (row.delivered === "steer") return row.cutBy.has(Math.max(...row.undoneBy)) ? undoneLines(row, columns) : []
    return undoneLines(row, columns)
  }
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
      return outcomeLines(row, columns, context.nested === true)
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
  const command = row.command
  // A command file's message is shown as it was typed; the text it stands for is under it when expanded.
  // A line of the message that starts indented (a quote in a review, a list) goes on under its own text when it wraps.
  const own = (line: string) => Math.min(line.length - line.trimStart().length, Math.floor(columns / 3))
  const lines = (command?.typed ?? row.text).split("\n").flatMap((line, index) => wrapLine([span(index === 0 ? "› " : "  ", "accent"), span(line, "user")], columns, [span(" ".repeat(2 + own(line)))]))
  if (command !== null) {
    lines.push(...wrapLine([span(`  ${command.head} · ${command.where}: `, "dim"), span(command.path, "dim")], columns, [span("    ")]))
    for (const note of command.notes) lines.push(...wrapLine([span("  ⚠ ", "warn"), span(note, "warn")], columns, [span("    ")]))
    if (row.expanded) lines.push(...row.text.split("\n").flatMap((line) => wrapLine([span("  │ ", "dim"), span(line)], columns, [span("  │ ", "dim")])))
  }
  if (row.delivered === null) return lines
  // How it reached the agent: after the message's last line when it fits there, otherwise on a line of its own; never cut.
  const tag = row.delivered === "steer" ? "↳ steered into the turn" : "↳ delivered from the queue"
  const last = lines.at(-1)!
  if (textWidth(last.map((part) => part.text).join("")) + 2 + textWidth(tag) <= columns) lines[lines.length - 1] = [...last, span(`  ${tag}`, "dim")]
  else lines.push([span(`  ${tag}`, "dim")])
  return lines
}

function undoneLines(row: UserRow, columns: number): Span[][] {
  const head = row.delivered === "steer" ? "↶ undone steer: " : `↶ undone${row.turn === null ? "" : ` turn ${row.turn}`}: `
  const text = (row.command?.typed ?? row.text).split("\n").find((line) => line.trim() !== "") ?? ""
  // The prompt comes first; the explanation is shortened before it is.
  const want = Math.min(textWidth(text), 30)
  const tail = [" · out of the conversation · /redo brings it back", " · /redo brings it back", ""].find((candidate) => columns - textWidth(head) - textWidth(candidate) - 2 >= want) ?? ""
  const room = Math.max(8, columns - textWidth(head) - textWidth(tail) - 2)
  return [[span(head, "dim"), span(`"${truncate(text, room)}"`, "dim"), span(tail, "dim")]]
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
  // A program's calls are drawn under its row, a step in.
  if (row.parent !== null) return callLines(row, columns - 2, context).map((line) => [span("  "), ...line])
  return callLines(row, columns, context)
}

/** A program's lines under its row: at most `PROGRAM_ROWS` collapsed, all of them expanded. */
const PROGRAM_ROWS = 6
function programRows(row: ToolRow, columns: number): Span[][] {
  if (row.name !== "run_code") return []
  let code = ""
  try {
    const input = JSON.parse(row.input) as { code?: unknown }
    code = typeof input.code === "string" ? input.code.replace(/\s+$/, "") : ""
  } catch {
    return []
  }
  if (code === "") return []
  const lines = code.split("\n")
  const shown = row.expand === 0 && lines.length > PROGRAM_ROWS ? [...lines.slice(0, PROGRAM_ROWS - 1), `… ${lines.length - PROGRAM_ROWS + 1} more lines`] : lines
  return shown.map((line) => [span(`  │ ${truncate(line, columns - 4)}`, "dim")])
}

function callLines(row: ToolRow, columns: number, context: LayoutContext): Span[][] {
  // The model's task list is shown as the list, not as a call (expanded, it is the call like any other).
  if (row.name === TASK_TOOL && row.expand === 0) {
    const tasks = taskListLines(row, columns)
    if (tasks !== null) return tasks
  }
  const head = toolHead(row, columns, context)
  const lines: Span[][] = [head, ...programRows(row, columns)]
  if (row.subagent !== null) return [head, ...subagentLines(row, row.subagent, columns, context)]
  if (row.expand === 0) {
    if (row.phase === "running" && row.progress !== null) {
      const last = row.progress.split("\n").filter((line) => line.trim() !== "").at(-1)
      if (last !== undefined) lines.push([span(`${INDENT}${truncate(last, columns - INDENT.length)}`, "dim")])
    }
    const approval = row.approval
    if (approval?.state === "declined" && approval.note !== null) lines.push(...wrapLine([span(`${INDENT}your note to the agent: `, "dim"), span(approval.note)], columns, [span(INDENT)]))
    else if (approval?.state === "declined") lines.push([span(`${INDENT}the agent was told you declined`, "dim")])
    else if (approval?.state === "denied" && approval.reason === "unattended")
      lines.push(...wrapLine([span(`${INDENT}it needs ${approval.needs.join(", ")}${approval.stop ? "; the run ends here" : ""}`, "warn")], columns, [span(INDENT)]))
    // The agent's rule, whole, in the engine's sentence for the user, instead of the text the model was given.
    else if (approval?.state === "denied" && approval.refusal != null) return [...lines, ...wrapLine([span(`${INDENT}${approval.refusal.reason}`)], columns, [span(INDENT)])]
    // A hook kept the call from running: its reason, in a few whole lines, instead of the text the model was given.
    else if (hookRefused(row) !== null) {
      const reason = hookRefused(row)!.reason
      if (reason !== null) lines.push(...clip(wrapLine([span(`${INDENT}${reason}`)], columns, [span(INDENT)]), HOOK_TEXT_ROWS))
    }
    else if (row.phase === "settled" && row.outcome === "error") for (const detail of detailLines(row.name, settledData(row)).slice(-3)) lines.push([span(`${INDENT}${truncate(detail, columns - INDENT.length)}`, "dim")])
    // A call that cannot be stopped midway (a read, one write) finished after the user asked it to stop.
    if (row.stopAsked && row.phase === "settled" && row.outcome === "success") lines.push([span(`${INDENT}it could not be stopped midway and finished: this is its result`, "warn")])
    lines.push(...hookLines(row, columns))
    return lines
  }
  lines.push(...argumentLines(row, columns))
  lines.push(...runLines(row, columns))
  lines.push(...hookLines(row, columns))
  lines.push(...outputLines(row, columns))
  return lines
}

/**
 * A `todo` call as the checklist it left: how far the list is, then every
 * task with its mark (done, in progress, pending). `null` while the call has
 * no list to show (it failed, or was not run): then it is a call like any other.
 */
function taskListLines(row: ToolRow, columns: number): Span[][] | null {
  const head = (text: string) => [span("≡ ", "accent"), span("tasks", undefined, { bold: true }), span(` · ${text}`, "dim")]
  if (row.phase !== "settled") return [head("updating…")]
  const tasks = row.outcome === "success" ? tasksOf(row.display) : null
  if (tasks === null) return null
  return [
    head(tasksProgress(tasks)),
    ...tasks.flatMap((task) =>
      wrapLine([span(`  ${TASK_MARK[task.status]} `, task.status === "done" ? "ok" : task.status === "in_progress" ? "accent" : "dim"), span(task.text, task.status === "done" ? "dim" : undefined, task.status === "in_progress" ? { bold: true } : undefined)], columns, [span("    ")]),
    ),
  ]
}

/**
 * A `subagent` call. Collapsed: one line of what its subagent is doing (or
 * that it asks you something, or how it ended). Expanded: its own
 * conversation, from its forwarded events, laid out as any session's rows
 * are, under a rule: its task, its steps and tool calls, its answer; the
 * latest `SUBAGENT_LINES` of it, all of it on a second expansion.
 */
function subagentLines(row: ToolRow, view: SubagentView, columns: number, context: LayoutContext): Span[][] {
  const rows = view.transcript.rows
  const tools = rows.filter((candidate): candidate is ToolRow => candidate.kind === "tool")
  const steps = view.steps
  const counted = `${plural(steps, "step")}, ${plural(tools.length, "tool call")}`
  const where = view.background ? "in the background · " : ""
  const status = (): Span[] => {
    if (view.asking) return [span(`${INDENT}↳ `, "warn"), span("it asks you something: answer below", "warn")]
    switch (view.state) {
      case "running": {
        if (steps === 0 && tools.length === 0) return [span(`${INDENT}↳ ${where}starting`, "dim")]
        const current = tools.findLast((candidate) => candidate.phase !== "settled") ?? tools.at(-1)
        const now = current === undefined ? "starting" : `${current.phase === "settled" ? "last" : "now"}: ${current.name} ${current.arg}`.trim()
        return [span(`${INDENT}↳ ${where}${counted} · ${now}`, "dim")]
      }
      case "completed":
        // A session opened again knows the subagent only from its parent's log: its work is read on expansion.
        if (rows.length === 0) return [span(`${INDENT}↳ ${where}finished · expand to read its work`, "dim")]
        return [span(`${INDENT}↳ ${where}finished after ${counted}`, "dim")]
      default:
        if (rows.length === 0) return [span(`${INDENT}↳ ${where}${view.state}${view.detail === null ? "" : ` · ${view.detail}`} · expand to read its work`, "warn")]
        return [span(`${INDENT}↳ ${where}${view.state} after ${counted}${view.detail === null ? "" : ` · ${view.detail}`}`, "warn")]
    }
  }
  if (row.expand === 0) return wrapLine(status(), columns, [span(INDENT + "  ")]).slice(0, 2)
  const inner = Math.max(20, columns - 4)
  const bar = [span("  │ ", "dim")]
  const body: Span[][] = []
  let previous: Row | null = null
  for (const child of rows) {
    // The task as the user gave it, without the harness's note to the subagent; and no key hint the nested rows cannot take.
    const shown = child.kind === "user" ? { ...child, text: child.text.replace(SUBAGENT_NOTE, "").trimEnd() } : child
    const laid = layoutRow(shown, inner, { ...context, nested: true })
    if (laid.length === 0) continue
    if (gapBefore(child, previous)) body.push([])
    body.push(...laid)
    previous = child
  }
  const limit = row.expand === 2 ? FULL_OUTPUT_LINES : SUBAGENT_LINES
  const shown = body.length > limit ? [[span(`… ${plural(body.length - limit, "earlier line")}${row.expand === 2 ? "" : " (expand again for all)"}`, "dim")], ...body.slice(-limit)] : body
  const framed = shown.map((line) => [...bar, ...line])
  if (framed.length === 0) framed.push([...bar, span("nothing yet", "dim")])
  // A subagent that ended has its own ending row inside the frame; the line under it would only say it again.
  const ended = view.state !== "running" && !view.asking && rows.at(-1)?.kind === "outcome"
  return ended ? framed : [...framed, ...wrapLine(status(), columns, [span(INDENT + "  ")]).slice(0, 2)]
}

/** Expanded: how the call ran, and the question it was asked under. */
function runLines(row: ToolRow, columns: number): Span[][] {
  const lines: Span[][] = []
  const sandbox = row.sandbox
  if (sandbox !== undefined)
    lines.push(
      ...wrapLine(
        sandbox === null
          ? [span(`${INDENT}ran without the sandbox`, "warn")]
          : [span(`${INDENT}ran in the sandbox ${SANDBOX_MARK}`, "dim"), span(sandbox.network ? " · with network access" : " · no network", sandbox.network ? "warn" : "dim"), span(sandbox.writableRoots.length === 0 ? "" : ` · could also write ${sandbox.writableRoots.join(", ")}`, "warn")],
        columns,
        [span(INDENT + "  ")],
      ),
    )
  const approval = row.approval
  if (approval !== null && approval.state !== "denied" && approval.title !== "") lines.push(...wrapLine([span(`${INDENT}asked: ${approval.title}`, "dim")], columns, [span(INDENT + "  ")]))
  return lines
}

/**
 * How the result of an MCP call begins. Its output starts with a line of the harness's for the model (which tool
 * it came from, and that it is not the user's word); on the row that line would take all the room and say nothing
 * the row does not, so the row shows the result's own first line. `null`: the output is not in that form.
 */
export function mcpResultStart(output: string): string | null {
  const lines = output.split("\n")
  if (!/^Result of MCP tool \S+.*:$/.test(lines[0] ?? "")) return null
  const first = lines.slice(1).find((line) => line.trim() !== "")
  return first === undefined ? "an empty result" : first.trim()
}

/** The fewest columns a tool row's argument is given before the end of the row says less. */
const MIN_ARGUMENT = 16

function toolHead(row: ToolRow, columns: number, context: LayoutContext): Span[] {
  // A subagent's row names the agent it runs as: its instructions and what it may do are that agent's.
  const name = span(`${row.name || "tool"}${row.subagent?.agent == null ? "" : ` (${row.subagent.agent})`}`, undefined, { bold: true })
  const fit = (before: Span[], after: Span[]) => {
    const fixed = textWidth([...before, ...after].map((part) => part.text).join(""))
    const room = Math.max(8, columns - fixed)
    return [...before, span(truncate(row.arg, room)), ...after]
  }
  switch (row.phase) {
    case "writing":
      return [span("▸ ", "accent"), name, span(` · writing arguments… ${plural(row.input.length, "character")}`, "dim")]
    case "called":
      if (row.approval?.state === "asked" && row.approval.live) return fit([span("? ", "warn", { bold: true }), name, span(row.arg === "" ? "" : " ")], [span(" · waiting for your approval", "warn")])
      return fit([span("▸ ", "accent"), name, span(row.arg === "" ? "" : " ")], [span(" · waiting to run", "dim")])
    case "running": {
      const elapsed = row.runningSince === null ? "" : ` · ${formatDuration(Math.max(0, context.now - row.runningSince))}`
      // Asked to stop by the user (this call only): it says so until its tool has stopped.
      if (row.stopAsked) return fit([span("■ ", "warn"), name, span(row.arg === "" ? "" : " ")], [...sandboxMark(row), span(` · stopping${elapsed}`, "warn")])
      return fit([span("⋯ ", "accent"), name, span(row.arg === "" ? "" : " ")], [...sandboxMark(row), span(` · running${elapsed}`, "dim")])
    }
    case "settled": {
      const outcome = describeOutcome(row)
      const took = row.startedAt === null || row.settledAt === null ? "" : ` · ${formatDuration(row.settledAt - row.startedAt)}`
      // What the language servers said about an edit: how many new diagnostics its note lists, and from which server.
      const diagnosed = diagnosticsSummary(row.diagnostics ?? undefined)
      const before = [span(`${outcome.symbol} `, outcome.role), name, span(row.arg === "" ? "" : " ")]
      const tailOf = (withTime: boolean, brief: boolean) => [...sandboxMark(row), span(outcome.text === "" ? "" : ` · ${outcome.text}`, outcome.role === "ok" ? undefined : outcome.role), ...(diagnosed === null ? [] : [span(` · ${diagnosed}`, "warn")]), ...approvalMark(row, brief), span(withTime ? took : "", "dim")]
      // On a narrow row the time goes first, then the approval in fewer words: the outcome is never cut for the argument.
      const roomFor = (tail: Span[]) => columns - textWidth([...before, ...tail].map((part) => part.text).join(""))
      const tail = [tailOf(true, false), tailOf(false, false), tailOf(false, true)].find((candidate) => roomFor(candidate) >= MIN_ARGUMENT) ?? tailOf(false, true)
      return fit(before, tail)
    }
  }
}

/** The glyph a sandboxed command carries on its row. */
export const SANDBOX_MARK = "⊡"

/**
 * How a command ran, kept small: `⊡` in the sandbox, with the extra access
 * spelled out when it had any (`⊡ +network`, `⊡ +write /opt/cache`); a
 * command that ran without the sandbox says so in words.
 */
function sandboxMark(row: ToolRow): Span[] {
  const sandbox = row.sandbox
  if (sandbox === undefined) return []
  if (sandbox === null) return row.name === "shell" ? [span(" · no sandbox", "warn")] : []
  const extra = [sandbox.network ? "+network" : null, ...sandbox.writableRoots.map((root) => `+write ${root}`)].filter((part) => part !== null)
  return [span(` ${SANDBOX_MARK}${extra.length === 0 ? "" : ` ${extra.join(" ")}`}`, extra.length === 0 ? "dim" : "warn")]
}

/** How the call's approval question was answered, when it was asked. */
function approvalMark(row: ToolRow, brief = false): Span[] {
  const approval = row.approval
  if (approval?.state !== "allowed") return []
  const how = brief ? "allowed" : approval.choice === "session" ? "allowed for the session" : approval.choice === "project" ? "allowed in this project" : "allowed once"
  return [span(` · ${how}`, "dim"), ...(approval.note === null ? [] : [span(` · your note: ${approval.note}`, "dim")])]
}

function describeOutcome(row: ToolRow): { symbol: string; role: Role; text: string } {
  const data = settledData(row)
  const approval = row.approval
  // The user stopped this one call and the turn went on: not a failure, and what it had printed is under the row.
  if (row.stopAsked && row.outcome !== "success") return { symbol: "■", role: "warn", text: row.outcome === "effect_unknown" ? "stopped by you · it may have taken effect" : "stopped by you" }
  if (approval?.state === "declined") return { symbol: "⊘", role: "warn", text: "not allowed by you" }
  if (approval?.state === "denied" && approval.refusal != null) return { symbol: "⊘", role: "warn", text: approval.refusal.head }
  if (approval?.state === "denied") return { symbol: "⊘", role: "warn", text: approval.reason === "policy" ? "refused by the approval policy" : "refused: nobody was there to approve it" }
  // A before hook kept the call from running: the hook's name, instead of the text the model was given.
  const refused = hookRefused(row)
  if (refused !== null) return { symbol: "⊘", role: "warn", text: refused.head }
  switch (row.outcome) {
    case "success":
      return { symbol: "✓", role: "ok", text: (row.name === "mcp_call" ? mcpResultStart(data.output) : null) ?? successSummary(row.name, data) }
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

/** The rows of what a hook said (its reason, its note, what it printed) under a call; expanding the call shows its whole result. */
const HOOK_TEXT_ROWS = 4

/** At most `rows` lines; the last one says that there is more. */
function clip(lines: Span[][], rows: number): Span[][] {
  if (lines.length <= rows) return lines
  return [...lines.slice(0, rows - 1), [...lines[rows - 1]!, span(" …", "dim")]]
}

/** The refusal of a call a before hook kept from running, or `null`. */
function hookRefused(row: ToolRow) {
  return row.phase === "settled" && row.outcome === "error" ? hookRefusal(row.hooks, row.startedAt !== null, row.output) : null
}

/** Under a settled call: a note a hook added to its result, a hook that could not answer, what a hook printed for the user. */
function hookLines(row: ToolRow, columns: number): Span[][] {
  if (row.phase !== "settled") return []
  return hookCallLines(row.hooks, row.startedAt !== null, row.hookFailures).flatMap((said) => clip(wrapLine([span(`${INDENT}${said.text}`, said.tone)], columns, [span(INDENT)]), HOOK_TEXT_ROWS))
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
  // A detail line's own indentation is kept when it wraps: its rows go on two columns further in than it starts.
  const detail = row.detail.flatMap((line) => {
    const own = (line[0]?.text ?? "").length - (line[0]?.text ?? "").trimStart().length
    return wrapLine([span("  "), ...line], columns, [span(" ".repeat(4 + own))])
  })
  return [...first, ...detail]
}

function outcomeLines(row: OutcomeRow, columns: number, nested = false): Span[][] {
  const parts = [row.steps + row.summaryCalls > 0 ? requestsText(row.steps, row.summaryCalls) : null, row.durationMs === null ? null : formatDuration(row.durationMs), nested || row.turn === null ? null : `turn\u00a0${row.turn}`].filter((part) => part !== null)
  // A queued message waited for this turn's answer: the next rows are that message and its own turn.
  if (row.continues) parts.push("on to the queued message")
  const after = parts.length === 0 ? "" : ` · ${parts.join(" · ")}`
  const lines: Span[][] = []
  const wrapped = (spans: Span[], indent = "  ") => lines.push(...wrapLine(spans, columns, [span(indent)]))
  // What each stop hook said when the turn ended with it unsatisfied: a few whole lines each, under the ending.
  const said = () => {
    for (const text of objectionTexts(row.objections)) lines.push(...clip(wrapLine([span(`  ${text}`)], columns, [span("  ")]), HOOK_TEXT_ROWS))
  }
  switch (row.outcome) {
    case "succeeded": {
      const status = row.verification?.status
      // Stop hooks still objected after the agent was sent back as often as a turn allows: its own kind of ending.
      if (row.unsatisfied !== null) {
        const basis = status === "passed" ? "checks passed" : status === "not_needed" ? "nothing to check" : status === "left_to_parent" ? LEFT_TO_PARENT : "no checks configured"
        wrapped([span("⚠ ", "warn"), span(unsatisfiedText(row.unsatisfied), "warn", { bold: true }), span(` · ${basis}`, "dim"), span(after, "dim")])
        said()
        if (row.verification?.status === "not_needed" && row.verification.unverified === true) wrapped([span(`  ${UNVERIFIED_HINT}`, "warn")], "    ")
      } else if (status === "passed") wrapped([span("✓ ", "ok"), span("done", "ok", { bold: true }), span(" · checks passed", "ok"), span(after, "dim")])
      else if (row.verification?.status === "not_needed" && row.verification.unverified === true) {
        // Files the checks cover changed outside this turn: not checked now, and when they will be.
        wrapped([span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · nothing to check", "dim"), span(after, "dim")])
        wrapped([span(`  ${UNVERIFIED_HINT}`, "warn")], "    ")
      } else if (status === "not_needed") wrapped([span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · checks not needed: nothing they cover changed", "dim"), span(after, "dim")])
      else if (status === "left_to_parent") wrapped([span("○ ", "ok"), span("done", "ok", { bold: true }), span(` · ${LEFT_TO_PARENT}`, "dim"), span(after, "dim")])
      else wrapped([span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · no checks configured", "dim"), span(after, "dim")])
      break
    }
    case "unresolved": {
      const verification = row.verification
      const failing = verification?.status === "unresolved" ? verification.failing.join(", ") : ""
      wrapped([span("✗ ", "error"), span("unresolved", "error", { bold: true }), span(` · failing checks: ${failing}`, "error"), span(after, "dim")])
      if (verification?.status === "unresolved") wrapped([span(`  ${unresolvedReason(verification)}`, "warn")], "    ")
      if (row.unsatisfied !== null) {
        wrapped([span(`  ⚠ it also ${unsatisfiedText(row.unsatisfied)}`, "warn")], "    ")
        said()
      }
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
  lines.push(...changedLines(row, columns, nested))
  if (row.usage !== null) lines.push([span(`  ${usageText(row.usage, columns - 2)}`, "dim")])
  return lines
}

function changedLines(row: OutcomeRow, columns: number, nested: boolean): Span[][] {
  const known = row.changedFiles
  const edited = [...new Set([...row.diffs.keys(), ...row.written])]
  const server = row.serverDiff !== null && row.serverDiff !== "loading" && row.serverDiff.available ? row.serverDiff : null
  const paths = server?.files.map((file) => file.path) ?? known ?? edited
  if (paths.length === 0) return []
  const source = server === null && known === null ? "edited" : "changed"
  const hint = `${server === null && known === null ? " (from its tool calls)" : ""}${row.expanded || nested ? "" : " · Ctrl-O\u00a0for\u00a0diffs"}`
  const lines = wrapLine([span(`  ${source} ${plural(paths.length, "file")}: `, "dim"), span(fileList(paths, row.expanded ? paths.length : 6)), span(hint, "dim")], columns, [span("    ")])
  if (!row.expanded) return lines
  if (row.serverDiff === "loading") lines.push([span(`${INDENT}loading the per-file diffs…`, "dim")])
  else if (row.serverDiff !== null && !row.serverDiff.available) lines.push(...wrapLine([span(`${INDENT}per-file diffs are not available: ${row.serverDiff.message}`, "dim")], columns, [span(INDENT)]))
  if (server !== null) {
    for (const file of server.files) lines.push(...fileDiffLines(file, FULL_OUTPUT_LINES, columns))
    return lines
  }
  for (const path of paths) {
    const diffs = row.diffs.get(path)
    lines.push([span(`  ${path}`, undefined, { bold: true })])
    if (diffs !== undefined) for (const diff of diffs) lines.push(...diffLines(diff, FULL_OUTPUT_LINES, columns))
    else if (row.written.has(path)) lines.push([span(`${INDENT}written whole by the write tool; no diff was reported`, "dim")])
    else lines.push([span(`${INDENT}no diff from its tool calls: changed by a command`, "dim")])
  }
  return lines
}

/** One file of a server diff: its path and status, then its patch, or why there is none. */
export function fileDiffLines(file: DiffFile, limit: number, columns: number): Span[][] {
  const status = file.status === "added" ? "new file" : file.status === "deleted" ? "deleted" : file.status === "modified" ? "" : file.status.replace(/_/g, " ")
  const stat = file.binary || file.patch === null ? "" : `+${file.added} -${file.removed}`
  const about = [status, stat].filter((part) => part !== "").join(" · ")
  const lines: Span[][] = [[span(`  ${file.path}`, undefined, { bold: true }), span(about === "" ? "" : ` · ${about}`, "dim")]]
  if (file.binary) lines.push([span(`${INDENT}binary file: no diff shown`, "dim")])
  else if (file.omitted) lines.push([span(`${INDENT}not shown: the diff of this turn is too large (the patch budget ran out before this file)`, "dim")])
  else if (file.patch === null) lines.push([span(`${INDENT}no patch`, "dim")])
  else {
    // The `diff --git` and index headers say nothing the line above does not.
    const body = file.patch.replace(/\n+$/, "").split("\n").filter((line) => !/^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity |rename )/.test(line))
    lines.push(...diffLines(body.join("\n"), limit, columns))
    if (file.truncated) lines.push([span(`${INDENT}… cut: the change to this file is larger than the per-file limit`, "dim")])
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
