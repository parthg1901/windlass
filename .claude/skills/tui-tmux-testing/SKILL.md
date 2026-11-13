---
name: tui-tmux-testing
description: How to test the full-screen TUI (packages/tui) in a real terminal through tmux, against the scripted demo engine, the real `windlass acp` with a scripted model, or the live model. Use before calling TUI work done, when a frame looks wrong on screen, or when an end-to-end TUI test is flaky.
---

# Testing the TUI through tmux

Component tests (`packages/tui/test/frames.test.ts`, `input.test.ts`) render the real `App` on OpenTUI's test renderer and are the fast loop. This skill is for the real terminal: key encoding, the alternate screen, exit paths, resize, the child server. Add to the "Known issues" section every time a tmux run teaches something.

## Rules

- Never `pkill -f` or `pgrep -f | xargs kill` with a pattern from the TUI's command line: a tmux server started with `new-session "<command>"` carries that command in its own argv, so the pattern kills the tmux server and every pane on it. Kill by PID from the pane's process tree (`Tmux.children()`, or `pgrep -P <pane pid>`).
- Use a private tmux server (`tmux -L <name>`), never the default one: tests must not see or touch the user's sessions, and `kill-server` must remove only yours.
- Live model runs spend the owner's ChatGPT plan allowance: `gpt-6-luna`, `--effort low`, short prompts, and count the calls (the panel's `calls` row counts them per session). Never print tokens or Authorization headers.
- Clean up: kill sessions, kill the private server, and delete its socket file (`kill-server` leaves `/tmp/tmux-<uid>/<name>` behind), temporary workspaces and data directories.

## Start the TUI at a fixed size

```sh
cd "$(git rev-parse --show-toplevel)"
T="tmux -L windlass-manual"
# Scripted demo engine (no model, no server): any of `bun packages/cli/src/main.ts --demo list`
$T new-session -d -s tui -x 100 -y 30 "bun packages/cli/src/main.ts tui --demo find-and-fix-a-failing-test; echo status=\$?; sleep 600"
# Real `windlass acp` with a scripted model, in a throwaway git workspace and data directory (no sign-in needed)
$T new-session -d -s tui -x 100 -y 30 "XDG_DATA_HOME=$TMP/xdg WINDLASS_ACP_SCRIPT=$TMP/script.json bun packages/cli/src/main.ts tui --cwd $TMP/work; echo status=\$?; sleep 600"
# The live model (check `bun scripts/login.ts status` first)
$T new-session -d -s tui -x 120 -y 40 "bun packages/cli/src/main.ts tui --cwd $TMP/work --model gpt-6-luna --effort low; echo status=\$?; sleep 600"
```

- `--demo-speed 4` plays a demo faster; `--demo-grace <ms>` makes a stopped command take that long to wind down (for Ctrl-C tests).
- A script for `WINDLASS_ACP_SCRIPT` is `{ "responses": [[items...], ...] }`, one list per model call; items are `text`, `reasoning`, `tool_call` (`callId`, `name`, `input`), `usage`, `delay` (`ms`), `finish`, `fail` (see `packages/acp/src/scripted.ts`). The workspace needs `git init` and a commit for undo to have snapshots.
- Approvals are scripted with calls the default mode (`auto`) asks about, so the question is the engine's own: a `write` to a path outside the workspace (not under `/tmp`, see Known issues), a `shell` call with `"sandbox": { "network": true }`, or anything after `/approval ask`. A `read` of a file outside the workspace taints the session. `{ "type": "delay", "ms": 1500 }` before the call gives a test time to type first.
- `WINDLASS_TUI_DEBUG=1` shows events the TUI does not know as dim rows; `NO_COLOR=1` turns colour off; `WINDLASS_TUI=1` makes plain `windlass` (interactive, no prompt) start the TUI.
- In tests use `packages/tui/test/tmux.ts`: `Tmux.start({ width, height, command, env })` runs the command under a shell that records its exit status and keeps the pane, on a private server per test process.

## Approvals, taint and diffs

- The approval dock opens above the input. It takes the keys only when the input is empty and nothing was typed for 1.2 s, and then ignores its own letters and Enter for 0.4 s; otherwise its last line says `Tab answers the question` and everything typed goes to the input. Focused, its last line starts `↑↓ Enter · a s p n m`. Answer `a` once, `s` session, `p` project (not offered for the network), `n` no, `m` no with a note (type it, Enter). Esc gives the keys back to the input; Ctrl-C stops the turn and answers `cancelled`. With no turn running (a question about a project's hook or server) Ctrl-C answers "not now" and the conversation says `the hook "<name>" is not run; /hooks approve <name> asks again`; the dock's last line then ends `Ctrl-C answers not now`. With text in the input and the dock not focused, the first Ctrl-C clears the text and the second answers.
- While a question waits the status line says `? waiting for your answer · <tool> <argument> · <time>`, and the call's row `? <tool> … · waiting for your approval`.
- A command's row ends in `⊡` when it ran in the sandbox, `⊡ +network` / `⊡ +write <dir>` with extra access, `· no sandbox` without it. A refused call is `⊘`.
- `/approval` (picker, or `/approval ask`), `/clear-taint` (asks first), `/diff` (full-screen per-file diffs of the selected step or turn, the latest by default; n and p jump between files, r opens the turn's review, Esc closes), `/review` (the turn's diff with a line cursor and comments: see "Reviewing a turn's diff").

```sh
$T send-keys -t tui -l "write it outside"; $T send-keys -t tui Enter
until $T capture-pane -p -t tui | grep -q "↑↓ Enter · a s"; do sleep 0.1; done; sleep 0.5   # focused and armed
$T send-keys -t tui -l "m"; $T send-keys -t tui -l "keep it in the workspace"; $T send-keys -t tui Enter
```

## Agents, the task list, /rename and /compact

- Agents are Markdown files in the workspace: `$TMP/work/.claude/agents/<name>.md` with front matter (`name`, `description`, and `effects: read` or `tools: read, write`). `tui --agent reviewer` starts as one: the first row is `⇄ working as the agent reviewer (read only)` with its restrictions under it, and the panel has `agent  reviewer`. Set `XDG_CONFIG_HOME` to a throwaway directory too, or the user's own agents and `agents.default` are read.
- `/agent` opens a picker (`no agent`, then each agent with `read only · <description>`, the descriptions in one column after the longest name: match `reviewer\s+read only ·`, not two spaces; the definitions that could not be used are in its detail, full paths wrapped). Type to filter (`docs`), wait about 0.3 s, Enter. The switch is a row drawn from its event, `⇄ agent reviewer → docs (restricted) · from the next step`, and is there again in `tui -c`. `/agent <name>` switches without the picker; `/agent none` switches off.
- A call the agent may not make: script a `write` under a read-only agent. The row is `⊘ write note.txt · refused by the reviewer agent`, with the engine's sentence under it (`The agent "reviewer" may use only tools that read. "write" changes files.`), never "approval policy", and the file is not created.
- A broken definition is said with the first turn (`⚠ agents: The agent definition at … was not loaded: …`), not when the session opens; `/agent` shows it at once.
- The task list: script a `todo` call (`{ "type": "tool_call", "callId": "c1", "name": "todo", "input": { "todos": [{ "text": "Read the code", "status": "done" }, …] } }`). The conversation shows `≡ tasks · 1 of 3 done` and one line per task (`✓` done, `▸` in progress, `○` pending); the panel has a `Tasks` section. After `/quit` and `tui -c` both are there again. At most one item may be `in_progress`, or the call fails and is drawn as a failed call.
- `/rename Login bug` answers `· renamed: Login bug` and the panel's `title` changes; `--list-sessions` and `/sessions` show it.
- `/compact` with a scripted model and a short conversation answers `· Not compacted: only about N tokens of the conversation could be summarised …` (the engine wants about 2,000 tokens it can take out, counted from the messages' text, not from scripted `usage` items); before the first turn, `There is nothing to compact: the conversation has not started.` A compaction that is made needs a long conversation and a summary response of the required form (`SUMMARY` in `packages/core/test/scenarios/script.ts`); it is covered in-process with `limits.manualCompactionMinTokens: 0` (`packages/cli/test/rename-compact.e2e.test.ts`, `packages/acp/test/rename-compact.e2e.test.ts`). It is drawn as `⇣ compacted the conversation · about <before> → <after> tokens` and no ending row follows it.

## Subagents, fork and replay

- A subagent shares the scripted model with its parent: one `responses` list, consumed in call order. A foreground child's calls come between the parent's call that starts it and the parent's next step: `[[parent: subagent call], [child: tool calls], [child: answer], [parent: answer]]`. The child asks like the parent does (a `write` outside the workspace); the dock then says `subagent: <first line of the task>` and the status line `? waiting for your answer · subagent <task>`.
- The `subagent` row: collapsed, one `↳` line (`starting`, `now: <tool> <arg>`, `it asks you something: answer below`, `finished after N steps, M tool calls`); selected (Alt-Up until `▌` is on it) and expanded (Ctrl-O), the child's own rows framed by `│ `, a second Ctrl-O shows all of them. A running subagent is in the panel (`agents ⋯ <task>`, `?` when it asks, `◌` in the background) and, in the background or after the turn, in the status line (`· 1 subagent at work: <task>`).
- `/fork` (or `/fork copy`) switches to the new session: the `⑂ forked from …` note first, then the history. `windlass fork` and `windlass replay` are one-off CLI subcommands; test them headless (`packages/cli/test/fork-replay.e2e.test.ts`), not in tmux.

## MCP servers, skills, wake-ups, memory, background work

- A project's MCP server (`.windlass/config.json` → `mcp.servers`; the core fixture `packages/core/test/mcp/fixtures/stdio-server.ts --only echo` is a real one) is asked about in the dock as soon as the session opens, after the project's hooks and language servers, with the `⚠ mcp: ... It was not started` line in the conversation at the same moment: `─ ? Start the MCP server "<name>" ...`, the command, `Defined in <file>`, the engine's details, `[a] Start it for this project` / `[n] Not now`. No "with a note" item. `a` → `✓ approved: "<name>" starts now` and when the agent has it (from the next message; in the middle of a turn, "ask again in your next message"); the next `/mcp` shows `<name> · running · N tools` (the first `/mcp` right after can still say starting). A tool call's question displaces it and it comes back after. The approval is kept under the data directory: a fresh `XDG_DATA_HOME` asks again.
- An MCP call's dock shows `mcp_call  <server>/<tool>` and `sends: {...}` (the arguments), the row `mcp_call <server>/<tool>`.
- `/skills`, `/mcp`, `/wakeups`, `/memory` print notes in the conversation (the line CLI's words); long paths wrap, never cut. A webhook `wake_create` is followed at once by `⏰ Webhook wake-up created <id>` with `URL` and `secret`; `/wakeups secret <id>` again. Memory off: `· Memory is off. To turn it on, ...`.
- A background command: `◌ background <id> · <command>` with `output: <path on this machine>` (the tool's own output names the sandbox's `/tmp/.spill/...`), status line `● ready · ◌ background <id>: <command>`, panel `bg ◌ <id>: ...`, a note after the turn's ending row, and on `/quit` the TUI prints `windlass: leaving stopped the background command still running (<id>); ...` after the screen is gone.
- The panel counts a model call only when the response reports usage: a scripted response without a `usage` item leaves `no model call yet`. Give scripted responses `{ "type": "usage", ... }` when a test reads tokens.
- `/fork copy` shows the copy note (no ignored files, not a git repository); `/sessions` is 120 columns wide at most and marks a fork `⑂`, with `fork of <id>` and `in <dir>` for a copy elsewhere.
- The line CLI in tmux: keys typed before its prompt (even with Enter) are sent as the first message; a project's server is asked at the prompt (`[y] start it · [N] not now ›`), also after the turn ended.

## Hooks and language servers

- Set `XDG_CONFIG_HOME` to a throwaway directory as well as `XDG_DATA_HOME`: the user's own hooks and servers are read otherwise, and a stop hook of theirs would send the scripted model back for a response the script does not have.
- A project's hook (`.windlass/config.json` → `hooks.beforeTool` / `afterTool` / `stop`) and a project's language server (`lsp.servers`; `packages/core/test/lsp/fixtures/server.ts` is a scripted one that reports `ERROR(name)` markers in `**/*.txt`) are asked about as soon as the session opens (with `● ready`, or within half a second of it), before any message, the hook first and then the server, and again in every session opened later in the same run (`/new`, the picker, `/fork`): the dock shows `─ ? This project's configuration asks to run a hook "<name>" …`, the command, what it applies to, `Defined in <file>.`, `[a] Allow it for this project` / `[n] Not now`; then the next question (`? Start the language server "<name>" …`). The engine's own lines about them (`⚠ hook: … It is not run`, `· language server: … It was not started`) appear in the conversation at the same moment. Approvals are kept under the data directory: a fresh `XDG_DATA_HOME` asks again; an edited hook asks again at the next turn.
- `/hooks` and `/lsp` (also `/diagnostics`) print notes: per hook its point, `in force` / `waiting for your approval: not run` / `failed the last time it ran` with `why:`, the command, what it applies to, the file; per server its state, `runs …`, `serves <patterns>`, the file.
- What to wait for in a turn: `⊘ write secret.txt · refused by the hook "<name>"` with the reason under it; under an edit `note from the hook "<name>", added to the result: …` and `the hook "<name>" printed: …` (its stderr); `· N new diagnostics from <server>` on the edit's row; `↻ the stop hook "<name>" did not let the turn end · the agent is sent back with what it said`; the ending `⚠ ended with the stop hook "<name>" unsatisfied · …` (set `maxStopRounds: 1` and script one more response than the turn would need: the model is called once more). A stored session (`tui -c`) shows all of these again, without the `⚠ hook:` lines, which are live only.
- For the edit to get diagnostics the server must be up: script a `read` of the file first (it starts the server), then `{ "type": "delay", "ms": 2500 }` before the `write`. Reset the file between runs (`git checkout`): an edit that changes nothing has nothing new to report.
- The line CLI asks the same questions at its prompt, one after the other (`[y] allow it · [N] not now ›`). Wait for the answer's line (`approved: the hook …`) before typing the next `y`: an answer typed with no question up is sent as a message.

## Send keys

```sh
$T send-keys -t tui Enter            # named keys: Enter Escape Tab BSpace Up Down PageUp PageDown Home End
$T send-keys -t tui C-c C-d C-o C-t C-p   # control keys
$T send-keys -t tui M-Up M-Enter     # Alt (meta) keys: Alt-Up selects a row, Alt-Enter is a new line
$T send-keys -t tui -l "/undo"       # literal text: -l, or tmux looks words up as key names
printf 'line 1\nline 2' | $T load-buffer -b p - && $T paste-buffer -p -d -b p -t tui   # bracketed paste
$T send-keys -t tui -l $'\e[<64;10;5M'   # mouse wheel up at column 10, row 5 (65 = down), SGR encoding
```

In tests: `term.keys("C-c")`, `term.type("text")`, `term.paste("a\nb")`, `term.wheel("up")`.

## Wait for output

Always a bounded poll of the captured pane, never a bare sleep:

```sh
until $T capture-pane -p -t tui | grep -q "● ready"; do sleep 0.05; done
```

In tests: `await term.waitFor("● ready")`, `waitFor(/regex/)` or `waitFor((frame) => ...)`, with `timeoutMs` (default 10 s; give the ACP server 20 s to start under load, a live turn 120-180 s). A failed wait throws with the last frame, which is usually the diagnosis.

What to wait for:
- A turn's ending by its number: `wait "· turn 1"`, never `"turn 1"`, which matches the status line's `turn 665ms` while the turn runs.
- A question about the project's configuration at open: the status line says `? waiting for your answer · the hook "<name>"` (or `the MCP server "<name>"`, `the language server "<name>"`) instead of `● ready` until it is answered; wait for `● ready` only after the last answer.
- Leaving: Ctrl-D takes about two seconds to print the resume line; poll for `status=` from the wrapper, never one capture.
- Ready for input: the status line (third row from the bottom) shows `● ready`. While the agent works it shows a spinner and what runs; while starting, `⋯ starting the engine`.
- A turn's end: `● ready` again after it was gone (`waitFor(f => !f.includes("● ready"))` first), or the ending row (`○ done`, `✓ done · checks passed`, `✗ unresolved`, `■ interrupted`, `✗ failed`). Counting ending rows in one frame does not work once earlier ones have scrolled off.
- A program's exit: `await term.exited()` reads the recorded status; then poll the screen and the modes (see Known issues).

## Capture and read a frame

```sh
$T capture-pane -p -t tui           # the visible screen as text
$T capture-pane -p -S - -t tui      # with the scrollback: what was printed after the TUI left the alternate screen
$T capture-pane -p -e -t tui        # with SGR escape sequences, to check colours and attributes
$T display -p -t tui '#{alternate_on} #{mouse_any_flag} #{cursor_flag}'   # terminal modes left set
$T pipe-pane -o -t tui 'cat >> /tmp/raw.log'   # every byte the program writes, in order, from now on
```

- Layout of a frame: conversation on the left; the panel (`│ Session …`) on the right at 100 columns and wider; then status, input (`› `, or `steer › ` / `queue › ` while the agent works) and hints. To compare a sentence that wraps, take each line's part before `│` and join them (`conversation()` in `terminal.e2e.test.ts`).
- Colours are palette indices (`38;5;1` red … `38;5;6` cyan) and default fg (`39`), never RGB for text, so they follow the terminal's theme. With `NO_COLOR` no `38;5;n` appears; states still differ by symbol and word (✓ ○ ✗ ■ ⚠ ↻).
- `cut -c` on a captured frame cuts multi-byte characters (`│`, `…`) into garbage; cut with Python or `Bun.stringWidth`, not bytes.

## Resize

```sh
$T resize-window -t tui -x 60 -y 20
```

Set `window-size manual` on the session first (the helper does), or tmux sizes the window to an attached client. After a resize wait for a frame with the new number of rows, then check that no line is wider than the new width. Below 100 columns the panel hides itself (Ctrl-P shows it from 60).

## Kill and clean up

```sh
$T kill-session -t tui; $T kill-server; rm -f /tmp/tmux-$(id -u)/windlass-manual
```

To kill the ACP server under a running TUI: `pgrep -P <TUI pid> -f "main.ts acp"`, then `kill -9 <pid>` (the TUI pid is the pane's pid when the command is exec'd, otherwise a child of it). `term.children("main.ts acp")` does this in tests. Tests kill their sessions in `afterEach` and call `killServer()` in `afterAll`, which also removes the socket file and the helper's directory.

## The suites

```sh
bun test packages/tui                       # everything: about 160 tests, 45 s to 3 min on two cores, by the load
bun test packages/tui/test/terminal.e2e.test.ts      # tmux only: demo turn, steer, Ctrl-C once and twice, crash, resize, undo, sessions, killed server, server stderr,
                                            #   approval approved / declined with a note / cancelled by Ctrl-C, typing kept, taint and /clear-taint, /diff
bun test packages/tui/test/approval.test.ts # component tests of the dock, the safety rows, the mode picker and the diff view at fixed sizes
bun test packages/tui/test/subagent.e2e.test.ts # a subagent's question in the dock, its row collapsed and expanded, the panel, a reloaded subagent (real engine events)
bun test packages/acp/test/client.e2e.test.ts   # the shared protocol client the TUI and the CLI use
bun test packages/tui/test/frames.test.ts --update-snapshots   # after an intended change to the showcase frames
```

## Quick manual pass (two minutes, no model)

Worth doing after any change to the TUI, before the test suite:

```sh
T="tmux -L windlass-manual"
$T new-session -d -s tui -x 120 -y 34 "bun packages/cli/src/main.ts tui --demo find-and-fix-a-failing-test --demo-speed 3; echo status=\$?; sleep 120"
until $T capture-pane -p -t tui | grep -q "● ready"; do sleep 0.1; done
$T send-keys -t tui Enter                                   # the demo prompt is pre-filled; Enter plays the turn
until $T capture-pane -p -t tui | grep -qE "○ done|✓ done"; do sleep 0.1; done
$T capture-pane -p -t tui                                   # read the whole frame
$T send-keys -t tui M-Up; $T send-keys -t tui M-Up; $T send-keys -t tui C-o   # select a tool row and expand it
$T capture-pane -p -t tui
$T kill-server; rm -f /tmp/tmux-$(id -u)/windlass-manual
```

What a good frame shows: tool rows with outcome and duration, the turn ending row with its verification state, the changed-files line, and on the right the panel with session totals, the last call, and one cache bar per model call (the first call 0% cached, later ones high).

Reviewed at 80, 100, 120 and 200 columns (2026-11-12): the demo hint wraps instead of being cut by the panel; the demo's panel shows the context window (the scenario's, or 272k); the idle hint at exactly 80 columns was cut mid-key ("Ctrl-P panel · C…") and now falls back to its short form; the help at 80 columns ran past the screen with wrapped lines at column 0 and a key run into its text ("\ at the endnew line") and now wraps under its keys and scrolls; the approval mode picker cut each mode's description and now says them in full above the list; titles are shortened at a word.

## Known issues and gotchas

- Send the text and Enter apart (`send-keys -l "<text>"`, wait about half a second, then `send-keys Enter`): an Enter that arrives with a `/command` still being typed can be eaten by the command palette, and nothing runs.

Everything here was hit while building and testing the TUI (2026-11-12).

- **pkill killed the tmux server.** `pkill -f "WINDLASS_ACP_SCRIPT=..."` matched the tmux server, whose argv holds the session's command; every pane died with EIO (`setRawMode failed with errno: 5` in the TUI's stderr). Kill by PID.
- **`pane_dead_status` is not reliable.** tmux marks a pane dead when its pty closes, which can come before it reaps the process; the status was then empty (read as 0) about one run in five, and once the process sat as a zombie for seconds. The helper runs the program under `sh -c '<command>; echo $? > <file>; exec sleep 600'` and reads the file.
- **A dead pane reports a hidden cursor.** `#{cursor_flag}` was 0 after every exit path although the raw output ended with `\e[?25h`: tmux hides the cursor of a dead pane. Read modes while the wrapper shell still holds the pane; `pipe-pane` shows what the program really wrote.
- **The exit is known before the last bytes are drawn.** Right after the exit status appeared, a capture still showed the alternate screen, or an empty main screen without the line printed after it. Poll the screen (`waitFor`) and the modes (`term.until`) after `exited()`, never one capture.
- **`process.exit` right after `renderer.destroy()` hung** (the second Ctrl-C under tmux: terminal back, process never ended). OpenTUI's `renderer.closed` must be awaited first; the TUI does this on every exit path.
- **A message written right after `destroy()` vanished** with the alternate screen (`destroy()` leaves it asynchronously): the crash message is written only after `closed`. Check printed exit lines with `capture-pane -S -`; a crash's stack can scroll the first line off the visible screen.
- **Bun prints an uncaught error itself** (with source excerpt) before the TUI's `uncaughtException` handler runs; the crash test sees both. Inject a crash with `bun --preload <file that throws from a timer>`.
- **A lone Esc needs a moment.** The key parser waits to tell Esc from the start of an escape sequence; the component tests sleep 80 ms after `pressEscape()`. tmux's own `escape-time` (500 ms by default) also delays Esc: the helper sets it to 10 ms.
- **The demo pre-fills the input** with the scripted prompt, so Ctrl-D (quit on an empty input) only edits it until the turn is sent. Send Enter first, or clear the input with Ctrl-C.
- **The pending steer line shortens the message** to fit the width (`↳ steering: "also tell me the te…"`). Wait for its start, not the whole text.
- **The panel shares the conversation's rows**: flattening a frame to one line mixes panel text into a wrapped sentence.
- **Several TUIs on one session**: a session is open in one process at a time; `--continue` in three panes at once left two waiting on a session in use. Use one workspace or data directory per pane.
- **A styled TextRenderable's `content.toString()` is `[object Object]`.** Comparing it with a string on every frame made the TUI re-render forever: 9% CPU at idle until fixed (now 0%). Measure idle CPU with `/proc/<pid>/stat` over a few seconds after `● ready`.
- **Mouse reporting is on** (wheel scrolling): text selection needs Shift-drag in most terminals, and inside tmux the copy mode of the outer tmux.
- **Esc then text in one burst is Alt-<letter>.** `send-keys Escape` followed at once by `send-keys -l "Fetch …"` lost the "F": the key parser read `ESC F` as Alt-F. Send Escape, wait 100 ms or more, then type.
- **A second turn's "○ done" is already on the screen.** Waiting for `○ done` after the second prompt matched the first turn's ending row at once. Wait for text only the new turn has (its reply, a unique tool row), or for `● ready` to go first.
- **The dock does not take keys from someone typing**, by design: a test that typed its prompt less than 1.2 s before the question arrived saw `Tab answers the question` and its `a` went into the input. Submitting clears that (a sent message is not typing). Wait for the focused footer, then 0.5 s for the arming; or press Tab, which toggles (Tab on a focused dock gives the keys back).
- **The network question has no "project" choice** (network is never remembered for a project), so `p` is absent and Up/Down counts differ from a file question's. Read the choices before scripting keys.
- **An "outside" path under /tmp is not outside.** With the workspace in /tmp, a path beside it is the session's own temp directory: no question, no taint. Use `/var/tmp` (or the home directory) for the outside directory in tests.
- **A cancelled question was recorded as a refusal.** The client answered the pending `session/request_permission` with `cancelled` right after sending `session/cancel`; inside the server the answer overtook the cancel and the engine recorded `approval.answered` with `deny`. The shared client now answers once the interrupt is in the log (at most 1 s later); the dock leaves the screen at once.
- **Replayed turn endings came before the replayed events.** On `session/load` a full-fidelity client got every `_windlass/turn` before the events of the turns they end, so the changed files had no ending row to go to. Fixed in the server; a TUI test asserts a replayed ending gets its files.
- **`conversation()` does not read dialogs.** It splits each line at `│` to drop the panel, and a dialog's own borders are `│` too: check dialog text in the raw frame.
- **The live model may skip the failure.** Asked to fetch a URL it often asks for `sandbox: { network: true }` up front (the question appears in the first step); told "exactly this, no extra arguments" it reported the sandbox's DNS failure instead of asking. Steering ("ask for network access and run it again") then asked.
- **Engine work in progress breaks unrelated suites.** Another agent edits `packages/core` in this checkout; once every engine-backed test failed with `this.concludeReplay is not a function` from `engine.ts`. Not the TUI: retry a few minutes later, and run the component tests (no engine) meanwhile.
- **The live model's second call often reads 0% from cache** (seen in the panel's per-call bars: 89%, 0%, 90%, 83%). That is the provider's lag on quick follow-ups described in the harness-testing skill, not the TUI.

- **Parallel subagents race for the script.** Two `subagent` calls in one response start at once, and their children's model calls take scripted responses in whatever order they arrive: a child may get the other's script. With `WINDLASS_ACP_SCRIPT` keep one subagent per step; in-process tests give `FakeProvider` a function response that picks by the task in `request.input` (`packages/acp/test/client.e2e.test.ts`, "two subagents asking at once").
- **Two questions at once used to cancel each other.** The dock (and the CLI's prompt) answered a pending question `null` when the next arrived, which refused the first subagent's call (the CLI even interrupted the turn). The shared client now puts one approval question to a front end at a time and queues the rest.
- **The dock ignores letters for 0.4 s after it takes the focus by itself.** A component test that advanced the clock past `QUIET_MS` only, then pressed `a`, waited forever for the answer. Advance it by `ARMING_MS` too (both are exported from `src/approval.ts`).
- **A note added before a session opens stands above its history**, but a wait for the note returns before the history is there: `/fork`'s test waits for the note, a line of the inherited history and `● ready` together.
- **Forwarded subagent events are not stored.** A session opened again (`--session`, a fork, the picker) shows its `subagent` rows without activity (`↳ finished · expand to read its work`); expanding one reads the subagent's own log over `_windlass/events`. A test of the live view must feed `child.event`s; a test of a reload must give the backend `storedEvents`.
- **The subagent's task carries the harness's note to it** ("(You are a subagent. …)"). The TUI drops it from the expanded view; the stored message keeps it, so `--json` and the child's log show it.
- **Paths are cut inside an expanded subagent at 100 columns** (the frame and the panel take room): match `✓ write \S+ · created`, not the whole path.
- **A server that died at start showed Bun's banner as the reason** (`… before it was ready: Bun v1.4.0 (Linux arm64)`), after the runtime's source excerpt on stderr. The shared client now holds the server's raw output until it is ready and names the uncaught error's message. Inject it with a fixture that throws at the top level as the server command.
- **A CLI killed with SIGKILL leaves its `windlass acp` shutting down for up to 5 s**, holding the session. A command with `trap '' TERM` in the scripted turn keeps that window open long enough to test; the next `--continue` now waits for the orphaned server (its parent is init or the systemd user manager) and says so.
- **Leaving without a session open exits 1** (fixed 2026-11-12; it was 0). `tui -c` on a session another TUI holds shows `✗ could not open the session … /reconnect`; Ctrl-D then exits 1 and prints `windlass: could not open the session: …` after the screen is back. The same for signed out and for an engine that died. Read the status from the wrapper (`echo status=$?`), the sentence with `capture-pane -S -`.
- **With no sign-in** (a throwaway `XDG_DATA_HOME`) the conversation says `✗ not signed in`, then `To sign in, run windlass login in another terminal …` and `Then type /reconnect here`; a sent message gives `! not sent: not signed in; run windlass login in another terminal, then /reconnect`. To test that `/reconnect` picks a sign-in up without a restart, write a synthetic `auth.json` (any strings, `expiresAt` an hour ahead, mode 0600) into the throwaway data directory and type `/reconnect`: `● ready` follows. The TUI then lists models with that fake token, which is one request to the provider that fails; do it once, never with a real token.
- **After `/undo` the panel's `context` figure is stale** until the next model call.
- **An undone turn is one dim line** where its prompt was: `↶ undone turn 2: "<prompt>" · out of the conversation · /redo brings it back` (the explanation is shortened first on a narrow pane), also in `tui -c`; its other rows are not drawn. Wait for `↶ undone turn`; the note after the undo says `↶ undone: turn 2 "…"`.
- **Ending rows carry the turn number** (`○ done · … · turn 2`), which `/fork <n>` takes. A message queued with `/queue` (or Ctrl-T) is a turn of its own with an ending row of its own: the turn before it ends `○ done · … · 1 step · 4.1s · turn 1 · on to the queued message` (its own steps, time, tokens and files), then the queued message's row (`↳ delivered from the queue`), its answer, and `… · turn 2`. `/diff` and Ctrl-O on the first of the two show that turn's own files: the server takes the ending row's `seq` as `endSeq` and diffs that turn alone (checked live in tmux, 2026-11-12: a fix turn's `/diff` had its two files, not the queued turn's README). On a replay (`tui -c`) the server sends no file lists, so only the ending whose diff the TUI fetched says `changed N files`; the others say `edited N files: … (from its tool calls)`.
- **The steer tag goes on its own line** when the message fills the width (`  ↳ steered into the turn`); it is never cut any more.
- **Ctrl-C at an idle, empty prompt says `· press Ctrl-D or type /quit to leave`** (seen 2026-11-12, connected and signed out); a demo's pre-filled input is cleared by it instead.
- **An unknown `/word` is not sent**: the TUI answers `/<word> is not a command, so nothing was sent; did you mean /<nearest>?` and `//text` sends `/text`. A test that types a message starting with a slash must double it.
- **Alt-Up selects the turn's ending row first**; a subagent's row is two more Alt-Ups up, and selection skips plain shell rows. Alt-PageUp / Alt-PageDown (`send-keys M-PageUp`) select the ending row of the turn before or after the selected row (with nothing selected, up is the latest turn's): use them to reach an earlier turn for `/diff`, `/review` or `/fork`.
- **Under load, start-up is slow**: at a load average of about 11 on two cores, start to `● ready` took 3.5 to 6 s. Allow 30 s when other agents are running.
- **A background `shell` row looks exactly like a finished one**; check the process with `pgrep -P`.
- **The `■ stopping…` row stays above `■ interrupted`**: wait for the second, not for the first to go.
- **`/sessions` cuts IDs to `ses_4…`** and forks share a title: match a row on its age or title, not its ID.
- **A glyph the test renderer draws in one cell can take two in a terminal.** `☰` (the first mark of the task list) left a stray space after it in tmux while every component frame looked right; `Bun.stringWidth("☰")` is 2. Check a new symbol with `Bun.stringWidth` before using it (the list uses `≡` now).
- **A running pane keeps the code it started with.** After an edit, a frame from a session started before it showed the old rows (a duplicate `instructions updated (agent)` under the switch). Kill the session and start a new one before judging a fix.
- **A switch of agent used to show twice**: the instruction message that tells the model (`· instructions updated (agent): The user switched you …`, six wrapped lines) and the switch row. The first is not drawn any more. The agents index (`· instructions updated (agent-index): …`) still is, on the first turn of a session whose workspace has agents: five dim lines a first-time user has to read past.
- **Two questions at once backed each other out in the line CLI** (found in tmux, 2026-11-12): a project with a hook and a language server sends both questions together; the second took the prompt and the first was answered "not now" unasked, so the typed `y` approved the wrong thing. The in-process test had one question per session and missed it. Patient questions now wait for each other (`Questions.patient`); test with both in one project.
- **A test that presses Ctrl-D while a turn still runs hangs**: Ctrl-D is ignored then, and nothing exits. After answering a question that came up during a turn, wait for the turn's reply or its ending before leaving.
- **A project's command was cut in its own approval question** (line CLI: a word wider than the terminal ended in `…`; dock: two lines, the rest dropped; arguments unquoted). The question now shows all of it, each argument quoted (`bash -c '<one argument>'`); a command too long for the dock (60% of the height) is printed in full above it and the dock says `… N more lines of the command do not fit here: the whole of it is printed above, to its end`. Test with one very long word that ends in a marker, at 80 columns in the CLI and 100 in the TUI, and read the frame before answering. The engine's own notice about a skipped hook (`⚠ hook: … (<command>…)`) still shortens the command at 120 characters: that line is not the question.
- **A problem with an agent definition marked the model call that was running** with `⚠` in the panel's bars (`⚠ diagnostic`), as if the request were wrong. Diagnostics of kind `agents` mark no call now; `skills` and `mcp` ones still do.
- **`/undo` of a turn that had a task list removes the panel's `Tasks` section**; wait for it to go, not for a row.
- **A turn's ending row with compactions** reads `○ done · … · 14 steps + 2 summary calls · 1m09s · turn 1`: match the parts, not the whole line.
- **Picking an agent**: `/new`, then `/agent`, type the start of its name (`rev`), wait 0.6 s, Enter.
- **A long command in an approval question**: put a marker at the end of a long word and look for the marker before answering; the dock prints a command too long for it above itself and says so.

## Measured (two-core aarch64, 2026-11-12)

- Start to `● ready`: 0.37 s with the demo engine, 0.7 s with the `windlass acp` child (most of it the server).
- CPU: 0% idle; 4% during a demo turn; 18% of a core with about 90 text deltas a second; a 110 KB reply in about 14,000 deltas renders and settles in 1.1 s. RSS 115 MB, 250 MB after that reply.

## Command files, questions before a message, notes before the first message (2026-11-12)

- A command file is `$TMP/work/.claude/commands/<name>.md` (`frontend/test.md` is `/frontend:test`); front matter `description` and `argument-hint` are optional. With a scripted model the turn's response is whatever the script has next: what proves the command worked is the row, not the answer. Full-screen: `› /release-notes 1.4`, then `the text of a command file was sent (2 lines) · from this project: <file>`, then one `⚠` line per argument that was not given and per `` !`cmd` `` or `@path` left as text; Alt-Up to the row and Ctrl-O shows the text that was sent under `│`. Line interface: `· /release-notes 1.4 · the text of a command file was sent (2 lines)`, `from this project:` and the file on a line of its own.
- The palette lists command files after the built-in commands once `/` is typed (they are listed again each time an entry starts with `/`): wait about 0.5 s after typing `/rel` before reading the pane. Enter on one with an `argument-hint` completes it and waits for the arguments.
- A typo (`/relase-notes`) is never sent and names the nearest of both sources; a file that cannot be used (`agent: not a name` in its front matter) says why with its path. `/help` lists the files under `Your commands`, in the full-screen interface at the end of the dialog: use a pane at least 100 rows high, or scroll, to read them.
- A project's hook or language server that waits for approval holds a message typed before the answer: the conversation says `your message is sent once the question below is answered` and the dock keeps the question. The dock does not have the keys right after typing: press Tab, wait 0.5 s, then `a`. The held message is sent when the answer is recorded; check the turn's rows, not the input.
- A project's MCP server is asked about at open, after its hooks (and language servers): wait for `Start it for this project` after answering the hook. Approved before the first message, the agent has its tools from that message. `/mcp` words a server named in a file the session has not read yet as `not read yet: a project's server is asked about with the next message` (rare now: a server added to the file after the session read it).
- With memory on in a throwaway `XDG_CONFIG_HOME` (`{ "memory": { "enabled": true } }` in `<dir>/<brand directory>/config.json`), `/remember <text>` before the first message answers that the note is kept; after the first message's turn a line starting `your note from before the first message: Saved m_…` follows. The note's file is under `XDG_DATA_HOME`, so give the run a throwaway one or `/forget` it.
- A deep workspace path is the test for the line interface's paths: capture with `capture-pane -p -S -` (no `-J`) and grep for the file's name at the end of the path; with `-J` tmux joins the wrapped rows and a cut path would look whole. `grep -c "…"` over the capture counts what was cut (an `instructions updated (memory)` line is cut by design; a path never is).
- A scripted `shell` call refused by a user or approved project hook (`"command": "case \"$<PREFIX>HOOK_COMMAND\" in *'git push'*) echo 'no'; exit 2;; esac; exit 0"`) is `⊘ shell git push · refused by the hook "<name>"` with the hook's words under it, in both interfaces; a call the session's agent may not make is `⊘ … refused by the <name> agent: it may not change files`.

## Stopping one call, watches, and wake-ups of the user's own (2026-11-12)

- Stop one call: script a `shell` call that hangs (`"command": "echo started; sleep 300"`), wait for its row to say `running`, then `send-keys C-x`. While a call the key would act on runs, the hints line reads `Ctrl-X stops shell <command> only (the turn goes on) · Ctrl-C stops the turn · …`. The row becomes `■ shell … · stopping`, then `■ shell … ⊡ · stopped by you · <time>` with what it had printed under it, and the turn goes on to the next scripted response (give the script one). With several calls running, select one first (Alt-Up); `/stop` is the same act. In the line interface it is `/stop` (`/stop <number>` with several running).
- The key does nothing until the call has started: a `/stop` or Ctrl-X sent with the row still `waiting to run` answers `no tool call is running`. Wait for `running` on the row (TUI) or retry until `■ stopping` appears (line interface).
- A watch: script a background command that prints a line late (`"command": "echo booting; sleep 8; echo 'Server listening on :3000'; sleep 300", "background": true`), read its ID from the `◌ background bg_… ·` row, then `/watch <id> listening on`. Rows to wait for: `◉ watching background <id> for text "listening on"`, then `◉ watch <id>.w1: background <id> printed a matching line (1 of 1) · the agent is told · sent by the watch, not typed by you` with the line under it. The firing wakes the idle session, so the script needs one more response for that turn. `/watch` alone lists the commands and their watches; an unknown ID answers with the engine's sentence (`No background command … is running`).
- Wake-ups of the user's own: `/wakeups add in 20m <message>`, `at 17:30`, `every 1h`, `webhook`, and `check 5m "<command>" <message>`. A check opens a dialog (`Run this command every 5m until it exits 0?`) with keys `s` (sandbox), `w` (sandbox with network), `u` (no sandbox), `n` (do not set it up): send the key with `send-keys -l "w"`. A webhook prints `⏰ Webhook wake-up created <id>` with `URL` and `secret whsec_…` once; `/wakeups` afterwards has the address and no secret. The interactive server fires wake-ups, so a check runs at once: its listing says `Last run: exit 1 at …` within a second.
- After typing a `/command` with arguments, send Escape before Enter (`send-keys -l "/watch"; sleep 0.6; send-keys Escape; sleep 0.3; send-keys Enter`): the palette is open while the entry is one word, and Enter then completes the chosen command instead of running what was typed.
- Capturing with `cut -c1-N` narrower than the pane cuts the ends of wrapped rows (`sent b` for `sent by`): read the pane's own width, or match the start of a row.

## Reviewing a turn's diff: /review (2026-11-12)

- Script a turn that edits two files, so there is an added and a removed line: a `write` over a committed file (`README.md` in the workspace's first commit) and a `write` of a new one. Give every response a `usage` item when the test reads the trace afterwards.
- `/review` (wait for `/review  review the selected turn` in the palette, then Enter) opens the latest turn; wait for `Review of turn 1 · no comments yet · 2 files`. The cursor (`▌`) starts on the first changed line. `r` in the `/diff` reader opens the same view.
- A comment: `send-keys -l "c"`, wait for `─ comment on README.md, line 1 of the old file (removed) ─`, type, Enter, wait for `◆ 1 comment` on the first row. `]` goes to the next hunk's first changed line (the next file's, when the file has no other hunk), `n` to the next file's own line. The comment is under its line after `╰`, and the cursor's mark runs down the comment's rows too.
- Send: `s`, wait for `Send this review to the agent?` (the message is shown as it will be sent), type the overall note, Enter. The conversation then has one `› Review of the changes in turn 1 (the latest turn): …` row and the scripted model's next response answers it: give the script one more response.
- What the agent received is in the stored session: `bun scripts/export-trace.ts --list --data-dir $XDG_DATA_HOME/<the brand's directory>` gives the session's ID, the same script with the ID prints one JSON line per model call, and the last `message` block with key `user` of the last call is the review (`packages/tui/test/review.e2e.test.ts` does this). A call whose response had no `usage` is not exported: the trace was empty until the script had them.
- Esc inside a comment cancels the comment only; a second Esc leaves the review, and the conversation then says `the review of turn 1 was closed without sending: its comment is kept until this session is closed`. `/review` again shows the comment.
- The two line-number columns are as wide as the largest line number of the diff, so the spaces between `▌` and the sign differ from diff to diff: match `▌\s+1 \+first note`, or take the exact row from a first capture.
- At 62 columns the comment being written wraps in the editor (up to 6 rows) and the hints fall back to their short form; after a resize the editor follows with the next frame.
- Tests: `bun test packages/tui/test/review.test.ts` (the view as plain values, and in the app on the test renderer), `bun test packages/tui/test/review.e2e.test.ts` (tmux, the real server).
- A review that could not be sent keeps its comments: at the last look (`Send this review to the agent?`) kill the server (`pgrep -P <TUI pid> -f "main.ts acp"`, `kill -9`), press Enter, and the conversation says `not sent: no session is open; /reconnect first, or /quit · the review of turn 1 is not lost: its comment is kept until this session is closed · /review opens it again`. After `/reconnect`, `/review` shows the comment.
- A question under the view: script a second turn whose first response is `{ "type": "delay", "ms": 4000 }` and then a `write` outside the workspace (`/var/tmp/...`), send the message, open `/review` (or `/diff`) during the delay. When the question arrives the review shows `? a question is waiting for your answer · Esc leaves the review to answer it: your comments are kept` above its keys, and the reader's footer starts `? a question is waiting for your answer · Esc closes this view to answer it`. After Esc the dock is there, not focused: Tab, wait 0.5 s, then the answer.

## What a user's run found, and what holds after the fixes (2026-11-12)

- **Questions at open.** They used to appear only after a message or `/hooks approve`: the server's notice could arrive before the TUI listened for it, and a session opened with `/new` never asked about what an earlier session of the run had been asked. The TUI now reads the hooks and language servers itself when a session opens. To test the second case: answer both `n`, `/new`, and wait for `─ ? This project's configuration asks to run a hook` again. A project's MCP server is asked about at open too, after its hooks and language servers.
- **Several questions in a row are easy to approve unread**: a question takes the keys 0.4 s after it appears, so five `a` keys 1.6 s apart approve five queued questions. Capture the pane between answers and read the title before the next key (`until … grep -q "<the next title>"`).
- **Ctrl-T's queue mode stays on** for later turns (the mode label says `queue ›` again at the next turn) until Ctrl-T is pressed again: a test that queued one message must press Ctrl-T back before it steers. The label follows the key at once now; it used to stay `steer ›` under a hint that said `Enter queues` until the next key or event.
- **The dock spans the full width** of the terminal, under the conversation and the panel: its lines are not cut at the panel's `│`, so `conversation()` (which splits at `│`) still reads them whole.
- **A command's answer typed just as a turn ends** (`/skills`, `/rename …`) stands under the turn's ending row, not between the answer and the ending. A line typed in the middle of the turn (rows of the turn follow it) stays where it was said, and `■ still stopping…` stays inside the turn.
- **Wrapping.** Text wraps between words whatever their styling: `` `core/brand.ts`, `` keeps its comma and `(see `docs/x.md`).` its brackets. Only a word longer than the row is broken, starting on the row it began on. To test, script an answer with inline code followed by punctuation and capture at several widths (`resize-window -x 60`, `80`, `100`); a row must not start with `,` `.` `)` `:`.
- **A refused follow-up to a subagent.** Agents `planner` (`tools: read, subagent`) in the workspace; script `[[subagent {task}], [child: text], [parent: text]]`, then `/agent planner`, then a turn `[[subagent {task, "session": "ses_"}], [text]]` (the prefix `ses_` names the only subagent). The row is `⊘ subagent <task> · refused by the planner agent` with `The follow-up was not sent: subagent ses_… was started before this session ran as the agent "planner", …` under it. Under a read-only agent the same call is refused earlier, by the agent's rule about tools (`"subagent" runs commands`), which was always drawn as refused.
- **A watch ended as too slow** reads `◉ watch <id> ended: its pattern took too long to match a line`. It needs a pattern that backtracks on a real line; the component test (`packages/tui/test/watch.test.ts`) feeds the event instead.
- **Arguments a command file has no place for**: `/release-notes 1.4 extra` on a file that uses only `$1` shows `⚠ argument 2 ("extra") was not used: the command file has no place for it, so it is not in the text that was sent` under the command's row, also in `tui -c`.
- **An undo after files changed while a command ran**: script a `shell` call with `sleep 5` in it, and while its row says `running` create a file in the workspace and append to one the session wrote earlier (a file the command itself writes is the command's and is not asked about). `/undo` then shows the plan with `<file> (changed while a command ran)` and a dialog titled `Undo: 2 files changed while a command ran`, whose first line is `2 files changed while a command ran (or the checks), which may be the command's own work or yours: <files>`. What each answer does is said whole above the choices (`Overwrite: …`, `Keep: …`); the choices are `[y] Overwrite`, `[2] Keep`, `[n] Change nothing`. A file changed with nothing running keeps the server's title (`… changed outside this session since the turn`). To read a dialog that the panel stands beside, take each line's part between its two `│`.
- **A compaction that retired images** says ` · N images of earlier tool results no longer sent` on its row; it needs a conversation long enough to compact with image results in the kept part, so it is covered in `packages/tui/test/transcript.test.ts`.
- **A scripted model starts over with the server**: after `/reconnect` (or `tui -c`) the script's first response is next again. Write the script for what follows before reconnecting.
- **Keys sent to a view that did not open go to the input**: `/review` right after `/redo` did not open once, and `c`, the comment and Enter were sent as a message (the scripted model then had no response: `FakeProvider: call N was not scripted`, with retries). Wait for the view's first line (`Review of turn`) before its keys.
- **The worktree of an agent has no `node_modules`**: `bun install --frozen-lockfile` there first, or the TUI exits with `Cannot find module` and the pane shows `status=1`.
- **Component tests time out while a tmux run goes on** on a loaded machine (`a beforeEach/afterEach hook timed out`): run them again alone before reading it as a failure.

## A user's second and third run (2026-11-12)

- The palette shows at most seven rows and pads the names into a column: match `/review\s+review the selected turn`, not two spaces.
- Count a run's live requests with `bun evals/dogfood/calls.ts --cwd <workspace>` (it counts the subagents' sessions too); the panel's `calls` row counts the parent's only.
- **A steer counts as a message for `/undo`.** After a turn that was steered and then followed by a queued message, the first `/undo` takes the queued turn, the second goes back to before the steer, in the middle of the first turn: its rows from the steer on are hidden, the steer's row is `↶ undone steer: "<text>"`, and the line after the undo says `↶ undone: your steer "<text>" and what followed it · … · N files as they were before the steer`. A second `/undo` names only the turn it took (it used to say `turns 4 to 5` with turn 5 already out), `/redo` only the turns it put back.
- The plan line before an undo (`↶ going back to before turn N "…"` with the files under it) is printed only when files change or a question follows; an undo with no file to change prints only its result line.
- The panel is 38 columns, a quarter of a wide terminal up to 52 (50 at 200 columns), and its session names share one column: `trust    untrusted · /clear-taint`, `approval auto · sandbox ⊡`.
- `/help` is as wide as the terminal up to 140 columns; a key longer than its column (a command file with arguments) has its description on the row under it.
- The status line names a background command, a running call and the call a question is about with as much of it as the line has room for (at least 24, 60 and 40 characters).
- The dock's title (the question) wraps under itself on up to three rows: at 100 columns a hook's question is two rows. Match its first words, not the whole title on one row.
- `/new` from a session with a turn says `· new session · the one before, "<title>", is kept: /sessions goes back to it`; from an empty one the welcome stays.
- In a demo the hint line says `Enter plays the demo's next message` while the next scripted prompt is in the input, and `the demo has played all its messages` after the last (`the demo is over · Ctrl-D quit` when narrow). Multi-turn demos (`two-turns-in-one-session`, 75, 108) used to look finished after their first turn.
- The panel's `context … of <window>` needs the model listing, which needs a sign-in: with a scripted model and a throwaway data directory it is `(window unknown)`, which is right. With a sign-in, a listing that failed once (seen on one `tui -c` live) is asked for again after 30 s, at the next model call.
- **The tmux helper's own race**: `kill-session` of the last session makes the tmux server exit, and a `new-session` sent right after can fail with `server exited unexpectedly`. Start each run with `kill-server`, a short sleep, then `new-session`.
- Under a load average above 10 (other agents), `bun run typecheck` took over two minutes: run it in the background and go on reading frames.

