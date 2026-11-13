/**
 * The crash test's kills, made deterministic. An append is one transaction,
 * so a writer killed at any moment leaves the log as it was after some
 * number of appends. Every such point of every scripted session is visited
 * here, and the step loop's recovery must turn what is left into a legal log.
 */
import { describe, expect, test } from "bun:test"
import { recover } from "../../src/engine/recovery.ts"
import type { MessageId, SessionId } from "../../src/id.ts"
import { ReduceError, reduceAll } from "../../src/message/reducer.ts"
import { type SqliteStore, openSqliteStore } from "../../src/store/sqlite.ts"
import { expectRebuildEqualsLive, expectStoreConsistent } from "./consistency.ts"
import { recoverClaimedSessions } from "./recovery.ts"
import {
  SCRIPTS,
  baselineSet,
  created,
  deliver,
  enqueue,
  executionStarted,
  stepEnded,
  stepStarted,
  textEnded,
  turnEnded,
} from "./scripted.ts"

class Killed extends Error {}

/** The store, until `appends` appends have been made; the next one is where the writer dies. */
function dyingAfter(store: SqliteStore, appends: number): SqliteStore {
  let made = 0
  const append: SqliteStore["append"] = (...args) => {
    if (made++ >= appends) throw new Killed()
    return store.append(...args)
  }
  return new Proxy(store, { get: (target, key) => (key === "append" ? append : Reflect.get(target, key, target)) })
}

/** Runs `script` against a fresh store until the writer dies after `appends` appends. */
function killedAt(script: (typeof SCRIPTS)[string], appends: number): SqliteStore {
  const store = openSqliteStore({ path: ":memory:" })
  try {
    script(dyingAfter(store, appends), "k")
  } catch (error) {
    if (!(error instanceof Killed)) throw error
  }
  return store
}

/** How many appends `script` makes when nobody kills it. */
function appendsOf(script: (typeof SCRIPTS)[string]): number {
  const store = openSqliteStore({ path: ":memory:" })
  let made = 0
  const append: SqliteStore["append"] = (...args) => (made++, store.append(...args))
  script(new Proxy(store, { get: (target, key) => (key === "append" ? append : Reflect.get(target, key, target)) }), "k")
  store.close()
  return made
}

/** Recovers every claimed session as the engine does at start-up, resuming it while the cap allows. */
function recoverResuming(store: SqliteStore) {
  for (const summary of store.listClaimedSessions()) {
    let next = 0
    const recovery = recover(store.getProjection(summary.session.id)!, {
      crashResumeCap: 3,
      newMessageId: () => `recovery_${next++}` as MessageId,
    })
    store.append(summary.session.id, recovery.events, { expectedSeq: summary.lastSeq })
  }
}

/** The rebuild of each session from its log equals its stored state; the full, slower comparison says where not. */
function expectRebuildsEqualLive(store: SqliteStore, ids: readonly SessionId[]) {
  for (const id of ids)
    if (!Bun.deepEquals(reduceAll(store.readEvents(id)), store.getProjection(id), true)) expectRebuildEqualsLive(store, id)
}

describe("a writer killed between any two appends", () => {
  for (const [name, script] of Object.entries(SCRIPTS))
    // Each kill point runs the script again from the start: under a second, unless the machine is busy.
    test(`${name}: every kill point recovers to a legal log, given up or resumed`, () => {
      const total = appendsOf(script)
      expect(total).toBeGreaterThan(5)
      for (let appends = 0; appends < total; appends++)
        for (const recovery of [recoverClaimedSessions, recoverResuming]) {
          const store = killedAt(script, appends)
          const claimed = store.listClaimedSessions().map((summary) => summary.session.id)
          try {
            recovery(store)
          } catch (error) {
            throw new Error(`${name}, killed after ${appends} appends, ${recovery.name}: ${(error as Error).message}`)
          }
          expectRebuildsEqualLive(store, claimed)
          if (recovery === recoverClaimedSessions) expect(store.listClaimedSessions()).toEqual([])
          store.close()
        }
    }, 30_000)
})

describe("a turn that ends for a queued item", () => {
  const id = "ses_handover" as SessionId
  function answered() {
    const store = openSqliteStore({ path: ":memory:" })
    for (const next of [
      created(),
      baselineSet(),
      enqueue("u1", "Look at the logs."),
      enqueue("u2", "Then fix the bug.", "queue"),
      executionStarted("exe_1"),
      deliver("u1"),
      stepStarted("a1"),
      textEnded("a1", "The logs are clean."),
      stepEnded("a1"),
    ])
      store.append(id, [next])
    return store
  }

  test("ends in the same append as the queued item's delivery", () => {
    const store = answered()
    store.append(id, [turnEnded(), deliver("u2")])
    expect(store.getProjection(id)!.session.open).toBeNull()
    expectStoreConsistent(store)
    store.close()
  })

  test("is refused on its own, and nothing is written, so no log is left with only the delivery to come", () => {
    const store = answered()
    const before = store.getProjection(id)!.lastSeq
    let error: unknown
    try {
      store.append(id, [turnEnded()])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ReduceError)
    expect((error as ReduceError).code).toBe("invalid_transition")
    expect((error as ReduceError).message).toContain("the turn ended for queued item u2: its delivery is in the same append")
    expect(store.getProjection(id)!.lastSeq).toBe(before)
    expect(store.readEvents(id)).toHaveLength(before)
    // What recovery would face is what the writer left: a step boundary with the item still waiting.
    recoverClaimedSessions(store)
    expectStoreConsistent(store)
    store.close()
  })
})
