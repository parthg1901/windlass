# Forks

A fork is a new session that starts with another session's conversation so far, to try a different way without
changing the original. The original is not touched; the fork is a session of its own that you continue like any
other. Everything on this page was run against the program with a scripted model;
`test/release/feature-docs.test.ts` checks the options and messages against the code.

## The smallest working example

In the project, fork the most recent session there, then continue in the fork:

```sh
windlass fork
windlass --session ses_da7131868a3c "try it with a regular expression instead"
```

`windlass fork` prints the new session and how to continue in it:

```text
Forked ses_f808227c38aa09907cd80c89 after its latest step.
New session: ses_da7131868a3c5d6dd01028a0 "start a build in the background (fork)" (gpt-6.1-sol), with the conversation so far; the original is unchanged.
It works in the same directory as the original, /home/me/proj: both sessions change the same files.

Continue in the fork:
  windlass --session ses_da7131868a3c5d6dd01028a0 "<your next message>"
  windlass tui --session ses_da7131868a3c5d6dd01028a0
```

In the full-screen interface, `/fork` does the same for the session on screen and switches to the fork; `/fork <n>`
forks after turn `<n>` (the number on that turn's ending row), and `/fork copy` gives the fork a copy of the
workspace (below). It works while the agent is idle, and only once the session has a turn: in a
session without one there is nothing to carry over, and it says so. `/sessions` marks a fork with `⑂`, shows the
start of its ID and of the one it was forked from, and the directory it works in when that is a copy elsewhere; a
fork's panel counts its own model calls, with the inherited ones on a line of their own.

`--session` and `windlass fork <session>` take an ID, its start, or its start without `ses_`; a start that names one
session of the current directory picks it even when other directories have sessions that start the same. With
`--list-sessions`, `--session` narrows the listing to the sessions that start so.

## Options

```sh
windlass fork --turn 2
windlass fork ses_f808 --through 7
windlass fork --copy --title "try a copy"
windlass fork --copy-to /home/me/proj-experiment -m gpt-6-luna --effort low
windlass fork --json
```

| Option | What |
|---|---|
| `<session>` | the session to fork: an ID, or the start of one if it is unique. Default: the most recent session in the directory |
| `--turn <n>` | fork after turn `<n>` of the session instead of after its latest step: 1 is its first prompt, as the full-screen interface numbers turns on their ending rows. A turn that `/undo` took back cannot be forked at |
| `--through <n>` | the precise form: fork after event `<n>` of the session. It must be a step boundary; otherwise it is refused and the nearest boundary before it is named |
| `--copy` | the fork works in a copy of the workspace, made under the work directory |
| `--copy-to <dir>` | the same, in `<dir>`: an absolute path that does not exist yet |
| `-m`, `--model <name>` | the fork's model; default the session's |
| `--effort <level>` | the fork's reasoning effort; default the session's (`default`: the model's own) |
| `--title <text>` | the fork's title; default the session's, followed by `(fork)` |
| `--cwd <dir>` | the directory whose most recent session is forked |
| `--json` | print the new session as one JSON object: `sessionId`, `parentSessionId`, `throughSeq`, `cwd`, `copiedFrom`, `title`, `model`, `effort` |

With `--turn`, the first line says which event that was (`Forked ses_… after turn 2 (event 28).`), and a turn the
session does not have is refused with the ones it has (exit code 2):

```text
windlass: there is no turn 7: the session has turns 1 to 2
Its turns:
  1  "what does a.txt say"
  2  "and again"
```

The event numbers for `--through` are the `seq` of each event in `windlass --json` output (see
[event-log.md](event-log.md)). A wrong one (exit code 2):

```text
windlass: seq 9 of session ses_f808227c38aa09907cd80c89 is inside a step: a session is forked at a step boundary (the nearest one before it is seq 7)
```

`windlass fork` calls no model and needs no sign-in: it works signed out, as `windlass --list-sessions` does. Continuing in
the fork is a prompt like any other and needs the sign-in.

## The workspace

**By default the fork works in the same directory as the original.** Both sessions then change the same files:
nothing stops that, each session keeps its own undo history, and neither's `/undo` overwrites the other's work
without asking.

**With `--copy`** (or `--copy-to`, or `/fork copy`) the fork gets a directory of its own, by default
`~/.local/share/windlass-work/workspaces/<fork's session id>`. It holds what an undo snapshot holds: the files
of the workspace as they are now if you fork the latest point of an idle session (your uncommitted edits included),
otherwise as they were at the fork point. It does not hold ignored files, large untracked files, nested
repositories, or `.git`: **the copy is not a git repository**, so git commands and a subagent's `worktree` do not
work in it. `windlass fork` and `/fork copy` say so when they make it, with what follows: commands that need installed
dependencies (and the project's checks) fail there until they are installed in the copy. At its first step the model
is told the working directory changed. A fork in a copy is listed by
`windlass --list-sessions` in the copy's directory, not in the original's.

## What a fork has and has not

It has, as of the fork point: the conversation (with any compaction), the model settings unless you gave others,
the title, and the taint (if untrusted content was in the conversation, it still is). Its first request extends
its parent's last one, so the provider's prompt cache is reused.

It does not have: messages waiting in the original's queue, the original's undo history (`/undo` in the fork goes
back no further than the fork), and what you allowed "for this session" in the original: those approvals were for
that line of work. What you allowed "in this project" still applies.

A fork's log holds only its own events and reads the earlier ones from the original's file, so keep the original.

## A fork of a fork, and a fork without its original

A fork is forked like any session, also at a point it inherited: `windlass fork <a fork> --turn 1` works when turn 1
is from the original's part of the conversation, and so does `--through <n>` for one of its events. The new session
is then recorded as a fork of the session that point belongs to (the original), and reads that part from its file.

If the original's file is deleted or moved, the fork is still listed and still runs. A new message to it is
answered, and you are told once that the earlier part cannot be listed:

```text
⚠ history: The part of this conversation from before the fork cannot be shown: the history inherited from session <id> cannot be read: <file> is missing. The session still has it, so the model sees it and the session goes on; only what happened since the fork is listed.
```

Forking that fork, or replaying it, needs the events it no longer has, and is refused with the file that is
missing (exit code 2):

```text
windlass: session <id> cannot be forked: the history inherited from session <id> cannot be read: <file> is missing
windlass: session <id> cannot be replayed: the history inherited from session <id> cannot be read: <file> is missing
```

## Not yet

- **No fork from the line interface's prompt**: use `windlass fork`, or `/fork` in `windlass tui`.
