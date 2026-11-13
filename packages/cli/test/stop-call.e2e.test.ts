/**
 * `/stop`: one running tool call is stopped and the turn goes on. What the
 * transcript says about it, from hand-written events; and the command as a
 * user types it, against the real server in this process with a scripted
 * model and a real command.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { c, m, opening, stepStarted } from "@windlass/core/testing/scenarios"
import { BUILTIN_COMMANDS, lookup } from "../src/slash.ts"
import { render, stored } from "./helpers.ts"
import { call, settle, typedSessions } from "./typed.ts"

setDefaultTimeout(40_000)

const started = (id: string, callId: string) => event("tool.started", { messageId: m(id), callId: c(callId) } as never)
const stopAsked = (id: string, callId: string) => event("tool.cancel_requested", { messageId: m(id), callId: c(callId) })

describe("what the transcript says", () => {
  test("a stopped command is not a failure: it says you stopped it, and shows what it had printed", () => {
    const out = render(
      stored([
        ...opening("Run the server."),
        stepStarted("a1"),
        call("a1", "c1", "shell", { command: "bun dev" }),
        started("a1", "c1"),
        stopAsked("a1", "c1"),
        settle("a1", "c1", "error", "listening on :3000\nGET / 200\n\n[Stopped by the user. The command and its child processes were stopped; the output above is everything it printed before that.]", { interrupted: "call" }),
      ]),
      { columns: () => 120 },
    )
    expect(out).toContain("■ stopping shell bun dev · this call only; the turn goes on\n")
    expect(out).toMatch(/  ■ shell bun dev · stopped by you[^\n]*\n    listening on :3000\n    GET \/ 200\n/)
    expect(out).not.toContain("✗")
  })

  test("a call that cannot be stopped midway finishes, and its line says so", () => {
    const out = render(
      stored([
        ...opening("Write the file."),
        stepStarted("a1"),
        call("a1", "c1", "write", { path: "notes.md", content: "x\n" }),
        started("a1", "c1"),
        stopAsked("a1", "c1"),
        settle("a1", "c1", "success", "Wrote notes.md (1 line)."),
      ]),
      { columns: () => 120 },
    )
    expect(out).toContain("■ stopping write notes.md · this call only; the turn goes on\n")
    expect(out).toMatch(/  ✓ write notes\.md[^\n]*\n    it could not be stopped midway and finished: this is its result\n/)
    expect(out).not.toContain("stopped by you")
  })

  test("/stop is a command of the prompt, with a number or nothing", () => {
    expect(lookup("/stop", [BUILTIN_COMMANDS])).toMatchObject({ kind: "command", command: { name: "stop" }, rest: "" })
    expect(lookup("/stop 2", [BUILTIN_COMMANDS])).toMatchObject({ kind: "command", command: { name: "stop" }, rest: "2" })
  })
})

describe("as a user types it", () => {
  const { workspace, engineFor, interactive } = typedSessions(`${brand.binary}-cli-stop-`)

  test("/stop stops the one running command, its line shows the output so far, and the turn goes on to its answer", async () => {
    const cwd = workspace()
    const provider = new FakeProvider([[script.toolCall("call_1", "shell", { command: "echo started; sleep 31.7391" })], [script.text("The command was stopped, so I did not wait for it.")]])
    const run = await interactive(["--cwd", cwd, "--approval", "full"], engineFor(provider, cwd), async (type, waitFor) => {
      // Nothing runs yet: said, with nothing sent.
      type("/stop\r")
      await waitFor("nothing is running, so there is nothing to stop")
      type("run the long command\r")
      await waitFor("▸ shell echo started; sleep 31.7391")
      // The call starts a moment after it is shown: asked until it is taken.
      for (let tries = 0; ; tries += 1) {
        type("/stop\r")
        const taken = await waitFor("■ stopping shell echo started; sleep 31.7391 · this call only; the turn goes on", 400).then(() => true, () => false)
        if (taken || tries > 30) break
      }
      await waitFor(/■ shell echo started; sleep 31\.7391 · stopped by you/)
      await waitFor("The command was stopped, so I did not wait for it.")
      await waitFor("✓ done")
      // A number that names no running call says so.
      type("/stop 7\r")
      await waitFor("nothing is running, so there is nothing to stop")
      type("\x04")
    })
    expect(run.code).toBe(0)
    // What it had printed is under its line, and the model read that the user stopped it.
    expect(run.screen).toMatch(/stopped by you[^■]*started/)
    expect(provider.requests.length).toBe(2)
    expect(JSON.stringify(provider.requests[1])).toContain("Stopped by the user")
    expect(run.screen).not.toContain("interrupted")
  })
})
