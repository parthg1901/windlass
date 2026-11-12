/**
 * The OTLP/JSON encoding of traces (an `ExportTraceServiceRequest`, as
 * `opentelemetry-proto` defines it and the OTLP specification maps it to
 * JSON): trace and span IDs as lowercase hex, times as decimal strings of
 * nanoseconds, 64-bit integers as decimal strings, enums as their numbers.
 * Written by hand: `packages/core` has no dependencies.
 */
import { brand } from "../brand.ts"
import type { AttributeValue, Attributes, Span } from "./span.ts"

/** The instrumentation scope every span is reported under. */
export const SCOPE = { name: `${brand.name}/telemetry`, version: "1" } as const

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } }

export interface OtlpKeyValue {
  readonly key: string
  readonly value: OtlpAnyValue
}

export interface OtlpSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly name: string
  readonly kind: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: readonly OtlpKeyValue[]
  readonly events: readonly { readonly timeUnixNano: string; readonly name: string; readonly attributes: readonly OtlpKeyValue[] }[]
  readonly links: readonly { readonly traceId: string; readonly spanId: string; readonly attributes: readonly OtlpKeyValue[] }[]
  readonly status: { readonly code: number; readonly message?: string }
}

export interface ExportTraceServiceRequest {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly OtlpKeyValue[] }
    readonly scopeSpans: readonly { readonly scope: { readonly name: string; readonly version: string }; readonly spans: readonly OtlpSpan[] }[]
  }[]
}

/** `SPAN_KIND_INTERNAL` and `SPAN_KIND_CLIENT`. */
const KIND = { internal: 1, client: 3 } as const
/** `STATUS_CODE_UNSET`, `_OK`, `_ERROR`. */
const STATUS = { unset: 0, ok: 1, error: 2 } as const

/** The resource every batch describes: the harness as a service. */
export function resourceAttributes(extra: Attributes = {}): Attributes {
  return { "service.name": brand.name, ...extra }
}

export function anyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  return { arrayValue: { values: (value as readonly AttributeValue[]).map(anyValue) } }
}

export function keyValues(attributes: Attributes): OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }))
}

/** Milliseconds as OTLP's nanoseconds, exactly: a millisecond epoch times 10^6 is past what a double holds. */
export function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

export function encodeSpan(span: Span): OtlpSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === null ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: KIND[span.kind],
    startTimeUnixNano: nanos(span.startMs),
    endTimeUnixNano: nanos(span.endMs),
    attributes: keyValues(span.attributes),
    events: span.events.map((event) => ({ timeUnixNano: nanos(event.timeMs), name: event.name, attributes: keyValues(event.attributes) })),
    links: span.links.map((link) => ({ traceId: link.traceId, spanId: link.spanId, attributes: keyValues(link.attributes) })),
    status: { code: STATUS[span.status.code], ...(span.status.message ? { message: span.status.message } : {}) },
  }
}

/** One request body for these spans. */
export function encodeRequest(spans: readonly Span[], resource: Attributes = resourceAttributes()): ExportTraceServiceRequest {
  return { resourceSpans: [{ resource: { attributes: keyValues(resource) }, scopeSpans: [{ scope: SCOPE, spans: spans.map(encodeSpan) }] }] }
}

export interface BatchLimits {
  /** Spans per request. Default 512, the OpenTelemetry SDKs' default batch size. */
  readonly maxSpans?: number
  /** Bytes of JSON per request. Default 1 MiB; a single larger span is sent alone. */
  readonly maxBytes?: number
}

/** One request body: its JSON text and how many spans it holds. */
export interface Batch {
  readonly body: string
  readonly spans: number
}

/** Splits spans into request bodies within the limits, in order. */
export function batches(spans: readonly Span[], limits: BatchLimits = {}, resource: Attributes = resourceAttributes()): Batch[] {
  const maxSpans = limits.maxSpans ?? 512
  const maxBytes = limits.maxBytes ?? 1024 * 1024
  const out: Batch[] = []
  let group: Span[] = []
  let bytes = 0
  const flush = () => {
    if (group.length > 0) out.push({ body: JSON.stringify(encodeRequest(group, resource)), spans: group.length })
    group = []
    bytes = 0
  }
  for (const span of spans) {
    const size = JSON.stringify(encodeSpan(span)).length + 1
    if (group.length > 0 && (group.length >= maxSpans || bytes + size > maxBytes)) flush()
    group.push(span)
    bytes += size
  }
  flush()
  return out
}
