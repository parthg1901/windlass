/**
 * One session with one MCP server over a channel: find out which era of the
 * protocol it speaks, list its tools, call them, and hear when the list changes.
 *
 * Era detection follows the specification's rules for a client that speaks
 * both eras:
 * - stdio: probe with `server/discover`. A `DiscoverResult` or a recognised
 *   modern error means modern; any other error means legacy. A legacy server
 *   may not answer the probe at all, and a modern one may just be slow to
 *   start, so after `probeMs` without an answer `initialize` is sent as well
 *   and whichever succeeds first decides.
 * - HTTP: a modern `server/discover`. A result or a recognised modern error
 *   means modern; a 4xx without one means legacy.
 * The configuration can fix the era (`protocol`), which skips the probe.
 *
 * Not supported, deliberately: resources, prompts, completion, logging,
 * sampling, elicitation and roots (the client declares no capabilities, so a
 * server must not ask for them; an `input_required` result is reported as an
 * error), the tasks extension, and the deprecated HTTP+SSE transport of 2024-11-05.
 */
import type { Json } from "../json.ts"
import type { Channel } from "./channel.ts"
import type { HttpChannel } from "./http.ts"
import {
  CLIENT_INFO,
  ERROR_CODES,
  type Incoming,
  type JsonObject,
  LEGACY_VERSIONS,
  META_SERVER_INFO,
  META_SUBSCRIPTION_ID,
  MODERN_VERSIONS,
  type McpCallResult,
  McpError,
  type McpToolDefinition,
  type RequestId,
  type ServerInfo,
  encodeHeaderValue,
  isModernError,
  isObject,
  modernMeta,
  parseCallResult,
  parseToolDefinition,
  readServerInfo,
  resultTypeOf,
} from "./protocol.ts"

export interface SessionOptions {
  /** Aborting it abandons the start-up. The caller times it out. */
  readonly signal: AbortSignal
  readonly protocol: "auto" | "modern" | "legacy"
  /** stdio only: how long the probe waits before `initialize` is sent alongside it. Default 2000 ms. */
  readonly probeMs?: number
}

export interface ToolListing {
  readonly tools: readonly McpToolDefinition[]
  /** Entries the harness cannot use, with the reason, for diagnostics. */
  readonly rejected: readonly { readonly name: string | null; readonly reason: string }[]
}

export interface CallOptions {
  readonly signal: AbortSignal
  /** Progress the server reports for this call, as text. */
  readonly onProgress?: (text: string) => void
}

export interface McpSession {
  readonly era: "modern" | "legacy"
  readonly protocolVersion: string
  readonly serverInfo: ServerInfo | null
  /** The server's own guidance for using it. Untrusted text. */
  readonly instructions: string | null
  readonly capabilities: JsonObject
  listTools(signal: AbortSignal): Promise<ToolListing>
  callTool(tool: McpToolDefinition, args: JsonObject, options: CallOptions): Promise<McpCallResult>
  /** Calls `onChange` whenever the server says its tool list changed. Call once, after the first listing. */
  watchTools(onChange: () => void): void
  /** Resolves with the reason once the session can do nothing more. */
  readonly closed: Promise<string>
  close(): Promise<void>
}

const MAX_PAGES = 100
const MAX_TOOLS = 10_000

export async function openSession(channel: Channel, options: SessionOptions): Promise<McpSession> {
  let nextId = 1
  const newId = () => nextId++
  const progress = new Map<string, (text: string) => void>()
  const subscriptions = new Map<string, (message: Extract<Incoming, { kind: "notification" }>) => void>()
  let legacyListChanged: (() => void) | null = null

  channel.onRequest((request) =>
    request.method === "ping" ? { result: {} } : { error: { code: ERROR_CODES.methodNotFound, message: `method not supported: ${request.method}`, data: undefined } },
  )
  channel.onNotification((message) => {
    const meta = isObject(message.params._meta) ? message.params._meta : {}
    const subscription = meta[META_SUBSCRIPTION_ID]
    if (subscription !== undefined) {
      subscriptions.get(String(subscription))?.(message)
      return
    }
    if (message.method === "notifications/progress") {
      const token = message.params.progressToken
      const report = token === undefined ? undefined : progress.get(String(token))
      if (report !== undefined) report(progressText(message.params))
      return
    }
    if (message.method === "notifications/tools/list_changed") legacyListChanged?.()
  })

  const negotiated = await negotiate(channel, options, newId)
  const http = channel.kind === "http" ? (channel as HttpChannel) : null
  const modern = negotiated.era === "modern"

  /** Sends a request in the negotiated era and returns its result. Rejects with an `McpError`. */
  const rpc = async (method: string, params: JsonObject, signal: AbortSignal, headers: Record<string, string> = {}): Promise<JsonObject> => {
    const outcome = await channel.request(
      { id: newId(), method, params: modern ? { ...params, _meta: { ...(isObject(params._meta) ? params._meta : {}), ...modernMeta(negotiated.version) } } : params },
      { signal, headers: modern ? { "mcp-method": method, ...headers } : headers },
    )
    if (!outcome.ok) throw new McpError("rpc", outcome.error.message, outcome.error, outcome.httpStatus)
    return outcome.result
  }

  const hasTools = isObject(negotiated.capabilities.tools)
  const listChanged = hasTools && isObject(negotiated.capabilities.tools) && negotiated.capabilities.tools.listChanged === true

  return {
    era: negotiated.era,
    protocolVersion: negotiated.version,
    serverInfo: negotiated.serverInfo,
    instructions: negotiated.instructions,
    capabilities: negotiated.capabilities,
    closed: channel.closed,
    close: () => channel.close(),

    listTools: async (signal) => {
      // A server that does not declare the tools capability has none to offer.
      if (!hasTools) return { tools: [], rejected: [] }
      const tools: McpToolDefinition[] = []
      const rejected: { name: string | null; reason: string }[] = []
      const names = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await rpc("tools/list", cursor === null ? {} : { cursor }, signal)
        if (resultTypeOf(result) !== "complete") throw new McpError("protocol", "tools/list did not return a complete result")
        if (!Array.isArray(result.tools)) throw new McpError("protocol", "the tools/list result has no tools array")
        for (const raw of result.tools) {
          const parsed = parseToolDefinition(raw, { http: channel.kind === "http" })
          if (!parsed.ok) rejected.push({ name: parsed.name, reason: parsed.reason })
          else if (names.has(parsed.tool.name)) rejected.push({ name: parsed.tool.name, reason: "a second tool with the same name" })
          else if (tools.length >= MAX_TOOLS) rejected.push({ name: parsed.tool.name, reason: `more than ${MAX_TOOLS} tools` })
          else {
            names.add(parsed.tool.name)
            tools.push(parsed.tool)
          }
        }
        const next = result.nextCursor
        if (typeof next !== "string" || next === "") return { tools, rejected }
        // A server that hands out the same cursor again would page forever.
        if (cursors.has(next)) throw new McpError("protocol", "tools/list returned a cursor it had returned before")
        cursors.add(next)
        cursor = next
      }
      throw new McpError("protocol", `tools/list returned more than ${MAX_PAGES} pages`)
    },

    callTool: async (tool, args, callOptions) => {
      const token = `progress-${newId()}`
      if (callOptions.onProgress !== undefined) progress.set(token, callOptions.onProgress)
      try {
        const headers: Record<string, string> = { "mcp-name": encodeHeaderValue(tool.name) }
        if (http !== null && modern)
          for (const param of tool.headerParams) {
            const value = valueAt(args, param.path)
            if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value)))
              headers[`mcp-param-${param.header.toLowerCase()}`] = encodeHeaderValue(String(value))
          }
        const result = await rpc("tools/call", { name: tool.name, arguments: args, _meta: { progressToken: token } }, callOptions.signal, modern ? headers : {})
        return parseCallResult(result)
      } finally {
        progress.delete(token)
      }
    },

    watchTools: (onChange) => {
      if (!listChanged) return
      if (!modern) {
        legacyListChanged = onChange
        http?.listenLegacy()
        return
      }
      // Modern: a long-lived `subscriptions/listen`, opened again whenever it ends while the session lives.
      void (async () => {
        let delay = 500
        let closed = false
        void channel.closed.then(() => (closed = true))
        while (!closed) {
          const id: RequestId = newId()
          const controller = new AbortController()
          void channel.closed.then(() => controller.abort(new Error("closed")))
          subscriptions.set(String(id), (message) => {
            if (message.method === "notifications/tools/list_changed") onChange()
          })
          const started = performance.now()
          try {
            await channel.request(
              { id, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: modernMeta(negotiated.version) } },
              { signal: controller.signal, headers: { "mcp-method": "subscriptions/listen" } },
            )
          } catch {
            // Ended by a transport failure; reopened below if the session still lives.
          } finally {
            subscriptions.delete(String(id))
          }
          if (closed) return
          // Changes may have been missed while the stream was down.
          onChange()
          if (performance.now() - started > 10_000) delay = 500
          await Bun.sleep(delay)
          delay = Math.min(delay * 2, 30_000)
        }
      })()
    },
  }
}

interface Negotiated {
  readonly era: "modern" | "legacy"
  readonly version: string
  readonly capabilities: JsonObject
  readonly serverInfo: ServerInfo | null
  readonly instructions: string | null
}

async function negotiate(channel: Channel, options: SessionOptions, newId: () => number): Promise<Negotiated> {
  if (options.protocol === "legacy") return initialize(channel, options.signal, newId)
  if (options.protocol === "modern") {
    const found = await discover(channel, options.signal, newId, MODERN_VERSIONS[0]!)
    if (found.kind === "modern") return found.negotiated
    throw new McpError("protocol", `the server did not answer server/discover as a ${MODERN_VERSIONS[0]} server: ${found.reason}`)
  }
  if (channel.kind === "http") {
    const found = await discover(channel, options.signal, newId, MODERN_VERSIONS[0]!)
    if (found.kind === "modern") return found.negotiated
    return initialize(channel, options.signal, newId)
  }
  return raceStdio(channel, options, newId)
}

/** stdio: the probe, with `initialize` sent as well once the probe has waited `probeMs`. The first success wins. */
async function raceStdio(channel: Channel, options: SessionOptions, newId: () => number): Promise<Negotiated> {
  const probeMs = options.probeMs ?? 2000
  const probe = new AbortController()
  const handshake = new AbortController()
  const abortAll = () => {
    probe.abort(options.signal.reason)
    handshake.abort(options.signal.reason)
  }
  options.signal.addEventListener("abort", abortAll, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<Negotiated>((resolve, reject) => {
      // The probe is pending until it answers; `legacy` is the handshake once it was sent.
      let probing = true
      let legacy: "unsent" | "pending" | "failed" = "unsent"
      let legacyError: unknown = null
      const startLegacy = () => {
        if (legacy !== "unsent") return
        legacy = "pending"
        initialize(channel, handshake.signal, newId).then(resolve, (error: unknown) => {
          legacy = "failed"
          legacyError = error
          // A modern server rejects `initialize`; its probe answer decides. Without one, this failure is the answer.
          if (!probing) reject(error)
        })
      }
      timer = setTimeout(startLegacy, probeMs)
      discover(channel, probe.signal, newId, MODERN_VERSIONS[0]!).then(
        (found) => {
          probing = false
          if (found.kind === "modern") return resolve(found.negotiated)
          if (legacy === "failed") return reject(legacyError)
          startLegacy()
        },
        (error: unknown) => {
          probing = false
          // The probe failed outright (the process died, a modern error): the handshake, if sent, may still succeed.
          if (legacy !== "pending") reject(legacy === "failed" ? legacyError : error)
        },
      )
    })
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener("abort", abortAll)
    probe.abort(new Error("negotiated"))
    handshake.abort(new Error("negotiated"))
  }
}

type Discovered = { readonly kind: "modern"; readonly negotiated: Negotiated } | { readonly kind: "legacy"; readonly reason: string }

async function discover(channel: Channel, signal: AbortSignal, newId: () => number, version: string, retried = false): Promise<Discovered> {
  if (channel.kind === "http") (channel as HttpChannel).setProtocolVersion(version)
  let outcome
  try {
    outcome = await channel.request(
      { id: newId(), method: "server/discover", params: { _meta: modernMeta(version) } },
      { signal, headers: { "mcp-method": "server/discover" } },
    )
  } catch (error) {
    // An HTTP status without a JSON-RPC body (a legacy server's 400, 404 or 405) is a legacy server.
    if (error instanceof McpError && error.kind === "transport" && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500)
      return { kind: "legacy", reason: error.message }
    throw error
  }
  if (outcome.ok) {
    const result = outcome.result
    const supported = Array.isArray(result.supportedVersions) ? result.supportedVersions.filter((v): v is string => typeof v === "string") : []
    if (!supported.includes(version)) {
      const other = MODERN_VERSIONS.find((candidate) => supported.includes(candidate))
      if (other !== undefined && !retried) return discover(channel, signal, newId, other, true)
      if (LEGACY_VERSIONS.some((candidate) => supported.includes(candidate))) return { kind: "legacy", reason: "the server supports only legacy versions" }
      throw new McpError("protocol", `the server supports protocol versions ${supported.join(", ") || "(none listed)"}, none of which this client speaks`)
    }
    const meta = isObject(result._meta) ? result._meta : {}
    return {
      kind: "modern",
      negotiated: {
        era: "modern",
        version,
        capabilities: isObject(result.capabilities) ? (result.capabilities as JsonObject) : {},
        serverInfo: readServerInfo(meta[META_SERVER_INFO] as Json | undefined),
        instructions: typeof result.instructions === "string" ? result.instructions : null,
      },
    }
  }
  const error = outcome.error
  if (error.code === ERROR_CODES.unsupportedProtocolVersion) {
    const data = isObject(error.data) ? error.data : {}
    const supported = Array.isArray(data.supported) ? data.supported.filter((v): v is string => typeof v === "string") : []
    const other = MODERN_VERSIONS.find((candidate) => supported.includes(candidate) && candidate !== version)
    if (other !== undefined && !retried) return discover(channel, signal, newId, other, true)
    if (LEGACY_VERSIONS.some((candidate) => supported.includes(candidate))) return { kind: "legacy", reason: "the server supports only legacy versions" }
    throw new McpError("protocol", `the server supports protocol versions ${supported.join(", ") || "(none listed)"}, none of which this client speaks`, error)
  }
  if (isModernError(error.code)) throw new McpError("rpc", `server/discover failed: ${error.message}`, error)
  return { kind: "legacy", reason: error.message }
}

async function initialize(channel: Channel, signal: AbortSignal, newId: () => number): Promise<Negotiated> {
  const http = channel.kind === "http" ? (channel as HttpChannel) : null
  http?.setProtocolVersion(null)
  http?.useLegacySession()
  const outcome = await channel.request(
    { id: newId(), method: "initialize", params: { protocolVersion: LEGACY_VERSIONS[0]!, capabilities: {}, clientInfo: CLIENT_INFO } },
    { signal },
  )
  if (!outcome.ok) throw new McpError("rpc", `initialize failed: ${outcome.error.message}`, outcome.error, outcome.httpStatus)
  const result = outcome.result
  const version = typeof result.protocolVersion === "string" ? result.protocolVersion : ""
  if (!LEGACY_VERSIONS.includes(version))
    throw new McpError("protocol", `the server answered initialize with protocol version ${JSON.stringify(version)}, which this client does not speak`)
  // The header exists from 2025-06-18 on; older servers do not expect it.
  if (version >= "2025-06-18") http?.setProtocolVersion(version)
  await channel.notify("notifications/initialized", {})
  return {
    era: "legacy",
    version,
    capabilities: isObject(result.capabilities) ? (result.capabilities as JsonObject) : {},
    serverInfo: readServerInfo(result.serverInfo),
    instructions: typeof result.instructions === "string" ? result.instructions : null,
  }
}

function progressText(params: JsonObject): string {
  const amount = typeof params.progress === "number" ? params.progress : null
  const total = typeof params.total === "number" ? params.total : null
  const message = typeof params.message === "string" ? params.message : ""
  const counter = amount === null ? "" : total === null ? `${amount}` : `${amount}/${total}`
  return [counter, message].filter((part) => part !== "").join(" ")
}

function valueAt(args: JsonObject, path: readonly string[]): Json | undefined {
  let node: Json | undefined = args
  for (const key of path) {
    if (!isObject(node)) return undefined
    node = (node as JsonObject)[key]
  }
  return node
}
