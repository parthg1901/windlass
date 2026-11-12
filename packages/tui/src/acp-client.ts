/**
 * The TUI as a client of the harness's own ACP server, through the protocol
 * client every terminal client shares (`@windlass/acp/client`): `windlass acp`
 * in a child process over stdio, asked at `initialize` for every harness
 * event and for no standard updates (the TUI renders the events itself).
 *
 * One connection serves the whole TUI run: the session picker lists sessions
 * and the model picker lists models on it, and switching sessions closes one
 * and opens another without a new server. `/reconnect` starts a new server
 * after one died.
 *
 * The server's standard error is handed to `onLog` line by line, so nothing
 * it writes lands on the TUI's screen. When the child dies, the open
 * session's events end and `lost()` says how, and how to resume.
 *
 * Calls, by feature:
 * - a new session: `session/new` with `_meta[<ns>] = { model, effort }`
 * - resume (`--session`, `--continue`, the picker): `<prefix>/resolve`, then
 *   `session/load`, which replays the stored log (events marked `replay`)
 * - a message: `<prefix>/steer` or `<prefix>/queue`; Ctrl-C: `session/cancel`,
 *   which also answers a pending approval question `cancelled`
 * - a tool call's approval: `session/request_permission` with
 *   `_meta[<ns>].approval`, answered by `onApproval` (with the note)
 * - undo, redo: `<prefix>/revert`, `<prefix>/undo_revert`, whose hand-edit
 *   question arrives as `session/request_permission`
 * - model, effort and approval mode: `session/set_config_option`; the mode
 *   and taint as they are: `<prefix>/approval`; `/clear-taint`:
 *   `<prefix>/clear_taint`
 * - per-file diffs: `<prefix>/diff`; how each turn ended, with the files it
 *   changed (also on a replay): `<prefix>/turn`
 * - the title: `<prefix>/session`; rename and compaction: `<prefix>/rename`
 *   and `<prefix>/compact`, only when `initialize` advertises them
 * - `/fork`: `<prefix>/fork`, then `session/load` of the fork
 * - a subagent's question: `session/request_permission` on the parent with
 *   `approval.subagent`; its activity: `child.event` in the events
 */
import { handEditChoices, signInReason } from "./cli.ts"
import { type ClientSession, ClientError, HarnessClient, openWhenReleased } from "@windlass/acp/client"
import { type ClientCommand, type CommandsResult, EXT, type MemoryChangeParams, type MemoryChangeResult, type WakeCreateParams, type WakeCreateResult } from "@windlass/acp/extensions"
import { handEditLines, handEditTitle } from "./features.ts"
import { type RevertResult, brand } from "@windlass/core"
import type { EngineEvent } from "./cli.ts"
import {
  type AgentsResult,
  type ApprovalHandler,
  type ApprovalInfo,
  type Backend,
  BackendError,
  type BackendSession,
  type CompactResult,
  type ConfigChoice,
  type Delivery,
  type DiffResult,
  type HooksStateResult,
  type LspStateResult,
  type McpStateResult,
  type MemoryStateResult,
  type SkillsResult,
  type WakeListResult,
  type WakeSecretResult,
  type ForkInfo,
  type ModelChoice,
  type OpenSettings,
  type OpenTarget,
  type QuestionHandler,
  type RevertOptions,
  type SessionChoice,
  type StreamItem,
} from "./backend.ts"

export { EventQueue } from "@windlass/acp/client"

/** The compaction method, should the server offer it. */
export const COMPACT_METHOD = EXT.compact
export const START_TIMEOUT_MS = 20_000

export interface AcpClientOptions {
  /** The command that serves ACP on stdio, such as `[bun, .../cli/src/main.ts, "acp"]`. */
  readonly command: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly version: string
  readonly startTimeoutMs?: number
}

export class AcpBackend implements Backend {
  readonly label = "acp"
  readonly restartable = true
  onQuestion: QuestionHandler = async () => null
  onApproval: ApprovalHandler = async () => null
  onLog: (line: string, level: "warn" | "error" | "info") => void = () => {}
  private readonly client: HarnessClient

  constructor(options: AcpClientOptions) {
    this.client = new HarnessClient({
      transport: { kind: "child", command: options.command, env: options.env },
      clientInfo: { name: `${brand.binary}-tui`, title: `${brand.name} TUI`, version: options.version },
      log: (line, level) => {
        if (level === "raw") return line.trim() === "" ? undefined : this.onLog(line, "warn")
        this.onLog(line, level === "error" ? "error" : level === "warn" ? "warn" : "info")
      },
      startTimeoutMs: options.startTimeoutMs ?? START_TIMEOUT_MS,
    })
  }

  /** Methods the server advertised at `initialize`. */
  get methods(): readonly string[] {
    return this.client.connected?.methods ?? []
  }

  async open(target: OpenTarget, cwd: string, settings: OpenSettings): Promise<BackendSession> {
    const link = await this.connect()
    const meta = { model: settings.model, effort: settings.effort, agent: settings.agent ?? null }
    try {
      if (target.kind === "new") return new AcpSession(this, await link.newSession(cwd, meta), settings.maxSteps)
      const named = target.kind === "resume" ? await link.resolveTyped(cwd, target.id) : await link.resolve(cwd)
      // Right after an earlier run was killed its engine may still be closing the session: that is waited for.
      const opened = await openWhenReleased(
        () => link.openSession(named.sessionId, named.cwd, { replay: true, meta: { ...meta, archived: true } }),
        (pid) => this.onLog(`the session is still held by the engine of an earlier run that was stopped (pid ${pid}); waiting for it to finish shutting down`, "info"),
      )
      return new AcpSession(this, opened, settings.maxSteps)
    } catch (error) {
      throw failure(error)
    }
  }

  async listSessions(cwd: string): Promise<SessionChoice[]> {
    const link = await this.connect()
    try {
      // This directory's sessions, and the forks of them that work in a copy of their own elsewhere.
      const here = await link.listSessions(cwd, { archived: true })
      const ids = new Set(here.map((row) => row.id))
      const elsewhere = (await link.listSessions(null, { archived: true }).catch(() => [])).filter((row) => row.cwd !== cwd && row.forkedFrom !== null && ids.has(row.forkedFrom))
      return [...here, ...elsewhere].sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (error) {
      throw failure(error)
    }
  }

  async listModels(): Promise<{ defaultModel: string; models: ModelChoice[] }> {
    const link = await this.connect()
    try {
      const listed = await link.listModels()
      return { defaultModel: listed.defaultModel, models: listed.models.map((model) => ({ ...model, isDefault: model.id === listed.defaultModel })) }
    } catch (error) {
      throw failure(error)
    }
  }

  async restart(): Promise<void> {
    try {
      await this.client.reconnect()
    } catch (error) {
      throw failure(error)
    }
  }

  stop(): Promise<void> {
    return this.client.stop()
  }

  private async connect() {
    try {
      return await this.client.connection()
    } catch (error) {
      throw failure(error)
    }
  }
}

class AcpSession implements BackendSession {
  readonly id: string
  readonly cwd: string
  readonly events: AsyncIterable<StreamItem>
  readonly compact?: () => Promise<CompactResult>
  readonly agents?: () => Promise<AgentsResult>
  readonly rename?: (title: string) => Promise<string>
  readonly cancelCall?: (target: { readonly messageId: string; readonly callId: string }) => Promise<{ readonly stopped: boolean; readonly message: string | null }>
  readonly fork?: (options: { readonly copy: boolean; readonly throughSeq?: number }) => Promise<ForkInfo>
  readonly storedEvents?: (sessionId: string) => Promise<readonly EngineEvent[]>
  readonly commands?: (builtins: readonly ClientCommand[]) => Promise<CommandsResult>
  readonly sendCommand?: (name: string, args: string, delivery: Delivery) => Promise<string | null>
  private closing: Promise<void> | null = null

  constructor(
    backend: AcpBackend,
    private readonly session: ClientSession,
    private readonly maxSteps: number | null,
  ) {
    this.id = session.id
    this.cwd = session.cwd
    const source = session.items
    this.events = {
      async *[Symbol.asyncIterator]() {
        for await (const item of source) {
          if ("event" in item) yield item
          else if (item.signal.kind === "turn") yield { turn: item.signal.turn, replay: item.signal.turn.replay === true }
        }
      },
    }
    session.approver = (ask, signal) => backend.onApproval(ask, signal)
    session.handEdits = async (ask) => {
      // What each answer does to the files edited by hand, as the line CLI says it: keep leaves the agent's changes in them too.
      const undo = ask.command === "revert"
      const them = ask.handEdited.length === 1 ? "it" : "them"
      const [overwrite, keep] = handEditChoices(undo, them).map((line) => line.replace(/^\s+[yk]\s+\w+: /, ""))
      const answer = await backend.onQuestion({
        title: handEditTitle(ask.plan.changes, undo, ask.title),
        // Who changed them, as far as the engine can tell, with the files; then what each answer does, whole (a
        // choice's own row is one line and would cut it).
        detail: [...handEditLines(ask.plan.changes, undo ? "since the turn" : "since the /undo"), "", `Overwrite: ${overwrite}`, `Keep: ${keep}`],
        options: [
          { id: "overwrite", label: "Overwrite", kind: "allow" },
          { id: "keep", label: "Keep", kind: "allow" },
          { id: "cancel", label: "Change nothing", kind: "reject" },
        ],
      })
      return answer === "overwrite" || answer === "keep" ? answer : null
    }
    if (session.offers(EXT.compact)) this.compact = () => this.call(() => session.compact())
    if (session.offers(EXT.events)) this.storedEvents = (sessionId) => this.call(() => session.connection.storedEvents(sessionId))
    if (session.offers(EXT.fork))
      this.fork = async ({ copy, throughSeq }) => {
        const forked = await this.call(() => session.connection.fork({ sessionId: session.id, ...(copy ? { workspace: {} } : {}), ...(throughSeq === undefined ? {} : { throughSeq }) }))
        return { sessionId: forked.sessionId, parentSessionId: forked.parentSessionId, cwd: forked.cwd, copiedFrom: forked.copiedFrom, title: forked.title }
      }
    if (session.offers(EXT.cancelCall)) this.cancelCall = (target) => this.call(() => session.cancelCall(target))
    if (session.offers(EXT.rename)) this.rename = (title) => this.call(() => session.rename(title))
    if (session.offers(EXT.agents)) this.agents = () => this.call(() => session.agents())
    if (session.offers(EXT.commands) && session.offers(EXT.sendCommand)) {
      this.commands = (builtins) => this.call(() => session.commands(builtins))
      this.sendCommand = async (name, args, delivery) => {
        if (session.gone) return null
        return (await this.call(() => session.sendCommand(name, args, { delivery, maxSteps: this.maxSteps }))).messageId
      }
    }
  }

  async send(text: string, delivery: Delivery): Promise<string | null> {
    if (this.session.gone) return null
    return this.call(() => this.session.send(text, { delivery, maxSteps: this.maxSteps }))
  }

  interrupt(): void {
    this.session.cancel()
  }

  revert(options: RevertOptions): Promise<RevertResult> {
    return this.call(() => this.session.revert(options))
  }

  undoRevert(options: RevertOptions): Promise<RevertResult> {
    return this.call(() => this.session.undoRevert(options))
  }

  async setConfig(id: "model" | "effort" | "approval" | "agent", value: string): Promise<void> {
    await this.call(() => this.session.setConfig(id, value))
  }

  configChoices(id: string): { readonly current: string | null; readonly choices: readonly ConfigChoice[] } | null {
    const option = this.session.configOptions.find((candidate) => candidate.id === id)
    if (option === undefined || option.type !== "select") return null
    const flat = option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    return { current: typeof option.currentValue === "string" ? option.currentValue : null, choices: flat.map((entry) => ({ value: entry.value, name: entry.name, description: entry.description ?? null })) }
  }

  async approval(): Promise<ApprovalInfo> {
    const state = await this.call(() => this.session.approval())
    return { enabled: state.enabled, mode: state.mode, tainted: state.tainted, taint: state.taint, sandboxUnavailable: state.sandboxUnavailable }
  }

  clearTaint(): Promise<boolean> {
    return this.call(() => this.session.clearTaint())
  }

  diff(params: { readonly executionId?: string; readonly endSeq?: number; readonly messageId?: string }): Promise<DiffResult> {
    if (!this.session.offers(EXT.diff)) return Promise.resolve({ available: false, reason: "unavailable", message: "this server does not send per-file diffs" })
    return this.call(() => this.session.diff(params))
  }

  async title(): Promise<string | null> {
    return (await this.call(() => this.session.state())).title
  }

  mcp(): Promise<McpStateResult> {
    return this.feature(EXT.mcp, () => this.session.mcp())
  }

  async approveMcp(name: string, fingerprint: string): Promise<boolean> {
    return (await this.feature(EXT.mcpApprove, () => this.session.approveMcp(name, fingerprint))).approved
  }

  onMcp(listener: (state: McpStateResult) => void): () => void {
    return this.session.onSignal((signal) => {
      if (signal.kind === "mcp") listener(signal.mcp)
    })
  }

  hooks(): Promise<HooksStateResult> {
    return this.feature(EXT.hooks, () => this.session.hooks())
  }

  async approveHook(fingerprint: string): Promise<boolean> {
    return (await this.feature(EXT.hookApprove, () => this.session.approveHook(fingerprint))).approved
  }

  onHooks(listener: (state: HooksStateResult) => void): () => void {
    return this.session.onSignal((signal) => {
      if (signal.kind === "hooks") listener(signal.hooks)
    })
  }

  lsp(): Promise<LspStateResult> {
    return this.feature(EXT.lsp, () => this.session.lsp())
  }

  async approveLsp(name: string, fingerprint: string): Promise<boolean> {
    return (await this.feature(EXT.lspApprove, () => this.session.approveLsp(name, fingerprint))).approved
  }

  onLsp(listener: (state: LspStateResult) => void): () => void {
    return this.session.onSignal((signal) => {
      if (signal.kind === "lsp") listener(signal.lsp)
    })
  }

  skills(): Promise<SkillsResult> {
    return this.feature(EXT.skills, () => this.session.skills())
  }

  wakeups(): Promise<WakeListResult> {
    return this.feature(EXT.wakeups, () => this.session.wakeups())
  }

  createWake(params: Omit<WakeCreateParams, "sessionId">): Promise<WakeCreateResult> {
    return this.feature(EXT.wakeCreate, () => this.session.createWake(params))
  }

  cancelWake(id: string): Promise<{ readonly cancelled: boolean; readonly message: string }> {
    return this.feature(EXT.wakeCancel, () => this.session.cancelWake(id))
  }

  wakeSecret(id: string): Promise<WakeSecretResult> {
    return this.feature(EXT.wakeSecret, () => this.session.wakeSecret(id))
  }

  watchOutput(command: string, watch: { readonly pattern: string; readonly regex?: boolean; readonly ignoreCase?: boolean; readonly limit?: number }) {
    return this.feature(EXT.watch, () => this.session.watchOutput(command, watch))
  }

  unwatchOutput(watchId: string): Promise<boolean> {
    return this.feature(EXT.unwatch, () => this.session.unwatchOutput(watchId))
  }

  watches() {
    return this.feature(EXT.watches, () => this.session.watches())
  }

  memory(): Promise<MemoryStateResult> {
    return this.feature(EXT.memory, () => this.session.memory())
  }

  memoryChange(params: Omit<MemoryChangeParams, "sessionId">): Promise<MemoryChangeResult> {
    return this.feature(EXT.memoryChange, () => this.session.memoryChange(params))
  }

  private feature<T>(method: string, work: () => Promise<T>): Promise<T> {
    if (!this.session.offers(method)) return Promise.reject(new BackendError(`this engine does not offer ${method.replace(/^.*\//, "/")} (it may be another version)`))
    return this.call(work)
  }

  close(shutdown: boolean): Promise<void> {
    this.closing ??= this.session.close({ shutdown })
    return this.closing
  }

  lost(): string | null {
    const gone = this.session.lost()
    if (gone === null) return null
    const said = gone.said === null ? "" : ` (${gone.said})`
    return `the engine process ${gone.how}${said}; its work is recovered when the session is opened again: /reconnect here, or ${brand.binary} tui --session ${this.id}`
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw failure(error)
    }
  }
}

/** The sentence for a refusal or for the server being gone. */
function failure(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  // The reason alone (`not signed in`); the TUI says how to sign in and how to carry on.
  if (error instanceof ClientError && error.reason === "auth_required") return new BackendError(signInReason(error.message), "auth_required")
  if (error instanceof ClientError) return new BackendError(error.message, error.reason)
  return new BackendError(error instanceof Error ? error.message : String(error))
}
