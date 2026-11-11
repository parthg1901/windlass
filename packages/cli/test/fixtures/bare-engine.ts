/** A real engine without the optional listing methods. */
import { findScenario } from "../../src/demo/scenarios.ts"
import type { Engine } from "../../src/engine.ts"
import { FakeEngine } from "../../src/fake-engine.ts"

export function createRealEngine(): Engine {
  return new FakeEngine(findScenario("a-plain-answer")!.scenario, { speed: 0 })
}
