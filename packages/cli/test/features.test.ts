/**
 * The four features at the line CLI, as a user meets them: a project's MCP
 * server is a question at the prompt (and, in a one-shot run, a sentence on
 * how to approve it), a server that cannot start is a notice with why,
 * `/mcp`, `/skills`, `/wakeups` (a webhook's secret shown once when it is
 * created), `/memory`, `/remember` and `/forget`; and what the renderer says
 * about an MCP call (the arguments that leave the machine), an image read and
 * a message a wake-up delivered.
 *
 * The configuration is real files under a throwaway `XDG_CONFIG_HOME` and the
 * workspace; the engine is the real server in this process with a scripted model.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CallId, type MessageId, brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { loadConfig } from "../../core/src/config/load.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import type { HooksStateResult, LspStateResult, McpServerInfo, McpStateResult } from "@windlass/acp/extensions"
import type { Session } from "../src/engine.ts"
import { FeatureWatch } from "../src/feature-commands.ts"
import { mcpApprovedText, mcpFirstMessageText, mcpNotWaitingText, mcpStateWords, wakeMessageSummary, wakeNotFiringText } from "../src/features.ts"
import { successSummary } from "../src/tools.ts"
import { render, runCli, stored } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(40_000)

const SERVER = join(import.meta.dir, "..", "..", "core", "test", "mcp", "fixtures", "stdio-server.ts")
const QUICK = { startWaitMs: 0, probeMs: 300, graceMs: 500, backoff: { initialMs: 200, maxMs: 400, stableMs: 60_000 }, dropAfterMs: 200 }
let root = ""
let saved: string | undefined
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-features-")))
  saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, "config")
})
afterAll(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = saved
  rmSync(root, { recursive: true, force: true })
})

let count = 0
function workspace(project?: unknown, user?: unknown): string {
  const dir = join(root, `work${++count}`)
  mkdirSync(join(dir, `.${brand.directory}`), { recursive: true })
  if (project !== undefined) writeFileSync(join(dir, `.${brand.directory}`, "config.json"), JSON.stringify(project))
  rmSync(join(root, "config"), { recursive: true, force: true })
  if (user !== undefined) {
    mkdirSync(join(root, "config", brand.directory), { recursive: true })
    writeFileSync(join(root, "config", brand.directory, "config.json"), JSON.stringify(user))
  }
  return dir
}

const engineFor = (provider: FakeProvider, data: string) => () =>
  createAcpEngine({ transport: "memory", harness: { dataDir: data, provider, log: () => {}, engine: { discover: () => [], mcp: QUICK, loadConfig: (cwd: string) => loadConfig({ cwd }) } }, stderr: () => {} })

async function interactive(cwd: string, provider: FakeProvider, drive: (type: (keys: string) => void, waitFor: (needle: string | RegExp, ms?: number) => Promise<void>) => Promise<void>) {
  const vt = new VirtualTerminal(120)
  let seen = ""
  let typer: ((data: string) => void) | null = null
  const waitFor = async (needle: string | RegExp, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!(typeof needle === "string" ? seen.includes(needle) : needle.test(seen))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(needle)}; screen:\n${vt.text}`)
      await Bun.sleep(5)
    }
  }
  const running = runCli(["--cwd", cwd], {
    engine: engineFor(provider, join(cwd, "..", `data-${count}`)),
    stdinTTY: true,
    stdoutTTY: true,
    columns: 120,
    env: { NO_COLOR: "1" },
    keys: (type) => {
      typer = type
    },
    onWrite: (text) => {
      seen += text
      vt.write(text)
    },
  })
  await waitFor("› ")
  await drive((keys) => typer!(keys), waitFor)
  const result = await running
  return { ...result, screen: vt.text.replace(/\n\s+/g, " ") }
}

describe("MCP servers", () => {
  test("a project's server is asked about at the prompt, starts on yes, and /mcp shows it running", async () => {
    const cwd = workspace({ mcp: { servers: { theirs: { command: process.execPath, args: [SERVER, "--only", "echo"] } } } })
    const provider = new FakeProvider([[script.text("Hello.")]])
    const run = await interactive(cwd, provider, async (type, waitFor) => {
      // Before the first message the engine has not looked at the servers: that is said, with what to do.
      type("/mcp\r")
      await waitFor("not looked at yet: a project's server is asked about once the first message is sent")
      type("/mcp approve theirs\r")
      await waitFor('The MCP server "theirs" cannot be approved yet: a session looks at its MCP servers when its first message is sent.')
      type("hello\r")
      await waitFor('This project\'s configuration names the MCP server "theirs". A project\'s server starts only once you have approved it')
      await waitFor('? Start the MCP server "theirs" that this project\'s configuration names?')
      await waitFor("[y] start it · [N] not now")
      type("y\r")
      // Said plainly: it starts now, and the agent has it from the next message.
      await waitFor('approved: "theirs" starts now')
      await waitFor(/the agent has its tools from your next message|ask again in your next message, when it has them/)
      // It starts in the background: asked again until it runs.
      for (let tries = 0; ; tries += 1) {
        type("/mcp\r")
        const running = await waitFor("theirs · running · 1 tool", 500).then(() => true, () => false)
        if (running || tries > 30) break
      }
      await waitFor("theirs · running · 1 tool")
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.screen).toContain("runs outside the sandbox, with your permissions")
    expect(run.screen).toContain("start it for this project and remember that")
    expect(run.screen).toContain(`defined in this project's file: ${join(cwd, `.${brand.directory}`, "config.json")}`)
  })

  test("a server that cannot start is a notice with why", async () => {
    const cwd = workspace(undefined, { mcp: { servers: { broken: { command: process.execPath, args: ["-e", "console.error('TRACKER_TOKEN is not valid'); process.exit(1)"] } } } })
    const provider = new FakeProvider([[script.text("Hello.")]])
    const run = await interactive(cwd, provider, async (type, waitFor) => {
      type("hello\r")
      await waitFor('MCP server "broken" could not start')
      type("\x04")
    })
    expect(run.screen).toContain("TRACKER_TOKEN is not valid")
    expect(run.screen).toContain("/mcp shows its state")
  })

  test("in a one-shot run nobody can approve it: it says so once, and how", async () => {
    const cwd = workspace({ mcp: { servers: { theirs: { command: process.execPath, args: [SERVER] } } } })
    const provider = new FakeProvider([[script.text("Done.")]])
    const run = await runCli(["--cwd", cwd, "hello"], { engine: engineFor(provider, join(root, `data-oneshot-${count}`)), env: { NO_COLOR: "1" } })
    const flat = (run.out + run.err).replace(/\n\s+/g, " ")
    expect(flat).toContain('MCP server "theirs" was not started')
    expect(flat).toContain(`To approve it, run \`${brand.binary}\` in this directory and answer the question it asks`)
    expect(flat.match(/was not started: this project's configuration names it/g)).toHaveLength(1)
  })
})

describe("/skills, /wakeups and /memory", () => {
  test("lists skills with broken ones in full; a webhook's secret is shown once when created; memory off says how to turn it on", async () => {
    const cwd = workspace()
    const skills = join(cwd, `.${brand.directory}`, "skills")
    mkdirSync(join(skills, "release-notes"), { recursive: true })
    writeFileSync(join(skills, "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: How to write release notes.\n---\nOne line per change.\n")
    mkdirSync(join(skills, "broken"), { recursive: true })
    writeFileSync(join(skills, "broken", "SKILL.md"), "nothing\n")
    const provider = new FakeProvider([[script.toolCall("call_1", "wake_create", { trigger: "webhook", message: "The deploy finished." })], [script.text("Set up.")]])
    const run = await interactive(cwd, provider, async (type, waitFor) => {
      type("/skills\r")
      await waitFor("release-notes · How to write release notes.")
      type("tell me when the deploy hook arrives\r")
      await waitFor("secret  whsec_")
      await waitFor("✓ done")
      type("/wakeups\r")
      await waitFor("Wake-ups of this session: 1 pending")
      type("/memory\r")
      await waitFor("Memory is off.")
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.screen).toContain(join(skills, "broken", "SKILL.md"))
    expect(run.screen).toContain("Not loaded (1)")
    expect(run.screen).toMatch(/Webhook wake-up created wk_\w+/)
    expect(run.screen).toContain("The model never sees the secret.")
    // Shown once: the listing has the URL and no secret.
    expect(run.screen.match(/whsec_/g)).toHaveLength(1)
    expect(run.screen).toContain(`{ "memory": { "enabled": true } }`)
  })

  test("with memory on: /remember saves a note, /memory lists it, /forget retracts it", async () => {
    const cwd = workspace(undefined, { memory: { enabled: true } })
    const provider = new FakeProvider([[script.text("Hi.")]])
    const run = await interactive(cwd, provider, async (type, waitFor) => {
      type("hello\r")
      await waitFor("✓ done")
      type("/remember this repository uses pnpm\r")
      await waitFor(/Saved (m_\w+)/)
      type("/memory\r")
      await waitFor("Notes in force (1)")
      type("\x04")
    })
    const id = /Saved (m_\w+)/.exec(run.screen)![1]!
    expect(run.screen).toContain(`[${id}] this project · fact: this repository uses pnpm`)
    expect(run.screen).toContain("written by you")
    const again = await interactive(cwd, new FakeProvider([[script.text("Hi.")]]), async (type, waitFor) => {
      type("hello\r")
      await waitFor("✓ done")
      type(`/forget ${id}\r`)
      await waitFor("retracted")
      type("/memory\r")
      await waitFor("No note is in force")
      type("\x04")
    })
    expect(again.code).toBe(0)
  })
})

describe("what the renderer says", () => {
  const m = (id: string) => id as MessageId
  const c = (id: string) => id as CallId
  test("an MCP call names the server's tool, and its question shows the arguments that would be sent", () => {
    const input = JSON.stringify({ server: "tracker", tool: "create_issue", arguments: { title: "Login fails", body: "steps..." } })
    const question = { title: "Allow the MCP tool tracker/create_issue?", subject: "tracker/create_issue", details: ["MCP tools run outside the sandbox with your permissions; what it receives can leave this machine."], choices: [] }
    const out = render(
      stored([
        event("tool.called", { messageId: m("m1"), callId: c("c1"), name: "mcp_call", input, providerData: null }),
        event("approval.requested", { messageId: m("m1"), callId: c("c1"), mode: "auto", paths: [], escalation: { network: true, write: [] }, question, needs: [{ kind: "network" }], then: { kind: "run" } } as never),
      ]),
    )
    expect(out).toContain("▸ mcp_call tracker/create_issue")
    expect(out).toContain(`arguments sent: {"title":"Login fails","body":"steps..."}`)
    expect(out.match(/tracker\/create_issue/g)).toHaveLength(2)
  })

  test("an image read is an image with its type and size, not a line count", () => {
    const settled = { messageId: m("m1"), callId: c("c1"), outcome: "success", output: "[image]", truncation: null, attachments: [], display: { path: "shot.png", image: { mediaType: "image/png", width: 640, height: 480, bytes: 20480 } } } as never
    expect(successSummary("read", settled)).toBe("image · image/png · 640×480 · 20.0 KB")
  })

  test("a message a wake-up delivered says which wake-up and is not shown as typed", () => {
    const text = "[Wake-up wk_7a3c12139dd8 · after 1m (at 2026-11-12T08:39:20Z)]\nThis message was not typed by the user just now. It was delivered by a wake-up.\n\nThe message set up with the wake-up:\nLook at the canary."
    expect(wakeMessageSummary(text, "wake")).toEqual({ head: "wake-up wk_7a3c12139dd8: it fired (after 1m (at 2026-11-12T08:39:20Z)) · not typed by you", message: "Look at the canary." })
    const out = render(stored([event("inbox.enqueued", { messageId: m("w1"), delivery: "queue", content: [{ type: "text", text }], origin: "wake" } as never)]))
    expect(out).toContain("⏰ wake-up wk_7a3c12139dd8: it fired")
    expect(out).toContain("Look at the canary.")
    expect(out).not.toContain("› [Wake-up")
  })
})

describe("what the project's configuration asks for is settled before a message is sent", () => {
  const server = (state: McpServerInfo["state"], origin: "user" | "project"): McpServerInfo => ({ name: "issues", state, transport: "stdio", target: "bun server.ts", argv: ["bun", "server.ts"], tools: null, hiddenTools: 0, error: null, retryInMs: null, origin, file: "/w/config.json", question: state === "awaiting_approval" ? { fingerprint: "f1", subject: "bun server.ts", details: [] } : null })

  test("the words: a server not looked at yet, one that cannot be approved yet, and an approval in the middle of a turn", () => {
    expect(mcpStateWords(server("not_started", "project"))).toBe("not looked at yet: a project's server is asked about once the first message is sent")
    expect(mcpStateWords(server("not_started", "user"))).toBe("not started yet: servers start with the next message")
    expect(mcpNotWaitingText(server("not_started", "project"))).toContain("Send your message: if this project's server still needs your approval you are asked then (/mcp approve issues asks again)")
    expect(mcpNotWaitingText(server("not_started", "user"))).toBe('The MCP server "issues" is your own and needs no approval: it starts with your next message.')
    expect(mcpNotWaitingText(server("running", "project"))).toBe('the MCP server "issues" does not wait for an approval: it is running')
    expect(mcpApprovedText({ name: "issues" }, false)).toBe('approved: "issues" starts now; the agent has its tools from your next message. /mcp shows it.')
    expect(mcpApprovedText({ name: "issues" }, true)).toContain("The turn in progress began without it, so the agent may already have said it has no such tools: ask again in your next message")
    expect(mcpFirstMessageText([server("not_started", "user"), server("running", "project")])).toBeNull()
    expect(mcpFirstMessageText([server("not_started", "project")])).toContain('names the MCP server "issues". A project\'s server starts only once you have approved it')
  })

  test("a hook, a language server and an MCP server that wait are asked about, and answered, before the message goes", async () => {
    const said: string[] = []
    const answers = ["y", "n", "y"]
    const approved: string[] = []
    const hooks: HooksStateResult = { sessionId: "s", available: true, maxStopRounds: 2, ignored: [], hooks: [{ name: "fmt", point: "afterTool", state: "awaiting_approval", command: "bun fmt", tools: null, paths: null, timeoutSeconds: 10, onError: "refuse", sandbox: true, origin: "project", file: "/w/config.json", fingerprint: "h1", error: null, question: "This project's configuration asks to run a hook \"fmt\" after a tool call:\n    bun fmt" }] }
    const lsp: LspStateResult = { sessionId: "s", available: true, off: null, waitMs: 1500, servers: [{ name: "pyright", state: "awaiting_approval", command: "pyright --stdio", argv: ["pyright", "--stdio"], languages: [], processes: [], error: null, origin: "project", file: "/w/config.json", question: { fingerprint: "l1", subject: "pyright --stdio", details: [] } }] }
    const mcp: McpStateResult = { sessionId: "s", available: true, servers: [server("awaiting_approval", "project")] }
    const session = {
      id: "ses_x",
      hooks: async () => hooks,
      lsp: async () => lsp,
      mcp: async () => mcp,
      approveHook: async (fingerprint: string) => (approved.push(`hook ${fingerprint}`), true),
      approveLsp: async (name: string) => (approved.push(`lsp ${name}`), true),
      approveMcp: async (name: string) => (approved.push(`mcp ${name}`), true),
    } as unknown as Session
    const io = { out: { lines: (lines: readonly { text: string }[]) => void said.push(...lines.map((line) => line.text)), notice: (text: string) => void said.push(text) }, ask: async (_question: string, print: () => void) => (print(), answers.shift() ?? null) }
    const watch = new FeatureWatch(session, io, { attended: true, secrets: false })
    await watch.beforeMessage()
    // All three were put, in turn, and what was allowed was recorded before the message could go.
    expect(approved).toEqual(["hook h1", "mcp issues"])
    expect(said.join("\n")).toContain('? This project\'s configuration asks to run a hook "fmt" after a tool call:')
    expect(said.join("\n")).toContain('not allowed: the language server "pyright" is not started; /lsp approve pyright asks again')
    expect(said.join("\n")).toContain('approved: "issues" starts now; the agent has its tools from your next message. /mcp shows it.')
    // Asked once: the next message goes without a question.
    said.length = 0
    await watch.beforeMessage()
    expect(said).toEqual([])
    // With nobody to ask, nothing is put before a message.
    const unattended = new FeatureWatch(session, { ...io, ask: null }, { attended: false, secrets: false })
    await unattended.beforeMessage()
    expect(said).toEqual([])
  })
})

describe("a wake-up created where none fires", () => {
  const created = (id: string) => stored([event("tool.settled", { messageId: "a1" as MessageId, callId: "c1" as CallId, outcome: "success", output: `Created wake-up ${id}.`, truncation: null, attachments: [], display: { wake: { action: "create", id } } })])[0]!
  const list = (running: boolean) => ({ sessionId: "ses_x", available: true, running, wakeups: [{ id: "w_1", trigger: "at" as const, description: "once at 09:30", state: "pending", nextAt: "2026-11-12T09:30:00.000Z", fired: 0, maxFirings: 1, author: "model" as const, message: "Check CI.", url: null, lines: [] }] })
  const watching = (running: boolean) => {
    const said: { text: string; tone: string | undefined }[] = []
    const session = { id: "ses_x", wakeups: async () => list(running), wakeSecret: async (id: string) => ({ id, url: null, secret: null, message: "not a webhook" }) } as unknown as Session
    const watch = new FeatureWatch(session, { out: { lines: () => {}, notice: (text, tone) => void said.push({ text, tone }) }, ask: null }, { attended: false, secrets: false })
    return { watch, said }
  }

  test("a one-prompt run says at once that it will not fire it, and where it will", async () => {
    const { watch, said } = watching(false)
    watch.event(created("w_1"))
    await watch.settled()
    expect(said).toEqual([{ text: wakeNotFiringText({ id: "w_1", description: "once at 09:30" }, "ses_x"), tone: "warn" }])
    expect(said[0]!.text).toBe(
      `Wake-up w_1 (once at 09:30) was created, but this run does not fire wake-ups: it ends with its turn. It fires, late if its time has passed by then, the next time ${brand.name} runs interactively on this machine (\`${brand.binary}\` with no prompt, \`${brand.binary} tui\`, or an editor). \`${brand.binary} --session ses_x\` opens this session: /wakeups lists it there, and /wakeups cancel w_1 removes it.`,
    )
  })

  test("a run that fires wake-ups says nothing about it", async () => {
    const { watch, said } = watching(true)
    watch.event(created("w_1"))
    await watch.settled()
    expect(said).toEqual([])
  })
})
