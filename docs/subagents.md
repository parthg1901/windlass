# Subagents and background commands

Two kinds of work can run beside the agent's own steps: a **subagent**, a second agent the first one hands a
self-contained task to, and a **background command**, a shell command that keeps running while the agent does other
things. Both are started by the model; you do not configure anything. Everything on this page was run against the
program with a scripted model; `test/release/feature-docs.test.ts` checks the names and messages against the code.

## Subagents

The model calls the `subagent` tool with a task. A subagent is a session of its own: the same tools, the same
working directory, the same model settings and approval mode as its parent, and a fresh conversation. It sees
nothing of the parent's conversation, only its task and the project's `AGENTS.md` files. Several `subagent` calls in
one response run at the same time; that is what they are for (one per module, one per question).

You can ask for one in your prompt:

```sh
windlass "use a subagent to count the lines in notes.txt"
```

```text
▸ subagent Count the lines in notes.txt and report the number.
  ▸ subagent ses_1ae04948 started
    subagent ses_1ae04948: Count the lines in notes.txt and report the number.
    ↳ subagent ses_1ae04948 ✓ read notes.txt · 1 line
  ✓ subagent ses_1ae04948 finished · 2 steps, 1 tool call · 1.1k tokens · 232ms
  ✓ subagent answered · 240ms
    One line.
```

The parent gets the child's final answer as the tool's result, followed by a line such as
`[subagent ses_1ae0494804f409c64284c352: finished after 2 steps, 1 tool call]`. A child that failed, was stopped or
ended without an answer comes back as an error that says so.

- **Only one level.** A subagent cannot start subagents of its own.
- **Follow-ups.** The model can send an earlier subagent a follow-up by its session ID; the child still has its
  conversation.
- **Its session.** A subagent's session is not shown by `windlass --list-sessions`, but it opens like any other:
  `windlass --session <its id>` continues it with you instead of its parent.
- **Checks.** The project's checks run for the parent's turn, once the children's work is in; children do not run
  them.
- **Stopping.** Ctrl-C (or closing the session) stops the parent and everything it started.

While a subagent works in the foreground, the status line of `windlass` says what it is running (`⋯ subagent ses_3ebb35c4:
running read a.txt · 1 step, 1 tool`), as `windlass tui` does. When a background subagent's answer reaches the agent
the line says so (`the subagent's answer reached the agent`), not as if you had typed it.

**Its tokens.** A subagent's model calls are its own, not the turn's. Its `finished` row says how many tokens they
took (`· 1.1k tokens`), and the line interface adds a line for them to the turn's ending, under the turn's own:

```text
✓ done · no checks configured · 2 steps · 451ms
  tokens · 2,200 in · 1,000 cached (45%) · 29 out
  + subagents: 1,100 in · 400 cached (36%) · 15 out
```

`tokens` is what the agent's own model calls of this turn took: input, how much of it was read from the prompt
cache, output. `+ subagents:` is the same three numbers added up over the subagents that ran in the foreground
and ended in this turn; it is there only when there was one.
<!-- NOT-YET(subagents-token-line): a background subagent, and the full-screen interface, have no "+ subagents:" line -->
A subagent started in the background is not on that line, whenever it ends: its tokens are on its own `finished`
row and nowhere in the turn's ending. `windlass tui` has no such line at all; its ending row shows the turn's own
tokens.

### In the background

With `background: true` the call returns at once (`Started subagent <id> in the background. ...`) and the parent
carries on. When the child ends, its answer is delivered to the parent as a message, after the parent's current step:

```text
  ✓ subagent ses_98910ff9 finished · 1 step, 0 tool calls · 605 tokens · 1.3s
  ↳ its result is sent to the agent after the current step
```

The parent's turn does not end while a background subagent still works, so a one-shot run waits for it.

### A worktree of its own

With `worktree: true` (only in a git repository; elsewhere the call is refused and nothing starts) the child works on
its own git worktree, on a new branch made from the parent's workspace as it stands, uncommitted and untracked files
included. Your index, branches, `HEAD` and stash are not touched, and no git hook runs. The worktree is under the
work directory beside the data directory, `~/.local/share/windlass-work/worktrees/<child's session id>`, and the
branch is `windlass/subagent-<id>`.

When the child finishes, every file it changed is merged into the parent's working directory (three ways: the
branch's start, the child's result, the file as it is now). The files are written, not committed or staged, and the
worktree and the branch are removed:

```text
  ✓ subagent ses_3ebb35c4 finished · 2 steps, 1 tool call · 661ms
    merged 1 file into the workspace: child.txt
```

If a file the child changed was also changed in the workspace meanwhile, and the changes conflict, **nothing is
merged**; the branch is kept with the child's work as a commit, and the model is told how to look at it:

```text
    ⚠ not merged, conflicts in: notes.txt
    its work is on branch windlass/subagent-47bbc88b69b9; nothing was changed in the workspace
```

Delete such a branch when you are done with it (`git branch -D windlass/subagent-47bbc88b69b9`); nothing removes it for
you. A child that did not finish has its work committed to its branch and nothing merged.

### Questions a subagent asks

A child's tool calls go through the approval layer like its parent's. Where someone can answer (the interactive
`windlass`, `windlass tui`, an editor), the child's question is shown in the parent's place, naming the child:

```text
    ? subagent ses_ddb003f3 asks: Allow network access for this command?
        echo net-ok
for subagent "Check that the network works.": [a]llow once · this [s]ession · [N]o ›
```

In a one-shot run it is refused, as the parent's would be. A child has none of its parent's approvals for the
session (approvals for the project apply to it). If the child took in untrusted content (a web page, an MCP result,
a networked command's output), its result taints the parent too:
`Content from subagent <id>, whose own conversation holds untrusted content, is in this conversation ...`

## Background commands

The `shell` tool's `background: true` starts a command (a long test run, a build, a server) and returns at once with
a handle such as `bg_eb5eabc8`. It runs exactly as a foreground command would (in the sandbox, with the same
approvals), without a time limit unless the model gives one. Its output goes to a file in the session's temp
directory; the model reads it so far with `background_output` and stops it with `background_stop`.

```text
▸ shell sleep 3; echo built
  ▸ background bg_98843659 · sleep 3; echo built
    output:
      /tmp/windlass-1001/ses_4c844fa2174d10de4f809972/.spill/shell-bg-msg_ca1d1a8f0a6e0cacde8ae5a3-c1.log
  ✓ shell sleep 3; echo built ·  ⊡ · 23ms
Started the build.
✓ done · no checks configured · 2 steps · 643ms
  ◌ 1 background command still running (bg_98843659): the agent is told when it ends
  ✓ background bg_98843659 exited with code 0 · 3.1s
  ↳ its result is sent to the agent, which carries on
The build finished and printed built.
```

`output:` is the file as this machine names it, which you can open; the agent is told the sandbox's name for the same
file, under the sandbox's temp directory. When the command exits, the model is sent a message with its exit code and the end of its output.
In the interactive mode that message starts a new turn if the session is idle, as above. A turn that ends while
background work runs says so on its ending lines, and `windlass tui` shows each running command in the status line and the
session panel until it ends.

When it is stopped instead (Ctrl-C stops the turn and its background work), the line says what is true:
`it was stopped; the agent is told with your next message`. Leaving `windlass` (or `windlass tui`) with a command still running
says first that leaving stops it; its end is told to the agent when the session is next opened.

**In a one-shot run** the turn does not wait for a background command: when the agent's turn is done, `windlass` exits
and the command is stopped (`Background command <id> was stopped (the harness shut down) after <n> s.`), which the
ending says (`it is stopped now that windlass exits; the agent is told when the session is next opened`). Its end is kept
for the session's next turn (`windlass -c`). For work that must finish, ask for a foreground command.

## Recovery

If `windlass` dies while background work runs, the next time the session is opened the work is recorded as lost and the
model is told; a background command was killed with the process. A subagent that had finished on its own delivers its
answer then, and its worktree is merged then.
