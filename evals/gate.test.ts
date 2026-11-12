// The regression gate and the baseline generator, on crafted results directories. No agent runs here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Baseline, BASELINE_FILE, buildBaseline, loadResults } from "./baseline.ts"
import { skipped } from "./classify.ts"
import { RULES, fisherLower, formatGate, gate, passRateRegression } from "./gate.ts"
import { type Report, type RunResult, computeMetrics, totalsOf } from "./run-agent.ts"

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
async function resultsDir(results: RunResult[], config: { model?: string | null; effort?: string | null; sha?: string } = {}) {
  const out = join(scratch.dir, `results-${++dirs.count}`)
  const report: Report = {
    startedAt: "2026-11-12T10:00:00.000Z",
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
async function baselineOf(runs: RunResult[]) {
  return buildBaseline(await loadResults([await resultsDir(runs)]))
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
    const baseline = await baselineOf(repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3), baseline)
    expect(rules(result, "fail")).toEqual([])
    expect(rules(result, "regression")).toEqual([])
    expect(rules(result, "no-data")).toEqual([])
    expect(result.verdict).toBe("pass")
    expect(result.exitCode).toBe(0)
    expect(rules(result, "info")).toEqual(["wall-time overall", "cached-share overall"])
    expect(formatGate(result)).toMatch(/gate: PASS {2}0 hard failure\(s\), 0 regression\(s\), 0 without enough data, \d+ check\(s\) passed/)
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
    const baseline = await baselineOf(repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3, { input: { alpha: 16_000 }, steps: { beta: 9 } }), baseline)
    expect(rules(result, "regression")).toEqual(["input-tokens alpha", "steps beta"])
    expect(result.findings.find((finding) => finding.rule === "input-tokens")!.message).toBe("median input 10.0k -> 16.0k (over 1.5x and +5.0k)")
  })

  test("the absolute floors keep small tasks from flapping", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3, { input: { alpha: 4000 }, steps: { beta: 2 } }))
    const result = await judge(repeats(TASKS, 3, { input: { alpha: 8000 }, steps: { beta: 4 } }), baseline)
    expect(rules(result, "regression")).toEqual([])
  })

  test("a cost shift across every task is caught overall even when each task stays inside its band", async () => {
    const baseline = await baselineOf(repeats(TASKS, 3))
    const result = await judge(repeats(TASKS, 3, { input: { alpha: 13_000, beta: 13_000, gamma: 13_000, delta: 13_000 } }), baseline)
    expect(rules(result, "regression")).toEqual(["input-tokens overall"])
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

describe("the baseline", () => {
  test("pools runs by task across directories, with the commit and date they recorded", async () => {
    const first = await resultsDir(repeats(TASKS, 2, { fails: { alpha: 1 }, steps: { beta: 3 } }))
    const second = await resultsDir(repeats(TASKS, 1, { steps: { beta: 9 } }))
    const baseline = buildBaseline(await loadResults([first, second]))
    expect(baseline.configuration).toEqual({ model: "gpt-test", effort: "low" })
    expect(baseline.commit).toBe("abc1234")
    expect(baseline.date).toBe("2026-11-12")
    expect(baseline.repeats).toBe(3)
    expect(baseline.sources).toEqual([first, second].map((dir) => dir.split("/").at(-1)!))
    expect(baseline.tasks.alpha).toMatchObject({ runs: 3, passes: 2 })
    expect(baseline.tasks.alpha!.passRate).toBeCloseTo(2 / 3)
    expect(baseline.tasks.beta!.medianSteps).toBe(3)
    expect(baseline.summary).toMatchObject({ runs: 12, passes: 11, medianWallMs: 20_000, cachedShare: 0 })
    expect(baseline.note).toBe("3 repeats per task.")
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
