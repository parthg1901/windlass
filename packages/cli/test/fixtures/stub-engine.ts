/**
 * A stand-in for `src/real-engine.ts`, loaded by tests through the same dynamic
 * import the CLI uses for the real one. It plays the "a-plain-answer" scenario
 * and records what the CLI asked for.
 */
import type { SessionId } from "@windlass/core"
import { findScenario } from "../../src/demo/scenarios.ts"
import type { Engine, OpenRequest } from "../../src/engine.ts"
import { FakeEngine } from "../../src/fake-engine.ts"

export const opened: OpenRequest[] = []

export function createRealEngine(): Engine {
  const fake = new FakeEngine(findScenario("a-plain-answer")!.scenario, { speed: 0 })
  return {
    open: async (request) => {
      opened.push(request)
      return fake.open(request)
    },
    listSessions: async ({ cwd }) => [
      { id: "ses_2" as SessionId, title: "Fix the add test", cwd, updatedAt: new Date(2026, 10, 11, 9, 5).getTime(), model: "gpt-test" },
      { id: "ses_1" as SessionId, title: null, cwd, updatedAt: new Date(2026, 10, 10, 17, 30).getTime(), model: "gpt-other" },
    ],
    listModels: async () => [
      { id: "gpt-test", description: "the default model", efforts: ["low", "medium", "high"], isDefault: true },
      { id: "gpt-other", description: null, efforts: [], isDefault: false },
    ],
  }
}
