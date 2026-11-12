import { describe, expect, test } from "bun:test"
import { type EphemeralEvent, type NewEvent, type ProviderErrorKind, type SessionId, brand, event, makeProviderError, text } from "@windlass/core"
import { c, m, opening, stepStarted, synthetic } from "@windlass/core/testing/scenarios"
import { demoScenarios } from "../src/demo/scenarios.ts"
import { scriptTurns } from "../src/fake-engine.ts"
import { displayWidth, stripAnsi } from "../src/text.ts"
import { PrettyRenderer, excerpt } from "../src/renderer.ts"
import { render, runCli, stored, withoutDurations } from "./helpers.ts"

const SESSION = "ses_test" as SessionId
const delta = (messageId: string, value: string): EphemeralEvent => ({ type: "text.delta", sessionId: SESSION, messageId: m(messageId), text: value })
const thinking = (messageId: string, value: string): EphemeralEvent => ({ type: "reasoning.delta", sessionId: SESSION, messageId: m(messageId), text: value })
const said = (messageId: string, value: string) => event("text.ended", { messageId: m(messageId), text: value, providerData: null })
const call = (messageId: string, callId: string, name: string, input: object) =>
  event("tool.called", { messageId: m(messageId), callId: c(callId), name, input: JSON.stringify(input), providerData: null })
const start = (messageId: string, callId: string, effect: "read" | "write" | "exec" = "read") =>
  event("tool.started", { messageId: m(messageId), callId: c(callId), effect })
const settle = (messageId: string, callId: string, outcome: "success" | "error" | "not_started" | "effect_unknown", output: string, display: NewEvent<"tool.settled">["data"]["display"] = null) =>
  event("tool.settled", { messageId: m(messageId), callId: c(callId), outcome, output, truncation: null, attachments: [], display })
const SGR = /\x1b\[[0-9;]*m/
const brandBinary = brand.binary
const providerError = (kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number, requestId: string | null = null, reason?: "connection" | "stalled") =>
  makeProviderError(kind, message, { ...(status === undefined ? {} : { status }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }), requestId, ...(reason === undefined ? {} : { reason }) })

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
    expect(out).toContain('↳ sent: "Also b.ts" · the agent will see it after the current step\n  ✓ read a.ts · 1 line · 200ms\n')
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
      ["▸ shell make", "  ✗ exit 2 · 100ms", "    … 26 earlier lines", "    line 27", "    line 28", "    line 29", "    line 30", "    output capped · 3,000 lines in full:", "      /tmp/spill/make.log", ""].join("\n"),
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
        event("execution.succeeded", { executionId: "exe_1" as never, verification: { status: "not_configured" } }),
      ]),
    )
    expect(out.split("\n").slice(-3)).toEqual(["✓ done · no checks configured · 2 steps · 800ms", "  tokens · 20,500 in · 9,984 cached (49%) · 240 out", ""])
  })

  test("has no usage line when no step reported usage", () => {
    const out = render(stored([...opening(), stepStarted("a1"), event("step.failed", { messageId: m("a1"), error: { kind: "interrupted", reason: "user" }, usage: null }), event("execution.interrupted", { executionId: "exe_1" as never, reason: "user" })]))
    expect(out).toBe("› Fix the failing test.\n\n■ interrupted · 500ms\n")
  })
})

describe("events the core added", () => {
  const exe = "exe_1" as never
  const failedWith = (error: ReturnType<typeof providerError>) => [
    ...opening(),
    stepStarted("a1"),
    event("step.failed", { messageId: m("a1"), error: { kind: "provider", error }, usage: null }),
    event("execution.failed", { executionId: exe, message: "The model call failed: it went wrong." }),
  ]

  test("a failure line carries the provider's request ID, on a line of its own", () => {
    const out = render(stored(failedWith(providerError("provider_internal", "boom", 500, undefined, "req_7f3a"))))
    expect(out.split("\n").slice(-3)).toEqual(["✗ failed (provider_internal): The model call failed: it went wrong.", "  request req_7f3a", ""])
    expect(render(stored(failedWith(providerError("provider_internal", "boom", 500))))).not.toContain("request ")
  })

  test("--quiet puts the request ID in the failure message on stderr", async () => {
    // Exercised through the sink directly: no scenario fails with a request ID.
    const { QuietSink } = await import("../src/renderer.ts")
    let out = ""
    let err = ""
    const sink = new QuietSink((text) => (out += text), (text) => (err += text))
    for (const item of stored(failedWith(providerError("rate_limit", "slow down", 429, undefined, "req_9")))) sink.event(item)
    expect(out).toBe("")
    expect(err).toBe("windlass: failed: The model call failed: it went wrong. (request req_9)\n".replace("windlass", brandBinary))
  })

  test("a stalled connection is named as such on the retry line", () => {
    const stalled = providerError("transport", "no data for 60 s", undefined, undefined, null, "stalled")
    const out = render(stored([...opening(), stepStarted("a1"), event("retry.scheduled", { messageId: m("a1"), attempt: 2, delayMs: 2000, error: stalled })]))
    expect(out).toContain("↻ retrying in 2.0s (attempt 2) · the connection stalled: no data for 60 s\n")
  })

  test("a model or effort change shows what changed", () => {
    const out = render(
      stored([
        ...opening(),
        event("settings.changed", { model: "gpt-other", reasoningEffort: "medium" }),
        event("settings.changed", { model: "gpt-other", reasoningEffort: "high" }),
        event("settings.changed", { model: "gpt-mini", reasoningEffort: null }),
      ]),
    )
    expect(out).toContain(
      ["⇄ model gpt-test → gpt-other · from the next step", "⇄ effort medium → high · from the next step", "⇄ model gpt-other → gpt-mini · effort high → default · from the next step", ""].join("\n"),
    )
  })

  test("instruction files are named once per baseline, and a removed source says so", () => {
    const base = (sources: string[]) =>
      event("baseline.set", { instructions: "x", tools: [], sources: sources.map((source) => ({ source, fingerprint: "f" })) })
    const out = render(
      stored([
        base(["date", "agents:AGENTS.md", "agents:src/AGENTS.md"]),
        base(["date", "agents:AGENTS.md", "agents:src/AGENTS.md"]),
        event("instruction.appended", { messageId: m("i1"), source: "agents:src/AGENTS.md", text: "", fingerprint: null }),
      ]),
    )
    expect(out).toBe("· instructions from AGENTS.md, src/AGENTS.md\n· instructions removed: src/AGENTS.md\n")
  })

  test("the stop request is shown when it is written, with the exit hint when this CLI asked for it", () => {
    const events = stored([...opening(), stepStarted("a1"), event("execution.interrupt_requested", { executionId: exe, reason: "user" })])
    expect(render(events).split("\n").at(-2)).toBe("■ stopping…")
    let out = ""
    const renderer = new PrettyRenderer({ write: (text) => (out += text), color: false, columns: () => 80, live: false, showReasoning: false, echoPrompts: false })
    renderer.interruptRequested()
    for (const item of events) renderer.event(item)
    renderer.interruptRequested()
    expect(out).toBe("■ stopping… press Ctrl-C again to exit now\n■ still stopping… press Ctrl-C again to exit now\n")
  })

  test("text that a provider error cut off continues after the note, marked as a continuation", () => {
    const out = render(
      stored([
        ...opening(),
        stepStarted("a1"),
        said("a1", "Let me look at the"),
        event("step.failed", { messageId: m("a1"), error: { kind: "provider", error: providerError("provider_internal", "oops", 500) }, usage: null }),
        event("retry.scheduled", { messageId: m("a1"), attempt: 2, delayMs: 2000, error: providerError("provider_internal", "oops", 500) }),
        synthetic("s1", "continuation", "Continue."),
        stepStarted("a2", 2),
      ]),
    )
    const [step] = stored([said("a2", " test first.")])
    expect(out + render([delta("a2", " test"), delta("a2", " first."), step!], {})).toContain("↻ asking the model to continue where it was cut off\n")
    // Within one renderer: the continuation's leading space is dropped and the block starts with an ellipsis.
    let text = ""
    const renderer = new PrettyRenderer({ write: (value) => (text += value), color: false, columns: () => 80, live: false, showReasoning: false, echoPrompts: false })
    for (const item of [...stored([...opening(), stepStarted("a1"), synthetic("s1", "continuation", "Continue."), stepStarted("a2")]), delta("a2", " test"), delta("a2", " first.")]) renderer.event(item)
    expect(text.endsWith("\n… test first.")).toBe(true)
  })

  test("a line that arrives while text streams does not split the text silently", () => {
    const events = stored([...opening(), stepStarted("a1")])
    const [enqueued] = stored([event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "steer", content: text("Also b.ts") })]).map((item) => ({ ...item, seq: 99 }))
    const out = render([...events, delta("a1", "Reading a."), enqueued!, delta("a1", "ts now.")])
    expect(out).toContain('Reading a.\n\n↳ sent: "Also b.ts" · the agent will see it after the current step\n\n… ts now.')
  })

  test("messages still waiting when a turn is interrupted are counted", () => {
    const out = render(
      stored([
        ...opening(),
        stepStarted("a1"),
        event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "queue", content: text("Then the changelog.") }),
        event("execution.interrupt_requested", { executionId: exe, reason: "user" }),
        event("step.failed", { messageId: m("a1"), error: { kind: "interrupted", reason: "user" }, usage: null }),
        synthetic("s1", "interrupt", "The user stopped the previous response before it finished."),
        event("execution.interrupted", { executionId: exe, reason: "user" }),
      ]),
    )
    expect(out).toContain('↳ queued: "Then the changelog." · the agent will see it after this turn\n')
    expect(render(stored([...opening(), event("inbox.enqueued", { messageId: m("u2"), origin: null, delivery: "steer", content: text("Also check b.ts and c.ts.") })]), { columns: () => 40 })).toContain('↳ sent: "Also check …" · after this step\n')
    expect(out.split("\n").slice(-3)).toEqual(["■ interrupted · 800ms", "  1 message still waiting · delivered when work starts again", ""])
  })
})

describe("verification, the workspace and reverts", () => {
  const SES = "ses_test" as SessionId
  const check = (name: string, status: "passed" | "failed" | "timed_out" | "could_not_start", extra: object = {}) => ({
    name,
    command: `bun ${name}`,
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    signal: null,
    durationMs: 10,
    files: ["a.ts"],
    fingerprint: "f",
    reusedFromSeq: null,
    outputPath: status === "passed" ? null : `/data/spill/checks/check-${name}-0a.log`,
    outputBytes: 0,
    outputLines: 0,
    ...extra,
  })
  const evidence = (...checks: ReturnType<typeof check>[]) => ({ run: 1, afterSeq: 1, changedFiles: ["a.ts"], checks })
  const finished = (...checks: ReturnType<typeof check>[]) => event("checks.finished", { run: 1, evidence: evidence(...checks) })
  const lines = (events: readonly NewEvent[], width = 80) => render(stored(events), { columns: () => width }).split("\n").filter((line) => line !== "")

  test("a passing run is one line with the count", () => {
    expect(lines([event("checks.started", { run: 1, checks: ["test", "lint"] }), finished(check("test", "passed"), check("lint", "passed"))])).toEqual(["✓ checks: 2 passed · 100ms"])
  })

  test("a failing run names each check that did not pass, how it ended, its command and where its output is", () => {
    const out = lines([
      event("checks.started", { run: 1, checks: ["test", "types", "lint"] }),
      finished(check("test", "failed"), check("types", "timed_out"), check("lint", "passed"), check("build", "could_not_start"), check("e2e", "failed", { exitCode: null, signal: "SIGKILL" })),
    ])
    expect(out).toEqual([
      "✗ checks: 2 failed, 1 timed out, 1 could not start, 1 passed · 100ms",
      "  ✗ test · exit 1 · bun test",
      "    full output:",
      "      /data/spill/checks/check-test-0a.log",
      "  ✗ types · timed out · bun types",
      "    full output:",
      "      /data/spill/checks/check-types-0a.log",
      "  ✗ build · could not start · bun build",
      "    full output:",
      "      /data/spill/checks/check-build-0a.log",
      "  ✗ e2e · killed by SIGKILL · bun e2e",
      "    full output:",
      "      /data/spill/checks/check-e2e-0a.log",
    ])
  })

  test("a path is never broken: on its own line, from the first column when it is wider than the terminal", () => {
    const long = `/home/someone/.local/share/${brand.directory}/spill/checks/check-test-0123456789abcdef.log`
    const out = lines([event("checks.started", { run: 1, checks: ["test"] }), finished(check("test", "failed", { outputPath: long }))], 60)
    expect(out.slice(-2)).toEqual(["    full output:", long])
  })

  test("the three endings of a turn that the engine calls done are told apart", () => {
    const ending = (verification: NewEvent<"execution.succeeded">["data"]["verification"]) =>
      lines([event("execution.started", { executionId: "exe_1" as never }), event("execution.succeeded", { executionId: "exe_1" as never, verification })])
    expect(ending({ status: "passed", evidence: evidence(check("test", "passed")) })).toEqual(["✓ done · checks passed · 0 steps · 100ms"])
    expect(ending({ status: "not_configured" })).toEqual(["✓ done · no checks configured · 0 steps · 100ms"])
    expect(ending({ status: "not_needed" })).toEqual(["✓ done · nothing to check · 0 steps · 100ms"])
    expect(ending({ status: "unresolved", reason: "report_mode", failing: ["test", "lint"], acknowledgement: null, evidence: evidence(check("test", "failed")) })).toEqual([
      "✗ stopped with failing checks: test, lint · 0 steps · 100ms",
      "  verify.mode is report: failures are recorded and the agent is not sent back",
    ])
    // Colour says the same thing: green for done, red for stopped.
    const colored = render(stored([event("execution.succeeded", { executionId: "exe_1" as never, verification: { status: "not_needed" } })]), { color: true })
    expect(colored).toContain("\x1b[32m")
    expect(colored).not.toContain("\x1b[31m")
  })

  test("the reason a turn stopped with failing checks is never cut on a narrow terminal", () => {
    const reason = "The integration tests need a database that this machine does not have."
    const out = lines(
      [event("execution.succeeded", { executionId: "exe_1" as never, verification: { status: "unresolved", reason: "acknowledged", failing: ["test"], acknowledgement: { checks: ["test"], reason }, evidence: evidence(check("test", "failed")) } })],
      40,
    )
    expect(out.every((line) => displayWidth(line) <= 40)).toBe(true)
    expect(out.join(" ").replace(/\s+/g, " ")).toContain(reason)
  })

  test("the quiet sink says on stderr that the answer it printed did not end on passing checks", async () => {
    const run = await runCli(["--quiet", "--demo", "the-checks-still-fail-after-the-last-allowed-round", "--demo-speed", "0", "Fix it."])
    expect(run.out).toBe("Now it adds.\n")
    expect(run.err).toContain(`${brandBinary}: stopped with failing checks: test (still failing after 2 runs`)
  })

  test("the files a turn changed are listed before its outcome, shortened to fit", () => {
    const changes: EphemeralEvent = { type: "workspace.changes", sessionId: SES, from: "w0", to: "w1", files: Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`) }
    const out = render([...stored([event("execution.started", { executionId: "exe_1" as never })]), changes], { columns: () => 60 }).split("\n")
    expect(out[0]).toMatch(/^· changed 9 files: src\/file-0\.ts, src\/file-1\.ts.*…$/)
    expect(displayWidth(out[0]!)).toBeLessThanOrEqual(60)
    const few: EphemeralEvent = { ...changes, files: ["a.ts", "b.ts"] }
    expect(render([few])).toBe("· changed 2 files: a.ts, b.ts\n")
  })

  test("a session without snapshots says so once, and what snapshots leave out is listed", () => {
    expect(lines([event("snapshot.unavailable", { reason: "git_not_found", message: "git was not found on PATH; snapshots need git 2.25 or newer." })])).toEqual([
      "· files cannot be restored by /undo in this session:",
      "  git was not found on PATH; snapshots need git 2.25 or newer.",
    ])
    expect(
      lines([
        event("snapshot.taken", { id: "w0", point: "delivery", messageId: null }),
        event("snapshot.coverage", { skipped: [{ path: "big.bin", reason: "too_large", bytes: 3_000_000 }], nestedRepositories: ["vendor/lib"] }),
        event("snapshot.coverage", { skipped: [], nestedRepositories: [] }),
      ]),
    ).toEqual(["· 1 file cannot be undone (too large or unreadable): big.bin", "· not tracked for undo (1 nested repository): vendor/lib"])
  })

  test("a revert says what was restored and what was kept, and a failed one that nothing changed", () => {
    const restore = { target: "w0", before: "w1", after: "w0", changed: 3, kept: [{ path: "notes.md", reason: "hand_edited" as const }, { path: "dist/app.js", reason: "ignored" as const }], keptOmitted: 0 }
    expect(lines([event("history.reverted", { fromSeq: 6, restore })])).toEqual([
      "↶ went back · 3 files restored · /redo brings it back",
      "  left as they are now, the outside changes and the agent's both: notes.md",
      "  left alone (ignored or never recorded): dist/app.js",
    ])
    expect(lines([event("history.reverted", { fromSeq: 6, restore: null })])).toEqual(["↶ went back · no file was restored · /redo brings it back"])
    expect(lines([event("history.restored", { revertSeq: 9, restore: { ...restore, kept: [] } })])).toEqual(["↷ brought back · 3 files as the turn left them"])
    expect(lines([event("revert.failed", { message: "git refused the restore" })])).toEqual(["✗ the workspace could not be restored: git refused the restore", "  nothing changed in the conversation"])
  })

  test("/undo and /redo name the turn they take out of the conversation or put back", () => {
    const said = (id: string, text: string) => event("inbox.enqueued", { messageId: m(id), origin: null, delivery: "steer", content: [{ type: "text", text }] })
    const turn = (id: string, exe: string, prompt: string) => [said(id, prompt), event("execution.started", { executionId: exe as never }), event("inbox.delivered", { messageId: m(id) }), event("execution.succeeded", { executionId: exe as never, verification: { status: "not_configured" } })]
    const restore = { target: "w0", before: "w1", after: "w0", changed: 1, kept: [], keptOmitted: 0 }
    const history = [...turn("u1", "exe_1", "Write the notes."), ...turn("u2", "exe_2", "Now add a test.")]
    const shown = lines([...history, event("history.reverted", { fromSeq: 7, restore }), event("history.restored", { revertSeq: 9, restore })], 140)
    expect(shown.filter((line) => /^[↶↷]/.test(line))).toEqual([
      '↶ undone: turn 2 "Now add a test." · out of the conversation · 1 file restored · /redo brings it back',
      '↷ redone: turn 2 "Now add a test." · back in the conversation · 1 file as the turn left them',
    ])
  })

  test("a diagnostic of the engine is printed in full", () => {
    const diagnostic: EphemeralEvent = {
      type: "diagnostic",
      sessionId: SES,
      kind: "prefix_violation",
      message: "session ses_test: the next request does not extend the previous one (params block 0 changed) and no event allows that",
    }
    const out = render([diagnostic], { columns: () => 50 }).split("\n").filter((line) => line !== "")
    // The heading carries the start of the message: no line of its own ending in ": " (it was, with a stray break after it).
    expect(out[0]).toBe("⚠ prompt cache: session ses_test: the next request")
    expect(out.join(" ").replace(/\s+/g, " ")).toContain("does not extend the previous one (params block 0 changed) and no event allows that")
    expect(out.every((line) => displayWidth(line) <= 50)).toBe(true)
  })

  test("the no-sandbox notice: its heading and the reason on one line, then the remedy, with no blank or dangling line", () => {
    const notice: EphemeralEvent = {
      type: "notice",
      sessionId: SES,
      kind: "sandbox_unavailable",
      message: "Commands cannot be sandboxed on this machine: bubblewrap is not installed\nInstall it with your package manager (bubblewrap).\n\nUntil then every command asks before it runs.",
    }
    expect(render([notice], { columns: () => 100 })).toBe(
      ["⚠ no sandbox: Commands cannot be sandboxed on this machine: bubblewrap is not installed", "  Install it with your package manager (bubblewrap).", "  Until then every command asks before it runs.", ""].join("\n"),
    )
  })

  test("a model call that took too long is named as such in the retry line", () => {
    const error = makeProviderError("transport", "The model call did not finish within 30 minutes", { reason: "timeout" })
    const out = lines([...opening(), stepStarted("a1"), event("retry.scheduled", { messageId: m("a1"), attempt: 2, delayMs: 2000, error })], 120)
    expect(out.at(-1)).toBe("↻ retrying in 2.0s (attempt 2) · the model call took too long: The model call did not finish within 30 minutes")
  })

  test("the status line says which checks are running and the last line of their output", () => {
    const statuses: (string | null)[] = []
    const renderer = new PrettyRenderer({ write: () => {}, color: false, columns: () => 80, live: false, showReasoning: false, echoPrompts: false, status: (text) => statuses.push(text) })
    const [started, checks] = stored([event("execution.started", { executionId: "exe_1" as never }), event("checks.started", { run: 1, checks: ["test", "lint"] })])
    renderer.event(started!)
    renderer.event(checks!)
    renderer.event({ type: "checks.progress", sessionId: SES, run: 1, check: "test", text: "12 pass\n3 fail\n" })
    expect(statuses.slice(-2)).toEqual(["⋯ running checks: test, lint", "⋯ running checks: test, lint · 3 fail"])
  })
})

describe("compaction", () => {
  const messageId = "cmp_1" as never
  const started = event("compaction.started", { messageId, trigger: "auto", mode: "normal", keepFromSeq: 1, prompt: "Summarise.", tokensBefore: 191_400 })
  const ended = (source: "model" | "repaired" | "fallback", detail: string | null) =>
    event("compaction.ended", { messageId, summary: "Checkpoint.", source, detail, tokensAfter: 48_250, usage: null })
  const lines = (...events: Parameters<typeof stored>[0]) => render(stored(events)).split("\n").filter((line) => line !== "")

  test("says how much smaller the next request is, and that the earlier messages can still be searched", () => {
    expect(lines(started, ended("model", null))).toEqual([
      "⇣ compacted the conversation · about 191,400 → 48,250 tokens",
      "  Earlier messages are now a checkpoint; the model can still search them.",
    ])
  })

  test("a summary that was used although something is off says what", () => {
    expect(lines(started, ended("repaired", "the model repeated its summary; its first copy is used")).at(-1)).toBe("  Note: the model repeated its summary; its first copy is used.")
  })

  test("without a summary the user is told why and what the model works from", () => {
    expect(lines(started, ended("fallback", "the model did not finish its summary within 5 minutes"))).toEqual([
      "⇣ compacted the conversation without a summary · about 191,400 → 48,250 tokens",
      "  Why: the model did not finish its summary within 5 minutes.",
      "  The model continues from a list of the files, commands and errors so far and",
      "  your own messages, and can search the full conversation.",
    ])
  })

  test("the status line says that it is compacting, and when the model was asked to fix its summary", () => {
    let out = ""
    const renderer = new PrettyRenderer({ write: (text) => (out += text), color: false, columns: () => 80, live: true, showReasoning: false, echoPrompts: true })
    const [claimed, first, repair] = stored([
      event("execution.started", { executionId: "exe_1" as never }),
      started,
      event("compaction.repair_requested", { messageId, attempt: 2, answer: "No.", prompt: "Fix it." }),
    ])
    renderer.event(claimed!)
    renderer.event(first!)
    expect(out).toContain("⋯ compacting the conversation")
    out = ""
    renderer.event(repair!)
    expect(out).toContain("⋯ compacting the conversation · asking the model to fix its summary")
  })
})

describe("preformatted text is never reflowed", () => {
  const diffFile = (patch: string) => ({ path: "src/a.ts", status: "modified" as const, binary: false, omitted: false, truncated: false, added: 1, removed: 1, patch })
  const shown = (columns: number, patch: string) => {
    let out = ""
    const renderer = new PrettyRenderer({ write: (text) => (out += text), color: false, columns: () => columns, live: false, showReasoning: false, echoPrompts: false })
    renderer.diff([diffFile(patch) as never])
    return out.split("\n").filter((line) => line !== "")
  }

  test("/diff keeps the indentation of context, added and removed lines", () => {
    const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,4 +1,4 @@", " function f() {", "   if (x) {", "-    return  1", "+    return  2", "   }", "\tdone()"].join("\n")
    expect(shown(80, patch)).toEqual([
      "src/a.ts · +1 -1",
      "  --- a/src/a.ts",
      "  +++ b/src/a.ts",
      "  @@ -1,4 +1,4 @@",
      "   function f() {",
      "     if (x) {",
      "  -    return  1",
      "  +    return  2",
      "     }",
      "      done()",
    ])
  })

  test("a diff line wider than the terminal continues on the next row with every character", () => {
    const line = `+${"  word".repeat(12)}`
    const rows = shown(30, ["@@ -1 +1 @@", line].join("\n")).slice(2)
    expect(rows.every((row) => displayWidth(row) <= 30)).toBe(true)
    expect(rows.map((row) => row.slice(2)).join("")).toBe(line)
  })

  test("a large paste is echoed as its first lines and a count, and sent whole", () => {
    let out = ""
    const renderer = new PrettyRenderer({ write: (text) => (out += text), color: false, columns: () => 80, live: false, showReasoning: false, echoPrompts: false })
    const paste = Array.from({ length: 2000 }, (_, index) => `line ${index} ${"x".repeat(50)}`).join("\n")
    renderer.prompt(paste)
    const rows = out.split("\n").filter((line) => line !== "")
    expect(rows.length).toBe(7)
    expect(rows[0]).toStartWith("› line 0 ")
    expect(rows.at(-1)).toBe(`  … 2,000 lines, ${(new TextEncoder().encode(paste).length / 1024).toFixed(1)} KB in all; the agent gets all of it`)
  })
})

describe("excerpts of prose", () => {
  test("are cut after a whole word, with … when there is more", () => {
    const text = "The first line of a.txt is hello, and the file has exactly one line in it with nothing else at all."
    expect(excerpt(text, 30, 5)).toEqual(["The first line of a.txt is", "hello, and the file has", "exactly one line in it with", "nothing else at all."])
    const cut = excerpt(text, 30, 2)
    expect(cut).toEqual(["The first line of a.txt is", "hello, and the file has …"])
    expect(cut.every((row) => displayWidth(row) <= 30)).toBe(true)
  })
})
