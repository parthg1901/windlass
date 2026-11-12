/**
 * Agents in the real `App`: the `/agent` picker, the switch in the transcript
 * and the panel, a call an agent refuses in the agent's words, and a problem
 * with a definition.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { type NewEvent, type SessionId, type StoredEvent, event } from "@windlass/core"
import { UNVERIFIED_HINT } from "../src/cli.ts"
import { Transcript } from "../src/transcript.ts"
import { AGENTS, REVIEWER, TASKS, type Task, c, call, flat, m, settle, started, step, succeeded, todo } from "./builders.ts"
import { CLOCK_START, type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})


async function open(width = 130, height = 44) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  return { backend, session: backend.session!, mounted }
}

async function enter(text: string) {
  await mounted!.setup.mockInput.typeText(text)
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
}

describe("agents", () => {
  test("/agent is a picker with what each agent may do and the definitions that could not be used; a name switches at once", async () => {
    const { session } = await open()
    const set: string[] = []
    session.agents = async () => AGENTS
    session.setConfig = async (id, value) => void set.push(`${id}=${value}`)
    await enter("/agent")
    const picker = flat(await mounted!.frame())
    expect(picker).toContain("Agent")
    expect(picker).toContain("no agent")
    expect(picker).toContain("reviewer")
    expect(picker).toContain("read only · Reviews a change without editing anything.")
    expect(picker).toContain("/work/.claude/agents/broken.md: not loaded: its front matter has no `description`")
    // What is said about each agent starts in one column, whatever the length of its name.
    const rows = (await mounted!.frame()).split("\n")
    const column = (text: string) => rows.find((row) => row.includes(text))!.indexOf(text)
    expect(column("restricted · Writes documentation only.")).toBe(column("the session's own instructions"))
    expect(column("read only · Reviews a change")).toBe(column("the session's own instructions"))
    expect(rows.find((row) => row.includes("read only · Reviews a change"))).toMatch(/reviewer {2,}read only/)
    // Down to the first agent, Enter: the switch is asked of the server; what happened comes back as its event.
    mounted!.setup.mockInput.pressArrow("down")
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    expect(set).toEqual(["agent=docs"])
    await enter("/agent reviewer")
    expect(set).toEqual(["agent=docs", "agent=reviewer"])
    // The one in force is not switched to again.
    session.agents = async () => ({ ...AGENTS, current: "reviewer" })
    await enter("/agent reviewer")
    expect(set).toHaveLength(2)
    expect(flat(await mounted!.frame())).toContain("this session runs as the reviewer agent already")
  })

  test("the switch is a row with what the agent may do, the panel names the agent, and a call it refuses is the agent's refusal", async () => {
    const { session } = await open()
    session.emit(
      event("agent.switched", { messageId: null, from: null, to: REVIEWER }),
      started(),
      event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }),
      call("a1", "c1", "write", { path: "note.txt", content: "x" }),
      event("approval.denied", { messageId: m("a1"), callId: c("c1"), mode: "auto", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }),
      settle("a1", "c1", "error", 'Not run: you are working as the agent "reviewer", which may use only tools that read. "write" changes files. Carry on without it.'),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("⇄ working as the agent reviewer (read only)")
    expect(frame).toContain("Only tools that read (effects: read).")
    expect(frame).toContain("agent reviewer")
    expect(frame).toContain("⊘ write note.txt · refused by the reviewer agent")
    expect(frame).toContain('The agent "reviewer" may use only tools that read. "write" changes files.')
    expect(frame).not.toContain("approval policy")
    expect(frame).not.toContain("you are working as")
    session.emit(event("agent.switched", { messageId: m("i1"), from: "reviewer", to: null }))
    await mounted!.settle()
    const after = flat(await mounted!.frame())
    expect(after).toContain("⇄ no agent: the instructions and restrictions of reviewer no longer apply")
    expect(mounted!.app.transcript.session.agent).toBeNull()
  })

  test("a problem with a definition, as the engine reports it, is a row", async () => {
    const { session } = await open()
    session.emit({ type: "diagnostic", sessionId: session.id as SessionId, kind: "agents", message: "The agent definition at /work/.claude/agents/broken.md was not loaded: its front matter has no `description`" })
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("agents: The agent definition at /work/.claude/agents/broken.md was not loaded")
  })
})
