/**
 * Classification of Responses API failures into the provider error taxonomy,
 * following section 7.6 of docs/reference/responses-api.md.
 *
 * The provider's own code wins over the HTTP status, because the sharing
 * codes cut across statuses (`subscription_sharing_route_not_supported` is a
 * 403 that is an invalid request, not an auth failure; a 429 with
 * `subscription_sharing_usage_limit_exceeded` is a usage limit, not a rate
 * limit). An unknown code falls back to the status, and a failure with
 * neither (a stream `error` event with an unknown code) is `provider_internal`.
 */
import { type ProviderError, type ProviderErrorKind, makeProviderError } from "./error.ts"

const CODES: Record<string, ProviderErrorKind> = {
  // Plan usage.
  subscription_sharing_usage_limit_exceeded: "usage_limit",
  subscription_sharing_workplace_individual_usage_limit_exceeded: "usage_limit",
  usage_limit_reached: "usage_limit",
  insufficient_quota: "usage_limit",
  // Identity and permission.
  subscription_sharing_user_not_eligible: "auth",
  subscription_sharing_invalid_user: "auth",
  chatpass_v2_scope_not_authorized: "auth",
  chatpass_v2_invalid_authorization_context: "auth",
  invalid_api_key: "auth",
  token_expired: "auth",
  // The request is wrong; sending it again cannot work.
  subscription_sharing_unsupported_capability: "invalid_request",
  subscription_sharing_route_not_supported: "invalid_request",
  invalid_encrypted_content: "invalid_request",
  invalid_parameter: "invalid_request",
  invalid_request_error: "invalid_request",
  unsupported_parameter: "invalid_request",
  invalid_image: "invalid_request",
  invalid_image_format: "invalid_request",
  invalid_base64_image: "invalid_request",
  invalid_image_url: "invalid_request",
  image_too_large: "invalid_request",
  image_too_small: "invalid_request",
  image_parse_error: "invalid_request",
  invalid_image_mode: "invalid_request",
  image_file_too_large: "invalid_request",
  unsupported_image_media_type: "invalid_request",
  empty_image_file: "invalid_request",
  failed_to_download_image: "invalid_request",
  image_file_not_found: "invalid_request",
  data_residency_mismatch: "invalid_request",
  // Context window.
  context_length_exceeded: "context_overflow",
  model_context_window_exceeded: "context_overflow",
  // Refusals and policy.
  invalid_prompt: "content_policy",
  bio_policy: "content_policy",
  misalignment_policy_violation: "content_policy",
  image_content_policy_violation: "content_policy",
  content_filter: "content_policy",
  content_policy_violation: "content_policy",
  // Slow down.
  rate_limit_exceeded: "rate_limit",
  rate_limit_error: "rate_limit",
  slow_down: "rate_limit",
  // The provider failed.
  server_error: "provider_internal",
  server_is_overloaded: "provider_internal",
  service_unavailable_error: "provider_internal",
  subscription_sharing_usage_unavailable: "provider_internal",
  subscription_sharing_user_unavailable: "provider_internal",
  vector_store_timeout: "provider_internal",
}

/** Message phrases that mean the input did not fit, as several OpenAI surfaces word it. */
const OVERFLOW =
  /context[_ ]length[_ ]exceeded|context window|maximum context length|input exceeds|too many (input )?tokens|prompt is too long|reduce the length of the (messages|input)/i

export interface FailureDetail {
  /** HTTP status, when the failure was an HTTP response. */
  readonly status?: number
  /** The provider's `error.code`, else its `error.type`. */
  readonly code?: string | null
  readonly message: string
  readonly retryAfterMs?: number | null
  /** The `x-oai-request-id` of the response, appended to the message for diagnosis. */
  readonly requestId?: string | null
}

export function classify(failure: FailureDetail): ProviderError {
  const kind = kindOf(failure)
  const message = failure.requestId ? `${failure.message} (request ${failure.requestId})` : failure.message
  return makeProviderError(kind, message, {
    status: failure.status,
    code: failure.code ?? undefined,
    retryAfterMs: failure.retryAfterMs ?? undefined,
  })
}

function kindOf(failure: FailureDetail): ProviderErrorKind {
  const byCode = failure.code ? CODES[failure.code] : undefined
  // A context overflow is only recognisable by its message when the code is generic or missing.
  const overflow = failure.status !== 429 && OVERFLOW.test(failure.message)
  if (byCode && byCode !== "invalid_request") return byCode
  if (overflow) return "context_overflow"
  if (byCode) return byCode
  const status = failure.status
  if (status === undefined) return "provider_internal"
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status === 408 || status >= 500) return "provider_internal"
  return "invalid_request"
}

/**
 * Reads a pre-stream error body. Three shapes were observed live:
 * `{"detail": "..."}`, `{"error": {code, message, type, param}}` and the same
 * with `code: null`. A body that is not JSON (or has no content type) is kept
 * as text.
 */
export function readErrorBody(text: string): { code: string | null; message: string } {
  const parsed = parseJson(text)
  if (isRecord(parsed)) {
    if (isRecord(parsed.error)) {
      const error = parsed.error
      const code = stringOr(error.code) ?? stringOr(error.type)
      const param = stringOr(error.param)
      const message = stringOr(error.message) ?? code ?? "request failed"
      return { code, message: param ? `${message} [param: ${param}]` : message }
    }
    if (parsed.detail !== undefined) {
      const detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail)
      return { code: null, message: detail }
    }
    const message = stringOr(parsed.message)
    if (message) return { code: stringOr(parsed.code), message }
  }
  const trimmed = text.trim()
  return { code: null, message: trimmed.length > 0 ? clip(trimmed) : "empty error body" }
}

/** `retry-after-ms`, then `retry-after` as seconds or an HTTP date. Absent or unreadable gives null. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ms = headers.get("retry-after-ms")
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms))
  const value = headers.get("retry-after")
  if (value === null) return null
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function clip(text: string) {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
