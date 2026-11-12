import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { script } from "@light-harness/core/testing"
import { SIGN_IN_HINT } from "../src/server.ts"
import { EXT } from "../src/extensions.ts"
import { type Harness, startHarness } from "./helpers.ts"

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

test("session/load replays the stored history as updates, then reports the current state", async () => {
  const first = await start({
    responses: [
      [script.reasoning("Check the file."), script.text("Let me look."), script.toolCall("call_1", "read", { path: "a.txt" })],
      [script.text("It says hi."), script.usage({ inputTokens: 50, cachedInputTokens: 10, outputTokens: 5 })],
    ],
  })
  await Bun.write(join(first.workspace, "a.txt"), "hi\n")
  const sessionId = await first.newSession()
  await first.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "read a.txt" }] })
  const live = first.of(sessionId).filter((update) => ["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate))
  await first.disconnect()
  await first.backend.close()

  const second = await start({ dataDir: first.dataDir })
  const response = await second.connection.agent.request(methods.agent.session.load, { sessionId, cwd: first.workspace, mcpServers: [] })
  expect(response.configOptions?.map((option) => option.currentValue)).toEqual(["test-model", "default"])
  const replayed = second.of(sessionId)
  expect(replayed.map((update) => update.sessionUpdate)).toEqual([
    "user_message_chunk",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "tool_call_update",
    "agent_message_chunk",
    "session_info_update",
    "usage_update",
  ])
  expect(replayed[0]).toMatchObject({ content: { type: "text", text: "read a.txt" } })
  // Whole items on replay, under the same message IDs as live.
  const text = (update: unknown) => (update as { messageId: string; content: { text: string } })
  const join_ = (updates: unknown[]) => {
    const byId = new Map<string, string>()
    for (const update of updates) byId.set(text(update).messageId, (byId.get(text(update).messageId) ?? "") + text(update).content.text)
    return [...byId]
  }
  expect(join_(replayed.filter((update) => ["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate)))).toEqual(join_(live))
  expect(replayed[5]).toMatchObject({ status: "completed" })
  expect(replayed.at(-1)).toEqual({ sessionUpdate: "usage_update", used: 55, size: 200_000 })
  // The replay is complete before the response.
  const responseIndex = second.wire.findIndex((message) => "result" in message && (message.result as Record<string, unknown>).configOptions !== undefined)
  const lastUpdate = second.wire.findLastIndex((message) => message.method === "session/update")
  expect(lastUpdate).toBeLessThan(responseIndex)
  expect(second.ext.filter((note) => note.method === EXT.state).map((note) => note.params.state)).toEqual(["idle"])

  // Resume does not replay.
  const third = await start({ dataDir: first.dataDir })
  await second.disconnect()
  await second.backend.close()
  await third.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: first.workspace })
  expect(third.of(sessionId).map((update) => update.sessionUpdate)).toEqual(["session_info_update", "usage_update"])
})

test("session/list, session/close and session/delete (a soft delete: the session is archived, its log stays)", async () => {
  const harness = await start({ responses: [[script.text("one")], [script.text("two")]] })
  const a = await harness.newSession()
  const b = await harness.newSession()
  await harness.connection.agent.request(methods.agent.session.prompt, { sessionId: a, prompt: [{ type: "text", text: "first" }] })
  const listed = await harness.connection.agent.request(methods.agent.session.list, { cwd: harness.workspace })
  expect(listed.sessions.map((session) => session.sessionId).sort()).toEqual([a, b].sort())
  expect(listed.sessions.every((session) => session.cwd === harness.workspace && typeof session.updatedAt === "string")).toBe(true)
  expect((await harness.connection.agent.request(methods.agent.session.list, { cwd: "/elsewhere" })).sessions).toEqual([])

  await harness.connection.agent.request(methods.agent.session.close, { sessionId: b })
  await expect(harness.connection.agent.request(methods.agent.session.prompt, { sessionId: b, prompt: [{ type: "text", text: "x" }] })).rejects.toMatchObject({ code: -32002 })
  await harness.connection.agent.request(methods.agent.session.close, { sessionId: "ses_unknown" })

  await harness.connection.agent.request(methods.agent.session.delete, { sessionId: a })
  expect((await harness.connection.agent.request(methods.agent.session.list, {})).sessions.map((session) => session.sessionId)).toEqual([b])
  await expect(harness.connection.agent.request(methods.agent.session.load, { sessionId: a, cwd: harness.workspace, mcpServers: [] })).rejects.toMatchObject({ code: -32002 })
  // The log is still there.
  expect(harness.backend.engine.readEvents(a as never).map((item) => item.type).at(-1)).toBe("session.archived")
  // Loading a session from another directory is refused rather than run in the wrong place.
  await expect(harness.connection.agent.request(methods.agent.session.load, { sessionId: b, cwd: "/tmp", mcpServers: [] })).rejects.toMatchObject({ code: -32602 })
})

test("signed out: session creation fails with auth-required and says how to sign in", async () => {
  const harness = await start({ signIn: async () => ({ signedIn: false, message: `Not signed in. To sign in, ${SIGN_IN_HINT}.` }) })
  const init = (harness.wire[0] as { result: { authMethods: { id: string }[] } }).result
  expect(init.authMethods.map((method) => method.id)).toEqual(["chatgpt"])
  const attempt = harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [] })
  await expect(attempt).rejects.toMatchObject({ code: -32000 })
  const error = (await attempt.catch((caught: unknown) => caught)) as { message: string }
  expect(error.message).toContain("bun scripts/login.ts start")
  await expect(harness.connection.agent.request(methods.agent.authenticate, { methodId: "chatgpt" })).rejects.toMatchObject({ code: -32000 })
  await expect(harness.connection.agent.request(methods.agent.session.load, { sessionId: "ses_x", cwd: harness.workspace, mcpServers: [] })).rejects.toMatchObject({ code: -32000 })
})

test("a failed turn answers the prompt with an error that says why; signed out mid-session is auth-required", async () => {
  const harness = await start({
    responses: [[script.fail("invalid_request", { message: "The request was malformed: bad tool schema." })], [script.fail("auth", { message: "token rejected" })]],
    engine: { refreshAuth: async () => false },
  })
  const sessionId = await harness.newSession()
  const failed = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] })
  await expect(failed).rejects.toMatchObject({ code: -32603, message: "The request was malformed: bad tool schema." })
  expect(harness.ext.filter((note) => note.method === EXT.state).at(-1)?.params).toMatchObject({ state: "idle", stopReason: "error" })
  const signedOut = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "again" }] })
  await expect(signedOut).rejects.toMatchObject({ code: -32000 })
  expect(((await signedOut.catch((caught: unknown) => caught)) as { message: string }).message).toContain("Signed out")
})
