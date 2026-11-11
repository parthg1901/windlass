# evals

End-to-end tasks for testing the agent the way a user would: a small workspace, a prompt typed in a natural voice,
and a grader that checks the finished workspace.

```
evals/
  grader.ts          helpers for graders (pass/fail, run a command, compare with the original workspace)
  run-check.ts       copy a workspace, run setup, optionally apply the reference solution, grade
  graders.test.ts    every untouched workspace fails its grader; every reference solution passes
  run-agent.ts       run the agent on tasks, grade, and report metrics from its event stream
  run-agent.test.ts  the runner, driven by testing/stand-in-agent.ts
  tasks/<id>/
    task.json        { id, title, prompt, tags, timeoutSeconds, maxSteps, setup? }
    workspace/       the project the agent starts in
    check.ts         the grader: bun check.ts <finished-workspace>, exit 0 = pass, prints one line
    solve.ts         reference solution: bun solve.ts <workspace> (or solution.patch, applied with patch -p1)
```

Run one task by hand: `bun evals/run-check.ts <id>` (expect FAIL) and `bun evals/run-check.ts <id> --solve`
(expect PASS); `--keep` leaves the workspace in the temp directory. Run all graders with `bun test evals`.
An agent runner should reuse `prepareWorkspace(id)` and `grade(id, dir)` from `run-check.ts`.

## Running the agent on the tasks

`run-agent.ts` runs the CLI on tasks the way a user would and grades what it leaves behind:

```
bun evals/run-agent.ts --all                          # every task once, with the CLI of this checkout
bun evals/run-agent.ts fix-failing-test large-log --model <slug> --effort high --repeat 3 --concurrency 2
bun evals/run-agent.ts --all --cli "bun evals/testing/stand-in-agent.ts"   # the scripted stand-in (see below)
```

For each run it copies the workspace to a fresh temporary directory and runs setup (`prepareWorkspace`), starts the
CLI as `<cli> --json --cwd <dir> [--model] [--effort] -- <prompt>`, sends SIGINT (Ctrl-C) at the task's
`timeoutSeconds` and SIGKILL if the agent has not stopped `--grace` seconds (default 15) later, saves the JSONL
stream, and runs the grader. The CLI has no step-limit flag yet, so steps are counted and a run over `maxSteps` is
flagged rather than stopped.

| option | meaning |
| --- | --- |
| `--all` / task ids | which tasks |
| `--model`, `--effort` | passed through to the CLI |
| `--repeat N` | run each task N times (rows `task#1`, `task#2`, ...) |
| `--concurrency N` | runs at once (default 1; the eval machine has two cores) |
| `--keep` | keep finished workspaces and print their paths (default: deleted) |
| `--out <dir>` | where results go (default `evals/results/<timestamp>/`, git-ignored) |
| `--cli "<command>"` | the command that starts the agent; relative script paths are resolved from here |
| `--timeout <s>`, `--grace <s>` | override every task's time limit; time between SIGINT and SIGKILL |

The exit code is 0 only when every run passed.

### Reading the output

```
task              #  result   exit  end               wall  steps  tools  retry  in    cached  out  anomalies
fix-failing-test  1  passed   0     succeeded         0.1s  2/15   1      1      2.6k  44%     120  -
answer-question   1  timeout  130   interrupted:user  1.0s  1/12   0      0      0     -       0    -

passed 1/2 (50%)  median wall 0.6s  tokens 2.7k (in 2.6k, out 120)  cached 44%  anomalies 0
```

- `result`: `passed`, `failed` (the agent finished, the grader said no), `timeout` (stopped with Ctrl-C at the limit),
  `killed` (ignored Ctrl-C), `crashed` (exited without an `execution.*` end event), `error` (setup failed).
  Failing runs are listed under the table with the grader's one-line reason.
- `exit`: the CLI's exit code (0 done, 1 failed, 130 interrupted), or the signal that killed it.
- `end`: the last `execution.*` event; for a failure, the class of the last step error (`failed:provider:auth`).
- `steps`: logical model calls against the task's `maxSteps`; a retry is not a step. `retry` counts `retry.scheduled`.
- `in`, `cached`, `out`: input tokens (cached included), the cached share of input, output tokens.
- `anomalies`: `cache-drop` (a step's cached tokens fell below the previous step's: the prefix changed),
  `effect-unknown` and `not-started` (tool calls settled that way), `unsettled-tool`, `no-execution-end`,
  `over-step-limit`, `malformed-event` (a line that is not a valid event).

Under `--out`: `results.json` (options, totals and one entry per run with every metric: tool calls by tool and by
outcome, retries by error kind, per-step `(input, cached, output)` tokens, the session ID, unknown event types with
counts, and every anomaly with its detail) and `runs/<task>-<n>.jsonl` / `.stderr.log`, the raw stream of each run.
Event types the runner does not know are counted, never fatal, so it keeps working while the schema grows.

### The stand-in agent

`testing/stand-in-agent.ts` takes the CLI's flags and writes an event stream built from the core event types, so the
runner can be tested before the engine exists. `STAND_IN_MODE` picks the behaviour: `solve` (default; applies the
reference solution of the task whose prompt it got), `nothing`, `hang` (stops on Ctrl-C like the CLI), `stubborn`
(ignores Ctrl-C), `crash` (exits with `STAND_IN_EXIT`, default 3, mid tool call) or `replay` (writes the file named
by `STAND_IN_EVENTS`). The CLI's own scripted demos work too: `--cli "bun packages/cli/src/main.ts --demo 5 --demo-speed 0"`.
`run-agent.test.ts` covers the runner with it.

## Workspace conventions

- A file stored as `name.in` is copied into the workspace as `name`. Test files (`*.test.ts`) are stored this way so
  the repository's own `bun test` does not pick up the deliberately failing tests.
- `setup` is an argv run in the copied workspace before the agent starts. Use it for anything large or generated;
  generated files are never committed (see `.gitignore`).
- `.git` and `node_modules` in a finished workspace are ignored by graders.

## Adding a task

1. Create `tasks/<id>/` with the files above. `id` in `task.json` must equal the directory name.
2. Write the prompt as a user would type it: say what they want, not how to do it.
3. The grader judges the outcome, not the method. It must fail on the untouched workspace and on a plausible wrong
   answer (hard-coding, editing the tests instead of the code, touching files it should not), and must never need
   the network. Prefer hidden inputs the agent has not seen over checking the exact diff.
4. Write the reference solution and run `bun test evals`.

## The rule

Every workspace is synthetic and hand-written for this purpose: a few small files, no code copied from real
projects or other repositories, no secrets or real personal data, no dependencies beyond Bun's built-ins.
