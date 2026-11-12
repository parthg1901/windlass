import type { CallFacts, Decision, DecisionInput, Grant, PathFact, TaintState } from "../../src/approval/index.ts"
import { CLEAN, DEFAULT_APPROVAL } from "../../src/approval/index.ts"

export const WS = "/w"
export const HOME = "/h"
export const NOW = 1_800_000_000_000

export function fact(real: string, place: PathFact["place"]): PathFact {
  const relative = place === "workspace" || place === "protected" ? real.slice(WS.length + 1) : null
  return { given: real, real, place, relative }
}

export function call(overrides: Partial<CallFacts> = {}): CallFacts {
  return { tool: "read", effect: "read", origin: "builtin", paths: [], command: null, escalation: null, ...overrides }
}

export const TAINTED: TaintState = { tainted: true, since: 10, sources: [{ at: 10, tool: "web_fetch", kind: "network-tool", path: null }] }

export function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    policy: DEFAULT_APPROVAL,
    call: call(),
    sandbox: { available: true },
    taint: CLEAN,
    grants: [],
    present: true,
    now: NOW,
    workspace: WS,
    home: HOME,
    ...overrides,
  }
}

export function sessionGrant(rule: Grant["rule"], at: number): Grant {
  return { scope: "session", rule, at, grantedAt: NOW - 1000 }
}

/** One letter per decision: R run, S sandboxed, N sandboxed with network, A ask, D deny, X deny and stop. */
export function code(decision: Decision): string {
  if (decision.kind === "run") return "R"
  if (decision.kind === "run_sandboxed") return decision.network ? "N" : "S"
  if (decision.kind === "ask") return "A"
  return decision.stop ? "X" : "D"
}

/** 0 loosest. Within run_sandboxed, more access is looser. */
export function rank(decision: Decision): number {
  return { run: 0, run_sandboxed: 1, ask: 2, deny: 3 }[decision.kind]
}

/** Whether `a` is at least as loose as `b`. */
export function notStricter(a: Decision, b: Decision): boolean {
  if (rank(a) !== rank(b)) return rank(a) < rank(b)
  if (a.kind === "run_sandboxed" && b.kind === "run_sandboxed")
    return (a.network || !b.network) && b.writableRoots.every((root) => a.writableRoots.includes(root))
  return true
}
