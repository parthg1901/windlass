/**
 * The order of questions and confirmations at the line interface's prompt:
 * what became of an answer is said before the next question is put, between
 * two questions about the project's configuration and between such a
 * question and a tool call's approval.
 */
import { expect, test } from "bun:test"
import { Questions } from "../src/main.ts"

/** A prompt that records what was put at it and is answered by the test. */
function prompt() {
  const log: string[] = []
  let pending: { question: string; answer: (text: string | null) => void } | null = null
  const screen = {
    ask: (question: string) =>
      new Promise<string | null>((answer) => {
        // One question at a time, as the screen has it: the one that was up is backed out of.
        pending?.answer(null)
        log.push(`ask ${question}`)
        pending = { question, answer }
      }),
  }
  const type = async (text: string) => {
    const asked = pending
    pending = null
    asked?.answer(text)
    await settle()
  }
  return { log, screen, type }
}
const settle = async () => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

test("the next patient question waits until what the answer before it asked for is done and said", async () => {
  const { log, screen, type } = prompt()
  const questions = new Questions(screen)
  let approve: (() => void) | null = null
  void questions.patient("hook?", () => log.push("print hook"), async (answer) => {
    await new Promise<void>((resolve) => (approve = resolve))
    log.push(`approved the hook (${answer})`)
  })
  void questions.patient("server?", () => log.push("print server"), (answer) => void log.push(`server: ${answer}`))
  await settle()
  await type("y")
  // Answered, and the approval is still on its way: the second question is not on the screen yet.
  expect(log).toEqual(["print hook", "ask hook?"])
  approve!()
  await settle()
  await type("n")
  expect(log).toEqual(["print hook", "ask hook?", "approved the hook (y)", "print server", "ask server?", "server: n"])
})

test("a patient question that stepped aside for an approval comes back once the approval's confirmation was drawn", async () => {
  const { log, screen, type } = prompt()
  const questions = new Questions(screen)
  void questions.patient("server?", () => log.push("print server"), (answer) => void log.push(`server: ${answer}`))
  await settle()
  const approval = questions.urgent("allow?").then((answer) => log.push(`answered ${answer}`))
  await settle()
  await type("a")
  await approval
  // The answer is given; what the engine says about it (`✓ allowed once`) is not drawn yet.
  expect(log).toEqual(["print server", "ask server?", "ask allow?", "answered a"])
  log.push("✓ allowed once")
  questions.confirmed()
  await settle()
  expect(log.slice(4)).toEqual(["✓ allowed once", "print server", "ask server?"])
  await type("y")
  expect(log.at(-1)).toBe("server: y")
})

test("an approval waits for what a patient answer asked for to be said; one backed out of holds nothing", async () => {
  const { log, screen, type } = prompt()
  const questions = new Questions(screen)
  let approve: (() => void) | null = null
  void questions.patient("hook?", () => log.push("print hook"), async () => {
    await new Promise<void>((resolve) => (approve = resolve))
    log.push("approved the hook")
  })
  await settle()
  await type("y")
  const approval = questions.urgent("allow?")
  await settle()
  expect(log).toEqual(["print hook", "ask hook?"])
  approve!()
  await settle()
  expect(log).toEqual(["print hook", "ask hook?", "approved the hook", "ask allow?"])
  // Backed out of (Ctrl-C): no confirmation will come, and the next patient question is put at once.
  await type(null as never)
  expect(await approval).toBeNull()
  void questions.patient("server?", () => log.push("print server"), () => {})
  await settle()
  expect(log.slice(4)).toEqual(["print server", "ask server?"])
})
