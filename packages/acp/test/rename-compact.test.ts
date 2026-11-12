/**
 * A title and a compaction a user asks for, over the wire: `<prefix>/rename`
 * and `<prefix>/compact`.
 */
import { afterEach, expect, test } from "bun:test"
import { methods } from "@agentclientprotocol/sdk"
import { script } from "@windlass/core/testing"
import { SUMMARY } from "../../core/test/scenarios/script.ts"
import type { CompactResult } from "../src/extensions.ts"
import { EXT, META } from "../src/extensions.ts"
import { TurnTracker } from "../src/turns.ts"
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

const request = <T>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request(method as never, params as never) as Promise<T>
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const at = (tokens: number) => script.usage({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0 })
const list = (harness: Harness, cursor?: string) => harness.connection.agent.request(methods.agent.session.list, { cwd: harness.workspace, ...(cursor === undefined ? {} : { cursor }) })

test("rename: the title as the engine stores it, told to the client and listed; an empty one is refused", async () => {
  const harness = await start({ responses: [[script.text("Hello.")]] })
  const sessionId = await harness.newSession()
  expect(((await harness.initialize()) as { agentCapabilities: { _meta: Record<string, { methods: string[] }> } }).agentCapabilities._meta[META.capabilities]!.methods).toEqual(expect.arrayContaining([EXT.rename, EXT.compact, EXT.agents]))
  // Untitled, it is named by the first thing the user said.
  await prompt(harness, sessionId, "Say hello to the team.\nAnd more below.")
  expect((await list(harness)).sessions[0]!.title).toBe("Say hello to the team.")
  expect(await request<{ title: string }>(harness, EXT.rename, { sessionId, title: "  Fix the\nlogin test " })).toEqual({ title: "Fix the login test" })
  expect(harness.of(sessionId, "session_info_update").at(-1)).toMatchObject({ title: "Fix the login test" })
  expect((await list(harness)).sessions[0]!.title).toBe("Fix the login test")
  expect(await request<{ title: string }>(harness, EXT.session, { sessionId })).toMatchObject({ title: "Fix the login test" })
  await expect(request(harness, EXT.rename, { sessionId, title: "   " })).rejects.toMatchObject({ code: -32602, message: "a session's title cannot be empty" })
  await expect(request(harness, EXT.rename, { sessionId })).rejects.toMatchObject({ code: -32602 })
})

test("compact: says there is nothing worth compacting, then compacts with the sizes; the run it took is not reported as a turn", async () => {
  const harness = await start({
    responses: [[script.text("One."), at(3000)], [script.text("Two."), at(3200)], [script.text(SUMMARY)], [script.text("Three."), at(900)]],
    engine: { limits: { manualCompactionMinTokens: 0 } },
  })
  const sessionId = await harness.newSession()
  expect(await request<CompactResult>(harness, EXT.compact, { sessionId })).toEqual({ kind: "nothing", message: "There is nothing to compact: the conversation has not started." })
  await prompt(harness, sessionId, "First.")
  await prompt(harness, sessionId, "Second.")
  const turnsBefore = harness.ext.filter((item) => item.method === EXT.turn).length
  const result = await request<CompactResult>(harness, EXT.compact, { sessionId })
  expect(result).toMatchObject({ kind: "compacted", source: "model", detail: null })
  if (result.kind !== "compacted") throw new Error("not compacted")
  // The sizes are the engine's estimates of the next request, before and after.
  expect(result.tokensBefore).toBeGreaterThan(0)
  expect(result.tokensAfter).toBeGreaterThan(0)
  // Its events were sent before the answer: the session is idle again, and no turn ending was reported for it.
  expect(harness.ext.filter((item) => item.method === EXT.state).map((item) => item.params.state).slice(-2)).toEqual(["running", "idle"])
  expect(harness.ext.filter((item) => item.method === EXT.turn)).toHaveLength(turnsBefore)
  // Nor is it one of the session's turns as a person counts them.
  const stored = await request<{ events: { seq: number; type: string; data?: unknown }[] }>(harness, EXT.events, { sessionId })
  expect(stored.events.map((item) => item.type)).toEqual(expect.arrayContaining(["compaction.started", "compaction.ended"]))
  const tracker = new TurnTracker()
  for (const item of stored.events) tracker.add(item)
  expect(tracker.turns.map((turn) => turn.prompt)).toEqual(["First.", "Second."])
  // Asked again right away: nothing is left to take out, and it says so.
  expect((await request<CompactResult>(harness, EXT.compact, { sessionId })).kind).toBe("nothing")
  // The next turn is a turn like any other.
  expect((await prompt(harness, sessionId, "Third.")).stopReason).toBe("end_turn")
  expect(harness.ext.filter((item) => item.method === EXT.turn)).toHaveLength(turnsBefore + 1)
})
