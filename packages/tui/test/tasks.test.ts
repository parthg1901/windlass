/**
 * The model's task list in the real `App`: a `todo` call is a checklist that
 * stays in the panel, and is there again for a session opened again.
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

describe("the task list", () => {
  test("a todo call is a checklist in the conversation and stays in the panel; a cleared list leaves it", async () => {
    const { session } = await open()
    session.emit(started(), event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }), call("a1", "c1", "todo", { todos: TASKS }), settle("a1", "c1", "success", "Task list updated.", todo(TASKS)))
    await mounted!.settle()
    const frame = await mounted!.frame()
    expect(frame).toContain("≡ tasks · 1 of 3 done")
    expect(frame).toMatch(/✓ Read the code\s/)
    expect(frame).toMatch(/▸ Fix the bug\s/)
    expect(frame).toMatch(/○ Run the tests\s/)
    expect(frame).not.toContain("✓ todo")
    // In the panel, under its own heading, with how far it is.
    const panel = frame.split("\n").map((line) => line.slice(-36))
    expect(panel.some((line) => line.includes("Tasks") && line.includes("1 of 3 done"))).toBe(true)
    expect(panel.filter((line) => line.includes("▸ Fix the bug"))).toHaveLength(1)
    expect(mounted!.app.transcript.tasks()).toEqual(TASKS)

    session.emit(call("a1", "c2", "todo", { todos: [] }), settle("a1", "c2", "success", "Task list cleared.", todo([])))
    await mounted!.settle()
    const cleared = await mounted!.frame()
    expect(cleared).toContain("≡ tasks · cleared")
    expect(cleared.split("\n").map((line) => line.slice(-36)).some((line) => line.includes("Tasks"))).toBe(false)
    expect(mounted!.app.transcript.tasks()).toBeNull()
  })

  test("a session opened again has its current list from the replayed log; an undone turn's list is not the current one", () => {
    const transcript = new Transcript(() => CLOCK_START)
    const log = (events: readonly NewEvent[], from = 0) => events.map((item, index) => ({ ...item, sessionId: "ses_x" as SessionId, seq: from + index + 1, time: CLOCK_START + index }) as StoredEvent)
    const first: Task[] = [{ text: "Read the code", status: "in_progress" }]
    const events = log([
      started(),
      call("a1", "c1", "todo", { todos: first }),
      settle("a1", "c1", "success", "Task list updated.", todo(first)),
      succeeded({ status: "not_configured" }),
      started("exe_2"),
      call("a2", "c1", "todo", { todos: TASKS }),
      settle("a2", "c1", "success", "Task list updated.", todo(TASKS)),
      succeeded({ status: "not_configured" }, "exe_2"),
    ])
    for (const item of events) transcript.apply(item, true)
    expect(transcript.tasks()).toEqual(TASKS)
    // The second turn is taken back: the list is what the first turn left.
    transcript.apply(log([event("history.reverted", { fromSeq: 5, messageId: m("u2"), restore: null } as never)], events.length)[0]!, true)
    expect(transcript.tasks()).toEqual(first)
  })
})
