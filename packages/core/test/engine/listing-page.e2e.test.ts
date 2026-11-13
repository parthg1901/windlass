/**
 * The session listing a page at a time (`Engine.listSessionsPage`): pages of
 * a given size in the listing's order, a cursor that is a place in that
 * order and so needs nothing kept between two calls, and what happens to the
 * pages when sessions arrive, or are worked in, between two of them.
 *
 * Through the real assembly and the session files (the listing cache
 * included), and through one shared store on a clock that does not move,
 * where every session was updated in the same millisecond and only the ID
 * tells two apart.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../../src/assembly.ts"
import { EngineError } from "../../src/engine/engine.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-listing-page-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  removeHarnessDirectories()
})

const SETTINGS = { model: "gpt-test", reasoningEffort: null }

/** Every page of a listing, by following the cursors. */
function pages<T extends { readonly sessions: readonly { readonly session: { readonly id: string } }[]; readonly nextCursor: string | null }>(page: (cursor: string | null) => T): string[][] {
  const all: string[][] = []
  let cursor: string | null = null
  do {
    const next = page(cursor)
    all.push(next.sessions.map((summary) => summary.session.id))
    cursor = next.nextCursor
  } while (cursor !== null)
  return all
}

describe("the session listing, a page at a time", () => {
  test("pages follow the listing's order, the last one has no cursor, and sessions that arrive or are worked in meanwhile are in no later page twice", async () => {
    const cwd = join(root, "project")
    const elsewhere = join(root, "elsewhere")
    mkdirSync(cwd, { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    const provider = new FakeProvider()
    const harness = createHarness({ dataDir: join(root, "data"), engine: { approval: null, loadConfig: null, discover: () => [] }, provider, log: () => {} })
    try {
      const turn = async (directory: string, text: string) => {
        provider.enqueue([script.text("Answered.")])
        const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
        session.send(text)
        await session.settled()
        await session.close()
        return session.id
      }
      for (let index = 0; index < 7; index += 1) await turn(cwd, `Question ${index}.`)
      await turn(elsewhere, "Somewhere else.")
      const whole = harness.engine.listSessions({ cwd }).map((summary) => summary.session.id)
      expect(whole).toHaveLength(7)

      // Pages of three: 3, 3, 1, in the order of the whole listing, and only the last has no cursor.
      const first = harness.engine.listSessionsPage({ cwd, limit: 3 })
      expect(first.sessions.map((summary) => summary.session.id)).toEqual(whole.slice(0, 3))
      expect(first.nextCursor).not.toBeNull()
      expect(pages((cursor) => harness.engine.listSessionsPage({ cwd, limit: 3, cursor }))).toEqual([whole.slice(0, 3), whole.slice(3, 6), whole.slice(6)])
      // Without a limit it is the whole listing; a page that ends exactly at the end has no cursor either.
      expect(harness.engine.listSessionsPage({ cwd })).toMatchObject({ nextCursor: null })
      expect(harness.engine.listSessionsPage({ cwd }).sessions.map((summary) => summary.session.id)).toEqual(whole)
      expect(harness.engine.listSessionsPage({ cwd, limit: 7 }).nextCursor).toBeNull()
      // The summaries are the listing's own: the first prompt comes with them.
      expect(first.sessions[0]!.firstPrompt).toBe("Question 6.")

      // A session arrives between two pages: it is newer than the cursor, so the later pages are what they were.
      const arrived = await turn(cwd, "A new one.")
      const second = harness.engine.listSessionsPage({ cwd, limit: 3, cursor: first.nextCursor })
      expect(second.sessions.map((summary) => summary.session.id)).toEqual(whole.slice(3, 6))
      expect(harness.engine.listSessionsPage({ cwd, limit: 3 }).sessions[0]!.session.id).toBe(arrived)

      // A session of the last page is worked in: it moves to the front, where a new listing has it, and is not listed twice.
      const moved = whole[6]!
      provider.enqueue([script.text("Again.")])
      const again = harness.engine.openSession(moved)
      again.send("Once more.")
      await again.settled()
      await again.close()
      expect(harness.engine.listSessionsPage({ cwd, limit: 3, cursor: second.nextCursor })).toEqual({ sessions: [], nextCursor: null })
      expect(harness.engine.listSessionsPage({ cwd, limit: 3 }).sessions[0]!.session.id).toBe(moved)

      // The query is the listing's: every directory, archived ones when asked.
      expect(pages((cursor) => harness.engine.listSessionsPage({ limit: 4, cursor })).flat()).toHaveLength(9)
      await harness.engine.archiveSession(arrived)
      expect(pages((cursor) => harness.engine.listSessionsPage({ cwd, limit: 2, cursor })).flat()).not.toContain(arrived)
      expect(pages((cursor) => harness.engine.listSessionsPage({ cwd, limit: 2, cursor, includeArchived: true })).flat()).toContain(arrived)
    } finally {
      await harness.close()
    }
  }, 60_000)

  test("sessions updated in the same millisecond are paged by ID: none twice, none left out", async () => {
    const h = new Harness()
    try {
      // The harness's clock does not move by itself: every session has the same time.
      const ids: string[] = []
      for (let index = 0; index < 5; index += 1) {
        const session = h.engine.createSession({ cwd: "/repo", settings: { model: "gpt-test", reasoningEffort: "medium" } })
        ids.push(session.id)
        await session.close()
      }
      const listed = pages((cursor) => h.engine.listSessionsPage({ limit: 2, cursor }))
      expect(listed.map((page) => page.length)).toEqual([2, 2, 1])
      expect([...listed.flat()].sort()).toEqual([...ids].sort())
      expect(new Set(h.engine.listSessions().map((summary) => summary.updatedAt)).size).toBe(1)
    } finally {
      await h.dispose()
    }
  })

  test("a cursor it did not give and a page of nothing are refused", async () => {
    const h = new Harness()
    try {
      const refused = (work: () => unknown) => {
        try {
          work()
          return "no error"
        } catch (error) {
          return error instanceof EngineError ? `${error.code}: ${error.message}` : String(error)
        }
      }
      expect(refused(() => h.engine.listSessionsPage({ cursor: "3:7" }))).toBe("no error")
      expect(refused(() => h.engine.listSessionsPage({ cursor: "second page" }))).toBe('invalid_request: "second page" is not a cursor of the session listing')
      expect(refused(() => h.engine.listSessionsPage({ limit: 0 }))).toBe("invalid_request: a page holds at least one session: 0 is not a page size")
    } finally {
      await h.dispose()
    }
  })
})
