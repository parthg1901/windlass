/**
 * Small wording, each where a user read it wrong: counts in the singular and
 * the plural, an undo that removed files, the help's columns under any
 * binary name, wake-up times on the user's clock, `/compact` with nothing to
 * compact, and the replay comparison's counts.
 */
import { describe, expect, test } from "bun:test"
import { brand, event } from "@windlass/core"
import { comparisonWords } from "@windlass/acp"
import { compactText, firstSentence } from "../src/agents.ts"
import { helpText } from "../src/args.ts"
import { restoredFiles } from "../src/commands.ts"
import { localTime, localTimes, wakeLines, wakeMessageSummary } from "../src/features.ts"
import { render, stored } from "./helpers.ts"

describe("an undo and a redo", () => {
  const restore = { target: "s1", before: "s2", after: "s1", kept: [], keptOmitted: 0 }

  test("one file is \"it\", several are \"them\"; an undo says the files are as before the turn, which is true of one it removed", () => {
    expect(restoredFiles(1, false)).toBe("1 file as the turn left it")
    expect(restoredFiles(2, false)).toBe("2 files as the turn left them")
    expect(restoredFiles(1, true)).toBe("1 file as it was before the turn")
    expect(restoredFiles(2, true)).toBe("2 files as they were before the turn")
    const out = render(stored([event("history.reverted", { fromSeq: 1, restore: { ...restore, changed: 2 } as never }), event("history.restored", { revertSeq: 1, restore: { ...restore, changed: 1 } as never })]), { columns: () => 120 })
    expect(out).toContain("↶ went back · 2 files as they were before the turn · /redo brings it back\n")
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

describe("the replay comparison", () => {
  test("no act on either side is said as that, and one read is one read", () => {
    const rendered = ["compared on what it did (reads ignored)", "  side effects   the same 0 acts as the recording", "  lenient        would have stayed on the recording (1 reads answerable from the recording, 0 not)", "  files          the same as the recording's at its end"].join("\n")
    const said = comparisonWords(rendered)
    expect(said).toContain("  side effects   none on either side: the recording changed nothing, and neither did the replay\n")
    expect(said).toContain("(1 read answerable from the recording, 0 not)")
    expect(said).not.toContain("0 acts")
    expect(said).not.toContain("1 reads")
    // Counts that read right are left as the engine wrote them.
    const plural = rendered.replace("the same 0 acts", "the same 3 acts").replace("1 reads", "12 reads")
    expect(comparisonWords(plural)).toBe(plural)
  })
})
