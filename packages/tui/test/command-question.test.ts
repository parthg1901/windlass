/**
 * The question about a command a project's configuration names (an MCP
 * server, a hook, a language server) shows the whole command in the dock:
 * wrapped and never cut, each argument quoted so that its boundaries are
 * unambiguous; a command too long for the dock is printed in full above it
 * before the question can be answered.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { HookInfo, LspServerInfo, McpServerInfo } from "@windlass/acp/extensions"
import { brand } from "@windlass/core"
import { ARMING_MS, QUIET_MS } from "../src/approval.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

const FILE = `/work/.${brand.directory}/config.json`
/** One word of `length` characters that ends in a marker: what a command can hide where nobody looks. */
const longWord = (length: number) => `/opt/tools/serve\${IFS}--log\${IFS}${"a/very/long/path/".repeat(Math.ceil(length / 17)).slice(0, length)};echo\${IFS}TAIL-MARKER>/dev/null`
/** The frame's rows without their whitespace: a wrapped command reads as one run of characters. */
const squeezed = (frame: string) => frame.replace(/\s+/g, "")
/** The same of the conversation alone (the part of each row before the panel). */
const conversation = (frame: string) =>
  frame
    .split("\n")
    .map((row) => row.split("│")[0]!)
    .join("")
    .replace(/\s+/g, "")

const mcp = (script: string): McpServerInfo => ({
  name: "theirs",
  state: "awaiting_approval",
  transport: "stdio",
  target: `bash -c ${script}`,
  argv: ["bash", "-c", script],
  tools: null,
  hiddenTools: 0,
  error: null,
  retryInMs: null,
  origin: "project",
  file: FILE,
  question: { fingerprint: "0123456789abcdef", subject: `bash -c ${script}`, details: ['This project\'s configuration names the MCP server "theirs", which is started by running that command. It runs outside the sandbox, with your permissions.'] },
})

async function open(width: number, height: number) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  return { backend, session: backend.session!, mounted }
}

describe("the dock at 100 columns", () => {
  test("an MCP server's command with one very long word is shown to its end, its arguments quoted, before it can be answered", async () => {
    const { session } = await open(100, 40)
    const script = `${longWord(420)} and more`
    const approved: string[] = []
    session.approveMcp = async (name) => {
      approved.push(name)
      return true
    }
    mounted!.clock.now += QUIET_MS + 10
    session.pushMcp({ sessionId: session.id, available: true, servers: [mcp(script)] })
    await mounted!.settle()
    const frame = await mounted!.frame()
    // The whole command, in order, nothing dropped and nothing cut: the one argument in quotes, the marker at its end.
    expect(squeezed(frame)).toContain(squeezed(`bash -c '${script}'`))
    expect(squeezed(frame)).toContain("TAIL-MARKER>/dev/nullandmore'")
    expect(frame).not.toContain("…")
    expect(frame).not.toContain("do not fit here")
    expect(frame).toContain("[a] Start it for this project")
    expect(approved).toEqual([])
    mounted!.clock.now += ARMING_MS + 10
    await mounted!.setup.mockInput.typeText("a")
    await mounted!.settle()
    expect(approved).toEqual(["theirs"])
  })

  test("a command too long for the dock: the dock says so, and the whole of it is printed above before any key answers", async () => {
    const { session } = await open(100, 30)
    const script = longWord(2600)
    mounted!.clock.now += QUIET_MS + 10
    session.pushMcp({ sessionId: session.id, available: true, servers: [mcp(script)] })
    await mounted!.settle()
    const frame = await mounted!.frame()
    expect(frame).toContain("of the command do not fit here: the whole of it is printed above, to its end")
    // Above the dock, in the conversation: the end of the command with its marker and the closing quote.
    expect(conversation(frame)).toContain("echo${IFS}TAIL-MARKER>/dev/null'")
    // The choices are still there.
    expect(frame).toContain("[a] Start it for this project")
    expect(frame).toContain("[n] Not now")
    // All of it is in the conversation: scrolled to its top, the command starts there.
    const whole = mounted!.app.transcript.rows.flatMap((row) => (row.kind === "notice" ? row.detail.map((line) => line.map((part) => part.text).join("")) : []))
    expect(whole).toContain(`bash -c '${script}'`)
  })

  test("a hook's command and a language server's command are shown whole too", async () => {
    const { session } = await open(100, 40)
    const command = `case "$CMD" in *push*) ${longWord(300)};; esac`
    const hook: HookInfo = {
      name: "no-push",
      point: "beforeTool",
      state: "awaiting_approval",
      command,
      tools: ["shell"],
      paths: null,
      timeoutSeconds: 10,
      onError: "refuse",
      sandbox: true,
      origin: "project",
      file: FILE,
      fingerprint: "a".repeat(64),
      error: null,
      question: `This project's configuration asks to run a hook "no-push" before a tool call runs, and can refuse the call:\n\n    ${command}\n\nIt applies to the tools shell.`,
    }
    mounted!.clock.now += QUIET_MS + 10
    session.pushHooks({ sessionId: session.id, available: true, hooks: [hook], maxStopRounds: 3, ignored: [] })
    await mounted!.settle()
    expect(squeezed(await mounted!.frame())).toContain(squeezed(command))
    mounted!.clock.now += ARMING_MS + 10
    await mounted!.setup.mockInput.typeText("n")
    await mounted!.settle()

    const argument = longWord(300)
    const server: LspServerInfo = {
      name: "fixture",
      state: "awaiting_approval",
      command: `node server.js ${argument} --stdio`,
      argv: ["node", "server.js", argument, "--stdio"],
      languages: [{ languageId: "plaintext", patterns: ["**/*.txt"] }],
      processes: [],
      error: null,
      origin: "project",
      file: FILE,
      question: { fingerprint: "0123456789abcdef", subject: `node server.js ${argument} --stdio`, details: [] },
    }
    mounted!.clock.now += QUIET_MS + 10
    session.pushLsp({ sessionId: session.id, available: true, off: null, waitMs: 1500, servers: [server] })
    await mounted!.settle()
    expect(squeezed(await mounted!.frame())).toContain(squeezed(`node server.js '${argument}' --stdio`))
  })
})
