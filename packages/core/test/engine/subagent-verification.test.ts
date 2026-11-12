/**
 * A subagent's ending says who verifies it.
 *
 * By design a child does not run the verification gate (`engine.ts`
 * `LiveSession.gate`): several children each running the project's whole
 * check suite in one workspace would mostly report each other's half-done
 * work, and the parent's turn runs the checks once the child's work is in.
 * So the child's `execution.succeeded` (and a `turn.ended` of its own)
 * carries the verification status `left_to_parent`, whatever the project
 * configures: not `not_configured`, which would say on its face that the
 * project has no checks. The reducer accepts that status from a subagent
 * and from nobody else, and no other status from a subagent.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { FakeWorkspace, Harness, converse, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = (inputTokens = 100) => script.usage({ inputTokens, cachedInputTokens: 40, outputTokens: 10, reasoningTokens: 0 })
const CHECKS: ConfigFile = { checks: [{ name: "test", command: "bun test" }] }
const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]

/** A parent that asks one subagent to edit a file, in a project with one check. */
async function delegated(run: (h: Harness, childId: SessionId) => void, config: ConfigFile = CHECKS) {
  const workspace = new FakeWorkspace({ "a.ts": "1\n" })
  const h = new Harness({ spawn: {}, config, workspace })
  try {
    const scripted = converse(h.provider, {
      "Fix a": [[script.toolCall("call_1", "subagent", { task: "Fix module a" }), U()], [script.text("Fixed by the subagent."), U()]],
      "Fix module a": [[script.toolCall("call_1", "write", { path: "a.ts", content: "2\n" }), U(50)], [script.text("a.ts is fixed."), U(60)]],
    })
    h.tools.on("write", () => {
      workspace.files.set("a.ts", "2\n")
      return "written"
    })
    if (config.checks !== undefined) h.checks.on("test", "passed")
    h.create().send("Fix a.ts with a subagent.")
    await h.settled()
    expect(scripted.unused()).toBe(0)
    const work = of(h.log(), "spawn.started")[0]!.data.work
    if (work.kind !== "subagent") throw new Error("the parent started no subagent")
    const childId = work.sessionId
    run(h, childId)
  } finally {
    await h.dispose()
  }
}

describe("a subagent's ending", () => {
  test("the child's ending says its work is left to the parent's checks, not that none are configured", () =>
    delegated((h, childId) => {
      const verification = of(h.store.readEvents(childId), "execution.succeeded")[0]!.data.verification
      expect(verification).toEqual({ status: "left_to_parent" })
    }))

  test("the child runs no check; the parent's turn runs the check once, after the child's work, and passes", () =>
    delegated((h, childId) => {
      const childLog = h.store.readEvents(childId)
      expect(of(childLog, "execution.succeeded")[0]!.data.verification).toEqual({ status: "left_to_parent" })
      expect(of(childLog, "checks.started")).toEqual([])
      expect(h.checks.ran).toEqual(["test"])
      const parent = h.log()
      expect(of(parent, "checks.started")[0]!.seq).toBeGreaterThan(of(parent, "spawn.ended")[0]!.seq)
      expect(of(parent, "execution.succeeded")[0]!.data.verification).toMatchObject({ status: "passed" })
    }))

  test("in a project without checks the child still says left_to_parent, and the parent says that none are configured", () =>
    delegated((h, childId) => {
      expect(of(h.store.readEvents(childId), "execution.succeeded")[0]!.data.verification).toEqual({ status: "left_to_parent" })
      expect(of(h.log(), "execution.succeeded")[0]!.data.verification).toEqual({ status: "not_configured" })
      expect(h.checks.ran).toEqual([])
    }, {}))
})
