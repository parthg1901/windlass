import { describe, expect, test } from "bun:test"
import { type Options, helpText, parseArgs } from "../src/args.ts"
import { brand } from "@windlass/core"

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
      agent: null,
      maxSteps: null,
      approval: null,
      unattended: null,
      cwd: null,
      output: "pretty",
      showReasoning: false,
      interactive: false,
      demo: null,
      demoSpeed: 1,
      demoGraceMs: null,
      engine: "acp",
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
    // A typo is named with the option that was probably meant; a word that is nothing like one is not.
    expect(errorOf(["--modle", "x"])).toBe("unknown option --modle; did you mean --model?")
    expect(errorOf(["--contineu"])).toBe("unknown option --contineu; did you mean --continue?")
    expect(errorOf(["--jsno"])).toBe("unknown option --jsno; did you mean --json?")
    expect(parseArgs(["fork", "--thruogh", "3"])).toEqual({ kind: "error", message: "fork: unknown option --thruogh; did you mean --through?" })
    expect(errorOf(["--model"])).toBe("--model needs a value")
    expect(errorOf(["--model", "--json"])).toBe("--model needs a value")
    expect(errorOf(["--model="])).toBe("--model needs a non-empty value")
    expect(errorOf(["--json=yes"])).toBe("--json does not take a value")
    expect(errorOf(["--json", "--quiet"])).toBe("--json and --quiet cannot be combined")
    expect(errorOf(["--session", "s", "--continue"])).toBe("--session and --continue cannot be combined")
    expect(errorOf(["--demo", "1", "--demo-speed", "fast"])).toBe("--demo-speed must be a number of at least 0")
    expect(errorOf(["--demo-speed", "2"])).toBe("--demo-speed and --demo-grace only apply with --demo")
    expect(errorOf(["-i", "--json"])).toBe("interactive mode cannot be combined with --json or --quiet")
    for (const value of ["0", "-1", "2.5", "many"]) expect(errorOf(["--max-steps", value, "hi"]), value).toBe(value.startsWith("-") ? "--max-steps needs a value" : "--max-steps must be a whole number of at least 1")
    expect(errorOf(["--list-sessions", "--models"])).toBe("--list-sessions and --models cannot be combined")
    expect(errorOf(["--models", "hello"])).toBe("--models takes no prompt")
  })

  test("--max-steps, --list-sessions and --models", () => {
    expect(options(["--max-steps", "12", "go"]).maxSteps).toBe(12)
    expect(options(["--max-steps=1", "go"]).maxSteps).toBe(1)
    expect(parseArgs(["--list-sessions", "--json"])).toMatchObject({ kind: "list", what: "sessions", options: { output: "json" } })
    expect(parseArgs(["--models"])).toMatchObject({ kind: "list", what: "models" })
  })

  test("help text uses the brand's binary name", () => {
    expect(helpText()).toContain(`  ${brand.binary} [options] <prompt...>`)
    // Every exit code is listed, with the one a script must not mistake for success.
    for (const line of ["  0    done", "  1    failed", "  2    usage error", "  3    done, but the project's checks still fail and were left unresolved", "  130  interrupted (Ctrl-C)", "  141  output closed", "  143  terminated (SIGTERM)"])
      expect(helpText()).toContain(line)
    expect(helpText()).toContain('data.verification.status is "unresolved"')
    // Both session commands are listed.
    expect(helpText()).toMatch(/^  \/undo {2,}go back to before your last message/m)
    expect(helpText()).toMatch(/^  \/redo {2,}bring back what the last \/undo took away/m)
    // The full-screen interface is a way to run the program like the others, as the README has it.
    expect(helpText()).toMatch(new RegExp(`^  ${brand.binary} tui \\[options\\] +the full-screen terminal interface \\(${brand.envPrefix}TUI=1 makes it$`, "m"))
    expect(helpText()).not.toMatch(/preview/i)
  })
})
