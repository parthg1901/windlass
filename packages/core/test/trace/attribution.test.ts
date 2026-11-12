/**
 * Per-step attribution on sessions the engine wrote with the scripted
 * provider: what was new in each request, and what the model did next.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import type { RequestRecord } from "../../src/store/store.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { type CallAttribution, attributeSession, renderAttribution } from "../../src/trace/attribution.ts"
import { Harness, type HarnessOptions, removeHarnessDirectories } from "../engine/harness.ts"
import { SUMMARY, measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1300))
const answer = (value: string) => [script.text(value), U]
const read = (callId: string, path: string) => [script.toolCall(callId, "read", { path }), U]

async function session(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness(options)
  try {
    await run(h)
    const events = h.store.readEvents(h.session.id)
    const rows = h.store.readRequests(h.session.id)
    return { h, rows, attribution: attributeSession(events, rows), events }
  } finally {
    await h.dispose()
  }
}

const sources = (call: CallAttribution) => call.groups.map((entry) => entry.source)

describe("attribution", () => {
  test("a plain turn: the first call is all new, and the model's answer is next to it", async () => {
    const { attribution } = await session(async (h) => {
      h.provider.enqueue(answer("Four."))
      h.create().send("What is two plus two?")
      await h.settled()
    })
    expect(attribution.foldFailure).toBeNull()
    expect(attribution.calls).toHaveLength(1)
    const [call] = attribution.calls
    expect(call!.verified).toBe(true)
    expect(call!.prefix).toEqual({ status: "first" })
    expect(call!.fresh).toHaveLength(call!.blocks)
    expect(sources(call!).slice(0, 3)).toEqual(["params", "tool", "instructions"])
    const user = call!.fresh.filter((block) => block.source === "user")
    expect(user).toHaveLength(1)
    expect(user[0]!.preview).toBe("What is two plus two?")
    expect(call!.freshBytes).toBe(call!.bytes)
    expect(call!.action).toMatchObject({ kind: "step", status: "completed", textChars: 5, preview: "Four.", toolCalls: [] })
    expect(call!.usage).toEqual({ input: 1300, cached: 1100, uncached: 200, cachedShare: 1100 / 1300, output: 50 })
  })

  test("a turn with tools: the second call saw the model's call and the tool's result for the first time", async () => {
    const { attribution } = await session(async (h) => {
      h.tools.on("read", "export const a = 1")
      h.provider.enqueue(read("call_1", "a.ts"), answer("a is 1."))
      h.create().send("What is a?")
      await h.settled()
    })
    const [first, second] = attribution.calls
    expect(first!.action).toMatchObject({ kind: "step", toolCalls: [{ name: "read", callId: "call_1", outcome: "success" }] })
    expect(second!.comparedWith).toBe(1)
    expect(second!.prefix).toEqual({ status: "extension", kept: first!.blocks, appended: 2 })
    expect(second!.fresh.map((block) => block.label)).toEqual(["model's tool call read call_1", "tool result read call_1"])
    const result = second!.fresh[1]!
    expect(result).toMatchObject({ source: "tool_result", tool: "read", callId: "call_1", preview: "export const a = 1" })
    expect(result.bytes).toBeGreaterThan(0)
    expect(second!.freshBytes).toBe(second!.fresh.reduce((sum, block) => sum + block.bytes, 0))
    expect(second!.action).toMatchObject({ kind: "step", preview: "a is 1." })
  })

  test("an instruction update: the file found in a directory the agent read in is new in the next call, with its source", async () => {
    const { attribution } = await session(async (h) => {
      h.agents.set("/repo/packages/api", "Handlers return status codes, never bodies.")
      h.tools.on("read", "export const handler = () => 200")
      h.provider.enqueue(read("call_1", "packages/api/handler.ts"), answer("It returns 200."))
      h.create().send("What does the handler return?")
      await h.settled()
    })
    const second = attribution.calls[1]!
    expect(second.prefix.status).toBe("extension")
    const instruction = second.fresh.find((block) => block.source === "instruction")
    expect(instruction).toMatchObject({ origin: "agents:/repo/packages/api/AGENTS.md", label: "instruction update agents:/repo/packages/api/AGENTS.md" })
    expect(instruction!.preview).toContain("/repo/packages/api/AGENTS.md now applies")
    expect(sources(second)).toEqual(["model_output", "tool_result", "instruction"])
  })

  test("a compaction: the summary call and the call after it say the prefix was rebuilt and why, and list as new only the checkpoint and what the model had not seen yet", async () => {
    const { attribution, rows } = await session(
      async (h) => {
        h.tools.on("read", "export const big = 1", "export const small = 2")
        h.provider.enqueue(
          [script.toolCall("call_1", "read", { path: "big.ts" }), script.usage(measured(6000))],
          [script.text(SUMMARY)],
          answer("Read it."),
          answer("Still here."),
        )
        h.create().send("Read big.ts.")
        await h.settled()
        h.session.send("Anything else?")
        await h.settled()
      },
      { contextWindow: 10_000 },
    )
    expect(rows.map((row) => row.purpose)).toEqual(["step", "compaction", "step", "step"])
    const [step, summary, after, later] = attribution.calls
    expect(attribution.calls.every((call) => call.verified)).toBe(true)
    // The summary call is compared with the step before it; it keeps that step's prefix and appends the prompt.
    expect(summary!.comparedWith).toBe(1)
    expect(summary!.action).toMatchObject({ kind: "summary", status: "completed", source: "model" })
    expect(summary!.fresh.at(-1)!.source).toBe("compaction_prompt")
    // Nothing before the cut but the prompt, so it is the step request plus the summary prompt.
    expect(summary!.prefix).toEqual({ status: "extension", kept: step!.blocks, appended: 1 })
    // The step after it is compared with the step before the compaction, not with the summary call.
    expect(after!.comparedWith).toBe(1)
    expect(after!.prefix.status).toBe("rebuilt")
    if (after!.prefix.status !== "rebuilt") throw new Error("unreachable")
    expect(after!.prefix.causes).toContain("compaction")
    expect(after!.prefix.reasons.join(" ")).toContain("history now starts at its checkpoint")
    // Tools and the system prompt are unchanged, so the first change is in the input.
    expect(after!.prefix.firstChanged.kind).toBe("input")
    const checkpoint = after!.fresh.filter((block) => block.source === "checkpoint")
    expect(checkpoint).toHaveLength(1)
    expect(checkpoint[0]!.bytes).toBeGreaterThan(SUMMARY.length)
    // The kept step (the model's call and its result) was never sent before; the user message went into the checkpoint.
    expect(sources(after!)).toEqual(["checkpoint", "model_output", "tool_result"])
    expect(after!.prefix.resent).toBe(0)
    // And the request after that extends it again, with the new user message.
    expect(later!.comparedWith).toBe(3)
    expect(later!.prefix.status).toBe("extension")
    expect(later!.fresh.find((block) => block.source === "user")?.preview).toBe("Anything else?")
    expect(step!.action).toMatchObject({ kind: "step", toolCalls: [{ name: "read" }] })
    // The table names it.
    const table = renderAttribution(attribution)
    expect(table).toContain("REBUILT against #1 (compaction")
    expect(table).toContain("checkpoint of compaction")
    expect(renderAttribution(attribution, { step: 4 })).toStartWith("#4 step")
  })

  test("a long turn compacted in the middle: the summary request leaves the kept steps out, and the step after it re-sends them", async () => {
    // As in the compaction tests: a 40,000-token window, nine 3,000-token files read one after the other.
    const line = (name: string, index: number) => `export const ${name}_${index} = compute_${name}(${index}, "value ${index} of ${name}")`
    const fileText = (name: string) => Array.from({ length: Math.ceil(3_000 / estimateTokens(`${line(name, 100)}\n`)) }, (_, index) => line(name, index)).join("\n")
    const usage = (request: ModelRequest) => script.usage({ inputTokens: estimateRequest(request), cachedInputTokens: 0, outputTokens: 40, reasoningTokens: 0 })
    const isSummary = (request: ModelRequest) => request.toolChoice === "none" && request.input.at(-1)?.type === "message"
    const { attribution, rows } = await session(
      async (h) => {
        for (let index = 0; index < 9; index += 1) h.tools.on("read", fileText(`m${index}`))
        let next = 0
        const respond = (request: ModelRequest) =>
          isSummary(request)
            ? [script.text(SUMMARY), usage(request)]
            : next < 9
              ? [script.toolCall(`call_${next}`, "read", { path: `src/module-${next++}.ts` }), usage(request)]
              : [script.text("Done."), usage(request)]
        h.provider.enqueue(...Array.from({ length: 12 }, () => respond))
        h.create().send("Read the modules.", { maxSteps: 20 })
        await h.settled()
      },
      { contextWindow: 40_000 },
    )
    const at = rows.findIndex((row) => row.purpose === "compaction")
    expect(at).toBeGreaterThan(0)
    const summary = attribution.calls[at]!
    const after = attribution.calls[at + 1]!
    expect(summary.prefix.status).toBe("rebuilt")
    if (summary.prefix.status !== "rebuilt" || after.prefix.status !== "rebuilt") throw new Error("not rebuilt")
    expect(summary.prefix.causes).toEqual(["summary"])
    expect(summary.fresh.map((block) => block.source)).toEqual(["compaction_prompt"])
    expect(after.comparedWith).toBe(at)
    expect(after.prefix.causes).toEqual(["compaction"])
    // The kept steps the previous step request already held are re-sent, not new.
    expect(after.prefix.resent).toBeGreaterThan(0)
    expect(after.prefix.resentBytes).toBeGreaterThan(5_000)
    expect(after.fresh.filter((block) => block.source === "checkpoint")).toHaveLength(1)
    expect(after.fresh.filter((block) => block.source === "tool_result")).toHaveLength(1)
    // Every other step extends the one before it.
    const others = attribution.calls.filter((call, index) => index !== 0 && call.purpose === "step" && index !== at + 1)
    expect(others.every((call) => call.prefix.status === "extension")).toBe(true)
    expect(attribution.calls.every((call) => call.verified)).toBe(true)
  })

  test("a row whose hashes do not match the log is still compared by the ledger, named by kind only, and a break without cause is unexplained", async () => {
    const { events, rows } = await session(async (h) => {
      h.tools.on("read", "export const a = 1")
      h.provider.enqueue(read("call_1", "a.ts"), answer("a is 1."))
      h.create().send("What is a?")
      await h.settled()
    })
    // A ledger row that says the system prompt of the second call was another one.
    const changed = rows.map((row, index): RequestRecord =>
      index === 1 ? { ...row, blocks: row.blocks.map((block) => (block.kind === "instructions" ? { ...block, hash: "0".repeat(64) } : block)) } : row,
    )
    const second = attributeSession(events, changed).calls[1]!
    expect(second.verified).toBe(false)
    expect(second.unverified).toContain("differs from the ledger")
    expect(second.prefix.status).toBe("unexplained")
    expect(second.fresh.map((block) => block.source)).toEqual(["instructions", "input", "input"])
  })
})
