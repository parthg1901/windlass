import { describe, expect, test } from "bun:test"
import { type CallShape, TapeMatcher, diffArguments, normalise } from "../../src/replay/match.ts"
import { parallelToolCalls, severalSteps } from "../scenarios/happy.ts"
import { deliver, enqueue, executionSucceeded, opening, ran, say, stepEnded, stepStarted } from "../scenarios/script.ts"
import { tapeOf } from "./helpers.ts"

const call = (name: string, argumentsText: string): CallShape => ({ name, argumentsText })

/** Recorded: step 1 reads a.ts, step 2 reads b.ts, step 3 answers. */
const twoReadSteps = tapeOf([
  ...opening(),
  stepStarted("a1"),
  ...ran("a1", "c1", "read", '{"path":"a.ts"}', "A"),
  stepEnded("a1", "tool_calls"),
  stepStarted("a2"),
  ...ran("a2", "c1", "read", '{"path":"b.ts"}', "B"),
  stepEnded("a2", "tool_calls"),
  stepStarted("a3"),
  say("a3", "done"),
  stepEnded("a3"),
  executionSucceeded(),
])

describe("matcher", () => {
  test("matches on tool name and canonical arguments, ignoring key order and whitespace", () => {
    const matcher = new TapeMatcher(tapeOf(severalSteps))
    matcher.takeInputs()
    const [first] = matcher.matchCalls([call("read", '{ "path" : "a.test.ts" }')])
    expect(first).toMatchObject({ kind: "matched", via: "exact", recordedStep: 0, recorded: { callId: "call_1", messageId: "a1" } })
    expect(matcher.endStep({ calls: 1, text: "" })).toMatchObject({ kind: "continue", recordedSteps: [0] })
    const [second] = matcher.matchCalls([call("write", '{"content":"expect(add(1, 1)).toBe(2)","path":"a.test.ts"}')])
    expect(second).toMatchObject({ kind: "matched", via: "exact", recorded: { messageId: "a2" } })
  })

  test("parallel calls may arrive in another order; the reordering is counted", () => {
    const matcher = new TapeMatcher(tapeOf(parallelToolCalls))
    const results = matcher.matchCalls([call("read", '{"path":"b.ts"}'), call("read", '{"path":"a.ts"}')])
    expect(results.map((result) => (result.kind === "matched" ? result.recorded.callId : result.kind))).toEqual(["call_2", "call_1"])
    expect(matcher.endStep({ calls: 2, text: "" }).kind).toBe("continue")
    expect(matcher.matched).toMatchObject({ steps: 1, calls: 2, reordered: 1 })
  })

  test("a normaliser makes a relative and an absolute path the same call; strict mode does not", () => {
    const options = { normalisers: { read: normalise.paths("path") } }
    const loose = new TapeMatcher(tapeOf(parallelToolCalls), options)
    expect(loose.matchCalls([call("read", '{"path":"/repo/a.ts"}')])[0]).toMatchObject({ kind: "matched", via: "normalised" })
    expect(loose.matched.normalised).toBe(1)

    const strict = new TapeMatcher(tapeOf(parallelToolCalls), { ...options, strict: true })
    expect(strict.matchCalls([call("read", '{"path":"/repo/a.ts"}')])[0]).toMatchObject({
      kind: "diverged",
      divergence: { kind: "arguments_differ", argumentDiff: [{ path: "path", recorded: "a.ts", replayed: "/repo/a.ts" }] },
    })
  })

  test("trailing whitespace in a command is normalised away", () => {
    const matcher = new TapeMatcher(tapeOf(severalSteps), { normalisers: { shell: normalise.trimEnd("command") } })
    matcher.matchCalls([call("read", '{"path":"a.test.ts"}')])
    matcher.endStep({ calls: 1, text: "" })
    matcher.matchCalls([call("write", '{"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}')])
    matcher.endStep({ calls: 1, text: "" })
    expect(matcher.matchCalls([call("shell", '{"command":"bun test  \\n"}')])[0]).toMatchObject({ kind: "matched", via: "normalised" })
  })

  test("a step of parallel reads may be split over two replayed steps", () => {
    const matcher = new TapeMatcher(tapeOf(parallelToolCalls))
    matcher.matchCalls([call("read", '{"path":"a.ts"}')])
    expect(matcher.endStep({ calls: 1, text: "" }).kind).toBe("continue")
    matcher.matchCalls([call("read", '{"path":"b.ts"}')])
    expect(matcher.endStep({ calls: 1, text: "" }).kind).toBe("continue")
    matcher.matchCalls([])
    expect(matcher.endStep({ calls: 0, text: "a is 1 and b is 2." }).kind).toBe("finished")
    expect(matcher.matched).toMatchObject({ steps: 2, calls: 2, splits: 1, merges: 0 })
    expect(matcher.divergence).toBeNull()
  })

  test("in strict mode a split is a divergence: recorded calls not made", () => {
    const matcher = new TapeMatcher(tapeOf(parallelToolCalls), { strict: true })
    matcher.matchCalls([call("read", '{"path":"a.ts"}')])
    expect(matcher.endStep({ calls: 1, text: "" })).toMatchObject({
      kind: "diverged",
      divergence: { kind: "missing_calls", replayStep: 0, recordedStep: 0, recorded: { kind: "calls", calls: [call("read", '{"path":"b.ts"}')] } },
    })
  })

  test("a step with a side effect is never split", () => {
    const tape = tapeOf([
      ...opening(),
      stepStarted("a1"),
      ...ran("a1", "c1", "write", '{"path":"a.ts"}', "Wrote"),
      ...ran("a1", "c2", "read", '{"path":"a.ts"}', "A"),
      stepEnded("a1", "tool_calls"),
    ])
    const matcher = new TapeMatcher(tape)
    matcher.matchCalls([call("write", '{"path":"a.ts"}')])
    expect(matcher.endStep({ calls: 1, text: "" })).toMatchObject({ kind: "diverged", divergence: { kind: "missing_calls" } })
  })

  test("two read-only steps may be merged into one replayed step", () => {
    const matcher = new TapeMatcher(twoReadSteps)
    const results = matcher.matchCalls([call("read", '{"path":"b.ts"}'), call("read", '{"path":"a.ts"}')])
    expect(results.map((result) => (result.kind === "matched" ? [result.recordedStep, result.recorded.settlement.output] : result.kind))).toEqual([
      [1, "B"],
      [0, "A"],
    ])
    expect(matcher.endStep({ calls: 2, text: "" })).toMatchObject({ kind: "continue", recordedSteps: [0, 1] })
    matcher.matchCalls([])
    expect(matcher.endStep({ calls: 0, text: "done" }).kind).toBe("finished")
    expect(matcher.matched).toMatchObject({ steps: 3, calls: 2, merges: 1 })
  })

  test("in strict mode a merge is a divergence: an extra call", () => {
    const matcher = new TapeMatcher(twoReadSteps, { boundaries: "exact" })
    const results = matcher.matchCalls([call("read", '{"path":"a.ts"}'), call("read", '{"path":"b.ts"}')])
    expect(results[1]).toMatchObject({ kind: "diverged", divergence: { kind: "extra_call", callIndex: 1, recordedStep: 0 } })
  })

  test("steps are not merged across an input that arrived between them", () => {
    const tape = tapeOf([
      ...opening(),
      stepStarted("a1"),
      ...ran("a1", "c1", "read", '{"path":"a.ts"}', "A"),
      enqueue("u2", "also b"),
      stepEnded("a1", "tool_calls"),
      deliver("u2"),
      stepStarted("a2"),
      ...ran("a2", "c1", "read", '{"path":"b.ts"}', "B"),
      stepEnded("a2", "tool_calls"),
    ])
    const results = new TapeMatcher(tape).matchCalls([call("read", '{"path":"a.ts"}'), call("read", '{"path":"b.ts"}')])
    expect(results[1]).toMatchObject({ kind: "diverged", divergence: { kind: "extra_call" } })
  })

  test("a write step and the read after it are not merged", () => {
    const tape = tapeOf([
      ...opening(),
      stepStarted("a1"),
      ...ran("a1", "c1", "write", '{"path":"a.ts"}', "Wrote"),
      stepEnded("a1", "tool_calls"),
      stepStarted("a2"),
      ...ran("a2", "c1", "read", '{"path":"a.ts"}', "new A"),
      stepEnded("a2", "tool_calls"),
    ])
    const results = new TapeMatcher(tape).matchCalls([call("write", '{"path":"a.ts"}'), call("read", '{"path":"a.ts"}')])
    expect(results[1]).toMatchObject({ kind: "diverged", divergence: { kind: "extra_call" } })
  })

  test("identical calls in one step are matched one recorded call each", () => {
    const tape = tapeOf([
      ...opening(),
      stepStarted("a1"),
      ...ran("a1", "c1", "read", '{"path":"a.ts"}', "first"),
      ...ran("a1", "c2", "read", '{"path":"a.ts"}', "second"),
      stepEnded("a1", "tool_calls"),
    ])
    const results = new TapeMatcher(tape).matchCalls([call("read", '{"path":"a.ts"}'), call("read", '{"path":"a.ts"}'), call("read", '{"path":"a.ts"}')])
    expect(results.map((result) => (result.kind === "matched" ? result.recorded.settlement.output : result.kind))).toEqual(["first", "second", "diverged"])
  })

  test("classifies divergences against the recorded step", () => {
    const at = (calls: CallShape[]) => {
      const matcher = new TapeMatcher(tapeOf(severalSteps))
      return matcher.matchCalls(calls)[calls.length - 1]
    }
    expect(at([call("shell", '{"command":"ls"}')])).toMatchObject({
      kind: "diverged",
      divergence: { kind: "different_tool", recorded: { kind: "calls", calls: [call("read", '{"path":"a.test.ts"}')] } },
    })
    expect(at([call("read", '{"path":"a.ts"}')])).toMatchObject({ divergence: { kind: "arguments_differ" } })

    const answered = new TapeMatcher(tapeOf(severalSteps))
    answered.matchCalls([])
    expect(answered.endStep({ calls: 0, text: "Nothing to do." })).toMatchObject({
      kind: "diverged",
      divergence: { kind: "text_instead_of_call", callIndex: null, replayed: { kind: "text", text: "Nothing to do." } },
    })
  })

  test("after a divergence nothing more is matched and no more inputs are given", () => {
    const matcher = new TapeMatcher(tapeOf(severalSteps))
    matcher.takeInputs()
    matcher.matchCalls([call("shell", '{"command":"ls"}')])
    expect(matcher.matchCalls([call("read", '{"path":"a.test.ts"}')])).toEqual([{ kind: "off_tape" }])
    expect(matcher.takeInputs()).toEqual([])
    expect(matcher.endStep({ calls: 2, text: "" })).toEqual({ kind: "off_tape" })
  })

  test("endStep refuses a step whose calls were not all matched", () => {
    const matcher = new TapeMatcher(tapeOf(severalSteps))
    expect(() => matcher.endStep({ calls: 1, text: "" })).toThrow("pass every call to matchCalls")
  })

  test("diffArguments reports changed, added and removed fields by path", () => {
    expect(diffArguments('{"a":1,"b":{"c":[1,2]},"d":"x"}', '{"a":1,"b":{"c":[1,3]},"e":true}')).toEqual([
      { path: "b.c[1]", recorded: 2, replayed: 3 },
      { path: "d", recorded: "x" },
      { path: "e", replayed: true },
    ])
    expect(diffArguments("{bad", "{bad")).toEqual([])
    expect(diffArguments("{bad", '{"a":1}')).toEqual([{ path: "", recorded: "{bad", replayed: '{"a":1}' }])
  })
})
