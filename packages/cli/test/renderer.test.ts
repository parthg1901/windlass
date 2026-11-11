import { describe, expect, test } from "bun:test"
import { type EphemeralEvent, type NewEvent, type SessionId, event, text } from "@light-harness/core"
import { c, m, opening, stepStarted } from "../../core/test/scenarios/script.ts"
import { demoScenarios } from "../src/demo/scenarios.ts"
import { scriptTurns } from "../src/fake-engine.ts"
import { displayWidth, stripAnsi } from "../src/text.ts"
import { render, runCli, stored, withoutDurations } from "./helpers.ts"

const SESSION = "ses_test" as SessionId
const delta = (messageId: string, value: string): EphemeralEvent => ({ type: "text.delta", sessionId: SESSION, messageId: m(messageId), text: value })
const thinking = (messageId: string, value: string): EphemeralEvent => ({ type: "reasoning.delta", sessionId: SESSION, messageId: m(messageId), text: value })
const said = (messageId: string, value: string) => event("text.ended", { messageId: m(messageId), text: value, providerData: null })
const call = (messageId: string, callId: string, name: string, input: object) =>
  event("tool.called", { messageId: m(messageId), callId: c(callId), name, input: JSON.stringify(input), providerData: null })
const start = (messageId: string, callId: string) => event("tool.started", { messageId: m(messageId), callId: c(callId) })
const settle = (messageId: string, callId: string, outcome: "success" | "error" | "not_started" | "effect_unknown", output: string, display: NewEvent<"tool.settled">["data"]["display"] = null) =>
  event("tool.settled", { messageId: m(messageId), callId: c(callId), outcome, output, truncation: null, attachments: [], display })
const SGR = /\x1b\[[0-9;]*m/

describe("streamed text", () => {
  test("text streamed as deltas is not printed again when text.ended arrives", () => {
    const [a, b, ended] = stored([...opening(), stepStarted("a1"), said("a1", "Hello, world.")]).slice(-3)
    const out = render([a!, b!, delta("a1", "Hello, "), delta("a1", "world."), ended!])
    expect(out.split("Hello, world.").length - 1).toBe(1)
    expect(out.endsWith("Hello, world.\n")).toBe(true)
  })

  test("text.ended completes a stream that missed its last deltas, without repeating the start", () => {
    const events = stored([stepStarted("a1"), said("a1", "Hello, world.")])
    const out = render([events[0]!, delta("a1", "Hel"), events[1]!])
    expect(out).toBe("Hello, world.\n")
  })

  test("every scenario replayed with deltas by the fake engine prints what its durable events alone print", async () => {
    for (const entry of demoScenarios) {
      const replay = await runCli(["--demo", entry.name, "--demo-speed", "0"])
      const script = scriptTurns(entry.scenario)
      const expected = render(stored([...script.preamble, ...script.turns.flatMap((turn) => turn.events.map((planned) => planned.event))]))
      expect(withoutDurations(replay.out), entry.name).toBe(withoutDurations(expected))
    }
  })

  test("escape sequences in model text are not passed to the terminal", () => {
    const out = render(stored([stepStarted("a1"), said("a1", "red \x1b[31mtext\x1b[0m and a bell\x07")]))
    expect(out).toBe("red text and a bell\n")
  })
})

describe("reasoning", () => {
  const events = () => {
    const [step, ended] = stored([stepStarted("a1"), event("reasoning.ended", { messageId: m("a1"), text: "**Plan**\n\nRead the test, then fix it.", providerData: null })])
    return [step!, thinking("a1", "**Plan**\n\n"), thinking("a1", "Read the test, then fix it."), ended!]
  }

  test("is collapsed to one dimmed line by default", () => {
    expect(render(events())).toBe("∴ thought · Plan\n")
    expect(render(events(), { color: true })).toBe("\x1b[2m∴ thought\x1b[22m\x1b[2m · Plan\x1b[22m\n")
  })

  test("is streamed in full with --show-reasoning, once", () => {
    expect(render(events(), { showReasoning: true })).toBe("∴ **Plan**\n\nRead the test, then fix it.\n")
  })
})

describe("tool calls", () => {
  test("one call gets a start line and a short outcome line under it", () => {
    const out = render(stored([stepStarted("a1"), call("a1", "c1", "read", { path: "src/a.ts" }), start("a1", "c1"), settle("a1", "c1", "success", "x", { path: "src/a.ts", lines: 40, totalLines: 120 })]))
    expect(out).toBe("▸ read src/a.ts\n  ✓ 40 lines of 120 · 100ms\n")
  })

  test("interleaved parallel calls each name themselves on their outcome line", () => {
    const out = render(
      stored([
        stepStarted("a1"),
        call("a1", "c1", "shell", { command: "bun test" }),
        call("a1", "c2", "grep", { pattern: "TODO", path: "src" }),
        call("a1", "c3", "glob", { pattern: "**/*.md" }),
        start("a1", "c1"),
        start("a1", "c2"),
        start("a1", "c3"),
        settle("a1", "c3", "success", "a.md", { matches: 7 }),
        settle("a1", "c2", "success", "", { matches: 0, files: 0, engine: "pure" }),
        settle("a1", "c1", "success", "12 pass\n0 fail", { exitCode: 0, signal: null, timedOut: false, interrupted: null }),
      ]),
    )
    expect(out).toBe(
      [
        "▸ shell bun test",
        "▸ grep TODO in src",
        "▸ glob **/*.md",
        "  ✓ glob **/*.md · 7 files · 100ms",
        "  ✓ grep TODO in src · no matches · 300ms",
        "  ✓ shell bun test · exit 0 · 500ms",
        "    12 pass",
        "    0 fail",
        "",
      ].join("\n"),
    )
  })

  test("the outcome names the call when another line came in between", () => {
    const out = render(
      stored([
        ...opening(),
        stepStarted("a1"),
        call("a1", "c1", "read", { path: "a.ts" }),
        start("a1", "c1"),
        event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "steer", content: text("Also b.ts") }),
        settle("a1", "c1", "success", "x"),
      ]),
    )
    expect(out).toContain('↳ steer: "Also b.ts" · delivered at the next step\n  ✓ read a.ts · 1 line · 200ms\n')
  })

  test("edits show their diff summary, failures their reason, and loop-decided outcomes their own wording", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n d"
    const out = render(
      stored([
        stepStarted("a1"),
        call("a1", "c1", "edit", { path: "x.ts", old_string: "a", new_string: "b\nc" }),
        start("a1", "c1"),
        settle("a1", "c1", "success", "Edited x.ts", { path: "x.ts", replacements: 1, diff }),
        call("a1", "c2", "read", { path: "missing.ts" }),
        start("a1", "c2"),
        settle("a1", "c2", "error", "File not found: missing.ts"),
        call("a1", "c3", "write", { path: "y.ts", content: "" }),
        start("a1", "c3"),
        settle("a1", "c3", "effect_unknown", "Started, but stopped before it reported a result."),
        call("a1", "c4", "shell", { command: "rm -rf build" }),
        settle("a1", "c4", "not_started", "Not run: the response was stopped before this call started."),
      ]),
    )
    expect(out).toBe(
      [
        "▸ edit x.ts",
        "  ✓ +2 -1 · 100ms",
        "▸ read missing.ts",
        "  ✗ failed · 100ms",
        "    File not found: missing.ts",
        "▸ write y.ts",
        "  ⚠ outcome unknown · it may have taken effect · 100ms",
        "▸ shell rm -rf build",
        "  ○ not run · stopped before it started",
        "",
      ].join("\n"),
    )
  })

  test("a command's preview keeps the end of its output, and capped output says where the rest is", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
    const events = stored([
      stepStarted("a1"),
      call("a1", "c1", "shell", { command: "make" }),
      start("a1", "c1"),
      event("tool.settled", {
        messageId: m("a1"),
        callId: c("c1"),
        outcome: "error",
        output: `${output}\n[Exit code 2]`,
        truncation: { originalBytes: 90_000, originalLines: 3_000, spillPath: "/tmp/spill/make.log" },
        attachments: [],
        display: { exitCode: 2, signal: null, timedOut: false, interrupted: null },
      }),
    ])
    expect(render(events)).toBe(
      ["▸ shell make", "  ✗ exit 2 · 100ms", "    … 26 earlier lines", "    line 27", "    line 28", "    line 29", "    line 30", "    output capped · 3,000 lines in full: /tmp/spill/make.log", ""].join("\n"),
    )
  })
})

describe("width", () => {
  test("no line is wider than the terminal except model text", () => {
    const long = "a-very-long-directory-name/".repeat(6)
    const model = "The model may write a long line that the terminal wraps itself, and that is never cut by the renderer."
    const events = stored([
      ...opening(),
      stepStarted("a1"),
      said("a1", model),
      call("a1", "c1", "shell", { command: `cd ${long} && bun test --coverage --reporter=junit` }),
      call("a1", "c2", "read", { path: `${long}file.ts` }),
      start("a1", "c1"),
      start("a1", "c2"),
      settle("a1", "c2", "error", `File not found: ${long}file.ts`),
      settle("a1", "c1", "success", `${long}\n${long}`, { exitCode: 0, signal: null, timedOut: false, interrupted: null }),
      event("step.ended", { messageId: m("a1"), finish: "stop", usage: { inputTokens: 123_456, cachedInputTokens: 100_000, outputTokens: 4_321, reasoningTokens: 1_000 } }),
      event("execution.failed", { executionId: "exe_1" as never, message: `Something went wrong while talking to the provider: ${long}` }),
    ])
    for (const columns of [24, 40, 80]) {
      const out = render(events, { columns: () => columns, color: true })
      const lines = out.split("\n").map(stripAnsi)
      expect(lines).toContain(model)
      for (const line of lines.filter((line) => line !== model)) expect(displayWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns)
      expect(out).toContain("…")
    }
  })

  test("the reason a turn failed is wrapped, never cut", () => {
    const events = stored([
      ...opening(),
      event("execution.failed", { executionId: "exe_1" as never, message: "Gave up after the harness restarted 3 times during this turn." }),
    ])
    expect(render(events, { columns: () => 40 }).split("\n").slice(-4)).toEqual(["✗ failed", "  Gave up after the harness restarted 3", "  times during this turn.", ""])
  })
})

describe("colour", () => {
  test("is off when stdout is not a terminal", async () => {
    const result = await runCli(["--demo", "find-and-fix-a-failing-test", "--demo-speed", "0"], { stdoutTTY: false })
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("\x1b")
  })

  test("is on for a terminal, and off for a terminal when NO_COLOR is set", async () => {
    const tty = await runCli(["--demo", "a-plain-answer", "--demo-speed", "0"], { stdoutTTY: true })
    expect(tty.out).toMatch(SGR)
    const noColor = await runCli(["--demo", "a-plain-answer", "--demo-speed", "0"], { stdoutTTY: true, env: { NO_COLOR: "1" } })
    expect(noColor.out).not.toMatch(SGR)
    const empty = await runCli(["--demo", "a-plain-answer", "--demo-speed", "0"], { stdoutTTY: true, env: { NO_COLOR: "" } })
    expect(empty.out).toMatch(SGR)
  })
})

describe("turn summary", () => {
  test("shows the usage of every step of the turn with the cached share", () => {
    const usage = (input: number, cached: number, output: number) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: 0 })
    const out = render(
      stored([
        ...opening(),
        stepStarted("a1"),
        event("step.ended", { messageId: m("a1"), finish: "tool_calls", usage: usage(10_000, 0, 200) }),
        stepStarted("a2"),
        said("a2", "Done."),
        event("step.ended", { messageId: m("a2"), finish: "stop", usage: usage(10_500, 9_984, 40) }),
        event("execution.succeeded", { executionId: "exe_1" as never }),
      ]),
    )
    expect(out.split("\n").slice(-3)).toEqual(["✓ done · 2 steps · 800ms", "  tokens · 20,500 in · 9,984 cached (49%) · 240 out", ""])
  })

  test("has no usage line when no step reported usage", () => {
    const out = render(stored([...opening(), stepStarted("a1"), event("step.failed", { messageId: m("a1"), error: { kind: "interrupted", reason: "user" }, usage: null }), event("execution.interrupted", { executionId: "exe_1" as never, reason: "user" })]))
    expect(out).toBe("› Fix the failing test.\n\n■ interrupted · 500ms\n")
  })
})
