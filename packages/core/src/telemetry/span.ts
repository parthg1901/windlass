/**
 * The span model the mapping produces and the exporters encode: a plain value
 * with no OpenTelemetry SDK behind it. Times are the milliseconds the log
 * stored; IDs are lowercase hex (32 characters for a trace, 16 for a span),
 * derived from the session ID and positions in its log (`ids.ts`), so the
 * same session exported twice gives the same IDs.
 */
import { createHash } from "node:crypto"
import { brand } from "../brand.ts"

/** The attribute namespace for what the GenAI conventions have no name for: the brand's directory name, as an identifier. */
export const NAMESPACE = brand.directory.toLowerCase().replace(/[^a-z0-9]+/g, "_")

/** `<namespace>.<name>`: a harness attribute. */
export function attr(name: string): string {
  return `${NAMESPACE}.${name}`
}

export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[]
export type Attributes = Record<string, AttributeValue>

export type SpanKind = "internal" | "client"

export interface SpanEvent {
  readonly name: string
  readonly timeMs: number
  readonly attributes: Attributes
}

export interface SpanLink {
  readonly traceId: string
  readonly spanId: string
  readonly attributes: Attributes
}

export interface SpanStatus {
  readonly code: "unset" | "ok" | "error"
  readonly message?: string
}

export interface Span {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly kind: SpanKind
  readonly startMs: number
  /** For a span whose closing event is not in the log yet: the time of the last event, with `open` set. */
  readonly endMs: number
  /** The closing event is not in the log (the session is still running, or the process died there). */
  readonly open: boolean
  /** The session whose log the span was derived from. Not exported as such: `gen_ai.conversation.id` carries it. */
  readonly sessionId: string
  readonly attributes: Attributes
  readonly events: readonly SpanEvent[]
  readonly links: readonly SpanLink[]
  readonly status: SpanStatus
}

/** A span's place in a trace, for a span that is a child of one made elsewhere (a subagent's turn under its parent's spawn). */
export interface SpanContext {
  readonly traceId: string
  readonly spanId: string
}

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.map(String).join("\u0000"), "utf8").digest("hex")
}

/** A trace ID (16 bytes) from the parts. Never all zeros, which OTLP reserves for "no trace". */
export function traceIdOf(...parts: readonly (string | number)[]): string {
  return nonZero(digest(["trace", ...parts]).slice(0, 32))
}

/** A span ID (8 bytes) from the parts. Never all zeros. */
export function spanIdOf(...parts: readonly (string | number)[]): string {
  return nonZero(digest(["span", ...parts]).slice(0, 16))
}

function nonZero(hex: string): string {
  return /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex
}
