/**
 * Watches on a background command's output, over the wire: `<prefix>/watch`
 * sets one on a command that is running (refused with the engine's
 * sentence), `<prefix>/watches` lists them, `<prefix>/unwatch` removes one,
 * and a firing reaches the model as a harness message, never as the user's.
 * The command is real and prints its lines over time.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { methods } from "@agentclientprotocol/sdk"
import { script } from "@windlass/core/testing"
import { EXT, META, type WatchSetResult, type WatchesResult } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

setDefaultTimeout(40_000)

let h: Harness | null = null
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

const NS = META.capabilities
const COMMAND = "echo booting; sleep 1.2; echo 'Server listening on http://localhost:3000'; sleep 37.3119"

test("a watch is set on a running command, listed, fires as a harness message that wakes the session, and can be removed; what the engine refuses is said in its sentence", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "shell", { command: COMMAND, background: true })], [script.text("Started the server.")], [script.text("It is up.")]],
    clientCapabilities: { _meta: { [NS]: { events: true } } },
  })
  await h.initialize()
  const harness = h
  const ext = <T>(method: string, params: Record<string, unknown>) => harness.connection.agent.request<T>(method, params)
  const events = () => harness.ext.filter((note) => note.method === EXT.event).map((note) => (note.params as { event: { type: string; data: Record<string, unknown> } }).event)
  const sessionId = await harness.newSession()
  await harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Start the server in the background." }] })

  const listed = await ext<WatchesResult>(EXT.watches, { sessionId })
  expect(listed.commands).toEqual([expect.objectContaining({ command: COMMAND, watches: [] })])
  const spawnId = listed.commands[0]!.spawnId

  // Refused with the engine's own sentence, and nothing is written.
  const refused = await ext(EXT.watch, { sessionId, command: "bg_nope", pattern: "x" }).catch((error: unknown) => error as { code: number; message: string; data: Record<string, { reason: string; message: string }> })
  expect(refused).toMatchObject({ code: -32602, data: { [NS]: { reason: "invalid_request" } } })
  expect((refused as { message: string }).message).toStartWith("No background command bg_nope is running, so its output cannot be watched")
  expect((refused as { message: string }).message).toContain(`Running: ${spawnId}.`)
  const bad = await ext(EXT.watch, { sessionId, command: spawnId, pattern: "(", regex: true }).catch((error: unknown) => error as { code: number; message: string })
  expect(bad).toMatchObject({ code: -32602 })
  expect((bad as { message: string }).message).toStartWith("The watch was not set.")

  // Set while the command runs: once, for text a later line has; and a second one that is removed again.
  const set = await ext<WatchSetResult>(EXT.watch, { sessionId, command: spawnId, pattern: "listening on" })
  expect(set).toEqual({ watchId: `${spawnId}.w1`, spawnId, pattern: "listening on", regex: false, ignoreCase: false, limit: 1, fired: 0 })
  const other = await ext<WatchSetResult>(EXT.watch, { sessionId, command: spawnId, pattern: "ERROR", regex: true, ignoreCase: true, limit: 3 })
  expect((await ext<WatchesResult>(EXT.watches, { sessionId })).commands[0]!.watches).toEqual([
    { watchId: set.watchId, pattern: "listening on", regex: false, ignoreCase: false, description: 'text "listening on"', limit: 1, fired: 0, watching: true },
    { watchId: other.watchId, pattern: "ERROR", regex: true, ignoreCase: true, description: "pattern /ERROR/i", limit: 3, fired: 0, watching: true },
  ])
  expect(await ext(EXT.unwatch, { sessionId, watchId: other.watchId })).toEqual({ removed: true })
  expect(await ext(EXT.unwatch, { sessionId, watchId: other.watchId })).toEqual({ removed: false })

  // The line comes: the watch fires, its message is a harness message (not a user's), and the idle session answers it.
  await until(() => events().some((item) => item.type === "watch.fired"), 10_000, "the watch to fire")
  await until(() => harness.provider.requests.length === 3, 10_000, "the model to be told")
  const fired = events().find((item) => item.type === "watch.fired")!
  expect(fired.data).toMatchObject({ watchId: set.watchId, spawnId, firing: 1, line: "Server listening on http://localhost:3000" })
  const told = events().find((item) => item.type === "inbox.enqueued" && item.data.messageId === fired.data.messageId)!
  expect(told.data.origin).toBe("background_watch")
  expect(JSON.stringify(harness.provider.requests[2])).toContain("Server listening on http://localhost:3000")
  // The watch is over; the removed one says so; the command still runs.
  await until(() => events().filter((item) => item.type === "execution.succeeded").length === 2, 10_000, "the turn the watch started to end")
  expect((await ext<WatchesResult>(EXT.watches, { sessionId })).commands[0]!.watches.map((watch) => [watch.watchId, watch.fired, watch.watching])).toEqual([
    [set.watchId, 1, false],
    [other.watchId, 0, false],
  ])
})
