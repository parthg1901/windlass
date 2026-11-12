import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ModelListError, OpenAIResponsesProvider, listModels } from "../../src/provider/openai-responses.ts"
import { encodeRequest } from "../../src/provider/openai-responses-encode.ts"
import type { StreamEvent } from "../../src/provider/provider.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { fixtureBytes } from "./responses-helpers.ts"

const TOKEN = "test-token-not-real"

const request: ModelRequest = {
  params: { model: "gpt-6-luna", reasoningEffort: "low", textVerbosity: null, parallelToolCalls: true, cacheKey: "cache-key-TEST" },
  tools: [],
  instructions: "Be terse.",
  input: [{ type: "message", role: "user", content: [{ type: "text", text: "Hi" }] }],
  toolChoice: "auto",
}

interface Seen {
  method: string
  path: string
  authorizationMatches: boolean
  sessionId: string | null
  body: string
}

const seen: Seen[] = []
/** Paths whose response body the client cancelled. */
const cancelled = new Set<string>()
let server: ReturnType<typeof Bun.serve>
let base: string

const encoder = new TextEncoder()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function sse(path: string, produce: (send: (text: string | Uint8Array) => void) => Promise<"close" | "hang">) {
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string | Uint8Array) => {
        if (!closed) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
      }
      const end = await produce(send)
      if (closed) return
      if (end === "close") controller.close()
    },
    cancel() {
      closed = true
      cancelled.add(path)
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "x-oai-request-id": "req_TEST1" } })
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-oai-request-id": "req_TEST1", ...headers },
  })

const frame = (type: string, rest: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`
const delta = (text: string) => frame("response.output_text.delta", { output_index: 0, delta: text })

const routes: Record<string, (request: Request, path: string) => Response | Promise<Response>> = {
  async "text"(_, path) {
    const bytes = await fixtureBytes("text.sse")
    return sse(path, async (send) => {
      // Odd-sized chunks, so frames and lines straddle network reads.
      for (let start = 0; start < bytes.length; start += 97) {
        send(bytes.subarray(start, start + 97))
        await sleep(0)
      }
      return "close"
    })
  },
  "detail-400": () => json(400, { detail: "Unsupported parameter: temperature" }),
  "code-400-no-content-type": () =>
    new Response(
      encoder.encode(JSON.stringify({ error: { message: "The encrypted content for item rs_TEST1 could not be verified.", type: "invalid_request_error", param: null, code: "invalid_encrypted_content" } })),
      { status: 400, headers: { "x-oai-request-id": "req_TEST1" } },
    ),
  "null-code-400": () =>
    json(400, { error: { message: "A function call output without a call_id requires a name.", type: "invalid_request_error", param: "input", code: null } }),
  "overflow-400": () =>
    json(400, { error: { message: "Your input exceeds the context window of this model.", type: "invalid_request_error", param: "input", code: "context_length_exceeded" } }),
  "unauthorized-401": () => json(401, { detail: "Unauthorized" }),
  "not-eligible-403": () =>
    json(403, { error: { message: "Not eligible.", type: "invalid_request_error", param: null, code: "subscription_sharing_user_not_eligible" } }),
  "usage-limit-429": () =>
    json(429, { error: { message: "Usage limit reached.", type: "usage_limit", param: null, code: "subscription_sharing_usage_limit_exceeded" } }, { "retry-after": "3600" }),
  "rate-limit-429": () => json(429, { error: { message: "Slow down.", type: "rate_limit_error", param: null, code: "slow_down" } }, { "retry-after": "2" }),
  "unavailable-503": () => json(503, { detail: "Direct routing unavailable" }),
  "html-502": () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
  "cut"(_, path) {
    return sse(path, async (send) => {
      send(frame("response.created", { response: {} }) + delta("partial"))
      return "close"
    })
  },
  "stall"(_, path) {
    return sse(path, async (send) => {
      send(frame("response.created", { response: {} }) + delta("partial"))
      return "hang"
    })
  },
  async "stall-headers"() {
    await sleep(5_000)
    return json(200, {})
  },
  "keep-alive"(_, path) {
    return sse(path, async (send) => {
      send(frame("response.created", { response: {} }))
      // Longer than the idle timeout in total, but never silent for that long.
      for (let index = 0; index < 8; index++) {
        await sleep(40)
        send(": keep-alive\n\n")
      }
      send(delta("ok") + frame("response.completed", { response: { output: [] } }))
      return "close"
    })
  },
  "garbage"(_, path) {
    return sse(path, async (send) => {
      send("event: response.created\ndata: {not json\n\n")
      return "hang"
    })
  },
  "slow"(_, path) {
    return sse(path, async (send) => {
      send(frame("response.created", { response: {} }))
      for (let index = 0; index < 200; index++) {
        send(delta(`d${index} `))
        await sleep(25)
      }
      return "close"
    })
  },
  "after-terminal"(_, path) {
    return sse(path, async (send) => {
      send(frame("response.completed", { response: { output: [] } }))
      await sleep(10)
      send(delta("late"))
      return "hang"
    })
  },
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(incoming) {
      const url = new URL(incoming.url)
      const [scenario, endpoint] = url.pathname.slice(1).split("/")
      if (endpoint === "models") return modelsRoute(incoming, scenario ?? "")
      seen.push({
        method: incoming.method,
        path: url.pathname,
        authorizationMatches: incoming.headers.get("authorization") === `Bearer ${TOKEN}`,
        sessionId: incoming.headers.get("session-id"),
        body: await incoming.text(),
      })
      const route = routes[scenario ?? ""]
      return route ? route(incoming, url.pathname) : new Response("no route", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

function provider(scenario: string, options: { idleTimeoutMs?: number; accessToken?: () => Promise<string>; baseUrl?: string } = {}) {
  return new OpenAIResponsesProvider({
    accessToken: options.accessToken ?? (async () => TOKEN),
    readBlob: () => {
      throw new Error("no blobs in this test")
    },
    baseUrl: options.baseUrl ?? `${base}/${scenario}`,
    idleTimeoutMs: options.idleTimeoutMs ?? 2_000,
  })
}

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function errorOf(scenario: string, options: Parameters<typeof provider>[1] = {}) {
  const events = await collect(provider(scenario, options).stream(request, new AbortController().signal))
  expect(events).toHaveLength(1)
  const last = events[0]
  if (last?.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(events)}`)
  return last.error
}

describe("OpenAIResponsesProvider over HTTP", () => {
  test("streams a completed response and sends the encoded body, bearer token and session-id", async () => {
    const events = await collect(provider("text").stream(request, new AbortController().signal))
    expect(events.map((event) => event.type)).toEqual(["text.delta", "text.delta", "text.delta", "text.delta", "text.end", "usage", "finish"])
    const last = seen.at(-1)!
    expect(last.method).toBe("POST")
    expect(last.path).toBe("/text/responses")
    expect(last.authorizationMatches).toBe(true)
    expect(last.sessionId).toBe("cache-key-TEST")
    expect(last.body).toBe(encodeRequest(request, new Map()).body)
  })

  test("pre-stream HTTP errors in each observed body shape", async () => {
    expect(await errorOf("detail-400")).toEqual({
      kind: "invalid_request",
      retryable: false,
      message: "HTTP 400: Unsupported parameter: temperature",
      status: 400,
      code: null,
      retryAfterMs: null,
      requestId: "req_TEST1",
    })
    expect(await errorOf("code-400-no-content-type")).toMatchObject({ kind: "invalid_request", status: 400, code: "invalid_encrypted_content" })
    expect(await errorOf("null-code-400")).toMatchObject({ kind: "invalid_request", status: 400, code: "invalid_request_error" })
    expect(await errorOf("overflow-400")).toMatchObject({ kind: "context_overflow", retryable: false, code: "context_length_exceeded" })
    expect(await errorOf("unauthorized-401")).toMatchObject({ kind: "auth", status: 401 })
    expect(await errorOf("not-eligible-403")).toMatchObject({ kind: "auth", status: 403, code: "subscription_sharing_user_not_eligible" })
    expect(await errorOf("usage-limit-429")).toMatchObject({ kind: "usage_limit", retryable: false, retryAfterMs: 3_600_000 })
    expect(await errorOf("rate-limit-429")).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 2_000, code: "slow_down" })
    expect(await errorOf("unavailable-503")).toMatchObject({ kind: "provider_internal", retryable: true, status: 503 })
    expect(await errorOf("html-502")).toMatchObject({ kind: "provider_internal", status: 502, message: "HTTP 502: <html>Bad gateway</html>" })
  })

  test("a connection killed mid-stream is transport, after the partial output", async () => {
    // A raw socket: headers, one chunk of a chunked body, then the connection drops without the final chunk.
    const killer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          const chunk = frame("response.created", { response: {} }) + delta("partial")
          const length = encoder.encode(chunk).length.toString(16)
          socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n${length}\r\n${chunk}\r\n`)
          setTimeout(() => socket.terminate(), 30)
        },
      },
    })
    try {
      const events = await collect(provider("", { baseUrl: `http://127.0.0.1:${killer.port}` }).stream(request, new AbortController().signal))
      expect(events).toMatchObject([
        { type: "text.delta", text: "partial" },
        { type: "error", error: { kind: "transport", retryable: true, reason: "connection" } },
      ])
    } finally {
      killer.stop(true)
    }
  })

  test("a body that ends without a terminal event is incomplete_stream", async () => {
    const events = await collect(provider("cut").stream(request, new AbortController().signal))
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "incomplete_stream", retryable: true } })
    expect(events.at(-1)?.type === "error" && events.at(-1)).toMatchObject({
      error: { requestId: "req_TEST1", message: expect.not.stringContaining("req_TEST1") },
    })
  })

  test("a stalled stream fails as transport after the idle timeout and the request is cancelled", async () => {
    const started = Date.now()
    const events = await collect(provider("stall", { idleTimeoutMs: 150 }).stream(request, new AbortController().signal))
    expect(Date.now() - started).toBeLessThan(1_500)
    // Still a transport error, so it is retried like one, but told apart from a broken connection.
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "transport", retryable: true, reason: "stalled", requestId: "req_TEST1" } })
    await sleep(50)
    expect(cancelled.has("/stall/responses")).toBe(true)
  })

  test("no response headers within the idle timeout is transport", async () => {
    const error = await errorOf("stall-headers", { idleTimeoutMs: 150 })
    expect(error).toMatchObject({ kind: "transport", status: null, reason: "stalled", requestId: null })
  })

  test("keep-alive comments keep a slow stream alive past the idle timeout", async () => {
    const events = await collect(provider("keep-alive", { idleTimeoutMs: 150 }).stream(request, new AbortController().signal))
    expect(events).toEqual([{ type: "text.delta", text: "ok" }, { type: "finish", reason: "stop", response: { requestId: "req_TEST1" } }])
  })

  test("an unparseable frame is provider_internal and stops reading", async () => {
    const events = await collect(provider("garbage").stream(request, new AbortController().signal))
    expect(events).toMatchObject([{ type: "error", error: { kind: "provider_internal" } }])
    await sleep(50)
    expect(cancelled.has("/garbage/responses")).toBe(true)
  })

  test("nothing is yielded after the terminal event and the body is released", async () => {
    const events = await collect(provider("after-terminal").stream(request, new AbortController().signal))
    expect(events).toEqual([{ type: "finish", reason: "stop", response: { requestId: "req_TEST1" } }])
    await sleep(50)
    expect(cancelled.has("/after-terminal/responses")).toBe(true)
  })

  test("a refused connection is transport", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") })
    const port = closed.port
    closed.stop(true)
    expect(await errorOf("", { baseUrl: `http://127.0.0.1:${port}` })).toMatchObject({
      kind: "transport",
      retryable: true,
      reason: "connection",
    })
  })

  test("a failing token getter is auth and sends nothing", async () => {
    const before = seen.length
    const error = await errorOf("text", {
      accessToken: async () => {
        throw new Error("Not signed in. Run the sign-in first.")
      },
    })
    expect(error).toMatchObject({ kind: "auth", retryable: false, message: "no usable access token: Not signed in. Run the sign-in first." })
    expect(seen.length).toBe(before)
  })

  test("an unreadable blob is invalid_request and sends nothing", async () => {
    const before = seen.length
    const withImage: ModelRequest = {
      ...request,
      input: [{ type: "message", role: "user", content: [{ type: "media", blob: { hash: "c".repeat(64), mediaType: "image/png" } }] }],
    }
    const events = await collect(provider("text").stream(withImage, new AbortController().signal))
    expect(events).toMatchObject([{ type: "error", error: { kind: "invalid_request" } }])
    expect(seen.length).toBe(before)
  })

  test("images are read through the injected blob reader", async () => {
    const blob = { hash: "d".repeat(64), mediaType: "image/png" }
    const reads: string[] = []
    const withImage: ModelRequest = { ...request, input: [{ type: "message", role: "user", content: [{ type: "media", blob }] }] }
    const instance = new OpenAIResponsesProvider({
      accessToken: async () => TOKEN,
      readBlob: async (ref) => {
        reads.push(ref.hash)
        return new Uint8Array([1, 2, 3])
      },
      baseUrl: `${base}/text`,
    })
    const events = await collect(instance.stream(withImage, new AbortController().signal))
    // The finish says what the response said about itself: the request's ID from its header, and the model that answered.
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop", response: { requestId: "req_TEST1", model: "gpt-6-luna" } })
    expect(reads).toEqual([blob.hash])
    expect(seen.at(-1)!.body).toContain('"image_url":"data:image/png;base64,AQID"')
  })
})

describe("abort", () => {
  test("aborting mid-stream stops promptly with no terminal event and cancels the request", async () => {
    const controller = new AbortController()
    const events: StreamEvent[] = []
    let abortedAt = 0
    for await (const event of provider("slow").stream(request, controller.signal)) {
      events.push(event)
      if (events.length === 2) {
        abortedAt = Date.now()
        controller.abort()
      }
    }
    expect(Date.now() - abortedAt).toBeLessThan(100)
    expect(events.length).toBeLessThanOrEqual(3)
    expect(events.every((event) => event.type === "text.delta")).toBe(true)
    await sleep(100)
    expect(cancelled.has("/slow/responses")).toBe(true)
  })

  test("aborting while waiting for the next chunk ends the stream without waiting for it", async () => {
    const controller = new AbortController()
    const stream = provider("stall", { idleTimeoutMs: 10_000 }).stream(request, controller.signal)
    const events: StreamEvent[] = []
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    for await (const event of stream) events.push(event)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(events).toEqual([{ type: "text.delta", text: "partial" }])
  })

  test("an already aborted signal makes no request and yields nothing", async () => {
    const before = seen.length
    const controller = new AbortController()
    controller.abort()
    expect(await collect(provider("text").stream(request, controller.signal))).toEqual([])
    expect(seen.length).toBe(before)
  })

  test("a consumer that stops reading early releases the request", async () => {
    cancelled.delete("/slow/responses")
    for await (const event of provider("slow").stream(request, new AbortController().signal)) if (event.type === "text.delta") break
    await sleep(100)
    expect(cancelled.has("/slow/responses")).toBe(true)
  })
})

function modelsRoute(incoming: Request, scenario: string) {
  if (incoming.headers.get("authorization") !== `Bearer ${TOKEN}`) return json(401, { detail: "Unauthorized" })
  if (scenario === "models-bad") return json(200, { data: [] })
  return json(200, {
    models: [
      { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list", supported_in_api: true, context_window: 400000, supported_reasoning_levels: [{ effort: "low", description: "x" }, { effort: "medium" }], default_reasoning_level: "medium" },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
      { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
    ],
  })
}

describe("listModels", () => {
  test("returns listed models in server order", async () => {
    const models = await listModels({ accessToken: async () => TOKEN, baseUrl: `${base}/models-ok` })
    expect(models.map((model) => model.slug)).toEqual(["gpt-6-luna", "gpt-6-sol"])
    expect(models[0]).toEqual({
      slug: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      visibility: "list",
      supportedInApi: true,
      contextWindow: 400000,
      reasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    })
    const all = await listModels({ accessToken: async () => TOKEN, baseUrl: `${base}/models-ok`, listedOnly: false })
    expect(all.map((model) => model.slug)).toEqual(["gpt-6-luna", "gpt-hidden", "gpt-6-sol"])
  })

  test("failures throw a classified ModelListError", async () => {
    const failure = (options: Parameters<typeof listModels>[0]) =>
      listModels(options).then(
        () => null,
        (error: unknown) => (error instanceof ModelListError ? error.error.kind : "not a ModelListError"),
      )
    expect(await failure({ accessToken: async () => "wrong", baseUrl: `${base}/models-ok` })).toBe("auth")
    expect(await failure({ accessToken: async () => TOKEN, baseUrl: `${base}/models-bad` })).toBe("provider_internal")
  })
})
