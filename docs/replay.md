# Replay

Replay runs the real model again on a recorded session, against a changed system prompt, tool description, model
or effort, and answers every tool call that is on the recording from the recording. While the model does what it
did, nothing runs. Where it does something else, the `stop` policy ends the replay, and `execute` carries on for
real in a copy of the recorded workspace, so the result can be compared and graded.

**What it can tell you, measured (2026-11-12, `gpt-6-luna`, the numbers and their sample sizes are below):**

- **Whether, and where, a replay leaves its recording tells you nothing on these sessions.** With nothing changed
  20 of 20 replays left within the first four steps, on a different read, `glob`, `grep`, `ls` or shell look. The
  same was true at medium effort (2 of 2). Do not read divergence counts.
- **A matcher that lets reads pass does not fix that under `stop`.** Answering a read from the recording wherever
  that is sound, 17 of 20 unchanged replays still left: 15 at a read the recording has no answer for, 2 at a
  different side effect.
- **Under `execute`, compare what the replay did and what it ended with, not how it looked.** The suite prints,
  next to the old count: the side effects (writes, edits and commands that may change something, in order), the
  set of files changed, the files byte for byte, and the grader's verdict. With nothing changed: files changed
  0 of 20 differed; grader 20 of 20 passed; side effects 14 of 20 differed, but by task, from 1 of 7 (a config
  edit) to 7 of 7 (a bug fix the model tests before or after editing, and writes two ways) and 6 of 6 (a task
  whose result is a note in prose).
- **A change showed only where the floor was low.** "Run the project's tests before editing anything" changed the
  side effects in 3 of 3 replays of the config task against 1 of 7 unchanged (Fisher p = 0.03, a tiny sample), and
  changed neither the files nor the grade there or on the bug fix (1 replay).

So: **only `execute` replays, read on side effects, files changed and grade, carry a signal, and only on tasks whose
floor on that measure is low. Divergence counts are noise.** Replay does not say whether the new behaviour is
better; that is the eval suite (`evals/run-agent.ts`, `evals/gate.ts`). A comparison under `execute` costs about as
many model calls as the recording has steps (5.9 per replay here), per replay.

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
                          [--noise-policy stop|execute]
```

Under `--policy execute` the unchanged replays (`--noise`) run under `execute` too, so both sides are compared like
with like; `--noise-policy stop` makes them cheap again, at the price of measuring only the old count.

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

Below the report the script prints the comparison that ignores reads (`replay/effects.ts`):

```
compared on what it did (reads ignored)
  side effects   differ at act 1: shell "bun test" (act differs) (recorded 2, replayed 2)
  lenient        would have left at step 2 read "README.md" (a look not on the recording) (4 reads answerable from the recording, 1 not)
  files          the same as the recording's at its end
```

- **Side effects** are the calls that may change something: `write` and `edit` (not when they failed: they check
  everything before they write), and every `shell` command that is not on a short list of readers (`cat`, `ls`,
  `grep`, `sed -n 'Np'`, `git status`, `find` without `-exec`/`-delete`, and so on, with no redirection into a
  file, command substitution, heredoc or background job). Test runners, builds and interpreters count, because
  they can write. They are compared in order, with a step's parallel calls in any order, paths normalised and a
  command's `timeout` ignored. Compared only when the replay reached an answer of its own (`execute`, or a replay
  that answered while still on the recording).
- **Lenient** is where a matcher that let reads off the recording pass would have stopped without a copy: at the
  first read no recorded call can answer soundly (an identical call, with no recorded side effect between where it
  was recorded and where the replay is, not run in parallel with one, in the same turn), or at the first side
  effect that differs.
- **Files** compares the replay's copy at its end with the recording's last snapshot. The suite also compares the
  set of files changed, whatever was written in them.

Every replay is a session of its own, typed as a replay in its log (`session.created` with `lineage.kind =
"replay"`: of which session, through which event, with which policy, and what was changed). Per call it records
`replay.call` (matched, normalised, dropped, diverged or off the recording, and whether the tool ran for real),
`replay.diverged` when it starts on a copy, and `replay.ended` with the outcome, the reason and the whole report.
A replay session takes no prompts, is not reverted and is not forked.

## The noise floor, measured

A model is not deterministic, so every result means something only against replays with **nothing changed**. The
suite replays every run `--noise` times (default 2) and prints those next to the change, and says in words which
differences chance alone could make (a two-sided Fisher exact test) and that "within chance" at a few replays does
not mean "no effect".

Measured 2026-11-12 on `gpt-6-luna`, under `execute`, on recordings of three eval tasks (one recording each,
4 to 5 steps): `fix-failing-test`, `config-edits` and `frozen-api` (it should refuse and leave a note). 195 live
requests in all, including the recordings.

| measure (replays that did it, of those measured) | unchanged, low (20: 7, 7, 6) | unchanged, medium (2, config) | changed, low (3 config + 1 fix) |
| --- | --- | --- | --- |
| left the recording (the old measure) | 20/20 | 2/2 | 4/4 |
| a lenient matcher without a copy would have left | 17/20 | 1/2 | 4/4 |
| other side effects | 14/20 (fix 7/7, config 1/7, frozen 6/6) | 1/2 | 4/4 (config 3/3) |
| other files changed | 0/20 | 0/2 | 0/4 |
| other bytes in the files | 12/20 (fix 5/7, config 1/7, frozen 6/6) | 0/2 | 2/4 |
| passed the grader | 20/20 | 2/2 | 4/4 |

What the rows say:

- **Left the recording.** Every replay left, within its first four steps, in 13 different places: a different
  first look (`glob` instead of `ls`, an extra `read`, `grep` instead of `glob`), or answering without the last
  recorded check. At this floor no change can show by count, and the "new place" column (where a change left
  where no unchanged replay did) is a hint at best: with 13 places in 20 replays, a new place is likely by chance.
- **Lenient.** Under `stop` a lenient matcher would answer most reads (2 to 5 per replay) from the recording, and
  still stop at the first read the recording never made in 15 of 20 (2 more left at a different side effect). Reads are not repeated, they are different.
  It is not built as a live mode (it needs the engine; `packages/core/src/replay/README.md` says what).
- **Side effects** are as noisy as the task allows. On the bug fix the recording edited and then tested; 5 of 7
  unchanged replays ran `bun test` before editing, and 2 wrote the fix with another, equivalent formula. A note in
  prose is never written the same way twice. A config edit is (6 of 7 the same). So the rule tried as the change
  ("run the tests before editing") is what the bug-fix replays did most of the time anyway, and only the config
  task, with no tests and a low floor, could show it.
- **Files changed** is the stable measure: 0 of 20. A change that makes the model touch other files (a new test,
  a stray file, a refusal that edits anyway) would show there against a floor of zero. The change tried here does
  not change which files are edited, and did not show (0 of 4), which is the right answer.
- **Bytes** differ for equivalent work (an env entry in another position, `Math.floor((s % 3600) / 60)` instead of
  `Math.floor(s / 60) % 60`): not a measure of behaviour.
- **Effort.** Two replays at medium effort left the recording too. Nothing can be said about whether effort lowers
  the floor from two.

What it would take to trust a replay comparison:

- `--policy execute`, read on files changed, the grade, and side effects on tasks whose floor on side effects is
  low. Measure the floor of the same recordings first; it differs per task (1/7 to 7/7 here).
- Sample size. At 20 unchanged and 20 changed replays, two rates must differ by roughly 25 to 35 points before
  chance can be ruled out; at 7 and 3, only an all-against-almost-none split shows (as the config case did).
  That is about 40 replays per question, at the size of these tasks about 240 model calls.
- A replay of an `execute` comparison is close in cost to running the eval task again from scratch (the model
  makes every step either way); what replay adds is the same starting history and a side-by-side diff.
- Sessions that follow a fixed procedure (a scripted workflow, a recorded demo) have a lower floor and are where an
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

`compareReplay(recordedEvents, replayEvents, report, { normalisers, replayFinal })` (`replay/effects.ts`) is the
comparison that ignores reads; pass `replayFinal`, a snapshot of the copy taken after the replay (`snapshotOfCopy`
in `scripts/replay.ts`), because the replay's own log does not snapshot the step in which it left the recording.

`run.session` is the replay session: its events are the replay's progress, and `interrupt()` ends it. The matcher,
the tape and the report are `packages/core/src/replay/`; the loop that drives them is `replayLoop` in
`engine/engine.ts`.
