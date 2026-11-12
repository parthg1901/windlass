# Forks

A fork is a new session that starts with another session's conversation so far, to try a different way without
changing the original. The original is not touched; the fork is a session of its own that you continue like any
other. Everything on this page was run against the program with a scripted model;
`test/release/feature-docs.test.ts` checks the options and messages against the code.

## The smallest working example

In the project, fork the most recent session there, then continue in the fork:

```sh
lh fork
lh --session ses_da7131868a3c "try it with a regular expression instead"
```

`lh fork` prints the new session and how to continue in it:

```text
Forked ses_f808227c38aa09907cd80c89 after its latest step.
New session: ses_da7131868a3c5d6dd01028a0 "start a build in the background (fork)" (gpt-6.1-sol), with the conversation so far; the original is unchanged.
It works in the same directory as the original, /home/me/proj: both sessions change the same files.

Continue in the fork:
  lh --session ses_da7131868a3c5d6dd01028a0 "<your next message>"
  lh tui --session ses_da7131868a3c5d6dd01028a0
```

In the full-screen interface, `/fork` does the same for the session on screen and switches to the fork; `/fork copy`
gives it a copy of the workspace (below). It works while the agent is idle.

## Options

```sh
lh fork ses_f808 --through 7
lh fork --copy --title "try a copy"
lh fork --copy-to /home/me/proj-experiment -m gpt-6-luna --effort low
lh fork --json
```

| Option | What |
|---|---|
| `<session>` | the session to fork: an ID, or the start of one if it is unique. Default: the most recent session in the directory |
| `--through <n>` | fork after event `<n>` of the session instead of after its latest step. It must be a step boundary; otherwise it is refused and the nearest boundary before it is named |
| `--copy` | the fork works in a copy of the workspace, made under the work directory |
| `--copy-to <dir>` | the same, in `<dir>`: an absolute path that does not exist yet |
| `-m`, `--model <name>` | the fork's model; default the session's |
| `--effort <level>` | the fork's reasoning effort; default the session's |
| `--title <text>` | the fork's title; default the session's, followed by `(fork)` |
| `--cwd <dir>` | the directory whose most recent session is forked |
| `--json` | print the new session as one JSON object: `sessionId`, `parentSessionId`, `throughSeq`, `cwd`, `copiedFrom`, `title`, `model`, `effort` |

The event numbers for `--through` are the `seq` of each event in `lh --json` output (see
[event-log.md](event-log.md)). A wrong one:

```text
lh: seq 9 of session ses_f808227c38aa09907cd80c89 is inside a step: a session is forked at a step boundary (the nearest one before it is seq 7)
```

`lh fork` needs no model call, but it starts the engine like every subcommand, so it needs a sign-in.

## The workspace

**By default the fork works in the same directory as the original.** Both sessions then change the same files:
nothing stops that, each session keeps its own undo history, and neither's `/undo` overwrites the other's work
without asking.

**With `--copy`** (or `--copy-to`, or `/fork copy`) the fork gets a directory of its own, by default
`~/.local/share/light-harness-work/workspaces/<fork's session id>`. It holds what an undo snapshot holds: the files
of the workspace as they are now if you fork the latest point of an idle session (your uncommitted edits included),
otherwise as they were at the fork point. It does not hold ignored files, large untracked files, nested
repositories, or `.git`: **the copy is not a git repository**, so git commands and a subagent's `worktree` do not
work in it. At its first step the model is told the working directory changed. A fork in a copy is listed by
`lh --list-sessions` in the copy's directory, not in the original's.

## What a fork has and has not

It has, as of the fork point: the conversation (with any compaction), the model settings unless you gave others,
the title, and the taint (if untrusted content was in the conversation, it still is). Its first request extends
its parent's last one, so the provider's prompt cache is reused.

It does not have: messages waiting in the original's queue, the original's undo history (`/undo` in the fork goes
back no further than the fork), and what you allowed "for this session" in the original: those approvals were for
that line of work. What you allowed "in this project" still applies.

A fork's log holds only its own events and reads the earlier ones from the original's file, so keep the original.

## Not yet

- **A fork whose original is gone cannot go on.** If the original session's file is deleted or moved, the fork is
  still listed, but a new message to it fails: `lh` prints only `lh: Internal error` (exit code 1);
  `--engine direct` shows the reason, `the history inherited from session <id> cannot be read: <file> is missing`.
- **No fork from the line interface's prompt**: use `lh fork`, or `/fork` in `lh tui`.
