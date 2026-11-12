/**
 * The ACP v1 agent: one instance per client connection, on top of the
 * process's harness (`createHarness` in `@light-harness/core`, the same
 * assembly the command line uses). Everything it does to a session goes
 * through the engine: creating and opening, the stored log for a replay,
 * settings, withdrawing a prompt, closing one session, archiving. A session
 * another process is working in (a terminal, another editor) is refused
 * with an error that names that process.
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
import { isAbsolute, join } from "node:path"
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
  type RequestPermissionRequest,
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
import {
  EngineError,
  type EngineEvent,
  type EngineSession,
  type Harness,
  type HandEditPolicy,
  type MessageId,
  type ModelEntry,
  ModelListError,
  type RevertOptions,
  type RevertPlan,
  type RevertResult,
  type SessionId,
  type SessionSettings,
  type StoredEvent,
  StoreError,
  brand,
} from "@light-harness/core"
import {
  type ClientMeta,
  type ErrorData,
  EXT,
  HAND_EDIT_OPTIONS,
  META,
  type OpenMeta,
  type RevertParams,
  type SessionState,
  type StateNotification,
} from "./extensions.ts"
import { type Logger, describeError } from "./log.ts"
import { type ModelCatalog, catalogOf } from "./models.ts"
import { promptText } from "./prompt.ts"
import { type Output, Translator, type TurnEnd } from "./translate.ts"

/** The instruction a signed-out user gets. The CLI has no sign-in command yet; this is the developer helper. */
export const SIGN_IN_HINT = `run \`bun scripts/login.ts start\` in the ${brand.name} checkout and finish the ChatGPT sign-in, then try again`

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

/** Serves one client connection. The harness outlives it; the caller closes the harness when the process ends. */
export function serve(harness: Harness, stream: Stream, options: ServeOptions): Served {
  const state = new ConnectionState(harness, options)
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
  methods: [EXT.steer, EXT.queue, EXT.models, EXT.revert, EXT.undoRevert, EXT.withdraw, EXT.unarchive, EXT.session, EXT.events, EXT.resolve],
  notifications: [EXT.usage, EXT.state, EXT.turn, EXT.diagnostic, EXT.event],
  promptMeta: [META.delivery, META.maxSteps],
  /** Keys of `clientCapabilities._meta[<ns>]` this server reads (`ClientMeta`). */
  clientMeta: ["events", "updates"],
  /** Keys of `_meta[<ns>]` on `session/new`, `session/load` and `session/resume` (`OpenMeta`). */
  openMeta: ["model", "effort"],
} as const

function buildAgent(state: ConnectionState): AgentApp {
  return agent({ name: brand.name })
    .onRequest(methods.agent.initialize, ({ params }) => state.initialize(params.protocolVersion, params.clientCapabilities ?? {}))
    .onRequest(methods.agent.authenticate, ({ params }) => state.authenticate(params.methodId))
    .onRequest(methods.agent.session.new, ({ params }) => state.newSession(params.cwd, params.mcpServers.length, openMeta(params._meta)))
    .onRequest(methods.agent.session.load, ({ params }) => state.loadSession(params.sessionId, params.cwd, true, openMeta(params._meta)))
    .onRequest(methods.agent.session.resume, ({ params }) => state.loadSession(params.sessionId, params.cwd, false, openMeta(params._meta)))
    .onRequest(methods.agent.session.list, ({ params }) =>
      state.listSessions(params.cwd ?? null, params.cursor ?? null, namespaced(params._meta)?.archived === true),
    )
    .onRequest(methods.agent.session.close, ({ params }) => state.closeSession(params.sessionId, namespaced(params._meta)?.shutdown === true))
    .onRequest(methods.agent.session.delete, ({ params }) => state.deleteSession(params.sessionId))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      if (!("value" in params) || typeof params.value !== "string")
        throw RequestError.invalidParams({ configId: params.configId }, "only select options are offered")
      return state.setConfigOption(params.sessionId, params.configId, params.value)
    })
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => state.prompt(params.sessionId, params.prompt, params._meta ?? null, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => state.cancel(params.sessionId))
    .onRequest(EXT.steer, parseInputParams, ({ params }) => state.admit(params.sessionId, params.prompt, "steer", params.maxSteps))
    .onRequest(EXT.queue, parseInputParams, ({ params }) => state.admit(params.sessionId, params.prompt, "queue", params.maxSteps))
    .onRequest(EXT.models, (params) => params, () => state.models())
    .onRequest(EXT.revert, parseRevertParams, ({ params }) => state.revert(params, false))
    .onRequest(EXT.undoRevert, parseRevertParams, ({ params }) => state.revert(params, true))
    .onRequest(EXT.withdraw, parseObject, ({ params }) => state.withdraw(requireString(params, "sessionId"), requireString(params, "messageId")))
    .onRequest(EXT.unarchive, parseObject, ({ params }) => state.unarchive(requireString(params, "sessionId")))
    .onRequest(EXT.session, parseObject, ({ params }) => state.sessionState(requireString(params, "sessionId")))
    .onRequest(EXT.events, parseObject, ({ params }) =>
      state.storedEvents(requireString(params, "sessionId"), optionalInteger(params, "afterSeq", 0) ?? 0, optionalInteger(params, "limit", 1)),
    )
    .onRequest(EXT.resolve, parseObject, ({ params }) =>
      state.resolve(requireString(params, "cwd"), optionalString(params, "session")),
    )
}

interface Pending {
  readonly messageId: string
  delivered: boolean
  /** `seq` of its `inbox.enqueued`, once this connection has seen it. */
  enqueuedSeq: number | null
  readonly resolve: (value: { stopReason: StopReason; _meta?: Record<string, unknown> }) => void
  readonly reject: (error: unknown) => void
}

class ConnectionState {
  client: AgentContext | null = null
  connectionSignal: AbortSignal | null = null
  private capabilities: ClientCapabilities = {}
  /** What a full-fidelity client asked for in `initialize`. */
  fidelity: { readonly events: boolean; readonly updates: boolean } = { events: false, updates: true }
  private readonly views = new Map<string, SessionView>()
  private closing: Promise<void> | null = null

  readonly catalog: ModelCatalog

  constructor(
    readonly harness: Harness,
    readonly options: ServeOptions,
  ) {
    this.catalog = catalogOf(harness, options.log)
  }

  get log(): Logger {
    return this.options.log
  }

  get clientCapabilities(): ClientCapabilities {
    return this.capabilities
  }

  // ---- setup ----

  initialize(requested: number, capabilities: ClientCapabilities): InitializeResponse {
    this.capabilities = capabilities
    const asked = namespaced(capabilities._meta) as ClientMeta | null
    this.fidelity = { events: asked?.events === true, updates: asked?.updates !== false }
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

  async newSession(cwd: string, mcpServers: number, meta: OpenMeta | null) {
    requireDirectory(cwd)
    await this.requireSignIn()
    if (mcpServers > 0) this.log.warn(`ignoring ${mcpServers} MCP server(s): ${brand.name} does not connect to MCP servers yet`)
    const asked = { model: meta?.model ?? null, effort: meta?.effort ?? null }
    // A model the client names is checked before a session is created with it, as the command line does.
    if (asked.model !== null) await this.validate(cwd, asked)
    const settings = await this.harness.settingsFor(cwd, asked)
    const session = this.engineErrors(() => this.harness.engine.createSession({ cwd, settings }))
    const view = this.attach(session, cwd, session.projection().lastSeq)
    // A full-fidelity client gets the session from its first event, as the engine's own stream has it.
    if (this.fidelity.events) for (const item of session.readEvents()) view.queueEvent(item, false)
    await view.flushed()
    return { sessionId: session.id, configOptions: await this.configOptions(view.settings) }
  }

  async loadSession(sessionId: string, cwd: string, replay: boolean, meta: OpenMeta | null) {
    if (!isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    await this.requireSignIn()
    const asked = { model: meta?.model ?? null, effort: meta?.effort ?? null }
    if (asked.model !== null) await this.validate(cwd, asked)
    // Archived sessions are not offered: `session/delete` archives.
    const summary = this.engineErrors(() => this.harness.engine.getSession(sessionId as SessionId), sessionId)
    if (summary === null || (summary.session.archived && meta?.archived !== true)) throw RequestError.sessionNotFound(sessionId)
    // Known before the state is reported, for the context window in `usage_update`.
    const models = this.catalog.list()
    if (summary.session.cwd !== cwd)
      throw RequestError.invalidParams({ cwd, sessionCwd: summary.session.cwd }, `session ${sessionId} works in ${summary.session.cwd}, not ${cwd}`)
    this.views.get(sessionId)?.detach()
    await models
    // What the log held before this open: events after it (a crashed claim's recovery) are news to a client.
    const openedAt = summary.lastSeq
    // A claim left by a process that died is repaired here; a suspended one (a clean shutdown in the middle of a
    // turn) stays suspended until the user says something, so their words are in front of the model in the first
    // step after the restart. A session another process holds is refused, with that process named.
    const session = this.engineErrors(() => this.harness.engine.openSession(sessionId as SessionId, { resume: "wait" }), sessionId)
    // Read, translate and queue the stored log before listening, all in this synchronous block, so that a live
    // event either is in the log read here or arrives after it, never both and never neither.
    const history = session.readEvents()
    const lastSeq = history.at(-1)?.seq ?? 0
    const view = this.attach(session, cwd, lastSeq, (translator) => {
      // Without a replay the log is still folded, so the translator knows the model and the calls in it.
      const outputs = translator.replay(history)
      return replay ? outputs.filter((output) => output.type === "update" || (output.type === "ext" && output.method === EXT.turn)) : []
    })
    // A full-fidelity client gets the log as it is: all of it on a load (marked as a replay up to this open), and on
    // either the events this open appended, which are what a live session would have streamed.
    if (this.fidelity.events)
      for (const item of history) if (replay || item.seq > openedAt) view.queueEvent(item, item.seq <= openedAt)
    view.syncState(history)
    // As the command line does on --session and --continue: the model or effort named is switched to, durably.
    if (asked.model !== null || asked.effort !== null) {
      const current = session.projection().session.settings
      session.setSettings({ model: asked.model ?? current.model, reasoningEffort: asked.effort ?? current.reasoningEffort })
    }
    await view.flushed()
    return { configOptions: await this.configOptions(view.settings) }
  }

  async listSessions(cwd: string | null, cursor: string | null, archived = false): Promise<ListSessionsResponse> {
    if (cwd !== null && !isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    const offset = cursor === null ? 0 : Number(cursor)
    if (!Number.isInteger(offset) || offset < 0) throw RequestError.invalidParams({ cursor }, "unknown cursor")
    const all = this.engineErrors(() => this.harness.engine.listSessions({ ...(cwd === null ? {} : { cwd }), ...(archived ? { includeArchived: true } : {}) }))
    const page = all.slice(offset, offset + LIST_PAGE)
    const sessions: SessionInfo[] = page.map((summary) => ({
      sessionId: summary.session.id,
      cwd: summary.session.cwd,
      title: summary.session.title,
      updatedAt: new Date(summary.updatedAt).toISOString(),
      _meta: {
        [META.capabilities]: {
          model: summary.session.settings.model,
          effort: summary.session.settings.reasoningEffort,
          ...(summary.session.archived ? { archived: true } : {}),
        },
      },
    }))
    return offset + LIST_PAGE < all.length ? { sessions, nextCursor: String(offset + LIST_PAGE) } : { sessions }
  }

  async closeSession(sessionId: string, shutdown = false): Promise<Record<string, never>> {
    const view = this.views.get(sessionId)
    if (view === undefined) return {}
    if (shutdown) {
      // As a process that exits: work in progress stops as a shutdown and stays resumable. The client hears every
      // event of it before the answer.
      await view.session.close()
      await view.drained()
      view.detach()
      return {}
    }
    await view.cancelAndWait()
    view.detach()
    // This session only: its work stops as a shutdown and it is let go of. The engine and its other sessions carry on.
    await view.session.close()
    return {}
  }

  async deleteSession(sessionId: string): Promise<Record<string, never>> {
    await this.closeSession(sessionId)
    // The soft delete: the session is archived (`session.archived`); its log stays.
    await this.engineErrors(() => this.harness.engine.archiveSession(sessionId as SessionId), sessionId, true)
    return {}
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    const view = this.requireView(sessionId)
    const current = view.settings
    const models = await this.catalog.list()
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
    view.session.setSettings(next)
    view.requested = next
    return { configOptions: await this.configOptions(next) }
  }

  // ---- the prompt turn ----

  async prompt(sessionId: string, blocks: readonly ContentBlock[], meta: Record<string, unknown> | null, signal: AbortSignal) {
    const view = this.requireView(sessionId)
    const text = requirePromptText(blocks)
    const delivery = meta?.[META.delivery] === "queue" ? "queue" : "steer"
    const maxSteps = stepLimit(meta?.[META.maxSteps])
    const messageId = view.session.send(text, { delivery, ...(maxSteps === undefined ? {} : { maxSteps }) })
    return view.waitFor(messageId, signal)
  }

  cancel(sessionId: string): void {
    this.views.get(sessionId)?.cancel()
  }

  /** `_<ns>/steer` and `_<ns>/queue`: admit input without waiting for the turn. */
  admit(sessionId: string, blocks: readonly ContentBlock[], delivery: "steer" | "queue", maxSteps: number | undefined) {
    const view = this.requireView(sessionId)
    const text = requirePromptText(blocks)
    const messageId = view.session.send(text, { delivery, ...(maxSteps === undefined ? {} : { maxSteps }) })
    view.echo.add(messageId)
    return { messageId }
  }

  async models() {
    // Asked for afresh, so that a client that lists the models hears why they cannot be listed.
    const models = await this.harness.listModels().catch((error: unknown) => {
      if (!(error instanceof ModelListError)) throw error
      const auth = error.error.kind === "auth"
      throw new RequestError(auth ? -32000 : -32603, `could not list the models: ${error.message}`, errorData({ reason: auth ? "auth_required" : "model_list_failed", message: error.message }))
    })
    return {
      defaultModel: this.harness.defaults.model,
      models: models.map((model) => ({ ...model, efforts: [...model.efforts] })),
    }
  }

  /** `_<ns>/revert` and `_<ns>/undo_revert`. With `handEdits: "ask"` (the default) the user is asked about files edited by hand. */
  async revert(params: RevertParams, undo: boolean): Promise<RevertResult> {
    const view = this.requireView(params.sessionId)
    const session = view.session
    const act = (options: Omit<RevertOptions, "messageId">) =>
      undo ? session.undoRevert(options) : session.revert({ ...options, ...(params.messageId === undefined ? {} : { messageId: params.messageId as MessageId }) })
    const dryRun = params.dryRun === true
    const asked = params.handEdits ?? "ask"
    if (dryRun || asked !== "ask") return act({ dryRun, handEdits: asked === "ask" ? "abort" : asked })
    const first = await act({ handEdits: "abort" })
    if (first.kind !== "hand_edited") return first
    const answer = await this.askHandEdits(view, first.plan, undo)
    // Declined: nothing changed, and the answer says why.
    return answer === null ? first : act({ handEdits: answer })
  }

  /** The hand-edit question, as a permission request about the restore. `null`: change nothing. */
  private async askHandEdits(view: SessionView, plan: RevertPlan, undo: boolean): Promise<HandEditPolicy | null> {
    const client = this.client
    if (client === null) return null
    const byHand = plan.changes.filter((change) => change.handEdited).map((change) => change.path)
    const cwd = view.session.projection().session.cwd
    const command = undo ? "undo_revert" : "revert"
    const files = byHand.length === 1 ? "1 file" : `${byHand.length} files`
    const request: RequestPermissionRequest = {
      sessionId: view.session.id,
      toolCall: {
        toolCallId: `${META.capabilities}-${command}-${plan.fromSeq}`,
        title: undo ? `Redo: overwrite ${files} edited by hand since the undo?` : `Undo: overwrite ${files} edited by hand since then?`,
        kind: "edit",
        status: "pending",
        locations: byHand.map((path) => ({ path: join(cwd, path) })),
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Edited by hand: ${byHand.join(", ")}. ${undo ? "Overwriting them cannot be taken back." : "Overwriting them is safe: undoing the undo brings them back."}`,
            },
          },
        ],
        rawInput: { command, plan },
      },
      options: [
        { optionId: HAND_EDIT_OPTIONS.overwrite, name: "Overwrite them", kind: "allow_once" },
        { optionId: HAND_EDIT_OPTIONS.keep, name: "Keep my edits, restore the rest", kind: "allow_once" },
        { optionId: HAND_EDIT_OPTIONS.cancel, name: "Change nothing", kind: "reject_once" },
      ],
      _meta: { [META.capabilities]: { command, plan, handEdited: byHand } },
    }
    const response = await client.request(methods.client.session.requestPermission, request)
    const outcome = response.outcome
    if (outcome.outcome !== "selected") return null
    if (outcome.optionId === HAND_EDIT_OPTIONS.overwrite) return "overwrite"
    if (outcome.optionId === HAND_EDIT_OPTIONS.keep) return "keep"
    return null
  }

  withdraw(sessionId: string, messageId: string) {
    const view = this.requireView(sessionId)
    return { withdrawn: view.session.withdraw(messageId as MessageId) }
  }

  async unarchive(sessionId: string): Promise<Record<string, never>> {
    await this.engineErrors(() => this.harness.engine.unarchiveSession(sessionId as SessionId), sessionId, true)
    return {}
  }

  sessionState(sessionId: string) {
    const view = this.requireView(sessionId)
    const projection = view.session.projection()
    const session = projection.session
    const state: SessionState = view.session.working ? "running" : session.execution?.status === "suspended" ? "suspended" : "idle"
    return {
      sessionId,
      state,
      cwd: session.cwd,
      title: session.title,
      model: view.settings.model,
      effort: view.settings.reasoningEffort,
      archived: session.archived,
      updatedAt: new Date(projection.updatedAt).toISOString(),
      lastSeq: projection.lastSeq,
      /** Admitted messages not yet delivered, oldest first. */
      inbox: projection.inbox.map((item) => ({ messageId: item.messageId, delivery: item.delivery })),
      canUndo: projection.messages.some((message) => message.kind === "user" && message.excluded === null),
      canRedo: session.reverts.length > 0,
    }
  }

  storedEvents(sessionId: string, afterSeq: number, limit: number | undefined) {
    const events = this.engineErrors(
      () => this.harness.engine.readEvents(sessionId as SessionId, { afterSeq, ...(limit === undefined ? {} : { limit }) }),
      sessionId,
    )
    return { events }
  }

  /** `_<ns>/resolve`: the command line's `--session <id or start of one>` and `--continue`. Signed out is refused first, as there. */
  async resolve(cwd: string, session: string | undefined) {
    if (!isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    await this.requireSignIn()
    const engine = this.harness.engine
    const id =
      session !== undefined
        ? this.engineErrors(() => engine.resolveSession(session))
        : (this.engineErrors(() => engine.latestSession(cwd))?.session.id ?? null)
    if (id === null) throw new RequestError(-32002, `there is no session to continue in ${cwd}`, errorData({ reason: "session_not_found", message: `there is no session to continue in ${cwd}` }))
    const summary = this.engineErrors(() => engine.getSession(id), id)
    if (summary === null) throw RequestError.sessionNotFound(id)
    return { sessionId: id, cwd: summary.session.cwd }
  }

  private async validate(cwd: string, asked: { readonly model: string | null; readonly effort: string | null }): Promise<void> {
    const settings = await this.harness.settingsFor(cwd, asked)
    const refused = await this.harness.engine.validateSettings(settings).then(
      () => null,
      (error: unknown) => error,
    )
    if (refused !== null)
      this.engineErrors(() => {
        throw refused
      })
  }

  // ---- shared ----

  async configOptions(settings: SessionSettings): Promise<SessionConfigOption[]> {
    return configOptionsFor(settings, await this.catalog.list())
  }

  sendUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    const client = this.client
    if (client === null || !this.fidelity.updates) return Promise.resolve()
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
      await Promise.all(views.map((view) => view.session.close().catch((error: unknown) => this.log.error(`closing ${view.session.id} failed: ${describeError(error)}`))))
    })()
    return this.closing
  }

  forget(view: SessionView): void {
    if (this.views.get(view.session.id) === view) this.views.delete(view.session.id)
  }

  private attach(session: EngineSession, cwd: string, fromSeq: number, prime?: (translator: Translator) => Output[]): SessionView {
    const view = new SessionView(this, session, cwd, fromSeq)
    if (prime !== undefined) view.queueOutputs(prime(view.translator), true)
    view.listen()
    this.views.set(session.id, view)
    return view
  }

  private requireView(sessionId: string): SessionView {
    const view = this.views.get(sessionId)
    if (view === undefined) throw RequestError.sessionNotFound(sessionId)
    return view
  }

  private async requireSignIn(): Promise<void> {
    const state = await this.harness.signIn()
    if (!state.signedIn)
      throw RequestError.authRequired({ methodId: AUTH_METHOD_ID, ...errorData({ reason: "auth_required", message: state.message }) }, `${state.message} To sign in, ${SIGN_IN_HINT}.`)
  }

  /**
   * Turns what the engine refuses into the protocol's errors: an unknown
   * session is `session not found`; a session another process is working in
   * is an error that names the process; a harness that is shutting down says
   * so. With `absentIsFine`, a session that does not exist is no error (a
   * delete of something already gone).
   */
  private engineErrors<T>(work: () => T, sessionId?: string, absentIsFine?: false): T
  private engineErrors<T>(work: () => Promise<T>, sessionId: string, absentIsFine: true): Promise<T | undefined>
  private engineErrors<T>(work: () => T | Promise<T>, sessionId?: string, absentIsFine = false): T | Promise<T | undefined> {
    const translate = (error: unknown): never => {
      if (error instanceof EngineError && error.code === "session_in_use")
        throw new RequestError(-32603, error.message, errorData({ reason: "session_in_use", holderPid: error.holderPid, message: error.message }))
      if (error instanceof EngineError && error.code === "session_not_found")
        throw new RequestError(-32002, "Resource not found", { sessionId: sessionId ?? "", ...errorData({ reason: "session_not_found", message: error.message }) })
      if (error instanceof EngineError && (error.code === "ambiguous_session" || error.code === "unknown_model"))
        throw new RequestError(-32602, error.message, errorData({ reason: error.code, message: error.message }))
      if (error instanceof EngineError) throw new RequestError(-32603, error.message, { reason: error.message, ...errorData({ reason: "closed", message: error.message }) })
      if (error instanceof StoreError && error.code === "schema_mismatch") {
        const message = `that session was written by another version of ${brand.name} and cannot be opened by this one (${error.message})`
        throw new RequestError(-32603, message, errorData({ reason: "schema_mismatch", message }))
      }
      if (this.harness.closed) throw RequestError.internalError({ reason: "shutting down" }, `${brand.name} is shutting down`)
      throw error
    }
    try {
      const result = work()
      if (!(result instanceof Promise)) return result
      return result.catch((error: unknown) => {
        if (absentIsFine && error instanceof EngineError && error.code === "session_not_found") return undefined
        return translate(error)
      })
    } catch (error) {
      return translate(error)
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
    readonly session: EngineSession,
    cwd: string,
    private fromSeq: number,
  ) {
    const catalog = connection.catalog
    const capabilities = connection.clientCapabilities
    this.translator = new Translator({
      sessionId: session.id,
      cwd,
      log: connection.log,
      notices: capabilities.session?.notices != null,
      compaction: capabilities.session?.compaction != null,
      contextWindow: (model) => catalog.cached().find((entry) => entry.id === model)?.contextWindow ?? null,
      echo: (messageId) => this.echo.has(messageId),
    })
  }

  get settings(): SessionSettings {
    return this.requested ?? this.session.projection().session.settings
  }

  listen(): void {
    // Handled after whatever produced the event has returned, in order: a prompt's sender registers what it
    // waits for before its own `inbox.enqueued` is looked at here.
    this.unlisten = this.session.subscribe((item) => queueMicrotask(() => this.onEvent(item)))
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
  waitFor(messageId: string, signal: AbortSignal): Promise<{ stopReason: StopReason; _meta?: Record<string, unknown> }> {
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
    const withdrawn = this.withdraw(waiting.map((pending) => pending.messageId))
    if (withdrawn.size > 0) this.settle((pending) => withdrawn.has(pending.messageId), { kind: "stop", stopReason: "cancelled" })
    this.session.interrupt()
  }

  async cancelAndWait(): Promise<void> {
    this.cancel()
    await this.session.settled()
    await this.flushed()
  }

  /**
   * Withdraws prompts that were not delivered yet (`inbox.cancelled`,
   * through the engine). The loop reads the inbox at every boundary, so one
   * withdrawn here never reaches the model. Returns the ones that were still
   * waiting; a prompt already delivered is left alone.
   */
  private withdraw(messageIds: readonly string[]): Set<string> {
    return new Set(
      messageIds.filter((messageId) => {
        try {
          return this.session.withdraw(messageId as MessageId)
        } catch (error) {
          this.connection.log.warn(`could not withdraw a waiting message in ${this.session.id}: ${describeError(error)}`)
          return false
        }
      }),
    )
  }

  queueOutputs(outputs: readonly Output[], replay: boolean): void {
    for (const output of outputs) this.handleOutput(output, replay, null)
  }

  /** One harness event as is, for a client that asked for them (`ClientMeta.events`). */
  queueEvent(item: EngineEvent, replay: boolean): void {
    const params = { sessionId: this.session.id, event: item, ...(replay ? { replay: true } : {}) }
    this.enqueue(() => this.connection.sendExt(EXT.event, params))
  }

  /** Resolves once every event the session has produced so far has been handled and sent. */
  async drained(): Promise<void> {
    for (;;) {
      // Events are handled a microtask after they happen, and handling one may queue more sends.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const outbox = this.outbox
      await outbox
      if (outbox === this.outbox) return
    }
  }

  /** After a load or resume: the title, the context use, and whether the session is working, idle or suspended. */
  syncState(history: readonly StoredEvent[]): void {
    const projection = this.session.projection()
    const session = projection.session
    this.enqueue(() =>
      this.connection.sendUpdate(this.session.id, {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt: new Date(projection.updatedAt).toISOString(),
      }),
    )
    const last = lastUsage(history)
    const size = last === null ? null : (this.connection.catalog.cached().find((model) => model.id === last.model)?.contextWindow ?? null)
    if (last !== null && size !== null)
      this.enqueue(() => this.connection.sendUpdate(this.session.id, { sessionUpdate: "usage_update", used: last.used, size }))
    const state: SessionState = this.session.working ? "running" : session.execution?.status === "suspended" ? "suspended" : "idle"
    const params: StateNotification = { sessionId: this.session.id, state }
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
    if (this.connection.fidelity.events) this.queueEvent(item, false)
    for (const output of this.translator.translate(item)) this.handleOutput(output, false, seq)
  }

  private handleOutput(output: Output, replay: boolean, seq: number | null): void {
    switch (output.type) {
      case "update": {
        const update = output.update
        this.enqueue(() => this.connection.sendUpdate(this.session.id, update))
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
          this.connection.sendUpdate(this.session.id, { sessionUpdate: "config_option_update", configOptions: await this.connection.configOptions(settings) }),
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
      const withdrawn = this.withdraw(stranded.map((pending) => pending.messageId))
      this.settle((pending) => withdrawn.has(pending.messageId), end)
    }
  }

  private settle(which: (pending: Pending) => boolean, end: TurnEnd): void {
    const chosen = this.pending.filter(which)
    if (chosen.length === 0) return
    for (const pending of chosen) this.pending.splice(this.pending.indexOf(pending), 1)
    // Every update sent so far goes out before the answer.
    void this.outbox.then(() => {
      const meta = end.turn === undefined ? {} : { _meta: { [META.capabilities]: turnMeta(end.turn) } }
      for (const pending of chosen) {
        if (end.kind === "stop") pending.resolve({ stopReason: end.stopReason, ...meta })
        else pending.reject(failure(end))
      }
    })
  }

  private enqueue(send: () => Promise<void>): void {
    this.outbox = this.outbox.then(send).catch((error: unknown) => {
      if (!this.connection.connectionClosed) this.connection.log.warn(`could not send an update for ${this.session.id}: ${describeError(error)}`)
    })
  }
}

/** A failed turn, as the error `session/prompt` answers with. Signed out is the protocol's auth-required error. */
function failure(end: Extract<TurnEnd, { kind: "failed" }>): RequestError {
  if (end.providerError?.kind === "auth")
    return RequestError.authRequired({ methodId: AUTH_METHOD_ID, ...errorData({ reason: "auth_required", message: end.message }) }, `${end.message} To sign in, ${SIGN_IN_HINT}.`)
  const data: Record<string, unknown> = { [META.capabilities]: { reason: "execution_failed" } }
  if (end.providerError !== null) data[META.capabilities] = { reason: "execution_failed", providerError: end.providerError.kind }
  return new RequestError(-32603, end.message, data)
}

/** The turn as the prompt response's `_meta[<ns>]` carries it: everything `<prefix>/turn` says but the session. */
function turnMeta(turn: NonNullable<TurnEnd["turn"]>): Record<string, unknown> {
  const { sessionId: _, ...rest } = turn
  return rest
}

/** `data[<ns>]` of an error. */
function errorData(data: ErrorData): Record<string, unknown> {
  return { [META.capabilities]: data }
}

/** The value under the namespace key of a `_meta` object, when it is an object. */
function namespaced(meta: unknown): Record<string, unknown> | null {
  if (typeof meta !== "object" || meta === null) return null
  const value = (meta as Record<string, unknown>)[META.capabilities]
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function openMeta(meta: unknown): OpenMeta | null {
  const value = namespaced(meta)
  if (value === null) return null
  const text = (key: string) => {
    const field = value[key]
    if (field === undefined || field === null) return null
    if (typeof field !== "string" || field === "") throw RequestError.invalidParams({ [key]: field }, `_meta.${META.capabilities}.${key} must be a non-empty string`)
    return field
  }
  return { model: text("model"), effort: text("effort"), archived: value.archived === true }
}

function stepLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw RequestError.invalidParams({ maxSteps: value }, "maxSteps must be a whole number of at least 1")
  return value
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw RequestError.invalidParams(undefined, "expected an object of params")
  return raw as Record<string, unknown>
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== "string" || value === "") throw RequestError.invalidParams(undefined, `${key} must be a non-empty string`)
  return value
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  return params[key] === undefined || params[key] === null ? undefined : requireString(params, key)
}

function optionalInteger(params: Record<string, unknown>, key: string, min: number): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw RequestError.invalidParams(undefined, `${key} must be a whole number of at least ${min}`)
  return value
}

function parseRevertParams(raw: unknown): RevertParams {
  const params = parseObject(raw)
  const sessionId = requireString(params, "sessionId")
  const messageId = optionalString(params, "messageId")
  if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") throw RequestError.invalidParams(undefined, "dryRun must be a boolean")
  const handEdits = params.handEdits
  if (handEdits !== undefined && handEdits !== "ask" && handEdits !== "abort" && handEdits !== "overwrite" && handEdits !== "keep")
    throw RequestError.invalidParams(undefined, 'handEdits must be "ask", "abort", "overwrite" or "keep"')
  return {
    sessionId,
    ...(messageId === undefined ? {} : { messageId }),
    ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun as boolean }),
    ...(handEdits === undefined ? {} : { handEdits }),
  }
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
function parseInputParams(raw: unknown): { sessionId: string; prompt: ContentBlock[]; maxSteps: number | undefined } {
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
  return { sessionId: value.sessionId, prompt: value.prompt as ContentBlock[], maxSteps: stepLimit(value.maxSteps) }
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
