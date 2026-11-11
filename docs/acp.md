# Using light-harness from an editor (ACP)

light-harness speaks the [Agent Client Protocol](https://agentclientprotocol.com) version 1 on stdin and stdout, so an
editor or any other ACP client can start it as its agent. (The display name, the `lh` binary and the `_light-harness`
extension prefix below all come from `packages/core/src/brand.ts`; they change with it.)

## Start it

The client runs this command and talks to it over stdio:

```
lh acp
```

From a checkout, without installing the binary, point the client at Bun and the CLI entry point:

```json
{
  "command": "bun",
  "args": ["/path/to/light-harness/packages/cli/src/main.ts", "acp"]
}
```

For Zed, for example, that object goes under `agent_servers."light-harness"` in `settings.json`.

Before the first session, sign in with your ChatGPT plan on the same machine (`bun scripts/login.ts start` in the
checkout, then finish the sign-in it prints). When you are not signed in, creating or loading a session fails with
ACP's auth-required error (`-32000`) and a message that says this; the client's "authenticate" button only re-checks.

Only one process can use the session database at a time: while `lh acp` runs, an `lh` in another terminal reports that
the database is in use, and the other way round. Sessions are shared, so a session started in the editor can be resumed
with `lh --session <id>` later.

Logs go to stderr (editors keep them as the agent's log); nothing but protocol messages is written to stdout. Set
`LH_ACP_LOG=debug` for more. Closing the connection, or SIGTERM, SIGINT or SIGHUP, stops running work as a shutdown:
every command the agent started is stopped, and the session resumes later where it was cut off.

## What is supported

| ACP | How light-harness does it |
| --- | --- |
| `initialize` | Protocol version 1. Capabilities: `loadSession`, embedded text context in prompts, `sessionCapabilities` `list`, `resume`, `close`, `delete`. One auth method, "Sign in with ChatGPT". |
| `authenticate` | Checks the saved sign-in; succeeds if it is usable, otherwise answers auth-required with how to sign in. There is no in-client browser flow. |
| `session/new` | A session in the client's `cwd` (an absolute directory). The response carries the config options below. |
| `session/load` | Replays the whole stored conversation as `session/update`s (user messages, reasoning, text, tool calls with their final status), then reports the title (`session_info_update`), the context use (`usage_update`), and the session's state (the `_light-harness/state` notification below), then answers. The `cwd` must be the session's own. |
| `session/resume` | The same without the replay. |
| `session/list` | Sessions (not deleted), newest first, filtered by `cwd`, 100 per page. Each has `_meta["light-harness"] = { model, effort }`. |
| `session/prompt` | Text, `resource_link` (named as `[file: /path]` or `[link: uri]` so the model can open it) and embedded text `resource` (the text in a fenced block under the same header). The response is the stop reason of the turn. |
| A prompt while the agent works | Steers it: the message reaches the model at the next step boundary (after the running tool calls), in the same turn. Every prompt the turn took in is answered when it ends, with the same stop reason. |
| `session/cancel` | Prompts not yet delivered are withdrawn and answered `cancelled` at once; the running turn is interrupted (commands are stopped) and its prompt is answered `cancelled` after its last update. A prompt sent right after a cancel starts the next turn. |
| `session/close` | Cancels, then frees the session in the agent. |
| `session/delete` | A soft delete: the session is archived and disappears from `session/list` and `session/load`; its log is kept. |
| `session/set_config_option` | Two select options: `model` (category `model`, the models the account offers) and `effort` (category `thought_level`: `default` or the model's efforts). A change applies from the next step boundary, also in the middle of a turn, and is reported with `config_option_update`. |

Stop reasons: `end_turn`; `max_turn_requests` when the turn reached its step limit; `max_tokens` when the last
response hit the output limit; `refusal` when the provider refused; `cancelled`. A turn that fails answers the prompt
with an error instead (v1 has no error stop reason): `-32000` when the sign-in was rejected, otherwise `-32603` with
the harness's sentence, such as "The model call failed 4 times: ...", and `data["light-harness"] = { reason:
"execution_failed", providerError? }` naming the provider's error class when there was one.

Updates during a turn: `agent_thought_chunk` (reasoning summaries) and `agent_message_chunk` as they stream; one
`tool_call` per call as soon as the model starts writing it, then `tool_call_update`s: the title and arguments
(`rawInput`) once they are complete, `in_progress` when it runs, the latest output of a running command, and the final
status with its content. Tool kinds: `read` (read, ls), `edit` (write, edit), `search` (glob, grep), `execute` (shell).
Locations are absolute paths, with the line for a read with an offset and for each changed region of an edit. Content:
a diff for an edit (one per changed region, with three lines of context) and for a new file; the output in a code block
for a command, a search or a listing; a line count for a read. `rawOutput` has the outcome, the text the model got, and
the tool's structured `display` data. `usage_update` follows each model call (tokens in context against the model's
window). Retries are shown as `notice`s, and compactions as `compaction_update`s, to clients that advertise them.

Tool outcomes ACP v1 has no status for are `failed` with a title suffix and a sentence: "(not started)" for a call the
interrupt reached before it ran (safe to run again), "(outcome unknown)" for one that started a side effect and was
stopped before reporting (check before repeating it). `_meta["light-harness/outcome"]` on the final update always holds
the harness outcome: `success`, `error`, `not_started` or `effect_unknown`.

IDs are stable: a user message has the harness message ID, agent text and reasoning are `<message>:t<n>` and
`<message>:r<n>`, a tool call is `<message>/<call>`. A replay uses the same IDs as the live turn.

## What is not supported (yet)

- Images and audio in prompts (`promptCapabilities.image` is false), and binary embedded resources.
- MCP servers: the ones a client passes in `session/new` are ignored, with a line in the log.
- Permission requests. The agent never asks: its tools read, write and run commands in the session's directory on
  their own, as they do in the CLI.
- The client's file system and terminal methods (`fs/*`, `terminal/*`): tools run inside the agent.
- Session modes, plans, slash commands (`available_commands_update`), `logout`, additional directories, and system
  prompt overrides.
- A replay shows what was said and done, not how earlier turns ended: a cancelled or failed turn's stop reason is not
  replayed.
- ACP v2. The SDK's v2 is an experimental draft whose prompt turn works differently (a prompt is answered once it is
  inserted and completion is a `state_update`), so serving it means a second set of handlers rather than a flag.

## Extensions

Advertised in `initialize` as `agentCapabilities._meta["light-harness"] = { methods, notifications, promptMeta }`.

**`session/prompt` `_meta["light-harness/delivery"]`**: `"steer"` (the default) or `"queue"`. A queued prompt waits
until the agent would otherwise stop, then gets its own answer in the same turn.

**`_light-harness/steer`** (request) and **`_light-harness/queue`** (request): admit input without waiting for the
turn. The message is shown as a `user_message_chunk` where it lands. If the session is idle, it starts a turn; its end
is reported by `_light-harness/state`.

```ts
// params
{ sessionId: string, prompt: ContentBlock[] }   // the same content blocks as session/prompt
// result
{ messageId: string }                           // the ID the message has once delivered
```

**`_light-harness/models`** (request): the models and efforts the account offers.

```ts
// params: {}
// result
{
  defaultModel: string,
  models: { id: string, name: string, efforts: string[], defaultEffort: string | null, contextWindow: number | null }[]
}
```

**`_light-harness/usage`** (notification, agent to client): after every model call that reported usage, including
the prompt-cache counts.

```ts
{
  sessionId: string,
  messageId: string,          // the assistant (or compaction) message the call served
  model: string | null,
  usage: {
    inputTokens: number,        // all input, including cached
    cachedInputTokens: number,  // the part of inputTokens read from the prompt cache
    outputTokens: number,       // all output, including reasoning
    reasoningTokens: number     // the part of outputTokens spent on reasoning
  }
}
```

**`_light-harness/state`** (notification, agent to client): when the session starts working, when it stops, and on
load or resume.

```ts
{
  sessionId: string,
  state: "running" | "idle" | "suspended",  // suspended: cut off by a shutdown; the next prompt takes it up again
  stopReason?: string,                       // on idle after work: a session/prompt stop reason, or "error"
  message?: string                           // on idle after a failure: why
}
```

## Trying it without an editor

`packages/acp/scripts/try-client.ts` is a small ACP client that starts `lh acp`, opens a session in a temporary
workspace, sends a prompt and prints every update:

```
bun packages/acp/scripts/try-client.ts --setup failing-test --model gpt-6-luna --effort low "Run the tests and fix the failing one."
bun packages/acp/scripts/try-client.ts --cancel-on-command 2000 "Run sleep 20 with the shell tool."
bun packages/acp/scripts/try-client.ts --workspace <dir> --load <session id>
```

For tests, `LH_ACP_SCRIPT=<file.json>` makes `lh acp` use a scripted model instead of the real one (see
`packages/acp/src/scripted.ts`).
