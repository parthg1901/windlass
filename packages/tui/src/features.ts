/**
 * The TUI's side of the features the engine runs for a session: the lines of
 * `/mcp`, `/skills`, `/wakeups` and `/memory` (the line CLI's words, in the
 * TUI's theme), and the question about a project's MCP server as an approval
 * the dock can show.
 */
import type { ApprovalAsk } from "@light-harness/acp/client"
import type { McpServerInfo } from "@light-harness/acp/extensions"
import type { Line } from "./cli.ts"
import { type Role, type Span, span } from "./theme.ts"

const ROLES: Record<Line["tone"], Role | undefined> = { plain: undefined, dim: "dim", warn: "warn", error: "error", ok: "ok", bold: undefined, accent: "accent" }

/** Lines as a note: the first is its heading, the rest its detail, indented as the line CLI indents them. */
export function noteOf(lines: readonly Line[]): { readonly head: Span[]; readonly detail: Span[][] } {
  const [first, ...rest] = lines
  const spanOf = (line: Line, base = 0) => [span(`${" ".repeat(Math.max(0, (line.indent ?? 0) - base))}${line.text}`, ROLES[line.tone], line.tone === "bold" ? { bold: true } : undefined)]
  return { head: first === undefined ? [] : spanOf(first), detail: rest.map((line) => spanOf(line, 2)) }
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
      subject: question?.subject ?? server.target ?? server.name,
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
