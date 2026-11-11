/**
 * The reducer: previous projection + one durable event -> next projection.
 *
 * SINGLE-OWNER FILE, together with `event/durable.ts`.
 *
 * It is pure and it is the only code that turns events into projected state.
 * The store runs it inside the append transaction, so when it throws
 * `ReduceError` the event is not appended. That makes the reducer the place
 * where the log's invariants are enforced:
 *
 * - `seq` is dense and events belong to the session being folded.
 * - Messages enter history only at a step boundary, and a delivered inbox item
 *   or a new step is always covered by an execution claim.
 * - A tool call follows its state machine and settles exactly once.
 * - A step has exactly one terminal event, and all its calls settle before it.
 * - Revert and refusal ranges never reach back past the latest compaction.
 *
 * Structure is shared: parts of the state an event does not touch are returned
 * as the same objects, so `projectionChanges` can find what to write.
 */
import type { StoredEvent, ToolOutcome } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import { releasesClaim } from "../interrupt.ts"
import {
  type AssistantMessage,
  type Exclusion,
  type Message,
  type MessageKind,
  type Projection,
  type SessionState,
  type ToolCallPart,
  SETTLE_FROM,
} from "./message.ts"

export type ReduceErrorCode =
  /** The event's `seq` is not the next one, or the session does not exist yet or already exists. */
  | "out_of_order"
  /** The event belongs to a different session than the state being folded. */
  | "wrong_session"
  /** A message, inbox item or tool call with this ID already exists. */
  | "duplicate_id"
  /** The event refers to a message, inbox item, tool call or execution that does not exist. */
  | "not_found"
  /** The event is not allowed in the current state (see the message). */
  | "invalid_transition"
  /** A `seq` range in the event is outside what it may cover. */
  | "invalid_range"

/** The event would break an invariant of the log. It must not be appended. */
export class ReduceError extends Error {
  constructor(
    readonly code: ReduceErrorCode,
    detail: string,
    readonly event: StoredEvent,
  ) {
    super(`cannot apply ${event.type} at seq ${event.seq}: ${detail}`)
    this.name = "ReduceError"
  }
}

/**
 * Folds one event into the projection.
 *
 * `state` is `null` only for the `session.created` of a root session. For the
 * `session.created` of a fork, `state` is the parent's projection folded
 * through `lineage.throughSeq`; the fork inherits its messages, baseline and
 * compaction, and starts idle with an empty inbox.
 */
export function reduce(state: Projection | null, event: StoredEvent): Projection {
  if (event.type === "session.created") return create(state, event)
  if (state === null) throw new ReduceError("out_of_order", "the session has not been created", event)
  if (event.sessionId !== state.session.id)
    throw new ReduceError("wrong_session", `the state belongs to session ${state.session.id}`, event)
  if (event.seq !== state.lastSeq + 1)
    throw new ReduceError("out_of_order", `expected seq ${state.lastSeq + 1}`, event)
  return { ...apply(state, event), lastSeq: event.seq, updatedAt: event.time }
}

/** Folds a whole log. `initial` is the parent's projection when the first event creates a fork. */
export function reduceAll(events: Iterable<StoredEvent>, initial: Projection | null = null): Projection | null {
  let state = initial
  for (const event of events) state = reduce(state, event)
  return state
}

function create(state: Projection | null, event: StoredEvent<"session.created">): Projection {
  const session: SessionState = {
    id: event.sessionId,
    cwd: event.data.cwd,
    title: event.data.title,
    lineage: event.data.lineage,
    archived: false,
    createdAt: event.time,
    execution: null,
    open: null,
    compaction: null,
  }
  const lineage = event.data.lineage
  if (lineage === null) {
    if (state !== null) throw new ReduceError("out_of_order", "the session already exists", event)
    if (event.seq !== 1) throw new ReduceError("out_of_order", "a root session starts at seq 1", event)
    return { lastSeq: 1, updatedAt: event.time, session, baseline: null, messages: [], inbox: [] }
  }
  if (state === null || state.session.id !== lineage.parentSessionId || state.lastSeq !== lineage.throughSeq)
    throw new ReduceError(
      "invalid_range",
      `a fork must be folded onto its parent ${lineage.parentSessionId} at seq ${lineage.throughSeq}`,
      event,
    )
  if (event.seq !== lineage.throughSeq + 1)
    throw new ReduceError("out_of_order", `a fork's first event has seq ${lineage.throughSeq + 1}`, event)
  if (state.session.open !== null)
    throw new ReduceError("invalid_transition", "a fork point must be a step boundary", event)
  return {
    lastSeq: event.seq,
    updatedAt: event.time,
    session: { ...session, compaction: state.session.compaction },
    baseline: state.baseline,
    messages: state.messages,
    inbox: [],
  }
}

function apply(state: Projection, event: Exclude<StoredEvent, { type: "session.created" }>): Projection {
  const fail = (code: ReduceErrorCode, detail: string): never => {
    throw new ReduceError(code, detail, event)
  }
  const session = (patch: Partial<SessionState>): Projection => ({ ...state, session: { ...state.session, ...patch } })
  const atBoundary = () => {
    if (state.session.open !== null)
      fail("invalid_transition", `${state.session.open.kind} ${state.session.open.messageId} is still open`)
  }
  const claimed = () => {
    if (state.session.execution?.status !== "running") fail("invalid_transition", "no execution is running")
  }
  const unused = (id: MessageId) => {
    if (state.messages.some((message) => message.id === id) || state.inbox.some((item) => item.messageId === id))
      fail("duplicate_id", `message ${id} already exists`)
  }
  const add = (message: Message): Projection => {
    atBoundary()
    unused(message.id)
    return { ...state, messages: [...state.messages, message] }
  }
  const edit = <K extends MessageKind>(
    id: MessageId,
    kind: K,
    change: (message: Extract<Message, { kind: K }>) => Extract<Message, { kind: K }>,
  ): Projection => {
    const index = state.messages.findLastIndex((message) => message.id === id)
    const found = state.messages[index]
    if (found === undefined) return fail("not_found", `message ${id} does not exist`)
    if (found.kind !== kind) return fail("invalid_transition", `message ${id} is ${found.kind}, not ${kind}`)
    return { ...state, messages: state.messages.with(index, change(found as Extract<Message, { kind: K }>)) }
  }
  /** Edits the assistant message of the open step. */
  const step = (id: MessageId, change: (message: AssistantMessage) => AssistantMessage): Projection => {
    const open = state.session.open
    if (open === null || open.kind !== "step" || open.messageId !== id)
      fail("invalid_transition", `step ${id} is not the open step`)
    return edit(id, "assistant", change)
  }
  const call = (id: MessageId, callId: string, change: (part: ToolCallPart) => ToolCallPart): Projection =>
    step(id, (message) => {
      const index = message.parts.findIndex((part) => part.type === "tool_call" && part.callId === callId)
      const part = message.parts[index]
      if (part === undefined || part.type !== "tool_call")
        return fail("not_found", `tool call ${callId} does not exist in message ${id}`)
      return { ...message, parts: message.parts.with(index, change(part)) }
    })
  /** Applies a step's single terminal event. */
  const close = (id: MessageId, change: (message: AssistantMessage) => AssistantMessage): Projection => {
    const closed = step(id, (message) => {
      const unsettled = message.parts.filter((part) => part.type === "tool_call" && part.state.status !== "settled")
      if (unsettled.length > 0)
        fail("invalid_transition", `${unsettled.length} tool call(s) of step ${id} are not settled`)
      return { ...change(message), endedAt: event.time }
    })
    return { ...closed, session: { ...closed.session, open: null } }
  }
  const execution = (id: string, statuses: readonly ("running" | "suspended")[]) => {
    const current = state.session.execution
    if (current === null || current.id !== id) return fail("not_found", `execution ${id} is not the claimed execution`)
    if (!statuses.includes(current.status)) return fail("invalid_transition", `execution ${id} is ${current.status}`)
    atBoundary()
    return current
  }
  /** Checks that an exclusion range starts after the latest compaction and not after `last`. */
  const range = (fromSeq: number, last: number) => {
    const floor = state.session.compaction?.seq ?? 0
    if (fromSeq <= floor || fromSeq > last)
      fail("invalid_range", `the range must start after seq ${floor} and no later than seq ${last}`)
  }
  const created = { seq: event.seq, time: event.time, excluded: null }

  switch (event.type) {
    case "session.renamed":
      return session({ title: event.data.title })
    case "session.archived":
      return session({ archived: true })
    case "session.unarchived":
      return session({ archived: false })

    case "baseline.set": {
      atBoundary()
      const compactedSince = (state.session.compaction?.seq ?? 0) > (state.baseline?.seq ?? 0)
      if (state.baseline !== null && !compactedSince)
        fail("invalid_transition", "the baseline is frozen until the next compaction")
      return { ...state, baseline: { seq: event.seq, instructions: event.data.instructions, tools: event.data.tools } }
    }
    case "instruction.appended":
      return add({
        kind: "instruction",
        id: event.data.messageId,
        ...created,
        source: event.data.source,
        text: event.data.text,
      })

    case "inbox.enqueued": {
      unused(event.data.messageId)
      const item = {
        messageId: event.data.messageId,
        seq: event.seq,
        time: event.time,
        origin: event.data.origin,
        delivery: event.data.delivery,
        content: event.data.content,
      }
      return { ...state, inbox: [...state.inbox, item] }
    }
    case "inbox.delivery_changed": {
      const index = state.inbox.findIndex((item) => item.messageId === event.data.messageId)
      const item = state.inbox[index]
      if (item === undefined) return fail("not_found", `inbox item ${event.data.messageId} is not waiting`)
      return { ...state, inbox: state.inbox.with(index, { ...item, delivery: event.data.delivery }) }
    }
    case "inbox.cancelled": {
      if (!state.inbox.some((item) => item.messageId === event.data.messageId))
        fail("not_found", `inbox item ${event.data.messageId} is not waiting`)
      return { ...state, inbox: state.inbox.filter((item) => item.messageId !== event.data.messageId) }
    }
    case "inbox.delivered": {
      const item = state.inbox.find((candidate) => candidate.messageId === event.data.messageId)
      if (item === undefined) return fail("not_found", `inbox item ${event.data.messageId} is not waiting`)
      atBoundary()
      claimed()
      const delivered: Message =
        item.origin === null
          ? { kind: "user", id: item.messageId, ...created, content: item.content, delivery: item.delivery }
          : {
              kind: "synthetic",
              id: item.messageId,
              ...created,
              origin: item.origin,
              content: item.content,
              delivery: item.delivery,
            }
      return {
        ...state,
        inbox: state.inbox.filter((candidate) => candidate !== item),
        messages: [...state.messages, delivered],
      }
    }
    case "synthetic.appended":
      return add({
        kind: "synthetic",
        id: event.data.messageId,
        ...created,
        origin: event.data.origin,
        content: event.data.content,
        delivery: null,
      })

    case "execution.started": {
      if (state.session.execution !== null)
        fail("invalid_transition", `execution ${state.session.execution.id} already holds the claim`)
      atBoundary()
      return session({
        execution: { id: event.data.executionId, status: "running", resumes: 0, startedSeq: event.seq },
      })
    }
    case "execution.resumed": {
      const current = execution(event.data.executionId, ["running", "suspended"])
      return session({ execution: { ...current, status: "running", resumes: current.resumes + 1 } })
    }
    case "execution.succeeded":
      execution(event.data.executionId, ["running"])
      return session({ execution: null })
    case "execution.failed":
      execution(event.data.executionId, ["running", "suspended"])
      return session({ execution: null })
    case "execution.interrupted": {
      const current = execution(event.data.executionId, ["running"])
      return session({ execution: releasesClaim(event.data.reason) ? null : { ...current, status: "suspended" } })
    }

    case "step.started": {
      claimed()
      const started = add({
        kind: "assistant",
        id: event.data.messageId,
        ...created,
        model: event.data.model,
        attempt: event.data.attempt,
        status: "running",
        parts: [],
        finish: null,
        usage: null,
        error: null,
        refusal: null,
        lastRetry: null,
        endedAt: null,
      })
      return { ...started, session: { ...started.session, open: { kind: "step", messageId: event.data.messageId } } }
    }
    case "step.ended":
      return close(event.data.messageId, (message) => ({
        ...message,
        status: "completed",
        finish: event.data.finish,
        usage: event.data.usage,
      }))
    case "step.failed": {
      const error = event.data.error
      if (error.kind === "provider" && error.error.kind === "content_policy")
        fail("invalid_transition", "a refusal is recorded as step.refused so that it is excluded from model history")
      return close(event.data.messageId, (message) => ({
        ...message,
        status: "failed",
        error,
        usage: event.data.usage,
      }))
    }
    case "step.refused": {
      const closed = close(event.data.messageId, (message) => {
        range(event.data.excludeFromSeq, message.seq)
        return { ...message, status: "refused", refusal: event.data.message, usage: event.data.usage }
      })
      return { ...closed, messages: exclude(closed.messages, event.data.excludeFromSeq, "refused") }
    }
    case "retry.scheduled":
      return edit(event.data.messageId, "assistant", (message) => {
        if (message.status !== "running" && message.status !== "failed")
          fail("invalid_transition", `step ${message.id} is ${message.status} and cannot be retried`)
        if (event.data.attempt <= message.attempt)
          fail("invalid_transition", `attempt ${message.attempt} of step ${message.id} has already run`)
        return {
          ...message,
          // Before output the retry continues under this message; after a failure it runs under a new one.
          attempt: message.status === "running" ? event.data.attempt : message.attempt,
          lastRetry: {
            attempt: event.data.attempt,
            delayMs: event.data.delayMs,
            error: event.data.error,
            time: event.time,
          },
        }
      })

    case "text.ended":
      return step(event.data.messageId, (message) => ({
        ...message,
        parts: [...message.parts, { type: "text", text: event.data.text, providerData: event.data.providerData }],
      }))
    case "reasoning.ended":
      return step(event.data.messageId, (message) => ({
        ...message,
        parts: [...message.parts, { type: "reasoning", text: event.data.text, providerData: event.data.providerData }],
      }))

    case "tool.called":
      return step(event.data.messageId, (message) => {
        if (message.parts.some((part) => part.type === "tool_call" && part.callId === event.data.callId))
          fail("duplicate_id", `tool call ${event.data.callId} already exists in message ${message.id}`)
        const part: ToolCallPart = {
          type: "tool_call",
          callId: event.data.callId,
          name: event.data.name,
          input: event.data.input,
          providerData: event.data.providerData,
          state: { status: "pending" },
        }
        return { ...message, parts: [...message.parts, part] }
      })
    case "tool.started":
      return call(event.data.messageId, event.data.callId, (part) => {
        if (part.state.status !== "pending")
          fail("invalid_transition", `tool call ${part.callId} is ${part.state.status}, not pending`)
        return { ...part, state: { status: "running" } }
      })
    case "tool.settled":
      return call(event.data.messageId, event.data.callId, (part) => {
        const allowed: readonly ToolOutcome[] = part.state.status === "settled" ? [] : SETTLE_FROM[part.state.status]
        if (!allowed.includes(event.data.outcome))
          fail("invalid_transition", `a ${part.state.status} tool call cannot settle as ${event.data.outcome}`)
        return {
          ...part,
          state: {
            status: "settled",
            outcome: event.data.outcome,
            output: event.data.output,
            truncation: event.data.truncation,
            attachments: event.data.attachments,
            display: event.data.display,
          },
        }
      })

    case "compaction.started": {
      claimed()
      const started = add({
        kind: "compaction",
        id: event.data.messageId,
        ...created,
        trigger: event.data.trigger,
        status: "running",
        summary: null,
        keepFromSeq: null,
        usage: null,
        error: null,
        endedAt: null,
      })
      return {
        ...started,
        session: { ...started.session, open: { kind: "compaction", messageId: event.data.messageId } },
      }
    }
    case "compaction.ended":
    case "compaction.failed": {
      const open = state.session.open
      if (open === null || open.kind !== "compaction" || open.messageId !== event.data.messageId)
        fail("invalid_transition", `compaction ${event.data.messageId} is not open`)
      if (event.type === "compaction.failed") {
        const failed = edit(event.data.messageId, "compaction", (message) => ({
          ...message,
          status: "failed",
          error: event.data.error,
          endedAt: event.time,
        }))
        return { ...failed, session: { ...failed.session, open: null } }
      }
      const ended = edit(event.data.messageId, "compaction", (message) => {
        range(event.data.keepFromSeq, message.seq)
        return {
          ...message,
          status: "completed",
          summary: event.data.summary,
          keepFromSeq: event.data.keepFromSeq,
          usage: event.data.usage,
          endedAt: event.time,
        }
      })
      const seq = ended.messages.findLast((message) => message.id === event.data.messageId)!.seq
      return {
        ...ended,
        session: {
          ...ended.session,
          open: null,
          compaction: { messageId: event.data.messageId, seq, keepFromSeq: event.data.keepFromSeq },
        },
      }
    }

    case "history.reverted": {
      if (state.session.execution !== null) fail("invalid_transition", "a session can be reverted only while idle")
      atBoundary()
      range(event.data.fromSeq, state.lastSeq)
      return { ...state, messages: exclude(state.messages, event.data.fromSeq, "reverted") }
    }

    default:
      return event satisfies never
  }
}

/** Marks every not-yet-excluded message from `fromSeq` on. Untouched messages keep their identity. */
function exclude(messages: readonly Message[], fromSeq: number, reason: Exclusion): readonly Message[] {
  return messages.map((message) =>
    message.seq >= fromSeq && message.excluded === null ? { ...message, excluded: reason } : message,
  )
}
