/**
 * The listing (a page at a time from the engine, titles without reading a log)
 * and a setting the engine refuses, over the wire.
 */
import { afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { methods } from "@agentclientprotocol/sdk"
import { E2E_TIMEOUT_MS, script } from "@windlass/core/testing"
import { SUMMARY } from "../../core/test/scenarios/script.ts"
import type { CompactResult } from "../src/extensions.ts"
import { EXT, META } from "../src/extensions.ts"
import { TurnTracker } from "../src/turns.ts"
import { type Harness, startHarness } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

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

test("session/list serves each page from the engine and keeps nothing between two: a session that arrives meanwhile changes no later page, and titles need no log", async () => {
  const harness = await start()
  const engine = harness.backend.engine
  for (let index = 0; index < 101; index += 1) await engine.createSession({ cwd: harness.workspace, settings: { model: "test-model", reasoningEffort: null }, title: `s${index}` }).close()
  const pages: (string | null | undefined)[] = []
  let whole = 0
  let reads = 0
  const listSessionsPage = engine.listSessionsPage
  const listSessions = engine.listSessions
  const readEvents = engine.readEvents
  Object.assign(engine, {
    listSessionsPage: (query: Parameters<typeof listSessionsPage>[0]) => (pages.push(query?.cursor), listSessionsPage(query)),
    listSessions: (query: Parameters<typeof listSessions>[0]) => ((whole += 1), listSessions(query)),
    readEvents: (...args: Parameters<typeof readEvents>) => ((reads += 1), readEvents(...args)),
  })
  const first = await list(harness)
  expect(first.sessions).toHaveLength(100)
  // A session started between the two pages is newer than every listed one: it is in no later page, and nothing is listed twice.
  const late = engine.createSession({ cwd: harness.workspace, settings: { model: "test-model", reasoningEffort: null }, title: "late" })
  await late.close()
  const second = await list(harness, first.nextCursor!)
  expect(second.sessions).toHaveLength(1)
  expect(second.nextCursor ?? null).toBeNull()
  const listed = [...first.sessions, ...second.sessions].map((row) => row.sessionId)
  expect(new Set(listed).size).toBe(101)
  expect(listed).not.toContain(late.id)
  // One page asked of the engine per request, with the cursor the client was given; no whole listing, and no log read.
  expect(pages).toEqual([null, first.nextCursor])
  expect(whole).toBe(0)
  expect(reads).toBe(0)
  // The cursor is a place in the order, not a name of something kept: asked again, it gives the same page.
  expect((await list(harness, first.nextCursor!)).sessions.map((row) => row.sessionId)).toEqual(second.sessions.map((row) => row.sessionId))
  // A new listing has the late session at the front.
  expect((await list(harness)).sessions[0]!.sessionId).toBe(late.id)
  await expect(list(harness, "nonsense")).rejects.toMatchObject({ code: -32602 })
  // It makes 102 sessions, each a database written with fsync: on a macOS runner that alone has taken over 5 s.
}, 30_000)

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
