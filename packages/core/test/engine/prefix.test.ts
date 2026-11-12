/**
 * The prefix property, end to end (context rule 1): over a session with
 * multi-step turns, steering, both kinds of retry, a cancel, a restart of
 * the process, a model switch, a refusal and a compaction, every step
 * request in the ledger is the previous step request plus appended blocks,
 * except exactly where an event in the log allows a break.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { checkPrefix } from "../../src/request/build-break.ts"
import { comparePrefix, hashRequest } from "../../src/request/prefix.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { FakeWorkspace, Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const usage = script.usage({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 })
const read = (path: string) => [script.toolCall("call_1", "read", { path }), usage]
const answer = (value: string) => [script.text(value), usage]

/** The verdict of every step request in the ledger against the one before it, from the log alone. */
function verdicts(h: Harness) {
  const projection = h.store.getProjection(h.session.id)!
  const rows = h.store.readRequests(h.session.id).filter((row) => row.purpose === "step")
  return rows.map((row, index) => {
    const previous = rows[index - 1]
    if (previous === undefined) return "first"
    // What was appended between the two requests: after the step the previous one served began, before this one's did.
    const seqOf = (id: string) => projection.messages.find((message) => message.id === id)!.seq
    const between = h.store.readEvents(h.session.id, { afterSeq: seqOf(previous.messageId) }).filter((item) => item.seq < seqOf(row.messageId))
    const verdict = checkPrefix(previous.blocks, row.blocks, between)
    return verdict.status === "expected_break" ? `break:${verdict.causes.join("+")}` : verdict.status
  })
}

describe("every step request extends the previous one except at a legitimate break", () => {
  test("across steering, retries, a cancel, a restart, a model switch, a refusal and a compaction", async () => {
    const h = new Harness()
    try {
      h.tools.on(
        "read",
        () => {
          h.session.send("Also look at b.ts.")
          return "export const a = 1"
        },
        "export const b = 2",
      )

      // Turn 1: a steer in the middle of a step, a transparent retry, and a retry after partial text.
      h.provider.enqueue(
        read("a.ts"),
        [script.fail("rate_limit", { retryAfterMs: 1000 })],
        read("b.ts"),
        [script.text("Both files ", { partial: true }), script.fail("provider_internal", { status: 500 })],
        answer("are fine."),
      )
      h.create().send("Look at a.ts.")
      await h.settled()

      // Turn 2 is cancelled in the middle of its answer; turn 3 follows the marker.
      h.provider.enqueue([script.text("Let me th", { partial: true }), script.hang()], answer("Yes."))
      h.session.send("Think about c.ts.")
      await h.seenText("Let me th")
      h.session.interrupt()
      await h.settled()
      h.session.send("Never mind. Is the build green?")
      await h.settled()

      // The process ends and another one carries the session on.
      await h.dispose()
      h.restart()

      // Turn 4: a queued follow-up, and the user switches the model while a tool runs.
      h.provider.enqueue(
        () => {
          h.session.queue("Then summarise.")
          return read("c.ts")
        },
        answer("c is 3."),
        answer("Summary: a, b and c."),
      )
      h.tools.on("read", () => {
        h.session.setSettings({ model: "gpt-other", reasoningEffort: "medium" })
        return "export const c = 3"
      })
      h.session.send("Now c.ts.")
      await h.settled()

      // Turn 5 is refused in its second step; turn 6 overflows and is compacted.
      h.provider.enqueue(read("s.txt"), [script.fail("content_policy", { message: "No." })])
      h.tools.on("read", "secret")
      h.session.send("Read the secret.")
      await h.settled()
      h.provider.enqueue([script.fail("context_overflow", { status: 400 })], [script.text("Summary of everything so far.")], answer("Done."), answer("Still here."))
      h.session.send("One more thing.")
      await h.settled()
      h.session.send("And another.")
      await h.settled()

      expect(h.diagnostics).toEqual([])
      expect(h.provider.remaining).toBe(0)
      expect(verdicts(h)).toEqual([
        "first",
        // turn 1: the steered step, the rate-limited attempt and its retry, the failed attempt and its continuation
        "extension",
        "extension",
        "extension",
        "extension",
        // turn 2 (cancelled) and turn 3
        "extension",
        "extension",
        // turn 4, across the restart; then the model switch, which is the first block of every request
        "extension",
        "break:settings",
        "extension",
        // turn 5; its second step is refused, so turn 6 no longer contains turn 5
        "extension",
        "extension",
        "break:refusal",
        // the rebuilt request after the compaction, and the turn after it
        "break:compaction",
        "extension",
      ])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("what the provider received is what the ledger hashed", async () => {
    const h = new Harness()
    try {
      h.provider.enqueue(read("a.ts"), answer("a is 1."))
      h.tools.on("read", "export const a = 1")
      h.create().send("Look at a.ts.")
      await h.settled()
      const rows = h.store.readRequests(h.session.id)
      expect(rows.map((row) => row.blocks)).toEqual(h.provider.requests.map(hashRequest))
      expect(rows.map((row) => row.outcome)).toEqual(["ok", "ok"])
      expect(rows.map((row) => row.usage?.cachedInputTokens)).toEqual([80, 80])
      expect(comparePrefix(rows[0]!.blocks, rows[1]!.blocks)).toMatchObject({ extension: true })
      // The cache key is the session's root ID on every request.
      expect(h.provider.requests.map((request) => request.params.cacheKey)).toEqual([h.session.id, h.session.id])
    } finally {
      await h.dispose()
    }
  })
})

describe("verification and revert keep the prefix property", () => {
  test("a check report is an appended message; a revert is a legitimate break; a revert that was undone is none", async () => {
    const h = new Harness({ workspace: new FakeWorkspace({ "a.ts": "1\n" }), config: { checks: [{ name: "test", command: "bun test" }] } })
    try {
      const write = (content: string) => [script.toolCall("call_1", "write", { path: "a.ts", content }), usage]
      const writes = (input: Record<string, unknown>) => {
        h.workspace!.files.set(String(input.path), String(input.content))
        return "Wrote a.ts"
      }
      h.tools.on("write", writes, writes)

      // Turn 1: the checks fail, the report sends the model back, the second run passes. Four requests.
      h.provider.enqueue(write("2\n"), answer("Done."), write("3\n"), answer("Fixed."))
      h.checks.on("test", "failed", "passed")
      h.create().send("Change a.ts.")
      await h.settled()

      // Turn 2 is reverted, and turn 3 is asked instead.
      h.provider.enqueue(answer("Nothing more."), answer("Yes?"))
      h.session.send("Anything else?")
      await h.settled()
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      h.session.send("One question.")
      await h.settled()

      // Turn 3 is reverted and the revert undone: history is what it was, so turn 4's request extends turn 3's.
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted" })
      h.provider.enqueue(answer("Go on."))
      h.session.send("And another.")
      await h.settled()

      expect(verdicts(h)).toEqual(["first", "extension", "extension", "extension", "extension", "break:revert", "extension"])
      // The report is where the third request grew: it is the last item, after the answer it responds to.
      const third = h.provider.requests[2]!
      expect(third.input.slice(0, h.provider.requests[1]!.input.length)).toEqual(h.provider.requests[1]!.input)
      expect(JSON.stringify(third.input.at(-1))).toContain('<harness origin=\\"check_report\\">')
      // The loop's own runtime check agreed: it reported nothing.
      expect(h.diagnostics).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})
