/**
 * The harness behind the ACP server: one step-loop engine and one session
 * database per process, shared by every session a client works in.
 *
 * Why this assembles the engine itself instead of calling the CLI's
 * `createRealEngine()`: that factory is shaped for one session per process.
 * Its `Session.close()` shuts the whole engine down, its listings close the
 * engine after answering, and it exposes neither the stored log (needed to
 * replay a session on `session/load`) nor a settings change after opening
 * (needed for model and effort selection). The assembly below is the same
 * one (store, ChatGPT-plan provider with the saved sign-in, standard tools,
 * `refreshAuth`), and the CLI passes in the defaults it owns (default model,
 * file names) so the two never disagree about where sessions live.
 *
 * Each open session's event stream has one reader here, which fans the
 * events out to the connections that show the session.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  type AnyTool,
  type Engine,
  type EngineEvent,
  EngineError,
  type EngineOptions,
  type EngineSession,
  type MessageId,
  ModelListError,
  OpenAIResponsesProvider,
  type Provider,
  type SessionId,
  type SessionSettings,
  type SessionSummary,
  type Store,
  StoreError,
  type StoredEvent,
  brand,
  createEngine,
  createStandardTools,
  event,
  listModels,
  openSqliteStore,
} from "@light-harness/core"
import { AuthError, accessToken, dataDir } from "@light-harness/core/auth/chatgpt"
import { type Logger, describeError } from "./log.ts"

/** What the CLI owns and passes in, so that the CLI and the ACP server use the same database and defaults. */
export interface HarnessDefaults {
  /** The model a new session uses. */
  readonly model: string
  /** The reasoning effort a new session uses; `null` is the model's own default. */
  readonly effort: string | null
  /** The session database's file name in the data directory. */
  readonly databaseFile: string
  /** The directory, under the data directory, for tool output too long for the model. */
  readonly spillDirectory: string
}

/** One model a client can pick. */
export interface ModelEntry {
  readonly id: string
  readonly name: string
  /** Reasoning efforts the model accepts; empty when it has none. */
  readonly efforts: readonly string[]
  /** The effort the model uses when none is set, when the provider says. */
  readonly defaultEffort: string | null
  /** Context window in tokens, when the provider says. */
  readonly contextWindow: number | null
}

export type SignInState = { readonly signedIn: true } | { readonly signedIn: false; readonly message: string }

export interface BackendOptions {
  readonly defaults: HarnessDefaults
  readonly log: Logger
  /** Defaults to `<data home>/<brand.directory>`, where the sign-in is kept too. */
  readonly dataDir?: string
  /** Instead of the ChatGPT-plan provider (tests). With one, the sign-in is not checked unless `signIn` is given. */
  readonly provider?: Provider
  /** Instead of the standard tools. */
  readonly tools?: readonly AnyTool[]
  /** Instead of reading the saved sign-in. */
  readonly signIn?: () => Promise<SignInState>
  /** Instead of asking the provider for the account's models. */
  readonly models?: () => Promise<readonly ModelEntry[]>
  /** Passed through to the step loop (limits, clock, instruction discovery, ...). */
  readonly engine?: Partial<Omit<EngineOptions, "store" | "provider" | "tools" | "dataDir">>
}

/** A session that is open in this process, with its events fanned out to listeners. */
export interface OpenSession {
  readonly id: SessionId
  readonly engine: EngineSession
  /** Calls `listener` with every event from now on, in order. Returns the function that stops it. */
  readonly listen: (listener: (event: EngineEvent) => void) => () => void
}

export class SessionUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionUnavailable"
  }
}

/** The instruction a signed-out user gets. The CLI has no sign-in command yet; this is the developer helper. */
export const SIGN_IN_HINT = `run \`bun scripts/login.ts start\` in the ${brand.name} checkout and finish the ChatGPT sign-in, then try again`

const MODEL_LIST_TIMEOUT_MS = 5000

export class Backend {
  private running: { readonly store: Store; readonly engine: Engine } | null = null
  private closing: Promise<void> | null = null
  private readonly open = new Map<SessionId, OpenSession>()
  private modelList: Promise<readonly ModelEntry[]> | null = null
  private knownModels: readonly ModelEntry[] = []
  readonly directory: string

  constructor(private readonly options: BackendOptions) {
    this.directory = options.dataDir ?? dataDir()
  }

  get defaults(): HarnessDefaults {
    return this.options.defaults
  }

  get closed(): boolean {
    return this.closing !== null
  }

  /** Whether model calls can be made: the saved ChatGPT sign-in exists and can produce a token. */
  async signIn(): Promise<SignInState> {
    if (this.options.signIn !== undefined) return this.options.signIn()
    if (this.options.provider !== undefined) return { signedIn: true }
    try {
      await accessToken()
      return { signedIn: true }
    } catch (error) {
      if (error instanceof AuthError) return { signedIn: false, message: `${error.message} To sign in, ${SIGN_IN_HINT}.` }
      throw error
    }
  }

  /** The models already listed, without waiting: empty until `models()` has answered once. */
  cachedModels(): readonly ModelEntry[] {
    return this.knownModels
  }

  /** The account's models, asked for once per process. A failure is logged and answered with an empty list (and asked again next time). */
  models(): Promise<readonly ModelEntry[]> {
    this.modelList ??= this.loadModels().then((models) => {
      this.knownModels = models
      return models
    }, (error: unknown) => {
      this.options.log.warn(`could not list the models: ${describeError(error)}`)
      this.modelList = null
      return []
    })
    return this.modelList
  }

  createSession(cwd: string): OpenSession {
    const { engine } = this.start()
    const settings: SessionSettings = { model: this.defaults.model, reasoningEffort: this.defaults.effort }
    return this.track(engine.createSession({ cwd, settings }))
  }

  /**
   * Opens a stored session. A claim left by a process that died is repaired
   * here; a suspended one (a clean shutdown in the middle of a turn) stays
   * suspended until the user says something, so their words are in front of
   * the model in the first step after the restart. Archived sessions are not
   * offered: `session/delete` archives.
   */
  openSession(id: string): OpenSession {
    const live = this.open.get(id as SessionId)
    if (live !== undefined) return live
    const { store, engine } = this.start()
    const summary = store.getSession(id as SessionId)
    if (summary === null || summary.session.archived) throw new SessionUnavailable(`there is no session ${id}`)
    try {
      return this.track(engine.openSession(id as SessionId, { resume: "wait" }))
    } catch (error) {
      if (error instanceof EngineError && error.code === "session_not_found") throw new SessionUnavailable(`there is no session ${id}`)
      throw error
    }
  }

  isOpen(id: string): boolean {
    return this.open.has(id as SessionId)
  }

  /** The stored log of a session, in `seq` order. */
  history(id: SessionId): readonly StoredEvent[] {
    return this.start().store.readEvents(id)
  }

  summary(id: string): SessionSummary | null {
    return this.start().store.getSession(id as SessionId)
  }

  /** Sessions that are not archived, most recently used first. */
  listSessions(): readonly SessionSummary[] {
    return this.start().store.listSessions()
  }

  /**
   * Withdraws inbox items that were not delivered yet (`inbox.cancelled`).
   * The engine reads the inbox from the store at every boundary, so an item
   * withdrawn here is never delivered. Items already delivered are skipped.
   */
  cancelInbox(id: SessionId, messageIds: readonly string[]): string[] {
    const { store } = this.start()
    const waiting = new Set(store.readInbox(id).map((item) => item.messageId as string))
    const cancel = messageIds.filter((messageId) => waiting.has(messageId))
    if (cancel.length === 0) return []
    try {
      store.append(
        id,
        cancel.map((messageId) => event("inbox.cancelled", { messageId: messageId as MessageId })),
      )
      return cancel
    } catch (error) {
      this.options.log.warn(`could not withdraw ${cancel.length} waiting message(s) in ${id}: ${describeError(error)}`)
      return []
    }
  }

  /** Stops the session's work as a shutdown (it stays resumable) and lets go of it in this process. */
  async closeSession(id: string): Promise<void> {
    const live = this.open.get(id as SessionId)
    if (live === undefined) return
    this.open.delete(id as SessionId)
    await live.engine.close()
  }

  /** The soft delete behind `session/delete`: the session is archived (`session.archived`); its log stays. */
  async archive(id: string): Promise<void> {
    await this.closeSession(id)
    const { store } = this.start()
    const summary = store.getSession(id as SessionId)
    if (summary === null || summary.session.archived) return
    store.append(id as SessionId, [event("session.archived", {})])
  }

  /** The graceful shutdown: every session is stopped as a shutdown, then the database is closed. Safe to call twice. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const current = this.running
      if (current === null) return
      await current.engine.close()
      this.open.clear()
      current.store.close()
    })()
    return this.closing
  }

  private start(): { readonly store: Store; readonly engine: Engine } {
    if (this.closing !== null) throw new SessionUnavailable(`${brand.name} is shutting down`)
    if (this.running !== null) return this.running
    mkdirSync(this.directory, { recursive: true })
    const path = join(this.directory, this.defaults.databaseFile)
    const store = openStore(path)
    const spillDir = join(this.directory, this.defaults.spillDirectory)
    const provider =
      this.options.provider ??
      new OpenAIResponsesProvider({
        accessToken,
        readBlob: (ref) => {
          const blob = store.getBlob(ref.hash)
          if (blob === null) throw new Error(`blob ${ref.hash} is not in the session database`)
          return blob.bytes
        },
      })
    const log = this.options.log
    const engine = createEngine({
      ...(this.options.provider === undefined
        ? {
            // On a rejected sign-in the token is looked up once more (it is refreshed when it is due) before the step fails.
            refreshAuth: () =>
              accessToken().then(
                () => true,
                () => false,
              ),
          }
        : {}),
      log: (line) => log.info(line),
      ...this.options.engine,
      store,
      provider,
      tools: this.options.tools ?? createStandardTools({ spillDir }),
      dataDir: this.directory,
      spillDir,
    })
    this.running = { store, engine }
    return this.running
  }

  private track(engine: EngineSession): OpenSession {
    const listeners = new Set<(event: EngineEvent) => void>()
    const session: OpenSession = {
      id: engine.id,
      engine,
      listen: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    this.open.set(engine.id, session)
    void (async () => {
      for await (const item of engine.events)
        for (const listener of [...listeners]) {
          try {
            listener(item)
          } catch (error) {
            this.options.log.error(`a listener of ${engine.id} failed on ${item.type}: ${describeError(error)}`)
          }
        }
    })()
    return session
  }

  private async loadModels(): Promise<readonly ModelEntry[]> {
    if (this.options.models !== undefined) return this.options.models()
    if (this.options.provider !== undefined) return []
    try {
      const models = await listModels({ accessToken, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) })
      return models.map((model) => ({
        id: model.slug,
        name: model.displayName,
        efforts: model.reasoningEfforts,
        defaultEffort: model.defaultReasoningEffort,
        contextWindow: model.contextWindow,
      }))
    } catch (error) {
      if (error instanceof ModelListError) throw new Error(error.message)
      throw error
    }
  }
}

function openStore(path: string): Store {
  try {
    return openSqliteStore({ path })
  } catch (error) {
    if (error instanceof StoreError && error.code === "locked")
      throw new SessionUnavailable(`another ${brand.binary} process is using the session database (${path}); close it first`)
    if (error instanceof StoreError && error.code === "schema_mismatch")
      throw new SessionUnavailable(`the session database (${path}) was written by another version of ${brand.name}`)
    throw error
  }
}
