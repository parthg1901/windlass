/**
 * The model's task list at the line CLI: a `todo` call is drawn as the
 * checklist it left, and a session resumed later shows the list as it stands.
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

describe("what the renderer says", () => {
  test("a todo call is the checklist it left, not a tool row; a list that could not be set is a failed call", () => {
    const items = [
      { text: "Read the code", status: "done" as const },
      { text: "Fix the bug", status: "in_progress" as const },
      { text: "Run the tests", status: "pending" as const },
    ]
    const out = render(
      stored([
        ...opening(),
        stepStarted("a1"),
        call("a1", "c1", "todo", { todos: items }),
        settle("a1", "c1", "success", "Task list updated: 1 done, 1 in progress, 1 pending.\nNow: Fix the bug", todo(items)),
        call("a1", "c2", "todo", { todos: [] }),
        settle("a1", "c2", "error", "The task list was not updated: `todos` must be a list of items. Send the whole list again with this fixed."),
        call("a1", "c3", "todo", { todos: [] }),
        settle("a1", "c3", "success", "Task list cleared.", todo([])),
      ]),
    )
    expect(out).toContain("≡ tasks · 1 of 3 done\n  ✓ Read the code\n  ▸ Fix the bug\n  ○ Run the tests\n")
    expect(out).not.toContain("▸ todo")
    expect(out).toContain("✗ todo")
    expect(out).toContain("≡ tasks · cleared\n")
  })
})

describe("as a user types them", () => {
  const { workspace, data, engineFor, interactive } = typedSessions(`${brand.binary}-cli-tasks-`)

  test("a todo call is a checklist as it happens, and a resumed session shows the list as it stands", async () => {
    const cwd = workspace()
    const items = [
      { text: "Read the code", status: "done" },
      { text: "Fix the bug", status: "in_progress" },
    ]
    const provider = new FakeProvider([[script.toolCall("c1", "todo", { todos: items })], [script.text("On it.")]])
    const first = await interactive(["--cwd", cwd], engineFor(provider, cwd), async (type, waitFor) => {
      type("fix the bug\r")
      await waitFor("≡ tasks · 1 of 2 done")
      await waitFor("▸ Fix the bug")
      await waitFor(/✓ done/)
      type("\x04")
    })
    expect(first.code).toBe(0)
    expect(first.seen).not.toContain("▸ todo")
    const again = await interactive(["--cwd", cwd, "--continue"], engineFor(new FakeProvider([]), cwd), async (type, waitFor) => {
      await waitFor(/resumed session ses_\w+ "fix the bug" · 1 turn/)
      await waitFor("Its task list (1 of 2 done):")
      await waitFor("✓ Read the code")
      await waitFor("▸ Fix the bug")
      type("\x04")
    })
    expect(again.code).toBe(0)
  })
})
