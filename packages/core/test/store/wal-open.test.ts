import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqliteStore } from "../../src/store/sqlite.ts"

const HOLDER = join(import.meta.dir, "fixtures", "read-holder.ts")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Seen on CI: a process listing sessions read a session file while the process creating it switched it to WAL. SQLite
// refuses that switch at once while another connection holds a shared lock, whatever the busy timeout; the store
// must wait for the reader (which lets go after half a second) instead of failing with "database is locked".
test("a new session store opens while another process holds a read on the file, once the reader lets go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-open-"))
  dirs.push(dir)
  const path = join(dir, "session.db")
  const holder = Bun.spawn([process.execPath, HOLDER, path], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = holder.stdout.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain("holding")
    const store = openSqliteStore({ path, busyTimeoutMs: 10_000 })
    store.close()
    expect(await holder.exited).toBe(0)
  } finally {
    holder.kill("SIGKILL")
  }
}, 30_000)
