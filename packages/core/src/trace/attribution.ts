/**
 * Per-step attribution: for every model call of a session, which blocks of
 * its request the model had not been sent before, what they were, and what
 * the model then did.
 *
 * It answers two questions that the trace alone does not:
 * - "what did the model see for the first time right before it did X": the
 *   blocks that were not in the request of its previous step (a user
 *   message, a tool result, an instruction update, a harness note, a
 *   checkpoint), next to the text and the tool calls it answered with. This
 *   is where one looks when a prompt or instruction change alters behaviour.
 * - "what was paid for at full price in this call": the new blocks with their
 *   sizes, next to the provider's usage (input, cached, the cached share).
 *
 * It is a pure function of what the trace exporter rebuilds from (`export.ts`):
 * the log and the request ledger. The comparison itself uses only the ledger,
 * which holds the block hashes of exactly what was sent. To say what a block
 * was, the request is rebuilt from the log folded to the event that started
 * the call (the same start points as the exporter), its hashes are checked
 * against the ledger row, and each input item is traced back to the stored
 * message it renders. A row whose rebuild does not match is still compared,
 * by the ledger's hashes, and its blocks are named only by their kind.
 *
 * What a call is compared with. A step call is compared with the previous
 * step call, or with the previous attempt of its own message: a compaction's
 * summary call in between is a separate conversation with the provider and
 * says nothing about what the model has seen while working. A summary call
 * is compared with the previous attempt of its own compaction, else with the
 * step call before it.
 *
 * When the request does not extend the one it is compared with, the prefix
 * was rebuilt. The causes are the legitimate breaks among the events in
 * between (`compaction.ended`, `history.reverted`, `step.refused`,
 * `settings.changed`; see `request/build-break.ts`), and for a summary call
 * that leaves the kept tail out, the summary itself. Then only the blocks
 * that were not anywhere in the earlier request are listed as new; the ones
 * that were (the instructions, the tools, the kept messages) are counted as
 * re-sent. A break with no cause is reported as `unexplained`: it is a bug.
 */
import type { StoredEvent } from "../event/durable.ts"
import { type ModelHistory, selectModelHistory } from "../message/history.ts"
import type { AssistantMessage, Message, Projection } from "../message/message.ts"
import { reduce } from "../message/reducer.ts"
import { type CallOptions, buildCompactionRequest, buildRequest, renderMessage, retiredNotes } from "../request/build.ts"
import { type PrefixBreakCause, prefixBreakCauses } from "../request/build-break.ts"
import { type BlockHash, comparePrefix, hashBlock, hashRequest } from "../request/prefix.ts"
import type { InputItem, ModelRequest } from "../request/request.ts"
import type { RequestRecord } from "../store/store.ts"

export interface AttributionOptions {
  /** The harness-wide call options the requests were built with. Defaults to the request builder's defaults. */
  readonly callOptions?: CallOptions
  /** Characters of text kept in a block's or an answer's `preview`. Default 80; 0 keeps none. */
  readonly previewChars?: number
}

/** What a block of a request is, as far as the model is concerned. */
export type BlockSource =
  /** The call parameters: model, effort, cache key. */
  | "params"
  /** One tool's specification. */
  | "tool"
  /** The frozen system prompt of the baseline. */
  | "instructions"
  /** A user message. */
  | "user"
  /** A harness note: a synthetic message (`origin` says from what), including the interrupt marker and check reports. */
  | "harness"
  /** An instruction update appended after the baseline (`source` says from which file or source). */
  | "instruction"
  /** A compaction checkpoint. */
  | "checkpoint"
  /** The model's own earlier output: text, reasoning or a tool call it made. */
  | "model_output"
  /** The result of a tool call (`tool` and `callId` say which). */
  | "tool_result"
  /** What a summary request appends: the compaction prompt, and with a repair the rejected answer and the follow-up. */
  | "compaction_prompt"
  /** An input item that could not be traced to a stored message (the rebuild did not match the ledger). */
  | "input"

export interface AttributedBlock {
  /** 0-based position in the request. */
  readonly index: number
  readonly source: BlockSource
  /** UTF-8 bytes of the block's canonical JSON, as the ledger stores them. */
  readonly bytes: number
  /** A short human description: `tool result read call_1`, `instruction update /repo/AGENTS.md`. */
  readonly label: string
  /** `seq` of the stored message it renders, when known. */
  readonly seq: number | null
  readonly tool?: string
  readonly callId?: string
  /** For `instruction`: the instruction source. For `harness`: the origin. */
  readonly origin?: string
  /** The first characters of its text, on one line. */
  readonly preview?: string
}

export interface SourceGroup {
  readonly source: BlockSource
  readonly count: number
  readonly bytes: number
}

export type PrefixStatus =
  /** The first call that is compared with nothing. Everything in it is new. */
  | { readonly status: "first" }
  /** The request is the earlier one plus `appended` blocks. */
  | { readonly status: "extension"; readonly kept: number; readonly appended: number }
  /**
   * The request does not extend the earlier one, for a stated reason. `kept`
   * blocks before `firstChanged` are unchanged; of the rest, `resent` blocks
   * (`resentBytes`) were in the earlier request somewhere and the others are new.
   */
  | {
      readonly status: "rebuilt"
      readonly causes: readonly RebuildCause[]
      readonly reasons: readonly string[]
      readonly firstChanged: { readonly index: number; readonly kind: BlockHash["kind"] }
      readonly kept: number
      readonly resent: number
      readonly resentBytes: number
    }
  /** The request does not extend the earlier one and nothing in the log explains it: a harness bug. */
  | {
      readonly status: "unexplained"
      readonly firstChanged: { readonly index: number; readonly kind: BlockHash["kind"] }
      readonly kept: number
      readonly resent: number
      readonly resentBytes: number
    }

export type RebuildCause = PrefixBreakCause | "summary"

/** What the model did with the call. */
export type CallAction =
  | {
      readonly kind: "step"
      /** The stored step's status (`completed`, `failed`, `refused`; `running` in a log that stops mid-step). */
      readonly status: AssistantMessage["status"]
      readonly finish: string | null
      readonly textChars: number
      readonly preview?: string
      readonly reasoning: number
      readonly toolCalls: readonly { readonly name: string; readonly callId: string; readonly outcome: string | null }[]
    }
  | { readonly kind: "summary"; readonly status: string; readonly source: string | null; readonly chars: number }
  /** A summary answer that was rejected; the next attempt carries it with the repair prompt. */
  | { readonly kind: "rejected_summary"; readonly chars: number }
  /** An attempt that produced nothing durable: the step went on under a later attempt. */
  | { readonly kind: "no_output"; readonly outcome: string | null; readonly errorKind: string | null }

export interface CallUsage {
  readonly input: number
  readonly cached: number
  readonly uncached: number
  /** `cached / input`, 0 when the input is 0. */
  readonly cachedShare: number
  readonly output: number
}

export interface CallAttribution {
  /** 1-based number of the call in the session's ledger. */
  readonly number: number
  readonly requestId: string
  readonly purpose: RequestRecord["purpose"]
  readonly messageId: string
  readonly attempt: number
  readonly outcome: RequestRecord["outcome"]
  /** `seq` of the event that started the call, `null` when none does. */
  readonly startSeq: number | null
  /** The number of the call this one is compared with, `null` for the first. */
  readonly comparedWith: number | null
  readonly blocks: number
  readonly bytes: number
  readonly prefix: PrefixStatus
  /** The blocks the model had not been sent in the call compared with, in request order. */
  readonly fresh: readonly AttributedBlock[]
  readonly freshBytes: number
  /** `fresh` grouped by source, in the order each source first occurs. */
  readonly groups: readonly SourceGroup[]
  readonly action: CallAction
  readonly usage: CallUsage | null
  /** Whether the request rebuilt from the log has the ledger's hashes, so every block could be named. */
  readonly verified: boolean
  /** Why it is not verified. */
  readonly unverified?: string
}

export interface SessionAttribution {
  readonly calls: readonly CallAttribution[]
  /** Set when the log does not fold to its end: later calls then have no start point. */
  readonly foldFailure: string | null
}

/** Attributes every model call of a session. `events` is the session's whole log (a fork's includes what it inherits). */
export function attributeSession(
  events: readonly StoredEvent[],
  rows: readonly RequestRecord[],
  options: AttributionOptions = {},
): SessionAttribution {
  const { points, final, failure } = fold(events)
  const previewChars = options.previewChars ?? 80
  const calls: CallAttribution[] = []
  rows.forEach((row, index) => {
    const start = points.get(row)
    const baseIndex = findBase(rows, index)
    const base = baseIndex === null ? null : rows[baseIndex]!
    const baseStart = base === null ? null : points.get(base)
    const named = name(row, start, options, previewChars)
    const since = start === null || baseStart === null || baseStart === undefined ? [] : events.filter((event) => event.seq > baseStart.seq && event.seq <= start.seq)
    const prefix = comparePrefixStatus(base, row, since)
    const known = new Set(base?.blocks.map((block) => `${block.kind}\u0000${block.hash}`) ?? [])
    const from = prefix.status === "first" ? 0 : prefix.kept
    const fresh = named.blocks.filter((block) => block.index >= from && !known.has(`${row.blocks[block.index]!.kind}\u0000${row.blocks[block.index]!.hash}`))
    calls.push({
      number: index + 1,
      requestId: row.id,
      purpose: row.purpose,
      messageId: row.messageId,
      attempt: row.attempt,
      outcome: row.outcome,
      startSeq: start?.seq ?? null,
      comparedWith: baseIndex === null ? null : baseIndex + 1,
      blocks: row.blocks.length,
      bytes: sum(row.blocks.map((block) => block.bytes)),
      prefix: withReasons(prefix, since, start?.projection ?? null),
      fresh,
      freshBytes: sum(fresh.map((block) => block.bytes)),
      groups: group(fresh),
      action: actionOf(row, final, previewChars),
      usage: usageOf(row),
      verified: named.verified,
      ...(named.unverified === undefined ? {} : { unverified: named.unverified }),
    })
  })
  return { calls, foldFailure: failure }
}

// ---------------------------------------------------------------- start points

interface StartPoint {
  readonly seq: number
  readonly projection: Projection
}

/**
 * The projection at the event that began each call, as `export.ts` finds it:
 * `step.started` for an attempt, `retry.scheduled` for a transparent retry
 * on a running message, `compaction.started` for a summary call and, from the
 * attempt it names, `compaction.repair_requested`.
 */
function fold(events: readonly StoredEvent[]) {
  const steps = new Map<string, StartPoint>()
  const summaries = new Map<string, { readonly fromAttempt: number; readonly point: StartPoint }[]>()
  let state: Projection | null = null
  let failure: string | null = null
  for (const event of events) {
    try {
      state = reduce(state, event)
    } catch (error) {
      failure = `event seq ${event.seq} (${event.type}) does not fold: ${error instanceof Error ? error.message : String(error)}`
      break
    }
    const point = { seq: event.seq, projection: state }
    if (event.type === "step.started") steps.set(key(event.data.messageId, event.data.attempt), point)
    if (event.type === "compaction.started") summaries.set(event.data.messageId, [{ fromAttempt: 1, point }])
    if (event.type === "compaction.repair_requested") summaries.get(event.data.messageId)?.push({ fromAttempt: event.data.attempt, point })
    if (event.type === "retry.scheduled") {
      const message = state.messages.findLast((candidate) => candidate.id === event.data.messageId)
      if (message?.kind === "assistant" && message.status === "running") steps.set(key(event.data.messageId, event.data.attempt), point)
    }
  }
  const get = (row: RequestRecord): StartPoint | null =>
    row.purpose === "compaction"
      ? (summaries.get(row.messageId)?.findLast((entry) => entry.fromAttempt <= row.attempt)?.point ?? null)
      : (steps.get(key(row.messageId, row.attempt)) ?? null)
  return { points: { get }, final: state, failure }
}

function key(messageId: string, attempt: number) {
  return `${messageId}\u0000${attempt}`
}

/** The row a call is compared with: the latest earlier attempt of its own message, else the latest earlier step call. */
function findBase(rows: readonly RequestRecord[], index: number): number | null {
  const row = rows[index]!
  for (let at = index - 1; at >= 0; at -= 1) {
    const candidate = rows[at]!
    if (candidate.messageId === row.messageId || candidate.purpose === "step") return at
  }
  return null
}

// ---------------------------------------------------------------- the comparison

function comparePrefixStatus(base: RequestRecord | null, row: RequestRecord, since: readonly StoredEvent[]): PrefixStatus {
  if (base === null) return { status: "first" }
  const comparison = comparePrefix(base.blocks, row.blocks)
  if (comparison.extension) return { status: "extension", kept: base.blocks.length, appended: comparison.appended }
  const kept = comparison.index
  const known = new Set(base.blocks.map((block) => `${block.kind}\u0000${block.hash}`))
  const rest = row.blocks.slice(kept).filter((block) => known.has(`${block.kind}\u0000${block.hash}`))
  const firstChanged = { index: kept, kind: comparison.kind }
  const shared = { firstChanged, kept, resent: rest.length, resentBytes: sum(rest.map((block) => block.bytes)) }
  const causes: RebuildCause[] = [...prefixBreakCauses(since), ...(row.purpose === "compaction" ? (["summary"] as const) : [])]
  return causes.length === 0 ? { status: "unexplained", ...shared } : { status: "rebuilt", causes, reasons: [], ...shared }
}

/** Adds a sentence per cause: which compaction, which revert, which settings. */
function withReasons(prefix: PrefixStatus, since: readonly StoredEvent[], projection: Projection | null): PrefixStatus {
  if (prefix.status !== "rebuilt") return prefix
  const reasons = since.flatMap((event): string[] => {
    switch (event.type) {
      case "compaction.ended": {
        const message = projection?.messages.findLast((candidate) => candidate.id === event.data.messageId)
        const detail = message?.kind === "compaction" ? `, ${message.trigger} ${message.mode}, summary from ${message.source ?? "?"}` : ""
        return [`compaction ${event.data.messageId}${detail}: history now starts at its checkpoint`]
      }
      case "history.reverted":
        return [`revert from seq ${event.data.fromSeq}: the messages after it are left out`]
      case "step.refused":
        return [`refused step ${event.data.messageId}: its range is left out`]
      case "settings.changed":
        return [`settings changed to model ${event.data.model}, effort ${event.data.reasoningEffort ?? "default"}`]
      default:
        return []
    }
  })
  const summary = prefix.causes.includes("summary") ? ["summary request: the step request of the part before the cut, without the kept tail, plus the prompt"] : []
  return { ...prefix, reasons: [...reasons, ...summary] }
}

// ---------------------------------------------------------------- naming blocks

interface Named {
  readonly blocks: readonly AttributedBlock[]
  readonly verified: boolean
  readonly unverified?: string
}

/** Names every block of a row: from the rebuilt request when its hashes are the ledger's, else by kind only. */
function name(row: RequestRecord, start: StartPoint | null, options: AttributionOptions, previewChars: number): Named {
  const byKind = (unverified: string): Named => ({
    blocks: row.blocks.map((block, index) => ({
      index,
      source: block.kind === "input" ? "input" : block.kind,
      bytes: block.bytes,
      label: block.kind === "input" ? "input item" : block.kind,
      seq: null,
    })),
    verified: false,
    unverified,
  })
  if (start === null) return byKind("no event in the log starts this call")
  let request: ModelRequest
  let sources: readonly ItemSource[]
  try {
    if (row.purpose === "compaction") {
      request = buildCompactionRequest(start.projection, options.callOptions, row.messageId as never)
      const compaction = start.projection.messages.findLast((message) => message.id === row.messageId)
      const keepFrom = compaction?.kind === "compaction" ? compaction.keepFromSeq : Number.POSITIVE_INFINITY
      // As buildCompactionRequest selects what it summarises: the part before the cut, checkpoints kept.
      const older = { ...start.projection, messages: start.projection.messages.filter((message) => message.seq < keepFrom || message.kind === "compaction") }
      sources = historySources(selectModelHistory(older))
    } else {
      request = buildRequest(start.projection, { ...options.callOptions, toolChoice: "auto" })
      sources = historySources(selectModelHistory(start.projection))
    }
  } catch (error) {
    return byKind(`the request builder failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const hashes = hashRequest(request)
  const mismatch = hashes.length !== row.blocks.length || hashes.some((block, index) => block.hash !== row.blocks[index]!.hash)
  if (mismatch) return byKind("the request rebuilt from the log differs from the ledger row")
  const tools = request.tools.length
  const blocks = row.blocks.map((block, index): AttributedBlock => {
    const bytes = block.bytes
    if (index === 0) return { index, source: "params", bytes, label: `params ${request.params.model} effort ${request.params.reasoningEffort ?? "default"}`, seq: null }
    if (index <= tools) return { index, source: "tool", bytes, label: `tool ${request.tools[index - 1]!.name}`, seq: null }
    if (index === tools + 1) return { index, source: "instructions", bytes, label: "system prompt", seq: null }
    const position = index - tools - 2
    const item = request.input[position]!
    const from = sources[position]
    // The item must be the one its message renders; anything else is named by kind only.
    if (from === undefined || hashBlock({ kind: "input", item: from.item }).hash !== block.hash)
      return { index, source: row.purpose === "compaction" ? "compaction_prompt" : "input", bytes, label: row.purpose === "compaction" ? "compaction prompt" : "input item", seq: null, ...preview(item, previewChars) }
    return describeItem(index, bytes, from, previewChars)
  })
  return { blocks, verified: true }
}

interface ItemSource {
  readonly item: InputItem
  readonly message: Message
}

/** The input items of a model view with the message each one renders, in request order (as `buildRequestFromHistory`). */
function historySources(history: ModelHistory): ItemSource[] {
  if (history.baseline === null) return []
  const context = { model: history.settings.model, baselineSeq: history.baseline.seq, retired: retiredNotes(history) }
  return history.messages.flatMap((message) => renderMessage(message, context).map((item) => ({ item, message })))
}

function describeItem(index: number, bytes: number, from: ItemSource, previewChars: number): AttributedBlock {
  const { item, message } = from
  const base = { index, bytes, seq: message.seq }
  switch (message.kind) {
    case "user":
      return { ...base, source: "user", label: "user message", ...preview(item, previewChars) }
    case "synthetic":
      return { ...base, source: "harness", label: `harness note (${message.origin})`, origin: message.origin, ...preview(item, previewChars) }
    case "instruction":
      return { ...base, source: "instruction", label: `instruction update ${message.source}`, origin: message.source, ...preview(item, previewChars) }
    case "compaction":
      return { ...base, source: "checkpoint", label: `checkpoint of compaction ${message.id}` }
    case "assistant": {
      if (item.type === "tool_result") {
        const call = message.parts.find((part) => part.type === "tool_call" && part.callId === item.callId)
        const tool = call?.type === "tool_call" ? call.name : "?"
        return { ...base, source: "tool_result", label: `tool result ${tool} ${item.callId}`, tool, callId: item.callId, ...preview(item, previewChars) }
      }
      if (item.type === "tool_call") return { ...base, source: "model_output", label: `model's tool call ${item.name} ${item.callId}`, tool: item.name, callId: item.callId }
      return { ...base, source: "model_output", label: item.type === "reasoning" ? "model's reasoning" : "model's text", ...preview(item, previewChars) }
    }
    default:
      return message satisfies never
  }
}

function preview(item: InputItem, chars: number): { preview?: string } {
  if (chars <= 0) return {}
  const raw =
    item.type === "message"
      ? item.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(" ")
      : item.type === "tool_result"
        ? item.output
        : item.type === "tool_call"
          ? item.input
          : item.text
  const line = raw.replace(/\s+/g, " ").trim()
  if (line === "") return {}
  return { preview: line.length > chars ? `${line.slice(0, chars - 1)}…` : line }
}

// ---------------------------------------------------------------- actions and usage

function actionOf(row: RequestRecord, final: Projection | null, previewChars: number): CallAction {
  const message = final?.messages.findLast((candidate) => candidate.id === row.messageId)
  const nothing: CallAction = { kind: "no_output", outcome: row.outcome, errorKind: row.errorKind }
  if (message === undefined) return nothing
  if (message.kind === "compaction") {
    if (message.repair !== null && row.attempt < message.repair.attempt) return { kind: "rejected_summary", chars: message.repair.answer.length }
    if (row.outcome !== "ok") return nothing
    return { kind: "summary", status: message.status, source: message.source, chars: message.summary?.length ?? 0 }
  }
  if (message.kind !== "assistant") return nothing
  // A message holds the output of its latest attempt; an earlier attempt left nothing durable.
  if (row.attempt !== message.attempt) return nothing
  const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
  const shown = previewChars <= 0 ? "" : text.replace(/\s+/g, " ").trim()
  return {
    kind: "step",
    status: message.status,
    finish: message.finish,
    textChars: text.length,
    ...(shown === "" ? {} : { preview: shown.length > previewChars ? `${shown.slice(0, previewChars - 1)}…` : shown }),
    reasoning: message.parts.filter((part) => part.type === "reasoning").length,
    toolCalls: message.parts.flatMap((part) =>
      part.type === "tool_call" ? [{ name: part.name, callId: part.callId, outcome: part.state.status === "settled" ? part.state.outcome : null }] : [],
    ),
  }
}

function usageOf(row: RequestRecord): CallUsage | null {
  if (row.usage === null) return null
  const input = row.usage.inputTokens
  const cached = row.usage.cachedInputTokens
  return { input, cached, uncached: input - cached, cachedShare: input === 0 ? 0 : cached / input, output: row.usage.outputTokens }
}

function group(blocks: readonly AttributedBlock[]): SourceGroup[] {
  const groups = new Map<BlockSource, { count: number; bytes: number }>()
  for (const block of blocks) {
    const entry = groups.get(block.source) ?? { count: 0, bytes: 0 }
    entry.count += 1
    entry.bytes += block.bytes
    groups.set(block.source, entry)
  }
  return [...groups].map(([source, entry]) => ({ source, ...entry }))
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0)
}

// ---------------------------------------------------------------- rendering

/** A readable table of the calls, one block of lines per call. */
export function renderAttribution(attribution: SessionAttribution, options: { readonly step?: number } = {}): string {
  const calls = options.step === undefined ? attribution.calls : attribution.calls.filter((call) => call.number === options.step)
  const lines: string[] = []
  for (const call of calls) {
    const usage = call.usage === null ? "no usage" : `in ${call.usage.input}, cached ${call.usage.cached} (${Math.round(call.usage.cachedShare * 100)}%), uncached ${call.usage.uncached}, out ${call.usage.output}`
    lines.push(`#${call.number} ${call.purpose} ${call.messageId} attempt ${call.attempt} (${call.outcome ?? "unfinished"}): ${call.blocks} blocks, ${call.bytes} B; ${usage}${call.verified ? "" : `; unverified: ${call.unverified}`}`)
    lines.push(`   prefix: ${describePrefix(call)}`)
    lines.push(`   new: ${call.fresh.length === 0 ? "nothing" : `${call.fresh.length} blocks, ${call.freshBytes} B: ${call.groups.map((entry) => `${entry.source} ${entry.count} (${entry.bytes} B)`).join(", ")}`}`)
    for (const block of call.fresh) {
      if (block.source === "tool" || block.source === "params") continue
      lines.push(`     + ${block.label}${block.seq === null ? "" : ` [seq ${block.seq}]`}, ${block.bytes} B${block.preview === undefined ? "" : `: ${block.preview}`}`)
    }
    const tools = call.fresh.filter((block) => block.source === "tool")
    if (tools.length > 0) lines.push(`     + ${tools.length} tool specs, ${sum(tools.map((block) => block.bytes))} B`)
    lines.push(`   then: ${describeAction(call.action)}`)
  }
  if (attribution.foldFailure !== null) lines.push(`the log stops folding: ${attribution.foldFailure}`)
  return lines.join("\n")
}

function describePrefix(call: CallAttribution): string {
  const prefix = call.prefix
  switch (prefix.status) {
    case "first":
      return "first call, everything is new"
    case "extension":
      return `extends #${call.comparedWith}: ${prefix.kept} blocks kept, ${prefix.appended} appended`
    case "rebuilt":
      return `REBUILT against #${call.comparedWith} (${prefix.causes.join(", ")}): ${prefix.kept} blocks kept, first change at block ${prefix.firstChanged.index} (${prefix.firstChanged.kind}), ${prefix.resent} blocks re-sent (${prefix.resentBytes} B); ${prefix.reasons.join("; ")}`
    case "unexplained":
      return `BROKEN against #${call.comparedWith} with no cause in the log: first change at block ${prefix.firstChanged.index} (${prefix.firstChanged.kind}), ${prefix.resent} blocks re-sent (${prefix.resentBytes} B)`
  }
}

function describeAction(action: CallAction): string {
  switch (action.kind) {
    case "step": {
      const parts = [
        ...(action.textChars > 0 ? [`text ${action.textChars} chars${action.preview === undefined ? "" : ` "${action.preview}"`}`] : []),
        ...(action.reasoning > 0 ? [`${action.reasoning} reasoning`] : []),
        ...(action.toolCalls.length > 0 ? [`calls ${action.toolCalls.map((call) => `${call.name} ${call.callId}${call.outcome === null ? "" : ` (${call.outcome})`}`).join(", ")}`] : []),
      ]
      return `${action.status}${action.finish === null ? "" : ` (${action.finish})`}: ${parts.length === 0 ? "no output" : parts.join("; ")}`
    }
    case "summary":
      return `summary ${action.chars} chars, ${action.status}, source ${action.source ?? "?"}`
    case "rejected_summary":
      return `summary answer of ${action.chars} chars, rejected (a repair was asked for)`
    case "no_output":
      return `no durable output (${action.outcome ?? "unfinished"}${action.errorKind === null ? "" : `, ${action.errorKind}`})`
  }
}
