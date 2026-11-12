/**
 * `/rename` and `/compact` in the real `App`: the title, what a compaction
 * that was asked for says, and that it is not drawn as a turn's ending.
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

describe("/rename and /compact", () => {
  test("/rename gives the title, in the panel; /compact says why there was nothing to compact, or that it failed", async () => {
    const { session } = await open()
    session.rename = async (title) => title.trim()
    await enter("/rename Login bug")
    const renamed = flat(await mounted!.frame())
    expect(renamed).toContain("renamed: Login bug")
    expect(renamed).toContain("title Login bug")
    session.compact = async () => ({ kind: "nothing", message: "There is nothing to compact: the conversation has not started." })
    await enter("/compact")
    expect(flat(await mounted!.frame())).toContain("There is nothing to compact: the conversation has not started.")
    session.compact = async () => ({ kind: "failed", message: "The compaction was interrupted; the conversation is unchanged." })
    await enter("/compact")
    expect(flat(await mounted!.frame())).toContain("The compaction was interrupted; the conversation is unchanged.")
  })
  test("a compaction that was asked for is drawn with its sizes and not as a turn's ending", async () => {
    const { session } = await open()
    session.compact = async () => {
      session.emit(
        started("exe_2"),
        event("compaction.started", { messageId: m("k1"), trigger: "manual", mode: "normal", keepFromSeq: 1, prompt: "Summarise.", tokensBefore: 9000 }),
        event("compaction.ended", { messageId: m("k1"), summary: "A checkpoint.", source: "model", detail: null, tokensAfter: 1200, usage: null, calls: 1 }),
        succeeded({ status: "not_needed" }, "exe_2"),
      )
      return { kind: "compacted", tokensBefore: 9000, tokensAfter: 1200, source: "model", detail: null }
    }
    await enter("/compact")
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("⇣ compacted the conversation · about 9,000 → 1,200 tokens")
    expect(frame).not.toContain("done")
    expect(mounted!.app.transcript.rows.some((row) => row.kind === "outcome")).toBe(false)
    expect(mounted!.app.transcript.turns.turns).toHaveLength(0)
  })
})
