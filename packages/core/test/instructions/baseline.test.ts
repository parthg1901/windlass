import { describe, expect, test } from "bun:test"
import { BASE_SYSTEM_PROMPT, buildBaseline } from "../../src/instructions/baseline.ts"
import { agentsSource, dateSource, environmentSource, parseSections, renderSection } from "../../src/instructions/source.ts"
import { HARNESS_CLOSE, harnessOpen } from "../../src/request/build.ts"
import { canonicalJson } from "../../src/request/canonical.ts"
import type { Tool } from "../../src/tool/tool.ts"

const read = { name: "read", description: "Read a file", inputSchema: { type: "object" } }
const shell = { name: "shell", description: "Run a command", inputSchema: { type: "object" } }
const grep = { name: "grep", description: "Search", inputSchema: { type: "object" } }

const sources = [
  agentsSource("/home/u/.config/windlass/AGENTS.md", "Be brief."),
  agentsSource("/repo/AGENTS.md", "Use bun."),
  environmentSource({ cwd: "/repo", platform: "linux", gitRepository: true }),
  dateSource(2026, 11, 11),
]

describe("the base system prompt", () => {
  test("contains nothing that differs between sessions", () => {
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/\b20\d\d\b/)
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\/)
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/gpt|claude|gemini|openai|anthropic/i)
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/linux|darwin|macos|windows/i)
  })

  test("is normalised: no carriage returns, no surrounding blank space, not empty", () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain("\r")
    expect(BASE_SYSTEM_PROMPT).toBe(BASE_SYSTEM_PROMPT.trim())
    expect(BASE_SYSTEM_PROMPT.length).toBeGreaterThan(1_000)
    expect(BASE_SYSTEM_PROMPT.length).toBeLessThan(6_000)
  })

  test("does not contain anything that reads back as an instruction section", () => {
    expect(parseSections(BASE_SYSTEM_PROMPT)).toEqual([])
  })

  test("explains the envelopes the request builder and the sections use", () => {
    expect(BASE_SYSTEM_PROMPT).toContain(harnessOpen("..."))
    expect(BASE_SYSTEM_PROMPT).toContain(HARNESS_CLOSE)
    expect(BASE_SYSTEM_PROMPT).toContain(harnessOpen("compaction"))
    expect(BASE_SYSTEM_PROMPT).toContain("<environment>")
    expect(BASE_SYSTEM_PROMPT).toContain("<date>")
    expect(BASE_SYSTEM_PROMPT).toContain('<instructions path="...">')
  })

  test("says what the tool outcomes that cannot be seen on the wire mean", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("was not started")
    expect(BASE_SYSTEM_PROMPT).toContain("effect is unknown")
  })
})

describe("buildBaseline", () => {
  test("the instructions are the base prompt followed by one section per source, in the given order", () => {
    const baseline = buildBaseline({ tools: [read], sources })
    expect(baseline.instructions).toBe([BASE_SYSTEM_PROMPT, ...sources.map(renderSection)].join("\n\n"))
    expect(parseSections(baseline.instructions)).toEqual(sources)
  })

  test("tools are sorted by name and reduced to what the model is told", () => {
    const tool: Tool = { ...shell, effect: "exec", execute: async () => ({ status: "success", output: "", truncation: null, attachments: [], display: null }) }
    const baseline = buildBaseline({ prompt: "p", tools: [tool, read, grep], sources: [] })
    expect(baseline.tools).toEqual([grep, read, shell])
    expect(baseline.instructions).toBe("p")
  })

  test("the result does not depend on the order the tools were registered in", () => {
    const one = buildBaseline({ tools: [shell, read, grep], sources })
    const other = buildBaseline({ tools: [grep, shell, read], sources })
    expect(canonicalJson(one)).toBe(canonicalJson(other))
  })

  test("tool names sort by code unit, not by locale", () => {
    const names = ["b", "B", "a_", "a-", "Z", "a"]
    const baseline = buildBaseline({ prompt: "p", tools: names.map((name) => ({ ...read, name })), sources: [] })
    expect(baseline.tools.map((tool) => tool.name)).toEqual(["B", "Z", "a", "a-", "a_", "b"])
  })

  test("two tools with the same name are rejected", () => {
    expect(() => buildBaseline({ tools: [read, shell, { ...read, description: "Another" }], sources: [] })).toThrow(
      'two tools are named "read"',
    )
  })

  test("two sources with the same key are rejected", () => {
    expect(() => buildBaseline({ tools: [], sources: [dateSource(2026, 11, 11), dateSource(2026, 11, 12)] })).toThrow(
      'two instruction sources have the key "date"',
    )
  })

  test("a base prompt that would read back as a section is rejected", () => {
    const prompt = `You are an agent.\n${renderSection(dateSource(2026, 11, 11))}`
    expect(() => buildBaseline({ prompt, tools: [], sources: [] })).toThrow("contains an instruction section")
  })
})
