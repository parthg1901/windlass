/**
 * The loop's ordering rules are enforced by the reducer now, so there is no
 * separate checker: a loop test folds the events its loop wrote, and an event
 * that breaks a rule is a `ReduceError`.
 *
 * `loopViolations` remains for callers that expect a list: it folds the events
 * and returns the first rejection, or nothing.
 */
import type { NewEvent } from "../../src/event/durable.ts"
import { ReduceError } from "../../src/message/reducer.ts"
import { fold } from "./script.ts"

export function loopViolations(events: readonly NewEvent[]): string[] {
  try {
    fold(null, events)
  } catch (error) {
    if (error instanceof ReduceError) return [error.message]
    throw error
  }
  return []
}
