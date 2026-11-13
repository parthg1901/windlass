/**
 * Several harness processes on one data directory, each a real process with
 * the real assembly and a scripted model: two working at once in different
 * workspaces and in the same one, a third listing while they do, a session
 * held by a live process and by a dead one, and snapshots of one workspace
 * taken and pruned by several processes at once.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../../src/assembly.ts"
import type { SessionId } from "../../src/id.ts"
import { openSnapshots } from "../../src/snapshot/index.ts"
import { openSessionDirectory } from "../../src/store/directory.ts"
import { FakeProvider } from "../../src/testing/fake-provider.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const FIXTURE = join(import.meta.dir, "fixtures", "harness-child.ts")
const scratch: string[] = []
const children: Bun.Subprocess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
})
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

function place() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-processes-")))
  scratch.push(root)
  const workspace = (name: string) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, "README.md"), `# ${name}\n`)
    return join(root, name)
  }
  return { root, data: join(root, "data"), workspace }
}

function spawn(...args: string[]) {
  const child = Bun.spawn([process.execPath, FIXTURE, ...args], { stdout: "pipe", stderr: "pipe" })
  children.push(child)
  const lines: string[] = []
  const reading = (async () => {
    const decoder = new TextDecoder()
    let rest = ""
    for await (const chunk of child.stdout) {
      rest += decoder.decode(chunk, { stream: true })
      const parts = rest.split("\n")
      rest = parts.pop()!
      lines.push(...parts)
    }
  })()
  const errors = new Response(child.stderr).text()
  /** Resolves with the session ID once the child has said `started <id>`. */
  const started = async () => {
    const line = await waitFor(
      () => {
        if (child.exitCode !== null) throw new Error("the child exited before it started")
        return lines.find((entry) => entry.startsWith("started "))
      },
      { timeoutMs: 20_000, intervalMs: 5, what: "the child to start" },
    ).catch(async (error: Error) => {
      throw new Error(`${error.message}: ${await errors}`)
    })
    return line.slice("started ".length) as SessionId
  }
  /** Resolves with the JSON the child printed last, once it has exited cleanly. */
  const result = async <T>() => {
    const code = await child.exited
    await reading
    if (code !== 0) throw new Error(`the child failed (${code}): ${await errors}`)
    return JSON.parse(lines.at(-1)!) as T
  }
  return { child, started, result }
}

const run = <T>(...args: string[]) => spawn(...args).result<T>()

interface Turn {
  readonly sessionId: SessionId
  readonly end: string
  readonly events: number
  readonly requests: number
}
type Listing = { id: string; cwd: string; lastSeq: number; execution: string | null }[]

/** The checks every finished session passes, from this process: its file folds to its rows, its ledger is its own. */
function verify(data: string, ids: readonly SessionId[]) {
  const directory = openSessionDirectory({ dataDir: data, notice: () => {} })
  try {
    for (const id of ids) {
      const store = directory.open(id)
      expectRebuildEqualsLive(store, id)
      expect(store.readRequests(id).map((row) => row.outcome)).toEqual(["ok", "ok", "ok", "ok"])
      expect(store.readRequests(id).every((row) => row.sessionId === id)).toBe(true)
      store.close()
    }
  } finally {
    directory.close()
  }
}

describe("two processes working at once", () => {
  test("in different workspaces: both turns run to their end, and a third process lists them while they run", async () => {
    const { data, workspace } = place()
    const a = spawn("turn", data, workspace("a"), "alpha", "900")
    const b = spawn("turn", data, workspace("b"), "beta", "900")
    const ids = await Promise.all([a.started(), b.started()])
    // Both are in the middle of a turn, each holding its own session. A third process lists them.
    const during = await run<Listing>("list", data)
    expect(during.map((entry) => entry.id).sort()).toEqual([...ids].sort())
    expect(during.map((entry) => entry.execution)).toEqual(["running", "running"])
    // And is refused if it tries to work in one of them, with the holder named.
    expect(await run("open", data, ids[0])).toMatchObject({ ok: false, code: "session_in_use", holderPid: a.child.pid })

    const [first, second] = await Promise.all([a.result<Turn>(), b.result<Turn>()])
    expect([first.end, second.end]).toEqual(["execution.succeeded", "execution.succeeded"])
    expect([first.sessionId, second.sessionId]).toEqual(ids)
    for (const [name, label] of [["a", "alpha"], ["b", "beta"]] as const) {
      expect(readFileSync(join(workspace(name), `${label}-1.txt`), "utf8")).toBe(`${label} one\n`)
      expect(readFileSync(join(workspace(name), `${label}-2.txt`), "utf8")).toBe(`${label} two\n`)
    }
    const after = await run<Listing>("list", data)
    expect(Object.fromEntries(after.map((entry) => [entry.id, [entry.lastSeq, entry.execution]]))).toEqual({ [first.sessionId]: [first.events, null], [second.sessionId]: [second.events, null] })
    verify(data, ids)
  }, 120_000)

  test("in the same workspace: both turns run, each records its own snapshots, and each undo asks about the other's files", async () => {
    const { data, workspace } = place()
    const shared = workspace("shared")
    const a = spawn("turn", data, shared, "alpha", "700")
    const b = spawn("turn", data, shared, "beta", "700")
    const ids = await Promise.all([a.started(), b.started()])
    const [first, second] = await Promise.all([a.result<Turn>(), b.result<Turn>()])
    expect([first.end, second.end]).toEqual(["execution.succeeded", "execution.succeeded"])
    for (const label of ["alpha", "beta"]) for (const part of [1, 2]) expect(readFileSync(join(shared, `${label}-${part}.txt`), "utf8")).toBe(`${label} ${part === 1 ? "one" : "two"}\n`)
    verify(data, ids)

    // Every snapshot either log names is in the shared private git directory, under that session's own refs.
    const snapshots = await openSnapshots(shared, { dataDir: join(data, "snapshots") })
    if (snapshots.kind !== "ready") throw new Error("no snapshots")
    const harness = createHarness({ dataDir: data, provider: new FakeProvider([]), log: () => {}, engine: { approval: null, loadConfig: null, discover: () => [] } })
    try {
      for (const id of ids) {
        const named = harness.engine.readEvents(id).flatMap((item) => (item.type === "snapshot.taken" ? [item.data.id] : []))
        expect(named.length).toBeGreaterThanOrEqual(7)
        const refs = new Set((await snapshots.list({ session: id })).map((ref) => ref.id as string))
        for (const snapshot of named) expect(refs.has(snapshot)).toBe(true)
      }
      // Each session's undo would remove its own two files, and knows that the other two are not its own.
      for (const [id, own, other] of [[ids[0], "alpha", "beta"], [ids[1], "beta", "alpha"]] as const) {
        const session = harness.engine.openSession(id, { resume: "wait" })
        const preview = await session.revert({ dryRun: true })
        if (preview.kind !== "preview") throw new Error(`no preview: ${preview.kind}`)
        const flags = Object.fromEntries(preview.plan.changes.map((change) => [change.path, change.handEdited]))
        expect(flags[`${own}-1.txt`]).toBe(false)
        expect(flags[`${own}-2.txt`]).toBe(false)
        // What the other session wrote since this one's turn began is flagged wherever the restore would touch it.
        for (const path of Object.keys(flags).filter((name) => name.startsWith(other))) expect(flags[path]).toBe(true)
        expect((await session.revert()).kind).toBe(Object.keys(flags).some((name) => name.startsWith(other)) ? "hand_edited" : "reverted")
        await session.close()
      }
      // Whatever each undo did, nobody's file was removed without being asked about.
      expect(readFileSync(join(shared, "README.md"), "utf8")).toBe("# shared\n")
    } finally {
      await harness.close()
    }
  }, 120_000)
})

describe("a session and the process that holds it", () => {
  test("held by a live process it is refused; once that process is killed, the next one recovers it and carries on", async () => {
    const { data, workspace } = place()
    const holder = spawn("hang", data, workspace("a"))
    const id = await holder.started()
    const refused = await run<{ ok: boolean; code: string; holderPid: number; message: string }>("open", data, id)
    expect(refused).toMatchObject({ ok: false, code: "session_in_use", holderPid: holder.child.pid })
    expect(refused.message).toBe(`session ${id} is in use by another windlass process (pid ${holder.child.pid}): wait for it to finish or stop it (kill ${holder.child.pid}), or start a new session`)

    holder.child.kill("SIGKILL")
    await holder.child.exited
    // The lock died with the process. What it left is a running claim and a started command: a crash.
    const recovered = await run<{ ok: boolean; recovered: string[]; execution: unknown }>("open", data, id)
    expect(recovered.ok).toBe(true)
    // Recovery settles the orphaned call, closes the step as crashed, tells the model, and resumes; then the model answers.
    expect(recovered.recovered.slice(0, 4)).toEqual(["tool.settled", "step.failed", "synthetic.appended", "execution.resumed"])
    expect(recovered.recovered.at(-1)).toBe("execution.succeeded")
    expect(recovered.execution).toBeNull()
    const directory = openSessionDirectory({ dataDir: data, notice: () => {} })
    const store = directory.open(id)
    const projection = expectRebuildEqualsLive(store, id)
    const crashed = projection.messages.find((message) => message.kind === "assistant" && message.status === "failed")
    expect(crashed).toMatchObject({ error: { kind: "crashed" } })
    store.close()
    directory.close()
  }, 120_000)
})

describe("snapshots of one workspace from several processes", () => {
  test("taken and pruned at once, no process loses a snapshot it kept or removes another's", async () => {
    const { root, workspace } = place()
    const shared = workspace("shared")
    const snapshotDir = join(root, "snapshots")
    const sessions = ["ses_one", "ses_two", "ses_three", "ses_four"]
    const results = await Promise.all(sessions.map((session) => run<{ session: string; taken: string[]; kept: string[] }>("snapshots", snapshotDir, shared, session, "12")))

    const snapshots = await openSnapshots(shared, { dataDir: snapshotDir })
    if (snapshots.kind !== "ready") throw new Error("no snapshots")
    for (const result of results) {
      expect(result.taken).toHaveLength(12)
      // What the process kept is what its session has now: nothing another process pruned touched it.
      const refs = (await snapshots.list({ session: result.session })).map((ref) => ref.id as string)
      expect(refs).toEqual(result.kept)
      expect(refs.length).toBeGreaterThanOrEqual(1)
      expect(refs.length).toBeLessThanOrEqual(4)
      // The newest snapshot of each session is always kept, and every kept one is a whole tree: it can be compared and restored from.
      expect(refs[0]).toBe(result.taken.at(-1)!)
      for (const id of refs) expect(await snapshots.changedFiles(id as never, refs[0] as never)).toBeInstanceOf(Array)
    }
    // All sixteen-odd refs are in one repository, and it is sound.
    const all = await snapshots.list()
    expect(new Set(all.map((ref) => ref.session))).toEqual(new Set(sessions))
    const dry = await snapshots.restore(results[0]!.kept[0] as never, { session: "ses_check", dryRun: true })
    expect(dry.kind).toBe("dry_run")
    // Each file a process wrote is in the workspace as its last write left it.
    for (const session of sessions) expect(readFileSync(join(shared, `${session}.txt`), "utf8")).toBe(`${session} 11\n`)
  }, 180_000)
})
