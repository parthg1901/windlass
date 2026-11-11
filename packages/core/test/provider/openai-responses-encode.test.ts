import { describe, expect, test } from "bun:test"
import { MissingBlobError, blobRefs, encodeRequest } from "../../src/provider/openai-responses-encode.ts"
import type { StreamEvent } from "../../src/provider/provider.ts"
import { canonicalJson } from "../../src/request/canonical.ts"
import type { InputItem, ModelRequest } from "../../src/request/request.ts"
import { decodeChunks, fixtureBytes } from "./responses-helpers.ts"

const weather = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
}
const readFile = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

const params = {
  model: "gpt-6-luna",
  reasoningEffort: "low",
  textVerbosity: null,
  parallelToolCalls: true,
  cacheKey: "cache-key-TEST",
}

/** Step 2 of a tool conversation, built from step 1's decoded events as the request builder would. */
function stepTwo(): ModelRequest {
  return {
    params,
    tools: [weather, readFile],
    instructions: "You are terse.",
    input: [
      { type: "message", role: "developer", content: [{ type: "text", text: "Workspace: /tmp/x" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
      {
        type: "reasoning",
        text: "**Computing**",
        providerData: { id: "rs_TEST1", summary: [{ type: "summary_text", text: "**Computing**" }], content: [], encrypted_content: "enc_PLACEHOLDER" },
      },
      { type: "assistant_text", text: "Checking.", providerData: { id: "msg_TEST1", phase: "commentary" } },
      { type: "tool_call", callId: "call_TEST1", name: "get_weather", input: '{"city": "Paris"}', providerData: { id: "fc_TEST1" } },
      { type: "tool_result", callId: "call_TEST1", output: '{"temp_c":14}', attachments: [] },
    ],
    toolChoice: "auto",
  }
}

describe("encodeRequest", () => {
  test("a multi-step tool conversation encodes to the hand-written body", () => {
    const expected = {
      model: "gpt-6-luna",
      store: false,
      stream: true,
      stream_options: { include_obfuscation: false },
      include: ["reasoning.encrypted_content"],
      instructions: "You are terse.",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
          strict: false,
        },
        {
          type: "function",
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
      prompt_cache_key: "cache-key-TEST",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Workspace: /tmp/x" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] },
        { type: "reasoning", id: "rs_TEST1", summary: [{ type: "summary_text", text: "**Computing**" }], content: [], encrypted_content: "enc_PLACEHOLDER" },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          id: "msg_TEST1",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking.", annotations: [] }],
        },
        { type: "function_call", id: "fc_TEST1", call_id: "call_TEST1", name: "get_weather", arguments: '{"city": "Paris"}' },
        { type: "function_call_output", call_id: "call_TEST1", output: '{"temp_c":14}' },
      ],
    }
    const encoded = encodeRequest(stepTwo(), new Map())
    expect(JSON.parse(encoded.body)).toEqual(expected)
    // Byte-exact: the body is the canonical form of the expected object.
    expect(encoded.body).toBe(canonicalJson(expected))
    expect(encoded.headers).toEqual({ "content-type": "application/json", accept: "text/event-stream", "session-id": "cache-key-TEST" })
  })

  test("never sends a field the flow rejects, and never a system role", () => {
    const body = encodeRequest(stepTwo(), new Map()).body
    const keys = Object.keys(JSON.parse(body) as object)
    for (const field of ["temperature", "top_p", "max_output_tokens", "previous_response_id", "metadata", "user", "truncation", "prompt_cache_retention", "safety_identifier"])
      expect(keys).not.toContain(field)
    expect(body).not.toContain('"system"')
  })

  test("encoding the same request twice, or a copy with different key order, is byte-identical", () => {
    const request = stepTwo()
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]))
          : value
    const shuffled = reverseKeys(request) as ModelRequest
    expect(Object.keys(shuffled)).toEqual(Object.keys(request).reverse())
    const first = encodeRequest(request, new Map()).body
    expect(encodeRequest(request, new Map()).body).toBe(first)
    expect(encodeRequest(shuffled, new Map()).body).toBe(first)
  })

  test("the tool list keeps the order it was given", () => {
    const names = (request: ModelRequest) =>
      (JSON.parse(encodeRequest(request, new Map()).body) as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    expect(names({ ...stepTwo(), tools: [weather, readFile] })).toEqual(["get_weather", "read_file"])
    expect(names({ ...stepTwo(), tools: [readFile, weather] })).toEqual(["read_file", "get_weather"])
  })

  test("the final call sends tool_choice none with the tool list unchanged", () => {
    const auto = JSON.parse(encodeRequest(stepTwo(), new Map()).body) as Record<string, unknown>
    const none = JSON.parse(encodeRequest({ ...stepTwo(), toolChoice: "none" }, new Map()).body) as Record<string, unknown>
    expect(none.tool_choice).toBe("none")
    expect(none.tools).toEqual(auto.tools)
    expect({ ...none, tool_choice: "auto" } as Record<string, unknown>).toEqual(auto)
  })

  test("optional params: no cache key means no header and no prompt_cache_key; verbosity and effort map when set", () => {
    const request: ModelRequest = { ...stepTwo(), params: { ...params, cacheKey: null, reasoningEffort: null, textVerbosity: "low" }, instructions: "" }
    const encoded = encodeRequest(request, new Map())
    const body = JSON.parse(encoded.body) as Record<string, unknown>
    expect(encoded.headers["session-id"]).toBeUndefined()
    expect(body.prompt_cache_key).toBeUndefined()
    expect(body.instructions).toBeUndefined()
    expect(body.reasoning).toEqual({ summary: "auto" })
    expect(body.text).toEqual({ verbosity: "low" })
  })

  test("a reasoning item without encrypted content is not replayed; items without providerData get no ids", () => {
    const request: ModelRequest = {
      ...stepTwo(),
      input: [
        { type: "reasoning", text: "summary only", providerData: null },
        { type: "assistant_text", text: "Hi.", providerData: null },
        { type: "tool_call", callId: "call_1", name: "read_file", input: "{bad json", providerData: null },
      ],
    }
    expect((JSON.parse(encodeRequest(request, new Map()).body) as { input: unknown[] }).input).toEqual([
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hi.", annotations: [] }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{bad json" },
    ])
  })

  test("images become data-URL input_image parts, in user messages and tool results; other media become input_file", () => {
    const png = { hash: "a".repeat(64), mediaType: "image/png" }
    const pdf = { hash: "b".repeat(64), mediaType: "application/pdf" }
    const request: ModelRequest = {
      ...stepTwo(),
      input: [
        { type: "message", role: "user", content: [{ type: "text", text: "Look" }, { type: "media", blob: png }, { type: "media", blob: pdf }] },
        { type: "tool_result", callId: "call_1", output: "screenshot", attachments: [png] },
      ],
    }
    expect(blobRefs(request)).toEqual([png, pdf])
    const blobs = new Map([
      [png.hash, new Uint8Array([1, 2, 3])],
      [pdf.hash, new TextEncoder().encode("%PDF")],
    ])
    expect((JSON.parse(encodeRequest(request, blobs).body) as { input: unknown[] }).input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Look" },
          { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "auto" },
          { type: "input_file", filename: "bbbbbbbbbbbbbbbb.pdf", file_data: "data:application/pdf;base64,JVBERg==" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "screenshot" },
          { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "auto" },
        ],
      },
    ])
    expect(() => encodeRequest(request, new Map())).toThrow(MissingBlobError)
  })

  test("decoded output replays as the items the API returned (reasoning verbatim, call minimal)", async () => {
    const events = decodeChunks([await fixtureBytes("reasoning-function-call.sse")])
    const replayed = events.flatMap((event: StreamEvent): InputItem[] => {
      if (event.type === "reasoning.end") return [{ type: "reasoning", text: event.text, providerData: event.providerData }]
      if (event.type === "tool_call.end")
        return [{ type: "tool_call", callId: event.callId, name: event.name, input: event.input, providerData: event.providerData }]
      return []
    })
    const input = (JSON.parse(encodeRequest({ ...stepTwo(), input: replayed }, new Map()).body) as { input: unknown[] }).input
    const text = new TextDecoder().decode(await fixtureBytes("reasoning-function-call.sse"))
    const done = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.includes('"response.output_item.done"'))
      .map((line) => (JSON.parse(line.slice(6)) as { item: Record<string, unknown> }).item)
    expect(input[0]).toEqual(done[0]!)
    const { status: _status, ...call } = done[1]!
    expect(input[1]).toEqual(call)
  })
})
