/**
 * The provider contract: one model call in, a stream of normalised events out.
 * A provider does not retry, does not persist and does not know about
 * sessions. The step loop owns the single attempt budget (retry rule 1).
 */
import type { Json } from "../json.ts"
import type { ModelRequest } from "../request/request.ts"
import type { ProviderError } from "./error.ts"
import type { Usage } from "./usage.ts"

/**
 * Why the model stopped.
 * - `stop`: the model finished its answer.
 * - `tool_calls`: the model wants its tool calls run.
 * - `length`: the output limit was reached. Any tool call still streaming was
 *   never ended, so it is never executed (retry rule 6).
 *
 * A refusal is not a finish reason; it is the `content_policy` error.
 */
export type FinishReason = "stop" | "tool_calls" | "length"

/**
 * Events of one model call, in the order the provider produced them.
 *
 * Output items arrive one at a time: the deltas of an item are followed by its
 * `end` event before the next item starts, except tool calls, which may
 * interleave and are told apart by `callId`. Each `end` event carries the
 * complete value, so a consumer that ignores deltas loses nothing.
 *
 * `providerData` is an opaque payload (encrypted reasoning, item phase) that
 * must be stored as received and sent back verbatim in later requests.
 */
export type StreamEvent =
  | { readonly type: "text.delta"; readonly text: string }
  /** A text item is complete. `text` is the whole item, not the last delta. */
  | { readonly type: "text.end"; readonly text: string; readonly providerData: Json | null }
  | { readonly type: "reasoning.delta"; readonly text: string }
  /** A reasoning item is complete. `text` is its readable summary and may be empty. */
  | { readonly type: "reasoning.end"; readonly text: string; readonly providerData: Json | null }
  /** A piece of a tool call's argument text. `callId` and `name` are repeated on every delta. */
  | { readonly type: "tool_call.delta"; readonly callId: string; readonly name: string; readonly input: string }
  /**
   * A tool call is complete. `input` is the whole argument text exactly as the
   * model wrote it; it is not parsed here, so malformed JSON reaches the tool
   * runtime, which answers the model with a tool error.
   */
  | {
      readonly type: "tool_call.end"
      readonly callId: string
      readonly name: string
      readonly input: string
      readonly providerData: Json | null
    }
  /** Token counts for the call. Sent at most once, before the terminal event. */
  | { readonly type: "usage"; readonly usage: Usage }
  /** Terminal: the call succeeded. */
  | { readonly type: "finish"; readonly reason: FinishReason }
  /** Terminal: the call failed, before or after partial output. */
  | { readonly type: "error"; readonly error: ProviderError }

export type StreamEventType = StreamEvent["type"]

export interface Provider {
  /** Stable name of the provider, recorded for diagnosis. */
  readonly id: string
  /**
   * Starts one model call.
   *
   * - The stream ends with exactly one terminal event, `finish` or `error`, and
   *   yields nothing after it. A stream that ends without one must be treated
   *   by the consumer as `incomplete_stream`.
   * - Failures are never thrown. The provider classifies every failure,
   *   including connection errors and malformed responses, into an `error` event.
   * - The only exception is abort: when `signal` aborts, the stream stops
   *   promptly and ends without a terminal event. The consumer checks
   *   `signal.aborted` to tell this from a broken stream.
   * - The request is sent as given. The provider never adds, drops or reorders
   *   content, because the request was already hashed into the ledger.
   */
  readonly stream: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<StreamEvent>
}
