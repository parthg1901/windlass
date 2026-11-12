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
import type { ConfigFile } from "../../src/config/schema.ts"
import { text } from "../../src/content.ts"
import { buildCheckpoint } from "../../src/context/checkpoint.ts"
import { type SummaryProblem, describeProblem, summaryPrompt, summaryRepairPrompt } from "../../src/context/summary.ts"
import {
  type CompactionMode,
  type NewEvent,
  type RestoreRecord,
  type SnapshotPoint,
  type StepError,
  type ToolOutcome,
  type VerificationOutcome,
  HARNESS_ORIGIN,
  event,
} from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import type { InterruptReason } from "../../src/interrupt.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import type { Exclusion, Message, Projection } from "../../src/message/message.ts"
import { type ReduceErrorCode, reduce } from "../../src/message/reducer.ts"
import { type ProviderError, type ProviderErrorKind, makeProviderError } from "../../src/provider/error.ts"
import type { ToolEffect } from "../../src/tool/tool.ts"
import type { Acknowledgement } from "../../src/verify/acknowledge.ts"
import type { VerificationEvidence } from "../../src/verify/evidence.ts"
import { renderReport } from "../../src/verify/report.ts"
import type { CheckResult } from "../../src/verify/run.ts"
import type { CheckStatus } from "../../src/verify/status.ts"

// ---------------------------------------------------------------- types

export interface Scenario {
  readonly title: string
  /** The situation, in plain words. */
  readonly description: string
  /** What the provider (and the tools, and the user) do to trigger it. */
  readonly provider: string
  /**
   * What the session runs in, for the scenarios about the workspace and the
   * checks. Without it there are no snapshots and no configuration, and the
   * log holds none of their events.
   */
  readonly setup?: Setup
  /**
   * The context window the engine is told the model has, in tokens, for the
   * scenarios about compaction. Without it nobody knows the window, and
   * history is compacted only after the provider rejects a request.
   */
  readonly contextWindow?: number
  readonly phases: readonly Phase[]
}

export interface Setup {
  /** The files of the workspace when the session starts, by path. Snapshots are on. */
  readonly files: Readonly<Record<string, string>>
  /** The project's configuration file. Absent: no configuration. */
  readonly config?: ConfigFile
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
  /** What is open (see `openLabel`): a step or compaction by message ID, `checks:<run>`, `revert`, `undo`, or `null` at a boundary. */
  readonly open?: string | null
  /** Inbox items still waiting, by message ID. */
  readonly inbox?: readonly string[]
  /** How many reverts can still be undone. */
  readonly undoable?: number
  /** Whether the session is hidden from the default listing. */
  readonly archived?: boolean
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
/** What the provider measured for a call whose request had `inputTokens` tokens: what the compaction policy decides from. */
export const measured = (inputTokens: number) => ({ inputTokens, cachedInputTokens: inputTokens - 200, outputTokens: 50, reasoningTokens: 10 })

// ---------------------------------------------------------------- session and inbox

export const created = () =>
  event("session.created", { cwd: "/repo", title: null, lineage: null, settings: { model: MODEL, reasoningEffort: "medium" } })
/** The user picks another model or reasoning effort. Takes effect at the next step. */
export const settingsChanged = (model: string, reasoningEffort: string | null = "medium") =>
  event("settings.changed", { model, reasoningEffort })
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
/** The user takes back a prompt that was not delivered yet. It never becomes a message. */
export const withdrawn = (id: string) => event("inbox.cancelled", { messageId: m(id) })
/**
 * The turn in progress may end, with what the gate found, and a queued message is delivered next. Without
 * checks there is nothing to verify, which is the plain case.
 */
export const turnEnded = (verification: VerificationOutcome = { status: "not_configured" }) => event("turn.ended", { verification })
export const archived = () => event("session.archived", {})
export const unarchived = () => event("session.unarchived", {})
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
export const executionSucceeded = (id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification: { status: "not_configured" } })
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

export const stepStarted = (id: string, attempt = 1, model = MODEL) => event("step.started", { messageId: m(id), attempt, model })
export const stepEnded = (id: string, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage })
/** A step ends whose request the provider measured at `inputTokens` tokens. */
export const stepEndedAt = (id: string, inputTokens: number, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage: measured(inputTokens) })
export const stepFailed = (id: string, error: StepError) => event("step.failed", { messageId: m(id), error, usage: null })
/**
 * The open step is closed as interrupted. `during` says where it was cut: in the model call (`"call"`, the
 * default), whose usage the provider had not reported yet, or while its tools ran (`"tools"`), after the call
 * itself had finished and reported what it cost.
 */
export const stepInterrupted = (id: string, reason: InterruptReason, during: "call" | "tools" = "call") =>
  event("step.failed", { messageId: m(id), error: { kind: "interrupted", reason }, usage: during === "tools" ? usage : null })
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

// ---------------------------------------------------------------- compaction

/** The context window of the compaction scenarios: 10,000 tokens, of which 2,000 are kept free for the answer. */
export const WINDOW = 10_000
/** The prompt a summary request appends, as the loop freezes it into `compaction.started`. */
export const SUMMARY_PROMPT = summaryPrompt()

/** A summary of the required form. */
export const SUMMARY = [
  "## Goal",
  "- Find out why the test fails and fix it.",
  "## Instructions and constraints",
  "- None.",
  "## Decisions",
  "- None.",
  "## Work completed",
  "- Read the files involved.",
  "## In progress",
  "- Looking for the wrong expectation.",
  "Next step: fix the expectation in a.test.ts.",
  "## Files",
  "- a.test.ts: read.",
  "## Commands",
  "- None.",
  "## Open questions",
  "- None.",
  "## Verbatim",
  "- None.",
].join("\n")
/** An answer that is not a summary of the required form: prose, with none of the sections. */
export const NOT_A_SUMMARY = "The user asked for a fix and some files were read."
/** What is wrong with `NOT_A_SUMMARY`, as the validator lists it. */
export const NOT_A_SUMMARY_PROBLEMS: readonly SummaryProblem[] = [
  "Goal",
  "Instructions and constraints",
  "Decisions",
  "Work completed",
  "In progress",
  "Files",
  "Commands",
  "Open questions",
  "Verbatim",
].map((heading) => ({ kind: "missing_section", heading }))

/**
 * A compaction begins. `keepFromSeq` is the cut: the first `seq` kept word
 * for word (the compaction's own `seq` when nothing is kept). `tokensBefore`
 * is a stand-in: the loop records its size estimate of the next request.
 */
export const compactionStarted = (id: string, keepFromSeq: number, trigger: "auto" | "overflow" = "auto", mode: CompactionMode = "normal") =>
  event("compaction.started", { messageId: m(id), trigger, mode, keepFromSeq, prompt: SUMMARY_PROMPT, tokensBefore: 0 })
/** The first answer was not usable: the loop records it and what it asks the model to fix. */
export const compactionRepair = (id: string, answer: string, problems: readonly SummaryProblem[], attempt = 2) =>
  event("compaction.repair_requested", { messageId: m(id), attempt, answer, prompt: summaryRepairPrompt(problems) })
/**
 * The checkpoint a compaction freezes: the summary (or, with `null`, the
 * statement that there is none), the identifier index and the user's
 * messages verbatim, exactly as `buildCheckpoint` renders them from the
 * messages before the cut. `before` is every event of the scenario up to the
 * compaction. `inProgress`: the cut left the turn's request out of the kept tail.
 */
export function checkpoint(before: readonly NewEvent[], keepFromSeq: number, summary: string | null = SUMMARY, inProgress = false): string {
  const earlier = fold(null, before).messages.filter((message) => message.excluded === null && message.seq < keepFromSeq)
  return buildCheckpoint({ summary, earlier, inProgress }).text
}
/** The compaction completes with its checkpoint. `tokensAfter` is a stand-in: the loop records its estimate of the next request. */
export const compactionEnded = (id: string, checkpointText: string, source: "model" | "repaired" | "fallback" = "model", detail: string | null = null) =>
  event("compaction.ended", { messageId: m(id), summary: checkpointText, source, detail, tokensAfter: 0, usage: null })
export const compactionFailed = (id: string, error: StepError) => event("compaction.failed", { messageId: m(id), error })
/** Why a compaction completed without a summary when both answers were unusable: `compaction.ended.detail`. */
export const UNUSABLE = (problems: readonly SummaryProblem[]) =>
  `the model's summary was unusable, also after it was asked to fix it: ${problems.slice(0, 2).map(describeProblem).join("; ")}${problems.length > 2 ? `; and ${problems.length - 2} more` : ""}`

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

/** What is open, as a scenario names it: the message ID of a step or compaction, `checks:<run>`, `revert` or `undo`; `null` at a boundary. */
export function openLabel(projection: Projection): string | null {
  const open = projection.session.open
  if (open === null) return null
  if (open.kind === "step" || open.kind === "compaction") return open.messageId
  return open.kind === "checks" ? `checks:${open.run}` : open.kind
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
      return `step.started ${d.messageId} attempt=${d.attempt}${d.model === MODEL ? "" : ` model=${d.model}`}`
    case "settings.changed":
      return `settings.changed model=${d.model} reasoningEffort=${d.reasoningEffort}`
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
    case "execution.succeeded": {
      const outcome = item.data.verification
      // Nothing verified is the plain case and is not spelled out with every scenario.
      if (outcome.status === "not_configured") return `execution.succeeded ${d.executionId}`
      const detail = outcome.status === "unresolved" ? ` ${outcome.reason} failing=${outcome.failing.join(",")}` : ""
      return `execution.succeeded ${d.executionId} verification=${outcome.status}${detail}`
    }
    case "turn.ended": {
      const outcome = item.data.verification
      if (outcome.status === "not_configured") return "turn.ended"
      const detail = outcome.status === "unresolved" ? ` ${outcome.reason} failing=${outcome.failing.join(",")}` : ""
      return `turn.ended verification=${outcome.status}${detail}`
    }
    case "snapshot.taken":
      return `snapshot.taken ${d.id} ${d.point}${d.messageId === null ? "" : ` ${d.messageId}`}`
    case "snapshot.unavailable":
      return `snapshot.unavailable ${d.reason}`
    case "checks.started":
      return `checks.started run=${d.run} ${item.data.checks.join(",")}`
    case "checks.finished":
      return `checks.finished run=${d.run} ${item.data.evidence.checks.map((check) => `${check.name}:${check.status}`).join(",")}`
    case "checks.failed":
      return `checks.failed run=${d.run} ${errorText(item.data.error)}`
    case "revert.started":
      return `revert.started fromSeq=${d.fromSeq} target=${d.target} before=${d.before}`
    case "revert.undo_started":
      return `revert.undo_started revertSeq=${d.revertSeq} target=${d.target} before=${d.before}`
    case "history.reverted":
    case "history.restored": {
      const record = item.data.restore
      const range = item.type === "history.reverted" ? `fromSeq=${item.data.fromSeq}` : `revertSeq=${item.data.revertSeq}`
      return `${item.type} ${range} ${record === null ? "no files restored" : `restored=${record.target} changed=${record.changed}`}`
    }
    case "execution.interrupt_requested":
    case "execution.interrupted":
      return `${item.type} ${d.executionId} ${d.reason}`
    case "compaction.started":
      return `compaction.started ${d.messageId} ${d.trigger} ${d.mode} keepFromSeq=${d.keepFromSeq}`
    case "compaction.repair_requested":
      return `compaction.repair_requested ${d.messageId} attempt=${d.attempt} ${quote(d.answer)}`
    case "compaction.ended":
      return `compaction.ended ${d.messageId} source=${d.source}${d.detail === null ? "" : ` (${String(d.detail).length > 70 ? `${String(d.detail).slice(0, 67)}...` : d.detail})`}`
    case "compaction.failed":
      return `compaction.failed ${d.messageId} ${errorText(item.data.error)}`
    default: {
      const id = d.executionId ?? d.messageId
      return id === undefined ? item.type : `${item.type} ${id}`
    }
  }
}

// ---------------------------------------------------------------- the workspace, checks and reverts

/**
 * The workspace was recorded. `id` is a name for its contents (`w0` for the
 * files the session started with, `w1` after the first change): a real ID is
 * the hash of the tree, and the same contents always have the same one.
 */
export const snap = (point: SnapshotPoint, id: string, step: string | null = null) =>
  event("snapshot.taken", { id, point, messageId: step === null ? null : m(step) })

/** `opening()` for a session with snapshots: the workspace is recorded as `w0` before the prompt is delivered. Seq 1..6; `u1` has seq 6. */
export const openingIn = (prompt = "Fix the failing test.", workspace = "w0") => [
  created(),
  enqueue("u1", prompt),
  executionStarted(),
  snap("delivery", workspace),
  baseline(),
  deliver("u1"),
]

/** A step whose one call changes a file: the workspace is recorded right before the tool runs and right after. */
export const wrote = (id: string, input: string, output: string, from: string, to: string) => [
  stepStarted(id),
  called(id, "call_1", "write", input),
  snap("step_start", from, id),
  toolStarted(id, "call_1", "write"),
  settled(id, "call_1", "success", output),
  snap("step_end", to, id),
  stepEnded(id, "tool_calls"),
]

/** The one check the verification scenarios configure. */
export const CHECK = { name: "test", command: "bun test", timeoutSeconds: 120 } as const
/** Their configuration file. */
export const CHECKS_CONFIG: ConfigFile = { checks: [{ name: CHECK.name, command: CHECK.command }] }
/** What the failing check prints. */
export const CHECK_OUTPUT = "1 fail\n"

/** The result of the check as the runner shapes it. */
export function checkResult(status: CheckStatus, check: { readonly name: string; readonly command: string; readonly timeoutSeconds: number } = CHECK): CheckResult {
  const bytes = new TextEncoder().encode(status === "passed" || status === "interrupted" ? "" : CHECK_OUTPUT)
  const lines = bytes.length === 0 ? 0 : 1
  return {
    name: check.name,
    command: check.command,
    timeoutSeconds: check.timeoutSeconds,
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    signal: null,
    interruptedBy: null,
    startError: null,
    durationMs: 0,
    output: { totalBytes: bytes.length, totalLines: lines, path: null, savedBytes: bytes.length, source: { head: bytes, tail: bytes, tailAtLineStart: true, totalBytes: bytes.length, totalLines: lines } },
  }
}

/**
 * The record of one run of the check. `afterSeq`, `fingerprint`, `durationMs`
 * and `outputPath` are stand-ins (the loop fills in the position of
 * `checks.started`, a hash of the changed files' state, the time taken and
 * the file that keeps the output).
 */
export function evidence(run: number, status: CheckStatus, changedFiles: readonly string[]): VerificationEvidence {
  const result = checkResult(status)
  return {
    run,
    afterSeq: 0,
    changedFiles: [...changedFiles],
    checks: [
      {
        name: result.name,
        command: result.command,
        status,
        exitCode: result.exitCode,
        signal: null,
        durationMs: 0,
        files: [...changedFiles],
        fingerprint: "fingerprint",
        reusedFromSeq: null,
        outputPath: null,
        outputBytes: result.output.totalBytes,
        outputLines: result.output.totalLines,
      },
    ],
  }
}

export const checksStarted = (run: number) => event("checks.started", { run, checks: [CHECK.name] })
export const checksFinished = (run: number, status: CheckStatus, changedFiles: readonly string[]) =>
  event("checks.finished", { run, evidence: evidence(run, status, changedFiles) })
export const checksFailed = (run: number, error: StepError) => event("checks.failed", { run, error })
/** The report of a failing run, exactly as the model is shown it. */
export const checkReport = (id: string) => synthetic(id, HARNESS_ORIGIN.checkReport, renderReport([checkResult("failed")]))

/** The execution ends as done, with what the gate found. */
export const succeededWith = (verification: VerificationOutcome, id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification })
export const passed = (run: number, changedFiles: readonly string[]): VerificationOutcome => ({ status: "passed", evidence: evidence(run, "passed", changedFiles) })
export const unresolved = (
  reason: "acknowledged" | "max_rounds" | "report_mode",
  run: number,
  changedFiles: readonly string[],
  acknowledgement: Acknowledgement | null = null,
): VerificationOutcome => ({ status: "unresolved", reason, failing: [CHECK.name], acknowledgement, evidence: evidence(run, "failed", changedFiles) })

/** What a restore did: from `before` to `target`, `changed` files written or removed, nothing kept. */
export const restore = (target: string, before: string, changed: number): RestoreRecord => ({ target, before, after: target, changed, kept: [], keptOmitted: 0 })
export const revertStarted = (fromSeq: number, target: string, before: string) => event("revert.started", { fromSeq, target, before, keep: [] })
export const historyReverted = (fromSeq: number, record: RestoreRecord | null) => event("history.reverted", { fromSeq, restore: record })
export const undoStarted = (revertSeq: number, target: string, before: string) => event("revert.undo_started", { revertSeq, target, before, keep: [] })
export const historyRestored = (revertSeq: number, record: RestoreRecord | null) => event("history.restored", { revertSeq, restore: record })
