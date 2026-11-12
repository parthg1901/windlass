/**
 * Crash recovery with a real process. A child runs the loop on a store file
 * against the scripted provider and is killed with SIGKILL at a named point
 * of the loop (through the engine's injected probe, see
 * `fixtures/engine-child.ts`). The parent then opens the same file, recovers
 * and continues, and checks the log, the projection and the next request.
 *
 * A compaction is killed at its two durable points. Another test kills the
 * whole process group of an engine whose shell tool is running a command,
 * and checks that nothing of that command survives.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StoredEvent } from "../../src/event/durable.ts"
import { brand } from "../../src/brand.ts"
import { loadConfig } from "../../src/config/load.ts"
import { TOOL_TEXT } from "../../src/engine/constants.ts"
import { type ProbePoint, createEngine } from "../../src/engine/engine.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { buildRequest } from "../../src/request/build.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { createStandardTools } from "../../src/tools/index.ts"
import { exportSession } from "../../src/trace/export.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { danglingCalls } from "./harness.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "engine-child.ts")

const directories: string[] = []
const children: Bun.Subprocess[] = []
afterAll(() => {
  for (const child of children) child.kill("SIGKILL")
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

/** A workspace for the child. With `check`, a project: its configuration declares that command as the check `exists`. */
function place(check?: string) {
  const directory = mkdtempSync(join(tmpdir(), "lh-engine-crash-"))
  directories.push(directory)
  const workspace = join(directory, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "a.txt"), "alpha\n")
  writeFileSync(join(workspace, "b.txt"), "old\n")
  const where = { directory, database: join(directory, "store.db"), workspace, project: check !== undefined }
  if (check !== undefined) configure(where, check)
  return where
}

type Place = ReturnType<typeof place>

function configure(where: Pick<Place, "workspace">, check: string) {
  mkdirSync(join(where.workspace, `.${brand.directory}`), { recursive: true })
  writeFileSync(join(where.workspace, `.${brand.directory}`, "config.json"), JSON.stringify({ checks: [{ name: "exists", command: check }] }))
}

/** Runs the child until it kills itself at the crash point. */
async function crashAt(name: string, point: ProbePoint, nth: number, check?: string) {
  const where = place(check)
  const child = Bun.spawn([process.execPath, FIXTURE, where.database, where.workspace, name, point, String(nth)], { stdout: "ignore", stderr: "pipe" })
  children.push(child)
  await child.exited
  if (child.signalCode !== "SIGKILL")
    throw new Error(`the child was not killed at ${point} #${nth} (exit ${child.exitCode}): ${await new Response(child.stderr).text()}`)
  return where
}

/** Whether a request is a compaction's summary request: tools switched off, and a developer prompt last. */
const isSummary = (request: ModelRequest) => request.toolChoice === "none" && request.input.at(-1)?.type === "message"

/** Opens the store a dead process left, recovers its session and lets the loop finish the turn. `contextWindow`: what the engine that recovers is told. */
async function recoverAndContinue(where: Pick<Place, "database" | "workspace"> & Partial<Place>, contextWindow?: number) {
  const store = openSqliteStore({ path: where.database })
  try {
    const [summary] = store.listSessions()
    if (summary === undefined) throw new Error("the child created no session")
    const id = summary.session.id
    const died = store.readEvents(id)
    // Whatever the model is asked after the restart, it wraps up; asked for a summary, it gives one.
    const provider = new FakeProvider(Array.from({ length: 4 }, () => (request: ModelRequest) => [script.text(isSummary(request) ? SUMMARY : "Recovered and finished.")]))
    const diagnostics: string[] = []
    const engine = createEngine({
      store,
      provider,
      tools: createStandardTools({ spillDir: join(where.workspace, ".spill") }),
      discover: () => [],
      ...(where.project && where.directory !== undefined
        ? { dataDir: join(where.directory, "data"), loadConfig: (cwd: string) => loadConfig({ cwd, env: {}, home: join(where.directory!, "home") }) }
        : { dataDir: where.workspace, snapshots: null, loadConfig: null }),
      log: (line) => diagnostics.push(line),
      ...(contextWindow === undefined ? {} : { contextWindow: () => contextWindow }),
      strict: true,
    })
    const session = engine.openSession(id)
    // Recovery is one synchronous append while opening.
    const recovery = store.readEvents(id, { afterSeq: died.at(-1)!.seq }).filter((item) => !["baseline.set", "inbox.delivered", "step.started"].includes(item.type))
    // A claim is recovered up to the event that decides it; a revert has no claim and is finished in the background.
    const decided = recovery.findIndex((item) => item.type.startsWith("execution."))
    const recovered = decided === -1 ? [] : recovery.slice(0, decided + 1)
    await session.settled()
    await engine.close()

    const projection = expectRebuildEqualsLive(store, id)
    const log = store.readEvents(id)
    expect(diagnostics).toEqual([])
    // The claim is released and nothing is left open.
    expect(projection.session.execution).toBeNull()
    expect(projection.session.open).toBeNull()
    expect(unsettled(log)).toEqual([])
    const request = buildRequest(projection, { toolChoice: "auto" })
    expect(danglingCalls(request.input)).toEqual([])
    return { died, recovered, log, projection, calls: provider.calls.length }
  } finally {
    store.close()
  }
}

/** Calls without exactly one result. */
function unsettled(log: readonly StoredEvent[]) {
  const key = (data: { messageId: string; callId: string }) => `${data.messageId}/${data.callId}`
  const settled = log.flatMap((item) => (item.type === "tool.settled" ? [key(item.data)] : []))
  return log.flatMap((item) => (item.type === "tool.called" && settled.filter((entry) => entry === key(item.data)).length !== 1 ? [key(item.data)] : []))
}

const types = (events: readonly StoredEvent[]): string[] => events.map((item) => item.type)
const outcomes = (events: readonly StoredEvent[]) =>
  events.flatMap((item) => (item.type === "tool.settled" ? [`${item.data.callId} ${item.data.outcome}`] : []))
const CRASHED = ["step.failed", "synthetic.appended", "execution.resumed"]

interface Case {
  readonly script?: string
  readonly point: ProbePoint
  readonly nth: number
  readonly what: string
  /** The event types recovery appends, up to the event that decides the claim. */
  readonly recovery: readonly string[]
  /** How recovery settles the calls the dead process left unsettled. */
  readonly settles?: readonly string[]
  readonly ends: "execution.succeeded" | "execution.interrupted"
}

const CASES: readonly Case[] = [
  { point: "execution.claimed", nth: 1, what: "the claim is taken and nothing else happened", recovery: ["execution.resumed"], ends: "execution.succeeded" },
  { point: "step.started", nth: 1, what: "the step started and its request was not sent", recovery: CRASHED, ends: "execution.succeeded" },
  { point: "model.output", nth: 1, what: "the first text is durable and the response is still streaming", recovery: CRASHED, ends: "execution.succeeded" },
  {
    point: "model.output",
    nth: 3,
    what: "both calls are recorded and none has started",
    recovery: ["tool.settled", "tool.settled", ...CRASHED],
    settles: ["call_1 not_started", "call_2 not_started"],
    ends: "execution.succeeded",
  },
  {
    point: "tool.started",
    nth: 1,
    what: "the read has started and the write has not",
    recovery: ["tool.settled", "tool.settled", ...CRASHED],
    settles: ["call_1 error", "call_2 not_started"],
    ends: "execution.succeeded",
  },
  {
    point: "tool.started",
    nth: 2,
    what: "both tools have started",
    recovery: ["tool.settled", "tool.settled", ...CRASHED],
    settles: ["call_1 error", "call_2 effect_unknown"],
    ends: "execution.succeeded",
  },
  {
    point: "tool.finished",
    nth: 1,
    what: "a tool has finished and its result is not written",
    recovery: ["tool.settled", "tool.settled", ...CRASHED],
    settles: ["call_1 error", "call_2 effect_unknown"],
    ends: "execution.succeeded",
  },
  { point: "tool.settled", nth: 1, what: "one result is durable and the other tool is still running", recovery: ["tool.settled", ...CRASHED], ends: "execution.succeeded" },
  { point: "step.closed", nth: 1, what: "the step ended and the next has not begun", recovery: ["execution.resumed"], ends: "execution.succeeded" },
  { point: "step.boundary", nth: 3, what: "the loop is between the second and the third step", recovery: ["execution.resumed"], ends: "execution.succeeded" },
  { script: "retry", point: "retry.scheduled", nth: 1, what: "a retry is scheduled and the wait has begun", recovery: CRASHED, ends: "execution.succeeded" },
  {
    script: "interrupt",
    point: "interrupt.requested",
    nth: 1,
    what: "the user's cancel is durable and nothing was stopped",
    recovery: ["tool.settled", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"],
    settles: ["call_1 error", "call_2 not_started"],
    ends: "execution.interrupted",
  },
  { point: "execution.ending", nth: 1, what: "the answer is durable and the claim is not released", recovery: ["execution.resumed"], ends: "execution.succeeded" },
]

describe("a process killed with SIGKILL is recovered by the next one", () => {
  for (const item of CASES)
    test(`${item.point} #${item.nth}: ${item.what}`, async () => {
      const where = await crashAt(item.script ?? "normal", item.point, item.nth)
      const result = await recoverAndContinue(where)
      expect(types(result.recovered)).toEqual([...item.recovery])
      if (item.settles !== undefined) expect(outcomes(result.recovered)).toEqual([...item.settles])
      expect(result.log.findLast((entry) => entry.type.startsWith("execution."))!.type).toBe(item.ends)
      const closed = result.recovered.find((entry) => entry.type === "step.failed")
      if (closed?.type === "step.failed")
        expect(closed.data.error).toEqual(item.ends === "execution.interrupted" ? { kind: "interrupted", reason: "user" } : { kind: "crashed" })
      // A cancelled turn is never resumed; a crashed one is finished by the model.
      expect(result.calls).toBe(item.ends === "execution.interrupted" || item.point === "execution.ending" ? 0 : 1)
    })

  test("the texts recovery freezes say what is known about each orphaned call", async () => {
    const result = await recoverAndContinue(await crashAt("normal", "tool.started", 2))
    const texts = result.recovered.flatMap((item) => (item.type === "tool.settled" ? [item.data.output] : []))
    expect<string[]>(texts).toEqual([TOOL_TEXT.crashRead, TOOL_TEXT.crashEffectUnknown])
  })
})

describe("a process killed inside a compaction", () => {
  const view = (result: Awaited<ReturnType<typeof recoverAndContinue>>) => selectModelHistory(result.projection).messages.map((message) => message.kind)

  test("compaction.started #1: the cut and the prompt are durable and the summary was never asked for; the next process closes it and compacts again", async () => {
    const where = await crashAt("compaction", "compaction.started", 1)
    const result = await recoverAndContinue(where, 10_000)
    expect(types(result.died).at(-1)).toBe("compaction.started")
    // No step was cut short, so there is no marker: the compaction is closed as crashed and the execution taken up again.
    expect(types(result.recovered)).toEqual(["compaction.failed", "execution.resumed"])
    expect(result.recovered[0]).toMatchObject({ data: { error: { kind: "crashed" } } })
    // The loop decided again from the log: the request is as large as it was, so it compacted, under a new message.
    const compactions = result.projection.messages.filter((message) => message.kind === "compaction")
    expect(compactions.map((message) => message.status)).toEqual(["failed", "completed"])
    expect(compactions[1]).toMatchObject({ source: "model", keepFromSeq: compactions[0]!.keepFromSeq })
    expect(view(result)).toEqual(["compaction", "assistant", "assistant"])
    expect(result.log.at(-1)!.type).toBe("execution.succeeded")
    // One summary call and one answer after the restart.
    expect(result.calls).toBe(2)
  })

  test("compaction.ended #1: the checkpoint is durable and the baseline was not set again; the next process sets it and carries on", async () => {
    const where = await crashAt("compaction", "compaction.ended", 1)
    const result = await recoverAndContinue(where, 10_000)
    expect(types(result.died).at(-1)).toBe("compaction.ended")
    expect(types(result.recovered)).toEqual(["execution.resumed"])
    const after = types(result.log.slice(result.died.length))
    expect(after).toEqual(["execution.resumed", "baseline.set", "step.started", "text.ended", "step.ended", "execution.succeeded"])
    // The checkpoint the dead process froze is the one the model continued from: nothing was summarised twice.
    expect(result.projection.messages.filter((message) => message.kind === "compaction").map((message) => message.status)).toEqual(["completed"])
    expect(result.calls).toBe(1)
    expect(view(result)).toEqual(["compaction", "assistant", "assistant"])
  })

  test("the summary request of a compaction a dead process started can still be rebuilt from the log", async () => {
    const where = await crashAt("compaction", "compaction.ended", 1)
    const store = openSqliteStore({ path: where.database })
    try {
      const id = store.listSessions()[0]!.session.id
      const result = exportSession(store, id)
      expect(result.unverified).toEqual([])
      expect(result.calls.map((call) => [call.row.purpose, call.request !== null])).toEqual([
        ["step", true],
        ["compaction", true],
      ])
    } finally {
      store.close()
    }
  })
})

describe("no tool subprocess outlives the engine's process", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const until = async (condition: () => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (!condition() && Date.now() < deadline) await Bun.sleep(20)
    return condition()
  }

  test(
    "killing the engine's process group with SIGKILL also ends the command its shell tool was running, and the call is recovered as effect unknown",
    async () => {
      const where = place()
      // A group of its own, as a terminal gives a foreground job.
      const child = Bun.spawn([process.execPath, FIXTURE, where.database, where.workspace, "shell"], { stdout: "ignore", stderr: "pipe", detached: true })
      children.push(child)
      const pidFiles = ["tool.pid", "background.pid"].map((name) => join(where.workspace, name))
      const started = await until(() => pidFiles.every((file) => existsSync(file) && readFileSync(file, "utf8").trim() !== ""), 10_000)
      if (!started) throw new Error(`the command never started: ${child.killed ? "" : "still running"}`)
      const pids = pidFiles.map((file) => Number(readFileSync(file, "utf8").trim()))
      expect(pids.every(alive)).toBe(true)

      process.kill(-child.pid, "SIGKILL")
      await child.exited
      expect(await until(() => !pids.some(alive), 5000)).toBe(true)

      const result = await recoverAndContinue(where)
      expect(outcomes(result.recovered)).toEqual(["call_1 effect_unknown"])
      expect(types(result.recovered)).toEqual(["tool.settled", ...CRASHED])
    },
    30_000,
  )
})

describe("a process killed inside a run of checks", () => {
  const verification = (log: readonly StoredEvent[]) => log.findLast((item) => item.type === "execution.succeeded")?.data.verification

  for (const [point, what] of [
    ["checks.started", "the run's start is durable and no command has run"],
    ["checks.finished", "the command has finished and its result is not written"],
  ] as const)
    test(`${point}: ${what}`, async () => {
      const result = await recoverAndContinue(await crashAt("checks", point, 1, "test -f b.txt"))
      expect(types(result.died).at(-1)).toBe("checks.started")
      expect(types(result.recovered)).toEqual(["checks.failed", "execution.resumed"])
      expect(result.recovered[0]).toMatchObject({ data: { run: 1, error: { kind: "crashed" } } })
      // The model's answer stands, so it is not called again: the checks run once more and the turn ends on their result.
      expect(result.calls).toBe(0)
      expect(types(result.log).filter((type) => type === "checks.started")).toHaveLength(2)
      expect(verification(result.log)).toMatchObject({ status: "passed", evidence: { run: 1, changedFiles: ["b.txt"], checks: [{ name: "exists", status: "passed", exitCode: 0 }] } })
    })

  test(
    "killing the process group while a check command runs ends the command too, and the next start runs the checks again",
    async () => {
      const where = place("echo $$ > check.pid; sleep 300")
      const child = Bun.spawn([process.execPath, FIXTURE, where.database, where.workspace, "checks"], { stdout: "ignore", stderr: "pipe", detached: true })
      children.push(child)
      const pidFile = join(where.workspace, "check.pid")
      const deadline = Date.now() + 15_000
      while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "") && Date.now() < deadline) await Bun.sleep(20)
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      const alive = () => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      expect(alive()).toBe(true)
      process.kill(-child.pid, "SIGKILL")
      await child.exited
      const gone = Date.now() + 5000
      while (alive() && Date.now() < gone) await Bun.sleep(20)
      expect(alive()).toBe(false)

      // The configuration is read when an execution starts: the project's check is fixed before the restart.
      rmSync(pidFile)
      configure(where, "test -f b.txt")
      const result = await recoverAndContinue(where)
      expect(types(result.recovered)).toEqual(["checks.failed", "execution.resumed"])
      expect(verification(result.log)).toMatchObject({ status: "passed" })
      expect(result.calls).toBe(0)
    },
    30_000,
  )
})

describe("a process killed inside a revert", () => {
  for (const [point, what, changed] of [
    ["revert.started", "the restore is announced and no file was touched", 1],
    ["revert.restored", "the files are restored and the revert is not recorded", 0],
  ] as const)
    test(`${point}: ${what}`, async () => {
      const where = await crashAt("revert", point, 1, "test -f b.txt")
      expect(readFileSync(join(where.workspace, "b.txt"), "utf8")).toBe(point === "revert.started" ? "new\n" : "old\n")
      const result = await recoverAndContinue(where)
      expect(types(result.died).slice(-2)).toEqual(["snapshot.taken", "revert.started"])
      // Opening the session finishes the revert: the workspace is as it was before the turn and the turn has left history.
      const after = result.log.slice(result.died.length)
      expect(types(after)).toEqual(["snapshot.taken", "history.reverted"])
      const started = result.died.at(-1)!
      if (started.type !== "revert.started") throw new Error("the child did not announce the revert")
      expect(after[1]).toMatchObject({ data: { restore: { target: started.data.target, before: started.data.before, changed } } })
      expect(readFileSync(join(where.workspace, "b.txt"), "utf8")).toBe("old\n")
      expect(result.projection.messages.every((message) => message.excluded === "reverted")).toBe(true)
      expect(result.projection.session.reverts).toHaveLength(1)
      expect(result.calls).toBe(0)
    })
})
