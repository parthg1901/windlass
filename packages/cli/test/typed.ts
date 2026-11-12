/**
 * Shared by the tests of agents, the task list, `/rename`, `/compact`, the
 * turn endings and the settings the engine refuses: builders of hand-written
 * events, and the interactive CLI as a user types into it, against the real
 * server in this process with a scripted model.
 */
import { afterAll, beforeAll } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentRecord, type NewEvent, brand, event } from "@windlass/core"
import type { FakeProvider } from "@windlass/core/testing"
import { c, m, x } from "@windlass/core/testing/scenarios"
import { createAcpEngine } from "../src/acp-engine.ts"
import { runCli } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

export const REVIEWER: AgentRecord = {
  name: "reviewer",
  path: "/work/.claude/agents/reviewer.md",
  scope: "project",
  definition: "f".repeat(64),
  instructions: "You review.",
  restrictions: { effects: ["read"], tools: null, deniedTools: [], approval: null },
  model: null,
  effort: null,
}
export const call = (id: string, callId: string, name: string, input: object) => event("tool.called", { messageId: m(id), callId: c(callId), name, input: JSON.stringify(input), providerData: null })
export const settle = (id: string, callId: string, outcome: "success" | "error", output: string, display: NewEvent<"tool.settled">["data"]["display"] = null) =>
  event("tool.settled", { messageId: m(id), callId: c(callId), outcome, output, truncation: null, attachments: [], display })
export const succeeded = (verification: NewEvent<"execution.succeeded">["data"]["verification"], id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification })
export const compactionStarted = (id: string, trigger: "auto" | "manual") => event("compaction.started", { messageId: m(id), trigger, mode: "normal", keepFromSeq: 1, prompt: "Summarise.", tokensBefore: 9000 })
export const compactionEnded = (id: string, calls: number) => event("compaction.ended", { messageId: m(id), summary: "A checkpoint.", source: "model", detail: null, tokensAfter: 1200, usage: null, calls })
export const todo = (items: readonly { text: string; status: "pending" | "in_progress" | "done" }[]) => ({
  todo: { items: [...items], counts: { pending: items.filter((item) => item.status === "pending").length, in_progress: items.filter((item) => item.status === "in_progress").length, done: items.filter((item) => item.status === "done").length } },
})

/**
 * Throwaway workspaces (with agent definitions), a data directory for each,
 * and the interactive CLI in them. Called at the top of a `describe`: it
 * points the configuration directory at a throwaway one for its tests.
 */
export function typedSessions(prefix: string) {
  let root = ""
  let saved: string | undefined
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(root, "config")
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
    rmSync(root, { recursive: true, force: true })
  })

  let count = 0
  function workspace(agents: Record<string, string> = {}): string {
    const dir = join(root, `work${++count}`)
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true })
    for (const [name, content] of Object.entries(agents)) writeFileSync(join(dir, ".claude", "agents", `${name}.md`), content)
    return dir
  }
  const data = (cwd: string) => join(cwd, "..", `data-${cwd.split("work").at(-1)}`)
  const engineFor = (provider: FakeProvider, cwd: string, limits: Record<string, number> = {}) => () =>
    createAcpEngine({
      transport: "memory",
      harness: { dataDir: data(cwd), provider, log: () => {}, engine: { discover: () => [], loadConfig: null, agents: { configDir: join(root, "config", brand.directory) }, limits } },
      stderr: () => {},
    })

  async function interactive(argv: readonly string[], engine: () => ReturnType<typeof createAcpEngine>, drive: (type: (keys: string) => void, waitFor: (needle: string | RegExp, ms?: number) => Promise<void>, written: () => string) => Promise<void>) {
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
    const running = runCli(argv, {
      engine,
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
    // `written`: everything the CLI wrote so far, for a test that types an ID it was shown.
    await drive((keys) => typer!(keys), waitFor, () => seen)
    const result = await running
    return { ...result, seen, screen: vt.text.replace(/\n\s+/g, " ") }
  }

  return { workspace, data, engineFor, interactive }
}
