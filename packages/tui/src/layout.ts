/**
 * Styled text laid out in terminal columns: word wrapping of a line of spans,
 * truncation, and the clean-up of text that came from a model or a command
 * (escape sequences and control characters a terminal would act on).
 */
import type { Line, Span } from "./theme.ts"

/** Columns a string takes in a terminal (wide characters 2, combining marks 0). */
export function width(text: string): number {
  return Bun.stringWidth(text)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** A logical line longer than this is cut before it is wrapped: a minified file must not freeze the view. */
export const MAX_LINE_CHARS = 4000

/** Model or command text as it can be drawn: no escape sequences, no control characters, tabs as two spaces. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

/** Cuts `text` to at most `max` columns, ending with `…` when something was cut. */
export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text
  if (max <= 0) return ""
  let out = ""
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const w = width(segment)
    if (used + w > max - 1) break
    out += segment
    used += w
  }
  return `${out}…`
}

/** A line of spans cut to `max` columns, with `…` where it was cut. */
export function truncateLine(line: Line, max: number): Span[] {
  const out: Span[] = []
  let left = max
  for (const part of line) {
    if (left <= 0) break
    const w = width(part.text)
    if (w <= left) {
      out.push(part)
      left -= w
      continue
    }
    out.push({ ...part, text: truncate(part.text, left) })
    break
  }
  return out
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, part) => sum + width(part.text), 0)
}

/** Pads a line with spaces to `columns`. */
export function padLine(line: Line, columns: number): Span[] {
  const used = lineWidth(line)
  return used >= columns ? [...line] : [...line, { text: " ".repeat(columns - used) }]
}

/** A run of spaces, or a word: its pieces, one per span it runs through (`see `, then a code span, then `).`). */
interface Token {
  readonly pieces: { readonly text: string; readonly style: Span; readonly width: number }[]
  readonly space: boolean
  width: number
}

/**
 * Word-wraps one logical line of spans to `columns`. Rows after the first
 * start with `indent` (a hanging indent); spaces at the start of those rows
 * are dropped. A word is what stands between spaces, whatever its styling:
 * inline code with the comma after it, a bold word with its colon, stay
 * together. Only a word longer than a row is broken across rows. Never
 * returns an empty list: an empty line is one empty row.
 */
export function wrapLine(line: Line, columns: number, indent: Line = []): Span[][] {
  const room = Math.max(1, columns)
  const indentWidth = Math.min(lineWidth(indent), Math.max(0, room - 1))
  const rows: Span[][] = []
  let row: Span[] = []
  let used = 0
  const push = (style: Span, text: string, w: number) => {
    const last = row.at(-1)
    const drawn = text.replace(/\u00a0/g, " ")
    if (last !== undefined && sameStyle(last, style)) row[row.length - 1] = { ...last, text: last.text + drawn }
    else row.push({ ...style, text: drawn })
    used += w
  }
  const newRow = () => {
    rows.push(row)
    row = indentWidth > 0 ? [...indent] : []
    used = indentWidth
  }
  const whole = (token: Token) => {
    for (const piece of token.pieces) push(piece.style, piece.text, piece.width)
  }
  for (const token of tokens(line)) {
    if (token.space) {
      if (used === indentWidth && rows.length > 0) continue
      if (used + token.width <= room) whole(token)
      else newRow()
      continue
    }
    if (used + token.width <= room) {
      whole(token)
      continue
    }
    if (token.width <= room - indentWidth && used > indentWidth) {
      newRow()
      whole(token)
      continue
    }
    // Longer than a row: broken at grapheme boundaries.
    for (const piece of token.pieces)
      for (const { segment } of graphemes.segment(piece.text)) {
        const w = width(segment)
        if (used + w > room && used > indentWidth) newRow()
        push(piece.style, segment, w)
      }
  }
  rows.push(row)
  return rows.map(trimEnd)
}

/** Several logical lines (split at newlines inside the spans), each wrapped. */
export function wrapText(line: Line, columns: number, indent: Line = []): Span[][] {
  return splitLines(line).flatMap((logical) => wrapLine(logical, columns, indent))
}

/** Splits a line of spans at the newlines inside them. */
export function splitLines(line: Line): Span[][] {
  const out: Span[][] = [[]]
  for (const part of line) {
    const pieces = part.text.split("\n")
    pieces.forEach((piece, index) => {
      if (index > 0) out.push([])
      if (piece !== "") out.at(-1)!.push({ ...part, text: piece })
    })
  }
  return out
}

function tokens(line: Line): Token[] {
  const out: Token[] = []
  let budget = MAX_LINE_CHARS
  for (const part of line) {
    if (budget <= 0) break
    const text = part.text.length > budget ? `${part.text.slice(0, budget)}… (${(part.text.length - budget).toLocaleString("en-US")} more characters)` : part.text
    budget -= part.text.length
    let first = true
    // A no-break space (U+00A0) holds the words on either side together; it is drawn as a plain space.
    for (const piece of text.split(/([^\S\u00a0]+)/)) {
      if (piece === "") continue
      const space = /^[^\S\u00a0]+$/.test(piece)
      const w = width(piece)
      const last = out.at(-1)
      // A span that begins where the one before it ended, with no space between: the same word goes on.
      if (first && !space && last !== undefined && !last.space) {
        last.pieces.push({ text: piece, style: part, width: w })
        last.width += w
      } else out.push({ pieces: [{ text: piece, style: part, width: w }], space, width: w })
      first = false
    }
  }
  return out
}

function sameStyle(a: Span, b: Span): boolean {
  return a.role === b.role && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse && a.strike === b.strike
}

function trimEnd(row: Span[]): Span[] {
  const last = row.at(-1)
  if (last === undefined || last.inverse) return row
  const trimmed = last.text.replace(/\s+$/, "")
  if (trimmed === last.text) return row
  return trimmed === "" ? row.slice(0, -1) : [...row.slice(0, -1), { ...last, text: trimmed }]
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`
}

/** A token count in a few columns: 980, 9.4k, 41k, 1.2M. */
export function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function thousands(value: number): string {
  return value.toLocaleString("en-US")
}
