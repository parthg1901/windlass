/**
 * A watch's regular expression is matched with a time limit of the engine's own.
 *
 * The pattern comes from a client (`session.watchOutput`), the line from whatever the command prints, and the
 * runtime's matcher backtracks: `(a+)+$` (and ordinary-looking patterns of the same shape, such as
 * `(\w+\s?)+:`) against a line of thirty characters that almost matches takes about a second. Matched in the
 * engine's thread, every such line would hold the whole process for that long.
 *
 * The match is made on a helper thread (`engine/bounded-match.ts`) and the engine waits for it no longer than
 * `WATCH_LIMITS.matchMs` (50 ms). A match that takes longer is given up on, and the watch is ended: on record
 * (`watch.ended` with the reason `too_slow`), with a notice to the user that names the budget. The command goes
 * on, its other watches keep firing, and an expression that is slow on one line costs the engine the budget once.
 */
import { afterAll, expect, test } from "bun:test"
import { boundedTest, stopBoundedMatcher } from "../../src/engine/bounded-match.ts"
import { watchMatcher } from "../../src/engine/spawn.ts"
import { type StoredEvent, WATCH_LIMITS } from "../../src/event/durable.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ToolContext } from "../../src/tool/tool.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(() => {
  removeHarnessDirectories()
  stopBoundedMatcher()
})

/** A line that makes `(a+)+$` backtrack for about a second: thirty characters, far below the 16 KiB of a line that is looked at. */
const SLOW_PATTERN = "(a+)+$"
const SLOW_LINE = `${"a".repeat(29)}!`

test(
  "matching one short line of output against a user's regular expression should not hold the engine for anything like a second",
  () => {
    const pattern = SLOW_PATTERN
    expect(pattern.length).toBeLessThanOrEqual(WATCH_LIMITS.patternChars)
    const matcher = watchMatcher({ pattern, regex: true, ignoreCase: false })
    if ("problem" in matcher) throw new Error(matcher.problem)
    const line = SLOW_LINE
    const started = performance.now()
    const matched = matcher.matches(line)
    const elapsed = performance.now() - started
    expect(matched).toBe(false)
    // The budget is 50 ms, and unbounded it takes about a second. This first match also starts the helper thread,
    // which takes a few milliseconds here and about 75 on a macOS CI runner: 250 ms is still a quarter of the second.
    expect(elapsed).toBeLessThan(250)
    // The match was given up on, and the expression is not tried again: every later line is no match, at once.
    expect(matcher.gaveUp()).toBe(true)
    const again = performance.now()
    expect(matcher.matches("aaa")).toBe(false)
    expect(performance.now() - again).toBeLessThan(10)
  },
  60_000,
)

test("an expression that answers in time matches as it always did, also right after another was given up on", () => {
  expect(WATCH_LIMITS.matchMs).toBe(50)
  expect(boundedTest(new RegExp(SLOW_PATTERN), SLOW_LINE, WATCH_LIMITS.matchMs)).toBe("over_budget")
  // The helper that was given up on is gone; the next match starts another and is answered. Starting a thread takes
  // longer than the budget on a loaded runner, so these are given a second: what is shown is the answer, not its speed.
  const ROOMY_MS = 1000
  expect(boundedTest(/err(or)?:/i, "12:00 ERROR: disk full", ROOMY_MS)).toBe("matched")
  expect(boundedTest(/err(or)?:/, "12:00 ERROR: disk full", ROOMY_MS)).toBe("no_match")
  // An expression that keeps its place between calls is tried from the start of every line.
  const sticky = /ready/g
  expect([boundedTest(sticky, "ready", ROOMY_MS), boundedTest(sticky, "ready", ROOMY_MS), sticky.lastIndex]).toEqual(["matched", "matched", 0])
  const matcher = watchMatcher({ pattern: "^listening on :(\\d+)$", regex: true, ignoreCase: false })
  if ("problem" in matcher) throw new Error(matcher.problem)
  expect([matcher.matches("listening on :3000"), matcher.matches("listening on port 3000"), matcher.gaveUp()]).toEqual([true, false, false])
  // Many lines cost little: the wait for the helper's answer is a few hundredths of a millisecond each.
  const started = performance.now()
  for (let index = 0; index < 2000; index += 1) matcher.matches(`request ${index} served in 3 ms`)
  expect(performance.now() - started).toBeLessThan(2000)
  // Text is looked for as it is and is never slow.
  const plain = watchMatcher({ pattern: "(a+)+$", regex: false, ignoreCase: false })
  if ("problem" in plain) throw new Error(plain.problem)
  expect([plain.matches("it printed (a+)+$ here"), plain.matches(SLOW_LINE), plain.gaveUp()]).toEqual([true, false, false])
})

test("a watch whose expression is too slow on a line is ended, on record and with a notice that names the budget; the command and its other watches go on", async () => {
  const U = script.usage({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 })
  let end: (result: { exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string }) => void = () => {}
  const exited = new Promise<Parameters<typeof end>[0]>((resolve) => (end = resolve))
  const listeners = new Set<(line: string) => void>()
  const lines = (listener: (line: string) => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  const print = (line: string) => [...listeners].forEach((listener) => listener(line))
  const h = new Harness({ spawn: {} })
  try {
    h.provider.enqueue([script.toolCall("call_1", "shell", { command: "bun run dev", background: true } as never), U], [script.text("Started."), U], [script.text("It is ready."), U])
    h.tools.on("shell", (_input: Record<string, unknown>, context: ToolContext) => {
      const stop = async () => end({ exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: 1, output: "" })
      return `Started in the background as ${context.background!.command({ command: "bun run dev", logPath: null, stop, output: () => "", lines, exited }).id}.`
    })
    const session = h.create()
    session.send("Start the dev server.")
    await h.settled()
    const slow = session.watchOutput("bg_1", { pattern: SLOW_PATTERN, regex: true, limit: 5 })
    const other = session.watchOutput("bg_1", { pattern: "ready", limit: 1 })
    expect(listeners.size).toBe(2)

    // One line that the slow expression backtracks on: the engine is held for the budget, not for a second.
    const started = performance.now()
    print(SLOW_LINE)
    expect(performance.now() - started).toBeLessThan(500)
    const ended = h.log().filter((item): item is StoredEvent<"watch.ended"> => item.type === "watch.ended")
    expect(ended.map((item) => item.data)).toEqual([{ watchId: slow.watchId, spawnId: "bg_1", reason: "too_slow" }])
    // The user is told once, with the budget; the model is told nothing (it was never told of the watch).
    const notices = h.diagnostics.filter((item) => item.kind === "watch")
    expect(notices.map((item) => item.message)).toEqual([
      `The watch ${slow.watchId} on background command bg_1 (pattern /(a+)+$/) was ended: matching its regular expression against one line of the output took longer than 50 ms, and was given up on. The command goes on. Set a watch with a simpler pattern: repetition inside repetition, such as (a+)+, is what makes one slow.`,
    ])
    expect(h.log().filter((item) => item.type === "inbox.enqueued")).toHaveLength(1)
    // It follows nothing any more: the same line again costs nothing and writes nothing.
    expect(listeners.size).toBe(1)
    const before = h.log().length
    const again = performance.now()
    for (let index = 0; index < 20; index += 1) print(SLOW_LINE)
    expect(performance.now() - again).toBeLessThan(100)
    expect(h.log()).toHaveLength(before)
    expect(session.projection().session.spawned!.running[0]!.watches!.map((watch) => [watch.watchId, watch.ended])).toEqual([
      [slow.watchId, "too_slow"],
      [other.watchId, null],
    ])

    // The command goes on, and its other watch fires as before.
    print("server ready")
    await h.settled()
    expect(h.log().filter((item) => item.type === "watch.fired").map((item) => (item as StoredEvent<"watch.fired">).data.watchId)).toEqual([other.watchId])
    expect(h.diagnostics.filter((item) => item.kind !== "watch")).toEqual([])
    h.verify()
  } finally {
    await h.dispose()
  }
})
