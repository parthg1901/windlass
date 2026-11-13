import { describe, expect, test } from "bun:test"
import { runReplay } from "../../src/replay/driver.ts"
import { responsesFromTape } from "../../src/replay/fake.ts"
import { normalise } from "../../src/replay/match.ts"
import { renderReport, renderReportJson } from "../../src/replay/report.ts"
import type { Tape } from "../../src/replay/tape.ts"
import { FakeProvider, type ScriptItem, script } from "../../src/testing/fake-provider.ts"
import { whileCallWaitsAndArgumentsStream, whileToolArgumentsStream } from "../scenarios/cancel.ts"
import { crashWhileSideEffectRuns } from "../scenarios/crash.ts"
import { parallelToolCalls, severalSteps } from "../scenarios/happy.ts"
import { refusedTurn } from "../scenarios/refusal.ts"
import { retryAfterPartialText } from "../scenarios/retry.ts"
import { CRASH_EFFECT_UNKNOWN, NOT_STARTED } from "../scenarios/script.ts"
import { simpleRequest, standIns, tapeOf } from "./helpers.ts"

async function replay(tape: Tape, overrides: Record<number, readonly ScriptItem[] | null> = {}, extra: ScriptItem[][] = [], options = {}) {
  const provider = new FakeProvider(responsesFromTape(tape, overrides, extra))
  const run = await runReplay({ tape, provider, buildRequest: simpleRequest("A changed system prompt."), replay: { tools: standIns().tools, ...options } })
  return { ...run, provider }
}

const several = tapeOf(severalSteps)
const usage = script.usage({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10 })

describe("replay driver", () => {
  test("an identical replay reports no divergence", async () => {
    const { report, provider } = await replay(several)
    expect(report).toMatchObject({
      status: "identical",
      divergence: null,
      matched: { steps: 4, calls: 3, normalised: 0, reordered: 0, splits: 0, merges: 0 },
      comparison: {
        steps: { recorded: 4, replayed: 4 },
        callsByTool: [
          { tool: "read", recorded: 1, replayed: 1 },
          { tool: "shell", recorded: 1, replayed: 1 },
          { tool: "write", recorded: 1, replayed: 1 },
        ],
        finalAnswer: { recorded: "Fixed the expectation; the test passes.", replayed: "Fixed the expectation; the test passes." },
        usage: {
          recorded: { inputTokens: 4000, cachedInputTokens: 3200, outputTokens: 200, reasoningTokens: 40 },
          replayed: { inputTokens: 4000, cachedInputTokens: 3200, outputTokens: 200, reasoningTokens: 40 },
        },
      },
    })
    expect(provider.remaining).toBe(0)
    expect(provider.requests[0]!.instructions).toBe("A changed system prompt.")
    // The model was given the recorded results.
    expect(provider.requests[3]!.input.flatMap((item) => (item.type === "tool_result" ? [item.output] : []))).toEqual([
      "expect(add(1, 1)).toBe(3)",
      "Wrote a.test.ts",
      "1 pass, 0 fail",
    ])
  })

  test("a changed argument is reported with the field that changed", async () => {
    const { report } = await replay(several, { 2: [script.toolCall("call_1", "shell", { command: "bun test --bail" }), usage] })
    expect(report).toMatchObject({
      status: "diverged",
      divergence: {
        kind: "arguments_differ",
        replayStep: 2,
        recordedStep: 2,
        callIndex: 0,
        recorded: { kind: "calls", calls: [{ name: "shell", argumentsText: '{"command":"bun test"}' }] },
        replayed: { kind: "call", call: { name: "shell", argumentsText: '{"command":"bun test --bail"}' } },
        argumentDiff: [{ path: "command", recorded: "bun test", replayed: "bun test --bail" }],
      },
      matched: { steps: 2, calls: 2 },
      comparison: { steps: { recorded: 4, replayed: 3 }, finalAnswer: { replayed: null } },
    })
  })

  test("a different tool", async () => {
    const { report } = await replay(several, { 1: [script.toolCall("call_1", "shell", { command: "sed -i s/3/2/ a.test.ts" })] })
    expect(report.divergence).toMatchObject({ kind: "different_tool", replayStep: 1, recorded: { calls: [{ name: "write" }] } })
    expect(report.matched).toMatchObject({ steps: 1, calls: 1 })
  })

  test("an answer earlier than recorded", async () => {
    const { report } = await replay(several, { 1: [script.text("The test expects 3; it should expect 2.")] })
    expect(report).toMatchObject({
      status: "diverged",
      divergence: { kind: "text_instead_of_call", replayStep: 1, callIndex: null, replayed: { kind: "text" } },
      comparison: { finalAnswer: { replayed: "The test expects 3; it should expect 2." } },
    })
  })

  test("an extra call, and a call where the recording answered", async () => {
    const extra = await replay(several, {
      0: [script.toolCall("call_1", "read", { path: "a.test.ts" }), script.toolCall("call_2", "read", { path: "a.ts" })],
    })
    expect(extra.report.divergence).toMatchObject({ kind: "extra_call", replayStep: 0, callIndex: 1 })

    const instead = await replay(several, { 3: [script.toolCall("call_1", "shell", { command: "bun test" })] })
    expect(instead.report.divergence).toMatchObject({
      kind: "call_instead_of_text",
      replayStep: 3,
      recorded: { kind: "text", text: "Fixed the expectation; the test passes." },
    })
  })

  test("reordered parallel calls and a normalised path still replay identically", async () => {
    const tape = tapeOf(parallelToolCalls)
    const { report } = await replay(
      tape,
      { 0: [script.toolCall("x", "read", { path: "/repo/b.ts" }), script.toolCall("y", "read", { path: "a.ts" })] },
      [],
      { normalisers: { read: normalise.paths("path") } },
    )
    expect(report).toMatchObject({ status: "identical", matched: { calls: 2, normalised: 1, reordered: 1 } })
  })

  test("an interrupted step: the recorded call is answered not_started and further calls are dropped as the interrupt dropped them", async () => {
    const tape = tapeOf(whileCallWaitsAndArgumentsStream)
    const { report, conversation } = await replay(tape, {
      0: [
        script.text("I'll run the migration, note it and show the schema."),
        script.toolCall("c1", "shell", { command: "bun run migrate" }),
        script.toolCall("c2", "write", { path: "CHANGELOG.md", content: "Added an index." }),
        script.toolCall("c3", "read", { path: "schema.sql" }),
      ],
    })
    expect(report).toMatchObject({ status: "identical", matched: { calls: 2, dropped: 1, notStarted: 1 } })
    const results = conversation.flatMap((entry) => (entry.kind === "output" && entry.item.type === "tool_result" ? [entry.item.output] : []))
    expect(results).toEqual(["Stopped by the user after 2 s. Output so far:\nmigrating\n", NOT_STARTED, "Not run: the user interrupted before this call started."])
    expect(conversation.at(-1)).toMatchObject({ kind: "input", input: { origin: "interrupt" } })
  })

  test("a step interrupted while it streamed, after a call of it had run: further calls are dropped, not an extra call", async () => {
    const { report, conversation } = await replay(tapeOf(whileToolArgumentsStream), {
      0: [script.text("I'll read both files."), script.toolCall("c1", "read", { path: "a.ts" }), script.toolCall("c2", "read", { path: "b.ts" })],
    })
    expect(report).toMatchObject({ status: "identical", matched: { calls: 1, dropped: 1, notStarted: 0 } })
    const results = conversation.flatMap((entry) => (entry.kind === "output" && entry.item.type === "tool_result" ? [entry.item.output] : []))
    expect(results).toEqual(["export const a = 1", "Not run: the user interrupted before this call started."])
  })

  test("a crash replays the recorded effect_unknown result and the restart marker", async () => {
    const { report, provider } = await replay(tapeOf(crashWhileSideEffectRuns))
    expect(report).toMatchObject({ status: "identical", matched: { steps: 3, effectUnknown: 1, notStarted: 1 } })
    expect(provider.requests[1]!.input.some((item) => item.type === "tool_result" && item.output === CRASH_EFFECT_UNKNOWN)).toBe(true)
  })

  test("a retried step replays as the one attempt that answered", async () => {
    const tape = tapeOf(retryAfterPartialText)
    const { report } = await replay(tape, { 0: [script.text("Let me look at the test first, then the implementation.")] })
    expect(report).toMatchObject({ status: "identical", skippedAttempts: 1, comparison: { steps: { recorded: 1, replayed: 1 } } })
  })

  test("a refusal in the recording ends the replay as unsupported", async () => {
    const { report, provider } = await replay(tapeOf(refusedTurn))
    expect(report).toMatchObject({ status: "unsupported", matched: { steps: 2 } })
    expect(report.reason).toBe("the recording has a refusal before step 3, which a replay cannot reproduce")
    expect(provider.calls).toHaveLength(2)
  })

  test("a provider error makes the replay incomplete", async () => {
    const { report } = await replay(several, { 1: [script.fail("rate_limit")] })
    expect(report).toMatchObject({ status: "incomplete", reason: "the provider failed at step 2: rate_limit: scripted rate_limit" })
  })

  test("the report renders deterministically, as text and as JSON", async () => {
    const first = await replay(several, { 2: [script.toolCall("call_1", "shell", { command: "bun test --bail" }), usage] })
    const second = await replay(several, { 2: [script.toolCall("call_1", "shell", { command: "bun test --bail" }), usage] })
    expect(renderReport(first.report)).toBe(renderReport(second.report))
    expect(renderReportJson(first.report)).toBe(renderReportJson(second.report))
    expect(JSON.parse(renderReportJson(first.report))).toEqual(JSON.parse(JSON.stringify(first.report)))
    expect(renderReport(first.report)).toBe(
      [
        "replay (no session id): DIVERGED  left the recording at step 3, call 1: arguments differ",
        '  recorded   shell {"command":"bun test"}',
        '  replayed   shell {"command":"bun test --bail"}',
        '  changed    command: "bun test" -> "bun test --bail"',
        "  matched before: 2 steps, 2 calls (0 normalised, 0 reordered, 0 split, 0 merged)",
        "",
        "                  recorded  replayed",
        "  steps                  4         3",
        "  calls read             1         1",
        "        shell            1         1",
        "        write            1         1",
        "  tokens in           4000      3000",
        "  tokens out           200       150",
        "  final answer",
        '    recorded  "Fixed the expectation; the test passes."',
        "    replayed  (not reached)",
      ].join("\n"),
    )
  })
})
