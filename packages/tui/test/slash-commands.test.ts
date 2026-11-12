/**
 * Command files in the real `App`: a typed `/name` is looked up after the
 * interface's own commands and sent through the engine, the row says where
 * the message came from and what expansion reported, the palette and the
 * help list them, and a name no source knows is never sent.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { event } from "@windlass/core"
import type { CommandsResult } from "@windlass/acp/extensions"
import { COMMANDS, complete, fileCommands, findFileCommand, parseCommand } from "../src/commands.ts"
import { flat, m, started, step, succeeded } from "./builders.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

const LISTING: CommandsResult = {
  available: true,
  commands: [
    { name: "frontend:test", description: "Run the frontend tests", argumentHint: null, agent: null, path: "/work/.claude/commands/frontend/test.md", scope: "project", hiddenBy: null },
    { name: "release-notes", description: "Draft release notes for a version", argumentHint: "<version> [previous-version]", agent: null, path: "/work/.claude/commands/release-notes.md", scope: "project", hiddenBy: null },
    { name: "undo", description: "A file the interface's own command hides", argumentHint: null, agent: null, path: "/work/.claude/commands/undo.md", scope: "project", hiddenBy: "undo" },
  ],
  problems: [{ path: "/work/.claude/commands/broken.md", severity: "skipped", reason: "its `agent` \"not a name\" is not an agent's name", name: "broken" }],
}

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function open(width = 130, height = 44) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  const session = backend.session!
  const sent: { name: string; args: string; delivery: string }[] = []
  session.commands = async () => LISTING
  session.sendCommand = async (name, args, delivery) => {
    sent.push({ name, args, delivery })
    return "i1"
  }
  return { backend, session, sent }
}

async function enter(text: string) {
  await mounted!.setup.mockInput.typeText(text)
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
}

describe("parsing and completing", () => {
  test("a name with a namespace, a digit or a dot is a command; a path is a message", () => {
    expect(parseCommand("/frontend:test --watch")).toEqual({ spec: null, name: "frontend:test", rest: "--watch" })
    expect(parseCommand("/Release-Notes2 1.4")).toEqual({ spec: null, name: "Release-Notes2", rest: "1.4" })
    expect(parseCommand("/UNDO")?.spec?.name).toBe("undo")
    expect(parseCommand("/")).toEqual({ spec: null, name: "", rest: "" })
    expect(parseCommand("/etc/hosts is wrong")).toBeNull()
  })

  test("the palette offers the command files after the interface's own, with their argument hint, and not one a command of its own hides", () => {
    const files = fileCommands(LISTING)
    expect(files.map((command) => [command.name, command.args])).toEqual([["frontend:test", ""], ["release-notes", "<version> [previous-version]"]])
    expect(complete("/re", () => true, files).map((command) => command.name)).toEqual(["redo", "remember", "rename", "reconnect", "release-notes"])
    expect(complete("/frontend:", () => true, files).map((command) => command.name)).toEqual(["frontend:test"])
    expect(complete("/", () => true, files).length).toBe(COMMANDS.length + 2)
    expect(findFileCommand(files, "Release-Notes")?.name).toBe("release-notes")
    expect(findFileCommand(files, "undo")).toBeNull()
  })
})

describe("in the app", () => {
  test("a command file's name is sent through the engine with what was typed after it; the row says where its text came from", async () => {
    const { backend, session, sent } = await open(220)
    await enter("/release-notes 1.4")
    expect(sent).toEqual([{ name: "release-notes", args: "1.4", delivery: "steer" }])
    expect(backend.sent).toEqual([])
    session.emit(
      event("inbox.enqueued", { messageId: m("i1"), origin: null, delivery: "steer", content: [{ type: "text", text: "Draft the release notes for version 1.4.\nLook at the commits since ." }] }),
      event("command.expanded", { messageId: m("i1"), name: "release-notes", path: "/work/.claude/commands/release-notes.md", scope: "project", fingerprint: "f".repeat(64), arguments: "1.4", missing: [2], unsupported: [{ kind: "shell", text: "!`git status`", line: 3 }] }),
      started(),
      event("inbox.delivered", { messageId: m("i1") }),
      ...step("a1"),
      succeeded({ status: "not_configured" }),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("› /release-notes 1.4")
    expect(frame).toContain("the text of a command file was sent (2 lines) · from this project: /work/.claude/commands/release-notes.md")
    expect(frame).toContain("⚠ argument 2 was not given: it is empty in the text that was sent")
    expect(frame).toContain("⚠ !`git status` (line 3) was left as text: a command file runs nothing when it is used")
    // The text it stands for is under the row once it is expanded, and no event of it is unknown to this client.
    expect(frame).not.toContain("Draft the release notes for version 1.4.")
    expect(frame).not.toContain("event command.expanded")
    mounted!.setup.mockInput.pressKey("o", { ctrl: true })
    await mounted!.settle()
    // The latest expandable row is the turn's ending; select the message's row instead.
    mounted!.setup.mockInput.pressKey("o", { ctrl: true })
    mounted!.setup.mockInput.pressArrow("up", { meta: true })
    mounted!.setup.mockInput.pressArrow("up", { meta: true })
    mounted!.setup.mockInput.pressKey("o", { ctrl: true })
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("│ Draft the release notes for version 1.4.")
  })

  test("a name with a namespace is sent; a typo of either source and a file that cannot be used send nothing and say why", async () => {
    const { backend, sent } = await open(220)
    await enter("/frontend:test --watch")
    expect(sent).toEqual([{ name: "frontend:test", args: "--watch", delivery: "steer" }])
    await enter("/relase-notes 1.4")
    expect(flat(await mounted!.frame())).toContain("/relase-notes is not a command, so nothing was sent; did you mean /release-notes? (/help lists them). To send a message that starts with a slash, begin it with two: //relase-notes")
    await enter("/hlep")
    expect(flat(await mounted!.frame())).toContain("/hlep is not a command, so nothing was sent; did you mean /help?")
    await enter("/broken")
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("/broken cannot be used, so nothing was sent: its `agent` \"not a name\" is not an agent's name.")
    expect(frame).toContain("/work/.claude/commands/broken.md")
    expect(sent).toHaveLength(1)
    expect(backend.sent).toEqual([])
  })

  test("the palette and /help list the command files with where each comes from", async () => {
    await open(220, 120)
    await mounted!.setup.mockInput.typeText("/rel")
    await mounted!.settle()
    const palette = flat(await mounted!.frame())
    expect(palette).toContain("/release-notes <version> [previous-version]")
    expect(palette).toContain("Draft release notes for a version")
    // Enter on a command that takes arguments completes it and waits for them.
    mounted!.setup.mockInput.pressEnter()
    await mounted!.settle()
    for (let index = 0; index < 20; index += 1) mounted!.setup.mockInput.pressBackspace()
    await mounted!.settle()
    await enter("/help")
    const help = flat(await mounted!.frame())
    expect(help).toContain("Your commands · command files: their text is sent as your message")
    expect(help).toContain("/frontend:test")
    expect(help).toContain("Draft release notes")
    expect(help).toContain("from this project:")
    expect(help).toContain("/work/.claude/commands/release-notes.md")
    expect(help).toContain("/broken: not usable: its `agent`")
  })
})
