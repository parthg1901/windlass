/**
 * A session's turns as a person counts them, read from its stored events:
 * every prompt that set the agent to work is a turn, numbered from 1 in the
 * order they happened, and a turn taken back by `/undo` keeps its number and
 * is marked undone (until `/redo` brings it back). Both front ends show these
 * numbers, and `fork --turn <n>` / `/fork <n>` take them; the event number of
 * the step boundary a turn ends at is the precise form the server's fork takes.
 *
 * A turn starts with an execution (`execution.started`) and ends with its
 * terminal event; a message queued behind it (`turn.ended`, then its
 * delivery) starts the next turn inside the same execution. A steer is part
 * of the turn it was sent into. A turn cut off by a shutdown and resumed
 * (`execution.resumed`) is one turn. An execution that only compacted the
 * conversation because the user asked (`/compact` while idle: no message, no
 * step) is no turn, and is not counted.
 *
 * Pure: it takes events in log order and touches nothing.
 */

/** The fields of a stored event this reads; any `StoredEvent` has them. */
export interface TurnEvent {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

export interface TurnInfo {
  /** 1 for the session's first turn. */
  readonly number: number
  /** The user's message that started it: its text, `""` when the work was not started by a message. */
  prompt: string
  /** The seq of that message's delivery, which is where `/undo` cuts; the turn's start until it is known. */
  messageSeq: number
  /** The seq of the event that ended it; `null` while it runs. */
  endSeq: number | null
  /**
   * The seq a fork that holds this turn and nothing after it is made at; `null` while it runs. The end of its
   * execution is one; a `turn.ended` is not (it opens the handover to the queued message), so for a turn a queued
   * message followed it is the event before, where the engine was at a step boundary.
   */
  forkSeq: number | null
  readonly executionId: string | null
  /** The seqs of the reverts (`history.reverted`) that took it back and were not undone since. */
  readonly undoneBy: Set<number>
}

/** Whether `/undo` has taken the turn back (and no `/redo` brought it back). */
export function isUndone(turn: TurnInfo): boolean {
  return turn.undoneBy.size > 0
}

/**
 * Folds events into turns. Feed it events one at a time (`add`) as they
 * arrive, or all at once (`turnsOf`); both give the same turns.
 */
export class TurnTracker {
  readonly turns: TurnInfo[] = []
  private readonly prompts = new Map<string, string>()
  private current: TurnInfo | null = null
  /** A queued message ended the previous turn: its delivery starts the next one. */
  private queuedNext: string | null = null
  /** Whether the execution in progress has made a model call for a step, and whether the user asked it to compact. */
  private stepped = false
  private compactionAsked = false

  add(event: TurnEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case "inbox.enqueued": {
        if (data.origin !== null) return
        const content = Array.isArray(data.content) ? (data.content as { type?: string; text?: string }[]) : []
        this.prompts.set(String(data.messageId), content.map((part) => (part.type === "text" ? (part.text ?? "") : "[image]")).join(""))
        return
      }
      case "execution.started":
        this.current = this.start(event.seq, typeof data.executionId === "string" ? data.executionId : null)
        this.stepped = false
        this.compactionAsked = false
        return
      case "step.started":
        this.stepped = true
        return
      case "compaction.started":
        if (data.trigger === "manual") this.compactionAsked = true
        return
      case "execution.resumed": {
        // The same turn, taken up again after a shutdown or a crash.
        const last = this.turns.at(-1)
        if (last !== undefined && last.executionId === data.executionId) {
          last.endSeq = null
          last.forkSeq = null
          this.current = last
        } else this.current = this.start(event.seq, typeof data.executionId === "string" ? data.executionId : null)
        return
      }
      case "inbox.delivered": {
        const id = String(data.messageId)
        const text = this.prompts.get(id)
        if (text === undefined) return
        this.prompts.delete(id)
        if (this.queuedNext !== null && this.current === null) {
          // The queued message after a `turn.ended`: a turn of its own in the same execution.
          this.current = this.start(event.seq, this.queuedNext)
          this.queuedNext = null
        }
        const turn = this.current
        if (turn !== null && turn.prompt === "" && turn.messageSeq <= event.seq && !this.delivered.has(turn)) {
          turn.prompt = text
          turn.messageSeq = event.seq
          this.delivered.add(turn)
        }
        return
      }
      case "turn.ended": {
        const turn = this.current
        if (turn !== null) {
          turn.endSeq = event.seq
          // The log's numbers are dense, and the engine writes `turn.ended` only at a boundary: the one before it.
          turn.forkSeq = event.seq - 1
        }
        this.queuedNext = turn?.executionId ?? null
        this.current = null
        return
      }
      case "execution.succeeded":
      case "execution.failed":
      case "execution.interrupted": {
        const turn = this.current
        if (turn !== null) turn.endSeq = turn.forkSeq = event.seq
        // Only a compaction the user asked for: not a turn.
        if (turn !== null && this.compactionAsked && !this.stepped && !this.delivered.has(turn) && this.turns.at(-1) === turn) this.turns.pop()
        this.current = null
        this.queuedNext = null
        this.compactionAsked = false
        return
      }
      case "history.reverted": {
        const from = Number(data.fromSeq)
        for (const turn of this.turns) if (turn.messageSeq >= from && turn.messageSeq < event.seq) turn.undoneBy.add(event.seq)
        return
      }
      case "history.restored": {
        const revert = Number(data.revertSeq)
        for (const turn of this.turns) turn.undoneBy.delete(revert)
        return
      }
      default:
        return
    }
  }

  /** The turns that delivered a message have their prompt; a turn's first delivery is its prompt, later ones are steers. */
  private readonly delivered = new WeakSet<TurnInfo>()

  private start(seq: number, executionId: string | null): TurnInfo {
    const turn: TurnInfo = { number: this.turns.length + 1, prompt: "", messageSeq: seq, endSeq: null, forkSeq: null, executionId, undoneBy: new Set() }
    this.turns.push(turn)
    return turn
  }
}

export function turnsOf(events: Iterable<TurnEvent>): TurnInfo[] {
  const tracker = new TurnTracker()
  for (const item of events) tracker.add(item)
  return tracker.turns
}

/**
 * The event number to fork at so that the fork holds turn `n` and nothing
 * after it, or why there is none: a sentence for the user.
 */
export function forkPointOfTurn(turns: readonly TurnInfo[], n: number): { readonly throughSeq: number } | { readonly problem: string } {
  const turn = turns.find((candidate) => candidate.number === n)
  if (turn === undefined)
    return { problem: turns.length === 0 ? "the session has no turns yet" : `there is no turn ${n}: the session has ${turns.length === 1 ? "1 turn" : `turns 1 to ${turns.length}`}` }
  if (turn.forkSeq === null) return { problem: `turn ${n} has not ended yet` }
  if (isUndone(turn)) return { problem: `turn ${n} was undone (/undo); fork after another turn, or /redo it first` }
  return { throughSeq: turn.forkSeq }
}
