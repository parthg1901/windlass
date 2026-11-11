import { describe, expect, test } from "bun:test"
import { validateEvent } from "@light-harness/core"
import { brand } from "@light-harness/core"
import { scriptTurns } from "../src/fake-engine.ts"
import { findScenario } from "../src/demo/scenarios.ts"
import { runCli } from "./helpers.ts"

const EPHEMERAL = ["text.delta", "reasoning.delta", "tool.input.delta", "tool.progress"]

describe("--json", () => {
  for (const name of ["find-and-fix-a-failing-test", "a-content-policy-refusal", "the-process-dies-while-a-side-effecting-tool-is-running"]) {
    test(`${name}: stdout is JSONL, one event per line, and durable events round-trip through the schema`, async () => {
      const result = await runCli(["--demo", name, "--demo-speed", "0", "--json"], { stdoutTTY: true })
      expect(result.out.endsWith("\n")).toBe(true)
      const lines = result.out.slice(0, -1).split("\n")
      const events = lines.map((line) => JSON.parse(line) as { type: string; v?: number; data?: unknown; seq?: number })
      expect(events.map((item) => JSON.stringify(item))).toEqual(lines)

      const durable = events.filter((item) => !EPHEMERAL.includes(item.type))
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
