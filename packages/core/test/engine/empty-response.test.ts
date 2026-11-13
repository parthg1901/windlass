/**
 * An empty answer after the work does not end the turn as failed.
 *
 * The first empty response of a turn gets one nudge (`closeStep` in
 * `engine.ts`, retry rule 8). When the answer to the nudge is empty too:
 * - a turn that has work in it (a call of the turn has its result,
 *   `workedThisTurn` in `engine/state.ts`) ends as any turn ends, through
 *   the verification gate, as `execution.succeeded`; the model had nothing
 *   to add. The user is told by a `notice` of kind `no_closing_answer`;
 * - a turn with no work at all fails with "The model returned an empty
 *   response twice." (scenario "An empty response: one nudge, then failure").
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { StoredEvent } from "../../src/event/durable.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ConfigFile } from "../../src/config/schema.ts"
import { FakeWorkspace, Harness, removeHarnessDirectories } from "./harness.ts"
import { measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const empty = [U]
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

describe("two empty answers in a row", () => {
  test("tool call, success, empty, nudge, empty: the turn ends as done, and the user is told there is no closing answer", async () => {
    const h = new Harness()
    try {
      h.tools.on("write", "Wrote notes.md (1 line).")
      h.provider.enqueue([script.toolCall("call_1", "write", { path: "notes.md", content: "x\n" }), U], empty, empty)
      const notices: string[] = []
      h.create()
      h.session.subscribe((item) => {
        if (item.type === "notice") notices.push(`${item.kind}: ${item.message}`)
      })
      h.session.send("Write notes.md.")
      await h.settled()
      expect(of(h, "tool.settled").map((item) => item.data.outcome)).toEqual(["success"])
      // One nudge was written.
      expect(of(h, "synthetic.appended").filter((item) => item.data.origin === "empty_response")).toHaveLength(1)
      expect(h.log().at(-1)?.type).toBe("execution.succeeded")
      expect(of(h, "execution.failed")).toEqual([])
      expect(notices).toEqual(["no_closing_answer: The model returned an empty response twice after its work, so the turn ended without a closing answer. What it did is shown above; ask it to sum up if you need that."])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("the turn ends through the gate: the project's checks run on what it changed", async () => {
    const workspace = new FakeWorkspace({ "notes.md": "old\n" })
    const config: ConfigFile = { checks: [{ name: "test", command: "bun test" }] }
    const h = new Harness({ config, workspace })
    try {
      h.tools.on("write", () => {
        workspace.files.set("notes.md", "x\n")
        return "Wrote notes.md (1 line)."
      })
      h.checks.on("test", "passed")
      h.provider.enqueue([script.toolCall("call_1", "write", { path: "notes.md", content: "x\n" }), U], empty, empty)
      h.create().send("Write notes.md.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test"])
      expect(of(h, "execution.succeeded")[0]?.data.verification).toMatchObject({ status: "passed" })
    } finally {
      await h.dispose()
    }
  })

  test("a call that never began is no work: two empty answers after it fail the turn", async () => {
    // A write outside the workspace asks, and a question waits for the response to be over. The response is cut at
    // the output limit, so the call never starts: it is settled as not started and the model is told.
    const sandbox = { state: { available: true }, temp: (id: string) => ({ dir: `/sandbox-tmp/${id}`, alias: "/tmp" }), plan: () => { throw new Error("unused") }, policy: () => { throw new Error("unused") } }
    const h = new Harness({ approval: { sandbox: sandbox as never, secrets: [], home: "/home/user" }, attended: true })
    try {
      h.provider.enqueue([script.toolCall("call_1", "write", { path: "/etc/motd", content: "x\n" }), U, script.finish("length")], empty, empty)
      h.create().send("Write /etc/motd.")
      await h.settled()
      expect(of(h, "tool.settled").map((item) => item.data.outcome)).toEqual(["not_started"])
      expect(of(h, "approval.requested")).toEqual([])
      expect(h.log().at(-1)).toMatchObject({ type: "execution.failed", data: { message: "The model returned an empty response twice." } })
    } finally {
      await h.dispose()
    }
  })

  // With no work in the turn, two empty answers fail it.
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
