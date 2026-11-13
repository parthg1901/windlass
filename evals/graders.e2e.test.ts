// Every grader must reject the untouched workspace and accept the reference solution.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { parseEntryFile } from "../packages/core/src/memory/entry.ts"
import { activeEntries } from "../packages/core/src/memory/hygiene.ts"
import { memoryPaths, openMemoryStore } from "../packages/core/src/memory/store.ts"
import { arrangeMemorySide, memoryTaskSource, notesOf } from "./memory-tasks/source.ts"
import { TASKS_DIR, applySolution, grade, listTasks, loadTask, prepareWorkspace } from "./run-check.ts"
import { E2E_TIMEOUT_MS } from "../packages/core/src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const ids = await listTasks()
const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

test("there are tasks, and each task.json is valid", async () => {
  expect(ids.length).toBeGreaterThanOrEqual(10)
  for (const id of ids) await loadTask(id)
})

// Sequential on purpose: graders run real commands and this suite shares the machine with other work.
for (const id of ids) {
  describe(id, () => {
    test("the untouched workspace fails", async () => {
      const { dir } = await prepareWorkspace(id)
      dirs.push(dir)
      const result = await grade(id, dir)
      expect(result.message).toStartWith("fail:")
      expect(result.pass).toBe(false)
    }, 300_000)

    test("the reference solution passes", async () => {
      const { dir } = await prepareWorkspace(id)
      dirs.push(dir)
      await applySolution(id, dir)
      const result = await grade(id, dir)
      expect(result.message).toStartWith("ok:")
      expect(result.pass).toBe(true)
    }, 300_000)
  })
}

// The chart the read-chart-image task shows is generated; the committed PNG must be what its generator makes.
test("read-chart-image: the committed chart is what make-chart.ts renders", async () => {
  const { render } = await import("./tasks/read-chart-image/make-chart.ts")
  const committed = new Uint8Array(await Bun.file(join(TASKS_DIR, "read-chart-image/workspace/docs/cpu-last-night.png")).arrayBuffer())
  expect(Buffer.compare(Buffer.from(committed), render())).toBe(0)
})

// The memory A/B tasks (evals/memory-tasks/) are held to the same rules, and their notes must be valid project notes
// that the store finds where the runner's `--memory with` side puts them.
const memoryIds = await memoryTaskSource.list()
test("there are at least eight memory tasks", () => {
  expect(memoryIds.length).toBeGreaterThanOrEqual(8)
})
for (const id of memoryIds) {
  describe(`memory-tasks/${id}`, () => {
    test("the untouched workspace fails and the reference solution passes", async () => {
      const untouched = await mkdtemp(join(tmpdir(), "wl-eval-memory-"))
      const solved = await mkdtemp(join(tmpdir(), "wl-eval-memory-"))
      dirs.push(untouched, solved)
      await memoryTaskSource.prepare(id, untouched)
      await memoryTaskSource.prepare(id, solved)
      await memoryTaskSource.solve(id, solved)
      const before = await memoryTaskSource.grade(id, untouched)
      const after = await memoryTaskSource.grade(id, solved)
      expect([before.pass, before.message.slice(0, 5), after.pass, after.message.slice(0, 3)]).toEqual([false, "fail:", true, "ok:"])
    }, 300_000)

    test("its notes are valid project notes, found by the store once seeded, and in force on the day of the run", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "wl-eval-memory-"))
      const config = await mkdtemp(join(tmpdir(), "wl-eval-memory-config-"))
      dirs.push(workspace, config)
      await memoryTaskSource.prepare(id, workspace)
      const now = new Date()
      const arranged = await arrangeMemorySide("with", id, workspace, config, { XDG_DATA_HOME: join(config, "data") }, now)
      expect(await Bun.file(join(arranged.env.XDG_CONFIG_HOME!, brand.directory, "config.json")).json()).toEqual({ memory: { enabled: true } })
      const notes = await notesOf(id)
      for (const note of notes) expect(parseEntryFile(await Bun.file(note).text(), note).scope).toBe("project")
      const store = openMemoryStore({ paths: memoryPaths({ dataDir: join(config, "data", brand.directory), projectDir: workspace }), now: () => now })
      const loaded = await store.load()
      expect(loaded.problems).toEqual([])
      expect(loaded.entries.length).toBe(notes.length)
      expect(activeEntries(loaded.entries, now).length).toBe(notes.length)
      expect(await Bun.file(join(workspace, `.${brand.directory}`, "memory")).exists()).toBe(false)
      await arranged.cleanup()
    }, 60_000)
  })
}
