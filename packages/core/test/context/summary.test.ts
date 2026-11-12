import { describe, expect, test } from "bun:test"
import { SUMMARY_SECTIONS, summaryPrompt, summaryRepairPrompt, validateSummary } from "../../src/context/summary.ts"
import { filler } from "./fixtures.ts"

const good = [
  "## Goal",
  "- Add percentage discounts to the cart.",
  "## Instructions and constraints",
  "- Throw a RangeError below 0 or above 100 (replaced the earlier 0 to 50 limit).",
  "## Decisions",
  "- Round down to whole cents, because the ledger stores integers.",
  "## Work completed",
  "- `applyDiscount` added to src/cart.ts; `bun test` passes.",
  "## In progress",
  "- Writing the NaN test.",
  "Next step: add `expect(() => cart.applyDiscount(NaN)).toThrow(RangeError)` to src/cart.test.ts.",
  "## Files",
  "- src/cart.ts: added applyDiscount.",
  "## Commands",
  "- `bun test` → exit 0.",
  "## Open questions",
  "- None.",
  "## Verbatim",
  "- None.",
].join("\n")

describe("summaryPrompt", () => {
  test("names every required heading, in order, and the next-step line", () => {
    const prompt = summaryPrompt()
    const positions = SUMMARY_SECTIONS.map((section) => prompt.indexOf(`## ${section.heading}:`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(prompt).toContain('"Next step:"')
    expect(prompt).toContain("Do not call tools")
    expect(summaryPrompt()).toBe(prompt)
  })
})

describe("validateSummary", () => {
  test("accepts a summary with every section", () => {
    expect(validateSummary(good, 2_500)).toMatchObject({ ok: true })
  })

  test("tolerates a preamble, bold headings and a trailing colon", () => {
    const loose = `Here is the summary.\n${good.replace("## Goal", "## **Goal:**")}`
    expect(validateSummary(loose, 2_500).ok).toBe(true)
  })

  test("names each problem", () => {
    const broken = good
      .replace("## Decisions\n- Round down to whole cents, because the ledger stores integers.\n", "")
      .replace("## Files\n- src/cart.ts: added applyDiscount.", "## Files\n")
      .replace("Next step:", "Then:")
    const check = validateSummary(`${broken}\n## Goal\n- again`, 2_500)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      { kind: "duplicate_section", heading: "Goal" },
      { kind: "missing_section", heading: "Decisions" },
      { kind: "empty_section", heading: "Files" },
      { kind: "no_next_step" },
    ])
  })

  test("reports sections out of order", () => {
    const swapped = good.replace("## Goal\n- Add percentage discounts to the cart.\n", "") + "\n## Goal\n- Add discounts."
    const check = validateSummary(swapped, 2_500)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.problems.map((problem) => problem.kind)).toContain("out_of_order")
  })

  test("enforces the size bound", () => {
    const long = good.replace("- None.", `- ${filler(3_000)}`)
    const check = validateSummary(long, 1_000)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.problems).toContainEqual({ kind: "too_long", tokens: check.tokens, maxTokens: 1_000 })
  })

  test("the repair prompt lists every problem", () => {
    const prompt = summaryRepairPrompt([{ kind: "missing_section", heading: "Files" }, { kind: "no_next_step" }])
    expect(prompt).toContain('"## Files" is missing')
    expect(prompt).toContain('"Next step:"')
  })
})
