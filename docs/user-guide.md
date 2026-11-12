# User guide

How to use `lh` day to day. `lh --help` is the reference for every option; this page explains what they are for.
Every command and message on this page was run against the program, and `test/release/docs.test.ts` checks the
options, configuration keys, exit codes and environment variables here against the code.

## Sessions

Every conversation is a session, kept on disk until you delete it. A session belongs to the directory it was
started in.

```sh
lh "explain what src/server.ts does"
lh --list-sessions
lh -c "now add a test for it"
lh --session ses_9acf "and run it"
```

- `lh --list-sessions` lists the sessions of the current directory, newest first: ID, last use, model, title.
  `--json` prints one JSON object per line.
- A run with `--json` writes every event as one JSON line, and after each turn's last event one line of its own,
  `{"type":"cli.summary", "outcome", "steps", "durationMs", "usage", "cachedShare", ...}`: what the end of the
  human-readable output says. `outcome` is `succeeded`, `unresolved`, `failed`, `stopped` (exit code 4) or
  `interrupted`.
- `-c` (`--continue`) resumes the most recent session in this directory; `--session <id>` resumes one by its ID, or
  by the start of one if it is unique. Both work with a prompt (one-shot) and without one (interactive).
- `--cwd <dir>` works in another directory without changing to it.

**Several at once.** Each `lh` process (and each editor using `lh acp`) works in its own session, so you can run
several side by side in the same project. One session can be open in only one process at a time; a second one is
refused with a message that names the process holding it (see [troubleshooting](troubleshooting.md#a-session-in-use-by-another-process)).

## Models and effort

```sh
lh --models
lh -m gpt-6-luna --effort low "rename the helper to parseLine"
```

`lh --models` lists the models your plan offers and the efforts each accepts; the one marked `*` is the default.
`-m` (`--model`) and `--effort` choose for a new session. A session keeps the model it was started with when you
resume it, unless you name another. `--max-steps <n>` limits the model calls in one turn; at the limit the model is
asked for a final answer without tools.

Defaults can be set in the configuration file (`model`, `effort`; see below).

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
  (`--unattended deny`, the default), or the run stops with exit code 4 (`--unattended stop`). A stopped run ends
  with `■ stopped for your approval` and the two ways on: run it interactively (`lh -i "<prompt>"`) and answer the
  question, or choose what such a call becomes (`--unattended deny`, or another `--approval` mode).
- In the interactive mode a question shows the command and the choices: `a` allow once, `s` for this session, `p`
  in this project, `n` no; words after the letter go to the agent as your note.
- A command that ran in the sandbox is marked `⊡`.

[docs/safety.md](safety.md) has the whole policy: what each mode allows, what the sandbox stops and what it does not,
"tainted" conversations and `/clear-taint`, and secret redaction.

## Project configuration

Two JSON files, both optional:

- your own: `~/.config/light-harness/config.json` (`$XDG_CONFIG_HOME/light-harness/config.json` when that is set);
- the project's: `.light-harness/config.json`, looked for from the working directory up to the repository root.

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

1. yours, `~/.config/light-harness/AGENTS.md`, for every project;
2. the project's, from the repository root down to the working directory, and in any other directory of the
   repository the session works in. The nearest file comes last and takes precedence.

The repository root is the nearest directory above with a `.git`. Outside a repository only the working directory
itself is searched. A file longer than 32,768 characters is cut, with a line saying so. An edited or removed file is
noticed on the next request.

## Verification checks

Declare the commands that tell whether the code is right as `checks` in the configuration. When a turn changed files,
the checks whose `when` patterns match run before the turn ends, in the sandbox. A turn ends one of these ways:

- `✓ done · checks passed`: they ran and passed. Exit code 0.
- `✓ done · no checks configured` or `✓ done · nothing to check` (nothing changed that a check covers). Exit code 0.
- `✗ stopped with failing checks: <names>`: they still fail, and the agent reported that it cannot fix them, ran
  out of rounds (`verify.maxRounds`), or `verify.mode` is `report`. Exit code 3; with `--json` the turn's last event is
  `execution.succeeded` with `data.verification.status` `"unresolved"`.

With `gate` (the default) a failing check is shown to the agent (`↻ the agent is shown the failing checks and
carries on`), which then fixes the code or reports why it cannot. Each check's full output is kept in a file the
report names. On a machine without a sandbox the checks are not run, except in `full`.

## Undo and redo

At the interactive prompt, while the agent is idle:

- `/undo` takes the files and the conversation back to before your last message. It shows what will change first,
  and asks before it overwrites a file that you or another session edited since.
- `/redo` brings back what the last `/undo` took away.
- `/diff` shows the files the last turn changed, with their diffs.

Undo needs `git` (2.25 or newer) on `PATH`, but the project does not have to be a git repository: snapshots are
kept in a private git directory per project inside the data directory, and your own repository is never touched. A steer you sent while the agent
worked counts as a message, so `/undo` goes back past it first.

## Compaction and the history tools

A long session is compacted automatically: when the next request would fill most of the model's context window, the
earlier part of the conversation is replaced by a checkpoint (a summary written by the model, plus your own
messages and the files, commands and errors so far), and a short recent part is kept word for word. You see
`⇣ compacted the conversation · about <before> → <after> tokens`.

Nothing is lost: the session's log keeps every message, and the agent has two tools to get exact details back,
`history_search` (words or a quoted phrase, across the whole session) and `history_read` (messages by position).
The first requests after a compaction cost more, because the provider's prompt cache has to be written again for
the new prefix. `lh --demo list` has scripted compactions under "Compaction".

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | failed |
| 2 | usage error: an unknown option (the nearest one is suggested), a wrong value, an unknown model or an ambiguous session ID |
| 3 | done, but the project's checks still fail and were left unresolved |
| 4 | stopped: a tool call needed your approval and nobody was there to give it (`--unattended stop`) |
| 130 | interrupted (Ctrl-C) |
| 141 | output closed (a pipe reader left) |
| 143 | terminated (SIGTERM) |

`lh login` uses 0, 1 (failed; for `status`: not signed in), 2 and 130.

## The data directory

Everything the program keeps is in `~/.local/share/light-harness` (`$XDG_DATA_HOME/light-harness` when that is set):

| Path | What |
|---|---|
| `auth.json` | your sign-in (mode 0600); `lh login logout` deletes it |
| `host-id` | this machine's ID for the sign-in |
| `sessions/` | one SQLite database per session, with its lock files |
| `index.db` | a cache for listing sessions; safe to delete |
| `snapshots/` | the private git directories that undo uses, one per project |
| `approvals/` | what you allowed "in this project", kept for 30 days |
| `blobs/`, `spill/` | images, and tool output too long to show the model |

Each session also has a temp directory, `/tmp/light-harness-<uid>/<session id>/` (under `$TMPDIR` instead of `/tmp`
when that is set), which sandboxed commands can write to (they see it as `/tmp` on Linux) and which holds the full
output of long commands.

### Deleting everything

```sh
sh scripts/install.sh --uninstall
rm -rf ~/.local/share/light-harness ~/.config/light-harness "/tmp/light-harness-$(id -u)"
```

This removes the program, every session, your sign-in (the plan's authorization on OpenAI's side stays until you
revoke it there), your configuration and `AGENTS.md`. Projects may also have a `.light-harness/` directory of their
own.

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
| `LH_TUI` | `1`: plain `lh` (interactive, no prompt) starts the full-screen interface |
| `LH_TUI_DEBUG` | `1`: the full-screen interface shows events it does not know, dimmed |
| `LH_ACP_LOG` | the server's log level on standard error: `debug`, `info` (default), `warn`, `error` |
| `LH_ENGINE_START_TIMEOUT_MS` | how long the server child may take to start (default 20000) |
| `DISPLAY`, `WAYLAND_DISPLAY`, `SSH_CONNECTION`, `SSH_TTY` | `lh login` opens a browser only with a display and not over SSH |
| `OPENTUI_LIB_PATH`, `OPENTUI_LIBC` | read by the full-screen interface's library: another native library, or `musl` |

Variables whose names look like credentials (`*TOKEN*`, `*KEY*`, `AWS_*`, ...) are not passed to sandboxed
commands, and their values are redacted from tool output.

For tests only, never for real use:

| Variable | Effect |
|---|---|
| `LH_ACP_SCRIPT` | a JSON file of scripted model responses: no model is called and no sign-in is needed |
| `LH_DEMO_TRACE` | a file the demo engine appends its shutdown steps to |
| `LIGHT_HARNESS_TEST_CONTEXT_WINDOW` | a smaller context window, in tokens, so that compaction happens early |

A project's `.env` and `bunfig.toml` are never loaded by the built executable.
