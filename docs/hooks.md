# Hooks

A hook is a command of yours that `windlass` runs at one of three points: **before a tool call runs** (it can refuse
the call), **after a call has its result** (it can add a note for the agent), and **when a turn is about to end**
(it can send the agent back). Hooks are for rules the agent must follow whether or not it was told: never push,
never read `.env`, do not finish while a scratch file is still there. A hook cannot change a call's arguments,
rewrite a result or approve anything. Everything on this page was run against the program with a scripted model,
and the first example with the real one; `test/release/feature-docs-2.test.ts` checks the keys, limits and
messages against the code.

## The smallest working example

In your own configuration file, `~/.config/windlass/config.json`:

```json
{
  "hooks": {
    "beforeTool": [
      {
        "name": "no-push",
        "tools": ["shell"],
        "command": "case \"$WINDLASS_HOOK_COMMAND\" in *'git push'*) echo 'Pushing is not allowed here. Commit locally and tell the user.'; exit 2;; esac"
      }
    ]
  }
}
```

Then work as usual. When the model runs `git push origin main` you see the call fail with the hook's words, and
the model is given the same two lines as the call's result:

```text
▸ shell git push origin main
  ✗ failed
    This call was not run: the hook "no-push" refused it.
    Pushing is not allowed here. Commit locally and tell the user.
```

The real model answered that the push was blocked by the hook, and did not try another way.

## The three points

```json
{
  "hooks": {
    "beforeTool": [
      {
        "name": "no-env-files",
        "tools": ["read", "edit", "write"],
        "paths": ["**/.env", "**/.env.*"],
        "command": "echo 'Files named .env hold secrets and are off limits. Ask the user for the value you need.'; exit 2"
      }
    ],
    "afterTool": [
      {
        "name": "no-todo",
        "tools": ["edit", "write"],
        "paths": ["**/*.ts"],
        "command": "if grep -n TODO $WINDLASS_HOOK_PATHS; then echo 'Do not leave TODO comments: finish the work, or tell the user what is left.'; exit 2; fi"
      }
    ],
    "stop": [
      {
        "name": "no-scratch",
        "command": "if [ -e SCRATCH.md ]; then echo 'SCRATCH.md still exists. Delete it before you finish.'; exit 2; fi"
      }
    ],
    "maxStopRounds": 3
  }
}
```

| Key in `hooks` | Value |
|---|---|
| `beforeTool` | hooks run before a tool call; one that says no refuses the call |
| `afterTool` | hooks run after a call returned; one that says no adds its words to the result as a note |
| `stop` | hooks run when the agent has answered and the turn would end; one that says no sends the agent back |
| `maxStopRounds` | how many times in one turn stop hooks may send the agent back, 1 to 10; default 3 |

| Key in a hook | Value |
|---|---|
| `name` | what you and the agent see it called: letters, digits, `_`, `.` and `-` |
| `tools` | before and after: the names of the tools it applies to. Default: every tool |
| `paths` | before and after: glob patterns; the hook then applies only to calls that name a matching file |
| `command` | required: the command, run by the shell in the session's working directory |
| `timeoutSeconds` | 1 to 300; default 10 before and after a call, 60 at the end of a turn |
| `onError` | before only: `refuse` (default) or `allow`, what happens to the call when the hook fails |
| `sandbox` | `false` runs the hook outside the sandbox, with your permissions and the network. Your own file only |

Hooks of one point run one after another, in the file's order.

**`paths` sees only the file tools.** `no-env-files` above refused `read .env` and `read app/.env.local`, and
let `shell cat .env` through: a shell command names no file. Match the command too (`tools: ["shell"]` and
`$WINDLASS_HOOK_COMMAND`) when the rule must hold for commands.

## How a hook answers

By its exit code, with what it wrote to standard output as its words:

| The hook | Before a call | After a call | At the end of a turn |
|---|---|---|---|
| exits 0 | no objection: the call goes on to the approval rules as usual | nothing is added | the turn may end |
| exits 2 | the call is not run; its output is the reason the agent reads | its output is added after the result, as a note | the agent is sent back with its output as a message |
| anything else, or no answer in time | it failed (below) | it failed | it failed |

What the agent reads, for the three hooks above:

```text
This call was not run: the hook "no-env-files" refused it.
Files named .env hold secrets and are off limits. Ask the user for the value you need.
```

```text
Edited math.ts: replaced 1 occurrence (line 1).

[Note from the hook "no-todo"]
1:export const add = (a: number, b: number) => a + b // TODO check
Do not leave TODO comments: finish the work, or tell the user what is left.
```

```text
[Stop hook 1 of at most 3] The turn cannot end yet.

The hook "no-scratch" says:
SCRATCH.md still exists. Delete it before you finish.
```

A reason or a note is cut at 2,000 characters, a stop message at 4,000. A hook that exits 2 without writing
anything gives `This call was not run: the hook "<name>" refused it and gave no reason.`

With the real model and `no-scratch`: it created `SCRATCH.md`, answered, was sent back, removed the file and
answered again; the turn then ended.

## What a hook is given

On standard input, the event as one line of JSON:

```json
{ "version": 1, "point": "beforeTool", "session": "ses_f302da68932bfa62e9957753", "cwd": "/home/me/proj",
  "hook": { "name": "no-push", "origin": "user" },
  "tool": { "name": "shell", "callId": "c2", "arguments": { "command": "echo hi" }, "argumentsBytes": 21, "paths": null } }
```

After a call the event also has `"result": { "status": "success", "output": "hi\n", "outputBytes": 3, "outputCut": false }`
(the first 16 KiB of the output). At the end of a turn it has, instead of `tool`,
`"turn": { "round": 1, "maxRounds": 3, "lastText": "All done.", "lastTextCut": false }`: the end of the agent's
answer, 8 KiB at most.

In the environment: `WINDLASS_HOOK_POINT`, `WINDLASS_HOOK_NAME` and `WINDLASS_HOOK_ORIGIN`; before and after a call
`WINDLASS_HOOK_TOOL`, `WINDLASS_HOOK_COMMAND` (a shell call's command) and `WINDLASS_HOOK_PATHS` (the files a call
names, one per line); after a call `WINDLASS_HOOK_STATUS`; at the end of a turn `WINDLASS_HOOK_ROUND` and
`WINDLASS_HOOK_MAX_ROUNDS`.

## Where hooks run

In the sandbox, like the agent's own commands: the working directory is writable, the rest of the file system is
read-only (`touch: cannot touch '/var/tmp/x': Read-only file system`), and there is no network. With
`--approval full` nothing is sandboxed, hooks included. Your own hook with `"sandbox": false` always runs
outside it.

Files a hook writes in the working directory count as the turn's changes (`· changed 2 files: ...`).

In a subagent, before and after hooks run for its calls; stop hooks run only for the turn of the session you
talk to.

## When a hook fails or is too slow

A hook fails when it exits with a code other than 0 or 2, or does not answer within its `timeoutSeconds`. You are
told each time:

```text
⚠ hooks: The hook "<name>" (before a tool call) could not answer: it exited with code 1; a hook answers with 0 or 2. A call it must allow is refused while it fails, unless the hook says `onError: "allow"`.
⚠ hooks: The hook "<name>" (before a tool call) could not answer: it did not answer within 1 second. A call it must allow is refused while it fails, unless the hook says `onError: "allow"`.
⚠ hooks: The hook "<name>" (after a tool call) could not answer: it exited with code 3; a hook answers with 0 or 2. Nothing was added to the result.
⚠ hooks: The hook "<name>" (when a turn is about to end) could not answer: it exited with code 9; a hook answers with 0 or 2. The turn ended as it would have without it.
```

- **A failing before hook refuses the call.** A hook that is there to stop something must not stop working
  unnoticed. The agent reads
  `This call was not run: the hook "<name>" (from the user's configuration) must allow it and could not answer: it exited with code 1; a hook answers with 0 or 2. Do not try to work around the hook; tell the user it is failing.`
  With `"onError": "allow"` (for a hook that only watches) the call goes on; you get the same warning.
- **A failing after or stop hook changes nothing**: no note, and the turn ends as it would have.
- **A mistake in the file** fails the turn before anything is sent, naming the file and the key:
  `hooks.beforeTool[0].comand: unknown key "comand"; known keys: name, tools, paths, command, timeoutSeconds, onError, sandbox`.

## The bound on stop hooks

Stop hooks send the agent back at most `maxStopRounds` times in one turn. The last message says so (here with
`"maxStopRounds": 2`:
`[Stop hook 2 of at most 2] The turn cannot end yet. This is the last time: if you stop again, the turn ends with the hook unsatisfied.`),
and if the hook still objects after that, the turn ends anyway:

```text
⚠ hooks: The turn ended although the stop hook "<name>" still objected: the agent was sent back 2 times already, the most a turn allows.
```

The ending is still `✓ done` with exit code 0; in `--json` the turn's last event has
`"hooks": { "unsatisfied": ["<name>"] }`.

## A project's hooks

A hook in a project's file, `.windlass/config.json`, is a command the repository wants to run on your machine. It
is not run until you approve it, and the work goes on as if it were not there. You are told at the first turn:

```text
⚠ hooks: This project's configuration asks to run the hook "<name>" before a tool call (<command>). It is not run: a hook a project names runs only after you approve it.
```

A project's file cannot take a hook out of the sandbox (`"sandbox": false` there fails the turn:
`only the user's own configuration file can run a hook outside the sandbox`) and cannot raise your
`maxStopRounds`:
`⚠ hooks: The project's configuration asks for more than yours allows and was not followed: hooks.maxStopRounds: the project's 9 is above the user's 3.`

## Approving, listing and seeing hooks

- **Approving a project's hook.** An interactive `windlass` and `windlass tui` ask you about a hook a project's
  file names, showing the whole command; `/hooks approve <hook>` answers it later. A one-prompt run cannot ask: it
  says once that the hook was skipped and how to approve it. An approval is for that exact definition; an edited
  hook is asked about again.
- **Listing.** `/hooks` shows each hook, when it runs, its command, the file that defines it and its state.
- **Seeing what a hook did.** A call a hook refused is shown with the hook's name and its reason; a note a hook
  added, a stop hook that sent the agent back, and a turn that ended with a stop hook unsatisfied each have a row.
  `--json` has all of it in the `hook.ran` events (`toModel`, `forUser`).

## Not yet

- **Other points.** There are these three: no hook when a session starts, on your message, or at a compaction.
