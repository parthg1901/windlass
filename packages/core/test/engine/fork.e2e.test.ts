/**
 * Fork as an engine operation: a new session with a file of its own, typed
 * as a fork in its log, with the parent's history up to a step boundary as
 * its history; what it inherits and what it does not; the workspace it works
 * in; a parent that another engine holds; and the request-prefix property
 * across the fork.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EngineError } from "../../src/engine/engine.ts"
import { forkOf } from "../../src/event/durable.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { comparePrefix, hashRequest } from "../../src/request/prefix.ts"
import { openSessionDirectory } from "../../src/store/directory.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { SETTINGS, call, closeHarnesses, place, removePlaces, say, start } from "./assembly-helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(closeHarnesses)
afterAll(removePlaces)

describe("forking a session", () => {
  test("the fork has the parent's history, its own file and typed lineage; its first request extends the parent's last one under the root's cache key", async () => {
    const { data, workspace } = place()
    const { harness, provider } = start(data, [[call("read", { path: "notes.md" })], say("It is a notes file."), say("Sure: a shorter summary.")])
    const engine = harness.engine
    const parent = engine.createSession({ cwd: workspace("w"), settings: SETTINGS, title: "Notes" })
    parent.send("What is notes.md?")
    await parent.settled()
    const parentLog = parent.readEvents()
    const before = parent.projection()

    const fork = await engine.forkSession(parent.id)
    const forked = fork.projection()
    expect(fork.id).not.toBe(parent.id)
    expect(forked.session.lineage).toEqual({ kind: "fork", parentSessionId: parent.id, throughSeq: before.lastSeq })
    expect(forked.session.rootId).toBe(parent.id)
    expect(forked.session.cwd).toBe(before.session.cwd)
    expect(forked.session.title).toBe("Notes")
    expect(forked.session.settings).toEqual(before.session.settings)
    expect(forked.session.execution).toBeNull()
    expect(forked.inbox).toEqual([])
    // The same history, and the same baseline: what the model saw is what the fork's model sees.
    expect(forked.messages).toEqual(before.messages)
    expect(forked.baseline).toEqual(before.baseline)
    expect(selectModelHistory(forked).messages.map((message) => message.id)).toEqual(selectModelHistory(before).messages.map((message) => message.id))
    // Its own file: one event of its own, after the inherited ones.
    expect(existsSync(harness.sessions.pathOf(fork.id))).toBe(true)
    expect(fork.readEvents().slice(0, parentLog.length)).toEqual([...parentLog])
    expect(fork.readEvents().slice(parentLog.length).map((item) => [item.seq, item.type])).toEqual([[before.lastSeq + 1, "session.created"]])

    fork.send("Shorter, please.")
    await fork.settled()
    // The prefix property across the fork: the fork's first request is the parent's last one plus appended items.
    const [, last, first] = provider.requests
    expect(comparePrefix(hashRequest(last!), hashRequest(first!))).toMatchObject({ extension: true })
    expect(first!.params.cacheKey).toBe(parent.id)
    expect(last!.params.cacheKey).toBe(parent.id)
    // The parent is untouched and carries on by itself.
    expect(parent.readEvents()).toEqual([...parentLog])
    expect(parent.projection().messages).toEqual(before.messages)
    harness.sessions.read(fork.id, (store) => expectRebuildEqualsLive(store as never, fork.id))
    expect(engine.listSessions().map((summary) => summary.session.id).sort()).toEqual([fork.id, parent.id].sort())
  })

  test("a fork point is a step boundary: one inside a step is refused, and the default is the latest boundary", async () => {
    const { data, workspace } = place()
    const { harness } = start(data, [[call("read", { path: "notes.md" })], say("Done.")])
    const engine = harness.engine
    const parent = engine.createSession({ cwd: workspace("w"), settings: SETTINGS })
    parent.send("Read it.")
    await parent.settled()
    const log = parent.readEvents()
    const inside = log.find((item) => item.type === "tool.started")!.seq
    const refused = await engine.forkSession(parent.id, { throughSeq: inside }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(EngineError)
    expect((refused as EngineError).code).toBe("invalid_request")
    expect((refused as EngineError).message).toContain("inside a step")
    expect(((await engine.forkSession(parent.id, { throughSeq: 9999 }).catch((error: unknown) => error)) as EngineError).message).toContain("past its end")

    // In the middle of the turn, after the first step: the fork ends on the tool result and takes a prompt of its own.
    const boundary = log.find((item) => item.type === "step.ended")!.seq
    const fork = await engine.forkSession(parent.id, { throughSeq: boundary, settings: { model: "gpt-other", reasoningEffort: "low" }, title: "Other" })
    expect(forkOf(fork.projection().session.lineage)?.throughSeq).toBe(boundary)
    expect(fork.projection().session.settings).toEqual({ model: "gpt-other", reasoningEffort: "low" })
    expect(fork.projection().session.title).toBe("Other")
    expect(fork.projection().messages.at(-1)?.kind).toBe("assistant")
    expect(((await engine.forkSession("ses_missing" as never).catch((error: unknown) => error)) as EngineError).code).toBe("session_not_found")
  })

  test("a fork may get a workspace of its own: the parent's as it stands, or as it was at the fork point", async () => {
    const { data, workspace, root } = place()
    const { harness } = start(data, [[call("write", { path: "notes.md", content: "first\n" })], say("Wrote it."), [call("write", { path: "notes.md", content: "second\n" })], say("Again."), [call("write", { path: "notes.md", content: "in the fork\n" })], say("Forked.")])
    const engine = harness.engine
    const directory = workspace("w", { "notes.md": "start\n", "keep.txt": "kept\n" })
    const parent = engine.createSession({ cwd: directory, settings: SETTINGS })
    parent.send("Write first.")
    await parent.settled()
    const afterFirst = parent.projection().lastSeq
    parent.send("Write second.")
    await parent.settled()
    // A change by hand after the last snapshot: a fork of the present state has it.
    writeFileSync(join(directory, "by-hand.txt"), "mine\n")

    const now = await engine.forkSession(parent.id, { workspace: { copyTo: join(root, "copy-now") } })
    expect(now.projection().session.cwd).toBe(join(root, "copy-now"))
    expect(readFileSync(join(root, "copy-now", "notes.md"), "utf8")).toBe("second\n")
    expect(readFileSync(join(root, "copy-now", "by-hand.txt"), "utf8")).toBe("mine\n")
    expect(readFileSync(join(root, "copy-now", "keep.txt"), "utf8")).toBe("kept\n")
    const lineage = forkOf(now.projection().session.lineage)!
    expect(lineage.copied?.from).toBe(directory)
    expect(lineage.copied?.snapshot).toMatch(/^[0-9a-f]{40}$/)

    // At the end of the first turn the workspace held "first".
    const then = await engine.forkSession(parent.id, { throughSeq: afterFirst })
    expect(then.projection().session.cwd).toBe(directory)
    const copy = await engine.forkSession(parent.id, { throughSeq: afterFirst, workspace: {} })
    const copied = copy.projection().session.cwd
    // Beside the data directory, never inside it: the sandbox hides the data directory from commands.
    expect(copied).toBe(join(`${data}-work`, "workspaces", copy.id))
    expect(readFileSync(join(copied, "notes.md"), "utf8")).toBe("first\n")
    expect(existsSync(join(copied, "by-hand.txt"))).toBe(false)

    // The fork works in its copy: the parent's files stay as they are.
    now.send("Write in the fork.")
    await now.settled()
    expect(readFileSync(join(root, "copy-now", "notes.md"), "utf8")).toBe("in the fork\n")
    expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("second\n")
  })

  test("a parent that another engine holds, and keeps writing to, is forked all the same", async () => {
    const { data, workspace } = place()
    const first = start(data, [say("One."), say("Two, in the parent.")])
    const parent = first.harness.engine.createSession({ cwd: workspace("w"), settings: SETTINGS })
    parent.send("Count.")
    await parent.settled()
    const forkPoint = parent.projection().lastSeq

    // A second engine on the same data directory, as another process is: it cannot open the parent, and forks it.
    const second = start(data, [say("Two, in the fork.")])
    expect(() => second.harness.engine.openSession(parent.id)).toThrow(/in use/)
    const fork = await second.harness.engine.forkSession(parent.id)
    // The parent goes on in its own engine; the fork does not see what it writes after the fork point.
    parent.send("Go on.")
    fork.send("Go on.")
    await Promise.all([parent.settled(), fork.settled()])
    expect(forkOf(fork.projection().session.lineage)?.throughSeq).toBe(forkPoint)
    const texts = (events: ReturnType<typeof fork.readEvents>) => events.flatMap((item) => (item.type === "text.ended" ? [item.data.text] : []))
    expect(texts(fork.readEvents())).toEqual(["One.", "Two, in the fork."])
    expect(texts(parent.readEvents())).toEqual(["One.", "Two, in the parent."])
    expect(comparePrefix(hashRequest(first.provider.requests[0]!), hashRequest(second.provider.requests[0]!))).toMatchObject({ extension: true })
    // Read back without either engine: the fork's file alone holds only its own events.
    await first.harness.close()
    await second.harness.close()
    const directory = openSessionDirectory({ dataDir: data })
    try {
      expect(directory.readEvents(fork.id, { afterSeq: forkPoint }).map((item) => item.type)[0]).toBe("session.created")
      expect(directory.get(fork.id)?.session.rootId).toBe(parent.id)
    } finally {
      directory.close()
    }
  })
})
