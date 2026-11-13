/**
 * The verification gate verifies a turn's own work: checks run when the turn
 * changed files, and only then. A hand edit, an undo or an earlier turn that
 * ended with failing checks never makes a turn that only answered run them;
 * what changed outside a turn stays unverified and is checked with the next
 * turn that changes a file. These are the cases around that rule.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { StoredEvent, VerificationOutcome } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { waitFor } from "../../src/testing/wait.ts"
import type { ToolContext } from "../../src/tool/tool.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, type HarnessOptions, converse, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const CHECKS: ConfigFile = { checks: [{ name: "test", command: "bun test", when: ["**/*.ts"] }, { name: "docs", command: "lint docs", when: ["docs/**"] }] }
const call = (name: string, input: Json, callId = "call_1") => [script.toolCall(callId, name, input)]
const write = (path: string, content: string) => call("write", { path, content })
const say = (value: string) => [script.text(value)]
/** What each turn ended as, in order, whether an execution ended there or a queued message followed. */
const endings = (h: Harness): VerificationOutcome[] => h.log().flatMap((item) => (item.type === "execution.succeeded" || item.type === "turn.ended" ? [item.data.verification] : []))
const started = (h: Harness) => h.log().filter((item): item is StoredEvent<"checks.started"> => item.type === "checks.started").map((item) => item.data.checks)

async function project(run: (h: Harness) => Promise<void>, options: HarnessOptions & { readonly snapshots?: boolean } = {}) {
  const { snapshots, ...rest } = options
  const h = new Harness({ config: CHECKS, ...(snapshots === false ? {} : { workspace: new FakeWorkspace({ "a.ts": "1\n", "b.ts": "1\n", "docs/guide.md": "hi\n", "README.md": "hi\n" }) }), ...rest })
  const writes = (input: Record<string, unknown>) => {
    h.workspace?.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}`
  }
  h.tools.on("write", ...Array.from({ length: 8 }, () => writes))
  h.checks.on("test", ...Array.from({ length: 6 }, () => "passed" as const))
  h.checks.on("docs", ...Array.from({ length: 6 }, () => "passed" as const))
  try {
    await run(h)
    // The unused scripted behaviours are spares; what ran is asserted in each test.
    h.verify()
  } finally {
    await h.dispose()
  }
}

describe("a turn that changed nothing runs no check", () => {
  test("after a hand edit: the question ends as not needed, the edit stays unverified, and the next turn that changes a file checks both", () =>
    project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Changed a."), say("It adds numbers."), write("docs/guide.md", "hello\n"), say("Updated the guide."))
      h.create().send("Change a.ts.")
      await h.settled()
      expect(endings(h)).toMatchObject([{ status: "passed" }])
      const verified = h.session.projection().session.verification.verified

      // The user edits a file by hand between the turns, then asks a question.
      h.workspace!.files.set("b.ts", "broken\n")
      h.session.send("What does a.ts do?")
      await h.settled()
      expect(h.checks.ran).toEqual(["test"])
      expect(endings(h)[1]).toEqual({ status: "not_needed", unverified: true })
      // Nothing was verified, so what later checks are selected against did not move.
      expect(h.session.projection().session.verification.verified).toEqual(verified)

      // A turn that changes a file under another check: both checks apply, because b.ts is still unverified.
      h.session.send("Update the guide.")
      await h.settled()
      expect(started(h).at(-1)).toEqual(["test", "docs"])
      expect(endings(h)[2]).toMatchObject({ status: "passed", evidence: { changedFiles: ["b.ts", "docs/guide.md"] } })
    }))

  test("a hand edit no check covers leaves nothing unverified", () =>
    project(async (h) => {
      h.provider.enqueue(say("Hello."), say("Hello again."))
      h.create().send("Hi.")
      await h.settled()
      h.workspace!.files.set("README.md", "by hand\n")
      h.session.send("Hi again.")
      await h.settled()
      expect(h.checks.ran).toEqual([])
      expect(endings(h)).toEqual([{ status: "not_needed" }, { status: "not_needed" }])
      // With nothing to check, what is there now is what later checks are selected against.
      expect(h.session.projection().session.verification.verified?.snapshot).toBe(h.session.projection().session.workspace.snapshot!.id)
    }))

  test("after an undo: the reverted turn's files differ from what was verified, and a question still runs nothing", () =>
    project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Changed a."), say("It is 1 again."), write("b.ts", "2\n"), say("Changed b."))
      h.create().send("Change a.ts.")
      await h.settled()
      expect(await h.session.revert()).toMatchObject({ kind: "reverted" })
      expect(h.workspace!.files.get("a.ts")).toBe("1\n")
      h.session.send("What is in a.ts now?")
      await h.settled()
      expect(h.checks.ran).toEqual(["test"])
      expect(endings(h).at(-1)).toEqual({ status: "not_needed", unverified: true })
      // New work is checked against the state that last passed: a.ts, which went back, and b.ts.
      h.session.send("Change b.ts.")
      await h.settled()
      expect(endings(h).at(-1)).toMatchObject({ status: "passed", evidence: { changedFiles: ["a.ts", "b.ts"] } })
    }))

  test("a turn that changes a file and puts it back changed nothing", () =>
    project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), write("a.ts", "1\n"), say("Tried it and put it back."))
      h.create().send("Try 2 in a.ts.")
      await h.settled()
      expect(h.checks.ran).toEqual([])
      expect(endings(h)).toEqual([{ status: "not_needed" }])
    }))
})

describe("whose turn a change belongs to", () => {
  test("a queued message begins a turn of its own: each turn is checked for what it changed", () =>
    project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Changed a."), say("It is 2."), say("Hello."), write("b.ts", "2\n"), say("Changed b."))
      h.create().send("Change a.ts.")
      h.session.queue("What is in a.ts?")
      await h.settled()
      // The first turn changed a file and was checked; the queued question changed nothing.
      expect(endings(h)).toMatchObject([{ status: "passed" }, { status: "not_needed" }])
      expect(h.checks.ran).toEqual(["test"])
      h.session.send("Hi.")
      h.session.queue("Change b.ts.")
      await h.settled()
      expect(endings(h).slice(2)).toMatchObject([{ status: "not_needed" }, { status: "passed", evidence: { changedFiles: ["b.ts"] } }])
    }))

  test("a steer does not begin a turn: what the turn changed before it is still the turn's", () =>
    project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Changed a, and it is Tuesday."))
      h.tools.on("read", "1")
      h.create().send("Change a.ts.")
      // Delivered at the boundary after the write, with a delivery snapshot of its own.
      await h.seen((item) => item.type === "tool.settled")
      h.session.send("Also, what day is it?")
      await h.settled()
      expect(h.log().filter((item) => item.type === "snapshot.taken" && item.data.point === "delivery")).toHaveLength(2)
      expect(h.checks.ran).toEqual(["test"])
      expect(endings(h)).toMatchObject([{ status: "passed", evidence: { changedFiles: ["a.ts"] } }])
    }))

  test("a subagent's changes are its parent's turn's changes", () =>
    project(
      async (h) => {
        converse(h.provider, {
          "Delegate": [[...call("subagent", { task: "Change a.ts" })], say("The subagent changed a.ts.")],
          "Change a.ts": [[...write("a.ts", "2\n")], say("Changed.")],
        })
        h.create().send("Delegate the change.")
        await h.settled()
        // The parent called no tool that writes; the workspace changed during its step all the same.
        expect(h.checks.ran).toEqual(["test"])
        expect(endings(h)).toMatchObject([{ status: "passed", evidence: { changedFiles: ["a.ts"] } }])
      },
      { spawn: {} },
    ))

  test("a background command that changes files after its turn ended: the turn its exit starts verifies them", () =>
    project(
      async (h) => {
        let end: (result: { exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string }) => void = () => {}
        const exited = new Promise<Parameters<typeof end>[0]>((resolve) => (end = resolve))
        h.tools.on("shell", (_input: Record<string, unknown>, context: ToolContext) => `Started in the background as ${context.background!.command({ command: "codegen", logPath: null, stop: async () => {}, output: () => "", exited }).id}.`)
        h.provider.enqueue(call("shell", { command: "codegen", background: true }), say("Generating."), say("Generated."))
        h.create().send("Generate the code in the background.")
        await h.settled()
        expect(endings(h)).toEqual([{ status: "not_needed" }])
        const before = h.log().length
        // The command writes a file and exits while the session is idle: its message starts a turn.
        h.workspace!.files.set("generated.ts", "export const x = 1\n")
        end({ exitCode: 0, signal: null, timedOut: false, durationMs: 1000, output: "done\n" })
        await h.seen((item) => item.type === "execution.started" && "seq" in item && item.seq > before)
        await h.settled()
        expect(h.checks.ran).toEqual(["test"])
        expect(endings(h)[1]).toMatchObject({ status: "passed", evidence: { changedFiles: ["generated.ts"] } })
      },
      { spawn: {} },
    ))
})

describe("without snapshots", () => {
  test("a turn counts as having changed files when a call that can change them ran in it, and not otherwise", () =>
    project(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Changed a."), say("Because of a.ts."), write("b.ts", "2\n"), say("Changed b."))
        h.checks.on("test", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        // The scripted queue has passes first; the order of the queue is the order checks run in.
        expect(h.checks.ran).toEqual(["test", "docs"])
        h.session.send("Why?")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "docs"])
        expect(endings(h)[1]).toEqual({ status: "not_needed" })
        h.session.send("Change b.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "docs", "test", "docs"])
      },
      { snapshots: false },
    ))
})

describe("a compaction the user asks for", () => {
  const at = (tokens: number) => script.usage({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0 })

  test("while idle: an execution of its own, a checkpoint, no step and no check; the next turn starts from it", async () => {
    await project(
      async (h) => {
        h.provider.enqueue([...write("a.ts", "2\n"), at(3000)], [script.text("Changed a."), at(3200)], [script.text(SUMMARY)], [script.text("It is 2."), at(900)])
        h.create().send("Change a.ts.")
        await h.settled()
        const before = h.log().length
        const result = await h.session.compact()
        expect(result).toMatchObject({ kind: "compacted", source: "model", detail: null })
        await h.settled()
        expect(h.log().slice(before).map((item) => item.type)).toEqual(["execution.started", "compaction.started", "compaction.ended", "snapshot.taken", "execution.succeeded"])
        expect(h.log().find((item) => item.type === "compaction.started")!.data).toMatchObject({ trigger: "manual", mode: "normal" })
        // Nothing of this execution's to verify, and no check ran for it.
        expect(h.checks.ran).toEqual(["test"])
        expect(endings(h).at(-1)).toEqual({ status: "not_needed" })
        // A second request right away finds nothing left to take out (a checkpoint and what followed it), and writes nothing.
        const again = h.log().length
        expect(await h.session.compact()).toEqual({ kind: "nothing", message: "There is nothing to compact: what is in the model's view is what the next request needs (the latest input, or a checkpoint and what followed it)." })
        expect(h.log()).toHaveLength(again)
        // The baseline is set again when the next step is about to be sent, and the request starts from the checkpoint.
        h.session.send("What is in a.ts?")
        await h.settled()
        const after = h.provider.requests.at(-1)!
        // The checkpoint, the model's last answer (what the tail rule always keeps), and the new message.
        expect(after.input.map((item) => item.type)).toEqual(["message", "assistant_text", "message"])
        expect(JSON.stringify(after.input[0])).toContain("Checkpoint of the earlier conversation")
        expect(after.tools).toEqual(h.provider.requests[0]!.tools)
        expect(h.log().filter((item) => item.type === "baseline.set")).toHaveLength(2)
      },
      { limits: { manualCompactionMinTokens: 0 } },
    )
  })

  test("says plainly when there is nothing worth compacting, and writes nothing", () =>
    project(async (h) => {
      expect(await h.create().compact()).toEqual({ kind: "nothing", message: "There is nothing to compact: the conversation has not started." })
      h.provider.enqueue(say("Hello."))
      h.session.send("Hi.")
      await h.settled()
      const before = h.log().length
      const result = await h.session.compact()
      expect(result.kind).toBe("nothing")
      expect(result.kind === "nothing" ? result.message : "").toStartWith("Not compacted: only about ")
      expect(h.log()).toHaveLength(before)
    }))

  test("while a turn runs: made at the boundary after the step in progress, and the turn carries on from the checkpoint", async () => {
    await project(
      async (h) => {
        h.provider.enqueue([...call("read", { path: "a.ts" }), at(3000)], [script.text(SUMMARY)], [script.text("It is 1."), at(900)])
        let asked: Promise<unknown> = Promise.resolve()
        h.tools.on("read", () => {
          // Asked while the step's tool runs.
          asked = h.session.compact()
          return "1"
        })
        h.create().send("What is in a.ts?")
        await h.settled()
        expect(await asked).toMatchObject({ kind: "compacted" })
        const types = h.log().map((item) => item.type)
        // After the step that was in progress, before the next one, under the same execution.
        expect(types.slice(types.indexOf("step.ended"))).toEqual(["step.ended", "compaction.started", "compaction.ended", "baseline.set", "step.started", "text.ended", "step.ended", "snapshot.taken", "execution.succeeded"])
        expect(types.filter((type) => type === "execution.started")).toHaveLength(1)
        // The step that was in progress is what the next call answers, so it is kept word for word.
        expect(h.provider.requests.at(-1)!.input.some((item) => item.type === "tool_result")).toBe(true)
      },
      { limits: { manualCompactionMinTokens: 0 } },
    )
  })

  test("an interrupt during the summary call leaves history as it was and says so", async () => {
    await project(
      async (h) => {
        h.provider.enqueue([...write("a.ts", "2\n"), at(3000)], [script.text("Changed a."), at(3200)], [script.hang()])
        h.create().send("Change a.ts.")
        await h.settled()
        const asked = h.session.compact()
        await h.seen((item) => item.type === "compaction.started")
        h.session.interrupt()
        expect(await asked).toEqual({ kind: "failed", message: "The compaction was interrupted; the conversation is unchanged." })
        await h.settled()
        expect(h.session.projection().session.compaction).toBeNull()
        expect(h.session.projection().session.execution).toBeNull()
        // Nothing of the model's was cut short, so no marker was left for it.
        expect(h.session.projection().messages.filter((message) => message.kind === "synthetic")).toEqual([])
      },
      { limits: { manualCompactionMinTokens: 0 } },
    )
  })

  test("a shutdown during the summary call leaves nothing to resume: the claim is released, history is as it was, and the next request starts an execution of its own", async () => {
    await project(
      async (h) => {
        h.provider.enqueue([...write("a.ts", "2\n"), at(3000)], [script.text("Changed a."), at(3200)], [script.hang()], [script.text(SUMMARY)])
        h.create().send("Change a.ts.")
        await h.settled()
        const view = selectModelHistory(h.session.projection()).messages.map((message) => message.id)
        const before = h.log().length
        const asked = h.session.compact()
        await h.seen((item) => item.type === "compaction.started")
        // The user leaves (the client closes the session) while the summary is being written.
        await h.session.close()
        expect(await asked).toEqual({ kind: "failed", message: "The compaction was interrupted; the conversation is unchanged." })
        const ending = h.log().slice(before)
        expect(ending.map((item) => item.type)).toEqual(["execution.started", "compaction.started", "execution.interrupt_requested", "compaction.failed", "execution.interrupted"])
        // Not a shutdown's interruption, which would keep the claim for the next start.
        expect(ending.at(-1)!.data).toMatchObject({ reason: "user" })

        // The next start: no claim to take up, in either mode, and nothing is appended by opening.
        await h.dispose()
        const session = h.restart("start")
        await h.settled()
        expect(h.log()).toHaveLength(before + ending.length)
        expect(session.projection().session.execution).toBeNull()
        expect(session.projection().session.compaction).toBeNull()
        expect(session.projection().messages.filter((message) => message.kind === "synthetic")).toEqual([])
        expect(selectModelHistory(session.projection()).messages.map((message) => message.id)).toEqual(view)
        // Asked again, the compaction is made under an execution of its own: nothing is resumed.
        expect(await session.compact()).toMatchObject({ kind: "compacted" })
        await h.settled()
        expect(h.log().slice(before + ending.length).map((item) => item.type)).toEqual(["execution.started", "compaction.started", "compaction.ended", "snapshot.taken", "execution.succeeded"])
        expect(h.log().some((item) => item.type === "execution.resumed")).toBe(false)
      },
      { limits: { manualCompactionMinTokens: 0 } },
    )
  })

  test("a process killed during the summary call leaves nothing to resume either: the next start closes the compaction, releases the claim, and history is as it was", async () => {
    await project(
      async (h) => {
        h.provider.enqueue([...write("a.ts", "2\n"), at(3000)], [script.text("Changed a."), at(3200)], () => {
          // The process dies while the summary is being written: nothing more reaches the log.
          h.kill()
          return [script.hang()]
        })
        h.create().send("Change a.ts.")
        await h.settled()
        const view = selectModelHistory(h.session.projection()).messages.map((message) => message.id)
        const before = h.log().length
        void h.session.compact()
        await waitFor(() => !(h.provider.calls.length < 3), { intervalMs: 1 })

        // The next start, in the mode that takes a claim up again: there is none to take up.
        h.provider.enqueue([script.text(SUMMARY)])
        const session = h.restart("start")
        await h.settled()
        const recovered = h.log().slice(before)
        expect(recovered.map((item) => item.type)).toEqual(["execution.started", "compaction.started", "compaction.failed", "execution.interrupt_requested", "execution.interrupted"])
        expect(recovered[2]!.data).toMatchObject({ error: { kind: "crashed" } })
        expect(recovered.at(-1)!.data).toMatchObject({ reason: "user" })
        // No summary was asked for behind the user's back, and nothing was resumed.
        expect(h.provider.calls).toHaveLength(3)
        expect(h.log().some((item) => item.type === "execution.resumed")).toBe(false)
        expect(session.projection().session.execution).toBeNull()
        expect(session.projection().session.compaction).toBeNull()
        expect(session.projection().messages.filter((message) => message.kind === "synthetic")).toEqual([])
        expect(selectModelHistory(session.projection()).messages.map((message) => message.id)).toEqual(view)
        // Asked again, the compaction is made under an execution of its own.
        expect(await session.compact()).toMatchObject({ kind: "compacted" })
        await h.settled()
        expect(h.log().slice(before + recovered.length).map((item) => item.type)).toEqual(["execution.started", "compaction.started", "compaction.ended", "snapshot.taken", "execution.succeeded"])
      },
      { limits: { manualCompactionMinTokens: 0 } },
    )
  })

  test("a shutdown during a turn that the compaction was asked in still keeps the turn for the next start", async () => {
    await project(
      async (h) => {
        h.provider.enqueue([...call("read", { path: "a.ts" }), at(3000)], [script.hang()])
        let asked: Promise<unknown> = Promise.resolve()
        h.tools.on("read", () => {
          asked = h.session.compact()
          return "1"
        })
        h.create().send("What is in a.ts?")
        await h.seen((item) => item.type === "compaction.started")
        await h.session.close()
        expect(await asked).toMatchObject({ kind: "failed" })
        expect(h.log().at(-1)).toMatchObject({ type: "execution.interrupted", data: { reason: "shutdown" } })
        expect(h.engine.getSession(h.session.id)!.session.execution).toMatchObject({ status: "suspended" })
      },
      { limits: { manualCompactionMinTokens: 0 } },
    )
  })
})

describe("renaming a session", () => {
  test("appends session.renamed, at any time, and the title is what a listing shows", () =>
    project(async (h) => {
      const session = h.create()
      expect(session.rename("  Fix the\n importer ")).toBe("Fix the importer")
      expect(h.log().at(-1)).toMatchObject({ type: "session.renamed", data: { title: "Fix the importer" } })
      expect(h.engine.getSession(session.id)!.session.title).toBe("Fix the importer")
      // The same title again writes nothing; an empty one is refused.
      const before = h.log().length
      session.rename("Fix the importer")
      expect(h.log()).toHaveLength(before)
      expect(() => session.rename("   ")).toThrow("a session's title cannot be empty")
      // While a turn runs, too.
      h.provider.enqueue(call("read", { path: "a.ts" }), say("It is 1."))
      h.tools.on("read", () => {
        session.rename("Importer, fixed")
        return "1"
      })
      session.send("What is in a.ts?")
      await h.settled()
      expect(session.projection().session.title).toBe("Importer, fixed")
    }))
})

describe("the files a turn changed", () => {
  const changes = (h: Harness) => h.seenEvents.flatMap((item) => (item.type === "workspace.changes" ? [[...item.files]] : []))

  test("each turn has its own, live and read back from the log: also a turn that ended because a queued message waited", () =>
    project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Changed a."), write("b.ts", "2\n"), say("Changed b."), say("Nothing to do."))
      h.create().send("Change a.ts.")
      h.session.queue("Change b.ts.")
      await h.settled()
      h.session.send("Anything else?")
      await h.settled()
      // Live: announced right before each turn ends, and only that turn's files.
      expect(changes(h)).toEqual([["a.ts"], ["b.ts"]])
      // From the stored log, for a client that shows the session later: one entry per turn, keyed by the event that ended it.
      const ends = h.log().filter((item) => item.type === "turn.ended" || item.type === "execution.succeeded")
      expect(ends.map((item) => item.type)).toEqual(["turn.ended", "execution.succeeded", "execution.succeeded"])
      const read = await h.engine.turnChanges(h.session.id)
      expect(read).toEqual([
        { endSeq: ends[0]!.seq, executionId: "exe_1", files: ["a.ts"] },
        { endSeq: ends[1]!.seq, executionId: "exe_1", files: ["b.ts"] },
        { endSeq: ends[2]!.seq, executionId: "exe_2", files: [] },
      ] as never)
      expect(await h.engine.turnChanges(h.session.id, { last: 1 })).toHaveLength(1)
    }))

  test("a steer's snapshot belongs to the turn it redirects; without snapshots nobody can tell", async () => {
    await project(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), write("b.ts", "2\n"), say("Changed both."))
      h.create().send("Change a.ts.")
      await h.seen((item) => item.type === "tool.settled")
      h.session.send("And b.ts.")
      await h.settled()
      expect(changes(h)).toEqual([["a.ts", "b.ts"]])
      expect((await h.engine.turnChanges(h.session.id)).map((turn) => turn.files)).toEqual([["a.ts", "b.ts"]])
    })
    await project(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Changed a."))
        h.create().send("Change a.ts.")
        await h.settled()
        expect((await h.engine.turnChanges(h.session.id)).map((turn) => turn.files)).toEqual([null])
      },
      { snapshots: false },
    )
  })
})
