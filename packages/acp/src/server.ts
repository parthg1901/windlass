/**
 * The ACP v1 agent: one instance per client connection, on top of the
 * process's harness (`createHarness` in `@windlass/core`, the same
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
  type AgentListing,
  type CallId,
  EngineError,
  type EngineEvent,
  type EngineSession,
  type EventData,
  type Harness,
  type HandEditPolicy,
  type MessageId,
  type ModelEntry,
  ModelListError,
  type OutputWatchRequest,
  type ReplayRequest,
  type RevertOptions,
  type RevertPlan,
  type RevertResult,
  type SessionFeature,
  type SessionId,
  type SessionSettings,
  type StoredEvent,
  StoreError,
  approvalModes,
  brand,
  currentTodos,
  describeRestrictions,
  renderReplayReport,
  restrictionTag,
} from "@windlass/core"
import { type FileChange, type SnapshotId, type Snapshots, openSnapshots } from "../../core/src/snapshot/index.ts"
import { DEFAULT_NORMALISERS } from "../../core/src/engine/replay.ts"
import { describeWatch } from "../../core/src/engine/spawn.ts"
import type { CommandExpansion } from "../../core/src/engine/commands.ts"
import type { Expansion } from "../../core/src/commands/expand.ts"
import type { CommandListing, ListedCommand } from "../../core/src/commands/lookup.ts"
import { compareReplay, renderComparison } from "../../core/src/replay/effects.ts"
import {
  type AgentsResult,
  APPROVAL_META,
  type CancelCallResult,
  type ApprovalRequestMeta,
  type ApprovalStateResult,
  type ClientCommand,
  type ClientMeta,
  type CommandInfo,
  type CommandsResult,
  type CompactResult,
  type DiffFile,
  type DiffResult,
  type ErrorData,
  type ExpandCommandResult,
  type ExpansionReport,
  EXT,
  type ForkParams,
  type ForkResult,
  HAND_EDIT_OPTIONS,
  META,
  type OpenMeta,
  type ReplayParams,
  type ReplayResult,
  type RevertParams,
  type SendCommandResult,
  type SubagentRef,
  type WatchSetResult,
  type WatchesResult,
  type SessionState,
  type StateNotification,
  handEditSentences,
  sessionTitle,
} from "./extensions.ts"
import { hookFailure, hooksState, lspState, mcpState, memoryChange, memoryKind, memoryState, skillsState, wakeCancel, wakeCreate, wakeCreateParams, wakeList, wakeSecret } from "./features.ts"
import { type Logger, describeError } from "./log.ts"
import { type ModelCatalog, catalogOf } from "./models.ts"
import { promptText, slashEntry } from "./prompt.ts"
import { type Output, Translator, type TurnEnd } from "./translate.ts"

/** The instruction a signed-out user gets. */
export const SIGN_IN_HINT = `run \`${brand.binary} login\` and finish the ChatGPT sign-in, then try again`

/** The one auth method: the ChatGPT-plan sign-in, which the user completes outside the client. */
export const AUTH_METHOD_ID = "chatgpt"

export const CONFIG = { model: "model", effort: "effort", approval: "approval", agent: "agent" } as const
/** The value of the `agent` option that means no agent (the engine's `NO_AGENT`). */
const NO_AGENT_VALUE = "none"
const UNATTENDED = ["deny", "stop"] as const
const DEFAULT_EFFORT_VALUE = "default"
const LIST_PAGE = 100
/** How many of the latest turns a `session/load` replays the changed files of. */
const REPLAYED_TURN_CHANGES = 50
/** How long the answer to a compaction asked for while idle waits for the execution that made it to end. */
const COMPACT_SETTLE_MS = 2000

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

/** The snapshot of a replay's copy of the workspace as it ended, for comparing the files it ended with. */
async function snapshotOfCopy(copy: string, dataDir: string, session: string): Promise<string | null> {
  const snapshots = await openSnapshots(copy, { dataDir: join(dataDir, "snapshots") }).catch(() => null)
  if (snapshots === null || snapshots.kind !== "ready") return null
  return (await snapshots.take({ session }).catch(() => null))?.id ?? null
}

/** Advertised in `initialize` under `agentCapabilities._meta[<ns>]`. */
export const EXTENSION_CAPABILITIES = {
  methods: [EXT.steer, EXT.queue, EXT.models, EXT.revert, EXT.undoRevert, EXT.withdraw, EXT.unarchive, EXT.session, EXT.events, EXT.resolve, EXT.approval, EXT.clearTaint, EXT.diff, EXT.fork, EXT.replay, EXT.mcp, EXT.mcpApprove, EXT.hooks, EXT.hookApprove, EXT.lsp, EXT.lspApprove, EXT.skills, EXT.wakeups, EXT.wakeCreate, EXT.wakeCancel, EXT.wakeSecret, EXT.memory, EXT.memoryChange, EXT.agents, EXT.rename, EXT.compact, EXT.commands, EXT.expandCommand, EXT.sendCommand, EXT.cancelCall, EXT.watch, EXT.unwatch, EXT.watches],
  notifications: [EXT.usage, EXT.state, EXT.turn, EXT.diagnostic, EXT.event, EXT.taint, EXT.notice, EXT.replayStarted, EXT.child, EXT.mcpChanged, EXT.hooksChanged, EXT.lspChanged],
  promptMeta: [META.delivery, META.maxSteps],
  /**
   * Slash commands: `session/prompt` expands a prompt that is `/name args` for a command file (and refuses one that
   * names none, with the sentence to show); the commands are advertised with `available_commands_update`.
   */
  commands: true,
  /** Keys of `clientCapabilities._meta[<ns>]` this server reads (`ClientMeta`). */
  clientMeta: ["events", "updates"],
  /** Keys of `_meta[<ns>]` on `session/new`, `session/load` and `session/resume` (`OpenMeta`). */
  openMeta: ["model", "effort", "agent", "approval", "unattended", "attended", "children"],
  /** The permission requests this server sends: the hand-edit question of an undo, and the approval of a tool call (the session's own, or a subagent's). */
  permissionRequests: ["revert", APPROVAL_META],
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
    .onRequest(EXT.approval, parseObject, ({ params }) =>
      state.approval(requireString(params, "sessionId"), {
        mode: oneOfOrNull(params.mode, approvalModes, "mode"),
        unattended: oneOfOrNull(params.unattended, UNATTENDED, "unattended"),
        attended: typeof params.attended === "boolean" ? params.attended : null,
      }),
    )
    .onRequest(EXT.clearTaint, parseObject, ({ params }) => state.clearTaint(requireString(params, "sessionId")))
    .onRequest(EXT.diff, parseObject, ({ params }) => {
      if (params.patch !== undefined && typeof params.patch !== "boolean") throw RequestError.invalidParams(undefined, "patch must be a boolean")
      return state.diff(requireString(params, "sessionId"), { executionId: optionalString(params, "executionId"), messageId: optionalString(params, "messageId"), patch: params.patch !== false })
    })
    .onRequest(EXT.fork, parseForkParams, ({ params }) => state.fork(params))
    .onRequest(EXT.replay, parseReplayParams, ({ params, signal }) => state.replay(params, signal))
    .onRequest(EXT.mcp, parseObject, ({ params }) => mcpState(state.view(requireString(params, "sessionId")).session))
    .onRequest(EXT.mcpApprove, parseObject, ({ params }) => state.approveMcp(requireString(params, "sessionId"), requireString(params, "name"), optionalString(params, "fingerprint")))
    .onRequest(EXT.hooks, parseObject, ({ params }) => state.view(requireString(params, "sessionId")).hooks())
    .onRequest(EXT.hookApprove, parseObject, ({ params }) => state.approveHook(requireString(params, "sessionId"), requireString(params, "fingerprint")))
    .onRequest(EXT.lsp, parseObject, ({ params }) => lspState(state.view(requireString(params, "sessionId")).session))
    .onRequest(EXT.lspApprove, parseObject, ({ params }) => state.approveLsp(requireString(params, "sessionId"), requireString(params, "name"), optionalString(params, "fingerprint")))
    .onRequest(EXT.skills, parseObject, ({ params }) => skillsState(state.view(requireString(params, "sessionId")).session))
    .onRequest(EXT.wakeups, parseObject, ({ params }) => wakeList(state.harness, state.view(requireString(params, "sessionId")).session.id))
    .onRequest(EXT.wakeCreate, parseObject, ({ params }) => {
      const parsed = wakeCreateParams(state.view(requireString(params, "sessionId")).session.id, params)
      if ("problem" in parsed) throw RequestError.invalidParams(undefined, parsed.problem)
      return wakeCreate(state.harness, parsed)
    })
    .onRequest(EXT.wakeCancel, parseObject, ({ params }) => wakeCancel(state.harness, state.view(requireString(params, "sessionId")).session.id, requireString(params, "id")))
    .onRequest(EXT.wakeSecret, parseObject, ({ params }) => wakeSecret(state.harness, state.view(requireString(params, "sessionId")).session.id, requireString(params, "id")))
    .onRequest(EXT.agents, parseObject, ({ params }) => state.agents(optionalString(params, "sessionId"), optionalString(params, "cwd")))
    .onRequest(EXT.rename, parseObject, ({ params }) => {
      if (typeof params.title !== "string") throw RequestError.invalidParams(undefined, "title must be a string")
      return state.rename(requireString(params, "sessionId"), params.title)
    })
    .onRequest(EXT.compact, parseObject, ({ params }) => state.compact(requireString(params, "sessionId")))
    .onRequest(EXT.commands, parseObject, ({ params }) => state.commands(optionalString(params, "sessionId"), optionalString(params, "cwd"), clientCommands(params.builtins)))
    .onRequest(EXT.expandCommand, parseObject, ({ params }) => state.expandCommand(requireString(params, "sessionId"), requireString(params, "name"), typeof params.args === "string" ? params.args : "", clientCommands(params.builtins)))
    .onRequest(EXT.sendCommand, parseObject, ({ params }) =>
      state.sendCommand(requireString(params, "sessionId"), requireString(params, "name"), typeof params.args === "string" ? params.args : "", {
        delivery: oneOfOrNull(params.delivery, ["steer", "queue"] as const, "delivery") ?? "steer",
        maxSteps: stepLimit(params.maxSteps),
        builtins: clientCommands(params.builtins),
      }),
    )
    .onRequest(EXT.cancelCall, parseObject, ({ params }) =>
      state.cancelCall(requireString(params, "sessionId"), { callId: requireString(params, "callId"), messageId: optionalString(params, "messageId"), childSessionId: optionalString(params, "childSessionId") }),
    )
    .onRequest(EXT.watch, parseObject, ({ params }) => {
      if (params.regex !== undefined && typeof params.regex !== "boolean") throw RequestError.invalidParams(undefined, "regex must be a boolean")
      if (params.ignoreCase !== undefined && typeof params.ignoreCase !== "boolean") throw RequestError.invalidParams(undefined, "ignoreCase must be a boolean")
      if (typeof params.pattern !== "string") throw RequestError.invalidParams(undefined, "pattern must be a string")
      return state.watch(requireString(params, "sessionId"), requireString(params, "command"), {
        pattern: params.pattern,
        ...(params.regex === undefined ? {} : { regex: params.regex }),
        ...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
      })
    })
    .onRequest(EXT.unwatch, parseObject, ({ params }) => state.unwatch(requireString(params, "sessionId"), requireString(params, "watchId")))
    .onRequest(EXT.watches, parseObject, ({ params }) => state.watches(requireString(params, "sessionId")))
    .onRequest(EXT.memory, parseObject, ({ params }) => memoryState(state.view(requireString(params, "sessionId")).session))
    .onRequest(EXT.memoryChange, parseObject, ({ params }) => {
      const action = oneOfOrNull(params.action, ["remember", "retract", "confirm", "reject", "renew"] as const, "action")
      if (action === null) throw RequestError.invalidParams(undefined, "action must be one of: remember, retract, confirm, reject, renew")
      const scope = oneOfOrNull(params.scope, ["user", "project"] as const, "scope")
      const kind = memoryKind(params.kind)
      return memoryChange(state.view(requireString(params, "sessionId")).session, {
        sessionId: requireString(params, "sessionId"),
        action,
        ...(typeof params.text === "string" ? { text: params.text } : {}),
        ...(scope === null ? {} : { scope }),
        ...(kind === undefined ? {} : { kind }),
        ...(typeof params.id === "string" ? { id: params.id } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      })
    })
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
  private readonly snapshotStores = new Map<string, Promise<Snapshots | { readonly message: string }>>()
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
    // A model or an effort the client names is checked before a session is created with it, as the command line does.
    if (asked.model !== null || asked.effort !== null) await this.validate(cwd, asked)
    const settings = await this.harness.settingsFor(cwd, asked)
    // As the agent the client names; without one, as the default of the user's configuration, if any.
    const agent = meta?.agent ?? null
    const session = this.engineErrors(() => this.harness.engine.createSession({ cwd, settings, ...(agent === null ? {} : { agent }) }))
    applyApproval(session, meta)
    const view = this.attach(session, cwd, session.projection().lastSeq, new Map())
    view.children = meta?.children !== false
    // A full-fidelity client gets the session from its first event, as the engine's own stream has it.
    if (this.fidelity.events) for (const item of session.readEvents()) view.queueEvent(item, false)
    await view.flushed()
    // After the answer: a client learns the session's ID from it, and the commands are about that session.
    setTimeout(() => {
      view.advertiseCommands()
      view.lookAtFeatures()
    }, 0)
    return { sessionId: session.id, configOptions: await this.configOptions(view.settings, view.session) }
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
    // The files each earlier turn changed, from its snapshots, for the replayed turn endings. Read before the open: the
    // turns that have ended are history and do not change.
    const changes = replay ? await this.replayChanges(sessionId as SessionId, cwd) : new Map<string, readonly string[]>()
    // What the log held before this open: events after it (a crashed claim's recovery) are news to a client.
    const openedAt = summary.lastSeq
    // A claim left by a process that died is repaired here; a suspended one (a clean shutdown in the middle of a
    // turn) stays suspended until the user says something, so their words are in front of the model in the first
    // step after the restart. A session another process holds is refused, with that process named.
    const session = this.engineErrors(() => this.harness.engine.openSession(sessionId as SessionId, { resume: "wait" }), sessionId)
    applyApproval(session, meta)
    // Read, translate and queue the stored log before listening, all in this synchronous block, so that a live
    // event either is in the log read here or arrives after it, never both and never neither.
    const history = session.readEvents()
    const lastSeq = history.at(-1)?.seq ?? 0
    const view = this.attach(session, cwd, lastSeq, changes, (prime) => {
      // Without a replay the log is still folded, so the translator knows the model and the calls in it. A
      // full-fidelity client gets the log as it is, each event before what it translates to (a turn's ending after
      // the turn): all of it on a load (marked as a replay up to this open), and on either the events this open
      // appended, which are what a live session would have streamed.
      for (const item of history) {
        prime.noteHook(item)
        if (this.fidelity.events && (replay || item.seq > openedAt)) prime.queueEvent(item, item.seq <= openedAt)
        const outputs = prime.translator.translate(item, true)
        if (replay) prime.queueOutputs(outputs.filter((output) => output.type === "update" || (output.type === "ext" && output.method === EXT.turn)), true)
      }
    })
    view.children = meta?.children !== false
    view.syncState(history)
    try {
      // As the command line does on --session and --continue: the model or effort named is switched to, durably.
      if (asked.model !== null || asked.effort !== null) {
        const current = session.projection().session.settings
        this.engineErrors(() => session.setSettings({ model: asked.model ?? current.model, reasoningEffort: asked.effort ?? current.reasoningEffort }))
      }
      // The agent named is switched to, as `--agent` with `--session` asks: recorded as `agent.switched`.
      const agent = meta?.agent ?? null
      if (agent !== null) this.engineErrors(() => session.setAgent(agent))
    } catch (error) {
      // Refused (an effort the model does not take, an agent that does not exist): the session is not left open here.
      view.detach()
      await session.close().catch(() => {})
      throw error
    }
    // What the open itself switched (`settings.changed`, `agent.switched`) reaches the client before the answer.
    if (asked.model !== null || asked.effort !== null || (meta?.agent ?? null) !== null) await view.drained()
    view.advertiseCommands()
    await view.flushed()
    // After the answer, as for a new session: what the configuration names is told once the session is open.
    setTimeout(() => view.lookAtFeatures(), 0)
    return { configOptions: await this.configOptions(view.settings, view.session) }
  }

  async listSessions(cwd: string | null, cursor: string | null, archived = false): Promise<ListSessionsResponse> {
    if (cwd !== null && !isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    // A page at a time, from the engine: its cursor is a place in the order (when a session was last updated, then
    // its ID), so nothing is kept here between two pages, and sessions that arrive meanwhile change no later page.
    // A cursor the engine did not give is refused as a bad request.
    const listed = this.engineErrors(() =>
      this.harness.engine.listSessionsPage({ ...(cwd === null ? {} : { cwd }), ...(archived ? { includeArchived: true } : {}), limit: LIST_PAGE, cursor }),
    )
    const sessions: SessionInfo[] = listed.sessions.map((summary) => ({
      sessionId: summary.session.id,
      cwd: summary.session.cwd,
      title: sessionTitle(summary.session.title, summary.firstPrompt),
      updatedAt: new Date(summary.updatedAt).toISOString(),
      _meta: {
        [META.capabilities]: {
          model: summary.session.settings.model,
          effort: summary.session.settings.reasoningEffort,
          ...(summary.session.archived ? { archived: true } : {}),
          // A fork names what it was forked from, so a listing can tell it from its parent.
          ...(summary.session.lineage?.kind === "fork" ? { forkedFrom: summary.session.lineage.parentSessionId, forkedThroughSeq: summary.session.lineage.throughSeq } : {}),
        },
      },
    }))
    return listed.nextCursor === null ? { sessions } : { sessions, nextCursor: listed.nextCursor }
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
    if (configId === CONFIG.approval) {
      // The user's own choice for this session; the project's file can still only tighten it.
      view.session.setApproval({ mode: oneOfOrNull(value, approvalModes, "value") ?? "auto" })
      return { configOptions: await this.configOptions(current, view.session) }
    }
    if (configId === CONFIG.agent) {
      // The switch: made now while the session is idle, at the next step boundary while a turn runs. Its record
      // (`agent.switched`) is what a client shows, and `config_option_update` follows it.
      this.engineErrors(() => view.session.setAgent(value))
      return { configOptions: await this.configOptions(view.settings, view.session) }
    }
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
      if (value !== DEFAULT_EFFORT_VALUE && !efforts.includes(value) && value !== current.reasoningEffort) {
        const message = `model ${current.model} does not offer the reasoning effort "${value}"; it accepts: ${efforts.length === 0 ? "none (it has no reasoning efforts)" : efforts.join(", ")}`
        throw new RequestError(-32602, message, { configId, value, ...errorData({ reason: "unknown_effort", message }) })
      }
      next = { model: current.model, reasoningEffort: value === DEFAULT_EFFORT_VALUE ? null : value }
    } else throw RequestError.invalidParams({ configId }, `unknown config option ${configId}`)
    this.engineErrors(() => view.session.setSettings(next))
    view.requested = next
    return { configOptions: await this.configOptions(next, view.session) }
  }

  // ---- the prompt turn ----

  async prompt(sessionId: string, blocks: readonly ContentBlock[], meta: Record<string, unknown> | null, signal: AbortSignal) {
    const view = this.requireView(sessionId)
    const text = requirePromptText(blocks)
    const delivery = meta?.[META.delivery] === "queue" ? "queue" : "steer"
    const maxSteps = stepLimit(meta?.[META.maxSteps])
    const options = { delivery, ...(maxSteps === undefined ? {} : { maxSteps }) } as const
    // The commands as they are now: a file added since the session was opened is offered from here on.
    view.advertiseCommands()
    // `/name args` is a command file's, or nothing: a name no file has is refused with the close names, and no
    // request is sent. `//text` is the text `/text`. A client has run its own commands before it sends.
    const entry = view.session.commands() === null ? null : slashEntry(text)
    const messageId = entry === null ? view.session.send(text, options) : entry.kind === "text" ? view.session.send(entry.text, options) : this.engineErrors(() => view.session.sendCommand(entry.name, entry.args, options)).messageId
    return view.waitFor(messageId, signal)
  }

  /** `_<ns>/commands`: the command files of a session open here, or of a directory, as they are now. */
  commands(sessionId: string | undefined, cwd: string | undefined, builtins: readonly ClientCommand[]): CommandsResult {
    if (sessionId === undefined && cwd === undefined) throw RequestError.invalidParams(undefined, "sessionId or cwd is needed")
    if (cwd !== undefined && !isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    const listing = this.engineErrors(() => (sessionId === undefined ? this.harness.engine.listCommands(cwd!, builtins) : this.requireView(sessionId).session.commands(builtins)))
    return commandsResult(listing)
  }

  /** `_<ns>/expand_command`: what `/name args` would send, and what expansion has to say about it. Nothing is sent. */
  expandCommand(sessionId: string, name: string, args: string, builtins: readonly ClientCommand[]): ExpandCommandResult {
    const found = this.engineErrors(() => this.requireView(sessionId).session.expandCommand(name, args, builtins))
    if (found === null) return { kind: "unavailable", message: "this engine offers no slash commands" }
    return expandResult(found)
  }

  /**
   * `_<ns>/send_command`: the command file of that name is expanded with
   * what was typed after it and admitted as the user's message, and the log
   * records which file produced it (`command.expanded`). Refused, with the
   * sentence to show and nothing sent, when no file has the name (the close
   * names of the client's own commands and of the files are suggested), the
   * file cannot be used, or the agent it names cannot be found.
   */
  sendCommand(sessionId: string, name: string, args: string, options: { readonly delivery: "steer" | "queue"; readonly maxSteps: number | undefined; readonly builtins: readonly ClientCommand[] }): SendCommandResult {
    const view = this.requireView(sessionId)
    // Looked up with the client's own commands first: the refusal then names the nearest of both.
    const found = this.engineErrors(() => view.session.findCommand(name, options.builtins))
    if (found !== null && found.kind !== "command") {
      const message = found.kind === "builtin" ? `/${found.name} is a command of the client's own` : found.message
      throw new RequestError(-32602, message, errorData({ reason: "invalid_request", message }))
    }
    const sent = this.engineErrors(() => view.session.sendCommand(name, args, { delivery: options.delivery, ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }) }))
    view.echo.add(sent.messageId)
    return { messageId: sent.messageId, command: commandInfo({ ...listed(sent.command), hiddenBy: null }), ...expansionReport(sent.expansion) }
  }

  cancel(sessionId: string): void {
    this.views.get(sessionId)?.cancel()
  }

  /**
   * `_<ns>/cancel_call`: the user stops one running tool call and nothing
   * else (`EngineSession.cancelCall`); the turn goes on, and the call
   * settles like any running call, with a result that says what came of
   * it. When the engine does not take the request, why is said from what
   * the log holds about the call.
   */
  cancelCall(sessionId: string, target: { readonly callId: string; readonly messageId: string | undefined; readonly childSessionId: string | undefined }): CancelCallResult {
    const session = this.requireView(sessionId).session
    const stopped = this.engineErrors(() =>
      session.cancelCall({
        callId: target.callId as CallId,
        ...(target.messageId === undefined ? {} : { messageId: target.messageId as MessageId }),
        ...(target.childSessionId === undefined ? {} : { sessionId: target.childSessionId as SessionId }),
      }),
    )
    if (stopped) return { stopped: true, message: null }
    // A subagent's call is in the subagent's own log, which this session does not hold.
    if (target.childSessionId !== undefined) return { stopped: false, message: "That call of the subagent is not running, or the subagent has ended. Nothing was stopped." }
    const projection = session.projection()
    const execution = projection.session.execution
    if (execution === null || execution.status !== "running") return { stopped: false, message: "No turn is running, so no call is. Nothing was stopped." }
    if (execution.interrupting !== null) return { stopped: false, message: "The whole turn is being stopped, which stops every call in it." }
    const part = projection.messages
      .flatMap((message) => (message.kind === "assistant" && (target.messageId === undefined || message.id === target.messageId) ? message.parts : []))
      .findLast((candidate) => candidate.type === "tool_call" && candidate.callId === target.callId)
    if (part?.type !== "tool_call") return { stopped: false, message: `There is no call ${target.callId} in the step in progress. Nothing was stopped.` }
    if (part.cancel !== undefined && part.state.status === "running") return { stopped: false, message: "That call was already asked to stop; it ends once its tool has stopped." }
    if (part.state.status === "running") return { stopped: false, message: "That call cannot be stopped from here (it is answered from a recording, or its tool has already come back). Nothing was stopped." }
    if (part.state.status === "pending") return { stopped: false, message: "That call has not started yet, so there is nothing to stop; Ctrl-C stops the whole turn." }
    return { stopped: false, message: "That call already has its result. Nothing was stopped." }
  }

  /**
   * `_<ns>/watch`: the user sets a watch on the output of a background
   * command that is running (`EngineSession.watchOutput`): the model is
   * told, without polling, when the command prints a line that matches.
   * What the engine refuses (no such command runs, a pattern it cannot
   * use, too many watches) is a bad request with the engine's sentence.
   * Answered after the watch's events (`watch.started`, and `watch.fired`
   * for a line the command had already printed) were sent.
   */
  async watch(sessionId: string, command: string, request: OutputWatchRequest): Promise<WatchSetResult> {
    const view = this.requireView(sessionId)
    const set = this.engineErrors(() => view.session.watchOutput(command, request))
    await view.drained()
    return { watchId: set.watchId, spawnId: set.spawnId, pattern: set.pattern, regex: set.regex, ignoreCase: set.ignoreCase, limit: set.limit, fired: set.fired }
  }

  /** `_<ns>/unwatch`: removes a watch that could still fire (`watch.ended`, `removed`); `false` for one that is over or unknown. */
  async unwatch(sessionId: string, watchId: string) {
    const view = this.requireView(sessionId)
    const removed = this.engineErrors(() => view.session.unwatchOutput(watchId))
    await view.drained()
    return { removed }
  }

  /** `_<ns>/watches`: the session's running background commands, each with the watches on its output, from its state. */
  watches(sessionId: string): WatchesResult {
    const running = this.requireView(sessionId).session.projection().session.spawned?.running ?? []
    return {
      sessionId,
      commands: running
        .filter((entry) => entry.kind === "command")
        .map((entry) => ({
          spawnId: entry.spawnId,
          command: entry.command ?? "",
          logPath: entry.logPath,
          watches: (entry.watches ?? []).map((watch) => ({
            watchId: watch.watchId,
            pattern: watch.pattern,
            regex: watch.regex,
            ignoreCase: watch.ignoreCase,
            description: describeWatch(watch),
            limit: watch.limit,
            fired: watch.fired,
            watching: watch.ended === null && watch.fired < watch.limit,
          })),
        })),
    }
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
        // Who changed them is in the text, as far as the engine can tell (`editedBy` of each file).
        title: undo ? `Redo: ${files} changed outside this session since the undo` : `Undo: ${files} changed outside this session since the turn`,
        kind: "edit",
        status: "pending",
        locations: byHand.map((path) => ({ path: join(cwd, path) })),
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `${handEditSentences(plan.changes, undo ? "since the undo" : "since the turn").map((sentence) => `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`).join(" ")} ${
                undo
                  ? "Overwrite: they go back to how the turn left them, and the changes since the undo are lost for good. Keep: they stay exactly as they are now, with those changes; the other files come back."
                  : "Overwrite: they go back to before the turn and those changes are lost (redo brings them back). Keep: they stay exactly as they are now, those changes and the agent's in them both; the other files go back."
              }`,
            },
          },
        ],
        rawInput: { command, plan },
      },
      options: [
        { optionId: HAND_EDIT_OPTIONS.overwrite, name: undo ? "Overwrite them: as the turn left them" : "Overwrite them: back to before the turn", kind: "allow_once" },
        { optionId: HAND_EDIT_OPTIONS.keep, name: "Keep them exactly as they are now", kind: "allow_once" },
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

  /**
   * The approval question about one tool call, as a permission request. The
   * call is the one the client already shows (`<message>/<call>`); the options
   * are the question's choices under their own IDs (`once`, `session`,
   * `project`, `deny`), each named with what it remembers. Whatever is not a
   * selection (a cancelled request, a client that cannot answer) declines.
   */
  async askApproval(view: SessionView, data: EventData<"approval.requested">, child: SubagentRef | null = null): Promise<void> {
    const client = this.client
    // A subagent's question is answered through its parent's `answer`, which hands it on to the subagent.
    const target = { messageId: data.messageId, callId: data.callId, ...(child === null ? {} : { sessionId: child.sessionId as SessionId }) }
    const decline = () => {
      // The parent's interrupt is durable before its subagents are stopped: a question withdrawn by that is left to the subagent's own interrupt.
      if (child !== null && view.session.projection().session.execution?.interrupting != null) return
      this.guard(() => view.session.answer(target, { choice: "deny" }))
    }
    if (client === null) return decline()
    const question = data.question
    const meta: ApprovalRequestMeta = { messageId: data.messageId, callId: data.callId, question, needs: data.needs, then: data.then, ...(child === null ? {} : { subagent: child }) }
    const asker = child === null ? [] : [`Asked by a subagent working on: ${child.title}`]
    const request: RequestPermissionRequest = {
      sessionId: view.session.id,
      toolCall: {
        // A subagent's call is not one of the session's own: it gets an ID of its own, which names the subagent's session.
        toolCallId: child === null ? `${data.messageId}/${data.callId}` : `${child.sessionId}/${data.messageId}/${data.callId}`,
        title: child === null ? question.title : `Subagent "${shorten(child.title, 48)}": ${question.title}`,
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: [question.subject, ...question.details, ...asker].join("\n") } }],
      },
      options: question.choices.map((choice) => ({
        optionId: choice.id,
        name: choice.remembers === null ? choice.label : `${choice.label} (remembers ${choice.remembers})`,
        kind: choice.id === "once" ? ("allow_once" as const) : choice.id === "deny" ? ("reject_once" as const) : ("allow_always" as const),
      })),
      _meta: { [META.capabilities]: { [APPROVAL_META]: meta } },
    }
    const response = await client.request(methods.client.session.requestPermission, request).catch((error: unknown) => {
      if (!this.connectionClosed) this.log.warn(`the client could not be asked about a tool call in ${view.session.id}: ${describeError(error)}`)
      return null
    })
    const outcome = response?.outcome
    if (outcome?.outcome !== "selected") return decline()
    const chosen = question.choices.find((choice) => choice.id === outcome.optionId)
    if (chosen === undefined) return decline()
    const note = (namespaced(response?._meta) as { note?: unknown } | null)?.note
    this.guard(() => view.session.answer(target, { choice: chosen.id, ...(typeof note === "string" ? { note } : {}) }))
  }

  /** `_<ns>/approval`: how the session's calls are approved, after setting what the request names. */
  approval(sessionId: string, change: { readonly mode: string | null; readonly unattended: string | null; readonly attended: boolean | null }): ApprovalStateResult {
    const view = this.requireView(sessionId)
    const session = view.session
    // Whoever answers for the session answers for its subagents, unless the session was opened saying otherwise.
    if (change.attended !== null) session.setAttended(change.attended, { children: change.attended && view.children })
    if (change.mode !== null || change.unattended !== null)
      session.setApproval({
        ...(change.mode === null ? {} : { mode: change.mode as (typeof approvalModes)[number] }),
        ...(change.unattended === null ? {} : { unattended: change.unattended as (typeof UNATTENDED)[number] }),
      })
    const state = session.approval()
    if (state === null) return { sessionId, enabled: false, mode: null, unattended: null, attended: false, sandboxUnavailable: null, tainted: false, taint: null, ignored: [] }
    return {
      sessionId,
      enabled: true,
      mode: state.policy.mode,
      unattended: state.policy.unattended,
      attended: state.attended,
      sandboxUnavailable: state.sandbox.available ? null : { reason: state.sandbox.reason, remedy: state.sandbox.remedy },
      tainted: state.taint.tainted,
      taint: session.projection().session.approval?.taint?.text ?? null,
      ignored: state.ignored,
    }
  }

  clearTaint(sessionId: string) {
    return { cleared: this.requireView(sessionId).session.clearTaint() }
  }

  /**
   * `_<ns>/fork`: a new session with the history of `sessionId` up to a step
   * boundary (`Engine.forkSession`). The parent is only read, so it may be
   * open here, in another process, or nowhere. The fork is let go of at once:
   * a client opens it (`session/load`) to work in it, here or elsewhere.
   */
  async fork(params: ForkParams): Promise<ForkResult> {
    const engine = this.harness.engine
    const summary = this.engineErrors(() => engine.getSession(params.sessionId as SessionId), params.sessionId)
    if (summary === null) throw RequestError.sessionNotFound(params.sessionId)
    let settings: SessionSettings | undefined
    if (params.model !== undefined || params.effort !== undefined) {
      const current = summary.session.settings
      const asked = { model: params.model ?? current.model, effort: params.effort === undefined ? current.reasoningEffort : params.effort }
      if (params.model !== undefined) await this.validate(summary.session.cwd, asked)
      settings = { model: asked.model, reasoningEffort: asked.effort }
    }
    const forked = await this.engineErrors(
      () =>
        engine.forkSession(params.sessionId as SessionId, {
          ...(params.throughSeq === undefined ? {} : { throughSeq: params.throughSeq }),
          ...(settings === undefined ? {} : { settings }),
          // Told apart from its parent in a listing: the parent's title, marked, unless the client names it.
          ...(params.title !== undefined ? { title: params.title } : forkTitle(this.titleOf(params.sessionId, summary.session.title))),
          ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
        }),
      params.sessionId,
    )
    const session = forked.projection().session
    const lineage = session.lineage
    const result: ForkResult = {
      sessionId: forked.id,
      // The session the fork was made from, as its lineage records it: the one named, or, for a point that one
      // inherited (it is a fork itself), the session it inherited it from.
      parentSessionId: lineage?.kind === "fork" ? lineage.parentSessionId : params.sessionId,
      throughSeq: lineage?.kind === "fork" ? lineage.throughSeq : 0,
      cwd: session.cwd,
      copiedFrom: lineage?.kind === "fork" ? (lineage.copied?.from ?? null) : null,
      title: this.titleOf(forked.id, session.title),
      model: session.settings.model,
      effort: session.settings.reasoningEffort,
    }
    // Held only while it was made: whoever continues in it opens it.
    await forked.close()
    return result
  }

  /**
   * `_<ns>/replay`: replays a recorded session (`Engine.replaySession`). The
   * replay session is shown on this connection while it runs, as any session
   * is: `_<ns>/replay_started` names it, then its events (and updates)
   * follow, and `session/cancel` on it ends the replay as incomplete. The
   * answer is the report, once the replay is over; the replay session is
   * then let go of.
   */
  async replay(params: ReplayParams, signal: AbortSignal): Promise<ReplayResult> {
    await this.requireSignIn()
    const engine = this.harness.engine
    const summary = this.engineErrors(() => engine.getSession(params.sessionId as SessionId), params.sessionId)
    if (summary === null) throw RequestError.sessionNotFound(params.sessionId)
    if (params.model !== undefined) await this.validate(summary.session.cwd, { model: params.model, effort: params.effort ?? null })
    const request: ReplayRequest = {
      ...(params.policy === undefined ? {} : { policy: params.policy }),
      ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
      ...(params.toolDescriptions === undefined ? {} : { toolDescriptions: params.toolDescriptions }),
      ...(params.model === undefined ? {} : { model: params.model }),
      ...(params.effort === undefined ? {} : { effort: params.effort }),
      ...(params.strict === undefined ? {} : { strict: params.strict }),
      ...(params.throughSeq === undefined ? {} : { throughSeq: params.throughSeq }),
      ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
    }
    const run = await this.engineErrors(() => engine.replaySession(params.sessionId as SessionId, request), params.sessionId)
    const session = run.session
    // What the replay appended before this point is read and queued, then the rest is listened to, in one synchronous block.
    const history = session.readEvents()
    const view = this.attach(session, session.projection().session.cwd, history.at(-1)?.seq ?? 0, new Map(), (prime) => {
      prime.queueExt(EXT.replayStarted, { sessionId: session.id, sourceSessionId: params.sessionId, ref: params.ref ?? null })
      for (const item of history) {
        if (this.fidelity.events) prime.queueEvent(item, false)
        prime.queueOutputs(prime.translator.translate(item), false)
      }
    })
    const stop = () => session.interrupt()
    signal.addEventListener("abort", stop, { once: true })
    try {
      const outcome = await run.done
      await session.settled()
      await view.drained()
      // The part that carries a signal: the side effects, the files it ended with, and the grade (`replay/effects.ts`).
      const replayFinal = outcome.workspace === null ? undefined : await snapshotOfCopy(outcome.workspace, this.harness.dataDir, outcome.sessionId)
      const compared = (() => {
        try {
          return compareReplay(engine.readEvents(params.sessionId as SessionId), engine.readEvents(outcome.sessionId as SessionId), outcome.report, { normalisers: DEFAULT_NORMALISERS, ...(replayFinal === undefined ? {} : { replayFinal }) })
        } catch (error) {
          this.log.warn(`the replay of ${params.sessionId} could not be compared: ${describeError(error)}`)
          return null
        }
      })()
      return {
        compared: compared as unknown as ReplayResult["compared"],
        comparison: compared === null ? null : renderComparison(compared),
        sourceSessionId: params.sessionId,
        sessionId: outcome.sessionId,
        policy: params.policy ?? "stop",
        workspace: outcome.workspace,
        requests: outcome.requests,
        usage: outcome.usage,
        report: outcome.report as unknown as ReplayResult["report"],
        text: renderReplayReport(outcome.report),
      }
    } finally {
      signal.removeEventListener("abort", stop)
      view.detach()
      await session.close().catch((error: unknown) => this.log.warn(`closing the replay session ${session.id} failed: ${describeError(error)}`))
    }
  }

  /**
   * `_<ns>/diff`: what a turn or a step changed, from the snapshots the engine
   * recorded around it (`snapshot.taken`). A turn runs from the workspace as
   * it was when its first message was delivered to the last snapshot before
   * it ended; a step from its `step_start` to its `step_end`. Read from the
   * stored log, so it works for any session, open here or not.
   */
  async diff(sessionId: string, options: { readonly executionId: string | undefined; readonly messageId: string | undefined; readonly patch: boolean }): Promise<DiffResult> {
    const summary = this.engineErrors(() => this.harness.engine.getSession(sessionId as SessionId), sessionId)
    if (summary === null) throw RequestError.sessionNotFound(sessionId)
    const events = this.engineErrors(() => this.harness.engine.readEvents(sessionId as SessionId), sessionId)
    const range = options.messageId !== undefined ? stepRange(events, options.messageId) : turnRange(events, options.executionId ?? null)
    if ("reason" in range) return { available: false, ...range }
    const store = await this.snapshotsOf(summary.session.cwd)
    if ("message" in store) return { available: false, reason: "unavailable", message: store.message }
    const changes = range.from === range.to ? [] : await store.diff(range.from as SnapshotId, range.to as SnapshotId, { patch: options.patch }).catch((error: unknown) => describeError(error))
    if (typeof changes === "string") return { available: false, reason: "unavailable", message: `the snapshots of this ${options.messageId === undefined ? "turn" : "step"} cannot be read: ${changes}` }
    return { available: true, scope: options.messageId === undefined ? "turn" : "step", executionId: range.executionId, messageId: options.messageId ?? null, from: range.from, to: range.to, files: changes.map(diffFile) }
  }

  /** The files each ended turn of a stored session changed, by execution, for a replay. The latest turns only: each costs a tree comparison. */
  private async replayChanges(sessionId: SessionId, cwd: string): Promise<Map<string, readonly string[]>> {
    const changes = new Map<string, readonly string[]>()
    const events = (() => {
      try {
        return this.harness.engine.readEvents(sessionId)
      } catch {
        return []
      }
    })()
    const ended = events.flatMap((item) => (item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted" ? [item.data.executionId] : []))
    if (ended.length === 0) return changes
    const store = await this.snapshotsOf(cwd)
    if ("message" in store) return changes
    for (const executionId of [...new Set(ended)].slice(-REPLAYED_TURN_CHANGES)) {
      const range = turnRange(events, executionId)
      if ("reason" in range) continue
      const files = range.from === range.to ? [] : await store.changedFiles(range.from as SnapshotId, range.to as SnapshotId).catch(() => null)
      if (files !== null) changes.set(executionId, files)
    }
    return changes
  }

  /** The snapshot store of a working directory, as the engine opens it (`<dataDir>/snapshots`), once per directory. */
  private snapshotsOf(cwd: string): Promise<Snapshots | { readonly message: string }> {
    let opened = this.snapshotStores.get(cwd)
    if (opened === undefined) {
      opened = openSnapshots(cwd, { dataDir: join(this.harness.dataDir, "snapshots") }).then(
        (store) => (store.kind === "ready" ? store : { message: `no snapshots can be read here: ${store.message}` }),
        (error: unknown) => ({ message: `no snapshots can be read here: ${describeError(error)}` }),
      )
      this.snapshotStores.set(cwd, opened)
      // A failure is not remembered: git may be installed, the directory created, in the meantime.
      void opened.then((store) => {
        if ("message" in store) this.snapshotStores.delete(cwd)
      })
    }
    return opened
  }

  /**
   * A session's title: its own (`session.renamed`, or given at creation), or
   * else the first line of the first thing the user said in it, shortened
   * (`sessionTitle`). The engine keeps the beginning of that with the
   * session's summary (`firstPrompt`), so no log is read for a title.
   */
  titleOf(sessionId: string, own: string | null): string | null {
    if (own !== null && own.trim() !== "") return own
    try {
      return sessionTitle(own, this.harness.engine.getSession(sessionId as SessionId)?.firstPrompt ?? null)
    } catch {
      return null
    }
  }

  /**
   * `_<ns>/agents`: the agents a session can run as, as they are now, with
   * the definitions that could not be used. With `sessionId` (a session open
   * here) also the one it runs as; with `cwd`, what a session started there
   * could run as.
   */
  agents(sessionId: string | undefined, cwd: string | undefined): AgentsResult {
    if (sessionId === undefined && cwd === undefined) throw RequestError.invalidParams(undefined, "sessionId or cwd is needed")
    if (cwd !== undefined && !isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
    const session = sessionId === undefined ? null : this.requireView(sessionId).session
    const listing = this.engineErrors(() => (session === null ? this.harness.engine.listAgents(cwd!) : session.agents()))
    return agentsResult(listing, session === null ? null : (session.agent()?.name ?? null))
  }

  /** `_<ns>/rename`: the session's title, as the engine stores it (`session.renamed`). */
  async rename(sessionId: string, title: string) {
    const view = this.requireView(sessionId)
    const stored = this.engineErrors(() => view.session.rename(title))
    // The title reaches the client (`session_info_update`, or the `session.renamed` event) before the answer.
    await view.drained()
    return { title: stored }
  }

  /**
   * `_<ns>/compact`: the conversation is compacted now, because the user
   * asks. Answered when it is done, after every event of it, with what came
   * of it: the sizes, or why nothing was compacted, or why it failed.
   */
  async compact(sessionId: string): Promise<CompactResult> {
    const view = this.requireView(sessionId)
    const idle = !view.session.working
    const result = await this.engineErrors(() => view.session.compact())
    // While idle the compaction runs under an execution of its own, which ends right after: its events come first.
    // (Briefly: a prompt sent meanwhile carries that execution on, and the answer does not wait for its turn.)
    if (idle) await Promise.race([view.session.settled(), Bun.sleep(COMPACT_SETTLE_MS)])
    await view.drained()
    return result
  }

  /** Runs something that may find the session closed in the meantime; that is no error worth a log line. */
  private guard(work: () => unknown): void {
    try {
      work()
    } catch (error) {
      if (!(error instanceof EngineError)) this.log.warn(`could not record an answer: ${describeError(error)}`)
    }
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
      title: this.titleOf(session.id, session.title),
      model: view.settings.model,
      effort: view.settings.reasoningEffort,
      archived: session.archived,
      updatedAt: new Date(projection.updatedAt).toISOString(),
      lastSeq: projection.lastSeq,
      /** Admitted messages not yet delivered, oldest first. */
      inbox: projection.inbox.map((item) => ({ messageId: item.messageId, delivery: item.delivery })),
      canUndo: projection.messages.some((message) => message.kind === "user" && message.excluded === null),
      canRedo: session.reverts.length > 0,
      /** The agent the session runs as (or will from its next step); `null`: none. */
      agent: view.session.agent()?.name ?? null,
      /** The model's task list as it stands (the latest `todo` call that counts); `null`: it never set one. */
      todos: currentTodos(projection.messages)?.items ?? null,
    }
  }

  storedEvents(sessionId: string, afterSeq: number, limit: number | undefined) {
    const events = this.engineErrors(
      () => this.harness.engine.readEvents(sessionId as SessionId, { afterSeq, ...(limit === undefined ? {} : { limit }) }),
      sessionId,
    )
    return { events }
  }

  /**
   * `_<ns>/resolve`: the command line's `--session <id or start of one>` and
   * `--continue`. A lookup in the store, so it needs no sign-in: what follows
   * it decides that (opening a session to work in it does, a fork does not).
   */
  async resolve(cwd: string, session: string | undefined) {
    if (!isAbsolute(cwd)) throw RequestError.invalidParams({ cwd }, `cwd must be an absolute path: ${cwd}`)
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

  async configOptions(settings: SessionSettings, session?: EngineSession): Promise<SessionConfigOption[]> {
    const agents = session === undefined ? null : agentChoices(session)
    return configOptionsFor(settings, await this.catalog.list(), session?.approval()?.policy.mode ?? null, agents)
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

  private attach(
    session: EngineSession,
    cwd: string,
    fromSeq: number,
    changes: ReadonlyMap<string, readonly string[]>,
    prime?: (view: SessionView) => void,
  ): SessionView {
    const view = new SessionView(this, session, cwd, fromSeq, changes)
    prime?.(view)
    view.listen()
    this.views.set(session.id, view)
    return view
  }

  /** A session open on this connection, for the feature requests. */
  view(sessionId: string): SessionView {
    return this.requireView(sessionId)
  }

  /** `<prefix>/mcp_approve`: the user approves a server the project's configuration names; it starts at once. */
  async approveMcp(sessionId: string, name: string, fingerprint: string | undefined) {
    const view = this.requireView(sessionId)
    const approved = view.session.approveMcpServer(name, fingerprint)
    // What changed with it (`<prefix>/mcp_changed`, told by the engine) reaches the client before the answer.
    await view.drained()
    return { approved, servers: (await mcpState(view.session)).servers }
  }

  /** `<prefix>/hook_approve`: the user allows a hook the project's configuration names; it runs from the next call it applies to. */
  async approveHook(sessionId: string, fingerprint: string) {
    const view = this.requireView(sessionId)
    const approved = view.session.approveHook(fingerprint)
    await view.drained()
    return { approved, hooks: (await view.hooks()).hooks }
  }

  /** `<prefix>/lsp_approve`: the user allows a language server the project's configuration names; it starts at the next file it serves. */
  async approveLsp(sessionId: string, name: string, fingerprint: string | undefined) {
    const view = this.requireView(sessionId)
    const approved = view.session.approveLspServer(name, fingerprint)
    await view.drained()
    return { approved, servers: (await lspState(view.session)).servers }
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
      if (error instanceof EngineError && (error.code === "ambiguous_session" || error.code === "unknown_model" || error.code === "unknown_effort" || error.code === "invalid_request"))
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
  /** Whether the client answers the questions of this session's subagents when it is attended (`OpenMeta.children`). */
  children = true
  /** The parent's `subagent` call of each subagent seen starting here, by the subagent's session. */
  private readonly spawnCalls = new Map<string, string>()
  private readonly pending: Pending[] = []
  private outbox: Promise<void> = Promise.resolve()
  private unlisten: (() => void) | null = null
  private detached = false
  /**
   * What the engine said changed (`onFeatureChange`: its MCP servers, its
   * hooks, its language servers) and whose state has not been read for the
   * client yet: a change that comes meanwhile is told with it.
   */
  private readonly changed = new Set<SessionFeature>()
  private unfeature: (() => void) | null = null
  /** Why each hook could not answer the last time it ran in this session, by fingerprint (`hook.ran`). */
  private readonly hookFailures = new Map<string, string>()

  constructor(
    private readonly connection: ConnectionState,
    readonly session: EngineSession,
    cwd: string,
    private fromSeq: number,
    changes: ReadonlyMap<string, readonly string[]>,
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
      replayedChanges: (executionId) => changes.get(executionId) ?? null,
    })
    this.titled = connection.titleOf(session.id, session.projection().session.title) !== null
  }

  /** Whether the client has a title for the session; the first message gives one to a session without. */
  private titled: boolean

  get settings(): SessionSettings {
    return this.requested ?? this.session.projection().session.settings
  }

  listen(): void {
    // Handled after whatever produced the event has returned, in order: a prompt's sender registers what it
    // waits for before its own `inbox.enqueued` is looked at here.
    this.unlisten = this.session.subscribe((item) => queueMicrotask(() => this.onEvent(item)))
    // The engine says when its MCP servers, hooks or language servers changed: nothing is looked at on a timer.
    this.unfeature = this.session.onFeatureChange((feature) => this.featureChanged(feature))
  }

  /** The commands as last advertised (`available_commands_update`). */
  private commandsSeen: string | null = null

  /**
   * Tells the client which slash commands the session has, the protocol's
   * way (`available_commands_update`): after the session is opened, and
   * again whenever the files changed by the time a prompt arrives. A command
   * a client's own would hide is the client's to leave out.
   */
  advertiseCommands(): void {
    if (this.detached) return
    let listing: CommandListing | null = null
    try {
      listing = this.session.commands()
    } catch {
      return
    }
    if (listing === null) return
    const availableCommands = listing.commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint === null ? {} : { input: { hint: command.argumentHint } }),
      _meta: { [META.capabilities]: { path: command.path, scope: command.scope, agent: command.agent } },
    }))
    const key = JSON.stringify(availableCommands)
    if (key === this.commandsSeen) return
    // A session without command files has nothing to say, until it had some and they went.
    const nothingYet = this.commandsSeen === null && availableCommands.length === 0
    this.commandsSeen = key
    if (nothingYet) return
    this.enqueue(() => this.connection.sendUpdate(this.session.id, { sessionUpdate: "available_commands_update", availableCommands }))
  }

  /** `<prefix>/hooks`: the session's hooks, with the ones that could not answer when they last ran here. */
  hooks() {
    return hooksState(this.session, this.hookFailures)
  }

  /** A `hook.ran` record, live or from the stored log: whether that hook could answer. */
  noteHook(item: EngineEvent): void {
    if (item.type !== "hook.ran") return
    const failure = hookFailure(item.data)
    if (failure === undefined) return
    const before = this.hookFailures.get(item.data.fingerprint) ?? null
    if (failure === null) this.hookFailures.delete(item.data.fingerprint)
    else this.hookFailures.set(item.data.fingerprint, failure)
    // Whether a hook can answer is this connection's own knowledge (the engine's hooks did not change): told from here.
    if (before !== failure && this.unlisten !== null) this.featureChanged("hooks")
  }

  /**
   * The session's hooks and language servers, looked at once, a moment after
   * it was opened: reading them reads the configuration, and the engine says
   * through its listener what it names (a project's hook or server that
   * waits for the user's approval), so a client has the question before the
   * first message. Not while the session is being opened: what the engine
   * says about the configuration belongs after the answer that opens it.
   */
  lookAtFeatures(): void {
    if (this.detached) return
    try {
      this.session.hooks()
      this.session.lsp()
    } catch {
      // A session that is closing has nothing new to say.
    }
  }

  /**
   * The engine's word that what `mcp()`, `hooks()` or `lsp()` returns has
   * changed: a server started, failed, waits for the user's approval or was
   * approved, the configuration a turn read names other hooks or servers.
   * The client is told (`<prefix>/mcp_changed`, `<prefix>/hooks_changed`,
   * `<prefix>/lsp_changed`, each with the whole state): one notification
   * for however many changes came together. It takes its place among the
   * session's updates here, ahead of what the engine says about the change
   * in its events (a project's hook that waits is told before the sentence
   * that it was not run); the state itself is read a moment later, once the
   * change is made, because the engine calls in the middle of it.
   */
  private featureChanged(feature: SessionFeature): void {
    if (this.detached || this.changed.has(feature)) return
    this.changed.add(feature)
    const [method, read] =
      feature === "mcp"
        ? ([EXT.mcpChanged, (): Promise<object> => mcpState(this.session)] as const)
        : feature === "hooks"
          ? ([EXT.hooksChanged, (): Promise<object> => this.hooks()] as const)
          : ([EXT.lspChanged, (): Promise<object> => lspState(this.session)] as const)
    this.enqueue(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      this.changed.delete(feature)
      // A session that closed meanwhile has nothing new to say.
      const state = this.detached ? null : await read().catch(() => null)
      if (state !== null) await this.connection.sendExt(method, { ...state })
    })
  }

  detach(): void {
    if (this.detached) return
    this.detached = true
    this.unlisten?.()
    this.unfeature?.()
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

  /** An extension notification, in order with the session's updates. */
  queueExt(method: string, params: Record<string, unknown>): void {
    this.enqueue(() => this.connection.sendExt(method, params))
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
        title: this.connection.titleOf(this.session.id, session.title),
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
    this.noteHook(item)
    // A title the user gave: the first message no longer names the session.
    if (item.type === "session.renamed") this.titled = true
    if (item.type === "inbox.enqueued" && item.data.origin === null && !this.titled) {
      const title = this.connection.titleOf(this.session.id, this.session.projection().session.title)
      if (title !== null) {
        this.titled = true
        this.enqueue(() => this.connection.sendUpdate(this.session.id, { sessionUpdate: "session_info_update", title, updatedAt: new Date(item.time).toISOString() }))
      }
    }
    if (this.connection.fidelity.events) this.queueEvent(item, false)
    for (const output of this.translator.translate(item)) this.handleOutput(output, false, seq)
    // The switch is durable: the `agent` option now names what the session runs as.
    if (item.type === "agent.switched")
      this.enqueue(async () => this.connection.sendUpdate(this.session.id, { sessionUpdate: "config_option_update", configOptions: await this.connection.configOptions(this.settings, this.session) }))
    // The question goes out after the events and updates that lead up to it, so the client can show the call it is about.
    if (item.type === "approval.requested") {
      const data = item.data
      this.enqueue(async () => void this.connection.askApproval(this, data))
    }
    if (item.type === "spawn.started" && item.data.work.kind === "subagent") this.spawnCalls.set(item.data.work.sessionId, `${item.data.messageId}/${item.data.callId}`)
    if (item.type === "child.event") this.onChildEvent(item)
  }

  /**
   * A durable event of a subagent, forwarded by the engine. A client that
   * takes the harness's events has it as `child.event` already; any other
   * gets `<prefix>/child`. A question the subagent asks is put to this
   * client, labelled with the subagent, when it answers for subagents.
   */
  private onChildEvent(item: Extract<EngineEvent, { type: "child.event" }>): void {
    const child: SubagentRef = { sessionId: item.child, title: item.title, spawnId: item.spawnId, toolCallId: this.spawnCalls.get(item.child) ?? null }
    if (!this.connection.fidelity.events) this.queueExt(EXT.child, { ...child, sessionId: this.session.id, childSessionId: item.child, event: item.event })
    if (item.event.type === "approval.requested") {
      const data = item.event.data
      this.enqueue(async () => void this.connection.askApproval(this, data, child))
    }
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
          this.connection.sendUpdate(this.session.id, { sessionUpdate: "config_option_update", configOptions: await this.connection.configOptions(settings, this.session) }),
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
  if (end.approvalRequired === true) return new RequestError(-32603, end.message, errorData({ reason: "approval_required", message: end.message }))
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
  return {
    model: text("model"),
    effort: text("effort"),
    agent: text("agent"),
    archived: value.archived === true,
    approval: oneOfOrNull(value.approval, approvalModes, `_meta.${META.capabilities}.approval`),
    unattended: oneOfOrNull(value.unattended, UNATTENDED, `_meta.${META.capabilities}.unattended`),
    ...(typeof value.attended === "boolean" ? { attended: value.attended } : {}),
    ...(typeof value.children === "boolean" ? { children: value.children } : {}),
  }
}

/** A value that is one of `allowed`, or `null` when it is absent. Anything else is a bad request. */
function oneOfOrNull<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !allowed.includes(value)) throw RequestError.invalidParams({ [name]: value }, `${name} must be one of: ${allowed.join(", ")}`)
  return value
}

/**
 * What a client says about approval when it opens a session: whether a
 * person is there to answer (yes, unless it says otherwise: an ACP client
 * can answer `session/request_permission`), and the user's own mode and
 * unattended behaviour for this session.
 */
function applyApproval(session: EngineSession, meta: OpenMeta | null): void {
  const attended = meta?.attended ?? true
  // Whoever answers for the session answers for its subagents too, unless the client says it does not.
  session.setAttended(attended, { children: attended && meta?.children !== false })
  const mode = meta?.approval ?? null
  const unattended = meta?.unattended ?? null
  if (mode !== null || unattended !== null)
    session.setApproval({
      ...(mode === null ? {} : { mode: mode as (typeof approvalModes)[number] }),
      ...(unattended === null ? {} : { unattended: unattended as (typeof UNATTENDED)[number] }),
    })
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

/** The agents a session can be switched to, and the one it runs as (`none`: no agent). `null` when the engine offers no agents. */
function agentChoices(session: EngineSession): { readonly current: string; readonly agents: readonly { readonly name: string; readonly description: string }[] } | null {
  try {
    const listing = session.agents()
    if (listing === null) return null
    return { current: session.agent()?.name ?? NO_AGENT_VALUE, agents: listing.agents.map((agent) => ({ name: agent.name, description: agent.description })) }
  } catch {
    return null
  }
}

/** The client's own commands a request names (`builtins`): a list of `{ name, aliases? }`. */
function clientCommands(value: unknown): ClientCommand[] {
  if (value === undefined || value === null) return []
  const bad = () => RequestError.invalidParams(undefined, "builtins must be a list of { name, aliases? }")
  if (!Array.isArray(value)) throw bad()
  return value.map((item: unknown) => {
    const entry = item as { name?: unknown; aliases?: unknown } | null
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string" || entry.name === "") throw bad()
    if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string"))) throw bad()
    return { name: entry.name, ...(entry.aliases === undefined ? {} : { aliases: entry.aliases as string[] }) }
  })
}

function commandInfo(command: ListedCommand): CommandInfo {
  return { name: command.name, description: command.description, argumentHint: command.argumentHint, agent: command.agent, path: command.path, scope: command.scope, hiddenBy: command.hiddenBy }
}

/** A found command in the listing's shape. */
function listed(command: { readonly name: string; readonly description: string; readonly argumentHint: string | null; readonly agent: string | null; readonly path: string; readonly root: { readonly scope: ListedCommand["scope"] } }): Omit<ListedCommand, "hiddenBy"> {
  return { name: command.name, description: command.description, argumentHint: command.argumentHint, agent: command.agent, path: command.path, scope: command.root.scope }
}

/** What `<prefix>/commands` answers for a listing of the engine's. */
function commandsResult(listing: CommandListing | null): CommandsResult {
  if (listing === null) return { available: false, commands: [], problems: [] }
  return { available: true, commands: listing.commands.map(commandInfo), problems: listing.problems.map((problem) => ({ path: problem.path, severity: problem.severity, reason: problem.reason, name: problem.name })) }
}

function expansionReport(expansion: Expansion): ExpansionReport {
  return {
    missing: [...expansion.missing],
    unused: [...expansion.unused],
    appended: expansion.appended,
    unsupported: expansion.unsupported.map((construct) => ({ kind: construct.kind, text: construct.text, line: construct.line, reason: construct.reason })),
    notes: [...expansion.notes],
  }
}

function expandResult(found: CommandExpansion): ExpandCommandResult {
  if (found.kind === "builtin") return { kind: "builtin", name: found.name }
  if (found.kind === "broken") return { kind: "broken", name: found.name, message: found.message }
  if (found.kind === "unknown") return { kind: "unknown", name: found.name, suggestions: [...found.suggestions], message: found.message }
  return { kind: "command", command: commandInfo({ ...listed(found.command), hiddenBy: null }), text: found.expansion.text, ...expansionReport(found.expansion) }
}

/** What `<prefix>/agents` answers for a listing of the engine's. */
function agentsResult(listing: AgentListing | null, current: string | null): AgentsResult {
  if (listing === null) return { available: false, agents: [], problems: [], default: null, ignored: [], current: null }
  return {
    available: true,
    agents: listing.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      path: agent.path,
      scope: agent.root.scope,
      model: agent.model,
      effort: agent.effort,
      restrictions: describeRestrictions(agent.restrictions),
      tag: restrictionTag(agent.restrictions),
    })),
    problems: listing.problems.map((problem) => ({ path: problem.path, severity: problem.severity, reason: problem.reason, name: problem.name })),
    default: listing.default,
    ignored: [...listing.ignored],
    current,
  }
}

export function configOptionsFor(
  settings: SessionSettings,
  models: readonly ModelEntry[],
  approval: string | null = null,
  agents: { readonly current: string; readonly agents: readonly { readonly name: string; readonly description: string }[] } | null = null,
): SessionConfigOption[] {
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
    // Offered when the approval layer is on. The value is the mode in force, which a project file may have tightened.
    ...(approval === null
      ? []
      : [
          {
            id: CONFIG.approval,
            name: "Approvals",
            description: "When a tool call asks before it runs",
            category: "mode" as const,
            type: "select" as const,
            currentValue: approval,
            options: [
              { value: "ask", name: "Ask", description: "Reads run; every edit, command and network call asks" },
              { value: "auto", name: "Auto", description: "Edits in the workspace and sandboxed commands run; leaving the sandbox asks" },
              { value: "full", name: "Full access", description: "Everything runs without the sandbox and without asking" },
            ],
          },
        ]),
    // Offered when the engine has agents and there is one to choose (or one in force). A definition that is hidden
    // or could not be loaded is not a value: `<prefix>/agents` lists those.
    ...(agents === null || (agents.agents.length === 0 && agents.current === NO_AGENT_VALUE)
      ? []
      : [
          {
            id: CONFIG.agent,
            name: "Agent",
            description: "The agent the session runs as: its instructions, its restrictions, and its model where it names one",
            category: `_${CONFIG.agent}`,
            type: "select" as const,
            currentValue: agents.current,
            options: [
              { value: NO_AGENT_VALUE, name: "No agent", description: "The session's own instructions, without an agent's restrictions" },
              ...agents.agents.map((agent) => ({ value: agent.name, name: agent.name, description: agent.description })),
              // The one in force stays a value when its definition is gone: the session runs as the record it was given.
              ...(agents.current !== NO_AGENT_VALUE && !agents.agents.some((agent) => agent.name === agents.current) ? [{ value: agents.current, name: agents.current }] : []),
            ],
          },
        ]),
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

function parseForkParams(raw: unknown): ForkParams {
  const params = parseObject(raw)
  const sessionId = requireString(params, "sessionId")
  const throughSeq = optionalInteger(params, "throughSeq", 1)
  const workspace = params.workspace
  if (workspace !== undefined && workspace !== "shared" && (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)))
    throw RequestError.invalidParams(undefined, 'workspace must be "shared" or { copyTo?: string }')
  const copyTo = typeof workspace === "object" && workspace !== null ? (workspace as Record<string, unknown>).copyTo : undefined
  if (copyTo !== undefined && (typeof copyTo !== "string" || !isAbsolute(copyTo))) throw RequestError.invalidParams(undefined, "workspace.copyTo must be an absolute path")
  const model = optionalString(params, "model")
  if (params.effort !== undefined && params.effort !== null && (typeof params.effort !== "string" || params.effort === "")) throw RequestError.invalidParams(undefined, "effort must be a non-empty string or null")
  if (params.title !== undefined && params.title !== null && typeof params.title !== "string") throw RequestError.invalidParams(undefined, "title must be a string or null")
  return {
    sessionId,
    ...(throughSeq === undefined ? {} : { throughSeq }),
    ...(workspace === undefined ? {} : { workspace: workspace === "shared" ? "shared" : copyTo === undefined ? {} : { copyTo: copyTo as string } }),
    ...(model === undefined ? {} : { model }),
    ...(params.effort === undefined ? {} : { effort: params.effort as string | null }),
    ...(params.title === undefined ? {} : { title: params.title as string | null }),
  }
}

const REPLAY_POLICIES = ["stop", "execute-read-only", "execute"] as const

function parseReplayParams(raw: unknown): ReplayParams {
  const params = parseObject(raw)
  const sessionId = requireString(params, "sessionId")
  const policy = oneOfOrNull(params.policy, REPLAY_POLICIES, "policy")
  const systemPrompt = params.systemPrompt
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") throw RequestError.invalidParams(undefined, "systemPrompt must be a string")
  const descriptions = params.toolDescriptions
  if (descriptions !== undefined && (typeof descriptions !== "object" || descriptions === null || Array.isArray(descriptions) || Object.values(descriptions).some((value) => typeof value !== "string")))
    throw RequestError.invalidParams(undefined, "toolDescriptions must map tool names to descriptions")
  const model = optionalString(params, "model")
  if (params.effort !== undefined && params.effort !== null && (typeof params.effort !== "string" || params.effort === "")) throw RequestError.invalidParams(undefined, "effort must be a non-empty string or null")
  if (params.strict !== undefined && typeof params.strict !== "boolean") throw RequestError.invalidParams(undefined, "strict must be a boolean")
  const workspace = optionalString(params, "workspace")
  if (workspace !== undefined && !isAbsolute(workspace)) throw RequestError.invalidParams(undefined, "workspace must be an absolute path")
  const throughSeq = optionalInteger(params, "throughSeq", 1)
  const ref = optionalString(params, "ref")
  return {
    sessionId,
    ...(policy === null ? {} : { policy }),
    ...(systemPrompt === undefined ? {} : { systemPrompt: systemPrompt as string }),
    ...(descriptions === undefined ? {} : { toolDescriptions: descriptions as Record<string, string> }),
    ...(model === undefined ? {} : { model }),
    ...(params.effort === undefined ? {} : { effort: params.effort as string | null }),
    ...(params.strict === undefined ? {} : { strict: params.strict as boolean }),
    ...(throughSeq === undefined ? {} : { throughSeq }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(ref === undefined ? {} : { ref }),
  }
}

/** The title of a fork the client did not name: its parent's, marked as a fork (once). */
function forkTitle(parent: string | null): { title?: string } {
  if (parent === null) return {}
  return { title: / \(fork\)$/.test(parent) ? parent : `${parent} (fork)` }
}

/** `text` cut at a word to at most `max` characters, with an ellipsis. */
function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`
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

/** The snapshots around a turn: from the workspace when its first message was delivered to the last snapshot before it ended. */
function turnRange(events: readonly StoredEvent[], executionId: string | null): { from: string; to: string; executionId: string } | { reason: "not_found" | "no_snapshots"; message: string } {
  const starts = events.filter((item) => item.type === "execution.started")
  const start = executionId === null ? starts.at(-1) : starts.find((item) => item.type === "execution.started" && item.data.executionId === executionId)
  if (start === undefined || start.type !== "execution.started")
    return { reason: "not_found", message: executionId === null ? "this session has no turn yet" : `there is no turn ${executionId} in this session` }
  const id = start.data.executionId
  const end = events.find((item) => item.seq > start.seq && (item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted") && item.data.executionId === id)
  const until = end?.seq ?? Number.POSITIVE_INFINITY
  // The delivery snapshot is recorded just before the message enters history, which may be before the execution's own start.
  const previousEnd = events.findLast((item) => item.seq < start.seq && (item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted"))?.seq ?? 0
  const marks = events.filter((item): item is StoredEvent<"snapshot.taken"> => item.type === "snapshot.taken" && item.seq > previousEnd && item.seq < until)
  const from = marks.find((item) => item.data.point === "delivery")
  if (from === undefined) return { reason: "no_snapshots", message: "no snapshot was recorded for this turn (snapshots were off or unavailable)" }
  const to = marks.findLast((item) => item.seq >= from.seq)!
  return { from: from.data.id, to: to.data.id, executionId: id }
}

/** The snapshots around one step: its `step_start` and its `step_end` (or whatever was recorded next, for a step cut short). */
function stepRange(events: readonly StoredEvent[], messageId: string): { from: string; to: string; executionId: string | null } | { reason: "not_found" | "no_snapshots"; message: string } {
  const step = events.find((item) => item.type === "step.started" && item.data.messageId === messageId)
  if (step === undefined) return { reason: "not_found", message: `there is no step ${messageId} in this session` }
  const start = events.find((item): item is StoredEvent<"snapshot.taken"> => item.type === "snapshot.taken" && item.data.point === "step_start" && item.data.messageId === messageId)
  if (start === undefined) return { reason: "no_snapshots", message: "this step ran no tool that can change files, so no snapshot was taken around it" }
  const end = events.find((item): item is StoredEvent<"snapshot.taken"> => item.type === "snapshot.taken" && item.seq > start.seq)
  const execution = events.findLast((item) => item.seq < step.seq && item.type === "execution.started")
  return { from: start.data.id, to: end?.data.id ?? start.data.id, executionId: execution?.type === "execution.started" ? execution.data.executionId : null }
}

function diffFile(change: FileChange): DiffFile {
  const patch = change.patch
  const text = patch?.kind === "text" ? patch.text : null
  const lines = text === null ? [] : text.split("\n")
  return {
    path: change.path,
    status: change.status,
    binary: patch?.kind === "binary",
    patch: text,
    truncated: patch?.kind === "text" && patch.truncated,
    omitted: patch?.kind === "omitted",
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  }
}
