/** Several real processes on one store: exactly one delivery when they compete, and a holder killed mid-fire. */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { openWakeStore } from "../../src/wake/store.ts"
import { cleanup, onCleanup, tempDir, until } from "./helpers.ts"

afterEach(cleanup)

const WORKER = join(import.meta.dir, "fixtures", "worker.ts")

function layout() {
  const base = tempDir()
  return { dir: join(base, "wake"), inboxPath: join(base, "inbox.db"), go: join(base, "go"), base }
}

function worker(paths: ReturnType<typeof layout>, mode: string) {
  const child = Bun.spawn([process.execPath, WORKER, paths.dir, paths.inboxPath, mode, paths.go], { stdout: "pipe", stderr: "pipe" })
  onCleanup(() => {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  })
  return {
    child,
    summary: async () => {
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const code = await child.exited
      return { code, signal: child.signalCode, out, err }
    },
  }
}

function inboxRows(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    return {
      attempts: db.query<{ key: string; pid: number }, []>("SELECT key, pid FROM attempt ORDER BY rowid").all(),
      admitted: db.query<{ key: string; pid: number }, []>("SELECT key, pid FROM admitted ORDER BY key").all(),
    }
  } finally {
    db.close()
  }
}

describe("competing processes", () => {
  test("three processes, five wake-ups due at once: each is delivered by exactly one, in exactly one attempt", async () => {
    const paths = layout()
    const store = openWakeStore({ dir: paths.dir })
    const ids = Array.from({ length: 5 }, (_, index) => {
      const created = store.create({ sessionId: `ses_${index % 2}`, message: `wake ${index}`, author: "user", trigger: { kind: "after", delayMs: 1500 } })
      if (!created.ok) throw new Error(created.error)
      return created.wake.id
    })
    store.close()
    const workers = [worker(paths, "run"), worker(paths, "run"), worker(paths, "run")]
    // Let them all open the store, then start together.
    await Bun.sleep(300)
    writeFileSync(paths.go, "")
    const summaries = await Promise.all(workers.map((one) => one.summary()))
    for (const summary of summaries) expect(summary).toMatchObject({ code: 0, err: "" })
    const rows = inboxRows(paths.inboxPath)
    expect(rows.admitted.map((row) => row.key).sort()).toEqual(ids.map((id) => `msg_${id}_1`).sort())
    expect(rows.attempts).toHaveLength(5)
    const reopened = openWakeStore({ dir: paths.dir })
    onCleanup(() => reopened.close())
    expect(reopened.list({ includeEnded: true }).map((wake) => wake.state.kind)).toEqual(["completed", "completed", "completed", "completed", "completed"])
  }, 60_000)
})

describe("a holder that dies", () => {
  test("killed after the engine admitted the message but before it was marked delivered: delivered again with the same key, admitted once", async () => {
    const paths = layout()
    const store = openWakeStore({ dir: paths.dir })
    const created = store.create({ sessionId: "ses_1", message: "once", author: "user", trigger: { kind: "after", delayMs: 1000 } })
    if (!created.ok) throw new Error(created.error)
    writeFileSync(paths.go, "")
    const first = await worker(paths, "die-after-admit").summary()
    expect(first.signal).toBe("SIGKILL")
    // The firing is recorded and still open.
    expect(store.firings(created.wake.id)).toMatchObject([{ n: 1, deliveredAt: null }])
    const second = await worker(paths, "run").summary()
    expect(second.code).toBe(0)
    expect(JSON.parse(second.out).results).toEqual([`msg_${created.wake.id}_1:duplicate`])
    const rows = inboxRows(paths.inboxPath)
    expect(rows.admitted).toHaveLength(1)
    expect(rows.attempts.map((row) => row.key)).toEqual([`msg_${created.wake.id}_1`, `msg_${created.wake.id}_1`])
    expect(store.firings(created.wake.id)[0]!.deliveredAt).not.toBeNull()
    store.close()
  }, 60_000)

  test("killed before the engine admitted it: the next process admits it, once", async () => {
    const paths = layout()
    const store = openWakeStore({ dir: paths.dir })
    const created = store.create({ sessionId: "ses_1", message: "once", author: "user", trigger: { kind: "after", delayMs: 1000 } })
    if (!created.ok) throw new Error(created.error)
    writeFileSync(paths.go, "")
    expect((await worker(paths, "die-before-admit").summary()).signal).toBe("SIGKILL")
    const second = await worker(paths, "run").summary()
    expect(JSON.parse(second.out).results).toEqual([`msg_${created.wake.id}_1:admitted`])
    expect(inboxRows(paths.inboxPath).admitted).toHaveLength(1)
    store.close()
  }, 60_000)

  test("killed while its check runs: the check's processes die with it, and another process takes the lease at once", async () => {
    const paths = layout()
    const workspace = tempDir()
    const store = openWakeStore({ dir: paths.dir })
    // The first run records its PID and hangs; once `marker` exists the check passes.
    const command = `if [ -f marker ]; then echo passed; exit 0; fi; echo $$ > check.pid; exec sleep 120`
    const created = store.create({ sessionId: "ses_1", message: "done", author: "user", trigger: { kind: "check", command, intervalMs: 15_000, fire: "until", timeoutMs: 300_000 }, run: { kind: "unsandboxed" }, cwd: workspace })
    if (!created.ok) throw new Error(created.error)
    writeFileSync(paths.go, "")
    const first = worker(paths, "run")
    await until(() => existsSync(join(workspace, "check.pid")), 20_000, "the check to start")
    const pid = Number(readFileSync(join(workspace, "check.pid"), "utf8"))
    first.child.kill("SIGKILL")
    await first.summary()
    // The guard kills the check's process group when its owner dies.
    await until(() => !alive(pid), 10_000, "the check's process to be killed")
    expect(store.get(created.wake.id)!.lastRun).toBeNull()
    writeFileSync(join(workspace, "marker"), "")
    const started = performance.now()
    const second = await worker(paths, "run").summary()
    // Without waiting for the two-minute lease to lapse.
    expect(performance.now() - started).toBeLessThan(30_000)
    expect(JSON.parse(second.out).results).toEqual([`msg_${created.wake.id}_1:admitted`])
    expect(store.get(created.wake.id)!.state.kind).toBe("completed")
    store.close()
  }, 90_000)
})

describe("owners", () => {
  test("an owner is alive while its process holds it, and dead once it closed or its process died", () => {
    const paths = layout()
    const store = openWakeStore({ dir: paths.dir })
    onCleanup(() => store.close())
    const owner = store.owner()
    expect(store.ownerAlive(owner.id)).toBe(true)
    const other = openWakeStore({ dir: paths.dir })
    onCleanup(() => other.close())
    // Another store in this process asks the operating system, which says the lock is held.
    expect(other.ownerAlive(owner.id)).toBe(true)
    owner.close()
    expect(other.ownerAlive(owner.id)).toBe(false)
    expect(store.ownerAlive("own_0123456789abcdef")).toBe(false)
  })
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
