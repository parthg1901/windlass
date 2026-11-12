# Compaction recall

How much does a compaction make the model forget? This evaluation plants checkable facts in a long synthetic
session, compacts it the way the harness would (`packages/core/src/context/`), and asks one question per fact in a
fresh request under four strategies:

| Strategy | What stands in for the removed history |
| --- | --- |
| `full` | nothing is removed: the ceiling |
| `summary` | the model-written summary only |
| `checkpoint` | Part A's checkpoint: the summary, the mechanically extracted identifier index and the user's messages verbatim |
| `checkpoint+tools` | the same checkpoint plus `history_search` and `history_read` over the original messages (one round of calls per question, then it must answer) |

All four see the same verbatim tail (`chooseTail` with a 1,500-token budget, which keeps the final turn) and, apart
from `full`, the same summary, produced once by the model from the normal request plus `summaryPrompt()` and checked
by `validateSummary` (one repair request when it fails).

```
evals/recall/
  generate.ts     seeded generator: filler turns plus planted facts, deterministic from the seed
  session.ts      builds stored Message values (user, steps with read/grep/shell/edit and their results)
  grade.ts        grading: exact identifiers without a model, a batched model judge where meaning matters
  history.ts      history_search / history_read over the generated session (simple deterministic text search)
  strategies.ts   the compaction and each strategy's context
  evaluate.ts     the loop and the report
  model.ts        the injected model function; liveModel() is the real provider
  fake.ts         the scripted "oracle reader" used by tests and by runs without --live
  run.ts          bun evals/recall/run.ts [--live] [--seed N] [--tokens N] [--questions N] [--out FILE]
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
availability, not understanding). `--live` uses the ChatGPT sign-in with `gpt-6-luna` at low effort; the default
run plans at most 63 requests (plus one retry per failed call, which counts too) and refuses to go past
`--max-requests` (66). Progress goes to stderr as counts only.

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
