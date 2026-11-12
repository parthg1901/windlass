/**
 * Compaction in the loop, beyond what the scenarios fix.
 *
 * The first group works with histories of realistic size: the scripted
 * provider "measures" each request the way the real one does (its input
 * tokens are the estimate of what it was sent), so the policy, the tail
 * chooser and the checkpoint work on numbers that agree with each other.
 * Its window is 40,000 tokens: 32,000 usable, due from 20,800, compacted
 * from 25,600, with about 6,700 tokens of history kept word for word.
 *
 * The other groups are about what happens around the summary call, and
 * script the sizes as the scenarios do: a window of 10,000 tokens, and one
 * step the provider measured at 6,000, after which the loop compacts.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import { COMPACTION_TEXT, FAILURE_TEXT } from "../../src/engine/constants.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type ScriptItem, script } from "../../src/testing/fake-provider.ts"
import { NOT_A_SUMMARY, SUMMARY, measured } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, type HarnessOptions, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const WINDOW = 40_000

/** File content of `tokens` tokens, as the estimator counts them, that no other file shares. */
function fileText(name: string, tokens: number): string {
  const line = (index: number) => `export const ${name}_${index} = compute_${name}(${index}, "value ${index} of ${name}")`
  const each = estimateTokens(`${line(100)}\n`)
  return Array.from({ length: Math.ceil(tokens / each) }, (_, index) => line(index)).join("\n")
}

/** A step the provider measured at 6,000 tokens of a 10,000-token window: the next request is over the trigger. */
const bigStep = [script.toolCall("call_1", "read", { path: "big.ts" }), script.usage(measured(6000))]
/** An answer measured small, as every request after a compaction is. */
const small = (value: string) => [script.text(value), script.usage(measured(1300))]
/** A summary answer. No usage is scripted, so none is recorded. */
const summary = (value = SUMMARY) => [script.text(value)]

/** The usage a provider would report for `request`: its input tokens are what the request is estimated at. */
const usageOf = (request: ModelRequest, output = 40) => script.usage({ inputTokens: estimateRequest(request), cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0 })
const reads = (path: string) => (request: ModelRequest) => [script.toolCall("call_1", "read", { path }), usageOf(request)]
const answers = (value: string) => (request: ModelRequest) => [script.text(value), usageOf(request)]
const summarises = (value = SUMMARY) => (request: ModelRequest) => [script.text(value), usageOf(request, 300)]
/** Whether a request is a summary request: its last item is the developer prompt. */
const isSummary = (request: ModelRequest) => request.toolChoice === "none" && request.input.at(-1)?.type === "message"

const ofType = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

async function withHarness(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness({ contextWindow: 10_000, ...options })
  try {
    await run(h)
  } finally {
    await h.dispose()
  }
}

describe("one very long turn", () => {
  test("is compacted between its steps, keeps its most recent steps each time, and finishes", () =>
    withHarness(async (h) => {
      const files = Array.from({ length: 16 }, (_, index) => `src/module-${index}.ts`)
      for (const [index, path] of files.entries()) h.tools.on("read", fileText(`m${index}`, 3_000))
      // The model reads sixteen files one after the other; whenever it is asked for a summary it gives one.
      let next = 0
      const respond = (request: ModelRequest): readonly ScriptItem[] => {
        if (isSummary(request)) return summarises()(request)
        return next < files.length ? reads(files[next++]!)(request) : answers("All sixteen modules export constants.")(request)
      }
      h.provider.enqueue(...Array.from({ length: 40 }, () => respond))
      h.create().send("Read every module under src and tell me what they export.", { maxSteps: 30 })
      await h.settled()

      expect(h.diagnostics).toEqual([])
      expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
      const started = ofType(h, "compaction.started")
      const ended = ofType(h, "compaction.ended")
      // Sixteen 3,000-token results do not fit 32,000 tokens: the turn is compacted more than once, always in the middle.
      expect(started.length).toBeGreaterThanOrEqual(2)
      expect(ended).toHaveLength(started.length)
      expect(started.every((item) => item.data.trigger === "auto" && item.data.mode === "normal")).toBe(true)
      const projection = h.session.projection()
      for (const [index, item] of started.entries()) {
        // The cut is at a step of this turn, and two or three steps are kept: about 6,700 tokens of 3,000-token results.
        const kept = projection.messages.filter((message) => message.kind === "assistant" && message.seq >= item.data.keepFromSeq && message.seq < item.seq)
        expect(projection.messages.find((message) => message.seq === item.data.keepFromSeq)?.kind).toBe("assistant")
        expect(kept.length).toBeGreaterThanOrEqual(2)
        expect(kept.length).toBeLessThanOrEqual(3)
        // It freed what it was for: the next request is estimated well under the target of 40% of the usable window.
        expect(item.data.tokensBefore).toBeGreaterThan(25_600 - 600)
        expect(ended[index]!.data.tokensAfter).toBeLessThan(12_800)
        expect(ended[index]!.data.source).toBe("model")
      }
      // No request was ever larger than the usable window, and the provider never had to reject one.
      const sizes = h.provider.requests.map((request) => estimateRequest(request))
      expect(Math.max(...sizes)).toBeLessThan(32_000)
      // The model read every file exactly once: it carried on after each compaction instead of starting over.
      expect(h.tools.ran.map((call) => call.input.path)).toEqual(files)
      // Every checkpoint quotes the request and tells the model the work was in progress.
      for (const item of ended) {
        expect(item.data.summary).toContain("> Read every module under src and tell me what they export.")
        expect(item.data.summary).toContain("The work was in progress when this checkpoint was taken.")
      }
      // The second checkpoint's index reaches behind the first: paths the first compaction took out of view are still listed.
      expect(ended[1]!.data.summary).toContain("src/module-0.ts")
      expect(ended[1]!.data.summary).toContain("src/module-7.ts")
      // The request after a compaction is the checkpoint and the kept steps; the one after that extends it.
      const steps = h.store.readRequests(h.session.id).filter((row) => row.purpose === "step")
      const breaks = h.provider.prefixBreaks().filter((entry) => !isSummary(h.provider.requests[entry.callIndex]!))
      expect(breaks).toHaveLength(started.length)
      expect(steps.length).toBe(files.length + 1)
      h.verify()
    }, { contextWindow: WINDOW }))

  test("the summary request leaves the kept steps out, and everything before them is the prefix the last steps already sent", () =>
    withHarness(async (h) => {
      for (let index = 0; index < 9; index += 1) h.tools.on("read", fileText(`m${index}`, 3_000))
      let next = 0
      const respond = (request: ModelRequest) => (isSummary(request) ? summarises()(request) : next < 9 ? reads(`src/module-${next++}.ts`)(request) : answers("Done.")(request))
      h.provider.enqueue(...Array.from({ length: 12 }, () => respond))
      h.create().send("Read the modules.", { maxSteps: 20 })
      await h.settled()
      const at = h.provider.requests.findIndex(isSummary)
      const summary = h.provider.requests[at]!
      const before = h.provider.requests[at - 1]!
      // The last step request already holds everything the summary request shows, in the same order: a cached prefix.
      const shown = summary.input.slice(0, -1)
      expect(shown.length).toBeLessThan(before.input.length)
      expect(before.input.slice(0, shown.length)).toEqual([...shown])
      expect(summary.tools).toEqual(before.tools)
      expect(summary.instructions).toBe(before.instructions)
      h.verify()
    }, { contextWindow: WINDOW }))
})

describe("when what must be kept is most of the context", () => {
  // A window of 24,000 tokens: 19,200 usable, compacted from 15,360.
  const options = { contextWindow: 24_000 }

  test("one large result that still fits is sent as it is: a compaction could take out nothing but the prompt, and costs a summary call", () =>
    withHarness(async (h) => {
      h.tools.on("read", fileText("big", 12_000))
      h.provider.enqueue(reads("big.ts"), answers("It exports constants."))
      h.create().send("Read big.ts.")
      await h.settled()
      // The second request was over the trigger and under the window.
      const size = estimateRequest(h.provider.requests[1]!)
      expect(size).toBeGreaterThan(12_000)
      expect(size).toBeLessThan(19_200)
      expect(ofType(h, "compaction.started")).toHaveLength(0)
      expect(h.provider.calls).toHaveLength(2)
      h.verify()
    }, options))

  test("a step whose results alone do not fit is compacted aggressively at once: one summary call, not a normal compaction and then an aggressive one", () =>
    withHarness(async (h) => {
      h.tools.on("read", fileText("left", 12_000), fileText("right", 12_000))
      h.provider.enqueue(
        (request) => [script.toolCall("call_1", "read", { path: "left.ts" }), script.toolCall("call_2", "read", { path: "right.ts" }), usageOf(request)],
        summarises(),
        (request) => [script.toolCall("call_1", "history_search", { query: "left_17" }), usageOf(request)],
        answers("Both export constants."),
      )
      h.create().send("Read left.ts and right.ts.")
      await h.settled()
      const started = ofType(h, "compaction.started")
      expect(started).toHaveLength(1)
      expect(started[0]!.data).toMatchObject({ trigger: "auto", mode: "aggressive" })
      // Nothing is kept word for word: the cut is the compaction's own position.
      expect(started[0]!.data.keepFromSeq).toBe(started[0]!.seq)
      expect(ofType(h, "compaction.ended")[0]!.data.tokensAfter).toBeLessThan(3_000)
      // The request after it is the checkpoint alone, and what the step read is one search away.
      expect(h.provider.requests[2]!.input).toHaveLength(1)
      const found = ofType(h, "tool.settled").at(-1)!.data
      expect(found.output).toContain('export const left_17 = compute_left(17, "value 17 of left")')
      expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
      h.verify()
    }, options))
})

describe("a summary that does not end", () => {
  const oneBigStep = (h: Harness) => {
    h.tools.on("read", "export const big = 1")
    return bigStep
  }

  test("the stream is cut at twice the summary's limit, and a summary the model kept repeating is used once", () =>
    withHarness(async (h) => {
      // The model writes the summary sixty times over: about 26,000 characters, past the bound of 20,000.
      const runaway = Array.from({ length: 60 }, () => SUMMARY).join("\n")
      h.provider.enqueue(oneBigStep(h), () => [script.text(runaway, { chunkSize: 400 }), script.usage({ inputTokens: 1 })], small("Read it."))
      h.create().send("Read big.ts.")
      await h.settled()
      const [ended] = ofType(h, "compaction.ended")
      expect(ended!.data).toMatchObject({ source: "model", detail: COMPACTION_TEXT.repeated })
      expect(ended!.data.summary).toContain(SUMMARY)
      expect(ended!.data.summary.split("## Goal").length - 1).toBe(1)
      // The loop stopped reading: the provider never got to send the rest, and no usage arrived.
      const call = h.provider.calls[1]!
      expect(call.outcome).not.toBe("finished")
      expect(call.events.filter((item) => item.type === "text.delta").length).toBeLessThan(60)
      expect(h.store.readRequests(h.session.id).find((row) => row.purpose === "compaction")).toMatchObject({ outcome: "aborted", usage: null })
      expect(ofType(h, "compaction.repair_requested")).toHaveLength(0)
      expect(ended!.data.usage).toBeNull()
      h.verify()
    }))

  test("a runaway answer that is not a summary is cut, repaired once, and the repair is used", () =>
    withHarness(async (h) => {
      const prose = Array.from({ length: 900 }, (_, index) => `Sentence ${index} about the work so far.`).join(" ")
      h.provider.enqueue(oneBigStep(h), () => [script.text(prose, { chunkSize: 500 })], summary(), small("Read it."))
      h.create().send("Read big.ts.")
      await h.settled()
      const [repair] = ofType(h, "compaction.repair_requested")
      // What is replayed to the model is what was read before the cut, without the sentence that was being written.
      expect(repair!.data.answer.length).toBeGreaterThan(19_000)
      expect(repair!.data.answer.length).toBeLessThanOrEqual(20_500)
      expect(repair!.data.prompt).toContain('the section "## Goal" is missing')
      expect(ofType(h, "compaction.ended")[0]!.data).toMatchObject({ source: "repaired", detail: null })
      h.verify()
    }))

  test("a summary call that reaches the time limit is not tried again: the compaction completes without a summary", () =>
    withHarness(
      async (h) => {
        h.clock.auto = false
        h.provider.enqueue(oneBigStep(h), () => [script.text("## Goal\n- Read big.ts", { partial: true }), script.hang()], small("Read it."))
        h.create().send("Read big.ts.")
        await h.seen((item) => item.type === "compaction.started")
        await h.clock.waiting()
        h.clock.advance(60_000)
        await h.settled()
        const [ended] = ofType(h, "compaction.ended")
        expect(ended!.data).toMatchObject({ source: "fallback", detail: COMPACTION_TEXT.timedOut(60_000) })
        expect(ended!.data.summary).toContain("No summary of the earlier conversation could be produced")
        expect(ended!.data.summary).toContain("> Read big.ts.")
        // One summary call, one ledger row, an error of the transport kind.
        expect(h.store.readRequests(h.session.id).filter((row) => row.purpose === "compaction").map((row) => [row.attempt, row.outcome, row.errorKind])).toEqual([[1, "error", "transport"]])
        expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
        h.verify()
      },
      { limits: { compactionCallTimeoutMs: 60_000 } },
    ))

  test("stopped at the time limit while repeating itself, the first copy it had written is the summary", () =>
    withHarness(
      async (h) => {
        h.clock.auto = false
        const written = `${SUMMARY}\n${SUMMARY}\n## Goal\n- Find out`
        h.provider.enqueue(oneBigStep(h), () => [script.text(written, { partial: true, chunkSize: 200 }), script.hang()], small("Read it."))
        h.create().send("Read big.ts.")
        await h.seen((item) => item.type === "compaction.started")
        // Everything it wrote has arrived; then nothing more comes.
        while (h.provider.calls.length < 2 || h.provider.calls[1]!.events.length < Math.ceil(written.length / 200)) await new Promise((resolve) => setTimeout(resolve, 1))
        h.clock.advance(60_000)
        await h.settled()
        expect(ofType(h, "compaction.ended")[0]!.data).toMatchObject({ source: "model", detail: COMPACTION_TEXT.repeated })
        h.verify()
      },
      { limits: { compactionCallTimeoutMs: 60_000 } },
    ))

  test("an empty answer is not repaired: there is nothing to repair", () =>
    withHarness(async (h) => {
      h.provider.enqueue(oneBigStep(h), () => [script.usage({ inputTokens: 1 })], small("Read it."))
      h.create().send("Read big.ts.")
      await h.settled()
      expect(ofType(h, "compaction.ended")[0]!.data).toMatchObject({ source: "fallback", detail: COMPACTION_TEXT.empty })
      expect(h.provider.calls).toHaveLength(3)
      h.verify()
    }))

  test("a repair that is only too long is used, and says so; the first answer is not", () =>
    withHarness(async (h) => {
      // Past the limit of 2,500 tokens and within the hard bound of twice that.
      const long = SUMMARY.replace("- Read the files involved.", Array.from({ length: 260 }, (_, index) => `- Read file number ${index} of the importer and noted its exports.`).join("\n"))
      h.provider.enqueue(oneBigStep(h), summary(NOT_A_SUMMARY), summary(long), small("Read it."))
      h.create().send("Read big.ts.")
      await h.settled()
      const [ended] = ofType(h, "compaction.ended")
      expect(ended!.data.source).toBe("repaired")
      expect(ended!.data.detail).toContain("the summary is used although it is about")
      expect(ended!.data.summary).toContain("- Read file number 259 of the importer")
      h.verify()
    }))
})

describe("a provider that cannot be used during a compaction", () => {
  const setup = (h: Harness) => {
    h.tools.on("read", "export const big = 1")
    return bigStep
  }

  test("a failure that can be retried is retried, each attempt its own ledger row", () =>
    withHarness(async (h) => {
      h.provider.enqueue(setup(h), [script.fail("provider_internal", { status: 500 })], summary(), small("Read it."))
      h.create().send("Read big.ts.")
      await h.settled()
      expect(h.clock.slept).toEqual([2000])
      expect(h.store.readRequests(h.session.id).filter((row) => row.purpose === "compaction").map((row) => [row.attempt, row.outcome])).toEqual([
        [1, "error"],
        [2, "ok"],
      ])
      expect(ofType(h, "compaction.ended")[0]!.data.source).toBe("model")
      // The retry sent the same request.
      expect(h.provider.requests[2]).toEqual(h.provider.requests[1]!)
      h.verify()
    }))

  test("signed out, or failing again and again, fails the execution as it would fail a step, and history is unchanged", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue(setup(h), [script.fail("auth", { message: "Signed out", status: 401 })])
        h.create().send("Read big.ts.")
        await h.settled()
        expect(h.log().slice(-2).map((item) => item.type)).toEqual(["compaction.failed", "execution.failed"])
        expect(h.log().at(-1)).toMatchObject({ data: { message: FAILURE_TEXT.compaction(FAILURE_TEXT.signedOut) } })
        expect(h.session.projection().session.compaction).toBeNull()
        const view = selectModelHistory(h.session.projection()).messages.map((message) => message.kind)
        expect(view).toEqual(["user", "assistant"])

        // The next turn, with the provider back: the compaction is made then, and the session carries on.
        h.provider.enqueue(...Array.from({ length: 3 }, () => [script.fail("rate_limit", { status: 429 })]))
        h.session.send("Try again.")
        await h.settled()
        expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: expect.stringContaining("Could not compact the conversation: The model call failed 3 times") } })
        h.provider.enqueue(summary(), small("Read it."))
        h.session.send("And again.")
        await h.settled()
        expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
        expect(ofType(h, "compaction.ended")).toHaveLength(1)
        h.verify()
      },
      { limits: { attemptBudget: 3 } },
    ))
})

describe("what arrives during a compaction", () => {
  test("a queued message waits for the turn to end; the model and the effort change at the boundary after it", () =>
    withHarness(async (h) => {
      h.tools.on("read", "export const big = 1")
      h.provider.enqueue(
        bigStep,
        () => {
          h.session.queue("Then summarise it in one line.")
          h.session.setSettings({ model: "gpt-other", reasoningEffort: "medium" })
          return summary()
        },
        small("Read it."),
        small("It exports constants."),
      )
      h.create().send("Read big.ts.")
      await h.settled()
      const types = h.log().map((item) => item.type)
      const ended = types.indexOf("compaction.ended")
      // The settings change is not accepted while the compaction is open: it follows it, and the baseline after it.
      expect(types.slice(ended, ended + 3)).toEqual(["compaction.ended", "settings.changed", "baseline.set"])
      expect(types.slice(-6)).toEqual(["turn.ended", "inbox.delivered", "step.started", "text.ended", "step.ended", "execution.succeeded"])
      expect(h.provider.requests.map((request) => request.params.model)).toEqual(["gpt-test", "gpt-test", "gpt-other", "gpt-other"])
      expect(h.diagnostics).toEqual([])
      h.verify()
    }))
})

describe("the verification gate across a compaction", () => {
  test("a turn that is compacted in the middle is still checked, sent back and checked again", async () => {
    const h = new Harness({ contextWindow: 10_000, workspace: new FakeWorkspace({ "a.ts": "1\n" }), config: { checks: [{ name: "test", command: "bun test" }] } })
    try {
      const write = (content: string) => [script.toolCall("call_1", "write", { path: "a.ts", content }), script.usage(measured(1300))]
      const writes = (input: Record<string, unknown>) => {
        h.workspace!.files.set(String(input.path), String(input.content))
        return "Wrote a.ts"
      }
      h.tools.on("read", "export const big = 1").on("write", writes, writes)
      h.provider.enqueue(bigStep, summary(), write("2\n"), small("Changed a.ts."), write("3\n"), small("Fixed a.ts."))
      h.checks.on("test", "failed", "passed")
      h.create().send("Read big.ts, then change a.ts.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test", "test"])
      expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded", data: { verification: { status: "passed" } } })
      expect(ofType(h, "compaction.ended")).toHaveLength(1)
      // The report that sent the model back is in the request after it, after the checkpoint and the kept step.
      expect(JSON.stringify(h.provider.requests[4]!.input.at(-1))).toContain("Checks run by the harness after your changes: 1 failed.")
      // The turn can still be undone: the snapshot before its prompt was kept although the prompt is behind the compaction.
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      expect(Object.fromEntries(h.workspace!.files)).toEqual({ "a.ts": "1\n" })
      expect(h.session.projection().session.compaction).toBeNull()
      expect(h.diagnostics).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("a crash around a compaction", () => {
  test("after the checkpoint was written and before the baseline was set again: the next start sets it and carries on", () =>
    withHarness(async (h) => {
      h.tools.on("read", "export const big = 1")
      h.provider.enqueue(bigStep, summary())
      h.dieAt("compaction.ended")
      h.create().send("Read big.ts.")
      await h.settled()
      h.provider.enqueue(small("Read it."))
      h.restart()
      await h.settled()
      const types = h.log().map((item) => item.type)
      const ended = types.indexOf("compaction.ended")
      expect(types.slice(ended)).toEqual(["compaction.ended", "execution.resumed", "baseline.set", "step.started", "text.ended", "step.ended", "execution.succeeded"])
      expect(h.provider.calls).toHaveLength(3)
      h.verify()
    }))

  test("while the repair was being asked for: recovery closes the compaction, and the next one starts from nothing", () =>
    withHarness(async (h) => {
      h.tools.on("read", "export const big = 1")
      h.provider.enqueue(bigStep, summary(NOT_A_SUMMARY), () => {
        h.kill()
        return [script.hang()]
      })
      h.create().send("Read big.ts.")
      await h.seen((item) => item.type === "compaction.repair_requested")
      while (h.provider.calls.length < 3) await new Promise((resolve) => setTimeout(resolve, 1))
      h.provider.enqueue(summary(), small("Read it."))
      h.restart()
      await h.settled()
      const compactions = h.session.projection().messages.filter((message) => message.kind === "compaction")
      expect(compactions.map((message) => [message.status, message.repair === null, message.source])).toEqual([
        ["failed", false, null],
        ["completed", true, "model"],
      ])
      expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
      h.verify()
    }))
})

describe("when nothing is compacted", () => {
  test("without a known context window the loop never compacts ahead of time, however large the request", async () => {
    const h = new Harness()
    try {
      h.tools.on("read", fileText("big", 60_000))
      h.provider.enqueue(reads("big.ts"), answers("Read it."))
      h.create().send("Read big.ts.")
      await h.settled()
      expect(ofType(h, "compaction.started")).toHaveLength(0)
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("below the early threshold nothing happens, at a user-message boundary or anywhere else", () =>
    withHarness(async (h) => {
      h.tools.on("read", fileText("small", 15_000))
      h.provider.enqueue(reads("small.ts"), answers("Read it."), answers("Yes."))
      h.create().send("Read small.ts.")
      await h.settled()
      h.session.send("Still there?")
      await h.settled()
      expect(ofType(h, "compaction.started")).toHaveLength(0)
      h.verify()
    }, { contextWindow: WINDOW }))

  test("a context window that cannot be had is the same as none", async () => {
    const h = new Harness()
    try {
      // The engine of this harness has no window; one that throws is tested through a second engine on the same store.
      const { createEngine } = await import("../../src/engine/engine.ts")
      h.tools.on("read", fileText("big", 60_000))
      h.provider.enqueue(reads("big.ts"), answers("Read it."))
      const engine = createEngine({
      approval: null,
        store: h.store,
        provider: h.provider,
        tools: h.tools.list(),
        dataDir: "/nonexistent",
        clock: h.clock,
        snapshots: null,
        loadConfig: null,
        discover: () => [],
        limits: { modelCallTimeoutMs: 0, compactionCallTimeoutMs: 0 },
        contextWindow: () => Promise.reject(new Error("the model list is unreachable")),
        log: () => {},
        strict: true,
      })
      const session = engine.createSession({ cwd: "/repo", settings: { model: "gpt-test", reasoningEffort: null } })
      session.send("Read big.ts.")
      await session.settled()
      expect(session.readEvents().some((item) => item.type === "compaction.started")).toBe(false)
      expect(session.readEvents().at(-1)).toMatchObject({ type: "execution.succeeded" })
      await engine.close()
    } finally {
      await h.dispose()
    }
  })
})
