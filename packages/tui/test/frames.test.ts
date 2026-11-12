/**
 * Frames as text at fixed sizes, from scripted sessions played instantly.
 * The showcase turn is kept as whole-frame snapshots at the three sizes
 * (`__snapshots__`); the other scenarios assert what a user must be able to
 * read in them.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { brand, event } from "@windlass/core"
import { MODELS_RETRY_MS } from "../src/app.ts"
import { panelLines, panelWidth } from "../src/panel.ts"
import { Theme } from "../src/theme.ts"
import type { CallUsage } from "../src/transcript.ts"
import type { DemoBackend } from "../src/demo-backend.ts"
import { type Mounted, ScriptBackend, mount, playAll } from "./helpers.ts"

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
    // The turn has ended: the stop line says what was asked, not that something is still stopping.
    expect(frame).toContain("■ stop requested")
    expect(frame).not.toContain("stopping…")
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
    36,
    40,
  ).map((line) => line.map((part) => part.text).join(""))

  test("session totals, the last call, the cache share and the context", () => {
    expect(lines).toContain("dir      ~/project")
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

describe("a command a demo cannot run", () => {
  const run = async (command: string) => {
    await mounted!.setup.mockInput.typeText(command)
    await mounted!.settle()
    mounted!.setup.mockInput.pressEscape()
    await new Promise((resolve) => setTimeout(resolve, 80))
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
  }
  const said = () => mounted!.app.transcript.rows.flatMap((row) => (row.kind === "notice" ? [row.text.map((part) => part.text).join("")] : []))

  test("says what a demo is and how to try the command for real, once in full; /review and /diff say where the demo's diffs are", async () => {
    await played("find-and-fix-a-failing-test", 120, 40)
    await run("/review")
    expect(said().at(-1)).toBe(
      `/review does nothing in a demo: a demo replays a recorded session and has no model, files or sessions of its own. Its turn changed no real file; Ctrl-O on the turn's ending row shows the diffs its tool calls reported. To try it for real, run ${brand.binary} tui in a project of yours (${brand.binary} login first).`,
    )
    await run("/diff")
    expect(said().at(-1)).toBe("/diff does nothing in a demo. Its turn changed no real file; Ctrl-O on the turn's ending row shows the diffs its tool calls reported.")
    await run("/undo")
    expect(said().at(-1)).toBe("/undo does nothing in a demo.")
    await run("/sessions")
    expect(said().at(-1)).toBe("/sessions does nothing in a demo.")
    expect(said().join(" ")).not.toContain("this engine")
  })

  test("the first line of a demo says that it is one and what Enter does", async () => {
    mounted = await mount({ width: 120, height: 30, scenario: "find-and-fix-a-failing-test" })
    await mounted.settle()
    expect((await mounted.frame()).replace(/\s*│[^\n]*/g, "").replace(/\s+/g, " ")).toContain("This is a demo: a recorded session, replayed without a model. Its prompt is in the input: press Enter to play it. /help lists keys.")
  })

  test("between a demo's turns the hint says Enter plays its next message, and after the last that it is over", async () => {
    mounted = await mount({ width: 120, height: 30, scenario: "two-turns-in-one-session" })
    await mounted.settle()
    const hint = async () => (await mounted!.frame()).split("\n").at(-1)!
    expect(await hint()).toContain("Enter plays the demo's next message")
    const backend = mounted.backend as DemoBackend
    mounted.setup.mockInput.pressEnter()
    await mounted.settle()
    await backend.current!.idle()
    await mounted.settle()
    expect(backend.current!.remaining).toBe(1)
    expect(await hint()).toContain("Enter plays the demo's next message")
    await playAll(mounted)
    expect(await hint()).toContain("the demo has played all its messages")
    // Typing something else gives the usual keys back.
    await mounted.setup.mockInput.typeText("x")
    await mounted.settle()
    expect(await hint()).toContain("Enter send")
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
    36,
    30,
  ).map((line) => line.map((part) => part.text).join(""))
  const bars = lines.filter((line) => /^\d+ /.test(line))
  expect(bars.length).toBeLessThan(40)
  expect(lines).toContain(`Cache, last ${bars.length}  █ cached ░ new`)
  expect(lines.every((line) => Bun.stringWidth(line) <= 36)).toBe(true)
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

test("the panel grows on a wide terminal, and every name in the session section takes the same column", () => {
  expect(panelWidth(80)).toBe(38)
  expect(panelWidth(120)).toBe(38)
  expect(panelWidth(200)).toBe(50)
  expect(panelWidth(400)).toBe(52)
  const lines = panelLines(
    {
      session: { id: "ses_0009e333e7112f4f87ac497e", cwd: "/home/me/project", title: "Explain the failing login test", model: "gpt-6-luna", effort: "low", taint: { at: 1 } as never },
      calls: [],
      activity: { executing: false, turnStartedAt: null, steps: 0, summaryCalls: 0, call: null, checking: null, compacting: null, retry: null, stopping: false, waiting: null },
      now: 0,
      contextWindow: 272_000,
      connection: "connected",
      home: "/home/me",
      approval: { mode: "auto", sandbox: true },
    },
    48,
    30,
  ).map((line) => line.map((part) => part.text).join(""))
  // At 200 columns a real session ID, the title and the trust line are whole.
  expect(lines).toContain("id       ses_0009e333e7112f4f87ac497e")
  expect(lines).toContain("title    Explain the failing login test")
  expect(lines).toContain("approval auto · sandbox ⊡")
  expect(lines).toContain("trust    untrusted · /clear-taint")
  const starts = lines.slice(1, 9).filter((line) => line !== "").map((line) => line.search(/(?<=^\S+\s+)\S/))
  expect(new Set(starts)).toEqual(new Set([9]))
})

test("a listing of the models that failed is asked for again, so the panel learns the context window", async () => {
  const backend = new ScriptBackend()
  let asked = 0
  Object.assign(backend, {
    listModels: async () => {
      asked += 1
      if (asked === 1) throw new Error("could not list the models: the provider did not answer")
      return { defaultModel: "gpt-6-luna", models: [{ id: "gpt-6-luna", name: "gpt-6-luna", efforts: ["low"], defaultEffort: "low", contextWindow: 272_000, isDefault: true }] }
    },
  })
  mounted = await mount({ width: 120, height: 30, backend })
  const usage = { inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0 }
  backend.session!.emit(
    event("session.created", { cwd: "/work", title: null, lineage: null, settings: { model: "gpt-6-luna", reasoningEffort: "low" } }),
    event("step.started", { messageId: "a1" as never, attempt: 1, model: "gpt-6-luna" }),
    event("step.ended", { messageId: "a1" as never, finish: "stop", usage }),
  )
  await mounted.settle()
  expect(await mounted.frame()).toContain("(window unknown)")
  expect(asked).toBe(1)
  mounted.clock.now += MODELS_RETRY_MS + 10
  backend.session!.emit(event("step.started", { messageId: "a2" as never, attempt: 1, model: "gpt-6-luna" }), event("step.ended", { messageId: "a2" as never, finish: "stop", usage }))
  await mounted.settle()
  await mounted.settle()
  expect(asked).toBe(2)
  expect(await mounted.frame()).toMatch(/context\s+4\.0k of 272k/)
  // Listed once, it is not asked for again.
  mounted.clock.now += MODELS_RETRY_MS + 10
  backend.session!.emit(event("step.started", { messageId: "a3" as never, attempt: 1, model: "gpt-6-luna" }), event("step.ended", { messageId: "a3" as never, finish: "stop", usage }))
  await mounted.settle()
  expect(asked).toBe(2)
})
