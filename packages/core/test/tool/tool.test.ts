import { describe, expect, test } from "bun:test"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt, interruptReasonOf } from "../../src/interrupt.ts"
import {
  type AnyTool,
  type Tool,
  type ToolContext,
  type ToolProgress,
  specOf,
  toolEffect,
  toolSpec,
} from "../../src/tool/tool.ts"
import { DecodeError } from "../../src/validate.ts"

/** A tool written against the contract, to show the contract is enough to write one. */
const countdown: Tool<{ from: number }> = {
  name: "countdown",
  description: "Counts down, one tick at a time",
  inputSchema: { type: "object", properties: { from: { type: "integer" } }, required: ["from"] },
  effect: "read",
  execute: async (input, context) => {
    const ticks: number[] = []
    for (let tick = input.from; tick > 0; tick -= 1) {
      if (context.signal.aborted)
        return {
          status: "error",
          output: `Stopped (${interruptReasonOf(context.signal)}) after: ${ticks.join(" ")}`,
          truncation: null,
          attachments: [],
          display: null,
        }
      ticks.push(tick)
      context.progress({ text: ticks.join(" ") })
      await Bun.sleep(1)
    }
    return { status: "success", output: ticks.join(" "), truncation: null, attachments: [], display: { ticks } }
  },
}

function context(signal: AbortSignal, progress: ToolProgress[] = []): ToolContext {
  return {
    sessionId: "ses_1" as SessionId,
    messageId: "msg_1" as MessageId,
    callId: "call_1" as CallId,
    cwd: "/repo",
    signal,
    progress: (update) => progress.push(update),
  }
}

describe("tool contract", () => {
  test("a tool runs with the context it is given and reports progress", async () => {
    const progress: ToolProgress[] = []
    const result = await countdown.execute({ from: 3 }, context(createInterrupt().signal, progress))
    expect(result).toEqual({ status: "success", output: "3 2 1", truncation: null, attachments: [], display: { ticks: [3, 2, 1] } })
    expect(progress.at(-1)).toEqual({ text: "3 2 1" })
  })

  test("an aborted tool returns what it observed, with the reason", async () => {
    const token = createInterrupt()
    const progress: ToolProgress[] = []
    const running = countdown.execute({ from: 1000 }, {
      ...context(token.signal, progress),
      progress: (update) => {
        progress.push(update)
        if (progress.length === 2) token.interrupt("user")
      },
    })
    expect(await running).toMatchObject({ status: "error", output: "Stopped (user) after: 1000 999" })
  })

  test("tools of different input types fit in one registry", () => {
    const other: Tool<{ path: string }> = { ...countdown, name: "read", execute: async () => ({ ...EMPTY }) }
    const registry: AnyTool[] = [countdown, other]
    expect(registry.map((tool) => tool.effect)).toEqual(["read", "read"])
  })

  test("specOf keeps only what the model is told", () => {
    const spec = specOf(countdown)
    expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"])
    expect(toolSpec(JSON.parse(JSON.stringify(spec)), "")).toEqual(spec)
  })

  test("the effect classes are closed", () => {
    for (const effect of ["read", "write", "exec", "network"]) expect(toolEffect(effect, "")).toBe(effect as never)
    expect(() => toolEffect("admin", "effect")).toThrow(DecodeError)
  })
})

const EMPTY = { status: "success", output: "", truncation: null, attachments: [], display: null } as const
