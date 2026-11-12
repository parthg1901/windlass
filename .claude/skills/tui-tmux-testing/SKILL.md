---
name: tui-tmux-testing
description: How to test the full-screen TUI (packages/tui) in a real terminal through tmux, against the scripted demo engine, the real `lh acp` with a scripted model, or the live model. Use before calling TUI work done, when a frame looks wrong on screen, or when an end-to-end TUI test is flaky.
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
T="tmux -L lh-manual"
# Scripted demo engine (no model, no server): any of `bun packages/cli/src/main.ts --demo list`
$T new-session -d -s tui -x 100 -y 30 "bun packages/cli/src/main.ts tui --demo find-and-fix-a-failing-test; echo status=\$?; sleep 600"
# Real `lh acp` with a scripted model, in a throwaway git workspace and data directory (no sign-in needed)
$T new-session -d -s tui -x 100 -y 30 "XDG_DATA_HOME=$TMP/xdg LH_ACP_SCRIPT=$TMP/script.json bun packages/cli/src/main.ts tui --cwd $TMP/work; echo status=\$?; sleep 600"
# The live model (check `bun scripts/login.ts status` first)
$T new-session -d -s tui -x 120 -y 40 "bun packages/cli/src/main.ts tui --cwd $TMP/work --model gpt-6-luna --effort low; echo status=\$?; sleep 600"
```

- `--demo-speed 4` plays a demo faster; `--demo-grace <ms>` makes a stopped command take that long to wind down (for Ctrl-C tests).
- A script for `LH_ACP_SCRIPT` is `{ "responses": [[items...], ...] }`, one list per model call; items are `text`, `reasoning`, `tool_call` (`callId`, `name`, `input`), `usage`, `delay` (`ms`), `finish`, `fail` (see `packages/acp/src/scripted.ts`). The workspace needs `git init` and a commit for undo to have snapshots.
- `LH_TUI_DEBUG=1` shows events the TUI does not know as dim rows; `NO_COLOR=1` turns colour off; `LH_TUI=1` makes plain `lh` (interactive, no prompt) start the TUI.
- In tests use `packages/tui/test/tmux.ts`: `Tmux.start({ width, height, command, env })` runs the command under a shell that records its exit status and keeps the pane, on a private server per test process.

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
$T kill-session -t tui; $T kill-server; rm -f /tmp/tmux-$(id -u)/lh-manual
```

To kill the ACP server under a running TUI: `pgrep -P <TUI pid> -f "main.ts acp"`, then `kill -9 <pid>` (the TUI pid is the pane's pid when the command is exec'd, otherwise a child of it). `term.children("main.ts acp")` does this in tests. Tests kill their sessions in `afterEach` and call `killServer()` in `afterAll`, which also removes the socket file and the helper's directory.

## The suites

```sh
bun test packages/tui                       # everything: about 50 tests, 35 s on two cores
bun test packages/tui/test/e2e.test.ts      # tmux only: demo turn, steer, Ctrl-C once and twice, crash, resize, undo, sessions, killed server, server stderr
bun test packages/tui/test/frames.test.ts --update-snapshots   # after an intended change to the showcase frames
```

## Known issues and gotchas

Everything here was hit while building and testing the TUI (2026-11-12).

- **pkill killed the tmux server.** `pkill -f "LH_ACP_SCRIPT=..."` matched the tmux server, whose argv holds the session's command; every pane died with EIO (`setRawMode failed with errno: 5` in the TUI's stderr). Kill by PID.
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
- **The live model's second call often reads 0% from cache** (seen in the panel's per-call bars: 89%, 0%, 90%, 83%). That is the provider's lag on quick follow-ups described in the harness-testing skill, not the TUI.

## Measured (two-core aarch64, 2026-11-12)

- Start to `● ready`: 0.37 s with the demo engine, 0.7 s with the `lh acp` child (most of it the server).
- CPU: 0% idle; 4% during a demo turn; 18% of a core with about 90 text deltas a second; a 110 KB reply in about 14,000 deltas renders and settles in 1.1 s. RSS 115 MB, 250 MB after that reply.
