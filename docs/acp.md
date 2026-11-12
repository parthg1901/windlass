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

Sessions are stored one file each, and a process holds only the sessions it is working in. While `lh acp` runs, an
`lh` in another terminal works in its own sessions, and so does a second editor. A session is open in one place at a
time: loading one that another process is working in fails with an error that names that process (`data` carries
`reason: "session_in_use"` and `holderPid` under the extension key), and it loads once that process has closed it
or exited. Sessions are shared otherwise, so a session started in the editor can be resumed with
`lh --session <id>` later. The server is built from the same assembly as the command line (`createHarness` in
`@light-harness/core`) and does everything through the engine: `session/close` closes that one session,
`session/delete` archives it, `session/cancel` withdraws prompts that were not delivered yet.

Logs go to stderr (editors keep them as the agent's log); nothing but protocol messages is written to stdout. Set
`LH_ACP_LOG=debug` for more. The engine's own warnings (its diagnostics, notices about the data directory) are logged at
`warn`. Closing the connection, or SIGTERM, SIGINT or SIGHUP, stops running work as a shutdown:
every command the agent started is stopped, and the session resumes later where it was cut off.

## What is supported

| ACP | How light-harness does it |
| --- | --- |
| `initialize` | Protocol version 1. Capabilities: `loadSession`, embedded text context in prompts, `sessionCapabilities` `list`, `resume`, `close`, `delete`. One auth method, "Sign in with ChatGPT". |
| `authenticate` | Checks the saved sign-in; succeeds if it is usable, otherwise answers auth-required with how to sign in. There is no in-client browser flow. |
| `session/new` | A session in the client's `cwd` (an absolute directory). The response carries the config options below. `_meta["light-harness"] = { model, effort }` starts it with those settings, the model checked against the account's models first (an unknown one is refused with `-32602` and the list of valid ones). |
| `session/load` | Replays the whole stored conversation as `session/update`s (user messages, reasoning, text, tool calls with their final status), then reports the title (`session_info_update`), the context use (`usage_update`), and the session's state (the `_light-harness/state` notification below), then answers. The `cwd` must be the session's own. |
| `session/resume` | The same without the replay. On load and resume, `_meta["light-harness"] = { model, effort }` switches the session to them (checked first, recorded as `settings.changed`), and `archived: true` opens an archived session too. |
| `session/list` | Sessions (not deleted), newest first, filtered by `cwd`, 100 per page. Each has `_meta["light-harness"] = { model, effort, archived? }`. With `_meta["light-harness"] = { archived: true }` archived sessions are listed too. |
| `session/prompt` | Text, `resource_link` (named as `[file: /path]` or `[link: uri]` so the model can open it) and embedded text `resource` (the text in a fenced block under the same header). The response is the stop reason of the turn, with how it ended under `_meta["light-harness"]` (below). `_meta["light-harness/maxSteps"]` sets the step limit of the turn the prompt starts. |
| A prompt while the agent works | Steers it: the message reaches the model at the next step boundary (after the running tool calls), in the same turn. Every prompt the turn took in is answered when it ends, with the same stop reason. |
| `session/cancel` | Prompts not yet delivered are withdrawn and answered `cancelled` at once; the running turn is interrupted (commands are stopped) and its prompt is answered `cancelled` after its last update. A prompt sent right after a cancel starts the next turn. |
| `session/close` | Cancels, then frees the session in the agent. With `_meta["light-harness"] = { shutdown: true }` it stops running work as a shutdown instead (the session stays resumable, as when the process exits), and every update and event of that is sent before the answer. |
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

How a turn ended goes beyond the stop reason: the verification gate decides whether a turn may end as done (see
`docs/` on checks). The prompt response's `_meta["light-harness"]` and the `_light-harness/turn` notification (below)
carry `outcome` (`succeeded`, `unresolved`: done but the project's checks still fail, `failed`, `interrupted`), the
gate's `verification` (`passed` with the evidence, `not_needed`, `not_configured`, or `unresolved` with the reason
and the failing checks), and the files the turn changed. On `session/load` every earlier turn's ending is replayed
as a `_light-harness/turn` notification marked `replay: true`, after that turn's updates.

Permission requests: the agent's tools read, write and run commands in the session's directory on their own, as they
do in the CLI, and never ask. The one question the agent asks is the hand-edit question of an undo or redo
(`_light-harness/revert`, below): `session/request_permission` with options `overwrite` (allow once), `keep` (allow
once: restore the rest) and `cancel` (reject once). Its `toolCall` names the files (`locations`) and says what
overwriting means; `_meta["light-harness"] = { command, plan, handEdited }` has the whole plan. A cancelled request
changes nothing.

## What is not supported (yet)

- Images and audio in prompts (`promptCapabilities.image` is false), and binary embedded resources.
- MCP servers: the ones a client passes in `session/new` are ignored, with a line in the log.
- The client's file system and terminal methods (`fs/*`, `terminal/*`): tools run inside the agent.
- Session modes, plans, slash commands (`available_commands_update`), `logout`, additional directories, and system
  prompt overrides.
- The files an earlier turn changed are not replayed (`changedFiles: null`): the list is computed from snapshots
  when a turn ends and not stored, and the engine has no operation to compute it later.
- ACP v2. The SDK's v2 is an experimental draft whose prompt turn works differently (a prompt is answered once it is
  inserted and completion is a `state_update`), so serving it means a second set of handlers rather than a flag.

## The command line is an ACP client

`lh` itself talks to the engine only through this protocol: it starts `lh acp` as a child process (in its own
process group, so Ctrl-C reaches the CLI, which sends `session/cancel`) and is a client like any editor. Whatever
the CLI can do, a client can do. `--engine direct` runs the engine in the CLI's own process instead (for debugging,
and as the reference the protocol path is tested against); `--engine acp-memory` runs the same server in-process
over in-memory streams. Starting the child costs about 0.2 s before the first event (measured on a two-core
aarch64 machine: a median of 190–250 ms to the first event directly against 365–510 ms through the child).

| CLI feature | Protocol |
| --- | --- |
| Rendering every event (`--json` prints them as they are) | `_light-harness/event` notifications, asked for at `initialize` (below); standard updates switched off |
| A new session with `--model`, `--effort` | `session/new` with `_meta["light-harness"] = { model, effort }` |
| `--session <id or start of one>`, `--continue` | `_light-harness/resolve`, then `session/resume` with `_meta["light-harness"] = { model, effort, archived: true }` |
| Recovery of a session whose process died | The events `session/resume` appended (the crashed step settled, the claim recovered) arrive as live events before its answer |
| The prompt, a steer, `/queue` | `_light-harness/steer` / `_light-harness/queue` (answered once admitted, with the message ID); the turn's end is its `execution.*` event |
| `--max-steps` | `maxSteps` on `_light-harness/steer` and `_light-harness/queue` (`_meta["light-harness/maxSteps"]` on `session/prompt`) |
| Ctrl-C (first press) | `session/cancel` |
| Exit while working (`/exit`, SIGTERM, Ctrl-C at the prompt, a closed pipe) | `session/close` with `_meta["light-harness"].shutdown`, then the connection is closed and `lh acp` exits |
| `/undo`, `/redo` | `_light-harness/revert`, `_light-harness/undo_revert`: a dry run first, then `handEdits: "ask"`; the hand-edit question is `session/request_permission` |
| The three turn endings and exit code 3 | `execution.succeeded`'s `verification` in the events; for other clients `_light-harness/turn` and the prompt response's `_meta` |
| The files a turn changed | the `workspace.changes` event; for other clients `changedFiles` in `_light-harness/turn` |
| Diagnostics | the `diagnostic` event; for other clients `_light-harness/diagnostic`, and a `notice` to clients that show them |
| `--list-sessions` | `session/list` (all pages) |
| `--models` | `_light-harness/models` |
| Not signed in, an unknown model or session, a session in use | errors with `data["light-harness"] = { reason, message, holderPid? }`; the CLI prints `message` |

Engine operations a client can use that the CLI does not: `_light-harness/withdraw` (take back an undelivered
message), `_light-harness/unarchive`, `_light-harness/session` (state), `_light-harness/events` (the stored log).

When `lh acp` dies under a turn, the CLI says so on stderr, names the session to open again, and exits with 1; the
next open of that session recovers it through the engine's crash recovery. A server that does not answer
`initialize` within 20 seconds (`LH_ENGINE_START_TIMEOUT_MS`), exits first (its last log line is shown), or does not
offer `_light-harness/event` is reported in one line, exit code 1.

## Extensions

Advertised in `initialize` as `agentCapabilities._meta["light-harness"] = { methods, notifications, promptMeta,
clientMeta, openMeta }`.

**Full fidelity: the harness's own events.** A client that renders the harness's events itself (the CLI does) asks
for them in `initialize`:

```ts
clientCapabilities._meta["light-harness"] = {
  events: true,    // send every harness event as _light-harness/event
  updates: false   // optional: send no standard session/update at all (default true: both)
}
```

Then every event of every session the client opened arrives as **`_light-harness/event`** (notification):
`{ sessionId, event, replay? }`. `event` is the harness's event as is, durable (with `seq` and `time`) or ephemeral
(streaming deltas, tool progress, check progress, `workspace.changes`, `diagnostic`), the same JSON `lh --json`
prints, in the order the engine produced them, before the answer of the request they belong to. A new session's
stream starts at `session.created`; `session/load` sends the stored log first, marked `replay: true`, then the
events the open appended (a crashed claim's recovery) unmarked; `session/resume` sends only the latter. Clients that
do not ask get the standard updates exactly as before, and none of this.

**`_light-harness/turn`** (notification): how a turn ended, live and replayed.

```ts
{
  sessionId: string,
  executionId: string,
  outcome: "succeeded" | "unresolved" | "failed" | "interrupted",
  stopReason: string,               // a session/prompt stop reason, or "error"
  verification?: object,            // execution.succeeded's verification: { status: "passed", evidence } | { status: "not_needed" }
                                    //   | { status: "not_configured" } | { status: "unresolved", reason, failing, acknowledgement, evidence }
  message?: string,                 // failed: why
  reason?: "user" | "shutdown",     // interrupted: by whom
  changedFiles: string[] | null,    // null on a replay, or when no snapshot could tell
  continues?: true,                 // the turn ended inside the execution because a queued message waited for it
  replay?: true
}
```

The `session/prompt` response carries the same object, without `sessionId`, as `_meta["light-harness"]`.

**`_light-harness/revert`** and **`_light-harness/undo_revert`** (requests): go back to before a user message (the
latest by default), the files and the conversation, and undo that. Only while the session is idle.

```ts
// params
{
  sessionId: string,
  messageId?: string,     // revert only
  dryRun?: boolean,       // say what would happen, change nothing
  handEdits?: "ask" | "abort" | "overwrite" | "keep"   // default "ask": session/request_permission when files were edited by hand
}
// result: the engine's RevertResult
{ kind: "preview", plan } | { kind: "reverted", plan, restore } | { kind: "hand_edited", plan }   // nothing changed (also when the question was declined)
  | { kind: "refused", reason: "busy" | "nothing_to_revert" | "not_found" | "compacted", message } | { kind: "failed", plan, message }
// plan: { fromSeq, messageId, messages, target, unrestorable, changes: { path, status, handEdited }[], kept }
```

**`_light-harness/withdraw`** (request) `{ sessionId, messageId }` → `{ withdrawn: boolean }`: takes back a message
that was admitted and not delivered yet (`inbox.cancelled`); `false` when it was delivered or is unknown.

**`_light-harness/unarchive`** (request) `{ sessionId }` → `{}`: puts a deleted (archived) session back in the
listing.

**`_light-harness/session`** (request) `{ sessionId }` → `{ sessionId, state, cwd, title, model, effort, archived,
updatedAt, lastSeq, inbox: { messageId, delivery }[], canUndo, canRedo }` for a session open on this connection.

**`_light-harness/events`** (request) `{ sessionId, afterSeq?, limit? }` → `{ events }`: the stored log, also of a
session another process is working in.

**`_light-harness/resolve`** (request) `{ cwd, session? }` → `{ sessionId, cwd }`: the session an ID or a unique
start of one names, or, without `session`, the latest in `cwd`. Refused when signed out, as session creation is.

**`_light-harness/diagnostic`** (notification) `{ sessionId, kind, message }`: something the engine noticed that is
not part of the log (`prefix_violation`, `internal_error`, `tool_crashed`, `listener_failed`).

**Errors.** Every error the server answers for a reason a client may act on has
`data["light-harness"] = { reason, message, holderPid? }`, `message` being the harness's own sentence:
`auth_required` (`-32000`), `session_in_use` (`-32603`, with the holder's process ID), `session_not_found`
(`-32002`), `ambiguous_session` and `unknown_model` (`-32602`), `schema_mismatch` (a session written by another
version), `model_list_failed`, `execution_failed` (a failed turn, with `providerError`), `closed`.

**`session/prompt` `_meta["light-harness/delivery"]`**: `"steer"` (the default) or `"queue"`. A queued prompt waits
until the agent would otherwise stop, then gets its own answer in the same turn.

**`_light-harness/steer`** (request) and **`_light-harness/queue`** (request): admit input without waiting for the
turn. The message is shown as a `user_message_chunk` where it lands. If the session is idle, it starts a turn; its end
is reported by `_light-harness/state` and `_light-harness/turn`.

```ts
// params
{ sessionId: string, prompt: ContentBlock[], maxSteps?: number }   // the same content blocks as session/prompt
// result
{ messageId: string }                           // the ID the message has once delivered
```

**`_light-harness/models`** (request): the models and efforts the account offers, asked for afresh; when they cannot
be listed, an error with the reason (`auth_required` or `model_list_failed`).

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
