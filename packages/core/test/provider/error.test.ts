import { describe, expect, test } from "bun:test"
import { RETRYABLE, type ProviderError, type ProviderErrorKind, makeProviderError, providerError } from "../../src/provider/error.ts"
import { usage } from "../../src/provider/usage.ts"
import { DecodeError } from "../../src/validate.ts"

const kinds = Object.keys(RETRYABLE) as ProviderErrorKind[]

describe("provider error taxonomy", () => {
  test("retries only rate limit, provider failure, transport and incomplete stream", () => {
    expect(kinds.filter((kind) => RETRYABLE[kind]).sort()).toEqual([
      "incomplete_stream",
      "provider_internal",
      "rate_limit",
      "transport",
    ])
    expect(kinds.filter((kind) => !RETRYABLE[kind]).sort()).toEqual([
      "auth",
      "content_policy",
      "context_overflow",
      "invalid_request",
      "usage_limit",
    ])
  })

  test("makeProviderError fills retryable from the table and nulls for missing detail", () => {
    expect(makeProviderError("rate_limit", "slow down", { status: 429, retryAfterMs: 1500 })).toEqual({
      kind: "rate_limit",
      retryable: true,
      message: "slow down",
      status: 429,
      code: null,
      retryAfterMs: 1500,
      requestId: null,
    })
    expect(makeProviderError("auth", "sign in again", { requestId: "req_1" })).toEqual({
      kind: "auth",
      retryable: false,
      message: "sign in again",
      status: null,
      code: null,
      retryAfterMs: null,
      requestId: "req_1",
    })
  })

  test("a transport error says whether the connection broke or stalled, and no other kind has a reason", () => {
    expect(makeProviderError("transport", "reset")).toMatchObject({ kind: "transport", retryable: true, reason: "connection" })
    const stalled = makeProviderError("transport", "no data for 300000 ms", { reason: "stalled" })
    expect(stalled).toMatchObject({ kind: "transport", retryable: true, reason: "stalled" })
    expect(providerError(JSON.parse(JSON.stringify(stalled)), "")).toEqual(stalled)
    expect(makeProviderError("rate_limit", "slow down", { reason: "stalled" })).not.toHaveProperty("reason")
    const { reason: _, ...withoutReason } = stalled
    expect(() => providerError(withoutReason, "error")).toThrow(DecodeError)
    expect(() => providerError({ ...stalled, reason: "slow" }, "error")).toThrow(DecodeError)
    expect(() => providerError({ ...makeProviderError("auth", "nope"), reason: "stalled" }, "error")).toThrow(DecodeError)
  })

  test("every kind survives a JSON round trip through the validator", () => {
    for (const kind of kinds) {
      const error = makeProviderError(kind, "message", { code: "some_code", requestId: "req_abc" })
      expect(providerError(JSON.parse(JSON.stringify(error)), "")).toEqual(error)
    }
  })

  test("a stored error whose retryable flag contradicts its kind is rejected", () => {
    const forged = { ...makeProviderError("auth", "nope"), retryable: true }
    expect(() => providerError(forged, "error")).toThrow(DecodeError)
    expect(() => providerError({ ...makeProviderError("auth", "nope"), kind: "timeout" }, "error")).toThrow(DecodeError)
  })

  test("retryable narrows the kind at compile time", () => {
    const describe = (error: ProviderError): string => {
      if (error.retryable) {
        const kind: "rate_limit" | "provider_internal" | "transport" | "incomplete_stream" = error.kind
        return kind
      }
      const kind: "auth" | "usage_limit" | "content_policy" | "invalid_request" | "context_overflow" = error.kind
      return kind
    }
    expect(describe(makeProviderError("transport", "reset"))).toBe("transport")
    expect(describe(makeProviderError("usage_limit", "limit reached"))).toBe("usage_limit")
  })
})

describe("usage", () => {
  test("accepts non-negative integers only", () => {
    const value = { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 80, reasoningTokens: 32 }
    expect(usage(value, "")).toEqual(value)
    expect(() => usage({ ...value, cachedInputTokens: -1 }, "")).toThrow(DecodeError)
    expect(() => usage({ ...value, outputTokens: 1.5 }, "")).toThrow(DecodeError)
    expect(() => usage({ inputTokens: 1, outputTokens: 1 }, "")).toThrow(DecodeError)
  })
})
