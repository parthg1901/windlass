/**
 * Size estimation: how many input tokens the next request will have.
 *
 * The best number is the provider's own: the input tokens it measured for the
 * last call. When the next request extends that call's request (the prefix
 * property `request/build.ts` keeps), the next request is that request plus
 * the items appended since: the call's own output and then tool results and
 * new messages. The output was measured too (`outputTokens`), so only the
 * items after it are estimated. Everything here is pure and deterministic.
 *
 * ## The text estimator
 *
 * `estimateTokens` imitates how a byte-pair tokenizer of the o200k family
 * splits text, without its vocabulary: it pre-splits text the way such
 * tokenizers do (letter runs, digit groups of up to three, punctuation runs,
 * whitespace), then charges each piece a cost by its class and length. It is
 * meant for mixed code, logs and prose.
 *
 * Measured on 2026-11-12 against the provider's numbers from ten real runs on
 * synthetic coding tasks (model `gpt-6-luna`; 54 step-to-step deltas, where
 * the delta minus the previous call's measured output is the cost of the
 * appended tool results, and 10 first requests):
 * - appended tool output, the part that is actually estimated: on the 12
 *   deltas of 300 tokens or more (up to 23,827), between -1.2% and +9.6%,
 *   +0.4% summed; on the 42 smaller ones within ±26 tokens, and within ±8
 *   below 100 tokens, where per-item framing (`ITEM_OVERHEAD`) dominates;
 * - first requests (instructions, 7 tools, one user message, about 1,800
 *   tokens): within ±0.3%, but that is one tool set and one system prompt in
 *   ten nearly identical copies, and the tool rendering constants were fitted
 *   to it, so it is a fit, not a validation;
 * - the previous call's output replays at exactly its measured `outputTokens`
 *   when it has no reasoning; reasoning replay was not observed in this data.
 * The data is small TypeScript projects with English prose. Text unlike it
 * (minified code, base64, other languages) can be off by more. So the policy
 * never trusts an estimate alone: it adds `ESTIMATOR_ERROR.relative` of the
 * estimated part, and at least `ESTIMATOR_ERROR.floorTokens`, as a margin.
 */
import type { Content } from "../content.ts"
import type { Json } from "../json.ts"
import type { Message } from "../message/message.ts"
import type { Usage } from "../provider/usage.ts"
import { type BlockHash, comparePrefix, hashRequest } from "../request/prefix.ts"
import type { InputItem, ModelRequest } from "../request/request.ts"
import type { ToolSpec } from "../tool/tool.ts"

/**
 * How wrong `estimateTokens` was against the provider's counts, and the margin
 * the policy applies because of it. See the file comment for the data.
 */
export const ESTIMATOR_ERROR = {
  /** Fraction of the estimated part added as a safety margin: above the worst relative error measured. */
  relative: 0.25,
  /** The margin never goes below this many tokens, because small estimates are mostly framing. */
  floorTokens: 512,
} as const

/** Tokens a tokenizer would plausibly give `text`. Deterministic; 0 for the empty string. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let total = 0
  for (const match of text.matchAll(PIECE)) total += pieceCost(match[0])
  return Math.ceil(total)
}

/**
 * Pre-split pattern, close to what o200k-style tokenizers use: an optional
 * leading space or symbol glued to a letter run (split at lower-to-upper case
 * changes), digit groups of one to three, punctuation runs with an optional
 * leading space, newline runs with their indentation, other whitespace.
 */
const PIECE = /[^\r\n\p{L}\p{N}]?[\p{Lu}]*[\p{Ll}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}]+(?![\p{Ll}])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu

function pieceCost(piece: string): number {
  const first = piece.charCodeAt(0)
  // Non-ASCII text (accents aside) is about one token per character in these vocabularies.
  if (/[^\x00-\x7f]/.test(piece)) return [...piece].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2ff ? 1 : 0.5), 0)
  if (/^\s+$/.test(piece)) return piece.includes("\n") ? 1 : Math.ceil(piece.length / 8)
  if (/\d/.test(piece)) return 1
  const letters = piece.replace(/[^A-Za-z]/g, "").length
  if (letters === 0) {
    // A punctuation run: common pairs and triples (`("`, `);`, `=>`, `*/`) are single tokens.
    const body = piece.trimStart().replace(/[\r\n]+$/, "")
    return Math.max(1, Math.ceil(body.length / 2))
  }
  // A word, possibly with one leading space or symbol. Common words are one token up to
  // about eight letters; longer or rarer ones split into pieces of four to five.
  const lead = first === 32 || letters === piece.length ? 0 : 0.5
  return lead + (letters <= 7 ? 1 : Math.ceil(letters / 5))
}

/** Framing the provider bills per input item (role, type and separators), measured as a constant. */
export const ITEM_OVERHEAD = 6
/** A fixed estimate for one media part (an image), whose real cost depends on its size. */
export const MEDIA_TOKENS = 1_000
/** Framing billed once per request on top of the instructions, tools and items. */
export const REQUEST_OVERHEAD = 16
/** A replayed reasoning item: its encrypted payload is billed as about this many tokens. */
export const REASONING_REPLAY_TOKENS = 15

export function estimateContent(content: Content): number {
  return content.reduce((sum, part) => sum + (part.type === "text" ? estimateTokens(part.text) : MEDIA_TOKENS), 0)
}

/** One input item as the provider bills it. */
export function estimateItem(item: InputItem): number {
  switch (item.type) {
    case "message":
      return ITEM_OVERHEAD + estimateContent(item.content)
    case "assistant_text":
      return ITEM_OVERHEAD + estimateTokens(item.text)
    case "reasoning":
      return REASONING_REPLAY_TOKENS
    case "tool_call":
      return ITEM_OVERHEAD + estimateTokens(item.name) + estimateTokens(item.input)
    case "tool_result":
      return ITEM_OVERHEAD + estimateTokens(item.output) + item.attachments.length * MEDIA_TOKENS
  }
}

/**
 * One tool definition. The provider does not bill the schema's JSON text: it
 * renders a compact signature (property names, types, descriptions, enum
 * values), so only those are counted, with a constant per property.
 */
export function estimateTool(tool: ToolSpec): number {
  return ITEM_OVERHEAD + estimateTokens(tool.name) + estimateTokens(tool.description) + estimateSchema(tool.inputSchema)
}

const PROPERTY_OVERHEAD = 4

function estimateSchema(value: Json | undefined): number {
  const schema = jsonObject(value)
  if (schema === null) return 0
  const description = typeof schema.description === "string" ? estimateTokens(schema.description) : 0
  const values = schema.enum
  const enumValues = Array.isArray(values) ? values.reduce<number>((sum, item) => sum + 1 + estimateTokens(String(item)), 0) : 0
  const properties = jsonObject(schema.properties)
  const nested =
    properties === null
      ? 0
      : Object.entries(properties).reduce((sum, [name, property]) => sum + PROPERTY_OVERHEAD + estimateTokens(name) + estimateSchema(property), 0)
  return description + enumValues + nested + estimateSchema(schema.items)
}

function jsonObject(value: Json | undefined): { readonly [key: string]: Json } | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? (value as { readonly [key: string]: Json }) : null
}

/** A whole request estimated from scratch, for when no measurement of its prefix exists. */
export function estimateRequest(request: Pick<ModelRequest, "instructions" | "tools" | "input">): number {
  return (
    REQUEST_OVERHEAD +
    estimateTokens(request.instructions) +
    request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
    request.input.reduce((sum, item) => sum + estimateItem(item), 0)
  )
}

/**
 * One stored message as the model would see it. Cheaper than rendering, and
 * close enough for choosing what to keep: it counts what `renderMessage`
 * emits (text, tool calls, tool results, the checkpoint) and charges replayed
 * reasoning a constant.
 */
export function estimateMessage(message: Message): number {
  switch (message.kind) {
    case "user":
    case "synthetic":
      return ITEM_OVERHEAD + estimateContent(message.content)
    case "instruction":
      return ITEM_OVERHEAD + estimateTokens(message.text)
    case "compaction":
      return message.summary === null ? 0 : ITEM_OVERHEAD + estimateTokens(message.summary)
    case "assistant":
      if (message.status === "running" || message.status === "refused") return 0
      return message.parts.reduce((sum, part) => {
        if (part.type === "text") return sum + (part.text.trim() === "" ? 0 : ITEM_OVERHEAD + estimateTokens(part.text))
        if (part.type === "reasoning") return sum + (part.providerData === null ? 0 : REASONING_REPLAY_TOKENS)
        const result =
          part.state.status === "settled"
            ? ITEM_OVERHEAD + estimateTokens(part.state.output) + part.state.attachments.length * MEDIA_TOKENS
            : 0
        return sum + ITEM_OVERHEAD + estimateTokens(part.name) + estimateTokens(part.input) + result
      }, 0)
  }
}

/** The last model call whose measurement the next estimate may build on. */
export interface MeasuredCall {
  /** The block hashes of the request that was sent, as the request ledger stores them. */
  readonly blocks: readonly BlockHash[]
  /** What the provider measured for it. */
  readonly usage: Usage
}

export interface SizeEstimate {
  /** Tokens known from the provider's measurement (input of the last call plus its output). */
  readonly measured: number
  /** Tokens estimated with `estimateTokens` (everything appended after the measured part). */
  readonly estimated: number
  /** `measured + estimated`: the best estimate of the next request's input tokens. */
  readonly total: number
  /** The safety margin the policy adds for the estimator's error: see `ESTIMATOR_ERROR`. */
  readonly margin: number
  /** Whether the estimate builds on a measurement (`false` after a compaction or a revert, or before the first call). */
  readonly basedOnMeasurement: boolean
}

/**
 * The best estimate of the input tokens of `next`.
 *
 * When `last` is given and `next` extends its request, the estimate is the
 * measured input of `last`, plus its measured output standing in for the
 * output items it produced (the first run of model-output items after its
 * request), plus an estimate of every item after them. Otherwise (no
 * measurement, or the prefix broke, as after a compaction) the whole request
 * is estimated.
 */
export function estimateNextInput(next: ModelRequest, last: MeasuredCall | null, nextBlocks?: readonly BlockHash[]): SizeEstimate {
  const blocks = nextBlocks ?? hashRequest(next)
  const extends_ = last !== null && last.blocks.length > 0 && comparePrefix(last.blocks, blocks).extension
  if (!extends_ || last === null) {
    const estimated = estimateRequest(next)
    return finish(0, estimated, false)
  }
  const firstInput = blocks.length - next.input.length
  const appended = next.input.slice(Math.max(0, last.blocks.length - firstInput))
  const outputCount = appended.findIndex((item) => !isModelOutput(item))
  const output = outputCount === -1 ? appended : appended.slice(0, outputCount)
  const rest = outputCount === -1 ? [] : appended.slice(outputCount)
  // Reasoning is billed as output but replayed as a small encrypted item; text and calls are replayed whole.
  const replayedOutput =
    last.usage.outputTokens - last.usage.reasoningTokens + output.filter((item) => item.type === "reasoning").length * REASONING_REPLAY_TOKENS
  const measured = last.usage.inputTokens + (output.length === 0 ? 0 : replayedOutput)
  return finish(measured, rest.reduce((sum, item) => sum + estimateItem(item), 0), true)
}

function isModelOutput(item: InputItem) {
  return item.type === "assistant_text" || item.type === "reasoning" || item.type === "tool_call"
}

function finish(measured: number, estimated: number, basedOnMeasurement: boolean): SizeEstimate {
  const margin = Math.max(ESTIMATOR_ERROR.floorTokens, Math.ceil(estimated * ESTIMATOR_ERROR.relative))
  return { measured, estimated, total: measured + estimated, margin, basedOnMeasurement }
}
