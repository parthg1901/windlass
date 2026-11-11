/**
 * An incremental server-sent events parser (WHATWG "event stream
 * interpretation"). Bytes may be split anywhere: in the middle of a line, of a
 * `\r\n` pair or of a UTF-8 sequence. Comment lines (`: keep-alive`) are
 * dropped; `id` and `retry` are read and ignored because a model stream is
 * never resumed.
 *
 * One deliberate difference from the spec: at end of input, a pending event
 * whose last line was complete (ended by a newline) is still dispatched. The
 * spec discards it, but a body cut right after the final `data:` line of
 * `response.completed` would then cost a whole retry. A trailing line with no
 * newline is always discarded, because it may be a truncated `data:` line.
 */

export interface SseEvent {
  /** The `event:` field, or `"message"` when the frame had none. */
  readonly event: string
  /** The `data:` lines joined with `\n`. */
  readonly data: string
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8")
  private buffer = ""
  private started = false
  private eventName = ""
  private data: string[] = []
  private hasField = false

  /** Feeds bytes and returns the events completed by them. */
  push(chunk: Uint8Array): SseEvent[] {
    return this.feed(this.decoder.decode(chunk, { stream: true }), false)
  }

  /** Ends the input and returns any event it completes. The parser must not be used afterwards. */
  end(): SseEvent[] {
    const rest = this.decoder.decode()
    const events = this.feed(rest, true)
    // A trailing partial line is dropped: it could be a cut `data:` line.
    this.buffer = ""
    if (this.hasField) {
      const event = this.dispatch()
      if (event) events.push(event)
    }
    return events
  }

  private feed(text: string, final: boolean): SseEvent[] {
    let input = this.buffer + text
    if (!this.started && input.length > 0) {
      this.started = true
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1)
    }
    const events: SseEvent[] = []
    let start = 0
    for (let index = 0; index < input.length; index++) {
      const code = input.charCodeAt(index)
      if (code !== 10 && code !== 13) continue
      // A `\r` at the very end may be the first half of `\r\n`; wait for more input.
      if (code === 13 && index === input.length - 1 && !final) break
      const event = this.line(input.slice(start, index))
      if (event) events.push(event)
      if (code === 13 && input.charCodeAt(index + 1) === 10) index++
      start = index + 1
    }
    this.buffer = input.slice(start)
    return events
  }

  private line(line: string): SseEvent | undefined {
    if (line.length === 0) return this.dispatch()
    if (line.charCodeAt(0) === 58) return undefined // ":" comment
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1)
    if (field === "event") this.eventName = value
    else if (field === "data") this.data.push(value)
    else return undefined
    this.hasField = true
    return undefined
  }

  private dispatch(): SseEvent | undefined {
    const event = this.data.length > 0 ? { event: this.eventName || "message", data: this.data.join("\n") } : undefined
    this.eventName = ""
    this.data = []
    this.hasField = false
    return event
  }
}
