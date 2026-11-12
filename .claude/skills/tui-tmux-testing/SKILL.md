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
cd /home/ubuntu/projects/light-harness
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

- The approval dock opens above the input. It takes the keys only when the input is empty and nothing was typed for 1.2 s, and then ignores its own letters and Enter for 0.4 s; otherwise its last line says `Tab answers the question` and everything typed goes to the input. Focused, its last line starts `↑↓ Enter · a s p n m`. Answer `a` once, `s` session, `p` project (not offered for the network), `n` no, `m` no with a note (type it, Enter). Esc gives the keys back to the input; Ctrl-C stops the turn and answers `cancelled`.
- While a question waits the status line says `? waiting for your answer · <tool> <argument> · <time>`, and the call's row `? <tool> … · waiting for your approval`.
- A command's row ends in `⊡` when it ran in the sandbox, `⊡ +network` / `⊡ +write <dir>` with extra access, `· no sandbox` without it. A refused call is `⊘`.
- `/approval` (picker, or `/approval ask`), `/clear-taint` (asks first), `/diff` (full-screen per-file diffs of the selected step or turn, the latest by default; n and p jump between files, Esc closes).

```sh
$T send-keys -t tui -l "write it outside"; $T send-keys -t tui Enter
until $T capture-pane -p -t tui | grep -q "↑↓ Enter · a s"; do sleep 0.1; done; sleep 0.5   # focused and armed
$T send-keys -t tui -l "m"; $T send-keys -t tui -l "keep it in the workspace"; $T send-keys -t tui Enter
```

## Agents, the task list, /rename and /compact

- Agents are Markdown files in the workspace: `$TMP/work/.claude/agents/<name>.md` with front matter (`name`, `description`, and `effects: read` or `tools: read, write`). `tui --agent reviewer` starts as one: the first row is `⇄ working as the agent reviewer (read only)` with its restrictions under it, and the panel has `agent  reviewer`. Set `XDG_CONFIG_HOME` to a throwaway directory too, or the user's own agents and `agents.default` are read.
- `/agent` opens a picker (`no agent`, then each agent with `read only · <description>`; the definitions that could not be used are in its detail, full paths wrapped). Type to filter (`docs`), wait about 0.3 s, Enter. The switch is a row drawn from its event, `⇄ agent reviewer → docs (restricted) · from the next step`, and is there again in `tui -c`. `/agent <name>` switches without the picker; `/agent none` switches off.
- A call the agent may not make: script a `write` under a read-only agent. The row is `⊘ write note.txt · not run: the reviewer agent may not change files`, never "approval policy", and the file is not created.
- A broken definition is said with the first turn (`⚠ agents: The agent definition at … was not loaded: …`), not when the session opens; `/agent` shows it at once.
- The task list: script a `todo` call (`{ "type": "tool_call", "callId": "c1", "name": "todo", "input": { "todos": [{ "text": "Read the code", "status": "done" }, …] } }`). The conversation shows `≡ tasks · 1 of 3 done` and one line per task (`✓` done, `▸` in progress, `○` pending); the panel has a `Tasks` section. After `/quit` and `tui -c` both are there again. At most one item may be `in_progress`, or the call fails and is drawn as a failed call.
- `/rename Login bug` answers `· renamed: Login bug` and the panel's `title` changes; `--list-sessions` and `/sessions` show it.
- `/compact` with a scripted model and a short conversation answers `· Not compacted: only about N tokens of the conversation could be summarised …` (the engine wants about 2,000 tokens it can take out, counted from the messages' text, not from scripted `usage` items); before the first turn, `There is nothing to compact: the conversation has not started.` A compaction that is made needs a long conversation and a summary response of the required form (`SUMMARY` in `packages/core/test/scenarios/script.ts`); it is covered in-process with `limits.manualCompactionMinTokens: 0` (`packages/cli/test/rename-compact.test.ts`, `packages/acp/test/rename-compact.test.ts`). It is drawn as `⇣ compacted the conversation · about <before> → <after> tokens` and no ending row follows it.

## Subagents, fork and replay

- A subagent shares the scripted model with its parent: one `responses` list, consumed in call order. A foreground child's calls come between the parent's call that starts it and the parent's next step: `[[parent: subagent call], [child: tool calls], [child: answer], [parent: answer]]`. The child asks like the parent does (a `write` outside the workspace); the dock then says `subagent: <first line of the task>` and the status line `? waiting for your answer · subagent <task>`.
- The `subagent` row: collapsed, one `↳` line (`starting`, `now: <tool> <arg>`, `it asks you something: answer below`, `finished after N steps, M tool calls`); selected (Alt-Up until `▌` is on it) and expanded (Ctrl-O), the child's own rows framed by `│ `, a second Ctrl-O shows all of them. A running subagent is in the panel (`agents ⋯ <task>`, `?` when it asks, `◌` in the background) and, in the background or after the turn, in the status line (`· 1 subagent at work: <task>`).
- `/fork` (or `/fork copy`) switches to the new session: the `⑂ forked from …` note first, then the history. `windlass fork` and `windlass replay` are one-off CLI subcommands; test them headless (`packages/cli/test/fork-replay.test.ts`), not in tmux.

## MCP servers, skills, wake-ups, memory, background work

- A project's MCP server (`.windlass/config.json` → `mcp.servers`; the core fixture `packages/core/test/mcp/fixtures/stdio-server.ts --only echo` is a real one) is asked about in the dock after the first message's `⚠ mcp: ... It was not started` line: `─ ? Start the MCP server "<name>" ...`, the command, `Defined in <file>`, the engine's details, `[a] Start it for this project` / `[n] Not now`. No "with a note" item. `a` → `✓ approved: MCP server "<name>" starts now`; the next `/mcp` shows `<name> · running · N tools` (the first `/mcp` right after can still say starting). A tool call's question displaces it and it comes back after. The approval is kept under the data directory: a fresh `XDG_DATA_HOME` asks again.
- An MCP call's dock shows `mcp_call  <server>/<tool>` and `sends: {...}` (the arguments), the row `mcp_call <server>/<tool>`.
- `/skills`, `/mcp`, `/wakeups`, `/memory` print notes in the conversation (the line CLI's words); long paths wrap, never cut. A webhook `wake_create` is followed at once by `⏰ Webhook wake-up created <id>` with `URL` and `secret`; `/wakeups secret <id>` again. Memory off: `· Memory is off. To turn it on, ...`.
- A background command: `◌ background <id> · <command>` with `output: <path on this machine>` (the tool's own output names the sandbox's `/tmp/.spill/...`), status line `● ready · ◌ background <id>: <command>`, panel `bg ◌ <id>: ...`, a note after the turn's ending row, and on `/quit` the TUI prints `windlass: leaving stopped the background command still running (<id>); ...` after the screen is gone.
- The panel counts a model call only when the response reports usage: a scripted response without a `usage` item leaves `no model call yet`. Give scripted responses `{ "type": "usage", ... }` when a test reads tokens.
- `/fork copy` shows the copy note (no ignored files, not a git repository); `/sessions` is 120 columns wide at most and marks a fork `⑂`, with `fork of <id>` and `in <dir>` for a copy elsewhere.
- The line CLI in tmux: keys typed before its prompt (even with Enter) are sent as the first message; a project's server is asked at the prompt (`[y] start it · [N] not now ›`), also after the turn ended.

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

- Layout of a frame: conversation on the left; the panel (`│ Session …`) on the right at 100 columns and wider; then status, input (`› `, or `steer › ` / `queue › ` while the agent works) and hints. To compare a sentence that wraps, take each line's part before `│` and join them (`conversation()` in `e2e.test.ts`).
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
bun test packages/tui                       # everything: about 75 tests, 45 s on two cores
bun test packages/tui/test/e2e.test.ts      # tmux only: demo turn, steer, Ctrl-C once and twice, crash, resize, undo, sessions, killed server, server stderr,
                                            #   approval approved / declined with a note / cancelled by Ctrl-C, typing kept, taint and /clear-taint, /diff
bun test packages/tui/test/approval.test.ts # component tests of the dock, the safety rows, the mode picker and the diff view at fixed sizes
bun test packages/tui/test/subagent.test.ts # a subagent's question in the dock, its row collapsed and expanded, the panel, a reloaded subagent (real engine events)
bun test packages/acp/test/client.test.ts   # the shared protocol client the TUI and the CLI use
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

- **Parallel subagents race for the script.** Two `subagent` calls in one response start at once, and their children's model calls take scripted responses in whatever order they arrive: a child may get the other's script. With `WINDLASS_ACP_SCRIPT` keep one subagent per step; in-process tests give `FakeProvider` a function response that picks by the task in `request.input` (`packages/acp/test/client.test.ts`, "two subagents asking at once").
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
- **Ending rows carry the turn number** (`○ done · … · turn 2`), which `/fork <n>` takes. A message queued with `/queue` (or Ctrl-T) is a turn of its own, so the second ending row of such a run is `turn 2` and `/undo` names that turn.
- **The steer tag goes on its own line** when the message fills the width (`  ↳ steered into the turn`); it is never cut any more.
- **Ctrl-C at an idle, empty prompt says `· press Ctrl-D or type /quit to leave`** (seen 2026-11-12, connected and signed out); a demo's pre-filled input is cleared by it instead.
- **An unknown `/word` is not sent**: the TUI answers `/<word> is not a command, so nothing was sent; did you mean /<nearest>?` and `//text` sends `/text`. A test that types a message starting with a slash must double it.
- **Alt-Up selects the turn's ending row first**; a subagent's row is two more Alt-Ups up, and selection skips plain shell rows.
- **Under load, start-up is slow**: at a load average of about 11 on two cores, start to `● ready` took 3.5 to 6 s. Allow 30 s when other agents are running.
- **A background `shell` row looks exactly like a finished one**; check the process with `pgrep -P`.
- **The `■ stopping…` row stays above `■ interrupted`**: wait for the second, not for the first to go.
- **`/sessions` cuts IDs to `ses_4…`** and forks share a title: match a row on its age or title, not its ID.
- **A glyph the test renderer draws in one cell can take two in a terminal.** `☰` (the first mark of the task list) left a stray space after it in tmux while every component frame looked right; `Bun.stringWidth("☰")` is 2. Check a new symbol with `Bun.stringWidth` before using it (the list uses `≡` now).
- **A running pane keeps the code it started with.** After an edit, a frame from a session started before it showed the old rows (a duplicate `instructions updated (agent)` under the switch). Kill the session and start a new one before judging a fix.
- **A switch of agent used to show twice**: the instruction message that tells the model (`· instructions updated (agent): The user switched you …`, six wrapped lines) and the switch row. The first is not drawn any more. The agents index (`· instructions updated (agent-index): …`) still is, on the first turn of a session whose workspace has agents: five dim lines a first-time user has to read past.
- **A problem with an agent definition marked the model call that was running** with `⚠` in the panel's bars (`⚠ diagnostic`), as if the request were wrong. Diagnostics of kind `agents` mark no call now; `skills` and `mcp` ones still do.

## Measured (two-core aarch64, 2026-11-12)

- Start to `● ready`: 0.37 s with the demo engine, 0.7 s with the `windlass acp` child (most of it the server).
- CPU: 0% idle; 4% during a demo turn; 18% of a core with about 90 text deltas a second; a 110 KB reply in about 14,000 deltas renders and settles in 1.1 s. RSS 115 MB, 250 MB after that reply.
