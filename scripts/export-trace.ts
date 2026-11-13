/**
 * Exports a stored session as a prefixlens trace, or lists the sessions.
 *
 *   bun scripts/export-trace.ts <session-id> [--data-dir <dir>] [-o <file>] [--compaction-prompt <text>] [--redact]
 *   bun scripts/export-trace.ts --list [--data-dir <dir>]
 *
 * Sessions are one database file each under the harness data directory
 * (`$XDG_DATA_HOME/<brand>`, or `~/.local/share/<brand>`); `--data-dir` names
 * another one, and the session may be given by a unique prefix of its ID.
 * `--db <path>` is accepted too: a directory is a data directory, a file is a
 * single database that holds the session itself (a test's, or a backup).
 *
 * Nothing is opened for writing and no session is held: the script copies a
 * consistent snapshot of the session's file (and, for a fork, of the files
 * its history is inherited from) through read-only connections and works on
 * the copies, so a harness that is working in the session is not disturbed.
 *
 * The trace goes to `-o <file>` or to stdout. A summary and every row whose
 * rebuilt request does not match the ledger go to stderr. Exit codes: 0 when
 * every call was exported, 3 when a rebuilt request differs from its ledger
 * row (the trace is still written, with those calls usage-only), 1 on usage
 * errors. Nothing from the sign-in is read; see packages/core/src/trace.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { brand } from "../packages/core/src/brand.ts"
import { forkOf } from "../packages/core/src/event/durable.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import type { BlobStore } from "../packages/core/src/store/blobs.ts"
import { copyDatabase as snapshot } from "../packages/core/src/store/copy.ts"
import { SESSIONS_DIRECTORY, openSessionDirectory } from "../packages/core/src/store/directory.ts"
import { openSqliteStore } from "../packages/core/src/store/sqlite.ts"
import { type SessionSummary, type Store, StoreError } from "../packages/core/src/store/store.ts"
import { describeUnverified, exportSession } from "../packages/core/src/trace/export.ts"
import { serializeTrace } from "../packages/core/src/trace/format.ts"

const USAGE = `usage: bun scripts/export-trace.ts <session-id> [--data-dir <dir>] [-o <file>] [--compaction-prompt <text>] [--redact]
       bun scripts/export-trace.ts --list [--data-dir <dir>]`

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
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

const place = values["data-dir"] ?? values.db ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
if (!existsSync(place)) fail(`nothing at ${place}`)
const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-trace-`))
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }))

/** What is exported from: every session it holds, and a way to read one as a consistent copy. */
const source = statSync(place).isDirectory() ? fromDataDirectory(place) : fromSingleDatabase(place)

if (values.list) {
  const sessions = source.list()
  if (sessions.length === 0) console.error(`no sessions in ${place}`)
  for (const entry of sessions) {
    const calls = source.read(entry.session.id, (store) => store.readRequests(entry.session.id).length)
    const title = entry.session.title ?? "(untitled)"
    console.log(`${entry.session.id}  ${new Date(entry.updatedAt).toISOString()}  ${String(calls).padStart(4)} calls  ${title}`)
  }
  process.exit(0)
}

const sessionId = (() => {
  try {
    return source.resolve(positionals[0]!)
  } catch (error) {
    if (error instanceof StoreError) fail(`${error.message} in ${place} (list them with --list)`)
    throw error
  }
})()
const result = source.read(sessionId, (store) =>
  exportSession(store, sessionId, {
    ...(values["compaction-prompt"] === undefined ? {} : { compactionPrompt: values["compaction-prompt"] }),
  }),
)
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

interface Source {
  readonly list: () => readonly SessionSummary[]
  readonly resolve: (idOrPrefix: string) => SessionId
  readonly read: <T>(id: SessionId, work: (store: Store) => T) => T
}

/**
 * The sessions of a data directory. A session is read from a copy: its file,
 * and the files of the sessions a fork inherits from, are each copied as one
 * consistent snapshot into a scratch data directory, which is then read.
 * Media is not in a session's file but in the data directory's shared blob
 * store, which the copy does not have: blobs are read from the live store
 * (content-addressed and never changed, so reading them needs no snapshot).
 * Without them a request with an image could not be encoded, and its call
 * would be exported usage-only.
 */
function fromDataDirectory(dataDir: string): Source {
  const live = openSessionDirectory({ dataDir })
  process.on("exit", () => live.close())
  const copies = join(scratch, "copy")
  mkdirSync(join(copies, SESSIONS_DIRECTORY), { recursive: true })
  const copied = openSessionDirectory({ dataDir: copies })
  process.on("exit", () => copied.close())
  const done = new Set<string>()
  const copy = (id: SessionId) => {
    for (let next: SessionId | null = id; next !== null && !done.has(next); ) {
      done.add(next)
      if (!existsSync(live.pathOf(next))) break
      snapshot(live.pathOf(next), copied.pathOf(next))
      const parent: SessionId | null = forkOf(copied.get(next)?.session.lineage ?? null)?.parentSessionId ?? null
      next = parent
    }
  }
  return {
    list: () => live.list({ includeArchived: true }),
    resolve: (idOrPrefix) => live.resolve(idOrPrefix),
    read: (id, work) => {
      copy(id)
      return copied.read(id, (store) => work(withBlobsOf(store, live.blobs)))
    },
  }
}

/** `store`, with `getBlob` answered from `blobs`. */
function withBlobsOf(store: Store, blobs: BlobStore): Store {
  return new Proxy(store, {
    get(target, key) {
      if (key === "getBlob") return (hash: string) => blobs.get(hash)
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** A single database file that holds its sessions itself, read from one consistent copy. */
function fromSingleDatabase(path: string): Source {
  const store = openSqliteStore({ path: snapshot(path, join(scratch, "snapshot.db")) })
  process.on("exit", () => store.close())
  const all = () => store.listSessions({ includeArchived: true })
  return {
    list: all,
    resolve: (idOrPrefix) => {
      const ids = all().map((entry) => entry.session.id)
      const found = ids.find((id) => id === idOrPrefix) ?? (ids.filter((id) => id.startsWith(idOrPrefix)).length === 1 ? ids.find((id) => id.startsWith(idOrPrefix)) : undefined)
      if (found === undefined) throw new StoreError("session_not_found", `no session ${idOrPrefix}`)
      return found
    },
    read: (id, work) => work(store),
  }
}


function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
