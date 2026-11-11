# Step-loop scenarios

The step loop (not written yet) takes a prompt, calls the model, runs tools, and handles cancel, retries and crash
recovery. This page is its acceptance target: for each situation, the exact durable events the loop must write, in
order, and what a UI and the model should see afterwards. The rules come from the blueprint
*Agent session core — storage, cancel, retries, context* (vault `Blueprints/`), cited below as e.g. "cancel rule 4".

The scenarios live in `packages/core/test/scenarios/`, one module per family. `scenarios.test.ts` folds every one
through the real reducer, checks the state after each phase, checks that the reducer rejects the wrong moves listed
with it, and runs `loop-rules.ts`, a checker for ordering rules the reducer does not enforce yet. A loop test can fold
the events its loop wrote and call `loopViolations` on them.

Today: 39 scenarios, 94 tests passing (two per scenario plus 16 gap probes), 3 `test.todo` for what cannot be
expressed yet. A gap probe passes while its gap is open; when the reducer closes one, the probe fails and should
become a `rejects` entry.

## Conventions

- IDs: `u` user, `a` assistant (one per step attempt that produced output), `s` synthetic, `i` instruction,
  `c` compaction, `exe_` execution. `seq` is the number at the start of each event line.
- Most scenarios start with the same five events, shown as `1-5 opening`: the session is created, the prompt `u1` is
  admitted, the claim `exe_1` is taken, the baseline is frozen and `u1` is delivered (at seq 5).
- *Model sees next* is `selectModelHistory` after the last event: what the next request is built from.
- Scenario constants: an attempt budget of 5 per logical step (1 + the spec's 4 retries), a resume cap of 3, and a
  step limit of 3 to keep the step-limit scenario short.

Choices these scenarios make where the blueprint leaves room (see also "Ambiguous rules" below):

- Tool calls are recorded (`tool.called`) the moment each call finishes streaming, but tools run only after the
  response finishes. So `step.ended` comes after every result, and a cancel during streaming leaves any recorded
  call `not_started`.
- The interrupt marker is its own `synthetic.appended` message with origin `interrupt`, written immediately after a
  step closes as `interrupted` or `crashed`. When no step is open (cancel between steps) it is written just before
  the release. Merging it into the next user message on the wire is the request builder's job.
- When the loop, not the tool, decides an outcome (not started, effect unknown, refused by the guard, malformed
  arguments), it freezes an explanatory text into `tool.settled.output`. The exact wording is in `script.ts`.

## Scenarios

### Happy paths

#### 1. A plain answer

The user asks a question and the model answers in one step without calling a tool. The execution claim is released as soon as the step has ended and nothing waits in the inbox.

*Provider:* streams reasoning, then one text item, then finishes with stop.

```
-- the prompt is admitted and the claim taken
  1  session.created
  2  inbox.enqueued u1 steer "What does this repo do?"
  3  execution.started exe_1
-- the baseline is frozen, the prompt delivered, the model answers
  4  baseline.set
  5  inbox.delivered u1
  6  step.started a1 attempt=1
  7  reasoning.ended a1 "Look at the README."
  8  text.ended a1 "It is a coding-agent harness."
  9  step.ended a1 finish=stop
 10  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

#### 2. One tool call, then an answer

The model reads a file and then answers. The call is durable (tool.called) before the tool starts, the start is durable before the tool runs, and the result is durable before the step ends. The answer is a second step that continues from the reloaded history.

*Provider:* step 1 streams text and one tool call and finishes with tool_calls; step 2 streams text and finishes with stop.

```
-- the turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Let me read the test."
  8  tool.called a1/call_1 read {"path":"a.test.ts"}
  9  tool.started a1/call_1
 10  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 3. Two parallel tool calls

The model asks for two reads in one response. Both calls are recorded as they finish streaming, both run at once, and they settle in the order they finish, which need not be the order they were called. The step ends only once both have settled.

*Provider:* step 1 streams two tool calls and finishes with tool_calls; call_2 finishes before call_1; step 2 answers.

```
-- the turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.called a1/call_2 read {"path":"b.ts"}
  9  tool.started a1/call_1
 10  tool.started a1/call_2
 11  tool.settled a1/call_2 success "export const b = 2"
 12  tool.settled a1/call_1 success "export const a = 1"
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "a is 1 and b is 2."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success, read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 4. Several steps in one turn

The model reads, edits, runs the tests and answers: four steps under one execution claim. Each step is one model call that starts from the history the previous step left; nothing is carried in memory between them. A provider that reuses call IDs across steps is fine, because calls are keyed by (message, call ID).

*Provider:* three steps that each finish with tool_calls (the provider reuses call_1 every time), then one that finishes with stop.

```
-- the turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
 13  tool.started a2/call_1
 14  tool.settled a2/call_1 success "Wrote a.test.ts"
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 shell {"command":"bun test"}
 18  tool.started a3/call_1
 19  tool.settled a3/call_1 success "1 pass, 0 fail"
 20  step.ended a3 finish=tool_calls
 21  step.started a4 attempt=1
 22  text.ended a4 "Fixed the expectation; the test passes."
 23  step.ended a4 finish=stop
 24  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [write success] · a3 completed [shell success] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3, a4.

#### 5. Two turns in one session

The user asks, gets an answer, and later asks again. Each turn has its own execution claim. Between the turns the date changed, so before the second turn's first step the loop appends the new date as an instruction message (context rule 3) instead of touching the frozen baseline.

*Provider:* each turn: one step that finishes with stop.

```
-- first turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "2"
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- second turn, the next day
 10  inbox.enqueued u2 steer "And 2 + 2?"
 11  execution.started exe_2
 12  instruction.appended i1 source=date "Today is Friday 13 November 2026."
 13  inbox.delivered u2
 14  step.started a2 attempt=1
 15  text.ended a2 "4"
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · i1 instruction · u2 user · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, i1, u2, a2.

### Cancel by the user

#### 6. Cancel while text is streaming

The model has finished a reasoning item and is half-way through its answer when the user presses stop. The half-written sentence the user already saw is kept, written as a `text.ended` with the text so far. Reasoning that was still streaming would be dropped, because partial reasoning is never recorded. The model is told on its next request that its response was cut short.

*Provider:* streams a complete reasoning item, then text deltas "Let me lo"; the abort signal fires and the stream stops with no terminal event.

```
-- the model is streaming
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  reasoning.ended a1 "Read the test first."
-- the user cancels: flush the visible text and close the step
  8  text.ended a1 "Let me lo"
  9  step.failed a1 interrupted:user
-- tell the model and release the claim
 10  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 11  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 7. Cancel while a tool call's arguments are streaming

The model has finished one tool call and is streaming the arguments of a second when the user cancels. Tools run only after the response finishes, so the first call is recorded but has not started: it settles as `not_started`. The second call never finished streaming, so it is never recorded at all; its partial arguments are dropped.

*Provider:* streams text, one complete tool call (call_1), then argument deltas for call_2; aborted before call_2 ends.

```
-- the model is streaming the second call
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "I'll read both files."
  8  tool.called a1/call_1 read {"path":"a.ts"}
-- the user cancels
  9  tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."
 10  step.failed a1 interrupted:user
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 12  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [read not_started] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 8. Cancel while one tool is running

A shell command is running when the user cancels. The shell kills the process group, waits its bounded grace period, and returns the output so far. Because an outcome was observed (it was stopped, and here is what it printed), the call settles as `error` with that output, not as `effect_unknown`.

*Provider:* the response finishes with one shell call; the command is still running when the abort fires.

```
-- the command is running
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  tool.started a1/call_1
-- the user cancels; the shell returns its output so far
  9  tool.settled a1/call_1 error "Stopped by the user after 4 s. Output so far:\n12 pass\n"
 10  step.failed a1 interrupted:user
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 12  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [shell error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 9. Cancel while two parallel tools run and one has finished

Two calls run at once. The read already settled with its result; the shell command is still running when the user cancels. The finished call keeps its result, the running one settles once with the output it observed, and only then does the step close.

*Provider:* step 1 finishes with a read and a shell call; the read finishes, the shell is still running at the abort.

```
-- one call is done, one is running
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.called a1/call_2 shell {"command":"bun test"}
  9  tool.started a1/call_1
 10  tool.started a1/call_2
 11  tool.settled a1/call_1 success "export const a = 1"
-- the user cancels
 12  tool.settled a1/call_2 error "Stopped by the user after 2 s. Output so far:\n3 pass\n"
 13  step.failed a1 interrupted:user
 14  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 15  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [read success, shell error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 10. Cancel before a started side-effecting tool reports anything

A write has started (its `tool.started` is durable) and the user cancels before it returns anything. Nobody observed whether the file was written, so the call settles as `effect_unknown` and the model is told to check before repeating it. It can never be `not_started`: once started, a side effect may have happened.

*Provider:* step 1 finishes with one write call; the abort fires right after the tool starts and the tool returns nothing.

```
-- the write has started
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"a.ts","content":"export const a = 2"}
  8  tool.started a1/call_1
-- the user cancels
  9  tool.settled a1/call_1 effect_unknown "Started, but stopped before it reported a result. It may ..."
 10  step.failed a1 interrupted:user
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 12  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [write effect_unknown] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 11. Cancel before a started read-only tool reports anything

Same moment as the previous scenario, but the tool only reads. A read has no side effect, so there is nothing unknown about the workspace: the call settles as `error`, and the model may simply call it again.

*Provider:* step 1 finishes with one read call; the abort fires right after the tool starts and the tool returns nothing.

```
-- the read has started
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
-- the user cancels
  9  tool.settled a1/call_1 error "Stopped before it finished. Nothing was changed; it is sa..."
 10  step.failed a1 interrupted:user
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 12  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [read error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 12. Cancel while waiting between steps

The first step ended and its tool results are durable; the next model call has not started. No step is open, so no step event is written: the cancel is only the marker and the release. Each step that ran still has exactly one terminal event.

*Provider:* step 1 finishes with one read call that succeeds; the abort fires before step 2 is requested.

```
-- between steps
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
-- the user cancels
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 12  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 completed [read success] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 13. Cancel while waiting to retry

The first attempt failed with a rate limit before any output, so the retry runs under the same message and the loop is sleeping for the retry-after delay. The step is still open. The user cancels during the delay: the step closes as interrupted (not as a provider failure), and the scheduled attempt never runs.

*Provider:* attempt 1 fails with rate_limit (retry-after 3 s) before any output; the abort fires during the delay.

```
-- waiting to retry
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  retry.scheduled a1 attempt=2 delayMs=3000 after rate_limit
-- the user cancels
  8  step.failed a1 interrupted:user
  9  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 10  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

### Steering and queueing

#### 14. A steer arriving mid-step is delivered at the next step boundary

While a read runs, the user types "also check b.ts". The message is admitted to the inbox at once, but it enters history only when the step has ended: after the tool result, as a new user message. Nothing already written is edited, so the next request extends the previous one.

*Provider:* step 1 finishes with one read call; the user steers while it runs; step 2 reads b.ts; step 3 answers.

```
-- the user steers while the read runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
  9  inbox.enqueued u2 steer "Also check b.ts."
-- the step ends; the steer is delivered before the next step
 10  tool.settled a1/call_1 success "export const a = 1"
 11  step.ended a1 finish=tool_calls
 12  inbox.delivered u2
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 read {"path":"b.ts"}
 15  tool.started a2/call_1
 16  tool.settled a2/call_1 success "export const b = 2"
 17  step.ended a2 finish=tool_calls
 18  step.started a3 attempt=1
 19  text.ended a3 "a is 1 and b is 2."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · u2 user · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, a2, a3.

#### 15. A queued message waits until the session would go idle

While the model works, the user queues a follow-up. Unlike a steer it is not delivered at the next step boundary: the turn runs to its answer first. When the session would otherwise go idle, exactly one queued item is delivered and the loop carries on under the same claim.

*Provider:* step 1 finishes with a read call; step 2 answers with stop; then step 3 answers the queued message.

```
-- the user queues a follow-up
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  inbox.enqueued u2 queue "Then write a changelog entry."
  8  tool.called a1/call_1 read {"path":"a.ts"}
  9  tool.started a1/call_1
 10  tool.settled a1/call_1 success "export const a = 1"
 11  step.ended a1 finish=tool_calls
-- the turn finishes, still holding the queued item
 12  step.started a2 attempt=1
 13  text.ended a2 "a is 1."
 14  step.ended a2 finish=stop
-- the session would go idle: deliver one queued item
 15  inbox.delivered u2
 16  step.started a3 attempt=1
 17  text.ended a3 "Added the entry."
 18  step.ended a3 finish=stop
 19  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed · u2 user · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, u2, a3.

#### 16. A pending steer survives an interrupt

The user steers while a call is pending and then cancels the turn. The cancel closes the step and releases the claim, but the steer is not withdrawn: it stays in the inbox, visible as waiting, and is the first thing delivered when work starts again. Only `inbox.cancelled` removes it.

*Provider:* step 1 finishes with one read call; the user steers, then cancels before the read starts.

```
-- a steer waits, then the user cancels
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  inbox.enqueued u2 steer "Use b.ts instead."
  9  tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."
 10  step.failed a1 interrupted:user
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 12  execution.interrupted exe_1 user
-- work starts again: the steer is delivered first
 13  execution.started exe_2
 14  inbox.delivered u2
 15  step.started a2 attempt=1
 16  tool.called a2/call_1 read {"path":"b.ts"}
 17  tool.started a2/call_1
 18  tool.settled a2/call_1 success "export const b = 2"
 19  step.ended a2 finish=tool_calls
 20  step.started a3 attempt=1
 21  text.ended a3 "b is 2."
 22  step.ended a3 finish=stop
 23  execution.succeeded exe_2
```

*UI:* u1 user · a1 failed interrupted:user [read not_started] · s1 synthetic · u2 user · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, u2, a2, a3.

### Retries

#### 17. A retryable failure before any output

The first attempt is rate limited before the model wrote anything durable. The retry is transparent: it runs under the same assistant message, nothing failed is left in history, and the message records that it is on attempt 2. The delay is at least the provider's retry-after (retry rule 4).

*Provider:* attempt 1 fails with rate_limit (retry-after 3 s) before any output; attempt 2 streams an answer.

```
-- attempt 1 is rate limited
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  retry.scheduled a1 attempt=2 delayMs=3000 after rate_limit
-- attempt 2 succeeds under the same message
  8  text.ended a1 "Here is the fix."
  9  step.ended a1 finish=stop
 10  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

#### 18. A retryable failure after partial text

The server fails after the model had written part of its answer, which the user saw. That text is now durable output, so the retry cannot be transparent: the message is marked failed with its partial text kept, and the next attempt runs under a new message with attempt 2. Both stay in the UI. The model sees the partial message too (see the ambiguity on this in the document).

*Provider:* attempt 1 streams "Let me look at the" and then fails with provider_internal (HTTP 500); attempt 2 answers.

```
-- attempt 1 fails after output
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Let me look at the"
-- the message fails and a retry is scheduled
  8  step.failed a1 provider:provider_internal
  9  retry.scheduled a1 attempt=2 delayMs=2000 after provider_internal
-- the retry runs under a new message
 10  step.started a2 attempt=2
 11  text.ended a2 "Let me look at the test first."
 12  step.ended a2 finish=stop
 13  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed provider:provider_internal · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 19. A stream that ends with no terminal event

The connection closes cleanly in the middle of the response: no `finish`, no `error`, and the abort signal did not fire. The loop treats it as `incomplete_stream`, which is retryable. Here nothing durable had been written, so it is the transparent retry.

*Provider:* attempt 1 yields one reasoning delta and then the iterator ends; attempt 2 answers.

```
-- the stream just stops
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  retry.scheduled a1 attempt=2 delayMs=2000 after incomplete_stream
  8  text.ended a1 "Done."
  9  step.ended a1 finish=stop
 10  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

#### 20. The attempt budget runs out

Every attempt fails before output. After attempt 5, the last of the budget, no retry is scheduled: the step fails with the last error and the execution fails, releasing the claim. One failed message is left, with an empty body; the user can prompt again.

*Provider:* attempts 1 to 5 each fail with provider_internal before any output.

```
-- every attempt fails
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  retry.scheduled a1 attempt=2 delayMs=2000 after provider_internal
  8  retry.scheduled a1 attempt=3 delayMs=4000 after provider_internal
  9  retry.scheduled a1 attempt=4 delayMs=8000 after provider_internal
 10  retry.scheduled a1 attempt=5 delayMs=16000 after provider_internal
 11  step.failed a1 provider:provider_internal
 12  execution.failed exe_1 "The model call failed 5 times: The server had an error"
```

*UI:* u1 user · a1 failed provider:provider_internal. *Claim:* released.

*Model sees next:* u1, a1.

#### 21. A non-retryable error: authentication

The ChatGPT sign-in expired. Retrying it unchanged cannot work (retry rule 3), so there is no retry.scheduled: the step fails with the classified error and the execution fails with a message the UI can act on.

*Provider:* attempt 1 fails with auth (HTTP 401) before any output.

```
-- the call is rejected
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  step.failed a1 provider:auth
-- the execution fails
  8  execution.failed exe_1 "Signed out: sign in again to continue."
```

*UI:* u1 user · a1 failed provider:auth. *Claim:* released.

*Model sees next:* u1, a1.

#### 22. A non-retryable error: usage limit

The plan's usage limit is exhausted until it resets. Retrying it unchanged cannot work (retry rule 3), so there is no retry.scheduled: the step fails with the classified error and the execution fails with a message the UI can act on.

*Provider:* attempt 1 fails with usage_limit (HTTP 429) before any output.

```
-- the call is rejected
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  step.failed a1 provider:usage_limit
-- the execution fails
  8  execution.failed exe_1 "Usage limit reached; it resets in 3 hours."
```

*UI:* u1 user · a1 failed provider:usage_limit. *Claim:* released.

*Model sees next:* u1, a1.

#### 23. A non-retryable error: invalid request

The provider rejected the request as malformed. Retrying it unchanged cannot work (retry rule 3), so there is no retry.scheduled: the step fails with the classified error and the execution fails with a message the UI can act on.

*Provider:* attempt 1 fails with invalid_request (HTTP 400) before any output.

```
-- the call is rejected
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  step.failed a1 provider:invalid_request
-- the execution fails
  8  execution.failed exe_1 "The provider rejected the request: Invalid 'input[3].call..."
```

*UI:* u1 user · a1 failed provider:invalid_request. *Claim:* released.

*Model sees next:* u1, a1.

#### 24. Malformed tool arguments

The model writes arguments that are not valid JSON. The call is recorded exactly as written, never started, and settled as `error` with a message telling the model what was wrong (retry rule 6). The step ends normally and the model calls again with valid arguments.

*Provider:* step 1 finishes with a read call whose arguments are `{"path": "a.ts"` (no closing brace); step 2 calls it correctly; step 3 answers.

```
-- the arguments do not parse
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path": "a.ts"
  8  tool.settled a1/call_1 error "The arguments are not valid JSON (unexpected end of input..."
  9  step.ended a1 finish=tool_calls
-- the model tries again
 10  step.started a2 attempt=1
 11  tool.called a2/call_1 read {"path": "a.ts"}
 12  tool.started a2/call_1
 13  tool.settled a2/call_1 success "export const a = 1"
 14  step.ended a2 finish=tool_calls
 15  step.started a3 attempt=1
 16  text.ended a3 "a is 1."
 17  step.ended a3 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read error] · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3.

#### 25. Tool arguments cut off by the output limit

The model hits its output limit while writing a large file's content. The call never finished streaming, so it is never recorded and never executed (retry rule 6). The step ends with finish `length`, and the loop appends a note telling the model why nothing ran, then continues.

*Provider:* step 1 streams text and the arguments of a write call, then finishes with length before the call ends; step 2 writes a shorter file; step 3 answers.

```
-- the response hits the output limit
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "I'll write the new module."
  8  step.ended a1 finish=length
-- the model is told and tries again
  9  synthetic.appended s1 origin=output_limit "Your last response reached the output limit while writing..."
 10  step.started a2 attempt=1
 11  tool.called a2/call_1 write {"path":"m.ts","content":"export {}"}
 12  tool.started a2/call_1
 13  tool.settled a2/call_1 success "Wrote m.ts"
 14  step.ended a2 finish=tool_calls
 15  step.started a3 attempt=1
 16  text.ended a3 "Created m.ts."
 17  step.ended a3 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed · s1 synthetic · a2 completed [write success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

#### 26. An empty response: one nudge, then failure

The model finishes with no text, no reasoning and no tool call. The loop appends one nudge and asks again (retry rule 8). The second response is empty too, so the execution fails instead of nudging again.

*Provider:* steps 1 and 2 each finish with stop and no output items.

```
-- the first empty response is nudged
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  step.ended a1 finish=stop
  8  synthetic.appended s1 origin=empty_response "Your last response was empty. Continue with the task, or ..."
-- the second one fails the execution
  9  step.started a2 attempt=1
 10  step.ended a2 finish=stop
 11  execution.failed exe_1 "The model returned an empty response twice."
```

*UI:* u1 user · a1 completed · s1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2.

#### 27. The same call with the same arguments, again and again

The model reads the same file with the same arguments in three consecutive steps and gets the same result. The third identical call trips the guard (retry rule 9): it is refused before running, settled as `error` with a message, and the model moves on.

*Provider:* steps 1 to 3 each call read with `{"path":"a.ts"}`; step 4 answers.

```
-- two identical calls run
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"a.ts"}
 13  tool.started a2/call_1
 14  tool.settled a2/call_1 success "export const a = 1"
 15  step.ended a2 finish=tool_calls
-- the third is refused without running
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 read {"path":"a.ts"}
 18  tool.settled a3/call_1 error "Not run: this exact call already ran twice in this turn w..."
 19  step.ended a3 finish=tool_calls
 20  step.started a4 attempt=1
 21  text.ended a4 "a is 1."
 22  step.ended a4 finish=stop
 23  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [read success] · a3 completed [read error] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3, a4.

#### 28. The step limit is reached

After 3 steps that each asked for tools, the loop appends a note that tools are now disabled and makes one final call with tool choice `none`. Tool choice is not part of the cached prefix and is not stored, so only the note is durable. The final answer ends the turn.

*Provider:* steps 1 to 3 each finish with a read call; the final call (tool choice none) answers with stop.

```
-- the limit is reached
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"f1.ts"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 success "file 1"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"f2.ts"}
 13  tool.started a2/call_1
 14  tool.settled a2/call_1 success "file 2"
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 read {"path":"f3.ts"}
 18  tool.started a3/call_1
 19  tool.settled a3/call_1 success "file 3"
 20  step.ended a3 finish=tool_calls
-- one final call with tools forbidden
 21  synthetic.appended s1 origin=step_limit "You have reached the step limit for this turn, so tools a..."
 22  step.started a4 attempt=1
 23  text.ended a4 "I read three files; the fix is still to do."
 24  step.ended a4 finish=stop
 25  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [read success] · a3 completed [read success] · s1 synthetic · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3, s1, a4.

#### 29. Context overflow before any output: compact once and rebuild

In the second turn the request no longer fits. No output had started, so the loop compacts once and rebuilds the request (retry rule 5). A compaction can start only at a boundary, so the overflowed attempt is first closed as failed, with an empty body, and stays in model history (gap G13). The checkpoint keeps the new prompt verbatim. A second overflow after this compaction would fail the execution.

*Provider:* turn 2, attempt 1 fails with context_overflow before output; the compaction call returns a summary; the rebuilt call answers.

```
-- first turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "A long explanation."
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- second turn overflows
 10  inbox.enqueued u2 steer "Now explain the reducer."
 11  execution.started exe_2
 12  inbox.delivered u2
 13  step.started a2 attempt=1
 14  step.failed a2 provider:context_overflow
-- compact once, then rebuild
 15  compaction.started c1
 16  compaction.ended c1
 17  step.started a3 attempt=1
 18  text.ended a3 "The reducer folds events."
 19  step.ended a3 finish=stop
 20  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · u2 user · a2 failed provider:context_overflow · c1 compaction · a3 completed. *Claim:* released.

*Model sees next:* c1, u2, a2, a3.

### Refusal

#### 30. A content-policy refusal

In the second turn the model reads a file and then the provider refuses. The refusal is never retried. The refused step stays in the log for the UI, and every message of the refused turn, from the prompt that started it, is excluded from model history, so the same content cannot trip the filter again on the next prompt. The execution fails. A third prompt is answered from the history before the refused turn.

*Provider:* turn 2: step 1 finishes with a read call; step 2 fails with content_policy; turn 3 answers normally.

```
-- first turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "It exports a."
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- second turn, refused in its second step
 10  inbox.enqueued u2 steer "Now do the thing the filter dislikes."
 11  execution.started exe_2
 12  inbox.delivered u2
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 read {"path":"b.txt"}
 15  tool.started a2/call_1
 16  tool.settled a2/call_1 success "contents of b.txt"
 17  step.ended a2 finish=tool_calls
 18  step.started a3 attempt=1
-- the refusal is recorded and the execution fails
 19  step.refused a3 excludeFromSeq=12
 20  execution.failed exe_2 "The provider refused the request."
-- the next prompt does not see the refused turn
 21  inbox.enqueued u3 steer "What does a.ts export?"
 22  execution.started exe_3
 23  inbox.delivered u3
 24  step.started a4 attempt=1
 25  text.ended a4 "a."
 26  step.ended a4 finish=stop
 27  execution.succeeded exe_3
```

*UI:* u1 user · a1 completed · u2 user excluded:refused · a2 completed [read success] excluded:refused · a3 refused excluded:refused · u3 user · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, u3, a4.

### Crash recovery

#### 31. The process dies while the model is streaming

One text item had ended and was durable; the next was streaming. The streamed deltas were never durable, so they are simply gone. Recovery closes the step as crashed (its completed text stays), tells the model the response was cut short, records the resume and runs a fresh step.

*Provider:* streams one complete text item, then deltas of a second; the process is killed; after restart the new step answers.

```
-- the process dies mid-stream
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Reading the test first."
-- at next start-up
  8  step.failed a1 crashed
  9  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 10  execution.resumed exe_1
-- the loop carries on
 11  step.started a2 attempt=1
 12  text.ended a2 "The expectation is wrong."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed crashed · s1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2.

#### 32. The process dies while a read-only tool is running

A read had started. A read changes nothing, so recovery settles it as `error` with a note that it is safe to repeat; the model calls it again in the resumed step.

*Provider:* step 1 finishes with a read call; the process is killed while it runs; after restart the model reads again and answers.

```
-- the process dies while the read runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
-- at next start-up
  9  tool.settled a1/call_1 error "Cut short by a restart before it finished. Nothing was ch..."
 10  step.failed a1 crashed
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 12  execution.resumed exe_1
-- the loop carries on
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 read {"path":"a.ts"}
 15  tool.started a2/call_1
 16  tool.settled a2/call_1 success "export const a = 1"
 17  step.ended a2 finish=tool_calls
 18  step.started a3 attempt=1
 19  text.ended a3 "a is 1."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed crashed [read error] · s1 synthetic · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

#### 33. The process dies while a side-effecting tool is running

A migration command had started and a second call was recorded but not yet started. Nobody knows whether the migration ran, so recovery settles it as `effect_unknown`; the pending call provably never ran and settles as `not_started`. In the resumed step the model checks the state before doing anything else.

*Provider:* step 1 finishes with a shell call and a read call; the shell starts, the process is killed; after restart the model inspects, then answers.

```
-- the process dies while the migration runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run migrate"}
  8  tool.called a1/call_2 read {"path":"schema.sql"}
  9  tool.started a1/call_1
-- at next start-up
 10  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 11  tool.settled a1/call_2 not_started "Not run: the response was stopped before this call starte..."
 12  step.failed a1 crashed
 13  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 14  execution.resumed exe_1
-- the model inspects before repeating
 15  step.started a2 attempt=1
 16  tool.called a2/call_1 shell {"command":"bun run migrate:status"}
 17  tool.started a2/call_1
 18  tool.settled a2/call_1 success "applied: 0007_add_index"
 19  step.ended a2 finish=tool_calls
 20  step.started a3 attempt=1
 21  text.ended a3 "The migration had already been applied."
 22  step.ended a3 finish=stop
 23  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed crashed [shell effect_unknown, read not_started] · s1 synthetic · a2 completed [shell success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

#### 34. The process dies after a tool finished but before its result was written

The write completed on disk, but the process died before `tool.settled` was appended. The log is byte-for-byte the same as a crash while the tool was still running, so recovery must do the same thing: the result is lost and the outcome is `effect_unknown`. This is why the start is made durable before running, and why the model is asked to check rather than told it failed.

*Provider:* step 1 finishes with a write call; the write finishes; the process is killed before the result is recorded.

```
-- the write finished, its result was not written
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"a.ts","content":"export const a = 2"}
  8  tool.started a1/call_1
-- at next start-up
  9  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 10  step.failed a1 crashed
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 12  execution.resumed exe_1
```

*UI:* u1 user · a1 failed crashed [write effect_unknown] · s1 synthetic. *Claim:* running, 1 resume(s).

*Model sees next:* u1, a1, s1.

#### 35. The process dies between steps

The step ended and its results are durable; the next model call had not started. Nothing was lost, so recovery has nothing to settle, no step to close and nothing to tell the model: it records the resume and the loop continues with the next step.

*Provider:* step 1 finishes with a read call that succeeds; the process is killed before step 2; after restart step 2 answers.

```
-- the process dies at the boundary
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
-- at next start-up
 11  execution.resumed exe_1
 12  step.started a2 attempt=1
 13  text.ended a2 "a is 1."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 36. The process dies after the answer, before the claim was released

The last step ended with `stop` and nothing waits in the inbox, so the execution was finished in all but name. Recovery releases the claim directly; there is no work to resume.

*Provider:* one step answers with stop; the process is killed before the claim is released.

```
-- the answer is durable, the claim is not released
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Done."
  8  step.ended a1 finish=stop
-- at next start-up
  9  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

#### 37. The resume cap: the same execution crashes 4 times

Something in this turn kills the process every time (say, a tool that exhausts memory). Each start-up recovers and resumes, and `execution.resumed` events count the attempts durably. After 3 resumes, the next start-up closes the crashed step and fails the execution instead of resuming it again.

*Provider:* every step is killed mid-stream.

```
-- 3 crashes, each recovered
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  step.failed a1 crashed
  8  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
  9  execution.resumed exe_1
 10  step.started a2 attempt=1
 11  step.failed a2 crashed
 12  synthetic.appended s2 origin=interrupt "The previous response was cut short when the harness rest..."
 13  execution.resumed exe_1
 14  step.started a3 attempt=1
 15  step.failed a3 crashed
 16  synthetic.appended s3 origin=interrupt "The previous response was cut short when the harness rest..."
 17  execution.resumed exe_1
 18  step.started a4 attempt=1
-- the next start-up gives up
 19  step.failed a4 crashed
 20  synthetic.appended s4 origin=interrupt "The previous response was cut short when the harness rest..."
 21  execution.failed exe_1 "Gave up after the harness restarted 3 times during this t..."
```

*UI:* u1 user · a1 failed crashed · s1 synthetic · a2 failed crashed · s2 synthetic · a3 failed crashed · s3 synthetic · a4 failed crashed · s4 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, s2, a3, s3, a4, s4.

### Shutdown

#### 38. A graceful shutdown mid-step

The user quits the app while a test run is in progress. The shell is stopped the same way as on a cancel and reports its output so far; the step closes as interrupted for `shutdown`; the model is told; the claim is kept as suspended. While suspended nothing new can start or be delivered. At the next start the execution is resumed and the turn continues where it stopped.

*Provider:* step 1 finishes with a shell call; the process receives SIGTERM while it runs; after restart the model reruns the tests and answers.

```
-- the shutdown stops the step
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 error "Stopped because the harness was shutting down. Output so ..."
 10  step.failed a1 interrupted:shutdown
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
-- the claim is kept
 12  execution.interrupted exe_1 shutdown
 13  inbox.enqueued u2 steer "Are you there?"
-- the next start resumes the session
 14  execution.resumed exe_1
 15  inbox.delivered u2
 16  step.started a2 attempt=1
 17  tool.called a2/call_1 shell {"command":"bun test"}
 18  tool.started a2/call_1
 19  tool.settled a2/call_1 success "14 pass, 0 fail"
 20  step.ended a2 finish=tool_calls
 21  step.started a3 attempt=1
 22  text.ended a3 "Yes. All 14 tests pass."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed interrupted:shutdown [shell error] · s1 synthetic · u2 user · a2 completed [shell success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, u2, a2, a3.

#### 39. A graceful shutdown between steps

No step is open, so nothing needs closing and nothing was cut short: no marker, only the suspended claim. The next start resumes and runs the next step.

*Provider:* step 1 finishes with a read call that succeeds; SIGTERM arrives before step 2.

```
-- shutdown at the boundary
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
 11  execution.interrupted exe_1 shutdown
-- the next start resumes
 12  execution.resumed exe_1
 13  step.started a2 attempt=1
 14  text.ended a2 "a is 1."
 15  step.ended a2 finish=stop
 16  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

## Gaps found

Each gap was checked by folding the sequence through the current reducer. G1–G6 and G8, G10–G12 have a probe in the
scenarios (a test named "Gn is still open"), and the checker in `loop-rules.ts` flags the sequence. G7–G9 cannot
be expressed today and are `test.todo`. G13 and G14 are notes; no change proposed. Only G8 changes an existing event
(a new version) and only G9 adds one; every other proposal is a reducer check, sometimes with a projection field.

### G1. A retry can continue under the same message after durable output

- Rule: retry rule 2, "Before durable output, retry transparently under the same ID. After output, mark the message
  failed and continue under a new ID."
- Sequence: `step.started a1` · `text.ended a1 "Let me look at the"` · `retry.scheduled a1 attempt=2`.
- Reducer: accepts. `a1` stays `running` with `attempt: 2`, and attempt 2's output would be appended after attempt 1's
  half sentence in the same message.
- Change: in `retry.scheduled`, when the message is `running`, reject with `invalid_transition` if it has any parts.

### G2. Retries of things that may not be retried

- Rule: retry rule 3, "Never retry auth, quota, refusal or invalid request unchanged", and the architecture page:
  "the kind fixes whether it may be retried".
- Sequences, all accepted:
  - `step.failed a1 provider:auth` · `retry.scheduled a1 attempt=2 error=auth`
  - `retry.scheduled a3 attempt=2 error=content_policy` on the open step, before `step.refused`
  - `step.failed a1 interrupted:user` · `retry.scheduled a1 attempt=3` (a step the user stopped)
- Change: reject `retry.scheduled` when `error.retryable` is false. When the target message is `failed`, also reject
  unless its `error` is `provider` with a retryable error.

### G3. A retry can name any old assistant message

- Rule: retry rule 1, "One attempt budget per logical step."
- Sequence: `step.failed a1 provider:provider_internal` · `retry.scheduled a1 attempt=2` · `step.started a2 attempt=2`
  · ... · `step.ended a2` · `retry.scheduled a1 attempt=3`. The same is accepted while `a2` is still open, and for a
  failed message from an earlier turn.
- Reducer: accepts. `retry.scheduled` finds its message with `edit`, which searches all messages, not the current step.
- Change: the target must be the open step, or, when no step is open, the latest assistant message.

### G4. `step.started` can carry any attempt

- Rule: retry rule 1, and the `step.started` doc: "a retry after output starts a new message with the next `attempt`".
- Sequence: `step.failed a1 ...` · `retry.scheduled a1 attempt=2` · `step.started a2 attempt=1`. A fresh step in a
  new turn with `attempt=5` is accepted too.
- Reducer: accepts any attempt from 1 up. Nothing ties `a2` to `a1`, so the budget exists in the log only by
  convention, and recovery cannot trust it.
- Change, projection only: add `session.retry: { attempt } | null`, set by `retry.scheduled` on a failed message and
  cleared by `step.started` and by every execution terminal event. `step.started` must carry `retry.attempt` when it
  is set, and `attempt: 1` otherwise.

### G5. An interrupted step does not force the execution to end interrupted

- Rule: cancel rule 2, "One abort token per turn, with an explicit reason enum and no default", and cancel rule 4:
  everything settles "before the step's single terminal event".
- Sequences, all accepted:
  - `step.failed a1 interrupted:user` · `step.started a2`: the loop keeps going after the user stopped it.
  - `step.failed a1 interrupted:shutdown` · `synthetic.appended s1` · `execution.interrupted user`: the claim is
    released on a shutdown, so the session is not resumed at next start. The reverse keeps a cancelled session
    claimed.
  - `step.failed a1 interrupted:user` · `execution.succeeded`.
- Change: add `session.interrupting: InterruptReason | null` to the projection, set by `step.failed` with
  `interrupted`. While it is set, accept only inbox events, `synthetic.appended`, and `execution.interrupted` with
  the same reason, which clears it.

### G6. `execution.succeeded` is accepted when the session is not done

- Rule: the `execution.succeeded` doc, "The session ran until it had nothing left to do", and the `queue` delivery
  doc, "only once the session would otherwise go idle".
- Sequences, both accepted:
  - `inbox.enqueued u2 queue` · ... · `step.ended a2 finish=stop` · `execution.succeeded`. `u2` is left in the inbox
    with no claim to deliver it.
  - `step.ended a1 finish=tool_calls` · `execution.succeeded`. The model never sees its tool results.
- Change: reject `execution.succeeded` while the inbox is not empty, or unless the latest assistant message since
  `execution.startedSeq` is `completed` with a finish other than `tool_calls`. Because there is one writer, a
  message enqueued just before the loop finishes makes the append fail, and the loop delivers it instead. That is
  the intended behaviour, not a race.

### G7. Shutdown resumes count toward the crash-resume cap (todo)

- Rule: the `execution.resumed` doc, "Counting these events is the durable resume-attempt accounting". The cap exists
  to stop crash loops.
- Sequence: three times in one long turn, `execution.interrupted shutdown` · (restart) · `execution.resumed`. Now
  `resumes` is 3, and the first real crash fails the execution at once.
- Reducer: `execution.resumed` adds 1 to `resumes` whether the claim was `running` (a crash) or `suspended` (a clean
  shutdown).
- Change, projection only: add 1 only when resuming from `running`, or keep a separate `crashResumes`. The todo
  scenario: shutdown, resume, shutdown, resume, then a crash, with the expected result `execution.resumed` and
  `resumes: 1`.

### G8. A call's effect class is not in the log (todo)

- Rule: cancel rule 4, "Started side effect with no observed outcome: 'effect unknown'. Crash orphans are settled
  durably at next start", and the `toolEffect` doc: a started call whose effect is not `read` and whose outcome was
  not observed settles as `effect_unknown`.
- Sequences:
  - `tool.called a1/call_1 read` · `tool.started` · `tool.settled effect_unknown` is accepted.
  - At next start, recovery must decide between `error` and `effect_unknown` for an orphan. It can look only at the
    current registry. After an upgrade that renamed or reclassified a tool, or for a bridge tool whose effect depends
    on its target, the registry says nothing reliable about the call that ran before the crash.
- Change: `tool.started` v2 `{ messageId, callId, effect }`. The `running` state carries `effect`, and the reducer
  rejects `effect_unknown` for `read`. A v1 event decodes with `effect: "exec"`, the conservative value. The todo
  scenario: `tool.started a1/call_1 effect=read` · (crash) · `tool.settled error` is accepted and
  `tool.settled effect_unknown` is rejected.

### G9. A user cancel is not durable until it has finished (todo; needs a decision)

- Rule: cancel rule 2, and the `interruptReason` doc: `user` releases the claim, `shutdown` keeps it.
- Sequence: the user presses stop while `tool.started a1/call_1 shell` runs. The shell gets SIGTERM and up to its
  grace period (3 s in opencode). The process dies 1 s later. The log ends at `tool.started`. The next start sees an
  ordinary crash: `tool.settled effect_unknown` · `step.failed crashed` · marker · `execution.resumed`, and it
  continues the turn the user stopped.
- How likely: it needs a crash inside the stop window, which is a few seconds at most. It is rare, but when it
  happens the user sees work they cancelled carry on by itself.
- Cost: one new event, one projection field and one branch in recovery.
- Change: `execution.interrupt_requested { executionId, reason }`, accepted while a step is open and written the
  moment the abort fires. Recovery that finds it finishes the interruption with that reason instead of resuming:
  settle the orphans, `step.failed interrupted:user`, the marker, `execution.interrupted user`. The repo's style rule
  asks for Parth's buy-in before adding this kind of robustness.

### G10. A step can start with no baseline

- Rule: context rule 2, and the `baseline.set` doc: "Recorded before the session's first step".
- Sequence: `session.created` · `inbox.enqueued u1` · `execution.started` · `step.started a1`. The baseline is
  `null`.
- Reducer: accepts. The request builder would have no instructions and no tool list to build the request from.
- Change: reject `step.started` and `compaction.started` while `baseline` is `null`.

### G11. Delivery mode and order are not enforced

- Rule: cancel rule 8, "Steering is a new user row at a step boundary"; the `queue` doc, "only once the session would
  otherwise go idle, one item at a time"; and the `inboxItem.seq` doc: "Items of equal delivery mode are delivered in
  this order".
- Sequence: `inbox.enqueued u2 queue` · ... · `step.ended a1 finish=tool_calls` · `inbox.delivered u2`. Also
  accepted: a queued item delivered while a steer waits, and a later steer delivered before an earlier one.
- Reducer: `inbox.delivered` checks only that the session is at a boundary and the claim is running.
- Change: a delivered item must be the oldest waiting item of its mode, and a `queue` item needs no steer waiting
  and, if a step has run under this claim, the latest step `completed` with a finish other than `tool_calls`.

### G12. Harness messages can be appended with no claim

- Rule: the architecture page says the reducer rejects "a delivered prompt or a step without an execution claim".
  A synthetic message is the harness speaking at a step boundary, which is part of an execution.
- Sequence: `execution.succeeded` · `synthetic.appended s1 origin=interrupt`. Accepted; `instruction.appended` is
  accepted while idle too.
- Change: require a `running` claim for `synthetic.appended` and `instruction.appended`, as `inbox.delivered` already
  does. An instruction that changes while the session is idle is then appended when the next execution starts. Low
  priority.

### G13 (note). Recovering from context overflow leaves a failed row

- Rule: retry rules 2 and 5. Before output a retry is transparent, and overflow means "compact once and rebuild, only
  if no output started".
- Sequence (scenario 29): `step.started a2` · `step.failed a2 provider:context_overflow` · `compaction.started c1
  overflow` · `compaction.ended` · `step.started a3`. It is legal, but `compaction.started` needs a boundary, so `a2`
  must be closed. It is left as an empty failed message inside the kept range, and "once" is enforced only by the
  loop.
- No change proposed. The request builder already has to render an assistant message with no parts as nothing,
  because a budget that runs out before output and a cancel before output leave the same row. The alternative,
  letting a compaction open inside an output-free step, costs more than it saves.

### G14 (note). An empty response has no failure shape

- Rule: retry rule 8, "One empty-response nudge, then fail."
- Sequence (scenario 26): the second empty response is `step.ended a2 finish=stop`, so the message is `completed`,
  and only `execution.failed` says why the turn stopped. A UI cannot mark that message as the failure.
- No change proposed unless a UI needs it. If one does, add a `stepError` variant `empty` and close the second empty
  step with `step.failed`.

## Ambiguous rules and how the scenarios read them

1. **Where the interrupt marker goes** (cancel rule 6, "rendered into the next user message"). The scenarios store it
   as its own synthetic message right after the step closes, the same way for user, shutdown and crash, with
   different text. Merging it into the next user message on the wire is left to the request builder. No marker is
   written when nothing was cut short (shutdown or crash between steps).
2. **Partial text on a provider failure.** Cancel rule 3 keeps partial visible text on a cancel. The scenarios do
   the same on a provider failure, so a failure in the middle of text counts as "after output" (scenario 18): the
   message is failed and the model sees the half sentence before the retry's message. That keeps the request
   prefix-stable. The alternative is to drop text that never reached `text.end`, which makes most mid-text failures
   transparent retries and keeps fragments away from the model, but the UI then has to remove text the user saw.
   This choice should be settled before the loop is built.
3. **The attempt number after a crash resume or an overflow compaction.** The scenarios start the new step at
   attempt 1. Crash loops are bounded by the resume cap, and overflow by "once".
4. **The refusal range.** The scenarios exclude the whole refused turn, from its prompt, as Hermes does. That
   includes completed tool steps with real side effects, which the model then forgets. The alternative is to exclude
   only the refused step.
5. **How an execution ends.** A refusal, a second empty response and a budget that runs out end with
   `execution.failed`. A step-limit final answer ends with `execution.succeeded`.
6. **A pending steer after a user cancel.** It stays waiting and is delivered first by the next execution. The loop
   does not start that execution by itself.
7. **A response cut off by `length` that also has complete calls.** This is not specified. The scenarios cover only a
   cut-off call, which is never recorded. Running the complete calls of a truncated response seems risky; settling
   them `not_started` and adding the output-limit note is the safer reading.
8. **The identical-call guard** ("a simple identical-call guard"). The scenarios refuse the third call in a turn with
   the same name, the same input and the same result before it, without running it.
9. **The numbers** (retry delays, the budget, the resume cap, the step limit) are not fixed by the blueprint. The
   constants are in `script.ts`.

## What the loop must not do

Marked *(reducer)* when the reducer already rejects it (the scenario `rejects` entries test it), and *(G n)* when
only `loop-rules.ts` catches it until that gap is closed.

1. Run a tool before its `tool.called` is durable. If the append throws, run nothing (cancel rule 1).
2. Run a tool before its `tool.started` is durable. Otherwise a crash after the tool began leaves a `pending` call,
   which recovery settles as `not_started`, and that claim is false. Scenario 34 shows why the start must come first.
3. Record a call before its `tool_call.end`, or run a call cut off by the output limit (retry rule 6).
4. End a step while a call is unsettled, or give a step a second terminal event *(reducer)*.
5. Settle a call twice, including settling a finished call again on cancel *(reducer)*. Settle a started call as
   `not_started` *(reducer)*, or a read as `effect_unknown` *(G8)*.
6. Deliver input in the middle of a step *(reducer)*. Deliver a queued item before the turn would go idle, or out of
   order *(G11)*.
7. Edit a stored row to steer. There is no edit event; a steer is always a new message.
8. Keep working after an interrupted step, or end the execution with a different reason than the step's *(G5)*.
9. Leave out the interrupt marker after a step that was interrupted or crashed (`loop-rules.ts`).
10. Retry under the same message after output *(G1)*. Retry a non-retryable error, a refusal or an interrupted step
    *(G2)*. Retry a message that is not the current step *(G3)*. Start a retry's new message with the wrong attempt
    *(G4)*.
11. Record a refusal as `step.failed` *(reducer)*.
12. Resume a crashed execution before every orphan is settled and the crashed step is closed *(reducer)*, or resume
    after a user interrupt *(reducer)*.
13. Start, deliver or step while the claim is suspended *(reducer)*.
14. Succeed while input waits, or right after a step that asked for tools *(G6)*.
15. Start a step before the baseline is frozen *(G10)*, change the baseline before a compaction *(reducer)*, or
    append a harness message after the claim is released *(G12)*.
