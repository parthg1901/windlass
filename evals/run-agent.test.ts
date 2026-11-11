// The agent runner, driven end to end with the scripted stand-in agent in place of the CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CallId, type EventData, type EventType, type MessageId, type SessionId, event } from "../packages/core/src/index.ts"
import { type RunOptions, computeMetrics, formatTable, parseRunnerArgs, runAgent } from "./run-agent.ts"
import { grade, prepareWorkspace } from "./run-check.ts"

const STAND_IN = ["bun", join(import.meta.dir, "testing", "stand-in-agent.ts")]
const scratch = { dir: "", tmp: "", previousTmp: process.env.TMPDIR }

beforeAll(async () => {
  scratch.dir = await mkdtemp(join(tmpdir(), "run-agent-test-"))
  // Every temporary directory the runner makes lands here, so the test can see that none is left behind.
  scratch.tmp = join(scratch.dir, "tmp")
  await Bun.write(join(scratch.tmp, ".keep"), "")
  process.env.TMPDIR = scratch.tmp
})

afterAll(async () => {
  process.env.TMPDIR = scratch.previousTmp
  await rm(scratch.dir, { recursive: true, force: true })
})

const runs = { count: 0 }
function run(mode: string, options: Partial<RunOptions> & { tasks: string[] }, env: Record<string, string> = {}) {
  runs.count += 1
  return runAgent({ cli: STAND_IN, out: join(scratch.dir, `out-${runs.count}`), graceSeconds: 5, ...options, env: { STAND_IN_MODE: mode, ...env } })
}

async function leftovers() {
  return (await readdir(scratch.tmp)).filter((name) => name.startsWith("lh-agent-") || name.startsWith("lh-eval-"))
}

describe("a solved task", () => {
  test("passes, with metrics read from the event stream", async () => {
    const report = await run("solve", { tasks: ["fix-failing-test"] })
    const result = report.results[0]!
    expect(result.pass).toBe(true)
    expect(result.reason).toStartWith("ok:")
    expect(result.status).toBe("passed")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.wallMs).toBeGreaterThan(0)
    const metrics = result.metrics
    expect(metrics.sessionId).toBe("ses_standin")
    expect(metrics.end).toBe("succeeded")
    expect(metrics.steps).toBe(2)
    expect(metrics.modelCalls).toBe(3)
    expect(metrics.toolCalls).toBe(1)
    expect(metrics.tools).toEqual({ shell: { calls: 1, success: 1, error: 0, not_started: 0, effect_unknown: 0, unsettled: 0 } })
    expect(metrics.retries).toBe(1)
    expect(metrics.retriesByKind).toEqual({ rate_limit: 1 })
    expect(metrics.tokens).toEqual({ input: 2600, cached: 1152, output: 120, reasoning: 0 })
    expect(metrics.cachedShare).toBeCloseTo(1152 / 2600)
    expect(metrics.perStep.map((step) => [step.input, step.cached])).toEqual([
      [1200, 0],
      [1400, 1152],
    ])
    expect(metrics.anomalies).toEqual([])
    expect(metrics.unknownEvents).toEqual({})

    const lines = (await Bun.file(result.eventsFile).text()).trim().split("\n")
    expect(JSON.parse(lines[0]!).type).toBe("session.created")
    expect(JSON.parse(lines.at(-1)!).type).toBe("execution.succeeded")
    const saved = await Bun.file(join(report.out, "results.json")).json()
    expect(saved.results[0].metrics.tokens.cached).toBe(1152)
    expect(report.totals).toMatchObject({ runs: 1, passed: 1, passRate: 1, totalTokens: 2720 })
    const table = formatTable(report)
    expect(table).toContain("fix-failing-test")
    expect(table).toContain("passed 1/1 (100%)")
    expect(result.workspace).toBeNull()
  }, 60_000)
})

test("a do-nothing run fails with the grader's reason", async () => {
  const report = await run("nothing", { tasks: ["answer-question"] })
  const result = report.results[0]!
  const { dir } = await prepareWorkspace("answer-question", join(scratch.dir, "pristine"))
  const expected = await grade("answer-question", dir)
  expect(result.pass).toBe(false)
  expect(result.status).toBe("failed")
  expect(result.reason).toBe(expected.message)
  expect(result.metrics.end).toBe("succeeded")
  expect(result.metrics.tools.shell?.success).toBe(1)
  expect(formatTable(report)).toContain(`answer-question#1: ${expected.message}`)
}, 60_000)

describe("time limit", () => {
  test("a hanging agent gets Ctrl-C at the timeout and is reported as interrupted", async () => {
    const report = await run("hang", { tasks: ["answer-question"], timeoutSeconds: 1 })
    const result = report.results[0]!
    expect(result.timedOut).toBe(true)
    expect(result.killed).toBe(false)
    expect(result.status).toBe("timeout")
    expect(result.exitCode).toBe(130)
    expect(result.wallMs).toBeGreaterThanOrEqual(1000)
    expect(result.wallMs).toBeLessThan(5000)
    expect(result.metrics.end).toBe("interrupted")
    expect(result.metrics.interruptReason).toBe("user")
    expect(result.metrics.errorClass).toBe("interrupted:user")
    expect(result.metrics.unknownEvents).toEqual({})
  }, 30_000)

  test("an agent that ignores Ctrl-C is killed after the grace period", async () => {
    const report = await run("stubborn", { tasks: ["answer-question"], timeoutSeconds: 1, graceSeconds: 1 })
    const result = report.results[0]!
    expect(result.timedOut).toBe(true)
    expect(result.killed).toBe(true)
    expect(result.status).toBe("killed")
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe("SIGKILL")
    expect(result.wallMs).toBeGreaterThanOrEqual(2000)
    expect(result.metrics.anomalies.map((anomaly) => anomaly.kind)).toContain("no-execution-end")
  }, 30_000)
})

test("a crashing agent is reported with its exit code", async () => {
  const report = await run("crash", { tasks: ["answer-question"] }, { STAND_IN_EXIT: "7" })
  const result = report.results[0]!
  expect(result.pass).toBe(false)
  expect(result.status).toBe("crashed")
  expect(result.exitCode).toBe(7)
  expect(result.metrics.end).toBeNull()
  expect(result.metrics.anomalies.map((anomaly) => anomaly.kind).sort()).toEqual(["no-execution-end", "unsettled-tool"])
  expect(await Bun.file(result.stderrFile).text()).toContain("simulated crash")
  expect(formatTable(report)).toMatch(/answer-question\s+1\s+crashed\s+7\s+none/)
}, 30_000)

describe("--repeat and --concurrency", () => {
  test("every task runs N times, rows come back in order", async () => {
    const report = await run("solve", { tasks: ["answer-question", "config-edits"], repeat: 2, concurrency: 2 })
    expect(report.results.map((result) => `${result.task}#${result.attempt}`)).toEqual(["answer-question#1", "answer-question#2", "config-edits#1", "config-edits#2"])
    expect(report.results.every((result) => result.pass)).toBe(true)
    expect(new Set(report.results.map((result) => result.eventsFile)).size).toBe(4)
    expect(report.totals.passRate).toBe(1)
  }, 120_000)

  test("runs overlap with --concurrency 2 and do not with 1", async () => {
    const timed = async (concurrency: number) => {
      const started = performance.now()
      await run("hang", { tasks: ["answer-question"], repeat: 2, concurrency, timeoutSeconds: 1 })
      return performance.now() - started
    }
    expect(await timed(2)).toBeLessThan(1900)
    expect(await timed(1)).toBeGreaterThanOrEqual(2000)
  }, 30_000)
})

describe("anomalies from a crafted event stream", () => {
  const sessionId = "ses_crafted" as SessionId
  const seq = { value: 0 }
  const line = <T extends EventType>(type: T, data: EventData<T>) => JSON.stringify({ ...event(type, data), sessionId, seq: ++seq.value, time: 0 })
  const usage = (inputTokens: number, cachedInputTokens: number) => ({ inputTokens, cachedInputTokens, outputTokens: 10, reasoningTokens: 0 })
  const step = (id: string, input: number, cached: number) => [
    line("step.started", { messageId: id as MessageId, attempt: 1, model: "m" }),
    line("step.ended", { messageId: id as MessageId, finish: "tool_calls", usage: usage(input, cached) }),
  ]
  const call = (message: string, id: string, outcome: "effect_unknown" | "not_started") => [
    line("tool.called", { messageId: message as MessageId, callId: id as CallId, name: "shell", input: "{}", providerData: null }),
    line("tool.settled", { messageId: message as MessageId, callId: id as CallId, outcome, output: "", truncation: null, attachments: [], display: null }),
  ]
  const stream = [
    ...step("m1", 1000, 0),
    ...step("m2", 1500, 900),
    ...call("m2", "c1", "effect_unknown"),
    ...step("m3", 1800, 200),
    ...call("m3", "c2", "not_started"),
    JSON.stringify({ type: "something.new", sessionId, seq: 99, time: 0, v: 1, data: {} }),
    JSON.stringify({ type: "step.ended", v: 1, data: { nope: true } }),
    '{"type": "text.del', // cut off mid-line
  ].join("\n")

  test("cache drops, unsafe tool outcomes, a missing execution end and step overruns are flagged", () => {
    const metrics = computeMetrics(stream, 2)
    const kinds = metrics.anomalies.map((anomaly) => anomaly.kind)
    expect(kinds.filter((kind) => kind !== "malformed-event")).toEqual(["effect-unknown", "not-started", "cache-drop", "no-execution-end", "over-step-limit"])
    expect(metrics.anomalies.find((anomaly) => anomaly.kind === "cache-drop")?.detail).toBe("step 3: cached input fell from 900 to 200")
    expect(metrics.unknownEvents).toEqual({ "something.new": 1 })
    expect(metrics.malformed).toBe(2)
    expect(metrics.toolOutcomes).toMatchObject({ effect_unknown: 1, not_started: 1 })
    expect(metrics.steps).toBe(3)
  })

  test("the runner reports them for a replayed stream and tolerates the unknown event", async () => {
    const file = join(scratch.dir, "crafted.jsonl")
    await Bun.write(file, `${stream}\n`)
    const report = await run("replay", { tasks: ["answer-question"] }, { STAND_IN_EVENTS: file })
    const result = report.results[0]!
    expect(result.exitCode).toBe(0)
    expect(result.metrics.unknownEvents).toEqual({ "something.new": 1 })
    expect(result.overStepLimit).toBe(false)
    expect(formatTable(report)).toContain("effect-unknown,not-started,malformed-event,cache-drop,no-execution-end")
  }, 30_000)
})

test("--keep keeps the finished workspace", async () => {
  const report = await run("solve", { tasks: ["answer-question"], keep: true })
  const workspace = report.results[0]!.workspace!
  expect(await Bun.file(join(workspace, "answer.txt")).exists()).toBe(true)
  await rm(join(workspace, ".."), { recursive: true, force: true })
}, 30_000)

test("no temporary directory is left behind", async () => {
  expect(runs.count).toBeGreaterThan(5)
  expect(await leftovers()).toEqual([])
})

test("arguments", async () => {
  expect(await parseRunnerArgs(["answer-question", "--repeat", "3", "--cli", 'bun "my agent.ts" --demo 1', "--timeout", "0.5"])).toMatchObject({
    tasks: ["answer-question"],
    repeat: 3,
    concurrency: 1,
    cli: ["bun", "my agent.ts", "--demo", "1"],
    timeoutSeconds: 0.5,
  })
  expect(((await parseRunnerArgs(["--all"])) as RunOptions).tasks.length).toBeGreaterThanOrEqual(10)
  expect(await parseRunnerArgs([])).toStartWith("name some tasks")
  expect(await parseRunnerArgs(["no-such-task"])).toStartWith("unknown task no-such-task")
  expect(await parseRunnerArgs(["--all", "--repeat", "0"])).toStartWith("--repeat must be")
  expect(await parseRunnerArgs(["--all", "--bogus"])).toBe("unknown option --bogus")
})
