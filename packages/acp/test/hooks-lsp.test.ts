/**
 * Hooks and language servers over the wire: a project's hook and a project's
 * language server wait for the user's approval (`<prefix>/hooks`,
 * `<prefix>/hooks_changed`, `<prefix>/lsp`, `<prefix>/lsp_changed`) and are
 * allowed by `<prefix>/hook_approve` and `<prefix>/lsp_approve`; an edited
 * definition is another question; what a hook did to a call, what the
 * language servers said about an edit and a turn that ended with a stop hook
 * unsatisfied reach a client that does not take the harness's events.
 *
 * The configuration is real files under a throwaway `XDG_CONFIG_HOME` and the
 * workspace, read by the same loader the command line uses. The hooks are
 * real commands; the language server is the scripted one of the engine's tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { brand } from "@windlass/core"
import { script } from "@windlass/core/testing"
import { loadConfig, loadConfigSync } from "../../core/src/config/load.ts"
import { EXT, META, type HookRun, type HooksStateResult, type LspStateResult, type ToolDiagnostics, type TurnNotification } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

setDefaultTimeout(40_000)

const NS = META.capabilities
const LSP_SERVER = join(import.meta.dir, "..", "..", "core", "test", "lsp", "fixtures", "server.ts")
const QUICK = { graceMs: 300, backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 } }

let configHome = ""
let saved: string | undefined
beforeAll(() => {
  saved = process.env.XDG_CONFIG_HOME
  configHome = realpathSync(mkdtempSync(join(tmpdir(), "wl-acp-hooks-")))
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

function userConfig(value: unknown): string {
  mkdirSync(join(configHome, brand.directory), { recursive: true })
  writeFileSync(join(configHome, brand.directory, "config.json"), JSON.stringify(value))
  return join(configHome, brand.directory, "config.json")
}

function projectConfig(workspace: string, value: unknown): string {
  const dir = join(workspace, `.${brand.directory}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify(value))
  return join(dir, "config.json")
}

async function start(responses: NonNullable<Parameters<typeof startHarness>[0]>["responses"], before?: (workspace: string) => void, events = false) {
  const harness = await startHarness({
    responses,
    clientCapabilities: { session: { notices: {} }, ...(events ? { _meta: { [NS]: { events: true } } } : {}) },
    engine: { lsp: QUICK, loadConfig: (cwd: string) => loadConfig({ cwd }), loadConfigSync: (cwd: string) => loadConfigSync({ cwd }) },
  })
  harnesses.push(harness)
  before?.(harness.workspace)
  await harness.initialize()
  return harness
}

const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const ext = <T>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request<T>(method, params)
const notes = <T>(harness: Harness, method: string) => harness.ext.filter((note) => note.method === method).map((note) => note.params as unknown as T)
const settledMeta = (harness: Harness, sessionId: string) =>
  harness
    .of(sessionId, "tool_call_update")
    .map((update) => (update as { _meta?: Record<string, unknown> })._meta)
    .filter((meta): meta is Record<string, unknown> => meta !== undefined && meta !== null && META.outcome in meta)

describe("hooks", () => {
  test("a project's hook waits for the user's approval with the engine's question, is skipped until then, and an edited one asks again", async () => {
    let file = ""
    const hook = (command: string) => ({ hooks: { beforeTool: [{ name: "no-secrets", tools: ["write"], command }] } })
    const harness = await start(
      [[script.toolCall("call_1", "write", { path: "a.txt", content: "one\n" })], [script.text("Written.")], [script.text("Again.")]],
      (workspace) => {
        file = projectConfig(workspace, hook("exit 0"))
      },
    )
    const sessionId = await harness.newSession()
    // Told unasked a moment after the session opened: the client has the question before the first message.
    await until(() => notes<HooksStateResult>(harness, EXT.hooksChanged).length > 0, 5000, "the hooks to be announced")
    const announced = notes<HooksStateResult>(harness, EXT.hooksChanged)[0]!
    expect(announced).toMatchObject({ sessionId, available: true, hooks: [{ name: "no-secrets", point: "beforeTool", state: "awaiting_approval", origin: "project", file, command: "exit 0", tools: ["write"], paths: null }] })
    const waiting = announced.hooks[0]!
    expect(waiting.question).toContain(`This project's configuration asks to run a hook "no-secrets" before a tool call`)
    expect(waiting.question).toContain("    exit 0")
    expect(waiting.question).toContain("It applies to the tools write.")
    expect(waiting.question).toContain("If the hook is changed, you will be asked again.")
    // Said once by the engine, as something for the user and not as a failure of the harness.
    const said = harness.of(sessionId, "notice")
    expect(said).toEqual([expect.objectContaining({ severity: "warning", title: "Hooks", description: expect.stringContaining("It is not run: a hook a project names runs only after you approve it.") })])

    // Not approved: the call runs as if the hook were not there.
    await prompt(harness, sessionId, "Write the file.")
    expect(settledMeta(harness, sessionId)).toEqual([{ [META.outcome]: "success" }])

    expect((await ext<{ approved: boolean }>(harness, EXT.hookApprove, { sessionId, fingerprint: "0".repeat(64) })).approved).toBe(false)
    const approved = await ext<{ approved: boolean; hooks: HooksStateResult["hooks"] }>(harness, EXT.hookApprove, { sessionId, fingerprint: waiting.fingerprint })
    expect(approved.approved).toBe(true)
    expect(approved.hooks).toEqual([expect.objectContaining({ name: "no-secrets", state: "in_force", question: null })])
    // The engine says that the hooks changed, so the client is told before the approval is answered: nothing waits for a timer.
    const told = harness.wire.findIndex((message) => message.method === EXT.hooksChanged && (message.params as unknown as HooksStateResult).hooks[0]?.state === "in_force")
    const answered = harness.wire.findIndex((message) => (message.result as { approved?: boolean } | undefined)?.approved === true)
    expect(told).toBeGreaterThan(-1)
    expect(told).toBeLessThan(answered)
    // And told once: the same state is not announced again while nothing changes.
    await Bun.sleep(700)
    expect(notes<HooksStateResult>(harness, EXT.hooksChanged).filter((state) => state.hooks[0]?.state === "in_force")).toHaveLength(1)

    // The same hook with another command is another hook: the next turn reads it and it waits again.
    projectConfig(harness.workspace, hook("exit 2"))
    await prompt(harness, sessionId, "And again.")
    await until(() => notes<HooksStateResult>(harness, EXT.hooksChanged).at(-1)?.hooks[0]?.command === "exit 2", 5000, "the edited hook to be announced")
    const edited = notes<HooksStateResult>(harness, EXT.hooksChanged).at(-1)!.hooks[0]!
    expect(edited.state).toBe("awaiting_approval")
    expect(edited.fingerprint).not.toBe(waiting.fingerprint)
  })

  test("a refusal, a note, a hook that cannot answer and an unsatisfied stop hook reach a client without the harness's events", async () => {
    const file = userConfig({
      hooks: {
        beforeTool: [{ name: "no-secrets", tools: ["write"], paths: ["secret.txt"], command: "echo 'Secrets are not written here.'; exit 2" }],
        afterTool: [
          { name: "reminder", tools: ["write"], paths: ["a.txt"], command: "echo 'Run the formatter before you finish.'; echo 'checked a.txt' >&2; exit 2" },
          { name: "broken", tools: ["write"], paths: ["a.txt"], command: "echo oops >&2; exit 7" },
        ],
        stop: [{ name: "never-done", command: "echo 'Not yet.'; exit 2" }],
        maxStopRounds: 1,
      },
    })
    const harness = await start([
      [script.toolCall("call_1", "write", { path: "secret.txt", content: "x\n" }), script.toolCall("call_2", "write", { path: "a.txt", content: "one\n" })],
      [script.text("Done.")],
      [script.text("Done again.")],
    ])
    const sessionId = await harness.newSession()
    const answer = (await prompt(harness, sessionId, "Write both files.")) as { stopReason: string; _meta?: Record<string, { hooks?: unknown }> }

    const [refused, noted] = settledMeta(harness, sessionId)
    expect(refused![META.outcome]).toBe("error")
    expect(refused![META.hooks] as HookRun[]).toEqual([{ point: "beforeTool", name: "no-secrets", origin: "user", answer: "no", failure: null, toModel: "Secrets are not written here.", forUser: "" }])
    expect(noted![META.outcome]).toBe("success")
    const runs = noted![META.hooks] as HookRun[]
    expect(runs).toEqual([
      expect.objectContaining({ point: "afterTool", name: "reminder", answer: "no", toModel: "Run the formatter before you finish.", forUser: expect.stringContaining("checked a.txt") }),
      expect.objectContaining({ point: "afterTool", name: "broken", answer: "failed", toModel: null, forUser: expect.stringContaining("oops") }),
    ])
    expect(runs[1]!.failure).toMatch(/7/)

    // The stop hook sent the agent back once, said as it happened; then the turn ended with it unsatisfied.
    const said = harness.of(sessionId, "notice") as unknown as { severity: string; title: string; description: string }[]
    expect(said).toContainEqual(expect.objectContaining({ severity: "warning", title: 'The stop hook "never-done" did not let the turn end', description: "Not yet." }))
    expect(said.filter((notice) => notice.title.startsWith("Internal problem"))).toEqual([])
    const turn = notes<TurnNotification>(harness, EXT.turn).at(-1)!
    // The ending carries what the hook said that last time: nobody was sent back with it.
    expect(turn).toMatchObject({ outcome: "succeeded", hooks: { unsatisfied: ["never-done"], objections: [{ hook: "never-done", text: "Not yet." }] } })
    expect(answer.stopReason).toBe("end_turn")
    expect(answer._meta![NS]!.hooks).toEqual({ unsatisfied: ["never-done"], objections: [{ hook: "never-done", text: "Not yet." }] })

    // The listing says which hook could not answer when it last ran, and why.
    const state = await ext<HooksStateResult>(harness, EXT.hooks, { sessionId })
    expect(state.maxStopRounds).toBe(1)
    expect(state.hooks.map((hook) => [hook.name, hook.point, hook.state, hook.origin, hook.file])).toEqual([
      ["no-secrets", "beforeTool", "in_force", "user", file],
      ["reminder", "afterTool", "in_force", "user", file],
      ["broken", "afterTool", "failed", "user", file],
      ["never-done", "stop", "in_force", "user", file],
    ])
    expect(state.hooks[2]!.error).toMatch(/7/)
  })
})

describe("language servers", () => {
  const server = (flags: readonly string[] = []) => ({ command: process.execPath, args: [LSP_SERVER, ...flags], languages: { plaintext: ["**/*.txt"] } })

  test("a project's server waits for the user's approval; approved, an edit's result says what it made worse", async () => {
    let file = ""
    const harness = await start(
      [
        [script.toolCall("call_1", "write", { path: "a.txt", content: "call(ERROR(old))\n" })],
        [script.text("Written.")],
        [script.toolCall("call_2", "read", { path: "a.txt" })],
        [script.toolCall("call_3", "write", { path: "a.txt", content: "call(ERROR(old))\nfresh(ERROR(fetchUser))\n" })],
        [script.text("Added.")],
      ],
      (workspace) => {
        file = projectConfig(workspace, { lsp: { waitMs: 5000, servers: { fixture: server() } } })
      },
    )
    const sessionId = await harness.newSession()
    await until(() => notes<LspStateResult>(harness, EXT.lspChanged).length > 0, 5000, "the servers to be announced")
    const waiting = notes<LspStateResult>(harness, EXT.lspChanged)[0]!.servers[0]!
    expect(waiting).toMatchObject({ name: "fixture", state: "awaiting_approval", origin: "project", file, languages: [{ languageId: "plaintext", patterns: ["**/*.txt"] }], processes: [] })
    expect(waiting.command).toContain("fixtures/server.ts")
    expect(waiting.question!.subject).toBe(waiting.command)
    // Each argument on its own, for a client that shows where one ends.
    expect(waiting.argv).toEqual([process.execPath, LSP_SERVER])
    expect(waiting.question!.details.join(" ")).toContain("It runs outside the sandbox, with your permissions.")
    // Said once, as information: not as a failure of the harness.
    expect(harness.of(sessionId, "notice")).toEqual([expect.objectContaining({ severity: "info", title: "Language servers" })])

    // Not approved: the edit is recorded as having had no server, and no note is added.
    await prompt(harness, sessionId, "Write the file.")
    const first = settledMeta(harness, sessionId)[0]![META.diagnostics] as ToolDiagnostics
    expect(first).toMatchObject({ noteAdded: false, servers: [{ name: "fixture", origin: "project", outcome: "not_approved" }] })

    expect((await ext<{ approved: boolean }>(harness, EXT.lspApprove, { sessionId, name: "fixture", fingerprint: "0000000000000000" })).approved).toBe(false)
    const approved = await ext<{ approved: boolean; servers: LspStateResult["servers"] }>(harness, EXT.lspApprove, { sessionId, name: "fixture", fingerprint: waiting.question!.fingerprint })
    expect(approved.approved).toBe(true)
    expect(approved.servers).toEqual([expect.objectContaining({ name: "fixture", state: "not_started", question: null })])

    await prompt(harness, sessionId, "Add the call.")
    const metas = settledMeta(harness, sessionId)
    const last = metas.at(-1)![META.diagnostics] as ToolDiagnostics
    // The read started the server; whether it was ready for the edit depends on the machine, and both are said as they are.
    expect(["compared", "timeout"]).toContain(last.servers[0]!.outcome)
    if (last.servers[0]!.outcome === "compared") expect(last).toMatchObject({ noteAdded: true, listed: 1, servers: [{ name: "fixture", new: 1, preExisting: 1 }] })
    await until(() => notes<LspStateResult>(harness, EXT.lspChanged).some((state) => state.servers[0]?.state === "running"), 15_000, "the server to run")
    const running = (await ext<LspStateResult>(harness, EXT.lsp, { sessionId })).servers[0]!
    expect(running).toMatchObject({ name: "fixture", state: "running", error: null, processes: [{ root: harness.workspace, state: "running" }] })
  })

  test("the listing says what is configured and where, a server that cannot start with why, and when diagnostics are off", async () => {
    const file = userConfig({ lsp: { waitMs: 300, servers: { broken: { command: process.execPath, args: ["-e", "console.error('no such grammar'); process.exit(1)"], languages: { plaintext: ["**/*.txt"] }, startupTimeoutSeconds: 2 }, resting: { ...server(), enabled: false } } } })
    const harness = await start([[script.toolCall("call_1", "write", { path: "a.txt", content: "x\n" })], [script.text("Written.")]])
    const sessionId = await harness.newSession()
    const before = await ext<LspStateResult>(harness, EXT.lsp, { sessionId })
    expect(before).toMatchObject({ available: true, off: null, waitMs: 300 })
    expect(before.servers.map((item) => [item.name, item.state, item.origin, item.file])).toEqual([
      ["broken", "not_started", "user", file],
      ["resting", "disabled", "user", file],
    ])
    await prompt(harness, sessionId, "Write the file.")
    await until(() => notes<LspStateResult>(harness, EXT.lspChanged).some((state) => state.servers[0]?.state === "failed"), 15_000, "the failure")
    const failed = notes<LspStateResult>(harness, EXT.lspChanged).findLast((state) => state.servers[0]?.state === "failed")!.servers[0]!
    expect(failed.error).not.toBeNull()
    expect(failed.processes).toEqual([expect.objectContaining({ root: harness.workspace, state: "failed" })])

    userConfig({ lsp: { enabled: false, servers: { fixture: server() } } })
    const off = await ext<LspStateResult>(harness, EXT.lsp, { sessionId })
    expect(off.off).toContain(`"enabled": false`)
  })
})
