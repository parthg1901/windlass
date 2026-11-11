/**
 * The sibling prefixlens checkout, when there is one at ../prefixlens next to
 * this repository. It is loaded by path at run time, never declared as a
 * dependency, so a fresh clone without it still installs, typechecks and runs
 * its tests (the parts that need prefixlens are skipped and say why).
 *
 * Only the few entry points the tests use are typed here.
 */
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/** `../prefixlens` beside this repository; `PREFIXLENS_DIR` points elsewhere (or at nothing, to see the skips). */
export const PREFIXLENS_DIR = process.env.PREFIXLENS_DIR ?? resolve(import.meta.dir, "../../../../../prefixlens")
const present = existsSync(join(PREFIXLENS_DIR, "src/assert.ts")) && existsSync(join(PREFIXLENS_DIR, "src/cli.ts"))

/** Why the prefixlens parts are skipped, or `null` when the sibling is there. */
export const SKIP_REASON = present ? null : `skipped: no prefixlens checkout at ${PREFIXLENS_DIR}`

/** `name`, with the skip reason appended when the sibling is absent, so a skipped test says why in the summary. */
export const withPrefixlens = (name: string) => (SKIP_REASON === null ? name : `${name} [${SKIP_REASON}]`)

if (SKIP_REASON !== null) console.warn(`prefixlens tests ${SKIP_REASON}`)

export interface Explanation {
  readonly stable: boolean
  readonly ok: boolean
  readonly message: string
  readonly block?: { readonly number: number; readonly kind: string; readonly label: string }
  readonly change: { readonly cause: string } | null
}

export interface PrefixOptions {
  readonly provider?: "openai"
  readonly allowBreak?: string | { readonly after?: "start" | "tools" | "system" | { readonly message: number } | number; readonly reason?: string }
  readonly ignoreParams?: readonly string[]
}

export interface PrefixlensTest {
  readonly assertPrefixStable: (prev: unknown, next: unknown, options?: PrefixOptions) => Explanation
  readonly explainPrefixDiff: (prev: unknown, next: unknown, options?: PrefixOptions) => Explanation
}

export interface PrefixlensRecorder {
  /** The record the recording proxy writes for one exchange (src/record/exchange.ts). */
  readonly buildRecord: (input: {
    api: "openai-responses"
    body: Record<string, unknown>
    response: { usage?: Record<string, unknown>; complete: boolean }
    startedAt: Date
    headers?: Headers
    session?: string
    lane: string
    recorder: string
  }) => Record<string, unknown> | string
}

export interface PrefixlensReader {
  readonly parseTrace: (text: string) => { records: unknown[]; errors: string[]; warnings: string[] }
}

export async function loadPrefixlens() {
  if (SKIP_REASON !== null) return null
  const load = (file: string) => import(join(PREFIXLENS_DIR, file))
  return {
    test: (await load("src/assert.ts")) as PrefixlensTest,
    recorder: (await load("src/record/exchange.ts")) as PrefixlensRecorder,
    reader: (await load("src/trace.ts")) as PrefixlensReader,
    cli: join(PREFIXLENS_DIR, "src/cli.ts"),
  }
}

/** `prefixlens report <trace> --json`, parsed. */
export function report(cli: string, trace: string) {
  const run = Bun.spawnSync(["bun", cli, "report", trace, "--json"], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`prefixlens report exited ${run.exitCode}: ${run.stderr.toString()}`)
  return { json: JSON.parse(run.stdout.toString()) as ReportJson, stderr: run.stderr.toString() }
}

export interface ReportJson {
  readonly report: string
  readonly summary: {
    readonly turns: number
    readonly lanes: readonly string[]
    readonly fidelity: { readonly full_request: number; readonly usage_only: number }
    /** Calls that lost cached tokens and were not declared as intentional breaks: the avoidable misses. */
    readonly misses: number
    readonly hit_rate: number
    readonly headline: string
    readonly intentional: { readonly breaks: number; readonly by_reason: readonly { readonly reason: string; readonly breaks: number }[] }
  }
  readonly turns: readonly {
    readonly turn: number
    readonly id?: string
    readonly status: string
    readonly hit_rate: number
    readonly usage: { readonly cache_read_tokens: number }
    readonly prompt_tokens: number
    readonly cause?: { readonly cause: string; readonly group: string; readonly summary: string; readonly confidence: string }
    readonly prefix_change?: { readonly cause: string; readonly summary: string }
    /** On a miss: the breaks the record declared, and whether they excuse it (SPEC 6.1). */
    readonly declared_break?: { readonly reasons: readonly string[]; readonly intentional: boolean; readonly checked: boolean; readonly note?: string }
  }[]
  readonly warnings: readonly string[]
}

/** Cause groups that do not blame the harness: nothing was cached yet, the entry expired, or the provider missed with the prefix intact. */
export const NOT_HARNESS = new Set(["cold start", "cache expiry", "provider-side misses"])
