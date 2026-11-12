/**
 * Known defect 4: a fork whose parent's database file is gone cannot run.
 *
 * The contract (docs/architecture.md, "Forks"): the inherited messages,
 * baseline and compaction are copied into the fork's own rows, "so a fork
 * whose parent file is later missing still opens, runs and is listed;
 * reading its inherited events then fails with `parent_missing`".
 *
 * Observed: fork with a workspace copy, move the parent's database files
 * away, send the fork a prompt: "The configuration could not be loaded: the
 * history inherited from session … cannot be read".
 *
 * The chain (approval layer on, as in the real harness): `engine.ts`
 * `LiveSession.drain` → `configure` → (inside its `try`) `announcePolicy` →
 * `noticeTaint` → `taint` → `this.store.readEvents(this.id)` with no range:
 * the effective log from seq 1, inherited events included, which the store
 * reads through `parentLog` (`store/directory.ts`) and which throws
 * `StoreError("parent_missing")`. `configure`'s `catch` takes every error
 * as a configuration problem and writes `execution.failed` with
 * `FAILURE_TEXT.config(...)` (with no configuration loader `announcePolicy`
 * runs outside that `try`, and `abandon` writes "The harness failed: …").
 * Without the approval layer the fork runs, which
 * is why `test/engine/fork.test.ts` (approval off) never saw it.
 *
 * The taint fold is the one reader that really needs the inherited events
 * (an inherited tool result can be a source). Smallest fix: in `taint`, on
 * `parent_missing`, fold the fork's own events (after `throughSeq`) and take
 * the inherited `session.approval.taint` (the noticed taint the reducer
 * copies into the fork) as a source at `throughSeq`; better, copy what the
 * fold needs (its entries) into the fork when it is made, as the messages
 * are. Could affect: a fork of a tainted parent whose taint was never
 * noticed (taint `off` then) is judged clean after its parent is gone.
 * Separately, `configure`'s `catch` should not label a store error as a
 * configuration problem. Other whole-log readers that a fork can reach:
 * `admitted` (a wake-up admitted into a fork), `revertTo`/`undoLatestRevert`
 * (`snapshotsSinceDelivery(this.store.readEvents(this.id))`).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { basename, join } from "node:path"
import { resolveConfig } from "../../src/config/schema.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { SETTINGS, call, closeHarnesses, place, removePlaces, say, start } from "../engine/assembly-helpers.ts"

afterEach(closeHarnesses)
afterAll(removePlaces)

/** Moves a session's database (and its write-ahead log) out of the data directory, as a user who cleans up would. */
function moveAway(path: string, to: string) {
  mkdirSync(to, { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, join(to, `${basename(path)}${suffix}`))
}

/** The configuration as the real harness reads it, with nothing in the files. */
const emptyConfig = async (cwd: string) => ({ config: resolveConfig({}), projectDir: cwd, files: { user: null, project: null } })

async function forkWithoutParent(approval: boolean, config = true) {
  const { data, workspace, root } = place("lh-defect-4-")
  const options = { ...(approval ? { approval: { user: { mode: "auto" as const } } } : {}), ...(config ? { loadConfig: emptyConfig } : {}) }
  const { harness } = start(data, [[call("read", { path: "notes.md" })], say("It is a notes file."), say("Still here, in the fork.")], { engine: options })
  const engine = harness.engine
  const parent = engine.createSession({ cwd: workspace("w"), settings: SETTINGS, title: "Notes" })
  parent.send("What is notes.md?")
  await parent.settled()
  const parentId = parent.id
  const fork = await engine.forkSession(parentId, { workspace: { copyTo: join(root, "copy") } })
  await parent.close()
  moveAway(harness.sessions.pathOf(parentId as SessionId), join(root, "moved"))
  fork.send("Are you still there?")
  await fork.settled()
  return { engine, fork, parentId, log: fork.readEvents({ afterSeq: fork.projection().session.lineage?.kind === "fork" ? (fork.projection().session.lineage as { throughSeq: number }).throughSeq : 0 }) }
}

describe("known defect 4: a fork whose parent's file is gone cannot run", () => {
  test.failing("with the approval layer on (the real harness): the fork answers, and is still listed", async () => {
    const { engine, fork, log } = await forkWithoutParent(true)
    const ended = log.filter((item) => item.type === "execution.failed" || item.type === "execution.succeeded") as StoredEvent[]
    // The defect: execution.failed, "The configuration could not be loaded: the history inherited from session … cannot be read".
    expect(ended.map((item) => item.type)).toEqual(["execution.succeeded"])
    expect(log.some((item) => item.type === "text.ended" && item.data.text === "Still here, in the fork.")).toBe(true)
    expect(engine.listSessions().map((summary) => summary.session.id)).toContain(fork.id)
  })

  // Holds today: with the approval layer off nothing reads the parent at run time, which is what the contract describes.
  test("with the approval layer off the same fork runs", async () => {
    const { log } = await forkWithoutParent(false)
    expect(log.filter((item) => item.type === "execution.failed")).toEqual([])
    expect(log.at(-1)?.type).toBe("execution.succeeded")
  })

  // What the user sees today, for the record: with a configuration loader (the real harness) the store error is
  // reported as a configuration problem; without one `announcePolicy` runs outside that `try` and `abandon` reports it.
  test("today: the failure names the configuration, and the cause is the inherited history", async () => {
    const message = (log: readonly StoredEvent[]) => (log.find((item) => item.type === "execution.failed") as StoredEvent<"execution.failed"> | undefined)?.data.message
    expect(message((await forkWithoutParent(true)).log)).toMatch(/^The configuration could not be loaded: the history inherited from session \S+ cannot be read/)
    expect(message((await forkWithoutParent(true, false)).log)).toMatch(/^The harness failed: the history inherited from session \S+ cannot be read/)
  })
})
