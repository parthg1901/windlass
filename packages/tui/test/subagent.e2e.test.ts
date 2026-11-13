/**
 * A subagent in the TUI, at fixed sizes: its question in the dock with its
 * label, its activity on the `subagent` row while it works (and in the
 * status line and the panel), and its own conversation when the row is
 * expanded. The events are the real engine's (a scripted model shared by
 * parent and child, the subagent's question answered in-process), played
 * into the app as the server would send them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { type EngineEvent, type StoredEvent, createHarness } from "@windlass/core"
import { E2E_TIMEOUT_MS, FakeProvider, script } from "@windlass/core/testing"
import { ARMING_MS, QUIET_MS } from "../src/approval.ts"
import type { ApprovalAsk } from "../src/backend.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-tui-child-")))
const elsewhere = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-tui-child-")))
const note = join(elsewhere, "note.txt")
const TASK = "Write the note outside"

/** The parent's stream until the subagent's question, the question, and the rest of the turn. */
let recorded: { before: EngineEvent[]; question: Extract<EngineEvent, { type: "child.event" }>; after: EngineEvent[] }

beforeAll(async () => {
  const workspace = join(root, "work")
  mkdirSync(workspace)
  const harness = createHarness({
    dataDir: join(root, "data"),
    provider: new FakeProvider([
      [script.toolCall("p1", "subagent", { task: `${TASK}\nIn the shared directory.` })],
      [script.toolCall("w1", "ls", {}), script.toolCall("w2", "write", { path: note, content: "note\n" })],
      [script.text("Written the note.")],
      [script.text("The subagent wrote it.")],
    ]),
    log: () => {},
    engine: { discover: () => [], loadConfig: null },
  })
  const session = harness.engine.createSession({ cwd: workspace, settings: { model: "test-model", reasoningEffort: null } })
  session.setAttended(true, { children: true })
  const before: EngineEvent[] = []
  const after: EngineEvent[] = []
  let question: Extract<EngineEvent, { type: "child.event" }> | null = null
  session.subscribe((item) => {
    if (item.type === "text.delta" || item.type === "reasoning.delta" || item.type === "tool.input.delta") return
    ;(question === null ? before : after).push(item)
    if (item.type === "child.event" && item.event.type === "approval.requested") {
      question = item
      before.pop()
      const data = item.event.data
      // Answered as the user would, once the question is out.
      queueMicrotask(() => session.answer({ sessionId: item.child, messageId: data.messageId, callId: data.callId }, { choice: "once" }))
    }
  })
  session.send("Get the note written.")
  await session.settled()
  await session.close()
  await harness.close()
  if (question === null) throw new Error("the subagent asked nothing")
  recorded = { before, question, after }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

function askOf(item: Extract<EngineEvent, { type: "child.event" }>): ApprovalAsk {
  if (item.event.type !== "approval.requested") throw new Error("not a question")
  const data = item.event.data
  return { sessionId: "ses_script", toolCallId: `${item.child}/${data.messageId}/${data.callId}`, messageId: data.messageId, callId: data.callId, question: data.question, needs: data.needs, then: data.then, subagent: item.title, subagentSessionId: item.child }
}

async function start(width: number, height: number) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  const session = backend.session!
  session.emit(...(recorded.before as StoredEvent[]), recorded.question)
  await mounted.settle()
  mounted.clock.now += QUIET_MS + 10
  const answer = backend.onApproval(askOf(recorded.question), new AbortController().signal)
  await mounted.settle()
  return { backend, session, answer }
}

describe("a subagent", () => {
  for (const [width, height] of [
    [100, 30],
    [80, 24],
  ] as const)
    test(`its question is in the dock with its label; its row, the status line and the panel say it asks (${width}x${height})`, async () => {
      await start(width, height)
      const frame = await mounted!.frame()
      const lines = frame.split("\n")
      expect(lines).toHaveLength(height)
      expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true)
      expect(frame).toContain(`subagent: ${TASK}`)
      expect(frame).toContain("? Allow write: writing")
      // The tool line of the dock is the subagent's own call.
      expect(frame).toMatch(/write {2}\/\S*wl-tui-child-/)
      expect(frame).toContain("[a] Allow once")
      expect(frame).toContain("↳ it asks you something: answer below")
      expect(frame).toMatch(/\? waiting for your answer · subagent /)
      if (width >= 100) expect(frame).toMatch(/agents +\? Write the note outside/)
    })

  test("answered, its calls and answer show on the row's expansion, framed under it; collapsed it says how it ended", async () => {
    const { session, answer } = await start(100, 40)
    mounted!.clock.now += ARMING_MS + 10
    mounted!.setup.mockInput.pressKey("a")
    expect(await answer).toEqual({ choice: "once" })
    session.emit(...(recorded.after as StoredEvent[]))
    await mounted!.settle()
    let frame = await mounted!.frame()
    expect(frame).not.toContain("[a] Allow once")
    expect(frame).toContain("↳ finished after 2 steps, 2 tool calls")
    expect(frame).toContain("The subagent wrote it.")
    expect(frame).not.toContain("agents ")

    // Alt-Up selects the subagent's row (the latest tool row before the answer); Ctrl-O expands it.
    for (let guard = 0; guard < 6 && !/›.*subagent|subagent.*◂/.test(frame); guard += 1) {
      mounted!.setup.mockInput.pressArrow("up", { meta: true })
      await mounted!.settle()
      frame = await mounted!.frame()
    }
    mounted!.setup.mockInput.pressKey("o", { ctrl: true })
    await mounted!.settle()
    frame = await mounted!.frame()
    const framed = frame.split("\n").filter((line) => line.includes("│ "))
    const body = framed.map((line) => line.slice(line.indexOf("│ ") + 2)).join("\n")
    expect(body).toContain(`› ${TASK}`)
    expect(body).toMatch(/✓ ls/)
    expect(body).toMatch(/✓ write \S+ · created/)
    expect(body).toContain("allowed once")
    expect(body).toContain("Written the note.")
    // Its own ending row closes the frame, and nothing under it says the same again.
    expect(body).toMatch(/○ done/)
    expect(frame).not.toContain("↳ finished after")
  })

  test("a session opened again knows the subagent from its parent's log only: expanding the row reads the subagent's own", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 40, backend })
    const session = backend.session!
    const asked: string[] = []
    const childLog = [...recorded.before, recorded.question, ...recorded.after].flatMap((item) => (item.type === "child.event" ? [item.event] : []))
    session.storedEvents = async (sessionId) => {
      asked.push(sessionId)
      return childLog
    }
    // What a load replays: the parent's durable events, none of the forwarded ones.
    session.emit(...([...recorded.before, ...recorded.after].filter((item) => "seq" in item) as StoredEvent[]))
    await mounted.settle()
    let frame = await mounted.frame()
    expect(frame).toContain("↳ finished · expand to read its work")
    for (let guard = 0; guard < 6 && !frame.includes("│ › Write the note outside"); guard += 1) {
      mounted.setup.mockInput.pressArrow("up", { meta: true })
      await mounted.settle()
      mounted.setup.mockInput.pressKey("o", { ctrl: true })
      await mounted.settle()
      frame = await mounted.frame()
      if (!frame.includes("│ › Write the note outside")) {
        mounted.setup.mockInput.pressKey("o", { ctrl: true })
        await mounted.settle()
      }
    }
    expect(asked).toEqual([childLog[0]!.sessionId])
    expect(frame).toContain("│ › Write the note outside")
    expect(frame).not.toContain("You are a subagent")
    expect(frame).toMatch(/│ ✓ write \S+ · created/)
    expect(frame).toMatch(/│ ○ done/)
    expect(frame).not.toContain("↳ finished after")
  })

  test("in the background: the status line and the panel show it at work after its call returned", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 110, height: 30, backend })
    const spawned = recorded.before.find((item) => item.type === "spawn.started") as StoredEvent<"spawn.started">
    const upToSpawn = recorded.before.slice(0, recorded.before.indexOf(spawned))
    const background = { ...spawned, data: { ...spawned.data, background: true } }
    const settled = recorded.after.find((item) => item.type === "tool.settled" && item.data.callId === spawned.data.callId) as StoredEvent<"tool.settled">
    const childEvents = recorded.before.filter((item) => item.type === "child.event").slice(0, 4)
    backend.session!.emit(...(upToSpawn as StoredEvent[]), background, ...childEvents, settled)
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toMatch(/subagent at work: Write the note outside/)
    expect(frame).toMatch(/agents +◌ Write the note outside/)
    expect(frame).toContain("↳ in the background · ")
  })
})
