/**
 * Diagnostics as the module keeps them, and the comparison that decides what
 * an edit made worse. Pure.
 *
 * "Made worse" is decided without trusting line numbers, because an edit moves
 * every line below it. A diagnostic after the edit is pre-existing when the
 * same diagnostic was there before, matched in two passes:
 *
 * 1. By identity: the same severity, source, code and message, on a line with
 *    the same text (whitespace collapsed, so re-indented code matches) and the
 *    same text under its range. This finds a diagnostic wherever its line went:
 *    shifted by lines added above it, or in code that was moved.
 * 2. By place: the same severity, source, code and message, at the line the
 *    old one's line maps to through the edit (lines above the changed region
 *    keep their number, lines below it shift by the change in length), or both
 *    inside the changed region. This keeps a diagnostic whose own line the edit
 *    touched (`let x = 1` became `let x = 2`; the variable is still unused).
 *
 * Matching is one to one (a multiset): a line copied with its error is one new
 * error, not zero. Within a group of equals, pairs are made nearest first, so
 * the copy farther from where the original was is the one reported as new.
 */

export interface Position {
  /** Zero-based, as on the wire. */
  readonly line: number
  /** Zero-based UTF-16 code units, as on the wire (the client offers only `utf-16`). */
  readonly character: number
}

export type Severity = 1 | 2 | 3 | 4

export interface Diagnostic {
  readonly range: { readonly start: Position; readonly end: Position }
  /** 1 error, 2 warning, 3 information, 4 hint. A diagnostic without one is an error. */
  readonly severity: Severity
  readonly code: string | null
  readonly source: string | null
  readonly message: string
}

export const SEVERITY_NAMES: Readonly<Record<Severity, string>> = { 1: "error", 2: "warning", 3: "information", 4: "hint" }

/** At most this many diagnostics of one publication are kept; the rest are counted. */
export const MAX_KEPT_DIAGNOSTICS = 5000
const MAX_MESSAGE_KEY_CHARS = 1000
const MAX_RANGE_TEXT_CHARS = 200

export interface DiagnosticSet {
  readonly diagnostics: readonly Diagnostic[]
  /** How many the server sent, kept or not. */
  readonly total: number
  /** Items that were not diagnostics. */
  readonly invalid: number
}

/** Reads a server's `diagnostics` array leniently: a bad item is counted and skipped, never fatal. */
export function parseDiagnostics(value: unknown, limit = MAX_KEPT_DIAGNOSTICS): DiagnosticSet {
  if (!Array.isArray(value)) return { diagnostics: [], total: 0, invalid: value === undefined || value === null ? 0 : 1 }
  const diagnostics: Diagnostic[] = []
  let invalid = 0
  for (const item of value) {
    if (diagnostics.length >= limit) break
    const parsed = parseDiagnostic(item)
    if (parsed === null) invalid += 1
    else diagnostics.push(parsed)
  }
  return { diagnostics, total: value.length, invalid }
}

function parseDiagnostic(item: unknown): Diagnostic | null {
  if (!isObject(item) || typeof item.message !== "string" || !isObject(item.range)) return null
  const start = position(item.range.start)
  const end = position(item.range.end)
  if (start === null || end === null) return null
  const severity = item.severity === 1 || item.severity === 2 || item.severity === 3 || item.severity === 4 ? item.severity : 1
  const code = typeof item.code === "string" ? item.code : typeof item.code === "number" && Number.isFinite(item.code) ? String(item.code) : null
  const source = typeof item.source === "string" && item.source !== "" ? item.source : null
  return { range: { start, end }, severity, code, source, message: item.message }
}

function position(value: unknown): Position | null {
  if (!isObject(value)) return null
  const { line, character } = value
  if (typeof line !== "number" || typeof character !== "number" || !Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0) return null
  return { line, character }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A document's text and the diagnostics the server gave for exactly that text. */
export interface Snapshot {
  readonly text: string
  readonly diagnostics: readonly Diagnostic[]
}

export interface Comparison {
  /** Diagnostics of the reported severities that the edit introduced, in document order. */
  readonly added: readonly Diagnostic[]
  /** Diagnostics of the reported severities present after the edit that were there before it. */
  readonly preExisting: number
  /** Diagnostics of the reported severities that were there before and are gone. */
  readonly fixed: number
  /** Everything the server reported after the edit, of any severity. */
  readonly afterTotal: number
}

/**
 * What the edit from `before` to `after` made worse. Only diagnostics whose
 * severity is in `severities` (errors only by default) are compared or counted;
 * the others are ignored on both sides.
 */
export function compareDiagnostics(before: Snapshot, after: Snapshot, severities: ReadonlySet<Severity> = new Set([1])): Comparison {
  const beforeLines = before.text.split("\n")
  const afterLines = after.text.split("\n")
  const map = lineMap(beforeLines, afterLines)
  const olds: Old[] = before.diagnostics.filter((d) => severities.has(d.severity)).map((d, o) => ({ d, at: map(d.range.start.line), used: false, o }))
  const news: New[] = after.diagnostics.filter((d) => severities.has(d.severity)).map((d, n) => ({ d, used: false, n }))

  const pass = (keyOld: (d: Diagnostic) => string, keyNew: (d: Diagnostic) => string, fits: (old: Old, line: number) => boolean) => {
    const groups = new Map<string, { olds: Old[]; news: New[] }>()
    for (const old of olds) if (!old.used) {
      const key = keyOld(old.d)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { olds: [old], news: [] })
      else group.olds.push(old)
    }
    for (const neu of news) if (!neu.used) groups.get(keyNew(neu.d))?.news.push(neu)
    for (const group of groups.values()) matchGroup(group.olds, group.news, fits)
  }

  pass((d) => identity(d, beforeLines), (d) => identity(d, afterLines), () => true)
  pass(
    kind,
    kind,
    (old, line) =>
      old.at.kind === "mapped" ? old.at.line === line : line >= old.at.from && line < old.at.to,
  )

  const added = news.filter((entry) => !entry.used).map((entry) => entry.d).sort(documentOrder)
  return {
    added,
    preExisting: news.length - added.length,
    fixed: olds.filter((old) => !old.used).length,
    afterTotal: after.diagnostics.length,
  }
}

type Old = { readonly d: Diagnostic; readonly at: Mapped; used: boolean; readonly o: number }
type New = { readonly d: Diagnostic; used: boolean; readonly n: number }

/** Pairs within a group above this size are made in document order instead of nearest first (a flood of equals). */
const MAX_PAIRS = 10_000

/** Pairs equal diagnostics one to one: nearest first, ties by position, so the result is deterministic. */
function matchGroup(olds: readonly Old[], news: readonly New[], fits: (old: Old, line: number) => boolean) {
  const target = (old: Old) => (old.at.kind === "mapped" ? old.at.line : old.at.from)
  if (olds.length * news.length > MAX_PAIRS) {
    const sortedOld = [...olds].sort((a, b) => target(a) - target(b) || a.o - b.o)
    const sortedNew = [...news].sort((a, b) => a.d.range.start.line - b.d.range.start.line || a.n - b.n)
    let index = 0
    for (const neu of sortedNew) {
      while (index < sortedOld.length && !fits(sortedOld[index]!, neu.d.range.start.line)) index += 1
      if (index >= sortedOld.length) break
      sortedOld[index]!.used = true
      neu.used = true
      index += 1
    }
    return
  }
  const pairs: { old: Old; neu: New; distance: number }[] = []
  for (const neu of news)
    for (const old of olds) {
      const line = neu.d.range.start.line
      if (fits(old, line)) pairs.push({ old, neu, distance: Math.abs(target(old) - line) })
    }
  pairs.sort((a, b) => a.distance - b.distance || a.neu.n - b.neu.n || a.old.o - b.old.o)
  for (const pair of pairs) {
    if (pair.old.used || pair.neu.used) continue
    pair.old.used = true
    pair.neu.used = true
  }
}

/** Severity, source, code and message: what a diagnostic says, wherever it is. */
function kind(d: Diagnostic): string {
  return JSON.stringify([d.severity, d.source, d.code, d.message.slice(0, MAX_MESSAGE_KEY_CHARS)])
}

/** What it says and the code it says it about. */
function identity(d: Diagnostic, lines: readonly string[]): string {
  const line = lines[d.range.start.line] ?? ""
  const end = d.range.end.line === d.range.start.line ? d.range.end.character : line.length
  const under = line.slice(d.range.start.character, Math.max(d.range.start.character, end)).slice(0, MAX_RANGE_TEXT_CHARS)
  return JSON.stringify([kind(d), collapse(line), collapse(under)])
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

type Mapped = { readonly kind: "mapped"; readonly line: number } | { readonly kind: "changed"; readonly from: number; readonly to: number }

/**
 * Where a line of `before` is in `after`: the lines both texts share at the
 * start and at the end keep their place (shifted, for the end); a line between
 * them is in the changed region, `[from, to)` of `after`.
 */
export function lineMap(before: readonly string[], after: readonly string[]): (line: number) => Mapped {
  let prefix = 0
  const shortest = Math.min(before.length, after.length)
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  const shift = after.length - before.length
  const from = prefix
  // An empty changed region (pure deletion) still has a place: the line where the deletion was.
  const to = Math.max(after.length - suffix, prefix + 1)
  return (line) => {
    if (line < prefix) return { kind: "mapped", line }
    if (line >= before.length - suffix) return { kind: "mapped", line: line + shift }
    return { kind: "changed", from, to }
  }
}

export function documentOrder(a: Diagnostic, b: Diagnostic): number {
  return (
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    a.severity - b.severity ||
    compare(a.code ?? "", b.code ?? "") ||
    compare(a.message, b.message) ||
    compare(a.source ?? "", b.source ?? "")
  )
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
