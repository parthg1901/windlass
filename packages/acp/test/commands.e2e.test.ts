/**
 * Slash commands over the wire: the listing, a preview, sending one (and the
 * record of which file produced the message), a prompt that is `/name args`,
 * the refusals that send nothing, and how the commands are advertised.
 */
import { afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { brand } from "@windlass/core"
import { E2E_TIMEOUT_MS, script } from "@windlass/core/testing"
import type { CommandsResult, ExpandCommandResult, SendCommandResult } from "../src/extensions.ts"
import { EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const NOTES = "---\ndescription: Draft release notes for a version\nargument-hint: <version> [previous-version]\n---\nDraft the release notes for version $1.\nLook at the commits since $2.\n"
const STATUS = "Summarise !`git status` and @src/app.ts for me. $ARGUMENTS\n"
const TEST = "Run the frontend tests with bun test $ARGUMENTS and fix what fails.\n"
const UNDO = "A file a client's own command hides.\n"
const BROKEN = "---\nagent: not a name\n---\nReview.\n"

const BUILTINS = [{ name: "undo" }, { name: "help" }, { name: "quit", aliases: ["exit"] }]

const harnesses: Harness[] = []
const roots: string[] = []
afterEach(async () => {
  const violations = harnesses.flatMap((harness) => harness.violations)
  for (const harness of harnesses.splice(0).reverse()) await harness.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  expect(violations).toEqual([])
})

/** A server whose workspace has these command files (by path below `.claude/commands`). */
async function start(files: Record<string, string>, options: Parameters<typeof startHarness>[0] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${brand.binary}-acp-commands-`)))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, "work", ".claude", "commands", path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const harness = await startHarness({ dataDir: join(root, "data"), ...options, engine: { commands: { configDir: join(root, "config") }, ...options.engine } })
  harnesses.push(harness)
  await harness.initialize()
  return harness
}

const FILES = { "release-notes.md": NOTES, "status.md": STATUS, "frontend/test.md": TEST, "undo.md": UNDO, "broken.md": BROKEN }
const request = <T>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request(method as never, params as never) as Promise<T>
const events = (harness: Harness, type: string) => harness.ext.filter((item) => item.method === EXT.event && (item.params.event as { type: string }).type === type).map((item) => item.params.event as { data: Record<string, unknown> })
const refusal = async (work: Promise<unknown>) => {
  const error = (await work.then(() => null, (thrown: unknown) => thrown)) as { message: string; data?: Record<string, { reason?: string; message?: string }> } | null
  return error === null ? null : { message: error.message, reason: error.data?.[META.capabilities]?.reason ?? null }
}

test("the commands of a session are listed with where each comes from, the one a client's command hides, and a file that cannot be used with why", async () => {
  const harness = await start(FILES)
  const sessionId = await harness.newSession()
  const listed = await request<CommandsResult>(harness, EXT.commands, { sessionId, builtins: BUILTINS })
  expect(listed.available).toBe(true)
  expect(listed.commands.map((command) => [command.name, command.scope, command.argumentHint, command.hiddenBy])).toEqual([
    ["frontend:test", "project", null, null],
    ["release-notes", "project", "<version> [previous-version]", null],
    ["status", "project", null, null],
    ["undo", "project", null, "undo"],
  ])
  expect(listed.commands[1]!.path).toBe(join(harness.workspace, ".claude", "commands", "release-notes.md"))
  expect(listed.commands[1]!.description).toBe("Draft release notes for a version")
  const skipped = listed.problems.find((problem) => problem.severity === "skipped")
  expect(skipped?.path).toBe(join(harness.workspace, ".claude", "commands", "broken.md"))
  expect(skipped?.reason).toContain("agent")
  expect(listed.problems.some((problem) => problem.severity === "shadowed" && problem.name === "undo")).toBe(true)
  // A directory's, without a session; and the listing needs one or the other.
  const byDirectory = await request<CommandsResult>(harness, EXT.commands, { cwd: harness.workspace })
  expect(byDirectory.commands.map((command) => command.name)).toEqual(["frontend:test", "release-notes", "status", "undo"])
  expect(await refusal(request(harness, EXT.commands, {}))).not.toBeNull()
})

test("a preview says what would be sent and what expansion reported, and sends nothing", async () => {
  const harness = await start(FILES, { clientCapabilities: { _meta: { [META.capabilities]: { events: true } } } })
  const sessionId = await harness.newSession()
  const notes = await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "release-notes", args: "1.4" })
  if (notes.kind !== "command") throw new Error(`expected the command, got ${notes.kind}`)
  expect(notes.text).toBe("Draft the release notes for version 1.4.\nLook at the commits since .")
  expect(notes.missing).toEqual([2])
  expect(notes.command.name).toBe("release-notes")
  const status = await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "status", args: "briefly" })
  if (status.kind !== "command") throw new Error(`expected the command, got ${status.kind}`)
  expect(status.text).toContain("!`git status`")
  expect(status.unsupported.map((construct) => [construct.kind, construct.text, construct.line])).toEqual([
    ["shell", "!`git status`", 1],
    ["include", "@src/app.ts", 1],
  ])
  expect(status.unsupported[0]!.reason).toContain("does not run commands")
  // A name of the client's own, a typo (the close names of both sources), and a file that cannot be used.
  expect(await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "exit", args: "", builtins: BUILTINS })).toEqual({ kind: "builtin", name: "quit" })
  const typo = await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "statsu", args: "", builtins: BUILTINS })
  expect(typo).toMatchObject({ kind: "unknown", suggestions: ["status"] })
  const builtinTypo = await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "hlep", args: "", builtins: BUILTINS })
  expect(builtinTypo).toMatchObject({ kind: "unknown", suggestions: ["help"] })
  expect(await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "broken", args: "" })).toMatchObject({ kind: "broken", name: "broken" })
  expect(events(harness, "inbox.enqueued")).toEqual([])
  expect(harness.provider.requests.length).toBe(0)
})

test("a command is sent as its expansion, the log records which file produced it, and the client is told what was left as text", async () => {
  const harness = await start(FILES, { responses: [[script.text("Here are the notes.")]], clientCapabilities: { _meta: { [META.capabilities]: { events: true } } } })
  const sessionId = await harness.newSession()
  const sent = await request<SendCommandResult>(harness, EXT.sendCommand, { sessionId, name: "release-notes", args: "1.4", builtins: BUILTINS })
  expect(sent.command.name).toBe("release-notes")
  expect(sent.missing).toEqual([2])
  await until(() => events(harness, "execution.succeeded").length === 1, 10_000, "the turn's ending")
  const admitted = events(harness, "inbox.enqueued")[0]!.data as { messageId: string; origin: unknown; content: { text: string }[] }
  expect(admitted.messageId).toBe(sent.messageId)
  expect(admitted.origin).toBeNull()
  expect(admitted.content[0]!.text).toBe("Draft the release notes for version 1.4.\nLook at the commits since .")
  expect(events(harness, "command.expanded")[0]!.data).toMatchObject({ messageId: sent.messageId, name: "release-notes", scope: "project", arguments: "1.4", missing: [2], unsupported: [], path: join(harness.workspace, ".claude", "commands", "release-notes.md") })
  // The model was sent the expanded text, once.
  expect(harness.provider.requests.length).toBe(1)
  expect(JSON.stringify(harness.provider.requests[0])).toContain("Draft the release notes for version 1.4.")
  // Shown to a client that takes the standard updates as the message, marked with the command it came from.
  const shown = harness.of(sessionId, "user_message_chunk")[0] as { content: { text: string }; _meta?: Record<string, { name: string; arguments: string }> }
  expect(shown.content.text).toContain("Draft the release notes for version 1.4.")
  expect(shown._meta?.[META.command]).toMatchObject({ name: "release-notes", arguments: "1.4" })
})

test("a name no file has is refused with the nearest name of both sources, and nothing is sent", async () => {
  const harness = await start(FILES, { clientCapabilities: { _meta: { [META.capabilities]: { events: true } } } })
  const sessionId = await harness.newSession()
  const unknown = await refusal(request(harness, EXT.sendCommand, { sessionId, name: "relase-notes", args: "1.4", builtins: BUILTINS }))
  expect(unknown?.reason).toBe("invalid_request")
  expect(unknown?.message).toContain("There is no command /relase-notes. Did you mean /release-notes?")
  expect((await refusal(request(harness, EXT.sendCommand, { sessionId, name: "udno", args: "", builtins: BUILTINS })))?.message).toContain("Did you mean /undo?")
  expect((await refusal(request(harness, EXT.sendCommand, { sessionId, name: "undo", args: "", builtins: BUILTINS })))?.message).toContain("a command of the client's own")
  expect((await refusal(request(harness, EXT.sendCommand, { sessionId, name: "broken", args: "" })))?.message).toContain("cannot be used")
  expect(events(harness, "inbox.enqueued")).toEqual([])
  expect(harness.provider.requests.length).toBe(0)
})

test("a prompt that is /name args is expanded; one that names no command is refused; // sends the text", async () => {
  const harness = await start(FILES, { responses: [[script.text("Tests pass.")], [script.text("Odd indeed.")]], clientCapabilities: { _meta: { [META.capabilities]: { events: true } } } })
  const sessionId = await harness.newSession()
  const prompt = (text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
  expect((await prompt("/frontend:test --watch")).stopReason).toBe("end_turn")
  expect(events(harness, "command.expanded")[0]!.data).toMatchObject({ name: "frontend:test", arguments: "--watch" })
  expect((events(harness, "inbox.enqueued")[0]!.data as { content: { text: string }[] }).content[0]!.text).toBe("Run the frontend tests with bun test --watch and fix what fails.")
  const refused = await refusal(prompt("/frontend:tset --watch"))
  expect(refused?.message).toContain("Did you mean /frontend:test?")
  expect(refused?.message).toContain("start it with //")
  expect(harness.provider.requests.length).toBe(1)
  expect((await prompt("//etc is odd")).stopReason).toBe("end_turn")
  expect((events(harness, "inbox.enqueued")[1]!.data as { content: { text: string }[] }).content[0]!.text).toBe("/etc is odd")
  expect(events(harness, "command.expanded").length).toBe(1)
})

test("the commands are advertised after a session is opened, and again when a file was added by the next prompt", async () => {
  const harness = await start({ "release-notes.md": NOTES }, { responses: [[script.text("ok")]] })
  const sessionId = await harness.newSession()
  await until(() => harness.of(sessionId, "available_commands_update").length === 1, 10_000, "the commands")
  const first = harness.of(sessionId, "available_commands_update")[0] as { availableCommands: { name: string; description: string; input?: { hint: string } }[] }
  expect(first.availableCommands.map((command) => [command.name, command.description, command.input?.hint])).toEqual([["release-notes", "Draft release notes for a version", "<version> [previous-version]"]])
  // The answer that names the session comes before its commands.
  const answered = harness.wire.findIndex((message) => (message.result as { sessionId?: string } | undefined)?.sessionId === sessionId)
  const advertised = harness.wire.findIndex((message) => (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "available_commands_update")
  expect(answered).toBeGreaterThan(-1)
  expect(advertised).toBeGreaterThan(answered)
  writeFileSync(join(harness.workspace, ".claude", "commands", "status.md"), STATUS)
  await harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] })
  const updates = harness.of(sessionId, "available_commands_update") as { availableCommands: { name: string }[] }[]
  expect(updates.length).toBe(2)
  expect(updates[1]!.availableCommands.map((command) => command.name)).toEqual(["release-notes", "status"])
})

test("an engine without slash commands says so, and a prompt that starts with a slash is an ordinary prompt there", async () => {
  const harness = await start({}, { responses: [[script.text("ok")]], engine: { commands: null }, clientCapabilities: { _meta: { [META.capabilities]: { events: true } } } })
  const sessionId = await harness.newSession()
  expect(await request<CommandsResult>(harness, EXT.commands, { sessionId })).toEqual({ available: false, commands: [], problems: [] })
  expect(await request<ExpandCommandResult>(harness, EXT.expandCommand, { sessionId, name: "x", args: "" })).toMatchObject({ kind: "unavailable" })
  expect((await refusal(request(harness, EXT.sendCommand, { sessionId, name: "x", args: "" })))?.reason).toBe("invalid_request")
  await harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/tmp is full" }] })
  expect((events(harness, "inbox.enqueued")[0]!.data as { content: { text: string }[] }).content[0]!.text).toBe("/tmp is full")
})
