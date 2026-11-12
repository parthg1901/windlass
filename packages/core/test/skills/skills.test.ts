/** Skills against real temporary directories: discovery and precedence, malformed files, symlinks, the index, the tool, edits mid-session. */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { fingerprint } from "../../src/instructions/source.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { parseSkillsSection, resolveSkillsConfig } from "../../src/skills/config.ts"
import { MAX_DEPTH, discoverSkills, skillRoots } from "../../src/skills/discover.ts"
import { parseFrontMatter } from "../../src/skills/frontmatter.ts"
import { SKILL_INDEX_LIMITS, renderSkillIndex, skillIndexSource, skillIndexUpdate } from "../../src/skills/skill-index.ts"
import { SKILL_TOOL, skillTool } from "../../src/skills/tool.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { noBlobStore, specOf } from "../../src/tool/tool.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repository with a nested working directory, and a separate config directory. */
function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wl-skills-")))
  dirs.push(base)
  const repo = join(base, "repo")
  const cwd = join(repo, "packages", "app")
  const configDir = join(base, "config")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  return { base, repo, cwd, configDir }
}

async function skill(dir: string, name: string | null, description: string, body = `Instructions of ${name ?? "it"}.`, extra = "") {
  const lines = ["---", ...(name === null ? [] : [`name: ${name}`]), `description: ${description}`, ...(extra === "" ? [] : [extra]), "---", "", body]
  await Bun.write(join(dir, "SKILL.md"), lines.join("\n"))
}

const project = (dir: string) => join(dir, `.${brand.directory}`, "skills")

describe("discovery", () => {
  test("searches the project from the working directory to the repository root, then config paths, then the user directory", () => {
    const { repo, cwd, configDir, base } = layout()
    const roots = skillRoots({ cwd, configDir, extraPaths: [join(base, "team")] }).map((root) => `${root.scope} ${root.dir.slice(base.length)}`)
    expect(roots).toEqual([
      `project /repo/packages/app/.${brand.directory}/skills`,
      "project /repo/packages/app/.agents/skills",
      "project /repo/packages/app/.claude/skills",
      `project /repo/packages/.${brand.directory}/skills`,
      "project /repo/packages/.agents/skills",
      "project /repo/packages/.claude/skills",
      `project /repo/.${brand.directory}/skills`,
      "project /repo/.agents/skills",
      "project /repo/.claude/skills",
      "config /team",
      "user /config/skills",
    ])
    // Outside a repository only the working directory is searched.
    rmSync(join(repo, ".git"), { recursive: true })
    expect(skillRoots({ cwd, configDir }).filter((root) => root.scope === "project").length).toBe(3)
  })

  test("the nearest definition of a name wins, the others are reported as shadowed", async () => {
    const { repo, cwd, configDir, base } = layout()
    await skill(join(project(cwd), "deploy"), "deploy", "Nearest.")
    await skill(join(cwd, ".agents", "skills", "deploy"), "deploy", "Same directory, lower root.")
    await skill(join(repo, ".claude", "skills", "deploy"), "deploy", "Repository root.")
    await skill(join(repo, ".claude", "skills", "review"), "review", "Only in .claude.")
    await skill(join(configDir, "skills", "review"), "review", "User level.")
    await skill(join(configDir, "skills", "notes"), "notes", "Only at user level.")
    await skill(join(base, "team", "notes"), "notes", "Config path beats user.")
    const set = discoverSkills({ cwd, configDir, extraPaths: [join(base, "team")] })
    expect(set.skills.map((s) => [s.name, s.description, s.root.scope])).toEqual([
      ["deploy", "Nearest.", "project"],
      ["notes", "Config path beats user.", "config"],
      ["review", "Only in .claude.", "project"],
    ])
    expect(set.problems.filter((p) => p.severity === "shadowed").map((p) => p.path.slice(base.length))).toEqual([
      "/config/skills/notes/SKILL.md",
      "/config/skills/review/SKILL.md",
      "/repo/.claude/skills/deploy/SKILL.md",
      "/repo/packages/app/.agents/skills/deploy/SKILL.md",
    ])
  })

  test("two skills with one name in the same root: the first by path wins", async () => {
    const { cwd, configDir } = layout()
    await skill(join(project(cwd), "a-one"), "same", "First.")
    await skill(join(project(cwd), "b-two"), "same", "Second.")
    const set = discoverSkills({ cwd, configDir })
    expect(set.skills.map((s) => s.description)).toEqual(["First."])
    expect(set.problems.find((p) => p.severity === "skipped")!.reason).toStartWith('another skill in the same directory is named "same"')
  })

  test("a malformed skill is skipped with a reason and never stops discovery", async () => {
    const { cwd, configDir } = layout()
    const root = project(cwd)
    await Bun.write(join(root, "no-front-matter", "SKILL.md"), "# Just a heading\n")
    await Bun.write(join(root, "unclosed", "SKILL.md"), "---\nname: unclosed\ndescription: x\n")
    await Bun.write(join(root, "no-description", "SKILL.md"), "---\nname: no-description\n---\nbody\n")
    await Bun.write(join(root, "bad-name", "SKILL.md"), "---\nname: has spaces\ndescription: x\n---\n")
    await Bun.write(join(root, "duplicate", "SKILL.md"), "---\nname: duplicate\ndescription: a\ndescription: b\n---\n")
    await Bun.write(join(root, "bad-quote", "SKILL.md"), '---\nname: bad-quote\ndescription: "never closed\n---\n')
    await Bun.write(join(root, "not-yaml", "SKILL.md"), "---\nname: not-yaml\nthis line has no colon\ndescription: x\n---\n")
    await Bun.write(join(root, "binary", "SKILL.md"), new Uint8Array(300 * 1024))
    await skill(join(root, "fine"), "fine", "Still loaded.")
    const set = discoverSkills({ cwd, configDir })
    expect(set.skills.map((s) => s.name)).toEqual(["fine"])
    const reasons = Object.fromEntries(set.problems.map((p) => [p.path.split("/").at(-2), p.reason]))
    expect(reasons).toEqual({
      "bad-name": `its name "has spaces" is not a name of letters, digits, '-', '_' and '.' of at most 64 characters`,
      "bad-quote": "the double-quoted value on line 3 is not closed",
      binary: "it is 307200 bytes; a skill may be at most 262144 bytes",
      duplicate: "the front matter has the key `description` twice (line 4)",
      "no-description": "its front matter has no `description`, which is how the model knows when to use it",
      "no-front-matter": "it does not start with front matter (a line `---`, then `name:` and `description:`, then `---`)",
      "not-yaml": 'line 3 of the front matter is not `key: value`: "this line has no colon"',
      unclosed: "its front matter is not closed with a line `---`",
    })
    expect(set.problems.every((p) => p.severity === "skipped")).toBe(true)
  })

  test("front matter is read forgivingly: CRLF, a BOM, comments, quotes, block scalars, nested keys", async () => {
    const text = [
      "\uFEFF---",
      "# a comment",
      "name: 'it''s-fine'",
      "description: >-",
      "  Folded over",
      "  two lines.",
      "",
      "  Second paragraph.",
      "license: MIT",
      "metadata:",
      "  author: someone",
      "  tags: [a, b]",
      "allowed-tools:",
      "  - read",
      'version: "1.0" # trailing comment',
      "---",
      "",
      "The body.",
    ].join("\r\n")
    const parsed = parseFrontMatter(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.fields.get("name")).toBe("it's-fine")
    expect(parsed.fields.get("description")).toBe("Folded over two lines.\nSecond paragraph.")
    expect(parsed.fields.get("version")).toBe("1.0")
    expect(parsed.fields.get("metadata")).toBe("")
    expect(parsed.body).toBe("The body.")
    expect(parseFrontMatter('---\ndescription: "a \\"quoted\\" \\u00e9"\n---\n')).toMatchObject({ fields: new Map([["description", 'a "quoted" é']]) })
    expect(parseFrontMatter("---\ndescription: plain value\n  continued here\n---\n")).toMatchObject({ fields: new Map([["description", "plain value continued here"]]) })
    expect(parseFrontMatter("---\ndescription: |\n  line one\n  line two\n---\n")).toMatchObject({ fields: new Map([["description", "line one\nline two"]]) })
  })

  test("warnings do not skip a skill: no name, a name that differs from the directory, no body", async () => {
    const { cwd, configDir } = layout()
    await skill(join(project(cwd), "unnamed"), null, "Named after its directory.")
    await skill(join(project(cwd), "folder"), "other-name", "Name differs.")
    await Bun.write(join(project(cwd), "empty", "SKILL.md"), "---\ndescription: Nothing below.\n---\n")
    const set = discoverSkills({ cwd, configDir })
    expect(set.skills.map((s) => s.name)).toEqual(["empty", "other-name", "unnamed"])
    expect(set.problems.map((p) => [p.severity, p.reason])).toEqual([
      ["warning", 'it has no `name`; the directory name "empty" is used'],
      ["warning", "it has no instructions after the front matter"],
      ["warning", 'its name "other-name" differs from its directory name "folder"'],
      ["warning", 'it has no `name`; the directory name "unnamed" is used'],
    ])
  })

  test(`skills are found up to ${MAX_DEPTH} levels down, in grouping folders; dot-directories and node_modules are not searched`, async () => {
    const { cwd, configDir } = layout()
    const root = project(cwd)
    await skill(join(root, "group", "sub", "deep"), "deep", "Three levels down.")
    await skill(join(root, "a", "b", "c", "too-deep"), "too-deep", "Four levels down.")
    await skill(join(root, ".hidden", "secret"), "secret", "In a dot-directory.")
    await skill(join(root, "node_modules", "pkg"), "pkg", "In node_modules.")
    // A skill's own subdirectories are its supporting files, not more skills.
    await skill(join(root, "outer"), "outer", "Outer.")
    await skill(join(root, "outer", "inner"), "inner", "Inside another skill.")
    expect(discoverSkills({ cwd, configDir }).skills.map((s) => s.name)).toEqual(["deep", "outer"])
  })

  test("symbolic links are followed inside a root and never out of it", async () => {
    const { cwd, configDir, base } = layout()
    const root = project(cwd)
    await skill(join(root, "real"), "real", "The real one.")
    symlinkSync(join(root, "real"), join(root, "alias"))
    await skill(join(base, "outside", "escaped"), "escaped", "Outside the root.")
    symlinkSync(join(base, "outside", "escaped"), join(root, "escaped"))
    mkdirSync(join(root, "linked-file"), { recursive: true })
    await Bun.write(join(base, "outside", "SKILL.md"), "---\nname: linked-file\ndescription: x\n---\n")
    symlinkSync(join(base, "outside", "SKILL.md"), join(root, "linked-file", "SKILL.md"))
    symlinkSync(root, join(root, "loop"))
    const set = discoverSkills({ cwd, configDir })
    // `alias` points at `real` inside the root: the same name, so the first by path (alias) wins and real is reported.
    expect(set.skills.map((s) => [s.name, s.path.slice(root.length)])).toEqual([["real", "/alias/SKILL.md"]])
    const outside = set.problems.filter((p) => p.reason.includes("outside"))
    expect(outside.map((p) => p.path.slice(root.length))).toEqual(["/escaped", "/linked-file/SKILL.md"])
    expect(outside[0]!.reason).toBe(`it is a link to ${join(base, "outside", "escaped")}, which is outside ${root}; links are not followed out of a skills directory`)
  })

  test("disabled names are left out", async () => {
    const { cwd, configDir } = layout()
    await skill(join(project(cwd), "keep"), "keep", "Kept.")
    await skill(join(project(cwd), "drop"), "drop", "Dropped.")
    expect(discoverSkills({ cwd, configDir, disabled: ["drop"] }).skills.map((s) => s.name)).toEqual(["keep"])
  })

  test("the example skills load cleanly", () => {
    const examples = join(import.meta.dir, "../../../../examples/skills")
    const { cwd, configDir } = layout()
    const set = discoverSkills({ cwd, configDir, extraPaths: [examples] })
    expect(set.skills.map((s) => s.name)).toEqual(["commit", "harness-testing"])
    expect(set.problems).toEqual([])
    expect(set.skills[0]!.description).toStartWith("How to commit when other people or agents work in the same working tree:")
  })
})

describe("the index", () => {
  const entries = (count: number, description = (i: number) => `Does thing ${i}.`) =>
    Array.from({ length: count }, (_, i) => ({ name: `skill-${String(i).padStart(3, "0")}`, description: description(i) }))

  test("is sorted by name whatever the order of discovery", () => {
    const a = renderSkillIndex([
      { name: "zeta", description: "Last.\nWith a second line." },
      { name: "alpha", description: "First." },
    ])
    const b = renderSkillIndex([
      { name: "alpha", description: "First." },
      { name: "zeta", description: "Last.\nWith a second line." },
    ])
    expect(a).toBe(b)
    expect(a).toBe(
      [
        "Skills are instructions for particular kinds of task, kept as files. When a task matches a skill's description, load the skill with the skill tool (by name) before you start, and follow it.",
        "",
        "- alpha: First.",
        "- zeta: Last. With a second line.",
      ].join("\n"),
    )
    expect(renderSkillIndex([])).toBeNull()
  })

  test("is bounded: long descriptions are cut, then skills are named without descriptions, then counted", () => {
    const long = renderSkillIndex(entries(3, () => "x".repeat(1000)))!
    expect(long.split("\n")[2]!.length).toBe("- skill-000: ".length + SKILL_INDEX_LIMITS.maxDescriptionChars)
    const many = renderSkillIndex(entries(400, (i) => `A description of skill ${i} that is moderately long, as real ones are.`))!
    expect(many.length).toBeLessThanOrEqual(SKILL_INDEX_LIMITS.maxChars)
    expect(many).toContain("- skill-000: A description")
    expect(many).toMatch(/\nAlso available, without descriptions here: skill-\d+, .*, and \d+ more\.$/)
    const tiny = renderSkillIndex(entries(400), { maxChars: 400, maxDescriptionChars: 50 })!
    expect(tiny.length).toBeLessThanOrEqual(400)
    expect(renderSkillIndex([...entries(400)].reverse(), { maxChars: 400, maxDescriptionChars: 50 })).toBe(tiny)
  })

  test("is appended when it first appears and again only when its fingerprint changes", () => {
    const first = skillIndexSource([{ name: "a", description: "A." }])!
    const added = skillIndexUpdate(undefined, first)!
    expect(added.text).toStartWith('Skills you can load:\n<skills lines="3">\n')
    expect(added.fingerprint).toBe(fingerprint(first.value))
    expect(skillIndexUpdate(added.fingerprint, first)).toBeNull()
    const second = skillIndexSource([{ name: "a", description: "A, edited." }])!
    expect(skillIndexUpdate(added.fingerprint, second)!.text).toStartWith("The skills have changed. This list replaces the one you were given before:\n")
    expect(skillIndexUpdate(added.fingerprint, null)).toEqual({ text: "There are no skills any more. Disregard the list of skills you were given before.", fingerprint: null })
    expect(skillIndexUpdate(undefined, null)).toBeNull()
  })
})

describe("the skill tool", () => {
  let calls = 0
  const run = (cwd: string, configDir: string, args: unknown) => {
    const runtime = createToolRuntime({ tools: [skillTool({ configDir })], spillDir: join(configDir, "spill"), putBlob: noBlobStore })
    calls += 1
    return runtime.run({
      name: SKILL_TOOL,
      argumentsText: JSON.stringify(args),
      context: { sessionId: "ses_t" as SessionId, messageId: "msg_t" as MessageId, callId: `call_${calls}` as CallId, cwd, signal: createInterrupt().signal, progress: () => {} },
    })
  }

  test("has a fixed spec that names no skill", async () => {
    const { cwd, configDir } = layout()
    const before = JSON.stringify(specOf(skillTool({ configDir })))
    await skill(join(project(cwd), "deploy"), "deploy", "Deploys.")
    expect(JSON.stringify(specOf(skillTool({ configDir, extraPaths: ["/elsewhere"], disabled: ["x"] })))).toBe(before)
    expect(before).not.toContain("deploy")
    expect(skillTool({ configDir }).effect).toBe("read")
  })

  test("returns the body and the supporting files, through links only inside the skill", async () => {
    const { cwd, configDir, base } = layout()
    const dir = join(project(cwd), "deploy")
    await skill(dir, "deploy", "Deploys.", "Run `scripts/deploy.sh`, then read reference/checks.md.")
    await Bun.write(join(dir, "scripts", "deploy.sh"), "echo deploy\n")
    await Bun.write(join(dir, "reference", "checks.md"), "# Checks\n")
    await Bun.write(join(dir, ".hidden"), "not listed\n")
    await Bun.write(join(base, "secret.txt"), "outside\n")
    symlinkSync(join(base, "secret.txt"), join(dir, "secret-link.txt"))
    symlinkSync(join(dir, "reference", "checks.md"), join(dir, "checks-link.md"))
    const outcome = await run(cwd, configDir, { name: "deploy" })
    expect(outcome.settlement.outcome).toBe("success")
    expect(outcome.settlement.output).toBe(
      [
        `<skill name="deploy" path="${join(dir, "SKILL.md")}">`,
        "Run `scripts/deploy.sh`, then read reference/checks.md.",
        "</skill>",
        "",
        `Supporting files of this skill (paths in its instructions are relative to ${dir}):`,
        `- ${join(dir, "checks-link.md")}`,
        `- ${join(dir, "reference", "checks.md")}`,
        `- ${join(dir, "scripts", "deploy.sh")}`,
      ].join("\n"),
    )
    expect(outcome.settlement.display).toEqual({ skill: { name: "deploy", path: join(dir, "SKILL.md"), files: 3 } })
  })

  test("an unknown name gets close matches; a broken skill says why", async () => {
    const { cwd, configDir } = layout()
    await skill(join(project(cwd), "deploy"), "deploy", "Deploys.")
    await skill(join(project(cwd), "review"), "review", "Reviews.")
    await Bun.write(join(project(cwd), "broken", "SKILL.md"), "no front matter\n")
    expect((await run(cwd, configDir, { name: "deplyo" })).settlement.output).toBe('There is no skill named "deplyo". Did you mean "deploy"? Skills: deploy, review.')
    expect((await run(cwd, configDir, { name: "Deploy" })).settlement.outcome).toBe("success")
    const broken = await run(cwd, configDir, { name: "broken" })
    expect(broken.settlement.outcome).toBe("error")
    expect(broken.settlement.output).toBe(
      `The skill "broken" (${join(project(cwd), "broken", "SKILL.md")}) could not be loaded: it does not start with front matter (a line \`---\`, then \`name:\` and \`description:\`, then \`---\`).`,
    )
  })

  test("a skill edited mid-session gives an updated index and the new body on the next load", async () => {
    const { cwd, configDir } = layout()
    const dir = join(project(cwd), "deploy")
    await skill(dir, "deploy", "Deploys the app.", "Version one.")
    const index = () => skillIndexSource(discoverSkills({ cwd, configDir }).skills)
    const first = skillIndexUpdate(undefined, index())!
    expect((await run(cwd, configDir, { name: "deploy" })).settlement.output).toContain("Version one.")
    // The body changes: the index (names and descriptions) does not, so nothing is appended; the next load is new.
    await skill(dir, "deploy", "Deploys the app.", "Version two.")
    expect(skillIndexUpdate(first.fingerprint, index())).toBeNull()
    expect((await run(cwd, configDir, { name: "deploy" })).settlement.output).toContain("Version two.")
    // The description changes, and a skill is added: one replacement message.
    await skill(dir, "deploy", "Deploys the app to staging first.", "Version three.")
    await skill(join(project(cwd), "rollback"), "rollback", "Rolls back.")
    const second = skillIndexUpdate(first.fingerprint, index())!
    expect(second.text).toContain("- deploy: Deploys the app to staging first.\n- rollback: Rolls back.")
    // Every skill is removed: a withdrawal.
    unlinkSync(join(dir, "SKILL.md"))
    rmSync(join(project(cwd), "rollback"), { recursive: true })
    expect(skillIndexUpdate(second.fingerprint, index())!.fingerprint).toBeNull()
    expect(dirname(dir)).toBe(project(cwd))
  })
})

describe("the skills section", () => {
  test("validates and resolves", () => {
    expect(resolveSkillsConfig(parseSkillsSection({ paths: ["~/team", "/abs"], disabled: ["x"] }, "f"), "/home/u")).toEqual({
      paths: ["/home/u/team", "/abs"],
      disabled: ["x"],
    })
    expect(resolveSkillsConfig(undefined)).toEqual({ paths: [], disabled: [] })
    expect(() => parseSkillsSection({ path: [] }, "f")).toThrow(/unknown key "path"/)
    expect(() => parseSkillsSection({ paths: ["relative"] }, "f")).toThrow(/skills.paths\[0\]: expected an absolute path/)
  })
})
