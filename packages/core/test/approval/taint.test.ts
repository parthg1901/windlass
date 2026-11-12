import { describe, expect, test } from "bun:test"
import { CLEAN, type HistoryEntry, deriveTaint, describeTaint } from "../../src/approval/index.ts"
import { fact } from "./fixtures.ts"

type Result = Extract<HistoryEntry, { kind: "tool_result" }>

function result(at: number, overrides: Partial<Result>): Result {
  return { kind: "tool_result", at, tool: "read", effect: "read", origin: "builtin", paths: [], networkGranted: false, ...overrides }
}

const none = { untrustedPaths: [] }

describe("deriveTaint", () => {
  test("workspace reads, edits and sandboxed commands leave a session clean", () => {
    const history: HistoryEntry[] = [
      result(1, { paths: [fact("/w/src/a.ts", "workspace")] }),
      result(2, { tool: "edit", effect: "write", paths: [fact("/w/src/a.ts", "workspace")] }),
      result(3, { tool: "shell", effect: "exec" }),
      result(4, { tool: "read", paths: [fact("/w/.git/config", "protected")] }),
    ]
    expect(deriveTaint(history, none)).toEqual(CLEAN)
  })

  test("a network tool taints from its position, whatever follows", () => {
    const history: HistoryEntry[] = [result(1, {}), result(7, { tool: "web_fetch", effect: "network" }), result(9, {})]
    expect(deriveTaint(history, none)).toEqual({ tainted: true, since: 7, sources: [{ at: 7, tool: "web_fetch", kind: "network-tool", path: null }] })
  })

  test("MCP results taint even when the tool declares a read effect", () => {
    expect(deriveTaint([result(3, { tool: "docs__search", origin: "mcp" })], none).sources[0]?.kind).toBe("mcp-tool")
  })

  test("files outside the workspace or hidden taint; `since` stays at the first source", () => {
    const taint = deriveTaint([result(2, { paths: [fact("/tmp/notes.md", "outside")] }), result(5, { paths: [fact("/h/.ssh/config", "hidden")] })], none)
    expect(taint.since).toBe(2)
    expect(taint.sources.map((source) => [source.kind, source.path])).toEqual([
      ["outside-file", "/tmp/notes.md"],
      ["outside-file", "/h/.ssh/config"],
    ])
  })

  test("workspace files taint only when untrustedPaths matches them", () => {
    const history = [result(1, { paths: [fact("/w/src/a.ts", "workspace")] }), result(2, { tool: "grep", paths: [fact("/w/node_modules/x/README.md", "workspace")] })]
    expect(deriveTaint(history, none).tainted).toBe(false)
    expect(deriveTaint(history, { untrustedPaths: ["node_modules/**"] })).toMatchObject({ tainted: true, since: 2 })
    expect(deriveTaint(history, { untrustedPaths: ["**"] }).since).toBe(1)
  })

  test("a command taints only when it ran with network the harness granted", () => {
    expect(deriveTaint([result(1, { tool: "shell", effect: "exec", networkGranted: false })], none).tainted).toBe(false)
    expect(deriveTaint([result(1, { tool: "shell", effect: "exec", networkGranted: true })], none).sources[0]?.kind).toBe("network-command")
  })

  test("compaction does not clear taint; an explicit clear does, and a later source starts a new `since`", () => {
    const history: HistoryEntry[] = [
      result(4, { tool: "web_fetch", effect: "network" }),
      { kind: "compaction", at: 8 },
      result(9, {}),
    ]
    expect(deriveTaint(history, none)).toMatchObject({ tainted: true, since: 4 })
    const cleared: HistoryEntry[] = [...history, { kind: "taint_cleared", at: 12 }]
    expect(deriveTaint(cleared, none)).toEqual(CLEAN)
    expect(deriveTaint([...cleared, result(15, { tool: "web_fetch", effect: "network" })], none)).toMatchObject({ tainted: true, since: 15 })
  })

  test("describes the first source", () => {
    const taint = deriveTaint([result(2, { paths: [fact("/tmp/notes.md", "outside")] }), result(3, { tool: "web_fetch", effect: "network" })], none)
    expect(describeTaint(taint)).toBe("Content from /tmp/notes.md (outside the workspace) and 1 more is in this conversation and may contain instructions aimed at the model.")
  })
})
