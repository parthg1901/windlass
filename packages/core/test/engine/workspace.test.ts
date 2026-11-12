/**
 * Snapshots in the loop and the revert built on them: what is recorded and
 * when, how a session degrades without snapshots, what a revert does with
 * files edited by hand, and where it stops (a compaction, a running turn, a
 * point with no snapshot). The last group runs the real snapshot module and
 * the real tools in a temporary directory.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Engine, createEngine } from "../../src/engine/engine.ts"
import { firstDelivery, handEditedPaths, snapshotsAfter, snapshotsSinceDelivery } from "../../src/engine/workspace.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { MessageId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { openSnapshots } from "../../src/snapshot/index.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { createStandardTools } from "../../src/tools/index.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, removeHarnessDirectories } from "./harness.ts"

const scratch: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

const types = (h: Harness): string[] => h.log().map((item) => item.type)
const call = (name: string, input: Json, callId = "call_1") => [script.toolCall(callId, name, input)]
const write = (path: string, content: string) => call("write", { path, content })
const say = (value: string) => [script.text(value)]
const snapshots = (h: Harness) => h.log().filter((item): item is StoredEvent<"snapshot.taken"> => item.type === "snapshot.taken")
const points = (h: Harness) => snapshots(h).map((item) => item.data.point)

async function withWorkspace(run: (h: Harness, files: Map<string, string>) => Promise<void>, files: Record<string, string> = { "a.ts": "1\n", "notes.md": "notes\n" }) {
  const h = new Harness({ workspace: new FakeWorkspace(files) })
  const writes = (input: Record<string, unknown>) => {
    h.workspace!.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}`
  }
  h.tools.on("write", ...Array.from({ length: 8 }, () => writes))
  try {
    await run(h, h.workspace!.files)
    h.verify()
  } finally {
    await h.dispose()
  }
}

/** One turn that writes `content` to `path`. */
async function turn(h: Harness, prompt: string, path: string, content: string) {
  h.provider.enqueue(write(path, content), say("Done."))
  if (h.session === undefined) h.create()
  h.session.send(prompt)
  await h.settled()
}

describe("what the log records about the workspace", () => {
  test("a step is bracketed by snapshots only when one of its calls can change files", () =>
    withWorkspace(async (h) => {
      h.provider.enqueue(call("read", { path: "a.ts" }), write("a.ts", "2\n"), [script.toolCall("call_1", "read", { path: "a.ts" }), script.toolCall("call_2", "shell", { command: "true" })], say("Done."))
      h.tools.on("read", "1", "2").on("shell", "")
      h.create().send("Change a.ts.")
      await h.settled()
      const steps = h.log().flatMap((item) => (item.type === "step.started" ? [item.data.messageId] : []))
      expect(snapshots(h).map((item) => [item.data.point, item.data.messageId])).toEqual([
        ["delivery", null],
        ["step_start", steps[1]!],
        ["step_end", steps[1]!],
        // A command can change anything, so its step is bracketed too; it changed nothing, and the IDs say so.
        ["step_start", steps[2]!],
        ["step_end", steps[2]!],
      ])
      const [, before, after, again, same] = snapshots(h).map((item) => item.data.id)
      expect(before).not.toBe(after)
      expect([again, same]).toEqual([after, after])
    }))

  test("what a step changed, what a turn changed and what was current at a message can be read off the log", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      files.set("notes.md", "edited by hand\n")
      await turn(h, "Second.", "a.ts", "3\n")
      const log = h.log()
      const users = h.session.projection().messages.filter((message) => message.kind === "user")
      const store = h.workspace!.store
      // The snapshot current when the second prompt was sent holds the hand edit and the first turn's change.
      const second = snapshotsSinceDelivery(log, users[1]!.seq)
      expect(h.workspace!.tree(second.target!)).toEqual({ "a.ts": "2\n", "notes.md": "edited by hand\n" })
      // The first turn changed a.ts; its step changed a.ts.
      const first = snapshotsSinceDelivery(log, users[0]!.seq)
      const firstTurn = first.timeline.filter((mark) => mark.seq < second.timeline[0]!.seq)
      expect(await store.changedFiles(first.target as never, firstTurn.at(-1)!.id as never)).toEqual(["a.ts"])
      const [start, end] = firstTurn.filter((mark) => mark.point !== "delivery")
      expect([start!.point, end!.point, start!.messageId === end!.messageId]).toEqual(["step_start", "step_end", true])
      expect(await store.changedFiles(start!.id as never, end!.id as never)).toEqual(["a.ts"])
      // Between the turns only a person changed files.
      expect(await handEditedPaths(store, first.timeline, snapshotsAfter(log, 0).at(-1)!.id)).toEqual(["notes.md"])
      expect(firstDelivery(log, 0)).toBe(first.target)
    }))

  test("input steered into a running turn gets a snapshot of its own", () =>
    withWorkspace(async (h) => {
      h.provider.enqueue(
        () => {
          h.session.send("And b.ts too.")
          return write("a.ts", "2\n")
        },
        write("b.ts", "new\n"),
        say("Both done."),
      )
      h.create().send("Change a.ts.")
      await h.settled()
      expect(points(h)).toEqual(["delivery", "step_start", "step_end", "delivery", "step_start", "step_end"])
      const steer = h.session.projection().messages.filter((message) => message.kind === "user")[1]!
      expect(h.workspace!.tree(snapshotsSinceDelivery(h.log(), steer.seq).target!)).toEqual({ "a.ts": "2\n", "notes.md": "notes\n" })
    }))

  test("what snapshots leave out is recorded when it changes, not with every snapshot", () =>
    withWorkspace(async (h) => {
      h.workspace!.skipped = [{ path: "big.bin", reason: "too_large", bytes: 3_000_000 }]
      h.workspace!.nestedRepositories = ["vendor/lib"]
      await turn(h, "First.", "a.ts", "2\n")
      await turn(h, "Second.", "a.ts", "3\n")
      h.workspace!.skipped = []
      await turn(h, "Third.", "a.ts", "4\n")
      const coverage = h.log().flatMap((item) => (item.type === "snapshot.coverage" ? [item.data] : []))
      expect(coverage).toEqual([
        { skipped: [{ path: "big.bin", reason: "too_large", bytes: 3_000_000 }], nestedRepositories: ["vendor/lib"] },
        { skipped: [], nestedRepositories: ["vendor/lib"] },
      ])
      expect(snapshots(h)).toHaveLength(9)
      expect(h.session.projection().session.workspace).toMatchObject({ skipped: [], nestedRepositories: ["vendor/lib"], unavailable: null })
    }))
})

describe("a session without snapshots", () => {
  test("says so once, works, and its revert rewinds the conversation only", () =>
    withWorkspace(async (h, files) => {
      h.workspace!.unavailable = { kind: "unavailable", reason: "git_not_found", message: "git was not found on PATH; snapshots need git 2.25 or newer." }
      await turn(h, "First.", "a.ts", "2\n")
      await turn(h, "Second.", "a.ts", "3\n")
      expect(types(h).filter((type) => type === "snapshot.unavailable")).toHaveLength(1)
      expect(types(h)).not.toContain("snapshot.taken")
      expect(types(h).filter((type) => type === "execution.succeeded")).toHaveLength(2)

      const preview = await h.session.revert({ dryRun: true })
      expect(preview).toMatchObject({ kind: "preview", plan: { target: null, unrestorable: "no snapshot of the workspace was taken at that point", changes: [] } })
      expect(await h.session.revert()).toMatchObject({ kind: "reverted", restore: null })
      expect(h.log().at(-1)).toMatchObject({ type: "history.reverted", data: { restore: null } })
      // The files are as the second turn left them: nothing could be restored, and the result said so.
      expect(files.get("a.ts")).toBe("3\n")
      // The undo of a revert that restored nothing puts the messages back and touches no file either.
      expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted", restore: null })
      expect(h.session.projection().messages.every((message) => message.excluded === null)).toBe(true)
    }))

  test("a snapshot that fails is recorded once, and recording resumes when snapshots work again", () =>
    withWorkspace(async (h) => {
      await turn(h, "First.", "a.ts", "2\n")
      h.workspace!.broken = "git add failed: disk full"
      await turn(h, "Second.", "a.ts", "3\n")
      expect(h.log().filter((item) => item.type === "snapshot.unavailable").map((item) => item.data)).toEqual([{ reason: "snapshot_failed", message: "git add failed: disk full" }])
      expect(h.session.projection().session.workspace).toMatchObject({ snapshot: null, unavailable: { reason: "snapshot_failed" } })
      h.workspace!.broken = null
      await turn(h, "Third.", "a.ts", "4\n")
      expect(h.session.projection().session.workspace.unavailable).toBeNull()

      // The second turn has no snapshot to go back to; the third and the first do.
      const users = h.session.projection().messages.filter((message) => message.kind === "user")
      expect(snapshotsSinceDelivery(h.log(), users[1]!.seq).target).toBeNull()
      const partial = await h.session.revert({ messageId: users[1]!.id, dryRun: true })
      expect(partial).toMatchObject({ kind: "preview", plan: { target: null, messages: 6 } })
      // Going back before the first turn restores its snapshot whole. What changed while nothing was recorded cannot
      // be put down to the agent, so it counts as edited by hand and the user is asked before it is overwritten.
      const whole = await h.session.revert({ messageId: users[0]!.id, dryRun: true })
      expect(whole).toMatchObject({ kind: "preview", plan: { unrestorable: null, messages: 9, changes: [{ path: "a.ts", status: "modified", handEdited: true }] } })
      expect(await h.session.revert({ messageId: users[0]!.id })).toMatchObject({ kind: "hand_edited" })
      expect(await h.session.revert({ messageId: users[0]!.id, handEdits: "overwrite" })).toMatchObject({ kind: "reverted", restore: { changed: 1 } })
      expect(h.workspace!.files.get("a.ts")).toBe("1\n")
    }))
})

describe("revert", () => {
  test("a dry run says what would happen and changes nothing", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "b.ts", "new\n")
      const before = h.log().length
      expect(await h.session.revert({ dryRun: true })).toMatchObject({
        kind: "preview",
        plan: { fromSeq: 6, messages: 3, changes: [{ path: "b.ts", status: "deleted", handEdited: false }], kept: [] },
      })
      expect(h.log()).toHaveLength(before)
      expect(files.has("b.ts")).toBe(true)
    }))

  test("files edited by hand since are not overwritten without a decision", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      // After the turn the user edits the file the agent changed, and another one.
      files.set("a.ts", "2 and mine\n")
      files.set("notes.md", "my notes\n")
      const before = h.log().length
      const stopped = await h.session.revert()
      expect(stopped).toMatchObject({
        kind: "hand_edited",
        plan: {
          changes: [
            { path: "a.ts", status: "modified", handEdited: true },
            { path: "notes.md", status: "modified", handEdited: true },
          ],
        },
      })
      expect(h.log()).toHaveLength(before)
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "2 and mine\n", "notes.md": "my notes\n" })
    }))

  test("overwriting them is undoable: the snapshot taken before the restore keeps them", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      files.set("notes.md", "my notes\n")
      expect(await h.session.revert({ handEdits: "overwrite" })).toMatchObject({ kind: "reverted", restore: { changed: 2, kept: [] } })
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "1\n", "notes.md": "notes\n" })
      expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted", restore: { changed: 2 } })
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "2\n", "notes.md": "my notes\n" })
    }))

  test("keeping them restores everything else and records what was kept", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      files.set("notes.md", "my notes\n")
      expect(await h.session.revert({ handEdits: "keep" })).toMatchObject({
        kind: "reverted",
        restore: { changed: 1, kept: [{ path: "notes.md", reason: "hand_edited" }], keptOmitted: 0 },
      })
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "1\n", "notes.md": "my notes\n" })
      expect(h.workspace!.log.at(-2)).toBe("restore a.ts")
    }))

  test("a hand edit made between two steps of the turn is found too, and a file only the agent changed is not", () =>
    withWorkspace(async (h, files) => {
      h.provider.enqueue(
        write("a.ts", "2\n"),
        () => {
          // While the model is thinking about its next step, the user edits a file.
          files.set("notes.md", "mine, mid-turn\n")
          return write("b.ts", "new\n")
        },
        say("Done."),
      )
      h.create().send("Two changes.")
      await h.settled()
      const plan = await h.session.revert({ dryRun: true })
      expect(plan).toMatchObject({
        kind: "preview",
        plan: {
          changes: [
            { path: "a.ts", handEdited: false },
            { path: "b.ts", status: "deleted", handEdited: false },
            { path: "notes.md", handEdited: true },
          ],
        },
      })
    }))

  test("is possible only while idle", () =>
    withWorkspace(async (h) => {
      h.provider.enqueue([script.text("Thinking", { partial: true }), script.hang()])
      h.create().send("Go.")
      await h.seenText("Thinking")
      expect(await h.session.revert()).toEqual({ kind: "refused", reason: "busy", message: "the session can be reverted only while it is idle" })
      h.session.interrupt()
      await h.settled()
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      expect(await h.session.revert()).toEqual({ kind: "refused", reason: "nothing_to_revert", message: "there is no turn to go back before" })
    }))

  test("a prompt sent while a revert is in progress starts once it is done, on the reverted history", () =>
    withWorkspace(async (h) => {
      await turn(h, "First.", "a.ts", "2\n")
      h.provider.enqueue(say("Fresh start."))
      const reverting = h.session.revert()
      h.session.send("Start over.")
      expect(await reverting).toMatchObject({ kind: "reverted" })
      await h.settled()
      const log = types(h)
      expect(log.indexOf("history.reverted")).toBeLessThan(log.lastIndexOf("execution.started"))
      // The reverted turn is gone from what the model sees; that request is a legitimate break of the prefix.
      expect(JSON.stringify(h.provider.requests.at(-1)!.input)).not.toContain("First.")
      expect(h.diagnostics).toEqual([])
    }))

  test("goes back any number of turns to a named message", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      await turn(h, "Second.", "b.ts", "new\n")
      await turn(h, "Third.", "a.ts", "3\n")
      const users = h.session.projection().messages.filter((message) => message.kind === "user")
      expect(await h.session.revert({ messageId: users[1]!.id })).toMatchObject({ kind: "reverted", plan: { messages: 6 }, restore: { changed: 2 } })
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "2\n", "notes.md": "notes\n" })
      expect(h.session.projection().messages.filter((message) => message.excluded === null).map((message) => message.kind)).toEqual(["user", "assistant", "assistant"])
      expect(await h.session.revert({ messageId: "msg_nope" as MessageId })).toMatchObject({ kind: "refused", reason: "not_found" })
      expect(await h.session.revert({ messageId: users[2]!.id })).toMatchObject({ kind: "refused", reason: "not_found" })
    }))

  test("only the latest revert can be undone, in order, and new work makes a revert final", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      await turn(h, "Second.", "a.ts", "3\n")
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      expect(files.get("a.ts")).toBe("1\n")
      expect(h.session.projection().session.reverts).toHaveLength(2)
      // Undo once: the first turn is back. Then new work starts.
      expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted", plan: { messages: 3 } })
      expect(files.get("a.ts")).toBe("2\n")
      await turn(h, "Something else.", "a.ts", "5\n")
      expect(h.session.projection().session.reverts).toEqual([])
      expect(await h.session.undoRevert()).toEqual({ kind: "refused", reason: "nothing_to_revert", message: "there is no revert to undo" })
    }))

  test("a hand edit made after a revert is not overwritten by its undo without a decision", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      files.set("a.ts", "typed by hand after the revert\n")
      expect(await h.session.undoRevert()).toMatchObject({ kind: "hand_edited", plan: { changes: [{ path: "a.ts", handEdited: true }] } })
      expect(files.get("a.ts")).toBe("typed by hand after the revert\n")
      expect(await h.session.undoRevert({ handEdits: "overwrite" })).toMatchObject({ kind: "reverted" })
      expect(files.get("a.ts")).toBe("2\n")
    }))

  test("a revert to before a compaction undoes the compaction for the model, and its undo brings the checkpoint back", async () => {
    const h = new Harness({ workspace: new FakeWorkspace({ "a.ts": "1\n" }) })
    try {
      h.provider.enqueue(
        say("A long explanation."),
        [script.fail("context_overflow", { message: "The input exceeds the context window", status: 400 })],
        say(SUMMARY),
        say("Second answer."),
        say("Third answer."),
      )
      h.create().send("First.")
      await h.settled()
      h.session.send("Second.")
      await h.settled()
      h.session.send("Third.")
      await h.settled()
      const users = h.session.projection().messages.filter((message) => message.kind === "user")
      const compaction = h.session.projection().session.compaction
      const view = () => selectModelHistory(h.session.projection()).messages.map((message) => message.kind)
      expect(compaction).not.toBeNull()
      expect(view()[0]).toBe("compaction")

      // The last turn, after the compaction: as before.
      expect(await h.session.revert()).toMatchObject({ kind: "reverted", plan: { messageId: users[2]!.id } })
      expect(h.session.projection().session.compaction).toEqual(compaction)

      // The second prompt is behind the compaction: it went into the checkpoint. Reverting to before it takes the
      // compaction out too, and history is what it was before that prompt: the first turn, word for word.
      expect(await h.session.revert()).toMatchObject({ kind: "reverted", plan: { messageId: users[1]!.id } })
      expect(h.session.projection().session.compaction).toBeNull()
      expect(view()).toEqual(["user", "assistant"])

      // Undoing that revert puts the turn and the checkpoint back.
      expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted" })
      expect(h.session.projection().session.compaction).toEqual(compaction)
      expect(view()[0]).toBe("compaction")

      // Reverted again, and work carries on from the uncompacted history: the next request is the first turn plus the new prompt.
      expect(await h.session.revert()).toMatchObject({ kind: "reverted", plan: { messageId: users[1]!.id } })
      h.provider.enqueue(say("Another answer."))
      h.session.send("Something else.")
      await h.settled()
      const request = h.provider.requests.at(-1)!
      expect(request.input.map((item) => item.type)).toEqual(["message", "assistant_text", "message"])
      expect(JSON.stringify(request.input)).toContain("A long explanation.")
      expect(JSON.stringify(request.input)).not.toContain("Checkpoint of the earlier conversation")
      expect(h.diagnostics).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a restore that the process dies in is finished when the session is opened again", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      files.set("notes.md", "my notes\n")
      // Dead right after the restore was announced: no file has been touched.
      h.dieAt("revert.started")
      await expect(h.session.revert({ handEdits: "keep" })).rejects.toThrow("killed")
      expect(files.get("a.ts")).toBe("2\n")
      h.restart("wait")
      await h.settled()
      expect(types(h).slice(-4)).toEqual(["snapshot.taken", "revert.started", "snapshot.taken", "history.reverted"])
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "1\n", "notes.md": "my notes\n" })
      // The undo point is the one recorded before the first attempt, and what was to be kept was kept.
      const started = h.log().find((item) => item.type === "revert.started")!
      expect(h.log().at(-1)).toMatchObject({ data: { restore: { before: started.data.before, changed: 1, kept: [{ path: "notes.md", reason: "hand_edited" }] } } })
      expect(await h.session.undoRevert()).toMatchObject({ kind: "reverted" })
      expect(Object.fromEntries(files)).toEqual({ "a.ts": "2\n", "notes.md": "my notes\n" })
    }))

  test("a restore that dies after the files were written is closed on reopening without changing them again", () =>
    withWorkspace(async (h, files) => {
      await turn(h, "First.", "a.ts", "2\n")
      h.dieAt("revert.restored")
      await expect(h.session.revert()).rejects.toThrow("killed")
      expect(files.get("a.ts")).toBe("1\n")
      h.restart()
      await h.settled()
      expect(h.log().at(-1)).toMatchObject({ type: "history.reverted", data: { restore: { changed: 0 } } })
      expect(files.get("a.ts")).toBe("1\n")
    }))
})

describe("with the real snapshot module and the real tools", () => {
  function project() {
    const root = mkdtempSync(join(tmpdir(), "lh-engine-workspace-"))
    scratch.push(root)
    const workspace = join(root, "project")
    mkdirSync(workspace)
    writeFileSync(join(workspace, ".gitignore"), "ignored.log\n")
    writeFileSync(join(workspace, "a.txt"), "alpha\n")
    writeFileSync(join(workspace, "ignored.log"), "kept whatever happens\n")
    const store = openSqliteStore({ path: join(root, "store.db") })
    const provider = new FakeProvider()
    const diagnostics: string[] = []
    const engine: Engine = createEngine({
      approval: null,
      store,
      provider,
      tools: createStandardTools({ spillDir: join(root, "spill") }),
      dataDir: join(root, "data"),
      discover: () => [],
      loadConfig: null,
      log: (line) => diagnostics.push(line),
      strict: true,
    })
    return { root, workspace, store, provider, engine, diagnostics }
  }

  test("a turn's files are restored by a revert and brought back by its undo, and an ignored file is never touched", async () => {
    const { root, workspace, store, provider, engine, diagnostics } = project()
    try {
      provider.enqueue(
        [script.toolCall("call_1", "write", { path: "b.txt", content: "new\n" }), script.toolCall("call_2", "edit", { path: "a.txt", old_string: "alpha", new_string: "beta" })],
        [script.toolCall("call_1", "shell", { command: "rm a.txt && echo more >> ignored.log" })],
        say("Done."),
      )
      const session = engine.createSession({ cwd: workspace, settings: { model: "gpt-test", reasoningEffort: null } })
      session.send("Change things.")
      await session.settled()
      expect(existsSync(join(workspace, "a.txt"))).toBe(false)
      expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("new\n")

      const reverted = await session.revert()
      expect(reverted).toMatchObject({ kind: "reverted", restore: { changed: 2, kept: [] } })
      expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("alpha\n")
      expect(existsSync(join(workspace, "b.txt"))).toBe(false)
      expect(readFileSync(join(workspace, "ignored.log"), "utf8")).toBe("kept whatever happens\nmore\n")

      expect(await session.undoRevert()).toMatchObject({ kind: "reverted", restore: { changed: 2 } })
      expect(existsSync(join(workspace, "a.txt"))).toBe(false)
      expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("new\n")

      // The log's snapshot IDs are trees in the private repository: the first step changed two files, the second removed one.
      const marks = snapshotsAfter(store.readEvents(session.id), 0)
      const snapshotStore = await openSnapshots(workspace, { dataDir: join(root, "data", "snapshots") })
      if (snapshotStore.kind !== "ready") throw new Error(snapshotStore.message)
      const steps = marks.filter((mark) => mark.point === "step_start" || mark.point === "step_end")
      expect(await snapshotStore.changedFiles(steps[0]!.id as never, steps[1]!.id as never)).toEqual(["a.txt", "b.txt"])
      expect(await snapshotStore.changedFiles(steps[2]!.id as never, steps[3]!.id as never)).toEqual(["a.txt"])
      // Nothing was created in the workspace by the harness.
      expect(existsSync(join(workspace, ".git"))).toBe(false)
      expect(diagnostics).toEqual([])
      expectRebuildEqualsLive(store, session.id)
    } finally {
      await engine.close()
      store.close()
    }
  })

  test("without git the session works, says once that there is no undo, and a revert restores no file", async () => {
    const { workspace, store, provider, engine } = project()
    const path = process.env.PATH
    try {
      provider.enqueue([script.toolCall("call_1", "write", { path: "b.txt", content: "new\n" })], say("Done."), say("Again."))
      const session = engine.createSession({ cwd: workspace, settings: { model: "gpt-test", reasoningEffort: null } })
      // No git on PATH for the snapshot module; the write tool needs none.
      process.env.PATH = join(workspace, "no-such-bin")
      session.send("Add b.txt.")
      await session.settled()
      session.send("And again.")
      await session.settled()
      const log = store.readEvents(session.id)
      expect(log.filter((item) => item.type === "snapshot.unavailable").map((item) => item.data.reason)).toEqual(["git_not_found"])
      expect(log.filter((item) => item.type === "execution.succeeded")).toHaveLength(2)
      const users = store.getProjection(session.id)!.messages.filter((message) => message.kind === "user")
      expect(await session.revert({ messageId: users[0]!.id })).toMatchObject({ kind: "reverted", restore: null, plan: { unrestorable: expect.stringContaining("no snapshot") } })
      expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("new\n")
    } finally {
      process.env.PATH = path
      await engine.close()
      store.close()
    }
  })
})
