# Compaction recall

How much does a compaction make the model forget? This evaluation plants checkable facts in a long synthetic
session, compacts it the way the harness would (`packages/core/src/context/`), and asks one question per fact in a
fresh request under five strategies. Four build their context here and tell what each part of a checkpoint is
worth; the fifth is the product itself:

| Strategy | What stands in for the removed history |
| --- | --- |
| `full` | nothing is removed: the ceiling |
| `summary` | the model-written summary only |
| `checkpoint` | Part A's checkpoint: the summary, the mechanically extracted identifier index and the user's messages verbatim |
| `checkpoint+tools` | the same checkpoint plus `history_search` and `history_read` over the original messages (one round of calls per question, then it must answer) |
| `engine` | the real thing: the session is loaded into a real session store, the engine compacts it, and each question goes through the engine's loop with the real history tools |

The first four see the same verbatim tail (`chooseTail` with a 1,500-token budget, which keeps the final turn) and,
apart from `full`, the same summary, produced once by the model from the normal request plus `summaryPrompt()` and
checked by `validateSummary` (one repair request when it fails).

`engine` (`engine.ts`) simulates nothing. The generated messages are written as a valid event log into a store file
(`sessionEvents`); a short user message is sent through the engine, which is told a context window of 30,600 tokens,
so its policy compacts at that user-message boundary and keeps about 1,500 tokens word for word, as the others do.
The engine chooses the cut, asks the model for the summary (with its bound, its one repair and its fallback),
freezes the checkpoint and sets the baseline again; the reply to that short message is canned, so the only model
calls of this step are the summary's. Each question is then asked in a fork of the compacted session: every
question starts from the same state, shares one prompt-cache prefix, and runs through the loop with the product's
system prompt and tool list. `history_search` and `history_read` are the engine's, on the fork's stored messages
(the full-text index); the other tools are listed and refuse to run, because the session's workspace does not exist.
A question gets two steps with tools and then a last call without (`ENGINE_MAX_STEPS`).

```
evals/recall/
  generate.ts     seeded generator: filler turns plus planted facts, deterministic from the seed
  session.ts      builds stored Message values (user, steps with read/grep/shell/edit and their results)
  grade.ts        grading: exact identifiers without a model, a batched model judge where meaning matters
  history.ts      history_search / history_read over the generated session in memory, with the engine's own
                  search without an index, read and renderers (for `checkpoint+tools`)
  strategies.ts   the simulated compaction and each context strategy's context
  engine.ts       the `engine` strategy: load into a store, compact with the engine, a fork per question
  evaluate.ts     the loop and the report
  model.ts        the injected model function; liveModel() is the real provider
  fake.ts         the scripted "oracle reader" used by tests and by runs without --live
  run.ts          bun evals/recall/run.ts [--live] [--strategies full,engine] [--seed N] [--tokens N]
                  [--questions N] [--pause MS] [--keep DIR] [--max-requests N] [--out FILE]
  track.ts        bun evals/recall/track.ts --live | --check: the score per commit, in history.jsonl
```

## What is planted

Seven fact types, each from hand-written pools with seeded values: a decision and its reason, the exact file and
line where a bug was found, an exact command and its exit code (the code appears only in the tool result), an exact
error message inside a noisy log, a value the user asked to keep exactly, a user correction of an earlier instruction
(the latest wins), and a fact next to a near-identical decoy. Filler turns are full of look-alikes on purpose: other
paths with line numbers in grep output, other test commands with exit codes, other error lines.

Grading: `contains` rules check that every exact identifier is in the answer (quotes, backticks and spacing
normalised; numbers must stand alone). A decision's answer must contain the chosen option's keyword and then a model
judge checks the reason. A distractor's answer that also names the decoy goes to the judge. All judged items of a run
are graded in one request; anything the judge does not grade counts as a failure.

The report also gives, per strategy, how often every exact identifier of the gold answer was present in what the
model was shown (context plus tool results): the difference between that and recall is what the model lost
although it had the text.

## Running

`bun test evals/recall` runs everything with the scripted model. `bun evals/recall/run.ts` runs the pipeline with
the oracle reader (it answers correctly exactly when the gold identifiers are in its context, so its "recall" is
availability, not understanding). `--live` uses the ChatGPT sign-in with `gpt-6-luna` at low effort. The four
context strategies plan at most 63 requests; `engine` adds one or two for the summary and up to three per question;
a failed call is retried once, which counts too. A run refuses to go past `--max-requests` (110). `--strategies
full,engine` compares the ceiling with the product and makes no simulated compaction. `--pause MS` waits between
the questions of a context strategy (see the cache finding below), and `--keep DIR` keeps the engine strategy's
store file there, for `scripts/export-trace.ts --db DIR/recall.db`. Progress goes to stderr as counts only.

## Tracking the score per commit

`track.ts` runs the evaluation and appends one row to `history.jsonl`: the commit, the date, the model and effort,
the session it measured (seed, size, questions), per strategy the score (`pass` of `total`) and the measured input
tokens per question, and the number of model calls the run made, counted at the model function with retries.
Numbers only: no answer, no session content.

```
bun evals/recall/track.ts --live                       # full and engine; at most 30 requests (--max-requests)
bun evals/recall/track.ts --live --strategies engine   # the product alone
bun evals/recall/track.ts --check [--margin 2]         # the latest row against the one before it
bun evals/recall/track.ts                              # the scripted oracle model: prints the row, writes nothing
```

- It refuses to run when the working tree has uncommitted changes other than `history.jsonl` itself, because the row
  would name a commit that is not what ran. `--allow-dirty` runs anyway and marks the row `dirty`. Commit the new row
  afterwards.
- Before it starts it says how many requests the strategies may need before retries: 12 for `full` plus the judge,
  2 + 3 per question for `engine` (two summary calls at most, then two rounds of history tools and the answer), so 51
  for `full,engine` and 39 for `engine` alone on 12 questions. The cap (`--max-requests`, default 30) is hard: a run
  that reaches it stops and records nothing. Measured live, `full,engine` took 28 requests and `engine` alone 16 (the
  model calls the history tools on one or two questions, not on all), so `engine` alone fits the default cap with room,
  and `full,engine` fits only when nothing is retried.
- `--check` compares only the latest row with the one before it, per strategy both have, and exits 1 when a score
  dropped by more than the margin, 2 when there is nothing to compare (fewer than two rows, or rows of another model,
  effort or session), 0 otherwise. Tokens per question are printed next to the score but never fail the check.

The first row (2026-11-12, commit `f76c5e1`, `gpt-6-luna` at `low`, `--strategies engine` to stay inside a 30-request
budget): `engine` 12 of 12, 5,935 input tokens per question, 16 live requests (one summary call of 35 s, 14 question
calls with one question using two history-tool calls, one judge call). Two of the twelve questions read nothing from
the prompt cache although every other fork read 5,760 of about 5,930 tokens from it.

**Why the margin is two questions.** A run is 12 questions on one generated session, so one question is 8 points, and
a single run is noisy: the engine scored 10 and 12 of 12 on two runs of the same session a small prompt change apart (below, "The
product"). Treating each question as an independent pass at about 90%, one run's score has a standard deviation of
about one question (√(12 · 0.9 · 0.1) ≈ 1.04), and the difference between two runs about 1.5 questions. A drop of two
questions is therefore well inside what chance gives; a drop of three (25 points) is about two standard deviations,
which chance gives about one time in fifty. So `--check` fails on a drop of three or more. That catches a change that
breaks recall (a checkpoint that loses its index, history tools that stop finding things) and not one that makes it a
little worse; for that, run several times and compare the means, or raise `--questions`.

## The product: full history against the engine

2026-11-12, `gpt-6-luna` at effort `low`, ChatGPT sign-in, the same generated session as below (seed 7, 143
messages, about 39,600 tokens, 12 questions). `bun evals/recall/run.ts --live --strategies full,engine`.

| Strategy | Recall | Early | Middle | Late | Gold present in what the model saw | Input tokens per question (measured) | Questions that read from the cache | Tool calls | Requests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full | 100% (12/12) | 4/4 | 3/3 | 5/5 | 100% | 37,864 | 0/12 | 0 | 12 |
| engine, first run | 83% (10/12) | 3/4 | 3/3 | 4/5 | 100% | 6,481 | 12/12 | 2 | 15 |
| engine, second run | 100% (12/12) | 4/4 | 3/3 | 5/5 | 100% | 6,680 | 11/12 | 2 | 15 |

The engine's compaction in both runs: trigger `auto`, mode `normal`, 137 of 143 messages removed, the request
estimated at about 41,700 tokens before and 6,700 to 6,950 after, one summary call of about 32 s whose first answer
was valid (`source: model`).

- **First run.** Both misses were the two `decision` facts: the model named the choice, said it could not tell the
  reason from what it had, and did not search, although the reason was one `history_search` away. The question
  itself invites that ("If you cannot tell from what you have, say so").
- **Between the runs** the checkpoint's last sentence and the system prompt's line about checkpoints were changed
  to say what to do in that case: look the detail up with the history tools before saying you cannot tell.
- **Second run.** 12 of 12. One summary differs from the other, and the model still called the tools for one
  question only, so the difference between 10 and 12 is as likely the summary as the wording: with one session and
  one run each, a question is 8 points.
- The model answers almost everything from the checkpoint alone: the identifier index carries the exact paths,
  commands, exit codes and errors. The history tools were used for one question per run (two calls each time, a
  search and a read), and got it right both times; in the first run that was the distractor, which no strategy of
  the earlier run below recovered after compaction.
- Every fork read the shared prefix from the cache from about 8 s after the first one wrote it.
- **The cache misses of `full` are explained** (they were the open question of the first live result). Two causes,
  both measured: an assistant item replayed without an item ID is never read from the cache, and the generated
  history had none (the request builder now derives one); and a 38,000-token prefix written cold is not readable
  for more than half a minute, while the twelve questions took about 40 s. With `--pause 45000` the second and
  third question read 38,656 of 38,806 tokens from the cache. Details: `docs/reference/responses-api.md`, "Verified
  live", items 30 and 31.

Requests: 28 for the first comparison (12 `full`, 1 summary, 14 questions, 1 judge), 16 for the second engine run,
4 for the pause check.

What this does and does not show: as below, one synthetic session, one seed, twelve questions. It shows that the
engine's own compaction and history tools, end to end on a real store, keep what the simulated strategies kept, at
about a sixth of the input per question. It does not show how the checkpoint does on real long sessions.

## First live result

2026-11-12, `gpt-6-luna` at effort `low`, ChatGPT sign-in. One generated session (seed 7): 143 messages, about
39,600 tokens of history. The compacting strategies remove 138 messages (about 38,100 tokens) and keep about 1,500
verbatim; 12 questions, one per planted fact (4 early, 3 middle, 5 late).

| Strategy | Recall | Early | Middle | Late | Gold present in what the model saw | Context tokens (estimated) | Input tokens per question (measured) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full | 100% (12/12) | 4/4 | 3/3 | 5/5 | 100% | 40,467 | 37,864 |
| summary | 33% (4/12) | 1/4 | 1/3 | 2/5 | 42% | 3,859 | 3,747 |
| checkpoint | 75% (9/12) | 3/4 | 2/3 | 4/5 | 92% | 5,686 | 5,449 |
| checkpoint+tools | 83% (10/12) | 4/4 | 2/3 | 4/5 | 100% | 5,991 | 5,775 |

| Fact type | full | summary | checkpoint | checkpoint+tools |
| --- | --- | --- | --- | --- |
| decision | 2/2 | 1/2 | 2/2 | 2/2 |
| path_line | 2/2 | 0/2 | 1/2 | 2/2 |
| command_exit | 2/2 | 0/2 | 2/2 | 2/2 |
| error_message | 2/2 | 0/2 | 1/2 | 1/2 |
| preserved_value | 2/2 | 2/2 | 2/2 | 2/2 |
| correction | 1/1 | 1/1 | 1/1 | 1/1 |
| distractor | 1/1 | 0/1 | 0/1 | 0/1 |

Requests: 57 live requests in all. A first attempt spent 1: its summary request ran for 15 minutes and the server
closed the stream. Before trying again, the evaluation got the harness's tool list in every request (the history
holds calls to those tools), a 240-second limit per call and one retry. The run itself spent 56: 3 on the summary
(the first call was still writing at the limit, the retry was invalid, then the one repair), 52 on questions (the
tool strategy called tools on 4 of 12 questions) and 1 on the judge.

What happened along the way:
- **The summary degenerated.** The first summary call wrote about 28,000 characters before the time limit stopped
  it. The retry and the repair both repeated the whole summary several times over (every section appears more than
  once), so `validateSummary` rejected both and the repaired answer was used anyway. The model also copied the
  prompt's description into each heading. So the summary request needs an output limit, and the engine needs a plan
  for a summary that is still invalid after the repair. This run cannot tell whether the cause is the prompt, low
  effort, or this model.
- **`summary` is a pessimistic baseline here.** Part A's prompt tells the model that an identifier index will be
  added next to its summary, and the model took that at its word: "exact commands and errors are in the
  harness-added context index". The `summary` strategy then shows that summary without the index. A summary written
  to stand alone would probably do better than 33%.
- **The model loses some of what it is shown.** `checkpoint` had the gold text in its context for 11 of 12
  questions and answered 9. `checkpoint+tools` had it, through tool results, for all 12 and answered 10. The two
  misses with tools came after one round of calls: the model said it could not verify the answer, even though the
  search snippet held it. A second round, to read the message in full, might recover these.
- **The distractor was never recovered after compaction.** The index does not extract paths without an extension
  (`.cache/tsbuild-ledger-v3`), and the search did not get the model there.
- **One judge call is debatable.** For `summary` and the config-validation decision, the answer named the right
  choice and the right reason, but hedged ("I can't verify"). The judge failed it.
- **No cache hits on the long requests.** None of the 12 `full` questions read anything from the cache, although
  they shared a 37,800-token prefix and one `session-id`. The short contexts hit from the second question on.

What it does and does not show. This is one session, one seed, 12 questions and one run of one small model at low
effort, so each question moves a strategy by 8 points, and a second run could easily reorder `checkpoint` and
`checkpoint+tools`. The facts and the filler are synthetic and come from templates written alongside the checkpoint
extractor. The extractor was improved after a run with the scripted oracle reader (bare `Error:` lines,
`path line N`), so the index fits these templates better than it would fit real sessions. At most, the run shows that
the pipeline works end to end, and that on this session the mechanical checkpoint, with or without history tools,
recovers much more than a summary alone, at about one seventh of the full history's input tokens. It does not show
how large those effects are, or that they hold on real 500K-token transcripts.
