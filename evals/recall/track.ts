// The recall score, recorded per commit.
//
//   bun evals/recall/track.ts --live [--strategies full,engine] [--max-requests N] [--allow-dirty]
//   bun evals/recall/track.ts --check [--margin N]
//   options: --history FILE (default evals/recall/history.jsonl), --seed N, --tokens N, --questions N
//
// A run evaluates the strategies (by default `full`, the ceiling, and `engine`, the product) on the
// default generated session, and appends one row to the history file: the commit, the date, the model
// and effort, per strategy the score and the input tokens per question, and the number of live requests
// the run spent. It refuses to run on a working tree with uncommitted changes (other than the history
// file itself), because the row would name a commit that is not what ran; `--allow-dirty` runs anyway
// and marks the row `dirty`. Without `--live` the scripted oracle model is used and the row is printed,
// not written: a check of the pipeline that spends nothing.
//
// `--check` compares the latest row with the one before it and exits 1 when a strategy's score dropped
// by more than `--margin` questions (default 2), 2 when there is nothing to compare (fewer than two rows,
// or rows of another model, effort or session), and 0 otherwise. README.md says why the margin is two.
//
// Every live request spends the project owner's ChatGPT plan allowance; `--max-requests` (default 30)
// is a hard cap counted on every call, retries included. Nothing here prints, logs or writes a token or
// a header, and the history file holds numbers only, never session content.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Report } from "./evaluate.ts"
import type { StrategyName } from "./strategies.ts"

export const HISTORY_FILE = join(import.meta.dir, "history.jsonl")
/** The strategies that matter: the ceiling and the product. */
export const DEFAULT_STRATEGIES: readonly StrategyName[] = ["full", "engine"]
export const DEFAULT_MAX_REQUESTS = 30
/** A drop of more than this many questions fails `--check`. See README.md. */
export const DEFAULT_MARGIN = 2

export interface StrategyRow {
  /** Share of questions answered correctly. */
  readonly recall: number
  readonly pass: number
  readonly total: number
  /** Mean measured input tokens of a question's first request; `null` when the model reported none. */
  readonly tokensPerQuestion: number | null
  readonly requests: number
}

export interface HistoryRow {
  readonly v: 1
  readonly commit: string
  /** Whether the working tree had uncommitted changes (only with `--allow-dirty`). */
  readonly dirty: boolean
  readonly date: string
  readonly model: string
  readonly effort: string
  readonly session: { readonly seed: number; readonly tokens: number; readonly questions: number }
  readonly strategies: Readonly<Partial<Record<StrategyName, StrategyRow>>>
  /** Model calls the run made, counted at the model function (retries included): live requests, for a recorded row. */
  readonly requests: number
}

export interface RunSettings {
  readonly live: boolean
  readonly strategies: readonly StrategyName[]
  readonly seed: number
  readonly tokens: number
  readonly questions: number
  readonly maxRequests: number
}

/** Runs the evaluation once. The real one is `evaluationRunner`; tests pass a fake. */
export type Runner = (settings: RunSettings) => Promise<{ readonly report: Report; readonly requests: number }>

export interface Git {
  readonly head: () => string
  /** Paths with uncommitted changes, as `git status --porcelain` names them. */
  readonly changes: () => readonly string[]
}

export interface TrackDeps {
  readonly runner: Runner
  readonly git: Git
  readonly historyPath: string
  readonly now: () => Date
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

/** The most requests one run may make, before retries: what the cap is weighed against. */
export function plannedRequests(strategies: readonly StrategyName[], questions: number): number {
  const per: Record<StrategyName, number> = { full: questions, summary: questions, checkpoint: questions, "checkpoint+tools": 2 * questions, engine: 2 + 3 * questions }
  const simulated = strategies.some((name) => name === "summary" || name === "checkpoint" || name === "checkpoint+tools") ? 2 : 0
  // One judge request when an answer needs judging (decisions and the distractor), which the default session has.
  return simulated + strategies.reduce((sum, name) => sum + per[name], 0) + 1
}

export function rowFrom(report: Report, meta: { readonly commit: string; readonly dirty: boolean; readonly date: string; readonly requests: number; readonly tokens: number }): HistoryRow {
  return {
    v: 1,
    commit: meta.commit,
    dirty: meta.dirty,
    date: meta.date,
    model: report.model,
    effort: report.effort,
    session: { seed: report.session.seed, tokens: meta.tokens, questions: report.session.facts },
    strategies: Object.fromEntries(
      report.strategies.map((strategy) => [
        strategy.name,
        {
          recall: strategy.recall,
          pass: strategy.answers.filter((answer) => answer.pass).length,
          total: strategy.answers.length,
          tokensPerQuestion: strategy.meanInputTokens,
          requests: strategy.requests,
        },
      ]),
    ),
    requests: meta.requests,
  }
}

export function readHistory(path: string): HistoryRow[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const row = JSON.parse(line) as HistoryRow
      if (row.v !== 1) throw new Error(`${path}:${index + 1}: unknown row version ${String(row.v)}`)
      return row
    })
}

export function appendRow(path: string, row: HistoryRow): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`)
}

export type CheckResult =
  | { readonly status: "ok"; readonly lines: readonly string[] }
  | { readonly status: "drop"; readonly lines: readonly string[] }
  | { readonly status: "incomparable"; readonly lines: readonly string[] }

/** Compares the latest row with the one before it. A drop of more than `margin` questions in any strategy both rows have is a `drop`. */
export function checkHistory(rows: readonly HistoryRow[], margin = DEFAULT_MARGIN): CheckResult {
  if (rows.length < 2) return { status: "incomparable", lines: [`${rows.length} row(s) in the history: nothing to compare yet`] }
  const latest = rows.at(-1)!
  const previous = rows.at(-2)!
  const what = (row: HistoryRow) => `${row.model}/${row.effort}, seed ${row.session.seed}, ${row.session.tokens} tokens, ${row.session.questions} questions`
  if (what(latest) !== what(previous))
    return { status: "incomparable", lines: [`the latest row (${what(latest)}) and the one before it (${what(previous)}) measured different things`] }
  const shared = (Object.keys(latest.strategies) as StrategyName[]).filter((name) => previous.strategies[name] !== undefined)
  if (shared.length === 0) return { status: "incomparable", lines: ["the latest row and the one before it have no strategy in common"] }
  const lines: string[] = [`${short(previous.commit)} (${previous.date.slice(0, 10)}) -> ${short(latest.commit)} (${latest.date.slice(0, 10)}), margin ${margin} question(s)`]
  let dropped = false
  for (const name of shared) {
    const before = previous.strategies[name]!
    const after = latest.strategies[name]!
    const drop = before.pass - after.pass
    const bad = drop > margin
    dropped ||= bad
    const tokens =
      before.tokensPerQuestion === null || after.tokensPerQuestion === null ? "" : `, tokens per question ${before.tokensPerQuestion} -> ${after.tokensPerQuestion}`
    lines.push(`  ${name}: ${before.pass}/${before.total} -> ${after.pass}/${after.total}${tokens}${bad ? `  DROP of ${drop}, more than ${margin}` : ""}`)
  }
  return { status: dropped ? "drop" : "ok", lines }
}

function short(commit: string) {
  return commit.slice(0, 10)
}

const HELP = `usage: bun evals/recall/track.ts --live [--strategies full,engine] [--max-requests N] [--allow-dirty] [--history FILE]
       bun evals/recall/track.ts --check [--margin N] [--history FILE]`

/** The command. Returns the exit code. */
export async function main(argv: readonly string[], deps: TrackDeps): Promise<number> {
  const flag = (name: string) => argv.includes(`--${name}`)
  const value = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)
  const number = (name: string, fallback: number) => {
    const raw = value(name)
    const parsed = raw === undefined ? fallback : Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} takes a number; got ${raw}`)
    return parsed
  }
  if (flag("help")) {
    deps.out(HELP)
    return 0
  }
  const historyPath = value("history") ?? deps.historyPath
  if (flag("check")) {
    const result = checkHistory(readHistory(historyPath), number("margin", DEFAULT_MARGIN))
    for (const line of result.lines) deps.out(line)
    return result.status === "ok" ? 0 : result.status === "drop" ? 1 : 2
  }

  const live = flag("live")
  const strategies = (value("strategies")?.split(",") ?? [...DEFAULT_STRATEGIES]) as StrategyName[]
  const known = ["full", "summary", "checkpoint", "checkpoint+tools", "engine"]
  for (const name of strategies) if (!known.includes(name)) throw new Error(`no strategy named ${name}; there are ${known.join(", ")}`)
  const settings: RunSettings = {
    live,
    strategies,
    seed: number("seed", 7),
    tokens: number("tokens", 40_000),
    questions: number("questions", 12),
    maxRequests: number("max-requests", DEFAULT_MAX_REQUESTS),
  }
  const changes = deps.git.changes().filter((path) => !path.endsWith("evals/recall/history.jsonl"))
  if (changes.length > 0 && !flag("allow-dirty")) {
    deps.err(`the working tree has uncommitted changes (${changes.slice(0, 5).join(", ")}${changes.length > 5 ? ", ..." : ""}): commit them, or pass --allow-dirty to record a row marked dirty`)
    return 1
  }
  const planned = plannedRequests(strategies, settings.questions)
  deps.err(
    `strategies ${strategies.join(", ")}: at most ${planned} requests before retries; the cap is ${settings.maxRequests}${live && planned > settings.maxRequests ? " (a run that needs more stops at the cap and records nothing)" : ""}`,
  )
  const commit = deps.git.head()
  const { report, requests } = await deps.runner(settings)
  const row = rowFrom(report, { commit, dirty: changes.length > 0, date: deps.now().toISOString(), requests, tokens: settings.tokens })
  deps.out(JSON.stringify(row))
  if (!live) {
    deps.err("scripted model: the row is not written (pass --live to record one)")
    return 0
  }
  appendRow(historyPath, row)
  deps.err(`appended to ${historyPath}; ${requests} live request(s) spent`)
  return 0
}

/** The evaluation itself, as `run.ts` runs it, with the request count kept. Imported lazily, so tests load none of it. */
export const evaluationRunner: Runner = async (settings) => {
  const { evaluate } = await import("./evaluate.ts")
  const { oracleModel } = await import("./fake.ts")
  const { generateSession } = await import("./generate.ts")
  const { LIVE_EFFORT, LIVE_MODEL, capped, liveModel, retryOnce } = await import("./model.ts")
  const { compact, needsSummary } = await import("./strategies.ts")
  const session = generateSession({ seed: settings.seed, tokens: settings.tokens, facts: settings.questions })
  const counted = capped(settings.live ? await liveModel() : oracleModel(session), settings.maxRequests)
  const model = settings.live ? retryOnce(counted) : counted
  const cacheKey = `recall-${crypto.randomUUID()}`
  const compaction = settings.strategies.some(needsSummary) ? await compact(session, model, cacheKey) : null
  const report = await evaluate({
    session,
    compaction,
    model,
    strategies: settings.strategies,
    cacheKey,
    date: new Date().toISOString().slice(0, 10),
    live: settings.live,
    modelName: settings.live ? LIVE_MODEL : "oracle fake",
    effort: settings.live ? LIVE_EFFORT : "-",
  })
  return { report, requests: counted.used() }
}

export const realGit: Git = {
  head: () => git(["rev-parse", "HEAD"]).trim(),
  changes: () =>
    git(["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3)),
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2), {
    runner: evaluationRunner,
    git: realGit,
    historyPath: HISTORY_FILE,
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
  process.exit(code)
}
