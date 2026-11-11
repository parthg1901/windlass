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
import { type CheckConfig, type Config, type ConfigFile, resolveConfig } from "../../src/config/schema.ts"
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
import type { WorkspaceSnapshots } from "../../src/engine/workspace.ts"
import type { ExecutionId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import { type InstructionSource, dateSource } from "../../src/instructions/source.ts"
import { interruptReasonOf } from "../../src/interrupt.ts"
import { encodeRequest } from "../../src/provider/openai-responses.ts"
import { buildRequest } from "../../src/request/build.ts"
import type { ChangeStatus, FileChange } from "../../src/snapshot/diff.ts"
import type { SkippedFile, SnapshotId, SnapshotUnavailable } from "../../src/snapshot/index.ts"
import { type SqliteStore, openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider } from "../../src/testing/fake-provider.ts"
import type { AnyTool, ToolContext, ToolEffect, ToolResult } from "../../src/tool/tool.ts"
import type { VerificationEvidence } from "../../src/verify/evidence.ts"
import type { CheckResult, CheckStatus, RunCheckOptions } from "../../src/verify/run.ts"
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

// ---------------------------------------------------------------- workspace

/**
 * A working tree that exists only in memory, with the snapshot operations
 * the loop uses. A snapshot ID is the hash of the tree, as with the real
 * module: equal contents, equal IDs. A test changes `files` where a tool or
 * a person would change a file.
 */
export class FakeWorkspace {
  /** The files, by path relative to the workspace. */
  readonly files = new Map<string, string>()
  /** What the next snapshots report as left out. */
  skipped: SkippedFile[] = []
  nestedRepositories: string[] = []
  /** Set to make `openSnapshots` report that there are none. */
  unavailable: SnapshotUnavailable | null = null
  /** Set to make every snapshot fail with this message. */
  broken: string | null = null
  /** Every operation asked for, in order. */
  readonly log: string[] = []
  private readonly trees = new Map<string, ReadonlyMap<string, string>>()

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.files.set(path, content)
  }

  readonly open = async (): Promise<WorkspaceSnapshots | SnapshotUnavailable> => this.unavailable ?? this.store

  /** The contents of snapshot `id`. */
  tree(id: string): Record<string, string> {
    return Object.fromEntries(this.trees.get(id) ?? [])
  }

  private capture(): SnapshotId {
    if (this.broken !== null) throw new Error(this.broken)
    const entries = [...this.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const id = new Bun.CryptoHasher("sha1").update(JSON.stringify(entries)).digest("hex")
    this.trees.set(id, new Map(entries))
    return id as SnapshotId
  }

  private diff(from: string, to: string): FileChange[] {
    const before = this.trees.get(from)
    const after = this.trees.get(to)
    if (before === undefined || after === undefined) throw new Error(`not a snapshot in this workspace: ${before === undefined ? from : to}`)
    const state = (content: string | undefined) => (content === undefined ? null : { kind: "file" as const, blob: content })
    return [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .filter((path) => before.get(path) !== after.get(path))
      .map((path) => {
        const status: ChangeStatus = !before.has(path) ? "added" : !after.has(path) ? "deleted" : "modified"
        return { path, status, before: state(before.get(path)), after: state(after.get(path)) }
      })
  }

  readonly store: WorkspaceSnapshots = {
    workspace: "/repo",
    take: async (options) => {
      this.log.push("take")
      return { id: this.capture(), session: options.session, takenAt: 0, skipped: this.skipped, nestedRepositories: this.nestedRepositories, durationMs: 0 }
    },
    changedFiles: async (from, to) => this.diff(from, to).map((change) => change.path),
    restore: async (target, options) => {
      this.log.push(options.dryRun ? "restore (dry run)" : `restore${options.paths === undefined ? "" : ` ${options.paths.join(",")}`}`)
      const before = this.capture()
      const only = options.paths === undefined ? null : new Set(options.paths)
      const changes = this.diff(before, target).filter((change) => only === null || only.has(change.path))
      if (!options.dryRun)
        for (const change of changes) {
          if (change.after === null) this.files.delete(change.path)
          else this.files.set(change.path, change.after.blob)
        }
      return { kind: options.dryRun ? "dry_run" : "restored", before, changes, kept: [] }
    },
  }
}

// ---------------------------------------------------------------- checks

export type CheckBehaviour = CheckStatus | ((check: CheckConfig, options: RunCheckOptions) => CheckStatus | Promise<CheckStatus>)

/** The result of a check as the real runner shapes it, with `output` as everything the command printed. */
export function checkResult(check: Pick<CheckConfig, "name" | "command" | "timeoutSeconds">, status: CheckStatus, output = ""): CheckResult {
  const bytes = new TextEncoder().encode(output)
  const lines = output === "" ? 0 : output.split("\n").length - (output.endsWith("\n") ? 1 : 0)
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

/** The text a scripted check prints when it fails. */
export const CHECK_OUTPUT = "1 fail\n"

/** Scripted checks: each run of a check takes the next behaviour queued for its name. A run stops at an interrupt, as the real one does. */
export class ScriptedChecks {
  private readonly queues = new Map<string, CheckBehaviour[]>()
  /** Every check that ran, in order. */
  readonly ran: string[] = []

  on(name: string, ...behaviours: CheckBehaviour[]): this {
    this.queues.set(name, [...(this.queues.get(name) ?? []), ...behaviours])
    return this
  }

  get unused(): number {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
  }

  readonly run = async (checks: readonly CheckConfig[], options: RunCheckOptions): Promise<CheckResult[]> => {
    const results: CheckResult[] = []
    for (const check of checks) {
      const stopped = () => ({ ...checkResult(check, "interrupted"), interruptedBy: interruptReasonOf(options.signal) })
      if (options.signal.aborted) {
        results.push(stopped())
        continue
      }
      this.ran.push(check.name)
      const behaviour = this.queues.get(check.name)?.shift()
      if (behaviour === undefined) throw new Error(`the test scripted no behaviour for this run of check ${check.name}`)
      const status = typeof behaviour === "string" ? behaviour : await behaviour(check, options)
      results.push(options.signal.aborted ? stopped() : checkResult(check, status, status === "passed" ? "" : CHECK_OUTPUT))
    }
    return results
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
  /** Whether a prefix violation throws. Defaults to `true`, as every test wants; `false` is what a user's session does. */
  readonly strict?: boolean
  /** A workspace the engine snapshots. Without one snapshots are off, as in every scenario that is not about them. */
  readonly workspace?: FakeWorkspace
  /** The configuration file of the project. Without one there is no configuration and nothing is verified. */
  readonly config?: ConfigFile
}

export class Harness {
  readonly provider = new FakeProvider()
  readonly clock = new ManualClock()
  readonly tools: ScriptedTools
  readonly checks = new ScriptedChecks()
  readonly workspace: FakeWorkspace | null
  /** The configuration as it is on disk now. An execution reads it when it starts. */
  config: Config | null
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
    this.workspace = options.workspace ?? null
    this.config = options.config === undefined ? null : resolveConfig(options.config)
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
      // The manual clock's sleeps take no time, so a wall-clock limit would end every model call at once.
      limits: { modelCallTimeoutMs: 0, ...this.options.limits },
      snapshots: this.workspace === null ? null : this.workspace.open,
      loadConfig: this.options.config === undefined ? null : async () => ({ config: this.config ?? resolveConfig({}), projectDir: "/repo" }),
      runChecks: this.checks.run,
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
      strict: this.options.strict ?? true,
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

  /** `boot` without opening the session: for a look at the log a dead process left. Returns the harness. */
  restartForLog(): this {
    this.boot()
    return this
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
 * - snapshot IDs: a scenario names workspace states (`w0`, `w1`), the loop
 *   records tree hashes. Both are replaced by the order of first appearance,
 *   so "the same state as before" and "a new state" are compared.
 * - check evidence: `afterSeq`, and per check `durationMs`, `fingerprint`
 *   and `outputPath` (see `evidence` in the scenario vocabulary).
 */
export function comparable(events: readonly NewEvent[]): Plain[] {
  const labels = new Map<string, string>()
  const counts = { m: 0, e: 0, w: 0 }
  const label = (kind: "m" | "e" | "w", id: string) => {
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
    if (item.type === "snapshot.taken") data.id = label("w", item.data.id)
    if (item.type === "revert.started" || item.type === "revert.undo_started") Object.assign(data, { target: label("w", item.data.target), before: label("w", item.data.before) })
    if ((item.type === "history.reverted" || item.type === "history.restored") && item.data.restore !== null) {
      const record = item.data.restore
      data.restore = { ...record, target: label("w", record.target), before: label("w", record.before), after: record.after === null ? null : label("w", record.after) }
    }
    if (item.type === "checks.finished") data.evidence = plainEvidence(item.data.evidence)
    if (item.type === "execution.succeeded" && "evidence" in item.data.verification)
      data.verification = { ...item.data.verification, evidence: plainEvidence(item.data.verification.evidence) }
    if (item.type === "baseline.set") return { type: item.type, data: { sources: data.sources } }
    if (item.type === "instruction.appended") return { type: item.type, data: { messageId: data.messageId, source: data.source } }
    return { type: item.type, data }
  })
}

/** Check evidence without the values a scenario writes as stand-ins. */
function plainEvidence(evidence: VerificationEvidence) {
  return { ...evidence, afterSeq: 0, checks: evidence.checks.map((check) => ({ ...check, durationMs: 0, fingerprint: "", outputPath: null })) }
}
