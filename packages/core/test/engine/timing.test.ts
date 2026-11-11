/**
 * Everything the loop waits for, with a clock moved by hand: the backoff
 * between attempts, a provider's retry-after, the cancellation of a wait,
 * and the grace period of a tool that will not stop.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { ENGINE_LIMITS, TOOL_TEXT, retryDelayMs } from "../../src/engine/constants.ts"
import { makeProviderError } from "../../src/provider/error.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ToolResult } from "../../src/tool/tool.ts"
import { Harness, forever, ok, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const serverError = () => [script.fail("provider_internal", { message: "The server had an error", status: 500 })]
const types = (h: Harness): string[] => h.log().map((item) => item.type)
/** Lets everything that is already runnable run. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("retryDelayMs", () => {
  const error = (retryAfterMs?: number) => makeProviderError("rate_limit", "slow down", retryAfterMs === undefined ? {} : { retryAfterMs })

  test("doubles from the base and stops at the cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(ENGINE_LIMITS, attempt, error(), () => 0))
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 32000, 32000])
  })

  test("jitter only ever adds, by at most the configured fraction", () => {
    expect(retryDelayMs(ENGINE_LIMITS, 1, error(), () => 0.5)).toBe(2250)
    expect(retryDelayMs(ENGINE_LIMITS, 1, error(), () => 0.999999)).toBeLessThanOrEqual(2500)
    expect(retryDelayMs(ENGINE_LIMITS, 1, error(), () => 0.999999)).toBeGreaterThan(2499)
  })

  test("a retry-after is a minimum, and is itself capped", () => {
    expect(retryDelayMs(ENGINE_LIMITS, 1, error(5000), () => 0)).toBe(5000)
    expect(retryDelayMs(ENGINE_LIMITS, 1, error(500), () => 0)).toBe(2000)
    expect(retryDelayMs(ENGINE_LIMITS, 3, error(500), () => 0)).toBe(8000)
    expect(retryDelayMs(ENGINE_LIMITS, 1, error(3_600_000), () => 0)).toBe(ENGINE_LIMITS.retryAfterCapMs)
  })
})

describe("the wait between attempts", () => {
  test("the next attempt is sent when the delay has passed, not before", async () => {
    const h = new Harness({ random: () => 0.5 })
    try {
      h.clock.auto = false
      h.provider.enqueue(serverError(), serverError(), [script.text("Done.")])
      h.create().send("Go.")
      await h.clock.waiting()
      expect(h.provider.calls).toHaveLength(1)
      expect(h.clock.slept).toEqual([2250])

      h.clock.advance(2249)
      await turn()
      expect(h.provider.calls).toHaveLength(1)
      h.clock.advance(1)
      await h.clock.waiting()
      expect(h.provider.calls).toHaveLength(2)
      expect(h.clock.slept).toEqual([2250, 4500])

      h.clock.advance(4500)
      await h.settled()
      expect(h.provider.calls).toHaveLength(3)
      expect(h.log().flatMap((item) => (item.type === "retry.scheduled" ? [[item.data.attempt, item.data.delayMs]] : []))).toEqual([
        [2, 2250],
        [3, 4500],
      ])
      expect(types(h).at(-1)).toBe("execution.succeeded")
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a retry-after longer than the backoff is waited for in full, and one longer than the cap only up to the cap", async () => {
    const h = new Harness()
    try {
      h.clock.auto = false
      h.provider.enqueue(
        [script.fail("rate_limit", { retryAfterMs: 7000 })],
        [script.fail("rate_limit", { retryAfterMs: 3_600_000 })],
        [script.text("Done.")],
      )
      h.create().send("Go.")
      await h.clock.waiting()
      h.clock.advance(6999)
      await turn()
      expect(h.provider.calls).toHaveLength(1)
      h.clock.advance(1)
      await h.clock.waiting()
      expect(h.provider.calls).toHaveLength(2)
      h.clock.advance(ENGINE_LIMITS.retryAfterCapMs)
      await h.settled()
      expect(h.clock.slept).toEqual([7000, ENGINE_LIMITS.retryAfterCapMs])
      expect(types(h).at(-1)).toBe("execution.succeeded")
    } finally {
      await h.dispose()
    }
  })

  test("a cancel ends the wait at once: the step closes as interrupted and the scheduled attempt never runs", async () => {
    const h = new Harness()
    try {
      h.clock.auto = false
      h.provider.enqueue(serverError())
      h.create().send("Go.")
      await h.clock.waiting()
      const before = h.clock.now()
      h.session.interrupt()
      await h.settled()
      expect(h.clock.now()).toBe(before)
      expect(h.clock.pending).toBe(0)
      expect(h.provider.calls).toHaveLength(1)
      expect(types(h).slice(-5)).toEqual(["retry.scheduled", "execution.interrupt_requested", "step.failed", "synthetic.appended", "execution.interrupted"])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a cancel during the wait after a failed message leaves the note and no new step", async () => {
    const h = new Harness()
    try {
      h.clock.auto = false
      h.provider.enqueue([script.text("Half an ans", { partial: true }), ...serverError()])
      h.create().send("Go.")
      await h.clock.waiting()
      h.session.interrupt()
      await h.settled()
      expect(types(h).slice(-7)).toEqual([
        "text.ended",
        "step.failed",
        "retry.scheduled",
        "synthetic.appended",
        "execution.interrupt_requested",
        "synthetic.appended",
        "execution.interrupted",
      ])
      expect(h.provider.calls).toHaveLength(1)
      // The next prompt is answered from that history; the scheduled attempt is not taken up again.
      h.clock.auto = true
      h.provider.enqueue([script.text("Hello.")])
      h.session.send("Hi.")
      await h.settled()
      expect(h.log().findLast((item) => item.type === "step.started")).toMatchObject({ data: { attempt: 1 } })
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a shutdown during the wait keeps the scheduled attempt for the process that resumes", async () => {
    const h = new Harness()
    try {
      h.clock.auto = false
      h.provider.enqueue([script.text("Half an ans", { partial: true }), ...serverError()])
      h.create().send("Go.")
      await h.clock.waiting()
      await h.engine.close()
      h.kill()
      expect(types(h.restart("wait") && h).slice(-2)).toEqual(["execution.interrupt_requested", "execution.interrupted"])
      h.clock.auto = true
      h.provider.enqueue([script.text("wer.")])
      h.session.start()
      await h.settled()
      // The retry was durably scheduled, so the new message carries its attempt.
      expect(h.log().findLast((item) => item.type === "step.started")).toMatchObject({ data: { attempt: 2 } })
      expect(types(h).at(-1)).toBe("execution.succeeded")
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("a tool that does not stop", () => {
  test("is given the grace period, then settled from its effect class; what it reports later is ignored", async () => {
    const h = new Harness()
    try {
      h.clock.auto = false
      let report: (result: ToolResult) => void = () => {}
      h.provider.enqueue([script.toolCall("call_1", "write", { path: "a.ts" }), script.toolCall("call_2", "read", { path: "b.ts" })])
      h.tools.on("write", () => new Promise<ToolResult>((resolve) => (report = resolve))).on("read", forever)
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started" && item.data.callId === "call_2")
      h.session.interrupt()
      await h.clock.waiting()
      expect(h.clock.slept).toEqual([ENGINE_LIMITS.toolStopGraceMs])
      // Nothing is settled while the tools may still report.
      h.clock.advance(ENGINE_LIMITS.toolStopGraceMs - 1)
      await turn()
      expect(types(h).at(-1)).toBe("execution.interrupt_requested")

      h.clock.advance(1)
      await h.settled()
      const settled = h.log().flatMap((item) => (item.type === "tool.settled" ? [[item.data.callId, item.data.outcome, item.data.output]] : []))
      expect(settled).toEqual([
        ["call_1", "effect_unknown", TOOL_TEXT.effectUnknown],
        ["call_2", "error", TOOL_TEXT.interruptedRead],
      ])
      expect(types(h).slice(-3)).toEqual(["step.failed", "synthetic.appended", "execution.interrupted"])

      // The write comes back after all. Its call was settled once and stays that way.
      const length = h.log().length
      report(ok("Wrote a.ts"))
      await turn()
      expect(h.log()).toHaveLength(length)
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a tool that stops within the grace period settles with what it observed, and the grace wait is dropped", async () => {
    const h = new Harness()
    try {
      h.clock.auto = false
      h.provider.enqueue([script.toolCall("call_1", "shell", { command: "bun test" })])
      h.tools.on("shell", async (_input, context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve()))
        // A bounded wait of its own, as the shell's kill-and-drain is.
        await turn()
        return { status: "error", output: "Stopped. Output so far:\n3 pass\n", truncation: null, attachments: [], display: null }
      })
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.started")
      h.session.interrupt()
      await h.settled()
      expect(h.clock.pending).toBe(0)
      expect(h.log().find((item) => item.type === "tool.settled")).toMatchObject({ data: { outcome: "error", output: "Stopped. Output so far:\n3 pass\n" } })
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("the wall-clock limit of one model call", () => {
  test("a call that is still running at the limit is stopped and retried like any transport failure", async () => {
    const h = new Harness({ limits: { modelCallTimeoutMs: 600_000 } })
    try {
      h.clock.auto = false
      h.provider.enqueue([script.text("Still wri", { partial: true }), script.hang()], [script.text("Done.")])
      h.create().send("Go.")
      await h.clock.waiting()
      expect(h.clock.slept).toEqual([600_000])
      h.clock.advance(599_999)
      await turn()
      expect(types(h).at(-1)).toBe("step.started")

      h.clock.advance(1)
      await h.clock.waiting()
      // The partial text is kept, the step fails as a timeout, and the retry waits its backoff.
      expect(types(h).slice(-4)).toEqual(["text.ended", "step.failed", "retry.scheduled", "synthetic.appended"])
      expect(h.log().find((item) => item.type === "step.failed")).toMatchObject({
        data: { error: { kind: "provider", error: { kind: "transport", reason: "timeout", retryable: true, message: "The model call did not finish within 10 minutes" } } },
      })
      // The provider's request was aborted, not left running.
      expect(h.provider.calls[0]!.outcome).not.toBe("running")
      h.clock.advance(2000)
      await h.settled()
      expect(types(h).at(-1)).toBe("execution.succeeded")
      expect(h.clock.pending).toBe(0)
      expect(h.store.readRequests(h.session.id).map((row) => [row.outcome, row.errorKind])).toEqual([
        ["error", "transport"],
        ["ok", null],
      ])
    } finally {
      await h.dispose()
    }
  })

  test("a call that finishes in time leaves no timer behind, and a limit of 0 sets none", async () => {
    for (const limit of [600_000, 0]) {
      const h = new Harness({ limits: { modelCallTimeoutMs: limit } })
      try {
        h.clock.auto = false
        h.provider.enqueue([script.text("Quick.")])
        h.create().send("Go.")
        await h.settled()
        expect(types(h).at(-1)).toBe("execution.succeeded")
        expect(h.clock.pending).toBe(0)
        expect(h.clock.slept).toEqual(limit === 0 ? [] : [limit])
      } finally {
        await h.dispose()
      }
    }
  })

  test("the default is generous", () => {
    expect(ENGINE_LIMITS.modelCallTimeoutMs).toBe(30 * 60_000)
  })
})
