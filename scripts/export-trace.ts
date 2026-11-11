/**
 * Exports a stored session as a prefixlens trace, or lists the sessions.
 *
 *   bun scripts/export-trace.ts <session-id> [--db <path>] [-o <file>] [--compaction-prompt <text>] [--redact]
 *   bun scripts/export-trace.ts --list [--db <path>]
 *
 * The database defaults to the one file in `$XDG_DATA_HOME/<brand>` (or
 * `~/.local/share/<brand>`). It is never opened for writing: the script reads a
 * consistent snapshot through a read-only connection and works on that copy,
 * so a running harness keeps its writer lock and is not disturbed.
 *
 * The trace goes to `-o <file>` or to stdout. A summary and every row whose
 * rebuilt request does not match the ledger go to stderr. Exit codes: 0 when
 * every call was exported, 3 when a rebuilt request differs from its ledger
 * row (the trace is still written, with those calls usage-only), 1 on usage
 * errors. Nothing from the sign-in is read; see packages/core/src/trace.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { brand } from "../packages/core/src/brand.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import { openSqliteStore } from "../packages/core/src/store/sqlite.ts"
import { describeUnverified, exportSession } from "../packages/core/src/trace/export.ts"
import { serializeTrace } from "../packages/core/src/trace/format.ts"

const USAGE = `usage: bun scripts/export-trace.ts <session-id> [--db <path>] [-o <file>] [--compaction-prompt <text>] [--redact]
       bun scripts/export-trace.ts --list [--db <path>]`

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string" },
    out: { type: "string", short: "o" },
    list: { type: "boolean" },
    redact: { type: "boolean" },
    "compaction-prompt": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
})

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (!values.list && positionals.length !== 1) fail(USAGE)

const path = values.db ?? defaultDatabase()
if (!existsSync(path)) fail(`no database at ${path}`)

const directory = mkdtempSync(join(tmpdir(), `${brand.directory}-trace-`))
process.on("exit", () => rmSync(directory, { recursive: true, force: true }))
const store = openSqliteStore({ path: snapshot(path, join(directory, "snapshot.db")) })

if (values.list) {
  const sessions = store.listSessions({ includeArchived: true })
  if (sessions.length === 0) console.error(`no sessions in ${path}`)
  for (const entry of sessions) {
    const calls = store.readRequests(entry.session.id).length
    const title = entry.session.title ?? "(untitled)"
    console.log(`${entry.session.id}  ${new Date(entry.updatedAt).toISOString()}  ${String(calls).padStart(4)} calls  ${title}`)
  }
  process.exit(0)
}

const sessionId = positionals[0] as SessionId
if (store.getSession(sessionId) === null) fail(`no session ${sessionId} in ${path} (list them with --list)`)
const result = exportSession(store, sessionId, {
  ...(values["compaction-prompt"] === undefined ? {} : { compactionPrompt: values["compaction-prompt"] }),
})
const trace = serializeTrace(result.records, { redact: values.redact === true })
if (values.out === undefined) process.stdout.write(trace)
else await Bun.write(values.out, trace)

const full = result.records.filter((record) => record.fidelity === "full-request").length
console.error(
  `${sessionId}: ${result.calls.length} calls, ${result.records.length} exported (${full} full-request, ${result.records.length - full} usage-only), ${result.skipped.length} without usage${values.out === undefined ? "" : ` -> ${values.out}`}`,
)
for (const entry of result.skipped) console.error(`  skipped ${entry.requestId}: ${entry.reason}`)
for (const line of describeUnverified(result)) console.error(`  usage-only ${line}`)
const mismatched = result.unverified.some((entry) => entry.reason !== "compaction_prompt_unknown")
if (mismatched) console.error("the rebuilt requests above differ from the ledger: the request builder is not deterministic or the log was changed")
process.exit(mismatched ? 3 : 0)

function defaultDatabase(): string {
  const data = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
  const candidates = existsSync(data)
    ? readdirSync(data).filter((name) => /\.(db|sqlite|sqlite3)$/.test(name)).map((name) => join(data, name))
    : []
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) fail(`no session database in ${data}; pass --db <path>`)
  fail(`several databases in ${data}: ${candidates.join(", ")}; pass --db <path>`)
}

/** A consistent copy of the database, read through a read-only connection, so the live file is never locked or written. */
function snapshot(source: string, target: string): string {
  const reader = new Database(source, { readonly: true })
  const bytes = reader.serialize()
  reader.close()
  writeFileSync(target, bytes)
  return target
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
