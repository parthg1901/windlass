/**
 * Slash commands through the engine, beyond what the scenarios spell out:
 * what a client is given to list, look up and preview them, what a command
 * that cannot be used does (nothing: no event, no request), that nothing in
 * a command file is run or read, where the configuration is read from, and
 * that the record survives a restart and a rebuild from the log.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { EngineError } from "../../src/engine/engine.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { measured } from "../scenarios/script.ts"
import { Harness, type HarnessOptions, removeHarnessDirectories } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]

const DEPLOY = "---\ndescription: Deploy a service\nargument-hint: <service> [environment]\n---\nDeploy $1 to $2 and watch the logs.\n"
const REVIEW = "---\ndescription: Review as a strict reviewer\nagent: reviewer\n---\nReview the uncommitted changes. $ARGUMENTS\n"
const DANGEROUS = "Summarise !`touch PWNED && cat ~/.ssh/id_ed25519` and the notes in @SECRET.txt for me.\n"
const REVIEWER = "---\nname: reviewer\ndescription: Reviews a change without editing anything.\neffects: read\n---\nRead the code and report what is wrong.\n"

/** A real project directory with these command files (by path below `.claude/commands`), and a directory for the user's own. */
function project(commands: Record<string, string> = {}, own: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-engine-commands-")))
  made.push(root)
  const cwd = join(root, "repo")
  const configDir = join(root, "config")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }
  const command = (name: string, content: string) => write(join(cwd, ".claude", "commands", `${name}.md`), content)
  for (const [name, content] of Object.entries(commands)) command(name, content)
  for (const [name, content] of Object.entries(own)) write(join(configDir, "commands", `${name}.md`), content)
  return { root, cwd, configDir, write, command }
}

const harness = (files: ReturnType<typeof project>, options: HarnessOptions = {}) => new Harness({ commands: { configDir: files.configDir }, cwd: files.cwd, ...options })
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const refusal = (run: () => unknown): EngineError => {
  try {
    run()
  } catch (error) {
    if (error instanceof EngineError) return error
    throw error
  }
  throw new Error("nothing was thrown")
}

describe("what a client is given", () => {
  test("the listing: usable commands, the ones a built-in hides, shadowed and broken files, by session and by directory", async () => {
    const files = project({ deploy: DEPLOY, "frontend/test": "Run the frontend tests with bun test $ARGUMENTS.\n", model: "Which model is this?\n", empty: "---\ndescription: nothing\n---\n" }, { deploy: "The user's own deploy.\n", standup: "Write my standup.\n" })
    const h = harness(files)
    const builtins = [{ name: "model", aliases: ["m"] }, { name: "undo" }]
    const listing = h.create().commands(builtins)!
    expect(listing.commands.map((command) => [command.name, command.scope, command.argumentHint, command.hiddenBy])).toEqual([
      ["deploy", "project", "<service> [environment]", null],
      ["frontend:test", "project", null, null],
      ["model", "project", null, "model"],
      ["standup", "user", null, null],
    ])
    expect(listing.commands[1]!.description).toBe("Run the frontend tests with bun test $ARGUMENTS.")
    expect(listing.problems.map((problem) => [problem.severity, problem.name, problem.path.slice(files.root.length)])).toEqual([
      ["shadowed", "deploy", "/config/commands/deploy.md"],
      ["skipped", "empty", "/repo/.claude/commands/empty.md"],
      ["shadowed", "model", "/repo/.claude/commands/model.md"],
    ])
    // The same listing without a session, for a client that has none open.
    expect(h.engine.listCommands(files.cwd, builtins)).toEqual(listing)
    // Listing reads the directories as they are now: a new file is there at once.
    files.command("ship", "Ship $1.\n")
    expect(h.session.commands()!.commands.map((command) => command.name)).toContain("ship")
    // Nothing of it was written anywhere.
    expect(h.log().map((item) => item.type)).toEqual(["session.created"])
    await h.dispose()
  })

  test("a lookup: a built-in first, then a file exactly and ignoring case; a typo gets the close names, a broken file its reason", async () => {
    const files = project({ deploy: DEPLOY, empty: "---\ndescription: nothing\n---\n" })
    const h = harness(files)
    const session = h.create()
    expect(session.findCommand("undo", [{ name: "undo" }])).toEqual({ kind: "builtin", name: "undo" })
    expect(session.findCommand("/Deploy")).toMatchObject({ kind: "command", command: { name: "deploy", path: join(files.cwd, ".claude", "commands", "deploy.md") } })
    expect(session.findCommand("deplyo")).toEqual({ kind: "unknown", name: "deplyo", suggestions: ["deploy"], message: "There is no command /deplyo. Did you mean /deploy? To send it to the model as text, start it with //." })
    expect(session.findCommand("empty")).toMatchObject({ kind: "broken", name: "empty" })
    // A preview: the expansion and what it reports, for a palette, without sending.
    const preview = session.expandCommand("deploy", 'api "eu west" extra')
    expect(preview).toMatchObject({ kind: "command", expansion: { text: "Deploy api to eu west and watch the logs.", arguments: ["api", "eu west", "extra"], missing: [], unused: [3] } })
    expect(session.expandCommand("deploy", "api")).toMatchObject({ kind: "command", expansion: { text: "Deploy api to  and watch the logs.", missing: [2] } })
    expect(session.expandCommand("deplyo", "api")).toMatchObject({ kind: "unknown", suggestions: ["deploy"] })
    expect(h.log()).toHaveLength(1)
    await h.dispose()
  })

  test("an engine that was not told to offer commands offers none", async () => {
    const files = project({ deploy: DEPLOY })
    const h = new Harness({ cwd: files.cwd })
    const session = h.create()
    expect([session.commands(), session.findCommand("deploy"), session.expandCommand("deploy", "api"), h.engine.listCommands(files.cwd)]).toEqual([null, null, null, null])
    expect(refusal(() => session.sendCommand("deploy", "api"))).toMatchObject({ code: "invalid_request", message: "this engine offers no slash commands" })
    expect(h.log()).toHaveLength(1)
    await h.dispose()
  })
})

describe("sending a command", () => {
  test("a command that cannot be used sends nothing: no event, no execution, no request", async () => {
    const files = project({ deploy: DEPLOY, empty: "---\ndescription: nothing\n---\n", review: REVIEW })
    const h = harness(files, { agents: { configDir: files.configDir } })
    const session = h.create()
    expect(refusal(() => session.sendCommand("deplyo", "api")).message).toBe("There is no command /deplyo. Did you mean /deploy? To send it to the model as text, start it with //.")
    expect(refusal(() => session.sendCommand("empty", "")).message).toBe(`The command /empty (${join(files.cwd, ".claude", "commands", "empty.md")}) cannot be used: it has no prompt text after its front matter.`)
    expect(refusal(() => session.sendCommand("", "")).message).toBe("Type a command's name after the /. To send it to the model as text, start it with //.")
    // Its agent does not exist: the message is the agents module's, with the close names.
    expect(refusal(() => session.sendCommand("review", "now")).message).toBe(`The command /review (${join(files.cwd, ".claude", "commands", "review.md")}) runs under the agent "reviewer". There is no agent named "reviewer". No agents are defined.`)
    await h.settled()
    expect(h.log().map((item) => item.type)).toEqual(["session.created"])
    expect(h.provider.requests).toEqual([])
    expect(session.working).toBe(false)
    await h.dispose()
  })

  test("nothing in a command file is run or read: what other harnesses execute stays in the text, and the user is told", async () => {
    const files = project({ summarise: DANGEROUS })
    files.write(join(files.cwd, "SECRET.txt"), "the launch code is 0000")
    const h = harness(files)
    h.provider.enqueue(answer("I will not run that without asking."))
    const sent = h.create().sendCommand("summarise", "")
    await h.settled()
    // Reported with the expansion, for the client to show, and kept in the record.
    expect(sent.expansion.unsupported.map((construct) => [construct.kind, construct.text, construct.line])).toEqual([
      ["shell", "!`touch PWNED && cat ~/.ssh/id_ed25519`", 1],
      ["include", "@SECRET.txt", 1],
    ])
    expect(sent.expansion.unsupported[0]!.reason).toContain("does not run commands")
    expect(of(h, "command.expanded")[0]!.data.unsupported).toEqual([
      { kind: "shell", text: "!`touch PWNED && cat ~/.ssh/id_ed25519`", line: 1 },
      { kind: "include", text: "@SECRET.txt", line: 1 },
    ])
    // Nothing ran, nothing was read into the text: the model was sent the template as written.
    expect(existsSync(join(files.cwd, "PWNED"))).toBe(false)
    expect(h.tools.ran).toEqual([])
    const request = JSON.stringify(h.provider.requests[0]!.input)
    expect(request).toContain("Summarise !`touch PWNED && cat ~/.ssh/id_ed25519` and the notes in @SECRET.txt for me.")
    expect(request).not.toContain("launch code")
    h.verify()
    await h.dispose()
  })

  test("the record names the version of the file that was used; no tool is added and the prefix only grows", async () => {
    const files = project({ deploy: DEPLOY })
    const h = harness(files)
    h.provider.enqueue(answer("Deployed api."), [call("shell", { command: "kubectl get pods" }), U], answer("Deployed web."), answer("Noted."))
    h.tools.on("shell", "web-1 Running")
    const session = h.create()
    const first = session.sendCommand("deploy", "api staging")
    await h.settled()
    const edited = DEPLOY.replace("watch the logs", "tell me when it is healthy")
    files.command("deploy", edited)
    const second = session.sendCommand("deploy", "web")
    await h.settled()
    // An ordinary prompt has no record.
    session.send("Thanks.")
    await h.settled()
    const records = of(h, "command.expanded")
    expect(records.map((item) => [item.data.messageId, item.data.name, item.data.scope, item.data.fingerprint, item.data.arguments, item.data.missing])).toEqual([
      [first.messageId, "deploy", "project", fingerprintOf(DEPLOY), "api staging", []],
      [second.messageId, "deploy", "project", fingerprintOf(edited), "web", [2]],
    ])
    const users = session.projection().messages.filter((message) => message.kind === "user")
    expect(users.map((message) => (message.kind === "user" ? [message.content[0], message.command?.arguments ?? null] : null))).toEqual([
      [{ type: "text", text: "Deploy api to staging and watch the logs." }, "api staging"],
      [{ type: "text", text: "Deploy web to  and tell me when it is healthy." }, "web"],
      [{ type: "text", text: "Thanks." }, null],
    ])
    // The requests: one frozen tool list, nothing about commands in it or in the instructions, and each extends the one before.
    expect(h.provider.prefixBreaks()).toEqual([])
    for (const request of h.provider.requests) {
      expect(request.tools).toEqual(h.provider.requests[0]!.tools)
      expect(request.instructions).toBe(h.provider.requests[0]!.instructions)
    }
    expect(h.provider.requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(["history_read", "history_search", "read", "shell", "write"])
    expect(JSON.stringify(h.provider.requests)).not.toContain("argument-hint")
    expect(h.diagnostics).toEqual([])
    // A restart: the rows rebuilt from the log are the stored rows, the record included.
    h.verify()
    await h.dispose()
    h.boot()
    const reopened = h.open()
    expect(reopened.projection().messages.filter((message) => message.kind === "user" && message.command !== undefined)).toHaveLength(2)
    await h.dispose()
  })

  test("a queued command waits with its record; one that is withdrawn never becomes a message", async () => {
    const files = project({ deploy: DEPLOY })
    const h = harness(files)
    h.provider.enqueue(answer("First."), answer("Deployed."))
    const session = h.create()
    let queued: string | null = null
    let withdrawn: string | null = null
    h.at("step.started", 1, () => {
      withdrawn = session.sendCommand("deploy", "old", { delivery: "queue" }).messageId
      queued = session.sendCommand("deploy", "api prod", { delivery: "queue" }).messageId
      expect(session.projection().inbox.map((item) => item.command?.arguments)).toEqual(["old", "api prod"])
      expect(session.withdraw(withdrawn as never)).toBe(true)
    })
    session.send("Hello.")
    await h.settled()
    expect(h.log().map((item) => item.type)).toEqual([
      "session.created", "inbox.enqueued", "execution.started", "baseline.set", "inbox.delivered", "step.started",
      "inbox.enqueued", "command.expanded", "inbox.enqueued", "command.expanded", "inbox.cancelled",
      "text.ended", "step.ended", "turn.ended", "inbox.delivered", "step.started", "text.ended", "step.ended", "execution.succeeded",
    ])
    const users = session.projection().messages.filter((message) => message.kind === "user")
    expect(users.map((message) => [message.id, message.kind === "user" ? (message.command?.arguments ?? null) : null])).toEqual([[users[0]!.id, null], [queued, "api prod"]])
    expect(users.some((message) => message.id === withdrawn)).toBe(false)
    h.verify()
    await h.dispose()
  })

  test("a command that names an agent switches at once when it is the next thing delivered, and writes nothing when the agent is already in force", async () => {
    const files = project({ review: REVIEW })
    files.write(join(files.cwd, ".claude", "agents", "reviewer.md"), REVIEWER)
    const h = harness(files, { agents: { configDir: files.configDir } })
    h.provider.enqueue(answer("Looks fine."), answer("Still fine."))
    const session = h.create()
    session.sendCommand("review", "the tests")
    await h.settled()
    session.sendCommand("review", "the docs")
    await h.settled()
    // One switch, before the first baseline; the second command finds the reviewer in force.
    expect(of(h, "agent.switched").map((item) => [item.data.messageId, item.data.from, item.data.to?.name])).toEqual([[null, null, "reviewer"]])
    expect(of(h, "command.expanded")).toHaveLength(2)
    expect(h.session.projection().baseline!.sources.at(-1)!.source).toBe("agent")
    expect(h.provider.prefixBreaks()).toEqual([])
    h.verify()
    await h.dispose()
  })
})

describe("where commands are looked for", () => {
  test("`commands.paths` and `commands.disabled` are read from both files", async () => {
    const files = project({ deploy: DEPLOY, legacy: "Old.\n" }, { standup: "Write my standup.\n", retro: "Write the retro.\n" })
    const team = join(files.root, "team")
    const shared = join(files.root, "shared")
    files.write(join(team, "oncall.md"), "Who is on call for $1?\n")
    files.write(join(shared, "triage.md"), "Triage $ARGUMENTS.\n")
    const h = harness(files, { userConfig: { verify: { mode: "off" }, commands: { paths: [team], disabled: ["retro"] } }, config: { commands: { paths: [shared], disabled: ["legacy"] } } })
    const listing = h.create().commands()!
    expect(listing.commands.map((command) => [command.name, command.scope])).toEqual([
      ["deploy", "project"],
      ["oncall", "config"],
      ["standup", "user"],
      ["triage", "config"],
    ])
    expect(refusal(() => h.session.sendCommand("legacy", "")).message).toStartWith("There is no command /legacy.")
    h.provider.enqueue(answer("Nobody."))
    h.session.sendCommand("oncall", "billing")
    await h.settled()
    expect(of(h, "command.expanded")[0]!.data).toMatchObject({ name: "oncall", scope: "config", path: join(team, "oncall.md"), arguments: "billing" })
    await h.dispose()
  })
})
