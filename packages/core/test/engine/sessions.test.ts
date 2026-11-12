/**
 * The engine on the real assembly (`createHarness`): a store per session in
 * a data directory, the real tools and the real snapshot module in temporary
 * workspaces, and a scripted model. What a client of the engine can do with
 * sessions besides prompting: close one and keep the rest, list, read a
 * stored log, withdraw, archive; and what several sessions share.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Harness, TEST_CONTEXT_WINDOW_ENV, createHarness, testContextWindow } from "../../src/assembly.ts"
import { parseConfigFile, resolveConfig } from "../../src/config/schema.ts"
import { estimateRequest } from "../../src/context/estimate.ts"
import { EngineError, type EngineSession, type RevertResult } from "../../src/engine/engine.ts"
import type { EngineEvent } from "../../src/engine/channel.ts"
import { neededSnapshots } from "../../src/engine/workspace.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { openSnapshots } from "../../src/snapshot/index.ts"
import { SessionInUseError, openSessionDirectory } from "../../src/store/directory.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../src/testing/fake-provider.ts"
import type { AnyTool } from "../../src/tool/tool.ts"
import { createStandardTools } from "../../src/tools/index.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"

const scratch: string[] = []
const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

const SETTINGS = { model: "gpt-test", reasoningEffort: null }
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const write = (path: string, content: string): ScriptedResponse => [call("write", { path, content })]
const say = (value: string): ScriptedResponse => [script.text(value)]

function place() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-sessions-")))
  scratch.push(root)
  const workspace = (name: string, files: Record<string, string> = { "notes.md": "# Notes\n" }) => {
    const directory = join(root, name)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true })
      writeFileSync(join(directory, path), content)
    }
    return directory
  }
  return { root, data: join(root, "data"), workspace }
}

interface Started {
  readonly harness: Harness
  readonly provider: FakeProvider
  /** What the engine wrote to its log (standard error, in a real process). */
  readonly logged: string[]
}

function start(data: string, responses: readonly ScriptedResponse[], more: Parameters<typeof createHarness>[0] = {}): Started {
  const provider = new FakeProvider([...responses])
  const logged: string[] = []
  const harness = createHarness({
    dataDir: data,
    provider,
    log: (line) => logged.push(line),
    ...more,
    engine: { loadConfig: null, discover: () => [], ...more.engine },
  })
  open.push(harness)
  return { harness, provider, logged }
}

/** Collects everything a session publishes. */
function watch(session: EngineSession) {
  const events: EngineEvent[] = []
  session.subscribe((item) => events.push(item))
  const seen = async (predicate: (item: EngineEvent) => boolean) => {
    for (let waited = 0; !events.some(predicate); waited += 5) {
      if (waited > 15_000) throw new Error("timed out waiting for an event")
      await Bun.sleep(5)
    }
  }
  return { events, seen }
}

const durable = (events: readonly EngineEvent[]) => events.filter((item): item is StoredEvent => "seq" in item)
const typesOf = (events: readonly StoredEvent[]) => events.map((item) => item.type)

describe("closing a session", () => {
  test("stops that session only: the engine and its other sessions work on, and anyone can open the closed one", async () => {
    const { data, workspace } = place()
    const { harness } = start(data, [[call("shell", { command: "sleep 30" })], say("Quick answer."), say("Back again."), say("And once more.")])
    const engine = harness.engine
    const slow = engine.createSession({ cwd: workspace("a"), settings: SETTINGS })
    const slowEvents = watch(slow)
    slow.send("Run something slow.")
    await slowEvents.seen((item) => item.type === "tool.started")

    const quick = engine.createSession({ cwd: workspace("b"), settings: SETTINGS })
    quick.send("Something quick.")
    await quick.settled()
    expect(quick.projection().session.execution).toBeNull()

    // Its event stream ends with the close, and with it only.
    const streamed = (async () => {
      let count = 0
      for await (const _ of slow.events) count += 1
      return count
    })()
    await slow.close()
    expect(await streamed).toBeGreaterThan(0)
    expect(() => slow.send("no")).toThrow(EngineError)
    // The work stopped as a shutdown and stays resumable.
    expect(engine.getSession(slow.id)!.session.execution).toMatchObject({ status: "suspended" })
    expect(typesOf(engine.readEvents(slow.id)).slice(-2)).toEqual(["synthetic.appended", "execution.interrupted"])

    // The engine is open, the other session works, and both are listed.
    quick.send("Once more.")
    await quick.settled()
    expect(typesOf(quick.readEvents()).filter((type) => type === "execution.succeeded")).toHaveLength(2)
    expect(engine.listSessions().map((summary) => summary.session.id).sort()).toEqual([slow.id, quick.id].sort())

    // The closed session was let go of: another process (here another directory on the same data) can hold it.
    const elsewhere = openSessionDirectory({ dataDir: data, notice: () => {} })
    elsewhere.open(slow.id).close()
    expect(() => elsewhere.open(quick.id)).toThrow(SessionInUseError)
    elsewhere.close()

    // And this engine can open it again: the suspended turn is taken up.
    const again = engine.openSession(slow.id)
    await again.settled()
    expect(again).not.toBe(slow)
    expect(typesOf(again.readEvents()).slice(-3)).toEqual(["text.ended", "step.ended", "execution.succeeded"])
    const store = harness.sessions.read(slow.id, (reader) => reader.readRequests(slow.id))
    // The ledger is the session's own: its three model calls, in its own file.
    expect(store.map((row) => row.outcome)).toEqual(["ok", "ok"])
  }, 60_000)

  test("closing the engine closes every session and lets go of all of them", async () => {
    const { data, workspace } = place()
    const { harness } = start(data, [say("One."), say("Two.")])
    const a = harness.engine.createSession({ cwd: workspace("a"), settings: SETTINGS })
    const b = harness.engine.createSession({ cwd: workspace("b"), settings: SETTINGS })
    a.send("One?")
    b.send("Two?")
    await Promise.all([a.settled(), b.settled()])
    await harness.close()
    expect(harness.closed).toBe(true)
    expect(() => harness.engine).toThrow()
    const elsewhere = openSessionDirectory({ dataDir: data, notice: () => {} })
    for (const id of [a.id, b.id]) {
      const store = elsewhere.open(id)
      expectRebuildEqualsLive(store, id)
      store.close()
    }
    elsewhere.close()
  })
})

describe("listing and reading", () => {
  test("list by directory, find the latest, resolve a prefix and read any session's log, without opening or closing anything", async () => {
    const { data, workspace } = place()
    const { harness } = start(data, [say("One."), say("Two."), say("Three.")], { engine: { ids: { session: counter("ses_ab", "ses_ac", "ses_b") } } })
    const engine = harness.engine
    const here = workspace("here")
    const there = workspace("there")
    const first = engine.createSession({ cwd: here, settings: SETTINGS, title: "first" })
    first.send("One?")
    await first.settled()
    const second = engine.createSession({ cwd: here, settings: SETTINGS })
    second.send("Two?")
    await second.settled()
    const third = engine.createSession({ cwd: there, settings: { model: "gpt-other", reasoningEffort: "low" } })

    expect(engine.listSessions({ cwd: here }).map((summary) => summary.session.id)).toEqual([second.id, first.id])
    expect(engine.latestSession(here)!.session.id).toBe(second.id)
    expect(engine.latestSession(there)!.session).toMatchObject({ id: third.id, settings: { model: "gpt-other", reasoningEffort: "low" } })
    expect(engine.latestSession("/nowhere")).toBeNull()
    expect(engine.listSessions().map((summary) => summary.session.id).sort()).toEqual([first.id, second.id, third.id].sort())
    expect(engine.getSession(first.id)!.session.title).toBe("first")
    expect(engine.getSession("ses_none" as SessionId)).toBeNull()

    expect(engine.resolveSession("ses_b")).toBe(third.id)
    expect(engine.resolveSession("ses_ab")).toBe(first.id)
    expect(() => engine.resolveSession("ses_a")).toThrow(/2 sessions start with ses_a/)
    expect(codeOf(() => engine.resolveSession("ses_a"))).toBe("ambiguous_session")
    expect(codeOf(() => engine.resolveSession("ses_zzz"))).toBe("session_not_found")

    // The stored log, of an open session and of a closed one, is the same from the session and from the engine.
    expect(engine.readEvents(first.id)).toEqual([...first.readEvents()])
    expect(first.readEvents({ afterSeq: 2, limit: 2 }).map((item) => item.seq)).toEqual([3, 4])
    await second.close()
    expect(typesOf(engine.readEvents(second.id)).at(-1)).toBe("execution.succeeded")
    expect(codeOf(() => engine.readEvents("ses_none" as SessionId))).toBe("session_not_found")

    // None of that closed the engine or a session: the first one still takes a prompt.
    first.send("Three?")
    await first.settled()
    expect(engine.latestSession(here)!.session.id).toBe(first.id)
  })

  test("a session another engine holds is refused with who holds it, and can still be read and listed", async () => {
    const { data, workspace } = place()
    const one = start(data, [say("One.")])
    const session = one.harness.engine.createSession({ cwd: workspace("a"), settings: SETTINGS })
    session.send("One?")
    await session.settled()
    // As a second process would be: its own harness on the same data directory.
    const two = start(data, [say("Two.")])
    const refused = (() => {
      try {
        return two.harness.engine.openSession(session.id)
      } catch (error) {
        return error
      }
    })()
    expect(refused).toBeInstanceOf(EngineError)
    expect(refused).toMatchObject({ code: "session_in_use", holderPid: process.pid })
    expect((refused as Error).message).toContain(`session ${session.id} is in use`)
    await expect(two.harness.engine.archiveSession(session.id)).rejects.toMatchObject({ code: "session_in_use" })
    expect(two.harness.engine.listSessions().map((summary) => summary.session.id)).toEqual([session.id])
    expect(two.harness.engine.readEvents(session.id)).toEqual([...session.readEvents()])
    expect(codeOf(() => two.harness.engine.openSession("ses_none" as SessionId))).toBe("session_not_found")

    // Once the first lets go, the second works in it.
    await session.close()
    const taken = two.harness.engine.openSession(session.id)
    taken.send("Two?")
    await taken.settled()
    expect(codeOf(() => one.harness.engine.openSession(session.id))).toBe("session_in_use")
    expect(typesOf(one.harness.engine.readEvents(session.id)).filter((type) => type === "execution.succeeded")).toHaveLength(2)
  })
})

describe("withdrawing and archiving", () => {
  test("a prompt that waits is withdrawn through the log; one that was delivered is not", async () => {
    const { data, workspace } = place()
    const { harness, provider } = start(data, [[call("shell", { command: "sleep 0.3" })], say("Done.")])
    const session = harness.engine.createSession({ cwd: workspace("a"), settings: SETTINGS })
    const { events, seen } = watch(session)
    const first = session.send("Run it.")
    await seen((item) => item.type === "tool.started")
    const steer = session.send("Also this.")
    const queued = session.queue("And this later.")
    expect(session.projection().inbox.map((item) => item.messageId)).toEqual([steer, queued])
    expect(session.withdraw(steer)).toBe(true)
    expect(session.withdraw(steer)).toBe(false)
    expect(session.withdraw(first)).toBe(false)
    expect(session.withdraw(queued)).toBe(true)
    await session.settled()
    expect(typesOf(durable(events)).filter((type) => type === "inbox.cancelled")).toHaveLength(2)
    expect(typesOf(durable(events)).filter((type) => type === "inbox.delivered")).toHaveLength(1)
    expect(JSON.stringify(provider.requests)).not.toContain("Also this.")
    expect(JSON.stringify(provider.requests)).not.toContain("And this later.")
    expect(session.projection().session.execution).toBeNull()
  })

  test("archive and unarchive go through the log, close the session here first, and are refused for nothing", async () => {
    const { data, workspace } = place()
    const { harness } = start(data, [say("One."), say("Two.")])
    const engine = harness.engine
    const cwd = workspace("a")
    const session = engine.createSession({ cwd, settings: SETTINGS })
    session.send("One?")
    await session.settled()
    await engine.archiveSession(session.id)
    expect(() => session.send("closed")).toThrow(EngineError)
    expect(engine.listSessions()).toEqual([])
    expect(engine.listSessions({ includeArchived: true }).map((summary) => summary.session.archived)).toEqual([true])
    expect(engine.latestSession(cwd)).toBeNull()
    // Twice is once; and an unknown session is an error, not a new file.
    await engine.archiveSession(session.id)
    expect(typesOf(engine.readEvents(session.id)).filter((type) => type === "session.archived")).toHaveLength(1)
    await expect(engine.archiveSession("ses_none" as SessionId)).rejects.toMatchObject({ code: "session_not_found" })

    await engine.unarchiveSession(session.id)
    await engine.unarchiveSession(session.id)
    expect(typesOf(engine.readEvents(session.id)).slice(-2)).toEqual(["session.archived", "session.unarchived"])
    const again = engine.openSession(session.id)
    again.send("Two?")
    await again.settled()
    expect(engine.listSessions().map((summary) => summary.session.id)).toEqual([session.id])
    harness.sessions.read(session.id, (store) => expect(store.getSession(session.id)!.session.archived).toBe(false))
  })
})

describe("what the engine says about a step", () => {
  test("a step interrupted in the model call keeps the usage the provider had reported", async () => {
    const { data, workspace } = place()
    const usage = { inputTokens: 900, cachedInputTokens: 512, outputTokens: 12, reasoningTokens: 4 }
    const { harness } = start(data, [[script.text("Half an answer", { partial: true }), script.usage(usage), script.hang()], [script.text("Nothing reported", { partial: true }), script.hang()]])
    const session = harness.engine.createSession({ cwd: workspace("a"), settings: SETTINGS })
    const { events, seen } = watch(session)
    session.send("Go.")
    await seen((item) => item.type === "text.delta" && events.filter((other) => other.type === "text.delta").map((other) => (other as { text: string }).text).join("") === "Half an answer")
    // The usage event follows the text; give it the turn of the event loop it needs.
    await Bun.sleep(20)
    session.interrupt()
    await session.settled()
    const failed = durable(events).find((item): item is StoredEvent<"step.failed"> => item.type === "step.failed")!
    expect(failed.data).toMatchObject({ error: { kind: "interrupted", reason: "user" }, usage })
    // The ledger has it too, and a step whose provider reported nothing still says nothing.
    harness.sessions.read(session.id, (store) => expect(store.readRequests(session.id).map((row) => [row.outcome, row.usage])).toEqual([["aborted", usage]]))
    session.send("Again.")
    await seen((item) => item.type === "text.delta" && (item as { text: string }).text.includes("reported"))
    session.interrupt()
    await session.settled()
    expect(durable(events).filter((item): item is StoredEvent<"step.failed"> => item.type === "step.failed").map((item) => item.data.usage)).toEqual([usage, null])
  })

  test("a diagnostic about an open session is an event of its stream, and is not also a line of the log", async () => {
    const { data, workspace } = place()
    const boom: AnyTool = {
      name: "boom",
      description: "Throws.",
      inputSchema: { type: "object" },
      effect: "read",
      execute: async () => {
        throw new Error("the tool has a bug")
      },
    } as unknown as AnyTool
    const { harness, logged } = start(data, [[call("boom", {})], say("It failed.")], { tools: [...createStandardTools({ spillDir: join(data, "spill") }), boom] })
    const session = harness.engine.createSession({ cwd: workspace("a"), settings: SETTINGS })
    const { events } = watch(session)
    session.send("Go.")
    await session.settled()
    const diagnostics = events.filter((item) => item.type === "diagnostic")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ kind: "tool_crashed", message: "the tool has a bug" })
    expect(logged.filter((line) => line.includes("tool_crashed"))).toEqual([])
  })
})

describe("instruction files in directories the agent starts working in", () => {
  test("are found at the next step boundary and appended once; the baseline is never rewritten", async () => {
    const { data, workspace } = place()
    const repo = workspace("repo", {
      "AGENTS.md": "Root rule: use bun.\n",
      "packages/api/AGENTS.md": "API rule: handlers return status codes.\n",
      "packages/api/handler.ts": "export const handler = () => 200\n",
      "packages/web/AGENTS.md": "Web rule: no inline styles.\n",
      "packages/web/page.ts": "export const page = 1\n",
    })
    mkdirSync(join(repo, ".git"))
    // The default discovery: the real files, read from the real directories.
    const { harness, provider } = start(data, [[call("read", { path: "packages/api/handler.ts" })], say("It returns 200."), [call("ls", { path: "packages/api" })], [call("write", { path: "packages/web/new.ts", content: "export {}\n" })], say("Done.")], {
      engine: { discover: undefined, snapshots: null },
    })
    const session = harness.engine.createSession({ cwd: repo, settings: SETTINGS })
    session.send("What does the handler return?")
    await session.settled()
    const api = `agents:${join(repo, "packages/api/AGENTS.md")}`
    const web = `agents:${join(repo, "packages/web/AGENTS.md")}`
    const appended = () => session.readEvents().filter((item): item is StoredEvent<"instruction.appended"> => item.type === "instruction.appended").map((item) => item.data.source)
    expect(appended()).toEqual([api])
    // Right at the boundary after the step that read there, before the next step.
    const order = typesOf(session.readEvents())
    expect(order.slice(order.indexOf("step.ended"), order.indexOf("step.ended") + 3)).toEqual(["step.ended", "instruction.appended", "step.started"])
    // The baseline has the root file and not the nested one, and is the same bytes in every request.
    expect(provider.requests[0]!.instructions).toContain("Root rule: use bun.")
    expect(provider.requests[0]!.instructions).not.toContain("API rule")
    expect(provider.requests[1]!.instructions).toBe(provider.requests[0]!.instructions)
    expect(JSON.stringify(provider.requests[1]!.input)).toContain("API rule: handlers return status codes.")
    expect(JSON.stringify(provider.requests[1]!.input)).not.toContain("Web rule")
    expect(provider.prefixBreaks()).toEqual([])

    // Working there again appends nothing; a new directory brings its own file, once.
    session.send("List that directory, then add a file to web.")
    await session.settled()
    expect(appended()).toEqual([api, web])
    expect(session.readEvents().filter((item) => item.type === "baseline.set")).toHaveLength(1)
    expect(provider.prefixBreaks()).toEqual([])
    expect(new Set(provider.requests.map((request) => request.instructions)).size).toBe(1)

    // After a restart the directories are read off the log again: nothing is appended twice.
    await session.close()
    const reopened = harness.engine.openSession(session.id)
    expect(reopened.readEvents().filter((item) => item.type === "instruction.appended")).toHaveLength(2)
  })
})

describe("checks whose last pass still stands", () => {
  test("a check that names what it depends on is not run again while those files are what they were", async () => {
    const { root, data, workspace } = place()
    const project = workspace("project", { "src/a.txt": "start\n", "docs/readme.md": "start\n" })
    const runs = join(root, "runs.log")
    const config = resolveConfig({
      checks: [
        { name: "test", command: `echo test >> ${runs}; grep -q fixed src/a.txt`, when: ["src/**"] },
        { name: "docs", command: `echo docs >> ${runs}; test -s docs/readme.md`, when: ["docs/**"] },
        { name: "all", command: `echo all >> ${runs}; true` },
      ],
    })
    const { harness } = start(
      data,
      [
        [call("write", { path: "src/a.txt", content: "broken\n" }, "call_1"), call("write", { path: "docs/readme.md", content: "Documented.\n" }, "call_2")],
        say("Done."),
        write("src/a.txt", "fixed\n"),
        say("Fixed."),
        write("docs/readme.md", "Documented better.\n"),
        say("Improved."),
      ],
      { engine: { loadConfig: async () => ({ config, projectDir: project }) } },
    )
    const session = harness.engine.createSession({ cwd: project, settings: SETTINGS })
    session.send("Change both.")
    await session.settled()
    const events = session.readEvents()
    const started = events.filter((item): item is StoredEvent<"checks.started"> => item.type === "checks.started")
    const finished = events.filter((item): item is StoredEvent<"checks.finished"> => item.type === "checks.finished")
    // Run 1: everything. Run 2: `docs` still stands; `test` failed and `all` names no dependencies, so both run.
    expect(started.map((item) => item.data.checks)).toEqual([["test", "docs", "all"], ["test", "all"]])
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["test", "docs", "all", "test", "all"])
    expect(finished[0]!.data.evidence.checks.map((check) => [check.name, check.status, check.reusedFromSeq])).toEqual([
      ["test", "failed", null],
      ["docs", "passed", null],
      ["all", "passed", null],
    ])
    // The carried result says where it comes from, and keeps the configuration's order.
    expect(finished[1]!.data.evidence.checks.map((check) => [check.name, check.status, check.reusedFromSeq])).toEqual([
      ["test", "passed", null],
      ["docs", "passed", finished[0]!.seq],
      ["all", "passed", null],
    ])
    expect(finished[1]!.data.evidence.checks[1]!.fingerprint).toBe(finished[0]!.data.evidence.checks[1]!.fingerprint)
    const end = events.at(-1) as StoredEvent<"execution.succeeded">
    expect(end.data.verification).toMatchObject({ status: "passed", evidence: { run: 2 } })

    // Later the file `docs` depends on changes: it runs, and nothing else is selected.
    session.send("Improve the docs.")
    await session.settled()
    const later = session.readEvents().filter((item): item is StoredEvent<"checks.started"> => item.type === "checks.started")
    expect(later.at(-1)!.data.checks).toEqual(["docs", "all"])
    await session.close()
    const store = harness.sessions.open(session.id)
    expectRebuildEqualsLive(store, session.id)
    store.close()
  }, 60_000)
})

describe("snapshot retention", () => {
  /** Three turns in one workspace, each of two write steps, so that every turn leaves snapshots only it needs. */
  async function threeTurns(limits: Record<string, number> = {}) {
    const { data, workspace } = place()
    const directory = workspace("project")
    const responses = [1, 2, 3].flatMap((turn) => [write(`step-a.txt`, `turn ${turn} a\n`), write(`step-b.txt`, `turn ${turn} b\n`), say(`Turn ${turn} done.`)])
    const started = start(data, responses, { engine: { limits } })
    const session = started.harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    for (const turn of [1, 2, 3]) {
      session.send(`Turn ${turn}.`)
      await session.settled()
    }
    const snapshots = await openSnapshots(directory, { dataDir: join(data, "snapshots") })
    if (snapshots.kind !== "ready") throw new Error("no snapshots")
    const refs = async (id: SessionId = session.id) => (await snapshots.list({ session: id })).map((ref) => ref.id as string)
    const engine = started.harness.engine
    /** Every snapshot the session's log names, and the ones a revert or undo of it could still need: read off the stored session, open or not. */
    const recorded = () => engine.readEvents(session.id).flatMap((item) => (item.type === "snapshot.taken" ? [item.data.id] : []))
    const needed = () => neededSnapshots(started.harness.sessions.read(session.id, (store) => store.getProjection(session.id)!), engine.readEvents(session.id))
    return { ...started, data, directory, session, snapshots, refs, recorded, needed }
  }

  test("after each turn the snapshots no revert could need are dropped by count and age; the needed ones never", async () => {
    const t = await threeTurns({ snapshotKeepLast: 1, snapshotMaxAgeMs: 0 })
    // Retention runs in the background after an execution; closing the session waits for it.
    const needed = t.needed()
    await t.session.close()
    const kept = await t.refs()
    // One ref per snapshot, every needed one among them, nothing else (age 0 keeps none of the rest).
    expect(new Set(kept).size).toBe(kept.length)
    expect([...kept].sort()).toEqual([...needed].sort())
    // Fewer than were recorded: the snapshots around the steps of the first two turns are gone.
    expect(new Set(t.recorded()).size).toBeGreaterThan(kept.length)
    // What every turn is reverted to is there: one delivery snapshot per turn.
    const deliveries = t.harness.engine.readEvents(t.session.id).flatMap((item) => (item.type === "snapshot.taken" && item.data.point === "delivery" ? [item.data.id] : []))
    expect(deliveries).toHaveLength(3)
    for (const id of deliveries) expect(kept).toContain(id)

    // So the last turn is undone exactly (no file counts as edited by hand), and so is the one before it.
    const again = t.harness.engine.openSession(t.session.id)
    const last = await again.revert()
    expect(last).toMatchObject({ kind: "reverted", plan: { changes: [{ path: "step-a.txt", handEdited: false }, { path: "step-b.txt", handEdited: false }] } })
    expect(readFileSync(join(t.directory, "step-a.txt"), "utf8")).toBe("turn 2 a\n")
    // The turn before had its in-between snapshots dropped. It is still undone exactly: a stretch between two
    // of the harness's own steps needs comparing only when the workspace differed across it, and it did not.
    expect(await again.revert()).toMatchObject({ kind: "reverted", plan: { changes: [{ path: "step-a.txt", handEdited: false }, { path: "step-b.txt", handEdited: false }] } })
    expect(readFileSync(join(t.directory, "step-a.txt"), "utf8")).toBe("turn 1 a\n")
  }, 120_000)

  test("with room to spare nothing needed or recent is dropped, only repeats of the same snapshot", async () => {
    const t = await threeTurns()
    await t.session.close()
    const kept = await t.refs()
    expect(new Set(kept).size).toBe(kept.length)
    expect([...new Set(t.recorded())].sort()).toEqual([...kept].sort())
  }, 120_000)

  test("archiving keeps exactly what a revert or undo could still restore, and leaves other sessions' snapshots alone", async () => {
    const t = await threeTurns()
    // A second session in the same workspace, with snapshots of its own in the same private git directory.
    const other = t.harness.engine.createSession({ cwd: t.directory, settings: SETTINGS })
    t.provider.enqueue(write("other.txt", "theirs\n"), say("Other done."))
    other.send("Add a file.")
    await other.settled()
    await other.close()
    const theirs = await t.refs(other.id)
    expect(theirs.length).toBeGreaterThan(0)

    const needed = t.needed()
    await t.harness.engine.archiveSession(t.session.id)
    expect([...(await t.refs())].sort()).toEqual([...needed].sort())
    expect(await t.refs(other.id)).toEqual(theirs)
    // Every snapshot either session's log needs is still an object in the store.
    for (const id of [...needed, ...theirs]) expect((await t.snapshots.changedFiles(id as never, id as never)).length).toBe(0)

    // Brought back, the session undoes its last turn and redoes it.
    await t.harness.engine.unarchiveSession(t.session.id)
    const again = t.harness.engine.openSession(t.session.id)
    // The other session's file was written after this session's last turn: it is not this session's to remove.
    const preview = await again.revert({ dryRun: true })
    expect(preview).toMatchObject({ kind: "preview" })
    expect(changesOf(preview).find((change) => change.path === "other.txt")).toMatchObject({ handEdited: true })
    expect(await again.revert({ handEdits: "keep" })).toMatchObject({ kind: "reverted" })
    expect(readFileSync(join(t.directory, "step-b.txt"), "utf8")).toBe("turn 2 b\n")
    expect(readFileSync(join(t.directory, "other.txt"), "utf8")).toBe("theirs\n")
    expect(await again.undoRevert({ handEdits: "keep" })).toMatchObject({ kind: "reverted" })
    expect(readFileSync(join(t.directory, "step-b.txt"), "utf8")).toBe("turn 3 b\n")
  }, 120_000)
})

describe("two sessions in one workspace", () => {
  test("an undo never silently overwrites what the other session changed, between this session's steps or during them", async () => {
    const { data, workspace } = place()
    const directory = workspace("shared", { "notes.md": "# Notes\n", "theirs.md": "start\n" })
    const { harness, provider } = start(data, [])
    const mine = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    const theirs = harness.engine.createSession({ cwd: directory, settings: SETTINGS })

    // This session changes notes.md. While its shell command runs, the other session changes theirs.md.
    provider.enqueue(write("notes.md", "# Notes\n\nmine\n"), [call("shell", { command: "sleep 0.6" })], write("theirs.md", "theirs, during\n"), say("Theirs done."), say("Mine done."))
    const watching = watch(mine)
    mine.send("Edit the notes, then wait.")
    await watching.seen((item) => item.type === "tool.started" && watching.events.filter((other) => other.type === "tool.started").length === 2)
    theirs.send("Change theirs.md.")
    await theirs.settled()
    await mine.settled()
    // And once more after this session's turn has ended.
    provider.enqueue(write("after.md", "theirs, after\n"), say("Theirs done again."))
    theirs.send("Add after.md.")
    await theirs.settled()

    const preview = await mine.revert({ dryRun: true })
    expect(preview.kind).toBe("preview")
    const changes = changesOf(preview)
    // Its own file is its own; the other session's files are not, whether they changed during its command or after its turn.
    expect(Object.fromEntries(changes.map((change) => [change.path, change.handEdited]))).toEqual({ "after.md": true, "notes.md": false, "theirs.md": true })
    // Without a word from the user nothing is touched.
    expect((await mine.revert()).kind).toBe("hand_edited")
    expect(readFileSync(join(directory, "theirs.md"), "utf8")).toBe("theirs, during\n")
    expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("# Notes\n\nmine\n")
    // Keeping theirs undoes only this session's own work.
    expect(await mine.revert({ handEdits: "keep" })).toMatchObject({ kind: "reverted", restore: { changed: 1 } })
    expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("# Notes\n")
    expect(readFileSync(join(directory, "theirs.md"), "utf8")).toBe("theirs, during\n")
    expect(existsSync(join(directory, "after.md"))).toBe(true)

    // The same holds the other way round: the other session's undo would remove the file its turn added, which is
    // its own, and would put notes.md back as it was then, which this session has changed since. It is asked.
    const their = await theirs.revert({ dryRun: true })
    expect(Object.fromEntries(changesOf(their).map((change) => [change.path, change.handEdited]))).toEqual({
      "after.md": false,
      "notes.md": true,
    })
  }, 60_000)

  test("a session alone in its workspace is not asked about what its own commands changed", async () => {
    const { data, workspace } = place()
    const directory = workspace("alone")
    const { harness } = start(data, [[call("shell", { command: "echo generated > generated.txt" })], say("Generated.")])
    const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    session.send("Generate it.")
    await session.settled()
    expect(await session.revert()).toMatchObject({ kind: "reverted", plan: { changes: [{ path: "generated.txt", handEdited: false }] } })
    expect(existsSync(join(directory, "generated.txt"))).toBe(false)
  }, 60_000)
})

describe("compaction on the real assembly", () => {
  /** A source file of about 6,000 tokens. */
  const registry = (from: number) => Array.from({ length: 350 }, (_, index) => `export const entry${from + index} = register("handler-${from + index}", ${(from + index) * 31})`).join("\n")
  const big = registry(0)

  test("the test setting lowers the context window, says so, and is not a configuration key", () => {
    expect(TEST_CONTEXT_WINDOW_ENV).toBe("LIGHT_HARNESS_TEST_CONTEXT_WINDOW")
    expect(testContextWindow({ [TEST_CONTEXT_WINDOW_ENV]: "40000" })).toBe(40_000)
    // Only a whole number of tokens is a setting; anything else is not one, and without it nothing is lowered.
    for (const value of ["", "0", "-5", "40k", "4e4", "40000.5", " "]) expect(testContextWindow({ [TEST_CONTEXT_WINDOW_ENV]: value })).toBeNull()
    expect(testContextWindow({})).toBeNull()
    expect(() => parseConfigFile(JSON.stringify({ contextWindow: 40_000 }), "config.json")).toThrow("unknown key")
  })

  test("with the test setting a session compacts after a few thousand tokens, in its own file, and the history tools search that file", async () => {
    const { data, workspace } = place()
    const directory = workspace("compact", { "registry-a.ts": registry(0), "registry-b.ts": registry(350), "notes.md": "# Notes\n" })
    const previous = process.env[TEST_CONTEXT_WINDOW_ENV]
    process.env[TEST_CONTEXT_WINDOW_ENV] = "20000"
    try {
      const respond = (request: ModelRequest) => script.usage({ inputTokens: estimateRequest(request), cachedInputTokens: 0, outputTokens: 30, reasoningTokens: 0 })
      const { harness, logged } = start(data, [
        (request) => [call("read", { path: "registry-a.ts" }), respond(request)],
        (request) => [call("read", { path: "registry-b.ts" }), respond(request)],
        // Two files are over the trigger of a 20,000-token window: the loop asks for a summary before the next step,
        // keeps the second file's step and puts the first behind the checkpoint.
        (request) => [script.text(SUMMARY), respond(request)],
        (request) => {
          // The first file's content is behind the checkpoint: only the user's question still names the handler.
          if (JSON.stringify(request.input).includes("entry212 = register")) throw new Error("the first file is still in view")
          return [call("history_search", { query: "handler-212" }), respond(request)]
        },
        (request) => [script.text("entry212 registers handler-212."), respond(request)],
      ])
      const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
      session.send("Which entry registers handler-212?")
      await session.settled()
      const log = session.readEvents()
      expect(logged.filter((line) => line.includes(TEST_CONTEXT_WINDOW_ENV))).toEqual([`${TEST_CONTEXT_WINDOW_ENV} is set: the context window is taken to be at most 20000 tokens (a test setting)`])
      expect(log.filter((item) => item.type === "compaction.ended")).toHaveLength(1)
      expect(log.at(-1)).toMatchObject({ type: "execution.succeeded" })
      const found = log.findLast((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled")!
      expect(found.data.output).toContain('[seq 7, offset 12130] tool (read): ')
      expect(found.data.output).toContain('export const entry212 = register("handler-212", 6572)')
      // The index is in the session's own database, beside its log.
      const id = session.id
      await harness.close()
      open.splice(0)
      const sessions = openSessionDirectory({ dataDir: data })
      try {
        const tables = sessions.read(id, (store) => (store as unknown as { database: { query: (sql: string) => { all: () => { name: string }[] } } }).database.query("SELECT name FROM sqlite_master WHERE name IN ('history_index', 'history_piece', 'history_fts') ORDER BY name").all())
        expect(tables.map((row) => row.name)).toEqual(["history_fts", "history_index", "history_piece"])
        expectRebuildEqualsLive(sessions.open(id), id)
      } finally {
        sessions.close()
      }
    } finally {
      if (previous === undefined) delete process.env[TEST_CONTEXT_WINDOW_ENV]
      else process.env[TEST_CONTEXT_WINDOW_ENV] = previous
    }
  }, 60_000)

  test("without it, and with a provider that names no window, nothing is compacted ahead of time", async () => {
    const { data, workspace } = place()
    const directory = workspace("plain", { "registry.ts": big })
    const { harness, logged } = start(data, [[call("read", { path: "registry.ts" }), script.usage({ inputTokens: 500_000 })], say("Read it.")])
    const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    session.send("Read registry.ts.")
    await session.settled()
    expect(session.readEvents().some((item) => item.type === "compaction.started")).toBe(false)
    expect(logged).toEqual([])
  }, 60_000)
})

/** The files a revert would write or remove, with whether each counts as changed by someone else. */
function changesOf(result: RevertResult): { path: string; handEdited: boolean }[] {
  if (result.kind !== "preview" && result.kind !== "hand_edited" && result.kind !== "reverted") throw new Error(`no plan: ${result.kind}`)
  return result.plan.changes.map((change) => ({ path: change.path, handEdited: change.handEdited }))
}

function codeOf(work: () => unknown): string {
  try {
    work()
    return "no error"
  } catch (error) {
    return error instanceof EngineError ? error.code : `not an EngineError: ${String(error)}`
  }
}

/** Session IDs in a fixed order, for tests about prefixes. */
function counter(...ids: string[]) {
  let next = 0
  return () => ids[next++] as SessionId
}
