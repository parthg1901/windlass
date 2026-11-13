/**
 * The prefix property, end to end (context rule 1): over a session with
 * multi-step turns, steering, both kinds of retry, a cancel, a restart of
 * the process, a model switch, a refusal and a compaction, every step
 * request in the ledger is the previous step request plus appended blocks,
 * except exactly where an event in the log allows a break.
 */
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import type { StoredEvent } from "../../src/event/durable.ts"
import { checkPrefix } from "../../src/request/build-break.ts"
import { comparePrefix, hashRequest } from "../../src/request/prefix.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { NOT_A_SUMMARY, SUMMARY, measured } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, removeHarnessDirectories } from "./harness.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

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
      h.provider.enqueue([script.fail("context_overflow", { status: 400 })], [script.text(SUMMARY)], answer("Done."), answer("Still here."))
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

describe("a compaction is a legitimate break, once, and nothing around it is", () => {
  const at = (inputTokens: number) => script.usage(measured(inputTokens))
  const readAt = (path: string, inputTokens: number) => [script.toolCall("call_1", "read", { path }), at(inputTokens)]
  const answerAt = (value: string, inputTokens: number) => [script.text(value), at(inputTokens)]

  test("at a user-message boundary, in the middle of a turn, repaired, without a summary, held, and reverted", async () => {
    // A window of 10,000 tokens: due from 5,200, compacted from 6,400 (see the compaction scenarios).
    const h = new Harness({ contextWindow: 10_000 })
    try {
      h.tools.on("read", "one", "two", "three", "four", "five", "six")

      // Turn 1 crosses the early threshold; turn 2's message is where it is compacted. A steer arrives during the summary call.
      h.provider.enqueue(
        readAt("a.ts", 4800),
        answerAt("Read a.", 4900),
        () => {
          h.session.send("And c.ts.")
          return [script.text(SUMMARY)]
        },
        readAt("b.ts", 1500),
        answerAt("Read b and c.", 1700),
      )
      h.create().send("Read a.ts.")
      await h.settled()
      h.session.send("Now b.ts.")
      await h.settled()

      // Turn 3 is one long turn: compacted between two of its steps, with a summary that needs the repair.
      h.provider.enqueue(readAt("d.ts", 3000), readAt("e.ts", 6500), [script.text(NOT_A_SUMMARY)], [script.text(SUMMARY)], readAt("f.ts", 1800), answerAt("Read d, e and f.", 2000))
      h.session.send("Now d.ts, e.ts and f.ts.")
      await h.settled()

      // Turn 4: compacted without a usable summary. The request after it is measured almost as large as before, so
      // the next steps are held, and each still extends the one before it.
      h.provider.enqueue(readAt("g.ts", 6500), [script.text(NOT_A_SUMMARY)], [script.text("Still not one.")], readAt("h.ts", 6400), answerAt("Read g and h.", 6500))
      h.tools.on("read", "seven", "eight")
      h.session.send("Now g.ts and h.ts.")
      await h.settled()

      // Turn 4 is reverted: the range holds its compaction, which is undone with it. Turn 5 follows turn 3.
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      h.provider.enqueue(answerAt("Nothing else.", 2100))
      h.session.send("Anything else?")
      await h.settled()

      expect(h.diagnostics).toEqual([])
      expect(h.provider.remaining).toBe(0)
      expect(h.log().filter((item) => item.type === "compaction.ended").map((item) => item.data.source)).toEqual(["model", "repaired", "fallback"])
      expect(verdicts(h)).toEqual([
        "first",
        "extension",
        // turn 2: compacted before its first step; the steer that arrived meanwhile is in that first request
        "break:compaction",
        "extension",
        // turn 3: two steps, the compaction between steps, two more
        "extension",
        "extension",
        "break:compaction",
        "extension",
        // turn 4: one step, the compaction, then two held steps
        "extension",
        "break:compaction",
        "extension",
        // turn 5, after the revert that took turn 4 and its compaction out
        "break:revert",
      ])
      // Every summary request reads what it summarises from the cache: it extends the request before it (that step's
      // output and the prompt are appended; a repair appends the answer and the follow-up), or, when a tail is kept,
      // all of it but the prompt is a prefix of that request.
      const rows = h.store.readRequests(h.session.id)
      const summaries = rows.filter((row) => row.purpose === "compaction")
      expect(summaries).toHaveLength(5)
      for (const row of summaries) {
        const previous = rows[rows.indexOf(row) - 1]!
        const extends_ = comparePrefix(previous.blocks, row.blocks).extension
        const prefixOf = row.blocks.slice(0, -1).every((block, index) => previous.blocks[index]?.hash === block.hash)
        expect(extends_ || prefixOf).toBe(true)
      }
      // The first request after each compaction starts with the checkpoint, and the one after that extends it byte for byte.
      const steps = rows.filter((row) => row.purpose === "step")
      for (const index of [2, 6, 9]) expect(comparePrefix(steps[index]!.blocks, steps[index + 1]!.blocks)).toMatchObject({ extension: true })
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a refusal in a turn that was compacted in the middle takes the checkpoint out with the turn", async () => {
    const h = new Harness({ contextWindow: 10_000 })
    try {
      h.tools.on("read", "one", "secret")
      h.provider.enqueue(answerAt("Hello.", 1000), readAt("s.txt", 6500), [script.text(SUMMARY)], readAt("t.txt", 1500), [script.fail("content_policy", { message: "No." })], answerAt("Yes.", 1200))
      h.create().send("Hi.")
      await h.settled()
      h.session.send("Read the secret files.")
      await h.settled()
      // The refused turn is excluded from its first message on, and the compaction made inside it with it: its checkpoint quotes the turn.
      const projection = h.session.projection()
      expect(projection.session.compaction).toBeNull()
      expect(projection.messages.filter((message) => message.kind === "compaction").map((message) => message.excluded)).toEqual(["refused"])
      h.session.send("Still there?")
      await h.settled()
      const last = h.provider.requests.at(-1)!
      expect(JSON.stringify(last.input)).not.toContain("secret")
      expect(last.input.map((item) => item.type)).toEqual(["message", "assistant_text", "message"])
      expect(verdicts(h)).toEqual(["first", "extension", "break:compaction", "extension", "break:refusal"])
      expect(h.diagnostics).toEqual([])
      h.verify()
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
      expect(third.input.slice(0, h.provider.requests[1]!.input.length)).toEqual([...h.provider.requests[1]!.input])
      expect(JSON.stringify(third.input.at(-1))).toContain('<harness origin=\\"check_report\\">')
      // The loop's own runtime check agreed: it reported nothing.
      expect(h.diagnostics).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("the approval layer keeps the prefix property", () => {
  test("a question, an answer, a refusal, a taint notice and its clearing are not model input: every request extends the one before", async () => {
    const sandbox = {
      state: { available: true as const },
      temp: (sessionId: string) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
      plan: () => {
        throw new Error("a scripted tool spawns nothing")
      },
      policy: () => {
        throw new Error("a scripted tool spawns nothing")
      },
    }
    const h = new Harness({ approval: { sandbox, secrets: [], home: "/Users/user" }, attended: true })
    try {
      const fetch = (command: string) => [script.toolCall("call_1", "shell", { command, sandbox: { network: true } }), usage]
      h.tools.on("shell", "fetched").on("read", "notes")
      h.provider.enqueue(fetch("curl a"), fetch("curl b"), [script.toolCall("call_1", "write", { path: "~/.ssh/config", content: "x" }), usage], answer("Done."), [script.toolCall("call_1", "read", { path: "a.ts" }), usage], answer("Read."))
      const session = h.create()
      session.send("Fetch twice.")
      const first = (await h.seen((item) => item.type === "approval.requested")) as StoredEvent<"approval.requested">
      session.answer({ messageId: first.data.messageId, callId: first.data.callId }, { choice: "once" })
      const second = (await h.seen((item) => item.type === "approval.requested" && item.seq > first.seq)) as StoredEvent<"approval.requested">
      session.answer({ messageId: second.data.messageId, callId: second.data.callId }, { choice: "deny" })
      await h.settled()
      // Between turns the user clears the taint; the next turn's request still extends the last one.
      expect(session.clearTaint()).toBe(true)
      session.send("Now read a.ts.")
      await h.settled()

      const kinds: string[] = h.log().map((item) => item.type)
      for (const type of ["approval.requested", "approval.answered", "approval.denied", "taint.noticed", "taint.cleared"]) expect(kinds).toContain(type)
      expect(verdicts(h)).toEqual(["first", "extension", "extension", "extension", "extension", "extension"])
      expect(h.diagnostics).toEqual([])
      // The frozen tool list is the session's for good: the same in the first request and the last.
      expect(h.provider.requests.at(-1)!.tools).toEqual(h.provider.requests[0]!.tools)
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("the shell tool's schema carries the escalation argument for every session, whatever the machine or the mode", async () => {
    const { createStandardTools } = await import("../../src/tools/index.ts")
    const { escalationSchema } = await import("../../src/approval/escalation.ts")
    const { createCommandSandbox } = await import("../../src/sandbox/command.ts")
    const plain = createStandardTools({ spillDir: "/nonexistent" }).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    const sandboxed = createStandardTools({ spillDir: "/elsewhere", shell: { sandbox: createCommandSandbox({ tempBase: "/nonexistent/temp" }) } }).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    // The specs do not depend on the options: the frozen tool list hashes the same everywhere.
    expect(sandboxed).toEqual(plain)
    const shell = plain.find((tool) => tool.name === "shell")!
    expect((shell.inputSchema as { properties: Record<string, unknown> }).properties.sandbox).toEqual(escalationSchema)
    expect((shell.inputSchema as { required: string[] }).required).toEqual(["command"])
  })
})
