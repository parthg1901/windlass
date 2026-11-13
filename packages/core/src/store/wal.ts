/**
 * Switches a connection's database to WAL, waiting out other processes doing the same.
 *
 * Several processes opening a new database file at once all ask for WAL. Each reads the header under a shared lock
 * and then needs an exclusive one to change the journal mode; SQLite does not run the busy handler for a lock that
 * could deadlock, so one of them gets `SQLITE_BUSY` at once however long `busy_timeout` is. Once the file is in WAL
 * mode (the mode is stored in it) asking again changes nothing, so the loser only has to ask again.
 */
import type { Database } from "bun:sqlite"
import { isBusy } from "./sqlite-lock.ts"

/** Sets `journal_mode = WAL`, retrying a busy refusal for up to `timeoutMs`. Returns the mode the database is in. */
export function enableWal(database: Database, timeoutMs: number): string {
  const deadline = performance.now() + timeoutMs
  for (let pause = 1; ; pause = Math.min(pause * 2, 50)) {
    try {
      return database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode ?? ""
    } catch (error) {
      if (!isBusy(error) || performance.now() >= deadline) throw error
      Bun.sleepSync(pause)
    }
  }
}
