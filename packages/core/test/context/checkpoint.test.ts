import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CHECKPOINT_LIMITS,
  HISTORY_SENTENCE,
  INDEX_HEADING,
  QUOTES_HEADING,
  buildCheckpoint,
  extractIdentifiers,
} from "../../src/context/checkpoint.ts"
import { estimateTokens } from "../../src/context/estimate.ts"
import { DEFAULT_COMPACTION_CONFIG } from "../../src/context/policy.ts"
import { Script, filler, read, shell } from "./fixtures.ts"

function session() {
  return new Script()
    .user("The importer crashes on the March export. Keep the label `IMPORT-7731-B` exactly as written.")
    .step({ calls: [read("src/importer/csv.ts", "1\texport function parse() {}\n")] })
    .step({
      calls: [
        shell(
          "bun test test/importer --bail",
          "(fail) importer > parses the March export [2.10ms]\nTypeError: Cannot read properties of undefined (reading 'currencyCode')\n    at parseRow (src/importer/csv.ts:142:17)",
          1,
        ),
      ],
    })
    .step({ text: "The crash is at src/importer/csv.ts:142. I fixed it in commit 3f9a2c1." })
    .step({ calls: [shell("bun test test/importer --bail", "12 pass\n0 fail")] })
    .user("Thanks. Now use port 9417 for the mock server, not 8081.")
}

describe("extractIdentifiers", () => {
  test("finds paths with lines, commands with each outcome, errors, commits and failing tests", () => {
    const index = extractIdentifiers(session().messages)
    expect(index.files).toEqual(["src/importer/csv.ts", "src/importer/csv.ts:142:17", "src/importer/csv.ts:142"])
    expect(index.commands).toEqual(["`bun test test/importer --bail` → exit 1, exit 0"])
    expect(index.errors).toEqual(["TypeError: Cannot read properties of undefined (reading 'currencyCode')"])
    expect(index.commits).toEqual(["3f9a2c1"])
    expect(index.tests).toEqual(["importer > parses the March export"])
  })

  test("catches a bare Error: line and records 'path line N' as path:N", () => {
    const script = new Script()
      .step({ calls: [shell("bun run sync.ts", "starting\nError: ENOENT: no such file or directory, open '/var/lib/x/rates.json'\ndone", 1)] })
      .step({ text: "Found it: src/refunds/calc/partial-refund.ts line 133, where the discount is applied twice." })
    const index = extractIdentifiers(script.messages)
    expect(index.errors).toEqual(["Error: ENOENT: no such file or directory, open '/var/lib/x/rates.json'"])
    expect(index.files).toContain("src/refunds/calc/partial-refund.ts:133")
  })

  test("over the cap, what the user or the model named wins over paths seen only in tool output", () => {
    const script = new Script().step({ text: "The bug is in src/early/named.ts." })
    for (let batch = 0; batch < 10; batch += 1)
      script.step({ calls: [{ name: "grep", input: { pattern: "x" }, output: Array.from({ length: 10 }, (_, line) => `src/noise-${batch}/f${line}.ts:${line + 1}: x`).join("\n") }] })
    const index = extractIdentifiers(script.messages)
    expect(index.files).toContain("src/early/named.ts")
    expect(index.files.length).toBe(DEFAULT_CHECKPOINT_LIMITS.perCategory.files)
  })

  test("collapses repeated outcomes and ignores URLs", () => {
    const script = new Script()
    for (let run = 0; run < 3; run += 1) script.step({ calls: [shell("make check", "boom", 2)] })
    script.step({ text: "See https://example.com/docs/guide.html for details." })
    const index = extractIdentifiers(script.messages)
    expect(index.commands).toEqual(["`make check` → exit 2 ×3"])
    expect(index.files).toEqual([])
  })

  test("is bounded per kind and in tokens, keeping the most recent entries", () => {
    const script = new Script()
    for (let file = 0; file < 200; file += 1) script.step({ calls: [read(`src/module-${file}/index.ts`, "x")] })
    const index = extractIdentifiers(script.messages)
    expect(index.files.length).toBe(DEFAULT_CHECKPOINT_LIMITS.perCategory.files)
    expect(index.files[index.files.length - 1]).toBe("src/module-199/index.ts")
    expect(index.files).not.toContain("src/module-0/index.ts")
    const tight = extractIdentifiers(script.messages, { ...DEFAULT_CHECKPOINT_LIMITS, indexTokens: 100 })
    expect(tight.files.length).toBeLessThan(index.files.length)
    expect(tight.files[tight.files.length - 1]).toBe("src/module-199/index.ts")
  })
})

describe("buildCheckpoint", () => {
  test("summary, index, verbatim user messages and the history sentence, in that order", () => {
    const checkpoint = buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages })
    const order = ["## Goal", INDEX_HEADING, QUOTES_HEADING, HISTORY_SENTENCE].map((part) => checkpoint.text.indexOf(part))
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(checkpoint.text).toContain("> The importer crashes on the March export. Keep the label `IMPORT-7731-B` exactly as written.")
    expect(checkpoint.text).toContain("> Thanks. Now use port 9417 for the mock server, not 8081.")
    expect(checkpoint.quoted).toEqual([1, 6])
    expect(checkpoint.text).toContain("history_search")
    expect(checkpoint.text).toContain("history_read")
    expect(checkpoint.tokens).toBe(estimateTokens(checkpoint.text))
  })

  test("leaves out the history sentence when the session has no history tools", () => {
    const checkpoint = buildCheckpoint({ summary: "s", earlier: session().messages, historyTools: false })
    expect(checkpoint.text).not.toContain(HISTORY_SENTENCE)
  })

  test("is byte-identical for the same input", () => {
    const build = () => buildCheckpoint({ summary: "## Goal\n- x", earlier: session().messages }).text
    expect(build()).toBe(build())
  })

  test("quotes the newest user messages within budget and says how many were left out", () => {
    const script = new Script()
    for (let index = 0; index < 30; index += 1) script.user(`request ${index}: ${filler(120, index)}`)
    const checkpoint = buildCheckpoint({ summary: "s", earlier: script.messages })
    expect(checkpoint.unquoted).toBeGreaterThan(0)
    expect(checkpoint.quoted[checkpoint.quoted.length - 1]).toBe(30)
    expect(checkpoint.text).toContain(`${checkpoint.unquoted} earlier user messages are not quoted here`)
    const quotes = checkpoint.text.slice(checkpoint.text.indexOf(QUOTES_HEADING), checkpoint.text.indexOf(HISTORY_SENTENCE))
    expect(estimateTokens(quotes)).toBeLessThanOrEqual(DEFAULT_CHECKPOINT_LIMITS.userTokens + 10)
  })

  test("cuts the middle of a very long user message and points at the original", () => {
    const script = new Script().user(`BEGIN ${filler(3_000)} END`)
    const checkpoint = buildCheckpoint({ summary: "s", earlier: script.messages })
    expect(checkpoint.text).toContain("> BEGIN")
    expect(checkpoint.text).toContain("END")
    expect(checkpoint.text).toContain("history_read seq 1 has the whole message")
  })

  test("its mechanical part stays within the policy's checkpoint budget", () => {
    const script = new Script()
    for (let index = 0; index < 120; index += 1) {
      script.user(`step ${index}: ${filler(60, index)}`)
      script.step({ calls: [shell(`bun test src/area-${index}/thing-${index}.test.ts`, `error: failed ${index}\n(fail) case ${index}`, 1)] })
    }
    const checkpoint = buildCheckpoint({ summary: "", earlier: script.messages })
    expect(checkpoint.tokens).toBeLessThanOrEqual(DEFAULT_COMPACTION_CONFIG.checkpointExtraMaxTokens)
  })

  test("ignores earlier checkpoints", () => {
    const script = new Script().checkpoint("old summary mentions src/ghost/file.ts", 1).user("hello")
    const checkpoint = buildCheckpoint({ summary: "s", earlier: script.messages })
    expect(checkpoint.index.files).toEqual([])
  })
})
