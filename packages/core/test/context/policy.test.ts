import { describe, expect, test } from "bun:test"
import type { SizeEstimate } from "../../src/context/estimate.ts"
import {
  type CompactionOutcome,
  DEFAULT_COMPACTION_CONFIG,
  type PolicyInput,
  decideAfterOverflow,
  decideCompaction,
  ineffective,
  tailBudget,
} from "../../src/context/policy.ts"

// A usable window of exactly 100,000 tokens and a fixed margin of 1,000 make the shares easy to read.
const WINDOW = 110_000
const RESERVED = 10_000
const MARGIN = 1_000

const estimate = (total: number): SizeEstimate => ({ measured: total, estimated: 0, total, margin: MARGIN, basedOnMeasurement: true })

const input = (total: number, overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  contextWindow: WINDOW,
  reservedOutput: RESERVED,
  estimate: estimate(total),
  fixedTokens: 4_000,
  lastCompaction: null,
  atUserBoundary: false,
  ...overrides,
})

describe("decideCompaction thresholds", () => {
  test("below the early threshold nothing happens", () => {
    expect(decideCompaction(input(60_000))).toEqual({ kind: "none", share: 0.61 })
  })

  test("between the thresholds: soon mid-turn, now at a user-message boundary", () => {
    expect(decideCompaction(input(70_000)).kind).toBe("soon")
    const atBoundary = decideCompaction(input(70_000, { atUserBoundary: true }))
    expect(atBoundary).toMatchObject({ kind: "now", mode: "normal", trigger: "auto" })
  })

  test("over the trigger it compacts now, toward the normal target", () => {
    const decision = decideCompaction(input(79_500))
    expect(decision).toMatchObject({ kind: "now", mode: "normal", targetTokens: 40_000 })
    if (decision.kind !== "now") throw new Error("expected now")
    expect(decision.tailBudget).toBe(40_000 - 4_000 - DEFAULT_COMPACTION_CONFIG.summaryMaxTokens - DEFAULT_COMPACTION_CONFIG.checkpointExtraMaxTokens)
  })

  test("the margin counts: an estimate just under the trigger with its margin is over it", () => {
    expect(decideCompaction(input(79_100)).kind).toBe("now")
    expect(decideCompaction(input(79_100, { estimate: { ...estimate(79_100), margin: 0 } })).kind).toBe("soon")
  })

  test("rejects a window that leaves no room", () => {
    expect(() => decideCompaction(input(1, { contextWindow: 10_000, reservedOutput: 10_000 }))).toThrow(RangeError)
  })
})

describe("thrashing", () => {
  const weak: CompactionOutcome = { mode: "normal", before: 82_000, after: 70_000 }
  const strong: CompactionOutcome = { mode: "normal", before: 82_000, after: 35_000 }

  test("a compaction that freed less than a quarter is ineffective", () => {
    expect(ineffective(weak)).toBe(true)
    expect(ineffective(strong)).toBe(false)
  })

  test("after an effective compaction the normal rules apply", () => {
    expect(decideCompaction(input(85_000, { lastCompaction: strong })).kind).toBe("now")
  })

  test("after an ineffective one it holds while the request still fits and the context has not grown enough", () => {
    expect(decideCompaction(input(85_000, { lastCompaction: weak }))).toMatchObject({ kind: "hold" })
    // Grown by 25% of the usable window since: try again, normally.
    expect(decideCompaction(input(95_000, { lastCompaction: weak }))).toMatchObject({ kind: "now", mode: "normal" })
  })

  test("when the request would not fit, it escalates to an aggressive compaction once", () => {
    const decision = decideCompaction(input(99_500, { lastCompaction: weak }))
    expect(decision).toMatchObject({ kind: "now", mode: "aggressive", targetTokens: 20_000 })
  })

  test("after an ineffective aggressive compaction it gives up instead of compacting again", () => {
    const aggressive: CompactionOutcome = { mode: "aggressive", before: 99_000, after: 90_000 }
    expect(decideCompaction(input(99_500, { lastCompaction: aggressive }))).toMatchObject({ kind: "give_up" })
    expect(decideCompaction(input(91_000, { lastCompaction: aggressive }))).toMatchObject({ kind: "hold" })
  })
})

describe("decideAfterOverflow", () => {
  const overflow = (total: number, overrides: Partial<Parameters<typeof decideAfterOverflow>[0]> = {}) =>
    decideAfterOverflow({ ...input(total), completedStepSinceCompaction: true, lastCompactionWasOverflow: false, ...overrides })

  test("always compacts aggressively, even when the estimate says it fits", () => {
    expect(overflow(50_000)).toMatchObject({ kind: "now", mode: "aggressive", trigger: "overflow", targetTokens: 10_000 })
    expect(overflow(150_000)).toMatchObject({ kind: "now", mode: "aggressive", targetTokens: 20_000 })
  })

  test("gives up when the rejected request was built straight from an overflow or aggressive compaction", () => {
    const last: CompactionOutcome = { mode: "aggressive", before: 120_000, after: 30_000 }
    expect(overflow(90_000, { lastCompaction: last, completedStepSinceCompaction: false })).toMatchObject({ kind: "give_up" })
    expect(overflow(90_000, { lastCompaction: last, completedStepSinceCompaction: true }).kind).toBe("now")
    const normal: CompactionOutcome = { mode: "normal", before: 120_000, after: 30_000 }
    expect(overflow(90_000, { lastCompaction: normal, completedStepSinceCompaction: false, lastCompactionWasOverflow: true }).kind).toBe("give_up")
    expect(overflow(90_000, { lastCompaction: normal, completedStepSinceCompaction: false }).kind).toBe("now")
  })
})

test("tailBudget never goes negative", () => {
  expect(tailBudget(3_000, 4_000)).toBe(0)
})

test("decisions are deterministic", () => {
  expect(JSON.stringify(decideCompaction(input(85_000)))).toBe(JSON.stringify(decideCompaction(input(85_000))))
})
