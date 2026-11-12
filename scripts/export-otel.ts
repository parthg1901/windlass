/**
 * Exports a stored session as OpenTelemetry spans (packages/core/src/telemetry), after the fact.
 *
 *   bun scripts/export-otel.ts <session-id> [--endpoint <url> [--header name=value ...] | -o <file>]
 *                              [--content] [--no-children] [--data-dir <dir>]
 *
 * - `--endpoint <url>`: POST OTLP/JSON to `<url>/v1/traces` (an OpenTelemetry Collector's OTLP/HTTP receiver listens
 *   on port 4318). `--header name=value` adds a request header; `${NAME}` in the value is read from the environment,
 *   so a token need not be typed on the command line. Header values are never printed.
 * - `-o <file>`: write the same OTLP/JSON, one request body per line. Without either, the lines go to stdout.
 * - `--content`: also export message text, tool arguments and tool output, after the harness's credential redaction
 *   (with the values of this process's credential-looking environment variables) and a size bound.
 * - `--no-children`: leave out the subagents' sessions (included by default, placed in their parent's traces).
 * - `--data-dir <dir>`: another harness data directory (default `$XDG_DATA_HOME/<brand>` or `~/.local/share/<brand>`).
 *
 * Read-only. Nothing is opened for writing and no session is held: each session's file (and those its history is
 * inherited from) is copied as one consistent snapshot through a read-only connection, and the copy is read, so a
 * harness working in the session is not disturbed and a running session can be exported. Nothing from the sign-in
 * is read. A summary goes to stderr. Exit codes: 0 exported; 1 usage error or no such session; 4 the collector did
 * not take every span.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { brand } from "../packages/core/src/brand.ts"
import { forkOf } from "../packages/core/src/event/durable.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import { SESSIONS_DIRECTORY, openSessionDirectory } from "../packages/core/src/store/directory.ts"
import { StoreError } from "../packages/core/src/store/store.ts"
import { credentialValues } from "../packages/core/src/telemetry/content.ts"
import { exportOtlpHttp, writeOtlpFile } from "../packages/core/src/telemetry/exporter.ts"
import { expand } from "../packages/core/src/telemetry/config.ts"
import { batches } from "../packages/core/src/telemetry/otlp.ts"
import { type SessionReader, mapSessionTree } from "../packages/core/src/telemetry/tree.ts"

const USAGE = `usage: bun scripts/export-otel.ts <session-id> [--endpoint <url> [--header name=value ...] | -o <file>] [--content] [--no-children] [--data-dir <dir>]`

const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      options: {
        "data-dir": { type: "string" },
        endpoint: { type: "string" },
        header: { type: "string", multiple: true },
        out: { type: "string", short: "o" },
        content: { type: "boolean" },
        "no-children": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
})()

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (positionals.length !== 1) fail(USAGE)
if (values.endpoint !== undefined && values.out !== undefined) fail(`give --endpoint or -o, not both\n${USAGE}`)
if (values.header !== undefined && values.endpoint === undefined) fail(`--header needs --endpoint\n${USAGE}`)

const headers: Record<string, string> = {}
for (const entry of values.header ?? []) {
  const at = entry.indexOf("=")
  if (at <= 0) fail(`--header takes name=value; got a value without "="`)
  try {
    headers[entry.slice(0, at)] = expand(entry.slice(at + 1), process.env, `--header ${entry.slice(0, at)}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

const dataDir = values["data-dir"] ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
if (!existsSync(join(dataDir, SESSIONS_DIRECTORY))) fail(`no sessions under ${dataDir}`)
const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-otel-`))
const live = openSessionDirectory({ dataDir })
const copies = join(scratch, "copy")
mkdirSync(join(copies, SESSIONS_DIRECTORY), { recursive: true })
const copied = openSessionDirectory({ dataDir: copies })
process.on("exit", () => {
  copied.close()
  live.close()
  rmSync(scratch, { recursive: true, force: true })
})

const sessionId = (() => {
  try {
    return live.resolve(positionals[0]!)
  } catch (error) {
    if (error instanceof StoreError) fail(`${error.message} in ${dataDir}`)
    throw error
  }
})()

const done = new Set<string>()
/** Copies a session's file, and the files its history is inherited from, as consistent snapshots. */
const copy = (id: SessionId) => {
  for (let next: SessionId | null = id; next !== null && !done.has(next); ) {
    done.add(next)
    if (!existsSync(live.pathOf(next))) break
    snapshot(live.pathOf(next), copied.pathOf(next))
    next = forkOf(copied.get(next)?.session.lineage ?? null)?.parentSessionId ?? null
  }
}
const read: SessionReader = (id) => {
  if (!existsSync(live.pathOf(id as SessionId))) return null
  copy(id as SessionId)
  return copied.read(id as SessionId, (store) => ({ sessionId: id, events: store.readEvents(id as SessionId), requests: store.readRequests(id as SessionId) }))
}

const tree = mapSessionTree(read, sessionId, {
  content: values.content === true,
  secrets: credentialValues(process.env),
  children: values["no-children"] !== true,
})
const traces = new Set(tree.spans.map((span) => span.traceId)).size
const summary = `${sessionId}: ${tree.spans.length} spans in ${traces} trace(s) from ${tree.sessions.length} session(s)${values.content ? ", with content" : ""}`
const unknown = Object.entries(tree.unknownEvents)
if (unknown.length > 0) console.error(`  event types without a mapping: ${unknown.map(([type, count]) => `${type} (${count})`).join(", ")}`)
if (tree.missing.length > 0) console.error(`  subagent sessions not found: ${tree.missing.join(", ")}`)

if (values.endpoint !== undefined) {
  const result = await exportOtlpHttp(tree.spans, { endpoint: values.endpoint, headers })
  console.error(`${summary} -> ${values.endpoint}: ${result.sent} sent, ${result.failed} failed`)
  for (const batch of result.batches) if (batch.error !== null) console.error(`  batch of ${batch.spans} after ${batch.attempts} attempt(s): ${batch.error}`)
  process.exit(result.failed === 0 ? 0 : 4)
}
if (values.out !== undefined) {
  const lines = writeOtlpFile(values.out, tree.spans)
  console.error(`${summary} -> ${values.out} (${lines} line(s))`)
} else {
  for (const batch of batches(tree.spans)) process.stdout.write(`${batch.body}\n`)
  console.error(summary)
}
process.exit(0)

/** A consistent copy of a database, read through a read-only connection, so the live file is never locked or written. */
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
