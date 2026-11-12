/**
 * The approval layer in the loop: what runs, what runs in the sandbox, what
 * asks and what is refused; the order of the calls of one step; the answers
 * and what they remember; taint; redaction; and what an interrupt, a crash,
 * a steer, a revert and a compaction do to all of that.
 *
 * The tools are scripted and the sandbox is a stand-in that only says
 * whether it is available: what is tested here is the loop's decisions and
 * its log. Real sandboxed processes are in `test/sandbox/workflows.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import { FAILURE_TEXT, TOOL_TEXT } from "../../src/engine/constants.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { CallId, MessageId } from "../../src/id.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { redactPieces } from "../../src/approval/redact.ts"
import { redactingStream } from "../../src/tool/redact-stream.ts"
import type { SandboxRun, ToolContext } from "../../src/tool/tool.ts"
import { CHECKS_CONFIG } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, type HarnessOptions, ScriptedTools, failed, removeHarnessDirectories, untilAbort } from "./harness.ts"

afterAll(removeHarnessDirectories)

const SECRET = "hunter2-very-secret-value"

/** A sandbox that plans nothing: the scripted tools spawn no process. It says whether one exists, and names the session's temp directory. */
const sandbox = (available = true): CommandSandbox => ({
  state: available ? { available: true } : { available: false, reason: "bubblewrap (bwrap) is not installed.", remedy: "Install bubblewrap." },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
})

const setup = (more: Partial<ApprovalSetup> = {}): ApprovalSetup => ({ sandbox: sandbox(), secrets: [SECRET], home: "/home/user", ...more })

async function withHarness(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness({ approval: setup(), ...options })
  try {
    await run(h)
    h.verify()
  } finally {
    await h.dispose()
  }
}

const shell = (command: string, callId = "call_1", extra: Record<string, unknown> = {}) => script.toolCall(callId, "shell", { command, ...extra })
const write = (path: string, callId = "call_1") => script.toolCall(callId, "write", { path, content: "x" })
const read = (path: string, callId = "call_1") => script.toolCall(callId, "read", { path })
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const types = (h: Harness) => h.log().map((item) => item.type)
const settled = (h: Harness) => of(h, "tool.settled").map((item) => [String(item.data.callId), item.data.outcome, item.data.output])
const asked = (h: Harness) => h.seen((item) => item.type === "approval.requested").then((item) => (item as StoredEvent<"approval.requested">).data)
const target = (data: { messageId: MessageId; callId: CallId }) => ({ messageId: data.messageId, callId: data.callId })

describe("mode auto with a sandbox", () => {
  test("a workspace edit runs and a command runs in the sandbox, without a question, and the log says how each ran", () =>
    withHarness(async (h) => {
      const contexts: (SandboxRun | null | undefined)[] = []
      h.provider.enqueue([write("src/a.ts", "call_1"), shell("bun test", "call_2")], [script.text("Done.")])
      h.tools.on("write", (_, context: ToolContext) => (contexts.push(context.sandbox), "written"))
      h.tools.on("shell", (_, context: ToolContext) => (contexts.push(context.sandbox), "1 pass"))
      h.create().send("Fix it.")
      await h.settled()
      expect(types(h).filter((type) => type.startsWith("approval."))).toEqual([])
      expect(of(h, "tool.started").map((item) => item.data.run)).toEqual([
        { mode: "auto", origin: "builtin", paths: [{ given: "src/a.ts", real: "/repo/src/a.ts", place: "workspace", relative: "src/a.ts" }], sandbox: null },
        { mode: "auto", origin: "builtin", paths: [], sandbox: { network: false, writableRoots: [] } },
      ])
      // The tool is told the same thing the log records: the edit runs as it is, the command in the sandbox.
      expect(contexts).toEqual([null, { network: false, writableRoots: [] }])
      expect(types(h).at(-1)).toBe("execution.succeeded")
    }))

  test("the file tools are handed the session's temp directory under the name commands see it by, and a file there neither asks nor taints", () =>
    withHarness(async (h) => {
      let temp: ToolContext["temp"]
      h.provider.enqueue([write("/tmp/scratch.py")], [read("/tmp/scratch.py")], [script.text("Done.")])
      h.tools.on("write", (_, context: ToolContext) => ((temp = context.temp), "written"))
      h.tools.on("read", "print(1)")
      const session = h.create()
      session.send("Try it.")
      await h.settled()
      expect(temp).toEqual({ dir: `/sandbox-tmp/${session.id}`, alias: "/tmp" })
      expect(of(h, "tool.started")[0]!.data.run?.paths).toEqual([{ given: "/tmp/scratch.py", real: `/sandbox-tmp/${session.id}/scratch.py`, place: "workspace", relative: null }])
      expect(types(h).filter((type) => type.startsWith("approval.") || type.startsWith("taint."))).toEqual([])
    }))

  test("a write outside the workspace asks; into a credential store it is refused by the policy without a question", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([write("/etc/motd", "call_1"), write("~/.ssh/authorized_keys", "call_2")], [script.text("Done.")])
        h.tools.on("write", "written")
        const session = h.create()
        session.send("Go.")
        const question = await asked(h)
        expect(question.question.title).toBe("Allow write: writing /etc/motd?")
        expect(question.needs).toEqual([{ kind: "write", path: "/etc/motd", root: "/etc", protectedRoot: null }])
        expect(session.approval()?.pending?.question.subject).toBe("/etc/motd")
        expect(session.answer(target(question), { choice: "once" })).toBe(true)
        await h.settled()
        expect(of(h, "approval.denied").map((item) => [String(item.data.callId), item.data.reason, item.data.stop])).toEqual([["call_2", "policy", false]])
        expect(settled(h)).toEqual([
          ["call_1", "success", "written"],
          ["call_2", "error", "Not run: write may not write /home/user/.ssh/authorized_keys: it is a credential store or the harness's own data."],
        ])
        // The denial and the result the model sees are one append.
        const denied = of(h, "approval.denied")[0]!
        expect(h.log().find((item) => item.seq === denied.seq + 1)?.type).toBe("tool.settled")
      },
      { attended: true },
    ))
})

describe("a command that needs the network", () => {
  test("it fails in the sandbox with the hint, the model asks, the user approves once, it runs with the network, the session is tainted, and the next request asks again", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue(
          [shell("curl -s https://example.com")],
          [shell("curl -s https://example.com", "call_1", { sandbox: { network: true } })],
          [shell("curl -s https://example.com/next", "call_1", { sandbox: { network: true } })],
          [script.text("Done.")],
        )
        h.tools.on(
          "shell",
          () => ({ ...failed("curl: (6) Could not resolve host: example.com\n[Exit code 6]"), display: { exitCode: 6 } }),
          (_, context: ToolContext) => `network=${context.sandbox?.network}`,
          "more",
        )
        const session = h.create()
        session.send("Fetch it.")
        const first = await asked(h)
        // The failure came back with the note that says how to ask.
        expect(settled(h)[0]![2]).toBe(
          'curl: (6) Could not resolve host: example.com\n[Exit code 6]\n[sandbox] This command ran in the sandbox (no network, and writes only inside the workspace and the temp directory), and its output shows an error the sandbox can cause. If it needs that access, run it again with `sandbox: { "network": true }`; the user will be asked.',
        )
        expect(first.question.title).toBe("Allow network access for this command?")
        expect(first.question.subject).toBe("curl -s https://example.com")
        expect(first.then).toEqual({ kind: "run_sandboxed", network: true, writableRoots: [] })
        expect(first.escalation).toEqual({ network: true, write: [] })
        expect(first.question.choices.map((choice) => choice.id)).toEqual(["once", "session", "deny"])
        session.answer(target(first), { choice: "once" })

        const second = (await h.seen((item) => item.type === "approval.requested" && item.seq > (h.log().find((entry) => entry.type === "approval.answered")?.seq ?? 0))) as StoredEvent<"approval.requested">
        // The command ran with the network, which taints: the user is told once, and the question now says so.
        expect(settled(h)[1]).toEqual(["call_1", "success", "network=true"])
        expect(of(h, "tool.started")[1]!.data.run?.sandbox).toEqual({ network: true, writableRoots: [] })
        expect(of(h, "taint.noticed").map((item) => item.data)).toEqual([
          {
            source: { at: of(h, "tool.settled")[1]!.seq, tool: "shell", kind: "network-command", path: null },
            text: "Content from a command that ran with network access is in this conversation and may contain instructions aimed at the model.",
          },
        ])
        expect(second.data.question.details).toContain("Approvals for this given before that content arrived do not apply.")
        session.answer(target(second.data), { choice: "deny" })
        await h.settled()
        expect(settled(h)[2]).toEqual(["call_1", "error", "Not run: the user declined this call."])
        expect(of(h, "taint.noticed")).toHaveLength(1)
        expect(h.session.projection().session.approval?.taint?.source.kind).toBe("network-command")
      },
      { attended: true },
    ))

  test("network approved for the session stops applying once that very command has brought untrusted content in", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("curl a", "call_1", { sandbox: { network: true } })], [shell("curl b", "call_1", { sandbox: { network: true } })], [script.text("Done.")])
        h.tools.on("shell", "a", "b")
        const session = h.create()
        session.send("Fetch.")
        session.answer(target(await asked(h)), { choice: "session" })
        const again = (await h.seen((item) => item.type === "approval.requested" && item.seq > of(h, "approval.answered")[0]!.seq)) as StoredEvent<"approval.requested">
        expect(h.session.projection().session.approval?.grants).toEqual([{ scope: "session", rule: { kind: "sandbox-network" }, at: of(h, "approval.answered")[0]!.seq, grantedAt: expect.any(Number) }])
        session.answer(target(again.data), { choice: "session" })
        await h.settled()
        expect(settled(h).map((entry) => entry[1])).toEqual(["success", "success"])
      },
      { attended: true },
    ))
})

describe("mode ask", () => {
  test("a read runs without a question, also while the edit beside it waits for its answer", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([read("a.ts", "call_1"), write("a.ts", "call_2")], [script.text("Done.")])
        h.tools.on("read", "content").on("write", "written")
        const session = h.create()
        session.setApproval({ mode: "ask" })
        session.send("Go.")
        const edit = await asked(h)
        expect(edit.question.title).toBe("Allow write: writing /repo/a.ts?")
        await h.seen((item) => item.type === "tool.settled")
        expect(settled(h)).toEqual([["call_1", "success", "content"]])
        session.answer(target(edit), { choice: "once" })
        await h.settled()
        expect(settled(h).map((entry) => entry[1])).toEqual(["success", "success"])
      },
      { attended: true },
    ))

  test("an approval remembered for the session covers the next command, and a refusal with a note is what the model reads", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("bun test")], [shell("bun run lint")], [write("b.ts")], [script.text("Done.")])
        h.tools.on("shell", "1 pass", "clean")
        const session = h.create()
        session.setApproval({ mode: "ask" })
        session.send("Go.")
        const command = await asked(h)
        session.answer(target(command), { choice: "session" })
        const edit = (await h.seen((item) => item.type === "approval.requested" && item.seq > of(h, "approval.answered")[0]!.seq)) as StoredEvent<"approval.requested">
        // Two commands ran on one answer; the edit is another capability and asks.
        expect(settled(h)).toEqual([
          ["call_1", "success", "1 pass"],
          ["call_1", "success", "clean"],
        ])
        expect(of(h, "approval.requested")).toHaveLength(2)
        session.answer(target(edit.data), { choice: "deny", note: "  not that file  " })
        await h.settled()
        expect(settled(h)[2]).toEqual(["call_1", "error", "Not run: the user declined this call. Their note: not that file"])
        expect(of(h, "approval.answered").map((item) => [item.data.choice, item.data.approve, item.data.note, item.data.grants.length])).toEqual([
          ["session", true, null, 1],
          ["deny", false, "not that file", 0],
        ])
        expect(h.tools.ran.map((call) => call.name)).toEqual(["shell", "shell"])
      },
      { attended: true },
    ))

  test("an approval with a note runs the call and puts the note before its output", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("rm -rf build")], [script.text("Done.")])
        h.tools.on("shell", "removed")
        const session = h.create()
        session.setApproval({ mode: "ask" })
        session.send("Clean.")
        session.answer(target(await asked(h)), { choice: "once", note: "only the build directory" })
        await h.settled()
        expect(settled(h)).toEqual([["call_1", "success", "The user approved this call with a note: only the build directory\n\nremoved"]])
      },
      { attended: true },
    ))
})

describe("nobody present", () => {
  test("a call that would ask is refused with the reason, nothing waits, and the run goes on", () =>
    withHarness(async (h) => {
      h.provider.enqueue([shell("curl example.com", "call_1", { sandbox: { network: true } })], [script.text("I could not fetch it.")])
      h.create().send("Fetch it.")
      await h.settled()
      expect(of(h, "approval.requested")).toEqual([])
      expect(of(h, "approval.denied").map((item) => item.data)).toMatchObject([{ reason: "unattended", stop: false, needs: [{ kind: "sandbox-network" }], escalation: { network: true, write: [] } }])
      expect(settled(h)).toEqual([["call_1", "error", "Not run: this call needs the user's approval for network access for this command, and this run has no one to approve it."]])
      expect(h.tools.ran).toEqual([])
      expect(types(h).at(-1)).toBe("execution.succeeded")
    }))

  test("with the unattended behaviour `stop` the refusal ends the run, and what had not started does not start", () =>
    withHarness(async (h) => {
      h.provider.enqueue([shell("curl example.com", "call_1", { sandbox: { network: true } }), write("a.ts", "call_2")])
      const session = h.create()
      session.setApproval({ unattended: "stop" })
      session.send("Fetch it.")
      await h.settled()
      const refusal = "Not run: this call needs the user's approval for network access for this command, and this run has no one to approve it."
      expect(settled(h)).toEqual([
        ["call_1", "error", refusal],
        ["call_2", "not_started", TOOL_TEXT.notStarted],
      ])
      expect(of(h, "approval.denied")[0]!.data.stop).toBe(true)
      expect(of(h, "execution.failed").map((item) => item.data)).toEqual([{ executionId: expect.any(String), message: FAILURE_TEXT.approvalStop(refusal), cause: "approval" }])
      expect(h.provider.calls).toHaveLength(1)
    }))
})

describe("no sandbox on this machine", () => {
  test("auto does not become full: a command asks, the question says why, and what is remembered is commands without the sandbox", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("bun test")], [script.text("Done.")])
        h.tools.on("shell", (_, context: ToolContext) => `sandbox=${JSON.stringify(context.sandbox)}`)
        const session = h.create()
        session.send("Test.")
        const question = await asked(h)
        expect(question.question.title).toBe("Run this command without the sandbox?")
        expect(question.question.details).toEqual([
          "The sandbox is unavailable on this machine: bubblewrap (bwrap) is not installed.",
          "The command would run with your full permissions, including the network and your credentials.",
        ])
        expect(question.then).toEqual({ kind: "run" })
        session.answer(target(question), { choice: "once" })
        await h.settled()
        expect(settled(h)).toEqual([["call_1", "success", "sandbox=null"]])
        expect(of(h, "tool.started")[0]!.data.run).toEqual({ mode: "auto", origin: "builtin", paths: [], sandbox: null })
        expect(h.seenEvents.filter((item) => item.type === "notice").map((item) => (item as { kind: string }).kind)).toEqual(["sandbox_unavailable"])
      },
      { attended: true, approval: setup({ sandbox: sandbox(false) }) },
    ))

  test("unattended, every command is refused, and the project's checks are not run and the user is told", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("bun test")], [script.text("I could not run it.")])
        h.create().send("Test.")
        await h.settled()
        expect(of(h, "approval.denied")[0]!.data).toMatchObject({ reason: "unattended", needs: [{ kind: "exec-unsandboxed" }] })
        expect(of(h, "checks.started")).toEqual([])
        expect(of(h, "execution.succeeded")[0]!.data.verification).toEqual({ status: "not_configured" })
        expect(h.seenEvents.filter((item) => item.type === "notice").map((item) => (item as { kind: string }).kind)).toEqual(["sandbox_unavailable", "checks_not_run"])
      },
      { approval: setup({ sandbox: sandbox(false) }), config: CHECKS_CONFIG },
    ))
})

describe("mode full", () => {
  test("nothing asks and nothing is sandboxed, until untrusted content is in the conversation: then commands run in the sandbox", () =>
    withHarness(async (h) => {
      const ran: (SandboxRun | null | undefined)[] = []
      h.provider.enqueue([shell("make", "call_1"), write("/etc/motd", "call_2")], [read("/home/user/notes.txt")], [shell("make")], [script.text("Done.")])
      h.tools.on("shell", (_, context: ToolContext) => (ran.push(context.sandbox), "ok"), (_, context: ToolContext) => (ran.push(context.sandbox), "ok")).on("write", "written").on("read", "notes")
      const session = h.create()
      session.setApproval({ mode: "full" })
      session.send("Go.")
      await h.settled()
      expect(types(h).filter((type) => type.startsWith("approval."))).toEqual([])
      expect(of(h, "taint.noticed").map((item) => [item.data.source.kind, item.data.source.path])).toEqual([["outside-file", "/home/user/notes.txt"]])
      expect(ran).toEqual([null, { network: false, writableRoots: [] }])
    }))
})

describe("the order of the calls of one step", () => {
  test("reads start at once; what can change something runs one at a time, in the order written", () =>
    withHarness(async (h) => {
      const order: string[] = []
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      h.provider.enqueue([write("a.ts", "call_1"), shell("bun test", "call_2"), read("b.ts", "call_3"), write("c.ts", "call_4")], [script.text("Done.")])
      h.tools
        .on("write", async () => (order.push("write a starts"), await held, order.push("write a ends"), "a"), () => (order.push("write c"), "c"))
        .on("shell", () => (order.push("shell"), "ok"))
        .on("read", () => (order.push("read b"), "b"))
      h.create().send("Go.")
      await h.seen((item) => item.type === "tool.settled")
      // The read ran while the first write was still running; the command and the second write have not started.
      expect(order).toEqual(["write a starts", "read b"])
      expect(of(h, "tool.started").map((item) => String(item.data.callId))).toEqual(["call_1", "call_3"])
      release()
      await h.settled()
      expect(order.slice(2)).toEqual(["write a ends", "shell", "write c"])
      // No write is decided or started while a command runs: each start follows the result of the one before it in the line.
      const line = h.log().filter((item) => (item.type === "tool.started" || item.type === "tool.settled") && String(item.data.callId) !== "call_3")
      expect(line.map((item) => `${item.type} ${(item.data as { callId: string }).callId}`)).toEqual([
        "tool.started call_1",
        "tool.settled call_1",
        "tool.started call_2",
        "tool.settled call_2",
        "tool.started call_4",
        "tool.settled call_4",
      ])
    }))

  test("a question suspends its call and what comes after it in the line, and nothing else", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("curl x", "call_1", { sandbox: { network: true } }), read("b.ts", "call_2"), write("c.ts", "call_3")], [script.text("Done.")])
        h.tools.on("shell", "fetched").on("read", "b").on("write", "c")
        const session = h.create()
        session.send("Go.")
        const question = await asked(h)
        await h.seen((item) => item.type === "tool.settled")
        expect(settled(h)).toEqual([["call_2", "success", "b"]])
        expect(h.tools.ran.map((call) => call.name)).toEqual(["read"])
        session.answer(target(question), { choice: "once" })
        await h.settled()
        expect(settled(h).map((entry) => entry[0])).toEqual(["call_2", "call_1", "call_3"])
      },
      { attended: true },
    ))

  test("questions are asked one at a time, and an answer that covers the next call spares it its question", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([read("~/.ssh/config", "call_1"), write("/opt/x/a", "call_2"), write("/opt/x/b", "call_3")], [script.text("Done.")])
        h.tools.on("read", "Host *").on("write", "a", "b")
        const session = h.create()
        session.send("Go.")
        const first = await asked(h)
        // The read of a credential store asks, and can only be allowed once.
        expect(String(first.callId)).toBe("call_1")
        expect(first.question.choices.map((choice) => choice.id)).toEqual(["once", "deny"])
        // The write behind it reached its own question meanwhile; it is not put until this one is answered.
        expect(of(h, "approval.requested")).toHaveLength(1)
        session.answer(target(first), { choice: "once" })
        const second = (await h.seen((item) => item.type === "approval.requested" && String(item.data.callId) === "call_2")) as StoredEvent<"approval.requested">
        session.answer(target(second.data), { choice: "session" })
        await h.settled()
        // Writes under /opt/x were remembered for the session: the third call ran on that.
        expect(of(h, "approval.requested").map((item) => String(item.data.callId))).toEqual(["call_1", "call_2"])
        expect(settled(h).map((entry) => [entry[0], entry[1]])).toEqual([
          ["call_1", "success"],
          ["call_2", "success"],
          ["call_3", "success"],
        ])
      },
      { attended: true },
    ))
})

describe("a pending question and what else can happen", () => {
  test("an interrupt withdraws it: the call never starts, and an answer that comes later is not taken", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("curl x", "call_1", { sandbox: { network: true } })])
        const session = h.create()
        session.send("Fetch.")
        const question = await asked(h)
        session.interrupt()
        await h.settled()
        expect(session.answer(target(question), { choice: "once" })).toBe(false)
        expect(settled(h)).toEqual([["call_1", "not_started", TOOL_TEXT.notStarted]])
        expect(types(h).slice(-5)).toEqual(["execution.interrupt_requested", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"])
        expect(of(h, "approval.answered")).toEqual([])
        expect(session.approval()?.pending).toBeNull()
        expect(h.tools.ran).toEqual([])
      },
      { attended: true },
    ))

  test("a shutdown withdraws it and keeps the claim: the next start asks the model again, and the question is asked again", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("curl x", "call_1", { sandbox: { network: true } })], [shell("curl x", "call_1", { sandbox: { network: true } })], [script.text("Done.")])
        h.tools.on("shell", "fetched")
        const session = h.create()
        session.send("Fetch.")
        await asked(h)
        await h.engine.close()
        h.kill()
        expect(h.restartForLog().log().at(-1)?.type).toBe("execution.interrupted")
        const reopened = h.open()
        const again = (await h.seen((item) => item.type === "approval.requested" && item.seq > h.log().findLast((entry) => entry.type === "execution.resumed")!.seq)) as StoredEvent<"approval.requested">
        reopened.answer(target(again.data), { choice: "once" })
        await h.settled()
        expect(settled(h).map((entry) => entry[1])).toEqual(["not_started", "success"])
      },
      { attended: true },
    ))

  test("a process that dies while it waits leaves the call pending: recovery settles it as not started, and the question is asked again", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("curl x", "call_1", { sandbox: { network: true } })], [shell("curl x", "call_1", { sandbox: { network: true } })], [script.text("Done.")])
        h.tools.on("shell", "fetched")
        h.dieAt("approval.requested")
        h.create().send("Fetch.")
        await h.settled().catch(() => {})
        const reopened = h.restart()
        const again = (await h.seen((item) => item.type === "approval.requested" && item.seq > h.log().findLast((entry) => entry.type === "execution.resumed")!.seq)) as StoredEvent<"approval.requested">
        expect(settled(h)).toEqual([["call_1", "not_started", TOOL_TEXT.notStarted]])
        expect(h.log().find((item) => item.type === "step.failed")?.data).toMatchObject({ error: { kind: "crashed" } })
        reopened.answer(target(again.data), { choice: "once" })
        await h.settled()
        expect(settled(h).map((entry) => entry[1])).toEqual(["not_started", "success"])
        expect(types(h).at(-1)).toBe("execution.succeeded")
      },
      { attended: true },
    ))

  test("a steered message waits in the inbox behind it and is delivered once the step is over", () =>
    withHarness(
      async (h) => {
        h.provider.enqueue([shell("curl x", "call_1", { sandbox: { network: true } })], [script.text("Done.")])
        h.tools.on("shell", "fetched")
        const session = h.create()
        session.send("Fetch.")
        const question = await asked(h)
        session.send("Also update the changelog.")
        expect(session.projection().inbox).toHaveLength(1)
        expect(session.approval()?.pending).not.toBeNull()
        session.answer(target(question), { choice: "once" })
        await h.settled()
        const delivered = of(h, "inbox.delivered")[1]!
        expect(delivered.seq).toBeGreaterThan(of(h, "step.ended")[0]!.seq)
        expect(JSON.stringify(h.provider.calls[1]!.request.input)).toContain("Also update the changelog.")
      },
      { attended: true },
    ))
})

describe("taint", () => {
  test("a read outside the workspace taints, the user is told once, clearing it is an event, and the fold starts again from there", () =>
    withHarness(async (h) => {
      h.provider.enqueue([read("/home/user/notes.txt", "call_1"), read("../other/x.txt", "call_2")], [script.text("Done.")])
      h.tools.on("read", "notes", "x")
      const session = h.create()
      session.send("Read them.")
      await h.settled()
      expect(of(h, "taint.noticed")).toHaveLength(1)
      expect(session.approval()?.taint).toMatchObject({ tainted: true, sources: [{ kind: "outside-file", path: "/home/user/notes.txt" }, { kind: "outside-file", path: "/other/x.txt" }] })
      expect(session.clearTaint()).toBe(true)
      expect(session.clearTaint()).toBe(false)
      expect(session.approval()?.taint.tainted).toBe(false)
      expect(session.projection().session.approval?.taint).toBeNull()
      expect(types(h).at(-1)).toBe("taint.cleared")
    }))

  test("a revert, its undo and a restart leave it as it was: it is derived from the log, which they do not shorten", () =>
    withHarness(async (h) => {
      h.provider.enqueue([read("/home/user/notes.txt")], [script.text("Done.")])
      h.tools.on("read", "notes")
      const session = h.create()
      session.send("Read it.")
      await h.settled()
      expect((await session.revert()).kind).toBe("reverted")
      expect(session.approval()?.taint.tainted).toBe(true)
      expect(session.projection().session.approval?.taint).not.toBeNull()
      await h.dispose()
      const reopened = h.restart("wait")
      expect(reopened.approval()?.taint).toMatchObject({ tainted: true, sources: [{ kind: "outside-file" }] })
      expect(of(h, "taint.noticed")).toHaveLength(1)
    }))

  test("a compaction does not clear it", () =>
    withHarness(
      async (h) => {
        const big = "x".repeat(6000)
        h.provider.enqueue([read("/home/user/notes.txt")], [script.text("Read.")], [script.text("## Goal\n- g")], [script.text("Done.")])
        h.tools.on("read", big)
        const session = h.create()
        session.send("Read it.")
        await h.settled()
        session.send("And now?")
        await h.settled()
        if (of(h, "compaction.ended").length > 0) expect(session.approval()?.taint.tainted).toBe(true)
        expect(session.approval()?.taint.tainted).toBe(true)
      },
      { contextWindow: 4000 },
    ))
})

describe("redaction", () => {
  test("a tool's output and its structured data are redacted before they are stored, so the model and a replay see the same text", () =>
    withHarness(async (h) => {
      h.provider.enqueue([shell("env")], [script.text("Done.")])
      h.tools.on("shell", () => ({ status: "success", output: `API_TOKEN=${SECRET}\nAuthorization: Bearer abcdef0123456789abcdef`, truncation: null, attachments: [], display: { tail: SECRET } }))
      h.create().send("Show the environment.")
      await h.settled()
      const result = of(h, "tool.settled")[0]!.data
      expect(result.output).toBe("API_TOKEN=[REDACTED:env]\nAuthorization: Bearer [REDACTED:authorization]")
      expect(result.display).toEqual({ tail: "[REDACTED:env]" })
      expect(JSON.stringify(h.provider.calls[1]!.request)).not.toContain(SECRET)
      expect(JSON.stringify(h.log())).not.toContain(SECRET)
    }))

  test("the file tools are handed the redaction, so that an edit can find what a placeholder stands for", () =>
    withHarness(async (h) => {
      let pieces: unknown
      h.provider.enqueue([write("a.env")], [script.text("Done.")])
      h.tools.on("write", (_, context: ToolContext) => ((pieces = context.redact?.(`K=${SECRET}`)), "written"))
      h.create().send("Go.")
      await h.settled()
      expect(pieces).toEqual([
        { text: "K=", original: "K=", kind: null },
        { text: "[REDACTED:env]", original: SECRET, kind: "env" },
      ])
    }))
})

describe("the project's checks", () => {
  test("run in the sandbox with no network and nothing extra, whatever the model's commands were allowed", () =>
    withHarness(
      async (h) => {
        let given: unknown = "not called"
        h.provider.enqueue([write("a.ts")], [script.text("Done.")])
        h.tools.on("write", () => {
          h.workspace!.files.set("a.ts", "changed")
          return "written"
        })
        h.checks.on("test", (_, options) => ((given = options.sandbox), "passed"))
        const session = h.create()
        session.send("Fix it.")
        await h.settled()
        expect(given).toMatchObject({ run: { network: false, writableRoots: [] }, sessionId: session.id })
        expect(of(h, "execution.succeeded")[0]!.data.verification.status).toBe("passed")
      },
      { config: CHECKS_CONFIG, workspace: new FakeWorkspace({ "a.ts": "old" }) },
    ))
})

describe("approvals remembered for the project", () => {
  test("are kept in the data directory, never in the repository, and cover the same capability in a later session", async () => {
    const tools = () => new ScriptedTools().on("write", "one", "two")
    const first = new Harness({ approval: setup(), attended: true, tools: tools() })
    let grantsDir = ""
    try {
      first.provider.enqueue([write("/opt/cache/a")], [script.text("Done.")])
      const session = first.create()
      session.send("Go.")
      const question = await asked(first)
      expect(question.question.choices.find((choice) => choice.id === "project")?.remembers).toBe("writes by file tools under /opt/cache, in this project for 30 days")
      session.answer(target(question), { choice: "project" })
      await first.settled()
      const answered = of(first, "approval.answered")[0]!.data
      expect(answered.grants).toEqual([{ scope: "project", rule: { kind: "write", root: "/opt/cache" }, at: null, grantedAt: expect.any(Number) }])
      // A project approval is not a session approval: it is in the file, not in the session's state.
      expect(first.session.projection().session.approval).toBeUndefined()
      grantsDir = join(first.dataDir, "approvals")
      expect(existsSync(grantsDir) && readdirSync(grantsDir).length).toBe(1)

      first.provider.enqueue([write("/opt/cache/b")], [script.text("Done.")])
      const second = first.engine.createSession({ cwd: "/repo", settings: { model: "gpt-test", reasoningEffort: null } })
      second.setAttended(true)
      second.send("Again.")
      await second.settled()
      expect(second.readEvents().filter((item) => item.type === "approval.requested")).toEqual([])
      expect(second.readEvents().filter((item) => item.type === "tool.settled").map((item) => item.data.outcome)).toEqual(["success"])
    } finally {
      await first.dispose()
    }
  })
})

test("with the approval layer off nothing is decided, recorded or redacted", async () => {
  const h = new Harness()
  try {
    h.provider.enqueue([shell("curl x", "call_1", { sandbox: { network: true } })], [script.text("Done.")])
    h.tools.on("shell", SECRET)
    const session = h.create()
    session.send("Go.")
    await h.settled()
    expect(of(h, "tool.started")[0]!.data as unknown).toEqual({ messageId: expect.any(String), callId: "call_1", effect: "exec" })
    expect(settled(h)).toEqual([["call_1", "success", SECRET]])
    expect(session.approval()).toBeNull()
    expect(session.clearTaint()).toBe(false)
  } finally {
    await h.dispose()
  }
})

// Kept last: it only checks that a tool waiting for an abort is unaffected by the line.
test("a command that is still running when the user interrupts is stopped as before, and the write behind it never starts", () =>
  withHarness(async (h) => {
    h.provider.enqueue([shell("sleep 60", "call_1"), write("a.ts", "call_2")])
    h.tools.on("shell", async (_, context: ToolContext) => (await untilAbort(context.signal), failed("[Interrupted by the user.]")))
    const session = h.create()
    session.send("Go.")
    await h.seen((item) => item.type === "tool.started")
    session.interrupt()
    await h.settled()
    expect(settled(h)).toEqual([
      ["call_1", "error", "[Interrupted by the user.]"],
      ["call_2", "not_started", TOOL_TEXT.notStarted],
    ])
  }))

describe("a credential's value that arrives in parts", () => {
  /** A value with a line break in it, as a private key or a multi-line token in an environment variable has. */
  const TWO_LINES = "first-line-of-the-secret-value\nsecond-line-of-the-secret-value"

  test("a tool is handed the check for an unfinished value, so output that is cut between its lines never shows the first half", () =>
    withHarness(
      async (h) => {
        const emitted: string[] = []
        h.provider.enqueue([shell("print-secret")], [script.text("Done.")])
        h.tools.on("shell", (_, context: ToolContext) => {
          expect(context.unfinishedSecret).toBeDefined()
          // Where the first line of the value begins: from there the text is held back until more has arrived.
          const arrived = `token: ${TWO_LINES.slice(0, 31)}`
          expect(context.unfinishedSecret!(arrived)).toBe("token: ".length)
          expect(context.unfinishedSecret!("nothing secret here\n")).toBe("nothing secret here\n".length)
          // As the shell tool redacts a running command's output with what the loop hands it.
          const stream = redactingStream({ redact: context.redact!, unfinishedSecret: context.unfinishedSecret! }, (bytes) => emitted.push(new TextDecoder().decode(bytes)))
          const encoder = new TextEncoder()
          stream.write(encoder.encode(arrived))
          stream.write(encoder.encode(`${TWO_LINES.slice(31)}\nafter\n`))
          stream.end()
          return emitted.join("")
        })
        h.create().send("Print it.")
        await h.settled()
        expect(emitted.join("")).toBe("token: [REDACTED:env]\nafter\n")
        for (const piece of emitted) expect(piece).not.toContain("first-line-of-the-secret")
        expect(settled(h)[0]![2]).toBe("token: [REDACTED:env]\nafter\n")
      },
      { approval: setup({ secrets: [TWO_LINES] }) },
    ))

  test("without the check the same output would have shown the first line: it is what closes the gap", () => {
    const emitted: string[] = []
    const stream = redactingStream({ redact: (text) => redactPieces(text, [TWO_LINES]) }, (bytes) => emitted.push(new TextDecoder().decode(bytes)))
    const encoder = new TextEncoder()
    stream.write(encoder.encode(`token: ${TWO_LINES.slice(0, 31)}`))
    stream.write(encoder.encode(`${TWO_LINES.slice(31)}\nafter\n`))
    stream.end()
    expect(emitted.join("")).toContain("first-line-of-the-secret-value")
  })
})
