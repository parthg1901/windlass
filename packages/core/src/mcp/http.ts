/**
 * The streamable HTTP transport: every message is a POST to one endpoint, and
 * a request is answered with one JSON object or with an SSE stream scoped to
 * it (notifications about the request, then the response). Closing that
 * stream is the cancellation.
 *
 * The legacy shape (2025-03-26 to 2025-11-25) is the same plus a session: the
 * server may assign `Mcp-Session-Id` on `initialize`, which every later
 * request carries, server-initiated messages arrive on a GET stream, a
 * cancellation is also sent as `notifications/cancelled`, and DELETE ends the
 * session. The session (`client.ts`) switches this on with `useLegacySession`.
 */
import type { Channel, ChannelDiagnostics, OutgoingRequest, RequestHandler, RequestOptions, RpcOutcome } from "./channel.ts"
import { type Incoming, type JsonObject, McpError, excerpt, parseIncoming } from "./protocol.ts"

export interface HttpOptions {
  readonly url: string
  /** Sent with every request (authentication). Already expanded. */
  readonly headers: Readonly<Record<string, string>>
  /** Default 32 MiB, for a JSON body and for each SSE event. */
  readonly maxMessageBytes?: number
}

export interface HttpChannel extends Channel {
  /** The `MCP-Protocol-Version` header for every later request; `null` sends none. */
  setProtocolVersion(version: string | null): void
  /** Switches on the legacy session behaviour: the session ID, cancellation notifications, DELETE on close. */
  useLegacySession(): void
  /** Opens the legacy GET stream for server-initiated messages and keeps it open while the channel lives. */
  listenLegacy(): void
}

export function openHttpChannel(options: HttpOptions): HttpChannel {
  const maxMessageBytes = options.maxMessageBytes ?? 32 * 1024 * 1024
  let protocolVersion: string | null = null
  let legacy = false
  let sessionId: string | null = null
  let notificationHandler: (message: Extract<Incoming, { kind: "notification" }>) => void = () => {}
  let requestHandler: RequestHandler | null = null
  let closeReason: string | null = null
  let resolveClosed: (reason: string) => void = () => {}
  const closed = new Promise<string>((resolve) => (resolveClosed = resolve))
  const inFlight = new Set<AbortController>()
  let listening = false

  const finish = (reason: string) => {
    if (closeReason !== null) return
    closeReason = reason
    resolveClosed(reason)
    for (const controller of inFlight) controller.abort(new Error(reason))
    inFlight.clear()
  }

  const baseHeaders = (extra: Readonly<Record<string, string>> = {}) => {
    const headers: Record<string, string> = {
      ...options.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extra,
    }
    if (protocolVersion !== null) headers["mcp-protocol-version"] = protocolVersion
    if (legacy && sessionId !== null) headers["mcp-session-id"] = sessionId
    return headers
  }

  const route = (message: Incoming, expectId: string | null): RpcOutcome | null => {
    if (message.kind === "result" || message.kind === "error") {
      if (expectId === null || message.id === null || String(message.id) !== expectId) return null
      return message.kind === "result" ? { ok: true, result: message.result } : { ok: false, error: message.error, httpStatus: null }
    }
    if (message.kind === "notification") notificationHandler(message)
    else {
      const answer = requestHandler?.(message) ?? { error: { code: -32601, message: `method not found: ${message.method}`, data: undefined } }
      void post("result" in answer ? { id: message.id, result: answer.result } : { id: message.id, error: answer.error }).catch(() => {})
    }
    return null
  }

  /** Sends one message and returns the raw response. Rejects with an `McpError`. */
  const post = async (body: object, signal?: AbortSignal, extra?: Readonly<Record<string, string>>) => {
    if (closeReason !== null) throw new McpError("closed", closeReason)
    const controller = new AbortController()
    inFlight.add(controller)
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const response = await fetch(options.url, {
        method: "POST",
        headers: baseHeaders(extra),
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal: controller.signal,
      })
      if (legacy) {
        const assigned = response.headers.get("mcp-session-id")
        if (assigned !== null && assigned !== "") sessionId = assigned
      }
      return { response, controller, release: () => (inFlight.delete(controller), signal?.removeEventListener("abort", onAbort)) }
    } catch (error) {
      inFlight.delete(controller)
      signal?.removeEventListener("abort", onAbort)
      if (signal?.aborted) throw new McpError("cancelled", reasonText(signal))
      if (closeReason !== null) throw new McpError("closed", closeReason)
      const message = `could not reach ${options.url}: ${error instanceof Error ? error.message : String(error)}`
      finish(message)
      throw new McpError("transport", message)
    }
  }

  const request = async (message: OutgoingRequest, requestOptions: RequestOptions): Promise<RpcOutcome> => {
    if (requestOptions.signal.aborted) throw new McpError("cancelled", "cancelled before it was sent")
    const expectId = String(message.id)
    const { response, release } = await post({ id: message.id, method: message.method, params: message.params }, requestOptions.signal, requestOptions.headers)
    try {
      // A legacy server forgets an expired or unknown session with 404; the client must start over.
      if (legacy && sessionId !== null && response.status === 404) {
        finish("the server ended the session (HTTP 404)")
        throw new McpError("closed", "the server ended the session (HTTP 404)")
      }
      const type = response.headers.get("content-type") ?? ""
      if (type.includes("text/event-stream") && response.body !== null) {
        for await (const event of readSse(response.body, maxMessageBytes)) {
          const outcome = parseData(event.data)
          if (outcome === null) continue
          const routed = route(outcome, expectId)
          if (routed !== null) return routed.ok ? routed : { ...routed, httpStatus: response.status }
        }
        throw new McpError("closed", "the response stream ended before the response arrived")
      }
      const text = response.body === null ? "" : await readBounded(response.body, maxMessageBytes)
      const parsed = parseData(text)
      if (parsed !== null && (parsed.kind === "result" || parsed.kind === "error")) {
        if (parsed.kind === "error") return { ok: false, error: parsed.error, httpStatus: response.status }
        if (String(parsed.id) === expectId) return { ok: true, result: parsed.result }
      }
      if (!response.ok) throw new McpError("transport", `HTTP ${response.status}${text.trim() === "" ? "" : `: ${excerpt(text, 200)}`}`, null, response.status)
      throw new McpError("protocol", `the response is not a JSON-RPC response to the request${text === "" ? "" : `: ${excerpt(text, 200)}`}`, null, response.status)
    } catch (error) {
      if (requestOptions.signal.aborted) {
        if (legacy) void notify("notifications/cancelled", { requestId: message.id, reason: reasonText(requestOptions.signal) }).catch(() => {})
        throw new McpError("cancelled", reasonText(requestOptions.signal))
      }
      if (error instanceof McpError) throw error
      if (closeReason !== null) throw new McpError("closed", closeReason)
      throw new McpError("transport", `the response from ${options.url} broke off: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      release()
    }
  }

  const notify = async (method: string, params: JsonObject) => {
    const { response, release } = await post({ method, params })
    release()
    await response.body?.cancel().catch(() => {})
    if (!response.ok) throw new McpError("transport", `HTTP ${response.status} for the ${method} notification`, null, response.status)
  }

  const listenLegacy = () => {
    if (listening) return
    listening = true
    void (async () => {
      let delay = 500
      while (closeReason === null) {
        const controller = new AbortController()
        inFlight.add(controller)
        try {
          const headers = baseHeaders({ accept: "text/event-stream" })
          delete headers["content-type"]
          const response = await fetch(options.url, { method: "GET", headers, signal: controller.signal })
          // 405: the server offers no stream. Change notifications then never arrive, which is allowed.
          if (response.status === 405 || response.status === 404) return
          if (response.ok && response.body !== null) {
            delay = 500
            for await (const event of readSse(response.body, maxMessageBytes)) {
              const message = parseData(event.data)
              if (message !== null) route(message, null)
            }
          }
        } catch {
          // The stream broke off; it is opened again below.
        } finally {
          inFlight.delete(controller)
        }
        if (closeReason !== null) return
        await Bun.sleep(delay)
        delay = Math.min(delay * 2, 30_000)
      }
    })()
  }

  return {
    kind: "http",
    request,
    notify,
    onNotification: (handler) => {
      notificationHandler = handler
    },
    onRequest: (handler) => {
      requestHandler = handler
    },
    closed,
    close: async () => {
      const id = legacy ? sessionId : null
      finish("the client closed the connection")
      if (id === null) return
      // Best effort: tell a legacy server the session is over.
      const headers: Record<string, string> = { ...options.headers, "mcp-session-id": id }
      if (protocolVersion !== null) headers["mcp-protocol-version"] = protocolVersion
      await fetch(options.url, { method: "DELETE", headers, signal: AbortSignal.timeout(2000) }).then(
        (response) => response.body?.cancel(),
        () => {},
      )
    },
    diagnostics: (): ChannelDiagnostics => ({ pid: null, stderrTail: "", garbageLines: 0, garbageSamples: [] }),
    setProtocolVersion: (version) => {
      protocolVersion = version
    },
    useLegacySession: () => {
      legacy = true
    },
    listenLegacy,
  }
}

function parseData(text: string): Incoming | null {
  try {
    return parseIncoming(JSON.parse(text))
  } catch {
    return null
  }
}

function reasonText(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason.message : "cancelled"
}

async function readBounded(body: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) return text + decoder.decode()
    total += next.value.length
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new McpError("protocol", `the response is longer than ${max} bytes`)
    }
    text += decoder.decode(next.value, { stream: true })
  }
}

export interface SseEvent {
  readonly event: string
  readonly data: string
}

/** Reads Server-Sent Events. Comments and `id`/`retry` fields are ignored; an event larger than `max` bytes ends the stream with an error. */
export async function* readSse(body: ReadableStream<Uint8Array>, max: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  let event = "message"
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      if (buffer.length > max * 2) throw new McpError("protocol", `an event of the response stream is longer than ${max} bytes`)
      const lines = buffer.split(/\r\n|\r|\n/)
      // The last piece may be an incomplete line, unless the stream ended.
      buffer = next.done ? "" : lines.pop()!
      for (const line of lines) {
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") }
          data = []
          event = "message"
          size = 0
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
        if (field === "data") {
          size += value.length
          if (size > max) throw new McpError("protocol", `an event of the response stream is longer than ${max} bytes`)
          data.push(value)
        } else if (field === "event") event = value
      }
      if (next.done) {
        if (data.length > 0) yield { event, data: data.join("\n") }
        return
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
