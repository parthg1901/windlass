---
name: harness-testing
description: How to test Windlass like a user, headless. Use before calling any wave or feature done, when a live ChatGPT-plan request is needed, or when sign-in fails.
---

# Testing Windlass headless

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

Credentials are at `~/.local/share/windlass/auth.json` (mode 0600). The access token lasts an hour and refreshes itself on use; the refresh token lasts 30 days and rotates on every refresh.

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

## Replay measurements

- An `execute` replay costs about as many requests as the recording has steps (5.9 per replay on 4 to 5-step tasks, 2026-11-12). Count before spending.
- At low and medium effort every unchanged replay leaves its recording within four steps (20 of 20 at low effort), so never read divergence counts. Read which files changed and the grade.
- Byte-for-byte file comparisons differ for equivalent work (reordered YAML entries, an equivalent formula, prose notes): 12 of 20 unchanged replays differed in bytes while 0 of 20 changed other files.
- A replay that answered without running a tool leaves an empty `<data dir>-work/replays/<id>` behind; nothing removes it yet.

## Scripted model (`WINDLASS_ACP_SCRIPT`) gotchas

- The script is shared by a parent and its subagents and consumed in call order. Keep one subagent per step; parallel children race for the responses.
- Each process plays its script from the start: the `fork` subcommand needs no responses, the `replay` subcommand needs the recording's responses again.
- With a throwaway `XDG_DATA_HOME` there is no sign-in, and every subcommand that starts the server needs either the sign-in or `WINDLASS_ACP_SCRIPT`, `fork` included although it calls no model.
- To reproduce "session in use" after a kill: put a command with `trap '' TERM` in the scripted turn, `kill -9` the CLI, then run `--continue` within 5 s.
- In a git worktree, set `PREFIXLENS_DIR=/home/ubuntu/projects/prefixlens`: the prefix gate and the eval classifier look for prefixlens beside the repository and skip silently when it is not there.

## MCP, skills and wake-ups (wired 2026-11-12)

- A one-prompt run cannot call an MCP tool in the default mode: `mcp_call` is a network-class call, nobody is there to ask, and it is refused as unattended. For a scripted or live one-shot check use `--approval full` and `"untrusted": false` on the server; interactively the question is asked. Both are needed: with an untrusted server (the default) the model's first `mcp_search` taints the session (`Content from the MCP tool mcp_search …`), and from then on even `full` asks, so the one-shot call is refused (seen live twice, 2026-11-12).
- `evals/dogfood/mcp-server.ts` is a user-style stdio server (legacy handshake, tools with answers the model cannot guess, `--log` of every request) and `mcp-config.ts` writes it into a throwaway user config (`--user <dir>` with `XDG_CONFIG_HOME=<dir>`) or a project config. The server's log is the proof of whether it started and what it received.
- A server named by the PROJECT's config file is not started until the user approves it; only a server in the user's file starts by itself. Point `XDG_CONFIG_HOME` at a throwaway directory to give a run its own user config; the sign-in stays in the data directory.
- A skill in the workspace (`.claude/skills/<name>/SKILL.md`) shows in the CLI as `· instructions updated (skills)` at the first step, then `▸ skill <name>`. Checked live: 3 requests, 3 full-request records, one provider-side miss.
- Wake-ups fire only in a process whose engine was told to run them (`engine.wake.run`). As of 2026-11-12 no client passes it, the `windlass acp` child of the CLI and the TUI included: a wake-up is created and never fires. Cancel every wake-up a test creates (`wake_cancel`, interactively: unattended it is refused as "writing files"), or it will fire into that session, at a cost, once a process runs the scheduler.
- A scripted turn can finish before an `await fetch()` in the test returns: take the event index before the request.
- `afterEach` in a shared test helper runs only for the first test file that imports it; register clean-up in each file.
- The frozen tool list has 19 tools since this pass (13 before); the first request of a session is about 5,000 tokens.

## The line CLI after the first-user fixes (2026-11-12)

- `--json` ends each turn with a `{"type":"cli.summary",…}` line (steps, time, usage, cached share): the engine's last event is the line before it (`.at(-2)`). The eval runner counts the line under `unknownEvents`; that is information, not a failure.
- `WINDLASS_ACP_SCRIPT` accepts every `--model`, so an unknown-model test needs an in-process harness with `engine.listModels`.
- `export XDG_DATA_HOME=…` in one tool call does not carry to the next: set it inline on each command, or a "signed out" check quietly uses the real sign-in.
- A first word of `/<letters>` is taken as a command and never sent to the model; `//` at the start sends a message that begins with a slash. `/tmp is full` is caught; `/etc/hosts …` (a second slash) is sent as typed.
- A queued message is its own turn; a steer belongs to the turn it steers. Fork points can be given as turns (`fork --turn N`).
- Listing, reading, resolving an ID and forking work signed out; opening a session (`session/new`, `session/load`) still needs the sign-in.

## Second dogfood pass (2026-11-12): what testing the newer features taught

- `evals/dogfood/events.ts <id> [--type <prefix>]` prints a session's events read-only: the quickest way to see how many compactions or summary calls happened, a fork's lineage, what an MCP catalogue said. The event table is `event` (not `events`); the session row has `cwd`, `title`, `parent_id`.
- `calls.ts --cwd` now counts descendants (subagents, forks in copies, replays) through the lineage in `session.created`: they work under `<data dir>-work/`, and a count by directory missed them. A replay's lineage names its recording, not a parent.
- Compaction on demand: `WINDLASS_TEST_CONTEXT_WINDOW=20000` (usable window 16,000 after the 20% output reserve; compaction is due from about 10,400 tokens at a user message and at once from 12,800). Two `-c` turns that each read a 10 to 20 KB file get there; three big reads in one turn compact in the middle of it. The TUI's panel still shows the model's real window (272k) under the variable.
- The line interface shows nothing when a session is resumed (`-c` with no prompt): no history, no ID. Read a resumed session in the TUI or with `events.ts`.
- `windlass fork --through <n>` takes an event number, which only `events.ts` shows; a number between a message's `inbox.enqueued` and its `inbox.delivered` makes a fork without that message.
- A fork made with `--copy`, and a replay under `execute`, work in a copy without `node_modules` and without `.git`: the project's checks fail there (`could not start` for `tsc`). Expect exit code 3 from such a fork's first edit.
- `windlass replay` prints the divergence report only; the "compared on what it did (reads ignored)" part that `docs/replay.md` says carries the signal is printed by `bun scripts/replay.ts` alone.
- A foreground subagent's running command is invisible in the line interface until it settles (only `⋯ running subagent …`); the TUI shows `now: shell …`. To interrupt at the right moment, poll `pgrep -a -x sleep` for the child's command, not the screen: the task text already contains the command.
- Background commands and subagent children are killed on Ctrl-C and on exit (checked with `pgrep -a -x sleep`). The output path a background start prints (`/tmp/.spill/…`) is the sandbox's view; on the host it is `/tmp/<brand.directory>-<uid>/<session>/.spill/`.
- Images: `evals/dogfood/make-image.ts` makes PNGs with checkable answers. The live model described both correctly (2 of 2) after `read`; the tool row says `1 line`.
- Text typed into the line interface before its first `›` is not sent although it looks sent. Under load (load average 11 on two cores) start-up took over 3 s: wait for `^›` before typing.
- An interactive start that sends nothing, and `/fork` in a new TUI session, leave empty `(untitled)` sessions that `--list-sessions` shows and `-c` may pick.
- Timing on this machine depends on other agents' load: say the load average with any start-up figure (`uptime`).

## After the second engine pass (2026-11-12)

- The frozen tool list has 20 tools, about 3,300 estimated tokens (`bun scripts/tool-block.ts` prints it); a session's first request is about 4,550 tokens.
- Wake-ups fire in the server of an interactive run (`windlass`, `windlass tui`, an editor's `windlass acp`), never in a one-prompt run, a listing or a subcommand (the CLI sets `WINDLASS_WAKE=off` for those). List pending wake-ups before starting an interactive session in a data directory with old ones: they fire at once, late.
- A question asked after a hand edit ends "nothing to check"; the next turn that edits a file runs the checks on everything unverified, the hand edit included, and the model may then repair the user's file.
- The CLI has no `--agent` yet: test an agent with `agents.default` in a throwaway `XDG_CONFIG_HOME`.
- In tmux, wait for the `›` prompt before sending keys: under load a fixed 6-second wait lost the Enter.
- Under heavy load (five agents on two cores: load average 15 to 20) tests time out at the default 5 s. Re-run a timeout alone, or with `--timeout 60000`, before believing it.
- prefixlens is a separate repository that may be changing under you: a failing `packages/core/test/trace/export.test.ts` can mean the sibling checkout moved (its trace format, how it records images), not that the harness broke. Check `git -C ../prefixlens log` first.

## Client commands for MCP, skills, wake-ups and memory (2026-11-12)

- A scripted `WINDLASS_ACP_SCRIPT` response without a `usage` item records no model call (the TUI panel then says "no model call yet").
- A background command's log is named in the tool output by the sandbox's path (`/tmp/.spill/...`); the path on the host is `spawn.started.data.work.logPath`, and the clients print that one.
- Approvals of a project's MCP server are kept under `XDG_DATA_HOME`, so a fresh data directory asks again. A one-prompt run cannot approve: it prints how (`/mcp approve <name>` in an interactive run).
- At a load average above 10 the killed-CLI subprocess test, the undo/redo test and the TUI crash test have each timed out and then passed alone. Re-run a failing file alone before treating it as a failure.

## After the engine fixes (2026-11-12)

- The store's schema version is 8 (it changes with most engine passes): session files written before are refused (`schema_mismatch`) and not listed. Nothing is migrated, since nothing is released.
- A one-prompt run can search and call a tool of an untrusted MCP server with `--approval full`; only the call's result taints the session, the search does not.
- `wake_cancel`, `memory_save` and `memory_retract` run unattended in `auto` and `full`; `ask` still asks.
- A compaction's ending carries `calls`, the summary calls it took: count them with `bun evals/dogfood/events.ts <id> --type compaction.ended`. Model requests of a turn are its steps plus those calls.
- A turn that did its work and then got two empty answers ends as done, with a `no_closing_answer` notice; with no work done it still fails.
- A subagent's ending says `left_to_parent` for verification, not `not_configured`.
- `evals/gate.test.ts` fails until the baseline is re-recorded on all 27 tasks.
- Under load 15 or more, type-check a commit in a copy (`git archive <sha> | tar -x -C <dir>`) so edits can continue meanwhile.

## Hooks and language-server diagnostics (wired 2026-11-12)

- With no `hooks` and no `lsp` section configured, a session's requests and log are byte-identical to before; a test holds that.
- A before hook that refuses a call shows the model the reason as the call's result; an after hook's note and a language server's diagnostics are appended to the tool's result before it is capped and stored.
- A project's hook or language server is skipped, with a diagnostic, until a client can approve it (no client can yet); put them in the user's config file to test.
- Stop hooks do not run for a subagent's turn; a replay runs no hooks and no language servers.
- Live, pyright's first diagnostics after an edit took 1.4 s; the default bound is 1.5 s, so a cold server can miss the first edit.

## Slash commands and telemetry (wired 2026-11-12)

- A session is idle by the time a reader sees its turn's ending event: an undo sent at that instant is accepted (it was refused as busy for a while; `packages/core/test/engine/idle-at-ending.test.ts` holds it).
- A user-defined slash command is expanded by the engine and recorded with the message it produced (`command.expanded`); clients send it with `session.sendCommand`. The client commands for it may lag behind the engine.
- Telemetry is off unless the user's own config file turns it on; a project's file can only turn it off. To look at a real turn's spans, point it at a local file or a local fake collector: one turn gives a turn span, a span per model call (token counts, response model, request ID) and a span per tool call, with no content.

