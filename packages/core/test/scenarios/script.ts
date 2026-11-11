/**
 * The vocabulary step-loop scenarios are written in.
 *
 * A scenario is a script of the durable events the step loop must write for
 * one situation, split into phases ("the user cancels", "the process dies,
 * then at next start-up"), with what a UI and the model should see after each
 * phase. The test folds every scenario through the real reducer.
 *
 * Nothing here runs a loop. These are the target the loop is built against.
 */
import { text } from "../../src/content.ts"
import { type NewEvent, type StepError, type ToolOutcome, HARNESS_ORIGIN, event } from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import type { InterruptReason } from "../../src/interrupt.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import type { Exclusion, Message, Projection } from "../../src/message/message.ts"
import { type ReduceErrorCode, reduce } from "../../src/message/reducer.ts"
import { type ProviderError, type ProviderErrorKind, makeProviderError } from "../../src/provider/error.ts"
import type { ToolEffect } from "../../src/tool/tool.ts"

// ---------------------------------------------------------------- types

export interface Scenario {
  readonly title: string
  /** The situation, in plain words. */
  readonly description: string
  /** What the provider (and the tools, and the user) do to trigger it. */
  readonly provider: string
  readonly phases: readonly Phase[]
}

/** A run of events the loop writes without anything else happening in between. */
export interface Phase {
  readonly label: string
  readonly events: readonly NewEvent[]
  /** What must hold once this phase is folded. The last phase always has one. */
  readonly expect?: Expect
  /** Events the loop must not write at the end of this phase. The reducer rejects each with the given code. */
  readonly rejects?: readonly Rejection[]
}

export interface Rejection {
  readonly event: NewEvent
  readonly code: ReduceErrorCode
  readonly why: string
}

export interface Expect {
  /** Every message in log order, as a UI would list it (see `view`). Matched as a subset per message. */
  readonly ui?: readonly Partial<MessageView>[]
  /** IDs of the messages `selectModelHistory` returns, in request order. */
  readonly history?: readonly string[]
  /** The execution claim: `null` when released. */
  readonly execution?: null | {
    readonly status: "running" | "suspended"
    readonly crashResumes: number
    /** The reason of a requested interrupt that has not completed. Defaults to `null`. */
    readonly interrupting?: InterruptReason
  }
  /** The open step or compaction, by message ID, or `null` at a boundary. */
  readonly open?: string | null
  /** Inbox items still waiting, by message ID. */
  readonly inbox?: readonly string[]
}

/** A message reduced to what a UI shows. */
export interface MessageView {
  readonly id: string
  readonly kind: Message["kind"]
  /** For assistant, compaction and failed steps: their status. Otherwise `null`. */
  readonly status: string | null
  readonly attempt: number | null
  /** The text a UI renders: user and synthetic content, or the assistant's text parts joined with "|". */
  readonly text: string
  /** One entry per tool call: `"<callId> <name> <state>"`, where state is pending, running or the outcome. */
  readonly calls: readonly string[]
  /** For a failed step: the error, e.g. `"interrupted:user"`, `"provider:rate_limit"`, `"crashed"`. */
  readonly error: string | null
  readonly excluded: Exclusion | null
  /** For a synthetic message: its origin. */
  readonly origin: string | null
}

// ---------------------------------------------------------------- ids and tools

export const m = (id: string) => id as MessageId
export const c = (id: string) => id as CallId
export const x = (id: string) => id as ExecutionId
export const SESSION = "ses_scenario" as SessionId
export const MODEL = "gpt-test"

/** The tools every scenario's baseline offers, with the effect class the loop knows them by. */
export const TOOLS = {
  read: "read",
  shell: "exec",
  write: "write",
} as const satisfies Record<string, ToolEffect>
export type ToolName = keyof typeof TOOLS

/** The attempt budget of one logical step that the retry scenarios assume (1 attempt + 4 retries). */
export const ATTEMPT_BUDGET = 5
/** How many times recovery may take up the same execution again before giving up. */
export const RESUME_CAP = 3
/** Steps per turn before the loop makes one final call with tools forbidden. */
export const STEP_LIMIT = 3

export const usage = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10 }

// ---------------------------------------------------------------- session and inbox

export const created = () => event("session.created", { cwd: "/repo", title: null, lineage: null })
export const baseline = () =>
  event("baseline.set", {
    instructions: "You are a coding agent.",
    tools: Object.keys(TOOLS).map((name) => ({ name, description: `The ${name} tool`, inputSchema: { type: "object" } })),
    sources: [{ source: "date", fingerprint: fingerprintOf("Thursday, 2026-11-12") }],
  })
/** The user (origin `null`) or a harness component submits input. */
export const enqueue = (
  id: string,
  value: string,
  delivery: "steer" | "queue" = "steer",
  origin: string | null = null,
) => event("inbox.enqueued", { messageId: m(id), origin, delivery, content: text(value) })
export const deliver = (id: string) => event("inbox.delivered", { messageId: m(id) })
/** An instruction that changed after the baseline. The fingerprint identifies the value the text carries. */
export const instruction = (id: string, source: string, value: string) =>
  event("instruction.appended", { messageId: m(id), source, text: value, fingerprint: fingerprintOf(value) })
export const synthetic = (id: string, origin: string, value: string) =>
  event("synthetic.appended", { messageId: m(id), origin, content: text(value) })

/** The structural note that the previous response was cut short (cancel rule 6). */
export const interruptMarker = (id: string, why: InterruptReason | "crash") =>
  synthetic(
    id,
    HARNESS_ORIGIN.interrupt,
    why === "user"
      ? "The user stopped the previous response before it finished."
      : "The previous response was cut short when the harness restarted.",
  )

/** The note after a model call failed with partial text already durable, so the retry continues instead of starting over. */
export const continuationNote = (id: string) =>
  synthetic(
    id,
    HARNESS_ORIGIN.continuation,
    "Your previous response was cut off by a provider error. Continue exactly where it stopped; do not repeat what you already wrote.",
  )

// ---------------------------------------------------------------- execution

export const executionStarted = (id = "exe_1") => event("execution.started", { executionId: x(id) })
export const executionResumed = (id = "exe_1") => event("execution.resumed", { executionId: x(id) })
export const executionSucceeded = (id = "exe_1") => event("execution.succeeded", { executionId: x(id) })
export const executionFailed = (message: string, id = "exe_1") =>
  event("execution.failed", { executionId: x(id), message })
/** The cancel or the shutdown signal arrives: durable before anything is stopped. */
export const interruptRequested = (reason: InterruptReason, id = "exe_1") =>
  event("execution.interrupt_requested", { executionId: x(id), reason })
export const executionInterrupted = (reason: InterruptReason, id = "exe_1") =>
  event("execution.interrupted", { executionId: x(id), reason })

/**
 * The start of every single-turn scenario: the session exists, the user's
 * prompt `u1` was admitted, the claim was taken, the baseline frozen and the
 * prompt delivered. Seq 1..5; `u1` has seq 5.
 */
export const opening = (prompt = "Fix the failing test.") => [
  created(),
  enqueue("u1", prompt),
  executionStarted(),
  baseline(),
  deliver("u1"),
]

// ---------------------------------------------------------------- steps

export const stepStarted = (id: string, attempt = 1) => event("step.started", { messageId: m(id), attempt, model: MODEL })
export const stepEnded = (id: string, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage })
export const stepFailed = (id: string, error: StepError) => event("step.failed", { messageId: m(id), error, usage: null })
export const stepInterrupted = (id: string, reason: InterruptReason) =>
  stepFailed(id, { kind: "interrupted", reason })
export const stepCrashed = (id: string) => stepFailed(id, { kind: "crashed" })
export const stepProviderFailed = (id: string, error: ProviderError) => stepFailed(id, { kind: "provider", error })
export const stepRefused = (id: string, message: string, excludeFromSeq: number) =>
  event("step.refused", { messageId: m(id), message, excludeFromSeq, usage })
export const retryScheduled = (id: string, attempt: number, error: ProviderError, delayMs = 2000) =>
  event("retry.scheduled", { messageId: m(id), attempt, delayMs, error })

export const say = (id: string, value: string) => event("text.ended", { messageId: m(id), text: value, providerData: null })
export const think = (id: string, value: string) =>
  event("reasoning.ended", { messageId: m(id), text: value, providerData: { encrypted_content: "gAAAA" } })

// ---------------------------------------------------------------- tools

export const called = (id: string, callId: string, name: ToolName | (string & {}), input: string) =>
  event("tool.called", { messageId: m(id), callId: c(callId), name, input, providerData: null })
/** The tool begins. `name` picks the effect class the loop records with the start (see `TOOLS`). */
export const toolStarted = (id: string, callId: string, name: ToolName) =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect: TOOLS[name] })
/** The start of a call to a tool outside `TOOLS`, with the effect class its registry entry had when it ran. */
export const toolStartedAs = (id: string, callId: string, effect: ToolEffect) =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect })
export const settled = (id: string, callId: string, outcome: ToolOutcome, output: string) =>
  event("tool.settled", {
    messageId: m(id),
    callId: c(callId),
    outcome,
    output,
    truncation: null,
    attachments: [],
    display: null,
  })

/** A call that runs and succeeds: called, started, settled. */
export const ran = (id: string, callId: string, name: ToolName, input: string, output: string) => [
  called(id, callId, name, input),
  toolStarted(id, callId, name),
  settled(id, callId, "success", output),
]

/** The texts the loop freezes into `tool.settled` when it, rather than the tool, decides the outcome. */
export const NOT_STARTED = "Not run: the response was stopped before this call started. It is safe to call it again."
export const INTERRUPTED_READ = "Stopped before it finished. Nothing was changed; it is safe to call it again."
export const EFFECT_UNKNOWN =
  "Started, but stopped before it reported a result. It may or may not have taken effect: check the current state before repeating it."
export const CRASH_READ = "Cut short by a restart before it finished. Nothing was changed; it is safe to call it again."
export const CRASH_EFFECT_UNKNOWN =
  "Started, but the harness restarted before its result was recorded. It may or may not have taken effect: check the current state before repeating it."

// ---------------------------------------------------------------- provider errors

export const providerError = (kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number) =>
  makeProviderError(kind, message, { ...(status === undefined ? {} : { status }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
export const rateLimited = providerError("rate_limit", "Rate limit reached", 429, 3000)
export const serverError = providerError("provider_internal", "The server had an error", 500)
export const incompleteStream = providerError("incomplete_stream", "The stream ended without a terminal event")

// ---------------------------------------------------------------- folding and views

/** Folds a list of events onto `state`, assigning dense `seq` and `time = seq * 10`. */
export function fold(state: Projection | null, events: readonly NewEvent[]): Projection {
  let next = state
  for (const item of events) next = reduce(next, position(next, item))
  if (next === null) throw new Error("nothing was folded")
  return next
}

export function position(state: Projection | null, item: NewEvent) {
  const seq = (state?.lastSeq ?? 0) + 1
  return { ...item, sessionId: SESSION, seq, time: seq * 10 }
}

/** Every event of a scenario in order. */
export const allEvents = (scenario: Scenario) => scenario.phases.flatMap((phase) => phase.events)

/** What a UI shows for each message. */
export function view(projection: Projection): MessageView[] {
  return projection.messages.map((message) => {
    const common = { id: message.id as string, kind: message.kind, excluded: message.excluded }
    switch (message.kind) {
      case "user":
        return { ...common, status: null, attempt: null, text: contentText(message.content), calls: [], error: null, origin: null }
      case "synthetic":
        return {
          ...common,
          status: null,
          attempt: null,
          text: contentText(message.content),
          calls: [],
          error: null,
          origin: message.origin,
        }
      case "instruction":
        return { ...common, status: null, attempt: null, text: message.text, calls: [], error: null, origin: null }
      case "compaction":
        return {
          ...common,
          status: message.status,
          attempt: null,
          text: message.summary ?? "",
          calls: [],
          error: message.error === null ? null : errorText(message.error),
          origin: null,
        }
      case "assistant":
        return {
          ...common,
          status: message.status,
          attempt: message.attempt,
          text: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("|"),
          calls: message.parts.flatMap((part) =>
            part.type === "tool_call"
              ? [`${part.callId} ${part.name} ${part.state.status === "settled" ? part.state.outcome : part.state.status}`]
              : [],
          ),
          error: message.error === null ? null : errorText(message.error),
          origin: null,
        }
    }
  })
}

export const historyIds = (projection: Projection) => selectModelHistory(projection).messages.map((message) => message.id as string)

function contentText(content: readonly { type: string; text?: string }[]) {
  return content.map((part) => part.text ?? "[media]").join("")
}

function errorText(error: StepError) {
  switch (error.kind) {
    case "provider":
      return `provider:${error.error.kind}`
    case "interrupted":
      return `interrupted:${error.reason}`
    case "crashed":
      return "crashed"
    case "internal":
      return "internal"
  }
}

/** A one-line rendering of an event, for the scenario index. */
export function describeEvent(item: NewEvent): string {
  const d = item.data as Record<string, unknown>
  const quote = (value: unknown) => JSON.stringify(String(value).length > 60 ? `${String(value).slice(0, 57)}...` : value)
  switch (item.type) {
    case "session.created":
      return "session.created"
    case "baseline.set":
      return "baseline.set"
    case "inbox.enqueued":
      return `inbox.enqueued ${d.messageId} ${d.delivery}${d.origin === null ? "" : ` origin=${d.origin}`} ${quote(contentText(item.data.content))}`
    case "synthetic.appended":
      return `synthetic.appended ${d.messageId} origin=${d.origin} ${quote(contentText(item.data.content))}`
    case "instruction.appended":
      return `instruction.appended ${d.messageId} source=${d.source} ${quote(d.text)}`
    case "step.started":
      return `step.started ${d.messageId} attempt=${d.attempt}`
    case "step.ended":
      return `step.ended ${d.messageId} finish=${d.finish}`
    case "step.failed":
      return `step.failed ${d.messageId} ${errorText(item.data.error)}`
    case "step.refused":
      return `step.refused ${d.messageId} excludeFromSeq=${d.excludeFromSeq}`
    case "retry.scheduled":
      return `retry.scheduled ${d.messageId} attempt=${d.attempt} delayMs=${d.delayMs} after ${item.data.error.kind}`
    case "text.ended":
    case "reasoning.ended":
      return `${item.type} ${d.messageId} ${quote(d.text)}`
    case "tool.called":
      return `tool.called ${d.messageId}/${d.callId} ${d.name} ${d.input}`
    case "tool.started":
      return `tool.started ${d.messageId}/${d.callId} effect=${d.effect}`
    case "tool.settled":
      return `tool.settled ${d.messageId}/${d.callId} ${d.outcome} ${quote(d.output)}`
    case "execution.failed":
      return `execution.failed ${d.executionId} ${quote(d.message)}`
    case "execution.interrupt_requested":
    case "execution.interrupted":
      return `${item.type} ${d.executionId} ${d.reason}`
    default: {
      const id = d.executionId ?? d.messageId
      return id === undefined ? item.type : `${item.type} ${id}`
    }
  }
}
