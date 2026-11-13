/**
 * Crash recovery with a real process, for forks, replays and spawned work.
 * A child process runs the real assembly with a scripted model and kills
 * itself with SIGKILL at a named point (`fixtures/lineage-child.ts`); this
 * process then opens the same data directory and checks what is there and
 * what recovery makes of it.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Harness, createHarness } from "../../src/assembly.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../src/testing/fake-provider.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "lineage-child.ts")
const directories: string[] = []
const harnesses: Harness[] = []
const children: Bun.Subprocess[] = []
afterAll(async () => {
  for (const harness of harnesses) await harness.close()
  for (const child of children) child.kill("SIGKILL")
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const types = (events: readonly StoredEvent[]) => events.map((item) => item.type)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sh = (cwd: string, command: string) => {
  const done = Bun.spawnSync(["bash", "-c", command], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (done.exitCode !== 0) throw new Error(`${command}: ${done.stderr.toString()}`)
  return done.stdout.toString()
}

/** Runs the child until it kills itself. */
async function crash(name: string, git = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-lineage-crash-")))
  directories.push(root)
  const workspace = join(root, "workspace")
  const data = join(root, "data")
  mkdirSync(workspace)
  mkdirSync(data)
  writeFileSync(join(workspace, "a.txt"), "alpha\n")
  writeFileSync(join(workspace, "b.txt"), "old\n")
  if (git) sh(workspace, "git init -q -b main && git add -A && git commit -q -m first")
  const child = Bun.spawn([process.execPath, FIXTURE, data, workspace, name], { stdout: "ignore", stderr: "pipe" })
  children.push(child)
  await child.exited
  if (child.signalCode !== "SIGKILL") throw new Error(`the child was not killed in ${name} (exit ${child.exitCode}): ${await new Response(child.stderr).text()}`)
  return { root, data, workspace, parent: readFileSync(join(data, "parent.id"), "utf8") as SessionId }
}

/** The next process on the same data directory. */
function reopen(data: string, responses: readonly ScriptedResponse[] = []) {
  const provider = new FakeProvider([...responses])
  const harness = createHarness({ dataDir: data, provider, log: () => {}, engine: { approval: null, loadConfig: null, discover: () => [] } })
  harnesses.push(harness)
  return { harness, provider }
}

const until = async (check: () => boolean) => {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 15_000) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

describe("a process that dies", () => {
  test("during a fork: no half-made session is listed, the parent is as it was, and the fork can be made again", async () => {
    const { root, data, parent } = await crash("fork")
    const { harness, provider } = reopen(data, [[script.text("In the fork.")]])
    const engine = harness.engine
    // The copy was made; the session was not. Nothing lists it and nothing refers to it.
    expect(existsSync(join(root, "fork-copy", "b.txt"))).toBe(true)
    expect(engine.listSessions({ includeArchived: true }).map((summary) => summary.session.id)).toEqual([parent])
    expect(readdirSync(join(data, "sessions")).filter((name) => name.endsWith(".db"))).toEqual([`${parent}.db`])
    const before = engine.readEvents(parent)
    const fork = await engine.forkSession(parent, { workspace: { copyTo: join(root, "fork-copy") } })
    fork.send("Go on.")
    await fork.settled()
    expect(engine.readEvents(parent)).toEqual(before)
    expect(fork.projection().session.lineage).toMatchObject({ kind: "fork", parentSessionId: parent, copied: { from: join(root, "workspace") } })
    expect(readFileSync(join(root, "fork-copy", "b.txt"), "utf8")).toBe("new\n")
    expect(provider.requests).toHaveLength(1)
    harness.sessions.read(fork.id, (store) => expectRebuildEqualsLive(store as never, fork.id))
  })

  test("during a replay: the replay session is consistent and ends as incomplete; nothing is taken up, nothing ran", async () => {
    const { data, workspace, parent } = await crash("replay")
    const replayId = readFileSync(join(data, "replay.id"), "utf8") as SessionId
    // The recording wrote b.txt; the replay answered the same call from the recording and wrote nothing.
    writeFileSync(join(workspace, "b.txt"), "by hand\n")
    const { harness, provider } = reopen(data)
    const before = harness.engine.readEvents(replayId)
    expect(of(before, "replay.call").map((item) => item.data.result)).toEqual(["matched", "matched"])
    expect(harness.engine.getSession(replayId)?.session.execution?.status).toBe("running")
    const session = harness.engine.openSession(replayId)
    await session.settled()
    const log = session.readEvents()
    // The step the process died in is closed as crashed, like any; then the replay is given up, not resumed.
    expect(types(log.slice(before.length))).toEqual(["step.failed", "synthetic.appended", "execution.resumed", "execution.failed", "replay.ended"])
    expect(of(log, "execution.failed")[0]!.data.cause).toBe("replay")
    expect(session.projection().session.replay?.ended).toMatchObject({ outcome: "incomplete" })
    expect(session.projection().session.execution).toBeNull()
    expect(provider.requests).toHaveLength(0)
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("by hand\n")
    harness.sessions.read(replayId, (store) => expectRebuildEqualsLive(store as never, replayId))
    // The recording itself is untouched and can be replayed again.
    expect(harness.engine.getSession(parent)?.session.execution).toBeNull()
  })

  test("with a background command and a background subagent running: both die with it, both are recorded as lost, the subagent's turn is ended, and the model is told", async () => {
    const { data, workspace, parent } = await crash("background")
    const pids = ["command.pid", "child.pid"].map((name) => Number(readFileSync(join(workspace, name), "utf8")))
    // The guard of each command killed its process group when the harness died.
    await until(() => pids.every((pid) => !alive(pid)))
    const { harness } = reopen(data, [[script.text("Both were lost in the restart.")]])
    expect(harness.engine.getSession(parent)?.session.spawned?.running.map((entry) => entry.kind).sort()).toEqual(["command", "subagent"])
    const session = harness.engine.openSession(parent)
    await until(() => session.projection().session.spawned?.running.length === 0)
    const log = session.readEvents()
    expect(of(log, "spawn.ended").map((item) => item.data.outcome)).toEqual(["lost", "lost"])
    const child = session.projection().session.spawned!.children[0]!
    const childLog = harness.engine.readEvents(child)
    expect(types(childLog).slice(-3)).toEqual(["execution.resumed", "execution.interrupt_requested", "execution.interrupted"])
    expect(of(childLog, "tool.settled").at(-1)!.data.outcome).toBe("effect_unknown")
    expect(harness.engine.getSession(child)?.session.execution).toBeNull()
    // The turn had ended before the crash, so opening the session starts nothing: the two messages wait for the next prompt.
    expect(session.projection().inbox.map((item) => item.origin)).toEqual(["spawn_lost", "spawn_lost"])
    session.send("What happened?")
    await session.settled()
    expect(types(session.readEvents()).at(-1)).toBe("execution.succeeded")
    harness.sessions.read(parent, (store) => expectRebuildEqualsLive(store as never, parent))
    harness.sessions.read(child, (store) => expectRebuildEqualsLive(store as never, child))
  })

  test("during a worktree merge: the merge is finished at the next start, the files are all there, and the repository is otherwise as the user left it", async () => {
    const { data, workspace, parent } = await crash("merge", true)
    // The first file was written and the process died: the workspace is half merged right now, and the worktree and its branch still exist.
    expect([readFileSync(join(workspace, "a.txt"), "utf8"), readFileSync(join(workspace, "b.txt"), "utf8")]).toEqual(["alpha changed\n", "old\n"])
    expect(sh(workspace, "git worktree list --porcelain | grep -c '^worktree '").trim()).toBe("2")
    const { harness } = reopen(data, [[script.text("The subagent's changes are merged.")], [script.text("Noted.")]])
    const session = harness.engine.openSession(parent)
    await until(() => session.projection().session.spawned?.running.length === 0)
    await session.settled()
    const ended = of(session.readEvents(), "spawn.ended")[0]!
    expect(ended.data).toMatchObject({ outcome: "completed", merge: { status: "merged", files: ["a.txt", "b.txt"], kept: false } })
    expect([readFileSync(join(workspace, "a.txt"), "utf8"), readFileSync(join(workspace, "b.txt"), "utf8")]).toEqual(["alpha changed\n", "new\n"])
    // The worktree and the harness's branch are cleaned up; the user's branch and index never moved.
    expect(sh(workspace, "git worktree list --porcelain | grep -c '^worktree '").trim()).toBe("1")
    expect(sh(workspace, "git branch --list").trim()).toBe("* main")
    expect(sh(workspace, "git diff --cached --name-only").trim()).toBe("")
    expect(sh(workspace, "git status --porcelain | cut -c4- | sort").trim().split("\n")).toEqual(["a.txt", "b.txt"])
    expect(of(session.readEvents(), "inbox.enqueued").at(-1)!.data.origin).toBe("subagent_result")
    expect(types(session.readEvents()).at(-1)).toBe("execution.succeeded")
    harness.sessions.read(parent, (store) => expectRebuildEqualsLive(store as never, parent))
  })
})
