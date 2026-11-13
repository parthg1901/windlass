/**
 * What a second user pass found confusing at the line CLI: text typed before
 * the prompt is shown is sent, not lost; a resumed session shows where it
 * stands; background work is described truly (where its output is on this
 * machine, what becomes of it when the turn ends, is stopped or the program
 * exits); a subagent's result is not worded as the user's steer and its
 * tokens are counted beside the turn's; a run that refused calls says so.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CallId, type MessageId, event } from "@windlass/core"
import { FakeProvider, script, waitFor as waitUntil } from "@windlass/core/testing"
import { createAcpEngine } from "../src/acp-engine.ts"
import { spawnMessageText } from "../src/renderer.ts"
import { render, runCli, stored } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(40_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-second-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const workspace = join(root, "work")
mkdirSync(workspace)
const engineFor = (provider: FakeProvider) => () =>
  createAcpEngine({ transport: "memory", harness: { dataDir: join(root, "data"), provider, log: () => {}, engine: { discover: () => [], loadConfig: null } }, stderr: () => {} })

async function interactive(args: readonly string[], provider: FakeProvider, early: string | null, drive: (type: (keys: string) => void, waitFor: (needle: string | RegExp) => Promise<void>) => Promise<void>) {
  const vt = new VirtualTerminal(100)
  let seen = ""
  let typer: ((data: string) => void) | null = null
  const waitFor = async (needle: string | RegExp): Promise<void> => {
    await waitUntil(() => (typeof needle === "string" ? seen.includes(needle) : needle.test(seen)), { timeoutMs: 15_000, intervalMs: 5, what: String(needle), describe: () => `screen:\n${vt.text}` })
  }
  const running = runCli(["--cwd", workspace, ...args], {
    engine: engineFor(provider),
    stdinTTY: true,
    stdoutTTY: true,
    columns: 100,
    env: { NO_COLOR: "1" },
    keys: (type) => {
      typer = type
      // What a user types while the engine starts, ended with Enter before the terminal was in raw mode.
      if (early !== null) type(early)
    },
    onWrite: (text) => {
      seen += text
      vt.write(text)
    },
  })
  await waitFor("› ")
  await drive((keys) => typer!(keys), waitFor)
  const result = await running
  return { ...result, screen: vt.text.replace(/\n\s+/g, " ") }
}

describe("the interactive line CLI", () => {
  test("text typed before the prompt is shown is sent as the first message", async () => {
    const provider = new FakeProvider([[script.text("Got your early message.")]])
    const run = await interactive([], provider, "typed while it started\n", async (type, waitFor) => {
      await waitFor("✓ done")
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.screen).toContain("› typed while it started")
    expect(JSON.stringify(provider.requests[0]!.input)).toContain("typed while it started")
  })

  test("a resumed session shows where it left off: the last turns, compactly", async () => {
    const first = await runCli(["--cwd", workspace, "what is in the box?"], { engine: engineFor(new FakeProvider([[script.text("A small red ball and a note.")]])), env: { NO_COLOR: "1" } })
    expect(first.code).toBe(0)
    const run = await interactive(["-c"], new FakeProvider([]), null, async (type, waitFor) => {
      await waitFor("Where you left off")
      type("\x04")
    })
    expect(run.screen).toContain("Where you left off:")
    expect(run.screen).toContain("› what is in the box?")
    expect(run.screen).toContain("A small red ball and a note.")
    expect(run.screen).toContain("turn 1: done")
  })
})

describe("what the renderer says", () => {
  const m = (id: string) => id as MessageId
  const c = (id: string) => id as CallId

  test("a background command: this machine's path to its output, and what becomes of it when the run exits", () => {
    const out = render(
      stored([
        event("execution.started", { executionId: "exe_1" } as never),
        event("tool.called", { messageId: m("m1"), callId: c("c1"), name: "shell", input: '{"command":"sleep 3; echo built","background":true}', providerData: null }),
        event("spawn.started", { spawnId: "bg_1", messageId: m("m1"), callId: c("c1"), background: true, work: { kind: "command", command: "sleep 3; echo built", logPath: "/tmp/windlass-1001/ses_x/.spill/shell-bg.log" } } as never),
        event("tool.settled", { messageId: m("m1"), callId: c("c1"), outcome: "success", output: "Started in the background as bg_1. Its output is written to /tmp/.spill/shell-bg.log.", truncation: null, attachments: [], display: { background: "bg_1", logPath: "/tmp/.spill/shell-bg.log" } } as never),
        event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } } as never),
      ]),
      { afterTurn: "exits", columns: () => 200 },
    )
    expect(out).toContain("/tmp/windlass-1001/ses_x/.spill/shell-bg.log")
    expect(out).not.toContain("/tmp/.spill/shell-bg.log")
    expect(out).toContain("1 background command still running (bg_1): it is stopped now that windlass exits; the agent is told when the session is next opened")
  })

  test("the message about spawned work says what is true in each case", () => {
    expect(spawnMessageText("background_command", { outcome: "stopped", detail: "Background command bg_1 was stopped (the harness shut down) after 0.5 s." }, false)).toBe(
      "it was stopped because the session closed; the agent is told when the session is next opened",
    )
    expect(spawnMessageText("background_command", { outcome: "stopped", detail: "Background command bg_1 was stopped (interrupted) after 2 s." }, false)).toBe("it was stopped; the agent is told with your next message")
    expect(spawnMessageText("background_command", { outcome: "completed", detail: "exited 0" }, false)).toBe("its result is sent to the agent, which carries on")
    expect(spawnMessageText("background_command", { outcome: "completed", detail: "exited 0" }, true)).toBe("its result is sent to the agent after the current step")
  })

  test("a subagent's answer is not the user's steer, and its tokens are shown beside the turn's", () => {
    const usage = { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 30, reasoningTokens: 0 }
    const out = render(
      stored([
        event("execution.started", { executionId: "exe_1" } as never),
        event("spawn.started", { spawnId: "sp_1", messageId: m("m1"), callId: c("c1"), background: false, work: { kind: "subagent", sessionId: "ses_child000000000000000000", worktree: null } } as never),
        event("spawn.ended", { spawnId: "sp_1", outcome: "completed", detail: "done", exitCode: null, usage, tainted: false, merge: null } as never),
        event("inbox.enqueued", { messageId: m("r1"), origin: "subagent_result", delivery: "steer", content: [{ type: "text", text: "[subagent result]" }] } as never),
        event("inbox.delivered", { messageId: m("r1") } as never),
        event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } } as never),
      ]),
      { columns: () => 200 },
    )
    expect(out).toContain("the subagent's answer reached the agent")
    expect(out).not.toContain("delivered to the agent")
    expect(out).toContain("+ subagents: 1,200 in · 0 cached (0%) · 30 out")
  })

  test("a run that refused calls for lack of approval says how many where it ends", () => {
    const out = render(
      stored([
        event("execution.started", { executionId: "exe_1" } as never),
        event("approval.denied", { messageId: m("m1"), callId: c("c1"), reason: "unattended", needs: [{ kind: "sandbox-network" }], stop: false } as never),
        event("approval.denied", { messageId: m("m1"), callId: c("c2"), reason: "unattended", needs: [{ kind: "sandbox-network" }], stop: false } as never),
        event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } } as never),
      ]),
      { columns: () => 200 },
    )
    expect(out).toContain("✓ done")
    expect(out).toContain("2 calls were refused: they needed your approval and nobody was here to give it (--unattended deny).")
  })
})
