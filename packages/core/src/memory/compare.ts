/**
 * The A/B comparison that decides whether memory stays: the same tasks run with memory delivered and without,
 * compared on pass rate and cost, from results directories in the format `evals/run-agent.ts` writes.
 *
 *   bun packages/core/src/memory/compare.ts --with <results-dir> [...] --without <results-dir> [...] [--json]
 *
 * Exit codes: 0 memory shows a gain at no more than the allowed cost; 1 it does not (no gain, a loss, or a gain
 * that costs too much); 3 not enough data or not comparable, which is not a pass; 2 usage error.
 *
 * It reuses the gate's statistics and thresholds (`evals/gate.ts`, `evals/baseline.ts`) rather than new ones:
 * - a task is compared only with at least `RULES.minRepeats` runs on each side;
 * - the verdict needs at least `RULES.overallMinTasks` such tasks; below that it is "not enough data";
 * - pass rate: the one-sided Fisher exact test on the pooled pass counts, in each direction, at `RULES.alpha`;
 * - cost: the median over tasks of the per-task ratio of median input tokens (and of median steps), with memory
 *   over without; over `RULES.overallTokenRatio` is a cost the gate would call a regression.
 * Both sides must have one configuration (model and effort), the same on both.
 *
 * What it cannot check: that the "with" runs were seeded with notes relevant to the tasks, and that the tasks are
 * ones memory could help with. A task that passes every run without memory cannot show a gain at any sample size;
 * `minPassesForGain` says what the "with" side would have needed.
 */
import { type Results, type TaskStats, byTask, configurationOf, loadResults, median, statsOf } from "../../../../evals/baseline.ts"
import { RULES, fisherLower } from "../../../../evals/gate.ts"

export type Verdict = "gain" | "gain-at-cost" | "no-gain" | "worse" | "not-enough-data" | "not-comparable"

export interface TaskComparison {
  readonly task: string
  readonly with: TaskStats | null
  readonly without: TaskStats | null
  /** Both sides have at least `RULES.minRepeats` runs. */
  readonly compared: boolean
}

export interface Comparison {
  readonly verdict: Verdict
  readonly reasons: readonly string[]
  readonly tasks: readonly TaskComparison[]
  /** Over compared tasks only; `null` when none. */
  readonly pooled: {
    readonly with: { readonly passes: number; readonly runs: number }
    readonly without: { readonly passes: number; readonly runs: number }
    /** Probability of a gap this large in favour of memory if memory made no difference. */
    readonly pGain: number
    /** The same, against memory. */
    readonly pLoss: number
    /** The fewest passes the "with" side needed for a significant gain at these sample sizes; `null` when even all would not do. */
    readonly minPassesForGain: number | null
  } | null
  /** Median over compared tasks of with/without median input tokens; `null` with fewer than `RULES.overallMinTasks`. */
  readonly tokenRatio: number | null
  readonly stepRatio: number | null
  /** What a verdict needs, for the reader. */
  readonly requirement: string
}

export function compareMemory(withMemory: readonly Results[], withoutMemory: readonly Results[]): Comparison {
  const requirement = `at least ${RULES.minRepeats} runs of a task on each side, and at least ${RULES.overallMinTasks} such tasks; one model and effort on both sides`
  const left = configurationOf(withMemory)
  const right = configurationOf(withoutMemory)
  const label = (config: { model: string | null; effort: string | null }) => `${config.model ?? "default model"}/${config.effort ?? "default effort"}`
  const empty = { tasks: [], pooled: null, tokenRatio: null, stepRatio: null, requirement }
  if (typeof left === "string") return { verdict: "not-comparable", reasons: [`with memory: ${left}`], ...empty }
  if (typeof right === "string") return { verdict: "not-comparable", reasons: [`without memory: ${right}`], ...empty }
  if (left.model !== right.model || left.effort !== right.effort)
    return { verdict: "not-comparable", reasons: [`with memory ran ${label(left)}, without ran ${label(right)}`], ...empty }

  const a = byTask(withMemory)
  const b = byTask(withoutMemory)
  const tasks = [...new Set([...a.keys(), ...b.keys()])].sort().map((task): TaskComparison => {
    const runsWith = a.get(task)
    const runsWithout = b.get(task)
    return {
      task,
      with: runsWith === undefined ? null : statsOf(runsWith),
      without: runsWithout === undefined ? null : statsOf(runsWithout),
      compared: (runsWith?.length ?? 0) >= RULES.minRepeats && (runsWithout?.length ?? 0) >= RULES.minRepeats,
    }
  })
  const compared = tasks.filter((task) => task.compared)
  const reasons: string[] = []
  for (const task of tasks.filter((entry) => !entry.compared))
    reasons.push(`${task.task}: ${task.with?.runs ?? 0} run(s) with memory, ${task.without?.runs ?? 0} without; needs ${RULES.minRepeats} on each side`)
  if (compared.length === 0) return { verdict: "not-enough-data", reasons: [...reasons, "no task has enough runs on both sides"], tasks, pooled: null, tokenRatio: null, stepRatio: null, requirement }

  const sum = (pick: (task: TaskComparison) => TaskStats) =>
    compared.reduce((total, task) => ({ passes: total.passes + pick(task).passes, runs: total.runs + pick(task).runs }), { passes: 0, runs: 0 })
  const withSide = sum((task) => task.with!)
  const withoutSide = sum((task) => task.without!)
  const pGain = fisherLower(withSide.passes, withSide.runs, withoutSide.passes, withoutSide.runs)
  const pLoss = fisherLower(withoutSide.passes, withoutSide.runs, withSide.passes, withSide.runs)
  let minPassesForGain: number | null = null
  for (let passes = 0; passes <= withSide.runs; passes += 1)
    if (fisherLower(passes, withSide.runs, withoutSide.passes, withoutSide.runs) < RULES.alpha) {
      minPassesForGain = passes
      break
    }
  const pooled = { with: withSide, without: withoutSide, pGain, pLoss, minPassesForGain }
  if (compared.length < RULES.overallMinTasks)
    return { verdict: "not-enough-data", reasons: [...reasons, `${compared.length} task(s) with enough runs; a verdict needs ${RULES.overallMinTasks}`], tasks, pooled, tokenRatio: null, stepRatio: null, requirement }

  const ratio = (pick: (stats: TaskStats) => number) => {
    const values = compared.filter((task) => pick(task.without!) > 0).map((task) => pick(task.with!) / pick(task.without!))
    return values.length === 0 ? null : median(values)
  }
  const tokenRatio = ratio((stats) => stats.medianInputTokens)
  const stepRatio = ratio((stats) => stats.medianSteps)
  const costly = tokenRatio !== null && tokenRatio > RULES.overallTokenRatio
  const rates = `${percent(withSide.passes, withSide.runs)} with memory, ${percent(withoutSide.passes, withoutSide.runs)} without, over ${compared.length} tasks`
  const cost = tokenRatio === null ? "input tokens not recorded" : `median input-token ratio ${tokenRatio.toFixed(2)} (limit ${RULES.overallTokenRatio})`
  if (pLoss < RULES.alpha) return { verdict: "worse", reasons: [...reasons, `pass rate is lower with memory: ${rates} (Fisher one-sided p=${pLoss.toFixed(3)})`, cost], tasks, pooled, tokenRatio, stepRatio, requirement }
  if (pGain < RULES.alpha)
    return { verdict: costly ? "gain-at-cost" : "gain", reasons: [...reasons, `pass rate is higher with memory: ${rates} (Fisher one-sided p=${pGain.toFixed(3)})`, cost], tasks, pooled, tokenRatio, stepRatio, requirement }
  const power =
    minPassesForGain === null
      ? `at these sample sizes no result could show a gain: the side without memory passes ${withoutSide.passes}/${withoutSide.runs}; use tasks it fails, or more repeats`
      : `a gain at these sample sizes needed at least ${minPassesForGain}/${withSide.runs} passes with memory`
  return { verdict: costly ? "worse" : "no-gain", reasons: [...reasons, `no significant difference: ${rates} (p=${pGain.toFixed(3)})`, power, cost], tasks, pooled, tokenRatio, stepRatio, requirement }
}

export function formatComparison(comparison: Comparison): string {
  const row = (stats: TaskStats | null) => (stats === null ? "-".padEnd(26) : `${stats.passes}/${stats.runs} pass, ${tokens(stats.medianInputTokens)} in, ${stats.medianSteps} steps`.padEnd(26))
  const lines = [
    "task                        with memory                 without memory",
    ...comparison.tasks.map((task) => `${task.task.padEnd(27)} ${row(task.with)}  ${row(task.without)}${task.compared ? "" : "  (not enough runs)"}`),
    "",
    ...comparison.reasons.map((reason) => `- ${reason}`),
    "",
    `memory A/B: ${VERDICTS[comparison.verdict]}`,
    `(needs ${comparison.requirement})`,
  ]
  return lines.join("\n")
}

const VERDICTS: Record<Verdict, string> = {
  gain: "GAIN: memory raised the pass rate at no more than the allowed cost",
  "gain-at-cost": "GAIN AT A COST: higher pass rate, but input tokens rose more than the gate allows",
  "no-gain": "NO GAIN: no significant difference in pass rate; memory has not earned its place",
  worse: "WORSE: memory lowered the pass rate, or cost more without a gain",
  "not-enough-data": "NOT ENOUGH DATA: no verdict",
  "not-comparable": "NOT COMPARABLE: the two sides ran different configurations",
}

export function exitCode(verdict: Verdict): 0 | 1 | 3 {
  if (verdict === "gain") return 0
  if (verdict === "not-enough-data" || verdict === "not-comparable") return 3
  return 1
}

function percent(passes: number, runs: number) {
  return runs === 0 ? "-" : `${Math.round((passes / runs) * 100)}% (${passes}/${runs})`
}

function tokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(Math.round(count))
}

const USAGE = "usage: bun packages/core/src/memory/compare.ts --with <results-dir> [...] --without <results-dir> [...] [--json]"

if (import.meta.main) {
  const sides: Record<"with" | "without", string[]> = { with: [], without: [] }
  let side: "with" | "without" | null = null
  let json = false
  for (const arg of process.argv.slice(2)) {
    if (arg === "--with" || arg === "--without") side = arg === "--with" ? "with" : "without"
    else if (arg === "--json") json = true
    else if (arg.startsWith("-") || side === null) {
      console.error(USAGE)
      process.exit(2)
    } else sides[side].push(arg)
  }
  if (sides.with.length === 0 || sides.without.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }
  const comparison = compareMemory(await loadResults(sides.with), await loadResults(sides.without))
  console.log(json ? JSON.stringify(comparison, null, 2) : formatComparison(comparison))
  process.exit(exitCode(comparison.verdict))
}
