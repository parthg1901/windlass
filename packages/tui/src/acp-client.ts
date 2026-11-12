/**
 * The TUI as a client of the harness's own ACP server, through the protocol
 * client every terminal client shares (`@light-harness/acp/client`): `lh acp`
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
import { type ClientSession, ClientError, HarnessClient, openWhenReleased } from "@light-harness/acp/client"
import { EXT } from "@light-harness/acp/extensions"
import { type RevertResult, brand } from "@light-harness/core"
import type { EngineEvent } from "./cli.ts"
import {
  type ApprovalHandler,
  type ApprovalInfo,
  type Backend,
  BackendError,
  type BackendSession,
  type ConfigChoice,
  type Delivery,
  type DiffResult,
  type ForkInfo,
  type ModelChoice,
  type OpenSettings,
  type OpenTarget,
  type QuestionHandler,
  type RevertOptions,
  type SessionChoice,
  type StreamItem,
} from "./backend.ts"

export { EventQueue } from "@light-harness/acp/client"

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
    const meta = { model: settings.model, effort: settings.effort }
    try {
      if (target.kind === "new") return new AcpSession(this, await link.newSession(cwd, meta), settings.maxSteps)
      const named = await link.resolve(cwd, target.kind === "resume" ? target.id : undefined)
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
      return await link.listSessions(cwd, { archived: true })
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
  readonly compact?: () => Promise<void>
  readonly rename?: (title: string) => Promise<string>
  readonly fork?: (options: { readonly copy: boolean }) => Promise<ForkInfo>
  readonly storedEvents?: (sessionId: string) => Promise<readonly EngineEvent[]>
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
        title: ask.title,
        detail: [...ask.handEdited.map((path) => `· ${path}`), ""],
        options: [
          { id: "overwrite", label: `Overwrite: ${overwrite}`, kind: "allow" },
          { id: "keep", label: `Keep: ${keep}`, kind: "allow" },
          { id: "cancel", label: "Change nothing", kind: "reject" },
        ],
      })
      return answer === "overwrite" || answer === "keep" ? answer : null
    }
    if (session.offers(EXT.compact)) this.compact = () => this.call(() => session.compact())
    if (session.offers(EXT.events)) this.storedEvents = (sessionId) => this.call(() => session.connection.storedEvents(sessionId))
    if (session.offers(EXT.fork))
      this.fork = async ({ copy }) => {
        const forked = await this.call(() => session.connection.fork({ sessionId: session.id, ...(copy ? { workspace: {} } : {}) }))
        return { sessionId: forked.sessionId, cwd: forked.cwd, copiedFrom: forked.copiedFrom, title: forked.title }
      }
    if (session.offers(EXT.rename)) this.rename = (title) => this.call(() => session.rename(title))
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

  async setConfig(id: "model" | "effort" | "approval", value: string): Promise<void> {
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

  diff(params: { readonly executionId?: string; readonly messageId?: string }): Promise<DiffResult> {
    if (!this.session.offers(EXT.diff)) return Promise.resolve({ available: false, reason: "unavailable", message: "this server does not send per-file diffs" })
    return this.call(() => this.session.diff(params))
  }

  async title(): Promise<string | null> {
    return (await this.call(() => this.session.state())).title
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
