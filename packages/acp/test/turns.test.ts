import { expect, test } from "bun:test"
import { forkPointOfTurn, isUndone, turnsOf, type TurnEvent } from "../src/turns.ts"

/** A log written by hand: each entry is `[type, data]`, numbered from 1. */
function log(...entries: [string, Record<string, unknown>][]): TurnEvent[] {
  return entries.map(([type, data], index) => ({ seq: index + 1, type, data }))
}
const said = (id: string, text: string): [string, Record<string, unknown>] => ["inbox.enqueued", { messageId: id, origin: null, delivery: "steer", content: [{ type: "text", text }] }]
const delivered = (id: string): [string, Record<string, unknown>] => ["inbox.delivered", { messageId: id }]
const started = (id: string): [string, Record<string, unknown>] => ["execution.started", { executionId: id }]
const ended = (id: string): [string, Record<string, unknown>] => ["execution.succeeded", { executionId: id, verification: { status: "not_configured" } }]

test("each prompt is a turn; a steer is part of its turn; a queued message is a turn of its own", () => {
  const turns = turnsOf(
    log(
      ["session.created", {}],
      said("u1", "first"), started("e1"), delivered("u1"), ["step.started", {}], said("u2", "and also"), delivered("u2"), ended("e1"),
      said("u3", "second"), started("e2"), delivered("u3"), said("u4", "after that"), ["turn.ended", {}], delivered("u4"), ended("e2"),
    ),
  )
  expect(turns.map((turn) => [turn.number, turn.prompt, turn.endSeq])).toEqual([
    [1, "first", 8],
    [2, "second", 13],
    [3, "after that", 15],
  ])
  expect(forkPointOfTurn(turns, 2)).toEqual({ throughSeq: 13 })
  expect(forkPointOfTurn(turns, 4)).toEqual({ problem: "there is no turn 4: the session has turns 1 to 3" })
})

test("an undone turn keeps its number and is marked, until /redo; it cannot be forked at", () => {
  const events = log(said("u1", "one"), started("e1"), delivered("u1"), ended("e1"), said("u2", "two"), started("e2"), delivered("u2"), ended("e2"), ["history.reverted", { fromSeq: 7, restore: null }])
  const undone = turnsOf(events)
  expect(undone.map((turn) => [turn.number, isUndone(turn)])).toEqual([
    [1, false],
    [2, true],
  ])
  expect(forkPointOfTurn(undone, 2)).toEqual({ problem: "turn 2 was undone (/undo); fork after another turn, or /redo it first" })
  const redone = turnsOf([...events, { seq: 10, type: "history.restored", data: { revertSeq: 9, restore: null } }])
  expect(redone.map((turn) => isUndone(turn))).toEqual([false, false])
})

test("a turn cut off by a shutdown and resumed is one turn", () => {
  const turns = turnsOf(log(said("u1", "one"), started("e1"), delivered("u1"), ["execution.interrupted", { executionId: "e1", reason: "shutdown" }], ["execution.resumed", { executionId: "e1" }], ended("e1")))
  expect(turns.map((turn) => [turn.number, turn.prompt, turn.endSeq])).toEqual([[1, "one", 6]])
})
