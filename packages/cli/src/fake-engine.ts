/**
 * A fake engine that replays a scripted step-loop scenario with realistic
 * timing, so the CLI can run end to end before the real step loop exists.
 *
 * The scenario's durable events are replayed as written. Around them the fake
 * adds what a live engine would stream: text and reasoning deltas before each
 * `text.ended` / `reasoning.ended`, argument deltas before `tool.called`, and
 * progress while a command runs. `interrupt()` stops the replay and writes the
 * cancel sequence the step loop must write (cancel rules 3, 4 and 6): partial
 * text flushed, every recorded call settled once, the step failed as
 * interrupted, the marker, and `execution.interrupted`.
 *
 * A scenario is split into turns at the points where the session goes idle;
 * each `send` plays the next one. Once the script is used up (or diverged
 * because of an interrupt), `send` answers with a short generic turn.
 */
import {
  type CallId,
  type EphemeralEvent,
  type ExecutionId,
  type MessageId,
  type NewEvent,
  type SessionId,
  type StoredEvent,
  event,
  text,
} from "@light-harness/core"
// The scenarios and the loop's frozen wording live with the core tests; there is no package export for them yet.
import { EFFECT_UNKNOWN, INTERRUPTED_READ, NOT_STARTED, type Scenario } from "../../core/test/scenarios/script.ts"
import { brand } from "./brand.ts"
import type { Engine, EngineEvent, OpenRequest, Session } from "./engine.ts"

export interface FakeOptions {
  /** Playback speed: 1 is real time, 2 twice as fast, 0 instant (no waiting at all). */
  readonly speed?: number
  /** How long a stopped tool takes to wind down after an interrupt, in real-time milliseconds. */
  readonly graceMs?: number
  /** Start of the virtual clock that stamps event times. Default: the wall clock when the session opens. */
  readonly clockStart?: number
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
  // A script may stop with the execution still open (it ends "at next start-up"). Close it the way a process that
  // exits there would, as a shutdown that keeps the claim, so the turn ends instead of waiting forever.
  const open = openExecution(turns.at(-1)?.events ?? [])
  if (open !== null) turns.at(-1)!.events.push({ event: event("execution.interrupted", { executionId: open, reason: "shutdown" }), phaseStart: false })
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
  started: boolean
  settled: boolean
  startedAt: number
  progress: string
}

export class FakeSession implements Session {
  readonly events: AsyncIterable<EngineEvent>
  private readonly channel = new Channel<EngineEvent>()
  private seq = 0
  private virtual = 0
  private readonly clockStart: number
  private readonly speed: number
  private cursor = 0
  private playing: Promise<void> | null = null
  private interruptRequested = false
  private wake: (() => void) | null = null
  private closed = false
  private generic = 0
  // What the replay has written so far, for the cancel sequence.
  private execution: ExecutionId | null = null
  private step: MessageId | null = null
  private calls = new Map<string, CallState>()
  private partialText: { messageId: MessageId; sent: string } | null = null

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

  async send(prompt: string): Promise<MessageId | null> {
    if (this.closed || this.playing !== null) return null
    const turn = this.turns[this.cursor] ?? this.genericTurn(prompt)
    this.cursor = Math.min(this.cursor + 1, this.turns.length)
    const events = turn.events.map((planned, index) =>
      index === 0 && planned.event.type === "inbox.enqueued" && prompt.trim() !== ""
        ? { ...planned, event: event("inbox.enqueued", { ...planned.event.data, content: text(prompt) }) }
        : planned,
    )
    this.interruptRequested = false
    this.playing = this.play(events).finally(() => {
      this.playing = null
    })
    const first = events[0]?.event
    return first?.type === "inbox.enqueued" ? first.data.messageId : null
  }

  interrupt(): void {
    if (this.playing === null || this.interruptRequested) return
    this.interruptRequested = true
    this.wake?.()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.interrupt()
    await this.playing
    this.closed = true
    this.channel.close()
  }

  // ---------------------------------------------------------------- replay

  private async play(events: readonly Planned[]): Promise<void> {
    for (const [index, planned] of events.entries()) {
      if (planned.phaseStart && index > 0 && !(await this.wait(700))) return this.cancel()
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

  /** What the step loop writes when the user interrupts (see the cancel scenarios). */
  private async cancel(): Promise<void> {
    const tail: NewEvent[] = []
    if (this.partialText !== null && this.partialText.sent !== "")
      tail.push(event("text.ended", { messageId: this.partialText.messageId, text: this.partialText.sent, providerData: null }))
    this.partialText = null
    const open = [...this.calls.entries()].filter(([, call]) => !call.settled)
    // A running command is killed and given a grace period before its output is collected.
    const winding = open.some(([, call]) => call.started && effectOf(call.name) !== "read")
    await sleep(this.real(winding ? (this.options.graceMs ?? 600) : 60))
    this.virtual += winding ? (this.options.graceMs ?? 600) : 60
    if (this.step !== null) {
      const messageId = this.step
      for (const [callId, call] of open) tail.push(stopped(messageId, callId as CallId, call, this.now()))
      tail.push(event("step.failed", { messageId, error: { kind: "interrupted", reason: "user" }, usage: null }))
    }
    if (this.execution !== null) {
      tail.push(
        event("synthetic.appended", { messageId: `s_interrupt_${this.seq + 1}` as MessageId, origin: "interrupt", content: text("The user stopped the previous response before it finished.") }),
        event("execution.interrupted", { executionId: this.execution, reason: "user" }),
      )
    }
    for (const item of tail) this.emitDurable(item)
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
      event("step.started", { messageId: answer, attempt: 1, model: "demo" }),
      event("text.ended", { messageId: answer, text: `This demo has no more scripted turns. Run \`${brand.binary} --demo list\` to pick another scenario.`, providerData: null }),
      event("step.ended", { messageId: answer, finish: "stop", usage }),
      event("execution.succeeded", { executionId: execution }),
    ]
    return { prompt, events: events.map((item) => ({ event: item, phaseStart: false })) }
  }

  // ---------------------------------------------------------------- emitting

  emitDurable(item: NewEvent): void {
    this.track(item)
    this.seq += 1
    const stored = { ...item, sessionId: this.id, seq: this.seq, time: this.now() } as StoredEvent
    this.emit(stored)
  }

  private emit(item: EngineEvent | EphemeralEvent): void {
    if (!this.closed) this.channel.push(item)
  }

  private track(item: NewEvent): void {
    switch (item.type) {
      case "execution.started":
      case "execution.resumed":
        this.execution = item.data.executionId
        return
      case "execution.succeeded":
      case "execution.failed":
      case "execution.interrupted":
        this.execution = null
        return
      case "step.started":
        this.step = item.data.messageId
        this.calls = new Map()
        return
      case "step.ended":
      case "step.failed":
      case "step.refused":
        this.step = null
        return
      case "tool.called":
        this.calls.set(item.data.callId, { name: item.data.name, started: false, settled: false, startedAt: 0, progress: "" })
        return
      case "tool.started": {
        const call = this.calls.get(item.data.callId)
        if (call !== undefined) {
          call.started = true
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

  /** Waits `ms` of script time (advancing the virtual clock by `virtualMs`). Resolves `false` if interrupted. */
  private async wait(ms: number, virtualMs = ms): Promise<boolean> {
    if (this.interruptRequested) return false
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
    return !this.interruptRequested
  }
}

/** The settled event the loop writes for a call it stops (cancel rule 4). */
function stopped(messageId: MessageId, callId: CallId, call: CallState, now: number): NewEvent {
  const settle = (outcome: "error" | "not_started" | "effect_unknown", output: string, display: NewEvent<"tool.settled">["data"]["display"] = null) =>
    event("tool.settled", { messageId, callId, outcome, output, truncation: null, attachments: [], display })
  if (!call.started) return settle("not_started", NOT_STARTED)
  switch (effectOf(call.name)) {
    case "read":
      return settle("error", INTERRUPTED_READ)
    case "exec": {
      const seconds = Math.max(1, Math.round((now - call.startedAt) / 1000))
      const output = `Stopped by the user after ${seconds} s. Output so far:\n${call.progress === "" ? "(no output)" : call.progress}\n`
      return settle("error", output, { exitCode: null, signal: "SIGTERM", timedOut: false, interrupted: "user", durationMs: now - call.startedAt })
    }
    case "write":
      return settle("effect_unknown", EFFECT_UNKNOWN)
  }
}

function effectOf(name: string): "read" | "write" | "exec" {
  if (name === "read" || name === "ls" || name === "glob" || name === "grep") return "read"
  if (name === "write" || name === "edit") return "write"
  return "exec"
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
