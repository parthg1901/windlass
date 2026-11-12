/**
 * Command files at the line CLI: how a typed `/name` is looked up (the CLI's
 * own commands first, then the user's and the project's files), what the
 * transcript says about a message a file produced, `/help`, and the whole of
 * it as a user types, against the real server in this process with a scripted
 * model.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { m, opening } from "@windlass/core/testing/scenarios"
import type { CommandsResult } from "@windlass/acp/extensions"
import { BUILTIN_COMMANDS, clientCommands, commandSent, helpLines, lookup, unknownCommandText, unusableCommandLines, userCommands } from "../src/slash.ts"
import { render, runCli, stored } from "./helpers.ts"
import { typedSessions } from "./typed.ts"

setDefaultTimeout(40_000)

const LISTING: CommandsResult = {
  available: true,
  commands: [
    { name: "frontend:test", description: "Run the frontend tests", argumentHint: null, agent: null, path: "/w/.claude/commands/frontend/test.md", scope: "project", hiddenBy: null },
    { name: "release-notes", description: "Draft release notes for a version", argumentHint: "<version> [previous-version]", agent: "writer", path: "/home/u/.config/x/commands/release-notes.md", scope: "user", hiddenBy: null },
    { name: "undo", description: "A file the CLI's own command hides", argumentHint: null, agent: null, path: "/w/.claude/commands/undo.md", scope: "project", hiddenBy: "undo" },
  ],
  problems: [{ path: "/w/.claude/commands/broken.md", severity: "skipped", reason: "its `agent` \"not a name\" is not an agent's name", name: "broken" }],
}

describe("looking a typed entry up", () => {
  const sources = [BUILTIN_COMMANDS, userCommands(LISTING)]

  test("the CLI's own commands come first, then the command files; a name with a namespace parses", () => {
    const own = lookup("/undo", sources)
    expect(own.kind === "command" ? [own.command.name, own.source.label] : null).toEqual(["undo", "Commands"])
    const file = lookup("/frontend:test --watch  src", sources)
    expect(file.kind === "command" ? [file.command.name, file.rest, file.command.file?.scope] : null).toEqual(["frontend:test", "--watch  src", "project"])
    const notes = lookup("/release-notes 1.4", sources)
    expect(notes.kind === "command" ? [notes.command.name, notes.rest, notes.command.args] : null).toEqual(["release-notes", "1.4", "<version> [previous-version]"])
    // A path is a message; two slashes send one.
    expect(lookup("/etc/hosts is wrong", sources)).toEqual({ kind: "message", text: "/etc/hosts is wrong" })
    expect(lookup("//frontend:test", sources)).toEqual({ kind: "message", text: "/frontend:test" })
  })

  test("an unknown name is never a message, and gets the nearest name of both sources", () => {
    const file = lookup("/relase-notes 1.4", sources)
    expect(file).toEqual({ kind: "unknown", name: "relase-notes", suggestion: "release-notes" })
    expect(lookup("/hlep", sources)).toEqual({ kind: "unknown", name: "hlep", suggestion: "help" })
    expect(lookup("/frontend:tset", sources)).toMatchObject({ kind: "unknown", suggestion: "frontend:test" })
    if (file.kind !== "unknown") throw new Error("expected an unknown command")
    expect(unknownCommandText(file)).toBe("/relase-notes is not a command, so nothing was sent; did you mean /release-notes? (/help lists them). To send a message that starts with a slash, begin it with two: //relase-notes")
  })

  test("a file that cannot be used says why and where; the CLI's own commands are what a file cannot take the name of", () => {
    expect(unusableCommandLines(LISTING, "broken")?.map((line) => line.text)).toEqual(['/broken cannot be used, so nothing was sent: its `agent` "not a name" is not an agent\'s name.', "/w/.claude/commands/broken.md"])
    expect(unusableCommandLines(LISTING, "nothing")).toBeNull()
    expect(clientCommands().find((command) => command.name === "exit")).toEqual({ name: "exit", aliases: ["quit"] })
  })

  test("/help lists the command files after the CLI's own, each with where it comes from and its file on a line of its own", () => {
    const lines = helpLines(sources)
    const text = lines.map((line) => `${" ".repeat(line.indent ?? 0)}${line.text}`)
    const at = text.findIndex((line) => line.startsWith("Your commands"))
    expect(at).toBeGreaterThan(text.findIndex((line) => line === "Commands:"))
    expect(text.slice(at + 1, at + 7)).toEqual([
      "  /frontend:test                               Run the frontend tests",
      "      from this project:",
      "      /w/.claude/commands/frontend/test.md",
      "  /release-notes <version> [previous-version]  Draft release notes for a version",
      "      your own, for every project · runs as the agent writer:",
      "      /home/u/.config/x/commands/release-notes.md",
    ])
    expect(lines.filter((line) => line.path === true).map((line) => line.text)).toEqual(["/w/.claude/commands/frontend/test.md", "/home/u/.config/x/commands/release-notes.md"])
    // A file the CLI's own command hides is not offered as a command.
    expect(text.some((line) => line.includes("A file the CLI's own command hides"))).toBe(false)
  })
})

describe("what the transcript says", () => {
  const use = { messageId: m("i1"), name: "release-notes", path: "/w/.claude/commands/release-notes.md", scope: "project" as const, fingerprint: "f".repeat(64), arguments: "1.4", missing: [2], unsupported: [{ kind: "shell" as const, text: "!`git status`", line: 3 }, { kind: "include" as const, text: "@src/app.ts", line: 4 }] }

  test("a message a command file produced is named as typed, with the file, what was not given and what was left as text", () => {
    expect(commandSent(use, "a\nb\nc")).toEqual({
      typed: "/release-notes 1.4",
      head: "the text of a command file was sent (3 lines)",
      where: "from this project",
      path: "/w/.claude/commands/release-notes.md",
      notes: [
        "argument 2 was not given: it is empty in the text that was sent",
        "!`git status` (line 3) was left as text: a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual",
        "@src/app.ts (line 4) was left as text: a command file reads no file into its text; the agent can read it with its tools",
      ],
    })
    expect(commandSent({ ...use, arguments: "", missing: [1, 2], unsupported: [] }, null)).toMatchObject({ typed: "/release-notes", head: "the text of a command file was sent", notes: ["arguments 1, 2 were not given: they are empty in the text that was sent"] })
    const events = opening("Draft the release notes for version 1.4.\nLook at the commits since .")
    const at = events.findIndex((item) => item.type === "inbox.enqueued")
    const admitted = events[at] as { data: { messageId: typeof use.messageId } }
    const out = render(stored([...events.slice(0, at + 1), event("command.expanded", { ...use, messageId: admitted.data.messageId }), ...events.slice(at + 1)]), { columns: () => 100 })
    expect(out).toContain("· /release-notes 1.4 · the text of a command file was sent (2 lines)\n  from this project:\n    /w/.claude/commands/release-notes.md\n  ⚠ argument 2 was not given: it is empty in the text that was sent\n")
    expect(out).toContain("  ⚠ !`git status` (line 3) was left as text: a command file runs nothing when it is used; the agent\n    can run it with its shell tool, which asks as usual\n")
  })
})

describe("as a user types them", () => {
  const { workspace, engineFor, interactive } = typedSessions(`${brand.binary}-cli-commands-`)
  const NOTES = "---\ndescription: Draft release notes for a version\nargument-hint: <version> [previous-version]\n---\nDraft the release notes for version $1.\nLook at the commits since $2.\n"
  const TEST = "Run the frontend tests with bun test $ARGUMENTS and fix what fails.\n"
  const BROKEN = "---\nagent: not a name\n---\nReview.\n"
  const withCommands = (files: Record<string, string>) => {
    const cwd = workspace()
    for (const [path, content] of Object.entries(files)) {
      const file = join(cwd, ".claude", "commands", path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    return cwd
  }

  test("a command file's name sends its text; the transcript says where it came from; a typo and a broken file send nothing", async () => {
    const cwd = withCommands({ "release-notes.md": NOTES, "frontend/test.md": TEST, "broken.md": BROKEN })
    const provider = new FakeProvider([[script.text("Here are the notes.")], [script.text("The tests pass.")]])
    const run = await interactive(["--cwd", cwd], engineFor(provider, cwd), async (type, waitFor) => {
      type("/help\r")
      await waitFor("Your commands (command files: their text is sent as your message):")
      await waitFor("/release-notes <version> [previous-version]  Draft release notes for a version")
      await waitFor(join(cwd, ".claude", "commands", "frontend", "test.md"))
      await waitFor("Command files with problems:")
      type("/relase-notes 1.4\r")
      await waitFor("/relase-notes is not a command, so nothing was sent; did you mean /release-notes?")
      type("/hlep\r")
      await waitFor("/hlep is not a command, so nothing was sent; did you mean /help?")
      type("/broken\r")
      await waitFor("/broken cannot be used, so nothing was sent:")
      type("/release-notes 1.4\r")
      await waitFor("› /release-notes 1.4")
      await waitFor("· /release-notes 1.4 · the text of a command file was sent (2 lines)")
      await waitFor("from this project:")
      await waitFor("⚠ argument 2 was not given: it is empty in the text that was sent")
      await waitFor("Here are the notes.")
      await waitFor(/✓ done/)
      type("/frontend:test --watch\r")
      await waitFor("· /frontend:test --watch · the text of a command file was sent (1 line)")
      await waitFor("The tests pass.")
      type("\x04")
    })
    expect(run.code).toBe(0)
    // Two messages reached the model: the two commands' texts, and nothing of the typos or the broken file.
    expect(provider.requests.length).toBe(2)
    expect(JSON.stringify(provider.requests[0])).toContain("Draft the release notes for version 1.4.")
    expect(JSON.stringify(provider.requests[1])).toContain("Run the frontend tests with bun test --watch and fix what fails.")
    expect(run.seen).toContain(join(cwd, ".claude", "commands", "release-notes.md"))
  })

  test("a one-prompt run whose prompt is a command file's name sends the file's text", async () => {
    const cwd = withCommands({ "frontend/test.md": TEST })
    const provider = new FakeProvider([[script.text("The tests pass.")]])
    const run = await runCli(["--cwd", cwd, "/frontend:test src"], { engine: engineFor(provider, cwd) })
    expect(run.code).toBe(0)
    expect(run.out).toContain("· /frontend:test src · the text of a command file was sent (1 line)\n  from this project:\n")
    expect(run.out).toContain("The tests pass.")
    expect(JSON.stringify(provider.requests[0])).toContain("Run the frontend tests with bun test src and fix what fails.")
  })
})
