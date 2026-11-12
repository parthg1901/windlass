/**
 * How the line-based renderer shows subagents and background work: a
 * labelled, indented, collapsed view. A child's own events are counted, not
 * printed; what is printed is its start, its task, a question it asks, and
 * its ending with the count.
 */
import { describe, expect, test } from "bun:test"
import { type CallId, type EphemeralEvent, type MessageId, type NewEvent, type SessionId, type StoredEvent, event, text } from "@light-harness/core"
import { render, stored } from "./helpers.ts"
import { COPY_NOTE } from "../src/features.ts"
import { wrap } from "../src/text.ts"

const PARENT = "ses_test" as SessionId
const CHILD = "ses_0123456789abcdef" as SessionId
const m = (id: string) => id as MessageId
const c = (id: string) => id as CallId

/** A child's durable event as the parent's stream carries it. */
const fromChild = (item: NewEvent, seq: number): EphemeralEvent => ({
  type: "child.event",
  sessionId: PARENT,
  child: CHILD,
  spawnId: "bg_1",
  title: "Fix the failing test in module a",
  event: { ...item, sessionId: CHILD, seq, time: seq * 100 } as StoredEvent,
})
const usage = { inputTokens: 12_000, cachedInputTokens: 9000, outputTokens: 340, reasoningTokens: 0 }
const started = (background: boolean, worktree = false) =>
  event("spawn.started", {
    spawnId: "bg_1",
    messageId: m("a1"),
    callId: c("call_1"),
    background,
    work: { kind: "subagent", sessionId: CHILD, worktree: worktree ? { path: "/data/worktrees/x", branch: "lh/subagent-x", base: "abc", repository: "/repo" } : null },
  })
const ended = (more: Partial<NewEvent<"spawn.ended">["data"]> = {}) => event("spawn.ended", { spawnId: "bg_1", outcome: "completed", detail: "It finished.", exitCode: null, usage, tainted: false, merge: null, ...more })

describe("a subagent", () => {
  test("is shown as a start, its task, and an ending with what it did; its own steps and tools are counted, not printed", () => {
    const [start, end] = stored([started(false), ended()])
    const child = [
      fromChild(event("step.started", { messageId: m("c1"), attempt: 1, model: "gpt-test" }), 2),
      fromChild(event("tool.called", { messageId: m("c1"), callId: c("call_1"), name: "read", input: "{}", providerData: null }), 3),
      fromChild(event("tool.called", { messageId: m("c1"), callId: c("call_2"), name: "shell", input: "{}", providerData: null }), 4),
      fromChild(event("step.ended", { messageId: m("c1"), finish: "tool_calls", usage: null }), 5),
      fromChild(event("text.ended", { messageId: m("c2"), text: "The child's own answer is not printed here.", providerData: null }), 6),
      fromChild(event("step.ended", { messageId: m("c2"), finish: "stop", usage: null }), 7),
    ]
    expect(render([start!, ...child, { ...end!, time: 2700 }])).toBe(
      ["  ▸ subagent ses_01234567 started", "    subagent ses_01234567: Fix the failing test in module a", "  ✓ subagent ses_01234567 finished · 2 steps, 2 tool calls · 12.3k tokens · 2.6s", ""].join("\n"),
    )
  })

  test("in the background and in a worktree says so; a merge, a conflict, a failure and untrusted content each get their line", () => {
    const merged = render(stored([started(true, true), ended({ merge: { status: "merged", branch: "lh/subagent-x", commit: "abc", files: ["a.ts", "b.ts"], conflicts: [], kept: false } })]))
    expect(merged).toContain("  ▸ subagent ses_01234567 started in the background, in its own worktree\n")
    expect(merged).toContain("    merged 2 files into the workspace: a.ts, b.ts\n")
    const conflict = render(stored([started(false, true), ended({ merge: { status: "conflicts", branch: "lh/subagent-x", commit: "abc", files: ["a.ts"], conflicts: ["a.ts"], kept: true } })]))
    expect(conflict).toContain("    ⚠ not merged, conflicts in: a.ts\n    its work is on branch lh/subagent-x; nothing was changed in the workspace\n")
    const failed = render(stored([started(false), ended({ outcome: "failed", detail: "It failed: The request was rejected.", usage: null, tainted: true })]))
    expect(failed).toContain("  ✗ subagent ses_01234567 failed · 100ms\n    It failed: The request was rejected.\n    ⚠ its result may carry untrusted content\n")
    expect(render(stored([started(true), ended({ outcome: "lost", detail: "It was cut off when the harness restarted.", usage: null })]))).toContain("  ⚠ subagent ses_01234567 lost")
  })

  test("that asks for approval is said, labelled, and the status line says who waits; its running count is the status line", () => {
    const lines: (string | null)[] = []
    const [open, start] = stored([event("execution.started", { executionId: "exe_1" as never }), started(false)])
    const question = { title: "Allow shell: curl example.com with network access?", subject: "curl example.com", details: [], choices: [{ id: "deny" as const, label: "No", approve: false, remembers: null, grants: [] }] }
    const out = render(
      [
        open!,
        start!,
        fromChild(event("tool.called", { messageId: m("c1"), callId: c("call_1"), name: "shell", input: "{}", providerData: null }), 3),
        fromChild(event("approval.requested", { messageId: m("c1"), callId: c("call_1"), mode: "auto", paths: [], escalation: { network: true, write: [] }, question, needs: [{ kind: "sandbox-network" }], then: { kind: "run_sandboxed", network: true, writableRoots: [] } }), 4),
      ],
      { status: (line) => lines.push(line) },
    )
    expect(out).toContain("    ? subagent ses_01234567 asks: Allow shell: curl example.com with network\n      access?\n")
    expect(lines.at(-1)).toBe("? subagent ses_01234567 waits for your answer · Ctrl-C stops the turn")
    // What it is doing, not only that it runs: its tool call that is open.
    expect(lines.at(-2)).toBe("⋯ subagent ses_01234567: running shell · 0 steps, 1 tool")
  })
})

describe("a background command", () => {
  const command = (line = "bun test --watch") => event("spawn.started", { spawnId: "bg_7", messageId: m("a1"), callId: c("call_1"), background: true, work: { kind: "command", command: line, logPath: "/tmp/.spill/bg.log" } })
  const exit = (exitCode: number | null, outcome: "completed" | "stopped" | "lost" = "completed") => event("spawn.ended", { spawnId: "bg_7", outcome, detail: "Background command bg_7 ended.", exitCode, usage: null, tainted: false, merge: null })
  const told = event("inbox.enqueued", { messageId: m("s9"), origin: "background_command", delivery: "steer", content: text("Background command bg_7 exited with code 0 after 2.5 s.\nCommand: bun test\nOutput:\n3 pass") })

  test("is a start line with the command, and a completion line that says how it ended and that the agent is told", () => {
    expect(render(stored([command(), exit(0), told]))).toBe(["  ▸ background bg_7 · bun test --watch", "    output:", "      /tmp/.spill/bg.log", "  ✓ background bg_7 exited with code 0 · 100ms", "  ↳ its result is sent to the agent, which carries on", ""].join("\n"))
    expect(render(stored([command(), exit(3)]))).toContain("  ✗ background bg_7 exited with code 3")
    expect(render(stored([command(), exit(null, "stopped")]))).toContain("  ■ background bg_7 stopped")
    expect(render(stored([command(), exit(null, "lost")]))).toContain("  ⚠ background bg_7 lost")
    // A long command line is shortened; the handle stays.
    expect(render(stored([command(`bun test ${"x".repeat(200)}`)])).split("\n")[0]!.length).toBeLessThanOrEqual(80)
  })
})

describe("a replay session", () => {
  test("says when it leaves its recording and how it ended", () => {
    const out = render(
      stored([
        event("replay.call", { messageId: m("a1"), callId: c("call_1"), result: "matched", executed: false, recorded: { step: 0, call: 0 }, divergence: null }),
        event("replay.diverged", { workspace: "/data/replays/ses_r", snapshot: "abc", divergence: "arguments_differ" }),
        event("replay.ended", { outcome: "diverged", reason: "left the recording at step 2, call 1: arguments differ", report: {} }),
      ]),
    )
    expect(out).toBe(["· replay left its recording (arguments differ) · continuing in a copy", "  /data/replays/ses_r", ...wrap(COPY_NOTE, 78).map((line) => `  ${line}`), "⚠ replay diverged · left the recording at step 2, call 1: arguments differ", ""].join("\n"))
  })
})
