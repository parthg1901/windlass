/**
 * The server gaps clients reported, closed with what the engine provides:
 * per-file diffs of a turn and of a step from the workspace snapshots
 * (`<prefix>/diff`), the files each turn changed replayed on `session/load`,
 * and titles derived from a session's first message (no model call) in
 * `session/list`, `session_info_update` and `<prefix>/session`. Rename and
 * compaction on request are not advertised: the engine has no operation for
 * them. Every message the agent writes is checked against the SDK's schemas.
 */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { E2E_TIMEOUT_MS, script } from "@windlass/core/testing"
import { type DiffResult, EXT, META, TITLE_LENGTH, deriveTitle } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const NS = META.capabilities
const harnesses: Harness[] = []
afterEach(async () => {
  const violations = harnesses.flatMap((harness) => harness.violations)
  for (const harness of harnesses.splice(0).reverse()) await harness.close()
  expect(violations).toEqual([])
})

async function start(options: Parameters<typeof startHarness>[0] = {}) {
  const harness = await startHarness(options)
  harnesses.push(harness)
  await harness.initialize()
  return harness
}

const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const diff = (harness: Harness, params: Record<string, unknown>) => harness.connection.agent.request<DiffResult>(EXT.diff, params)
const stepIds = (harness: Harness, sessionId: string) => harness.backend.engine.readEvents(sessionId as never).flatMap((item) => (item.type === "step.started" ? [item.data.messageId] : []))
const executions = (harness: Harness, sessionId: string) => harness.backend.engine.readEvents(sessionId as never).flatMap((item) => (item.type === "execution.started" ? [item.data.executionId] : []))

/** Turn 1 writes notes.md and a binary file; turn 2 edits notes.md. */
const TWO_TURNS = [
  [script.toolCall("c1", "write", { path: "notes.md", content: "one\ntwo\nthree\n" }), script.toolCall("c2", "shell", { command: "printf 'a\\000b' > blob.bin" })],
  [script.text("Written.")],
  [script.toolCall("c3", "edit", { path: "notes.md", old_string: "two", new_string: "TWO" })],
  [script.text("Edited.")],
]

describe("per-file diffs", () => {
  test("a turn's diff: every changed file with its status, a bounded patch and its line counts; binary files flagged", async () => {
    const h = await start({ responses: TWO_TURNS })
    const sessionId = await h.newSession()
    await prompt(h, sessionId, "write them")
    const first = await diff(h, { sessionId })
    if (!first.available) throw new Error(first.message)
    expect(first.scope).toBe("turn")
    expect(first.executionId).toBe(executions(h, sessionId)[0]!)
    const notes = first.files.find((file) => file.path === "notes.md")!
    expect(notes).toMatchObject({ status: "added", binary: false, truncated: false, omitted: false, added: 3, removed: 0 })
    expect(notes.patch).toContain("+two")
    expect(first.files.find((file) => file.path === "blob.bin")).toMatchObject({ status: "added", binary: true, patch: null })

    await prompt(h, sessionId, "edit it")
    const second = await diff(h, { sessionId })
    if (!second.available) throw new Error(second.message)
    expect(second.files.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([["notes.md", "modified", 1, 1]])
    expect(second.files[0]!.patch).toContain("-two\n+TWO")
    // The earlier turn by its execution, unchanged by what came after it.
    const again = await diff(h, { sessionId, executionId: first.executionId, patch: false })
    expect(again.available && again.files.map((file) => [file.path, file.patch])).toEqual([
      ["blob.bin", null],
      ["notes.md", null],
    ])
  })

  test("a step's diff is that step's files; a step of reads has none recorded; unknown turns and steps are not found", async () => {
    const h = await start({ responses: [[script.toolCall("c1", "ls", {})], [script.toolCall("c2", "write", { path: "a.txt", content: "a\n" })], [script.text("Done.")]] })
    const sessionId = await h.newSession()
    await prompt(h, sessionId, "go")
    const [reads, writes] = stepIds(h, sessionId)
    const step = await diff(h, { sessionId, messageId: writes })
    expect(step.available && [step.scope, step.files.map((file) => file.path)]).toEqual(["step", ["a.txt"]])
    expect(await diff(h, { sessionId, messageId: reads })).toMatchObject({ available: false, reason: "no_snapshots" })
    expect(await diff(h, { sessionId, messageId: "msg_nope" })).toMatchObject({ available: false, reason: "not_found" })
    expect(await diff(h, { sessionId, executionId: "exe_nope" })).toMatchObject({ available: false, reason: "not_found" })
  })

  test("a session with no turn yet, and bad params", async () => {
    const h = await start()
    const sessionId = await h.newSession()
    expect(await diff(h, { sessionId })).toMatchObject({ available: false, reason: "not_found", message: "this session has no turn yet" })
    const bad = await diff(h, { sessionId, patch: "yes" }).then(
      () => null,
      (error: { code?: number }) => error.code,
    )
    expect(bad).toBe(-32602)
    const unknown = await diff(h, { sessionId: "ses_nope" }).then(
      () => null,
      (error: { code?: number }) => error.code,
    )
    expect(unknown).toBe(-32002)
  })

  test("a turn and the queued message that followed it are two turns: each has its own diff, live and on session/load", async () => {
    const h = await start({
      responses: [
        [script.toolCall("c1", "write", { path: "first.md", content: "one\n" }), script.toolCall("c2", "shell", { command: "sleep 0.5" })],
        [script.text("Written.")],
        [script.toolCall("c3", "write", { path: "second.md", content: "two\n" })],
        [script.text("And the second.")],
      ],
    })
    const sessionId = await h.newSession()
    const running = prompt(h, sessionId, "write the first")
    // Queued while the first turn's command runs: delivered at the handover, under the same execution.
    await until(() => h.backend.engine.readEvents(sessionId as never).some((item) => item.type === "tool.started"), 10_000, "the first turn's tools")
    await h.connection.agent.request(EXT.queue, { sessionId, prompt: [{ type: "text", text: "then the second" }] })
    await running
    await until(() => h.backend.engine.readEvents(sessionId as never).some((item) => item.type === "execution.succeeded"), 10_000, "the end of the queued turn")
    const events = h.backend.engine.readEvents(sessionId as never)
    const handover = events.find((item) => item.type === "turn.ended")!.seq
    const [executionId] = executions(h, sessionId)
    expect(executions(h, sessionId)).toHaveLength(1)
    const paths = (result: DiffResult) => (result.available ? result.files.map((file) => file.path) : result.message)
    // The latest turn is the queued message's: its file alone, with or without the execution named.
    expect(paths(await diff(h, { sessionId }))).toEqual(["second.md"])
    expect(paths(await diff(h, { sessionId, executionId }))).toEqual(["second.md"])
    // The turn before it, by the event that ended it.
    expect(paths(await diff(h, { sessionId, endSeq: handover }))).toEqual(["first.md"])
    expect(paths(await diff(h, { sessionId, executionId, endSeq: events.at(-1)!.seq }))).toEqual(["second.md"])
    expect(await diff(h, { sessionId, endSeq: handover + 1 })).toMatchObject({ available: false, reason: "not_found" })
    const live = h.ext.filter((note) => note.method === EXT.turn).map((note) => note.params.changedFiles)
    expect(live).toEqual([["first.md"], ["second.md"]])
    await h.disconnect()
    await h.backend.close()

    const loader = await start({ dataDir: h.dataDir })
    await loader.connection.agent.request(methods.agent.session.load, { sessionId, cwd: h.workspace, mcpServers: [] })
    const replayed = loader.ext.filter((note) => note.method === EXT.turn && note.params.replay === true).map((note) => note.params.changedFiles)
    expect(replayed).toEqual(live)
  }, 60_000)

  test("session/load replays each earlier turn's ending with the files it changed", async () => {
    const first = await start({ responses: TWO_TURNS })
    const sessionId = await first.newSession()
    await prompt(first, sessionId, "write them")
    await prompt(first, sessionId, "edit it")
    const live = first.ext.filter((note) => note.method === EXT.turn).map((note) => note.params.changedFiles)
    await first.disconnect()
    await first.backend.close()

    const loader = await start({ dataDir: first.dataDir })
    await loader.connection.agent.request(methods.agent.session.load, { sessionId, cwd: first.workspace, mcpServers: [] })
    const replayed = loader.ext.filter((note) => note.method === EXT.turn && note.params.replay === true).map((note) => note.params.changedFiles)
    expect(replayed).toEqual([
      ["blob.bin", "notes.md"],
      ["notes.md"],
    ])
    expect(replayed).toEqual(live)
  })

  test("advertised: the diff, and the rename and the compaction the engine now has operations for", async () => {
    const h = await startHarness()
    harnesses.push(h)
    const init = (await h.initialize()) as { agentCapabilities: { _meta: Record<string, { methods: string[] }> } }
    const offered = init.agentCapabilities._meta[NS]!.methods
    expect(offered).toContain(EXT.diff)
    expect(offered).toContain(EXT.rename)
    expect(offered).toContain(EXT.compact)
  })
})

describe("titles", () => {
  test("derived from the first message: its first line, trimmed and shortened at a word, without a model call", () => {
    expect(deriveTitle("  Fix the login test  \nand then the docs")).toBe("Fix the login test")
    expect(deriveTitle("\n\n   \nsecond line wins")).toBe("second line wins")
    expect(deriveTitle("   ")).toBeNull()
    const long = deriveTitle("Refactor the session store so that every write goes through one transaction and nothing is lost on a crash")!
    expect(long.length).toBeLessThanOrEqual(TITLE_LENGTH)
    expect(long).toEndWith("…")
    expect(long).toStartWith("Refactor the session store so that every write")
    expect(deriveTitle("x".repeat(100))).toBe(`${"x".repeat(TITLE_LENGTH - 1)}…`)
  })

  test("session/list, session_info_update and the session state carry the derived title; the model is asked once per prompt only", async () => {
    const h = await start({ responses: [[script.text("Sure.")]] })
    const sessionId = await h.newSession()
    expect((await h.connection.agent.request(methods.agent.session.list, { cwd: h.workspace })).sessions[0]?.title ?? null).toBeNull()
    await prompt(h, sessionId, "Make the parser faster\nIt is slow on big files.")
    expect(h.provider.calls).toHaveLength(1)
    const listed = await h.connection.agent.request(methods.agent.session.list, { cwd: h.workspace })
    expect(listed.sessions.map((session) => session.title)).toEqual(["Make the parser faster"])
    const info = h.of(sessionId, "session_info_update") as { title?: string }[]
    expect(info.map((update) => update.title)).toContain("Make the parser faster")
    const state = await h.connection.agent.request<{ title: string | null }>(EXT.session, { sessionId })
    expect(state.title).toBe("Make the parser faster")
  })

  test("a loaded session reports its derived title", async () => {
    const first = await start({ responses: [[script.text("Sure.")]] })
    const sessionId = await first.newSession()
    await prompt(first, sessionId, "Tidy the README")
    writeFileSync(join(first.workspace, "README.md"), "# readme\n")
    await first.disconnect()
    await first.backend.close()
    const loader = await start({ dataDir: first.dataDir })
    await loader.connection.agent.request(methods.agent.session.load, { sessionId, cwd: first.workspace, mcpServers: [] })
    expect((loader.of(sessionId, "session_info_update") as { title?: string }[]).at(-1)?.title).toBe("Tidy the README")
  })
})
