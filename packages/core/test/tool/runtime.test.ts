import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createInterrupt } from "../../src/interrupt.ts"
import { OUTPUT_LIMITS } from "../../src/tool/cap.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import type { AnyTool, Tool, ToolEffect, ToolResult } from "../../src/tool/tool.ts"
import { context, tempDir } from "../tools/helpers.ts"

const ok = (output: string): ToolResult => ({ status: "success", output, truncation: null, attachments: [], display: null })

function echo(effect: ToolEffect = "read"): Tool<{ text: string; delayMs?: number }> {
  return {
    name: "echo",
    description: "Echoes text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, delayMs: { type: "integer", minimum: 0 } },
      required: ["text"],
      additionalProperties: false,
    },
    effect,
    execute: async (input, ctx) => {
      if (input.delayMs !== undefined) {
        const aborted = new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
        await Promise.race([Bun.sleep(input.delayMs), aborted])
        if (ctx.signal.aborted) return { ...ok(`stopped after ${input.text}`), status: "error" }
      }
      return ok(input.text)
    },
  }
}

function crasher(name: string, effect: ToolEffect): Tool<Record<string, never>> {
  return {
    name,
    description: "Throws.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect,
    execute: async () => {
      throw new Error("boom")
    },
  }
}

function setup(tools: AnyTool[]) {
  const spillDir = `${tempDir()}/spill`
  const runtime = createToolRuntime({ tools, spillDir })
  const cwd = tempDir()
  return { runtime, spillDir, run: (name: string, argumentsText: string, signal?: AbortSignal, onStart?: () => void) =>
    runtime.run({ name, argumentsText, context: context(cwd, { signal }) }, { onStart }) }
}

describe("tool runtime", () => {
  test("a returned result passes through with its status, after onStart", async () => {
    const order: string[] = []
    const { run } = setup([echo()])
    const outcome = await run("echo", '{"text":"hi"}', undefined, () => order.push("started"))
    expect(order).toEqual(["started"])
    expect(outcome).toEqual({
      kind: "completed",
      settlement: { outcome: "success", output: "hi", truncation: null, attachments: [], display: null },
    })
  })

  test("malformed JSON is refused with an excerpt, and the tool never starts", async () => {
    let started = false
    const { run } = setup([echo()])
    const outcome = await run("echo", '{"text": hi}', undefined, () => (started = true))
    expect(started).toBe(false)
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.reason).toBe("malformed_arguments")
    expect(outcome.settlement.outcome).toBe("error")
    expect(outcome.settlement.output).toStartWith("The arguments for echo are not valid JSON (")
    expect(outcome.settlement.output).toEndWith('Received: {"text": hi}\nCall echo again with the arguments as one JSON object.')
  })

  test("invalid input is refused naming the path", async () => {
    const { run } = setup([echo()])
    const outcome = await run("echo", '{"text": 1, "delayMs": -1, "x": true}')
    expect(outcome).toMatchObject({ kind: "refused", reason: "invalid_arguments" })
    expect(outcome.settlement.output).toBe(
      "Invalid arguments for echo:\n- text: must be a string, got 1\n- delayMs: must be at least 0, got -1\n- x: is not a known parameter\nFix them and call echo again.",
    )
  })

  test("an unknown tool is refused with the available names", async () => {
    const { run } = setup([echo()])
    expect(await run("nope", "{}")).toMatchObject({
      kind: "refused",
      reason: "unknown_tool",
      settlement: { outcome: "error", output: 'There is no tool named "nope". Available tools: echo.' },
    })
  })

  test("a call whose execution is already interrupted is not started", async () => {
    const token = createInterrupt()
    token.interrupt("shutdown")
    let started = false
    const { run } = setup([echo()])
    expect(await run("echo", '{"text":"x"}', token.signal, () => (started = true))).toEqual({
      kind: "not_started",
      settlement: {
        outcome: "not_started",
        output: "Not run: the harness shut down before this call started.",
        truncation: null,
        attachments: [],
        display: null,
      },
    })
    expect(started).toBe(false)
  })

  test("a thrown exception settles as error for read tools and effect_unknown otherwise", async () => {
    const { run } = setup([crasher("r", "read"), crasher("w", "write"), crasher("x", "exec"), crasher("n", "network")])
    const read = await run("r", "{}")
    expect(read).toMatchObject({ kind: "crashed", settlement: { outcome: "error", output: "r failed with an internal error: boom" } })
    for (const name of ["w", "x", "n"]) {
      const outcome = await run(name, "{}")
      expect(outcome.kind).toBe("crashed")
      expect(outcome.settlement.outcome).toBe("effect_unknown")
      expect(outcome.settlement.output).toStartWith(`${name} failed with an internal error after it started: boom\n`)
    }
  })

  test("a tool that returns something other than a ToolResult is treated as a crash", async () => {
    const bad: Tool<Record<string, never>> = { ...crasher("bad", "write"), execute: async () => ({ output: 1 }) as never }
    const { run } = setup([bad])
    expect((await run("bad", "{}")).settlement.outcome).toBe("effect_unknown")
  })

  test("output the tool did not cap is capped once and spilled", async () => {
    const text = "x\n".repeat(OUTPUT_LIMITS.maxLines * 2)
    const { run } = setup([echo()])
    const outcome = await run("echo", JSON.stringify({ text }))
    expect(outcome.settlement.truncation).toEqual({ originalBytes: text.length, originalLines: 4000, spillPath: expect.any(String) })
    expect(readFileSync(outcome.settlement.truncation!.spillPath!, "utf8")).toBe(text)
    expect(outcome.settlement.output.length).toBeLessThan(text.length)
  })

  test("output the tool capped itself is not capped again", async () => {
    const own: Tool<Record<string, never>> = {
      ...crasher("own", "read"),
      execute: async () => ({ ...ok("y\n".repeat(5000)), truncation: { originalBytes: 1, originalLines: 1, spillPath: null } }),
    }
    const { run } = setup([own])
    expect((await run("own", "{}")).settlement.output).toBe("y\n".repeat(5000))
  })

  test("parallel calls: a slow and a failing call do not affect a fast one, outcomes stay in order", async () => {
    const { runtime } = setup([echo(), crasher("w", "write")])
    const cwd = tempDir()
    const started: number[] = []
    const begin = performance.now()
    const timings: number[] = []
    const calls = [
      { name: "echo", argumentsText: '{"text":"slow","delayMs":300}', context: context(cwd) },
      { name: "w", argumentsText: "{}", context: context(cwd) },
      { name: "echo", argumentsText: '{"text":"fast"}', context: context(cwd) },
      { name: "echo", argumentsText: "{bad", context: context(cwd) },
    ]
    const tracked = calls.map((call, index) =>
      runtime.run(call, { onStart: () => started.push(index) }).then((outcome) => {
        timings[index] = performance.now() - begin
        return outcome
      }),
    )
    const outcomes = await Promise.all(tracked)
    expect(outcomes.map((outcome) => [outcome.kind, outcome.settlement.outcome])).toEqual([
      ["completed", "success"],
      ["crashed", "effect_unknown"],
      ["completed", "success"],
      ["refused", "error"],
    ])
    expect(started.sort()).toEqual([0, 1, 2])
    expect(timings[2]!).toBeLessThan(150)
    expect(timings[0]!).toBeGreaterThanOrEqual(290)
  })

  test("runAll runs calls concurrently, reports starts by index and abort reaches every call", async () => {
    const { runtime } = setup([echo()])
    const cwd = tempDir()
    const token = createInterrupt()
    const started: number[] = []
    const begin = performance.now()
    const all = runtime.runAll(
      [0, 1, 2].map((index) => ({ name: "echo", argumentsText: `{"text":"${index}","delayMs":5000}`, context: context(cwd, { signal: token.signal }) })),
      { onStart: (index) => started.push(index) },
    )
    setTimeout(() => token.interrupt("user"), 50)
    const outcomes = await all
    expect(performance.now() - begin).toBeLessThan(1000)
    expect(started).toEqual([0, 1, 2])
    expect(outcomes.map((outcome) => outcome.settlement.output)).toEqual(["stopped after 0", "stopped after 1", "stopped after 2"])
  })

  test("tool names must be unique", () => {
    expect(() => createToolRuntime({ tools: [echo(), echo()], spillDir: "/tmp" })).toThrow("unique")
  })
})
