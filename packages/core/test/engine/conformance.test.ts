/**
 * Scenario conformance: the main acceptance test of the step loop.
 *
 * For every scenario in `test/scenarios/` the real loop is driven with the
 * scripted provider and scripted tools so that the situation occurs, and the
 * durable events it wrote must equal the scenario's events (see `comparable`
 * in `harness.ts` for what "equal" leaves out). After each one, the
 * projection rebuilt from the log must equal the stored rows, and the next
 * request built from the log must be valid for the provider.
 *
 * A scenario the loop does not reproduce event for event is listed in
 * `DEVIATIONS` with the reason; its expectation is the scenario's events with
 * exactly that difference applied, never a looser comparison.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { type NewEvent, event } from "../../src/event/durable.ts"
import { ENGINE_LIMITS, FAILURE_TEXT, NOTE_TEXT, TOOL_TEXT } from "../../src/engine/constants.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { noBlobStore } from "../../src/tool/tool.ts"
import { families } from "../scenarios/index.ts"
import {
  ATTEMPT_BUDGET,
  CRASH_EFFECT_UNKNOWN,
  CRASH_READ,
  EFFECT_UNKNOWN,
  INTERRUPTED_READ,
  NOT_STARTED,
  RESUME_CAP,
  SESSION,
  STEP_LIMIT,
  type Scenario,
  allEvents,
  c,
  continuationNote,
  interruptMarker,
  m,
  usage,
} from "../scenarios/script.ts"
import { Harness, ScriptedTools, comparable, failed, forever, removeHarnessDirectories, untilAbort } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(usage)
const ENCRYPTED = { providerData: { encrypted_content: "gAAAA" } }
const call = (callId: string, name: string, input: Json) => script.toolCall(callId, name, input)
const answer = (value: string) => [script.text(value), U]

/** The prompts the scenario's user types, in order. */
const prompts = (scenario: Scenario) =>
  allEvents(scenario).flatMap((item) => (item.type === "inbox.enqueued" ? [item.data.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []))

/** Waits for a shutdown that a probe started to complete, then ends the process. */
async function stopped(h: Harness) {
  const from = h.seenEvents.length
  await h.seen((item) => item.type === "execution.interrupted", from)
  await h.engine.close()
  h.kill()
}

type Play = (h: Harness, say: readonly string[]) => Promise<void>

/** How each scenario is made to happen. Keyed by the scenario's title. */
const PLAYS: Record<string, Play> = {
  // ---------------------------------------------------------------- happy paths

  "A plain answer": async (h, say) => {
    h.provider.enqueue([script.reasoning("Look at the README.", ENCRYPTED), script.text("It is a coding-agent harness."), U])
    h.create().send(say[0]!)
    await h.settled()
  },

  "One tool call, then an answer": async (h, say) => {
    h.provider.enqueue(
      [script.text("Let me read the test."), call("call_1", "read", { path: "a.test.ts" }), U],
      answer("The expectation is wrong: 1 + 1 is 2."),
    )
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.settled()
  },

  "Two parallel tool calls": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), call("call_2", "read", { path: "b.ts" }), U], answer("a is 1 and b is 2."))
    h.tools.on(
      "read",
      // call_1 finishes only after call_2 has settled.
      async () => {
        await h.seen((item) => item.type === "tool.settled")
        return "export const a = 1"
      },
      "export const b = 2",
    )
    h.create().send(say[0]!)
    await h.settled()
  },

  "Several steps in one turn": async (h, say) => {
    h.provider.enqueue(
      [call("call_1", "read", { path: "a.test.ts" }), U],
      [call("call_1", "write", { path: "a.test.ts", content: "expect(add(1, 1)).toBe(2)" }), U],
      [call("call_1", "shell", { command: "bun test" }), U],
      answer("Fixed the expectation; the test passes."),
    )
    h.tools.on("read", "expect(add(1, 1)).toBe(3)").on("write", "Wrote a.test.ts").on("shell", "1 pass, 0 fail")
    h.create().send(say[0]!)
    await h.settled()
  },

  "Two turns in one session": async (h, say) => {
    h.provider.enqueue(answer("2"), answer("4"))
    h.create().send(say[0]!)
    await h.settled()
    h.date = [2026, 11, 13]
    h.session.send(say[1]!)
    await h.settled()
  },

  "The user switches the model in the middle of a turn": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], answer("a is 1."))
    h.tools.on("read", () => {
      h.session.setSettings({ model: "gpt-other", reasoningEffort: "medium" })
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.requests.map((request) => request.params.model)).toEqual(["gpt-test", "gpt-other"])
  },

  // ---------------------------------------------------------------- cancel

  "Cancel while text is streaming": async (h, say) => {
    h.provider.enqueue([script.reasoning("Read the test first.", ENCRYPTED), script.text("Let me lo", { partial: true }), script.hang()])
    h.create().send(say[0]!)
    await h.seenText("Let me lo")
    h.session.interrupt()
    await h.settled()
  },

  "Cancel while a tool call's arguments are streaming": async (h, say) => {
    h.provider.enqueue([
      script.text("I'll read both files."),
      call("call_1", "read", { path: "a.ts" }),
      script.toolCall("call_2", "read", { path: "b.ts" }, { partial: true }),
      script.hang(),
    ])
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.input.delta" && item.callId === "call_2")
    h.session.interrupt()
    await h.settled()
    expect(h.tools.ran).toEqual([])
  },

  "Cancel while one tool is running": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U])
    h.tools.on("shell", async (_input, context) => {
      await untilAbort(context.signal)
      return failed("Stopped by the user after 4 s. Output so far:\n12 pass\n")
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    h.session.interrupt()
    await h.settled()
  },

  "Cancel while two parallel tools run and one has finished": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), call("call_2", "shell", { command: "bun test" }), U])
    h.tools.on("read", "export const a = 1").on("shell", async (_input, context) => {
      await untilAbort(context.signal)
      return failed("Stopped by the user after 2 s. Output so far:\n3 pass\n")
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.settled")
    h.session.interrupt()
    await h.settled()
  },

  "Cancel before a started side-effecting tool reports anything": async (h, say) => {
    h.provider.enqueue([call("call_1", "write", { path: "a.ts", content: "export const a = 2" }), U])
    h.tools.on("write", async (_input, context) => {
      await untilAbort(context.signal)
      throw new Error("aborted")
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    h.session.interrupt()
    await h.settled()
  },

  "Cancel before a started read-only tool reports anything": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.tools.on("read", async (_input, context) => {
      await untilAbort(context.signal)
      throw new Error("aborted")
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    h.session.interrupt()
    await h.settled()
  },

  "Cancel while waiting between steps": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.tools.on("read", "export const a = 1")
    h.at("step.boundary", 2, () => h.session.interrupt())
    h.create().send(say[0]!)
    await h.settled()
  },

  "Cancel while waiting to retry": async (h, say) => {
    h.provider.enqueue([script.fail("rate_limit", { message: "Rate limit reached", status: 429, retryAfterMs: 3000 })])
    h.clock.auto = false
    h.create().send(say[0]!)
    await h.clock.waiting()
    h.session.interrupt()
    await h.settled()
    expect(h.clock.slept).toEqual([3000])
  },

  // ---------------------------------------------------------------- steering and queueing

  "A steer arriving mid-step is delivered at the next step boundary": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], [call("call_1", "read", { path: "b.ts" }), U], answer("a is 1 and b is 2."))
    h.tools.on(
      "read",
      () => {
        h.session.send(say[1]!)
        return "export const a = 1"
      },
      "export const b = 2",
    )
    h.create().send(say[0]!)
    await h.settled()
  },

  "A queued message waits until the session would go idle": async (h, say) => {
    h.provider.enqueue(
      () => {
        h.session.queue(say[1]!)
        return [call("call_1", "read", { path: "a.ts" }), U]
      },
      answer("a is 1."),
      answer("Added the entry."),
    )
    h.tools.on("read", "export const a = 1")
    h.create().send(say[0]!)
    await h.settled()
  },

  "A pending steer survives an interrupt": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), script.hang()], [call("call_1", "read", { path: "b.ts" }), U], answer("b is 2."))
    h.tools.on("read", "export const b = 2")
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.called")
    h.session.send(say[1]!)
    h.session.interrupt()
    await h.settled()
    // The loop does not start the next execution by itself; the steer waits until work is started again.
    expect(h.session.projection().session.execution).toBeNull()
    expect(h.session.projection().inbox).toHaveLength(1)
    h.session.start()
    await h.settled()
  },

  "Several waiting items: steers first and in order, then one queued item at a time": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], answer("a, b and c are fine."), answer("Changelog updated."), answer("Version bumped."))
    h.tools.on("read", () => {
      h.session.queue(say[1]!)
      h.session.queue(say[2]!)
      h.session.send(say[3]!)
      h.session.send(say[4]!)
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.settled()
  },

  // ---------------------------------------------------------------- retries

  "A retryable failure before any output": async (h, say) => {
    h.provider.enqueue([script.fail("rate_limit", { message: "Rate limit reached", status: 429, retryAfterMs: 3000 })], answer("Here is the fix."))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.clock.slept).toEqual([3000])
    // A retry resends the same request unchanged.
    expect(h.provider.requests[1]).toEqual(h.provider.requests[0]!)
  },

  "A retryable failure after partial text: the model is asked to continue": async (h, say) => {
    h.provider.enqueue(
      [script.text("Let me look at the", { partial: true }), script.fail("provider_internal", { message: "The server had an error", status: 500 })],
      answer(" test first, then the implementation."),
    )
    h.create().send(say[0]!)
    await h.settled()
    expect(h.clock.slept).toEqual([2000])
  },

  "A stream that ends with no terminal event": async (h, say) => {
    h.provider.enqueue([script.reasoning("Thinking", { partial: true }), script.cut()], answer("Done."))
    h.create().send(say[0]!)
    await h.settled()
  },

  "The attempt budget runs out": async (h, say) => {
    for (let attempt = 0; attempt < ATTEMPT_BUDGET; attempt += 1)
      h.provider.enqueue([script.fail("provider_internal", { message: "The server had an error", status: 500 })])
    h.create().send(say[0]!)
    await h.settled()
    expect(h.clock.slept).toEqual([2000, 4000, 8000, 16000])
  },

  "A non-retryable error: authentication": async (h, say) => {
    h.provider.enqueue([script.fail("auth", { message: "Signed out: sign in again to continue.", status: 401 })])
    h.create().send(say[0]!)
    await h.settled()
  },

  "A non-retryable error: usage limit": async (h, say) => {
    h.provider.enqueue([script.fail("usage_limit", { message: "Usage limit reached; it resets in 3 hours.", status: 429 })])
    h.create().send(say[0]!)
    await h.settled()
  },

  "A non-retryable error: invalid request": async (h, say) => {
    h.provider.enqueue([script.fail("invalid_request", { message: "The provider rejected the request: Invalid 'input[3].call_id'.", status: 400 })])
    h.create().send(say[0]!)
    await h.settled()
  },

  "Malformed tool arguments": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", '{"path": "a.ts"'), U], [call("call_1", "read", '{"path": "a.ts"}'), U], answer("a is 1."))
    h.tools.on("read", "export const a = 1")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.tools.ran).toHaveLength(1)
  },

  "Tool arguments cut off by the output limit": async (h, say) => {
    h.provider.enqueue(
      [
        script.text("I'll write the new module."),
        script.toolCall("call_1", "write", '{"path":"m.ts","content":"export const everything = [', { partial: true }),
        U,
        script.finish("length"),
      ],
      [call("call_1", "write", { path: "m.ts", content: "export {}" }), U],
      answer("Created m.ts."),
    )
    h.tools.on("write", "Wrote m.ts")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.tools.ran).toHaveLength(1)
  },

  "An empty response: one nudge, then failure": async (h, say) => {
    h.provider.enqueue([U], [U])
    h.create().send(say[0]!)
    await h.settled()
  },

  "The same call with the same arguments, again and again": async (h, say) => {
    h.provider.enqueue(
      [call("call_1", "read", { path: "a.ts" }), U],
      [call("call_1", "read", { path: "a.ts" }), U],
      [call("call_1", "read", { path: "a.ts" }), U],
      answer("a is 1."),
    )
    h.tools.on("read", "export const a = 1", "export const a = 1")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.tools.ran).toHaveLength(2)
  },

  "The step limit is reached": async (h, say) => {
    h.provider.enqueue(
      [call("call_1", "read", { path: "f1.ts" }), U],
      [call("call_1", "read", { path: "f2.ts" }), U],
      [call("call_1", "read", { path: "f3.ts" }), U],
      answer("I read three files; the fix is still to do."),
    )
    h.tools.on("read", "file 1", "file 2", "file 3")
    h.create().send(say[0]!, { maxSteps: STEP_LIMIT })
    await h.settled()
    // Tools are forbidden in the final call and the tool list is unchanged, so the cached prefix holds.
    expect(h.provider.requests.map((request) => request.toolChoice)).toEqual(["auto", "auto", "auto", "none"])
    expect(h.provider.requests[3]!.tools).toEqual(h.provider.requests[0]!.tools)
    expect(h.provider.prefixBreaks()).toEqual([])
  },

  "Context overflow before any output: compact once and rebuild": async (h, say) => {
    h.provider.enqueue(
      answer("A long explanation."),
      [script.fail("context_overflow", { message: "The input exceeds the context window", status: 400 })],
      [script.text("The user asked about the architecture; it was explained.")],
      answer("The reducer folds events."),
    )
    h.create().send(say[0]!)
    await h.settled()
    h.session.send(say[1]!)
    await h.settled()
    // The compaction request is the step request of what is summarised plus one prompt, with tools switched off.
    const [first, , compaction] = h.provider.requests
    expect(compaction!.toolChoice).toBe("none")
    expect(compaction!.input.slice(0, -1)).toEqual([...first!.input, { type: "assistant_text", text: "A long explanation.", providerData: null }])
    expect(compaction!.input.at(-1)).toMatchObject({ type: "message", role: "developer" })
  },

  // ---------------------------------------------------------------- refusal

  "A content-policy refusal": async (h, say) => {
    h.provider.enqueue(
      answer("It exports a."),
      [call("call_1", "read", { path: "b.txt" }), U],
      [U, script.fail("content_policy", { message: "I can't help with that." })],
      answer("a."),
    )
    h.tools.on("read", "contents of b.txt")
    h.create().send(say[0]!)
    await h.settled()
    h.session.send(say[1]!)
    await h.settled()
    h.session.send(say[2]!)
    await h.settled()
    // The third turn's request holds nothing of the refused turn.
    expect(JSON.stringify(h.provider.requests.at(-1)!.input)).not.toContain("b.txt")
  },

  // ---------------------------------------------------------------- crash recovery

  "The process dies while the model is streaming": async (h, say) => {
    h.provider.enqueue([script.text("Reading the test first."), script.text("Then the", { partial: true }), script.hang()])
    h.create().send(say[0]!)
    await h.seenText("Then the")
    h.kill()
    h.provider.enqueue(answer("The expectation is wrong."))
    h.restart()
    await h.settled()
  },

  "The process dies while a read-only tool is running": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.tools.on("read", forever)
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    h.kill()
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], answer("a is 1."))
    h.tools.on("read", "export const a = 1")
    h.restart()
    await h.settled()
  },

  "The process dies while a side-effecting tool is running": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun run migrate" }), call("call_2", "read", { path: "schema.sql" }), U])
    // Dead the moment the first call's start is durable: the command itself never runs, and the second call never starts.
    h.dieAt("tool.started")
    h.create().send(say[0]!)
    await h.settled()
    h.provider.enqueue([call("call_1", "shell", { command: "bun run migrate:status" }), U], answer("The migration had already been applied."))
    h.tools.on("shell", "applied: 0007_add_index")
    h.restart()
    await h.settled()
  },

  "The process dies while a tool runs that the next build no longer has": async (h, say) => {
    h.provider.enqueue([call("call_1", "fetch", { url: "https://example.com/releases", method: "POST" }), U])
    h.tools.on("fetch", forever)
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    h.kill()
    // The build that starts next has no tool of that name, and recovery never asks it.
    h.toolNames = ["read", "shell", "write"]
    h.restart("claim")
  },

  "The process dies after a tool finished but before its result was written": async (h, say) => {
    h.provider.enqueue([call("call_1", "write", { path: "a.ts", content: "export const a = 2" }), U])
    h.tools.on("write", "Wrote a.ts")
    h.dieAt("tool.finished")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.tools.ran).toHaveLength(1)
    h.restart("claim")
  },

  "The process dies in the middle of a user cancel": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun run migrate" }), U])
    h.tools.on("shell", forever)
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    // The request is durable; the process dies before anything was stopped.
    h.dieAt("interrupt.requested")
    expect(() => h.session.interrupt()).toThrow("killed")
    h.restart()
    await h.settled()
  },

  "The process dies between steps": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.tools.on("read", "export const a = 1")
    h.dieAt("step.boundary", 2)
    h.create().send(say[0]!)
    await h.settled()
    h.provider.enqueue(answer("a is 1."))
    h.restart()
    await h.settled()
  },

  "The process dies after the answer, before the claim was released": async (h, say) => {
    h.provider.enqueue(answer("Done."))
    h.dieAt("execution.ending")
    h.create().send(say[0]!)
    await h.settled()
    h.restart()
    await h.settled()
  },

  [`The resume cap: the same execution crashes ${RESUME_CAP + 1} times`]: async (h, say) => {
    // Killed each time the step has started and before its request is sent, so the model is never reached.
    h.dieAt("step.started")
    h.create().send(say[0]!)
    await h.settled()
    for (let crash = 0; crash < RESUME_CAP; crash += 1) {
      h.boot()
      h.dieAt("step.started")
      h.open()
      await h.settled()
    }
    // The next start-up gives up instead of resuming once more.
    h.restart()
    await h.settled()
    expect(h.provider.calls).toHaveLength(0)
  },

  // ---------------------------------------------------------------- shutdown

  "A graceful shutdown mid-step": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U])
    h.tools.on("shell", async (_input, context) => {
      await untilAbort(context.signal)
      return failed("Stopped because the harness was shutting down. Output so far:\n12 pass\n")
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    await h.engine.close()
    h.kill()
    // The next start: the user's message is admitted, then the suspended execution is resumed.
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], answer("Yes. All 14 tests pass."))
    h.tools.on("shell", "14 pass, 0 fail")
    h.restart("wait").send(say[1]!)
    await h.settled()
  },

  "A graceful shutdown between steps": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.tools.on("read", "export const a = 1")
    h.at("step.boundary", 2, () => void h.engine.close())
    h.create().send(say[0]!)
    await stopped(h)
    h.provider.enqueue(answer("a is 1."))
    h.restart()
    await h.settled()
  },

  "Shutdown resumes do not use up the crash-resume cap": async (h, say) => {
    h.tools.on("read", "export const a = 1", "export const a = 1")
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.at("step.boundary", 2, () => void h.engine.close())
    h.create().send(say[0]!)
    await stopped(h)
    // A second clean restart, again between steps.
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U])
    h.boot()
    h.at("step.boundary", 2, () => void h.engine.close())
    h.open()
    await stopped(h)
    // The third process is killed in the middle of a step.
    h.provider.enqueue([script.text("Now the tests."), script.text("Running", { partial: true }), script.hang()])
    h.restart()
    await h.seenText("Running")
    h.kill()
    h.restart("claim")
  },

  "The process is killed while it is shutting down": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U])
    h.tools.on("shell", forever)
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    // The shutdown is durable; the kill comes before the command has stopped.
    h.dieAt("interrupt.requested")
    await h.engine.close()
    h.restart("claim")
  },
}

/**
 * Scenarios the loop does not reproduce event for event, with the reason and
 * the exact difference. Everything else must match its scenario as written.
 */
const DEVIATIONS: Record<string, { readonly why: string; readonly expected: (events: readonly NewEvent[]) => NewEvent[] | Promise<NewEvent[]> }> = {
  "Context overflow before any output: compact once and rebuild": {
    why:
      "The loop writes `baseline.set` right after `compaction.ended`, because `prepareInstructions` returns one whenever a compaction is newer than the baseline (context rule 2: a compaction is the one place the frozen prefix is rebuilt). The scenario goes from `compaction.ended` straight to `step.started`.",
    expected: (events) =>
      events.flatMap((item): NewEvent[] => (item.type === "compaction.ended" ? [item, events.find((other) => other.type === "baseline.set")!] : [item])),
  },
  "Malformed tool arguments": {
    why:
      "The text that answers malformed arguments is the tool runtime's, not the loop's: it names the tool, quotes what it received and says how to call again. The scenario's wording was written before the runtime existed. Outcome, order and every other event are the scenario's.",
    expected: async (events) => {
      // What the runtime itself says about these arguments.
      const runtime = createToolRuntime({ tools: new ScriptedTools().list(), spillDir: "/nonexistent", putBlob: noBlobStore })
      const context = { sessionId: SESSION, messageId: m("a1"), callId: c("call_1"), cwd: "/repo", signal: createInterrupt().signal, progress: () => {} }
      const refusal = await runtime.run({ name: "read", argumentsText: '{"path": "a.ts"', context })
      expect(refusal).toMatchObject({ kind: "refused", reason: "malformed_arguments" })
      return events.map((item) =>
        item.type === "tool.settled" && item.data.outcome === "error" ? event("tool.settled", { ...item.data, output: refusal.settlement.output }) : item,
      )
    },
  },
}

const scenarios = Object.entries(families).flatMap(([family, list]) => list.map((scenario) => ({ family, scenario })))

describe("the loop writes each scenario's events", () => {
  for (const { family, scenario } of scenarios) {
    test(`${family}: ${scenario.title}`, async () => {
      const play = PLAYS[scenario.title]
      if (play === undefined) throw new Error(`no play drives the loop through "${scenario.title}"`)
      const tools = scenario.title.includes("the next build no longer has")
        ? new ScriptedTools({ read: "read", shell: "exec", write: "write", fetch: "network" })
        : new ScriptedTools()
      const h = new Harness({ tools, limits: { crashResumeCap: RESUME_CAP, attemptBudget: ATTEMPT_BUDGET } })
      try {
        await play(h, prompts(scenario))
        const wanted = (await DEVIATIONS[scenario.title]?.expected(allEvents(scenario))) ?? allEvents(scenario)
        expect(comparable(h.log())).toEqual(comparable(wanted))
        // Nothing scripted was left over, so the situation happened the way the scenario describes it.
        expect(h.provider.remaining).toBe(0)
        expect(h.tools.unused).toBe(0)
        // Only a simulated kill may make the engine report anything.
        expect(h.diagnostics.filter((diagnostic) => !/killed|Database has closed/.test(diagnostic.message))).toEqual([])
        h.verify()
      } finally {
        await h.dispose()
      }
    })
  }

  test("every scenario has a play and every play a scenario", () => {
    expect(Object.keys(PLAYS).sort()).toEqual(scenarios.map(({ scenario }) => scenario.title).sort())
    expect(scenarios).toHaveLength(45)
    for (const title of Object.keys(DEVIATIONS)) expect(Object.keys(PLAYS)).toContain(title)
  })
})

describe("the loop's constants and frozen texts are the scenarios'", () => {
  test("numbers", () => {
    expect(ENGINE_LIMITS.attemptBudget).toBe(ATTEMPT_BUDGET)
    expect(ENGINE_LIMITS.crashResumeCap).toBe(RESUME_CAP)
    expect(ENGINE_LIMITS.retryBaseDelayMs).toBe(2000)
  })

  test("texts", () => {
    expect(TOOL_TEXT.notStarted).toBe(NOT_STARTED)
    expect(TOOL_TEXT.interruptedRead).toBe(INTERRUPTED_READ)
    expect(TOOL_TEXT.effectUnknown).toBe(EFFECT_UNKNOWN)
    expect(TOOL_TEXT.crashRead).toBe(CRASH_READ)
    expect(TOOL_TEXT.crashEffectUnknown).toBe(CRASH_EFFECT_UNKNOWN)
    const noteText = (item: NewEvent) => (item.type === "synthetic.appended" && item.data.content[0]?.type === "text" ? item.data.content[0].text : null)
    expect(NOTE_TEXT.interruptedByUser).toBe(noteText(interruptMarker("s", "user"))!)
    expect(NOTE_TEXT.interruptedByRestart).toBe(noteText(interruptMarker("s", "crash"))!)
    expect(NOTE_TEXT.interruptedByRestart).toBe(noteText(interruptMarker("s", "shutdown"))!)
    expect(NOTE_TEXT.continuation).toBe(noteText(continuationNote("s"))!)
    expect(FAILURE_TEXT.crashCap(RESUME_CAP)).toBe(`Gave up after the harness restarted ${RESUME_CAP} times during this turn.`)
  })
})
