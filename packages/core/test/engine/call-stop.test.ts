/**
 * Stopping one running tool call (`EngineSession.cancelCall`) in the loop,
 * beyond what the scenarios show: a tool that does not come back within the
 * grace period, the line of calls under the approval layer, a subagent's own
 * call stopped through its parent, and the properties that hold afterwards
 * (the rebuilt state equals the stored rows, every request extends the one
 * before it).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { ENGINE_LIMITS, TOOL_TEXT } from "../../src/engine/constants.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { CallId, SessionId } from "../../src/id.ts"
import { callStopReasonOf } from "../../src/interrupt.ts"
import { checkPrefix } from "../../src/request/build-break.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { CANCELLED_EFFECT_UNKNOWN, CANCELLED_READ } from "../scenarios/script.ts"
import { Harness, type HarnessOptions, converse, failed, forever, removeHarnessDirectories, untilAbort } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = script.usage({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 })
const call = (callId: string, name: string, input: Record<string, unknown>) => script.toolCall(callId, name, input as never)
const answer = (value: string) => [script.text(value), U]
const c = (id: string) => id as CallId
const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const settledOf = (h: Harness) => of(h.log(), "tool.settled").map((item) => [item.data.callId, item.data.outcome, item.data.output])

async function withHarness(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness(options)
  try {
    await run(h)
    expect(h.diagnostics).toEqual([])
    h.verify()
    for (const summary of h.store.listSessions({ includeArchived: true })) expectRebuildEqualsLive(h.store, summary.session.id)
  } finally {
    await h.dispose()
  }
}

/** The verdict of every step request in the ledger against the one before it, from the log alone. */
function verdicts(h: Harness) {
  const projection = h.store.getProjection(h.session.id)!
  const rows = h.store.readRequests(h.session.id).filter((row) => row.purpose === "step")
  return rows.map((row, index) => {
    const previous = rows[index - 1]
    if (previous === undefined) return "first"
    const seqOf = (id: string) => projection.messages.find((message) => message.id === id)!.seq
    const between = h.store.readEvents(h.session.id, { afterSeq: seqOf(previous.messageId) }).filter((item) => item.seq < seqOf(row.messageId))
    return checkPrefix(previous.blocks, row.blocks, between).status
  })
}

describe("the texts of a stopped call that reported nothing are the scenarios'", () => {
  test("texts", () => {
    expect<string>(TOOL_TEXT.cancelledRead).toBe(CANCELLED_READ)
    expect<string>(TOOL_TEXT.cancelledEffectUnknown).toBe(CANCELLED_EFFECT_UNKNOWN)
  })
})

describe("a tool that does not stop when its call is stopped", () => {
  for (const [name, input, outcome, text] of [
    ["shell", { command: "bun run migrate" }, "effect_unknown", CANCELLED_EFFECT_UNKNOWN],
    ["write", { path: "a.ts", content: "a" }, "effect_unknown", CANCELLED_EFFECT_UNKNOWN],
    ["read", { path: "a.ts" }, "error", CANCELLED_READ],
  ] as const)
    test(`${name}: after the grace period the call is settled from its effect class (${outcome}), the step goes on, and what the tool returns later is dropped`, () =>
      withHarness(async (h) => {
        h.provider.enqueue([call("call_1", name, input), U], answer("Carrying on."))
        let finish: (output: string) => void = () => {}
        const late = new Promise<string>((resolve) => (finish = resolve))
        // It never looks at its signal.
        h.tools.on(name, () => late)
        h.create().send("Go.")
        await h.seen((item) => item.type === "tool.started")
        h.clock.auto = false
        expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
        await h.clock.waiting()
        // Nothing is settled while the tool still has time to report.
        expect(settledOf(h)).toEqual([])
        expect(h.clock.slept.at(-1)).toBe(ENGINE_LIMITS.toolStopGraceMs)
        h.clock.auto = true
        h.clock.advance(ENGINE_LIMITS.toolStopGraceMs)
        await h.settled()
        expect(settledOf(h)).toEqual([["call_1", outcome, text]])
        // The tool comes back now: its call has its one result, and nothing more is written.
        const before = h.log().length
        finish("done after all")
        await Bun.sleep(5)
        expect(h.log()).toHaveLength(before)
        expect(h.log().at(-1)?.type).toBe("execution.succeeded")
        expect(verdicts(h)).toEqual(["first", "extension"])
      }))

  test("a tool that reports within the grace period settles with what it reports, and the grace period's end changes nothing", () =>
    withHarness(async (h) => {
      h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], answer("Carrying on."))
      h.tools.on("shell", async (_input, context) => {
        await untilAbort(context.signal)
        return failed("3 pass\n[Stopped by the user.]")
      })
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started")
      h.clock.auto = false
      expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
      await h.seen((item) => item.type === "tool.settled")
      h.clock.auto = true
      h.clock.advance(ENGINE_LIMITS.toolStopGraceMs)
      await h.settled()
      expect(settledOf(h)).toEqual([["call_1", "error", "3 pass\n[Stopped by the user.]"]])
    }))

  test("an interrupt during the grace period winds the call down by the interrupt's rules", () =>
    withHarness(async (h) => {
      h.provider.enqueue([call("call_1", "shell", { command: "bun run migrate" }), U])
      h.tools.on("shell", forever)
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started")
      expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
      h.session.interrupt()
      await h.settled()
      // One result, written by the wind-down: the call was stopped with the turn.
      expect(settledOf(h)).toEqual([["call_1", "effect_unknown", TOOL_TEXT.effectUnknown]])
      expect(h.log().map((item) => item.type).slice(-4)).toEqual(["tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"])
    }))
})

/** A sandbox that exists and is never asked to wrap anything: the scripted tools spawn nothing. */
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

describe("the other calls of the step", () => {
  test("under the approval layer the next command in the line starts once the stopped one has its result", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), call("call_2", "shell", { command: "bun run lint" }), U], answer("The linter is clean."))
        const reasons: (string | null)[] = []
        h.tools
          .on("shell", async (_input, context) => {
            await untilAbort(context.signal)
            reasons.push(callStopReasonOf(context.signal))
            return failed("[Stopped by the user.]")
          })
          .on("shell", async (_input, context) => {
            reasons.push(callStopReasonOf(context.signal))
            return "0 problems"
          })
        h.create().send("Run the tests, then the linter.")
        await h.seen((item) => item.type === "tool.started")
        // The second command waits in the line: it has not started, so it cannot be stopped this way.
        expect(h.session.cancelCall({ callId: c("call_2") })).toBe(false)
        expect(h.session.cancelCall({ callId: c("call_1") })).toBe(true)
        await h.settled()
        expect(reasons).toEqual(["call", null])
        expect(h.log().flatMap((item) => (item.type === "tool.started" || item.type === "tool.settled" || item.type === "tool.cancel_requested" ? [`${item.type} ${item.data.callId}`] : []))).toEqual([
          "tool.started call_1",
          "tool.cancel_requested call_1",
          "tool.settled call_1",
          "tool.started call_2",
          "tool.settled call_2",
        ])
        expect(settledOf(h).map(([, outcome]) => outcome)).toEqual(["error", "success"])
        expect(verdicts(h)).toEqual(["first", "extension"])
      },
      { approval: { sandbox, secrets: [], home: "/home/user", user: { mode: "full", unattended: "deny" } } },
    ))

  test("the model reads the stopped call's result in its next request, like any other", () =>
    withHarness(async (h) => {
      h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], answer("Carrying on."))
      h.tools.on("shell", async (_input, context) => {
        await untilAbort(context.signal)
        return failed("12 pass\n[Stopped by the user.]")
      })
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started")
      h.session.cancelCall({ callId: c("call_1") })
      await h.settled()
      const next = h.provider.requests.at(-1)!
      expect(next.input.at(-1)).toMatchObject({ type: "tool_result", callId: "call_1", output: "12 pass\n[Stopped by the user.]" })
      // The request says nothing else about the stop: no marker, no harness message.
      expect(next.input.filter((item) => item.type === "message")).toHaveLength(1)
    }))
})

describe("which call", () => {
  test("a step's message can be named; a wrong one, an idle session and an unknown subagent take nothing", () =>
    withHarness(async (h) => {
      h.provider.enqueue([call("call_1", "shell", { command: "bun test" }), U], answer("Carrying on."))
      h.tools.on("shell", async (_input, context) => {
        await untilAbort(context.signal)
        return failed("[Stopped by the user.]")
      })
      const session = h.create()
      expect(session.cancelCall({ callId: c("call_1") })).toBe(false)
      session.send("Go.")
      const started = await h.seen((item) => item.type === "tool.started")
      if (started.type !== "tool.started") throw new Error("unreachable")
      expect(session.cancelCall({ callId: c("call_1"), messageId: "msg_other" as never })).toBe(false)
      expect(session.cancelCall({ callId: c("call_1"), sessionId: "ses_other" as SessionId })).toBe(false)
      expect(session.cancelCall({ callId: c("call_1"), messageId: started.data.messageId, sessionId: session.id })).toBe(true)
      await h.settled()
      expect(of(h.log(), "tool.cancel_requested")).toHaveLength(1)
    }))

  test("a subagent's own call is stopped through its parent, and the subagent carries on", () =>
    withHarness(
      async (h) => {
        converse(h.provider, {
          "Delegate": [[call("call_1", "subagent", { task: "Fix module a" }), U], answer("Module a is fixed.")],
          "Fix module a": [[call("call_1", "shell", { command: "bun test" }), U], answer("The tests hung; a.ts is fixed anyway.")],
        })
        h.tools.on("shell", async (_input, context) => {
          await untilAbort(context.signal)
          return failed(`[Stopped by the user: ${callStopReasonOf(context.signal)}]`)
        })
        h.create().send("Delegate module a.")
        await h.seen((item) => item.type === "child.event" && item.event.type === "tool.started")
        const child = h.session.projection().session.spawned!.children[0]!
        expect(h.session.cancelCall({ callId: c("call_1"), sessionId: child })).toBe(true)
        await h.settled()
        // The child's call was stopped; the parent's call, which waited for the child, was not.
        expect(of(h.store.readEvents(child), "tool.cancel_requested")).toHaveLength(1)
        expect(of(h.store.readEvents(child), "tool.settled").map((item) => item.data.output)).toEqual(["[Stopped by the user: call]"])
        expect(of(h.log(), "tool.cancel_requested")).toEqual([])
        expect(of(h.log(), "spawn.ended").map((item) => item.data.outcome)).toEqual(["completed"])
        expect(h.store.readEvents(child).at(-1)?.type).toBe("execution.succeeded")
      },
      { spawn: {} },
    ))
})
