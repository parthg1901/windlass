/**
 * The two history tools, with which the model recovers exact details from
 * the original messages, which the event log keeps forever: also the ones a
 * compaction took out of its view. This file defines their names, their
 * model-facing descriptions and schemas, the input and output shapes, and the
 * text an output is shown to the model as. The search itself is in
 * `history-search.ts` and in the store (`Store.searchMessages`); the tools
 * the engine offers are in `engine/history.ts`.
 *
 * Messages are addressed by their `seq`, the one ordering the log has. The
 * search covers every message that is not excluded (reverted or refused),
 * including those still in view; a compaction checkpoint is not searched,
 * because it is derived text. A hit says where in the message the match is
 * (`offset`), and a read names the messages before and after, so the model
 * can read around a hit.
 */
import type { Content } from "../content.ts"
import type { Json } from "../json.ts"
import type { Message } from "../message/message.ts"
import { parseArguments } from "../tool/args.ts"
import type { ToolSpec } from "../tool/tool.ts"

export const HISTORY_SEARCH = "history_search"
export const HISTORY_READ = "history_read"

export const HISTORY_LIMITS = {
  /** Hits per search, default and maximum. */
  defaultHits: 8,
  maxHits: 20,
  /** Characters of one snippet around the match. */
  snippetChars: 240,
  /** Characters `history_read` returns per call, default and maximum. */
  defaultReadChars: 6_000,
  maxReadChars: 20_000,
} as const

/** Who a searched piece of text came from. `tool` is a tool call's input or its result. */
export type HistoryRole = "user" | "assistant" | "tool" | "harness"

export interface HistorySearchInput {
  /** Words or an exact phrase. Matching ignores case; a quoted phrase must match as written. */
  readonly query: string
  /** Optional restriction by role. */
  readonly role?: HistoryRole
  readonly limit?: number
}

export interface HistorySearchHit {
  readonly seq: number
  readonly role: HistoryRole
  /** The tool's name, when the hit is a tool call or its result. */
  readonly tool: string | null
  /** Text around the best match, at most `snippetChars`, with `…` where it was cut. */
  readonly snippet: string
  /** Where the match starts in the message's text as `history_read` returns it: the `offset` to read from in a long message. */
  readonly offset: number
}

export interface HistorySearchOutput {
  readonly query: string
  /** Best match first; ties in `seq` order. */
  readonly hits: readonly HistorySearchHit[]
  /** How many messages matched, of which `hits` is the best `limit`. */
  readonly matched: number
}

export interface HistoryReadInput {
  readonly seq: number
  /** Character offset into the message's text, for reading a long message in parts. Default 0. */
  readonly offset?: number
  readonly limit?: number
}

export interface HistoryReadOutput {
  readonly seq: number
  readonly role: HistoryRole
  readonly tool: string | null
  /** The message as text: user and assistant text, each tool call with its input and its full result. */
  readonly text: string
  readonly offset: number
  readonly totalChars: number
  /** Where the next part starts, or `null` when this part reaches the end. */
  readonly nextOffset: number | null
  /** The `seq` of the message before this one and of the one after it, for reading around it; `null` at either end. */
  readonly previousSeq: number | null
  readonly nextSeq: number | null
}

export const historySearchTool: ToolSpec = {
  name: HISTORY_SEARCH,
  description:
    "Search the full stored conversation of this session, including everything a compaction checkpoint replaced, for file paths, commands and their output, error messages, values and what the user said. Use it when you need an exact detail that is no longer in view; what is still in view needs no search. Returns the best matching messages, each with its seq, where in the message the match is, and a snippet. Use history_read with a seq to read that message.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description:
          'Words to find; matching ignores case, and messages that hold more of the words rank higher. Identifiers work as written (src/config/schema.ts, ECONNRESET, a1b2c3d). Put an exact phrase in double quotes, e.g. "exit code 3".',
      },
      role: { type: "string", enum: ["user", "assistant", "tool", "harness"], description: "Only search messages of this role. Default: all." },
      limit: { type: "integer", minimum: 1, maximum: HISTORY_LIMITS.maxHits, description: `How many hits to return. Default ${HISTORY_LIMITS.defaultHits}.` },
    },
    required: ["query"],
    additionalProperties: false,
  },
}

export const historyReadTool: ToolSpec = {
  name: HISTORY_READ,
  description:
    "Read one message of the stored conversation of this session, by the seq that history_search returned: its text, and for a step each tool call with its input and complete result. Long messages are returned in parts: pass the offset a search hit gave to start at the match, or the returned next offset to continue. The result names the messages before and after, so you can read around it.",
  inputSchema: {
    type: "object",
    properties: {
      seq: { type: "integer", minimum: 1, description: "The seq of the message, from history_search." },
      offset: { type: "integer", minimum: 0, description: "Character offset to start from: the one a search hit gave, or the next offset of the previous part. Default 0." },
      limit: { type: "integer", minimum: 1, maximum: HISTORY_LIMITS.maxReadChars, description: `Characters to return. Default ${HISTORY_LIMITS.defaultReadChars}.` },
    },
    required: ["seq"],
    additionalProperties: false,
  },
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string }

const ROLES: readonly HistoryRole[] = ["user", "assistant", "tool", "harness"]

/** Validates the argument text of a `history_search` call. Never throws. */
export function parseHistorySearchInput(text: string): Parsed<HistorySearchInput> {
  const parsed = parseArguments(text)
  if (!parsed.ok) return { ok: false, problem: `the arguments are not valid JSON: ${parsed.problem}` }
  const value = record(parsed.value)
  if (value === null) return { ok: false, problem: "the arguments must be an object" }
  const unknown = Object.keys(value).find((key) => !["query", "role", "limit"].includes(key))
  if (unknown !== undefined) return { ok: false, problem: `unknown argument "${unknown}"` }
  if (typeof value.query !== "string" || value.query.trim() === "") return { ok: false, problem: '"query" must be a non-empty string' }
  if (value.role !== undefined && !ROLES.includes(value.role as HistoryRole))
    return { ok: false, problem: `"role" must be one of ${ROLES.join(", ")}` }
  const limit = boundedInteger(value.limit, 1, HISTORY_LIMITS.maxHits)
  if (limit === null) return { ok: false, problem: `"limit" must be an integer from 1 to ${HISTORY_LIMITS.maxHits}` }
  return {
    ok: true,
    value: {
      query: value.query,
      ...(value.role === undefined ? {} : { role: value.role as HistoryRole }),
      ...(limit === undefined ? {} : { limit }),
    },
  }
}

/** Validates the argument text of a `history_read` call. Never throws. */
export function parseHistoryReadInput(text: string): Parsed<HistoryReadInput> {
  const parsed = parseArguments(text)
  if (!parsed.ok) return { ok: false, problem: `the arguments are not valid JSON: ${parsed.problem}` }
  const value = record(parsed.value)
  if (value === null) return { ok: false, problem: "the arguments must be an object" }
  const unknown = Object.keys(value).find((key) => !["seq", "offset", "limit"].includes(key))
  if (unknown !== undefined) return { ok: false, problem: `unknown argument "${unknown}"` }
  const seq = boundedInteger(value.seq, 1, Number.MAX_SAFE_INTEGER)
  if (seq === null || seq === undefined) return { ok: false, problem: '"seq" must be a positive integer' }
  const offset = boundedInteger(value.offset, 0, Number.MAX_SAFE_INTEGER)
  if (offset === null) return { ok: false, problem: '"offset" must be a non-negative integer' }
  const limit = boundedInteger(value.limit, 1, HISTORY_LIMITS.maxReadChars)
  if (limit === null) return { ok: false, problem: `"limit" must be an integer from 1 to ${HISTORY_LIMITS.maxReadChars}` }
  return { ok: true, value: { seq, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) } }
}

/** The tool result text of a search. */
export function renderSearchOutput(output: HistorySearchOutput): string {
  if (output.hits.length === 0) return `No earlier message matches ${JSON.stringify(output.query)}.`
  const head = `${output.matched} ${output.matched === 1 ? "message matches" : "messages match"} ${JSON.stringify(output.query)}; showing ${output.hits.length}, best first.`
  const hits = output.hits.map(
    (hit) => `[seq ${hit.seq}${hit.offset > 0 ? `, offset ${hit.offset}` : ""}] ${hit.role}${hit.tool === null ? "" : ` (${hit.tool})`}: ${hit.snippet}`,
  )
  return [head, ...hits, `Read one with ${HISTORY_READ} and its seq; pass the offset to start at the match in a long message.`].join("\n")
}

/** The tool result text of a read. */
export function renderReadOutput(output: HistoryReadOutput): string {
  const end = output.offset + output.text.length
  const range =
    output.offset === 0 && output.nextOffset === null ? "" : `, characters ${output.offset}-${end} of ${output.totalChars}`
  const more = output.nextOffset === null ? "" : `\n[More: call ${HISTORY_READ} with offset ${output.nextOffset}.]`
  const around = [
    ...(output.previousSeq === null ? [] : [`the message before it is seq ${output.previousSeq}`]),
    ...(output.nextSeq === null ? [] : [`the one after it is seq ${output.nextSeq}`]),
  ]
  const neighbours = around.length === 0 ? "" : `\n[${around.join("; ")}.]`
  return `[seq ${output.seq}] ${output.role}${output.tool === null ? "" : ` (${output.tool})`}${range}\n${output.text}${more}${neighbours}`
}

function record(value: Json): { readonly [key: string]: Json } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { readonly [key: string]: Json }) : null
}

/** `undefined` when absent, `null` when present and invalid. */
function boundedInteger(value: Json | undefined, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null
}

/**
 * Who a stored message is from, for the history tools. A synthetic message is
 * the harness speaking; an assistant message is a step, whose calls are
 * reported as `tool` pieces by `messagePieces`.
 */
export function messageRole(message: Message): HistoryRole {
  switch (message.kind) {
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "synthetic":
    case "instruction":
    case "compaction":
      return "harness"
  }
}

/** One searchable piece of a stored message: its text, a tool call's input, or a tool call's result. */
export interface MessagePiece {
  readonly role: HistoryRole
  readonly tool: string | null
  readonly text: string
}

/**
 * A stored message as searchable pieces, in order. Text the model never saw
 * as such (reasoning, a running or refused step) is left out; media is
 * `[media <type>]`.
 */
export function messagePieces(message: Message): MessagePiece[] {
  switch (message.kind) {
    case "user":
    case "synthetic":
      return [{ role: messageRole(message), tool: null, text: contentText(message.content) }]
    case "instruction":
      return [{ role: "harness", tool: null, text: message.text }]
    case "compaction":
      return []
    case "assistant":
      if (message.status === "running" || message.status === "refused") return []
      return message.parts.flatMap((part): MessagePiece[] => {
        if (part.type === "text") return part.text.trim() === "" ? [] : [{ role: "assistant", tool: null, text: part.text }]
        if (part.type === "reasoning") return []
        const call: MessagePiece = { role: "tool", tool: part.name, text: `call ${part.name} ${part.input}` }
        if (part.state.status !== "settled") return [call]
        return [call, { role: "tool", tool: part.name, text: `result (${part.state.outcome}):\n${part.state.output}` }]
      })
  }
}

/** The text `history_read` returns for a message: its pieces, separated by blank lines. */
export function messageReadText(message: Message): string {
  return messagePieces(message)
    .map((piece) => piece.text)
    .join("\n\n")
}

function contentText(content: Content): string {
  return content.map((part) => (part.type === "text" ? part.text : `[media ${part.blob.mediaType}]`)).join("")
}
