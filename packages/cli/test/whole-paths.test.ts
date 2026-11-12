/**
 * A path is never cut in the line interface: `/agent`, `/mcp`, `/hooks`,
 * `/lsp`, `/skills`, the questions about a project's server or hook, a
 * notice, the engine's warning about a definition it could not load and the
 * configuration error of a failed turn each show a path wider than the
 * terminal whole, to its last character, on a line of its own.
 */
import { describe, expect, test } from "bun:test"
import type { HookInfo, LspServerInfo, McpServerInfo } from "@windlass/acp/extensions"
import { type SessionId, event } from "@windlass/core"
import { executionStarted, opening, x } from "@windlass/core/testing/scenarios"
import { agentLines } from "../src/agents.ts"
import { mcpFailureText, mcpLines, mcpQuestionLines, skillsLines } from "../src/features.ts"
import { hookQuestionLines, hooksLines, lspLines, lspQuestionLines } from "../src/hooks.ts"
import { PrettyRenderer } from "../src/renderer.ts"
import { wrapKeeping } from "../src/text.ts"
import { render, stored } from "./helpers.ts"

const DEEP = "/var/tmp/a-workspace-kept-under-a-deep-temporary-directory/with-another-long-directory-name/and-one-more-level"
const AGENT = `${DEEP}/.claude/agents/reviewer-END.md`
const CONFIG = `${DEEP}/.project/config-END.json`
const COLUMNS = 80

function printed(lines: Parameters<PrettyRenderer["printLines"]>[0]): string {
  let out = ""
  const renderer = new PrettyRenderer({ write: (text) => (out += text), color: false, columns: () => COLUMNS, live: false, showReasoning: false, echoPrompts: false })
  renderer.printLines(lines)
  return out
}

/** The path is there whole, on a line that holds nothing else, and nothing was cut. */
function whole(out: string, path: string): void {
  expect(out.split("\n").map((line) => line.trim())).toContain(path)
  expect(out).not.toContain("…")
}

const server: McpServerInfo = { name: "issues", state: "awaiting_approval", transport: "stdio", target: "bun server.ts", argv: ["bun", "server.ts"], tools: null, hiddenTools: 0, error: null, retryInMs: null, origin: "project", file: CONFIG, question: { fingerprint: "f1", subject: "bun server.ts", details: ["It runs outside the sandbox."] } }
const hook: HookInfo = { name: "format", point: "afterTool", state: "awaiting_approval", command: "bun fmt", tools: ["edit"], paths: null, timeoutSeconds: 10, onError: "refuse", sandbox: true, origin: "project", file: CONFIG, fingerprint: "h1", error: null, question: "This project's configuration asks to run a hook \"format\" after a tool call:\n    bun fmt\nIt applies to edit." }
const lsp: LspServerInfo = { name: "pyright", state: "awaiting_approval", command: "pyright --stdio", argv: ["pyright", "--stdio"], languages: [{ languageId: "python", patterns: ["**/*.py"] }], processes: [], error: null, origin: "project", file: CONFIG, question: { fingerprint: "l1", subject: "pyright --stdio", details: [] } }

describe("a path wider than the terminal", () => {
  test("is a row of its own in prose, whole", () => {
    expect(wrapKeeping(`defined in ${CONFIG} for this project`, 40)).toEqual(["defined in", CONFIG, "for this project"])
    expect(wrapKeeping("short words wrap as before, at the last space that fits", 30)).toEqual(["short words wrap as before, at", "the last space that fits"])
  })

  test("/agent shows each definition's file whole, and so the file of one that was not loaded", () => {
    const out = printed(agentLines({ available: true, agents: [{ name: "reviewer", description: "Reviews a change", path: AGENT, scope: "project", model: "gpt-test", effort: null, restrictions: "", tag: "read only" }], problems: [{ path: `${DEEP}/.claude/agents/broken-END.md`, severity: "skipped", reason: "its front matter has no `description`", name: null }], default: null, ignored: [], current: null }))
    whole(out, AGENT)
    whole(out, `${DEEP}/.claude/agents/broken-END.md`)
    expect(out).toContain("      read only · model gpt-test\n")
    expect(out).toContain("    not loaded: its front matter has no `description`\n")
  })

  test("/mcp, /hooks, /lsp and /skills show where each is defined whole, and so do the questions about a project's", () => {
    whole(printed(mcpLines({ sessionId: "s", available: true, servers: [server] })), CONFIG)
    whole(printed(mcpQuestionLines(server)), CONFIG)
    whole(printed(hooksLines({ sessionId: "s", available: true, hooks: [hook], maxStopRounds: 2, ignored: [] })), CONFIG)
    whole(printed(hookQuestionLines(hook)), CONFIG)
    whole(printed(lspLines({ sessionId: "s", available: true, off: null, waitMs: 1500, servers: [lsp] })), CONFIG)
    whole(printed(lspQuestionLines(lsp)), CONFIG)
    const skills = printed(skillsLines({ sessionId: "s", available: true, skills: [{ name: "release", description: "Cut a release", path: `${DEEP}/.claude/skills/release/SKILL-END.md`, scope: "project", root: DEEP }], problems: [{ path: `${DEEP}/.claude/skills/broken/SKILL-END.md`, severity: "skipped", reason: "no front matter" }], roots: [] }))
    whole(skills, `${DEEP}/.claude/skills/release/SKILL-END.md`)
    whole(skills, `${DEEP}/.claude/skills/broken/SKILL-END.md`)
    // A short path keeps its indentation under its label.
    expect(printed(mcpLines({ sessionId: "s", available: true, servers: [{ ...server, file: "/w/config.json" }] }))).toContain("    defined in this project's file:\n      /w/config.json\n")
  })

  test("a notice, the warning about a definition that was not loaded and a configuration error keep it whole", () => {
    let out = ""
    const renderer = new PrettyRenderer({ write: (text) => (out += text), color: false, columns: () => COLUMNS, live: false, showReasoning: false, echoPrompts: false })
    renderer.notice(mcpFailureText({ ...server, state: "failed", error: "spawn bun ENOENT", question: null }), "warn")
    expect(out).toContain(`\n${CONFIG}\n`)
    expect(out).not.toContain("…")
    const warned = render([{ type: "diagnostic", sessionId: "ses_test" as SessionId, kind: "agents", message: `The agent definition at ${AGENT} was not loaded: it does not start with front matter` }], { columns: () => COLUMNS })
    expect(warned).toContain(`⚠ agents: The agent definition at\n${AGENT}\n  was not loaded: it does not start with front matter\n`)
    const failed = render(stored([...opening("hello"), executionStarted(), event("execution.failed", { executionId: x("exe_1"), message: `The configuration file ${CONFIG} could not be read: "mcp.servers.issues.command" must be a string` })]), { columns: () => COLUMNS })
    expect(failed).toContain(`\n${CONFIG}\n`)
    expect(failed).toContain('  could not be read: "mcp.servers.issues.command" must be a string\n')
    expect(failed).not.toContain("…")
  })
})
