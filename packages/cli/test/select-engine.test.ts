import { describe, expect, test } from "bun:test"
import { brand } from "@windlass/core"
import { findScenario } from "../src/demo/scenarios.ts"
import { FakeEngine } from "../src/fake-engine.ts"
import { REAL_ENGINE_EXPORT, REAL_ENGINE_MODULE, selectEngine } from "../src/select-engine.ts"
import { opened } from "./fixtures/stub-engine.ts"
import { runCli } from "./helpers.ts"

// Module paths are relative to src/select-engine.ts, as `./real-engine.ts` is.
const STUB = "../test/fixtures/stub-engine.ts"
const BROKEN = "../test/fixtures/broken-engine.ts"
const BARE = "../test/fixtures/bare-engine.ts"
const MISSING = "./no-such-engine.ts"

describe("engine selection", () => {
  test("the real engine is ./real-engine.ts exporting createRealEngine", () => {
    expect([REAL_ENGINE_MODULE, REAL_ENGINE_EXPORT]).toEqual(["./real-engine.ts", "createRealEngine"])
  })

  test("--demo gets the fake engine without touching the real one", async () => {
    const selected = await selectEngine({ scenario: findScenario("a-plain-answer")!.scenario, options: { speed: 0 } }, MISSING)
    expect(selected.kind === "engine" && selected.engine instanceof FakeEngine).toBe(true)
  })

  test("without the module: one line on stderr and the usage exit code", async () => {
    const result = await runCli(["hello"], { realEngineModule: MISSING })
    expect(result).toEqual({ code: 2, out: "", err: `${brand.binary}: the real engine is not available in this build; try \`${brand.binary} --demo list\`\n` })
  })

  test("a module that fails to load is reported the same way, with the reason", async () => {
    const result = await runCli(["hello"], { realEngineModule: BROKEN })
    expect(result.code).toBe(2)
    expect(result.err).toBe(`${brand.binary}: the real engine is not available in this build (failed to load: the step loop is not wired up yet); try \`${brand.binary} --demo list\`\n`)
  })

  test("with the module present a prompt runs through it, flags included", async () => {
    opened.length = 0
    const result = await runCli(["--model", "gpt-test", "--max-steps", "7", "what", "is", "this"], { realEngineModule: STUB })
    expect(result.code).toBe(0)
    expect(result.out).toContain("It is a coding-agent harness.\n")
    expect(opened).toEqual([{ session: { kind: "new" }, cwd: process.cwd(), model: "gpt-test", effort: null, agent: null, maxSteps: 7, approval: null, unattended: null, attended: false }])
  })
})

describe("--list-sessions and --models", () => {
  test("print a table", async () => {
    const sessions = await runCli(["--list-sessions"], { realEngineModule: STUB })
    expect(sessions.code).toBe(0)
    expect(sessions.out).toBe("ses_2  2026-11-11 09:05  gpt-test   Fix the add test\nses_1  2026-11-10 17:30  gpt-other  (untitled)\n")
    const models = await runCli(["--models"], { realEngineModule: STUB })
    expect(models.out).toBe("* gpt-test   effort: low, medium, high  the default model\n  gpt-other\n\n* the default when --model is not given\n")
  })

  test("with --json, one object per line", async () => {
    const result = await runCli(["--models", "--json"], { realEngineModule: STUB })
    expect(result.out.trim().split("\n").map((line) => JSON.parse(line).id)).toEqual(["gpt-test", "gpt-other"])
  })

  test("an engine without them says so", async () => {
    const result = await runCli(["--list-sessions"], { realEngineModule: BARE })
    expect(result).toEqual({ code: 1, out: "", err: `${brand.binary}: --list-sessions is not supported by this engine\n` })
  })

  test("without the real engine it is the usual usage error", async () => {
    expect((await runCli(["--models"], { realEngineModule: MISSING })).code).toBe(2)
  })
})
