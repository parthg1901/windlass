/**
 * Agents at the line CLI: what the renderer says about a switch and about a
 * call an agent refuses, the `--agent` option, and `/agent` as a user types it,
 * against the real server in this process with a scripted model.
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
  test("a switch of agent is a line with what the agent may do; a call it refuses is the agent's refusal, never the approval policy", () => {
    const out = render(
      stored([
        ...opening("Write note.txt."),
        event("agent.switched", { messageId: null, from: null, to: REVIEWER }),
        stepStarted("a1"),
        call("a1", "c1", "write", { path: "note.txt", content: "x" }),
        event("approval.denied", { messageId: m("a1"), callId: c("c1"), mode: "auto", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "reviewer", refusal: { rule: "effect", effect: "write", text: 'The agent "reviewer" may use only tools that read. "write" changes files.' } }),
        settle("a1", "c1", "error", 'Not run: you are working as the agent "reviewer", which may use only tools that read. "write" changes files. Carry on without it, or tell the user what you would need and why.'),
        stepEnded("a1", "tool_calls"),
        event("agent.switched", { messageId: m("i1"), from: "reviewer", to: null }),
      ]),
      { columns: () => 120 },
    )
    expect(out).toContain("⇄ working as the agent reviewer (read only)\n  Only tools that read (effects: read).\n")
    expect(out).toContain('▸ write note.txt\n  ⊘ refused by the reviewer agent\n    The agent "reviewer" may use only tools that read. "write" changes files.\n')
    expect(out).not.toContain("approval policy")
    expect(out).not.toContain("you are working as")
    expect(out).toContain("⇄ no agent: the instructions and restrictions of reviewer no longer apply · from the next step\n")
  })
})

describe("the command line", () => {
  test("--agent is an option with a value, and the help names it and /agent", () => {
    const parsed = parseArgs(["--agent", "reviewer", "review", "this"])
    expect(parsed.kind === "run" ? [parsed.options.agent, parsed.options.prompt] : null).toEqual(["reviewer", "review this"])
    expect(parseArgs(["--agent"])).toEqual({ kind: "error", message: "--agent needs a value" })
    const help = helpText()
    for (const needle of ["--agent <name>", "/agent [name|none]"]) expect(help).toContain(needle)
  })
})

describe("as a user types them", () => {
  const { workspace, data, engineFor, interactive } = typedSessions(`${brand.binary}-cli-agents-`)
  const REVIEWER_FILE = "---\nname: reviewer\ndescription: Reviews a change without editing anything.\neffects: read\n---\nYou review.\n"
  const DOCS_FILE = "---\nname: docs\ndescription: Writes documentation only.\ntools: read, write\n---\nEdit only files under docs/.\n"
  const BROKEN_FILE = "---\nname: broken\n---\nNo description.\n"

  test("--agent starts the session as it; /agent lists, switches and says what could not be used; a refused call is the agent's", async () => {
    const cwd = workspace({ reviewer: REVIEWER_FILE, docs: DOCS_FILE, broken: BROKEN_FILE })
    const provider = new FakeProvider([[script.toolCall("c1", "write", { path: "note.txt", content: "x" })], [script.text("I may not write as the reviewer.")]])
    const run = await interactive(["--cwd", cwd, "--agent", "reviewer"], engineFor(provider, cwd), async (type, waitFor) => {
      // Which session this is says which agent it runs as, and the record is drawn with what the agent may do.
      await waitFor(/new session ses_\w+ · agent reviewer · \/help lists the commands/)
      await waitFor("⇄ working as the agent reviewer (read only)")
      type("/agent\r")
      await waitFor("Agents (this session runs as reviewer):")
      await waitFor("* reviewer  Reviews a change without editing anything.")
      await waitFor("Definitions with problems:")
      await waitFor(/broken\.md\n\s+not loaded: .*description/)
      type("write note.txt\r")
      await waitFor("⊘ refused by the reviewer agent")
      // The engine's own sentence about the rule, as its log has it.
      await waitFor('The agent "reviewer" may use only tools that read. "write" changes files.')
      await waitFor("I may not write as the reviewer.")
      await waitFor(/✓ done/)
      type("/agent docs\r")
      await waitFor("⇄ agent reviewer → docs (restricted) · from the next step")
      type("/agent docs\r")
      await waitFor("this session runs as the docs agent already")
      type("/agent reviwer\r")
      await waitFor(/\/agent: .*reviewer/)
      type("/agent none\r")
      await waitFor("⇄ no agent: the instructions and restrictions of docs no longer apply")
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.seen).not.toContain("approval policy")
    // The agent's instructions were part of what the model was sent.
    expect(JSON.stringify(provider.requests[0])).toContain('working as the agent \\"reviewer\\"')
  })

  test("an agent that does not exist is a usage error that names the near one, and no session is made", async () => {
    const cwd = workspace({ reviewer: REVIEWER_FILE })
    const run = await runCli(["--cwd", cwd, "--agent", "reviwer", "hello"], { engine: engineFor(new FakeProvider([]), cwd) })
    expect(run.code).toBe(2)
    expect(run.err).toContain("reviewer")
    expect(run.out).toBe("")
  })
})
