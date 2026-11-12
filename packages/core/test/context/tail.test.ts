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

describe("chooseTail at a user-message boundary", () => {
  test("keeps as much as fits, cutting between messages", () => {
    const script = new Script()
    turn(script, "first", 3) // index 0..4
    turn(script, "second", 3) // index 5..9
    script.user("third") // index 10: what the next call answers
    // 30 tokens: the new prompt and the two messages before it.
    expect(chooseTail(script.messages, { budget: 30, cost: flat })).toMatchObject({ keepFrom: 8, keepFromSeq: 9, boundary: "step", overBudget: false, keptTokens: 30, removedTokens: 80, midTurn: false })
  })

  test("prefers a user-message boundary when it keeps at least half as much", () => {
    const script = new Script()
    turn(script, "first", 3) // index 0..4
    turn(script, "second", 1) // index 5..7
    script.user("third") // index 8
    // Budget 80: the best cut is index 1 (80 tokens); the user cut at index 5 keeps 40, at least half: prefer it.
    expect(chooseTail(script.messages, { budget: 80, cost: flat })).toMatchObject({ keepFrom: 5, boundary: "user", keptTokens: 40 })
    // Budget 90 keeps everything from the very first message, which is a user message too.
    expect(chooseTail(script.messages, { budget: 90, cost: flat })).toMatchObject({ keepFrom: 0, boundary: "user", nothingToRemove: true })
    // Budget 30: index 6 keeps 30; the user cut at index 8 keeps 10, less than half: take 6.
    expect(chooseTail(script.messages, { budget: 30, cost: flat })).toMatchObject({ keepFrom: 6, boundary: "step", keptTokens: 30 })
  })

  test("the input that arrived since the model last spoke is kept even over budget", () => {
    const script = new Script()
    turn(script, "first", 2) // index 0..3
    script.user("big request " + filler(2_000)) // index 4
    script.user("and one more thing") // index 5: a second steer before the model answered
    const choice = chooseTail(script.messages, { budget: 10 })
    expect(choice).toMatchObject({ keepFrom: 4, boundary: "user", overBudget: true, midTurn: false })
  })

  test("an aggressive compaction keeps it only when it fits", () => {
    const script = new Script()
    turn(script, "first", 2)
    script.user("big request " + filler(2_000))
    const choice = chooseTail(script.messages, { budget: 10, mandatory: "if_fits" })
    // Nothing is kept: the checkpoint quotes the request, and has to say that the work continues.
    expect(choice).toMatchObject({ keepFrom: 5, keepFromSeq: null, boundary: "end", overBudget: false, keptTokens: 0, midTurn: true })
    expect(chooseTail(script.messages, { budget: 10_000, mandatory: "if_fits" })).toMatchObject({ keepFrom: 0, nothingToRemove: true })
  })

  test("a step that failed before any output is not the model speaking", () => {
    const script = new Script()
    turn(script, "first", 1) // index 0..2
    script.user("second") // index 3
    script.step({ status: "failed" }) // index 4: rejected as too large, nothing was said
    expect(chooseTail(script.messages, { budget: 0, cost: flat })).toMatchObject({ keepFrom: 3, boundary: "user", midTurn: false })
  })
})

describe("chooseTail in the middle of a turn", () => {
  test("one long turn keeps its most recent steps and cuts between two of them", () => {
    const script = new Script()
    script.user("refactor everything") // index 0
    for (let index = 0; index < 8; index += 1) script.step({ calls: [read(`src/file-${index}.ts`, filler(30, index))] }) // index 1..8
    const choice = chooseTail(script.messages, { budget: 30, cost: flat })
    // The three latest steps fit. The request itself is before the cut.
    expect(choice).toMatchObject({ keepFrom: 6, keepFromSeq: 7, boundary: "step", overBudget: false, keptTokens: 30, removedTokens: 60, nothingToRemove: false, midTurn: true })
  })

  test("the last step is kept even over budget, with what the harness said after it", () => {
    const script = new Script()
    script.user("fix it") // 0
    script.step({ calls: [read("a.ts", filler(40))] }) // 1
    script.step({ calls: [shell("bun test", filler(4_000), 1)] }) // 2: the step whose result the next call needs
    script.synthetic(HARNESS_ORIGIN.checkReport, "1 check failed") // 3
    const choice = chooseTail(script.messages, { budget: 10 })
    expect(choice).toMatchObject({ keepFrom: 2, boundary: "step", overBudget: true, midTurn: true })
    // Aggressively, the step goes too when it does not fit: with room for the report alone, only that stays; with none, nothing.
    expect(chooseTail(script.messages, { budget: 10, mandatory: "if_fits" })).toMatchObject({ keepFrom: 3, boundary: "step" })
    expect(chooseTail(script.messages, { budget: 5, mandatory: "if_fits" })).toMatchObject({ keepFrom: 4, boundary: "end", keptTokens: 0 })
  })

  test("a turn that fits is kept from its request on", () => {
    const script = new Script()
    turn(script, "first", 4) // index 0..5
    script.user("second") // 6
    script.step({ calls: [read("a.ts", "x")] }) // 7
    script.step({ calls: [read("b.ts", "y")] }) // 8
    expect(chooseTail(script.messages, { budget: 40, cost: flat })).toMatchObject({ keepFrom: 6, boundary: "user", keptTokens: 30, midTurn: false })
  })
})

describe("chooseTail", () => {
  test("never keeps a leading checkpoint and says when nothing can be removed", () => {
    const script = new Script().checkpoint("old summary", 1)
    script.user("go on")
    script.step({ text: "ok" })
    const choice = chooseTail(script.messages, { budget: 1_000, cost: flat })
    expect(choice.keepFrom).toBe(1)
    expect(choice.nothingToRemove).toBe(true)
  })

  test("with no user message in view the cut still falls between steps", () => {
    const script = new Script().checkpoint("old", 1)
    script.step({ calls: [read("a.ts", "x")] })
    script.step({ text: "done" })
    // The last step is what the next call follows.
    expect(chooseTail(script.messages, { budget: 5, cost: flat })).toMatchObject({ keepFrom: 2, keepFromSeq: 3, boundary: "step", nothingToRemove: false, midTurn: true })
    expect(chooseTail(script.messages, { budget: 5, cost: flat, mandatory: "if_fits" })).toMatchObject({ keepFrom: 3, keepFromSeq: null, boundary: "end" })
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
    // The last step is index 6; with room for three messages the cut is at index 4, never at 5 (the marker stays with its step).
    expect(chooseTail(script.messages, { budget: 30, cost: flat }).keepFrom).toBe(4)
    expect(chooseTail(script.messages, { budget: 20, cost: flat }).keepFrom).toBe(6)
    // Room for five: index 2 and 3 would split the continued step, so the cut is at index 4 again.
    expect(chooseTail(script.messages, { budget: 50, cost: flat }).keepFrom).toBe(4)
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
      for (const mandatory of ["always", "if_fits"] as const) {
        for (const budget of [0, 50, 200, 800, 5_000]) {
          const choice = chooseTail(script.messages, { budget, mandatory })
          const kept = script.messages.slice(choice.keepFrom)
          const items = kept.flatMap((message) => renderMessage(message, { model: "gpt-6-luna", baselineSeq: 0 }))
          const calls = new Set(items.flatMap((item) => (item.type === "tool_call" ? [item.callId] : [])))
          for (const item of items) if (item.type === "tool_result") expect(calls.has(item.callId)).toBe(true)
          // A normal compaction always keeps what the next call answers: the last step, or the input that came after it.
          const lastStep = script.messages.findLastIndex((message: Message) => message.kind === "assistant" && message.parts.length > 0)
          const latestUser = script.messages.findLastIndex((message: Message) => message.kind === "user")
          if (mandatory === "always") expect(choice.keepFrom).toBeLessThanOrEqual(latestUser > lastStep ? lastStep + 1 : lastStep)
          // What is kept fits the budget, unless it is only the mandatory part.
          if (!choice.overBudget) expect(choice.keptTokens).toBeLessThanOrEqual(budget)
          expect(choice.midTurn).toBe(!kept.some((message) => message.kind === "user"))
        }
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
