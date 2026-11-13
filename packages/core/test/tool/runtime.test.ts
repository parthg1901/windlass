import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createInterrupt } from "../../src/interrupt.ts"
import { OUTPUT_LIMITS } from "../../src/tool/cap.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { type AnyTool, type Tool, type ToolEffect, type ToolResult, noBlobStore } from "../../src/tool/tool.ts"
import { context, tempDir, removeTempDirs } from "../tools/helpers.ts"

afterEach(removeTempDirs)

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
  const runtime = createToolRuntime({ tools, spillDir, putBlob: noBlobStore })
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
      "Invalid arguments for echo:\n- text: must be a string, got 1\n- delayMs: must be at least 0, got -1\n- x: is not a known parameter (known: text, delayMs)\nFix them and call echo again.",
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
    // Stopped once all three have started.
    const all = runtime.runAll(
      [0, 1, 2].map((index) => ({ name: "echo", argumentsText: `{"text":"${index}","delayMs":5000}`, context: context(cwd, { signal: token.signal }) })),
      { onStart: (index) => (started.push(index), started.length === 3 && queueMicrotask(() => token.interrupt("user"))) },
    )
    const outcomes = await all
    // Each would take 5 s; stopped, they return at once. The slack is for a loaded runner.
    expect(performance.now() - begin).toBeLessThan(2500)
    expect(started).toEqual([0, 1, 2])
    expect(outcomes.map((outcome) => outcome.settlement.output)).toEqual(["stopped after 0", "stopped after 1", "stopped after 2"])
  })

  test("tool names must be unique", () => {
    expect(() => createToolRuntime({ tools: [echo(), echo()], spillDir: "/tmp", putBlob: noBlobStore })).toThrow("unique")
  })

  test("a tool stores media through the context and attaches the reference it gets back", async () => {
    const stored: { bytes: Uint8Array; mediaType: string }[] = []
    const putBlob = (bytes: Uint8Array, mediaType: string) => {
      stored.push({ bytes, mediaType })
      return { hash: `hash-${stored.length}`, mediaType }
    }
    const screenshot: Tool<Record<string, never>> = {
      name: "screenshot",
      description: "Takes a screenshot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      execute: async (_, ctx) => ({ ...ok("screenshot taken"), attachments: [ctx.putBlob(new Uint8Array([137, 80, 78, 71]), "image/png")] }),
    }
    const runtime = createToolRuntime({ tools: [screenshot], spillDir: `${tempDir()}/spill`, putBlob })
    // The caller's context carries no blob store: the runtime supplies the one from its options.
    const { putBlob: _, ...callContext } = context(tempDir())
    const outcome = await runtime.run({ name: "screenshot", argumentsText: "{}", context: callContext })
    expect(outcome).toMatchObject({
      kind: "completed",
      settlement: { outcome: "success", output: "screenshot taken", attachments: [{ hash: "hash-1", mediaType: "image/png" }] },
    })
    expect(stored).toEqual([{ bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }])
  })

  test("the runtime's blob store wins over one a caller left on the context, and a failing store is the tool's crash", async () => {
    const attach: Tool<Record<string, never>> = {
      name: "attach",
      description: "Stores one byte.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      execute: async (_, ctx) => ({ ...ok("stored"), attachments: [ctx.putBlob(new Uint8Array([1]), "application/octet-stream")] }),
    }
    const runtime = createToolRuntime({ tools: [attach], spillDir: `${tempDir()}/spill`, putBlob: noBlobStore })
    const callers = { ...context(tempDir()), putBlob: () => ({ hash: "callers", mediaType: "x/y" }) }
    const outcome = await runtime.run({ name: "attach", argumentsText: "{}", context: callers })
    expect(outcome).toMatchObject({ kind: "crashed", settlement: { outcome: "error", output: expect.stringContaining("no blob store") } })
  })
})

describe("the step after a tool ran", () => {
  test("what the caller appends is capped once with the tool's output, and the tool's output comes first byte for byte", async () => {
    const spillDir = `${tempDir()}/spill`
    const runtime = createToolRuntime({ tools: [echo()], spillDir, putBlob: noBlobStore })
    const seen: { tool: string; input: unknown; output: string }[] = []
    const outcome = await runtime.run(
      { name: "echo", argumentsText: '{"text":"hi"}', context: context(tempDir()) },
      {
        afterExecute: async (tool, input, result) => {
          seen.push({ tool: tool.name, input, output: result.output })
          return { ...result, output: `${result.output}\n\n[note]\nlook again` }
        },
      },
    )
    expect(seen).toEqual([{ tool: "echo", input: { text: "hi" }, output: "hi" }])
    expect(outcome).toEqual({ kind: "completed", settlement: { outcome: "success", output: "hi\n\n[note]\nlook again", truncation: null, attachments: [], display: null } })
    // A long output with a note: one cap, over the whole text.
    const long = "x".repeat(OUTPUT_LIMITS.maxBytes + 1000)
    const capped = await runtime.run({ name: "echo", argumentsText: JSON.stringify({ text: long }), context: context(tempDir()) }, { afterExecute: (_tool, _input, result) => ({ ...result, output: `${result.output}\n\n[note]` }) })
    if (capped.kind !== "completed") throw new Error("expected a completed call")
    expect(capped.settlement.truncation?.originalBytes).toBe(long.length + "\n\n[note]".length)
    expect(readFileSync(capped.settlement.truncation!.spillPath!, "utf8")).toBe(`${long}\n\n[note]`)
  })

  test("it comes after the tool ran and is not called for a tool that threw, was refused or never started", async () => {
    const order: string[] = []
    const runtime = createToolRuntime({ tools: [echo(), crasher("crash", "write")], spillDir: `${tempDir()}/spill`, putBlob: noBlobStore })
    const hooks = {
      onStart: () => void order.push("started"),
      afterExecute: (_tool: AnyTool, _input: unknown, result: ToolResult) => {
        order.push("after")
        return result
      },
    }
    await runtime.run({ name: "echo", argumentsText: '{"text":"hi"}', context: context(tempDir()) }, hooks)
    expect(order).toEqual(["started", "after"])
    order.length = 0
    expect((await runtime.run({ name: "crash", argumentsText: "{}", context: context(tempDir()) }, hooks)).kind).toBe("crashed")
    expect((await runtime.run({ name: "echo", argumentsText: "{", context: context(tempDir()) }, hooks)).kind).toBe("refused")
    expect((await runtime.run({ name: "echo", argumentsText: '{"text":"hi"}', context: context(tempDir()) }, { ...hooks, authorize: () => ({ kind: "refuse", output: "no" }) })).kind).toBe("denied")
    const interrupt = createInterrupt()
    interrupt.interrupt("user")
    expect((await runtime.run({ name: "echo", argumentsText: '{"text":"hi"}', context: context(tempDir(), { signal: interrupt.signal }) }, hooks)).kind).toBe("not_started")
    expect(order).toEqual(["started"])
  })

  test("a tool that capped itself keeps what is appended after its capped text, and an approval note still comes first", async () => {
    const capped: Tool<Record<string, never>> = {
      name: "capped",
      description: "Caps itself.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "exec",
      execute: async () => ({ ...ok("head … tail"), truncation: { originalBytes: 5000, originalLines: 90, spillPath: null } }),
    }
    const runtime = createToolRuntime({ tools: [capped as unknown as AnyTool], spillDir: `${tempDir()}/spill`, putBlob: noBlobStore })
    const outcome = await runtime.run(
      { name: "capped", argumentsText: "{}", context: context(tempDir()) },
      { authorize: () => ({ kind: "run", note: "[approved]" }), afterExecute: (_tool, _input, result) => ({ ...result, output: `${result.output}\n\n[note]` }) },
    )
    expect(outcome).toMatchObject({ kind: "completed", settlement: { output: "[approved]\n\nhead … tail\n\n[note]", truncation: { originalBytes: 5000, originalLines: 90, spillPath: null } } })
  })
})
