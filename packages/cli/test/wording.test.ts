/**
 * Small wording, each where a user read it wrong: counts in the singular and
 * the plural, an undo that removed files, the help's columns under any
 * binary name, wake-up times on the user's clock, and `/compact` with nothing
 * to compact.
 */
import { describe, expect, test } from "bun:test"
import { ACCESS_TOKEN_FILE_ENV, FAILURE_TEXT, brand, event } from "@windlass/core"
import { HAND_IN_ADVICE, handedInRejected } from "@windlass/core/auth/chatgpt"
import { compactText, firstSentence } from "../src/agents.ts"
import { helpText } from "../src/args.ts"
import { restoreCounts } from "../src/commands.ts"
import { signInReason, signInSentence } from "../src/engine.ts"
import { localTime, localTimes, wakeLines, wakeMessageSummary } from "../src/features.ts"
import { render, stored } from "./helpers.ts"

describe("an undo and a redo", () => {
  const restore = { target: "s1" as never, before: "s2" as never, after: "s1" as never, kept: [], keptOmitted: 0 }

  test("one file is \"it\", several are \"them\"; the files written and the files removed are counted apart, as the engine records them", () => {
    expect(restoreCounts({ written: 1, removed: 0 }, false)).toBe("1 file as the turn left it")
    expect(restoreCounts({ written: 2, removed: 0 }, false)).toBe("2 files as the turn left them")
    expect(restoreCounts({ written: 1, removed: 0 }, true)).toBe("1 file as it was before the turn")
    expect(restoreCounts({ written: 2, removed: 0 }, true)).toBe("2 files as they were before the turn")
    // A file the turn created is removed by the undo, not put back as it was: said as that.
    expect(restoreCounts({ written: 2, removed: 1 }, true)).toBe("2 files as they were before the turn, 1 file removed (it was not there before the turn)")
    expect(restoreCounts({ written: 0, removed: 2 }, true)).toBe("2 files removed (they were not there before the turn)")
    expect(restoreCounts({ written: 1, removed: 1 }, false)).toBe("1 file as the turn left it, 1 file removed again")
    expect(restoreCounts({ written: 0, removed: 0 }, true)).toBe("no file needed to change")
    const out = render(stored([event("history.reverted", { fromSeq: 1, restore: { ...restore, written: 1, removed: 1, changed: 2 } }), event("history.restored", { revertSeq: 1, restore: { ...restore, written: 1, removed: 0, changed: 1 } })]), { columns: () => 120 })
    expect(out).toContain("↶ went back · 1 file as it was before the turn, 1 file removed (it was not there before the turn) · /redo brings it back\n")
    expect(out).toContain("↷ brought back · 1 file as the turn left it\n")
    expect(out).not.toContain("restored")
  })
})

describe("the help", () => {
  test("every line that continues a description starts in the description's column, whatever the binary is called", () => {
    const lines = helpText().split("\n")
    const first = lines.findIndex((line) => line.startsWith(`  ${brand.binary} [options] <prompt...>`))
    const column = lines[first]!.indexOf("run one prompt and exit")
    expect(column).toBeGreaterThan(`  echo "<prompt>" | ${brand.binary} [options]`.length)
    const usage = lines.slice(first, lines.indexOf("Options:") - 1)
    expect(usage.length).toBeGreaterThan(15)
    for (const line of usage) {
      // What is typed ends before the column; a description, or its continuation, starts exactly in it.
      expect(line.slice(0, column).trimEnd().length, line).toBeLessThanOrEqual(column - 2)
      expect(line[column], line).not.toBe(" ")
      expect(line[column - 1], line).toBe(" ")
    }
    expect(usage).toContain(`${" ".repeat(column)}ended on (pasted, not shown)`)
    expect(usage).toContain(`${" ".repeat(column)}(\`${brand.binary} replay --help\`)`)
  })
})

describe("wake-up times", () => {
  test("are the user's clock with the zone, not only UTC", () => {
    const at = new Date("2026-11-12T09:30:00Z")
    expect(localTime(at, "UTC")).toBe("2026-11-12 09:30 UTC")
    expect(localTime(at, "Asia/Kolkata")).toBe("2026-11-12 15:00 GMT+5:30")
    expect(localTime(new Date("2026-11-12T23:59:07Z"), "America/New_York")).toBe("2026-11-12 18:59:07 EST")
    expect(localTimes("next at 2026-11-12T09:30:00Z, expires 2026-11-13T09:30:00.000Z; id wk_1", "Asia/Kolkata")).toBe("next at 2026-11-12 15:00 GMT+5:30, expires 2026-11-13 15:00 GMT+5:30; id wk_1")
    const lines = wakeLines({ sessionId: "s", available: true, running: true, wakeups: [{ id: "wk_1", trigger: "at", description: "once at 2026-11-12T09:30:00Z", state: "pending", nextAt: "2026-11-12T09:30:00.000Z", fired: 0, maxFirings: 1, author: "model", message: "Check CI.", url: null, lines: ["pending · next 2026-11-12T09:30:00Z · fired 0 of 1"] }] }, "Asia/Kolkata").map((line) => line.text)
    expect(lines).toContain("wk_1 · once at 2026-11-12 15:00 GMT+5:30")
    expect(lines).toContain("pending · next 2026-11-12 15:00 GMT+5:30 · fired 0 of 1")
    expect(lines.join("\n")).not.toMatch(/T09:30:00Z/)
    // The line about a message a wake-up delivered: its time is on this machine's clock, and no longer the raw stamp.
    expect(wakeMessageSummary("[Wake-up wk_1 · due 2026-11-12T09:30:00Z]\n\nThe message set up with the wake-up:\nCheck CI.", "wake").head).not.toContain("T09:30:00Z")
  })
})

describe("/compact with nothing to compact", () => {
  test("says so in one short sentence", () => {
    expect(compactText({ kind: "nothing", message: "There is nothing to compact: what is in the model's view is what the next request needs (the latest input, or a checkpoint and what followed it)." })).toEqual({ text: "There is nothing to compact: what is in the model's view is what the next request needs.", tone: "info" })
    expect(compactText({ kind: "nothing", message: "Not compacted: only about 1,200 tokens of the conversation could be summarised, and a checkpoint takes about as much. A compaction is worth it from about 2,000 tokens." })?.text).toBe("Not compacted: only about 1,200 tokens of the conversation could be summarised, and a checkpoint takes about as much.")
    expect(compactText({ kind: "nothing", message: "There is nothing to compact: the conversation has not started." })?.text).toBe("There is nothing to compact: the conversation has not started.")
    expect(firstSentence("One. Two.")).toBe("One.")
    // A failure keeps all of its reason; a compaction that was made is drawn from its events.
    expect(compactText({ kind: "failed", message: "The compaction was interrupted; the conversation is unchanged." })).toEqual({ text: "The compaction was interrupted; the conversation is unchanged.", tone: "warn" })
    expect(compactText({ kind: "compacted", tokensBefore: 9000, tokensAfter: 3000, source: "model", detail: null })).toBeNull()
  })
})

describe("a sign-in that cannot be used", () => {
  const signIn = `run \`${brand.binary} login\` to sign in with ChatGPT, then try again`
  const handIn = `hand in a new token (the output of \`${brand.binary} login token\`, run where the sign-in is saved), then try again`

  test("saved on this machine: the reason, then how to sign in", () => {
    expect(signInSentence("Not signed in. Run the sign-in first.")).toBe(`not signed in; ${signIn}`)
    expect(signInSentence("no usable access token: Not signed in. Run the sign-in first.", "the models cannot be listed")).toBe(`not signed in, so the models cannot be listed; ${signIn}`)
    expect(signInSentence(FAILURE_TEXT.signedOut)).toEndWith(`; ${signIn}`)
  })

  test("handed in from outside: the reason with the variable, then to hand in a new token, and never to sign in here", () => {
    const missing = `The file ${ACCESS_TOKEN_FILE_ENV} names does not exist (/run/handed-in/token). ${HAND_IN_ADVICE}`
    expect(signInReason(missing)).toBe(`the file ${ACCESS_TOKEN_FILE_ENV} names does not exist (/run/handed-in/token)`)
    expect(signInSentence(missing)).toBe(`the file ${ACCESS_TOKEN_FILE_ENV} names does not exist (/run/handed-in/token); ${handIn}`)
    expect(signInSentence(`no usable access token: ${missing}`, "the models cannot be listed")).toBe(`the file ${ACCESS_TOKEN_FILE_ENV} names does not exist (/run/handed-in/token), so the models cannot be listed; ${handIn}`)
    // A token the provider turned down: when the models are listed, and in the middle of a turn.
    expect(signInSentence(handedInRejected("HTTP 401: Unauthorized"), "the models cannot be listed")).toBe(`the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected (HTTP 401: Unauthorized), so the models cannot be listed; ${handIn}`)
    expect(signInSentence(FAILURE_TEXT.handedInRejected)).toBe(`signed out: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected or cannot be used; ${handIn}`)
    for (const message of [missing, handedInRejected("HTTP 401: Unauthorized"), FAILURE_TEXT.handedInRejected]) expect(signInSentence(message)).not.toContain(signIn)
  })
})
