# Using Windlass from an editor (ACP)

Windlass speaks the [Agent Client Protocol](https://agentclientprotocol.com) version 1 on stdin and stdout, so an
editor or any other ACP client can start it as its agent. (The display name, the `windlass` binary and the `_windlass`
extension prefix below all come from `packages/core/src/brand.ts`; they change with it.)

## Start it

The client runs this command and talks to it over stdio:

```
windlass acp
```

From a checkout, without installing the binary, point the client at Bun and the CLI entry point:

```json
{
  "command": "bun",
  "args": ["/path/to/light-harness/packages/cli/src/main.ts", "acp"]
}
```

For Zed, for example, that object goes under `agent_servers."windlass"` in `settings.json`.

Before the first session, sign in with your ChatGPT plan on the same machine (`bun scripts/login.ts start` in the
checkout, then finish the sign-in it prints). When you are not signed in, creating or loading a session fails with
ACP's auth-required error (`-32000`) and a message that says this; the client's "authenticate" button only re-checks.
Listing sessions, reading a session's log, resolving a session ID and forking need no sign-in.

Sessions are stored one file each, and a process holds only the sessions it is working in. While `windlass acp` runs, an
`windlass` in another terminal works in its own sessions, and so does a second editor. A session is open in one place at a
time: loading one that another process is working in fails with an error that names that process (`data` carries
`reason: "session_in_use"` and `holderPid` under the extension key), and it loads once that process has closed it
or exited. Sessions are shared otherwise, so a session started in the editor can be resumed with
`windlass --session <id>` later. The server is built from the same assembly as the command line (`createHarness` in
`@windlass/core`) and does everything through the engine: `session/close` closes that one session,
`session/delete` archives it, `session/cancel` withdraws prompts that were not delivered yet.

Logs go to stderr (editors keep them as the agent's log); nothing but protocol messages is written to stdout. Set
`WINDLASS_ACP_LOG=debug` for more. The engine's own warnings (its diagnostics, notices about the data directory) are logged at
`warn`. Closing the connection, or SIGTERM, SIGINT or SIGHUP, stops running work as a shutdown:
every command the agent started is stopped, and the session resumes later where it was cut off.

## What is supported

| ACP | How Windlass does it |
| --- | --- |
| `initialize` | Protocol version 1. Capabilities: `loadSession`, embedded text context in prompts, `sessionCapabilities` `list`, `resume`, `close`, `delete`. One auth method, "Sign in with ChatGPT". |
| `authenticate` | Checks the saved sign-in; succeeds if it is usable, otherwise answers auth-required with how to sign in. There is no in-client browser flow. |
| `session/new` | A session in the client's `cwd` (an absolute directory). The response carries the config options below. `_meta["windlass"] = { model, effort }` starts it with those settings, checked against the account's models first (an unknown model is refused with `-32602` and the list of valid ones, an effort the model does not take with the ones it accepts). `agent` in the same object is the agent it starts as, by name (`"none"`: no agent; absent: the default of the user's configuration); a name that is no agent is refused with `-32602` and a sentence that suggests the near ones, and no session is created. `approval` (`ask`, `auto`, `full`), `unattended` (`deny`, `stop`), `attended` (default `true`) and `children` (default: as `attended`) in the same object say how tool calls are approved (see "Approval" below); they are read on `session/load` and `session/resume` too. |
| `session/load` | Replays the whole stored conversation as `session/update`s (user messages, reasoning, text, tool calls with their final status), then reports the title (`session_info_update`), the context use (`usage_update`), and the session's state (the `_windlass/state` notification below), then answers. The `cwd` must be the session's own. |
| `session/resume` | The same without the replay. On load and resume, `_meta["windlass"] = { model, effort }` switches the session to them (checked first, recorded as `settings.changed`), `agent` switches it to that agent (recorded as `agent.switched`; a refusal leaves the session closed), and `archived: true` opens an archived session too. |
| `session/list` | Sessions (not deleted), newest first, filtered by `cwd`, 100 per page. Each has `_meta["windlass"] = { model, effort, archived?, forkedFrom?, forkedThroughSeq? }` (a fork names the session it was forked from and the last event it inherited). With `_meta["windlass"] = { archived: true }` archived sessions are listed too. The `title` is the session's own, or else derived from its first prompt (below). Each page is read from the engine: `nextCursor` is a place in the order (when a session was last updated, then its ID), so the server keeps nothing between two pages, a session that arrives meanwhile is in no later page, and none is listed twice; a new listing has it at the front. A cursor the server did not give is refused with `-32602`. |
| `session/prompt` | Text, `resource_link` (named as `[file: /path]` or `[link: uri]` so the model can open it) and embedded text `resource` (the text in a fenced block under the same header). The response is the stop reason of the turn, with how it ended under `_meta["windlass"]` (below). `_meta["windlass/maxSteps"]` sets the step limit of the turn the prompt starts. |
| A prompt while the agent works | Steers it: the message reaches the model at the next step boundary (after the running tool calls), in the same turn. Every prompt the turn took in is answered when it ends, with the same stop reason. |
| `session/cancel` | Prompts not yet delivered are withdrawn and answered `cancelled` at once; the running turn is interrupted (commands are stopped) and its prompt is answered `cancelled` after its last update. A prompt sent right after a cancel starts the next turn. |
| `session/close` | Cancels, then frees the session in the agent. With `_meta["windlass"] = { shutdown: true }` it stops running work as a shutdown instead (the session stays resumable, as when the process exits), and every update and event of that is sent before the answer. |
| `session/delete` | A soft delete: the session is archived and disappears from `session/list` and `session/load`; its log is kept. |
| `session/set_config_option` | Four select options: `model` (category `model`, the models the account offers), `effort` (category `thought_level`: `default` or the model's efforts), `approval` (category `mode`: `ask`, `auto`, `full`) and, where agents are defined, `agent` (category `_agent`: `none` or an agent's name). A model or effort change applies from the next step boundary, also in the middle of a turn, and is reported with `config_option_update`; an approval change applies from the next tool call. An effort the model does not take is refused with `-32602`, `reason: "unknown_effort"` and one sentence that names the ones it accepts. |

Stop reasons: `end_turn`; `max_turn_requests` when the turn reached its step limit; `max_tokens` when the last
response hit the output limit; `refusal` when the provider refused; `cancelled`. A turn that fails answers the prompt
with an error instead (v1 has no error stop reason): `-32000` when the sign-in was rejected, otherwise `-32603` with
the harness's sentence, such as "The model call failed 4 times: ...", and `data["windlass"] = { reason:
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
stopped before reporting (check before repeating it). `_meta["windlass/outcome"]` on the final update always holds
the harness outcome: `success`, `error`, `not_started` or `effect_unknown`.

IDs are stable: a user message has the harness message ID, agent text and reasoning are `<message>:t<n>` and
`<message>:r<n>`, a tool call is `<message>/<call>`. A replay uses the same IDs as the live turn.

How a turn ended goes beyond the stop reason: the verification gate decides whether a turn may end as done (see
`docs/` on checks). The prompt response's `_meta["windlass"]` and the `_windlass/turn` notification (below)
carry `outcome` (`succeeded`, `unresolved`: done but the project's checks still fail, `failed`, `interrupted`), the
gate's `verification` (`passed` with the evidence; `not_needed`, with `unverified: true` when files the checks cover
changed outside the turn and are still to be checked; `not_configured`; `left_to_parent` for a subagent, whose checks
are its parent's turn's; or `unresolved` with the reason and the failing checks), and the files the turn changed. On `session/load` every earlier turn's ending is replayed
as a `_windlass/turn` notification marked `replay: true`, after that turn's updates (and, for a client that
takes the harness's events, after that turn's events), with the files it changed worked out from its snapshots.

**Titles.** A session the user did not name gets a title without a model call: the first line of the first thing
the user said in it, trimmed, runs of spaces collapsed, shortened at a word to 60 characters with `…` (`sessionTitle`
and `deriveTitle` in `packages/acp/src/extensions.ts`). The engine keeps the beginning of that prompt with the
session's summary (`firstPrompt`), so a listing reads no log for a title. It is what `session/list`,
`session_info_update` (on load and resume, and live when the first message arrives) and `_windlass/session`
report; nothing is written to the log. A title the user gives (`_windlass/rename`) replaces it.

**Agents.** A session can run as an agent: a definition with its own instructions, restrictions on what it may
call, and optionally a model. `_windlass/agents` lists them; `agent` in `_meta["windlass"]` starts a
session as one; the `agent` config option switches (`none` switches it off). The switch is made at once while the
session is idle and at the next step boundary while a turn runs; its record is the `agent.switched` event
(`{ messageId, from, to }`, `to` being the definition as it was selected), and `config_option_update` follows it.
A call the agent's restrictions refuse fails like any refused call; for a client that takes the events it is
`approval.denied` with `reason: "policy"`, `agent: <name>` and `refusal: { rule, effect, text }`: which rule of the
agent refused it, the effect class the tool declares, and the engine's sentence for the user (`The agent "reviewer"
may use only tools that read. "write" changes files.`), which a client shows as it is rather than the approval
policy's words. The call's part in the session's state carries the same `refusal`. Definitions that could not be used are
in `_windlass/agents` (`problems`) and arrive as `diagnostic`s of kind `agents`. What the engine says about agents
while it creates the session (an agent that names a tool that does not exist, a project's `agents.default` that
was not followed) is kept for the session's first listener, so a client that subscribes after `session/new` gets it.

**The task list.** The model keeps a task list with the `todo` tool; each call replaces the list. The call's
`rawOutput.display.todo` is `{ items: { text, status }[], counts }` (`status`: `pending`, `in_progress`, `done`),
which a client shows as a checklist instead of a tool call. The list as it stands (reverted turns left out) is
`todos` in `_windlass/session`.

## Approval

Before every tool call the harness decides whether it runs, runs in the sandbox, asks the user or is refused
(`docs/safety.md` says what each mode does). What a client sees and does:

- **The mode** is the `approval` config option, or `approval` in `_meta["windlass"]` when the session is
  opened, or `_windlass/approval` (below). It is the user's own choice for the session; a project
  configuration file can make it stricter and never looser, and the option's `currentValue` is the mode in force.
- **A question** is `session/request_permission`. Its `toolCall.toolCallId` is the call the client already shows
  (`<message>/<call>`), its `title` is the question ("Allow network access for this command?"), and its `content` is
  the command, path or tool verbatim followed by what the user needs to know to answer. The options are the
  question's choices under their own IDs: `once` (`allow_once`), `session` and `project` (`allow_always`: allowed
  for the rest of the session, or in this project for 30 days) and `deny` (`reject_once`). Each option's name says
  what it remembers, which is always a capability (network for sandboxed commands, writes under a directory), never
  the command. `_meta["windlass"].approval = { messageId, callId, question, needs, then }` has the whole
  question: `question.choices[].remembers` in words, `needs` (what it is about) and `then` (how the call runs if
  approved: `{ kind: "run" }` or `{ kind: "run_sandboxed", network, writableRoots }`). The answer is the selected
  option; a `note` under `_meta["windlass"]` of the response goes to the model with the result. A cancelled
  request, an option the question does not have and a client that cannot answer all decline.
- **While it waits** the call is `pending` with the title suffixed "(waiting for approval)", and the turn's prompt
  stays unanswered: the turn is waiting, not stuck. `session/cancel` withdraws the question (the call ends as
  "not started"); the client then answers its pending request with `cancelled`, as ACP asks. A prompt sent
  meanwhile is delivered after the step, as during any tool call. One question is pending at a time.
- **Nobody present.** A client that cannot answer says `attended: false` when it opens the session. A call that
  would ask is then refused at once and the model is told (`unattended: "deny"`, the default), or the turn ends
  (`"stop"`): the prompt is answered with an error whose `data["windlass"].reason` is `approval_required`.
  Nothing waits either way.
- **Taint.** When content from outside (a file outside the workspace, a command that ran with the network, later a
  web or MCP tool) enters the conversation, `_windlass/taint` `{ sessionId, tainted: true, text, source }` is
  sent once, and a `notice` to clients that show them. From then on anything that can send data out asks again.
  `_windlass/clear_taint` is the user's "I trust what is there"; it is answered `{ cleared }` and followed by
  `_windlass/taint` `{ tainted: false }`.
- **Notices.** `_windlass/notice` `{ sessionId, kind, message }` says once what the user should know about how
  tools run here: `sandbox_unavailable` (why, and what would fix it), `approval_ignored` (a project setting that
  would have loosened the policy), `checks_not_run`; and about how a turn ended, `no_closing_answer` (the model did
  its work and then returned nothing twice, so the turn ended without a last word from it).
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
<task>", and `_meta["windlass"].approval.subagent = { sessionId, title, spawnId, toolCallId }` names the subagent
(`toolCallId` is the parent's `subagent` call that started it, when this connection saw it start). The answer is the
selected option, as for any question; the server hands it to the subagent through its parent. A cancel of the parent
withdraws it: the parent's interrupt stops its subagents, and the request is answered `cancelled`. What the subagent
does is forwarded as it happens (`_windlass/child`, or `child.event` in the events, below).

The other question the agent asks is the hand-edit question of an undo or redo (`_windlass/revert`, below):
`session/request_permission` with options `overwrite` (allow once), `keep` (allow once: restore the rest) and
`cancel` (reject once). Its `toolCall` names the files (`locations`), says who changed each as far as the engine can
tell (`handEditSentences` in `packages/acp/src/extensions.ts` words the plan's `editedBy`) and what overwriting means;
`_meta["windlass"] = { command, plan, handEdited }` has the whole plan. A cancelled request changes nothing.
A client tells the two apart by `_meta["windlass"]`: `approval` or `plan`.

## What is not supported (yet)

- Images and audio in prompts (`promptCapabilities.image` is false), and binary embedded resources.
- MCP servers: the ones a client passes in `session/new` are ignored, with a line in the log.
- The client's file system and terminal methods (`fs/*`, `terminal/*`): tools run inside the agent.
- Session modes, plans, `logout`, additional directories, and system prompt overrides.
- A subagent's history on `session/load`: what a parent forwards is not stored in its log, so a loaded session shows
  its `subagent` calls and their results only. The subagent's own log is `_windlass/events` of its session (the
  TUI reads it when such a row is expanded).
- ACP v2. The SDK's v2 is an experimental draft whose prompt turn works differently (a prompt is answered once it is
  inserted and completion is a `state_update`), so serving it means a second set of handlers rather than a flag.

## The command line is an ACP client

`windlass` itself talks to the engine only through this protocol: it starts `windlass acp` as a child process (in its own
process group, so Ctrl-C reaches the CLI, which sends `session/cancel`) and is a client like any editor. Whatever
the CLI can do, a client can do. `--engine direct` runs the engine in the CLI's own process instead (for debugging,
and as the reference the protocol path is tested against); `--engine acp-memory` runs the same server in-process
over in-memory streams. Starting the child costs about 0.2 s before the first event (measured on a two-core
aarch64 machine: a median of 190–250 ms to the first event directly against 365–510 ms through the child).

| CLI feature | Protocol |
| --- | --- |
| Rendering every event (`--json` prints them as they are) | `_windlass/event` notifications, asked for at `initialize` (below); standard updates switched off |
| A new session with `--model`, `--effort`, `--agent` | `session/new` with `_meta["windlass"] = { model, effort, agent }` |
| `--session <id or start of one>`, `--continue` | `_windlass/resolve`, then `session/resume` with `_meta["windlass"] = { model, effort, agent, archived: true }` |
| `/agent`, `/agent <name\|none>`, the agent on the session line | `_windlass/agents`; `session/set_config_option` `agent`; the switch is drawn from `agent.switched`; `agent` in `_windlass/session` |
| A call an agent refuses, with the engine's sentence about the agent's rule | `approval.denied` with `agent` and `refusal.text` in the events |
| The task list as a checklist; the current list of a resumed session | `tool.settled`'s `display.todo` in the events; `todos` in `_windlass/session` |
| `/rename <title>` | `_windlass/rename` |
| `/compact` | `_windlass/compact`; a compaction that was made is drawn from its `compaction.*` events, and the execution it ran under is not drawn as a turn |
| Recovery of a session whose process died | The events `session/resume` appended (the crashed step settled, the claim recovered) arrive as live events before its answer |
| The prompt, a steer, `/queue` | `_windlass/steer` / `_windlass/queue` (answered once admitted, with the message ID); the turn's end is its `execution.*` event |
| `--max-steps` | `maxSteps` on `_windlass/steer` and `_windlass/queue` (`_meta["windlass/maxSteps"]` on `session/prompt`) |
| `--approval`, `--unattended`, and whether anyone is at the terminal | `approval`, `unattended` and `attended` in `_meta["windlass"]` on `session/new` and `session/resume`. Only the interactive mode is attended: a one-shot run, `--json` and a pipe are not |
| A tool call's approval question, answered at the prompt | `session/request_permission` with `_meta["windlass"].approval`; the answer is the option, and what the user typed after it is the `note` |
| `/clear-taint` | `_windlass/clear_taint` |
| Exit code 4 (`--unattended stop`) | `execution.failed` with `cause: "approval"` in the events; for other clients the prompt's error with `reason: "approval_required"` |
| Ctrl-C (first press) | `session/cancel` |
| `/stop [<number>]` (in the TUI: Ctrl-X on the selected running call): one running tool call is stopped and the turn goes on | `_windlass/cancel_call`; the `tool.cancel_requested` event, then the call's `tool.settled` with what came of it |
| Exit while working (`/exit`, SIGTERM, Ctrl-C at the prompt, a closed pipe) | `session/close` with `_meta["windlass"].shutdown`, then the connection is closed and `windlass acp` exits |
| `/undo`, `/redo` | `_windlass/revert`, `_windlass/undo_revert`: a dry run first, then `handEdits: "ask"`; the hand-edit question is `session/request_permission` |
| The three turn endings and exit code 3 | `execution.succeeded`'s `verification` in the events; for other clients `_windlass/turn` and the prompt response's `_meta` |
| The files a turn changed | the `workspace.changes` event; for other clients `changedFiles` in `_windlass/turn` |
| Diagnostics | the `diagnostic` event; for other clients `_windlass/diagnostic`, and a `notice` to clients that show them |
| `--list-sessions` | `session/list` (all pages), with the derived titles |
| `windlass fork [<session>]` (`--through`, `--copy`, `--copy-to`, `--model`, `--effort`, `--title`) | `_windlass/resolve`, then `_windlass/fork`; the fork is continued with `--session` |
| `windlass replay [<session>]` (the options of `scripts/replay.ts` but `--data-dir`) | `_windlass/resolve`, then `_windlass/replay`; progress from the replay session's events after `_windlass/replay_started`, the report from the answer; Ctrl-C is `session/cancel` of the replay session |
| A subagent's question, labelled with its task | `session/request_permission` with `_meta["windlass"].approval.subagent`; the CLI answers for subagents only where it is attended |
| A subagent's tool calls, one indented line each | `child.event` in the events |
| `--models` | `_windlass/models` |
| `/mcp`, the question about a project's server, a server that failed to start | `_windlass/mcp`, `_windlass/mcp_approve`, `_windlass/mcp_changed` |
| `/hooks`, the question about a project's hook, how to approve it in a run with nobody to ask | `_windlass/hooks`, `_windlass/hook_approve`, `_windlass/hooks_changed` (and at once after a `diagnostic` of kind `hooks`) |
| `/lsp`, the question about a project's language server | `_windlass/lsp`, `_windlass/lsp_approve`, `_windlass/lsp_changed` (and at once after a `diagnostic` of kind `lsp`) |
| A call a hook refused, a note a hook added, a stop hook that sent the agent back, a turn that ended with one unsatisfied | the `hook.ran` events (before the `tool.settled`, the `stop_hook` message or the ending they belong to) and `hooks.unsatisfied` with `hooks.objections` (what each hook said that last time) on `execution.succeeded` and `turn.ended`; for other clients `_meta["windlass/hooks"]` on the settled call, a `notice`, and `hooks` in `_windlass/turn` |
| An edit that got diagnostics: how many, from which server | `tool.settled`'s `diagnostics`; for other clients `_meta["windlass/diagnostics"]` on the settled call |
| `/skills` | `_windlass/skills` |
| `/wakeups`, `/wakeups cancel`, `/wakeups secret`, a webhook's secret shown once when it is created | `_windlass/wakeups`, `_windlass/wake_cancel`, `_windlass/wake_secret` (after the `tool.settled` of `wake_create` whose `display.wake` is `{ action: "create", id }`) |
| `/wakeups add in <duration>\|at <time>\|every <duration>\|webhook <message>`, and `check <duration> "<command>" <message>` after the user was asked how the command may run; a webhook's address and secret shown once, on a terminal | `_windlass/wake_create` (the secret is in its answer) |
| `/watch <command id> [--regex] [--ignore-case] [--times <n>] <text>`, `/watch` (the running commands and their watches), `/watch remove <watch id>`; a firing drawn as the watch's message, not the user's | `_windlass/watch`, `_windlass/watches`, `_windlass/unwatch`; the `watch.started`, `watch.fired` and `watch.ended` events (the firing's message is the `inbox.enqueued` before it, with `origin: "background_watch"`) |
| `/memory`, `/remember`, `/forget`; a note written before the first message, kept and saved once the session has started | `_windlass/memory`, `_windlass/memory_change` (`deferred`), the `baseline.set` event |
| A question about a project's hook, language server or MCP server put before a message is sent | `_windlass/hooks`, `_windlass/lsp`, `_windlass/mcp` read before `_windlass/steer`; the message goes after the answers |
| The notice that a wake-up created in a one-prompt run will not fire there (in `--json`: a line of the CLI's own, `{ type: "cli.notice", kind: "wake_not_firing", sessionId, wakeId, message }`) | `_windlass/wakeups` (`running: false`) after the `tool.settled` of `wake_create` |
| `/name args` of a command file, its line in the transcript, the command files in `/help` and the palette | `_windlass/commands` (with the client's own commands as `builtins`), `_windlass/send_command`; the `command.expanded` event |
| `/approval [ask\|auto\|full]` | `session/set_config_option` `approval`, then `_windlass/approval` for the mode in force |
| `/diff` | `_windlass/diff` for the latest turn |
| The sandbox marker on a command (`⊡`, `+network`, `+write <dir>`, "no sandbox") | `tool.started`'s `run.sandbox` in the events |
| Not signed in, an unknown model or session, a session in use | errors with `data["windlass"] = { reason, message, holderPid? }`; the CLI prints `message` |

Engine operations a client can use that the CLI does not: `_windlass/withdraw` (take back an undelivered
message), `_windlass/unarchive`, `_windlass/session` (state), `_windlass/events` (the stored log).

When `windlass acp` dies under a turn, the CLI says so on stderr, names the session to open again, and exits with 1; the
next open of that session recovers it through the engine's crash recovery. A server that does not answer
`initialize` within 20 seconds (`WINDLASS_ENGINE_START_TIMEOUT_MS`), exits first, or does not offer `_windlass/event` is
reported in one line, exit code 1. A server that exits first is "the engine could not start: <why> (its process exited
with code N)", `<why>` being its own last error line or the message of the uncaught error it died of; what it wrote
besides its log lines before it was ready (a runtime's source excerpt, stack and banner) is not shown.

A CLI killed outright (SIGKILL) leaves its `windlass acp` finishing its shutdown on its own, holding its session for up to
the server's shutdown limit (5 s). When the next `windlass --session` or `--continue` finds the session held by such a
server (an `acp` process whose client is gone: its parent is init or a subreaper, read from `/proc`), it says so and
waits for it ("the session is still held by the engine of an earlier run that was stopped (pid N); waiting for it to
finish shutting down…"), then opens the session. A session held by anything else is refused at once, as before.

## The client library

Both terminal clients (`windlass` and `windlass tui`) use one protocol client, `@windlass/acp/client`
(`packages/acp/src/client.ts`), and another client can too. It lives in this package because it is the protocol's
other half: it depends on the SDK and on `extensions.ts`, never on a client, so nothing depends back on it.

- `HarnessConnection.start({ transport, clientInfo, log?, startTimeoutMs? })` starts `windlass acp` as a child process
  (`{ kind: "child", command, env }`, its own process group, its stderr parsed into log lines) or the server in the
  same process (`{ kind: "memory", harness }`, for tests), and negotiates the harness's events
  (`events: true, updates: false`). It refuses a server that does not offer them, with a sentence.
- A connection serves any number of sessions: `newSession`, `resolve`, `openSession` (load or resume),
  `listSessions`, `listModels`, `listAgents`, `listCommands`, `storedEvents`, `unarchive`. Listings never stop a server in use; `stop()` does.
- A `ClientSession` has `events` (typed harness events with `replay`) or `items` (the events and the session's
  notifications: turn endings, state, usage, taint, notices, MCP changes, in arrival order), `send` (steer or queue), `cancel`,
  `setConfig`, `revert`, `undoRevert`, `withdraw`, `state`, `approval`, `clearTaint`, `diff`, `mcp`, `approveMcp`,
  `skills`, `wakeups`, `createWake`, `cancelWake`, `wakeSecret`, `memory`, `memoryChange`, `agents`, `setAgent`, `rename`,
  `compact`, `commands`, `expandCommand`, `sendCommand`, `cancelCall`, `watchOutput`, `unwatchOutput`, `watches`, `close`. `offers(method)` says whether a server (of another version) has a method.
- `fork(params)` (`_windlass/fork`; nothing is opened) and `replay(params, { cwd, onStart })`
  (`_windlass/replay`): `onStart` gets the replay session as a `ClientSession` as soon as
  `_windlass/replay_started` names it, so its `events` are the progress and its `cancel()` ends the replay; the
  promise resolves with the report, and the replay session's events end with it.
- `openWhenReleased(open, waiting)` runs an open again while the session is held by a server that is winding down
  (`windingDown(pid)`), up to `WINDING_DOWN_MS`; `lastWords(lines)` is how a dead server's reason is picked.
- Permission requests are routed to the session they are about: `approver(ask, signal)` gets the whole approval
  question (choices with what each remembers, `needs`, `then`, and for a subagent's question `subagent`, the first
  line of its task, and `subagentSessionId`), one at a time per session (several subagents may ask at once; the rest
  wait their turn, and one that is withdrawn meanwhile is answered `cancelled` without being put), and
  `handEdits(ask, signal)` the hand-edit question of an undo. `cancel()` answers a pending question `cancelled`
  once the server has withdrawn it (its interrupt is in the log), and aborts `signal` so the client can close it.
- Errors are `ClientError`s with the server's `reason` (`auth_required`, `session_in_use`, `session_not_found`,
  ..., `closed` when the server is gone or never started); `lost()` says how a server went away.
- `HarnessClient` wraps a connection that can be made again (`reconnect()`), for the TUI's `/reconnect`.

## Extensions

Advertised in `initialize` as `agentCapabilities._meta["windlass"] = { methods, notifications, promptMeta,
commands, clientMeta, openMeta, permissionRequests }`.

**Full fidelity: the harness's own events.** A client that renders the harness's events itself (the CLI does) asks
for them in `initialize`:

```ts
clientCapabilities._meta["windlass"] = {
  events: true,    // send every harness event as _windlass/event
  updates: false   // optional: send no standard session/update at all (default true: both)
}
```

Then every event of every session the client opened arrives as **`_windlass/event`** (notification):
`{ sessionId, event, replay? }`. `event` is the harness's event as is, durable (with `seq` and `time`) or ephemeral
(streaming deltas, tool progress, check progress, `workspace.changes`, `diagnostic`), the same JSON `windlass --json`
prints, in the order the engine produced them, before the answer of the request they belong to. A new session's
stream starts at `session.created`; `session/load` sends the stored log first, marked `replay: true`, then the
events the open appended (a crashed claim's recovery) unmarked; `session/resume` sends only the latter. Clients that
do not ask get the standard updates exactly as before, and none of this.

**`_windlass/turn`** (notification): how a turn ended, live and replayed.

```ts
{
  sessionId: string,
  executionId: string,
  outcome: "succeeded" | "unresolved" | "failed" | "interrupted",
  stopReason: string,               // a session/prompt stop reason, or "error"
  verification?: object,            // execution.succeeded's verification: { status: "passed", evidence } | { status: "not_needed", unverified?: true }
                                    //   | { status: "not_configured" } | { status: "left_to_parent" }
                                    //   | { status: "unresolved", reason, failing, acknowledgement, evidence }
  hooks?: { unsatisfied: string[],  // stop hooks still objected after the agent had been sent back as often as a turn
            objections: { hook: string, text: string }[] },   // allows (hooks.maxStopRounds): the turn ended anyway, with
                                    //   these hooks unsatisfied; objections: what each said that last time, for the
                                    //   user (nobody was sent back with it; text is empty for a hook that gave no reason)
  message?: string,                 // failed: why
  reason?: "user" | "shutdown",     // interrupted: by whom
  changedFiles: string[] | null,    // also on a replay (from the turn's snapshots); null when no snapshot could tell
  continues?: true,                 // the turn ended inside the execution because a queued message waited for it
  replay?: true
}
```

The `session/prompt` response carries the same object, without `sessionId`, as `_meta["windlass"]`. An
execution that only compacted the conversation because the user asked (`_windlass/compact` while idle: no
message, no step) is no turn: no `_windlass/turn` is sent for it, live or replayed, and `TurnTracker`
(`packages/acp/src/turns.ts`) does not count it. A turn's model requests are its steps plus the `calls` of its
compactions (`compaction.ended` and `compaction.failed`: the summary requests sent, retries and the repair included).

**`_windlass/agents`** (request): the agents a session can run as, as the definitions are now.

```ts
// params: a session open on this connection, or a directory
{ sessionId: string } | { cwd: string }
// result
{
  available: boolean,              // false: this engine offers no agents
  agents: { name, description, path, scope: "project" | "config" | "user", model: string | null, effort: string | null,
            restrictions: string,  // what it may not do, in a sentence or two
            tag: "read only" | "restricted" | null }[],
  problems: { path, severity: "skipped" | "shadowed" | "warning", reason, name: string | null }[],
  default: string | null,          // the agent a new session runs as when none is named (the user's agents.default)
  ignored: string[],               // settings of the project's file about agents that were not followed
  current: string | null           // with sessionId: the agent the session runs as, or will from its next step
}
```

**`_windlass/rename`** (request) `{ sessionId, title }` → `{ title }`: gives the session a title
(`session.renamed`); the answer is the title as stored (trimmed, line breaks as spaces), sent after
`session_info_update`. An empty title is `-32602`.

**`_windlass/compact`** (request) `{ sessionId }` → the engine's `CompactResult`: compacts the conversation now,
as an automatic compaction would (`compaction.started` with `trigger: "manual"`). While a turn runs it is made at
the next step boundary and the turn carries on; while idle it runs under an execution of its own, which ends as
soon as the checkpoint is written. Answered when it is done, after its events:

```ts
{ kind: "compacted", tokensBefore: number, tokensAfter: number,   // the estimates of the next request, before and after
  source: "model" | "repaired" | "fallback", detail: string | null }
| { kind: "nothing", message: string }   // nothing worth compacting, and why; nothing was written
| { kind: "failed", message: string }    // it did not complete (interrupted, the session closed); history is unchanged
```

**`_windlass/revert`** and **`_windlass/undo_revert`** (requests): go back to before a user message (the
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
// plan: { fromSeq, messageId, messages, target, unrestorable, changes: { path, status, handEdited, editedBy? }[], kept }
// editedBy (there when handEdited): who changed the file outside the session's own work, as far as the snapshots tell:
//   { kind: "outside" } (you or another program), { kind: "session", sessionId: string | null } (while another
//   session, or with null several, worked in the directory), { kind: "unknown" } (while a command or the checks of
//   this session ran, and no call named the file: the command's own work, or the user's meanwhile)
```

**`_windlass/diff`** (request): the files a turn or a step changed, with bounded per-file patches, from the
workspace snapshots the engine recorded around it (`snapshot.taken`). A turn runs from the workspace as it was when
its first message was delivered to the last snapshot before it ended; a step from its `step_start` to its
`step_end`. A queued message is a turn of its own, so an execution can hold several: `endSeq`, the number of the
event that ended a turn (`turn.ended`, or its execution's terminal event), names one of them, and without it the
diff is of the latest turn of the execution named, or of the session. Read from the stored log, so it works for
any session, also one this connection did not open.

```ts
// params
{ sessionId: string, executionId?: string, endSeq?: number, messageId?: string, patch?: boolean }  // a turn (the latest by default) or a step (its assistant message); patch: false lists files only
// result
{ available: true, scope: "turn" | "step", executionId: string | null, messageId: string | null, from: string, to: string,
  files: { path, status: "added" | "deleted" | "modified" | "mode_changed" | "type_changed", binary: boolean,
           patch: string | null, truncated: boolean, omitted: boolean, added: number, removed: number }[] }
| { available: false, reason: "not_found" | "no_snapshots" | "unavailable", message: string }
```

Patches are cut at 32 KiB per file (`truncated`) and 256 KiB in all (later files `omitted`); a file git finds
binary has `binary: true` and no patch. `no_snapshots`: nothing around it could change files (a step of reads), or
snapshots were off. `unavailable`: the snapshot store cannot be read (no git, or the snapshots were pruned).

**`_windlass/fork`** (request): a new session with the history of another up to a step boundary
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

`parentSessionId` is the session the fork was made from, as the fork's lineage records it. It is the session the
request names unless that one is a fork itself and `throughSeq` lies in the history it inherited: such a point
belongs to the session it was forked from (or that one's parent), and the new session is a fork of that session.

A fork point inside a step, or anything else the engine cannot do as asked, is `-32602` with
`data["windlass"].reason = "invalid_request"` and the engine's sentence; an unknown parent is `-32002`.

A fork can be the parent. With a `throughSeq` in the part it inherited, the new session is recorded as a fork of
the session that event belongs to: its `session.created` lineage, and `forkedFrom` in `session/list`, name that
session, while `parentSessionId` in this result is the session the request named. A fork whose inherited history
cannot be read (its parent's file was deleted or moved) still loads and runs: `session/load` replays its own
events, and its first listener gets one `diagnostic` of kind `history` naming the missing file. Reading its whole
log (`_windlass/events`), forking it, or replaying it is refused as `invalid_request` with the sentence
(`session <id> cannot be forked: the history inherited from session <id> cannot be read: <file> is missing`).

**`_windlass/replay`** (request): replays a recorded session against a changed baseline (`Engine.replaySession`,
`docs/replay.md`). The real model is called; every tool call that is on the recording is answered from it. The
answer comes when the replay is over; meanwhile the replay session is shown on this connection like any session:
**`_windlass/replay_started`** (notification) `{ sessionId, sourceSessionId, ref }` names it first, then its
events (`_windlass/event` for a client that takes them, standard updates otherwise) follow under its ID, and
`session/cancel` on it (or `$/cancel_request` of the replay request) ends the replay as `incomplete`. It is let go of
when the replay ends; it is not listed, and its log stays readable (`_windlass/events`). Refused when signed out.

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

**`_windlass/child`** (notification): one durable event of a subagent of a session open on this connection, as
the engine forwards it, for a client that does not take the harness's events. A client that does gets the same as
`child.event` inside `_windlass/event` (`{ type: "child.event", sessionId, child, spawnId, title, event }`) and
no `_windlass/child`. Nothing of it is stored in the parent: the subagent's own log is the record.

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

**`_windlass/cancel_call`** (request) `{ sessionId, callId, messageId?, childSessionId? }` → `{ stopped: boolean,
message: string | null }`: the user stops one running tool call and nothing else (`EngineSession.cancelCall`); the
turn is not interrupted. `callId` is the call as `tool.called` names it; `messageId` is its step (the assistant
message), and without it the call is looked for in the step in progress; `childSessionId` names a subagent of the
session whose call it is. With `stopped: true` the request is in the log (`tool.cancel_requested`), and the call
settles like any running call: a command with what it had printed and a line that says the user stopped it (outcome
`error`), a subagent call with the subagent's last words, a call that cannot be stopped midway (a read, one write)
with its ordinary result. The model reads the result in its next request. With `stopped: false` nothing was asked
of the call and `message` says why in a sentence: no turn runs, the whole turn is being stopped, there is no such
call in the step in progress, it has not started or already has its result, or it was already asked to stop. A
client that takes the standard updates sees the call's final `tool_call_update` and nothing else of it.

**`_windlass/watch`** (request) `{ sessionId, command, pattern, regex?, ignoreCase?, limit? }` → `{ watchId,
spawnId, pattern, regex, ignoreCase, limit, fired }`: the user sets a watch on the output of a background command
that is running (`EngineSession.watchOutput`), so that the model is told, without polling, when the command prints a
line that matches. `command` is the command's ID (`spawn.started.spawnId`); `pattern` is text a line must contain, or
with `regex` a regular expression; `limit` is how often it may fire (default 1). `fired` counts the lines the command
had already printed that matched at once. The model has no tool for this: it is the user's to ask for. What the
engine refuses (no such command runs, the ID names a subagent, a pattern it cannot use, a limit out of range, a
command that has its fill of watches) is `-32602` with `reason: "invalid_request"` and the engine's sentence, and
nothing is written. A firing is the `watch.fired` event right after the `inbox.enqueued` of the harness message that
tells the model (`origin: "background_watch"`): a client shows it as the watch's, with the line, never as something
the user typed; a client that takes the standard updates is sent no `user_message_chunk` for it. Answered after the
watch's events were sent.

**`_windlass/unwatch`** (request) `{ sessionId, watchId }` → `{ removed: boolean }`: removes a watch that could
still fire (`watch.ended`, `removed`); `false` for one that has fired as often as it may, has ended, or is unknown.

**`_windlass/watches`** (request) `{ sessionId }` → `{ sessionId, commands: { spawnId, command, logPath, watches: {
watchId, pattern, regex, ignoreCase, description, limit, fired, watching }[] }[] }`: the session's background
commands that are running, oldest first, each with the watches on its output; `description` is what a watch looks
for in the engine's words (`text "ready"`, `pattern /error/i`), `watching` whether it can still fire. A command that
ended is not listed: its watches ended with it.

**`_windlass/withdraw`** (request) `{ sessionId, messageId }` → `{ withdrawn: boolean }`: takes back a message
that was admitted and not delivered yet (`inbox.cancelled`); `false` when it was delivered or is unknown.

**`_windlass/unarchive`** (request) `{ sessionId }` → `{}`: puts a deleted (archived) session back in the
listing.

**`_windlass/session`** (request) `{ sessionId }` → `{ sessionId, state, cwd, title, model, effort, archived,
updatedAt, lastSeq, inbox: { messageId, delivery }[], canUndo, canRedo, agent, todos }` for a session open on this
connection. `agent`: the name of the agent it runs as, or `null`; `todos`: the model's task list as it stands
(`{ text, status }[]`), or `null` when it never set one.

**`_windlass/events`** (request) `{ sessionId, afterSeq?, limit? }` → `{ events }`: the stored log, also of a
session another process is working in.

**`_windlass/resolve`** (request) `{ cwd, session? }` → `{ sessionId, cwd }`: the session an ID or a unique
start of one names, or, without `session`, the latest in `cwd`. A lookup in the store: it works signed out, and so
does everything that only reads or copies sessions (`session/list`, `_windlass/events`, `_windlass/fork`).

**`_windlass/diagnostic`** (notification) `{ sessionId, kind, message }`: something the engine noticed that is
not part of the log (`prefix_violation`, `internal_error`, `tool_crashed`, `listener_failed`), or about what it
could not use as configured (`skills`, `mcp`, `wake`, `memory`, `telemetry`: export that is on and cannot be
started, or stopped for the session; `agents`: an agent definition that was skipped or is hidden by another, an
agent that names a tool that does not exist or asks for a looser approval mode than the user's, a project's
default agent that was not followed, a model the session keeps when it leaves the agent that set it), or about
a session's own history (`history`: a fork whose parent's file is missing, said once), or about a hook or a language
server (`hooks`: a project's hook that is skipped until the user approves it, a hook that could not answer and what
that means for the call, a turn that ended with a stop hook unsatisfied; `lsp`: a project's server that is not
started until approved, and why an edit got no diagnostics, said once per server and reason), or about a fork whose
parent's file is gone (`history`: the conversation it inherited is not shown, and which file is missing). Four kinds
are for the user to read and are no failure of the harness: the `notice` a client that shows notices gets for them is
titled `Hooks` (severity `warning`), `Language servers` (`info`), `Agent definitions` (`warning`) and `Earlier
history not shown` (`warning`), not `Internal problem`.

**`_windlass/approval`** (request) `{ sessionId, mode?, unattended?, attended? }` → `{ sessionId, enabled, mode,
unattended, attended, sandboxUnavailable: { reason, remedy } | null, tainted, taint, ignored }`: how the session's
tool calls are approved, after setting the fields the request names. `ignored` lists project settings that would
have loosened the user's policy.

**`_windlass/clear_taint`** (request) `{ sessionId }` → `{ cleared: boolean }`.

**`_windlass/taint`** (notification) `{ sessionId, tainted, text?, source?, replay? }` and
**`_windlass/notice`** (notification) `{ sessionId, kind, message }`: see "Approval" above.

**Errors.** Every error the server answers for a reason a client may act on has
`data["windlass"] = { reason, message, holderPid? }`, `message` being the harness's own sentence:
`auth_required` (`-32000`), `session_in_use` (`-32603`, with the holder's process ID), `session_not_found`
(`-32002`), `ambiguous_session`, `unknown_model`, `unknown_effort` (the message names the efforts the model accepts)
and `invalid_request` (`-32602`), `schema_mismatch` (a session written by another
version), `model_list_failed`, `execution_failed` (a failed turn, with `providerError`), `approval_required` (a turn ended
because a call needed approval and nobody was present), `closed`.

**`session/prompt` `_meta["windlass/delivery"]`**: `"steer"` (the default) or `"queue"`. A queued prompt waits
until the agent would otherwise stop, then gets its own answer in the same turn.

**`_windlass/steer`** (request) and **`_windlass/queue`** (request): admit input without waiting for the
turn. The message is shown as a `user_message_chunk` where it lands. If the session is idle, it starts a turn; its end
is reported by `_windlass/state` and `_windlass/turn`.

```ts
// params
{ sessionId: string, prompt: ContentBlock[], maxSteps?: number }   // the same content blocks as session/prompt
// result
{ messageId: string }                           // the ID the message has once delivered
```

**`_windlass/models`** (request): the models and efforts the account offers, asked for afresh; when they cannot
be listed, an error with the reason (`auth_required` or `model_list_failed`).

```ts
// params: {}
// result
{
  defaultModel: string,
  models: { id: string, name: string, efforts: string[], defaultEffort: string | null, contextWindow: number | null }[]
}
```

**`_windlass/usage`** (notification, agent to client): after every model call that reported usage, including
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

**`_windlass/state`** (notification, agent to client): when the session starts working, when it stops, and on
load or resume.

```ts
{
  sessionId: string,
  state: "running" | "idle" | "suspended",  // suspended: cut off by a shutdown; the next prompt takes it up again
  stopReason?: string,                       // on idle after work: a session/prompt stop reason, or "error"
  message?: string                           // on idle after a failure: why
}
```

**The session's features.** What the engine runs for a session that a client shows the user: its MCP servers, its
hooks, its language servers, its skills, its wake-ups, and its memory. Every request takes `{ sessionId }` of a session open on this connection; what
they say is in the engine's own words where it has them.

**`_windlass/mcp`** (request) → `{ sessionId, available, servers }`, and **`_windlass/mcp_changed`**
(notification, the same object) whenever what a client shows changed: a server started, failed, waits for the user's
approval, or was approved (the engine tells the server when it changes: nothing is polled; a retry's countdown is not
a change). An approval's `_changed` notification is sent before the answer to the approval. `available: false`: the
engine offers no MCP servers.

```ts
servers: {
  name: string,
  state: "running" | "starting" | "failed" | "awaiting_approval" | "disabled" | "stopped" | "not_started",
  transport: "stdio" | "http" | null,
  target: string | null,          // the command with its arguments, or the address
  argv: string[] | null,          // the command and each argument, one string each (for a question: the engine's
                                  //   own, of the definition it asks about); null for an address
  tools: number | null,           // once running
  hiddenTools: number,            // hidden by the allow/deny list
  error: string | null,           // failed: why, with the end of its stderr
  retryInMs: number | null,
  origin: "user" | "project" | null, file: string | null,   // the file that defines it
  question: { fingerprint, subject, details: string[] } | null   // awaiting_approval: the engine's question
}[]
```

`not_started`: a file names it and no turn has read the configuration yet (servers start with a turn).

A client that asks the user about a command shows all of it, to its last character, and where each argument ends:
`quotedCommand(argv)` (`packages/acp/src/extensions.ts`) gives the line, with every argument that is not plain text in
single quotes, so `bash -c "a b"` reads `bash -c 'a b'` and never `bash -c a b`. The same holds for a language
server's `argv` and for a hook's `command` (one string, run by the shell as it is).

**`_windlass/mcp_approve`** (request) `{ sessionId, name, fingerprint }` → `{ approved, servers }`: the user starts
a server the project's configuration names, exactly the definition `fingerprint` identifies (from `question`); it is
remembered for the project for 30 days and starts at once. `approved: false` when no such server waits (the definition
changed: ask again).

**`_windlass/hooks`** (request) → `{ sessionId, available, hooks, maxStopRounds, ignored }`, and
**`_windlass/hooks_changed`** (notification, the same object) whenever what a client shows changed: the
configuration was read and names hooks, a project's hook waits for the user's approval or was approved, a hook could
not answer or answers again. The engine tells the server when they change; the server reads them once, a moment
after the session was opened, so a client has the question before the first message. `available: false`: the engine runs no hooks.
`maxStopRounds` is how often per turn stop hooks may send the agent back; `ignored` is what the project's file asked
for beyond what the user's allows.

```ts
hooks: {                           // in the order they run: per point the user's first, then the project's
  name: string,
  point: "beforeTool" | "afterTool" | "stop",
  state: "in_force" | "awaiting_approval" | "failed",
  command: string,                 // word for word
  tools: string[] | null,          // the tools it applies to; null: every tool (always for a stop hook)
  paths: string[] | null,          // the path patterns it applies to; null: any call
  timeoutSeconds: number,
  onError: "refuse" | "allow",     // a before hook that cannot answer: the call is refused, or goes through
  sandbox: boolean,                // false: the user's own hook that asked to run outside the sandbox
  origin: "user" | "project", file: string | null,   // the file that defines it
  fingerprint: string,             // exactly this definition: what hook_approve takes
  error: string | null,            // failed: why it could not answer the last time it ran in this session
  question: string | null          // awaiting_approval: the engine's question, word for word
}[]
```

`awaiting_approval`: the project's file names the hook and the user has not approved this definition; it is skipped
(the call runs as if the hook were not there) until then. `question` is the whole question as the engine words it:
a first sentence, the command indented by four spaces, what it applies to and how it runs. `failed`: the hook is
still run the next time it applies; a later run that answers puts it back `in_force`.

**`_windlass/hook_approve`** (request) `{ sessionId, fingerprint }` → `{ approved, hooks }`: the user allows a hook
the project's configuration names, exactly the definition `fingerprint` identifies. It is remembered for the project
for 30 days and the hook runs from the next call it applies to. An edited hook has another fingerprint and waits
again. `approved: false` when no such hook waits.

**`_windlass/lsp`** (request) → `{ sessionId, available, off, waitMs, servers }`, and **`_windlass/lsp_changed`**
(notification, the same object) whenever what a client shows changed: a server started, failed, waits for the user's
approval, or was approved (told by the engine, like the hooks). `available: false`: the engine offers no
diagnostics. `off`: a sentence when servers are configured and no edit gets diagnostics (`lsp.enabled: false`,
`lsp.waitMs: 0`), else `null`. `waitMs`: how long an edit's result may wait; `null` when nothing is configured.

```ts
servers: {
  name: string,
  state: "running" | "starting" | "failed" | "awaiting_approval" | "disabled" | "stopped" | "not_started",
  command: string,                 // with its arguments
  argv: string[],                  // the command and each argument, one string each (see quotedCommand above)
  languages: { languageId: string, patterns: string[] }[],   // the files it serves, relative to the working directory
  processes: { root: string, state: "running" | "starting" | "failed" | "stopped" | "not_started",
               error: string | null, restarts: number, openDocuments: number }[],   // one per workspace root
  error: string | null,            // failed or stopped: why
  origin: "user" | "project" | null, file: string | null,   // the file that defines it
  question: { fingerprint, subject, details: string[] } | null   // awaiting_approval: the engine's question
}[]
```

`not_started`: a server starts when the agent reads or edits a file it serves. A server's `state` is that of the
process that most needs the user's eye (`failed`, then `starting`, `running`, `stopped`). `failed` is not final: the
server is started again at a later edit, after a backoff.

**`_windlass/lsp_approve`** (request) `{ sessionId, name, fingerprint }` → `{ approved, servers }`: the user allows a
language server the project's configuration names or changes, exactly the definition `fingerprint` identifies (from
`question`). It is remembered for the project for 30 days and the server starts at the next file it serves.

**What a hook did and what the language servers said, for a client without the harness's events.** A client that
takes the events has `hook.ran` and `tool.settled.diagnostics`. Any other gets, on the settled `tool_call_update`:

```ts
_meta: {
  "windlass/outcome": "success" | "error" | "not_started" | "effect_unknown",
  "windlass/hooks"?: {             // the hooks that refused the call, added a note to its result, or could not answer
    point: "beforeTool" | "afterTool" | "stop", name: string, origin: "user" | "project",
    answer: "yes" | "no" | "failed" | "interrupted" | "skipped",   // here only "no" and "failed"
    failure: string | null,        // failed: why
    toModel: string | null,        // the hook's own text the model was given: the reason, or the note
    forUser: string                // what it printed for the user (its stderr), bounded
  }[],
  "windlass/diagnostics"?: {       // an edit of a file a language server serves
    noteAdded: boolean,            // a note with the new diagnostics follows the tool's own output
    listed: number, omitted: number, waitedMs: number,
    servers: { name: string, origin: "user" | "project", outcome: string, new: number, preExisting: number, fixed: number }[]
  }                                // outcome: compared, unchanged, timeout, not_running, crashed, not_approved, interrupted
}
```

A stop hook that sends the agent back is a `notice` (`warning`, titled with the hook's name, its text as the
description) to a client that shows notices; a turn that ends with stop hooks still objecting has `hooks.unsatisfied`
and `hooks.objections` (what each hook said) in `_windlass/turn` and in the prompt response's `_meta`.

**`_windlass/skills`** (request) → `{ sessionId, available, skills: { name, description, path, scope, root }[],
problems: { path, severity: "skipped" | "shadowed" | "warning", reason }[], roots: { dir, scope }[] }`: the skills of
the session's directory as the model would be given them now. `scope` is `project`, `config` (`skills.paths`) or
`user`; paths are absolute and never cut.

**`_windlass/wakeups`** (request) → `{ sessionId, available, running, wakeups }`: the session's wake-ups,
pending and ended. Each is `{ id, trigger, description, state, nextAt, fired, maxFirings, author, message, url, lines
}`: `lines` are the engine's listing lines (state, limits, who created it, the message), `url` a webhook's address.
`running`: this process fires wake-ups.

**`_windlass/wake_create`** (request) → `{ created, message, wake, url, secret, running }`: the user creates a
wake-up for the session (`Engine.wake().create`, author `user`), with the bounds the engine gives a user.

```ts
// params
{
  sessionId: string,
  message: string,                  // what the session is told when it fires
  trigger:                          // times in ms since the epoch, durations in ms
    | { kind: "at", at: number } | { kind: "after", delayMs: number } | { kind: "every", intervalMs: number }
    | { kind: "cron", expression: string, timeZone?: string }
    | { kind: "check", command: string, intervalMs: number, fire: "until" | "on_change", timeoutMs?: number, includeOutput?: boolean }
    | { kind: "webhook", includeBody?: boolean },
  delivery?: "wake" | "queue",      // default wake: starts a turn if the session is idle
  maxFirings?: number, expiresAt?: number, minIntervalMs?: number,
  run?: { kind: "sandboxed", network: boolean, writableRoots: string[] } | { kind: "unsandboxed" }
}                                   // run: a check only: the access the user chose for its command (default: in the
                                    //   sandbox, without network); it is the most the command ever runs with
```

`created: false`: nothing was set up, and `message` is the engine's sentence (the request is not valid, the session
is a subagent or a replay or has wake-ups turned off, it has no room for another). Otherwise `wake` is the wake-up as
`_windlass/wakeups` lists it and `running` says whether this process fires wake-ups. For a webhook, `url` and
`secret` are its address and the secret that signs its requests: the secret is for the user and never the model, and
is in no event, notification or log, only in this answer and in `_windlass/wake_secret`. A client asks the user
about a check's command before it sends the request, as it would be asked about a command the agent runs, and shows
a secret once, where its output is a terminal. Params that are not a wake-up at all are `-32602`.

**`_windlass/wake_cancel`** (request) `{ sessionId, id }` → `{ cancelled, message }`: the user cancels one.

**`_windlass/wake_secret`** (request) `{ sessionId, id }` → `{ id, url, secret, message }`: a webhook wake-up's
address and the secret that signs its requests, for the user. It is in no event, notification or log: only in this
answer. `secret: null` with `message` for another trigger or an unknown wake-up.

**`_windlass/memory`** (request) → `{ sessionId, enabled, off, startsWithFirstTurn?, notes, pending, problems,
review, paths }`. With memory off (`enabled: false`), `off` says why and how to turn it on;
`startsWithFirstTurn: true` says it is on in the configuration and starts with this session's first turn, which has
not begun (a session's notes are read then). Otherwise `notes` are the notes in force and the
lapsed or superseded ones (`{ id, kind, scope, text, state, author, quote, created, confirmed, expires }`), `pending`
the ones waiting for the user's confirmation (with why, and `decisions`), `problems` the note files that are not
valid, `review` what to look at (`reviewReport`), `paths` the two directories of notes.

**`_windlass/memory_change`** (request) `{ sessionId, action, text?, scope?, kind?, id?, reason? }` → `{ ok, id,
message, deferred? }`: the user's own change. `remember` saves `text` as a note written by the user (`scope`
`project` by default, or `user`); `retract`, `confirm`, `reject` and `renew` act on the note `id`. `message` says
what happened, or why nothing did: without memory it is the sentence `_windlass/memory` gives as `off`. A `remember`
before the session's first turn, with memory on in the configuration, answers `{ ok: false, deferred: true }`:
nothing is wrong with the note and nothing is saved yet. The client keeps it and sends it again once the session
has started (its `baseline.set` event), so a note is never dropped; both interfaces do, and say what became of it.

### Slash commands

A slash command is a Markdown file of the user's or the project's whose text, with what was typed after its name put
in, is sent as the user's message ([commands.md](commands.md) has the format and where the files live).
Nothing in a file is run or read when it is used. The server offers them three ways.

**The protocol's own way.** After `session/new` (right after its answer) and `session/load`, and again before a
prompt is admitted when the files changed, the server sends a `session/update` of kind `available_commands_update`:
`availableCommands: [{ name, description, input?: { hint }, _meta: { "windlass": { path, scope, agent } } }]`.
A `session/prompt` whose text is `/name args` is then expanded by the server: the file's text is admitted as the
user's message and the turn runs as for any prompt. A name no file has is refused with invalid-params and the
sentence to show (`There is no command /deplyo. Did you mean /deploy? To send it to the model as text, start it
with //.`); nothing is admitted and no request is sent. `//text` sends the text `/text`; a first word that cannot be
a command's name (`/usr/bin/env is missing`) is an ordinary prompt. `agentCapabilities._meta["windlass"].commands`
is `true` on a server that does this. A client with commands of its own runs those before it sends.

**`_windlass/commands`** (request) `{ sessionId }` or `{ cwd }`, with `builtins?: [{ name, aliases? }]` (the
client's own commands) → `{ available, commands, problems }`. `commands` are the files by name (`{ name,
description, argumentHint, agent, path, scope, hiddenBy }`; `scope` is `project`, `config` or `user`; `hiddenBy`
names the client's command that takes the name, when one does). `problems` (`{ path, severity, reason, name }`) are
the files that cannot be used (`skipped`), the ones a nearer file or a client's command hides (`shadowed`) and the
ones used although something in them is not read (`warning`). `available: false`: this engine offers none.

**`_windlass/expand_command`** (request) `{ sessionId, name, args, builtins? }` → what `/name args` would send,
without sending it: `{ kind: "command", command, text, missing, unused, appended, unsupported, notes }`, or
`{ kind: "builtin", name }`, `{ kind: "broken", name, message }`, `{ kind: "unknown", name, suggestions, message }`
(the close names of the client's commands and of the files), `{ kind: "unavailable", message }`. `missing` are the
positions the file uses that were not given (each is empty in the text); `unsupported` is what another harness would
run or read at that point and this one leaves in the text as written (`{ kind: "shell" | "include", text, line,
reason }`).

**`_windlass/send_command`** (request) `{ sessionId, name, args, delivery?, maxSteps?, builtins? }` →
`{ messageId, command, missing, unused, appended, unsupported, notes }`: the command is expanded and admitted as the
user's message, answered once admitted (as `_windlass/steer` is). The log records which file produced the message:
the `command.expanded` event follows the `inbox.enqueued` at once, with `{ messageId, name, path, scope,
fingerprint, arguments, missing, unsupported }`. Refused with invalid-params (`reason: "invalid_request"`) and the
sentence to show, with nothing admitted, when no file has the name, the file cannot be used, the name is one of
`builtins`, or the agent the file names does not exist.

A client that takes the standard updates is shown such a message as `user_message_chunk` with its text and
`_meta["windlass/command"] = { name, arguments, path, scope, missing, unsupported }`.

## Trying it without an editor

`packages/acp/scripts/try-client.ts` is a small ACP client that starts `windlass acp`, opens a session in a temporary
workspace, sends a prompt and prints every update:

```
bun packages/acp/scripts/try-client.ts --setup failing-test --model gpt-6-luna --effort low "Run the tests and fix the failing one."
bun packages/acp/scripts/try-client.ts --cancel-on-command 2000 "Run sleep 20 with the shell tool."
bun packages/acp/scripts/try-client.ts --workspace <dir> --load <session id>
```

For tests, `WINDLASS_ACP_SCRIPT=<file.json>` makes `windlass acp` use a scripted model instead of the real one (see
`packages/acp/src/scripted.ts`).
