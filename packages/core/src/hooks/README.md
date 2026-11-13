# hooks

A hook is a command from a configuration file that the harness runs at one of three points: **before a tool call
runs**, **after a tool call has its result**, and **when a turn is about to end**. Hooks make an agent obey local
rules without asking it nicely: refuse `git push`, run a formatter after every edit, refuse to finish while
something is wrong. They are built so that they cannot break what the rest of the harness relies on:

- a hook never changes a call's arguments or rewrites a result the model will see: it can refuse a call, add a
  note after a result, or send the model back, and nothing else (the transcript stays true and the provider's
  prompt cache stays valid);
- a repository's hook never runs until the user approved that exact hook, and runs in the sandbox;
- a slow hook is killed at its timeout and a broken one has a defined, safe outcome;
- a stop hook sends the model back a bounded number of times per turn, then the turn ends.

The module itself decides and renders; the step loop calls it from `engine/hooks.ts` (see "As wired into the
engine" at the end, which says where that differs from the proposal under "For the engine integrator").

| File | What |
| --- | --- |
| `config.ts` | the `hooks` configuration section, its defaults, and each hook's fingerprint |
| `match.ts` | which hooks apply to a call: tool names with `*`, path globs (pure) |
| `answer.ts` | the answer format and the parser from what the process did to an answer (pure) |
| `decide.ts` | the decision per point, the stop bound, and every text the model is shown (pure) |
| `trust.ts` | which hooks may run and how (sandbox, approval), the approval question, what taints (pure) |
| `event.ts` | the event a hook is given on stdin and in its environment, bounded (pure) |
| `run.ts` | the runner: the hook's command through the checks' runner (`../verify/run.ts`), sandboxed, capped, redacted as its output arrives |
| `points.ts` | the three points put together: plan, run, parse, decide, and the records to store |

`bun scripts/hooks-demo.ts` runs real hooks at each point and prints what the model would see.

## For users

### The configuration

In your configuration file (`~/.config/windlass/config.json`) or a project's (`.windlass/config.json`;
the directory names come from `packages/core/src/brand.ts`):

```json
{
  "hooks": {
    "beforeTool": [
      {
        "name": "no-push",
        "tools": ["shell"],
        "command": "case \"$WINDLASS_HOOK_COMMAND\" in *'git push'*) echo 'Pushing is not allowed here. Commit locally and tell the user.'; exit 2;; esac"
      }
    ],
    "afterTool": [
      {
        "name": "prettier",
        "tools": ["edit", "write"],
        "paths": ["**/*.ts", "**/*.tsx"],
        "command": "printf '%s\\n' \"$WINDLASS_HOOK_PATHS\" | xargs ./node_modules/.bin/prettier --write >/dev/null 2>&1 || { echo 'prettier could not format this file; run it to see why.'; exit 2; }"
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

A hook has:

| Key | Points | Meaning |
| --- | --- | --- |
| `command` | all | required. Run with `bash -c` (`/bin/sh -c` without bash) in the working directory. |
| `name` | all | shown to the model and to you. Letters, digits, `_`, `.`, `-`. Default `beforeTool[0]` and so on. |
| `tools` | before, after | tool names; `*` matches any run of characters (`mcp__*`). Default: every tool. |
| `paths` | before, after | glob patterns matched against the paths a call names, relative to the working directory. The hook then applies only to calls that name a matching path (the file tools: `read`, `edit`, `write`, ...); a shell command names no path and never matches. A path outside the working directory is matched as its absolute path, so `**/.env` matches every `.env`, and `src/**` only the workspace's. |
| `timeoutSeconds` | all | 1 to 300. Default 10 (before, after) and 60 (stop). |
| `onError` | before | `"refuse"` (default) or `"allow"`: what happens to the call when the hook cannot answer. |
| `sandbox` | all, your own file only | `false` runs the hook outside the sandbox, with your rights and the network. A project's file cannot say this. |

`maxStopRounds` (1 to 10, default 3) is how many times per turn stop hooks may send the agent back. A project's
file can only lower your number.

Hooks of a point run one after another: yours first, then the project's, each in file order. A project's file adds
hooks; it cannot replace or remove yours.

### What a hook is given

On **stdin**, the event as one line of JSON (version 1):

```json
{ "version": 1, "point": "beforeTool", "session": "ses_…", "cwd": "/home/me/repo",
  "hook": { "name": "no-push", "origin": "user" },
  "tool": { "name": "shell", "callId": "call_…", "arguments": { "command": "git push origin main" }, "argumentsBytes": 35, "paths": null } }
```

An `afterTool` event adds `"result": { "status": "success" | "error", "output": "…", "outputBytes": 1234, "outputCut": false }`
(the first 16 KiB of the result's text); a `stop` event has, instead of `tool`,
`"turn": { "round": 1, "maxRounds": 3, "lastText": "…", "lastTextCut": false }` (the end of the agent's last
message, 8 KiB at most). Arguments over 24 KiB are left out (`"arguments": null`, with their size).

In the **environment** (the prefix is the product's environment prefix, `brand.envPrefix`): `WINDLASS_HOOK_POINT`,
`_NAME`, `_ORIGIN`; for before and after `_TOOL`, `_COMMAND` (the call's `command` argument, for shell calls) and
`_PATHS` (the call's paths, relative to the working directory, one per line); for after `_STATUS`; for stop `_ROUND`
and `_MAX_ROUNDS`. A value over 16 KiB is not set.

Neither omission is silent: `HookEvent.omitted` names each value of the call the event does not carry whole (the
command, the list of paths, the arguments), with its size and the limit. `runBeforeHooks` does not ask a hook
about such a call (an exit 0 from a hook that was shown an empty variable is not "no objection"): the hook is
not run, its answer is `failed` (`cannot_run`, with `tooLargeDetail(event)` as the detail), and the call is
refused unless the hook says `onError: "allow"`. After hooks are still run with the event as it is.

The event is a copy. Nothing a hook does with it changes the call, its result or the log.

### How a hook answers

By its exit code, with its **stdout** as the text:

| The hook | Before a call | After a call | At the end of a turn |
| --- | --- | --- | --- |
| exits 0 | no objection (the call still goes through the approval rules as usual) | nothing to add | the turn may end |
| exits 2 | the call is refused; stdout is the reason the agent reads | stdout is added as a note after the result | the agent is sent back with stdout as the message |
| fails: other exit code, killed, timed out, could not start, or exit 2 with stdout that is not text (NUL bytes, invalid UTF-8, escape sequences) | the call is refused, and the agent is told the hook is failing (unless `onError: "allow"`) | nothing is added | the turn may end |

stderr never reaches the agent, and neither does stdout on exit 0. Both are kept for you in the hook's record (the
`forUser` field of the `hook.ran` event, which `--json` prints).
Both interfaces show what a hook printed on the row of the call or the turn it belongs to. A
reason or note is cut at 2,000 characters, a stop message at 4,000. Exit 2 with nothing on stdout gives a default
text ("refused it and gave no reason").

Why a failing before hook refuses the call: a before hook is there to stop something. If it quietly stopped
answering and calls went through, the rule it enforces would be off without anyone noticing. Set
`onError: "allow"` for a hook that only observes. A failing after or stop hook changes nothing: a missing note is no
worse than no hook, and the agent cannot fix a broken stop hook, so sending it back would only spend rounds. You are
told about every failure.

What the agent sees, for the examples above:

```
This call was not run: the hook "no-push" refused it.
Pushing is not allowed here. Commit locally and tell the user.
```

```
Edited src/a.ts: replaced 1 occurrence (line 1).

[Note from the hook "prettier"]
prettier could not format this file; run it to see why.
```

```
[Stop hook 1 of at most 3] The turn cannot end yet.

The hook "no-scratch" says:
SCRATCH.md still exists. Delete it before you finish.
```

After the last allowed round the turn ends anyway, and you are told that the hook was not satisfied.

### Where hooks run

Like the agent's own commands: in the sandbox (the workspace writable, no network, no extra directory) in `ask`
and `auto`, and in `full` once the session holds untrusted content; outside it in `full` otherwise. Your own hook
with `"sandbox": false` always runs outside it. On a machine without a sandbox your hooks run unsandboxed (they are
your commands); a project's hooks do not run there, which for a before hook means the call is refused.

### A project's hooks

A hook in a repository's configuration file is a command that repository wants to run on your machine. It is not
run until you approve it: you are asked once per hook, with the command word for word, and the approval is kept in
your data directory, never in the repository. It is tied to the hook's fingerprint (its point, `tools`, `paths`,
`command`, `timeoutSeconds` and `onError`; not its name), so a hook that is edited is asked about again. An
unapproved hook is not run at all; the work goes on as if it were not there, and you are told it was skipped.

## For the engine integrator

### Configuration

- `config/schema.ts` gets a `hooks` key whose validator calls `parseHooksSection(value, file, origin)`, with the
  origin of the file (`"user"` or `"project"`). Like `approval`, it is **not merged** key by key:
  `config/load.ts` hands both files' sections to `resolveHooksConfig(user, project)` and shows `ignored` once.
  (Merging would let a project's `hooks.beforeTool` replace the user's list.)
- Read the configuration when an execution starts, as the checks are, so a change takes effect at the next turn.
- The hook set is never in the request: no tool, no system-prompt text depends on it. Nothing here touches the
  frozen prefix.

### Wiring

`const runner = createHookRunner({ spillDir: <session temp or data dir>/hooks, sandbox: approvals.sandbox(), secrets })`,
and per point a `HookPointContext`: the runner, `trust` (`mode`, the session's taint, `sandboxAvailable`,
`isApproved` from the approval store below), `cwd`, `sessionId`, the execution's interrupt `signal`, and
`untrustedRepository` (the project's configuration file matches `approval.untrustedPaths`).

1. **Before** (`runBeforeHooks(context, config.beforeTool, call)`): in the tool runtime's `authorize`, after the
   arguments were accepted and **before** `decide` (a refusal then needs no question). `call.arguments` is the
   validated input, `call.paths` is `tool.touches?.(input) ?? null`. On `refuse`, return
   `{ kind: "refuse", output: decision.output }`: the call settles from `pending` as `error` with that text. On
   `allow`, carry on to the approval decision unchanged: a hook's yes is never an approval. On `interrupted`, the
   runtime returns `not_started` itself (the signal is aborted). Calls of one step keep their order rules: a call's
   before hooks run when it is decided, which is when its turn in the step's schedule comes (`schedule/`).
2. **After** (`runAfterHooks(context, config.afterTool, call, result)`): after `execute` returned and **before**
   the runtime caps the output. The runtime has no place for this today; it needs one change in
   `tool/runtime.ts` (the tool track's file):

   ```ts
   // RunHooks
   readonly afterExecute?: (tool: AnyTool, input: Json, result: ToolResult) => Promise<ToolResult>
   ```

   called between `execute` and `capOutput` for a call that returned (not for one that threw). The engine passes
   `(tool, input, result) => runAfterHooks(...).then((out) => out.result)`. The returned result's `output` begins
   with the tool's output byte for byte and every other field is the tool's own (tested). A tool that capped
   itself (`truncation` set) gets the notes after its capped text; the runtime does not cap it again, so a result
   can be at most `MAX_NOTES_CHARS` (4,000) characters over the cap. Run after hooks only for calls that started;
   a refused or denied call has none. Redaction then applies to the whole text, notes included, as now.
3. **Stop** (`runStopHooks(context, config.stop, { roundsSent, maxRounds: config.maxStopRounds, lastText })`):
   where the loop would end the turn (before `execution.succeeded`, or before `turn.ended` with a queued message),
   **after the verification gate said the turn may end** (`finish` or `finish_unresolved`). `roundsSent` is
   `stopRoundsSent(wholeTurn(projection))`, counted from the log, never kept in memory, over the whole turn: a
   message the harness delivers in the middle of it (a background command's end) does not start the count again. `lastText` is the
   assistant's last text. Then:
   - `end`: end the turn as the gate decided; list `failed` hooks to the user.
   - `continue`: append `decision.message` as a harness message (`synthetic`, `delivery: null`, origin
     `STOP_HOOK_ORIGIN` = `"stop_hook"`, to be added to `HARNESS_ORIGIN` in `event/durable.ts`) in the same
     append as the hook records, and run another step. The reducer must accept it where it accepts a check report.
   - `end_unsatisfied`: end the turn, and record on the ending that these hooks were not satisfied (below).
   - `interrupted`: the execution is being interrupted; wind down as usual and record nothing else.

### The stop hook and the verification gate

Order: **gate first, then stop hooks**, only when the gate lets the turn end. Checks are the project's definition of
"correct"; a stop hook asks the narrower question "may this turn end now?", and should see a workspace whose checks
already passed or were given up on. Stop hooks therefore do not run on rounds where the gate sends the model back.
When a stop hook sends the model back and it changes files, the next time the model stops the gate runs again on
those changes, then the stop hooks. Both are bounded per turn and count separately from the log: the gate by its
reports (`maxRounds`), the hooks by their messages (`maxStopRounds`), so a turn returns to the model at most
`maxRounds + maxStopRounds` times. An unresolved gate does not skip the stop hooks: the turn is about to end either
way, and the hooks' own bound holds.

### What to record durably

One event per hook that applied, e.g. `hook.ran`, in the same append as what it decided (the settled refusal, the
settled result with its notes, the stop message or the turn's ending). Its data is `HookRecord`'s fields, never
parsed text:

- `point`, `hookId`, `name`, `origin`, `fingerprint`, and the call (`messageId`, `callId`) for before and after;
- `run`: `ran` with `sandbox` (`null` unsandboxed, else `network` and `writableRoots`), `skipped` with
  `not_approved`, or `cannot_run`;
- `answer` (`yes`, `no`, `failed`, `interrupted`, `skipped`), `failure` and `detail`, `exitCode`;
- `toModel`: the hook's own text that reached the model (also inside the frozen result or message; recorded so a
  client and the taint fold need not parse it);
- `forUser`: stderr (and stdout of a yes), redacted and at most 2 KiB, for a client to show;
- `taint` (below). `durationMs` is display data, like a check's.

The texts the model sees are frozen where they already live: a refusal in `tool.settled.output`, a note inside
the result's output, a stop message in the synthetic message. An unsatisfied ending goes on
`execution.succeeded` / `turn.ended` next to the gate's verdict, e.g. `hooks: { unsatisfied: ["no-scratch"] }`
(a new optional field: a change to the event schema's owner), so a client shows it as its own kind of ending.

### Approving a project's hooks

- At execution start, after the configuration is read: `pendingHookApprovals(config, isApproved)` lists the
  project hooks with no approval. Put one question per hook (`request.question`, word for word, recorded in
  `approval.requested` like any question) with choices: allow for this project (remembered by fingerprint), not
  now (this session only, or not at all), and no. Unattended (nobody present): ask nothing, run none of them, and
  say once that they were skipped and how to approve them.
- Store approvals in the user's data directory, keyed by the project's directory and the fingerprint, beside the
  "always allow in this project" grants; never in the repository. `isApproved(hook)` is a lookup of
  `hook.fingerprint`. An edited hook has a new fingerprint and is asked about again; a stale approval is harmless.
- The approval layer's `decide` is not involved: approving a hook is a statement about configuration, not a call.

### Taint

Hook output is content the harness does not control. `HookRecord.taint` says what to tell the taint layer, by the
same rules as a command's output (`hookTaints`): a hook in the sandbox without network is not a source; a user's
`sandbox: false` hook whose text reached the model is a `hook-network` source (it ran with the network by the
user's grant, like a command with granted network); a project hook in an untrusted repository is a
`hook-untrusted-project` source; a hook unsandboxed because of `full` is the same stated gap as commands in `full`.
`approval/taint.ts` needs a `HistoryEntry` for it, e.g. `{ kind: "hook_output", at, hook, taint }`, mapped from
`hook.ran` events (a change to the approval track's file); the engine must fold it before the next decision.

### Interrupt

The execution's signal reaches the running hook, which is killed with its process group (the shell tool's grace
and SIGKILL). A before hook interrupted: the call is `not_started`. An after hook interrupted: the result is stored
without the notes not yet given, the call settles as it would have. A stop hook interrupted: `interrupted`; the
turn winds down as any interrupt. Records of hooks that had finished are still written.

### Changes outside this module

1. `tool/runtime.ts`: `RunHooks.afterExecute` as above.
2. `config/schema.ts` and `config/load.ts`: the `hooks` key, unmerged, validated with the file's origin.
3. `event/durable.ts`, `message/reducer.ts`: a `hook.ran` event; `HARNESS_ORIGIN.stopHook = "stop_hook"` accepted
   like a check report; an optional unsatisfied-hooks field on the turn's ending; scenarios for each.
4. `approval/taint.ts`: the `hook_output` history entry.
5. The approval store: remembered approvals of project hooks by fingerprint.
6. `engine/engine.ts`: the three call sites and the question at execution start.

## As wired into the engine

`engine/hooks.ts` and `engine/engine.ts` do what the section above asks for, with these differences:

- **The question about a project's hook is put the way a project's MCP server's is**, not as
  `approval.requested`: it is about configuration, not about a call, so the log does not change and nothing waits.
  `EngineSession.hooks()` gives the hooks in force and the ones that wait (`awaiting`: name, point, fingerprint,
  command, and the question word for word); `approveHook(fingerprint)` writes the project grant
  (`{ kind: "tool", tool: "hook:<fingerprint>" }`, 30 days) and the hook runs from the next call. Until then the
  hook is skipped, recorded as skipped, and the user is told once by a `diagnostic` of kind `hooks`.
- **The event is `hook.ran`**, with `HookRecord`'s fields and the call (`messageId`, `callId`; both `null` for a
  stop hook). `forUser` is cut to its last 2,048 characters. The unsatisfied ending is `hooks: { unsatisfied }`
  on `execution.succeeded` and `turn.ended`.
- **`RunHooks.afterExecute`** is given the tool, the input and the result, as proposed. The engine shows an after
  hook the result as the model will be shown it (redacted), and appends what the hook added to the tool's own,
  unredacted output, which is redacted once with the rest, as before.
- **Stop hooks are not run for a subagent's turn** (its parent's turn runs them, as with the checks), nor for an
  execution that has no answer to end on.
- **Taint** is folded from `hook.ran.taint` (`approval/record.ts`: a `hook_output` entry; source kinds
  `hook-network` and `hook-untrusted-project`).
- **The wrapper** sends the hook's stderr out on the wrapper's own stdout as it is written, and ends the answer
  with a second marker line, so that the answer is exactly what lies between the two lines whatever order two
  pipes are read in and whatever length a replaced credential leaves. The output is redacted as it arrives
  (`RunCheckOptions.redact`), before it is kept, cut or read back.
