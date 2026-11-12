/**
 * The ending of a turn in which a stop hook sent the model back after the checks had passed.
 *
 * The gate verifies a turn's own work: a turn that changed no file runs no check, and when files the checks
 * cover differ from the verified state its ending says that they changed outside the turn (`not_needed` with
 * `unverified`). A turn whose checks already ran is not such a turn. The model, sent back by a stop hook after
 * they passed, changes files again; when that puts the workspace back as it was when the turn began, the turn
 * as a whole changed nothing, and yet what was checked is not what is there now, and the change was made in
 * this turn. The checks run again for what changed since they passed, and the ending records that run.
 */
import { afterAll, expect, test } from "bun:test"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { FakeWorkspace, Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const call = (name: string, input: Json, callId = "call_1") => [script.toolCall(callId, name, input)]
const say = (value: string) => [script.text(value)]
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

/** A session with one check and one stop hook that objects the first time it is asked. */
function project() {
  let asked = 0
  const scripted = scriptedRunner({ review: () => (asked++ === 0 ? exited(2, "Take the change back.\n") : exited(0, "")) })
  const h = new Harness({
    workspace: new FakeWorkspace({ "a.ts": "1\n", "notes.md": "notes\n" }),
    config: { checks: [{ name: "test", command: "bun test" }] },
    userConfig: { hooks: { stop: [{ name: "review", command: "review" }] } },
    hooks: { runner: scripted.runner },
  })
  const writes = (input: Record<string, unknown>) => {
    h.workspace!.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}`
  }
  h.tools.on("write", writes, writes)
  return h
}

test("files changed after the checks passed, because a stop hook sent the model back, should be checked again, also when the change puts them back as the turn found them", async () => {
  const h = project()
  try {
    h.checks.on("test", "passed", "passed")
    // The model changes a file, the checks pass, the hook objects, and the model takes its change back.
    h.provider.enqueue(call("write", { path: "a.ts", content: "2\n" }), say("Done."), call("write", { path: "a.ts", content: "1\n" }), say("Taken back."))
    h.create().send("Change it.")
    await h.settled()

    expect(of(h, "synthetic.appended").filter((item) => item.data.origin === "stop_hook")).toHaveLength(1)
    // What changed since the first run is checked: the run is on record, and the ending rests on it.
    expect(of(h, "checks.started").map((item) => item.data.run)).toEqual([1, 2])
    const ending = of(h, "execution.succeeded")[0]!.data.verification
    expect(ending).toMatchObject({ status: "passed", evidence: { run: 2, changedFiles: ["a.ts"] } })
    // The verified state is the workspace as it is now, so the next turn that changes nothing has nothing unverified.
    h.provider.enqueue(say("Nothing to do."))
    h.session.send("Anything else?")
    await h.settled()
    expect(of(h, "execution.succeeded")[1]!.data.verification).toEqual({ status: "not_needed" })
    expect(h.checks.unused).toBe(0)
  } finally {
    await h.dispose()
  }
})

test("when nothing changed after the checks passed, their run stands and is not made again", async () => {
  const h = project()
  try {
    h.checks.on("test", "passed")
    // Sent back by the hook, the model only answers.
    h.provider.enqueue(call("write", { path: "a.ts", content: "2\n" }), say("Done."), say("It is right as it is."))
    h.create().send("Change it.")
    await h.settled()
    expect(of(h, "checks.started")).toHaveLength(1)
    expect(of(h, "execution.succeeded")[0]!.data.verification).toMatchObject({ status: "passed", evidence: { run: 1 } })
  } finally {
    await h.dispose()
  }
})
