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
import { type CallId, type MessageId, brand, event } from "@light-harness/core"
import { FakeProvider, script } from "@light-harness/core/testing"
import { loadConfig } from "../../core/src/config/load.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import { wakeMessageSummary } from "../src/features.ts"
import { successSummary } from "../src/tools.ts"
import { render, runCli, stored } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(40_000)

const SERVER = join(import.meta.dir, "..", "..", "core", "test", "mcp", "fixtures", "stdio-server.ts")
const QUICK = { startWaitMs: 0, probeMs: 300, graceMs: 500, backoff: { initialMs: 200, maxMs: 400, stableMs: 60_000 }, dropAfterMs: 200 }
let root = ""
let saved: string | undefined
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lh-cli-features-")))
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
      type("/mcp\r")
      await waitFor("not started yet: servers start with the next message")
      type("hello\r")
      await waitFor('? Start the MCP server "theirs" that this project\'s configuration names?')
      await waitFor("[y] start it · [N] not now")
      type("y\r")
      await waitFor('approved: "theirs" starts now')
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
    expect(run.screen).toContain(`defined in this project's file, ${join(cwd, `.${brand.directory}`, "config.json")}`)
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
