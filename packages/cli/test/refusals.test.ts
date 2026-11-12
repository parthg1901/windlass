/**
 * How the line CLI draws a call somebody did not let run, a subagent, and a
 * repeated instruction update: a hook's refusal and an agent's are both
 * "refused", with who refused; a subagent's row names the agent it runs as;
 * an instruction update that is the same again is said once.
 */
import { expect, test } from "bun:test"
import { type EventData, type SessionId, event } from "@windlass/core"
import { c, executionStarted, m, opening, stepEnded, stepStarted } from "@windlass/core/testing/scenarios"
import { agentRefused } from "../src/agents.ts"
import { hookRefusal } from "../src/hooks.ts"
import { render, stored } from "./helpers.ts"
import { REVIEWER, call, settle } from "./typed.ts"

const ran = (fields: Partial<EventData<"hook.ran">>): EventData<"hook.ran"> => ({ point: "beforeTool", name: "no-push", origin: "user", fingerprint: "f".repeat(64), messageId: m("a1"), callId: c("c1"), round: null, answer: "no", failure: null, detail: null, exitCode: 2, durationMs: 12, toModel: "Pushing is not allowed here.", forUser: "", ...fields }) as EventData<"hook.ran">

test("a hook's refusal and an agent's refusal are both drawn as refused, with who refused; neither is a failure", () => {
  // The rule is the engine's own sentence (`refusal.text`), whatever the tool is called: nothing is guessed from its name.
  expect(agentRefused("docs", { text: 'The agent "docs" may use only these tools: read, write. "deploy_site" is not one of them.' })).toEqual({ head: "refused by the docs agent", reason: 'The agent "docs" may use only these tools: read, write. "deploy_site" is not one of them.' })
  expect(hookRefusal([ran({})], false, "")).toEqual({ head: 'refused by the hook "no-push"', reason: "Pushing is not allowed here." })
  const out = render(
    stored([
      ...opening("Push, then write a note."),
      event("agent.switched", { messageId: null, from: null, to: REVIEWER }),
      stepStarted("a1"),
      call("a1", "c1", "shell", { command: "git push" }),
      event("hook.ran", ran({})),
      settle("a1", "c1", "error", 'This call was not run: the hook "no-push" refused it.\nPushing is not allowed here.'),
      call("a1", "c2", "write", { path: "note.txt", content: "x" }),
      event("approval.denied", { messageId: m("a1"), callId: c("c2"), mode: "auto", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }),
      settle("a1", "c2", "error", 'Not run: you are working as the agent "reviewer", which may use only tools that read.'),
      stepEnded("a1", "tool_calls"),
    ]),
    { columns: () => 120 },
  )
  expect(out).toContain('▸ shell git push\n  ⊘ refused by the hook "no-push"\n    Pushing is not allowed here.\n')
  expect(out).toContain('▸ write note.txt\n  ⊘ refused by the reviewer agent\n    The agent "reviewer" may use only tools that read. "write" changes files.\n')
  expect(out).not.toContain("✗")
  expect(out).not.toContain("○ not run")
})

test("a subagent's line names the agent it runs as, and a call of its own that was refused says by whom", () => {
  const child = (inner: ReturnType<typeof event>, seq: number) => ({ type: "child.event" as const, sessionId: "ses_test" as SessionId, child: "ses_child000000000000000000" as SessionId, spawnId: "sp_1", title: "Review the change", event: { ...inner, sessionId: "ses_child000000000000000000" as SessionId, seq, time: seq * 100 } })
  const out = render(
    [
      ...stored([
        ...opening("Have the reviewer look."),
        stepStarted("a1"),
        call("a1", "c1", "subagent", { task: "Review the change", agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }),
        event("spawn.started", { spawnId: "sp_1", messageId: m("a1"), callId: c("c1"), background: false, work: { kind: "subagent", sessionId: "ses_child000000000000000000" as SessionId, worktree: null, agent: "reviewer" } }),
      ]),
      child(call("b1", "k1", "write", { path: "note.txt", content: "x" }), 5),
      child(event("approval.denied", { messageId: m("b1"), callId: c("k1"), mode: "auto", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }), 6),
      child(settle("b1", "k1", "error", "Not run."), 7),
      child(call("b1", "k2", "shell", { command: "git push" }), 8),
      child(event("hook.ran", ran({ messageId: m("b1"), callId: c("k2") })), 9),
      child(settle("b1", "k2", "error", 'This call was not run: the hook "no-push" refused it.'), 10),
    ] as never,
    { columns: () => 120 },
  )
  expect(out).toMatch(/▸ subagent \w+ started as the agent reviewer\n/)
  expect(out).toMatch(/↳ subagent \w+ ⊘ write note\.txt · refused by the reviewer agent\n +The agent "reviewer" may use only tools that read\. "write" changes files\.\n/)
  expect(out).toMatch(/↳ subagent \w+ ⊘ shell git push · refused by the hook "no-push"\n/)
  expect(out).not.toContain("✗")
})

test("an instruction update that is the same again (after every compaction) is said once; a changed one is said again", () => {
  const index = (fingerprint: string | null, text = "2 agents: reviewer, docs") => event("instruction.appended", { messageId: m(`n${Math.random()}`), source: "agent-index", text, fingerprint })
  const out = render(stored([...opening("hello"), executionStarted(), index("aaa"), index("aaa"), index("aaa"), index("bbb", "3 agents: reviewer, docs, tester"), index("bbb", "3 agents: reviewer, docs, tester"), index(null), index(null), index("aaa")]), { columns: () => 120 })
  expect(out.match(/· instructions updated \(agent-index\)/g)).toHaveLength(3)
  expect(out.match(/· instructions removed: agent-index/g)).toHaveLength(1)
  expect(out).toContain("· instructions updated (agent-index): 3 agents: reviewer, docs, tester\n")
})
