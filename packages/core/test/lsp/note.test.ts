/** The note the model sees: the frozen text, its bounds, deterministic order. */
import { describe, expect, test } from "bun:test"
import type { Comparison, Diagnostic } from "../../src/lsp/diagnostics.ts"
import { NOTE_LIMITS, oneLine, renderNote } from "../../src/lsp/note.ts"

const d = (line: number, character: number, message: string, fields: Partial<Diagnostic> = {}): Diagnostic => ({
  range: { start: { line, character }, end: { line, character: character + 1 } },
  severity: 1,
  code: "TS2304",
  source: "ts",
  message,
  ...fields,
})
const comparison = (added: Diagnostic[], preExisting = 0): Comparison => ({ added, preExisting, fixed: 0, afterTotal: added.length + preExisting })

describe("renderNote", () => {
  test("the exact text", () => {
    const note = renderNote("src/app.ts", [
      {
        server: "typescript",
        comparison: comparison(
          [d(11, 4, "Cannot find name 'fetchUser'."), d(19, 17, "Argument of type 'string' is not assignable to parameter of type 'number'.", { code: "TS2345" })],
          3,
        ),
      },
    ])
    expect(note.text).toBe(
      [
        `[Diagnostics from the language server "typescript" for src/app.ts after this edit: 2 new errors]`,
        "src/app.ts:12:5: error TS2304: Cannot find name 'fetchUser'. (ts)",
        "src/app.ts:20:18: error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'. (ts)",
        "These are the language server's diagnostics for this file after the edit; the 3 it already had are not listed, and the project's checks remain the authority.",
      ].join("\n"),
    )
    expect(note).toMatchObject({ listed: 2, omitted: 0 })
  })

  test("no pre-existing, one warning, no code or source", () => {
    const note = renderNote("a.py", [{ server: "py", comparison: comparison([d(0, 0, "unused", { severity: 2, code: null, source: null })]) }])
    expect(note.text).toBe(
      [
        `[Diagnostics from the language server "py" for a.py after this edit: 1 new warning]`,
        "a.py:1:1: warning: unused",
        "These are the language server's diagnostics for this file after the edit; diagnostics it already had are not listed, and the project's checks remain the authority.",
      ].join("\n"),
    )
  })

  test("nothing new: no note", () => {
    expect(renderNote("a.ts", [{ server: "ts", comparison: comparison([], 5) }])).toEqual({ text: null, listed: 0, omitted: 0 })
    expect(renderNote("a.ts", []).text).toBeNull()
  })

  test("at most maxItems, and one line saying how many were left out", () => {
    const added = Array.from({ length: 4000 }, (_, i) => d(i, 0, `problem ${i}`))
    const note = renderNote("big.ts", [{ server: "ts", comparison: comparison(added) }])
    const lines = note.text!.split("\n")
    expect(lines).toHaveLength(1 + NOTE_LIMITS.maxItems.default + 2)
    expect(lines[0]).toContain("4000 new errors")
    expect(lines.at(-2)).toBe("... and 3990 more new diagnostics not listed.")
    expect(note).toMatchObject({ listed: 10, omitted: 3990 })
  })

  test("long messages are cut to one line and the whole note stays within the character bound", () => {
    const added = Array.from({ length: 50 }, (_, i) => d(i, 0, `line one\nline two ${"x".repeat(1000)} ${i}`))
    const note = renderNote("long.ts", [{ server: "ts", comparison: comparison(added) }], { maxItems: 50 })
    expect(note.text!.length).toBeLessThanOrEqual(NOTE_LIMITS.maxChars)
    expect(note.text).not.toContain("line one\nline two")
    expect(note.listed + note.omitted).toBe(50)
    expect(note.text!.split("\n").at(-2)).toBe(`... and ${note.omitted} more new diagnostics not listed.`)
  })

  test("several servers: sorted by name, one item budget shared", () => {
    const sections = [
      { server: "zeta", comparison: comparison([d(0, 0, "z1"), d(1, 0, "z2")]) },
      { server: "alpha", comparison: comparison([d(0, 0, "a1"), d(1, 0, "a2")]) },
    ]
    const note = renderNote("f.ts", sections, { maxItems: 3 })
    const text = note.text!
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'))
    expect(note).toMatchObject({ listed: 3, omitted: 1 })
    expect(renderNote("f.ts", [...sections].reverse(), { maxItems: 3 }).text).toBe(text)
  })

  test("control characters from a server do not reach the note", () => {
    const note = renderNote("f.ts", [{ server: "s", comparison: comparison([d(0, 0, "bad\u001b[31m red\u0007")]) }])
    expect(note.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/)
  })
})

describe("oneLine", () => {
  test("cuts without splitting a surrogate pair", () => {
    const cut = oneLine(`${"a".repeat(6)}😀😀x`, 10)
    expect(cut.endsWith("...")).toBe(true)
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})
