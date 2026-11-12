/**
 * Agents through the loop, beyond what the scenarios spell out: where the
 * default agent comes from, what a child's restrictions are, what a
 * compaction, a fork and a restart keep, how the approval mode is tightened,
 * and that none of it ever changes the tool list.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineEvent } from "../../src/engine/channel.ts"
import { EngineError } from "../../src/engine/engine.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { SUMMARY, measured } from "../scenarios/script.ts"
import { Harness, type HarnessOptions, converse, removeHarnessDirectories } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]

const REVIEWER = "---\nname: reviewer\ndescription: Reviews a change without editing anything.\neffects: read\n---\nRead the code and report what is wrong.\n"
const DOCS = "---\nname: docs\ndescription: Writes documentation only.\ntools: read, write, subagent\n---\nEdit only files under docs/.\n"
const CAREFUL = "---\nname: careful\ndescription: Asks before everything.\napproval: ask\n---\nBe careful.\n"
const LOOSE = "---\nname: loose\ndescription: Would like no questions.\napproval: full\n---\nGo fast.\n"
const PINNED = "---\nname: pinned\ndescription: Runs on another model.\nmodel: gpt-unlisted\n---\nUse the other model.\n"

/** A real project directory with these agent definitions, and a directory for the user's own. */
function project(agents: Record<string, string> = {}, own: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-agents-")))
  made.push(root)
  const cwd = join(root, "repo")
  const configDir = join(root, "config")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  const write = (name: string, content: string, directory = join(cwd, ".claude", "agents")) => {
    const path = join(directory, `${name}.md`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }
  for (const [name, content] of Object.entries(agents)) write(name, content)
  for (const [name, content] of Object.entries(own)) write(name, content, join(configDir, "agents"))
  return { cwd, configDir, write, remove: (name: string) => rmSync(join(cwd, ".claude", "agents", `${name}.md`), { force: true }) }
}

const harness = (files: ReturnType<typeof project>, options: HarnessOptions = {}) => new Harness({ agents: { configDir: files.configDir }, cwd: files.cwd, ...options })
const switches = (h: Harness) => h.log().filter((item): item is StoredEvent<"agent.switched"> => item.type === "agent.switched")
const denials = (h: Harness) => h.log().filter((item): item is StoredEvent<"approval.denied"> => item.type === "approval.denied")

describe("the agent a session starts as", () => {
  test("the default comes from the user's own configuration; a project's is not followed, and the user is told", async () => {
    const files = project({ reviewer: REVIEWER, docs: DOCS })
    const h = harness(files, { userConfig: { agents: { default: "reviewer" } }, config: { verify: { mode: "off" }, agents: { default: "docs" } } })
    try {
      h.provider.enqueue(answer("Hello."))
      h.create().send("Hi.")
      await h.settled()
      expect(h.session.projection().session.agent?.name).toBe("reviewer")
      expect(switches(h)).toHaveLength(1)
      expect(h.diagnostics.map((item) => `${item.kind}: ${item.message}`)).toEqual(['agents: Not followed: agents.default "docs" in the project\'s configuration (only the user\'s own configuration chooses the default agent).'])
      expect(h.engine.listAgents(files.cwd)).toMatchObject({ default: "reviewer", agents: [{ name: "docs" }, { name: "reviewer" }] })
      // Asking for none overrides the default.
      const plain = h.engine.createSession({ cwd: files.cwd, settings: { model: "gpt-test", reasoningEffort: null }, agent: "none" })
      expect(plain.projection().session.agent).toBeUndefined()
      expect(plain.agent()).toBeNull()
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("what is said while the session is created reaches the first listener, once: a default that was not followed, a tool that does not exist", async () => {
    const files = project({ odd: "---\nname: odd\ndescription: Names a tool that is not there.\ntools: read, Bash\n---\nWork.\n" })
    const h = harness(files, { config: { verify: { mode: "off" }, agents: { default: "odd" } } })
    try {
      // The engine says both inside `createSession`: nobody can be listening yet.
      const session = h.engine.createSession({ cwd: files.cwd, settings: { model: "gpt-test", reasoningEffort: null }, agent: "odd" })
      const expected = [
        'Not followed: agents.default "odd" in the project\'s configuration (only the user\'s own configuration chooses the default agent).',
        `The agent "odd" (${join(files.cwd, ".claude", "agents", "odd.md")}) names a tool that does not exist here, which therefore restricts nothing: Bash.`,
      ]
      const heard = (events: readonly EngineEvent[]) => events.flatMap((item) => (item.type === "diagnostic" ? [`${item.kind}: ${item.message}`] : []))
      const first: EngineEvent[] = []
      const second: EngineEvent[] = []
      session.subscribe((item) => first.push(item))
      session.subscribe((item) => second.push(item))
      expect(heard(first)).toEqual(expected.map((message) => `agents: ${message}`))
      expect(heard(second)).toEqual([])
      // A reader of the stream had them all along, and has them once.
      h.provider.enqueue(answer("Hello."))
      session.send("Hi.")
      await session.settled()
      await session.close()
      const stream: EngineEvent[] = []
      for await (const item of session.events) stream.push(item)
      expect(heard(stream)).toEqual(expected.map((message) => `agents: ${message}`))
      expect(heard(first)).toHaveLength(2)
    } finally {
      await h.dispose()
    }
  })

  test("a project's default alone starts no agent", async () => {
    const files = project({ docs: DOCS })
    const h = harness(files, { config: { verify: { mode: "off" }, agents: { default: "docs" } } })
    try {
      expect(h.create().projection().session.agent).toBeUndefined()
    } finally {
      await h.dispose()
    }
  })

  test("an agent that cannot be found creates nothing, and the message says what there is", async () => {
    const files = project({ reviewer: REVIEWER })
    const h = harness(files, { userConfig: { agents: { default: "reviwer" } } })
    try {
      const before = h.engine.listSessions().length
      const refused = (() => {
        try {
          h.create()
          return null
        } catch (error) {
          return error as EngineError
        }
      })()
      expect(refused).toBeInstanceOf(EngineError)
      expect(refused!.code).toBe("invalid_request")
      expect(refused!.message).toBe('There is no agent named "reviwer". Did you mean "reviewer"? Agents: reviewer. (It is the default agent, agents.default; change that, or start with the agent "none".)')
      expect(() => h.create(undefined, "nobody")).toThrow('There is no agent named "nobody". Agents: reviewer.')
      expect(h.engine.listSessions()).toHaveLength(before)
    } finally {
      await h.dispose()
    }
  })

  test("an agent whose model the provider does not offer creates nothing; its model and effort are the session's settings from the first event", async () => {
    const files = project({ pinned: PINNED, captain: "---\nname: captain\ndescription: Releases.\nmodel: gpt-other\neffort: high\n---\nRelease.\n" })
    const h = harness(files, { models: [{ id: "gpt-test", efforts: ["low", "medium"] }, { id: "gpt-other", efforts: ["low", "high"] }] })
    try {
      // The listing is known once settings were validated, as a client does before it creates a session.
      await h.engine.validateSettings({ model: "gpt-test", reasoningEffort: "medium" })
      expect(() => h.create(undefined, "pinned")).toThrow('The agent "pinned" asks for the model "gpt-unlisted", which is not offered (gpt-test, gpt-other); "gpt-test" is used.')
      const session = h.create(undefined, "captain")
      expect(session.projection().session.settings).toEqual({ model: "gpt-other", reasoningEffort: "high" })
      expect(h.log()[0]).toMatchObject({ type: "session.created", data: { settings: { model: "gpt-other", reasoningEffort: "high" } } })
      expect(h.log()[1]).toMatchObject({ type: "agent.switched", data: { messageId: null, from: null, to: { name: "captain", model: "gpt-other", effort: "high" } } })
    } finally {
      await h.dispose()
    }
  })

  test("before the first baseline a switch is recorded at once and no message is needed", async () => {
    const files = project({ reviewer: REVIEWER, docs: DOCS })
    const h = harness(files)
    try {
      h.create(undefined, "reviewer")
      h.session.setAgent("docs")
      expect(switches(h).map((item) => [item.data.messageId, item.data.from, item.data.to?.name])).toEqual([[null, null, "reviewer"], [null, "reviewer", "docs"]])
      h.provider.enqueue(answer("Hello."))
      h.session.send("Hi.")
      await h.settled()
      expect(h.provider.requests[0]!.instructions).toContain('You are working as the agent "docs"')
      expect(h.provider.requests[0]!.instructions).not.toContain("reviewer")
      expect(h.log().filter((item) => item.type === "instruction.appended")).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("a switch made while the session is idle", () => {
  test("is recorded when it is made, so a process that dies right after has not lost it", async () => {
    const files = project({ reviewer: REVIEWER })
    const h = harness(files)
    try {
      h.provider.enqueue(answer("Hello."), [call("write", { path: "a.ts", content: "x" }), U], answer("As the reviewer I may not."))
      h.create().send("Hi.")
      await h.settled()
      const before = h.log().length
      h.session.setAgent("reviewer")
      // Durable at once: the message that tells the model and the record, with no execution around them.
      expect(h.log().slice(before).map((item) => item.type)).toEqual(["instruction.appended", "agent.switched"])
      expect(h.session.projection().session.execution).toBeNull()
      // The process dies before the next prompt. The next one reads the switch from the log.
      h.kill()
      const reopened = h.restart()
      expect(reopened.agent()?.name).toBe("reviewer")
      expect(reopened.projection().session.agent?.name).toBe("reviewer")
      reopened.send("Change a.ts.")
      await h.settled()
      // The turn ran as the reviewer, was told so by the message already in history, and nothing was announced twice.
      expect(denials(h).map((item) => item.data.agent)).toEqual(["reviewer"])
      expect(switches(h)).toHaveLength(1)
      expect(h.log().filter((item) => item.type === "instruction.appended" && item.data.source === "agent")).toHaveLength(1)
      // The request after the switch is the one before it plus the message and the prompt: the cached prefix is kept.
      expect(h.provider.prefixBreaks()).toEqual([])
      expect(JSON.stringify(h.provider.requests[1]!.input)).toContain("The user switched you to the agent")
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("with another model it changes the settings in the same breath; switched off again it says so in one line", async () => {
    const files = project({ pinned: PINNED.replace("gpt-unlisted", "gpt-other") })
    const h = harness(files)
    try {
      h.provider.enqueue(answer("Hello."))
      h.create().send("Hi.")
      await h.settled()
      const before = h.log().length
      h.session.setAgent("pinned")
      expect(h.log().slice(before).map((item) => item.type)).toEqual(["instruction.appended", "agent.switched", "settings.changed"])
      expect(h.session.projection().session.settings.model).toBe("gpt-other")
      h.session.setAgent("none")
      expect(h.log().slice(before + 3).map((item) => item.type)).toEqual(["instruction.appended", "agent.switched"])
      expect(h.session.projection().session.agent ?? null).toBeNull()
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("while a step runs it waits for the boundary, as before", async () => {
    const files = project({ reviewer: REVIEWER })
    const h = harness(files)
    try {
      h.provider.enqueue([call("read", { path: "a.ts" }), U], answer("Read it."))
      h.tools.on("read", () => {
        // Asked for in the middle of the step: nothing may be appended inside it.
        h.session.setAgent("reviewer")
        return "x"
      })
      h.create().send("Read a.ts.")
      await h.settled()
      const types = h.log().map((item) => item.type)
      expect(types.indexOf("agent.switched")).toBeGreaterThan(types.indexOf("step.ended"))
      expect(types.indexOf("agent.switched")).toBeLessThan(types.lastIndexOf("step.started"))
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("what an agent's session keeps", () => {
  test("after a compaction the new baseline carries the agent from the record, not the file; a restart and a fork keep it", async () => {
    const files = project({ reviewer: REVIEWER })
    const h = harness(files, { contextWindow: 10_000 })
    try {
      const at = (tokens: number) => script.usage(measured(tokens))
      h.provider.enqueue([script.text("First answer."), at(4900)], [script.text(SUMMARY)], [script.text("Second answer."), at(1200)], [call("write", { path: "a.ts", content: "x" }), U], answer("Refused."))
      h.create(undefined, "reviewer").send("One.")
      await h.settled()
      const record = h.session.projection().session.agent!
      // The file is edited and then removed: the session runs as what it selected.
      files.write("reviewer", REVIEWER.replace("effects: read", "effects: read, write"))
      files.remove("reviewer")
      h.session.send("Two.")
      await h.settled()
      const baselines = h.log().filter((item): item is StoredEvent<"baseline.set"> => item.type === "baseline.set")
      expect(baselines).toHaveLength(2)
      for (const item of baselines) {
        expect(item.data.sources.at(-1)).toEqual({ source: "agent", fingerprint: fingerprintOf(record.instructions) })
        expect(item.data.instructions).toContain(record.instructions)
        expect(item.data.tools).toEqual(baselines[0]!.data.tools)
      }
      // No message about the agent was ever appended: the instruction state follows the baseline's fingerprint.
      expect(h.log().filter((item) => item.type === "instruction.appended" && item.data.source === "agent")).toEqual([])

      // A restart: the record is state folded from the log, and the restriction still holds.
      h.kill()
      h.restart()
      expect(h.session.projection().session.agent).toEqual(record)
      h.session.send("Three: write it.")
      await h.settled()
      expect(denials(h).at(-1)!.data).toMatchObject({ reason: "policy", agent: "reviewer", stop: false })
      expect(h.tools.ran).toEqual([])

      // A fork inherits the agent with the history.
      const fork = await h.engine.forkSession(h.session.id)
      expect(fork.projection().session.agent).toEqual(record)
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

describe("a subagent's restrictions", () => {
  test("are its agent's combined with its parent's, and a child without an agent runs as its parent's", async () => {
    const files = project({ reviewer: REVIEWER, docs: DOCS })
    const h = harness(files, { spawn: {} })
    try {
      converse(h.provider, {
        "Delegate": [
          [call("subagent", { task: "Review as the reviewer", agent: "reviewer" }), U],
          [call("subagent", { task: "Carry on as I do" }), U],
          [call("subagent", { task: "Unknown", agent: "reviwer" }), U],
          [call("shell", { command: "ls" }), U],
          answer("Done."),
        ],
        "Review as the reviewer": [[call("write", { path: "a.ts", content: "x" }), U], [call("read", { path: "a.ts" }), U], answer("Reviewed.")],
        "Carry on as I do": [[call("shell", { command: "ls" }), U], [call("write", { path: "docs/a.md", content: "x" }), U], answer("Written.")],
      })
      h.tools.on("read", "export const a = 1")
      h.tools.on("write", "Wrote docs/a.md")
      h.create(undefined, "docs").send("Delegate.")
      await h.settled()
      const parent = h.session.projection()
      const [first, second] = parent.session.spawned!.children
      expect(parent.session.spawned!.children).toHaveLength(2)
      const reviewer = h.store.getProjection(first!)!
      // The reviewer's effects and the parent's tool list, both: the stricter of each.
      expect(reviewer.session.agent).toMatchObject({ name: "reviewer", restrictions: { effects: ["read"], tools: ["read", "write", "subagent"], deniedTools: [], approval: null } })
      expect(reviewer.session.agent!.instructions).toContain("Only tools that read (effects: read). Only these tools: read, write, subagent.")
      const refusedIn = (id: string) => h.store.readEvents(id as never).flatMap((item) => (item.type === "tool.settled" && item.data.outcome === "error" ? [item.data.output] : []))
      expect(refusedIn(first!)).toEqual([expect.stringContaining('which may use only tools that read. "write" changes files.')])
      // Without `agent` the child runs as its parent's agent: the same record, the same refusals.
      const inherited = h.store.getProjection(second!)!
      expect(inherited.session.agent).toEqual(parent.session.agent!)
      expect(refusedIn(second!)).toEqual([expect.stringContaining('which may use only these tools: read, write, subagent. "shell" is not one of them.')])
      // A name that does not exist starts nothing and says what there is; the parent's own shell call is refused too.
      const results = parent.messages.flatMap((message) => (message.kind === "assistant" ? message.parts.flatMap((part) => (part.type === "tool_call" && part.state.status === "settled" ? [part.state.output] : [])) : []))
      expect(results[2]).toBe('The subagent was not started: There is no agent named "reviwer". Did you mean "reviewer"? Agents: docs, reviewer.')
      expect(results[3]).toContain('which may use only these tools: read, write, subagent. "shell" is not one of them.')
      expect(h.tools.ran.map((entry) => entry.name)).toEqual(["read", "write"])
      // What the parent's log says about the two children.
      const started = h.log().filter((item): item is StoredEvent<"spawn.started"> => item.type === "spawn.started")
      expect(started.map((item) => (item.data.work.kind === "subagent" ? item.data.work.agent : null))).toEqual(["reviewer", "docs"])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a follow-up cannot change the agent", async () => {
    const files = project({ reviewer: REVIEWER })
    const h = harness(files, { spawn: {} })
    try {
      converse(h.provider, {
        "Delegate": [[call("subagent", { task: "Look at a" }), U], answer("Started.")],
        "Look at a": [answer("Looked.")],
      })
      h.create().send("Delegate.")
      await h.settled()
      const child = h.session.projection().session.spawned!.children[0]!
      h.provider.enqueue([call("subagent", { task: "Again", session: child, agent: "reviewer" }), U], answer("Could not."))
      h.session.send("Follow up as the reviewer.")
      await h.settled()
      const last = h.session.projection().messages.findLast((message) => message.kind === "assistant" && message.parts.some((part) => part.type === "tool_call"))
      expect(JSON.stringify(last)).toContain("a subagent keeps the agent it started as")
    } finally {
      await h.dispose()
    }
  })
})

describe("the list of agents", () => {
  test("follows the files, is given only to a session that can run a subagent, and never changes the prefix", async () => {
    const files = project({ reviewer: REVIEWER })
    const h = harness(files, { spawn: {} })
    try {
      h.provider.enqueue(answer("One."), answer("Two."), answer("Three."))
      h.create().send("First.")
      await h.settled()
      files.write("docs", DOCS)
      h.session.send("Second.")
      await h.settled()
      files.remove("docs")
      files.remove("reviewer")
      h.session.send("Third.")
      await h.settled()
      const index = h.log().filter((item): item is StoredEvent<"instruction.appended"> => item.type === "instruction.appended" && item.data.source === "agent-index")
      expect(index.map((item) => item.data.text.split("\n")[0])).toEqual([
        "Agents you can run a subagent as:",
        "The agents have changed. This list replaces the one you were given before:",
        "There are no agents any more. Disregard the list of agents you were given before; a subagent can no longer be given `agent`.",
      ])
      expect(index.map((item) => item.data.detail)).toEqual([
        { kind: "agents", agents: [{ name: "reviewer", path: join(files.cwd, ".claude", "agents", "reviewer.md") }] },
        { kind: "agents", agents: [{ name: "docs", path: join(files.cwd, ".claude", "agents", "docs.md") }, { name: "reviewer", path: join(files.cwd, ".claude", "agents", "reviewer.md") }] },
        { kind: "agents", agents: [] },
      ])
      expect(index.at(-1)!.data.fingerprint).toBeNull()
      expect(h.provider.prefixBreaks()).toEqual([])
      for (const request of h.provider.requests) expect(request.tools).toEqual(h.provider.requests[0]!.tools)
      h.verify()
    } finally {
      await h.dispose()
    }

    // Without the `subagent` tool there is nobody to run as an agent, and nothing is said.
    const quiet = harness(files)
    try {
      files.write("reviewer", REVIEWER)
      quiet.provider.enqueue(answer("One."))
      quiet.create().send("First.")
      await quiet.settled()
      expect(quiet.log().filter((item) => item.type === "instruction.appended")).toEqual([])
    } finally {
      await quiet.dispose()
    }
  })

  test("a definition that cannot be used is the user's to read, never the model's", async () => {
    const files = project({ reviewer: REVIEWER, broken: "no front matter here\n" })
    const h = harness(files, { spawn: {} })
    try {
      h.provider.enqueue(answer("One."))
      h.create().send("First.")
      await h.settled()
      expect(JSON.stringify(h.provider.requests[0]!.input)).not.toContain("broken")
      expect(h.diagnostics.map((item) => item.kind)).toEqual(["agents"])
      expect(h.diagnostics[0]!.message).toStartWith(`The agent definition at ${join(files.cwd, ".claude", "agents", "broken.md")} was not loaded:`)
      expect(h.session.agents()!.problems).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })
})

describe("an agent and the approval mode", () => {
  const approval = { sandbox: { state: { available: true as const }, temp: () => ({ dir: "/tmp/x", alias: null }), plan: () => ({ kind: "unavailable" as const, reason: "test" }), policy: () => null } as never, secrets: [], home: "/home/test", user: { mode: "auto" as const } }

  test("an agent tightens the mode and never loosens it, whoever wrote the definition", async () => {
    const files = project({ careful: CAREFUL }, { loose: LOOSE })
    const h = harness(files, { approval })
    try {
      const careful = h.create(undefined, "careful")
      expect(careful.approval()!.policy.mode).toBe("ask")
      const loose = h.engine.createSession({ cwd: files.cwd, settings: { model: "gpt-test", reasoningEffort: null }, agent: "loose" })
      expect(loose.approval()!.policy.mode).toBe("auto")
      expect(h.diagnostics.map((item) => item.message)).toContain('The agent "loose" asks for approval mode "full"; the user\'s mode "auto" is kept, since an agent can only tighten it.')
      // Switched off, the user's own mode is back.
      careful.setAgent("none")
      expect(careful.approval()!.policy.mode).toBe("auto")
    } finally {
      await h.dispose()
    }
  })
})
