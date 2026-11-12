import { describe, expect, test } from "bun:test"
import { event, type NewEvent } from "@windlass/core"
import { c, executionSucceeded, m, opening, say, stepStarted } from "@windlass/core/testing/scenarios"
import { findScenario } from "../src/cli.ts"
import { summarize } from "../src/panel.ts"
import { Transcript, instructionStart } from "../src/transcript.ts"
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

  test("what the engine says about the project's configuration marks no call: a server waiting for approval is not a fault of the request", () => {
    const transcript = new Transcript(() => CLOCK_START)
    const said = (kind: string) => transcript.apply({ type: "diagnostic", sessionId: "s" as never, kind, message: `about ${kind}` } as never)
    // Before the first call (at open), and while a call runs.
    said("mcp")
    said("skills")
    for (const item of stamp(findScenario("find-and-fix-a-failing-test")!.scenario)) {
      transcript.apply(item)
      if (item.type === "step.started") for (const kind of ["mcp", "hooks", "skills", "memory", "wake", "watch"]) said(kind)
    }
    expect(transcript.calls.length).toBeGreaterThan(1)
    expect(transcript.calls.every((call) => call.diagnostics.length === 0)).toBe(true)
    // Each is still said on a row of its own.
    expect(transcript.rows.filter((row) => row.kind === "notice" && row.text.some((part) => part.text.startsWith("about mcp"))).length).toBeGreaterThan(1)
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

  test("a compaction that retired images of kept tool results says how many on its row", () => {
    const transcript = play([
      ...opening("go"),
      event("compaction.started", { messageId: m("k1"), trigger: "auto", mode: "normal", keepFromSeq: 3, prompt: "summarise", tokensBefore: 41_200 }),
      event("compaction.ended", {
        messageId: m("k1"),
        summary: "…",
        source: "model",
        detail: null,
        tokensAfter: 9_800,
        usage: null,
        retired: [
          { messageId: m("a0"), callId: c("r1"), images: 2, note: "(2 images of this result are no longer shown.)" },
          { messageId: m("a0"), callId: c("r2"), images: 1, note: "(1 image of this result is no longer shown.)" },
        ],
      }),
    ])
    const row = transcript.rows.find((candidate) => candidate.kind === "notice" && candidate.symbol === "⇣")
    expect(row?.kind === "notice" && row.text.map((part) => part.text).join("")).toBe("compacted the conversation · about 41,200 → 9,800 tokens · 3 images of earlier tool results no longer sent")
  })

  test("parallel calls stay where they started while they interleave", () => {
    const called = (id: string, name: string) => event("tool.called", { messageId: m("a1"), callId: c(id), name, input: JSON.stringify({ command: `run ${id}` }), providerData: null })
    const settled = (id: string) => event("tool.settled", { messageId: m("a1"), callId: c(id), outcome: "success", output: "ok", truncation: null, attachments: [], display: null })
    const transcript = play([...opening("go"), stepStarted("a1"), called("one", "shell"), called("two", "shell"), event("tool.started", { messageId: m("a1"), callId: c("one"), effect: "exec" }), event("tool.started", { messageId: m("a1"), callId: c("two"), effect: "exec" }), settled("two")])
    const tools = transcript.rows.filter((row) => row.kind === "tool")
    expect(tools.map((row) => `${row.arg}:${row.phase}`)).toEqual(["run one:running", "run two:settled"])
  })
})

describe("a turn that a queued message follows", () => {
  const shown = (transcript: Transcript) =>
    transcript.rows.flatMap((row) => layoutRow(row, 140, { now: CLOCK_START, debug: false, color: false })).map((line) => line.map((part) => part.text).join("").trimEnd())
  const message = (id: string, text: string, delivery: "steer" | "queue") => event("inbox.enqueued", { messageId: m(id), origin: null, delivery, content: [{ type: "text", text }] })

  test("each turn has its own ending row, with its own steps, time, tokens and files; the queued message stands between them", () => {
    const transcript = play([
      event("session.created", { cwd: "/w", title: null, lineage: null, settings: { model: "m", reasoningEffort: null } }),
      message("u1", "Write the notes.", "steer"),
      event("execution.started", { executionId: "exe_1" as never }),
      event("inbox.delivered", { messageId: m("u1") }),
      stepStarted("a1"),
      event("tool.called", { messageId: m("a1"), callId: c("w1"), name: "write", input: JSON.stringify({ path: "notes.md", content: "one\n" }), providerData: null }),
      event("tool.settled", { messageId: m("a1"), callId: c("w1"), outcome: "success", output: "Wrote notes.md", truncation: null, attachments: [], display: null }),
      event("step.ended", { messageId: m("a1"), finish: "tool_calls", usage: usage(1000, 0, 20) }),
      stepStarted("a2"),
      say("a2", "Wrote them."),
      event("step.ended", { messageId: m("a2"), finish: "stop", usage: usage(1100, 1000, 5) }),
      message("u2", "Now the tests.", "queue"),
      event("turn.ended", { verification: { status: "not_configured" } }),
      event("inbox.delivered", { messageId: m("u2") }),
      stepStarted("a3"),
      say("a3", "They pass."),
      event("step.ended", { messageId: m("a3"), finish: "stop", usage: usage(1200, 1100, 7) }),
      event("execution.succeeded", { executionId: "exe_1" as never, verification: { status: "not_configured" } }),
    ])
    const lines = shown(transcript)
    const first = lines.findIndex((line) => line.includes("turn 1"))
    expect(lines[first]).toBe("○ done · no checks configured · 2 steps · 1.0s · turn 1 · on to the queued message")
    expect(lines[first + 1]).toBe("  edited 1 file: notes.md (from its tool calls) · Ctrl-O for diffs")
    expect(lines[first + 2]).toContain("tokens · 2,100 in · 1,000 cached")
    expect(lines[first + 3]).toBe("› Now the tests.  ↳ delivered from the queue")
    expect(lines.at(-2)).toBe("○ done · no checks configured · 1 step · 500ms · turn 2")
    expect(lines.at(-1)).toContain("tokens · 1,200 in · 1,100 cached")
    // Two ending rows and no other line about the first turn's end.
    expect(lines.filter((line) => line.includes("done ·"))).toHaveLength(2)
    expect(transcript.activity.executing).toBe(false)
    // Narrow, the key that shows the diffs goes to the next row whole.
    const ending = transcript.rows.find((row) => row.kind === "outcome")!
    const narrow = layoutRow(ending, 58, { now: CLOCK_START, debug: false, color: false }).map((line) => line.map((part) => part.text).join("").trimEnd())
    expect(narrow.some((line) => line.trim() === "Ctrl-O for diffs" || line.endsWith("· Ctrl-O for diffs"))).toBe(true)
  })

  test("what the first turn rests on is on its own row: checks that passed, failing ones left unresolved, a stop hook that still objected", () => {
    const until = (ended: NewEvent) => [
      message("u1", "Fix it.", "steer"),
      event("execution.started", { executionId: "exe_1" as never }),
      event("inbox.delivered", { messageId: m("u1") }),
      stepStarted("a1"),
      say("a1", "Fixed."),
      event("step.ended", { messageId: m("a1"), finish: "stop", usage: null }),
      message("u2", "And the docs.", "queue"),
      ended,
      event("inbox.delivered", { messageId: m("u2") }),
    ]
    expect(shown(play(until(event("turn.ended", { verification: { status: "passed", checks: ["test"] } as never }))))).toContain("✓ done · checks passed · 1 step · 600ms · turn 1 · on to the queued message")
    const hooked = shown(play(until(event("turn.ended", { verification: { status: "not_configured" }, hooks: { unsatisfied: ["tidy"], objections: [{ hook: "tidy", text: "The tree is not clean." }] } }))))
    expect(hooked.some((line) => line.startsWith("⚠ ") && line.includes('"tidy"') && line.endsWith("turn 1 · on to the queued message"))).toBe(true)
    expect(hooked.some((line) => line.includes("The tree is not clean."))).toBe(true)
  })
})

describe("a line of the interface's own at a turn's end", () => {
  const texts = (transcript: Transcript) => transcript.rows.flatMap((row) => layoutRow(row, 140, { now: CLOCK_START, debug: false, color: false })).map((line) => line.map((part) => part.text).join("").trimEnd())

  test("a command's answer that arrives after the turn's last row stands under the ending row; one from the middle of the turn, and a line about the stop, stay where they are", () => {
    const transcript = new Transcript(() => CLOCK_START)
    let seq = 0
    const apply = (...events: NewEvent[]) => {
      for (const item of events) transcript.apply({ ...item, sessionId: "s" as never, seq: ++seq, time: CLOCK_START + seq * 100 } as never)
    }
    apply(...opening("go"), stepStarted("a1"))
    transcript.note("Skills (0): typed while the model was thinking")
    apply(say("a1", "All done."), event("step.ended", { messageId: m("a1"), finish: "stop", usage: null }))
    transcript.note("renamed: Login bug")
    transcript.note("■ still stopping… press Ctrl-C again to exit now", "warn", "!", [], "work")
    transcript.note("Memory is off.")
    transcript.note("no tool call is running")
    apply(executionSucceeded())
    const lines = texts(transcript)
    const at = (text: string) => lines.findIndex((line) => line.includes(text))
    expect(at("typed while the model was thinking")).toBeLessThan(at("All done."))
    expect(at("renamed: Login bug")).toBeLessThan(at("still stopping"))
    expect(at("still stopping")).toBeLessThan(at("○ done"))
    expect(lines.slice(at("○ done") + 1)).toEqual(["· Memory is off.", "· no tool call is running"])
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

  test("a second /undo names only the turn it took out, and its /redo only the turn it put back", () => {
    const first = turn("u1", "exe_1", "Write the notes.", "Wrote them.")
    const second = turn("u2", "exe_2", "Now add a test.", "Added one.")
    const transcript = play([event("session.created", { cwd: "/w", title: null, lineage: null, settings: { model: "m", reasoningEffort: null } }), ...first, ...second])
    const stored = (type: "history.reverted" | "history.restored", data: object, seq: number) => ({ ...event(type, data as never), sessionId: "s" as never, seq, time: CLOCK_START })
    transcript.apply(stored("history.reverted", { fromSeq: 11, restore: null }, 16) as never)
    // The first prompt is delivered at seq 4: this one takes turn 1 out, turn 2 being out already.
    transcript.apply(stored("history.reverted", { fromSeq: 4, restore: null }, 17) as never)
    expect(shown(transcript).at(-1)).toBe('↶ undone: turn 1 "Write the notes." · out of the conversation · no file was restored · /redo brings it back')
    transcript.apply(stored("history.restored", { revertSeq: 17, restore: null }, 18) as never)
    const back = shown(transcript)
    expect(back.at(-1)).toBe('↷ redone: turn 1 "Write the notes." · back in the conversation · no file was restored')
    expect(back).toContain("Wrote them.")
    expect(back).not.toContain("Added one.")
  })
})

describe("undo and redo of a turn that changed no file", () => {
  test("says that no file needed to change, not a count of none", () => {
    const said = event("inbox.enqueued", { messageId: m("u1"), origin: null, delivery: "steer", content: [{ type: "text", text: "What is this?" }] })
    const transcript = play([event("session.created", { cwd: "/w", title: null, lineage: null, settings: { model: "m", reasoningEffort: null } }), said, event("execution.started", { executionId: "exe_1" as never }), event("inbox.delivered", { messageId: m("u1") }), event("execution.succeeded", { executionId: "exe_1" as never, verification: { status: "not_configured" } })])
    const restore = { target: "a".repeat(40), before: "b".repeat(40), after: "a".repeat(40), written: 0, removed: 0, changed: 0, kept: [], keptOmitted: 0 }
    const last = () => layoutRow(transcript.rows.at(-1)!, 140, { now: CLOCK_START, debug: false, color: false }).map((line) => line.map((part) => part.text).join("").trimEnd())
    transcript.apply({ ...event("history.reverted", { fromSeq: 3, restore } as never), sessionId: "s" as never, seq: 6, time: CLOCK_START })
    expect(last()).toEqual(['↶ undone: turn 1 "What is this?" · out of the conversation · no file needed to change · /redo brings it back'])
    transcript.apply({ ...event("history.restored", { revertSeq: 6, restore } as never), sessionId: "s" as never, seq: 7, time: CLOCK_START })
    expect(last()).toEqual(['↷ redone: turn 1 "What is this?" · back in the conversation · no file needed to change'])
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

describe("a message with indented lines", () => {
  test("an indented line goes on under its own text when it wraps", () => {
    const transcript = play([...opening("start")])
    const text = "Review of the changes in turn 2: 1 comment on 1 file.\n\n1. src/parse.ts, line 15 (added)\n   >   return text.split(\"\\n\").filter((line) => line.trim() !== \"\").map(parseLine)"
    transcript.apply({ ...event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "steer", content: [{ type: "text", text }] }), sessionId: "s" as never, seq: 100, time: CLOCK_START })
    transcript.apply({ ...event("inbox.delivered", { messageId: m("u2") }), sessionId: "s" as never, seq: 101, time: CLOCK_START })
    const lines = layoutRow(transcript.rows.at(-1)!, 60, { now: CLOCK_START, debug: false, color: false }).map((line) => line.map((part) => part.text).join(""))
    const quote = lines.findIndex((line) => line.startsWith("     >   return"))
    expect(quote).toBeGreaterThan(-1)
    expect(lines[quote + 1]).toMatch(/^ {5}\S/)
  })
})

describe("an instruction update", () => {
  const INDEX = [
    "Agents you can run a subagent as:",
    '<agents lines="3">',
    "An agent is a role kept as a file: instructions, and sometimes a model and restrictions.",
    "",
    "- reviewer (read only): Reads the code and reports problems; changes nothing",
    "</agents>",
  ].join("\n")

  test("is one row: how it begins, how much more the model was given, and the command that lists the same", () => {
    const transcript = play([event("instruction.appended", { messageId: m("n1"), source: "agent-index", text: INDEX, fingerprint: "aaa" })])
    const row = transcript.rows.find((candidate) => candidate.kind === "notice")!
    const lines = layoutRow(row, 120, { now: CLOCK_START, debug: false, color: false }).map((line) => line.map((part) => part.text).join(""))
    expect(lines).toEqual(["· instructions updated (agent-index): Agents you can run a subagent as: … · 4 more lines · /agent lists them"])
    expect(lines.join("")).not.toContain("<agents")
  })

  test("a one-line update is said whole, and a source with no command of its own names none", () => {
    expect(instructionStart("agent-index", "3 agents: reviewer, docs, tester")).toBe("3 agents: reviewer, docs, tester")
    expect(instructionStart("agents:src/AGENTS.md", "Use tabs.\nNo semicolons.")).toBe("Use tabs. … · 1 more line")
  })
})
