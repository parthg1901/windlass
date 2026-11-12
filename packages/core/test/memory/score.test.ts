/** Outcome scoring from usage records. (The A/B comparison on evaluation results is `evals/memory-compare.ts`.) */
import { afterEach, describe, expect, test } from "bun:test"
import { planMemoryDelivery } from "../../src/memory/deliver.ts"
import { reviewReport } from "../../src/memory/hygiene.ts"
import { checkedPassRate, formatStats, memoryStats, usageForReview } from "../../src/memory/score.ts"
import { outcomeOfVerification } from "../../src/memory/usage.ts"
import { cleanup, fixture, save } from "./helpers.ts"

afterEach(cleanup)

describe("scoring", () => {
  test("outcomes are attributed to the notes held or read when the turn ended; corrections to the notes they name", () => {
    const { store, time } = fixture()
    const a = save(store, "Run migrations with `make migrate`.")
    const b = save(store, "The admin UI lives in apps/admin.")
    const deliver = (session: string) => {
      const plan = planMemoryDelivery({ session, known: null, records: [], entries: store.load().entries, now: time.now() })!
      store.recordUsage(plan.record)
    }
    const outcome = (session: string, kind: Parameters<typeof outcomeOfVerification>[0] | "interrupted" | "corrected_again" | "reverted", turn: number | null, entries: string[] | null = null) =>
      store.recordUsage({ type: "outcome", session, at: time.now().toISOString(), turn, outcome: kind === "interrupted" || kind === "corrected_again" || kind === "reverted" ? kind : outcomeOfVerification(kind), entries, note: null })

    deliver("ses_1")
    outcome("ses_1", "passed", 10)
    outcome("ses_1", "passed", 10) // the same turn reported twice counts once
    outcome("ses_1", "corrected_again", 20, [a.id])
    outcome("ses_1", "unresolved", 30)
    deliver("ses_2")
    store.recordUsage({ type: "read", session: "ses_2", at: time.now().toISOString(), query: "admin", ids: [b.id] })
    outcome("ses_2", "not_needed", 5)
    outcome("ses_2", "reverted", 9)
    // A session with memory on and nothing to deliver.
    outcome("ses_3", "passed", 4)
    outcome("ses_3", "interrupted", null)

    const stats = memoryStats(store.usage().records, store.load().entries, time.now())
    const of = (id: string) => stats.entries.find((entry) => entry.id === id)!
    expect(of(a.id)).toMatchObject({ deliveredSessions: 2, readSessions: 0, correctedAfter: 1, outcomes: { passed: 1, unresolved: 1, unchecked: 1, corrected_again: 1, reverted: 1, interrupted: 0 } })
    expect(of(b.id)).toMatchObject({ deliveredSessions: 2, readSessions: 1, correctedAfter: 0 })
    expect(stats.overall).toEqual({
      sessions: 3,
      sessionsWithNotes: 2,
      withNotes: { passed: 1, unchecked: 1, unresolved: 1, interrupted: 0, reverted: 1, corrected_again: 1 },
      withoutNotes: { passed: 1, unchecked: 0, unresolved: 0, interrupted: 1, reverted: 0, corrected_again: 0 },
    })
    expect(checkedPassRate(stats.overall.withNotes)).toBe(0.5)
    expect(checkedPassRate(stats.overall.withoutNotes)).toBe(1)
    const text = formatStats(stats)
    expect(text).toContain(`${a.id}        in force                         2     0  50% (1/2)                    1  1 passed, 1 unchecked, 1 unresolved, 1 reverted, 1 corrected again`)
    expect(text).toContain("These rates are observational")
    expect(reviewReport(store.load().entries, [], time.now(), { usage: usageForReview(stats) }).map((item) => [item.reason, item.id])).toEqual([["corrected-after-delivery", a.id]])
  })

  test("a note deleted by hand still has its history; a retracted one shows its status", () => {
    const { store, time } = fixture()
    const note = save(store, "Benchmarks run on the perf host.")
    store.recordUsage(planMemoryDelivery({ session: "s", known: null, records: [], entries: store.load().entries, now: time.now() })!.record)
    store.retract(note.id, "user", null)
    expect(memoryStats(store.usage().records, store.load().entries, time.now()).entries[0]).toMatchObject({ id: note.id, status: "retracted", deliveredSessions: 1 })
    expect(memoryStats(store.usage().records, [], time.now()).entries[0]).toMatchObject({ id: note.id, status: "not in the store", deliveredSessions: 1 })
  })
})
