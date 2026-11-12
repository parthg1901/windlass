#!/usr/bin/env bun
// Prints a session's durable events, one line each, so a dogfood pass can check what the log says happened
// without reading the clients' rendering of it.
//
//   bun evals/dogfood/events.ts <session id or unique prefix> [--type <prefix>]... [--full] [--width <n>]
//
// Read-only. Each line is `seq  type  data`, with the data cut to `--width` characters (default 220) unless
// `--full`. `--type compaction` keeps only the event types that start with that word (repeatable). It opens the
// database read-only and never writes; a session held by a running process can still be read. The data directory
// is `$XDG_DATA_HOME/<brand.directory>`, or `~/.local/share/<brand.directory>`.

import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"

const argv = process.argv.slice(2)
let id = ""
let full = false
let width = 220
const types: string[] = []
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  if (arg === "--full") full = true
  else if (arg === "--type") types.push(argv[++index] ?? "")
  else if (arg === "--width") width = Number(argv[++index])
  else if (arg.startsWith("-")) usage()
  else id = arg
}
if (id === "") usage()

function usage(): never {
  console.error("usage: bun evals/dogfood/events.ts <session id or prefix> [--type <prefix>]... [--full] [--width <n>]")
  process.exit(2)
}

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const sessions = join(dataHome, brand.directory, "sessions")
if (!existsSync(sessions)) {
  console.error(`events: no sessions directory at ${sessions}`)
  process.exit(1)
}
const matches = readdirSync(sessions).filter((file) => file.endsWith(".db") && file.startsWith(id))
if (matches.length !== 1) {
  console.error(matches.length === 0 ? `events: no session starts with ${id}` : `events: ${matches.length} sessions start with ${id}`)
  process.exit(1)
}

const db = new Database(join(sessions, matches[0]!), { readonly: true })
const rows = db.query("SELECT seq, type, data FROM event ORDER BY seq").all() as { seq: number; type: string; data: string }[]
for (const row of rows) {
  if (types.length > 0 && !types.some((prefix) => row.type.startsWith(prefix))) continue
  const data = full ? row.data : row.data.length > width ? `${row.data.slice(0, width)}…` : row.data
  console.log(`${String(row.seq).padStart(5)}  ${row.type.padEnd(24)} ${data}`)
}
db.close()
