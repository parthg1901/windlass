/**
 * The listing (one listing for all its pages, titles without reading a log)
 * and a setting the engine refuses, over the wire.
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

test("session/list makes one listing for all its pages, and names an untitled session by its first prompt without reading its log", async () => {
  const harness = await start()
  const engine = harness.backend.engine
  for (let index = 0; index < 101; index += 1) await engine.createSession({ cwd: harness.workspace, settings: { model: "test-model", reasoningEffort: null }, title: `s${index}` }).close()
  let listings = 0
  let reads = 0
  const listSessions = engine.listSessions
  const readEvents = engine.readEvents
  Object.assign(engine, {
    listSessions: (query: Parameters<typeof listSessions>[0]) => ((listings += 1), listSessions(query)),
    readEvents: (...args: Parameters<typeof readEvents>) => ((reads += 1), readEvents(...args)),
  })
  const first = await list(harness)
  expect(first.sessions).toHaveLength(100)
  const second = await list(harness, first.nextCursor!)
  expect(second.sessions).toHaveLength(1)
  expect(second.nextCursor ?? null).toBeNull()
  expect(new Set([...first.sessions, ...second.sessions].map((row) => row.sessionId)).size).toBe(101)
  expect(listings).toBe(1)
  expect(reads).toBe(0)
  // A cursor whose listing is no longer kept is served by a listing made again; a cursor that is none is refused.
  expect((await list(harness, "gone:100")).sessions).toHaveLength(1)
  expect(listings).toBe(2)
  await expect(list(harness, "nonsense")).rejects.toMatchObject({ code: -32602 })
})

test("an effort the model does not take is refused in one sentence that names the ones it accepts", async () => {
  const harness = await start({ engine: { listModels: async () => [{ id: "test-model", efforts: ["low", "medium", "high"] }, { id: "other-model", efforts: [] }] } })
  const sentence = 'model test-model does not offer the reasoning effort "extreme"; it accepts: low, medium, high'
  const refused = (error: { code: number; message: string; data?: Record<string, { reason?: string; message?: string }> }) => ({ code: error.code, message: error.message, reason: error.data?.[META.capabilities]?.reason })
  // When the session is created with it.
  const created = harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], _meta: { [META.capabilities]: { effort: "extreme" } } })
  expect(await created.then(() => null, refused)).toEqual({ code: -32602, message: sentence, reason: "unknown_effort" })
  // When the option is set.
  const sessionId = await harness.newSession()
  const set = harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "effort", value: "extreme" })
  expect(await set.then(() => null, refused)).toEqual({ code: -32602, message: sentence, reason: "unknown_effort" })
  // When a session is opened again with it: refused, and the session is not left held.
  await harness.connection.agent.request(methods.agent.session.close, { sessionId })
  const resumed = harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [], _meta: { [META.capabilities]: { effort: "extreme" } } })
  expect(await resumed.then(() => null, refused)).toEqual({ code: -32602, message: sentence, reason: "unknown_effort" })
  await harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [] })
})
