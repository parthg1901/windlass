/**
 * One memory entry and its file form. Pure: parsing and rendering text, no I/O.
 *
 * An entry is one Markdown file, front matter then the note itself:
 *
 *   ---
 *   id: m_3f9a2c1b
 *   kind: preference
 *   scope: project
 *   status: active
 *   created: 2026-11-12T09:14:03Z
 *   confirmed: 2026-11-12T09:14:03Z
 *   expires: 365d
 *   author: model
 *   session: ses_01
 *   message: msg_07
 *   call: call_2
 *   seq: 17
 *   quote: "no, it's bun only here, never npm"
 *   ---
 *   Use bun to install and run scripts, never npm.
 *
 * Front matter is `key: value` lines. A value is either bare (the rest of the
 * line, trimmed) or a JSON string in double quotes; the writer quotes free
 * text (`quote`, `retract-reason`) and leaves tokens bare. Lines starting with
 * `#` are comments. An unknown key, a missing required key or a malformed
 * value makes the file invalid: a typo such as `expire: never` must not be
 * silently ignored. Optional keys are left out when they have no value.
 *
 * Required: `id`, `kind`, `scope`, `created`, and a non-empty body. Everything
 * else has a default, so a person can write an entry by hand with four lines
 * (`status: active`, `author: user`, `confirmed` = `created`, the kind's
 * default expiry).
 */
import { fingerprint } from "../instructions/source.ts"

export const MEMORY_KINDS = ["preference", "correction", "fact", "pointer"] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const MEMORY_SCOPES = ["user", "project"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * What the file says. `expired` and `superseded` are never stored: they follow
 * from the clock and from other entries (`hygiene.ts`), so an entry goes stale
 * without anything being written.
 * - `active`: in force.
 * - `pending`: saved by the model after untrusted content entered its session; not used until the user confirms it.
 * - `retracted`: withdrawn; kept on disk.
 * - `rejected`: a pending entry the user turned down; kept on disk.
 */
export const STORED_STATUSES = ["active", "pending", "retracted", "rejected"] as const
export type StoredStatus = (typeof STORED_STATUSES)[number]

/**
 * When an entry stops being delivered by itself.
 * - `confirm-within`: `days` after it was last confirmed (`expires: 90d`).
 * - `until`: after the end of that UTC day (`expires: 2027-03-01`).
 * - `never`: only by retraction (`expires: never`).
 */
export type Expiry = { readonly type: "confirm-within"; readonly days: number } | { readonly type: "until"; readonly date: string } | { readonly type: "never" }

export interface Provenance {
  /** Who wrote it: the user directly (a command, a hand-written file), or the model through `memory_save`. */
  readonly author: "user" | "model"
  /** The session it was written in, or `null` (a hand-written file). */
  readonly session: string | null
  /** The assistant message whose tool call wrote it, or the user message it was typed in. */
  readonly message: string | null
  /** The provider call ID of that tool call. */
  readonly call: string | null
  /** The position (`seq`) in the session's log of the user message `quote` comes from. */
  readonly seq: number | null
  /** The user's own words it was derived from, copied from that message. */
  readonly quote: string | null
  /** Written by the model in a session that had taken in untrusted content (see `trust.ts`). */
  readonly untrusted: boolean
}

export interface Retraction {
  readonly at: string
  readonly by: "user" | "model"
  readonly reason: string | null
}

export interface MemoryEntry {
  readonly id: string
  /** One short note. Shown to the model on one line (whitespace collapsed). */
  readonly text: string
  readonly kind: MemoryKind
  readonly scope: MemoryScope
  readonly status: StoredStatus
  /** ISO 8601, UTC, whole seconds. */
  readonly created: string
  /** When it was last confirmed to be still true: created, renewed by the user, or saved again. */
  readonly confirmed: string
  readonly expires: Expiry
  readonly provenance: Provenance
  /** The entry this one replaces. Both stay on disk; the older one counts as superseded once this one is in force. */
  readonly supersedes: string | null
  /** When the user confirmed a pending entry. */
  readonly userConfirmed: string | null
  readonly retracted: Retraction | null
}

/** Text a note may have at most, in characters. A note is one fact, not a document. */
export const MAX_TEXT_CHARS = 500
export const ID_PATTERN = /^m_[a-z0-9]{4,32}$/

/**
 * The default expiry of a new entry. Project facts and pointers go stale with
 * the code, so they lapse after 90 days without confirmation; facts about the
 * user, 180; preferences and corrections the user gave, a year.
 */
export function defaultExpiry(kind: MemoryKind, scope: MemoryScope): Expiry {
  if (kind === "preference" || kind === "correction") return { type: "confirm-within", days: 365 }
  return { type: "confirm-within", days: scope === "project" ? 90 : 180 }
}

/** A timestamp in the one form files use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function formatExpiry(expiry: Expiry): string {
  if (expiry.type === "never") return "never"
  if (expiry.type === "until") return expiry.date
  return `${expiry.days}d`
}

/** Parses `90d`, `2027-03-01` or `never`; `null` for anything else. */
export function parseExpiry(text: string): Expiry | null {
  if (text === "never") return { type: "never" }
  const days = /^(\d{1,5})d$/.exec(text)
  if (days !== null && Number(days[1]) > 0) return { type: "confirm-within", days: Number(days[1]) }
  if (isCalendarDate(text)) return { type: "until", date: text }
  return null
}

export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

/** A file that does not parse. Reported to the user; the file is never changed or removed because of it. */
export class MemoryFileError extends Error {
  constructor(
    readonly path: string,
    /** 1-based line of the problem, or `null` for the file as a whole. */
    readonly line: number | null,
    readonly problem: string,
  ) {
    super(`${path}${line === null ? "" : `:${line}`}: ${problem}`)
    this.name = "MemoryFileError"
  }
}

const KEYS = [
  "id",
  "kind",
  "scope",
  "status",
  "created",
  "confirmed",
  "expires",
  "author",
  "session",
  "message",
  "call",
  "seq",
  "quote",
  "untrusted",
  "supersedes",
  "user-confirmed",
  "retracted",
  "retracted-by",
  "retract-reason",
] as const
type Key = (typeof KEYS)[number]

/** The file text of an entry. Deterministic: the same entry always gives the same bytes. */
export function renderEntryFile(entry: MemoryEntry): string {
  const p = entry.provenance
  const fields: [Key, string | number | null, "bare" | "quoted"][] = [
    ["id", entry.id, "bare"],
    ["kind", entry.kind, "bare"],
    ["scope", entry.scope, "bare"],
    ["status", entry.status, "bare"],
    ["created", entry.created, "bare"],
    ["confirmed", entry.confirmed, "bare"],
    ["expires", formatExpiry(entry.expires), "bare"],
    ["author", p.author, "bare"],
    ["session", p.session, "quoted"],
    ["message", p.message, "quoted"],
    ["call", p.call, "quoted"],
    ["seq", p.seq, "bare"],
    ["quote", p.quote, "quoted"],
    ["untrusted", p.untrusted ? "yes" : null, "bare"],
    ["supersedes", entry.supersedes, "bare"],
    ["user-confirmed", entry.userConfirmed, "bare"],
    ["retracted", entry.retracted?.at ?? null, "bare"],
    ["retracted-by", entry.retracted?.by ?? null, "bare"],
    ["retract-reason", entry.retracted?.reason ?? null, "quoted"],
  ]
  const lines = fields.flatMap(([key, value, style]) => {
    if (value === null) return []
    const text = String(value)
    // IDs from the harness are plain tokens; quote anything else so the line always reads back the same.
    return [`${key}: ${style === "quoted" && !/^[A-Za-z0-9_.:-]+$/.test(text) ? JSON.stringify(text) : text}`]
  })
  return ["---", ...lines, "---", entry.text, ""].join("\n")
}

/** Reads an entry file. Throws `MemoryFileError` naming the line at fault. */
export function parseEntryFile(text: string, path: string): MemoryEntry {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")
  if (lines[0]?.trim() !== "---") throw new MemoryFileError(path, 1, 'expected the front matter to start with a line "---"')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) throw new MemoryFileError(path, null, 'the front matter is not closed with a line "---"')
  const values = new Map<Key, { value: string; line: number }>()
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index]!
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue
    const match = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/.exec(raw)
    if (match === null) throw new MemoryFileError(path, index + 1, `expected "key: value", got ${JSON.stringify(raw)}`)
    const key = match[1]!.toLowerCase()
    if (!(KEYS as readonly string[]).includes(key)) throw new MemoryFileError(path, index + 1, `unknown key "${key}"${suggest(key)}`)
    if (values.has(key as Key)) throw new MemoryFileError(path, index + 1, `"${key}" appears twice`)
    values.set(key as Key, { value: unquote(match[2]!.trim(), path, index + 1), line: index + 1 })
  }
  const body = lines.slice(end + 1).join("\n").trim()
  const get = (key: Key) => values.get(key)
  const fail = (key: Key, problem: string): never => {
    throw new MemoryFileError(path, get(key)?.line ?? null, `${key}: ${problem}`)
  }
  const required = (key: Key) => {
    const value = get(key)?.value
    if (value === undefined || value === "") fail(key, "is required")
    return value!
  }
  const optional = (key: Key) => {
    const value = get(key)?.value
    return value === undefined || value === "" ? null : value
  }
  const oneOfKey = <T extends string>(key: Key, allowed: readonly T[], fallback: T | null): T => {
    const value = fallback === null ? required(key) : (optional(key) ?? fallback)
    if (!(allowed as readonly string[]).includes(value)) fail(key, `expected one of ${allowed.join(", ")}, got "${value}"`)
    return value as T
  }
  const time = (key: Key, fallback: string | null) => {
    const value = fallback === null ? required(key) : (optional(key) ?? fallback)
    const date = new Date(value)
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(date.getTime())) fail(key, `expected a timestamp such as 2026-11-12T09:14:03Z, got "${value}"`)
    return isoSeconds(date)
  }

  const id = required("id")
  if (!ID_PATTERN.test(id)) fail("id", `expected "m_" followed by 4 to 32 lowercase letters or digits, got "${id}"`)
  const kind = oneOfKey("kind", MEMORY_KINDS, null)
  const scope = oneOfKey("scope", MEMORY_SCOPES, null)
  const status = oneOfKey("status", STORED_STATUSES, "active")
  const created = time("created", null)
  const confirmed = time("confirmed", created)
  const expiresText = optional("expires")
  const expires = expiresText === null ? defaultExpiry(kind, scope) : parseExpiry(expiresText)
  if (expires === null) fail("expires", `expected a number of days such as 90d, a date such as 2027-03-01, or never; got "${expiresText}"`)
  const author = oneOfKey("author", ["user", "model"] as const, "user")
  const seqText = optional("seq")
  if (seqText !== null && !/^[1-9]\d*$/.test(seqText)) fail("seq", `expected a positive whole number, got "${seqText}"`)
  const untrusted = oneOfKey("untrusted", ["yes", "no"] as const, "no") === "yes"
  const supersedes = optional("supersedes")
  if (supersedes !== null && !ID_PATTERN.test(supersedes)) fail("supersedes", `expected an entry ID such as m_3f9a2c1b, got "${supersedes}"`)
  if (supersedes === id) fail("supersedes", "an entry cannot replace itself")
  const retractedAt = optional("retracted") === null ? null : time("retracted", null)
  if (status === "retracted" && retractedAt === null) fail("status", 'a retracted entry needs "retracted: <timestamp>"')
  if (body === "") throw new MemoryFileError(path, end + 2, "the note itself (the text after the front matter) is empty")
  if ([...body].length > MAX_TEXT_CHARS) throw new MemoryFileError(path, end + 2, `the note is ${[...body].length} characters; at most ${MAX_TEXT_CHARS}`)
  return {
    id,
    text: body,
    kind,
    scope,
    status,
    created,
    confirmed,
    expires: expires!,
    provenance: {
      author,
      session: optional("session"),
      message: optional("message"),
      call: optional("call"),
      seq: seqText === null ? null : Number(seqText),
      quote: optional("quote"),
      untrusted,
    },
    supersedes,
    userConfirmed: optional("user-confirmed") === null ? null : time("user-confirmed", null),
    retracted: retractedAt === null ? null : { at: retractedAt, by: oneOfKey("retracted-by", ["user", "model"] as const, "user"), reason: optional("retract-reason") },
  }
}

function unquote(value: string, path: string, line: number): string {
  if (!value.startsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === "string") return parsed
  } catch {
    // reported below
  }
  throw new MemoryFileError(path, line, `a value starting with " must be a complete JSON string, got ${value}`)
}

function suggest(key: string): string {
  const close = KEYS.find((known) => known.startsWith(key.slice(0, 4)) || key.startsWith(known.slice(0, 4)))
  return close === undefined ? `; known keys: ${KEYS.join(", ")}` : `; did you mean "${close}"?`
}

/** The text of a note as the model sees it: one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Identity of an entry's content for change detection during a session. */
export function entryHash(rendered: string): string {
  return fingerprint(rendered).slice(0, 16)
}
