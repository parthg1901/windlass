/**
 * Copies a task's workspace to a fresh temporary directory, runs its setup, optionally applies the reference
 * solution, and grades it. An agent runner reuses `prepareWorkspace` and `grade`; this file only adds the CLI.
 *
 *   bun evals/run-check.ts <task-id> [--solve] [--keep]
 */
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { IGNORED_DIRS, STORED_SUFFIX, lastLine, run } from "./grader.ts"

export const TASKS_DIR = join(import.meta.dir, "tasks")

export interface Task {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly tags: readonly string[]
  readonly timeoutSeconds: number
  readonly maxSteps: number
  /** A command (argv) run in the copied workspace before the agent starts, e.g. to generate a large file. */
  readonly setup?: readonly string[]
}

export interface GradeResult {
  readonly pass: boolean
  readonly message: string
}

export async function listTasks() {
  const entries = await readdir(TASKS_DIR, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

export async function loadTask(id: string): Promise<Task> {
  const value: unknown = await Bun.file(join(TASKS_DIR, id, "task.json")).json()
  if (!isTask(value)) throw new Error(`tasks/${id}/task.json does not match the task shape`)
  if (value.id !== id) throw new Error(`tasks/${id}/task.json has id ${value.id}`)
  return value
}

/** Copies `workspace/` (renaming stored `*.in` files) into a new temporary directory. */
export async function copyWorkspace(id: string, dest?: string) {
  const target = dest ?? (await mkdtemp(join(tmpdir(), `lh-eval-${id}-`)))
  const source = join(TASKS_DIR, id, "workspace")
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(source, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await mkdir(join(target, path), { recursive: true })
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const name = path.endsWith(STORED_SUFFIX) ? path.slice(0, -STORED_SUFFIX.length) : path
      await mkdir(dirname(join(target, name)), { recursive: true })
      await Bun.write(join(target, name), Bun.file(join(source, path)))
    }
  }
  await walk("")
  return target
}

export async function runSetup(task: Task, dir: string) {
  if (!task.setup) return
  const result = await run([...task.setup], dir, 120)
  if (result.code !== 0) throw new Error(`setup for ${task.id} failed: ${lastLine(result.output)}`)
}

/** A copied workspace with setup done, ready for an agent (or the reference solution). */
export async function prepareWorkspace(id: string, dest?: string) {
  const task = await loadTask(id)
  const dir = await copyWorkspace(id, dest)
  await runSetup(task, dir)
  return { task, dir }
}

/** Applies `solve.ts <dir>` if the task has one, otherwise `solution.patch` with `patch -p1`. */
export async function applySolution(id: string, dir: string) {
  const taskDir = join(TASKS_DIR, id)
  const result = (await Bun.file(join(taskDir, "solve.ts")).exists())
    ? await run(["bun", join(taskDir, "solve.ts"), dir], dir, 120)
    : await run(["patch", "-p1", "-i", join(taskDir, "solution.patch")], dir, 60)
  if (result.code !== 0) throw new Error(`reference solution for ${id} failed: ${lastLine(result.output)}`)
}

export async function grade(id: string, dir: string): Promise<GradeResult> {
  const task = await loadTask(id)
  const result = await run(["bun", join(TASKS_DIR, id, "check.ts"), dir], dir, Math.max(60, task.timeoutSeconds))
  return { pass: result.code === 0, message: lastLine(result.output) }
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false
  const task = value as Record<string, unknown>
  const strings = ["id", "title", "prompt"].every((key) => typeof task[key] === "string" && task[key] !== "")
  const numbers = ["timeoutSeconds", "maxSteps"].every((key) => Number.isInteger(task[key]) && (task[key] as number) > 0)
  const tags = Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string")
  const setup = task.setup === undefined || (Array.isArray(task.setup) && task.setup.length > 0 && task.setup.every((arg) => typeof arg === "string"))
  return strings && numbers && tags && setup
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const id = args.find((arg) => !arg.startsWith("--"))
  if (!id) {
    console.log(`usage: bun evals/run-check.ts <task-id> [--solve] [--keep]\ntasks: ${(await listTasks()).join(", ")}`)
    process.exit(2)
  }
  const { dir } = await prepareWorkspace(id)
  if (args.includes("--solve")) await applySolution(id, dir)
  const result = await grade(id, dir)
  console.log(`${result.pass ? "PASS" : "FAIL"} ${id}: ${result.message}`)
  if (args.includes("--keep")) console.log(`workspace kept at ${dir}`)
  else await rm(dir, { recursive: true, force: true })
  process.exit(result.pass ? 0 : 1)
}
