/**
 * The four features a client shows the user, over the wire: a project's MCP
 * server waits for the user's approval (`<prefix>/mcp`, `<prefix>/mcp_changed`)
 * and starts once approved (`<prefix>/mcp_approve`), a server that cannot
 * start is reported with why; the skills of the directory with the broken
 * and the shadowed ones (`<prefix>/skills`); the session's wake-ups, a
 * webhook's secret only as the answer to `<prefix>/wake_secret` (never in an
 * event), and cancelling one; memory off, then on: remember, the pending
 * note confirmed, retract.
 *
 * The configuration is real files under a throwaway `XDG_CONFIG_HOME` and the
 * workspace, read by the same loader the command line uses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { brand } from "@windlass/core"
import { script } from "@windlass/core/testing"
import { loadConfig } from "../../core/src/config/load.ts"
import { EXT, META, type McpStateResult, type MemoryStateResult, type SkillsResult, type WakeListResult, type WakeSecretResult } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

const NS = META.capabilities
const SERVER = join(import.meta.dir, "..", "..", "core", "test", "mcp", "fixtures", "stdio-server.ts")
const QUICK = { startWaitMs: 0, probeMs: 300, graceMs: 500, backoff: { initialMs: 200, maxMs: 400, stableMs: 60_000 }, dropAfterMs: 200 }

let configHome = ""
let saved: string | undefined
beforeAll(() => {
  saved = process.env.XDG_CONFIG_HOME
  configHome = realpathSync(mkdtempSync(join(tmpdir(), "wl-acp-config-")))
  process.env.XDG_CONFIG_HOME = configHome
})
afterAll(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = saved
  rmSync(configHome, { recursive: true, force: true })
})

const harnesses: Harness[] = []
afterEach(async () => {
  const violations = harnesses.flatMap((harness) => harness.violations)
  for (const harness of harnesses.splice(0).reverse()) await harness.close()
  rmSync(join(configHome, brand.directory), { recursive: true, force: true })
  expect(violations).toEqual([])
})

function userConfig(value: unknown): void {
  mkdirSync(join(configHome, brand.directory), { recursive: true })
  writeFileSync(join(configHome, brand.directory, "config.json"), JSON.stringify(value))
}

async function start(responses: NonNullable<Parameters<typeof startHarness>[0]>["responses"], before?: (workspace: string) => void) {
  const harness = await startHarness({
    responses,
    clientCapabilities: { _meta: { [NS]: { events: true } } },
    engine: { mcp: QUICK, loadConfig: (cwd: string) => loadConfig({ cwd }) },
  })
  harnesses.push(harness)
  before?.(harness.workspace)
  await harness.initialize()
  return harness
}

const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const ext = <T>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request<T>(method, params)
const changes = (harness: Harness) => harness.ext.filter((note) => note.method === EXT.mcpChanged).map((note) => note.params as unknown as McpStateResult)

function projectConfig(workspace: string, value: unknown): string {
  const dir = join(workspace, `.${brand.directory}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify(value))
  return join(dir, "config.json")
}

describe("MCP servers", () => {
  test("a project's server waits for the user's approval, is announced, and starts once approved", async () => {
    let file = ""
    const harness = await start([[script.text("Nothing to do yet.")], [script.text("Now it is there.")]], (workspace) => {
      file = projectConfig(workspace, { mcp: { servers: { theirs: { command: process.execPath, args: [SERVER, "--only", "echo"] } } } })
    })
    const sessionId = await harness.newSession()
    // Before a turn the servers are only named: they start with the turn that reads the configuration.
    const before = await ext<McpStateResult>(harness, EXT.mcp, { sessionId })
    expect(before.servers).toEqual([expect.objectContaining({ name: "theirs", state: "not_started", origin: "project", file })])
    await prompt(harness, sessionId, "Hello.")
    await until(() => changes(harness).some((change) => change.servers.some((server) => server.state === "awaiting_approval")), 5000, "the question")
    const waiting = (await ext<McpStateResult>(harness, EXT.mcp, { sessionId })).servers[0]!
    expect(waiting).toMatchObject({ name: "theirs", state: "awaiting_approval", origin: "project", file, tools: null })
    expect(waiting.target).toContain("stdio-server.ts --only echo")
    // Each argument on its own, for a client that shows where one ends.
    expect(waiting.argv).toEqual([process.execPath, SERVER, "--only", "echo"])
    expect(waiting.question!.details.join(" ")).toContain("runs outside the sandbox")
    expect(waiting.question!.fingerprint).toMatch(/^[0-9a-f]{16}$/)

    const wrong = await ext<{ approved: boolean }>(harness, EXT.mcpApprove, { sessionId, name: "theirs", fingerprint: "0000000000000000" })
    expect(wrong.approved).toBe(false)
    const approved = await ext<{ approved: boolean }>(harness, EXT.mcpApprove, { sessionId, name: "theirs", fingerprint: waiting.question!.fingerprint })
    expect(approved.approved).toBe(true)
    await until(() => changes(harness).some((change) => change.servers.some((server) => server.name === "theirs" && server.state === "running")), 10_000, "the server to run")
    const running = changes(harness).findLast((change) => change.servers.some((server) => server.state === "running"))!.servers[0]!
    expect(running).toMatchObject({ name: "theirs", state: "running", tools: 1, origin: "project", file, question: null })
  })

  test("a server that cannot start is reported to the client with why", async () => {
    userConfig({ mcp: { servers: { broken: { command: process.execPath, args: ["-e", "console.error('no token configured'); process.exit(1)"] } } } })
    const harness = await start([[script.text("Hi.")]])
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "Hello.")
    await until(() => changes(harness).some((change) => change.servers.some((server) => server.state === "failed")), 10_000, "the failure")
    const failed = changes(harness).find((change) => change.servers.some((server) => server.state === "failed"))!.servers[0]!
    expect(failed).toMatchObject({ name: "broken", state: "failed", origin: "user", file: join(configHome, brand.directory, "config.json") })
    expect(failed.error).toContain("no token configured")
  })
})

describe("skills", () => {
  test("lists each skill with where it comes from, and the ones that could not be loaded with their full paths", async () => {
    let broken = ""
    const harness = await start([], (workspace) => {
      const root = join(workspace, `.${brand.directory}`, "skills")
      mkdirSync(join(root, "release-notes"), { recursive: true })
      writeFileSync(join(root, "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: How to write release notes.\n---\nOne line per change.\n")
      mkdirSync(join(root, "a-very-long-directory-name-that-a-listing-must-not-cut", "broken"), { recursive: true })
      broken = join(root, "a-very-long-directory-name-that-a-listing-must-not-cut", "broken", "SKILL.md")
      writeFileSync(broken, "no front matter here\n")
      mkdirSync(join(workspace, ".claude", "skills", "release-notes"), { recursive: true })
      writeFileSync(join(workspace, ".claude", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Another one.\n---\nx\n")
    })
    const sessionId = await harness.newSession()
    const skills = await ext<SkillsResult>(harness, EXT.skills, { sessionId })
    expect(skills.available).toBe(true)
    expect(skills.skills).toEqual([expect.objectContaining({ name: "release-notes", description: "How to write release notes.", scope: "project" })])
    expect(skills.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: broken, severity: "skipped" }),
        expect.objectContaining({ severity: "shadowed", path: join(harness.workspace, ".claude", "skills", "release-notes", "SKILL.md") }),
      ]),
    )
  })
})

describe("wake-ups", () => {
  test("lists them in the engine's words; a webhook's secret is only ever the answer to wake_secret; the user cancels one", async () => {
    const harness = await start([[script.toolCall("call_1", "wake_create", { trigger: "webhook", message: "The deploy finished." })], [script.text("Set up.")]])
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "Tell me when the deploy webhook arrives.")
    const listed = await ext<WakeListResult>(harness, EXT.wakeups, { sessionId })
    expect(listed.available).toBe(true)
    expect(listed.running).toBe(false)
    expect(listed.wakeups).toHaveLength(1)
    const wake = listed.wakeups[0]!
    expect(wake).toMatchObject({ trigger: "webhook", state: "pending", author: "model", message: "The deploy finished.", fired: 0 })
    expect(wake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/w\/wk_/)
    expect(wake.lines.join("\n")).toContain("State: waiting for a request.")
    expect(JSON.stringify(listed)).not.toContain("whsec_")

    const secret = await ext<WakeSecretResult>(harness, EXT.wakeSecret, { sessionId, id: wake.id })
    expect(secret.secret).toMatch(/^whsec_/)
    expect(secret.url).toBe(wake.url)
    // Nowhere else on the wire: not in an event, not in a notification, not in the model's tool result.
    expect(harness.ext.some((note) => JSON.stringify(note).includes(secret.secret!))).toBe(false)
    expect(harness.wire.filter((message) => JSON.stringify(message).includes(secret.secret!))).toEqual([expect.objectContaining({ result: secret })])

    expect((await ext<WakeSecretResult>(harness, EXT.wakeSecret, { sessionId, id: "wk_000000000000" })).message).toContain("there is no wake-up")
    const cancelled = await ext<{ cancelled: boolean; message: string }>(harness, EXT.wakeCancel, { sessionId, id: wake.id })
    expect(cancelled).toEqual({ cancelled: true, message: expect.stringContaining(`Cancelled wake-up ${wake.id}`) })
    expect((await ext<WakeListResult>(harness, EXT.wakeups, { sessionId })).wakeups[0]!.state).toBe("cancelled")
  })
})

describe("memory", () => {
  test("off: says so and how to turn it on", async () => {
    const harness = await start([])
    const sessionId = await harness.newSession()
    const state = await ext<MemoryStateResult>(harness, EXT.memory, { sessionId })
    expect(state.enabled).toBe(false)
    expect(state.off).toContain(`{ "memory": { "enabled": true } } in ${join(configHome, brand.directory, "config.json")}`)
    const refused = await ext<{ ok: boolean; message: string; deferred?: boolean }>(harness, EXT.memoryChange, { sessionId, action: "remember", text: "x" })
    expect(refused.ok).toBe(false)
    // The same sentence the listing gives, and nothing for a client to keep: memory is off.
    expect(refused.message).toBe(state.off!)
    expect(refused.deferred).toBeUndefined()
    expect(state.startsWithFirstTurn).toBeUndefined()
  })

  test("on: the user remembers a note, confirms a pending one, and retracts", async () => {
    userConfig({ memory: { enabled: true } })
    const harness = await start([[script.text("Noted.")]])
    const sessionId = await harness.newSession()
    const before = await ext<MemoryStateResult>(harness, EXT.memory, { sessionId })
    expect(before.off).toContain("Send a message")
    expect(before.startsWithFirstTurn).toBe(true)
    // A note written now is not saved yet and not dropped either: the client is told to keep it until the session has started.
    const early = await ext<{ ok: boolean; id: string | null; message: string; deferred?: boolean }>(harness, EXT.memoryChange, { sessionId, action: "remember", text: "Build with pnpm." })
    expect(early).toMatchObject({ ok: false, id: null, deferred: true })
    expect(early.message).toContain("this session's notes are read when it starts its first turn: nothing is saved yet. The note is kept and saved as soon as your first message is sent")
    expect((await ext<{ deferred?: boolean; message: string }>(harness, EXT.memoryChange, { sessionId, action: "retract", id: "m_x" })).message).toBe(before.off!)
    await prompt(harness, sessionId, "Hello.")
    const empty = await ext<MemoryStateResult>(harness, EXT.memory, { sessionId })
    expect(empty).toMatchObject({ enabled: true, notes: [], pending: [], problems: [] })

    const saved = await ext<{ ok: boolean; id: string; message: string }>(harness, EXT.memoryChange, { sessionId, action: "remember", text: "This repository uses pnpm, never npm." })
    expect(saved.ok).toBe(true)
    expect(saved.message).toContain("for this project")
    // A note the model saved after untrusted content, waiting for the user, and a file with a mistake.
    const project = empty.paths!.project!
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, "m_pend0001.md"),
      "---\nid: m_pend0001\nkind: fact\nscope: project\nstatus: pending\ncreated: 2026-11-12T08:00:00Z\nconfirmed: 2026-11-12T08:00:00Z\nexpires: 90d\nauthor: model\nuntrusted: yes\n---\nThe API lives in api/.\n",
    )
    writeFileSync(join(project, "m_bad00001.md"), "---\nid: m_bad00001\ncolour: blue\n---\nx\n")
    const state = await ext<MemoryStateResult>(harness, EXT.memory, { sessionId })
    expect(state.notes).toEqual([expect.objectContaining({ id: saved.id, author: "user", state: "active", scope: "project", text: "This repository uses pnpm, never npm." })])
    expect(state.pending).toEqual([expect.objectContaining({ id: "m_pend0001", text: "The API lives in api/." })])
    expect(state.problems).toEqual([expect.objectContaining({ path: join(project, "m_bad00001.md") })])
    expect(state.review.map((item) => item.reason)).toEqual(expect.arrayContaining(["invalid-file", "pending-confirmation"]))

    expect(await ext(harness, EXT.memoryChange, { sessionId, action: "confirm", id: "m_pend0001" })).toMatchObject({ ok: true, message: "m_pend0001 confirmed: later sessions are given it." })
    expect(await ext(harness, EXT.memoryChange, { sessionId, action: "retract", id: saved.id })).toMatchObject({ ok: true })
    const after = await ext<MemoryStateResult>(harness, EXT.memory, { sessionId })
    expect(after.notes.map((note) => note.id)).toEqual(["m_pend0001"])
    expect(after.pending).toEqual([])
  })
})
