/**
 * A channel carries JSON-RPC messages between the client and one server. Its
 * two kinds differ in how a request travels and how it is cancelled:
 *
 * - stdio (`stdio.ts`): one child process, one newline-delimited stream each
 *   way, responses matched by ID; cancellation is a `notifications/cancelled`.
 * - streamable HTTP (`http.ts`): one POST per message, answered with JSON or
 *   an SSE stream scoped to that request; cancellation is closing that stream.
 *
 * The session (`client.ts`) above it is the same for both.
 */
import type { Incoming, JsonObject, RequestId, RpcError } from "./protocol.ts"

export interface OutgoingRequest {
  readonly id: RequestId
  readonly method: string
  readonly params: JsonObject
}

export interface RequestOptions {
  /** Aborting it cancels the request on the wire; the promise then rejects with an `McpError` of kind `cancelled`. */
  readonly signal: AbortSignal
  /** Extra HTTP headers for this request (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`). Ignored by stdio. */
  readonly headers?: Readonly<Record<string, string>>
}

/** The server's answer. A transport failure is not an answer: the promise rejects with an `McpError` instead. */
export type RpcOutcome =
  | { readonly ok: true; readonly result: JsonObject }
  | { readonly ok: false; readonly error: RpcError; readonly httpStatus: number | null }

/** A message from the server that is not the response to a pending request. */
export type ServerMessage = Extract<Incoming, { kind: "notification" } | { kind: "request" }>

/** How the client answers a request the server sends (legacy servers send `ping`). */
export type RequestHandler = (request: Extract<Incoming, { kind: "request" }>) => { readonly result: JsonObject } | { readonly error: RpcError }

export interface Channel {
  readonly kind: "stdio" | "http"
  request(message: OutgoingRequest, options: RequestOptions): Promise<RpcOutcome>
  notify(method: string, params: JsonObject): Promise<void>
  /** Receives notifications, and requests after `onRequest` has answered them. Set once by the session. */
  onNotification(handler: (message: Extract<Incoming, { kind: "notification" }>) => void): void
  onRequest(handler: RequestHandler): void
  /** Resolves with the reason once the channel can carry nothing more (the process exited, the session ended). */
  readonly closed: Promise<string>
  /** Ends the channel and, for stdio, the server's whole process group. Idempotent. */
  close(): Promise<void>
  /** What helps explain a failure: the tail of stderr, lines that were not JSON-RPC. */
  diagnostics(): ChannelDiagnostics
}

export interface ChannelDiagnostics {
  readonly pid: number | null
  /** The last bytes the server wrote to stderr, for a failure message. */
  readonly stderrTail: string
  /** Lines on stdout that were not JSON-RPC messages, and the first few of them. */
  readonly garbageLines: number
  readonly garbageSamples: readonly string[]
}
