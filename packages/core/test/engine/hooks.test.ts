/**
 * Hooks through the loop, with the scripted provider as the model and, for
 * most tests, a scripted runner in place of real commands: a before hook
 * refuses a call and approves nothing, an after hook's note is stored with
 * the result, a stop hook sends the model back a bounded number of times, a
 * project's hook waits for the user's approval, an interrupt reaches a
 * running hook, a hook's text taints by its record, and a session whose
 * configuration names no hook sends exactly the requests of an engine
 * without hooks.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { ConfigFile } from "../../src/config/schema.ts"
import { HARNESS_ORIGIN, type StoredEvent } from "../../src/event/durable.ts"
import type { HookProcessResult } from "../../src/hooks/answer.ts"
import { HOOK_ENV_PREFIX } from "../../src/hooks/event.ts"
import type { HookRunRequest } from "../../src/hooks/run.ts"
import type { Json } from "../../src/json.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { measured } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, type HarnessOptions, removeHarnessDirectories, untilAbort } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]

const sandbox: CommandSandbox = {
  state: { available: true },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
}
const approval = (more: Partial<ApprovalSetup> = {}): ApprovalSetup => ({ sandbox, secrets: [], home: "/home/user", ...more })

type Answers = Record<string, HookProcessResult | ((request: HookRunRequest) => HookProcessResult)>

/** A harness whose hooks are answered from a script per hook name. */
function harness(config: { user?: ConfigFile; project?: ConfigFile }, answers: Answers, more: HarnessOptions = {}) {
  const scripted = scriptedRunner(answers)
  const h = new Harness({ userConfig: { verify: { mode: "off" }, ...config.user }, ...(config.project === undefined ? {} : { config: config.project }), hooks: { runner: scripted.runner }, ...more })
  return { h, requests: scripted.requests }
}

const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
/** By call: with the approval layer off the calls of a step run side by side, and settle in the order they finish. */
const byCall = <T extends { readonly data: { readonly callId: string | null } }>(items: readonly T[]) => [...items].sort((a, b) => String(a.data.callId).localeCompare(String(b.data.callId)))
const types = (h: Harness) => h.log().map((item) => item.type)
const said = (h: Harness, kind: string) => h.diagnostics.filter((item) => item.kind === kind).map((item) => item.message)

const NO_PUSH = { name: "no-push", tools: ["shell"], command: "refuse git push" }
const REFUSAL = 'This call was not run: the hook "no-push" refused it.\nPushing is not allowed here. Commit locally and tell the user.'
const refusesPush = (request: HookRunRequest) =>
  String((request.event.env as Record<string, string>)[`${HOOK_ENV_PREFIX}COMMAND`] ?? "").includes("git push") ? exited(2, "Pushing is not allowed here. Commit locally and tell the user.\n") : exited(0)

describe("a before hook", () => {
  test("refuses a call: the call never starts, the model reads why, and the next request extends the one before", async () => {
    const { h, requests } = harness({ user: { hooks: { beforeTool: [NO_PUSH] } } }, { "no-push": refusesPush })
    h.provider.enqueue([call("shell", { command: "git status" }), call("shell", { command: "git push origin main" }, "call_2"), U], answer("I committed locally; pushing is not allowed here."))
    h.tools.on("shell", "nothing to commit")
    h.create().send("Commit and push.")
    await h.settled()
    // The hook was asked about both calls, with the call's own arguments; only the first ran.
    expect(requests.map((request) => JSON.parse(request.event.stdin).tool.arguments.command)).toEqual(["git status", "git push origin main"])
    expect(h.tools.ran).toEqual([{ name: "shell", input: { command: "git status" } }])
    const settled = byCall(of(h, "tool.settled"))
    expect(settled.map((item) => [item.data.callId, item.data.outcome, item.data.output])).toEqual([
      ["call_1", "success", "nothing to commit"],
      ["call_2", "error", REFUSAL],
    ])
    // One record per hook that applied, each right before the result of its call, and no start for the refused one.
    const records = byCall(of(h, "hook.ran"))
    expect(records.map((item) => [item.data.callId, item.data.point, item.data.name, item.data.origin, item.data.answer, item.data.toModel])).toEqual([
      ["call_1", "beforeTool", "no-push", "user", "yes", null],
      ["call_2", "beforeTool", "no-push", "user", "no", "Pushing is not allowed here. Commit locally and tell the user."],
    ])
    expect(records[1]!.seq + 1).toBe(settled[1]!.seq)
    expect(of(h, "tool.started").map((item) => item.data.callId as string)).toEqual(["call_1"])
    // The model reads the reason in the call's result, and nothing about hooks is in the prefix.
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain("Pushing is not allowed here.")
    expect(h.provider.prefixBreaks()).toEqual([])
    expect(h.provider.requests[1]!.tools).toEqual(h.provider.requests[0]!.tools)
    expect(JSON.stringify(h.provider.requests[0])).not.toContain("no-push")
    expect(h.diagnostics).toEqual([])
    h.verify()
    await h.dispose()
  })

  test("a hook that does not object approves nothing: the approval layer decides next, and refuses", async () => {
    const { h } = harness({ user: { hooks: { beforeTool: [{ name: "fine", command: "true" }] } } }, { fine: exited(0, "looks good to me\n") }, { approval: approval({ user: { mode: "auto" } }) })
    h.provider.enqueue([call("write", { path: "/etc/hosts", content: "x" }), U], answer("I could not write it."))
    h.create().send("Write /etc/hosts.")
    await h.settled()
    expect(h.tools.ran).toEqual([])
    // The denial, the hook's record and the result are one decision: one append, in that order.
    const at = types(h).indexOf("approval.denied")
    expect(types(h).slice(at, at + 3)).toEqual(["approval.denied", "hook.ran", "tool.settled"])
    expect(of(h, "hook.ran")[0]!.data).toMatchObject({ answer: "yes", toModel: null, forUser: "looks good to me", run: { kind: "ran", sandbox: { network: false, writableRoots: [] } } })
    expect(of(h, "tool.settled")[0]!.data.outcome).toBe("error")
    h.verify()
    await h.dispose()
  })

  test("a hook that cannot answer refuses the call and the user is told; with onError allow the call runs", async () => {
    const broken: HookProcessResult = { kind: "timed_out", timeoutSeconds: 10, stderr: "", durationMs: 10_000 }
    const { h } = harness(
      { user: { hooks: { beforeTool: [{ name: "slow", tools: ["shell"], command: "sleep 99" }, { name: "watch", tools: ["read"], command: "sleep 99", onError: "allow" }] } } },
      { slow: broken, watch: broken },
    )
    h.provider.enqueue([call("shell", { command: "ls" }), call("read", { path: "a.ts" }, "call_2"), U], answer("Done."))
    h.tools.on("read", "export const a = 1")
    h.create().send("Look around.")
    await h.settled()
    expect(h.tools.ran.map((item) => item.name)).toEqual(["read"])
    const refused = of(h, "tool.settled").find((item) => item.data.callId === "call_1")!
    expect(refused.data).toMatchObject({ outcome: "error" })
    expect(refused.data.output).toBe('This call was not run: the hook "slow" (from the user\'s configuration) must allow it and could not answer: it did not answer within 10 seconds. Do not try to work around the hook; tell the user it is failing.')
    expect(of(h, "hook.ran").map((item) => [item.data.name, item.data.answer, item.data.failure])).toEqual(expect.arrayContaining([["slow", "failed", "timed_out"], ["watch", "failed", "timed_out"]]))
    // Each notice says what became of its call: the one refused, the one that ran.
    expect([...said(h, "hooks")].sort()).toEqual([
      'The hook "slow" (before a tool call) could not answer: it did not answer within 10 seconds. A call it must allow is refused while it fails, unless the hook says `onError: "allow"`.',
      'The hook "watch" (before a tool call) could not answer: it did not answer within 10 seconds. The call went on without its answer, since the hook says `onError: "allow"`.',
    ])
    await h.dispose()
  })

  test("an interrupt while a hook runs: the call never starts, and the hooks that had finished are on record", async () => {
    let stop: (() => void) | null = null
    // The second hook is running when the user cancels: its runner sees the abort, as the real one does.
    const scripted = scriptedRunner({ quick: exited(0) })
    const slow = new Harness({
      userConfig: { verify: { mode: "off" }, hooks: { beforeTool: [{ name: "quick", command: "true" }, { name: "hangs", command: "sleep 99" }] } },
      hooks: {
        runner: async (request) => {
          if (request.hook.name === "quick") return scripted.runner(request)
          stop?.()
          await untilAbort(request.signal)
          return { kind: "interrupted" }
        },
      },
    })
    slow.provider.enqueue([call("shell", { command: "ls" }), U])
    slow.create()
    stop = () => slow.session.interrupt()
    slow.session.send("List the files.")
    await slow.settled()
    expect(slow.tools.ran).toEqual([])
    const log = slow.log()
    const at = log.findIndex((item) => item.type === "execution.interrupt_requested")
    expect(log.slice(at).map((item) => item.type)).toEqual(["execution.interrupt_requested", "hook.ran", "hook.ran", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"])
    expect(of(slow, "hook.ran").map((item) => [item.data.name, item.data.answer])).toEqual([["quick", "yes"], ["hangs", "interrupted"]])
    expect(of(slow, "tool.settled")[0]!.data.outcome).toBe("not_started")
    slow.verify()
    await slow.dispose()
  })
})

describe("an after hook", () => {
  test("adds a note after the tool's own output: stored once with the result, replayed byte for byte", async () => {
    const { h, requests } = harness(
      { user: { hooks: { afterTool: [{ name: "prettier", tools: ["write"], paths: ["**/*.ts"], command: "format" }, { name: "quiet", tools: ["write"], command: "true" }] } } },
      { prettier: exited(2, "prettier could not format this file; run it to see why.\n", "SyntaxError: Unexpected token"), quiet: exited(0) },
    )
    h.provider.enqueue([call("write", { path: "src/a.ts", content: "const a = " }), call("write", { path: "notes.md", content: "x" }, "call_2"), U], answer("Written."))
    h.tools.on("write", "Wrote src/a.ts (1 line).", "Wrote notes.md (1 line).")
    h.create().send("Write both files.")
    await h.settled()
    const settled = byCall(of(h, "tool.settled"))
    expect(settled[0]!.data.output).toBe('Wrote src/a.ts (1 line).\n\n[Note from the hook "prettier"]\nprettier could not format this file; run it to see why.')
    // The path pattern leaves the other file to the hook without one, which adds nothing.
    expect(settled[1]!.data.output).toBe("Wrote notes.md (1 line).")
    expect(byCall(of(h, "hook.ran")).map((item) => [item.data.callId, item.data.name, item.data.answer, item.data.toModel, item.data.forUser])).toEqual([
      ["call_1", "prettier", "no", "prettier could not format this file; run it to see why.", "SyntaxError: Unexpected token"],
      ["call_1", "quiet", "yes", null, ""],
      ["call_2", "quiet", "yes", null, ""],
    ])
    // The hook was shown the result it annotates, and the model the note in the stored result.
    expect(JSON.parse(requests.find((request) => request.hook.name === "prettier")!.event.stdin).result).toMatchObject({ status: "success", output: "Wrote src/a.ts (1 line)." })
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain('[Note from the hook \\"prettier\\"]')
    expect(h.provider.prefixBreaks()).toEqual([])
    h.verify()
    await h.dispose()
  })

  test("a note that holds a credential is stored redacted, and so is what the hook was shown of the result", async () => {
    const secret = "s3cr3t-value-0123456789"
    const { h, requests } = harness({ user: { hooks: { afterTool: [{ name: "echo", command: "cat" }] } } }, { echo: exited(2, `the result held ${secret}\n`) }, { approval: approval({ secrets: [secret], user: { mode: "full" } }) })
    h.provider.enqueue([call("read", { path: "a.ts" }), U], answer("Read."))
    h.tools.on("read", `token = "${secret}"`)
    h.create().send("Read a.ts.")
    await h.settled()
    expect(requests[0]!.event.stdin).not.toContain(secret)
    const output = of(h, "tool.settled")[0]!.data.output
    expect(output).not.toContain(secret)
    expect(output).toMatch(/^token = "\[REDACTED:[a-z_-]+\]"\n\n\[Note from the hook "echo"\]\nthe result held \[REDACTED:[a-z_-]+\]$/)
    await h.dispose()
  })
})

describe("a stop hook", () => {
  const SCRATCH = { name: "no-scratch", command: "test ! -e SCRATCH.md" }

  test("sends the model back with its message, then lets the turn end", async () => {
    let asked = 0
    const { h, requests } = harness({ user: { hooks: { stop: [SCRATCH] } } }, { "no-scratch": () => (++asked === 1 ? exited(2, "SCRATCH.md still exists. Delete it before you finish.\n") : exited(0)) })
    h.provider.enqueue(answer("Done."), [call("shell", { command: "rm SCRATCH.md" }), U], answer("Deleted it. Done."))
    h.tools.on("shell", "")
    h.create().send("Tidy up.")
    await h.settled()
    const stops = of(h, "synthetic.appended").filter((item) => item.data.origin === HARNESS_ORIGIN.stopHook)
    expect(stops.map((item) => item.data.content)).toEqual([[{ type: "text", text: '[Stop hook 1 of at most 3] The turn cannot end yet.\n\nThe hook "no-scratch" says:\nSCRATCH.md still exists. Delete it before you finish.' }]])
    // The record and the message are one append; the turn ends with the second record and nothing about hooks on its ending.
    const records = of(h, "hook.ran")
    expect(records.map((item) => [item.data.point, item.data.messageId, item.data.callId, item.data.answer])).toEqual([["stop", null, null, "no"], ["stop", null, null, "yes"]])
    expect(records[0]!.seq + 1).toBe(stops[0]!.seq)
    const ended = of(h, "execution.succeeded")[0]!
    expect(records[1]!.seq + 1).toBe(ended.seq)
    expect(ended.data).toEqual({ executionId: ended.data.executionId, verification: { status: "not_configured" } })
    // The hook was told the round and the agent's last words; the model was shown the message as a harness message.
    expect(requests.map((request) => JSON.parse(request.event.stdin).turn)).toEqual([
      { round: 1, maxRounds: 3, lastText: "Done.", lastTextCut: false },
      { round: 2, maxRounds: 3, lastText: "Deleted it. Done.", lastTextCut: false },
    ])
    expect(JSON.stringify(h.provider.requests[1]!.input)).toContain('<harness origin=\\"stop_hook\\">')
    expect(h.provider.prefixBreaks()).toEqual([])
    h.verify()
    await h.dispose()
  })

  test("is bounded: after the last round the turn ends and says the hook was not satisfied", async () => {
    const { h } = harness({ user: { hooks: { stop: [SCRATCH], maxStopRounds: 2 } } }, { "no-scratch": exited(2, "SCRATCH.md still exists.\n") })
    h.provider.enqueue(answer("Done."), answer("Done, really."), answer("I cannot delete it."))
    h.create().send("Tidy up.")
    await h.settled()
    const stops = of(h, "synthetic.appended").filter((item) => item.data.origin === HARNESS_ORIGIN.stopHook)
    expect(stops).toHaveLength(2)
    expect(JSON.stringify(stops[1]!.data.content)).toContain("This is the last time: if you stop again, the turn ends with the hook unsatisfied.")
    expect(of(h, "hook.ran").map((item) => [item.data.answer, item.data.toModel])).toEqual([
      ["no", "SCRATCH.md still exists."],
      ["no", "SCRATCH.md still exists."],
      // The third answer sent nobody back: it reached the user, never the model.
      ["no", null],
    ])
    expect(of(h, "execution.succeeded")[0]!.data).toMatchObject({ verification: { status: "not_configured" }, hooks: { unsatisfied: ["no-scratch"] } })
    expect(said(h, "hooks")).toEqual(['The turn ended although the stop hook "no-scratch" still objected: the agent was sent back 2 times already, the most a turn allows.'])
    expect(h.provider.remaining).toBe(0)
    h.verify()
    // The count is the log's: a process that restarts in the turn counts the same rounds.
    await h.dispose()
  })

  test("comes after the gate, in the gate's append; a failing hook lets the turn end and the user is told", async () => {
    const workspace = new FakeWorkspace({ "a.ts": "export const a = 1\n" })
    let asked = 0
    const scripted = scriptedRunner({ review: () => (++asked === 1 ? exited(2, "Add a changelog entry.\n") : { kind: "killed", signal: "SIGSEGV", stderr: "", durationMs: 3 }) })
    const h = new Harness({ config: { checks: [{ name: "test", command: "bun test" }], hooks: {} }, userConfig: { hooks: { stop: [{ name: "review", command: "review" }] } }, hooks: { runner: scripted.runner }, workspace })
    h.checks.on("test", "passed", "passed")
    h.provider.enqueue([call("write", { path: "a.ts", content: "export const a = 2\n" }), U], answer("Changed."), [call("write", { path: "CHANGELOG.md", content: "a is 2\n" }), U], answer("Added."))
    h.tools.on("write", (input) => (workspace.files.set(String(input.path), String(input.content)), "Wrote a.ts"), (input) => (workspace.files.set(String(input.path), String(input.content)), "Wrote CHANGELOG.md"))
    h.create().send("Make a 2.")
    await h.settled()
    const log = types(h)
    // The checks pass first; then the hook is asked, and its record and message follow the run's result in one append.
    const first = log.indexOf("checks.finished")
    expect(log.slice(first, first + 3)).toEqual(["checks.finished", "hook.ran", "synthetic.appended"])
    // The model changed a file, so the gate ran again before the hook was asked again.
    const second = log.lastIndexOf("checks.finished")
    expect(second).toBeGreaterThan(first)
    expect(log.slice(second)).toEqual(["checks.finished", "hook.ran", "execution.succeeded"])
    expect(of(h, "hook.ran").at(-1)!.data).toMatchObject({ answer: "failed", failure: "killed", detail: "it was killed by signal SIGSEGV" })
    expect(of(h, "execution.succeeded")[0]!.data.verification.status).toBe("passed")
    expect(of(h, "execution.succeeded")[0]!.data.hooks).toBeUndefined()
    expect(said(h, "hooks")).toEqual(['The hook "review" (when a turn is about to end) could not answer: it was killed by signal SIGSEGV. The turn ended as it would have without it.'])
    h.verify()
    await h.dispose()
  })

  test("a queued message waits for the stop hooks too, and the turn's ending carries what they left", async () => {
    const { h } = harness({ user: { hooks: { stop: [SCRATCH], maxStopRounds: 1 } } }, { "no-scratch": exited(2, "SCRATCH.md still exists.\n") })
    h.provider.enqueue(answer("Done."), answer("Still there."), answer("Second answer."), answer("Second, again."))
    h.create()
    h.at("step.started", 1, () => void h.session.queue("And then this."))
    h.session.send("Tidy up.")
    await h.settled()
    const ended = of(h, "turn.ended")[0]!
    expect(ended.data).toEqual({ verification: { status: "not_configured" }, hooks: { unsatisfied: ["no-scratch"] } })
    // The delivery follows the turn's ending at once; the second turn is held by the hook in its own right.
    expect(h.log().find((item) => item.seq === ended.seq + 1)!.type).toBe("inbox.delivered")
    expect(of(h, "synthetic.appended").filter((item) => item.data.origin === HARNESS_ORIGIN.stopHook)).toHaveLength(2)
    expect(of(h, "execution.succeeded")[0]!.data.hooks).toEqual({ unsatisfied: ["no-scratch"] })
    h.verify()
    await h.dispose()
  })
})

describe("a project's hook", () => {
  const project: ConfigFile = { hooks: { beforeTool: [{ name: "repo-guard", tools: ["shell"], command: "guard" }] } }

  test("is not run until the user approved it: skipped and said once, then asked about by fingerprint, then run", async () => {
    const { h, requests } = harness({ project }, { "repo-guard": exited(2, "Not in this repository.\n") })
    h.provider.enqueue([call("shell", { command: "ls" }), U], answer("Listed."), [call("shell", { command: "ls" }), U], answer("Refused."))
    h.tools.on("shell", "a.ts")
    h.create()
    // Before the first turn a client can already put the question.
    const waiting = h.session.hooks()!.awaiting
    expect(waiting).toMatchObject([{ name: "repo-guard", point: "beforeTool", command: "guard" }])
    expect(waiting[0]!.question).toContain('This project\'s configuration asks to run a hook "repo-guard" before a tool call runs, and can refuse the call:')
    h.session.send("List the files.")
    await h.settled()
    // As if it did not exist: the call ran, the record says the hook was skipped, and the user was told once.
    expect(requests).toEqual([])
    expect(of(h, "hook.ran")[0]!.data).toMatchObject({ origin: "project", run: { kind: "skipped", reason: "not_approved" }, answer: "skipped", toModel: null })
    expect(of(h, "tool.settled")[0]!.data.outcome).toBe("success")
    expect(said(h, "hooks")).toEqual(['This project\'s configuration asks to run the hook "repo-guard" before a tool call (guard). It is not run: a hook a project names runs only after you approve it.'])
    // Approved by the fingerprint the question showed: remembered for the project, and in force from the next call.
    expect(h.session.approveHook("hook-sha256:0000")).toBe(false)
    expect(h.session.approveHook(waiting[0]!.fingerprint)).toBe(true)
    expect(h.session.hooks()!.awaiting).toEqual([])
    h.session.send("List them again.")
    await h.settled()
    expect(requests).toHaveLength(1)
    expect(of(h, "tool.settled").at(-1)!.data).toMatchObject({ outcome: "error", output: 'This call was not run: the hook "repo-guard" refused it.\nNot in this repository.' })
    // The approval is the user's, kept under the data directory: the next process has it, an edited hook does not.
    await h.dispose()
    h.boot()
    h.open()
    expect(h.session.hooks()!.awaiting).toEqual([])
    h.files.project = { hooks: { beforeTool: [{ name: "repo-guard", tools: ["shell"], command: "guard --strict" }] } }
    h.provider.enqueue(answer("Nothing to do."))
    h.session.send("Anything else?")
    await h.settled()
    expect(h.session.hooks()!.awaiting.map((item) => item.command)).toEqual(["guard --strict"])
    await h.dispose()
  })

  test("runs after the user's hooks, in the sandbox, and cannot run where there is none", async () => {
    const user: ConfigFile = { hooks: { beforeTool: [{ name: "mine", command: "true" }] } }
    const unavailable: CommandSandbox = { ...sandbox, state: { available: false, reason: "bubblewrap (bwrap) is not installed.", remedy: null } }
    const { h, requests } = harness({ user, project }, { mine: exited(0), "repo-guard": exited(0) }, { approval: approval({ sandbox: unavailable, user: { mode: "auto" } }) })
    h.create()
    h.session.approveHook(h.session.hooks()!.awaiting[0]!.fingerprint)
    h.provider.enqueue([call("shell", { command: "ls" }), U], answer("Refused."))
    h.session.send("List the files.")
    await h.settled()
    // The user's own command runs unsandboxed on a machine without a sandbox; the project's does not run at all, which refuses the call.
    expect(requests.map((request) => [request.hook.name, request.sandbox])).toEqual([["mine", null]])
    expect(of(h, "hook.ran").map((item) => [item.data.name, item.data.run.kind, item.data.answer, item.data.failure])).toEqual([["mine", "ran", "yes", null], ["repo-guard", "cannot_run", "failed", "cannot_run"]])
    expect(of(h, "tool.settled")[0]!.data.output).toContain('the hook "repo-guard" (from this project\'s configuration) must allow it and could not answer')
    await h.dispose()
  })
})

describe("taint", () => {
  test("the text of a hook the user runs outside the sandbox taints the session from its record on, and the user is told once", async () => {
    const { h } = harness(
      { user: { hooks: { beforeTool: [{ name: "policy", tools: ["shell"], command: "curl policy", sandbox: false }, { name: "local", tools: ["read"], command: "true" }] } } },
      { policy: exited(2, "The policy server says no.\n"), local: exited(2, "Not that file.\n") },
      { approval: approval({ user: { mode: "auto" } }) },
    )
    h.provider.enqueue([call("read", { path: "a.ts" }), U], [call("shell", { command: "deploy" }), U], answer("Refused."))
    h.create().send("Deploy.")
    await h.settled()
    // A sandboxed hook without network is no source; the one the user gave the network is.
    expect(of(h, "hook.ran").map((item) => [item.data.name, item.data.run, item.data.taint])).toEqual([
      ["local", { kind: "ran", sandbox: { network: false, writableRoots: [] } }, null],
      ["policy", { kind: "ran", sandbox: null }, "hook-network"],
    ])
    const noticed = of(h, "taint.noticed")
    expect(noticed).toHaveLength(1)
    expect(noticed[0]!.data.source).toMatchObject({ tool: "policy", kind: "hook-network", at: of(h, "hook.ran")[1]!.seq })
    expect(h.session.approval()!.taint.tainted).toBe(true)
    h.verify()
    await h.dispose()
  })
})

describe("without hooks", () => {
  test("a session whose configuration names no hook sends byte for byte the requests of an engine without hooks, and writes the same log", async () => {
    const play = async (options: HarnessOptions) => {
      const h = new Harness({ userConfig: { verify: { mode: "off" } }, ...options })
      h.provider.enqueue([call("read", { path: "a.ts" }), call("shell", { command: "ls" }, "call_2"), U], [call("write", { path: "a.ts", content: "x" }), U], answer("Done."))
      h.tools.on("read", "export const a = 1").on("shell", "a.ts").on("write", "Wrote a.ts")
      h.create().send("Change a.ts.")
      await h.settled()
      const out = { requests: JSON.stringify(h.provider.requests), blocks: h.store.readRequests(h.session.id).map((row) => row.blocks), log: JSON.stringify(h.log().map((item) => ({ type: item.type, data: item.data }))) }
      await h.dispose()
      return out
    }
    const without = await play({})
    // Offered and unused: no hook in either file, no language server. And with the approval layer on.
    const offered = await play({ hooks: {}, lsp: {} })
    expect(offered.requests).toBe(without.requests)
    expect(offered.blocks).toEqual(without.blocks)
    expect(offered.log).toBe(without.log)
    const guarded = await play({ approval: approval({ user: { mode: "full" } }) })
    expect(await play({ approval: approval({ user: { mode: "full" } }), hooks: {}, lsp: {} })).toEqual(guarded)
    // An empty section is no hook either.
    expect((await play({ hooks: {}, lsp: {}, config: { hooks: { beforeTool: [], maxStopRounds: 2 }, lsp: { servers: {} } } })).requests).toBe(without.requests)
  })

  test("an engine that was not told to run hooks runs none, whatever the configuration says", async () => {
    const h = new Harness({ userConfig: { verify: { mode: "off" }, hooks: { beforeTool: [{ name: "never", command: "exit 2" }], stop: [{ name: "never-stop", command: "exit 2" }] } } })
    h.provider.enqueue([call("shell", { command: "ls" }), U], answer("Done."))
    h.tools.on("shell", "a.ts")
    h.create().send("List the files.")
    await h.settled()
    expect(h.session.hooks()).toBeNull()
    expect(types(h)).not.toContain("hook.ran")
    expect(of(h, "tool.settled")[0]!.data.outcome).toBe("success")
    await h.dispose()
  })
})

describe("real commands", () => {
  test("the module's runner, with the engine's own defaults: a command refuses `git push` by its exit code, and the model reads its stdout", async () => {
    const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "wl-engine-hooks-"))), "repo")
    made.push(join(cwd, ".."))
    mkdirSync(join(cwd, ".git"), { recursive: true })
    const command = `case "$${HOOK_ENV_PREFIX}COMMAND" in *'git push'*) echo 'Pushing is not allowed here. Commit locally and tell the user.'; echo 'refused a push' >&2; exit 2;; esac`
    const h = new Harness({ cwd, userConfig: { verify: { mode: "off" }, hooks: { beforeTool: [{ ...NO_PUSH, command }], stop: [{ name: "no-scratch", command: "if [ -e SCRATCH.md ]; then echo 'SCRATCH.md still exists.'; exit 2; fi" }] } }, hooks: {} })
    h.provider.enqueue([call("shell", { command: "git push origin main" }), U], answer("Pushing is not allowed; I stopped."))
    h.create().send("Push.")
    await h.settled()
    expect(h.tools.ran).toEqual([])
    expect(of(h, "tool.settled")[0]!.data).toMatchObject({ outcome: "error", output: REFUSAL })
    expect(of(h, "hook.ran").map((item) => [item.data.name, item.data.answer, item.data.exitCode, item.data.forUser])).toEqual([
      ["no-push", "no", 2, "refused a push"],
      ["no-scratch", "yes", 0, ""],
    ])
    expect(of(h, "execution.succeeded")).toHaveLength(1)
    expect(h.diagnostics).toEqual([])
    h.verify()
    await h.dispose()
  }, 60_000)
})
