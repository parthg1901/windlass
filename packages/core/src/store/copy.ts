/**
 * A consistent copy of a session's database, for the scripts that read one
 * another process may be writing (trace export, telemetry export,
 * attribution). It is read through a read-only connection, so the live file
 * is never locked or written.
 *
 * The copy is marked as a rollback-journal database rather than a WAL one.
 * `serialize` returns the pages as the reader saw them, WAL frames included,
 * but keeps the header's WAL mark; a WAL database opened read-only needs its
 * `-wal` and `-shm` files, which the copy has none of. SQLite as Linux builds
 * it creates them anyway; the SQLite macOS ships refuses the open
 * (SQLITE_CANTOPEN). Bytes 18 and 19 of the header are the file format's
 * write and read versions: 2 is WAL, 1 the rollback journal.
 */
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"

export function copyDatabase(source: string, target: string): string {
  const reader = new Database(source, { readonly: true })
  let bytes: Uint8Array
  try {
    bytes = reader.serialize()
  } finally {
    reader.close()
  }
  if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1
    bytes[19] = 1
  }
  writeFileSync(target, bytes)
  return target
}
