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
 * - Messages enter history only at a step boundary and only under a running
 *   execution claim. A step needs a baseline to build its request from.
 * - Inbox items are delivered oldest first within their mode; a queued item
 *   only when no steer waits and the session would otherwise go idle, which,
 *   after a turn, the gate says with `turn.ended` right before the delivery.
 * - An execution succeeds only when nothing waits in the inbox and the model
 *   has answered everything it was given.
 * - A tool call follows its state machine and settles exactly once.
 * - A step has exactly one terminal event, and all its calls settle before it.
 * - A retry is scheduled only for a retryable provider error, only for the
 *   step in progress and only before durable output or after the message
 *   failed; attempts count up by one and the next step carries the scheduled one.
 * - Once an interrupt is requested the execution only winds down and ends as
 *   interrupted for that reason. A step that was cut short (interrupted or
 *   crashed) is followed at once by the interrupt marker.
 * - A step calls the model the session's settings name; settings change only
 *   at a step boundary.
 * - A compaction's cut never reaches back past the cut of the one before it.
 *   A revert or refusal range may hold a compaction: that compaction is then
 *   excluded like any message, and model history starts from the latest one
 *   that is not.
 * - Checks start only when the session would otherwise go idle, and a run has
 *   one terminal event. An execution ends as done with what the gate found.
 * - A revert and its undo happen only while idle; one that restores files is
 *   announced first and closed by exactly one event. Only the latest revert
 *   can be undone, and only until new work starts.
 * - A session is archived once and unarchived once: each event changes something.
 * - The agent a session runs as changes before its first baseline, or right
 *   after the instruction message that tells the model, and never otherwise.
 * - A hook's record names the call it applied to, which has no result yet,
 *   or, for a stop hook, no call, at a boundary; an ending names the stop
 *   hooks that were not satisfied only when there is one.
 *
 * Structure is shared: parts of the state an event does not touch are returned
 * as the same objects, so `projectionChanges` can find what to write.
 */
import { AGENT_KEY } from "../agents/use.ts"
import { type StepError, type StoredEvent, HARNESS_ORIGIN } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import { releasesClaim } from "../interrupt.ts"
import { sumUsage } from "../provider/usage.ts"
import {
  type AssistantMessage,
  type Exclusion,
  INITIAL_TRACKING,
  type Message,
  type MessageKind,
  type Projection,
  type SessionState,
  type ToolCallPart,
  describeOpen,
  settleOutcomes,
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
    rootId: event.data.lineage?.kind !== "fork" || state === null ? event.sessionId : state.session.rootId,
    archived: false,
    createdAt: event.time,
    settings: event.data.settings,
    execution: null,
    open: null,
    compaction: null,
    // A fork starts untracked too: its snapshots, verification and undo history are its own.
    ...INITIAL_TRACKING,
    // It starts with no approvals of its own, and with its parent's taint: the content came with the history.
    ...(event.data.lineage?.kind === "fork" && state?.session.approval?.taint != null ? { approval: { grants: [], taint: state.session.approval.taint } } : {}),
    // The agent it runs as came with the history too: its instructions are in the inherited baseline or messages.
    ...(event.data.lineage?.kind === "fork" && state?.session.agent !== undefined ? { agent: state.session.agent } : {}),
  }
  const lineage = event.data.lineage
  if (lineage === null || lineage.kind !== "fork") {
    // A root, a subagent and a replay all start a history of their own.
    if (state !== null) throw new ReduceError("out_of_order", "the session already exists", event)
    if (event.seq !== 1) throw new ReduceError("out_of_order", `a ${lineage === null ? "root" : lineage.kind} session starts at seq 1`, event)
    if (event.data.inherited !== undefined) throw new ReduceError("invalid_transition", "only a fork inherits history: nothing is carried into a session that starts its own", event)
    const started: SessionState = lineage?.kind === "replay" ? { ...session, replay: { workspace: null, ended: null } } : session
    return { lastSeq: 1, updatedAt: event.time, session: started, baseline: null, messages: [], inbox: [] }
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
  if (event.data.inherited?.taint.some((entry) => entry.at > lineage.throughSeq))
    throw new ReduceError("invalid_range", "what a fork carries of its inherited history lies at or before its fork point", event)
  return {
    lastSeq: event.seq,
    updatedAt: event.time,
    session: { ...session, compaction: state.session.compaction },
    baseline: state.baseline,
    messages: state.messages,
    inbox: [],
  }
}

type AppliedEvent = Exclude<StoredEvent, { type: "session.created" }>

/**
 * What an event is to an execution that is winding down.
 * - `session`: about the session or its inbox, written whenever the user acts. Never held back.
 * - `wind_down`: brings an interrupted execution to rest (each has its own check below).
 * - `work`: moves the session forward. Rejected once an interrupt was requested,
 *   and while a cut-short step still waits for its marker.
 *
 * Listing every type here makes a new event a compile error until it is classified.
 */
const SCOPE = {
  "session.renamed": "session",
  "session.archived": "session",
  "session.unarchived": "session",
  "inbox.enqueued": "session",
  // Part of the admission it describes: written with it, whatever the execution is doing.
  "command.expanded": "session",
  "inbox.delivery_changed": "session",
  "inbox.cancelled": "session",
  "settings.changed": "session",
  "text.ended": "wind_down",
  "tool.settled": "wind_down",
  // The record of a hook that had finished is written with what settles its call, also while an interrupt is wound down.
  "hook.ran": "wind_down",
  "step.failed": "wind_down",
  "compaction.failed": "wind_down",
  "synthetic.appended": "wind_down",
  "execution.interrupted": "wind_down",
  "baseline.set": "work",
  "instruction.appended": "work",
  "agent.switched": "work",
  "inbox.delivered": "work",
  "turn.ended": "work",
  "execution.started": "work",
  "execution.interrupt_requested": "work",
  "execution.resumed": "work",
  "execution.succeeded": "work",
  "execution.failed": "work",
  "step.started": "work",
  "step.ended": "work",
  "step.refused": "work",
  "retry.scheduled": "work",
  "reasoning.ended": "work",
  "tool.called": "work",
  "tool.started": "work",
  // Stopping one call keeps the turn going, so it is work: once an interrupt was requested everything stops anyway.
  "tool.cancel_requested": "work",
  "compaction.started": "work",
  "compaction.repair_requested": "work",
  "compaction.ended": "work",
  "history.reverted": "work",
  // A snapshot is a fact about the working tree, whatever the execution is doing.
  "snapshot.taken": "session",
  "snapshot.unavailable": "session",
  "snapshot.coverage": "session",
  "checks.started": "work",
  "checks.finished": "work",
  "checks.failed": "wind_down",
  "revert.started": "work",
  "revert.undo_started": "work",
  "history.restored": "work",
  "revert.failed": "work",
  "approval.requested": "work",
  "approval.answered": "work",
  "approval.denied": "work",
  // Facts about the conversation, whatever the execution is doing: a result that settles during a wind-down still taints.
  "taint.noticed": "session",
  "taint.cleared": "session",
  "spawn.started": "work",
  // A fact about work that ran beside the steps: it ends when it ends, also while an interrupt is wound down.
  "spawn.ended": "session",
  "replay.call": "work",
  "replay.diverged": "work",
  "replay.ended": "session",
} as const satisfies Record<AppliedEvent["type"], "session" | "wind_down" | "work">

function apply(state: Projection, event: AppliedEvent): Projection {
  const fail = (code: ReduceErrorCode, detail: string): never => {
    throw new ReduceError(code, detail, event)
  }
  const held = state.session.execution
  if (held !== null && SCOPE[event.type] !== "session") {
    if (held.interrupting !== null && SCOPE[event.type] === "work")
      fail(
        "invalid_transition",
        `an interrupt (${held.interrupting}) was requested, so the execution only winds down and ends as interrupted`,
      )
    // Cancel rule 6: the model is told, durably, right where the response was cut.
    const last = state.messages.at(-1)
    const cutShort =
      last?.kind === "assistant" &&
      last.seq > held.startedSeq &&
      last.status === "failed" &&
      (last.error?.kind === "interrupted" || last.error?.kind === "crashed")
    if (cutShort && !(event.type === "synthetic.appended" && event.data.origin === HARNESS_ORIGIN.interrupt))
      fail("invalid_transition", `step ${last.id} was cut short: the interrupt marker must follow it`)
  }
  // A turn that ended for a queued item is followed by that item's delivery and by nothing else.
  const handover = state.session.open?.kind === "handover" ? state.session.open : null
  if (handover !== null && !(event.type === "inbox.delivered" && event.data.messageId === handover.messageId))
    fail("invalid_transition", `the turn ended for queued item ${handover.messageId}: its delivery comes next`)
  /** A step or compaction closes as `interrupted` exactly when that interrupt was requested, and as nothing else then. */
  const closing = (error: StepError) => {
    const interrupting = held?.interrupting ?? null
    if (error.kind === "interrupted" && error.reason !== interrupting)
      fail("invalid_transition", `no ${error.reason} interrupt was requested (execution.interrupt_requested comes first)`)
    if (error.kind !== "interrupted" && interrupting !== null)
      fail("invalid_transition", `an interrupt (${interrupting}) was requested, so this ends as interrupted for that reason`)
  }
  const session = (patch: Partial<SessionState>): Projection => ({ ...state, session: { ...state.session, ...patch } })
  const atBoundary = () => {
    if (state.session.open !== null) fail("invalid_transition", `${describeOpen(state.session.open)} is still open`)
  }
  /** The execution that holds a running claim. */
  const claimed = () => {
    const current = state.session.execution
    if (current === null || current.status !== "running") return fail("invalid_transition", "no execution is running")
    return current
  }
  /** Who verifies a turn is a fact about the session: a subagent's is left to its parent's turn, and nobody else's is. */
  const verifiedBy = (outcome: { readonly status: string }) => {
    const subagent = state.session.lineage?.kind === "spawn"
    if (subagent && outcome.status !== "left_to_parent") fail("invalid_transition", "a subagent's turn is not verified by itself: its ending says left_to_parent")
    if (!subagent && outcome.status === "left_to_parent") fail("invalid_transition", "only a subagent leaves the verification of its turn to the session that started it")
  }
  /** The baseline every request of a step or compaction is built from. */
  const based = () => {
    if (state.baseline === null) fail("invalid_transition", "no baseline has been set (baseline.set comes before the first step)")
  }
  /**
   * Whether the session would go idle now: under this claim, nothing said to
   * the model is still unanswered. True when the claim has added no user,
   * harness or assistant message, or when the latest of them is a completed
   * step that did not ask for tools.
   */
  /** What was said under the claim: user, harness and assistant messages. */
  const spokenSince = (startedSeq: number) =>
    state.messages.filter(
      (message) =>
        message.seq > startedSeq && (message.kind === "user" || message.kind === "synthetic" || message.kind === "assistant"),
    )
  const wouldGoIdle = (startedSeq: number, unansweredReport = false) => {
    const spoken = spokenSince(startedSeq)
    // The report of checks left unresolved is told to the model without sending it back.
    const last = spoken.at(-1)
    const reported = unansweredReport && last?.kind === "synthetic" && last.delivery === null && last.origin === HARNESS_ORIGIN.checkReport
    const latest = reported ? spoken.at(-2) : last
    return (
      latest === undefined || (latest.kind === "assistant" && latest.status === "completed" && latest.finish !== "tool_calls")
    )
  }
  /** An ending that names stop hooks names at least one, each once. */
  const unsatisfied = (hooks: { readonly unsatisfied: readonly string[] } | undefined) => {
    if (hooks === undefined) return
    if (hooks.unsatisfied.length === 0) fail("invalid_transition", "an ending names the stop hooks that were not satisfied only when there is one")
    if (new Set(hooks.unsatisfied).size !== hooks.unsatisfied.length) fail("invalid_transition", "an ending names each stop hook that was not satisfied once")
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
  /** The open run of checks numbered `run`. */
  const checking = (run: number) => {
    const open = state.session.open
    if (open === null || open.kind !== "checks" || open.run !== run) return fail("invalid_transition", `checks run ${run} is not open`)
    return open
  }
  /** Closes the open restore with what it did to the workspace, which must be the restore that was announced. */
  const restored = (kind: "revert" | "undo", restore: { readonly target: string; readonly before: string } | null) => {
    const open = state.session.open
    if (open === null) {
      if (restore !== null) fail("invalid_transition", `a restore of the workspace is announced first (${kind === "revert" ? "revert.started" : "revert.undo_started"})`)
      return
    }
    if (open.kind !== kind) return fail("invalid_transition", `${describeOpen(open)} is still open`)
    if (restore === null || restore.target !== open.target || restore.before !== open.before)
      fail("invalid_transition", `${describeOpen(open)} restores ${open.target} from ${open.before}, and its record must say so`)
  }
  const idle = () => {
    if (state.session.execution !== null) fail("invalid_transition", "a session can be reverted only while idle")
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
  /** Checks that an exclusion range starts no later than `last`. It may reach back past a compaction, which it then excludes. */
  const range = (fromSeq: number, last: number) => {
    if (fromSeq > last) fail("invalid_range", `the range must start no later than seq ${last}`)
  }
  /** The compaction that is open under `id`. */
  const compacting = (id: MessageId) => {
    const open = state.session.open
    if (open === null || open.kind !== "compaction" || open.messageId !== id) fail("invalid_transition", `compaction ${id} is not open`)
  }
  const created = { seq: event.seq, time: event.time, excluded: null }

  switch (event.type) {
    case "session.renamed":
      return session({ title: event.data.title })
    case "session.archived":
      if (state.session.archived) fail("invalid_transition", "the session is already archived")
      return session({ archived: true })
    case "session.unarchived":
      if (!state.session.archived) fail("invalid_transition", "the session is not archived")
      return session({ archived: false })
    case "settings.changed": {
      // A request in flight was built from the settings it started with.
      atBoundary()
      const current = state.session.settings
      if (current.model === event.data.model && current.reasoningEffort === event.data.reasoningEffort)
        fail("invalid_transition", "the settings are unchanged")
      return session({ settings: event.data })
    }

    case "baseline.set": {
      atBoundary()
      const compactedSince = (state.session.compaction?.seq ?? 0) > (state.baseline?.seq ?? 0)
      if (state.baseline !== null && !compactedSince)
        fail("invalid_transition", "the baseline is frozen until the next compaction")
      const sources = event.data.sources.map((entry) => entry.source)
      const repeated = sources.find((source, index) => sources.indexOf(source) !== index)
      if (repeated !== undefined) fail("duplicate_id", `instruction source ${repeated} is listed twice`)
      return {
        ...state,
        baseline: {
          seq: event.seq,
          instructions: event.data.instructions,
          tools: event.data.tools,
          sources: event.data.sources,
        },
      }
    }
    case "instruction.appended":
      // A message enters history under a running claim. The one exception is the message that announces a switch
      // of agent: the user makes one between two turns too, and it is recorded when it is made, at a boundary.
      if (event.data.source !== AGENT_KEY) claimed()
      return add({
        kind: "instruction",
        id: event.data.messageId,
        ...created,
        source: event.data.source,
        text: event.data.text,
        fingerprint: event.data.fingerprint,
      })

    case "agent.switched": {
      atBoundary()
      const current = state.session.agent ?? null
      const next = event.data.to
      if (event.data.from !== (current?.name ?? null)) fail("invalid_transition", `the session runs as ${current === null ? "no agent" : `the agent "${current.name}"`}, and the switch must say so`)
      if (current === null && next === null) fail("invalid_transition", "the session runs as no agent: there is nothing to switch off")
      if (event.data.messageId === null) {
        // Before the first baseline the agent's instructions become a section of it; later only a message can say them.
        if (state.baseline !== null) fail("invalid_transition", "the baseline is frozen: a switch is announced by an instruction message (instruction.appended with source agent comes first)")
      } else {
        // No claim is needed: the message it follows was accepted where a switch may be made (see `instruction.appended`).
        const announced = state.messages.at(-1)
        if (announced === undefined || announced.id !== event.data.messageId || announced.kind !== "instruction" || announced.source !== AGENT_KEY || announced.seq !== event.seq - 1)
          fail("invalid_transition", `a switch follows at once the instruction message that announces it, and ${event.data.messageId} is not that message`)
        else if ((announced.fingerprint === null) !== (next === null)) fail("invalid_transition", "the message that announces a switch carries the new agent's instructions, or withdraws the old one's")
      }
      return session({ agent: next })
    }

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
    case "command.expanded": {
      // The record of where an admitted message's text came from: it follows that admission at once, in its append.
      const index = state.inbox.findIndex((candidate) => candidate.messageId === event.data.messageId)
      const item = state.inbox[index]
      if (item === undefined) return fail("not_found", `inbox item ${event.data.messageId} is not waiting`)
      if (item.seq !== event.seq - 1) fail("invalid_transition", `a command's record follows at once the admission of the message it produced, and ${event.data.messageId} was admitted at seq ${item.seq}`)
      if (item.origin !== null) fail("invalid_transition", "a command produces a message of the user's, never one of the harness's")
      const { messageId: _, ...command } = event.data
      return { ...state, inbox: state.inbox.with(index, { ...item, command }) }
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
      if (handover === null) atBoundary()
      const current = claimed()
      const first = state.inbox.find((candidate) => candidate.delivery === item.delivery)
      if (first !== item)
        fail("invalid_transition", `${item.delivery} item ${first?.messageId} was admitted earlier and is delivered first`)
      if (item.delivery === "queue" && handover === null) {
        const steer = state.inbox.find((candidate) => candidate.delivery === "steer")
        if (steer !== undefined)
          fail("invalid_transition", `steered item ${steer.messageId} is delivered before any queued item`)
        // Whether a turn may end is the gate's decision, so a queued item behind a turn waits for `turn.ended`.
        // Only as the first input under the claim is there no turn before it.
        if (spokenSince(current.startedSeq).length > 0)
          fail("invalid_transition", "a queued item is delivered only once the turn before it has ended (turn.ended comes first)")
      }
      const delivered: Message =
        item.origin === null
          ? { kind: "user", id: item.messageId, ...created, content: item.content, delivery: item.delivery, ...(item.command === undefined ? {} : { command: item.command }) }
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
        session: handover === null ? state.session : { ...state.session, open: null },
        inbox: state.inbox.filter((candidate) => candidate !== item),
        messages: [...state.messages, delivered],
      }
    }
    case "turn.ended": {
      const current = claimed()
      atBoundary()
      const steer = state.inbox.find((candidate) => candidate.delivery === "steer")
      if (steer !== undefined) fail("invalid_transition", `steered item ${steer.messageId} is delivered at once: a steer does not wait for the turn to end`)
      const queued = state.inbox.find((candidate) => candidate.delivery === "queue")
      if (queued === undefined) return fail("invalid_transition", "no queued item waits: an execution with nothing left to do ends (execution.succeeded)")
      if (spokenSince(current.startedSeq).length === 0) fail("invalid_transition", "there is no turn to end under this execution")
      const outcome = event.data.verification
      verifiedBy(outcome)
      unsatisfied(event.data.hooks)
      if (!wouldGoIdle(current.startedSeq, outcome.status === "unresolved"))
        fail("invalid_transition", "the model has not answered everything it was given in this turn")
      return session({
        open: { kind: "handover", messageId: queued.messageId },
        // As when an execution ends with nothing to check: what is there now is what later checks are selected against.
        // Not so when changes made outside the turn were left unchecked: they stay to be verified.
        verification:
          outcome.status === "not_needed" && outcome.unverified !== true
            ? { ...state.session.verification, verified: { seq: event.seq, snapshot: state.session.workspace.snapshot?.id ?? null } }
            : state.session.verification,
      })
    }
    case "synthetic.appended":
      if ((held?.interrupting ?? null) !== null && event.data.origin !== HARNESS_ORIGIN.interrupt)
        fail("invalid_transition", "while an interrupt is wound down the only harness message is the interrupt marker")
      claimed()
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
        execution: { id: event.data.executionId, status: "running", crashResumes: 0, startedSeq: event.seq, nextAttempt: 1, interrupting: null },
        // New work on top of a revert makes it final.
        reverts: state.session.reverts.length === 0 ? state.session.reverts : [],
      })
    }
    case "execution.resumed": {
      const current = execution(event.data.executionId, ["running", "suspended"])
      // A claim that is still `running` at start-up was cut off by a crash; a `suspended` one was shut down cleanly.
      const crashResumes = current.crashResumes + (current.status === "running" ? 1 : 0)
      return session({ execution: { ...current, status: "running", crashResumes } })
    }
    case "execution.succeeded": {
      const current = execution(event.data.executionId, ["running"])
      const waiting = state.inbox[0]
      if (waiting !== undefined)
        fail("invalid_transition", `inbox item ${waiting.messageId} is waiting: deliver it instead of going idle`)
      const outcome = event.data.verification
      verifiedBy(outcome)
      unsatisfied(event.data.hooks)
      if (!wouldGoIdle(current.startedSeq, outcome.status === "unresolved"))
        fail("invalid_transition", "the model has not answered everything it was given under this execution")
      // With nothing to check, what is there now is what later checks are selected against. A turn that changed
      // nothing while files changed outside it verified nothing: those changes stay to be checked.
      const verification =
        outcome.status === "not_needed" && outcome.unverified !== true
          ? { ...state.session.verification, verified: { seq: event.seq, snapshot: state.session.workspace.snapshot?.id ?? null } }
          : state.session.verification
      return session({ execution: null, verification })
    }
    case "execution.failed":
      execution(event.data.executionId, ["running", "suspended"])
      return session({ execution: null })
    case "execution.interrupt_requested": {
      const current = claimed()
      if (current.id !== event.data.executionId)
        fail("not_found", `execution ${event.data.executionId} is not the claimed execution`)
      // A second request is rejected above: the first reason wins, as it does on the abort token.
      return session({ execution: { ...current, interrupting: event.data.reason } })
    }
    case "execution.interrupted": {
      const current = execution(event.data.executionId, ["running"])
      if (current.interrupting !== event.data.reason)
        fail(
          "invalid_transition",
          current.interrupting === null
            ? `no ${event.data.reason} interrupt was requested (execution.interrupt_requested comes first)`
            : `the interrupt was requested for ${current.interrupting}, so the execution ends for that reason`,
        )
      return session({
        execution: releasesClaim(event.data.reason) ? null : { ...current, status: "suspended", interrupting: null },
      })
    }

    case "step.started": {
      const current = claimed()
      based()
      if (event.data.model !== state.session.settings.model)
        fail(
          "invalid_transition",
          `the session's model is ${state.session.settings.model} (settings.changed comes before a step on another model)`,
        )
      if (event.data.attempt !== current.nextAttempt)
        fail(
          "invalid_transition",
          current.nextAttempt === 1
            ? "a step that is not a scheduled retry starts at attempt 1"
            : `the scheduled retry must start as attempt ${current.nextAttempt}`,
        )
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
      return {
        ...started,
        session: {
          ...started.session,
          execution: { ...current, nextAttempt: 1 },
          open: { kind: "step", messageId: event.data.messageId },
        },
      }
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
      closing(error)
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
      return recompacted({ ...closed, messages: exclude(closed.messages, event.data.excludeFromSeq, "refused") })
    }
    case "retry.scheduled": {
      const current = claimed()
      const error = event.data.error
      if (!error.retryable) fail("invalid_transition", `a ${error.kind} error is never retried unchanged`)
      const open = state.session.open
      if (open !== null && open.kind !== "step") return fail("invalid_transition", `${describeOpen(open)} is still open`)
      // One attempt budget per logical step: only the step in progress can be retried.
      const target =
        open?.messageId ??
        state.messages.findLast((message) => message.kind === "assistant" && message.seq > current.startedSeq)?.id
      const retried = edit(event.data.messageId, "assistant", (message) => {
        if (message.id !== target)
          fail("invalid_transition", `step ${message.id} is not the step in progress, so it cannot be retried`)
        if (message.status === "completed" || message.status === "refused")
          fail("invalid_transition", `step ${message.id} is ${message.status} and cannot be retried`)
        // Before durable output the retry is transparent; after it the message must fail first (retry rule 2).
        if (message.status === "running" && message.parts.length > 0)
          fail("invalid_transition", `step ${message.id} has durable output: it fails first and the retry runs under a new message`)
        if (message.status === "failed" && !(message.error?.kind === "provider" && message.error.error.retryable))
          fail("invalid_transition", `step ${message.id} did not fail with a retryable provider error`)
        if (message.status === "failed" && current.nextAttempt !== 1)
          fail("invalid_transition", `attempt ${current.nextAttempt} of step ${message.id} is already scheduled`)
        if (event.data.attempt !== message.attempt + 1)
          fail("invalid_transition", `the attempt after ${message.attempt} of step ${message.id} is ${message.attempt + 1}`)
        return {
          ...message,
          // Before output the retry continues under this message; after a failure it runs under a new one.
          attempt: message.status === "running" ? event.data.attempt : message.attempt,
          lastRetry: { attempt: event.data.attempt, delayMs: event.data.delayMs, error, time: event.time },
        }
      })
      if (open !== null) return retried
      return { ...retried, session: { ...retried.session, execution: { ...current, nextAttempt: event.data.attempt } } }
    }

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
        // A call the user was asked about runs only once they approved; a denied one never runs.
        if (part.approval?.kind === "denied") fail("invalid_transition", `tool call ${part.callId} was denied`)
        if (part.approval?.kind === "asked" && part.approval.answer?.approve !== true)
          fail("invalid_transition", `tool call ${part.callId} ${part.approval.answer === null ? "waits for the user's answer" : "was declined by the user"}`)
        return { ...part, state: { status: "running", effect: event.data.effect } }
      })
    case "tool.cancel_requested":
      claimed()
      return call(event.data.messageId, event.data.callId, (part) => {
        // Only a call that runs is stopped by itself: one that waits is declined or never begins, one that has its result is over.
        if (part.state.status !== "running") fail("invalid_transition", `tool call ${part.callId} is ${part.state.status}: only a running call is stopped by itself`)
        if (part.cancel !== undefined) fail("invalid_transition", `tool call ${part.callId} was already asked to stop`)
        return { ...part, cancel: { seq: event.seq } }
      })
    case "approval.requested":
      return call(event.data.messageId, event.data.callId, (part) => {
        if (part.state.status !== "pending") fail("invalid_transition", `tool call ${part.callId} is ${part.state.status}: a question comes before it starts`)
        if (part.approval !== undefined) fail("invalid_transition", `tool call ${part.callId} was already ${part.approval.kind}`)
        if (!event.data.question.choices.some((choice) => !choice.approve)) fail("invalid_transition", "a question always offers a way to decline")
        return { ...part, approval: { kind: "asked", seq: event.seq, question: event.data.question, needs: event.data.needs, then: event.data.then, answer: null } }
      })
    case "approval.answered": {
      const answered = call(event.data.messageId, event.data.callId, (part) => {
        const asked = part.approval
        if (part.state.status !== "pending" || asked?.kind !== "asked") return fail("invalid_transition", `tool call ${part.callId} was not asked about`)
        if (asked.answer !== null) fail("invalid_transition", `the question about tool call ${part.callId} was already answered`)
        const chosen = asked.question.choices.find((choice) => choice.id === event.data.choice)
        if (chosen === undefined) return fail("invalid_transition", `the question about tool call ${part.callId} offers no choice ${event.data.choice}`)
        if (chosen.approve !== event.data.approve) fail("invalid_transition", `choice ${chosen.id} ${chosen.approve ? "approves" : "declines"}`)
        // What is remembered is exactly what the choice said it would remember, given here and now.
        const offered = chosen.grants.map((template) => JSON.stringify([template.scope, template.rule]))
        const stored = event.data.grants.map((item) => JSON.stringify([item.scope, item.rule]))
        if (offered.length !== stored.length || offered.some((entry, index) => entry !== stored[index]))
          fail("invalid_transition", `choice ${chosen.id} remembers ${chosen.remembers ?? "nothing"}, and the answer must record exactly that`)
        if (event.data.grants.some((item) => item.scope === "session" && item.at !== event.seq))
          fail("invalid_transition", "a session approval is stamped with the position of the answer that gave it")
        return { ...part, approval: { ...asked, answer: { seq: event.seq, choice: event.data.choice, approve: event.data.approve, note: event.data.note } } }
      })
      const session = event.data.grants.filter((item) => item.scope === "session")
      if (session.length === 0) return answered
      const approval = answered.session.approval ?? { grants: [], taint: null }
      return { ...answered, session: { ...answered.session, approval: { ...approval, grants: [...approval.grants, ...session] } } }
    }
    case "approval.denied":
      return call(event.data.messageId, event.data.callId, (part) => {
        if (part.state.status !== "pending") fail("invalid_transition", `tool call ${part.callId} is ${part.state.status}: it is denied before it starts`)
        if (part.approval !== undefined) fail("invalid_transition", `tool call ${part.callId} was already ${part.approval.kind}`)
        if (event.data.stop && event.data.reason !== "unattended") fail("invalid_transition", "only a call nobody could approve ends the run")
        const agent = event.data.agent
        if (agent !== undefined && (event.data.reason !== "policy" || agent !== state.session.agent?.name))
          fail("invalid_transition", `a call is refused by the restrictions of the agent the session runs as, which is ${state.session.agent == null ? "none" : `"${state.session.agent.name}"`}`)
        return { ...part, approval: { kind: "denied", seq: event.seq, reason: event.data.reason, stop: event.data.stop, ...(agent === undefined ? {} : { agent }) } }
      })
    case "taint.noticed": {
      const approval = state.session.approval ?? { grants: [], taint: null }
      if (approval.taint !== null) fail("invalid_transition", "the session is already tainted: the user is told once")
      if (event.data.source.at > state.lastSeq) fail("invalid_range", "the source of the taint is a result already in the log")
      return session({ approval: { ...approval, taint: { seq: event.seq, source: event.data.source, text: event.data.text } } })
    }
    case "taint.cleared": {
      const approval = state.session.approval
      if (approval === undefined || approval.taint === null) return fail("invalid_transition", "the session is not tainted")
      return session({ approval: { ...approval, taint: null } })
    }
    case "tool.settled":
      return call(event.data.messageId, event.data.callId, (part) => {
        if (!settleOutcomes(part.state).includes(event.data.outcome))
          fail(
            "invalid_transition",
            `a ${part.state.status}${part.state.status === "running" ? ` ${part.state.effect}` : ""} tool call cannot settle as ${event.data.outcome}`,
          )
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
    case "hook.ran": {
      claimed()
      const record = event.data
      if ((record.answer === "skipped") !== (record.run.kind === "skipped")) fail("invalid_transition", "a hook is recorded as skipped exactly when it did not run because the user has not approved it")
      if (record.toModel !== null && record.answer !== "no") fail("invalid_transition", "only a hook that answered no has text that reached the model")
      if (record.point === "stop") {
        if (record.messageId !== null || record.callId !== null) fail("invalid_transition", "a stop hook applies to the end of a turn, not to a tool call")
        atBoundary()
        return state
      }
      if (record.messageId === null || record.callId === null) return fail("invalid_transition", `a ${record.point} hook applies to a tool call, which its record names`)
      const open = state.session.open
      if (open === null || open.kind !== "step" || open.messageId !== record.messageId) fail("invalid_transition", `step ${record.messageId} is not the open step`)
      const message = state.messages.findLast((candidate) => candidate.id === record.messageId)
      const part = message?.kind === "assistant" ? message.parts.find((candidate) => candidate.type === "tool_call" && candidate.callId === record.callId) : undefined
      if (part === undefined || part.type !== "tool_call") return fail("not_found", `tool call ${record.callId} does not exist in message ${record.messageId}`)
      if (part.state.status === "settled") fail("invalid_transition", `tool call ${part.callId} is settled: a hook's record comes before the result of its call`)
      if (record.point === "afterTool" && part.state.status !== "running") fail("invalid_transition", `an after hook applies to a call that ran, and tool call ${part.callId} never started`)
      // Nothing of it is state: the texts it gave the model are in the call's result, and taint is folded from the event.
      return state
    }

    case "compaction.started": {
      claimed()
      based()
      // The cut only moves forward: what an earlier checkpoint replaced stays replaced. Nothing kept is the event's own seq.
      const floor = state.session.compaction?.keepFromSeq ?? 1
      if (event.data.keepFromSeq < floor || event.data.keepFromSeq > event.seq)
        fail("invalid_range", `the cut must be from seq ${floor} to seq ${event.seq}`)
      const started = add({
        kind: "compaction",
        id: event.data.messageId,
        ...created,
        trigger: event.data.trigger,
        mode: event.data.mode,
        status: "running",
        keepFromSeq: event.data.keepFromSeq,
        prompt: event.data.prompt,
        repair: null,
        summary: null,
        source: null,
        detail: null,
        tokensBefore: event.data.tokensBefore,
        tokensAfter: null,
        usage: null,
        error: null,
        endedAt: null,
      })
      return {
        ...started,
        session: { ...started.session, open: { kind: "compaction", messageId: event.data.messageId } },
      }
    }
    case "compaction.repair_requested":
      compacting(event.data.messageId)
      return edit(event.data.messageId, "compaction", (message) => {
        if (message.repair !== null) fail("invalid_transition", `compaction ${message.id} already asked for one repair`)
        return { ...message, repair: { attempt: event.data.attempt, answer: event.data.answer, prompt: event.data.prompt } }
      })
    case "compaction.ended":
    case "compaction.failed": {
      compacting(event.data.messageId)
      if (event.type === "compaction.failed") {
        closing(event.data.error)
        const failed = edit(event.data.messageId, "compaction", (message) => ({
          ...message,
          status: "failed",
          error: event.data.error,
          endedAt: event.time,
        }))
        return { ...failed, session: { ...failed.session, open: null } }
      }
      const ended = edit(event.data.messageId, "compaction", (message) => {
        // A summary the model wrote is the first answer, or the answer to the one repair that was asked for.
        if (event.data.source === "repaired" && message.repair === null)
          fail("invalid_transition", `compaction ${message.id} asked for no repair (compaction.repair_requested comes first)`)
        return {
          ...message,
          status: "completed",
          summary: event.data.summary,
          source: event.data.source,
          detail: event.data.detail,
          tokensAfter: event.data.tokensAfter,
          usage: event.data.usage,
          endedAt: event.time,
        }
      })
      const checkpoint = ended.messages.findLast((message) => message.id === event.data.messageId)!
      return {
        ...ended,
        session: {
          ...ended.session,
          open: null,
          compaction: { messageId: event.data.messageId, seq: checkpoint.seq, keepFromSeq: (checkpoint as Extract<Message, { kind: "compaction" }>).keepFromSeq },
        },
      }
    }

    case "snapshot.taken": {
      const stepPoint = event.data.point === "step_start" || event.data.point === "step_end"
      const open = state.session.open
      if (stepPoint && (open === null || open.kind !== "step" || open.messageId !== event.data.messageId))
        fail("invalid_transition", `a ${event.data.point} snapshot names the open step`)
      if (!stepPoint && event.data.messageId !== null) fail("invalid_transition", `a ${event.data.point} snapshot belongs to no step`)
      const snapshot = { id: event.data.id, seq: event.seq }
      const verification = state.session.verification
      return session({
        workspace: { ...state.session.workspace, snapshot, unavailable: null },
        // The first snapshot is the state before the agent did anything: what the first checks are selected against.
        verification: verification.verified === null ? { ...verification, verified: { seq: event.seq, snapshot: event.data.id } } : verification,
      })
    }
    case "snapshot.unavailable":
      return session({ workspace: { ...state.session.workspace, snapshot: null, unavailable: event.data } })
    case "snapshot.coverage":
      return session({
        workspace: { ...state.session.workspace, skipped: event.data.skipped, nestedRepositories: event.data.nestedRepositories },
      })

    case "checks.started": {
      const current = claimed()
      atBoundary()
      if (event.data.checks.length === 0) fail("invalid_transition", "a run of checks names at least one check")
      // Checks answer "is it done?", so they run only once the model says it is and nobody has redirected it since.
      // A queued item waits for exactly this answer; a steer is delivered first.
      const waiting = state.inbox.find((candidate) => candidate.delivery === "steer")
      if (waiting !== undefined) fail("invalid_transition", `steered item ${waiting.messageId} is waiting: deliver it before checking`)
      if (!wouldGoIdle(current.startedSeq))
        fail("invalid_transition", "checks run only when the session would otherwise go idle")
      return session({ open: { kind: "checks", run: event.data.run, seq: event.seq } })
    }
    case "checks.finished": {
      checking(event.data.run)
      if (event.data.evidence.run !== event.data.run) fail("invalid_transition", `the evidence is of run ${event.data.evidence.run}`)
      const snapshot = state.session.workspace.snapshot?.id ?? null
      const passed = event.data.evidence.checks.every((check) => check.status === "passed")
      return session({
        open: null,
        verification: {
          verified: passed ? { seq: event.seq, snapshot } : state.session.verification.verified,
          latest: { run: event.data.run, seq: event.seq, snapshot, evidence: event.data.evidence },
        },
      })
    }
    case "checks.failed":
      checking(event.data.run)
      closing(event.data.error)
      return session({ open: null })

    case "revert.started": {
      idle()
      atBoundary()
      range(event.data.fromSeq, state.lastSeq)
      return session({ open: { kind: "revert", ...event.data } })
    }
    case "history.reverted": {
      idle()
      restored("revert", event.data.restore)
      range(event.data.fromSeq, state.lastSeq)
      const excluded = state.messages.filter((message) => message.seq >= event.data.fromSeq && message.excluded === null).map((message) => message.seq)
      const entry = {
        seq: event.seq,
        fromSeq: event.data.fromSeq,
        before: event.data.restore?.before ?? null,
        after: event.data.restore?.after ?? null,
        excluded,
      }
      return recompacted({
        ...state,
        session: { ...state.session, open: null, reverts: [...state.session.reverts, entry] },
        messages: exclude(state.messages, event.data.fromSeq, "reverted"),
      })
    }
    case "revert.undo_started": {
      idle()
      atBoundary()
      const last = state.session.reverts.at(-1)
      if (last === undefined || last.seq !== event.data.revertSeq)
        fail("invalid_transition", `only the latest revert can be undone, and only until new work starts`)
      else if (last.before !== event.data.target) fail("invalid_transition", `the undo of that revert restores ${last.before}`)
      return session({ open: { kind: "undo", ...event.data } })
    }
    case "history.restored": {
      idle()
      restored("undo", event.data.restore)
      const last = state.session.reverts.at(-1)
      if (last === undefined || last.seq !== event.data.revertSeq)
        return fail("invalid_transition", `only the latest revert can be undone, and only until new work starts`)
      if (last.before !== null && event.data.restore === null)
        fail("invalid_transition", "that revert restored files, so undoing it restores them too")
      const back = new Set(last.excluded)
      return recompacted({
        ...state,
        session: { ...state.session, open: null, reverts: state.session.reverts.slice(0, -1) },
        messages: state.messages.map((message) => (back.has(message.seq) && message.excluded === "reverted" ? { ...message, excluded: null } : message)),
      })
    }
    case "revert.failed": {
      const open = state.session.open
      if (open === null || (open.kind !== "revert" && open.kind !== "undo")) fail("invalid_transition", "no revert is open")
      return session({ open: null })
    }

    case "spawn.started": {
      claimed()
      const spawned = state.session.spawned ?? { running: [], children: [], usage: null }
      if (spawned.running.some((entry) => entry.spawnId === event.data.spawnId)) fail("duplicate_id", `spawned work ${event.data.spawnId} already exists`)
      // It is started by a call that is running: the tool that spawns it.
      const open = state.session.open
      const owner = open?.kind === "step" && open.messageId === event.data.messageId ? state.messages.findLast((message) => message.id === open.messageId) : undefined
      const part = owner?.kind === "assistant" ? owner.parts.find((candidate) => candidate.type === "tool_call" && candidate.callId === event.data.callId) : undefined
      if (part?.type !== "tool_call" || part.state.status !== "running")
        fail("invalid_transition", `work is spawned by a running tool call, and ${event.data.messageId}/${event.data.callId} is not one`)
      const work = event.data.work
      const child = work.kind === "subagent" ? work.sessionId : null
      if (child === state.session.id) fail("invalid_transition", "a session does not spawn itself")
      if (child !== null && spawned.running.some((entry) => entry.sessionId === child)) fail("invalid_transition", `subagent ${child} is still running: it takes a follow-up once it has ended`)
      const entry = {
        spawnId: event.data.spawnId,
        seq: event.seq,
        kind: work.kind,
        background: event.data.background,
        messageId: event.data.messageId,
        callId: event.data.callId,
        sessionId: child,
        command: work.kind === "command" ? work.command : null,
        logPath: work.kind === "command" ? work.logPath : null,
        worktree: work.kind === "subagent" ? work.worktree : null,
      }
      return session({
        spawned: {
          ...spawned,
          running: [...spawned.running, entry],
          children: child === null || spawned.children.includes(child) ? spawned.children : [...spawned.children, child],
        },
      })
    }
    case "spawn.ended": {
      const spawned = state.session.spawned
      const entry = spawned?.running.find((candidate) => candidate.spawnId === event.data.spawnId)
      if (spawned === undefined || entry === undefined) return fail("not_found", `spawned work ${event.data.spawnId} is not running`)
      if (entry.kind === "command" && (event.data.usage !== null || event.data.tainted || event.data.merge !== null))
        fail("invalid_transition", "a background command has no usage, taint or worktree")
      if (event.data.merge !== null && entry.worktree === null) fail("invalid_transition", `subagent ${entry.sessionId} did not work in a worktree`)
      const cost = event.data.usage
      const total = spawned.usage
      const usage = cost === null ? total : total === null ? cost : sumUsage(total, cost)
      return session({ spawned: { ...spawned, running: spawned.running.filter((candidate) => candidate !== entry), usage } })
    }

    case "replay.call": {
      if (state.session.replay === undefined) fail("invalid_transition", "the session is not a replay")
      // Checks only: the call's own events carry its state.
      return call(event.data.messageId, event.data.callId, (part) => {
        if (part.state.status === "settled") fail("invalid_transition", `tool call ${part.callId} is settled: what the replay made of it is recorded before its result`)
        if ((event.data.result === "matched" || event.data.result === "normalised") !== (event.data.recorded !== null))
          fail("invalid_transition", "a matched call names the recorded call it matched, and only a matched call does")
        if ((event.data.result === "diverged") !== (event.data.divergence !== null)) fail("invalid_transition", "the call that left the recording says how, and only that call does")
        return part
      })
    }
    case "replay.diverged": {
      const replay = state.session.replay
      if (replay === undefined) return fail("invalid_transition", "the session is not a replay")
      claimed()
      if (state.session.lineage?.kind === "replay" && state.session.lineage.policy === "stop") fail("invalid_transition", "a replay with the stop policy ends where it leaves the recording")
      if (replay.workspace !== null) fail("invalid_transition", "the replay already left the recording")
      if (replay.ended !== null) fail("invalid_transition", "the replay has ended")
      return session({ replay: { ...replay, workspace: event.data.workspace } })
    }
    case "replay.ended": {
      const replay = state.session.replay
      if (replay === undefined) return fail("invalid_transition", "the session is not a replay")
      if (replay.ended !== null) fail("invalid_transition", "the replay has already ended")
      return session({ replay: { ...replay, ended: { seq: event.seq, outcome: event.data.outcome, reason: event.data.reason } } })
    }

    default:
      return event satisfies never
  }
}

/**
 * After messages were excluded or put back: the compaction model history
 * starts from is the latest completed one that is not excluded. A revert to
 * before a compaction therefore undoes it for the model, and undoing that
 * revert brings it back. The session object keeps its identity when nothing changed.
 */
function recompacted(state: Projection): Projection {
  const latest = state.messages.findLast((message) => message.kind === "compaction" && message.status === "completed" && message.excluded === null)
  const current = state.session.compaction
  if ((latest?.id ?? null) === (current?.messageId ?? null)) return state
  const compaction = latest?.kind === "compaction" ? { messageId: latest.id, seq: latest.seq, keepFromSeq: latest.keepFromSeq } : null
  return { ...state, session: { ...state.session, compaction } }
}

/** Marks every not-yet-excluded message from `fromSeq` on. Untouched messages keep their identity. */
function exclude(messages: readonly Message[], fromSeq: number, reason: Exclusion): readonly Message[] {
  return messages.map((message) =>
    message.seq >= fromSeq && message.excluded === null ? { ...message, excluded: reason } : message,
  )
}
