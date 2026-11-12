/**
 * Editing a file the model was shown redacted.
 *
 * The harness replaces secrets in tool output with placeholders
 * (`[REDACTED:<kind>]`) before the model sees it. A model that read a file
 * this way and then edits it copies the placeholder into `old_string`, which
 * is not the file's text, and may copy it into `new_string` or into the
 * content of a `write`, which would replace the real secret with the
 * placeholder.
 *
 * So the file tools compare with the file as the model was shown it. The
 * tool context carries the harness's own redaction (`ToolContext.redact`),
 * which says, for every placeholder it puts into a text, what it stands for.
 * `old_string` is looked for in that view, the match is mapped back onto the
 * real text, and a placeholder in the replacement is written as the secret
 * the same placeholder stood for in what is replaced. The model never sees
 * the secret and the file never loses it. What cannot be resolved (a
 * placeholder with nothing to stand for, a match that would cut a secret in
 * two) is refused with the reason instead of written.
 */
import type { RedactedText } from "../tool/tool.ts"

/** A redaction placeholder as the harness writes them. */
const PLACEHOLDER = /(\[REDACTED:[a-z-]+\])/

export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text)
}

interface Piece extends RedactedText {
  /** Where the piece starts in the text as shown, and in the real text. */
  readonly shownStart: number
  readonly realStart: number
}

/** A file as the model was shown it, with every position mapped back to the real text. */
export interface RedactedView {
  readonly shown: string
  /** Whether anything in the file is redacted. When nothing is, the view is the file. */
  readonly redacted: boolean
  readonly pieces: readonly Piece[]
}

export function redactedView(real: string, redact: (text: string) => readonly RedactedText[]): RedactedView {
  let shownStart = 0
  let realStart = 0
  const pieces = redact(real).map((piece): Piece => {
    const placed = { ...piece, shownStart, realStart }
    shownStart += piece.text.length
    realStart += piece.original.length
    return placed
  })
  return { shown: pieces.map((piece) => piece.text).join(""), redacted: pieces.some((piece) => piece.kind !== null), pieces }
}

/** A stretch of the real text that a match in the shown text stands for, with the secrets inside it in order. */
export interface RealSpan {
  readonly start: number
  readonly end: number
  readonly secrets: readonly { readonly placeholder: string; readonly original: string }[]
}

/**
 * Where `search` (text as the model was shown it) is in the real file: every
 * occurrence, left to right, without overlaps. `cut` when an occurrence
 * begins or ends inside a secret: half a placeholder stands for nothing.
 */
export function locate(view: RedactedView, search: string): readonly RealSpan[] | "cut" {
  const spans: RealSpan[] = []
  for (let index = view.shown.indexOf(search); index !== -1; index = view.shown.indexOf(search, index + search.length)) {
    const start = realPosition(view, index)
    const end = realPosition(view, index + search.length)
    if (start === null || end === null) return "cut"
    const inside = view.pieces.filter((piece) => piece.kind !== null && piece.shownStart >= index && piece.shownStart + piece.text.length <= index + search.length)
    spans.push({ start, end, secrets: inside.map((piece) => ({ placeholder: piece.text, original: piece.original })) })
  }
  return spans
}

/** The position in the real text of a position in the shown text, or `null` when it lies inside a secret. */
function realPosition(view: RedactedView, shown: number): number | null {
  if (shown === view.shown.length) return view.pieces.reduce((sum, piece) => sum + piece.original.length, 0)
  const piece = view.pieces.find((candidate) => shown >= candidate.shownStart && shown < candidate.shownStart + candidate.text.length)
  if (piece === undefined) return null
  if (piece.kind === null) return piece.realStart + (shown - piece.shownStart)
  return shown === piece.shownStart ? piece.realStart : null
}

/**
 * `text` with each placeholder written as the secret it stands for: the next
 * one of `secrets`, in order, that the same placeholder replaced. Returns the
 * placeholder that stands for nothing when there is one.
 */
export function restore(text: string, secrets: RealSpan["secrets"]): { readonly text: string; readonly restored: number } | { readonly unknown: string } {
  const left = [...secrets]
  let restored = 0
  let unknown: string | null = null
  const out = text
    .split(PLACEHOLDER)
    .map((part, index) => {
      if (index % 2 === 0) return part
      const at = left.findIndex((secret) => secret.placeholder === part)
      if (at === -1) {
        unknown ??= part
        return part
      }
      restored += 1
      return left.splice(at, 1)[0]!.original
    })
    .join("")
  return unknown === null ? { text: out, restored } : { unknown }
}

/** The placeholders in a text, in order. */
export function placeholders(text: string): string[] {
  return text.split(PLACEHOLDER).filter((_, index) => index % 2 === 1)
}
