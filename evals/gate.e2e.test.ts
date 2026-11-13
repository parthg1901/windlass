// The regression gate and the baseline generator, on crafted results directories. No agent runs here.
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Baseline, BASELINE_FILE, buildBaseline, loadResults } from "./baseline.ts"
import { skipped } from "./classify.ts"
import { RULES, fisherLower, formatGate, gate, passRateRegression } from "./gate.ts"
import { type Report, type RunResult, computeMetrics, totalsOf } from "./run-agent.ts"
import { E2E_TIMEOUT_MS } from "../packages/core/src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const scratch = { dir: "" }
beforeAll(async () => {
  scratch.dir = await mkdtemp(join(tmpdir(), "gate-test-"))
})
afterAll(() => rm(scratch.dir, { recursive: true, force: true }))

/** A clean, classified, passing run; `change` overrides any field, `steps` and `input` shape its stream. */
function runOf(task: string, attempt: number, change: Partial<RunResult> & { steps?: number; input?: number; stream?: string } = {}): RunResult {
  const steps = change.steps ?? 5
  const input = change.input ?? 10_000
  const stream =
    change.stream ??
    [
      { type: "execution.started", v: 1, data: { executionId: "exe_1" } },
      ...Array.from({ length: steps }, (_, index) => [
        { type: "step.started", v: 1, data: { messageId: `m${index}`, attempt: 1, model: "m" } },
        { type: "step.ended", v: 1, data: { messageId: `m${index}`, finish: "stop", usage: { inputTokens: Math.round(input / steps), cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 } } },
      ]).flat(),
      { type: "execution.succeeded", v: 1, data: { executionId: "exe_1", verification: { status: "not_configured" } } },
    ]
      .map((item, index) => JSON.stringify({ ...item, sessionId: "ses_g", seq: index + 1, time: 0 }))
      .join("\n")
  const { steps: _steps, input: _input, stream: _stream, ...rest } = change
  return {
    task,
    attempt,
    pass: true,
    reason: "ok: fine",
    exitCode: 0,
    signal: null,
    wallMs: 20_000,
    timedOut: false,
    killed: false,
    timeoutSeconds: 300,
    turns: [{ prompt: 1, exitCode: 0, signal: null, wallMs: 20_000, timedOut: false, killed: false }],
    prompts: 1,
    maxSteps: 20,
    overStepLimit: false,
    status: "passed",
    metrics: computeMetrics(stream, 20),
    cache: { ...skipped(""), status: "classified", reason: null, records: steps, fullRequest: steps, fullFidelity: true },
    traceFile: null,
    eventsFile: "",
    stderrFile: "",
    workspace: null,
    ...rest,
  }
}

const dirs = { count: 0 }
async function resultsDir(results: RunResult[], config: { model?: string | null; effort?: string | null; sha?: string; startedAt?: string } = {}) {
  const out = join(scratch.dir, `results-${++dirs.count}`)
  const report: Report = {
    startedAt: config.startedAt ?? "2026-11-12T10:00:00.000Z",
    commit: { sha: config.sha ?? "abc1234", dirty: false },
    cli: ["windlass"],
    model: config.model === undefined ? "gpt-test" : config.model,
    effort: config.effort === undefined ? "low" : config.effort,
    out,
    // A run read back from an older results.json may have no `cache`; the totals of the time had none either.
    totals: totalsOf(results.map((run) => ({ ...run, cache: run.cache ?? skipped("") }))),
    results,
  }
  await Bun.write(join(out, "results.json"), JSON.stringify(report))
  return out
}

/** `n` runs of each task, passing unless `fails` says how many of that task's runs fail. */
function repeats(tasks: readonly string[], n: number, shape: { fails?: Record<string, number>; steps?: Record<string, number>; input?: Record<string, number> } = {}) {
  return tasks.flatMap((task) =>
    Array.from({ length: n }, (_, index) => {
      const failed = index < (shape.fails?.[task] ?? 0)
      return runOf(task, index + 1, {
        pass: failed ? false : true,
        status: failed ? "failed" : "passed",
        ...(shape.steps?.[task] === undefined ? {} : { steps: shape.steps[task] }),
        ...(shape.input?.[task] === undefined ? {} : { input: shape.input[task] }),
      })
    }),
  )
}

const TASKS = ["alpha", "beta", "gamma", "delta"]
/** A baseline with one batch per argument: each is one results directory. */
async function baselineOf(...batches: RunResult[][]) {
  return buildBaseline(await loadResults(await Promise.all(batches.map((runs) => resultsDir(runs)))))
}
/** One task's runs of one batch, from what each run cost. */
function samples(task: string, runs: readonly { steps: number; input: number; pass?: boolean }[]) {
  return runs.map((run, index) => runOf(task, index + 1, { steps: run.steps, input: run.input, pass: run.pass ?? true, status: run.pass === false ? "failed" : "passed" }))
}
async function judge(runs: RunResult[], baseline: Baseline | null, options: { hardOnly?: boolean } = {}) {
  return gate(await loadResults([await resultsDir(runs)]), baseline, options)
}
const rules = (result: Awaited<ReturnType<typeof gate>>, level?: string) => result.findings.filter((finding) => level === undefined || finding.level === level).map((finding) => `${finding.rule} ${finding.scope}`)

describe("statistics", () => {
  test("Fisher's one-sided test gives the textbook values", () => {
    expect(fisherLower(3, 3, 0, 3)).toBeCloseTo(0.05, 10)
    expect(fisherLower(5, 5, 0, 5)).toBeCloseTo(1 / 252, 10)
    expect(fisherLower(5, 5, 5, 5)).toBe(1)
    expect(fisherLower(9, 10, 4, 10)).toBeCloseTo(0.0286, 3)
  })

  test("a perfect task failing in a majority is a regression; one failure is noise", () => {
    expect(passRateRegression(3, 3, 1, 3)).toContain("majority")
    expect(passRateRegression(5, 5, 2, 5)).toContain("majority")
    expect(passRateRegression(5, 5, 4, 5)).toBeNull()
    expect(passRateRegression(5, 5, 3, 5)).toBeNull()
    // A flaky task: only a drop Fisher finds significant counts.
    expect(passRateRegression(4, 5, 1, 5)).toBeNull()
    expect(passRateRegression(9, 10, 4, 10)).toContain("Fisher")
  })
})

describe("a clean run against a matching baseline", () => {
  test("passes with exit 0 when every check has its data", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3), repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3), baseline)
    expect(rules(result, "fail")).toEqual([])
    expect(rules(result, "regression")).toEqual([])
    expect(rules(result, "no-data")).toEqual([])
    expect(result.verdict).toBe("pass")
    expect(result.exitCode).toBe(0)
    expect(rules(result, "info")).toEqual(["wall-time overall", "cached-share overall"])
    expect(formatGate(result)).toMatch(/gate: PASS {2}0 hard failure\(s\), 0 regression\(s\), 0 warning\(s\), 0 without enough data, \d+ check\(s\) passed/)
  })

  test("model noise does not flap it: one failure per task, 1.4x tokens, two extra steps", async () => {
    const baseline = await baselineOf(repeats(TASKS, 5))
    const result = await judge(repeats(TASKS, 5, { fails: { alpha: 1, beta: 2 }, input: { gamma: 14_000 }, steps: { delta: 7 } }), baseline)
    expect(rules(result, "regression")).toEqual([])
    expect(result.exitCode).toBe(0)
  })
})

describe("hard failures, regardless of the baseline", () => {
  const hard = async (run: RunResult) => {
    const result = await judge([run], null, { hardOnly: true })
    expect(result.exitCode).toBe(1)
    return result.findings.filter((finding) => finding.level === "fail")
  }

  test("an avoidable cache miss, with its cause", async () => {
    const run = runOf("alpha", 1)
    const findings = await hard({ ...run, cache: { ...run.cache, avoidable: 1, avoidableCauses: ["turn 3: tools_changed: tool list changed (+1 tool: 2 → 3)"] } })
    expect(findings.map((finding) => `${finding.rule} ${finding.scope}: ${finding.message}`)).toEqual(["avoidable-miss alpha#1: avoidable cache miss, turn 3: tools_changed: tool list changed (+1 tool: 2 → 3)"])
  })

  test("a record not exported with full-request fidelity", async () => {
    const run = runOf("alpha", 1)
    const findings = await hard({ ...run, cache: { ...run.cache, fullFidelity: false, unfaithful: [{ turn: 2, messageId: "m1", reason: "hash_mismatch" }] } })
    expect(findings.map((finding) => finding.rule)).toEqual(["usage-only-record"])
    expect(findings[0]!.message).toContain("trace call 2 exported usage-only (hash_mismatch)")
  })

  test("a run without an execution end", async () => {
    const findings = await hard(runOf("alpha", 1, { stream: JSON.stringify({ type: "execution.started", v: 1, data: { executionId: "e" }, sessionId: "s", seq: 1, time: 0 }) }))
    expect(findings.map((finding) => finding.rule)).toEqual(["no-execution-end"])
  })

  const unsafe = (outcome: string, interrupted: boolean) =>
    [
      { type: "execution.started", v: 1, data: { executionId: "e" } },
      { type: "tool.called", v: 1, data: { messageId: "m", callId: "c", name: "shell", input: "{}", providerData: null } },
      { type: "tool.settled", v: 1, data: { messageId: "m", callId: "c", outcome, output: "", truncation: null, attachments: [], display: null } },
      interrupted ? { type: "execution.interrupted", v: 1, data: { executionId: "e", reason: "user" } } : { type: "execution.succeeded", v: 1, data: { executionId: "e", verification: { status: "not_configured" } } },
    ]
      .map((item, index) => JSON.stringify({ ...item, sessionId: "s", seq: index + 1, time: 0 }))
      .join("\n")

  test("an effect-unknown or not-started tool call in a run that was not interrupted", async () => {
    expect((await hard(runOf("alpha", 1, { stream: unsafe("effect_unknown", false) }))).map((finding) => finding.rule)).toEqual(["effect-unknown"])
    expect((await hard(runOf("alpha", 1, { stream: unsafe("not_started", false) }))).map((finding) => finding.rule)).toEqual(["not-started"])
  })

  test("the same outcomes after an interrupt are expected, not failures", async () => {
    const result = await judge([runOf("alpha", 1, { stream: unsafe("effect_unknown", true), timedOut: true, status: "timeout", pass: false })], null, { hardOnly: true })
    expect(rules(result, "fail")).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  test("a malformed event", async () => {
    const findings = await hard(runOf("alpha", 1, { stream: `${unsafe("success", false)}\n{"type": "step.ended", "v": 1, "data": {}}` }))
    expect(findings.map((finding) => finding.rule)).toEqual(["malformed-event"])
  })

  test("a run killed after ignoring Ctrl-C, or far over its limit", async () => {
    expect((await hard(runOf("alpha", 1, { killed: true, timedOut: true, wallMs: 316_000, status: "killed", pass: false }))).map((finding) => finding.rule)).toEqual(["time-limit"])
    expect((await hard(runOf("alpha", 1, { wallMs: 300_000 * RULES.overrunFactor + 1 }))).map((finding) => finding.message)).toEqual(["ran 450.0s, more than 1.5x its 300 s limit"])
    // Stopping on Ctrl-C at the limit is model slowness, not a harness bug.
    const stopped = await judge([runOf("alpha", 1, { timedOut: true, wallMs: 302_000, status: "timeout", pass: false })], null, { hardOnly: true })
    expect(stopped.exitCode).toBe(0)
  })

  test("setup and classification errors", async () => {
    const run = runOf("alpha", 1)
    expect((await hard({ ...run, status: "error", pass: false, reason: "setup failed: boom" })).map((finding) => finding.rule)).toEqual(["setup-failed"])
    expect((await hard({ ...run, cache: skipped("export failed (1): no session", "error") })).map((finding) => finding.rule)).toEqual(["classification-error"])
  })

  test("unclassified runs leave the cache rules unchecked: inconclusive, never a pass", async () => {
    const result = await judge([{ ...runOf("alpha", 1), cache: skipped("no prefixlens checkout at /x") }], null, { hardOnly: true })
    expect(rules(result, "unchecked")).toEqual(["cache-classification overall"])
    expect(result.findings[0]!.message).toContain("alpha#1 (no prefixlens checkout at /x)")
    expect(result.verdict).toBe("inconclusive")
    expect(result.exitCode).toBe(3)
  })

  test("results from before classification existed count as unclassified", async () => {
    const { cache: _cache, ...old } = runOf("alpha", 1)
    const result = await judge([old as RunResult], null, { hardOnly: true })
    expect(rules(result, "unchecked")).toEqual(["cache-classification overall"])
  })
})

describe("statistical comparisons", () => {
  test("not enough repeats on either side is reported as such, and the verdict is inconclusive", async () => {
    const thin = await baselineOf(repeats(TASKS, 1))
    const result = await judge(repeats(TASKS, 3), thin)
    expect(rules(result, "no-data")).toEqual(["repeats alpha", "repeats beta", "repeats delta", "repeats gamma", "pass-rate overall", "input-tokens overall"])
    expect(result.findings.find((finding) => finding.scope === "alpha")!.message).toBe("baseline 1 run(s), new 3; pass rate, tokens and steps need 3 on each side")
    expect(result.verdict).toBe("inconclusive")
    expect(result.exitCode).toBe(3)
    expect(formatGate(result)).not.toContain("PASS")

    const fewNew = await judge(repeats(TASKS, 2), await baselineOf(repeats(TASKS, 3)))
    expect(rules(fewNew, "no-data")).toContain("repeats alpha")
    expect(fewNew.exitCode).toBe(3)
  })

  test("a task that always passed and now fails in a majority", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3, { fails: { beta: 2 } }), baseline)
    expect(rules(result, "regression")).toEqual(["pass-rate beta"])
    expect(result.findings.find((finding) => finding.level === "regression")!.message).toBe("passed 3/3 in the baseline, 1/3 now (never failed in the baseline, now fails in a majority)")
    expect(result.exitCode).toBe(1)
  })

  test("the overall pass rate, pooled over tasks", async () => {
    const baseline = await baselineOf(repeats(TASKS, 5, { fails: { alpha: 1, beta: 1, gamma: 1, delta: 1 } }))
    // Each task alone drops 4/5 -> 2/5 (not significant per task); together 16/20 -> 8/20 is.
    const result = await judge(repeats(TASKS, 5, { fails: { alpha: 3, beta: 3, gamma: 3, delta: 3 } }), baseline)
    expect(rules(result, "regression")).toEqual(["pass-rate overall"])
  })

  test("input tokens and steps outside the tolerance band", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3), repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3, { input: { alpha: 16_000 }, steps: { beta: 9 } }), baseline)
    expect(rules(result, "regression")).toEqual(["input-tokens alpha", "steps beta"])
    expect(result.findings.find((finding) => finding.rule === "input-tokens")!.message).toBe(
      "median input 16.0k against batch medians of 10.0k, 10.0k in the baseline (over 1.5x and +5.0k on the highest), every run above the baseline's most expensive (16.0k or more against 10.0k)",
    )
  })

  test("the absolute floors keep small tasks from flapping", async () => {
    const small = () => repeats(TASKS, 3, { input: { alpha: 4000 }, steps: { beta: 2 } })
    const result = await judge(repeats(TASKS, 3, { input: { alpha: 8000 }, steps: { beta: 4 } }), await baselineOf(small(), small()))
    expect(rules(result, "regression")).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  test("a cost shift across every task is caught overall even when each task stays inside its band", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3), repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3, { input: { alpha: 13_000, beta: 13_000, gamma: 13_000, delta: 13_000 } }), baseline)
    expect(rules(result, "regression")).toEqual(["input-tokens overall"])
    expect(result.findings.find((finding) => finding.level === "regression")!.message).toBe("median per-task input-token ratio 1.30 against each task's most expensive baseline batch (over 1.25)")
    // Against one batch the same shift is a warning, and the verdict stands.
    const warned = await judge(repeats(TASKS, 3, { input: { alpha: 13_000, beta: 13_000, gamma: 13_000, delta: 13_000 } }), await baselineOf(repeats(TASKS, 3)))
    expect(rules(warned, "regression")).toEqual([])
    expect(rules(warned, "warning")).toEqual(["input-tokens overall"])
    expect(warned.exitCode).toBe(0)
  })

  test("another configuration is not comparable", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3))
    const results = await loadResults([await resultsDir(repeats(TASKS, 3), { model: "other-model" })])
    const result = await gate(results, baseline)
    expect(rules(result, "no-data")).toEqual(["configuration overall"])
    expect(result.findings.find((finding) => finding.level === "no-data")!.message).toBe("results are for other-model/low, the baseline for gpt-test/low: not comparable")
    expect(result.exitCode).toBe(3)
  })

  test("--hard-only skips the comparisons", async () => {
    const result = await judge(repeats(TASKS, 1), await baselineOf(repeats(TASKS, 1)), { hardOnly: true })
    expect(result.findings).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  test("new and missing tasks are reported, not judged", async () => {
    const baseline = await baselineOf(repeats(["alpha", "beta", "gamma"], 3))
    const result = await judge(repeats(["alpha", "beta", "delta"], 3), baseline)
    expect(rules(result, "info")).toContain("new-task delta")
    expect(rules(result, "info")).toContain("missing-task gamma")
  })
})

// The numbers of the first nightly run. One task, same code: a median of 16 steps / 181k input tokens in the batch
// the baseline was recorded from, 24 to 39 steps / 300k to 508k the same evening. Another flipped 3/3 to 0/3.
describe("cost and pass rate against the baseline's batches", () => {
  const AUDIT = "audit-every-handler"
  const cheap = () => [...repeats(TASKS, 3), ...samples(AUDIT, [{ steps: 14, input: 160_000 }, { steps: 16, input: 181_000 }, { steps: 19, input: 204_000 }])]
  const expensive = () => [...repeats(TASKS, 3), ...samples(AUDIT, [{ steps: 24, input: 300_000 }, { steps: 31, input: 402_000 }, { steps: 39, input: 508_000 }])]
  const against = (runs: { steps: number; input: number }[]) => [...repeats(TASKS, 3), ...samples(AUDIT, runs)]

  test("the same code on an expensive evening passes against a baseline with a cheap and an expensive batch", async () => {
    const baseline = await baselineOf(cheap(), expensive())
    expect(baseline.tasks[AUDIT]).toMatchObject({ runs: 6, passes: 6, medianSteps: 21.5 })
    expect(baseline.tasks[AUDIT]!.batches!.map((batch) => [batch.medianSteps, Math.round(batch.medianInputTokens / 1000)])).toEqual([[16, 181], [31, 402]])
    const control = await judge(against([{ steps: 26, input: 318_000 }, { steps: 33, input: 421_000 }, { steps: 37, input: 489_000 }]), baseline)
    expect(control.findings.filter((finding) => finding.level !== "info")).toEqual([])
    expect(control.verdict).toBe("pass")
    expect(control.exitCode).toBe(0)
    // An evening more expensive than either batch on record, within the margin.
    const dearer = await judge(against([{ steps: 30, input: 380_000 }, { steps: 39, input: 508_000 }, { steps: 45, input: 590_000 }]), baseline)
    expect(dearer.findings.filter((finding) => finding.level !== "info")).toEqual([])
    expect(dearer.exitCode).toBe(0)
  })

  test("a median over the margin is not a regression while one run is no more expensive than the baseline's worst", async () => {
    const result = await judge(against([{ steps: 35, input: 480_000 }, { steps: 50, input: 640_000 }, { steps: 56, input: 700_000 }]), await baselineOf(cheap(), expensive()))
    expect(result.findings.filter((finding) => finding.level !== "info")).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  test("every run twice the most expensive baseline batch is a regression", async () => {
    const result = await judge(against([{ steps: 48, input: 600_000 }, { steps: 62, input: 804_000 }, { steps: 78, input: 1_016_000 }]), await baselineOf(cheap(), expensive()))
    expect(rules(result, "regression")).toEqual([`input-tokens ${AUDIT}`, `steps ${AUDIT}`])
    expect(result.findings.filter((finding) => finding.level === "regression").map((finding) => finding.message)).toEqual([
      "median input 804.0k against batch medians of 181.0k, 402.0k in the baseline (over 1.5x and +5.0k on the highest), every run above the baseline's most expensive (600.0k or more against 508.0k)",
      "median steps 62 against batch medians of 16, 31 in the baseline (over 1.5x and +2 on the highest), every run above the baseline's most expensive (48 or more against 39)",
    ])
    expect(result.verdict).toBe("fail")
    expect(result.exitCode).toBe(1)
  })

  test("against a baseline with one batch the expensive evening is a warning, and the verdict stands", async () => {
    const baseline = await baselineOf(cheap())
    const result = await judge(expensive(), baseline)
    expect(rules(result, "regression")).toEqual([])
    expect(rules(result, "warning")).toEqual([`input-tokens ${AUDIT}`, `steps ${AUDIT}`])
    expect(result.findings.find((finding) => finding.rule === "steps")!.message).toBe(
      "median steps 16 -> 31 (over 1.5x and +2), every run above the baseline's most expensive (24 or more against 19); the baseline has one batch, so how much this varies between batches is unknown: a warning, not a regression",
    )
    expect(result.findings.find((finding) => finding.rule === "baseline-batches")).toMatchObject({ level: "info", scope: "overall" })
    expect(result.verdict).toBe("pass")
    expect(result.exitCode).toBe(0)
    expect(formatGate(result)).toMatch(/^WARNING {4}steps {16}audit-every-handler: median steps 16 -> 31/m)
    expect(formatGate(result)).toMatch(/gate: PASS {2}0 hard failure\(s\), 0 regression\(s\), 2 warning\(s\), 0 without enough data/)
  })

  test("a baseline file from before batches were recorded loads as one batch", async () => {
    const { batches: _batches, ...recorded } = await baselineOf(cheap())
    const old: Baseline = { ...recorded, tasks: Object.fromEntries(Object.entries(recorded.tasks).map(([task, { batches: _samples, ...stats }]) => [task, stats])) }
    const result = await judge(expensive(), old)
    expect(rules(result, "regression")).toEqual([])
    expect(rules(result, "warning")).toEqual([`input-tokens ${AUDIT}`, `steps ${AUDIT}`])
    expect(result.findings.find((finding) => finding.rule === "steps")!.message).toStartWith("median steps 16 -> 31 (over 1.5x and +2); the baseline has one batch")
    expect(result.exitCode).toBe(0)
  })

  test("a batch with too few runs of a task does not count: cost is then without data, never a pass", async () => {
    // Three baseline runs of each task, but as 2 + 1: no batch can stand for the task's cost.
    const result = await judge(repeats(TASKS, 3, { steps: { beta: 30 } }), await baselineOf(repeats(TASKS, 2), repeats(TASKS, 1)))
    expect(rules(result, "regression")).toEqual([])
    expect(rules(result, "no-data")).toEqual(["batches alpha", "batches beta", "batches delta", "batches gamma", "input-tokens overall"])
    expect(result.findings.find((finding) => finding.rule === "batches")!.message).toBe("no baseline batch has 3 runs of it (2, 1); tokens and steps need 2 such batches")
    expect(result.exitCode).toBe(3)
    // Two full batches and a thin one: the thin one is left out of the cost comparison, its runs still count for pass rate.
    const mixed = await judge(repeats(TASKS, 3, { steps: { beta: 30 } }), await baselineOf(repeats(TASKS, 3), repeats(TASKS, 3), repeats(TASKS, 1, { steps: { beta: 40 } })))
    expect(rules(mixed, "regression")).toEqual(["steps beta"])
    expect(mixed.findings.find((finding) => finding.rule === "steps")!.message).toContain("against batch medians of 5, 5 in the baseline")
  })

  test("a task that flips between 3/3 and 0/3 from batch to batch is judged against its pooled count", async () => {
    const FLIP = "answer-question"
    const all = (pass: boolean) => [...repeats(TASKS, 3), ...samples(FLIP, [{ steps: 4, input: 20_000, pass }, { steps: 4, input: 20_000, pass }, { steps: 4, input: 20_000, pass }])]
    const flaky = await baselineOf(all(true), all(false))
    expect(flaky.tasks[FLIP]).toMatchObject({ runs: 6, passes: 3, passRate: 0.5 })
    expect(passRateRegression(3, 6, 0, 3)).toBeNull()
    const again = await judge(all(false), flaky)
    expect(rules(again, "regression")).toEqual([])
    expect(again.exitCode).toBe(0)
    // Never failed in either batch, and now fails every run.
    const solid = await judge(all(false), await baselineOf(all(true), all(true)))
    // (Three failures in 15 runs against 30 clean baseline runs also moves the pooled rate.)
    expect(rules(solid, "regression")).toEqual([`pass-rate ${FLIP}`, "pass-rate overall"])
    expect(solid.findings.find((finding) => finding.level === "regression")!.message).toBe("passed 6/6 in the baseline (3/3, 3/3 by batch), 0/3 now (never failed in the baseline, now fails in a majority)")
  })
})

describe("the baseline", () => {
  test("pools runs by task across directories and keeps each directory as a batch, with the commit and date they recorded", async () => {
    const first = await resultsDir(repeats(TASKS, 2, { fails: { alpha: 1 }, steps: { beta: 3 } }), { startedAt: "2026-11-12T22:00:00.000Z" })
    const second = await resultsDir(repeats(TASKS, 1, { steps: { beta: 9 } }), { startedAt: "2026-11-12T09:00:00.000Z" })
    const baseline = buildBaseline(await loadResults([first, second]))
    const [one, two] = [first, second].map((dir) => dir.split("/").at(-1)!)
    expect(baseline.batches).toEqual([
      { source: one!, startedAt: "2026-11-12T22:00:00.000Z", runs: 8 },
      { source: two!, startedAt: "2026-11-12T09:00:00.000Z", runs: 4 },
    ])
    expect(baseline.tasks.beta!.batches).toEqual([
      { source: one!, runs: 2, passes: 2, steps: [3, 3], inputTokens: [9999, 9999], medianSteps: 3, medianInputTokens: 9999 },
      { source: two!, runs: 1, passes: 1, steps: [9], inputTokens: [9999], medianSteps: 9, medianInputTokens: 9999 },
    ])
    expect(baseline.tasks.alpha!.batches!.map((batch) => `${batch.passes}/${batch.runs}`)).toEqual(["1/2", "1/1"])
    expect(baseline.configuration).toEqual({ model: "gpt-test", effort: "low" })
    expect(baseline.commit).toBe("abc1234")
    expect(baseline.date).toBe("2026-11-12")
    expect(baseline.repeats).toBe(3)
    expect(baseline.sources).toEqual([first, second].map((dir) => dir.split("/").at(-1)!))
    expect(baseline.tasks.alpha).toMatchObject({ runs: 3, passes: 2 })
    expect(baseline.tasks.alpha!.passRate).toBeCloseTo(2 / 3)
    expect(baseline.tasks.beta!.medianSteps).toBe(3)
    expect(baseline.summary).toMatchObject({ runs: 12, passes: 11, medianWallMs: 20_000, cachedShare: 0 })
    expect(baseline.note).toBe("3 repeats per task over 2 batches.")
    expect(buildBaseline(await loadResults([await resultsDir(repeats(TASKS, 3))])).note).toBe("3 repeats per task in one batch: cost above it is a warning, not a regression, until a second batch recorded at another time is added.")
  })

  test("says when it is too thin, and refuses mixed configurations or an unknown commit", async () => {
    const thin = buildBaseline(await loadResults([await resultsDir(repeats(TASKS, 1))]))
    expect(thin.note).toContain("1-repeat baseline")
    await expect(async () => buildBaseline(await loadResults([await resultsDir(repeats(TASKS, 1)), await resultsDir(repeats(TASKS, 1), { effort: "high" })]))).toThrow("results mix configurations")
    await expect(async () => buildBaseline(await loadResults([await resultsDir(repeats(TASKS, 1), { sha: "a" }), await resultsDir(repeats(TASKS, 1), { sha: "b" })]))).toThrow("several commits")
    expect(buildBaseline(await loadResults([await resultsDir(repeats(TASKS, 1), { sha: "a" }), await resultsDir(repeats(TASKS, 1), { sha: "b" })]), { commit: "c" }).commit).toBe("c")
  })

  // The committed baseline is refreshed from real runs, so this checks what the gate needs from it
  // rather than one particular run: enough repeats for the statistical rules, and every task present.
  test("the committed baseline has enough repeats for the gate and covers every task", async () => {
    const committed = (await Bun.file(BASELINE_FILE).json()) as Baseline
    expect(committed.configuration).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(committed.repeats).toBeGreaterThanOrEqual(3)
    expect(committed.note).not.toStartWith("SINGLE-REPEAT SEED")
    expect(committed.commit).toMatch(/^[0-9a-f]{7,40}$/)
    const tasks = (await Array.fromAsync(new Bun.Glob("*/task.json").scan({ cwd: join(import.meta.dir, "tasks") }))).map((path) => path.split("/")[0]!)
    expect(Object.keys(committed.tasks).sort()).toEqual(tasks.sort())
  })
})

describe("the command", () => {
  const cli = (args: string[]) => {
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "gate.ts"), ...args], { stdout: "pipe", stderr: "pipe" })
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
  }

  test("prints one line per finding and exits with the verdict; --json is machine-readable", async () => {
    const baselineFile = join(scratch.dir, "cli-baseline.json")
    await Bun.write(baselineFile, JSON.stringify(await baselineOf(repeats(TASKS, 3))))
    const dir = await resultsDir(repeats(TASKS, 3, { fails: { gamma: 3 } }))
    const text = cli([dir, "--baseline", baselineFile])
    expect(text.code).toBe(1)
    expect(text.stdout).toMatch(/^REGRESSION pass-rate +gamma: passed 3\/3 in the baseline, 0\/3 now/m)
    expect(text.stdout).toContain("gate: FAIL")
    const json = cli([dir, "--baseline", baselineFile, "--json"])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout)).toMatchObject({ verdict: "fail", exitCode: 1 })
    expect(cli([dir, "--hard-only", "--baseline", baselineFile]).code).toBe(0)
    expect(cli([]).code).toBe(2)
  })

  test("the baseline command records one batch per directory and says when there is only one", async () => {
    const record = (args: string[]) => {
      const proc = Bun.spawnSync(["bun", join(import.meta.dir, "baseline.ts"), ...args], { stdout: "pipe", stderr: "pipe" })
      return { code: proc.exitCode, stdout: proc.stdout.toString() }
    }
    const evening = await resultsDir(repeats(TASKS, 3), { startedAt: "2026-11-12T21:00:00.000Z" })
    const morning = await resultsDir(repeats(TASKS, 3, { steps: { alpha: 9 } }), { startedAt: "2026-11-13T08:00:00.000Z" })
    const out = join(scratch.dir, "recorded-baseline.json")
    const two = record([evening, morning, "--out", out])
    expect(two.code).toBe(0)
    expect(two.stdout).toContain("4 tasks, 6 repeat(s) over 2 batch(es), commit abc1234")
    expect(two.stdout).toContain(`batch ${morning.split("/").at(-1)}: 12 run(s), started 2026-11-13T08:00:00.000Z`)
    expect(two.stdout).not.toContain("one batch")
    const written = (await Bun.file(out).json()) as Baseline
    expect(written.tasks.alpha!.batches!.map((batch) => batch.medianSteps)).toEqual([5, 9])
    expect(written.date).toBe("2026-11-12")
    const one = record([evening, "--out", out])
    expect(one.stdout).toContain("one batch: the gate reports cost above it as a warning, not a regression")
  })

  test("--update-baseline writes the new baseline, but never over a hard failure", async () => {
    const baselineFile = join(scratch.dir, "update-baseline.json")
    const good = await resultsDir(repeats(TASKS, 3), { sha: "def5678" })
    const updated = cli([good, "--baseline", baselineFile, "--update-baseline"])
    expect(updated.code).toBe(0)
    expect(((await Bun.file(baselineFile).json()) as Baseline).commit).toBe("def5678")

    const broken = await resultsDir([runOf("alpha", 1, { killed: true, wallMs: 400_000 })], { sha: "bad0000" })
    const refused = cli([broken, "--baseline", baselineFile, "--update-baseline"])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("not updating the baseline")
    expect(((await Bun.file(baselineFile).json()) as Baseline).commit).toBe("def5678")
  })
})
