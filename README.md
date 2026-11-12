# Windlass

A coding agent for the terminal: you describe a change, and it reads your code, edits files and runs commands in
your project until the change is done. Commands run in an operating-system sandbox, edits can be undone, and every
session is kept on disk so it can be resumed. It is one program, `windlass` (`wl` for short, wherever it is installed), with a line interface, a full-screen
interface, and a server for editors (the Agent Client Protocol).

**State of the project.** It works on Linux (built and run on arm64). macOS and Linux x64 executables can be built,
but have never been run. The only model provider is a ChatGPT plan, through "Sign in with ChatGPT". Nothing is
published: there is no package, no download and no release; you build it from this repository.

## Requirements

- To build: [Bun](https://bun.sh) 1.4 and this repository with its dependencies installed (`bun install`).
- To run: Linux or macOS, a ChatGPT plan, and these programs on `PATH`:
  - `bwrap` (bubblewrap) on Linux, for the sandbox. Without it no command runs sandboxed, and every command asks first.
  - GNU `env` 8.31 or newer (coreutils), so that a stopped command gets time to finish.
  - `git` 2.25 or newer, for undo. Without it `/undo` cannot restore files.

`sh scripts/install.sh --check` says which of these this machine has, and what each missing one costs.

## Build and install

```sh
bun scripts/build.ts
sh scripts/install.sh
windlass --version
```

The first builds `dist/windlass-<os>-<arch>` for this machine (about 95 MB: Bun's runtime, the program, and the full-screen
interface's native library). The second copies it to `~/.local/bin/windlass`, checks the requirements, and tells you if
that directory is not on your `PATH` (it asks before touching a shell profile). `bun scripts/build.ts --all` builds
all four targets; see the top of `scripts/build.ts` for what each includes. `sh scripts/install.sh --uninstall`
removes the program and keeps your sessions.

You can also run it from source without building: `bun packages/cli/src/main.ts` instead of `windlass`.

## Sign in

```sh
windlass login
windlass login status
```

On a machine with a browser, `windlass login` opens it. On a remote machine it prints an address: open it in a browser
anywhere, approve, and the browser ends on a page at `127.0.0.1` that fails to load. Copy that page's address and
paste it at the prompt (it is not shown, and it never goes on the command line). `windlass login status` says who is
signed in; it never prints a token.

## A first session (five minutes)

Try the interface without a model first: the demos are scripted sessions, played without a model or a sign-in.

```sh
windlass --demo list
windlass --demo find-and-fix-a-failing-test
```

In a project of yours, give it one task and let it finish:

```sh
windlass --model gpt-6-luna --effort low "the add test fails; find out why and fix it"
```

It prints each tool call as it runs and ends with a line such as `✓ done · no checks configured · 4 steps · 7.5s`.
The exit code says how it went (0 done, 1 failed, 2 a usage error such as a mistyped option, 3 done but the
project's checks still fail, 4 stopped because a tool call needed your approval and nobody was there).

Work interactively: run `windlass` with no prompt. It names the session it opened (`new session ses_…`, or for `-c` the
one it resumed, with its title and turns), and on leaving prints how to resume it. Type a message and press Enter.

```sh
windlass
```

- **Steer a running turn:** type while the agent works and press Enter. The message is sent at once and the agent
  reads it after its current step (`↳ delivered to the agent: ...`). `/queue <message>` holds it until the turn ends.
- **Undo:** `/undo` at the prompt takes the files and the conversation back to before your last message, and shows
  what will change first. `/redo` brings it back. `/diff` shows what the last turn changed.
- **Work as an agent:** `windlass --agent reviewer` starts the session as an agent you defined (its own instructions, and
  what it may do); `/agent` lists them and switches. `/rename <title>` names the session, and `/compact` makes room
  in a long one.
- **Stop:** Ctrl-C stops the agent; Ctrl-D leaves.
- **Continue later:** `windlass -c` resumes the most recent session in this directory; `windlass fork --turn 2` starts a new
  session with the conversation up to the end of its second turn.

The full-screen interface does the same in one screen, with a panel for tokens and the prompt cache:

```sh
windlass tui
```

`/help` lists the commands and keys in both. A `/word` that is not a command is never sent to the model; to send a
message that starts with a slash, begin it with two (`//etc` sends `/etc`).

| Command | Line interface (`windlass`) | Full-screen (`windlass tui`) |
|---|---|---|
| `/help` | the commands and keys | the keys and commands |
| `/undo`, `/redo` | yes | yes |
| `/diff` | the last turn's changes | the selected step's or turn's, in a reader |
| `/approval [ask\|auto\|full]` | yes | yes, with a picker |
| `/clear-taint` | yes | yes |
| `/agent [name\|none]` | the agents and the one in force; a name switches | yes, with a picker |
| `/rename <title>` | yes | yes |
| `/compact` | yes | yes |
| `/queue <message>` | yes | yes (or Ctrl-T) |
| `/exit`, `/quit` | yes | yes |
| `/fork [<turn>] [copy]` | `windlass fork` instead | yes |
| `/sessions`, `/new`, `/model` | `--list-sessions`, `-c`, `--session`, `-m` instead | yes |
| `/reconnect`, `/panel`, `/debug` | | yes |

## Where next

- [docs/user-guide.md](docs/user-guide.md): sessions, models, approvals and the sandbox, configuration, checks, undo,
  compaction, exit codes, the data directory, environment variables.
- [docs/troubleshooting.md](docs/troubleshooting.md): the errors you are likely to meet, and what to do.
- [docs/safety.md](docs/safety.md): what the agent may do without asking, and what the sandbox does and does not stop.
- [docs/acp.md](docs/acp.md): using it from an editor.
- [docs/subagents.md](docs/subagents.md): subagents, a worktree of their own, background commands.
- [docs/forks.md](docs/forks.md): forking a session, with or without a copy of the workspace.
- [docs/replay.md](docs/replay.md): replaying a recorded session against a changed prompt, and what that can tell you.
- [docs/mcp.md](docs/mcp.md): MCP servers, and why a server a project names waits for your approval.
- [docs/skills.md](docs/skills.md): skills and where they live.
- [docs/wake-ups.md](docs/wake-ups.md): timers, checks and webhooks that wake a session.
- [docs/memory.md](docs/memory.md): notes that persist across sessions (off by default).
- [docs/agents.md](docs/agents.md): agents: defining one, restrictions, switching, subagents as agents.
- [docs/hooks.md](docs/hooks.md): commands that refuse a call, add a note, or keep a turn from ending.
- [docs/diagnostics.md](docs/diagnostics.md): language-server diagnostics after an edit.
- [docs/task-list.md](docs/task-list.md): the model's task list.
- [docs/event-log.md](docs/event-log.md): the format of a session's log.
- `windlass --help`: every option and exit code.

## Licence

MIT; see `LICENSE`. `CONTRIBUTING.md` says how to work on it.
