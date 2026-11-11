/**
 * Exports a stored session as a prefixlens trace (prefixlens SPEC.md, v1).
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
 * are marked on the later call: as SPEC hints where the spec has a kind
 * (`compaction`, `model_switch`), and always in the `x_light_harness`
 * extension field.
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
import { PREFIX_BREAK_CAUSES, type PrefixBreakCause } from "../request/build-break.ts"
import { type BlockHash, hashRequest } from "../request/prefix.ts"
import type { ModelRequest } from "../request/request.ts"
import type { RequestRecord, Store } from "../store/store.ts"
import {
  type CanonicalTraceRequest,
  type HarnessExtension,
  TRACE_VERSION,
  type TraceHint,
  type TraceRecord,
  canonicalResponsesRequest,
  traceUsage,
} from "./format.ts"

export interface ExportOptions {
  /**
   * The prompt the step loop appends for a compaction call. The log does not
   * store it, so without it a compaction call cannot be rebuilt and is
   * exported usage-only (with the reason).
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
    /** A compaction call, and no `compactionPrompt` was given. Not a mismatch: the request is just not reproducible. */
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
  let previousStart: number | null = null
  const calls = rows.map((row, index): ExportedCall => {
    const start = starts.points.get(startKey(row.purpose, row.messageId, row.attempt)) ?? null
    const since =
      start === null || previousStart === null
        ? []
        : events.filter((event) => event.seq > previousStart! && event.seq <= start.seq)
    if (start !== null) previousStart = start.seq
    const breakEvents = since.filter((event) => event.type in PREFIX_BREAK_CAUSES)
    const breaks = [...new Set(breakEvents.map((event) => PREFIX_BREAK_CAUSES[event.type as keyof typeof PREFIX_BREAK_CAUSES]))]
    const rebuilt = rebuild(store, row, start, starts.failure, options)
    const record =
      row.usage === null
        ? null
        : toRecord(row, rebuilt, breakEvents, hintsFor(row, rows[index - 1] ?? null, since), options, sessionId)
    return {
      row,
      startSeq: start?.seq ?? null,
      request: "request" in rebuilt ? rebuilt.request : null,
      unverified: "unverified" in rebuilt ? rebuilt.unverified : null,
      breaks,
      record,
    }
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
}

/**
 * The projection at the event that began each call: `step.started` for an
 * attempt's first call, `retry.scheduled` for a transparent retry (before any
 * output, the step continues under the same message with the next attempt),
 * `compaction.started` for a compaction call. Folding stops at the first
 * event the reducer rejects; later calls then have no start point.
 */
function startPoints(events: readonly StoredEvent[]) {
  const points = new Map<string, StartPoint>()
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
    if (event.type === "step.started") points.set(startKey("step", event.data.messageId, event.data.attempt), point)
    if (event.type === "compaction.started") points.set(startKey("compaction", event.data.messageId, 1), point)
    if (event.type === "retry.scheduled") {
      const message = state.messages.findLast((candidate) => candidate.id === event.data.messageId)
      if (message?.kind === "assistant" && message.status === "running")
        points.set(startKey("step", event.data.messageId, event.data.attempt), point)
    }
  }
  return { points, failure }
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
  if (row.purpose === "compaction" && options.compactionPrompt === undefined)
    return fail("compaction_prompt_unknown", "a compaction call: the log does not store the compaction prompt, so the request cannot be rebuilt")
  const built = attempt(() =>
    row.purpose === "compaction"
      ? buildCompactionRequest(start.projection, options.compactionPrompt!, options.callOptions)
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
  breakEvents: readonly StoredEvent[],
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
    ...(breakEvents.length > 0
      ? {
          prefix_break: {
            causes: [...new Set(breakEvents.map((event) => PREFIX_BREAK_CAUSES[event.type as keyof typeof PREFIX_BREAK_CAUSES]))],
            events: breakEvents.map((event) => ({ type: event.type, seq: event.seq })),
          },
        }
      : {}),
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
 * SPEC 6 hints for the breaks the spec has a kind for: `compaction` after a
 * completed compaction, `model_switch` when the model differs from the
 * previous call's after a `settings.changed`, and `compaction_call` on the
 * compaction request itself. Reverts, refusals and effort-only changes have
 * no kind and are only in the extension field.
 */
function hintsFor(row: RequestRecord, previous: RequestRecord | null, since: readonly StoredEvent[]): TraceHint[] {
  const compactions = since.flatMap((event): TraceHint[] =>
    event.type === "compaction.ended" ? [{ kind: "compaction", detail: `compaction ${event.data.messageId}` }] : [],
  )
  const switched = previous !== null && previous.model !== row.model && since.some((event) => event.type === "settings.changed")
  return [
    ...(row.purpose === "compaction" ? [{ kind: "compaction_call" as const }] : []),
    ...compactions,
    ...(switched ? [{ kind: "model_switch" as const, detail: `${previous.model} → ${row.model}` }] : []),
  ]
}
