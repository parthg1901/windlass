import { describe, expect, test } from "bun:test"
import { text } from "../../src/content.ts"
import { createInterrupt, interruptReasonOf } from "../../src/interrupt.ts"
import { RETRYABLE, type ProviderErrorKind, makeProviderError } from "../../src/provider/error.ts"
import type { Provider, StreamEvent } from "../../src/provider/provider.ts"
import type { InputItem, ModelRequest } from "../../src/request/request.ts"
import { FakeProvider, collectStream, script } from "../../src/testing/fake-provider.ts"

const request: ModelRequest = {
  params: { model: "gpt-test", reasoningEffort: null, textVerbosity: null, parallelToolCalls: true, cacheKey: "ses_1" },
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  instructions: "You are a coding agent.",
  input: [{ type: "message", role: "user", content: text("hi") }],
  toolChoice: "auto",
}
const never = new AbortController().signal
const types = (events: readonly StreamEvent[]) => events.map((streamEvent) => streamEvent.type)

describe("FakeProvider", () => {
  test("is a Provider", () => {
    const provider: Provider = new FakeProvider()
    expect(provider.id).toBe("fake")
  })

  test("streams text as deltas followed by the whole item, then finishes", async () => {
    const provider = new FakeProvider([[script.text("Hello, world!", { chunkSize: 5 })]])
    expect(await collectStream(provider.stream(request, never))).toEqual([
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: ", wor" },
      { type: "text.delta", text: "ld!" },
      { type: "text.end", text: "Hello, world!", providerData: null },
      { type: "finish", reason: "stop" },
    ])
    expect(provider.calls[0]!.outcome).toBe("finished")
    expect(provider.remaining).toBe(0)
  })

  test("streams reasoning with its opaque payload untouched", async () => {
    const payload = { id: "rs_1", encrypted_content: "gAAAAB", summary: [] }
    const provider = new FakeProvider([[script.reasoning("thinking hard", { providerData: payload }), script.text("ok")]])
    const events = await collectStream(provider.stream(request, never))
    expect(events.find((streamEvent) => streamEvent.type === "reasoning.end")).toEqual({
      type: "reasoning.end",
      text: "thinking hard",
      providerData: payload,
    })
    expect(types(events)).toEqual(["reasoning.delta", "reasoning.delta", "reasoning.end", "text.delta", "text.end", "finish"])
  })

  test("streams several tool calls and finishes with tool_calls", async () => {
    const provider = new FakeProvider([
      [
        script.toolCall("call_1", "read", { path: "a.ts" }, { chunkSize: 100 }),
        script.toolCall("call_2", "read", { path: "b.ts" }, { chunkSize: 100 }),
        script.usage({ inputTokens: 120, cachedInputTokens: 100, outputTokens: 30 }),
      ],
    ])
    expect(await collectStream(provider.stream(request, never))).toEqual([
      { type: "tool_call.delta", callId: "call_1", name: "read", input: '{"path":"a.ts"}' },
      { type: "tool_call.end", callId: "call_1", name: "read", input: '{"path":"a.ts"}', providerData: null },
      { type: "tool_call.delta", callId: "call_2", name: "read", input: '{"path":"b.ts"}' },
      { type: "tool_call.end", callId: "call_2", name: "read", input: '{"path":"b.ts"}', providerData: null },
      { type: "usage", usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 30, reasoningTokens: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
  })

  test("the deltas of a tool call join to its complete input", async () => {
    const input = { command: "grep -rn 'needle' src | head -20", timeout: 30 }
    const provider = new FakeProvider([[script.toolCall("call_1", "shell", input, { chunkSize: 3 })]])
    const events = await collectStream(provider.stream(request, never))
    const joined = events.flatMap((streamEvent) => (streamEvent.type === "tool_call.delta" ? [streamEvent.input] : [])).join("")
    expect(JSON.parse(joined)).toEqual(input)
    expect(events.at(-2)).toMatchObject({ type: "tool_call.end", input: joined })
  })

  test("a string input is sent as written, so it can be malformed", async () => {
    const provider = new FakeProvider([[script.toolCall("call_1", "read", '{"path": ')]])
    const events = await collectStream(provider.stream(request, never))
    expect(events.at(-2)).toMatchObject({ type: "tool_call.end", input: '{"path": ' })
  })

  test("an explicit finish reason is respected", async () => {
    const provider = new FakeProvider([[script.text("cut off by the limit"), script.finish("length")]])
    expect((await collectStream(provider.stream(request, never))).at(-1)).toEqual({ type: "finish", reason: "length" })
  })

  test("can fail before any output with each error class", async () => {
    for (const kind of Object.keys(RETRYABLE) as ProviderErrorKind[]) {
      const provider = new FakeProvider([[script.fail(kind, { retryAfterMs: 1500, status: 429 })]])
      const events = await collectStream(provider.stream(request, never))
      expect(events).toEqual([
        { type: "error", error: makeProviderError(kind, `scripted ${kind}`, { retryAfterMs: 1500, status: 429 }) },
      ])
      expect(events[0]).toMatchObject({ error: { kind, retryable: RETRYABLE[kind], retryAfterMs: 1500, status: 429 } })
      expect(provider.calls[0]!.outcome).toBe("failed")
    }
  })

  test("can fail in the middle of a stream, after complete and partial output", async () => {
    const provider = new FakeProvider([
      [
        script.text("First paragraph."),
        script.toolCall("call_1", "read", { path: "a.ts" }, { partial: true, chunkSize: 6 }),
        script.fail("provider_internal", { status: 500 }),
      ],
    ])
    const events = await collectStream(provider.stream(request, never))
    expect(types(events)).toEqual([
      "text.delta",
      "text.delta",
      "text.end",
      "tool_call.delta",
      "tool_call.delta",
      "tool_call.delta",
      "error",
    ])
    expect(events.some((streamEvent) => streamEvent.type === "tool_call.end")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "provider_internal", retryable: true } })
  })

  test("a stream can die after partial output, reported as incomplete_stream", async () => {
    const provider = new FakeProvider([[script.text("Half a sent", { partial: true }), script.fail("incomplete_stream")]])
    const events = await collectStream(provider.stream(request, never))
    expect(types(events)).toEqual(["text.delta", "text.delta", "error"])
    expect(events.at(-1)).toMatchObject({ error: { kind: "incomplete_stream", retryable: true } })
  })

  test("a stream can be cut with no terminal event at all", async () => {
    const provider = new FakeProvider([[script.text("Half a sent", { partial: true }), script.cut()]])
    const events = await collectStream(provider.stream(request, never))
    expect(types(events)).toEqual(["text.delta", "text.delta"])
    expect(provider.calls[0]!.outcome).toBe("cut")
  })

  test("plays one response per call, in order, and can compute one from the request", async () => {
    const provider = new FakeProvider([
      [script.text("one")],
      (received, callIndex) => [script.text(`call ${callIndex} saw ${received.input.length} item(s)`)],
    ])
    await collectStream(provider.stream(request, never))
    const second = await collectStream(provider.stream({ ...request, input: [...request.input, ...request.input] }, never))
    expect(second.at(-2)).toMatchObject({ type: "text.end", text: "call 1 saw 2 item(s)" })
    provider.enqueue([script.text("three")])
    expect(provider.remaining).toBe(1)
    expect((await collectStream(provider.stream(request, never))).at(-2)).toMatchObject({ text: "three" })
  })

  test("throws when a call was not scripted", () => {
    const provider = new FakeProvider([])
    expect(() => provider.stream(request, never)).toThrow("call 0 was not scripted")
  })

  test("rejects scripts no provider could produce", () => {
    expect(() => new FakeProvider([[script.finish("stop"), script.text("late")]])).toThrow("nothing may follow")
    expect(() => new FakeProvider([[script.text("half", { partial: true })]])).toThrow("partial")
    expect(() => new FakeProvider([[script.text("half", { partial: true }), script.finish("stop")]])).toThrow("partial")
    const computed = new FakeProvider([() => [script.cut(), script.text("late")]])
    expect(() => computed.stream(request, never)).toThrow("nothing may follow")
  })

  describe("request recording", () => {
    test("records every request it receives, in order", async () => {
      const provider = new FakeProvider([[script.text("one")], [script.text("two")]])
      const followUp: InputItem = { type: "message", role: "user", content: text("again") }
      const second = { ...request, input: [...request.input, followUp] }
      await collectStream(provider.stream(request, never))
      await collectStream(provider.stream(second, never))
      expect(provider.requests).toEqual([request, second])
      expect(provider.calls.map((call) => call.outcome)).toEqual(["finished", "finished"])
    })

    test("records a copy, so later mutation of the caller's request is not seen", async () => {
      const provider = new FakeProvider([[script.text("one")]])
      const input: InputItem[] = [{ type: "message", role: "user", content: text("hi") }]
      const mutable = { ...request, input }
      await collectStream(provider.stream(mutable, never))
      input.push({ type: "message", role: "user", content: text("added later") })
      expect(provider.requests[0]!.input).toHaveLength(1)
    })

    test("records the request even when the stream is never read", () => {
      const provider = new FakeProvider([[script.text("one")]])
      provider.stream(request, never)
      expect(provider.requests).toEqual([request])
      expect(provider.calls[0]!.outcome).toBe("abandoned")
    })

    test("records the events the consumer actually received", async () => {
      const provider = new FakeProvider([[script.text("abcdefghijklmnopqrstuvwxyz", { chunkSize: 2 })]])
      for await (const streamEvent of provider.stream(request, never)) if (streamEvent.type === "text.delta") break
      expect(provider.calls[0]!.events).toEqual([{ type: "text.delta", text: "ab" }])
      expect(provider.calls[0]!.outcome).toBe("abandoned")
    })

    test("prefixBreaks is empty when each request extends the previous one", async () => {
      const provider = new FakeProvider([[script.text("one")], [script.text("two")], [script.text("three")]])
      const second = { ...request, input: [...request.input, { type: "assistant_text", text: "one", providerData: null } as const] }
      const third = { ...second, input: [...second.input, { type: "message", role: "user", content: text("more") } as const] }
      for (const next of [request, second, third]) await collectStream(provider.stream(next, never))
      expect(provider.prefixBreaks()).toEqual([])
    })

    test("prefixBreaks names the call and the first changed block", async () => {
      const provider = new FakeProvider([[script.text("one")], [script.text("two")], [script.text("three")]])
      const rewritten = { ...request, instructions: "You are a coding agent. It is 12:01." }
      for (const next of [request, rewritten, rewritten]) await collectStream(provider.stream(next, never))
      expect(provider.prefixBreaks()).toMatchObject([
        { callIndex: 1, comparison: { extension: false, index: 2, kind: "instructions", change: "changed" } },
      ])
    })
  })

  describe("cancellation", () => {
    test("an already aborted signal yields nothing", async () => {
      const token = createInterrupt()
      token.interrupt("user")
      const provider = new FakeProvider([[script.text("never seen")]])
      expect(await collectStream(provider.stream(request, token.signal))).toEqual([])
      expect(provider.calls[0]!.outcome).toBe("aborted")
    })

    test("aborting mid-stream stops it without a terminal event", async () => {
      const token = createInterrupt()
      const provider = new FakeProvider([[script.text("abcdefghijklmnopqrstuvwxyz", { chunkSize: 2 })]], { delayMs: 5 })
      const events: StreamEvent[] = []
      for await (const streamEvent of provider.stream(request, token.signal)) {
        events.push(streamEvent)
        if (events.length === 3) token.interrupt("user")
      }
      expect(types(events)).toEqual(["text.delta", "text.delta", "text.delta"])
      expect(provider.calls[0]!.outcome).toBe("aborted")
      expect(interruptReasonOf(token.signal)).toBe("user")
    })

    test("aborting during a long delay ends the stream promptly", async () => {
      const token = createInterrupt()
      const provider = new FakeProvider([[script.text("before"), script.delay(60_000), script.text("after")]])
      const startedAt = performance.now()
      setTimeout(() => token.interrupt("shutdown"), 20)
      const events = await collectStream(provider.stream(request, token.signal))
      expect(performance.now() - startedAt).toBeLessThan(5_000)
      expect(types(events)).toEqual(["text.delta", "text.end"])
      expect(provider.calls[0]!.outcome).toBe("aborted")
    })

    test("a hanging stream ends only when aborted", async () => {
      const token = createInterrupt()
      const provider = new FakeProvider([[script.text("partial ans", { partial: true }), script.hang()]])
      const events: StreamEvent[] = []
      const reading = (async () => {
        for await (const streamEvent of provider.stream(request, token.signal)) events.push(streamEvent)
      })()
      await Bun.sleep(20)
      expect(provider.calls[0]!.outcome).toBe("running")
      token.interrupt("user")
      await reading
      expect(types(events)).toEqual(["text.delta", "text.delta"])
      expect(provider.calls[0]!.outcome).toBe("aborted")
    })

    test("a scripted delay holds events back until it elapses", async () => {
      const provider = new FakeProvider([[script.delay(30), script.text("late")]])
      const startedAt = performance.now()
      const events = await collectStream(provider.stream(request, never))
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25)
      expect(types(events)).toEqual(["text.delta", "text.end", "finish"])
    })

    test("aborting leaves no abort listeners behind", async () => {
      const controller = new AbortController()
      let listeners = 0
      const add = controller.signal.addEventListener.bind(controller.signal)
      const remove = controller.signal.removeEventListener.bind(controller.signal)
      controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
        listeners += 1
        return add(...args)
      }) as typeof add
      controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
        listeners -= 1
        return remove(...args)
      }) as typeof remove
      const provider = new FakeProvider([[script.text("abcdef", { chunkSize: 1 })]], { delayMs: 1 })
      await collectStream(provider.stream(request, controller.signal))
      expect(listeners).toBe(0)
    })
  })
})
