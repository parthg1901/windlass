/**
 * `Tool.varies`: how a tool says that its result changes without a call of
 * the model's, which the identical-call guard reads
 * (`packages/core/test/engine/spawn.test.ts` has the guard at work). It is
 * not part of a tool's spec, so the frozen tool list is the same with it.
 */
import { describe, expect, test } from "bun:test"
import { engineMcpTools } from "../../src/engine/mcp.ts"
import { spawnTools } from "../../src/engine/spawn.ts"
import { engineWakeTools } from "../../src/engine/wake.ts"
import { type AnyTool, specOf } from "../../src/tool/tool.ts"

const tools = (): AnyTool[] => {
  const spawn = spawnTools(() => null)
  const mcp = engineMcpTools(() => null)
  const wake = engineWakeTools({ runtime: () => { throw new Error("not used") }, now: () => 0, tainted: () => false, seqOf: () => null, configOf: () => null } as never)
  return [spawn.subagent, ...spawn.management, mcp.search as unknown as AnyTool, mcp.call as unknown as AnyTool, ...wake]
}

describe("tools whose result changes by itself", () => {
  test("polling background work, listing wake-ups and the MCP bridge say so; starting, stopping and cancelling do not", () => {
    expect(tools().filter((tool) => tool.varies === true).map((tool) => tool.name).sort()).toEqual(["background_output", "mcp_call", "mcp_search", "wake_list"])
    expect(tools().filter((tool) => tool.varies !== true).map((tool) => tool.name).sort()).toEqual(["background_stop", "subagent", "wake_cancel", "wake_create"])
  })

  test("it is not in the spec the model is sent", () => {
    for (const tool of tools()) expect(Object.keys(specOf(tool)).sort()).toEqual(["description", "inputSchema", "name"])
  })
})
