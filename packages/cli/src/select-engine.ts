/**
 * Chooses the engine for a run: the fake engine for `--demo`, otherwise the
 * real one, loaded on demand from `./real-engine.ts` so that a build without
 * it (or with one that fails to load) still runs demos and reports clearly.
 */
import { type Scenario } from "@light-harness/core/testing/scenarios"
import type { Engine } from "./engine.ts"
import { FakeEngine, type FakeOptions } from "./fake-engine.ts"

/** An engine, or why there is none: `reason` is `null` when the real engine is simply not part of this build. */
export type Selected = { readonly kind: "engine"; readonly engine: Engine } | { readonly kind: "unavailable"; readonly reason: string | null }

/** The module the real engine lives in, relative to this file, and its factory's export name. */
export const REAL_ENGINE_MODULE = "./real-engine.ts"
export const REAL_ENGINE_EXPORT = "createRealEngine"

export async function selectEngine(demo: { scenario: Scenario; options: FakeOptions } | null, module = REAL_ENGINE_MODULE): Promise<Selected> {
  if (demo !== null) return { kind: "engine", engine: new FakeEngine(demo.scenario, demo.options) }
  return loadRealEngine(module)
}

async function loadRealEngine(module: string): Promise<Selected> {
  const url = new URL(module, import.meta.url)
  if (!(await Bun.file(url).exists())) return { kind: "unavailable", reason: null }
  let loaded: Record<string, unknown>
  try {
    loaded = await import(url.href)
  } catch (error) {
    return { kind: "unavailable", reason: `failed to load: ${describe(error)}` }
  }
  const create = loaded[REAL_ENGINE_EXPORT]
  if (typeof create !== "function") return { kind: "unavailable", reason: `${module} does not export ${REAL_ENGINE_EXPORT}` }
  try {
    return { kind: "engine", engine: (create as () => Engine)() }
  } catch (error) {
    return { kind: "unavailable", reason: `failed to start: ${describe(error)}` }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split("\n")[0] ?? ""
}
