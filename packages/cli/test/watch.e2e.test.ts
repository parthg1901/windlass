/**
 * `/watch`: the agent is told when a background command prints a line the
 * user named. What was typed after the command, the listing, and what the
 * transcript says about a watch (from hand-written events); and the command
 * as a user types it, against the real server in this process with a
 * scripted model and a real command.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { brand, event, text } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { m, opening } from "@windlass/core/testing/scenarios"
import { WATCH_USAGE, watchEntry, watchLines } from "../src/features.ts"
import { render, stored } from "./helpers.ts"
import { typedSessions } from "./typed.ts"

setDefaultTimeout(40_000)

describe("what was typed after /watch", () => {
  test("a command and a text (spaces and all), options before the text, a list, a removal; mistakes say what to type", () => {
    expect(watchEntry("")).toEqual({ kind: "list" })
    expect(watchEntry("list")).toEqual({ kind: "list" })
    expect(watchEntry("bg_1 listening on port")).toEqual({ kind: "set", command: "bg_1", pattern: "listening on port", regex: false, ignoreCase: false, limit: null })
    expect(watchEntry("bg_1 --regex --ignore-case --times 3 error:\\s+\\d+")).toEqual({ kind: "set", command: "bg_1", pattern: "error:\\s+\\d+", regex: true, ignoreCase: true, limit: 3 })
    // Two dashes end the options: the text may start with them.
    expect(watchEntry("bg_1 -- --verbose mode")).toMatchObject({ kind: "set", pattern: "--verbose mode", regex: false })
    expect(watchEntry("remove bg_1.w2")).toEqual({ kind: "remove", watchId: "bg_1.w2" })
    expect(watchEntry("remove")).toEqual({ problem: "/watch remove takes one watch's ID, as /watch lists them: /watch remove bg_1.w1" })
    expect(watchEntry("bg_1")).toEqual({ problem: `/watch bg_1 needs the text to look for. ${WATCH_USAGE}` })
    expect(watchEntry("bg_1 --times many x")).toEqual({ problem: "/watch --times takes a number: how often the watch may fire, such as --times 3" })
  })

  test("the listing names each running command with its watches, or says there is nothing to watch", () => {
    expect(watchLines({ sessionId: "s", commands: [] }).map((line) => line.text)[0]).toBe("No background command is running, so there is no output to watch.")
    const lines = watchLines({
      sessionId: "s",
      commands: [
        { spawnId: "bg_1", command: "bun run dev", logPath: null, watches: [{ watchId: "bg_1.w1", pattern: "ready", regex: false, ignoreCase: false, description: 'text "ready"', limit: 1, fired: 1, watching: false }, { watchId: "bg_1.w2", pattern: "error", regex: true, ignoreCase: true, description: "pattern /error/i", limit: 3, fired: 1, watching: true }] },
        { spawnId: "bg_2", command: "tail -f app.log", logPath: null, watches: [] },
      ],
    })
    expect(lines.map((line) => `${" ".repeat(line.indent ?? 0)}${line.text}`)).toEqual([
      "Background commands running (2):",
      "  bg_1 · bun run dev",
      '    bg_1.w1 · text "ready" · fired 1 of 1 · done',
      "    bg_1.w2 · pattern /error/i · fired 1 of 3",
      "  bg_2 · tail -f app.log",
      "    no watch on its output",
      WATCH_USAGE,
    ])
  })
})

describe("what the transcript says", () => {
  test("a watch that is set, fires and ends; the message it sends is the watch's, never shown as typed by the user", () => {
    const fired = event("watch.fired", { watchId: "bg_1.w1", spawnId: "bg_1", firing: 1, line: "Server listening on http://localhost:3000", messageId: m("w1") })
    const out = render(
      stored([
        ...opening("Start the server."),
        event("watch.started", { watchId: "bg_1.w1", spawnId: "bg_1", pattern: "listening on", regex: false, ignoreCase: false, limit: 2 }),
        event("inbox.enqueued", { messageId: m("w1"), origin: "background_watch", delivery: "steer", content: text("Background command bg_1 printed a line that matches the watch the user set on its output.") }),
        fired,
        event("watch.ended", { watchId: "bg_1.w1", spawnId: "bg_1", reason: "removed" }),
      ]),
      { columns: () => 140 },
    )
    expect(out).toContain('◉ watching background bg_1 for text "listening on" · the agent is told when it prints a matching line (up to 2 times) · bg_1.w1\n')
    expect(out).toContain("◉ watch bg_1.w1: background bg_1 printed a matching line (1 of 2) · the agent is told · sent by the watch, not typed by you\n    Server listening on http://localhost:3000\n")
    expect(out).toContain("◉ watch bg_1.w1 removed\n")
    // The message itself is the model's to read: it is not echoed as a prompt, nor as a line of an unnamed origin.
    expect(out).not.toContain("background_watch")
    expect(out).not.toContain("› Background command")
  })
})

describe("as a user types it", () => {
  const { workspace, engineFor, interactive } = typedSessions(`${brand.binary}-cli-watch-`)
  const COMMAND = "echo booting; sleep 1.5; echo 'Server listening on http://localhost:3000'; sleep 37.4127"

  test("/watch lists the running command, sets a watch that fires and wakes the agent, and says the engine's sentence when it refuses", async () => {
    const cwd = workspace()
    const provider = new FakeProvider([[script.toolCall("call_1", "shell", { command: COMMAND, background: true })], [script.text("Started the server.")], [script.text("It is up now.")]])
    const run = await interactive(["--cwd", cwd, "--approval", "full"], engineFor(provider, cwd), async (type, waitFor, written, rows) => {
      type("/watch\r")
      await waitFor("No background command is running, so there is no output to watch.")
      type("start the server in the background\r")
      await waitFor(/background \S+ · echo booting/)
      await waitFor("Started the server.")
      await waitFor("✓ done")
      const id = /background (\S+) · echo booting/.exec(written())![1]!
      // The engine's own sentence for a command that does not run, and for a pattern it cannot use.
      type("/watch bg_nope ready\r")
      await waitFor("No background command bg_nope is running, so its output cannot be watched")
      type(`/watch ${id} --regex (\r`)
      await waitFor("The watch was not set.")
      // Set while the command runs, for a line it has not printed yet.
      type(`/watch ${id} listening on\r`)
      await waitFor(`◉ watching background ${id} for text "listening on" · the agent is told when it prints a matching line (once)`)
      type("/watch\r")
      await waitFor(new RegExp(`${id}\\.w1 · text "listening on" · fired [01] of 1`))
      // The line comes: said as the watch's message, and the agent, which was idle, answers it.
      await waitFor(`◉ watch ${id}.w1: background ${id} printed a matching line (1 of 1) · the agent is told · sent by the watch,`)
      await waitFor("It is up now.")
      await waitFor(/It is up now\.[\s\S]*✓ done/)
      // The turn the watch started ended under the prompt: a blank line above the prompt, as after a turn the user typed.
      for (let tries = 0; tries < 100 && !(rows().findLast((row) => row.trim() !== "") ?? "").startsWith("›"); tries += 1) await Bun.sleep(10)
      const shown = rows()
      const prompt = shown.findLastIndex((row) => row.startsWith("›"))
      expect(shown[prompt - 1]).toBe("")
      expect(shown[prompt - 2]).toContain("background command still running")
      // A watch that is over cannot be removed, and that is said.
      type(`/watch remove ${id}.w1\r`)
      await waitFor(`there is no watch ${id}.w1 that could still fire`)
      type("\x04")
    })
    // The matching line is under the watch's line; the model was told in a message of the harness's, not the user's.
    expect(run.screen).toContain("sent by the watch, not typed by you Server listening on http://localhost:3000")
    expect(run.screen).not.toContain("background_watch")
    // The turn the watch started ended under the prompt: a blank line above the prompt again, as after a typed turn.
    expect(provider.requests.length).toBe(3)
    expect(JSON.stringify(provider.requests[2])).toContain("printed a line that matches the watch the user set on its output")
  })
})
