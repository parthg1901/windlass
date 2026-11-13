import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyDatabase } from "../../src/store/copy.ts"

const dir = mkdtempSync(join(tmpdir(), "wl-copy-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("a copy of a WAL database another connection is writing holds what it wrote, and opens read-only without a -wal or -shm file", () => {
  const live = join(dir, "live.db")
  const writer = new Database(live)
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("CREATE TABLE t (x)")
  writer.run("INSERT INTO t VALUES (1), (2)")
  try {
    const copy = copyDatabase(live, join(dir, "copy.db"))
    const header = readFileSync(copy).subarray(18, 20)
    expect([...header]).toEqual([1, 1])
    const reader = new Database(copy, { readonly: true })
    try {
      expect(reader.query<{ x: number }, []>("SELECT x FROM t ORDER BY x").all()).toEqual([{ x: 1 }, { x: 2 }])
    } finally {
      reader.close()
    }
    // The rows were in the live file's WAL, not yet in the file itself: the copy has them all the same.
    expect(readdirSync(dir).sort()).toEqual(["copy.db", "live.db", "live.db-shm", "live.db-wal"])
  } finally {
    writer.close()
  }
})
