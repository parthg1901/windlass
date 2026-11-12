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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type NewEvent, event } from "../../src/event/durable.ts"
import { ENGINE_LIMITS, FAILURE_TEXT, NOTE_TEXT, TOOL_TEXT } from "../../src/engine/constants.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import { callStopReasonOf, createInterrupt } from "../../src/interrupt.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { noBlobStore } from "../../src/tool/tool.ts"
import { allFamilies as families } from "../scenarios/index.ts"
import {
  ATTEMPT_BUDGET,
  CRASH_EFFECT_UNKNOWN,
  CRASH_READ,
  EFFECT_UNKNOWN,
  HOME,
  NO_SANDBOX,
  INTERRUPTED_READ,
  NOT_STARTED,
  NOT_A_SUMMARY,
  RESUME_CAP,
  SESSION,
  STEP_LIMIT,
  SUMMARY,
  type Scenario,
  allEvents,
  c,
  continuationNote,
  interruptMarker,
  m,
  measured,
  usage,
} from "../scenarios/script.ts"
import { FIRING, MCP_CALL_INPUT, SKILL_EDITED, SKILL_FIRST, WAKE_TEXT, WEBHOOK_BODY, WEBHOOK_TEXT } from "../scenarios/features.ts"
import { EDIT } from "../scenarios/revert.ts"
import { CHILD_WORDS, INTERRUPTED_LINT, STOPPED_TESTS } from "../scenarios/call-stop.ts"
import { ERROR_WATCH, UP_WATCH } from "../scenarios/lineage.ts"
import { ACKNOWLEDGEMENT, FIRST_FIX, HAND_EDITED, SECOND_FIX } from "../scenarios/verification.ts"
import type { AnyTool, ToolContext } from "../../src/tool/tool.ts"
import { currentTodos, todoTool } from "../../src/tools/todo.ts"
import { TODO_INPUT } from "../scenarios/compaction.ts"
import { CAPTAIN_FILE, DELEGATE_AS, REVIEWER_FILE, WRITE_FIX } from "../scenarios/agents.ts"
import { RELEASE_NOTES_ARGS, RELEASE_NOTES_FILE, REVIEW_ARGS, REVIEW_FILE, SHIP_ARGS, SHIP_FILE } from "../scenarios/commands.ts"
import { mapSession } from "../../src/telemetry/map.ts"
import type { Span } from "../../src/telemetry/span.ts"
import { DOCUMENT_BEFORE, FORMAT_NOTE, PUSH_INPUT, PUSH_REASON, READ_DOCUMENT, SCRATCH_REASON, WRITE_DOCUMENT, WRITE_HELPER, WROTE_DOCUMENT, WROTE_HELPER } from "../scenarios/hooks.ts"
import type { HookProcessResult } from "../../src/hooks/answer.ts"
import type { HookRunner } from "../../src/hooks/run.ts"
import { exited } from "../hooks/helpers.ts"
import { fixture as languageServer } from "../lsp/helpers.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import { HARNESS_ORIGIN } from "../../src/event/durable.ts"
import type { MessageId } from "../../src/id.ts"
import { fixtureServer, waitFor } from "../mcp/helpers.ts"
import { FakeWorkspace, Harness, ScriptedTools, comparable, converse, failed, forever, removeHarnessDirectories, untilAbort } from "./harness.ts"

const projects: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A real directory for a scenario about skills or MCP servers, which read
 * the disk and start processes: the session works in it, and its path
 * stands for the scenarios' `/repo` when the logs are compared.
 */
function projectDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-conformance-")))
  projects.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  return cwd
}

/** A skill file of the scenario's project. */
function writeSkill(cwd: string, name: string, description: string): void {
  const path = join(cwd, ".claude", "skills", name, "SKILL.md")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\nTag, then push the tag.\n`)
}

/** An agent definition of the scenario's project. */
function writeAgent(cwd: string, name: string, text: string): void {
  const path = join(cwd, ".claude", "agents", `${name}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A command file of the scenario's project. */
function writeCommand(cwd: string, name: string, text: string): void {
  const path = join(cwd, ".claude", "commands", `${name}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** What the collector of the scenario being played was sent: the engine's exporter is this list. */
let exportedSpans: Span[] = []

/**
 * What the hooks of the scenario being played answer, by hook name: a play
 * says it before it sends the prompt. The scenarios' hooks are not commands
 * that exist; the engine's runner is this script.
 */
let hookAnswers: Record<string, HookProcessResult> = {}
const scriptedHooks: HookRunner = async (request) => {
  const answer = hookAnswers[request.hook.name]
  if (answer === undefined) throw new Error(`the play scripted no answer for the hook ${request.hook.name}`)
  return answer
}

/** The log with the scenario's stand-in for the working directory. */
function inRepo(h: Harness, events: readonly StoredEvent[]): readonly StoredEvent[] {
  if (h.cwd === "/repo") return events
  return JSON.parse(JSON.stringify(events).split(h.cwd).join("/repo")) as StoredEvent[]
}

const U = script.usage(usage)
const ENCRYPTED = { providerData: { encrypted_content: "gAAAA" } }
const call = (callId: string, name: string, input: Json) => script.toolCall(callId, name, input)
const answer = (value: string) => [script.text(value), U]
/** A call the provider measured at `inputTokens` input tokens: a file read, or an answer. */
const at = (inputTokens: number) => script.usage(measured(inputTokens))
const readsAt = (path: string, inputTokens: number) => [call("call_1", "read", { path }), at(inputTokens)]
const answersAt = (value: string, inputTokens: number) => [script.text(value), at(inputTokens)]
/** What the model returns for a summary request: no usage is scripted, as for a stream that was only read for its text. */
const summary = (value = SUMMARY) => [script.text(value)]

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

/** A write call as the model makes it, and the tool that carries it out on the scenario's workspace. */
const write = (input: string) => [call("call_1", "write", input), U]
const writes = (h: Harness, output: string) => (input: Record<string, unknown>) => {
  h.workspace!.files.set(String(input.path), String(input.content))
  return output
}

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

  // ---------------------------------------------------------------- one call stopped by the user

  "The user stops one command and the turn goes on": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], answer("The test run hung after 12 tests, so you stopped it. The next test is the one to look at."))
    h.tools.on("shell", async (_input, context) => {
      await untilAbort(context.signal)
      // The signal is the call's own, and its reason says that this call was stopped, not the turn.
      expect(callStopReasonOf(context.signal)).toBe("call")
      return failed(STOPPED_TESTS)
    })
    h.create().send(say[0]!)
    // Not before it runs: a call that has not started is not stopped this way.
    await h.seen((item) => item.type === "tool.called")
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(false)
    await h.seen((item) => item.type === "tool.started")
    expect(h.session.cancelCall({ callId: c("call_2") })).toBe(false)
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
    // Once.
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(false)
    await h.settled()
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(false)
  },

  "A stopped call that reports nothing is settled from its effect class, and the step's other call finishes": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun run migrate" }), call("call_2", "read", { path: "a.ts" }), U], answer("a.ts exports a = 1. I do not know whether the migration was applied: let me check its status."))
    let readSignal: AbortSignal | null = null
    h.tools
      .on("shell", async (_input, context) => {
        await untilAbort(context.signal)
        throw new Error("aborted")
      })
      .on("read", async (_input, context) => {
        readSignal = context.signal
        await h.seen((item) => item.type === "tool.settled")
        return "export const a = 1"
      })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started" && item.data.callId === "call_2")
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
    await h.settled()
    // The other call of the step was never told to stop.
    expect(readSignal!.aborted).toBe(false)
  },

  "A call that cannot be stopped midway finishes with its ordinary result": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], answer("It exports a = 1."))
    // A read does not look at its signal: it returns the file.
    h.tools.on("read", async () => {
      await h.seen((item) => item.type === "tool.cancel_requested")
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started")
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
    await h.settled()
  },

  "The user stops one call and then the whole turn": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), call("call_2", "shell", { command: "bun run lint" }), U])
    const reasons: (string | null)[] = []
    h.tools
      .on("shell", async (_input, context) => {
        await untilAbort(context.signal)
        // It reports only once the turn is being interrupted too.
        await h.seen((item) => item.type === "execution.interrupt_requested")
        reasons.push(callStopReasonOf(context.signal))
        return failed(STOPPED_TESTS)
      })
      .on("shell", async (_input, context) => {
        await untilAbort(context.signal)
        await h.seen((item) => item.type === "tool.settled")
        reasons.push(callStopReasonOf(context.signal))
        return failed(INTERRUPTED_LINT)
      })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "tool.started" && item.data.callId === "call_2")
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
    h.session.interrupt()
    // Everything stops now: no single call is stopped any more.
    expect(h.session.cancelCall({ callId: c("call_2") })).toBe(false)
    await h.settled()
    // The first abort of a call's signal wins: the first call was stopped as a call, the second by the interrupt.
    expect(reasons).toEqual(["call", "user"])
  },

  "The user stops a subagent call: the child is interrupted and the call says so": async (h, say) => {
    converse(h.provider, {
      [say[0]!]: [[call("call_1", "subagent", { task: "Fix module a" }), U], answer("You stopped the subagent before it changed anything. Module a is not fixed.")],
      "Fix module a": [[script.text(CHILD_WORDS), call("call_1", "read", { path: "a.ts" }), U]],
    })
    // The child is reading when the user stops the parent's call; its read stops with the child's own interrupt.
    h.tools.on("read", async (_input, context) => {
      await untilAbort(context.signal)
      expect(callStopReasonOf(context.signal)).toBe("user")
      return failed("Stopped.")
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "child.event" && item.event.type === "tool.started")
    expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
    await h.settled()
    // The child's own turn ended as interrupted by its user, and its conversation stays.
    const child = h.session.projection().session.spawned!.children[0]!
    expect(h.engine.readEvents(child).filter((item) => item.type === "execution.interrupted").map((item) => item.data)).toMatchObject([{ reason: "user" }])
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

  "An empty response after the work: the turn ends as done": async (h, say) => {
    h.provider.enqueue([call("call_1", "write", { path: "notes.md", content: "x\n" }), U], [U], [U])
    h.tools.on("write", "Wrote notes.md (1 line).")
    const notices: string[] = []
    h.create()
    h.session.subscribe((item) => {
      if (item.type === "notice") notices.push(item.kind)
    })
    h.session.send(say[0]!)
    await h.settled()
    // The user is told, once, why the turn has no last word.
    expect(notices).toEqual(["no_closing_answer"])
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

  "A prompt is withdrawn before it is delivered": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], answer("a is 1."))
    h.tools.on("read", () => {
      const sent = h.session.send(say[1]!)
      expect(h.session.withdraw(sent)).toBe(true)
      // Withdrawn once; and what was delivered is history, not something to withdraw.
      expect(h.session.withdraw(sent)).toBe(false)
      expect(h.session.withdraw(h.session.projection().messages[0]!.id)).toBe(false)
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.settled()
    // The model never saw it.
    expect(JSON.stringify(h.provider.requests)).not.toContain(say[1]!)
  },

  "The agent starts working in a directory that has its own instructions": async (h, say) => {
    h.agents.set("/repo/packages/api", "Handlers return status codes, never bodies.")
    h.provider.enqueue([call("call_1", "read", { path: "packages/api/handler.ts" }), U], answer("It returns 200."))
    h.tools.on("read", "export const handler = () => 200")
    h.create().send(say[0]!)
    await h.settled()
    // Appended, not folded into the frozen prefix: the second request is the first plus new items.
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(h.provider.requests[1]!.instructions).toBe(h.provider.requests[0]!.instructions)
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain("Handlers return status codes, never bodies.")
  },

  "A session is archived and brought back": async (h, say) => {
    h.provider.enqueue(answer("2"), answer("4"))
    const id = h.create().id
    h.session.send(say[0]!)
    await h.settled()
    await h.engine.archiveSession(id)
    // Archiving closed the session here and left it out of the default listing; twice is once.
    await h.engine.archiveSession(id)
    expect(h.engine.listSessions().map((summary) => summary.session.id)).toEqual([])
    expect(h.engine.listSessions({ includeArchived: true }).map((summary) => summary.session.id)).toEqual([id])
    await h.engine.unarchiveSession(id)
    await h.engine.unarchiveSession(id)
    expect(h.engine.listSessions().map((summary) => summary.session.id)).toEqual([id])
    h.open().send(say[1]!)
    await h.settled()
  },

  // ---------------------------------------------------------------- verification

  "A queued message waits for the checks": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."), write(SECOND_FIX), answer("Now it adds."), answer("Added the test."))
    h.tools.on(
      "write",
      (input: Record<string, unknown>) => {
        h.session.queue(say[1]!)
        return writes(h, "Wrote add.ts")(input)
      },
      writes(h, "Wrote add.ts"),
    )
    h.checks.on("test", "failed", "passed")
    h.create().send(say[0]!)
    await h.settled()
    // The gate ran twice before the follow-up was delivered, and not again after it: nothing had changed.
    expect(h.checks.ran).toEqual(["test", "test"])
    expect(h.provider.prefixBreaks()).toEqual([])
  },

  "The checks pass": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."))
    h.tools.on("write", writes(h, "Wrote add.ts"))
    h.checks.on("test", "passed")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.checks.ran).toEqual(["test"])
  },

  "A question after a hand edit runs no check; the next turn that changes a file checks it all": async (h, say) => {
    h.provider.enqueue(answer("It subtracts, which looks like a bug."), answer("It expects 4 for 2 + 2, which is right."), write(SECOND_FIX), answer("Now it adds."))
    h.tools.on("write", writes(h, "Wrote add.ts"))
    h.checks.on("test", "passed")
    h.create().send(say[0]!)
    await h.settled()
    // The user edits a test by hand between the turns.
    h.workspace!.files.set(HAND_EDITED.path, HAND_EDITED.content)
    h.session.send(say[1]!)
    await h.settled()
    expect(h.checks.ran).toEqual([])
    h.session.send(say[2]!)
    await h.settled()
    expect(h.checks.ran).toEqual(["test"])
  },

  "The checks fail, the model fixes the code, and they pass": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."), write(SECOND_FIX), answer("Now it adds."))
    h.tools.on("write", writes(h, "Wrote add.ts"), writes(h, "Wrote add.ts"))
    h.checks.on("test", "failed", "passed")
    h.create().send(say[0]!)
    await h.settled()
    // The report is appended to the conversation: the request after it is the one before it plus new items.
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(JSON.stringify(h.provider.requests[2]!.input.at(-1))).toContain("Checks run by the harness after your changes: 1 failed.")
  },

  "The checks still fail after the last allowed round": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."), write(SECOND_FIX), answer("Now it adds."))
    h.tools.on("write", writes(h, "Wrote add.ts"), writes(h, "Wrote add.ts"))
    h.checks.on("test", "failed", "failed")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.calls).toHaveLength(4)
  },

  "The model reports that it cannot make the checks pass": async (h, say) => {
    h.provider.enqueue(
      write(FIRST_FIX),
      answer("Fixed add."),
      [call("call_1", "report_check_failure", ACKNOWLEDGEMENT), U],
      answer("The test cannot pass without the fixture."),
    )
    h.tools.on("write", writes(h, "Wrote add.ts"))
    h.checks.on("test", "failed")
    h.create().send(say[0]!)
    await h.settled()
    // The tool is in the frozen list because verification was on when the baseline was set.
    expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).toContain("report_check_failure")
    expect(h.checks.ran).toEqual(["test"])
  },

  "No checks are configured": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."))
    h.tools.on("write", writes(h, "Wrote add.ts"))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).not.toContain("report_check_failure")
  },

  "Cancel while the checks run": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."))
    h.tools.on("write", writes(h, "Wrote add.ts"))
    h.checks.on("test", async (_check, options) => {
      await untilAbort(options.signal)
      return "interrupted" as const
    })
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "checks.started")
    h.session.interrupt()
    await h.settled()
  },

  "The process dies while the checks run": async (h, say) => {
    h.provider.enqueue(write(FIRST_FIX), answer("Fixed add."))
    h.tools.on("write", writes(h, "Wrote add.ts"))
    // Dead the moment the run's start is durable: the command itself never runs.
    h.dieAt("checks.started")
    h.create().send(say[0]!)
    await h.settled()
    h.checks.on("test", "passed")
    h.restart()
    await h.settled()
    expect(h.provider.calls).toHaveLength(2)
  },

  // ---------------------------------------------------------------- revert

  "Revert of the last turn": async (h, say) => {
    h.provider.enqueue(write(EDIT), answer("Added the line."))
    h.tools.on("write", writes(h, "Wrote notes.md"))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.workspace!.files.get("notes.md")).toContain("reviewed")
    expect(await h.session.revert()).toMatchObject({ kind: "reverted", plan: { changes: [{ path: "notes.md", status: "modified", handEdited: false }] } })
    expect(Object.fromEntries(h.workspace!.files)).toEqual({ "notes.md": "# Notes\n" })
  },

  "Revert, then undo the revert": async (h, say) => {
    h.provider.enqueue(write(EDIT), answer("Added the line."))
    h.tools.on("write", writes(h, "Wrote notes.md"))
    h.create().send(say[0]!)
    await h.settled()
    expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
    expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted", plan: { messages: 3 } })
    expect(h.workspace!.files.get("notes.md")).toContain("reviewed")
  },

  // ---------------------------------------------------------------- compaction

  "A compaction that is due waits for the next user message": async (h, say) => {
    h.provider.enqueue(readsAt("a.test.ts", 4800), answersAt("The expectation is wrong: 1 + 1 is 2.", 4900), summary(), answersAt("Changed the expectation to 2.", 1200))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.settled()
    // Over the early threshold, and nothing was compacted in the middle of the turn.
    expect(h.provider.calls).toHaveLength(2)
    h.session.send(say[1]!)
    await h.settled()
    const [, second, compaction, after] = h.provider.requests
    // The summary request is the first turn's last request plus that step's answer and one prompt, with tools switched off.
    expect(compaction!.toolChoice).toBe("none")
    expect(compaction!.tools).toEqual(second!.tools)
    expect(compaction!.input.slice(0, second!.input.length)).toEqual([...second!.input])
    expect(compaction!.input.at(-1)).toMatchObject({ type: "message", role: "developer" })
    expect(JSON.stringify(compaction!.input)).not.toContain(say[1]!)
    // The request after it: the checkpoint, the new message, nothing else.
    expect(after!.input).toHaveLength(2)
    expect(after!.input[1]).toEqual({ type: "message", role: "user", content: [{ type: "text", text: say[1]! }] })
  },

  "The model's task list survives a compaction": async (h, say) => {
    h.provider.enqueue(
      [call("call_1", "todo", JSON.parse(TODO_INPUT) as Json), at(4800)],
      answersAt("The expectation is wrong; fixing it is next.", 4900),
      summary(),
      answersAt("Fixed the expectation; running the tests is next.", 1200),
    )
    h.create().send(say[0]!)
    await h.settled()
    h.session.send(say[1]!)
    await h.settled()
    // The request after the compaction: the checkpoint with the list as the call left it, then the new message.
    const after = h.provider.requests.at(-1)!
    expect(after.input).toHaveLength(2)
    const shown = JSON.stringify(after.input[0])
    expect(shown).toContain("[x] Read the failing test\\n[>] Fix the expectation\\n[ ] Run the tests")
    // The tool list is the same before and after, and a client still folds the list out of the log.
    expect(after.tools).toEqual(h.provider.requests[0]!.tools)
    expect(after.tools.map((tool) => tool.name)).toContain("todo")
    expect(currentTodos(h.session.projection().messages)?.counts).toEqual({ pending: 1, in_progress: 1, done: 1 })
  },

  "The user asks for a compaction while the session is idle": async (h, say) => {
    h.provider.enqueue(readsAt("a.test.ts", 3000), answersAt("The expectation is wrong: 1 + 1 is 2.", 3200), summary(), answersAt("Changed the expectation to 2.", 1200))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.settled()
    expect(await h.session.compact()).toMatchObject({ kind: "compacted", source: "model" })
    await h.settled()
    // Asked again right away: nothing to take out, and nothing is written.
    const before = h.log().length
    expect((await h.session.compact()).kind).toBe("nothing")
    expect(h.log()).toHaveLength(before)
    h.session.send(say[1]!)
    await h.settled()
    const after = h.provider.requests.at(-1)!
    expect(after.input.map((item) => item.type)).toEqual(["message", "assistant_text", "message"])
    expect(after.tools).toEqual(h.provider.requests[0]!.tools)
  },

  "A compaction in the middle of a long turn": async (h, say) => {
    h.provider.enqueue(
      readsAt("build.ts", 3000),
      readsAt("bundle.ts", 4000),
      readsAt("compile.ts", 6000),
      summary(),
      answersAt("Every entry is compiled one after the other, and the cache is never read.", 1500),
    )
    h.tools.on("read", "await bundle(entries)", "for (const entry of entries) await compile(entry)", "const cache = new Map()")
    h.create().send(say[0]!)
    await h.settled()
    const [, , third, compaction, after] = h.provider.requests
    // Keeping only the last step, the summary request is that step's own request plus the prompt: all of it is read from the cache.
    expect(compaction!.input.slice(0, -1)).toEqual([...third!.input])
    // After it: the checkpoint, then the kept step's call and its result, word for word.
    expect(after!.input.map((item) => item.type)).toEqual(["message", "tool_call", "tool_result"])
    expect(after!.input[2]).toMatchObject({ output: "const cache = new Map()" })
    const checkpointText = JSON.stringify(after!.input[0])
    expect(checkpointText).toContain(say[0]!)
    expect(checkpointText).toContain("The work was in progress when this checkpoint was taken.")
  },

  "The provider rejects a request as too large: compact aggressively and rebuild": async (h, say) => {
    h.provider.enqueue(
      answer("A long explanation."),
      [script.fail("context_overflow", { message: "The input exceeds the context window", status: 400 })],
      summary(),
      answer("The reducer folds events."),
    )
    h.create().send(say[0]!)
    await h.settled()
    h.session.send(say[1]!)
    await h.settled()
    const [first, , compaction, rebuilt] = h.provider.requests
    // The summary request is the step request of what is summarised (here everything, the new prompt included) plus one prompt.
    expect(compaction!.toolChoice).toBe("none")
    expect(compaction!.input.slice(0, -1)).toMatchObject([...first!.input, { type: "assistant_text", text: "A long explanation." }, { type: "message", role: "user", content: [{ type: "text", text: say[1]! }] }])
    // The rebuilt request is the checkpoint alone; it quotes the prompt it replaced.
    expect(rebuilt!.input).toHaveLength(1)
    expect(JSON.stringify(rebuilt!.input)).toContain(say[1]!)
  },

  "A compaction that frees too little: the hold, one aggressive attempt, then nothing more": async (h, say) => {
    h.provider.enqueue(
      readsAt("migrations/0001.sql", 6000),
      summary(),
      readsAt("migrations/0002.sql", 5900),
      readsAt("migrations/0003.sql", 7500),
      summary(),
      readsAt("migrations/0004.sql", 7500),
      answersAt("Four migrations; the last one drops the index the third one made.", 7600),
    )
    h.tools.on("read", "CREATE TABLE ledger (id INTEGER)", "ALTER TABLE ledger ADD COLUMN total", "CREATE INDEX ledger_total", "DROP INDEX ledger_total")
    h.create().send(say[0]!)
    await h.settled()
    // Two summary calls in seven: the hold and the last request cost none.
    expect(h.provider.requests.map((request) => request.toolChoice)).toEqual(["auto", "none", "auto", "auto", "none", "auto", "auto"])
  },

  "An invalid summary is repaired": async (h, say) => {
    h.provider.enqueue(readsAt("a.test.ts", 6000), summary(NOT_A_SUMMARY), summary(), answersAt("The expectation is wrong: 1 + 1 is 2.", 1300))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.settled()
    const [, first, repair] = h.provider.requests
    // The repair request is the first summary request plus the rejected answer and what to fix.
    expect(repair!.input.slice(0, first!.input.length)).toEqual([...first!.input])
    expect(repair!.input.slice(first!.input.length).map((item) => item.type)).toEqual(["assistant_text", "message"])
    expect(repair!.input.at(-2)).toMatchObject({ text: NOT_A_SUMMARY })
    // The ledger numbers the two calls as attempts of the compaction.
    expect(h.store.readRequests(h.session.id).filter((row) => row.purpose === "compaction").map((row) => row.attempt)).toEqual([1, 2])
  },

  "A summary that is still invalid: the checkpoint is built without the model": async (h, say) => {
    h.provider.enqueue(readsAt("a.test.ts", 6000), summary(NOT_A_SUMMARY), summary(NOT_A_SUMMARY), answersAt("The expectation is wrong: 1 + 1 is 2.", 1300))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.settled()
    // No third summary call.
    expect(h.provider.calls).toHaveLength(4)
    const checkpointText = JSON.stringify(h.provider.requests[3]!.input[0])
    expect(checkpointText).toContain("No summary of the earlier conversation could be produced")
    expect(checkpointText).toContain(say[0]!)
    expect(checkpointText).not.toContain(NOT_A_SUMMARY)
  },

  "Cancel while the summary is being written": async (h, say) => {
    h.provider.enqueue(readsAt("a.test.ts", 6000), [script.text("## Goal\n- Find out", { partial: true }), script.hang()], summary(), answersAt("The expectation is wrong: 1 + 1 is 2.", 1300))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.seen((item) => item.type === "compaction.started")
    // The summary is streaming; nothing of it is shown or stored.
    while (h.provider.calls.length < 2 || h.provider.calls[1]!.events.length < 2) await new Promise((resolve) => setTimeout(resolve, 1))
    h.session.interrupt()
    await h.settled()
    expect(h.session.projection().session.execution).toBeNull()
    h.session.send(say[1]!)
    await h.settled()
  },

  "The process dies during a compaction": async (h, say) => {
    h.provider.enqueue(readsAt("a.test.ts", 6000))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    // Dead the moment the compaction's start is durable: the summary request is never sent.
    h.dieAt("compaction.started")
    h.create().send(say[0]!)
    await h.settled()
    h.provider.enqueue(summary(), answersAt("The expectation is wrong: 1 + 1 is 2.", 1300))
    h.restart()
    await h.settled()
    expect(h.provider.calls).toHaveLength(3)
  },
}

// ---------------------------------------------------------------- approval and the sandbox

/** The sandbox of the approval scenarios: it says whether one exists; the scripted tools spawn nothing. */
const scenarioSandbox = (available: boolean): CommandSandbox => ({
  state: available ? { available: true } : { available: false, reason: NO_SANDBOX, remedy: null },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
})

const CURL = "curl -s https://example.com/notes"
const fetches = (command = CURL) => [call("call_1", "shell", { command, sandbox: { network: true } }), U]
/** Answers the next question the session asks after `after` events were seen. */
async function answerNext(h: Harness, choice: "once" | "session" | "deny", from = 0) {
  const asked = (await h.seen((item) => item.type === "approval.requested", from)) as StoredEvent<"approval.requested">
  expect(h.session.answer({ messageId: asked.data.messageId, callId: asked.data.callId }, { choice })).toBe(true)
}

Object.assign(PLAYS, {
  "Auto mode: an edit runs and a command runs in the sandbox": async (h, say) => {
    h.provider.enqueue([call("call_1", "write", { path: "a.test.ts", content: "expect(add(1, 1)).toBe(2)" }), call("call_2", "shell", { command: "bun test" }), U], answer("Fixed: the test passes."))
    h.tools.on("write", "written").on("shell", "1 pass")
    h.create().send(say[0]!)
    await h.settled()
  },

  "A command needs the network: the hint, the request, one approval, taint, and the next request asks again": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: CURL }), U], fetches(), fetches("curl -s https://example.com/next"), answer("The notes say installs are faster."))
    h.tools.on("shell", () => ({ ...failed("curl: (6) Could not resolve host: example.com\n[Exit code 6]"), display: { exitCode: 6 } }), "v2.1: faster installs")
    h.create().send(say[0]!)
    await answerNext(h, "once")
    await answerNext(h, "deny", h.seenEvents.findIndex((item) => item.type === "approval.answered") + 1)
    await h.settled()
  },

  "Ask mode: a read runs, an edit and a command each ask": async (h, say) => {
    h.provider.enqueue(
      [call("call_1", "read", { path: "a.test.ts" }), U],
      [call("call_1", "write", { path: "a.test.ts", content: "expect(add(1, 1)).toBe(2)" }), U],
      [call("call_1", "shell", { command: "bun test" }), U],
      answer("Fixed: the test passes."),
    )
    h.tools.on("read", "expect(add(1, 1)).toBe(3)").on("write", "written").on("shell", "1 pass")
    h.create().send(say[0]!)
    await answerNext(h, "once")
    await answerNext(h, "once", h.seenEvents.findIndex((item) => item.type === "approval.answered") + 1)
    await h.settled()
  },

  "A call the policy refuses": async (h, say) => {
    h.provider.enqueue([call("call_1", "write", { path: "~/.ssh/authorized_keys", content: "ssh-ed25519 AAAA" }), U], answer("I cannot change that file."))
    h.create().send(say[0]!)
    await h.settled()
  },

  "Nobody present: a call that would ask is refused and the run goes on": async (h, say) => {
    h.provider.enqueue(fetches(), answer("I could not reach example.com: this run has no network."))
    h.create().send(say[0]!)
    await h.settled()
  },

  "Nobody present, and the run ends with the refusal": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: CURL, sandbox: { network: true } }), call("call_2", "write", { path: "notes.md", content: "notes" }), U])
    h.create().send(say[0]!)
    await h.settled()
  },

  "An approval remembered for the session, then used": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], [call("call_1", "shell", { command: "bun run lint" }), U], answer("The tests pass and the linter is clean."))
    h.tools.on("shell", "1 pass", "clean")
    h.create().send(say[0]!)
    await answerNext(h, "session")
    await h.settled()
  },

  "A pending question is interrupted": async (h, say) => {
    h.provider.enqueue(fetches())
    const session = h.create()
    session.send(say[0]!)
    const asked = (await h.seen((item) => item.type === "approval.requested")) as StoredEvent<"approval.requested">
    session.interrupt()
    await h.settled()
    // The answer comes too late: the question was withdrawn.
    expect(session.answer({ messageId: asked.data.messageId, callId: asked.data.callId }, { choice: "once" })).toBe(false)
  },

  "A crash with a pending question": async (h, say) => {
    h.provider.enqueue(fetches(), fetches(), answer("The notes say installs are faster."))
    h.tools.on("shell", "v2.1: faster installs")
    h.dieAt("approval.requested")
    h.create().send(say[0]!)
    await h.settled().catch(() => {})
    h.restart()
    await answerNext(h, "once", h.seenEvents.findIndex((item) => item.type === "execution.resumed"))
    await h.settled()
  },

  "No sandbox on this machine: auto asks for every command": async (h, say) => {
    h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], answer("The test passes."))
    h.tools.on("shell", "1 pass")
    h.create().send(say[0]!)
    await answerNext(h, "once")
    await h.settled()
  },
} satisfies Record<string, Play>)

/**
 * Scenarios the loop does not reproduce event for event, with the reason and
 * the exact difference. Everything else must match its scenario as written.
 */
const DEVIATIONS: Record<string, { readonly why: string; readonly expected: (events: readonly NewEvent[]) => NewEvent[] | Promise<NewEvent[]> }> = {
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

// ---------------------------------------------------------------- forks, replays, subagents and background work

/** Records the session the replay scenarios replay: one read, then an answer. */
async function recordForReplay(h: Harness, prompt: string) {
  h.provider.enqueue([call("call_1", "read", { path: "a.test.ts" }), U], answer("The expectation is wrong."))
  h.tools.on("read", "expect(add(1, 1)).toBe(3)")
  h.create().send(prompt)
  await h.settled()
  return h.session.id
}

/** Replays the recorded session with the model doing `first` in its first step, and makes the replay session the one the test looks at. */
async function replayInto(h: Harness, prompt: string, policy: "stop" | "execute", first: Parameters<typeof h.provider.enqueue>[0], rest: Parameters<typeof h.provider.enqueue> = []) {
  const source = await recordForReplay(h, prompt)
  h.provider.enqueue(first, ...rest)
  const run = await h.engine.replaySession(source, { systemPrompt: "You are a careful coding agent.", policy })
  await run.done
  await run.session.settled()
  h.session = run.session
}

/** A background command as the scripted shell tool hands it to the session: it runs until the test ends it. */
function scriptedCommand(command: string) {
  let end: (result: { exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string }) => void = () => {}
  const exited = new Promise<Parameters<typeof end>[0]>((resolve) => (end = resolve))
  const listeners = new Set<(line: string) => void>()
  const lines = (listener: (line: string) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  return {
    start: (_input: Record<string, unknown>, context: ToolContext) => `Started in the background as ${context.background!.command({ command, logPath: "/tmp/.spill/bg.log", stop: async () => {}, output: () => "", lines, exited }).id}.`,
    /** The command prints a line: whoever follows its output is told. */
    print: (line: string) => [...listeners].forEach((listener) => listener(line)),
    /** How many follow its output right now. */
    followers: () => listeners.size,
    exit: (exitCode: number, output: string) => end({ exitCode, signal: null, timedOut: false, durationMs: 2500, output }),
  }
}

Object.assign(PLAYS, {
  "A fork continues from its parent's history": async (h, say) => {
    h.provider.enqueue(answer("It adds two numbers."), answer("There is no subtract."))
    h.create().send(say[0]!)
    await h.settled()
    const fork = await h.engine.forkSession(h.session.id)
    h.session = fork
    fork.send(say[1]!)
    await fork.settled()
  },

  "A replay that stays on its recording": (h, say) => replayInto(h, say[0]!, "stop", [call("call_1", "read", { path: "a.test.ts" }), U], [answer("The expectation is wrong.")]),

  "A replay that leaves its recording stops there": (h, say) => replayInto(h, say[0]!, "stop", [call("call_1", "read", { path: "b.test.ts" }), U]),

  "A replay that leaves its recording carries on in a copy": async (h, say) => {
    // The second read is the replay's own, off the recording: it runs for real.
    h.tools.on("read", "expect(add(1, 1)).toBe(3)", "expect(sub(2, 1)).toBe(1)")
    h.provider.enqueue([call("call_1", "read", { path: "a.test.ts" }), U], answer("The expectation is wrong."))
    h.create().send(say[0]!)
    await h.settled()
    h.provider.enqueue([call("call_1", "read", { path: "b.test.ts" }), U], answer("b.test.ts is fine."))
    const run = await h.engine.replaySession(h.session.id, { systemPrompt: "You are a careful coding agent.", policy: "execute" })
    await run.done
    await run.session.settled()
    h.session = run.session
  },

  "A subagent runs a task and its answer is the call's result": async (h, say) => {
    converse(h.provider, { [say[0]!]: [[call("call_1", "subagent", { task: "Fix module a" }), U], answer("Module a is fixed.")], "Fix module a": [answer("a.ts is fixed.")] })
    h.create().send(say[0]!)
    await h.settled()
  },

  "The subagent's own log": async (h) => {
    converse(h.provider, { "Delegate": [[call("call_1", "subagent", { task: "Fix module a" }), U], answer("Module a is fixed.")], "Fix module a": [answer("a.ts is fixed.")] })
    h.create().send("Delegate module a.")
    await h.settled()
    // The child: the second session of this engine.
    h.session = h.engine.openSession(h.session.projection().session.spawned!.children[0]!)
  },

  "A background subagent's answer arrives as a message": async (h, say) => {
    converse(h.provider, {
      [say[0]!]: [[call("call_1", "subagent", { task: "Fix module a", background: true }), U], answer("Started."), answer("The subagent fixed module a.")],
      "Fix module a": [[call("call_1", "read", { path: "a.ts" }), U], answer("a.ts is fixed.")],
    })
    // The child is still reading when the parent says that it started.
    h.tools.on("read", async () => {
      await h.seen((item) => item.type === "step.ended" && item.data.finish === "stop")
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.settled()
  },

  "A background command's exit wakes the idle session": async (h, say) => {
    const tests = scriptedCommand("bun test")
    h.provider.enqueue([call("call_1", "shell", { command: "bun test", background: true }), U], answer("The tests are running."), answer("The tests pass."))
    h.tools.on("shell", tests.start)
    h.create().send(say[0]!)
    await h.settled()
    tests.exit(0, "3 pass\n")
    await h.seen((item) => item.type === "execution.started" && item.seq > 15)
    await h.settled()
  },

  "A background command is lost when the process dies": async (h, say) => {
    const watcher = scriptedCommand("bun test --watch")
    h.provider.enqueue([call("call_1", "shell", { command: "bun test --watch", background: true }), U], answer("Watching."), answer("The watcher stopped when the harness restarted."))
    h.tools.on("shell", watcher.start)
    h.create().send(say[0]!)
    await h.settled()
    h.kill()
    // (The scenario's second input is the harness's own message about the lost command; the user's is the third.)
    h.restart().send(say[2]!)
    await h.settled()
  },

  "A watch on a background command's output wakes the idle session when a line matches": async (h, say) => {
    const server = scriptedCommand("bun run dev")
    h.provider.enqueue([call("call_1", "shell", { command: "bun run dev", background: true }), U], answer("The server is starting."), answer("The server is up on port 3000."), answer("The server has stopped."))
    h.tools.on("shell", server.start)
    h.create().send(say[0]!)
    await h.settled()
    expect(h.session.watchOutput("bg_1", UP_WATCH)).toEqual({ watchId: "bg_1.w1", spawnId: "bg_1", pattern: "listening on", regex: false, ignoreCase: false, limit: 1, fired: 0 })
    // Setting it told the model nothing and started nothing.
    expect(h.session.working).toBe(false)
    expect(h.session.projection().inbox).toEqual([])
    server.print("$ bun run dev")
    expect(h.session.working).toBe(false)
    const from = h.seenEvents.length
    server.print("Server listening on http://localhost:3000")
    await h.seen((item) => item.type === "execution.succeeded", from)
    await h.settled()
    // It fired as often as it may: nothing follows the output any more, and a later match is nobody's.
    expect(server.followers()).toBe(0)
    server.print("Server listening on http://localhost:3001")
    expect(h.session.unwatchOutput("bg_1.w1")).toBe(false)
    const later = h.seenEvents.length
    server.exit(0, "Server listening on http://localhost:3000\n")
    await h.seen((item) => item.type === "execution.succeeded", later)
    await h.settled()
    expect(() => h.session.watchOutput("bg_1", UP_WATCH)).toThrow("No background command bg_1 is running")
  },

  "A watch fires while a turn runs, and ends with its command": async (h, say) => {
    const build = scriptedCommand("bun run build --watch")
    h.provider.enqueue(
      [call("call_1", "shell", { command: "bun run build --watch", background: true }), U],
      [call("call_1", "read", { path: "src/a.ts" }), U],
      answer("The build reports the type error on line 3 of a.ts: the value is a string."),
      answer("The build stopped with the type error still in place."),
    )
    h.tools.on("shell", build.start).on("read", () => {
      build.print("[12:00:01] compiling...")
      build.print("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.")
      return "const a: number = '1'"
    })
    // The user sets the watch while the first step is still open.
    h.at("tool.settled", 1, () => void h.session.watchOutput("bg_1", ERROR_WATCH))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.session.projection().session.spawned?.running[0]?.watches).toMatchObject([{ watchId: "bg_1.w1", fired: 1, limit: 3, ended: null }])
    const from = h.seenEvents.length
    build.exit(1, "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n")
    await h.seen((item) => item.type === "execution.succeeded", from)
    await h.settled()
    expect(build.followers()).toBe(0)
  },

  "A watch is lost with its command when the process dies": async (h, say) => {
    const server = scriptedCommand("bun run dev")
    h.provider.enqueue([call("call_1", "shell", { command: "bun run dev", background: true }), U], answer("The server is starting."), answer("The server stopped when the harness restarted, and so did the watch for its start. Shall I start it again?"))
    h.tools.on("shell", server.start)
    h.create().send(say[0]!)
    await h.settled()
    h.session.watchOutput("bg_1", UP_WATCH)
    h.kill()
    // (The scenario's second input is the harness's own message about the lost command; the user's is the third.)
    h.restart().send(say[2]!)
    await h.settled()
  },

  // ---------------------------------------------------------------- skills, MCP servers and wake-ups

  "The skill index follows the files: first given, then replaced, then withdrawn": async (h, say) => {
    writeSkill(h.cwd, "release", SKILL_FIRST)
    h.provider.enqueue(answer("One: release."))
    h.create().send(say[0]!)
    await h.settled()
    writeSkill(h.cwd, "release", SKILL_EDITED)
    h.provider.enqueue([call("call_1", "shell", { command: "rm -r .claude/skills/release" }), U], answer("Removed."))
    h.tools.on("shell", () => {
      rmSync(join(h.cwd, ".claude", "skills", "release"), { recursive: true })
      return ""
    })
    h.session.send(say[1]!)
    await h.settled()
    // Three messages about skills, and never a changed prefix.
    expect(h.provider.prefixBreaks()).toEqual([])
    for (const request of h.provider.requests) expect(request.tools).toEqual(h.provider.requests[0]!.tools)
    expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).toContain("skill")
  },

  "An MCP server connects late; its tool is called through the bridge, and the result taints the session": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], [call("call_2", "mcp_call", JSON.parse(MCP_CALL_INPUT) as Json), U], answer("The server said hello."))
    h.tools.on("read", async () => {
      // The first request is out; the server connects while the tool runs.
      await waitFor(() => h.session.mcp()!.servers.some((server) => server.state === "ready"), 10_000, "the server to connect")
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(JSON.stringify(h.provider.requests[0]!.input)).not.toContain("mcp_tools")
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain("- echo: Echo the text back.")
    for (const request of h.provider.requests) expect(request.tools).toEqual(h.provider.requests[0]!.tools)
    expect(h.session.approval()!.taint.tainted).toBe(true)
  },

  "A wake-up fires while the session is idle": async (h, say) => {
    h.provider.enqueue(answer("2"), answer("The build is green."))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.session.admit({ messageId: FIRING as MessageId, origin: HARNESS_ORIGIN.wake, text: WAKE_TEXT, start: true })).toBe("admitted")
    await h.settled()
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(JSON.stringify(h.provider.requests[1]!.input.at(-1))).toContain('<harness origin=\\"wake\\">')
  },

  "A wake-up fires while a turn runs": async (h, say) => {
    h.provider.enqueue([call("call_1", "read", { path: "a.ts" }), U], answer("a is 1."), answer("The build is green."))
    h.tools.on("read", () => {
      expect(h.session.admit({ messageId: FIRING as MessageId, origin: HARNESS_ORIGIN.wake, text: WAKE_TEXT, start: true })).toBe("admitted")
      return "export const a = 1"
    })
    h.create().send(say[0]!)
    await h.settled()
    // The user's turn was answered before the model was shown the wake-up.
    expect(JSON.stringify(h.provider.requests[1]!.input)).not.toContain("Wake-up")
    expect(h.provider.prefixBreaks()).toEqual([])
  },

  "A firing is delivered again after the process died": async (h, say) => {
    h.provider.enqueue(answer("2"))
    h.create().send(say[0]!)
    await h.settled()
    // Admitted, and the process is gone before the turn starts: nothing more is in the log.
    expect(h.session.admit({ messageId: FIRING as MessageId, origin: HARNESS_ORIGIN.wake, text: WAKE_TEXT, start: false })).toBe("admitted")
    h.kill()
    const session = h.restart("wait")
    h.provider.enqueue(answer("The build is green."))
    const before = h.log().length
    expect(session.admit({ messageId: FIRING as MessageId, origin: HARNESS_ORIGIN.wake, text: WAKE_TEXT, start: true })).toBe("duplicate")
    // Nothing was admitted a second time; what was written is the start of the turn the message was to start.
    expect(h.log()[before]!.type).toBe("execution.started")
    await h.settled()
    expect(session.admit({ messageId: FIRING as MessageId, origin: HARNESS_ORIGIN.wake, text: WAKE_TEXT, start: true })).toBe("duplicate")
    await h.settled()
  },

  "A webhook's firing brings untrusted content: the session is tainted before its turn starts": async (h, say) => {
    h.provider.enqueue(answer("2"), answer("The deploy went out."))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.session.approval()!.taint.tainted).toBe(false)
    expect(h.session.admit({ messageId: FIRING as MessageId, origin: HARNESS_ORIGIN.wakeWebhook, text: WEBHOOK_TEXT, start: true, untrusted: WEBHOOK_BODY })).toBe("admitted")
    await h.settled()
    expect(h.session.approval()!.taint).toMatchObject({ tainted: true, sources: [{ kind: "wake-up", path: "webhook_body" }] })
    expect(h.provider.prefixBreaks()).toEqual([])
  },

  // ---------------------------------------------------------------- agents

  "A session starts as a read-only agent, and a write is refused with the reason": async (h, say) => {
    writeAgent(h.cwd, "reviewer", REVIEWER_FILE)
    h.provider.enqueue([call("call_1", "write", JSON.parse(WRITE_FIX) as Json), U], answer("As the reviewer I may not edit files. The expectation should be 2."))
    h.create(undefined, "reviewer").send(say[0]!)
    await h.settled()
    // The write never ran, and the model was told why in the call's result.
    expect(h.tools.ran).toEqual([])
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain('Not run: you are working as the agent \\"reviewer\\", which may use only tools that read.')
    // The agent's instructions are the last section of the baseline, under the fingerprint the baseline records for them.
    const projection = h.session.projection()
    const record = projection.session.agent!
    expect(projection.baseline!.instructions.endsWith(`<agent lines="${record.instructions.split("\n").length}">\n${record.instructions}\n</agent>`)).toBe(true)
    expect(projection.baseline!.sources.at(-1)).toEqual({ source: "agent", fingerprint: fingerprintOf(record.instructions) })
    expect(h.session.agent()?.name).toBe("reviewer")
  },

  "The user switches the agent in the middle of a session: an appended message, never a new baseline": async (h, say) => {
    writeAgent(h.cwd, "reviewer", REVIEWER_FILE)
    writeAgent(h.cwd, "captain", CAPTAIN_FILE)
    h.provider.enqueue(
      answer("The expectation is wrong: 1 + 1 is 2."),
      [call("call_1", "write", JSON.parse(WRITE_FIX) as Json), U],
      answer("As the reviewer I may not edit files."),
      [call("call_1", "write", JSON.parse(WRITE_FIX) as Json), U],
      answer("Fixed the expectation on the release branch."),
      answer("You are welcome."),
    )
    h.tools.on("write", "Wrote a.test.ts")
    h.create().send(say[0]!)
    await h.settled()
    expect(h.session.agent()).toBeNull()
    // Selected while idle: it is recorded at once, the message that tells the model and the record, with no execution.
    const before = h.log().length
    expect(h.session.setAgent("reviewer")?.name).toBe("reviewer")
    expect(h.session.agent()?.name).toBe("reviewer")
    expect(h.log().slice(before).map((item) => item.type)).toEqual(["instruction.appended", "agent.switched"])
    expect(h.session.projection().session.agent?.name).toBe("reviewer")
    expect(h.session.projection().session.execution).toBeNull()
    // Selecting it again changes nothing and writes nothing.
    h.session.setAgent("reviewer")
    expect(h.log().slice(before)).toHaveLength(2)
    expect(() => h.session.setAgent("reviewr")).toThrow('There is no agent named "reviewr". Did you mean "reviewer"? Agents: captain, reviewer.')
    h.session.send(say[1]!)
    await h.settled()
    h.session.setAgent("captain")
    h.session.send(say[2]!)
    await h.settled()
    h.session.setAgent("none")
    // The captain's model and effort stay, and the user is told so in words (taken off the list the harness expects to be empty).
    expect(h.diagnostics.splice(0).map((diagnostic) => `${diagnostic.kind}: ${diagnostic.message}`)).toEqual([
      'agents: The session keeps the model "gpt-other" and the reasoning effort "high", which the agent "captain" set: switching the agent off does not put back what the session ran with before. Change the session\'s model or effort to use another.',
    ])
    h.session.send(say[3]!)
    await h.settled()
    // The only prefix break is the model change the captain brings; the tool list and the instructions never changed.
    expect(h.provider.prefixBreaks().map((entry) => (entry.comparison.extension ? null : entry.comparison.kind))).toEqual(["params"])
    for (const request of h.provider.requests) {
      expect(request.tools).toEqual(h.provider.requests[0]!.tools)
      expect(request.instructions).toBe(h.provider.requests[0]!.instructions)
    }
    expect(h.provider.requests.map((request) => request.params.model)).toEqual(["gpt-test", "gpt-test", "gpt-test", "gpt-other", "gpt-other", "gpt-other"])
    expect(h.session.projection().session.agent).toBeNull()
  },

  "A subagent is run as an agent the list of agents names": async (h, say) => {
    writeAgent(h.cwd, "reviewer", REVIEWER_FILE)
    writeAgent(h.cwd, "captain", CAPTAIN_FILE)
    converse(h.provider, { [say[0]!]: [[call("call_1", "subagent", JSON.parse(DELEGATE_AS) as Json), U], answer("The reviewer found nothing wrong in module a.")], "Review module a": [answer("Module a is fine.")] })
    h.create().send(say[0]!)
    await h.settled()
    // The spec of `subagent` names no agent; the list is a message.
    const spec = h.provider.requests[0]!.tools.find((tool) => tool.name === "subagent")!
    expect(JSON.stringify(spec)).not.toContain("reviewer")
    expect(JSON.stringify(h.provider.requests[0]!.input)).toContain("- reviewer (read only): Reviews a change without editing anything.")
    // The parent's two requests (the child's, between them, is another session's): the second extends the first.
    expect(h.provider.requests[2]!.tools).toEqual(h.provider.requests[0]!.tools)
    expect(h.provider.requests[2]!.input.slice(0, h.provider.requests[0]!.input.length)).toEqual([...h.provider.requests[0]!.input])
  },

  "The log of a subagent that runs as an agent": async (h) => {
    writeAgent(h.cwd, "reviewer", REVIEWER_FILE)
    converse(h.provider, {
      "Delegate": [[call("call_1", "subagent", JSON.parse(DELEGATE_AS) as Json), U], answer("Reviewed.")],
      "Review module a": [[call("call_1", "write", JSON.parse(WRITE_FIX) as Json), U], answer("Module a is fine.")],
    })
    h.create().send("Delegate the review of module a.")
    await h.settled()
    expect(h.tools.ran).toEqual([])
    // The child: the second session of this engine.
    h.session = h.engine.openSession(h.session.projection().session.spawned!.children[0]!)
  },
} satisfies Record<string, Play>)

Object.assign(PLAYS, {
  // ---------------------------------------------------------------- hooks and diagnostics

  "A before hook refuses a call, and the model reads why": async (h, say) => {
    hookAnswers = { "no-push": exited(2, `${PUSH_REASON}\n`) }
    h.provider.enqueue([call("call_1", "shell", JSON.parse(PUSH_INPUT) as Json), U], answer("I committed locally. Pushing is not allowed here."))
    h.create().send(say[0]!)
    await h.settled()
    // The command never ran, and the hook is nowhere in the prefix: the model read of it in the call's result.
    expect(h.tools.ran).toEqual([])
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(JSON.stringify(h.provider.requests[0])).not.toContain("no-push")
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain(PUSH_REASON)
  },

  "An after hook adds a note to a result, stored once with it": async (h, say) => {
    hookAnswers = { prettier: exited(2, `${FORMAT_NOTE}\n`) }
    h.provider.enqueue([call("call_1", "write", JSON.parse(WRITE_HELPER) as Json), U], answer("Written; the file does not parse yet."))
    h.tools.on("write", WROTE_HELPER)
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain(FORMAT_NOTE)
  },

  "A stop hook sends the model back, and at its bound the turn ends with the hook unsatisfied": async (h, say) => {
    hookAnswers = { "no-scratch": exited(2, `${SCRATCH_REASON}\n`) }
    h.provider.enqueue(answer("Done."), answer("I cannot delete SCRATCH.md: it is not mine to remove."))
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.prefixBreaks()).toEqual([])
    // The user is told how the turn ended; the model is not sent back a second time.
    expect(h.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.message])).toEqual([["hooks", 'The turn ended although the stop hook "no-scratch" still objected: the agent was sent back 1 time already, the most a turn allows.']])
  },

  "A language server's diagnostics follow the result of the edit that made something worse": async (h, say) => {
    const file = (input: Record<string, unknown>) => join(h.cwd, String(input.path))
    mkdirSync(join(h.cwd, "src"), { recursive: true })
    writeFileSync(join(h.cwd, "src", "a.txt"), DOCUMENT_BEFORE)
    h.provider.enqueue([call("call_1", "read", JSON.parse(READ_DOCUMENT) as Json), U], [call("call_1", "write", JSON.parse(WRITE_DOCUMENT) as Json), U], answer("Added the call; fetchUser is not defined yet."))
    h.tools.on("read", (input) => readFileSync(file(input), "utf8"))
    h.tools.on("write", async (input) => {
      // The read started the server; the model's next step comes seconds later, when it is up.
      await waitFor(() => h.session.lsp()?.servers.some((server) => server.state === "ready") ?? false, 15_000, "the language server to start")
      writeFileSync(file(input), String(input.content))
      return WROTE_DOCUMENT
    })
    h.create().send(say[0]!)
    await h.settled()
    expect(h.provider.prefixBreaks()).toEqual([])
    for (const request of h.provider.requests) expect(request.tools).toEqual(h.provider.requests[0]!.tools)
    expect(JSON.stringify(h.provider.requests[0])).not.toContain("fixture")
    expect(JSON.stringify(h.provider.requests[2]!.input)).toContain("cannot find name 'fetchUser'")
  },

  // ---------------------------------------------------------------- slash commands and telemetry

  "The user sends a slash command: the expanded text is the message, and the log says which command produced it": async (h, say) => {
    writeCommand(h.cwd, "release-notes", RELEASE_NOTES_FILE)
    h.provider.enqueue(answer("Here are the notes for 1.4. Which version came before it?"))
    h.create()
    // What a palette previews before Enter: the same expansion, and nothing is written for it.
    const preview = h.session.expandCommand("release-notes", RELEASE_NOTES_ARGS)
    expect(preview).toMatchObject({ kind: "command", expansion: { text: say[0]!, missing: [2] } })
    expect(h.log()).toHaveLength(1)
    const sent = h.session.sendCommand("release-notes", RELEASE_NOTES_ARGS)
    await h.settled()
    // The user is told what was not given and what was left as text; none of it was run or read.
    expect(sent.expansion.missing).toEqual([2])
    expect(sent.expansion.unsupported.map((construct) => [construct.kind, construct.text])).toEqual([["shell", "!`git log --oneline`"], ["include", "@docs/CHANGES.md"]])
    expect(h.tools.ran).toEqual([])
    // The model is sent the expanded text as the user's message, with both constructs in it as written, and nothing else:
    // the request is the one the same words typed as a prompt make.
    const typed = new Harness({})
    typed.provider.enqueue(answer("Here are the notes for 1.4. Which version came before it?"))
    typed.create().send(say[0]!)
    await typed.settled()
    expect(JSON.stringify(h.provider.requests)).toBe(JSON.stringify(typed.provider.requests))
    await typed.dispose()
    expect(JSON.stringify(h.provider.requests[0]!.input)).toContain("!`git log --oneline`")
    // The record is in the append of the admission, and the message carries it for a transcript.
    const [admitted, record] = h.log().slice(1, 3)
    expect([admitted!.type, record!.type, record!.seq - admitted!.seq]).toEqual(["inbox.enqueued", "command.expanded", 1])
    expect(h.session.projection().messages[0]).toMatchObject({ kind: "user", id: sent.messageId, command: { name: "release-notes", arguments: "1.4", missing: [2] } })
  },

  "A command that names an agent: the session switches to it where the command's message is delivered": async (h, say) => {
    writeAgent(h.cwd, "reviewer", REVIEWER_FILE)
    writeAgent(h.cwd, "captain", CAPTAIN_FILE)
    writeCommand(h.cwd, "review", REVIEW_FILE)
    writeCommand(h.cwd, "ship", SHIP_FILE)
    h.provider.enqueue(answer("The tests do not cover the empty list."), answer("sum.test.ts."), answer("Release 1.4 is prepared on release/1.4."))
    h.create()
    expect(h.session.sendCommand("review", REVIEW_ARGS).expansion.text).toBe(say[0]!)
    await h.settled()
    expect(h.session.agent()?.name).toBe("reviewer")
    // While the question is being answered the user queues the second command: its switch waits with it.
    h.at("step.started", 1, () => {
      h.session.sendCommand("ship", SHIP_ARGS, { delivery: "queue" })
      expect(h.session.projection().session.agent?.name).toBe("reviewer")
    })
    h.session.send(say[1]!)
    await h.settled()
    expect(h.session.projection().session.agent?.name).toBe("captain")
    // The reviewer answered the question on the session's model; only the captain's turn is on the other one.
    expect(h.provider.requests.map((request) => request.params.model)).toEqual(["gpt-test", "gpt-test", "gpt-other"])
    for (const request of h.provider.requests) expect(request.tools).toEqual(h.provider.requests[0]!.tools)
    expect(h.provider.prefixBreaks().map((entry) => (entry.comparison.extension ? null : entry.comparison.kind))).toEqual(["params"])
  },

  "Live telemetry is on: the turn's log is the log it would be without, and its spans are sent as it runs": async (h, say) => {
    h.provider.enqueue([script.text("Let me read the test."), call("call_1", "read", { path: "a.test.ts" }), U], answer("The expectation is wrong: 1 + 1 is 2."))
    h.tools.on("read", "expect(add(1, 1)).toBe(3)")
    h.create().send(say[0]!)
    await h.settled()
    // The spans that were sent are the ones an export after the fact derives from the log and the ledger: the turn, two model calls, the read.
    const later = mapSession({ sessionId: h.session.id, events: h.log(), requests: h.store.readRequests(h.session.id) }).spans
    const byId = (spans: readonly Span[]) => [...spans].sort((a, b) => (a.spanId < b.spanId ? -1 : 1))
    expect(byId(exportedSpans)).toEqual(byId(later))
    expect(exportedSpans.map((span) => span.name.split(" ")[0]).sort()).toEqual(["chat", "chat", "execute_tool", "invoke_agent"])
    expect(JSON.stringify(exportedSpans)).not.toContain("expect(add")
    expect(JSON.stringify(h.provider.requests)).not.toContain("telemetry")
  },
} satisfies Record<string, Play>)

const scenarios = Object.entries(families).flatMap(([family, list]) => list.map((scenario) => ({ family, scenario })))

describe("the loop writes each scenario's events", () => {
  for (const { family, scenario } of scenarios) {
    test(`${family}: ${scenario.title}`, async () => {
      const play = PLAYS[scenario.title]
      if (play === undefined) throw new Error(`no play drives the loop through "${scenario.title}"`)
      const tools = scenario.title.includes("the next build no longer has")
        ? new ScriptedTools({ read: "read", shell: "exec", write: "write", fetch: "network" })
        : new ScriptedTools()
      const setup = scenario.setup
      const features = scenario.features
      // Skills and MCP servers are read from a real directory, which then stands for the scenarios' `/repo`.
      const cwd = features?.skills === true || features?.mcp === true || features?.agents === true || features?.lsp === true || features?.commands === true ? projectDirectory() : undefined
      hookAnswers = {}
      exportedSpans = []
      const h = new Harness({
        ...(cwd === undefined ? {} : { cwd }),
        ...(features?.skills === true ? { skills: { configDir: join(dirname(cwd!), "config") } } : {}),
        // One scripted server of the user's own, slow to start, so that the first request is out before it connects.
        ...(features?.mcp === true
          ? { mcp: { startWaitMs: 0, probeMs: 300, graceMs: 500, dropAfterMs: 200 }, userConfig: { verify: { mode: "off" as const }, mcp: { servers: { fx: fixtureServer(["--only", "echo", "--startup-delay", "300"]) } } } }
          : {}),
        ...(features?.wake === true ? { wake: {} } : {}),
        // Hooks of the user's own configuration, answered by the play's script; one scripted language server of the user's own.
        ...(features?.hooks === undefined ? {} : { hooks: { runner: scriptedHooks } }),
        ...(features?.lsp === true ? { lsp: { graceMs: 300, backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 } } } : {}),
        ...(features?.hooks !== undefined || features?.lsp === true
          ? {
              userConfig: {
                verify: { mode: "off" as const },
                ...(features.hooks === undefined ? {} : { hooks: features.hooks }),
                ...(features.lsp === true ? { lsp: { waitMs: 5000, servers: { fixture: languageServer() } } } : {}),
              },
            }
          : {}),
        ...(features?.todo === true ? { extraTools: [todoTool() as unknown as AnyTool] } : {}),
        ...(features?.agents === true ? { agents: { configDir: join(dirname(cwd!), "config") } } : {}),
        ...(features?.commands === true ? { commands: { configDir: join(dirname(cwd!), "config") } } : {}),
        // Telemetry of the user's own configuration, toward a collector that is this test: every closed span, as it closes.
        ...(features?.telemetry === true
          ? {
              userConfig: { verify: { mode: "off" as const }, telemetry: { enabled: true, endpoint: "http://collector.invalid:4318" } },
              telemetry: { mapDelayMs: 0, env: {}, send: async (spans: readonly Span[]) => (exportedSpans.push(...spans), { batches: [], sent: spans.length, failed: 0 }) },
            }
          : {}),
        tools,
        // The scenarios' conversations are a few dozen tokens long: a compaction on request is made whatever it frees.
        limits: { crashResumeCap: RESUME_CAP, attemptBudget: ATTEMPT_BUDGET, manualCompactionMinTokens: 0 },
        ...(setup === undefined ? {} : { workspace: new FakeWorkspace(setup.files) }),
        ...(setup?.config === undefined ? {} : { config: setup.config }),
        ...(scenario.contextWindow === undefined ? {} : { contextWindow: scenario.contextWindow }),
        // Subagents and background work are offered only where the scenario is about them.
        ...(scenario.spawn === undefined ? {} : { spawn: scenario.spawn }),
        // The approval layer is off unless the scenario is about it; then it runs under exactly what the scenario says.
        ...(scenario.approval === undefined
          ? {}
          : {
              approval: {
                sandbox: scenarioSandbox(scenario.approval.sandbox !== "unavailable"),
                secrets: [],
                home: HOME,
                user: { mode: scenario.approval.mode ?? "auto", unattended: scenario.approval.unattended ?? "deny" },
              },
              attended: scenario.approval.attended === true,
            }),
      })
      try {
        await play(h, prompts(scenario))
        const wanted = (await DEVIATIONS[scenario.title]?.expected(allEvents(scenario))) ?? allEvents(scenario)
        expect(comparable(inRepo(h, h.log()))).toEqual(comparable(wanted))
        // Nothing scripted was left over, so the situation happened the way the scenario describes it.
        expect(h.provider.remaining).toBe(0)
        expect(h.tools.unused).toBe(0)
        expect(h.checks.unused).toBe(0)
        // Only a simulated kill may make the engine report anything.
        // (And what a hook's own play expects the user to be told about it.)
        expect(h.diagnostics.filter((diagnostic) => diagnostic.kind !== "hooks" && !/killed|Database has closed/.test(diagnostic.message))).toEqual([])
        h.verify()
      } finally {
        await h.dispose()
      }
    })
  }

  test("every scenario has a play and every play a scenario", () => {
    expect(Object.keys(PLAYS).sort()).toEqual(scenarios.map(({ scenario }) => scenario.title).sort())
    expect(scenarios).toHaveLength(113)
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
    expect<string>(TOOL_TEXT.notStarted).toBe(NOT_STARTED)
    expect<string>(TOOL_TEXT.interruptedRead).toBe(INTERRUPTED_READ)
    expect<string>(TOOL_TEXT.effectUnknown).toBe(EFFECT_UNKNOWN)
    expect<string>(TOOL_TEXT.crashRead).toBe(CRASH_READ)
    expect<string>(TOOL_TEXT.crashEffectUnknown).toBe(CRASH_EFFECT_UNKNOWN)
    const noteText = (item: NewEvent) => (item.type === "synthetic.appended" && item.data.content[0]?.type === "text" ? item.data.content[0].text : null)
    expect<string>(NOTE_TEXT.interruptedByUser).toBe(noteText(interruptMarker("s", "user"))!)
    expect<string>(NOTE_TEXT.interruptedByRestart).toBe(noteText(interruptMarker("s", "crash"))!)
    expect<string>(NOTE_TEXT.interruptedByRestart).toBe(noteText(interruptMarker("s", "shutdown"))!)
    expect<string>(NOTE_TEXT.continuation).toBe(noteText(continuationNote("s"))!)
    expect(FAILURE_TEXT.crashCap(RESUME_CAP)).toBe(`Gave up after the harness restarted ${RESUME_CAP} times during this turn.`)
  })
})
