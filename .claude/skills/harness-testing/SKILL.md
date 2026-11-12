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
- Prompt caching needs a stable `session-id` request header per conversation. Without it hits are erratic. A cold prefix takes a few seconds to become readable, so a follow-up sent within about 2 s can miss; wait about 10 s between requests when a test asserts a cache hit.
- Cache probes: `bun scripts/probe-responses.ts cache2` (8 requests). Re-run a surprising verdict before trusting it: a single run misled us once.
- Rejected request fields include `temperature`, `top_p`, `max_output_tokens`, `previous_response_id`, `metadata`, `user`, `truncation`, and system-role message items.

## Gotchas

- Do not stop a background helper with `pkill -f <its command line>` from a shell whose own command line contains the same text: it kills the shell too. Kill by PID.

## Running real tasks (the fastest whole-product check)

```sh
bun evals/run-agent.ts --all --model gpt-6-luna --effort low --out <dir outside the repo>   # ten tasks, about 3.5 min, about 60 requests
bun evals/run-agent.ts fix-failing-test --model gpt-6-luna                                   # one task, about 20 s
bun packages/cli/src/main.ts --cwd <workspace> --model gpt-6-luna --effort low "<prompt>"    # one prompt, human-readable
```

First full run (2026-11-11, gpt-6-luna, low effort): 8 of 10 passed, median 18.6 s, 283k tokens, 75% of input read from cache.

Reading a result:
- `cache-drop` in the anomalies column means a step read fewer cached tokens than the one before. Do not assume a harness bug. Export the session and ask prefixlens:
  `bun scripts/export-trace.ts <session-id> -o /tmp/t.jsonl && bun ../prefixlens/src/cli.ts report /tmp/t.jsonl --all`
  "provider-side miss, not caused by the harness" with all records full-request means the prefix was intact (seen on 4 of 10 runs; it is the provider's lag on quick follow-ups). Any other cause is a real bug.
- "N full-request, 0 usage-only" in the report is itself a check: every request rebuilt from the log matched the hashes in the ledger.
- A failed task is not always the agent's fault. Read the task prompt against the grader's reason before blaming either (one grader demanded behaviour the prompt never asked for).
- `retry-after-error` fails on gpt-6-luna at low effort because the model refuses to remove a stale lock without confirmation. That is model caution, a useful signal when comparing prompts or models.
- Keep run output and exported traces outside the repo and delete them afterwards.

## Dogfooding (a real repository, the real model)

`evals/dogfood/` holds the kit: `setup.ts` clones prefixlens into a throwaway workspace (origin removed, dependencies installed, the project configuration with its real `bun test` and typecheck checks, an optional seeded bug, all committed), `calls.ts` counts the requests a pass spent, and `README.md` lists ten tasks with how to judge each. A full pass is about 60 requests. Gotchas from the first pass (2026-11-12):

- The line interface has no `/help` (or any unknown slash command): it is sent to the model, costs a request, and becomes the session's title. Only `/undo`, `/redo`, `/diff`, `/queue`, `/approval` (or `/mode`), `/clear-taint`, `/exit` and `/quit` are local (`packages/cli/src/main.ts`, the `submit` case).
- An effort the model does not list (`--effort ultra` on `gpt-6-luna`) is not checked before sending: one request spent on an HTTP 400, and a failed session is left as the directory's latest for `-c`. Check `--models` first.
- `--models` without a sign-in throws an uncaught error with a source excerpt; a prompt without a sign-in prints the clean message. Use a throwaway `XDG_DATA_HOME` for these, never the real data directory.
- The gate runs on files changed since the last passing check, not since the turn began: a hand edit or an `/undo` between turns makes the next turn (even "reply OK") run every check and report `checks passed`. Commit or revert in the workspace before a turn whose ending you want to read.
- Line-mode interactive needs a terminal; drive it through a private tmux server like the full-screen interface. Wait for a new ending row by counting `^(✓|✗) (done|stopped|failed)` lines in `capture-pane -S -`, since earlier endings stay in the scrollback.
- The line interface prints no session ID anywhere (one-shot, interactive, exit). Get it from `--list-sessions` in the workspace, or from `session.created` in `--json`.
- `--json` has no usage summary event; sum `step.ended.data.usage`, or use `calls.ts`.
- `calls.ts --since <minutes>` counts every session in the data directory, other agents' too; count with `--cwd <workspace>`.
- Checks run in the sandbox and tests that listen on localhost pass there (prefixlens's proxy tests).
- The model's first command is often `find .. -name AGENTS.md`, which walks the workspace's parent: keep workspaces in their own empty parent directory so that walk stays small.
