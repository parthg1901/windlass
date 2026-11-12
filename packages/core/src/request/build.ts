/**
 * The request builder: projected session state -> `ModelRequest`.
 *
 * SINGLE-OWNER FILE. This is the only code that decides what the model sees.
 *
 * It is a pure function of stored state: no clock, no filesystem, no
 * environment, no randomness, no memory between calls. Building the same
 * state twice gives byte-identical canonical JSON, in this process or another.
 *
 * The provider's prompt cache is an append-only log, so the property this
 * file exists to keep is: the request built after any appended event is the
 * request built before it plus appended items. It holds because
 *
 * - a message renders from its own stored fields only, never from its
 *   neighbours, its position or the time;
 * - a message that is still `running` renders nothing, so a request built
 *   while a step is open equals the request that step was sent, and a message
 *   renders for the first time when it is terminal and can no longer change;
 * - messages enter history only at the end (`seq` order), and the baseline
 *   (instructions and tools) is copied as stored, in stored order.
 *
 * The only events after which the next request may not extend the previous
 * one are `compaction.ended` (with the `baseline.set` that follows it),
 * `history.reverted`, `step.refused` and `settings.changed`; see
 * `build-break.ts`. A checkpoint is frozen text and the messages a compaction
 * keeps render exactly as they did before it, so the request after the first
 * one that follows a compaction extends it like any other.
 *
 * The `params` block comes from stored state too: `model` and
 * `reasoningEffort` are the session's settings (`session.created`,
 * `settings.changed`) and the cache key is the root session's ID. A caller cannot
 * pass another model, so the first block changes only when the log says so.
 *
 * Nothing is repaired here. The log settles every tool call before its step
 * ends, so a closed message is rendered as stored; state that the reducer
 * cannot produce (a closed message with an unsettled call) throws
 * `RequestBuildError` instead of being papered over.
 *
 * ## What the model sees
 *
 * | Stored                                   | Rendered as |
 * | ---------------------------------------- | ----------- |
 * | baseline `instructions`                  | `instructions`, verbatim |
 * | baseline `tools`                         | `tools`, verbatim, in the frozen order |
 * | user message                             | `user` message, content verbatim |
 * | synthetic message (any origin, appended or delivered from the inbox, including the interrupt marker) | `user` message wrapped in `<harness origin="…">` … `</harness>` |
 * | instruction message                      | `developer` message, text verbatim; dropped when it is older than the baseline in force |
 * | compaction checkpoint                    | first item: `user` message, the checkpoint text wrapped in `<harness origin="compaction">`; then the kept messages by these same rules |
 * | assistant, `running` or `refused`        | nothing |
 * | assistant text part                      | `assistant_text` |
 * | assistant reasoning part                 | `reasoning`, or nothing (rules below) |
 * | assistant tool call part                 | `tool_call`, argument text verbatim |
 * | settled tool call, every outcome         | `tool_result` with the stored output and attachments, byte for byte |
 * | excluded (reverted or refused) messages  | nothing (`selectModelHistory` leaves them out) |
 *
 * Roles. `developer` is the role with the harness's authority, so it is used
 * only for instruction messages, whose text the instructions module wrote.
 * Synthetic messages and the checkpoint often carry text the harness did not
 * write (the output of a background command, a model-written summary); giving
 * that text instruction authority would be a prompt-injection path, so they
 * are `user` messages inside an envelope that says the harness, not the user,
 * is speaking. The envelope is a constant function of the stored origin.
 *
 * One assistant message is one model response. Its parts are emitted in
 * stored order, then one `tool_result` per call in call order (not settle
 * order): calls, then outputs, which is the shape the provider itself
 * produced the step in. Call IDs are sent as the provider issued them; a
 * provider may reuse an ID in a later step, and each call still sits directly
 * before its own result.
 *
 * Tool results. The outcome (`success`, `error`, `not_started`,
 * `effect_unknown`) has no field on the wire: the stored output text already
 * says what happened, including the text that explains a call that never
 * started or whose effect is unknown, and it is replayed unchanged.
 *
 * Reasoning is replayed only when all of these hold; otherwise the part is
 * dropped, which the provider accepts (replay is optional):
 * - the message is `completed` (a failed step's reasoning may be cut mid-item);
 * - the message was produced by the model the request is for (the payload is
 *   encrypted for that model);
 * - the part carries `providerData` (without it there is nothing to replay);
 * - a later part of the same message is rendered. The provider rejects a
 *   reasoning item with no output item after it, so a message never ends in one.
 *
 * `providerData` of text and tool-call parts is replayed to the model that
 * produced it and sent as `null` to any other model.
 *
 * Failed assistant messages (provider failure, interruption, crash) keep what
 * they produced: text, tool calls and their results, with reasoning dropped.
 * A call that never started is shown with its stored `not_started` result, so
 * the model knows it asked and that nothing happened. A message that failed
 * before any output renders nothing; when the step continues under a new
 * message, that message's output simply follows.
 *
 * Text that is empty or only whitespace says nothing and is never sent: such
 * text parts are skipped, and a message left with no content is skipped.
 */
import { type Content, text } from "../content.ts"
import type { MessageId } from "../id.ts"
import { type ModelHistory, selectModelHistory } from "../message/history.ts"
import type { AssistantMessage, Message, Projection } from "../message/message.ts"
import type { InputItem, ModelRequest, RequestParams } from "./request.ts"

/**
 * Call settings that are not stored per session, because they are the same
 * for every request a build of the harness sends. Changing one changes the
 * `params` block of every session, so they are constants, not knobs.
 */
export interface CallOptions {
  /** Provider-interpreted output verbosity. Defaults to `null`, the model's default. */
  readonly textVerbosity?: string | null
  /** Defaults to `true`. */
  readonly parallelToolCalls?: boolean
  /**
   * The prompt-cache routing key. Defaults to the ID of the root of the
   * session's fork chain, so a fork shares its parent's cached prefix; `null` sends none.
   */
  readonly cacheKey?: string | null
}

export interface BuildOptions extends CallOptions {
  readonly toolChoice: ModelRequest["toolChoice"]
}

/** The `params` block of a session's next request: its stored settings plus the harness-wide call options. */
export function requestParams(history: Pick<ModelHistory, "rootId" | "settings">, options: CallOptions = {}): RequestParams {
  return {
    model: history.settings.model,
    reasoningEffort: history.settings.reasoningEffort,
    textVerbosity: options.textVerbosity ?? null,
    parallelToolCalls: options.parallelToolCalls ?? true,
    cacheKey: options.cacheKey === undefined ? history.rootId : options.cacheKey,
  }
}

export type RequestBuildErrorCode =
  /** No `baseline.set` has been recorded, so there are no instructions and no tool list to send. */
  | "no_baseline"
  /** A closed assistant message has a tool call without a result. The reducer never produces this. */
  | "unsettled_call"
  /** The compaction that history starts from has no summary. The reducer never produces this. */
  | "checkpoint_without_summary"
  /** A summary request was asked for and no compaction is open (or the one named does not exist). */
  | "no_compaction"

/** The stored state cannot be rendered as a valid request. Nothing is sent. */
export class RequestBuildError extends Error {
  constructor(
    readonly code: RequestBuildErrorCode,
    detail: string,
  ) {
    super(`cannot build the request: ${detail}`)
    this.name = "RequestBuildError"
  }
}

/** Builds the request for the next model call of a session. */
export function buildRequest(projection: Projection, options: BuildOptions): ModelRequest {
  return buildRequestFromHistory(selectModelHistory(projection), options)
}

/** `buildRequest` for a caller that already selected the model's view, for example with SQL. */
export function buildRequestFromHistory(history: ModelHistory, options: BuildOptions): ModelRequest {
  const baseline = history.baseline
  if (baseline === null) throw new RequestBuildError("no_baseline", "the session has no baseline.set event yet")
  const context = { model: history.settings.model, baselineSeq: baseline.seq }
  return {
    // Built field by field so that an extra property on the caller's object never reaches a block hash.
    params: requestParams(history, options),
    tools: baseline.tools,
    instructions: baseline.instructions,
    input: history.messages.flatMap((message) => renderMessage(message, context)),
    toolChoice: options.toolChoice,
  }
}

/**
 * The summary request of a compaction: the step request of the part before
 * the cut plus one prompt (context rule 7), with the tool list kept and tool
 * calls switched off. Because it is that step request plus appended items, it
 * reads the part it summarises from the provider's cache.
 *
 * Like every request it is a pure function of stored state. The cut, the
 * prompt and, when the first answer was rejected, that answer with the
 * follow-up prompt are fields of the compaction message (`compaction.started`
 * and `compaction.repair_requested` froze them), so the request of any
 * attempt can be rebuilt from the log: fold it to the event that began the
 * attempt, and build. `projection` is the state while the compaction is
 * open; `messageId` says which one is meant, and must be that one.
 */
export function buildCompactionRequest(projection: Projection, options: CallOptions = {}, messageId?: MessageId): ModelRequest {
  const open = projection.session.open
  const id = messageId ?? (open?.kind === "compaction" ? open.messageId : undefined)
  const compaction = id === undefined ? undefined : projection.messages.findLast((message) => message.id === id)
  // Only while it is open: once it has ended, the view starts from its own checkpoint.
  if (compaction?.kind !== "compaction" || compaction.status !== "running")
    throw new RequestBuildError("no_compaction", id === undefined ? "no compaction is open" : `compaction ${id} is not open`)
  // What the model saw before the cut. Checkpoints stay in the list: the view may start from an earlier one.
  const older = { ...projection, messages: projection.messages.filter((message) => message.seq < compaction.keepFromSeq || message.kind === "compaction") }
  const request = buildRequest(older, { ...options, toolChoice: "none" })
  const developer = (value: string): InputItem => ({ type: "message", role: "developer", content: text(value) })
  const repair: InputItem[] =
    compaction.repair === null ? [] : [{ type: "assistant_text", text: compaction.repair.answer, providerData: null }, developer(compaction.repair.prompt)]
  return { ...request, input: [...request.input, developer(compaction.prompt), ...repair] }
}

export interface RenderContext {
  /** The model the request is for. */
  readonly model: string
  /** `seq` of the baseline in force. */
  readonly baselineSeq: number
}

/** The input items one model-visible message becomes. See the table at the top of this file. */
export function renderMessage(message: Message, context: RenderContext): InputItem[] {
  switch (message.kind) {
    case "user": {
      const content = spoken(message.content)
      return content.length === 0 ? [] : [{ type: "message", role: "user", content }]
    }
    case "synthetic":
      return harnessMessage(message.origin, message.content)
    case "instruction":
      // A baseline set after this message was built from newer sources and already says what it said.
      if (message.seq < context.baselineSeq || blank(message.text)) return []
      return [{ type: "message", role: "developer", content: text(message.text) }]
    case "assistant":
      return renderAssistant(message, context.model)
    case "compaction":
      if (message.status !== "completed") return []
      if (message.summary === null)
        throw new RequestBuildError("checkpoint_without_summary", `compaction ${message.id} is completed without a summary`)
      return harnessMessage(CHECKPOINT_ORIGIN, text(message.summary))
    default:
      return message satisfies never
  }
}

/** The `origin` under which the compaction checkpoint is shown to the model. */
export const CHECKPOINT_ORIGIN = "compaction"

/** The first line of a harness message. The base system prompt explains it to the model. */
export function harnessOpen(origin: string) {
  return `<harness origin="${origin}">`
}

/** The last line of a harness message. */
export const HARNESS_CLOSE = "</harness>"

function renderAssistant(message: AssistantMessage, model: string): InputItem[] {
  if (message.status === "running" || message.status === "refused") return []
  const sameModel = message.model === model
  const lastOutput = message.parts.findLastIndex(
    (part) => part.type === "tool_call" || (part.type === "text" && !blank(part.text)),
  )
  const output = message.parts.flatMap((part, index): InputItem[] => {
    switch (part.type) {
      case "text":
        if (blank(part.text)) return []
        return [{ type: "assistant_text", text: part.text, providerData: sameModel ? part.providerData : null }]
      case "reasoning":
        if (message.status !== "completed" || !sameModel || part.providerData === null || index > lastOutput) return []
        return [{ type: "reasoning", text: part.text, providerData: part.providerData }]
      case "tool_call":
        return [
          {
            type: "tool_call",
            callId: part.callId,
            name: part.name,
            input: part.input,
            providerData: sameModel ? part.providerData : null,
          },
        ]
    }
  })
  const results = message.parts.flatMap((part): InputItem[] => {
    if (part.type !== "tool_call") return []
    if (part.state.status !== "settled")
      throw new RequestBuildError(
        "unsettled_call",
        `tool call ${part.callId} of ${message.status} message ${message.id} is ${part.state.status}`,
      )
    return [{ type: "tool_result", callId: part.callId, output: part.state.output, attachments: part.state.attachments }]
  })
  return [...output, ...results]
}

/**
 * A message from the harness, in the `user` role. The envelope lines are
 * joined to the first and last text part, or sent as their own part next to media.
 */
function harnessMessage(origin: string, content: Content): InputItem[] {
  const parts = spoken(content)
  const first = parts[0]
  if (first === undefined) return []
  const open = `${harnessOpen(origin)}\n`
  const opened: Content =
    first.type === "text" ? [{ type: "text", text: open + first.text }, ...parts.slice(1)] : [...text(open), ...parts]
  const last = opened[opened.length - 1]!
  const close = `\n${HARNESS_CLOSE}`
  const closed: Content =
    last.type === "text" ? [...opened.slice(0, -1), { type: "text", text: last.text + close }] : [...opened, ...text(close)]
  return [{ type: "message", role: "user", content: closed }]
}

/** Content without the text parts that say nothing. */
function spoken(content: Content): Content {
  return content.filter((part) => part.type !== "text" || !blank(part.text))
}

function blank(value: string) {
  return value.trim() === ""
}
