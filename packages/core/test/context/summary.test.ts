import { describe, expect, test } from "bun:test"
import { SUMMARY_SECTIONS, resolveSummary, salvageSummary, summaryOutputCapChars, summaryPrompt, summaryRepairPrompt, validateSummary } from "../../src/context/summary.ts"
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

describe("a summary the model did not stop writing", () => {
  test("repeated several times over, its first copy is the summary", () => {
    const repeated = [good, good, good].join("\n")
    expect(validateSummary(repeated, 2_500)).toMatchObject({ ok: false })
    expect(salvageSummary(repeated)).toBe(good)
    expect(resolveSummary(repeated, 2_500)).toEqual({ ok: true, text: good, tokens: validateSummary(good, 2_500).tokens, salvaged: true })
  })

  test("a valid answer is used as it is", () => {
    expect(resolveSummary(`${good}\n`, 2_500)).toMatchObject({ ok: true, text: good, salvaged: false })
  })

  test("cut by the engine in the middle of the second copy, the first copy is still whole", () => {
    const cut = `${good}\n${good.slice(0, 180)}`
    expect(resolveSummary(cut, 2_500, { complete: false })).toMatchObject({ ok: true, text: good, salvaged: true })
    // Cut inside the first copy, sections are missing: not usable.
    const short = resolveSummary(good.slice(0, 200), 2_500, { complete: false })
    expect(short).toMatchObject({ ok: false, usable: false })
    // The line that was being written when the stream was cut is dropped.
    expect(short.text.endsWith("0 to")).toBe(false)
  })

  test("copying the prompt's description into each heading is tolerated, also when repeated", () => {
    const described = good.replace("## Goal", "## Goal: what the user wants overall, in one or two sentences.")
    expect(resolveSummary(`${described}\n${described}`, 2_500)).toMatchObject({ ok: true, salvaged: true })
  })

  test("too long but complete, or without the next-step line, is usable when a repair does no better; a missing section is not", () => {
    const long = good.replace("- Round down to whole cents, because the ledger stores integers.", `- ${filler(300)}`)
    const tight = validateSummary(long, 2_500).tokens - 10
    expect(resolveSummary(long, tight)).toMatchObject({ ok: false, usable: true, problems: [{ kind: "too_long" }] })
    // Past twice the limit it is not bounded any more.
    expect(resolveSummary(long, Math.floor(tight / 2) - 20)).toMatchObject({ ok: false, usable: false })
    expect(resolveSummary(good.replace("Next step:", "Then:"), 2_500)).toMatchObject({ ok: false, usable: true, problems: [{ kind: "no_next_step" }] })
    expect(resolveSummary(good.replace("## Files", "## Other"), 2_500)).toMatchObject({ ok: false, usable: false })
    expect(resolveSummary("", 2_500)).toMatchObject({ ok: false, usable: false, text: "" })
    expect(resolveSummary("I cannot summarise this.", 2_500)).toMatchObject({ ok: false, usable: false })
  })

  test("the engine stops reading at twice the token limit, counted in characters", () => {
    expect(summaryOutputCapChars(2_500)).toBe(20_000)
    // A summary at the limit is well inside it.
    expect(good.length).toBeLessThan(summaryOutputCapChars(2_500))
  })
})
