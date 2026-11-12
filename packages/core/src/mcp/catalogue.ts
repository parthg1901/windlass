/**
 * The catalogue of MCP tools: what the model is told exists, and the search
 * over it. Everything here is pure: the same servers and tools give the same
 * bytes whatever order they connected in, because servers are sorted by name
 * and tools by name (by UTF-16 code units, as `sortTools` does).
 *
 * The catalogue is an instruction source, not part of the tool list. It is
 * appended to the conversation as a message when it first has something to
 * say, and again only when its fingerprint changes (a server connected,
 * disappeared or changed its tools), so the frozen prefix never changes.
 *
 * It is bounded. Each description is cut to its first line or sentence, at
 * most `maxDescriptionChars`; at most `maxToolsPerServer` tools are listed per
 * server; and when the whole text would exceed `maxChars`, the servers at the
 * end of the order are summarised as a count instead, then dropped with a
 * count. `mcp_search` is how the model sees the rest.
 */
import { fingerprint } from "../instructions/source.ts"
import type { Json } from "../json.ts"
import type { JsonObject } from "./protocol.ts"

/** The `source` of the instruction messages that carry the catalogue. */
export const MCP_CATALOGUE_KEY = "mcp"

export interface CatalogueTool {
  readonly name: string
  readonly title: string | null
  readonly description: string
  readonly inputSchema: JsonObject
}

export interface CatalogueServer {
  readonly name: string
  readonly untrusted: boolean
  /** The server's own guidance, shown by `mcp_search` for that server. Untrusted text, never put in the catalogue. */
  readonly instructions: string | null
  readonly tools: readonly CatalogueTool[]
}

export interface CatalogueLimits {
  readonly maxChars: number
  readonly maxDescriptionChars: number
  readonly maxToolsPerServer: number
}

export const CATALOGUE_LIMITS: CatalogueLimits = { maxChars: 12_000, maxDescriptionChars: 160, maxToolsPerServer: 60 }

const INTRO =
  "MCP servers connected to this session and their tools. Find a tool and its input schema with mcp_search, then call it with mcp_call (server and tool as shown here). The names and descriptions come from the servers."

/** Servers and their tools in the one order every rendering uses. */
export function normalise(servers: readonly CatalogueServer[]): CatalogueServer[] {
  return [...servers].sort((a, b) => byCodeUnits(a.name, b.name)).map((server) => ({ ...server, tools: [...server.tools].sort((a, b) => byCodeUnits(a.name, b.name)) }))
}

/** The catalogue body, or `null` when no server has tools to offer (then there is nothing to tell the model). */
export function renderCatalogue(servers: readonly CatalogueServer[], limits: CatalogueLimits = CATALOGUE_LIMITS): string | null {
  const ordered = normalise(servers).filter((server) => server.tools.length > 0)
  if (ordered.length === 0) return null
  const full = ordered.map((server) => fullBlock(server, limits))
  const summary = ordered.map((server) => `${server.name}: ${count(server.tools.length)} (not listed here; use mcp_search with server "${server.name}")`)
  // Degrade from the end of the order, so the same set always gives the same text.
  let blocks = [...full]
  const text = () => [INTRO, ...blocks].join("\n\n")
  for (let index = blocks.length - 1; index >= 0 && text().length > limits.maxChars; index -= 1) blocks[index] = summary[index]!
  for (let keep = ordered.length - 1; keep >= 0 && text().length > limits.maxChars; keep -= 1) {
    const rest = ordered.slice(keep)
    const tools = rest.reduce((sum, server) => sum + server.tools.length, 0)
    blocks = [...summary.slice(0, keep), `${rest.length === 1 ? "1 more server" : `${rest.length} more servers`} with ${count(tools)} (use mcp_search)`]
  }
  return text()
}

function fullBlock(server: CatalogueServer, limits: CatalogueLimits): string {
  const shown = server.tools.slice(0, limits.maxToolsPerServer)
  const lines = shown.map((tool) => {
    const description = oneLine(tool.description === "" ? (tool.title ?? "") : tool.description, limits.maxDescriptionChars)
    return description === "" ? `- ${tool.name}` : `- ${tool.name}: ${description}`
  })
  const hidden = server.tools.length - shown.length
  if (hidden > 0) lines.push(`- and ${hidden} more (use mcp_search with server "${server.name}")`)
  return [`${server.name} (${count(server.tools.length)}):`, ...lines].join("\n")
}

/** The catalogue as an instruction source: its key and body, or `null` when there is nothing to say. */
export function catalogueSource(servers: readonly CatalogueServer[], limits?: CatalogueLimits): { readonly key: string; readonly value: string } | null {
  const value = renderCatalogue(servers, limits)
  return value === null ? null : { key: MCP_CATALOGUE_KEY, value }
}

/**
 * What to append so the model's catalogue matches `source`, given the
 * fingerprint of the catalogue it was last given (`null` or `undefined`:
 * none, or it was told there is none). Returns `null` when nothing changed.
 * The text is final; the engine stores it with the fingerprint (`null` for a
 * withdrawal) in an `instruction.appended` event with source `MCP_CATALOGUE_KEY`.
 */
export function catalogueUpdate(
  known: string | null | undefined,
  source: { readonly value: string } | null,
): { readonly text: string; readonly fingerprint: string | null } | null {
  if (source === null) {
    if (known === null || known === undefined) return null
    return { text: "No MCP server is connected any more. The MCP tools you were given before are not available; mcp_search shows the current state.", fingerprint: null }
  }
  const current = fingerprint(source.value)
  if (current === known) return null
  const notice =
    known === null || known === undefined
      ? "MCP tools are available:"
      : "The MCP servers or their tools have changed. This list replaces the one you were given before:"
  return { text: `${notice}\n${section(source.value)}`, fingerprint: current }
}

function section(value: string) {
  return [`<mcp_tools lines="${value.split("\n").length}">`, value, "</mcp_tools>"].join("\n")
}

/** The first line or sentence of a description, whitespace collapsed, cut on a character boundary. */
export function oneLine(text: string, max: number): string {
  const firstLine = text.trim().split(/\n\s*\n|\n/)[0] ?? ""
  const flat = firstLine.replace(/\s+/g, " ").trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat
  const chars = [...sentence]
  return chars.length <= max ? sentence : `${chars.slice(0, max - 1).join("").trimEnd()}…`
}

export interface SearchMatch {
  readonly server: string
  readonly tool: CatalogueTool
}

/**
 * Tools whose server, name, title or description contain the query's words
 * (case-insensitive). A tool that matches more words comes first, then one
 * whose name matches, then by server and name. An empty query lists every tool.
 * `server/tool` or an exact tool name puts that tool first.
 */
export function searchCatalogue(servers: readonly CatalogueServer[], query: string, server: string | null): SearchMatch[] {
  const scope = normalise(servers).filter((entry) => server === null || entry.name === server)
  const all = scope.flatMap((entry) => entry.tools.map((tool) => ({ server: entry.name, tool })))
  const trimmed = query.trim().toLowerCase()
  if (trimmed === "") return all
  const words = [...new Set(trimmed.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""))]
  const scored = all.flatMap((match) => {
    const name = match.tool.name.toLowerCase()
    const qualified = `${match.server.toLowerCase()}/${name}`
    const nameWords = splitName(match.tool.name)
    const text = `${(match.tool.title ?? "").toLowerCase()} ${match.tool.description.toLowerCase()}`
    let matched = 0
    let score = 0
    for (const word of words) {
      const inName = nameWords.includes(word) ? 4 : name.includes(word) ? 3 : 0
      const inServer = match.server.toLowerCase().includes(word) ? 1 : 0
      const inText = text.includes(word) ? 1 : 0
      if (inName + inServer + inText > 0) matched += 1
      score += inName + inServer + inText
    }
    if (trimmed === qualified || trimmed === name) score += 100
    return matched === 0 ? [] : [{ match, matched, score }]
  })
  return scored
    .sort(
      (a, b) =>
        b.matched - a.matched || b.score - a.score || byCodeUnits(a.match.server, b.match.server) || byCodeUnits(a.match.tool.name, b.match.tool.name),
    )
    .map((entry) => entry.match)
}

/** `create_issue`, `createIssue` and `issues.create` all give their words. */
function splitName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
}

/** JSON with sorted keys, so a schema prints the same however the server ordered it. */
export function stableJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort(byCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key]!)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

function count(tools: number) {
  return tools === 1 ? "1 tool" : `${tools} tools`
}

export function byCodeUnits(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}
