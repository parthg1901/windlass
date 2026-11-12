/**
 * Every step-loop scenario, by family, in the order docs/step-loop-scenarios.md
 * lists them, together with the vocabulary they are written in. Other
 * packages import this module as `@light-harness/core/testing/scenarios`.
 */
import { approvalScenarios } from "./approval.ts"
import { cancelScenarios } from "./cancel.ts"
import { compactionScenarios } from "./compaction.ts"
import { crashScenarios } from "./crash.ts"
import { happyPaths } from "./happy.ts"
import { refusalScenarios } from "./refusal.ts"
import { retryScenarios } from "./retry.ts"
import { revertScenarios } from "./revert.ts"
import type { Scenario } from "./script.ts"
import { shutdownScenarios } from "./shutdown.ts"
import { steeringScenarios } from "./steering.ts"
import { verificationScenarios } from "./verification.ts"

export * from "./script.ts"

export const families: Record<string, readonly Scenario[]> = {
  "Happy paths": happyPaths,
  "Cancel by the user": cancelScenarios,
  "Steering and queueing": steeringScenarios,
  Retries: retryScenarios,
  Refusal: refusalScenarios,
  "Crash recovery": crashScenarios,
  Shutdown: shutdownScenarios,
  Verification: verificationScenarios,
  Revert: revertScenarios,
  Compaction: compactionScenarios,
  "Approval and the sandbox": approvalScenarios,
}
