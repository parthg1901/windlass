/**
 * The real engine behind the CLI's `Engine` interface: the step loop from
 * `@light-harness/core` on the session database in the harness data
 * directory, the ChatGPT-plan Responses provider with the saved sign-in, and
 * the standard tools.
 *
 * `createRealEngine()` does nothing until `open` (or a listing) is called:
 * the CLI creates it for every run that is not a demo, including runs that
 * only print help. Everything that can be missing in a user's environment (no
 * sign-in, another process holding the database, an unknown session) is
 * reported as `EngineUnavailable` with a sentence the CLI prints.
 *
 * Every name, directory and binary comes from `brand`.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  type AnyTool,
  type Engine as CoreEngine,
  EngineError,
  type EngineOptions,
  type EngineSession,
  ModelListError,
  OpenAIResponsesProvider,
  type Provider,
  type SessionId,
  type SessionSettings,
  type Store,
  StoreError,
  brand,
  createEngine,
  createStandardTools,
  listModels,
  openSqliteStore,
} from "@light-harness/core"
import { AuthError, accessToken, dataDir } from "@light-harness/core/auth/chatgpt"
import { offerSession } from "./commands.ts"
import { type Engine, EngineUnavailable, type ModelInfo, type OpenRequest, type Session, type SessionSummary } from "./engine.ts"

/** The model a new session uses when `--model` is not given. `--models` lists what the account offers. */
export const DEFAULT_MODEL = "gpt-6.1-sol"
/** The reasoning effort a new session uses when `--effort` is not given: `null` is the model's own default. */
export const DEFAULT_EFFORT: string | null = null
/** The session database, in the harness data directory. */
export const DATABASE_FILE = "sessions.db"
/** Where tool output that is too long for the model is written in full, under the data directory. */
export const SPILL_DIRECTORY = "spill"

/** For tests and scripts. The CLI passes nothing. */
export interface RealEngineOptions {
  /** Defaults to `<data home>/<brand.directory>`, where the sign-in is kept too. */
  readonly dataDir?: string
  /** Instead of the ChatGPT-plan provider. With one, the sign-in is not checked. */
  readonly provider?: Provider
  /** Instead of the standard tools. */
  readonly tools?: readonly AnyTool[]
  readonly defaultModel?: string
  readonly defaultEffort?: string | null
  /** Passed through to the loop (limits, clock, instruction discovery, hooks, ...). */
  readonly engine?: Partial<Omit<EngineOptions, "store" | "provider" | "tools" | "dataDir">>
}

interface Running {
  readonly store: Store
  readonly engine: CoreEngine
}

export function createRealEngine(options: RealEngineOptions = {}): Engine {
  const directory = options.dataDir ?? dataDir()
  let running: Running | null = null
  let stopping: Promise<void> | null = null

  /** Opens the database and builds the loop on first use. */
  const start = (): Running => {
    if (running !== null) return running
    mkdirSync(directory, { recursive: true })
    const store = openStore(join(directory, DATABASE_FILE))
    const spillDir = join(directory, SPILL_DIRECTORY)
    const provider =
      options.provider ??
      new OpenAIResponsesProvider({
        accessToken,
        readBlob: (ref) => {
          const blob = store.getBlob(ref.hash)
          if (blob === null) throw new Error(`blob ${ref.hash} is not in the session database`)
          return blob.bytes
        },
      })
    const engine = createEngine({
      // On a rejected sign-in the token is looked up once more (it is refreshed when it is due) before the step fails.
      refreshAuth: () =>
        accessToken().then(
          () => true,
          () => false,
        ),
      log: (line) => process.stderr.write(`${brand.binary}: ${line}\n`),
      // What `--model` is checked against. A scripted provider has no listing, so nothing is checked.
      ...(options.provider === undefined ? { listModels: () => listModels({ accessToken }).then((models) => models.map((model) => model.slug)) } : {}),
      ...options.engine,
      store,
      provider,
      tools: options.tools ?? createStandardTools({ spillDir }),
      dataDir: directory,
      spillDir,
    })
    running = { store, engine }
    return running
  }

  /** The shutdown every exit path goes through: stop the work, then let go of the database. Safe to call twice. */
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const current = running
      if (current === null) return
      await current.engine.close()
      current.store.close()
    })()
    return stopping
  }

  const settingsFor = (request: OpenRequest): SessionSettings => ({
    model: request.model ?? options.defaultModel ?? DEFAULT_MODEL,
    reasoningEffort: request.effort ?? (options.defaultEffort === undefined ? DEFAULT_EFFORT : options.defaultEffort),
  })

  const sessionFor = ({ engine }: Running, request: OpenRequest): EngineSession => {
    const target = request.session
    if (target.kind === "new") return engine.createSession({ cwd: request.cwd, settings: settingsFor(request) })
    const id = target.kind === "resume" ? (target.id as SessionId) : engine.latestSession(request.cwd)?.session.id
    if (id === undefined) throw new EngineUnavailable(`there is no session to continue in ${request.cwd}`)
    // A claim left by a process that died or shut down is repaired here. It is worked on again once the user says
    // something, so that what they say is in front of the model in the first step after the restart.
    const session = open(engine, id)
    const current = session.projection().session.settings
    if (request.model !== null || request.effort !== null)
      session.setSettings({ model: request.model ?? current.model, reasoningEffort: request.effort ?? current.reasoningEffort })
    return session
  }

  return {
    open: async (request): Promise<Session> => {
      if (stopping !== null) throw new EngineUnavailable("the engine is closed")
      if (options.provider === undefined) await requireSignIn()
      const loop = start()
      // A model named on the command line is checked before a session is created with it or switched to it.
      if (request.model !== null) await validate(loop.engine, settingsFor(request))
      const session = sessionFor(loop, request)
      // `/undo` and `/redo` act on this session (see `commands.ts`).
      offerSession(session)
      return {
        id: session.id,
        events: session.events,
        send: async (value, send = {}) =>
          session.send(value, {
            ...(send.delivery === undefined ? {} : { delivery: send.delivery }),
            ...(request.maxSteps === null ? {} : { maxSteps: request.maxSteps }),
          }),
        interrupt: () => session.interrupt(),
        close: stop,
      }
    },

    listSessions: async ({ cwd }): Promise<SessionSummary[]> => {
      const { store } = start()
      try {
        return store
          .listSessions()
          .filter((summary) => summary.session.cwd === cwd)
          .map((summary) => ({
            id: summary.session.id,
            title: summary.session.title,
            cwd: summary.session.cwd,
            updatedAt: summary.updatedAt,
            model: summary.session.settings.model,
          }))
      } finally {
        await stop()
      }
    },

    listModels: async (): Promise<ModelInfo[]> => {
      const fallback = options.defaultModel ?? DEFAULT_MODEL
      try {
        const models = await listModels({ accessToken })
        return models.map((model) => ({
          id: model.slug,
          description: model.displayName === model.slug ? null : model.displayName,
          efforts: model.reasoningEfforts,
          isDefault: model.slug === fallback,
        }))
      } catch (error) {
        if (error instanceof ModelListError) throw new EngineUnavailable(`could not list the models: ${signInHint(error.error.kind, error.message)}`)
        throw error
      }
    },
  }
}

function openStore(path: string): Store {
  try {
    return openSqliteStore({ path })
  } catch (error) {
    if (error instanceof StoreError && error.code === "locked")
      throw new EngineUnavailable(`another ${brand.binary} process is using the session database (${path}); close it first`)
    if (error instanceof StoreError && error.code === "schema_mismatch")
      throw new EngineUnavailable(`the session database (${path}) was written by another version of ${brand.name}`)
    throw error
  }
}

function open(engine: CoreEngine, id: SessionId): EngineSession {
  try {
    return engine.openSession(id, { resume: "wait" })
  } catch (error) {
    if (error instanceof EngineError && error.code === "session_not_found") throw new EngineUnavailable(`there is no session ${id}`)
    throw error
  }
}

/** Refuses a model the provider does not offer, naming the ones it does. */
async function validate(engine: CoreEngine, settings: SessionSettings): Promise<void> {
  try {
    await engine.validateSettings(settings)
  } catch (error) {
    if (error instanceof EngineError && error.code === "unknown_model") throw new EngineUnavailable(error.message)
    throw error
  }
}

/** Fails before a session is created or resumed when there is no usable sign-in. */
async function requireSignIn(): Promise<void> {
  try {
    await accessToken()
  } catch (error) {
    if (error instanceof AuthError) throw new EngineUnavailable(`${error.message} (sign in with ChatGPT, then try again)`)
    throw error
  }
}

function signInHint(kind: string, message: string) {
  return kind === "auth" ? `${message} (sign in with ChatGPT, then try again)` : message
}
