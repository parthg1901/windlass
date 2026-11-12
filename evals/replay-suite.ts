/**
 * "What would this prompt change do?" Replays every recorded run of an eval
 * results directory (`evals/run-agent.ts --out <dir>`; each run names its
 * session, and the sessions live in the harness data directory) against a
 * proposed change, and prints per task how many replays stayed on the
 * recording to the end and where the others left it.
 *
 *   bun evals/replay-suite.ts <results-dir> [--system-prompt <file>] [--tool-description <tool>=<file>]...
 *                             [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute] [--strict]
 *                             [--repeat N] [--noise N] [--json] [--out <file>] [--data-dir <dir>]
 *
 * The noise floor. A model is not deterministic: a replay with NO change
 * still leaves the recording sometimes. So every run is also replayed
 * `--noise` times (default 2) with nothing changed, and that rate is printed
 * next to every result. A change is only interesting where it leaves the
 * recording more often, or somewhere else, than no change does.
 *
 * With `--policy execute` a replay that leaves the recording carries on in a
 * copy of the recorded workspace, and that copy is graded with the task's
 * grader; the verdict is printed next to the recorded run's. A replay that
 * stayed on the recording made the recorded calls, so its result is the
 * recorded one.
 *
 * It answers "where does this change alter behaviour", cheaply and without
 * side effects. Whether the new behaviour is better is what the eval suite
 * itself measures (`run-agent.ts`, `gate.ts`).
 */
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { type Engine, EngineError, type ReplayOutcome, type ReplayRequest, createHarness } from "../packages/core/src/index.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import type { Divergence } from "../packages/core/src/replay/match.ts"
import { REPLAY_FLAGS, replayRequest } from "../scripts/replay.ts"
import { type GradeResult, grade } from "./run-check.ts"

/** One recorded run, as the suite needs it. */
export interface RecordedRun {
  readonly task: string
  readonly attempt: number
  readonly pass: boolean
  readonly sessionId: string | null
}

/** One replay of one recorded run. */
export interface ReplayRow {
  readonly task: string
  readonly attempt: number
  readonly sessionId: string
  /** `change`: with the proposed change. `noise`: with nothing changed. */
  readonly kind: "change" | "noise"
  readonly replaySessionId: string | null
  /** `identical`, `diverged`, `unsupported`, `incomplete`, or `error` when the replay could not be started. */
  readonly status: string
  readonly reason: string
  /** Where it left the recording: the replay's step (1-based), the tool it called there (`null`: it answered), and how. */
  readonly left: { readonly step: number; readonly recordedStep: number | null; readonly tool: string | null; readonly kind: string } | null
  readonly matchedSteps: number
  readonly recordedSteps: number
  readonly requests: number
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
  /** The grade of the copy a diverged replay ended in (`--policy execute`). */
  readonly graded: GradeResult | null
  readonly recordedPass: boolean
}

export interface TaskSummary {
  readonly task: string
  readonly runs: number
  readonly change: { readonly replays: number; readonly onTape: number; readonly left: number; readonly other: number; readonly where: readonly string[] }
  readonly noise: { readonly replays: number; readonly onTape: number; readonly left: number; readonly other: number; readonly where: readonly string[] }
  /** With grading: of the diverged replays, how many passed the task's grader; and how many of the recorded runs had. */
  readonly graded: { readonly diverged: number; readonly passed: number; readonly recordedPassed: number } | null
}

export interface SuiteReport {
  readonly results: string
  readonly policy: string
  readonly change: string
  readonly rows: readonly ReplayRow[]
  readonly tasks: readonly TaskSummary[]
  readonly totals: {
    readonly runs: number
    readonly skipped: number
    readonly change: { readonly replays: number; readonly onTape: number; readonly left: number; readonly other: number }
    readonly noise: { readonly replays: number; readonly onTape: number; readonly left: number; readonly other: number }
    readonly requests: number
    readonly inputTokens: number
    readonly cachedTokens: number
    readonly outputTokens: number
  }
}

export interface SuiteOptions {
  readonly engine: Pick<Engine, "replaySession" | "resolveSession">
  readonly runs: readonly RecordedRun[]
  readonly request: ReplayRequest
  /** Replays per run with the change. Default 1. */
  readonly repeat?: number
  /** Replays per run with nothing changed. Default 2; 0 measures no noise floor (and the report says so). */
  readonly noise?: number
  /** Grades a diverged replay's copy. Default: the task's own grader. */
  readonly grade?: (task: string, workspace: string) => Promise<GradeResult>
  /** Whether the copies are deleted after grading. Default true. */
  readonly cleanup?: boolean
  readonly results?: string
  readonly onRow?: (row: ReplayRow) => void
}

/** Reads the recorded runs of a results directory. */
export async function readRuns(directory: string): Promise<RecordedRun[]> {
  const file = Bun.file(join(directory, "results.json"))
  if (!(await file.exists())) throw new Error(`${join(directory, "results.json")} does not exist: give the --out directory of a run of evals/run-agent.ts`)
  const report = (await file.json()) as { readonly results?: readonly { readonly task?: unknown; readonly attempt?: unknown; readonly pass?: unknown; readonly metrics?: { readonly sessionId?: unknown } }[] }
  return (report.results ?? []).flatMap((row) =>
    typeof row.task === "string" ? [{ task: row.task, attempt: typeof row.attempt === "number" ? row.attempt : 1, pass: row.pass === true, sessionId: typeof row.metrics?.sessionId === "string" ? row.metrics.sessionId : null }] : [],
  )
}

/** What a request changes, in a few words. */
export function describeChange(request: ReplayRequest): string {
  const parts = [
    ...(request.systemPrompt === undefined ? [] : ["the system prompt"]),
    ...Object.keys(request.toolDescriptions ?? {}).map((tool) => `the description of ${tool}`),
    ...(request.model === undefined ? [] : [`model ${request.model}`]),
    ...(request.effort === undefined ? [] : [`effort ${request.effort ?? "default"}`]),
    ...(request.strict === true ? ["strict matching"] : []),
  ]
  return parts.length === 0 ? "nothing (every replay measures the noise floor)" : parts.join(", ")
}

function where(divergence: Divergence | null): ReplayRow["left"] {
  if (divergence === null) return null
  return { step: divergence.replayStep + 1, recordedStep: divergence.recordedStep === null ? null : divergence.recordedStep + 1, tool: divergence.replayed.kind === "call" ? divergence.replayed.call.name : null, kind: divergence.kind }
}

const place = (left: NonNullable<ReplayRow["left"]>) => `step ${left.step} ${left.tool ?? "answer"} (${left.kind.replaceAll("_", " ")})`

export async function runReplaySuite(options: SuiteOptions): Promise<SuiteReport> {
  const repeat = options.repeat ?? 1
  const noise = options.noise ?? 2
  const grader = options.grade ?? grade
  const rows: ReplayRow[] = []
  // The noise floor is measured under `stop`, whatever the change runs under: it asks only where the model leaves, and costs nothing else.
  const unchanged: ReplayRequest = { policy: "stop", ...(options.request.strict === true ? { strict: true } : {}) }
  const replayable = options.runs.filter((run) => run.sessionId !== null)

  const one = async (run: RecordedRun, kind: ReplayRow["kind"], request: ReplayRequest): Promise<ReplayRow> => {
    const base = { task: run.task, attempt: run.attempt, sessionId: run.sessionId!, kind, recordedPass: run.pass }
    const failed = (reason: string): ReplayRow => ({ ...base, replaySessionId: null, status: "error", reason, left: null, matchedSteps: 0, recordedSteps: 0, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, graded: null })
    let outcome: ReplayOutcome
    try {
      const started = await options.engine.replaySession(options.engine.resolveSession(run.sessionId!) as SessionId, request)
      outcome = await started.done
      await started.session.settled()
      await started.session.close()
    } catch (error) {
      return failed(error instanceof EngineError || error instanceof Error ? error.message : String(error))
    }
    const report = outcome.report
    let graded: GradeResult | null = null
    if (outcome.workspace !== null) {
      // Only a replay that left the recording has a workspace of its own to grade.
      if (kind === "change") graded = await grader(run.task, outcome.workspace).catch((error: unknown) => ({ pass: false, message: `the grader failed: ${error instanceof Error ? error.message : String(error)}` }))
      if (options.cleanup !== false) await rm(outcome.workspace, { recursive: true, force: true })
    }
    return {
      ...base,
      replaySessionId: outcome.sessionId,
      status: report.status,
      reason: report.reason,
      left: where(report.divergence),
      matchedSteps: report.matched.steps,
      recordedSteps: report.comparison.steps.recorded,
      requests: outcome.requests,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      cachedTokens: outcome.usage?.cachedInputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      graded,
    }
  }

  for (const run of replayable) {
    const plan: [ReplayRow["kind"], ReplayRequest][] = [...Array.from({ length: noise }, (): [ReplayRow["kind"], ReplayRequest] => ["noise", unchanged]), ...Array.from({ length: repeat }, (): [ReplayRow["kind"], ReplayRequest] => ["change", options.request])]
    for (const [kind, request] of plan) {
      const row = await one(run, kind, request)
      rows.push(row)
      options.onRow?.(row)
    }
  }

  const tally = (list: readonly ReplayRow[]) => ({
    replays: list.length,
    onTape: list.filter((row) => row.status === "identical").length,
    left: list.filter((row) => row.status === "diverged").length,
    other: list.filter((row) => row.status !== "identical" && row.status !== "diverged").length,
  })
  const places = (list: readonly ReplayRow[]) => {
    const counted = new Map<string, number>()
    for (const row of list) if (row.left !== null) counted.set(place(row.left), (counted.get(place(row.left)) ?? 0) + 1)
    return [...counted].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([text, count]) => (count === 1 ? text : `${count}x ${text}`))
  }
  const tasks = [...new Set(replayable.map((run) => run.task))].map((task): TaskSummary => {
    const mine = rows.filter((row) => row.task === task)
    const change = mine.filter((row) => row.kind === "change")
    const floor = mine.filter((row) => row.kind === "noise")
    const graded = change.filter((row) => row.graded !== null)
    return {
      task,
      runs: replayable.filter((run) => run.task === task).length,
      change: { ...tally(change), where: places(change) },
      noise: { ...tally(floor), where: places(floor) },
      graded: graded.length === 0 ? null : { diverged: graded.length, passed: graded.filter((row) => row.graded!.pass).length, recordedPassed: graded.filter((row) => row.recordedPass).length },
    }
  })
  const sum = (pick: (row: ReplayRow) => number) => rows.reduce((total, row) => total + pick(row), 0)
  return {
    results: options.results ?? "",
    policy: options.request.policy ?? "stop",
    change: describeChange(options.request),
    rows,
    tasks,
    totals: {
      runs: replayable.length,
      skipped: options.runs.length - replayable.length,
      change: tally(rows.filter((row) => row.kind === "change")),
      noise: tally(rows.filter((row) => row.kind === "noise")),
      requests: sum((row) => row.requests),
      inputTokens: sum((row) => row.inputTokens),
      cachedTokens: sum((row) => row.cachedTokens),
      outputTokens: sum((row) => row.outputTokens),
    },
  }
}

const share = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`)

/** The table: per task, the change's replays next to the noise floor. */
export function formatSuite(report: SuiteReport): string {
  const head = ["task", "runs", "on tape", "left", "where the change left it", "noise: left", "where no change left it", ...(report.tasks.some((task) => task.graded !== null) ? ["diverged: pass", "recorded: pass"] : [])]
  const body = report.tasks.map((task) => [
    task.task,
    String(task.runs),
    `${task.change.onTape}/${task.change.replays}`,
    `${task.change.left}/${task.change.replays}${task.change.other > 0 ? ` (+${task.change.other} n/a)` : ""}`,
    task.change.where.join("; ") || "-",
    task.noise.replays === 0 ? "not measured" : `${task.noise.left}/${task.noise.replays}${task.noise.other > 0 ? ` (+${task.noise.other} n/a)` : ""}`,
    task.noise.where.join("; ") || "-",
    ...(head.length > 7 ? [task.graded === null ? "-" : `${task.graded.passed}/${task.graded.diverged}`, task.graded === null ? "-" : `${task.graded.recordedPassed}/${task.graded.diverged}`] : []),
  ])
  const widths = head.map((title, column) => Math.max(title.length, ...body.map((row) => row[column]!.length)))
  const line = (cells: readonly string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()
  const { change, noise } = report.totals
  const floor = noise.replays === 0 ? null : noise.left / noise.replays
  const rate = change.replays === 0 ? 0 : change.left / change.replays
  const verdict =
    floor === null
      ? "The noise floor was not measured (--noise 0), so nothing can be read into the change yet."
      : report.change.startsWith("nothing")
        ? `Unchanged, a replay left the recording in ${noise.left + change.left} of ${noise.replays + change.replays} replays (${share(noise.left + change.left, noise.replays + change.replays)}). That is the noise floor of these recordings on this model.`
        : `The change left the recording in ${change.left} of ${change.replays} replays (${share(change.left, change.replays)}); with nothing changed, ${noise.left} of ${noise.replays} did (${share(noise.left, noise.replays)}). ${
            rate > floor
              ? "The change is above the noise floor: look at where it leaves, and whether no change ever leaves there."
              : "That is within the noise floor: these replays do not show that the change alters behaviour."
          }`
  return [
    `replay suite: ${report.results}`,
    `change: ${report.change}   policy: ${report.policy}`,
    "",
    line(head),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
    "",
    `totals: ${report.totals.runs} recorded run${report.totals.runs === 1 ? "" : "s"}${report.totals.skipped > 0 ? ` (${report.totals.skipped} without a session, skipped)` : ""}; change ${change.onTape} on tape, ${change.left} left, ${change.other} not comparable; no change ${noise.onTape} on tape, ${noise.left} left, ${noise.other} not comparable`,
    `cost: ${report.totals.requests} model calls, ${report.totals.inputTokens} tokens in (${report.totals.cachedTokens} cached), ${report.totals.outputTokens} out`,
    "",
    verdict,
  ].join("\n")
}

async function main(argv: readonly string[]): Promise<number> {
  const usage = "usage: bun evals/replay-suite.ts <results-dir> [--system-prompt <file>] [--tool-description <tool>=<file>]... [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute] [--strict] [--repeat N] [--noise N] [--json] [--out <file>] [--data-dir <dir>]"
  const parsed = (() => {
    try {
      return parseArgs({ args: [...argv], allowPositionals: true, options: { ...REPLAY_FLAGS, repeat: { type: "string" }, noise: { type: "string" }, json: { type: "boolean" }, out: { type: "string" }, "data-dir": { type: "string" }, keep: { type: "boolean" } } })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  if (typeof parsed === "string" || parsed.positionals.length !== 1) {
    console.error(typeof parsed === "string" ? `${parsed}\n${usage}` : usage)
    return 2
  }
  const request = await replayRequest(parsed.values)
  const count = (value: string | undefined, fallback: number) => (value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : null)
  const repeat = count(parsed.values.repeat, 1)
  const noise = count(parsed.values.noise, 2)
  if (typeof request === "string" || repeat === null || noise === null) {
    console.error(`${typeof request === "string" ? request : "--repeat and --noise take a number"}\n${usage}`)
    return 2
  }
  const directory = resolve(parsed.positionals[0]!)
  const harness = createHarness(parsed.values["data-dir"] === undefined ? {} : { dataDir: parsed.values["data-dir"] })
  try {
    const signedIn = await harness.signIn()
    if (!signedIn.signedIn) {
      console.error(signedIn.message)
      return 1
    }
    const runs = await readRuns(directory)
    const report = await runReplaySuite({
      engine: harness.engine,
      runs,
      request,
      repeat,
      noise,
      results: directory,
      cleanup: parsed.values.keep !== true,
      onRow: (row) => console.error(`  ${row.kind === "noise" ? "no change" : "change   "}  ${row.task}#${row.attempt}  ${row.status}${row.left === null ? "" : `  ${place(row.left)}`}${row.graded === null ? "" : `  graded ${row.graded.pass ? "pass" : "fail"}`}  (${row.requests} calls)`),
    })
    if (parsed.values.out !== undefined) await Bun.write(parsed.values.out, `${JSON.stringify(report, null, 2)}\n`)
    console.log(parsed.values.json === true ? JSON.stringify(report, null, 2) : formatSuite(report))
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await harness.close()
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
