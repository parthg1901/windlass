/**
 * Scripted sessions for the request-builder tests. Every event goes through
 * the real reducer, so a script can only describe logs the store would accept.
 */
import { type BlobRef, text } from "../../src/content.ts"
import {
  type EventData,
  type NewEvent,
  type RetiredResult,
  type SessionSettings,
  type StepError,
  type StoredEvent,
  type ToolOutcome,
  event,
} from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import type { Json } from "../../src/json.ts"
import type { Projection } from "../../src/message/message.ts"
import { reduce } from "../../src/message/reducer.ts"
import { makeProviderError } from "../../src/provider/error.ts"
import { type BuildOptions, buildRequest } from "../../src/request/build.ts"
import { type BlockHash, hashRequest } from "../../src/request/prefix.ts"
import type { InputItem, ModelRequest, RequestParams } from "../../src/request/request.ts"
import type { ToolSpec } from "../../src/tool/tool.ts"

/** The prompt the scripted compactions freeze into `compaction.started`. */
export const COMPACTION_PROMPT = "Summarise the conversation so far."

export const MODEL = "gpt-test"

export const PARAMS: RequestParams = {
  model: MODEL,
  reasoningEffort: "medium",
  textVerbosity: null,
  parallelToolCalls: true,
  cacheKey: "ses_1",
}

/** The settings every scripted session is created with; with the defaults of `BuildOptions` they give `PARAMS`. */
export const SETTINGS: SessionSettings = { model: PARAMS.model, reasoningEffort: PARAMS.reasoningEffort }

export const OPTIONS: BuildOptions = { toolChoice: "auto" }

export const READ: ToolSpec = {
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}
export const SHELL: ToolSpec = {
  name: "shell",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}

export const BASELINE: EventData<"baseline.set"> = { instructions: "You are a coding agent.", tools: [READ, SHELL], sources: [] }

/** What the provider attached to a reasoning item. */
export const ENCRYPTED: Json = { id: "rs_1", encrypted_content: "gAAAA" }

const USAGE = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: 5 }

export type PartSpec =
  | { readonly text: string; readonly providerData?: Json | null }
  | { readonly reasoning: string; readonly providerData?: Json | null }
  | {
      readonly call: string
      readonly name?: string
      readonly input?: string
      /** Defaults to `success`. */
      readonly outcome?: ToolOutcome
      readonly output?: string
      readonly attachments?: readonly BlobRef[]
      /** Whether `tool.started` is written. Defaults to what the outcome needs; an `error` defaults to started. */
      readonly started?: boolean
      readonly providerData?: Json | null
    }

type CallSpec = Extract<PartSpec, { call: string }>

export type StepEnd =
  | "stop"
  | "tool_calls"
  | "length"
  /** `execution.interrupt_requested` by the user, then `step.failed` as interrupted. The marker must follow. */
  | "interrupted"
  /** `step.failed` with a retryable provider error. */
  | "provider_error"
  /** `step.failed` recorded by crash recovery. The marker must follow. */
  | "crashed"
  /** `step.refused`, excluding history from this `seq`. */
  | { readonly refusedFrom: number }

export interface StepSpec {
  readonly id?: string
  readonly parts?: readonly PartSpec[]
  readonly attempt?: number
  /** Defaults to `MODEL`. When it differs from the session's current model, `settings.changed` is written first. */
  readonly model?: string
  /** Retries scheduled before any output; they continue under the same message. */
  readonly retriesBeforeOutput?: number
  /** Defaults to `tool_calls` when the step has a call, otherwise `stop`. */
  readonly end?: StepEnd
  /** Runs while the step is open, for example to enqueue a steering message. */
  readonly during?: () => void
}

export class Script {
  state: Projection | null = null
  readonly events: StoredEvent[] = []
  private counter = 0

  constructor(readonly sessionId = "ses_1" as SessionId) {}

  /** Appends events, with `seq` assigned densely and `time` set to `seq * 10`. */
  apply(...events: NewEvent[]): Projection {
    for (const next of events) {
      const seq = (this.state?.lastSeq ?? 0) + 1
      const stored: StoredEvent = { ...next, sessionId: this.sessionId, seq, time: seq * 10 }
      this.state = reduce(this.state, stored)
      this.events.push(stored)
    }
    return this.projection
  }

  get projection(): Projection {
    if (this.state === null) throw new Error("the session has not been created")
    return this.state
  }

  get seq() {
    return this.projection.lastSeq
  }

  /** The first `seq` an exclusion range may start at. */
  get floor() {
    return (this.projection.session.compaction?.seq ?? 0) + 1
  }

  request(options: BuildOptions = OPTIONS): ModelRequest {
    return buildRequest(this.projection, options)
  }

  /**
   * The input of the next request, for comparing with what a test expects.
   * A part the provider gave nothing to replay for is sent with an item ID
   * the builder derives from the message (`stableItemId`); that ID is shown
   * here as `null`, which is how the tests write such a part. `request()`
   * has the real thing.
   */
  input(options: BuildOptions = OPTIONS): readonly InputItem[] {
    return this.request(options).input.map(withoutDerivedId)
  }

  hashes(options: BuildOptions = OPTIONS): BlockHash[] {
    return hashRequest(this.request(options))
  }

  private id(prefix: string) {
    this.counter += 1
    return `${prefix}_${this.counter}` as MessageId
  }

  /** `session.created` and the first `baseline.set`. */
  open(baseline: EventData<"baseline.set"> = BASELINE): this {
    this.apply(
      event("session.created", { cwd: "/repo", title: null, lineage: null, settings: SETTINGS }),
      event("baseline.set", baseline),
    )
    return this
  }

  /** The user picks another model or reasoning effort, at a step boundary. Does nothing when nothing changes. */
  settings(change: Partial<SessionSettings>) {
    const current = this.projection.session.settings
    const next = { ...current, ...change }
    if (next.model !== current.model || next.reasoningEffort !== current.reasoningEffort)
      this.apply(event("settings.changed", next))
  }

  /** Makes sure an execution holds the claim. */
  claim() {
    const execution = this.projection.session.execution
    if (execution === null) this.apply(event("execution.started", { executionId: `exe_${this.seq}` as ExecutionId }))
    else if (execution.status === "suspended") this.apply(event("execution.resumed", { executionId: execution.id }))
  }

  /** Ends the execution normally, if one is running. */
  release() {
    const execution = this.projection.session.execution
    if (execution !== null) this.apply(event("execution.succeeded", { executionId: execution.id, verification: { status: "not_configured" } }))
  }

  /** Records that an interrupt was asked for, unless one already was. From here the execution only winds down. */
  requestInterrupt(reason: "user" | "shutdown" = "user") {
    const execution = this.projection.session.execution
    if (execution === null) throw new Error("no execution to interrupt")
    if (execution.interrupting === null)
      this.apply(event("execution.interrupt_requested", { executionId: execution.id, reason }))
  }

  /**
   * Ends the execution as interrupted, requesting the interrupt first when
   * the script has not. After an interrupted step the marker (`harness`)
   * comes before this.
   */
  interruptExecution(reason: "user" | "shutdown" = "user") {
    this.requestInterrupt(reason)
    this.apply(event("execution.interrupted", { executionId: this.projection.session.execution!.id, reason }))
  }

  /** Ends the execution because it gave up. */
  failExecution() {
    const execution = this.projection.session.execution
    if (execution === null) throw new Error("no execution to fail")
    this.apply(event("execution.failed", { executionId: execution.id, message: "gave up" }))
  }

  /** Admits input without delivering it. Allowed while a step is open. */
  enqueue(value: string, origin: string | null = null, delivery: "steer" | "queue" = "steer"): MessageId {
    const messageId = this.id(origin === null ? "usr" : "syn")
    this.apply(event("inbox.enqueued", { messageId, origin, delivery, content: text(value) }))
    return messageId
  }

  /** Withdraws an admitted item before it is delivered. */
  cancel(messageId: MessageId) {
    this.apply(event("inbox.cancelled", { messageId }))
  }

  /** Delivers an admitted item at a step boundary. Returns the `seq` of the message. */
  deliver(messageId: MessageId): number {
    this.claim()
    this.apply(event("inbox.delivered", { messageId }))
    return this.seq
  }

  /** A user prompt, admitted and delivered. Returns the `seq` of the message. */
  user(value: string, delivery: "steer" | "queue" = "steer"): number {
    return this.deliver(this.enqueue(value, null, delivery))
  }

  /** A harness message that came through the inbox, such as a finished background command. */
  background(origin: string, value: string): number {
    return this.deliver(this.enqueue(value, origin))
  }

  /** A harness message appended directly, such as the interrupt marker. */
  harness(origin: string, value: string): number {
    this.claim()
    this.apply(event("synthetic.appended", { messageId: this.id("syn"), origin, content: text(value) }))
    return this.seq
  }

  /**
   * An instruction message. `value` is the fingerprint of what `text` gives
   * the model for `source` (`null` for a removal notice); by default the text
   * itself is fingerprinted, which is enough where only rendering matters.
   */
  instruction(source: string, value: string, fingerprint: string | null = fingerprintOf(value)): number {
    this.claim()
    this.apply(event("instruction.appended", { messageId: this.id("ins"), source, text: value, fingerprint }))
    return this.seq
  }

  /** One model call, from `step.started` to its terminal event. Calls start in order and settle in reverse order. */
  step(spec: StepSpec = {}): MessageId {
    this.claim()
    const messageId = (spec.id ?? this.id("ast")) as MessageId
    const parts = spec.parts ?? []
    // A step always calls the session's model, so a step on another model is preceded by the settings change.
    this.settings({ model: spec.model ?? MODEL })
    this.apply(event("step.started", { messageId, attempt: spec.attempt ?? 1, model: spec.model ?? MODEL }))
    for (let retry = 1; retry <= (spec.retriesBeforeOutput ?? 0); retry++) this.retry(messageId, (spec.attempt ?? 1) + retry)
    for (const part of parts) {
      if ("text" in part)
        this.apply(event("text.ended", { messageId, text: part.text, providerData: part.providerData ?? null }))
      else if ("reasoning" in part)
        this.apply(
          event("reasoning.ended", {
            messageId,
            text: part.reasoning,
            providerData: part.providerData === undefined ? ENCRYPTED : part.providerData,
          }),
        )
      else
        this.apply(
          event("tool.called", {
            messageId,
            callId: part.call as CallId,
            name: part.name ?? "read",
            input: part.input ?? '{"path":"a.ts"}',
            providerData: part.providerData ?? null,
          }),
        )
    }
    spec.during?.()
    const calls = parts.filter((part): part is CallSpec => "call" in part)
    const outcomeOf = (call: CallSpec) => call.outcome ?? "success"
    for (const call of calls) {
      // The effect class the loop would record. Only a call that started with a side effect can end `effect_unknown`.
      const effect = (call.name ?? "read") === "read" && outcomeOf(call) !== "effect_unknown" ? "read" : "exec"
      if (call.started ?? outcomeOf(call) !== "not_started")
        this.apply(event("tool.started", { messageId, callId: call.call as CallId, effect }))
    }
    // A cancel is durable before anything is stopped or settled, and nothing starts after it.
    if (spec.end === "interrupted") this.requestInterrupt("user")
    for (const call of calls.toReversed())
      this.apply(
        event("tool.settled", {
          messageId,
          callId: call.call as CallId,
          outcome: outcomeOf(call),
          output: call.output ?? `${outcomeOf(call)} ${call.call}`,
          truncation: null,
          attachments: [...(call.attachments ?? [])],
          display: null,
        }),
      )
    this.apply(terminal(messageId, spec.end ?? (calls.length > 0 ? "tool_calls" : "stop")))
    return messageId
  }

  /** `retry.scheduled` for a step, after a transport error. */
  retry(messageId: MessageId, attempt: number) {
    this.apply(
      event("retry.scheduled", { messageId, attempt, delayMs: 500, error: makeProviderError("transport", "socket closed") }),
    )
  }

  /**
   * A completed compaction. Returns the `seq` of the compaction message.
   * `retire` says, from the cut, which kept results lose their images (`compaction.ended.retired`).
   */
  compact(keep: (compactionSeq: number) => number, summary = "Summary so far.", retire?: (keepFromSeq: number) => readonly RetiredResult[]): number {
    this.claim()
    const messageId = this.id("cmp")
    // The cut is decided when the compaction starts; its own message gets the next seq.
    const seq = this.seq + 1
    const keepFromSeq = keep(seq)
    const retired = retire?.(keepFromSeq) ?? []
    this.apply(event("compaction.started", { messageId, trigger: "auto", mode: "normal", keepFromSeq, prompt: COMPACTION_PROMPT, tokensBefore: 0 }))
    this.apply(event("compaction.ended", { messageId, summary, source: "model", detail: null, tokensAfter: 0, usage: null, ...(retired.length === 0 ? {} : { retired: [...retired] }) }))
    return seq
  }

  baseline(data: EventData<"baseline.set">) {
    this.apply(event("baseline.set", data))
  }

  /** Rewinds an idle session. */
  revert(fromSeq: number) {
    this.apply(event("history.reverted", { fromSeq, restore: null }))
  }
}

function terminal(messageId: MessageId, end: StepEnd): NewEvent {
  if (typeof end === "object")
    return event("step.refused", { messageId, message: "I can't help with that.", excludeFromSeq: end.refusedFrom, usage: null })
  if (end === "stop" || end === "tool_calls" || end === "length")
    return event("step.ended", { messageId, finish: end, usage: USAGE })
  const errors: Record<"interrupted" | "provider_error" | "crashed", StepError> = {
    interrupted: { kind: "interrupted", reason: "user" },
    provider_error: { kind: "provider", error: makeProviderError("incomplete_stream", "the stream ended early") },
    crashed: { kind: "crashed" },
  }
  return event("step.failed", { messageId, error: errors[end], usage: null })
}

// ---- expected input items ----

export const user = (value: string): InputItem => ({ type: "message", role: "user", content: text(value) })
export const developer = (value: string): InputItem => ({ type: "message", role: "developer", content: text(value) })
export const harness = (origin: string, value: string): InputItem =>
  user(`<harness origin="${origin}">\n${value}\n</harness>`)
/** An assistant item as the tests expect it: a derived item ID (see `Script.input`) is `null`. */
export function withoutDerivedId(item: InputItem): InputItem {
  if (item.type !== "assistant_text" && item.type !== "tool_call") return item
  const data = item.providerData
  const id = data !== null && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1 ? (data as { readonly [key: string]: Json }).id : undefined
  const derived = typeof id === "string" && /^(msg|fc)_[0-9a-f]{48}$/.test(id)
  return derived ? { ...item, providerData: null } : item
}

export const said = (value: string, providerData: Json | null = null): InputItem => ({
  type: "assistant_text",
  text: value,
  providerData,
})
export const thought = (value: string, providerData: Json | null = ENCRYPTED): InputItem => ({
  type: "reasoning",
  text: value,
  providerData,
})
export const called = (
  callId: string,
  input = '{"path":"a.ts"}',
  name = "read",
  providerData: Json | null = null,
): InputItem => ({ type: "tool_call", callId, name, input, providerData })
export const result = (callId: string, output: string, attachments: readonly BlobRef[] = []): InputItem => ({
  type: "tool_result",
  callId,
  output,
  attachments,
})

/**
 * Asserts what the provider requires of a request, independently of how it
 * was built: every tool call has exactly one result after it, results follow
 * the calls of their own response, a reasoning item is followed by an output
 * item of the same response, and nothing is empty. Returns the problems found.
 */
export function providerProblems(request: ModelRequest): string[] {
  const problems: string[] = []
  const open = new Set<string>()
  request.input.forEach((item, index) => {
    const previous = request.input[index - 1]
    const next = request.input[index + 1]
    if (item.type !== "tool_result" && open.size > 0 && previous?.type === "tool_result")
      problems.push(`input[${index}]: ${[...open].join(", ")} still without a result when the next response starts`)
    if (item.type === "message") {
      if (open.size > 0) problems.push(`input[${index}]: a message arrives while ${[...open].join(", ")} has no result`)
      if (item.content.length === 0) problems.push(`input[${index}]: message without content`)
      if (item.content.some((part) => part.type === "text" && part.text.trim() === ""))
        problems.push(`input[${index}]: blank text part`)
    }
    if (item.type === "assistant_text" && item.text.trim() === "") problems.push(`input[${index}]: blank assistant text`)
    if (item.type === "reasoning" && !["reasoning", "assistant_text", "tool_call"].includes(next?.type ?? "end"))
      problems.push(`input[${index}]: reasoning is followed by ${next?.type ?? "the end of the request"}`)
    if (item.type === "tool_call") {
      if (open.has(item.callId)) problems.push(`input[${index}]: call ${item.callId} repeated before its result`)
      open.add(item.callId)
    }
    if (item.type === "tool_result" && !open.delete(item.callId))
      problems.push(`input[${index}]: result for ${item.callId} without a call before it`)
  })
  if (open.size > 0) problems.push(`calls without a result: ${[...open].join(", ")}`)
  const names = request.tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) problems.push("duplicate tool names")
  return problems
}
