import { afterEach, describe, expect, test } from "bun:test"
import { type NewEvent, event } from "@light-harness/core"
import { executionSucceeded, m, opening, say, stepStarted } from "@light-harness/core/testing/scenarios"
import { BackendError } from "../src/backend.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function scripted(width = 100, height = 30): Promise<{ mounted: Mounted; backend: ScriptBackend }> {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  backend.session!.emit(event("session.created", { cwd: "/work", title: null, lineage: null, settings: { model: "gpt-6-luna", reasoningEffort: "low" } }))
  await mounted.settle()
  return { mounted, backend }
}

const keys = (mounted: Mounted) => mounted.setup.mockInput

describe("the input", () => {
  test("Enter sends; Alt-Enter and a trailing backslash start a new line instead", async () => {
    const { mounted, backend } = await scripted()
    await keys(mounted).typeText("first line")
    keys(mounted).pressEnter({ meta: true })
    await keys(mounted).typeText("second\\")
    keys(mounted).pressEnter()
    await keys(mounted).typeText("third")
    await mounted.settle()
    expect(mounted.app.input.plainText).toBe("first line\nsecond\nthird")
    expect(await mounted.frame()).toContain("second")
    keys(mounted).pressEnter()
    await mounted.settle()
    expect(backend.sent).toEqual([{ text: "first line\nsecond\nthird", delivery: "steer" }])
    expect(mounted.app.input.plainText).toBe("")
  })

  test("a paste with newlines is inserted, not sent", async () => {
    const { mounted, backend } = await scripted()
    await keys(mounted).pasteBracketedText("line one\nline two\nline three")
    await mounted.settle()
    expect(mounted.app.input.plainText).toBe("line one\nline two\nline three")
    expect(backend.sent).toHaveLength(0)
  })

  test("Up and Down recall whole entries, and Down returns to the draft", async () => {
    const { mounted, backend } = await scripted()
    for (const text of ["one", "two\nlines"]) {
      await keys(mounted).typeText(text.split("\n")[0]!)
      if (text.includes("\n")) {
        keys(mounted).pressEnter({ meta: true })
        await keys(mounted).typeText("lines")
      }
      keys(mounted).pressEnter()
      await mounted.settle()
    }
    expect(backend.sent.map((item) => item.text)).toEqual(["one", "two\nlines"])
    await keys(mounted).typeText("draft")
    keys(mounted).pressArrow("up")
    expect(mounted.app.input.plainText).toBe("two\nlines")
    // The cursor is at the end of the recalled entry: Up moves inside it first, then to the entry before.
    keys(mounted).pressArrow("up")
    keys(mounted).pressArrow("up")
    expect(mounted.app.input.plainText).toBe("one")
    keys(mounted).pressArrow("down")
    keys(mounted).pressArrow("down")
    expect(mounted.app.input.plainText).toBe("draft")
  })

  test("Ctrl-C at the prompt clears it, and on an empty prompt says how to leave", async () => {
    const { mounted } = await scripted()
    await keys(mounted).typeText("not this")
    keys(mounted).pressCtrlC()
    expect(mounted.app.input.plainText).toBe("")
    keys(mounted).pressCtrlC()
    expect(await mounted.frame()).toContain("press Ctrl-D or type /quit to leave")
    expect(mounted.exits).toEqual([])
  })
})

describe("while the agent works", () => {
  async function working() {
    const context = await scripted()
    context.backend.session!.emit(...opening("start"), stepStarted("a1"))
    await context.mounted.settle()
    return context
  }

  test("the mode says whether Enter steers or queues, and Ctrl-T toggles it", async () => {
    const { mounted, backend } = await working()
    let frame = await mounted.frame()
    expect(frame).toContain("steer ›")
    expect(frame).toContain("Enter steers the running turn")
    await keys(mounted).typeText("look at the docs too")
    keys(mounted).pressEnter()
    keys(mounted).pressKey("t", { ctrl: true })
    await mounted.settle()
    frame = await mounted.frame()
    expect(frame).toContain("queue ›")
    await keys(mounted).typeText("then update the changelog")
    keys(mounted).pressEnter()
    await mounted.settle()
    expect(backend.sent).toEqual([
      { text: "look at the docs too", delivery: "steer" },
      { text: "then update the changelog", delivery: "queue" },
    ])
  })

  test("the first Ctrl-C stops the turn and says so; a second within two seconds exits at once", async () => {
    const { mounted, backend } = await working()
    keys(mounted).pressCtrlC()
    expect(backend.interrupts).toBe(1)
    backend.session!.emit(event("execution.interrupt_requested", { executionId: "exe_1" as never, reason: "user" }))
    await mounted.settle()
    expect(await mounted.frame()).toContain("■ stopping… · press Ctrl-C again to exit now")
    mounted.clock.now += 1500
    keys(mounted).pressCtrlC()
    expect(mounted.exits).toEqual([130])
  })

  test("the exit hint on the stop line goes once the turn has ended", async () => {
    const { mounted, backend } = await working()
    keys(mounted).pressCtrlC()
    backend.session!.emit(event("execution.interrupt_requested", { executionId: "exe_1" as never, reason: "user" }), event("execution.interrupted", { executionId: "exe_1" as never, reason: "user" }))
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("■ stopping…")
    expect(frame).not.toContain("press Ctrl-C again")
    expect(frame).toContain("■ interrupted")
  })

  test("a second Ctrl-C after two seconds stops again instead of exiting", async () => {
    const { mounted, backend } = await working()
    keys(mounted).pressCtrlC()
    mounted.clock.now += 2500
    keys(mounted).pressCtrlC()
    expect(backend.interrupts).toBe(2)
    expect(mounted.exits).toEqual([])
  })

  test("the status line says what runs and for how long", async () => {
    const { mounted, backend } = await working()
    mounted.clock.now += 3200
    let frame = await mounted.frame()
    expect(frame).toMatch(/model call · gpt-test · 3\.2s/)
    backend.session!.emit(
      event("tool.called", { messageId: m("a1"), callId: "c1" as never, name: "shell", input: JSON.stringify({ command: "bun test" }), providerData: null }),
      event("tool.started", { messageId: m("a1"), callId: "c1" as never, effect: "exec" }),
    )
    await mounted.settle()
    mounted.clock.now += 1000
    frame = await mounted.frame()
    expect(frame).toMatch(/running shell bun test · 1\.0s/)
    expect(frame).toMatch(/⋯ shell bun test · running · 1\.0s/)
  })
})

describe("the command palette and dialogs", () => {
  test("typing / lists the commands; Tab completes; Enter runs", async () => {
    const { mounted } = await scripted()
    await keys(mounted).typeText("/")
    let frame = await mounted.frame()
    for (const name of ["/new", "/help", "/quit"]) expect(frame).toContain(name)
    // This backend cannot undo, list sessions or models, or compact: those are not offered.
    for (const name of ["/undo", "/sessions", "/model", "/compact"]) expect(frame).not.toContain(name)
    await keys(mounted).typeText("he")
    keys(mounted).pressTab()
    expect(mounted.app.input.plainText).toBe("/help")
    keys(mounted).pressEnter()
    await mounted.settle()
    frame = await mounted.frame()
    expect(mounted.app.dialog.open).toBe(true)
    expect(frame).toContain("Help")
    expect(frame).toContain("Ctrl-T")
    keys(mounted).pressEscape()
    // A lone Esc is told from the start of an escape sequence only after a short wait.
    await Bun.sleep(80)
    await mounted.settle()
    expect(mounted.app.dialog.open).toBe(false)
  })

  test("a question from the agent is a dialog; what the user was typing is still there afterwards", async () => {
    const { mounted, backend } = await scripted()
    await keys(mounted).typeText("half a thought")
    const answer = backend.onQuestion({
      title: "Undo: overwrite 1 file edited by hand since then?",
      detail: ["Edited by hand: notes.md."],
      options: [
        { id: "overwrite", label: "Overwrite them", kind: "allow" },
        { id: "keep", label: "Keep my edits, restore the rest", kind: "allow" },
        { id: "cancel", label: "Change nothing", kind: "reject" },
      ],
    })
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("Undo: overwrite 1 file edited by hand since then?")
    expect(frame).toContain("[y] Overwrite them")
    expect(frame).toContain("[n] Change nothing")
    // Keys go to the dialog, not to the input.
    keys(mounted).pressArrow("down")
    keys(mounted).pressEnter()
    expect(await answer).toBe("keep")
    expect(mounted.app.input.plainText).toBe("half a thought")
  })

  test("Esc or Ctrl-C on a question answers with its reject option", async () => {
    const { mounted, backend } = await scripted()
    const answer = backend.onQuestion({ title: "Q", detail: [], options: [{ id: "yes", label: "Yes", kind: "allow" }, { id: "no", label: "No", kind: "reject" }] })
    await mounted.settle()
    keys(mounted).pressCtrlC()
    expect(await answer).toBe("no")
    expect(mounted.exits).toEqual([])
  })
})

describe("scrolling", () => {
  async function long() {
    const context = await scripted(80, 20)
    const events = [...opening("start"), stepStarted("a1"), say("a1", Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n\n"))]
    context.backend.session!.emit(...events)
    await context.mounted.settle()
    return context
  }

  test("follows the bottom; PageUp stays put while output arrives; Esc follows again", async () => {
    const { mounted, backend } = await long()
    expect(await mounted.frame()).toContain("line 60")
    keys(mounted).pressKey("\x1b[5~")
    await mounted.settle()
    const scrolled = await mounted.frame()
    expect(scrolled).not.toContain("line 60")
    expect(scrolled).toContain("↑ scrolled")
    const top = scrolled.split("\n")[0]
    backend.session!.emit(event("step.ended", { messageId: m("a1"), finish: "stop", usage: null }), stepStarted("a2"), say("a2", "something new arrived"), executionSucceeded())
    await mounted.settle()
    const after = await mounted.frame()
    expect(after.split("\n")[0]).toBe(top)
    expect(after).toMatch(/↑ scrolled · \d+ new lines below · Esc follows/)
    keys(mounted).pressEscape()
    // A lone Esc is told from the start of an escape sequence only after a short wait.
    await Bun.sleep(80)
    await mounted.settle()
    expect(await mounted.frame()).toContain("something new arrived")
  })

  test("the mouse wheel scrolls", async () => {
    const { mounted } = await long()
    await mounted.setup.mockMouse.scroll(10, 5, "up")
    await mounted.settle()
    expect(await mounted.frame()).toContain("↑ scrolled")
    for (let index = 0; index < 10; index += 1) await mounted.setup.mockMouse.scroll(10, 5, "down")
    await mounted.settle()
    expect(await mounted.frame()).not.toContain("↑ scrolled")
  })
})

describe("robustness", () => {
  test("thousands of rows and a huge output stay fast to render", async () => {
    const { mounted, backend } = await scripted(120, 40)
    const events: NewEvent[] = [...opening("start")]
    for (let step = 1; step <= 1500; step += 1) {
      const id = `a${step}`
      events.push(stepStarted(id), say(id, `step ${step}: **checked** \`file${step}.ts\``))
      events.push(event("tool.called", { messageId: m(id), callId: "c1" as never, name: "shell", input: JSON.stringify({ command: `cat big${step}` }), providerData: null }))
      events.push(event("tool.settled", { messageId: m(id), callId: "c1" as never, outcome: "success", output: step === 1500 ? Array.from({ length: 50_000 }, (_, index) => `output ${index}`).join("\n") : "ok", truncation: null, attachments: [], display: { exitCode: 0 } }))
      events.push(event("step.ended", { messageId: m(id), finish: "tool_calls", usage: null }))
    }
    events.push(say("a1500", "x".repeat(200_000)))
    backend.session!.emit(...events)
    await mounted.settle(40)
    const started = performance.now()
    let frame = await mounted.frame()
    const first = performance.now() - started
    expect(frame).toContain("characters)")
    // Expanding the huge output, fully, still draws only what is on screen.
    keys(mounted).pressKey("o", { ctrl: true })
    keys(mounted).pressKey("o", { ctrl: true })
    const again = performance.now()
    frame = await mounted.frame()
    expect(performance.now() - again).toBeLessThan(2000)
    expect(first).toBeLessThan(5000)
    for (let index = 0; index < 20; index += 1) keys(mounted).pressKey("\x1b[5~")
    const paged = performance.now()
    await mounted.frame()
    expect(performance.now() - paged).toBeLessThan(200)
  })

  test("the server dying is said, with how to resume", async () => {
    const { mounted, backend } = await scripted()
    backend.session!.die("the engine process was killed (SIGKILL); its work is recovered when the session is opened again: lh tui --session ses_script")
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("the engine is gone")
    expect(frame).toContain("lh tui --session ses_script")
    expect(frame).toContain("✗ disconnected")
  })

  test("starting signed out says so and how to sign in, and stays open", async () => {
    const backend = new ScriptBackend()
    backend.failOpen = new BackendError("you are not signed in (sign in with ChatGPT, then try again)", "auth_required")
    mounted = await mount({ width: 100, height: 20, backend })
    const frame = await mounted.frame()
    expect(frame).toContain("not signed in: you are not signed in")
    expect(frame).toContain("Sign in, then type /reconnect")
    expect(frame).toContain("✗ not signed in")
  })

  test("a resize at any time re-lays out the frame to the new width", async () => {
    const { mounted, backend } = await scripted(200, 30)
    backend.session!.emit(...opening("start"), stepStarted("a1"), say("a1", "word ".repeat(120)))
    await mounted.settle()
    for (const [width, height] of [[60, 20], [140, 40], [40, 12]] as const) {
      mounted.setup.resize(width, height)
      await mounted.settle()
      const lines = (await mounted.frame()).split("\n")
      expect(lines).toHaveLength(height)
      expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true)
    }
  })

  test("the verification endings: passed, not needed and unresolved read differently", async () => {
    const { mounted, backend } = await scripted(120, 30)
    const evidence = { run: 1, checks: [], stale: false } as never
    for (const verification of [{ status: "passed", evidence }, { status: "not_needed" }, { status: "unresolved", reason: "max_rounds", failing: ["test"], acknowledgement: null, evidence: { run: 3, checks: [] } }] as const) {
      backend.session!.emit(...opening("go"), stepStarted("a1"), event("step.ended", { messageId: m("a1"), finish: "stop", usage: null }), event("execution.succeeded", { executionId: "exe_1" as never, verification: verification as never }))
    }
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("✓ done · checks passed")
    expect(frame).toContain("○ done · checks not needed: nothing they cover changed")
    expect(frame).toContain("✗ unresolved · failing checks: test")
  })
})

describe("the model picker", () => {
  test("picks a model, then its effort, and switches through the session's config", async () => {
    const changes: [string, string][] = []
    const backend = new ScriptBackend()
    Object.assign(backend, {
      listModels: async () => ({
        defaultModel: "gpt-6-luna",
        models: [
          { id: "gpt-6-luna", name: "Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000, isDefault: true },
          { id: "gpt-6.1-sol", name: "Sol", efforts: ["low", "high"], defaultEffort: "high", contextWindow: 400_000, isDefault: false },
        ],
      }),
    })
    const open = backend.open.bind(backend)
    backend.open = async (...args) => Object.assign(await open(...args), { setConfig: async (id: string, value: string) => void changes.push([id, value]) })
    mounted = await mount({ width: 100, height: 30, backend })
    backend.session!.emit(event("session.created", { cwd: "/work", title: null, lineage: null, settings: { model: "gpt-6-luna", reasoningEffort: "low" } }))
    await mounted.settle()
    await keys(mounted).typeText("/model")
    keys(mounted).pressEnter()
    await mounted.settle()
    let frame = await mounted.frame()
    expect(frame).toContain("gpt-6-luna (current)")
    expect(frame).toContain("400k context")
    // Typing filters the list.
    await keys(mounted).typeText("sol")
    keys(mounted).pressEnter()
    await mounted.settle()
    frame = await mounted.frame()
    expect(frame).toContain("Reasoning effort for gpt-6.1-sol")
    keys(mounted).pressArrow("down")
    keys(mounted).pressArrow("down")
    keys(mounted).pressEnter()
    await mounted.settle()
    expect(changes).toEqual([
      ["model", "gpt-6.1-sol"],
      ["effort", "high"],
    ])
  })
})
