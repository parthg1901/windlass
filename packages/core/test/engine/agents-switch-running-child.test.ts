/**
 * A background subagent that is at work when the user switches the session to a stricter agent does not go on
 * unrestricted.
 *
 * docs/agents.md, "A subagent run as an agent": "A restricted session cannot get around its restrictions through
 * a child." A subagent keeps the agent it started as, so one started before the switch is not under the new
 * agent's restrictions. Where the switch is made (`agent.switched`), every subagent at work that is not held to
 * everything the session is now held to (`heldToParent`) is stopped as by its user: `spawn.ended` says `stopped`
 * with the reason, the user is told (a diagnostic), and the model is told with the message that carries the
 * subagent's end, which says to start a new one. A subagent that is held to the new restrictions goes on.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { HARNESS_ORIGIN, type StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, converse, removeHarnessDirectories } from "./harness.ts"
import { measured } from "../scenarios/script.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]

const PLANNER = "---\nname: planner\ndescription: Plans and delegates, and never edits a file.\ndisallowed-tools: write, edit\n---\nPlan the work.\n"

function project(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  mkdirSync(join(cwd, `.${brand.directory}`, "agents"), { recursive: true })
  writeFileSync(join(cwd, `.${brand.directory}`, "agents", "planner.md"), PLANNER)
  return { cwd, configDir: join(root, "config") }
}

/** A read that does not return until the test lets it: the subagent is at work for as long. */
function heldRead() {
  let release: () => void = () => {}
  let begin: () => void = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  const begun = new Promise<void>((resolve) => (begin = resolve))
  return {
    begun,
    release,
    run: async () => {
      begin()
      await released
      return "contents of a.ts"
    },
  }
}

const settledOf = (log: readonly StoredEvent[]) => log.filter((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled")
const ends = (log: readonly StoredEvent[]) => log.filter((item): item is StoredEvent<"spawn.ended"> => item.type === "spawn.ended")

test("a background subagent that is at work when the session is switched to a stricter agent should be stopped, and the user and the model told", async () => {
  const files = project("agents-switch-running-")
  const h = new Harness({ agents: { configDir: files.configDir }, cwd: files.cwd, spawn: {} })
  try {
    const read = heldRead()
    converse(h.provider, {
      // The parent, with no agent: a subagent in the background. It has nothing more to do, so its turn waits for
      // the subagent; told that the subagent was stopped, it answers.
      "Delegate": [[call("subagent", { task: "Rewrite a", background: true }), U], answer("Started; waiting."), answer("The subagent was stopped.")],
      // The child: a read, then the write the planner may not make.
      "Rewrite a": [[call("read", { path: "a.ts" }), U], [call("write", { path: "a.ts", content: "by the child" }, "call_2"), U], answer("Wrote a.ts.")],
    })
    h.tools.on("read", read.run)
    h.tools.on("write", "Wrote a.ts")
    h.create().send("Delegate.")
    await read.begun

    // The user switches while the subagent is at work and the parent's turn waits for it.
    h.session.setAgent("planner")
    await h.settled()
    read.release()

    const log = h.log()
    expect(h.session.projection().session.agent?.name).toBe("planner")
    // The subagent was stopped, on record, with the reason; it wrote nothing.
    expect(ends(log)).toHaveLength(1)
    expect(ends(log)[0]!.data).toMatchObject({ outcome: "stopped" })
    expect(ends(log)[0]!.data.detail).toBe(
      'It was stopped before it finished: this session now runs as the agent "planner", and the subagent was started before that, so it is not under that agent\'s restrictions. Start a new subagent for what is left (call subagent without `session`): it runs under them.',
    )
    expect(ends(log)[0]!.seq).toBeGreaterThan(log.find((item) => item.type === "agent.switched")!.seq)
    expect(h.tools.ran.map((ran) => ran.name)).not.toContain("write")
    // The model is told with the message that carries the subagent's end, in the same turn.
    const told = log.filter((item): item is StoredEvent<"inbox.enqueued"> => item.type === "inbox.enqueued" && item.data.origin === HARNESS_ORIGIN.subagentResult)
    expect(told).toHaveLength(1)
    expect(JSON.stringify(told[0]!.data.content)).toContain("Start a new subagent for what is left")
    expect(log.filter((item) => item.type === "execution.started")).toHaveLength(1)
    expect(log.at(-1)?.type).toBe("execution.succeeded")
    // The user is told once.
    expect(h.diagnostics.filter((diagnostic) => diagnostic.kind === "agents" && diagnostic.message.includes("was stopped")).map((diagnostic) => diagnostic.message)).toEqual([
      'Subagent ses_2 was stopped: it was started before this session ran as the agent "planner", so it is not under that agent\'s restrictions. What it had done so far stays, and so does its conversation.',
    ])
  } finally {
    await h.dispose()
  }
})

test("a background subagent that is held to the new agent's restrictions goes on when the session is switched", async () => {
  const files = project("agents-switch-running-kept-")
  const h = new Harness({ agents: { configDir: files.configDir }, cwd: files.cwd, spawn: {} })
  try {
    const read = heldRead()
    converse(h.provider, {
      "Delegate": [[call("subagent", { task: "Look at a", background: true }), U], answer("Started; waiting."), answer("It looked.")],
      "Look at a": [[call("read", { path: "a.ts" }), U], answer("Looked at a.ts.")],
    })
    h.tools.on("read", read.run)
    // The session runs as the planner from the start, so its subagent does too. Switching to the same agent
    // again, or to none, holds the subagent to nothing it is not held to already.
    h.create(undefined, "planner").send("Delegate.")
    await read.begun
    h.session.setAgent("none")
    h.session.setAgent("planner")
    read.release()
    await h.settled()
    const log = h.log()
    expect(ends(log).map((item) => item.data.outcome)).toEqual(["completed"])
    expect(settledOf(log).map((item) => item.data.outcome)).toEqual(["success"])
    expect(h.diagnostics.filter((diagnostic) => diagnostic.message.includes("was stopped"))).toEqual([])
  } finally {
    await h.dispose()
  }
})
