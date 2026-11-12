/**
 * In the real `App`: a call a hook refused and a call the agent refused are
 * both drawn as refused, with who refused; a subagent's row names the agent
 * it runs as; an instruction update that is the same again is one row.
 */
import { afterEach, expect, test } from "bun:test"
import { type EventData, type SessionId, event } from "@windlass/core"
import { REVIEWER, c, call, flat, m, settle, started } from "./builders.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function open() {
  const backend = new ScriptBackend()
  mounted = await mount({ width: 170, height: 44, backend })
  return backend.session!
}

const ran = (fields: Partial<EventData<"hook.ran">> = {}): EventData<"hook.ran"> => ({ point: "beforeTool", name: "no-push", origin: "user", fingerprint: "f".repeat(64), messageId: m("a1"), callId: c("c1"), round: null, answer: "no", failure: null, detail: null, exitCode: 2, durationMs: 12, toModel: "Pushing is not allowed here.", forUser: "", ...fields }) as EventData<"hook.ran">

test("a hook's refusal and an agent's refusal are both drawn as refused, with who refused", async () => {
  const session = await open()
  session.emit(
    event("agent.switched", { messageId: null, from: null, to: REVIEWER }),
    started(),
    event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }),
    call("a1", "c1", "shell", { command: "git push" }),
    event("hook.ran", ran()),
    settle("a1", "c1", "error", 'This call was not run: the hook "no-push" refused it.\nPushing is not allowed here.'),
    call("a1", "c2", "write", { path: "note.txt", content: "x" }),
    event("approval.denied", { messageId: m("a1"), callId: c("c2"), mode: "auto", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }),
    settle("a1", "c2", "error", 'Not run: you are working as the agent "reviewer", which may use only tools that read.'),
  )
  await mounted!.settle()
  const frame = flat(await mounted!.frame())
  expect(frame).toContain('⊘ shell git push · refused by the hook "no-push"')
  expect(frame).toContain("Pushing is not allowed here.")
  expect(frame).toContain("⊘ write note.txt · refused by the reviewer agent")
  expect(frame).toContain('The agent "reviewer" may use only tools that read. "write" changes files.')
  expect(frame).not.toContain("✗")
})

test("a subagent's row names the agent it runs as", async () => {
  const session = await open()
  session.emit(
    started(),
    event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }),
    call("a1", "c1", "subagent", { task: "Review the change", agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }),
    event("spawn.started", { spawnId: "sp_1", messageId: m("a1"), callId: c("c1"), background: false, work: { kind: "subagent", sessionId: "ses_child000000000000000000" as SessionId, worktree: null, agent: "reviewer" } }),
    call("a1", "c2", "subagent", { task: "Count the files" }),
    event("spawn.started", { spawnId: "sp_2", messageId: m("a1"), callId: c("c2"), background: false, work: { kind: "subagent", sessionId: "ses_child000000000000000001" as SessionId, worktree: null } }),
  )
  await mounted!.settle()
  const frame = flat(await mounted!.frame())
  expect(frame).toContain("subagent (reviewer) Review the change")
  expect(frame).toContain("subagent Count the files")
})

test("an instruction update that is the same again is one row; a changed one is another", async () => {
  const session = await open()
  const index = (id: string, fingerprint: string, text = "2 agents: reviewer, docs") => event("instruction.appended", { messageId: m(id), source: "agent-index", text, fingerprint })
  session.emit(started(), index("n1", "aaa"), index("n2", "aaa"), index("n3", "aaa"), index("n4", "aaa"), index("n5", "aaa"), index("n6", "bbb", "3 agents: reviewer, docs, tester"))
  await mounted!.settle()
  const frame = flat(await mounted!.frame())
  expect(frame.match(/instructions updated \(agent-index\)/g)).toHaveLength(2)
  expect(frame).toContain("instructions updated (agent-index): 3 agents: reviewer, docs, tester")
})
