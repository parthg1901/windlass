/**
 * The memory A/B task set: tasks where a convention stated in an earlier session matters, kept apart from
 * `evals/tasks/` so they never mix into the general baseline. Each task has the same layout as a general task
 * (`task.json`, `workspace/`, `check.ts`, `solve.ts`) plus `memory/`, the notes a person or an earlier session
 * would have left, in the file format of `packages/core/src/memory/README.md`.
 *
 * `evals/run-agent.ts --memory with|without` reads its tasks from here and arranges each run (`arrangeMemorySide`):
 *
 * - `with`: a throwaway user configuration directory (`XDG_CONFIG_HOME`) whose `config.json` turns memory on with
 *   `inRepository`, and the task's notes copied into the workspace's `.<brand.directory>/memory/` after setup, so
 *   the session is given them as project notes. The sign-in and the session files stay in the data directory.
 * - `without`: the same kind of throwaway configuration with memory off, and no notes.
 *
 * Both sides get a configuration directory of their own, so a user file on the machine changes neither.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"
import { lastLine, run } from "../grader.ts"
import { type GradeResult, type Task, copyWorkspace } from "../run-check.ts"

export const MEMORY_TASKS_DIR = import.meta.dir
export type MemorySide = "with" | "without"

/** Where a task's tasks live and how each is loaded, prepared, solved and graded. */
export interface TaskSource {
  readonly dir: string
  readonly list: () => Promise<string[]>
  readonly load: (id: string) => Promise<Task>
  /** Copies the workspace into `dest` and runs the task's setup. */
  readonly prepare: (id: string, dest: string) => Promise<unknown>
  readonly solve: (id: string, dir: string) => Promise<void>
  readonly grade: (id: string, dir: string) => Promise<GradeResult>
}

export const memoryTaskSource: TaskSource = {
  dir: MEMORY_TASKS_DIR,
  list: async () => {
    const entries = await readdir(MEMORY_TASKS_DIR, { withFileTypes: true })
    const ids = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ((await Bun.file(join(MEMORY_TASKS_DIR, entry.name, "task.json")).exists()) ? entry.name : null)))
    return ids.filter((id) => id !== null).sort()
  },
  load: loadMemoryTask,
  prepare: async (id, dest) => {
    const task = await loadMemoryTask(id)
    await copyFrom(id, dest)
    if (task.setup) {
      const result = await run([...task.setup], dest, 120)
      if (result.code !== 0) throw new Error(`setup for ${id} failed: ${lastLine(result.output)}`)
    }
  },
  solve: async (id, dir) => {
    const result = await run(["bun", join(MEMORY_TASKS_DIR, id, "solve.ts"), dir], dir, 120)
    if (result.code !== 0) throw new Error(`reference solution for ${id} failed: ${lastLine(result.output)}`)
  },
  grade: async (id, dir) => {
    const task = await loadMemoryTask(id)
    const result = await run(["bun", join(MEMORY_TASKS_DIR, id, "check.ts"), dir], dir, Math.max(60, task.timeoutSeconds))
    return { pass: result.code === 0, message: lastLine(result.output) }
  },
}

async function loadMemoryTask(id: string): Promise<Task> {
  const value = (await Bun.file(join(MEMORY_TASKS_DIR, id, "task.json")).json()) as Record<string, unknown>
  const ok =
    value.id === id &&
    typeof value.title === "string" &&
    typeof value.prompt === "string" &&
    value.prompts === undefined &&
    Array.isArray(value.tags) &&
    Number.isInteger(value.timeoutSeconds) &&
    Number.isInteger(value.maxSteps) &&
    (value.setup === undefined || (Array.isArray(value.setup) && value.setup.every((arg) => typeof arg === "string")))
  if (!ok) throw new Error(`memory-tasks/${id}/task.json does not match the task shape (one prompt; id equal to the directory)`)
  return { ...(value as unknown as Task), prompts: [value.prompt as string] }
}

/** `copyWorkspace` reads from evals/tasks/; the same copy, from here (stored `*.in` files renamed). */
async function copyFrom(id: string, dest: string) {
  // copyWorkspace(id, dest) joins TASKS_DIR with id; a relative id reaches this directory without duplicating it.
  await copyWorkspace(join("..", "memory-tasks", id), dest)
}

/** The notes a task seeds on the `with` side. */
export async function notesOf(id: string) {
  const dir = join(MEMORY_TASKS_DIR, id, "memory")
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((name) => name.endsWith(".md")).sort().map((name) => join(dir, name))
}

/**
 * Arranges one run of a memory task: writes a user configuration under `configRoot` with memory on (`with`) or off
 * (`without`), seeds the task's notes into the prepared workspace on the `with` side, and returns the environment
 * the agent process needs.
 */
export async function arrangeMemorySide(side: MemorySide, id: string, workspace: string, configRoot: string): Promise<Record<string, string>> {
  const memory = side === "with" ? { enabled: true, inRepository: true } : { enabled: false }
  await Bun.write(join(configRoot, brand.directory, "config.json"), `${JSON.stringify({ memory }, null, 2)}\n`)
  if (side === "with") {
    const notes = await notesOf(id)
    if (notes.length === 0) throw new Error(`memory-tasks/${id}/memory/ has no notes to seed`)
    const target = join(workspace, `.${brand.directory}`, "memory")
    await mkdir(target, { recursive: true })
    for (const note of notes) await copyFile(note, join(target, note.split("/").at(-1)!))
  }
  return { XDG_CONFIG_HOME: configRoot }
}
