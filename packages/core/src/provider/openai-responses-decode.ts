/**
 * Maps Responses API stream events to normalised `StreamEvent`s.
 *
 * The mapper is fed one parsed SSE frame at a time and returns the events it
 * produces. After it has produced a terminal event (`finish` or `error`) it
 * produces nothing more; `end()` reports a stream that stopped without one.
 *
 * Rules (docs/reference/responses-api.md, "Verified live" and section 4):
 * - Item values come from `response.output_item.done`, never from deltas:
 *   argument deltas are not guaranteed, and the encrypted reasoning on
 *   `output_item.added` may be incomplete. Deltas only feed live display.
 * - An item that was started but whose `output_item.done` never came is
 *   completed from `response.completed.response.output` when it is there.
 * - `response.completed` is the only success. `response.incomplete` with
 *   `max_output_tokens` is the `length` finish; with `content_filter` it is a
 *   `content_policy` error; any other reason is a `provider_internal` error.
 * - A refusal content part makes the call a `content_policy` error, reported
 *   when the response ends (after usage). Refusal text is not assistant text.
 * - `response.failed` and `error` frames are classified by their code.
 * - `response.metadata`, `response.created`/`in_progress`/`queued`, content
 *   and summary part boundaries, annotation events and unknown types are ignored.
 */
import type { Json } from "../json.ts"
import { type ProviderError, makeProviderError } from "./error.ts"
import { classify, isRecord, stringOr } from "./openai-responses-error.ts"
import type { StreamEvent } from "./provider.ts"
import type { SseEvent } from "./sse.ts"
import type { Usage } from "./usage.ts"

type Record_ = Record<string, unknown>

interface OpenItem {
  readonly type: string
  readonly id: string | null
  /** For function calls. */
  readonly callId: string
  readonly name: string
  /** Arguments from `function_call_arguments.done`, used only if the item never completes. */
  argumentsDone: string | null
  /** Summary parts seen so far, to insert a separator delta between parts. */
  summaryParts: number
  done: boolean
}

export class ResponsesStreamMapper {
  private readonly items = new Map<number, OpenItem>()
  private toolCalls = 0
  private refusal: string | null = null
  private terminated = false

  constructor(private readonly requestId: string | null = null) {}

  /** True once a terminal event has been produced. */
  get done(): boolean {
    return this.terminated
  }

  /** Maps one SSE frame. A frame that is not a JSON object with a `type` fails the call. */
  frame(frame: SseEvent): StreamEvent[] {
    if (this.terminated) return []
    const parsed = parse(frame.data)
    if (!isRecord(parsed) || typeof parsed.type !== "string")
      return this.fail(
        makeProviderError("provider_internal", this.withRequest(`unparseable stream frame: ${clip(frame.data)}`)),
      )
    return this.event(parsed as Record_ & { type: string })
  }

  /** Called when the body ends. Returns `incomplete_stream` unless a terminal event was produced. */
  end(): StreamEvent[] {
    if (this.terminated) return []
    return this.fail(
      makeProviderError("incomplete_stream", this.withRequest("the stream ended before response.completed")),
    )
  }

  /** Fails the call with an error found outside the frames (transport, timeout). */
  fail(error: ProviderError): StreamEvent[] {
    if (this.terminated) return []
    this.terminated = true
    return [{ type: "error", error }]
  }

  private event(event: Record_ & { type: string }): StreamEvent[] {
    switch (event.type) {
      case "response.output_item.added":
        return this.added(event)
      case "response.output_item.done":
        return isRecord(event.item) ? this.itemDone(integerOr(event.output_index), event.item) : []
      case "response.output_text.delta":
        return typeof event.delta === "string" && event.delta.length > 0 ? [{ type: "text.delta", text: event.delta }] : []
      case "response.reasoning_summary_part.added":
        return this.summaryPart(event)
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return typeof event.delta === "string" && event.delta.length > 0
          ? [{ type: "reasoning.delta", text: event.delta }]
          : []
      case "response.function_call_arguments.delta":
        return this.argumentsDelta(event)
      case "response.function_call_arguments.done": {
        const item = this.items.get(integerOr(event.output_index))
        if (item && typeof event.arguments === "string") item.argumentsDone = event.arguments
        return []
      }
      case "response.refusal.done":
        this.refusal ??= stringOr(event.refusal) ?? "the model refused"
        return []
      case "response.completed":
        return this.completed(isRecord(event.response) ? event.response : {})
      case "response.incomplete":
        return this.incomplete(isRecord(event.response) ? event.response : {})
      case "response.failed":
        return this.failed(isRecord(event.response) ? event.response : {})
      case "error":
        return this.fail(this.errorOf(event))
      default:
        return []
    }
  }

  private added(event: Record_): StreamEvent[] {
    if (!isRecord(event.item) || typeof event.item.type !== "string") return []
    const item = event.item
    this.items.set(integerOr(event.output_index), {
      type: item.type as string,
      id: stringOr(item.id),
      callId: stringOr(item.call_id) ?? "",
      name: stringOr(item.name) ?? "",
      argumentsDone: null,
      summaryParts: 0,
      done: false,
    })
    return []
  }

  private summaryPart(event: Record_): StreamEvent[] {
    const item = this.items.get(integerOr(event.output_index))
    if (!item) return []
    item.summaryParts++
    // `reasoning.end` joins summary parts with a blank line; mirror that in the deltas.
    return item.summaryParts > 1 ? [{ type: "reasoning.delta", text: "\n\n" }] : []
  }

  private argumentsDelta(event: Record_): StreamEvent[] {
    const item = this.items.get(integerOr(event.output_index))
    if (!item || item.type !== "function_call" || typeof event.delta !== "string" || event.delta.length === 0) return []
    return [{ type: "tool_call.delta", callId: item.callId, name: item.name, input: event.delta }]
  }

  private itemDone(index: number, item: Record_): StreamEvent[] {
    const open = this.items.get(index)
    if (open?.done) return []
    if (open) open.done = true
    else this.items.set(index, { type: String(item.type), id: stringOr(item.id), callId: "", name: "", argumentsDone: null, summaryParts: 0, done: true })
    switch (item.type) {
      case "message":
        return this.message(item)
      case "reasoning": {
        const { type: _type, ...data } = item
        const summary = Array.isArray(item.summary) ? item.summary : []
        const text = summary
          .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
          .filter((part) => part.length > 0)
          .join("\n\n")
        return [{ type: "reasoning.end", text, providerData: data as Json }]
      }
      case "function_call": {
        const callId = stringOr(item.call_id) ?? open?.callId ?? ""
        const name = stringOr(item.name) ?? open?.name ?? ""
        const input = typeof item.arguments === "string" ? item.arguments : (open?.argumentsDone ?? "")
        const providerData: Record<string, Json> = {}
        const id = stringOr(item.id) ?? open?.id
        if (id) providerData.id = id
        if (typeof item.namespace === "string") providerData.namespace = item.namespace
        this.toolCalls++
        return [{ type: "tool_call.end", callId, name, input, providerData }]
      }
      default:
        // custom_tool_call and hosted tool items: never requested by this provider.
        return []
    }
  }

  private message(item: Record_): StreamEvent[] {
    const parts = Array.isArray(item.content) ? item.content.filter(isRecord) : []
    const refusal = parts.find((part) => part.type === "refusal")
    if (refusal) this.refusal ??= stringOr(refusal.refusal) ?? "the model refused"
    const texts = parts.filter((part) => part.type === "output_text")
    if (texts.length === 0) return []
    const providerData: Record<string, Json> = {}
    if (typeof item.id === "string") providerData.id = item.id
    if (typeof item.phase === "string") providerData.phase = item.phase
    const text = texts.map((part) => (typeof part.text === "string" ? part.text : "")).join("")
    return [{ type: "text.end", text, providerData }]
  }

  /** Items that started but never got `output_item.done`, completed from the final response's `output`. */
  private settleOpenItems(response: Record_): StreamEvent[] {
    const output = Array.isArray(response.output) ? response.output : []
    return [...this.items.entries()]
      .filter(([, item]) => !item.done)
      .sort(([a], [b]) => a - b)
      .flatMap(([index, item]) => {
        const final = output[index]
        if (isRecord(final) && final.type === item.type) return this.itemDone(index, final)
        // A function call whose arguments were announced as done is still complete.
        if (item.type === "function_call" && item.argumentsDone !== null)
          return this.itemDone(index, { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: item.argumentsDone })
        return []
      })
  }

  private completed(response: Record_): StreamEvent[] {
    const events = [...this.settleOpenItems(response), ...this.usage(response)]
    if (this.refusal !== null)
      return [...events, ...this.fail(makeProviderError("content_policy", this.withRequest(`refused: ${this.refusal}`), { code: "refusal" }))]
    this.terminated = true
    return [...events, { type: "finish", reason: this.toolCalls > 0 ? "tool_calls" : "stop" }]
  }

  private incomplete(response: Record_): StreamEvent[] {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {}
    const reason = stringOr(details.reason)
    const events = this.usage(response)
    if (reason === "max_output_tokens") {
      this.terminated = true
      return [...events, { type: "finish", reason: "length" }]
    }
    const error =
      reason === "content_filter" || this.refusal !== null
        ? makeProviderError("content_policy", this.withRequest(`response incomplete: ${reason ?? "refusal"}`), { code: reason ?? "refusal" })
        : makeProviderError("provider_internal", this.withRequest(`response incomplete: ${reason ?? "no reason given"}`), {
            code: reason ?? undefined,
          })
    return [...events, ...this.fail(error)]
  }

  private failed(response: Record_): StreamEvent[] {
    const error = isRecord(response.error) ? response.error : {}
    const code = stringOr(error.code) ?? stringOr(error.type)
    return [
      ...this.usage(response),
      ...this.fail(
        classify({ code, message: stringOr(error.message) ?? `response failed${code ? `: ${code}` : ""}`, requestId: this.requestId }),
      ),
    ]
  }

  private errorOf(event: Record_): ProviderError {
    // The documented frame is flat ({code, message, param}); some gateways nest it under `error`.
    const source = isRecord(event.error) ? event.error : event
    const code = stringOr(source.code) ?? stringOr(source.type === "error" ? null : source.type)
    const message = stringOr(source.message) ?? `stream error${code ? `: ${code}` : ""}`
    return classify({ code, message, requestId: this.requestId })
  }

  private usage(response: Record_): StreamEvent[] {
    if (!isRecord(response.usage)) return []
    const raw = response.usage
    const input = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {}
    const output = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {}
    const usage: Usage = {
      inputTokens: count(raw.input_tokens),
      cachedInputTokens: count(input.cached_tokens),
      outputTokens: count(raw.output_tokens),
      reasoningTokens: count(output.reasoning_tokens),
    }
    return [{ type: "usage", usage }]
  }

  private withRequest(message: string) {
    return this.requestId ? `${message} (request ${this.requestId})` : message
  }
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

function integerOr(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : -1
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

function clip(text: string) {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
