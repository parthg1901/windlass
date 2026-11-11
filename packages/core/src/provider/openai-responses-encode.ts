/**
 * Encodes a `ModelRequest` as a Responses API request body and headers.
 *
 * The encoding is a pure function of the request and the bytes of the blobs it
 * refers to: the same request always gives the same bytes, because the body is
 * serialised with `canonicalJson` (keys sorted, no whitespace).
 *
 * Fixed choices, all verified live on the Sign in with ChatGPT flow
 * (docs/reference/responses-api.md, "Verified live"):
 * - `store: false` and `stream: true` on every request. Nothing in the
 *   rejected list (`temperature`, `top_p`, `max_output_tokens`,
 *   `previous_response_id`, `metadata`, `user`, `truncation`, ...) is ever sent,
 *   and there is no `system` role.
 * - `params.cacheKey` goes out as the `session-id` header (the server derives
 *   the prompt cache key from it; without it hits are erratic) and also as
 *   `prompt_cache_key`, which the server overwrites with the same value.
 * - Tools are plain top-level `function` tools with `strict: false`: the
 *   tool track's schemas need not meet strict mode's rules (every property
 *   required, `additionalProperties: false`), and an omitted `strict` would let
 *   the server pick per schema.
 * - `include: ["reasoning.encrypted_content"]` is sent although stateless mode
 *   returns it by default, so replay keeps working if that default changes.
 * - `stream_options.include_obfuscation: false` drops the padding field from
 *   every delta.
 *
 * Replay of provider-owned items (`providerData`, produced by the decoder in
 * openai-responses-decode.ts):
 * - Reasoning: `providerData` is the complete `output_item.done` reasoning
 *   item without its `type` (`id`, `summary`, `content`, `encrypted_content`).
 *   It is replayed verbatim as `{type: "reasoning", ...providerData}`. This is
 *   the documented way to carry reasoning across tool calls statelessly, was
 *   accepted live, and keeps the bytes of every earlier step identical, which
 *   the prompt cache needs. Replaying the readable `text` instead would be
 *   useless to the model and dropping the item would change the history that
 *   the cache saw. A reasoning item without `providerData` (or without
 *   `encrypted_content`) carries nothing the API can use and is not sent.
 * - Assistant text: `providerData` holds the item `id` and `phase`; the item
 *   is rebuilt as a completed assistant message with one `output_text` part.
 *   `phase` must be replayed or commentary looks like a final answer.
 * - Tool calls: `providerData` holds the item `id` (and `namespace`, if the
 *   call had one); `status` is not replayed (accepted live without it).
 */
import type { BlobRef, Content } from "../content.ts"
import type { Json } from "../json.ts"
import { canonicalJson } from "../request/canonical.ts"
import type { InputItem, ModelRequest } from "../request/request.ts"

/** Bytes of the blobs a request refers to, by hash. */
export type BlobBytes = ReadonlyMap<string, Uint8Array>

export interface EncodedRequest {
  /** The JSON body, in canonical key order. */
  readonly body: string
  /** Request headers other than `Authorization`, in a fixed order. */
  readonly headers: Readonly<Record<string, string>>
}

export function encodeRequest(request: ModelRequest, blobs: BlobBytes): EncodedRequest {
  const params = request.params
  const body: Record<string, Json | undefined> = {
    model: params.model,
    store: false,
    stream: true,
    stream_options: { include_obfuscation: false },
    include: ["reasoning.encrypted_content"],
    instructions: request.instructions.length > 0 ? request.instructions : undefined,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
    tool_choice: request.toolChoice,
    parallel_tool_calls: params.parallelToolCalls,
    reasoning: { effort: params.reasoningEffort ?? undefined, summary: "auto" } as Json,
    text: params.textVerbosity === null ? undefined : { verbosity: params.textVerbosity },
    prompt_cache_key: params.cacheKey ?? undefined,
    input: request.input.flatMap((item) => encodeItem(item, blobs)),
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  }
  if (params.cacheKey !== null) headers["session-id"] = params.cacheKey
  return { body: canonicalJson(body), headers }
}

/** Every blob a request refers to, in first-use order, without duplicates. */
export function blobRefs(request: ModelRequest): BlobRef[] {
  const refs = request.input.flatMap((item): readonly BlobRef[] => {
    if (item.type === "message") return item.content.flatMap((part) => (part.type === "media" ? [part.blob] : []))
    if (item.type === "tool_result") return item.attachments
    return []
  })
  const seen = new Set<string>()
  return refs.filter((ref) => !seen.has(ref.hash) && seen.add(ref.hash))
}

function encodeItem(item: InputItem, blobs: BlobBytes): Json[] {
  switch (item.type) {
    case "message":
      return [{ type: "message", role: item.role, content: encodeContent(item.content, blobs) }]
    case "assistant_text": {
      const data = record(item.providerData)
      return [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          id: stringField(data, "id"),
          phase: data.phase === undefined ? undefined : data.phase,
          content: [{ type: "output_text", text: item.text, annotations: [] }],
        } as Json,
      ]
    }
    case "reasoning": {
      const data = record(item.providerData)
      if (typeof data.encrypted_content !== "string") return []
      return [{ ...data, type: "reasoning" }]
    }
    case "tool_call": {
      const data = record(item.providerData)
      return [
        {
          type: "function_call",
          id: stringField(data, "id"),
          namespace: stringField(data, "namespace"),
          call_id: item.callId,
          name: item.name,
          arguments: item.input,
        } as Json,
      ]
    }
    case "tool_result":
      return [
        {
          type: "function_call_output",
          call_id: item.callId,
          output:
            item.attachments.length === 0
              ? item.output
              : [
                  { type: "input_text", text: item.output },
                  ...item.attachments.map((blob) => encodeMedia(blob, blobs)),
                ],
        },
      ]
  }
}

function encodeContent(content: Content, blobs: BlobBytes): Json[] {
  return content.map((part) =>
    part.type === "text" ? { type: "input_text", text: part.text } : encodeMedia(part.blob, blobs),
  )
}

/**
 * Images become `input_image` with a base64 data URL; anything else becomes
 * `input_file` with a data URL in `file_data` (the shape the docs give for
 * PDFs; not exercised live). The file name is derived from the hash so that
 * it is stable.
 */
function encodeMedia(blob: BlobRef, blobs: BlobBytes): Json {
  const bytes = blobs.get(blob.hash)
  if (bytes === undefined) throw new MissingBlobError(blob)
  const url = `data:${blob.mediaType};base64,${Buffer.from(bytes).toString("base64")}`
  if (blob.mediaType.startsWith("image/")) return { type: "input_image", image_url: url, detail: "auto" }
  return { type: "input_file", filename: `${blob.hash.slice(0, 16)}${extension(blob.mediaType)}`, file_data: url }
}

export class MissingBlobError extends Error {
  constructor(readonly blob: BlobRef) {
    super(`blob ${blob.hash} (${blob.mediaType}) is not available`)
  }
}

function extension(mediaType: string) {
  if (mediaType === "application/pdf") return ".pdf"
  if (mediaType.startsWith("text/")) return ".txt"
  return ""
}

function record(value: Json | null): Readonly<Record<string, Json>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, Json>>)
    : {}
}

function stringField(data: Readonly<Record<string, Json>>, key: string): string | undefined {
  const value = data[key]
  return typeof value === "string" ? value : undefined
}
