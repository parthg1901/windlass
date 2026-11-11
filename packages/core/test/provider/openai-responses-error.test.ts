import { describe, expect, test } from "bun:test"
import { classify, readErrorBody, retryAfterMs } from "../../src/provider/openai-responses-error.ts"
import { FIXTURES } from "./responses-helpers.ts"

const kindOf = (detail: Parameters<typeof classify>[0]) => classify(detail).kind

describe("classify", () => {
  test("sharing codes win over the status", () => {
    expect(kindOf({ status: 429, code: "subscription_sharing_usage_limit_exceeded", message: "limit" })).toBe("usage_limit")
    expect(kindOf({ status: 429, code: "subscription_sharing_workplace_individual_usage_limit_exceeded", message: "limit" })).toBe("usage_limit")
    expect(kindOf({ status: 403, code: "subscription_sharing_route_not_supported", message: "route" })).toBe("invalid_request")
    expect(kindOf({ status: 403, code: "subscription_sharing_user_not_eligible", message: "no" })).toBe("auth")
    expect(kindOf({ status: 401, code: "subscription_sharing_invalid_user", message: "no" })).toBe("auth")
    expect(kindOf({ status: 403, code: "chatpass_v2_scope_not_authorized", message: "no" })).toBe("auth")
    expect(kindOf({ status: 403, code: "chatpass_v2_invalid_authorization_context", message: "no" })).toBe("auth")
    expect(kindOf({ status: 400, code: "subscription_sharing_unsupported_capability", message: "no" })).toBe("invalid_request")
    expect(kindOf({ status: 503, code: "subscription_sharing_usage_unavailable", message: "later" })).toBe("provider_internal")
    expect(kindOf({ status: 503, code: "subscription_sharing_user_unavailable", message: "later" })).toBe("provider_internal")
  })

  test("statuses without a known code", () => {
    expect(kindOf({ status: 400, message: "System messages are not allowed" })).toBe("invalid_request")
    expect(kindOf({ status: 413, message: "payload too large" })).toBe("invalid_request")
    expect(kindOf({ status: 401, message: "Unauthorized" })).toBe("auth")
    expect(kindOf({ status: 403, message: "region" })).toBe("auth")
    expect(kindOf({ status: 429, message: "slow down" })).toBe("rate_limit")
    expect(kindOf({ status: 500, message: "oops" })).toBe("provider_internal")
    expect(kindOf({ status: 503, message: "Direct routing unavailable" })).toBe("provider_internal")
    expect(kindOf({ status: 408, message: "timeout" })).toBe("provider_internal")
  })

  test("stream failures with no status: known codes, policy codes, unknown codes", () => {
    expect(kindOf({ code: "server_error", message: "The model failed to generate a response." })).toBe("provider_internal")
    expect(kindOf({ code: "rate_limit_exceeded", message: "slow" })).toBe("rate_limit")
    for (const code of ["invalid_prompt", "bio_policy", "misalignment_policy_violation", "image_content_policy_violation"])
      expect(kindOf({ code, message: "policy" })).toBe("content_policy")
    expect(kindOf({ code: "invalid_base64_image", message: "bad image" })).toBe("invalid_request")
    expect(kindOf({ code: "something_new", message: "?" })).toBe("provider_internal")
    expect(kindOf({ message: "?" })).toBe("provider_internal")
  })

  test("context overflow by code or message, never for a 429", () => {
    expect(kindOf({ status: 400, code: "context_length_exceeded", message: "too long" })).toBe("context_overflow")
    expect(kindOf({ status: 400, code: "model_context_window_exceeded", message: "too long" })).toBe("context_overflow")
    expect(kindOf({ status: 400, code: "invalid_request_error", message: "Your input exceeds the context window of this model." })).toBe("context_overflow")
    expect(kindOf({ status: 400, message: "This model's maximum context length is 400000 tokens." })).toBe("context_overflow")
    expect(kindOf({ code: null, message: "Input exceeds the context window" })).toBe("context_overflow")
    expect(kindOf({ status: 429, message: "Request too large: too many tokens per min" })).toBe("rate_limit")
  })

  test("the request id is appended to the message and detail is kept", () => {
    expect(classify({ status: 429, code: "slow_down", message: "HTTP 429: slow", retryAfterMs: 2000, requestId: "req_TEST1" })).toEqual({
      kind: "rate_limit",
      retryable: true,
      message: "HTTP 429: slow (request req_TEST1)",
      status: 429,
      code: "slow_down",
      retryAfterMs: 2000,
    })
  })
})

describe("readErrorBody", () => {
  test("the three observed shapes and plain text", async () => {
    const fixture = async (name: string) =>
      JSON.stringify(((await Bun.file(`${FIXTURES}/${name}`).json()) as { body: unknown }).body)
    expect(readErrorBody(await fixture("http-400-unsupported-parameter.json"))).toEqual({ code: null, message: "Unsupported parameter: temperature" })
    expect(readErrorBody(await fixture("http-400-invalid-encrypted-content.json"))).toEqual({
      code: "invalid_encrypted_content",
      message: "The encrypted content for item rs_TEST1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    })
    expect(
      readErrorBody('{"error":{"message":"A function call output without a call_id requires a name.","type":"invalid_request_error","param":"input","code":null}}'),
    ).toEqual({ code: "invalid_request_error", message: "A function call output without a call_id requires a name. [param: input]" })
    expect(readErrorBody("<html>Bad gateway</html>")).toEqual({ code: null, message: "<html>Bad gateway</html>" })
    expect(readErrorBody("")).toEqual({ code: null, message: "empty error body" })
    expect(readErrorBody('{"detail":{"reason":"x"}}')).toEqual({ code: null, message: '{"reason":"x"}' })
  })
})

describe("retryAfterMs", () => {
  test("milliseconds header, seconds, HTTP date, absent", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500)
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000)
    expect(retryAfterMs(new Headers({ "retry-after": "0.5" }))).toBe(500)
    const now = Date.parse("2026-11-11T00:00:00Z")
    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 11 Nov 2026 00:00:30 GMT" }), now)).toBe(30_000)
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull()
    expect(retryAfterMs(new Headers())).toBeNull()
  })
})
