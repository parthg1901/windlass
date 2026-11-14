/**
 * Explains a run's prompt-cache misses. After a run, its session is exported from the harness's data directory (one
 * database file per session, so runs in parallel never wait for each other) as a prefixlens trace (`scripts/export-trace.ts`) and `prefixlens check --json`, prefixlens's own gate,
 * gives every call a class. The ones that count here:
 *
 * - provider-side: the prefix was intact and the provider missed anyway (seen often on quick follow-ups);
 * - expired: the prefix was intact but the cache entry outlived its TTL;
 * - intentional: the harness declared the break (a compaction, a revert, a settings change) and the change is
 *   within what the declaration allows;
 * - avoidable: the harness changed its own prefix, with prefixlens's cause (`tools_changed`, `message_edited`,
 *   ...). A harness bug. That is a call that lost cached tokens to the change, one that changed its prefix
 *   undeclared while nothing was cached to lose, and a loss prefixlens cannot explain.
 *
 * A usage-only record in the export means the request rebuilt from the log did not match the hashes the ledger
 * stored for what was sent: also a harness bug, and prefixlens cannot explain that call's miss.
 *
 * prefixlens is a dev dependency of the workspace root; its command-line entry is run as a process.
 */
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { COMPACTION_PROMPT } from "../packages/core/src/engine/constants.ts"
import { HARNESS_KEY, type TraceRecord } from "../packages/core/src/trace/format.ts"
import { errorLine } from "./grader.ts"

const REPO = resolve(import.meta.dir, "..")
const EXPORTER = join(REPO, "scripts", "export-trace.ts")

/** The command-line entry of the installed prefixlens package, from its own `bin`. */
export function prefixlensCli(): string {
  const require = createRequire(import.meta.url)
  const { bin } = require("prefixlens/package.json") as { bin: Record<string, string> }
  return join(dirname(require.resolve("prefixlens/package.json")), bin.prefixlens!)
}

/** The data directory the CLI keeps its sessions in, one file each, for the environment the agent ran with. */
export function sessionDatabase(env: Readonly<Record<string, string | undefined>> = process.env) {
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
}

export type MissVerdict = "provider-side" | "expired" | "intentional" | "avoidable"

export interface ClassifiedMiss {
  /** 1-based call number in the trace. */
  readonly turn: number
  /** The step's message, from the trace's harness extension, to match a `cache-drop` in the event stream. */
  readonly messageId: string | null
  /** prefixlens's class of the call: `avoidable`, `undeclared-change`, `unexplained`, `intentional`, `expiry` or `provider-side`. */
  readonly class: string
  readonly verdict: MissVerdict
  /** prefixlens's cause, e.g. `provider_side`, `tools_changed`. */
  readonly cause: string
  readonly summary: string
}

export interface CacheClassification {
  /** `classified`: the numbers below are real. `skipped`: no prefixlens or no session. `error`: a step failed. */
  readonly status: "classified" | "skipped" | "error"
  /** Why it was skipped or failed. */
  readonly reason: string | null
  readonly records: number
  readonly fullRequest: number
  readonly usageOnly: number
  /** Usage-only records whose request did not rebuild to what was sent, with the exporter's reason. A harness bug. */
  readonly unfaithful: readonly { readonly turn: number; readonly messageId: string | null; readonly reason: string }[]
  /** No unfaithful record: every request was exported with full-request fidelity (or is a known exception). */
  readonly fullFidelity: boolean
  readonly providerSide: number
  readonly expired: number
  readonly intentional: number
  readonly avoidable: number
  /** The named cause of each avoidable miss, `turn N: <cause>: <summary>`. */
  readonly avoidableCauses: readonly string[]
  /** Every call that lost cached tokens or changed its prefix undeclared, with its verdict. */
  readonly misses: readonly ClassifiedMiss[]
}

/** The fields of `prefixlens check --json` read here. Everything else in it is ignored. */
interface CheckJson {
  readonly calls: readonly {
    readonly turn: number
    readonly class: string
    readonly summary: string
    readonly cause?: string
  }[]
}

/** What each class of `prefixlens check` is here. A class not named (`ok`, `cold-start`, `warm-start`) is no miss. */
const VERDICTS: Readonly<Record<string, MissVerdict>> = {
  avoidable: "avoidable",
  "undeclared-change": "avoidable",
  unexplained: "avoidable",
  intentional: "intentional",
  expiry: "expired",
  "provider-side": "provider-side",
}

const EMPTY = { records: 0, fullRequest: 0, usageOnly: 0, unfaithful: [], fullFidelity: false, providerSide: 0, expired: 0, intentional: 0, avoidable: 0, avoidableCauses: [], misses: [] }

export function skipped(reason: string, status: "skipped" | "error" = "skipped"): CacheClassification {
  return { status, reason, ...EMPTY }
}

/** Exports `sessionId` from `database` (a harness data directory, or a single database file) to `traceFile`, then classifies it. Never throws. */
export async function classifySession(sessionId: string | null, options: { readonly database: string; readonly traceFile: string }): Promise<CacheClassification> {
  if (sessionId === null) return skipped("the run reported no session")
  if (!existsSync(options.database)) return skipped(`no session database at ${options.database}`)
  // Exit 3: written, with some calls usage-only because their rebuilt request differs. Read the trace to see which.
  const exported = await spawn(["bun", EXPORTER, sessionId, "--db", options.database, "-o", options.traceFile, "--compaction-prompt", COMPACTION_PROMPT])
  if (exported.code !== 0 && exported.code !== 3) return skipped(`export failed (${exported.code}): ${errorLine(exported.stderr)}`, "error")
  return classifyTrace(options.traceFile)
}

/** Runs `prefixlens check --json` on a trace file and counts its classes. Never throws. */
export async function classifyTrace(traceFile: string): Promise<CacheClassification> {
  const cli = prefixlensCli()
  const records = (await Bun.file(traceFile).text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceRecord)
  // Exit 0: no failing call. 1: at least one, and they are in the JSON all the same. Anything else: no verdict.
  const checked = await spawn(["bun", cli, "check", traceFile, "--json"])
  if (checked.code !== 0 && checked.code !== 1) return skipped(`prefixlens check failed (${checked.code}): ${errorLine(checked.stderr)}`, "error")
  const check = JSON.parse(checked.stdout) as CheckJson

  const messageOf = (turn: number) => records[turn - 1]?.[HARNESS_KEY]?.message_id ?? null
  const unfaithful = records.flatMap((record, index) => {
    if (record.fidelity === "full-request") return []
    const reason = record[HARNESS_KEY]?.unverified_reason ?? "usage-only"
    // The exporter is given the engine's compaction prompt, so this only appears if that prompt changed under it.
    return [{ turn: index + 1, messageId: record[HARNESS_KEY]?.message_id ?? null, reason }]
  })
  const misses = check.calls.flatMap((call): ClassifiedMiss[] => {
    const verdict = VERDICTS[call.class]
    if (verdict === undefined) return []
    return [{ turn: call.turn, messageId: messageOf(call.turn), class: call.class, verdict, cause: call.cause ?? "unknown", summary: call.summary }]
  })
  const count = (verdict: MissVerdict) => misses.filter((miss) => miss.verdict === verdict).length
  const fullRequest = records.filter((record) => record.fidelity === "full-request").length
  return {
    status: "classified",
    reason: null,
    records: records.length,
    fullRequest,
    usageOnly: records.length - fullRequest,
    unfaithful,
    fullFidelity: unfaithful.length === 0,
    providerSide: count("provider-side"),
    expired: count("expired"),
    intentional: count("intentional"),
    avoidable: count("avoidable"),
    avoidableCauses: misses.filter((miss) => miss.verdict === "avoidable").map((miss) => `turn ${miss.turn}: ${miss.cause}: ${miss.summary}`),
    misses,
  }
}

async function spawn(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, NO_COLOR: "1" } })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { stdout, stderr, code }
}
