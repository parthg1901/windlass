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
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../../src/brand.ts"
import { type CheckConfig, type Config, type ConfigFile, resolveConfig } from "../../src/config/schema.ts"
import type { NewEvent, SessionSettings, StoredEvent } from "../../src/event/durable.ts"
import type { EngineEvent } from "../../src/engine/channel.ts"
import type { Clock } from "../../src/engine/clock.ts"
import type { CompactionConfig } from "../../src/context/policy.ts"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { EngineLimits } from "../../src/engine/constants.ts"
import type { HooksSetup } from "../../src/engine/hooks.ts"
import type { LspSetup } from "../../src/engine/lsp.ts"
import type { McpSetup } from "../../src/engine/mcp.ts"
import type { MemorySetup } from "../../src/engine/memory.ts"
import type { SkillsSetup } from "../../src/engine/skills.ts"
import type { AgentsSetup } from "../../src/engine/agents.ts"
import type { CommandsSetup } from "../../src/engine/commands.ts"
import type { TelemetrySetup } from "../../src/engine/telemetry.ts"
import type { SpawnSettings } from "../../src/engine/spawn.ts"
import type { WakeSetup } from "../../src/engine/wake.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import type { ScriptedResponse } from "../../src/testing/fake-provider.ts"
import {
  type Diagnostic,
  type Engine,
  type EngineSession,
  type ModelOffer,
  type ProbePoint,
  type ResumeMode,
  createEngine,
} from "../../src/engine/engine.ts"
import type { WorkspaceSnapshots } from "../../src/engine/workspace.ts"
import type { ExecutionId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import { type InstructionSource, agentsSource, dateSource } from "../../src/instructions/source.ts"
import { interruptReasonOf } from "../../src/interrupt.ts"
import { blobRefs, encodeRequest } from "../../src/provider/openai-responses.ts"
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
      // As the standard file tools say it: a call touches the path it names.
      touches: (input: Record<string, unknown>) => (typeof input.path === "string" ? [input.path] : []),
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
  /** The context window the engine is told every model has, in tokens. Without one nobody knows it, and nothing is compacted ahead of time. */
  readonly contextWindow?: number
  /** The compaction policy's numbers, where a test needs others than the defaults. */
  readonly compaction?: Partial<CompactionConfig>
  /**
   * The approval layer. Without one it is off, as in every scenario that is
   * not about it: each call runs as it is and nothing about approval is recorded.
   */
  readonly approval?: ApprovalSetup
  /** Whether a person is there to answer questions, for the sessions this harness creates and opens. Default: nobody. */
  readonly attended?: boolean
  /** Whether that person also answers the questions of the session's subagents. */
  readonly attendedChildren?: boolean
  /** Subagents and background work. Without it the engine offers none, as in every scenario that is not about them. */
  readonly spawn?: Partial<SpawnSettings>
  /** Writes a snapshot of the scripted workspace into a directory, for a fork with a copy and a replay that runs tools. */
  readonly exportSnapshot?: (workspace: string, snapshot: string, into: string) => Promise<{ readonly files: number }>
  /** Skills. Without it the engine offers none, as in every scenario that is not about them. */
  readonly skills?: SkillsSetup
  /** MCP servers. Without it the engine offers none and starts none. */
  readonly mcp?: McpSetup
  /** Wake-ups. Without it the engine offers none; with `run` the engine fires them itself. */
  readonly wake?: WakeSetup
  /** Memory. Without it the engine offers none; with it a session gets it when its configuration turns the flag on. */
  readonly memory?: MemorySetup
  /** The user's own configuration file, apart from the project's (`config`): what the engine's features read from each. */
  readonly userConfig?: ConfigFile
  /** The directory the sessions work in. Default `/repo`, which does not exist: a test about real files names a real one. */
  readonly cwd?: string
  /** Real tools beside the scripted ones (the `todo` tool, which keeps no state and touches nothing). */
  readonly extraTools?: readonly AnyTool[]
  /** Agents. Without it the engine offers none, as in every scenario that is not about them. */
  readonly agents?: AgentsSetup
  /** Slash commands. Without it the engine offers none. */
  readonly commands?: CommandsSetup
  /** Live telemetry. Without it the engine exports nothing, whatever the configuration says. */
  readonly telemetry?: TelemetrySetup
  /** Hooks. Without it the engine runs none, whatever the configuration says. */
  readonly hooks?: HooksSetup
  /** Language-server diagnostics. Without it the engine starts no server. */
  readonly lsp?: LspSetup
  /** The models the provider lists, with the efforts each accepts, for the tests about settings. Without it nothing is checked. */
  readonly models?: readonly (string | ModelOffer)[]
}

export class Harness {
  readonly provider = new FakeProvider()
  readonly clock = new ManualClock()
  readonly tools: ScriptedTools
  readonly checks = new ScriptedChecks()
  readonly workspace: FakeWorkspace | null
  /** The configuration as it is on disk now. An execution reads it when it starts. */
  config: Config | null
  /** The two configuration files as they are on disk now, apart: the features' sections (`mcp`, `skills`, `wake`, `memory`). */
  files: { user: ConfigFile | null; project: ConfigFile | null }
  /** The date the instruction sources report: `[year, month, day]`. */
  date: [number, number, number] = [2026, 11, 12]
  /** AGENTS.md files on the scripted disk, by directory. One is a source once the session works in its directory. */
  readonly agents = new Map<string, string>()
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
  private readonly counters = { session: 0, message: 0, execution: 0, request: 0, spawn: 0 }
  private probes: ((point: ProbePoint) => void)[] = []
  private waiters: { predicate: (event: EngineEvent) => boolean; resolve: (event: EngineEvent) => void }[] = []
  private alive = false

  constructor(private readonly options: HarnessOptions = {}) {
    this.tools = options.tools ?? new ScriptedTools()
    this.workspace = options.workspace ?? null
    this.config = options.config === undefined ? null : resolveConfig(options.config)
    this.files = { user: options.userConfig ?? null, project: options.config ?? null }
    this.toolNames = Object.keys(this.tools.effects)
    this.directory = mkdtempSync(join(tmpdir(), "wl-engine-"))
    directories.push(this.directory)
    this.path = join(this.directory, "store.db")
    this.boot()
  }

  /** The directory the sessions of this harness work in. */
  get cwd(): string {
    return this.options.cwd ?? "/repo"
  }

  /** The data directory of the engines this harness boots. */
  get dataDir(): string {
    return this.directory
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
      tools: [...this.tools.list(this.toolNames), ...(this.options.extraTools ?? [])],
      dataDir: this.directory,
      workDir: join(this.directory, "work"),
      clock: this.clock,
      random: this.options.random ?? (() => 0),
      // The manual clock's sleeps take no time, so a wall-clock limit would end every model call at once.
      limits: { modelCallTimeoutMs: 0, compactionCallTimeoutMs: 0, ...this.options.limits },
      ...(this.options.contextWindow === undefined ? {} : { contextWindow: () => this.options.contextWindow! }),
      ...(this.options.compaction === undefined ? {} : { compaction: this.options.compaction }),
      snapshots: this.workspace === null ? null : this.workspace.open,
      approval: this.options.approval ?? null,
      loadConfig:
        this.options.config === undefined && this.options.userConfig === undefined
          ? null
          : async (cwd: string) => ({ config: this.config ?? resolveConfig({}), projectDir: this.projectDirOf(cwd), files: this.files }),
      // The same files, for what is read without waiting: the agent a session starts as, the approval mode before a first turn.
      loadConfigSync:
        this.options.config === undefined && this.options.userConfig === undefined
          ? null
          : (cwd: string) => ({ config: this.config ?? resolveConfig({}), projectDir: this.projectDirOf(cwd), files: this.files, approval: { user: this.files.user?.approval ?? null, project: this.files.project?.approval ?? null } }),
      ...(this.options.agents === undefined ? {} : { agents: this.options.agents }),
      ...(this.options.models === undefined ? {} : { listModels: async () => this.options.models! }),
      runChecks: this.checks.run,
      prompt: "You are a coding agent.",
      discover: (input): InstructionSource[] => [
        // As discovery does: the files of the directories the session has worked in, and the ones the model already has.
        ...[...new Set([...(input.directories ?? []).map((directory) => join(directory, "AGENTS.md")), ...(input.known ?? [])])]
          .sort()
          .flatMap((path) => {
            const content = this.agents.get(dirname(path))
            return content === undefined ? [] : [agentsSource(path, content)]
          }),
        dateSource(...this.date),
      ],
      ids: {
        session: () => `ses_${++this.counters.session}` as SessionId,
        message: () => `msg_${++this.counters.message}` as MessageId,
        execution: () => `exe_${++this.counters.execution}` as ExecutionId,
        request: () => `req_${++this.counters.request}` as RequestId,
        spawn: () => `bg_${++this.counters.spawn}`,
      },
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
      ...(this.options.skills === undefined ? {} : { skills: this.options.skills }),
      ...(this.options.mcp === undefined ? {} : { mcp: this.options.mcp }),
      ...(this.options.wake === undefined ? {} : { wake: this.options.wake }),
      ...(this.options.memory === undefined ? {} : { memory: this.options.memory }),
      ...(this.options.commands === undefined ? {} : { commands: this.options.commands }),
      ...(this.options.telemetry === undefined ? {} : { telemetry: this.options.telemetry }),
      ...(this.options.hooks === undefined ? {} : { commandHooks: this.options.hooks }),
      ...(this.options.lsp === undefined ? {} : { lsp: this.options.lsp }),
      ...(this.options.exportSnapshot === undefined ? {} : { exportSnapshot: this.options.exportSnapshot }),
      ...(this.options.refreshAuth === undefined ? {} : { refreshAuth: this.options.refreshAuth }),
      hooks: { probe: (point) => [...this.probes].forEach((probe) => probe(point)) },
      onDiagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
      log: () => {},
      strict: this.options.strict ?? true,
    })
  }

  /** Creates the session every test works in. */
  create(settings: SessionSettings = this.options.settings ?? { model: "gpt-test", reasoningEffort: "medium" }, agent?: string | null): EngineSession {
    return this.adopt(this.engine.createSession({ cwd: this.cwd, settings, ...(agent === undefined ? {} : { agent }) }))
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
    if (this.options.attended === true) session.setAttended(true, { children: this.options.attendedChildren === true })
    session.subscribe((item) => {
      this.seenEvents.push(item)
      const ready = this.waiters.filter((waiter) => waiter.predicate(item))
      this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter))
      for (const waiter of ready) waiter.resolve(item)
    })
    return session
  }

  /**
   * Where the project's file is for a session working in `cwd`, as the real loader finds it: in that directory
   * when the file is there on disk (a worktree has its own copy), else in the harness's directory (the file is
   * above a subdirectory, or the test never wrote one).
   */
  private projectDirOf(cwd: string): string {
    return existsSync(join(cwd, `.${brand.directory}`, "config.json")) ? cwd : this.cwd
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

  /** Resolves once the provider's call `index` (zero-based, across sessions) has sent its terminal event: the loop read everything before it. */
  async responded(index: number): Promise<void> {
    const over = () => this.provider.calls[index]?.events.some((item) => item.type === "finish" || item.type === "error") === true
    while (!over()) await new Promise((resolve) => setTimeout(resolve, 1))
  }

  /** Resolves the next time the loop reaches `point`. */
  reached(point: ProbePoint): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      this.probes.push((at) => {
        if (at !== point || done) return
        done = true
        resolve()
      })
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
    // The provider's own encoder accepts it, with the media the request refers to as the store holds it.
    const media = new Map(blobRefs(request).flatMap((ref) => [this.store.getBlob(ref.hash)].flatMap((blob) => (blob === null ? [] : [[ref.hash, blob.bytes] as const]))))
    expect(() => encodeRequest(request, media)).not.toThrow()
  }

  /** Ends the test's process cleanly. */
  async dispose(): Promise<void> {
    if (!this.alive) return
    await this.engine.close()
    this.store.close()
    this.alive = false
  }
}

/** The text of the first user message of a request: what tells one conversation from another when several call the model at once. */
export function firstPrompt(request: ModelRequest): string {
  const first = request.input.find((item) => item.type === "message" && item.role === "user")
  return first?.type === "message" ? first.content.map((part) => (part.type === "text" ? part.text : "")).join("") : ""
}

/**
 * Scripts the model per conversation, for tests in which a session and its
 * subagents call it at the same time: each call takes the next response of
 * the conversation whose first user message starts with one of the keys.
 */
export function converse(provider: FakeProvider, scripts: Record<string, readonly ScriptedResponse[]>): { readonly unused: () => number } {
  const queues = new Map(Object.entries(scripts).map(([key, responses]) => [key, [...responses]]))
  const total = [...queues.values()].reduce((sum, queue) => sum + queue.length, 0)
  const next: ScriptedResponse = (request, callIndex) => {
    const prompt = firstPrompt(request)
    const key = [...queues.keys()].find((candidate) => prompt.startsWith(candidate))
    const response = key === undefined ? undefined : queues.get(key)!.shift()
    if (response === undefined) throw new Error(`the test scripted no response for this call of the conversation that starts ${JSON.stringify(prompt.slice(0, 60))}`)
    return typeof response === "function" ? response(request, callIndex) : response
  }
  provider.enqueue(...Array.from({ length: total }, () => next))
  return { unused: () => [...queues.values()].reduce((sum, queue) => sum + queue.length, 0) }
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
 * - when an approval was given: `grantedAt` of the grants an answer created
 *   (the loop records its clock). The rule, the scope and the position
 *   (`at`) are compared.
 * - a compaction's sizes: `tokensBefore` and `tokensAfter` (the loop records
 *   its own estimates of the request before and after). The cut, the mode,
 *   the prompt, the repair and the checkpoint text are compared.
 * - other sessions (a fork's parent, a replay's recording, a subagent): each
 *   is named by the order of first appearance wherever its ID occurs, also
 *   inside a title or a tool result.
 * - a replay: the directory of its copy (a path under the data directory),
 *   and the report stored with `replay.ended` (the loop stores the whole
 *   divergence report). The outcome and the reason are compared.
 * - a subagent's result: the structured `display` data a client is given
 *   beside the text (the child's session, its steps and tool calls).
 * - a hook's record: how long it ran (`durationMs`).
 * - what a language server said about an edit: how long the result waited
 *   (`waitedMs`) and the fingerprint of the server's definition, which
 *   holds a path of this machine. The outcome and the counts are compared.
 */
export function comparable(events: readonly NewEvent[]): Plain[] {
  return others(events.map((item) => plain(item, events)).map(copies))
}

/** Names the other sessions a log mentions by order of first appearance. */
function others(events: Plain[]): Plain[] {
  const found: string[] = []
  const note = (id: unknown) => {
    if (typeof id === "string" && !found.includes(id)) found.push(id)
  }
  for (const item of events) {
    const lineage = (item.data as { lineage?: { parentSessionId?: string; sourceSessionId?: string } | null }).lineage
    note(lineage?.parentSessionId)
    note(lineage?.sourceSessionId)
    note((item.data as { work?: { sessionId?: string } }).work?.sessionId)
  }
  if (found.length === 0) return events
  return events.map((item) => ({ type: item.type, data: JSON.parse(found.reduce((json, id, index) => json.split(id).join(`S${index + 1}`), JSON.stringify(item.data))) as Record<string, unknown> }))
}

/** A replay's copy of the workspace and its stored report, as stand-ins. */
function copies(item: Plain): Plain {
  const lineage = (item.data as { lineage?: { kind?: string; policy?: string } | null }).lineage
  if (item.type === "session.created" && lineage?.kind === "replay" && lineage.policy !== "stop") return { type: item.type, data: { ...item.data, cwd: "<copy>" } }
  if (item.type === "replay.diverged") return { type: item.type, data: { ...item.data, workspace: "<copy>" } }
  if (item.type === "replay.ended") return { type: item.type, data: { ...item.data, report: null } }
  // What a client is given besides the text of a subagent's result (its session, its counts): the scenario writes the text.
  const display = (item.data as { display?: unknown }).display
  if (item.type === "tool.settled" && typeof display === "object" && display !== null && "subagent" in display) return { type: item.type, data: { ...item.data, display: null } }
  return item
}

function plain(item: NewEvent, events: readonly NewEvent[]): Plain {
  return labelled(events)[events.indexOf(item)]!
}

const labelledCache = new WeakMap<readonly NewEvent[], Plain[]>()
function labelled(events: readonly NewEvent[]): Plain[] {
  const known = labelledCache.get(events)
  if (known !== undefined) return known
  const made = label(events)
  labelledCache.set(events, made)
  return made
}

function label(events: readonly NewEvent[]): Plain[] {
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
    if ((item.type === "execution.succeeded" || item.type === "turn.ended") && "evidence" in item.data.verification)
      data.verification = { ...item.data.verification, evidence: plainEvidence(item.data.verification.evidence) }
    // When an approval was given is the loop's clock; a scenario writes a stand-in.
    if (item.type === "approval.answered") data.grants = item.data.grants.map((grant) => ({ ...grant, grantedAt: 0 }))
    if (item.type === "hook.ran") data.durationMs = 0
    if (item.type === "tool.settled" && item.data.diagnostics !== undefined)
      data.diagnostics = { ...item.data.diagnostics, waitedMs: 0, servers: item.data.diagnostics.servers.map((server) => ({ ...server, fingerprint: "" })) }
    if (item.type === "compaction.started") data.tokensBefore = 0
    if (item.type === "compaction.ended") {
      data.tokensAfter = 0
      // The results a compaction retired the images of are named by their message, like everything else.
      if (item.data.retired !== undefined) data.retired = item.data.retired.map((entry) => ({ ...entry, messageId: label("m", entry.messageId) }))
    }
    // The agent's instructions name the file that defines it, which is a real path in the loop and `/repo/...` in a
    // scenario, so its fingerprint is a stand-in here; a test compares it with the record.
    if (item.type === "baseline.set") return { type: item.type, data: { sources: item.data.sources.map((entry) => (entry.source === "agent" ? { ...entry, fingerprint: "<agent>" } : entry)) } }
    if (item.type === "instruction.appended") return { type: item.type, data: { messageId: data.messageId, source: data.source } }
    return { type: item.type, data }
  })
}

/** Check evidence without the values a scenario writes as stand-ins. */
function plainEvidence(evidence: VerificationEvidence) {
  return { ...evidence, afterSeq: 0, checks: evidence.checks.map((check) => ({ ...check, durationMs: 0, fingerprint: "", outputPath: null })) }
}
