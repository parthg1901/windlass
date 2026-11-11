import { describe, expect, test } from "bun:test"
import { excerpt, looksTruncated, parseArguments } from "../../src/tool/args.ts"

describe("argument text", () => {
  test("parses JSON and reads empty text as an empty object", () => {
    expect(parseArguments('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseArguments("  ")).toEqual({ ok: true, value: {} })
  })

  test("malformed JSON is a value with a problem and an excerpt, not an exception", () => {
    const parsed = parseArguments('{"path": "a.ts",}')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.problem.length).toBeGreaterThan(0)
      expect(parsed.excerpt).toBe('{"path": "a.ts",}')
    }
  })

  test("excerpts are cut on code points", () => {
    expect(excerpt("😀".repeat(300), 2)).toBe("😀😀… (298 more characters)")
  })

  test("tells cut-off arguments from malformed ones", () => {
    expect(looksTruncated('{"path": "a.ts", "content": "hel')).toBe(true)
    expect(looksTruncated('{"edits": [{"a": 1}, {"b"')).toBe(true)
    expect(looksTruncated('{"a": "x\\"')).toBe(true)
    expect(looksTruncated('{"a": 1}')).toBe(false)
    expect(looksTruncated("")).toBe(false)
    expect(looksTruncated('{"a": 1]')).toBe(false)
    expect(looksTruncated('{"a": 1} {"b"')).toBe(false)
    expect(looksTruncated("not json")).toBe(false)
  })
})
