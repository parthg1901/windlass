import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ESTIMATOR_ERROR,
  ITEM_OVERHEAD,
  estimateItem,
  estimateNextInput,
  estimateRequest,
  estimateTokens,
} from "../../src/context/estimate.ts"
import { hashRequest } from "../../src/request/prefix.ts"
import type { InputItem, ModelRequest } from "../../src/request/request.ts"
import { filler } from "./fixtures.ts"

const request = (input: readonly InputItem[]): ModelRequest => ({
  params: { model: "gpt-6-luna", reasoningEffort: "low", textVerbosity: null, parallelToolCalls: true, cacheKey: "ses_1" },
  tools: [{ name: "read", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
  instructions: "You are a coding agent.",
  input,
  toolChoice: "auto",
})
const user = (value: string): InputItem => ({ type: "message", role: "user", content: [{ type: "text", text: value }] })
const call = (id: string): InputItem => ({ type: "tool_call", callId: id, name: "read", input: '{"path":"a.ts"}', providerData: null })
const result = (id: string, output: string): InputItem => ({ type: "tool_result", callId: id, output, attachments: [] })
const usage = { inputTokens: 5_000, cachedInputTokens: 4_000, outputTokens: 40, reasoningTokens: 0 }

describe("estimateTokens", () => {
  test("is 0 for empty text and deterministic", () => {
    expect(estimateTokens("")).toBe(0)
    const code = 'export function total(items: Item[]) {\n  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)\n}\n'
    expect(estimateTokens(code)).toBe(estimateTokens(code))
  })

  test("prose lands near four characters per token, code and identifiers denser", () => {
    const prose = filler(400)
    const ratio = prose.length / estimateTokens(prose)
    expect(ratio).toBeGreaterThan(3.2)
    expect(ratio).toBeLessThan(5.5)
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    expect(hex.length / estimateTokens(hex)).toBeLessThan(3)
  })

  test("grows with the text", () => {
    expect(estimateTokens(filler(200))).toBeGreaterThan(estimateTokens(filler(100)))
  })
})

describe("estimateNextInput", () => {
  test("builds on the measured call: its input, its output, then an estimate of what follows", () => {
    const previous = request([user("Read a.ts")])
    const output = "export const answer = 42\n".repeat(40)
    const next = request([user("Read a.ts"), call("c1"), result("c1", output)])
    const estimate = estimateNextInput(next, { blocks: hashRequest(previous), usage })
    expect(estimate.basedOnMeasurement).toBe(true)
    expect(estimate.measured).toBe(usage.inputTokens + usage.outputTokens)
    expect(estimate.estimated).toBe(estimateItem(result("c1", output)))
    expect(estimate.total).toBe(estimate.measured + estimate.estimated)
    expect(estimate.margin).toBe(Math.max(ESTIMATOR_ERROR.floorTokens, Math.ceil(estimate.estimated * ESTIMATOR_ERROR.relative)))
  })

  test("estimates everything when the prefix broke (after a compaction) or nothing was measured", () => {
    const next = request([user("Summary"), user("Go on")])
    const broken = estimateNextInput(next, { blocks: hashRequest(request([user("Something else")])), usage })
    expect(broken.basedOnMeasurement).toBe(false)
    expect(broken.measured).toBe(0)
    expect(broken.total).toBe(estimateRequest(next))
    expect(estimateNextInput(next, null)).toEqual(broken)
  })

  test("a new user message after a final answer is estimated, the answer is measured", () => {
    const previous = request([user("Hi")])
    const next = request([user("Hi"), { type: "assistant_text", text: "Hello.", providerData: null }, user("Now fix the bug")])
    const estimate = estimateNextInput(next, { blocks: hashRequest(previous), usage })
    expect(estimate.measured).toBe(usage.inputTokens + usage.outputTokens)
    expect(estimate.estimated).toBe(ITEM_OVERHEAD + estimateTokens("Now fix the bug"))
  })
})

/**
 * The estimator against the provider's numbers. The calibration runs are not
 * part of the repository (they are local eval output); point
 * `LH_CALIBRATION_DIR` at a directory of `*.jsonl` event streams to run this.
 * The bounds are the ones the file comment of `estimate.ts` states.
 */
const calibration = process.env.LH_CALIBRATION_DIR ?? ""

describe.skipIf(calibration === "" || !existsSync(calibration))("estimator error on real runs", () => {
  const runs = calibration !== "" && existsSync(calibration) ? readdirSync(calibration).filter((name) => name.endsWith(".jsonl")) : []
  const points = runs.flatMap((name) => deltas(readFileSync(join(calibration, name), "utf8")))

  test("appended tool output: within -5% and +15% for deltas of 300 tokens or more", () => {
    const large = points.filter((point) => point.actual >= 300)
    expect(large.length).toBeGreaterThanOrEqual(10)
    for (const point of large) {
      const error = (point.estimate - point.actual) / point.actual
      expect(error).toBeGreaterThan(-0.05)
      expect(error).toBeLessThan(0.15)
    }
    // Never more than the margin the policy adds.
    for (const point of large) expect(Math.abs(point.estimate - point.actual)).toBeLessThan(point.estimate * ESTIMATOR_ERROR.relative)
  })

  test("small deltas: within 30 tokens (within 10 below 100 tokens, which is framing), far inside the margin floor", () => {
    const small = points.filter((point) => point.actual < 300)
    expect(small.length).toBeGreaterThan(20)
    for (const point of small) expect(Math.abs(point.estimate - point.actual)).toBeLessThanOrEqual(30)
    for (const point of small.filter((point) => point.actual < 100)) expect(Math.abs(point.estimate - point.actual)).toBeLessThanOrEqual(10)
  })

  test("first requests: within ±3%", () => {
    for (const name of runs) {
      const first = firstRequest(readFileSync(join(calibration, name), "utf8"))
      expect(Math.abs(first.estimate - first.actual) / first.actual).toBeLessThan(0.03)
    }
  })
})

type Event = { type: string; data: Record<string, never> & Record<string, unknown> }

function events(text: string): Event[] {
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event)
}

interface Step {
  usage: { inputTokens: number; outputTokens: number }
  results: InputItem[]
  delivered: InputItem[]
}

/** Per step: the delta of input tokens minus the previous call's measured output, against the estimate of what was appended. */
function deltas(text: string) {
  const steps = collect(text).steps
  return steps.slice(1).map((step, index) => {
    const previous = steps[index]!
    const appended = [...previous.results, ...step.delivered]
    return {
      actual: step.usage.inputTokens - previous.usage.inputTokens - previous.usage.outputTokens,
      estimate: appended.reduce((sum, item) => sum + estimateItem(item), 0),
    }
  })
}

function firstRequest(text: string) {
  const run = collect(text)
  const first = run.steps[0]!
  return {
    actual: first.usage.inputTokens,
    estimate: estimateRequest({ instructions: run.instructions, tools: run.tools, input: first.delivered }),
  }
}

function collect(text: string) {
  const enqueued = new Map<string, unknown>()
  const steps: Step[] = []
  let instructions = ""
  let tools: ModelRequest["tools"] = []
  let delivered: InputItem[] = []
  let current: Step | null = null
  for (const event of events(text)) {
    const data = event.data as Record<string, unknown>
    if (event.type === "baseline.set") {
      instructions = data.instructions as string
      tools = data.tools as ModelRequest["tools"]
    }
    if (event.type === "inbox.enqueued") enqueued.set(data.messageId as string, data.content)
    if (event.type === "inbox.delivered")
      delivered.push({ type: "message", role: "user", content: enqueued.get(data.messageId as string) as never })
    if (event.type === "step.started") {
      current = { usage: { inputTokens: 0, outputTokens: 0 }, results: [], delivered }
      delivered = []
    }
    if (event.type === "tool.settled" && current !== null)
      current.results.push({ type: "tool_result", callId: data.callId as string, output: data.output as string, attachments: [] })
    if (event.type === "step.ended" && current !== null) {
      current.usage = data.usage as Step["usage"]
      steps.push(current)
    }
  }
  return { instructions, tools, steps }
}
