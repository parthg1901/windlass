import { newId } from "./ids.ts"
import type { Store } from "./store.ts"

export interface Poll {
  readonly id: string
  readonly threadId: string
  readonly question: string
  readonly options: readonly string[]
  readonly votes: Map<string, number>
}

export function createPoll(store: Store, threadId: string, question: string, options: readonly string[]): Poll {
  if (!store.threads.has(threadId)) throw new Error(`no thread ${threadId}`)
  if (options.length < 2) throw new Error("a poll needs at least two options")
  const poll = { id: newId("pol"), threadId, question: question.trim(), options: [...options], votes: new Map<string, number>() }
  store.polls.set(poll.id, poll)
  return poll
}

/** One vote per user; voting again moves the vote. */
export function vote(store: Store, pollId: string, userId: string, option: number): void {
  const poll = store.polls.get(pollId)
  if (!poll) throw new Error(`no poll ${pollId}`)
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) throw new Error(`no option ${option}`)
  poll.votes.set(userId, option)
}
