import { describe, expect, test } from "bun:test"
import { text } from "../../src/content.ts"
import { comparePrefix, hashBlock, hashRequest } from "../../src/request/prefix.ts"
import {
  type InputItem,
  type ModelRequest,
  type RequestBlock,
  requestBlocks,
  requestFromBlocks,
} from "../../src/request/request.ts"
import { type ToolSpec, sortTools } from "../../src/tool/tool.ts"

const read: ToolSpec = {
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}
const shell: ToolSpec = {
  name: "shell",
  description: "Run a command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}
const grep: ToolSpec = { name: "grep", description: "Search", inputSchema: { type: "object", properties: {} } }

const user = (value: string): InputItem => ({ type: "message", role: "user", content: text(value) })
const call = (callId: string, input: string): InputItem => ({
  type: "tool_call",
  callId,
  name: "read",
  input,
  providerData: null,
})
const result = (callId: string, output: string): InputItem => ({ type: "tool_result", callId, output, attachments: [] })

const base: ModelRequest = {
  params: { model: "gpt-test", reasoningEffort: "medium", toolChoice: "auto", parallelToolCalls: true },
  tools: [read, shell],
  instructions: "You are a coding agent.",
  input: [user("fix the bug"), call("call_1", '{"path":"a.ts"}'), result("call_1", "const a = 1")],
}

const compare = (previous: ModelRequest, next: ModelRequest) => comparePrefix(hashRequest(previous), hashRequest(next))

describe("requestBlocks", () => {
  test("orders blocks as params, tools, instructions, input", () => {
    expect(requestBlocks(base).map((block) => block.kind)).toEqual([
      "params",
      "tool",
      "tool",
      "instructions",
      "input",
      "input",
      "input",
    ])
  })

  test("loses nothing: the request can be rebuilt from its blocks", () => {
    expect(requestFromBlocks(requestBlocks(base))).toEqual(base)
    const empty: ModelRequest = { ...base, tools: [], input: [] }
    expect(requestFromBlocks(requestBlocks(empty))).toEqual(empty)
  })

  test("covers every field of the request", () => {
    // If a field is added to ModelRequest without a block, this fails and the
    // field would otherwise be sent without being hashed.
    expect(Object.keys(base).sort()).toEqual(["input", "instructions", "params", "tools"])
  })

  test("rejects block lists that are not a request", () => {
    const blocks = requestBlocks(base)
    const withoutParams = blocks.slice(1)
    const twoInstructions: RequestBlock[] = [...blocks.slice(0, 4), { kind: "instructions", text: "again" }]
    const toolAfterInput: RequestBlock[] = [...blocks, { kind: "tool", tool: grep }]
    for (const bad of [withoutParams, twoInstructions, toolAfterInput, []]) expect(() => requestFromBlocks(bad)).toThrow()
  })
})

describe("hashBlock", () => {
  test("is a SHA-256 over canonical JSON, with the canonical byte length", () => {
    const hashed = hashBlock({ kind: "instructions", text: "é" })
    expect(hashed).toEqual({
      kind: "instructions",
      hash: new Bun.CryptoHasher("sha256").update('{"kind":"instructions","text":"é"}').digest("hex"),
      bytes: 35,
    })
  })

  test("does not depend on key order inside a block", () => {
    const reordered: ToolSpec = {
      inputSchema: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
      description: "Read a file",
      name: "read",
    }
    expect(hashBlock({ kind: "tool", tool: reordered })).toEqual(hashBlock({ kind: "tool", tool: read }))
  })

  test("separates blocks of different kinds that carry the same text", () => {
    const asInstructions = hashBlock({ kind: "instructions", text: "hello" })
    const asUser = hashBlock({ kind: "input", item: user("hello") })
    const asDeveloper = hashBlock({ kind: "input", item: { type: "message", role: "developer", content: text("hello") } })
    expect(new Set([asInstructions.hash, asUser.hash, asDeveloper.hash]).size).toBe(3)
  })

  test("covers the opaque provider payload", () => {
    const item = (providerData: InputItem & { type: "reasoning" }) => hashBlock({ kind: "input", item: providerData }).hash
    expect(item({ type: "reasoning", text: "", providerData: { encrypted: "aaa" } })).not.toBe(
      item({ type: "reasoning", text: "", providerData: { encrypted: "aab" } }),
    )
  })

  test("is stable across calls", () => {
    expect(hashRequest(base)).toEqual(hashRequest(structuredClone(base)))
  })
})

describe("comparePrefix", () => {
  test("an identical request is an extension with nothing appended", () => {
    expect(compare(base, structuredClone(base))).toEqual({ extension: true, appended: 0 })
  })

  test("an appended message is an extension", () => {
    const next = { ...base, input: [...base.input, user("thanks, now add a test")] }
    expect(compare(base, next)).toEqual({ extension: true, appended: 1 })
  })

  test("a whole appended step is an extension", () => {
    const next = {
      ...base,
      input: [
        ...base.input,
        { type: "reasoning", text: "thinking", providerData: { encrypted: "x" } } satisfies InputItem,
        { type: "assistant_text", text: "Reading b.ts", providerData: null } satisfies InputItem,
        call("call_2", '{"path":"b.ts"}'),
        result("call_2", "const b = 2"),
      ],
    }
    expect(compare(base, next)).toEqual({ extension: true, appended: 4 })
  })

  test("an empty previous request is extended by anything", () => {
    expect(comparePrefix([], hashRequest(base))).toEqual({ extension: true, appended: 7 })
    expect(comparePrefix([], [])).toEqual({ extension: true, appended: 0 })
  })

  test("an edited earlier message is the first changed block", () => {
    const next = { ...base, input: [user("fix the bug please"), ...base.input.slice(1), user("more")] }
    const comparison = compare(base, next)
    expect(comparison).toMatchObject({ extension: false, index: 4, kind: "input", change: "changed" })
  })

  test("a rewritten tool result is caught even when a message was appended after it", () => {
    const next = { ...base, input: [base.input[0]!, base.input[1]!, result("call_1", "const a = 1 "), user("more")] }
    expect(compare(base, next)).toMatchObject({ extension: false, index: 6, kind: "input", change: "changed" })
  })

  test("reordered tools are the first changed block", () => {
    const next = { ...base, tools: [shell, read] }
    expect(compare(base, next)).toMatchObject({ extension: false, index: 1, kind: "tool", change: "changed" })
  })

  test("reordered input items are caught", () => {
    const next = { ...base, input: [base.input[0]!, base.input[2]!, base.input[1]!] }
    expect(compare(base, next)).toMatchObject({ extension: false, index: 5, kind: "input", change: "changed" })
  })

  test("a changed parameter is block 0", () => {
    for (const params of [
      { ...base.params, model: "gpt-other" },
      { ...base.params, reasoningEffort: "high" },
      { ...base.params, reasoningEffort: null },
      { ...base.params, toolChoice: "none" as const },
      { ...base.params, parallelToolCalls: false },
    ])
      expect(compare(base, { ...base, params })).toMatchObject({
        extension: false,
        index: 0,
        kind: "params",
        change: "changed",
      })
  })

  test("changed instructions are reported as instructions", () => {
    const next = { ...base, instructions: `${base.instructions} Today is Tuesday.` }
    expect(compare(base, next)).toMatchObject({ extension: false, index: 3, kind: "instructions", change: "changed" })
  })

  test("a changed tool description or schema is reported at that tool", () => {
    const described = { ...base, tools: [read, { ...shell, description: "Run a shell command" }] }
    expect(compare(base, described)).toMatchObject({ extension: false, index: 2, kind: "tool" })
    const schema = {
      ...base,
      tools: [{ ...read, inputSchema: { type: "object", properties: { path: { type: "string" }, limit: {} } } }, shell],
    }
    expect(compare(base, schema)).toMatchObject({ extension: false, index: 1, kind: "tool" })
  })

  test("an added tool is reported as a tool change, though instructions sat at that index", () => {
    const next = { ...base, tools: [read, shell, grep] }
    const comparison = compare(base, next)
    expect(comparison).toMatchObject({ extension: false, index: 3, kind: "tool", change: "changed" })
    if (!comparison.extension) {
      expect(comparison.previous.kind).toBe("instructions")
      expect(comparison.next?.kind).toBe("tool")
    }
  })

  test("a removed tool is reported as a tool change", () => {
    const next = { ...base, tools: [read] }
    const comparison = compare(base, next)
    expect(comparison).toMatchObject({ extension: false, index: 2, kind: "tool", change: "changed" })
  })

  test("a tool inserted in sorted position breaks at that position", () => {
    const next = { ...base, tools: sortTools([...base.tools, grep]) }
    expect(next.tools.map((tool) => tool.name)).toEqual(["grep", "read", "shell"])
    expect(compare(base, next)).toMatchObject({ extension: false, index: 1, kind: "tool" })
  })

  test("a shorter request with an unchanged start is a removal, not an extension", () => {
    const next = { ...base, input: base.input.slice(0, 1) }
    const comparison = compare(base, next)
    expect(comparison).toMatchObject({ extension: false, index: 5, kind: "input", change: "removed", next: null })
  })

  test("the same tool-call id reused in a later step is an extension", () => {
    // Providers reuse call ids across steps. The earlier call and result are
    // untouched, so the later pair with the same id is plain appended content.
    const next = {
      ...base,
      input: [...base.input, call("call_1", '{"path":"b.ts"}'), result("call_1", "const b = 2")],
    }
    expect(compare(base, next)).toEqual({ extension: true, appended: 2 })
    const hashes = hashRequest(next)
    expect(hashes[5]!.hash).not.toBe(hashes[7]!.hash)
    expect(hashes[6]!.hash).not.toBe(hashes[8]!.hash)
  })

  test("identical repeated blocks hash the same but are compared by position", () => {
    const repeated = { ...base, input: [user("again"), user("again")] }
    const hashes = hashRequest(repeated)
    expect(hashes[4]!.hash).toBe(hashes[5]!.hash)
    expect(compare(repeated, { ...repeated, input: [user("again"), user("again"), user("again")] })).toEqual({
      extension: true,
      appended: 1,
    })
    expect(compare(repeated, { ...repeated, input: [user("again")] })).toMatchObject({
      extension: false,
      index: 5,
      change: "removed",
    })
  })

  test("reports the first change when there are several", () => {
    const next = { ...base, tools: [shell, read], instructions: "changed", input: [user("changed")] }
    expect(compare(base, next)).toMatchObject({ extension: false, index: 1, kind: "tool" })
  })

  test("a block with the same hash but another kind is a change", () => {
    const hashes = hashRequest(base)
    const forged = hashes.with(3, { ...hashes[3]!, kind: "input" })
    expect(comparePrefix(hashes, forged)).toMatchObject({ extension: false, index: 3, kind: "instructions" })
  })

  test("byte counts do not take part in equality", () => {
    const hashes = hashRequest(base)
    expect(comparePrefix(hashes, hashes.map((block) => ({ ...block, bytes: 0 })))).toEqual({
      extension: true,
      appended: 0,
    })
  })
})

describe("sortTools", () => {
  test("orders by code unit and does not mutate its input", () => {
    const tools = [{ name: "shell" }, { name: "Read" }, { name: "edit" }, { name: "read" }, { name: "élan" }]
    expect(sortTools(tools).map((tool) => tool.name)).toEqual(["Read", "edit", "read", "shell", "élan"])
    expect(tools[0]!.name).toBe("shell")
  })

  test("gives the same order whatever order the tools arrive in", () => {
    const names = ["grep", "read", "edit", "shell", "glob"].map((name) => ({ name }))
    expect(sortTools([...names].reverse())).toEqual(sortTools(names))
  })
})
