/** What an edit made worse: line shifts, moved code, duplicates, fixed errors, a pre-existing error that moved. */
import { describe, expect, test } from "bun:test"
import { type Diagnostic, type Severity, compareDiagnostics, lineMap, parseDiagnostics } from "../../src/lsp/diagnostics.ts"

/** Diagnostics from the same marker rules as the scripted server: ERROR(x) and WARN(x). */
function rules(text: string): Diagnostic[] {
  const out: Diagnostic[] = []
  text.split("\n").forEach((line, number) => {
    for (const match of line.matchAll(/\b(ERROR|WARN)\(([^)]*)\)/g)) {
      const range = { start: { line: number, character: match.index! }, end: { line: number, character: match.index! + match[0].length } }
      out.push(
        match[1] === "ERROR"
          ? { range, severity: 1, code: "E1", source: "t", message: `cannot find name '${match[2]}'` }
          : { range, severity: 2, code: "W1", source: "t", message: `'${match[2]}' is declared but never used` },
      )
    }
  })
  return out
}

const compare = (before: string, after: string, severities: Severity[] = [1]) =>
  compareDiagnostics({ text: before, diagnostics: rules(before) }, { text: after, diagnostics: rules(after) }, new Set(severities))
const lines = (...items: string[]) => items.join("\n")
const where = (d: Diagnostic) => `${d.range.start.line}:${d.range.start.character} ${d.message}`

describe("compare", () => {
  test("lines added above a pre-existing error shift it; it is not new", () => {
    const before = lines("a", "x = ERROR(foo)", "b")
    const after = lines("new 1", "new 2", "new 3", "a", "x = ERROR(foo)", "b")
    expect(compare(before, after)).toEqual({ added: [], preExisting: 1, fixed: 0, afterTotal: 1 })
  })

  test("a new error is reported, the old one counted", () => {
    const before = lines("x = ERROR(foo)", "y = 1")
    const after = lines("x = ERROR(foo)", "y = ERROR(bar)")
    const result = compare(before, after)
    expect(result.added.map(where)).toEqual(["1:4 cannot find name 'bar'"])
    expect(result.preExisting).toBe(1)
  })

  test("moved code keeps its errors", () => {
    const block = ["function f() {", "  return ERROR(gone)", "}"]
    const before = lines(...block, "", "const a = 1", "const b = 2", "const c = 3")
    const after = lines("const a = 1", "const b = 2", "const c = 3", "", ...block)
    expect(compare(before, after)).toMatchObject({ added: [], preExisting: 1, fixed: 0 })
  })

  test("re-indented code keeps its errors", () => {
    const before = lines("call(ERROR(x))")
    const after = lines("if (ok) {", "    call(ERROR(x))", "}")
    expect(compare(before, after).added).toEqual([])
  })

  test("a copied line with an error is one new error: the copy farther away", () => {
    const before = lines("a = ERROR(dup)", "b", "c", "d")
    const after = lines("a = ERROR(dup)", "b", "c", "d", "a = ERROR(dup)")
    const result = compare(before, after)
    expect(result.added.map(where)).toEqual(["4:4 cannot find name 'dup'"])
    expect(result.preExisting).toBe(1)
  })

  test("identical diagnostics on identical lines match one to one", () => {
    const before = lines("ERROR(z)", "ERROR(z)")
    const after = lines("ERROR(z)", "ERROR(z)", "ERROR(z)")
    expect(compare(before, after)).toMatchObject({ preExisting: 2, fixed: 0 })
    expect(compare(before, after).added).toHaveLength(1)
    expect(compare(after, before)).toMatchObject({ added: [], preExisting: 2, fixed: 1 })
  })

  test("a fixed error is counted as fixed, nothing added", () => {
    const before = lines("x = ERROR(foo)", "y = ERROR(bar)")
    const after = lines("x = foo", "y = ERROR(bar)")
    expect(compare(before, after)).toEqual({ added: [], preExisting: 1, fixed: 1, afterTotal: 1 })
  })

  test("a pre-existing error whose own line the edit changed is still pre-existing", () => {
    const before = lines("head", "let v = ERROR(foo) + 1", "tail")
    const after = lines("head", "let v = ERROR(foo) + 2", "tail")
    expect(compare(before, after)).toMatchObject({ added: [], preExisting: 1 })
  })

  test("a pre-existing error that moved and whose line changed is matched when it stays in the changed region", () => {
    const before = lines("top", "use(ERROR(foo))", "bottom")
    const after = lines("top", "// comment", "use(ERROR(foo), 2)", "bottom")
    expect(compare(before, after).added).toEqual([])
  })

  test("the same message on a different, unchanged line is new", () => {
    // The old error at line 0 is untouched; a new one with the same message appears far below in new code.
    const before = lines("ERROR(foo)", "a", "b")
    const after = lines("ERROR(foo)", "a", "b", "c", "x(ERROR(foo))")
    expect(compare(before, after).added.map(where)).toEqual(["4:2 cannot find name 'foo'"])
  })

  test("warnings are ignored unless asked for", () => {
    const before = lines("a")
    const after = lines("a", "WARN(u)", "ERROR(e)")
    expect(compare(before, after).added.map((d) => d.code)).toEqual(["E1"])
    expect(compare(before, after, [1, 2]).added.map((d) => d.code)).toEqual(["W1", "E1"])
  })

  test("added diagnostics are in document order whatever order the server sent", () => {
    const after = lines("ERROR(c)", "ERROR(a) ERROR(b)")
    const diagnostics = rules(after).reverse()
    const result = compareDiagnostics({ text: "", diagnostics: [] }, { text: after, diagnostics }, new Set([1]))
    expect(result.added.map(where)).toEqual(["0:0 cannot find name 'c'", "1:0 cannot find name 'a'", "1:9 cannot find name 'b'"])
  })

  test("a new file: everything is new", () => {
    expect(compare("", lines("ERROR(a)", "ERROR(b)")).added).toHaveLength(2)
  })

  test("a flood of equal diagnostics is matched without pairing every one with every other", () => {
    const before = Array.from({ length: 3000 }, () => "ERROR(x)").join("\n")
    const after = `${before}\nERROR(x)`
    const started = performance.now()
    const result = compare(before, after)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.added).toHaveLength(1)
    expect(result.preExisting).toBe(3000)
  })
})

describe("lineMap", () => {
  test("lines above and below the change keep their place; lines in it map to the region", () => {
    const map = lineMap(["a", "b", "c", "d"], ["a", "X", "Y", "Z", "d"])
    expect(map(0)).toEqual({ kind: "mapped", line: 0 })
    expect(map(3)).toEqual({ kind: "mapped", line: 4 })
    expect(map(1)).toEqual({ kind: "changed", from: 1, to: 4 })
  })
})

describe("parseDiagnostics", () => {
  test("lenient: bad items are counted, a missing severity is an error, numeric codes become text", () => {
    const set = parseDiagnostics([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "m", code: 2304 },
      { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } }, message: "bad line" },
      { message: "no range" },
      "nonsense",
    ])
    expect(set.total).toBe(4)
    expect(set.invalid).toBe(3)
    expect(set.diagnostics).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, code: "2304", source: null, message: "m" }])
  })

  test("keeps at most the limit and counts the rest", () => {
    const item = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "m" }
    const set = parseDiagnostics(Array.from({ length: 50 }, () => item), 10)
    expect(set.diagnostics).toHaveLength(10)
    expect(set.total).toBe(50)
  })
})
