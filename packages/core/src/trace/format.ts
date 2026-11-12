/**
 * The prefixlens trace format, version 1.2 (prefixlens SPEC.md), as far as a
 * Responses API harness writes it: the record and block types, the canonical
 * block view of a Responses request body, usage conversion, and a serializer
 * that writes each block's content once per file and reuses the previous
 * request's leading blocks (SPEC sections 4.5 and 4.6).
 *
 * Images and files in a request are written as their SHA-256 and size, never
 * as their bytes (SPEC 4.5, "Binary data"); the block's hash is still that of
 * the content as sent, so it is the hash the ledger proves.
 *
 * Of what 1.2 adds: `billing` is written for a call the ledger says the
 * signed-in provider served (a ChatGPT plan: `"subscription"`) and left out,
 * as the spec says to for "unknown", for any other provider (a scripted
 * one); `cache_write_tokens` and `cache_write_12h_tokens` are what the
 * provider reported and the ledger kept, `null` and absent when it reported
 * none. An OpenAI stream reports usage only on its final event, so a call
 * with usage was never cut off and `interrupted` is never written.
 *
 * Nothing here knows about sessions or the store; `export.ts` does.
 */
import { createHash } from "node:crypto"
import { brand } from "../brand.ts"
import type { Json } from "../json.ts"
import type { Usage } from "../provider/usage.ts"
import { canonicalJson } from "../request/canonical.ts"

/** The major version every 1.x record carries in `v`. */
export const TRACE_VERSION = 1
/** The version of prefixlens SPEC.md this file writes. A minor version only adds optional fields, so its records still carry `v: 1`. */
export const TRACE_FORMAT_VERSION = "1.2"

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
  /** SPEC 4.5 (format 1.2): binary data in `content` is written as its SHA-256 and size; `hash` is still over the content as sent. */
  readonly elided?: boolean
}

/**
 * SPEC 3. `cache_write_tokens` is what the provider reported
 * (`input_tokens_details.cache_write_tokens`, zero included), or `null` when
 * it reported no figure, which is what the spec says for writes that are
 * not known. `cache_write_12h_tokens` (1.2) is the part of it with the
 * 12-hour lifetime (`cache_write_tokens_details.ttl_12h_tokens`), written
 * only when the provider reported the split.
 */
export interface TraceUsage {
  readonly input_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number | null
  readonly cache_write_12h_tokens?: number
  readonly output_tokens: number
  readonly reasoning_tokens?: number
}

/** SPEC 6. Only the kinds the spec defines are written. */
export type TraceHint =
  | { readonly kind: "compaction" | "compaction_call" | "tool_output_pruned" | "agent_switch" | "model_switch"; readonly detail?: string }
  | PrefixBreakHint

/**
 * SPEC 6.1 (format 1.1): the harness broke its own prefix on purpose before
 * this call. `after` is the last part of the previous request the break
 * leaves unchanged; without it the reason's default applies (`"system"` for
 * `revert` and `refusal`, `"start"` for the others).
 */
export interface PrefixBreakHint {
  readonly kind: "prefix_break"
  readonly reason: "compaction" | "revert" | "refusal" | "model_switch" | "settings_change"
  readonly after?: "start" | "tools" | "system" | { readonly message: number } | number
  readonly detail?: string
}

/** The brand's directory name as an identifier (`-` becomes `_`), as a type, so that the field's name below is a literal. */
type Identifier<S extends string> = S extends `${infer Head}-${infer Tail}` ? `${Head}_${Identifier<Tail>}` : S

/** The name of the field that holds `HarnessExtension`: `x_` and the brand's directory name as an identifier. */
export const HARNESS_KEY = `x_${brand.directory.replaceAll("-", "_")}` as `x_${Identifier<typeof brand.directory>}`

/**
 * The harness's own facts about a call, in a field readers ignore (SPEC 2:
 * "Readers MUST ignore fields they do not know"). Prefix breaks are declared
 * in `hints` (SPEC 6.1); what is left here has no place in the spec: the
 * ledger row's identity within the session (ordinal, message, attempt),
 * its outcome, whether the rebuilt request was verified against the ledger
 * and why not, and which wire fields the export could not reproduce.
 */
export interface HarnessExtension {
  readonly ordinal: number
  readonly message_id: string
  readonly attempt: number
  readonly purpose: "step" | "compaction"
  /** The provider that served the call, by the name the ledger has for it (`Provider.id`): the signed-in one, or a scripted one. */
  readonly served_by: string
  readonly outcome: "ok" | "error" | "aborted" | null
  /** Whether the rebuilt request's block hashes equal the ledger row's. `false` means the record is usage-only for that reason. */
  readonly verified: boolean
  /** Why the request could not be shown to be the one that was sent. */
  readonly unverified_reason?: string
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
  /** SPEC 2 (format 1.2): how the call was billed, when the writer knows. */
  readonly billing?: "per_token" | "subscription"
  readonly fidelity: "full-request" | "usage-only"
  readonly params?: Readonly<Record<string, Json>>
  readonly request?: { readonly reuse?: number; readonly blocks: readonly TraceBlock[] }
  readonly usage: TraceUsage
  readonly hints?: readonly TraceHint[]
  readonly headers?: Readonly<Record<string, string>>
  readonly source?: Readonly<Record<string, Json>>
  readonly [HARNESS_KEY]?: HarnessExtension
}

/** SPEC 4.4: lowercase hex SHA-256 of the UTF-8 canonical JSON (RFC 8785 for the values JSON carries). */
export function traceHash(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex")
}

/**
 * SPEC 4.5, "Binary data" (format 1.2): `content` with the base64 data of
 * every image, document, audio and file part replaced by
 * `"<binary MEDIA_TYPE, N bytes, sha256 HEX>"` (HEX over the base64 text as
 * sent, N the decoded size), and whether anything was replaced. The part
 * shapes are the ones the spec lists for every provider, matched the way
 * prefixlens's recorder matches them, so the same body gives the same blocks;
 * a Responses body carries only `input_image` and `input_file`. A URL that is
 * not a `data:` URL is kept.
 */
export function elideBinary(content: Json): { readonly content: Json; readonly elided: boolean } {
  let elided = false
  const walk = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(walk)
    if (!isObject(value)) return value
    const replaced = replaceBinary(value)
    if (replaced !== undefined) {
      elided = true
      return replaced
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]))
  }
  const result = walk(content)
  return { content: result, elided }
}

type JsonObject = { readonly [key: string]: Json }

function replaceBinary(part: JsonObject): JsonObject | undefined {
  const at = (object: Json | undefined, key: string, transform: (text: string) => string | undefined): JsonObject | undefined => {
    if (!isObject(object)) return undefined
    const text = object[key]
    if (typeof text !== "string") return undefined
    const next = transform(text)
    return next === undefined ? undefined : { ...object, [key]: next }
  }
  const nested = (key: string, inner: string, transform: (text: string) => string | undefined): JsonObject | undefined => {
    const replaced = at(part[key], inner, transform)
    return replaced === undefined ? undefined : { ...part, [key]: replaced }
  }
  if (isObject(part.source) && part.source.type === "base64") return nested("source", "data", (data) => binaryMarker(data, field(part.source!, "media_type")))
  if (part.type === "input_image") return at(part, "image_url", dataUrlMarker)
  if (part.type === "input_file") return at(part, "file_data", (data) => dataUrlMarker(data) ?? binaryMarker(data))
  if (part.type === "image_url") return nested("image_url", "url", dataUrlMarker)
  if (part.type === "input_audio") return nested("input_audio", "data", (data) => binaryMarker(data, field(part.input_audio!, "format")))
  if (part.type === "file") return nested("file", "file_data", (data) => dataUrlMarker(data) ?? binaryMarker(data))
  for (const key of ["inlineData", "inline_data"])
    if (isObject(part[key])) return nested(key, "data", (data) => binaryMarker(data, field(part[key]!, "mimeType") ?? field(part[key]!, "mime_type")))
  return undefined
}

function binaryMarker(base64: string, mediaType?: string): string {
  const bytes = Math.floor((base64.replace(/[^A-Za-z0-9+/]/g, "").length * 3) / 4)
  return `<binary${mediaType ? ` ${mediaType}` : ""}, ${bytes} bytes, sha256 ${createHash("sha256").update(base64, "utf8").digest("hex")}>`
}

/** Only a `data:` URL carries the bytes. */
function dataUrlMarker(url: string): string | undefined {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,/.exec(url)
  return match ? binaryMarker(url.slice(match[0].length), match[1] || undefined) : undefined
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
 * assistant). Everything else is kept as sent, except that a block's
 * images and files are written as their digest and size (`elideBinary`;
 * its hash is still over them). prefixlens's own recorder gives the same
 * blocks for the same body; the tests check it when the sibling repository
 * is present.
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

/** SPEC 3, the OpenAI Responses row: the harness's `inputTokens` include the cached ones and the ones written to the cache. */
export function traceUsage(usage: Usage): TraceUsage {
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens)
  const written = usage.cacheWriteTokens === undefined ? null : Math.min(usage.inputTokens - cached, usage.cacheWriteTokens)
  return {
    input_tokens: usage.inputTokens - cached - (written ?? 0),
    cache_read_tokens: cached,
    cache_write_tokens: written,
    ...(written === null || usage.cacheWrite12hTokens === undefined ? {} : { cache_write_12h_tokens: Math.min(written, usage.cacheWrite12hTokens) }),
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

/** The hash is over the content as sent; the content written is the one with binary data elided. */
function block(kind: TraceBlockKind, content: Json, key: string | undefined): TraceBlock {
  const written = elideBinary(content)
  return { kind, ...(key === undefined ? {} : { key }), hash: traceHash(content), content: written.content, ...(written.elided ? { elided: true } : {}) }
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
