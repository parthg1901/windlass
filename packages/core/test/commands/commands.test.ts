/** Slash commands against real temporary directories: discovery and precedence, malformed files, expansion, unsupported constructs, lookup, collisions with built-ins. */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { parseCommandsSection, resolveCommandsConfig } from "../../src/commands/config.ts"
import { commandRoots, discoverCommands } from "../../src/commands/discover.ts"
import { expandTemplate, findUnsupported, splitArguments } from "../../src/commands/expand.ts"
import { type BuiltinCommand, expandCommand, listCommands, lookupCommand, parseSlash } from "../../src/commands/lookup.ts"
import { ConfigError } from "../../src/config/schema.ts"
import { fingerprint } from "../../src/instructions/source.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lh-commands-")))
  dirs.push(base)
  const repo = join(base, "repo")
  const cwd = join(repo, "app")
  const configDir = join(base, "config")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  return { base, repo, cwd, configDir }
}

const claude = (repo: string) => join(repo, ".claude", "commands")
const BUILTINS: readonly BuiltinCommand[] = [{ name: "undo" }, { name: "help" }, { name: "approval", aliases: ["mode"] }, { name: "quit", aliases: ["exit"] }]

describe("discovery", () => {
  test("roots mirror skills and agents", () => {
    const { base, cwd, configDir } = layout()
    expect(commandRoots({ cwd, configDir, extraPaths: [join(base, "team")] }).map((root) => `${root.scope} ${root.dir.slice(base.length)}`)).toEqual([
      `project /repo/app/.${brand.directory}/commands`,
      "project /repo/app/.agents/commands",
      "project /repo/app/.claude/commands",
      `project /repo/.${brand.directory}/commands`,
      "project /repo/.agents/commands",
      "project /repo/.claude/commands",
      "config /team",
      "user /config/commands",
    ])
  })

  test("front matter is optional; the description falls back to the first line; folders namespace with ':'", async () => {
    const { repo, cwd, configDir } = layout()
    await Bun.write(join(claude(repo), "release-notes.md"), "---\ndescription: Draft release notes\nargument-hint: <version> [previous]\n---\nWrite notes for $1.\n")
    await Bun.write(join(claude(repo), "plain.md"), "# Explain the code\n\nExplain $ARGUMENTS simply.\n")
    await Bun.write(join(claude(repo), "frontend", "test.md"), "Run the frontend tests.\n")
    await Bun.write(join(claude(repo), "a", "b", "c", "too-deep.md"), "Deep.\n")
    const set = discoverCommands({ cwd, configDir })
    expect(set.commands.map((c) => [c.name, c.description, c.derivedDescription, c.argumentHint])).toEqual([
      ["frontend:test", "Run the frontend tests.", true, null],
      ["plain", "Explain the code", true, null],
      ["release-notes", "Draft release notes", false, "<version> [previous]"],
    ])
    expect(set.problems).toEqual([])
    const notes = set.commands.find((c) => c.name === "release-notes")!
    expect(notes.template).toBe("Write notes for $1.")
    expect(notes.fingerprint).toBe(fingerprint("---\ndescription: Draft release notes\nargument-hint: <version> [previous]\n---\nWrite notes for $1.\n"))
  })

  test("nearest wins; the others are shadowed; disabled names are left out", async () => {
    const { repo, cwd, configDir } = layout()
    await Bun.write(join(claude(repo), "review.md"), "Repo review.\n")
    await Bun.write(join(cwd, `.${brand.directory}`, "commands", "review.md"), "Nearest review.\n")
    await Bun.write(join(configDir, "commands", "review.md"), "User review.\n")
    await Bun.write(join(configDir, "commands", "frontend", "lint.md"), "Lint.\n")
    const set = discoverCommands({ cwd, configDir })
    expect(set.commands.map((c) => `${c.name}:${c.template}:${c.root.scope}`)).toEqual(["frontend:lint:Lint.:user", "review:Nearest review.:project"])
    expect(set.problems.map((p) => [p.severity, p.path])).toEqual([
      ["shadowed", join(configDir, "commands", "review.md")],
      ["shadowed", join(claude(repo), "review.md")],
    ])
    expect(discoverCommands({ cwd, configDir, disabled: ["frontend:lint", "review"] }).commands).toEqual([])
  })

  test("the order does not depend on how the files were written", async () => {
    const a = layout()
    const b = layout()
    for (const name of ["zeta", "Alpha", "beta", "9"]) await Bun.write(join(claude(a.repo), `${name}.md`), "x\n")
    for (const name of ["9", "beta", "Alpha", "zeta"]) await Bun.write(join(claude(b.repo), `${name}.md`), "x\n")
    const names = (l: ReturnType<typeof layout>) => discoverCommands({ cwd: l.cwd, configDir: l.configDir }).commands.map((c) => c.name)
    expect(names(a)).toEqual(["9", "Alpha", "beta", "zeta"])
    expect(names(b)).toEqual(names(a))
  })
})

describe("malformed commands are skipped with a reason, never thrown", () => {
  const cases: [string, string, string, RegExp][] = [
    ["front matter not closed", "a.md", "---\ndescription: d\nBody\n", /not closed/],
    ["a line that is not key: value", "a.md", "---\nnonsense here\n---\nBody\n", /not `key: value`/],
    ["a duplicated key", "a.md", "---\ndescription: a\ndescription: b\n---\nBody\n", /twice/],
    ["no prompt text", "a.md", "---\ndescription: d\n---\n\n", /no prompt text/],
    ["an empty file", "a.md", "", /no prompt text/],
    ["a bad file name", "has space.md", "Body\n", /is not letters, digits/],
    ["a colon in a file name", "a:b.md", "Body\n", /is not letters, digits/],
    ["a bad agent", "a.md", "---\nagent: two words\n---\nBody\n", /not an agent's name/],
  ]
  for (const [title, file, text, reason] of cases)
    test(title, async () => {
      const { repo, cwd, configDir } = layout()
      await Bun.write(join(claude(repo), file), text)
      const set = discoverCommands({ cwd, configDir })
      expect(set.commands).toEqual([])
      expect(set.problems).toHaveLength(1)
      expect(set.problems[0]!.severity).toBe("skipped")
      expect(set.problems[0]!.reason).toMatch(reason)
    })

  test("a file over the size limit", async () => {
    const { repo, cwd, configDir } = layout()
    await Bun.write(join(claude(repo), "big.md"), "x".repeat(65 * 1024))
    expect(discoverCommands({ cwd, configDir }).problems[0]!.reason).toMatch(/a command may be at most 65536 bytes/)
  })

  test("keys of other harnesses that would grant or change something are reported as not read; unsupported constructs are warned about", async () => {
    const { repo, cwd, configDir } = layout()
    await Bun.write(join(claude(repo), "commit.md"), "---\nallowed-tools: Bash(git add:*)\nmodel: big\nname: other\n---\nStatus: !`git status`\nSee @src/main.ts\n")
    const set = discoverCommands({ cwd, configDir })
    expect(set.commands.map((c) => c.name)).toEqual(["commit"])
    expect(set.problems.every((p) => p.severity === "warning")).toBe(true)
    const reasons = set.problems.map((p) => p.reason)
    expect(reasons).toHaveLength(5)
    for (const start of ["`allowed-tools` is not read here: a command cannot grant tools", "`model` is not read here", "`name` is not read here", "line 1: !`git status` is left as text: a command file does not run commands", "line 2: @src/main.ts is left as text: a command file does not read files"])
      expect(reasons.some((reason) => reason.startsWith(start))).toBe(true)
  })
})

describe("expansion", () => {
  test("positional arguments, all of them, quotes", () => {
    const e = expandTemplate("Notes for $1 since $2. All: $ARGUMENTS.", ' 1.4  "1.3 beta" ')
    expect(e.text).toBe('Notes for 1.4 since 1.3 beta. All: 1.4  "1.3 beta".')
    expect(e.arguments).toEqual(["1.4", "1.3 beta"])
    expect(e.raw).toBe('1.4  "1.3 beta"')
    expect([e.missing, e.unused, e.appended, e.notes]).toEqual([[], [], false, []])
  })

  test("a missing positional argument becomes empty and is listed", () => {
    const e = expandTemplate("Compare $1 with $3.", "a")
    expect(e.text).toBe("Compare a with .")
    expect(e.missing).toEqual([3])
  })

  test("arguments the template does not use are listed; with $ARGUMENTS none are unused", () => {
    expect(expandTemplate("Only $2.", "a b c").unused).toEqual([1, 3])
    expect(expandTemplate("$1 then $ARGUMENTS", "a b").unused).toEqual([])
  })

  test("no placeholder: the arguments are appended, never dropped; none given: the template as it is", () => {
    expect(expandTemplate("Review the diff.", "focus on auth")).toEqual(expect.objectContaining({ text: "Review the diff.\n\nArguments: focus on auth", appended: true }))
    expect(expandTemplate("Review the diff.", "  ")).toEqual(expect.objectContaining({ text: "Review the diff.", appended: false }))
  })

  test("a literal dollar sign; other dollars are left alone; $10 is the tenth", () => {
    expect(expandTemplate("Costs $$5, $HOME stays, $0 stays, $ alone, $$ARGUMENTS literal", "").text).toBe("Costs $5, $HOME stays, $0 stays, $ alone, $ARGUMENTS literal")
    expect(expandTemplate("$10-$1", "a b c d e f g h i j").text).toBe("j-a")
  })

  test("substituted text is not expanded again", () => {
    expect(expandTemplate("[$1] [$2]", "'$2 and $ARGUMENTS' b").text).toBe("[$2 and $ARGUMENTS] [b]")
  })

  test("argument splitting", () => {
    expect(splitArguments(`a "b c" 'd "e"' "f \\"g\\" \\\\" h\\i ""`)).toEqual({ arguments: ["a", "b c", 'd "e"', 'f "g" \\', "h\\i", ""], unclosed: false })
    expect(splitArguments('a "b c')).toEqual({ arguments: ["a", "b c"], unclosed: true })
    expect(splitArguments("")).toEqual({ arguments: [], unclosed: false })
    expect(expandTemplate("$1|$2", 'a "b c').notes).toEqual(["A quote in the arguments is not closed; the last argument runs to the end."])
  })

  test("a shell construct and a file include are left as text and reported with the reason", () => {
    const template = "Status:\n!`git status --short`\nRead @src/app.ts and @./docs/ and (@~/notes.md).\nMail me@example.com, ping @octocat, cost @ 5."
    const e = expandTemplate(template, "")
    expect(e.text).toBe(template)
    expect(e.unsupported.map((u) => [u.kind, u.text, u.line])).toEqual([
      ["shell", "!`git status --short`", 2],
      ["include", "@src/app.ts", 3],
      ["include", "@./docs/", 3],
      ["include", "@~/notes.md", 3],
    ])
    expect(e.unsupported[0]!.reason).toContain("does not run commands")
    expect(e.unsupported[1]!.reason).toContain("does not read files")
    // The user's own arguments are theirs: nothing in them is reported.
    expect(expandTemplate("$ARGUMENTS", "!`ls` @src/x.ts").unsupported).toEqual([])
    expect(findUnsupported("Run `npm test` and say ! at the end.")).toEqual([])
  })
})

describe("entries, lookup and the listing", () => {
  test("what a typed entry is", () => {
    expect(parseSlash("hello")).toBeNull()
    expect(parseSlash("/release-notes 1.4 1.3")).toEqual({ kind: "command", name: "release-notes", args: "1.4 1.3" })
    expect(parseSlash("  /frontend:test  --watch\nmore ")).toEqual({ kind: "command", name: "frontend:test", args: "--watch\nmore" })
    expect(parseSlash("/")).toEqual({ kind: "command", name: "", args: "" })
    expect(parseSlash("/usr/bin/env is missing")).toBeNull()
    expect(parseSlash("//etc is odd")).toEqual({ kind: "text", text: "/etc is odd" })
  })

  async function setup() {
    const { repo, cwd, configDir } = layout()
    await Bun.write(join(claude(repo), "deploy.md"), "Deploy $1.\n")
    await Bun.write(join(claude(repo), "review.md"), "---\nagent: reviewer\n---\nReview.\n")
    await Bun.write(join(claude(repo), "undo.md"), "Our own undo.\n")
    await Bun.write(join(claude(repo), "Mode.md"), "A mode command.\n")
    await Bun.write(join(claude(repo), "broken.md"), "---\ndescription: x\n")
    return discoverCommands({ cwd, configDir })
  }

  test("built-ins win, then commands (exact, then ignoring case)", async () => {
    const set = await setup()
    expect(lookupCommand(set, "undo", BUILTINS)).toEqual({ kind: "builtin", name: "undo" })
    expect(lookupCommand(set, "MODE", BUILTINS)).toEqual({ kind: "builtin", name: "approval" })
    const found = lookupCommand(set, "/Deploy", BUILTINS)
    expect(found.kind === "command" && found.command.name).toBe("deploy")
    const review = lookupCommand(set, "review", BUILTINS)
    expect(review.kind === "command" && review.command.agent).toBe("reviewer")
    expect(lookupCommand(set, "undo").kind).toBe("command")
  })

  test("a typo gets a did-you-mean across built-ins and commands; a broken file says why", async () => {
    const set = await setup()
    expect(lookupCommand(set, "deplyo", BUILTINS)).toEqual({
      kind: "unknown",
      name: "deplyo",
      suggestions: ["deploy"],
      message: "There is no command /deplyo. Did you mean /deploy? To send it to the model as text, start it with //.",
    })
    expect(lookupCommand(set, "hepl", BUILTINS)).toEqual(expect.objectContaining({ suggestions: ["help"] }))
    expect(lookupCommand(set, "zzzzzzzz", BUILTINS)).toEqual(expect.objectContaining({ suggestions: [], message: "There is no command /zzzzzzzz. To send it to the model as text, start it with //." }))
    expect(lookupCommand(set, "", BUILTINS)).toEqual(expect.objectContaining({ kind: "unknown", message: expect.stringContaining("Type a command's name") }))
    const broken = lookupCommand(set, "broken", BUILTINS)
    expect(broken.kind === "broken" && broken.message).toContain("cannot be used: its front matter is not closed")
  })

  test("the listing marks commands a built-in hides and reports them", async () => {
    const set = await setup()
    const listing = listCommands(set, BUILTINS)
    expect(listing.commands.map((c) => [c.name, c.hiddenBy, c.agent, c.scope])).toEqual([
      ["Mode", "approval", null, "project"],
      ["deploy", null, null, "project"],
      ["review", null, "reviewer", "project"],
      ["undo", "undo", null, "project"],
    ])
    expect(listing.problems.map((p) => `${p.severity} ${p.name}: ${p.reason}`)).toEqual([
      "shadowed Mode: the client's built-in /approval takes the name /Mode; rename the file to use it",
      "skipped broken: its front matter is not closed with a line `---`",
      "shadowed undo: the client's built-in /undo takes the name /undo; rename the file to use it",
    ])
  })

  test("expandCommand is the template's expansion", async () => {
    const set = await setup()
    const found = lookupCommand(set, "deploy")
    if (found.kind !== "command") throw new Error("not found")
    expect(expandCommand(found.command, "staging").text).toBe("Deploy staging.")
    expect(expandCommand(found.command, "").missing).toEqual([1])
  })
})

describe("configuration", () => {
  test("validates and resolves", () => {
    expect(parseCommandsSection({ paths: ["~/c"], disabled: ["frontend:test"] }, "f.json")).toEqual({ paths: ["~/c"], disabled: ["frontend:test"] })
    for (const [value, path] of [[{ x: 1 }, "commands.x"], [{ paths: ["rel"] }, "commands.paths[0]"], [null, "commands"]] as const) {
      expect(() => parseCommandsSection(value, "f.json")).toThrow(ConfigError)
      try {
        parseCommandsSection(value, "f.json")
      } catch (error) {
        expect((error as ConfigError).path).toBe(path)
      }
    }
    expect(resolveCommandsConfig({ paths: ["~/c", "/abs"] }, "/home/u")).toEqual({ paths: ["/home/u/c", "/abs"], disabled: [] })
  })
})
