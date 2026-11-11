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
  classify.ts        export a run's session as a trace and have prefixlens explain its cache misses
  baseline.ts        build baseline.json from results directories
  baseline.json      the committed baseline the gate compares against
  gate.ts            the regression gate: new results against the baseline
  gate.test.ts       the gate and the baseline generator, on crafted results
  tasks/<id>/
    task.json        { id, title, prompt | prompts, tags, timeoutSeconds, maxSteps, setup? }
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
stream, and runs the grader. Steps are counted and a run over `maxSteps` is flagged rather than stopped (the runner
does not pass `--max-steps`).

A task with `prompts` (a list) instead of `prompt` is one session over several turns: after a turn's process exits,
the next prompt is sent with `--session <id>` (the ID from the first turn's events) and without `--model`/`--effort`,
which the session keeps (passing them again would record a settings change and break the prompt cache). The time
limit covers the whole run; a turn that times out, crashes or exits non-zero ends the run, and the grader runs after
the last turn that was sent. All turns go into one event stream.

After each run the runner exports the session from the CLI's session database (`$XDG_DATA_HOME/light-harness/
sessions.db`, or `--db`) with `scripts/export-trace.ts` and runs `prefixlens report --json` on the trace
(`classify.ts`; prefixlens is the sibling checkout `../prefixlens` or `PREFIXLENS_DIR`, run by path). Each call that
lost cached tokens is sorted into provider-side (prefix intact, the provider missed: common on quick follow-ups),
expired, intentional (a break the harness declared, within what the declaration allows) or avoidable (anything
else, with prefixlens's cause: a harness bug). A record exported usage-only means the request rebuilt from the log is
not what was sent, also a harness bug. Without prefixlens or a database the step is skipped and says why.

The real CLI holds a single-writer lock on the session database, so keep `--concurrency 1` with it: a second run
started while the first holds the lock fails at once.

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
| `--db <path>` | the session database to export traces from (default: the CLI's, under the agent's `XDG_DATA_HOME`) |
| `--no-classify` | skip the trace export and cache classification |

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
- `anomalies`: `cache-drop` (a step's cached tokens fell below the previous step's), shown as `cache-drop(ok)` when
  the classification explains it (provider-side, expired, declared, or within prefixlens's 128-token tolerance),
  `cache-drop` when it does not, `cache-drop(?)` when the run was not classified; `avoidable-miss` and
  `usage-only-record` (from the classification); `effect-unknown` and `not-started` (tool calls settled that way),
  `unsettled-tool`, `no-execution-end` (no end event, or an execution that started and never ended),
  `over-step-limit`, `malformed-event` (a line that is not a valid event).
- Under the totals, `cache misses (N/M runs classified): P provider-side, I intentional, A avoidable; U usage-only records`.

Under `--out`: `results.json` (options, totals and one entry per run with every metric: tool calls by tool and by
outcome, retries by error kind, per-step `(input, cached, output)` tokens, the session ID, unknown event types with
counts, every anomaly with its detail, each turn's exit and time, and `cache`: the classification with every miss
and its verdict), the commit the runs were taken at, and `runs/<task>-<n>.jsonl` / `.stderr.log` /
`.trace.jsonl`, the raw stream, stderr and exported trace of each run. Results and traces are never committed.
Event types the runner does not know are counted, never fatal, so it keeps working while the schema grows.

### The stand-in agent

`testing/stand-in-agent.ts` takes the CLI's flags and writes an event stream built from the core event types, so the
runner can be tested before the engine exists. `STAND_IN_MODE` picks the behaviour: `solve` (default; applies the
reference solution of the task whose prompt it got), `nothing`, `hang` (stops on Ctrl-C like the CLI), `stubborn`
(ignores Ctrl-C), `crash` (exits with `STAND_IN_EXIT`, default 3, mid tool call), `replay` (writes the file named
by `STAND_IN_EVENTS`) or `scripted` (writes the scripted trace session `STAND_IN_SCRIPT` from
packages/core/test/trace/sessions.ts into a real session database under `XDG_DATA_HOME` and prints its events, so the
export and classification run for real; `STAND_IN_BUILDER=broken` makes its ledger unreproducible). Given
`--session`, it continues that session, and in `solve` mode applies the reference solution only on a task's last
prompt. The CLI's own scripted demos work too: `--cli "bun packages/cli/src/main.ts --demo 5 --demo-speed 0"`.
`run-agent.test.ts` covers the runner with it.

## The regression gate

A full suite run, then the gate:

```
bun evals/run-agent.ts --all --model gpt-6-luna --effort low --repeat 3 --out /tmp/eval-a   # 15 tasks x 3, about 15 min
bun evals/gate.ts /tmp/eval-a                                                               # compare with baseline.json
bun evals/gate.ts /tmp/eval-a --hard-only                                                   # harness bugs only, any repeat count
bun evals/gate.ts /tmp/eval-a /tmp/eval-b --json                                            # several directories pool by task
```

Exit codes: 0 pass; 1 a hard failure or a regression; 3 inconclusive (nothing failed, but some comparison lacked the
repeats it needs or some run was not classified: that is not a pass); 2 usage error.

The output is one line per finding, worst first, then a verdict:

```
FAIL       avoidable-miss       fix-failing-test#2: avoidable cache miss, turn 4: tools_changed: tool list changed (-1 tool: 6 → 5)
REGRESSION pass-rate            rename-function: passed 3/3 in the baseline, 1/3 now (never failed in the baseline, now fails in a majority)
NO-DATA    repeats              add-feature: baseline 1 run(s), new 3; pass rate, tokens and steps need 3 on each side
INFO       wall-time            overall: median wall 19.2s (baseline 18.6s)

gate: FAIL  1 hard failure(s), 1 regression(s), 1 without enough data, 52 check(s) passed
```

| rule | kind | fails when | why this threshold |
| --- | --- | --- | --- |
| `avoidable-miss` | hard | any avoidable cache miss | prefixlens proved from full requests that the harness changed its own prefix; model noise cannot do that |
| `usage-only-record` | hard | any record not exported full-request | the request rebuilt from the log is not what was sent: the builder is not deterministic or the log is wrong |
| `classification-error` | hard | the export or the report failed | the cache rules above could not run |
| `no-execution-end` | hard | a run, or one of its executions, has no end event | the CLI must always end what it starts, even on Ctrl-C |
| `effect-unknown`, `not-started`, `unsettled-tool` | hard | such a tool call in a run that was not interrupted | outside an interrupt every call must settle cleanly |
| `malformed-event` | hard | any line that is not a valid event | the stream is the CLI's contract; unknown event types are tolerated, broken ones are not |
| `time-limit` | hard | killed after ignoring Ctrl-C for the grace period, or over 1.5x the limit | stopping at the limit is model slowness; not stopping is a harness bug |
| `setup-failed` | hard | a workspace setup failed | an eval bug, not a result |
| `pass-rate` (task) | statistical | baseline passed every time and a strict majority of new runs fail; otherwise a one-sided Fisher exact test at p < 0.05 | a solid task does not lose a majority to noise (2 of 3 at a true 0.9 pass rate: 2.8%); Fisher is exact at small n and needs a large drop |
| `pass-rate` (overall) | statistical | Fisher, p < 0.05, pooled over tasks compared | many runs give power for a broad, moderate drop no single task shows |
| `input-tokens`, `steps` (task) | statistical | new median over 1.5x and over +5k tokens / +2 steps | medians of 3+ runs ignore one long run; the floors keep small tasks from flapping on one extra tool call |
| `input-tokens` (overall) | statistical | median of per-task ratios over 1.25, with 3+ tasks | noise cancels across tasks; a 25% shift in the middle task is systematic (a longer prompt, untruncated output) |
| `wall-time`, `cached-share` | report-only | never | they follow the provider's load and cache, not the harness |

Statistical rules need at least 3 runs of a task on each side and the same model and effort as the baseline;
otherwise they report `NO-DATA`. `UNCHECKED` means some runs were not classified (no prefixlens checkout, or results
from before classification existed). The thresholds and their reasoning are in `RULES` in `gate.ts`.

### Refreshing the baseline

```
bun evals/gate.ts /tmp/eval-a /tmp/eval-b --update-baseline     # writes baseline.json from these results; refused on a hard failure
bun evals/baseline.ts /tmp/eval-a [--commit <sha>] [--note <text>] [--out <file>]   # the generator itself
```

The baseline holds one configuration (model, effort): per task the runs, passes, pass rate, median steps, wall time
and input tokens, and cached share; the same over all runs; the date, the commit the runs recorded (`--commit` for
older results that did not record one), the source directories and a note. Refresh it on purpose, after a change
that is meant to change the numbers, and commit it with that change. Updating accepts any statistical regression in
the new results; it never accepts a hard failure.

The committed `baseline.json` is a single-repeat seed from the first real run (2026-11-11, gpt-6-luna, low effort,
at a1b9d1f): every statistical comparison against it reports not enough data. Regenerate it from at least 3
repeats of all 15 tasks before relying on the gate's statistics.

### Honest limits

- One model and one effort level per baseline. Another configuration is not comparable, only hard rules apply.
- Fifteen small synthetic tasks. A pass rate over them says the harness works on small, well-specified jobs; it says
  little about long sessions, large repositories or vague requests.
- Variance. At 3 repeats only big drops are detectable: a task that went from 90% to 60% will usually pass the gate.
  More repeats buy sensitivity at the price of time and requests (15 tasks x 3 is about 45 runs and 15 minutes).
- The provider's cache is noisy (4 of the first 10 runs had provider-side misses), which is why the cached share is
  report-only and only avoidable misses fail.
- Classification needs the sibling prefixlens checkout and the CLI's session database on the machine that ran the
  suite. Without them the cache rules are unchecked, never silently passed.
- `add-feature` failed in the seed run because of a grader bug since fixed; `retry-after-error` fails on model caution
  (gpt-6-luna at low effort will not remove a stale lock without confirmation).

## Workspace conventions

- A file stored as `name.in` is copied into the workspace as `name`. Test files (`*.test.ts`) are stored this way so
  the repository's own `bun test` does not pick up the deliberately failing tests.
- `setup` is an argv run in the copied workspace before the agent starts. Use it for anything large or generated;
  generated files are never committed (see `.gitignore`).
- `.git` and `node_modules` in a finished workspace are ignored by graders.

## Adding a task

1. Create `tasks/<id>/` with the files above. `id` in `task.json` must equal the directory name.
2. Write the prompt as a user would type it: say what they want, not how to do it. For a multi-turn task give
   `prompts`, a list; later prompts may refer to earlier turns, as a user's follow-up would.
3. The grader judges the outcome, not the method. It must fail on the untouched workspace and on a plausible wrong
   answer (hard-coding, editing the tests instead of the code, touching files it should not), and must never need
   the network. Prefer hidden inputs the agent has not seen over checking the exact diff.
4. Write the reference solution and run `bun test evals`.

## The rule

Every workspace is synthetic and hand-written for this purpose: a few small files, no code copied from real
projects or other repositories, no secrets or real personal data, no dependencies beyond Bun's built-ins.
