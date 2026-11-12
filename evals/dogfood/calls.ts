#!/usr/bin/env bun
// Counts the live model requests a dogfood pass spent, so the pass stays inside its budget.
//
//   bun evals/dogfood/calls.ts --cwd <workspace> [--cwd <another>]...   # every session started in these directories
//   bun evals/dogfood/calls.ts --since <minutes>                        # every session used in the last N minutes
//
// Reads the session databases in the data directory read-only and prints one line per session:
// its ID, requests, tokens in/cached/out, and title. It prints counts only, never message text or
// credentials, and it never writes. The data directory is `$XDG_DATA_HOME/<brand.directory>`, or
// `~/.local/share/<brand.directory>`.

import { Database } from "bun:sqlite"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"

const dirs: string[] = []
let sinceMinutes: number | null = null
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  if (arg === "--cwd") dirs.push(realpathSync(resolve(argv[++index] ?? ".")))
  else if (arg === "--since") sinceMinutes = Number(argv[++index])
  else {
    console.error("usage: bun evals/dogfood/calls.ts (--cwd <dir>)... | --since <minutes>")
    process.exit(2)
  }
}
if (dirs.length === 0 && (sinceMinutes === null || !Number.isFinite(sinceMinutes))) {
  console.error("calls: give --cwd <dir> or --since <minutes>")
  process.exit(2)
}

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const sessions = join(dataHome, brand.directory, "sessions")
if (!existsSync(sessions)) {
  console.error(`calls: no sessions directory at ${sessions}`)
  process.exit(1)
}
const cutoff = sinceMinutes === null ? 0 : Date.now() - sinceMinutes * 60_000

interface Row {
  id: string
  title: string | null
  cwd: string
  updated: number
  requests: number
  input: number
  cached: number
  output: number
}

const rows: Row[] = []
for (const file of readdirSync(sessions)) {
  if (!file.endsWith(".db")) continue
  let db: Database | undefined
  try {
    db = new Database(join(sessions, file), { readonly: true })
    for (const session of db.query("SELECT id, title, cwd, time_updated AS updated FROM session").all() as Omit<Row, "requests" | "input" | "cached" | "output">[]) {
      if (dirs.length > 0 && !dirs.includes(session.cwd)) continue
      if (session.updated < cutoff) continue
      const usage = db
        .query(
          "SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(cached_input_tokens),0) AS cached, COALESCE(SUM(output_tokens),0) AS output FROM request WHERE session_id = ?",
        )
        .get(session.id) as Pick<Row, "requests" | "input" | "cached" | "output">
      rows.push({ ...session, ...usage })
    }
  } catch {
    // A session being written by a running process can be busy; skip it rather than wait.
  } finally {
    db?.close()
  }
}

rows.sort((a, b) => a.updated - b.updated)
let total = 0
for (const row of rows) {
  total += row.requests
  const title = (row.title ?? "(untitled)").slice(0, 50)
  console.log(`${row.id}  ${String(row.requests).padStart(3)} requests  ${row.input} in / ${row.cached} cached / ${row.output} out  ${title}`)
}
console.log(`${rows.length} sessions, ${total} requests`)
