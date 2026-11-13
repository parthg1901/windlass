/**
 * `/diff` and the ending row's expansion ask the server for one turn's own files: a turn that a queued message
 * followed is named by the event that ended it, so its diff is not the queued message's turn's.
 */
import { afterEach, expect, test } from "bun:test"
import { event } from "@windlass/core"
import type { DiffResult } from "../src/backend.ts"
import { type Mounted, ScriptBackend, mount, pressEscapeAlone } from "./helpers.ts"
import { c, flat, m } from "./builders.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

const keys = () => mounted!.setup.mockInput
const message = (id: string, text: string, delivery: "steer" | "queue") => event("inbox.enqueued", { messageId: m(id), origin: null, delivery, content: [{ type: "text", text }] })
const step = (id: string) => [event("step.started", { messageId: m(id), attempt: 1, model: "gpt-test" }), event("step.ended", { messageId: m(id), finish: "stop", usage: null })]
const file = (path: string, line: string): DiffResult & { available: true } => ({
  available: true,
  scope: "turn",
  executionId: "exe_1",
  messageId: null,
  from: "a".repeat(40),
  to: "b".repeat(40),
  files: [{ path, status: "added", binary: false, patch: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`, truncated: false, omitted: false, added: 1, removed: 0 } as never],
})

async function command(text: string): Promise<void> {
  await keys().typeText(text)
  await pressEscapeAlone(keys())
  keys().pressEnter()
  await mounted!.settle()
}

async function twoTurnsOfOneExecution() {
  const backend = new ScriptBackend()
  mounted = await mount({ width: 110, height: 34, backend })
  const session = backend.session!
  const asked: { executionId?: string; endSeq?: number; messageId?: string }[] = []
  let ends: { first: number; second: number } | null = null
  session.diff = async (params) => {
    asked.push(params)
    return params.endSeq === ends?.first ? file("notes.md", "one") : file("tests.md", "two")
  }
  session.emit(
    event("session.created", { cwd: "/w", title: null, lineage: null, settings: { model: "m", reasoningEffort: null } } as never),
    message("u1", "Write the notes.", "steer"),
    event("execution.started", { executionId: "exe_1" } as never),
    event("inbox.delivered", { messageId: m("u1") }),
    ...step("a1"),
    message("u2", "Now the tests.", "queue"),
    event("turn.ended", { verification: { status: "not_configured" } } as never),
    event("inbox.delivered", { messageId: m("u2") }),
    ...step("a2"),
    event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } } as never),
  )
  await mounted.settle()
  const rows = mounted.app.transcript.rows.filter((row) => row.kind === "outcome")
  ends = { first: rows[0]!.seq, second: rows[1]!.seq }
  return { session, asked, ends, app: mounted.app }
}

test("/diff with nothing selected shows the latest turn's own files; with the earlier turn's ending row selected, that turn's", async () => {
  const { asked, ends, app } = await twoTurnsOfOneExecution()
  expect(ends.first).toBeLessThan(ends.second)
  await command("/diff")
  expect(asked.at(-1)).toEqual({ executionId: "exe_1", endSeq: ends.second })
  let frame = await mounted!.frame()
  expect(frame).toContain("Changes of turn 2: 1 file · +1 -0")
  expect(frame).toContain("tests.md")
  await pressEscapeAlone(keys())
  await mounted!.settle()

  // Alt-Up twice: the latest ending row, then the one of the turn the queued message followed.
  keys().pressArrow("up", { meta: true })
  await mounted!.settle()
  keys().pressArrow("up", { meta: true })
  await mounted!.settle()
  expect(app.conversation.selectedRow()?.kind === "outcome" && app.conversation.selectedRow()?.seq).toBe(ends.first)
  await command("/diff")
  expect(asked.at(-1)).toEqual({ endSeq: ends.first })
  frame = await mounted!.frame()
  expect(frame).toContain("Changes of turn 1: 1 file · +1 -0")
  expect(frame).toContain("notes.md")
  expect(frame).not.toContain("tests.md")
  expect(flat(app.conversation.text())).not.toContain("kept apart")

  // r in the reader opens the review of the same turn, not of the execution's latest.
  keys().pressKey("r")
  await mounted!.settle()
  expect(app.review.open).toBe(true)
  expect(asked.at(-1)).toEqual({ executionId: "exe_1", endSeq: ends.first })
  expect(await mounted!.frame()).toContain("Review of turn 1 · no comments yet · 1 file · +1 -0")
})

test("a turn that changed no file says which turn, and with nothing selected how to see an earlier one", async () => {
  const { session, app } = await twoTurnsOfOneExecution()
  session.diff = async () => ({ available: true, scope: "turn", executionId: "exe_1", messageId: null, from: "a".repeat(40), to: "a".repeat(40), files: [] })
  await command("/diff")
  expect(flat(app.conversation.text())).toContain("turn 2 changed no file (the latest); for an earlier turn's changes select its ending row (Alt-Up), then /diff")
  keys().pressArrow("up", { meta: true })
  await mounted!.settle()
  keys().pressArrow("up", { meta: true })
  await mounted!.settle()
  await command("/diff")
  expect(flat(app.conversation.text())).toMatch(/turn 1 changed no file(?! \(the latest\))/)
})
