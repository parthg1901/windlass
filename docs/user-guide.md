# User guide

How to use `windlass` day to day. `windlass --help` is the reference for every option; this page explains what they are for.
Every command and message on this page was run against the program, and `test/release/docs.test.ts` checks the
options, configuration keys, exit codes and environment variables here against the code.

## Sessions

Every conversation is a session, kept on disk until you delete it. A session belongs to the directory it was
started in.

```sh
windlass "explain what src/server.ts does"
windlass --list-sessions
windlass -c "now add a test for it"
windlass --session ses_9acf "and run it"
```

- `windlass --list-sessions` lists the sessions of the current directory, newest first: ID, last use, model, title.
  `--json` prints one JSON object per line.
- A run with `--json` writes every event as one JSON line, and after each turn's last event one line of its own,
  `{"type":"cli.summary", "outcome", "steps", "durationMs", "usage", "cachedShare", ...}`: what the end of the
  human-readable output says. `outcome` is `succeeded`, `unresolved`, `failed`, `stopped` (exit code 4) or
  `interrupted`.
- `-c` (`--continue`) resumes the most recent session in this directory; `--session <id>` resumes one by its ID, or
  by the start of one if it is unique. Both work with a prompt (one-shot) and without one (interactive).
- `--cwd <dir>` works in another directory without changing to it.
- The interactive mode starts by naming its session: `new session ses_…`, or for one it resumed
  `resumed session ses_… "<title>" · 3 turns (1 undone)`. Leaving it prints `session ses_… · resume with: windlass --session
  ses_…`, as the full-screen interface does. A one-shot run prints neither.
- `windlass fork` starts a new session with another's conversation, to try another way without changing the original:
  after its latest step, or after a turn with `--turn <n>` (1 is the session's first prompt; the full-screen interface
  shows each turn's number on its ending row, and `/fork <n>` does the same there). `windlass fork --help` has the precise
  form, an event number. Forking and listing need no sign-in.

**Several at once.** Each `windlass` process (and each editor using `windlass acp`) works in its own session, so you can run
several side by side in the same project. One session can be open in only one process at a time; a second one is
refused with a message that names the process holding it (see [troubleshooting](troubleshooting.md#a-session-in-use-by-another-process)).

## Models and effort

```sh
windlass --models
windlass -m gpt-6-luna --effort low "rename the helper to parseLine"
```

`windlass --models` lists the models your plan offers and the efforts each accepts; the one marked `*` is the default.
`-m` (`--model`) and `--effort` choose for a new session. A session keeps the model it was started with when you
resume it, unless you name another. An effort the model does not take is refused in one sentence that names the
ones it accepts (`model gpt-6-luna does not offer the reasoning effort "extreme"; it accepts: low, medium, high,
xhigh, max`), exit code 2. `--max-steps <n>` limits the model calls in one turn; at the limit the model is asked for
a final answer without tools.

Defaults can be set in the configuration file (`model`, `effort`; see below).

## Agents

An agent is a way of working you define once: its own instructions, restrictions on what it may do, and
optionally its model. A definition is a Markdown file, `<name>.md`, in `.claude/agents` (or `.agents/agents`, or
`.windlass/agents`) of the project, or in the `agents` directory of your configuration directory; its front
matter has a `name`, a `description`, and what it may do (`effects: read` for a read-only agent, `tools`,
`disallowed-tools`, `approval`, `model`, `effort`). `examples/agents/` has three.

```sh
windlass --agent reviewer "review the last commit"
```

- `--agent <name>` starts the session as that agent; with `--session` or `-c` it switches the session to it.
  `--agent none` is no agent. Without the option a new session runs as the `agents.default` of your own
  configuration, if you set one.
- `/agent` at the prompt lists the agents defined here, marks the one in force, and says which definitions could not
  be used and why. `/agent <name>` switches (from the next step, also in the middle of a turn); `/agent none`
  switches it off. In the full-screen interface `/agent` is a picker.
- The session line names the agent (`new session ses_… · agent reviewer`), the full-screen panel has an `agent`
  field, and a switch is a line in the conversation (`⇄ agent reviewer → docs (restricted)`), also in a session
  opened again.
- A call the agent may not make is not run, and says whose rule it was: `○ not run: the reviewer agent may not
  change files`. An agent can only take away: it never lets a call run that your approval mode would ask about.

## The task list

For work with several steps the model keeps a task list, and each update is shown as the list itself:

```
≡ tasks · 1 of 3 done
  ✓ Read the code
  ▸ Fix the bug
  ○ Run the tests
```

`✓` is done, `▸` in progress, `○` pending. The full-screen interface keeps the current list in the panel; a session
you resume shows the list as it stands (`Its task list (1 of 3 done):`). A turn you `/undo` takes its list back
with it.

## Approvals and the sandbox

Before every tool call the program decides whether it runs, runs in a sandbox, asks you, or is refused.

| Mode | Reads | Edits in the project | Commands |
|---|---|---|---|
| `ask` | run | ask | ask, then run in the sandbox |
| `auto` (default) | run | run | run in the sandbox; more access asks |
| `full` | run | run | run with your full permissions, nothing asks |

- The sandbox (bubblewrap on Linux) lets a command write only in the project and a session temp directory, hides
  credential stores, and has no network. A command that needs more is run only after you approve it.
- Choose with `--approval <mode>`, or `/approval ask|auto|full` while working. A project's own configuration can make
  the policy stricter, never looser.
- When nobody can answer (a one-shot run, `--json`, a pipe), a call that would ask is refused and the agent is told
  (`--unattended deny`, the default), or the run stops with exit code 4 (`--unattended stop`). With `deny` the agent
  carries on without those calls and the run can still end as done, with exit code 0: its ending says how many calls
  were refused. A script that must not count such a run as done uses `--unattended stop`. A stopped run ends
  with `■ stopped for your approval` and the two ways on: run it interactively (`windlass -i "<prompt>"`) and answer the
  question, or choose what such a call becomes (`--unattended deny`, or another `--approval` mode).
- In the interactive mode a question shows the command and the choices: `a` allow once, `s` for this session, `p`
  in this project, `n` no; words after the letter go to the agent as your note.
- A command that ran in the sandbox is marked `⊡`.

[docs/safety.md](safety.md) has the whole policy: what each mode allows, what the sandbox stops and what it does not,
"tainted" conversations and `/clear-taint`, and secret redaction.

## Project configuration

Two JSON files, both optional:

- your own: `~/.config/windlass/config.json` (`$XDG_CONFIG_HOME/windlass/config.json` when that is set);
- the project's: `.windlass/config.json`, looked for from the working directory up to the repository root.

The project file overrides yours key by key (a list such as `checks` replaces yours whole), except `approval`,
where the project can only tighten what you chose. An unknown key is an error that names the file and suggests the
key you probably meant.

```json
{
  "model": "gpt-6-luna",
  "effort": "low",
  "checks": [
    { "name": "test", "command": "bun test", "timeoutSeconds": 300, "when": ["src/**", "test/**"] },
    { "name": "types", "command": "bun run typecheck" }
  ],
  "verify": { "mode": "gate", "maxRounds": 3 },
  "approval": { "mode": "auto", "unattended": "deny" }
}
```

Every key:

| Key | Value |
|---|---|
| `$schema` | ignored; lets an editor find a schema |
| `model` | the model for new sessions |
| `effort` | the reasoning effort for new sessions |
| `checks` | the project's checks, a list (below) |
| `verify` | what is done with the checks (below) |
| `approval` | the approval policy (below) |
| `mcp` | MCP servers: `servers`, by name, each started by a `command` or reached at a `url`; one a project's file names is not started until you approve it |
| `skills` | skills: `paths` (extra directories, from your own file only) and `disabled` (names to leave out) |
| `wake` | wake-ups: `enabled` (default on), `hourlyCeiling`, `maxActive`, `webhook`; a project's file can only tighten |
| `memory` | memory: `enabled` (default off), `inRepository`, `projectChars`, `userChars` |
| `agents` | agents: `paths` (extra directories), `disabled` (names to leave out) and `default` (the agent a new session runs as; from your own file only) |
| `hooks` | hooks: commands run before a tool call (`beforeTool`: can refuse it), after one (`afterTool`: can add a note to its result) and when a turn is about to end (`stop`: can send the agent back, at most `maxStopRounds` times); a project's hooks are added to yours and none runs until you approve it |
| `lsp` | language servers: `servers`, by name, each with a `command` and the `languages` it serves; `waitMs`, `warnings`, `maxDiagnostics`, `enabled`. After an edit, what the edit made worse is added to its result as a short note; one a project's file names is not started until you approve it |
| `commands` | slash commands (prompt templates kept as Markdown files): `paths` (extra directories) and `disabled` (names to leave out) |
| `telemetry` | live OpenTelemetry export of a session's spans: `enabled` (default off), `endpoint` (an OTLP/HTTP collector), `headers`, `content` (default off: no message text, tool arguments or output), `timeoutMs`. Only your own file can turn it on or say where it goes; a project's file can only turn it off |

| Key in `checks[]` | Value |
|---|---|
| `name` | required; letters, digits, `_`, `.` and `-`; unique |
| `command` | required; run with `bash -c` in the project directory |
| `timeoutSeconds` | 1 to 3600; default 120 |
| `when` | glob patterns of changed files that make the check run; default: any change |

| Key in `verify` | Value |
|---|---|
| `mode` | `gate` (default), `report` or `off` |
| `maxRounds` | 1 to 20; default 3: how many times in one turn the agent is sent back to fix failing checks |

| Key in `approval` | Value |
|---|---|
| `mode` | `ask`, `auto` (default) or `full` |
| `unattended` | `deny` (default) or `stop` |
| `taint` | `enforce` (default) or `off` |
| `untrustedPaths` | glob patterns of project files to treat as untrusted content (`["**"]`: the whole repository) |

## Project instructions (AGENTS.md)

The agent reads `AGENTS.md` files and follows them:

1. yours, `~/.config/windlass/AGENTS.md`, for every project;
2. the project's, from the repository root down to the working directory, and in any other directory of the
   repository the session works in. The nearest file comes last and takes precedence.

The repository root is the nearest directory above with a `.git`. Outside a repository only the working directory
itself is searched. A file longer than 32,768 characters is cut, with a line saying so. An edited or removed file is
noticed on the next request.

## Verification checks

Declare the commands that tell whether the code is right as `checks` in the configuration. When a turn changed files,
the checks whose `when` patterns match run before the turn ends, in the sandbox. A turn ends one of these ways;
the two interfaces word them differently:

| The turn | Line interface (`windlass`) | Full-screen (`windlass tui`) |
|---|---|---|
| ran its checks, and they passed | `✓ done · checks passed` | `✓ done · checks passed` |
| changed nothing that a check covers | `✓ done · nothing to check` | `○ done · checks not needed: nothing they cover changed` |
| the same, while files the checks cover changed outside the turn | `✓ done · nothing to check`, and a line under it | `○ done · nothing to check`, and the same line under it |
| ran in a project with no checks | `✓ done · no checks configured` | `○ done · no checks configured` |
| was a subagent's | `✓ done · its checks are left to its parent's turn` | `○ done · its checks are left to its parent's turn` |
| ended with checks that still fail | `✗ stopped with failing checks: <names>` | `✗ unresolved · failing checks: <names>` |

- Each row goes on with the turn's steps and time (`· 2 steps · 392ms`), and in the full-screen interface with
  the turn's number (`· turn 2`), which `/fork <n>` takes. `○` there marks a turn that ended as done with nothing
  checked.
- The line under "nothing to check" is for files the checks cover that changed outside the turn (you edited by
  hand, a turn was undone, an earlier turn ended with its checks failing): they were not checked now, and are at
  the end of the next turn that changes a file.
- A subagent's work is checked with its parent's.
- Checks still fail when the agent reported that it cannot fix them, ran out of rounds (`verify.maxRounds`), or
  `verify.mode` is `report`; the line under the row says which.
- For a one-shot run the exit code is 0 for every `done` and 3 for failing checks; with `--json` the turn's last
  event is then `execution.succeeded` with `data.verification.status` `"unresolved"`.

With `gate` (the default) a failing check is shown to the agent (`↻ the agent is shown the failing checks and
carries on`), which then fixes the code or reports why it cannot. Each check's full output is kept in a file the
report names. On a machine without a sandbox the checks are not run, except in `full`.

## Commands at the prompt

In the interactive mode an entry that starts with `/<word>` is a command, never a message: `/help` lists them all.
A word that is not a command is not sent to the model (it would cost a request); you are told the nearest command
instead. To send a message that really starts with a slash, begin it with two: `//etc is where the config lives`
sends `/etc is where the config lives`. A first word with another slash in it (`/etc/hosts is wrong`) is a path and
is sent as typed. The README has the table of the commands each interface has.

## Undo and redo

At the interactive prompt, while the agent is idle:

- `/undo` takes the files and the conversation back to before your last message. It shows what will change first,
  and asks before it overwrites a file that you or another session edited since.
- `/redo` brings back what the last `/undo` took away.
- `/diff` shows the files the last turn changed, with their diffs.
- `/rename <title>` gives the session a title, which `--list-sessions`, the session picker and the line that
  resumes it show. Without one a session is named by the first line of your first prompt.

`/undo` says which turn it took back (`↶ undone: turn 2 "add a test" · out of the conversation`), and `/redo` which
it put back. In the full-screen interface an undone turn is one dim line where it was (`↶ undone turn 2: "add a
test"`), also in a session opened again, until `/redo` shows it as before.

When a file the restore would change was changed outside the session since (by you, another program, or another
session in the same directory: the program cannot tell which), the question says so and what each answer does to it:
overwrite (it goes back, and those changes are lost; after `/undo`, `/redo` brings them back), keep (it stays exactly
as it is now: those changes and the agent's in it both, while the other files are restored), or change nothing.

Undo needs `git` (2.25 or newer) on `PATH`, but the project does not have to be a git repository: snapshots are
kept in a private git directory per project inside the data directory, and your own repository is never touched. A steer you sent while the agent
worked counts as a message, so `/undo` goes back past it first.

## Compaction and the history tools

A long session is compacted automatically: when the next request would fill most of the model's context window, the
earlier part of the conversation is replaced by a checkpoint (a summary written by the model, plus your own
messages and the files, commands and errors so far), and a short recent part is kept word for word. You see
`⇣ compacted the conversation · about <before> → <after> tokens`.

`/compact` does it now, when you want room before a long task. It says what happened: the same line with the sizes,
or that there was nothing worth compacting (a short conversation, or one that is already a checkpoint and what
followed it), or why it failed. While the agent works it is made after the current step and the turn carries on;
while it is idle nothing else runs, and no turn is counted for it. A turn's ending counts the summary requests of
its compactions with its steps (`3 steps + 1 summary call`), since each is a model request.

Nothing is lost: the session's log keeps every message, and the agent has two tools to get exact details back,
`history_search` (words or a quoted phrase, across the whole session) and `history_read` (messages by position).
The first requests after a compaction cost more, because the provider's prompt cache has to be written again for
the new prefix. `windlass --demo list` has scripted compactions under "Compaction".

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done; with `--unattended deny` also when calls were refused for lack of approval (the ending says how many) |
| 1 | failed |
| 2 | usage error: an unknown option (the nearest one is suggested), a wrong value, an unknown model or an ambiguous session ID |
| 3 | done, but the project's checks still fail and were left unresolved |
| 4 | stopped: a tool call needed your approval and nobody was there to give it (`--unattended stop`) |
| 130 | interrupted (Ctrl-C) |
| 141 | output closed (a pipe reader left) |
| 143 | terminated (SIGTERM) |

`windlass login` uses 0, 1 (failed; for `status`: not signed in), 2 and 130. `windlass tui` exits with 0 when you leave it, 1
when you leave without a session open (not signed in, the session in use elsewhere, the engine gone; the reason is
printed after the screen is back), and 129, 130 or 143 when a signal ends it.

## The data directory

Everything the program keeps is in `~/.local/share/windlass` (`$XDG_DATA_HOME/windlass` when that is set):

| Path | What |
|---|---|
| `auth.json` | your sign-in (mode 0600); `windlass login logout` deletes it |
| `auth.lock` | a lock that keeps two processes from renewing the sign-in at once |
| `host-id` | this machine's ID for the sign-in |
| `sessions/` | one SQLite database per session, with its lock files |
| `index.db` | a cache for listing sessions; safe to delete |
| `snapshots/` | the private git directories that undo uses, one per project |
| `approvals/` | what you allowed "in this project", kept for 30 days |
| `blobs/`, `spill/` | images, and tool output too long to show the model |
| `wake/` | the wake-ups of every session (`wake.db`), with the secrets of webhook wake-ups ([wake-ups.md](wake-ups.md)) |
| `memory/` | the memory notes, one Markdown file each, once memory is turned on ([memory.md](memory.md)) |

Beside it, not inside it, is the work directory `~/.local/share/windlass-work` (`$XDG_DATA_HOME/windlass-work`),
where the program makes the directories that sessions work in when it makes them itself. It is outside the data
directory because sandboxed commands must run there, and the data directory is hidden from them.

| Path in the work directory | What |
|---|---|
| `workspaces/` | the copy of a workspace that a fork made with `--copy` works in ([forks.md](forks.md)) |
| `worktrees/` | the git worktree of a subagent started with `worktree: true`, removed when its work is merged ([subagents.md](subagents.md)) |
| `replays/` | the copy a replay carried on in under `--policy execute`; nothing removes it ([replay.md](replay.md)) |

Each session also has a temp directory, `/tmp/windlass-<uid>/<session id>/` (under `$TMPDIR` instead of `/tmp`
when that is set), which sandboxed commands can write to (they see it as `/tmp` on Linux) and which holds the full
output of long commands.

### Deleting everything

```sh
sh scripts/install.sh --uninstall
rm -rf ~/.local/share/windlass ~/.local/share/windlass-work ~/.config/windlass "/tmp/windlass-$(id -u)"
```

This removes the program, every session, your sign-in (the plan's authorization on OpenAI's side stays until you
revoke it there), the wake-ups and memory notes, the work directory with every fork's copy, your configuration
and `AGENTS.md`. Projects may also have a `.windlass/` directory of their own, and a repository where a subagent's
work was not merged keeps its `windlass/subagent-<id>` branch.

## Environment variables

| Variable | Effect |
|---|---|
| `XDG_DATA_HOME` | where the data directory is (default `~/.local/share`) |
| `XDG_CONFIG_HOME` | where your configuration and `AGENTS.md` are (default `~/.config`) |
| `TMPDIR` | where session temp directories are made (default `/tmp`) |
| `XDG_RUNTIME_DIR` | read to hide your session bus from sandboxed commands |
| `PATH` | where `bwrap`, `env` and `git` are found; commands the agent runs get it too |
| `NO_COLOR` | set to anything: no colour |
| `COLUMNS` | the width when the terminal does not say |
| `WINDLASS_TUI` | `1`: plain `windlass` (interactive, no prompt) starts the full-screen interface |
| `WINDLASS_TUI_DEBUG` | `1`: the full-screen interface shows events it does not know, dimmed |
| `WINDLASS_ACP_LOG` | the server's log level on standard error: `debug`, `info` (default), `warn`, `error` |
| `WINDLASS_ENGINE_START_TIMEOUT_MS` | how long the server child may take to start (default 20000) |
| `WINDLASS_WAKE` | `off`: this process's server fires no wake-ups (an interactive `windlass`, `windlass tui` and `windlass acp` fire them; a one-prompt run never does) |
| `DISPLAY`, `WAYLAND_DISPLAY`, `SSH_CONNECTION`, `SSH_TTY` | `windlass login` opens a browser only with a display and not over SSH |
| `OPENTUI_LIB_PATH`, `OPENTUI_LIBC` | read by the full-screen interface's library: another native library, or `musl` |

Variables whose names look like credentials (`*TOKEN*`, `*KEY*`, `AWS_*`, ...) are not passed to sandboxed
commands, and their values are redacted from tool output.

For tests only, never for real use:

| Variable | Effect |
|---|---|
| `WINDLASS_ACP_SCRIPT` | a JSON file of scripted model responses: no model is called and no sign-in is needed |
| `WINDLASS_DEMO_TRACE` | a file the demo engine appends its shutdown steps to |
| `WINDLASS_TEST_CONTEXT_WINDOW` | a smaller context window, in tokens, so that compaction happens early |

A project's `.env` and `bunfig.toml` are never loaded by the built executable.
