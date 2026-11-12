import { newId } from "./ids.ts"
import type { Store } from "./store.ts"

export interface Thread {
  readonly id: string
  readonly title: string
  readonly authorId: string
  readonly createdAt: string
}

export function createThread(store: Store, title: string, authorId: string): Thread {
  const thread = { id: newId("thr"), title: title.trim(), authorId, createdAt: new Date().toISOString() }
  store.threads.set(thread.id, thread)
  return thread
}
