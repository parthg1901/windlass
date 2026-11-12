/**
 * "What would this prompt change do?" Replays every recorded run of an eval
 * results directory (`evals/run-agent.ts --out <dir>`; each run names its
 * session, and the sessions live in the harness data directory) against a
 * proposed change, and prints per task how many replays stayed on the
 * recording to the end and where the others left it.
 *
 *   bun evals/replay-suite.ts <results-dir> [--system-prompt <file>] [--tool-description <tool>=<file>]...
 *                             [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute] [--strict]
 *                             [--repeat N] [--noise N] [--noise-policy stop|execute] [--json] [--out <file>] [--data-dir <dir>]
 *
 * The noise floor. A model is not deterministic: a replay with NO change
 * still leaves the recording sometimes. So every run is also replayed
 * `--noise` times (default 2) with nothing changed, and that rate is printed
 * next to every result.
 *
 * With `--policy execute` a replay that leaves the recording carries on in a
 * copy of the recorded workspace, and that copy is graded with the task's
 * grader; the verdict is printed next to the recorded run's. A replay that
 * stayed on the recording made the recorded calls, so its result is the
 * recorded one.
 *
 * Next to that old count it reports measures that ignore how the model
 * looked around (`replay/effects.ts`): where a lenient matcher would have
 * stopped, whether the side effects, the set of files changed and the files'
 * bytes are the recording's, and the grade. Under `--policy execute` the
 * unchanged replays run under `execute` too, so both sides are measured the
 * same way. Measured on the real model, divergence counts are at the floor
 * (every unchanged replay leaves); files changed and the grade are what
 * carry a signal (docs/replay.md has the numbers). The verdict says which
 * differences chance alone could make at the sample size used.
 *
 * Whether the new behaviour is better is what the eval suite itself measures
 * (`run-agent.ts`, `gate.ts`).
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { type Engine, EngineError, type ReplayOutcome, type ReplayRequest, createHarness } from "../packages/core/src/index.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import { DEFAULT_NORMALISERS } from "../packages/core/src/engine/replay.ts"
import { compareReplay, finalSnapshot } from "../packages/core/src/replay/effects.ts"
import { exportSnapshot } from "../packages/core/src/snapshot/index.ts"
import type { Divergence } from "../packages/core/src/replay/match.ts"
import { REPLAY_FLAGS, replayRequest, snapshotOfCopy } from "../scripts/replay.ts"
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
  /**
   * Compared on what it did rather than how it looked around
   * (`replay/effects.ts`): the calls with side effects, in order. `null` when
   * the replay did not reach an answer of its own (it stopped where it left
   * the recording, or failed), so there is nothing whole to compare.
   */
  readonly effects: { readonly same: boolean; readonly matched: number; readonly recordedActs: number; readonly replayedActs: number; readonly first: string | null } | null
  /**
   * A lenient matcher without a copy of the workspace: where it would have
   * ended (the first look it could not soundly answer from the recording, or
   * the first act that differs). `null` when not comparable, as `effects`.
   */
  readonly lenient: { readonly served: number; readonly mustRun: number; readonly left: string | null } | null
  /** Whether it ended with the recording's workspace (equal snapshot IDs); `null` when that is not known (it left without a copy). */
  readonly sameWorkspace: boolean | null
  /**
   * Whether it changed the same files as the recording, whatever it wrote in
   * them (the paths that differ between the recording's first snapshot and
   * each side's last). `null` when not known.
   */
  readonly samePaths: boolean | null
  /** The changed paths of both sides, when they are not the same. */
  readonly paths: { readonly recorded: readonly string[]; readonly replayed: readonly string[] } | null
  /** The grade of the copy a diverged replay ended in (`--policy execute`). */
  readonly graded: GradeResult | null
  readonly recordedPass: boolean
}

export interface TaskSummary {
  readonly task: string
  readonly runs: number
  /**
   * `novel`: how many of the replays that left the recording left it at a
   * place (step, tool, kind) where no unchanged replay of this task did. A
   * model that explores differently every time leaves most recordings
   * anyway; where it leaves them is what a change shows in.
   */
  readonly change: Tally & { readonly where: readonly string[]; readonly effectsWhere: readonly string[]; readonly novel: number }
  readonly noise: Tally & { readonly where: readonly string[]; readonly effectsWhere: readonly string[] }
  /** With grading: of the diverged replays, how many passed the task's grader; and how many of the recorded runs had. */
  readonly graded: { readonly diverged: number; readonly passed: number; readonly recordedPassed: number } | null
}

/** A count out of the replays it could be measured on. */
export interface Measure {
  readonly yes: number
  readonly of: number
}

/** The old measure (left the recording) and the new ones, for one set of replays. */
export interface Tally {
  readonly replays: number
  readonly onTape: number
  readonly left: number
  readonly other: number
  /** Made other side effects than the recording (of the replays that reached an answer). */
  readonly effectsDiffer: Measure
  /** A lenient matcher without a copy would have left the recording (same replays). */
  readonly lenientLeft: Measure
  /** Changed other files than the recording, whatever it wrote in them (of the replays where it is known). */
  readonly pathsDiffer: Measure
  /** Ended with another workspace than the recording, byte for byte (of the replays where it is known). */
  readonly workspaceDiffers: Measure
  /** Passed the task's grader (of the replays that were graded). */
  readonly passed: Measure
}

export interface SuiteReport {
  readonly results: string
  readonly policy: string
  /** The policy the unchanged replays ran under. */
  readonly noisePolicy: string
  readonly change: string
  readonly rows: readonly ReplayRow[]
  readonly tasks: readonly TaskSummary[]
  readonly totals: {
    readonly runs: number
    readonly skipped: number
    readonly change: Tally & { readonly novel: number }
    readonly noise: Tally
    readonly requests: number
    readonly inputTokens: number
    readonly cachedTokens: number
    readonly outputTokens: number
  }
}

export interface SuiteOptions {
  readonly engine: Pick<Engine, "replaySession" | "resolveSession" | "readEvents">
  readonly runs: readonly RecordedRun[]
  readonly request: ReplayRequest
  /** Replays per run with the change. Default 1. */
  readonly repeat?: number
  /** Replays per run with nothing changed. Default 2; 0 measures no noise floor (and the report says so). */
  readonly noise?: number
  /**
   * The policy of the unchanged replays. Default: `execute` when the change
   * runs under `execute` (the side effects and the workspace are compared
   * like with like, and graded), otherwise `stop`.
   */
  readonly noisePolicy?: "stop" | "execute"
  /**
   * Writes snapshot `id` of `workspace` into the directory `into`
   * (`exportSnapshot` with the harness's snapshot directory). Without it the
   * changed paths are not compared.
   */
  readonly exportSnapshot?: (workspace: string, id: string, into: string) => Promise<unknown>
  /**
   * Takes a snapshot of the copy a replay ended in and returns its ID
   * (`snapshotOfCopy`). Without it the files are judged from the replay's
   * log, which misses the changes of the step in which it left the recording
   * when no later step was snapshotted.
   */
  readonly snapshotCopy?: (copy: string, session: string) => Promise<string | null>
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
  const changePolicy = options.request.policy ?? "stop"
  // Under `stop` the noise floor asks only where the model leaves, and costs nothing else. Under `execute` the
  // unchanged replays run to their end too, so their side effects and workspaces are compared like with like.
  const noisePolicy = options.noisePolicy ?? (changePolicy === "execute" ? "execute" : "stop")
  const unchanged: ReplayRequest = { policy: noisePolicy, ...(options.request.strict === true ? { strict: true } : {}) }
  const replayable = options.runs.filter((run) => run.sessionId !== null)

  const one = async (run: RecordedRun, kind: ReplayRow["kind"], request: ReplayRequest): Promise<ReplayRow> => {
    const base = { task: run.task, attempt: run.attempt, sessionId: run.sessionId!, kind, recordedPass: run.pass }
    const failed = (reason: string): ReplayRow => ({ ...base, replaySessionId: null, status: "error", reason, left: null, matchedSteps: 0, recordedSteps: 0, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, effects: null, lenient: null, sameWorkspace: null, samePaths: null, paths: null, graded: null })
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
    const sourceEvents = options.engine.readEvents(outcome.sourceSessionId)
    const replayEvents = options.engine.readEvents(outcome.sessionId)
    const replayFinal = outcome.workspace === null || options.snapshotCopy === undefined ? undefined : await options.snapshotCopy(outcome.workspace, outcome.sessionId).catch(() => null)
    const compared = compareReplay(sourceEvents, replayEvents, report, { normalisers: DEFAULT_NORMALISERS, ...(replayFinal === undefined ? {} : { replayFinal }) })
    const paths = compared.sameWorkspace !== false || options.exportSnapshot === undefined ? null : await changedPaths(options.exportSnapshot, sourceEvents, replayEvents, replayFinal).catch(() => null)
    const samePaths = compared.sameWorkspace === true ? true : paths === null ? null : sameList(paths.recorded, paths.replayed)
    let graded: GradeResult | null = null
    if (outcome.workspace !== null) {
      // Only a replay that left the recording has a workspace of its own to grade.
      graded = await grader(run.task, outcome.workspace).catch((error: unknown) => ({ pass: false, message: `the grader failed: ${error instanceof Error ? error.message : String(error)}` }))
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
      ...compared,
      samePaths,
      paths: samePaths === false ? paths : null,
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

  const places = (list: readonly (string | null)[]) => {
    const counted = new Map<string, number>()
    for (const text of list) if (text !== null) counted.set(text, (counted.get(text) ?? 0) + 1)
    return [...counted].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([text, count]) => (count === 1 ? text : `${count}x ${text}`))
  }
  const placeOf = (row: ReplayRow) => (row.left === null ? null : place(row.left))
  const tasks = [...new Set(replayable.map((run) => run.task))].map((task): TaskSummary => {
    const mine = rows.filter((row) => row.task === task)
    const change = mine.filter((row) => row.kind === "change")
    const floor = mine.filter((row) => row.kind === "noise")
    const graded = change.filter((row) => row.graded !== null)
    const usual = new Set(floor.flatMap((row) => (row.left === null ? [] : [place(row.left)])))
    return {
      task,
      runs: replayable.filter((run) => run.task === task).length,
      change: { ...tally(change), where: places(change.map(placeOf)), effectsWhere: places(change.map((row) => row.effects?.first ?? null)), novel: change.filter((row) => row.left !== null && !usual.has(place(row.left))).length },
      noise: { ...tally(floor), where: places(floor.map(placeOf)), effectsWhere: places(floor.map((row) => row.effects?.first ?? null)) },
      graded: graded.length === 0 ? null : { diverged: graded.length, passed: graded.filter((row) => row.graded!.pass).length, recordedPassed: graded.filter((row) => row.recordedPass).length },
    }
  })
  const sum = (pick: (row: ReplayRow) => number) => rows.reduce((total, row) => total + pick(row), 0)
  return {
    results: options.results ?? "",
    policy: changePolicy,
    noisePolicy,
    change: describeChange(options.request),
    rows,
    tasks,
    totals: {
      runs: replayable.length,
      skipped: options.runs.length - replayable.length,
      change: { ...tally(rows.filter((row) => row.kind === "change")), novel: tasks.reduce((total, task) => total + task.change.novel, 0) },
      noise: tally(rows.filter((row) => row.kind === "noise")),
      requests: sum((row) => row.requests),
      inputTokens: sum((row) => row.inputTokens),
      cachedTokens: sum((row) => row.cachedTokens),
      outputTokens: sum((row) => row.outputTokens),
    },
  }
}

type LogEvents = ReturnType<Engine["readEvents"]>

/** The files each side changed: what differs between the recording's first snapshot and each side's last one. */
async function changedPaths(exporter: NonNullable<SuiteOptions["exportSnapshot"]>, sourceEvents: LogEvents, replayEvents: LogEvents, replayFinal: string | null | undefined): Promise<{ recorded: string[]; replayed: string[] } | null> {
  const taken = sourceEvents.flatMap((item) => (item.type === "snapshot.taken" ? [item.data.id] : []))
  const diverged = replayEvents.find((item) => item.type === "replay.diverged")
  const start = taken[0]
  const recorded = taken.at(-1)
  const replayed = replayFinal !== undefined ? replayFinal : finalSnapshot(replayEvents, recorded ?? null)
  const cwd = sourceEvents[0]?.type === "session.created" ? sourceEvents[0].data.cwd : null
  if (start === undefined || recorded === undefined || replayed === null || diverged?.type !== "replay.diverged" || cwd === null) return null
  const directory = await mkdtemp(join(tmpdir(), "replay-suite-"))
  const written = async (workspace: string, id: string, into: string) => {
    const result = await exporter(workspace, id, into).catch(() => null)
    return typeof result === "object" && result !== null && "files" in result
  }
  try {
    if (!(await written(cwd, start, join(directory, "start"))) || !(await written(cwd, recorded, join(directory, "recorded")))) return null
    // The replay's last snapshot is its copy's; the one it was restored from, the recording's.
    if (!(await written(diverged.data.workspace, replayed, join(directory, "replayed"))) && !(await written(cwd, replayed, join(directory, "replayed")))) return null
    const [before, after, replay] = await Promise.all(["start", "recorded", "replayed"].map((name) => fileHashes(join(directory, name))))
    return { recorded: differing(before!, after!), replayed: differing(before!, replay!) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function fileHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else hashes.set(relative(root, path), entry.isSymbolicLink() ? `link:${await readlink(path)}` : createHash("sha256").update(await readFile(path)).digest("hex"))
    }
  }
  await walk(root)
  return hashes
}

const differing = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort()
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])

const measure = (list: readonly ReplayRow[], pick: (row: ReplayRow) => boolean | null): Measure => {
  const known = list.map(pick).filter((value): value is boolean => value !== null)
  return { yes: known.filter(Boolean).length, of: known.length }
}

function tally(list: readonly ReplayRow[]): Tally {
  return {
    replays: list.length,
    onTape: list.filter((row) => row.status === "identical").length,
    left: list.filter((row) => row.status === "diverged").length,
    other: list.filter((row) => row.status !== "identical" && row.status !== "diverged").length,
    effectsDiffer: measure(list, (row) => (row.effects === null ? null : !row.effects.same)),
    lenientLeft: measure(list, (row) => (row.lenient === null ? null : row.lenient.left !== null)),
    pathsDiffer: measure(list, (row) => (row.samePaths === null ? null : !row.samePaths)),
    workspaceDiffers: measure(list, (row) => (row.sameWorkspace === null ? null : !row.sameWorkspace)),
    // A replay that stayed on the recording made the recorded calls, so its result is the recorded one.
    // So did one that answered having made exactly the recorded acts, all answered from the recording (same files).
    passed: measure(list, (row) => (row.graded !== null ? row.graded.pass : row.status === "identical" || (row.sameWorkspace === true && row.effects?.same === true) ? row.recordedPass : null)),
  }
}

/**
 * Two-sided Fisher exact test: how likely a split at least as uneven as
 * `a` of `n1` against `c` of `n2` is when both sets have the same rate.
 */
export function fisherExact(a: number, n1: number, c: number, n2: number): number {
  const logFactorial = (n: number) => {
    let total = 0
    for (let k = 2; k <= n; k += 1) total += Math.log(k)
    return total
  }
  const yes = a + c
  const total = n1 + n2
  const probability = (x: number) => Math.exp(logFactorial(yes) + logFactorial(total - yes) + logFactorial(n1) + logFactorial(n2) - logFactorial(total) - logFactorial(x) - logFactorial(yes - x) - logFactorial(n1 - x) - logFactorial(n2 - yes + x))
  const observed = probability(a)
  let p = 0
  for (let x = Math.max(0, yes - n2); x <= Math.min(yes, n1); x += 1) {
    const value = probability(x)
    if (value <= observed * (1 + 1e-9)) p += value
  }
  return Math.min(1, p)
}

const share = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`)
const ratio = (value: Measure) => (value.of === 0 ? "-" : `${value.yes}/${value.of}`)

/** The measures, in the order the table and the verdict show them. */
const MEASURES = [
  { key: "left", title: "left", words: "left the recording (the strict matcher: the old measure)" },
  { key: "lenientLeft", title: "lenient", words: "would have left it under a lenient matcher without a copy" },
  { key: "effectsDiffer", title: "effects", words: "made other side effects than the recording" },
  { key: "pathsDiffer", title: "paths", words: "changed other files than the recording" },
  { key: "workspaceDiffers", title: "bytes", words: "ended with files not byte for byte the recording's" },
  { key: "passed", title: "pass", words: "passed the task's grader" },
] as const

function measureOf(tallied: Tally, key: (typeof MEASURES)[number]["key"]): Measure {
  return key === "left" ? { yes: tallied.left, of: tallied.onTape + tallied.left } : tallied[key]
}

/** The table: per task, the unchanged replays and the changed ones, each on the old count and the new measures. */
export function formatSuite(report: SuiteReport): string {
  const unchangedOnly = report.change.startsWith("nothing")
  const head = ["task", "runs", "replays", ...MEASURES.map((item) => item.title), "new place"]
  const rowsOf = (task: string, runs: number, noise: Tally, change: Tally & { readonly novel: number }) => [
    [task, String(runs), `no change ${noise.replays}`, ...MEASURES.map((item) => (noise.replays === 0 ? "-" : ratio(measureOf(noise, item.key)))), ""],
    ...(unchangedOnly ? [] : [["", "", `change ${change.replays}`, ...MEASURES.map((item) => ratio(measureOf(change, item.key))), noise.replays === 0 ? "-" : `${change.novel}/${change.left}`]]),
  ]
  const totals = report.totals
  const body = [...report.tasks.flatMap((task) => rowsOf(task.task, task.runs, task.noise, task.change)), ...rowsOf("all", totals.runs, totals.noise, totals.change)]
  const widths = head.map((title, column) => Math.max(title.length, ...body.map((row) => row[column]!.length)))
  const line = (row: readonly string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()
  const wheres = report.tasks.flatMap((task) => [
    `${task.task}`,
    `  no change left it at    ${task.noise.where.join("; ") || "-"}`,
    `  no change acted first   ${task.noise.effectsWhere.join("; ") || "-"}`,
    ...(unchangedOnly ? [] : [`  the change left it at   ${task.change.where.join("; ") || "-"}`, `  the change acted first  ${task.change.effectsWhere.join("; ") || "-"}`]),
  ])
  return [
    `replay suite: ${report.results}`,
    `change: ${report.change}   policy: ${report.policy}   unchanged replays: ${report.noisePolicy}`,
    "",
    line(head),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
    "",
    "Each column counts the replays that did it, of those it could be measured on. left: left the recording (the strict",
    "matcher, the old measure). lenient: would still have left under a matcher that lets reads pass where it can answer",
    "them soundly from the recording, and stops at the first it cannot. effects: made other writes, edits or non-reading",
    "commands, or in another order. paths: changed other files. bytes: ended with other file contents. pass: passed the",
    "task's grader. new place: changed replays that left at a step, tool and kind no unchanged replay of the task did.",
    "",
    ...wheres,
    "",
    `totals: ${totals.runs} recorded run${totals.runs === 1 ? "" : "s"}${totals.skipped > 0 ? ` (${totals.skipped} without a session, skipped)` : ""}; change ${totals.change.onTape} on tape, ${totals.change.left} left, ${totals.change.other} not comparable; no change ${totals.noise.onTape} on tape, ${totals.noise.left} left, ${totals.noise.other} not comparable`,
    `cost: ${totals.requests} model calls, ${totals.inputTokens} tokens in (${totals.cachedTokens} cached), ${totals.outputTokens} out`,
    "",
    ...verdict(report),
  ].join("\n")
}

/** What can and cannot be concluded, in plain words. */
export function verdict(report: SuiteReport): string[] {
  const { change, noise } = report.totals
  if (noise.replays === 0) return ["The noise floor was not measured (--noise 0), so nothing can be read into the change yet."]
  const unchangedOnly = report.change.startsWith("nothing")
  const floor = (value: Measure) => (value.of === 0 ? "not measured" : value.yes === 0 ? `0 of ${value.of} (the true rate is probably below ${share(3, value.of)}: with ${value.of} replays nothing rarer can be seen)` : `${value.yes} of ${value.of} (${share(value.yes, value.of)})`)
  if (unchangedOnly) {
    const all = (key: (typeof MEASURES)[number]["key"]): Measure => {
      const a = measureOf(noise, key)
      const b = measureOf(change, key)
      return { yes: a.yes + b.yes, of: a.of + b.of }
    }
    return [
      "Nothing was changed, so every replay measures the noise floor of these recordings on this model:",
      ...MEASURES.filter((item) => item.key !== "passed").map((item) => `- ${item.words}: ${floor(all(item.key))}`),
      "A change is visible on a measure only where it moves that measure clearly above these rates.",
    ]
  }
  const lines = [`With the change (${change.replays} replays) against no change (${noise.replays} replays):`]
  for (const item of MEASURES) {
    const a = measureOf(change, item.key)
    const b = measureOf(noise, item.key)
    if (a.of === 0 || b.of === 0) {
      lines.push(`- ${item.words}: not measured on ${a.of === 0 ? "the changed" : "the unchanged"} replays${report.policy !== "execute" && item.key !== "left" ? " (it needs --policy execute: a replay must reach its end)" : ""}.`)
      continue
    }
    const p = fisherExact(a.yes, a.of, b.yes, b.of)
    const reading = p < 0.05 ? `a difference chance alone makes this large only ${share(Math.round(p * 1000), 1000)} of the time` : `within what chance gives at these numbers (p = ${p.toFixed(2)})`
    lines.push(`- ${item.words}: ${a.yes} of ${a.of} with the change, ${b.yes} of ${b.of} without; ${reading}.`)
  }
  if (change.left > 0)
    lines.push(
      change.novel === 0
        ? "Every place the change left a recording is a place where no change left it too."
        : `${change.novel} of the ${change.left} changed replays that left did so at a place no unchanged replay of the same task did (${[...new Set(report.tasks.flatMap((task) => (task.change.novel > 0 ? task.change.where : [])))].slice(0, 4).join("; ")}). With ${noise.replays} unchanged replays that is a hint, not a measurement: a place is "new" only against the few places the floor happened to show.`,
    )
  const smallest = Math.min(change.replays, noise.replays)
  lines.push(
    smallest < 20
      ? `At ${change.replays} and ${noise.replays} replays only a large difference can be told from chance; "within chance" here does not mean the change does nothing.`
      : `At ${change.replays} and ${noise.replays} replays two rates must differ by roughly a quarter to a third of the replays (more near 50%) before chance can be ruled out; smaller differences cannot be read.`,
  )
  return lines
}

async function main(argv: readonly string[]): Promise<number> {
  const usage = "usage: bun evals/replay-suite.ts <results-dir> [--system-prompt <file>] [--tool-description <tool>=<file>]... [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute] [--strict] [--repeat N] [--noise N] [--noise-policy stop|execute] [--json] [--out <file>] [--data-dir <dir>]"
  const parsed = (() => {
    try {
      return parseArgs({ args: [...argv], allowPositionals: true, options: { ...REPLAY_FLAGS, repeat: { type: "string" }, noise: { type: "string" }, "noise-policy": { type: "string" }, json: { type: "boolean" }, out: { type: "string" }, "data-dir": { type: "string" }, keep: { type: "boolean" } } })
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
  const noisePolicy = parsed.values["noise-policy"]
  if (typeof request === "string" || repeat === null || noise === null || (noisePolicy !== undefined && noisePolicy !== "stop" && noisePolicy !== "execute")) {
    console.error(`${typeof request === "string" ? request : repeat === null || noise === null ? "--repeat and --noise take a number" : "--noise-policy is stop or execute"}\n${usage}`)
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
      ...(noisePolicy === undefined ? {} : { noisePolicy: noisePolicy as "stop" | "execute" }),
      exportSnapshot: (workspace, id, into) => exportSnapshot(workspace, id, into, { dataDir: join(harness.dataDir, "snapshots") }),
      snapshotCopy: (copy, session) => snapshotOfCopy(copy, harness.dataDir, session),
      results: directory,
      cleanup: parsed.values.keep !== true,
      onRow: (row) => console.error(`  ${row.kind === "noise" ? "no change" : "change   "}  ${row.task}#${row.attempt}  ${row.status}${row.left === null ? "" : `  ${place(row.left)}`}${row.effects === null ? "" : `  effects ${row.effects.same ? "same" : "differ"}`}${row.samePaths === null ? "" : `  paths ${row.samePaths ? "same" : "differ"}`}${row.sameWorkspace === null ? "" : `  bytes ${row.sameWorkspace ? "same" : "differ"}`}${row.graded === null ? "" : `  graded ${row.graded.pass ? "pass" : "fail"}`}  (${row.requests} calls)`),
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
