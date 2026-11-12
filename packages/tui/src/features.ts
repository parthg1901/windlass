/**
 * The TUI's side of the features the engine runs for a session: the lines of
 * `/mcp`, `/hooks`, `/lsp`, `/skills`, `/wakeups` and `/memory` (the line
 * CLI's words, in the TUI's theme), and the question about an MCP server, a
 * hook or a language server a project's configuration names as an approval
 * the dock can show.
 */
import type { ApprovalAsk } from "@windlass/acp/client"
import { type HookInfo, type LspServerInfo, type McpServerInfo, type PlannedChange, handEditSentences } from "@windlass/acp/extensions"
import { shownCommand } from "./cli.ts"
import { type Line, hookNotNow, hookQuestionParts, lspNotNow, lspQuestionTitle } from "./cli.ts"
import { splitArguments } from "../../core/src/commands/expand.ts"
import { sanitize, truncate } from "./layout.ts"
import { type Role, type Span, span } from "./theme.ts"

const ROLES: Record<Line["tone"], Role | undefined> = { plain: undefined, dim: "dim", warn: "warn", error: "error", ok: "ok", bold: undefined, accent: "accent" }

/** Lines as a note: the first is its heading, the rest its detail, indented as the line CLI indents them. */
export function noteOf(lines: readonly Line[]): { readonly head: Span[]; readonly detail: Span[][] } {
  const [first, ...rest] = inRows(lines)
  const spanOf = (line: Line, base = 0) => [span(`${" ".repeat(Math.max(0, (line.indent ?? 0) - base))}${line.text}`, ROLES[line.tone], line.tone === "bold" ? { bold: true } : undefined)]
  return { head: first === undefined ? [] : spanOf(first), detail: rest.map((line) => spanOf(line, 2)) }
}

/**
 * The line CLI gives a path a line of its own, because it never cuts or
 * breaks one; here a row wraps, so a path goes back beside what it belongs
 * to: after the label before it (`defined in your file: /path`), or before
 * what is said about it on the next line (`/path: not loaded: ...`).
 */
export function inRows(lines: readonly Line[]): Line[] {
  const rows: Line[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const before = rows.at(-1)
    const after = lines[index + 1]
    if (line.path !== true) rows.push(line)
    else if (after !== undefined && after.path !== true && (after.indent ?? 0) > (line.indent ?? 0)) {
      rows.push({ ...line, text: `${line.text}: ${after.text}`, path: false })
      index += 1
    } else if (before !== undefined && before.path !== true && before.text.endsWith(":") && (before.indent ?? 0) <= (line.indent ?? 0)) rows[rows.length - 1] = { ...before, text: `${before.text} ${line.text}` }
    else rows.push(line)
  }
  return rows
}

/** The ID the dock knows a server's question by. */
export function mcpAskId(server: McpServerInfo): string {
  return `mcp-server:${server.name}:${server.question?.fingerprint ?? ""}`
}

/**
 * The question about a server the project's configuration names, as an
 * approval for the dock: the engine's own subject and details, where it is
 * defined, and two answers that say what they do.
 */
export function mcpServerAsk(sessionId: string, server: McpServerInfo): ApprovalAsk {
  const question = server.question
  return {
    sessionId,
    toolCallId: mcpAskId(server),
    messageId: "",
    callId: "",
    question: {
      title: `Start the MCP server "${server.name}" that this project's configuration names?`,
      subject: shownCommand(server.argv, question?.subject ?? server.target ?? server.name),
      details: [...(server.file === null ? [] : [`Defined in ${server.file}.`]), ...(question?.details ?? [])],
      choices: [
        { id: "once", label: "Start it for this project", approve: true, remembers: "that, for 30 days, for exactly this definition" },
        { id: "deny", label: `Not now: it stays stopped (/mcp approve ${server.name} asks again)`, approve: false, remembers: null },
      ],
    },
    needs: [],
    then: { kind: "run" },
    subagent: null,
    subagentSessionId: null,
  }
}

/** The ID the dock knows a hook's question by: exactly this definition of it. */
export function hookAskId(hook: HookInfo): string {
  return `hook:${hook.fingerprint}`
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/**
 * The question about a hook the project's configuration names, as an
 * approval for the dock: the engine's own first sentence as the title, the
 * command word for word as the subject, the engine's other sentences (what
 * it applies to, how it runs) and where it is defined as the details, and
 * two answers that say what they do.
 */
export function hookAsk(sessionId: string, hook: HookInfo): ApprovalAsk {
  const question = hookQuestionParts(hook)
  return {
    sessionId,
    toolCallId: hookAskId(hook),
    messageId: "",
    callId: "",
    question: {
      title: `${question.title}:`,
      subject: question.command,
      details: [...question.details, ...(hook.file === null ? [] : [`Defined in ${hook.file}.`])],
      choices: [
        { id: "once", label: "Allow it for this project", approve: true, remembers: "that, for 30 days, for exactly this definition" },
        { id: "deny", label: sentence(hookNotNow(hook)), approve: false, remembers: null },
      ],
    },
    needs: [],
    then: { kind: "run" },
    subagent: null,
    subagentSessionId: null,
  }
}

/** The ID the dock knows a language server's question by. */
export function lspAskId(server: LspServerInfo): string {
  return `lsp-server:${server.name}:${server.question?.fingerprint ?? ""}`
}

/** The question about a language server the project's configuration names, as an approval for the dock: the engine's own subject and details. */
export function lspServerAsk(sessionId: string, server: LspServerInfo): ApprovalAsk {
  const question = server.question
  return {
    sessionId,
    toolCallId: lspAskId(server),
    messageId: "",
    callId: "",
    question: {
      title: lspQuestionTitle(server),
      subject: shownCommand(server.argv, question?.subject ?? server.command),
      details: [...(server.file === null ? [] : [`Defined in ${server.file}.`]), ...(question?.details ?? [])],
      choices: [
        { id: "once", label: "Allow it for this project", approve: true, remembers: "that, for 30 days, for exactly this definition" },
        { id: "deny", label: sentence(lspNotNow(server)), approve: false, remembers: null },
      ],
    },
    needs: [],
    then: { kind: "run" },
    subagent: null,
    subagentSessionId: null,
  }
}

/**
 * What a command's row says about the arguments that were typed after its
 * name and that its template has no place for (`command.expanded.unused`,
 * their positions): which ones, as typed, and that they are not in the
 * message. `null` when every argument was used.
 */
export function unusedArgumentsNote(use: { readonly arguments: string; readonly unused: readonly number[] }): string | null {
  if (use.unused.length === 0) return null
  const typed = splitArguments(use.arguments).arguments
  const quoted = use.unused.map((position) => typed[position - 1]).filter((argument) => argument !== undefined).map((argument) => `"${truncate(sanitize(argument), 40)}"`)
  const which = `${use.unused.length === 1 ? "argument" : "arguments"} ${use.unused.join(", ")}${quoted.length === use.unused.length ? ` (${quoted.join(", ")})` : ""}`
  return use.unused.length === 1 ? `${which} was not used: the command file has no place for it, so it is not in the text that was sent` : `${which} were not used: the command file has no place for them, so they are not in the text that was sent`
}

/** What is said of a file an undo or a redo asks about because it changed while a command or the checks of this session ran and no tool call named it (`editedBy: unknown`). */
export const CHANGED_DURING_COMMAND = "changed while a command ran"

/**
 * The files an undo or a redo asks about before it overwrites them, one
 * sentence per kind of change: the shared sentences for a change by the user
 * or another program and for one made while another session worked; and for
 * a file that changed while this session's own command or checks ran,
 * without a call naming it, that it changed then, and that it may be the
 * command's own work or the user's.
 */
export function handEditLines(changes: readonly PlannedChange[], since: string): string[] {
  const during = changes.filter((change) => change.handEdited && (change.editedBy ?? { kind: "unknown" }).kind === "unknown")
  const known = handEditSentences(changes.filter((change) => !during.includes(change)), since)
  if (during.length === 0) return known
  return [...known, `${during.length === 1 ? "1 file" : `${during.length} files`} ${CHANGED_DURING_COMMAND} (or the checks), which may be the command's own work or yours: ${during.map((change) => change.path).join(", ")}`]
}
