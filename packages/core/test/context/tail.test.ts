import { describe, expect, test } from "bun:test"
import { allowedCut, chooseTail } from "../../src/context/tail.ts"
import { HARNESS_ORIGIN } from "../../src/event/durable.ts"
import type { Message } from "../../src/message/message.ts"
import { renderMessage } from "../../src/request/build.ts"
import { Script, filler, read, shell } from "./fixtures.ts"

/** Every message costs 10 tokens, so budgets read as message counts. */
const flat = () => 10

function turn(script: Script, request: string, steps: number) {
  script.user(request)
  for (let index = 0; index < steps; index += 1) script.step({ calls: [read(`src/file-${index}.ts`, filler(30, index))] })
  return script.step({ text: "Done." })
}

describe("chooseTail", () => {
  test("keeps as much as fits, cutting between messages", () => {
    const script = new Script()
    turn(script, "first", 3) // seq 1..5
    turn(script, "second", 3) // seq 6..10
    const choice = chooseTail(script.messages, { budget: 30, cost: flat })
    // The latest user message (index 5) is mandatory; 50 tokens from there, over budget.
    expect(choice).toMatchObject({ keepFrom: 5, keepFromSeq: 6, boundary: "user", overBudget: true, keptTokens: 50, removedTokens: 50 })
  })

  test("prefers a user-message boundary when it keeps at least half as much", () => {
    const script = new Script()
    turn(script, "first", 3) // index 0..4
    turn(script, "second", 1) // index 5..7
    // Budget 70: the best cut is index 1 (70 tokens); the user cut at index 5 keeps 30, less than half: take 1.
    expect(chooseTail(script.messages, { budget: 70, cost: flat })).toMatchObject({ keepFrom: 1, boundary: "step", keptTokens: 70 })
    // Budget 50: the best cut is index 3 (50 tokens); the user cut keeps 30, at least half: prefer it.
    expect(chooseTail(script.messages, { budget: 50, cost: flat })).toMatchObject({ keepFrom: 5, boundary: "user" })
  })

  test("always keeps the latest user message and what follows", () => {
    const script = new Script()
    turn(script, "first", 2)
    script.user("big request " + filler(2_000))
    script.step({ calls: [shell("bun test", filler(500))] })
    const choice = chooseTail(script.messages, { budget: 10 })
    expect(choice.keepFrom).toBe(4)
    expect(choice.overBudget).toBe(true)
    expect(script.messages[choice.keepFrom]!.kind).toBe("user")
  })

  test("never keeps a leading checkpoint and says when nothing can be removed", () => {
    const script = new Script().checkpoint("old summary", 1)
    script.user("go on")
    script.step({ text: "ok" })
    const choice = chooseTail(script.messages, { budget: 1_000, cost: flat })
    expect(choice.keepFrom).toBe(1)
    expect(choice.nothingToRemove).toBe(true)
  })

  test("with no user message the whole list may go", () => {
    const script = new Script().checkpoint("old", 1)
    script.step({ calls: [read("a.ts", "x")] })
    script.step({ text: "done" })
    const choice = chooseTail(script.messages, { budget: 5, cost: flat })
    expect(choice).toMatchObject({ keepFrom: 3, keepFromSeq: null, boundary: "end", nothingToRemove: false })
  })

  test("does not split a step continued after a provider error, nor separate an interrupt marker", () => {
    const script = new Script()
    script.user("start") // 0
    script.step({ calls: [read("a.ts", "x")], status: "failed" }) // 1
    script.synthetic(HARNESS_ORIGIN.continuation, "continue") // 2
    script.step({ text: "continued" }) // 3
    script.step({ text: "cut", status: "failed" }) // 4
    script.synthetic(HARNESS_ORIGIN.interrupt, "stopped") // 5
    script.step({ text: "after" }) // 6
    expect([1, 2, 3, 4, 5, 6].map((index) => allowedCut(script.messages, index))).toEqual([true, false, false, true, false, true])
    // No user boundary after index 0; a budget of 30 would allow index 4 only if 4..6 fits (30): yes.
    expect(chooseTail(script.messages, { budget: 30, cost: flat }).keepFrom).toBe(0)
  })

  test("the kept tail never holds a tool result without its call, on many scripted histories", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const script = new Script()
      for (let index = 0; index < 12; index += 1) {
        if ((seed + index) % 4 === 0) script.user(`request ${index} ${filler(seed % 7, index)}`)
        script.step({
          text: index % 3 === 0 ? filler(10, seed) : undefined,
          calls: Array.from({ length: (seed * index) % 3 }, (_, call) => shell(`bun test ${call}`, filler(20 + ((seed * 13 + index) % 90), call), call)),
        })
      }
      for (const budget of [0, 50, 200, 800, 5_000]) {
        const choice = chooseTail(script.messages, { budget })
        const items = script.messages.slice(choice.keepFrom).flatMap((message) => renderMessage(message, { model: "gpt-6-luna", baselineSeq: 0 }))
        const calls = new Set(items.flatMap((item) => (item.type === "tool_call" ? [item.callId] : [])))
        for (const item of items) if (item.type === "tool_result") expect(calls.has(item.callId)).toBe(true)
        const latestUser = script.messages.findLastIndex((message: Message) => message.kind === "user")
        if (latestUser !== -1) expect(choice.keepFrom).toBeLessThanOrEqual(latestUser)
      }
    }
  })

  test("is deterministic", () => {
    const build = () => {
      const script = new Script()
      turn(script, "a", 4)
      turn(script, "b", 4)
      return chooseTail(script.messages, { budget: 400 })
    }
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
  })
})
