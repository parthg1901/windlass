/**
 * Another process reading a session file while it is being created: opens the file, holds a read transaction
 * (a shared lock) for half a second, then lets go. Used by `wal-open.e2e.test.ts`.
 *
 *   bun read-holder.ts <database file>
 */
import { Database } from "bun:sqlite"

const [path] = process.argv.slice(2) as [string]
const database = new Database(path, { create: true })
database.run("BEGIN")
database.query("SELECT count(*) FROM sqlite_master").get()
console.log("holding")
// The store opening in the test's process blocks its thread while it retries, so the reader lets go by itself.
await Bun.sleep(500)
database.run("COMMIT")
database.close()
