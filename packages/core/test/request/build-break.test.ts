import { describe, expect, test } from "bun:test"
import type { EventType } from "../../src/event/durable.ts"
import { checkPrefix, prefixBreakCauses } from "../../src/request/build-break.ts"
import { Script } from "./session.ts"

const events = (...types: EventType[]) => types.map((type) => ({ type }))

/** Block hashes of a two-step session at three points: after the prompt, after one step, after two. */
function points() {
  const s = new Script().open()
  s.user("fix the bug")
  const first = s.hashes()
  s.step({ parts: [{ call: "call_1" }] })
  const second = s.hashes()
  s.step({ parts: [{ text: "Done." }] })
  return { first, second, third: s.hashes() }
}

describe("prefixBreakCauses", () => {
  test("names compaction, revert and refusal, once each, in the order they first occur", () => {
    expect(
      prefixBreakCauses(
        events("step.started", "step.refused", "history.reverted", "compaction.ended", "baseline.set", "step.refused"),
      ),
    ).toEqual(["refusal", "revert", "compaction"])
  })

  test("no other event is a cause", () => {
    expect(
      prefixBreakCauses(
        events(
          "baseline.set",
          "instruction.appended",
          "synthetic.appended",
          "inbox.delivered",
          "step.failed",
          "retry.scheduled",
          "compaction.started",
          "compaction.failed",
          "execution.interrupted",
          "tool.settled",
        ),
      ),
    ).toEqual([])
  })
})

describe("checkPrefix", () => {
  test("the first request of a session has nothing to extend", () => {
    expect(checkPrefix(null, points().first, events("session.created", "baseline.set"))).toEqual({ status: "first" })
  })

  test("a request that adds blocks is an extension", () => {
    const { first, second } = points()
    expect(checkPrefix(first, second, events("step.started", "tool.called", "tool.settled", "step.ended"))).toEqual({
      status: "extension",
      appended: 2,
    })
  })

  test("an extension stays an extension when a break was allowed", () => {
    const { first, second } = points()
    expect(checkPrefix(first, second, events("history.reverted"))).toEqual({ status: "extension", appended: 2 })
  })

  test("a shorter request is an expected break after a revert", () => {
    const { first, third } = points()
    const verdict = checkPrefix(third, first, events("step.ended", "execution.succeeded", "history.reverted"))
    expect(verdict).toMatchObject({ status: "expected_break", causes: ["revert"], comparison: { change: "removed", kind: "input" } })
  })

  test("the same shorter request with no cause is a violation that names the block", () => {
    const { first, third } = points()
    const verdict = checkPrefix(third, first, events("step.ended", "execution.succeeded"))
    expect(verdict).toMatchObject({ status: "violation", comparison: { extension: false, index: first.length, kind: "input" } })
  })

  test("a changed block with no cause is a violation", () => {
    const { second } = points()
    const tampered = second.with(1, { ...second[1]!, hash: "0".repeat(64) })
    expect(checkPrefix(second, tampered, events("step.started"))).toMatchObject({
      status: "violation",
      comparison: { index: 1, kind: "tool", change: "changed" },
    })
  })
})
