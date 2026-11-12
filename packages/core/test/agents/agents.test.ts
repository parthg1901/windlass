/** Agent definitions against real temporary directories: discovery and precedence, malformed files, restrictions, the index, and the three ways of using an agent. */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_INDEX_KEY, AGENT_INDEX_LIMITS, agentIndexSource, agentIndexUpdate, renderAgentIndex } from "../../src/agents/agent-index.ts"
import { parseAgentsSection, resolveAgentsConfig } from "../../src/agents/config.ts"
import { NO_RESTRICTIONS, type AgentRestrictions, parseAgentDefinition } from "../../src/agents/definition.ts"
import { type AgentDefinition, agentRoots, discoverAgents } from "../../src/agents/discover.ts"
import { checkAgentCall, combineRestrictions, describeRestrictions, effectiveApprovalMode, unknownToolNames } from "../../src/agents/restrictions.ts"
import {
  AGENT_KEY,
  SUBAGENT_AGENT_PROPERTY,
  agentRecord,
  agentRecordOf,
  agentSettings,
  agentSource,
  agentSwitch,
  childAgent,
  findAgent,
  renderAgentSection,
  resolveStartAgent,
} from "../../src/agents/use.ts"
import { brand } from "../../src/brand.ts"
import { ConfigError } from "../../src/config/schema.ts"
import { fingerprint } from "../../src/instructions/source.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lh-agents-")))
  dirs.push(base)
  const repo = join(base, "repo")
  const cwd = join(repo, "packages", "app")
  const configDir = join(base, "config")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  return { base, repo, cwd, configDir }
}

async function agent(dir: string, file: string, front: string, body = "Instructions.") {
  await Bun.write(join(dir, file), `---\n${front}\n---\n\n${body}\n`)
}

const project = (dir: string) => join(dir, `.${brand.directory}`, "agents")

const parse = (front: string, body = "Body.", name = "x") => parseAgentDefinition(`---\n${front}\n---\n${body}\n`, name)
const restrictionsOf = (front: string): AgentRestrictions => {
  const parsed = parse(`description: d\n${front}`)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.agent.restrictions
}

describe("discovery", () => {
  test("roots: the project from the working directory up to the repository root, then config paths, then the user directory", () => {
    const { cwd, configDir, base } = layout()
    const roots = agentRoots({ cwd, configDir, extraPaths: [join(base, "team")] }).map((root) => `${root.scope} ${root.dir.slice(base.length)}`)
    expect(roots).toEqual([
      `project /repo/packages/app/.${brand.directory}/agents`,
      "project /repo/packages/app/.agents/agents",
      "project /repo/packages/app/.claude/agents",
      `project /repo/packages/.${brand.directory}/agents`,
      "project /repo/packages/.agents/agents",
      "project /repo/packages/.claude/agents",
      `project /repo/.${brand.directory}/agents`,
      "project /repo/.agents/agents",
      "project /repo/.claude/agents",
      "config /team",
      "user /config/agents",
    ])
  })

  test("outside a repository only the working directory is searched", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lh-agents-norepo-")))
    dirs.push(base)
    const cwd = join(base, "a", "b")
    mkdirSync(cwd, { recursive: true })
    const roots = agentRoots({ cwd, configDir: join(base, "config") }).filter((root) => root.scope === "project")
    expect(roots.map((root) => root.dir.slice(base.length))).toEqual([`/a/b/.${brand.directory}/agents`, "/a/b/.agents/agents", "/a/b/.claude/agents"])
  })

  test("the nearest definition of a name wins; the others are reported as shadowed", async () => {
    const { repo, cwd, configDir } = layout()
    await agent(join(repo, ".claude", "agents"), "reviewer.md", "name: reviewer\ndescription: repo root", "Root.")
    await agent(project(cwd), "reviewer.md", "name: reviewer\ndescription: nearest", "Near.")
    await agent(join(configDir, "agents"), "reviewer.md", "name: reviewer\ndescription: user", "User.")
    await agent(join(configDir, "agents"), "planner.md", "name: planner\ndescription: user planner")
    const set = discoverAgents({ cwd, configDir })
    expect(set.agents.map((a) => `${a.name}:${a.description}:${a.root.scope}`)).toEqual(["planner:user planner:user", "reviewer:nearest:project"])
    expect(set.problems.filter((p) => p.severity === "shadowed").map((p) => p.path)).toEqual([join(configDir, "agents", "reviewer.md"), join(repo, ".claude", "agents", "reviewer.md")])
    expect(set.problems.find((p) => p.severity === "shadowed")!.reason).toContain(join(project(cwd), "reviewer.md"))
  })

  test("the brand directory beats .agents beats .claude in one directory; configured paths come before the user's", async () => {
    const { base, repo, cwd, configDir } = layout()
    await agent(join(repo, ".claude", "agents"), "a.md", "name: a\ndescription: claude")
    await agent(join(repo, ".agents", "agents"), "a.md", "name: a\ndescription: agents")
    await agent(join(repo, ".claude", "agents"), "b.md", "name: b\ndescription: claude")
    await agent(join(base, "team"), "c.md", "name: c\ndescription: team")
    await agent(join(configDir, "agents"), "c.md", "name: c\ndescription: user")
    const set = discoverAgents({ cwd, configDir, extraPaths: [join(base, "team")] })
    expect(set.agents.map((a) => `${a.name}:${a.description}`)).toEqual(["a:agents", "b:claude", "c:team"])
  })

  test("two definitions of one name in one directory: the first by path wins, the other is skipped", async () => {
    const { repo, cwd, configDir } = layout()
    const dir = join(repo, ".claude", "agents")
    await agent(dir, "a.md", "name: same\ndescription: first")
    await agent(join(dir, "group"), "b.md", "name: same\ndescription: second")
    const set = discoverAgents({ cwd, configDir })
    expect(set.agents.map((a) => a.description)).toEqual(["first"])
    expect(set.problems.filter((p) => p.severity === "skipped")).toEqual([expect.objectContaining({ path: join(dir, "group", "b.md"), reason: expect.stringContaining("same directory") })])
  })

  test("folders group definitions down to the depth limit; README.md, dot-entries and non-Markdown files are not read", async () => {
    const { repo, cwd, configDir } = layout()
    const dir = join(repo, ".claude", "agents")
    await agent(join(dir, "one", "two"), "deep.md", "name: deep\ndescription: level 3")
    await agent(join(dir, "one", "two", "three"), "deeper.md", "name: deeper\ndescription: level 4")
    await Bun.write(join(dir, "README.md"), "# Our agents\n")
    await agent(join(dir, ".hidden"), "h.md", "name: h\ndescription: hidden")
    await Bun.write(join(dir, "notes.txt"), "not a definition")
    const set = discoverAgents({ cwd, configDir })
    expect(set.agents.map((a) => a.name)).toEqual(["deep"])
    expect(set.problems).toEqual([])
  })

  test("disabled names are left out wherever they are", async () => {
    const { repo, cwd, configDir } = layout()
    await agent(join(repo, ".claude", "agents"), "a.md", "name: a\ndescription: x")
    await agent(join(configDir, "agents"), "a.md", "name: a\ndescription: y")
    await agent(join(configDir, "agents"), "b.md", "name: b\ndescription: y")
    const set = discoverAgents({ cwd, configDir, disabled: ["a"] })
    expect(set.agents.map((a) => a.name)).toEqual(["b"])
    expect(set.problems).toEqual([])
  })

  test("a link is followed inside the root and reported when it leads out", async () => {
    const { base, repo, cwd, configDir } = layout()
    const dir = join(repo, ".claude", "agents")
    await agent(join(dir, "real"), "inner.md", "name: inner\ndescription: inside")
    symlinkSync(join(dir, "real", "inner.md"), join(dir, "alias.md"))
    await agent(join(base, "elsewhere"), "outer.md", "name: outer\ndescription: outside")
    symlinkSync(join(base, "elsewhere", "outer.md"), join(dir, "outer.md"))
    symlinkSync(join(base, "missing.md"), join(dir, "dangling.md"))
    const set = discoverAgents({ cwd, configDir })
    expect(set.agents.map((a) => a.name)).toEqual(["inner"])
    const reasons = set.problems.map((p) => `${p.severity} ${p.path.slice(dir.length + 1)}: ${p.reason.slice(0, 30)}`)
    expect(reasons).toContain("skipped outer.md: it is a link to " + join(base, "elsewhere", "outer.md").slice(0, 14))
    expect(set.problems.some((p) => p.path.endsWith("dangling.md") && p.reason.includes("broken link"))).toBe(true)
    // The same file reached twice in one root: the second is the same name in the same directory.
    expect(set.problems.some((p) => p.path.endsWith(join("real", "inner.md")) && p.reason.includes("same directory"))).toBe(true)
  })

  test("the order is the same however the files were written", async () => {
    const first = layout()
    const second = layout()
    for (const name of ["zeta", "Alpha", "beta", "9x"]) await agent(join(first.repo, ".claude", "agents"), `${name}.md`, `name: ${name}\ndescription: d`)
    for (const name of ["9x", "beta", "Alpha", "zeta"]) await agent(join(second.repo, ".claude", "agents"), `${name}.md`, `name: ${name}\ndescription: d`)
    const names = (l: ReturnType<typeof layout>) => discoverAgents({ cwd: l.cwd, configDir: l.configDir }).agents.map((a) => a.name)
    expect(names(first)).toEqual(["9x", "Alpha", "beta", "zeta"])
    expect(names(second)).toEqual(names(first))
  })

  test("a file over the size limit is skipped with its size", async () => {
    const { repo, cwd, configDir } = layout()
    await agent(join(repo, ".claude", "agents"), "big.md", "name: big\ndescription: d", "x".repeat(70 * 1024))
    const set = discoverAgents({ cwd, configDir })
    expect(set.agents).toEqual([])
    expect(set.problems[0]!.reason).toMatch(/bytes; a definition may be at most 65536 bytes/)
  })
})

describe("malformed definitions are skipped with a reason, never thrown", () => {
  const cases: [string, string, RegExp][] = [
    ["no front matter", "Just text.", /does not start with front matter/],
    ["front matter not closed", "---\nname: a\ndescription: d\n", /not closed/],
    ["a line that is not key: value", "---\nname: a\ndescription: d\nthis is wrong\n---\n", /not `key: value`/],
    ["a duplicated key", "---\nname: a\nname: b\ndescription: d\n---\n", /twice/],
    ["an unclosed quote", '---\nname: a\ndescription: "open\n---\n', /not closed/],
    ["no description", "---\nname: a\n---\nBody\n", /no `description`/],
    ["a bad name", "---\nname: has space\ndescription: d\n---\n", /not a name/],
    ["the reserved name", "---\nname: None\ndescription: d\n---\n", /"none" cannot be an agent's name/],
    ["an unknown effect", "---\nname: a\ndescription: d\neffects: read, delete\n---\n", /"delete", which is not an effect class/],
    ["an empty restriction", "---\nname: a\ndescription: d\ntools:\n---\n", /`tools` is empty/],
    ["an empty flow list", "---\nname: a\ndescription: d\neffects: []\n---\n", /`effects` is empty/],
    ["an unclosed flow list", "---\nname: a\ndescription: d\ntools: [read, grep\n---\n", /not closed/],
    ["a tool pattern", "---\nname: a\ndescription: d\ntools: Bash(git:*)\n---\n", /patterns with arguments/],
    ["a bad denied tool", "---\nname: a\ndescription: d\ndisallowed-tools: rm -rf\n---\n", /not a tool name/],
    ["both spellings of denied tools", "---\nname: a\ndescription: d\ndisallowed-tools: shell\ndisallowedTools: shell\n---\n", /keep one/],
    ["an unknown approval mode", "---\nname: a\ndescription: d\napproval: yolo\n---\n", /one of ask, auto, full/],
    ["a bad model", "---\nname: a\ndescription: d\nmodel: gpt 6\n---\n", /not a model name/],
    ["a bad effort", "---\nname: a\ndescription: d\neffort: very-high\n---\n", /not a effort name/],
    ["both effort keys", "---\nname: a\ndescription: d\neffort: low\nreasoning-effort: high\n---\n", /keep one/],
  ]
  for (const [title, text, reason] of cases)
    test(title, async () => {
      const { repo, cwd, configDir } = layout()
      await Bun.write(join(repo, ".claude", "agents", "a.md"), text)
      const set = discoverAgents({ cwd, configDir })
      expect(set.agents).toEqual([])
      expect(set.problems).toHaveLength(1)
      expect(set.problems[0]).toEqual(expect.objectContaining({ severity: "skipped", name: "a" }))
      expect(set.problems[0]!.reason).toMatch(reason)
    })

  test("warnings that do not skip it: no name, a name unlike the file, a long description, no body, keys of other harnesses that are not read", async () => {
    const { repo, cwd, configDir } = layout()
    const dir = join(repo, ".claude", "agents")
    await Bun.write(join(dir, "nameless.md"), "---\ndescription: d\n---\nBody.\n")
    await Bun.write(join(dir, "file.md"), `---\nname: other\ndescription: ${"long ".repeat(300)}\npermissionMode: bypassPermissions\nhooks: x\n---\n`)
    const set = discoverAgents({ cwd, configDir })
    expect(set.agents.map((a) => a.name)).toEqual(["nameless", "other"])
    const warnings = set.problems.map((p) => p.reason)
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('the file name "nameless" is used'),
        expect.stringContaining('differs from its file name "file.md"'),
        expect.stringContaining("description is"),
        expect.stringContaining("no instructions"),
        expect.stringContaining("`permissionMode` is not read here"),
        expect.stringContaining("`hooks` is not read here"),
      ]),
    )
    expect(set.problems.every((p) => p.severity === "warning")).toBe(true)
  })
})

describe("front matter fields", () => {
  test("lists in every form, deduplicated; effects in their canonical order", () => {
    expect(restrictionsOf("tools: Read, Grep, glob, read").tools).toEqual(["Read", "Grep", "glob"])
    expect(restrictionsOf("tools: [read, 'grep']").tools).toEqual(["read", "grep"])
    expect(restrictionsOf("tools:\n  - read\n  - \"grep\" # comment\n\n  - glob").tools).toEqual(["read", "grep", "glob"])
    expect(restrictionsOf("tools: '*'").tools).toBeNull()
    expect(restrictionsOf("effects: write, READ").effects).toEqual(["read", "write"])
    expect(restrictionsOf("disallowedTools: shell").deniedTools).toEqual(["shell"])
    expect(restrictionsOf("approval: ASK").approval).toBe("ask")
    expect(restrictionsOf("")).toEqual(NO_RESTRICTIONS)
  })

  test("model and effort; inherit means the session's", () => {
    const parsed = parse("description: d\nmodel: gpt-6-luna\neffort: High")
    expect(parsed.ok && [parsed.agent.model, parsed.agent.effort]).toEqual(["gpt-6-luna", "high"])
    const inherit = parse("description: d\nmodel: inherit\nreasoning-effort: inherit")
    expect(inherit.ok && [inherit.agent.model, inherit.agent.effort]).toEqual([null, null])
  })

  test("the fingerprint changes with anything the session is given, and not with where the file is", () => {
    const a = parse("name: r\ndescription: d\neffects: read")
    const b = parseAgentDefinition("---\nname: r\ndescription: d\neffects: read\n---\nBody.\n", "elsewhere")
    const c = parse("name: r\ndescription: d\neffects: read, write")
    const d = parse("name: r\ndescription: d\neffects: read", "Other body.")
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error("parse")
    expect(a.agent.fingerprint).toBe(b.agent.fingerprint)
    expect(new Set([a.agent.fingerprint, c.agent.fingerprint, d.agent.fingerprint]).size).toBe(3)
  })
})

describe("restrictions", () => {
  const reviewer = { name: "reviewer", restrictions: restrictionsOf("effects: read\ndisallowed-tools: background_output") }

  test("an effect class outside the agent's is refused with a sentence that names the agent, the rule and the call", () => {
    expect(checkAgentCall(reviewer, { name: "read", effect: "read" })).toEqual({ kind: "pass" })
    const refused = checkAgentCall(reviewer, { name: "edit", effect: "write" })
    expect(refused).toEqual({
      kind: "refuse",
      reason: 'Not run: you are working as the agent "reviewer", which may use only tools that read. "edit" changes files. Carry on without it, or tell the user what you would need and why.',
    })
    expect(checkAgentCall(reviewer, { name: "shell", effect: "exec" }).kind).toBe("refuse")
    expect(checkAgentCall(reviewer, { name: "subagent", effect: "exec" }).kind).toBe("refuse")
  })

  test("a denied tool is refused even when its effect is allowed; names compare ignoring case", () => {
    const verdict = checkAgentCall(reviewer, { name: "Background_Output", effect: "read" })
    expect(verdict.kind === "refuse" && verdict.reason).toContain('may not use the tool "Background_Output"')
  })

  test("an allowlist refuses every other tool and lists the allowed ones", () => {
    const agent = { name: "searcher", restrictions: restrictionsOf("tools: Read, Grep") }
    expect(checkAgentCall(agent, { name: "grep", effect: "read" }).kind).toBe("pass")
    const verdict = checkAgentCall(agent, { name: "glob", effect: "read" })
    expect(verdict.kind === "refuse" && verdict.reason).toContain("may use only these tools: Read, Grep")
  })

  test("an MCP tool's effect is not trusted: under an effects restriction it runs only when named", () => {
    const loose = { name: "r", restrictions: restrictionsOf("effects: read") }
    const verdict = checkAgentCall(loose, { name: "docs_search", effect: "read", origin: "mcp" })
    expect(verdict.kind === "refuse" && verdict.reason).toContain("comes from an MCP server")
    const named = { name: "r", restrictions: restrictionsOf("effects: read\ntools: read, docs_search") }
    expect(checkAgentCall(named, { name: "docs_search", effect: "network", origin: "mcp" }).kind).toBe("pass")
    expect(checkAgentCall({ name: "r", restrictions: NO_RESTRICTIONS }, { name: "docs_search", effect: "network", origin: "mcp" }).kind).toBe("pass")
  })

  test("exempt tools are never refused", () => {
    const agent = { name: "r", restrictions: restrictionsOf("tools: read") }
    expect(checkAgentCall(agent, { name: "report_check_failure", effect: "read" }, { exempt: ["report_check_failure"] }).kind).toBe("pass")
    expect(checkAgentCall(agent, { name: "report_check_failure", effect: "read" }).kind).toBe("refuse")
  })

  test("a definition cannot widen: the verdict is only pass or refuse, and the approval mode only tightens", () => {
    // Everything allowed and the loosest mode asked for, as a project file might.
    const wide = { name: "yolo", restrictions: restrictionsOf("effects: read, write, exec, network\ntools: '*'\napproval: full") }
    for (const effect of ["read", "write", "exec", "network"] as const) expect(checkAgentCall(wide, { name: "shell", effect })).toEqual({ kind: "pass" })
    const mode = effectiveApprovalMode("ask", wide)
    expect(mode.mode).toBe("ask")
    expect(mode.ignored).toContain('asks for approval mode "full"; the user\'s mode "ask" is kept')
    expect(effectiveApprovalMode("auto", { name: "strict", restrictions: restrictionsOf("approval: ask") })).toEqual({ mode: "ask", ignored: null })
    expect(effectiveApprovalMode("full", null)).toEqual({ mode: "full", ignored: null })
  })

  test("combining takes the stricter of each field", () => {
    const parent = restrictionsOf("effects: read, exec\ntools: read, grep, shell, subagent\ndisallowed-tools: write\napproval: auto")
    const child = restrictionsOf("effects: read, write\ntools: Grep, read, edit\ndisallowed-tools: WRITE, glob\napproval: full")
    expect(combineRestrictions(parent, child)).toEqual({ effects: ["read"], tools: ["read", "grep"], deniedTools: ["write", "glob"], approval: "auto" })
    expect(combineRestrictions(NO_RESTRICTIONS, child)).toEqual(child)
    expect(combineRestrictions(parent, NO_RESTRICTIONS)).toEqual(parent)
  })

  test("names that are not tools of the session are found for a warning", () => {
    expect(unknownToolNames(restrictionsOf("tools: Read, Bash\ndisallowed-tools: WebFetch"), ["read", "shell", "grep"])).toEqual(["Bash", "WebFetch"])
  })

  test("the description for the model", () => {
    expect(describeRestrictions(NO_RESTRICTIONS)).toBe("No restrictions beyond the session's approval settings.")
    expect(describeRestrictions(restrictionsOf("effects: read, write\ndisallowed-tools: shell\napproval: ask"))).toBe(
      'Only tools that read or change files (effects: read, write). Never these tools: shell. Approval mode at most as loose as "ask".',
    )
  })
})

describe("the index", () => {
  const entry = (name: string, description: string, front = "") => ({ name, description, restrictions: restrictionsOf(front) })

  test("sorted, one line each, read-only agents tagged; nothing when there are none", () => {
    const text = renderAgentIndex([entry("planner", "Plans.\nTwo lines."), entry("reviewer", "Reviews.", "effects: read"), entry("fixer", "Fixes.", "tools: edit")])!
    expect(text.split("\n").slice(2)).toEqual(["- fixer (restricted): Fixes.", "- planner: Plans. Two lines.", "- reviewer (read only): Reviews."])
    expect(text).toContain("call the subagent tool with `agent` set to its name")
    expect(renderAgentIndex([])).toBeNull()
    expect(agentIndexSource([])).toBeNull()
  })

  test("bounded: descriptions are cut, then agents are named without one, then counted", () => {
    const many = Array.from({ length: 200 }, (_, index) => entry(`agent-${String(index).padStart(3, "0")}`, "word ".repeat(100)))
    const text = renderAgentIndex(many)!
    expect(text.length).toBeLessThanOrEqual(AGENT_INDEX_LIMITS.maxChars)
    expect(text).toContain("Also available, without descriptions here:")
    expect(text).toMatch(/, and \d+ more\.$/)
    const tiny = renderAgentIndex(many, { maxChars: 300, maxDescriptionChars: 20 })!
    expect(tiny.length).toBeLessThanOrEqual(300 + 30)
    const one = renderAgentIndex([entry("a", "x".repeat(500))], { maxChars: 6000, maxDescriptionChars: 50 })!
    expect(one.split("\n").pop()!.length).toBeLessThanOrEqual("- a: ".length + 50)
    expect(renderAgentIndex(many)).toBe(text)
  })

  test("appended once, again only when it changes, withdrawn when none are left", () => {
    const first = agentIndexSource([entry("reviewer", "Reviews.")])!
    expect(first.key).toBe(AGENT_INDEX_KEY)
    const added = agentIndexUpdate(undefined, first)!
    expect(added.text.split("\n")[0]).toBe("Agents you can run a subagent as:")
    expect(added.text).toContain(`<agents lines="${first.value.split("\n").length}">`)
    expect(added.fingerprint).toBe(fingerprint(first.value))
    expect(agentIndexUpdate(added.fingerprint, first)).toBeNull()
    const changed = agentIndexUpdate(added.fingerprint, agentIndexSource([entry("reviewer", "Reviews strictly.")]))!
    expect(changed.text.split("\n")[0]).toBe("The agents have changed. This list replaces the one you were given before:")
    const gone = agentIndexUpdate(changed.fingerprint, null)!
    expect(gone.fingerprint).toBeNull()
    expect(gone.text).toContain("There are no agents any more")
    expect(agentIndexUpdate(null, null)).toBeNull()
    expect(agentIndexUpdate(undefined, null)).toBeNull()
  })
})

describe("using an agent", () => {
  async function setup() {
    const { repo, cwd, configDir } = layout()
    const dir = join(repo, ".claude", "agents")
    await agent(dir, "reviewer.md", "name: reviewer\ndescription: Reviews without editing.\neffects: read\nmodel: gpt-6-sol\neffort: high", "Be strict.")
    await agent(dir, "fixer.md", "name: fixer\ndescription: Fixes.\ndisallowed-tools: shell", "Fix it.")
    await Bun.write(join(dir, "broken.md"), "---\nname: broken\n---\n")
    const set = discoverAgents({ cwd, configDir })
    const get = (name: string) => set.agents.find((a) => a.name === name) as AgentDefinition
    return { set, get, dir }
  }

  test("(a) a new session: the record is valid durable data, and its instructions are a baseline source", async () => {
    const { get, dir } = await setup()
    const record = agentRecordOf(get("reviewer"))
    expect(agentRecord(JSON.parse(JSON.stringify(record)), "agent")).toEqual(record)
    expect(record).toEqual(expect.objectContaining({ name: "reviewer", path: join(dir, "reviewer.md"), scope: "project", definition: get("reviewer").fingerprint, model: "gpt-6-sol", effort: "high" }))
    const source = agentSource(record)
    expect(source.key).toBe(AGENT_KEY)
    expect(source.value).toBe(
      [
        `You are working as the agent "reviewer" (defined in ${join(dir, "reviewer.md")}): Reviews without editing.`,
        "Restrictions: Only tools that read (effects: read). A call outside them is refused with the reason, not run.",
        "",
        "Be strict.",
      ].join("\n"),
    )
    expect(renderAgentSection(source.value)).toBe(`<agent lines="4">\n${source.value}\n</agent>`)
    expect(agentSettings(record, { model: "gpt-6-luna", reasoningEffort: null })).toEqual({ settings: { model: "gpt-6-sol", reasoningEffort: "high" }, changed: true, notes: [] })
  })

  test("settings: what the agent does not name is inherited; a model that is not offered is not used, with a note", async () => {
    const { get } = await setup()
    const fixer = agentRecordOf(get("fixer"))
    expect(agentSettings(fixer, { model: "gpt-6-luna", reasoningEffort: "low" })).toEqual({ settings: { model: "gpt-6-luna", reasoningEffort: "low" }, changed: false, notes: [] })
    const reviewer = agentSettings(agentRecordOf(get("reviewer")), { model: "gpt-6-luna", reasoningEffort: "low" }, ["gpt-6-luna"])
    expect(reviewer.settings).toEqual({ model: "gpt-6-luna", reasoningEffort: "high" })
    expect(reviewer.notes[0]).toContain('asks for the model "gpt-6-sol", which is not offered (gpt-6-luna)')
    expect(agentSettings(null, { model: "m", reasoningEffort: null }).changed).toBe(false)
  })

  test("starting: a name, the default, none; a missing or broken one fails closed", async () => {
    const { set } = await setup()
    const start = (requested: string | null | undefined, fallback: string | null) => resolveStartAgent(set, requested, { default: fallback })
    expect(start("reviewer", null)).toEqual({ ok: true, agent: expect.objectContaining({ name: "reviewer" }) })
    expect(start(undefined, "fixer")).toEqual({ ok: true, agent: expect.objectContaining({ name: "fixer" }) })
    expect(start("none", "fixer")).toEqual({ ok: true, agent: null })
    expect(start(undefined, null)).toEqual({ ok: true, agent: null })
    const missing = start(undefined, "reveiwer")
    expect(missing.ok === false && missing.message).toBe('There is no agent named "reveiwer". Did you mean "reviewer"? Agents: fixer, reviewer. (It is the default agent, agents.default; change that, or start with the agent "none".)')
    const broken = start("broken", null)
    expect(broken.ok === false && broken.message).toContain('The agent "broken" (')
    expect(broken.ok === false && broken.message).toContain("no `description`")
  })

  test("(b) a subagent: the name is checked when the call runs; restrictions are combined with the parent's", async () => {
    const { set, get } = await setup()
    const miss = findAgent(set, "fxer")
    expect(miss.ok === false && miss.message).toBe('There is no agent named "fxer". Did you mean "fixer"? Agents: fixer, reviewer.')
    expect(findAgent(set, "REVIEWER").ok).toBe(true)
    const disabled = findAgent({ ...set, agents: [] }, "fixer", ["fixer"])
    expect(disabled.ok === false && disabled.message).toContain("disabled")
    const none = findAgent({ agents: [], problems: [], roots: [] }, "x")
    expect(none.ok === false && none.message).toBe('There is no agent named "x". No agents are defined.')

    const parent = agentRecordOf(get("reviewer"))
    expect(childAgent(null, null)).toBeNull()
    expect(childAgent(parent, null)).toEqual(parent)
    const child = childAgent(parent, get("fixer"))!
    expect(child.name).toBe("fixer")
    expect(child.restrictions).toEqual({ effects: ["read"], tools: null, deniedTools: ["shell"], approval: null })
    expect(child.instructions).toContain("Restrictions: Only tools that read (effects: read). Never these tools: shell.")
    expect(childAgent(null, get("fixer"))!.restrictions).toEqual(get("fixer").restrictions)
  })

  test("the subagent tool's new property names no agent", () => {
    expect(JSON.stringify(SUBAGENT_AGENT_PROPERTY)).not.toMatch(/reviewer|fixer|enum/)
    expect(SUBAGENT_AGENT_PROPERTY.agent.type).toBe("string")
  })

  test("(c) a switch: an appended message that replaces the previous agent's instructions; nothing for no change", async () => {
    const { get } = await setup()
    const reviewer = agentRecordOf(get("reviewer"))
    const fixer = agentRecordOf(get("fixer"))
    const on = agentSwitch(null, reviewer)!
    expect(on.text.split("\n")[0]).toBe('The user switched you to the agent "reviewer". From this point on these instructions apply, in addition to the instructions you already have:')
    expect(on.text).toContain(renderAgentSection(reviewer.instructions))
    expect(on.fingerprint).toBe(fingerprint(agentSource(reviewer).value))
    const across = agentSwitch(reviewer, fixer)!
    expect(across.text.split("\n")[0]).toBe(
      'The user switched you from the agent "reviewer" to the agent "fixer". From this point on these instructions replace those of "reviewer" (and its restrictions); everything else you were given still applies:',
    )
    expect(agentSwitch(reviewer, reviewer)).toBeNull()
    expect(agentSwitch(null, null)).toBeNull()
    const off = agentSwitch(fixer, null)!
    expect(off).toEqual({ text: 'The user switched off the agent "fixer". From this point on its instructions and its restrictions no longer apply; carry on under your other instructions.', fingerprint: null })
    const edited = agentSwitch(reviewer, { ...reviewer, instructions: `${reviewer.instructions}\nAlso check tests.`, definition: "other" })!
    expect(edited.text.split("\n")[0]).toContain('The definition of the agent "reviewer" changed and the user selected it again')
  })
})

describe("configuration", () => {
  test("validates each key and names the file and path", () => {
    expect(parseAgentsSection({ paths: ["/abs", "~/team"], disabled: ["x"], default: " reviewer " }, "f.json")).toEqual({ paths: ["/abs", "~/team"], disabled: ["x"], default: "reviewer" })
    expect(parseAgentsSection({}, "f.json")).toEqual({})
    const bad: [unknown, string][] = [
      [[], "agents"],
      [{ colour: 1 }, "agents.colour"],
      [{ paths: "x" }, "agents.paths"],
      [{ paths: ["relative"] }, "agents.paths[0]"],
      [{ disabled: [""] }, "agents.disabled[0]"],
      [{ default: 3 }, "agents.default"],
      [{ default: "  " }, "agents.default"],
    ]
    for (const [value, path] of bad) {
      try {
        parseAgentsSection(value, "f.json")
        throw new Error("accepted")
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        expect((error as ConfigError).path).toBe(path)
      }
    }
  })

  test("resolves: ~ expanded, project paths first, the default only from the user's file", () => {
    const resolved = resolveAgentsConfig({ paths: ["~/mine"], disabled: ["a"], default: "reviewer" }, { paths: ["/proj"], disabled: ["b"], default: "yolo" }, "/home/u")
    expect(resolved).toEqual({ paths: ["/proj", "/home/u/mine"], disabled: ["a", "b"], default: "reviewer", ignored: [expect.stringContaining('agents.default "yolo"')] })
    expect(resolveAgentsConfig(undefined)).toEqual({ paths: [], disabled: [], default: null, ignored: [] })
    expect(resolveAgentsConfig({ default: "None" }).default).toBeNull()
  })
})
