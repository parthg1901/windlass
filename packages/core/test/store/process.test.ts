/**
 * Tests that need a second process: crash safety under SIGKILL, and the
 * single-writer rule.
 */
import { Database, SQLiteError } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessageId, RequestId, SessionId } from "../../src/id.ts"
import { StoreLockedError, openSqliteStore } from "../../src/store/sqlite.ts"
import { StoreError } from "../../src/store/store.ts"
import { expectStoreConsistent } from "./consistency.ts"
import { recoverClaimedSessions } from "./recovery.ts"
import { baselineSet, created, enqueue } from "./scripted.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "writer.ts")

const directories: string[] = []
const children: Bun.Subprocess[] = []
afterAll(() => {
  // A test that timed out may have left a writer running.
  for (const child of children) child.kill("SIGKILL")
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), "lh-store-process-"))
  directories.push(directory)
  return join(directory, "store.db")
}

/** Starts the fixture and resolves once it has printed `open`. */
async function spawnWriter(mode: "crash-loop" | "hold", path: string) {
  const child = Bun.spawn([process.execPath, FIXTURE, mode, path], { stdout: "pipe", stderr: "pipe" })
  children.push(child)
  const reader = child.stdout.getReader()
  let seen = ""
  while (!seen.includes("open\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`writer exited before opening: ${await new Response(child.stderr).text()}`)
    seen += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  return child
}

async function tryOpenInChild(path: string): Promise<{ ok: boolean; name?: string; message?: string }> {
  const child = Bun.spawn([process.execPath, FIXTURE, "open", path], { stdout: "pipe", stderr: "pipe" })
  children.push(child)
  const output = await new Response(child.stdout).text()
  await child.exited
  return JSON.parse(output)
}

describe("crash safety", () => {
  test(
    "a writer killed with SIGKILL at random moments leaves a dense, decodable log whose rebuild equals live",
    async () => {
      const path = temporaryPath()
      const runs = 12
      const progress: number[] = []
      for (let run = 0; run < runs; run++) {
        const child = await spawnWriter("crash-loop", path)
        await Bun.sleep(Math.floor(Math.random() * 400))
        child.kill("SIGKILL")
        await child.exited
        expect(child.signalCode).toBe("SIGKILL")

        const store = openSqliteStore({ path })
        expect(store.database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
        expectStoreConsistent(store)
        for (const row of store.database.query<{ id: string }, []>("SELECT id FROM session").all())
          store.readRequests(row.id as SessionId)
        progress.push(store.database.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()!.n)
        store.close()
      }
      // The kills landed while the writer was making progress, not only before it started.
      expect(new Set(progress).size).toBeGreaterThan(runs / 3)
      console.log(`crash test: ${runs} kills, event rows after each: ${progress.join(", ")}`)

      // What the last writer left claimed can still be recovered and appended to.
      const store = openSqliteStore({ path })
      recoverClaimedSessions(store)
      expect(store.listClaimedSessions()).toEqual([])
      expectStoreConsistent(store)
      store.close()
    },
    120_000,
  )
})

/** The `StoreError` code a call throws, or what it threw instead. */
function codeOf(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error instanceof StoreError ? error.code : error
  }
  return "no error"
}

describe("single writer", () => {
  test("a second store on the same file is refused at once, in this process and in another", async () => {
    const path = temporaryPath()
    const first = openSqliteStore({ path })
    first.append("ses_1" as SessionId, [created()])
    expect(() => openSqliteStore({ path })).toThrow(StoreLockedError)
    expect(codeOf(() => openSqliteStore({ path }))).toBe("locked")

    const startedAt = performance.now()
    const refused = await tryOpenInChild(path)
    expect(refused).toMatchObject({ ok: false, name: "StoreLockedError" })
    expect(refused.message).toContain("only one writer")
    // Bun's startup included; the open itself does not wait for the lock.
    expect(performance.now() - startedAt).toBeLessThan(10_000)

    // The first writer is unaffected, and other connections can still read.
    first.append("ses_1" as SessionId, [baselineSet()])
    const reader = new Database(path, { readonly: true })
    expect(reader.query("SELECT count(*) AS n FROM event").get()).toEqual({ n: 2 })
    reader.close()

    first.close()
    expect(await tryOpenInChild(path)).toEqual({ ok: true })
  }, 30_000)

  test("a killed writer releases the lock", async () => {
    const path = temporaryPath()
    const child = await spawnWriter("hold", path)
    expect(() => openSqliteStore({ path })).toThrow(StoreLockedError)
    child.kill("SIGKILL")
    await child.exited
    openSqliteStore({ path }).close()
  }, 30_000)

  test("an append waits a bounded time for a foreign connection's write lock, then fails having written nothing", () => {
    const path = temporaryPath()
    const store = openSqliteStore({ path, busyTimeoutMs: 200 })
    store.append("ses_1" as SessionId, [created()])
    const intruder = new Database(path)
    intruder.run("BEGIN IMMEDIATE")
    const startedAt = performance.now()
    let error: unknown
    try {
      store.append("ses_1" as SessionId, [enqueue("u1", "hi")])
    } catch (caught) {
      error = caught
    }
    // The store's own error, not a raw SQLite one; the SQLite error is kept as the cause.
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe("locked")
    expect(((error as StoreError).cause as SQLiteError).code).toStartWith("SQLITE_BUSY")
    expect(performance.now() - startedAt).toBeLessThan(5_000)
    // The ledger is written under the same lock and fails the same way.
    expect(
      codeOf(() =>
        store.beginRequest({
          id: "req_1" as RequestId,
          sessionId: "ses_1" as SessionId,
          messageId: "a1" as MessageId,
          attempt: 1,
          purpose: "step",
          model: "gpt-test",
          provider: "fake",
          blocks: [],
        }),
      ),
    ).toBe("locked")
    // Media is not in the database, so storing it waits for nobody.
    expect(store.putBlob(new Uint8Array([1]), "application/octet-stream").hash).toHaveLength(64)
    intruder.run("ROLLBACK")
    intruder.close()
    expect(store.getSession("ses_1" as SessionId)!.lastSeq).toBe(1)
    store.append("ses_1" as SessionId, [enqueue("u1", "hi")])
    expectStoreConsistent(store)
    store.close()
  }, 30_000)
})
