/**
 * A fake engine that replays a scripted step-loop scenario with realistic
 * timing, so the CLI can run end to end before the real step loop exists.
 *
 * The scenario's durable events are replayed as written. Around them the fake
 * adds what a live engine would stream: text and reasoning deltas before each
 * `text.ended` / `reasoning.ended`, argument deltas before `tool.called`, and
 * progress while a command runs.
 *
 * `interrupt()` and `close()` stop the replay and write the cancel sequence the
 * step loop writes: `execution.interrupt_requested` at once, then the visible
 * partial text, every recorded call settled once (after a grace period when a
 * command was running), the open step failed as interrupted, the interrupt
 * marker, and `execution.interrupted`. `interrupt()` stops for the user;
 * `close()` stops as a shutdown, which keeps the claim.
 *
 * `send` while a turn plays admits the message at once (`inbox.enqueued`) and
 * delivers it the way the loop does: a steer at the next step boundary, a
 * queued message when the session would otherwise go idle. The script cannot
 * react to it, so a message delivered after the script's last step gets a short
 * scripted answer of its own; one delivered earlier is answered by the
 * script's next step.
 *
 * A scenario is split into turns at the points where the session goes idle;
 * each `send` while idle plays the next one. Once the script is used up (or
 * diverged because of an interrupt), `send` answers with a short generic turn.
 */
import {
  type CallId,
  type EphemeralEvent,
  type ExecutionId,
  type InterruptReason,
  type MessageId,
  type NewEvent,
  type SessionId,
  type StoredEvent,
  type ToolEffect,
  brand,
  event,
  text,
} from "@light-harness/core"
import { EFFECT_UNKNOWN, INTERRUPTED_READ, NOT_STARTED, type Scenario } from "@light-harness/core/testing/scenarios"
import type { Engine, EngineEvent, OpenRequest, SendOptions, Session } from "./engine.ts"

export interface FakeOptions {
  /** Playback speed: 1 is real time, 2 twice as fast, 0 instant (no waiting at all). */
  readonly speed?: number
  /** How long a stopped tool takes to wind down after an interrupt, in real-time milliseconds. */
  readonly graceMs?: number
  /** Start of the virtual clock that stamps event times. Default: the wall clock when the session opens. */
  readonly clockStart?: number
  /** Told `close` when `close` is called and `closed` when it has finished; for tests of the CLI's exit paths. */
  readonly trace?: (line: string) => void
}

/** One turn of a scenario: what the user typed to start it (if anything) and the events until the session is idle. */
export interface ScriptedTurn {
  readonly prompt: string | null
  readonly events: readonly Planned[]
}

interface Planned {
  readonly event: NewEvent
  /** First event of a scenario phase; the replay pauses before it (for example "the process dies, then at next start-up"). */
  readonly phaseStart: boolean
}

/** Splits a scenario into what happens before the first prompt and one entry per turn. */
export function scriptTurns(scenario: Scenario): { preamble: NewEvent[]; turns: ScriptedTurn[] } {
  const preamble: NewEvent[] = []
  const turns: { prompt: string | null; events: Planned[] }[] = []
  let current: { prompt: string | null; events: Planned[] } | null = null
  for (const phase of scenario.phases) {
    phase.events.forEach((item, index) => {
      const startsTurn =
        (item.type === "inbox.enqueued" && item.data.origin === null) || item.type === "execution.started" || item.type === "execution.resumed"
      if (current === null) {
        if (!startsTurn && turns.length === 0) {
          preamble.push(item)
          return
        }
        current = { prompt: item.type === "inbox.enqueued" ? promptText(item) : null, events: [] }
        turns.push(current)
      }
      current.events.push({ event: item, phaseStart: index === 0 })
      if (item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted") current = null
    })
  }
  // A script may stop with the execution open (it ends "at next start-up", right after the resume, with no step open).
  // Close it the way a process that exits there would, as a shutdown that keeps the claim, so the turn ends instead
  // of waiting forever.
  const open = openExecution(turns.at(-1)?.events ?? [])
  if (open !== null)
    turns.at(-1)!.events.push(
      { event: event("execution.interrupt_requested", { executionId: open, reason: "shutdown" }), phaseStart: false },
      { event: event("execution.interrupted", { executionId: open, reason: "shutdown" }), phaseStart: false },
    )
  return { preamble, turns }
}

export class FakeEngine implements Engine {
  readonly preamble: readonly NewEvent[]
  readonly turns: readonly ScriptedTurn[]

  constructor(
    scenario: Scenario,
    private readonly options: FakeOptions = {},
  ) {
    const script = scriptTurns(scenario)
    this.preamble = script.preamble
    this.turns = script.turns
  }

  async open(request: OpenRequest): Promise<FakeSession> {
    const id = (request.session.kind === "resume" ? request.session.id : "ses_demo") as SessionId
    const session = new FakeSession(id, this.turns, this.options)
    for (const item of this.preamble) session.emitDurable(item)
    return session
  }
}

interface CallState {
  readonly name: string
  /** The effect class recorded with `tool.started`; it decides how a stopped call settles. */
  effect: ToolEffect | null
  started: boolean
  settled: boolean
  startedAt: number
  progress: string
}

interface InboxItem {
  readonly id: MessageId
  delivery: "steer" | "queue"
  readonly text: string
  /** Admitted by `send` during a turn, rather than written by the script. */
  readonly live: boolean
}

/** The last work event after which the loop may deliver input: a step boundary that is not part of a retry or a wind-down. */
const DELIVERY_POINTS = new Set(["step.ended", "execution.started", "execution.resumed", "baseline.set", "inbox.delivered", "instruction.appended", "compaction.ended"])
/** Events about the session or its inbox, written whenever the user acts; they do not move the turn on. */
const SESSION_SCOPED = new Set(["inbox.enqueued", "inbox.delivery_changed", "inbox.cancelled", "settings.changed", "session.created", "session.renamed", "session.archived", "session.unarchived"])

export class FakeSession implements Session {
  readonly events: AsyncIterable<EngineEvent>
  private readonly channel = new Channel<EngineEvent>()
  private seq = 0
  private virtual = 0
  private readonly clockStart: number
  private readonly speed: number
  private cursor = 0
  private playing: Promise<void> | null = null
  /** The stop that was asked for (`interrupt` or `close`); the first wins. */
  private stopWanted: InterruptReason | null = null
  /** The stop is in effect: its request is in the log and the replay winds down. */
  private stopping = false
  private wake: (() => void) | null = null
  private closing: Promise<void> | null = null
  private closed = false
  private generic = 0
  private live = 0
  // What the log holds so far, for the cancel sequence and for deliveries.
  private model = "demo"
  private execution: ExecutionId | null = null
  private interrupting: InterruptReason | null = null
  private step: MessageId | null = null
  private compaction: MessageId | null = null
  private lastWork: string | null = null
  private calls = new Map<string, CallState>()
  private partialText: { messageId: MessageId; sent: string } | null = null
  private readonly inbox: InboxItem[] = []
  /** A live message was delivered and no step has ended since: the model still has to answer it. */
  private unanswered: InboxItem[] = []

  constructor(
    readonly id: SessionId,
    private readonly turns: readonly ScriptedTurn[],
    private readonly options: FakeOptions,
  ) {
    this.events = this.channel
    this.clockStart = options.clockStart ?? Date.now()
    this.speed = options.speed ?? 1
  }

  /** Scripted turns not played yet. */
  get remaining(): number {
    return this.turns.length - this.cursor
  }

  /** The prompt the next scripted turn starts with, if it starts with one. */
  get nextPrompt(): string | null {
    return this.turns[this.cursor]?.prompt ?? null
  }

  /** Resolves when the turn being played has finished. */
  async idle(): Promise<void> {
    await this.playing
  }

  async send(prompt: string, options: SendOptions = {}): Promise<MessageId | null> {
    if (this.closed || this.closing !== null) return null
    if (this.playing !== null) return this.admit(prompt, options.delivery ?? "steer")
    const turn = this.turns[this.cursor] ?? this.genericTurn(prompt)
    this.cursor = Math.min(this.cursor + 1, this.turns.length)
    const events = turn.events.map((planned, index) =>
      index === 0 && planned.event.type === "inbox.enqueued" && prompt.trim() !== ""
        ? { ...planned, event: event("inbox.enqueued", { ...planned.event.data, content: text(prompt) }) }
        : planned,
    )
    this.stopWanted = null
    this.stopping = false
    this.playing = this.play(events).finally(() => {
      this.playing = null
    })
    const first = events[0]?.event
    return first?.type === "inbox.enqueued" ? first.data.messageId : null
  }

  interrupt(): void {
    this.requestStop("user")
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.options.trace?.("close")
      this.requestStop("shutdown")
      await this.playing
      this.closed = true
      this.channel.close()
      this.options.trace?.("closed")
    })()
    return this.closing
  }

  // ---------------------------------------------------------------- input during a turn

  /** Admits a message while a turn plays. It waits in the inbox for its delivery point. */
  private admit(value: string, delivery: "steer" | "queue"): MessageId {
    this.live += 1
    const messageId = `u_live_${this.live}` as MessageId
    this.emitDurable(event("inbox.enqueued", { messageId, origin: null, delivery, content: text(value) }), true)
    return messageId
  }

  /** Delivers waiting live input that is due before `next`. Returns `false` when interrupted. */
  private async deliverBefore(next: NewEvent): Promise<boolean> {
    if (!this.atDeliveryPoint()) return true
    if (next.type === "inbox.delivered") {
      // Live steers admitted before the scripted item go first: within a mode the oldest is delivered first.
      const target = this.inbox.find((item) => item.id === next.data.messageId)
      if (target === undefined) return true
      for (let first = this.firstOf(target.delivery); first !== undefined && first !== target && first.live; first = this.firstOf(target.delivery))
        if (!(await this.deliver(first))) return false
      return true
    }
    if (next.type !== "step.started" && next.type !== "execution.succeeded") return true
    for (let first = this.firstOf("steer"); first?.live === true; first = this.firstOf("steer")) if (!(await this.deliver(first))) return false
    if (next.type !== "execution.succeeded") return true
    // The session would go idle: answer what was delivered, then take queued items one at a time.
    for (;;) {
      if (this.unanswered.length > 0) {
        if (!(await this.answer())) return false
        continue
      }
      const queued = this.firstOf("queue")
      if (this.firstOf("steer") !== undefined || queued?.live !== true) return true
      if (!(await this.deliver(queued))) return false
    }
  }

  private atDeliveryPoint(): boolean {
    return (
      this.execution !== null &&
      this.interrupting === null &&
      !this.stopping &&
      this.step === null &&
      this.compaction === null &&
      this.lastWork !== null &&
      DELIVERY_POINTS.has(this.lastWork)
    )
  }

  private firstOf(delivery: "steer" | "queue"): InboxItem | undefined {
    return this.inbox.find((item) => item.delivery === delivery)
  }

  private async deliver(item: InboxItem): Promise<boolean> {
    if (!(await this.replay(event("inbox.delivered", { messageId: item.id })))) return false
    this.unanswered.push(item)
    return true
  }

  /** A scripted answer to live input the script could not have known about. */
  private async answer(): Promise<boolean> {
    this.live += 1
    const messageId = `a_live_${this.live}` as MessageId
    const quoted = this.unanswered.map((item) => `"${oneLine(item.text)}"`).join(" and ")
    const reply = `Got ${quoted}. This is a scripted demo, so the replay cannot act on it; with the real engine the model would answer it here.`
    const usage = { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 30, reasoningTokens: 0 }
    for (const item of [
      event("step.started", { messageId, attempt: 1, model: this.model }),
      event("text.ended", { messageId, text: reply, providerData: null }),
      event("step.ended", { messageId, finish: "stop", usage }),
    ])
      if (!(await this.replay(item))) return false
    return true
  }

  // ---------------------------------------------------------------- replay

  private async play(events: readonly Planned[]): Promise<void> {
    for (const [index, planned] of events.entries()) {
      if (planned.phaseStart && index > 0 && !(await this.wait(700))) return this.cancel()
      if (!(await this.deliverBefore(planned.event))) return this.cancel()
      if (!(await this.replay(planned.event))) return this.cancel()
    }
  }

  /** Replays one durable event with what a live engine streams before it. Returns `false` when interrupted. */
  private async replay(item: NewEvent): Promise<boolean> {
    switch (item.type) {
      case "text.ended": {
        if (!(await this.wait(60))) return false
        this.partialText = { messageId: item.data.messageId, sent: "" }
        for (const chunk of chunks(item.data.text)) {
          if (!(await this.wait(28))) return false
          this.emit({ type: "text.delta", sessionId: this.id, messageId: item.data.messageId, text: chunk })
          this.partialText.sent += chunk
        }
        this.partialText = null
        this.emitDurable(item)
        return true
      }
      case "reasoning.ended": {
        for (const chunk of chunks(item.data.text)) {
          if (!(await this.wait(18))) return false
          this.emit({ type: "reasoning.delta", sessionId: this.id, messageId: item.data.messageId, text: chunk })
        }
        this.emitDurable(item)
        return true
      }
      case "tool.called": {
        const input = item.data.input
        const third = Math.ceil(input.length / 3)
        for (const piece of [input.slice(0, third), input.slice(third, third * 2), input.slice(third * 2)]) {
          if (!(await this.wait(40))) return false
          if (piece !== "")
            this.emit({ type: "tool.input.delta", sessionId: this.id, messageId: item.data.messageId, callId: item.data.callId, name: item.data.name, input: piece })
        }
        this.emitDurable(item)
        return true
      }
      case "tool.settled": {
        const call = this.calls.get(item.data.callId)
        const ran = call?.started === true && (item.data.outcome === "success" || item.data.outcome === "error")
        if (ran && call.name === "shell") {
          // A command prints as it runs: show its output growing, then settle.
          const lines = item.data.output.split("\n")
          const total = Math.min(8000, Math.max(900, lines.length * 300))
          const per = total / Math.max(1, lines.length)
          for (const [index] of lines.entries()) {
            if (!(await this.wait(per))) return false
            call.progress = lines.slice(0, index + 1).join("\n")
            this.emit({ type: "tool.progress", sessionId: this.id, messageId: item.data.messageId, callId: item.data.callId, text: call.progress })
          }
        } else if (!(await this.wait(ran ? 180 : 30))) return false
        this.emitDurable(item)
        return true
      }
      case "retry.scheduled": {
        this.emitDurable(item)
        return this.wait(Math.min(item.data.delayMs, 1500), item.data.delayMs)
      }
      case "step.started": {
        if (!(await this.wait(80))) return false
        this.emitDurable(item)
        // The model's time to first token.
        return this.wait(450)
      }
      case "inbox.enqueued":
        if (this.execution !== null && !(await this.wait(350))) return false
        this.emitDurable(item)
        return true
      default:
        if (!(await this.wait(40))) return false
        this.emitDurable(item)
        return true
    }
  }

  // ---------------------------------------------------------------- stopping

  private requestStop(reason: InterruptReason): void {
    if (this.playing === null || this.stopWanted !== null) return
    this.stopWanted = reason
    this.beginStop()
  }

  /**
   * Puts a wanted stop into effect: the request is durable the moment the abort
   * fires, before anything is stopped. Before the turn's execution exists the
   * stop waits for it (see `emitDurable`).
   */
  private beginStop(): void {
    if (this.stopWanted === null || this.stopping || this.execution === null) return
    this.stopping = true
    if (this.interrupting === null) this.emitDurable(event("execution.interrupt_requested", { executionId: this.execution, reason: this.stopWanted }))
    this.wake?.()
  }

  /** What the step loop writes after the interrupt request (see the cancel and shutdown scenarios). */
  private async cancel(): Promise<void> {
    const reason = this.interrupting ?? this.stopWanted ?? "user"
    // The visible partial text is kept, at once.
    if (this.partialText !== null && this.partialText.sent !== "")
      this.emitDurable(event("text.ended", { messageId: this.partialText.messageId, text: this.partialText.sent, providerData: null }))
    this.partialText = null
    const open = [...this.calls.entries()].filter(([, call]) => !call.settled)
    // A running command is killed and given a grace period before its output is collected.
    const winding = this.step !== null && open.some(([, call]) => call.started && call.effect !== "read")
    const grace = winding ? (this.options.graceMs ?? 600) : 60
    await sleep(this.real(grace))
    this.virtual += grace
    const cutShort = this.step !== null
    if (this.step !== null) {
      const messageId = this.step
      for (const [callId, call] of open) this.emitDurable(stopped(messageId, callId as CallId, call, this.now(), reason))
      this.emitDurable(event("step.failed", { messageId, error: { kind: "interrupted", reason }, usage: null }))
    }
    if (this.compaction !== null) this.emitDurable(event("compaction.failed", { messageId: this.compaction, error: { kind: "interrupted", reason } }))
    if (this.execution !== null) {
      // After a user cancel the model is always told; after a shutdown only when a response was cut short.
      if (reason === "user" || cutShort)
        this.emitDurable(
          event("synthetic.appended", {
            messageId: `s_interrupt_${this.seq + 1}` as MessageId,
            origin: "interrupt",
            content: text(reason === "user" ? "The user stopped the previous response before it finished." : "The previous response was cut short when the harness restarted."),
          }),
        )
      this.emitDurable(event("execution.interrupted", { executionId: this.execution, reason }))
    }
    // The script assumed the turn would finish; from here on it no longer matches the session.
    this.cursor = this.turns.length
  }

  private genericTurn(prompt: string): ScriptedTurn {
    this.generic += 1
    const n = this.generic
    const message = `u_demo_${n}` as MessageId
    const answer = `a_demo_${n}` as MessageId
    const execution = `exe_demo_${n}` as ExecutionId
    const usage = { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 24, reasoningTokens: 0 }
    const events: NewEvent[] = [
      event("inbox.enqueued", { messageId: message, origin: null, delivery: "steer", content: text(prompt === "" ? "(empty)" : prompt) }),
      event("execution.started", { executionId: execution }),
      event("inbox.delivered", { messageId: message }),
      event("step.started", { messageId: answer, attempt: 1, model: this.model }),
      event("text.ended", { messageId: answer, text: `This demo has no more scripted turns. Run \`${brand.binary} --demo list\` to pick another scenario.`, providerData: null }),
      event("step.ended", { messageId: answer, finish: "stop", usage }),
      event("execution.succeeded", { executionId: execution }),
    ]
    return { prompt, events: events.map((item) => ({ event: item, phaseStart: false })) }
  }

  // ---------------------------------------------------------------- emitting

  emitDurable(item: NewEvent, live = false): void {
    this.track(item, live)
    this.seq += 1
    const stored = { ...item, sessionId: this.id, seq: this.seq, time: this.now() } as StoredEvent
    this.emit(stored)
    // A stop asked for before the execution existed takes effect as soon as it does.
    if (item.type === "execution.started" || item.type === "execution.resumed") this.beginStop()
  }

  private emit(item: EngineEvent | EphemeralEvent): void {
    if (!this.closed) this.channel.push(item)
  }

  private track(item: NewEvent, live: boolean): void {
    if (!SESSION_SCOPED.has(item.type)) this.lastWork = item.type
    switch (item.type) {
      case "session.created":
        this.model = item.data.settings.model
        return
      case "settings.changed":
        this.model = item.data.model
        return
      case "inbox.enqueued":
        this.inbox.push({ id: item.data.messageId, delivery: item.data.delivery, text: promptText(item), live })
        return
      case "inbox.delivery_changed": {
        const found = this.inbox.find((entry) => entry.id === item.data.messageId)
        if (found !== undefined) found.delivery = item.data.delivery
        return
      }
      case "inbox.delivered":
      case "inbox.cancelled": {
        const index = this.inbox.findIndex((entry) => entry.id === item.data.messageId)
        if (index !== -1) this.inbox.splice(index, 1)
        return
      }
      case "execution.started":
      case "execution.resumed":
        this.execution = item.data.executionId
        this.interrupting = null
        return
      case "execution.interrupt_requested":
        this.interrupting = item.data.reason
        return
      case "execution.succeeded":
      case "execution.failed":
      case "execution.interrupted":
        this.execution = null
        this.interrupting = null
        this.unanswered = []
        return
      case "step.started":
        this.step = item.data.messageId
        this.calls = new Map()
        return
      case "step.ended":
        this.step = null
        this.unanswered = []
        return
      case "step.failed":
      case "step.refused":
        this.step = null
        return
      case "compaction.started":
        this.compaction = item.data.messageId
        return
      case "compaction.ended":
      case "compaction.failed":
        this.compaction = null
        return
      case "tool.called":
        this.calls.set(item.data.callId, { name: item.data.name, effect: null, started: false, settled: false, startedAt: 0, progress: "" })
        return
      case "tool.started": {
        const call = this.calls.get(item.data.callId)
        if (call !== undefined) {
          call.started = true
          call.effect = item.data.effect
          call.startedAt = this.now()
        }
        return
      }
      case "tool.settled": {
        const call = this.calls.get(item.data.callId)
        if (call !== undefined) call.settled = true
        return
      }
    }
  }

  private now(): number {
    return this.clockStart + Math.round(this.virtual)
  }

  private real(ms: number): number {
    return this.speed <= 0 ? 0 : ms / this.speed
  }

  /** Waits `ms` of script time (advancing the virtual clock by `virtualMs`). Resolves `false` once a stop is in effect. */
  private async wait(ms: number, virtualMs = ms): Promise<boolean> {
    if (this.stopping) return false
    this.virtual += virtualMs
    const real = this.real(ms)
    if (real > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, real)
        function done() {
          clearTimeout(timer)
          resolve()
        }
        this.wake = done
      })
    else await Promise.resolve()
    this.wake = null
    return !this.stopping
  }
}

/** The settled event the loop writes for a call it stops (cancel rule 4). */
function stopped(messageId: MessageId, callId: CallId, call: CallState, now: number, reason: InterruptReason): NewEvent {
  const settle = (outcome: "error" | "not_started" | "effect_unknown", output: string, display: NewEvent<"tool.settled">["data"]["display"] = null) =>
    event("tool.settled", { messageId, callId, outcome, output, truncation: null, attachments: [], display })
  if (!call.started) return settle("not_started", NOT_STARTED)
  switch (call.effect ?? "exec") {
    case "read":
      return settle("error", INTERRUPTED_READ)
    case "exec": {
      const seconds = Math.max(1, Math.round((now - call.startedAt) / 1000))
      const why = reason === "user" ? `Stopped by the user after ${seconds} s.` : "Stopped because the harness was shutting down."
      const output = `${why} Output so far:\n${call.progress === "" ? "(no output)" : call.progress}\n`
      return settle("error", output, { exitCode: null, signal: "SIGTERM", timedOut: false, interrupted: reason, durationMs: now - call.startedAt })
    }
    case "write":
    case "network":
      return settle("effect_unknown", EFFECT_UNKNOWN)
  }
}

/** Splits text the way a model streams it: a word or two at a time, keeping whitespace. */
function chunks(value: string): string[] {
  return value.match(/\S+\s*\S*\s*|\s+/g) ?? []
}

function openExecution(events: readonly Planned[]): ExecutionId | null {
  let open: ExecutionId | null = null
  for (const { event: item } of events) {
    if (item.type === "execution.started" || item.type === "execution.resumed") open = item.data.executionId
    if (item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted") open = null
  }
  return open
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
}

function promptText(item: NewEvent<"inbox.enqueued">): string {
  return item.data.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

/** A single-consumer async queue. */
class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: ((result: IteratorResult<T>) => void) | null = null
  private ended = false

  push(item: T): void {
    if (this.ended) return
    if (this.waiter !== null) {
      const waiter = this.waiter
      this.waiter = null
      waiter({ value: item, done: false })
    } else this.items.push(item)
  }

  close(): void {
    this.ended = true
    if (this.waiter !== null) {
      this.waiter({ value: undefined, done: true })
      this.waiter = null
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }
}
