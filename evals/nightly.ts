/**
 * The nightly run: what a scheduled job does, and what a person can run by hand.
 *
 *   bun evals/nightly.ts [--root <dir>] [--dry-run] [--tasks a,b] [--repeat N] [--model <slug>] [--effort <level>]
 *                        [--baseline <file>] [--recall-strategies engine] [--recall-history <file>] [--recall-margin N]
 *                        [--concurrency N] [--timeout <s>] [--allow-dirty]
 *
 * In order: record the commit; run the task suite on the real model with the repeat count the gate needs
 * (`RULES.minRepeats`), each run's cache misses classified as `run-agent.ts` does (`classify.ts`); run the gate
 * against `baseline.json`; run the recall tracker (`recall/track.ts`) and its `--check`; write one dated directory
 * under the root, outside the repository, holding the raw results, `summary.json` and `summary.md`.
 *
 * - The summary directory is written aside (`<root>/.staging-<stamp>`) and renamed into place when it is complete,
 *   so `<root>/<stamp>/` either holds a whole summary or does not exist. A run that was killed leaves only its
 *   hidden staging directory, which the next run removes.
 * - A lock (`<root>/nightly.lock`, holding the process ID) keeps two runs from overlapping; a lock whose process
 *   is gone is taken over.
 * - The recall history the nightly appends to is its own (`<root>/recall-history.jsonl`, started from a copy of
 *   the committed `evals/recall/history.jsonl`), so a scheduled run never changes the repository. A dry run keeps
 *   its rows apart (`<root>/recall-history.dry-run.jsonl`, started empty).
 * - `--dry-run` runs the same flow without the model: the tasks with the scripted stand-in agent
 *   (`evals/testing/stand-in-agent.ts`, `STAND_IN_MODE=scripted` unless set, its sessions in a data directory of
 *   its own inside the staging directory, so the export and the classification run for real), and the recall
 *   evaluation with the oracle reader. It spends nothing and records rows marked with the oracle's model.
 *
 * Exit codes: 0 everything passed; 1 the gate failed (a hard failure or a regression); 2 recall dropped by more than
 * the margin; 3 both; 4 inconclusive (nothing failed, but the gate lacked data or the recall rows were not
 * comparable); 5 another nightly holds the lock; 6 the run could not be completed (a dirty tree, a step that threw;
 * the summary says which); 64 usage error. Every live request spends the owner's ChatGPT plan allowance: a full run
 * is about 15 tasks x 3 repeats plus the recall run, roughly 350 requests.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join, relative, resolve } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { BASELINE_FILE, type Baseline, type Results, byTask, loadResults, statsOf } from "./baseline.ts"
import { type GateResult, RULES, formatGate, gate } from "./gate.ts"
import { HISTORY_FILE, type HistoryRow, type Runner, type TrackDeps, evaluationRunner, main as track, readHistory, realGit } from "./recall/track.ts"
import { type Report, type RunOptions, runAgent } from "./run-agent.ts"
import { listTasks } from "./run-check.ts"

const REPO = resolve(import.meta.dir, "..")
export const STAND_IN = ["bun", join(import.meta.dir, "testing", "stand-in-agent.ts")]
export const DEFAULT_MODEL = "gpt-6-luna"
export const DEFAULT_EFFORT = "low"
export const LOCK_FILE = "nightly.lock"
export const STAGING_PREFIX = ".staging-"

export const EXIT = { pass: 0, gate: 1, recall: 2, both: 3, inconclusive: 4, locked: 5, error: 6, usage: 64 } as const

export interface NightlyOptions {
  readonly root: string
  readonly dryRun: boolean
  /** Task IDs; empty means all. */
  readonly tasks: readonly string[]
  readonly repeat: number
  /** `null` with `--dry-run` and no `--model`: the stand-in is given none. */
  readonly model: string | null
  readonly effort: string | null
  readonly baseline: string
  readonly recallStrategies: readonly string[]
  readonly recallHistory: string
  readonly recallMargin: number
  readonly concurrency: number
  readonly timeoutSeconds: number | null
  readonly allowDirty: boolean
}

/** What the run needs from outside, so the tests can replace the parts that cost something. */
export interface NightlyDeps {
  readonly runTasks: (options: RunOptions) => Promise<Report>
  readonly recallRunner: Runner
  readonly git: { readonly head: () => string; readonly changes: () => readonly string[] }
  readonly now: () => Date
  readonly log: (line: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
}

export type RecallStatus = "ok" | "drop" | "incomparable" | "error" | "skipped"

export interface TaskLine {
  readonly task: string
  readonly runs: number
  readonly passes: number
  readonly passRate: number
  readonly baseline: { readonly runs: number; readonly passes: number; readonly passRate: number } | null
}

export interface NightlySummary {
  readonly v: 1
  readonly stamp: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly phasesMs: Readonly<Record<string, number>>
  readonly dryRun: boolean
  readonly commit: { readonly sha: string | null; readonly dirty: boolean }
  readonly host: string
  readonly configuration: { readonly model: string | null; readonly effort: string | null; readonly repeat: number; readonly tasks: number }
  readonly verdict: "pass" | "fail" | "inconclusive" | "error"
  readonly exitCode: number
  readonly errors: readonly string[]
  readonly tasks: readonly TaskLine[]
  readonly totals: { readonly runs: number; readonly passed: number; readonly passRate: number; readonly baselinePassRate: number | null } | null
  readonly gate: { readonly verdict: GateResult["verdict"]; readonly exitCode: number; readonly regressions: readonly string[]; readonly warnings: readonly string[]; readonly inconclusive: readonly string[]; readonly passedChecks: number } | null
  readonly cache: {
    readonly cachedShare: number | null
    readonly classified: number
    readonly runs: number
    readonly providerSide: number
    readonly intentional: number
    readonly avoidable: number
    readonly usageOnly: number
    readonly avoidableCauses: readonly string[]
  } | null
  readonly recall: {
    readonly status: RecallStatus
    readonly strategies: Readonly<Record<string, { readonly pass: number; readonly total: number; readonly previous: { readonly pass: number; readonly total: number } | null }>>
    readonly lines: readonly string[]
    readonly requests: number
  }
  readonly requests: { readonly live: boolean; readonly tasks: number; readonly recall: number; readonly total: number }
  readonly tokens: { readonly input: number; readonly cached: number; readonly output: number; readonly total: number } | null
}

// ---------------------------------------------------------------- the run

/** Runs the whole flow. Returns the exit code and, unless the lock was held, where the summary is. */
export async function runNightly(options: NightlyOptions, deps: NightlyDeps): Promise<{ readonly exitCode: number; readonly directory: string | null; readonly summary: NightlySummary | null }> {
  mkdirSync(options.root, { recursive: true })
  const lock = acquireLock(join(options.root, LOCK_FILE))
  if ("heldBy" in lock) {
    deps.log(`another nightly run holds ${join(options.root, LOCK_FILE)} (process ${lock.heldBy}); not starting`)
    return { exitCode: EXIT.locked, directory: null, summary: null }
  }
  try {
    return await locked(options, deps)
  } finally {
    lock.release()
  }
}

async function locked(options: NightlyOptions, deps: NightlyDeps) {
  const started = deps.now()
  const stamp = stampOf(started)
  // With the lock held, a staging directory is a dead run's: nobody is writing it.
  for (const name of readdirSync(options.root)) if (name.startsWith(STAGING_PREFIX)) rmSync(join(options.root, name), { recursive: true, force: true })
  const staging = join(options.root, `${STAGING_PREFIX}${stamp}`)
  mkdirSync(staging, { recursive: true })
  const errors: string[] = []
  const phases: Record<string, number> = {}
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T | null> => {
    const at = Date.now()
    deps.log(`${name}...`)
    try {
      return await work()
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      deps.log(`${name} failed: ${errors.at(-1)}`)
      return null
    } finally {
      phases[name] = Date.now() - at
    }
  }

  // 1. The commit.
  const sha = safe(() => deps.git.head())
  const changes = safe(() => deps.git.changes()) ?? []
  const dirty = changes.some((path) => !path.endsWith("evals/recall/history.jsonl"))
  const allowDirty = options.allowDirty || options.dryRun
  if (dirty && !allowDirty) errors.push(`the working tree has uncommitted changes (${changes.slice(0, 5).join(", ")}): commit them, or pass --allow-dirty`)
  const runnable = !(dirty && !allowDirty)

  // 2. The task suite.
  const ids = options.tasks.length > 0 ? options.tasks : await listTasks()
  const tasksDir = join(staging, "tasks")
  const dryData = join(staging, "dry-run-data")
  const report = !runnable
    ? null
    : await timed("tasks", () =>
        deps.runTasks({
          tasks: ids,
          model: options.model,
          effort: options.effort,
          repeat: options.repeat,
          concurrency: options.concurrency,
          out: tasksDir,
          ...(options.timeoutSeconds === null ? {} : { timeoutSeconds: options.timeoutSeconds }),
          ...(options.dryRun ? { cli: STAND_IN, env: { XDG_DATA_HOME: dryData, STAND_IN_MODE: deps.env.STAND_IN_MODE ?? "scripted" } } : {}),
          onResult: (result) => deps.log(`  ${result.status.padEnd(7)} ${result.task}#${result.attempt}`),
        }),
      )

  // 3. The gate.
  const baseline = existsSync(options.baseline) ? (JSON.parse(readFileSync(options.baseline, "utf8")) as Baseline) : null
  if (baseline === null && report !== null) errors.push(`no baseline at ${options.baseline}: only the hard rules applied`)
  let results: Results[] = []
  const gated =
    report === null
      ? null
      : await timed("gate", async () => {
          results = await loadResults([tasksDir])
          const result = await gate(results, baseline)
          await Bun.write(join(staging, "gate.json"), `${JSON.stringify(result, null, 2)}\n`)
          await Bun.write(join(staging, "gate.txt"), `${formatGate(result)}\n`)
          return result
        })

  // 4. Recall: record a row, then check it against the one before.
  const recallLog: string[] = []
  const recall = !runnable
    ? { status: "skipped" as RecallStatus, strategies: {}, lines: ["not run"], requests: 0 }
    : ((await timed("recall", () => recallStep(options, deps, recallLog))) ?? { status: "error" as RecallStatus, strategies: {}, lines: [errors.at(-1) ?? ""], requests: 0 })
  await Bun.write(join(staging, "recall.log"), `${recallLog.join("\n")}\n`)

  // 5. The summary.
  const finished = deps.now()
  const taskRequests = report === null ? 0 : report.results.reduce((total, run) => total + countRequests(safe(() => readFileSync(run.eventsFile, "utf8")) ?? ""), 0)
  const failedBits = (gated?.verdict === "fail" ? EXIT.gate : 0) | (recall.status === "drop" ? EXIT.recall : 0)
  const inconclusive = gated?.verdict === "inconclusive" || recall.status === "incomparable"
  const exitCode = failedBits !== 0 ? failedBits : errors.length > 0 && (report === null || gated === null || recall.status === "error" || recall.status === "skipped") ? EXIT.error : inconclusive ? EXIT.inconclusive : EXIT.pass
  const summary: NightlySummary = {
    v: 1,
    stamp,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    phasesMs: phases,
    dryRun: options.dryRun,
    commit: { sha, dirty },
    host: hostname(),
    configuration: { model: options.model, effort: options.effort, repeat: options.repeat, tasks: ids.length },
    verdict: failedBits !== 0 ? "fail" : exitCode === EXIT.error ? "error" : inconclusive ? "inconclusive" : "pass",
    exitCode,
    errors,
    tasks: report === null ? [] : taskLines(results, baseline),
    totals:
      report === null
        ? null
        : { runs: report.totals.runs, passed: report.totals.passed, passRate: report.totals.passRate, baselinePassRate: baseline === null ? null : baseline.summary.passRate },
    gate:
      gated === null
        ? null
        : {
            verdict: gated.verdict,
            exitCode: gated.exitCode,
            regressions: gated.findings.filter((finding) => finding.level === "fail" || finding.level === "regression").map((finding) => `${finding.level.toUpperCase()} ${finding.rule} ${finding.scope}: ${finding.message}`),
            // Cost above a baseline with one batch: shown, not part of the verdict.
            warnings: gated.findings.filter((finding) => finding.level === "warning").map((finding) => `${finding.rule} ${finding.scope}: ${finding.message}`),
            inconclusive: gated.findings.filter((finding) => finding.level === "no-data" || finding.level === "unchecked").map((finding) => `${finding.rule} ${finding.scope}: ${finding.message}`),
            passedChecks: gated.passedChecks,
          },
    cache:
      report === null
        ? null
        : {
            cachedShare: report.totals.cachedShare,
            classified: report.totals.cache.classified,
            runs: report.totals.runs,
            providerSide: report.totals.cache.providerSide,
            intentional: report.totals.cache.intentional,
            avoidable: report.totals.cache.avoidable,
            usageOnly: report.totals.cache.unfaithful,
            avoidableCauses: report.results.flatMap((run) => run.cache.avoidableCauses.map((cause) => `${run.task}#${run.attempt}: ${cause}`)),
          },
    recall,
    requests: { live: !options.dryRun, tasks: taskRequests, recall: recall.requests, total: taskRequests + recall.requests },
    tokens: report === null ? null : { input: report.totals.inputTokens, cached: report.totals.cachedTokens, output: report.totals.outputTokens, total: report.totals.totalTokens },
  }
  const directory = publish(options.root, staging, stamp, summary)
  deps.log(`summary: ${join(directory, "summary.md")}`)
  return { exitCode, directory, summary }
}

/** Runs the tracker twice: once to record a row in the nightly's own history, once with `--check`. */
async function recallStep(options: NightlyOptions, deps: NightlyDeps, log: string[]): Promise<NightlySummary["recall"]> {
  const history = options.recallHistory
  if (!existsSync(history)) {
    mkdirSync(resolve(history, ".."), { recursive: true })
    // A real run's history starts from the committed rows, so the first night has something to compare with.
    if (!options.dryRun && existsSync(HISTORY_FILE)) {
      copyFileSync(HISTORY_FILE, history)
      log.push(`started ${history} from ${relative(REPO, HISTORY_FILE)}`)
    }
  }
  const before = readHistory(history).length
  // In a dry run the tracker is told `--live`, so it records the row, while the runner it is given uses the oracle.
  const runner: Runner = options.dryRun ? (settings) => deps.recallRunner({ ...settings, live: false }) : deps.recallRunner
  const trackDeps = (out: string[]): TrackDeps => ({ runner, git: deps.git, historyPath: history, now: deps.now, out: (line) => out.push(line), err: (line) => out.push(line) })
  const recorded: string[] = []
  const args = ["--live", "--strategies", options.recallStrategies.join(","), "--history", history, ...(options.allowDirty || options.dryRun ? ["--allow-dirty"] : [])]
  const code = await track(args, trackDeps(recorded))
  log.push(`$ track ${args.join(" ")}`, ...recorded, `exit ${code}`)
  const rows = readHistory(history)
  if (code !== 0 || rows.length === before) return { status: "error", strategies: {}, lines: [`the recall run recorded no row (exit ${code})`, ...recorded.slice(-3)], requests: 0 }
  const checked: string[] = []
  const checkCode = await track(["--check", "--history", history, "--margin", String(options.recallMargin)], trackDeps(checked))
  log.push(`$ track --check --margin ${options.recallMargin}`, ...checked, `exit ${checkCode}`)
  const latest = rows.at(-1)!
  const previous: HistoryRow | null = rows.at(-2) ?? null
  const comparable = previous !== null && previous.model === latest.model && previous.effort === latest.effort
  const strategies = Object.fromEntries(
    Object.entries(latest.strategies).map(([name, row]) => {
      const earlier = comparable ? previous!.strategies[name as keyof HistoryRow["strategies"]] : undefined
      return [name, { pass: row!.pass, total: row!.total, previous: earlier === undefined ? null : { pass: earlier.pass, total: earlier.total } }]
    }),
  )
  return { status: checkCode === 0 ? "ok" : checkCode === 1 ? "drop" : "incomparable", strategies, lines: checked, requests: latest.requests }
}

function taskLines(results: readonly Results[], baseline: Baseline | null): TaskLine[] {
  return [...byTask(results)].map(([task, runs]) => {
    const stats = statsOf(runs)
    const base = baseline?.tasks[task]
    return { task, runs: stats.runs, passes: stats.passes, passRate: stats.passRate, baseline: base === undefined ? null : { runs: base.runs, passes: base.passes, passRate: base.passRate } }
  })
}

/**
 * Model calls a run's event stream shows: every `step.started` (retries included), and every compaction summary
 * call (its start, its repair and its retries), also inside a subagent's `child.event`.
 */
export function countRequests(jsonl: string): number {
  let count = 0
  const compactions = new Set<string>()
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    let item: { type?: string; data?: { messageId?: string }; event?: { type?: string; data?: { messageId?: string } } }
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    const event = item.type === "child.event" ? item.event : item
    const type = event?.type
    const message = event?.data?.messageId ?? ""
    if (type === "step.started" || type === "compaction.repair_requested") count += 1
    else if (type === "compaction.started") {
      count += 1
      compactions.add(message)
    } else if (type === "retry.scheduled" && compactions.has(message)) count += 1
  }
  return count
}

// ---------------------------------------------------------------- writing the summary

/** Writes the summary into the staging directory, points the raw results at the final place, and renames it there. */
function publish(root: string, staging: string, stamp: string, summary: NightlySummary): string {
  let directory = join(root, stamp)
  for (let n = 2; existsSync(directory); n += 1) directory = join(root, `${stamp}-${n}`)
  const results = join(staging, "tasks", "results.json")
  // results.json names its files by absolute path; after the rename they are under the final directory.
  if (existsSync(results)) writeFileAtomic(results, readFileSync(results, "utf8").split(staging).join(directory))
  writeFileAtomic(join(staging, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileAtomic(join(staging, "summary.md"), renderSummary(summary))
  renameSync(staging, directory)
  // `latest` points at the newest summary; replaced by a rename, so a reader never sees it missing.
  const link = join(root, "latest")
  const temporary = join(root, `.latest-${process.pid}`)
  rmSync(temporary, { force: true })
  symlinkSync(relative(root, directory), temporary)
  renameSync(temporary, link)
  return directory
}

function writeFileAtomic(path: string, text: string) {
  const temporary = `${path}.tmp-${process.pid}`
  const fd = openSync(temporary, "w")
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
}

export function renderSummary(summary: NightlySummary): string {
  const pct = (share: number | null) => (share === null ? "-" : `${Math.round(share * 100)}%`)
  const duration = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)
  const count = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))
  const gateWord = summary.gate === null ? "not run" : summary.gate.verdict.toUpperCase()
  const recallWord = summary.recall.status === "ok" ? "ok" : summary.recall.status.toUpperCase()
  const lines = [
    `# Nightly ${summary.startedAt.slice(0, 16).replace("T", " ")} UTC: ${summary.verdict.toUpperCase()} (exit ${summary.exitCode})${summary.dryRun ? " (dry run, no model)" : ""}`,
    "",
    `commit ${summary.commit.sha?.slice(0, 10) ?? "unknown"}${summary.commit.dirty ? " (dirty)" : ""} · ${summary.configuration.model ?? "no model"} / ${summary.configuration.effort ?? "-"} · ${summary.configuration.tasks} tasks x ${summary.configuration.repeat} · ${duration(summary.durationMs)}`,
    "",
    `gate ${gateWord} · recall ${recallWord}${summary.totals === null ? "" : ` · passed ${summary.totals.passed}/${summary.totals.runs} (${pct(summary.totals.passRate)}; baseline ${pct(summary.totals.baselinePassRate)})`}`,
  ]
  if (summary.errors.length > 0) lines.push("", "## Errors", ...summary.errors.map((error) => `- ${error}`))
  if (summary.gate !== null && summary.gate.regressions.length > 0) lines.push("", "## Regressions", ...summary.gate.regressions.map((line) => `- ${line}`))
  if (summary.gate !== null && summary.gate.warnings.length > 0) {
    lines.push("", "## Warnings", ...summary.gate.warnings.slice(0, 10).map((line) => `- ${line}`))
    if (summary.gate.warnings.length > 10) lines.push(`- ... and ${summary.gate.warnings.length - 10} more (gate.txt)`)
  }
  if (summary.gate !== null && summary.gate.inconclusive.length > 0) {
    lines.push("", "## Not enough data", ...summary.gate.inconclusive.slice(0, 5).map((line) => `- ${line}`))
    if (summary.gate.inconclusive.length > 5) lines.push(`- ... and ${summary.gate.inconclusive.length - 5} more (gate.txt)`)
  }
  if (summary.tasks.length > 0) {
    lines.push("", "## Pass rate per task", "", "| task | now | baseline |", "| --- | --- | --- |")
    for (const task of summary.tasks) lines.push(`| ${task.task} | ${task.passes}/${task.runs} | ${task.baseline === null ? "-" : `${task.baseline.passes}/${task.baseline.runs}`} |`)
  }
  if (summary.cache !== null) {
    const cache = summary.cache
    lines.push(
      "",
      "## Cache",
      "",
      `cached share ${pct(cache.cachedShare)} · ${cache.classified}/${cache.runs} runs classified · misses: ${cache.providerSide} provider-side, ${cache.intentional} intentional, ${cache.avoidable} avoidable · ${cache.usageOnly} usage-only records`,
      ...cache.avoidableCauses.slice(0, 5).map((cause) => `- avoidable: ${cause}`),
    )
  }
  lines.push("", "## Recall", "")
  const strategies = Object.entries(summary.recall.strategies)
  if (strategies.length === 0) lines.push(summary.recall.lines[0] ?? "not run")
  for (const [name, row] of strategies) lines.push(`- ${name}: ${row.pass}/${row.total}${row.previous === null ? " (nothing comparable before)" : ` (previous ${row.previous.pass}/${row.previous.total})`} ${recallWord}`)
  lines.push(
    "",
    "## Cost and time",
    "",
    `${summary.requests.live ? "live" : "scripted"} model requests: ${summary.requests.total} (${summary.requests.tasks} tasks, ${summary.requests.recall} recall)` +
      (summary.tokens === null ? "" : ` · task tokens ${count(summary.tokens.input)} in (${count(summary.tokens.cached)} cached), ${count(summary.tokens.output)} out`),
    Object.entries(summary.phasesMs).map(([name, ms]) => `${name} ${duration(ms)}`).join(" · ") + ` · total ${duration(summary.durationMs)}`,
    "",
    "Raw: `tasks/results.json`, `tasks/runs/`, `gate.txt`, `gate.json`, `recall.log`, `summary.json`.",
    "",
  )
  return lines.join("\n")
}

// ---------------------------------------------------------------- the lock

/** Takes the lock file, or says who holds it. A lock whose process is gone is taken over. */
export function acquireLock(path: string): { readonly release: () => void } | { readonly heldBy: number } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      closeSync(fd)
      return {
        release: () => {
          if (holder(path) === process.pid) rmSync(path, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const pid = holder(path)
      if (pid !== null && alive(pid)) return { heldBy: pid }
      // Stale: move it aside first, so two runs that both found it stale cannot both remove a fresh lock.
      const aside = `${path}.stale-${process.pid}`
      try {
        renameSync(path, aside)
        unlinkSync(aside)
      } catch {}
    }
  }
  const pid = holder(path)
  return { heldBy: pid ?? -1 }
}

function holder(path: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// ---------------------------------------------------------------- the command

function stampOf(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "")
}

function safe<T>(work: () => T): T | null {
  try {
    return work()
  } catch {
    return null
  }
}

export function defaultRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), `${brand.directory}-nightly`)
}

const USAGE = `usage: bun evals/nightly.ts [--root <dir>] [--dry-run] [--tasks a,b] [--repeat N] [--model <slug>] [--effort <level>]
         [--baseline <file>] [--recall-strategies engine] [--recall-history <file>] [--recall-margin N]
         [--concurrency N] [--timeout <s>] [--allow-dirty]`

/** Parses the command line. A string is a usage error. */
export function parseNightlyArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): NightlyOptions | string {
  const valued = ["--root", "--tasks", "--repeat", "--model", "--effort", "--baseline", "--recall-strategies", "--recall-history", "--recall-margin", "--concurrency", "--timeout"]
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (valued.includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined) return `${arg} needs a value`
      values.set(arg, value)
      index += 1
    } else if (arg === "--dry-run" || arg === "--allow-dirty") flags.add(arg)
    else return `unknown argument ${arg}`
  }
  const dryRun = flags.has("--dry-run")
  const number = (flag: string, fallback: number, min: number) => {
    const raw = values.get(flag)
    if (raw === undefined) return fallback
    const value = Number(raw)
    return Number.isInteger(value) && value >= min ? value : null
  }
  const repeat = number("--repeat", RULES.minRepeats, 1)
  const concurrency = number("--concurrency", 1, 1)
  const margin = number("--recall-margin", 2, 0)
  if (repeat === null) return "--repeat takes a whole number of at least 1"
  if (concurrency === null) return "--concurrency takes a whole number of at least 1"
  if (margin === null) return "--recall-margin takes a whole number of at least 0"
  const timeout = values.has("--timeout") ? Number(values.get("--timeout")) : null
  if (timeout !== null && !(timeout > 0)) return "--timeout takes a positive number of seconds"
  const root = resolve(values.get("--root") ?? defaultRoot(env))
  if (root === REPO || root.startsWith(`${REPO}/`)) return `the root must be outside the repository (${REPO})`
  const baselineFile = resolve(values.get("--baseline") ?? BASELINE_FILE)
  const configured = !dryRun && existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline).configuration : null
  return {
    root,
    dryRun,
    tasks: values.get("--tasks")?.split(",").filter((id) => id !== "") ?? [],
    repeat,
    // The gate compares only like with like: by default, the configuration the baseline was recorded with.
    model: values.get("--model") ?? (dryRun ? null : (configured?.model ?? DEFAULT_MODEL)),
    effort: values.get("--effort") ?? (dryRun ? null : (configured?.effort ?? DEFAULT_EFFORT)),
    baseline: baselineFile,
    recallStrategies: (values.get("--recall-strategies") ?? "engine").split(",").filter((name) => name !== ""),
    // A dry run's rows (the oracle's) never share a history with real ones.
    recallHistory: resolve(values.get("--recall-history") ?? join(root, dryRun ? "recall-history.dry-run.jsonl" : "recall-history.jsonl")),
    recallMargin: margin,
    concurrency,
    timeoutSeconds: timeout,
    allowDirty: flags.has("--allow-dirty"),
  }
}

if (import.meta.main) {
  const parsed = parseNightlyArgs(process.argv.slice(2))
  if (typeof parsed === "string") {
    console.error(`${parsed}\n${USAGE}`)
    process.exit(EXIT.usage)
  }
  const known = await listTasks()
  const unknown = parsed.tasks.filter((id) => !known.includes(id))
  if (unknown.length > 0) {
    console.error(`unknown task ${unknown.join(", ")}; tasks: ${known.join(", ")}`)
    process.exit(EXIT.usage)
  }
  const { exitCode, directory } = await runNightly(parsed, {
    runTasks: runAgent,
    recallRunner: evaluationRunner,
    git: realGit,
    now: () => new Date(),
    log: (line) => console.error(line),
    env: process.env,
  })
  if (directory !== null) console.log(readFileSync(join(directory, "summary.md"), "utf8"))
  process.exit(exitCode)
}
