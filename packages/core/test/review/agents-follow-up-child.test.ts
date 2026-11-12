/**
 * Review finding: a session that was switched to a restricted agent can still have the forbidden work done by
 * a subagent it started before the switch, by sending that subagent a follow-up.
 *
 * What is promised.
 * - docs/agents.md, "A subagent run as an agent": "**A restricted session cannot get around its restrictions
 *   through a child.** A subagent started without `agent` by a session that runs as an agent runs as that agent.
 *   One started as another agent gets both sets of restrictions".
 * - docs/agents.md, "What restrictions do": "Use `disallowed-tools: write, edit` for an agent that plans and
 *   delegates."
 *
 * What happens. Restrictions are combined into a child only when the child is created. A follow-up (`subagent`
 * with `session`) reopens the earlier child as it is: `followUp` records `spawn.started` and runs the child
 * without looking at the agent the parent runs as now. So: the session works without an agent and starts a
 * subagent; the user switches the session to an agent that may not use `write`; the model sends the old child
 * a follow-up asking it to write; the child, which has no agent, writes. The parent's own `write` is refused.
 *
 * Code path. `LiveSession.followUp` and `runChild` in packages/core/src/engine/engine.ts (no use of
 * `projection.session.agent`); compare `subagent` in the same file, which calls `childAgent(...)` for a new child.
 *
 * Smallest fix. In `followUp`, before `spawn.started`: when the parent runs as an agent whose restrictions the
 * child's record does not already include (`combineRestrictions(parent, child)` differs from the child's), refuse
 * the follow-up with a sentence for the model ("this subagent was started before you were switched to the agent
 * ...; start a new subagent"). Refusing is smaller than switching the child, which "keeps the agent it started as".
 *
 * What that fix could affect. A session that is switched to a stricter agent loses the conversations of its
 * earlier subagents for follow-ups (it can start new ones, which inherit the agent). A background child that is
 * still running when the user switches is not covered by that check and keeps working as it was started.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, converse, removeHarnessDirectories } from "../engine/harness.ts"
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

test.failing("a session switched to an agent that may not write should not get a file written through a follow-up to an earlier subagent", async () => {
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
    // And it must hold through the child: no file is written by anyone on this session's behalf.
    expect(h.tools.ran).toEqual([])
  } finally {
    await h.dispose()
  }
})
