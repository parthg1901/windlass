import { today } from "./clock.ts"
import { formatTask } from "./format.ts"
import { type Task, load, nextId, save } from "./store.ts"

export interface Output {
  code: number
  stdout: string[]
  stderr: string[]
}

export class UsageError extends Error {}

export async function add(path: string, args: readonly string[], out: Output): Promise<void> {
  const title = args.join(" ").trim()
  if (title === "") throw new UsageError('add needs a title: tasks add "Buy milk"')
  const tasks = await load(path)
  const task: Task = { id: nextId(tasks), title, done: false }
  await save(path, [...tasks, task])
  out.stdout.push(`added ${task.id}`)
}

export async function list(path: string, _args: readonly string[], out: Output): Promise<void> {
  const tasks = await load(path)
  if (tasks.length === 0) out.stdout.push("nothing to do")
  for (const task of tasks) out.stdout.push(formatTask(task))
}

export async function done(path: string, args: readonly string[], out: Output, env: Record<string, string | undefined>): Promise<void> {
  const id = Number(args[0])
  const tasks = await load(path)
  const task = tasks.find((candidate) => candidate.id === id)
  if (!task) throw new UsageError(`no task ${args[0] ?? ""}`)
  await save(
    path,
    tasks.map((candidate) => (candidate.id === id ? { ...candidate, done: true, completedAt: today(env) } : candidate)),
  )
  out.stdout.push(`done ${id}`)
}
