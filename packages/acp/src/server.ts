/**
 * The ACP v1 agent: one instance per client connection, on top of the
 * process's `Backend`.
 *
 * The prompt turn. `session/prompt` admits the prompt into the session's inbox
 * (`steer` by default, `queue` when `_meta["<ns>/delivery"]` says so) and its
 * response waits for the end of the execution that delivered it. A prompt
 * sent while the session is working steers it: it is delivered at the next
 * step boundary, and every prompt the execution took in is answered when the
 * execution ends, with the same stop reason. Every update the execution
 * produced is sent before that response.
 *
 * `session/cancel` withdraws this connection's prompts that were not
 * delivered yet (they are answered `cancelled` at once), then interrupts the
 * running execution as the user; the prompts it delivered are answered
 * `cancelled` once it has wound down, after its last update. A prompt that
 * arrives after the cancel (a client that cancels and resends) is not
 * affected: it starts the next execution.
 *
 * A disconnect closes this connection's sessions as a graceful shutdown: work
 * in progress stops as a `shutdown`, which keeps it resumable, and every tool
 * process is stopped.
 */
import { isAbsolute } from "node:path"
import { statSync } from "node:fs"
import {
  type AgentApp,
  type AgentCapabilities,
  type AgentConnection,
  type AgentContext,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type ListSessionsResponse,
  PROTOCOL_VERSION,
  RequestError,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type Stream,
  agent,
  methods,
} from "@agentclientprotocol/sdk"
import { type EngineEvent, type SessionSettings, type StoredEvent, brand } from "@light-harness/core"
import { Backend, type ModelEntry, type OpenSession, SessionUnavailable, SIGN_IN_HINT } from "./backend.ts"
import { EXT, META, type SessionState, type StateNotification } from "./extensions.ts"
import { type Logger, describeError } from "./log.ts"
import { promptText } from "./prompt.ts"
import { type Output, Translator, type TurnEnd } from "./translate.ts"

/** The one auth method: the ChatGPT-plan sign-in, which the user completes outside the client. */
export const AUTH_METHOD_ID = "chatgpt"

export const CONFIG = { model: "model", effort: "effort" } as const
const DEFAULT_EFFORT_VALUE = "default"
const LIST_PAGE = 100

export interface ServeOptions {
  readonly log: Logger
  /** Reported as `agentInfo.version`. */
  readonly version?: string
}

export interface Served {
  readonly connection: AgentConnection
  /** Resolves once the connection has closed and its sessions have been shut down. */
  readonly done: Promise<void>
}

/** Serves one client connection. The backend outlives it; the caller closes the backend when the process ends. */
export function serve(backend: Backend, stream: Stream, options: ServeOptions): Served {
  const state = new ConnectionState(backend, options)
  const connection = buildAgent(state).connect(stream)
  state.client = connection.client
  state.connectionSignal = connection.signal
  const done = connection.closed.then(
    () => state.shutdown(),
    () => state.shutdown(),
  )
  return { connection, done }
}

/** Advertised in `initialize` under `agentCapabilities._meta[<ns>]`. */
export const EXTENSION_CAPABILITIES = {
  methods: [EXT.steer, EXT.queue, EXT.models],
  notifications: [EXT.usage, EXT.state],
  promptMeta: [META.delivery],
} as const

function buildAgent(state: ConnectionState): AgentApp {
  return agent({ name: brand.name })
    .onRequest(methods.agent.initialize, ({ params }) => state.initialize(params.protocolVersion, params.clientCapabilities ?? {}))
    .onRequest(methods.agent.authenticate, ({ params }) => state.authenticate(params.methodId))
    .onRequest(methods.agent.session.new, ({ params }) => state.newSession(params.cwd, params.mcpServers.length))
    .onRequest(methods.agent.session.load, ({ params }) => state.loadSession(params.sessionId, params.cwd, true))
    .onRequest(methods.agent.session.resume, ({ params }) => state.loadSession(params.sessionId, params.cwd, false))
    .onRequest(methods.agent.session.list, ({ params }) => state.listSessions(params.cwd ?? null, params.cursor ?? null))
    .onRequest(methods.agent.session.close, ({ params }) => state.closeSession(params.sessionId))
    .onRequest(methods.agent.session.delete, ({ params }) => state.deleteSession(params.sessionId))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      if (!("value" in params) || typeof params.value !== "string")
        throw RequestError.invalidParams({ configId: params.configId }, "only select options are offered")
      return state.setConfigOption(params.sessionId, params.configId, params.value)
    })
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => state.prompt(params.sessionId, params.prompt, params._meta ?? null, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => state.cancel(params.sessionId))
    .onRequest(EXT.steer, parseInputParams, ({ params }) => state.admit(params.sessionId, params.prompt, "steer"))
    .onRequest(EXT.queue, parseInputParams, ({ params }) => state.admit(params.sessionId, params.prompt, "queue"))
    .onRequest(EXT.models, (params) => params, () => state.models())
}

interface Pending {
  readonly messageId: string
  delivered: boolean
  /** `seq` of its `inbox.enqueued`, once this connection has seen it. */
  enqueuedSeq: number | null
  readonly resolve: (value: { stopReason: StopReason }) => void
  readonly reject: (error: unknown) => void
}

class ConnectionState {
  client: AgentContext | null = null
  connectionSignal: AbortSignal | null = null
  private capabilities: ClientCapabilities = {}
  private readonly views = new Map<string, SessionView>()
  private closing: Promise<void> | null = null

  constructor(
    readonly backend: Backend,
    readonly options: ServeOptions,
  ) {}

  get log(): Logger {
    return this.options.log
  }

  get clientCapabilities(): ClientCapabilities {
    return this.capabilities
  }

  // ---- setup ----

  initialize(requested: number, capabilities: ClientCapabilities): InitializeResponse {
    this.capabilities = capabilities
    this.log.info(`client connected, protocol ${requested}${requested === PROTOCOL_VERSION ? "" : `, answering ${PROTOCOL_VERSION}`}`)
    const agentCapabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
      _meta: { [META.capabilities]: EXTENSION_CAPABILITIES },
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities,
      agentInfo: { name: brand.binary, title: brand.name, version: this.options.version ?? "0.0.0" },
      authMethods: [
        {
          id: AUTH_METHOD_ID,
          name: "Sign in with ChatGPT",
          description: `Uses the ChatGPT plan sign-in saved on this machine. To sign in, ${SIGN_IN_HINT}.`,
        },
      ],
    }
  }

  async authenticate(methodId: string): Promise<Record<string, never>> {
    if (methodId !== AUTH_METHOD_ID) throw RequestError.invalidParams({ methodId }, `unknown auth method ${methodId}`)
    await this.requireSignIn()
    return {}
  }

  // ---- sessions ----

  async newSession(cwd: string, mcpServers: number) {
    requireDirectory(cwd)
    await this.requireSignIn()
    if (mcpServers > 0) this.log.warn(`ignoring ${mcpServers} MCP server(s): ${brand.name} does not connect to MCP servers yet`)
    const open = this.unavailableAsError(() => this.backend.createSession(cwd))
    const view = this.attach(open, cwd, open.engine.projection().lastSeq)
    return { sessionId: open.id, configOptions: await this.configOptions(view.settings) }
  }

  async loadSession(sessionId: string, cwd: string, replay: boolean) {
    if (!isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    await this.requireSignIn()
    const summary = this.unavailableAsError(() => this.backend.summary(sessionId))
    if (summary === null || summary.session.archived) throw RequestError.sessionNotFound(sessionId)
    // Known before the state is reported, for the context window in `usage_update`.
    const models = this.backend.models()
    if (summary.session.cwd !== cwd)
      throw RequestError.invalidParams({ cwd, sessionCwd: summary.session.cwd }, `session ${sessionId} works in ${summary.session.cwd}, not ${cwd}`)
    this.views.get(sessionId)?.detach()
    await models
    const open = this.unavailableAsError(() => {
      try {
        return this.backend.openSession(sessionId)
      } catch (error) {
        if (error instanceof SessionUnavailable) throw RequestError.sessionNotFound(sessionId)
        throw error
      }
    })
    // Read, translate and queue the stored log before listening, all in this synchronous block, so that a live
    // event either is in the log read here or arrives after it, never both and never neither.
    const history = this.backend.history(open.id)
    const lastSeq = history.at(-1)?.seq ?? 0
    const view = this.attach(open, cwd, lastSeq, (translator) => {
      // Without a replay the log is still folded, so the translator knows the model and the calls in it.
      const outputs = translator.replay(history)
      return replay ? outputs.filter((output) => output.type === "update") : []
    })
    view.syncState(history)
    await view.flushed()
    return { configOptions: await this.configOptions(view.settings) }
  }

  async listSessions(cwd: string | null, cursor: string | null): Promise<ListSessionsResponse> {
    if (cwd !== null && !isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    const offset = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0) throw RequestError.invalidParams({ cursor }, "unknown cursor")
    const all = this.unavailableAsError(() => this.backend.listSessions()).filter((summary) => cwd === null || summary.session.cwd === cwd)
    const page = all.slice(offset, offset + LIST_PAGE)
    const sessions: SessionInfo[] = page.map((summary) => ({
      sessionId: summary.session.id,
      cwd: summary.session.cwd,
      title: summary.session.title,
      updatedAt: new Date(summary.updatedAt).toISOString(),
      _meta: { [META.capabilities]: { model: summary.session.settings.model, effort: summary.session.settings.reasoningEffort } },
    }))
    return offset + LIST_PAGE < all.length ? { sessions, nextCursor: String(offset + LIST_PAGE) } : { sessions }
  }

  async closeSession(sessionId: string): Promise<Record<string, never>> {
    const view = this.views.get(sessionId)
    if (view === undefined) return {}
    await view.cancelAndWait()
    view.detach()
    await this.backend.closeSession(sessionId)
    return {}
  }

  async deleteSession(sessionId: string): Promise<Record<string, never>> {
    await this.closeSession(sessionId)
    await this.unavailableAsError(() => this.backend.archive(sessionId))
    return {}
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    const view = this.requireView(sessionId)
    const current = view.settings
    const models = await this.backend.models()
    let next: SessionSettings
    if (configId === CONFIG.model) {
      const entry = models.find((model) => model.id === value)
      if (entry === undefined && value !== current.model)
        throw RequestError.invalidParams({ configId, value }, `unknown model ${value}${models.length === 0 ? " (the model list is not available)" : ""}`)
      // An effort the new model does not take falls back to the model's own default.
      const keeps = current.reasoningEffort === null || entry === undefined || entry.efforts.includes(current.reasoningEffort)
      next = { model: value, reasoningEffort: keeps ? current.reasoningEffort : null }
    } else if (configId === CONFIG.effort) {
      const efforts = models.find((model) => model.id === current.model)?.efforts ?? []
      if (value !== DEFAULT_EFFORT_VALUE && !efforts.includes(value) && value !== current.reasoningEffort)
        throw RequestError.invalidParams({ configId, value }, `${current.model} does not take the reasoning effort ${value}`)
      next = { model: current.model, reasoningEffort: value === DEFAULT_EFFORT_VALUE ? null : value }
    } else throw RequestError.invalidParams({ configId }, `unknown config option ${configId}`)
    view.open.engine.setSettings(next)
    view.requested = next
    return { configOptions: await this.configOptions(next) }
  }

  // ---- the prompt turn ----

  async prompt(sessionId: string, blocks: readonly ContentBlock[], meta: Record<string, unknown> | null, signal: AbortSignal) {
    const view = this.requireView(sessionId)
    const text = requirePromptText(blocks)
    const delivery = meta?.[META.delivery] === "queue" ? "queue" : "steer"
    const messageId = view.open.engine.send(text, { delivery })
    return view.waitFor(messageId, signal)
  }

  cancel(sessionId: string): void {
    this.views.get(sessionId)?.cancel()
  }

  /** `_<ns>/steer` and `_<ns>/queue`: admit input without waiting for the turn. */
  admit(sessionId: string, blocks: readonly ContentBlock[], delivery: "steer" | "queue") {
    const view = this.requireView(sessionId)
    const text = requirePromptText(blocks)
    const messageId = view.open.engine.send(text, { delivery })
    view.echo.add(messageId)
    return { messageId }
  }

  async models() {
    const models = await this.backend.models()
    return {
      defaultModel: this.backend.defaults.model,
      models: models.map((model) => ({ ...model, efforts: [...model.efforts] })),
    }
  }

  // ---- shared ----

  async configOptions(settings: SessionSettings): Promise<SessionConfigOption[]> {
    return configOptionsFor(settings, await this.backend.models())
  }

  sendUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    const client = this.client
    if (client === null) return Promise.resolve()
    const notification: SessionNotification = { sessionId, update }
    return client.notify(methods.client.session.update, notification)
  }

  sendExt(method: string, params: Record<string, unknown>): Promise<void> {
    const client = this.client
    if (client === null) return Promise.resolve()
    return client.notify(method, params)
  }

  get connectionClosed(): boolean {
    return this.connectionSignal?.aborted === true
  }

  /** On disconnect: stop listening, and shut this connection's sessions down so they resume later. */
  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      const views = [...this.views.values()]
      this.views.clear()
      for (const view of views) view.detach()
      if (views.length > 0) this.log.info(`client disconnected; closing ${views.length} session(s) as a shutdown`)
      await Promise.all(views.map((view) => this.backend.closeSession(view.open.id).catch((error: unknown) => this.log.error(`closing ${view.open.id} failed: ${describeError(error)}`))))
    })()
    return this.closing
  }

  forget(view: SessionView): void {
    if (this.views.get(view.open.id) === view) this.views.delete(view.open.id)
  }

  private attach(open: OpenSession, cwd: string, fromSeq: number, prime?: (translator: Translator) => Output[]): SessionView {
    const view = new SessionView(this, open, cwd, fromSeq)
    if (prime !== undefined) view.queueOutputs(prime(view.translator), true)
    view.listen()
    this.views.set(open.id, view)
    return view
  }

  private requireView(sessionId: string): SessionView {
    const view = this.views.get(sessionId)
    if (view === undefined) throw RequestError.sessionNotFound(sessionId)
    return view
  }

  private async requireSignIn(): Promise<void> {
    const state = await this.backend.signIn()
    if (!state.signedIn) throw RequestError.authRequired({ methodId: AUTH_METHOD_ID }, state.message)
  }

  private unavailableAsError<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (error instanceof SessionUnavailable) throw RequestError.internalError({ reason: error.message }, error.message)
      throw error
    }
  }
}

/** One session as this connection shows it. */
class SessionView {
  readonly translator: Translator
  /** Messages this connection admitted through the extension methods; they are shown when delivered. */
  readonly echo = new Set<string>()
  /** A settings change this connection asked for that has not reached the log yet. */
  requested: SessionSettings | null = null
  private readonly pending: Pending[] = []
  private outbox: Promise<void> = Promise.resolve()
  private unlisten: (() => void) | null = null
  private detached = false

  constructor(
    private readonly connection: ConnectionState,
    readonly open: OpenSession,
    cwd: string,
    private fromSeq: number,
  ) {
    const backend = connection.backend
    const capabilities = connection.clientCapabilities
    this.translator = new Translator({
      sessionId: open.id,
      cwd,
      log: connection.log,
      notices: capabilities.session?.notices != null,
      compaction: capabilities.session?.compaction != null,
      contextWindow: (model) => backend.cachedModels().find((entry) => entry.id === model)?.contextWindow ?? null,
      echo: (messageId) => this.echo.has(messageId),
    })
  }

  get settings(): SessionSettings {
    return this.requested ?? this.open.engine.projection().session.settings
  }

  listen(): void {
    this.unlisten = this.open.listen((item) => this.onEvent(item))
  }

  detach(): void {
    if (this.detached) return
    this.detached = true
    this.unlisten?.()
    this.connection.forget(this)
    const error = new RequestError(-32800, "the session was closed")
    for (const pending of this.pending.splice(0)) pending.reject(error)
  }

  flushed(): Promise<void> {
    return this.outbox
  }

  /** Waits for the end of the execution that delivers `messageId`. */
  waitFor(messageId: string, signal: AbortSignal): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve, reject) => {
      const pending: Pending = { messageId, delivered: false, enqueuedSeq: null, resolve, reject }
      this.pending.push(pending)
      // `$/cancel_request` on the prompt cancels its turn. The signal also aborts when the connection closes,
      // which is a shutdown, handled by the disconnect.
      signal.addEventListener("abort", () => {
        if (!this.connection.connectionClosed && this.pending.includes(pending)) this.cancel()
      }, { once: true })
    })
  }

  cancel(): void {
    const waiting = this.pending.filter((pending) => !pending.delivered)
    const withdrawn = new Set(this.connection.backend.cancelInbox(this.open.id, waiting.map((pending) => pending.messageId)))
    if (withdrawn.size > 0) this.settle((pending) => withdrawn.has(pending.messageId), { kind: "stop", stopReason: "cancelled" })
    this.open.engine.interrupt()
  }

  async cancelAndWait(): Promise<void> {
    this.cancel()
    await this.open.engine.settled()
    await this.flushed()
  }

  queueOutputs(outputs: readonly Output[], replay: boolean): void {
    for (const output of outputs) this.handleOutput(output, replay, null)
  }

  /** After a load or resume: the title, the context use, and whether the session is working, idle or suspended. */
  syncState(history: readonly StoredEvent[]): void {
    const projection = this.open.engine.projection()
    const session = projection.session
    this.enqueue(() =>
      this.connection.sendUpdate(this.open.id, {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: new Date(projection.updatedAt).toISOString(),
      }),
    )
    const last = lastUsage(history)
    const size = last === null ? null : (this.connection.backend.cachedModels().find((model) => model.id === last.model)?.contextWindow ?? null)
    if (last !== null && size !== null)
      this.enqueue(() => this.connection.sendUpdate(this.open.id, { sessionUpdate: "usage_update", used: last.used, size }))
    const state: SessionState = this.open.engine.working ? "running" : session.execution?.status === "suspended" ? "suspended" : "idle"
    const params: StateNotification = { sessionId: this.open.id, state }
    this.enqueue(() => this.connection.sendExt(EXT.state, { ...params }))
  }

  private onEvent(item: EngineEvent): void {
    if (this.detached) return
    const seq = "seq" in item ? item.seq : null
    if (seq !== null && seq <= this.fromSeq) return
    if (item.type === "inbox.enqueued") {
      const pending = this.pending.find((entry) => entry.messageId === item.data.messageId)
      if (pending !== undefined) pending.enqueuedSeq = item.seq
    }
    if (item.type === "settings.changed") this.requested = null
    for (const output of this.translator.translate(item)) this.handleOutput(output, false, seq)
  }

  private handleOutput(output: Output, replay: boolean, seq: number | null): void {
    switch (output.type) {
      case "update": {
        const update = output.update
        this.enqueue(() => this.connection.sendUpdate(this.open.id, update))
        return
      }
      case "ext": {
        const { method, params } = output
        this.enqueue(() => this.connection.sendExt(method, params))
        return
      }
      case "settings": {
        const settings = output.settings
        this.enqueue(async () =>
          this.connection.sendUpdate(this.open.id, { sessionUpdate: "config_option_update", configOptions: await this.connection.configOptions(settings) }),
        )
        return
      }
      case "delivered": {
        const pending = this.pending.find((entry) => entry.messageId === output.messageId)
        if (pending !== undefined) pending.delivered = true
        return
      }
      case "end":
        if (!replay) this.onEnd(output.end, seq)
        return
    }
  }

  /** Answers the prompts the ended execution delivered; after a failure, also those it left waiting. */
  private onEnd(end: TurnEnd, seq: number | null): void {
    this.settle((pending) => pending.delivered, end)
    if (end.kind === "failed" && seq !== null) {
      const stranded = this.pending.filter((pending) => !pending.delivered && pending.enqueuedSeq !== null && pending.enqueuedSeq < seq)
      const withdrawn = new Set(this.connection.backend.cancelInbox(this.open.id, stranded.map((pending) => pending.messageId)))
      this.settle((pending) => withdrawn.has(pending.messageId), end)
    }
  }

  private settle(which: (pending: Pending) => boolean, end: TurnEnd): void {
    const chosen = this.pending.filter(which)
    if (chosen.length === 0) return
    for (const pending of chosen) this.pending.splice(this.pending.indexOf(pending), 1)
    // Every update sent so far goes out before the answer.
    void this.outbox.then(() => {
      for (const pending of chosen) {
        if (end.kind === "stop") pending.resolve({ stopReason: end.stopReason })
        else pending.reject(failure(end))
      }
    })
  }

  private enqueue(send: () => Promise<void>): void {
    this.outbox = this.outbox.then(send).catch((error: unknown) => {
      if (!this.connection.connectionClosed) this.connection.log.warn(`could not send an update for ${this.open.id}: ${describeError(error)}`)
    })
  }
}

/** A failed turn, as the error `session/prompt` answers with. Signed out is the protocol's auth-required error. */
function failure(end: Extract<TurnEnd, { kind: "failed" }>): RequestError {
  if (end.providerError?.kind === "auth")
    return RequestError.authRequired({ methodId: AUTH_METHOD_ID }, `${end.message} To sign in, ${SIGN_IN_HINT}.`)
  const data: Record<string, unknown> = { [META.capabilities]: { reason: "execution_failed" } }
  if (end.providerError !== null) data[META.capabilities] = { reason: "execution_failed", providerError: end.providerError.kind }
  return new RequestError(-32603, end.message, data)
}

export function configOptionsFor(settings: SessionSettings, models: readonly ModelEntry[]): SessionConfigOption[] {
  const entry = models.find((model) => model.id === settings.model)
  const modelOptions = models.map((model) => ({ value: model.id, name: model.name }))
  if (entry === undefined) modelOptions.unshift({ value: settings.model, name: settings.model })
  const efforts = entry?.efforts ?? []
  const effortOptions = [
    { value: DEFAULT_EFFORT_VALUE, name: entry?.defaultEffort ? `Default (${entry.defaultEffort})` : "Model default" },
    ...efforts.map((effort) => ({ value: effort, name: effort.charAt(0).toUpperCase() + effort.slice(1) })),
  ]
  const effort = settings.reasoningEffort ?? DEFAULT_EFFORT_VALUE
  if (!effortOptions.some((option) => option.value === effort)) effortOptions.push({ value: effort, name: effort })
  return [
    { id: CONFIG.model, name: "Model", category: "model", type: "select", currentValue: settings.model, options: modelOptions },
    { id: CONFIG.effort, name: "Reasoning effort", category: "thought_level", type: "select", currentValue: effort, options: effortOptions },
  ]
}

function requirePromptText(blocks: readonly ContentBlock[]): string {
  const text = promptText(blocks)
  if (!text.ok) throw RequestError.invalidParams({ prompt: "rejected" }, text.message)
  return text.text
}

function requireDirectory(cwd: string): void {
  if (!isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
  const info = (() => {
    try {
      return statSync(cwd)
    } catch {
      return null
    }
  })()
  if (info === null || !info.isDirectory()) throw RequestError.invalidParams({ cwd }, `cwd is not a directory: ${cwd}`)
}

/** Params of `_<ns>/steer` and `_<ns>/queue`. Content blocks are checked by `promptText`. */
function parseInputParams(raw: unknown): { sessionId: string; prompt: ContentBlock[] } {
  if (typeof raw !== "object" || raw === null) throw RequestError.invalidParams(undefined, "expected { sessionId, prompt }")
  const value = raw as Record<string, unknown>
  if (typeof value.sessionId !== "string") throw RequestError.invalidParams(undefined, "sessionId must be a string")
  if (!Array.isArray(value.prompt)) throw RequestError.invalidParams(undefined, "prompt must be an array of content blocks")
  for (const block of value.prompt) {
    if (typeof block !== "object" || block === null || typeof (block as { type?: unknown }).type !== "string")
      throw RequestError.invalidParams(undefined, "every prompt item must be a content block")
    const typed = block as Record<string, unknown>
    if (typed.type === "text" && typeof typed.text !== "string") throw RequestError.invalidParams(undefined, "a text block needs text")
    if (typed.type === "resource_link" && (typeof typed.uri !== "string" || typeof typed.name !== "string"))
      throw RequestError.invalidParams(undefined, "a resource_link block needs uri and name")
    if (typed.type === "resource") {
      const resource = typed.resource as Record<string, unknown> | undefined
      if (typeof resource !== "object" || resource === null || typeof resource.uri !== "string")
        throw RequestError.invalidParams(undefined, "a resource block needs resource.uri")
    }
  }
  return { sessionId: value.sessionId, prompt: value.prompt as ContentBlock[] }
}

/** The context use after the latest model call of a stored log: its input plus output tokens. */
function lastUsage(history: readonly StoredEvent[]): { used: number; model: string } | null {
  let model: string | null = null
  let last: { used: number; model: string } | null = null
  for (const item of history) {
    if (item.type === "session.created") model = item.data.settings.model
    if (item.type === "step.started") model = item.data.model
    if ((item.type === "step.ended" || item.type === "step.failed" || item.type === "step.refused") && item.data.usage !== null && model !== null)
      last = { used: item.data.usage.inputTokens + item.data.usage.outputTokens, model }
  }
  return last
}
