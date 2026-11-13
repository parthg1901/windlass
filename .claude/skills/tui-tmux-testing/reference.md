# TUI testing: feature set-ups

Detail for [SKILL.md](SKILL.md): how to bring each feature onto the screen with a scripted model
(`WINDLASS_ACP_SCRIPT`; items in the `harness-testing` skill's reference). What a feature shows is in its page under
`docs/`; take exact wording to wait for from `packages/tui/src/` or the feature's test.

## Scripting rules

- Each model call takes the next response, a subagent's included: its responses come between the parent's
  `subagent` call and the parent's next response. Script one subagent per step; two started together race.
- Anything that starts a turn needs a response: a message, a queued message, a review that is sent, a watch that
  fires, a wake-up, a stop hook that sends the model back. Count them, or the turn fails as not scripted.
- The script starts over with the server: after `/reconnect` or `tui -c` the first response is next again.
- `{ "type": "delay", "ms": 3000 }` at the start of a response gives time to type, steer, stop or open a view.
- Give responses a `usage` item when the test reads the panel's tokens or exports a trace: a call without one is
  not counted.

## Questions and the approval dock

- A call that asks under the default `auto` mode: a `write` to a path outside the workspace and outside `/tmp` (use
  a directory under `/var/tmp`; a path under `/tmp` counts as the session's own temp directory), a `shell` call with
  `"sandbox": { "network": true }`, or any edit or command after `/approval ask`.
- Answer keys: `a` once, `s` this session, `p` this project (not offered for network access), `n` no, `m` no with a
  note (type it, then Enter). Read the choices before scripting Up and Down.
- The dock takes the keys only when the input is empty and nothing was typed for 1.2 s, and ignores its own letters
  for 0.4 s after taking them (`QUIET_MS`, `ARMING_MS` in `packages/tui/src/approval.ts`). When its last line says
  `Tab answers`, press Tab and wait 0.5 s. Sending a message does not count as typing.
- With several questions queued, wait for the next question's title between answers: each takes the keys 0.4 s
  after it appears, so keys sent in a loop approve them unread.
- A project's hooks, language servers and MCP servers (`.windlass/config.json`) are asked about when the session
  opens. Until the last is answered the status line shows the question instead of `● ready`, and a message sent
  meanwhile is held. Real ones for tests: `packages/core/test/lsp/fixtures/server.ts`,
  `packages/core/test/mcp/fixtures/stdio-server.ts`.
- Approvals of a project's hooks and servers are kept in the data directory: a new `XDG_DATA_HOME` asks again.
- To check that a long command is shown whole in a question, end a long word with a marker and look for the marker
  before answering.

## Features

| Feature | Set-up |
|---|---|
| Steer and queue | While a turn runs, Enter steers. Ctrl-T switches to queueing and stays switched for later turns: read the input's label (`steer ›` or `queue ›`) before typing. A queued message is a turn of its own with its own ending row. |
| Stop the turn | Ctrl-C once; twice within 2 s exits. Wait for `interrupted`, not for the `stopping` row to go. To see the second Ctrl-C act, the command must outlast the first: `trap '' TERM; sleep 30`, or `--demo-grace` in a demo. |
| Stop one call | Script a `shell` call with `echo started; sleep 300` and one more response. Send Ctrl-X only after the row says `running`; with several running, select one first. |
| Select and expand | Alt-Up moves the `▌` mark up from the turn's ending row, one row per press; Ctrl-O expands the marked row, and again for a tool call's full output. Alt-PageUp jumps to the ending row of the turn before. |
| Slash commands | Type the command, wait 0.5 s for the palette, then Enter. A `/word` that is not a command is never sent; `//text` sends a message that starts with a slash. |
| Undo, diff, review | The workspace must be a git repository with a commit. Script a turn that overwrites a committed file and writes a new one. Wait for a view's first line before sending its keys. Keys and wording: `docs/user-guide.md`, "Undo and redo" and "Reviewing a turn's changes". |
| Agents | `<workspace>/.claude/agents/<name>.md` with front matter `name`, `description` and `effects: read` or `tools: ...` (`docs/agents.md`); start with `tui --agent <name>` or switch with `/agent <name>`. To see a refusal, script a `write` under a read-only agent. |
| Task list | Script a `todo` call: `"input": { "todos": [{ "text": "...", "status": "done" }] }`, statuses `pending`, `in_progress`, `done`, at most one `in_progress`. |
| Subagents | Script `[[parent: subagent call], [child: tool calls], [child: answer], [parent: answer]]`. Mark the row and expand it to read the child's rows. A reopened session shows the row without live activity; expanding reads the child's own log. |
| Background and watch | Script a `shell` call with `"background": true` that prints a line late (`echo booting; sleep 8; echo listening; sleep 300`), read its ID from the row, then `/watch <id> listening`. The firing starts a turn. A background row looks like a finished one: check the process with `pgrep -P`. |
| Hooks and diagnostics | Put them in the user's file (throwaway `XDG_CONFIG_HOME`) to skip the approval, or answer the question. For diagnostics script a `read` of the file (it starts the server), a `delay` of 2500 ms, then the `write`; reset the file between runs, since an edit that changes nothing reports nothing. |
| Compaction | A short scripted conversation answers that there is too little to compact. A compaction that happens needs a long conversation and a summary response of the required form, so cover it in-process (`rename-compact.e2e.test.ts` under `packages/cli/test/` and `packages/acp/test/`). |
| Fork | `/fork` switches to the new session. Wait for the fork's note, a line of the inherited history and `● ready` together: the note arrives before the history. `windlass fork` and `windlass replay` are one-off subcommands: test them headless. |

## Exit paths and crashes

- Kill the server under a running TUI: `pgrep -P <TUI pid> -f "main.ts acp"`, then `kill -9 <pid>`. The TUI is the
  pane's process when the command was exec'd, otherwise a child of it.
- Inject a crash with `bun --preload <file that throws from a timer>`. Bun prints the uncaught error itself before
  the TUI's handler does, so both appear; read them with `capture-pane -p -S -`, since the stack can scroll the first
  line off the screen.
- Read the exit status from the wrapper's `status=` line (or `term.exited()`), never from tmux's
  `pane_dead_status`, which can be empty. Read terminal modes while the wrapper still holds the pane: a dead pane
  always reports a hidden cursor.
- `$T pipe-pane -o -t tui 'cat >> <file>'` records every byte the program writes from then on, for when the modes
  and the screen disagree.

## Checks worth making

- Idle CPU: after `● ready`, the TUI's CPU time in `/proc/<pid>/stat` must not grow over a few seconds. Growth
  means something re-renders every frame.
- Wrapping: script an answer with inline code followed by punctuation and capture at 60, 80 and 100 columns. No row
  may start with `,` `.` `)` or `:`, and only a word longer than the row is broken.
- Panel: with a scripted model and a throwaway data directory the context row says `(window unknown)`, which is
  right: the window comes from the model listing, which needs a sign-in.
- Live model: a call that reads 0% from cache right after a high one is usually the provider's, not the TUI's. The
  `harness-testing` skill (step 6) says how to tell.
