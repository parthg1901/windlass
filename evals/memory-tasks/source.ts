/**
 * The memory A/B task set: tasks where a convention stated in an earlier session matters, kept apart from
 * `evals/tasks/` so they never mix into the general baseline. Each task has the same layout as a general task
 * (`task.json`, `workspace/`, `check.ts`, `solve.ts`) plus `memory/`, the notes a person or an earlier session
 * would have left, in the file format of `packages/core/src/memory/README.md`.
 *
 * `evals/run-agent.ts --memory with|without` reads its tasks from here and arranges each run (`arrangeMemorySide`):
 *
 * - `with`: a throwaway user configuration directory (`XDG_CONFIG_HOME`) whose `config.json` turns memory on, and
 *   the task's notes written where a user's project notes live by default: the agent's data directory, under
 *   `memory/projects/<key of the workspace's project>/`, outside the workspace. The model is given them by delivery
 *   and the memory tools only: no file listing, `git status` or grader sees them. They are re-dated on the way
 *   (`redateNote`) and removed after the run (`cleanup`).
 * - `without`: the same kind of throwaway configuration with memory off, and no notes.
 *
 * Both sides get a configuration directory of their own, so a user file on the machine changes neither.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"
import { findConfigFiles } from "../../packages/core/src/config/load.ts"
import { defaultDataDir, memoryPaths } from "../../packages/core/src/memory/store.ts"
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
 * The notes in `memory/` are written as if today were this day. Seeding moves every date in a note's header by the
 * time since then, so a note stays as old relative to the run as it was written (a note "from three weeks ago" is
 * three weeks old whenever the comparison runs) and never lapses because the set was run late.
 */
export const NOTES_WRITTEN_AS_OF = "2026-11-12T12:00:00Z"

/** A note's text with `created`, `confirmed` and a dated `expires` moved from `NOTES_WRITTEN_AS_OF` to `now`. */
export function redateNote(text: string, now: Date): string {
  const shift = now.getTime() - Date.parse(NOTES_WRITTEN_AS_OF)
  const header = /^---\n[\s\S]*?\n---\n/.exec(text)
  if (header === null) throw new Error("a note must start with a --- header")
  const moved = header[0].replace(/^(created|confirmed|expires): (\S+)$/gm, (line, key: string, value: string) => {
    if (key === "expires" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return line
    const time = Date.parse(value)
    if (Number.isNaN(time)) throw new Error(`a note's ${key} is not a date: ${value}`)
    const iso = new Date(time + shift).toISOString()
    return `${key}: ${key === "expires" ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, "Z")}`
  })
  return moved + text.slice(header[0].length)
}

export interface ArrangedSide {
  /** What the agent process needs in its environment. */
  readonly env: Record<string, string>
  /** Where the notes were seeded (`with`), or `null`. */
  readonly notesDir: string | null
  /** Removes the seeded notes, and any the session saved beside them. */
  readonly cleanup: () => Promise<void>
}

/**
 * Arranges one run of a memory task: writes a user configuration under `configRoot` with memory on (`with`) or off
 * (`without`) and, on the `with` side, seeds the task's notes as project notes of the prepared workspace in the data
 * directory the agent will use (`agentEnv`'s `XDG_DATA_HOME`, or the default). Call it after setup, which may make
 * the workspace a repository and so decide which directory is the project.
 *
 * Refused, rather than mixed in: user notes already in that data directory (they would be delivered too, and differ
 * from one machine to the next), and a project notes directory that already exists (the runner removes only what it
 * wrote).
 */
export async function arrangeMemorySide(side: MemorySide, id: string, workspace: string, configRoot: string, agentEnv: Readonly<Record<string, string | undefined>> = process.env, now = new Date()): Promise<ArrangedSide> {
  const memory = { enabled: side === "with" }
  await Bun.write(join(configRoot, brand.directory, "config.json"), `${JSON.stringify({ memory }, null, 2)}\n`)
  const env = { XDG_CONFIG_HOME: configRoot }
  if (side === "without") return { env, notesDir: null, cleanup: async () => {} }
  const notes = await notesOf(id)
  if (notes.length === 0) throw new Error(`memory-tasks/${id}/memory/ has no notes to seed`)
  const { projectDir } = await findConfigFiles({ cwd: workspace, env: { ...agentEnv, ...env } })
  const paths = memoryPaths({ dataDir: defaultDataDir(agentEnv), projectDir })
  const userNotes = (await readdir(paths.user).catch(() => [] as string[])).filter((name) => name.endsWith(".md"))
  if (userNotes.length > 0) throw new Error(`${paths.user} holds ${userNotes.length} user note(s), which would be delivered to the run too; use a data directory without user notes`)
  const target = paths.project!
  if (await stat(target).then(() => true, () => false)) throw new Error(`${target} already exists; the runner seeds only a directory it creates`)
  const cleanup = () => rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  try {
    for (const note of notes) await Bun.write(join(target, note.split("/").at(-1)!), redateNote(await Bun.file(note).text(), now))
  } catch (error) {
    await cleanup()
    throw error
  }
  return { env, notesDir: target, cleanup }
}
