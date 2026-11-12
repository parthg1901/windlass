/**
 * A scripted MCP server over streamable HTTP, for tests and the demo.
 * `startHttpFixture` runs it in the calling process on a free port of
 * 127.0.0.1; running this file starts one and prints its URL.
 *
 * - `modern` (2026-07-28): POST only; checks that the MCP-Protocol-Version,
 *   Mcp-Method, Mcp-Name and Mcp-Param-* headers match the body and rejects
 *   the request with HeaderMismatch otherwise; long calls answer on an SSE
 *   stream and closing it cancels them; `subscriptions/listen` is a stream.
 * - `legacy` (2025-06-18): `initialize` assigns Mcp-Session-Id, which every
 *   later request must carry (400 otherwise, as the official SDK answers);
 *   change notifications go to the GET stream; DELETE ends the session.
 */
import { UnknownTool, createBehaviour, parseFlags, readOptions } from "./behaviour.ts"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type Obj = { [key: string]: JsonValue }

const MODERN = "2026-07-28"

export interface HttpFixture {
  readonly url: string
  /** Events: `call echo`, `cancelled 5`, `header-mismatch ...`, `session ended`. */
  readonly events: string[]
  stop(): Promise<void>
}

export function startHttpFixture(options: { readonly era: "modern" | "legacy"; readonly flags?: readonly string[] }): HttpFixture {
  const flags = parseFlags(options.flags ?? [])
  const events: string[] = []
  const encoder = new TextEncoder()
  const listeners = new Set<(data: Obj) => void>()
  let session: string | null = null
  const behaviour = createBehaviour(readOptions(flags), () => {
    for (const listener of listeners) listener({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
  })
  const name = flags.get("name") ?? `http-${options.era}`

  const json = (body: Obj, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
  const rpcError = (id: JsonValue, code: number, message: string, status = 200, data?: JsonValue) =>
    json({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } }, status)

  const sse = (request: Request, start: (push: (data: Obj) => void, close: () => void, signal: AbortSignal) => void) => {
    const controller = new AbortController()
    request.signal.addEventListener("abort", () => controller.abort(), { once: true })
    let open = true
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          const close = () => {
            if (!open) return
            open = false
            try {
              stream.close()
            } catch {
              // The client went away first.
            }
          }
          const push = (data: Obj) => {
            if (!open) return
            try {
              stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`))
            } catch {
              open = false
            }
          }
          stream.enqueue(encoder.encode(": stream open\n\n"))
          start(push, close, controller.signal)
        },
        cancel() {
          open = false
          controller.abort()
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } },
    )
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const headers = Object.fromEntries([...request.headers].map(([key, value]) => [key.toLowerCase(), value]))
      if (options.era === "modern" && request.method !== "POST") return new Response(null, { status: 405 })
      if (options.era === "legacy" && request.method === "DELETE") {
        events.push("session ended")
        session = null
        return new Response(null, { status: 200 })
      }
      if (options.era === "legacy" && request.method === "GET") {
        if (session === null || headers["mcp-session-id"] !== session) return new Response("no session", { status: 400 })
        return sse(request, (push, _close, signal) => {
          listeners.add(push)
          signal.addEventListener("abort", () => listeners.delete(push), { once: true })
        })
      }
      let message: Obj
      try {
        message = (await request.json()) as Obj
      } catch {
        return rpcError(null, -32700, "Parse error", 400)
      }
      const method = String(message.method)
      const id = message.id
      const params = (message.params ?? {}) as Obj
      const meta = (params._meta ?? {}) as Obj

      if (options.era === "legacy") {
        if (method === "initialize") {
          session = crypto.randomUUID()
          return json(
            {
              jsonrpc: "2.0",
              id: id as JsonValue,
              result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name, version: "1.0.0" } },
            },
            200,
            { "mcp-session-id": session },
          )
        }
        if (session === null || headers["mcp-session-id"] !== session) return rpcError(null, -32000, "Bad Request: No valid session ID provided", 400)
      } else {
        // Modern: the headers must match the body.
        const version = meta["io.modelcontextprotocol/protocolVersion"]
        if (id !== undefined) {
          if (typeof version !== "string") return rpcError(id as JsonValue, -32602, "missing io.modelcontextprotocol/protocolVersion", 400)
          const mismatch =
            headers["mcp-protocol-version"] !== version
              ? "MCP-Protocol-Version"
              : headers["mcp-method"] !== method
                ? "Mcp-Method"
                : method === "tools/call" && decodeHeader(headers["mcp-name"]) !== params.name
                  ? "Mcp-Name"
                  : method === "tools/call" &&
                      params.name === "region" &&
                      decodeHeader(headers["mcp-param-region"]) !== ((params.arguments ?? {}) as Obj).region
                    ? "Mcp-Param-Region"
                    : null
          if (mismatch !== null) {
            events.push(`header-mismatch ${mismatch}`)
            return rpcError(id as JsonValue, -32020, `Header mismatch: ${mismatch}`, 400)
          }
          if (version !== MODERN) return rpcError(id as JsonValue, -32022, "Unsupported protocol version", 400, { supported: [MODERN], requested: version })
        }
      }

      if (id === undefined) {
        if (method === "notifications/cancelled") events.push(`cancelled ${String(params.requestId)}`)
        return new Response(null, { status: 202 })
      }
      const result = (body: Obj) => ({ jsonrpc: "2.0", id: id as JsonValue, result: options.era === "modern" ? { resultType: "complete", ...body } : body })

      switch (method) {
        case "server/discover":
          return json(
            result({
              supportedVersions: [MODERN],
              capabilities: { tools: { listChanged: true } },
              _meta: { "io.modelcontextprotocol/serverInfo": { name, version: "1.0.0" } },
              ttlMs: 0,
              cacheScope: "private",
            }),
          )
        case "tools/list":
          return json(result({ ...behaviour.list(params.cursor), ...(options.era === "modern" ? { ttlMs: 0, cacheScope: "private" } : {}) }))
        case "subscriptions/listen":
          return sse(request, (push, _close, signal) => {
            const tagged = (data: Obj) =>
              push({ ...data, params: { ...((data.params ?? {}) as Obj), _meta: { "io.modelcontextprotocol/subscriptionId": id as JsonValue } } })
            tagged({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: { toolsListChanged: true } } })
            listeners.add(tagged)
            signal.addEventListener("abort", () => listeners.delete(tagged), { once: true })
          })
        case "tools/call": {
          const toolName = String(params.name)
          const args = (params.arguments ?? {}) as Obj
          const token = meta.progressToken
          const run = (signal: AbortSignal, push: ((data: Obj) => void) | null) =>
            behaviour.call(toolName, args, {
              signal,
              headers,
              progress: (progress, total, text) => {
                if (push !== null && token !== undefined)
                  push({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress, total, message: text } })
              },
              crash: () => {
                throw new Error("the HTTP fixture cannot crash")
              },
            })
          if (toolName === "hang" || toolName === "slow")
            return sse(request, (push, close, signal) => {
              signal.addEventListener("abort", () => events.push(`cancelled ${String(id)}`), { once: true })
              run(signal, push).then(
                (body) => {
                  if (!signal.aborted) push(result(body))
                  close()
                },
                () => close(),
              )
            })
          try {
            return json(result(await run(request.signal, null)))
          } catch (error) {
            if (error instanceof UnknownTool) return json({ jsonrpc: "2.0", id: id as JsonValue, error: { code: -32602, message: `Unknown tool: ${error.message}` } })
            return json({ jsonrpc: "2.0", id: id as JsonValue, error: { code: -32603, message: String(error) } })
          }
        }
        default:
          return rpcError(id as JsonValue, -32601, `Method not found: ${method}`, options.era === "modern" ? 404 : 200)
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    events,
    stop: async () => {
      listeners.clear()
      await server.stop(true)
    },
  }
}

function decodeHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = /^=\?base64\?(.*)\?=$/.exec(value)
  return match === null ? value : Buffer.from(match[1]!, "base64").toString("utf8")
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2))
  const fixture = startHttpFixture({ era: flags.get("era") === "legacy" ? "legacy" : "modern", flags: process.argv.slice(2) })
  console.log(fixture.url)
}
