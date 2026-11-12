/**
 * Frames as text at fixed sizes, from scripted sessions played instantly.
 * The showcase turn is kept as whole-frame snapshots at the three sizes
 * (`__snapshots__`); the other scenarios assert what a user must be able to
 * read in them.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { panelLines } from "../src/panel.ts"
import { Theme } from "../src/theme.ts"
import type { CallUsage } from "../src/transcript.ts"
import { type Mounted, mount, playAll } from "./helpers.ts"

const SIZES = [
  [60, 20],
  [100, 30],
  [200, 50],
] as const

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function played(scenario: string, width: number, height: number): Promise<string> {
  mounted = await mount({ width, height, scenario })
  await playAll(mounted)
  return mounted.frame()
}

describe("the showcase turn", () => {
  for (const [width, height] of SIZES)
    test(`${width}x${height}`, async () => {
      const frame = await played("find-and-fix-a-failing-test", width, height)
      expect(frame).toMatchSnapshot()
      const lines = frame.split("\n")
      expect(lines).toHaveLength(height)
      expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true)
      expect(frame).toContain("✓ edit src/add.ts · +1 -1")
      expect(frame).toContain("○ done · no checks configured · 5 steps")
      expect(lines.at(-3)).toContain("● ready")
      // The panel hides itself below 100 columns.
      expect(frame.includes("Cache per call")).toBe(width >= 100)
    })
})

describe("scenarios a user must be able to read", () => {
  test("an interrupted command: the stop, the call's outcome, the ending", async () => {
    const frame = await played("cancel-while-one-tool-is-running", 100, 30)
    expect(frame).toContain("■ stopping…")
    expect(frame).toMatch(/■ interrupted/)
  })

  test("crash recovery says the turn resumes after the previous process stopped", async () => {
    const frame = await played("the-process-dies-while-the-model-is-streaming", 100, 30)
    expect(frame).toContain("resuming after the previous process stopped unexpectedly")
  })

  test("a retry is its own row with the reason", async () => {
    const frame = await played("a-retryable-failure-before-any-output", 100, 30)
    expect(frame).toMatch(/↻ retrying in .* \(attempt 2\)/)
  })

  test("the three verification endings look different", async () => {
    const passed = await played("the-checks-pass", 100, 30)
    expect(passed).toContain("✓ done · checks passed")
    await mounted?.dispose()
    const unresolved = await played("the-checks-still-fail-after-the-last-allowed-round", 100, 30)
    expect(unresolved).toContain("✗ unresolved · failing checks:")
    await mounted?.dispose()
    const none = await played("no-checks-are-configured", 100, 30)
    expect(none).toContain("○ done · no checks configured")
  })

  test("a queued message waits under the conversation, then is delivered from the queue", async () => {
    const frame = await played("a-queued-message-waits-until-the-session-would-go-idle", 100, 40)
    expect(frame).toContain("↳ delivered from the queue")
  })

  test("a compaction row", async () => {
    const frame = await played("a-compaction-in-the-middle-of-a-long-turn", 100, 40)
    expect(frame).toContain("⇣ compacted the conversation")
  })
})

describe("the usage panel", () => {
  const call = (n: number, input: number, cached: number, extra: Partial<CallUsage> = {}): CallUsage => ({
    n,
    messageId: `a${n}`,
    model: "m",
    kind: "step",
    requests: 1,
    usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: 50, reasoningTokens: 0 },
    diagnostics: [],
    ended: "ok",
    ...extra,
  })
  const calls = [call(1, 10_000, 0), call(2, 12_000, 9_000), call(3, 14_000, 13_000, { diagnostics: ["prefix_violation"] }), call(4, 20_000, 0, { kind: "compaction" })]
  const lines = panelLines(
    {
      session: { id: "ses_0123456789abcdef0123", cwd: "/home/me/project", title: null, model: "gpt-6-luna", effort: "low", taint: null },
      calls,
      activity: { executing: false, turnStartedAt: null, steps: 0, summaryCalls: 0, call: null, checking: null, compacting: null, retry: null, stopping: false, waiting: null },
      now: 0,
      contextWindow: 272_000,
      connection: "connected",
      home: "/home/me",
    },
    34,
    40,
  ).map((line) => line.map((part) => part.text).join(""))

  test("session totals, the last call, the cache share and the context", () => {
    expect(lines).toContain("dir    ~/project")
    expect(lines.find((line) => line.startsWith("input"))).toMatch(/input\s+56,000\s+20,000/)
    expect(lines.find((line) => line.startsWith(" cached"))).toMatch(/22,000\s+0$/)
    expect(lines.find((line) => line.startsWith(" cache share"))).toMatch(/39%\s+0%$/)
    expect(lines.find((line) => line.startsWith("calls"))).toMatch(/4$/)
    expect(lines.find((line) => line.startsWith("context"))).toBe("context     20k of 272k (7%)")
  })

  test("one bar per call: cached and new input in different glyphs, diagnostics and compactions marked", () => {
    const bars = lines.filter((line) => /^\d /.test(line))
    expect(bars).toHaveLength(4)
    const count = (line: string, glyph: string) => [...line].filter((char) => char === glyph).length
    expect(count(bars[0]!, "█")).toBe(0)
    expect(count(bars[2]!, "█")).toBeGreaterThan(count(bars[1]!, "█"))
    expect(bars[2]).toContain("⚠")
    expect(bars[3]).toContain("C")
    expect(lines.at(-1)).toBe("⚠ diagnostic · C compaction")
  })
})

test("the panel's heading over the bars says how many calls it shows when not all fit, within the panel's width", () => {
  const calls: CallUsage[] = Array.from({ length: 40 }, (_, index) => ({ n: index + 1, messageId: `a${index}`, model: "m", kind: "step", requests: 1, usage: { inputTokens: 5_000, cachedInputTokens: 4_000, outputTokens: 5, reasoningTokens: 0 }, diagnostics: [], ended: "ok" }))
  const lines = panelLines(
    {
      session: { id: "ses_0123456789abcdef0123", cwd: "/home/me/project", title: null, model: "gpt-6-luna", effort: "low", taint: null },
      calls,
      activity: { executing: false, turnStartedAt: null, steps: 0, summaryCalls: 0, call: null, checking: null, compacting: null, retry: null, stopping: false, waiting: null },
      now: 0,
      contextWindow: 272_000,
      connection: "connected",
      home: "/home/me",
    },
    34,
    30,
  ).map((line) => line.map((part) => part.text).join(""))
  const bars = lines.filter((line) => /^\d+ /.test(line))
  expect(bars.length).toBeLessThan(40)
  expect(lines).toContain(`Cache, last ${bars.length}  █ cached ░ new`)
  expect(lines.every((line) => Bun.stringWidth(line) <= 34)).toBe(true)
  expect(lines.join("\n")).not.toContain("…")
})

test("NO_COLOR keeps attributes and drops every colour", () => {
  const plain = new Theme(false)
  const colored = new Theme(true)
  for (const role of ["ok", "error", "warn", "added", "removed", "accent"] as const) {
    expect(plain.paint({ text: "x", role }).fg.intent).toBe("default")
    expect(colored.paint({ text: "x", role }).fg.intent).toBe("indexed")
  }
  expect(plain.paint({ text: "x", role: "user" }).attributes).toBe(colored.paint({ text: "x", role: "user" }).attributes)
})
