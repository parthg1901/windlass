import type { Attachment } from "./attachments.ts"
import type { Comment } from "./comments.ts"
import type { Mention } from "./mentions.ts"
import type { Poll } from "./polls.ts"
import type { Thread } from "./threads.ts"

/** The in-memory store the handlers share; production swaps in the database-backed one with the same shape. */
export interface Store {
  readonly threads: Map<string, Thread>
  readonly comments: Map<string, Comment>
  readonly attachments: Map<string, Attachment>
  readonly mentions: Map<string, Mention>
  readonly polls: Map<string, Poll>
}

export function createStore(): Store {
  return { threads: new Map(), comments: new Map(), attachments: new Map(), mentions: new Map(), polls: new Map() }
}
