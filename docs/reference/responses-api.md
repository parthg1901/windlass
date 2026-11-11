# OpenAI Responses API reference (Sign in with ChatGPT, open-source plan usage)

Scope: everything a streaming client needs in order to drive a multi-step, tool-calling agent loop against
`POST https://api.openai.com/v1/responses` with an OAuth access token from "Sign in with ChatGPT" for
open-source apps (ChatGPT plan usage). Compiled 2026-11-11.

How to read the provenance tags. Every statement ends with one or more tags:

- `[docs:KEY]` means OpenAI documentation. Keys resolve to URLs in the table below.
- `[oc:FILE:LINE]` means observed in the read-only opencode snapshot. File keys resolve to paths below. opencode is a
  cross-check only. Where it disagrees with the docs, the docs win and the disagreement is listed in section 12.

| Docs key | URL |
| --- | --- |
| SIWC-FULL | https://developers.openai.com/siwc/llms-full.txt |
| SIWC-OV | https://developers.openai.com/siwc/token-sharing-open-source |
| SIWC-MI | https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference |
| SIWC-PL | https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations |
| SIWC-ER | https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery |
| SIWC-TR | https://developers.openai.com/siwc/token-sharing-open-source/token-reference |
| SIWC-AS | https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions |
| API-CREATE | https://developers.openai.com/api/reference/resources/responses/methods/create |
| API-EVENTS | https://developers.openai.com/api/reference/resources/responses/streaming-events |
| API-MODELS | https://developers.openai.com/api/reference/resources/models/methods/list |
| G-STREAM | https://developers.openai.com/api/docs/guides/streaming-responses |
| G-FC | https://developers.openai.com/api/docs/guides/function-calling |
| G-STATE | https://developers.openai.com/api/docs/guides/conversation-state |
| G-REASON | https://developers.openai.com/api/docs/guides/reasoning |
| G-PREFIX | https://developers.openai.com/api/docs/guides/preserved-reasoning |
| G-CACHE | https://developers.openai.com/api/docs/guides/prompt-caching |
| G-ERR | https://developers.openai.com/api/docs/guides/error-codes |
| G-RL | https://developers.openai.com/api/docs/guides/rate-limits |
| G-VISION | https://developers.openai.com/api/docs/guides/images-vision |

All `.md` variants of these pages (append `.md`) carry the same text [docs:SIWC-MI].

- `[live]` means observed against the real endpoint on 2026-11-11 with `scripts/probe-responses.ts` (model `gpt-6-luna`,
  effort `low` unless noted). Raw captures stay in the git-ignored `captures/`; trimmed fixtures are in
  `packages/core/test/fixtures/responses/`. Where `[live]` contradicts a docs or opencode claim in the body, the old
  claim is kept and marked "Corrected (live)".

| Source key | Path under the opencode snapshot `.../scratchpad/opencode-dev/` |
| --- | --- |
| OR | `packages/ai/src/protocols/open-responses.ts` (provider-neutral Responses request lowering and stream parser) |
| OAR | `packages/ai/src/protocols/openai-responses.ts` (OpenAI-specific route on top of OR) |
| CG | `packages/core/src/plugin/provider/chatgpt.ts` (the Sign in with ChatGPT plan-usage plugin, i.e. this flow) |
| PE | `packages/ai/src/provider-error.ts` (error classification) |
| RC | `packages/ai/src/route/client.ts` (stream driver) |
| EX | `packages/ai/src/route/executor.ts` (HTTP executor, rate-limit headers) |
| SH | `packages/ai/src/protocols/shared.ts` |
| CACHE | `packages/ai/src/protocols/utils/cache.ts` |
| FR | `packages/ai/src/route/framing.ts` |
| OCORE | `packages/core/src/plugin/provider/openai.ts` (the older Codex-backend ChatGPT flow at `chatgpt.com/backend-api/codex`; NOT this flow, cited only for contrast) |

---

## Verified live (2026-11-11)

One line per finding. Probe name in brackets; run `bun scripts/probe-responses.ts <name>` to re-check. 46 inference
requests in total.

1. Plain top-level `{type:"function", name, description, parameters, strict:true}` tools are accepted and called. A
   `namespace` tool is also accepted, and its call carries `namespace:"wx"` [tools] [extras].
2. Function-call stream order: `output_item.added` (`arguments:""`, `status:"in_progress"`) →
   `function_call_arguments.delta`×n → `function_call_arguments.done` → `output_item.done` → `response.metadata` →
   `response.completed` [tools].
3. Calls in a parallel response came with no `function_call_arguments.delta` at all, only `.done`. Arguments were
   formatted differently there (`{"city": "Paris"}`, with a space). Two calls arrive one after the other at
   `output_index` 0 and 1, never interleaved [parallel].
4. Stateless replay works. Item `id`s are optional everywhere: the minimal `{type:"function_call", call_id, name,
   arguments}` (no `id`, no `status`) is accepted, and so is an invented `fc_` id. `function_call_output` without
   `call_id` fails with 400 `"A function call output without a call_id requires a name."` (`code: null`) [replay].
5. `encrypted_content` is returned by default with `store:false`; `include: ["reasoning.encrypted_content"]` is
   accepted but not needed. It is already complete-looking on `output_item.added` [reasoning].
6. Replaying a reasoning item is optional. With it, without it (function_call kept), or without its `id`, the next
   request completes. With it, input grows by about 15 tokens (the attribution map bills the `rs_` item). A corrupted
   `encrypted_content` fails with 400 `invalid_encrypted_content` [reasoning].
7. Reasoning items have keys `type, id, summary, content, encrypted_content` and no `status`. At effort `low`,
   `gpt-6-luna` emitted no reasoning item for simple prompts; at `medium` it did (`reasoning_tokens` 13) [reasoning].
8. `instructions` and a `developer` message are both accepted. A `system` message fails with HTTP 400
   `{"detail":"System messages are not allowed"}` [instructions].
9. Rejected request fields fail before the stream with HTTP 400, `content-type: application/json` and body
   `{"detail":"Unsupported parameter: temperature"}`. An unknown field gets the same shape. There is no `error.code`
   for these [rejected].
10. Unsupported input items fail with HTTP 400 `{"error":{"type":"invalid_request_error","param":"input",
    "code":"subscription_sharing_unsupported_capability",...}}`. `configuration_update` is one of them [extras].
11. Three pre-stream error body shapes exist: `{"detail"}`, `{"error"}` with a code, and `{"error"}` with `code: null`.
    One 400 (`invalid_encrypted_content`) came without a `content-type` header [rejected] [replay] [reasoning].
12. SSE framing: every frame has `event: <type>` and `data: <json>` lines, and the event name matches the JSON `type`.
    No `[DONE]` sentinel is sent. `: keep-alive` comment lines occur. The last event of every successful stream was
    `response.completed` [framing].
13. `response.metadata` (undocumented) appears once per stream, carrying `response_id` and a large
    `metadata.openai_chatgpt_moderation_metadata` object. It can arrive in the middle of a message item (between
    `output_text.delta` and `output_text.done`), not only after the items [framing] [text].
14. Delta events carry an `obfuscation` string by default; `stream_options.include_obfuscation:false` removes it.
    `response_id` appears only on `response.metadata`, not on function-call events [framing] [extras].
15. Event types seen across 38 streams: `output_text.delta`, `output_item.added`/`.done`, `created`, `in_progress`,
    `metadata`, `completed`, `content_part.added`/`.done`, `output_text.done`, `function_call_arguments.delta`/`.done`,
    `reasoning_summary_part.added`/`.done`, `reasoning_summary_text.delta`/`.done`. No `error`, `response.failed`,
    `response.incomplete` or `reasoning_text.*` was ever observed [framing].
16. Usage on `response.completed`: `input_tokens`, `input_tokens_details.{cached_tokens, cache_write_tokens}`,
    `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens`, plus `attribution` [usage].
17. `attribution.items` maps an item id to `{input_tokens, cached_tokens, cache_write_tokens, output_tokens,
    content?: [same per content part]}` for every input item and the output item. Input items sent without ids get
    server ids (`msg_`, `fc_`), so the keys cannot be matched to the request by id, only by order.
    `attribution.request_fields.tools` bills the tool definitions (38 tokens for one small tool) [usage] [cache].
18. `cache_write_tokens` was 0 in every response, including cold ones [cache].
19. Prompt caching is only reliable with a stable `session-id` request header. The server overwrites
    `prompt_cache_key`: the echoed value is the `session-id` header when present, otherwise a fresh random UUID per
    request. Correction (orchestrator re-probe, same day, one run of four requests per condition, 10 s apart):
    without the header a hit is possible but erratic (no key: miss, hit, miss, miss; body `prompt_cache_key` only:
    miss, miss, hit, miss), which looks like requests landing on different cache shards. With the header, every
    request after the cold one hit (3 of 3, with and without a matching body key). The first probe's "a body key alone
    never hit" was too strong [cache] [cache2] [re-probe].
19a. A cold prefix is not readable straight away. Two re-runs with a 2 s gap missed on the second request even with
    a stable `session-id`, then hit on the third. With a 10 s gap the second request hit. Expect the first follow-up
    after a cold write to miss if it is sent within a few seconds [re-probe].
20. With a stable `session-id`: a repeat request cached 3,072 of about 3,260 input tokens (twice). Changing only the
    last user message still cached 3,072. Changing one tool description cached 0. The same prefix under a different
    `session-id` cached 0, so the cache is scoped to the session-id [cache] [cache2].
21. `prompt_cache_options` fails on `gpt-6-luna` with 400 `{"error":{"code":"invalid_parameter",
    "param":"prompt_cache_options","message":"prompt_cache_options is not supported on this model"}}` [extras].
22. Response headers on a 200 stream: `x-oai-request-id` (e.g. `req_…`; not `x-request-id`), `cf-ray`,
    `x-models-etag`, `x-codex-turn-state` (an opaque `gAAAA…` blob), `x-openai-proxy-wasm`, plus standard ones. No
    `x-ratelimit-*`, `retry-after` or `openai-processing-ms` headers appeared on 200 or 400 responses [headers].
23. `tool_choice:"none"` with tools present is accepted; the model answers in text and makes no call [toolnone].
24. `parallel_tool_calls:true` gave two calls in one response; `false` is accepted and gave one call [parallel].
25. Aborting a stream from the client after the first text delta causes no problem; the next request completes
    [abort].
26. `allowed_tools` with `mode:"none"` fails with 400 `"'none' is not a valid mode for Allowed Tools."` [extras].
27. A zstd-compressed body with `Content-Encoding: zstd` is accepted [extras].
28. The echoed response shows server defaults: `reasoning.summary:"detailed"` when `auto` was sent,
    `reasoning.context:"all_turns"`, `prompt_cache_retention:"24h"`, `temperature:1.0`, `top_p:0.98`, and a
    `safety_identifier` (`user-…`). `response.completed.response.output` is populated even with `store:false`
    [text] [tools].
29. The model list is `{models:[...]}`, as the SIWC docs say. Entries carry `visibility` (`list`/`hide`),
    `supported_in_api`, `context_window`, `max_context_window`, `supported_reasoning_levels`,
    `default_reasoning_level`, `default_verbosity`, `supports_parallel_tool_calls`,
    `supports_reasoning_effort_updates`, `prefer_websockets: true`, `base_instructions` and many Codex-specific
    flags. `gpt-6-luna` is described as "Fast and affordable model for easier tasks" (GET /models, not counted above).

---

## 0. The flow in one screen

1. Authenticate: `Authorization: Bearer <ACCESS_TOKEN>` on `POST https://api.openai.com/v1/responses` [docs:SIWC-MI].
   Do not use ChatGPT `backend-api` endpoints for this flow [docs:SIWC-MI].
2. Every HTTP inference request sets `"store": false` and `"stream": true` [docs:SIWC-MI] [docs:SIWC-PL].
3. `input` is an array containing all the context the request needs; `previous_response_id` is omitted over HTTP
   [docs:SIWC-PL].
4. Success is only `response.completed`. Read through the terminal event; handle `response.incomplete`, explicit errors
   and interrupted streams separately [docs:SIWC-MI].
5. A usage-limit failure can arrive as `response.failed` after streaming has begun [docs:SIWC-MI].
6. Plan-usage errors stop inference. OpenAI does not silently switch billing. Preserve the HTTP status, body shape,
   error code and request ID [docs:SIWC-ER].
7. Access tokens last one hour (`expires_in: 3600`); refresh tokens last 30 days and rotate on every refresh
   [docs:SIWC-TR]. Refresh near expiry and serialize refreshes per session [docs:SIWC-AS].

---

## 1. Request body

### 1.1 Required under this flow

| Field | Value | Source |
| --- | --- | --- |
| `model` | A `slug` from the account's model list (section 8) | [docs:SIWC-MI] |
| `input` | Array of input items (section 3). Send the full history each call | [docs:SIWC-PL] |
| `store` | `false` | [docs:SIWC-MI] [docs:SIWC-PL] |
| `stream` | `true` | [docs:SIWC-MI] [docs:SIWC-PL] |

`store` defaults to `true` when omitted in the general API, so it must be sent explicitly [docs:API-CREATE].

### 1.2 Rejected under this flow (omit them)

`background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`,
`prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`
[docs:SIWC-PL].

Also rejected or unsupported:

- `previous_response_id` over HTTP [docs:SIWC-PL].
- `{ "type": "message", "role": "system" }` input items [docs:SIWC-PL].
- Hosted tools: image generation, file search, Code Interpreter, native computer use, hosted MCP/connectors, Responses
  `tool_search`. `programmatic_tool_calling` is not accepted in top-level `tools` [docs:SIWC-PL].
- Audio/video input, the Files upload API and the transcription API [docs:SIWC-PL].
- The OAuth authorization parameter `prompt=consent` is unrelated to the request-body `prompt` field. The body field is
  unsupported [docs:SIWC-ER].
- An unsupported input, tool, execution feature, model or service-tier override fails with
  `subscription_sharing_unsupported_capability` (HTTP 400). `error.param` names the offending field [docs:SIWC-ER].
  Corrected (live): that holds for unsupported input items (`param: "input"`). Rejected or unknown top-level
  fields instead return HTTP 400 `{"detail":"Unsupported parameter: <field>"}` with no code, and a `system` message
  returns `{"detail":"System messages are not allowed"}` [live].
- opencode disables `reasoning.mode: "pro"` models for this flow [oc:CG:325-327]. It also disables
  `configuration_update` effort updates [oc:CG:322] and native `/responses/compact` ("Token sharing does not support
  native /responses/compact") [oc:CG:323-324]. The docs do not state these three restrictions; see section 12.
  `configuration_update` is confirmed rejected with `subscription_sharing_unsupported_capability` [live].

### 1.3 Accepted (not on the rejected list) and relevant to an agent loop

`instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `include`, `reasoning` (`effort`, `summary`), `text`
(`verbosity`, `format`), `prompt_cache_key`, `stream_options`. These are documented in the general API
[docs:API-CREATE] and are absent from the rejected list [docs:SIWC-PL]. The SIWC docs never affirmatively list
"accepted" fields, so acceptance is inferred from absence. Live: `instructions`, `tools`, `tool_choice`,
`parallel_tool_calls`, `include`, `reasoning` (`effort`, `summary`), `prompt_cache_key` and `stream_options` are all
accepted; `text` was not sent on its own [live]. opencode sends `instructions`, `tools`,
`tool_choice`, `parallel_tool_calls`, `include`, `reasoning`, `text.verbosity` and `prompt_cache_key` on this route
when they are configured [oc:OR:808-845] [oc:OAR:239-268].

Field reference (general API):

| Field | Type / values | Notes | Source |
| --- | --- | --- | --- |
| `instructions` | string or null | "A system (or developer) message inserted into the model's context." | [docs:API-CREATE] |
| `tools` | array | Section 2 | [docs:API-CREATE] |
| `tool_choice` | `"none"`, `"auto"`, `"required"`, `{type:"function",name}`, `{type:"custom",name}`, `{type:"allowed_tools",mode,tools}` and others | Section 2.4 | [docs:API-CREATE] |
| `parallel_tool_calls` | boolean, default `true` | | [docs:API-CREATE] |
| `include` | array of strings | e.g. `"reasoning.encrypted_content"` (section 3.6) | [docs:API-CREATE] |
| `reasoning` | `{ effort?, summary?, context?, mode? }` | Section 9 | [docs:API-CREATE] |
| `text` | `{ format?, verbosity? }` | `verbosity`: `low` / `medium` (default) / `high` | [docs:API-CREATE] |
| `prompt_cache_key` | string | Section 6. opencode clamps it to 64 chars [oc:SH:117-124]. Live: accepted but overwritten by the server (section 6) [live] | [docs:API-CREATE] |
| `prompt_cache_options` | `{ mode?, ttl?, prewarm?, comparison_response_id? }` | GPT-5.6+. Not mentioned by SIWC docs. Live: rejected on `gpt-6-luna` with `invalid_parameter` "not supported on this model" [live] | [docs:API-CREATE] |
| `stream_options` | `{ include_obfuscation?: boolean }` | Only with `stream: true`. Adds an `obfuscation` field to delta events; on by default | [docs:API-CREATE] |
| `service_tier` | `auto`, `default`, `flex`, `scale`, `priority`, `fast`, `ultrafast` | A service-tier override can fail with `subscription_sharing_unsupported_capability` [docs:SIWC-ER] | [docs:API-CREATE] |

### 1.4 System / developer instructions: `instructions` versus developer items

- Allowed: top-level `instructions`, or `{role:"developer"}` input messages. `role:"system"` message items are rejected
  [docs:SIWC-PL].
- `instructions` is a single string inserted as a system/developer message [docs:API-CREATE].
- Changing `instructions` changes the prefix and breaks caching and preserved reasoning [docs:G-PREFIX].
- Top-level `instructions` cannot carry an explicit cache breakpoint. To mark reusable developer instructions, put
  them in an `input_text` block inside a developer message [docs:G-CACHE].
- In implicit cache mode (GPT-5.6+), "the last developer message in the initial consecutive group of developer
  messages" is an eligible implicit breakpoint and a cache lookup boundary. Developer messages after that initial
  group are not automatic lookup boundaries [docs:G-CACHE].
- To update instructions mid-conversation, append a new developer message saying older instructions are superseded.
  Do not edit the original [docs:G-PREFIX].

Recommendation, derived from the docs above. Put the stable system prompt in the first `input` item as
`{role:"developer", content:[{type:"input_text", text:...}]}` and never change it. This gives a stable, cacheable prefix
and a natural cache boundary, and it can later take an explicit `prompt_cache_breakpoint` if the flow supports
`prompt_cache_options` (live: rejected on `gpt-6-luna`; section 12). Using `instructions` is also valid if it never changes, but it cannot
carry a breakpoint. Put dynamic content (timestamps, per-user data) after the stable prefix [docs:G-CACHE].

opencode puts the request's system prompt in top-level `instructions` [oc:OR:808-814]. It lowers later system messages
in the conversation to developer-role input items with string content [oc:OR:657-671].

### 1.5 Minimal valid request (from the docs)

```json
{
  "model": "gpt-6.1-sol",
  "input": [{ "role": "user", "content": "Say exactly: Hello, world!" }],
  "store": false,
  "stream": true
}
```

[docs:SIWC-MI]

### 1.6 Full agent-step request (shape assembled from the docs)

```json
{
  "model": "gpt-6.1-sol",
  "store": false,
  "stream": true,
  "input": [
    {
      "role": "developer",
      "content": [{ "type": "input_text", "text": "You are a coding agent. <stable system prompt>" }]
    },
    { "role": "user", "content": [{ "type": "input_text", "text": "List the files in src/" }] }
  ],
  "tools": [
    {
      "type": "function",
      "name": "list_dir",
      "description": "List directory entries.",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"],
        "additionalProperties": false
      },
      "strict": true
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "text": { "verbosity": "medium" },
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<stable opaque per-conversation key>"
}
```

Field shapes come from [docs:API-CREATE] [docs:G-FC] [docs:G-REASON]. `include` is optional (section 3.6).

### 1.7 HTTP headers

- `Authorization: Bearer <ACCESS_TOKEN>` and `Content-Type: application/json` [docs:SIWC-MI].
- opencode also sends `session-id`, `thread-id` and `x-client-request-id` on this flow. Its comment says "ChatGPT
  derives prompt-cache affinity from session-id" [oc:CG:285-288]. The docs do not mention these headers.
  Live: `session-id` is needed for reliable cache hits (without it hits are erratic, see "Verified live" item 19).
  The server uses its value as the echoed `prompt_cache_key`, and a different `session-id` misses a warm prefix.
  Send one stable `session-id` per conversation (section 6) [live].
  `thread-id` and `x-client-request-id` were not probed.
- Live: a `Content-Encoding: zstd` body is accepted [live]. The ~1 MiB uncompressed limit below was not probed.
- opencode compresses request bodies with `zstd` (`content-encoding`) on this flow. Its comment says "ChatGPT sign-in
  rejects uncompressed bodies over ~1 MiB and decodes zstd" [oc:CG:303-304] [oc:SH:456-484]. The docs do not state
  this limit (section 12).
- opencode uses HTTP/SSE transport (`transport: "http"`) and base URL `https://api.openai.com/v1` for this flow
  [oc:CG:300-301]. The docs' Codex app-server config also sets `supports_websockets=false` [docs:SIWC-PL].

---

## 2. Function tools

### 2.1 Shape of one `tools` entry

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Retrieves current weather for the given location.",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City and country e.g. Bogotá, Colombia" },
      "units": { "type": "string", "enum": ["celsius", "fahrenheit"] }
    },
    "required": ["location", "units"],
    "additionalProperties": false
  },
  "strict": true
}
```

[docs:G-FC]

Fields:

- `type` is always `"function"`, `name` is required, `parameters` is a JSON Schema object or null, and `strict` is a
  boolean or null [docs:API-CREATE].
- Optional fields are `description`, `allowed_callers` (`direct` / `programmatic`), `async`, `defer_loading` and
  `output_schema` [docs:API-CREATE]. `defer_loading` belongs with `tool_search`, which this flow does not support
  [docs:SIWC-PL].
- A name inside a namespace matches `^[a-zA-Z0-9_-]+$`, 1 to 128 chars [docs:API-CREATE].
- Tool definitions are injected into the system context and billed as input tokens. OpenAI suggests fewer than 20
  functions at the start of a turn as a soft target [docs:G-FC].

### 2.2 `strict`

- `strict: true` requires `additionalProperties: false` on every object and every property listed in `required`.
  Optional fields are expressed as `"type": ["string", "null"]`. A non-conforming schema with `strict: true` is
  rejected [docs:G-FC].
- If `strict` is omitted, Responses tries to normalize the schema to strict mode and falls back to non-strict when it
  cannot. The echoed tool then shows `strict: false`. Send `strict: false` explicitly to opt out [docs:G-FC].
- opencode always sends `strict: false` [oc:OR:476-483].

### 2.3 Namespaces and `additional_tools`

The SIWC preview limits say: "Group function/custom tools in namespaces or supply them through `additional_tools`
input items" [docs:SIWC-PL]. Live: plain top-level function tools are accepted as well, so this is not a requirement.
Namespace tools are accepted too, and the resulting `function_call` carries `namespace` [live].

Namespace tool shape:

```json
{
  "type": "namespace",
  "name": "fs",
  "description": "Filesystem tools.",
  "tools": [
    { "type": "function", "name": "read_file", "description": "Read a file.",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } },
                      "required": ["path"], "additionalProperties": false } }
  ]
}
```

- `description` and `name` are required, and `tools` holds at least one function or custom tool [docs:API-CREATE]
  [docs:G-FC].
- A `function_call` output item carries an optional `namespace` field naming the namespace [docs:API-EVENTS].
- opencode sends plain top-level `function` tools on this route and wraps only namespaced entries in `namespace`. It
  supplies a fallback namespace description because "OpenAI requires a namespace description" [oc:OAR:202-217].

`additional_tools` input item (append-only tool loading, keeps the prefix stable):

```json
{ "type": "additional_tools", "role": "developer", "tools": [ { "type": "function", "name": "...", "parameters": {} } ] }
```

- Only the `developer` role is supported. Replay the item at its original position [docs:API-CREATE] [docs:G-PREFIX].
- `additional_tools` items do not accept `prompt_cache_breakpoint` [docs:G-CACHE].

### 2.4 `tool_choice` and `parallel_tool_calls`

| Value | Meaning | Source |
| --- | --- | --- |
| `"auto"` (default) | Zero, one or several calls, or a message | [docs:G-FC] |
| `"required"` | Must call one or more tools | [docs:API-CREATE] |
| `"none"` | No tool call. Generates a message | [docs:API-CREATE] |
| `{"type":"function","name":"x"}` | Force that function | [docs:G-FC] |
| `{"type":"custom","name":"x"}` | Force that custom tool | [docs:API-CREATE] |
| `{"type":"allowed_tools","mode":"auto"\|"required","tools":[{"type":"function","name":"x"}]}` | Restrict to a subset | [docs:API-CREATE] |

Forbidding tool calls on a final step: send `"tool_choice": "none"` and keep the same `tools` array. The docs say to
"Set `tool_choice` to `\"none\"` instead of removing the tool definitions", which preserves the cached prefix
[docs:G-CACHE]. Changing `tools` changes the cached prefix [docs:G-CACHE] [docs:G-PREFIX].

`parallel_tool_calls: false` means "exactly zero or one tool is called". Default `true` [docs:G-FC]. Changing it can
change the cached prefix [docs:G-CACHE].

Live: `tool_choice:"none"` with tools present gives a text answer and no call. `parallel_tool_calls` `true` and `false`
are both accepted; `true` produced two sequential calls in one response. `allowed_tools` `mode:"none"` is rejected
[live].

---

## 3. Input items for stateless replay (`store: false`)

### 3.1 Principle

- With `store: false`, preserve every item in each response's `output` array, in original order. Append the next
  items (tool outputs, user message) and resend the complete history [docs:G-STATE] [docs:G-REASON].
- With reasoning models and tool calls, the reasoning items returned alongside the function calls must be passed back
  with the tool outputs [docs:G-FC] [docs:G-REASON].
- Append only. Edits to earlier history (shortening tool results, rewriting developer messages, summarizing) are
  prefix changes. Newer frontier models drop reasoning items that follow a prefix change [docs:G-PREFIX].
- Assistant `phase` values must be preserved on replay. Dropping `phase` can make preambles look like final answers
  [docs:G-REASON] [docs:G-STATE].
- The docs' own stateless example appends `response.output` items wholesale with
  `history.push(...toResponseInputItems(response.output))` (JS) or `history += response.output` (Python)
  [docs:G-STATE].

### 3.2 User message

```json
{ "type": "message", "role": "user", "content": [ { "type": "input_text", "text": "Fix the failing test." } ] }
```

- `content` can also be a plain string, and `type: "message"` is optional on this "EasyInputMessage" shape
  [docs:API-CREATE].
- Allowed roles on input messages are `user`, `assistant`, `system`, `developer` in general. `system` is rejected on
  this flow [docs:API-CREATE] [docs:SIWC-PL].
- opencode sends `type:"message"`, `role:"user"` and a content array of `input_text` / `input_image` / `input_file`
  [oc:OR:674-678].

### 3.3 Assistant message (`output_text`)

Replay the `message` output item exactly as received in `response.output_item.done`:

```json
{
  "type": "message",
  "id": "msg_123",
  "role": "assistant",
  "status": "completed",
  "phase": "commentary",
  "content": [ { "type": "output_text", "text": "I'll run the tests first.", "annotations": [] } ]
}
```

- An output message has `id`, `type:"message"`, `role:"assistant"`, `status` (`in_progress` / `completed` /
  `incomplete`), `content` (an array of `output_text` `{type,text,annotations,logprobs}` or `refusal`
  `{type,refusal}`) and an optional `phase` (`commentary` / `final_answer` / null) [docs:API-EVENTS] [docs:API-CREATE].
- `phase` labels intermediate commentary versus the final answer. "preserve and resend phase on all assistant
  messages" [docs:API-CREATE].
- opencode replays assistant text as `{type:"message", id?, role:"assistant", status:"completed",
  content:[{type:"output_text", text}], phase?}`. It keeps the `id` only when one was received, and always sets status
  `completed` ("Replayed text is a finished input item, even if generation was cut short") [oc:OR:699-708]. It strips
  `annotations` and `logprobs` from replayed content [oc:OR:69-72] [oc:OR:706].

### 3.4 `function_call` (model's tool call, echoed back)

```json
{
  "type": "function_call",
  "id": "fc_1234xyz",
  "call_id": "call_1234xyz",
  "name": "get_weather",
  "arguments": "{\"location\":\"Paris, France\"}",
  "status": "completed"
}
```

- `arguments` (a JSON string), `call_id`, `name` and `type` are required. `id`, `namespace`, `status`, `async` and
  `caller` are optional [docs:API-CREATE].
- `call_id` links the call to its output [docs:G-FC].
- opencode replays `{type:"function_call", id?, call_id, name, namespace?, arguments}`. It drops `id` unless it holds a
  well-formed server id, and drops `status` [oc:OR:537-561] [oc:OR:527-534].
- Live: `{type, call_id, name, arguments}` is enough. Without `id` and `status`, and also with an invented `id`, the
  request completes [live].

### 3.5 `function_call_output` (your tool result)

```json
{ "type": "function_call_output", "call_id": "call_1234xyz", "output": "{\"temperature_c\": 14}" }
```

- `output` is a string (max 10,485,760 chars) or an array of `input_text` / `input_image` / `input_file` content for
  tools returning images or files [docs:API-CREATE] [docs:G-FC].
- Return a string even for void functions, e.g. `"success"` [docs:G-FC].
- Optional fields: `id`, `name`, `namespace`, `status`, `caller` [docs:API-CREATE].
- opencode always sends `{type, call_id, output}` [oc:OR:796-802]. It sends text/json/error results as a plain string
  and media results as a content array [oc:OR:629-640].
- Live: without `call_id` the request fails with 400 "A function call output without a call_id requires a name."
  Always send `call_id` [live].

Array form:

```json
{ "type": "function_call_output", "call_id": "call_9", "output": [
  { "type": "input_text", "text": "Screenshot attached" },
  { "type": "input_image", "image_url": "data:image/png;base64,iVBOR...", "detail": "auto" } ] }
```

[docs:API-CREATE]

### 3.6 Reasoning items and `include: ["reasoning.encrypted_content"]`

Reasoning output item:

```json
{
  "type": "reasoning",
  "id": "rs_6806bfca0b2481918a5748308061a260",
  "summary": [ { "type": "summary_text", "text": "**Planning the fix**\n\n..." } ],
  "encrypted_content": "gAAAAAB...",
  "status": "completed"
}
```

Corrected (live): the observed item has no `status`. Its keys are `type, id, summary, content, encrypted_content`, with
`content: []` [live].

- Fields: `id` (string), `summary` (array of `{type:"summary_text", text}`), `type:"reasoning"`, and optional
  `content` (array of `{type:"reasoning_text", text}`), `encrypted_content` and `status` [docs:API-CREATE]
  [docs:API-EVENTS].
- Echo it back verbatim, taken from `response.output_item.done`, not `response.output_item.added`. "The
  `encrypted_content` in `response.output_item.added` may be incomplete. This is especially important when `store` is
  `false`" [docs:API-EVENTS] [docs:API-CREATE].
- Is `include` required? The current docs say no. "In stateless mode, reasoning items in the response's `output`
  array include an `encrypted_content` property by default. Stateless mode applies when `store` is `false`... The API
  still accepts the legacy `reasoning.encrypted_content` value in `include` for compatibility, but doesn't require it"
  [docs:G-REASON]. The `include` parameter reference still describes it as what "enables reasoning items to be used in
  multi-turn conversations when using the Responses API statelessly" [docs:API-CREATE]. Sending it is harmless and
  accepted [docs:G-REASON]. Live: confirmed. `encrypted_content` comes back without `include`, and with it [live].
- Live: replaying the reasoning item is optional. Keeping it, dropping it while keeping the function call, or dropping
  only its `id` all complete. A corrupted `encrypted_content` fails with 400 `invalid_encrypted_content`, so a client
  that edits or truncates reasoning blobs breaks the request [live].
- opencode sends `store: false, include: ["reasoning.encrypted_content"]` as route defaults [oc:OAR:363]. It replays
  reasoning as `{type:"reasoning", id?, summary:[...], encrypted_content}`. It skips the item when there is neither
  summary text nor encrypted content, and it does not replay `content` [oc:OR:563-578]. It merges multiple streamed
  summary parts of one item into a single item [oc:OR:726-739].
- Cross-turn reasoning: `reasoning.context` takes `auto` / `current_turn` / `all_turns`. GPT-5.6 family defaults to
  `all_turns`; earlier models default to `current_turn`. `all_turns` with `store:false` only works if you replay the
  complete history. Reasoning only carries within the same model family; on a family switch the API omits
  incompatible reasoning [docs:G-REASON].

### 3.7 Item `id` fields under `store: false`

- In the input schemas, `id` is required on `reasoning` items and optional on `function_call`, `function_call_output`
  and EasyInputMessage-style messages [docs:API-CREATE].
- The docs' stateless examples replay full output items, which carry their ids [docs:G-STATE].
- ~~No document says whether ids must, may or must not be sent with `store: false`.~~ Live: ids are optional on
  `function_call` and `reasoning` items and are not checked against server state [live].
- opencode sends ids when it has them and omits them otherwise. Its reasoning item `id` is optional
  [oc:OR:93-98] [oc:OR:572-576] [oc:OR:553-560].

Safest documented behaviour: replay items exactly as received, ids included.

### 3.8 Other input items you may see or send

- `configuration_update` `{type, reasoning?:{effort}, text?:{format}}` changes effort or format mid-conversation
  without rewriting the prefix (GPT-6+) [docs:G-REASON] [docs:G-CACHE]. Constraints: put it before the next user
  message, don't combine it with automatic compaction or truncation, and replay it at its original position
  [docs:G-REASON]. opencode disables this on the ChatGPT flow [oc:CG:322], and its comment says consecutive updates
  are rejected [oc:OR:660-662]. Live: a single `configuration_update` item is rejected with
  `subscription_sharing_unsupported_capability` (`param: "input"`) [live].
- `compaction` `{type, id?, encrypted_content}` is returned by OpenAI compaction [docs:API-CREATE]. opencode says
  native compaction is unsupported on this flow and uses its own summary compaction [oc:CG:302] [oc:CG:323-324].
- `custom_tool_call` / `custom_tool_call_output` are freeform custom tools. They use the same `call_id` linkage and
  `input` (string) instead of `arguments` [docs:API-CREATE].

### 3.9 Worked multi-step replay (step 2 request body)

After step 1 streamed a reasoning item, a commentary message and one function call:

```json
{
  "model": "gpt-6.1-sol",
  "store": false,
  "stream": true,
  "tools": [ "<identical to step 1>" ],
  "tool_choice": "auto",
  "reasoning": { "effort": "medium", "summary": "auto" },
  "input": [
    { "role": "developer", "content": [ { "type": "input_text", "text": "<identical system prompt>" } ] },
    { "role": "user", "content": [ { "type": "input_text", "text": "List the files in src/" } ] },
    { "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAAA..." },
    { "type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "phase": "commentary",
      "content": [ { "type": "output_text", "text": "Listing src/.", "annotations": [] } ] },
    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "list_dir",
      "arguments": "{\"path\":\"src\"}", "status": "completed" },
    { "type": "function_call_output", "call_id": "call_1", "output": "index.ts\nutil.ts" }
  ]
}
```

Rules applied: items replayed in original order, reasoning passed back with the tool output, prefix unchanged
[docs:G-STATE] [docs:G-REASON] [docs:G-PREFIX].

---

## 4. Streaming events

### 4.1 Framing

- Server-sent events. Each event's JSON has a `type` and an integer `sequence_number` [docs:API-EVENTS] [docs:G-STREAM].
- Dispatch on the JSON `type`. opencode reads only each SSE event's `data:` payload, drops empty events, keepalives
  and a `[DONE]` sentinel, and decodes the JSON [oc:FR:9-14] [oc:FR:28-62]. Live: every frame has an `event:` line
  matching the JSON `type`, no `[DONE]` is sent, and `: keep-alive` comment lines occur [live].
- Live: an undocumented `response.metadata` event (`{type, sequence_number, response_id, metadata}`) arrives once per
  stream, sometimes in the middle of a message item. Ignore it [live].
- Delta events may carry an extra `obfuscation` string field unless `stream_options.include_obfuscation: false`.
  Ignore it [docs:API-CREATE].

### 4.2 Lifecycle and ordering

```
response.created                       (once; response.status "in_progress", output [], usage null)
response.in_progress                   (once)
  for each output item, by output_index:
    response.output_item.added         (item with partial fields)
      ... item-specific events ...
    response.output_item.done          (final item: replay THIS one)
response.completed | response.incomplete | response.failed     (terminal)
error                                  (can occur instead of the above)
```

- `response.created`, `response.output_text.delta`, `response.completed` and `error` are the documented core events
  [docs:G-STREAM].
- The complete function-call sequence is documented [docs:G-FC]:
  `output_item.added` (function_call, `arguments:""`) → `function_call_arguments.delta`* →
  `function_call_arguments.done` → `output_item.done`.
- ~~The nesting order of content-part and reasoning-summary events within an item is inferred from the event
  schemas, not stated.~~ Live order: message is `output_item.added` → `content_part.added` → `output_text.delta`* →
  `output_text.done` → `content_part.done` → `output_item.done`. Reasoning is `output_item.added` →
  `reasoning_summary_part.added` → `reasoning_summary_text.delta`* → `reasoning_summary_text.done` →
  `reasoning_summary_part.done` → `output_item.done` [live].
- Corrected (live): `function_call_arguments.delta` is not guaranteed. In a parallel-call response both calls went
  straight from `output_item.added` to `function_call_arguments.done` [live].
- `response.queued` also exists (status `queued`) [docs:API-EVENTS]. Treat it as non-terminal.

### 4.3 Event payloads

Response-level events. Each carries the full Response object in `response`:

```json
{ "type": "response.created", "sequence_number": 1,
  "response": { "id": "resp_67cc...", "object": "response", "created_at": 1741487325, "status": "in_progress",
                "error": null, "incomplete_details": null, "model": "gpt-6-astra", "output": [], "usage": null,
                "store": false, "tool_choice": "auto", "tools": [], "parallel_tool_calls": true } }
```

`response.in_progress` has the same shape [docs:API-EVENTS].

Item events:

```json
{ "type": "response.output_item.added", "output_index": 0, "sequence_number": 2,
  "item": { "id": "msg_123", "status": "in_progress", "type": "message", "role": "assistant", "content": [] } }
```

```json
{ "type": "response.output_item.done", "output_index": 0, "sequence_number": 9,
  "item": { "id": "msg_123", "status": "completed", "type": "message", "role": "assistant",
            "content": [ { "type": "output_text", "text": "Done.", "annotations": [] } ] } }
```

[docs:API-EVENTS]. `item` is any output item type: `message`, `function_call`, `reasoning`, `custom_tool_call`,
`web_search_call` and others [docs:API-EVENTS].

Content parts. These belong to message items; `part` is `output_text`, `refusal` or `reasoning_text`:

```json
{ "type": "response.content_part.added", "item_id": "msg_123", "output_index": 0, "content_index": 0,
  "part": { "type": "output_text", "text": "", "annotations": [] }, "sequence_number": 3 }
{ "type": "response.content_part.done",  "item_id": "msg_123", "output_index": 0, "content_index": 0,
  "part": { "type": "output_text", "text": "Done.", "annotations": [] }, "sequence_number": 8 }
```

[docs:API-EVENTS]

Text:

```json
{ "type": "response.output_text.delta", "item_id": "msg_123", "output_index": 0, "content_index": 0, "delta": "In", "sequence_number": 4 }
{ "type": "response.output_text.done",  "item_id": "msg_123", "output_index": 0, "content_index": 0, "text": "In a ...", "sequence_number": 7 }
```

[docs:API-EVENTS]. `response.output_text.annotation.added` also exists [docs:API-EVENTS].

Refusal. A refusal is a content part of a `message` item:

```json
{ "type": "response.refusal.delta", "item_id": "msg_123", "output_index": 0, "content_index": 0, "delta": "refusal text so far", "sequence_number": 1 }
{ "type": "response.refusal.done",  "item_id": "item-abc", "output_index": 1, "content_index": 2, "refusal": "final refusal text", "sequence_number": 1 }
```

[docs:API-EVENTS]. opencode routes refusal deltas and dones into the same text stream as output text [oc:OR:1494-1503].

Function-call arguments. These carry no `content_index`:

```json
{ "type": "response.output_item.added", "output_index": 0,
  "item": { "type": "function_call", "id": "fc_1234xyz", "call_id": "call_1234xyz", "name": "get_weather", "arguments": "" } }
{ "type": "response.function_call_arguments.delta", "item_id": "fc_1234xyz", "output_index": 0, "delta": "{\"" }
{ "type": "response.function_call_arguments.done",  "item_id": "fc_1234xyz", "output_index": 0,
  "arguments": "{\"location\":\"Paris, France\"}" }
{ "type": "response.output_item.done", "output_index": 0,
  "item": { "type": "function_call", "id": "fc_1234xyz", "call_id": "call_1234xyz", "name": "get_weather",
            "arguments": "{\"location\":\"Paris, France\"}" } }
```

[docs:G-FC] [docs:API-EVENTS]

- Deltas are keyed by `item_id`, the item `id` (`fc_...`). This is not `call_id`. Use `call_id` from the item for
  `function_call_output` [docs:G-FC].
- Accumulate `delta`s per item. `function_call_arguments.done.arguments` is authoritative [docs:API-EVENTS].
- The docs' function-call example also shows a `response_id` field on these events [docs:G-FC]. The schema reference
  does not list it [docs:API-EVENTS]. Do not depend on it. Live: absent on function-call events [live].
- opencode keys parser state by `output_index`, adopting the id first seen at that slot because some gateways change
  ids between events [oc:OR:1007-1039]. On `response.completed`, it also finalizes tool calls whose
  `output_item.done` never arrived [oc:OR:1419-1428].

Custom tool input:

```json
{ "type": "response.custom_tool_call_input.delta", "item_id": "ctc_123", "output_index": 0, "delta": "partial input text", "sequence_number": 1 }
{ "type": "response.custom_tool_call_input.done",  "item_id": "ctc_123", "output_index": 0, "input": "final complete input text", "sequence_number": 2 }
```

[docs:API-EVENTS]

Reasoning summary. Summary parts are indexed by `summary_index`:

```json
{ "type": "response.reasoning_summary_part.added", "item_id": "rs_68...", "output_index": 0, "summary_index": 0,
  "part": { "type": "summary_text", "text": "" }, "sequence_number": 1 }
{ "type": "response.reasoning_summary_text.delta", "item_id": "rs_68...", "output_index": 0, "summary_index": 0,
  "delta": "**Responding to a greeting**...", "sequence_number": 2 }
{ "type": "response.reasoning_summary_text.done",  "item_id": "rs_68...", "output_index": 0, "summary_index": 0,
  "text": "**Responding to a greeting**...", "sequence_number": 3 }
{ "type": "response.reasoning_summary_part.done",  "item_id": "rs_68...", "output_index": 0, "summary_index": 0,
  "part": { "type": "summary_text", "text": "..." }, "sequence_number": 4 }
```

[docs:API-EVENTS]. `reasoning_summary_part.done` may carry `status: "incomplete"` [docs:API-EVENTS].

Reasoning text. This is raw reasoning content, keyed by `content_index`:

```json
{ "type": "response.reasoning_text.delta", "item_id": "rs_123", "output_index": 0, "content_index": 0, "delta": "The", "sequence_number": 1 }
{ "type": "response.reasoning_text.done",  "item_id": "rs_123", "output_index": 0, "content_index": 0, "text": "The user is asking...", "sequence_number": 4 }
```

[docs:API-EVENTS]. The API does not return raw reasoning text for persisted reasoning ("The reasoning items remain
opaque") [docs:G-REASON]. Expect summaries, not reasoning text, unless a model emits it. opencode also handles a
non-documented `response.reasoning.delta` / `.done` alias [oc:OR:1504-1515] [oc:OAR:330-335].

### 4.4 Terminal events

`response.completed`:

```json
{ "type": "response.completed", "sequence_number": 42,
  "response": { "id": "resp_123", "status": "completed", "completed_at": 1740855870, "error": null,
    "incomplete_details": null, "output": [ { "id": "msg_123", "type": "message", "role": "assistant",
      "status": "completed", "content": [ { "type": "output_text", "text": "...", "annotations": [] } ] } ],
    "usage": { "input_tokens": 0, "input_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 },
               "output_tokens": 0, "output_tokens_details": { "reasoning_tokens": 0 }, "total_tokens": 0 } } }
```

[docs:API-EVENTS]

`response.incomplete`:

```json
{ "type": "response.incomplete",
  "response": { "id": "resp_123", "status": "incomplete", "error": null,
                "incomplete_details": { "reason": "max_output_tokens" }, "output": [], "usage": null } }
```

[docs:API-EVENTS]

`response.failed`:

```json
{ "type": "response.failed",
  "response": { "id": "resp_123", "status": "failed",
                "error": { "code": "server_error", "message": "The model failed to generate a response." },
                "output": [], "usage": null } }
```

[docs:API-EVENTS]. The docs' sample client reads `event.response.error.code` [docs:SIWC-MI].

`error`:

```json
{ "type": "error", "code": "ERR_SOMETHING", "message": "Something went wrong", "param": null, "sequence_number": 1 }
```

`code` is string or null and `param` is string or null [docs:API-EVENTS].

### 4.5 Usage: where and field names

- `usage` is null on `response.created` [docs:API-EVENTS]. The final usage is on the terminal event's
  `response.usage`, shown on `response.completed` [docs:API-EVENTS].
- Field names:
  - `usage.input_tokens`: all input, including cached [docs:API-EVENTS].
  - `usage.input_tokens_details.cached_tokens`: tokens read from cache. Excludes tokens charged as writes
    [docs:API-EVENTS] [docs:G-CACHE].
  - `usage.input_tokens_details.cache_write_tokens`: tokens written to cache [docs:API-EVENTS].
  - `usage.input_tokens_details.cache_write_tokens_details.{ttl_30m_tokens, ttl_12h_tokens}`: these sum to
    `cache_write_tokens` [docs:G-CACHE].
  - `usage.output_tokens`: includes reasoning [docs:API-EVENTS] [docs:G-REASON].
  - `usage.output_tokens_details.reasoning_tokens` [docs:API-EVENTS].
  - `usage.total_tokens` [docs:API-EVENTS].
- Uncached input = `input_tokens - cached_tokens - cache_write_tokens` [docs:G-CACHE].
- Live: `cache_write_tokens` was always 0, `cache_write_tokens_details` never appeared, and usage also carries an
  undocumented `attribution` object: `items` maps each input and output item id to `{input_tokens, cached_tokens,
  cache_write_tokens, output_tokens, content?}`, and `request_fields.tools` counts the tool definitions. Server-assigned
  ids appear for input items sent without ids [live].
- opencode reads usage from `response.completed` and `response.incomplete`. It treats every count as optional and
  lenient [oc:OR:337-356] [oc:OR:893-913] [oc:OR:1438].
- Plan usage is not billed per token to the app. opencode zeroes model cost on this flow [oc:CG:333]. Users see usage
  at ChatGPT Settings → Usage [docs:SIWC-AS].

---

## 5. How a response ends

### 5.1 `response.status`

`completed`, `failed`, `in_progress`, `cancelled`, `queued`, `incomplete` [docs:API-EVENTS].

Item-level `status`: `in_progress`, `completed`, `incomplete` [docs:API-EVENTS].

### 5.2 `incomplete_details.reason`

| Reason | Meaning | Source |
| --- | --- | --- |
| `max_output_tokens` | Output limit or context window reached. Can happen before any visible text, with reasoning tokens still billed | [docs:API-EVENTS] [docs:G-REASON] |
| `content_filter` | Content filtered | [docs:API-EVENTS] |
| `max_messages` | Listed, not described | [docs:API-EVENTS] |
| `steered` | WebSocket steering only. Not applicable to HTTP | [docs:API-EVENTS] |

`max_output_tokens` is a rejected request field on this flow [docs:SIWC-PL]. The `max_output_tokens` reason can still
occur when generation reaches the context window limit [docs:G-REASON].

### 5.3 Finish classification for the agent loop

- A step succeeded only on `response.completed` [docs:SIWC-MI].
- If any `function_call` items were completed, run the tools and continue. Otherwise the step is a final answer.
  Agent-loop rule; opencode maps the finish reason this way [oc:OR:946-956].
- opencode's mapping: no reason plus function calls gives `tool-calls`; `response.incomplete` with no reason gives
  `unknown`; `max_output_tokens` gives `length`; `content_filter` gives `content-filter` [oc:OR:946-956].

### 5.4 Detecting a stream that died without a terminal event

- Terminal events are `response.completed`, `response.incomplete`, `response.failed`, plus `error`
  [docs:SIWC-MI] [docs:API-EVENTS]. opencode treats exactly these four as terminal [oc:OR:968-972].
- If the HTTP body ends (EOF, reset, abort) before a terminal event, treat the step as failed. The docs' Python sample
  raises "Stream ended without response.completed." when `completed` was never set [docs:SIWC-MI].
- opencode fails with "The provider response ended unexpectedly." (classification `incomplete-stream`) when the
  stream ends with no finish event. It also fails on any non-raw event that arrives after the terminal event
  [oc:RC:307-330].
- Because history is client-held, retrying means resending the same request. Discard partial output from the dead
  attempt and never replay partial items. Do not execute a tool call whose `output_item.done` never arrived. The
  `encrypted_content` from `output_item.added` may be incomplete [docs:API-EVENTS].
- Neither source documents an idle or keepalive timeout (section 12). Live: `: keep-alive` SSE comment lines occur
  [live].

---

## 6. Prompt caching

- Caching is automatic and on by default for supported models. It reuses an exact rendered prefix: hidden OpenAI
  instructions, developer messages, tool definitions and history [docs:G-CACHE].
- Minimum cacheable prefix: 1,024 visible input tokens for GPT-5.6 and later. For earlier models it varies with
  request settings (tools, images, schemas, effort, verbosity) [docs:G-CACHE].
- Implicit breakpoints (GPT-5.6+) sit at the end of the latest eligible message: user messages, the last tool response
  in a consecutive group, and the last developer message in the initial developer group [docs:G-CACHE]. For GPT-5.5 /
  5.5 Pro they are spaced every 2,048 tokens [docs:G-CACHE].
- Reported `cached_tokens`: exact eligible boundary on 5.6+. Rounded down to a multiple of 128 on earlier models
  [docs:G-CACHE].
- Cache lifetime: on 5.6+, at least 30 minutes by default, or 12 hours via `prompt_cache_options.ttl`. On 5.5 it is
  about 30 minutes, up to 24 hours [docs:G-CACHE].

Live, on this flow (overrides the general-API claims below) [live]:

- Caching is reliable only with a stable `session-id` request header. The server overwrites `prompt_cache_key` with
  the `session-id` value, or with a fresh random UUID when the header is absent. Without the header a hit is possible
  but erratic (see "Verified live" item 19).
- The cache is scoped to the `session-id`. A warm prefix under a different `session-id` cached 0 tokens.
- With a stable `session-id`, a repeat cached 3,072 of about 3,260 tokens. Changing only the last user message kept
  the 3,072. Changing one tool description dropped it to 0, so tools render before the developer prefix.
- `cached_tokens` was 3,072 every time, not the exact message boundary (about 3,250). Granularity is unknown.
- A hit 2 seconds after the cold request is not guaranteed: two re-runs missed at 2 s and hit on the next request.
  At 10 s the second request hit.

`prompt_cache_key`:

- Not on the SIWC rejected list [docs:SIWC-PL]. Corrected (live): accepted but overwritten, see above.
- Before GPT-5.6, a stable key per shared prefix improves cache routing. Aim for about 15 requests per minute per key
  [docs:G-CACHE].
- On 5.6+, routing is automatic and the key only separates cache accounting [docs:G-CACHE].
- Use an opaque value with no PII. opencode clamps the key to 64 chars and says "OpenAI limits `prompt_cache_key` to 64
  chars" [oc:SH:117-124].

`prompt_cache_retention`: rejected on this flow [docs:SIWC-PL]. In the general API it is deprecated in favour of
`prompt_cache_options.ttl` [docs:API-EVENTS]. opencode's generic lowering can emit `prompt_cache_retention: "24h"` when
a 24h TTL is configured [oc:CACHE:37-44] [oc:OAR:251]. A client for this flow must never send it.

`prompt_cache_options` / `prompt_cache_breakpoint`: documented for GPT-5.6+ in the general API [docs:API-CREATE]
[docs:G-CACHE]. The SIWC docs neither list nor reject them (section 12).

What breaks the cached prefix [docs:G-CACHE] [docs:G-PREFIX]:

- A different `model`.
- Any change to `tools`: names, descriptions, schemas or order.
- A change to `parallel_tool_calls`, `text.format`, `reasoning.effort` or `text.verbosity`.
- A change to `instructions`.
- Editing, truncating or summarizing earlier `input` items, or shrinking past tool outputs or images.
- Compaction or `context_management`.
- Extending an existing message instead of appending a new one.
- Dynamic content (timestamps, user data) placed early in the prompt.

`prompt_cache_diagnostics.reason` values name these causes: `model_changed`, `prompt_cache_key_changed`,
`tools_changed`, `text_format_changed`, `reasoning_effort_changed`, `verbosity_changed`, `context_compacted`,
`input_changed`, `service_tier_changed` [docs:API-EVENTS].

Cache-preserving alternatives [docs:G-CACHE]:

- Use `tool_choice: "none"` or `allowed_tools` instead of removing tools.
- Use an `additional_tools` item to add tools.
- Use a `configuration_update` item to change effort.

Cached tokens still count toward TPM rate limits [docs:G-CACHE].

opencode sends `session-id` on this flow for cache affinity [oc:CG:285-288]; not documented. Live: confirmed and
required (see the top of this section) [live].

---

## 7. Errors

### 7.1 Before the stream opens (non-2xx HTTP)

- Direct-route admission can return `{"detail":"..."}` instead of the standard `error` object. Treat `detail` as
  diagnostic text, not a machine code [docs:SIWC-ER].
- Responses-layer errors carry an `error` object. Use its exact `error.code` and `error.param` [docs:SIWC-ER]. The
  general API also uses `error.type` (e.g. `rate_limit_error`, `service_unavailable_error`, `insufficient_quota`)
  [docs:G-ERR] [docs:G-RL]. Body shape:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": "tools[0]", "code": "subscription_sharing_unsupported_capability" } }
```

  The field names come from [docs:SIWC-ER] [docs:G-ERR]. The `{"error":{...}}` wrapper also matches opencode's
  primary decode layout [oc:PE:168-186]. opencode also decodes `{"detail": "..."}` [oc:PE:179].
- Preserve the HTTP status, body shape, error code and request ID [docs:SIWC-ER]. The general API exposes the request
  ID as the `x-request-id` response header [docs:G-RL]. Corrected (live): this flow sends `x-oai-request-id`
  (`req_…`) and no `x-request-id` [live].
- Live pre-stream bodies [live]:
  - `{"detail":"Unsupported parameter: temperature"}` (HTTP 400) for any rejected or unknown top-level field, and
    `{"detail":"System messages are not allowed"}` for a system message. No code.
  - `{"error":{"message","type":"invalid_request_error","param","code"}}` where `code` can be a string
    (`subscription_sharing_unsupported_capability`, `invalid_encrypted_content`, `invalid_parameter`) or `null`.
  - One such 400 had no `content-type` header. Parse the body as JSON regardless.

Direct-admission statuses [docs:SIWC-ER]:

| Status | Meaning / action |
| --- | --- |
| 401 | Signed identity or direct permission not accepted. Check the account and the granted scopes (`chatgpt.tokens.use.direct`) |
| 403 | Policy or permission check (e.g. serving region). Surface the restriction |
| 503 | Direct routing unavailable or not enabled. Preserve credentials; bounded backoff |

### 7.2 After the stream opens

- The failure arrives as `response.failed` with `response.error.{code,message}` or as an `error` event with
  `{code,message,param}` [docs:API-EVENTS].
- `subscription_sharing_usage_limit_exceeded` and `subscription_sharing_usage_unavailable` can arrive as
  `response.failed` after streaming began [docs:SIWC-MI].
- `response.error.code` enum (general API): `server_error`, `rate_limit_exceeded`, `invalid_prompt`,
  `data_residency_mismatch`, `bio_policy`, `misalignment_policy_violation`, `vector_store_timeout`, `invalid_image`,
  `invalid_image_format`, `invalid_base64_image`, `invalid_image_url`, `image_too_large`, `image_too_small`,
  `image_parse_error`, `image_content_policy_violation`, `invalid_image_mode`, `image_file_too_large`,
  `unsupported_image_media_type`, `empty_image_file`, `failed_to_download_image`, `image_file_not_found`. Optional
  `param`, `type` and `misalignment` fields also appear [docs:API-EVENTS].
- opencode reads code and message from the top level, then `error`, then `response.error`, and formats them as
  `code: message`. An `error` frame with no recognizable fields becomes provider-internal [oc:OR:1450-1481].

### 7.3 Sharing-specific codes [docs:SIWC-ER]

| `error.code` | HTTP | Action |
| --- | --- | --- |
| `subscription_sharing_user_not_eligible` | 403 | Explain; do not repeat or loop OAuth |
| `subscription_sharing_usage_limit_exceeded` | 429 | Pause plan requests; link https://chatgpt.com/settings/usage; do not infer a reset time; may be an app-specific limit |
| `subscription_sharing_usage_unavailable` | 503 | Retry later with bounded backoff |
| `subscription_sharing_unsupported_capability` | 400 | Read `error.param`, remove the field, tool, model or service tier; do not resend the same body |
| `subscription_sharing_route_not_supported` | 403 | Wrong method or endpoint; use `POST /v1/responses` |
| `subscription_sharing_invalid_user` | 401 | Diagnose the credential; re-sign-in after confirmed revocation or a terminal refresh error |
| `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context` | 403 | Fix client or grant config; do not retry or switch billing |
| `subscription_sharing_user_unavailable` | 503 | Retry with bounded backoff |

The docs say this list is not exhaustive [docs:SIWC-ER]. opencode additionally treats
`subscription_sharing_workplace_individual_usage_limit_exceeded` as non-retryable [oc:CG:53-62]. Its non-retry list
covers usage_limit_exceeded, workplace_individual_usage_limit_exceeded, user_not_eligible, unsupported_capability,
route_not_supported, invalid_user and both chatpass codes, matched as substrings of the response body [oc:CG:268-276].

On disconnection, OpenAI does not notify the app when a user disconnects it. When a request or refresh confirms the
disconnection, stop using the tokens and ask the user to sign in again. Do not erase credentials on temporary network
failures [docs:SIWC-ER].

Refresh errors [docs:SIWC-ER]:

- `invalid_grant` on refresh, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`,
  `refresh_token_invalidated` or `refresh_token_reused` mean the refresh token is unusable. Clear the tokens and redo
  OAuth with the saved client ID.
- `invalid_client` means the client configuration is wrong.

### 7.4 Rate limits and Retry-After

- `Retry-After` (seconds) may be present on 429 temporary rate limits and 503 overloads. Treat it as a minimum and add
  jitter. Without it, use exponential backoff with jitter. Cap both the number of attempts and total time
  [docs:G-RL] [docs:G-ERR].
- `Retry-After` does not mean that quota or billing errors are retryable [docs:G-RL].
- Headers (general API): `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`,
  `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests` (e.g. `1s`), `x-ratelimit-reset-tokens` (e.g.
  `6m0s`), and the project-token variants [docs:G-RL]. The SIWC docs do not say whether these appear on this flow.
  Live: none of them, and no `retry-after`, appeared on 200 or 400 responses. 429s were not probed [live].
- General codes: `429 rate_limit_error / slow_down` (traffic ramped too fast; can happen under limits) and
  `503 service_unavailable_error / server_is_overloaded` [docs:G-RL] [docs:G-ERR].
- opencode parses `retry-after-ms` first, then `retry-after` as seconds or an HTTP-date [oc:EX:22-35]. It also parses
  `x-ratelimit-{limit,remaining,reset}-*` [oc:EX:47-53].
- Disable automatic SDK retries if you own retries. The docs' sample uses `max_retries=0` [docs:SIWC-MI].

### 7.5 Context-length overflow

- With truncation disabled (the default; `truncation` is a rejected field here), input beyond the context window
  "will fail with a 400 error" [docs:API-EVENTS] [docs:SIWC-PL].
- The exact error code and message are not documented in the sources read (section 12).
- opencode classifies a 4xx (or status-less) failure as `context-overflow` if a code is `context_length_exceeded`,
  `model_context_window_exceeded` or `request_too_large`, or if the message matches overflow phrases such as
  "exceeds the context window" or "maximum context length is N tokens". 429s are excluded [oc:PE:16-58]
  [oc:PE:225-234].
- HTTP 413 or "payload too large" text is classed separately as `payload-too-large` [oc:PE:235-236]. That is relevant
  given the about 1 MiB uncompressed body limit noted in section 1.7.

### 7.6 Classification table

| Signal | Class | Retry? | Source |
| --- | --- | --- | --- |
| HTTP 429 `rate_limit_exceeded` / `slow_down`, or `response.error.code: rate_limit_exceeded` | rate_limit | Yes, honor Retry-After | [docs:G-RL] [docs:API-EVENTS] |
| HTTP 500, `server_error` (HTTP or `response.failed`) | provider_internal | Yes, backoff | [docs:G-ERR] [docs:API-EVENTS] |
| HTTP 503 `server_is_overloaded` | provider_internal | Yes, honor Retry-After | [docs:G-RL] |
| HTTP 503 direct admission `{"detail"}` | provider_internal | Yes, bounded backoff | [docs:SIWC-ER] |
| `subscription_sharing_usage_unavailable` (503) | provider_internal | Yes, bounded backoff | [docs:SIWC-ER] |
| `subscription_sharing_user_unavailable` (503) | provider_internal | Yes, bounded backoff | [docs:SIWC-ER] |
| Network error / TLS / connection reset before a response | transport | Yes (stateless resend) | [oc:PE:83-87] (docs silent) |
| Stream EOF without terminal event | incomplete_stream | Yes, resend the whole step and discard the partial | [docs:SIWC-MI] [oc:RC:307-330] |
| HTTP 401 direct admission, `subscription_sharing_invalid_user` (401) | auth | No (refresh once if the access token expired, else re-sign-in) | [docs:SIWC-ER] [docs:SIWC-TR] |
| HTTP 403 direct admission (region/policy) | auth | No | [docs:SIWC-ER] |
| `subscription_sharing_user_not_eligible` (403) | auth | No | [docs:SIWC-ER] |
| `chatpass_v2_scope_not_authorized` / `chatpass_v2_invalid_authorization_context` (403) | auth | No | [docs:SIWC-ER] |
| Terminal refresh errors (`invalid_grant`, `refresh_token_*`) | auth | No, redo OAuth | [docs:SIWC-ER] |
| `subscription_sharing_usage_limit_exceeded` (429) | usage_limit | No, pause and link to usage settings | [docs:SIWC-ER] |
| `subscription_sharing_workplace_individual_usage_limit_exceeded` | usage_limit | No | [oc:CG:55] |
| `incomplete_details.reason: content_filter` | content_policy | No | [docs:API-EVENTS] |
| `invalid_prompt`, `bio_policy`, `misalignment_policy_violation`, `image_content_policy_violation` | content_policy | No | [docs:API-EVENTS] |
| `subscription_sharing_unsupported_capability` (400) | invalid_request | No, fix the body | [docs:SIWC-ER] |
| `subscription_sharing_route_not_supported` (403) | invalid_request | No, fix the route | [docs:SIWC-ER] |
| HTTP 400 `{"detail":"Unsupported parameter: …"}` or `{"detail":"System messages are not allowed"}` | invalid_request | No, fix the body | [live] |
| HTTP 400 `invalid_encrypted_content` | invalid_request | No; replay reasoning blobs byte-for-byte or drop the item | [live] |
| HTTP 400 `invalid_request_error`; image codes (`invalid_image*`, `image_too_large`, ...) | invalid_request | No | [docs:G-ERR] [docs:API-EVENTS] |
| HTTP 413 / payload too large | invalid_request | No (compress or shrink) | [oc:PE:235-236] |
| 400 with context-length overflow | context_overflow | No as-is; compact history, then a new request | [docs:API-EVENTS] [oc:PE:225-234] |
| `incomplete_details.reason: max_output_tokens` | not an error: finish reason "length" | Continue or compact | [docs:G-REASON] [oc:OR:953] |

`invalid_prompt` is used for usage-policy rejections in OpenAI's case [oc:PE:146-151]. The docs list it in the enum
without a description [docs:API-EVENTS].

---

## 8. Model listing for this flow

Endpoint: `GET https://api.openai.com/v1/models` with the same bearer access token used for inference [docs:SIWC-MI].

```bash
curl --fail-with-body -sS https://api.openai.com/v1/models -H "Authorization: Bearer $ACCESS_TOKEN" \
  | jq '[.models[] | select(.visibility == "list") | {slug, display_name}]'
```

[docs:SIWC-MI]

- The response contains a `models` array. This is not the general API's `data` array (section 12) [docs:SIWC-MI].
- Keep `visibility == "list"` entries and preserve the server's ordering [docs:SIWC-MI].
- Show `display_name`; send `slug` as `model` [docs:SIWC-MI].
- Refresh the list when the user switches ChatGPT accounts [docs:SIWC-MI].
- The list is a catalog, not an entitlement check. A successfully completed inference verifies access to that model
  [docs:SIWC-FULL] (Codex app-server section).

Per-model fields observed by opencode [oc:CG:76-86]:

```json
{ "models": [ {
  "slug": "gpt-6.1-sol",
  "display_name": "GPT-6.1 Sol",
  "visibility": "list",
  "supported_in_api": true,
  "context_window": 400000,
  "input_modalities": ["text", "image"],
  "supported_reasoning_levels": [ { "effort": "low" }, { "effort": "medium" }, { "effort": "high" } ]
} ] }
```

The example values are illustrative; field names and types come from the decoding schema.

- `slug`, `display_name` and `visibility` are documented [docs:SIWC-MI].
- `supported_in_api` (boolean), `context_window` (integer greater than 1), `input_modalities` (string array) and
  `supported_reasoning_levels` (optional array of `{effort}`) come only from opencode's schema [oc:CG:76-86].
  Live: all four are present, along with `max_context_window`, `default_reasoning_level`, `default_verbosity`,
  `supports_parallel_tool_calls`, `base_instructions` and many Codex-specific flags. `supported_reasoning_levels`
  entries also have a `description` [live].
- opencode filters `visibility === "list" && supported_in_api` [oc:CG:425]. It maps `context_window` to the context
  limit, `supported_reasoning_levels[].effort` to effort variants, and keeps only `text`/`image` input modalities
  [oc:CG:445-465].
- opencode's live model fetch is currently commented out. It falls back to a hard-coded allow-list (`gpt-5.5`,
  `gpt-5.6-{luna,sol,terra}`, `gpt-6-{astra,luna,sol}`, `gpt-6.1-{sol,terra}`, each with a `-fast` twin)
  [oc:CG:33-52] [oc:CG:314] [oc:CG:337-373].

---

## 9. Reasoning and verbosity controls

- `reasoning.effort` takes `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Support and defaults are
  model-dependent [docs:API-CREATE] [docs:G-REASON].
  - GPT-6 Astra rejects `none` with HTTP 400 [docs:G-REASON].
  - GPT-6.1 Sol rejects `none` and `minimal` and defaults to `medium` [docs:G-REASON].
  - Use the model list's `supported_reasoning_levels` to constrain choices [oc:CG:456-461].
- `reasoning.summary` takes `auto`, `concise` or `detailed`. Summaries are emitted only when requested [docs:G-REASON].
  `auto` gives the most detailed available summarizer [docs:G-REASON]. `generate_summary` is deprecated
  [docs:API-CREATE].
- `reasoning.context` takes `auto`, `current_turn` or `all_turns` (section 3.6) [docs:G-REASON].
- `reasoning.mode` takes `standard` or `pro` on GPT-5.6 / GPT-6 [docs:G-REASON]. opencode disables pro-mode models on
  this flow [oc:CG:325-327].
- `text.verbosity` takes `low`, `medium` (default) or `high` [docs:API-CREATE].
- `text.format` defaults to `{type:"text"}`; `json_schema` is also available [docs:API-CREATE].
- None of these fields is on the rejected list [docs:SIWC-PL]. Acceptance is not affirmatively documented (section 12).
  Live: `reasoning.effort` `low`/`medium` and `reasoning.summary:"auto"` are accepted. The response echoes
  `summary:"detailed"` for `auto`. At `low`, `gpt-6-luna` emitted no reasoning item for trivial prompts [live].
- Changing `reasoning.effort` or `text.verbosity` between steps changes the cached prefix. Keep both fixed per
  conversation. On GPT-6+, use a `configuration_update` item instead [docs:G-CACHE] [docs:G-PREFIX].
- The response echoes the request-level `reasoning.effort` even after a `configuration_update` [docs:G-REASON].
- Reasoning tokens are billed as output and occupy context. OpenAI recommends reserving about 25,000 tokens for
  reasoning and output when starting out [docs:G-REASON].

---

## 10. Image input

- Supported on this flow when the model accepts images [docs:SIWC-PL].
- Use an `input_image` content part in a user message, or in a `function_call_output.output` array:

```json
{ "role": "user", "content": [
  { "type": "input_text", "text": "What is in this screenshot?" },
  { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo...", "detail": "auto" } ] }
```

[docs:API-CREATE] [docs:G-VISION]

- `image_url` is a fully qualified URL or a base64 data URL [docs:API-CREATE].
- `file_id` requires the Files upload API, which this flow does not support [docs:SIWC-PL].
- `detail` takes `low`, `high`, `auto` (default) or `original` (model-dependent) [docs:G-VISION].
- Supported types: PNG, JPEG, WEBP, non-animated GIF. Limits: up to 512 MB total payload, up to 1,500 images per
  request, at most 30,000 patches per image [docs:G-VISION].
- Files are also supported on this flow when the model accepts them, as `input_file` with
  `file_data`/`file_url`/`filename` [docs:SIWC-PL] [docs:API-CREATE]. opencode sends PDFs as `input_file` with a data
  URL in `file_data` [oc:OR:592-600].
- Downsize images before first sending. Shrinking them later is a prefix change [docs:G-PREFIX].
- opencode's comment in section 1.7 suggests that large inline images could exceed the uncompressed body limit;
  compress the body [oc:CG:303-304].

---

## 11. Client checklist (each item restates a sourced rule above)

1. Always send `store:false`, `stream:true`, the full `input`, and no `previous_response_id` (1.1, 1.2).
2. Strip every rejected field (1.2). In particular, never send `max_output_tokens`, `temperature`, `top_p`, `metadata`,
   `user`, `safety_identifier`, `truncation` or `prompt_cache_retention`.
3. Use a fixed developer message or fixed `instructions`. Never send `role:"system"` items (1.4).
4. Keep `tools`, `parallel_tool_calls`, `reasoning`, `text` and `model` byte-identical across steps of a conversation.
   On the final step use `tool_choice:"none"`, not an empty `tools` array (2.4, 6).
5. Replay `output_item.done` items verbatim and in order, including reasoning `encrypted_content` and assistant
   `phase`. Append `function_call_output` items with the right `call_id` (3).
6. Accumulate argument deltas by `item_id`. Execute tools only after `output_item.done` or `arguments.done` (4.3).
7. A step succeeds only on `response.completed`. EOF without a terminal event is `incomplete_stream` (5.4).
8. Read usage from the terminal event's `response.usage` (4.5).
9. Classify errors per 7.6. Never auto-retry usage-limit, auth, policy or invalid-request failures. Pre-stream
   bodies come as `{"detail": "..."}` or `{"error": {...}}`, and `error.code` can be null [live].
10. Send one stable `session-id` header per conversation. Without it prompt caching is erratic [live].
11. Do not require `function_call_arguments.delta` events; take arguments from `.done` or `output_item.done`.
    Ignore `response.metadata` and SSE comment lines [live].

---

## 12. Unverified / conflicting

Items settled live on 2026-11-11 (include, item ids, `call_id`, top-level functions, `configuration_update`,
`session-id`, model list shape, event ordering, SSE framing, rate-limit headers on 200/400, `allowed_tools` `none`,
`response_id`) moved to "Verified live" at the top. What remains:

1. Accepted fields not yet exercised: `prompt_cache_breakpoint`, `text.verbosity` and `text.format`,
   `reasoning.context`, `service_tier`, `additional_tools` items. `prompt_cache_options` is rejected on `gpt-6-luna`
   ("not supported on this model"); other models were not tried.
2. Native compaction (`/responses/compact`, `context_management`, `compaction_trigger`) and `reasoning.mode:"pro"`.
   opencode disables both on this flow [oc:CG:322-327]. Not probed: pro mode could be expensive.
3. Body size. The ~1 MiB uncompressed limit is an opencode comment only [oc:CG:303-304]. zstd bodies are accepted
   [live]; the limit itself was not probed.
4. `thread-id` and `x-client-request-id` headers [oc:CG:285-288]: purpose and effect not probed.
5. `x-codex-turn-state` response header: an opaque `gAAAA…` blob on every response [live]. Whether a client should
   echo it back (for routing or cache affinity) is unknown.
6. `cached_tokens` granularity: 3,072 of a ~3,250-token prefix each time [live]. Whether this is 1,024- or
   128-token blocks, and the minimum cacheable prefix on this flow, are not settled. Cache lifetime was not measured.
7. Context-overflow error. The docs only say "fail with a 400 error" [docs:API-EVENTS]. Skipped: too expensive to
   trigger. opencode detects overflow by code or regex [oc:PE:16-58] [oc:PE:225-234].
8. Mid-stream failures. No `error` event, `response.failed` or `response.incomplete` was observed, so their live
   shapes, whether `error` is always terminal, and whether `response.incomplete` carries `usage` remain open.
9. 429 and usage-limit responses: whether `retry-after` or `x-ratelimit-*` appear on them. Not triggered on purpose.
10. Idle or keepalive timeouts and maximum stream duration. `: keep-alive` comments do occur [live]; their interval
    and any server timeout are unknown.
11. Whether the model actually uses replayed reasoning (`reasoning.context` echoes `all_turns`). Replay is accepted
    and billed about 15 input tokens [live]; its effect on answers was not measured.
12. `function_call_output` addressed by `name` instead of `call_id`: the error text implies it is possible [live].
    Not tried; always send `call_id`.
13. `incomplete_details.reason: "max_messages"` is listed without explanation [docs:API-EVENTS].
14. `subscription_sharing_workplace_individual_usage_limit_exceeded` is opencode only [oc:CG:55].
