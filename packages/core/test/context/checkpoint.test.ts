import { describe, expect, test } from "bun:test"
import {
  CONTINUE_SENTENCE,
  DEFAULT_CHECKPOINT_LIMITS,
  HISTORY_SENTENCE,
  LAST_WORDS_HEADING,
  NO_SUMMARY_ADVICE,
  NO_SUMMARY_STATEMENT,
  INDEX_HEADING,
  QUOTES_HEADING,
  TODOS_ADVICE,
  TODOS_HEADING,
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

describe("a checkpoint without a summary", () => {
  test("says so, and carries the assistant's last words, the index and the user's messages", () => {
    const checkpoint = buildCheckpoint({ summary: null, earlier: session().messages })
    const text = checkpoint.text
    expect(text).toContain(NO_SUMMARY_STATEMENT)
    expect(text).toContain(`${LAST_WORDS_HEADING}\n[seq 4] The crash is at src/importer/csv.ts:142. I fixed it in commit 3f9a2c1.`)
    expect(text).toContain("- `bun test test/importer --bail` → exit 1, exit 0")
    expect(text).toContain("> Thanks. Now use port 9417 for the mock server, not 8081.")
    expect(text.endsWith(`${HISTORY_SENTENCE} ${NO_SUMMARY_ADVICE}`)).toBe(true)
    // In the order: statement, last words, index, quotes, tools.
    const order = [NO_SUMMARY_STATEMENT, LAST_WORDS_HEADING, INDEX_HEADING, QUOTES_HEADING, HISTORY_SENTENCE].map((part) => text.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((position) => position > 0)).toBe(true)
  })

  test("is deterministic and stays within the checkpoint's whole budget on a long session", () => {
    const build = () => {
      const script = new Script()
      for (let turn = 0; turn < 60; turn += 1) {
        script.user(`Request ${turn}: ${filler(120, turn)}`)
        script.step({ text: filler(200, turn), calls: [read(`src/module-${turn}/index.ts`, filler(50, turn)), shell(`bun test test/module-${turn}`, `error: failure ${turn}\n${filler(40, turn)}`, 1)] })
      }
      return buildCheckpoint({ summary: null, earlier: script.messages })
    }
    const checkpoint = build()
    expect(build().text).toBe(checkpoint.text)
    expect(checkpoint.tokens).toBeLessThanOrEqual(DEFAULT_COMPACTION_CONFIG.summaryMaxTokens + DEFAULT_COMPACTION_CONFIG.checkpointExtraMaxTokens)
    expect(checkpoint.unquoted).toBeGreaterThan(0)
  })
})

describe("a checkpoint taken while the work was in progress", () => {
  test("tells the model to carry on, after the quotes and before the tools", () => {
    const text = buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages, inProgress: true }).text
    expect(text).toContain(CONTINUE_SENTENCE)
    expect(text.indexOf(QUOTES_HEADING)).toBeLessThan(text.indexOf(CONTINUE_SENTENCE))
    expect(text.indexOf(CONTINUE_SENTENCE)).toBeLessThan(text.indexOf(HISTORY_SENTENCE))
    expect(buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages }).text).not.toContain(CONTINUE_SENTENCE)
  })
})

describe("a checkpoint of a session that keeps a task list", () => {
  const todos = "[x] Read the parser\n[>] Fix the off-by-one\n[ ] Run the tests"

  test("carries the list right after the summary, and says it is still the model's", () => {
    const text = buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages, todos }).text
    expect(text).toContain(`${TODOS_HEADING}\n${todos}\n${TODOS_ADVICE}`)
    expect(text.indexOf("## Goal")).toBeLessThan(text.indexOf(TODOS_HEADING))
    expect(text.indexOf(TODOS_HEADING)).toBeLessThan(text.indexOf(INDEX_HEADING))
  })

  test("says nothing about a list when there is none, and is unchanged for every session without one", () => {
    const without = buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages })
    expect(without.text).not.toContain(TODOS_HEADING)
    expect(buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages, todos: null }).text).toBe(without.text)
    expect(buildCheckpoint({ summary: "## Goal\n- Fix the importer.", earlier: session().messages, todos: "  " }).text).toBe(without.text)
  })

  test("without a summary the list is still there", () => {
    expect(buildCheckpoint({ summary: null, earlier: session().messages, todos }).text).toContain(todos)
  })
})
