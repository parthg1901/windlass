# Known behaviour of the live Responses API (ChatGPT sign-in)

- `GET /v1/models` returns a `models` array; use entries with `visibility == "list"` and send `slug` as `model`.
- A stream is successful only when `response.completed` arrives. Usage is on that event.
- Usage reports `input_tokens_details.cached_tokens` and `cache_write_tokens`.
- Prompt caching needs a stable `session-id` request header per conversation; without it hits are erratic.
- A cold prefix takes a few seconds to become readable, so a follow-up within about 2 s can miss. Wait about 10 s between requests when a test asserts a cache hit.
- Cache probes: `bun scripts/probe-responses.ts cache2` (8 requests). Re-run a surprising verdict before trusting it.
- Rejected request fields include `temperature`, `top_p`, `max_output_tokens`, `previous_response_id`, `metadata`, `user`, `truncation`, and system-role message items.
