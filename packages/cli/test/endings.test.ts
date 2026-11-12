/**
 * How the line CLI says a turn ended: nothing to check (with a hint when
 * checked files changed outside the turn), a subagent's checks left to its
 * parent, the notice of a turn without a closing answer, and a turn's model
 * requests counted as its steps plus the summary calls of its compactions.
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
  test("a turn's model requests are its steps and the summary calls of its compactions, in words and in the --json summary", () => {
    const inTurn = render(
      stored([...opening(), stepStarted("a1"), stepEnded("a1", "tool_calls"), compactionStarted("k1", "auto"), compactionEnded("k1", 2), stepStarted("a2"), stepEnded("a2"), succeeded({ status: "not_configured" })]),
    )
    expect(inTurn).toMatch(/✓ done · no checks configured · 2 steps \+ 2 summary calls · /)

    // The line a script reads after a turn says the same in numbers.
    let json = ""
    const sink = new JsonSink(
      (text) => (json += text),
      () => {},
    )
    for (const item of stored([executionStarted(), stepStarted("a1"), stepEnded("a1"), compactionStarted("k1", "auto"), compactionEnded("k1", 2), succeeded({ status: "not_configured" })])) sink.event(item)
    expect(JSON.parse(json.trim().split("\n").at(-1)!)).toMatchObject({ type: "cli.summary", steps: 1, summaryCalls: 2, requests: 3 })
  })

  test("endings: nothing to check with the hint when checked files changed outside the turn; a subagent's checks are its parent's; no closing answer", () => {
    const unverified = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed", unverified: true })]), { columns: () => 300 })
    expect(unverified).toMatch(/✓ done · nothing to check · 1 step · /)
    expect(unverified).toContain(`  ${UNVERIFIED_HINT}\n`)
    const plain = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed" })]))
    expect(plain).toMatch(/✓ done · nothing to check · 1 step · /)
    expect(plain).not.toContain("outside this turn")
    const child = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "left_to_parent" })]))
    expect(child).toMatch(/✓ done · its checks are left to its parent's turn · 1 step · /)
    const silent = render([
      ...stored([...opening(), stepStarted("a1"), stepEnded("a1")]),
      { type: "notice", sessionId: "ses_test" as SessionId, kind: "no_closing_answer", message: "The model returned an empty response twice after its work, so the turn ended without a closing answer." },
    ])
    expect(silent).toContain("⚠ no closing answer: The model returned an empty response twice after its work,\n  so the turn ended without a closing answer.\n")
  })
})
