/** Every step-loop scenario, by family, in the order docs/step-loop-scenarios.md lists them. */
import { cancelScenarios } from "./cancel.ts"
import { crashScenarios } from "./crash.ts"
import { happyPaths } from "./happy.ts"
import { refusalScenarios } from "./refusal.ts"
import { retryScenarios } from "./retry.ts"
import type { Scenario } from "./script.ts"
import { shutdownScenarios } from "./shutdown.ts"
import { steeringScenarios } from "./steering.ts"

export { todoScenarios } from "./todo.ts"

export const families: Record<string, readonly Scenario[]> = {
  "Happy paths": happyPaths,
  "Cancel by the user": cancelScenarios,
  "Steering and queueing": steeringScenarios,
  Retries: retryScenarios,
  Refusal: refusalScenarios,
  "Crash recovery": crashScenarios,
  Shutdown: shutdownScenarios,
}
