/**
 * The prefixlens trace format, version 1 (prefixlens SPEC.md), as far as a
 * Responses API harness writes it: the record and block types, the canonical
 * block view of a Responses request body, usage conversion, and a serializer
 * that writes each block's content once per file and reuses the previous
 * request's leading blocks (SPEC sections 4.5 and 4.6).
 *
 * Nothing here knows about sessions or the store; `export.ts` does.
 */
import { createHash } from "node:crypto"
import type { Json } from "../json.ts"
import type { Usage } from "../provider/usage.ts"
import { canonicalJson } from "../request/canonical.ts"

export const TRACE_VERSION = 1

export type TraceBlockKind = "tool" | "system" | "message"

/** SPEC 4.1. `content` is the block as sent, in the canonical form of SPEC 4.3. */
export interface TraceBlock {
  readonly kind: TraceBlockKind
  /** Tool name for tools, role (or item type) for messages. Not hashed. */
  readonly key?: string
  /** Lowercase hex SHA-256 of the canonical JSON of `content`. */
  readonly hash: string
  readonly content?: Json
  readonly breakpoint?: boolean
}

/** SPEC 3. OpenAI caches implicitly and reports no writes, so `cache_write_tokens` is always `null` here. */
export interface TraceUsage {
  readonly input_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number | null
  readonly output_tokens: number
  readonly reasoning_tokens?: number
}

/** SPEC 6. Only the kinds the spec defines are written. */
export interface TraceHint {
  readonly kind: "compaction" | "compaction_call" | "tool_output_pruned" | "agent_switch" | "model_switch"
  readonly detail?: string
}

/**
 * The harness's own facts about a call, in a field readers ignore (SPEC 2:
 * "Readers MUST ignore fields they do not know"). SPEC.md has no way to say
 * that a prefix break was intended for a revert, a refusal or an effort
 * change, so the reason for every legitimate break is recorded here as well as
 * in `hints` where the spec has a kind for it.
 */
export interface HarnessExtension {
  readonly ordinal: number
  readonly message_id: string
  readonly attempt: number
  readonly purpose: "step" | "compaction"
  readonly outcome: "ok" | "error" | "aborted" | null
  /** Whether the rebuilt request's block hashes equal the ledger row's. `false` means the record is usage-only for that reason. */
  readonly verified: boolean
  /** Why the request could not be shown to be the one that was sent. */
  readonly unverified_reason?: string
  /**
   * Legitimate prefix breaks since the previous call of the session
   * (`compaction`, `revert`, `refusal`, `settings`), with the events that
   * caused them. Absent when there was none.
   */
  readonly prefix_break?: {
    readonly causes: readonly string[]
    readonly events: readonly { readonly type: string; readonly seq: number }[]
  }
  /**
   * Wire fields left out of `params` because the log does not record them.
   * `tool_choice` is one: it is not part of the cached prefix, so the ledger
   * does not hash it, and the request cannot say which value was sent.
   */
  readonly params_omitted: readonly string[]
}

/** SPEC 2. */
export interface TraceRecord {
  readonly v: typeof TRACE_VERSION
  readonly id?: string
  readonly session?: string
  readonly lane?: string
  readonly ts: string
  readonly provider: string
  readonly model: string
  readonly fidelity: "full-request" | "usage-only"
  readonly params?: Readonly<Record<string, Json>>
  readonly request?: { readonly reuse?: number; readonly blocks: readonly TraceBlock[] }
  readonly usage: TraceUsage
  readonly hints?: readonly TraceHint[]
  readonly headers?: Readonly<Record<string, string>>
  readonly source?: Readonly<Record<string, Json>>
  readonly x_light_harness?: HarnessExtension
}

/** SPEC 4.4: lowercase hex SHA-256 of the UTF-8 canonical JSON (RFC 8785 for the values JSON carries). */
export function traceHash(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex")
}

export interface CanonicalTraceRequest {
  readonly model: string
  readonly params: Readonly<Record<string, Json>>
  readonly blocks: readonly TraceBlock[]
}

/** Request fields that are not params (SPEC 2), plus the transport-only ones it says to leave out. */
const NOT_PARAMS = new Set(["model", "tools", "functions", "instructions", "input", "stream", "stream_options"])

/**
 * The canonical block view of an OpenAI Responses request body (SPEC 4.2,
 * 4.3): each element of `tools`; `instructions` as one system block
 * `{type: "text", text}`; each leading `input` item whose role is `system` or
 * `developer` as a system block; every other input item as a message block.
 * `cache_control` is removed from each item and its content parts, and a
 * string `content` becomes one `input_text` part (`output_text` for the
 * assistant). Everything else is kept as sent. prefixlens's own canonicaliser
 * gives the same blocks for the same body; the tests check it when the
 * sibling repository is present.
 */
export function canonicalResponsesRequest(body: Readonly<Record<string, Json>>): CanonicalTraceRequest {
  const tools = list(body.tools).map((tool) => block("tool", tool, toolName(tool)))
  const instructions = typeof body.instructions === "string" ? [block("system", { type: "text", text: body.instructions }, undefined)] : []
  const input =
    typeof body.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: body.input }] }] : list(body.input)
  const items = input.map(normalizeItem)
  const firstOther = items.findIndex((item) => !["system", "developer"].includes(field(item, "role") ?? ""))
  const cut = firstOther === -1 ? items.length : firstOther
  const blocks = items.map((item, index) => block(index < cut ? "system" : "message", item, field(item, "role") ?? field(item, "type")))
  return {
    model: typeof body.model === "string" ? body.model : "",
    params: Object.fromEntries(Object.entries(body).filter(([key]) => !NOT_PARAMS.has(key))),
    blocks: [...tools, ...instructions, ...blocks],
  }
}

/** SPEC 3, the OpenAI Responses row: the harness's `inputTokens` include the cached ones. */
export function traceUsage(usage: Usage): TraceUsage {
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens)
  return {
    input_tokens: usage.inputTokens - cached,
    cache_read_tokens: cached,
    cache_write_tokens: null,
    output_tokens: usage.outputTokens,
    reasoning_tokens: usage.reasoningTokens,
  }
}

export interface SerializeOptions {
  /** Write each block's content only the first time its hash appears, and reuse the previous request's leading blocks. Default `true`. */
  readonly compact?: boolean
  /** Write no block content at all (SPEC 4.5, redaction). Hashes are still over the real content. Default `false`. */
  readonly redact?: boolean
}

/** JSON Lines, one record per line, compacted as SPEC 4.5 and 4.6 recommend. */
export function serializeTrace(records: readonly TraceRecord[], options: SerializeOptions = {}): string {
  const compact = options.compact ?? true
  const written = new Set<string>()
  const previous = new Map<string, readonly TraceBlock[]>()
  return records
    .map((record) => {
      if (record.request === undefined) return JSON.stringify(record)
      const all = record.request.blocks
      const lane = `${record.session ?? ""}\u0000${record.lane ?? "main"}`
      const before = previous.get(lane) ?? []
      previous.set(lane, all)
      const reuse = compact ? leadingRun(before, all) : 0
      const blocks = all.slice(reuse).map((entry): TraceBlock => {
        const seen = written.has(entry.hash)
        written.add(entry.hash)
        if (options.redact || (compact && seen)) {
          const { content: _, ...rest } = entry
          return rest
        }
        return entry
      })
      return JSON.stringify({ ...record, request: { ...(reuse > 0 ? { reuse } : {}), blocks } })
    })
    .map((line) => `${line}\n`)
    .join("")
}

function leadingRun(before: readonly TraceBlock[], after: readonly TraceBlock[]) {
  const same = (a: TraceBlock, b: TraceBlock) =>
    a.hash === b.hash && a.kind === b.kind && a.key === b.key && Boolean(a.breakpoint) === Boolean(b.breakpoint)
  const index = before.findIndex((entry, position) => after[position] === undefined || !same(entry, after[position]!))
  return index === -1 ? before.length : index
}

function block(kind: TraceBlockKind, content: Json, key: string | undefined): TraceBlock {
  return { kind, ...(key === undefined ? {} : { key }), hash: traceHash(content), content }
}

function normalizeItem(item: Json): Json {
  const stripped = withoutCacheControl(item)
  if (!isObject(stripped)) return stripped
  if (Array.isArray(stripped.content)) return { ...stripped, content: stripped.content.map(withoutCacheControl) }
  if (typeof stripped.content !== "string") return stripped
  const type = stripped.role === "assistant" ? "output_text" : "input_text"
  return { ...stripped, content: [{ type, text: stripped.content }] }
}

function withoutCacheControl(value: Json): Json {
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control"))
}

function toolName(tool: Json): string | undefined {
  if (!isObject(tool)) return undefined
  if (typeof tool.name === "string") return tool.name
  const inner = tool.function
  if (isObject(inner) && typeof inner.name === "string") return inner.name
  return typeof tool.type === "string" ? tool.type : undefined
}

function field(value: Json, key: string): string | undefined {
  if (!isObject(value)) return undefined
  const found = value[key]
  return typeof found === "string" ? found : undefined
}

function list(value: Json | undefined): readonly Json[] {
  return Array.isArray(value) ? value : []
}

function isObject(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
