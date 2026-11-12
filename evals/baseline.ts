/**
 * The baseline the gate compares against: for one configuration (model, effort), each task's pass rate over its
 * repeats and its cost-like numbers, taken from one or more results directories of `run-agent.ts`.
 *
 *   bun evals/baseline.ts <results-dir> [<results-dir> ...] [--out evals/baseline.json] [--commit <sha>] [--note <text>]
 *
 * Each directory is one batch: the runs of one sitting. The model's cost on a task varies between sittings (time of
 * day) by more than it varies inside one, so a baseline that is to gate cost needs at least two batches recorded at
 * different times: the gate judges cost against what the batches themselves showed (`RULES` in gate.ts). Per task the
 * baseline keeps every batch's samples (steps and input tokens per run) and its medians, next to the numbers pooled
 * over all batches, which the pass-rate rules use. All directories must share one configuration. The commit is the
 * one the runs recorded; results from before the runner recorded it, or from several commits, need `--commit`.
 */
import { join, resolve } from "node:path"
import type { Report, RunResult } from "./run-agent.ts"

export const BASELINE_FILE = join(import.meta.dir, "baseline.json")

export interface TaskStats {
  readonly runs: number
  readonly passes: number
  readonly passRate: number
  readonly medianSteps: number
  readonly medianWallMs: number
  readonly medianInputTokens: number
  /** cached / input over all its runs; `null` without input. */
  readonly cachedShare: number | null
}

/** One batch's runs of one task: one results directory, so one sitting. */
export interface BatchStats {
  /** The directory's name, as in `Baseline.batches`. */
  readonly source: string
  readonly runs: number
  readonly passes: number
  /** One value per run, ascending: the samples the gate's cost rules compare with. */
  readonly steps: readonly number[]
  readonly inputTokens: readonly number[]
  readonly medianSteps: number
  readonly medianInputTokens: number
}

/** A task in the baseline: its numbers pooled over every batch, and each batch on its own. */
export interface TaskBaseline extends TaskStats {
  /** Absent in a file written before batches were recorded; the gate reads such a task as one batch without samples. */
  readonly batches?: readonly BatchStats[]
}

export interface Baseline {
  readonly note: string
  readonly configuration: { readonly model: string | null; readonly effort: string | null }
  /** YYYY-MM-DD of the earliest run. */
  readonly date: string
  readonly commit: string | null
  /** The fewest runs any task has: what the statistical comparisons can lean on. */
  readonly repeats: number
  readonly sources: readonly string[]
  /** One entry per results directory, in `sources` order, with when its runs started. Absent in older files. */
  readonly batches?: readonly { readonly source: string; readonly startedAt: string; readonly runs: number }[]
  readonly summary: TaskStats
  readonly tasks: Readonly<Record<string, TaskBaseline>>
}

/** A results directory, read back. Older files lack fields added since; the gate treats those as unknown. */
export interface Results {
  readonly dir: string
  readonly report: Report
}

export async function loadResults(dirs: readonly string[]): Promise<Results[]> {
  return Promise.all(
    dirs.map(async (dir) => {
      const file = Bun.file(join(resolve(dir), "results.json"))
      if (!(await file.exists())) throw new Error(`no results.json in ${dir}`)
      return { dir: resolve(dir), report: (await file.json()) as Report }
    }),
  )
}

/** The one configuration all results share, or an error naming the mismatch. */
export function configurationOf(results: readonly Results[]): Baseline["configuration"] | string {
  const configs = [...new Set(results.map((entry) => JSON.stringify({ model: entry.report.model ?? null, effort: entry.report.effort ?? null })))]
  if (configs.length !== 1) return `results mix configurations: ${configs.join(", ")}`
  return JSON.parse(configs[0]!) as Baseline["configuration"]
}

export function statsOf(runs: readonly RunResult[]): TaskStats {
  const passes = runs.filter((run) => run.pass).length
  const input = runs.reduce((total, run) => total + run.metrics.tokens.input, 0)
  const cached = runs.reduce((total, run) => total + run.metrics.tokens.cached, 0)
  return {
    runs: runs.length,
    passes,
    passRate: runs.length === 0 ? 0 : passes / runs.length,
    medianSteps: median(runs.map((run) => run.metrics.steps)),
    medianWallMs: median(runs.map((run) => run.wallMs)),
    medianInputTokens: median(runs.map((run) => run.metrics.tokens.input)),
    cachedShare: input === 0 ? null : cached / input,
  }
}

/** Runs grouped by task, in task order. */
export function byTask(results: readonly Results[]): Map<string, RunResult[]> {
  const groups = new Map<string, RunResult[]>()
  for (const run of results.flatMap((entry) => entry.report.results).toSorted((a, b) => a.task.localeCompare(b.task)))
    groups.set(run.task, [...(groups.get(run.task) ?? []), run])
  return groups
}

export function buildBaseline(results: readonly Results[], options: { readonly commit?: string | null; readonly note?: string } = {}): Baseline {
  const configuration = configurationOf(results)
  if (typeof configuration === "string") throw new Error(configuration)
  const groups = byTask(results)
  const commits = [...new Set(results.map((entry) => entry.report.commit?.sha ?? null))]
  const recorded = commits.length === 1 ? commits[0]! : null
  const commit = options.commit ?? recorded
  if (commit === null) throw new Error(commits.length > 1 ? `results come from several commits (${commits.join(", ")}); pass --commit` : "the results do not record a commit; pass --commit <sha>")
  const repeats = Math.min(...[...groups.values()].map((runs) => runs.length))
  const date = results.map((entry) => entry.report.startedAt).toSorted()[0]!.slice(0, 10)
  const sources = results.map((entry) => entry.dir.split("/").at(-1)!)
  const ascending = (values: readonly number[]) => values.toSorted((a, b) => a - b)
  const batchesOf = (task: string): BatchStats[] =>
    results.flatMap((entry, index) => {
      const runs = entry.report.results.filter((run) => run.task === task)
      if (runs.length === 0) return []
      const stats = statsOf(runs)
      return [
        {
          source: sources[index]!,
          runs: stats.runs,
          passes: stats.passes,
          steps: ascending(runs.map((run) => run.metrics.steps)),
          inputTokens: ascending(runs.map((run) => run.metrics.tokens.input)),
          medianSteps: stats.medianSteps,
          medianInputTokens: stats.medianInputTokens,
        },
      ]
    })
  return {
    note:
      options.note ??
      (repeats < 3
        ? `${repeats}-repeat baseline: too few runs per task for the statistical comparisons, which report "not enough data" until it is regenerated from at least 3 repeats.`
        : results.length === 1
          ? `${repeats} repeats per task in one batch: cost above it is a warning, not a regression, until a second batch recorded at another time is added.`
          : `${repeats} repeats per task over ${results.length} batches.`),
    configuration,
    date,
    commit,
    repeats,
    sources,
    batches: results.map((entry, index) => ({ source: sources[index]!, startedAt: entry.report.startedAt, runs: entry.report.results.length })),
    summary: statsOf(results.flatMap((entry) => entry.report.results)),
    tasks: Object.fromEntries([...groups].map(([task, runs]) => [task, { ...statsOf(runs), batches: batchesOf(task) }])),
  }
}

export async function writeBaseline(baseline: Baseline, file = BASELINE_FILE) {
  await Bun.write(file, `${JSON.stringify(baseline, null, 2)}\n`)
}

export function median(values: readonly number[]) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const USAGE = "usage: bun evals/baseline.ts <results-dir> [<results-dir> ...] [--out <file>] [--commit <sha>] [--note <text>]"

if (import.meta.main) {
  const args = process.argv.slice(2)
  const values = new Map<string, string>()
  const dirs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (["--out", "--commit", "--note"].includes(arg) && args[index + 1] !== undefined) {
      values.set(arg, args[++index]!)
      continue
    }
    if (arg.startsWith("-")) {
      console.error(`unknown option ${arg}\n${USAGE}`)
      process.exit(2)
    }
    dirs.push(arg)
  }
  if (dirs.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }
  const baseline = buildBaseline(await loadResults(dirs), {
    ...(values.has("--commit") ? { commit: values.get("--commit")! } : {}),
    ...(values.has("--note") ? { note: values.get("--note")! } : {}),
  })
  const out = resolve(values.get("--out") ?? BASELINE_FILE)
  await writeBaseline(baseline, out)
  const batches = baseline.batches ?? []
  console.log(`baseline for ${baseline.configuration.model ?? "(default model)"} / ${baseline.configuration.effort ?? "(default effort)"}: ${Object.keys(baseline.tasks).length} tasks, ${baseline.repeats} repeat(s) over ${batches.length} batch(es), commit ${baseline.commit} -> ${out}`)
  for (const batch of batches) console.log(`  batch ${batch.source}: ${batch.runs} run(s), started ${batch.startedAt}`)
  if (batches.length < 2) console.log("  one batch: the gate reports cost above it as a warning, not a regression; add a second directory recorded at another time of day")
}
