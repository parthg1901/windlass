/** The memory A/B comparison on results directories in the format `run-agent.ts` writes. */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadResults } from "./baseline.ts"
import { RULES } from "./gate.ts"
import { compareMemory, exitCode, formatComparison } from "./memory-compare.ts"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** A results directory as `evals/run-agent.ts` writes it, with the fields the gate's statistics read. */
function resultsDir(name: string, runs: { task: string; passes: number; runs: number; input?: number; steps?: number }[], config = { model: "m1", effort: "high" }) {
  const dir = join(tempDir("wl-memory-ab-"), name)
  mkdirSync(dir, { recursive: true })
  const results = runs.flatMap((task) =>
    Array.from({ length: task.runs }, (_, index) => ({
      task: task.task,
      attempt: index + 1,
      pass: index < task.passes,
      status: index < task.passes ? "passed" : "failed",
      wallMs: 30_000,
      metrics: { steps: task.steps ?? 6, tokens: { input: task.input ?? 20_000, cached: 15_000, output: 800, reasoning: 0 } },
    })),
  )
  writeFileSync(join(dir, "results.json"), JSON.stringify({ startedAt: "2026-11-12T00:00:00Z", cli: [], out: dir, totals: {}, ...config, results }))
  return dir
}

describe("the A/B comparison", () => {
  const tasks = ["recall-convention", "use-project-tool", "avoid-past-mistake", "follow-preference"]

  test("a clear gain at a similar cost is a gain", async () => {
    const withMemory = await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 5, runs: 5, input: 21_000 })))])
    const without = await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 2, runs: 5 })))])
    const comparison = compareMemory(withMemory, without)
    expect(comparison.verdict).toBe("gain")
    expect(comparison.pooled).toMatchObject({ with: { passes: 20, runs: 20 }, without: { passes: 8, runs: 20 } })
    expect(comparison.pooled!.pGain).toBeLessThan(RULES.alpha)
    expect(comparison.tokenRatio).toBeCloseTo(1.05)
    expect(exitCode(comparison.verdict)).toBe(0)
    expect(formatComparison(comparison)).toContain("memory A/B: GAIN")
  })

  test("the same pass rate is no gain, and it says what a gain would have needed", async () => {
    const withMemory = await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 3, runs: 5 })))])
    const without = await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 3, runs: 5 })))])
    const comparison = compareMemory(withMemory, without)
    expect(comparison.verdict).toBe("no-gain")
    expect(comparison.reasons).toContain(`a gain at these sample sizes needed at least ${comparison.pooled!.minPassesForGain}/20 passes with memory`)
    expect(comparison.pooled!.minPassesForGain).toBeGreaterThan(12)
    expect(exitCode(comparison.verdict)).toBe(1)
  })

  test("a side without memory that never fails cannot show a gain, and the report says so", async () => {
    const withMemory = await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 3, runs: 3 })))])
    const without = await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 3, runs: 3 })))])
    const comparison = compareMemory(withMemory, without)
    expect(comparison.verdict).toBe("no-gain")
    expect(comparison.pooled!.minPassesForGain).toBeNull()
    expect(comparison.reasons.join("\n")).toContain("no result could show a gain")
  })

  test("a loss, or more cost for nothing, is worse; a gain that costs too much is a trade-off", async () => {
    const lose = compareMemory(
      await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 1, runs: 5 })))]),
      await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 5, runs: 5 })))]),
    )
    expect(lose.verdict).toBe("worse")
    const costly = compareMemory(
      await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 3, runs: 5, input: 40_000 })))]),
      await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 3, runs: 5, input: 20_000 })))]),
    )
    expect(costly).toMatchObject({ verdict: "worse", tokenRatio: 2 })
    const tradeOff = compareMemory(
      await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 5, runs: 5, input: 40_000 })))]),
      await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 1, runs: 5, input: 20_000 })))]),
    )
    expect(tradeOff.verdict).toBe("gain-at-cost")
  })

  test("not enough data: too few repeats, too few tasks, or tasks on one side only; never a pass", async () => {
    const fewRepeats = compareMemory(
      await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 2, runs: 2 })))]),
      await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 0, runs: 2 })))]),
    )
    expect(fewRepeats).toMatchObject({ verdict: "not-enough-data", pooled: null })
    expect(fewRepeats.reasons).toContain(`recall-convention: 2 run(s) with memory, 2 without; needs ${RULES.minRepeats} on each side`)
    expect(exitCode(fewRepeats.verdict)).toBe(3)

    const fewTasks = compareMemory(
      await loadResults([resultsDir("with", tasks.slice(0, 2).map((task) => ({ task, passes: 10, runs: 10 })))]),
      await loadResults([resultsDir("without", tasks.slice(0, 2).map((task) => ({ task, passes: 0, runs: 10 })))]),
    )
    // Even a huge gap on two tasks is no verdict: it could be two tasks that happen to suit memory.
    expect(fewTasks.verdict).toBe("not-enough-data")
    expect(fewTasks.reasons).toContain(`2 task(s) with enough runs; a verdict needs ${RULES.overallMinTasks}`)
    expect(formatComparison(fewTasks)).toContain("memory A/B: NOT ENOUGH DATA")

    const oneSided = compareMemory(
      await loadResults([resultsDir("with", [{ task: "only-here", passes: 5, runs: 5 }])]),
      await loadResults([resultsDir("without", [{ task: "elsewhere", passes: 5, runs: 5 }])]),
    )
    expect(oneSided.verdict).toBe("not-enough-data")
  })

  test("different configurations are not comparable", async () => {
    const comparison = compareMemory(
      await loadResults([resultsDir("with", tasks.map((task) => ({ task, passes: 5, runs: 5 })), { model: "m1", effort: "high" })]),
      await loadResults([resultsDir("without", tasks.map((task) => ({ task, passes: 1, runs: 5 })), { model: "m2", effort: "high" })]),
    )
    expect(comparison).toMatchObject({ verdict: "not-comparable", reasons: ["with memory ran m1/high, without ran m2/high"] })
  })

  test("the command line reads results directories and exits by verdict", async () => {
    const withDir = resultsDir("with", tasks.map((task) => ({ task, passes: 2, runs: 2 })))
    const withoutDir = resultsDir("without", tasks.map((task) => ({ task, passes: 1, runs: 2 })))
    const script = join(import.meta.dir, "memory-compare.ts")
    const run = Bun.spawnSync(["bun", script, "--with", withDir, "--without", withoutDir])
    expect(run.exitCode).toBe(3)
    expect(run.stdout.toString()).toContain("memory A/B: NOT ENOUGH DATA")
    expect(Bun.spawnSync(["bun", script, "--with", withDir]).exitCode).toBe(2)
  })
})
