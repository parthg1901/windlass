/**
 * What the tests of the engine's session operations (fork, replay,
 * subagents, background commands) share: the real assembly
 * (`createHarness`) on a data directory in a temporary place, the real tools
 * and the real snapshot module in temporary workspaces, and a scripted model.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Harness, createHarness } from "../../src/assembly.ts"
import type { EngineEvent } from "../../src/engine/channel.ts"
import type { EngineSession } from "../../src/engine/engine.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../src/testing/fake-provider.ts"

const scratch: string[] = []
const open: Harness[] = []

/** Closes every harness a test started. Register with `afterEach`. */
export async function closeHarnesses() {
  for (const harness of open.splice(0)) await harness.close()
}

/** Removes every temporary directory. Register with `afterAll`. */
export function removePlaces() {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
}

export const SETTINGS = { model: "gpt-test", reasoningEffort: null }
export const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
export const say = (value: string): ScriptedResponse => [script.text(value)]
export const USAGE = (inputTokens: number, outputTokens = 10) => script.usage({ inputTokens, cachedInputTokens: 0, outputTokens, reasoningTokens: 0 })

/** A temporary root with a data directory and workspaces in it. */
export function place(prefix = "lh-ops-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  scratch.push(root)
  const workspace = (name: string, files: Record<string, string> = { "notes.md": "# Notes\n" }) => {
    const directory = join(root, name)
    mkdirSync(directory, { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true })
      writeFileSync(join(directory, path), content)
    }
    return directory
  }
  return { root, data: join(root, "data"), workspace }
}

export interface Started {
  readonly harness: Harness
  readonly provider: FakeProvider
  readonly logged: string[]
}

/** The real harness on `data` with a scripted model. The approval layer, the configuration and instruction discovery are off unless `more` turns them on. */
export function start(data: string, responses: readonly ScriptedResponse[], more: Parameters<typeof createHarness>[0] = {}): Started {
  const provider = new FakeProvider([...responses])
  const logged: string[] = []
  const harness = createHarness({
    dataDir: data,
    provider,
    log: (line) => logged.push(line),
    ...more,
    engine: { approval: null, loadConfig: null, discover: () => [], ...more.engine },
  })
  open.push(harness)
  return { harness, provider, logged }
}

/** Collects everything a session publishes. */
export function watch(session: EngineSession) {
  const events: EngineEvent[] = []
  session.subscribe((item) => events.push(item))
  const seen = async (predicate: (item: EngineEvent) => boolean, timeoutMs = 15_000) => {
    for (let waited = 0; !events.some(predicate); waited += 5) {
      if (waited > timeoutMs) throw new Error("timed out waiting for an event")
      await Bun.sleep(5)
    }
    return events.find(predicate)!
  }
  return { events, seen }
}

export const durable = (events: readonly EngineEvent[]) => events.filter((item): item is StoredEvent => "seq" in item)
export const typesOf = (events: readonly StoredEvent[]) => events.map((item) => item.type)

/** Waits until `check` holds. */
export async function until(check: () => boolean, timeoutMs = 15_000) {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > timeoutMs) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}
