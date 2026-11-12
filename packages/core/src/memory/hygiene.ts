/**
 * Hygiene: pure functions over a loaded set of entries and a clock.
 *
 * - Expiry: `stateOf` derives `expired` from `expires` and `confirmed`; nothing is written when an entry lapses.
 * - Duplicates: `checkWrite` finds an exact or near duplicate of a new note in the same scope and says whether to
 *   merge (refresh the existing entry's confirmation) or reject, with the reason.
 * - Contradiction as supersession: a new entry names the one it replaces (`supersedes`). Both stay on disk; the
 *   older one is `superseded` as soon as its replacement is in force (active, expired or retracted later: the
 *   replacement was said, and retracting it does not bring back what it replaced). A pending or rejected
 *   replacement supersedes nothing, so content that came in untrusted cannot displace a note until the user
 *   confirms it.
 * - Budget: `selectForDelivery` keeps the delivered set within a per-scope size and drops from it, never from disk,
 *   by one fixed ranking.
 * - Review: `reviewReport` lists what a person should look at.
 */
import { type MemoryEntry, type MemoryKind, type MemoryScope, MEMORY_KINDS, oneLine } from "./entry.ts"

export type EntryState =
  | { readonly state: "active" }
  | { readonly state: "pending" }
  | { readonly state: "retracted" }
  | { readonly state: "rejected" }
  | { readonly state: "expired"; readonly at: string }
  | { readonly state: "superseded"; readonly by: string }

const DAY_MS = 86_400_000

/** When the entry lapses, or `null` for `never`. */
export function expiresAt(entry: Pick<MemoryEntry, "expires" | "confirmed">): Date | null {
  if (entry.expires.type === "never") return null
  if (entry.expires.type === "until") return new Date(Date.parse(`${entry.expires.date}T00:00:00Z`) + DAY_MS)
  return new Date(Date.parse(entry.confirmed) + entry.expires.days * DAY_MS)
}

export function isExpired(entry: Pick<MemoryEntry, "expires" | "confirmed">, now: Date): boolean {
  const at = expiresAt(entry)
  return at !== null && now.getTime() >= at.getTime()
}

/** Which entry replaced each superseded one: the earliest-created replacement in force, by ID on a tie. */
export function supersessions(entries: readonly MemoryEntry[]): ReadonlyMap<string, string> {
  const map = new Map<string, MemoryEntry>()
  for (const entry of entries) {
    if (entry.supersedes === null || entry.status === "pending" || entry.status === "rejected") continue
    const current = map.get(entry.supersedes)
    if (current === undefined || byCreated(entry, current) < 0) map.set(entry.supersedes, entry)
  }
  return new Map([...map].map(([id, by]) => [id, by.id]))
}

/** The effective state of every entry, by ID. Retraction and rejection come first, then pending, then supersession, then expiry. */
export function statesOf(entries: readonly MemoryEntry[], now: Date): ReadonlyMap<string, EntryState> {
  const replaced = supersessions(entries)
  return new Map(entries.map((entry) => [entry.id, stateOf(entry, replaced, now)]))
}

export function stateOf(entry: MemoryEntry, replaced: ReadonlyMap<string, string>, now: Date): EntryState {
  if (entry.status === "retracted") return { state: "retracted" }
  if (entry.status === "rejected") return { state: "rejected" }
  if (entry.status === "pending") return { state: "pending" }
  const by = replaced.get(entry.id)
  if (by !== undefined) return { state: "superseded", by }
  if (isExpired(entry, now)) return { state: "expired", at: expiresAt(entry)!.toISOString() }
  return { state: "active" }
}

/** Entries the model may be given: in force now. */
export function activeEntries(entries: readonly MemoryEntry[], now: Date): MemoryEntry[] {
  const states = statesOf(entries, now)
  return entries.filter((entry) => states.get(entry.id)?.state === "active")
}

// ---- duplicates ----

const STOPWORDS = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "at", "is", "are", "be", "it", "this", "that", "with", "by", "as"])

/** Lowercase, compatibility-normalised words without punctuation. */
export function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^\p{L}\p{N}_'./-]+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word !== "")
}

export function normalisedText(text: string): string {
  return words(text).join(" ")
}

/** Jaccard similarity of the content words of two notes, 0 to 1. */
export function similarity(a: string, b: string): number {
  const left = new Set(words(a).filter((word) => !STOPWORDS.has(word)))
  const right = new Set(words(b).filter((word) => !STOPWORDS.has(word)))
  if (left.size === 0 && right.size === 0) return 1
  const shared = [...left].filter((word) => right.has(word)).length
  return shared / (left.size + right.size - shared)
}

/** At or above this, two notes in one scope say the same thing. */
export const NEAR_DUPLICATE = 0.8

export type WriteCheck =
  | { readonly action: "accept" }
  /** The note is already there. The existing entry's `confirmed` is refreshed instead of writing a new one. */
  | { readonly action: "merge"; readonly into: string; readonly reason: string }
  | { readonly action: "reject"; readonly reason: string; readonly conflict: string | null }

export interface Candidate {
  readonly text: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly supersedes: string | null
  /** Whether the writer may refresh an existing entry (a trusted writer). An untrusted one is rejected instead. */
  readonly mayMerge: boolean
}

/** What to do with a new note, given what is stored. */
export function checkWrite(candidate: Candidate, entries: readonly MemoryEntry[], now: Date): WriteCheck {
  const states = statesOf(entries, now)
  if (candidate.supersedes !== null) {
    const target = entries.find((entry) => entry.id === candidate.supersedes)
    if (target === undefined) return { action: "reject", reason: `There is no memory note ${candidate.supersedes}. Use memory_search to find the note to replace.`, conflict: null }
    if (target.scope !== candidate.scope) return { action: "reject", reason: `${target.id} is a ${target.scope} note; a replacement must have the same scope.`, conflict: target.id }
    const state = states.get(target.id)!
    if (state.state !== "active" && state.state !== "expired")
      return { action: "reject", reason: `${target.id} is ${describeState(state)} and cannot be replaced.`, conflict: target.id }
  }
  const text = normalisedText(candidate.text)
  const live = entries.filter((entry) => {
    const state = states.get(entry.id)!.state
    return entry.scope === candidate.scope && entry.id !== candidate.supersedes && (state === "active" || state === "pending")
  })
  const exact = live.find((entry) => normalisedText(entry.text) === text)
  const near =
    exact ??
    live
      .map((entry) => ({ entry, score: similarity(entry.text, candidate.text) }))
      .filter((match) => match.score >= NEAR_DUPLICATE)
      .sort((a, b) => b.score - a.score || byCreated(a.entry, b.entry))[0]?.entry
  if (near === undefined) return { action: "accept" }
  const how = near === exact ? "the same as" : "nearly the same as"
  const pending = states.get(near.id)!.state === "pending"
  if (pending || !candidate.mayMerge || near.kind !== candidate.kind)
    return {
      action: "reject",
      reason: `This is ${how} ${near.id} (${pending ? "awaiting the user's confirmation" : near.kind}): "${oneLine(near.text)}". Nothing was saved. If the new note should replace it, retract ${near.id} with this note as the replacement.`,
      conflict: near.id,
    }
  return { action: "merge", into: near.id, reason: `This is ${how} ${near.id}: "${oneLine(near.text)}". No new note was saved; ${near.id} is marked as confirmed today.` }
}

export function describeState(state: EntryState): string {
  if (state.state === "superseded") return `superseded by ${state.by}`
  if (state.state === "expired") return `expired (${state.at.slice(0, 10)})`
  if (state.state === "pending") return "pending (awaiting the user's confirmation)"
  return state.state
}

// ---- budget ----

export interface ScopeBudget {
  readonly maxEntries: number
  /** Total characters of the delivered note lines of this scope. */
  readonly maxChars: number
}

export interface DeliveryLimits {
  readonly user: ScopeBudget
  readonly project: ScopeBudget
}

export const DELIVERY_LIMITS: DeliveryLimits = {
  user: { maxEntries: 20, maxChars: 2000 },
  project: { maxEntries: 40, maxChars: 4000 },
}

/**
 * The order in which entries are kept when a scope is over budget, best first; the delivered set is the longest
 * prefix of this order that fits. Fixed and total, so the same store and clock always give the same set:
 *   1. who stands behind it: written by the user; then by the model from the user's quoted words; then by the model alone;
 *   2. the most recently confirmed;
 *   3. the most recently created;
 *   4. the ID.
 * Usage counts play no part: ranking by what was used before would keep delivering what was delivered before.
 */
export function budgetRank(a: MemoryEntry, b: MemoryEntry): number {
  return backing(a) - backing(b) || cmp(b.confirmed, a.confirmed) || cmp(b.created, a.created) || cmp(a.id, b.id)
}

function backing(entry: MemoryEntry): number {
  if (entry.provenance.author === "user") return 0
  return entry.provenance.quote !== null ? 1 : 2
}

/** The order notes are shown in: user scope first, then by kind, then oldest first, then ID. */
export function displayOrder(a: MemoryEntry, b: MemoryEntry): number {
  return (
    (a.scope === b.scope ? 0 : a.scope === "user" ? -1 : 1) ||
    MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind) ||
    byCreated(a, b)
  )
}

export interface Selection {
  /** In display order. */
  readonly delivered: readonly MemoryEntry[]
  /** Active but over budget, in budget order. Still on disk and found by `memory_search`. */
  readonly dropped: readonly MemoryEntry[]
}

/** The active entries to deliver, within each scope's budget. `size` is the length of the line an entry is shown as. */
export function selectForDelivery(entries: readonly MemoryEntry[], now: Date, limits: DeliveryLimits, size: (entry: MemoryEntry) => number): Selection {
  const active = activeEntries(entries, now)
  const delivered: MemoryEntry[] = []
  const dropped: MemoryEntry[] = []
  for (const scope of ["user", "project"] as const) {
    const budget = limits[scope]
    let chars = 0
    let full = false
    for (const entry of active.filter((item) => item.scope === scope).sort(budgetRank)) {
      const length = size(entry) + 1
      // Once one entry does not fit, everything ranked below it is dropped too, so the cut is a prefix of the ranking.
      if (full || delivered.filter((item) => item.scope === scope).length >= budget.maxEntries || chars + length > budget.maxChars) {
        full = true
        dropped.push(entry)
        continue
      }
      chars += length
      delivered.push(entry)
    }
  }
  return { delivered: delivered.sort(displayOrder), dropped }
}

// ---- review ----

export type ReviewReason = "invalid-file" | "pending-confirmation" | "expires-soon" | "recently-expired" | "never-used" | "corrected-after-delivery"

export interface ReviewItem {
  readonly reason: ReviewReason
  /** The entry, or `null` for a file that does not parse. */
  readonly id: string | null
  readonly path: string | null
  readonly detail: string
}

export interface ReviewOptions {
  /** An active entry that lapses within this many days is listed. Default 14. */
  readonly expiringWithinDays?: number
  /** An entry that lapsed at most this many days ago is listed, so it can be renewed. Default 60. */
  readonly expiredWithinDays?: number
  /** Per-entry usage, from `score.ts`. */
  readonly usage?: ReadonlyMap<string, { readonly deliveredSessions: number; readonly readSessions: number; readonly correctedAfter: number }>
  /** Delivered to at least this many sessions and never read nor cited: listed as never used. Default 10. */
  readonly unusedAfterSessions?: number
}

/** What a person should look at, most urgent first. */
export function reviewReport(entries: readonly MemoryEntry[], problems: readonly { readonly path: string; readonly problem: string }[], now: Date, options: ReviewOptions = {}): ReviewItem[] {
  const soon = (options.expiringWithinDays ?? 14) * DAY_MS
  const lately = (options.expiredWithinDays ?? 60) * DAY_MS
  const unused = options.unusedAfterSessions ?? 10
  const states = statesOf(entries, now)
  const items: ReviewItem[] = problems.map((problem) => ({ reason: "invalid-file" as const, id: null, path: problem.path, detail: problem.problem }))
  for (const entry of [...entries].sort(byCreated)) {
    const state = states.get(entry.id)!
    const at = expiresAt(entry)
    const item = (reason: ReviewReason, detail: string) => items.push({ reason, id: entry.id, path: null, detail: `${detail}: "${oneLine(entry.text)}"` })
    if (state.state === "pending") item("pending-confirmation", `saved by the model after untrusted content entered session ${entry.provenance.session ?? "?"}; confirm or reject it`)
    if (state.state === "active" && at !== null && at.getTime() - now.getTime() <= soon) item("expires-soon", `expires ${at.toISOString().slice(0, 10)} unless renewed`)
    if (state.state === "expired" && at !== null && now.getTime() - at.getTime() <= lately) item("recently-expired", `expired ${at.toISOString().slice(0, 10)}; renew it if it is still true`)
    const usage = options.usage?.get(entry.id)
    if (state.state === "active" && usage !== undefined) {
      if (usage.correctedAfter > 0) item("corrected-after-delivery", `the user corrected the model on its subject in ${usage.correctedAfter} turn(s) after it was delivered`)
      else if (usage.deliveredSessions >= unused && usage.readSessions === 0) item("never-used", `delivered to ${usage.deliveredSessions} sessions, never searched for`)
    }
  }
  const order: ReviewReason[] = ["invalid-file", "pending-confirmation", "corrected-after-delivery", "expires-soon", "recently-expired", "never-used"]
  return items.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))
}

export function byCreated(a: Pick<MemoryEntry, "created" | "id">, b: Pick<MemoryEntry, "created" | "id">): number {
  return cmp(a.created, b.created) || cmp(a.id, b.id)
}

/** UTF-16 code unit order, the same on every machine. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
