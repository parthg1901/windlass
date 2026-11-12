/**
 * The one place the real harness is put together: the data directory, a
 * store per session in it (`store/directory.ts`), the ChatGPT-plan Responses
 * provider with the saved sign-in, the standard tools, the configuration
 * files and the defaults (the default model). The command-line interface and
 * the ACP server both call `createHarness()` and add only what is theirs:
 * arguments and a terminal, or a protocol.
 *
 * Nothing is opened until the engine is first used, so a process that only
 * prints help never touches the disk. Several harness processes share one
 * data directory: sessions are held one at a time, per session, and
 * everything else in the directory (blobs, spill files, snapshots, the
 * session index) is written so that several processes can do it at once.
 *
 * Every name, directory and binary comes from `brand`.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { AuthError, accessToken, dataDir as defaultDataDir } from "./auth/chatgpt.ts"
import { brand } from "./brand.ts"
import { loadConfig } from "./config/load.ts"
import { type Engine, type EngineOptions, createEngine } from "./engine/engine.ts"
import type { SessionSettings } from "./event/durable.ts"
import { OpenAIResponsesProvider, listModels } from "./provider/openai-responses.ts"
import type { Provider } from "./provider/provider.ts"
import { type SessionDirectory, openSessionDirectory } from "./store/directory.ts"
import type { AnyTool } from "./tool/tool.ts"
import { createStandardTools } from "./tools/index.ts"

/** The model a new session uses when neither the caller nor the configuration names one. */
export const DEFAULT_MODEL = "gpt-6.1-sol"
/** The reasoning effort a new session uses when nothing names one: `null` is the model's own default. */
export const DEFAULT_EFFORT: string | null = null
/** Where tool output that is too long for the model is written in full, under the data directory. */
export const SPILL_DIRECTORY = "spill"
/**
 * A test setting, never a user's: an environment variable that lowers the
 * context window the compaction policy works with to the given number of
 * tokens, so that a test or an evaluation run compacts after tens of
 * thousands of tokens instead of hundreds of thousands. It can only lower
 * the window, the harness says so on its log when it is set, and no
 * configuration file has a key for it.
 */
export const TEST_CONTEXT_WINDOW_ENV = `${brand.directory.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TEST_CONTEXT_WINDOW`

/** The window `TEST_CONTEXT_WINDOW_ENV` asks for, or `null` when it is not set to a whole number of tokens. */
export function testContextWindow(env: Record<string, string | undefined> = process.env): number | null {
  const value = env[TEST_CONTEXT_WINDOW_ENV]
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value.trim())) return null
  return Number(value.trim())
}

/** One model the account offers. */
export interface ModelEntry {
  readonly id: string
  /** A name to show; the ID when the provider gives none. */
  readonly name: string
  /** Reasoning efforts the model accepts; empty when it has none. */
  readonly efforts: readonly string[]
  /** The effort the model uses when none is set, when the provider says. */
  readonly defaultEffort: string | null
  /** Context window in tokens, when the provider says. */
  readonly contextWindow: number | null
}

export type SignInState = { readonly signedIn: true } | { readonly signedIn: false; readonly message: string }

export interface HarnessOptions {
  /** Defaults to `<data home>/<brand.directory>`, where the sign-in is kept too. */
  readonly dataDir?: string
  /** Instead of the ChatGPT-plan provider (tests, a scripted model). With one, the sign-in is not checked and no model is listed. */
  readonly provider?: Provider
  /** Instead of the standard tools. */
  readonly tools?: readonly AnyTool[]
  readonly defaultModel?: string
  readonly defaultEffort?: string | null
  /** One line of the engine's log, and notices about the data directory. Defaults to standard error, prefixed with the binary's name. */
  readonly log?: (line: string) => void
  /** Instead of reading the saved sign-in. */
  readonly signIn?: () => Promise<SignInState>
  /** Instead of asking the provider for the account's models. */
  readonly models?: (signal?: AbortSignal) => Promise<readonly ModelEntry[]>
  /** Passed through to the step loop (limits, clock, instruction discovery, hooks, ...). */
  readonly engine?: Partial<Omit<EngineOptions, "store" | "provider" | "tools" | "dataDir">>
}

export interface Harness {
  readonly dataDir: string
  readonly defaults: { readonly model: string; readonly effort: string | null }
  /**
   * The engine on the session directory, built on first use. Throws once the
   * harness is closed.
   */
  readonly engine: Engine
  /** The session directory under the engine: for a tool that reads sessions (an exporter), never for writing around the engine. */
  readonly sessions: SessionDirectory
  /** Whether a model call can be made: the saved ChatGPT sign-in exists and yields a token. Always signed in with a provider of the caller's. */
  readonly signIn: () => Promise<SignInState>
  /** The account's models, in the provider's order. Rejects with `ModelListError` when they cannot be listed. Empty with a provider of the caller's. */
  readonly listModels: (signal?: AbortSignal) => Promise<readonly ModelEntry[]>
  /**
   * The settings a new session in `cwd` starts with: what the caller asks
   * for, else what the configuration files that apply there name, else the
   * defaults. A configuration that cannot be read is not reported here: the
   * session's first execution fails with it, before anything is sent.
   */
  readonly settingsFor: (cwd: string, asked?: { readonly model?: string | null; readonly effort?: string | null }) => Promise<SessionSettings>
  /**
   * The shutdown every way out of a process goes through: every session is
   * stopped as a shutdown (it resumes later) and let go of, then the data
   * directory is. Safe to call more than once.
   */
  readonly close: () => Promise<void>
  readonly closed: boolean
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dataDir = options.dataDir ?? defaultDataDir()
  const log = options.log ?? ((line: string) => void process.stderr.write(`${brand.binary}: ${line}\n`))
  const defaults = {
    model: options.defaultModel ?? DEFAULT_MODEL,
    effort: options.defaultEffort === undefined ? DEFAULT_EFFORT : options.defaultEffort,
  }
  let running: { readonly sessions: SessionDirectory; readonly engine: Engine } | null = null
  let closing: Promise<void> | null = null

  const start = () => {
    if (closing !== null) throw new Error(`${brand.name} is shutting down`)
    if (running !== null) return running
    mkdirSync(dataDir, { recursive: true })
    const sessions = openSessionDirectory({ dataDir, notice: log })
    const spillDir = join(dataDir, SPILL_DIRECTORY)
    // The context window the compaction policy measures against: the provider's, per model, asked for once.
    let catalogue: Promise<readonly { readonly slug: string; readonly contextWindow: number | null }[]> | null = null
    const providerWindow = async (model: string) => {
      catalogue ??= listModels({ accessToken, listedOnly: false }).catch(() => [])
      return (await catalogue).find((entry) => entry.slug === model)?.contextWindow ?? null
    }
    const lowered = testContextWindow()
    if (lowered !== null) log(`${TEST_CONTEXT_WINDOW_ENV} is set: the context window is taken to be at most ${lowered} tokens (a test setting)`)
    const contextWindow = async (model: string) => {
      const real = options.provider === undefined ? await providerWindow(model) : ((await options.engine?.contextWindow?.(model)) ?? null)
      return lowered === null ? real : real === null ? lowered : Math.min(real, lowered)
    }
    const provider =
      options.provider ??
      new OpenAIResponsesProvider({
        accessToken,
        readBlob: (ref) => {
          const blob = sessions.getBlob(ref.hash)
          if (blob === null) throw new Error(`blob ${ref.hash} is not in the blob store`)
          return blob.bytes
        },
      })
    const engine = createEngine({
      ...(options.provider === undefined
        ? {
            // On a rejected sign-in the token is looked up once more (it is refreshed when it is due) before the step fails.
            refreshAuth: () =>
              accessToken().then(
                () => true,
                () => false,
              ),
            // What a model name is checked against. A provider of the caller's has no listing, so nothing is checked.
            listModels: () => listModels({ accessToken }).then((models) => models.map((model) => model.slug)),
          }
        : {}),
      log,
      ...options.engine,
      // With a provider of the caller's the window is the caller's to give; the test setting lowers either.
      ...(options.provider === undefined || options.engine?.contextWindow !== undefined || lowered !== null ? { contextWindow } : {}),
      store: sessions,
      provider,
      tools: options.tools ?? createStandardTools({ spillDir }),
      dataDir,
      spillDir,
    })
    running = { sessions, engine }
    return running
  }

  return {
    dataDir,
    defaults,
    get engine() {
      return start().engine
    },
    get sessions() {
      return start().sessions
    },
    get closed() {
      return closing !== null
    },
    signIn: async () => {
      if (options.signIn !== undefined) return options.signIn()
      if (options.provider !== undefined) return { signedIn: true }
      try {
        await accessToken()
        return { signedIn: true }
      } catch (error) {
        if (error instanceof AuthError) return { signedIn: false, message: error.message }
        throw error
      }
    },
    listModels: async (signal) => {
      if (options.models !== undefined) return options.models(signal)
      if (options.provider !== undefined) return []
      const models = await listModels({ accessToken, ...(signal === undefined ? {} : { signal }) })
      return models.map((model) => ({
        id: model.slug,
        name: model.displayName,
        efforts: model.reasoningEfforts,
        defaultEffort: model.defaultReasoningEffort,
        contextWindow: model.contextWindow,
      }))
    },
    settingsFor: async (cwd, asked = {}) => {
      // The same configuration the engine verifies with, so a test that switches it off switches this off too.
      const load = options.engine?.loadConfig === undefined ? (directory: string) => loadConfig({ cwd: directory }) : options.engine.loadConfig
      const config =
        load === null
          ? null
          : await load(cwd).then(
              (loaded) => loaded.config,
              () => null,
            )
      return {
        model: asked.model ?? config?.model ?? defaults.model,
        reasoningEffort: asked.effort ?? config?.effort ?? defaults.effort,
      }
    },
    close: () => {
      closing ??= (async () => {
        const current = running
        if (current === null) return
        await current.engine.close()
        current.sessions.close()
      })()
      return closing
    },
  }
}
