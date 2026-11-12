/**
 * The four features in the real `App`: a project's MCP server is put in the
 * approval dock (what it runs, where it is defined, what each answer does)
 * and approved by a key; a server that cannot start is a note with why;
 * `/skills`, `/wakeups` and `/memory` show the line CLI's words; a webhook's
 * secret is shown once when it is created; a message a wake-up delivered is
 * labelled as one; an MCP call's question shows the arguments it would send.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { McpServerInfo } from "@windlass/acp/extensions"
import { type CallId, type MessageId, event } from "@windlass/core"
import { ARMING_MS, QUIET_MS } from "../src/approval.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

const m = (id: string) => id as MessageId
const c = (id: string) => id as CallId
const flat = (frame: string) => frame.replace(/\s+/g, " ")

const THEIRS: McpServerInfo = {
  name: "theirs",
  state: "awaiting_approval",
  transport: "stdio",
  target: "tracker-mcp --stdio",
  argv: ["tracker-mcp", "--stdio"],
  tools: null,
  hiddenTools: 0,
  error: null,
  retryInMs: null,
  origin: "project",
  file: "/work/.windlass/config.json",
  question: { fingerprint: "0123456789abcdef", subject: "tracker-mcp --stdio", details: ['This project\'s configuration names the MCP server "theirs", which is started by running that command. It runs outside the sandbox, with your permissions.'] },
}

async function open(width = 110, height = 34) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  return { backend, session: backend.session!, mounted }
}

describe("MCP servers", () => {
  test("a project's server waits in the dock: what it runs, where it is defined, and the two answers; `a` starts it", async () => {
    const { session } = await open()
    const approved: string[] = []
    session.approveMcp = async (name, fingerprint) => {
      approved.push(`${name}:${fingerprint}`)
      return true
    }
    mounted!.clock.now += QUIET_MS + 10
    session.pushMcp({ sessionId: session.id, available: true, servers: [THEIRS] })
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain('Start the MCP server "theirs" that this project\'s configuration names?')
    expect(frame).toContain("tracker-mcp --stdio")
    expect(frame).toContain("[a] Start it for this project")
    expect(frame).toContain("Not now: it stays stopped")
    expect(frame).not.toContain("tell the agent why")
    // The same question is not put twice.
    session.pushMcp({ sessionId: session.id, available: true, servers: [THEIRS] })
    mounted!.clock.now += ARMING_MS + 10
    await mounted!.setup.mockInput.typeText("a")
    await mounted!.settle()
    expect(approved).toEqual(["theirs:0123456789abcdef"])
    const after = flat(await mounted!.frame())
    expect(after).toContain('approved: "theirs" starts now; the agent has its tools from your next')
    expect(after).not.toContain("[a] Start it for this project")
  })

  test("a server that cannot start is said once, with why; /mcp lists the servers", async () => {
    const { session } = await open()
    const failed: McpServerInfo = { ...THEIRS, name: "tracker", state: "failed", origin: "user", file: "/home/u/.config/windlass/config.json", question: null, error: "the server process exited with code 1; stderr ends with: TRACKER_TOKEN is not set", retryInMs: 5000 }
    session.mcp = async () => ({ sessionId: session.id, available: true, servers: [failed] })
    session.pushMcp({ sessionId: session.id, available: true, servers: [failed] })
    session.pushMcp({ sessionId: session.id, available: true, servers: [failed] })
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame.match(/could not start/g)).toHaveLength(1)
    expect(frame).toContain("TRACKER_TOKEN is not set")
    await mounted!.setup.mockInput.typeText("/mcp")
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    const listed = flat(await mounted!.frame())
    expect(listed).toContain("tracker · failed to start")
    expect(listed).toContain("defined in your file")
  })

  test("an MCP call's question shows the arguments it would send", async () => {
    const { backend, session } = await open()
    const input = JSON.stringify({ server: "tracker", tool: "create_issue", arguments: { title: "Login fails" } })
    session.emit(event("execution.started", { executionId: "exe_1" } as never), event("tool.called", { messageId: m("m1"), callId: c("c1"), name: "mcp_call", input, providerData: null }))
    await mounted!.settle()
    mounted!.clock.now += QUIET_MS + 10
    void backend.onApproval(
      {
        sessionId: session.id,
        toolCallId: "m1/c1",
        messageId: "m1",
        callId: "c1",
        question: { title: "Allow the MCP tool tracker/create_issue?", subject: "tracker/create_issue", details: [], choices: [{ id: "once", label: "Allow once", approve: true, remembers: null }, { id: "deny", label: "Don't allow", approve: false, remembers: null }] },
        needs: [],
        then: { kind: "run" },
        subagent: null,
        subagentSessionId: null,
      },
      new AbortController().signal,
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("mcp_call tracker/create_issue")
    expect(frame).toContain('sends: {"title":"Login fails"}')
  })
})

describe("/skills, /wakeups, /memory and what wake-ups deliver", () => {
  test("the listings, the secret once on creation, and a wake-up's message labelled", async () => {
    const { session } = await open(120, 50)
    session.skills = async () => ({
      sessionId: session.id,
      available: true,
      skills: [{ name: "release-notes", description: "How to write release notes.", path: "/work/.windlass/skills/release-notes/SKILL.md", scope: "project", root: "/work/.windlass/skills" }],
      problems: [{ path: "/work/.windlass/skills/broken/SKILL.md", severity: "skipped", reason: "it does not start with front matter" }],
      roots: [],
    })
    session.wakeSecret = async (id) => ({ id, url: "http://127.0.0.1:47863/w/wk_1", secret: "whsec_abc", message: null })
    session.memory = async () => ({ sessionId: session.id, enabled: false, off: "Memory is off. To turn it on, put { \"memory\": { \"enabled\": true } } in ~/.config/windlass/config.json; sessions started after that have it.", notes: [], pending: [], problems: [], review: [], paths: null })
    await mounted!.setup.mockInput.typeText("/skills")
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    session.emit(
      event("tool.called", { messageId: m("m1"), callId: c("c1"), name: "wake_create", input: '{"trigger":"webhook","message":"x"}', providerData: null }),
      event("tool.settled", { messageId: m("m1"), callId: c("c1"), outcome: "success", output: "Created wake-up wk_1.", truncation: null, attachments: [], display: { wake: { action: "create", id: "wk_1" } } } as never),
    )
    await mounted!.settle()
    await mounted!.setup.mockInput.typeText("/memory")
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    session.emit(
      event("inbox.enqueued", { messageId: m("w1"), delivery: "queue", origin: "wake", content: [{ type: "text", text: "[Wake-up wk_9 · every 1m]\nThis message was not typed by the user just now.\n\nThe message set up with the wake-up:\nCheck CI." }] } as never),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("release-notes · How to write release notes.")
    expect(frame).toContain("/work/.windlass/skills/broken/SKILL.md")
    expect(frame).toContain("secret whsec_abc")
    expect(frame).toContain("Memory is off.")
    expect(frame).toContain("wake-up wk_9: it fired (every 1m) · not typed by you")
    expect(frame).toContain("Check CI.")
  })
})

describe("forks", () => {
  test("/sessions tells a fork from its parent: a mark, enough of the ID, what it was forked from, and where it works", async () => {
    const { backend } = await open(130, 30)
    const now = mounted!.clock.now
    Object.assign(backend, {
      listSessions: async () => [
        { id: "ses_aaaa1111bbbb2222cccc3333", title: "fix the login test (fork)", cwd: "/data-work/workspaces/ses_aaaa1111bbbb2222cccc3333", updatedAt: now - 1000, model: "gpt-6-luna", effort: "low", archived: false, forkedFrom: "ses_aaaa9999bbbb2222cccc3333" },
        { id: "ses_aaaa9999bbbb2222cccc3333", title: "fix the login test", cwd: "/work", updatedAt: now - 120_000, model: "gpt-6-luna", effort: "low", archived: false, forkedFrom: null },
      ],
    })
    await mounted!.setup.mockInput.typeText("/sessions")
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("⑂ fix the login test (fork)")
    expect(frame).toContain("ses_aaaa1111bbbb · fork of ses_aaaa9999 · in /data-work/work…bb2222cccc3333")
    expect(frame).toContain("ses_aaaa9999bbbb · 2 min ago")
  })

  test("/fork in a session without a turn is refused with a sentence", async () => {
    const { session } = await open()
    let forked = 0
    session.fork = async () => {
      forked += 1
      return { sessionId: "ses_x", parentSessionId: "ses_parent", cwd: "/work", copiedFrom: null, title: null }
    }
    await mounted!.setup.mockInput.typeText("/fork")
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    expect(forked).toBe(0)
    expect(flat(await mounted!.frame())).toContain("/fork copies this conversation into a new session, and there is none")
  })

  test("a fork's panel counts its own model calls and names the inherited ones apart", async () => {
    const { session } = await open(140, 40)
    const usage = (input: number) => ({ inputTokens: input, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 })
    session.emit(
      event("session.created", { cwd: "/work", title: null, lineage: null, settings: { model: "gpt-6-luna", reasoningEffort: null } }),
      event("step.started", { messageId: m("a1"), model: "gpt-6-luna" } as never),
      event("step.ended", { messageId: m("a1"), usage: usage(1000), finish: "stop" } as never),
      event("session.created", { cwd: "/work", title: null, lineage: { kind: "fork", parentSessionId: "ses_parent0000000000000000", throughSeq: 3 }, settings: { model: "gpt-6-luna", reasoningEffort: null } } as never),
      event("step.started", { messageId: m("b1"), model: "gpt-6-luna" } as never),
      event("step.ended", { messageId: m("b1"), usage: usage(1500), finish: "stop" } as never),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("fork of ses_parent")
    expect(frame).toContain("inherited 1 call · 1.0k in")
    expect(frame).toContain("the parent's, not above")
    expect(frame).toMatch(/input\s+1,500/)
  })
})

describe("background commands", () => {
  test("shown with this machine's path to their output, in the panel while they run, and at the end of the turn that leaves them running", async () => {
    const { session } = await open(140, 40)
    session.emit(
      event("execution.started", { executionId: "exe_1" } as never),
      event("tool.called", { messageId: m("m1"), callId: c("c1"), name: "shell", input: '{"command":"sleep 5; echo built","background":true}', providerData: null }),
      event("spawn.started", { spawnId: "bg_1", messageId: m("m1"), callId: c("c1"), background: true, work: { kind: "command", command: "sleep 5; echo built", logPath: "/tmp/windlass-1001/ses_x/.spill/shell-bg.log" } } as never),
      event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } } as never),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("background bg_1 · sleep 5; echo built")
    expect(frame).toContain("output: /tmp/windlass-1001/ses_x/.spill/shell-bg.log")
    expect(frame).toContain("1 background command still running (bg_1)")
    expect(frame).toMatch(/bg +◌ bg_1: sleep 5/)
    session.emit(event("spawn.ended", { spawnId: "bg_1", outcome: "completed", detail: "exited", exitCode: 0, usage: null, tainted: false, merge: null } as never))
    await mounted!.settle()
    const after = flat(await mounted!.frame())
    expect(after).toContain("background bg_1 exited with code 0")
    expect(after).not.toMatch(/bg +◌ bg_1/)
  })

  test("the line about commands still running is said once for the same commands, however many turns end meanwhile", async () => {
    const { session } = await open(140, 40)
    const turn = (id: string) => [event("execution.started", { executionId: id } as never), event("execution.succeeded", { executionId: id, verification: { status: "not_configured" } } as never)]
    session.emit(
      event("execution.started", { executionId: "exe_1" } as never),
      event("spawn.started", { spawnId: "bg_1", messageId: m("m1"), callId: c("c1"), background: true, work: { kind: "command", command: "sleep 500", logPath: "/tmp/x.log" } } as never),
      event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } } as never),
      ...turn("exe_2"),
      ...turn("exe_3"),
    )
    await mounted!.settle()
    expect(flat(await mounted!.frame()).match(/background command still running/g)).toHaveLength(1)
    // Another command joins it: the line is news again, and names both.
    session.emit(
      event("execution.started", { executionId: "exe_4" } as never),
      event("spawn.started", { spawnId: "bg_2", messageId: m("m2"), callId: c("c2"), background: true, work: { kind: "command", command: "sleep 600", logPath: "/tmp/y.log" } } as never),
      event("execution.succeeded", { executionId: "exe_4", verification: { status: "not_configured" } } as never),
    )
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("2 background commands still running (bg_1, bg_2)")
  })

  test("the message its end sends to the model is one line saying where it goes, not the message", async () => {
    const { session } = await open(140, 40)
    const told = "Background command bg_1 exited with code 0 after 5.0 s.\nCommand: sleep 5; echo built\nOutput:\nbuilt\nFull output: /tmp/.spill/shell-bg.log"
    session.emit(
      event("spawn.started", { spawnId: "bg_1", messageId: m("m1"), callId: c("c1"), background: true, work: { kind: "command", command: "sleep 5; echo built", logPath: "/tmp/windlass-1001/ses_x/.spill/shell-bg.log" } } as never),
      event("spawn.ended", { spawnId: "bg_1", outcome: "completed", detail: "exited", exitCode: 0, usage: null, tainted: false, merge: null } as never),
      event("inbox.enqueued", { messageId: m("b1"), delivery: "queue", origin: "background_command", content: [{ type: "text", text: told }] } as never),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("✓ background bg_1 exited with code 0")
    expect(frame).toContain("↳ its result is sent to the agent, which carries on")
    expect(frame).not.toContain("background_command")
    expect(frame).not.toContain("⏎")
    expect(frame).not.toContain("Full output")
    session.emit(event("inbox.enqueued", { messageId: m("b2"), delivery: "queue", origin: "subagent_result", content: [{ type: "text", text: "Subagent result" }] } as never))
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("↳ the subagent's result is sent to the agent, which carries on")
  })
})
