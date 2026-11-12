// The nightly run, end to end with `--dry-run`: the tasks with the scripted stand-in agent (whose sessions are
// exported and classified for real), the gate, the recall tracker with the oracle reader, and the summary. Then the
// exit codes for a pass, a gate failure, a recall drop and both, the lock, and what a run that is killed leaves.
// Nothing here calls a model.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildBaseline, loadResults } from "./baseline.ts"
import { prefixlensDir } from "./classify.ts"
import { EXIT, LOCK_FILE, type NightlySummary, STAGING_PREFIX, acquireLock, countRequests, parseNightlyArgs } from "./nightly.ts"
import type { HistoryRow } from "./recall/track.ts"

const REPO = resolve(import.meta.dir, "..")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lh-nightly-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const TASKS = ["answer-question", "config-edits", "large-log"]
const hasPrefixlens = existsSync(join(prefixlensDir(), "src", "cli.ts"))

/** Runs the nightly as a user would, with a time limit; returns its exit code and output. */
async function nightly(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "evals/nightly.ts", "--dry-run", ...args], { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

/** The published summaries under a root, oldest first. */
const published = (root: string) =>
  readdirSync(root)
    .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}Z/.test(name))
    .sort()
const summaryOf = (root: string, name = published(root).at(-1)!) => JSON.parse(readFileSync(join(root, name, "summary.json"), "utf8")) as NightlySummary

/** An oracle row, as the tracker writes it in a dry run, to seed a history with. */
const oracleRow = (strategies: HistoryRow["strategies"]): HistoryRow => ({
  v: 1,
  commit: "0".repeat(40),
  dirty: false,
  date: "2026-11-11T03:00:00.000Z",
  model: "oracle fake",
  effort: "-",
  session: { seed: 7, tokens: 40_000, questions: 12 },
  strategies,
  requests: 26,
})
const seeded = (name: string, rows: readonly HistoryRow[]) => {
  const path = join(scratch, `${name}.jsonl`)
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""))
  return path
}
const full = (pass: number) => ({ recall: pass / 12, pass, total: 12, tokensPerQuestion: 100, requests: 25 })

let baselineFile = ""
let failingBaselineFile = ""

describe("the whole flow, dry", () => {
  test("against the committed baseline (another configuration) it is inconclusive, exit 4; the summary says why, and holds everything", async () => {
    const root = join(scratch, "first")
    const result = await nightly(["--root", root, "--tasks", TASKS.join(","), "--recall-history", seeded("first", [oracleRow({ engine: full(12) })])])
    expect(result.code).toBe(EXIT.inconclusive)
    const [name] = published(root)
    expect(name).toBeDefined()
    const directory = join(root, name!)
    for (const file of ["summary.json", "summary.md", "gate.json", "gate.txt", "recall.log", "tasks/results.json"]) expect(existsSync(join(directory, file))).toBe(true)
    expect(readdirSync(root).filter((entry) => entry.startsWith(STAGING_PREFIX))).toEqual([])
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
    expect(readFileSync(join(root, "latest", "summary.json"), "utf8")).toBe(readFileSync(join(directory, "summary.json"), "utf8"))
    const summary = summaryOf(root)
    expect(summary).toMatchObject({ v: 1, dryRun: true, verdict: "inconclusive", exitCode: EXIT.inconclusive, configuration: { model: null, effort: null, repeat: 3, tasks: 3 } })
    expect(summary.commit.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(summary.gate!.verdict).toBe("inconclusive")
    expect(summary.gate!.inconclusive.join("\n")).toContain("not comparable")
    expect(summary.tasks.map((line) => [line.task, line.runs])).toEqual(TASKS.map((task) => [task, 3]))
    expect(summary.recall).toMatchObject({ status: "ok", strategies: { engine: { pass: 12, total: 12, previous: { pass: 12, total: 12 } } } })
    expect(summary.requests.live).toBe(false)
    expect(summary.requests.tasks).toBeGreaterThan(0)
    expect(summary.requests.total).toBe(summary.requests.tasks + summary.requests.recall)
    expect(summary.tokens!.input).toBeGreaterThan(0)
    expect(Object.keys(summary.phasesMs)).toEqual(["tasks", "gate", "recall"])
    if (hasPrefixlens) expect(summary.cache).toMatchObject({ classified: 9, runs: 9, avoidable: 0, usageOnly: 0 })
    // The raw results name their files where they are now, not where they were written.
    const results = readFileSync(join(directory, "tasks", "results.json"), "utf8")
    expect(results).not.toContain(STAGING_PREFIX)
    expect(results).toContain(directory)
    const markdown = readFileSync(join(directory, "summary.md"), "utf8")
    expect(markdown).toContain("INCONCLUSIVE (exit 4) (dry run, no model)")
    expect(markdown).toContain("| answer-question | 0/3 |")
    expect(markdown).toContain("scripted model requests")
    expect(result.stdout.trimEnd()).toBe(markdown.trimEnd())

    // The baselines the next tests compare with: this run's own numbers, and the same with every run passing.
    const loaded = await loadResults([join(directory, "tasks")])
    const baseline = buildBaseline(loaded, { note: "test" })
    baselineFile = join(scratch, "baseline.json")
    writeFileSync(baselineFile, JSON.stringify(baseline))
    const perfect = { ...baseline, tasks: Object.fromEntries(Object.entries(baseline.tasks).map(([task, stats]) => [task, { ...stats, passes: stats.runs, passRate: 1 }])) }
    failingBaselineFile = join(scratch, "baseline-perfect.json")
    writeFileSync(failingBaselineFile, JSON.stringify(perfect))
  }, 240_000)

  test.skipIf(!hasPrefixlens)("a run that matches its baseline and keeps its recall passes: exit 0", async () => {
    const root = join(scratch, "pass")
    const result = await nightly(["--root", root, "--tasks", TASKS.join(","), "--baseline", baselineFile, "--recall-history", seeded("pass", [oracleRow({ engine: full(12) })])])
    expect(result.code).toBe(EXIT.pass)
    const summary = summaryOf(root)
    expect(summary).toMatchObject({ verdict: "pass", exitCode: 0, errors: [], gate: { verdict: "pass", regressions: [], inconclusive: [] }, recall: { status: "ok" } })
    expect(summary.tasks[0]!.baseline).toEqual({ runs: 3, passes: 0, passRate: 0 })
    expect(readFileSync(join(root, published(root)[0]!, "summary.md"), "utf8")).toContain("PASS (exit 0)")
  }, 240_000)

  test("a gate failure: a task that always passed in the baseline fails now; exit 1, and the regression is named", async () => {
    const root = join(scratch, "gate")
    const result = await nightly(["--root", root, "--tasks", TASKS.join(","), "--baseline", failingBaselineFile, "--recall-history", seeded("gate", [oracleRow({ engine: full(12) })])])
    expect(result.code).toBe(EXIT.gate)
    const summary = summaryOf(root)
    expect(summary.verdict).toBe("fail")
    expect(summary.gate!.verdict).toBe("fail")
    expect(summary.gate!.regressions.some((line) => line.startsWith("REGRESSION pass-rate answer-question"))).toBe(true)
    expect(readFileSync(join(root, published(root)[0]!, "summary.md"), "utf8")).toContain("## Regressions")
  }, 240_000)

  test("a recall drop beyond the margin: exit 2; with a gate failure as well: exit 3", async () => {
    // The oracle answers nothing from a summary alone, so a history in which it once had 12 of 12 shows a drop.
    const drop = await nightly(["--root", join(scratch, "drop"), "--tasks", "answer-question", "--repeat", "1", "--recall-strategies", "summary", "--recall-history", seeded("drop", [oracleRow({ summary: full(12) })])])
    expect(drop.code).toBe(EXIT.recall)
    const summary = summaryOf(join(scratch, "drop"))
    expect(summary.recall).toMatchObject({ status: "drop", strategies: { summary: { pass: 0, total: 12, previous: { pass: 12, total: 12 } } } })
    expect(summary.recall.lines.join("\n")).toContain("DROP of 12")
    expect(readFileSync(join(scratch, "drop", published(join(scratch, "drop"))[0]!, "summary.md"), "utf8")).toContain("- summary: 0/12 (previous 12/12) DROP")

    const both = await nightly(["--root", join(scratch, "both"), "--tasks", "answer-question", "--baseline", failingBaselineFile, "--recall-strategies", "summary", "--recall-history", seeded("both", [oracleRow({ summary: full(12) })])])
    expect(both.code).toBe(EXIT.both)
    expect(summaryOf(join(scratch, "both")).verdict).toBe("fail")
  }, 240_000)
})

describe("the lock", () => {
  test("a run started while another holds the lock does nothing and exits 5", async () => {
    const root = join(scratch, "locked")
    mkdirSync(root, { recursive: true })
    // This test process is alive, so its lock is not stale.
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: "2026-11-12T03:00:00.000Z" }))
    const result = await nightly(["--root", root, "--tasks", "answer-question", "--repeat", "1"])
    expect(result.code).toBe(EXIT.locked)
    expect(result.stderr).toContain(`process ${process.pid}`)
    expect(readdirSync(root)).toEqual([LOCK_FILE])
    expect(JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")).pid).toBe(process.pid)
  }, 60_000)

  test("acquire and release; a second taker is refused; a lock whose process is gone is taken over", () => {
    const path = join(scratch, "unit.lock")
    const first = acquireLock(path)
    expect("release" in first).toBe(true)
    expect(acquireLock(path)).toEqual({ heldBy: process.pid })
    if ("release" in first) first.release()
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345 }))
    const taken = acquireLock(path)
    expect("release" in taken).toBe(true)
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid)
    if ("release" in taken) taken.release()
  })
})

describe("a run that is killed", () => {
  test("leaves no summary directory, only its hidden staging directory and a stale lock; the next run takes over and cleans up", async () => {
    const root = join(scratch, "killed")
    // The stand-in hangs in its first step; the run is killed while the tasks are running.
    const child = spawn("bun", ["evals/nightly.ts", "--dry-run", "--root", root, "--tasks", "answer-question", "--repeat", "1", "--timeout", "120"], {
      cwd: REPO,
      env: { ...process.env, STAND_IN_MODE: "hang" },
      detached: true,
      stdio: "ignore",
    })
    try {
      for (let waited = 0; !(existsSync(root) && readdirSync(root).some((name) => name.startsWith(STAGING_PREFIX) && existsSync(join(root, name, "tasks", "runs", "answer-question-1.jsonl")))); waited += 50) {
        if (waited > 60_000) throw new Error("the run never started its tasks")
        await Bun.sleep(50)
      }
      await Bun.sleep(300)
    } finally {
      // The whole process group: the nightly, the runner's agent and anything it started.
      process.kill(-child.pid!, "SIGKILL")
    }
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(null) : child.once("exit", resolve)))
    expect(published(root)).toEqual([])
    expect(existsSync(join(root, "latest"))).toBe(false)
    expect(readdirSync(root).filter((name) => name.startsWith(STAGING_PREFIX))).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")).pid).toBe(child.pid)

    const next = await nightly(["--root", root, "--tasks", "answer-question", "--repeat", "1"])
    expect(next.code).toBe(EXIT.inconclusive)
    expect(published(root)).toHaveLength(1)
    expect(readdirSync(root).filter((name) => name.startsWith(STAGING_PREFIX))).toEqual([])
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
  }, 120_000)
})

describe("pieces", () => {
  test("model requests counted from a stream: steps with retries, summary calls with their repairs and retries, and a child's", () => {
    const line = (item: unknown) => JSON.stringify(item)
    const stream = [
      line({ type: "step.started", data: { messageId: "m1", attempt: 1 } }),
      line({ type: "step.started", data: { messageId: "m1", attempt: 2 } }),
      line({ type: "retry.scheduled", data: { messageId: "m1", attempt: 2 } }),
      line({ type: "compaction.started", data: { messageId: "c1" } }),
      line({ type: "retry.scheduled", data: { messageId: "c1", attempt: 2 } }),
      line({ type: "compaction.repair_requested", data: { messageId: "c1", attempt: 3 } }),
      line({ type: "child.event", event: { type: "step.started", data: { messageId: "x", attempt: 1 } } }),
      "not json",
      "",
    ].join("\n")
    expect(countRequests(stream)).toBe(6)
  })

  test("arguments: defaults from the baseline's configuration, a dry run gives no model, the root must be outside the repository", () => {
    const real = parseNightlyArgs(["--root", join(scratch, "r")], {})
    if (typeof real === "string") throw new Error(real)
    expect(real).toMatchObject({ dryRun: false, repeat: 3, concurrency: 1, recallStrategies: ["engine"], recallMargin: 2, recallHistory: join(scratch, "r", "recall-history.jsonl") })
    expect(real.model).toBeString()
    const dry = parseNightlyArgs(["--dry-run", "--root", join(scratch, "r"), "--tasks", "a,b"], {})
    expect(dry).toMatchObject({ dryRun: true, model: null, effort: null, tasks: ["a", "b"], recallHistory: join(scratch, "r", "recall-history.dry-run.jsonl") })
    expect(parseNightlyArgs(["--root", join(REPO, "evals", "out")], {})).toContain("outside the repository")
    expect(parseNightlyArgs(["--repeat", "0", "--root", scratch], {})).toContain("--repeat")
    expect(parseNightlyArgs(["--bogus"], {})).toContain("unknown argument")
    const defaulted = parseNightlyArgs([], { XDG_DATA_HOME: join(scratch, "xdg") })
    expect(typeof defaulted === "string" ? defaulted : defaulted.root).toStartWith(join(scratch, "xdg"))
  })
})
