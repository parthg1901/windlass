/**
 * Live telemetry, as the engine runs it (`telemetry/` has the module).
 *
 * - Nothing is written for it and nothing of it is in a request: spans are
 *   derived from the session's log and its request ledger with the same
 *   `mapSession` an export after the fact uses, so a span sent live and one
 *   exported later have the same IDs and say the same.
 * - A session keeps the part of its log that still has something open (the
 *   execution in progress, and an earlier one whose background work still
 *   runs) and the ledger rows of it, as they are written. At the events
 *   where a span closes the window is mapped, and every span that is closed
 *   and was not sent before is queued, once.
 * - A model call's span is final once its ledger row is finished and the
 *   log says what became of the call (the step's ending, a retry, the next
 *   step, the execution's ending). Until then it is not sent.
 * - A turn is never slowed or failed by the collector: queueing never waits
 *   and never throws, sending runs off the loop with a timeout and bounded
 *   retries, and a queue that is full drops its oldest spans and counts them.
 *   Mapping in the middle of a turn is put off by a moment and runs once for
 *   everything that closed meanwhile; a failure in it switches telemetry off
 *   for the session and is said once.
 * - Who may say what is the module's rule (`resolveTelemetryConfig`): only
 *   the user's own configuration turns it on, names the collector and asks
 *   for content; a project's file can only turn it off.
 */
import { hostname } from "node:os"
import type { StoredEvent } from "../event/durable.ts"
import type { RequestRecord } from "../store/store.ts"
import { type TelemetryConfig, TelemetryConfigError, resolveTelemetryConfig } from "../telemetry/config.ts"
import { type BackgroundExporter, type ExportReport, createBackgroundExporter, exportOtlpHttp } from "../telemetry/exporter.ts"
import { IGNORED_EVENTS, type LogEvent, type MapOptions, mapSession } from "../telemetry/map.ts"
import { resourceAttributes } from "../telemetry/otlp.ts"
import { type Attributes, type Span, type SpanContext, spanIdOf } from "../telemetry/span.ts"
import { placementIn } from "../telemetry/tree.ts"
import { versionString } from "../version.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to export telemetry live. */
export interface TelemetrySetup {
  /** The environment a header's `${NAME}` is read from. Default: the process's. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * What is handed the spans of one flush, instead of the OTLP/HTTP exporter
   * (a test, a collector of the caller's own). It may be slow, reject or
   * throw: the engine counts what it did not take and carries on.
   */
  readonly send?: (spans: readonly Span[], config: TelemetryConfig) => Promise<ExportReport>
  /** How long a closed span may wait in the queue before it is sent. Default 5 s. An execution's ending sends at once. */
  readonly flushIntervalMs?: number
  /**
   * How long spans that closed in the middle of a turn wait to be mapped,
   * so that a step with many calls is mapped once. Default 1 s; `0` maps at
   * every closing event. An execution's ending always maps at once.
   */
  readonly mapDelayMs?: number
  /** How long `Engine.close()` waits for the collector to take what is queued; what is left then is dropped. Default 2 s. */
  readonly closeDeadlineMs?: number
  /** Spans the queue holds before the oldest are dropped. Default: the module's (2048). */
  readonly maxQueue?: number
  /** The resource the spans are reported under, besides the service's name. Default: the harness's version and the host's name. */
  readonly resource?: Attributes
}

export const TELEMETRY_FLUSH_INTERVAL_MS = 5_000
export const TELEMETRY_MAP_DELAY_MS = 1_000
export const TELEMETRY_CLOSE_DEADLINE_MS = 2_000

/** One collector the engine sends to, for a client that shows it. Header values are never part of it. */
export interface TelemetryState {
  readonly endpoint: string
  /** Spans waiting to be sent, dropped because the queue was full, taken by the collector, and not taken. */
  readonly queued: number
  readonly dropped: number
  readonly sent: number
  readonly failed: number
}

/** What a session's configuration says about telemetry, resolved: on (with where and how), off, or why it cannot be used. */
export type TelemetryPlan = { readonly kind: "on"; readonly config: TelemetryConfig } | { readonly kind: "off" } | { readonly kind: "unusable"; readonly message: string }

interface Exporter {
  readonly endpoint: string
  readonly queue: BackgroundExporter
  /** Queues spans and makes sure they are sent within the flush interval. */
  readonly add: (spans: readonly Span[]) => void
  /** Sends what is queued now. Never rejects. */
  readonly flush: () => Promise<void>
}

/** The engine's exporters: one background queue per collector (endpoint, headers and timeout), shared by the sessions that send there. */
export class TelemetryHub {
  private readonly exporters = new Map<string, Exporter>()
  /** Aborted when the engine closes and the deadline has passed: requests in flight and waits between retries end. */
  private readonly stopped = new AbortController()

  constructor(private readonly setup: TelemetrySetup) {}

  get mapDelayMs(): number {
    return this.setup.mapDelayMs ?? TELEMETRY_MAP_DELAY_MS
  }

  /** Reads the `telemetry` sections of a session's two files as the module requires. Never throws. */
  plan(files: ConfigFiles | null): TelemetryPlan {
    try {
      const config = resolveTelemetryConfig(files?.user?.telemetry, files?.project?.telemetry, this.setup.env ?? process.env)
      return config.enabled ? { kind: "on", config } : { kind: "off" }
    } catch (error) {
      if (error instanceof TelemetryConfigError) return { kind: "unusable", message: error.message }
      return { kind: "unusable", message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** What tells one resolved configuration from another: where the spans go and what they carry. Holds header values; never shown. */
  key(config: TelemetryConfig): string {
    return JSON.stringify([collector(config), config.content])
  }

  /** The queue in front of the collector a configuration names, made on first use. */
  exporter(config: TelemetryConfig): Exporter {
    const key = collector(config)
    const known = this.exporters.get(key)
    if (known !== undefined) return known
    const resource = resourceAttributes(this.setup.resource ?? { "service.version": versionString(), "host.name": hostname() })
    const stopped = this.stopped.signal
    const send =
      this.setup.send === undefined
        ? (spans: readonly Span[]) =>
            exportOtlpHttp(spans, {
              endpoint: config.endpoint!,
              headers: config.headers,
              timeoutMs: config.timeoutMs,
              resource,
              // Once the engine has closed nothing waits any longer: a request in flight is cut, a wait between retries ends.
              fetch: (url, init) => fetch(url, { ...init, signal: init.signal == null ? stopped : AbortSignal.any([init.signal, stopped]) }),
              sleep: (ms) => pause(ms, stopped),
            })
        : (spans: readonly Span[]) => this.setup.send!(spans, config)
    const queue = createBackgroundExporter(send, this.setup.maxQueue === undefined ? {} : { maxQueue: this.setup.maxQueue })
    const interval = this.setup.flushIntervalMs ?? TELEMETRY_FLUSH_INTERVAL_MS
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      return queue.flush()
    }
    const made: Exporter = {
      endpoint: config.endpoint!,
      queue,
      add: (spans) => {
        if (spans.length === 0 || stopped.aborted) return
        queue.add(spans)
        if (timer !== null) return
        timer = setTimeout(() => {
          timer = null
          void queue.flush()
        }, interval)
        // A span that waits to be sent never keeps a process alive.
        timer.unref?.()
      },
      flush,
    }
    this.exporters.set(key, made)
    return made
  }

  state(): TelemetryState[] {
    return [...this.exporters.values()].map((exporter) => ({ endpoint: exporter.endpoint, ...exporter.queue.stats() }))
  }

  /** Sends what is queued, waits for it for a short while, then lets go: whatever the collector does, closing ends. */
  async close(): Promise<void> {
    const flushed = Promise.all([...this.exporters.values()].map((exporter) => exporter.flush()))
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.setup.closeDeadlineMs ?? TELEMETRY_CLOSE_DEADLINE_MS)
    })
    await Promise.race([flushed, deadline])
    if (timer !== null) clearTimeout(timer)
    this.stopped.abort()
  }
}

/** One collector, as a key: the endpoint, the headers and the timeout. */
function collector(config: TelemetryConfig): string {
  return JSON.stringify([config.endpoint, Object.entries(config.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), config.timeoutMs])
}

/** Waits `ms`, or until `signal` aborts. Its timer keeps no process alive. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal.addEventListener("abort", done, { once: true })
  })
}

/** The events at which something a span stands for is over: the window is mapped when one is appended. */
const CLOSES = new Set<string>([
  "execution.succeeded",
  "execution.failed",
  "execution.interrupted",
  "turn.ended",
  "tool.settled",
  "spawn.ended",
  "compaction.ended",
  "compaction.failed",
  "compaction.repair_requested",
  "compaction.started",
  "checks.finished",
  "checks.failed",
  "step.started",
  "step.ended",
  "step.failed",
  "step.refused",
  "retry.scheduled",
])
/** The events that end the work of an execution in a process: mapped at once, sent at once, and the window is cut behind them. */
const ENDS = new Set<string>(["execution.succeeded", "execution.failed", "execution.interrupted"])
/**
 * The events that say what became of a model call that has finished: its
 * step's ending (the finish reason), a retry (that it was retried, and after
 * what delay), the next step, a compaction's next move, the turn's or the
 * execution's ending. A call's span is sent once one of them follows its
 * ledger row's finish, so it is sent whole.
 */
const SETTLES = new Set<string>([...ENDS, "turn.ended", "step.started", "step.ended", "step.failed", "step.refused", "retry.scheduled", "compaction.started", "compaction.ended", "compaction.failed", "compaction.repair_requested"])

export interface SessionTraceOptions {
  readonly sessionId: string
  readonly exporter: Pick<Exporter, "add" | "flush">
  /** Export message text, tool arguments and tool output, redacted and bounded. */
  readonly content: boolean
  /** The values redacted from exported content. */
  readonly secrets: readonly string[]
  /** Where an execution of this session goes when it is a subagent's: under its parent's spawn span, when the parent is traced. */
  readonly placement?: (execution: { readonly seq: number; readonly timeMs: number }) => SpanContext | null
  readonly mapDelayMs: number
  /** Told once when mapping failed; the session's telemetry is off from then on. */
  readonly onFailure: (message: string) => void
}

/** One session's log as it grows, mapped to spans at the events where spans close. */
export class SessionTrace {
  /** The part of the log that can still change what a span says, oldest first: see `prune`. */
  private window: LogEvent[]
  /** The ledger rows of that part, by request ID, with the `seq` of the last event written before each finished. */
  private readonly rows = new Map<string, { row: RequestRecord; finishedAfter: number }>()
  private readonly exported = new Set<string>()
  /** Where each execution of a subagent was placed, by the `seq` of its start: asked once, when its parent's spawn is certainly on record. */
  private readonly placed = new Map<number, SpanContext | null>()
  private lastSeq = 0
  private lastSettle = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private broken = false

  /**
   * `history` is the session's own log and ledger as they are when telemetry
   * starts for it. What is closed in them was the business of whoever ran the
   * session then: it is not sent again. What is open (an execution a restart
   * resumes) is sent when it closes.
   */
  constructor(
    private readonly options: SessionTraceOptions,
    history: { readonly events: readonly StoredEvent[]; readonly requests: readonly RequestRecord[] },
  ) {
    this.window = history.events.flatMap((item) => this.kept(item))
    this.lastSeq = history.events.at(-1)?.seq ?? 0
    // A call that had finished before telemetry started is whole already.
    for (const row of history.requests) this.rows.set(row.id, { row, finishedAfter: -1 })
    this.guard(() => {
      for (const span of this.map().filter((span) => this.final(span))) this.exported.add(span.spanId)
      this.prune()
    })
  }

  /** Whether mapping failed and the session's telemetry is off. */
  get failed(): boolean {
    return this.broken
  }

  /** The events of one append, in order. Never throws. */
  observe(events: readonly StoredEvent[]): void {
    if (this.broken || events.length === 0) return
    let closes = false
    let ends = false
    for (const item of events) {
      this.window.push(...this.kept(item))
      this.lastSeq = item.seq
      if (SETTLES.has(item.type)) this.lastSettle = item.seq
      closes ||= CLOSES.has(item.type)
      ends ||= ENDS.has(item.type)
    }
    if (ends) this.guard(() => this.flushNow(true))
    else if (closes) this.schedule()
  }

  /** A ledger row as it was begun, or as it was finished. Never throws. */
  request(row: RequestRecord): void {
    if (this.broken) return
    this.rows.set(row.id, { row, finishedAfter: this.lastSeq })
  }

  /**
   * Where the executions of a subagent this session spawned belong: under
   * the span of the spawned work that started them, in this session's trace.
   */
  placementOf(childSessionId: string): (execution: { readonly seq: number; readonly timeMs: number }) => SpanContext | null {
    return (execution) => {
      if (this.broken) return null
      try {
        const own = mapSession({ sessionId: this.options.sessionId, events: this.window, requests: [] }, this.mapOptions())
        return placementIn(own, childSessionId)?.(execution) ?? null
      } catch {
        return null
      }
    }
  }

  /** Maps what closed and was not mapped yet, and hands it to the queue; with `send`, the queue is sent now. Never throws. */
  settle(send = false): void {
    if (this.broken) return
    this.guard(() => this.flushNow(send))
  }

  private schedule(): void {
    if (this.options.mapDelayMs <= 0) return this.guard(() => this.flushNow(false))
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.guard(() => this.flushNow(false))
    }, this.options.mapDelayMs)
    this.timer.unref?.()
  }

  private flushNow(ended: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const ready = this.map().filter((span) => this.final(span) && !this.exported.has(span.spanId))
    for (const span of ready) this.exported.add(span.spanId)
    this.options.exporter.add(ready)
    if (!ended) return
    // The natural end of a request: what the turn produced is sent now, off the loop.
    void this.options.exporter.flush()
    this.prune()
  }

  private mapOptions(): MapOptions {
    const placement = this.options.placement
    return {
      content: this.options.content,
      secrets: this.options.secrets,
      ...(placement === undefined
        ? {}
        : {
            placement: (execution) => {
              if (!this.placed.has(execution.seq)) this.placed.set(execution.seq, placement(execution))
              return this.placed.get(execution.seq) ?? null
            },
          }),
    }
  }

  private map(): readonly Span[] {
    return mapSession({ sessionId: this.options.sessionId, events: this.window, requests: [...this.rows.values()].map((entry) => entry.row) }, this.mapOptions()).spans
  }

  /** The IDs of the spans of model calls that are not whole yet: the row is in flight, or the log does not say yet what became of the call. */
  private pendingCalls(): Set<string> {
    const pending = new Set<string>()
    for (const { row, finishedAfter } of this.rows.values()) {
      if (row.finishedAt !== null && this.lastSettle > finishedAfter) continue
      pending.add(spanIdOf(this.options.sessionId, "call", row.ordinal))
      pending.add(spanIdOf(this.options.sessionId, "orphan", `call-${row.ordinal}`))
    }
    return pending
  }

  private pending: Set<string> | null = null
  private final(span: Span): boolean {
    if (span.open) return false
    if (span.attributes["gen_ai.operation.name"] !== "chat") return true
    this.pending ??= this.pendingCalls()
    return !this.pending.has(span.spanId)
  }

  /**
   * Cuts the window behind an execution that ended: what stays is what a
   * later map still needs. The session's first event and its settings
   * changes (the model and effort a span names), input that still waits (its
   * content, for a later execution's export) and, while work that was
   * spawned earlier still runs, everything from the execution that started
   * the oldest of it: its span closes later, under the tool call that
   * started it, in that execution's trace.
   */
  private prune(): void {
    this.pending = null
    const events = this.window
    const open = new Map<string, number>()
    const waiting = new Map<string, number>()
    let execution = -1
    let running = false
    events.forEach((item, index) => {
      const data = (item.data ?? {}) as { spawnId?: unknown; messageId?: unknown }
      if (item.type === "execution.started") {
        execution = index
        running = true
      } else if (ENDS.has(item.type)) running = false
      else if (item.type === "spawn.started" && typeof data.spawnId === "string") open.set(data.spawnId, execution === -1 ? index : execution)
      else if (item.type === "spawn.ended" && typeof data.spawnId === "string") open.delete(data.spawnId)
      else if (item.type === "inbox.enqueued" && typeof data.messageId === "string") waiting.set(data.messageId, index)
      else if ((item.type === "inbox.delivered" || item.type === "inbox.cancelled") && typeof data.messageId === "string") waiting.delete(data.messageId)
    })
    // An execution that has not ended (one a shutdown suspended is taken up again) stays whole.
    const from = Math.min(running ? execution : events.length, ...open.values())
    const kept = new Set(waiting.values())
    this.window = events.filter((item, index) => index >= from || item.type === "session.created" || item.type === "settings.changed" || kept.has(index))
    // The ledger rows go with the steps and compactions they served: a row whose call is no longer in the window
    // belongs to nothing a later map could show.
    const served = new Set<unknown>()
    for (const item of this.window) if (item.type === "step.started" || item.type === "compaction.started") served.add((item.data as { messageId?: unknown } | null)?.messageId)
    for (const [id, entry] of this.rows) if (!served.has(entry.row.messageId)) this.rows.delete(id)
    if (from < events.length) return
    // Nothing earlier can change a span any more: the record of what was sent goes with it.
    this.exported.clear()
    this.placed.clear()
  }

  private guard(work: () => void): void {
    try {
      this.pending = null
      work()
    } catch (error) {
      this.broken = true
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      this.window = []
      this.rows.clear()
      this.options.onFailure(error instanceof Error ? error.message : String(error))
    } finally {
      this.pending = null
    }
  }

  /**
   * An event as the window keeps it: not at all when the mapping has no use
   * for its type, and, unless content is exported, without the text a span
   * never carries then (a tool's arguments and output, the model's words, a
   * prompt, a checkpoint), so that a long turn is not held in memory twice.
   */
  private kept(item: StoredEvent): LogEvent[] {
    if (IGNORED_EVENTS.has(item.type)) return []
    const event: LogEvent = { type: item.type, seq: item.seq, time: item.time, data: item.data }
    if (this.options.content) return [event]
    const data = item.data as Record<string, unknown>
    switch (item.type) {
      case "tool.called":
        return [{ ...event, data: { ...data, input: "" } }]
      case "tool.settled":
        return [{ ...event, data: { ...data, output: "", display: null } }]
      case "text.ended":
      case "reasoning.ended":
        return [{ ...event, data: { ...data, text: "", providerData: null } }]
      case "inbox.enqueued":
        return [{ ...event, data: { ...data, content: [] } }]
      case "compaction.started":
      case "compaction.repair_requested":
      case "compaction.ended":
        // The cut, the prompt, the rejected answer and the checkpoint are text; a compaction's span has numbers and names.
        return [{ ...event, data: Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value !== "string" || value.length <= 256)) }]
      default:
        return [event]
    }
  }
}
