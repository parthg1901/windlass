import { describe, expect, test } from "bun:test"
import {
  type ApprovalMode,
  CLEAN,
  type CallFacts,
  type DecisionInput,
  type Grant,
  type PathFact,
  type TaintState,
  approvalModes,
  decide,
} from "../../src/approval/index.ts"
import { HOME, NOW, WS, fact, input, notStricter } from "./fixtures.ts"

/** Deterministic, so a failure reproduces. */
function prng(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
}

const PATHS: PathFact[] = [
  fact(`${WS}/a.ts`, "workspace"),
  fact(`${WS}/.git/hooks/pre-push`, "protected"),
  fact("/o/x", "outside"),
  fact("/o/cache", "outside"),
  fact(`${HOME}/.ssh/id`, "hidden"),
  { given: "loop", real: null, place: "outside", relative: null },
  fact(HOME, "outside"),
]

const RULES: Grant["rule"][] = [
  { kind: "exec-sandboxed" },
  { kind: "exec-unsandboxed" },
  { kind: "sandbox-network" },
  { kind: "sandbox-write", root: "/o" },
  { kind: "write", root: "/o" },
  { kind: "write", root: WS },
  { kind: "write", root: `${WS}/.git` },
  { kind: "tool", tool: "web_fetch" },
  { kind: "tool", tool: "mcp__x" },
]

const TAINTS: TaintState[] = [
  { tainted: true, since: 10, sources: [{ at: 10, tool: "web_fetch", kind: "network-tool", path: null }] },
  { tainted: true, since: 30, sources: [{ at: 30, tool: "web_fetch", kind: "network-tool", path: null }] },
]

function generate(random: () => number): DecisionInput {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const some = <T,>(items: readonly T[]) => items.filter(() => random() < 0.3)
  const kind = pick(["read", "write", "exec", "network", "mcp"] as const)
  const call: CallFacts = {
    tool: kind === "mcp" ? "mcp__x" : kind === "network" ? "web_fetch" : kind === "exec" ? "shell" : kind,
    effect: kind === "mcp" ? pick(["read", "write", "exec", "network"] as const) : kind,
    origin: kind === "mcp" ? "mcp" : "builtin",
    paths: kind === "read" || kind === "write" ? some(PATHS) : [],
    command: kind === "exec" ? "make" : null,
    escalation: kind === "exec" && random() < 0.6 ? { network: random() < 0.5, write: some(PATHS) } : null,
  }
  const grants = some(RULES).map((rule): Grant =>
    random() < 0.5 ? { scope: "session", rule, at: Math.floor(random() * 40), grantedAt: NOW } : { scope: "project", rule, at: null, grantedAt: NOW - Math.floor(random() * 2) * 40 * 86_400_000 },
  )
  return input({
    policy: { mode: pick(approvalModes), unattended: pick(["deny", "stop"] as const), taint: pick(["enforce", "off"] as const) },
    call,
    sandbox: random() < 0.7 ? { available: true } : { available: false, reason: "no bwrap" },
    taint: random() < 0.5 ? CLEAN : pick(TAINTS),
    grants,
    present: random() < 0.6,
  })
}

const SAMPLES = 20_000
const looser = (mode: ApprovalMode) => approvalModes.slice(approvalModes.indexOf(mode) + 1)

describe("monotonicity", () => {
  test("widening the mode never makes a decision stricter", () => {
    const random = prng(1)
    for (let i = 0; i < SAMPLES; i += 1) {
      const base = generate(random)
      const before = decide(base)
      for (const mode of looser(base.policy.mode)) {
        const after = decide({ ...base, policy: { ...base.policy, mode } })
        if (!notStricter(after, before)) expect({ base, mode, before, after }).toBeNull()
      }
    }
  })

  test("adding taint never makes a decision looser", () => {
    const random = prng(2)
    for (let i = 0; i < SAMPLES; i += 1) {
      const base = { ...generate(random), taint: CLEAN }
      const clean = decide(base)
      for (const taint of TAINTS) {
        const tainted = decide({ ...base, taint })
        if (!notStricter(clean, tainted)) expect({ base, taint, clean, tainted }).toBeNull()
      }
    }
  })

  test("adding a grant never makes a decision stricter", () => {
    const random = prng(3)
    for (let i = 0; i < SAMPLES; i += 1) {
      const base = generate(random)
      const extra: Grant = { scope: "session", rule: RULES[Math.floor(random() * RULES.length)]!, at: Math.floor(random() * 40), grantedAt: NOW }
      const before = decide(base)
      const after = decide({ ...base, grants: [...base.grants, extra] })
      if (!notStricter(after, before)) expect({ base, extra, before, after }).toBeNull()
    }
  })

  test("no one present never makes a decision looser, and never asks", () => {
    const random = prng(4)
    for (let i = 0; i < SAMPLES; i += 1) {
      const base = generate(random)
      const present = decide({ ...base, present: true })
      const absent = decide({ ...base, present: false })
      expect(absent.kind).not.toBe("ask")
      if (!notStricter(present, absent)) expect({ base, present, absent }).toBeNull()
    }
  })
})
