import { describe, expect, test } from "bun:test"
import { ftsQuery, locateHit, queryTerms, readable, scanSearch } from "../../src/context/history-search.ts"
import {
  HISTORY_READ,
  HISTORY_SEARCH,
  historyReadTool,
  historySearchTool,
  messagePieces,
  messageReadText,
  parseHistoryReadInput,
  parseHistorySearchInput,
  renderReadOutput,
  renderSearchOutput,
} from "../../src/context/history-tools.ts"
import { toolSpec } from "../../src/tool/tool.ts"
import { Script, shell } from "./fixtures.ts"

describe("tool specs", () => {
  test("are valid tool specs with the agreed names", () => {
    expect(toolSpec(historySearchTool, "search").name).toBe(HISTORY_SEARCH)
    expect(toolSpec(historyReadTool, "read").name).toBe(HISTORY_READ)
  })
})

describe("input parsing", () => {
  test("search", () => {
    expect(parseHistorySearchInput('{"query":"exit code"}')).toEqual({ ok: true, value: { query: "exit code" } })
    expect(parseHistorySearchInput('{"query":"x","role":"user","limit":3}')).toEqual({ ok: true, value: { query: "x", role: "user", limit: 3 } })
    expect(parseHistorySearchInput('{"query":""}').ok).toBe(false)
    expect(parseHistorySearchInput('{"query":"x","limit":99}').ok).toBe(false)
    expect(parseHistorySearchInput('{"query":"x","role":"system"}').ok).toBe(false)
    expect(parseHistorySearchInput('{"query":"x","extra":1}').ok).toBe(false)
    expect(parseHistorySearchInput("not json").ok).toBe(false)
  })

  test("read", () => {
    expect(parseHistoryReadInput('{"seq":12}')).toEqual({ ok: true, value: { seq: 12 } })
    expect(parseHistoryReadInput('{"seq":12,"offset":6000,"limit":100}')).toEqual({ ok: true, value: { seq: 12, offset: 6000, limit: 100 } })
    expect(parseHistoryReadInput('{"seq":0}').ok).toBe(false)
    expect(parseHistoryReadInput('{"seq":1.5}').ok).toBe(false)
    expect(parseHistoryReadInput("{}").ok).toBe(false)
  })
})

describe("rendering", () => {
  test("search output", () => {
    expect(renderSearchOutput({ query: "port", hits: [], matched: 0 })).toBe('No earlier message matches "port".')
    const text = renderSearchOutput({
      query: "port",
      matched: 3,
      hits: [
        { seq: 7, role: "user", tool: null, snippet: "use port 9417", offset: 0 },
        { seq: 9, role: "tool", tool: "shell", snippet: "…listening on 9417", offset: 31_250 },
      ],
    })
    expect(text).toBe(
      '3 messages match "port"; showing 2, best first.\n[seq 7] user: use port 9417\n[seq 9, offset 31250] tool (shell): …listening on 9417\nRead one with history_read and its seq; pass the offset to start at the match in a long message.',
    )
  })

  test("read output, whole and in parts", () => {
    const alone = { previousSeq: null, nextSeq: null }
    expect(renderReadOutput({ seq: 3, role: "user", tool: null, text: "hello", offset: 0, totalChars: 5, nextOffset: null, ...alone })).toBe("[seq 3] user\nhello")
    expect(renderReadOutput({ seq: 3, role: "assistant", tool: null, text: "abc", offset: 0, totalChars: 9, nextOffset: 3, ...alone })).toBe(
      "[seq 3] assistant, characters 0-3 of 9\nabc\n[More: call history_read with offset 3.]",
    )
    // The messages around it are named, so the model can read on in either direction.
    expect(renderReadOutput({ seq: 12, role: "user", tool: null, text: "hello", offset: 0, totalChars: 5, nextOffset: null, previousSeq: 9, nextSeq: 14 })).toBe(
      "[seq 12] user\nhello\n[the message before it is seq 9; the one after it is seq 14.]",
    )
  })
})

test("messagePieces lists text, each call and each result", () => {
  const script = new Script().user("run it").step({ text: "Running.", calls: [shell("bun test", "1 fail", 1)] })
  expect(messagePieces(script.messages[1]!)).toEqual([
    { role: "assistant", tool: null, text: "Running." },
    { role: "tool", tool: "shell", text: 'call shell {"command":"bun test"}' },
    { role: "tool", tool: "shell", text: "result (error):\n1 fail\n[Exit code 1]" },
  ])
  expect(messageReadText(script.messages[0]!)).toBe("run it")
})

describe("a query", () => {
  test("is split into quoted phrases and the words that say something, in lower case, once each", () => {
    expect(queryTerms('Where is "Exit Code 3" in the src/billing/rounding.ts:142 output? the THE exit')).toEqual([
      { text: "exit code 3", phrase: true },
      { text: "src/billing/rounding.ts:142", phrase: false },
      { text: "output", phrase: false },
      { text: "exit", phrase: false },
    ])
    expect(queryTerms("  ")).toEqual([])
    expect(queryTerms('"" "unbalanced')).toEqual([{ text: "unbalanced", phrase: false }])
  })

  test("becomes a full-text query in which nothing is syntax: identifiers and phrases are quoted, plain words match as prefixes", () => {
    const terms = queryTerms('upload "part 3 of 9" src/a.ts:42 AND say "it\'s" ok')
    expect(ftsQuery(terms, "any")).toBe('"part 3 of 9" OR "it\'s" OR "upload"* OR "src/a.ts:42" OR "say"* OR "ok"')
    // Quotes inside quotes just end and begin phrases: nothing can break out of a term.
    expect(ftsQuery(queryTerms('say "a ""quoted"" word"'), "all")).toBe('"a" AND "quoted" AND "word" AND "say"*')
    // Nothing a tokenizer keeps: no query.
    expect(ftsQuery(queryTerms("-- :: //"), "any")).toBeNull()
  })

  test("the hit is in the piece that holds the first term found, with the offset into the whole message", () => {
    const script = new Script().user("run it").step({ text: "Running the suite.", calls: [shell("bun test", "12 pass\n1 fail: parses the March export", 1)] })
    const step = script.messages[1]!
    const hit = locateHit(step, queryTerms("march export"))!
    expect(hit).toMatchObject({ seq: 2, role: "tool", tool: "shell" })
    expect(messageReadText(step).slice(hit.offset, hit.offset + 5)).toBe("March")
    // Restricted to the assistant's own words, the tool output is not looked at; a role with no piece gives nothing.
    expect(locateHit(step, queryTerms("suite"), { role: "assistant" })).toMatchObject({ role: "assistant", tool: null, offset: 12 })
    expect(locateHit(step, queryTerms("suite"), { role: "user" })).toBeNull()
    // A match the tokenizer made that is not there as written falls back to the start of the piece.
    expect(locateHit(step, queryTerms("nothing-like-this"), { piece: 2 })).toMatchObject({ role: "tool", offset: messageReadText(step).indexOf("result (error)") })
  })

  test("the scan ranks rarer terms higher and skips what cannot be read", () => {
    const script = new Script().user("the parser fails on dates").step({ text: "The parser is fine; the lexer drops the year." }).user("fix the lexer").checkpoint("the lexer drops the year", 1)
    const output = scanSearch(script.messages, { query: "lexer year parser" })
    expect(output.matched).toBe(3)
    expect(output.hits[0]).toMatchObject({ seq: 2, role: "assistant" })
    // The checkpoint is not searched, and an excluded message is not either.
    expect(output.hits.map((hit) => hit.seq)).not.toContain(4)
    const reverted = script.messages.map((message) => (message.seq === 3 ? { ...message, excluded: "reverted" as const } : message))
    expect(scanSearch(reverted, { query: "fix lexer", role: "user" }).hits).toEqual([])
    expect(readable(reverted[2]!)).toBe(false)
    expect(readable(script.messages[3]!)).toBe(false)
  })
})
