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
 * Redacts `text`. `secrets` are values to remove wherever they occur (longest
 * first, so a value that contains another is removed whole).
 */
export function redact(text: string, secrets: readonly string[] = []): Redaction {
  const values = [...new Set(secrets)].filter((value) => value.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  const found = new Set<RedactionKind>()
  const pass = (input: string) =>
    input
      .split(MARKER)
      .map((part, index) => (index % 2 === 1 ? part : redactPart(part, values, found)))
      .join("")
  let current = text
  for (let next = pass(current); next !== current; next = pass(current)) current = next
  return { text: current, kinds: redactionKinds.filter((kind) => found.has(kind)) }
}

/** One part of the text that contains no marker. Replacements are markers, so later rules cannot see into them. */
function redactPart(part: string, values: readonly string[], found: Set<RedactionKind>): string {
  const afterValues = values.reduce((text, value) => {
    if (!text.includes(value)) return text
    found.add("env")
    return text.split(value).join(marker("env"))
  }, part)
  return RULES.reduce(
    (text, rule) =>
      text
        .split(MARKER)
        .map((piece, index) =>
          index % 2 === 1
            ? piece
            : piece.replace(rule.pattern, (match, ...groups) => {
                found.add(rule.kind)
                const kept = rule.keep === undefined ? "" : String(groups[rule.keep - 1] ?? "")
                return `${kept}${marker(rule.kind)}`
              }),
        )
        .join(""),
    afterValues,
  )
}
