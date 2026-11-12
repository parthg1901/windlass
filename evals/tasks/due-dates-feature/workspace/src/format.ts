import type { Task } from "./store.ts"

/** `[ ] 3 Pay rent` or `[x] 3 Pay rent` */
export function formatTask(task: Task): string {
  return `[${task.done ? "x" : " "}] ${task.id} ${task.title}`
}
