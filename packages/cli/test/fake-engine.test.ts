import { describe, expect, test } from "bun:test"
import type { NewEvent, StoredEvent } from "@light-harness/core"
import { loopViolations } from "../../core/test/scenarios/loop-rules.ts"
import { fold } from "@light-harness/core/testing/scenarios"
import { findScenario } from "../src/demo/scenarios.ts"
import type { EngineEvent } from "../src/engine.ts"
import { FakeEngine, scriptTurns } from "../src/fake-engine.ts"

const durable = (item: EngineEvent): item is StoredEvent => "seq" in item
const strip = (item: StoredEvent): NewEvent => ({ type: item.type, v: item.v, data: item.data }) as NewEvent

/** Plays the first turn of a scenario at high speed and interrupts at the first event `when` matches. */
async function interruptAt(name: string, when: (item: EngineEvent) => boolean) {
  const engine = new FakeEngine(findScenario(name)!.scenario, { speed: 20, graceMs: 100 })
  const session = await engine.open({ session: { kind: "new" }, cwd: "/repo", model: null, effort: null, maxSteps: null })
  const seen: EngineEvent[] = []
  await session.send("")
  let interrupted = false
  for await (const item of session.events) {
    seen.push(item)
    if (!interrupted && when(item)) {
      interrupted = true
      session.interrupt()
    }
    if (item.type === "execution.interrupted" || item.type === "execution.succeeded" || item.type === "execution.failed") break
  }
  await session.close()
  return seen
}

describe("the fake engine's cancel sequence", () => {
  const cases: [string, string, (item: EngineEvent) => boolean, string[]][] = [
    ["while text streams", "a-plain-answer", (item) => item.type === "text.delta", ["execution.interrupt_requested", "text.ended", "step.failed", "synthetic.appended", "execution.interrupted"]],
    [
      "after the first call is recorded, before any starts",
      "two-parallel-tool-calls",
      (item) => item.type === "tool.called",
      ["tool.called", "execution.interrupt_requested", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"],
    ],
    ["while a command runs", "a-long-build-command", (item) => item.type === "tool.progress", ["execution.interrupt_requested", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"]],
    ["while waiting to retry", "a-retryable-failure-before-any-output", (item) => item.type === "retry.scheduled", ["retry.scheduled", "execution.interrupt_requested", "step.failed", "synthetic.appended", "execution.interrupted"]],
    ["between steps", "one-tool-call-then-an-answer", (item) => item.type === "step.ended", ["step.ended", "execution.interrupt_requested", "synthetic.appended", "execution.interrupted"]],
  ]
  for (const [label, name, when, tail] of cases) {
    test(`${label}: a log the reducer accepts, ending the way the cancel scenarios do`, async () => {
      const events = (await interruptAt(name, when)).filter(durable)
      const types = events.map((item) => item.type)
      expect(types.slice(-tail.length)).toEqual(tail as never)
      expect(events.map((item) => item.seq)).toEqual(events.map((_, index) => index + 1))
      const state = fold(null, events.map(strip))
      expect(state.session.execution).toBeNull()
      expect(state.session.open).toBeNull()
      expect(loopViolations(events.map(strip))).toEqual([])
    })
  }

  test("partial text is kept and a running command is settled as stopped with its output so far", async () => {
    const text = (await interruptAt("a-plain-answer", (item) => item.type === "text.delta")).filter(durable)
    const partial = text.find((item) => item.type === "text.ended")
    expect(partial?.type === "text.ended" && "It is a coding-agent harness.".startsWith(partial.data.text) && partial.data.text !== "").toBe(true)

    const shell = (await interruptAt("a-long-build-command", (item) => item.type === "tool.progress")).filter(durable)
    const settled = shell.find((item) => item.type === "tool.settled")
    expect(settled?.type === "tool.settled" && settled.data.outcome).toBe("error")
    expect(settled?.type === "tool.settled" && settled.data.output).toMatch(/^Stopped by the user after \d+ s\. Output so far:\n\$ tsc/)
  })
})

describe("scriptTurns", () => {
  test("splits a scenario where the session goes idle and keeps the prompts", () => {
    const script = scriptTurns(findScenario("a-content-policy-refusal")!.scenario)
    expect(script.preamble.map((item) => item.type)).toEqual(["session.created"])
    expect(script.turns.map((turn) => turn.prompt)).toEqual(["Summarise a.ts.", "Now do the thing the filter dislikes.", "What does a.ts export?"])
  })

  test("a turn with no prompt of its own (work restarting for a pending steer) has none", () => {
    expect(scriptTurns(findScenario("a-pending-steer-survives-an-interrupt")!.scenario).turns.map((turn) => turn.prompt)).toEqual(["Fix the failing test.", null])
  })

  test("a script that stops with the execution open is closed as a shutdown", () => {
    const turns = scriptTurns(findScenario("the-process-dies-after-a-tool-finished-but-before-its-result-was-written")!.scenario).turns
    expect(turns.at(-1)?.events.at(-1)?.event).toMatchObject({ type: "execution.interrupted", data: { reason: "shutdown" } })
  })
})
