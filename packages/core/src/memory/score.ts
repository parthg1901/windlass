/**
 * Outcome scoring from the usage log: which notes each session was given or looked up, and how the turns that
 * followed ended. Per note and overall, as text a person can read.
 *
 * Attribution: a turn's outcome counts for every note the model held (the latest delivery before it) or had read
 * (`memory_search`) in that session before the outcome was recorded. A `corrected_again` outcome that names notes
 * counts against those notes specifically (`correctedAfter`): the user had to correct the model on a subject a
 * note it held already covered, which says the note did not do its job, or is wrong.
 *
 * This is observational. Sessions that receive notes differ from sessions that do not (older projects, returning
 * users), so the "with notes" and "without" rates here are not evidence that notes help. They point a person at
 * notes to review. Whether memory stays is decided by the A/B comparison (`evals/memory-compare.ts`).
 */
import type { MemoryEntry } from "./entry.ts"
import { type EntryState, statesOf } from "./hygiene.ts"
import { OUTCOMES, type Outcome, type UsageRecord } from "./usage.ts"

export type OutcomeCounts = Record<Outcome, number>

export interface EntryStats {
  readonly id: string
  readonly text: string
  /** `in force`, `retracted`, ...; `not in the store` for a note deleted by hand. */
  readonly status: string
  readonly deliveredSessions: number
  readonly readSessions: number
  /** Turns that ended while the model held or had read this note, by outcome. */
  readonly outcomes: OutcomeCounts
  readonly correctedAfter: number
}

export interface OverallStats {
  readonly sessions: number
  readonly sessionsWithNotes: number
  /** Turns that ended with at least one note held or read, by outcome. */
  readonly withNotes: OutcomeCounts
  /** Turns that ended with no note held or read. */
  readonly withoutNotes: OutcomeCounts
}

export interface MemoryStats {
  readonly entries: readonly EntryStats[]
  readonly overall: OverallStats
}

const zero = (): Record<Outcome, number> => Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>

export function memoryStats(records: readonly UsageRecord[], entries: readonly MemoryEntry[], now: Date): MemoryStats {
  const sessions = new Map<string, UsageRecord[]>()
  for (const record of records) sessions.set(record.session, [...(sessions.get(record.session) ?? []), record])
  const per = new Map<string, { delivered: Set<string>; read: Set<string>; outcomes: OutcomeCounts; corrected: number }>()
  const of = (id: string) => {
    const existing = per.get(id)
    if (existing !== undefined) return existing
    const created = { delivered: new Set<string>(), read: new Set<string>(), outcomes: zero(), corrected: 0 }
    per.set(id, created)
    return created
  }
  const withNotes = zero()
  const withoutNotes = zero()
  let sessionsWithNotes = 0
  for (const [session, list] of sessions) {
    let held = new Set<string>()
    const read = new Set<string>()
    const seenTurns = new Set<string>()
    let any = false
    for (const record of list) {
      if (record.type === "delivered") {
        held = new Set(record.held.map((note) => note.id))
        for (const id of held) of(id).delivered.add(session)
        if (held.size > 0) any = true
        continue
      }
      if (record.type === "read") {
        for (const id of record.ids) {
          read.add(id)
          of(id).read.add(session)
        }
        if (record.ids.length > 0) any = true
        continue
      }
      if (record.turn !== null) {
        const key = `${record.turn}:${record.outcome}`
        if (seenTurns.has(key)) continue
        seenTurns.add(key)
      }
      const exposed = new Set([...held, ...read])
      for (const id of exposed) of(id).outcomes[record.outcome] += 1
      if (record.outcome === "corrected_again") for (const id of record.entries ?? []) if (exposed.has(id)) of(id).corrected += 1
      ;(exposed.size > 0 ? withNotes : withoutNotes)[record.outcome] += 1
    }
    if (any) sessionsWithNotes += 1
  }
  const states = statesOf(entries, now)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const ids = [...new Set([...entries.map((entry) => entry.id), ...per.keys()])].sort()
  return {
    entries: ids.map((id) => {
      const usage = per.get(id)
      const entry = byId.get(id)
      const state = states.get(id)
      return {
        id,
        text: entry?.text.replace(/\s+/g, " ").trim() ?? "",
        status: state === undefined ? "not in the store" : shortState(state),
        deliveredSessions: usage?.delivered.size ?? 0,
        readSessions: usage?.read.size ?? 0,
        outcomes: usage?.outcomes ?? zero(),
        correctedAfter: usage?.corrected ?? 0,
      }
    }),
    overall: { sessions: sessions.size, sessionsWithNotes, withNotes, withoutNotes },
  }
}

function shortState(state: EntryState): string {
  if (state.state === "active") return "in force"
  if (state.state === "superseded") return `superseded by ${state.by}`
  if (state.state === "expired") return `expired ${state.at.slice(0, 10)}`
  return state.state
}

/** Per-note usage in the shape `reviewReport` takes. */
export function usageForReview(stats: MemoryStats) {
  return new Map(stats.entries.map((entry) => [entry.id, { deliveredSessions: entry.deliveredSessions, readSessions: entry.readSessions, correctedAfter: entry.correctedAfter }]))
}

/** Passed among turns whose checks decided something (passed or unresolved), or `null` when there were none. */
export function checkedPassRate(counts: OutcomeCounts): number | null {
  const checked = counts.passed + counts.unresolved
  return checked === 0 ? null : counts.passed / checked
}

export function formatStats(stats: MemoryStats): string {
  const rate = (counts: OutcomeCounts) => {
    const value = checkedPassRate(counts)
    return value === null ? "-" : `${Math.round(value * 100)}% (${counts.passed}/${counts.passed + counts.unresolved})`
  }
  const tally = (counts: OutcomeCounts) =>
    OUTCOMES.filter((outcome) => counts[outcome] > 0)
      .map((outcome) => `${counts[outcome]} ${outcome.replace("_", " ")}`)
      .join(", ") || "no turns"
  const lines = [
    `Memory usage over ${stats.overall.sessions} session(s), ${stats.overall.sessionsWithNotes} of them given or reading notes.`,
    "",
    "note          status                    sessions  read  checks passed   corrected after  turns",
    ...stats.entries.map(
      (entry) =>
        `${entry.id.padEnd(13)} ${entry.status.padEnd(25)} ${String(entry.deliveredSessions).padStart(8)}  ${String(entry.readSessions).padStart(4)}  ${rate(entry.outcomes).padEnd(14)} ${String(entry.correctedAfter).padStart(15)}  ${tally(entry.outcomes)}`,
    ),
    "",
    `Turns with notes:    ${tally(stats.overall.withNotes)}; checks passed ${rate(stats.overall.withNotes)}`,
    `Turns without notes: ${tally(stats.overall.withoutNotes)}; checks passed ${rate(stats.overall.withoutNotes)}`,
    "These rates are observational: sessions that get notes differ from those that do not. Use them to find notes to review; whether memory helps is decided by the A/B comparison.",
  ]
  return lines.join("\n")
}
