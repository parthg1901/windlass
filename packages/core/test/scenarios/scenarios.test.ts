/**
 * Folds every step-loop scenario through the real reducer, checks what a UI
 * and the model would see after each phase, and checks that the reducer
 * rejects every wrong move listed with a phase. See docs/step-loop-scenarios.md.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { NewEvent } from "../../src/event/durable.ts"
import type { Projection } from "../../src/message/message.ts"
import { ReduceError, reduce } from "../../src/message/reducer.ts"
import { families } from "./index.ts"
import { SCENARIOS_END, SCENARIOS_START, renderScenarios } from "./render.ts"
import { type Expect, allEvents, fold, historyIds, openLabel, position, view } from "./script.ts"

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
          }
        })

        const rejections = scenario.phases.flatMap((phase, index) =>
          (phase.rejects ?? []).map((rejection) => ({
            ...rejection,
            label: phase.label,
            prefix: scenario.phases.slice(0, index + 1).flatMap((earlier) => earlier.events),
          })),
        )
        for (const rejection of rejections)
          test(`after "${rejection.label}" the reducer rejects ${rejection.event.type}: ${rejection.why}`, () => {
            expect(attempt(fold(null, rejection.prefix), rejection.event)).toBe(rejection.code)
          })

        test("settles every recorded call exactly once", () => {
          expect(settlements(allEvents(scenario))).toEqual({ unsettled: [], twice: [] })
        })
      })
    }
  })
}

describe("docs/step-loop-scenarios.md", () => {
  test("its scenario section is what the scenario modules render (bun scripts/scenario-doc.ts --write)", async () => {
    const document = await Bun.file(join(import.meta.dir, "../../../../docs/step-loop-scenarios.md")).text()
    const start = document.indexOf(SCENARIOS_START)
    const end = document.indexOf(SCENARIOS_END)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(document.slice(start + SCENARIOS_START.length, end).trim()).toBe(renderScenarios())
  })
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
        : {
            status: state.session.execution.status,
            crashResumes: state.session.execution.crashResumes,
            interrupting: state.session.execution.interrupting,
          },
      label,
    ).toEqual(expected.execution === null ? null : { interrupting: null, ...expected.execution })
  if (expected.open !== undefined) expect(openLabel(state), label).toBe(expected.open)
  if (expected.inbox !== undefined) expect(state.inbox.map((item) => item.messageId as string), label).toEqual([...expected.inbox])
  if (expected.undoable !== undefined) expect(state.session.reverts.length, label).toBe(expected.undoable)
  if (expected.archived !== undefined) expect(state.session.archived, label).toBe(expected.archived)
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
