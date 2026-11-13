/**
 * Live telemetry through the loop, with the scripted provider as the model
 * and a function in place of the collector: which spans are sent and when,
 * that they are the spans an export after the fact derives, who may turn
 * export on, that content stays out unless the user asks for it, and that a
 * collector that is slow, down or wrong never slows or fails a turn.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { TelemetrySetup } from "../../src/engine/telemetry.ts"
import type { SessionId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import type { TelemetryConfig } from "../../src/telemetry/config.ts"
import type { ExportReport } from "../../src/telemetry/exporter.ts"
import { mapSession } from "../../src/telemetry/map.ts"
import { type Span, attr } from "../../src/telemetry/span.ts"
import { mapSessionTree } from "../../src/telemetry/tree.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { waitFor } from "../../src/testing/wait.ts"
import { measured } from "../scenarios/script.ts"
import { Harness, type HarnessOptions, converse, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
const ENDPOINT = "http://collector.invalid:4318"
const ON: ConfigFile = { verify: { mode: "off" }, telemetry: { enabled: true, endpoint: ENDPOINT } }

/** A collector that takes everything, and remembers what it was sent and under which configuration. */
function collector() {
  const batches: Span[][] = []
  const configs: TelemetryConfig[] = []
  const send = async (spans: readonly Span[], config: TelemetryConfig): Promise<ExportReport> => {
    batches.push([...spans])
    configs.push(config)
    return { batches: [], sent: spans.length, failed: 0 }
  }
  return { batches, configs, send, spans: () => batches.flat() }
}

/** A harness whose telemetry goes to `send`, mapped at every closing event so that a test sees each span when it closes. */
function harness(config: { user?: ConfigFile; project?: ConfigFile }, send: TelemetrySetup["send"], more: HarnessOptions = {}, setup: TelemetrySetup = {}) {
  return new Harness({ userConfig: config.user ?? ON, ...(config.project === undefined ? {} : { config: config.project }), telemetry: { mapDelayMs: 0, env: {}, ...(send === undefined ? {} : { send }), ...setup }, ...more })
}

const names = (spans: readonly Span[]) => spans.map((span) => span.name)
const byId = (spans: readonly Span[]) => [...spans].sort((a, b) => (a.spanId < b.spanId ? -1 : 1))
/** What an export after the fact derives from what the session stored. */
const afterTheFact = (h: Harness, id: SessionId = h.session.id) => mapSession({ sessionId: id, events: h.store.readEvents(id), requests: h.store.readRequests(id) }).spans

/** One turn: a read, a write, an answer. */
async function editTurn(h: Harness, prompt = "Change a.ts.") {
  h.provider.enqueue([call("read", { path: "a.ts" }), U], [call("write", { path: "a.ts", content: "export const a = 2" }), U], answer("Changed a.ts."))
  h.tools.on("read", "export const a = 1").on("write", "Wrote a.ts")
  if (h.session === undefined) h.create()
  h.session.send(prompt)
  await h.settled()
}

describe("the spans of a turn", () => {
  test("are the spans an export after the fact derives from the log and the ledger, each sent once", async () => {
    const sink = collector()
    const h = harness({}, sink.send)
    await editTurn(h)
    const sent = sink.spans()
    expect(names(sent).sort()).toEqual(["chat gpt-test", "chat gpt-test", "chat gpt-test", "execute_tool read", "execute_tool write", `invoke_agent ${sent.find((span) => span.parentSpanId === null)!.attributes["gen_ai.agent.name"] as string}`].sort())
    expect(new Set(sent.map((span) => span.spanId)).size).toBe(sent.length)
    expect(sent.every((span) => !span.open)).toBe(true)
    // The same IDs, times, attributes and events: a live span and one exported later never disagree.
    expect(byId(sent)).toEqual(byId(afterTheFact(h)))
    // One trace, rooted in the turn; the model calls and the tool calls are its children.
    const root = sent.find((span) => span.parentSpanId === null)!
    expect(sent.every((span) => span.traceId === root.traceId)).toBe(true)
    expect(sent.filter((span) => span !== root).every((span) => span.parentSpanId === root.spanId)).toBe(true)
    expect(root.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.conversation.id": h.session.id,
      "gen_ai.usage.input_tokens": 3000,
      "gen_ai.usage.output_tokens": 150,
      "gen_ai.usage.cache_read.input_tokens": 2400,
      [attr("execution.outcome")]: "succeeded",
      [attr("execution.steps")]: 3,
      [attr("execution.model_calls")]: 3,
      [attr("execution.tool_calls")]: 2,
    })
    const chats = sent.filter((span) => span.name.startsWith("chat "))
    expect(chats.map((span) => [span.attributes["gen_ai.usage.input_tokens"], span.attributes["gen_ai.response.finish_reasons"], span.attributes[attr("request.outcome")]])).toEqual([
      [1000, ["tool_calls"], "ok"],
      [1000, ["tool_calls"], "ok"],
      [1000, ["stop"], "ok"],
    ])
    expect(sent.find((span) => span.name === "execute_tool write")!.attributes).toMatchObject({ "gen_ai.tool.name": "write", [attr("tool.effect")]: "write", [attr("tool.outcome")]: "success" })
    // A second turn is a second trace, and nothing of the first is sent again.
    await editTurn(h, "And again.")
    const all = sink.spans()
    expect(new Set(all.map((span) => span.spanId)).size).toBe(all.length)
    expect(new Set(all.map((span) => span.traceId)).size).toBe(2)
    expect(byId(all)).toEqual(byId(afterTheFact(h)))
    expect(h.engine.telemetry()).toEqual([{ endpoint: ENDPOINT, queued: 0, dropped: 0, sent: 12, failed: 0 }])
    expect(h.diagnostics).toEqual([])
    h.verify()
    await h.dispose()
  })

  test("are queued as the turn runs: a model call when its step has ended, a tool call when it has settled", async () => {
    const sink = collector()
    const h = harness({}, sink.send)
    const queued: number[] = []
    const seen = () => {
      queued.push(h.engine.telemetry()?.[0]?.queued ?? 0)
      return true
    }
    h.provider.enqueue([call("read", { path: "a.ts" }), U], (() => (seen(), [call("write", { path: "a.ts", content: "x" }), U])) as never, (() => (seen(), answer("Done."))) as never)
    h.tools.on("read", "1").on("write", "Wrote a.ts")
    h.create().send("Change a.ts.")
    await h.settled()
    // When the second request is built: the first call and its read. When the third is: the second call and its write too.
    expect(queued).toEqual([2, 4])
    // Nothing was sent before the turn ended (the flush interval is long), and its ending sent everything at once.
    expect(sink.batches.map((batch) => batch.length)).toEqual([6])
    await h.dispose()
  })

  test("a queue that waits is sent within the flush interval, also in the middle of a turn", async () => {
    const sink = collector()
    const h = harness({}, sink.send, {}, { flushIntervalMs: 5 })
    let midTurn = 0
    h.provider.enqueue([call("read", { path: "a.ts" }), U], answer("Done."))
    h.tools.on("read", "1")
    h.create()
    h.provider.enqueue()
    h.session.send("Read a.ts.")
    await h.settled()
    midTurn = sink.batches.length
    expect(midTurn).toBeGreaterThanOrEqual(1)
    // The last spans go out at the next flush.
    await waitFor(() => sink.spans().length >= 4, { what: "the turn's four spans", describe: () => JSON.stringify(sink.spans().map((span) => span.name)) })
    expect(sink.spans()).toHaveLength(4)
    expect(new Set(sink.spans().map((span) => span.spanId)).size).toBe(4)
    await h.dispose()
  })

  test("a call that was retried says so, and a call that finished carries what the provider said about its response", async () => {
    const sink = collector()
    const h = harness({}, sink.send)
    h.provider.enqueue(
      [script.fail("rate_limit", { message: "Too many requests.", status: 429, requestId: "req_provider_0" })],
      [script.text("Hello."), U, script.finish("stop", { requestId: "req_provider_1", model: "gpt-test-2026-11-01" })],
    )
    h.create().send("Hi.")
    await h.settled()
    const chats = sink.spans().filter((span) => span.name.startsWith("chat "))
    expect(chats.map((span) => [span.attributes[attr("request.attempt")], span.attributes[attr("request.outcome")], span.attributes[attr("request.retried")], span.attributes[attr("provider.request_id")], span.attributes["gen_ai.response.model"] ?? null])).toEqual([
      [1, "error", true, "req_provider_0", null],
      [2, "ok", false, "req_provider_1", "gpt-test-2026-11-01"],
    ])
    expect(chats[0]!.attributes[attr("retry.delay_ms")]).toBeGreaterThan(0)
    // The ledger keeps both facts: an export after the fact says the same.
    expect(h.store.readRequests(h.session.id).map((row) => [row.outcome, row.providerRequestId, row.responseModel])).toEqual([
      ["error", "req_provider_0", null],
      ["ok", "req_provider_1", "gpt-test-2026-11-01"],
    ])
    expect(byId(sink.spans())).toEqual(byId(afterTheFact(h)))
    await h.dispose()
  })

  test("a turn the user stops is exported with its interrupted ending, and a session that is closed sends what it has", async () => {
    const sink = collector()
    const h = harness({}, sink.send)
    h.provider.enqueue([call("shell", { command: "sleep 600" }), U])
    h.tools.on("shell", async (_, context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))
      return "[Interrupted by the user.]"
    })
    h.create().send("Wait.")
    await h.seen((item) => item.type === "tool.started")
    h.session.interrupt()
    await h.settled()
    const root = sink.spans().find((span) => span.parentSpanId === null)!
    expect(root.attributes).toMatchObject({ [attr("execution.outcome")]: "interrupted", [attr("interrupt.reason")]: "user" })
    expect(byId(sink.spans())).toEqual(byId(afterTheFact(h)))
    await h.dispose()
  })

  test("a subagent's turn is in its parent's trace, under the span of the work that started it", async () => {
    const sink = collector()
    const h = harness({}, sink.send, { spawn: {} })
    converse(h.provider, {
      "Fix both": [[script.toolCall("call_1", "subagent", { task: "Fix module a" } as never), U], answer("Both are fixed.")],
      "Fix module a": [[call("write", { path: "a.ts", content: "a" }), U], answer("a.ts is fixed.")],
    })
    h.tools.on("write", "written")
    h.create().send("Fix both modules.")
    await h.settled()
    const sent = sink.spans()
    const child = sent.find((span) => span.name.startsWith("invoke_agent") && span.sessionId !== h.session.id)!
    const spawn = sent.find((span) => span.name === "subagent")!
    expect(child.traceId).toBe(spawn.traceId)
    expect(child.parentSpanId).toBe(spawn.spanId)
    expect(new Set(sent.map((span) => span.traceId)).size).toBe(1)
    expect(sent.filter((span) => span.sessionId === child.sessionId).map((span) => span.name).sort()).toEqual(["chat gpt-test", "chat gpt-test", "execute_tool write", child.name].sort())
    // The tree export after the fact places the child the same way (it also links the spawn span to it).
    const tree = mapSessionTree((id) => ({ sessionId: id, events: h.store.readEvents(id as SessionId), requests: h.store.readRequests(id as SessionId) }), h.session.id)
    expect(byId(sent).map((span) => ({ ...span, links: [] }))).toEqual(byId(tree.spans).map((span) => ({ ...span, links: [] })))
    await h.dispose()
  })

  test("a session opened again sends nothing of the turns that ended before, and the next turn whole", async () => {
    const sink = collector()
    const h = harness({}, sink.send)
    await editTurn(h)
    await h.dispose()
    const before = sink.spans().length
    h.boot()
    h.open()
    await editTurn(h, "Once more.")
    const all = sink.spans()
    expect(all.length).toBe(before * 2)
    expect(new Set(all.map((span) => span.spanId)).size).toBe(all.length)
    expect(byId(all)).toEqual(byId(afterTheFact(h)))
    await h.dispose()
  })
})

describe("who may turn telemetry on, and what is sent", () => {
  test("off unless the user's own file turns it on; a project's file can only turn it off", async () => {
    const play = async (config: { user?: ConfigFile; project?: ConfigFile }) => {
      const sink = collector()
      const h = harness(config, sink.send)
      await editTurn(h)
      const out = { spans: sink.spans().length, configs: sink.configs, said: h.diagnostics.map((item) => `${item.kind}: ${item.message}`), state: h.engine.telemetry() }
      await h.dispose()
      return out
    }
    expect((await play({ user: { verify: { mode: "off" } } })).spans).toBe(0)
    expect((await play({ user: { verify: { mode: "off" }, telemetry: { endpoint: ENDPOINT } } })).spans).toBe(0)
    // A repository cannot start an export, name a collector or ask for content.
    const projectOnly = await play({ user: { verify: { mode: "off" } }, project: { telemetry: { enabled: true, endpoint: "http://elsewhere.invalid", content: true } } })
    expect([projectOnly.spans, projectOnly.state]).toEqual([0, []])
    const widened = await play({ project: { telemetry: { enabled: true, endpoint: "http://elsewhere.invalid", content: true, headers: { "x-project": "1" } } } })
    expect(widened.spans).toBe(6)
    expect(new Set(widened.configs.map((config) => JSON.stringify(config)))).toEqual(new Set([JSON.stringify({ enabled: true, endpoint: ENDPOINT, headers: {}, content: false, timeoutMs: 10_000 })]))
    // It can turn the user's off.
    const off = await play({ project: { telemetry: { enabled: false } } })
    expect([off.spans, off.said]).toEqual([0, []])
  })

  test("content stays out unless the user's file asks for it; then it is redacted like a tool's result", async () => {
    const SECRET = "sk-test-0123456789abcdef0123456789abcdef"
    const play = async (content: boolean) => {
      const sink = collector()
      const h = harness({ user: { verify: { mode: "off" }, telemetry: { enabled: true, endpoint: ENDPOINT, ...(content ? { content: true } : {}) } } }, sink.send)
      h.provider.enqueue([call("shell", { command: "cat .env" }), U], answer("The key is set."))
      h.tools.on("shell", `API_KEY=${SECRET}`)
      h.create().send("Is the unusual-prompt-word key set?")
      await h.settled()
      const text = JSON.stringify(sink.spans())
      await h.dispose()
      return text
    }
    const without = await play(false)
    for (const piece of ["unusual-prompt-word", "cat .env", "API_KEY", SECRET, "The key is set.", "gen_ai.input.messages", "gen_ai.tool.call.arguments"]) expect(without).not.toContain(piece)
    const withContent = await play(true)
    for (const piece of ["unusual-prompt-word", "cat .env", "The key is set.", "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) expect(withContent).toContain(piece)
    expect(withContent).not.toContain(SECRET)
  })

  test("a header's variable is read from the environment, and a section that cannot be used is a notice: the turn runs", async () => {
    const sink = collector()
    const user: ConfigFile = { verify: { mode: "off" }, telemetry: { enabled: true, endpoint: ENDPOINT, headers: { authorization: "Bearer ${COLLECTOR_TOKEN}" } } }
    const h = harness({ user }, sink.send, {}, { env: { COLLECTOR_TOKEN: "t0ken" } })
    await editTurn(h)
    expect(sink.configs[0]!.headers).toEqual({ authorization: "Bearer t0ken" })
    // What a client is shown about the collector never holds a header's value.
    expect(JSON.stringify(h.engine.telemetry())).not.toContain("t0ken")
    await h.dispose()

    for (const [section, notice] of [
      [{ enabled: true }, "Telemetry is not exported: telemetry is enabled but the user configuration names no endpoint."],
      [user.telemetry!, "Telemetry is not exported: telemetry.headers.authorization: the environment variable COLLECTOR_TOKEN is not set."],
    ] as const) {
      const failing = collector()
      const g = harness({ user: { verify: { mode: "off" }, telemetry: section } }, failing.send)
      await editTurn(g)
      await editTurn(g, "Again.")
      expect(g.log().filter((item) => item.type === "execution.succeeded")).toHaveLength(2)
      expect(failing.spans()).toEqual([])
      // Said once, to the user; never to the model.
      expect(g.diagnostics.map((item) => [item.kind, item.message])).toEqual([["telemetry", notice]])
      expect(JSON.stringify(g.provider.requests)).not.toContain("Telemetry")
      await g.dispose()
    }
  })

  test("an engine that was not told to export sends nothing, whatever the configuration says", async () => {
    const h = new Harness({ userConfig: ON })
    await editTurn(h)
    expect(h.engine.telemetry()).toBeNull()
    expect(h.diagnostics).toEqual([])
    await h.dispose()
  })
})

describe("a collector that is slow, down or wrong", () => {
  const timed = async (send: TelemetrySetup["send"], setup: TelemetrySetup = {}) => {
    const h = harness({}, send, {}, { closeDeadlineMs: 150, ...setup })
    try {
      await editTurn(h)
      await editTurn(h, "Again.")
      const log = h.log()
      const state = h.engine.telemetry()
      const closing = performance.now()
      await h.dispose()
      return { close: performance.now() - closing, ended: log.filter((item) => item.type === "execution.succeeded").length, state, diagnostics: h.diagnostics }
    } finally {
      await h.dispose()
    }
  }

  test("one that never answers: the turns end without it, and closing waits a short while at most", async () => {
    const result = await timed(() => new Promise<ExportReport>(() => {}))
    // Both turns ended while the first turn's spans were still with the collector, which has not answered and never
    // will: nothing waited for it. The second turn's spans wait behind that request.
    expect(result.ended).toBe(2)
    expect(result.state).toEqual([{ endpoint: ENDPOINT, queued: 6, dropped: 0, sent: 0, failed: 0 }])
    // Closing gives the collector its short deadline and then lets go.
    expect(result.close).toBeGreaterThanOrEqual(140)
    expect(result.close).toBeLessThan(5000)
    expect(result.diagnostics).toEqual([])
  })

  test("one that rejects or throws: the spans are counted as not taken, and nothing else happens", async () => {
    for (const send of [async () => Promise.reject(new Error("collector exploded")), (() => { throw new Error("collector exploded at once") }) as never]) {
      const result = await timed(send)
      expect(result.ended).toBe(2)
      expect(result.state).toEqual([{ endpoint: ENDPOINT, queued: 0, dropped: 0, sent: 0, failed: 12 }])
      expect(result.diagnostics).toEqual([])
    }
  })

  test("a queue that is full drops its oldest spans and counts them", async () => {
    const result = await timed(() => new Promise<ExportReport>(() => {}), { maxQueue: 4 })
    expect(result.ended).toBe(2)
    expect(result.state).toEqual([{ endpoint: ENDPOINT, queued: 4, dropped: 4, sent: 0, failed: 0 }])
  })

  test("real collectors over HTTP: one that answers 500, one that never answers, and nothing listening", async () => {
    const received: number[] = []
    const failing = Bun.serve({ port: 0, fetch: async (request) => (received.push((await request.text()).length), new Response("no", { status: 500 })) })
    const silent = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") })
    const dead = `http://127.0.0.1:${closed.port}`
    await closed.stop(true)
    try {
      // The module's own exporter, with its timeout and its retries. A turn that waited for it would wait for
      // every attempt: more than eleven seconds with the collector that never answers, three and a half with the
      // port nothing listens on (the waits between attempts alone).
      for (const [endpoint, waits] of [[`http://127.0.0.1:${failing.port}`, false], [`http://127.0.0.1:${silent.port}`, true], [dead, true]] as const) {
        const h = harness({ user: { verify: { mode: "off" }, telemetry: { enabled: true, endpoint, timeoutMs: 2000 } } }, undefined, {}, { closeDeadlineMs: 300 })
        try {
          await editTurn(h)
          expect(h.log().at(-1)!.type).toBe("execution.succeeded")
          // The turn has ended and the collector has given no outcome yet: the spans are still with the exporter.
          if (waits) expect(h.engine.telemetry()).toEqual([{ endpoint, queued: 0, dropped: 0, sent: 0, failed: 0 }])
          const closing = performance.now()
          await h.dispose()
          // Closing waits its deadline at most, then cuts the request in flight and the waits between retries.
          expect(performance.now() - closing).toBeLessThan(3000)
          expect(h.diagnostics).toEqual([])
        } finally {
          await h.dispose()
        }
      }
      // The collector that answered was sent an OTLP/JSON body; a 500 is not retried.
      expect(received).toHaveLength(1)
      expect(received[0]!).toBeGreaterThan(500)
    } finally {
      // Not waited for: a server with a request that never ends is not this test's to see closed.
      void failing.stop(true)
      void silent.stop(true)
    }
  })

  test("a real collector that takes the spans is sent one OTLP/JSON request per turn, with the headers", async () => {
    const bodies: { resourceSpans: { resource: { attributes: { key: string }[] }; scopeSpans: { spans: { name: string }[] }[] }[] }[] = []
    const headers: (string | null)[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        headers.push(`${new URL(request.url).pathname} ${request.headers.get("authorization")} ${request.headers.get("content-type")}`)
        bodies.push((await request.json()) as never)
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    })
    try {
      const h = harness({ user: { verify: { mode: "off" }, telemetry: { enabled: true, endpoint: `http://127.0.0.1:${server.port}`, headers: { authorization: "Bearer ${COLLECTOR_TOKEN}" } } } }, undefined, {}, { env: { COLLECTOR_TOKEN: "t0ken" } })
      await editTurn(h)
      await h.dispose()
      expect(headers).toEqual(["/v1/traces Bearer t0ken application/json"])
      expect(bodies[0]!.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => span.name).filter((name) => name.startsWith("execute_tool")).sort()).toEqual(["execute_tool read", "execute_tool write"])
      expect(bodies[0]!.resourceSpans[0]!.resource.attributes.map((item) => item.key).sort()).toEqual(["host.name", "service.name", "service.version"])
      expect(h.engine.telemetry()).toEqual([{ endpoint: `http://127.0.0.1:${server.port}`, queued: 0, dropped: 0, sent: 6, failed: 0 }])
    } finally {
      void server.stop(true)
    }
  })
})

describe("without telemetry and without commands", () => {
  test("a session whose configuration names neither sends byte for byte the requests of an engine that offers neither, and writes the same log and ledger", async () => {
    const play = async (options: HarnessOptions) => {
      const h = new Harness({ userConfig: { verify: { mode: "off" } }, ...options })
      h.provider.enqueue([call("read", { path: "a.ts" }), call("shell", { command: "ls" }, "call_2"), U], [call("write", { path: "a.ts", content: "x" }), U], answer("Done."), answer("Yes."))
      h.tools.on("read", "export const a = 1").on("shell", "a.ts").on("write", "Wrote a.ts")
      h.create().send("Change a.ts.")
      await h.settled()
      h.session.send("/usr/bin/env is missing?")
      await h.settled()
      const out = {
        requests: JSON.stringify(h.provider.requests),
        ledger: JSON.stringify(h.store.readRequests(h.session.id)),
        log: JSON.stringify(h.log().map((item) => ({ seq: item.seq, type: item.type, v: item.v, time: item.time, data: item.data }))),
        rows: JSON.stringify(h.session.projection()),
      }
      await h.dispose()
      return out
    }
    const without = await play({})
    // Offered and not configured.
    expect(await play({ commands: {}, telemetry: {} })).toEqual(without)
    // Empty sections, and a section that leaves telemetry off, are not configured either.
    expect(await play({ commands: {}, telemetry: {}, userConfig: { verify: { mode: "off" }, commands: {}, telemetry: { enabled: false, endpoint: ENDPOINT } }, config: { commands: { disabled: [] }, telemetry: { enabled: false } } })).toEqual(without)
    // Telemetry that is on writes nothing either: the log, the ledger and the requests are those of a session without it.
    const sink = collector()
    expect(await play({ commands: {}, telemetry: { send: sink.send, mapDelayMs: 0, env: {} }, userConfig: ON })).toEqual(without)
    expect(sink.spans().length).toBe(9)
  })
})
