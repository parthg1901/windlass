/**
 * The engine's surface and the loop rules that no scenario spells out: the
 * event stream, starting and closing, sign-in refresh, the per-step and
 * per-turn limits, and what happens when the harness itself is wrong.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { type EngineEvent, EventChannel } from "../../src/engine/channel.ts"
import { COMPACTION_TEXT, FAILURE_TEXT, NOTE_TEXT, TOOL_TEXT } from "../../src/engine/constants.ts"
import { EngineError, createEngine } from "../../src/engine/engine.ts"
import type { MessageId, RequestId, SessionId } from "../../src/id.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { Harness, forever, removeHarnessDirectories, untilAbort } from "./harness.ts"

afterAll(removeHarnessDirectories)

const types = (h: Harness): string[] => h.log().map((item) => item.type)
const read = (path: string, callId = "call_1") => script.toolCall(callId, "read", { path })
const settledOutputs = (h: Harness) => h.log().flatMap((item) => (item.type === "tool.settled" ? [[item.data.outcome, item.data.output]] : []))

async function withHarness(run: (h: Harness) => Promise<void>, options: ConstructorParameters<typeof Harness>[0] = {}) {
  const h = new Harness(options)
  try {
    await run(h)
  } finally {
    await h.dispose()
  }
}

describe("the event stream", () => {
  test("yields every durable event and delta in order and ends after close", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.reasoning("Hmm."), script.text("Hello, world!", { chunkSize: 5 })])
      const session = h.create()
      const received: EngineEvent[] = []
      const reading = (async () => {
        for await (const item of session.events) received.push(item)
      })()
      session.send("Hi.")
      await h.settled()
      await session.close()
      await reading
      expect(received.map((item) => item.type)).toEqual([
        "session.created",
        "inbox.enqueued",
        "execution.started",
        "baseline.set",
        "inbox.delivered",
        "step.started",
        "reasoning.delta",
        "reasoning.ended",
        "text.delta",
        "text.delta",
        "text.delta",
        "text.ended",
        "step.ended",
        "execution.succeeded",
      ])
      // The durable part of the stream is the log.
      expect(received.filter((item) => "seq" in item)).toEqual([...h.log()])
    }))

  test("a consumer that does not read never stalls the loop, and its backlog holds one delta per run of deltas", () =>
    withHarness(async (h) => {
      const long = "word ".repeat(4000)
      h.provider.enqueue([script.text(long, { chunkSize: 1 }), script.toolCall("call_1", "read", { path: "a.ts" }, { chunkSize: 1 })], [script.text("ok")])
      h.tools.on("read", "x")
      const session = h.create()
      session.send("Go.")
      // Nobody has read `session.events` yet: the turn still runs to its end.
      await h.settled()
      expect(types(h).at(-1)).toBe("execution.succeeded")
      await session.close()
      const backlog: EngineEvent[] = []
      for await (const item of session.events) backlog.push(item)
      const deltas = backlog.filter((item) => item.type === "text.delta")
      expect(deltas).toHaveLength(2)
      expect(deltas[0]).toMatchObject({ text: long })
      expect(backlog.filter((item) => item.type === "tool.input.delta")).toMatchObject([{ input: '{"path":"a.ts"}' }])
      expect(backlog.filter((item) => "seq" in item)).toEqual([...h.log()])
    }))

  test("the channel merges only deltas of the same item and keeps durable events apart", async () => {
    const channel = new EventChannel()
    const delta = (text: string, messageId = "m1") => ({ type: "text.delta", sessionId: "s" as SessionId, messageId: messageId as MessageId, text }) as const
    const progress = (text: string) => ({ type: "tool.progress", sessionId: "s" as SessionId, messageId: "m1" as MessageId, callId: "c1" as never, text }) as const
    for (const item of [delta("a"), delta("b"), delta("c", "m2"), progress("1"), progress("2"), delta("d")]) channel.push(item)
    expect(channel.backlog).toBe(4)
    channel.end()
    channel.push(delta("late"))
    const read: EngineEvent[] = []
    for await (const item of channel) read.push(item)
    expect(read).toEqual([delta("ab"), delta("c", "m2"), progress("2"), delta("d")])
  })

  test("a reader that keeps up sees every delta as it arrived", async () => {
    const channel = new EventChannel()
    const iterator = channel[Symbol.asyncIterator]()
    const first = iterator.next()
    channel.push({ type: "text.delta", sessionId: "s" as SessionId, messageId: "m" as MessageId, text: "a" })
    expect((await first).value).toMatchObject({ text: "a" })
    const second = iterator.next()
    channel.push({ type: "text.delta", sessionId: "s" as SessionId, messageId: "m" as MessageId, text: "b" })
    expect((await second).value).toMatchObject({ text: "b" })
  })
})

describe("sessions", () => {
  test("the most recent session of a working directory is found, and an unknown one is an error", () =>
    withHarness(async (h) => {
      const first = h.create()
      const second = h.engine.createSession({ cwd: "/repo", settings: { model: "gpt-test", reasoningEffort: null } })
      h.engine.createSession({ cwd: "/elsewhere", settings: { model: "gpt-test", reasoningEffort: null } })
      h.clock.time += 1000
      h.provider.enqueue([script.text("Hi.")])
      first.send("Hello.")
      await h.settled()
      expect(h.engine.latestSession("/repo")?.session.id).toBe(first.id)
      expect(h.engine.latestSession("/nowhere")).toBeNull()
      expect(h.engine.openSession(second.id)).toBe(second)
      expect(() => h.engine.openSession("ses_missing" as SessionId)).toThrow(EngineError)
    }))

  test("a prompt sent while a cancel winds down starts a new execution once the claim is released", () =>
    withHarness(async (h) => {
      h.provider.enqueue([read("a.ts")], [script.text("Fresh start.")])
      h.tools.on("read", async (_input, context) => {
        await untilAbort(context.signal)
        // The user types again while the tool is still stopping.
        h.session.send("Do this instead.")
        return "stopped"
      })
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started")
      h.session.interrupt()
      await h.settled()
      expect(types(h).slice(-9)).toEqual([
        "tool.settled",
        "step.failed",
        "synthetic.appended",
        "execution.interrupted",
        "execution.started",
        "inbox.delivered",
        "step.started",
        "text.ended",
        "step.ended",
        "execution.succeeded",
      ].slice(1))
      h.verify()
    }))

  test("a prompt sent the moment a turn ends starts the next execution", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.text("One.")], [script.text("Two.")])
      const session = h.create()
      // A consumer that answers the end of a turn at once, before the drain has returned.
      let sent = false
      session.subscribe((item) => {
        if (item.type !== "execution.succeeded" || sent) return
        sent = true
        session.send("Second.")
      })
      session.send("First.")
      await h.settled()
      expect(h.log().filter((item) => item.type === "execution.succeeded")).toHaveLength(2)
      expect(h.session.projection().inbox).toEqual([])
      expect(h.provider.remaining).toBe(0)
    }))

  test("a provider that ignores the abort signal does not hold a cancel up", () =>
    withHarness(async (h) => {
      const session = h.create()
      // Not the scripted provider: one whose stream never ends and never looks at the signal.
      const deaf = h.provider.stream
      h.provider.stream = () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }),
      })
      session.send("Go.")
      await h.seen((item) => item.type === "step.started")
      session.interrupt()
      await h.settled()
      h.provider.stream = deaf
      expect(types(h).slice(-4)).toEqual(["execution.interrupt_requested", "step.failed", "synthetic.appended", "execution.interrupted"])
      expect(h.store.readRequests(session.id).map((row) => row.outcome)).toEqual(["aborted"])
    }))

  test("a settings change while idle is recorded at once, and an unchanged one records nothing", () =>
    withHarness(async (h) => {
      const session = h.create()
      session.setSettings({ model: "gpt-test", reasoningEffort: "medium" })
      session.setSettings({ model: "gpt-test", reasoningEffort: "high" })
      expect(types(h)).toEqual(["session.created", "settings.changed"])
    }))

  test("close is a shutdown that can be repeated, and a closed session takes no more input", () =>
    withHarness(async (h) => {
      h.provider.enqueue([read("a.ts")])
      h.tools.on("read", async (_input, context) => {
        await untilAbort(context.signal)
        throw new Error("stopped")
      })
      const session = h.create()
      session.send("Go.")
      await h.seen((item) => item.type === "tool.started")
      const [first, second] = [session.close(), session.close()]
      expect(first).toBe(second)
      await first
      await h.engine.close()
      expect(h.engine.close()).toBe(h.engine.close())
      expect(types(h).slice(-5)).toEqual(["execution.interrupt_requested", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"])
      expect(h.store.getProjection(session.id)!.session.execution).toMatchObject({ status: "suspended", crashResumes: 0 })
      expect(() => session.send("More.")).toThrow(EngineError)
      expect(() => h.engine.createSession({ cwd: "/repo", settings: { model: "m", reasoningEffort: null } })).toThrow(EngineError)
    }))

  test("a crashed claim opened with `wait` is repaired at once and worked on only when asked", () =>
    withHarness(async (h) => {
      h.provider.enqueue([read("a.ts")])
      h.tools.on("read", forever)
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started")
      h.kill()
      const session = h.restart("wait")
      expect(types(h).slice(-4)).toEqual(["tool.settled", "step.failed", "synthetic.appended", "execution.resumed"])
      expect(session.working).toBe(false)
      h.provider.enqueue([script.text("Back.")])
      session.send("Are you there?")
      await h.settled()
      // The new prompt is in front of the model in the very first step after the restart.
      expect(types(h).slice(-6)).toEqual(["inbox.enqueued", "inbox.delivered", "step.started", "text.ended", "step.ended", "execution.succeeded"])
      h.verify()
    }))

  test("closing a session whose recovered claim was never worked on suspends it, so the next start does not count a crash", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.text("Half", { partial: true }), script.hang()])
      h.create().send("Go.")
      await h.seenText("Half")
      h.kill()
      await h.restart("wait").close()
      expect(types(h).slice(-2)).toEqual(["execution.interrupt_requested", "execution.interrupted"])
      h.kill()
      h.provider.enqueue([script.text("Done.")])
      h.restart()
      await h.settled()
      expect(h.log().filter((item) => item.type === "execution.resumed")).toHaveLength(2)
      expect(types(h).at(-1)).toBe("execution.succeeded")
    }))
})

describe("settings are checked against the models the provider offers", () => {
  const engineWith = (listModels: (() => Promise<readonly string[]>) | undefined) => {
    const store = openSqliteStore({ path: ":memory:" })
    const engine = createEngine({ approval: null,  store, provider: new FakeProvider(), tools: [], dataDir: "/nonexistent", snapshots: null, loadConfig: null, ...(listModels === undefined ? {} : { listModels }) })
    return { engine, store }
  }

  test("an unknown model is refused with the valid choices", async () => {
    const { engine, store } = engineWith(async () => ["gpt-6-luna", "gpt-6.1-sol"])
    const refused = await engine.validateSettings({ model: "gpt-6-lunar", reasoningEffort: null }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(EngineError)
    expect(refused).toMatchObject({ code: "unknown_model", message: "model gpt-6-lunar is not available; choose one of: gpt-6-luna, gpt-6.1-sol" })
    await engine.validateSettings({ model: "gpt-6-luna", reasoningEffort: "low" })
    store.close()
  })

  test("without a listing, or when it cannot be fetched, nothing is refused", async () => {
    for (const listModels of [undefined, async () => Promise.reject(new Error("offline")), async () => []]) {
      const { engine, store } = engineWith(listModels)
      await engine.validateSettings({ model: "anything", reasoningEffort: null })
      store.close()
    }
  })
})

describe("sign-in", () => {
  test("an auth error refreshes the sign-in once and sends the same request again", async () => {
    let refreshes = 0
    await withHarness(
      async (h) => {
        h.provider.enqueue([script.fail("auth", { status: 401 })], [script.text("Hello.")])
        h.create().send("Hi.")
        await h.settled()
        expect(refreshes).toBe(1)
        expect(h.provider.requests[1]).toEqual(h.provider.requests[0]!)
        // No retry is recorded: nothing about the step changed.
        expect(types(h).slice(-4)).toEqual(["step.started", "text.ended", "step.ended", "execution.succeeded"])
        expect(h.store.readRequests(h.session.id).map((row) => [row.attempt, row.outcome, row.errorKind])).toEqual([
          [1, "error", "auth"],
          [1, "ok", null],
        ])
      },
      { refreshAuth: async () => ++refreshes > 0 },
    )
  })

  test("a second auth error, or a refresh that fails, ends the execution asking the user to sign in", async () => {
    for (const refreshAuth of [async () => true, async () => false, async () => Promise.reject(new Error("offline"))]) {
      await withHarness(
        async (h) => {
          h.provider.enqueue([script.fail("auth", { status: 401 })], [script.fail("auth", { status: 401 })])
          h.create().send("Hi.")
          await h.settled()
          expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: FAILURE_TEXT.signedOut } })
          expect(h.log().filter((item) => item.type === "retry.scheduled")).toEqual([])
        },
        { refreshAuth },
      )
    }
  })

  test("a usage limit is never retried and says when it resets", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.fail("usage_limit", { message: "You have hit your usage limit.", status: 429, retryAfterMs: 3 * 3_600_000 })])
      h.create().send("Hi.")
      await h.settled()
      expect(h.provider.calls).toHaveLength(1)
      expect(h.clock.slept).toEqual([])
      expect(h.log().at(-1)).toMatchObject({ data: { message: "You have hit your usage limit. It resets in 3 hours." } })
    }))
})

describe("limits", () => {
  test("the engine's step limit applies when the caller sets none, and new input resets the allowance", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue(
          [read("1.ts")],
          [read("2.ts")],
          (request) => {
            expect(request.toolChoice).toBe("none")
            return [script.text("Out of steps.")]
          },
          (request) => {
            expect(request.toolChoice).toBe("auto")
            return [read("3.ts")]
          },
          [script.text("Read it.")],
        )
        h.tools.on("read", "1", "2", "3")
        h.create().send("Read everything.")
        await h.settled()
        h.session.send("One more file.")
        await h.settled()
        expect(h.log().filter((item) => item.type === "synthetic.appended")).toHaveLength(1)
        expect(types(h).at(-1)).toBe("execution.succeeded")
        expect(h.provider.prefixBreaks()).toEqual([])
      },
      { limits: { stepLimit: 2 } },
    ))

  test("a tool call made in the final step is answered, not run", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([read("1.ts")], [read("2.ts")], [script.text("That is all.")])
        h.tools.on("read", "1")
        h.create().send("Read.", { maxSteps: 1 })
        await h.settled()
        expect(h.tools.ran).toHaveLength(1)
        expect(settledOutputs(h)).toEqual([
          ["success", "1"],
          ["error", TOOL_TEXT.toolsDisabled],
        ])
        expect(types(h).at(-1)).toBe("execution.succeeded")
        h.verify()
      },
      {},
    ))

  test("a model that keeps asking for tools after the limit fails the execution instead of going round for ever", () =>
    withHarness(async (h) => {
      for (let step = 0; step < 5; step += 1) h.provider.enqueue([read(`${step}.ts`)])
      h.tools.on("read", "0")
      h.create().send("Read.", { maxSteps: 1 })
      await h.settled()
      expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: FAILURE_TEXT.stepLimitIgnored } })
      expect(h.provider.calls).toHaveLength(4)
      expect(h.tools.ran).toHaveLength(1)
    }))

  test("calls beyond the per-step limit are answered with an error and the rest run", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([read("a.ts", "call_1"), read("b.ts", "call_2"), read("c.ts", "call_3")], [script.text("ok")])
        h.tools.on("read", "a", "b")
        h.create().send("Read.")
        await h.settled()
        expect(settledOutputs(h).map(([outcome]) => outcome).sort()).toEqual(["error", "success", "success"])
        expect(settledOutputs(h).find(([outcome]) => outcome === "error")![1]).toBe(TOOL_TEXT.tooManyCalls(2))
        h.verify()
      },
      { limits: { maxToolCallsPerStep: 2 } },
    ))

  test("the identical-call guard is reset by any other call in between, and keeps holding while the model repeats itself", () =>
    withHarness(async (h) => {
      h.provider.enqueue(
        [read("a.ts")],
        [read("a.ts")],
        [script.toolCall("call_1", "write", { path: "a.ts", content: "2" })],
        // The file may have changed: the same read runs again.
        [read("a.ts")],
        [read("a.ts")],
        [read("a.ts")],
        [read("a.ts")],
        [script.text("ok")],
      )
      h.tools.on("read", "1", "1", "2", "2").on("write", "Wrote a.ts")
      h.create().send("Go.")
      await h.settled()
      expect(settledOutputs(h).map(([outcome, output]) => (output === TOOL_TEXT.identicalCall ? "refused" : outcome))).toEqual([
        "success",
        "success",
        "success",
        "success",
        "success",
        "refused",
        "refused",
      ])
      expect(h.tools.ran).toHaveLength(5)
    }))
})

describe("model output the scenarios leave open", () => {
  test("a response cut off by the output limit keeps what its calls that started did, and starts nothing more", () =>
    withHarness(async (h) => {
      // The read starts as its arguments end; the write after the command waits for it, and the cut comes first.
      h.provider.enqueue(
        [read("a.ts"), script.toolCall("call_2", "shell", { command: "bun test" }), script.toolCall("call_3", "write", { path: "b.ts", content: "b" }), script.toolCall("call_4", "write", '{"path":"c.ts","content":"', { partial: true }), script.finish("length")],
        [script.text("ok")],
      )
      h.tools.on("read", "export const a = 1").on("shell", async () => {
        await h.responded(0)
        return "1 pass"
      })
      h.create().send("Go.")
      await h.settled()
      expect(h.tools.ran.map((call) => call.name)).toEqual(["read", "shell"])
      expect(settledOutputs(h)).toEqual([
        ["success", "export const a = 1"],
        ["success", "1 pass"],
        ["not_started", TOOL_TEXT.notStarted],
      ])
      const ended = types(h).indexOf("step.ended")
      expect(types(h).slice(ended - 2, ended + 2)).toEqual(["tool.settled", "tool.settled", "step.ended", "synthetic.appended"])
      h.verify()
    }))

  test("an answer cut off by the output limit ends the turn without a note", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.text("A very long ans"), script.finish("length")])
      h.create().send("Go.")
      await h.settled()
      expect(types(h).slice(-3)).toEqual(["text.ended", "step.ended", "execution.succeeded"])
    }))

  test("a response that holds only reasoning says nothing, and is nudged like an empty one", () =>
    withHarness(async (h) => {
      const thought = () => [script.reasoning("Thinking about it.", { providerData: { encrypted_content: "gAAAA" } })]
      h.provider.enqueue(thought(), [script.text("   ")])
      h.create().send("Go.")
      await h.settled()
      expect(types(h).slice(-8)).toEqual(["step.started", "reasoning.ended", "step.ended", "synthetic.appended", "step.started", "text.ended", "step.ended", "execution.failed"])
      expect(h.log().findLast((item) => item.type === "synthetic.appended")).toMatchObject({ data: { origin: "empty_response" } })
      expect(h.log().at(-1)).toMatchObject({ data: { message: FAILURE_TEXT.emptyTwice } })
      // The reasoning-only message renders nothing, so the request after it is still valid for the provider.
      expect(h.provider.requests[1]!.input.map((item) => item.type)).toEqual(["message", "message"])
      h.verify()
    }))

  test("after the nudge a model that answers carries on normally", () =>
    withHarness(async (h) => {
      h.provider.enqueue([], [script.text("Sorry. Done.")])
      h.create().send("Go.")
      await h.settled()
      expect(h.provider.requests[1]!.input.at(-1)).toMatchObject({ role: "user", content: [{ text: expect.stringContaining(NOTE_TEXT.emptyResponse) }] })
      expect(types(h).at(-1)).toBe("execution.succeeded")
    }))

  test("a provider failure after a call started: the call finishes, the step fails, and the model is asked to continue", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.text("Reading."), read("a.ts"), script.fail("transport", { message: "connection reset" })], [read("a.ts", "call_2")], [script.text("ok")])
      h.tools.on("read", "1", "1")
      h.create().send("Go.")
      await h.settled()
      // The recorded call is durable output, so the retry is never transparent: the message fails first.
      expect(types(h).slice(5, 14)).toEqual([
        "step.started",
        "text.ended",
        "tool.called",
        "tool.started",
        "tool.settled",
        "step.failed",
        "retry.scheduled",
        "synthetic.appended",
        "step.started",
      ])
      expect(settledOutputs(h)[0]).toEqual(["success", "1"])
      expect(h.tools.ran).toHaveLength(2)
      // The model continues from the failed message with its call and the call's result.
      const input = JSON.stringify(h.provider.requests[1]!.input)
      expect(input).toContain('"callId":"call_1"')
      h.verify()
    }))

  test("a second overflow right after the compaction fails the execution instead of compacting again", () =>
    withHarness(async (h) => {
      const overflow = () => [script.fail("context_overflow", { message: "too long", status: 400 })]
      h.provider.enqueue([script.text("One.")], overflow(), [script.text(SUMMARY)], overflow())
      h.create().send("First.")
      await h.settled()
      h.session.send("Second.")
      await h.settled()
      expect(h.log().filter((item) => item.type === "compaction.started")).toHaveLength(1)
      expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: FAILURE_TEXT.overflow } })
      h.verify()
    }))

  test("a first prompt that is itself too large is compacted too: without a summary when it cannot be summarised either", () =>
    withHarness(async (h) => {
      const overflow = () => [script.fail("context_overflow", { message: "too long", status: 400 })]
      // The prompt is rejected; so is the request to summarise it; then the checkpoint alone is answered.
      h.provider.enqueue(overflow(), overflow(), [script.text("It is a log of a failed deploy.")])
      h.create().send("A prompt that is itself too long.")
      await h.settled()
      expect(types(h).slice(5)).toEqual(["step.started", "step.failed", "compaction.started", "compaction.ended", "baseline.set", "step.started", "text.ended", "step.ended", "execution.succeeded"])
      expect(h.log().find((item) => item.type === "compaction.ended")).toMatchObject({ data: { source: "fallback", detail: COMPACTION_TEXT.tooLarge } })
      // What the model is shown instead: the prompt quoted in the checkpoint, and where to read all of it.
      const shown = JSON.stringify(h.provider.requests[2]!.input)
      expect(h.provider.requests[2]!.input).toHaveLength(1)
      expect(shown).toContain("A prompt that is itself too long.")
      expect(shown).toContain("history_read")
      h.verify()
    }))

  test("an overflow with nothing in view to take out fails without a compaction", () =>
    withHarness(async (h) => {
      const overflow = () => [script.fail("context_overflow", { message: "too long", status: 400 })]
      h.provider.enqueue(overflow(), overflow(), overflow())
      h.create().send("A prompt that is itself too long.")
      await h.settled()
      // The request built from the fallback checkpoint alone is rejected too: nothing more can be done.
      expect(h.log().filter((item) => item.type === "compaction.started")).toHaveLength(1)
      expect(types(h).slice(-2)).toEqual(["step.failed", "execution.failed"])
      expect(h.log().at(-1)).toMatchObject({ data: { message: FAILURE_TEXT.overflow } })
      h.verify()
    }))

  test("a cancel during the compaction closes it as interrupted and releases the claim", () =>
    withHarness(async (h) => {
      h.provider.enqueue([script.text("One.")], [script.fail("context_overflow", { status: 400 })], [script.text("Summ", { partial: true }), script.hang()])
      h.create().send("First.")
      await h.settled()
      h.session.send("Second.")
      await h.seen((item) => item.type === "compaction.started")
      await new Promise((resolve) => setTimeout(resolve, 5))
      h.session.interrupt()
      await h.settled()
      expect(types(h).slice(-4)).toEqual(["execution.interrupt_requested", "compaction.failed", "synthetic.appended", "execution.interrupted"])
      expect(h.session.projection().session.execution).toBeNull()
      h.verify()
    }))
})

describe("when the harness itself is wrong", () => {
  test("a request that breaks the cached prefix with no event to allow it is reported, and thrown only in strict mode", async () => {
    for (const strict of [true, false]) {
      await withHarness(
        async (h) => {
          h.provider.enqueue([script.text("One.")], [script.text("Two.")])
          h.create().send("First.")
          await h.settled()
          // A ledger row that claims a different request was sent for that step: what a bug in the builder would look like.
          const row = h.store.readRequests(h.session.id)[0]!
          h.store.beginRequest({
            id: "req_forged" as RequestId,
            sessionId: row.sessionId,
            messageId: row.messageId,
            attempt: row.attempt,
            purpose: "step",
            model: row.model,
            provider: row.provider,
            blocks: row.blocks.map((block, index) => (index === 0 ? { ...block, hash: "0".repeat(64) } : block)),
          })
          h.session.send("Second.")
          await h.settled()
          expect(h.diagnostics[0]).toMatchObject({ kind: "prefix_violation", message: expect.stringContaining("params block 0 changed") })
          if (strict) {
            expect(h.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["prefix_violation", "internal_error"])
            expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: expect.stringContaining("does not extend the previous one") } })
            return
          }
          // A user's session is told, loudly, and carries on.
          expect(h.diagnostics).toHaveLength(1)
          expect(types(h).at(-1)).toBe("execution.succeeded")
        },
        { strict },
      )
    }
  })

  test("a diagnostic about a session is an event of its stream, so a client can show it", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([script.text("One.")], [script.text("Two.")])
        h.create().send("First.")
        await h.settled()
        const row = h.store.readRequests(h.session.id)[0]!
        h.store.beginRequest({
          id: "req_forged" as RequestId,
          sessionId: row.sessionId,
          messageId: row.messageId,
          attempt: row.attempt,
          purpose: "step",
          model: row.model,
          provider: row.provider,
          blocks: row.blocks.map((block, index) => (index === 0 ? { ...block, hash: "0".repeat(64) } : block)),
        })
        const from = h.seenEvents.length
        h.session.send("Second.")
        await h.settled()
        const shown = h.seenEvents.slice(from).filter((item) => item.type === "diagnostic")
        expect(shown).toEqual([{ type: "diagnostic", sessionId: h.session.id, kind: "prefix_violation", message: expect.stringContaining("does not extend the previous one") }])
        // It is not part of the log.
        expect(types(h)).not.toContain("diagnostic")
      },
      { strict: false },
    ))

  test("an internal failure closes the step and releases the claim, and the session stays usable", () =>
    withHarness(async (h) => {
      // The provider repeats a call ID inside one response, which the log cannot hold.
      h.provider.enqueue([read("a.ts", "call_1"), read("b.ts", "call_1")], [script.text("Fine now.")])
      h.tools.on("read", "export const a = 1")
      h.create().send("Go.")
      await h.settled()
      // The first call started as its arguments ended and has its result; the second could not be recorded.
      expect(types(h).slice(-5)).toEqual(["tool.called", "tool.started", "tool.settled", "step.failed", "execution.failed"])
      expect(h.log().at(-2)).toMatchObject({ data: { error: { kind: "internal" } } })
      expect(h.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["internal_error"])
      h.session.send("Again.")
      await h.settled()
      expect(types(h).at(-1)).toBe("execution.succeeded")
      h.verify()
    }))

  test("a tool that throws is settled from its effect class and reported", () =>
    withHarness(async (h) => {
      h.provider.enqueue([read("a.ts", "call_1"), script.toolCall("call_2", "write", { path: "b.ts" })], [script.text("ok")])
      h.tools
        .on("read", () => {
          throw new Error("read bug")
        })
        .on("write", () => {
          throw new Error("write bug")
        })
      h.create().send("Go.")
      await h.settled()
      expect(settledOutputs(h).map(([outcome]) => outcome)).toEqual(["error", "effect_unknown"])
      expect(h.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["tool_crashed", "tool_crashed"])
      expect(types(h).at(-1)).toBe("execution.succeeded")
    }))
})
