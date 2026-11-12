/**
 * A validator for prefixlens trace files, written from prefixlens SPEC.md
 * (format version 1.2) alone, without its code. It checks every rule a reader
 * enforces and the writer duties the spec states with MUST or SHOULD, and
 * resolves `request.reuse` and omitted content so the full block list of
 * each record can be compared with what was exported.
 */
import { traceHash } from "../../src/trace/format.ts"

export interface ResolvedBlock {
  readonly kind: string
  readonly key?: string
  readonly hash: string
  readonly content?: unknown
  readonly breakpoint?: boolean
  readonly elided?: boolean
}

export interface Validation {
  readonly errors: string[]
  /** Each record with its full block list (reuse resolved, omitted content restored). */
  readonly records: { readonly record: Record<string, unknown>; readonly blocks: ResolvedBlock[] | null }[]
  /** Hashes that appear only without content anywhere in the file (treated as redacted, SPEC 4.5). */
  readonly redacted: Set<string>
}

const KINDS = ["tool", "system", "message"]
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const HEX64 = /^[0-9a-f]{64}$/
// SPEC 2: never authorization, x-api-key, cookies or account ids.
const CREDENTIAL_HEADER = /authorization|api-key|cookie|account|token|secret/
// SPEC 2: params holds every field that is not the model, tools, system prompt or messages, and no transport-only field.
const NOT_PARAMS = ["model", "tools", "instructions", "input", "messages", "system", "stream", "stream_options"]

export function validateTrace(text: string): Validation {
  const errors: string[] = []
  const records: Validation["records"] = []
  const contents = new Map<string, unknown>()
  const lastFull = new Map<string, ResolvedBlock[]>()
  const ids = new Set<string>()
  const hashOnly = new Set<string>()
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return
    const at = (problem: string) => errors.push(`line ${index + 1}: ${problem}`)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return at("not JSON")
    }
    if (!isObject(value)) return at("not a JSON object")
    if (value.v !== 1) at("v must be 1")
    if (typeof value.ts !== "string" || !RFC3339.test(value.ts) || Number.isNaN(Date.parse(value.ts)))
      at("ts must be an RFC 3339 timestamp with a time zone")
    for (const field of ["provider", "model"]) if (typeof value[field] !== "string") at(`${field} must be a string`)
    for (const field of ["id", "session", "lane"])
      if (value[field] !== undefined && typeof value[field] !== "string") at(`${field} must be a string`)
    if (typeof value.id === "string") {
      if (ids.has(value.id)) at(`id ${value.id} is not unique within the trace`)
      ids.add(value.id)
    }
    if (value.fidelity !== "full-request" && value.fidelity !== "usage-only") at("fidelity must be full-request or usage-only")
    checkUsage(value.usage, at)
    if (value.params !== undefined) {
      if (!isObject(value.params)) at("params must be an object")
      else for (const key of NOT_PARAMS) if (key in value.params) at(`params must not contain ${key}`)
    }
    if (value.cache_ttl_seconds !== undefined && !isCount(value.cache_ttl_seconds)) at("cache_ttl_seconds must be a non-negative integer")
    if (value.hints !== undefined) {
      if (!Array.isArray(value.hints)) at("hints must be an array")
      else
        value.hints.forEach((hint, position) => {
          if (!isObject(hint) || typeof hint.kind !== "string") at(`hints[${position}] needs a string kind`)
          else if (hint.detail !== undefined && typeof hint.detail !== "string") at(`hints[${position}].detail must be a string`)
          else if (hint.kind === "prefix_break") checkDeclaration(hint, (problem) => at(`hints[${position}] (prefix_break) ${problem}`))
        })
    }
    if (value.headers !== undefined) {
      if (!isObject(value.headers)) at("headers must be an object of strings")
      else
        for (const [name, header] of Object.entries(value.headers)) {
          if (typeof header !== "string") at(`header ${name} must be a string`)
          if (name !== name.toLowerCase()) at(`header ${name} must be lowercase`)
          if (CREDENTIAL_HEADER.test(name)) at(`header ${name} may be a credential and must not be written`)
        }
    }
    if (value.source !== undefined && !isObject(value.source)) at("source must be an object")
    // 1.2: `interrupted` and `billing` (SPEC 2).
    if (value.interrupted !== undefined && typeof value.interrupted !== "boolean") at("interrupted must be a boolean")
    if (value.billing !== undefined && value.billing !== "per_token" && value.billing !== "subscription") at('billing must be "per_token" or "subscription"')

    const lane = `${value.session ?? ""}\u0000${value.lane ?? "main"}`
    if (value.fidelity === "usage-only") {
      if (value.request !== undefined) at("a usage-only record must not carry a request")
      return void records.push({ record: value, blocks: null })
    }
    if (!isObject(value.request) || !Array.isArray(value.request.blocks)) {
      at("request.blocks must be an array for a full-request record")
      return void records.push({ record: value, blocks: null })
    }
    const previous = lastFull.get(lane) ?? []
    const reuse = value.request.reuse ?? 0
    if (!isCount(reuse)) at("request.reuse must be a non-negative integer")
    else if (reuse > previous.length) at(`request.reuse ${reuse} exceeds the ${previous.length} blocks of the previous full request in the lane`)
    const own = value.request.blocks.flatMap((block, position): ResolvedBlock[] => {
      const where = `request.blocks[${position}]`
      if (!isObject(block)) return at(`${where} must be an object`), []
      if (typeof block.kind !== "string" || !KINDS.includes(block.kind)) at(`${where}.kind must be tool, system or message`)
      if (block.key !== undefined && typeof block.key !== "string") at(`${where}.key must be a string`)
      if (block.breakpoint !== undefined && typeof block.breakpoint !== "boolean") at(`${where}.breakpoint must be a boolean`)
      if (block.hash === undefined && block.content === undefined) return at(`${where} needs hash or content`), []
      // 1.2, SPEC 4.5 "Binary data": an elided block carries its hash, which is over the content as sent, not the content written.
      if (block.elided !== undefined && typeof block.elided !== "boolean") at(`${where}.elided must be a boolean`)
      const elided = block.elided === true
      if (elided && block.hash === undefined) return at(`${where} is elided and needs a hash`), []
      if (block.content !== undefined) {
        const found = binaryParts(block.content)
        // A writer SHOULD replace the base64 data; this harness always does, so any left is an error here.
        if (found.raw > 0) at(`${where} carries ${found.raw} base64 binary part(s); write each as its digest and size`)
        if (found.markers > 0 && !elided) at(`${where} has binary markers but is not marked elided`)
        if (found.markers === 0 && elided) at(`${where} is marked elided but has no binary marker`)
      }
      if (block.hash !== undefined && (typeof block.hash !== "string" || !HEX64.test(block.hash)))
        return at(`${where}.hash must be lowercase hex SHA-256`), []
      const hash = (block.hash as string | undefined) ?? traceHash(block.content)
      if (block.content !== undefined) {
        if (!elided && traceHash(block.content) !== hash) at(`${where}.hash does not match its content`)
        // SPEC 4.5: a writer SHOULD write each distinct block's content only the first time its hash appears.
        if (contents.has(hash)) at(`${where} repeats content already written for ${hash.slice(0, 12)}`)
        contents.set(hash, block.content)
        hashOnly.delete(hash)
        return [{ ...(block as unknown as ResolvedBlock), hash }]
      }
      if (!contents.has(hash)) hashOnly.add(hash)
      return [{ ...(block as unknown as ResolvedBlock), hash, ...(contents.has(hash) ? { content: contents.get(hash) } : {}) }]
    })
    const blocks = [...previous.slice(0, isCount(reuse) ? reuse : 0), ...own]
    const order = blocks.map((block) => KINDS.indexOf(block.kind))
    const outOfOrder = order.findIndex((rank, position) => position > 0 && rank < order[position - 1]!)
    if (outOfOrder !== -1) at(`block ${outOfOrder + 1}: blocks must be ordered tools, system, messages`)
    lastFull.set(lane, blocks)
    records.push({ record: value, blocks })
  })
  return { errors, records, redacted: hashOnly }
}

/**
 * SPEC 6.1. A reader drops a malformed declaration, so a writer that emits one
 * hides nothing but excuses nothing either: it is an error here. A writer
 * should use the reasons the spec names when one fits; these are the ones a
 * harness declares.
 */
const REASONS = ["compaction", "revert", "refusal", "model_switch", "settings_change"]

function checkDeclaration(hint: Record<string, unknown>, at: (problem: string) => void) {
  if (typeof hint.reason !== "string" || hint.reason === "") return at("needs a non-empty string reason")
  if (!REASONS.includes(hint.reason)) at(`reason ${hint.reason} is not one SPEC 6.1 names`)
  if (hint.after !== undefined && !isPosition(hint.after)) at('after must be "start", "tools", "system", {"message": n} or an integer >= 0')
}

function isPosition(value: unknown) {
  if (value === "start" || value === "tools" || value === "system") return true
  if (isCount(value)) return true
  return isObject(value) && Object.keys(value).length === 1 && isCount(value.message)
}

function checkUsage(usage: unknown, at: (problem: string) => void) {
  if (!isObject(usage)) return at("usage must be an object")
  for (const field of ["input_tokens", "cache_read_tokens", "output_tokens"])
    if (!isCount(usage[field])) at(`usage.${field} must be a non-negative integer`)
  if (!("cache_write_tokens" in usage)) at("usage.cache_write_tokens is required (null when the provider does not report writes)")
  else if (usage.cache_write_tokens !== null && !isCount(usage.cache_write_tokens)) at("usage.cache_write_tokens must be an integer or null")
  for (const field of ["cache_write_1h_tokens", "cache_write_12h_tokens", "reasoning_tokens"])
    if (usage[field] !== undefined && !isCount(usage[field])) at(`usage.${field} must be a non-negative integer`)
  if (usage.reported_cost !== undefined && !(typeof usage.reported_cost === "number" && usage.reported_cost >= 0))
    at("usage.reported_cost must be a non-negative number")
}

const MARKER = /^<binary (?:[^,>]+, )?\d+ bytes, sha256 [0-9a-f]{64}>$/

/**
 * SPEC 4.5: the binary parts in a block's content, written as data (`raw`) or
 * as the marker that replaces them (`markers`). Only the part shapes a
 * Responses body carries are looked for: `input_image` with a `data:` URL and
 * `input_file` with `file_data`.
 */
function binaryParts(content: unknown) {
  let raw = 0
  let markers = 0
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!isObject(value)) return
    const data = value.type === "input_image" ? value.image_url : value.type === "input_file" ? value.file_data : undefined
    if (typeof data === "string") {
      if (MARKER.test(data)) markers += 1
      else if (value.type === "input_file" || data.startsWith("data:")) raw += 1
      return
    }
    Object.values(value).forEach(walk)
  }
  walk(content)
  return { raw, markers }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
