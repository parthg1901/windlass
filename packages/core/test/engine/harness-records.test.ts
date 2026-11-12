/**
 * Tools that change only the harness's own records are not asked about as
 * file writes.
 *
 * `wake_cancel`, `memory_save` and `memory_retract` have the effect class
 * `write` and name no path: they change the wake-up store and the notes,
 * not the workspace. Each says so (`Tool.changes: "records"`), `callFacts`
 * (`engine/approval.ts`) hands that to `decide` as a fact, and `planCall`
 * (`approval/decide.ts`) reads it: such a call runs without a question in
 * the modes `auto` and `full`, attended or not, and is asked about only in
 * `ask`, where every change asks, as a change of the harness's records.
 * The class stays `write`, so `effect_unknown` after a crash and the
 * snapshots around the step stay as they are.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { brand } from "../../src/brand.ts"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, type HarnessOptions, removeHarnessDirectories } from "./harness.ts"
import { measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
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
/** The default the real harness runs with: mode `auto` in a sandbox, nobody present. */
const approval = (more: Partial<ApprovalSetup> = {}): ApprovalSetup => ({ sandbox, secrets: [], home: "/home/user", ...more })

async function withHarness(options: HarnessOptions, run: (h: Harness) => Promise<void>) {
  const h = new Harness(options)
  try {
    await run(h)
  } finally {
    await h.dispose()
  }
}

describe("tools that change only the harness's own records", () => {
  test("auto, nobody present: wake_create runs, and so does the wake_cancel of the wake-up it made", () =>
    withHarness({ approval: approval(), wake: {} }, async (h) => {
      h.provider.enqueue(
        [call("wake_create", { trigger: "after", seconds: 600, message: "Check the deploy." }), U],
        (request: ModelRequest) => {
          const last = request.input.at(-1)
          const id = /wk_[0-9a-f]{12}/.exec(last?.type === "tool_result" ? last.output : "")![0]
          return [call("wake_cancel", { id, reason: "not needed" }, "call_2"), U]
        },
        answer("Set up and cancelled."),
      )
      h.create().send("Remind me in ten minutes, then forget it.")
      await h.settled()
      const started = of(h, "tool.started").map((item) => item.data.effect)
      // wake_create is decided as a sandboxed command and runs.
      expect(started[0]).toBe("exec")
      // wake_cancel changes a record of the harness's own: it is not asked about as a write without a checkable path.
      expect(of(h, "approval.denied")).toEqual([])
      expect(of(h, "tool.settled").map((item) => item.data.outcome)).toEqual(["success", "success"])
      expect(h.engine.wake()!.store.list({ sessionId: h.session.id })).toEqual([])
    }))

  test("auto, nobody present: memory_save runs", () =>
    withHarness({ approval: approval(), memory: {}, userConfig: { memory: { enabled: true } } }, async (h) => {
      h.provider.enqueue([call("memory_save", { text: "The deploy script is scripts/deploy-all.sh.", kind: "fact", scope: "project" }), U], answer("Saved."))
      h.create().send("Remember where the deploy script is: scripts/deploy-all.sh.")
      await h.settled()
      expect(of(h, "approval.denied")).toEqual([])
      expect(of(h, "tool.settled")[0]?.data.outcome).toBe("success")
    }))

  test("ask, attended: the question is about the harness's records, not about a file, and can be remembered for the tool", () =>
    withHarness({ approval: approval({ user: { mode: "ask" } }), wake: {}, attended: true }, async (h) => {
      h.provider.enqueue([call("wake_cancel", { id: "wk_000000000000", reason: "not needed" }), U], answer("Done."))
      h.create().send("Cancel it.")
      const asked = (await h.seen((item) => item.type === "approval.requested")) as StoredEvent<"approval.requested">
      expect(asked.data.needs).toEqual([{ kind: "records", tool: "wake_cancel" }])
      expect(asked.data.question.title).toBe(`Allow wake_cancel: changing ${brand.name}'s own records?`)
      expect(asked.data.question.details.join("\n")).not.toContain("path")
      expect(asked.data.question.choices.map((choice) => choice.id)).toEqual(["once", "session", "project", "deny"])
      h.session.interrupt()
      await h.settled()
    }))

  test("full, nobody present: wake_cancel runs, and its call is still recorded as a write", () =>
    withHarness({ approval: approval({ user: { mode: "full" } }), wake: {} }, async (h) => {
      h.provider.enqueue([call("wake_cancel", { id: "wk_000000000000", reason: "not needed" }), U], answer("There was none."))
      h.create().send("Cancel it.")
      await h.settled()
      expect(of(h, "approval.denied")).toEqual([])
      expect(of(h, "approval.requested")).toEqual([])
      expect(of(h, "tool.started").map((item) => item.data.effect)).toEqual(["write"])
    }))
})
