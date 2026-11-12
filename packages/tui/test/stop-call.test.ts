/**
 * In the real `App`: Ctrl-X stops one running tool call and the turn goes
 * on. The hints name the key while there is a call it would act on; the
 * call's row says it is stopping, and then that the user stopped it, with
 * what it had printed; a call that cannot be stopped midway says so.
 */
import { afterEach, expect, test } from "bun:test"
import { event } from "@windlass/core"
import { c, call, flat, m, settle, started } from "./builders.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function open() {
  const backend = new ScriptBackend()
  mounted = await mount({ width: 150, height: 40, backend })
  const session = backend.session!
  const asked: { messageId: string; callId: string }[] = []
  session.cancelCall = async (target) => {
    asked.push(target)
    return { stopped: true, message: null }
  }
  return { session, asked }
}

const running = (id: string, callId: string) => event("tool.started", { messageId: m(id), callId: c(callId) } as never)
const stopAsked = (id: string, callId: string) => event("tool.cancel_requested", { messageId: m(id), callId: c(callId) })
const frame = async () => {
  await mounted!.settle()
  return flat(await mounted!.frame())
}
const ctrlX = () => mounted!.setup.mockInput.pressKey("x", { ctrl: true })

test("Ctrl-X stops the one running call; its row says stopping, then that you stopped it, with what it had printed", async () => {
  const { session, asked } = await open()
  session.emit(started(), event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }), call("a1", "c1", "shell", { command: "bun dev" }), running("a1", "c1"))
  // The key is in the hints while there is a call it would act on.
  expect(await frame()).toContain("Ctrl-X stops shell bun dev only (the turn goes on) · Ctrl-C stops the turn")
  ctrlX()
  await mounted!.settle()
  expect(asked).toEqual([{ messageId: m("a1"), callId: c("c1") }])
  session.emit(stopAsked("a1", "c1"))
  const stopping = await frame()
  expect(stopping).toContain("■ shell bun dev")
  expect(stopping).toContain("· stopping")
  // Asked once: the hint is gone, and the key says the call was asked already.
  expect(stopping).not.toContain("Ctrl-X stops shell")
  ctrlX()
  await mounted!.settle()
  expect(asked).toHaveLength(1)
  expect(await frame()).toContain("that call was already asked to stop")
  session.emit(settle("a1", "c1", "error", "listening on :3000\nGET / 200\n\n[Stopped by the user. The command and its child processes were stopped; the output above is everything it printed before that.]", { interrupted: "call" }))
  const stopped = await frame()
  expect(stopped).toContain("■ shell bun dev · stopped by you")
  expect(stopped).toContain("GET / 200")
  expect(stopped).not.toContain("✗")
})

test("with several calls running the selected one is stopped; with none selected it says how; a call that finishes anyway says so", async () => {
  const { session, asked } = await open()
  session.emit(
    started(),
    event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }),
    call("a1", "c1", "shell", { command: "bun dev" }),
    call("a1", "c2", "write", { path: "notes.md", content: "x\n" }),
    running("a1", "c1"),
    running("a1", "c2"),
  )
  await mounted!.settle()
  ctrlX()
  expect(await frame()).toContain("2 tool calls are running: select one with Alt-Up or Alt-Down, then Ctrl-X stops it")
  expect(asked).toEqual([])
  // The latest row is the write: selected, the hint names it, and the key stops it.
  mounted!.setup.mockInput.pressArrow("up", { meta: true })
  expect(await frame()).toContain("Ctrl-X stops write notes.md only (the turn goes on)")
  ctrlX()
  await mounted!.settle()
  expect(asked).toEqual([{ messageId: m("a1"), callId: c("c2") }])
  session.emit(stopAsked("a1", "c2"), settle("a1", "c2", "success", "Wrote notes.md (1 line)."))
  const done = await frame()
  expect(done).toContain("it could not be stopped midway and finished: this is its result")
  // A refusal of the engine's is said with its reason.
  session.cancelCall = async () => ({ stopped: false, message: "The whole turn is being stopped, which stops every call in it." })
  mounted!.setup.mockInput.pressArrow("up", { meta: true })
  ctrlX()
  expect(await frame()).toContain("not stopped: The whole turn is being stopped, which stops every call in it.")
})

test("with nothing running the key says so; /stop is the same act as the key", async () => {
  const { session, asked } = await open()
  ctrlX()
  expect(await frame()).toContain("no tool call is running, so there is nothing for Ctrl-X to stop")
  session.emit(started(), event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }), call("a1", "c1", "shell", { command: "bun dev" }), running("a1", "c1"))
  await mounted!.settle()
  await mounted!.setup.mockInput.typeText("/stop")
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
  expect(asked).toEqual([{ messageId: m("a1"), callId: c("c1") }])
})
