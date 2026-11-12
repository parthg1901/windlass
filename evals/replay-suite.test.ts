/**
 * The replay suite on recordings made with a scripted model: the table it
 * prints, the noise floor next to every result, and the grading of a replay
 * that left its recording under `execute`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../packages/core/src/assembly.ts"
import { responsesFromTape } from "../packages/core/src/replay/fake.ts"
import { tapeFromEvents } from "../packages/core/src/replay/tape.ts"
import { exportSnapshot } from "../packages/core/src/snapshot/index.ts"
import { snapshotOfCopy } from "../scripts/replay.ts"
import { FakeProvider, type ScriptedResponse, script } from "../packages/core/src/testing/fake-provider.ts"
import { describeChange, fisherExact, formatSuite, readRuns, runReplaySuite, verdict } from "./replay-suite.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-replay-suite-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const call = (name: string, input: Record<string, string>) => script.toolCall("call_1", name, input)

async function recorded() {
  const provider = new FakeProvider()
  const harness = createHarness({ dataDir: join(root, "data"), provider, log: () => {}, engine: { approval: null, loadConfig: null, discover: () => [] } })
  const tapes = new Map<string, ReturnType<typeof tapeFromEvents>>()
  const runs = []
  for (const [task, responses] of Object.entries<ScriptedResponse[]>({
    "task-a": [[call("read", { path: "a.txt" })], [call("write", { path: "a.txt", content: "fixed\n" })], [script.text("Fixed a.")]],
    "task-b": [[call("read", { path: "a.txt" })], [script.text("Nothing to do.")]],
  })) {
    const directory = join(root, task)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "a.txt"), "broken\n")
    provider.enqueue(...responses)
    const session = harness.engine.createSession({ cwd: directory, settings: { model: "gpt-test", reasoningEffort: null } })
    session.send(`Do ${task}.`)
    await session.settled()
    tapes.set(task, tapeFromEvents(session.readEvents()))
    runs.push({ task, attempt: 1, pass: task === "task-a", metrics: { sessionId: session.id } })
    await session.close()
  }
  const results = join(root, "results")
  mkdirSync(results, { recursive: true })
  writeFileSync(join(results, "results.json"), JSON.stringify({ results: [...runs, { task: "task-c", attempt: 1, pass: false, metrics: { sessionId: null } }] }))
  return { provider, harness, tapes, results }
}

describe("the replay suite", () => {
  test("replays every recorded run with the change and without it, and reports where each left its recording next to the noise floor", async () => {
    const { provider, harness, tapes, results } = await recorded()
    try {
      const a = tapes.get("task-a")!
      const b = tapes.get("task-b")!
      const otherWrite = { 1: [call("write", { path: "a.txt", content: "other\n" })], 2: null }
      provider.enqueue(
        // task-a: unchanged twice (once the model itself edits differently and, under execute like the change, finishes in its copy),
        // then with the change (it edits differently, and finishes in its copy).
        ...responsesFromTape(a),
        ...responsesFromTape(a, otherWrite, [[script.text("Done.")]]),
        ...responsesFromTape(a, otherWrite, [[script.text("Done differently.")]]),
        // task-b: unchanged twice, then with the change: all as recorded.
        ...responsesFromTape(b),
        ...responsesFromTape(b),
        ...responsesFromTape(b),
      )
      const runs = await readRuns(results)
      expect(runs.map((run) => [run.task, run.pass, run.sessionId !== null])).toEqual([
        ["task-a", true, true],
        ["task-b", false, true],
        ["task-c", false, false],
      ])
      const graded: string[] = []
      const report = await runReplaySuite({
        engine: harness.engine,
        runs,
        request: { systemPrompt: "Changed.", policy: "execute" },
        results,
        cleanup: false,
        exportSnapshot: (workspace, id, into) => exportSnapshot(workspace, id, into, { dataDir: join(harness.dataDir, "snapshots") }),
        snapshotCopy: (copy, session) => snapshotOfCopy(copy, harness.dataDir, session),
        grade: async (task, workspace) => {
          graded.push(task)
          const content = readFileSync(join(workspace, "a.txt"), "utf8")
          return { pass: content === "other\n", message: content.trim() }
        },
      })
      expect(provider.remaining).toBe(0)
      expect(report.noisePolicy).toBe("execute")
      expect(report.rows.map((row) => [row.task, row.kind, row.status, row.left === null ? null : [row.left.step, row.left.tool, row.left.kind], row.graded?.pass ?? null])).toEqual([
        ["task-a", "noise", "identical", null, null],
        ["task-a", "noise", "diverged", [2, "write", "arguments_differ"], true],
        ["task-a", "change", "diverged", [2, "write", "arguments_differ"], true],
        ["task-b", "noise", "identical", null, null],
        ["task-b", "noise", "identical", null, null],
        ["task-b", "change", "identical", null, null],
      ])
      // The new measures: what each replay did and the files it ended with, against the recording.
      // The other content in a.txt is another side effect and other bytes, but the same file changed.
      expect(report.rows.map((row) => [row.effects?.same ?? null, row.effects?.first ?? null, row.lenient?.left ?? null, row.samePaths, row.sameWorkspace])).toEqual([
        [true, null, null, true, true],
        [false, 'act 1: write "a.txt" (act differs)', 'act 1: write "a.txt" (act differs)', true, false],
        [false, 'act 1: write "a.txt" (act differs)', 'act 1: write "a.txt" (act differs)', true, false],
        [true, null, null, true, true],
        [true, null, null, true, true],
        [true, null, null, true, true],
      ])
      // Every replay that left its recording has a workspace of its own to grade, unchanged ones too.
      expect(graded).toEqual(["task-a", "task-a"])
      expect(report.tasks[0]).toMatchObject({
        task: "task-a",
        change: { replays: 1, onTape: 0, left: 1, effectsDiffer: { yes: 1, of: 1 }, workspaceDiffers: { yes: 1, of: 1 }, passed: { yes: 1, of: 1 }, where: ["step 2 write (arguments differ)"], novel: 0 },
        noise: { replays: 2, onTape: 1, left: 1, effectsDiffer: { yes: 1, of: 2 }, lenientLeft: { yes: 1, of: 2 }, workspaceDiffers: { yes: 1, of: 2 }, passed: { yes: 2, of: 2 }, effectsWhere: ['act 1: write "a.txt" (act differs)'] },
        graded: { diverged: 1, passed: 1, recordedPassed: 1 },
      })
      expect(report.totals).toMatchObject({ runs: 2, skipped: 1, change: { replays: 2, onTape: 1, left: 1, other: 0, novel: 0 }, noise: { replays: 4, onTape: 3, left: 1, other: 0, effectsDiffer: { yes: 1, of: 4 } }, requests: 15 })
      const table = formatSuite(report)
      expect(table).toContain("change: the system prompt   policy: execute   unchanged replays: execute")
      // Per task a row for the unchanged replays and one for the changed: left, lenient, effects, paths, bytes, pass, new place.
      expect(table).toContain("task    runs  replays      left  lenient  effects  paths  bytes  pass  new place")
      expect(table).toMatch(/task-a\s+1\s+no change 2\s+1\/2\s+1\/2\s+1\/2\s+0\/2\s+1\/2\s+2\/2\n\s+change 1\s+1\/1\s+1\/1\s+1\/1\s+0\/1\s+1\/1\s+1\/1\s+0\/1\n/)
      expect(table).toMatch(/all\s+2\s+no change 4\s+1\/4\s+1\/4\s+1\/4\s+0\/4\s+1\/4\s+2\/4\n\s+change 2\s+1\/2/)
      expect(table).toContain('  no change acted first   act 1: write "a.txt" (act differs)')
      expect(table).toContain("- made other side effects than the recording: 1 of 2 with the change, 1 of 4 without; within what chance gives at these numbers (p = 1.00).")
      expect(table).toContain("Every place the change left a recording is a place where no change left it too")
      expect(table).toContain('At 2 and 4 replays only a large difference can be told from chance; "within chance" here does not mean the change does nothing.')
      expect(table).toContain("(1 without a session, skipped)")
    } finally {
      await harness.close()
    }
  })

  test("under stop the unchanged replays stop too, and a replay that stopped where it left has no side effects to compare", async () => {
    const { provider, harness, tapes, results } = await recorded()
    try {
      const a = tapes.get("task-a")!
      const b = tapes.get("task-b")!
      const otherWrite = { 1: [call("write", { path: "a.txt", content: "other\n" })], 2: null }
      provider.enqueue(...responsesFromTape(a, otherWrite), ...responsesFromTape(b))
      const report = await runReplaySuite({ engine: harness.engine, runs: await readRuns(results), request: { systemPrompt: "Changed." }, noise: 1, repeat: 0, results })
      expect(provider.remaining).toBe(0)
      expect(report.noisePolicy).toBe("stop")
      expect(report.rows.map((row) => [row.task, row.status, row.effects, row.lenient, row.sameWorkspace, row.graded])).toEqual([
        ["task-a", "diverged", null, null, null, null],
        ["task-b", "identical", { same: true, matched: 0, recordedActs: 0, replayedActs: 0, first: null }, { served: 1, mustRun: 0, left: null }, true, null],
      ])
      expect(report.totals.noise).toMatchObject({ left: 1, effectsDiffer: { yes: 0, of: 1 }, workspaceDiffers: { yes: 0, of: 1 } })
      expect(verdict(report).join("\n")).toContain("made other side effects than the recording: not measured on the changed replays (it needs --policy execute: a replay must reach its end).")
    } finally {
      await harness.close()
    }
  })

  test("says what a request changes, and that nothing can be read from a change without a noise floor", () => {
    expect(describeChange({})).toBe("nothing (every replay measures the noise floor)")
    expect(describeChange({ systemPrompt: "x", toolDescriptions: { shell: "y" }, model: "m", effort: null, strict: true })).toBe("the system prompt, the description of shell, model m, effort default, strict matching")
    const none = { yes: 0, of: 0 }
    const empty = { replays: 0, onTape: 0, left: 0, other: 0, effectsDiffer: none, lenientLeft: none, pathsDiffer: none, workspaceDiffers: none, passed: none }
    const table = formatSuite({ results: "r", policy: "stop", noisePolicy: "stop", change: "the system prompt", rows: [], tasks: [], totals: { runs: 0, skipped: 0, change: { ...empty, novel: 0 }, noise: empty, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 } })
    expect(table).toContain("The noise floor was not measured (--noise 0), so nothing can be read into the change yet.")
  })

  test("with nothing changed every replay is the noise floor, and a rate of none says how rare a rate it can rule out", () => {
    const of = (yes: number, count: number) => ({ yes, of: count })
    const noise = { replays: 20, onTape: 0, left: 20, other: 0, effectsDiffer: of(6, 20), lenientLeft: of(15, 20), pathsDiffer: of(0, 20), workspaceDiffers: of(4, 20), passed: of(19, 20) }
    const change = { replays: 0, onTape: 0, left: 0, other: 0, effectsDiffer: of(0, 0), lenientLeft: of(0, 0), pathsDiffer: of(0, 0), workspaceDiffers: of(0, 0), passed: of(0, 0), novel: 0 }
    const lines = verdict({ results: "r", policy: "execute", noisePolicy: "execute", change: describeChange({}), rows: [], tasks: [], totals: { runs: 5, skipped: 0, change, noise, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 } })
    expect(lines).toEqual([
      "Nothing was changed, so every replay measures the noise floor of these recordings on this model:",
      "- left the recording (the strict matcher: the old measure): 20 of 20 (100%)",
      "- would have left it under a lenient matcher without a copy: 15 of 20 (75%)",
      "- made other side effects than the recording: 6 of 20 (30%)",
      "- changed other files than the recording: 0 of 20 (the true rate is probably below 15%: with 20 replays nothing rarer can be seen)",
      "- ended with files not byte for byte the recording's: 4 of 20 (20%)",
      "A change is visible on a measure only where it moves that measure clearly above these rates.",
    ])
  })

  test("the exact test: an even split is chance, an extreme one at these sizes is not", () => {
    expect(fisherExact(1, 2, 1, 4)).toBeCloseTo(1, 6)
    expect(fisherExact(5, 5, 0, 10)).toBeCloseTo(1 / 3003, 6)
    expect(fisherExact(3, 5, 1, 10)).toBeCloseTo(0.0769, 3)
  })
})
