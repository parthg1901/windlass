/**
 * Known defect 8: an empty answer after a successful tool call ends the turn
 * as failed.
 *
 * Observed: after `wake_cancel` succeeded, the model returned an empty
 * response twice and the turn showed "failed".
 *
 * What the loop writes (`engine.ts` `LiveSession.closeStep`, the
 * `saysNothing(message)` branch): the first empty step is `step.ended stop`
 * plus a harness note (`HARNESS_ORIGIN.emptyResponse`, `NOTE_TEXT.emptyResponse`);
 * the second, seeing that note right before it (`current.messages.at(-2)`),
 * is `step.ended stop` plus `execution.failed` with `FAILURE_TEXT.emptyTwice`
 * ("The model returned an empty response twice."). It does not look at what
 * the turn did before. The rule is retry rule 8 and scenario 31 of
 * docs/step-loop-scenarios.md ("one nudge, then failure"), written for a
 * turn in which the model never did anything.
 *
 * RECOMMENDED (what the failing test asserts): when the turn already has
 * work in it (a call that settled since the turn's input), a second empty
 * answer means "nothing to add": the turn ends as any turn ends, through
 * the gate, as `execution.succeeded`. A turn with no work at all still fails
 * (scenario 31, the second test, holds today and must keep holding). The
 * change is in `closeStep`'s `nudged` branch (end through the gate instead
 * of `execution.failed` when the current turn has a settled call); the
 * reducer already accepts `execution.succeeded` after a completed empty step,
 * since the nudge is answered by it. It changes scenario 31's description
 * and adds a scenario; the gate then runs checks after such a turn.
 * ALTERNATIVE: keep the failure but give `execution.failed` a distinct
 * `cause` (say `"empty"`) so a client can say "the model stopped answering
 * after its work" instead of "failed" (a schema change).
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { StoredEvent } from "../../src/event/durable.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "../engine/harness.ts"
import { measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const empty = [U]
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

describe("known defect 8: an empty answer after the work ends the turn as failed", () => {
  test.failing("tool call, success, empty, nudge, empty: the turn ends as done", async () => {
    const h = new Harness()
    try {
      h.tools.on("write", "Wrote notes.md (1 line).")
      h.provider.enqueue([script.toolCall("call_1", "write", { path: "notes.md", content: "x\n" }), U], empty, empty)
      h.create().send("Write notes.md.")
      await h.settled()
      expect(of(h, "tool.settled").map((item) => item.data.outcome)).toEqual(["success"])
      // One nudge was written.
      expect(of(h, "synthetic.appended").filter((item) => item.data.origin === "empty_response")).toHaveLength(1)
      // The defect: execution.failed "The model returned an empty response twice."
      expect(h.log().at(-1)?.type).toBe("execution.succeeded")
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  // Scenario 31, which must keep holding: with no work in the turn, two empty answers fail it.
  test("with no work in the turn, two empty answers still fail it", async () => {
    const h = new Harness()
    try {
      h.provider.enqueue(empty, empty)
      h.create().send("Hello?")
      await h.settled()
      expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: "The model returned an empty response twice." } })
    } finally {
      await h.dispose()
    }
  })
})
