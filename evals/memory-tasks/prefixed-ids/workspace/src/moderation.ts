import type { Store } from "./store.ts"

const BLOCKED = ["spam-link.example", "buy followers"]

/** Hides a comment that matches the block list; returns whether it was hidden. */
export function moderate(store: Store, commentId: string): boolean {
  const comment = store.comments.get(commentId)
  if (!comment) throw new Error(`no comment ${commentId}`)
  const hit = BLOCKED.some((phrase) => comment.body.toLowerCase().includes(phrase))
  if (hit) store.comments.delete(commentId)
  return hit
}
