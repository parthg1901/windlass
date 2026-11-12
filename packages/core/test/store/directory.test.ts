/**
 * The session directory: one database per session, held by one writer at a
 * time; a listing that never trusts its cache; forks that read their parent
 * from another file; blobs that sessions share. Everything here runs in one
 * process; `directory-process.test.ts` does the same across processes.
 */
import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { event } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { INDEX_FILE, LEGACY_BACKUP_PREFIX, LEGACY_DATABASE, RACY_MS, SessionInUseError, openSessionDirectory } from "../../src/store/directory.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { StoreError } from "../../src/store/store.ts"
import { expectRebuildEqualsLive } from "./consistency.ts"
import { Driver, baselineSet, created, enqueue, exchange, forked } from "./scripted.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function dataDir() {
  const directory = mkdtempSync(join(tmpdir(), "lh-directory-"))
  directories.push(directory)
  return directory
}

const sid = (value: string) => value as SessionId
const codeOf = (work: () => unknown) => {
  try {
    work()
    return "no error"
  } catch (error) {
    return error instanceof StoreError ? error.code : `not a StoreError: ${String(error)}`
  }
}

/** A directory whose clock the test moves, so `updatedAt` orders sessions without sleeping. */
function open(dir = dataDir()) {
  const clock = { now: 1_000 }
  const directory = openSessionDirectory({ dataDir: dir, now: () => (clock.now += 10), notice: () => {} })
  /** Creates a session with one turn and lets go of it. */
  const session = (id: string, cwd = "/work/demo", title: string | null = null) => {
    const store = directory.create(sid(id))
    const driver = new Driver(store, sid(id))
    driver.add(created(cwd, title), baselineSet())
    exchange(driver, "1", "What is this?", `This is ${id}.`)
    store.close()
    return sid(id)
  }
  return { dir, directory, session, clock }
}

const listed = (directory: ReturnType<typeof open>["directory"], query?: Parameters<ReturnType<typeof open>["directory"]["list"]>[0]) =>
  directory.list(query).map((summary) => summary.session.id as string)

/** Makes every session file look old, so the cache is trusted for unchanged ones (see `RACY_MS`). */
function age(dir: string) {
  const sessions = join(dir, "sessions")
  const past = new Date(Date.now() - 10 * RACY_MS)
  for (const name of readdirSync(sessions)) if (/\.db(-wal)?$/.test(name)) utimesSync(join(sessions, name), past, past)
}

/** How often a listing had to read a session file, counted through the cache's rows that it rewrote. */
function indexRows(dir: string) {
  const database = new Database(join(dir, INDEX_FILE), { readonly: true })
  try {
    return database.query<{ id: string; last_seq: number; checked_at: number; signature: string }, []>("SELECT id, last_seq, checked_at, signature FROM session_index ORDER BY id").all()
  } finally {
    database.close()
  }
}

describe("one file per session", () => {
  test("a session is a file of its own, with the store's guarantees per file", () => {
    const { dir, directory, session } = open()
    const a = session("ses_a")
    const b = session("ses_b", "/work/other")
    expect(readdirSync(join(dir, "sessions")).filter((name) => name.endsWith(".db")).sort()).toEqual(["ses_a.db", "ses_b.db"])
    expect(directory.pathOf(a)).toBe(join(dir, "sessions", "ses_a.db"))
    for (const id of [a, b]) {
      const store = directory.open(id)
      // Dense seq from 1, and the rows equal the fold of the log.
      const rebuilt = expectRebuildEqualsLive(store, id)
      expect(rebuilt.lastSeq).toBe(store.readEvents(id).length)
      // Only this session is in the file.
      expect(store.database.query("SELECT id FROM session").all()).toEqual([{ id }])
      store.close()
    }
    directory.close()
  })

  test("a session held here cannot be opened a second time; closing its store lets go of it", () => {
    const { directory, session } = open()
    const id = session("ses_a")
    const store = directory.open(id)
    const again = (() => {
      try {
        return directory.open(id)
      } catch (error) {
        return error
      }
    })()
    expect(again).toBeInstanceOf(SessionInUseError)
    expect(again).toMatchObject({ code: "locked", sessionId: id, holderPid: process.pid })
    expect((again as Error).message).toBe("session ses_a is in use by this process: close it there first, or start a new session")
    // Another directory on the same data (another part of the same process) is refused by the file's own lock.
    const other = openSessionDirectory({ dataDir: directory.dataDir, notice: () => {} })
    expect(codeOf(() => other.open(id))).toBe("locked")
    store.close()
    other.open(id).close()
    directory.open(id).close()
    other.close()
    directory.close()
  })

  test("unknown sessions, and names that are not session IDs", () => {
    const { directory, session } = open()
    session("ses_a")
    expect(codeOf(() => directory.open(sid("ses_missing")))).toBe("session_not_found")
    expect(directory.get(sid("ses_missing"))).toBeNull()
    expect(codeOf(() => directory.read(sid("ses_missing"), () => null))).toBe("session_not_found")
    // A session ID becomes a file name, so it cannot be a path.
    expect(codeOf(() => directory.open(sid("../escape")))).toBe("session_not_found")
    expect(codeOf(() => directory.create(sid("a/b")))).toBe("session_not_found")
    expect(codeOf(() => directory.create(sid("ses_a")))).toBe("locked")
    directory.close()
  })

  test("reading never takes the writer's place, and shows what is committed", () => {
    const { directory, session } = open()
    const id = session("ses_a")
    const writer = directory.open(id)
    const other = openSessionDirectory({ dataDir: directory.dataDir, notice: () => {} })
    const before = other.get(id)!.lastSeq
    writer.append(id, [enqueue("u9", "more")])
    expect(other.get(id)!.lastSeq).toBe(before + 1)
    expect(other.readEvents(id, { afterSeq: before }).map((item) => item.type)).toEqual(["inbox.enqueued"])
    // A reader cannot write.
    expect(codeOf(() => other.read(id, (store) => store.append(id, [enqueue("u10", "no")])))).toBe("read_only")
    expect(writer.getSession(id)!.lastSeq).toBe(before + 1)
    writer.close()
    other.close()
    directory.close()
  })
})

describe("listing", () => {
  test("by directory, most recent first, without archived sessions unless asked", () => {
    const { directory, session } = open()
    session("ses_1", "/work/a")
    session("ses_2", "/work/b")
    session("ses_3", "/work/a")
    expect(listed(directory)).toEqual(["ses_3", "ses_2", "ses_1"])
    expect(listed(directory, { cwd: "/work/a" })).toEqual(["ses_3", "ses_1"])
    expect(listed(directory, { cwd: "/work/a", limit: 1 })).toEqual(["ses_3"])
    expect(listed(directory, { cwd: "/nowhere" })).toEqual([])
    // Using a session makes it the most recent; archiving it hides it.
    const store = directory.open(sid("ses_1"))
    store.append(sid("ses_1"), [enqueue("u2", "again")])
    expect(listed(directory, { cwd: "/work/a" })).toEqual(["ses_1", "ses_3"])
    store.append(sid("ses_1"), [event("session.archived", {})])
    store.close()
    expect(listed(directory)).toEqual(["ses_3", "ses_2"])
    expect(listed(directory, { includeArchived: true })).toEqual(["ses_1", "ses_3", "ses_2"])
    // The summary is the session's own row.
    expect(directory.list({ includeArchived: true })[0]).toEqual(directory.get(sid("ses_1"))!)
    directory.close()
  })

  test("resolves an ID or a unique prefix of one", () => {
    const { directory, session } = open()
    session("ses_abc1")
    session("ses_abd2")
    session("ses_x")
    expect(directory.resolve("ses_abc1")).toBe(sid("ses_abc1"))
    expect(directory.resolve("ses_abc")).toBe(sid("ses_abc1"))
    expect(directory.resolve("ses_x")).toBe(sid("ses_x"))
    expect(codeOf(() => directory.resolve("ses_ab"))).toBe("ambiguous_session")
    expect(codeOf(() => directory.resolve("ses_"))).toBe("ambiguous_session")
    expect(codeOf(() => directory.resolve("nope"))).toBe("session_not_found")
    expect(codeOf(() => directory.resolve(""))).toBe("session_not_found")
    // An exact ID wins over being a prefix of another.
    session("ses_x2")
    expect(directory.resolve("ses_x")).toBe(sid("ses_x"))
    directory.close()
  })

  test("an unchanged session is answered from the cache; a changed one is read again", () => {
    const { dir, directory, session } = open()
    session("ses_a")
    session("ses_b")
    listed(directory)
    age(dir)
    // The first listing after the files settled reads them once more and records that they are settled.
    listed(directory)
    const settled = indexRows(dir)
    expect(listed(directory)).toEqual(["ses_b", "ses_a"])
    // Nothing was read again: the rows are the ones written before.
    expect(indexRows(dir)).toEqual(settled)

    // Another writer (another process would do the same) changes one session.
    const other = openSessionDirectory({ dataDir: dir, notice: () => {} })
    const store = other.open(sid("ses_a"))
    store.append(sid("ses_a"), [enqueue("u2", "more")])
    store.close()
    other.close()
    expect(directory.list().find((summary) => summary.session.id === "ses_a")!.lastSeq).toBe(settled.find((row) => row.id === "ses_a")!.last_seq + 1)
    const after = indexRows(dir)
    expect(after.find((row) => row.id === "ses_b")).toEqual(settled.find((row) => row.id === "ses_b")!)
    expect(after.find((row) => row.id === "ses_a")!.last_seq).toBe(settled.find((row) => row.id === "ses_a")!.last_seq + 1)
    directory.close()
  })

  test("a summary carries the beginning of the user's first prompt, and an unchanged session's comes from the cache", () => {
    const { dir, directory, session } = open()
    session("ses_a")
    session("ses_b")
    // Read from each session's own file, with its summary row.
    expect(directory.get(sid("ses_a"))?.firstPrompt).toBe("What is this?")
    expect(directory.list().map((summary) => summary.firstPrompt)).toEqual(["What is this?", "What is this?"])
    age(dir)
    directory.list()
    const settled = indexRows(dir)
    // The cache's row is what a listing returns while the file is unchanged: no session is opened for it.
    const index = new Database(join(dir, INDEX_FILE))
    index.run("UPDATE session_index SET first_prompt = 'from the cache' WHERE id = 'ses_a'")
    index.close()
    const again = directory.list()
    expect(again.find((summary) => summary.session.id === "ses_a")?.firstPrompt).toBe("from the cache")
    expect(again.find((summary) => summary.session.id === "ses_b")?.firstPrompt).toBe("What is this?")
    expect(indexRows(dir)).toEqual(settled)
    // A session that changed is read again, and its row with it.
    const other = openSessionDirectory({ dataDir: dir, notice: () => {} })
    const store = other.open(sid("ses_a"))
    store.append(sid("ses_a"), [enqueue("u2", "more")])
    store.close()
    other.close()
    expect(directory.list().find((summary) => summary.session.id === "ses_a")?.firstPrompt).toBe("What is this?")
    directory.close()
  })

  test("a session nobody has spoken in has no first prompt; one whose prompt still waits is named by it", () => {
    const { directory } = open()
    const store = directory.create(sid("ses_new"))
    const driver = new Driver(store, sid("ses_new"))
    driver.add(created("/work/demo", null))
    expect(store.getSession(sid("ses_new"))?.firstPrompt).toBeNull()
    driver.add(enqueue("u1", "Rename the module."))
    expect(store.getSession(sid("ses_new"))?.firstPrompt).toBe("Rename the module.")
    store.close()
    directory.close()
  })

  test("a file changed a moment ago is read again whatever its signature says", async () => {
    const { dir, directory, session } = open()
    session("ses_a")
    listed(directory)
    listed(directory)
    const first = indexRows(dir)[0]!
    await Bun.sleep(5)
    // Recently modified: the next listing does not trust the row, although nothing changed, and reads the file again.
    listed(directory)
    const second = indexRows(dir)[0]!
    expect(second.signature).toBe(first.signature)
    expect(second.checked_at).toBeGreaterThan(first.checked_at)
    // Once the file has been quiet for a while the row is trusted and left alone.
    age(dir)
    listed(directory)
    const settled = indexRows(dir)[0]!
    listed(directory)
    expect(indexRows(dir)[0]).toEqual(settled)
    directory.close()
  })

  test("a cache row that lies is corrected, a row without a file dropped, a file without a row found", () => {
    const { dir, directory, session } = open()
    session("ses_a")
    session("ses_b")
    listed(directory)
    directory.close()
    // Tamper with the cache as a bug or a stray tool might: a wrong summary under a stale signature, and a ghost row.
    const index = new Database(join(dir, INDEX_FILE))
    index.run("UPDATE session_index SET cwd = '/wrong', last_seq = 999, signature = 'stale' WHERE id = 'ses_a'")
    index.run("INSERT INTO session_index SELECT 'ses_ghost', cwd, archived, last_seq, time_updated, state, first_prompt, signature, checked_at FROM session_index WHERE id = 'ses_b'")
    index.run("DELETE FROM session_index WHERE id = 'ses_b'")
    index.close()

    const reopened = openSessionDirectory({ dataDir: dir, notice: () => {} })
    const summaries = reopened.list()
    expect(summaries.map((summary) => summary.session.id as string).sort()).toEqual(["ses_a", "ses_b"])
    expect(summaries.find((summary) => summary.session.id === "ses_a")!.session.cwd).toBe("/work/demo")
    expect(summaries.find((summary) => summary.session.id === "ses_a")!.lastSeq).toBe(reopened.get(sid("ses_a"))!.lastSeq)
    expect(indexRows(dir).map((row) => row.id)).toEqual(["ses_a", "ses_b"])
    // A session file that is deleted leaves the listing.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${reopened.pathOf(sid("ses_b"))}${suffix}`, { force: true })
    expect(listed(reopened)).toEqual(["ses_a"])
    expect(indexRows(dir).map((row) => row.id)).toEqual(["ses_a"])
    reopened.close()
  })

  test("the index is rebuilt after it is deleted or corrupted, and a listing never depends on it", () => {
    const { dir, directory, session } = open()
    const ids = ["ses_a", "ses_b", "ses_c"].map((id) => session(id))
    const truth = listed(directory)
    expect(truth).toEqual(["ses_c", "ses_b", "ses_a"])

    // Deleted while the directory is open.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `${INDEX_FILE}${suffix}`), { force: true })
    expect(listed(directory)).toEqual(truth)
    directory.close()

    // Corrupted on disk: not a database at all.
    for (const suffix of ["-wal", "-shm"]) rmSync(join(dir, `${INDEX_FILE}${suffix}`), { force: true })
    writeFileSync(join(dir, INDEX_FILE), "this is not a database, and it is long enough to have a header ".repeat(40))
    const afterGarbage = openSessionDirectory({ dataDir: dir, notice: () => {} })
    expect(listed(afterGarbage)).toEqual(truth)
    expect(indexRows(dir).map((row) => row.id)).toEqual(ids.map(String).sort())
    afterGarbage.close()

    // From another version of the cache: started again.
    const stale = new Database(join(dir, INDEX_FILE))
    stale.run("PRAGMA user_version = 7")
    stale.run("DROP TABLE session_index")
    stale.close()
    const afterStale = openSessionDirectory({ dataDir: dir, notice: () => {} })
    expect(listed(afterStale)).toEqual(truth)

    // Asked for explicitly.
    afterStale.rebuildIndex()
    expect(indexRows(dir).map((row) => row.id)).toEqual(ids.map(String).sort())
    expect(listed(afterStale)).toEqual(truth)

    // Unusable altogether (a directory sits where the file should be): the listing is computed from the files.
    afterStale.close()
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `${INDEX_FILE}${suffix}`), { force: true })
    mkdirSync(join(dir, INDEX_FILE))
    const withoutIndex = openSessionDirectory({ dataDir: dir, notice: () => {} })
    expect(listed(withoutIndex)).toEqual(truth)
    expect(listed(withoutIndex, { cwd: "/work/demo", limit: 2 })).toEqual(truth.slice(0, 2))
    withoutIndex.close()
  })

  test("a file that is not a session of this build is left out, not fatal", () => {
    const { dir, directory, session } = open()
    session("ses_a")
    writeFileSync(join(dir, "sessions", "ses_garbage.db"), "not a database")
    const foreign = new Database(join(dir, "sessions", "ses_foreign.db"), { create: true })
    foreign.run("PRAGMA user_version = 1")
    foreign.run("CREATE TABLE something (x)")
    foreign.close()
    // Created and never given its first event.
    directory.create(sid("ses_empty")).close()
    expect(listed(directory)).toEqual(["ses_a"])
    expect(directory.get(sid("ses_empty"))).toBeNull()
    expect(codeOf(() => directory.open(sid("ses_empty")))).toBe("session_not_found")
    expect(codeOf(() => directory.open(sid("ses_foreign")))).toBe("schema_mismatch")
    directory.close()
  })
})

describe("forks", () => {
  /** A parent with two turns, forked after the first. Each session is its own file. */
  function family() {
    const { dir, directory } = open()
    const parentStore = directory.create(sid("ses_parent"))
    const parent = new Driver(parentStore, sid("ses_parent"))
    parent.add(created(), baselineSet())
    exchange(parent, "1", "Sketch a plan.", "1. Routes 2. Handlers")
    const forkPoint = parent.lastSeq
    exchange(parent, "2", "Do step 1.", "Routes added.")
    return { dir, directory, parentStore, parent, forkPoint }
  }

  test("a fork reads its parent's log through the fork point from the parent's file, which someone else is writing", () => {
    const { directory, parentStore, parent, forkPoint } = family()
    // The parent stays open for writing (here; another process is the same) while the fork is created and used.
    const childStore = directory.create(sid("ses_child"))
    const child = new Driver(childStore, sid("ses_child"))
    child.add(forked(parent.id, forkPoint))
    exchange(child, "2", "Do step 2 first.", "Handlers written.")
    exchange(parent, "3", "Do step 3.", "Tests added.")

    const events = childStore.readEvents(child.id)
    expect(events.map((item) => item.seq)).toEqual(events.map((_, index) => index + 1))
    expect(events.slice(0, forkPoint)).toEqual([...parentStore.readEvents(parent.id, { limit: forkPoint })])
    expect(events.slice(0, forkPoint).every((item) => item.sessionId === parent.id)).toBe(true)
    expect(events.slice(forkPoint).every((item) => item.sessionId === child.id)).toBe(true)
    // Nothing the parent did after the fork point is in the fork, however far the parent has gone since.
    expect(JSON.stringify(events)).not.toContain("Routes added.")
    expect(JSON.stringify(events)).not.toContain("Tests added.")
    // The fork's rows equal the fold of its effective log, and it owns only its own events.
    expectRebuildEqualsLive(childStore, child.id)
    expect(childStore.database.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()!.n).toBe(events.length - forkPoint)
    // Ranges across the seam.
    expect(childStore.readEvents(child.id, { afterSeq: forkPoint - 2, limit: 4 }).map((item) => item.seq)).toEqual([forkPoint - 1, forkPoint, forkPoint + 1, forkPoint + 2])
    expect(childStore.readEvents(child.id, { afterSeq: forkPoint }).every((item) => item.sessionId === child.id)).toBe(true)
    // Without holding either session.
    expect(directory.readEvents(child.id)).toEqual(events)

    // A fork of the fork: its log runs through three files.
    const grandStore = directory.create(sid("ses_grandchild"))
    new Driver(grandStore, sid("ses_grandchild")).add(forked(child.id, child.lastSeq), enqueue("u9", "later", "queue"))
    expectRebuildEqualsLive(grandStore, sid("ses_grandchild"))
    const whole = grandStore.readEvents(sid("ses_grandchild"))
    expect(whole.slice(0, events.length)).toEqual([...events])
    expect([...new Set(whole.map((item) => item.sessionId as string))]).toEqual(["ses_parent", "ses_child", "ses_grandchild"])
    expect(grandStore.readEvents(sid("ses_grandchild"), { afterSeq: forkPoint - 1, limit: 3 }).map((item) => item.sessionId as string)).toEqual(["ses_parent", "ses_child", "ses_child"])
    for (const store of [grandStore, childStore, parentStore]) store.close()
    // All three are listed, each from its own file.
    expect(listed(directory).sort()).toEqual(["ses_child", "ses_grandchild", "ses_parent"])
    directory.close()
  })

  test("a fork point must exist in the parent and be a step boundary; a parent that cannot be found is said so", () => {
    const { directory, parentStore, parent } = family()
    const tooFar = directory.create(sid("ses_far"))
    expect(() => tooFar.append(sid("ses_far"), [forked(parent.id, parent.lastSeq + 5)])).toThrow()
    tooFar.close()
    const orphan = directory.create(sid("ses_orphan"))
    expect(codeOf(() => orphan.append(sid("ses_orphan"), [forked(sid("ses_nobody"), 3)]))).toBe("parent_missing")
    orphan.close()
    // Neither became a session.
    expect(listed(directory)).toEqual(["ses_parent"])
    parentStore.close()
    directory.close()
  })

  test("a fork whose parent file is gone still opens, runs and lists; only its inherited events cannot be read", () => {
    const { directory, parentStore, parent, forkPoint } = family()
    const childStore = directory.create(sid("ses_child"))
    const child = new Driver(childStore, sid("ses_child"))
    child.add(forked(parent.id, forkPoint))
    exchange(child, "2", "Do step 2 first.", "Handlers written.")
    const before = childStore.getProjection(child.id)!
    childStore.close()
    parentStore.close()
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${directory.pathOf(parent.id)}${suffix}`, { force: true })

    expect(listed(directory)).toEqual(["ses_child"])
    const reopened = directory.open(child.id)
    // Its state is its own rows: the inherited messages were copied when it was created.
    expect(reopened.getProjection(child.id)).toEqual(before)
    expect(reopened.readModelHistory(child.id).messages.map((message) => message.id as string)).toEqual(["u1", "a1", "u2", "a2"])
    exchange(new Driver(reopened, child.id), "3", "And step 3.", "Done.")
    // Its own events read fine; the inherited ones name what is missing.
    expect(reopened.readEvents(child.id, { afterSeq: forkPoint }).length).toBeGreaterThan(0)
    const failure = (() => {
      try {
        return reopened.readEvents(child.id)
      } catch (error) {
        return error
      }
    })()
    expect(failure).toBeInstanceOf(StoreError)
    expect(failure).toMatchObject({ code: "parent_missing" })
    expect((failure as Error).message).toContain("ses_parent")
    expect(codeOf(() => directory.readEvents(child.id))).toBe("parent_missing")
    reopened.close()
    directory.close()
  })
})

describe("what sessions share", () => {
  test("blobs are files named by content: stored once, read by any session, first media type wins", () => {
    const { dir, directory, session } = open()
    const a = directory.open(session("ses_a"))
    const b = directory.open(session("ses_b"))
    const bytes = new TextEncoder().encode("synthetic image bytes")
    const ref = a.putBlob(bytes, "image/png")
    expect(ref.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.putBlob(new Uint8Array(bytes), "image/webp")).toEqual(ref)
    expect(b.getBlob(ref.hash)).toEqual({ hash: ref.hash, mediaType: "image/png", bytes })
    expect(directory.getBlob(ref.hash)).toEqual({ hash: ref.hash, mediaType: "image/png", bytes })
    expect(directory.getBlob("0".repeat(64))).toBeNull()
    expect(directory.getBlob("../../etc/passwd")).toBeNull()
    // Bytes that contain line breaks survive: the media type line is the first line only.
    const tricky = directory.putBlob(new Uint8Array([10, 13, 10, 0, 255]), "application/octet-stream")
    expect([...directory.getBlob(tricky.hash)!.bytes]).toEqual([10, 13, 10, 0, 255])
    expect(() => directory.putBlob(bytes, "")).toThrow()
    expect(() => directory.putBlob(bytes, "image/png\nx")).toThrow()
    // One file per blob, no temporary file left behind, nothing in the session databases.
    const files = readdirSync(join(dir, "blobs"), { recursive: true }).filter((name) => statSync(join(dir, "blobs", String(name))).isFile())
    expect(files).toHaveLength(2)
    expect(a.database.query("SELECT name FROM sqlite_master WHERE name = 'blob'").all()).toEqual([])
    a.close()
    b.close()
    directory.close()
  })

  test("the old single database is moved aside once, said once, and never converted", () => {
    const dir = dataDir()
    const legacy = openSqliteStore({ path: join(dir, LEGACY_DATABASE) })
    legacy.append(sid("ses_old"), [created()])
    legacy.close()
    writeFileSync(join(dir, `${LEGACY_DATABASE}-lock`), "")
    const notices: string[] = []
    const directory = openSessionDirectory({ dataDir: dir, notice: (line) => notices.push(line) })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("was not converted")
    const backups = readdirSync(dir).filter((name) => name.startsWith(LEGACY_BACKUP_PREFIX))
    expect(backups).toHaveLength(1)
    expect(notices[0]).toContain(join(dir, backups[0]!))
    // The database and what belonged to it (its lock, the record of its last holder).
    expect(readdirSync(join(dir, backups[0]!)).sort()).toEqual([LEGACY_DATABASE, `${LEGACY_DATABASE}-holder`, `${LEGACY_DATABASE}-lock`])
    expect(existsSync(join(dir, LEGACY_DATABASE))).toBe(false)
    expect(listed(directory)).toEqual([])
    directory.close()
    // The backup still opens as what it was.
    const backup = openSqliteStore({ path: join(dir, backups[0]!, LEGACY_DATABASE) })
    expect(backup.getSession(sid("ses_old"))).not.toBeNull()
    backup.close()
    // The next start finds nothing to move and says nothing.
    openSessionDirectory({ dataDir: dir, notice: (line) => notices.push(line) }).close()
    expect(notices).toHaveLength(1)
    expect(readdirSync(dir).filter((name) => name.startsWith(LEGACY_BACKUP_PREFIX))).toHaveLength(1)
  })
})
