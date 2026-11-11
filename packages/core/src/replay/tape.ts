/**
 * The recording reader: from a session's event log to a "tape", the ordered
 * list of what the model did in each step and what it was given between steps.
 *
 * A replay runs the real model again against a changed prompt or changed
 * harness code and answers each tool call that matches the recording from the
 * tape instead of running the tool. The tape therefore keeps, per call, the
 * exact terminal result as it was settled (outcome, output text byte for byte,
 * truncation, attachments, display), whatever that outcome was: calls that
 * never started and calls whose effect is unknown are on the tape too, because
 * the model saw their results and a faithful replay shows it the same text.
 *
 * Steps and faults
 * - A tape step is one model call that reached a terminal event. A retry
 *   before any output runs under the same message and is one tape step (with
 *   the latest `attempt`).
 * - A step whose response was complete (it ended normally, or a tool of it
 *   started, which only happens after the response finished) is always kept,
 *   however the step was closed afterwards (interrupted, crashed): the model
 *   fully decided it.
 * - A step whose response was cut short is kept only when the user cut it
 *   (`interrupted: user`). The user's decision is an input a replay reproduces.
 * - A step cut by a fault (provider error, crash, shutdown, harness error) is
 *   not something a replay can reproduce. It is moved to `skipped`, together
 *   with the harness message that only exists because of the fault (the
 *   continuation note, the restart marker). Its partial text is carried into
 *   the next step's `text`, so the recorded answer reads as the user saw it.
 *
 * Inputs
 * Every message that entered history between steps (a delivered user or
 * synthetic message, an instruction, a harness message) is an input with the
 * index of the step it precedes, so a replay can inject the same inputs at the
 * same points. Settings changes, baselines, compactions, reverts and
 * refusals are inputs too; the last three change history in a way a replay
 * cannot reproduce, and the replay stops when it reaches one.
 */
import type { Content } from "../content.ts"
import type { NewEvent, SessionSettings, StepError, ToolOutcome } from "../event/durable.ts"
import type { CallId, MessageId, SessionId } from "../id.ts"
import type { InterruptReason } from "../interrupt.ts"
import type { Json } from "../json.ts"
import type { FinishReason } from "../provider/provider.ts"
import type { Usage } from "../provider/usage.ts"
import type { Store } from "../store/store.ts"
import type { Settlement } from "../tool/runtime.ts"
import type { ToolEffect, ToolSpec } from "../tool/tool.ts"
import { argumentKey } from "./match.ts"

export interface Tape {
  readonly sessionId: SessionId | null
  /** The recorded session's working directory: the original workspace. */
  readonly cwd: string
  /** The settings the session was created with. */
  readonly settings: SessionSettings
  /** The first baseline (system prompt and tools), or `null` if the session never set one. */
  readonly baseline: { readonly instructions: string; readonly tools: readonly ToolSpec[] } | null
  /** The replayable steps, in log order. `index` is the position in this array. */
  readonly steps: readonly TapeStep[]
  /** Inputs in log order, each with the index of the step it precedes. */
  readonly inputs: readonly TapeInput[]
  /** Steps cut short by a fault, and the harness messages that followed only because of it. */
  readonly skipped: readonly SkippedAttempt[]
}

export interface TapeStep {
  readonly index: number
  readonly messageId: MessageId
  /** `seq` of `step.started`. */
  readonly seq: number
  readonly attempt: number
  readonly model: string
  /** Text items in order, joined without a separator. Partial text of a skipped attempt right before is prefixed. */
  readonly text: string
  readonly calls: readonly TapeCall[]
  /** `complete`: the model finished its response. `cut`: the user stopped it while it streamed. */
  readonly response: "complete" | "cut"
  readonly end: StepEnd
  readonly usage: Usage | null
}

export type StepEnd =
  | { readonly kind: "ended"; readonly finish: FinishReason }
  | { readonly kind: "interrupted"; readonly reason: InterruptReason }
  | { readonly kind: "crashed" }
  | { readonly kind: "provider"; readonly errorKind: string }
  | { readonly kind: "internal" }

export interface TapeCall {
  /** Position within the step, in the order the model made the calls. */
  readonly index: number
  readonly messageId: MessageId
  /** The provider's call ID. Not unique across steps. */
  readonly callId: CallId
  readonly name: string
  /** The argument text exactly as the model produced it. */
  readonly input: string
  /** `canonicalJson` of the parsed arguments, or `null` when they were not JSON. */
  readonly canonical: string | null
  readonly providerData: Json | null
  /** Set when the tool started, with the effect class recorded at that moment. */
  readonly started: { readonly effect: ToolEffect } | null
  /** The terminal result exactly as settled. */
  readonly settlement: Settlement<ToolOutcome>
}

export type TapeInput =
  | {
      readonly kind: "message"
      readonly beforeStep: number
      readonly seq: number
      readonly messageId: MessageId
      /** `user` when the user wrote it; otherwise the harness origin (`interrupt`, `step_limit`, a check name). */
      readonly from: "user" | "harness"
      readonly origin: string | null
      readonly content: Content
    }
  | {
      readonly kind: "instruction"
      readonly beforeStep: number
      readonly seq: number
      readonly messageId: MessageId
      readonly source: string
      readonly text: string
    }
  | { readonly kind: "settings"; readonly beforeStep: number; readonly seq: number; readonly settings: SessionSettings }
  | {
      readonly kind: "baseline"
      readonly beforeStep: number
      readonly seq: number
      readonly instructions: string
      readonly tools: readonly ToolSpec[]
    }
  /** History changed in a way a replay cannot reproduce from here. */
  | {
      readonly kind: "unsupported"
      readonly beforeStep: number
      readonly seq: number
      readonly what: "compaction" | "revert" | "refusal"
    }

export interface SkippedAttempt {
  readonly messageId: MessageId
  readonly seq: number
  readonly error: StepError
  readonly text: string
  /** Harness messages dropped with it. */
  readonly dropped: readonly MessageId[]
}

/** An event with or without its position; a `StoredEvent` is one. */
type LogEvent = NewEvent & { readonly seq?: number; readonly sessionId?: SessionId }

/** Reads a stored session's tape through the `Store` interface. For a fork this is the effective log. */
export function tapeFromStore(store: Store, sessionId: SessionId): Tape {
  return tapeFromEvents(store.readEvents(sessionId))
}

/**
 * Reads the tape from a session's events in log order. Events without a `seq`
 * are numbered from 1 in list order. Throws when the log is inconsistent (a
 * settlement for a call that was never recorded), which the store's reducer
 * makes impossible for a stored log.
 */
export function tapeFromEvents(events: readonly LogEvent[]): Tape {
  const first = events[0]
  if (first === undefined || first.type !== "session.created") throw new Error("a tape starts at session.created")
  const steps: TapeStep[] = []
  const inputs: TapeInput[] = []
  const skipped: SkippedAttempt[] = []
  const enqueued = new Map<string, { origin: string | null; content: Content }>()
  let baseline: Tape["baseline"] = null
  let open: OpenStep | null = null
  let carried: string[] = []
  // Set after a fault-cut step was skipped: the harness messages that answer the fault are dropped with it.
  let dropping: { attempt: SkippedAttempt; origins: readonly string[] } | null = null

  const close = (step: OpenStep, end: StepEnd | { kind: "fault"; error: StepError }, usage: Usage | null) => {
    const calls = step.calls.map((call, index): TapeCall => {
      if (call.settlement === null) throw new Error(`call ${call.messageId}/${call.callId} was never settled`)
      return { ...call, index, settlement: call.settlement }
    })
    const complete = end.kind === "ended" || calls.some((call) => call.started !== null)
    if (!complete && end.kind === "fault") {
      const attempt = { messageId: step.messageId, seq: step.seq, error: end.error, text: step.texts.join(""), dropped: [] }
      skipped.push(attempt)
      if (step.texts.length > 0) carried = [...carried, ...step.texts]
      dropping = { attempt, origins: FAULT_ORIGINS[end.error.kind] ?? [] }
      return
    }
    const finalEnd: StepEnd = end.kind === "fault" ? faultEnd(end.error) : end
    steps.push({
      index: steps.length,
      messageId: step.messageId,
      seq: step.seq,
      attempt: step.attempt,
      model: step.model,
      text: [...carried, ...step.texts].join(""),
      calls,
      response: complete ? "complete" : "cut",
      end: finalEnd,
      usage,
    })
    carried = []
  }

  const addInput = (input: TapeInput) => {
    if (dropping !== null && input.kind === "message" && input.origin !== null && dropping.origins.includes(input.origin)) {
      ;(dropping.attempt.dropped as MessageId[]).push(input.messageId)
      return
    }
    dropping = null
    inputs.push(input)
  }

  events.forEach((item, position) => {
    const seq = item.seq ?? position + 1
    const beforeStep = steps.length
    switch (item.type) {
      case "baseline.set":
        if (baseline === null) baseline = { instructions: item.data.instructions, tools: item.data.tools }
        addInput({ kind: "baseline", beforeStep, seq, instructions: item.data.instructions, tools: item.data.tools })
        return
      case "settings.changed":
        addInput({ kind: "settings", beforeStep, seq, settings: item.data })
        return
      case "inbox.enqueued":
        enqueued.set(item.data.messageId, { origin: item.data.origin, content: item.data.content })
        return
      case "inbox.delivered": {
        const waiting = enqueued.get(item.data.messageId)
        if (waiting === undefined) throw new Error(`inbox item ${item.data.messageId} was delivered but never enqueued`)
        addInput({
          kind: "message",
          beforeStep,
          seq,
          messageId: item.data.messageId,
          from: waiting.origin === null ? "user" : "harness",
          origin: waiting.origin,
          content: waiting.content,
        })
        return
      }
      case "synthetic.appended":
        addInput({
          kind: "message",
          beforeStep,
          seq,
          messageId: item.data.messageId,
          from: "harness",
          origin: item.data.origin,
          content: item.data.content,
        })
        return
      case "instruction.appended":
        addInput({ kind: "instruction", beforeStep, seq, messageId: item.data.messageId, source: item.data.source, text: item.data.text })
        return
      case "compaction.ended":
        addInput({ kind: "unsupported", beforeStep, seq, what: "compaction" })
        return
      case "history.reverted":
        addInput({ kind: "unsupported", beforeStep, seq, what: "revert" })
        return
      case "step.started":
        if (open !== null && open.messageId === item.data.messageId) return
        open = { messageId: item.data.messageId, seq, attempt: item.data.attempt, model: item.data.model, texts: [], calls: [] }
        return
      case "retry.scheduled":
        if (open !== null && open.messageId === item.data.messageId) open.attempt = item.data.attempt
        return
      case "text.ended":
        if (open !== null) open.texts.push(item.data.text)
        return
      case "tool.called":
        requireOpen(open, item).calls.push({
          messageId: item.data.messageId,
          callId: item.data.callId,
          name: item.data.name,
          input: item.data.input,
          canonical: argumentKey(item.data.input),
          providerData: item.data.providerData,
          started: null,
          settlement: null,
        })
        return
      case "tool.started":
        findCall(open, item.data).started = { effect: item.data.effect }
        return
      case "tool.settled":
        findCall(open, item.data).settlement = {
          outcome: item.data.outcome,
          output: item.data.output,
          truncation: item.data.truncation,
          attachments: item.data.attachments,
          display: item.data.display,
        }
        return
      case "step.ended":
        close(requireOpen(open, item), { kind: "ended", finish: item.data.finish }, item.data.usage)
        open = null
        return
      case "step.failed": {
        const error = item.data.error
        const kept = error.kind === "interrupted" && error.reason === "user"
        close(requireOpen(open, item), kept ? { kind: "interrupted", reason: "user" } : { kind: "fault", error }, item.data.usage)
        open = null
        return
      }
      case "step.refused":
        // The refused range leaves model history; a replay cannot reproduce a refusal.
        open = null
        addInput({ kind: "unsupported", beforeStep, seq, what: "refusal" })
        return
      default:
        // Session metadata, inbox bookkeeping, execution claims and compaction bounds change nothing a replay feeds the model.
        return
    }
  })

  return {
    sessionId: first.sessionId ?? null,
    cwd: first.data.cwd,
    settings: first.data.settings,
    baseline,
    steps,
    inputs,
    skipped,
  }
}

/** The harness messages that exist only because a step was cut by this kind of fault. */
const FAULT_ORIGINS: Partial<Record<StepError["kind"], readonly string[]>> = {
  provider: ["continuation"],
  crashed: ["interrupt"],
  interrupted: ["interrupt"],
}

interface OpenStep {
  readonly messageId: MessageId
  readonly seq: number
  attempt: number
  readonly model: string
  readonly texts: string[]
  readonly calls: {
    readonly messageId: MessageId
    readonly callId: CallId
    readonly name: string
    readonly input: string
    readonly canonical: string | null
    readonly providerData: Json | null
    started: { readonly effect: ToolEffect } | null
    settlement: Settlement<ToolOutcome> | null
  }[]
}

function faultEnd(error: StepError): StepEnd {
  switch (error.kind) {
    case "interrupted":
      return { kind: "interrupted", reason: error.reason }
    case "crashed":
      return { kind: "crashed" }
    case "provider":
      return { kind: "provider", errorKind: error.error.kind }
    case "internal":
      return { kind: "internal" }
  }
}

function requireOpen(open: OpenStep | null, item: LogEvent): OpenStep {
  if (open === null) throw new Error(`${item.type} outside a step`)
  return open
}

function findCall(open: OpenStep | null, data: { readonly messageId: MessageId; readonly callId: CallId }) {
  const call = open?.calls.find((candidate) => candidate.messageId === data.messageId && candidate.callId === data.callId)
  if (call === undefined) throw new Error(`call ${data.messageId}/${data.callId} was never recorded in the open step`)
  return call
}
