/**
 * The parts of the Model Context Protocol a tool-using client needs, as data:
 * versions, JSON-RPC message shapes, error codes, and the parsing of tool
 * definitions and tool results. Nothing here does I/O.
 *
 * Two eras of the protocol are in use and both are supported:
 * - modern (2026-07-28): stateless. Every request carries its protocol version
 *   and the client's capabilities in `_meta`; `server/discover` replaces the
 *   handshake; list changes arrive on a `subscriptions/listen` stream.
 * - legacy (2025-11-25 and earlier): an `initialize` request and an
 *   `notifications/initialized` notification open a session; list changes are
 *   sent unprompted.
 */
import { brand } from "../brand.ts"
import type { Json } from "../json.ts"

/** The modern revision this client speaks, newest first. */
export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"]
/** Handshake-based revisions this client falls back to, newest first. The first is offered in `initialize`. */
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

export const CLIENT_INFO = { name: brand.name, version: "0.0.0" } as const

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId"
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const

/** Errors only a modern server sends. Receiving one means the server is modern, whatever else went wrong. */
export function isModernError(code: number) {
  return code === ERROR_CODES.headerMismatch || code === ERROR_CODES.missingRequiredClientCapability || code === ERROR_CODES.unsupportedProtocolVersion
}

export type JsonObject = { readonly [key: string]: Json }
export type RequestId = number | string

export interface RpcError {
  readonly code: number
  readonly message: string
  readonly data: Json | undefined
}

/** One message read from a server. */
export type Incoming =
  | { readonly kind: "result"; readonly id: RequestId; readonly result: JsonObject }
  | { readonly kind: "error"; readonly id: RequestId | null; readonly error: RpcError }
  | { readonly kind: "request"; readonly id: RequestId; readonly method: string; readonly params: JsonObject }
  | { readonly kind: "notification"; readonly method: string; readonly params: JsonObject }

/** Why a request did not produce a result. `rpc` is the server's own JSON-RPC error. */
export type McpErrorKind = "timeout" | "cancelled" | "closed" | "transport" | "protocol" | "rpc" | "start"

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly rpc: RpcError | null = null,
    /** The HTTP status, when an HTTP response carried the failure. */
    readonly httpStatus: number | null = null,
  ) {
    super(message)
    this.name = "McpError"
  }
}

/** Reads one JSON value as a message. `null` for anything that is not JSON-RPC 2.0. */
export function parseIncoming(value: unknown): Incoming | null {
  if (!isObject(value) || value.jsonrpc !== "2.0") return null
  const id = value.id
  const validId = typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
  if (typeof value.method === "string") {
    const params = isObject(value.params) ? (value.params as JsonObject) : {}
    if (validId) return { kind: "request", id: id as RequestId, method: value.method, params }
    if (id === undefined) return { kind: "notification", method: value.method, params }
    return null
  }
  if (isObject(value.error)) {
    const error = value.error
    if (typeof error.code !== "number" || typeof error.message !== "string") return null
    return {
      kind: "error",
      id: validId ? (id as RequestId) : null,
      error: { code: error.code, message: error.message, data: error.data as Json | undefined },
    }
  }
  if (validId && isObject(value.result)) return { kind: "result", id: id as RequestId, result: value.result as JsonObject }
  return null
}

/** The `_meta` every modern request carries. */
export function modernMeta(version: string): JsonObject {
  return { [META_PROTOCOL_VERSION]: version, [META_CLIENT_INFO]: CLIENT_INFO, [META_CLIENT_CAPABILITIES]: {} }
}

/**
 * The `resultType` of a result. An absent field is `complete` (servers of
 * earlier revisions do not send it); a value this client does not know is
 * invalid, as the specification requires.
 */
export function resultTypeOf(result: JsonObject): "complete" | "input_required" | "invalid" {
  const type = result.resultType
  if (type === undefined || type === "complete") return "complete"
  if (type === "input_required") return "input_required"
  return "invalid"
}

export interface ServerInfo {
  readonly name: string
  readonly version: string
}

export function readServerInfo(value: Json | undefined): ServerInfo | null {
  if (!isObject(value) || typeof value.name !== "string") return null
  return { name: value.name, version: typeof value.version === "string" ? value.version : "" }
}

/** A parameter the HTTP transport mirrors into an `Mcp-Param-<header>` header (`x-mcp-header`). */
export interface HeaderParam {
  readonly header: string
  /** The chain of `properties` keys from the schema root to the parameter. */
  readonly path: readonly string[]
}

/** A tool as a server lists it, reduced to what the harness uses. */
export interface McpToolDefinition {
  readonly name: string
  readonly title: string | null
  readonly description: string
  /** The tool's JSON Schema for its arguments, as the server sent it. */
  readonly inputSchema: JsonObject
  readonly headerParams: readonly HeaderParam[]
}

export type ParsedTool = { readonly ok: true; readonly tool: McpToolDefinition } | { readonly ok: false; readonly name: string | null; readonly reason: string }

const MAX_TOOL_NAME = 128

/**
 * Validates one entry of a `tools/list` result. A tool the harness cannot
 * use is rejected with a reason instead of failing the whole list. On HTTP an
 * invalid `x-mcp-header` annotation rejects the tool, as the transport requires.
 */
export function parseToolDefinition(raw: Json, options: { readonly http: boolean }): ParsedTool {
  if (!isObject(raw)) return { ok: false, name: null, reason: "not an object" }
  const name = raw.name
  if (typeof name !== "string" || name === "") return { ok: false, name: null, reason: "no name" }
  // The name is shown on one line and typed back by the model; control characters and very long names are unusable.
  if (name.length > MAX_TOOL_NAME || /[\u0000-\u001f\u007f\s/]/.test(name))
    return { ok: false, name: excerpt(name, 60), reason: "the name is longer than 128 characters or contains spaces, '/' or control characters" }
  const inputSchema = raw.inputSchema
  if (!isObject(inputSchema)) return { ok: false, name, reason: "inputSchema is not a JSON Schema object" }
  const headerParams = options.http ? readHeaderParams(inputSchema as JsonObject) : { ok: true as const, params: [] }
  if (!headerParams.ok) return { ok: false, name, reason: headerParams.reason }
  return {
    ok: true,
    tool: {
      name,
      title: typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : null,
      description: typeof raw.description === "string" ? raw.description : "",
      inputSchema: inputSchema as JsonObject,
      headerParams: headerParams.params,
    },
  }
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Reads the `x-mcp-header` annotations of a schema, which are valid only on primitive properties reachable through `properties` alone. */
function readHeaderParams(schema: JsonObject): { ok: true; params: HeaderParam[] } | { ok: false; reason: string } {
  const params: HeaderParam[] = []
  const reachable = new Set<Json>()
  const walk = (node: JsonObject, path: string[]) => {
    reachable.add(node)
    const properties = node.properties
    if (!isObject(properties)) return
    for (const [key, child] of Object.entries(properties)) {
      if (!isObject(child)) continue
      const header = (child as JsonObject)["x-mcp-header"]
      if (header !== undefined) {
        reachable.add(child)
        params.push({ header: typeof header === "string" ? header : "", path: [...path, key] })
        const type = (child as JsonObject).type
        if (type !== "string" && type !== "integer" && type !== "boolean")
          throw new HeaderProblem(`x-mcp-header on "${[...path, key].join(".")}", which is not a string, integer or boolean`)
      }
      walk(child as JsonObject, [...path, key])
    }
  }
  try {
    walk(schema, [])
    // An annotation anywhere else (under items, anyOf, $defs...) makes the whole definition invalid.
    if (hasStrayHeader(schema, reachable)) throw new HeaderProblem("x-mcp-header on a parameter that is not reachable through properties alone")
  } catch (error) {
    if (error instanceof HeaderProblem) return { ok: false, reason: error.message }
    throw error
  }
  const seen = new Set<string>()
  for (const param of params) {
    if (!TOKEN.test(param.header)) return { ok: false, reason: `x-mcp-header "${excerpt(param.header, 40)}" is not a valid header name` }
    const lower = param.header.toLowerCase()
    if (seen.has(lower)) return { ok: false, reason: `x-mcp-header "${param.header}" is used twice` }
    seen.add(lower)
  }
  return { ok: true, params }
}

class HeaderProblem extends Error {}

function hasStrayHeader(node: Json, allowed: Set<Json>, depth = 0): boolean {
  if (depth > 64) return false
  if (Array.isArray(node)) return node.some((item) => hasStrayHeader(item, allowed, depth + 1))
  if (!isObject(node)) return false
  if (Object.hasOwn(node, "x-mcp-header") && !allowed.has(node)) return true
  return Object.values(node).some((child) => hasStrayHeader(child as Json, allowed, depth + 1))
}

/** One item of a tool result's `content`. */
export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | { readonly type: "resource_link"; readonly uri: string; readonly name: string; readonly description: string | null; readonly mimeType: string | null }
  | { readonly type: "resource"; readonly uri: string; readonly mimeType: string | null; readonly text: string | null; readonly blob: string | null }
  | { readonly type: "unknown"; readonly original: string }

export interface McpCallResult {
  readonly content: readonly McpContent[]
  /** `structuredContent`, when the server sent it. */
  readonly structured: Json | undefined
  /** The server's `isError`: the tool ran and failed. */
  readonly isError: boolean
}

/** Reads a `tools/call` result. A result that is not complete is a protocol error: this client declares no capability a server could ask it to use. */
export function parseCallResult(result: JsonObject): McpCallResult {
  const type = resultTypeOf(result)
  if (type === "input_required")
    throw new McpError("protocol", "the tool asked the client for more input (elicitation, sampling or roots), which this client does not provide")
  if (type === "invalid") throw new McpError("protocol", `the result has an unknown resultType ${JSON.stringify(result.resultType)}`)
  const content = Array.isArray(result.content) ? result.content.map(parseContent) : []
  return { content, structured: result.structuredContent, isError: result.isError === true }
}

function parseContent(item: Json): McpContent {
  if (!isObject(item) || typeof item.type !== "string") return { type: "unknown", original: "malformed" }
  switch (item.type) {
    case "text":
      return typeof item.text === "string" ? { type: "text", text: item.text } : { type: "unknown", original: "text" }
    case "image":
    case "audio":
      return typeof item.data === "string" && typeof item.mimeType === "string"
        ? { type: item.type, data: item.data, mimeType: item.mimeType }
        : { type: "unknown", original: item.type }
    case "resource_link":
      return typeof item.uri === "string"
        ? {
            type: "resource_link",
            uri: item.uri,
            name: typeof item.name === "string" ? item.name : item.uri,
            description: typeof item.description === "string" ? item.description : null,
            mimeType: typeof item.mimeType === "string" ? item.mimeType : null,
          }
        : { type: "unknown", original: "resource_link" }
    case "resource": {
      const resource = item.resource
      if (!isObject(resource) || typeof resource.uri !== "string") return { type: "unknown", original: "resource" }
      return {
        type: "resource",
        uri: resource.uri,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : null,
        text: typeof resource.text === "string" ? resource.text : null,
        blob: typeof resource.blob === "string" ? resource.blob : null,
      }
    }
    default:
      return { type: "unknown", original: excerpt(item.type, 40) }
  }
}

/**
 * Encodes a value for an `Mcp-Name` or `Mcp-Param-*` header: as is when it is
 * plain visible ASCII without surrounding space, otherwise in the Base64 sentinel form.
 */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !(value.startsWith("=?base64?") && value.endsWith("?="))
  return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
