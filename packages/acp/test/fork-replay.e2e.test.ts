/**
 * Fork and replay over the protocol (`<prefix>/fork`, `<prefix>/replay`), on
 * the real harness with a scripted model. A fork is a new session with the
 * parent's history that is listed, loaded and prompted like any other; a
 * replay streams its session's events after `<prefix>/replay_started` and
 * answers with the report. Every message the agent writes is checked against
 * the SDK's schemas.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { script } from "@windlass/core/testing"
import { EXT, type ForkResult, META, type ReplayResult } from "../src/extensions.ts"
import { type Harness, startHarness } from "./helpers.ts"

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

const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const ext = <T>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request<T>(method, params)
const userTexts = (harness: Harness, index: number) =>
  JSON.stringify(harness.provider.calls[index]!.request.input)
    .match(/"text":"[^"]*"/g)
    ?.map((part) => part.slice(8, -1)) ?? []

describe("fork", () => {
  test("forks at the latest boundary: the fork is listed, loads with the parent's history, and its first prompt carries that history", async () => {
    const h = await start({ responses: [[script.toolCall("c1", "write", { path: "a.txt", content: "one\n" })], [script.text("Wrote a.txt.")], [script.text("In the fork.")]] })
    const parent = await h.newSession()
    await prompt(h, parent, "Write a.txt.")
    const forked = await ext<ForkResult>(h, EXT.fork, { sessionId: parent })
    expect(forked.sessionId).not.toBe(parent)
    expect(forked).toMatchObject({ parentSessionId: parent, cwd: h.workspace, copiedFrom: null, title: "Write a.txt. (fork)", model: "test-model" })
    expect(forked.throughSeq).toBeGreaterThan(1)

    // Listed beside its parent, newest first.
    const listed = await h.connection.agent.request(methods.agent.session.list, { cwd: h.workspace })
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([forked.sessionId, parent])

    // It was let go of: this connection (or any process) opens it, sees the parent's turn, and works in it.
    await h.connection.agent.request(methods.agent.session.load, { sessionId: forked.sessionId, cwd: h.workspace, mcpServers: [] })
    expect(h.of(forked.sessionId, "user_message_chunk")).toHaveLength(1)
    expect((await prompt(h, forked.sessionId, "And now?")).stopReason).toBe("end_turn")
    expect(userTexts(h, 2)).toContain("Write a.txt.")
    expect(userTexts(h, 2)).toContain("And now?")
    // The parent is untouched.
    expect(h.backend.engine.readEvents(parent as never).some((item) => item.type === "inbox.enqueued" && JSON.stringify(item.data).includes("And now?"))).toBe(false)
    // A fork of the fork at a point the fork inherited is a fork of the session that point belongs to, and the answer names it.
    const inherited = await ext<ForkResult>(h, EXT.fork, { sessionId: forked.sessionId, throughSeq: forked.throughSeq })
    expect(inherited.parentSessionId).toBe(parent)
    // At a point of the fork's own, it is the fork's.
    const own = await ext<ForkResult>(h, EXT.fork, { sessionId: forked.sessionId })
    expect(own.parentSessionId).toBe(forked.sessionId)
  })

  test("into a copy of the workspace, with its own model settings; a fork point inside a step is refused with the reason", async () => {
    const h = await start({ responses: [[script.toolCall("c1", "write", { path: "a.txt", content: "one\n" })], [script.text("Wrote a.txt.")]], engine: { listModels: async () => ["test-model", "other-model"] } })
    const parent = await h.newSession()
    await prompt(h, parent, "Write a.txt.")
    const copyTo = join(h.dataDir, "..", "fork-copy")
    const forked = await ext<ForkResult>(h, EXT.fork, { sessionId: parent, workspace: { copyTo }, model: "other-model", effort: null, title: "Try another way" })
    expect(forked).toMatchObject({ cwd: copyTo, copiedFrom: h.workspace, model: "other-model", effort: null, title: "Try another way" })
    expect(readFileSync(join(copyTo, "a.txt"), "utf8")).toBe("one\n")
    rmSync(copyTo, { recursive: true, force: true })

    const inside = h.backend.engine.readEvents(parent as never).find((item) => item.type === "tool.called")!.seq
    const refused = await ext(h, EXT.fork, { sessionId: parent, throughSeq: inside }).catch((error: unknown) => error as { code: number; data: Record<string, { reason: string; message: string }> })
    expect((refused as { code: number }).code).toBe(-32602)
    expect((refused as { data: Record<string, { reason: string }> }).data[NS]!.reason).toBe("invalid_request")
    expect((refused as { data: Record<string, { message: string }> }).data[NS]!.message).toContain("step")
    // An unknown model is checked before anything is made.
    const unknown = await ext(h, EXT.fork, { sessionId: parent, model: "nope" }).catch((error: unknown) => error as { data: Record<string, { reason: string }> })
    expect((unknown as { data: Record<string, { reason: string }> }).data[NS]!.reason).toBe("unknown_model")
    const missing = await ext(h, EXT.fork, { sessionId: "ses_nope" }).catch((error: unknown) => error as { code: number })
    expect((missing as { code: number }).code).toBe(-32002)
  })
})

describe("replay", () => {
  test("streams the replay session's events after replay_started and answers with the report; nothing runs, the recording is untouched", async () => {
    const write = script.toolCall("c1", "write", { path: "a.txt", content: "one\n" })
    const h = await start({
      responses: [[write], [script.text("Wrote a.txt.")], [write], [script.text("Wrote a.txt.")]],
      clientCapabilities: { _meta: { [NS]: { events: true } } },
    })
    const source = await h.newSession()
    await prompt(h, source, "Write a.txt.")
    writeFileSync(join(h.workspace, "a.txt"), "by hand\n")
    const sourceLog = h.backend.engine.readEvents(source as never)

    const result = await ext<ReplayResult>(h, EXT.replay, { sessionId: source, systemPrompt: "You are a careful agent.", ref: "mine" })
    expect(result.report.status).toBe("identical")
    expect(result).toMatchObject({ sourceSessionId: source, policy: "stop", workspace: null, requests: 2 })
    expect(result.text).toStartWith(`replay ${source}: IDENTICAL`)
    // Nothing ran: the hand edit is still there, and the recording's log did not change.
    expect(readFileSync(join(h.workspace, "a.txt"), "utf8")).toBe("by hand\n")
    expect(h.backend.engine.readEvents(source as never)).toEqual(sourceLog)
    // The changed prompt reached the model.
    expect(JSON.stringify(h.provider.calls[2]!.request)).toContain("You are a careful agent.")

    // replay_started came first, naming the replay session; its events followed under that ID, ending with replay.ended.
    const started = h.ext.findIndex((note) => note.method === EXT.replayStarted)
    expect(h.ext[started]!.params).toEqual({ sessionId: result.sessionId, sourceSessionId: source, ref: "mine" })
    const events = h.ext.filter((note, index) => index > started && note.method === EXT.event && note.params.sessionId === result.sessionId).map((note) => (note.params.event as { type: string }).type)
    expect(events[0]).toBe("session.created")
    expect(events.at(-1)).toBe("replay.ended")
    expect(h.ext.slice(0, started).some((note) => note.method === EXT.event && note.params.sessionId === result.sessionId)).toBe(false)
    // A replay session is not listed and was let go of: it can be read but is not open here.
    const listed = await h.connection.agent.request(methods.agent.session.list, { cwd: h.workspace })
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([source])
    expect(await ext(h, EXT.session, { sessionId: result.sessionId }).catch((error: unknown) => (error as { code: number }).code)).toBe(-32002)
    expect(existsSync(join(h.workspace, "b.txt"))).toBe(false)
  })

  test("a replay that leaves the recording says where; a cancel of its session ends it as incomplete; bad options are refused", async () => {
    const h = await start({
      responses: [
        [script.toolCall("c1", "write", { path: "a.txt", content: "one\n" })],
        [script.text("Done.")],
        [script.toolCall("c1", "write", { path: "a.txt", content: "two\n" })],
        [script.text("Thinking"), script.delay(5000)],
      ],
    })
    const source = await h.newSession()
    await prompt(h, source, "Write a.txt.")
    const diverged = await ext<ReplayResult>(h, EXT.replay, { sessionId: source })
    expect(diverged.report.status).toBe("diverged")
    expect(diverged.text).toContain("arguments differ")

    const running = ext<ReplayResult>(h, EXT.replay, { sessionId: source })
    let replayId: string | null = null
    const deadline = Date.now() + 5000
    while (replayId === null && Date.now() < deadline) {
      await Bun.sleep(10)
      const note = h.ext.findLast((item) => item.method === EXT.replayStarted)
      if (note !== undefined && note.params.sessionId !== diverged.sessionId) replayId = note.params.sessionId as string
    }
    expect(replayId).not.toBeNull()
    await Bun.sleep(50)
    await h.connection.agent.notify(methods.agent.session.cancel, { sessionId: replayId! })
    expect((await running).report.status).toBe("incomplete")

    const bad = await ext(h, EXT.replay, { sessionId: source, policy: "everything" }).catch((error: unknown) => error as { code: number })
    expect((bad as { code: number }).code).toBe(-32602)
  })
})
