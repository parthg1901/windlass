/**
 * Where spans go: an OTLP/HTTP collector (`<endpoint>/v1/traces`, JSON
 * bodies), or a file with one OTLP/JSON request body per line, which any
 * collector's file receiver or a person with `jq` can read.
 *
 * The HTTP exporter never throws and never prints: it returns what happened
 * to each batch. Every attempt has a timeout; a refused or failed batch is
 * retried a bounded number of times with backoff (the collector's
 * `Retry-After` is honoured up to the cap) only when OTLP says the failure is
 * transient (408, 429, 502, 503, 504, or no response at all). Header values
 * are never part of an error message.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { type Batch, type BatchLimits, batches, resourceAttributes } from "./otlp.ts"
import type { Attributes, Span } from "./span.ts"

export interface OtlpHttpOptions {
  /** The collector's base URL (`http://localhost:4318`), or the full traces URL (`.../v1/traces`). */
  readonly endpoint: string
  readonly headers?: Readonly<Record<string, string>>
  /** Per attempt. Default 10 s. */
  readonly timeoutMs?: number
  /** Retries after the first attempt, per batch. Default 3. */
  readonly retries?: number
  /** First backoff; doubled per retry. Default 500 ms. */
  readonly backoffMs?: number
  /** The longest wait between attempts, `Retry-After` included. Default 5 s. */
  readonly maxBackoffMs?: number
  readonly limits?: BatchLimits
  readonly resource?: Attributes
  /** For tests. Default: the global `fetch`. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** For tests. Default: a timer. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface BatchOutcome {
  readonly ok: boolean
  readonly spans: number
  readonly attempts: number
  /** The last HTTP status, or `null` when no response came. */
  readonly status: number | null
  /** Why the batch failed, or the collector's partial-success message. Never contains a header value. */
  readonly error: string | null
  /** Spans the collector said it rejected (`partialSuccess.rejectedSpans`). */
  readonly rejectedSpans: number
}

export interface ExportReport {
  readonly batches: readonly BatchOutcome[]
  /** Spans in batches the collector accepted (minus what it said it rejected). */
  readonly sent: number
  /** Spans in batches that failed after every attempt, plus rejected ones. */
  readonly failed: number
}

/** The traces URL for an endpoint. */
export function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "")
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`
}

const TRANSIENT = new Set([408, 429, 502, 503, 504])

/** Sends the spans to a collector, batch by batch, in order. */
export async function exportOtlpHttp(spans: readonly Span[], options: OtlpHttpOptions): Promise<ExportReport> {
  const url = tracesUrl(options.endpoint)
  const outcomes: BatchOutcome[] = []
  for (const batch of batches(spans, options.limits, options.resource ?? resourceAttributes())) outcomes.push(await sendBatch(url, batch, options))
  return report(outcomes)
}

function report(outcomes: readonly BatchOutcome[]): ExportReport {
  const sent = outcomes.reduce((total, outcome) => total + (outcome.ok ? outcome.spans - outcome.rejectedSpans : 0), 0)
  const failed = outcomes.reduce((total, outcome) => total + (outcome.ok ? outcome.rejectedSpans : outcome.spans), 0)
  return { batches: outcomes, sent, failed }
}

async function sendBatch(url: string, batch: Batch, options: OtlpHttpOptions): Promise<BatchOutcome> {
  const send = options.fetch ?? ((target: string, init: RequestInit) => fetch(target, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retries = Math.max(0, options.retries ?? 3)
  const maxBackoff = options.maxBackoffMs ?? 5_000
  let backoff = options.backoffMs ?? 500
  let status: number | null = null
  let error: string | null = null
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
    let wait = backoff
    try {
      const response = await send(url, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: batch.body,
        signal: controller.signal,
      })
      status = response.status
      const text = await response.text().catch(() => "")
      if (response.ok) {
        const partial = partialSuccess(text)
        return { ok: true, spans: batch.spans, attempts: attempt, status, error: partial.message, rejectedSpans: partial.rejected }
      }
      error = `HTTP ${status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`
      if (!TRANSIENT.has(status)) return { ok: false, spans: batch.spans, attempts: attempt, status, error, rejectedSpans: 0 }
      const after = retryAfterMs(response.headers.get("retry-after"))
      if (after !== null) wait = after
    } catch (caught) {
      status = null
      error = controller.signal.aborted ? `no response within ${options.timeoutMs ?? 10_000} ms` : `request failed: ${caught instanceof Error ? caught.message : String(caught)}`
    } finally {
      clearTimeout(timer)
    }
    if (attempt <= retries) {
      await sleep(Math.min(wait, maxBackoff))
      backoff *= 2
    }
  }
  return { ok: false, spans: batch.spans, attempts: retries + 1, status, error, rejectedSpans: 0 }
}

function partialSuccess(text: string): { readonly rejected: number; readonly message: string | null } {
  try {
    const body = JSON.parse(text) as { partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } }
    const rejected = Number(body.partialSuccess?.rejectedSpans ?? 0)
    const message = body.partialSuccess?.errorMessage
    return { rejected: Number.isFinite(rejected) ? rejected : 0, message: message === undefined || message === "" ? null : message.slice(0, 200) }
  } catch {
    return { rejected: 0, message: null }
  }
}

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

export interface FileExportOptions {
  readonly limits?: BatchLimits
  readonly resource?: Attributes
  /** Add to the file instead of replacing it. */
  readonly append?: boolean
}

/** Writes the spans as OTLP/JSON request bodies, one per line. Returns how many lines (batches) were written. */
export function writeOtlpFile(path: string, spans: readonly Span[], options: FileExportOptions = {}): number {
  const lines = batches(spans, options.limits, options.resource ?? resourceAttributes()).map((batch) => `${batch.body}\n`)
  mkdirSync(dirname(path), { recursive: true })
  if (options.append) appendFileSync(path, lines.join(""))
  else writeFileSync(path, lines.join(""))
  return lines.length
}

export interface BackgroundExporter {
  /** Queues spans. Never throws, never waits; past `maxQueue` the oldest spans are dropped and counted. */
  readonly add: (spans: readonly Span[]) => void
  /** Sends what is queued. One send runs at a time; a flush during a send waits for it, then sends the rest. Never rejects. */
  readonly flush: () => Promise<void>
  readonly stats: () => { readonly queued: number; readonly dropped: number; readonly sent: number; readonly failed: number }
}

/**
 * For live export (README, "For the engine integrator"): a bounded queue in
 * front of a sender, so that whoever adds spans is never slowed down or
 * failed by the collector. `flushAt` spans in the queue start a flush.
 */
export function createBackgroundExporter(send: (spans: readonly Span[]) => Promise<ExportReport>, options: { readonly maxQueue?: number; readonly flushAt?: number } = {}): BackgroundExporter {
  const maxQueue = options.maxQueue ?? 2048
  const flushAt = options.flushAt ?? 512
  let queue: Span[] = []
  let running: Promise<void> | null = null
  const counts = { dropped: 0, sent: 0, failed: 0 }
  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const taken = queue
      queue = []
      try {
        const result = await send(taken)
        counts.sent += result.sent
        counts.failed += result.failed
      } catch {
        counts.failed += taken.length
      }
    }
  }
  const flush = (): Promise<void> => {
    if (running !== null) return running.then(flush)
    running = drain().finally(() => {
      running = null
    })
    return running
  }
  return {
    add: (spans) => {
      queue.push(...spans)
      if (queue.length > maxQueue) {
        counts.dropped += queue.length - maxQueue
        queue = queue.slice(queue.length - maxQueue)
      }
      if (queue.length >= flushAt && running === null) void flush()
    },
    flush,
    stats: () => ({ queued: queue.length, ...counts }),
  }
}
