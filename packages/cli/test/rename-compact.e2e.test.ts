/**
 * `/rename` and `/compact` at the line CLI: the title a session is given, and
 * a compaction the user asks for, which says what happened and is not drawn
 * as a turn's ending.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { type SessionId, brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { c, executionStarted, m, opening, stepEnded, stepStarted } from "@windlass/core/testing/scenarios"
import { SUMMARY } from "../../core/test/scenarios/script.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import { UNVERIFIED_HINT } from "../src/agents.ts"
import { helpText, parseArgs } from "../src/args.ts"
import { JsonSink } from "../src/renderer.ts"
import { render, runCli, stored } from "./helpers.ts"
import { REVIEWER, call, compactionEnded, compactionStarted, settle, succeeded, todo, typedSessions } from "./typed.ts"

setDefaultTimeout(40_000)

describe("what the renderer says", () => {
  test("a compaction the user asked for while idle is drawn with its sizes, and is no turn's ending", () => {
    const alone = render(stored([executionStarted("exe_2"), compactionStarted("k1", "manual"), compactionEnded("k1", 1), succeeded({ status: "not_needed" }, "exe_2")]), { echoPrompts: false })
    expect(alone).toContain("⇣ compacted the conversation · about 9,000 → 1,200 tokens")
    expect(alone).not.toContain("done")
    expect(alone).not.toContain("step")
  })
})

describe("the command line", () => {
  test("the help names /rename and /compact", () => {
    const help = helpText()
    for (const needle of ["/rename <title>", "/compact"]) expect(help).toContain(needle)
  })
})

describe("as a user types them", () => {
  const { workspace, data, engineFor, interactive } = typedSessions(`${brand.binary}-cli-compact-`)

  test("/rename gives the title, which the listing and a resumed session show", async () => {
    const cwd = workspace()
    const provider = new FakeProvider([[script.text("On it.")]])
    const first = await interactive(["--cwd", cwd], engineFor(provider, cwd), async (type, waitFor) => {
      type("fix the bug\r")
      await waitFor(/✓ done/)
      type("/rename\r")
      await waitFor("/rename needs a title")
      type("/rename   Login   bug \r")
      await waitFor("renamed: Login bug")
      type("\x04")
    })
    expect(first.code).toBe(0)
    const listed = await runCli(["--cwd", cwd, "--list-sessions"], { engine: engineFor(new FakeProvider([]), cwd) })
    expect(listed.out).toContain("Login bug")
    const again = await interactive(["--cwd", cwd, "--continue"], engineFor(new FakeProvider([]), cwd), async (type, waitFor) => {
      await waitFor(/resumed session ses_\w+ "Login bug" · 1 turn/)
      type("\x04")
    })
    expect(again.code).toBe(0)
  })

  test("/compact says there is nothing to compact, then compacts with the sizes and draws no turn ending for it", async () => {
    const cwd = workspace()
    const at = (tokens: number) => script.usage({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0 })
    const provider = new FakeProvider([[script.text("One."), at(3000)], [script.text("Two."), at(3200)], [script.text(SUMMARY)]])
    const run = await interactive(["--cwd", cwd], engineFor(provider, cwd, { manualCompactionMinTokens: 0 }), async (type, waitFor) => {
      type("/compact\r")
      await waitFor("There is nothing to compact: the conversation has not started.")
      type("first\r")
      await waitFor("One.")
      await waitFor(/✓ done/)
      type("second\r")
      await waitFor("Two.")
      await waitFor(/✓ done[^]*✓ done/)
      type("/compact\r")
      await waitFor(/⇣ compacted the conversation · about [\d,]+ → [\d,]+ tokens/)
      type("/compact\r")
      await waitFor("There is nothing to compact: what is in the model's view is what the next request needs")
      type("\x04")
    })
    expect(run.code).toBe(0)
    // Two turns ended, and the compaction was not drawn as a third.
    expect(run.seen.match(/✓ done/g)).toHaveLength(2)
    const resumed = await interactive(["--cwd", cwd, "--continue"], engineFor(new FakeProvider([]), cwd), async (type, waitFor) => {
      await waitFor(/resumed session ses_\w+ "first" · 2 turns/)
      type("\x04")
    })
    expect(resumed.code).toBe(0)
  })
})
