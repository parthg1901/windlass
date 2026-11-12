import { describe, expect, test } from "bun:test"
import { event, type NewEvent } from "@light-harness/core"
import { c, executionSucceeded, m, opening, say, stepStarted } from "@light-harness/core/testing/scenarios"
import { findScenario } from "../src/cli.ts"
import { summarize } from "../src/panel.ts"
import { Transcript } from "../src/transcript.ts"
import { layoutRow } from "../src/rows.ts"
import { CLOCK_START, stamp } from "./helpers.ts"

function play(events: readonly NewEvent[]): Transcript {
  const transcript = new Transcript(() => CLOCK_START)
  for (const item of stamp({ title: "t", description: "", provider: "", phases: [{ label: "p", events: [...events], expect: { execution: null } }] })) transcript.apply(item)
  return transcript
}

const usage = (inputTokens: number, cachedInputTokens: number, outputTokens = 10) => ({ inputTokens, cachedInputTokens, outputTokens, reasoningTokens: 0 })

describe("rows from a scripted turn", () => {
  test("the showcase turn: prompt, thought, text, tools in place, ending", () => {
    const transcript = new Transcript(() => CLOCK_START)
    for (const item of stamp(findScenario("find-and-fix-a-failing-test")!.scenario)) transcript.apply(item)
    const kinds = transcript.rows.map((row) => row.kind)
    expect(kinds[0]).toBe("user")
    expect(kinds.at(-1)).toBe("outcome")
    const tools = transcript.rows.filter((row) => row.kind === "tool")
    // The two parallel calls of the first step keep their order and their own outcome, whatever order they settle in.
    expect(tools.map((row) => `${row.name}:${row.outcome}`)).toEqual(["grep:success", "shell:error", "read:success", "edit:success", "shell:success"])
    const outcome = transcript.rows.at(-1)
    expect(outcome?.kind === "outcome" && outcome.steps).toBe(5)
    expect(outcome?.kind === "outcome" && [...outcome.diffs.keys()]).toEqual(["src/add.ts"])
    expect(transcript.activity.executing).toBe(false)
  })

  test("the usage of every call, summed for the session, with the share read from cache", () => {
    const transcript = new Transcript(() => CLOCK_START)
    for (const item of stamp(findScenario("find-and-fix-a-failing-test")!.scenario)) transcript.apply(item)
    const summary = summarize(transcript.calls)
    expect(summary.calls).toBe(5)
    expect(summary.total).toEqual({ inputTokens: 44_746, cachedInputTokens: 35_072, outputTokens: 396, reasoningTokens: 64 })
    expect(summary.cacheShare).toBe(78)
    expect(summary.last?.usage.inputTokens).toBe(9_410)
    expect(summary.lastCacheShare).toBe(98)
    expect(transcript.calls.map((call) => call.model)).toEqual(Array(5).fill("gpt-test"))
  })

  test("a steer waits under the conversation and becomes a user row where it is delivered", () => {
    const transcript = play([...opening("start"), stepStarted("a1")])
    transcript.apply({ ...event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "steer", content: [{ type: "text", text: "also check the docs" }] }), sessionId: "s" as never, seq: 100, time: CLOCK_START })
    expect(transcript.pending.map((item) => [item.text, item.delivery])).toEqual([["also check the docs", "steer"]])
    expect(transcript.rows.filter((row) => row.kind === "user")).toHaveLength(1)
    transcript.apply({ ...event("step.ended", { messageId: m("a1"), finish: "tool_calls", usage: null }), sessionId: "s" as never, seq: 101, time: CLOCK_START })
    transcript.apply({ ...event("inbox.delivered", { messageId: m("u2") }), sessionId: "s" as never, seq: 102, time: CLOCK_START })
    expect(transcript.pending).toHaveLength(0)
    const delivered = transcript.rows.at(-1)
    expect(delivered?.kind === "user" && [delivered.text, delivered.delivered]).toEqual(["also check the docs", "steer"])
  })

  test("a broken cache prefix marks the call it was found for", () => {
    const transcript = play([...opening("go"), stepStarted("a1"), event("step.ended", { messageId: m("a1"), finish: "tool_calls", usage: usage(1000, 0) })])
    transcript.apply({ type: "diagnostic", sessionId: "s" as never, kind: "prefix_violation", message: "the request is not the previous one plus new blocks" })
    for (const item of [stepStarted("a2"), event("step.ended", { messageId: m("a2"), finish: "stop", usage: usage(1100, 0) })]) transcript.apply({ ...item, sessionId: "s" as never, seq: 50, time: CLOCK_START } as never)
    expect(transcript.calls.map((call) => call.diagnostics)).toEqual([[], ["prefix_violation"]])
    expect(transcript.rows.some((row) => row.kind === "notice" && row.text.some((part) => part.text.includes("prompt cache")))).toBe(true)
  })

  test("an event this client does not know is a debug row, counted", () => {
    const transcript = new Transcript()
    transcript.apply({ type: "memory.recalled", sessionId: "s", seq: 1, time: 0, v: 1, data: { note: "x" } } as never)
    expect(transcript.rows.map((row) => row.kind)).toEqual(["debug"])
    expect(transcript.unknown.get("memory.recalled")).toBe(1)
  })

  test("a compaction is one row that gets its result, and its call is counted as a compaction", () => {
    const transcript = play([
      ...opening("go"),
      event("compaction.started", { messageId: m("k1"), trigger: "auto", mode: "normal", keepFromSeq: 3, prompt: "summarise", tokensBefore: 41_200 }),
      event("compaction.ended", { messageId: m("k1"), summary: "…", source: "model", detail: null, tokensAfter: 9_800, usage: usage(41_000, 40_000, 900) }),
      stepStarted("a1"),
      say("a1", "ok"),
      event("step.ended", { messageId: m("a1"), finish: "stop", usage: usage(9_900, 0) }),
      executionSucceeded(),
    ])
    const compactions = transcript.rows.filter((row) => row.kind === "notice" && row.symbol === "⇣")
    expect(compactions).toHaveLength(1)
    expect(compactions[0]!.kind === "notice" && compactions[0]!.text.map((part) => part.text).join("")).toBe("compacted the conversation · about 41,200 → 9,800 tokens")
    expect(transcript.calls.map((call) => call.kind)).toEqual(["compaction", "step"])
  })

  test("parallel calls stay where they started while they interleave", () => {
    const called = (id: string, name: string) => event("tool.called", { messageId: m("a1"), callId: c(id), name, input: JSON.stringify({ command: `run ${id}` }), providerData: null })
    const settled = (id: string) => event("tool.settled", { messageId: m("a1"), callId: c(id), outcome: "success", output: "ok", truncation: null, attachments: [], display: null })
    const transcript = play([...opening("go"), stepStarted("a1"), called("one", "shell"), called("two", "shell"), event("tool.started", { messageId: m("a1"), callId: c("one"), effect: "exec" }), event("tool.started", { messageId: m("a1"), callId: c("two"), effect: "exec" }), settled("two")])
    const tools = transcript.rows.filter((row) => row.kind === "tool")
    expect(tools.map((row) => `${row.arg}:${row.phase}`)).toEqual(["run one:running", "run two:settled"])
  })
})

describe("undo and redo", () => {
  const said = (id: string, text: string) => event("inbox.enqueued", { messageId: m(id), origin: null, delivery: "steer", content: [{ type: "text", text }] })
  const turn = (id: string, exe: string, prompt: string, answer: string) => [
    said(id, prompt),
    event("execution.started", { executionId: exe as never }),
    event("inbox.delivered", { messageId: m(id) }),
    stepStarted(`a${id}`),
    event("text.ended", { messageId: m(`a${id}`), text: answer, providerData: null }),
    event("step.ended", { messageId: m(`a${id}`), finish: "stop", usage: null }),
    event("execution.succeeded", { executionId: exe as never, verification: { status: "not_configured" } }),
  ]
  const shown = (transcript: Transcript) =>
    transcript.rows.flatMap((row) => layoutRow(row, 140, { now: CLOCK_START, debug: false, color: false })).map((line) => line.map((part) => part.text).join("").trimEnd())

  test("an undone turn is one dim line naming it; /redo shows it as before; the ending rows carry the turn number", () => {
    const first = turn("u1", "exe_1", "Write the notes.", "Wrote them.")
    const second = turn("u2", "exe_2", "Now add a test.", "Added one.")
    // created is seq 1; the second prompt is delivered at seq 11.
    const transcript = play([event("session.created", { cwd: "/w", title: null, lineage: null, settings: { model: "m", reasoningEffort: null } }), ...first, ...second])
    const before = shown(transcript)
    expect(before.filter((line) => line.includes("turn "))).toEqual(["○ done · no checks configured · 1 step · 500ms · turn 1", "○ done · no checks configured · 1 step · 500ms · turn 2"])
    transcript.apply({ ...event("history.reverted", { fromSeq: 11, restore: null }), sessionId: "s" as never, seq: 16, time: CLOCK_START })
    const undone = shown(transcript)
    expect(undone).toContain('↶ undone turn 2: "Now add a test." · out of the conversation · /redo brings it back')
    expect(undone).not.toContain("Added one.")
    expect(undone).toContain("Wrote them.")
    expect(undone.at(-1)).toBe('↶ undone: turn 2 "Now add a test." · out of the conversation · no file was restored · /redo brings it back')
    transcript.apply({ ...event("history.restored", { revertSeq: 16, restore: null }), sessionId: "s" as never, seq: 17, time: CLOCK_START })
    const redone = shown(transcript)
    expect(redone).toContain("Added one.")
    expect(redone.at(-1)).toBe('↷ redone: turn 2 "Now add a test." · back in the conversation · no file was restored')
  })
})

describe("a steered message", () => {
  test("says how it reached the agent in full, on its own line when the message fills the width", () => {
    const transcript = play([...opening("start"), stepStarted("a1")])
    const text = "also tell me the test's name and where the fixture for it lives"
    transcript.apply({ ...event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "steer", content: [{ type: "text", text }] }), sessionId: "s" as never, seq: 100, time: CLOCK_START })
    transcript.apply({ ...event("inbox.delivered", { messageId: m("u2") }), sessionId: "s" as never, seq: 101, time: CLOCK_START })
    const row = transcript.rows.at(-1)!
    const at = (columns: number) => layoutRow(row, columns, { now: CLOCK_START, debug: false, color: false }).map((line) => line.map((part) => part.text).join(""))
    expect(at(120)).toEqual([`› ${text}  ↳ steered into the turn`])
    expect(at(78)).toEqual([`› ${text}`, "  ↳ steered into the turn"])
    expect(at(78).every((line) => Bun.stringWidth(line) <= 78)).toBe(true)
  })
})
