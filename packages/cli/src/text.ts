/** Terminal text: styles, display width and width-aware truncation. */

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const

export type Tone = keyof typeof CODES

/** A run of text with an optional style. A line is a list of these, styled only after it is cut to width. */
export interface Segment {
  readonly text: string
  readonly tone?: Tone | readonly Tone[]
}

export const seg = (text: string, tone?: Tone | readonly Tone[]): Segment => (tone === undefined ? { text } : { text, tone })

/** Wraps `text` in the ANSI codes for `tone`. With colour off it returns `text` unchanged. */
export function paint(color: boolean, tone: Tone | readonly Tone[] | undefined, text: string): string {
  if (!color || tone === undefined || text === "") return text
  const tones = typeof tone === "string" ? [tone] : tone
  return tones.reduce((inner, name) => `\x1b[${CODES[name][0]}m${inner}\x1b[${CODES[name][1]}m`, text)
}

/** Columns a string occupies in a terminal (wide characters count 2, escape codes 0). */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Cuts `text` to at most `max` columns, ending with `…` when something was cut. */
export function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  if (max <= 0) return ""
  let out = ""
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const w = displayWidth(segment)
    if (used + w > max - 1) break
    out += segment
    used += w
  }
  return `${out}…`
}

/** Cuts a styled line to `max` columns and renders it. Newlines and tabs inside segments are flattened first. */
export function renderLine(segments: readonly Segment[], max: number, color: boolean): string {
  let left = max
  let out = ""
  for (const part of segments) {
    if (left <= 0) break
    const flat = flatten(part.text)
    const cut = truncate(flat, left)
    out += paint(color, part.tone, cut)
    left -= displayWidth(cut)
    if (cut !== flat) break
  }
  return out
}

/**
 * Word-wraps one line of prose to `width` columns; a word longer than a line
 * is cut. The line's own indent is kept on its first row. Not for
 * preformatted text (a diff, a command, code), where spaces mean something:
 * that is `hardWrap`.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  const lead = text.slice(0, text.length - text.trimStart().length)
  let current = lead.length < width / 2 ? lead : ""
  let first = true
  for (const word of text.trimStart().split(" ")) {
    if (first) {
      first = false
      if (displayWidth(current + word) <= width) {
        current += word
        continue
      }
      if (current !== "") out.push(current.trimEnd())
      current = truncate(word, width)
      continue
    }
    const next = current === "" ? word : `${current} ${word}`
    if (displayWidth(next) <= width) current = next
    else {
      if (current !== "") out.push(current)
      current = truncate(word, width)
    }
  }
  if (current !== "") out.push(current)
  return out.filter((row) => row.trim() !== "" || out.length === 1)
}

/**
 * Preformatted text (a line of a diff, a command) as rows of `width`
 * columns: every character kept, nothing reflowed, a tab as four spaces. A
 * row that is cut continues on the next, from the very next character.
 */
export function hardWrap(text: string, width: number): string[] {
  const line = text.replace(/\t/g, "    ")
  if (displayWidth(line) <= width) return [line]
  const rows: string[] = []
  let current = ""
  let used = 0
  for (const { segment } of graphemes.segment(line)) {
    const w = displayWidth(segment)
    if (used + w > Math.max(1, width)) {
      rows.push(current)
      current = ""
      used = 0
    }
    current += segment
    used += w
  }
  if (current !== "" || rows.length === 0) rows.push(current)
  return rows
}

/**
 * A styled line as terminal rows: as it is when it fits `max` columns,
 * otherwise wrapped at word boundaries with the continuation rows indented.
 * A wrapped line keeps its words and loses its per-segment styling: every row
 * takes the style of the line's last styled segment.
 */
export function renderWrapped(segments: readonly Segment[], max: number, color: boolean): string[] {
  const whole = segments.map((part) => flatten(part.text)).join("")
  if (displayWidth(whole) <= max) return [renderLine(segments, max, color)]
  const tone = segments.findLast((part) => part.tone !== undefined)?.tone
  // The line's own indent is kept on its first row; the rows after it are indented two columns more.
  const lead = whole.slice(0, whole.length - whole.trimStart().length)
  const [first, ...rest] = wrap(whole.trim(), max - lead.length)
  const more = wrap(rest.join(" "), max - lead.length - 2).map((row) => `${lead}  ${row}`)
  return [`${lead}${first ?? ""}`, ...more].map((row) => paint(color, tone, row))
}

/** One visual line: control characters, tabs and newlines become spaces or a visible return mark. */
export function flatten(text: string): string {
  return text.replace(/\r?\n/g, " ⏎ ").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

/** Removes ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Whether to colour output: only for a terminal, and never when NO_COLOR is set to a non-empty value. */
export function colorEnabled(isTTY: boolean, env: Record<string, string | undefined>): boolean {
  const noColor = env.NO_COLOR
  return isTTY && (noColor === undefined || noColor === "")
}

/**
 * The candidate closest to `word` by edit distance, when it is close enough
 * to be what was meant (a typo, not another word): at most a third of the
 * longer one's length, and at least one edit. Case is ignored.
 */
export function nearest(word: string, candidates: readonly string[]): string | null {
  const typed = word.toLowerCase()
  let best: { candidate: string; distance: number } | null = null
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate.toLowerCase())
    if (best === null || distance < best.distance) best = { candidate, distance }
  }
  if (best === null) return null
  const limit = Math.max(1, Math.floor(Math.max(typed.length, best.candidate.length) / 3))
  return best.distance <= limit ? best.candidate : null
}

/** Levenshtein distance, with a swap of two neighbouring characters counted as one edit. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1)
      rows[i]![j] = value
    }
  return rows[a.length]![b.length]!
}
