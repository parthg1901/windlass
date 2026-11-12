import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { redactPieces } from "../../src/approval/redact.ts"
import { capOutput } from "../../src/tool/cap.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { type Tool, type ToolProgress, noBlobStore } from "../../src/tool/tool.ts"
import { context, removeTempDirs, tempDir } from "../tools/helpers.ts"

afterEach(removeTempDirs)

const SECRET = "EXAMPLE_VALUE_123"
const MARKER = "[REDACTED:env]"

/** A tool that reports `text` as progress and returns it. */
const say: Tool<{ text: string }> = {
  name: "say",
  description: "Says text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  effect: "read",
  execute: async (input, ctx) => {
    ctx.progress({ text: input.text.slice(0, 100) })
    return { status: "success", output: input.text, truncation: null, attachments: [], display: null }
  },
}

describe("the runtime and the harness's redaction", () => {
  test("progress and the spill file of an output the runtime caps hold the placeholder", async () => {
    const spillDir = join(tempDir(), "spill")
    const runtime = createToolRuntime({ tools: [say], spillDir, putBlob: noBlobStore })
    const progress: ToolProgress[] = []
    const text = `start ${SECRET}\n${"line\n".repeat(3000)}end ${SECRET}\n`
    const outcome = await runtime.run({
      name: "say",
      argumentsText: JSON.stringify({ text }),
      context: { ...context(tempDir(), { progress }), redact: (part) => redactPieces(part, [SECRET]) },
    })
    expect(progress).toEqual([{ text: text.slice(0, 100).replace(SECRET, MARKER) }])
    const { output, truncation } = outcome.settlement
    expect(output).not.toContain(SECRET)
    expect(output).toStartWith(`start ${MARKER}\n`)
    expect(output).toEndWith(`end ${MARKER}\n`)
    const spill = readFileSync(truncation!.spillPath!, "utf8")
    expect(spill).toBe(text.split(SECRET).join(MARKER))
    expect(truncation!.originalBytes).toBe(Buffer.byteLength(spill))
  })

  test("without a redaction nothing changes", async () => {
    const runtime = createToolRuntime({ tools: [say], spillDir: join(tempDir(), "spill"), putBlob: noBlobStore })
    const progress: ToolProgress[] = []
    const outcome = await runtime.run({ name: "say", argumentsText: JSON.stringify({ text: `x ${SECRET}` }), context: context(tempDir(), { progress }) })
    expect(outcome.settlement.output).toBe(`x ${SECRET}`)
    expect(progress).toEqual([{ text: `x ${SECRET}` }])
  })
})

describe("the cap and placeholders", () => {
  test("a cut inside one long line moves out of a placeholder at either end", async () => {
    const limits = { maxBytes: 1000, maxLines: 100 }
    // The head keeps 244 bytes and the tail 244: one placeholder lies across each cut.
    const text = `${"a".repeat(238)}${MARKER}${"m".repeat(1500)}${MARKER}${"b".repeat(240)}`
    const { output } = await capOutput(text, join(tempDir(), "spill"), limits)
    const [head, rest] = output.split("\n\n[... ")
    expect(head).toBe("a".repeat(238))
    expect(rest).toEndWith(`]\n\n${"b".repeat(240)}`)
  })
})
