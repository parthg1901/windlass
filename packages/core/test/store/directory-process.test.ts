/**
 * The session directory across real processes: sessions held one writer at
 * a time, by whoever is alive; listings that stay right while other
 * processes create, write and die; forks of a session another process is
 * writing; blobs stored by several processes at once.
 */
import { Database } from "bun:sqlite"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionId } from "../../src/id.ts"
import { INDEX_FILE, SessionInUseError, openSessionDirectory } from "../../src/store/directory.ts"
import { expectRebuildEqualsLive } from "./consistency.ts"
import { Driver, baselineSet, created, exchange, forked } from "./scripted.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "directory-child.ts")
const directories: string[] = []
const children: Bun.Subprocess[] = []
afterEach(() => {
  // A test that failed or timed out may have left a child running.
  for (const child of children.splice(0)) child.kill("SIGKILL")
})
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function dataDir() {
  const directory = mkdtempSync(join(tmpdir(), "lh-directory-process-"))
  directories.push(directory)
  return directory
}

const sid = (value: string) => value as SessionId

function spawn(...args: string[]) {
  const child = Bun.spawn([process.execPath, FIXTURE, ...args], { stdout: "pipe", stderr: "pipe" })
  children.push(child)
  return child
}

/** Starts the fixture and resolves once it has printed `ready`. */
async function spawnReady(...args: string[]) {
  const child = spawn(...args)
  const reader = child.stdout.getReader()
  let seen = ""
  while (!seen.includes("ready\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`the child exited before it was ready: ${await new Response(child.stderr).text()}`)
    seen += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  return child
}

/** Runs the fixture to its end and returns the JSON it printed last. */
async function run<T>(...args: string[]): Promise<T> {
  const child = spawn(...args)
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`the child failed (${code}): ${errors}`)
  return JSON.parse(output.trim().split("\n").at(-1)!) as T
}

/** A session with one turn, created and let go of by this process. */
function seed(dir: string, id: string, cwd = "/work/demo") {
  const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })
  const store = directory.create(sid(id))
  const driver = new Driver(store, sid(id))
  driver.add(created(cwd), baselineSet())
  exchange(driver, "1", "What is this?", `This is ${id}.`)
  const lastSeq = driver.lastSeq
  store.close()
  directory.close()
  return lastSeq
}

type Listing = { id: string; lastSeq: number; archived: boolean }[]

describe("who holds a session", () => {
  test("a session held by a live process is refused with that process named; once the holder is dead it opens", async () => {
    const dir = dataDir()
    seed(dir, "ses_a")
    seed(dir, "ses_b")
    const holder = await spawnReady("crash", dir, "ses_a")
    const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })

    const refused = (() => {
      try {
        return directory.open(sid("ses_a"))
      } catch (error) {
        return error
      }
    })()
    expect(refused).toBeInstanceOf(SessionInUseError)
    expect(refused).toMatchObject({ code: "locked", sessionId: "ses_a", holderPid: holder.pid })
    expect((refused as Error).message).toBe(`session ses_a is in use by another lh process (pid ${holder.pid}): wait for it to finish or stop it (kill ${holder.pid}), or start a new session`)
    // The same from a third process.
    expect(await run("open", dir, "ses_a")).toMatchObject({ ok: false, name: "SessionInUseError", code: "locked", holderPid: holder.pid })
    // Only that session is held: the other one opens, and the held one can still be read and listed.
    directory.open(sid("ses_b")).close()
    expect(directory.get(sid("ses_a"))!.session.execution).toMatchObject({ id: "exe_crash", status: "running" })
    expect(directory.list().map((summary) => summary.session.id as string).sort()).toEqual(["ses_a", "ses_b"])

    // The holder dies without letting go. The operating system releases its lock with it.
    holder.kill("SIGKILL")
    await holder.exited
    expect(await run("open", dir, "ses_a")).toEqual({ ok: true })
    const store = directory.open(sid("ses_a"))
    // What it left is what a crash leaves: a running claim and an open step, for recovery to settle.
    const left = store.getProjection(sid("ses_a"))!
    expect(left.session.execution).toMatchObject({ id: "exe_crash", status: "running" })
    expect(left.session.open).toMatchObject({ kind: "step", messageId: "a_crash" })
    expectRebuildEqualsLive(store, sid("ses_a"))
    store.close()
    directory.close()
  }, 60_000)
})

describe("listing while other processes work", () => {
  test("sessions created by several processes at once are all listed, by everyone, and none is lost from the index", async () => {
    const dir = dataDir()
    const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })
    const creators = ["p1", "p2", "p3"].map((tag) => run<{ created: number }>("create", dir, tag, "15"))
    // List while they create: a listing shows only sessions that exist, each with a state that was committed.
    const seen = new Set<string>()
    let done = false
    void Promise.all(creators).then(() => (done = true))
    while (!done) {
      for (const summary of directory.list()) {
        seen.add(summary.session.id)
        expect(summary.lastSeq).toBeGreaterThanOrEqual(1)
      }
      await Bun.sleep(5)
    }
    expect((await Promise.all(creators)).map((result) => result.created)).toEqual([15, 15, 15])

    const expected = ["p1", "p2", "p3"].flatMap((tag) => Array.from({ length: 15 }, (_, index) => `${tag}_${index}`)).sort()
    expect(directory.list().map((summary) => summary.session.id as string).sort()).toEqual(expected)
    expect([...seen].every((id) => expected.includes(id))).toBe(true)
    // A process that never saw them listed sees the same, and so does the cache on disk.
    const fresh = await run<Listing>("list", dir)
    expect(fresh.map((entry) => entry.id).sort()).toEqual(expected)
    expect(fresh.every((entry) => entry.lastSeq === 9)).toBe(true)
    const index = new Database(join(dir, INDEX_FILE), { readonly: true })
    expect(index.query<{ id: string }, []>("SELECT id FROM session_index ORDER BY id").all().map((row) => row.id)).toEqual(expected)
    index.close()
    // By working directory, as `--continue` and an editor's session list ask.
    expect(directory.list({ cwd: "/work/p2" }).map((summary) => summary.session.id as string).sort()).toEqual(expected.filter((id) => id.startsWith("p2_")))
    directory.close()
  }, 120_000)

  test("a third process sees two sessions that two other processes are writing, never behind what it saw before", async () => {
    const dir = dataDir()
    const start = { ses_a: seed(dir, "ses_a"), ses_b: seed(dir, "ses_b") }
    const writers = [await spawnReady("append", dir, "ses_a", "40"), await spawnReady("append", dir, "ses_b", "40")]
    const exits = Promise.all(writers.map((writer) => writer.exited))
    let finished = false
    void exits.then(() => (finished = true))
    const last: Record<string, number> = { ...start }
    let listings = 0
    while (!finished) {
      const listing = await run<Listing>("list", dir)
      listings += 1
      expect(listing.map((entry) => entry.id).sort()).toEqual(["ses_a", "ses_b"])
      for (const entry of listing) {
        // A listing is never staler than an earlier one: what was committed stays visible.
        expect(entry.lastSeq).toBeGreaterThanOrEqual(last[entry.id]!)
        last[entry.id] = entry.lastSeq
      }
    }
    expect(await exits).toEqual([0, 0])
    expect(listings).toBeGreaterThan(0)
    // Each writer added 40 turns of 7 events; the listing ends exactly where the files do.
    const final = await run<Listing>("list", dir)
    expect(Object.fromEntries(final.map((entry) => [entry.id, entry.lastSeq]))).toEqual({ ses_a: start.ses_a + 280, ses_b: start.ses_b + 280 })
    const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })
    for (const id of ["ses_a", "ses_b"]) {
      const store = directory.open(sid(id))
      expectRebuildEqualsLive(store, sid(id))
      store.close()
    }
    directory.close()
  }, 120_000)

  test("processes killed in the middle of updating the index leave listings right", async () => {
    const dir = dataDir()
    for (let index = 0; index < 12; index += 1) seed(dir, `ses_${index}`)
    const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })
    const truth = () => readdirSync(join(dir, "sessions")).flatMap((name) => (name.endsWith(".db") ? [name.slice(0, -3)] : [])).sort()
    for (let round = 0; round < 6; round += 1) {
      // Fresh files are re-read at every listing, so each lister rewrites rows in a transaction over and over.
      const listers = [await spawnReady("list-loop", dir), await spawnReady("list-loop", dir)]
      const creator = run<{ created: number }>("create", dir, `round${round}`, "4")
      await Bun.sleep(40 + round * 25)
      for (const lister of listers) lister.kill("SIGKILL")
      await Promise.all(listers.map((lister) => lister.exited))
      await creator
      const listed = directory.list({ includeArchived: true })
      expect(listed.map((summary) => summary.session.id as string).sort()).toEqual(truth())
      // Every summary is the session's own row, whatever a dead process left in the cache.
      for (const summary of listed) expect(summary).toEqual(directory.get(summary.session.id)!)
    }
    expect(truth()).toHaveLength(12 + 6 * 4)
    // The cache itself is a sound database with one row per session.
    const index = new Database(join(dir, INDEX_FILE), { readonly: true })
    expect(index.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(index.query<{ n: number }, []>("SELECT count(*) AS n FROM session_index").get()!.n).toBe(truth().length)
    index.close()
    directory.close()
  }, 120_000)
})

describe("a fork of a session another process is writing", () => {
  test("reads the parent's committed prefix and nothing after the fork point, while the parent grows", async () => {
    const dir = dataDir()
    const forkPoint = seed(dir, "ses_parent")
    const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })
    const prefix = directory.readEvents(sid("ses_parent"))
    expect(prefix).toHaveLength(forkPoint)

    const writer = await spawnReady("append", dir, "ses_parent", "60")
    // The parent is held by the other process, for writing, right now.
    expect(() => directory.open(sid("ses_parent"))).toThrow(SessionInUseError)
    const store = directory.create(sid("ses_fork"))
    const fork = new Driver(store, sid("ses_fork"))
    fork.add(forked(sid("ses_parent"), forkPoint))
    for (let turn = 0; turn < 5; turn += 1) {
      exchange(fork, `f${turn}`, `Fork question ${turn}`, `Fork answer ${turn}`)
      // Read again and again while the parent is appended to: the inherited part never changes.
      expect(store.readEvents(sid("ses_fork"), { limit: forkPoint })).toEqual(prefix)
      expectRebuildEqualsLive(store, sid("ses_fork"))
    }
    expect(await writer.exited).toBe(0)
    expect(directory.get(sid("ses_parent"))!.lastSeq).toBe(forkPoint + 60 * 7)

    const events = store.readEvents(sid("ses_fork"))
    expect(events.slice(0, forkPoint)).toEqual([...prefix])
    expect(events).toHaveLength(forkPoint + 1 + 5 * 7)
    expect(JSON.stringify(events)).not.toContain("Question 0")
    expectRebuildEqualsLive(store, sid("ses_fork"))
    store.close()
    // The parent's own log is intact and still ends where its writer left it.
    const parent = directory.open(sid("ses_parent"))
    expectRebuildEqualsLive(parent, sid("ses_parent"))
    parent.close()
    directory.close()
  }, 120_000)
})

describe("blobs from several processes", () => {
  test("the same bytes stored at once are one file with one media type, whoever was first", async () => {
    const dir = dataDir()
    const results = await Promise.all(["a", "b", "c", "d"].map((tag) => run<{ hash: string; mediaType: string }[]>("blobs", dir, tag, "25")))
    const directory = openSessionDirectory({ dataDir: dir, notice: () => {} })
    for (let index = 0; index < 25; index += 1) {
      const stored = directory.getBlob(results[0]![index]!.hash)!
      expect(new TextDecoder().decode(stored.bytes)).toBe(`blob ${index} ${"x".repeat(index * 100)}`)
      // Every process was told the same reference: the first writer's media type is everybody's.
      for (const result of results) expect(result[index]).toEqual({ hash: stored.hash, mediaType: stored.mediaType })
    }
    const files = readdirSync(join(dir, "blobs"), { recursive: true }).map(String).filter((name) => statSync(join(dir, "blobs", name)).isFile())
    expect(files).toHaveLength(25)
    expect(files.some((name) => name.includes(".tmp-"))).toBe(false)
    directory.close()
  }, 60_000)
})
