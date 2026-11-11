/**
 * The provider error taxonomy. Every failure of a model call is classified
 * into exactly one kind at the provider boundary; nothing above the provider
 * inspects HTTP statuses or error strings.
 */
import { type Infer, type Validator, integer, nullable, object, oneOf, string, literal, variant } from "../validate.ts"

/**
 * Whether each kind may be retried unchanged (retry rule 3). This table is the
 * only place the classification lives; `providerError` copies it onto the value.
 *
 * - `rate_limit`: the provider asked us to slow down (HTTP 429 without a usage-limit code).
 * - `provider_internal`: the provider failed (HTTP 5xx, overloaded).
 * - `transport`: the request or response never made it (DNS, reset, timeout).
 * - `incomplete_stream`: the stream ended without its terminal event.
 * - `auth`: credentials missing, expired or rejected. Needs a new sign-in.
 * - `usage_limit`: the plan's usage limit is exhausted. `retryAfterMs`, when known, is when it resets.
 * - `content_policy`: the provider refused the content. The step becomes `step.refused`.
 * - `invalid_request`: the provider rejected the request as malformed. Retrying it unchanged cannot work.
 * - `context_overflow`: the request exceeds the model's context window. Handled by one
 *   compaction and a rebuild, and only if no output had started (retry rule 5), never by a plain retry.
 */
export const RETRYABLE = {
  rate_limit: true,
  provider_internal: true,
  transport: true,
  incomplete_stream: true,
  auth: false,
  usage_limit: false,
  content_policy: false,
  invalid_request: false,
  context_overflow: false,
} as const

export type ProviderErrorKind = keyof typeof RETRYABLE

const detail = {
  /** Human-readable description, safe to show and to store. Never contains credentials. */
  message: string,
  /** HTTP status when the failure was an HTTP response. */
  status: nullable(integer(100)),
  /** The provider's own error code or type, kept for diagnosis only. */
  code: nullable(string),
  /** Minimum delay before the next attempt (or until the usage limit resets), when the provider said. */
  retryAfterMs: nullable(integer(0)),
}

function kind<K extends ProviderErrorKind>(name: K) {
  return object({ kind: literal(name), retryable: literal(RETRYABLE[name]), ...detail })
}

export const providerError = variant("kind", {
  rate_limit: kind("rate_limit"),
  provider_internal: kind("provider_internal"),
  transport: kind("transport"),
  incomplete_stream: kind("incomplete_stream"),
  auth: kind("auth"),
  usage_limit: kind("usage_limit"),
  content_policy: kind("content_policy"),
  invalid_request: kind("invalid_request"),
  context_overflow: kind("context_overflow"),
} satisfies Record<ProviderErrorKind, Validator<unknown>>)

/** A classified failure. `retryable` is fixed by `kind`, so `if (error.retryable)` narrows the kind. */
export type ProviderError = Infer<typeof providerError>

export const providerErrorKind = oneOf(Object.keys(RETRYABLE) as [ProviderErrorKind, ...ProviderErrorKind[]])

/** Builds a `ProviderError`, filling `retryable` from the table. */
export function makeProviderError<K extends ProviderErrorKind>(
  kind: K,
  message: string,
  detail: { status?: number; code?: string; retryAfterMs?: number } = {},
): Extract<ProviderError, { kind: K }> {
  return {
    kind,
    retryable: RETRYABLE[kind],
    message,
    status: detail.status ?? null,
    code: detail.code ?? null,
    retryAfterMs: detail.retryAfterMs ?? null,
  } as Extract<ProviderError, { kind: K }>
}
