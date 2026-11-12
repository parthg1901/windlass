/**
 * Word wrapping of styled text: a word is what stands between spaces,
 * whatever its styling, and only a word longer than a row is broken.
 */
import { describe, expect, test } from "bun:test"
import { COMMANDS, PALETTE_ROWS, paletteLines } from "../src/commands.ts"
import { width, wrapLine } from "../src/layout.ts"
import { markdown } from "../src/markdown.ts"
import { span } from "../src/theme.ts"

const rows = (text: string, columns: number, plain = false) => markdown(text, plain).flatMap((block) => wrapLine(block.spans, columns, block.indent).map((row) => row.map((part) => part.text).join("")))

test("an answer wraps between words: inline code keeps the punctuation around it, a bold word its colon", () => {
  const answer = "The name is read from `core/brand.ts`, and **everything**: the binary (see `docs/names.md`)."
  for (let columns = 18; columns <= 100; columns += 1) {
    const laid = rows(answer, columns)
    for (const row of laid) expect(width(row)).toBeLessThanOrEqual(columns)
    // No row starts with what closes a word, or ends with what opens one.
    for (const row of laid) {
      expect(row).not.toMatch(/^[,:).]/)
      expect(row).not.toMatch(/\($/)
    }
    // Nothing is lost and nothing is split: the rows put together with spaces are the sentence.
    expect(laid.join(" ")).toBe("The name is read from core/brand.ts, and everything: the binary (see docs/names.md).")
  }
  // The same with the backticks kept (no colour to show code by).
  expect(rows(answer, 30, true).join(" ")).toBe("The name is read from `core/brand.ts`, and **everything**: the binary (see `docs/names.md`).".replace(/\*\*/g, ""))
})

test("a word keeps the style of each of its parts, and a word longer than a row is the only thing broken", () => {
  const laid = wrapLine([span("see "), span("a.ts", "code"), span(", then")], 9)
  expect(laid.map((row) => row.map((part) => part.text).join(""))).toEqual(["see a.ts,", "then"])
  expect(laid[0]).toEqual([span("see "), span("a.ts", "code"), span(",")])
  const long = wrapLine([span("at "), span("packages/core/src/brand.ts", "code"), span(".")], 12, [span("  ")])
  expect(long.map((row) => row.map((part) => part.text).join(""))).toEqual(["at packages/", "  core/src/b", "  rand.ts."])
})

describe("the command palette", () => {
  const text = (lines: ReturnType<typeof paletteLines>) => lines.map((line) => line.map((part) => part.text).join(""))

  test("names in one column, what each does in the next, cut at a word; the last row counts them and says the keys", () => {
    const all = COMMANDS.filter((spec) => ["undo", "redo", "sessions", "model", "new", "fork", "agent", "compact"].includes(spec.name))
    const lines = text(paletteLines(all, 0, 100))
    expect(lines).toHaveLength(PALETTE_ROWS + 1)
    // The column is as wide as the widest name shown with its arguments (/fork [<turn>] [copy], 21 cells), then two spaces.
    expect(lines[0]).toBe(`› /undo${" ".repeat(18)}go back to before your last message: files and conversation`)
    expect(lines[1]).toBe(`  /redo${" ".repeat(18)}bring back what the last /undo took away`)
    // Every description starts in the same column, and none runs past the width or ends in the middle of a word.
    const starts = lines.slice(0, -1).map((line) => line.indexOf(line.trimStart().split(/\s{2,}/)[1]!))
    expect(new Set(starts).size).toBe(1)
    expect(lines.every((line) => Bun.stringWidth(line) <= 100)).toBe(true)
    expect(lines[5]).toMatch(/^ {2}\/fork \[<turn>\] \[copy\] {2}continue in a new session .* [a-z)]+…$/)
    expect(lines.at(-1)).toBe("  1 of 8 · ↑↓ choose · Tab completes · Enter runs it · Esc closes the list")
  })

  test("a list that fits has no count, and a narrow terminal gets the short form of the keys", () => {
    const two = COMMANDS.filter((spec) => spec.name === "help" || spec.name === "quit")
    expect(text(paletteLines(two, 1, 100)).at(-1)).toBe("  ↑↓ choose · Tab completes · Enter runs it · Esc closes the list")
    const narrow = text(paletteLines(COMMANDS, 9, 40))
    expect(narrow.at(-1)).toBe(`  10 of ${COMMANDS.length} · ↑↓ Tab Enter Esc`)
    expect(narrow.every((line) => Bun.stringWidth(line) <= 40)).toBe(true)
    expect(narrow.filter((line) => line.startsWith("› "))).toHaveLength(1)
  })
})
