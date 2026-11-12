/**
 * Turns one session's harness events into what an ACP v1 client is sent.
 * The same translator serves live events and the replay of the stored log on
 * `session/load`: a replay is the durable events alone, without the streaming
 * deltas, so each item arrives whole.
 *
 * IDs are derived from the log, so they are the same live and on replay:
 * - a user message keeps the harness message ID;
 * - agent text and reasoning are one ACP message per text or reasoning item:
 *   `<messageId>:t<n>` and `<messageId>:r<n>`. A harness message that writes
 *   text, calls tools, then writes more text becomes two ACP messages around
 *   the tool calls, so the client shows them in the order they happened;
 * - a tool call is `<messageId>/<callId>`, because providers reuse call IDs
 *   across steps.
 *
 * Mapping decisions worth knowing:
 * - v1 tool statuses have no "cancelled" or "unknown": `not_started` and
 *   `effect_unknown` settle as `failed`, with the title suffixed, a sentence
 *   saying what happened, and the outcome in `_meta`.
 * - The stop reason comes from how the execution ended: `end_turn`;
 *   `max_turn_requests` when the step limit was reached; `max_tokens` when the
 *   last response hit the output limit; `refusal` when the provider refused;
 *   `cancelled` for a user interrupt (and for a shutdown, should a client
 *   still be listening). A failure is not a stop reason in v1: the prompt
 *   request is answered with an error carrying the harness's sentence.
 * - Unknown event types are ignored with a debug line: the event schema is
 *   still growing.
 */
import type { SessionUpdate, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk"
import type { EngineEvent, EventData, ProviderError, SessionSettings, StoredEvent, Usage } from "@windlass/core"
import { HARNESS_ORIGIN } from "@windlass/core"
import { EXT, META, type StateNotification, type TurnNotification, type UsageNotification } from "./extensions.ts"
import type { Logger } from "./log.ts"
import { outcomeSuffix, parseInput, progressContent, rawInput, settledContent, toolKind, toolLocations, toolTitle } from "./tools.ts"

/** How an execution ended, for the prompt requests waiting on it. */
export type TurnEnd = (
  | { readonly kind: "stop"; readonly stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" }
  | { readonly kind: "failed"; readonly message: string; readonly providerError: ProviderError | null; readonly approvalRequired?: true }
) & {
  /** What `<prefix>/turn` says about it, for the `_meta` of the prompt response. */
  readonly turn?: TurnNotification
}

export type Output =
  | { readonly type: "update"; readonly update: SessionUpdate }
  | { readonly type: "ext"; readonly method: string; readonly params: Record<string, unknown> }
  /** An inbox item became a message. */
  | { readonly type: "delivered"; readonly messageId: string }
  /** The execution ended. */
  | { readonly type: "end"; readonly end: TurnEnd }
  /** The model or effort changed. */
  | { readonly type: "settings"; readonly settings: SessionSettings }

export interface TranslatorOptions {
  readonly sessionId: string
  readonly cwd: string
  readonly log: Logger
  /** Whether the client presents `notice` updates (`clientCapabilities.session.notices`). */
  readonly notices: boolean
  /** Whether the client understands `compaction_update` (`clientCapabilities.session.compaction`). */
  readonly compaction: boolean
  /** The context window of a model, when known, for `usage_update`. */
  readonly contextWindow: (model: string) => number | null
  /** Whether a delivered user message is shown to the client: true for input the client did not send as a prompt. */
  readonly echo: (messageId: string) => boolean
  /** On a replay: the files an ended turn changed, worked out from its snapshots, or `null` when they cannot be told. */
  readonly replayedChanges?: (executionId: string) => readonly string[] | null
}

interface ToolState {
  readonly id: string
  readonly name: string
  args: Record<string, unknown> | null
  created: boolean
  final: boolean
}

interface MessageParts {
  textIndex: number
  /** What was streamed of the current text item, or `null` when none is open. */
  text: string | null
  reasoningIndex: number
  reasoning: string | null
}

export class Translator {
  private readonly parts = new Map<string, MessageParts>()
  private readonly tools = new Map<string, ToolState>()
  private readonly inbox = new Map<string, { readonly text: string; readonly origin: string | null }>()
  private model: string | null = null
  private turn = freshTurn()

  constructor(private readonly options: TranslatorOptions) {}

  /** The current model, as the log says (`session.created`, `settings.changed`). */
  get currentModel(): string | null {
    return this.model
  }

  /**
   * Translates one event. `replay` is set for events read back from the log on
   * `session/load`: live-only output (usage notifications, notices, state) is left out.
   */
  translate(item: EngineEvent, replay = false): Output[] {
    const out: Output[] = []
    const update = (value: SessionUpdate) => out.push({ type: "update", update: value })
    switch (item.type) {
      // ---- streaming deltas ----
      case "text.delta": {
        const parts = this.partsOf(item.messageId)
        parts.text = (parts.text ?? "") + item.text
        if (item.text !== "") update({ sessionUpdate: "agent_message_chunk", messageId: `${item.messageId}:t${parts.textIndex}`, content: { type: "text", text: item.text } })
        break
      }
      case "reasoning.delta": {
        const parts = this.partsOf(item.messageId)
        parts.reasoning = (parts.reasoning ?? "") + item.text
        if (item.text !== "")
          update({ sessionUpdate: "agent_thought_chunk", messageId: `${item.messageId}:r${parts.reasoningIndex}`, content: { type: "text", text: item.text } })
        break
      }
      case "tool.input.delta": {
        const tool = this.toolOf(item.messageId, item.callId, item.name)
        if (!tool.created) {
          tool.created = true
          update({ sessionUpdate: "tool_call", toolCallId: tool.id, title: toolTitle(tool.name, null), kind: toolKind(tool.name), status: "pending" })
        }
        break
      }
      case "tool.progress": {
        const tool = this.tools.get(toolKey(item.messageId, item.callId))
        if (tool !== undefined && !tool.final) update({ sessionUpdate: "tool_call_update", toolCallId: tool.id, content: progressContent(tool.name, item.text) })
        break
      }

      // ---- durable events ----
      case "session.created":
        this.model = item.data.settings.model
        break
      case "settings.changed":
        this.model = item.data.model
        out.push({ type: "settings", settings: item.data })
        break
      case "session.renamed":
        update({ sessionUpdate: "session_info_update", title: item.data.title, updatedAt: new Date(item.time).toISOString() })
        break
      case "inbox.enqueued":
        this.inbox.set(item.data.messageId, { text: contentText(item.data.content), origin: item.data.origin })
        break
      case "inbox.cancelled":
        this.inbox.delete(item.data.messageId)
        break
      case "inbox.delivered": {
        const waiting = this.inbox.get(item.data.messageId)
        this.inbox.delete(item.data.messageId)
        out.push({ type: "delivered", messageId: item.data.messageId })
        if (waiting !== undefined && waiting.origin === null && (replay || this.options.echo(item.data.messageId)))
          update({ sessionUpdate: "user_message_chunk", messageId: item.data.messageId, content: { type: "text", text: waiting.text } })
        break
      }
      case "synthetic.appended":
        if (item.data.origin === HARNESS_ORIGIN.stepLimit) this.turn.stepLimit = true
        break
      case "execution.started":
      case "execution.resumed":
        this.turn = freshTurn()
        this.turn.executionId = item.data.executionId
        if (!replay) out.push(this.state({ sessionId: this.options.sessionId, state: "running" }))
        break
      case "execution.succeeded": {
        const verification = item.data.verification
        const outcome = verification.status === "unresolved" ? "unresolved" : "succeeded"
        out.push(...this.finishTools(update), ...this.end({ kind: "stop", stopReason: this.successReason() }, replay, { executionId: item.data.executionId, outcome, verification }))
        break
      }
      case "turn.ended": {
        // A queued message was waiting for this turn's answer: the turn ends here and the execution carries on with it.
        const verification = item.data.verification
        const params: TurnNotification = {
          sessionId: this.options.sessionId,
          executionId: this.turn.executionId ?? "",
          outcome: verification.status === "unresolved" ? "unresolved" : "succeeded",
          stopReason: this.successReason(),
          verification,
          changedFiles: replay ? null : this.turn.changedFiles,
          continues: true,
          ...(replay ? { replay: true } : {}),
        }
        this.turn.changedFiles = null
        out.push({ type: "ext", method: EXT.turn, params: { ...params } })
        break
      }
      case "execution.failed": {
        const end: TurnEnd = this.turn.refused
          ? { kind: "stop", stopReason: "refusal" }
          : this.turn.stepLimit
            ? { kind: "stop", stopReason: "max_turn_requests" }
            : { kind: "failed", message: item.data.message, providerError: this.turn.providerError, ...(item.data.cause === "approval" ? { approvalRequired: true as const } : {}) }
        out.push(...this.finishTools(update), ...this.end(end, replay, { executionId: item.data.executionId, outcome: "failed", message: item.data.message }))
        break
      }
      case "execution.interrupted":
        out.push(
          ...this.finishTools(update),
          ...this.end({ kind: "stop", stopReason: "cancelled" }, replay, { executionId: item.data.executionId, outcome: "interrupted", reason: item.data.reason }),
        )
        break
      case "step.started":
        this.model = item.data.model
        this.turn.providerError = null
        // A retry before any durable output streams the response again: what the client already has of the
        // abandoned attempt stays, and the new attempt goes to a new ACP message instead of being appended to it.
        this.restartOpenItems(item.data.messageId)
        break
      case "step.ended":
        this.turn.lastFinish = item.data.finish
        this.turn.refused = false
        out.push(...this.usage(item.data.messageId, item.data.usage, replay))
        break
      case "step.failed":
        if (item.data.error.kind === "provider") this.turn.providerError = item.data.error.error
        out.push(...this.usage(item.data.messageId, item.data.usage, replay))
        break
      case "step.refused":
        this.turn.refused = true
        update({
          sessionUpdate: "agent_message_chunk",
          messageId: `${item.data.messageId}:refusal`,
          content: { type: "text", text: item.data.message === "" ? "(The provider refused to answer.)" : item.data.message },
        })
        out.push(...this.usage(item.data.messageId, item.data.usage, replay))
        break
      case "retry.scheduled":
        if (!replay && this.options.notices)
          update({
            sessionUpdate: "notice",
            severity: "warning",
            title: `The model call failed; retrying in ${seconds(item.data.delayMs)} (attempt ${item.data.attempt})`,
            description: item.data.error.message,
          })
        break
      case "text.ended":
        this.endItem(item.data.messageId, "text", item.data.text, update)
        break
      case "reasoning.ended":
        this.endItem(item.data.messageId, "reasoning", item.data.text, update)
        break
      case "tool.called": {
        const tool = this.toolOf(item.data.messageId, item.data.callId, item.data.name)
        tool.args = parseInput(item.data.input)
        const fields = {
          toolCallId: tool.id,
          title: toolTitle(tool.name, tool.args),
          kind: toolKind(tool.name),
          status: "pending" as const,
          rawInput: rawInput(item.data.input),
          locations: toolLocations(tool.name, tool.args, this.options.cwd),
        }
        update(tool.created ? { sessionUpdate: "tool_call_update", ...fields } : { sessionUpdate: "tool_call", ...fields })
        tool.created = true
        break
      }
      case "tool.started": {
        const tool = this.tools.get(toolKey(item.data.messageId, item.data.callId))
        if (tool !== undefined) update({ sessionUpdate: "tool_call_update", toolCallId: tool.id, status: "in_progress" })
        break
      }
      case "tool.settled": {
        const tool = this.tools.get(toolKey(item.data.messageId, item.data.callId))
        if (tool === undefined) {
          this.options.log.debug(`settled call ${item.data.callId} was never called; ignored`)
          break
        }
        update(this.settled(tool, item.data))
        break
      }
      case "compaction.started":
        if (this.options.compaction) update({ sessionUpdate: "compaction_update", compactionId: item.data.messageId, status: "in_progress" })
        break
      case "compaction.ended":
        if (this.options.compaction)
          update({ sessionUpdate: "compaction_update", compactionId: item.data.messageId, status: "completed", summary: [{ type: "text", text: item.data.summary }] })
        out.push(...this.usage(item.data.messageId, item.data.usage, replay))
        break
      case "compaction.failed":
        if (this.options.compaction)
          update({
            sessionUpdate: "compaction_update",
            compactionId: item.data.messageId,
            status: item.data.error.kind === "interrupted" ? "cancelled" : "failed",
            error: stepErrorText(item.data.error),
          })
        break
      case "workspace.changes":
        this.turn.changedFiles = [...item.files]
        break
      case "diagnostic":
        out.push({ type: "ext", method: EXT.diagnostic, params: { sessionId: this.options.sessionId, kind: item.kind, message: item.message } })
        if (this.options.notices) update({ sessionUpdate: "notice", severity: "error", title: `Internal problem (${item.kind.replace(/_/g, " ")})`, description: item.message })
        break
      // ---- approval ----
      // The question itself is put by the server as `session/request_permission` (live only). What is shown here is
      // the call's state: waiting, and for a full replay the answer it got.
      case "approval.requested": {
        const tool = this.tools.get(toolKey(item.data.messageId, item.data.callId))
        if (tool !== undefined && !replay) update({ sessionUpdate: "tool_call_update", toolCallId: tool.id, status: "pending", title: `${toolTitle(tool.name, tool.args)} (waiting for approval)` })
        break
      }
      case "approval.answered": {
        const tool = this.tools.get(toolKey(item.data.messageId, item.data.callId))
        if (tool !== undefined && !replay) update({ sessionUpdate: "tool_call_update", toolCallId: tool.id, status: "pending", title: toolTitle(tool.name, tool.args) })
        break
      }
      // A denial is the call's own result (`tool.settled` follows in the same append).
      case "approval.denied":
        break
      case "taint.noticed":
        out.push({ type: "ext", method: EXT.taint, params: { sessionId: this.options.sessionId, tainted: true, text: item.data.text, source: item.data.source, ...(replay ? { replay: true } : {}) } })
        if (!replay && this.options.notices)
          update({ sessionUpdate: "notice", severity: "warning", title: "Untrusted content is in this conversation", description: `${item.data.text} Anything that can send data out asks again from here on.` })
        break
      case "taint.cleared":
        out.push({ type: "ext", method: EXT.taint, params: { sessionId: this.options.sessionId, tainted: false, ...(replay ? { replay: true } : {}) } })
        break
      case "notice":
        out.push({ type: "ext", method: EXT.notice, params: { sessionId: this.options.sessionId, kind: item.kind, message: item.message } })
        if (this.options.notices) update({ sessionUpdate: "notice", severity: "warning", title: noticeTitle(item.kind), description: item.message })
        break
      // Facts with nothing to show: the frozen prompt, instruction updates, the claim's bookkeeping, history ranges.
      case "baseline.set":
      case "instruction.appended":
      case "inbox.delivery_changed":
      case "execution.interrupt_requested":
      case "session.archived":
      case "session.unarchived":
      case "history.reverted":
      // A subagent's events: the server forwards them on their own (`<prefix>/child`) and puts its questions.
      case "child.event":
        break
      default:
        this.options.log.debug(`event type ${(item as { type: string }).type} is not translated; ignored`)
    }
    return out
  }

  /** Every durable event of a stored log, translated for `session/load`. */
  replay(events: readonly StoredEvent[]): Output[] {
    return events.flatMap((item) => this.translate(item, true))
  }

  /** The tool calls the translator has seen that have not settled. */
  get unsettledTools(): number {
    return [...this.tools.values()].filter((tool) => !tool.final).length
  }

  private settled(tool: ToolState, data: EventData<"tool.settled">): SessionUpdate {
    tool.final = true
    const shown = settledContent(tool.name, tool.args, data, this.options.cwd)
    const suffix = outcomeSuffix(data.outcome)
    const rawOutput: Record<string, unknown> = { outcome: data.outcome, output: data.output }
    if (data.display !== null) rawOutput.display = data.display
    if (data.truncation !== null) rawOutput.truncation = data.truncation
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: tool.id,
      status: data.outcome === "success" ? "completed" : "failed",
      ...(suffix === null ? {} : { title: `${toolTitle(tool.name, tool.args)} (${suffix})` }),
      content: shown.content satisfies ToolCallContent[],
      ...(shown.locations === null ? {} : { locations: shown.locations satisfies ToolCallLocation[] }),
      rawOutput,
      _meta: { [META.outcome]: data.outcome },
    }
  }

  /** The loop settles every call before a turn ends; a call it did not is given a final status here rather than left spinning. */
  private finishTools(update: (value: SessionUpdate) => void): Output[] {
    for (const tool of this.tools.values()) {
      if (tool.final) continue
      tool.final = true
      if (tool.created) update({ sessionUpdate: "tool_call_update", toolCallId: tool.id, status: "failed" })
    }
    return []
  }

  private end(
    end: TurnEnd,
    replay: boolean,
    details: Pick<TurnNotification, "executionId" | "outcome" | "verification" | "message" | "reason">,
  ): Output[] {
    const turn: TurnNotification = {
      sessionId: this.options.sessionId,
      ...details,
      stopReason: end.kind === "stop" ? end.stopReason : "error",
      changedFiles: replay ? (this.options.replayedChanges?.(details.executionId) ?? null) : this.turn.changedFiles,
      ...(replay ? { replay: true } : {}),
    }
    const out: Output[] = [{ type: "ext", method: EXT.turn, params: { ...turn } }]
    if (!replay)
      out.push(
        this.state({
          sessionId: this.options.sessionId,
          state: "idle",
          stopReason: end.kind === "stop" ? end.stopReason : "error",
          ...(end.kind === "failed" ? { message: end.message } : {}),
        }),
      )
    // Last, so that the prompts it answers are answered after everything it says.
    out.push({ type: "end", end: { ...end, turn } })
    return out
  }

  private successReason(): "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" {
    if (this.turn.refused) return "refusal"
    if (this.turn.stepLimit) return "max_turn_requests"
    if (this.turn.lastFinish === "length") return "max_tokens"
    return "end_turn"
  }

  private usage(messageId: string, usage: Usage | null, replay: boolean): Output[] {
    if (usage === null || replay) return []
    const params: UsageNotification = { sessionId: this.options.sessionId, messageId, model: this.model, usage }
    const out: Output[] = [{ type: "ext", method: EXT.usage, params: { ...params } }]
    const size = this.model === null ? null : this.options.contextWindow(this.model)
    if (size !== null) out.push({ type: "update", update: { sessionUpdate: "usage_update", used: usage.inputTokens + usage.outputTokens, size } })
    return out
  }

  private state(params: StateNotification): Output {
    return { type: "ext", method: EXT.state, params: { ...params } }
  }

  private endItem(messageId: string, kind: "text" | "reasoning", whole: string, update: (value: SessionUpdate) => void): void {
    const parts = this.partsOf(messageId)
    const streamed = (kind === "text" ? parts.text : parts.reasoning) ?? ""
    const id = kind === "text" ? `${messageId}:t${parts.textIndex}` : `${messageId}:r${parts.reasoningIndex}`
    const sessionUpdate = kind === "text" ? "agent_message_chunk" : "agent_thought_chunk"
    // The ended item carries the whole value; send what the deltas did not (all of it on replay).
    if (whole.startsWith(streamed)) {
      const rest = whole.slice(streamed.length)
      if (rest !== "") update({ sessionUpdate, messageId: id, content: { type: "text", text: rest } })
    } else this.options.log.debug(`the streamed ${kind} of ${messageId} differs from its final value; the client keeps the streamed text`)
    if (kind === "text") {
      parts.text = null
      parts.textIndex += 1
    } else {
      parts.reasoning = null
      parts.reasoningIndex += 1
    }
  }

  private restartOpenItems(messageId: string): void {
    const parts = this.parts.get(messageId)
    if (parts === undefined) return
    if (parts.text !== null) {
      parts.text = null
      parts.textIndex += 1
    }
    if (parts.reasoning !== null) {
      parts.reasoning = null
      parts.reasoningIndex += 1
    }
  }

  private partsOf(messageId: string): MessageParts {
    let parts = this.parts.get(messageId)
    if (parts === undefined) {
      parts = { textIndex: 0, text: null, reasoningIndex: 0, reasoning: null }
      this.parts.set(messageId, parts)
    }
    return parts
  }

  private toolOf(messageId: string, callId: string, name: string): ToolState {
    const key = toolKey(messageId, callId)
    let tool = this.tools.get(key)
    if (tool === undefined) {
      tool = { id: key, name, args: null, created: false, final: false }
      this.tools.set(key, tool)
    }
    return tool
  }
}

function freshTurn() {
  return {
    executionId: null as string | null,
    changedFiles: null as string[] | null,
    stepLimit: false,
    refused: false,
    lastFinish: null as EventData<"step.ended">["finish"] | null,
    providerError: null as ProviderError | null,
  }
}

function toolKey(messageId: string, callId: string): string {
  return `${messageId}/${callId}`
}

function contentText(content: EventData<"inbox.enqueued">["content"]): string {
  return content.map((part) => (part.type === "text" ? part.text : `[${part.blob.mediaType}]`)).join("")
}

function seconds(ms: number): string {
  const value = Math.max(1, Math.round(ms / 1000))
  return `${value} ${value === 1 ? "second" : "seconds"}`
}

function stepErrorText(error: EventData<"step.failed">["error"]): string {
  switch (error.kind) {
    case "provider":
      return error.error.message
    case "interrupted":
      return error.reason === "user" ? "stopped by the user" : "stopped by a shutdown"
    case "crashed":
      return "cut short by a restart"
    case "internal":
      return error.message
  }
}

function noticeTitle(kind: "sandbox_unavailable" | "approval_ignored" | "checks_not_run" | "no_closing_answer"): string {
  if (kind === "no_closing_answer") return "The model gave no closing answer"
  if (kind === "sandbox_unavailable") return "Commands cannot be sandboxed on this machine"
  if (kind === "approval_ignored") return "A project setting was not followed"
  return "The project's checks were not run"
}
