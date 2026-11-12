import type { Store } from "./store.ts"

export interface Attachment {
  readonly id: string
  readonly commentId: string
  readonly fileName: string
  readonly bytes: number
}

export function attach(store: Store, commentId: string, fileName: string, bytes: number): Attachment {
  if (!store.comments.has(commentId)) throw new Error(`no comment ${commentId}`)
  const attachment = { id: crypto.randomUUID(), commentId, fileName, bytes }
  store.attachments.set(attachment.id, attachment)
  return attachment
}
