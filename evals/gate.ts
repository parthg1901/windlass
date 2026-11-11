/**
 * The regression gate: compares one or more results directories of `run-agent.ts` with `baseline.json` and prints
 * one line per finding.
 *
 *   bun evals/gate.ts <results-dir> [<results-dir> ...] [--baseline <file>] [--json] [--hard-only] [--update-baseline]
 *
 * Exit codes: 0 no regression and every check had the data it needs; 1 a hard failure or a regression; 3
 * inconclusive (nothing failed, but a statistical comparison lacked repeats or a run's cache misses were not
 * classified: that is not a pass); 2 usage error.
 *
 * Three kinds of rule (the thresholds and why they are what they are are in RULES below):
 * - hard: harness bugs, judged on every run regardless of the baseline. One run is enough to fail.
 * - statistical: pass rate and cost against the baseline, only with at least MIN_REPEATS runs of a task on each
 *   side, and only when the configuration (model, effort) matches. Otherwise "not enough data", never a pass.
 * - report-only: wall time and cached share, printed for the reader, never failing.
 */
import { BASELINE_FILE, type Baseline, type Results, buildBaseline, byTask, configurationOf, loadResults, median, statsOf, writeBaseline } from "./baseline.ts"
import type { RunResult } from "./run-agent.ts"
import { loadTask } from "./run-check.ts"

export const RULES = {
  /**
   * Fewest runs of a task on each side before its pass rate or cost is compared. With 3, a task that passed every
   * baseline run and now fails 2 of 3 is flagged; below 3 a single unlucky run would decide the verdict.
   */
  minRepeats: 3,
  /**
   * Significance for the one-sided Fisher exact test on pass counts (baseline vs new), used for tasks that already
   * failed sometimes in the baseline and for the pooled overall rate. Fisher is exact at small n and conservative,
   * so a false alarm needs a large drop: at 5 repeats 4/5 -> 1/5 is p=0.10 (not flagged), at 10 repeats 9/10 ->
   * 4/10 is p=0.03 (flagged). A flaky task needs more repeats to judge; that is the honest answer at this size.
   */
  alpha: 0.05,
  /**
   * A task that passed every baseline run (at least minRepeats) and fails in a strict majority of new runs is a
   * regression. If its true pass rate were still 0.9, failing 2 of 3 has probability 2.8% and 3 of 5 0.86%; a task
   * that was solid does not lose a majority to noise.
   */
  perfectMajority: true,
  /**
   * Cost per task (median input tokens, median steps): a regression only when the new median exceeds the baseline
   * median by the ratio AND by the absolute floor. Medians of >= 3 runs ignore a single long run; the ratio of 1.5
   * is beyond the step spread of these short tasks (4-9 steps), and the floors keep tiny tasks (4 -> 6 steps,
   * 8k -> 12k tokens) from flapping on one extra tool call.
   */
  tokenRatio: 1.5,
  tokenFloor: 5000,
  stepRatio: 1.5,
  stepFloor: 2,
  /**
   * Across all tasks with enough data (at least 3 of them), the median of the per-task input-token ratios. Noise
   * pushes tasks both ways and cancels in the median; a shift of 25% in the middle task is a systematic change (a
   * longer system prompt, a tool output no longer truncated).
   */
  overallTokenRatio: 1.25,
  overallMinTasks: 3,
  /** A run longer than this multiple of its time limit went far past Ctrl-C: the stop path is broken. */
  overrunFactor: 1.5,
} as const

export type Level = "fail" | "regression" | "no-data" | "unchecked" | "info"

export interface Finding {
  readonly level: Level
  readonly rule: string
  /** `task#attempt`, a task id, or `overall`. */
  readonly scope: string
  readonly message: string
}

export interface GateResult {
  readonly verdict: "pass" | "fail" | "inconclusive"
  readonly exitCode: 0 | 1 | 3
  readonly findings: readonly Finding[]
  /** How many comparisons ran and passed, for the summary line. */
  readonly passedChecks: number
}

export async function gate(results: readonly Results[], baseline: Baseline | null, options: { readonly hardOnly?: boolean } = {}): Promise<GateResult> {
  const runs = results.flatMap((entry) => entry.report.results)
  const hard = await hardFindings(runs)
  const statistical = options.hardOnly ? { findings: [], passed: 0 } : statisticalFindings(results, baseline)
  const findings = [...hard.findings, ...statistical.findings, ...(options.hardOnly ? [] : reportOnly(results, baseline))]
  const failed = findings.some((finding) => finding.level === "fail" || finding.level === "regression")
  const inconclusive = findings.some((finding) => finding.level === "no-data" || finding.level === "unchecked")
  return {
    verdict: failed ? "fail" : inconclusive ? "inconclusive" : "pass",
    exitCode: failed ? 1 : inconclusive ? 3 : 0,
    findings,
    passedChecks: hard.passed + statistical.passed,
  }
}

/** Harness bugs. Each is judged per run; none depends on the model having done well. */
async function hardFindings(runs: readonly RunResult[]) {
  const findings: Finding[] = []
  const fail = (rule: string, run: RunResult, message: string) => findings.push({ level: "fail", rule, scope: `${run.task}#${run.attempt}`, message })
  const unclassified: string[] = []
  let passed = 0
  for (const run of runs) {
    const before = findings.length
    const anomalies = run.metrics.anomalies
    const interrupted = run.metrics.end === "interrupted" || run.timedOut
    if (run.status === "error") fail("setup-failed", run, run.reason)
    else {
      const cache = run.cache
      if (cache === undefined || cache.status === "skipped") unclassified.push(`${run.task}#${run.attempt}${cache?.reason ? ` (${cache.reason})` : ""}`)
      else if (cache.status === "error") fail("classification-error", run, `could not classify cache misses: ${cache.reason}`)
      else {
        for (const cause of cache.avoidableCauses) fail("avoidable-miss", run, `avoidable cache miss, ${cause}`)
        for (const record of cache.unfaithful) fail("usage-only-record", run, `trace call ${record.turn} exported usage-only (${record.reason}): the rebuilt request is not what was sent`)
      }
      for (const anomaly of anomalies.filter((item) => item.kind === "no-execution-end")) fail("no-execution-end", run, anomaly.detail)
      if (!interrupted)
        for (const anomaly of anomalies.filter((item) => item.kind === "effect-unknown" || item.kind === "not-started" || item.kind === "unsettled-tool"))
          fail(anomaly.kind, run, `${anomaly.detail} in a run that was not interrupted`)
      if (run.metrics.malformed > 0)
        fail("malformed-event", run, `${run.metrics.malformed} malformed line(s); first: ${anomalies.find((item) => item.kind === "malformed-event")?.detail ?? "?"}`)
      const limit = run.timeoutSeconds ?? (await loadTask(run.task).then((task) => task.timeoutSeconds, () => null))
      if (run.killed) fail("time-limit", run, `ignored Ctrl-C at the ${limit ?? "?"} s limit for the whole grace period and was killed after ${seconds(run.wallMs)}`)
      else if (limit !== null && run.wallMs > limit * 1000 * RULES.overrunFactor)
        fail("time-limit", run, `ran ${seconds(run.wallMs)}, more than ${RULES.overrunFactor}x its ${limit} s limit`)
    }
    if (findings.length === before) passed += 1
  }
  if (unclassified.length > 0)
    findings.push({ level: "unchecked", rule: "cache-classification", scope: "overall", message: `${unclassified.length} of ${runs.length} runs not classified, so avoidable misses and export fidelity are unchecked: ${unclassified.slice(0, 3).join(", ")}${unclassified.length > 3 ? ", ..." : ""}` })
  return { findings, passed }
}

/** Pass rate and cost against the baseline. */
function statisticalFindings(results: readonly Results[], baseline: Baseline | null) {
  const findings: Finding[] = []
  let passed = 0
  if (baseline === null) return { findings: [{ level: "no-data" as const, rule: "baseline", scope: "overall", message: "no baseline to compare with" }], passed }
  const configuration = configurationOf(results)
  const label = (config: Baseline["configuration"]) => `${config.model ?? "default model"}/${config.effort ?? "default effort"}`
  if (typeof configuration === "string") return { findings: [{ level: "no-data" as const, rule: "configuration", scope: "overall", message: configuration }], passed }
  if (configuration.model !== baseline.configuration.model || configuration.effort !== baseline.configuration.effort)
    return { findings: [{ level: "no-data" as const, rule: "configuration", scope: "overall", message: `results are for ${label(configuration)}, the baseline for ${label(baseline.configuration)}: not comparable` }], passed }

  const groups = byTask(results)
  const compared: { task: string; base: Baseline["tasks"][string]; next: ReturnType<typeof statsOf> }[] = []
  for (const [task, runs] of groups) {
    const base = baseline.tasks[task]
    if (base === undefined) {
      findings.push({ level: "info", rule: "new-task", scope: task, message: `not in the baseline (${runs.length} run(s), ${runs.filter((run) => run.pass).length} passed)` })
      continue
    }
    if (base.runs < RULES.minRepeats || runs.length < RULES.minRepeats) {
      findings.push({ level: "no-data", rule: "repeats", scope: task, message: `baseline ${base.runs} run(s), new ${runs.length}; pass rate, tokens and steps need ${RULES.minRepeats} on each side` })
      continue
    }
    compared.push({ task, base, next: statsOf(runs) })
  }
  for (const task of Object.keys(baseline.tasks).filter((id) => !groups.has(id)))
    findings.push({ level: "info", rule: "missing-task", scope: task, message: "in the baseline but not in these results" })

  for (const { task, base, next } of compared) {
    const drop = passRateRegression(base.passes, base.runs, next.passes, next.runs)
    if (drop) findings.push({ level: "regression", rule: "pass-rate", scope: task, message: `passed ${base.passes}/${base.runs} in the baseline, ${next.passes}/${next.runs} now (${drop})` })
    else passed += 1
    if (next.medianInputTokens > base.medianInputTokens * RULES.tokenRatio && next.medianInputTokens - base.medianInputTokens > RULES.tokenFloor)
      findings.push({ level: "regression", rule: "input-tokens", scope: task, message: `median input ${count(base.medianInputTokens)} -> ${count(next.medianInputTokens)} (over ${RULES.tokenRatio}x and +${count(RULES.tokenFloor)})` })
    else passed += 1
    if (next.medianSteps > base.medianSteps * RULES.stepRatio && next.medianSteps - base.medianSteps > RULES.stepFloor)
      findings.push({ level: "regression", rule: "steps", scope: task, message: `median steps ${base.medianSteps} -> ${next.medianSteps} (over ${RULES.stepRatio}x and +${RULES.stepFloor})` })
    else passed += 1
  }

  if (compared.length === 0) findings.push({ level: "no-data", rule: "pass-rate", scope: "overall", message: `no task has ${RULES.minRepeats} runs on both sides` })
  else {
    const base = compared.reduce((sum, entry) => ({ passes: sum.passes + entry.base.passes, runs: sum.runs + entry.base.runs }), { passes: 0, runs: 0 })
    const next = compared.reduce((sum, entry) => ({ passes: sum.passes + entry.next.passes, runs: sum.runs + entry.next.runs }), { passes: 0, runs: 0 })
    const p = fisherLower(base.passes, base.runs, next.passes, next.runs)
    if (p < RULES.alpha)
      findings.push({ level: "regression", rule: "pass-rate", scope: "overall", message: `${percent(base.passes / base.runs)} -> ${percent(next.passes / next.runs)} over ${compared.length} task(s) (Fisher one-sided p=${p.toFixed(3)})` })
    else passed += 1
  }
  if (compared.length < RULES.overallMinTasks)
    findings.push({ level: "no-data", rule: "input-tokens", scope: "overall", message: `${compared.length} task(s) with enough data; the overall cost check needs ${RULES.overallMinTasks}` })
  else {
    const ratio = median(compared.filter((entry) => entry.base.medianInputTokens > 0).map((entry) => entry.next.medianInputTokens / entry.base.medianInputTokens))
    if (ratio > RULES.overallTokenRatio)
      findings.push({ level: "regression", rule: "input-tokens", scope: "overall", message: `median per-task input-token ratio ${ratio.toFixed(2)} (over ${RULES.overallTokenRatio})` })
    else passed += 1
  }
  return { findings, passed }
}

/** Why the new pass count is a regression from the baseline's, or `null`. */
export function passRateRegression(basePasses: number, baseRuns: number, newPasses: number, newRuns: number): string | null {
  const newFails = newRuns - newPasses
  if (RULES.perfectMajority && basePasses === baseRuns && newFails * 2 > newRuns) return "never failed in the baseline, now fails in a majority"
  const p = fisherLower(basePasses, baseRuns, newPasses, newRuns)
  return p < RULES.alpha ? `Fisher one-sided p=${p.toFixed(3)}` : null
}

/**
 * One-sided Fisher exact test: the probability, with both samples drawn from one pass rate, that the new sample has
 * at most `newPasses` of the combined passes. Small means the new pass rate is lower than chance allows.
 */
export function fisherLower(basePasses: number, baseRuns: number, newPasses: number, newRuns: number) {
  const total = baseRuns + newRuns
  const passes = basePasses + newPasses
  const all = choose(total, newRuns)
  let p = 0
  for (let x = Math.max(0, newRuns - (total - passes)); x <= newPasses; x += 1) p += (choose(passes, x) * choose(total - passes, newRuns - x)) / all
  return Math.min(1, p)
}

function choose(n: number, k: number) {
  if (k < 0 || k > n) return 0
  let value = 1
  for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i
  return value
}

/** Wall time and cached share: printed, never failing. Wall time depends on the provider's load; cached share on its cache. */
function reportOnly(results: readonly Results[], baseline: Baseline | null): Finding[] {
  const next = statsOf(results.flatMap((entry) => entry.report.results))
  const base = baseline?.summary
  return [
    { level: "info", rule: "wall-time", scope: "overall", message: `median wall ${seconds(next.medianWallMs)}${base ? ` (baseline ${seconds(base.medianWallMs)})` : ""}` },
    { level: "info", rule: "cached-share", scope: "overall", message: `cached share ${percent(next.cachedShare)}${base ? ` (baseline ${percent(base.cachedShare)})` : ""}` },
  ]
}

export function formatGate(result: GateResult): string {
  const order: Level[] = ["fail", "regression", "unchecked", "no-data", "info"]
  const lines = result.findings.toSorted((a, b) => order.indexOf(a.level) - order.indexOf(b.level)).map((finding) => `${finding.level.toUpperCase().padEnd(10)} ${finding.rule.padEnd(20)} ${finding.scope}: ${finding.message}`)
  const tally = (level: Level) => result.findings.filter((finding) => finding.level === level).length
  return [
    ...lines,
    "",
    `gate: ${result.verdict.toUpperCase()}  ${tally("fail")} hard failure(s), ${tally("regression")} regression(s), ${tally("no-data") + tally("unchecked")} without enough data, ${result.passedChecks} check(s) passed`,
  ].join("\n")
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`
}

function count(tokens: number) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens))
}

function percent(share: number | null) {
  return share === null ? "-" : `${Math.round(share * 100)}%`
}

const USAGE = "usage: bun evals/gate.ts <results-dir> [<results-dir> ...] [--baseline <file>] [--json] [--hard-only] [--update-baseline]"

if (import.meta.main) {
  const args = process.argv.slice(2)
  const dirs: string[] = []
  const flags = new Set<string>()
  let baselineFile = BASELINE_FILE
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--baseline" && args[index + 1] !== undefined) baselineFile = args[++index]!
    else if (["--json", "--hard-only", "--update-baseline"].includes(arg)) flags.add(arg)
    else if (arg.startsWith("-")) {
      console.error(`unknown option ${arg}\n${USAGE}`)
      process.exit(2)
    } else dirs.push(arg)
  }
  if (dirs.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }
  const results = await loadResults(dirs)
  const file = Bun.file(baselineFile)
  const baseline = (await file.exists()) ? ((await file.json()) as Baseline) : null
  const result = await gate(results, baseline, { hardOnly: flags.has("--hard-only") })
  if (flags.has("--json")) console.log(JSON.stringify(result, null, 2))
  else console.log(formatGate(result))
  if (flags.has("--update-baseline")) {
    // A baseline must never encode a harness bug; regressions in pass rate or cost are accepted on purpose.
    if (result.findings.some((finding) => finding.level === "fail")) {
      console.error("not updating the baseline: fix the hard failures first")
      process.exit(1)
    }
    const next = buildBaseline(results)
    await writeBaseline(next, baselineFile)
    console.error(`baseline updated: ${Object.keys(next.tasks).length} tasks, ${next.repeats} repeat(s), commit ${next.commit} -> ${baselineFile}`)
    process.exit(0)
  }
  process.exit(result.exitCode)
}
