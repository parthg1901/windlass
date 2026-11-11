/**
 * The step loop: takes a prompt, calls the model, runs tools, and handles
 * cancel, retries and crash recovery. `docs/step-loop-scenarios.md` is its
 * specification, and the reducer rejects every sequence it must not write.
 *
 * SINGLE-OWNER FILE. It owns the order of durable writes around a model call
 * and its tools.
 *
 * How it is built:
 *
 * - One step is one model call. Before every step the loop re-reads the
 *   projection and decides what to do from stored state alone (`state.ts`).
 *   Nothing about the conversation lives in memory, so a process that
 *   restarts decides what the one before it would have decided.
 * - Events that are decided together are appended together, in one
 *   transaction: a failed step with its retry and the note that asks the
 *   model to continue; an interrupted step with its marker and the release.
 *   A crash can therefore never fall between two halves of one decision.
 * - A side effect follows its durable record, never the other way round:
 *   `tool.called` is appended when the call finishes streaming, `tool.started`
 *   inside the runtime's `onStart`, synchronously, right before the tool runs.
 * - An interrupt is appended (`execution.interrupt_requested`) before
 *   anything is aborted. From then on the loop only winds down.
 * - Every await is followed by a check of the abort signal before anything
 *   that carries the work on is appended.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { brand } from "../brand.ts"
import { text } from "../content.ts"
import { type NewEvent, type SessionSettings, type StoredEvent, HARNESS_ORIGIN, event } from "../event/durable.ts"
import type { EphemeralEvent } from "../event/ephemeral.ts"
import { type CallId, type ExecutionId, type MessageId, type RequestId, type SessionId, newId } from "../id.ts"
import { type DiscoveryInput, discoverSources } from "../instructions/discover.ts"
import type { InstructionSource } from "../instructions/source.ts"
import { instructionState, knownAgentsFiles, prepareInstructions } from "../instructions/state.ts"
import { type Interrupt, type InterruptReason, createInterrupt, interruptReasonOf } from "../interrupt.ts"
import { selectModelHistory } from "../message/history.ts"
import type { AssistantMessage, CompactionMessage, Projection, ToolCallPart } from "../message/message.ts"
import { type ProviderError, makeProviderError } from "../provider/error.ts"
import type { FinishReason, Provider, StreamEvent } from "../provider/provider.ts"
import type { Usage } from "../provider/usage.ts"
import { type PrefixVerdict, checkPrefix } from "../request/build-break.ts"
import { type CallOptions, buildCompactionRequest, buildRequest } from "../request/build.ts"
import { type BlockHash, hashRequest } from "../request/prefix.ts"
import type { ModelRequest } from "../request/request.ts"
import type { AppendOptions, RequestPurpose, SessionSummary, Store } from "../store/store.ts"
import { type ToolCallOutcome, type ToolRuntime, createToolRuntime } from "../tool/runtime.ts"
import type { AnyTool, ToolEffect } from "../tool/tool.ts"
import { type EngineEvent, EventChannel } from "./channel.ts"
import { type Clock, systemClock } from "./clock.ts"
import {
  COMPACTION_PROMPT,
  ENGINE_LIMITS,
  type EngineLimits,
  FAILURE_TEXT,
  INCOMPLETE_STREAM,
  NOTE_TEXT,
  TOOL_TEXT,
  failureText,
  retryDelayMs,
} from "./constants.ts"
import { recover } from "./recovery.ts"
import {
  STOPPED,
  claimOf,
  latestSpoken,
  note,
  notedThisTurn,
  openStep,
  owesMarker,
  refusedTurnStart,
  repeatsItself,
  settleUnsettled,
  stepsThisTurn,
  turnInput,
  wouldGoIdle,
} from "./state.ts"

// ---------------------------------------------------------------- options

/** Generators for the IDs the loop creates. Tests inject counters. */
export interface EngineIds {
  readonly session: () => SessionId
  readonly message: () => MessageId
  readonly execution: () => ExecutionId
  readonly request: () => RequestId
}

/**
 * Named moments in the loop at which an injected `probe` is called,
 * synchronously. A crash test kills the process inside one; a scenario test
 * acts on the session at exactly that moment. Production passes no probe.
 */
export type ProbePoint =
  /** The claim was taken or resumed; nothing else happened yet. */
  | "execution.claimed"
  /** Between steps, before the loop decides what to do next. */
  | "step.boundary"
  /** `step.started` is durable; the request has not been sent. */
  | "step.started"
  /** One piece of model output (`text.ended`, `reasoning.ended`, `tool.called`) is durable. */
  | "model.output"
  /** `tool.started` is durable; the tool is about to run. */
  | "tool.started"
  /** A tool returned; its result is not yet written. */
  | "tool.finished"
  /** `tool.settled` is durable. */
  | "tool.settled"
  /** The step's terminal event is durable. */
  | "step.closed"
  /** `retry.scheduled` is durable; the wait has not begun. */
  | "retry.scheduled"
  /** `execution.interrupt_requested` is durable; nothing was stopped yet. */
  | "interrupt.requested"
  /** The loop found nothing left to do; the claim is not yet released. */
  | "execution.ending"

export interface EngineHooks {
  readonly probe?: (point: ProbePoint, sessionId: SessionId) => void
}

/** Something the engine noticed that is not part of any session's log. Shown or logged, never stored. */
export interface Diagnostic {
  readonly kind: "prefix_violation" | "internal_error" | "tool_crashed" | "listener_failed"
  readonly sessionId: SessionId | null
  readonly message: string
  readonly cause?: unknown
}

/** A step request did not extend the previous one and no event explains it: a bug in the harness. */
export class PrefixViolationError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly verdict: Extract<PrefixVerdict, { status: "violation" }>,
  ) {
    const { index, kind, change } = verdict.comparison
    super(`session ${sessionId}: the next request does not extend the previous one (${kind} block ${index} ${change}) and no event allows that`)
    this.name = "PrefixViolationError"
  }
}

export class EngineError extends Error {
  constructor(
    readonly code: "session_not_found" | "closed",
    message: string,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

export interface EngineOptions {
  readonly store: Store
  readonly provider: Provider
  /** Every tool of every session. Their specs are frozen into each session's baseline. */
  readonly tools: readonly AnyTool[]
  /** The harness data directory. Tool output that is too long for the model is written under it. */
  readonly dataDir: string
  /** Where capped tool output goes. Defaults to `<dataDir>/spill`. */
  readonly spillDir?: string
  /** Defaults to the system clock. */
  readonly clock?: Clock
  /** Defaults to random IDs (`newId`). */
  readonly ids?: Partial<EngineIds>
  /** The source of retry jitter, in [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number
  readonly limits?: Partial<EngineLimits>
  /** The base system prompt. Defaults to the harness's own. */
  readonly prompt?: string
  /**
   * Reads the instruction sources as they are now. Defaults to
   * `discoverSources` with the harness config directory (named from `brand`),
   * this platform and the engine's clock.
   */
  readonly discover?: (input: Pick<DiscoveryInput, "cwd" | "known">) => InstructionSource[]
  /** Call settings that are the same for every request of this build. */
  readonly call?: CallOptions
  /**
   * Called once when a model call is rejected for its credentials, before the
   * step fails: refresh the sign-in and resolve `true` if the call is worth
   * sending again.
   */
  readonly refreshAuth?: () => Promise<boolean>
  readonly hooks?: EngineHooks
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void
  /** One line per diagnostic. Defaults to standard error. */
  readonly log?: (line: string) => void
  /**
   * Throw `PrefixViolationError` when a request breaks the cached prefix with
   * no event that allows it. Tests set this; a user's session reports the
   * violation and carries on.
   */
  readonly strict?: boolean
}

/** What happens to a held claim when its session is opened. Recovery of a crashed claim always runs. */
export type ResumeMode =
  /** Resume the claim and start working at once. The default. */
  | "start"
  /** Resume the claim (`execution.resumed`) but do no work until `start()` or `send()`. */
  | "claim"
  /** Leave a suspended claim suspended until `start()` or `send()`. */
  | "wait"

export interface SendOptions {
  /** `steer` (the default) is delivered at the next step boundary; `queue` once the session would otherwise go idle. */
  readonly delivery?: "steer" | "queue"
  /** The step limit of the turn this input starts, instead of the engine's. */
  readonly maxSteps?: number
}

export interface EngineSession {
  readonly id: SessionId
  /**
   * Every event of this session from the moment it was created or opened, in
   * order: durable events as they are appended (recovery's first), ephemeral
   * deltas as they arrive. One consumer. It ends after `close`. A consumer
   * that falls behind never slows the loop down; see `channel.ts`.
   */
  readonly events: AsyncIterable<EngineEvent>
  /** A further consumer, called synchronously with each event from now on. Returns the unsubscribe function. */
  readonly subscribe: (listener: (event: EngineEvent) => void) => () => void
  /**
   * Admits a prompt into the inbox. If nothing is running an execution
   * starts (or a suspended one resumes); otherwise the prompt is delivered
   * at the next step boundary. Returns the ID the message will have.
   */
  readonly send: (value: string, options?: SendOptions) => MessageId
  /** `send` with `delivery: "queue"`: delivered only once the turn in progress has its answer. */
  readonly queue: (value: string, options?: Omit<SendOptions, "delivery">) => MessageId
  /**
   * Starts working if there is something to do and nothing is running: takes
   * the claim when input waits, or takes up a claim that is suspended or was
   * recovered without being started.
   */
  readonly start: () => void
  /** Asks the running execution to stop, as the user. The request is durable before anything stops. A no-op when idle. */
  readonly interrupt: () => void
  /** Changes the model or the reasoning effort. Takes effect at the next step boundary. */
  readonly setSettings: (settings: SessionSettings) => void
  /** The session's stored state. */
  readonly projection: () => Projection
  /** Whether an execution is being worked on in this process. */
  readonly working: boolean
  /** Resolves once no execution is being worked on in this process. */
  readonly settled: () => Promise<void>
  /**
   * A graceful shutdown of this session: work in progress is stopped as a
   * `shutdown`, which leaves the execution suspended and resumable, and
   * `events` ends. Safe to call more than once.
   */
  readonly close: () => Promise<void>
}

export interface Engine {
  /** Creates a session. Its baseline is frozen when its first execution starts. */
  readonly createSession: (input: { readonly cwd: string; readonly settings: SessionSettings; readonly title?: string | null }) => EngineSession
  /**
   * Opens an existing session. If it holds a claim from a process that died
   * or shut down, it is recovered here, and what happens next is `resume`.
   */
  readonly openSession: (id: SessionId, options?: { readonly resume?: ResumeMode }) => EngineSession
  /** The most recently updated session whose working directory is `cwd`. */
  readonly latestSession: (cwd: string) => SessionSummary | null
  /**
   * The hook a process calls before it exits, for whatever reason it controls
   * (a normal end, SIGINT, SIGTERM, an uncaught error): every session is
   * closed as a shutdown, which stops every tool and waits for it. Safe to
   * call more than once; every call resolves when the shutdown is complete.
   * It does not close the store, which belongs to whoever opened it.
   */
  readonly close: () => Promise<void>
}

// ---------------------------------------------------------------- engine

interface Core {
  readonly store: Store
  readonly provider: Provider
  readonly runtime: ToolRuntime
  readonly effects: ReadonlyMap<string, ToolEffect>
  readonly tools: readonly AnyTool[]
  readonly clock: Clock
  readonly ids: EngineIds
  readonly random: () => number
  readonly limits: EngineLimits
  readonly prompt: string | undefined
  readonly discover: (input: Pick<DiscoveryInput, "cwd" | "known">) => InstructionSource[]
  readonly call: CallOptions
  readonly refreshAuth: (() => Promise<boolean>) | undefined
  readonly probe: ((point: ProbePoint, sessionId: SessionId) => void) | undefined
  readonly strict: boolean
  readonly report: (diagnostic: Diagnostic) => void
  readonly sessions: Map<SessionId, LiveSession>
}

export function createEngine(options: EngineOptions): Engine {
  const clock = options.clock ?? systemClock
  const log = options.log ?? ((line: string) => console.error(line))
  const core: Core = {
    store: options.store,
    provider: options.provider,
    runtime: createToolRuntime({
      tools: options.tools,
      spillDir: options.spillDir ?? join(options.dataDir, "spill"),
      putBlob: options.store.putBlob,
    }),
    effects: new Map(options.tools.map((tool) => [tool.name, tool.effect])),
    tools: options.tools,
    clock,
    ids: {
      session: options.ids?.session ?? (() => newId("session")),
      message: options.ids?.message ?? (() => newId("message")),
      execution: options.ids?.execution ?? (() => newId("execution")),
      request: options.ids?.request ?? (() => newId("request")),
    },
    random: options.random ?? Math.random,
    limits: { ...ENGINE_LIMITS, ...options.limits },
    prompt: options.prompt,
    discover:
      options.discover ??
      ((input) => discoverSources({ ...input, configDir: configDirectory(), platform: process.platform, now: () => new Date(clock.now()) })),
    call: options.call ?? {},
    refreshAuth: options.refreshAuth,
    probe: options.hooks?.probe,
    strict: options.strict ?? false,
    report: (diagnostic) => {
      log(`[engine] ${diagnostic.kind}${diagnostic.sessionId === null ? "" : ` in ${diagnostic.sessionId}`}: ${diagnostic.message}`)
      options.onDiagnostic?.(diagnostic)
    },
    sessions: new Map(),
  }
  let closing: Promise<void> | null = null

  return {
    createSession: (input) => {
      if (closing !== null) throw new EngineError("closed", "the engine is closed")
      const id = core.ids.session()
      const session = new LiveSession(core, id)
      core.sessions.set(id, session)
      session.write([event("session.created", { cwd: input.cwd, title: input.title ?? null, lineage: null, settings: input.settings })])
      return session
    },
    openSession: (id, open = {}) => {
      if (closing !== null) throw new EngineError("closed", "the engine is closed")
      const live = core.sessions.get(id)
      if (live !== undefined) return live
      if (core.store.getSession(id) === null) throw new EngineError("session_not_found", `session ${id} does not exist`)
      const session = new LiveSession(core, id)
      core.sessions.set(id, session)
      session.recover(open.resume ?? "start")
      return session
    },
    latestSession: (cwd) => core.store.listSessions().find((summary) => summary.session.cwd === cwd) ?? null,
    close: () => {
      closing ??= Promise.all([...core.sessions.values()].map((session) => session.close())).then(() => {})
      return closing
    },
  }
}

// ---------------------------------------------------------------- one session

/** One execution being worked on in this process: its claim and its abort token (cancel rule 2). */
interface Run {
  readonly executionId: ExecutionId
  readonly interrupt: Interrupt
  done: Promise<void>
}

type ModelEnd =
  | { readonly type: "finish"; readonly reason: FinishReason }
  | { readonly type: "error"; readonly error: ProviderError }
  /** The call was interrupted. The stream stopped without a terminal event. */
  | { readonly type: "aborted" }

interface ModelCall {
  readonly end: ModelEnd
  readonly usage: Usage | null
  /** Text of an item that was still streaming when the call ended. Kept when the call did not finish (cancel rule 3). */
  readonly partialText: string
  /** Whether a tool call's arguments were still streaming when the call ended. Such a call is never recorded or run. */
  readonly cutOff: boolean
  /** The text of the response, for a compaction call, which records no output events. */
  readonly text: string
}

type StepResult =
  /** The step is closed; the loop decides what comes next. */
  | "continue"
  /** The execution's terminal event was written. */
  | "done"

class LiveSession implements EngineSession {
  private readonly channel = new EventChannel()
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly outbox: EngineEvent[] = []
  private publishing = false
  private run: Run | null = null
  /** A settings change asked for while a step was open. It is not history yet, only a request. */
  private pendingSettings: SessionSettings | null = null
  /** Step limits callers set for the turns their inputs start. Lost with the process, like any option. */
  private readonly turnLimits = new Map<MessageId, number>()
  /** Input arrived while the drain was ending (a user's cancel winding down, or just released): start again when it is gone. */
  private restart = false
  private closing: Promise<void> | null = null

  constructor(
    private readonly core: Core,
    readonly id: SessionId,
  ) {}

  // ---- the public surface ----

  get events(): AsyncIterable<EngineEvent> {
    return this.channel
  }

  get working(): boolean {
    return this.run !== null
  }

  subscribe = (listener: (event: EngineEvent) => void) => {
    const entry = (item: EngineEvent) => listener(item)
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  projection = (): Projection => {
    const projection = this.core.store.getProjection(this.id)
    if (projection === null) throw new EngineError("session_not_found", `session ${this.id} does not exist`)
    return projection
  }

  send = (value: string, options: SendOptions = {}): MessageId => {
    this.assertOpen()
    const messageId = this.core.ids.message()
    if (options.maxSteps !== undefined) this.turnLimits.set(messageId, options.maxSteps)
    this.write([event("inbox.enqueued", { messageId, origin: null, delivery: options.delivery ?? "steer", content: text(value) })])
    this.start()
    return messageId
  }

  queue = (value: string, options: Omit<SendOptions, "delivery"> = {}) => this.send(value, { ...options, delivery: "queue" })

  start = (): void => {
    this.assertOpen()
    const projection = this.projection()
    const execution = projection.session.execution
    if (this.run !== null) {
      // Input that arrives while the drain is on its way out starts the next execution once it is gone: the user
      // cancelled and then asked for more, or the claim was released a moment ago and the drain has not returned yet.
      if ((execution === null || execution.interrupting === "user") && projection.inbox.length > 0) this.restart = true
      return
    }
    if (execution === null) {
      if (projection.inbox.length === 0) return
      const executionId = this.core.ids.execution()
      this.write([event("execution.started", { executionId })])
      this.launch(executionId)
      return
    }
    if (execution.interrupting !== null || projection.session.open !== null || owesMarker(projection)) {
      // A claim nobody is working on that was never repaired (it was opened with `wait` after this check ran).
      this.recover("wait")
      return this.start()
    }
    if (execution.status === "suspended") this.write([event("execution.resumed", { executionId: execution.id })])
    this.launch(execution.id)
  }

  interrupt = (): void => {
    this.requestInterrupt("user")
  }

  setSettings = (settings: SessionSettings): void => {
    this.assertOpen()
    // A request in flight was built from the settings it started with: the change waits for the boundary.
    if (this.projection().session.open !== null) this.pendingSettings = settings
    else this.changeSettings(settings)
  }

  settled = async (): Promise<void> => {
    while (this.run !== null) await this.run.done
  }

  close = (): Promise<void> => {
    this.closing ??= this.shutdown()
    return this.closing
  }

  // ---- writing and publishing ----

  /** Appends to the session's log and publishes what was appended. The only way this session's state changes. */
  write(events: readonly NewEvent[], options?: AppendOptions): readonly StoredEvent[] {
    const stored = this.core.store.append(this.id, events, options)
    for (const item of stored) this.publish(item)
    return stored
  }

  /** Hands an event to every consumer, in the order events were produced even when a listener produces more. */
  private publish(item: EngineEvent): void {
    this.outbox.push(item)
    if (this.publishing) return
    this.publishing = true
    try {
      for (let next = this.outbox.shift(); next !== undefined; next = this.outbox.shift()) {
        this.channel.push(next)
        for (const listener of [...this.listeners]) {
          try {
            listener(next)
          } catch (error) {
            this.core.report({ kind: "listener_failed", sessionId: this.id, message: describe(error), cause: error })
          }
        }
      }
    } finally {
      this.publishing = false
    }
  }

  private ephemeral(item: EphemeralEvent): void {
    this.publish(item)
  }

  private probe(point: ProbePoint): void {
    this.core.probe?.(point, this.id)
  }

  private assertOpen(): void {
    if (this.closing !== null) throw new EngineError("closed", `session ${this.id} is closed`)
  }

  // ---- starting, stopping, recovering ----

  private launch(executionId: ExecutionId): void {
    const run: Run = { executionId, interrupt: createInterrupt(), done: Promise.resolve() }
    this.run = run
    run.done = this.drain(run)
  }

  /**
   * Makes the interrupt durable, then aborts (cancel rule 2, "What the loop
   * must not do" 8). The first request wins. Returns whether it was this one.
   */
  private requestInterrupt(reason: InterruptReason): boolean {
    const run = this.run
    if (run === null) return false
    const execution = this.projection().session.execution
    if (execution === null || execution.id !== run.executionId || execution.status !== "running" || execution.interrupting !== null)
      return false
    this.write([event("execution.interrupt_requested", { executionId: execution.id, reason })])
    this.probe("interrupt.requested")
    run.interrupt.interrupt(reason)
    return true
  }

  private async shutdown(): Promise<void> {
    try {
      if (this.run !== null) {
        this.requestInterrupt("shutdown")
        await this.settled()
        return
      }
      // A claim this process took up and never worked on is suspended, so the next start resumes it uncounted.
      const projection = this.core.store.getProjection(this.id)
      const execution = projection?.session.execution ?? null
      if (projection && execution?.status === "running" && execution.interrupting === null && projection.session.open === null)
        this.write([
          event("execution.interrupt_requested", { executionId: execution.id, reason: "shutdown" }),
          event("execution.interrupted", { executionId: execution.id, reason: "shutdown" }),
        ])
    } catch (error) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `closing failed: ${describe(error)}`, cause: error })
    } finally {
      this.channel.end()
      this.listeners.clear()
      this.core.sessions.delete(this.id)
    }
  }

  /** Repairs a claim that no process is working on (see `recovery.ts`), then resumes it as `mode` says. */
  recover(mode: ResumeMode): void {
    const projection = this.projection()
    const recovery = recover(projection, { crashResumeCap: this.core.limits.crashResumeCap, newMessageId: this.core.ids.message })
    if (recovery.events.length > 0) this.write(recovery.events, { expectedSeq: projection.lastSeq })
    if (recovery.claim === "none" || mode === "wait") return
    const execution = claimOf(this.projection())
    if (recovery.claim === "suspended") this.write([event("execution.resumed", { executionId: execution.id })])
    if (mode === "start") this.launch(execution.id)
  }

  private changeSettings(settings: SessionSettings): void {
    const current = this.projection().session.settings
    if (current.model === settings.model && current.reasoningEffort === settings.reasoningEffort) return
    this.write([event("settings.changed", settings)])
  }

  // ---- the drain ----

  private async drain(run: Run): Promise<void> {
    try {
      // The caller that started the execution returns first.
      await Promise.resolve()
      this.probe("execution.claimed")
      await this.loop(run)
    } catch (error) {
      this.abandon(run, error)
    } finally {
      this.run = null
      const again = this.restart && this.closing === null
      this.restart = false
      if (again) {
        try {
          this.start()
        } catch (error) {
          this.core.report({ kind: "internal_error", sessionId: this.id, message: describe(error), cause: error })
        }
      }
    }
  }

  /** Works until the execution has its terminal event: succeeded, failed or interrupted. */
  private async loop(run: Run): Promise<void> {
    const { limits, ids } = this.core
    const signal = run.interrupt.signal
    for (;;) {
      this.probe("step.boundary")
      if (signal.aborted) return this.finishInterrupt(run)
      if (this.pendingSettings !== null) {
        const settings = this.pendingSettings
        this.pendingSettings = null
        this.changeSettings(settings)
      }

      const before = this.projection()
      const latest = latestSpoken(before)
      if (latest?.kind === "assistant" && latest.status === "failed") {
        // The only failed step the loop leaves unanswered is one that overflowed: compact once, then rebuild (retry rule 5).
        const compaction = before.messages.findLast(
          (message): message is CompactionMessage => message.kind === "compaction" && message.seq > latest.seq,
        )
        const overflowed = latest.error?.kind === "provider" && latest.error.error.kind === "context_overflow"
        const retryable = compaction === undefined || compaction.error?.kind === "crashed" || compaction.error?.kind === "interrupted"
        if (!overflowed || (compaction?.status !== "completed" && !retryable)) {
          this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.internal("the last step failed and was not retried") })])
          return
        }
        if (compaction?.status !== "completed") {
          if ((await this.compact(run)) === "done") return
          continue
        }
      }

      const idle = wouldGoIdle(before)
      const steers = before.inbox.filter((item) => item.delivery === "steer")
      const queued = before.inbox.find((item) => item.delivery === "queue")
      if (idle && steers.length === 0 && queued === undefined) {
        this.probe("execution.ending")
        this.write([event("execution.succeeded", { executionId: run.executionId })])
        return
      }

      // A step follows. Instructions first, then the waiting input, so the request carries both.
      const prepared = prepareInstructions(before, {
        ...(this.core.prompt === undefined ? {} : { prompt: this.core.prompt }),
        tools: this.core.tools,
        sources: this.core.discover({ cwd: before.session.cwd, known: knownAgentsFiles(instructionState(selectModelHistory(before))) }),
        newMessageId: ids.message,
      })
      if (prepared.length > 0) this.write(prepared)
      // Steers at any boundary, oldest first; one queued item only when the turn before it has its answer.
      const deliveries = steers.length > 0 ? steers : idle && queued !== undefined ? [queued] : []
      if (deliveries.length > 0) this.write(deliveries.map((item) => event("inbox.delivered", { messageId: item.messageId })))

      const ready = this.projection()
      const input = turnInput(ready)
      const limit = (input === undefined ? undefined : this.turnLimits.get(input.id)) ?? limits.stepLimit
      const steps = stepsThisTurn(ready)
      let forbidden = notedThisTurn(ready, HARNESS_ORIGIN.stepLimit)
      if (forbidden && steps > limit + 2) {
        // The final call may not use tools, and a provider that ignores that could go round for ever.
        this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.stepLimitIgnored })])
        return
      }
      if (!forbidden && steps >= limit) {
        this.write([note(ids.message(), HARNESS_ORIGIN.stepLimit, NOTE_TEXT.stepLimit)])
        forbidden = true
      }
      // The tool list stays; only the choice changes, which is not part of the cached prefix.
      if ((await this.step(run, forbidden ? "none" : "auto")) === "done") return
    }
  }

  /** One logical step: a model call with its single attempt budget (retry rule 1), then its tools. */
  private async step(run: Run, toolChoice: ModelRequest["toolChoice"]): Promise<StepResult> {
    const { limits, clock, ids } = this.core
    const signal = run.interrupt.signal
    const start = this.projection()
    const request = buildRequest(start, { ...this.core.call, toolChoice })
    const blocks = hashRequest(request)
    this.checkPrefix(start, blocks)
    const messageId = ids.message()
    let attempt = claimOf(start).nextAttempt
    this.write([event("step.started", { messageId, attempt, model: start.session.settings.model })])
    this.probe("step.started")

    let refreshed = false
    for (;;) {
      // A retry resends the same request unchanged.
      const call = await this.callModel(run, { messageId, attempt, request, blocks, purpose: "step" })
      if (call.end.type === "aborted") {
        this.finishInterrupt(run, call.partialText)
        return "done"
      }
      if (call.end.type === "finish") return this.finishStep(run, messageId, toolChoice, call.end.reason, call)

      const error = call.end.error
      const message = this.assistant(messageId)
      // The partial text the user saw is kept, as on a cancel; partial reasoning and arguments are dropped.
      const flush = call.partialText === "" ? [] : [event("text.ended", { messageId, text: call.partialText, providerData: null })]
      const hasOutput = message.parts.length > 0 || flush.length > 0
      // A call that was recorded never started: tools run only after the response finishes.
      const closing = [...flush, ...settleUnsettled(message, STOPPED)]
      const failed = event("step.failed", { messageId, error: { kind: "provider", error }, usage: call.usage })
      const giveUp = (reason: string) => event("execution.failed", { executionId: run.executionId, message: reason })

      if (error.kind === "content_policy") {
        const refused = event("step.refused", {
          messageId,
          message: error.message,
          excludeFromSeq: refusedTurnStart(this.projection(), message),
          usage: call.usage,
        })
        this.write([...closing, refused, giveUp(FAILURE_TEXT.refused)])
        return "done"
      }
      if (error.kind === "auth" && !hasOutput && !refreshed && this.core.refreshAuth !== undefined) {
        refreshed = true
        const usable = await this.core.refreshAuth().catch(() => false)
        if (signal.aborted) {
          this.finishInterrupt(run)
          return "done"
        }
        if (usable) continue
      }
      if (error.retryable && attempt < limits.attemptBudget) {
        const delayMs = retryDelayMs(limits, attempt, error, this.core.random)
        const retry = event("retry.scheduled", { messageId, attempt: attempt + 1, delayMs, error })
        // Before durable output the retry is transparent. After it the message fails, and the retry runs under a new
        // message that the model is asked to continue from (retry rule 2).
        this.write(hasOutput ? [...closing, failed, retry, note(ids.message(), HARNESS_ORIGIN.continuation, NOTE_TEXT.continuation)] : [retry])
        this.probe("retry.scheduled")
        await clock.sleep(delayMs, signal)
        if (signal.aborted) {
          this.finishInterrupt(run)
          return "done"
        }
        if (hasOutput) return "continue"
        attempt += 1
        continue
      }
      if (error.kind === "context_overflow" && !hasOutput && !this.compactedInVain(start)) {
        // Closed here; the loop compacts at the boundary and rebuilds the request.
        this.write([failed])
        this.probe("step.closed")
        return "continue"
      }
      const reason = error.retryable
        ? FAILURE_TEXT.budget(attempt, error)
        : error.kind === "context_overflow"
          ? FAILURE_TEXT.overflow
          : failureText(error)
      this.write([...closing, failed, giveUp(reason)])
      return "done"
    }
  }

  /** The model call finished: run what it asked for and close the step. */
  private async finishStep(
    run: Run,
    messageId: MessageId,
    toolChoice: ModelRequest["toolChoice"],
    reason: FinishReason,
    call: ModelCall,
  ): Promise<StepResult> {
    const ids = this.core.ids
    const message = this.assistant(messageId)
    const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call")
    const usage = call.usage

    if (reason === "length") {
      // A call cut off by the output limit was never recorded and never runs (retry rule 6). Calls that did end
      // are not run either: the response they belong to is incomplete.
      const told = call.cutOff || calls.length > 0
      this.write([
        ...settleUnsettled(message, STOPPED),
        event("step.ended", { messageId, finish: "length", usage }),
        ...(told ? [note(ids.message(), HARNESS_ORIGIN.outputLimit, NOTE_TEXT.outputLimit)] : []),
      ])
      this.probe("step.closed")
      return "continue"
    }

    if (calls.length > 0) {
      await this.runTools(run, message, calls, toolChoice)
      if (run.interrupt.signal.aborted) {
        this.finishInterrupt(run)
        return "done"
      }
      // A step that ran tools asked for tools, whatever the provider called its finish.
      this.write([event("step.ended", { messageId, finish: "tool_calls", usage })])
      this.probe("step.closed")
      return "continue"
    }

    const ended = event("step.ended", { messageId, finish: "stop", usage })
    const current = this.projection()
    if (message.parts.length === 0 && !current.inbox.some((item) => item.delivery === "steer")) {
      // An empty response gets one nudge; a second one in a row fails the execution (retry rule 8).
      const previous = current.messages.at(-2)
      const nudged = previous?.kind === "synthetic" && previous.delivery === null && previous.origin === HARNESS_ORIGIN.emptyResponse
      if (nudged) {
        this.write([ended, event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.emptyTwice })])
        return "done"
      }
      this.write([ended, note(ids.message(), HARNESS_ORIGIN.emptyResponse, NOTE_TEXT.emptyResponse)])
      this.probe("step.closed")
      return "continue"
    }
    this.write([ended])
    this.probe("step.closed")
    return "continue"
  }

  /**
   * Streams one model call: deltas are published as they arrive, each
   * finished item is appended at its end, and the ledger row is closed.
   * A compaction call records no output events; its text is returned.
   */
  private async callModel(
    run: Run,
    input: {
      readonly messageId: MessageId
      readonly attempt: number
      readonly request: ModelRequest
      readonly blocks: readonly BlockHash[]
      readonly purpose: RequestPurpose
    },
  ): Promise<ModelCall> {
    const { store, provider, ids } = this.core
    const signal = run.interrupt.signal
    const { messageId, request } = input
    const step = input.purpose === "step"
    const requestId = ids.request()
    store.beginRequest({
      id: requestId,
      sessionId: this.id,
      messageId,
      attempt: input.attempt,
      purpose: input.purpose,
      model: request.params.model,
      blocks: input.blocks,
    })

    let usage: Usage | null = null
    let partialText = ""
    let whole = ""
    let end: ModelEnd | null = null
    const streaming = new Set<string>()
    const threw = (error: unknown): ModelEnd => ({
      type: "error",
      error: makeProviderError("provider_internal", `The provider failed: ${describe(error)}`),
    })

    let iterator: AsyncIterator<StreamEvent> | null = null
    try {
      iterator = provider.stream(request, signal)[Symbol.asyncIterator]()
    } catch (error) {
      end = threw(error)
    }
    // A provider that does not stop on abort must not hold the cancel up: the loop stops waiting for it.
    const stopped = abortedOnce(signal)
    try {
      while (iterator !== null && end === null) {
        // Only the provider's own failure is caught here: an error in what follows is the harness's and must surface.
        const next = await Promise.race([iterator.next().catch((error: unknown) => ({ failed: error })), stopped.promise])
        if (next === ABORTED) break
        if ("failed" in next) {
          if (!signal.aborted) end = threw(next.failed)
          break
        }
        if (next.done || signal.aborted) break
        const item = next.value
        switch (item.type) {
          case "text.delta":
            partialText += item.text
            if (step) this.ephemeral({ type: "text.delta", sessionId: this.id, messageId, text: item.text })
            break
          case "text.end":
            partialText = ""
            whole += item.text
            if (step) {
              this.write([event("text.ended", { messageId, text: item.text, providerData: item.providerData })])
              this.probe("model.output")
            }
            break
          case "reasoning.delta":
            if (step) this.ephemeral({ type: "reasoning.delta", sessionId: this.id, messageId, text: item.text })
            break
          case "reasoning.end":
            if (step) {
              this.write([event("reasoning.ended", { messageId, text: item.text, providerData: item.providerData })])
              this.probe("model.output")
            }
            break
          case "tool_call.delta":
            streaming.add(item.callId)
            if (step)
              this.ephemeral({
                type: "tool.input.delta",
                sessionId: this.id,
                messageId,
                callId: item.callId as CallId,
                name: item.name,
                input: item.input,
              })
            break
          case "tool_call.end":
            streaming.delete(item.callId)
            if (step) {
              // Durable before anything runs; if this append throws, nothing runs (cancel rule 1).
              this.write([
                event("tool.called", { messageId, callId: item.callId as CallId, name: item.name, input: item.input, providerData: item.providerData }),
              ])
              this.probe("model.output")
            }
            break
          case "usage":
            usage = item.usage
            break
          case "finish":
            end = { type: "finish", reason: item.reason }
            break
          case "error":
            end = { type: "error", error: item.error }
            break
        }
      }
    } finally {
      stopped.dispose()
      // Stops the request when the loop stopped reading first. After an abort the provider is not waited for.
      const closed = iterator?.return?.().catch(() => {})
      if (!signal.aborted) await closed
    }
    // No terminal event and nobody aborted: the stream broke.
    end ??= signal.aborted ? { type: "aborted" } : { type: "error", error: makeProviderError("incomplete_stream", INCOMPLETE_STREAM) }
    store.finishRequest(requestId, {
      outcome: end.type === "finish" ? "ok" : end.type === "error" ? "error" : "aborted",
      usage,
      errorKind: end.type === "error" ? end.error.kind : null,
    })
    return { end, usage, partialText, cutOff: streaming.size > 0, text: whole }
  }

  /**
   * Runs the step's calls at once and settles each exactly once, in the order
   * they finish. Returns when every call is settled, or, after an interrupt,
   * when the tools have stopped or their grace period is over; what is still
   * unsettled then is settled by `finishInterrupt` from its recorded state.
   */
  private async runTools(
    run: Run,
    message: AssistantMessage,
    calls: readonly ToolCallPart[],
    toolChoice: ModelRequest["toolChoice"],
  ): Promise<void> {
    const { runtime, limits, clock, effects } = this.core
    const signal = run.interrupt.signal
    const before = this.projection()
    const messageId = message.id
    const unsettled = new Set<CallId>()
    const abandoned = new Set<CallId>()
    const failure: { error?: unknown; failed: boolean } = { failed: false }
    const refuse = (call: ToolCallPart, output: string) =>
      this.write([
        event("tool.settled", { messageId, callId: call.callId, outcome: "error", output, truncation: null, attachments: [], display: null }),
      ])

    const running = calls.flatMap((call, index): Promise<void>[] => {
      // Once an interrupt is requested nothing new starts; the call is settled as not started below.
      if (failure.failed || signal.aborted) return []
      if (toolChoice === "none") return refuse(call, TOOL_TEXT.toolsDisabled) && []
      if (index >= limits.maxToolCallsPerStep) return refuse(call, TOOL_TEXT.tooManyCalls(limits.maxToolCallsPerStep)) && []
      if (repeatsItself(before, { messageId, callId: call.callId, name: call.name, input: call.input })) return refuse(call, TOOL_TEXT.identicalCall) && []
      const effect = effects.get(call.name)
      unsettled.add(call.callId)
      const outcome = runtime.run(
        {
          name: call.name,
          argumentsText: call.input,
          context: {
            sessionId: this.id,
            messageId,
            callId: call.callId,
            cwd: before.session.cwd,
            signal,
            progress: (update) => {
              if (!abandoned.has(call.callId)) this.ephemeral({ type: "tool.progress", sessionId: this.id, messageId, callId: call.callId, text: update.text })
            },
          },
        },
        {
          // Synchronous, right before the tool runs: the start is durable before any side effect.
          onStart: () => {
            if (effect === undefined) throw new Error(`tool ${call.name} started without an effect class`)
            this.write([event("tool.started", { messageId, callId: call.callId, effect })])
            this.probe("tool.started")
          },
        },
      )
      return [
        outcome
          .then((result) => {
            this.probe("tool.finished")
            // A tool that came back after its grace period was already settled from its effect class.
            if (abandoned.has(call.callId)) return
            unsettled.delete(call.callId)
            this.write([event("tool.settled", { messageId, callId: call.callId, ...this.settlement(result, effect, signal) })])
            this.probe("tool.settled")
          })
          .catch((error: unknown) => {
            unsettled.delete(call.callId)
            if (!failure.failed) failure.error = error
            failure.failed = true
          }),
      ]
    })

    const all = Promise.all(running)
    await untilAborted(all, signal)
    if (signal.aborted && unsettled.size > 0) {
      // Cooperative: the tools saw the abort. Give them time to stop and report what they observed.
      const timer = new AbortController()
      await Promise.race([all, clock.sleep(limits.toolStopGraceMs, timer.signal)])
      timer.abort()
      for (const callId of unsettled) abandoned.add(callId)
    }
    if (failure.failed) throw failure.error
  }

  /** What `tool.settled` records for an outcome of the runtime. */
  private settlement(result: ToolCallOutcome, effect: ToolEffect | undefined, signal: AbortSignal) {
    if (result.kind !== "crashed") return result.settlement
    // A tool that threw while it was being stopped reported nothing: the outcome follows from its effect class.
    if (signal.aborted) {
      const base = { truncation: null, attachments: [], display: null }
      return effect === "read"
        ? { ...base, outcome: "error" as const, output: STOPPED.read }
        : { ...base, outcome: "effect_unknown" as const, output: STOPPED.effectUnknown }
    }
    this.core.report({ kind: "tool_crashed", sessionId: this.id, message: describe(result.error), cause: result.error })
    return result.settlement
  }

  /**
   * Compacts after a context overflow: summarises everything before the
   * latest user message and keeps that message and what follows verbatim.
   * The request is the step request of the summarised part plus one prompt,
   * so it reads that part from the cache (context rule 7).
   */
  private async compact(run: Run): Promise<StepResult> {
    const { limits, clock, ids } = this.core
    const signal = run.interrupt.signal
    const start = this.projection()
    const floor = start.session.compaction?.seq ?? 0
    const visible = selectModelHistory(start).messages
    const kept = visible.findLast((message) => message.kind === "user" && message.seq > floor)
    const giveUp = (reason: string) => event("execution.failed", { executionId: run.executionId, message: reason })
    if (!visible.some((message) => message.kind !== "compaction" && (kept === undefined || message.seq < kept.seq))) {
      // Nothing older than the prompt itself: a summary cannot make this request fit.
      this.write([giveUp(FAILURE_TEXT.overflow)])
      return "done"
    }
    const messageId = ids.message()
    const [started] = this.write([event("compaction.started", { messageId, trigger: "overflow" })])
    const keepFromSeq = kept?.seq ?? started!.seq
    const older = { ...start, messages: start.messages.filter((message) => message.seq < keepFromSeq || message.kind === "compaction") }
    const request = buildCompactionRequest(older, COMPACTION_PROMPT, this.core.call)
    const blocks = hashRequest(request)

    for (let attempt = 1; ; attempt += 1) {
      const call = await this.callModel(run, { messageId, attempt, request, blocks, purpose: "compaction" })
      if (call.end.type === "aborted") {
        this.finishInterrupt(run)
        return "done"
      }
      if (call.end.type === "finish") {
        const summary = (call.text + call.partialText).trim()
        if (summary === "") {
          this.write([
            event("compaction.failed", { messageId, error: { kind: "internal", message: "the model returned an empty summary" } }),
            giveUp(FAILURE_TEXT.compaction("the model returned an empty summary")),
          ])
          return "done"
        }
        this.write([event("compaction.ended", { messageId, summary, keepFromSeq, usage: call.usage })])
        return "continue"
      }
      const error = call.end.error
      if (error.retryable && attempt < limits.attemptBudget) {
        // The log has no retry event for a compaction; the ledger row of each attempt is its record.
        await clock.sleep(retryDelayMs(limits, attempt, error, this.core.random), signal)
        if (signal.aborted) {
          this.finishInterrupt(run)
          return "done"
        }
        continue
      }
      this.write([event("compaction.failed", { messageId, error: { kind: "provider", error } }), giveUp(FAILURE_TEXT.compaction(error.message))])
      return "done"
    }
  }

  /** Whether the request that just overflowed was already built from an overflow compaction: once is the limit. */
  private compactedInVain(projection: Projection): boolean {
    const compaction = projection.session.compaction
    if (compaction === null) return false
    const checkpoint = projection.messages.findLast((message) => message.id === compaction.messageId)
    if (checkpoint?.kind !== "compaction" || checkpoint.trigger !== "overflow") return false
    return !projection.messages.some((message) => message.kind === "assistant" && message.status === "completed" && message.seq > compaction.seq)
  }

  /**
   * Winds the execution down after a requested interrupt, in one append:
   * the visible partial text, one terminal result for every unsettled call,
   * the step closed as interrupted, the marker for the model, the release
   * (cancel rules 3, 4 and 6). With no step open there is nothing to close;
   * a user's cancel still leaves the marker, a shutdown at a boundary cut
   * nothing short and leaves none.
   */
  private finishInterrupt(run: Run, partialText = ""): void {
    const reason = interruptReasonOf(run.interrupt.signal)
    if (reason === null) throw new Error("the execution is not interrupted")
    const projection = this.projection()
    const execution = claimOf(projection)
    const error = { kind: "interrupted", reason } as const
    const events: NewEvent[] = []
    let cutShort = owesMarker(projection)
    const step = openStep(projection)
    if (step !== null) {
      if (partialText !== "") events.push(event("text.ended", { messageId: step.id, text: partialText, providerData: null }))
      events.push(...settleUnsettled(step, STOPPED), event("step.failed", { messageId: step.id, error, usage: null }))
      cutShort = true
    }
    const open = projection.session.open
    if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error }))
    if (cutShort || reason === "user")
      events.push(
        note(this.core.ids.message(), HARNESS_ORIGIN.interrupt, reason === "user" ? NOTE_TEXT.interruptedByUser : NOTE_TEXT.interruptedByRestart),
      )
    events.push(event("execution.interrupted", { executionId: execution.id, reason }))
    this.write(events)
  }

  /**
   * The loop itself failed (a bug, a storage error). Closes what is open as
   * an internal failure and releases the claim, so the session is usable
   * again; if even that cannot be written, the claim stays and the next
   * start recovers it as a crash.
   */
  private abandon(run: Run, error: unknown): void {
    this.core.report({ kind: "internal_error", sessionId: this.id, message: describe(error), cause: error })
    try {
      const projection = this.projection()
      const execution = projection.session.execution
      if (execution === null || execution.id !== run.executionId || execution.status !== "running") return
      if (execution.interrupting !== null) {
        if (!run.interrupt.signal.aborted) run.interrupt.interrupt(execution.interrupting)
        return this.finishInterrupt(run)
      }
      const failure = { kind: "internal", message: describe(error) } as const
      const events: NewEvent[] = []
      const step = openStep(projection)
      if (step !== null) events.push(...settleUnsettled(step, STOPPED), event("step.failed", { messageId: step.id, error: failure, usage: null }))
      const open = projection.session.open
      if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error: failure }))
      if (owesMarker(projection)) events.push(note(this.core.ids.message(), HARNESS_ORIGIN.interrupt, NOTE_TEXT.interruptedByRestart))
      events.push(event("execution.failed", { executionId: execution.id, message: FAILURE_TEXT.internal(describe(error)) }))
      this.write(events)
    } catch (second) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `could not close the failed execution: ${describe(second)}`, cause: second })
    }
  }

  /**
   * The runtime prefix check (context rule 1): the request about to be sent
   * must be the previous step request plus appended blocks, unless an event
   * appended since allows a break. A violation is a bug in the harness; it
   * is reported, and thrown only in strict mode.
   */
  private checkPrefix(projection: Projection, blocks: readonly BlockHash[]): void {
    const store = this.core.store
    const last = store.lastRequest(this.id, "step")
    if (last === null) return
    const served = projection.messages.findLast((message) => message.id === last.messageId)
    const since = served === undefined ? [] : store.readEvents(this.id, { afterSeq: served.seq })
    const verdict = checkPrefix(last.blocks, blocks, since)
    if (verdict.status !== "violation") return
    const violation = new PrefixViolationError(this.id, verdict)
    this.core.report({ kind: "prefix_violation", sessionId: this.id, message: violation.message, cause: violation })
    if (this.core.strict) throw violation
  }

  private assistant(messageId: MessageId): AssistantMessage {
    const message = this.projection().messages.findLast((candidate) => candidate.id === messageId)
    if (message?.kind !== "assistant") throw new Error(`step ${messageId} has no assistant message`)
    return message
  }
}

/** The harness config directory, where the user-level AGENTS.md lives: `$XDG_CONFIG_HOME/<brand.directory>`. */
function configDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), brand.directory)
}

const ABORTED = Symbol("aborted")

/** A promise that resolves with `ABORTED` when the signal aborts. `dispose` removes its listener. */
function abortedOnce(signal: AbortSignal): { readonly promise: Promise<typeof ABORTED>; readonly dispose: () => void } {
  let dispose = () => {}
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) return resolve(ABORTED)
    const done = () => resolve(ABORTED)
    signal.addEventListener("abort", done, { once: true })
    dispose = () => signal.removeEventListener("abort", done)
  })
  return { promise, dispose }
}

/** Waits for `promise`, or for the abort, whichever is first, and leaves no listener behind. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
    void promise.then(done)
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
