import { describe, expect, test } from "bun:test"
import { type Options, helpText, parseArgs } from "../src/args.ts"
import { brand } from "../src/brand.ts"

const options = (argv: string[]): Options => {
  const parsed = parseArgs(argv)
  if (parsed.kind !== "run") throw new Error(`expected run, got ${JSON.stringify(parsed)}`)
  return parsed.options
}
const errorOf = (argv: string[]) => {
  const parsed = parseArgs(argv)
  return parsed.kind === "error" ? parsed.message : null
}

describe("parseArgs", () => {
  test("defaults", () => {
    expect(options([])).toEqual({
      prompt: null,
      session: null,
      continue: false,
      model: null,
      effort: null,
      cwd: null,
      output: "pretty",
      showReasoning: false,
      interactive: false,
      demo: null,
      demoSpeed: 1,
      demoGraceMs: null,
    })
  })

  test("the prompt is every word that is not an option, joined with spaces", () => {
    expect(options(["fix", "the", "test"]).prompt).toBe("fix the test")
    expect(options(["--model", "gpt-5", "fix", "-q", "it"])).toMatchObject({ prompt: "fix it", model: "gpt-5", output: "quiet" })
    expect(options(["--", "--not-a-flag", "-x"]).prompt).toBe("--not-a-flag -x")
  })

  test("value options take the next word or an inline value", () => {
    expect(options(["--session", "ses_1", "--effort=high", "--cwd", "/tmp", "-m", "m1"])).toMatchObject({ session: "ses_1", effort: "high", cwd: "/tmp", model: "m1" })
    expect(options(["-c", "--json", "--show-reasoning"])).toMatchObject({ continue: true, output: "json", showReasoning: true })
    expect(options(["--demo", "3", "--demo-speed", "2.5", "--demo-grace", "5000"])).toMatchObject({ demo: "3", demoSpeed: 2.5, demoGraceMs: 5000 })
  })

  test("help and version win over everything else", () => {
    expect(parseArgs(["--json", "-h"]).kind).toBe("help")
    expect(parseArgs(["prompt", "--version"]).kind).toBe("version")
    expect(parseArgs(["-v"]).kind).toBe("version")
  })

  test("usage errors", () => {
    expect(errorOf(["--frobnicate"])).toBe("unknown option --frobnicate")
    expect(errorOf(["-x"])).toBe("unknown option -x")
    expect(errorOf(["--model"])).toBe("--model needs a value")
    expect(errorOf(["--model", "--json"])).toBe("--model needs a value")
    expect(errorOf(["--model="])).toBe("--model needs a non-empty value")
    expect(errorOf(["--json=yes"])).toBe("--json does not take a value")
    expect(errorOf(["--json", "--quiet"])).toBe("--json and --quiet cannot be combined")
    expect(errorOf(["--session", "s", "--continue"])).toBe("--session and --continue cannot be combined")
    expect(errorOf(["--demo", "1", "--demo-speed", "fast"])).toBe("--demo-speed must be a number of at least 0")
    expect(errorOf(["--demo-speed", "2"])).toBe("--demo-speed and --demo-grace only apply with --demo")
    expect(errorOf(["-i", "--json"])).toBe("interactive mode cannot be combined with --json or --quiet")
  })

  test("help text uses the brand's binary name", () => {
    expect(helpText()).toContain(`  ${brand.binary} [options] <prompt...>`)
    expect(helpText()).toContain("Exit codes: 0 done, 1 failed, 2 usage error, 130 interrupted.")
  })
})
