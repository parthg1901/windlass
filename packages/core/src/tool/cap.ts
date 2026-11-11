/**
 * The one output cap. Text over the limit keeps a head and a tail, cut on line
 * boundaries (or, inside a single overlong line, on a character boundary),
 * with a marker between them that says what was dropped and where the full
 * text is. The result depends only on the input bytes, the limits and the spill
 * path, so capping the same output twice gives the same bytes, and capped
 * output is itself within the limits (capping it again changes nothing).
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Truncation } from "./tool.ts"

export interface OutputLimits {
  readonly maxBytes: number
  readonly maxLines: number
}

/** What the model sees of one tool result at most. */
export const OUTPUT_LIMITS: OutputLimits = { maxBytes: 50 * 1024, maxLines: 2000 }

/** Room kept for the marker and the blank lines around it. */
const MARKER_BYTES = 512
const MARKER_LINES = 4
const NEWLINE = 0x0a

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * What the cap reads. `head` is a prefix and `tail` a suffix of the full
 * output; for text in memory both are the whole text. A streaming producer
 * (the shell) passes only the first and last bytes it kept, which gives the
 * same result as long as each holds more than half the byte limit.
 */
export interface CapSource {
  readonly head: Uint8Array
  readonly tail: Uint8Array
  /** Whether `tail` starts at the beginning of a line (it is the whole output, or the byte before it is a newline). */
  readonly tailAtLineStart: boolean
  readonly totalBytes: number
  readonly totalLines: number
}

/** Where the full output is. `savedBytes` is less than the total when the spill file itself was capped. */
export interface Spill {
  readonly path: string | null
  readonly savedBytes: number
}

/** Number of lines in text: newlines, plus one for a final line without a newline. */
export function countLines(bytes: Uint8Array): number {
  let lines = 0
  for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) lines += 1
  return bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE ? lines + 1 : lines
}

export function fitsLimits(totalBytes: number, totalLines: number, limits: OutputLimits): boolean {
  return totalBytes <= limits.maxBytes && totalLines <= limits.maxLines
}

/**
 * Caps text in memory: returns it unchanged with `truncation: null` when it
 * fits, otherwise writes the full text to a spill file named by its SHA-256 in
 * `spillDir` and returns the capped text with `truncation` filled in.
 */
export async function capOutput(
  text: string,
  spillDir: string,
  limits: OutputLimits = OUTPUT_LIMITS,
): Promise<{ readonly output: string; readonly truncation: Truncation | null }> {
  const bytes = encoder.encode(text)
  const totalLines = countLines(bytes)
  if (fitsLimits(bytes.length, totalLines, limits)) return { output: text, truncation: null }
  const spillPath = await writeSpill(bytes, spillDir)
  const source = { head: bytes, tail: bytes, tailAtLineStart: true, totalBytes: bytes.length, totalLines }
  return {
    output: renderCapped(source, { path: spillPath, savedBytes: spillPath === null ? 0 : bytes.length }, limits),
    truncation: { originalBytes: bytes.length, originalLines: totalLines, spillPath },
  }
}

/** Builds the capped text from a source that does not fit the limits. */
export function renderCapped(source: CapSource, spill: Spill, limits: OutputLimits = OUTPUT_LIMITS): string {
  const byteBudget = Math.max(0, limits.maxBytes - MARKER_BYTES)
  const lineBudget = Math.max(0, limits.maxLines - MARKER_LINES)
  const headEnd = cutHead(source.head, Math.floor(byteBudget / 2), Math.floor(lineBudget / 2))
  const tailStart = cutTail(source.tail, source.tailAtLineStart, byteBudget - Math.floor(byteBudget / 2), lineBudget - Math.floor(lineBudget / 2))
  const head = source.head.subarray(0, headEnd)
  const tail = source.tail.subarray(tailStart)
  const headPartial = head.length > 0 && head[head.length - 1] !== NEWLINE
  const tailPartial = tail.length > 0 && !(tailStart === 0 ? source.tailAtLineStart : source.tail[tailStart - 1] === NEWLINE)
  const marker = describeOmission({
    headLines: countLines(head),
    tailLines: countLines(tail),
    omittedBytes: source.totalBytes - head.length - tail.length,
    partial: headPartial || tailPartial,
    source,
    spill,
  })
  return `${decoder.decode(head)}${headPartial ? "\n" : ""}\n${marker}\n\n${decoder.decode(tail)}`
}

function describeOmission(input: {
  headLines: number
  tailLines: number
  omittedBytes: number
  partial: boolean
  source: CapSource
  spill: Spill
}): string {
  const total = input.source.totalLines
  const firstOmitted = input.headLines + 1
  const lastOmitted = total - input.tailLines
  const what = input.partial
    ? `[... ${input.omittedBytes} bytes omitted from the middle; lines too long to show whole were cut. The full output is ${total} lines, ${input.source.totalBytes} bytes.`
    : `[... lines ${firstOmitted}-${lastOmitted} omitted (${lastOmitted - firstOmitted + 1} lines, ${input.omittedBytes} bytes) of ${total} lines.`
  if (input.spill.path === null) return `${what} The full output was not saved.]`
  if (input.spill.savedBytes < input.source.totalBytes)
    return `${what} The first ${input.spill.savedBytes} bytes are saved in ${input.spill.path}.]`
  if (input.partial) return `${what} Full output: ${input.spill.path}]`
  return `${what} Full output: ${input.spill.path} (read it with offset ${firstOmitted} to see the omitted lines).]`
}

/** End of the head: after the last whole line within both budgets, or on a character boundary inside a first line that is too long. */
function cutHead(bytes: Uint8Array, maxBytes: number, maxLines: number): number {
  const limit = Math.min(bytes.length, maxBytes)
  let end = 0
  let lines = 0
  for (let index = bytes.indexOf(NEWLINE); index !== -1 && index < limit && lines < maxLines; index = bytes.indexOf(NEWLINE, index + 1)) {
    end = index + 1
    lines += 1
  }
  if (end > 0 || maxLines === 0) return end
  let cut = limit
  while (cut > 0 && isContinuation(bytes[cut])) cut -= 1
  return cut
}

/** Start of the tail: the first line start within both budgets, or a character boundary inside a last line that is too long. */
function cutTail(bytes: Uint8Array, atLineStart: boolean, maxBytes: number, maxLines: number): number {
  const minStart = Math.max(0, bytes.length - maxBytes)
  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === NEWLINE
  let start = -1
  let lines = 0
  for (let index = bytes.length - 1 - (endsWithNewline ? 1 : 0); index >= minStart - 1 && lines < maxLines; index -= 1) {
    const isStart = index === -1 ? atLineStart : bytes[index] === NEWLINE
    if (!isStart) continue
    start = index + 1
    lines += 1
  }
  if (start !== -1 || maxLines === 0) return start === -1 ? bytes.length : start
  let cut = minStart
  while (cut < bytes.length && isContinuation(bytes[cut])) cut += 1
  return cut
}

function isContinuation(byte: number | undefined) {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

async function writeSpill(bytes: Uint8Array, spillDir: string): Promise<string | null> {
  const path = join(spillDir, `output-${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32)}.txt`)
  try {
    await mkdir(spillDir, { recursive: true })
    await Bun.write(path, bytes)
    return path
  } catch {
    // The cap must still produce its text when the spill directory is unusable; the marker says nothing was saved.
    return null
  }
}
