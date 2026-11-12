/**
 * What the loop reads off the projection to decide its next move. Everything
 * here is a pure function of stored state: the loop keeps no conversation
 * state of its own, so after a restart it decides exactly what the process
 * before it would have decided.
 */
import type { Content } from "../content.ts"
import { type NewEvent, HARNESS_ORIGIN, event } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import type { CompactionOutcome } from "../context/policy.ts"
import { type AssistantMessage, type Message, type Projection, type ToolCallPart, hasSideEffect } from "../message/message.ts"
import type { ToolEffect } from "../tool/tool.ts"
import { safeDecode } from "../validate.ts"
import { ACKNOWLEDGE_TOOL_NAME, type Acknowledgement, acknowledgement } from "../verify/acknowledge.ts"
import { TOOL_TEXT } from "./constants.ts"

/** The held execution claim. The loop only runs while there is one. */
export function claimOf(projection: Projection) {
  const execution = projection.session.execution
  if (execution === null) throw new Error(`session ${projection.session.id} holds no execution claim`)
  return execution
}

/**
 * The latest thing said under the current claim: a user, harness or assistant
 * message. Instruction and compaction messages need no answer and are skipped.
 */
export function latestSpoken(projection: Projection): Message | undefined {
  const startedSeq = claimOf(projection).startedSeq
  return projection.messages.findLast(
    (message) => message.seq > startedSeq && (message.kind === "user" || message.kind === "synthetic" || message.kind === "assistant"),
  )
}

/**
 * Whether nothing said to the model under this claim is still unanswered.
 * The same test the reducer applies before it accepts `execution.succeeded`
 * or the delivery of a queued item.
 */
export function wouldGoIdle(projection: Projection): boolean {
  const latest = latestSpoken(projection)
  return latest === undefined || (latest.kind === "assistant" && latest.status === "completed" && latest.finish !== "tool_calls")
}

/** Whether `message` came out of the inbox: something a user or a harness component submitted. */
function delivered(message: Message): boolean {
  return message.kind === "user" || (message.kind === "synthetic" && message.delivery !== null)
}

/** The messages of the current turn: everything under the claim from the latest delivered input on. */
export function currentTurn(projection: Projection): readonly Message[] {
  const startedSeq = claimOf(projection).startedSeq
  const start = projection.messages.findLastIndex((message) => message.seq > startedSeq && delivered(message))
  return start === -1 ? projection.messages.filter((message) => message.seq > startedSeq) : projection.messages.slice(start)
}

/** The input that opened the current turn, when there is one. A per-turn step limit is keyed by its ID. */
export function turnInput(projection: Projection): Message | undefined {
  const first = currentTurn(projection)[0]
  return first !== undefined && delivered(first) ? first : undefined
}

/** Completed model calls of the current turn. A retry is not a step, and neither is a call that failed. */
export function stepsThisTurn(projection: Projection): number {
  return currentTurn(projection).filter((message) => message.kind === "assistant" && message.status === "completed").length
}

/** Whether the loop already appended a harness note of this origin in the current turn. */
export function notedThisTurn(projection: Projection, origin: string): boolean {
  return currentTurn(projection).some((message) => message.kind === "synthetic" && message.delivery === null && message.origin === origin)
}

/**
 * Where a refusal's exclusion range starts: the input that began the refused
 * turn, so the content that tripped the filter is not sent again (retry rule
 * 7). A turn begins with the first input delivered under the claim, and again
 * with every queued item, which is delivered only once the turn before it had
 * its answer. The range may hold a compaction made in the middle of that turn:
 * it is excluded with the turn, since its checkpoint quotes the turn's input.
 */
export function refusedTurnStart(projection: Projection, refused: AssistantMessage): number {
  const startedSeq = claimOf(projection).startedSeq
  const inputs = projection.messages.filter((message) => message.seq > startedSeq && delivered(message))
  const start = inputs.findLast((message, index) => index === 0 || ("delivery" in message && message.delivery === "queue"))
  return start?.seq ?? refused.seq
}

/**
 * The identical-call guard (retry rule 9): whether the two tool calls made
 * right before this one, in this turn, were this same call (same tool, same
 * argument text) and both gave the same result. Calls the guard itself
 * refused are skipped, so the guard keeps holding while the model keeps
 * repeating itself; any other call in between resets it, because that call
 * may have changed what this one would see. Calls made earlier in the same
 * response are not settled yet and never trip it.
 */
export function repeatsItself(projection: Projection, call: { readonly messageId: MessageId; readonly callId: string; readonly name: string; readonly input: string }): boolean {
  const calls = currentTurn(projection).flatMap((message) =>
    message.kind === "assistant"
      ? message.parts.flatMap((part) => (part.type === "tool_call" ? [{ messageId: message.id, part }] : []))
      : [],
  )
  const self = calls.findIndex((entry) => entry.messageId === call.messageId && entry.part.callId === call.callId)
  const before = (self === -1 ? calls : calls.slice(0, self))
    .map((entry) => entry.part)
    .filter((part) => !(part.state.status === "settled" && part.state.output === TOOL_TEXT.identicalCall))
    .slice(-2)
  const [first, second] = before
  if (first === undefined || second === undefined) return false
  if (first.state.status !== "settled" || second.state.status !== "settled") return false
  return (
    [first, second].every((part) => part.name === call.name && part.input === call.input) &&
    first.state.outcome === second.state.outcome &&
    first.state.output === second.state.output
  )
}

/** The assistant message of the open step, or `null` at a boundary or during a compaction. */
export function openStep(projection: Projection): AssistantMessage | null {
  const open = projection.session.open
  if (open === null || open.kind !== "step") return null
  const message = projection.messages.findLast((candidate) => candidate.id === open.messageId)
  if (message?.kind !== "assistant") throw new Error(`open step ${open.messageId} has no assistant message`)
  return message
}

/**
 * Whether the last message is a step that was cut short (interrupted or
 * crashed) and still waits for its interrupt marker. The reducer accepts
 * nothing else until the marker is written.
 */
export function owesMarker(projection: Projection): boolean {
  const last = projection.messages.at(-1)
  return (
    last?.kind === "assistant" &&
    last.seq > claimOf(projection).startedSeq &&
    last.status === "failed" &&
    (last.error?.kind === "interrupted" || last.error?.kind === "crashed")
  )
}

/** The texts for calls that nobody saw finish: stopped by an interrupt, or orphaned by a crash. */
export interface OrphanTexts {
  readonly read: string
  readonly effectUnknown: string
}

export const STOPPED: OrphanTexts = { read: TOOL_TEXT.interruptedRead, effectUnknown: TOOL_TEXT.effectUnknown }
/** For a call the user stopped by itself and whose tool reported nothing. */
export const CANCELLED: OrphanTexts = { read: TOOL_TEXT.cancelledRead, effectUnknown: TOOL_TEXT.cancelledEffectUnknown }
export const CRASHED: OrphanTexts = { read: TOOL_TEXT.crashRead, effectUnknown: TOOL_TEXT.crashEffectUnknown }

/**
 * Settles every call of `message` that is not settled, from its recorded
 * state alone (cancel rule 4): a pending call never began; a running read
 * changed nothing; a running call of any other class may have had its effect.
 */
export function settleUnsettled(message: AssistantMessage, texts: OrphanTexts): NewEvent<"tool.settled">[] {
  return message.parts.flatMap((part) => {
    if (part.type !== "tool_call" || part.state.status === "settled") return []
    return [settledBy(message.id, part, texts)]
  })
}

export function settledBy(messageId: MessageId, part: ToolCallPart, texts: OrphanTexts): NewEvent<"tool.settled"> {
  const state = part.state
  const settlement =
    state.status === "pending"
      ? ({ outcome: "not_started", output: TOOL_TEXT.notStarted } as const)
      : state.status === "running" && !hasSideEffect(state.effect)
        ? ({ outcome: "error", output: texts.read } as const)
        : ({ outcome: "effect_unknown", output: texts.effectUnknown } as const)
  return event("tool.settled", { messageId, callId: part.callId, ...settlement, truncation: null, attachments: [], display: null })
}

/** A harness message of one of the loop's origins. */
export function note(messageId: MessageId, origin: (typeof HARNESS_ORIGIN)[keyof typeof HARNESS_ORIGIN], value: string) {
  return event("synthetic.appended", { messageId, origin, content: [{ type: "text", text: value }] })
}

// ---------------------------------------------------------------- the context window

/** Whether an assistant message put something into history: a completed step, or a failed one that had output. */
function spoke(message: Message): boolean {
  return message.kind === "assistant" && (message.status === "completed" || (message.status === "failed" && message.parts.length > 0))
}

/**
 * Whether the next model call is the first after new input entered history:
 * the model has said nothing since the latest delivered input that is still
 * in history. This is where a compaction that is due "soon" happens.
 */
export function atInputBoundary(projection: Projection): boolean {
  const messages = projection.messages.filter((message) => message.excluded === null)
  const input = messages.findLastIndex(delivered)
  return input !== -1 && !messages.slice(input + 1).some(spoke)
}

/**
 * What the compaction in force achieved, for the policy: its mode, the size
 * it started from, and the size of the first request after it, as the
 * provider measured it once that call has run and as estimated until then.
 */
export function compactionOutcome(projection: Projection): CompactionOutcome | null {
  const current = projection.session.compaction
  if (current === null) return null
  const checkpoint = projection.messages.findLast((message) => message.id === current.messageId)
  if (checkpoint?.kind !== "compaction") return null
  const measured = projection.messages.find((message) => message.kind === "assistant" && message.seq > current.seq && message.status === "completed" && message.usage !== null)
  return {
    mode: checkpoint.mode,
    before: checkpoint.tokensBefore,
    after: (measured?.kind === "assistant" ? measured.usage?.inputTokens : undefined) ?? checkpoint.tokensAfter ?? 0,
  }
}

/** Whether a step completed after the compaction in force. When none did, the request about to be sent is the first built from it. */
export function completedStepSinceCompaction(projection: Projection): boolean {
  const current = projection.session.compaction
  return current === null || projection.messages.some((message) => message.kind === "assistant" && message.seq > current.seq && message.status === "completed")
}

// ---------------------------------------------------------------- the verification gate

/** Where the current turn begins in the log: the `seq` of its input, or of the claim when nothing was delivered under it. */
export function turnStartSeq(projection: Projection): number {
  return currentTurn(projection)[0]?.seq ?? claimOf(projection).startedSeq
}

/**
 * The input that began the turn in progress, for the gate, which verifies a
 * whole turn: the first input delivered under the claim, or the latest
 * queued one (a queued item is delivered only once the turn before it has
 * ended). A steer in between redirects the turn and does not begin one, so
 * this is not `turnInput`, which the step limit counts from. `undefined`
 * when nothing was delivered under the claim.
 */
export function turnBeginning(projection: Projection): Message | undefined {
  const startedSeq = claimOf(projection).startedSeq
  const inputs = projection.messages.filter((message) => message.seq > startedSeq && delivered(message))
  return inputs.findLast((message, index) => index === 0 || ("delivery" in message && message.delivery === "queue"))
}

/** The origins of the messages that tell the model how spawned work ended. */
const SPAWN_ENDS: ReadonlySet<string> = new Set([HARNESS_ORIGIN.backgroundCommand, HARNESS_ORIGIN.subagentResult, HARNESS_ORIGIN.spawnLost])

/**
 * Whether the turn in progress was told that spawned work ended: a
 * background command exited, a background subagent finished, or one of them
 * was lost. That work ran outside the steps, possibly between two turns, so
 * what it changed is nobody's turn but this one's to verify.
 */
export function spawnedWorkEndedThisTurn(projection: Projection): boolean {
  const from = turnBeginning(projection)?.seq ?? claimOf(projection).startedSeq
  return projection.messages.some((message) => message.seq >= from && message.kind === "synthetic" && message.delivery !== null && SPAWN_ENDS.has(message.origin))
}

/** The check reports the model was sent in the current turn, oldest first. */
export function reportsThisTurn(projection: Projection): readonly { readonly seq: number; readonly content: Content }[] {
  return currentTurn(projection).flatMap((message) =>
    message.kind === "synthetic" && message.delivery === null && message.origin === HARNESS_ORIGIN.checkReport
      ? [{ seq: message.seq, content: message.content }]
      : [],
  )
}

/**
 * What the model said with the acknowledgement tool after the latest check
 * report of this turn: the input of its latest call that ran, or `null`. A
 * call made before any report acknowledges nothing, and neither does one
 * whose arguments were refused.
 */
export function acknowledgementThisTurn(projection: Projection): Acknowledgement | null {
  const report = reportsThisTurn(projection).at(-1)
  if (report === undefined) return null
  const calls = currentTurn(projection).flatMap((message) =>
    message.kind === "assistant" && message.seq > report.seq
      ? message.parts.filter((part): part is ToolCallPart => part.type === "tool_call" && part.name === ACKNOWLEDGE_TOOL_NAME)
      : [],
  )
  const said = calls.findLast((part) => part.state.status === "settled" && part.state.outcome === "success")
  if (said === undefined) return null
  const decoded = safeDecode(acknowledgement, parse(said.input))
  return decoded.ok ? decoded.value : null
}

/**
 * Whether a call that can change files ran after `seq`, going by the effect
 * class each tool has in this build. The stand-in for a snapshot diff in a
 * session that has no snapshots: it cannot say which files, only that some may have changed.
 */
export function ranSideEffectsSince(projection: Projection, seq: number, effects: ReadonlyMap<string, ToolEffect>): boolean {
  return projection.messages.some(
    (message) =>
      message.kind === "assistant" &&
      message.seq > seq &&
      message.parts.some((part) => {
        if (part.type !== "tool_call" || part.state.status === "pending") return false
        if (part.state.status === "running") return hasSideEffect(part.state.effect)
        const effect = effects.get(part.name)
        return part.state.outcome !== "not_started" && effect !== undefined && hasSideEffect(effect)
      }),
  )
}

/**
 * Whether the turn in progress did work: one of its tool calls has its
 * result. A call that never began (stopped before it started) is none.
 */
export function workedThisTurn(projection: Projection): boolean {
  return currentTurn(projection).some(
    (message) => message.kind === "assistant" && message.parts.some((part) => part.type === "tool_call" && part.state.status === "settled" && part.state.outcome !== "not_started"),
  )
}

/** Whether a response says nothing: no tool call and no text but whitespace. Reasoning alone is not an answer. */
export function saysNothing(message: AssistantMessage): boolean {
  return message.parts.every((part) => part.type === "reasoning" || (part.type === "text" && part.text.trim() === ""))
}

function parse(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}
