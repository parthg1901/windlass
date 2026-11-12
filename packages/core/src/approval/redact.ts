/**
 * Redacts credentials from tool output before it is shown to the model or
 * stored: well-known token formats, private key blocks, passwords in URLs,
 * `Bearer`/`Basic` credentials, and the values of credential-looking
 * environment variables the caller passes in (for example the values of the
 * names `isCredentialName` matches).
 *
 * Every match becomes one of a fixed set of markers, `[REDACTED:<kind>]`.
 * Markers carry no data (not even a variable name, which could itself be
 * made to hold a secret), and text that already is a marker is left alone, so
 * an output cannot smuggle a secret through by printing a fake marker around
 * it. The replacements run until nothing changes, which makes the function
 * idempotent: redacting its result again gives the same string.
 *
 * Misses (false negatives): credentials without a recognisable format
 * (database passwords, custom tokens, `password=hunter2` assignments, which
 * are left alone because code is full of them); environment values shorter
 * than `MIN_SECRET_LENGTH`; secrets split across lines, encoded (base64, URL
 * encoding, hex) or quoted with escapes; and `Basic`/`Bearer` values without a
 * digit; a token glued to the next one with no separator (`…KWsk-ant-…`), which
 * the word-boundary anchors that keep false positives down can miss. Over-redaction (false positives): real-looking example keys in tests
 * and docs (`AKIA…EXAMPLE`), identifiers that happen to start with `sk-` and
 * run 20 characters, JWTs that are not secret, and every occurrence of an
 * environment value anywhere, including a non-secret one such as a region
 * name under an `AWS_` variable. A redacted file read back through `read`
 * also means an `edit` of that region will not match, and a `write` of the
 * whole file would replace the key with the marker.
 */

export const redactionKinds = [
  "private-key",
  "aws-access-key",
  "github-token",
  "gitlab-token",
  "slack-token",
  "stripe-key",
  "google-api-key",
  "npm-token",
  "huggingface-token",
  "anthropic-key",
  "openai-key",
  "jwt",
  "authorization",
  "url-password",
  "env",
] as const
export type RedactionKind = (typeof redactionKinds)[number]

/** Shorter environment values are not redacted: they would match too much ordinary text. */
export const MIN_SECRET_LENGTH = 8

export interface Redaction {
  readonly text: string
  /** The kinds replaced, in `redactionKinds` order. */
  readonly kinds: readonly RedactionKind[]
}

type Rule = { readonly kind: RedactionKind; readonly pattern: RegExp; readonly keep?: number }

/** In order: earlier rules win where they overlap. `keep`: a leading group left in place. */
const RULES: readonly Rule[] = [
  // An unterminated block (a capped output) is redacted to the end of its segment.
  { kind: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "authorization", pattern: /(\b(?:Bearer|Basic) +)(?=[A-Za-z0-9._~+/-]*[0-9])[A-Za-z0-9._~+/-]{16,}=*/g, keep: 1 },
  { kind: "url-password", pattern: /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g, keep: 1 },
]

const MARKER = new RegExp(`(\\[REDACTED:(?:${redactionKinds.join("|")})\\])`)

function marker(kind: RedactionKind) {
  return `[REDACTED:${kind}]`
}

/**
 * One piece of a redacted text. A piece with a `kind` is a marker that stands
 * for `original`, the text that was removed; any other piece is text that was
 * left as it is (`text === original`), which includes text that already was a
 * marker. The pieces' `original`s joined give the input back, and their
 * `text`s joined give the redacted text.
 */
export interface RedactedPiece {
  readonly text: string
  readonly original: string
  readonly kind: RedactionKind | null
}

/**
 * Redacts `text`. `secrets` are values to remove wherever they occur (longest
 * first, so a value that contains another is removed whole).
 */
export function redact(text: string, secrets: readonly string[] = []): Redaction {
  const pieces = redactPieces(text, secrets)
  const found = new Set(pieces.flatMap((piece) => (piece.kind === null ? [] : [piece.kind])))
  return { text: pieces.map((piece) => piece.text).join(""), kinds: redactionKinds.filter((kind) => found.has(kind)) }
}

/**
 * `redact`, keeping for every marker the text it replaced, so that a caller
 * holding the original (a file about to be edited) can tell which part of it
 * a redacted excerpt stands for. `redact` is this function's result joined.
 */
export function redactPieces(text: string, secrets: readonly string[] = []): RedactedPiece[] {
  const values = [...new Set(secrets)].filter((value) => value.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  let current = literals(text)
  // The replacements run until nothing changes. A marker made in one pass is never looked into again.
  for (;;) {
    const next = merge(current.flatMap((piece) => (piece.kind !== null || piece.fixed ? [piece] : redactPart(piece.text, values))))
    if (same(next, current)) break
    current = next
  }
  return current.map((piece) => ({ text: piece.text, original: piece.original, kind: piece.kind }))
}

/** A piece while it is worked on. `fixed`: text that already is a marker, left alone. */
interface Piece extends RedactedPiece {
  readonly fixed: boolean
}

const literal = (text: string, fixed = false): Piece => ({ text, original: text, kind: null, fixed })
const replaced = (kind: RedactionKind, original: string): Piece => ({ text: marker(kind), original, kind, fixed: false })

/** Splits text into what may be redacted and the markers already in it. */
function literals(text: string): Piece[] {
  return text
    .split(MARKER)
    .map((part, index) => literal(part, index % 2 === 1))
    .filter((piece) => piece.text !== "")
}

/** Joins neighbouring pieces of plain text, so a later rule sees them as the one run of text they are. */
function merge(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = []
  for (const piece of pieces) {
    const last = out[out.length - 1]
    if (piece.text === "" && piece.kind === null) continue
    if (last !== undefined && last.kind === null && !last.fixed && piece.kind === null && !piece.fixed) out[out.length - 1] = literal(last.text + piece.text)
    else out.push(piece)
  }
  return out
}

function same(a: readonly Piece[], b: readonly Piece[]): boolean {
  return a.length === b.length && a.every((piece, index) => piece.text === b[index]!.text && piece.kind === b[index]!.kind && piece.original === b[index]!.original)
}

/** One run of text that contains no marker. Replacements are markers, so later rules cannot see into them. */
function redactPart(part: string, values: readonly string[]): Piece[] {
  const plain = (pieces: readonly Piece[], change: (text: string) => Piece[]) => merge(pieces.flatMap((piece) => (piece.kind !== null || piece.fixed ? [piece] : change(piece.text))))
  const afterValues = values.reduce<Piece[]>(
    (pieces, value) =>
      plain(pieces, (text) =>
        text.includes(value) ? text.split(value).flatMap((between, index) => (index === 0 ? [literal(between)] : [replaced("env", value), literal(between)])) : [literal(text)],
      ),
    [literal(part)],
  )
  return RULES.reduce<Piece[]>(
    (pieces, rule) =>
      plain(pieces, (text) => {
        const out: Piece[] = []
        let from = 0
        // A fresh expression per run of text: the shared one carries `lastIndex`.
        for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
          const kept = rule.keep === undefined ? "" : String(match[rule.keep] ?? "")
          out.push(literal(text.slice(from, match.index) + kept), replaced(rule.kind, match[0].slice(kept.length)))
          from = match.index + match[0].length
        }
        out.push(literal(text.slice(from)))
        return out
      }),
    afterValues,
  )
}
