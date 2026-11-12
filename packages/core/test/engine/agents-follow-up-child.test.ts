/**
 * A session that was switched to a restricted agent cannot have the forbidden work done by a subagent it started
 * before the switch.
 *
 * docs/agents.md, "A subagent run as an agent": "A restricted session cannot get around its restrictions through
 * a child." A new subagent is given the session's restrictions when it is created. An earlier one keeps the agent
 * it started as, so a follow-up (`subagent` with `session`) to a child that is not held to everything the session
 * is held to now is refused, with a sentence that tells the model to start a new subagent. A child that was
 * started under the same agent, or under a stricter one, still takes follow-ups.
 *
 * A background child that is still running when the user switches is stopped where the switch is made:
 * agents-switch-running-child.test.ts.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { NO_RESTRICTIONS } from "../../src/agents/definition.ts"
import { heldToParent } from "../../src/engine/agents.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
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

// The agent docs/agents.md recommends for a session that plans and delegates.
const PLANNER = "---\nname: planner\ndescription: Plans and delegates, and never edits a file.\ndisallowed-tools: write, edit\n---\nPlan the work.\n"

test("a session switched to an agent that may not write should not get a file written through a follow-up to an earlier subagent", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-agents-follow-up-")))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  mkdirSync(join(cwd, `.${brand.directory}`, "agents"), { recursive: true })
  writeFileSync(join(cwd, `.${brand.directory}`, "agents", "planner.md"), PLANNER)
  const h = new Harness({ agents: { configDir: join(root, "config") }, cwd, spawn: {} })
  try {
    converse(h.provider, {
      // The parent: a subagent while it has no agent; after the switch, a write of its own and a follow-up to that subagent.
      "Delegate": [
        [call("subagent", { task: "Look at a" }), U],
        answer("Started."),
        [call("write", { path: "a.ts", content: "by the parent" }), U],
        [call("subagent", { task: "Now write a.ts", session: "ses_2" }), U],
        answer("Done."),
      ],
      // The child: its first task, then the follow-up.
      "Look at a": [answer("Looked."), [call("write", { path: "a.ts", content: "by the child" }), U], answer("Wrote a.ts.")],
    })
    h.tools.on("write", "Wrote a.ts")
    h.create().send("Delegate.")
    await h.settled()
    expect(h.session.projection().session.spawned!.children).toEqual(["ses_2"] as never)

    h.session.setAgent("planner")
    h.session.send("Have a.ts written.")
    await h.settled()

    // The restriction is in force for the session itself: its own write is refused by the agent.
    expect(h.session.projection().session.agent?.name).toBe("planner")
    const refused = h.log().filter((item): item is StoredEvent<"approval.denied"> => item.type === "approval.denied")
    expect(refused.map((item) => [item.data.agent, item.data.refusal?.rule])).toEqual([["planner", "denied_tool"]])
    // And it holds through the child: no file is written by anyone on this session's behalf.
    expect(h.tools.ran).toEqual([])
    // The follow-up was refused with what to do instead, and the child was not started again.
    const followUp = h.log().filter((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled").at(-1)!
    expect(followUp.data).toMatchObject({ outcome: "error" })
    expect(followUp.data.output).toBe(
      'The follow-up was not sent: subagent ses_2 was started before this session ran as the agent "planner", so it is not under that agent\'s restrictions. Start a new subagent for the work (call subagent without `session`): it runs under them.',
    )
    expect(h.log().filter((item) => item.type === "spawn.started")).toHaveLength(1)
  } finally {
    await h.dispose()
  }
})

test("a follow-up reaches a subagent that is held to what its parent is held to, whichever of them is stricter", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-agents-follow-up-kept-")))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  mkdirSync(join(cwd, `.${brand.directory}`, "agents"), { recursive: true })
  writeFileSync(join(cwd, `.${brand.directory}`, "agents", "planner.md"), PLANNER)
  const h = new Harness({ agents: { configDir: join(root, "config") }, cwd, spawn: {} })
  try {
    converse(h.provider, {
      // The session runs as the planner from the start, so its subagent does too, and a follow-up reaches it.
      "Delegate": [[call("subagent", { task: "Look at a" }), U], answer("Started."), [call("subagent", { task: "Look again", session: "ses_2" }), U], answer("Done.")],
      "Look at a": [answer("Looked."), answer("Looked again.")],
    })
    h.create(undefined, "planner").send("Delegate.")
    await h.settled()
    h.session.send("Have it look again.")
    await h.settled()
    expect(h.log().filter((item) => item.type === "spawn.started")).toHaveLength(2)
    expect(h.log().filter((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled").map((item) => item.data.outcome)).toEqual(["success", "success"])
  } finally {
    await h.dispose()
  }

  const planner = { ...NO_RESTRICTIONS, deniedTools: ["write", "edit"] }
  // A parent that restricts nothing holds any child; a restricted one holds a child with the same or more.
  expect(heldToParent(NO_RESTRICTIONS, NO_RESTRICTIONS)).toBe(true)
  expect(heldToParent(NO_RESTRICTIONS, planner)).toBe(true)
  expect(heldToParent(planner, planner)).toBe(true)
  expect(heldToParent(planner, { ...planner, deniedTools: ["Edit", "shell", "WRITE"], approval: "ask" })).toBe(true)
  // A child that lacks one of them is not held.
  expect(heldToParent(planner, NO_RESTRICTIONS)).toBe(false)
  expect(heldToParent(planner, { ...NO_RESTRICTIONS, deniedTools: ["write"] })).toBe(false)
  expect(heldToParent({ ...NO_RESTRICTIONS, effects: ["read"] }, { ...NO_RESTRICTIONS, effects: ["read", "write"] })).toBe(false)
  expect(heldToParent({ ...NO_RESTRICTIONS, tools: ["read"] }, NO_RESTRICTIONS)).toBe(false)
  expect(heldToParent({ ...NO_RESTRICTIONS, approval: "ask" }, { ...NO_RESTRICTIONS, approval: "auto" })).toBe(false)
})
