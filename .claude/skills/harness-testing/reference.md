# Headless testing: reference

Detail for [SKILL.md](SKILL.md). Read the part you need.

## Script items (`WINDLASS_ACP_SCRIPT`)

`{ "responses": [[item, ...], ...] }`, one list per model call, parsed by `packages/acp/src/scripted.ts`.

| `type` | Fields | Use |
|---|---|---|
| `text`, `reasoning` | `text` | what the model says or thinks |
| `tool_call` | `callId`, `name`, `input` | a call of a real tool; it runs |
| `usage` | `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens` | token counts for the call |
| `delay` | `ms` | time to act before the next item (interrupt, steer, type) |
| `finish` | `reason`: `stop`, `tool_calls`, `length` | how the response ends |
| `fail` | `kind`, `message` | a provider error |

- A subagent takes its responses from the parent's list, in call order: the child's responses come between the
  parent's `subagent` call and the parent's next response. Script one subagent per step; two started together race
  for the list.
- The script accepts any `--model`, so an unknown-model check needs an in-process test, not a scripted run.
- A call that asks under the default `auto` mode: a `write` to a path outside the workspace and outside `/tmp` (use
  a directory under `/var/tmp`), or a `shell` call with `"sandbox": { "network": true }`. A one-prompt run cannot
  answer: the call is refused (`--unattended`).

## Signing in again

`bun scripts/login.ts status` says who is signed in and when the access token expires; an expired access token
refreshes itself on use and is not a problem. A refused refresh needs a new sign-in, which only the owner can do:

1. `bun scripts/login.ts start` prints the sign-in address and saves the pending state.
2. The owner opens it and approves. On a remote machine the browser ends on a page at `127.0.0.1:1455` that fails
   to load; its full address is what you need.
3. Ask the owner for that address through a secret prompt, never in chat, save it to a file outside the repository,
   run `bun scripts/login.ts finish <file>`, and delete the file.

With port 1455 forwarded to this machine, `bun scripts/login.ts listen` takes the callback instead. Afterwards
`bun scripts/login.ts ping` lists the models and makes one request. `docs/troubleshooting.md` has the messages a
user sees.

## Feature recipes

Each feature's behaviour is in its page under `docs/`. This table holds what a test needs to set up.

| Feature | Set-up that makes the test work |
|---|---|
| Compaction | `WINDLASS_TEST_CONTEXT_WINDOW=20000` on the command makes a session compact after a few large reads; with the real window `/compact` finds too little to summarise. Count summary calls with `events.ts <id> --type compaction.ended` (`calls`): they are requests on top of the steps. |
| MCP | `evals/dogfood/mcp-config.ts` adds the test server (`mcp-server.ts`, `--log <file>` records what it received: that log is the proof). A project's server waits for an approval a one-prompt run cannot give: add it to the user's file (`--user <dir>` with `XDG_CONFIG_HOME=<dir>`). A one-prompt call needs `--approval full`; after the first result from an untrusted server the session is tainted and later calls are refused (`docs/mcp.md`, "Trust"). |
| Hooks, language servers | `evals/dogfood/hooks-config.ts`; the same approval rule, so use the user's file for one-prompt runs. In a live prompt say "using the edit tool, not the shell", or the model appends with a command and no after-hook or diagnostics follow. A language server that is still starting misses the first edit: make two. What the model was told is in `events.ts <id> --full`, not on screen. |
| Wake-ups | They fire only in an interactive run's server (`windlass`, `windlass tui`, `windlass acp`). Test a webhook with `evals/dogfood/webhook.ts <URL>`, the secret in `WAKE_SECRET`, never on screen or in a capture. List pending wake-ups before starting an interactive session in a data directory that has old ones: they fire at once. |
| Memory | Off unless the user's file turns it on. Notes are kept in the data directory: with the real one, `/forget <id>` every note the test saved. |
| Telemetry | Only the user's file can turn it on. `evals/dogfood/otel-collector.ts --out <file>` receives it; `--check <file> <word>...` counts words in what arrived, to prove no content was sent. |
| Fork | Works signed out. `--turn <n>` takes the turn number, `--through <n>` an event number from `events.ts`. A `--copy` fork has no `node_modules` and no `.git`, so the project's checks fail there (exit 3). |
| Replay | Calls the live model: about one request per recorded step. Judge by the files changed and the grade, not the divergence count (`docs/replay.md`, "The noise floor, measured"). |
| Images | `evals/dogfood/make-image.ts` writes PNGs with an answer a person can check. |
| Code mode | Compare with and without the tool from a script that drives `createHarness` (`engine: { codeMode: null }` builds it without); keep the approval layer on, since the tool needs the sandbox. Check a program's writes byte for byte. |

## The line interface, interactively

It needs a terminal: drive it in a private tmux server as the `tui-tmux-testing` skill describes, with
`bun packages/cli/src/main.ts --cwd <workspace>` as the command.

- Wait for a turn's end by counting ending rows in the scrollback (`capture-pane -p -S -`) and waiting for one
  more: `^(✓ done|✗ (failed|stopped)|■ (interrupted|stopped))`. Earlier endings and earlier tool rows stay in the
  scrollback and satisfy a plain wait at once.
- A question and the answer typed to it are not kept in the scrollback: read the tail of the visible pane. Answer
  one question at a time and wait for its `approved:` or `not allowed:` line before the next key.
- Capture without `-J` when checking that a long path or command is shown whole: `-J` joins wrapped rows and hides a
  cut. Put a marker at the end of a long word and look for the marker.
- A `/word` that is not a command is never sent; `//text` sends a message that starts with a slash.
- To test Ctrl-C twice, the running command must outlast the first: use `trap '' TERM; sleep 30` and ask the live
  model for it "in the foreground".

## The live API

`docs/reference/responses-api.md` has the request fields the provider accepts and rejects, the stream's events and
how usage is reported. `bun scripts/probe-responses.ts list` names the live probes; `cache2` checks prompt caching in
8 requests. Run a probe again before trusting a surprising verdict.
