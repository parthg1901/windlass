/**
 * Per-step attribution of a stored session: for each model call, the blocks
 * its request had that the model's previous step had not been sent (a user
 * message, a tool result, an instruction update, a harness note, a
 * checkpoint), with their sizes, what the model did next, and the usage.
 *
 *   bun scripts/attribution.ts <session-id> [--json] [--step N] [--data-dir <dir> | --db <path>] [--no-preview]
 *
 * The session may be given by a unique prefix of its ID. It is read from the
 * harness data directory (`$XDG_DATA_HOME/<brand>`, or `~/.local/share/<brand>`)
 * or from `--data-dir`; `--db <path>` names a single database file instead (a
 * test's, or the recall evaluation's `--keep` store). As with
 * `scripts/export-trace.ts`, nothing is opened for writing and no session is
 * held: the session's file (and a fork's ancestors) is copied through a
 * read-only connection and the copy is read.
 *
 * `--step N` shows call N only (1-based, ledger order). `--json` prints the
 * attribution as JSON. Text previews of what the model was shown are on by
 * default (they are the session's own content, printed locally); `--no-preview`
 * leaves them out. Exit codes: 0, or 3 when a call broke the prefix with no
 * cause in the log, or a rebuilt request differs from its ledger row; 1 on usage
 * errors. See packages/core/src/trace/attribution.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { brand } from "../packages/core/src/brand.ts"
import { forkOf } from "../packages/core/src/event/durable.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import { copyDatabase as snapshot } from "../packages/core/src/store/copy.ts"
import { SESSIONS_DIRECTORY, openSessionDirectory } from "../packages/core/src/store/directory.ts"
import { openSqliteStore } from "../packages/core/src/store/sqlite.ts"
import { type Store, StoreError } from "../packages/core/src/store/store.ts"
import { attributeSession, renderAttribution } from "../packages/core/src/trace/attribution.ts"

const USAGE = "usage: bun scripts/attribution.ts <session-id> [--json] [--step N] [--data-dir <dir> | --db <path>] [--no-preview]"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    db: { type: "string" },
    json: { type: "boolean" },
    step: { type: "string" },
    "no-preview": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
})

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (positionals.length !== 1) fail(USAGE)
const step = values.step === undefined ? undefined : Number(values.step)
if (step !== undefined && (!Number.isInteger(step) || step < 1)) fail(`--step takes a call number from 1; got ${values.step}`)

const place = values["data-dir"] ?? values.db ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
if (!existsSync(place)) fail(`nothing at ${place}`)
const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-attribution-`))
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }))

const source = statSync(place).isDirectory() ? fromDataDirectory(place) : fromSingleDatabase(place)
const sessionId = (() => {
  try {
    return source.resolve(positionals[0]!)
  } catch (error) {
    if (error instanceof StoreError) fail(`${error.message} in ${place}`)
    throw error
  }
})()

const attribution = source.read(sessionId, (store) =>
  attributeSession(store.readEvents(sessionId), store.readRequests(sessionId), { previewChars: values["no-preview"] ? 0 : 80 }),
)
if (step !== undefined && !attribution.calls.some((call) => call.number === step)) fail(`the session has ${attribution.calls.length} calls; there is no call ${step}`)

if (values.json) {
  const calls = step === undefined ? attribution.calls : attribution.calls.filter((call) => call.number === step)
  console.log(JSON.stringify({ sessionId, ...attribution, calls }, null, 2))
} else {
  console.log(`${sessionId}: ${attribution.calls.length} model calls`)
  console.log(renderAttribution(attribution, step === undefined ? {} : { step }))
}
const bad = attribution.calls.filter((call) => call.prefix.status === "unexplained" || !call.verified)
for (const call of bad) console.error(`call ${call.number}: ${call.prefix.status === "unexplained" ? "the prefix broke with no cause in the log" : call.unverified}`)
process.exit(bad.length > 0 ? 3 : 0)

interface Source {
  readonly resolve: (idOrPrefix: string) => SessionId
  readonly read: <T>(id: SessionId, work: (store: Store) => T) => T
}

/** The sessions of a data directory, each read from a consistent copy of its file and its fork ancestors' files. */
function fromDataDirectory(dataDir: string): Source {
  const live = openSessionDirectory({ dataDir })
  process.on("exit", () => live.close())
  const copies = join(scratch, "copy")
  mkdirSync(join(copies, SESSIONS_DIRECTORY), { recursive: true })
  const copied = openSessionDirectory({ dataDir: copies })
  process.on("exit", () => copied.close())
  const copy = (id: SessionId) => {
    const done = new Set<string>()
    for (let next: SessionId | null = id; next !== null && !done.has(next); ) {
      done.add(next)
      if (!existsSync(live.pathOf(next))) break
      snapshot(live.pathOf(next), copied.pathOf(next))
      next = forkOf(copied.get(next)?.session.lineage ?? null)?.parentSessionId ?? null
    }
  }
  return {
    resolve: (idOrPrefix) => live.resolve(idOrPrefix),
    read: (id, work) => {
      copy(id)
      return copied.read(id, work)
    },
  }
}

/** A single database file that holds its sessions itself, read from one consistent copy. */
function fromSingleDatabase(path: string): Source {
  const store = openSqliteStore({ path: snapshot(path, join(scratch, "snapshot.db")) })
  process.on("exit", () => store.close())
  return {
    resolve: (idOrPrefix) => {
      const ids = store.listSessions({ includeArchived: true }).map((entry) => entry.session.id)
      const matches = ids.filter((id) => id === idOrPrefix || id.startsWith(idOrPrefix))
      const found = ids.find((id) => id === idOrPrefix) ?? (matches.length === 1 ? matches[0] : undefined)
      if (found === undefined) throw new StoreError("session_not_found", `no session ${idOrPrefix}`)
      return found
    },
    read: (_id, work) => work(store),
  }
}


function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
