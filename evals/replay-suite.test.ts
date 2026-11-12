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
import { FakeProvider, type ScriptedResponse, script } from "../packages/core/src/testing/fake-provider.ts"
import { describeChange, formatSuite, readRuns, runReplaySuite } from "./replay-suite.ts"

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
        // task-a: unchanged twice (once the model itself edits differently), then with the change (it edits differently, and finishes in its copy).
        ...responsesFromTape(a),
        ...responsesFromTape(a, otherWrite),
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
        grade: async (task, workspace) => {
          graded.push(task)
          const content = readFileSync(join(workspace, "a.txt"), "utf8")
          return { pass: content === "other\n", message: content.trim() }
        },
      })
      expect(provider.remaining).toBe(0)
      expect(report.rows.map((row) => [row.task, row.kind, row.status, row.left === null ? null : [row.left.step, row.left.tool, row.left.kind], row.graded?.pass ?? null])).toEqual([
        ["task-a", "noise", "identical", null, null],
        ["task-a", "noise", "diverged", [2, "write", "arguments_differ"], null],
        ["task-a", "change", "diverged", [2, "write", "arguments_differ"], true],
        ["task-b", "noise", "identical", null, null],
        ["task-b", "noise", "identical", null, null],
        ["task-b", "change", "identical", null, null],
      ])
      // Only the replay that left its recording has a workspace of its own to grade.
      expect(graded).toEqual(["task-a"])
      expect(report.tasks).toEqual([
        {
          task: "task-a",
          runs: 1,
          change: { replays: 1, onTape: 0, left: 1, other: 0, where: ["step 2 write (arguments differ)"], novel: 0 },
          noise: { replays: 2, onTape: 1, left: 1, other: 0, where: ["step 2 write (arguments differ)"] },
          graded: { diverged: 1, passed: 1, recordedPassed: 1 },
        },
        { task: "task-b", runs: 1, change: { replays: 1, onTape: 1, left: 0, other: 0, where: [], novel: 0 }, noise: { replays: 2, onTape: 2, left: 0, other: 0, where: [] }, graded: null },
      ])
      expect(report.totals).toMatchObject({ runs: 2, skipped: 1, change: { replays: 2, onTape: 1, left: 1, other: 0, novel: 0 }, noise: { replays: 4, onTape: 3, left: 1, other: 0 }, requests: 14 })
      const table = formatSuite(report)
      expect(table).toContain("change: the system prompt   policy: execute")
      expect(table).toMatch(/task-a\s+1\s+0\/1\s+1\/1\s+0\/1\s+step 2 write \(arguments differ\)\s+1\/2\s+step 2 write \(arguments differ\)\s+1\/1\s+1\/1/)
      expect(table).toMatch(/task-b\s+1\s+1\/1\s+0\/1\s+0\/0\s+-\s+0\/2\s+-\s+-\s+-/)
      expect(table).toContain("The change left the recording in 1 of 2 replays (50%); with nothing changed, 1 of 4 did (25%). By count the change is above the noise floor. And every place the change left a recording is a place where no change left it too")
      expect(table).toContain("(1 without a session, skipped)")
    } finally {
      await harness.close()
    }
  })

  test("says what a request changes, and that nothing can be read from a change without a noise floor", () => {
    expect(describeChange({})).toBe("nothing (every replay measures the noise floor)")
    expect(describeChange({ systemPrompt: "x", toolDescriptions: { shell: "y" }, model: "m", effort: null, strict: true })).toBe("the system prompt, the description of shell, model m, effort default, strict matching")
    const empty = { replays: 0, onTape: 0, left: 0, other: 0 }
    const table = formatSuite({ results: "r", policy: "stop", change: "the system prompt", rows: [], tasks: [], totals: { runs: 0, skipped: 0, change: { ...empty, novel: 0 }, noise: empty, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 } })
    expect(table).toContain("The noise floor was not measured (--noise 0), so nothing can be read into the change yet.")
  })
})
