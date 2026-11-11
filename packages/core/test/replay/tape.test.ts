import { describe, expect, test } from "bun:test"
import type { SessionId } from "../../src/id.ts"
import { tapeFromEvents, tapeFromStore } from "../../src/replay/tape.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { beforeSideEffectReports, whileToolArgumentsStream } from "../scenarios/cancel.ts"
import { crashWhileSideEffectRuns } from "../scenarios/crash.ts"
import { parallelToolCalls, severalSteps, twoTurns } from "../scenarios/happy.ts"
import { refusedTurn } from "../scenarios/refusal.ts"
import { retryAfterPartialText, retryBeforeOutput } from "../scenarios/retry.ts"
import { allEvents, CRASH_EFFECT_UNKNOWN, EFFECT_UNKNOWN, NOT_STARTED } from "../scenarios/script.ts"
import { steerAtNextBoundary } from "../scenarios/steering.ts"
import { tapeOf } from "./helpers.ts"

describe("tape extraction", () => {
  test("several steps that reuse one provider call id stay distinct, keyed by message", () => {
    const tape = tapeOf(severalSteps)
    expect(tape.cwd).toBe("/repo")
    expect(tape.baseline?.instructions).toBe("You are a coding agent.")
    expect(tape.steps.map((step) => [step.messageId, step.calls.map((call) => `${call.messageId}/${call.callId} ${call.name}`)])).toEqual([
      ["a1", ["a1/call_1 read"]],
      ["a2", ["a2/call_1 write"]],
      ["a3", ["a3/call_1 shell"]],
      ["a4", []],
    ])
    const write = tape.steps[1]!.calls[0]!
    expect(write.input).toBe('{"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}')
    expect(write.canonical).toBe('{"content":"expect(add(1, 1)).toBe(2)","path":"a.test.ts"}')
    expect(write.started).toEqual({ effect: "write" })
    expect(write.settlement).toEqual({ outcome: "success", output: "Wrote a.test.ts", truncation: null, attachments: [], display: null })
    expect(tape.steps[3]!).toMatchObject({ text: "Fixed the expectation; the test passes.", response: "complete", end: { kind: "ended", finish: "stop" } })
    expect(tape.steps[0]!.usage).toEqual({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10 })
    expect(tape.inputs.filter((input) => input.kind === "message")).toEqual([
      expect.objectContaining({ kind: "message", beforeStep: 0, messageId: "u1", from: "user", origin: null }),
    ])
  })

  test("parallel calls keep the order the model made them, and each its own settlement", () => {
    const step = tapeOf(parallelToolCalls).steps[0]!
    expect(step.calls.map((call) => [call.callId, call.input, call.settlement.output])).toEqual([
      ["call_1", '{"path":"a.ts"}', "export const a = 1"],
      ["call_2", '{"path":"b.ts"}', "export const b = 2"],
    ])
  })

  test("a step the user interrupted while streaming is kept as cut, with its unstarted call and the marker after it", () => {
    const tape = tapeOf(whileToolArgumentsStream)
    expect(tape.steps).toHaveLength(1)
    const step = tape.steps[0]!
    expect(step).toMatchObject({ response: "cut", end: { kind: "interrupted", reason: "user" }, text: "I'll read both files." })
    expect(step.calls[0]).toMatchObject({ name: "read", started: null, settlement: { outcome: "not_started", output: NOT_STARTED } })
    expect(tape.inputs.at(-1)).toMatchObject({ kind: "message", beforeStep: 1, messageId: "s1", from: "harness", origin: "interrupt" })
    expect(tape.skipped).toEqual([])
  })

  test("a started side-effecting call settled effect_unknown is on the tape as such", () => {
    const call = tapeOf(beforeSideEffectReports).steps[0]!.calls[0]!
    expect(call).toMatchObject({ started: { effect: "write" }, settlement: { outcome: "effect_unknown", output: EFFECT_UNKNOWN } })
    expect(tapeOf(beforeSideEffectReports).steps[0]!.response).toBe("complete")
  })

  test("a crash after the tools started keeps the complete step, its outcomes and the restart marker", () => {
    const tape = tapeOf(crashWhileSideEffectRuns)
    expect(tape.steps.map((step) => [step.messageId, step.response, step.end.kind])).toEqual([
      ["a1", "complete", "crashed"],
      ["a2", "complete", "ended"],
      ["a3", "complete", "ended"],
    ])
    expect(tape.steps[0]!.calls.map((call) => [call.started, call.settlement.outcome])).toEqual([
      [{ effect: "exec" }, "effect_unknown"],
      [null, "not_started"],
    ])
    expect(tape.steps[0]!.calls[0]!.settlement.output).toBe(CRASH_EFFECT_UNKNOWN)
    expect(tape.inputs.some((input) => input.kind === "message" && input.messageId === "s1" && input.beforeStep === 1)).toBe(true)
  })

  test("a retry after partial text skips the failed attempt and its continuation note, carrying the text", () => {
    const tape = tapeOf(retryAfterPartialText)
    expect(tape.steps).toHaveLength(1)
    expect(tape.steps[0]).toMatchObject({ messageId: "a2", attempt: 2, text: "Let me look at the test first, then the implementation." })
    expect(tape.skipped).toEqual([
      expect.objectContaining({ messageId: "a1", text: "Let me look at the", dropped: ["s1"], error: expect.objectContaining({ kind: "provider" }) }),
    ])
    expect(tape.inputs.some((input) => input.kind === "message" && input.messageId === "s1")).toBe(false)
  })

  test("a retry before any output is one step with the latest attempt", () => {
    const tape = tapeOf(retryBeforeOutput)
    expect(tape.steps.map((step) => [step.messageId, step.attempt, step.text])).toEqual([["a1", 2, "Here is the fix."]])
  })

  test("inputs that arrive between steps carry the index of the step they precede", () => {
    expect(tapeOf(steerAtNextBoundary).inputs.flatMap((input) => (input.kind === "message" ? [[input.messageId, input.beforeStep]] : []))).toEqual([
      ["u1", 0],
      ["u2", 1],
    ])
    expect(tapeOf(twoTurns).inputs.flatMap((input) => (input.kind === "baseline" || input.kind === "settings" ? [] : [[input.kind, input.beforeStep]]))).toEqual([
      ["message", 0],
      ["instruction", 1],
      ["message", 1],
    ])
  })

  test("a refusal is an unsupported input at its position", () => {
    const tape = tapeOf(refusedTurn)
    expect(tape.steps.map((step) => step.messageId)).toEqual(["a1", "a2", "a4"])
    expect(tape.inputs.find((input) => input.kind === "unsupported")).toMatchObject({ what: "refusal", beforeStep: 2 })
  })

  test("reading through the store gives the same tape as reading the events", () => {
    const store = openSqliteStore({ path: ":memory:", now: () => 1000 })
    const sessionId = "ses_tape" as SessionId
    store.append(sessionId, allEvents(severalSteps))
    const fromStore = tapeFromStore(store, sessionId)
    const fromEvents = tapeFromEvents(allEvents(severalSteps))
    expect(fromStore.sessionId).toBe(sessionId)
    expect({ ...fromStore, sessionId: null }).toEqual(fromEvents)
    store.close()
  })
})
