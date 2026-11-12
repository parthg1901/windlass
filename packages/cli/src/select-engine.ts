/**
 * Chooses the engine for a run: the fake engine for `--demo`, otherwise the
 * real one, loaded on demand so that a build without it (or with one that
 * fails to load) still runs demos and reports clearly.
 *
 * The real engine is reached one of two ways (`--engine`):
 * - `acp` (the default): through the Agent Client Protocol, as an editor
 *   reaches it, with `lh acp` as a child process (`./acp-engine.ts`);
 *   `acp-memory` is the same client with the server in this process.
 * - `direct`: the engine in this process, behind a thin adapter
 *   (`./real-engine.ts`). For debugging, and the reference the ACP path is
 *   tested against.
 */
import type { HarnessOptions } from "@light-harness/core"
import { type Scenario } from "@light-harness/core/testing/scenarios"
import type { AcpEngineOptions } from "./acp-engine.ts"
import type { Engine } from "./engine.ts"
import { FakeEngine, type FakeOptions } from "./fake-engine.ts"

/** An engine, or why there is none: `reason` is `null` when the real engine is simply not part of this build. */
export type Selected = { readonly kind: "engine"; readonly engine: Engine } | { readonly kind: "unavailable"; readonly reason: string | null }

/** How the CLI reaches the real engine (`--engine`). */
export type EngineKind = "acp" | "acp-memory" | "direct"
export const ENGINE_KINDS: readonly EngineKind[] = ["acp", "acp-memory", "direct"]

/** The module the direct engine lives in, relative to this file, and its factory's export name. */
export const REAL_ENGINE_MODULE = "./real-engine.ts"
export const REAL_ENGINE_EXPORT = "createRealEngine"
/** The module of the ACP client, and its factory's export name. */
export const ACP_ENGINE_MODULE = "./acp-engine.ts"
export const ACP_ENGINE_EXPORT = "createAcpEngine"

/** What the ACP client is started with. */
export type EngineContext = Pick<AcpEngineOptions, "env" | "stderr" | "version">

/**
 * `module` replaces the real engine's module (tests); it exports
 * `createRealEngine`, which is called with no arguments, as the direct
 * engine's factory is.
 */
export async function selectEngine(
  demo: { scenario: Scenario; options: FakeOptions } | null,
  module?: string,
  kind: EngineKind = "acp",
  context: EngineContext = {},
): Promise<Selected> {
  if (demo !== null) return { kind: "engine", engine: new FakeEngine(demo.scenario, demo.options) }
  if (module !== undefined) return loadRealEngine(module, REAL_ENGINE_EXPORT, [])
  if (kind === "acp") return loadRealEngine(ACP_ENGINE_MODULE, ACP_ENGINE_EXPORT, [{ ...context, transport: "child" } satisfies AcpEngineOptions])
  // In this process, the scripted model of tests (`LH_ACP_SCRIPT`) is read here; `lh acp` reads it itself.
  const harness = await scripted(context.env ?? {})
  if (kind === "direct") return loadRealEngine(REAL_ENGINE_MODULE, REAL_ENGINE_EXPORT, harness === null ? [] : [harness])
  return loadRealEngine(ACP_ENGINE_MODULE, ACP_ENGINE_EXPORT, [{ ...context, transport: "memory", ...(harness === null ? {} : { harness }) } satisfies AcpEngineOptions])
}

async function loadRealEngine(module: string, name: string, args: readonly unknown[]): Promise<Selected> {
  const url = new URL(module, import.meta.url)
  if (!(await Bun.file(url).exists())) return { kind: "unavailable", reason: null }
  let loaded: Record<string, unknown>
  try {
    loaded = await import(url.href)
  } catch (error) {
    return { kind: "unavailable", reason: `failed to load: ${describe(error)}` }
  }
  const create = loaded[name]
  if (typeof create !== "function") return { kind: "unavailable", reason: `${module} does not export ${name}` }
  try {
    return { kind: "engine", engine: (create as (...values: readonly unknown[]) => Engine)(...args) }
  } catch (error) {
    return { kind: "unavailable", reason: `failed to start: ${describe(error)}` }
  }
}

/** The harness options for the scripted model a test names in the environment, or `null`. */
async function scripted(env: Record<string, string | undefined>): Promise<HarnessOptions | null> {
  const { SCRIPT_ENV, scriptedProvider } = await import("@light-harness/acp")
  const path = env[SCRIPT_ENV]
  if (path === undefined || path === "") return null
  return { provider: await scriptedProvider(path) }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split("\n")[0] ?? ""
}
