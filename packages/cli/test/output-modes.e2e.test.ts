import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { validateEvent } from "@windlass/core"
import { brand } from "@windlass/core"
import { scriptTurns } from "../src/fake-engine.ts"
import { findScenario } from "../src/demo/scenarios.ts"
import { CLI, runCli } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "@windlass/core/testing"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const EPHEMERAL = ["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]

describe("--json", () => {
  for (const name of ["find-and-fix-a-failing-test", "a-content-policy-refusal", "the-process-dies-while-a-side-effecting-tool-is-running"]) {
    test(`${name}: stdout is JSONL, one event per line, and durable events round-trip through the schema`, async () => {
      const result = await runCli(["--demo", name, "--demo-speed", "0", "--json"], { stdoutTTY: true })
      expect(result.out.endsWith("\n")).toBe(true)
      const lines = result.out.slice(0, -1).split("\n")
      const events = lines.map((line) => JSON.parse(line) as { type: string; v?: number; data?: unknown; seq?: number })
      expect(events.map((item) => JSON.stringify(item))).toEqual(lines)

      // After each turn's ending event the CLI's own summary line, which is not an engine event.
      const summaries = events.filter((item) => item.type === "cli.summary")
      expect(summaries.length).toBe(events.filter((item) => /^execution\.(succeeded|failed|interrupted)$/.test(item.type)).length)
      const durable = events.filter((item) => !EPHEMERAL.includes(item.type) && item.type !== "cli.summary")
      for (const item of durable) expect(validateEvent({ type: item.type, v: item.v!, data: item.data })).toEqual({ type: item.type, v: item.v, data: item.data } as never)
      expect(durable.map((item) => item.seq)).toEqual(durable.map((_, index) => index + 1))
      expect(events.some((item) => EPHEMERAL.includes(item.type))).toBe(true)

      // Exactly the scripted durable events, in order.
      const script = scriptTurns(findScenario(name)!.scenario)
      const scripted = [...script.preamble, ...script.turns.flatMap((turn) => turn.events.map((planned) => planned.event))]
      expect(durable.map((item) => ({ type: item.type, v: item.v, data: item.data }))).toEqual(scripted.map((item) => JSON.parse(JSON.stringify(item))))
    })
  }

  test("writes notices to stderr, never to stdout", async () => {
    const result = await runCli(["--demo", "a-non-retryable-error-authentication", "--demo-speed", "0", "--json"])
    expect(result.code).toBe(1)
    for (const line of result.out.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow()
  })
})

describe("--quiet", () => {
  test("prints only the final assistant text", async () => {
    const result = await runCli(["--demo", "find-and-fix-a-failing-test", "--demo-speed", "0", "--quiet"])
    expect(result.code).toBe(0)
    expect(result.out).toBe("Fixed. `add` in `src/add.ts` returned `a - b`; it now returns `a + b`.\n\n`bun test src/add.test.ts` passes (1 pass, 0 fail).\n")
    expect(result.err).toBe("")
  })

  test("prints nothing on stdout when the turn fails, and the reason on stderr", async () => {
    const result = await runCli(["--demo", "a-non-retryable-error-authentication", "--demo-speed", "0", "-q"])
    expect(result.code).toBe(1)
    expect(result.out).toBe("")
    expect(result.err).toBe(`${brand.binary}: failed: Signed out: sign in again to continue.\n`)
  })
})

describe("--json for a live reader", () => {
  test("each line arrives as its event happens, and stdout holds JSON lines only, even across a Ctrl-C", async () => {
    const proc = Bun.spawn(["bun", CLI, "--demo", "a-long-build-command", "--json", "--demo-speed", "2"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    try {
      const arrivals: { at: number; line: string }[] = []
      const decoder = new TextDecoder()
      let buffer = ""
      let interrupted = false
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true })
        for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
          arrivals.push({ at: Date.now(), line: buffer.slice(0, end) })
          buffer = buffer.slice(end + 1)
        }
        if (!interrupted && arrivals.filter((item) => item.line.includes('"tool.progress"')).length >= 3) {
          interrupted = true
          proc.kill("SIGINT")
        }
      }
      expect(await proc.exited).toBe(130)
      expect(buffer).toBe("")
      const types = arrivals.map((item) => (JSON.parse(item.line) as { type: string }).type)
      expect(types).toContain("execution.interrupt_requested")
      expect(types.slice(-2)).toEqual(["execution.interrupted", "cli.summary"])
      // Lines came in over the run, not in one burst at the end.
      const spread = arrivals.at(-1)!.at - arrivals[0]!.at
      expect(spread).toBeGreaterThan(1000)
      expect(new Set(arrivals.map((item) => Math.floor(item.at / 100))).size).toBeGreaterThan(5)
      expect(await new Response(proc.stderr).text()).toBe(`${brand.binary}: stopping; press Ctrl-C again to exit now\n`)
    } finally {
      proc.kill("SIGKILL")
    }
  }, 30_000)
})

describe("--quiet errors", () => {
  test("a refused turn, a failure and a usage error all go to stderr; stdout has only answers", async () => {
    const refusal = await runCli(["--demo", "a-content-policy-refusal", "--demo-speed", "0", "-q"])
    expect(refusal.code).toBe(0)
    expect(refusal.out).toBe("It exports a.\na.\n")
    expect(refusal.err).toBe(`${brand.binary}: failed: The provider refused the request.\n`)
    const interrupted = await runCli(["--demo", "cancel-while-text-is-streaming", "--demo-speed", "0", "-q"])
    expect(interrupted).toEqual({ code: 130, out: "", err: `${brand.binary}: interrupted\n` })
    const unavailable = await runCli(["-q", "hello"], { realEngineModule: "./no-such-engine.ts" })
    expect(unavailable.out).toBe("")
    expect(unavailable.err).not.toBe("")
  })
})
