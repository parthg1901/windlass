/** The report's exact text, built from real check runs. */
import { afterEach, describe, expect, test } from "bun:test"
import { renderReport, runChecks } from "../../src/verify/index.ts"
import { check, project, removeTempDirs } from "./helpers.ts"

afterEach(removeTempDirs)

describe("renderReport", () => {
  test("all passing: one line each, no instruction", async () => {
    const p = project()
    const results = await runChecks([check("typecheck", "echo fine"), check("test", "true")], p.options())
    expect(renderReport(results)).toBe(
      ["Checks run by the harness after your changes: 2 passed.", "passed: typecheck (echo fine)", "passed: test (true)", ""].join("\n"),
    )
  })

  test("failures show the command, the exit code and the output, then one instruction", async () => {
    const p = project()
    const results = await runChecks(
      [
        check("typecheck", "true"),
        check("test", "echo 'math.test.ts:'; echo '  expected 3, received 4'; exit 1"),
        check("lint", "exit 2"),
        check("format", "printf 'no newline at end'; exit 1"),
      ],
      p.options(),
    )
    expect(renderReport(results)).toBe(
      [
        "Checks run by the harness after your changes: 1 passed, 3 failed.",
        "passed: typecheck (true)",
        "",
        "failed: test (echo 'math.test.ts:'; echo '  expected 3, received 4'; exit 1), exit code 1. Output:",
        "math.test.ts:",
        "  expected 3, received 4",
        "[end of test output]",
        "",
        "failed: lint (exit 2), exit code 2, no output.",
        "",
        "failed: format (printf 'no newline at end'; exit 1), exit code 1. Output:",
        "no newline at end",
        "[end of format output]",
        "",
        "Fix the code so that these checks pass, or, if you cannot, call report_check_failure with the name of each failing check and the reason.",
        "",
      ].join("\n"),
    )
  })

  test("one-line results first, then failures, each group in the order given; one failure is addressed in the singular", async () => {
    const p = project()
    const results = await runChecks([check("b", "exit 1"), check("a", "true"), check("c", "exit 4"), check("d", "true")], p.options())
    expect(renderReport(results)).toBe(
      [
        "Checks run by the harness after your changes: 2 passed, 2 failed.",
        "passed: a (true)",
        "passed: d (true)",
        "",
        "failed: b (exit 1), exit code 1, no output.",
        "",
        "failed: c (exit 4), exit code 4, no output.",
        "",
        "Fix the code so that these checks pass, or, if you cannot, call report_check_failure with the name of each failing check and the reason.",
        "",
      ].join("\n"),
    )
    expect(renderReport(results.slice(0, 2))).toEndWith("Fix the code so that this check passes, or, if you cannot, call report_check_failure with the name of each failing check and the reason.\n")
  })

  test("an empty set of results", () => {
    expect(renderReport([])).toBe("Checks run by the harness after your changes: none ran.\n")
  })
})
