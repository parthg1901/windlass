/**
 * A setting the engine refuses, at the line CLI: an effort the model does not
 * take is one sentence that names the ones it accepts.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { type SessionId, brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { c, executionStarted, m, opening, stepEnded, stepStarted } from "@windlass/core/testing/scenarios"
import { SUMMARY } from "../../core/test/scenarios/script.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import { UNVERIFIED_HINT, agentRefusal } from "../src/agents.ts"
import { helpText, parseArgs } from "../src/args.ts"
import { JsonSink } from "../src/renderer.ts"
import { render, runCli, stored } from "./helpers.ts"
import { REVIEWER, call, compactionEnded, compactionStarted, settle, succeeded, todo, typedSessions } from "./typed.ts"

setDefaultTimeout(40_000)

describe("as a user types them", () => {
  const { workspace, data, engineFor, interactive } = typedSessions(`${brand.binary}-cli-effort-`)

  test("an effort the model does not take is one sentence that names the ones it accepts, exit code 2", async () => {
    const cwd = workspace()
    const engine = () =>
      createAcpEngine({
        transport: "memory",
        harness: { dataDir: data(cwd), provider: new FakeProvider([]), log: () => {}, engine: { discover: () => [], loadConfig: null, listModels: async () => [{ id: "gpt-test", efforts: ["low", "high"] }] }, defaultModel: "gpt-test" },
        stderr: () => {},
      })
    const run = await runCli(["--cwd", cwd, "--effort", "extreme", "hello"], { engine })
    expect(run.code).toBe(2)
    expect(run.err).toBe(`${brand.binary}: model gpt-test does not offer the reasoning effort "extreme"; it accepts: low, high\n`)
  })
})
