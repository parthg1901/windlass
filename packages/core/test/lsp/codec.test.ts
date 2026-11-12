/** The Content-Length framing: split and merged frames, invalid headers, bounds. */
import { describe, expect, test } from "bun:test"
import { MAX_HEADER_BYTES, createFrameDecoder, encodeMessage } from "../../src/lsp/codec.ts"

const bytes = (text: string) => new TextEncoder().encode(text)
const frame = (body: string) => bytes(`Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`)

describe("encode", () => {
  test("adds jsonrpc and counts bytes, not characters", () => {
    const encoded = new TextDecoder().decode(encodeMessage({ id: 1, method: "x", params: { text: "é→" } }))
    const body = '{"jsonrpc":"2.0","id":1,"method":"x","params":{"text":"é→"}}'
    expect(encoded).toBe(`Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`)
  })

  test("round-trips through the decoder", () => {
    const decoder = createFrameDecoder()
    const { messages, error } = decoder.push(encodeMessage({ id: 7, result: { ok: true } }))
    expect(error).toBeNull()
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 7, result: { ok: true } }])
  })
})

describe("decode", () => {
  test("a frame split at every byte", () => {
    const decoder = createFrameDecoder()
    const all = frame('{"a":"ü"}')
    const out: unknown[] = []
    for (let i = 0; i < all.length; i += 1) out.push(...decoder.push(all.subarray(i, i + 1)).messages)
    expect(out).toEqual([{ a: "ü" }])
  })

  test("several frames in one chunk, and one ending mid-header of the next", () => {
    const decoder = createFrameDecoder()
    const joined = new Uint8Array([...frame('{"n":1}'), ...frame('{"n":2}'), ...bytes("Content-Le")])
    expect(decoder.push(joined).messages).toEqual([{ n: 1 }, { n: 2 }])
    expect(decoder.push(bytes('ngth: 7\r\n\r\n{"n":3}')).messages).toEqual([{ n: 3 }])
  })

  test("other headers, any case, and a bare-newline separator", () => {
    const decoder = createFrameDecoder()
    const body = '{"x":1}'
    expect(decoder.push(bytes(`content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}\r\n\r\n${body}`)).messages).toEqual([{ x: 1 }])
    expect(decoder.push(bytes(`Content-Length: ${body.length}\n\n${body}`)).messages).toEqual([{ x: 1 }])
  })

  test("a framed body that is not JSON is counted and skipped", () => {
    const decoder = createFrameDecoder()
    const result = decoder.push(new Uint8Array([...frame("not json"), ...frame('{"ok":1}')]))
    expect(result.messages).toEqual([{ ok: 1 }])
    expect(result.error).toBeNull()
    expect(decoder.invalidBodies).toBe(1)
  })

  test.each([
    ["no Content-Length", "Content-Type: x\r\n\r\n{}", "a header block without Content-Length"],
    ["a non-numeric length", "Content-Length: ten\r\n\r\n{}", 'an invalid Content-Length: "ten"'],
    ["a negative length", "Content-Length: -2\r\n\r\n{}", 'an invalid Content-Length: "-2"'],
    ["a line that is not a header", "hello world\r\n\r\n{}", 'an invalid header line: "hello world"'],
  ])("%s ends the stream", (_, input, message) => {
    const decoder = createFrameDecoder()
    expect(decoder.push(bytes(input))).toEqual({ messages: [], error: message })
    // Once lost, framing is not resumed.
    expect(decoder.push(frame("{}")).messages).toEqual([])
  })

  test("a length over the limit ends the stream before reading the body", () => {
    const decoder = createFrameDecoder({ maxMessageBytes: 100 })
    expect(decoder.push(bytes("Content-Length: 101\r\n\r\n")).error).toBe("a message of 101 bytes, over the limit of 100")
  })

  test("a header block that never ends is cut off", () => {
    const decoder = createFrameDecoder()
    expect(decoder.push(bytes("X".repeat(MAX_HEADER_BYTES + 1))).error).toBe(`a header block longer than ${MAX_HEADER_BYTES} bytes`)
  })

  test("messages before a broken frame are still delivered", () => {
    const decoder = createFrameDecoder()
    const result = decoder.push(new Uint8Array([...frame('{"n":1}'), ...bytes("garbage\r\n\r\n")]))
    expect(result.messages).toEqual([{ n: 1 }])
    expect(result.error).toContain("invalid header line")
  })
})
