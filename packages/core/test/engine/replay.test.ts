/**
 * Replay as an engine operation, on the real assembly: a recorded session is
 * replayed in a replay session against a changed baseline, with a scripted
 * model that does what the recording did or leaves it. Nothing may run for
 * real while the model stays on the recording, or ever under `stop`; under
 * `execute` the replay carries on in a copy of the workspace as it was at
 * the point it left.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveConfig } from "../../src/config/schema.ts"
import { EngineError, type EngineSession } from "../../src/engine/engine.ts"
import { REPLAY_TEXT } from "../../src/engine/replay.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { agentsSource, dateSource, environmentSource } from "../../src/instructions/source.ts"
import { responsesFromTape } from "../../src/replay/fake.ts"
import { renderReport } from "../../src/replay/report.ts"
import { STOPPED_OUTPUT } from "../../src/replay/replay.ts"
import { tapeFromEvents } from "../../src/replay/tape.ts"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { SETTINGS, type Started, call, closeHarnesses, place, removePlaces, say, start } from "./assembly-helpers.ts"

afterEach(closeHarnesses)
afterAll(removePlaces)

const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const types = (events: readonly StoredEvent[]) => events.map((item) => item.type)

/** Records a session: a read, a write, a command, an answer, then a second turn with one more write. */
async function record(more: Parameters<typeof start>[2] = {}) {
  const spot = place("lh-replay-")
  const directory = spot.workspace("w", { "a.txt": "one\n", "AGENTS.md": "Keep it short.\n" })
  const started = start(
    spot.data,
    [
      [script.text("Let me look."), call("read", { path: "a.txt" })],
      [call("write", { path: join(directory, "a.txt"), content: "two\n" })],
      [call("shell", { command: "cat a.txt" })],
      say("a.txt now says two."),
      [call("write", { path: "b.txt", content: "bee\n" })],
      say("Added b.txt."),
    ],
    {
      ...more,
      engine: {
        discover: () => [agentsSource(join(directory, "AGENTS.md"), "Keep it short."), environmentSource({ cwd: directory, platform: "linux", gitRepository: false }), dateSource(2026, 11, 12)],
        prompt: "You are a coding agent. Old rules.",
        ...more.engine,
      },
    },
  )
  const session = started.harness.engine.createSession({ cwd: directory, settings: SETTINGS })
  session.send("Change a.txt to two.")
  await session.settled()
  session.send("Now add b.txt.")
  await session.settled()
  const events = session.readEvents()
  return { ...spot, ...started, directory, session, events, tape: tapeFromEvents(events) }
}

type Recording = Awaited<ReturnType<typeof record>>

/** Replays the recording with the model scripted to do what `overrides` say instead of the recorded step. */
async function replay(recording: Recording, request: Parameters<Started["harness"]["engine"]["replaySession"]>[1], overrides: Parameters<typeof responsesFromTape>[1] = {}, extra: Parameters<typeof responsesFromTape>[2] = []) {
  const from = recording.provider.requests.length
  recording.provider.enqueue(...responsesFromTape(recording.tape, overrides, extra))
  const run = await recording.harness.engine.replaySession(recording.session.id, request)
  const outcome = await run.done
  await run.session.settled()
  return { run, outcome, session: run.session, log: run.session.readEvents(), requests: recording.provider.requests.slice(from) }
}

const check = (recording: Recording, session: EngineSession) => recording.harness.sessions.read(session.id, (store) => expectRebuildEqualsLive(store as never, session.id))

describe("a replay that stays on the recording", () => {
  test("runs the real loop against the changed baseline, answers every call from the recording, runs nothing, and is recorded as the replay it is", async () => {
    const recording = await record()
    // Whatever the replay would run would show here.
    writeFileSync(join(recording.directory, "a.txt"), "by hand\n")
    rmSync(join(recording.directory, "b.txt"))
    const sourceLog = [...recording.events]
    const { outcome, session, log, requests } = await replay(recording, { systemPrompt: "You are a coding agent. New rules.", toolDescriptions: { read: "Reads a file, carefully." } })

    expect(outcome.report.status).toBe("identical")
    expect(outcome.report.reason).toBe("all 6 recorded steps replayed without a divergence")
    expect(outcome.report.matched).toMatchObject({ steps: 6, calls: 4, normalised: 0 })
    expect(outcome.workspace).toBeNull()
    expect(outcome.requests).toBe(6)
    expect(readFileSync(join(recording.directory, "a.txt"), "utf8")).toBe("by hand\n")
    expect(existsSync(join(recording.directory, "b.txt"))).toBe(false)
    expect(recording.session.readEvents()).toEqual(sourceLog)

    // Typed as a replay, durably: of which session, through where, how, and what was changed.
    const projection = session.projection()
    expect(projection.session.lineage).toEqual({
      kind: "replay",
      sourceSessionId: recording.session.id,
      throughSeq: recording.events.at(-1)!.seq,
      policy: "stop",
      strict: false,
      changed: { instructions: true, tools: ["read"], settings: false },
    })
    expect(projection.session.rootId).toBe(session.id)
    expect(projection.session.replay).toEqual({ workspace: null, ended: { seq: log.at(-1)!.seq, outcome: "identical", reason: outcome.report.reason } })
    // The baseline: the new prompt, the recording's own sections and tool list, one description changed.
    const recorded = of(recording.events, "baseline.set")[0]!.data
    const baseline = of(log, "baseline.set")[0]!.data
    expect(baseline.instructions).toBe(recorded.instructions.replace("You are a coding agent. Old rules.", "You are a coding agent. New rules."))
    expect(baseline.instructions).toContain("Keep it short.")
    expect(baseline.sources).toEqual(recorded.sources)
    expect(baseline.tools.map((tool) => tool.name)).toEqual(recorded.tools.map((tool) => tool.name))
    expect(baseline.tools.find((tool) => tool.name === "read")!.description).toBe("Reads a file, carefully.")
    expect(requests[0]!.instructions).toBe(baseline.instructions)
    expect(requests.at(-1)!.input.filter((item) => item.type === "message" && item.role === "user")).toHaveLength(2)

    // Per call: matched, with the recorded step and call, and the recorded result byte for byte.
    expect(of(log, "replay.call").map((item) => [item.data.result, item.data.executed, item.data.recorded])).toEqual([
      ["matched", false, { step: 0, call: 0 }],
      ["matched", false, { step: 1, call: 0 }],
      ["matched", false, { step: 2, call: 0 }],
      ["matched", false, { step: 4, call: 0 }],
    ])
    expect(of(log, "tool.settled").map((item) => item.data.output)).toEqual(of(recording.events, "tool.settled").map((item) => item.data.output))
    expect(of(log, "tool.started").map((item) => item.data.effect)).toEqual(["read", "write", "exec", "write"])
    // One execution, the recording's two prompts delivered where they arrived, no snapshot, no check, no question.
    expect(types(log).filter((type) => type.startsWith("execution."))).toEqual(["execution.started", "execution.succeeded"])
    expect(of(log, "inbox.delivered")).toHaveLength(2)
    expect(types(log).filter((type) => type.startsWith("snapshot.") || type.startsWith("checks.") || type.startsWith("approval."))).toEqual([])
    expect(types(log).slice(-2)).toEqual(["execution.succeeded", "replay.ended"])
    check(recording, session)
    // It is the harness's own session: the listing of the directory, and "the latest session", leave it out unless asked.
    const engine = recording.harness.engine
    expect(engine.listSessions().map((summary) => summary.session.id)).toEqual([recording.session.id])
    expect(engine.latestSession(recording.directory)?.session.id).toBe(recording.session.id)
    expect(engine.listSessions({ includeSpawned: true }).map((summary) => summary.session.id)).toContain(session.id)
    // A replay session replays and ends: it takes no prompt, is not reverted and is not forked.
    expect(() => session.send("And now?")).toThrow(REPLAY_TEXT.noPrompts)
    expect((await session.revert()).kind).toBe("refused")
    expect(((await recording.harness.engine.forkSession(session.id).catch((error: unknown) => error)) as EngineError).code).toBe("invalid_request")
  })

  test("a path written another way is the same call, and says so; strict mode does not allow it", async () => {
    const recording = await record()
    const relative = { 1: [call("write", { path: "a.txt", content: "two\n" })] }
    const loose = await replay(recording, {}, relative)
    expect(loose.outcome.report.status).toBe("identical")
    expect(of(loose.log, "replay.call")[1]!.data).toMatchObject({ result: "normalised", recorded: { step: 1, call: 0 } })
    const strict = await replay(recording, { strict: true }, relative)
    expect(strict.outcome.report.status).toBe("diverged")
    expect(strict.session.projection().session.lineage).toMatchObject({ strict: true })
    expect(of(strict.log, "replay.call")[1]!.data).toMatchObject({ result: "diverged", divergence: "arguments_differ" })
  })

  test("the project's checks and the approval layer do nothing in a replay: nothing is run, nothing is asked", async () => {
    const recording = await record({
      engine: {
        loadConfig: async (cwd) => ({ config: resolveConfig({ checks: [{ name: "mark", command: "echo ran >> checks.log" }] }), projectDir: cwd }),
      },
    })
    expect(of(recording.events, "checks.started").length).toBeGreaterThan(0)
    const ran = readFileSync(join(recording.directory, "checks.log"), "utf8")
    const { outcome, log } = await replay(recording, { systemPrompt: "Other." })
    expect(outcome.report.status).toBe("identical")
    expect(types(log).filter((type) => type.startsWith("checks."))).toEqual([])
    expect(readFileSync(join(recording.directory, "checks.log"), "utf8")).toBe(ran)
  })
})

describe("a replay that leaves the recording", () => {
  const otherWrite = (directory: string) => ({ 1: [script.text("A different edit."), call("write", { path: join(directory, "a.txt"), content: "three\n" })] })
  /** From the second step on the model does not do what the recording did: the rest of the recording's responses are not given. */
  const afterwards = { 2: null, 3: null, 4: null, 5: null }

  test("under stop: the call is not run, the replay ends there, and the report says where and how", async () => {
    const recording = await record()
    const { outcome, session, log } = await replay(recording, { model: "gpt-other", effort: "high" }, otherWrite(recording.directory))
    expect(outcome.report.status).toBe("diverged")
    expect(outcome.report.reason).toBe("left the recording at step 2, call 1: arguments differ")
    expect(outcome.report.divergence).toMatchObject({ kind: "arguments_differ", replayStep: 1, recordedStep: 1, callIndex: 0, argumentDiff: [{ path: "content", recorded: "two\n", replayed: "three\n" }] })
    expect(outcome.report.matched).toMatchObject({ steps: 1, calls: 1 })
    expect(renderReport(outcome.report)).toContain("changed    content: \"two\\n\" -> \"three\\n\"")
    expect(readFileSync(join(recording.directory, "a.txt"), "utf8")).toBe("two\n")
    expect(of(log, "replay.call").map((item) => [item.data.result, item.data.executed, item.data.divergence])).toEqual([
      ["matched", false, null],
      ["diverged", false, "arguments_differ"],
    ])
    expect(of(log, "tool.settled").at(-1)!.data).toMatchObject({ outcome: "not_started", output: STOPPED_OUTPUT })
    expect(of(log, "tool.started")).toHaveLength(1)
    // The model had not answered: the execution has no answer to end on, and says that it was the replay that ended.
    expect(of(log, "execution.failed")[0]!.data).toMatchObject({ cause: "replay", message: `The replay ended: ${outcome.report.reason}` })
    expect(of(log, "replay.ended")[0]!.data).toMatchObject({ outcome: "diverged", reason: outcome.report.reason })
    expect((of(log, "replay.ended")[0]!.data.report as { divergence: { kind: string } }).divergence.kind).toBe("arguments_differ")
    expect(session.projection().session.lineage).toMatchObject({ changed: { instructions: false, tools: [], settings: true } })
    expect(session.projection().session.settings).toEqual({ model: "gpt-other", reasoningEffort: "high" })
    expect(of(log, "step.started").every((item) => item.data.model === "gpt-other")).toBe(true)
    check(recording, session)
  })

  test("under execute: the recorded workspace as it was at that point is restored into a copy, and the turn is finished there with real tools", async () => {
    const recording = await record()
    const copy = join(recording.root, "copy")
    const { outcome, session, log } = await replay(
      recording,
      { policy: "execute", workspace: copy },
      { ...otherWrite(recording.directory), ...afterwards },
      // Off the recording the model does as it likes: it looks, and answers.
      [[call("shell", { command: `cat ${join(recording.directory, "a.txt")} && pwd` })], say("It says three.")],
    )
    expect(outcome.report.status).toBe("diverged")
    expect(outcome.report.offTape).toEqual({ steps: 3, calls: 2, executed: 2 })
    expect(outcome.report.comparison.finalAnswer).toEqual({ recorded: "Added b.txt.", replayed: "It says three." })
    expect(outcome.workspace).toBe(copy)
    // The copy started from the workspace before the recorded write, and holds the replay's own; the original is as the recording left it.
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("three\n")
    expect(readFileSync(join(copy, "AGENTS.md"), "utf8")).toBe("Keep it short.\n")
    expect(existsSync(join(copy, "b.txt"))).toBe(false)
    expect(readFileSync(join(recording.directory, "a.txt"), "utf8")).toBe("two\n")
    const diverged = of(log, "replay.diverged")[0]!
    expect(diverged.data).toMatchObject({ workspace: copy, divergence: "arguments_differ" })
    expect(diverged.data.snapshot).toBe(of(recording.events, "snapshot.taken").find((item) => item.data.point === "step_start")!.data.id)
    expect(session.projection().session.replay?.workspace).toBe(copy)
    expect(session.projection().session.cwd).toBe(copy)
    expect(of(log, "replay.call").map((item) => [item.data.result, item.data.executed])).toEqual([
      ["matched", false],
      ["diverged", true],
      ["off_tape", true],
    ])
    // The model wrote the recording's path and was shown the recording's path: the copy stands in for it both ways.
    expect(of(log, "tool.settled").at(-1)!.data.output).toBe(`three\n${recording.directory}\n`)
    // From the divergence on it is an ordinary turn in the copy: its steps are bracketed by snapshots of the copy, and it ends as done.
    expect(types(log).filter((type) => type === "snapshot.taken").length).toBeGreaterThan(0)
    expect(types(log).slice(-2)).toEqual(["execution.succeeded", "replay.ended"])
    check(recording, session)
  })

  test("under execute-read-only: a read runs in the copy, a write ends the replay", async () => {
    const recording = await record()
    const copy = join(recording.root, "copy-ro")
    const { outcome, log } = await replay(recording, { policy: "execute-read-only", workspace: copy }, { 1: [call("read", { path: "AGENTS.md" })], ...afterwards }, [[call("write", { path: "c.txt", content: "no\n" })]])
    expect(outcome.report.status).toBe("diverged")
    expect(outcome.report.reason).toContain("stopped: write has effect write; execute-read-only runs only read tools")
    expect(of(log, "replay.call").map((item) => [item.data.result, item.data.executed])).toEqual([
      ["matched", false],
      ["diverged", true],
      ["off_tape", false],
    ])
    expect(existsSync(join(copy, "c.txt"))).toBe(false)
    expect(of(log, "tool.settled").at(-2)!.data.output).toContain("Keep it short.")
  })
})

describe("a replay that runs tools, with the approval layer on", () => {
  const sandboxed = createCommandSandbox().state.available

  test.skipIf(!sandboxed)("runs them in its copy inside the real sandbox with the network off, and asks nobody for more", async () => {
    const recording = await record()
    await recording.harness.close()
    // The same data directory, now with the approval layer and this machine's sandbox, as a user's harness has them.
    const guarded = start(recording.data, [], { engine: { approval: { secrets: [], grantsDir: join(recording.root, "grants") } } })
    guarded.provider.enqueue(
      ...responsesFromTape(recording.tape, { 1: [call("shell", { command: "cat a.txt > seen.txt && pwd" })], 2: null, 3: null, 4: null, 5: null }, [
        [call("shell", { command: "curl -s https://example.com", sandbox: { network: true } })],
        [call("write", { path: "/etc/replay-was-here", content: "no\n" })],
        say("Done in the copy."),
      ]),
    )
    const run = await guarded.harness.engine.replaySession(recording.session.id, { policy: "execute" })
    const outcome = await run.done
    await run.session.settled()
    const log = run.session.readEvents()
    const copy = outcome.workspace!
    // The copy is made where commands can reach it: beside the data directory, which the sandbox hides.
    expect(copy).toBe(join(`${recording.data}-work`, "replays", run.session.id))
    const [ran, network, outside] = of(log, "tool.settled").slice(1)
    expect(ran!.data).toMatchObject({ outcome: "success", output: `${recording.directory}\n` })
    expect(readFileSync(join(copy, "seen.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(recording.directory, "seen.txt"))).toBe(false)
    expect(of(log, "tool.started")[1]!.data.run).toMatchObject({ mode: "auto", sandbox: { network: false, writableRoots: [] } })
    // More than the sandbox gives needs a person, and a replay has none: refused, not asked, and the replay goes on.
    expect(network!.data.outcome).toBe("error")
    expect(outside!.data.outcome).toBe("error")
    expect(of(log, "approval.denied").map((item) => item.data.reason)).toEqual(["unattended", "unattended"])
    expect(of(log, "approval.requested")).toEqual([])
    expect(existsSync("/etc/replay-was-here")).toBe(false)
    expect(outcome.report.comparison.finalAnswer.replayed).toBe("Done in the copy.")
    expect(types(log).slice(-2)).toEqual(["execution.succeeded", "replay.ended"])
    rmSync(copy, { recursive: true, force: true })
  })
})

describe("a replay that cannot run to its end", () => {
  test("is incomplete when it is interrupted, and when its process stops: a replay is not taken up again", async () => {
    const recording = await record()
    recording.provider.enqueue([script.text("Thinking"), script.hang()])
    const run = await recording.harness.engine.replaySession(recording.session.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    run.session.interrupt()
    const outcome = await run.done
    expect(outcome.report.status).toBe("incomplete")
    expect(outcome.report.reason).toBe(REPLAY_TEXT.interrupted)
    const log = run.session.readEvents()
    expect(types(log).slice(-2)).toEqual(["execution.interrupted", "replay.ended"])
    check(recording, run.session)

    // The process stops in the middle of a replay (a shutdown here; a kill leaves the same claim behind).
    recording.provider.enqueue([script.text("Thinking"), script.hang()])
    const second = await recording.harness.engine.replaySession(recording.session.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const id = second.session.id
    await recording.harness.close()
    const next = start(recording.data, [])
    expect(next.harness.engine.getSession(id)?.session.execution?.status).toBe("suspended")
    const reopened = next.harness.engine.openSession(id)
    await reopened.settled()
    expect(reopened.projection().session.execution).toBeNull()
    expect(reopened.projection().session.replay?.ended).toMatchObject({ outcome: "incomplete" })
    // The shutdown ended the replay; the claim it left suspended is given up when the session is opened, not resumed.
    const tail = reopened.readEvents().slice(-3)
    expect(tail.map((item) => item.type)).toEqual(["execution.interrupted", "replay.ended", "execution.failed"])
    expect(tail[2]!.data).toMatchObject({ cause: "replay" })
    next.harness.sessions.read(id, (store) => expectRebuildEqualsLive(store as never, id))
    expect(next.provider.requests).toHaveLength(0)
  })

  test("stops as unsupported where the recording's history was rewound, and refuses a recording with nothing to replay", async () => {
    const recording = await record()
    await recording.session.revert({ handEdits: "overwrite" })
    recording.provider.enqueue(say("Fine."))
    recording.session.send("Do something else.")
    await recording.session.settled()
    const events = recording.session.readEvents()
    recording.provider.enqueue(...responsesFromTape(tapeFromEvents(events)))
    const run = await recording.harness.engine.replaySession(recording.session.id)
    const outcome = await run.done
    expect(outcome.report.status).toBe("unsupported")
    expect(outcome.report.reason).toContain("the recording has a revert before step")
    expect(of(run.session.readEvents(), "replay.ended")[0]!.data.outcome).toBe("unsupported")

    const empty = recording.harness.engine.createSession({ cwd: recording.directory, settings: SETTINGS })
    const refused = (await recording.harness.engine.replaySession(empty.id).catch((error: unknown) => error)) as EngineError
    expect(refused.code).toBe("invalid_request")
    expect(refused.message).toContain("never called the model")
    const unknown = (await recording.harness.engine.replaySession(recording.session.id, { toolDescriptions: { nope: "x" } }).catch((error: unknown) => error)) as EngineError
    expect(unknown.message).toContain("no tool named nope")
    expect(((await recording.harness.engine.replaySession("ses_none" as SessionId).catch((error: unknown) => error)) as EngineError).code).toBe("session_not_found")
  })
})
