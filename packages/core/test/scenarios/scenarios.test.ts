/**
 * Folds every step-loop scenario through the real reducer and checks what a UI
 * and the model would see after each phase. See docs/step-loop-scenarios.md.
 */
import { describe, expect, test } from "bun:test"
import type { NewEvent } from "../../src/event/durable.ts"
import type { Projection } from "../../src/message/message.ts"
import { ReduceError, reduce } from "../../src/message/reducer.ts"
import { families, todoScenarios } from "./index.ts"
import { loopViolations } from "./loop-rules.ts"
import { type Expect, allEvents, fold, historyIds, position, view } from "./script.ts"

for (const [family, scenarios] of Object.entries(families)) {
  describe(family, () => {
    for (const scenario of scenarios) {
      describe(scenario.title, () => {
        test("folds through the reducer with the expected state after each phase", () => {
          const last = scenario.phases.at(-1)
          expect(last?.expect).toBeDefined()
          let state: Projection | null = null
          for (const phase of scenario.phases) {
            state = fold(state, phase.events)
            if (phase.expect !== undefined) check(state, phase.expect, phase.label)
            for (const rejection of phase.rejects ?? [])
              expect(attempt(state, rejection.event), `${phase.label}: ${rejection.why}`).toBe(rejection.code)
          }
        })

        test("follows the loop's ordering rules", () => {
          expect(loopViolations(allEvents(scenario))).toEqual([])
          expect(settlements(allEvents(scenario))).toEqual({ unsettled: [], twice: [] })
        })

        const probes = scenario.phases.flatMap((phase, index) =>
          (phase.gaps ?? []).map((probe) => ({ ...probe, prefix: scenario.phases.slice(0, index + 1).flatMap((p) => p.events) })),
        )
        for (const probe of probes)
          test(`${probe.gap} is still open: the reducer accepts ${probe.event.type} (${probe.why})`, () => {
            // When this fails the reducer has closed the gap: move the probe to `rejects`.
            expect(attempt(fold(null, probe.prefix), probe.event)).toBe("accepted")
            expect(loopViolations([...probe.prefix, probe.event]).length).toBeGreaterThan(0)
          })
      })
    }
  })
}

describe("not expressible today", () => {
  for (const todo of todoScenarios) test.todo(`${todo.gap}: ${todo.title}`)
})

function check(state: Projection, expected: Expect, label: string) {
  if (expected.ui !== undefined) {
    const actual = view(state)
    expect(actual.map((message) => message.id), label).toEqual(expected.ui.map((message) => message.id!))
    expect(actual, label).toMatchObject(expected.ui)
  }
  if (expected.history !== undefined) expect(historyIds(state), label).toEqual([...expected.history])
  if (expected.execution !== undefined)
    expect(
      state.session.execution === null
        ? null
        : { status: state.session.execution.status, resumes: state.session.execution.resumes },
      label,
    ).toEqual(expected.execution)
  if (expected.open !== undefined) expect((state.session.open?.messageId as string | undefined) ?? null, label).toBe(expected.open)
  if (expected.inbox !== undefined) expect(state.inbox.map((item) => item.messageId as string), label).toEqual([...expected.inbox])
}

function attempt(state: Projection, item: NewEvent) {
  try {
    reduce(state, position(state, item))
  } catch (error) {
    if (error instanceof ReduceError) return error.code
    throw error
  }
  return "accepted"
}

/** Every recorded call is settled exactly once by the end of the scenario. */
function settlements(events: readonly NewEvent[]) {
  const key = (data: { messageId: string; callId: string }) => `${data.messageId}/${data.callId}`
  const calls = events.flatMap((item) => (item.type === "tool.called" ? [key(item.data)] : []))
  const settles = events.flatMap((item) => (item.type === "tool.settled" ? [key(item.data)] : []))
  return {
    unsettled: calls.filter((call) => !settles.includes(call)),
    twice: settles.filter((call, index) => settles.indexOf(call) !== index),
  }
}
