# Replay

Replay answers one question: **when I change the system prompt, a tool description, the model or the effort, where
does the model's behaviour change in sessions that really happened?** It runs the real model again on a recorded
session, against the changed baseline, and answers every tool call that is on the recording from the recording.
While the model does what it did, nothing runs: no command, no edit, no check, no question. The first call it makes
differently is the finding.

It does not answer whether the new behaviour is better. That is what the eval suite measures (`evals/run-agent.ts`,
`evals/gate.ts`). Replay is the cheap first look: a replay under the default policy costs a few model calls and has
no side effects, so it can be run on every recorded session you have.

## Running it

One session:

```
bun scripts/replay.ts <session-id> [--system-prompt <file>] [--tool-description <tool>=<file>]...
                      [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute]
                      [--strict] [--json] [--through <seq>] [--workspace <dir>] [--data-dir <dir>]
```

- `<session-id>` is a session of the harness data directory, or a unique prefix of one.
- `--system-prompt <file>` replaces the base system prompt. The recording's own sections (its AGENTS.md files, its
  environment, its date) stay as they were recorded: today's date and today's files are not the recording's.
- `--tool-description <tool>=<file>` replaces one tool's description. Names and schemas stay the recording's.
- `--model`, `--effort` (`default` for the model's own) change the settings of the whole replay.
- `--strict` compares arguments byte for byte after JSON canonicalisation and requires the same step boundaries.
  Without it a path given relative or absolute is the same path, trailing whitespace of a command does not matter,
  parallel calls match in any order, and a run of read-only steps may be split or merged.
- With nothing changed it shows how much the model varies by itself (the noise floor, below).

A set of recorded eval runs, as one table:

```
bun evals/run-agent.ts <tasks...> --model <m> --effort <e> --out <dir>     # record
bun evals/replay-suite.ts <dir> --system-prompt <file> [--policy execute] [--noise N] [--repeat N]
```

## The three policies

| Policy | At the first call that is not on the recording | Use it for |
| --- | --- | --- |
| `stop` (default) | The call is not run; the replay ends there. | "Where does this change alter behaviour?" No side effects at all. |
| `execute-read-only` | Read-only tools run in a copy of the recorded workspace; the first tool that could change something ends the replay. | Seeing a little further than the first different read. |
| `execute` | The recorded workspace, as it was at that point, is restored into a copy, and the replay finishes the turn there with real tools. | Grading what the changed behaviour produces. |

Under the policies that run tools:

- The copy is restored from the snapshot that was current when the recording reached the point the replay left it
  at. It is made under `<data dir>-work/replays/<replay session>` (or `--workspace`), never in the recording's
  workspace, which is not touched: the replay session's working directory is the copy.
- Tools run under the approval layer in mode `auto` with nobody present: commands in the OS sandbox with the network
  off, edits inside the copy; anything that would need a question is refused, not asked.
- A path the model writes as the recording's workspace means the copy, and output that names the copy is shown as
  the recording's path, so the conversation stays the recording's.
- After it has left the recording the replay is an ordinary turn: the step limit applies, and the copy's own
  project checks run (in the sandbox) before the turn may end. It finishes the turn in which it left; inputs the
  recording received later are not delivered.

**What the copy does not reproduce.** A snapshot holds what the snapshot module records: no ignored file (so no
`node_modules`, no build output), no untracked file over 2 MiB, nothing inside a nested repository. Nothing outside
the workspace is copied, and the outside world is not the recording's: the network is off, services and
credentials are whatever they are now. A replay that needs installed dependencies to run its tests needs them
installed in the copy first, and says so by failing.

## Reading the report

```
replay ses_e79e…: DIVERGED  left the recording at step 2, call 1: arguments differ
  recorded   write {"path":"/w/a.txt","content":"two\n"}
  replayed   write {"path":"/w/a.txt","content":"three\n"}
  changed    content: "two\n" -> "three\n"
  matched before: 1 step, 1 call (0 normalised, 0 reordered, 0 split, 0 merged)

                  recorded  replayed
  steps                  6         2
  calls read             1         1
  …
  final answer
    recorded  "Added b.txt."
    replayed  (not reached)
```

- **Status.** `identical`: every recorded step was replayed and matched. `diverged`: the replay left the
  recording; the first line says at which step and call and how. `unsupported`: the recording does something a
  replay cannot reproduce at that point. `incomplete`: the replay ended for another reason (an interrupt, a
  provider failure, the process stopping).
- **How it left** (`kind`): `arguments_differ`, `different_tool`, `extra_call`, `call_instead_of_text`,
  `text_instead_of_call`, `missing_calls`, `past_end`.
- **Matched before** is how far the model did what it did: steps, calls, and how many of them needed a normaliser,
  came in another order, or had their step boundary moved.
- **Off tape** (under `execute`): steps and calls after the divergence, and how many ran for real.
- **Text is compared only as the final answer**, side by side; a step that says something different and makes the
  same calls is the same step.

Every replay is a session of its own, typed as a replay in its log (`session.created` with `lineage.kind =
"replay"`: of which session, through which event, with which policy, and what was changed). Per call it records
`replay.call` (matched, normalised, dropped, diverged or off the recording, and whether the tool ran for real),
`replay.diverged` when it starts on a copy, and `replay.ended` with the outcome, the reason and the whole report.
A replay session takes no prompts, is not reverted and is not forked.

## The noise floor

A model is not deterministic. Replay the same recording with **nothing changed** and it will often leave the
recording anyway, because the model reads another file first or words a command differently. A result means
something only against that: so the suite replays every run `--noise` times (default 2) with nothing changed, and
prints that next to every result.

Measured on five recorded eval runs (`gpt-6-luna`, low effort, 6 to 9 steps each), ten unchanged replays:

| task | unchanged replays that left the recording | where |
| --- | --- | --- |
| fix-failing-test | 2 of 2 | step 2 read (extra call); step 3 shell (arguments differ) |
| crashing-script | 2 of 2 | 2x step 2 read (arguments differ) |
| rename-function | 2 of 2 | step 1 glob (extra call); step 2 glob (different tool) |
| project-checks | 2 of 2 | step 1 glob (arguments differ); step 1 grep (different tool) |
| agents-md-rule | 2 of 2 | 2x step 1 ls (arguments differ) |

Ten of ten left within the first three steps. At this effort the model explores a little differently every time,
so **how often a replay leaves its recording says nothing by itself**: the count is at the floor before any change
is made.

What does carry information is **where and how** it leaves. With a rule added to the system prompt ("run the
project's tests before editing anything"), all five replays left at `step 1 shell (different tool)`: the model ran
the tests first, which no unchanged replay did. The suite reports this as the *new place* column (how many replays
left at a step, tool and kind where no unchanged replay of the same task did) and words its verdict from it.
Under `execute` those five replays ran to their end in copies and were graded: 5 of 5 passed their task's grader
(the recordings: 4 of 5).

What to conclude:

- Trust a replay for **a change that shows early and in kind**: a new first action, a tool that is used or no
  longer used, a command that is always run differently. Read the place, not the count.
- Do not read anything into "it diverged" for exploratory sessions, and do not compare divergence rates of two
  prompts unless both are far from the floor. More unchanged replays make the comparison sharper; two are a
  minimum, not a measurement.
- A long recorded session is mostly unreachable under `stop`: the replay leaves in the first steps, and what the
  change would do in step 30 is not seen. `execute` reaches the end, at the price of real runs in a copy, and
  what it reaches is one sample of a non-deterministic model: grade it over several replays, or use the evals.
- Sessions that follow a fixed procedure (a scripted workflow, a recorded demo) have a low floor and are where an
  exact replay is at its best.

## What a replay cannot do

- **Say how the session would have gone after the divergence**, under `stop`. From the first different call on,
  the tool results and possibly the workspace differ from the recording.
- **Reproduce faults.** A step cut by a provider error, a crash or a shutdown is skipped, with the harness message
  that only exists because of it. A step the recording's user interrupted is replayed as far as the recording kept
  it, and the marker is delivered as the message it was; the replay itself is not interrupted.
- **Cross a compaction, a revert or a refusal.** The recording's history changed there in a way a replay cannot
  make happen again; it stops as `unsupported` and says where.
- **Move the recording's inputs.** A message the user sent between steps 4 and 5 is delivered before the replay's
  step 5, whatever the model did until then.
- **Survive its own process.** A replay that is interrupted, or whose process stops, ends as `incomplete`. The
  session is consistent (its open step is closed as after any crash) and is not taken up again: replay the
  recording once more.

## For code

```ts
const run = await engine.replaySession(sessionId, { systemPrompt, toolDescriptions, model, effort, policy, strict })
const outcome = await run.done      // { report, sessionId, workspace, usage, requests }
```

`run.session` is the replay session: its events are the replay's progress, and `interrupt()` ends it. The matcher,
the tape and the report are `packages/core/src/replay/`; the loop that drives them is `replayLoop` in
`engine/engine.ts`.
