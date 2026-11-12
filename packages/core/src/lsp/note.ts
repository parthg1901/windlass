/**
 * The note the model is shown after a file tool's result. Pure and
 * deterministic: it depends only on the path, the servers' names, the
 * comparisons and the bounds, never on timing. Written once, when the call
 * settles, and stored inside the result's output like the hooks' notes.
 *
 *   [Diagnostics from the language server "typescript" for src/app.ts after this edit: 2 new errors]
 *   src/app.ts:12:5: error TS2304: Cannot find name 'fetchUser'. (ts)
 *   src/app.ts:20:18: error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'. (ts)
 *   These are the language server's diagnostics for this file after the edit; the 3 it already had are not listed, and the project's checks remain the authority.
 *
 * Bounds: at most `maxItems` diagnostics in all, each message cut to one line
 * of `MAX_MESSAGE_CHARS`, the whole note at most `maxChars`; whatever is left
 * out is stated as a count on one line.
 */
import { type Comparison, type Diagnostic, SEVERITY_NAMES } from "./diagnostics.ts"

export const NOTE_LIMITS = {
  /** Diagnostics listed, over all servers. */
  maxItems: { default: 10, min: 1, max: 50 },
  /** Characters in the whole note. */
  maxChars: 2000,
} as const

export const MAX_MESSAGE_CHARS = 300

export interface NoteSection {
  /** The server's name in the configuration. */
  readonly server: string
  readonly comparison: Comparison
}

export interface NoteOptions {
  readonly maxItems?: number
  readonly maxChars?: number
}

export interface RenderedNote {
  /** `null` when no section has anything new. */
  readonly text: string | null
  /** Diagnostics shown, over all servers. */
  readonly listed: number
  /** New diagnostics not shown. */
  readonly omitted: number
}

/** `path` is as the model should see it: relative to the working directory, with `/`. */
export function renderNote(path: string, sections: readonly NoteSection[], options: NoteOptions = {}): RenderedNote {
  const maxItems = options.maxItems ?? NOTE_LIMITS.maxItems.default
  const maxChars = options.maxChars ?? NOTE_LIMITS.maxChars
  const worse = [...sections].filter((section) => section.comparison.added.length > 0).sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0))
  if (worse.length === 0) return { text: null, listed: 0, omitted: 0 }

  // The fixed lines of every section first, so the bound is spent on items, never on cutting a heading.
  const frames = worse.map((section) => ({ section, heading: heading(path, section), footer: footer(section.comparison.preExisting) }))
  let room = maxChars - frames.reduce((sum, frame) => sum + frame.heading.length + 1 + frame.footer.length + 1, 0) - (frames.length - 1)
  let itemsLeft = maxItems
  let listed = 0
  let omitted = 0
  const blocks: string[] = []
  for (const frame of frames) {
    const lines = [frame.heading]
    const added = frame.section.comparison.added
    let shown = 0
    for (const diagnostic of added) {
      if (itemsLeft === 0) break
      const line = item(path, diagnostic)
      // Keep room for the line that says what was left out.
      const reserve = shown + 1 < added.length ? 60 : 0
      if (line.length + 1 + reserve > room) break
      lines.push(line)
      room -= line.length + 1
      itemsLeft -= 1
      shown += 1
    }
    const left = added.length - shown
    if (left > 0) {
      const line = `... and ${left} more new ${left === 1 ? "diagnostic" : "diagnostics"} not listed.`
      lines.push(line)
      room -= line.length + 1
    }
    lines.push(frame.footer)
    blocks.push(lines.join("\n"))
    listed += shown
    omitted += left
  }
  return { text: blocks.join("\n\n"), listed, omitted }
}

function heading(path: string, section: NoteSection): string {
  return `[Diagnostics from the language server ${JSON.stringify(section.server)} for ${path} after this edit: ${counts(section.comparison.added)}]`
}

function footer(preExisting: number): string {
  const before =
    preExisting === 0 ? "diagnostics it already had are not listed" : `the ${preExisting} it already had ${preExisting === 1 ? "is" : "are"} not listed`
  return `These are the language server's diagnostics for this file after the edit; ${before}, and the project's checks remain the authority.`
}

function counts(added: readonly Diagnostic[]): string {
  const bySeverity = new Map<number, number>()
  for (const d of added) bySeverity.set(d.severity, (bySeverity.get(d.severity) ?? 0) + 1)
  return [...bySeverity.entries()]
    .sort(([a], [b]) => a - b)
    .map(([severity, count]) => `${count} new ${SEVERITY_NAMES[severity as 1 | 2 | 3 | 4]}${count === 1 ? "" : "s"}`)
    .join(", ")
}

function item(path: string, d: Diagnostic): string {
  const where = `${path}:${d.range.start.line + 1}:${d.range.start.character + 1}`
  const code = d.code === null ? "" : ` ${oneLine(d.code, 40)}`
  const source = d.source === null ? "" : ` (${oneLine(d.source, 40)})`
  return `${where}: ${SEVERITY_NAMES[d.severity]}${code}: ${oneLine(d.message, MAX_MESSAGE_CHARS)}${source}`
}

/** One line of at most `max` characters: whitespace runs (newlines included) become one space, control characters go. */
export function oneLine(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const flat = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  // Do not cut a surrogate pair in half.
  let cut = max - 3
  const code = flat.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${flat.slice(0, cut)}...`
}
