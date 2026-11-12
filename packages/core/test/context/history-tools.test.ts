import { describe, expect, test } from "bun:test"
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
