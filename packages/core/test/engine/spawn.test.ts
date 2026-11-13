/**
 * Subagents and background work in the loop, with scripted tools and a model
 * scripted per conversation: what a child is and sees, calls that run side
 * by side, background results that arrive as messages, follow-ups and stops,
 * and what propagates between parent and child (interrupts, questions,
 * taint, usage, failures).
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import { TOOL_TEXT } from "../../src/engine/constants.ts"
import type { EngineSession } from "../../src/engine/engine.ts"
import { SUBAGENT_NOTE } from "../../src/engine/spawn.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { waitFor } from "../../src/testing/wait.ts"
import type { BackgroundCommand, ToolContext } from "../../src/tool/tool.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { Harness, type HarnessOptions, converse, firstPrompt, removeHarnessDirectories, untilAbort } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = (inputTokens = 100) => script.usage({ inputTokens, cachedInputTokens: 40, outputTokens: 10, reasoningTokens: 0 })
const subagent = (callId: string, input: Record<string, unknown>) => script.toolCall(callId, "subagent", input as never)
const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const types = (events: readonly StoredEvent[]) => events.map((item) => item.type)
const child = (n: number) => `ses_${n}` as SessionId
const logOf = (h: Harness, id: SessionId) => h.store.readEvents(id)
const outputs = (h: Harness) => of(h.log(), "tool.settled").map((item) => [item.data.outcome, item.data.output])

async function withHarness(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness({ spawn: {}, ...options })
  try {
    await run(h)
    h.verify()
    for (const summary of h.store.listSessions({ includeArchived: true })) expectRebuildEqualsLive(h.store, summary.session.id)
  } finally {
    await h.dispose()
  }
}

const until = (check: () => boolean) => waitFor(check, { intervalMs: 2 }).then(() => {})

describe("a subagent", () => {
  test("is a session of its own with a fresh conversation; calls in one response run side by side and return the answers with a reference", () =>
    withHarness(async (h) => {
      const scripted = converse(h.provider, {
        "Fix both": [[subagent("call_1", { task: "Fix module a" }), subagent("call_2", { task: "Fix module b" }), U()], [script.text("Both are fixed."), U()]],
        "Fix module a": [[script.toolCall("call_1", "write", { path: "a.ts", content: "a" }), U(50)], [script.text("a.ts is fixed."), U(60)]],
        "Fix module b": [[script.text("b.ts needed nothing."), U(30)]],
      })
      // The first child's tool waits for the second child to finish: with the calls in a line this would never end.
      h.tools.on("write", async () => {
        await until(() => h.store.getSession(child(3))?.session.execution === null && logOf(h, child(3)).some((item) => item.type === "execution.succeeded"))
        return "written"
      })
      const session = h.create()
      session.send("Fix both modules.")
      await h.settled()
      expect(scripted.unused()).toBe(0)

      const log = h.log()
      const started = of(log, "spawn.started")
      const ended = of(log, "spawn.ended")
      expect(started.map((item) => [item.data.work.kind === "subagent" ? item.data.work.sessionId : null, item.data.background, String(item.data.callId)])).toEqual([
        [child(2), false, "call_1"],
        [child(3), false, "call_2"],
      ])
      // Both began before either ended, and the second ended first.
      expect(Math.max(...started.map((item) => item.seq))).toBeLessThan(Math.min(...ended.map((item) => item.seq)))
      expect(ended.map((item) => [item.data.spawnId, item.data.outcome])).toEqual([
        ["bg_2", "completed"],
        ["bg_1", "completed"],
      ])
      expect(outputs(h)).toEqual([
        ["success", `b.ts needed nothing.\n\n[subagent ${child(3)}: finished after 1 step, 0 tool calls]`],
        ["success", `a.ts is fixed.\n\n[subagent ${child(2)}: finished after 2 steps, 1 tool call]`],
      ])
      expect(of(log, "tool.started").every((item) => item.data.effect === "exec")).toBe(true)

      // The child: typed lineage, the parent's workspace and settings, and a conversation that holds only its task.
      const first = h.store.getProjection(child(2))!
      expect(first.session.lineage).toEqual({ kind: "spawn", parentSessionId: session.id, spawnId: "bg_1", depth: 1, worktree: null })
      expect(first.session.rootId).toBe(child(2))
      expect(first.session.cwd).toBe("/repo")
      expect(first.session.title).toBe("Fix module a")
      expect(first.session.settings).toEqual(session.projection().session.settings)
      const requests = h.provider.requests.filter((request) => firstPrompt(request).startsWith("Fix module a"))
      expect(requests[0]!.input).toEqual([{ type: "message", role: "user", content: [{ type: "text", text: `Fix module a\n\n${SUBAGENT_NOTE}` }] }])
      expect(requests[0]!.params.cacheKey).toBe(child(2))
      // One level by default: the child is not offered `subagent`; the parent is. Both can run and stop background work.
      const names = (id: SessionId) => h.store.getProjection(id)!.baseline!.tools.map((tool) => tool.name)
      expect(names(session.id)).toEqual(["background_output", "background_stop", "history_read", "history_search", "read", "shell", "subagent", "write"])
      expect(names(child(2))).toEqual(["background_output", "background_stop", "history_read", "history_search", "read", "shell", "write"])
      // What the children cost is recorded with each end and added up in the parent.
      expect(ended.map((item) => item.data.usage?.inputTokens)).toEqual([30, 110])
      expect(session.projection().session.spawned).toEqual({
        running: [],
        children: [child(2), child(3)],
        usage: { inputTokens: 140, cachedInputTokens: 120, outputTokens: 30, reasoningTokens: 0 },
      })
      // A client of the parent sees the children's events, labelled.
      const forwarded = h.seenEvents.flatMap((item) => (item.type === "child.event" ? [item] : []))
      expect(new Set(forwarded.map((item) => `${item.child}:${item.title}`))).toEqual(new Set([`${child(2)}:Fix module a`, `${child(3)}:Fix module b`]))
      expect(forwarded.filter((item) => item.child === child(2)).map((item) => item.event.type)).toEqual(types(logOf(h, child(2))).slice(1))
      // The children are not verified and end like any turn.
      expect(of(logOf(h, child(2)), "execution.succeeded")[0]!.data.verification).toEqual({ status: "left_to_parent" })
    }))

  test("cannot start subagents of its own by default; a deeper limit lets it", async () => {
    await withHarness(async (h) => {
      converse(h.provider, {
        "Delegate": [[subagent("call_1", { task: "Child task" }), U()], [script.text("Done."), U()]],
        "Child task": [[subagent("call_1", { task: "Grandchild task" }), U()], [script.text("I did it myself."), U()]],
      })
      h.create().send("Delegate this.")
      await h.settled()
      expect(of(logOf(h, child(2)), "tool.settled").map((item) => [item.data.outcome, item.data.output])).toEqual([["error", "Not started: a subagent cannot start subagents of its own. Do the work yourself."]])
      expect(h.store.listSessions({ includeArchived: true })).toHaveLength(2)
    })
    await withHarness(
      async (h) => {
        converse(h.provider, {
          "Delegate": [[subagent("call_1", { task: "Child task" }), U()], [script.text("Done."), U()]],
          "Child task": [[subagent("call_1", { task: "Grandchild task" }), U()], [script.text("The grandchild did it."), U()]],
          "Grandchild task": [[script.text("Did it."), U()]],
        })
        h.create().send("Delegate this.")
        await h.settled()
        expect(h.store.getProjection(child(3))!.session.lineage).toMatchObject({ kind: "spawn", parentSessionId: child(2), depth: 2 })
        expect(h.store.getProjection(child(2))!.baseline!.tools.map((tool) => tool.name)).toContain("subagent")
        expect(h.store.getProjection(child(3))!.baseline!.tools.map((tool) => tool.name)).not.toContain("subagent")
        // The grandchild's cost reaches the top through its parent's own total only as the child's spawned usage.
        expect(h.store.getProjection(child(2))!.session.spawned?.usage?.inputTokens).toBe(100)
      },
      { spawn: { maxDepth: 2 } },
    )
  })

  test("that fails, or ends without an answer, comes back as that: an error result that says what happened", () =>
    withHarness(async (h) => {
      converse(h.provider, {
        "Try": [[subagent("call_1", { task: "Break" }), subagent("call_2", { task: "Mumble" }), U()], [script.text("One failed, one said nothing."), U()]],
        "Break": [[script.text("I was about to"), script.fail("invalid_request", { message: "The request was rejected." })]],
        "Mumble": [[script.reasoning("hm")], [script.reasoning("hm")]],
      })
      h.create().send("Try both.")
      await h.settled()
      const results = Object.fromEntries(of(h.log(), "tool.settled").map((item) => [String(item.data.callId), [item.data.outcome, item.data.output]]))
      expect(results.call_1).toEqual([
        "error",
        `The subagent did not finish its task. It failed: The request was rejected.\n\nIts last words:\nI was about to\n\n[subagent ${child(2)}: failed after 0 steps, 0 tool calls]`,
      ])
      expect(results.call_2![0]).toBe("error")
      expect(results.call_2![1]).toContain("The subagent did not finish its task. It failed: The model returned an empty response twice.")
      expect(of(h.log(), "spawn.ended").map((item) => item.data.outcome)).toEqual(["failed", "failed"])
    }))
})

describe("a background subagent", () => {
  test("returns at once; its answer arrives as a message at the next boundary, and the turn does not end while it works", () =>
    withHarness(async (h) => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      converse(h.provider, {
        "Look into": [
          [subagent("call_1", { task: "Research x", background: true }), U()],
          [script.text("Started; I will report when it is back."), U()],
          [script.text("The research says: x is 42."), U()],
        ],
        "Research x": [[script.toolCall("call_1", "read", { path: "x.md" }), U()], [script.text("x is 42."), U()]],
      })
      h.tools.on("read", async () => {
        await gate
        return "x = 42"
      })
      const session = h.create()
      session.send("Look into x.")
      // The parent has answered and waits: no checks, no end of the execution, while the child works.
      await h.seen((item) => item.type === "step.ended" && item.data.finish === "stop")
      await Bun.sleep(20)
      expect(session.projection().session.execution?.status).toBe("running")
      expect(session.projection().session.spawned?.running.map((entry) => [entry.kind, entry.background, entry.sessionId])).toEqual([["subagent", true, child(2)]])
      expect(session.working).toBe(true)
      release()
      await h.settled()
      const log = h.log()
      expect(outputs(h)[0]![0]).toBe("success")
      expect(outputs(h)[0]![1]).toStartWith(`Started subagent ${child(2)} in the background.`)
      const tail = types(log).slice(types(log).indexOf("spawn.ended"))
      expect(tail).toEqual(["spawn.ended", "inbox.enqueued", "inbox.delivered", "step.started", "text.ended", "step.ended", "execution.succeeded"])
      expect(of(log, "inbox.enqueued").at(-1)!.data).toMatchObject({ origin: "subagent_result", delivery: "steer", content: [{ type: "text", text: `x is 42.\n\n[subagent ${child(2)}: finished after 2 steps, 1 tool call]` }] })
      expect(of(log, "execution.started")).toHaveLength(1)
      // The model is shown it as a harness message, not as something the user said.
      const last = h.provider.requests.at(-1)!.input.at(-1)!
      expect(last.type === "message" && last.content[0]?.type === "text" ? last.content[0].text : "").toStartWith('<harness origin="subagent_result">\nx is 42.')
    }))

  test("wakes an idle parent, takes a follow-up by reference with its conversation intact, and can be looked at and stopped", () =>
    withHarness(async (h) => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      converse(h.provider, {
        "Start it": [
          [subagent("call_1", { task: "Count to one", background: true }), U()],
          [script.fail("invalid_request", { message: "The parent's own call broke." })],
          [script.text("It said one."), U()],
          [subagent("call_1", { task: "Now count to two", session: child(2) }), U()],
          [script.text("And two."), U()],
          [subagent("call_1", { task: "Wait forever", background: true }), U()],
          [script.toolCall("call_1", "background_output", { id: child(3) }), U()],
          [script.toolCall("call_1", "background_stop", { id: child(3) }), U()],
          [script.text("Stopped it."), U()],
        ],
        "Count to one": [[script.toolCall("call_1", "read", { path: "one.txt" }), U()], [script.text("One."), U()], [script.text("Two."), U()]],
        "Wait forever": [[script.text("Waiting."), script.toolCall("call_1", "shell", { command: "sleep 999" }), U()]],
      })
      h.tools.on("shell", async (_input, context: ToolContext) => {
        await untilAbort(context.signal)
        return "stopped"
      })
      h.tools.on("read", async () => {
        await gate
        return "1"
      })
      const session = h.create()
      // The parent's own turn fails after it started the child: the session is idle when the child's answer comes, and is woken by it.
      session.send("Start it.")
      await h.seen((item) => item.type === "execution.failed")
      await h.settled()
      expect(session.working).toBe(false)
      release()
      await h.seen((item) => item.type === "execution.succeeded")
      await h.settled()
      expect(of(h.log(), "execution.started")).toHaveLength(2)
      expect(of(h.log(), "inbox.enqueued").at(-1)!.data.origin).toBe("subagent_result")

      // A follow-up by reference: the child still has its conversation, and this piece of its work is new spawned work.
      session.send("Start it again, with a follow-up.")
      await h.settled()
      expect(outputs(h).at(-1)).toEqual(["success", `Two.\n\n[subagent ${child(2)}: finished after 1 step, 0 tool calls]`])
      const followUp = h.provider.requests.filter((request) => firstPrompt(request).startsWith("Count to one")).at(-1)!
      expect(followUp.input.map((item) => (item.type === "message" ? item.content.map((part) => (part.type === "text" ? part.text.split("\n")[0] : "")).join("") : item.type))).toEqual(["Count to one", "tool_call", "tool_result", "assistant_text", "Now count to two"])
      expect(of(h.log(), "spawn.started").map((item) => [item.data.spawnId, item.data.work.kind === "subagent" ? item.data.work.sessionId : null])).toEqual([
        ["bg_1", child(2)],
        ["bg_2", child(2)],
      ])
      expect(session.projection().session.spawned?.children).toEqual([child(2)])

      session.send("Start it once more and stop it.")
      await h.settled()
      const [, looked, stopped] = outputs(h).slice(-3)
      expect(looked).toEqual(["success", `Subagent ${child(3)} is still working: 0 steps, 1 tool call so far.`])
      expect(stopped![0]).toBe("success")
      expect(stopped![1]).toBe(`The subagent did not finish its task. It was stopped before it finished: it was asked to stop.\n\nIts last words:\nWaiting.\n\n[subagent ${child(3)}: stopped after 0 steps, 1 tool call]`)
      expect(of(h.log(), "spawn.ended").at(-1)!.data.outcome).toBe("stopped")
      // Stopped by the tool: its result is the tool's result, and no message follows.
      expect(of(h.log(), "inbox.enqueued").filter((item) => item.data.origin === "subagent_result")).toHaveLength(1)
      expect(of(logOf(h, child(3)), "execution.interrupted").map((item) => item.data.reason)).toEqual(["user"])
    }))
})

describe("between parent and child", () => {
  test("an interrupt of the parent stops its children, and each log ends as interrupted", () =>
    withHarness(async (h) => {
      converse(h.provider, {
        "Do two": [[subagent("call_1", { task: "Slow one" }), subagent("call_2", { task: "Slow two", background: true }), U()]],
        "Slow one": [[script.toolCall("call_1", "shell", { command: "sleep 1" }), U()]],
        "Slow two": [[script.toolCall("call_1", "shell", { command: "sleep 2" }), U()]],
      })
      const wait = async (_input: Record<string, unknown>, context: ToolContext) => {
        await untilAbort(context.signal)
        return "stopped"
      }
      h.tools.on("shell", wait, wait)
      const session = h.create()
      session.send("Do two things.")
      await until(() => [child(2), child(3)].every((id) => (h.store.getSession(id) === null ? false : logOf(h, id).some((item) => item.type === "tool.started"))))
      session.interrupt()
      await h.settled()
      await until(() => session.projection().session.spawned?.running.length === 0)
      expect(of(h.log(), "spawn.ended").map((item) => [item.data.outcome, item.data.detail]).sort()).toEqual([
        ["stopped", "It was stopped before it finished: this session was interrupted."],
        ["stopped", "It was stopped before it finished: this session was interrupted."],
      ])
      for (const id of [child(2), child(3)]) {
        expect(types(logOf(h, id)).slice(-2)).toEqual(["synthetic.appended", "execution.interrupted"])
        expect(h.store.getSession(id)!.session.execution).toBeNull()
      }
      expect(session.projection().session.execution).toBeNull()
      // The foreground call observed its child stopping and says so; the background child's end waits in the inbox for the next prompt.
      expect(outputs(h).find(([, output]) => output?.includes(child(2)))?.[1]).toContain("It was stopped before it finished: this session was interrupted.")
      expect(session.projection().inbox.map((item) => item.origin)).toEqual(["subagent_result"])
    }))

  const sandbox: CommandSandbox = {
    state: { available: true },
    temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
    plan: () => {
      throw new Error("a scripted tool spawns nothing")
    },
    policy: () => {
      throw new Error("a scripted tool spawns nothing")
    },
  }
  const approval: ApprovalSetup = { sandbox, secrets: [], home: "/Users/user" }
  const fetching = {
    "Fetch it": [[subagent("call_1", { task: "Download the notes" }), U()], [script.text("The notes are in."), U()]],
    "Download the notes": [[script.toolCall("call_1", "shell", { command: "curl -s https://example.com/notes", sandbox: { network: true } }), U()], [script.text("Downloaded."), U()]],
  }

  test("a child's question reaches the user through the parent's client, labelled with the child; the answer goes back the same way; its taint becomes the parent's", () =>
    withHarness(
      async (h) => {
        converse(h.provider, fetching)
        h.tools.on("shell", "notes")
        const session = h.create()
        session.send("Fetch it.")
        const asked = await h.seen((item) => item.type === "child.event" && item.event.type === "approval.requested")
        if (asked.type !== "child.event" || asked.event.type !== "approval.requested") throw new Error("unreachable")
        expect(asked.child).toBe(child(2))
        expect(asked.title).toBe("Download the notes")
        const pending = session.approval()!.pending!
        expect(pending.child).toEqual({ sessionId: child(2), title: "Download the notes" })
        expect(pending.question.title).toBe(asked.event.data.question.title)
        expect([pending.messageId, pending.callId]).toEqual([asked.event.data.messageId, asked.event.data.callId])
        // An answer for a call that is nobody's is not taken; the child's is, through the parent.
        expect(session.answer({ messageId: pending.messageId, callId: "call_x" as never }, { choice: "once" })).toBe(false)
        expect(session.answer({ sessionId: child(2), messageId: pending.messageId, callId: pending.callId }, { choice: "once" })).toBe(true)
        await h.settled()
        expect(of(logOf(h, child(2)), "approval.answered").map((item) => item.data.choice)).toEqual(["once"])
        expect(of(logOf(h, child(2)), "taint.noticed").map((item) => item.data.source.kind)).toEqual(["network-command"])
        // The child's conversation holds untrusted content: so does the parent's, from the result on.
        const ended = of(h.log(), "spawn.ended")[0]!
        expect(ended.data.tainted).toBe(true)
        expect(of(h.log(), "taint.noticed").map((item) => item.data)).toEqual([
          {
            source: { at: ended.seq, tool: "subagent", kind: "subagent", path: child(2) },
            text: `Content from subagent ${child(2)}, whose own conversation holds untrusted content, is in this conversation and may contain instructions aimed at the model.`,
          },
        ])
        expect(session.approval()!.taint.tainted).toBe(true)
        expect(outputs(h)[0]![1]).toContain("Note: its conversation holds content from a source the harness does not control")
      },
      { approval, attended: true, attendedChildren: true },
    ))

  test("without a client that answers for children, a child has nobody to ask: its call is refused, and it says so", () =>
    withHarness(
      async (h) => {
        converse(h.provider, fetching)
        const session = h.create()
        session.send("Fetch it.")
        await h.settled()
        expect(of(logOf(h, child(2)), "approval.denied").map((item) => item.data.reason)).toEqual(["unattended"])
        expect(of(logOf(h, child(2)), "approval.requested")).toEqual([])
        expect(session.approval()!.taint.tainted).toBe(false)
        expect(of(h.log(), "spawn.ended")[0]!.data.tainted).toBe(false)
      },
      { approval, attended: true },
    ))
})

describe("a background command", () => {
  /** A command as the shell tool hands it over: it "runs" until the test ends it or it is stopped. */
  function fakeCommand(command: string) {
    let end: (result: { exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string }) => void = () => {}
    const exited = new Promise<Parameters<typeof end>[0]>((resolve) => (end = resolve))
    const state = { printed: "", stopped: false }
    const work: BackgroundCommand = {
      command,
      logPath: "/tmp/.spill/bg.log",
      stop: async () => {
        state.stopped = true
        end({ exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: 1200, output: state.printed })
      },
      output: () => state.printed,
      exited,
    }
    return { work, state, exit: (exitCode: number) => end({ exitCode, signal: null, timedOut: false, durationMs: 2500, output: state.printed }) }
  }
  const background = (h: Harness, started: ReturnType<typeof fakeCommand>) => (_input: Record<string, unknown>, context: ToolContext) => `Started in the background as ${context.background!.command(started.work).id}.`
  const bgShell = (command: string) => script.toolCall("call_1", "shell", { command, background: true })

  test("is spawned work of the session: the model goes on, its exit arrives as a message and wakes the idle session", () =>
    withHarness(async (h) => {
      const tests = fakeCommand("bun test")
      h.provider.enqueue([bgShell("bun test"), U()], [script.toolCall("call_1", "read", { path: "a.ts" }), U()], [script.text("Reading while the tests run."), U()], [script.text("The tests passed."), U()])
      h.tools.on("shell", background(h, tests)).on("read", "export const a = 1")
      const session = h.create()
      session.send("Run the tests in the background and read a.ts.")
      await h.settled()
      // The turn is over and the command still runs.
      expect(session.projection().session.execution).toBeNull()
      expect(session.projection().session.spawned?.running.map((entry) => [entry.spawnId, entry.kind, entry.command, entry.logPath])).toEqual([["bg_1", "command", "bun test", "/tmp/.spill/bg.log"]])
      expect(outputs(h)[0]).toEqual(["success", "Started in the background as bg_1."])
      tests.state.printed = "3 pass\n0 fail\n"
      tests.exit(0)
      await h.seen((item) => item.type === "execution.succeeded" && item.seq > session.projection().lastSeq - 1)
      await h.settled()
      const log = h.log()
      const from = types(log).indexOf("spawn.ended")
      expect(types(log).slice(from)).toEqual(["spawn.ended", "inbox.enqueued", "execution.started", "inbox.delivered", "step.started", "text.ended", "step.ended", "execution.succeeded"])
      expect(of(log, "spawn.ended")[0]!.data).toEqual({ spawnId: "bg_1", outcome: "completed", detail: "Background command bg_1 exited with code 0 after 2.5 s.", exitCode: 0, usage: null, tainted: false, merge: null })
      expect(of(log, "inbox.enqueued").at(-1)!.data).toMatchObject({
        origin: "background_command",
        delivery: "steer",
        content: [{ type: "text", text: "Background command bg_1 exited with code 0 after 2.5 s.\nCommand: bun test\nOutput:\n3 pass\n0 fail\nFull output: /tmp/.spill/bg.log" }],
      })
      expect(session.projection().session.spawned?.running).toEqual([])
    }))

  test("polled again and again while it prints nothing new, every call runs: the identical-call guard leaves a tool whose result changes by itself alone", () =>
    withHarness(async (h) => {
      const build = fakeCommand("bun run build")
      const poll = () => [script.toolCall("call_1", "background_output", { id: "bg_1" }), U()]
      h.provider.enqueue([bgShell("bun run build"), U()], poll(), poll(), poll(), poll(), [script.toolCall("call_1", "background_stop", { id: "bg_1" }), U()], [script.text("Stopped it."), U()])
      let polls = 0
      h.tools.on("shell", (input, context) => {
        build.state.printed = "compiling\n"
        return background(h, build)(input, context)
      })
      h.at("tool.started", 5, () => {
        // Before the fourth poll runs the command prints: three identical answers were not the last word.
        polls += 1
        build.state.printed = "compiling\ndone\n"
      })
      h.create().send("Build in the background and watch it.")
      await h.settled()
      const same = ["success", "bg_1 is still running.\nOutput so far:\ncompiling"]
      expect(outputs(h).slice(1, 5)).toEqual([same, same, same, ["success", "bg_1 is still running.\nOutput so far:\ncompiling\ndone"]])
      expect(polls).toBe(1)
      expect(outputs(h).map(([, output]) => output)).not.toContain(TOOL_TEXT.identicalCall)
    }))

  test("can be read while it runs and stopped by the model; an interrupt and a shutdown stop it too", () =>
    withHarness(async (h) => {
      const server = fakeCommand("bun run dev")
      h.provider.enqueue(
        [bgShell("bun run dev"), U()],
        [script.toolCall("call_1", "background_output", { id: "bg_1" }), U()],
        [script.toolCall("call_1", "background_stop", { id: "bg_1" }), U()],
        [script.toolCall("call_1", "background_output", { id: "bg_1" }), U()],
        [script.text("Stopped the server."), U()],
      )
      h.tools.on("shell", (input, context) => {
        server.state.printed = "listening on :3000\n"
        return background(h, server)(input, context)
      })
      const session = h.create()
      session.send("Start the server, look at it, stop it.")
      await h.settled()
      expect(outputs(h).slice(1)).toEqual([
        ["success", "bg_1 is still running.\nOutput so far:\nlistening on :3000"],
        ["success", "Background command bg_1 was stopped (it was asked to stop) after 1.2 s.\nCommand: bun run dev\nOutput:\nlistening on :3000\nFull output: /tmp/.spill/bg.log"],
        ["error", "No background work bg_1 is running. Work that has ended delivered its result as a message, or as the result of the call that started it."],
      ])
      expect(server.state.stopped).toBe(true)
      expect(of(h.log(), "spawn.ended")[0]!.data).toMatchObject({ outcome: "stopped", exitCode: null })
      // Stopped by the tool: no message, the session is not woken.
      expect(of(h.log(), "inbox.enqueued")).toHaveLength(1)

      // A command that runs while the user interrupts is stopped with the turn, and says so at the next prompt.
      const slow = fakeCommand("sleep 60")
      h.provider.enqueue([bgShell("sleep 60"), U()], [script.hang()])
      h.tools.on("shell", background(h, slow))
      const from = h.seenEvents.length
      session.send("Start something slow.")
      await h.seen((item) => item.type === "step.started", (await h.seen((item) => item.type === "spawn.started", from).then(() => h.seenEvents.length)) - 1)
      session.interrupt()
      await h.settled()
      await until(() => session.projection().session.spawned?.running.length === 0)
      expect(slow.state.stopped).toBe(true)
      expect(of(h.log(), "spawn.ended").at(-1)!.data.detail).toBe("Background command bg_2 was stopped (this session was interrupted) after 1.2 s.")
      expect(session.projection().inbox.map((item) => item.origin)).toEqual(["background_command"])
      expect(session.projection().session.execution).toBeNull()

      // And a command that runs when the session is closed is stopped with it.
      const last = fakeCommand("tail -f log")
      h.provider.enqueue([bgShell("tail -f log"), U()], [script.text("Tailing."), U()])
      h.tools.on("shell", background(h, last))
      session.send("Tail the log.")
      await h.settled()
      expect(last.state.stopped).toBe(false)
      await session.close()
      expect(last.state.stopped).toBe(true)
      expect(of(h.log(), "spawn.ended").at(-1)!.data.detail).toBe("Background command bg_3 was stopped (the harness shut down) after 1.2 s.")
    }))
})

describe("recovery of spawned work", () => {
  const expectClosed = (session: EngineSession) => expect(session.projection().session.spawned?.running).toEqual([])

  test("a background command the process died with is recorded as lost, and the model is told", async () => {
    const h = new Harness({ spawn: {} })
    try {
      const never: BackgroundCommand = { command: "bun test --watch", logPath: "/tmp/.spill/watch.log", stop: async () => {}, output: () => "", exited: new Promise(() => {}) }
      h.provider.enqueue([script.toolCall("call_1", "shell", { command: "bun test --watch", background: true }), U()], [script.text("Watching."), U()], [script.text("The watcher is gone; I will start it again if needed."), U()])
      h.tools.on("shell", (_input, context) => `Started as ${context.background!.command(never).id}.`)
      h.create().send("Watch the tests.")
      await h.settled()
      expect(h.session.projection().session.spawned?.running).toHaveLength(1)
      h.kill()
      const session = h.restart()
      await h.settled()
      expectClosed(session)
      expect(of(h.log(), "spawn.ended")[0]!.data).toMatchObject({ spawnId: "bg_1", outcome: "lost", detail: "The harness restarted while it ran, and it was stopped with it." })
      // Opening the session starts nothing: the message waits for the next prompt, and is delivered with it.
      expect(session.projection().inbox.map((item) => item.origin)).toEqual(["spawn_lost"])
      session.send("Still watching?")
      await h.settled()
      const said = h.provider.requests.at(-1)!.input.flatMap((item) => (item.type === "message" ? [item.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []))
      expect(said.at(-2)).toBe('<harness origin="spawn_lost">\nBackground command bg_1 is gone: the harness restarted while it ran, and it was stopped with it.\nCommand: bun test --watch\nWhat it had printed is in /tmp/.spill/watch.log.\n</harness>')
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a parent that died with a running child: the child's turn is ended, the call's result says it was cut, and the model is told what the child had done", async () => {
    const h = new Harness({ spawn: {} })
    try {
      converse(h.provider, {
        // The message about the lost child arrives before or after the parent's next step: it answers once or twice.
        "Hand it over": [[subagent("call_1", { task: "Long job" }), U()], [script.text("The subagent was cut off; I will look at what it did."), U()], [script.text("Noted."), U()]],
        "Long job": [[script.text("Starting."), script.toolCall("call_1", "shell", { command: "make all" }), U()]],
      })
      // The process dies while the child's command runs.
      h.tools.on("shell", () => {
        h.kill()
        return new Promise<never>(() => {})
      })
      h.create().send("Hand it over.")
      await until(() => h.tools.ran.length === 1)
      await Bun.sleep(10)
      const session = h.restart()
      await h.settled()
      await until(() => session.projection().session.spawned?.running.length === 0)
      await h.settled()
      // The child: its orphaned call is settled, its step closed as crashed, and its claim released as an interrupt.
      const childLog = logOf(h, child(2))
      expect(types(childLog).slice(-6)).toEqual(["tool.settled", "step.failed", "synthetic.appended", "execution.resumed", "execution.interrupt_requested", "execution.interrupted"])
      expect(h.store.getSession(child(2))!.session.execution).toBeNull()
      // The parent: its call's effect is unknown, the spawned work is lost, and a message says what the child had done.
      const log = h.log()
      expect(of(log, "tool.settled")[0]!.data.outcome).toBe("effect_unknown")
      expect(of(log, "spawn.ended")[0]!.data).toMatchObject({ outcome: "lost", detail: "It was cut off when the harness restarted." })
      expect(of(log, "inbox.enqueued").at(-1)!.data).toMatchObject({
        origin: "spawn_lost",
        content: [{ type: "text", text: `The subagent did not finish its task. It was cut off when the harness restarted.\n\nIts last words:\nStarting.\n\n[subagent ${child(2)}: lost after 0 steps, 1 tool call]` }],
      })
      expect(types(log).at(-1)).toBe("execution.succeeded")
      h.verify()
      expectRebuildEqualsLive(h.store, child(2))
    } finally {
      await h.dispose()
    }
  })

  test("a child whose parent is gone runs on by itself when it is opened, and its answer reaches the parent when that is opened again", async () => {
    const h = new Harness({ spawn: {} })
    try {
      converse(h.provider, {
        "Hand it over": [[subagent("call_1", { task: "Short job", background: true }), U()], [script.text("Started."), U()], [script.text("It is done: 7."), U()]],
        "Short job": [[script.toolCall("call_1", "read", { path: "n.txt" }), U()], [script.text("The number is 7."), U()]],
      })
      // The process dies while the child reads.
      h.tools.on("read", () => {
        h.kill()
        return new Promise<never>(() => {})
      })
      const parent = h.create()
      parent.send("Hand it over.")
      await until(() => h.tools.ran.length === 1)
      await Bun.sleep(10)
      // The next process opens the child, not the parent: it recovers and finishes its task like any session.
      h.boot()
      const orphan = h.engine.openSession(child(2))
      await orphan.settled()
      expect(types(logOf(h, child(2))).at(-1)).toBe("execution.succeeded")
      await orphan.close()
      // Then the parent: the child's answer is delivered, as the answer it is.
      h.session = parent
      const session = h.open()
      await until(() => session.projection().session.spawned?.running.length === 0)
      await h.settled()
      expect(of(h.log(), "spawn.ended")[0]!.data).toMatchObject({ outcome: "completed" })
      expect(of(h.log(), "inbox.enqueued").at(-1)!.data).toMatchObject({ origin: "subagent_result", content: [{ type: "text", text: `The number is 7.\n\n[subagent ${child(2)}: finished after 1 step, 1 tool call]` }] })
      expect(types(h.log()).at(-1)).toBe("execution.succeeded")
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})
