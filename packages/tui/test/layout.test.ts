/**
 * Word wrapping of styled text: a word is what stands between spaces,
 * whatever its styling, and only a word longer than a row is broken.
 */
import { expect, test } from "bun:test"
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
