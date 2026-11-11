/**
 * The event stream of a session: one queue per consumer, filled by the loop
 * and read at the consumer's own pace.
 *
 * The loop never waits for a consumer, so a slow or stopped reader cannot
 * stall a turn. What keeps a queue from growing without bound is that the two
 * kinds of event are not equal:
 *
 * - a durable event is always kept, in order. There are only as many as the
 *   log has;
 * - an ephemeral delta is progress, and the durable event that ends its item
 *   carries the whole value. While a reader is behind, a delta is merged into
 *   the delta already waiting for the same item (text is joined, tool
 *   progress is replaced), so a backlog holds at most one delta per run of
 *   deltas, however many arrived.
 *
 * A reader that keeps up sees every delta as it arrived.
 */
import type { StoredEvent } from "../event/durable.ts"
import type { EphemeralEvent } from "../event/ephemeral.ts"

/** One item of a session's event stream. Durable and ephemeral type names are disjoint, so `type` tells them apart. */
export type EngineEvent = StoredEvent | EphemeralEvent

export class EventChannel implements AsyncIterable<EngineEvent> {
  private readonly queue: EngineEvent[] = []
  private waiting: ((result: IteratorResult<EngineEvent>) => void) | null = null
  private ended = false

  push(event: EngineEvent): void {
    if (this.ended) return
    const waiting = this.waiting
    if (waiting !== null) {
      this.waiting = null
      waiting({ value: event, done: false })
      return
    }
    const last = this.queue.at(-1)
    const merged = last === undefined ? null : merge(last, event)
    if (merged === null) this.queue.push(event)
    else this.queue[this.queue.length - 1] = merged
  }

  /** Ends the stream: a reader gets what is already queued and then `done`. */
  end(): void {
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    this.waiting = null
    waiting?.({ value: undefined, done: true })
  }

  /** Events queued and not yet read. */
  get backlog(): number {
    return this.queue.length
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return {
      next: () => {
        const next = this.queue.shift()
        if (next !== undefined) return Promise.resolve({ value: next, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: () => {
        this.end()
        this.queue.length = 0
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/** The single delta that says what `queued` followed by `next` say, or `null` when they are not about the same item. */
function merge(queued: EngineEvent, next: EngineEvent): EngineEvent | null {
  if (queued.type !== next.type || !("messageId" in queued) || !("messageId" in next)) return null
  if (queued.type === "text.delta" && next.type === "text.delta")
    return queued.messageId === next.messageId ? { ...queued, text: queued.text + next.text } : null
  if (queued.type === "reasoning.delta" && next.type === "reasoning.delta")
    return queued.messageId === next.messageId ? { ...queued, text: queued.text + next.text } : null
  if (queued.type === "tool.input.delta" && next.type === "tool.input.delta")
    return queued.messageId === next.messageId && queued.callId === next.callId ? { ...queued, input: queued.input + next.input } : null
  if (queued.type === "tool.progress" && next.type === "tool.progress")
    return queued.messageId === next.messageId && queued.callId === next.callId ? next : null
  return null
}
