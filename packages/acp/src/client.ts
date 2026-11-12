/**
 * The client side of the harness's own ACP server, shared by every terminal
 * client (the line-based CLI and the TUI): it starts the server or connects
 * to one, negotiates the full-fidelity extension (every harness event as
 * `<prefix>/event`), and exposes sessions, prompts, steering and queueing,
 * cancel, config options, listings, undo and redo, permission answering, the
 * extension methods and reconnection, with typed events.
 *
 * It lives in this package because it is the protocol's other half: it
 * depends on the SDK and on `extensions.ts` (and on the engine's types, for
 * the events), never on a client. The CLI and the TUI depend on it; nothing
 * here depends on them, so there is no cycle.
 *
 * Two transports reach the same server:
 * - `child`: `lh acp` as a child process over stdio, in its own process group
 *   (a Ctrl-C at the terminal is the client's to turn into a cancel). It
 *   leaves when its stdin closes, which also happens when the client dies.
 *   Its stderr is parsed into log lines for the client to show or drop.
 * - `memory`: the server in this process over in-memory streams, for tests
 *   and debugging. Messages are copied as JSON, as the wire would.
 *
 * A connection serves any number of sessions. Listing sessions or models
 * never stops it; `stop()` does, once its owner is done.
 */
import {
  type ClientConnection,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type Stream,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk"
import { readFileSync } from "node:fs"
import type { EphemeralEvent, HarnessOptions, Need, RevertPlan, RevertResult, RunDecision, StoredEvent } from "@light-harness/core"
import { brand } from "@light-harness/core"
import {
  APPROVAL_META,
  type ApprovalStateResult,
  type DiffParams,
  type DiffResult,
  EXT,
  type ForkParams,
  type ForkResult,
  META,
  type OpenMeta,
  type ReplayParams,
  type ReplayResult,
  type RevertParams,
  type StateNotification,
  type TurnNotification,
  type UsageNotification,
} from "./extensions.ts"

const NS = META.capabilities

/** One item of a session's event stream: a harness event as the engine produced it. Durable and ephemeral types are disjoint. */
export type HarnessEvent = StoredEvent | EphemeralEvent

export interface EventItem {
  readonly event: HarnessEvent
  /** Part of the stored history a `session/load` replays: history to show, never live. */
  readonly replay: boolean
}

/** An event, or a notification about the session, in the order the server sent them (`ClientSession.items`). */
export type SessionItem = EventItem | { readonly signal: SessionSignal }

/** The extension notifications a session receives besides its events, typed. */
export type SessionSignal =
  | { readonly kind: "turn"; readonly turn: TurnNotification }
  | { readonly kind: "state"; readonly state: StateNotification }
  | { readonly kind: "usage"; readonly usage: UsageNotification }
  | { readonly kind: "taint"; readonly tainted: boolean; readonly text: string | null; readonly replay: boolean }
  | { readonly kind: "notice"; readonly notice: string; readonly message: string }
  | { readonly kind: "diagnostic"; readonly diagnostic: string; readonly message: string }
  | { readonly kind: "update"; readonly update: SessionNotification["update"] }

/** A tool call's approval question, as the server puts it (`session/request_permission` with `_meta[<ns>].approval`). */
export interface ApprovalAsk {
  readonly sessionId: string
  /** The call the client already shows: `<message>/<call>`. */
  readonly toolCallId: string
  readonly messageId: string
  readonly callId: string
  readonly question: {
    readonly title: string
    /** The command, path or tool, verbatim. */
    readonly subject: string
    readonly details: readonly string[]
    readonly choices: readonly { readonly id: string; readonly label: string; readonly approve: boolean; readonly remembers: string | null }[]
  }
  /** What the question is about. */
  readonly needs: readonly Need[]
  /** How the call runs if approved. */
  readonly then: RunDecision
  /** Who asks, when a subagent does: its label (the first line of its task). `null` for the session's own agent (or a server that does not say). */
  readonly subagent: string | null
  /** The asking subagent's own session, when the server names it. The call (`messageId`, `callId`) is that session's. */
  readonly subagentSessionId: string | null
}

/** The answer to an approval question: one of its choices, and a note for the model. */
export interface ApprovalAnswer {
  readonly choice: string
  readonly note?: string
}

/** The hand-edit question of an undo or redo (`_meta[<ns>].plan`). */
export interface HandEditAsk {
  readonly sessionId: string
  readonly title: string
  readonly command: "revert" | "undo_revert"
  readonly plan: RevertPlan
  readonly handEdited: readonly string[]
  readonly detail: readonly string[]
}

export type Transport =
  | {
      readonly kind: "child"
      /** The command that serves ACP on stdio, such as `[bun, .../cli/src/main.ts, "acp"]`. */
      readonly command: readonly string[]
      readonly env: Record<string, string | undefined>
    }
  | {
      readonly kind: "memory"
      /** The harness the in-process server runs on. */
      readonly harness?: HarnessOptions
    }

/** A line the server logged: its own lines with their level, anything else (a crash's stack) as `raw`. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "raw"

export interface ConnectOptions {
  readonly transport: Transport
  readonly clientInfo: { readonly name: string; readonly title: string; readonly version: string }
  readonly log?: (line: string, level: LogLevel) => void
  /** How long the server may take to answer `initialize`. Default `START_TIMEOUT_MS`. */
  readonly startTimeoutMs?: number
  /** Also send the standard `session/update`s (default `false`: the client renders the events and needs none). */
  readonly updates?: boolean
}

/** How long a cancel waits for the server's interrupt before it answers a pending question `cancelled` anyway. */
const CANCEL_ANSWER_MS = 1000

/** How long a server may take to start and answer `initialize`. */
export const START_TIMEOUT_MS = 20_000

/** How the server went away: `how` completes "the engine process ..."; `said` is the last line it logged, if it failed. */
export interface Gone {
  readonly how: string
  readonly said: string | null
}

/** A refusal or a failure, with the server's reason when it gave one (`data[<ns>].reason`). */
export class ClientError extends Error {
  constructor(
    message: string,
    /** `auth_required`, `session_in_use`, `session_not_found`, ... (`ErrorData.reason`); `closed` when the server is gone or never started; `null` otherwise. */
    readonly reason: string | null = null,
    readonly holderPid: number | null = null,
  ) {
    super(message)
    this.name = "ClientError"
  }
}

/** One listed session. The title is the session's own, or derived from its first message by the server. */
export interface SessionListing {
  readonly id: string
  readonly title: string | null
  readonly cwd: string
  readonly updatedAt: number
  readonly model: string
  readonly effort: string | null
  readonly archived: boolean
}

export interface ModelListing {
  readonly defaultModel: string
  readonly models: readonly { readonly id: string; readonly name: string; readonly efforts: readonly string[]; readonly defaultEffort: string | null; readonly contextWindow: number | null }[]
}

/** Result of `<prefix>/session`. */
export interface SessionStateResult {
  readonly sessionId: string
  readonly state: "running" | "idle" | "suspended"
  readonly cwd: string
  readonly title: string | null
  readonly model: string
  readonly effort: string | null
  readonly archived: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
}

interface Transported {
  readonly stream: Stream
  /** Resolves with how the server went, once it has. Never rejects. */
  readonly gone: Promise<Gone>
  stop(): Promise<void>
  kill(): void
}

/** One connection to the server. */
export class HarnessConnection {
  private readonly sessions = new Map<string, ClientSession>()
  /** Events and signals for a session whose open has not been answered yet. */
  private readonly early = new Map<string, ((session: ClientSession) => void)[]>()
  private stopping: Promise<void> | null = null
  private lostReason: Gone | null = null
  private offered: { methods: readonly string[]; notifications: readonly string[] } = { methods: [], notifications: [] }
  /** Replays this connection asked for whose session is not known yet, by the `ref` they were started with. */
  private readonly replays = new Map<string, { readonly cwd: string; readonly onStart: (session: ClientSession) => void }>()
  private nextRef = 1
  readonly connection: ClientConnection
  /** Resolves once the connection has ended, asked to or not. */
  readonly ended: Promise<void>

  private constructor(private readonly transport: Transported) {
    this.connection = client({ name: brand.binary })
      .onNotification(EXT.event, parseEventParams, ({ params }) => this.route(params.sessionId, (session) => session.push({ event: params.event, replay: params.replay === true })))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.permission(params))
      .onNotification(methods.client.session.update, ({ params }) => this.route(params.sessionId, (session) => session.signal({ kind: "update", update: params.update })))
      .onNotification("*", ({ method, params }) => this.extension(method, params))
      .connect(transport.stream)
    this.ended = this.connection.closed
      .catch(() => {})
      .then(() => this.onClosed())
  }

  static async start(options: ConnectOptions): Promise<HarnessConnection> {
    // Until the server is ready, what it writes that is not one of its own log lines (a crash's source excerpt and
    // stack, Bun's banner) is held back: if it dies at start the user gets one sentence, not the dump.
    let held: [string, LogLevel][] | null = []
    const log = (line: string, level: LogLevel) => {
      if (held !== null && level === "raw") held.push([line, level])
      else options.log?.(line, level)
    }
    const transport = options.transport.kind === "memory" ? await memoryTransport(options.transport, log) : childTransport(options.transport, log)
    const link = new HarnessConnection(transport)
    const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const failed = (message: string) => new ClientError(message, "closed")
    const goneText = (gone: Gone) => (gone.said === null ? `the engine process ${gone.how} before it was ready` : `the engine could not start: ${gone.said} (its process ${gone.how})`)
    try {
      const init = await Promise.race([
        link.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { _meta: { [NS]: { events: true, updates: options.updates === true } } },
          clientInfo: { ...options.clientInfo },
        }),
        transport.gone.then((gone) => {
          throw failed(goneText(gone))
        }),
        new Promise<never>((_, reject) => {
          const seconds = timeoutMs < 10_000 ? (timeoutMs / 1000).toFixed(1) : String(Math.round(timeoutMs / 1000))
          timer = setTimeout(() => reject(failed(`the engine process did not start within ${seconds} s; giving up`)), timeoutMs)
        }),
      ])
      const offered = init.agentCapabilities?._meta?.[NS] as { notifications?: unknown; methods?: unknown } | undefined
      const names = (value: unknown) => (Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [])
      if (!names(offered?.notifications).includes(EXT.event)) throw failed(`the engine process does not send ${brand.name}'s events (${EXT.event}); it may be another version`)
      link.offered = { methods: names(offered?.methods), notifications: names(offered?.notifications) }
      const early = held
      held = null
      for (const [line, level] of early) options.log?.(line, level)
      return link
    } catch (error) {
      held = null
      // The connection closes a moment before the process is reaped: an exit is the better explanation.
      const gone = error instanceof ClientError ? null : await Promise.race([transport.gone, Bun.sleep(1000).then(() => null)])
      transport.kill()
      await link.stop()
      if (error instanceof ClientError) throw error
      if (gone !== null) throw failed(goneText(gone))
      throw failed(`the engine process did not answer as expected: ${describe(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Extension methods the server advertised at `initialize`. */
  get methods(): readonly string[] {
    return this.offered.methods
  }

  offers(method: string): boolean {
    return this.offered.methods.includes(method)
  }

  /** Whether the connection is unusable: stopped, or the server went away. */
  get gone(): boolean {
    return this.lostReason !== null || this.stopping !== null
  }

  /** How the server went away on its own, or `null`. */
  get lost(): Gone | null {
    return this.lostReason
  }

  /** Sessions open on this connection. */
  get openSessions(): number {
    return this.sessions.size
  }

  get agent() {
    return this.connection.agent
  }

  /** `session/new` with `meta` (model, effort, approval, unattended, attended) under the namespace. */
  async newSession(cwd: string, meta: OpenMeta = {}): Promise<ClientSession> {
    // The events of the new session (`session.created`) arrive before the answer: they wait in `early`.
    const created = await this.call(() => this.agent.request(methods.agent.session.new, { cwd, mcpServers: [], _meta: { [NS]: { ...meta } } }))
    const session = this.attach(created.sessionId, cwd)
    session.configOptions = created.configOptions ?? []
    return session
  }

  /** `<prefix>/resolve`: the session an ID or a unique start of one names, or the latest in `cwd`. */
  resolve(cwd: string, session?: string): Promise<{ sessionId: string; cwd: string }> {
    return this.request<{ sessionId: string; cwd: string }>(EXT.resolve, { cwd, ...(session === undefined ? {} : { session }) })
  }

  /** `session/load` (`replay`: the stored log arrives first, marked) or `session/resume`. */
  async openSession(sessionId: string, cwd: string, options: { readonly replay: boolean; readonly meta?: OpenMeta }): Promise<ClientSession> {
    // Attached before the answer, so that the replay and the recovery events that come with it have a place to go.
    const session = this.attach(sessionId, cwd)
    try {
      const method = options.replay ? methods.agent.session.load : methods.agent.session.resume
      const opened = await this.call(() => this.agent.request(method, { sessionId, cwd, mcpServers: [], _meta: { [NS]: { ...options.meta } } }))
      session.configOptions = opened.configOptions ?? []
      return session
    } catch (error) {
      this.forget(sessionId)
      session.end()
      throw error
    }
  }

  /** `session/list`, every page. Never stops the server. */
  async listSessions(cwd: string, options: { readonly archived?: boolean } = {}): Promise<SessionListing[]> {
    const rows: SessionListing[] = []
    let cursor: string | undefined
    do {
      const page = await this.call(() =>
        this.agent.request(methods.agent.session.list, { cwd, ...(cursor === undefined ? {} : { cursor }), ...(options.archived === true ? { _meta: { [NS]: { archived: true } } } : {}) }),
      )
      for (const info of page.sessions) {
        const meta = info._meta?.[NS] as { model?: string; effort?: string | null; archived?: boolean } | undefined
        rows.push({ id: info.sessionId, title: info.title ?? null, cwd: info.cwd, updatedAt: Date.parse(info.updatedAt ?? ""), model: meta?.model ?? "", effort: meta?.effort ?? null, archived: meta?.archived === true })
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return rows
  }

  /** `<prefix>/models`, asked for afresh. Never stops the server. */
  async listModels(): Promise<ModelListing> {
    const listed = await this.request<ModelListing>(EXT.models, {})
    return { defaultModel: listed.defaultModel, models: listed.models.map((model) => ({ ...model, defaultEffort: model.defaultEffort ?? null, contextWindow: model.contextWindow ?? null })) }
  }

  /** `<prefix>/events`: a session's stored log, also of one another process holds. */
  async storedEvents(sessionId: string, range: { readonly afterSeq?: number; readonly limit?: number } = {}): Promise<StoredEvent[]> {
    return (await this.request<{ events: StoredEvent[] }>(EXT.events, { sessionId, ...range })).events
  }

  unarchive(sessionId: string): Promise<void> {
    return this.request(EXT.unarchive, { sessionId }).then(() => undefined)
  }

  /** `<prefix>/fork`: a new session with another's history up to a step boundary. Nothing is opened: `openSession` the result to work in it. */
  fork(params: ForkParams): Promise<ForkResult> {
    return this.request<ForkResult>(EXT.fork, { ...params })
  }

  /**
   * `<prefix>/replay`: replays a recorded session and resolves with the
   * report once it is over. `onStart` gets the replay session as soon as the
   * server names it: its `events` are the replay's progress, and its
   * `cancel()` ends the replay as incomplete. It ends with the replay.
   */
  async replay(params: Omit<ReplayParams, "ref">, options: { readonly cwd?: string; readonly onStart?: (session: ClientSession) => void } = {}): Promise<ReplayResult> {
    const ref = `r${this.nextRef++}`
    let started: ClientSession | null = null
    this.replays.set(ref, {
      cwd: options.cwd ?? "",
      onStart: (session) => {
        started = session
        options.onStart?.(session)
      },
    })
    try {
      return await this.request<ReplayResult>(EXT.replay, { ...params, ref })
    } finally {
      this.replays.delete(ref)
      const session = started as ClientSession | null
      if (session !== null) {
        this.forget(session.id)
        session.end()
      }
    }
  }

  /** Any request, with the server's refusals as `ClientError`s. */
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.call(() => this.agent.request(method as never, params as never) as Promise<T>)
  }

  /** Lets go of the server: every session's events end, its input is closed, and it shuts down what it still runs and exits. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const session of this.sessions.values()) session.end()
      this.connection.close()
      await this.transport.stop()
    })()
    return this.stopping
  }

  /** Turns what the server refused, or its absence, into a `ClientError` with the harness's own sentence. */
  failure(error: unknown): ClientError {
    if (error instanceof ClientError) return error
    if (this.lostReason !== null) return new ClientError(`the engine process ${this.lostReason.how}`, "closed")
    if (this.stopping !== null) return new ClientError("the connection to the engine was closed", "closed")
    const data = errorData(error)
    const holder = typeof data?.holderPid === "number" ? data.holderPid : null
    // ACP's own "resource not found" carries no reason of the harness's.
    const reason = typeof data?.reason === "string" ? data.reason : (error as { code?: unknown } | null)?.code === -32002 ? "session_not_found" : null
    if (typeof data?.message === "string") return new ClientError(data.message, reason, holder)
    return new ClientError(describe(error), reason, holder)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw this.failure(error)
    }
  }

  private attach(sessionId: string, cwd: string): ClientSession {
    const session = new ClientSession(this, sessionId, cwd)
    this.sessions.set(sessionId, session)
    for (const deliver of this.early.get(sessionId) ?? []) deliver(session)
    this.early.delete(sessionId)
    return session
  }

  private route(sessionId: string, deliver: (session: ClientSession) => void): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) return deliver(session)
    const waiting = this.early.get(sessionId) ?? []
    waiting.push(deliver)
    this.early.set(sessionId, waiting)
  }

  private extension(method: string, raw: unknown): void {
    const params = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null
    if (sessionId === null) return
    if (method === EXT.replayStarted) {
      const waiting = typeof params.ref === "string" ? this.replays.get(params.ref) : undefined
      if (waiting === undefined) return
      this.replays.delete(params.ref as string)
      // Attached before its events are handled: they follow this notification on the wire.
      waiting.onStart(this.attach(sessionId, waiting.cwd))
      return
    }
    const signal = signalOf(method, params)
    if (signal !== null) this.route(sessionId, (session) => session.signal(signal))
  }

  private async permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) return { outcome: { outcome: "cancelled" } }
    return session.answerPermission(params)
  }

  private async onClosed(): Promise<void> {
    if (this.stopping !== null) return
    this.lostReason = await this.transport.gone
    for (const session of this.sessions.values()) session.end()
  }
}

/** One session open on a connection. */
export class ClientSession {
  private readonly queue = new EventQueue<SessionItem>()
  private readonly listeners = new Set<(signal: SessionSignal) => void>()
  private readonly pendingAsks = new Set<AbortController>()
  /** The approval question being put to the approver: the next waits for it (several subagents can ask at once). */
  private approvalLine: Promise<void> = Promise.resolve()
  private closing: Promise<void> | null = null
  /** Answers the pending questions `cancelled`, once the cancel has reached the engine. */
  private interrupted: (() => void) | null = null
  /** The session's config options as the server last reported them (model, effort, approval). */
  configOptions: readonly SessionConfigOption[] = []
  /** Answers tool-call approval questions; without one they are declined. `signal` aborts when the question is withdrawn (a cancel). */
  approver: ((ask: ApprovalAsk, signal: AbortSignal) => Promise<ApprovalAnswer | null>) | null = null
  /** Answers the hand-edit question of an undo or redo; without one nothing is changed. */
  handEdits: ((ask: HandEditAsk, signal: AbortSignal) => Promise<"overwrite" | "keep" | null>) | null = null

  constructor(
    private readonly link: HarnessConnection,
    readonly id: string,
    readonly cwd: string,
  ) {}

  /** Every event of the session from the moment it was opened. One consumer (of this or `items`). Ends when the session is closed or the server is gone. */
  get events(): AsyncIterable<EventItem> {
    const source = this.queue
    return {
      async *[Symbol.asyncIterator]() {
        for await (const item of source) if ("event" in item) yield item
      },
    }
  }

  /** The events and the session's notifications (turn endings, taint, notices, ...) in the order they arrived. One consumer (of this or `events`). */
  get items(): AsyncIterable<SessionItem> {
    return this.queue
  }

  /** The connection the session is on. */
  get connection(): HarnessConnection {
    return this.link
  }

  /** The connection's advertised methods, for features a server may lack. */
  offers(method: string): boolean {
    return this.link.offers(method)
  }

  /** Listens to the session's extension notifications (turn endings, state, usage, taint, notices) and, if enabled, its standard updates. */
  onSignal(listener: (signal: SessionSignal) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  push(item: EventItem): void {
    this.queue.push(item)
    if (item.event.type === "execution.interrupt_requested" && !item.replay) this.interrupted?.()
  }

  signal(signal: SessionSignal): void {
    if (signal.kind !== "update") this.queue.push({ signal })
    for (const listener of this.listeners) listener(signal)
  }

  end(): void {
    for (const pending of this.pendingAsks) pending.abort()
    this.queue.end()
  }

  /** Whether the connection is gone (stopped, or the server died). */
  get gone(): boolean {
    return this.link.gone
  }

  /** `<prefix>/steer` (`delivery: "steer"`) or `<prefix>/queue`: admitted at once; resolves with the message ID. */
  async send(text: string, options: { readonly delivery?: "steer" | "queue"; readonly maxSteps?: number | null } = {}): Promise<string> {
    const admitted = await this.link.request<{ messageId: string }>(options.delivery === "queue" ? EXT.queue : EXT.steer, {
      sessionId: this.id,
      prompt: [{ type: "text", text }],
      ...(options.maxSteps === null || options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
    return admitted.messageId
  }

  /** `session/cancel`. A pending approval or hand-edit question is answered `cancelled` at once, as ACP asks. */
  cancel(): void {
    const abort = () => {
      this.interrupted = null
      for (const pending of this.pendingAsks) pending.abort()
    }
    if (this.link.gone || this.pendingAsks.size === 0) {
      if (!this.link.gone) this.link.agent.notify(methods.agent.session.cancel, { sessionId: this.id }).catch(() => {})
      return abort()
    }
    // The question is answered `cancelled` once the server has withdrawn it (its interrupt is in the log): answered
    // sooner, the answer can overtake the cancel inside the server and be recorded as a refusal.
    this.interrupted = abort
    setTimeout(() => this.interrupted === abort && abort(), CANCEL_ANSWER_MS)
    this.link.agent.notify(methods.agent.session.cancel, { sessionId: this.id }).catch(() => {})
  }

  /** `session/set_config_option`: `model`, `effort` or `approval`. Resolves with the options as they now are. */
  async setConfig(configId: string, value: string): Promise<readonly SessionConfigOption[]> {
    const result = await this.link.request<{ configOptions: SessionConfigOption[] }>(methods.agent.session.setConfigOption, { sessionId: this.id, configId, value })
    this.configOptions = result.configOptions
    return result.configOptions
  }

  revert(params: Omit<RevertParams, "sessionId"> = {}): Promise<RevertResult> {
    return this.link.request<RevertResult>(EXT.revert, { sessionId: this.id, ...params })
  }

  undoRevert(params: Omit<RevertParams, "sessionId" | "messageId"> = {}): Promise<RevertResult> {
    return this.link.request<RevertResult>(EXT.undoRevert, { sessionId: this.id, ...params })
  }

  async withdraw(messageId: string): Promise<boolean> {
    return (await this.link.request<{ withdrawn: boolean }>(EXT.withdraw, { sessionId: this.id, messageId })).withdrawn
  }

  state(): Promise<SessionStateResult> {
    return this.link.request<SessionStateResult>(EXT.session, { sessionId: this.id })
  }

  /** `<prefix>/approval`: how calls are approved here, after setting what `change` names. */
  approval(change: { readonly mode?: string; readonly unattended?: string; readonly attended?: boolean } = {}): Promise<ApprovalStateResult> {
    return this.link.request<ApprovalStateResult>(EXT.approval, { sessionId: this.id, ...change })
  }

  async clearTaint(): Promise<boolean> {
    return (await this.link.request<{ cleared: boolean }>(EXT.clearTaint, { sessionId: this.id })).cleared
  }

  /** `<prefix>/diff`: the files a turn (the latest by default) or a step changed, with per-file patches. */
  diff(params: Omit<DiffParams, "sessionId"> = {}): Promise<DiffResult> {
    return this.link.request<DiffResult>(EXT.diff, { sessionId: this.id, ...params })
  }

  /** `<prefix>/rename`, when the server offers it (`offers(EXT.rename)`). */
  async rename(title: string): Promise<string> {
    return (await this.link.request<{ title: string }>(EXT.rename, { sessionId: this.id, title })).title
  }

  /** `<prefix>/compact`, when the server offers it (`offers(EXT.compact)`). */
  async compact(): Promise<void> {
    await this.link.request(EXT.compact, { sessionId: this.id })
  }

  /** `session/close`: with `shutdown`, running work stops as a shutdown and resumes at the next open, every event of it before the answer. */
  close(options: { readonly shutdown?: boolean } = {}): Promise<void> {
    this.closing ??= (async () => {
      if (!this.link.gone) await this.link.agent.request(methods.agent.session.close, { sessionId: this.id, ...(options.shutdown === true ? { _meta: { [NS]: { shutdown: true } } } : {}) }).catch(() => {})
      this.link.forget(this.id)
      this.end()
    })()
    return this.closing
  }

  /** How the server went away under this session, or `null`. */
  lost(): Gone | null {
    return this.link.lost
  }

  private async putApproval(
    approver: NonNullable<ClientSession["approver"]>,
    approval: ApprovalAsk,
    controller: AbortController,
    cancelled: Promise<null>,
  ): Promise<RequestPermissionResponse> {
    const reply = await Promise.race([approver(approval, controller.signal).catch(() => null), cancelled])
    // Backed out of with a cancel on its way (Ctrl-C): answered once the server has withdrawn the question.
    if (reply === null && this.interrupted !== null) await cancelled
    if (reply === null || controller.signal.aborted) return { outcome: { outcome: "cancelled" } }
    return { outcome: { outcome: "selected", optionId: reply.choice }, ...(reply.note === undefined || reply.note === "" ? {} : { _meta: { [NS]: { note: reply.note } } }) }
  }

  /** A permission request the server sent about this session: an approval, a hand-edit question, or one this client does not know (declined). */
  async answerPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const meta = params._meta?.[NS] as Record<string, unknown> | undefined
    const controller = new AbortController()
    this.pendingAsks.add(controller)
    const cancelled = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }))
    try {
      const approval = parseApproval(params, meta?.[APPROVAL_META])
      if (approval !== null) {
        const approver = this.approver
        if (approver === null) return { outcome: { outcome: "cancelled" } }
        // One question at a time: the session's own and its subagents' can be pending together, and a front end shows one.
        const before = this.approvalLine
        let done = () => {}
        this.approvalLine = new Promise<void>((resolve) => (done = resolve))
        try {
          await Promise.race([before, cancelled])
          if (controller.signal.aborted) return { outcome: { outcome: "cancelled" } }
          return await this.putApproval(approver, approval, controller, cancelled)
        } finally {
          done()
        }
      }
      const plan = meta?.plan as RevertPlan | undefined
      const answerer = this.handEdits
      if (plan === undefined || answerer === null) return { outcome: { outcome: "cancelled" } }
      const ask: HandEditAsk = {
        sessionId: this.id,
        title: params.toolCall.title ?? "Overwrite files edited by hand?",
        command: meta?.command === "undo_revert" ? "undo_revert" : "revert",
        plan,
        handEdited: Array.isArray(meta?.handEdited) ? (meta.handEdited as string[]) : [],
        detail: (params.toolCall.content ?? []).flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : [])),
      }
      const answer = await Promise.race([answerer(ask, controller.signal).catch(() => null), cancelled])
      return answer === null || controller.signal.aborted ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: answer } }
    } finally {
      this.pendingAsks.delete(controller)
    }
  }
}

/**
 * A connection that can be made again: the first use starts the server, and
 * `reconnect()` replaces one whose server went away. For a client that runs
 * longer than one server (the TUI's `/reconnect`).
 */
export class HarnessClient {
  private current: HarnessConnection | null = null
  private starting: Promise<HarnessConnection> | null = null

  constructor(private readonly options: ConnectOptions) {}

  /** The connection, started on first use. Fails once the server went away until `reconnect()`. */
  async connection(): Promise<HarnessConnection> {
    const current = this.current
    if (current !== null && !current.gone) return current
    if (current?.lost !== null && current?.lost !== undefined) throw new ClientError(`the engine process ${current.lost.how}`, "closed")
    this.starting ??= HarnessConnection.start(this.options).then(
      (link) => {
        this.current = link
        return link
      },
      (error: unknown) => {
        this.starting = null
        throw error
      },
    )
    return this.starting
  }

  /** The connection if one is up, without starting one. */
  get connected(): HarnessConnection | null {
    return this.current !== null && !this.current.gone ? this.current : null
  }

  /** Stops the old server (if it is still there) and starts a new one. */
  async reconnect(): Promise<HarnessConnection> {
    const old = this.current
    this.current = null
    this.starting = null
    await old?.stop()
    return this.connection()
  }

  async stop(): Promise<void> {
    const link = this.current ?? (await this.starting?.catch(() => null)) ?? null
    this.current = null
    this.starting = null
    await link?.stop()
  }
}

function childTransport(transport: Extract<Transport, { kind: "child" }>, log: ConnectOptions["log"]): Transported {
  const env = transport.env
  // Only what the user should see, unless asked for more: the server's warnings and errors.
  const level = `${brand.binary.toUpperCase()}_ACP_LOG`
  const child = Bun.spawn([...transport.command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, [level]: env[level] ?? "warn" },
    // Its own process group: Ctrl-C at the terminal is the client's to handle (a cancel, not a shutdown).
    detached: true,
  })
  // The client may leave while the server still shuts down; that is the server's own business by then.
  child.unref()
  const tail: string[] = []
  const logged = forwardLines(child.stderr, (line) => {
    tail.push(line)
    if (tail.length > 40) tail.shift()
    const own = /^\S+ acp (debug|info|warn|error): (.*)$/.exec(line)
    if (own === null) return log?.(line, "raw")
    log?.(own[2]!, own[1] as LogLevel)
  })
  const gone = child.exited.then(async (code) => {
    await logged
    const how = child.signalCode !== null ? `was killed (${child.signalCode})` : `exited with code ${code}`
    return { how, said: code === 0 ? null : lastWords(tail) }
  })
  const input = new WritableStream<Uint8Array>({
    write: (chunk) => {
      child.stdin.write(chunk)
      child.stdin.flush()
    },
    close: () => {
      child.stdin.end()
    },
  })
  return {
    stream: ndJsonStream(input, child.stdout),
    gone,
    // Not waited for: the sessions were let go of before, and the server finishes its shutdown on its own.
    stop: async () => {
      try {
        child.stdin.end()
      } catch {}
    },
    kill: () => child.kill("SIGTERM"),
  }
}

async function memoryTransport(transport: Extract<Transport, { kind: "memory" }>, log: ConnectOptions["log"]): Promise<Transported> {
  const { createLogger } = await import("./log.ts")
  const { serve } = await import("./server.ts")
  const { createHarness } = await import("@light-harness/core")
  const logger = createLogger({
    level: "warn",
    write: (line) => {
      const own = /^\S+ acp (debug|info|warn|error): (.*)\n?$/.exec(line)
      if (own === null) return log?.(line.replace(/\n$/, ""), "raw")
      log?.(own[2]!, own[1] as LogLevel)
    },
  })
  const harness = createHarness({ log: (line) => logger.warn(line), ...transport.harness })
  // Copied as JSON, as the wire would: neither side keeps a reference to the other's objects.
  const wire = () => new TransformStream<object, object>({ transform: (message, controller) => controller.enqueue(JSON.parse(JSON.stringify(message))) })
  const toClient = wire()
  const toAgent = wire()
  const served = serve(harness, { writable: toClient.writable, readable: toAgent.readable } as unknown as Stream, { log: logger })
  return {
    stream: { writable: toAgent.writable, readable: toClient.readable } as unknown as Stream,
    gone: served.done.then(() => ({ how: "closed the connection", said: null })),
    stop: async () => {
      served.connection.close()
      await served.done
      await harness.close()
    },
    kill: () => served.connection.close(),
  }
}

/** How long a server whose client is gone may take to let go of its sessions: its shutdown limit, and a margin. */
export const WINDING_DOWN_MS = 6000

/**
 * Whether `pid` is a server whose client went away, finishing its shutdown
 * (it closes its sessions on its own, within its shutdown limit): an `acp`
 * process whose parent is gone, so it was handed to init or a subreaper.
 * Read from `/proc`; `false` where that cannot be told.
 */
export function windingDown(pid: number): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((arg) => arg !== "")
    if (args.at(-1) !== "acp") return false
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
    if (parent === 1) return true
    const comm = readFileSync(`/proc/${parent}/comm`, "utf8").trim()
    return comm === "systemd" || comm === "init"
  } catch {
    return false
  }
}

/**
 * Runs `open` again while the session it opens is held by a server that is
 * winding down (`windingDown`): what a client sees right after the one
 * before it was killed. `waiting` is told once, with the holder. A session
 * held by anything else is refused at once, as before, with a word on what
 * to do when its holder is a server.
 */
export async function openWhenReleased<T>(open: () => Promise<T>, waiting: (holderPid: number) => void = () => {}, limitMs = WINDING_DOWN_MS): Promise<T> {
  const deadline = Date.now() + limitMs
  let told = false
  for (;;) {
    try {
      return await open()
    } catch (error) {
      if (!(error instanceof ClientError) || error.reason !== "session_in_use" || error.holderPid === null) throw error
      const pid = error.holderPid
      if (!windingDown(pid) || Date.now() > deadline) {
        if (!windingDown(pid)) throw error
        throw new ClientError(`${error.message}. It is the engine of an earlier run that was stopped, still shutting down: try again in a moment`, error.reason, pid)
      }
      if (!told) waiting(pid)
      told = true
      await Bun.sleep(200)
    }
  }
}

/**
 * Why a server process died, from the end of what it wrote: its own last
 * error line, or the message of an uncaught error out of a crash dump
 * (`error: ...`, `TypeError: ...`), never the runtime's banner, a source
 * excerpt or a stack frame.
 */
export function lastWords(tail: readonly string[]): string | null {
  const lines = tail.map((line) => line.trimEnd()).filter((line) => line.trim() !== "")
  const own = lines.findLast((line) => /^\S+ acp (error|warn): /.test(line))
  if (own !== undefined) return own.replace(/^\S+ acp \w+: /, "")
  const thrown = lines.findLast((line) => /^(error|[A-Z]\w*Error|[A-Z]\w*Exception)(\[\w+\])?: \S/.test(line))
  if (thrown !== undefined) return thrown.replace(/^error: /, "")
  const plain = lines.findLast((line) => !/^Bun v\d/.test(line) && !/^\s*\d+ \| /.test(line) && !/^\s+at /.test(line) && !/^\s*\^\s*$/.test(line))
  return plain === undefined ? null : plain.trim()
}

/** Calls `line` with each line of the stream; resolves when it ends. */
async function forwardLines(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let rest = ""
  try {
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true })
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const each of lines) line(each)
    }
  } catch {}
  if (rest !== "") line(rest)
}

function signalOf(method: string, params: Record<string, unknown>): SessionSignal | null {
  switch (method) {
    case EXT.turn:
      return { kind: "turn", turn: params as unknown as TurnNotification }
    case EXT.state:
      return { kind: "state", state: params as unknown as StateNotification }
    case EXT.usage:
      return { kind: "usage", usage: params as unknown as UsageNotification }
    case EXT.taint:
      return { kind: "taint", tainted: params.tainted === true, text: typeof params.text === "string" ? params.text : null, replay: params.replay === true }
    case EXT.notice:
      return { kind: "notice", notice: String(params.kind ?? ""), message: String(params.message ?? "") }
    case EXT.diagnostic:
      return { kind: "diagnostic", diagnostic: String(params.kind ?? ""), message: String(params.message ?? "") }
    default:
      return null
  }
}

/** The approval of a permission request, or `null` when it is not one. Tolerates fields a newer server adds (a subagent's label). */
function parseApproval(params: RequestPermissionRequest, raw: unknown): ApprovalAsk | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  const question = value.question as ApprovalAsk["question"] | undefined
  if (typeof value.messageId !== "string" || typeof value.callId !== "string" || typeof question?.title !== "string" || !Array.isArray(question.choices)) return null
  return {
    sessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    messageId: value.messageId,
    callId: value.callId,
    question: { title: question.title, subject: typeof question.subject === "string" ? question.subject : "", details: Array.isArray(question.details) ? question.details : [], choices: question.choices },
    needs: Array.isArray(value.needs) ? (value.needs as Need[]) : [],
    then: (value.then as RunDecision | undefined) ?? { kind: "run" },
    subagent: labelOf(value.subagent ?? value.agent),
    subagentSessionId: typeof value.subagent === "object" && value.subagent !== null && typeof (value.subagent as { sessionId?: unknown }).sessionId === "string" ? (value.subagent as { sessionId: string }).sessionId : null,
  }
}

/** A subagent named by a string, or by an object with a `label`, `name` or `id`. */
function labelOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  if (typeof value !== "object" || value === null) return null
  const fields = value as Record<string, unknown>
  for (const key of ["label", "name", "title", "id", "sessionId"]) if (typeof fields[key] === "string" && (fields[key] as string).trim() !== "") return (fields[key] as string).trim()
  return null
}

/** `data[<ns>]` of a protocol error, or `null`. */
function errorData(error: unknown): { reason?: unknown; message?: unknown; holderPid?: unknown } | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null
  const data = (error as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return null
  const value = (data as Record<string, unknown>)[NS]
  return typeof value === "object" && value !== null ? (value as { reason?: unknown; message?: unknown }) : null
}

function parseEventParams(raw: unknown): { sessionId: string; event: HarnessEvent; replay?: boolean } {
  const value = raw as { sessionId?: unknown; event?: { type?: unknown } }
  if (typeof value?.sessionId !== "string" || typeof value.event?.type !== "string") throw new Error(`${EXT.event} without sessionId and event`)
  return raw as { sessionId: string; event: HarnessEvent; replay?: boolean }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One consumer's queue, which ends once. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private ended = false

  push(item: T): void {
    if (this.ended) return
    const waiting = this.waiting
    this.waiting = null
    if (waiting !== null) waiting({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    this.waiting = null
    waiting?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}
