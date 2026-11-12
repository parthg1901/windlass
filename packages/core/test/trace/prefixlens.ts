/**
 * prefixlens, the package the cache guarantee is checked with: its `assertPrefixStable` on the harness's own
 * requests, its recorder's records beside the exporter's, and its report on an exported trace. It is a dev
 * dependency of the workspace root, so these tests always run.
 *
 * Only the few entry points the tests use are typed here.
 */
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { buildRecord, parseTrace } from "prefixlens"
import { assertPrefixStable, explainPrefixDiff } from "prefixlens/test"

/** The package's command-line entry, from its own `bin`. */
function cliPath(): string {
  const manifest = createRequire(import.meta.url).resolve("prefixlens/package.json")
  const { bin } = createRequire(import.meta.url)("prefixlens/package.json") as { bin: Record<string, string> }
  return join(dirname(manifest), bin.prefixlens!)
}

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

export const prefixlens = {
  test: { assertPrefixStable, explainPrefixDiff } as unknown as PrefixlensTest,
  recorder: { buildRecord } as unknown as PrefixlensRecorder,
  reader: { parseTrace } as unknown as PrefixlensReader,
  cli: cliPath(),
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
