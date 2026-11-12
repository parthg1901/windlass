// The agent runner, driven end to end with the scripted stand-in agent in place of the CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CallId, type EventData, type EventType, type MessageId, type SessionId, event } from "../packages/core/src/index.ts"
import { traceHash } from "../packages/core/src/trace/format.ts"
import { classifySession, classifyTrace, prefixlensDir } from "./classify.ts"
import { type RunOptions, computeMetrics, explainAnomalies, formatTable, parseRunnerArgs, runAgent, taskRunEnv } from "./run-agent.ts"
import { TEST_CONTEXT_WINDOW_ENV } from "../packages/core/src/assembly.ts"
import { brand } from "../packages/core/src/brand.ts"
import { NOTES_WRITTEN_AS_OF, arrangeMemorySide, memoryTaskSource, notesOf, redateNote } from "./memory-tasks/source.ts"
import { projectKey } from "../packages/core/src/memory/store.ts"
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
  // Assigning `undefined` would store the string "undefined" and break `tmpdir()` for every test file that runs after this one.
  if (scratch.previousTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = scratch.previousTmp
  await rm(scratch.dir, { recursive: true, force: true })
})

const runs = { count: 0 }
function run(mode: string, options: Partial<RunOptions> & { tasks: string[] }, env: Record<string, string> = {}) {
  runs.count += 1
  // The agent's data directory is the scratch one, so classification never reads the real session database.
  return runAgent({ cli: STAND_IN, out: join(scratch.dir, `out-${runs.count}`), graceSeconds: 5, ...options, env: { XDG_DATA_HOME: join(scratch.dir, "data"), STAND_IN_MODE: mode, ...env } })
}

async function leftovers() {
  return (await readdir(scratch.tmp)).filter((name) => name.startsWith(`${brand.binary}-agent-`) || name.startsWith(`${brand.binary}-eval-`))
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
    expect(metrics.anomalies.find((anomaly) => anomaly.kind === "cache-drop")?.detail).toBe("step 3 (message m3): cached input fell from 900 to 200")
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
    expect(formatTable(report)).toContain("effect-unknown,not-started,malformed-event,cache-drop(?),no-execution-end")
  }, 30_000)
})

describe("a multi-turn task", () => {
  test("each prompt is a turn of the same session, and the grader runs after the last", async () => {
    const report = await run("solve", { tasks: ["follow-up-change"] })
    const result = report.results[0]!
    expect(result.pass).toBe(true)
    expect(result.prompts).toBe(2)
    expect(result.turns.map((turn) => turn.exitCode)).toEqual([0, 0])
    expect(result.wallMs).toBe(result.turns[0]!.wallMs + result.turns[1]!.wallMs)
    expect(result.metrics.sessionId).toBe("ses_standin")
    expect(result.metrics.steps).toBe(4)
    expect(result.metrics.toolCalls).toBe(2)
    expect(result.metrics.tools.shell?.success).toBe(2)
    // The stand-in's second turn reads nothing from cache; there is no database here to explain the drop with.
    expect(result.metrics.anomalies.map((anomaly) => [anomaly.kind, anomaly.explained])).toEqual([["cache-drop", null]])
    const stream = (await Bun.file(result.eventsFile).text()).trim().split("\n").map((line) => JSON.parse(line))
    // The second turn resumed the session: one session.created, two executions.
    expect(stream.filter((item) => item.type === "session.created")).toHaveLength(1)
    expect(stream.filter((item) => item.type === "execution.succeeded")).toHaveLength(2)
    expect(await Bun.file(result.stderrFile).text()).toContain("--- turn 2")
  }, 60_000)

  test("every turn is started with the task's step limit, the later ones in the first one's session", async () => {
    const record = join(scratch.dir, "argv.jsonl")
    const report = await run("solve", { tasks: ["follow-up-change"], model: "stand-in-model", effort: "low" }, { STAND_IN_ARGV: record })
    const result = report.results[0]!
    const turns = (await Bun.file(record).text()).trim().split("\n").map((line) => JSON.parse(line) as string[])
    expect(turns).toHaveLength(2)
    const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
    // The limit is the task's own (`maxSteps` in task.json), on every turn, and before the `--` that ends the options.
    expect(turns.map((argv) => flag(argv, "--max-steps"))).toEqual([String(result.maxSteps), String(result.maxSteps)])
    expect(turns.every((argv) => argv.indexOf("--max-steps") < argv.indexOf("--"))).toBe(true)
    expect(turns.map((argv) => flag(argv, "--model"))).toEqual(["stand-in-model", null])
    // Every turn says how calls are approved: the default mode, and a refusal where a person would be asked.
    expect(turns.map((argv) => [flag(argv, "--approval"), flag(argv, "--unattended")])).toEqual([
      ["auto", "deny"],
      ["auto", "deny"],
    ])
    expect(turns.map((argv) => flag(argv, "--session"))).toEqual([null, "ses_standin"])
  }, 60_000)

  test("a turn that hits the time limit ends the run; the next prompt is not sent", async () => {
    const report = await run("hang", { tasks: ["follow-up-change"], timeoutSeconds: 1 })
    const result = report.results[0]!
    expect(result.turns).toHaveLength(1)
    expect(result.status).toBe("timeout")
    expect(result.metrics.end).toBe("interrupted")
  }, 30_000)

  test("a turn that crashes ends the run and is reported as crashed", async () => {
    const report = await run("crash", { tasks: ["follow-up-change"] })
    const result = report.results[0]!
    expect(result.turns).toHaveLength(1)
    expect(result.status).toBe("crashed")
    expect(result.metrics.anomalies.map((anomaly) => anomaly.kind)).toContain("no-execution-end")
  }, 30_000)

  test("an execution that starts and never ends is flagged even when an earlier one ended", () => {
    const first = computeMetrics(
      [
        { type: "execution.started", v: 1, data: { executionId: "exe_1" }, sessionId: "ses_x", seq: 1, time: 0 },
        { type: "execution.succeeded", v: 1, data: { executionId: "exe_1", verification: { status: "not_configured" } }, sessionId: "ses_x", seq: 2, time: 0 },
        { type: "execution.started", v: 1, data: { executionId: "exe_2" }, sessionId: "ses_x", seq: 3, time: 0 },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
      5,
    )
    expect(first.verification).toBe("not_configured")
    expect(first.anomalies).toEqual([{ kind: "no-execution-end", detail: "2 executions started, 1 ended" }])
  })
})

/**
 * Hand-written traces in the shape the exporter writes (SPEC format 1.1 plus the harness extension), each call
 * 2 s after the one before, so prefixlens judges a miss with the prefix intact as provider-side.
 */
function handTrace(calls: readonly { readonly blocks: readonly object[]; readonly read: number; readonly hints?: readonly object[]; readonly fidelity?: string; readonly reason?: string }[]) {
  return calls
    .map((call, index) =>
      JSON.stringify({
        v: 1,
        id: `req_${index + 1}`,
        session: "ses_hand",
        lane: "main",
        ts: new Date(Date.UTC(2026, 10, 11, 10) + index * 2000).toISOString(),
        provider: "openai",
        model: "gpt-test",
        fidelity: call.fidelity ?? "full-request",
        ...(call.fidelity === "usage-only" ? {} : { request: { blocks: call.blocks } }),
        usage: { input_tokens: 3000 + index * 300 - call.read, cache_read_tokens: call.read, cache_write_tokens: null, output_tokens: 10 },
        ...(call.hints ? { hints: call.hints } : {}),
        x_windlass: { ordinal: index, message_id: `msg_${index + 1}`, attempt: 1, purpose: "step", outcome: "ok", verified: call.fidelity !== "usage-only", ...(call.reason ? { unverified_reason: call.reason } : {}), params_omitted: [] },
      }),
    )
    .join("\n")
}
const block = (kind: string, key: string | undefined, content: object) => ({ kind, ...(key ? { key } : {}), hash: traceHash(content), content })
const tool = (name: string) => block("tool", name, { type: "function", name, description: `${name} tool`, parameters: {} })
const system = (text: string) => block("system", undefined, { type: "text", text })
const message = (n: number) => block("message", "user", { type: "message", role: "user", content: [{ type: "input_text", text: `message ${n} `.repeat(50) }] })
const instructions = system("You are a coding agent. ".repeat(200))
const prefix = [tool("read"), tool("shell"), instructions]
const present = await Bun.file(join(prefixlensDir(), "src", "cli.ts")).exists()
const withPrefixlens = (name: string) => (present ? name : `${name} [skipped: no prefixlens checkout at ${prefixlensDir()}]`)

describe("cache classification", () => {
  const trace = async (name: string, calls: Parameters<typeof handTrace>[0]) => {
    const file = join(scratch.dir, `${name}.trace.jsonl`)
    await Bun.write(file, `${handTrace(calls)}\n`)
    return file
  }

  test.skipIf(!present)(withPrefixlens("a provider-side miss, a declared break and an avoidable miss are told apart"), async () => {
    const file = await trace("mixed", [
      { blocks: [...prefix, message(1)], read: 0 },
      { blocks: [...prefix, message(1), message(2)], read: 3200 },
      // Nothing changed and the provider read nothing: provider-side.
      { blocks: [...prefix, message(1), message(2), message(3)], read: 0 },
      // A tool disappeared mid-session: the harness's fault.
      { blocks: [tool("read"), instructions, message(1), message(2), message(3), message(4)], read: 0 },
      // A compaction, declared.
      { blocks: [tool("read"), system("Summary of the work so far."), message(5)], read: 0, hints: [{ kind: "prefix_break", reason: "compaction" }] },
    ])
    const result = await classifyTrace(file)
    expect(result).toMatchObject({ status: "classified", records: 5, fullRequest: 5, usageOnly: 0, fullFidelity: true, providerSide: 1, intentional: 1, avoidable: 1, expired: 0 })
    expect(result.avoidableCauses).toEqual(["turn 4: tools_changed: tool list changed (-1 tool: 2 → 1)"])
    expect(result.misses.map((miss) => [miss.messageId, miss.verdict])).toEqual([
      ["msg_3", "provider-side"],
      ["msg_4", "avoidable"],
      ["msg_5", "intentional"],
    ])

    // The event stream's cache drops are matched to those verdicts by message ID.
    const usage = (input: number, cached: number) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: 10, reasoningTokens: 0 })
    const steps = [usage(3000, 0), usage(3300, 3200), usage(3600, 0), usage(3900, 2000), usage(4200, 0), usage(4500, 4400), usage(4800, 4300)]
    const stream = steps
      .map((step, index) => JSON.stringify({ type: "step.ended", v: 1, data: { messageId: `msg_${index + 1}`, finish: "stop", usage: step }, sessionId: "ses_hand", seq: index + 1, time: 0 }))
      .join("\n")
    const marked = explainAnomalies(computeMetrics(stream, 20), result)
    const drops = marked.filter((anomaly) => anomaly.kind === "cache-drop").map((anomaly) => [anomaly.detail.split(":")[0], anomaly.explained])
    expect(drops).toEqual([
      ["step 3 (message msg_3)", true],
      ["step 5 (message msg_5)", true],
      // A drop of 100 tokens: prefixlens counts no miss within its 128-token tolerance.
      ["step 7 (message msg_7)", true],
    ])
    expect(marked.find((anomaly) => anomaly.detail.startsWith("step 3"))?.detail).toEndWith("explained, provider-side")
    expect(marked.filter((anomaly) => anomaly.kind === "avoidable-miss").map((anomaly) => anomaly.detail)).toEqual(["trace call 4: tools_changed: tool list changed (-1 tool: 2 → 1)"])
  }, 60_000)

  test.skipIf(!present)(withPrefixlens("a drop at an avoidable miss is unexplained"), async () => {
    const file = await trace("avoidable", [
      { blocks: [...prefix, message(1)], read: 0 },
      { blocks: [...prefix, message(1), message(2)], read: 3200 },
      { blocks: [tool("shell"), tool("read"), instructions, message(1), message(2), message(3)], read: 0 },
    ])
    const result = await classifyTrace(file)
    expect(result.avoidable).toBe(1)
    expect(result.avoidableCauses[0]).toStartWith("turn 3: tools_reordered")
    const usage = (input: number, cached: number) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: 10, reasoningTokens: 0 })
    const stream = [usage(3000, 0), usage(3300, 3200), usage(3600, 0)]
      .map((step, index) => JSON.stringify({ type: "step.ended", v: 1, data: { messageId: `msg_${index + 1}`, finish: "stop", usage: step }, sessionId: "ses_hand", seq: index + 1, time: 0 }))
      .join("\n")
    const drop = explainAnomalies(computeMetrics(stream, 20), result).find((anomaly) => anomaly.kind === "cache-drop")!
    expect(drop.explained).toBe(false)
    expect(drop.detail).toEndWith("unexplained, tools_reordered")
  }, 60_000)

  test.skipIf(!present)(withPrefixlens("a usage-only record is a fidelity failure, with the exporter's reason"), async () => {
    const file = await trace("usage-only", [
      { blocks: [...prefix, message(1)], read: 0 },
      { blocks: [], read: 3200, fidelity: "usage-only", reason: "hash_mismatch" },
    ])
    const result = await classifyTrace(file)
    expect(result.fullFidelity).toBe(false)
    expect(result.unfaithful).toEqual([{ turn: 2, messageId: "msg_2", reason: "hash_mismatch" }])
    expect(explainAnomalies(computeMetrics("", 5), result).map((anomaly) => anomaly.kind)).toContain("usage-only-record")
  }, 60_000)

  test("without the prefixlens checkout it is skipped and says why; drops stay unexplained", async () => {
    const previous = process.env.PREFIXLENS_DIR
    process.env.PREFIXLENS_DIR = join(scratch.dir, "no-prefixlens")
    try {
      const result = await classifySession("ses_x", { database: join(scratch.dir, "none.db"), traceFile: join(scratch.dir, "none.jsonl") })
      expect(result.status).toBe("skipped")
      expect(result.reason).toBe(`no prefixlens checkout at ${join(scratch.dir, "no-prefixlens")}`)
      const usage = (cached: number) => ({ inputTokens: 3000, cachedInputTokens: cached, outputTokens: 10, reasoningTokens: 0 })
      const stream = [usage(2000), usage(0)].map((step, index) => JSON.stringify({ type: "step.ended", v: 1, data: { messageId: `m${index}`, finish: "stop", usage: step } })).join("\n")
      expect(explainAnomalies(computeMetrics(stream, 5), result).find((anomaly) => anomaly.kind === "cache-drop")?.explained).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.PREFIXLENS_DIR
      else process.env.PREFIXLENS_DIR = previous
    }
  })

  // End to end: the stand-in writes a scripted session into a real session database, the runner exports it with
  // scripts/export-trace.ts and classifies it.
  test.skipIf(!present)(withPrefixlens("the runner exports a real session and classifies its declared breaks"), async () => {
    const data = join(scratch.dir, "data-settings")
    const report = await run("scripted", { tasks: ["answer-question"] }, { XDG_DATA_HOME: data, STAND_IN_SCRIPT: "settings changes" })
    const result = report.results[0]!
    expect(result.cache).toMatchObject({ status: "classified", records: 3, fullRequest: 3, fullFidelity: true, intentional: 2, avoidable: 0 })
    expect(result.traceFile).toBe(join(report.out, "runs", "answer-question-1.trace.jsonl"))
    expect(await Bun.file(result.traceFile!).exists()).toBe(true)
    expect(report.totals.cache).toEqual({ classified: 1, providerSide: 0, intentional: 2, avoidable: 0, unfaithful: 0 })
    expect(formatTable(report)).toContain("0 provider-side, 2 intentional, 0 avoidable; 0 usage-only records")
  }, 60_000)

  test.skipIf(!present)(withPrefixlens("a session whose ledger does not match its log exports usage-only, and that is flagged"), async () => {
    const data = join(scratch.dir, "data-broken")
    const report = await run("scripted", { tasks: ["answer-question"] }, { XDG_DATA_HOME: data, STAND_IN_SCRIPT: "multi-step turns", STAND_IN_BUILDER: "broken" })
    const result = report.results[0]!
    expect(result.cache.status).toBe("classified")
    expect(result.cache.fullFidelity).toBe(false)
    expect(result.cache.unfaithful.length).toBe(result.cache.records)
    expect(result.cache.unfaithful[0]!.reason).toContain("differs from the ledger")
    expect(result.metrics.anomalies.filter((anomaly) => anomaly.kind === "usage-only-record")).toHaveLength(result.cache.records)
  }, 60_000)

  test("--no-classify turns it off, and an unknown session is reported, not fatal", async () => {
    const off = await run("nothing", { tasks: ["answer-question"], classify: false })
    expect(off.results[0]!.cache).toMatchObject({ status: "skipped", reason: "classification turned off" })
    const missing = await run("nothing", { tasks: ["answer-question"] })
    expect(missing.results[0]!.cache.status).toBe("skipped")
    expect(missing.results[0]!.cache.reason).toContain(present ? "no session database" : "no prefixlens checkout")
  }, 60_000)
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
  expect(await parseRunnerArgs(["answer-question", "--db", "x.db", "--no-classify"])).toMatchObject({ database: join(process.cwd(), "x.db"), classify: false })
  expect(((await parseRunnerArgs(["--all"])) as RunOptions).tasks.length).toBeGreaterThanOrEqual(10)
  expect(await parseRunnerArgs([])).toStartWith("name some tasks")
  expect(await parseRunnerArgs(["no-such-task"])).toStartWith("unknown task no-such-task")
  expect(await parseRunnerArgs(["--all", "--repeat", "0"])).toStartWith("--repeat must be")
  expect(await parseRunnerArgs(["--all", "--bogus"])).toBe("unknown option --bogus")
})

describe("per-task run options and the memory A/B sides", () => {
  // A CLI that records what the agent was started with (its configuration file and the test window) and then hands
  // over to the stand-in. The runner appends the CLI's flags after it.
  const spy = (name: string) => [
    "sh",
    "-c",
    `{ cat "$XDG_CONFIG_HOME/${brand.directory}/config.json" 2>/dev/null || echo none; echo "window=\${${TEST_CONTEXT_WINDOW_ENV}:-unset}"; } > "${join(scratch.dir, name)}"; exec "$@"`,
    "spy",
    ...STAND_IN,
  ]

  test("a task's run.contextWindow reaches the agent as the test window; a bad run section is refused", async () => {
    const audit = await (await import("./run-check.ts")).loadTask("audit-every-handler")
    expect(taskRunEnv(audit)).toEqual({ [TEST_CONTEXT_WINDOW_ENV]: "29000" })
    expect(taskRunEnv({ ...audit, run: undefined } as never)).toEqual({})
    expect(() => taskRunEnv({ ...audit, run: { contextWindow: 10.5 } } as never)).toThrow("whole number")
    expect(() => taskRunEnv({ ...audit, run: { window: 1 } } as never)).toThrow("unknown run option window")
    await run("nothing", { tasks: ["audit-every-handler"], cli: spy("seen-window") })
    expect((await Bun.file(join(scratch.dir, "seen-window")).text()).trim().split("\n").at(-1)).toBe("window=29000")
    await run("nothing", { tasks: ["answer-question"], cli: spy("seen-plain") })
    expect(await Bun.file(join(scratch.dir, "seen-plain")).text()).toBe("none\nwindow=unset\n")
  }, 60_000)

  test("--memory with: memory on in the run's own configuration, the task's notes seeded outside the workspace and removed after", async () => {
    const id = (await memoryTaskSource.list())[0]!
    const data = join(scratch.dir, "data")
    // During the run: every note file under the agent's data directory, with its path and text.
    const notesSpy = [
      "sh",
      "-c",
      `find "$XDG_DATA_HOME/${brand.directory}/memory" -name '*.md' -type f | sort | while read -r f; do echo "== $f"; cat "$f"; done > "${join(scratch.dir, "seen-notes")}"; exec "$@"`,
      "notes",
      ...spy("seen-with"),
    ]
    const before = Date.now()
    const report = await run("nothing", { tasks: [id], memory: "with", keep: true, cli: notesSpy })
    const result = report.results[0]!
    expect(report.memory).toBe("with")
    expect(result.status).toBe("failed")
    expect(result.reason).toStartWith("fail:")
    expect(JSON.parse((await Bun.file(join(scratch.dir, "seen-with")).text()).split("\nwindow=")[0]!)).toEqual({ memory: { enabled: true } })
    const notes = await notesOf(id)
    const seen = (await Bun.file(join(scratch.dir, "seen-notes")).text()).split(/^== /m).filter((part) => part !== "")
    expect(seen.length).toBe(notes.length)
    const projectDir = join(data, brand.directory, "memory", "projects", projectKey(result.workspace!))
    for (const [index, note] of notes.entries()) {
      const [path, ...text] = seen[index]!.split("\n")
      expect(path).toBe(join(projectDir, note.split("/").at(-1)!))
      // The same note, re-dated to the run: the body is unchanged and the created date has moved by the time since the notes were written.
      const original = await Bun.file(note).text()
      const seeded = text.join("\n")
      expect(seeded.split("\n---\n").slice(1)).toEqual(original.split("\n---\n").slice(1))
      const shift = Date.parse(/^created: (\S+)$/m.exec(seeded)![1]!) - Date.parse(/^created: (\S+)$/m.exec(original)![1]!)
      expect(shift).toBeGreaterThanOrEqual(before - Date.parse(NOTES_WRITTEN_AS_OF) - 1000)
      expect(shift).toBeLessThanOrEqual(Date.now() - Date.parse(NOTES_WRITTEN_AS_OF))
    }
    expect(await Bun.file(join(result.workspace!, `.${brand.directory}`, "memory")).exists()).toBe(false)
    expect(await readdir(projectDir).catch(() => "removed")).toBe("removed")
    await rm(join(result.workspace!, ".."), { recursive: true, force: true })
  }, 60_000)

  test("--memory with refuses to mix in user notes or an existing notes directory", async () => {
    const id = (await memoryTaskSource.list())[0]!
    const data = join(scratch.dir, "data-with-user-notes")
    await Bun.write(join(data, brand.directory, "memory", "user", "m_00000001.md"), "---\nid: m_00000001\nkind: preference\nscope: user\ncreated: 2026-11-01T00:00:00Z\n---\nShort answers.\n")
    const report = await run("nothing", { tasks: [id], memory: "with" }, { XDG_DATA_HOME: data })
    expect(report.results[0]!.status).toBe("error")
    expect(report.results[0]!.reason).toContain("user note(s)")
    const workspace = await mkdtemp(join(scratch.dir, "ws-"))
    const config = await mkdtemp(join(scratch.dir, "cfg-"))
    const env = { XDG_DATA_HOME: join(scratch.dir, "data-existing") }
    const first = await arrangeMemorySide("with", id, workspace, config, env)
    await expect(arrangeMemorySide("with", id, workspace, config, env)).rejects.toThrow("already exists")
    await first.cleanup()
    expect(await readdir(first.notesDir!).catch(() => "removed")).toBe("removed")
  }, 60_000)

  test("notes are re-dated relative to the run", () => {
    const note = "---\nid: m_1\nkind: fact\nscope: project\ncreated: 2026-10-22T12:00:00Z\nconfirmed: 2026-11-02T12:00:00Z\nexpires: 2026-12-31\n---\ncreated: 2026-10-22T12:00:00Z stays in the body\n"
    const later = new Date(Date.parse(NOTES_WRITTEN_AS_OF) + 100 * 86_400_000)
    expect(redateNote(note, later)).toBe("---\nid: m_1\nkind: fact\nscope: project\ncreated: 2027-01-30T12:00:00Z\nconfirmed: 2027-02-10T12:00:00Z\nexpires: 2027-04-10\n---\ncreated: 2026-10-22T12:00:00Z stays in the body\n")
    expect(redateNote(note.replace("expires: 2026-12-31", "expires: 90d"), new Date(NOTES_WRITTEN_AS_OF))).toBe(note.replace("expires: 2026-12-31", "expires: 90d"))
  })

  test("--memory without: memory off in the run's own configuration, no notes", async () => {
    const id = (await memoryTaskSource.list())[0]!
    const report = await run("nothing", { tasks: [id], memory: "without", keep: true, cli: spy("seen-without") })
    const result = report.results[0]!
    expect(report.memory).toBe("without")
    expect(JSON.parse((await Bun.file(join(scratch.dir, "seen-without")).text()).split("\nwindow=")[0]!)).toEqual({ memory: { enabled: false } })
    expect(await Bun.file(join(result.workspace!, `.${brand.directory}`, "memory")).exists()).toBe(false)
    expect(await readdir(join(result.workspace!, ".."))).toEqual(expect.arrayContaining([`${id}-1`, `${id}-1.config`]))
    await rm(join(result.workspace!, ".."), { recursive: true, force: true })
  }, 60_000)

  test("--memory picks the task set and is checked", async () => {
    const ids = await memoryTaskSource.list()
    expect(await parseRunnerArgs(["--all", "--memory", "without"])).toMatchObject({ tasks: ids, memory: "without" })
    expect(await parseRunnerArgs([ids[0]!, "--memory", "with"])).toMatchObject({ tasks: [ids[0]], memory: "with" })
    expect(await parseRunnerArgs(["answer-question", "--memory", "with"])).toStartWith("unknown task answer-question")
    expect(await parseRunnerArgs(["--all", "--memory", "maybe"])).toBe("--memory must be with or without")
    expect(((await parseRunnerArgs(["--all"])) as RunOptions).tasks).not.toContain(ids[0])
    expect(await leftovers()).toEqual([])
  })
})
