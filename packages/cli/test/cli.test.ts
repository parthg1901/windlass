import { describe, expect, test } from "bun:test"
import { brand } from "@windlass/core"
import { findScenario } from "../src/demo/scenarios.ts"
import { FakeEngine } from "../src/fake-engine.ts"
import { CLI, runCli } from "./helpers.ts"

const demo = (name: string, ...more: string[]) => ["--demo", name, "--demo-speed", "0", ...more]

describe("exit codes", () => {
  test("0 when the turn completes", async () => {
    expect((await runCli(demo("a-plain-answer"))).code).toBe(0)
  })

  test("1 when it fails", async () => {
    for (const name of ["a-non-retryable-error-authentication", "the-attempt-budget-runs-out", "the-resume-cap-the-same-execution-crashes-4-times"])
      expect((await runCli(demo(name))).code, name).toBe(1)
  })

  test("130 when it was interrupted", async () => {
    for (const name of ["cancel-while-text-is-streaming", "cancel-while-waiting-to-retry"]) expect((await runCli(demo(name))).code, name).toBe(130)
  })

  test("2 for usage errors, with the reason on stderr", async () => {
    const cases: [string[], string, Parameters<typeof runCli>[1]?][] = [
      [["--bogus"], "unknown option --bogus"],
      [demo("no-such-scenario"), 'no demo scenario named "no-such-scenario"'],
      [["--cwd", "/definitely/not/here", "hi"], "--cwd /definitely/not/here: not a directory"],
      [[], "the prompt on stdin is empty", { stdin: "  \n" }],
      [["--json"], "--json needs a prompt", { stdinTTY: true }],
      [["-i", "hello"], "interactive mode needs a terminal on stdin"],
    ]
    for (const [argv, message, options] of cases) {
      const result = await runCli(argv, options)
      expect(result.code, argv.join(" ")).toBe(2)
      expect(result.out).toBe("")
      expect(result.err).toContain(`${brand.binary}: ${message}`)
    }
  })

  test("the process exits with the turn's code", async () => {
    for (const [name, code] of [["a-plain-answer", 0], ["a-non-retryable-error-usage-limit", 1], ["cancel-while-one-tool-is-running", 130]] as const) {
      const proc = Bun.spawn(["bun", CLI, ...demo(name)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      expect(await proc.exited, name).toBe(code)
    }
    const usage = Bun.spawn(["bun", CLI, "--nope"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    expect(await usage.exited).toBe(2)
  })
})

describe("commands", () => {
  test("--version and --help", async () => {
    expect((await runCli(["--version"])).out).toBe(`${brand.name} 0.0.0+source (${process.platform}-${process.arch})\n`)
    const help = await runCli(["--help"])
    expect(help.code).toBe(0)
    expect(help.out).toContain(`${brand.binary} [options] <prompt...>`)
  })

  test("--demo list names every scenario with a number", async () => {
    const result = await runCli(["--demo", "list"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("Showcase\n   1  find-and-fix-a-failing-test\n")
    expect(result.out).toContain("   3  a-plain-answer\n")
    expect(findScenario("3")?.name).toBe("a-plain-answer")
    expect(findScenario("a-plain")?.name).toBe("a-plain-answer")
  })

  test("without the real engine in this build a prompt is a usage error, with one line saying so", async () => {
    const result = await runCli(["hello"], { realEngineModule: "./no-such-engine.ts" })
    expect(result.code).toBe(2)
    expect(result.out).toBe("")
    expect(result.err).toBe(`${brand.binary}: the real engine is not available in this build; try \`${brand.binary} --demo list\`\n`)
  })

  test("the package's bin entries are the brand's binary name and its aliases", async () => {
    const pkg: { bin: Record<string, string> } = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(Object.keys(pkg.bin)).toEqual([brand.binary, ...brand.aliases])
  })
})

describe("prompts and sessions reach the engine", () => {
  const recording = () => {
    const sent: string[] = []
    const opened: unknown[] = []
    const engine = new FakeEngine(findScenario("a-plain-answer")!.scenario, { speed: 0 })
    const open = engine.open.bind(engine)
    engine.open = async (request) => {
      opened.push(request)
      const session = await open(request)
      const send = session.send.bind(session)
      session.send = (text) => {
        sent.push(text)
        return send(text)
      }
      return session
    }
    return { engine, sent, opened }
  }

  test("a prompt given as arguments", async () => {
    const r = recording()
    const result = await runCli(["--model", "m1", "--effort", "low", "explain", "this"], { engine: () => r.engine })
    expect(result.code).toBe(0)
    expect(r.sent).toEqual(["explain this"])
    expect(r.opened).toEqual([{ session: { kind: "new" }, cwd: process.cwd(), model: "m1", effort: "low", agent: null, maxSteps: null, approval: null, unattended: null, attended: false }])
    // The typed prompt replaces the scripted one; it is not echoed, because the user just typed it.
    expect(result.out.startsWith("∴ thought")).toBe(true)
  })

  test("a prompt on stdin, and --session / --continue", async () => {
    const piped = recording()
    expect((await runCli(["--session", "ses_42"], { stdin: "fix it\n", engine: () => piped.engine })).code).toBe(0)
    expect(piped.sent).toEqual(["fix it"])
    expect(piped.opened).toMatchObject([{ session: { kind: "resume", id: "ses_42" } }])
    const continued = recording()
    await runCli(["-c", "again"], { engine: () => continued.engine })
    expect(continued.opened).toMatchObject([{ session: { kind: "continue" } }])
  })
})
