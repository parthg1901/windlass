/**
 * Known defect 2: `wake_cancel` and `memory_save` ask about a file.
 *
 * Observed: in the default mode `auto` they ask "Allow wake_cancel: writing
 * files? … The tool did not name a path that could be checked", and with
 * nobody present they are refused, while `wake_create` (an `exec` tool,
 * decided like a sandboxed command) runs. They change the harness's own
 * records (the wake store, the notes), not the workspace.
 *
 * The decision path: `engine.ts` `LiveSession.authorize` → `engine/approval.ts`
 * `callFacts` (the tool has no `touches`, so `paths` is `[]`) → `approval/decide.ts`
 * `decide` → `planCall` (effect `write`, mode not `full`) → `planWrite`:
 * `paths.length === 0` gives the need `{ kind: "write", path: null }`, which
 * no grant covers in `auto`; with nobody present `decide` returns `deny`
 * (`unattendedMessage`), and the engine writes `approval.denied` (`unattended`).
 *
 * RECOMMENDED (what these tests assert): a call that writes only the
 * harness's own records runs in `auto` and `full` without a question (it
 * cannot change the workspace or send anything out), and still asks in `ask`,
 * where every write asks. The smallest way there is a flag on the tool
 * (say `Tool.writes: "harness"`), passed through `callFacts` as a fact and
 * read by `planWrite`; the effect class stays `write`, so `effect_unknown`
 * after a crash and the snapshots around the step stay as they are.
 * ALTERNATIVES: a new effect class (changes the tool contract, the
 * `tool.started` schema, the reducer's `effect_unknown` rule and the taint
 * fold); or a path fact naming the harness's directory (the data directory
 * is a `hidden` place, and `planWrite` refuses writes to hidden paths
 * outright, so this would need a new place and would describe a store, not a
 * file the tool writes).
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, type HarnessOptions, removeHarnessDirectories } from "../engine/harness.ts"
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

describe("known defect 2: tools that write only the harness's own records ask about a file", () => {
  test.failing("auto, nobody present: wake_create runs, and so does the wake_cancel of the wake-up it made", () =>
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
      // The defect: wake_cancel is refused as unattended, asked about as a write without a checkable path.
      expect(of(h, "approval.denied")).toEqual([])
      expect(of(h, "tool.settled").map((item) => item.data.outcome)).toEqual(["success", "success"])
      expect(h.engine.wake()!.store.list({ sessionId: h.session.id })).toEqual([])
    }))

  test.failing("auto, nobody present: memory_save runs", () =>
    withHarness({ approval: approval(), memory: {}, userConfig: { memory: { enabled: true } } }, async (h) => {
      h.provider.enqueue([call("memory_save", { text: "The deploy script is scripts/deploy-all.sh.", kind: "fact", scope: "project" }), U], answer("Saved."))
      h.create().send("Remember where the deploy script is: scripts/deploy-all.sh.")
      await h.settled()
      expect(of(h, "approval.denied")).toEqual([])
      expect(of(h, "tool.settled")[0]?.data.outcome).toBe("success")
    }))

  // What the question says today, attended: the words of the report. Holds today; it documents the path, it is not the goal.
  test("today, attended: the question is about writing files, and says no path could be checked", () =>
    withHarness({ approval: approval(), wake: {}, attended: true }, async (h) => {
      h.provider.enqueue([call("wake_cancel", { id: "wk_000000000000", reason: "not needed" }), U], answer("Done."))
      h.create().send("Cancel it.")
      const asked = (await h.seen((item) => item.type === "approval.requested")) as StoredEvent<"approval.requested">
      expect(asked.data.needs).toEqual([{ kind: "write", path: null, root: null, protectedRoot: null }])
      expect(asked.data.question.title).toBe("Allow wake_cancel: writing files?")
      expect(asked.data.question.details).toContain("The tool did not name a path that could be checked.")
      h.session.interrupt()
      await h.settled()
    }))
})
