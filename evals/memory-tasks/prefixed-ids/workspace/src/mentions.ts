import type { Store } from "./store.ts"

export interface Mention {
  readonly id: string
  readonly commentId: string
  readonly userId: string
}

/** Records that a comment mentions a user, once per user and comment. */
export function mention(store: Store, commentId: string, userId: string): Mention {
  if (!store.comments.has(commentId)) throw new Error(`no comment ${commentId}`)
  const existing = [...store.mentions.values()].find((item) => item.commentId === commentId && item.userId === userId)
  if (existing) return existing
  const item = { id: crypto.randomUUID(), commentId, userId }
  store.mentions.set(item.id, item)
  return item
}

export function mentionsIn(store: Store, commentId: string): Mention[] {
  return [...store.mentions.values()].filter((item) => item.commentId === commentId)
}
