import { newId } from "./ids.ts"
import type { Store } from "./store.ts"

export interface Comment {
  readonly id: string
  readonly threadId: string
  readonly authorId: string
  readonly body: string
  readonly createdAt: string
}

export function addComment(store: Store, threadId: string, authorId: string, body: string): Comment {
  if (!store.threads.has(threadId)) throw new Error(`no thread ${threadId}`)
  if (body.trim() === "") throw new Error("a comment needs a body")
  const comment = { id: newId("cmt"), threadId, authorId, body: body.trim(), createdAt: new Date().toISOString() }
  store.comments.set(comment.id, comment)
  return comment
}

export function commentsIn(store: Store, threadId: string): Comment[] {
  return [...store.comments.values()].filter((comment) => comment.threadId === threadId)
}
