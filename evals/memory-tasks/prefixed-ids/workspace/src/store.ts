import type { Attachment } from "./attachments.ts"
import type { Comment } from "./comments.ts"
import type { Thread } from "./threads.ts"

/** The in-memory store the handlers share; production swaps in the database-backed one with the same shape. */
export interface Store {
  readonly threads: Map<string, Thread>
  readonly comments: Map<string, Comment>
  readonly attachments: Map<string, Attachment>
}

export function createStore(): Store {
  return { threads: new Map(), comments: new Map(), attachments: new Map() }
}
