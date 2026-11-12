/**
 * Exports a stored session as a prefixlens trace (prefixlens SPEC.md, format 1.1).
 *
 * The ledger keeps, per model call, only the block hashes of the request and
 * the usage. The request itself is rebuilt: it is a pure function of the log
 * up to the event that started the call, so this file folds the log to that
 * event, calls the request builder, and compares the rebuilt block hashes
 * with the ones stored in the ledger row.
 *
 * - Equal hashes prove the rebuild is the request that was sent. The record
 *   is written with `fidelity: "full-request"` and the blocks of the wire body
 *   the provider encoder produces for it, in the canonical form SPEC 4.3 asks for.
 * - Anything else is never smoothed over: the record is written usage-only
 *   and the mismatch is returned (which row, which block). It means the
 *   request builder is not deterministic or the log was changed.
 *
 * Legitimate prefix breaks (`compaction.ended`, `history.reverted`,
 * `step.refused`, `settings.changed`, see build-break.ts) between two calls
 * are declared on the later call with `prefix_break` hints (SPEC 6.1), so
 * prefixlens reports the miss that follows as an intentional break.
 *
 * A compaction's summary calls are rebuilt like every other call: the cut,
 * the prompt and the repair of a compaction are in the log
 * (`compaction.started`, `compaction.repair_requested`), and the request of
 * each ledger attempt is a function of the state at whichever of the two
 * began it. A summary request is the step request of the part before the
 * cut plus a prompt. When the compaction keeps a tail, that is not an
 * extension of the step request before it (the tail is left out), so the
 * call declares its own break: everything but its appended items is an
 * unchanged prefix of the previous request, and only the part after that
 * may differ.
 *
 * Nothing from the sign-in is read. The only header written is `session-id`,
 * which is the session's prompt-cache key (the ID of its root session).
 */
import { brand } from "../brand.ts"
import type { StoredEvent } from "../event/durable.ts"
import type { SessionId } from "../id.ts"
import type { Projection } from "../message/message.ts"
import { reduce } from "../message/reducer.ts"
import { blobRefs, encodeRequest } from "../provider/openai-responses-encode.ts"
import { type BuildOptions, type CallOptions, buildCompactionRequest, buildRequest } from "../request/build.ts"
import { type PrefixBreakCause, prefixBreakCauses } from "../request/build-break.ts"
import { type BlockHash, hashRequest } from "../request/prefix.ts"
import type { ModelRequest } from "../request/request.ts"
import type { RequestRecord, Store } from "../store/store.ts"
import {
  type CanonicalTraceRequest,
  type HarnessExtension,
  type PrefixBreakHint,
  TRACE_VERSION,
  type TraceHint,
  type TraceRecord,
  canonicalResponsesRequest,
  traceUsage,
} from "./format.ts"

export interface ExportOptions {
  /**
   * Not used any more: the log stores the prompt of every compaction
   * (`compaction.started`). Kept so that callers that still pass it compile.
   */
  readonly compactionPrompt?: string
  /** The harness-wide call options the requests were built with. Defaults to the request builder's defaults. */
  readonly callOptions?: CallOptions
  /**
   * The step request builder to rebuild with. Defaults to `buildRequest`; a
   * test passes a deliberately broken one to show that the prefix gate
   * catches what such a builder would have sent.
   */
  readonly buildStep?: (projection: Projection, options: BuildOptions) => ModelRequest
  /** The trace lane. Default `"main"`: every call of a session extends the one before it. */
  readonly lane?: string
}

/** Why a ledger row's request could not be shown to be the one that was sent. */
export interface Unverified {
  readonly requestId: string
  readonly ordinal: number
  readonly reason:
    /** The rebuilt block hashes differ from the stored ones. `block` names the first difference. */
    | "hash_mismatch"
    /** No event in the log starts this call (no `step.started`, retry or `compaction.started` for its message and attempt). */
    | "no_start_event"
    /** The request builder threw for the folded state. */
    | "build_failed"
    /** The log could not be folded (the reducer rejected an event). */
    | "fold_failed"
    /** Not given any more: the log stores every compaction's prompt. Kept for callers that still compare with it. */
    | "compaction_prompt_unknown"
    /** A blob the request refers to is not in the store. */
    | "blob_missing"
  /** For `hash_mismatch`: the 1-based block number, and what the ledger and the rebuild have there. */
  readonly block?: {
    readonly number: number
    readonly stored: BlockHash | null
    readonly rebuilt: BlockHash | null
  }
  readonly message: string
}

/** One ledger row and what became of it. */
export interface ExportedCall {
  readonly row: RequestRecord
  /** `seq` of the event that started the call, or `null` when there is none. */
  readonly startSeq: number | null
  /** The rebuilt request in trace blocks, when it was verified against the ledger. */
  readonly request: CanonicalTraceRequest | null
  /** Set when the request could not be verified. */
  readonly unverified: Unverified | null
  /** Legitimate prefix breaks among the events since the previous call's start event. */
  readonly breaks: readonly PrefixBreakCause[]
  /**
   * What the call declares against the call before it (SPEC 6.1): the breaks
   * of `breaks`, and a summary request's own. A `settings.changed` that
   * changed nothing declares nothing.
   */
  readonly declared: readonly PrefixBreakHint[]
  /**
   * What the call's record carries: `declared`, after the declarations of
   * the calls before it that have no record (an aborted call, a failed
   * attempt). A reader compares a record with the record before it, so a
   * break that happened in between is declared where it can be read.
   */
  readonly hinted: readonly PrefixBreakHint[]
  /** The trace record, or `null` when the call has no usage to report (it is in `skipped`). */
  readonly record: TraceRecord | null
}

export interface ExportResult {
  readonly sessionId: SessionId
  readonly calls: readonly ExportedCall[]
  /** The records to write, in ledger order. */
  readonly records: readonly TraceRecord[]
  /** Rows exported usage-only because the request could not be verified. A hash mismatch here is a bug or a changed log. */
  readonly unverified: readonly Unverified[]
  /** Rows without a record: SPEC.md requires usage, and the call reported none (aborted, or still in flight). */
  readonly skipped: readonly { readonly requestId: string; readonly ordinal: number; readonly reason: string }[]
}

/** Builds the trace of one session from its log and its ledger rows. */
export function exportSession(store: Store, sessionId: SessionId, options: ExportOptions = {}): ExportResult {
  const events = store.readEvents(sessionId)
  const rows = store.readRequests(sessionId)
  const starts = startPoints(events)
  // The first call has nothing before it to break; later ones look at the events since the previous call started.
  let previousStart: StartPoint | null = null
  // The request each call is compared with: the one of the call before it that could be rebuilt.
  let previousRequest: CanonicalTraceRequest | null = null
  // Declarations of calls that have no record, waiting for the next record.
  let carried: PrefixBreakHint[] = []
  const calls = rows.map((row, index): ExportedCall => {
    const start = starts.get(row)
    const before = previousStart
    const since = start === null || before === null ? [] : events.filter((event) => event.seq > before.seq && event.seq <= start.seq)
    if (start !== null) previousStart = start
    const breaks = prefixBreakCauses(since)
    const rebuilt = rebuild(store, row, start, starts.failure, options)
    const request = "request" in rebuilt ? rebuilt.request : null
    const declared = [...declare(since, { row, start }, { row: rows[index - 1] ?? null, start: before }, previousRequest), ...summaryBreak(row, start, request, previousRequest)]
    if (request !== null) previousRequest = request
    const hinted = [...carried, ...declared]
    const hints: TraceHint[] = [
      ...(row.purpose === "compaction" ? [{ kind: "compaction_call" as const }] : []),
      // A `compaction` hint allows a break anywhere, so the summary call's own declaration, which keeps a prefix, gets none.
      ...hinted.filter((hint) => hint.reason === "compaction" && hint.after === undefined).map((hint) => ({ kind: "compaction" as const, detail: hint.detail })),
      ...hinted,
    ]
    const record = row.usage === null ? null : toRecord(row, rebuilt, hints, options, sessionId)
    carried = record === null ? hinted : []
    return { row, startSeq: start?.seq ?? null, request, unverified: "unverified" in rebuilt ? rebuilt.unverified : null, breaks, declared, hinted, record }
  })
  return {
    sessionId,
    calls,
    records: calls.flatMap((call) => (call.record === null ? [] : [call.record])),
    unverified: calls.flatMap((call) => (call.unverified === null ? [] : [call.unverified])),
    skipped: calls.flatMap((call) =>
      call.record !== null
        ? []
        : [
            {
              requestId: call.row.id,
              ordinal: call.row.ordinal,
              reason: call.row.finishedAt === null ? "the call never finished (in flight, or the process died)" : `the call ended ${call.row.outcome} without usage`,
            },
          ],
    ),
  }
}

/** A short, human-readable account of the rows that could not be verified. */
export function describeUnverified(result: ExportResult): string[] {
  return result.unverified.map((entry) => `request ${entry.requestId} (ordinal ${entry.ordinal}): ${entry.message}`)
}

// ---------------------------------------------------------------- start points

interface StartPoint {
  readonly seq: number
  readonly projection: Projection
  /** For a compaction's summary call: how many input items the call appends to the step request of the part before the cut. */
  readonly appended?: number
}

/**
 * The projection at the event that began each call: `step.started` for an
 * attempt's first call, `retry.scheduled` for a transparent retry (before any
 * output, the step continues under the same message with the next attempt).
 * A compaction's summary calls begin at `compaction.started`, and from the
 * attempt a `compaction.repair_requested` names, at that event; the attempts
 * in between are retries of the same request. Folding stops at the first
 * event the reducer rejects; later calls then have no start point.
 */
function startPoints(events: readonly StoredEvent[]) {
  const steps = new Map<string, StartPoint>()
  /** Per compaction message: the points its summary request changed at, with the first ledger attempt each applies to. */
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
    if (event.type === "step.started") steps.set(startKey("step", event.data.messageId, event.data.attempt), point)
    if (event.type === "compaction.started") summaries.set(event.data.messageId, [{ fromAttempt: 1, point: { ...point, appended: 1 } }])
    if (event.type === "compaction.repair_requested")
      summaries.get(event.data.messageId)?.push({ fromAttempt: event.data.attempt, point: { ...point, appended: 3 } })
    if (event.type === "retry.scheduled") {
      const message = state.messages.findLast((candidate) => candidate.id === event.data.messageId)
      if (message?.kind === "assistant" && message.status === "running")
        steps.set(startKey("step", event.data.messageId, event.data.attempt), point)
    }
  }
  const get = (key: { readonly purpose: string; readonly messageId: string; readonly attempt: number }): StartPoint | null =>
    key.purpose === "compaction"
      ? (summaries.get(key.messageId)?.findLast((entry) => entry.fromAttempt <= key.attempt)?.point ?? null)
      : (steps.get(startKey(key.purpose, key.messageId, key.attempt)) ?? null)
  return { get, failure }
}

function startKey(purpose: string, messageId: string, attempt: number) {
  return `${purpose}\u0000${messageId}\u0000${attempt}`
}

// ---------------------------------------------------------------- rebuild

type Rebuilt = { readonly request: CanonicalTraceRequest } | { readonly unverified: Unverified }

function rebuild(
  store: Store,
  row: RequestRecord,
  start: StartPoint | null,
  foldFailure: string | null,
  options: ExportOptions,
): Rebuilt {
  const fail = (reason: Unverified["reason"], message: string, block?: Unverified["block"]): Rebuilt => ({
    unverified: { requestId: row.id, ordinal: row.ordinal, reason, ...(block ? { block } : {}), message },
  })
  if (start === null)
    return foldFailure !== null
      ? fail("fold_failed", `cannot rebuild: ${foldFailure}`)
      : fail("no_start_event", `no event starts ${row.purpose} call ${row.messageId} attempt ${row.attempt}`)
  const built = attempt(() =>
    row.purpose === "compaction"
      ? buildCompactionRequest(start.projection, options.callOptions, row.messageId)
      : (options.buildStep ?? buildRequest)(start.projection, { ...options.callOptions, toolChoice: "auto" }),
  )
  if ("error" in built) return fail("build_failed", `the request builder failed: ${built.error}`)
  const hashes = hashRequest(built.value)
  const index = firstDifference(row.blocks, hashes)
  if (index !== -1) {
    const stored = row.blocks[index] ?? null
    const rebuilt = hashes[index] ?? null
    return fail(
      "hash_mismatch",
      `the rebuilt request differs from the ledger at block ${index + 1} of ${row.blocks.length} (ledger: ${describe(stored)}; rebuilt: ${describe(rebuilt)}); the request builder is not deterministic or the log was changed`,
      { number: index + 1, stored, rebuilt },
    )
  }
  const encoded = attempt(() => encode(store, built.value))
  if ("error" in encoded) return fail("blob_missing", `cannot encode the request: ${encoded.error}`)
  return { request: encoded.value }
}

function encode(store: Store, request: ModelRequest): CanonicalTraceRequest {
  const blobs = new Map(
    blobRefs(request).flatMap((ref) => {
      const blob = store.getBlob(ref.hash)
      return blob === null ? [] : [[ref.hash, blob.bytes] as const]
    }),
  )
  const canonical = canonicalResponsesRequest(JSON.parse(encodeRequest(request, blobs).body))
  return { ...canonical, params: withoutToolChoice(canonical.params) }
}

function firstDifference(stored: readonly BlockHash[], rebuilt: readonly BlockHash[]) {
  const length = Math.max(stored.length, rebuilt.length)
  return Array.from({ length }, (_, index) => index).find((index) => {
    const a = stored[index]
    const b = rebuilt[index]
    return a === undefined || b === undefined || a.kind !== b.kind || a.hash !== b.hash
  }) ?? -1
}

function describe(block: BlockHash | null) {
  return block === null ? "nothing" : `${block.kind} ${block.hash.slice(0, 12)}`
}

function attempt<T>(run: () => T): { readonly value: T } | { readonly error: string } {
  try {
    return { value: run() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------- records

function toRecord(
  row: RequestRecord,
  rebuilt: Rebuilt,
  hints: readonly TraceHint[],
  options: ExportOptions,
  sessionId: SessionId,
): TraceRecord {
  const request = "request" in rebuilt ? rebuilt.request : null
  const extension: HarnessExtension = {
    ordinal: row.ordinal,
    message_id: row.messageId,
    attempt: row.attempt,
    purpose: row.purpose,
    outcome: row.outcome,
    verified: request !== null,
    ...("unverified" in rebuilt ? { unverified_reason: rebuilt.unverified.message } : {}),
    params_omitted: ["tool_choice"],
  }
  const cacheKey = request?.params.prompt_cache_key
  return {
    v: TRACE_VERSION,
    id: row.id,
    session: sessionId,
    lane: options.lane ?? "main",
    ts: new Date(row.startedAt).toISOString(),
    provider: "openai",
    model: request?.model ?? row.model,
    fidelity: request === null ? "usage-only" : "full-request",
    ...(request === null ? {} : { params: request.params, request: { blocks: request.blocks } }),
    usage: traceUsage(row.usage!),
    ...(hints.length > 0 ? { hints } : {}),
    ...(typeof cacheKey === "string" ? { headers: { "session-id": cacheKey } } : {}),
    source: { harness: brand.name, exporter: "trace", purpose: row.purpose },
    x_light_harness: extension,
  }
}

/**
 * `tool_choice` is left out of `params`. The step is rebuilt with `"auto"`,
 * but the loop may have sent `"none"` (the last call at the step limit); the
 * value is not hashed and not stored, so it cannot be told. It is also not
 * part of the provider's cached prefix (verified live), while prefixlens
 * counts every param it does not know as cache-relevant, so writing it would
 * make the compaction call look like a parameter change.
 */
function withoutToolChoice(params: CanonicalTraceRequest["params"]) {
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== "tool_choice"))
}

/**
 * The `prefix_break` hints (SPEC 6.1) for the break events since the previous
 * call, in the order they happened. A `compaction` hint (SPEC 6, it names the
 * cause) is written next to the compaction declaration by the caller.
 *
 * `settings.changed` declares what actually changed between the settings the
 * two calls were built from: a `model_switch` for the model, a
 * `settings_change` for the reasoning effort, nothing when neither changed.
 *
 * A revert or a refusal only excludes messages: the baseline (tools and
 * instructions) is untouched. But a developer instruction message that leads
 * the input is a system block in the trace (SPEC 4.2), and a revert or
 * refusal can remove one (a revert past every user message, after an
 * instruction change). The default `after: "system"` would then say a
 * system block survives that did not, so the declaration names the part
 * that does survive: the tools and the instructions block.
 */
function declare(
  since: readonly StoredEvent[],
  current: { readonly row: RequestRecord; readonly start: StartPoint | null },
  previous: { readonly row: RequestRecord | null; readonly start: StartPoint | null },
  previousRequest: CanonicalTraceRequest | null,
): PrefixBreakHint[] {
  const tools = previousRequest?.blocks.filter((block) => block.kind === "tool").length ?? 0
  const leadingDeveloper = (previousRequest?.blocks.filter((block) => block.kind === "system").length ?? 0) > 1
  const removal = (reason: "revert" | "refusal", detail: string): PrefixBreakHint => ({
    kind: "prefix_break",
    reason,
    ...(leadingDeveloper ? { after: tools + 1 } : {}),
    detail,
  })
  const removals = since.flatMap((event): PrefixBreakHint[] => {
    if (event.type === "compaction.ended") return [{ kind: "prefix_break", reason: "compaction", detail: `compaction ${event.data.messageId}` }]
    if (event.type === "history.reverted") return [removal("revert", `reverted from seq ${event.data.fromSeq}`)]
    if (event.type === "step.refused") return [removal("refusal", `refused step ${event.data.messageId}`)]
    return []
  })
  return [...removals, ...(since.some((event) => event.type === "settings.changed") ? settingsChanges(current, previous) : [])]
}

/**
 * The break a compaction's summary call makes by itself. Its request is the
 * step request of the part before the cut plus the items it appends (the
 * prompt; with a repair, the rejected answer and the follow-up too). When
 * the compaction keeps a tail, the previous request went on where this one
 * has its prompt, so the call is not an extension, on purpose. It declares
 * that everything before its appended items is unchanged: a difference
 * earlier than that is not excused.
 */
function summaryBreak(row: RequestRecord, start: StartPoint | null, request: CanonicalTraceRequest | null, previous: CanonicalTraceRequest | null): PrefixBreakHint[] {
  if (row.purpose !== "compaction" || start === null || request === null || previous === null) return []
  const extends_ = previous.blocks.length <= request.blocks.length && previous.blocks.every((block, index) => block.hash === request.blocks[index]!.hash)
  if (extends_) return []
  return [{ kind: "prefix_break", reason: "compaction", after: request.blocks.length - (start.appended ?? 1), detail: `summary request of compaction ${row.messageId}: the kept tail is left out` }]
}

/**
 * The model and effort changes between the settings two calls were built
 * from. Without both start points only the ledger's model can be compared.
 */
function settingsChanges(
  current: { readonly row: RequestRecord; readonly start: StartPoint | null },
  previous: { readonly row: RequestRecord | null; readonly start: StartPoint | null },
): PrefixBreakHint[] {
  if (previous.row === null) return []
  const before = previous.start?.projection.session.settings
  const after = current.start?.projection.session.settings
  const model = { from: before?.model ?? previous.row.model, to: after?.model ?? current.row.model }
  const effort = (value: string | null) => value ?? "default"
  return [
    ...(model.from !== model.to ? [{ kind: "prefix_break" as const, reason: "model_switch" as const, detail: `${model.from} → ${model.to}` }] : []),
    ...(before !== undefined && after !== undefined && before.reasoningEffort !== after.reasoningEffort
      ? [
          {
            kind: "prefix_break" as const,
            reason: "settings_change" as const,
            detail: `effort ${effort(before.reasoningEffort)} → ${effort(after.reasoningEffort)}`,
          },
        ]
      : []),
  ]
}
