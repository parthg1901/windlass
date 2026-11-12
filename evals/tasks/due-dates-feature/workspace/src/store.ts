export interface Task {
  readonly id: number
  readonly title: string
  readonly done: boolean
  readonly completedAt?: string
}

export interface TaskFile {
  readonly version: 1
  readonly tasks: readonly Task[]
}

export function storePath(env: Record<string, string | undefined> = process.env): string {
  return env.TASKS_FILE ?? ".tasks.json"
}

export async function load(path: string): Promise<Task[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const data = (await file.json()) as TaskFile
  return [...data.tasks]
}

export async function save(path: string, tasks: readonly Task[]): Promise<void> {
  const data: TaskFile = { version: 1, tasks }
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`)
}

export function nextId(tasks: readonly Task[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1
}
