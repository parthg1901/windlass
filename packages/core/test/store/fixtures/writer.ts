/**
 * A child process for the crash and single-writer tests.
 *
 *   bun writer.ts crash-loop <path>   recover, then append scripted sessions until killed
 *   bun writer.ts hold <path>         open the store and wait until killed
 *   bun writer.ts open <path>         try to open the store; print the outcome as JSON
 *
 * Every mode prints `open` on its own line once the store is open.
 */
import { openSqliteStore } from "../../../src/store/sqlite.ts"
import { recoverClaimedSessions } from "../recovery.ts"
import { SCRIPTS } from "../scripted.ts"

const [mode, path] = process.argv.slice(2)
if (path === undefined) throw new Error("usage: writer.ts crash-loop|hold|open <path>")

if (mode === "open") {
  try {
    openSqliteStore({ path }).close()
    console.log(JSON.stringify({ ok: true }))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, name: (error as Error).name, message: (error as Error).message }))
  }
  process.exit(0)
}

const store = openSqliteStore({ path })
console.log("open")

if (mode === "hold") await Bun.sleep(60_000)

if (mode === "crash-loop") {
  recoverClaimedSessions(store)
  // Stop on our own if the parent never kills us.
  const deadline = Date.now() + 60_000
  for (let run = 0; Date.now() < deadline; run++)
    for (const [name, script] of Object.entries(SCRIPTS)) script(store, `p${process.pid}_${run}_${name}`)
}

store.close()
