import { afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { type SessionId, brand, openSessionDirectory } from "@windlass/core"
import { E2E_TIMEOUT_MS, script } from "@windlass/core/testing"
import { EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

let h: Harness | null = null
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

/**
 * The command sleeps for a duration nothing else on the machine sleeps for,
 * so the host can tell whether it still runs. The command runs in the
 * sandbox, in a process namespace of its own: the PID it sees for itself is
 * not one the host knows, so the file it writes only says that it started.
 */
const SLEEP = "30.4172"

function alive(_started: number): boolean {
  // The whole command line, so only the command itself matches, not a shell or a wrapper that names it.
  return Bun.spawnSync(["pgrep", "-f", `^sleep ${SLEEP.replace(".", "\\.")}$`]).exitCode === 0
}

async function pidIn(path: string): Promise<number> {
  await until(() => Bun.file(path).size > 0, 10_000, "the command to write its pid")
  await until(() => alive(0), 10_000, "the command to be running")
  return Number((await Bun.file(path).text()).trim())
}

test("cancel mid-command: the prompt answers cancelled after the last update, and the command is stopped", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "shell", { command: "echo $$ > pid.txt; exec sleep 30.4172" })], [script.text("never reached")]],
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

test("cancel_call stops one running command and nothing else: the turn goes on with what it printed, and a call that is not running says why", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "shell", { command: "echo started; echo $$ > pid.txt; exec sleep 30.4172" })], [script.text("The command was stopped; carrying on.")]],
  })
  await h.initialize()
  const harness = h
  const ext = <T>(method: string, params: Record<string, unknown>) => harness.connection.agent.request<T>(method, params)
  const sessionId = await harness.newSession()
  const turn = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait a long time" }] })
  await pidIn(join(harness.workspace, "pid.txt"))
  // A call that is not there is not stopped, and the answer says so.
  expect(await ext(EXT.cancelCall, { sessionId, callId: "call_nope" })).toEqual({ stopped: false, message: "There is no call call_nope in the step in progress. Nothing was stopped." })
  expect(await ext(EXT.cancelCall, { sessionId, callId: "call_1" })).toEqual({ stopped: true, message: null })
  // Asked twice: the first request stands.
  const again = await ext<{ stopped: boolean; message: string | null }>(EXT.cancelCall, { sessionId, callId: "call_1" })
  expect(again.stopped).toBe(false)
  // The turn was not interrupted: the model read the result and answered.
  expect((await turn).stopReason).toBe("end_turn")
  expect(alive(0)).toBe(false)
  const finals = harness.of(sessionId, "tool_call_update").filter((update) => "rawOutput" in update) as Record<string, unknown>[]
  expect(finals.map((update) => [update.status, (update._meta as Record<string, unknown>)[META.outcome]])).toEqual([["failed", "error"]])
  // What it had printed, and that the user stopped it.
  expect(JSON.stringify(finals[0]!.content)).toContain("started")
  expect(JSON.stringify(finals[0]!.content)).toContain("Stopped by the user")
  expect(harness.provider.requests).toHaveLength(2)
  expect(JSON.stringify(harness.provider.requests[1])).toContain("Stopped by the user")
  expect(harness.of(sessionId, "agent_message_chunk").map((update) => (update as { content: { text: string } }).content.text).join("")).toBe("The command was stopped; carrying on.")
  // With no turn running there is no call to stop.
  expect(await ext(EXT.cancelCall, { sessionId, callId: "call_1" })).toEqual({ stopped: false, message: "No turn is running, so no call is. Nothing was stopped." })
})

test("a prompt sent right after a cancel is not withdrawn: it starts the next execution", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "shell", { command: "echo $$ > pid.txt; exec sleep 30.4172" })], [script.text("Fresh answer.")]],
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
  h = await startHarness({ responses: [[script.toolCall("call_1", "shell", { command: "echo $$ > pid.txt; exec sleep 30.4172" })]] })
  await h.initialize()
  const harness = h
  const sessionId = await harness.newSession()
  void harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow" }] }).catch(() => {})
  const pid = await pidIn(join(harness.workspace, "pid.txt"))
  await harness.disconnect()
  expect(alive(pid)).toBe(false)
  // The disconnect let go of the session, though the server process lives on: anyone can open it for writing now.
  const directory = openSessionDirectory({ dataDir: harness.dataDir })
  try {
    directory.open(sessionId as SessionId).close()
    const events = directory.readEvents(sessionId as SessionId)
    expect(events.map((item) => item.type).slice(-2)).toEqual(["synthetic.appended", "execution.interrupted"])
    const interrupted = events.at(-1) as { data: { reason: string } }
    expect(interrupted.data.reason).toBe("shutdown")
    expect(directory.get(sessionId as SessionId)?.session.execution?.status).toBe("suspended")
  } finally {
    directory.close()
  }
  await harness.backend.close()

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
