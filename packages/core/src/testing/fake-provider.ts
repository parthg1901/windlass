/**
 * A scripted provider for tests. It implements `Provider` exactly as a real
 * one must, plays one scripted response per `stream` call and records every
 * request it is given.
 *
 *   const provider = new FakeProvider([
 *     [script.reasoning("look first"), script.toolCall("call_1", "read", { path: "a.ts" })],
 *     [script.text("Done.")],
 *   ])
 *
 * A response without a terminal item gets `finish` appended: `tool_calls` if
 * it contains a complete tool call, otherwise `stop`.
 */
import type { Json } from "../json.ts"
import { type ProviderError, type ProviderErrorDetail, type ProviderErrorKind, makeProviderError } from "../provider/error.ts"
import type { FinishReason, Provider, ResponseFacts, StreamEvent } from "../provider/provider.ts"
import type { Usage } from "../provider/usage.ts"
import { type PrefixComparison, comparePrefix, hashRequest } from "../request/prefix.ts"
import type { ModelRequest } from "../request/request.ts"

export type ScriptItem =
  /** A text item streamed as `chunks`. With `partial`, the deltas are sent but the item never ends. */
  | { readonly type: "text"; readonly chunks: readonly string[]; readonly providerData: Json | null; readonly partial: boolean }
  /** A reasoning item streamed as `chunks`. With `partial`, it never ends. */
  | {
      readonly type: "reasoning"
      readonly chunks: readonly string[]
      readonly providerData: Json | null
      readonly partial: boolean
    }
  /** A tool call whose argument text is streamed as `chunks`. With `partial`, the arguments are cut short. */
  | {
      readonly type: "tool_call"
      readonly callId: string
      readonly name: string
      readonly chunks: readonly string[]
      readonly providerData: Json | null
      readonly partial: boolean
    }
  | { readonly type: "usage"; readonly usage: Usage }
  /** Waits before the next item. Ends early if the call is aborted. */
  | { readonly type: "delay"; readonly ms: number }
  /** Terminal: the call succeeds. */
  | { readonly type: "finish"; readonly reason: FinishReason; readonly response?: ResponseFacts }
  /** Terminal: the call fails with a classified error, as a conforming provider reports it. */
  | { readonly type: "error"; readonly error: ProviderError }
  /** Terminal: the stream ends with no terminal event at all, which a consumer must treat as `incomplete_stream`. */
  | { readonly type: "cut" }
  /** Terminal: nothing more arrives until the call is aborted. */
  | { readonly type: "hang" }

/** The response to one `stream` call: fixed, or computed from the request and the zero-based call index. */
export type ScriptedResponse =
  | readonly ScriptItem[]
  | ((request: ModelRequest, callIndex: number) => readonly ScriptItem[])

interface ItemOptions {
  /** Maximum characters per delta. Defaults to 8. */
  readonly chunkSize?: number
  readonly providerData?: Json
  /** Send the deltas but never the end event. Follow it with `fail`, `cut`, `hang` or `finish("length")`. */
  readonly partial?: boolean
}

/** Builders for script items. */
export const script = {
  text: (value: string, options: ItemOptions = {}): ScriptItem => ({
    type: "text",
    chunks: split(value, options.chunkSize),
    providerData: options.providerData ?? null,
    partial: options.partial ?? false,
  }),
  reasoning: (value: string, options: ItemOptions = {}): ScriptItem => ({
    type: "reasoning",
    chunks: split(value, options.chunkSize),
    providerData: options.providerData ?? null,
    partial: options.partial ?? false,
  }),
  /** `input` is sent as given when it is a string (so it can be malformed JSON), otherwise as its JSON text. */
  toolCall: (callId: string, name: string, input: Json, options: ItemOptions = {}): ScriptItem => ({
    type: "tool_call",
    callId,
    name,
    chunks: split(typeof input === "string" ? input : JSON.stringify(input), options.chunkSize),
    providerData: options.providerData ?? null,
    partial: options.partial ?? false,
  }),
  usage: (usage: Partial<Usage> = {}): ScriptItem => ({
    type: "usage",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, ...usage },
  }),
  delay: (ms: number): ScriptItem => ({ type: "delay", ms }),
  /** `response`: what the provider says about the response it finished (its own ID of the request, the model that answered). */
  finish: (reason: FinishReason, response?: ResponseFacts): ScriptItem => ({ type: "finish", reason, ...(response === undefined ? {} : { response }) }),
  /** Fails the call with an error of the given class. */
  fail: (
    kind: ProviderErrorKind,
    detail: ProviderErrorDetail & { message?: string } = {},
  ): ScriptItem => ({ type: "error", error: makeProviderError(kind, detail.message ?? `scripted ${kind}`, detail) }),
  cut: (): ScriptItem => ({ type: "cut" }),
  hang: (): ScriptItem => ({ type: "hang" }),
}

/**
 * How a recorded call ended.
 * - `running`: the stream is still being consumed.
 * - `finished` / `failed`: it yielded `finish` / `error`.
 * - `cut`: it ended without a terminal event because the script said so.
 * - `aborted`: the signal aborted it.
 * - `abandoned`: the consumer stopped reading (or never started).
 */
export type FakeCallOutcome = "running" | "finished" | "failed" | "cut" | "aborted" | "abandoned"

export interface FakeCall {
  /** A deep copy of the request, taken when `stream` was called. */
  readonly request: ModelRequest
  /** Every event the consumer received, in order. */
  readonly events: readonly StreamEvent[]
  readonly outcome: FakeCallOutcome
}

export interface FakeProviderOptions {
  /** Wait this long before every event, so a test can abort in the middle of a stream. Defaults to 0. */
  readonly delayMs?: number
}

const TERMINAL: readonly ScriptItem["type"][] = ["finish", "error", "cut", "hang"]

export class FakeProvider implements Provider {
  readonly id = "fake"
  readonly calls: FakeCall[] = []
  private readonly responses: ScriptedResponse[]
  private readonly delayMs: number

  constructor(responses: readonly ScriptedResponse[] = [], options: FakeProviderOptions = {}) {
    for (const response of responses) if (typeof response !== "function") check(response)
    this.responses = [...responses]
    this.delayMs = options.delayMs ?? 0
  }

  /** Adds responses for later calls. */
  enqueue(...responses: ScriptedResponse[]): void {
    for (const response of responses) if (typeof response !== "function") check(response)
    this.responses.push(...responses)
  }

  /** The requests received so far, in call order. */
  get requests(): readonly ModelRequest[] {
    return this.calls.map((call) => call.request)
  }

  /** Scripted responses not yet used. A finished test usually expects 0. */
  get remaining(): number {
    return this.responses.length
  }

  /**
   * Compares each recorded request with the one before it and returns the
   * comparisons that are not extensions. An empty array means every request
   * extended the previous one (context rule 1).
   */
  prefixBreaks(): { readonly callIndex: number; readonly comparison: PrefixComparison }[] {
    const hashes = this.requests.map(hashRequest)
    return hashes.flatMap((next, callIndex) => {
      const previous = hashes[callIndex - 1]
      if (previous === undefined) return []
      const comparison = comparePrefix(previous, next)
      return comparison.extension ? [] : [{ callIndex, comparison }]
    })
  }

  stream = (request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent> => {
    const callIndex = this.calls.length
    const response = this.responses.shift()
    if (response === undefined)
      throw new Error(`FakeProvider: call ${callIndex} was not scripted (${callIndex} response(s) were)`)
    const recorded = structuredClone(request)
    const items = typeof response === "function" ? check(response(recorded, callIndex)) : response
    const call: { request: ModelRequest; events: StreamEvent[]; outcome: FakeCallOutcome } = {
      request: recorded,
      events: [],
      outcome: "abandoned",
    }
    this.calls.push(call)
    return this.play(call, items, signal)
  }

  private async *play(
    call: { events: StreamEvent[]; outcome: FakeCallOutcome },
    items: readonly ScriptItem[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    call.outcome = "running"
    try {
      for (const action of expand(items)) {
        if (signal.aborted) break
        if (action.type === "hang") {
          await sleep(Number.POSITIVE_INFINITY, signal)
          break
        }
        if (action.type === "cut") {
          call.outcome = "cut"
          return
        }
        if (action.type === "delay") {
          await sleep(action.ms, signal)
          continue
        }
        if (this.delayMs > 0) await sleep(this.delayMs, signal)
        if (signal.aborted) break
        call.events.push(action.event)
        yield action.event
        if (action.event.type === "finish" || action.event.type === "error") {
          call.outcome = action.event.type === "finish" ? "finished" : "failed"
          return
        }
      }
      call.outcome = "aborted"
    } finally {
      // Reached with "running" only when the consumer stopped reading.
      if (call.outcome === "running") call.outcome = "abandoned"
    }
  }
}

/** Reads a whole stream into an array. */
export async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const streamEvent of stream) events.push(streamEvent)
  return events
}

type Action =
  | { readonly type: "event"; readonly event: StreamEvent }
  | { readonly type: "delay"; readonly ms: number }
  | { readonly type: "cut" }
  | { readonly type: "hang" }

function expand(items: readonly ScriptItem[]): Action[] {
  const emit = (event: StreamEvent): Action => ({ type: "event", event })
  const actions = items.flatMap((item): Action[] => {
    switch (item.type) {
      case "text":
        return [
          ...item.chunks.map((chunk) => emit({ type: "text.delta", text: chunk })),
          ...(item.partial ? [] : [emit({ type: "text.end", text: item.chunks.join(""), providerData: item.providerData })]),
        ]
      case "reasoning":
        return [
          ...item.chunks.map((chunk) => emit({ type: "reasoning.delta", text: chunk })),
          ...(item.partial
            ? []
            : [emit({ type: "reasoning.end", text: item.chunks.join(""), providerData: item.providerData })]),
        ]
      case "tool_call":
        return [
          ...item.chunks.map((chunk) =>
            emit({ type: "tool_call.delta", callId: item.callId, name: item.name, input: chunk }),
          ),
          ...(item.partial
            ? []
            : [
                emit({
                  type: "tool_call.end",
                  callId: item.callId,
                  name: item.name,
                  input: item.chunks.join(""),
                  providerData: item.providerData,
                }),
              ]),
        ]
      case "usage":
        return [emit({ type: "usage", usage: item.usage })]
      case "finish":
        return [emit({ type: "finish", reason: item.reason, ...(item.response === undefined ? {} : { response: item.response }) })]
      case "error":
        return [emit({ type: "error", error: item.error })]
      case "delay":
        return [{ type: "delay", ms: item.ms }]
      case "cut":
        return [{ type: "cut" }]
      case "hang":
        return [{ type: "hang" }]
    }
  })
  if (items.some((item) => TERMINAL.includes(item.type))) return actions
  const calledTools = items.some((item) => item.type === "tool_call")
  return [...actions, emit({ type: "finish", reason: calledTools ? "tool_calls" : "stop" })]
}

/** Rejects scripts that no conforming provider could produce. */
function check(items: readonly ScriptItem[]): readonly ScriptItem[] {
  const terminal = items.findIndex((item) => TERMINAL.includes(item.type))
  if (terminal !== -1 && terminal !== items.length - 1)
    throw new Error(`FakeProvider: nothing may follow a ${items[terminal]!.type} item`)
  const last = items.at(-1)
  const partial = items.some((item) => "partial" in item && item.partial)
  // The output limit is the one way a call succeeds with an item unfinished (a tool call cut off mid-arguments).
  const cutByLimit = last?.type === "finish" && last.reason === "length"
  if (partial && !cutByLimit && (last === undefined || last.type === "finish" || !TERMINAL.includes(last.type)))
    throw new Error("FakeProvider: a response with a partial item must end with fail, cut, hang or finish(\"length\")")
  return items
}

function split(value: string, chunkSize = 8): string[] {
  if (chunkSize < 1) throw new Error("FakeProvider: chunkSize must be at least 1")
  const chunks: string[] = []
  for (let start = 0; start < value.length; start += chunkSize) chunks.push(value.slice(start, start + chunkSize))
  return chunks
}

/** Resolves after `ms`, or as soon as the signal aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = Number.isFinite(ms) ? setTimeout(done, ms) : undefined
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
  })
}
