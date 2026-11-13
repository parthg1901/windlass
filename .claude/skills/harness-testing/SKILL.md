---
name: harness-testing
description: Test Windlass headless as a user runs it, on a demo, a scripted model or the live model. Load before calling a user-visible change done, before spending a live ChatGPT-plan request, when reading eval or gate results, or when sign-in fails.
---

# Testing Windlass headless

Unit tests prove the pieces. This procedure proves the product: run the real entry points and read the output as a
user would. For the full-screen interface use the `tui-tmux-testing` skill.

## Rules

- **Use the cheapest level that can show the change** (step 2). Most changes need no live request.
- **Live requests spend the owner's ChatGPT plan.** Put `--model gpt-6-luna --effort low` on every live command (a
  command without `--model` runs on the account's default model), keep prompts short, run one at a time, and report
  how many requests you spent (step 7).
- **Never print, log or commit tokens, and never copy `auth.json`.** To test "not signed in", use a throwaway
  `XDG_DATA_HOME`.
- **Set environment variables inline on each command.** An `export` in one tool call does not reach the next, and a
  "signed out" check then quietly uses the real sign-in.
- **Keep workspaces, results and traces outside the repository** and delete them when done. Never commit session
  data.
- **Kill by PID**, never `pkill -f <text>`: the pattern also matches the shell that runs it.

## 1. Set up

```sh
bun install --frozen-lockfile                      # a new worktree has no node_modules
W=$(mktemp -d); echo "$W"; mkdir -p "$W/p/work" "$W/data" "$W/config"
git -C "$W/p/work" init -q && echo "# demo" > "$W/p/work/README.md"
git -C "$W/p/work" add . && git -C "$W/p/work" -c user.name=t -c user.email=t@example.com commit -qm init
```

The workspace is a git repository with one commit (undo needs it) inside a parent directory of its own (the model
often searches the parent). Shell variables do not survive between tool calls: start each later call with
`W=<the path printed above>`.

## 2. Pick the level

| Level | Shows | Costs |
|---|---|---|
| Demo (step 3) | how a recorded event sequence is rendered | nothing; no engine, no tools |
| Scripted model (step 4) | the real engine, tools, sandbox, approvals, store and CLI | nothing; no sign-in |
| Live model (step 5) | what the model does with it; prompt caching | plan requests |

## 3. Demo

```sh
bun packages/cli/src/main.ts --demo list
bun packages/cli/src/main.ts --demo 1 --demo-speed 0      # by number or name; 0 is instant
```

Pass: the rows match the scenario (`docs/step-loop-scenarios.md`) and the exit code matches its ending.

## 4. Scripted model

`WINDLASS_ACP_SCRIPT` names a JSON file with one list of items per model call; the real server plays it instead of
calling a model. Item types and feature recipes are in [reference.md](reference.md).

```sh
cat > "$W/script.json" <<'EOF'
{ "responses": [
  [{ "type": "tool_call", "callId": "c1", "name": "write", "input": { "path": "note.txt", "content": "hello\n" } },
   { "type": "usage", "inputTokens": 1000, "cachedInputTokens": 0, "outputTokens": 20 }],
  [{ "type": "text", "text": "Wrote note.txt." },
   { "type": "usage", "inputTokens": 1100, "cachedInputTokens": 1000, "outputTokens": 8 }]
] }
EOF
E="XDG_DATA_HOME=$W/data XDG_CONFIG_HOME=$W/config WINDLASS_ACP_SCRIPT=$W/script.json"
env $E bun packages/cli/src/main.ts --cwd "$W/p/work" "write a note"; echo "exit=$?"
env $E bun packages/cli/src/main.ts --cwd "$W/p/work" --json "write a note" > "$W/out.jsonl"
env $E bun packages/cli/src/main.ts --cwd "$W/p/work" --list-sessions
```

- Set both `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, or the run reads the user's own configuration, agents and hooks.
- Every process plays the script from its first response: a `-c` run needs its own script file.
- Give each response a `usage` item when you read tokens or export a trace; a call without one is not counted.
- Options come before the prompt and a subcommand comes first: `fork --cwd <dir>`, not `--cwd <dir> fork`, which
  sends the prompt "fork".

Pass: the ending row and exit code are the ones you expect (step 6) and the workspace holds what the tools did.

## 5. Live model

Check the sign-in first; neither command prints a token. If it fails, see "Signing in again" in
[reference.md](reference.md).

```sh
bun scripts/login.ts status
bun packages/cli/src/main.ts --models          # gpt-6-luna must be listed, with the efforts it accepts
```

One prompt (about one request per step):

```sh
bun packages/cli/src/main.ts --cwd "$W/p/work" --model gpt-6-luna --effort low "<short prompt>"; echo "exit=$?"
```

Eval tasks, graded (`evals/README.md` has every option and column):

```sh
bun evals/run-agent.ts fix-failing-test --model gpt-6-luna --effort low --out "$W/eval"   # one task, a few requests
bun evals/run-agent.ts --all --model gpt-6-luna --effort low --out "$W/eval"              # every task once: the costly one
bun evals/gate.ts "$W/eval" --hard-only        # harness bugs only; exit 0 pass, 1 fail, 3 inconclusive
```

`--cli "bun evals/testing/stand-in-agent.ts" --no-classify` runs the same pipeline with no model, to test the runner
itself (the gate then says inconclusive, since no trace was classified). For a real repository with the live model,
follow `evals/dogfood/README.md`.

- Wait about 10 s between two requests when a test asserts a cache hit: a new prefix takes a few seconds to become
  readable.
- Before a turn whose ending you want to read, commit or revert hand edits in the workspace: the checks cover every
  file changed since they last passed, not only that turn's.
- A wake-up never fires in a one-prompt run. Cancel every wake-up a test creates, or it fires later in an
  interactive session, at a cost.

## 6. Read the result

- **Ending row and exit code**: `✓ done` 0, `✗ failed` 1, usage error 2, checks left unresolved 3, a refused call
  under `--unattended stop` 4, interrupted 130. `--help` lists them all.
- **`--json`**: the last line is `cli.summary` (`outcome`, `steps`, `requests`, `usage`, `cachedShare`); the line
  before it is the engine's last event, `execution.succeeded` or `execution.failed`. A one-prompt run prints its
  session ID only here (`sessionId`) and in `--list-sessions`.
- **What the log says**, next to what the client showed: `bun evals/dogfood/events.ts <session-id> [--type <prefix>]`.
  This script, `export-trace.ts` and `calls.ts` read the real data directory: for a session made with a throwaway
  one, put the same `XDG_DATA_HOME` on the command.
- **A low cached share or a `cache-drop` anomaly** is not a harness bug until the trace says so:

  ```sh
  bun scripts/export-trace.ts <session-id> -o "$W/t.jsonl" && bunx prefixlens report "$W/t.jsonl" --all
  ```

  Every record must be `full-request`; a `usage-only` record means the request rebuilt from the log is not the one
  that was sent, which is a harness bug. A miss reported as provider-side with the prefix intact is the provider's
  (common on quick follow-ups, sometimes mid-turn). Any other cause is a harness bug.
- **A failed eval task**: read the task's prompt against the grader's reason before blaming the agent or the grader.
  A cost or pass-rate change needs a control run of the baseline commit in the same sitting, because the model's cost
  varies more between sittings than between runs.
- **A test that timed out on a busy machine** (`uptime`): rerun that file alone before treating it as a failure.

## 7. Count the requests and clean up

```sh
bun evals/dogfood/calls.ts --cwd "$W/p/work"     # live requests per session, subagents, forks and replays included
rm -rf "$W"
```

Live sessions land in the real data directory. A fork made with `--copy` and a replay under `--policy execute`
leave a copy under `<data dir>-work/` (`workspaces/`, `replays/`): delete the ones your run made. Report the request
count with your result.
