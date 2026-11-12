/**
 * What the server offers beyond ACP's standard updates: the harness's own
 * events to a client that asks for them, how turns end (live, in the prompt
 * response, and on a replay), undo and redo with the hand-edit question as a
 * permission request, withdraw, unarchive, session state, stored events,
 * resolve, diagnostics, the step limit, a shutdown close, and the errors a
 * client can tell apart. Every message the agent writes is checked against
 * the SDK's schemas.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import type { AnyTool, StoredEvent } from "@windlass/core"
import { script } from "@windlass/core/testing"
import { EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

const NS = META.capabilities
const harnesses: Harness[] = []
afterEach(async () => {
  const violations = harnesses.flatMap((harness) => harness.violations)
  for (const harness of harnesses.splice(0).reverse()) await harness.close()
  expect(violations).toEqual([])
})

async function start(options: Parameters<typeof startHarness>[0] = {}) {
  const harness = await startHarness(options)
  harnesses.push(harness)
  await harness.initialize()
  return harness
}

const prompt = (harness: Harness, sessionId: string, text: string, meta?: Record<string, unknown>) =>
  harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }], ...(meta === undefined ? {} : { _meta: meta }) })
const ext = <T = Record<string, unknown>>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request<T>(method, params)
const events = (harness: Harness, sessionId: string) =>
  harness.ext.filter((note) => note.method === EXT.event && note.params.sessionId === sessionId).map((note) => note.params as { event: { type: string; seq?: number }; replay?: boolean })
const turns = (harness: Harness, sessionId: string) => harness.ext.filter((note) => note.method === EXT.turn && note.params.sessionId === sessionId).map((note) => note.params)
const errorOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: { code: number; message: string; data?: Record<string, unknown> }) => error,
  )

/** Checks that run as the project's configuration says, without a file on disk. */
const checking = (command: string, mode: "report" | "gate" = "report") => ({
  loadConfig: async (cwd: string) => ({
    config: { model: null, effort: null, checks: [{ name: "lint", command, timeoutSeconds: 30, when: null }], verify: { mode, maxRounds: 3 } },
    projectDir: cwd,
  }),
})

const WRITE: Parameters<typeof startHarness>[0] = {
  responses: [[script.toolCall("call_1", "write", { path: "notes.md", content: "# Notes\n\n- reviewed\n" })], [script.text("Added the line.")]],
}

describe("the harness's own events, for a client that asks", () => {
  test("events: true sends every event as it is, in order, beside the standard updates", async () => {
    const harness = await start({ ...WRITE, clientCapabilities: { _meta: { [NS]: { events: true } } } })
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "add a line")
    const received = events(harness, sessionId).map((note) => note.event)
    // From the session's first event, as the engine's own stream has it; deltas included.
    expect(received[0]!.type).toBe("session.created")
    expect(received.map((item) => item.type)).toContain("tool.input.delta")
    expect(received.map((item) => item.type)).toContain("workspace.changes")
    expect(received.at(-1)!.type).toBe("execution.succeeded")
    const durable = received.filter((item): item is StoredEvent => "seq" in item)
    expect(durable.map((item) => item.seq)).toEqual(durable.map((_, index) => index + 1))
    expect(durable).toEqual([...harness.backend.engine.readEvents(sessionId as never)])
    expect(harness.of(sessionId, "tool_call").length).toBe(1)
  })

  test("updates: false leaves the standard updates out; the prompt is still answered", async () => {
    const harness = await start({ ...WRITE, clientCapabilities: { _meta: { [NS]: { events: true, updates: false } } } })
    const sessionId = await harness.newSession()
    const response = await prompt(harness, sessionId, "add a line")
    expect(response.stopReason).toBe("end_turn")
    expect(harness.updates).toEqual([])
    expect(events(harness, sessionId).length).toBeGreaterThan(10)
  })

  test("an ordinary client gets no events", async () => {
    const harness = await start(WRITE)
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "add a line")
    expect(events(harness, sessionId)).toEqual([])
    expect(harness.of(sessionId).length).toBeGreaterThan(3)
  })

  test("session/load replays the stored log as events marked replay; resume sends only what the open appended", async () => {
    const first = await start({ ...WRITE, clientCapabilities: { _meta: { [NS]: { events: true } } } })
    const sessionId = await first.newSession()
    await prompt(first, sessionId, "add a line")
    await first.disconnect()
    await first.backend.close()

    const second = await start({ dataDir: first.dataDir, clientCapabilities: { _meta: { [NS]: { events: true } } } })
    await second.connection.agent.request(methods.agent.session.load, { sessionId, cwd: first.workspace, mcpServers: [] })
    const replayed = events(second, sessionId)
    expect(replayed.every((note) => note.replay === true)).toBe(true)
    expect(replayed.map((note) => note.event)).toEqual([...second.backend.engine.readEvents(sessionId as never)])
    await second.connection.agent.request(methods.agent.session.close, { sessionId })

    const third = await start({ dataDir: first.dataDir, clientCapabilities: { _meta: { [NS]: { events: true } } } })
    await third.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: first.workspace, mcpServers: [] })
    expect(events(third, sessionId)).toEqual([])
  })
})

describe("how a turn ended", () => {
  test("not configured: <prefix>/turn and the prompt response's _meta say so, with the changed files", async () => {
    const harness = await start(WRITE)
    const sessionId = await harness.newSession()
    const response = await prompt(harness, sessionId, "add a line")
    expect(response._meta?.[NS]).toMatchObject({ outcome: "succeeded", stopReason: "end_turn", verification: { status: "not_configured" }, changedFiles: ["notes.md"] })
    expect(turns(harness, sessionId)).toEqual([expect.objectContaining({ outcome: "succeeded", verification: { status: "not_configured" }, changedFiles: ["notes.md"] })])
  })

  test("passed: the checks' evidence comes with it", async () => {
    const harness = await start({ ...WRITE, engine: checking("true") })
    const sessionId = await harness.newSession()
    const response = await prompt(harness, sessionId, "add a line")
    const turn = response._meta?.[NS] as { outcome: string; verification: { status: string; evidence: { checks: { name: string; status: string }[] } } }
    expect(turn.outcome).toBe("succeeded")
    expect(turn.verification.status).toBe("passed")
    expect(turn.verification.evidence.checks.map((check) => [check.name, check.status])).toEqual([["lint", "passed"]])
  })

  test("unresolved: done, but the checks still fail, and why", async () => {
    const harness = await start({ ...WRITE, engine: checking("echo nope; exit 1") })
    const sessionId = await harness.newSession()
    const response = await prompt(harness, sessionId, "add a line")
    expect(response.stopReason).toBe("end_turn")
    expect(response._meta?.[NS]).toMatchObject({ outcome: "unresolved", verification: { status: "unresolved", reason: "report_mode", failing: ["lint"] } })
  })

  test("session/load replays how every earlier turn ended, marked replay, with the files each changed (none here)", async () => {
    const first = await start({
      responses: [[script.text("One.")], [script.toolCall("call_1", "shell", { command: "sleep 20" })]],
    })
    const sessionId = await first.newSession()
    await prompt(first, sessionId, "first")
    const second = prompt(first, sessionId, "second")
    await until(() => first.of(sessionId, "tool_call_update").some((update) => (update as { status?: string }).status === "in_progress"), 5000, "the command")
    await first.connection.agent.notify(methods.agent.session.cancel, { sessionId })
    expect((await second).stopReason).toBe("cancelled")
    await first.disconnect()
    await first.backend.close()

    const loader = await start({ dataDir: first.dataDir })
    await loader.connection.agent.request(methods.agent.session.load, { sessionId, cwd: first.workspace, mcpServers: [] })
    expect(turns(loader, sessionId).map((turn) => [turn.outcome, turn.stopReason, turn.reason ?? null, turn.changedFiles, turn.replay])).toEqual([
      ["succeeded", "end_turn", null, [], true],
      ["interrupted", "cancelled", "user", [], true],
    ])
    // A load also reads each turn's snapshots: on two loaded cores this took over the default 10 s.
  }, 30_000)

  test("the step limit: _meta maxSteps on the prompt ends the turn at max_turn_requests", async () => {
    const harness = await start({ responses: [[script.toolCall("call_1", "ls", {})], [script.text("Stopping.")]] })
    const sessionId = await harness.newSession()
    const response = await prompt(harness, sessionId, "look", { [META.maxSteps]: 1 })
    expect(response.stopReason).toBe("max_turn_requests")
    const bad = await errorOf(prompt(harness, sessionId, "look", { [META.maxSteps]: 0 }))
    expect(bad?.code).toBe(-32602)
  })
})

describe("undo and redo", () => {
  async function edited(onPermission?: Parameters<typeof startHarness>[0] extends infer O ? (O extends { onPermission?: infer P } ? P : never) : never) {
    const harness = await start({ ...WRITE, ...(onPermission === undefined ? {} : { onPermission }) })
    await Bun.write(join(harness.workspace, "notes.md"), "# Notes\n")
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "add a line")
    // The user edits the file by hand after the turn.
    writeFileSync(join(harness.workspace, "notes.md"), "# Notes\n\nmine\n")
    return { harness, sessionId, notes: () => readFileSync(join(harness.workspace, "notes.md"), "utf8") }
  }

  test("a dry run previews; handEdits abort changes nothing and says which files were edited by hand", async () => {
    const { harness, sessionId, notes } = await edited()
    const preview = await ext<{ kind: string; plan: { changes: { path: string; handEdited: boolean }[] } }>(harness, EXT.revert, { sessionId, dryRun: true })
    expect(preview.kind).toBe("preview")
    expect(preview.plan.changes).toEqual([expect.objectContaining({ path: "notes.md", handEdited: true })])
    const aborted = await ext<{ kind: string }>(harness, EXT.revert, { sessionId, handEdits: "abort" })
    expect(aborted.kind).toBe("hand_edited")
    expect(notes()).toBe("# Notes\n\nmine\n")
    expect(harness.permissions).toEqual([])
  })

  test("ask (the default) puts the question as session/request_permission; overwrite restores, and the redo brings the edit back", async () => {
    const { harness, sessionId, notes } = await edited(() => ({ outcome: { outcome: "selected", optionId: "overwrite" } }))
    const reverted = await ext<{ kind: string }>(harness, EXT.revert, { sessionId })
    expect(reverted.kind).toBe("reverted")
    expect(notes()).toBe("# Notes\n")
    const [asked] = harness.permissions
    expect(asked!.options.map((option) => [option.optionId, option.kind])).toEqual([
      ["overwrite", "allow_once"],
      ["keep", "allow_once"],
      ["cancel", "reject_once"],
    ])
    expect(asked!.toolCall.locations).toEqual([{ path: join(harness.workspace, "notes.md") }])
    expect((asked!._meta?.[NS] as { command: string; handEdited: string[] }).handEdited).toEqual(["notes.md"])
    const state = await ext<{ canRedo: boolean }>(harness, EXT.session, { sessionId })
    expect(state.canRedo).toBe(true)
    const redone = await ext<{ kind: string }>(harness, EXT.undoRevert, { sessionId, handEdits: "abort" })
    expect(redone.kind).toBe("reverted")
    expect(notes()).toBe("# Notes\n\nmine\n")
  })

  test("a cancelled or declined question changes nothing", async () => {
    const { harness, sessionId, notes } = await edited(() => ({ outcome: { outcome: "selected", optionId: "cancel" } }))
    const declined = await ext<{ kind: string }>(harness, EXT.revert, { sessionId, handEdits: "ask" })
    expect(declined.kind).toBe("hand_edited")
    expect(notes()).toBe("# Notes\n\nmine\n")
    expect(harness.permissions).toHaveLength(1)
  })

  test("keep restores the rest and leaves the hand edits", async () => {
    const { harness, sessionId, notes } = await edited(() => ({ outcome: { outcome: "selected", optionId: "keep" } }))
    expect((await ext<{ kind: string }>(harness, EXT.revert, { sessionId })).kind).toBe("reverted")
    expect(notes()).toBe("# Notes\n\nmine\n")
  })

  test("bad params are refused", async () => {
    const harness = await start()
    const sessionId = await harness.newSession()
    expect((await errorOf(ext(harness, EXT.revert, { sessionId, handEdits: "maybe" })))?.code).toBe(-32602)
    expect((await errorOf(ext(harness, EXT.revert, { sessionId: "ses_nope" })))?.code).toBe(-32002)
  })
})

describe("sessions", () => {
  test("withdraw takes back a queued message that was not delivered", async () => {
    const harness = await start({ responses: [[script.toolCall("call_1", "shell", { command: "sleep 2" })], [script.text("Done.")]] })
    const sessionId = await harness.newSession()
    const running = prompt(harness, sessionId, "wait")
    await until(() => harness.of(sessionId, "tool_call_update").some((update) => (update as { status?: string }).status === "in_progress"), 5000, "the command")
    const { messageId } = await ext<{ messageId: string }>(harness, EXT.queue, { sessionId, prompt: [{ type: "text", text: "then this" }] })
    expect((await ext<{ inbox: { messageId: string }[] }>(harness, EXT.session, { sessionId })).inbox.map((item) => item.messageId)).toEqual([messageId])
    expect(await ext(harness, EXT.withdraw, { sessionId, messageId })).toEqual({ withdrawn: true })
    expect(await ext(harness, EXT.withdraw, { sessionId, messageId })).toEqual({ withdrawn: false })
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId })
    await running
    const stored = await ext<{ events: StoredEvent[] }>(harness, EXT.events, { sessionId })
    expect(stored.events.map((item) => item.type)).toContain("inbox.cancelled")
  })

  test("session state, stored events from a point, and resolve by a prefix or as the latest in a directory", async () => {
    const harness = await start({ responses: [[script.text("Hi.")]] })
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "hello")
    const state = await ext<Record<string, unknown>>(harness, EXT.session, { sessionId })
    expect(state).toMatchObject({ sessionId, state: "idle", cwd: harness.workspace, model: "test-model", archived: false, inbox: [], canUndo: true, canRedo: false })
    const all = (await ext<{ events: StoredEvent[] }>(harness, EXT.events, { sessionId })).events
    const later = (await ext<{ events: StoredEvent[] }>(harness, EXT.events, { sessionId, afterSeq: 3, limit: 2 })).events
    expect(later.map((item) => item.seq)).toEqual([4, 5])
    expect(all.length).toBeGreaterThan(5)
    expect(await ext(harness, EXT.resolve, { cwd: harness.workspace, session: sessionId.slice(0, 10) })).toEqual({ sessionId, cwd: harness.workspace })
    expect(await ext(harness, EXT.resolve, { cwd: harness.workspace })).toEqual({ sessionId, cwd: harness.workspace })
    const none = await errorOf(ext(harness, EXT.resolve, { cwd: "/nowhere/at/all" }))
    expect(none?.data?.[NS]).toEqual({ reason: "session_not_found", message: "there is no session to continue in /nowhere/at/all" })
    const unknown = await errorOf(ext(harness, EXT.resolve, { cwd: harness.workspace, session: "ses_nope" }))
    expect((unknown?.data?.[NS] as { reason: string }).reason).toBe("session_not_found")
  })

  test("delete archives; the listing shows archived sessions on request; unarchive brings it back", async () => {
    const harness = await start()
    const sessionId = await harness.newSession()
    const listed = async (meta?: Record<string, unknown>) =>
      (await harness.connection.agent.request(methods.agent.session.list, { cwd: harness.workspace, ...(meta === undefined ? {} : { _meta: meta }) })).sessions.map((info) => [
        info.sessionId,
        (info._meta?.[NS] as { archived?: boolean }).archived ?? false,
      ])
    await harness.connection.agent.request(methods.agent.session.delete, { sessionId })
    expect(await listed()).toEqual([])
    expect(await listed({ [NS]: { archived: true } })).toEqual([[sessionId, true]])
    await ext(harness, EXT.unarchive, { sessionId })
    expect(await listed()).toEqual([[sessionId, false]])
  })

  test("session/new with a model in _meta starts with it; an unknown one is refused with the engine's sentence", async () => {
    const harness = await start({ engine: { listModels: async () => ["test-model", "other-model"] } })
    const created = await harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], _meta: { [NS]: { model: "other-model", effort: "low" } } })
    expect(harness.backend.engine.getSession(created.sessionId as never)?.session.settings).toEqual({ model: "other-model", reasoningEffort: "low" })
    const refused = await errorOf(harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], _meta: { [NS]: { model: "nope" } } }))
    expect(refused?.code).toBe(-32602)
    expect(refused?.data?.[NS]).toEqual({ reason: "unknown_model", message: "model nope is not available; choose one of: test-model, other-model" })
  })

  test("session/resume with a model in _meta switches to it durably", async () => {
    const first = await start({ responses: [[script.text("Hi.")]] })
    const sessionId = await first.newSession()
    await first.connection.agent.request(methods.agent.session.close, { sessionId })
    await first.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: first.workspace, mcpServers: [], _meta: { [NS]: { model: "other-model" } } })
    const stored = first.backend.engine.readEvents(sessionId as never)
    expect(stored.at(-1)).toMatchObject({ type: "settings.changed", data: { model: "other-model", reasoningEffort: null } })
  })

  test("session/close with _meta shutdown stops running work as a shutdown, sends all of it first, and the session resumes later", async () => {
    const harness = await start({ responses: [[script.toolCall("call_1", "shell", { command: "sleep 20" })]], clientCapabilities: { _meta: { [NS]: { events: true } } } })
    const sessionId = await harness.newSession()
    const running = prompt(harness, sessionId, "wait")
    await until(() => events(harness, sessionId).some((note) => note.event.type === "tool.started"), 5000, "the command")
    await harness.connection.agent.request(methods.agent.session.close, { sessionId, _meta: { [NS]: { shutdown: true } } })
    const received = events(harness, sessionId).map((note) => note.event.type)
    expect(received.slice(received.indexOf("execution.interrupt_requested")).at(-1)).toBe("execution.interrupted")
    expect((await running).stopReason).toBe("cancelled")
    const stored = harness.backend.engine.readEvents(sessionId as never)
    expect(stored.find((item) => item.type === "execution.interrupted")?.data).toMatchObject({ reason: "shutdown" })
    await harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [] })
    expect(harness.ext.filter((note) => note.method === EXT.state).at(-1)?.params.state).toBe("suspended")
  })
})

describe("diagnostics and errors", () => {
  test("a tool that throws is a diagnostic: <prefix>/diagnostic, and a notice for a client that shows them", async () => {
    const broken: AnyTool = {
      name: "explode",
      description: "Always throws.",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      execute: async () => {
        throw new Error("the tool is broken")
      },
    }
    const harness = await start({ tools: [broken], responses: [[script.toolCall("call_1", "explode", {})], [script.text("It broke.")]], clientCapabilities: { session: { notices: {} } } })
    const sessionId = await harness.newSession()
    await prompt(harness, sessionId, "try it")
    const diagnostics = harness.ext.filter((note) => note.method === EXT.diagnostic).map((note) => note.params)
    expect(diagnostics).toEqual([{ sessionId, kind: "tool_crashed", message: expect.stringContaining("the tool is broken") }])
    expect(harness.of(sessionId, "notice")).toEqual([expect.objectContaining({ severity: "error", title: "Internal problem (tool crashed)" })])
  })

  test("signed out: auth required, with the harness's sentence under the extension key", async () => {
    const harness = await start({ signIn: async () => ({ signedIn: false, message: "Not signed in." }) })
    const refused = await errorOf(harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [] }))
    expect(refused?.code).toBe(-32000)
    expect(refused?.data).toMatchObject({ methodId: "chatgpt", [NS]: { reason: "auth_required", message: "Not signed in." } })
  })

  test("a session another process holds: the engine's sentence, the reason and the holder's pid", async () => {
    const harness = await start()
    const sessionId = await harness.newSession()
    await harness.connection.agent.request(methods.agent.session.close, { sessionId })
    const holder = Bun.spawn(
      [process.execPath, "-e", `import { createHarness } from "@windlass/core"; import { FakeProvider } from "@windlass/core/testing"; const h = createHarness({ dataDir: ${JSON.stringify(harness.dataDir)}, provider: new FakeProvider([]), log: () => {} }); h.engine.openSession(${JSON.stringify(sessionId)}); console.log("held"); for await (const _ of Bun.stdin.stream()) {} await h.close()`],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: import.meta.dir },
    )
    try {
      await holder.stdout.getReader().read()
      const refused = await errorOf(harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [] }))
      expect(refused?.data?.[NS]).toMatchObject({ reason: "session_in_use", holderPid: holder.pid })
      expect(refused?.message).toContain(`pid ${holder.pid}`)
    } finally {
      holder.stdin.end()
      await holder.exited
    }
  })
})
