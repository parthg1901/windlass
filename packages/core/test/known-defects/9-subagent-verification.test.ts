/**
 * Known defect 9: a subagent's ending says no checks are configured in a
 * project that has checks.
 *
 * By design a child does not run the verification gate: `engine.ts`
 * `LiveSession.gate` sets `loaded = null` when `lineage.kind === "spawn"`,
 * and then `this.finish(run, { status: "not_configured" })`. So the child's
 * `execution.succeeded.verification` is `{ status: "not_configured" }`
 * whatever the project configures, and a client that shows it says "no
 * checks are configured". The parent's turn runs the checks once the
 * child's work is in (confirmed by the second test, which holds today).
 *
 * `not_configured` is documented (`event/durable.ts`, `verificationOutcome`)
 * as "verification is off, or no check is configured. Nothing was
 * verified." The child's case is a third thing: verification is on and
 * checks exist, and they are left to the parent's turn.
 *
 * RECOMMENDED (what the failing test asserts, loosely: only that the child's
 * value is no longer `not_configured`): a fifth variant of
 * `verificationOutcome`, e.g. `{ status: "by_parent" }`, written by `gate`
 * for a spawned session whose configuration has checks and verification
 * on (keeping `not_configured` when there are none). It is a schema change
 * of `execution.succeeded` and `turn.ended` (the variant is shared): the
 * reducer, the scenarios, the clients' endings (CLI renderer, TUI
 * transcript, ACP translate) and memory's outcome recording read it.
 * ALTERNATIVE: no schema change; clients read the session's lineage
 * (`kind: "spawn"`) next to `not_configured` and word it themselves. Cheaper,
 * but every client has to know the rule, and the log says something false
 * on its face.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { FakeWorkspace, Harness, converse, removeHarnessDirectories } from "../engine/harness.ts"

afterAll(removeHarnessDirectories)

const U = (inputTokens = 100) => script.usage({ inputTokens, cachedInputTokens: 40, outputTokens: 10, reasoningTokens: 0 })
const CHECKS: ConfigFile = { checks: [{ name: "test", command: "bun test" }] }
const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]

/** A parent that asks one subagent to edit a file, in a project with one check. */
async function delegated(run: (h: Harness, childId: SessionId) => void) {
  const workspace = new FakeWorkspace({ "a.ts": "1\n" })
  const h = new Harness({ spawn: {}, config: CHECKS, workspace })
  try {
    const scripted = converse(h.provider, {
      "Fix a": [[script.toolCall("call_1", "subagent", { task: "Fix module a" }), U()], [script.text("Fixed by the subagent."), U()]],
      "Fix module a": [[script.toolCall("call_1", "write", { path: "a.ts", content: "2\n" }), U(50)], [script.text("a.ts is fixed."), U(60)]],
    })
    h.tools.on("write", () => {
      workspace.files.set("a.ts", "2\n")
      return "written"
    })
    h.checks.on("test", "passed")
    h.create().send("Fix a.ts with a subagent.")
    await h.settled()
    expect(scripted.unused()).toBe(0)
    const childId = of(h.log(), "spawn.started")[0]!.data.work.sessionId as SessionId
    run(h, childId)
  } finally {
    await h.dispose()
  }
}

describe("known defect 9: a subagent's ending says no checks are configured", () => {
  test.failing("the child's ending says its work is left to the parent's checks, not that none are configured", () =>
    delegated((h, childId) => {
      const verification = of(h.store.readEvents(childId), "execution.succeeded")[0]!.data.verification
      expect(verification.status).not.toBe("not_configured")
    }))

  // Holds today: what happens by design. The child runs no checks; the parent's turn runs them once, after the child's work.
  test("today: the child says not_configured and runs no check; the parent's turn runs the check once and passes", () =>
    delegated((h, childId) => {
      const childLog = h.store.readEvents(childId)
      expect(of(childLog, "execution.succeeded")[0]!.data.verification).toEqual({ status: "not_configured" })
      expect(of(childLog, "checks.started")).toEqual([])
      expect(h.checks.ran).toEqual(["test"])
      const parent = h.log()
      expect(of(parent, "checks.started")[0]!.seq).toBeGreaterThan(of(parent, "spawn.ended")[0]!.seq)
      expect(of(parent, "execution.succeeded")[0]!.data.verification).toMatchObject({ status: "passed" })
    }))
})
