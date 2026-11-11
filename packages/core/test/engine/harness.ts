/**
 * What the engine tests drive the real loop with: a real SQLite store in a
 * temporary directory, the scripted provider, scripted tools, a clock moved
 * by hand and counting IDs. Nothing here stands in for the loop itself.
 *
 * A "crash" is simulated in-process by closing the store under the engine:
 * from that moment nothing it does can reach the log, which is all a dead
 * process amounts to. A new store and a new engine are then opened on the
 * same file. (`crash.test.ts` does the same with a real process and SIGKILL.)
 */
import { expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NewEvent, SessionSettings, StoredEvent } from "../../src/event/durable.ts"
import type { EngineEvent } from "../../src/engine/channel.ts"
import type { Clock } from "../../src/engine/clock.ts"
import type { EngineLimits } from "../../src/engine/constants.ts"
import {
  type Diagnostic,
  type Engine,
  type EngineSession,
  type ProbePoint,
  type ResumeMode,
  createEngine,
} from "../../src/engine/engine.ts"
import type { ExecutionId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import { type InstructionSource, dateSource } from "../../src/instructions/source.ts"
import { encodeRequest } from "../../src/provider/openai-responses.ts"
import { buildRequest } from "../../src/request/build.ts"
import { type SqliteStore, openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider } from "../../src/testing/fake-provider.ts"
import type { AnyTool, ToolContext, ToolEffect, ToolResult } from "../../src/tool/tool.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"

// ---------------------------------------------------------------- clock

interface Sleeper {
  readonly ms: number
  readonly due: number
  readonly wake: () => void
}

/**
 * A clock moved by hand. With `auto` (the default) a sleep takes no time (it
 * returns on the next turn of the event loop) and only its length is
 * recorded; without it a sleep waits for `advance`.
 */
export class ManualClock implements Clock {
  time = Date.UTC(2026, 10, 12, 9, 0, 0)
  auto = true
  /** Every sleep asked for, in order. */
  readonly slept: number[] = []
  private readonly sleepers = new Set<Sleeper>()
  private readonly watchers: (() => void)[] = []

  now = () => this.time

  sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    this.slept.push(ms)
    if (signal?.aborted) return Promise.resolve()
    if (this.auto) {
      this.time += ms
      // After everything already runnable: a tool that reports at once must win against its own grace period.
      return new Promise((resolve) => setTimeout(resolve, 0))
    }
    return new Promise((resolve) => {
      const sleeper: Sleeper = {
        ms,
        due: this.time + ms,
        wake: () => {
          this.sleepers.delete(sleeper)
          signal?.removeEventListener("abort", sleeper.wake)
          resolve()
        },
      }
      this.sleepers.add(sleeper)
      signal?.addEventListener("abort", sleeper.wake, { once: true })
      for (const watcher of this.watchers.splice(0)) watcher()
    })
  }

  /** How many sleeps are waiting. */
  get pending(): number {
    return this.sleepers.size
  }

  /** Resolves once at least one sleep is waiting. */
  async waiting(): Promise<void> {
    while (this.sleepers.size === 0) await new Promise<void>((resolve) => this.watchers.push(resolve))
  }

  /** Moves time forward and wakes every sleep that is due. */
  advance(ms: number): void {
    this.time += ms
    for (const sleeper of [...this.sleepers]) if (sleeper.due <= this.time) sleeper.wake()
  }
}

// ---------------------------------------------------------------- tools

export type ToolBehaviour = (input: Record<string, unknown>, context: ToolContext) => string | ToolResult | Promise<string | ToolResult>

export const ok = (output: string): ToolResult => ({ status: "success", output, truncation: null, attachments: [], display: null })
export const failed = (output: string): ToolResult => ({ status: "error", output, truncation: null, attachments: [], display: null })

/** Resolves when the signal aborts. */
export const untilAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })))

/** Never resolves: a tool the process dies in, or one that ignores its abort signal. */
export const forever = () => new Promise<never>(() => {})

/** Scripted tools: each call takes the next behaviour queued for its tool. */
export class ScriptedTools {
  private readonly queues = new Map<string, ToolBehaviour[]>()
  /** Every call that ran, in order. */
  readonly ran: { name: string; input: Record<string, unknown> }[] = []

  constructor(readonly effects: Record<string, ToolEffect> = { read: "read", shell: "exec", write: "write" }) {}

  /** Queues behaviours for a tool. A string is a successful result with that output. */
  on(name: string, ...behaviours: (ToolBehaviour | string)[]): this {
    const queue = this.queues.get(name) ?? []
    queue.push(...behaviours.map((behaviour): ToolBehaviour => (typeof behaviour === "string" ? () => behaviour : behaviour)))
    this.queues.set(name, queue)
    return this
  }

  /** Behaviours queued and never used. */
  get unused(): number {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
  }

  list(names: readonly string[] = Object.keys(this.effects)): AnyTool[] {
    return names.map((name) => ({
      name,
      description: `The ${name} tool`,
      inputSchema: { type: "object" },
      effect: this.effects[name]!,
      execute: async (input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
        this.ran.push({ name, input })
        const behaviour = this.queues.get(name)?.shift()
        if (behaviour === undefined) throw new Error(`the test scripted no behaviour for this ${name} call`)
        const result = await behaviour(input, context)
        return typeof result === "string" ? ok(result) : result
      },
    })) as unknown as AnyTool[]
  }
}

// ---------------------------------------------------------------- harness

/** Thrown inside a probe to stop the engine's current path the way a kill would. */
export class Killed extends Error {
  constructor() {
    super("the test killed the process here")
    this.name = "Killed"
  }
}

const directories: string[] = []

/** Removes every temporary directory the harnesses made. Each test file registers it with `afterAll`. */
export function removeHarnessDirectories() {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}

export interface HarnessOptions {
  readonly limits?: Partial<EngineLimits>
  readonly tools?: ScriptedTools
  readonly settings?: SessionSettings
  readonly random?: () => number
  readonly refreshAuth?: () => Promise<boolean>
}

export class Harness {
  readonly provider = new FakeProvider()
  readonly clock = new ManualClock()
  readonly tools: ScriptedTools
  /** The date the instruction sources report: `[year, month, day]`. */
  date: [number, number, number] = [2026, 11, 12]
  /** Everything the engines reported. A test that expects none asserts on it. */
  readonly diagnostics: Diagnostic[] = []
  /** Every event published by any incarnation of the session, in order. */
  readonly seenEvents: EngineEvent[] = []
  store!: SqliteStore
  engine!: Engine
  session!: EngineSession
  /** Tool names of the build that is running. A restart may bring another set. */
  toolNames: readonly string[]
  private readonly directory: string
  private readonly path: string
  private readonly counters = { session: 0, message: 0, execution: 0, request: 0 }
  private probes: ((point: ProbePoint) => void)[] = []
  private waiters: { predicate: (event: EngineEvent) => boolean; resolve: (event: EngineEvent) => void }[] = []
  private alive = false

  constructor(private readonly options: HarnessOptions = {}) {
    this.tools = options.tools ?? new ScriptedTools()
    this.toolNames = Object.keys(this.tools.effects)
    this.directory = mkdtempSync(join(tmpdir(), "lh-engine-"))
    directories.push(this.directory)
    this.path = join(this.directory, "store.db")
    this.boot()
  }

  /** Opens the store and a fresh engine on it: a process start. */
  boot(): void {
    if (this.alive) throw new Error("the previous process is still alive: kill it or close it first")
    this.store = openSqliteStore({ path: this.path, now: () => this.clock.now() })
    this.alive = true
    this.probes = []
    this.engine = createEngine({
      store: this.store,
      provider: this.provider,
      tools: this.tools.list(this.toolNames),
      dataDir: this.directory,
      clock: this.clock,
      random: this.options.random ?? (() => 0),
      limits: this.options.limits ?? {},
      prompt: "You are a coding agent.",
      discover: (): InstructionSource[] => [dateSource(...this.date)],
      ids: {
        session: () => `ses_${++this.counters.session}` as SessionId,
        message: () => `msg_${++this.counters.message}` as MessageId,
        execution: () => `exe_${++this.counters.execution}` as ExecutionId,
        request: () => `req_${++this.counters.request}` as RequestId,
      },
      ...(this.options.refreshAuth === undefined ? {} : { refreshAuth: this.options.refreshAuth }),
      hooks: { probe: (point) => [...this.probes].forEach((probe) => probe(point)) },
      onDiagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
      log: () => {},
      strict: true,
    })
  }

  /** Creates the session every test works in. */
  create(settings: SessionSettings = this.options.settings ?? { model: "gpt-test", reasoningEffort: "medium" }): EngineSession {
    return this.adopt(this.engine.createSession({ cwd: "/repo", settings }))
  }

  /** Opens the session again, in the running process or after `boot`. */
  open(resume: ResumeMode = "start"): EngineSession {
    const id = this.session.id
    const before = this.store.getSession(id)!.lastSeq
    const session = this.engine.openSession(id, { resume })
    // What recovery appended while opening was published before anyone could subscribe.
    this.seenEvents.push(...this.store.readEvents(id, { afterSeq: before }))
    return this.adopt(session)
  }

  /** `boot` and `open`: the next start of the process. */
  restart(resume: ResumeMode = "start"): EngineSession {
    this.boot()
    return this.open(resume)
  }

  private adopt(session: EngineSession): EngineSession {
    this.session = session
    session.subscribe((item) => {
      this.seenEvents.push(item)
      const ready = this.waiters.filter((waiter) => waiter.predicate(item))
      this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter))
      for (const waiter of ready) waiter.resolve(item)
    })
    return session
  }

  /** Calls `action` at the `nth` time the loop reaches `point` in this process (1 is the first). */
  at(point: ProbePoint, nth: number, action: () => void): void {
    let count = 0
    this.probes.push((reached) => {
      if (reached !== point) return
      count += 1
      if (count === nth) action()
    })
  }

  /**
   * Kills the process: the store is closed, so nothing the engine still does
   * reaches the log. Inside a probe, follow it with `throw new Killed()` (or
   * use `dieAt`) so the engine's current path stops there too.
   */
  kill(): void {
    this.store.close()
    this.alive = false
  }

  /** Kills the process at the `nth` time the loop reaches `point`. */
  dieAt(point: ProbePoint, nth = 1): void {
    this.at(point, nth, () => {
      this.kill()
      throw new Killed()
    })
  }

  /** Resolves with the first event, already published or still to come, that matches. */
  seen(predicate: (event: EngineEvent) => boolean, from = 0): Promise<EngineEvent> {
    const past = this.seenEvents.slice(from).find(predicate)
    if (past !== undefined) return Promise.resolve(past)
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }))
  }

  /** Resolves once the streamed text deltas so far end with `value`. */
  async seenText(value: string): Promise<void> {
    const streamed = () =>
      this.seenEvents
        .flatMap((item) => (item.type === "text.delta" ? [item.text] : []))
        .join("")
        .endsWith(value)
    while (!streamed()) await this.seen((item) => item.type === "text.delta", this.seenEvents.length)
  }

  /** Resolves when no execution is being worked on. */
  settled(): Promise<void> {
    return this.session.settled()
  }

  /** The session's durable log. */
  log(): readonly StoredEvent[] {
    return this.store.readEvents(this.session.id)
  }

  /** The checks that hold after every scenario, whatever happened in it. */
  verify(): void {
    if (!this.alive) this.boot()
    const projection = expectRebuildEqualsLive(this.store, this.session.id)
    if (projection.baseline === null) return
    const request = buildRequest(projection, { toolChoice: "auto" })
    expect(danglingCalls(request.input)).toEqual([])
    expect(request.input.at(-1)?.type).not.toBe("reasoning")
    // The provider's own encoder accepts it.
    expect(() => encodeRequest(request, new Map())).not.toThrow()
  }

  /** Ends the test's process cleanly. */
  async dispose(): Promise<void> {
    if (!this.alive) return
    await this.engine.close()
    this.store.close()
    this.alive = false
  }
}

/**
 * What is wrong with the calls and results of a request's input: a result
 * without its call, a call asked twice before it was answered, a call that
 * was never answered. Call IDs repeat across steps, so the pairing is by position.
 */
export function danglingCalls(input: readonly { type: string; callId?: string }[]): string[] {
  const open = new Set<string>()
  const problems: string[] = []
  input.forEach((item, index) => {
    if (item.type === "tool_call") {
      if (open.has(item.callId!)) problems.push(`item ${index}: call ${item.callId} is asked again before it has a result`)
      open.add(item.callId!)
      return
    }
    if (item.type === "tool_result") {
      if (!open.delete(item.callId!)) problems.push(`item ${index}: result ${item.callId} has no call before it`)
      return
    }
    for (const callId of open) problems.push(`item ${index}: call ${callId} has no result before the next message`)
    open.clear()
  })
  for (const callId of open) problems.push(`call ${callId} has no result`)
  return problems
}

// ---------------------------------------------------------------- comparing logs

type Plain = { readonly type: string; readonly data: Record<string, unknown> }

/**
 * A log reduced to what a scenario fixes. IDs are replaced by the order in
 * which each first appears (`m1`, `m2`, ... for messages, `e1`, ... for
 * executions), so two logs compare equal when they have the same events
 * about the same things in the same order, whatever the IDs are. Positions
 * and times are left out.
 *
 * Values a scenario writes as stand-ins are left out too:
 * - `baseline.set`: `instructions` and `tools` (the scenario's baseline is a
 *   stub; the real one is the base prompt plus the rendered sources, and the
 *   engine's tool list). `sources` is compared.
 * - `instruction.appended`: `text` and `fingerprint` (the instructions module
 *   words the update and fingerprints the value). `source` is compared.
 */
export function comparable(events: readonly NewEvent[]): Plain[] {
  const labels = new Map<string, string>()
  const counts = { m: 0, e: 0 }
  const label = (kind: "m" | "e", id: string) => {
    const known = labels.get(`${kind}:${id}`)
    if (known !== undefined) return known
    const next = `${kind}${++counts[kind]}`
    labels.set(`${kind}:${id}`, next)
    return next
  }
  return events.map((item) => {
    const data: Record<string, unknown> = { ...(item.data as Record<string, unknown>) }
    if (typeof data.messageId === "string") data.messageId = label("m", data.messageId)
    if (typeof data.executionId === "string") data.executionId = label("e", data.executionId)
    if (item.type === "baseline.set") return { type: item.type, data: { sources: data.sources } }
    if (item.type === "instruction.appended") return { type: item.type, data: { messageId: data.messageId, source: data.source } }
    return { type: item.type, data }
  })
}
