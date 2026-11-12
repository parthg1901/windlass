/**
 * `getProjection` reads only the rows that changed since it last read the
 * session (`message.changed_seq`; see the head of `store/sqlite.ts`). What
 * it returns must be exactly what reading every row returns, at every
 * point of every log, whichever events came between two reads: a message
 * that grows, a range that is excluded and put back, a compaction, an
 * inbox item that comes and goes, a baseline that is set again.
 *
 * Every step-loop scenario that starts a history of its own is appended
 * event by event to a database file. After each event the writer's
 * `getProjection` (which by then holds rows from earlier reads) is compared
 * with a connection opened just for that read, which has read nothing
 * before and so reads every row, and with the rebuild from the log.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NewEvent } from "../../src/event/durable.ts"
import { reduceAll } from "../../src/message/reducer.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { SESSION, families } from "../scenarios/index.ts"

const directory = mkdtempSync(join(tmpdir(), "wl-projection-read-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const scenarios = Object.values(families)
  .flat()
  .map((scenario) => ({ title: scenario.title, events: scenario.phases.flatMap((phase) => phase.events) }))
  // A fork's log begins with its parent's events, which belong to another session's rows.
  .filter(({ events }) => events[0]?.type === "session.created" && events.filter((item) => item.type === "session.created").length === 1)

describe("getProjection reads the rows that changed and returns what every row says", () => {
  test("the scenarios cover what changes a row after it was written", () => {
    const types = new Set<string>(scenarios.flatMap(({ events }) => events.map((item) => item.type)))
    for (const type of ["history.reverted", "history.restored", "step.refused", "compaction.ended", "inbox.cancelled", "baseline.set", "tool.settled", "settings.changed"]) expect(types).toContain(type)
    expect(scenarios.length).toBeGreaterThan(80)
  })

  test(
    "after every event of every scenario, read every other event and read at every event",
    () => {
      let compared = 0
      for (const [index, scenario] of scenarios.entries()) {
        // Reading after every append, and reading only now and then (several appends between two reads).
        for (const every of [1, 3]) {
          const path = join(directory, `scenario-${index}-${every}.db`)
          const store = openSqliteStore({ path, now: () => 1_800_000_000_000 })
          try {
            const fresh = () => {
              const reader = openSqliteStore({ path, readOnly: true })
              try {
                return reader.getProjection(SESSION)
              } finally {
                reader.close()
              }
            }
            for (const [position, item] of scenario.events.entries()) {
              store.append(SESSION, [item as NewEvent])
              if ((position + 1) % every !== 0 && position !== scenario.events.length - 1) continue
              const read = store.getProjection(SESSION)
              expect(read).toStrictEqual(fresh())
              expect(read).toStrictEqual(reduceAll(store.readEvents(SESSION)))
              // Asked again with nothing appended, it is the very same state.
              expect(store.getProjection(SESSION)).toBe(read)
              compared += 1
            }
          } catch (error) {
            throw new Error(`scenario "${scenario.title}" (read every ${every}): ${error instanceof Error ? error.message : String(error)}`, { cause: error })
          } finally {
            store.close()
          }
        }
      }
      expect(compared).toBeGreaterThan(1000)
    },
    { timeout: 300_000 },
  )

  test("a reader beside the writer brings its rows up to date across the writer's appends", () => {
    const scenario = scenarios.find(({ events }) => events.some((item) => item.type === "history.reverted"))!
    const path = join(directory, "beside.db")
    const store = openSqliteStore({ path, now: () => 1_800_000_000_000 })
    const reader = openSqliteStore({ path, readOnly: true })
    try {
      for (const item of scenario.events) {
        store.append(SESSION, [item as NewEvent])
        expect(reader.getProjection(SESSION)).toStrictEqual(store.getProjection(SESSION))
      }
      expect(reader.getProjection(SESSION)).toStrictEqual(reduceAll(store.readEvents(SESSION)))
    } finally {
      reader.close()
      store.close()
    }
  })

  test("a fork's inherited rows are read in full, and its own changes on top of them", () => {
    const parentEvents = scenarios.find(({ title }) => title === "A plain question and answer") ?? scenarios[0]!
    const path = join(directory, "fork.db")
    const store = openSqliteStore({ path, now: () => 1_800_000_000_000 })
    try {
      for (const item of parentEvents.events) store.append(SESSION, [item as NewEvent])
      const through = store.getProjection(SESSION)!.lastSeq
      const fork = "ses_fork" as typeof SESSION
      const settings = store.getProjection(SESSION)!.session.settings
      store.append(fork, [{ type: "session.created", v: 1, data: { cwd: "/repo", title: null, lineage: { kind: "fork", parentSessionId: SESSION, throughSeq: through }, settings } } as NewEvent])
      const first = store.getProjection(fork)!
      expect(first.messages).toStrictEqual(store.getProjection(SESSION)!.messages)
      store.append(fork, [{ type: "session.renamed", v: 1, data: { title: "A fork" } } as NewEvent])
      const second = store.getProjection(fork)!
      expect(second.session.title).toBe("A fork")
      // Nothing about the messages changed: the rows already read stand.
      expect(second.messages).toBe(first.messages)
      expect(second).toStrictEqual(reduceAll(store.readEvents(fork))!)
    } finally {
      store.close()
    }
  })
})
