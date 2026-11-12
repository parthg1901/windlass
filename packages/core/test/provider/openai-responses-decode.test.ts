import { describe, expect, test } from "bun:test"
import { ResponsesStreamMapper } from "../../src/provider/openai-responses-decode.ts"
import type { StreamEvent } from "../../src/provider/provider.ts"
import { decodeChunks, fixtureBytes, splitAt, sseFixtures } from "./responses-helpers.ts"

const decodeFixture = async (name: string) => decodeChunks([await fixtureBytes(name)])

/** The usage a response reported. Every fixture says how much it wrote to the cache (nothing); `written: null` is a response without that field. */
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, written: number | null = 0) => ({
  type: "usage" as const,
  usage: { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, ...(written === null ? {} : { cacheWriteTokens: written }) },
})

const terminalCount = (events: readonly StreamEvent[]) =>
  events.filter((event) => event.type === "finish" || event.type === "error").length

describe("Responses stream decoding: live fixtures", () => {
  test("text.sse: deltas, the whole text with id and phase, usage, stop", async () => {
    expect(await decodeFixture("text.sse")).toEqual([
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: "," },
      { type: "text.delta", text: " world" },
      { type: "text.delta", text: "!" },
      { type: "text.end", text: "Hello, world!", providerData: { id: "msg_TEST1", phase: "final_answer" } },
      usage(13, 0, 8, 0),
      { type: "finish", reason: "stop" },
    ])
  })

  test("reasoning-function-call.sse: reasoning item kept whole for replay, then the call", async () => {
    const events = await decodeFixture("reasoning-function-call.sse")
    expect(events.filter((event) => !event.type.endsWith(".delta"))).toEqual([
      {
        type: "reasoning.end",
        text: "**Computing 391 parity**",
        providerData: {
          id: "rs_TEST1",
          summary: [{ type: "summary_text", text: "**Computing 391 parity**" }],
          content: [],
          encrypted_content: "enc_PLACEHOLDER",
        },
      },
      { type: "tool_call.end", callId: "call_TEST1", name: "get_weather", input: '{"city":"Paris"}', providerData: { id: "fc_TEST1" } },
      usage(71, 0, 33, 13),
      { type: "finish", reason: "tool_calls" },
    ])
    expect(events.filter((event) => event.type === "reasoning.delta")).toEqual([
      { type: "reasoning.delta", text: "**Computing 391 parity**" },
    ])
    const deltas = events.flatMap((event) => (event.type === "tool_call.delta" ? [event.input] : []))
    expect(deltas.join("")).toBe('{"city":"Paris"}')
    for (const event of events)
      if (event.type === "tool_call.delta") expect([event.callId, event.name]).toEqual(["call_TEST1", "get_weather"])
  })

  test("parallel-function-calls.sse: two calls without argument deltas, arguments exactly as written", async () => {
    expect(await decodeFixture("parallel-function-calls.sse")).toEqual([
      { type: "tool_call.end", callId: "call_TEST1", name: "get_weather", input: '{"city": "Paris"}', providerData: { id: "fc_TEST1" } },
      { type: "tool_call.end", callId: "call_TEST2", name: "get_weather", input: '{"city": "Tokyo"}', providerData: { id: "fc_TEST2" } },
      usage(67, 0, 48, 0),
      { type: "finish", reason: "tool_calls" },
    ])
  })

  test("function-call.sse: one call, tool_calls finish", async () => {
    const events = await decodeFixture("function-call.sse")
    const ends = events.filter((event) => event.type === "tool_call.end")
    expect(ends).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
  })
})

describe("Responses stream decoding: synthetic fixtures", () => {
  test("response.failed after text has streamed is a classified error and nothing else ends", async () => {
    const events = await decodeFixture("synthetic-failed-mid-stream.sse")
    expect(events.slice(0, 2)).toEqual([
      { type: "text.delta", text: "Café — 東京 " },
      { type: "text.delta", text: "🌧️ is" },
    ])
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({
      type: "error",
      error: { kind: "usage_limit", retryable: false, code: "subscription_sharing_usage_limit_exceeded" },
    })
  })

  test("an error frame is classified by its code", async () => {
    const events = await decodeFixture("synthetic-error-event.sse")
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "rate_limit", retryable: true, code: "rate_limit_exceeded" } })
    expect(terminalCount(events)).toBe(1)
  })

  test("response.incomplete for max_output_tokens finishes with length and never ends the cut call", async () => {
    const events = await decodeFixture("synthetic-incomplete-max-output.sse")
    expect(events.some((event) => event.type === "tool_call.end")).toBe(false)
    expect(events.slice(-2)).toEqual([usage(120, 0, 4096, 4000), { type: "finish", reason: "length" }])
  })

  test("response.incomplete for content_filter is content_policy", async () => {
    expect(await decodeFixture("synthetic-incomplete-content-filter.sse")).toEqual([
      {
        type: "error",
        error: { kind: "content_policy", retryable: false, message: "response incomplete: content_filter", status: null, code: "content_filter", retryAfterMs: null, requestId: null },
      },
    ])
  })

  test("a refusal is content_policy after usage, and its text is not assistant text", async () => {
    const events = await decodeFixture("synthetic-refusal.sse")
    expect(events.some((event) => event.type === "text.delta" || event.type === "text.end")).toBe(false)
    expect(events[0]).toEqual(usage(20, 0, 7, 0))
    expect(events[1]).toMatchObject({ type: "error", error: { kind: "content_policy", code: "refusal" } })
    expect(events[1]?.type === "error" && events[1].error.message).toContain("I can't help with that.")
    expect(events).toHaveLength(2)
  })

  test("two summary parts are separated by a blank line in deltas and end; a call without output_item.done is settled from the final output", async () => {
    const events = await decodeFixture("synthetic-reasoning-two-parts.sse")
    const deltas = events.flatMap((event) => (event.type === "reasoning.delta" ? [event.text] : []))
    const end = events.find((event) => event.type === "reasoning.end")
    expect(end?.type === "reasoning.end" && end.text).toBe("**Reading the file**\n\n**Naïve plan ✓**")
    expect(deltas.join("")).toBe("**Reading the file**\n\n**Naïve plan ✓**")
    // The done item's encrypted content wins over the partial one on output_item.added.
    expect(end?.type === "reasoning.end" && end.providerData).toMatchObject({ encrypted_content: "enc_PLACEHOLDER" })
    expect(events.slice(-3)).toEqual([
      { type: "tool_call.end", callId: "call_TEST1", name: "read_file", input: '{"path":"README.md"}', providerData: { id: "fc_TEST1" } },
      usage(50, 0, 30, 12),
      { type: "finish", reason: "tool_calls" },
    ])
  })
})

describe("Responses stream decoding: framing", () => {
  for (const name of sseFixtures) {
    test(`${name}: exactly one terminal event, last, and identical at every split offset`, async () => {
      const bytes = await fixtureBytes(name)
      const whole = decodeChunks([bytes])
      expect(terminalCount(whole)).toBe(1)
      expect(["finish", "error"]).toContain(whole.at(-1)!.type)
      for (let offset = 1; offset < bytes.length; offset++) expect(decodeChunks(splitAt(bytes, offset))).toEqual(whole)
      expect(decodeChunks([...bytes].map((byte) => new Uint8Array([byte])))).toEqual(whole)
    })
  }

  test("a stream cut before its terminal event is incomplete_stream, with the partial output before it", async () => {
    const bytes = await fixtureBytes("text.sse")
    const text = new TextDecoder().decode(bytes)
    const cut = new TextEncoder().encode(text.slice(0, text.indexOf("event: response.completed")))
    const events = decodeChunks([cut])
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "incomplete_stream", retryable: true } })
    expect(events.filter((event) => event.type === "text.end")).toHaveLength(1)
    expect(terminalCount(events)).toBe(1)
  })

  test("a stream cut in the middle of the completed frame is incomplete_stream", async () => {
    const bytes = await fixtureBytes("text.sse")
    const events = decodeChunks([bytes.subarray(0, bytes.length - 40)])
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "incomplete_stream" } })
  })

  test("an unparseable frame is provider_internal and ends the call", () => {
    const mapper = new ResponsesStreamMapper("req_TEST1")
    const events = mapper.frame({ event: "response.output_text.delta", data: "{not json" })
    expect(events).toMatchObject([{ type: "error", error: { kind: "provider_internal", retryable: true } }])
    // The request ID is its own field; the message is only the description.
    expect(events[0]?.type === "error" && events[0].error).toMatchObject({ requestId: "req_TEST1" })
    expect(events[0]?.type === "error" && events[0].error.message).not.toContain("req_TEST1")
    expect(mapper.done).toBe(true)
    expect(mapper.frame({ event: "x", data: '{"type":"response.completed","response":{}}' })).toEqual([])
    expect(mapper.end()).toEqual([])
  })

  test("unknown event types, metadata and keep-alives are ignored", () => {
    const mapper = new ResponsesStreamMapper()
    for (const type of ["response.metadata", "response.queued", "response.something_new", "response.output_text.annotation.added"])
      expect(mapper.frame({ event: type, data: JSON.stringify({ type, sequence_number: 1 }) })).toEqual([])
    expect(mapper.frame({ event: "response.completed", data: '{"type":"response.completed","response":{"output":[]}}' })).toEqual([
      { type: "finish", reason: "stop" },
    ])
  })

  test("what the provider wrote to its cache is kept as reported: absent when the response has no such field, with the 12-hour part when it says", () => {
    const completed = (details: Record<string, unknown>) => {
      const response = { output: [], usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 1024, ...details }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 8 } } }
      return new ResponsesStreamMapper().frame({ event: "response.completed", data: JSON.stringify({ type: "response.completed", response }) })[0]
    }
    // A model that reports no writes: the figure is unknown, not zero.
    expect(completed({})).toEqual(usage(5000, 1024, 40, 8, null))
    // Zero is a figure.
    expect(completed({ cache_write_tokens: 0 })).toEqual(usage(5000, 1024, 40, 8, 0))
    // The lifetimes are a split of the same figure.
    expect(completed({ cache_write_tokens: 3000, cache_write_tokens_details: { ttl_30m_tokens: 1000, ttl_12h_tokens: 2000 } })).toEqual({
      type: "usage",
      usage: { inputTokens: 5000, cachedInputTokens: 1024, outputTokens: 40, reasoningTokens: 8, cacheWriteTokens: 3000, cacheWrite12hTokens: 2000 },
    })
    // A split without the figure it splits says nothing.
    expect(completed({ cache_write_tokens_details: { ttl_12h_tokens: 2000 } })).toEqual(usage(5000, 1024, 40, 8, null))
  })

  test("nothing follows a terminal event", () => {
    const mapper = new ResponsesStreamMapper()
    mapper.frame({ event: "error", data: '{"type":"error","code":"server_error","message":"boom"}' })
    expect(mapper.frame({ event: "response.failed", data: '{"type":"response.failed","response":{"error":{"code":"x"}}}' })).toEqual([])
    expect(mapper.end()).toEqual([])
  })
})
