# evals

End-to-end tasks for testing the agent the way a user would: a small workspace, a prompt typed in a natural voice,
and a grader that checks the finished workspace.

```
evals/
  grader.ts          helpers for graders (pass/fail, run a command, compare with the original workspace)
  run-check.ts       copy a workspace, run setup, optionally apply the reference solution, grade
  graders.test.ts    every untouched workspace fails its grader; every reference solution passes
  alternatives.test.ts  other correct solutions each grader must accept, and wrong ones it must reject
  run-agent.ts       run the agent on tasks, grade, and report metrics from its event stream
  run-agent.test.ts  the runner, driven by testing/stand-in-agent.ts
  classify.ts        export a run's session as a trace and have prefixlens explain its cache misses
  baseline.ts        build baseline.json from results directories
  baseline.json      the committed baseline the gate compares against
  gate.ts            the regression gate: new results against the baseline
  gate.test.ts       the gate and the baseline generator, on crafted results
  memory-compare.ts  the A/B comparison that decides whether memory stays: the same tasks with and without it
  memory-compare.test.ts  the comparison, on crafted results
  memory-tasks/      the memory A/B task set (see "The memory A/B task set"), never part of --all
  tasks/<id>/
    task.json        { id, title, prompt | prompts, tags, timeoutSeconds, maxSteps, setup?, run? }
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
CLI as `<cli> --json --cwd <dir> --max-steps <maxSteps> [--model] [--effort] -- <prompt>`, sends SIGINT (Ctrl-C) at
the task's `timeoutSeconds` and SIGKILL if the agent has not stopped `--grace` seconds (default 15) later, saves the
JSONL stream, and runs the grader. With `--max-steps` the CLI makes one last call without tools when a turn reaches
the task's limit instead of going on; steps are still counted from the stream, and a run over `maxSteps` is flagged.

A task with `prompts` (a list) instead of `prompt` is one session over several turns: after a turn's process exits,
the next prompt is sent with `--session <id>` (the ID from the first turn's events) and `--max-steps`, without
`--model`/`--effort`, which the session keeps (passing them again would record a settings change and break the prompt
cache). The time limit covers the whole run; a turn that times out, crashes or exits non-zero (exit 3 included) ends
the run, and the grader runs after the last turn that was sent. All turns go into one event stream.

After each run the runner exports the session from the CLI's data directory (`$XDG_DATA_HOME/light-harness/`, or
`~/.local/share/light-harness/`, where each session is its own database file, `sessions/<id>.db`; or `--db`) with
`scripts/export-trace.ts` and runs `prefixlens report --json` on the trace
(`classify.ts`; prefixlens is the sibling checkout `../prefixlens` or `PREFIXLENS_DIR`, run by path). Each call that
lost cached tokens is sorted into provider-side (prefix intact, the provider missed: common on quick follow-ups),
expired, intentional (a break the harness declared, within what the declaration allows) or avoidable (anything
else, with prefixlens's cause: a harness bug). A record exported usage-only means the request rebuilt from the log is
not what was sent, also a harness bug. Without prefixlens, a session ID or the data directory the step is skipped and
says why.

Because every session has its own file, several agent processes can run at once, so `--concurrency` above 1 works
with the real CLI; the export reads a copy of the session's file and never holds it.

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
| `--db <path>` | where to export traces from: a harness data directory, or a single database file (default: the CLI's data directory, under the agent's `XDG_DATA_HOME`) |
| `--no-classify` | skip the trace export and cache classification |
| `--memory with\|without` | one side of the memory A/B: tasks from `memory-tasks/`, each run with its own user configuration, memory on and the task's notes seeded, or memory off (see "The memory A/B task set") |

A task can ask for its own run settings with `run` in its task.json. The only one is `contextWindow` (tokens): the
runner sets the test context window variable (`<BRAND>_TEST_CONTEXT_WINDOW`, docs/architecture.md, "The context
window in tests") for that task's runs, so a long task compacts early. An unknown key fails the run before it starts.

The exit code is 0 only when every run passed.

### Reading the output

```
task              #  result   exit  end               wall  steps  tools  retry  in    cached  out  anomalies
fix-failing-test  1  passed   0     succeeded         0.1s  2/15   1      1      2.6k  44%     120  -
answer-question   1  timeout  130   interrupted:user  1.0s  1/12   0      0      0     -       0    -

passed 1/2 (50%)  median wall 0.6s  tokens 2.7k (in 2.6k, out 120)  cached 44%  anomalies 0
```

- `result`: `passed`, `failed` (the agent finished, the grader said no), `timeout` (stopped with Ctrl-C at the limit),
  `killed` (ignored Ctrl-C), `crashed` (exited without an `execution.*` end event, or a multi-turn run that ended
  before its last prompt), `error` (setup failed). A run the grader passes is `passed` whatever else happened.
  Failing runs are listed under the table with the grader's one-line reason.
- `exit`: the CLI's exit code of the last turn (0 done, 1 failed, 2 usage error, 3 done but the project's checks were
  left unresolved, 130 interrupted), or the signal that killed it. Exit 3 still ends in `execution.succeeded`: the row
  shows `end` as `succeeded`, the grader decides `passed` or `failed`, and `verification` in `results.json` is
  `unresolved`. In a multi-turn task it stops the run before the next prompt, so a failing run is `crashed`.
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
- `add-feature` failed in the seed run because of a grader bug since fixed (it required `NaN` to throw). In the seed
  run `retry-after-error` failed on model caution (gpt-6-luna at low effort would not remove a stale lock without
  confirmation); its prompt now says the last run crashed and not to check back, so stopping to ask is a failure the
  prompt itself rules out. The seed baseline predates both changes.

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
   the network. Prefer hidden inputs the agent has not seen over checking the exact diff. See the rules below.
4. Write the reference solution, add at least one other correct solution and one plausible wrong one to
   `alternatives.test.ts`, and run `bun test evals`.

## Writing a fair grader

A grader that fails correct work makes the pass rate meaningless and makes the gate flap. Before a task goes in, read
its prompt as a careful engineer would, list the reasonable ways to satisfy it, and check the grader takes them all.

- Grade only what the prompt asks. A requirement the prompt does not state (`NaN` must throw when it said "below 0 or
  above 100") is a grader bug. Where the prompt leaves a choice open (rounding, what a second call does, where tests
  go, file and helper names), grade inputs on which every reasonable choice agrees.
- Require a file to be byte-identical only when the prompt says to leave it alone ("don't edit orders.json", "don't
  change the tests", "don't change any code"). Otherwise check what the file must still do. For tests the agent may
  add to but not weaken, run the original test files against the code (`requireOriginalTestsPass`) instead of
  freezing the file.
- Compare meaning, not text: parse JSON and YAML, pick out the lines that matter from output (an extra notice line is
  not a wrong summary), read numbers out of an answer with or without a unit, skip comments when scanning code.
- Judge behaviour, not structure: import the module and call it rather than matching `export function name`; accept
  an arrow function, a helper, a type in another file.
- Do not depend on the reference solution's incidental choices. Write a second correct solution that differs from it
  where the prompt allows, and check it passes.
- Be strict where the task's purpose is: a rule in a nested AGENTS.md, a frozen API, not editing the tests. Those must
  still fail when broken, and `alternatives.test.ts` holds a case that breaks them.
- Make sure nothing done, a hard-coded answer and the most likely wrong reading all fail.
- No dependence on time, the machine, ordering of directory listings or the network; generated inputs come from a
  fixed seed.
- If the prompt is ambiguous and both readings are defensible, accept both. Change the prompt instead, in the user's
  own voice and without saying how to do the job, only when the task exists to test one reading.
- Every fix gets a case in `alternatives.test.ts`: the correct solution the old grader rejected, and for a tightened
  grader the wrong one it now rejects.

## The rule

Every workspace is synthetic and hand-written for this purpose: a few small files, no code copied from real
projects or other repositories, no secrets or real personal data, no dependencies beyond Bun's built-ins.

## The harder tasks

Twelve tasks added for the second baseline, because a suite on which `gpt-6-luna` at low effort passes 87% cannot
show improvement. Each covers something the first fifteen do not. Measured with 3 live runs each on `gpt-6-luna` at
low effort, on the final version of the task (2026-11-12, a busy two-core machine, so wall times are high):

| task | what it tests | passed | median wall, tokens |
| --- | --- | --- | --- |
| `rename-across-files` | a field renamed across a type, operations, a report, reminders, an email template and tests, with old stored data still loadable (the Invoice type is checked with the repository's TypeScript on a probe file) | 2/3 | 72s, 113k |
| `test-blames-wrong-file` | `report.test.ts` fails, the bug is the CSV splitter in `csv.ts` (quoted fields, separators); hidden statements | 2/3 | 64s, 105k |
| `not-a-bug` | the reported bug is fixed in this version (the customer runs an old one): change nothing, explain in ANSWER.md | 1/3 | 22s, 41k |
| `run-to-find-out` | which records the CI steps reject: the validator stops at the first and the checksums cannot be done by reading; two directories under two profiles (`.ci/pipeline.yml`) | 2/3 | 25s, 40k |
| `audit-every-handler` | a documented rule applied to 42 handlers in six files; runs with `run.contextWindow` lowered so it compacts | 2/3 (29k window) | 58s, 90k |
| `api-report-check` | add a function; the project check (an API report in `.api/`) fails until the report is updated: the verification gate sends the model back | 3/3 | 34s, 57k |
| `follow-a-skill` | a schema change done the way `.claude/skills/schema-change/SKILL.md` says (new migration, regenerated snapshot, changelog line, API field null when unset); the prompt states none of it | 3/3 | 46s, 88k |
| `nested-agents-md` | the same helper in two packages; a nested AGENTS.md says one package returns results instead of throwing | 3/3 | 88s, 76k |
| `generated-file-trap` | add an error code where the obvious file is generated (with a content hash) from `errors.json` | 3/3 | 41s, 75k |
| `read-chart-image` | which services to scale, readable only from a bar chart PNG (`make-chart.ts` in the task, outside the workspace, makes it; `graders.test.ts` checks the committed image is its output) | 0/3 | 62s, 83k |
| `due-dates-feature` | harder: a CLI feature across parsing, storage, ordering and output, with exact behaviour specified, driven through the CLI on unseen scenarios | 2/3 | 86s, 158k |
| `reconcile-several-bugs` | harder: a report wrong for three reasons in three Python modules (a dropped last page, a sign, rounding per SKU); a hidden second day of data | 1/3 | 53s, 107k |

What the failures were, read against prompt and grader:

- `not-a-bug` fails mostly because the model explains in its final message and does not write ANSWER.md (it said
  once "I left the code unchanged and did not create ANSWER.md"), and once by "fixing" working code and adding a
  test. The prompt was reworded twice to remove any reading of "don't change anything" that forbids the file
  (0/3, 0/3, then 1/3). `answer-question` fails the same way.
- `read-chart-image` fails because the model never gives the PNG to `read`: it tries Python, PIL, `file` and an MCP
  search, then reports it cannot see the image. The `read` tool's description says "Read a text file" and never
  mentions images, although it returns them. The task stays as it is: it should pass once the description says so.
- `audit-every-handler` at a 20k or 26k window loops: the model reads all six files in one step, the context
  compacts at once, the summary does not carry the files, and it reads them again (16 and 19 compactions in 38 and
  46 steps, nothing edited). At 32k it rarely compacts (one compaction in three runs). The task asks for
  `contextWindow: 29000`.
- `reconcile-several-bugs` and `rename-across-files` fail on the model: rounding the total instead of each SKU,
  which the README states; an email template still saying `{{userId}}`.
- Easy ones stay for a reason: `api-report-check` shows the gate working (in every run the checks ran twice, the
  first failing); `follow-a-skill` shows a workspace skill being loaded and followed; `nested-agents-md` and
  `generated-file-trap` are guards against carelessness that would show a regression.

Grader fixes made after reading failures (each has a case in `alternatives.test.ts`): `nested-agents-md` no longer
requires `"1e3"` and `"0x50"` to be rejected (whether they are whole numbers is a matter of reading);
`due-dates-feature` compares `list --overdue` as a set (the prompt fixes the order of `list` only);
`rename-across-files` accepts the reminder's `to` field renamed too, and its type probe no longer passes when
TypeScript fails to start.

## The memory A/B task set

`memory-tasks/` holds the tasks that decide whether memory ships (`memory-compare.ts`; the rule in
`packages/core/src/memory/README.md`, "Measuring it"). They are kept out of `tasks/` so they never mix into the
general baseline, `--all` or the nightly run. Each is a task like any other plus `memory/`, the notes a person or an
earlier session left, in the file format a person can edit (one terse, one with a detail slightly out of date). In
every task the convention can be found in the workspace with effort, and the note only saves the search:

| task | the convention | where it can be found without memory | passed without memory |
| --- | --- | --- | --- |
| `changelog-fragments` | changelog entries are fragment files in `.changes/`; CHANGELOG.md is generated | CONTRIBUTING.md, `scripts/release.ts`, the hidden `.changes/` directory | 3/3 (6 of 6 over two versions) |
| `amounts-in-cents` | every amount is integer cents | a comment at the end of `src/types.ts`, `src/ui/format.ts` dividing by 100 | 3/3 (9 of 9 over three versions) |
| `error-codes` | bad input raises `AppError` with a new registered, documented `E4xxx` code; `users.ts` is old code | `docs/errors.md` (the README points at it), `orders.ts`, `payments.ts` | 0/3 (0 of 6) |
| `prefixed-ids` | ids come from `newId(prefix)` with the prefix registered; two old modules use `randomUUID` | `src/ids.ts`, `threads.ts`, `comments.ts` | 3/3 (6 of 6) |
| `commit-convention` | commit messages are `area: lowercase summary`, blank line, `Refs: #<issue>` | `git log` (CONTRIBUTING.md says to follow it) | 0/3 (0 of 6) |

Measured without memory (3 runs each, `gpt-6-luna`, low effort) the set is lopsided, not "sometimes": three tasks
always pass and two always fail. Each was adjusted once after the first measurement (the convention moved further
from the code, or a pointer to it was added) without moving it. In the passing ones the model's routine first steps
(`glob **/*`, reading the files it edits whole) find the convention; in the failing ones it follows the code nearest
to the change (`users.ts` throws plain errors) or ignores what it saw (every `commit-convention` run ran
`git log --oneline` and still wrote `Fix oversized upload error typo`). The three that always pass cannot show a gain;
the two that always fail can, and the pooled test still has room (9 of 15 without; 15 of 15 with would be p < 0.01).
More tasks in the middle are the next thing this set needs.

Run both sides with the same model and effort, then compare:

```
bun evals/run-agent.ts --all --memory without --model gpt-6-luna --effort low --repeat 3 --out /tmp/mem-without
bun evals/run-agent.ts --all --memory with    --model gpt-6-luna --effort low --repeat 3 --out /tmp/mem-with
bun evals/memory-compare.ts --with /tmp/mem-with --without /tmp/mem-without
```

`--memory` reads the tasks from `memory-tasks/` and gives every run its own user configuration directory
(`XDG_CONFIG_HOME`, beside the workspace, removed with it). On the `with` side its `config.json` is
`{ "memory": { "enabled": true, "inRepository": true } }` and the task's notes are copied into the workspace's
`.<brand.directory>/memory/` after setup, so they are project notes of that workspace; on the `without` side it is
`{ "memory": { "enabled": false } }` and nothing is seeded. Both sides therefore ignore any user configuration on the
machine; the sign-in and the session files stay in the data directory. Two things differ between the sides beyond
the delivered notes, and both are part of the treatment: the `with` side has the three memory tools in its tool
list, and its notes are files in the workspace (the model may find them with `ls -a`, and `git status` shows them as
untracked in `commit-convention`). Graders ignore them. The notes lapse 90 days (a fact) or a year (a preference or
correction) after their dates; re-date them if the comparison is run after that.

## The nightly run

`nightly.ts` is the one command a scheduled job runs, and a person can run it by hand:

```
bun evals/nightly.ts                                   # the real run: about 350 live requests, about 20 minutes
bun evals/nightly.ts --dry-run                         # the same flow without the model: the stand-in and the oracle
bun evals/nightly.ts --dry-run --tasks answer-question --repeat 1 --root /tmp/nightly-try
```

In order it records the commit (and refuses a tree with uncommitted changes unless `--allow-dirty`); runs the task
suite (`run-agent.ts`) on every task with `--repeat 3`, the repeats the gate's statistics need (`RULES.minRepeats`),
with the model and effort the baseline was recorded with (`--model`, `--effort` to override), each run's cache misses
classified as usual; runs the gate against `baseline.json` (`--baseline` for another file); runs the recall tracker
(`recall/track.ts --live`, strategy `engine` by default, `--recall-strategies`) and then its `--check` (margin 2,
`--recall-margin`); and writes one summary directory.

Where it writes: a root outside the repository, by default `$XDG_DATA_HOME/<brand>-nightly/` (or
`~/.local/share/<brand>-nightly/`), `--root` for another. Each run is a directory named by its UTC start time,
`<root>/2026-11-13T030000Z/`, and `<root>/latest` points at the newest:

```
summary.md          a page to read in a minute: the verdict and exit code, the commit, pass rate per task against the
                    baseline, regressions by name, cached share and avoidable misses, recall against the previous row,
                    model requests and tokens, how long each phase took
summary.json        the same as data (`NightlySummary` in nightly.ts)
gate.txt, gate.json the gate's findings
recall.log          what the tracker printed, both runs
tasks/              run-agent's results.json and runs/ (streams, stderr, exported traces)
```

The directory is written aside (`<root>/.staging-<stamp>/`) and renamed into place when complete, so a dated
directory always holds a whole summary. A run that is killed leaves its staging directory (and the runner's
temporary workspaces under the system temp directory); the next run removes the staging directory. A lock,
`<root>/nightly.lock` with the process ID, keeps two runs from overlapping; a second run exits 5 at once, and a lock
whose process is gone is taken over.

The recall rows go to the nightly's own history, `<root>/recall-history.jsonl`, started from a copy of the committed
`recall/history.jsonl` on the first run, so a scheduled run never changes the repository. Commit a row to
`recall/history.jsonl` by hand when it should become the reference. A dry run keeps its oracle rows apart, in
`<root>/recall-history.dry-run.jsonl`.

| exit | meaning |
| --- | --- |
| 0 | the gate passed and recall did not drop |
| 1 | the gate failed: a hard failure or a regression |
| 2 | recall dropped by more than the margin |
| 3 | both |
| 4 | inconclusive: nothing failed, but the gate lacked data (repeats, configuration, classification) or the recall rows were not comparable |
| 5 | another nightly run holds the lock |
| 6 | the run could not be completed: a dirty tree, or a step that threw (the summary's `errors` says which) |
| 64 | usage error |

Until the baseline holds three repeats of every task, a real run ends in 4. `--dry-run` uses the stand-in agent in
`scripted` mode (set `STAND_IN_MODE` for another) with its sessions in a data directory inside the summary, so the
trace export and the classification run for real; its tasks are graded as failed because nothing solved them, and
it is compared with the committed baseline only as "not comparable". `nightly.test.ts` runs the whole flow this way.

### Scheduling it

Nothing is installed by the repository. To run it every night at 03:00 with cron (`crontab -e`), from a checkout
that is kept on `main` and signed in:

```
0 3 * * * cd /path/to/checkout && PREFIXLENS_DIR=/path/to/prefixlens /path/to/bun evals/nightly.ts >> "$HOME/.local/share/<brand>-nightly/cron.log" 2>&1
```

Or with a systemd user timer, two files under `~/.config/systemd/user/`:

```ini
# nightly-evals.service
[Unit]
Description=Nightly evals
[Service]
Type=oneshot
WorkingDirectory=/path/to/checkout
Environment=PREFIXLENS_DIR=/path/to/prefixlens
ExecStart=/path/to/bun evals/nightly.ts
```

```ini
# nightly-evals.timer
[Unit]
Description=Nightly evals at 03:00
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
```

then `systemctl --user daemon-reload && systemctl --user enable --now nightly-evals.timer`, and
`journalctl --user -u nightly-evals` for its output. The job's exit code is the table above; a wrapper that alerts on
anything but 0 and 4 catches failures without crying wolf while the baseline is thin. Each run spends about 350 live
requests of the plan's allowance.
