/**
 * In the real `App`: `/watch` sets a watch on a background command's
 * output, lists the commands with their watches and removes one, with the
 * engine's sentence when it refuses; a firing is a row of the watch's own,
 * with the line, never a message the user typed.
 */
import { afterEach, expect, test } from "bun:test"
import { event, text } from "@windlass/core"
import { flat, m } from "./builders.ts"
import { type Mounted, ScriptBackend, mount, said } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function open() {
  const backend = new ScriptBackend()
  mounted = await mount({ width: 170, height: 44, backend })
  const session = backend.session!
  const set: { command: string; watch: object }[] = []
  const removed: string[] = []
  session.watches = async () => ({
    sessionId: "ses_script",
    commands: [{ spawnId: "bg_1", command: "bun run dev", logPath: null, watches: [{ watchId: "bg_1.w1", pattern: "ready", regex: false, ignoreCase: false, description: 'text "ready"', limit: 2, fired: 1, watching: true }] }],
  })
  session.watchOutput = async (command, watch) => {
    if (command !== "bg_1") throw new Error(`No background command ${command} is running, so its output cannot be watched: a watch is set while the command runs. Running: bg_1.`)
    set.push({ command, watch })
    return { watchId: "bg_1.w2", spawnId: "bg_1", pattern: watch.pattern, regex: watch.regex === true, ignoreCase: watch.ignoreCase === true, limit: watch.limit ?? 1, fired: 0 }
  }
  session.unwatchOutput = async (watchId) => {
    removed.push(watchId)
    return watchId === "bg_1.w1"
  }
  return { session, set, removed }
}

async function run(entry: string): Promise<string> {
  await mounted!.setup.mockInput.typeText(entry)
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
  return flat(await mounted!.frame())
}

test("/watch lists the commands with their watches, sets one with its options, removes one, and says the engine's sentence when it refuses", async () => {
  const { set, removed } = await open()
  const listed = await run("/watch")
  expect(listed).toContain("Background commands running (1):")
  expect(listed).toContain("bg_1 · bun run dev")
  expect(listed).toContain('bg_1.w1 · text "ready" · fired 1 of 2')
  await run("/watch bg_1 --ignore-case --times 3 listening on port")
  expect(set).toEqual([{ command: "bg_1", watch: { pattern: "listening on port", regex: false, ignoreCase: true, limit: 3 } }])
  // The engine's sentence, as it gave it.
  await run("/watch bg_9 ready")
  expect(said(await mounted!.frame())).toContain("No background command bg_9 is running, so its output cannot be watched: a watch is set while the command runs. Running: bg_1.")
  expect(await run("/watch bg_1")).toContain("/watch bg_1 needs the text to look for.")
  await run("/watch remove bg_1.w1")
  expect(await run("/watch remove bg_1.w7")).toContain("there is no watch bg_1.w7 that could still fire")
  expect(removed).toEqual(["bg_1.w1", "bg_1.w7"])
})

test("a watch that is set, fires and ends is a row of its own each; its message is the watch's, not a message the user typed", async () => {
  const { session } = await open()
  session.emit(
    event("watch.started", { watchId: "bg_1.w1", spawnId: "bg_1", pattern: "listening on", regex: false, ignoreCase: false, limit: 2 }),
    event("inbox.enqueued", { messageId: m("w1"), origin: "background_watch", delivery: "steer", content: text("Background command bg_1 printed a line that matches the watch the user set on its output.") }),
    event("watch.fired", { watchId: "bg_1.w1", spawnId: "bg_1", firing: 1, line: "Server listening on http://localhost:3000", messageId: m("w1") }),
    event("watch.ended", { watchId: "bg_1.w1", spawnId: "bg_1", reason: "command_ended" }),
  )
  await mounted!.settle()
  const frame = flat(await mounted!.frame())
  expect(said(await mounted!.frame())).toContain('◉ watching background bg_1 for text "listening on" · the agent is told when it prints a matching line (up to 2 times) · bg_1.w1')
  expect(frame).toContain("◉ watch bg_1.w1: background bg_1 printed a matching line (1 of 2) · the agent is told · sent by the watch, not typed by you")
  expect(frame).toContain("Server listening on http://localhost:3000")
  expect(frame).toContain("◉ watch bg_1.w1 ended with its command (background bg_1)")
  // Not a prompt of the user's, and not a line of an unnamed origin.
  expect(frame).not.toContain("background_watch")
  expect(frame).not.toContain("› Background command")
})

test("a watch the engine ended because its pattern took too long says so in its own sentence", async () => {
  const { session } = await open()
  session.emit(
    event("watch.started", { watchId: "bg_1.w1", spawnId: "bg_1", pattern: "(a+)+$", regex: true, ignoreCase: false, limit: 1 }),
    event("watch.ended", { watchId: "bg_1.w1", spawnId: "bg_1", reason: "too_slow" }),
  )
  await mounted!.settle()
  const frame = flat(await mounted!.frame())
  expect(frame).toContain("◉ watch bg_1.w1 ended: its pattern took too long to match a line")
  expect(frame).not.toContain("too_slow")
})
