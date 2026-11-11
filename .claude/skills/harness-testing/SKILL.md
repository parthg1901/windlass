---
name: harness-testing
description: How to test light-harness like a user, headless. Use before calling any wave or feature done, when a live ChatGPT-plan request is needed, or when sign-in fails.
---

# Testing light-harness headless

Unit tests prove the pieces; this skill is for proving the product. Run the real entry points end to end and read the output as a user would. Add to this file whenever a test run teaches something (a failure mode, a slow path, a trick that saved time).

## Rules

- The only provider is ChatGPT plan usage (Sign in with ChatGPT). No API keys, no other providers.
- Live requests spend the owner's ChatGPT plan allowance. Use the scripted fake provider for anything that does not need a real model, and keep live prompts tiny.
- Never print, log or commit tokens. `auth.json` lives outside the repo and is ignored by git.
- Never commit real session databases or transcripts. Fixtures are small, synthetic and hand-written.

## Sign-in state

```sh
bun scripts/login.ts status     # account, client ID, scopes, minutes until the access token expires
bun scripts/login.ts ping       # lists models, then one "Hello, world!" request with usage and event counts
```

Credentials are at `~/.local/share/light-harness/auth.json` (mode 0600). The access token lasts an hour and refreshes itself on use; the refresh token lasts 30 days and rotates on every refresh.

## Signing in again (remote machine)

The redirect goes to `127.0.0.1:1455` on the browser's computer, not this server, so the callback page fails to load there. That is expected.

1. `bun scripts/login.ts start` prints the sign-in URL and saves the pending state.
2. The owner opens the URL, approves, and copies the full `http://127.0.0.1:1455/auth/callback?...` address from the browser.
3. Save that URL to a file and run `bun scripts/login.ts finish <file>`. Ask the owner for it through the secret prompt, never in chat.

If port 1455 is forwarded to this machine, `bun scripts/login.ts listen` catches the callback directly instead.

## Known behaviour of the live API

- `GET /v1/models` returns a `models` array; use entries with `visibility == "list"` and send `slug` as `model`.
- A stream is only successful when `response.completed` arrives. Usage is on that event.
- Usage reports `input_tokens_details.cached_tokens` and `cache_write_tokens`, plus a per-item `attribution` map.
- Rejected request fields include `temperature`, `top_p`, `max_output_tokens`, `previous_response_id`, `metadata`, `user`, `truncation`, and system-role message items.

## Gotchas

- Do not stop a background helper with `pkill -f <its command line>` from a shell whose own command line contains the same text: it kills the shell too. Kill by PID.
