/**
 * Every step-loop scenario, by family, in the order docs/step-loop-scenarios.md
 * lists them, together with the vocabulary they are written in. Other
 * packages import this module as `@light-harness/core/testing/scenarios`.
 */
import { approvalScenarios } from "./approval.ts"
import { cancelScenarios } from "./cancel.ts"
import { compactionScenarios } from "./compaction.ts"
import { crashScenarios } from "./crash.ts"
import { featureScenarios } from "./features.ts"
import { happyPaths } from "./happy.ts"
import { forkScenarios, lineageScenarios } from "./lineage.ts"
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
  "Replays, subagents and background work": lineageScenarios,
  "Skills, MCP servers and wake-ups": featureScenarios,
}

/**
 * Scenarios whose log spans two sessions' files (a fork's history begins
 * with its parent's events). Each scenario in `families` is one session's
 * log and can be stored as a session under any ID; these cannot, so a
 * consumer that stores scenarios takes `families` and leaves these out.
 */
export const forkFamilies: Record<string, readonly Scenario[]> = { Forks: forkScenarios }

/** Every scenario, in the order docs/step-loop-scenarios.md lists them. */
export const allFamilies: Record<string, readonly Scenario[]> = { ...families, ...forkFamilies }
