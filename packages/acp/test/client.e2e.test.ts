/**
 * The shared protocol client (`src/client.ts`) against the real server on the
 * real harness with a scripted model: in memory for most tests, and once as
 * the `acp` subcommand in a child process (start, events, a killed server,
 * reconnection). What the CLI and the TUI rely on: typed events and turn
 * endings in order, steer and queue, approvals answered with a note or
 * cancelled by a cancel, listings that never stop a server in use, config
 * options, taint and its clearing, diffs, and errors with the server's reason.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "@windlass/core"
import { FakeProvider, type ScriptedResponse, script, within } from "@windlass/core/testing"
import { type ApprovalAsk, ClientError, type ClientSession, HarnessClient, HarnessConnection, type SessionItem } from "../src/client.ts"
import { EXT } from "../src/extensions.ts"
import { SCRIPT_ENV } from "../src/scripted.ts"
import { MODELS } from "./helpers.ts"

setDefaultTimeout(30_000)

const MAIN = new URL("../../cli/src/main.ts", import.meta.url).pathname
const dirs: string[] = []
const links: HarnessConnection[] = []
const clients: HarnessClient[] = []
/** Outside every workspace, and not under /tmp (a path beside a /tmp workspace is the session's own temp directory). */
const elsewhere = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-client-outside-")))

afterEach(async () => {
  for (const link of links.splice(0)) await link.stop()
  for (const client of clients.splice(0)) await client.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterAll(() => rmSync(elsewhere, { recursive: true, force: true }))

function place(): { root: string; workspace: string; dataDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-client-")))
  dirs.push(root)
  const workspace = join(root, "work")
  Bun.spawnSync(["mkdir", "-p", workspace])
  return { root, workspace, dataDir: join(root, "data") }
}

async function memory(responses: readonly ScriptedResponse[]): Promise<{ link: HarnessConnection; workspace: string; logs: string[] }> {
  const where = place()
  const logs: string[] = []
  const link = await HarnessConnection.start({
    transport: {
      kind: "memory",
      harness: { dataDir: where.dataDir, provider: new FakeProvider(responses), models: async () => MODELS, defaultModel: "test-model", log: () => {}, engine: { discover: () => [], loadConfig: null } },
    },
    clientInfo: { name: "client-test", title: "client test", version: "0.0.0" },
    log: (line) => void logs.push(line),
  })
  links.push(link)
  return { link, workspace: where.workspace, logs }
}

/** Reads items until `done` says the last one was what it waited for. */
async function collect(session: ClientSession, done: (item: SessionItem) => boolean, ms = 10_000): Promise<SessionItem[]> {
  const items: SessionItem[] = []
  const iterator = session.items[Symbol.asyncIterator]()
  const deadline = Date.now() + ms
  for (;;) {
    const next = await within(iterator.next(), Math.max(1, deadline - Date.now()), "the next item").catch(() => null)
    if (next === null) throw new Error(`timed out; got ${items.map(kind).join(", ")}`)
    if (next.done) return items
    items.push(next.value)
    if (done(next.value)) return items
  }
}

const kind = (item: SessionItem) => ("event" in item ? item.event.type : `signal:${item.signal.kind}`)
const turnEnded = (item: SessionItem) => !("event" in item) && item.signal.kind === "turn"
const writeOutside = (callId = "c1") => script.toolCall(callId, "write", { path: join(elsewhere, `${callId}.txt`), content: "outside\n" })

describe("in memory", () => {
  test("a session: typed events, then the turn's ending with its changed files, in the order the server sent them", async () => {
    const { link, workspace } = await memory([[script.toolCall("c1", "write", { path: "notes.md", content: "hi\n" })], [script.text("Done.")]])
    const session = await link.newSession(workspace, { model: "test-model" })
    expect(session.configOptions.map((option) => option.id)).toEqual(["model", "effort", "approval"])
    const id = await session.send("write it")
    expect(id).toStartWith("msg_")
    const items = await collect(session, turnEnded)
    const types = items.map(kind)
    expect(types[0]).toBe("session.created")
    expect(types).toContain("tool.settled")
    // The ending comes after the turn's own events.
    expect(types.indexOf("execution.succeeded")).toBeLessThan(types.indexOf("signal:turn"))
    const turn = items.at(-1)
    expect(turn !== undefined && !("event" in turn) && turn.signal.kind === "turn" && turn.signal.turn.changedFiles).toEqual(["notes.md"])
    expect(readFileSync(join(workspace, "notes.md"), "utf8")).toBe("hi\n")
  })

  test("listing sessions and models while a session is open leaves the server running", async () => {
    const { link, workspace } = await memory([[script.text("One.")], [script.text("Two.")]])
    const session = await link.newSession(workspace)
    await session.send("first")
    await collect(session, turnEnded)
    const listed = await link.listSessions(workspace)
    expect(listed.map((row) => [row.id, row.title, row.model])).toEqual([[session.id, "first", "test-model"]])
    expect((await link.listModels()).models.map((model) => [model.id, model.contextWindow])).toEqual([
      ["test-model", 200_000],
      ["other-model", null],
    ])
    expect(link.gone).toBe(false)
    await session.send("second")
    const items = await collect(session, turnEnded)
    expect(items.map(kind)).toContain("execution.succeeded")
  })

  test("an approval question reaches the approver with the whole question; the answer and its note are recorded", async () => {
    const { link, workspace } = await memory([[writeOutside()], [script.text("Written.")]])
    const session = await link.newSession(workspace)
    const asked: ApprovalAsk[] = []
    session.approver = async (ask) => {
      asked.push(ask)
      return { choice: "once", note: "only this time" }
    }
    await session.send("write outside")
    const items = await collect(session, turnEnded)
    expect(asked).toHaveLength(1)
    const ask = asked[0]!
    expect(ask.toolCallId).toBe(`${ask.messageId}/${ask.callId}`)
    expect(ask.question.title).toBe(`Allow write: writing ${join(elsewhere, "c1.txt")}?`)
    expect(ask.question.choices.map((choice) => choice.id)).toEqual(["once", "session", "project", "deny"])
    expect(ask.needs.map((need) => need.kind)).toEqual(["write"])
    expect(ask.then).toEqual({ kind: "run" })
    expect(ask.subagent).toBeNull()
    const answered = items.flatMap((item) => ("event" in item && item.event.type === "approval.answered" ? [item.event.data] : []))
    expect(answered.map((data) => [data.choice, data.note])).toEqual([["once", "only this time"]])
  })

  test("a cancel while the question is pending: the approver's signal aborts, the request is answered cancelled, the call does not run", async () => {
    const { link, workspace } = await memory([[writeOutside("c2")], [script.text("never")]])
    const session = await link.newSession(workspace)
    let aborted = false
    session.approver = (_ask, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true
          resolve({ choice: "once" })
        })
        // Cancelled while the question is pending: the listener is in place, so the abort reaches it.
        queueMicrotask(() => void session.cancel())
      })
    await session.send("write outside")
    const items = await collect(session, turnEnded)
    expect(aborted).toBe(true)
    if (process.env.DBG) console.log(items.map(kind).join(" "), JSON.stringify(items.flatMap((item) => ("event" in item && item.event.type === "approval.answered" ? [item.event.data] : []))))
    expect(items.map(kind)).toContain("execution.interrupted")
    expect(items.some((item) => "event" in item && item.event.type === "approval.answered")).toBe(false)
    expect(existsSync(join(elsewhere, "c2.txt"))).toBe(false)
  })

  test("no approver declines; the approval mode is a config option; taint is a signal and clears", async () => {
    writeFileSync(join(elsewhere, "secret.txt"), "from outside\n")
    const { link, workspace } = await memory([[script.toolCall("c1", "read", { path: join(elsewhere, "secret.txt") })], [script.text("Read.")]])
    const session = await link.newSession(workspace)
    const options = await session.setConfig("approval", "ask")
    expect(options.find((option) => option.id === "approval")?.currentValue).toBe("ask")
    expect((await session.approval()).mode).toBe("ask")
    await session.setConfig("approval", "auto")
    await session.send("read it")
    const items = await collect(session, turnEnded)
    const taint = items.find((item) => !("event" in item) && item.signal.kind === "taint")
    expect(taint !== undefined && !("event" in taint) && taint.signal.kind === "taint" && taint.signal.tainted).toBe(true)
    expect((await session.approval()).tainted).toBe(true)
    expect(await session.clearTaint()).toBe(true)
    expect((await session.approval()).tainted).toBe(false)
    expect(await session.clearTaint()).toBe(false)
  })

  test("diffs, state, withdraw; refusals carry the server's reason", async () => {
    const { link, workspace } = await memory([[script.toolCall("c1", "write", { path: "a.txt", content: "a\n" })], [script.text("Done.")]])
    const session = await link.newSession(workspace)
    expect(session.offers(EXT.diff)).toBe(true)
    expect(session.offers(EXT.rename)).toBe(true)
    await session.send("write a")
    await collect(session, turnEnded)
    const diff = await session.diff()
    expect(diff.available && diff.files.map((file) => [file.path, file.added])).toEqual([["a.txt", 1]])
    const state = await session.state()
    expect([state.state, state.title, state.canUndo]).toEqual(["idle", "write a", true])
    expect(await session.withdraw("msg_unknown")).toBe(false)
    const missing = await link.openSession("ses_nope", workspace, { replay: true }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(ClientError)
    expect((missing as ClientError).reason).toBe("session_not_found")
  })

  test("a session opened again replays its history, marked, with each turn's ending", async () => {
    const { link, workspace } = await memory([[script.text("One.")]])
    const first = await link.newSession(workspace)
    await first.send("hello")
    await collect(first, turnEnded)
    await first.close()
    const again = await link.openSession(first.id, workspace, { replay: true })
    const items = await collect(again, turnEnded)
    expect(items.every((item) => ("event" in item ? item.replay : item.signal.kind !== "turn" || item.signal.turn.replay === true))).toBe(true)
    expect(items.map(kind)).toContain("execution.succeeded")
  })

  test("fork: a new session with the history, opened and prompted like any other", async () => {
    const { link, workspace } = await memory([[script.text("One.")], [script.text("In the fork.")]])
    const session = await link.newSession(workspace)
    await session.send("first")
    await collect(session, turnEnded)
    const forked = await link.fork({ sessionId: session.id })
    expect(forked).toMatchObject({ parentSessionId: session.id, cwd: workspace, title: "first (fork)" })
    expect((await link.listSessions(workspace)).map((row) => row.id)).toEqual([forked.sessionId, session.id])
    const opened = await link.openSession(forked.sessionId, forked.cwd, { replay: true })
    await opened.send("second")
    const items = await collect(opened, (item) => turnEnded(item) && !(item as { signal: { turn: { replay?: boolean } } }).signal.turn.replay)
    expect(items.filter((item) => "event" in item && item.replay).length).toBeGreaterThan(0)
    expect(items.map(kind)).toContain("execution.succeeded")
  })

  test("replay: onStart hands over the replay session, whose events are its progress; the answer is the report", async () => {
    const { link, workspace } = await memory([[script.text("Hello.")], [script.text("Hello.")]])
    const session = await link.newSession(workspace)
    await session.send("say hello")
    await collect(session, turnEnded)
    const seen: string[] = []
    let reading: Promise<void> | null = null
    const result = await link.replay(
      { sessionId: session.id },
      {
        cwd: workspace,
        onStart: (replaying) => {
          reading = (async () => {
            for await (const item of replaying.events) seen.push(item.event.type)
          })()
        },
      },
    )
    await reading
    expect(result.report.status).toBe("identical")
    expect(result.text).toContain("IDENTICAL")
    expect(seen[0]).toBe("session.created")
    expect(seen).toContain("replay.ended")
  })

  test("a subagent's question reaches the session's approver with the subagent's label and session", async () => {
    const { link, workspace } = await memory([
      [script.toolCall("p1", "subagent", { task: "Write the file outside" })],
      [writeOutside("c3")],
      [script.text("Written.")],
      [script.text("Done.")],
    ])
    const session = await link.newSession(workspace)
    const asked: ApprovalAsk[] = []
    session.approver = async (ask) => {
      asked.push(ask)
      return { choice: "once" }
    }
    await session.send("delegate it")
    const items = await collect(session, turnEnded)
    expect(asked).toHaveLength(1)
    const child = items.flatMap((item) => ("event" in item && item.event.type === "child.event" ? [item.event] : []))
    expect(asked[0]).toMatchObject({ sessionId: session.id, subagent: "Write the file outside", subagentSessionId: child[0]!.child })
    expect(child.map((item) => item.event.type)).toContain("approval.answered")
    expect(readFileSync(join(elsewhere, "c3.txt"), "utf8")).toBe("outside\n")
  })

  test("two subagents asking at once: their questions are put one at a time, and both are answered", async () => {
    // Each subagent's model calls are told apart by its task, whatever order they come in.
    const steps = new Map<string, number>()
    const child = (request: { input: unknown }): ReturnType<typeof script.text>[] => {
      const input = JSON.stringify(request.input)
      const which = input.includes("Write file A") ? "a" : "b"
      const step = steps.get(which) ?? 0
      steps.set(which, step + 1)
      return step === 0 ? [writeOutside(`par-${which}`)] : [script.text(`Wrote ${which}.`)]
    }
    const { link, workspace } = await memory([
      [script.toolCall("p1", "subagent", { task: "Write file A" }), script.toolCall("p2", "subagent", { task: "Write file B" })],
      child as never,
      child as never,
      child as never,
      child as never,
      [script.text("Both done.")],
    ])
    const session = await link.newSession(workspace)
    let open = 0
    let most = 0
    const asked: string[] = []
    session.approver = async (ask) => {
      open += 1
      most = Math.max(most, open)
      asked.push(ask.subagent ?? "")
      await Bun.sleep(50)
      open -= 1
      return { choice: "once" }
    }
    await session.send("do both")
    await collect(session, turnEnded, 20_000)
    expect(asked.sort()).toEqual(["Write file A", "Write file B"])
    expect(most).toBe(1)
    expect(readFileSync(join(elsewhere, "par-a.txt"), "utf8")).toBe("outside\n")
    expect(readFileSync(join(elsewhere, "par-b.txt"), "utf8")).toBe("outside\n")
  })
})

describe("as a child process", () => {
  test("start, a turn, a killed server is lost with how, and reconnection opens the session again", async () => {
    const where = place()
    const scriptFile = join(where.root, "script.json")
    writeFileSync(scriptFile, JSON.stringify({ responses: [[{ type: "text", text: "Hello." }], [{ type: "text", text: "Again." }]] }))
    const client = new HarnessClient({
      transport: { kind: "child", command: [process.execPath, MAIN, "acp"], env: { ...process.env, XDG_DATA_HOME: join(where.root, "xdg"), [SCRIPT_ENV]: scriptFile } },
      clientInfo: { name: "client-test", title: "client test", version: "0.0.0" },
    })
    clients.push(client)
    const servers = async () => (await Bun.$`pgrep -P ${process.pid} -f ${"main.ts acp"}`.nothrow().text()).trim().split("\n").filter((line) => line !== "").map(Number)
    const before = new Set(await servers())
    const link = await client.connection()
    expect(link.offers(EXT.diff)).toBe(true)
    const session = await link.newSession(where.workspace)
    await session.send("hi")
    await collect(session, turnEnded)

    // The server dies: the session's items end, and how is said.
    // This test's server: other test files' servers may be children of this process too.
    const started = (await servers()).filter((pid) => !before.has(pid))
    expect(started).toHaveLength(1)
    const pid = started[0]!
    process.kill(pid, "SIGKILL")
    await collect(session, () => false).catch(() => [])
    expect(session.lost()?.how).toBe("was killed (SIGKILL)")
    const refused = await client.connection().then(
      () => null,
      (error: unknown) => error as ClientError,
    )
    expect(refused?.reason).toBe("closed")

    const fresh = await client.reconnect()
    const reopened = await fresh.openSession(session.id, where.workspace, { replay: true })
    const items = await collect(reopened, turnEnded)
    expect(items.map(kind)).toContain("execution.succeeded")
  })

  test("a command that is not the server: refused with a sentence and reason closed", async () => {
    const refused = await HarnessConnection.start({
      transport: { kind: "child", command: ["sh", "-c", `echo "${brand.binary} acp error: no data directory" >&2; exit 3`], env: process.env },
      clientInfo: { name: "client-test", title: "client test", version: "0.0.0" },
    }).then(
      () => null,
      (error: unknown) => error as ClientError,
    )
    expect(refused).toBeInstanceOf(ClientError)
    expect(refused?.reason).toBe("closed")
    expect(refused?.message).toBe("the engine could not start: no data directory (its process exited with code 3)")
  })
})
