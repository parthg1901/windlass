/**
 * The recall history: what a run appends, when it refuses, and what `--check`
 * says, with a fake runner and a fake git. Nothing here calls a model.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Report, StrategyResult } from "./evaluate.ts"
import { type HistoryRow, type Runner, type TrackDeps, checkHistory, evaluationRunner, main, plannedRequests, readHistory } from "./track.ts"

const directory = mkdtempSync(join(tmpdir(), "recall-track-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
let files = 0
const historyFile = () => join(directory, `history-${++files}.jsonl`)

/** A strategy result with `pass` of 12 right and the given tokens per question. */
function strategy(name: StrategyResult["name"], pass: number, tokens: number | null, requests = 12): StrategyResult {
  const answers = Array.from({ length: 12 }, (_, index) => ({ pass: index < pass }) as StrategyResult["answers"][number])
  return { name, answers, recall: pass / 12, meanInputTokens: tokens, requests } as unknown as StrategyResult
}

function report(strategies: readonly StrategyResult[], model = "gpt-test"): Report {
  return { model, effort: "low", live: true, session: { seed: 7, facts: 12 }, strategies } as unknown as Report
}

/** Runs the command with fakes; returns the exit code, what it printed and what the runner was asked. */
async function run(argv: string[], options: { report?: Report; requests?: number; changes?: string[]; history?: string; head?: string } = {}) {
  const out: string[] = []
  const err: string[] = []
  const asked: Parameters<Runner>[0][] = []
  const deps: TrackDeps = {
    runner: async (settings) => {
      asked.push(settings)
      return { report: options.report ?? report([strategy("full", 12, 37_000), strategy("engine", 11, 6_500, 15)]), requests: options.requests ?? 28 }
    },
    git: { head: () => options.head ?? "a".repeat(40), changes: () => options.changes ?? [] },
    historyPath: options.history ?? historyFile(),
    now: () => new Date("2026-11-12T12:00:00Z"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  }
  const code = await main(argv, deps)
  return { code, out, err, asked, history: deps.historyPath }
}

const row = (commit: string, pass: Record<string, number>, overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  v: 1,
  commit,
  dirty: false,
  date: "2026-11-12T12:00:00.000Z",
  model: "gpt-test",
  effort: "low",
  session: { seed: 7, tokens: 40_000, questions: 12 },
  strategies: Object.fromEntries(Object.entries(pass).map(([name, value]) => [name, { recall: value / 12, pass: value, total: 12, tokensPerQuestion: 6_000, requests: 12 }])),
  requests: 28,
  ...overrides,
})

describe("recording a run", () => {
  test("a live run appends one row: the commit, the date, the model, per strategy the score and the tokens per question, and the requests", async () => {
    const result = await run(["--live"])
    expect(result.code).toBe(0)
    expect(result.asked).toEqual([{ live: true, strategies: ["full", "engine"], seed: 7, tokens: 40_000, questions: 12, maxRequests: 30 }])
    const rows = readHistory(result.history)
    expect(rows).toEqual([
      {
        v: 1,
        commit: "a".repeat(40),
        dirty: false,
        date: "2026-11-12T12:00:00.000Z",
        model: "gpt-test",
        effort: "low",
        session: { seed: 7, tokens: 40_000, questions: 12 },
        strategies: {
          full: { recall: 1, pass: 12, total: 12, tokensPerQuestion: 37_000, requests: 12 },
          engine: { recall: 11 / 12, pass: 11, total: 12, tokensPerQuestion: 6_500, requests: 15 },
        },
        requests: 28,
      },
    ])
    // A second run appends, it does not rewrite.
    await run(["--live"], { history: result.history, head: "b".repeat(40) })
    expect(readHistory(result.history).map((entry) => entry.commit)).toEqual(["a".repeat(40), "b".repeat(40)])
    expect(readFileSync(result.history, "utf8").split("\n").filter(Boolean)).toHaveLength(2)
  })

  test("refuses a dirty tree, except the history file itself; --allow-dirty records the row marked dirty", async () => {
    const refused = await run(["--live"], { changes: ["packages/core/src/engine/engine.ts"] })
    expect(refused.code).toBe(1)
    expect(refused.asked).toEqual([])
    expect(refused.err.join("\n")).toContain("uncommitted changes (packages/core/src/engine/engine.ts)")
    expect(readHistory(refused.history)).toEqual([])

    const ownFile = await run(["--live"], { changes: ["evals/recall/history.jsonl"] })
    expect(ownFile.code).toBe(0)
    expect(readHistory(ownFile.history)[0]!.dirty).toBe(false)

    const allowed = await run(["--live", "--allow-dirty"], { changes: ["a.ts"] })
    expect(allowed.code).toBe(0)
    expect(readHistory(allowed.history)[0]!.dirty).toBe(true)
  })

  test("without --live the row is printed and not written; options reach the runner", async () => {
    const result = await run(["--strategies", "engine", "--max-requests", "20", "--questions", "6"])
    expect(result.code).toBe(0)
    expect(result.asked[0]).toMatchObject({ live: false, strategies: ["engine"], maxRequests: 20, questions: 6 })
    expect(readHistory(result.history)).toEqual([])
    expect(JSON.parse(result.out[0]!).requests).toBe(28)
    await expect(run(["--strategies", "nope"])).rejects.toThrow("no strategy named nope")
  })

  test("the plan: full and engine may need 51 requests before retries, engine alone 39, full alone 13", () => {
    expect(plannedRequests(["full", "engine"], 12)).toBe(51)
    expect(plannedRequests(["engine"], 12)).toBe(39)
    expect(plannedRequests(["full"], 12)).toBe(13)
    expect(plannedRequests(["full", "summary", "checkpoint", "checkpoint+tools", "engine"], 12)).toBe(2 + 12 + 12 + 12 + 24 + 38 + 1)
  })
})

describe("--check", () => {
  const write = (rows: readonly HistoryRow[]) => {
    const path = historyFile()
    writeFileSync(path, rows.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
    return path
  }

  test("passes when nothing dropped by more than the margin, fails on a larger drop", async () => {
    expect(checkHistory([row("a", { full: 12, engine: 12 }), row("b", { full: 12, engine: 10 })]).status).toBe("ok")
    const drop = checkHistory([row("a", { full: 12, engine: 12 }), row("b", { full: 12, engine: 9 })])
    expect(drop.status).toBe("drop")
    expect(drop.lines.join("\n")).toContain("engine: 12/12 -> 9/12, tokens per question 6000 -> 6000  DROP of 3, more than 2")
    // A rise is fine; the margin can be set.
    expect(checkHistory([row("a", { engine: 8 }), row("b", { engine: 12 })]).status).toBe("ok")
    expect(checkHistory([row("a", { engine: 12 }), row("b", { engine: 11 })], 0).status).toBe("drop")

    expect((await run(["--check"], { history: write([row("a", { engine: 12 }), row("b", { engine: 9 })]) })).code).toBe(1)
    expect((await run(["--check"], { history: write([row("a", { engine: 12 }), row("b", { engine: 9 })]) })).asked).toEqual([])
    expect((await run(["--check", "--margin", "3"], { history: write([row("a", { engine: 12 }), row("b", { engine: 9 })]) })).code).toBe(0)
    expect((await run(["--check"], { history: write([row("a", { engine: 12 }), row("b", { engine: 11 })]) })).code).toBe(0)
  })

  test("compares only the latest row with the one before it", () => {
    // An old drop does not fail the check of a later pair.
    expect(checkHistory([row("a", { engine: 12 }), row("b", { engine: 6 }), row("c", { engine: 7 })]).status).toBe("ok")
  })

  test("says there is nothing to compare: fewer than two rows, another model or session, no strategy in common", async () => {
    expect(checkHistory([]).status).toBe("incomparable")
    expect(checkHistory([row("a", { engine: 12 })]).status).toBe("incomparable")
    expect(checkHistory([row("a", { engine: 12 }), row("b", { engine: 12 }, { model: "other" })]).status).toBe("incomparable")
    expect(checkHistory([row("a", { engine: 12 }), row("b", { engine: 12 }, { session: { seed: 8, tokens: 40_000, questions: 12 } })]).status).toBe("incomparable")
    expect(checkHistory([row("a", { full: 12 }), row("b", { engine: 12 })]).status).toBe("incomparable")
    expect((await run(["--check"], { history: write([row("a", { engine: 12 })]) })).code).toBe(2)
    expect((await run(["--check"], { history: historyFile() })).code).toBe(2)
  })
})

test("the real runner with the scripted oracle model gives a report the row is made from", async () => {
  const { report: result, requests } = await evaluationRunner({ live: false, strategies: ["full"], seed: 7, tokens: 8_000, questions: 4, maxRequests: 30 })
  expect(result.strategies.map((entry) => entry.name)).toEqual(["full"])
  expect(result.strategies[0]!.answers).toHaveLength(4)
  expect(requests).toBeGreaterThanOrEqual(4)
})
