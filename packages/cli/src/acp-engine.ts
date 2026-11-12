/**
 * The engine behind the CLI's `Engine` interface, reached through the Agent
 * Client Protocol: the CLI is an ACP client of the harness's own ACP server,
 * the same one editors start. Nothing here touches the engine directly; what
 * the protocol cannot carry, the CLI cannot do.
 *
 * The protocol client is the one every terminal client shares
 * (`@windlass/acp/client`): it starts `windlass acp` as a child process (or
 * the server in this process, `memory`), asks at `initialize` for every
 * harness event as `<prefix>/event` and for no standard updates, and routes
 * permission requests to the session they are about. This file only maps it
 * onto the CLI's `Engine` and `Session`:
 *
 * - `open`: `session/new` with the model, effort and approval settings in
 *   `_meta[<ns>]`; for `--session` and `--continue`, `<prefix>/resolve` names
 *   the session, then `session/resume` opens it (a crashed claim's recovery
 *   events arrive as live events before the answer).
 * - `send`: `<prefix>/steer` or `<prefix>/queue` with `maxSteps`, answered
 *   once the message is admitted. A turn ends for the CLI at its
 *   `execution.*` event, as on the direct path.
 * - `interrupt`: `session/cancel` (a pending approval question is answered
 *   `cancelled`).
 * - `revert` / `undoRevert`: `<prefix>/revert` / `<prefix>/undo_revert`; with
 *   `handEdits: "ask"` the server asks with `session/request_permission`,
 *   which is answered by the question's `confirm`.
 * - `close`: `session/close` with `_meta[<ns>].shutdown`: running work stops
 *   as a shutdown, and every event of it arrives before the answer. Then the
 *   connection is closed and the child leaves.
 * - `listSessions`: `session/list`; `listModels`: `<prefix>/models`. When the
 *   listing is all the run does (no session is open), the server is let go of
 *   after it; a server in use is never stopped by a listing.
 */
import { type ClientSession, HarnessConnection, ClientError, START_TIMEOUT_MS, openWhenReleased } from "@windlass/acp/client"
import {
  type AgentsResult,
  type CancelCallResult,
  type ClientCommand,
  type CommandsResult,
  type CompactResult,
  type DiffResult,
  EXT,
  type HooksStateResult,
  type LspStateResult,
  type McpStateResult,
  type MemoryChangeParams,
  type MemoryChangeResult,
  type MemoryStateResult,
  type ReplayResult,
  type SkillsResult,
  type WakeListResult,
  type WakeSecretResult,
  type WatchSetResult,
  type WatchesResult,
  titleFromEvents,
} from "@windlass/acp/extensions"
import { forkPointOfTurn, isUndone, turnsOf } from "@windlass/acp/turns"
import { type CallId, type HarnessOptions, type MessageId, type Question, type RevertResult, type SessionId, brand } from "@windlass/core"
import { selfCommand } from "./self.ts"
import {
  type Approver,
  type Engine,
  type EngineEvent,
  EngineUnavailable,
  type ForkOutcome,
  type ForkRequest,
  type HandEditQuestion,
  type ModelInfo,
  type OpenRequest,
  type ReplayCommand,
  type ReplayProgress,
  type SendOptions,
  type Session,
  type SessionDescription,
  type SessionRevertOptions,
  type SessionSummary,
  signInSentence,
} from "./engine.ts"

export interface AcpEngineOptions {
  /** `child` (the default) or `memory`. */
  readonly transport?: "child" | "memory"
  /** `child`: the command that serves ACP on stdio. Defaults to this Bun running this CLI's `acp` subcommand. */
  readonly command?: readonly string[]
  /** `child`: its environment. Defaults to this process's. */
  readonly env?: Record<string, string | undefined>
  /** `memory`: the harness the in-process server runs on. */
  readonly harness?: HarnessOptions
  /** Where the server's warnings and errors go, as the CLI's own lines (`windlass: ...`). Defaults to standard error. */
  readonly stderr?: (text: string) => void
  /** How long the server may take to answer `initialize`. */
  readonly startTimeoutMs?: number
  /** Sent as `clientInfo.version`. */
  readonly version?: string
}

export { START_TIMEOUT_MS }
/** Overrides `START_TIMEOUT_MS`, in milliseconds. */
export const START_TIMEOUT_ENV = `${brand.envPrefix}ENGINE_START_TIMEOUT_MS`

export function createAcpEngine(options: AcpEngineOptions = {}): Engine {
  let started: Promise<HarnessConnection> | null = null
  let opened = 0
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  const link = () =>
    (started ??= HarnessConnection.start({
      transport: options.transport === "memory" ? { kind: "memory", ...(options.harness === undefined ? {} : { harness: options.harness }) } : { kind: "child", command: options.command ?? selfCommand(["acp"]), env: options.env ?? process.env },
      clientInfo: { name: brand.binary, title: brand.name, version: options.version ?? "0.0.0" },
      // Only what the user should see: the server's warnings and errors, as the CLI's own lines.
      log: (line, level) => {
        if (level === "raw") stderr(`${line}\n`)
        else if (level === "warn" || level === "error") stderr(`${brand.binary}: ${line}\n`)
      },
      startTimeoutMs: options.startTimeoutMs ?? startTimeout(options.env ?? process.env),
    }).catch((error: unknown) => {
      throw unavailable(error)
    }))
  // A listing that is all the run does lets the server go after it; one in a run that opened a session leaves it be.
  const listing = async <T>(work: (connected: HarnessConnection) => Promise<T>): Promise<T> => {
    const connected = await link()
    try {
      return await work(connected)
    } finally {
      if (opened === 0 && connected.openSessions === 0) {
        await connected.stop()
        // What comes after it in the same run (a session opened for a prompt that turned out to be a command file's) starts a server again.
        if (started !== null && opened === 0) started = null
      }
    }
  }
  return {
    open: async (request) => {
      opened += 1
      try {
        return await openSession(await link(), request, stderr)
      } catch (error) {
        opened -= 1
        throw error
      }
    },
    listSessions: ({ cwd }) =>
      listing(async (connected) => {
        const rows = await connected.listSessions(cwd).catch((error: unknown) => {
          throw unavailable(error)
        })
        return rows.map((row): SessionSummary => ({ id: row.id as SessionId, title: row.title, cwd: row.cwd, updatedAt: row.updatedAt, model: row.model }))
      }),
    listModels: () =>
      listing(async (connected) => {
        const listed = await connected.listModels().catch((error: unknown) => {
          if (error instanceof ClientError && error.reason === "auth_required") throw new EngineUnavailable(signInSentence(error.message, "the models cannot be listed (they come from your ChatGPT plan)"), "auth")
          throw unavailable(error)
        })
        return listed.models.map((model): ModelInfo => ({ id: model.id, description: model.name === model.id ? null : model.name, efforts: model.efforts, isDefault: model.id === listed.defaultModel }))
      }),
    commands: (cwd, builtins) =>
      listing(async (connected) => {
        // A server from before command files has none to list.
        if (!connected.offers(EXT.commands)) return { available: false, commands: [], problems: [] }
        return connected.listCommands(cwd, builtins).catch((error: unknown) => {
          throw unavailable(error)
        })
      }),
    // A one-off: the server is let go of after it, as after a listing.
    fork: (request: ForkRequest): Promise<ForkOutcome> =>
      listing(async (connected) => {
        try {
          const named = request.session === null ? await connected.resolve(request.cwd) : await connected.resolveTyped(request.cwd, request.session)
          // A turn is where the user sees it: its event number, from the session's own log.
          let throughSeq = request.throughSeq
          if (request.turn != null) {
            const turns = turnsOf(await connected.storedEvents(named.sessionId))
            const point = forkPointOfTurn(turns, request.turn)
            if ("problem" in point) throw new EngineUnavailable(`${point.problem}${turnList(turns)}`, "usage")
            throughSeq = point.throughSeq
          }
          const forked = await connected.fork({
            sessionId: named.sessionId,
            ...(throughSeq === null ? {} : { throughSeq }),
            ...(request.copy === null ? {} : { workspace: request.copy.copyTo === null ? {} : { copyTo: request.copy.copyTo } }),
            ...(request.model === null ? {} : { model: request.model }),
            ...(request.effort === null ? {} : { effort: request.effort === "default" ? null : request.effort }),
            ...(request.title === null ? {} : { title: request.title }),
          })
          return { ...forked, named: named.sessionId }
        } catch (error) {
          throw unavailable(error)
        }
      }),
    replay: (request: ReplayCommand, progress: ReplayProgress): Promise<ReplayResult> =>
      listing(async (connected) => {
        try {
          const named = request.session === null ? await connected.resolve(request.cwd) : await connected.resolveTyped(request.cwd, request.session)
          let reading: Promise<void> = Promise.resolve()
          const result = await connected.replay(
            { sessionId: named.sessionId, ...request.params },
            {
              cwd: named.cwd,
              onStart: (session) => {
                progress.started(session.id, named.sessionId, () => session.cancel())
                reading = (async () => {
                  for await (const item of session.events) progress.event(item.event)
                })()
              },
            },
          )
          await reading
          return result
        } catch (error) {
          throw unavailable(error)
        }
      }),
  }
}

async function openSession(connected: HarnessConnection, request: OpenRequest, stderr: (text: string) => void): Promise<Session> {
  // Who is there to answer, and the user's own mode and unattended behaviour, said when the session is opened.
  const meta = { model: request.model, effort: request.effort, agent: request.agent ?? null, approval: request.approval ?? null, unattended: request.unattended ?? null, attended: request.attended ?? false }
  const target = request.session
  try {
    if (target.kind === "new") return new AcpSession(await connected.newSession(request.cwd, meta), request.maxSteps)
    const named = target.kind === "resume" ? await connected.resolveTyped(request.cwd, target.id) : await connected.resolve(request.cwd)
    // Right after an earlier run was killed its engine may still be closing the session: that is waited for, and said.
    const opened = await openWhenReleased(
      () => connected.openSession(named.sessionId, named.cwd, { replay: false, meta: { ...meta, archived: true } }),
      (pid) => stderr(`${brand.binary}: the session is still held by the engine of an earlier run that was stopped (pid ${pid}); waiting for it to finish shutting down…\n`),
    )
    return new AcpSession(opened, request.maxSteps)
  } catch (error) {
    throw unavailable(error)
  }
}

/** The CLI's session on a protocol session. A replay is history the CLI does not show; it never asks for one. */
class AcpSession implements Session {
  readonly id: SessionId
  readonly events: AsyncIterable<EngineEvent>
  private question: HandEditQuestion | null = null
  private approver: Approver | null = null
  private closing: Promise<void> | null = null

  constructor(
    private readonly session: ClientSession,
    private readonly maxSteps: number | null,
  ) {
    this.id = session.id as SessionId
    const source = session.events
    this.events = {
      async *[Symbol.asyncIterator]() {
        for await (const item of source) if (!item.replay) yield item.event
      },
    }
    session.approver = (ask) => {
      const approver = this.approver
      if (approver === null) return Promise.resolve(null)
      return approver({ messageId: ask.messageId as MessageId, callId: ask.callId as CallId, question: ask.question as Question, subagent: ask.subagent })
    }
    session.handEdits = async (ask) => {
      const question = this.question
      if (question === null) return null
      const answer = await question(ask.plan)
      return answer === "overwrite" || answer === "keep" ? answer : null
    }
  }

  async send(text: string, options: SendOptions = {}): Promise<MessageId | null> {
    if (this.session.gone) return null
    try {
      return (await this.session.send(text, { delivery: options.delivery ?? "steer", maxSteps: this.maxSteps })) as MessageId
    } catch (error) {
      if (this.session.gone) return null
      throw new Error(unavailable(error).message)
    }
  }

  commands(builtins: readonly ClientCommand[]): Promise<CommandsResult> {
    // A server from before command files has none to list.
    if (!this.session.offers(EXT.commands)) return Promise.resolve({ available: false, commands: [], problems: [] })
    return this.feature(EXT.commands, () => this.session.commands(builtins))
  }

  async sendCommand(name: string, args: string, options: SendOptions = {}): Promise<MessageId | null> {
    if (this.session.gone) return null
    try {
      return (await this.session.sendCommand(name, args, { delivery: options.delivery ?? "steer", maxSteps: this.maxSteps })).messageId as MessageId
    } catch (error) {
      if (this.session.gone) return null
      throw new Error(unavailable(error).message)
    }
  }

  interrupt(): void {
    this.session.cancel()
  }

  cancelCall(target: { readonly messageId: MessageId; readonly callId: CallId }): Promise<CancelCallResult> {
    return this.feature(EXT.cancelCall, () => this.session.cancelCall(target))
  }

  revert(options: SessionRevertOptions = {}): Promise<RevertResult> {
    return this.restore(false, options)
  }

  undoRevert(options: Omit<SessionRevertOptions, "messageId"> = {}): Promise<RevertResult> {
    return this.restore(true, options)
  }

  setApprover(approver: Approver | null): void {
    this.approver = approver
  }

  async clearTaint(): Promise<boolean> {
    if (this.session.gone) return false
    try {
      return await this.session.clearTaint()
    } catch (error) {
      throw new Error(unavailable(error).message)
    }
  }

  /** `/approval`: the session's approval mode, after setting `mode` when given. */
  async approvalMode(mode?: string): Promise<{ readonly mode: string | null; readonly tainted: boolean; readonly taint: string | null }> {
    try {
      if (mode !== undefined) await this.session.setConfig("approval", mode)
      const state = await this.session.approval()
      return { mode: state.mode, tainted: state.tainted, taint: state.taint }
    } catch (error) {
      throw new Error(unavailable(error).message)
    }
  }

  /** `/diff`: the files the latest turn changed, with their patches. */
  async diff(): Promise<DiffResult> {
    if (!this.session.offers(EXT.diff)) return { available: false, reason: "unavailable", message: "this server does not send per-file diffs" }
    try {
      return await this.session.diff()
    } catch (error) {
      throw new Error(unavailable(error).message)
    }
  }

  async mcp(): Promise<McpStateResult> {
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

  cancelWake(id: string): Promise<{ readonly cancelled: boolean; readonly message: string }> {
    return this.feature(EXT.wakeCancel, () => this.session.cancelWake(id))
  }

  wakeSecret(id: string): Promise<WakeSecretResult> {
    return this.feature(EXT.wakeSecret, () => this.session.wakeSecret(id))
  }

  watchOutput(command: string, watch: { readonly pattern: string; readonly regex?: boolean; readonly ignoreCase?: boolean; readonly limit?: number }): Promise<WatchSetResult> {
    return this.feature(EXT.watch, () => this.session.watchOutput(command, watch))
  }

  unwatchOutput(watchId: string): Promise<boolean> {
    return this.feature(EXT.unwatch, () => this.session.unwatchOutput(watchId))
  }

  watches(): Promise<WatchesResult> {
    return this.feature(EXT.watches, () => this.session.watches())
  }

  memory(): Promise<MemoryStateResult> {
    return this.feature(EXT.memory, () => this.session.memory())
  }

  memoryChange(params: Omit<MemoryChangeParams, "sessionId">): Promise<MemoryChangeResult> {
    return this.feature(EXT.memoryChange, () => this.session.memoryChange(params))
  }

  agents(): Promise<AgentsResult> {
    return this.feature(EXT.agents, () => this.session.agents())
  }

  setAgent(name: string): Promise<void> {
    return this.feature(EXT.agents, () => this.session.setAgent(name))
  }

  rename(title: string): Promise<string> {
    return this.feature(EXT.rename, () => this.session.rename(title))
  }

  compact(): Promise<CompactResult> {
    return this.feature(EXT.compact, () => this.session.compact())
  }

  /** A feature request, refused in one sentence by a server that does not offer it. */
  private async feature<T>(method: string, work: () => Promise<T>): Promise<T> {
    if (!this.session.offers(method)) throw new Error(`this engine does not offer ${method.replace(/^.*\//, "/")} (it may be another version)`)
    try {
      return await work()
    } catch (error) {
      throw new Error(unavailable(error).message)
    }
  }

  /** The title and the turns, from the stored log. */
  async describe(): Promise<SessionDescription> {
    const [state, events] = await Promise.all([this.session.state(), this.session.connection.storedEvents(this.id)])
    const turns = turnsOf(events)
    return { title: state.title ?? titleFromEvents(events), turns: turns.length, undone: turns.filter(isUndone).length, events, agent: state.agent ?? null, tasks: state.todos ?? null }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.session.close({ shutdown: true })
      await this.session.connection.stop()
    })()
    return this.closing
  }

  lost(): string | null {
    const gone = this.session.lost()
    if (gone === null) return null
    const said = gone.said === null ? "" : ` (${gone.said})`
    return `the engine process ${gone.how} in the middle of the session${said}; its work is recovered when the session is opened again: ${brand.binary} --session ${this.id}`
  }

  private async restore(undo: boolean, options: SessionRevertOptions): Promise<RevertResult> {
    const { confirm, handEdits, dryRun } = options
    const messageId = "messageId" in options ? options.messageId : undefined
    this.question = handEdits === "ask" ? (confirm ?? null) : null
    // The engine's own default, where the protocol's is to ask.
    const params = { ...(dryRun === undefined ? {} : { dryRun }), handEdits: handEdits ?? "abort" }
    try {
      return undo ? await this.session.undoRevert(params) : await this.session.revert({ ...params, ...(messageId === undefined ? {} : { messageId }) })
    } catch (error) {
      throw new Error(unavailable(error).message)
    } finally {
      this.question = null
    }
  }
}

/** The session's turns, one line each, for a `--turn` that names none of them. */
function turnList(turns: ReturnType<typeof turnsOf>): string {
  if (turns.length === 0) return ""
  const width = String(turns.length).length
  return `\nIts turns:\n${turns.map((turn) => `  ${String(turn.number).padStart(width)}  "${turn.prompt.split("\n")[0]!.slice(0, 60)}"${isUndone(turn) ? " (undone)" : ""}`).join("\n")}`
}

/** Refusals that say the command line asked for something wrong: an exit with the usage code. */
const USAGE_REASONS = new Set(["unknown_model", "unknown_effort", "ambiguous_session", "invalid_request"])

/** The error the CLI prints for something the server refused, or for the server being gone. */
function unavailable(error: unknown): EngineUnavailable {
  if (error instanceof EngineUnavailable) return error
  if (error instanceof ClientError && error.reason === "auth_required") return new EngineUnavailable(signInSentence(error.message), "auth")
  if (error instanceof ClientError && error.reason !== null && USAGE_REASONS.has(error.reason)) return new EngineUnavailable(error.message, "usage")
  return new EngineUnavailable(error instanceof Error ? error.message : String(error))
}

function startTimeout(env: Record<string, string | undefined>): number {
  const value = Number(env[START_TIMEOUT_ENV])
  return Number.isFinite(value) && value > 0 ? value : START_TIMEOUT_MS
}
