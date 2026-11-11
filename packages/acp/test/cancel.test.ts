import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { brand, openSqliteStore } from "@light-harness/core"
import { script } from "@light-harness/core/testing"
import { EXT, META } from "../src/extensions.ts"
import { DEFAULTS, type Harness, startHarness, until } from "./helpers.ts"

let h: Harness | null = null
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pidIn(path: string): Promise<number> {
  await until(() => Bun.file(path).size > 0, 5000, "the command to write its pid")
  return Number((await Bun.file(path).text()).trim())
}

test("cancel mid-command: the prompt answers cancelled after the last update, and the command is stopped", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "shell", { command: "echo $$ > pid.txt; exec sleep 30" })], [script.text("never reached")]],
  })
  await h.initialize()
  const harness = h
  const sessionId = await harness.newSession()
  const turn = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait a long time" }] })
  const pid = await pidIn(join(harness.workspace, "pid.txt"))
  expect(alive(pid)).toBe(true)
  await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId })
  expect((await turn).stopReason).toBe("cancelled")
  expect(alive(pid)).toBe(false)

  // Nothing about this session arrives after the response.
  await Bun.sleep(300)
  const answered = harness.wire.findIndex((message) => "result" in message && (message.result as { stopReason?: string }).stopReason === "cancelled")
  const later = harness.wire.slice(answered + 1).filter((message) => (message.params as { sessionId?: string } | undefined)?.sessionId === sessionId)
  expect(later).toEqual([])

  const finals = harness.of(sessionId, "tool_call_update").filter((update) => "rawOutput" in update) as Record<string, unknown>[]
  expect(finals.map((update) => [update.status, (update._meta as Record<string, unknown>)[META.outcome]])).toEqual([["failed", "error"]])
  expect(JSON.stringify(finals[0]!.content)).toContain("Interrupted by the user")
  expect(harness.ext.filter((note) => note.method === EXT.state).at(-1)?.params).toMatchObject({ state: "idle", stopReason: "cancelled" })
  expect(harness.provider.requests).toHaveLength(1)
})

test("a prompt sent right after a cancel is not withdrawn: it starts the next execution", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "shell", { command: "echo $$ > pid.txt; exec sleep 30" })], [script.text("Fresh answer.")]],
  })
  await h.initialize()
  const harness = h
  const sessionId = await harness.newSession()
  const first = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow" }] })
  await pidIn(join(harness.workspace, "pid.txt"))
  await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId })
  const second = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "do this instead" }] })
  expect((await first).stopReason).toBe("cancelled")
  expect((await second).stopReason).toBe("end_turn")
  expect(JSON.stringify(harness.provider.requests[1])).toContain("do this instead")
})

test("a client that disconnects mid-turn: the session is shut down resumably and no command is left running", async () => {
  h = await startHarness({ responses: [[script.toolCall("call_1", "shell", { command: "echo $$ > pid.txt; exec sleep 30" })]] })
  await h.initialize()
  const harness = h
  const sessionId = await harness.newSession()
  void harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow" }] }).catch(() => {})
  const pid = await pidIn(join(harness.workspace, "pid.txt"))
  await harness.disconnect()
  expect(alive(pid)).toBe(false)
  expect(harness.backend.isOpen(sessionId)).toBe(false)
  await harness.backend.close()

  const store = openSqliteStore({ path: join(harness.dataDir, DEFAULTS.databaseFile) })
  try {
    const types = store.readEvents(sessionId as never).map((item) => item.type)
    expect(types.slice(-2)).toEqual(["synthetic.appended", "execution.interrupted"])
    const interrupted = store.readEvents(sessionId as never).at(-1) as { data: { reason: string } }
    expect(interrupted.data.reason).toBe("shutdown")
    expect(store.getSession(sessionId as never)?.session.execution?.status).toBe("suspended")
  } finally {
    store.close()
  }

  // A new connection (a restarted process) sees the session suspended, and the next prompt takes the turn up again.
  const again = await startHarness({ dataDir: harness.dataDir, responses: [[script.text("Picked up where we stopped.")]] })
  try {
    await again.initialize()
    await again.connection.agent.request(methods.agent.session.load, { sessionId, cwd: harness.workspace, mcpServers: [] })
    expect(again.ext.filter((note) => note.method === EXT.state).at(-1)?.params).toEqual({ sessionId, state: "suspended" })
    const resumed = await again.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go on" }] })
    expect(resumed.stopReason).toBe("end_turn")
    expect(again.violations).toEqual([])
  } finally {
    await again.close({ keep: true })
  }
})

test(`${brand.name} answers a cancel for an idle or unknown session without effect`, async () => {
  h = await startHarness({ responses: [[script.text("ok")]] })
  await h.initialize()
  const sessionId = await h.newSession()
  await h.connection.agent.notify(methods.agent.session.cancel, { sessionId })
  await h.connection.agent.notify(methods.agent.session.cancel, { sessionId: "ses_nope" })
  expect((await h.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hi" }] })).stopReason).toBe("end_turn")
})
