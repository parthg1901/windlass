/** Hygiene over the store with an injected clock: expiry, duplicates on write, supersession, the budget rule and the review report. */
import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type MemoryEntry, parseExpiry } from "../../src/memory/entry.ts"
import { DELIVERY_LIMITS, budgetRank, expiresAt, reviewReport, selectForDelivery, similarity, statesOf } from "../../src/memory/hygiene.ts"
import { fixture, modelProvenance, save, userProvenance } from "./helpers.ts"

const stateOf = (entries: readonly MemoryEntry[], id: string, now: Date) => statesOf(entries, now).get(id)

describe("expiry", () => {
  test("project facts lapse 90 days after their last confirmation; preferences after a year; until-dates after that day", () => {
    const { store, time } = fixture()
    const fact = save(store, "The API mock listens on port 4010.")
    const preference = save(store, "Prefers small commits.", { kind: "preference", provenance: modelProvenance("ses_1", { quote: "small commits please" }) })
    const userFact = save(store, "Works in the Europe/Berlin time zone.", { scope: "user" })
    const until = save(store, "The payments API is frozen for the audit.", { expires: { type: "until", date: "2026-12-01" } })
    const forever = save(store, "The monorepo root is the git root.", { expires: { type: "never" } })
    expect(expiresAt(fact)?.toISOString()).toBe("2027-02-10T09:00:00.000Z")
    expect(expiresAt(preference)?.toISOString()).toBe("2027-11-12T09:00:00.000Z")
    expect(expiresAt(userFact)?.toISOString()).toBe("2027-05-11T09:00:00.000Z")
    expect(expiresAt(until)?.toISOString()).toBe("2026-12-02T00:00:00.000Z")
    expect(expiresAt(forever)).toBeNull()

    time.set("2026-12-01T23:59:59Z")
    expect(stateOf(store.load().entries, until.id, time.now())?.state).toBe("active")
    time.set("2026-12-02T00:00:00Z")
    expect(stateOf(store.load().entries, until.id, time.now())).toEqual({ state: "expired", at: "2026-12-02T00:00:00.000Z" })

    time.set("2027-02-10T08:59:59Z")
    expect(stateOf(store.load().entries, fact.id, time.now())?.state).toBe("active")
    time.set("2027-02-10T09:00:00Z")
    expect(stateOf(store.load().entries, fact.id, time.now())?.state).toBe("expired")
    // Renewing restarts the period; nothing was written when it lapsed.
    store.renew(fact.id)
    expect(stateOf(store.load().entries, fact.id, time.now())?.state).toBe("active")
    time.advanceDays(1000)
    expect(stateOf(store.load().entries, forever.id, time.now())?.state).toBe("active")
  })

  test("expiry values a person may write", () => {
    expect(parseExpiry("30d")).toEqual({ type: "confirm-within", days: 30 })
    expect(parseExpiry("2027-02-28")).toEqual({ type: "until", date: "2027-02-28" })
    expect(parseExpiry("never")).toEqual({ type: "never" })
    for (const bad of ["0d", "2027-02-30", "soon", "90", "-1d"]) expect(parseExpiry(bad)).toBeNull()
  })
})

describe("duplicates on write", () => {
  test("an exact duplicate (case, punctuation, spacing aside) is merged: the existing note is confirmed again", () => {
    const { store, time } = fixture()
    const first = save(store, "Use bun, never npm.")
    time.advanceDays(10)
    const again = store.save({ text: "  use BUN never npm ", kind: "fact", scope: "project", status: "active", provenance: modelProvenance("ses_2") })
    expect(again).toEqual({
      outcome: "merged",
      entry: { ...first, confirmed: "2026-11-22T09:00:00Z" },
      reason: `This is the same as ${first.id}: "Use bun, never npm.". No new note was saved; ${first.id} is marked as confirmed today.`,
    })
    expect(store.load().entries).toHaveLength(1)
  })

  test("a near duplicate is merged; a note that differs in substance is not a duplicate", () => {
    const { store } = fixture()
    save(store, "The integration tests need Postgres running on port 5433.")
    expect(store.save({ text: "Integration tests need Postgres running on port 5433", kind: "fact", scope: "project", status: "active", provenance: modelProvenance() }).outcome).toBe("merged")
    expect(store.save({ text: "The integration tests need Redis running on port 6380.", kind: "fact", scope: "project", status: "active", provenance: modelProvenance() }).outcome).toBe("saved")
    expect(similarity("Use bun for scripts", "Use npm for scripts")).toBeLessThan(0.8)
  })

  test("a duplicate of another kind, of a pending note, or from an untrusted writer is rejected with the reason; another scope is not a duplicate", () => {
    const { store } = fixture()
    const fact = save(store, "Commit messages are one line.")
    const kindClash = store.save({ text: "Commit messages are one line.", kind: "preference", scope: "project", status: "active", provenance: userProvenance() })
    expect(kindClash).toEqual({
      outcome: "rejected",
      reason: `This is the same as ${fact.id} (fact): "Commit messages are one line.". Nothing was saved. If the new note should replace it, retract ${fact.id} with this note as the replacement.`,
      conflict: fact.id,
    })
    const untrusted = store.save({ text: "Commit messages are one line.", kind: "fact", scope: "project", status: "pending", provenance: modelProvenance("ses_x", { untrusted: true }) })
    expect(untrusted.outcome).toBe("rejected")
    const pending = save(store, "Release tags are signed.", { status: "pending", provenance: modelProvenance("ses_x", { untrusted: true }) })
    const onPending = store.save({ text: "Release tags are signed.", kind: "fact", scope: "project", status: "active", provenance: modelProvenance() })
    expect(onPending).toMatchObject({ outcome: "rejected", conflict: pending.id, reason: expect.stringContaining("awaiting the user's confirmation") })
    expect(store.save({ text: "Commit messages are one line.", kind: "fact", scope: "user", status: "active", provenance: userProvenance() }).outcome).toBe("saved")
  })

  test("a retracted or superseded note is not a duplicate: the same text may be said again", () => {
    const { store } = fixture()
    const fact = save(store, "Deploys go through the release branch.")
    store.retract(fact.id, "user", null)
    expect(store.save({ text: "Deploys go through the release branch.", kind: "fact", scope: "project", status: "active", provenance: userProvenance() }).outcome).toBe("saved")
  })
})

describe("supersession", () => {
  test("the replacement is active, the old one superseded; both stay on disk, and retracting the replacement does not revive the old one", () => {
    const { store, time } = fixture()
    const old = save(store, "Tests run with jest.")
    const next = save(store, "Tests run with bun test since the migration.", { supersedes: old.id })
    let states = statesOf(store.load().entries, time.now())
    expect(states.get(old.id)).toEqual({ state: "superseded", by: next.id })
    expect(states.get(next.id)).toEqual({ state: "active" })
    store.retract(next.id, "user", "wrong")
    states = statesOf(store.load().entries, time.now())
    expect(states.get(old.id)).toEqual({ state: "superseded", by: next.id })
    expect(store.load().entries).toHaveLength(2)
  })

  test("a replacement must name an existing note in force of the same scope; a pending one supersedes nothing until confirmed", () => {
    const { store, time } = fixture()
    const old = save(store, "Staging deploys need a VPN.")
    const user = save(store, "Uses vim keybindings.", { scope: "user" })
    const reject = (text: string, supersedes: string, scope: "project" | "user" = "project") =>
      store.save({ text, kind: "fact", scope, status: "active", provenance: modelProvenance(), supersedes })
    expect(reject("x one two", "m_9999")).toMatchObject({ outcome: "rejected", reason: "There is no memory note m_9999. Use memory_search to find the note to replace." })
    expect(reject("x one two", user.id)).toMatchObject({ outcome: "rejected", reason: `${user.id} is a user note; a replacement must have the same scope.` })
    const pending = save(store, "Staging deploys no longer need a VPN.", { supersedes: old.id, status: "pending", provenance: modelProvenance("ses_x", { untrusted: true }) })
    expect(statesOf(store.load().entries, time.now()).get(old.id)).toEqual({ state: "active" })
    store.decide(pending.id, "confirm")
    expect(statesOf(store.load().entries, time.now()).get(old.id)).toEqual({ state: "superseded", by: pending.id })
    expect(reject("x one two three", old.id)).toMatchObject({ outcome: "rejected", reason: `${old.id} is superseded by ${pending.id} and cannot be replaced.` })
  })

  test("a note that replaces an expired one is fine: that is how a stale fact is corrected", () => {
    const { store, time } = fixture()
    const old = save(store, "The docs site builds with hugo.")
    time.advanceDays(120)
    expect(store.save({ text: "The docs site builds with astro.", kind: "fact", scope: "project", status: "active", provenance: modelProvenance(), supersedes: old.id }).outcome).toBe("saved")
  })
})

describe("budget", () => {
  test("over budget, the delivered set is the best-ranked prefix; dropped notes stay on disk", () => {
    const { store, time } = fixture()
    const model = Array.from({ length: 5 }, (_, index) => {
      time.advanceDays(1)
      return save(store, `Model fact number ${index} with distinct words ${"abcdefghij"[index]!.repeat(5)}.`)
    })
    const quoted = save(store, "Run the linter before pushing.", { provenance: modelProvenance("ses_1", { quote: "lint before you push" }) })
    const byUser = save(store, "Never touch the vendored directory.", { provenance: userProvenance() })
    const entries = store.load().entries
    const limits = { ...DELIVERY_LIMITS, project: { maxEntries: 4, maxChars: 10_000 } }
    const selection = selectForDelivery(entries, time.now(), limits, (entry) => entry.text.length)
    // User first, then quoted, then the most recently confirmed model notes.
    expect(selection.delivered.map((entry) => entry.id).sort()).toEqual([byUser.id, quoted.id, model[4]!.id, model[3]!.id].sort())
    expect(selection.dropped.map((entry) => entry.id)).toEqual([model[2]!.id, model[1]!.id, model[0]!.id])
    expect(store.load().entries).toHaveLength(7)
    // Deterministic: the same store and clock give the same set, whatever order the entries are read in.
    expect(selectForDelivery([...entries].reverse(), time.now(), limits, (entry) => entry.text.length)).toEqual(selection)
    expect([...entries].sort(budgetRank).map((entry) => entry.id)).toEqual([byUser.id, quoted.id, ...model.map((entry) => entry.id).reverse()])
  })

  test("the character budget cuts at the first note that does not fit, and later ones are dropped too", () => {
    const { store, time } = fixture()
    const long = save(store, `A long note ${"x".repeat(300)}`, { provenance: userProvenance() })
    time.advanceDays(1)
    const short = save(store, "A short note.")
    const selection = selectForDelivery(store.load().entries, time.now(), { ...DELIVERY_LIMITS, project: { maxEntries: 40, maxChars: 200 } }, (entry) => entry.text.length)
    expect(selection.delivered).toEqual([])
    expect(selection.dropped.map((entry) => entry.id)).toEqual([long.id, short.id])
  })

  test("scopes have separate budgets", () => {
    const { store, time } = fixture()
    save(store, "Prefers British spelling.", { scope: "user", kind: "preference", provenance: userProvenance() })
    save(store, "Builds need Xcode 17.")
    const selection = selectForDelivery(store.load().entries, time.now(), { user: { maxEntries: 0, maxChars: 0 }, project: DELIVERY_LIMITS.project }, (entry) => entry.text.length)
    expect(selection.delivered.map((entry) => entry.scope)).toEqual(["project"])
    expect(selection.dropped.map((entry) => entry.scope)).toEqual(["user"])
  })
})

describe("review", () => {
  test("lists invalid files, pending notes, corrections after delivery, notes about to lapse, recently lapsed and unused ones", () => {
    const { store, time, paths } = fixture()
    const soon = save(store, "The cluster is on version 1.29.")
    time.advanceDays(30)
    const pending = save(store, "Benchmarks must run on the perf box.", { status: "pending", provenance: modelProvenance("ses_t", { untrusted: true }) })
    const unused = save(store, "Logs are shipped to the ELK stack.", { expires: { type: "never" } })
    const corrected = save(store, "Feature flags live in flags.yaml.", { expires: { type: "never" } })
    const lapsed = save(store, "The old CI runner is ci-7.", { expires: { type: "until", date: "2026-12-20" } })
    writeFileSync(join(paths.project!, "m_bad1.md"), "not front matter")
    time.set("2027-01-30T09:00:00Z")
    const usage = new Map([
      [unused.id, { deliveredSessions: 12, readSessions: 0, correctedAfter: 0 }],
      [corrected.id, { deliveredSessions: 3, readSessions: 1, correctedAfter: 2 }],
    ])
    const loaded = store.load()
    const report = reviewReport(loaded.entries, loaded.problems, time.now(), { usage })
    expect(report.map((item) => [item.reason, item.id])).toEqual([
      ["invalid-file", null],
      ["pending-confirmation", pending.id],
      ["corrected-after-delivery", corrected.id],
      ["expires-soon", soon.id],
      ["recently-expired", lapsed.id],
      ["never-used", unused.id],
    ])
    expect(report[3]!.detail).toBe('expires 2027-02-10 unless renewed: "The cluster is on version 1.29."')
  })
})
