/**
 * The single-writer guard for a SQLite store file.
 *
 * Choice: a second writer fails at open, immediately, with `StoreLockedError`.
 * It never waits for the first one and never writes alongside it.
 *
 * How: next to `<path>` sits `<path>-lock`, a tiny SQLite database that the
 * writer opens in `locking_mode = EXCLUSIVE` and writes once. SQLite then
 * holds an exclusive file lock on it until the connection closes, and the
 * operating system drops that lock when the process exits, also on SIGKILL, so
 * a crash never leaves a stale lock. A second opener uses `busy_timeout = 0`
 * and gets `SQLITE_BUSY` at once. SQLite tracks locks per inode within a
 * process, so a second store opened in the same process is refused too.
 *
 * The main database is not locked exclusively: in WAL mode other connections
 * may still read it while the writer runs. The lock file is never deleted,
 * because unlinking a file another process is about to lock would let two
 * writers lock two different inodes.
 */
import { Database, SQLiteError } from "bun:sqlite"
import { StoreError } from "./store.ts"

/** Another process (or another store in this process) already writes to this database. A `StoreError` with code `locked`. */
export class StoreLockedError extends StoreError {
  constructor(readonly path: string) {
    super("locked", `${path} is already open for writing by another store; only one writer may open it at a time`)
    this.name = "StoreLockedError"
  }
}

/** Whether `error` is SQLite reporting that another connection holds a lock it needs. */
export function isBusy(error: unknown): error is SQLiteError {
  return error instanceof SQLiteError && (error.code?.startsWith("SQLITE_BUSY") ?? false)
}

/** Takes the writer lock for `path`. Returns the connection that holds it; closing it releases the lock. */
export function acquireWriterLock(path: string): Database {
  const lock = new Database(`${path}-lock`, { create: true })
  try {
    lock.run("PRAGMA busy_timeout = 0")
    lock.run("PRAGMA locking_mode = EXCLUSIVE")
    lock.run("PRAGMA journal_mode = MEMORY")
    lock.run("BEGIN EXCLUSIVE")
    lock.run("CREATE TABLE IF NOT EXISTS writer (pid INTEGER NOT NULL)")
    lock.run("DELETE FROM writer")
    lock.run("INSERT INTO writer (pid) VALUES (?)", [process.pid])
    // In exclusive locking mode the lock outlives the transaction.
    lock.run("COMMIT")
  } catch (error) {
    lock.close()
    if (isBusy(error)) throw new StoreLockedError(path)
    throw error
  }
  return lock
}
