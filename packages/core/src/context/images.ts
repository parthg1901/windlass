/**
 * Retiring images at a compaction.
 *
 * A tool result may carry images (`tool.settled.attachments`: the `read`
 * tool on an image file, an MCP result). Each is sent again with every later
 * request, at full cost, long after the model has looked at it. An image
 * that was sent cannot be dropped from a request by itself: the block that
 * holds it would change, and the provider's prompt cache would be lost for
 * everything after it. So images are retired only where the prefix is
 * rebuilt anyway, at a compaction, and in two ways:
 *
 * - **Before the cut** nothing of a result is sent any more. The checkpoint
 *   names the images that were shown there (`renderImages`): the file, its
 *   type and size, and that reading the file again shows it again.
 * - **In the part kept word for word** at most `keepRecent` images stay
 *   attached, the most recent ones, and the images the model has not been
 *   shown yet stay whatever their number (the results of the last step: the
 *   next call answers them; they are the most recent, and count). Every
 *   older result keeps its stored text, byte for byte, and loses its
 *   attachments; one line (`note`) is appended that says so and how to see
 *   the image again. That is `retireImages`.
 *
 * The decision is recorded with the compaction (`compaction.ended.retired`:
 * the result, how many images it no longer carries, and the appended line,
 * frozen), and the request builder renders a retired result from that
 * record, so every request can be rebuilt from the log alone. Between two
 * compactions the record does not change, so neither does any block that was
 * sent. A later compaction carries a retirement forward for as long as the
 * result is in view, with the same line: an image never comes back by
 * itself. When the compaction is excluded (a revert to before it), model
 * history is what it was before it, images included.
 *
 * Everything here is pure and deterministic.
 */
import type { RetiredResult } from "../event/durable.ts"
import type { Json } from "../json.ts"
import type { MessageId } from "../id.ts"
import type { Message, ToolCallPart } from "../message/message.ts"
import { parseArguments } from "../tool/args.ts"
import { estimateTokens } from "./estimate.ts"

/** How many images stay attached in the part a compaction keeps word for word, those of the last step included (which stay in any case). */
export const IMAGE_RETIREMENT = {
  /** After a normal compaction, and one the user asked for. */
  keepRecent: 2,
  /** After an aggressive one: only what the model has not been shown yet stays. */
  keepRecentAggressive: 0,
} as const

export type { RetiredResult }

export interface RetirementInput {
  /** The model-visible messages the compaction keeps word for word, in `seq` order. */
  readonly kept: readonly Message[]
  /** What the compaction in force retired (empty without one). A result of it that is still kept stays retired, with the same line. */
  readonly previous: readonly RetiredResult[]
  /** How many images may stay attached, newest first. The last step's count, and stay even when they are more. */
  readonly keepRecent: number
}

/** The key of a tool result: a provider may reuse a call ID in a later step, so the message is part of it. */
export function resultKey(messageId: MessageId, callId: string): string {
  return `${messageId}\u0000${callId}`
}

interface ImageResult {
  readonly messageId: MessageId
  readonly seq: number
  readonly part: ToolCallPart
  readonly images: number
}

/** The settled tool results with attachments among `messages`, oldest first. A step that is running or was refused renders nothing. */
function imageResults(messages: readonly Message[]): ImageResult[] {
  return messages.flatMap((message) =>
    message.kind !== "assistant" || message.status === "running" || message.status === "refused"
      ? []
      : message.parts.flatMap((part) =>
          // A call a program made is not sent, so it has no image the model was shown.
          part.type === "tool_call" && part.parent === undefined && part.state.status === "settled" && part.state.attachments.length > 0
            ? [{ messageId: message.id, seq: message.seq, part, images: part.state.attachments.length }]
            : [],
        ),
  )
}

/**
 * Which results of the kept part lose their images. Newest first: the
 * results of the last step are kept whatever their number (the model has not
 * been shown them), then results are kept while the images kept so far and
 * theirs are at most `keepRecent`; from the first that does not fit, every
 * older one is retired. A result the compaction in force retired stays
 * retired and counts for nothing. The list is in `seq` order.
 */
export function retireImages(input: RetirementInput): RetiredResult[] {
  const previous = new Map(input.previous.map((entry) => [resultKey(entry.messageId, entry.callId), entry]))
  // The last step that put something into the view: what the next model call answers.
  const unanswered = input.kept.findLast((message) => message.kind === "assistant" && message.status !== "running" && message.status !== "refused" && message.parts.length > 0)
  const retired: RetiredResult[] = []
  let attached = 0
  let full = false
  for (const result of imageResults(input.kept).reverse()) {
    const carried = previous.get(resultKey(result.messageId, result.part.callId))
    if (carried !== undefined) {
      retired.push(carried)
      continue
    }
    if (result.messageId === unanswered?.id || (!full && attached + result.images <= input.keepRecent)) {
      attached += result.images
      continue
    }
    full = true
    retired.push({ messageId: result.messageId, callId: result.part.callId, images: result.images, note: retiredNote(result.part) })
  }
  return retired.reverse()
}

/**
 * The line appended to a retired result. The stored output above it still
 * says what the image was (the `read` tool names the file, its type, its
 * dimensions and its size), so the line says what changed and what to do.
 */
export function retiredNote(part: ToolCallPart): string {
  const images = part.state.status === "settled" ? part.state.attachments.length : 0
  const one = images === 1
  const path = pathOf(part)
  const again = path !== null ? `read ${path} again` : `call ${part.name} again with the same arguments`
  return `\n[${one ? "The image of this result is" : `The ${images} images of this result are`} no longer attached: ${one ? "it was" : "they were"} taken out of the conversation when it was compacted, to save context. To see ${one ? "it" : "them"} again, ${again}.]`
}

/**
 * How many tokens the retired results take off the kept part as `estimateMessage` counts it (from the stored
 * messages, every attachment included): what their images are counted at, less the lines that replace them.
 * Results carried on from the compaction in force are part of it: their stored messages still hold the images.
 */
export function retirementSaves(retired: readonly RetiredResult[], mediaTokens: number): number {
  return retired.reduce((sum, entry) => sum + entry.images * mediaTokens - estimateTokens(entry.note), 0)
}

// ---- the checkpoint's list ----

export const IMAGES_HEADING = "## Images you were shown earlier (no longer attached)"
export const IMAGES_ADVICE = "An image is not kept past a compaction. To see one again, read its file again, or call the tool that returned it again."

/**
 * The images among the results before the cut, for the checkpoint: one line
 * each with the file, its type and size and where it was shown, newest first
 * until `maxTokens` is spent, printed oldest first. A file that was shown
 * more than once is listed once, where it was last shown. Empty when there
 * was none.
 */
export function renderImages(earlier: readonly Message[], maxTokens: number, entryChars: number): string {
  const latest = new Map<string, string>()
  for (const result of imageResults(earlier)) {
    const path = pathOf(result.part)
    const line = clip(`- ${describeResult(result, path)}`, entryChars)
    const key = path ?? `${result.messageId}\u0000${result.part.callId}`
    // Listed where it was last shown: the entry moves to the end.
    latest.delete(key)
    latest.set(key, line)
  }
  const lines = [...latest.values()]
  if (lines.length === 0) return ""
  const chosen: string[] = []
  let spent = estimateTokens(`${IMAGES_HEADING}\n${IMAGES_ADVICE}`)
  for (const line of [...lines].reverse()) {
    const cost = estimateTokens(line) + 1
    if (spent + cost > maxTokens) break
    spent += cost
    chosen.unshift(line)
  }
  const unlisted = lines.length - chosen.length
  const note = unlisted === 0 ? [] : [`(${unlisted} image${unlisted === 1 ? "" : "s"} shown before ${unlisted === 1 ? "that is" : "those are"} not listed.)`]
  return [IMAGES_HEADING, IMAGES_ADVICE, ...note, ...chosen].join("\n")
}

function describeResult(result: ImageResult, path: string | null): string {
  const state = result.part.state
  const blobs = state.status === "settled" ? state.attachments : []
  const types = [...new Set(blobs.map((blob) => blob.mediaType))].join(", ")
  const facts = imageFacts(state.status === "settled" ? state.display : null)
  const size = [types, ...(facts.pixels === null ? [] : [facts.pixels]), ...(facts.bytes === null ? [] : [`${facts.bytes} bytes`])].join(", ")
  if (path !== null) return `${path} (${size}), read at seq ${result.seq}`
  return `${result.images === 1 ? "an image" : `${result.images} images`} (${size}) returned by ${result.part.name} at seq ${result.seq}`
}

/** What a tool reported about the one image it attached (`display.image`, as the `read` tool gives it), when it did. */
function imageFacts(display: Json | null): { readonly pixels: string | null; readonly bytes: number | null } {
  const image = isRecord(display) && isRecord(display.image) ? display.image : null
  if (image === null) return { pixels: null, bytes: null }
  const whole = (value: Json | undefined): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null)
  const width = whole(image.width)
  const height = whole(image.height)
  return { pixels: width === null || height === null ? null : `${width}x${height} pixels`, bytes: whole(image.bytes) }
}

/** The file a call names with a `path` argument: what reading again means. `null` for a call that names none. */
function pathOf(part: ToolCallPart): string | null {
  const args = parseArguments(part.input)
  const value = args.ok && isRecord(args.value as Json) ? (args.value as { readonly [key: string]: Json }).path : undefined
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function isRecord(value: Json | null | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clip(value: string, chars: number) {
  return value.length <= chars ? value : `${value.slice(0, chars - 1)}…`
}
