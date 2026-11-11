/**
 * Crash recovery with a real process. A child runs the loop on a store file
 * against the scripted provider and is killed with SIGKILL at a named point
 * of the loop (through the engine's injected probe, see
 * `fixtures/engine-child.ts`). The parent then opens the same file, recovers
 * and continues, and checks the log, the projection and the next request.
 *
 * The last test kills the whole process group of an engine whose shell tool
 * is running a command, and checks that nothing of that command survives.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StoredEvent } from "../../src/event/durable.ts"
import { TOOL_TEXT } from "../../src/engine/constants.ts"
import { type ProbePoint, createEngine } from "../../src/engine/engine.ts"
import { buildRequest } from "../../src/request/build.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { createStandardTools } from "../../src/tools/index.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"
import { danglingCalls } from "./harness.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "engine-child.ts")

const directories: string[] = []
const children: Bun.Subprocess[] = []
afterAll(() => {
  for (const child of children) child.kill("SIGKILL")
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function place() {
  const directory = mkdtempSync(join(tmpdir(), "lh-engine-crash-"))
  directories.push(directory)
  const workspace = join(directory, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "a.txt"), "alpha\n")
  writeFileSync(join(workspace, "b.txt"), "old\n")
  return { database: join(directory, "store.db"), workspace }
}

/** Runs the child until it kills itself at the crash point. */
async function crashAt(name: string, point: ProbePoint, nth: number) {
  const where = place()
  const child = Bun.spawn([process.execPath, FIXTURE, where.database, where.workspace, name, point, String(nth)], { stdout: "ignore", stderr: "pipe" })
  children.push(child)
  await child.exited
  if (child.signalCode !== "SIGKILL")
    throw new Error(`the child was not killed at ${point} #${nth} (exit ${child.exitCode}): ${await new Response(child.stderr).text()}`)
  return where
}

/** Opens the store a dead process left, recovers its session and lets the loop finish the turn. */
async function recoverAndContinue(where: { database: string; workspace: string }) {
  const store = openSqliteStore({ path: where.database })
  try {
    const [summary] = store.listSessions()
    if (summary === undefined) throw new Error("the child created no session")
    const id = summary.session.id
    const died = store.readEvents(id)
    // Whatever the model is asked after the restart, it wraps up.
    const provider = new FakeProvider(Array.from({ length: 4 }, () => () => [script.text("Recovered and finished.")]))
    const diagnostics: string[] = []
    const engine = createEngine({
      store,
      provider,
      tools: createStandardTools({ spillDir: join(where.workspace, ".spill") }),
      dataDir: where.workspace,
      discover: () => [],
      log: (line) => diagnostics.push(line),
      strict: true,
    })
    const session = engine.openSession(id)
    // Recovery is one synchronous append while opening.
    const recovery = store.readEvents(id, { afterSeq: died.at(-1)!.seq }).filter((item) => !["baseline.set", "inbox.delivered", "step.started"].includes(item.type))
    const recovered = recovery.slice(0, recovery.findIndex((item) => item.type.startsWith("execution.")) + 1)
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
  { point: "execution.ending", nth: 1, what: "the answer is durable and the claim is not released", recovery: ["execution.succeeded"], ends: "execution.succeeded" },
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
