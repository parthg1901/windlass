// Every grader must reject the untouched workspace and accept the reference solution.
import { afterAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { applySolution, grade, listTasks, loadTask, prepareWorkspace } from "./run-check.ts"

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
