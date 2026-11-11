/**
 * The OpenAI Responses API provider for "Sign in with ChatGPT" (plan usage):
 * `POST {baseUrl}/responses`, streamed over SSE, stateless (`store: false`).
 *
 * Everything the network or the credentials touch is injected, so tests run
 * against a local server with a fake token.
 *
 * Failure mapping when the stream does not complete:
 * - before a response: token getter failure -> `auth`; `fetch` rejects ->
 *   `transport`; no response headers within `idleTimeoutMs` -> `transport`.
 * - a non-2xx response -> classified from its status and body
 *   (openai-responses-error.ts), with `retry-after` honoured when present.
 * - after the stream opened: a read error (connection reset) -> `transport`;
 *   no bytes (not even a keep-alive comment) for `idleTimeoutMs` ->
 *   `transport`; a clean end of body without a terminal event ->
 *   `incomplete_stream`; a frame that is not JSON -> `provider_internal`.
 * - abort: the HTTP request is cancelled and the stream ends with no terminal event.
 */
import { type BlobRef } from "../content.ts"
import type { ModelRequest } from "../request/request.ts"
import { makeProviderError, type ProviderError } from "./error.ts"
import { ResponsesStreamMapper } from "./openai-responses-decode.ts"
import { MissingBlobError, blobRefs, encodeRequest } from "./openai-responses-encode.ts"
import { classify, isRecord, readErrorBody, retryAfterMs, stringOr } from "./openai-responses-error.ts"
import type { Provider, StreamEvent } from "./provider.ts"
import { SseParser } from "./sse.ts"

export { encodeRequest, blobRefs, MissingBlobError, type EncodedRequest, type BlobBytes } from "./openai-responses-encode.ts"
export { ResponsesStreamMapper } from "./openai-responses-decode.ts"
export { classify, readErrorBody, retryAfterMs } from "./openai-responses-error.ts"

/** The base URL of the Sign in with ChatGPT flow; the same value as `RESOURCE` in auth/chatgpt.ts. */
export const RESPONSES_BASE_URL = "https://api.openai.com/v1"

/** Five minutes. Keep-alive comments reset the timer, so this only fires on a dead connection. */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>

export interface OpenAIResponsesOptions {
  /** Returns a usable access token. In production: `accessToken` from auth/chatgpt.ts. Never logged. */
  readonly accessToken: () => Promise<string>
  /** Returns the bytes of a blob referenced by a media part or tool attachment. */
  readonly readBlob: (ref: BlobRef) => Uint8Array | Promise<Uint8Array>
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchFunction
  /** Defaults to `RESPONSES_BASE_URL`. */
  readonly baseUrl?: string
  /** Longest wait for response headers or for the next bytes of the body. */
  readonly idleTimeoutMs?: number
}

export class OpenAIResponsesProvider implements Provider {
  readonly id = "openai-responses"
  private readonly options: OpenAIResponsesOptions
  private readonly fetch: FetchFunction
  private readonly baseUrl: string
  private readonly idleTimeoutMs: number

  constructor(options: OpenAIResponsesOptions) {
    this.options = options
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.baseUrl = (options.baseUrl ?? RESPONSES_BASE_URL).replace(/\/+$/, "")
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  stream = (request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent> => this.run(request, signal)

  private async *run(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (signal.aborted) return
    // One controller cancels the HTTP request for every reason: caller abort, idle timeout, early exit.
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    let reader: { cancel(): Promise<void> } | undefined
    try {
      const prepared = await this.prepare(request)
      if (signal.aborted) return
      if ("error" in prepared) {
        yield { type: "error", error: prepared.error }
        return
      }

      const opened = await this.open(prepared.body, prepared.headers, prepared.token, controller)
      if (signal.aborted) return
      if ("error" in opened) {
        yield { type: "error", error: opened.error }
        return
      }
      const response = opened.response
      const requestId = response.headers.get("x-oai-request-id")
      if (!response.ok) {
        const text = await this.withTimeout(response.text(), controller)
        if (signal.aborted) return
        yield { type: "error", error: httpError(response, text, requestId) }
        return
      }
      if (!response.body) {
        yield { type: "error", error: makeProviderError("incomplete_stream", "the response had no body", { status: response.status }) }
        return
      }

      const mapper = new ResponsesStreamMapper(requestId)
      const parser = new SseParser()
      const body = response.body.getReader()
      reader = body
      while (!mapper.done) {
        const chunk = await this.withTimeout(body.read(), controller)
        if (signal.aborted) return
        if (chunk instanceof Timeout) {
          yield* mapper.fail(makeProviderError("transport", `no data from the stream for ${this.idleTimeoutMs} ms`))
          break
        }
        if (chunk instanceof Failure) {
          yield* mapper.fail(makeProviderError("transport", `the connection failed mid-stream: ${describe(chunk.cause)}`))
          break
        }
        const frames = chunk.done ? parser.end() : parser.push(chunk.value)
        for (const frame of frames) {
          if (signal.aborted) return
          yield* mapper.frame(frame)
          if (mapper.done) break
        }
        if (chunk.done) {
          yield* mapper.end()
          break
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort)
      // Stops the body after a terminal event, on abort, and when the consumer stops reading early.
      controller.abort()
      reader?.cancel().catch(() => {})
    }
  }

  private async prepare(
    request: ModelRequest,
  ): Promise<{ body: string; headers: Readonly<Record<string, string>>; token: string } | { error: ProviderError }> {
    const blobs = new Map<string, Uint8Array>()
    try {
      for (const ref of blobRefs(request)) blobs.set(ref.hash, await this.options.readBlob(ref))
    } catch (cause) {
      return { error: makeProviderError("invalid_request", `could not read a media blob: ${describe(cause)}`) }
    }
    let encoded
    try {
      encoded = encodeRequest(request, blobs)
    } catch (cause) {
      return { error: makeProviderError("invalid_request", `could not encode the request: ${describe(cause)}`) }
    }
    try {
      return { ...encoded, token: await this.options.accessToken() }
    } catch (cause) {
      return { error: makeProviderError("auth", `no usable access token: ${describe(cause)}`) }
    }
  }

  private async open(
    body: string,
    headers: Readonly<Record<string, string>>,
    token: string,
    controller: AbortController,
  ): Promise<{ response: Response } | { error: ProviderError }> {
    const sent = this.fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${token}` },
      body,
      signal: controller.signal,
    })
    const result = await this.withTimeout(sent, controller)
    if (result instanceof Timeout)
      return { error: makeProviderError("transport", `no response within ${this.idleTimeoutMs} ms`) }
    if (result instanceof Failure)
      return { error: makeProviderError("transport", `the request failed: ${describe(result.cause)}`) }
    return { response: result }
  }

  /**
   * Waits for `promise`, at most `idleTimeoutMs`. On timeout the request is
   * cancelled. A rejection is returned as a `Failure`, never thrown, and the
   * wait ends as soon as the request is cancelled.
   */
  private async withTimeout<T>(promise: Promise<T>, controller: AbortController): Promise<T | Timeout | Failure> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const timeout = new Promise<Timeout>((resolve) => {
      timer = setTimeout(() => {
        resolve(new Timeout())
        controller.abort()
      }, this.idleTimeoutMs)
    })
    const aborted = new Promise<Failure>((resolve) => {
      onAbort = () => resolve(new Failure(controller.signal.reason))
      if (controller.signal.aborted) onAbort()
      else controller.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([promise.catch((cause: unknown) => new Failure(cause)), timeout, aborted])
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener("abort", onAbort)
    }
  }
}

class Timeout {}
class Failure {
  constructor(readonly cause: unknown) {}
}

function httpError(response: Response, text: string | Timeout | Failure, requestId: string | null): ProviderError {
  const body = typeof text === "string" ? readErrorBody(text) : { code: null, message: `HTTP ${response.status}` }
  return classify({
    status: response.status,
    code: body.code,
    message: `HTTP ${response.status}: ${body.message}`,
    retryAfterMs: retryAfterMs(response.headers),
    requestId,
  })
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name
  return String(cause)
}

// ---------------------------------------------------------------- model list

export interface ModelInfo {
  /** Sent as `params.model`. */
  readonly slug: string
  /** Shown to the user. */
  readonly displayName: string
  /** `list` entries are offered to the user; `hide` entries are not. */
  readonly visibility: string
  readonly supportedInApi: boolean
  readonly contextWindow: number | null
  readonly reasoningEfforts: readonly string[]
  readonly defaultReasoningEffort: string | null
}

export class ModelListError extends Error {
  constructor(readonly error: ProviderError) {
    super(error.message)
  }
}

/**
 * Lists the account's models (`GET {baseUrl}/models`, `{models: [...]}`), in
 * the server's order. With `listedOnly` (the default) only `visibility:
 * "list"` entries are returned, as the docs ask. The list is a catalog, not an
 * entitlement check. Throws `ModelListError` with a classified error.
 */
export async function listModels(options: {
  readonly accessToken: () => Promise<string>
  readonly fetch?: FetchFunction
  readonly baseUrl?: string
  readonly listedOnly?: boolean
  readonly signal?: AbortSignal
}): Promise<ModelInfo[]> {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  const baseUrl = (options.baseUrl ?? RESPONSES_BASE_URL).replace(/\/+$/, "")
  let token: string
  try {
    token = await options.accessToken()
  } catch (cause) {
    throw new ModelListError(makeProviderError("auth", `no usable access token: ${describe(cause)}`))
  }
  let response: Response
  let text: string
  try {
    response = await fetcher(`${baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: options.signal,
    })
    text = await response.text()
  } catch (cause) {
    throw new ModelListError(makeProviderError("transport", `the model list request failed: ${describe(cause)}`))
  }
  const requestId = response.headers.get("x-oai-request-id")
  if (!response.ok) throw new ModelListError(httpError(response, text, requestId))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models))
    throw new ModelListError(makeProviderError("provider_internal", "the model list is not {models: [...]}", { status: response.status }))
  const models = parsed.models.filter(isRecord).flatMap((entry): ModelInfo[] => {
    const slug = stringOr(entry.slug)
    if (!slug) return []
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
    return [
      {
        slug,
        displayName: stringOr(entry.display_name) ?? slug,
        visibility: stringOr(entry.visibility) ?? "list",
        supportedInApi: entry.supported_in_api !== false,
        contextWindow: typeof entry.context_window === "number" ? entry.context_window : null,
        reasoningEfforts: levels.flatMap((level) => (isRecord(level) && typeof level.effort === "string" ? [level.effort] : [])),
        defaultReasoningEffort: stringOr(entry.default_reasoning_level),
      },
    ]
  })
  return options.listedOnly === false ? models : models.filter((model) => model.visibility === "list")
}
