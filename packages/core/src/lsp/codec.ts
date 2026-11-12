/**
 * The LSP base protocol's framing: each message is a header block, a blank
 * line, then a JSON body of exactly `Content-Length` bytes.
 *
 *   Content-Length: 52\r\n
 *   \r\n
 *   {"jsonrpc":"2.0","id":1,"method":"initialize",...}
 *
 * Pure. The decoder takes bytes in whatever pieces the pipe delivers them (a
 * frame split over many reads, several frames in one read) and gives back
 * whole messages. What a server writes is untrusted: a header block that is
 * not `Name: value` lines, a missing or invalid `Content-Length`, a header
 * block or body over the limits ends the stream (framing cannot be resumed
 * once lost); a correctly framed body that is not JSON is counted and skipped.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CR = 0x0d
const LF = 0x0a

/** Default bound on one message body. A diagnostics flood of thousands of items stays far below it. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
/** A header block longer than this without its blank line is not a header block. */
export const MAX_HEADER_BYTES = 8 * 1024

export function encodeMessage(message: object): Uint8Array {
  const body = encoder.encode(JSON.stringify({ jsonrpc: "2.0", ...message }))
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

export interface DecodeResult {
  /** The bodies decoded from this chunk and what was buffered before it, in order. */
  readonly messages: readonly unknown[]
  /** Set once the stream can no longer be read; every later `push` returns it again and no messages. */
  readonly error: string | null
}

export interface FrameDecoder {
  push(chunk: Uint8Array): DecodeResult
  /** Correctly framed bodies that were not JSON. */
  readonly invalidBodies: number
}

export function createFrameDecoder(options: { readonly maxMessageBytes?: number } = {}): FrameDecoder {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  let buffer = new Uint8Array(0)
  let error: string | null = null
  let invalidBodies = 0
  /** The body length once the current frame's header was read; `null` while reading a header. */
  let bodyLength: number | null = null

  const append = (chunk: Uint8Array) => {
    if (buffer.length === 0) {
      buffer = chunk.slice()
      return
    }
    const joined = new Uint8Array(buffer.length + chunk.length)
    joined.set(buffer, 0)
    joined.set(chunk, buffer.length)
    buffer = joined
  }

  return {
    get invalidBodies() {
      return invalidBodies
    },
    push(chunk) {
      if (error !== null) return { messages: [], error }
      append(chunk)
      const messages: unknown[] = []
      for (;;) {
        if (bodyLength === null) {
          const end = headerEnd(buffer)
          if (end === -1) {
            if (buffer.length > MAX_HEADER_BYTES) error = `a header block longer than ${MAX_HEADER_BYTES} bytes`
            break
          }
          const parsed = parseHeaders(decoder.decode(buffer.subarray(0, end.start)), maxMessageBytes)
          if (typeof parsed === "string") {
            error = parsed
            break
          }
          bodyLength = parsed
          buffer = buffer.subarray(end.after)
        }
        if (buffer.length < bodyLength) break
        const body = buffer.subarray(0, bodyLength)
        buffer = buffer.subarray(bodyLength)
        bodyLength = null
        try {
          messages.push(JSON.parse(decoder.decode(body)))
        } catch {
          invalidBodies += 1
        }
      }
      if (error !== null) buffer = new Uint8Array(0)
      return { messages, error }
    },
  }
}

/** Where the header block ends: `\r\n\r\n`, or a bare `\n\n` (lenient, some servers write it). */
function headerEnd(bytes: Uint8Array): { start: number; after: number } | -1 {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== LF) continue
    if (bytes[index + 1] === LF) return { start: index, after: index + 2 }
    if (bytes[index + 1] === CR && bytes[index + 2] === LF) return { start: index, after: index + 3 }
  }
  return -1
}

/** The body length, or what is wrong with the header block. */
function parseHeaders(block: string, maxMessageBytes: number): number | string {
  let length: number | null = null
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (line === "") continue
    const colon = line.indexOf(":")
    if (colon <= 0 || !/^[A-Za-z0-9-]+$/.test(line.slice(0, colon))) return `an invalid header line: ${JSON.stringify(line.slice(0, 80))}`
    if (line.slice(0, colon).toLowerCase() !== "content-length") continue
    const value = line.slice(colon + 1).trim()
    if (!/^\d{1,12}$/.test(value)) return `an invalid Content-Length: ${JSON.stringify(value.slice(0, 40))}`
    length = Number(value)
  }
  if (length === null) return "a header block without Content-Length"
  if (length > maxMessageBytes) return `a message of ${length} bytes, over the limit of ${maxMessageBytes}`
  return length
}
