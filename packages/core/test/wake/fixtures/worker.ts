/**
 * A harness process as far as wake-ups are concerned: a scheduler on the shared store, delivering into a shared
 * SQLite "inbox" that admits each key once, as the engine's inbox does. Used by `processes.test.ts`.
 *
 *   bun worker.ts <wake dir> <inbox db> <mode> [<go file>]
 *
 * Modes: `run` delivers normally; `die-after-admit` is killed (SIGKILL) right after its first admission, before
 * the store hears it was delivered; `die-before-admit` is killed on its first delivery attempt. It waits for the
 * go file (a barrier, so that several start at once), runs until every wake-up has ended with nothing left to
 * deliver, prints a JSON summary and exits.
 */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { createCheckRunner } from "../../../src/wake/check.ts"
import { createScheduler } from "../../../src/wake/scheduler.ts"
import { openWakeStore } from "../../../src/wake/store.ts"

const [dir, inboxPath, mode, goFile] = process.argv.slice(2) as [string, string, string, string | undefined]
const inbox = new Database(inboxPath, { create: true })
inbox.run("PRAGMA busy_timeout = 10000")
inbox.run("PRAGMA journal_mode = WAL")
inbox.run("CREATE TABLE IF NOT EXISTS attempt (key TEXT NOT NULL, pid INTEGER NOT NULL)")
inbox.run("CREATE TABLE IF NOT EXISTS admitted (key TEXT PRIMARY KEY, pid INTEGER NOT NULL)")

const store = openWakeStore({ dir })
const results: string[] = []
let attempts = 0
const scheduler = createScheduler({
  store,
  runCheck: createCheckRunner({ spillDir: `${dir}/spill-${process.pid}`, graceMs: 200 }),
  maxIdleMs: 200,
  probeMs: 100,
  deliver: async (firing) => {
    attempts += 1
    inbox.run("INSERT INTO attempt (key, pid) VALUES (?, ?)", [firing.key, process.pid])
    if (mode === "die-before-admit" && attempts === 1) process.kill(process.pid, "SIGKILL")
    const admitted = inbox.run("INSERT OR IGNORE INTO admitted (key, pid) VALUES (?, ?)", [firing.key, process.pid]).changes === 1
    if (mode === "die-after-admit" && attempts === 1) process.kill(process.pid, "SIGKILL")
    results.push(`${firing.key}:${admitted ? "admitted" : "duplicate"}`)
    return { kind: admitted ? "admitted" : "duplicate" }
  },
})

if (goFile !== undefined) while (!existsSync(goFile)) await Bun.sleep(5)
scheduler.start()

const deadline = performance.now() + 30_000
const finished = () =>
  store.list({ includeEnded: true }).every((wake) => wake.state.kind !== "pending" && store.firings(wake.id).every((firing) => firing.deliveredAt !== null))
while (!finished() && performance.now() < deadline) await Bun.sleep(25)
const done = finished()
await scheduler.stop()
store.close()
console.log(JSON.stringify({ pid: process.pid, finished: done, results }))
