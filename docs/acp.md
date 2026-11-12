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
| `session/new` | A session in the client's `cwd` (an absolute directory). The response carries the config options below. `_meta["light-harness"] = { model, effort }` starts it with those settings, the model checked against the account's models first (an unknown one is refused with `-32602` and the list of valid ones). `approval` (`ask`, `auto`, `full`), `unattended` (`deny`, `stop`), `attended` (default `true`) and `children` (default: as `attended`) in the same object say how tool calls are approved (see "Approval" below); they are read on `session/load` and `session/resume` too. |
| `session/load` | Replays the whole stored conversation as `session/update`s (user messages, reasoning, text, tool calls with their final status), then reports the title (`session_info_update`), the context use (`usage_update`), and the session's state (the `_light-harness/state` notification below), then answers. The `cwd` must be the session's own. |
| `session/resume` | The same without the replay. On load and resume, `_meta["light-harness"] = { model, effort }` switches the session to them (checked first, recorded as `settings.changed`), and `archived: true` opens an archived session too. |
| `session/list` | Sessions (not deleted), newest first, filtered by `cwd`, 100 per page. Each has `_meta["light-harness"] = { model, effort, archived? }`. With `_meta["light-harness"] = { archived: true }` archived sessions are listed too. The `title` is the session's own, or else derived from its first message (below). |
| `session/prompt` | Text, `resource_link` (named as `[file: /path]` or `[link: uri]` so the model can open it) and embedded text `resource` (the text in a fenced block under the same header). The response is the stop reason of the turn, with how it ended under `_meta["light-harness"]` (below). `_meta["light-harness/maxSteps"]` sets the step limit of the turn the prompt starts. |
| A prompt while the agent works | Steers it: the message reaches the model at the next step boundary (after the running tool calls), in the same turn. Every prompt the turn took in is answered when it ends, with the same stop reason. |
| `session/cancel` | Prompts not yet delivered are withdrawn and answered `cancelled` at once; the running turn is interrupted (commands are stopped) and its prompt is answered `cancelled` after its last update. A prompt sent right after a cancel starts the next turn. |
| `session/close` | Cancels, then frees the session in the agent. With `_meta["light-harness"] = { shutdown: true }` it stops running work as a shutdown instead (the session stays resumable, as when the process exits), and every update and event of that is sent before the answer. |
| `session/delete` | A soft delete: the session is archived and disappears from `session/list` and `session/load`; its log is kept. |
| `session/set_config_option` | Three select options: `model` (category `model`, the models the account offers), `effort` (category `thought_level`: `default` or the model's efforts) and `approval` (category `mode`: `ask`, `auto`, `full`). A model or effort change applies from the next step boundary, also in the middle of a turn, and is reported with `config_option_update`; an approval change applies from the next tool call. |

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
as a `_light-harness/turn` notification marked `replay: true`, after that turn's updates (and, for a client that
takes the harness's events, after that turn's events), with the files it changed worked out from its snapshots.

**Titles.** A session the user did not name gets a title without a model call: the first line of its first
message, trimmed, runs of spaces collapsed, shortened at a word to 60 characters with `…` (`deriveTitle` in
`packages/acp/src/extensions.ts`). It is what `session/list`, `session_info_update` (on load and resume, and live
when the first message arrives) and `_light-harness/session` report; nothing is written to the log.

## Approval

Before every tool call the harness decides whether it runs, runs in the sandbox, asks the user or is refused
(`docs/safety.md` says what each mode does). What a client sees and does:

- **The mode** is the `approval` config option, or `approval` in `_meta["light-harness"]` when the session is
  opened, or `_light-harness/approval` (below). It is the user's own choice for the session; a project
  configuration file can make it stricter and never looser, and the option's `currentValue` is the mode in force.
- **A question** is `session/request_permission`. Its `toolCall.toolCallId` is the call the client already shows
  (`<message>/<call>`), its `title` is the question ("Allow network access for this command?"), and its `content` is
  the command, path or tool verbatim followed by what the user needs to know to answer. The options are the
  question's choices under their own IDs: `once` (`allow_once`), `session` and `project` (`allow_always`: allowed
  for the rest of the session, or in this project for 30 days) and `deny` (`reject_once`). Each option's name says
  what it remembers, which is always a capability (network for sandboxed commands, writes under a directory), never
  the command. `_meta["light-harness"].approval = { messageId, callId, question, needs, then }` has the whole
  question: `question.choices[].remembers` in words, `needs` (what it is about) and `then` (how the call runs if
  approved: `{ kind: "run" }` or `{ kind: "run_sandboxed", network, writableRoots }`). The answer is the selected
  option; a `note` under `_meta["light-harness"]` of the response goes to the model with the result. A cancelled
  request, an option the question does not have and a client that cannot answer all decline.
- **While it waits** the call is `pending` with the title suffixed "(waiting for approval)", and the turn's prompt
  stays unanswered: the turn is waiting, not stuck. `session/cancel` withdraws the question (the call ends as
  "not started"); the client then answers its pending request with `cancelled`, as ACP asks. A prompt sent
  meanwhile is delivered after the step, as during any tool call. One question is pending at a time.
- **Nobody present.** A client that cannot answer says `attended: false` when it opens the session. A call that
  would ask is then refused at once and the model is told (`unattended: "deny"`, the default), or the turn ends
  (`"stop"`): the prompt is answered with an error whose `data["light-harness"].reason` is `approval_required`.
  Nothing waits either way.
- **Taint.** When content from outside (a file outside the workspace, a command that ran with the network, later a
  web or MCP tool) enters the conversation, `_light-harness/taint` `{ sessionId, tainted: true, text, source }` is
  sent once, and a `notice` to clients that show them. From then on anything that can send data out asks again.
  `_light-harness/clear_taint` is the user's "I trust what is there"; it is answered `{ cleared }` and followed by
  `_light-harness/taint` `{ tainted: false }`.
- **Notices.** `_light-harness/notice` `{ sessionId, kind, message }` says once what the user should know about how
  tools run here: `sandbox_unavailable` (why, and what would fix it), `approval_ignored` (a project setting that
  would have loosened the policy), `checks_not_run`.
- **A session that is loaded** replays an asked-and-answered call as the call with its final status and content.
  A client that takes the harness's events gets `approval.requested`, `approval.answered` and `approval.denied`
  with `replay: true`; it shows them as history and puts no question. No question is ever pending in a stored
  session: one that a process died under was settled as "not started" by recovery, and the model asks again.

**A subagent's question.** A session's subagents (the `subagent` tool) ask through their parent's client. A client
that is attended answers for them too, unless it opened the session with `children: false`; without someone to ask, a
subagent's call that would ask is refused as unattended. The question is a `session/request_permission` on the
**parent** session, like the parent's own, with these differences: `toolCall.toolCallId` is
`<subagent session>/<message>/<call>` (the call is the subagent's, not one the client shows for the parent), the
`title` is prefixed `Subagent "<first line of its task>": `, the content ends with "Asked by a subagent working on:
<task>", and `_meta["light-harness"].approval.subagent = { sessionId, title, spawnId, toolCallId }` names the subagent
(`toolCallId` is the parent's `subagent` call that started it, when this connection saw it start). The answer is the
selected option, as for any question; the server hands it to the subagent through its parent. A cancel of the parent
withdraws it: the parent's interrupt stops its subagents, and the request is answered `cancelled`. What the subagent
does is forwarded as it happens (`_light-harness/child`, or `child.event` in the events, below).

The other question the agent asks is the hand-edit question of an undo or redo (`_light-harness/revert`, below):
`session/request_permission` with options `overwrite` (allow once), `keep` (allow once: restore the rest) and
`cancel` (reject once). Its `toolCall` names the files (`locations`) and says what overwriting means;
`_meta["light-harness"] = { command, plan, handEdited }` has the whole plan. A cancelled request changes nothing.
A client tells the two apart by `_meta["light-harness"]`: `approval` or `plan`.

## What is not supported (yet)

- Images and audio in prompts (`promptCapabilities.image` is false), and binary embedded resources.
- MCP servers: the ones a client passes in `session/new` are ignored, with a line in the log.
- The client's file system and terminal methods (`fs/*`, `terminal/*`): tools run inside the agent.
- Session modes, plans, slash commands (`available_commands_update`), `logout`, additional directories, and system
  prompt overrides.
- A subagent's history on `session/load`: what a parent forwards is not stored in its log, so a loaded session shows
  its `subagent` calls and their results only. The subagent's own log is `_light-harness/events` of its session (the
  TUI reads it when such a row is expanded).
- Renaming a session: the engine has no operation that appends `session.renamed` (it would be
  `EngineSession.rename(title)`), so `_light-harness/rename` is not offered and titles are derived (below).
- Compaction on request: the engine compacts only when its policy says so and has no operation to ask for one
  (`EngineSession.compact()`), so `_light-harness/compact` is not offered.
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
| `--approval`, `--unattended`, and whether anyone is at the terminal | `approval`, `unattended` and `attended` in `_meta["light-harness"]` on `session/new` and `session/resume`. Only the interactive mode is attended: a one-shot run, `--json` and a pipe are not |
| A tool call's approval question, answered at the prompt | `session/request_permission` with `_meta["light-harness"].approval`; the answer is the option, and what the user typed after it is the `note` |
| `/clear-taint` | `_light-harness/clear_taint` |
| Exit code 4 (`--unattended stop`) | `execution.failed` with `cause: "approval"` in the events; for other clients the prompt's error with `reason: "approval_required"` |
| Ctrl-C (first press) | `session/cancel` |
| Exit while working (`/exit`, SIGTERM, Ctrl-C at the prompt, a closed pipe) | `session/close` with `_meta["light-harness"].shutdown`, then the connection is closed and `lh acp` exits |
| `/undo`, `/redo` | `_light-harness/revert`, `_light-harness/undo_revert`: a dry run first, then `handEdits: "ask"`; the hand-edit question is `session/request_permission` |
| The three turn endings and exit code 3 | `execution.succeeded`'s `verification` in the events; for other clients `_light-harness/turn` and the prompt response's `_meta` |
| The files a turn changed | the `workspace.changes` event; for other clients `changedFiles` in `_light-harness/turn` |
| Diagnostics | the `diagnostic` event; for other clients `_light-harness/diagnostic`, and a `notice` to clients that show them |
| `--list-sessions` | `session/list` (all pages), with the derived titles |
| `lh fork [<session>]` (`--through`, `--copy`, `--copy-to`, `--model`, `--effort`, `--title`) | `_light-harness/resolve`, then `_light-harness/fork`; the fork is continued with `--session` |
| `lh replay [<session>]` (the options of `scripts/replay.ts` but `--data-dir`) | `_light-harness/resolve`, then `_light-harness/replay`; progress from the replay session's events after `_light-harness/replay_started`, the report from the answer; Ctrl-C is `session/cancel` of the replay session |
| A subagent's question, labelled with its task | `session/request_permission` with `_meta["light-harness"].approval.subagent`; the CLI answers for subagents only where it is attended |
| A subagent's tool calls, one indented line each | `child.event` in the events |
| `--models` | `_light-harness/models` |
| `/approval [ask\|auto\|full]` | `session/set_config_option` `approval`, then `_light-harness/approval` for the mode in force |
| `/diff` | `_light-harness/diff` for the latest turn |
| The sandbox marker on a command (`⊡`, `+network`, `+write <dir>`, "no sandbox") | `tool.started`'s `run.sandbox` in the events |
| Not signed in, an unknown model or session, a session in use | errors with `data["light-harness"] = { reason, message, holderPid? }`; the CLI prints `message` |

Engine operations a client can use that the CLI does not: `_light-harness/withdraw` (take back an undelivered
message), `_light-harness/unarchive`, `_light-harness/session` (state), `_light-harness/events` (the stored log).

When `lh acp` dies under a turn, the CLI says so on stderr, names the session to open again, and exits with 1; the
next open of that session recovers it through the engine's crash recovery. A server that does not answer
`initialize` within 20 seconds (`LH_ENGINE_START_TIMEOUT_MS`), exits first, or does not offer `_light-harness/event` is
reported in one line, exit code 1. A server that exits first is "the engine could not start: <why> (its process exited
with code N)", `<why>` being its own last error line or the message of the uncaught error it died of; what it wrote
besides its log lines before it was ready (a runtime's source excerpt, stack and banner) is not shown.

A CLI killed outright (SIGKILL) leaves its `lh acp` finishing its shutdown on its own, holding its session for up to
the server's shutdown limit (5 s). When the next `lh --session` or `--continue` finds the session held by such a
server (an `acp` process whose client is gone: its parent is init or a subreaper, read from `/proc`), it says so and
waits for it ("the session is still held by the engine of an earlier run that was stopped (pid N); waiting for it to
finish shutting down…"), then opens the session. A session held by anything else is refused at once, as before.

## The client library

Both terminal clients (`lh` and `lh tui`) use one protocol client, `@light-harness/acp/client`
(`packages/acp/src/client.ts`), and another client can too. It lives in this package because it is the protocol's
other half: it depends on the SDK and on `extensions.ts`, never on a client, so nothing depends back on it.

- `HarnessConnection.start({ transport, clientInfo, log?, startTimeoutMs? })` starts `lh acp` as a child process
  (`{ kind: "child", command, env }`, its own process group, its stderr parsed into log lines) or the server in the
  same process (`{ kind: "memory", harness }`, for tests), and negotiates the harness's events
  (`events: true, updates: false`). It refuses a server that does not offer them, with a sentence.
- A connection serves any number of sessions: `newSession`, `resolve`, `openSession` (load or resume),
  `listSessions`, `listModels`, `storedEvents`, `unarchive`. Listings never stop a server in use; `stop()` does.
- A `ClientSession` has `events` (typed harness events with `replay`) or `items` (the events and the session's
  notifications: turn endings, state, usage, taint, notices, in arrival order), `send` (steer or queue), `cancel`,
  `setConfig`, `revert`, `undoRevert`, `withdraw`, `state`, `approval`, `clearTaint`, `diff`, `close`, and the
  features a server may lack behind `offers(method)` (`rename`, `compact`).
- `fork(params)` (`_light-harness/fork`; nothing is opened) and `replay(params, { cwd, onStart })`
  (`_light-harness/replay`): `onStart` gets the replay session as a `ClientSession` as soon as
  `_light-harness/replay_started` names it, so its `events` are the progress and its `cancel()` ends the replay; the
  promise resolves with the report, and the replay session's events end with it.
- `openWhenReleased(open, waiting)` runs an open again while the session is held by a server that is winding down
  (`windingDown(pid)`), up to `WINDING_DOWN_MS`; `lastWords(lines)` is how a dead server's reason is picked.
- Permission requests are routed to the session they are about: `approver(ask, signal)` gets the whole approval
  question (choices with what each remembers, `needs`, `then`, and for a subagent's question `subagent`, the first
  line of its task, and `subagentSessionId`), and
  `handEdits(ask, signal)` the hand-edit question of an undo. `cancel()` answers a pending question `cancelled`
  once the server has withdrawn it (its interrupt is in the log), and aborts `signal` so the client can close it.
- Errors are `ClientError`s with the server's `reason` (`auth_required`, `session_in_use`, `session_not_found`,
  ..., `closed` when the server is gone or never started); `lost()` says how a server went away.
- `HarnessClient` wraps a connection that can be made again (`reconnect()`), for the TUI's `/reconnect`.

## Extensions

Advertised in `initialize` as `agentCapabilities._meta["light-harness"] = { methods, notifications, promptMeta,
clientMeta, openMeta, permissionRequests }`.

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
  changedFiles: string[] | null,    // also on a replay (from the turn's snapshots); null when no snapshot could tell
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

**`_light-harness/diff`** (request): the files a turn or a step changed, with bounded per-file patches, from the
workspace snapshots the engine recorded around it (`snapshot.taken`). A turn runs from the workspace as it was when
its first message was delivered to the last snapshot before it ended; a step from its `step_start` to its
`step_end`. Read from the stored log, so it works for any session, also one this connection did not open.

```ts
// params
{ sessionId: string, executionId?: string, messageId?: string, patch?: boolean }  // a turn (the latest by default) or a step (its assistant message); patch: false lists files only
// result
{ available: true, scope: "turn" | "step", executionId: string | null, messageId: string | null, from: string, to: string,
  files: { path, status: "added" | "deleted" | "modified" | "mode_changed" | "type_changed", binary: boolean,
           patch: string | null, truncated: boolean, omitted: boolean, added: number, removed: number }[] }
| { available: false, reason: "not_found" | "no_snapshots" | "unavailable", message: string }
```

Patches are cut at 32 KiB per file (`truncated`) and 256 KiB in all (later files `omitted`); a file git finds
binary has `binary: true` and no patch. `no_snapshots`: nothing around it could change files (a step of reads), or
snapshots were off. `unavailable`: the snapshot store cannot be read (no git, or the snapshots were pruned).

**`_light-harness/fork`** (request): a new session with the history of another up to a step boundary
(`Engine.forkSession`). The parent is only read: it may be open on this connection, in another process, or nowhere.
The fork is let go of once it is made; open it (`session/load` or `session/resume`) to work in it, here or elsewhere.
It is listed like any session; its title is the parent's with " (fork)" unless one is given.

```ts
// params
{
  sessionId: string,                            // the parent
  throughSeq?: number,                          // the last event it inherits, a step boundary; default the latest boundary
  workspace?: "shared" | { copyTo?: string },   // default "shared" (the parent's directory); {}: a copy under <data dir>-work/workspaces/<fork>
  model?: string, effort?: string | null,       // default the parent's; checked against the account's models
  title?: string | null
}
// result
{ sessionId, parentSessionId, throughSeq, cwd, copiedFrom: string | null, title: string | null, model, effort: string | null }
```

A fork point inside a step, or anything else the engine cannot do as asked, is `-32602` with
`data["light-harness"].reason = "invalid_request"` and the engine's sentence; an unknown parent is `-32002`.

**`_light-harness/replay`** (request): replays a recorded session against a changed baseline (`Engine.replaySession`,
`docs/replay.md`). The real model is called; every tool call that is on the recording is answered from it. The
answer comes when the replay is over; meanwhile the replay session is shown on this connection like any session:
**`_light-harness/replay_started`** (notification) `{ sessionId, sourceSessionId, ref }` names it first, then its
events (`_light-harness/event` for a client that takes them, standard updates otherwise) follow under its ID, and
`session/cancel` on it (or `$/cancel_request` of the replay request) ends the replay as `incomplete`. It is let go of
when the replay ends; it is not listed, and its log stays readable (`_light-harness/events`). Refused when signed out.

```ts
// params
{
  sessionId: string,                                  // the recording
  policy?: "stop" | "execute-read-only" | "execute",  // default "stop"
  systemPrompt?: string, toolDescriptions?: Record<string, string>,
  model?: string, effort?: string | null,             // null: the model's default
  strict?: boolean, throughSeq?: number,
  workspace?: string,                                 // where the copy is made, for the policies that run tools
  ref?: string                                        // echoed in replay_started
}
// result
{ sourceSessionId, sessionId /* the replay session */, policy, workspace: string | null, requests: number,
  usage: { inputTokens, cachedInputTokens, outputTokens, reasoningTokens } | null,
  report: ReplayReport,     // status: "identical" | "diverged" | "unsupported" | "incomplete", reason, divergence, ...
  text: string }            // the report as the harness prints it
```

**`_light-harness/child`** (notification): one durable event of a subagent of a session open on this connection, as
the engine forwards it, for a client that does not take the harness's events. A client that does gets the same as
`child.event` inside `_light-harness/event` (`{ type: "child.event", sessionId, child, spawnId, title, event }`) and
no `_light-harness/child`. Nothing of it is stored in the parent: the subagent's own log is the record.

```ts
{
  sessionId: string,          // the parent
  childSessionId: string,     // the subagent's own session (also under the name sessionId in approval.subagent)
  title: string,              // the first line of its task
  spawnId: string,
  toolCallId: string | null,  // the parent's subagent call that started it (<message>/<call>), when seen here
  event: object               // the subagent's stored event, as in its own log
}
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

**`_light-harness/approval`** (request) `{ sessionId, mode?, unattended?, attended? }` → `{ sessionId, enabled, mode,
unattended, attended, sandboxUnavailable: { reason, remedy } | null, tainted, taint, ignored }`: how the session's
tool calls are approved, after setting the fields the request names. `ignored` lists project settings that would
have loosened the user's policy.

**`_light-harness/clear_taint`** (request) `{ sessionId }` → `{ cleared: boolean }`.

**`_light-harness/taint`** (notification) `{ sessionId, tainted, text?, source?, replay? }` and
**`_light-harness/notice`** (notification) `{ sessionId, kind, message }`: see "Approval" above.

**Errors.** Every error the server answers for a reason a client may act on has
`data["light-harness"] = { reason, message, holderPid? }`, `message` being the harness's own sentence:
`auth_required` (`-32000`), `session_in_use` (`-32603`, with the holder's process ID), `session_not_found`
(`-32002`), `ambiguous_session`, `unknown_model` and `invalid_request` (`-32602`), `schema_mismatch` (a session written by another
version), `model_list_failed`, `execution_failed` (a failed turn, with `providerError`), `approval_required` (a turn ended
because a call needed approval and nobody was present), `closed`.

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
