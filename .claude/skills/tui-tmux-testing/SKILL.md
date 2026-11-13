---
name: tui-tmux-testing
description: Drive the full-screen interface (packages/tui) in a real terminal through tmux, on a demo, a scripted model or the live model. Load before calling TUI work done, when a frame looks wrong on screen, or when writing or debugging a tmux-driven test.
---

# Testing the TUI through tmux

Component tests (`packages/tui/test/*.test.ts`) render the app on a test renderer and are the fast loop. This
procedure is for what only a real terminal shows: key encoding, the alternate screen, exit paths, resize and the
child server. For one-prompt and eval runs use the `harness-testing` skill.

## Rules

- **Use a private tmux server** (`tmux -L <name>`), never the default one: your `kill-server` must not touch the
  user's sessions.
- **Kill by PID, never `pkill -f`**: the tmux server's own command line holds the pane's command, so a pattern from
  it kills the server and every pane. Find a child with `pgrep -P <pane pid>`.
- **Start with the cheapest engine that shows the change** (step 2). The live model spends the owner's ChatGPT plan:
  `--model gpt-6-luna --effort low` on the command, short prompts, and report the request count
  (`bun evals/dogfood/calls.ts --cwd <workspace>`; the panel's `calls` row leaves out subagents). Never print tokens.
- **Give each pane its own data directory or workspace.** A session opens in one process at a time.
- **Restart the pane after an edit.** A running pane keeps the code it started with.
- **Read the frame before the next key.** Keys sent to a view or question that is not on screen go to the input and
  are sent as a message.

## 1. Set up

```sh
bun install --frozen-lockfile                 # a new worktree has no node_modules; the pane shows status=1 without
W=$(mktemp -d); echo "$W"
printf 'set -g status off\nset -g escape-time 10\nset -g history-limit 5000\n' > "$W/tmux.conf"
mkdir -p "$W/work" "$W/data" "$W/config"      # a workspace for the real server: a git repository with one commit
git -C "$W/work" init -q && echo "# demo" > "$W/work/README.md"
git -C "$W/work" add . && git -C "$W/work" -c user.name=t -c user.email=t@example.com commit -qm init
```

Shell variables do not survive between tool calls. Start every later call with these lines, `W` set to the path
printed above:

```sh
W=<that path>; T="tmux -L wl-manual -f $W/tmux.conf"
wait_for() {   # wait_for <extended regex> [tenths of a second, default 300]; prints the frame when it gives up
  n=0; until $T capture-pane -p -t tui | grep -qE "$1"; do
    n=$((n+1)); [ $n -gt "${2:-300}" ] && { echo "TIMEOUT: $1"; $T capture-pane -p -t tui; return 1; }; sleep 0.1
  done
}
```

`escape-time 10` matters: tmux's default holds a lone Esc for half a second.

## 2. Start the interface at a fixed size

Each command ends in `; echo status=\$?; sleep 600`, so the exit status is printed and the pane stays readable.

```sh
# Scripted demo: no model, no server (bun packages/cli/src/main.ts --demo list)
$T new-session -d -s tui -x 120 -y 34 "bun packages/cli/src/main.ts tui --demo 1 --demo-speed 3; echo status=\$?; sleep 600"

# The real server on a scripted model: no sign-in. Write $W/script.json first.
$T new-session -d -s tui -x 100 -y 30 "XDG_DATA_HOME=$W/data XDG_CONFIG_HOME=$W/config WINDLASS_ACP_SCRIPT=$W/script.json bun packages/cli/src/main.ts tui --cwd $W/work; echo status=\$?; sleep 600"

# The live model (bun scripts/login.ts status first)
$T new-session -d -s tui -x 120 -y 40 "bun packages/cli/src/main.ts tui --cwd $W/work --model gpt-6-luna --effort low; echo status=\$?; sleep 600"

wait_for "● ready"
```

The script format and a worked approval example are in the `harness-testing` skill (step 4 and its reference).
Set both `XDG_` variables, or the user's own agents and hooks are read. `--demo-grace <ms>` makes a stopped command
take that long to wind down, for Ctrl-C tests.

## 3. Send keys

```sh
$T send-keys -t tui -l "fix the test"; sleep 0.5; $T send-keys -t tui Enter   # text and Enter apart
$T send-keys -t tui Escape                       # named keys: Enter Escape Tab BSpace Up Down PageUp PageDown
$T send-keys -t tui C-c                          # control keys: C-c C-d C-o C-t C-p C-x
$T send-keys -t tui M-Up                         # Alt keys: M-Up selects a row, M-Enter is a new line
printf 'line 1\nline 2' | $T load-buffer -b p - && $T paste-buffer -p -d -b p -t tui   # a bracketed paste
$T send-keys -t tui -l $'\e[<64;10;5M'           # mouse wheel up at column 10, row 5 (65 is down)
```

- Use `-l` for text, or tmux reads words as key names.
- After Escape wait 0.1 s before typing: Esc followed at once by a letter is read as Alt-letter.
- A demo starts with its prompt in the input: Enter plays it. Ctrl-D leaves only from an empty input, and is
  ignored while a turn runs.

## 4. Wait for output

Always poll with a bound (`wait_for`), never a bare sleep followed by one capture.

| Waiting for | Pattern |
|---|---|
| Ready for input | `● ready` on the status line, the third row from the bottom |
| A turn's end | `· turn <n>` on its ending row; never `○ done` alone (an earlier turn's row matches) or `turn <n>` alone (the running status line matches) |
| A question | `\? waiting for your answer` on the status line |
| The approval dock holding the keys | `↑↓ Enter · a s`, then 0.5 s before the answer key |
| The program gone | `status=` in `$T capture-pane -p -S - -t tui` |

Take other text from the code that draws it (`packages/tui/src/rows.ts`, `transcript.ts`, `app.ts`) or from the
feature's test, not from memory, and match the start of a row: long text is shortened or wrapped to the width.

## 5. Read a frame

```sh
$T capture-pane -p -t tui                                # the visible screen
$T capture-pane -p -t tui | awk -F'│' '{print $1}'       # the conversation without the panel
$T capture-pane -p -S - -t tui                           # with scrollback: what was printed after leaving
$T capture-pane -p -e -t tui                             # with colour escapes
```

A frame is the conversation on the left, the session panel on the right (hidden below 100 columns; Ctrl-P toggles
it), then the status line, the input and a hint line. A good frame after a turn shows tool rows with outcome and
duration, an ending row with the verification state and turn number, the changed files, and in the panel the
session's tokens and one cache bar per model call (the first at 0%).

- Split at `│` with awk or Python, never `cut`: it cuts multi-byte characters. Dialogs draw their own `│` borders,
  so read a dialog in the raw frame.
- Colours are palette indices (`38;5;<n>`) or the default, never RGB; with `NO_COLOR=1` none appear.
- A symbol can be one cell on the test renderer and two in a terminal: check a new one with `Bun.stringWidth`.

## 6. Resize

```sh
$T set-option -t tui window-size manual; $T resize-window -t tui -x 80 -y 24; sleep 0.5
$T capture-pane -p -t tui | awk '{ if (length($0) > m) m = length($0) } END { print m }'   # must not exceed 80
```

Check 80, 100 and 120 columns: nothing cut mid-word, no row wider than the window, hints in their short form.

## 7. Leave and check the terminal

```sh
$T send-keys -t tui C-d
until $T capture-pane -p -S - -t tui | grep -q "status="; do sleep 0.1; done
$T capture-pane -p -S - -t tui | grep -v '^$' | tail -4
$T display -p -t tui 'alt=#{alternate_on} mouse=#{mouse_any_flag} cursor=#{cursor_flag}'
```

Pass: `status=0` (1 when no session was open: signed out, session in use, engine gone, with the reason printed),
the resume line for a real session, and `alt=0 mouse=0 cursor=1`. Poll for `status=`: the exit is known before the
last bytes are drawn, so one capture right after the key can still show the alternate screen.

## 8. Clean up

```sh
$T kill-server; rm -f "/tmp/tmux-$(id -u)/wl-manual"; rm -rf "$W"
```

`kill-server` leaves its socket file behind. Remove any directory the run made outside `$W` as well. Wait a moment
before starting a new server under the same name.

## Writing a tmux test

`packages/tui/test/tmux.ts` does all of the above for tests: `Tmux.start({ width, height, command, env })`,
`term.keys("C-c")`, `term.type(text)`, `term.paste(text)`, `term.wheel("up")`, `await term.waitFor(text | regex |
(frame) => boolean, { timeoutMs })`, `await term.exited()`, `term.children(pattern)`. A failed wait throws with the
last frame.

- A test that drives tmux starts a process: name the file `*.e2e.test.ts`, set `setDefaultTimeout(E2E_TIMEOUT_MS)`
  and wait with `term.waitFor`, never a fixed sleep (CONTRIBUTING.md, "Tests and fixtures").
- Kill sessions in `afterEach` and call `killServer()` in `afterAll`, in each test file.
- Run only the files you changed: `bun test packages/tui/test/<name>`.

Feature set-ups (questions, agents, subagents, hooks, review, background work) are in [reference.md](reference.md).
