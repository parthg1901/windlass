/**
 * The harness's redaction (`ToolContext.redact`) for output that arrives in
 * pieces: a running command's output, which is shown as progress and kept in
 * a file while it runs. A secret can arrive split across two pieces, and the
 * first half alone matches nothing; so the end of what has arrived is held
 * back until it can no longer be the beginning of a secret, and only what is
 * before it is redacted and passed on. What comes out, joined, is what
 * redacting the whole output at once gives, apart from over-redaction where
 * a hold-back point fell inside a word.
 *
 * Held back, from the earliest of:
 * - the start of the last line, which is not finished: every pattern the
 *   redaction knows fits in one line except a private key block;
 * - a replaced secret that ends the text: a token may be longer still, and an
 *   unterminated private key block is replaced up to the end of the text;
 * - where `unfinishedSecret` says a configured value may be starting, so that
 *   a value with a line break in it is held whole. Without it such a value is
 *   missed when the output is cut between its lines.
 *
 * A line longer than `maxHeld` characters is passed on except its last few
 * kilobytes, cut between words: memory stays bounded, and a token cut there
 * (one longer than that rest) is missed.
 */
import type { RedactedText } from "./tool.ts"

export interface StreamRedaction {
  readonly redact: (text: string) => readonly RedactedText[]
  readonly unfinishedSecret?: (text: string) => number
}

export interface RedactingStream {
  readonly write: (chunk: Uint8Array) => void
  /** Passes on everything still held. Nothing may be written after it. */
  readonly end: () => void
}

/** The most text held back. A longer line keeps only `KEPT_CHARS` of its end. */
export const MAX_HELD_CHARS = 64 * 1024
const KEPT_CHARS = 4 * 1024

/** Decodes UTF-8 chunks, redacts them and passes the redacted text on, encoded, to `emit`. */
export function redactingStream(redaction: StreamRedaction, emit: (bytes: Uint8Array) => void, maxHeld = MAX_HELD_CHARS): RedactingStream {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let held = ""
  const flush = (final: boolean) => {
    if (held === "") return
    const pieces = redaction.redact(held)
    let cut = final ? held.length : holdPoint(held, pieces, redaction.unfinishedSecret)
    const forced = held.length - cut > maxHeld
    if (forced) {
      const position = held.length - Math.min(KEPT_CHARS, Math.floor(maxHeld / 2))
      const word = wordStart(held, position)
      cut = word > cut ? word : position
    }
    let out = ""
    let at = 0
    for (const piece of pieces) {
      const end = at + piece.original.length
      if (end <= cut) {
        out += piece.text
        at = end
        continue
      }
      // Text left as it is may be cut anywhere; a replaced secret only when the line it is on is too long to hold.
      if (piece.kind === null && at < cut) {
        out += piece.text.slice(0, cut - at)
        at = cut
      } else if (forced && at < cut) {
        out += piece.text
        at = end
      }
      break
    }
    held = held.slice(at)
    if (out !== "") emit(encoder.encode(out))
  }
  return {
    write: (chunk) => {
      held += decoder.decode(chunk, { stream: true })
      flush(false)
    },
    end: () => {
      held += decoder.decode()
      flush(true)
    },
  }
}

/** Where the text that may still be the beginning of a secret starts. */
function holdPoint(text: string, pieces: readonly RedactedText[], unfinishedSecret: StreamRedaction["unfinishedSecret"]): number {
  const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1
  const last = pieces[pieces.length - 1]
  const markerStart = last !== undefined && last.kind !== null ? text.length - last.original.length : text.length
  return Math.min(lineStart, markerStart, unfinishedSecret === undefined ? text.length : unfinishedSecret(text))
}

/** The start of the word `position` is in, when it starts at most `KEPT_CHARS` before it; else `position`, never inside a surrogate pair. */
function wordStart(text: string, position: number): number {
  for (let index = position - 1; index > 0 && index >= position - KEPT_CHARS; index -= 1) if (/\s/.test(text[index]!)) return index + 1
  return /[\udc00-\udfff]/.test(text[position] ?? "") ? position - 1 : position
}
