# Step-loop scenarios

The step loop (`packages/core/src/engine/`) takes a prompt, calls the model, runs tools, and handles cancel, retries
and crash recovery. It records the workspace as snapshots around everything that can change it, runs the project's
configured checks before a turn may end as done, and reverts a turn (files and conversation) on request. This page
is its specification: for each situation, the exact durable events the loop must write, in
order, what a UI and the model should see afterwards, and the wrong moves the reducer rejects at that point. Rules are cited
by family and number, e.g. "cancel rule 4".

The scenarios live in `packages/core/test/scenarios/`, one module per family, and are exported for other packages as
`@windlass/core/testing/scenarios`. `scenarios.test.ts` folds every one through the real reducer, checks the state
after each phase, and checks, one test per entry, that the reducer rejects every wrong move listed with a phase.

`packages/core/test/engine/conformance.test.ts` drives the real loop through every scenario (90 of them) with the
scripted provider and compares the events it wrote with the scenario's. One scenario differs from what the loop writes, by one stated
detail (the runtime's wording for malformed arguments, in "Malformed tool arguments"); the test lists it with the
reason. Every other scenario, the eight of the Compaction family included, is reproduced event for event.

Every ordering rule on this page is enforced by the reducer, which runs inside the append transaction: an event that
breaks one is never written. A loop test therefore needs no separate checker. It folds the events its loop wrote; a
`ReduceError` is the violation.

The "Scenarios" section is generated from the modules by `bun scripts/scenario-doc.ts --write`, and a test fails when
the two differ.

## Conventions

- IDs: `u` user, `a` assistant (one per step attempt that produced output), `s` synthetic, `r` a check report,
  `i` instruction, `c` compaction, `q` a queued prompt, `exe_` execution, `w` a state of the workspace (a snapshot
  ID; the same state always has the same one). `seq` is the number at the start of each event line.
- Most scenarios start with the same five events, shown as `1-5 opening`: the session is created (with its model
  settings), the prompt `u1` is admitted, the claim `exe_1` is taken, the baseline is frozen and `u1` is delivered
  (at seq 5).
- The scenarios of the last two families run with snapshots on, and say so in a *Setup* line with the files of the
  workspace and the project's configuration. Their opening has six events: the workspace is recorded (`w0`) before
  the prompt is delivered (at seq 6). Every other scenario runs without snapshots and without a configuration, so
  its log holds none of their events and its `execution.succeeded` says that nothing was verified (not shown).
- The scenarios of the family "Approval and the sandbox" run with the approval layer on, and say what they run
  under in an *Approval* line: the mode, whether the machine has a sandbox, and whether a person is present. Every
  other scenario runs with the layer off: each call runs as it is, `tool.started` carries no `run` facts, and the
  log holds no `approval.*` or `taint.*` event. With the layer on, `tool.started` shows the mode, `sandboxed` for a
  command that ran in the sandbox (`+network` when it had the network) and where each path argument lies.
- The scenarios of the family "Replays, subagents and background work" are each one session's log: a replay's and
  a subagent's start at seq 1 and name the session they come from (`ses_other`). Subagents and background work are
  switched on for the scenarios about them and off everywhere else. The family "Forks" is listed last and apart
  (`forkFamilies`): a fork's log begins with its parent's events (a scenario is one log, so they carry the
  scenario's session ID), which makes it the one scenario that cannot be stored as a session under another ID.
- *Model sees next* is `selectModelHistory` after the last event: what the next request is built from.
- *The reducer rejects* lists events the loop must not write at the end of the named phase, with the error code.
- Scenario constants: an attempt budget of 5 per logical step (1 + the spec's 4 retries), a crash-resume cap of 3,
  and a step limit of 3 to keep the step-limit scenario short. The reducer counts attempts and crash resumes; the
  limits themselves are the loop's.

Choices these scenarios make where the blueprint leaves room (see also "Ambiguous rules" below):

- Tool calls are recorded (`tool.called`) the moment each call finishes streaming, but tools run only after the
  response finishes. So `step.ended` comes after every result, and a cancel during streaming leaves any recorded
  call `not_started`.
- A cancel or a shutdown is recorded at once as `execution.interrupt_requested`, before anything is stopped. From
  there the execution only winds down, and it ends with `execution.interrupted` for the same reason.
- The interrupt marker is its own `synthetic.appended` message with origin `interrupt`, written immediately after a
  step closes as `interrupted` or `crashed`. When no step is open (cancel between steps) it is written just before
  the release. Merging it into the next user message on the wire is the request builder's job.
- When the loop, not the tool, decides an outcome (not started, effect unknown, refused by the guard, malformed
  arguments), it freezes an explanatory text into `tool.settled.output`. The exact wording is in `script.ts`.
- A snapshot is taken where the workspace can have changed, and nowhere else: before input is delivered, around
  the tools of a step that has a call with a side effect, around a run of checks, around a restore. A step whose
  calls all read takes none.
- The verification gate runs when the model has answered and no steer waits: before the execution ends, and
  before a queued follow-up is delivered, because "after this turn" means after the turn is done and done is what
  the gate says. When a queued message waits, the gate's verdict is recorded as `turn.ended`, appended together
  with that message's delivery. A steer never waits for the gate. The results of a run and what the gate decides
  from them (the report that sends the model back, or the terminal event) are one append.
- The check report is a `synthetic.appended` with origin `check_report`, appended at the end of history like any
  other message. The acknowledgement is a call to the `report_check_failure` tool; nothing is read from prose.

## Scenarios

<!-- scenarios:start (generated by scripts/scenario-doc.ts; do not edit by hand) -->

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

*The reducer rejects:*
- after "the prompt is admitted and the claim taken": `step.started a1 attempt=1` (invalid_transition). A step needs the frozen baseline its request is built from.
- after "the baseline is frozen, the prompt delivered, the model answers": `synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."` (invalid_transition). History grows only under a running claim, as inbox.delivered already requires.

#### 2. One tool call, then an answer

The model reads a file and then answers. The call is durable (tool.called) before the tool starts, the start is durable before the tool runs, and the result is durable before the step ends. The answer is a second step that continues from the reloaded history.

*Provider:* step 1 streams text and one tool call and finishes with tool_calls; step 2 streams text and finishes with stop.

```
-- the turn
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Let me read the test."
  8  tool.called a1/call_1 read {"path":"a.test.ts"}
  9  tool.started a1/call_1 effect=read
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
  9  tool.started a1/call_1 effect=read
 10  tool.started a1/call_2 effect=read
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
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
 13  tool.started a2/call_1 effect=write
 14  tool.settled a2/call_1 success "Wrote a.test.ts"
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 shell {"command":"bun test"}
 18  tool.started a3/call_1 effect=exec
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

#### 6. The user switches the model in the middle of a turn

While the first step's tool runs, the user picks another model. The change is a durable event of its own, written at the step boundary; from then on every step calls the new model, and the request builder takes its parameters from the stored settings. The next request no longer extends the previous one (its first block changed), and the prefix check is told why by this event.

*Provider:* step 1 (gpt-test) finishes with a read call; the user switches to gpt-other; step 2 (gpt-other) answers.

```
-- the first step runs on the session's model
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
-- the step ends and the change is recorded
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
 11  settings.changed model=gpt-other reasoningEffort=medium
-- the turn continues on the new model
 12  step.started a2 attempt=1 model=gpt-other
 13  text.ended a2 "a is 1."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the first step runs on the session's model": `settings.changed model=gpt-other reasoningEffort=medium` (invalid_transition). The request in flight was built from the old settings: they change only at a step boundary.
- after "the step ends and the change is recorded": `step.started a2 attempt=1` (invalid_transition). A step calls the model the session's settings name, which is gpt-other now.
- after "the step ends and the change is recorded": `settings.changed model=gpt-other reasoningEffort=medium` (invalid_transition). An event that changes nothing records no fact.

#### 7. The agent starts working in a directory that has its own instructions

The session started in `/repo`, whose instructions are in the frozen baseline. The model reads a file in `packages/api`, a directory with an `AGENTS.md` of its own. The loop notes which directories the tool calls of a step touched, and at the next step boundary it looks for instruction files there: the file is appended once, as a message, with its text and fingerprint frozen. The baseline is not rewritten, so the next request is the previous one plus appended items. From then on the file is known, and is appended again only if it changes.

*Provider:* step 1 finishes with a read call in packages/api; step 2 answers.

```
-- the model reads a file in packages/api
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"packages/api/handler.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "export const handler = () => 200"
 10  step.ended a1 finish=tool_calls
-- at the boundary the directory's instructions are appended, then the next step runs
 11  instruction.appended i1 source=agents:/repo/packages/api/AGENTS.md "Handlers return status codes, never bodies."
 12  step.started a2 attempt=1
 13  text.ended a2 "It returns 200."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · i1 instruction · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, i1, a2.

*The reducer rejects:*
- after "at the boundary the directory's instructions are appended, then the next step runs": `baseline.set` (invalid_transition). The baseline is frozen until the next compaction: a newly found file is appended, never folded in.

#### 8. A session is archived and brought back

After a turn the user archives the session (an editor's "delete"). Archiving is an event in the session's own log, so it is recorded once and nothing is deleted: the session is only left out of the default listing, and the workspace snapshots that no revert or undo of it could still restore are dropped. Unarchiving is the opposite event, and the session works as before.

*Provider:* answers each of the two prompts with stop.

```
-- a turn, then the session is archived
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "2"
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
 10  session.archived
-- it is unarchived and used again
 11  session.unarchived
 12  inbox.enqueued u2 steer "And 2 + 2?"
 13  execution.started exe_2
 14  inbox.delivered u2
 15  step.started a2 attempt=1
 16  text.ended a2 "4"
 17  step.ended a2 finish=stop
 18  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · u2 user · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, a2.

*The reducer rejects:*
- after "a turn, then the session is archived": `session.archived` (invalid_transition). A session is archived once: an event records a change.
- after "it is unarchived and used again": `session.unarchived` (invalid_transition). The session is not archived.

### Cancel by the user

#### 9. Cancel while text is streaming

The model has finished a reasoning item and is half-way through its answer when the user presses stop. The half-written sentence the user already saw is kept, written as a `text.ended` with the text so far. Reasoning that was still streaming would be dropped, because partial reasoning is never recorded. The model is told on its next request that its response was cut short.

*Provider:* streams a complete reasoning item, then text deltas "Let me lo"; the abort signal fires and the stream stops with no terminal event.

```
-- the model is streaming
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  reasoning.ended a1 "Read the test first."
-- the user cancels: the request is durable before anything stops
  8  execution.interrupt_requested exe_1 user
-- flush the visible text and close the step
  9  text.ended a1 "Let me lo"
 10  step.failed a1 interrupted:user
-- tell the model
 11  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
-- release the claim
 12  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the user cancels: the request is durable before anything stops": `reasoning.ended a1 "One more thought."` (invalid_transition). No new model output is recorded after the cancel, only the visible partial text.
- after "the user cancels: the request is durable before anything stops": `tool.called a1/call_1 read {}` (invalid_transition). No tool call is recorded after the cancel.
- after "the user cancels: the request is durable before anything stops": `step.ended a1 finish=stop` (invalid_transition). A step that was open when the cancel arrived ends as interrupted, not as completed.
- after "the user cancels: the request is durable before anything stops": `step.failed a1 provider:provider_internal` (invalid_transition). The step ends as interrupted even if the provider failed at the same moment.
- after "the user cancels: the request is durable before anything stops": `step.failed a1 crashed` (invalid_transition). The cancel is durable, so recovery closes the step as interrupted, not as crashed.
- after "the user cancels: the request is durable before anything stops": `step.failed a1 interrupted:shutdown` (invalid_transition). The step is interrupted for the reason that was requested.
- after "the user cancels: the request is durable before anything stops": `execution.interrupt_requested exe_1 shutdown` (invalid_transition). The first interrupt wins, as it does on the abort token.
- after "flush the visible text and close the step": `step.started a2 attempt=1` (invalid_transition). An interrupted step must be followed by the marker and execution.interrupted, not by another step.
- after "flush the visible text and close the step": `execution.interrupted exe_1 user` (invalid_transition). The interrupt marker comes first: the model must be told its response was cut short.
- after "flush the visible text and close the step": `synthetic.appended s1 origin=empty_response "Continue."` (invalid_transition). The only harness message while winding down is the interrupt marker.
- after "flush the visible text and close the step": `execution.succeeded exe_1` (invalid_transition). An interrupted execution does not succeed.
- after "flush the visible text and close the step": `execution.failed exe_1 "gave up"` (invalid_transition). An interrupted execution ends as interrupted, not as failed.
- after "tell the model": `execution.interrupted exe_1 shutdown` (invalid_transition). The user cancelled, so the claim is released, not kept for the next start.
- after "tell the model": `step.started a2 attempt=1` (invalid_transition). The marker does not end the interrupt; only execution.interrupted does.
- after "release the claim": `execution.resumed exe_1` (not_found). A user interrupt releases the claim, so unlike a shutdown there is nothing to resume.

#### 10. Cancel while a tool call's arguments are streaming

The model has finished one tool call and is streaming the arguments of a second when the user cancels. Tools run only after the response finishes, so the first call is recorded but has not started: it settles as `not_started`. The second call never finished streaming, so it is never recorded at all; its partial arguments are dropped.

*Provider:* streams text, one complete tool call (call_1), then argument deltas for call_2; aborted before call_2 ends.

```
-- the model is streaming the second call
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "I'll read both files."
  8  tool.called a1/call_1 read {"path":"a.ts"}
-- the user cancels
  9  execution.interrupt_requested exe_1 user
 10  tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [read not_started] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the model is streaming the second call": `step.failed a1 interrupted:user` (invalid_transition). A step ends as interrupted only after the interrupt was requested, and only once call_1 is settled.

#### 11. Cancel while one tool is running

A shell command is running when the user cancels. The shell kills the process group, waits its bounded grace period, and returns the output so far. Because an outcome was observed (it was stopped, and here is what it printed), the call settles as `error` with that output, not as `effect_unknown`.

*Provider:* the response finishes with one shell call; the command is still running when the abort fires.

```
-- the command is running
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  tool.started a1/call_1 effect=exec
-- the user cancels; the shell returns its output so far
  9  execution.interrupt_requested exe_1 user
 10  tool.settled a1/call_1 error "Stopped by the user after 4 s. Output so far:\n12 pass\n"
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [shell error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

#### 12. Cancel while two parallel tools run and one has finished

Two calls run at once. The read already settled with its result; the shell command is still running when the user cancels. The finished call keeps its result, the running one settles once with the output it observed, and only then does the step close.

*Provider:* step 1 finishes with a read and a shell call; the read finishes, the shell is still running at the abort.

```
-- one call is done, one is running
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.called a1/call_2 shell {"command":"bun test"}
  9  tool.started a1/call_1 effect=read
 10  tool.started a1/call_2 effect=exec
 11  tool.settled a1/call_1 success "export const a = 1"
-- the user cancels
 12  execution.interrupt_requested exe_1 user
 13  tool.settled a1/call_2 error "Stopped by the user after 2 s. Output so far:\n3 pass\n"
 14  step.failed a1 interrupted:user
 15  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 16  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [read success, shell error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "one call is done, one is running": `tool.settled a1/call_1 error "Stopped by the user."` (invalid_transition). A call settles exactly once: the finished read keeps its result.

#### 13. Cancel before a started side-effecting tool reports anything

A write has started (its `tool.started` is durable) and the user cancels before it returns anything. Nobody observed whether the file was written, so the call settles as `effect_unknown` and the model is told to check before repeating it. It can never be `not_started`: once started, a side effect may have happened.

*Provider:* step 1 finishes with one write call; the abort fires right after the tool starts and the tool returns nothing.

```
-- the write has started
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"a.ts","content":"export const a = 2"}
  8  tool.started a1/call_1 effect=write
-- the user cancels
  9  execution.interrupt_requested exe_1 user
 10  tool.settled a1/call_1 effect_unknown "Started, but stopped before it reported a result. It may ..."
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [write effect_unknown] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the write has started": `tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."` (invalid_transition). A started call may have had its effect; it cannot claim it never started.

#### 14. Cancel before a started read-only tool reports anything

Same moment as the previous scenario, but the tool only reads. A read has no side effect, so there is nothing unknown about the workspace: the call settles as `error`, and the model may simply call it again.

*Provider:* step 1 finishes with one read call; the abort fires right after the tool starts and the tool returns nothing.

```
-- the read has started
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
-- the user cancels
  9  execution.interrupt_requested exe_1 user
 10  tool.settled a1/call_1 error "Stopped before it finished. Nothing was changed; it is sa..."
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [read error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the read has started": `tool.settled a1/call_1 effect_unknown "Started, but stopped before it reported a result. It may ..."` (invalid_transition). The call started with effect class read, which has no side effect, so there is nothing unknown about it.

#### 15. Cancel while waiting between steps

The first step ended and its tool results are durable; the next model call has not started. No step is open, so no step event is written: the cancel is only the marker and the release. Each step that ran still has exactly one terminal event.

*Provider:* step 1 finishes with one read call that succeeds; the abort fires before step 2 is requested.

```
-- between steps
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
-- the user cancels
 11  execution.interrupt_requested exe_1 user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 completed [read success] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "between steps": `step.failed a1 interrupted:user` (invalid_transition). A1 already has its terminal event; a step ends exactly once.
- after "between steps": `execution.interrupted exe_1 user` (invalid_transition). An execution ends as interrupted only after the interrupt was requested.
- after "between steps": `execution.succeeded exe_1` (invalid_transition). The model never saw call_1's result, so the execution did not run to completion.

#### 16. Cancel while waiting to retry

The first attempt failed with a rate limit before any output, so the retry runs under the same message and the loop is sleeping for the retry-after delay. The step is still open. The user cancels during the delay: the step closes as interrupted (not as a provider failure), and the scheduled attempt never runs.

*Provider:* attempt 1 fails with rate_limit (retry-after 3 s) before any output; the abort fires during the delay.

```
-- waiting to retry
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  retry.scheduled a1 attempt=2 delayMs=3000 after rate_limit
-- the user cancels during the delay
  8  execution.interrupt_requested exe_1 user
-- the step closes as interrupted
  9  step.failed a1 interrupted:user
 10  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 11  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the user cancels during the delay": `retry.scheduled a1 attempt=3 delayMs=2000 after rate_limit` (invalid_transition). Nothing is retried once the user cancelled.
- after "the step closes as interrupted": `retry.scheduled a1 attempt=3 delayMs=2000 after rate_limit` (invalid_transition). A step that the user interrupted is not retried.

### One call stopped by the user

#### 17. The user stops one command and the turn goes on

A test run hangs. The user stops that call, not the turn. The request is recorded for the call (`tool.cancel_requested`) before anything is stopped, then the call's own abort signal fires with a reason that says the user stopped this call. The shell kills the process group and returns what the command had printed, with a line that says the user stopped it, so the call settles as `error` with that output: an outcome was observed. The execution is not interrupted: the step ends like any step whose calls have their results, and the model reads the result in its next request and carries on. Only a call that is running can be stopped this way, and only once.

*Provider:* step 1 calls shell with a test run that never returns; the user stops that call; step 2 answers.

```
-- the model asks for the command
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
-- the command hangs; the user stops that call
  8  tool.started a1/call_1 effect=exec
  9  tool.cancel_requested a1/call_1
-- the shell returns what the command had printed; the step ends and the model answers
 10  tool.settled a1/call_1 error "12 pass\n[Stopped by the user. The command and its child p..."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The test run hung after 12 tests, so you stopped it. The ..."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell error (stopped by the user)] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the model asks for the command": `tool.cancel_requested a1/call_1` (invalid_transition). Only a call that is running is stopped by itself; one that has not started is declined, or never begins.
- after "the command hangs; the user stops that call": `tool.cancel_requested a1/call_1` (invalid_transition). A call is asked to stop once.
- after "the command hangs; the user stops that call": `tool.cancel_requested a1/call_2` (not_found). The request names a call of the step.
- after "the command hangs; the user stops that call": `step.ended a1 finish=tool_calls` (invalid_transition). The step waits for the stopped call's result like for any other.
- after "the command hangs; the user stops that call": `tool.settled a1/call_1 not_started "Not run."` (invalid_transition). A call that started is never recorded as not started, also when it was stopped.
- after "the shell returns what the command had printed; the step ends and the model answers": `tool.cancel_requested a1/call_1` (invalid_transition). Nothing is stopped once the turn is over.

#### 18. A stopped call that reports nothing is settled from its effect class, and the step's other call finishes

Two calls of one step run side by side: a command and a file read. The user stops the command. Its tool reports nothing: it throws while it is being stopped, or does not come back within the grace period a stopping tool is given (then whatever it returns later is dropped). The loop settles the call from the effect class it started with, exactly as it does for a call an interrupt reached: a command may have had its effect, so the outcome is `effect_unknown`, and the text says that the user stopped this call and that the state must be checked. A read in the same place would settle as `error`: it changed nothing. The other call is not touched: the read finishes with its result, the step ends, and the model goes on.

*Provider:* step 1 calls shell and read; the user stops the shell call, whose tool reports nothing; the read finishes; step 2 answers.

```
-- both calls run
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run migrate"}
  8  tool.called a1/call_2 read {"path":"a.ts"}
  9  tool.started a1/call_1 effect=exec
 10  tool.started a1/call_2 effect=read
-- the user stops the command; its tool reports nothing
 11  tool.cancel_requested a1/call_1
 12  tool.settled a1/call_1 effect_unknown "Stopped by the user before it reported a result; the user..."
-- the read finishes; the step ends and the model goes on
 13  tool.settled a1/call_2 success "export const a = 1"
 14  step.ended a1 finish=tool_calls
 15  step.started a2 attempt=1
 16  text.ended a2 "a.ts exports a = 1. I do not know whether the migration w..."
 17  step.ended a2 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell effect_unknown (stopped by the user), read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the user stops the command; its tool reports nothing": `tool.cancel_requested a1/call_1` (invalid_transition). A call that has its result is over.
- after "the user stops the command; its tool reports nothing": `tool.settled a1/call_2 effect_unknown "Stopped by the user before it reported a result; the user..."` (invalid_transition). A read changes nothing, whoever stops it.

#### 19. A call that cannot be stopped midway finishes with its ordinary result

The user asks for a file read to stop. A read (like a write, which is one rename) cannot be stopped midway and takes no time worth stopping: the tool finishes and the call settles with its ordinary result, as if nobody had asked. The request stays on record with the call, so a client can show that it was made; the model reads the file's content.

*Provider:* step 1 calls read; the user asks for it to stop while it runs; the read returns the file; step 2 answers.

```
-- the read runs and the user asks for it to stop
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.cancel_requested a1/call_1
-- the read finishes as ever
 10  tool.settled a1/call_1 success "export const a = 1"
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "It exports a = 1."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success (stopped by the user)] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 20. The user stops one call and then the whole turn

Two commands run side by side. The user stops the first, and before it has reported, stops the turn. The interrupt is recorded like any (`execution.interrupt_requested`) and from then on the execution only winds down: no single call is stopped any more, because everything stops. Each call settles once with what its tool observed (the first was stopped as a call, the second by the interrupt, and each result says which), the step closes as interrupted, the marker follows, and the claim is released.

*Provider:* step 1 calls shell twice; the user stops the first call, then cancels the turn; both commands return what they had printed.

```
-- two commands run; the user stops the first
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  tool.called a1/call_2 shell {"command":"bun run lint"}
  9  tool.started a1/call_1 effect=exec
 10  tool.started a1/call_2 effect=exec
 11  tool.cancel_requested a1/call_1
-- the user cancels the turn
 12  execution.interrupt_requested exe_1 user
-- both commands return what they had printed; the turn ends as interrupted
 13  tool.settled a1/call_1 error "12 pass\n[Stopped by the user. The command and its child p..."
 14  tool.settled a1/call_2 error "[Interrupted by the user. The command and its child proce..."
 15  step.failed a1 interrupted:user
 16  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 17  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [shell error (stopped by the user), shell error] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the user cancels the turn": `tool.cancel_requested a1/call_2` (invalid_transition). Once an interrupt was requested everything stops: no single call is stopped any more.

#### 21. The user stops a subagent call: the child is interrupted and the call says so

A call that waits for a subagent is stopped like any call. Its signal fires, and the session interrupts the child as the child's own user would: the child winds down by the usual rules and its turn ends as interrupted in its own log. In the parent, `spawn.ended` records that the work was `stopped`, and the call settles as `error` with a result that says the subagent did not finish because the user stopped this call, and quotes its last words. The parent's turn goes on: the model reads that result and decides what to do. The child's conversation stays, so a follow-up can still be sent to it.

*Provider:* step 1 calls subagent; the child has said what it is doing and is reading a file when the user stops the call; step 2 answers.

```
-- the child is started and runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 subagent {"task":"Fix module a"}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 subagent ses_other
-- the user stops the call; the child is interrupted and its end is the call's result
 10  tool.cancel_requested a1/call_1
 11  spawn.ended bg_1 stopped usage=1000in/50out
 12  tool.settled a1/call_1 error "The subagent did not finish its task. It was stopped befo..."
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "You stopped the subagent before it changed anything. Modu..."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [subagent error (stopped by the user)] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

### Steering and queueing

#### 22. A steer arriving mid-step is delivered at the next step boundary

While a read runs, the user types "also check b.ts". The message is admitted to the inbox at once, but it enters history only when the step has ended: after the tool result, as a new user message. Nothing already written is edited, so the next request extends the previous one.

*Provider:* step 1 finishes with one read call; the user steers while it runs; step 2 reads b.ts; step 3 answers.

```
-- the user steers while the read runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  inbox.enqueued u2 steer "Also check b.ts."
-- the step ends; the steer is delivered before the next step
 10  tool.settled a1/call_1 success "export const a = 1"
 11  step.ended a1 finish=tool_calls
 12  inbox.delivered u2
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 read {"path":"b.ts"}
 15  tool.started a2/call_1 effect=read
 16  tool.settled a2/call_1 success "export const b = 2"
 17  step.ended a2 finish=tool_calls
 18  step.started a3 attempt=1
 19  text.ended a3 "a is 1 and b is 2."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · u2 user · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, a2, a3.

*The reducer rejects:*
- after "the user steers while the read runs": `inbox.delivered u2` (invalid_transition). Input enters history only at a step boundary, never in the middle of a step.

#### 23. A queued message waits until the session would go idle

While the model works, the user queues a follow-up. Unlike a steer it is not delivered at the next step boundary: the turn runs to its answer first. When the session would otherwise go idle, the turn ends (`turn.ended`, with what the verification gate found: here nothing is configured, so nothing was verified), exactly one queued item is delivered in the same append, and the loop carries on under the same claim.

*Provider:* step 1 finishes with a read call; step 2 answers with stop; then step 3 answers the queued message.

```
-- the user queues a follow-up
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  inbox.enqueued u2 queue "Then write a changelog entry."
  8  tool.called a1/call_1 read {"path":"a.ts"}
  9  tool.started a1/call_1 effect=read
 10  tool.settled a1/call_1 success "export const a = 1"
 11  step.ended a1 finish=tool_calls
-- the turn finishes, still holding the queued item
 12  step.started a2 attempt=1
 13  text.ended a2 "a is 1."
 14  step.ended a2 finish=stop
-- the session would go idle: the turn ends and one queued item is delivered
 15  turn.ended
 16  inbox.delivered u2
 17  step.started a3 attempt=1
 18  text.ended a3 "Added the entry."
 19  step.ended a3 finish=stop
 20  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed · u2 user · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, u2, a3.

*The reducer rejects:*
- after "the user queues a follow-up": `inbox.delivered u2` (invalid_transition). The model still has to answer: a queued item waits until the session would go idle.
- after "the turn finishes, still holding the queued item": `execution.succeeded exe_1` (invalid_transition). The execution cannot succeed while input waits; it delivers the queued item instead.
- after "the turn finishes, still holding the queued item": `inbox.delivered u2` (invalid_transition). Whether the turn may end is the gate's decision: turn.ended comes before the delivery of what waited behind the turn.

#### 24. A pending steer survives an interrupt

The user steers while a call is pending and then cancels the turn. The cancel closes the step and releases the claim, but the steer is not withdrawn: it stays in the inbox, visible as waiting, and is the first thing delivered when work starts again. Only `inbox.cancelled` removes it.

*Provider:* step 1 finishes with one read call; the user steers, then cancels before the read starts.

```
-- a steer waits, then the user cancels
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  inbox.enqueued u2 steer "Use b.ts instead."
  9  execution.interrupt_requested exe_1 user
 10  tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
-- work starts again: the steer is delivered first
 14  execution.started exe_2
 15  inbox.delivered u2
 16  step.started a2 attempt=1
 17  tool.called a2/call_1 read {"path":"b.ts"}
 18  tool.started a2/call_1 effect=read
 19  tool.settled a2/call_1 success "export const b = 2"
 20  step.ended a2 finish=tool_calls
 21  step.started a3 attempt=1
 22  text.ended a3 "b is 2."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_2
```

*UI:* u1 user · a1 failed interrupted:user [read not_started] · s1 synthetic · u2 user · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, u2, a2, a3.

#### 25. Several waiting items: steers first and in order, then one queued item at a time

While a read runs the user queues two follow-ups and then steers twice. At the step boundary both steers are delivered, oldest first, and the queued items keep waiting. When the turn has its answer, one queued item is delivered and answered before the next. Within a mode the order is the order of admission; a steer never waits behind a queued item.

*Provider:* step 1 finishes with a read call; step 2 answers; steps 3 and 4 answer the two queued items.

```
-- four items are admitted while the read runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  inbox.enqueued q1 queue "Then update the changelog."
 10  inbox.enqueued q2 queue "Then bump the version."
 11  inbox.enqueued u2 steer "Also check b.ts."
 12  inbox.enqueued u3 steer "And c.ts."
 13  tool.settled a1/call_1 success "export const a = 1"
 14  step.ended a1 finish=tool_calls
-- both steers are delivered at the boundary, in order
 15  inbox.delivered u2
 16  inbox.delivered u3
-- the turn gets its answer; one queued item is delivered
 17  step.started a2 attempt=1
 18  text.ended a2 "a, b and c are fine."
 19  step.ended a2 finish=stop
 20  turn.ended
 21  inbox.delivered q1
-- each queued item is answered before the next is delivered
 22  step.started a3 attempt=1
 23  text.ended a3 "Changelog updated."
 24  step.ended a3 finish=stop
 25  turn.ended
 26  inbox.delivered q2
 27  step.started a4 attempt=1
 28  text.ended a4 "Version bumped."
 29  step.ended a4 finish=stop
 30  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · u2 user · u3 user · a2 completed · q1 user · a3 completed · q2 user · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, u3, a2, q1, a3, q2, a4.

*The reducer rejects:*
- after "four items are admitted while the read runs": `inbox.delivered u3` (invalid_transition). U2 was steered first, so it is delivered first.
- after "four items are admitted while the read runs": `inbox.delivered q1` (invalid_transition). Steered input is delivered before queued input.
- after "both steers are delivered at the boundary, in order": `inbox.delivered q1` (invalid_transition). The steers are not answered yet, so the session would not go idle.
- after "both steers are delivered at the boundary, in order": `execution.succeeded exe_1` (invalid_transition). Input was delivered and not answered, and more waits.
- after "the turn gets its answer; one queued item is delivered": `inbox.delivered q2` (invalid_transition). One queued item at a time: q1 has not been answered.

#### 26. A prompt is withdrawn before it is delivered

The user steers while a read runs and takes the message back before the step ends (a client that cancels a prompt it just sent). The withdrawal is an event of its own, `inbox.cancelled`: the item leaves the inbox and never becomes a message, so the model never sees it. Nothing else about the turn changes. A prompt that was already delivered cannot be withdrawn; that is what a revert is for.

*Provider:* step 1 finishes with a read call; step 2 answers.

```
-- the user steers while the read runs, then takes it back
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  inbox.enqueued u2 steer "Also check b.ts."
 10  inbox.cancelled u2
 11  tool.settled a1/call_1 success "export const a = 1"
 12  step.ended a1 finish=tool_calls
-- the turn ends without it
 13  step.started a2 attempt=1
 14  text.ended a2 "a is 1."
 15  step.ended a2 finish=stop
 16  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the user steers while the read runs, then takes it back": `inbox.delivered u2` (not_found). A withdrawn item is never delivered.
- after "the user steers while the read runs, then takes it back": `inbox.cancelled u2` (not_found). It is withdrawn once.
- after "the user steers while the read runs, then takes it back": `inbox.cancelled u1` (not_found). A delivered prompt is history and cannot be withdrawn.

### Retries

#### 27. A retryable failure before any output

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

#### 28. A retryable failure after partial text: the model is asked to continue

The server fails after the model had written part of its answer, which the user saw. That text is now durable output, so the retry cannot be transparent: the message is marked failed with its partial text kept, and the next attempt runs under a new message with attempt 2. Between the two the loop appends a short harness note asking the model to continue from where it stopped. Without the note the next request ends on the model's own half sentence and the model starts its answer again from the top (checked against the live provider); with it, the new message picks up mid-sentence. Both messages stay in the UI, and the model sees the partial message, the note and the continuation.

*Provider:* attempt 1 streams "Let me look at the" and then fails with provider_internal (HTTP 500); attempt 2 continues the sentence.

```
-- attempt 1 fails after output
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Let me look at the"
-- the message fails and a retry is scheduled
  8  step.failed a1 provider:provider_internal
  9  retry.scheduled a1 attempt=2 delayMs=2000 after provider_internal
-- the model is asked to continue, and the retry runs under a new message
 10  synthetic.appended s1 origin=continuation "Your previous response was cut off by a provider error. C..."
 11  step.started a2 attempt=2
-- the continuation
 12  text.ended a2 " test first, then the implementation."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed provider:provider_internal · s1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2.

*The reducer rejects:*
- after "attempt 1 fails after output": `retry.scheduled a1 attempt=2 delayMs=2000 after provider_internal` (invalid_transition). After durable output the retry may not continue under the same message.
- after "attempt 1 fails after output": `synthetic.appended s1 origin=continuation "Your previous response was cut off by a provider error. C..."` (invalid_transition). A message enters history only at a step boundary: the failed step is closed first.
- after "the message fails and a retry is scheduled": `step.started a2 attempt=1` (invalid_transition). The retry continues the step's attempt budget, so it must carry the scheduled attempt 2.
- after "the message fails and a retry is scheduled": `retry.scheduled a1 attempt=3 delayMs=2000 after provider_internal` (invalid_transition). Attempt 2 is already scheduled; the budget moves on when the new message starts.
- after "the message fails and a retry is scheduled": `execution.succeeded exe_1` (invalid_transition). The latest step failed, so the model has not answered.
- after "the model is asked to continue, and the retry runs under a new message": `retry.scheduled a1 attempt=3 delayMs=2000 after provider_internal` (invalid_transition). A1 is no longer the step in progress; only a2 can be retried now.

#### 29. A stream that ends with no terminal event

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

#### 30. The attempt budget runs out

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

#### 31. A non-retryable error: authentication

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

*The reducer rejects:*
- after "the call is rejected": `retry.scheduled a1 attempt=2 delayMs=2000 after auth` (invalid_transition). Auth is not retryable.

#### 32. A non-retryable error: usage limit

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

*The reducer rejects:*
- after "the call is rejected": `retry.scheduled a1 attempt=2 delayMs=2000 after usage_limit` (invalid_transition). Usage_limit is not retryable.

#### 33. A non-retryable error: invalid request

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

*The reducer rejects:*
- after "the call is rejected": `retry.scheduled a1 attempt=2 delayMs=2000 after invalid_request` (invalid_transition). Invalid_request is not retryable.

#### 34. Malformed tool arguments

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
 12  tool.started a2/call_1 effect=read
 13  tool.settled a2/call_1 success "export const a = 1"
 14  step.ended a2 finish=tool_calls
 15  step.started a3 attempt=1
 16  text.ended a3 "a is 1."
 17  step.ended a3 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read error] · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3.

#### 35. Tool arguments cut off by the output limit

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
 12  tool.started a2/call_1 effect=write
 13  tool.settled a2/call_1 success "Wrote m.ts"
 14  step.ended a2 finish=tool_calls
 15  step.started a3 attempt=1
 16  text.ended a3 "Created m.ts."
 17  step.ended a3 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed · s1 synthetic · a2 completed [write success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

#### 36. An empty response: one nudge, then failure

The model finishes with no text, no reasoning and no tool call. The loop appends one nudge and asks again (retry rule 8). The second response is empty too, and the turn has done nothing, so the execution fails instead of nudging again. (A turn that has work in it ends differently: see the next scenario.)

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

#### 37. An empty response after the work: the turn ends as done

The model did what it was asked (a call of this turn has its result) and then finishes with nothing: no text, no call. It gets the one nudge, as always. When the answer to the nudge is empty too, that means the model has nothing to add, not that the turn failed: the second empty step is closed, and the turn ends as any turn ends, through the verification gate, as `execution.succeeded` with what the gate found (here no check is configured). The user is told once, by a `notice` of kind `no_closing_answer`, that the model gave no closing answer; the log shows the same thing as the nudge followed by an empty completed step. A turn with no work in it still fails on the second empty response (the scenario before this one).

*Provider:* step 1 asks for a tool; steps 2 and 3 each finish with stop and no output items.

```
-- the work, then an empty response, which is nudged
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"notes.md","content":"x\n"}
  8  tool.started a1/call_1 effect=write
  9  tool.settled a1/call_1 success "Wrote notes.md (1 line)."
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  step.ended a2 finish=stop
 13  synthetic.appended s1 origin=empty_response "Your last response was empty. Continue with the task, or ..."
-- the second one ends the turn through the gate
 14  step.started a3 attempt=1
 15  step.ended a3 finish=stop
 16  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [write success] · a2 completed · s1 synthetic · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, a3.

#### 38. The same call with the same arguments, again and again

The model reads the same file with the same arguments in three consecutive steps and gets the same result. The third identical call trips the guard (retry rule 9): it is refused before running, settled as `error` with a message, and the model moves on.

*Provider:* steps 1 to 3 each call read with `{"path":"a.ts"}`; step 4 answers.

```
-- two identical calls run
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"a.ts"}
 13  tool.started a2/call_1 effect=read
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

#### 39. The step limit is reached

After 3 steps that each asked for tools, the loop appends a note that tools are now disabled and makes one final call with tool choice `none`. Tool choice is not part of the cached prefix and is not stored, so only the note is durable. The final answer ends the turn.

*Provider:* steps 1 to 3 each finish with a read call; the final call (tool choice none) answers with stop.

```
-- the limit is reached
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"f1.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "file 1"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"f2.ts"}
 13  tool.started a2/call_1 effect=read
 14  tool.settled a2/call_1 success "file 2"
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 read {"path":"f3.ts"}
 18  tool.started a3/call_1 effect=read
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

### Refusal

#### 40. A content-policy refusal

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
 15  tool.started a2/call_1 effect=read
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

*The reducer rejects:*
- after "second turn, refused in its second step": `step.failed a3 provider:content_policy` (invalid_transition). A refusal is recorded as step.refused, so that it leaves model history.
- after "second turn, refused in its second step": `retry.scheduled a3 attempt=2 delayMs=2000 after content_policy` (invalid_transition). A refusal is never retried.

### Crash recovery

#### 41. The process dies while the model is streaming

One text item had ended and was durable; the next was streaming. The streamed deltas were never durable, so they are simply gone. Recovery closes the step as crashed (its completed text stays), tells the model the response was cut short, records the resume and runs a fresh step.

*Provider:* streams one complete text item, then deltas of a second; the process is killed; after restart the new step answers.

```
-- the process dies mid-stream
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Reading the test first."
-- at next start-up: the step is closed
  8  step.failed a1 crashed
-- the model is told and the resume is recorded
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

*The reducer rejects:*
- after "the process dies mid-stream": `execution.resumed exe_1` (invalid_transition). Recovery closes the crashed step before it records the resume.
- after "the process dies mid-stream": `step.failed a1 interrupted:user` (invalid_transition). Nobody requested an interrupt; a step cut off by a crash is closed as crashed.
- after "at next start-up: the step is closed": `execution.resumed exe_1` (invalid_transition). The interrupt marker follows a crashed step before anything else.
- after "at next start-up: the step is closed": `step.started a2 attempt=1` (invalid_transition). The model is told its response was cut short before the next step.

#### 42. The process dies while a read-only tool is running

A read had started. A read changes nothing, so recovery settles it as `error` with a note that it is safe to repeat; the model calls it again in the resumed step.

*Provider:* step 1 finishes with a read call; the process is killed while it runs; after restart the model reads again and answers.

```
-- the process dies while the read runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
-- at next start-up
  9  tool.settled a1/call_1 error "Cut short by a restart before it finished. Nothing was ch..."
 10  step.failed a1 crashed
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 12  execution.resumed exe_1
-- the loop carries on
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 read {"path":"a.ts"}
 15  tool.started a2/call_1 effect=read
 16  tool.settled a2/call_1 success "export const a = 1"
 17  step.ended a2 finish=tool_calls
 18  step.started a3 attempt=1
 19  text.ended a3 "a is 1."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed crashed [read error] · s1 synthetic · a2 completed [read success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

*The reducer rejects:*
- after "the process dies while the read runs": `tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."` (invalid_transition). A call that was started cannot be settled as not started.
- after "the process dies while the read runs": `tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."` (invalid_transition). The start recorded effect class read, so recovery knows nothing can have changed.

#### 43. The process dies while a side-effecting tool is running

A migration command had started and a second call was recorded but not yet started. Nobody knows whether the migration ran, so recovery settles it as `effect_unknown`; the pending call provably never ran and settles as `not_started`. In the resumed step the model checks the state before doing anything else.

*Provider:* step 1 finishes with a shell call and a read call; the shell starts, the process is killed; after restart the model inspects, then answers.

```
-- the process dies while the migration runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run migrate"}
  8  tool.called a1/call_2 read {"path":"schema.sql"}
  9  tool.started a1/call_1 effect=exec
-- at next start-up
 10  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 11  tool.settled a1/call_2 not_started "Not run: the response was stopped before this call starte..."
 12  step.failed a1 crashed
 13  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 14  execution.resumed exe_1
-- the model inspects before repeating
 15  step.started a2 attempt=1
 16  tool.called a2/call_1 shell {"command":"bun run migrate:status"}
 17  tool.started a2/call_1 effect=exec
 18  tool.settled a2/call_1 success "applied: 0007_add_index"
 19  step.ended a2 finish=tool_calls
 20  step.started a3 attempt=1
 21  text.ended a3 "The migration had already been applied."
 22  step.ended a3 finish=stop
 23  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed crashed [shell effect_unknown, read not_started] · s1 synthetic · a2 completed [shell success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

#### 44. The process dies while a tool runs that the next build no longer has

A `fetch` tool that talks to the network had started when the process died, and the build that starts next has no tool of that name (an upgrade renamed it). Its registry cannot say whether the call had a side effect, and recovery never asks it: the effect class was recorded with `tool.started`. A `network` call whose outcome nobody observed settles as `effect_unknown`, whatever the tool is called today.

*Provider:* step 1 finishes with one fetch call; the process is killed while it runs; the restarted build has no fetch tool.

```
-- the process dies while the request is in flight
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 fetch {"url":"https://example.com/releases","method":"POST"}
  8  tool.started a1/call_1 effect=network
-- at next start-up
  9  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 10  step.failed a1 crashed
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 12  execution.resumed exe_1
```

*UI:* u1 user · a1 failed crashed [fetch effect_unknown] · s1 synthetic. *Claim:* running, 1 crash resume(s).

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the process dies while the request is in flight": `tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."` (invalid_transition). The start is durable, so the request may have been sent.

#### 45. The process dies after a tool finished but before its result was written

The write completed on disk, but the process died before `tool.settled` was appended. The log is byte-for-byte the same as a crash while the tool was still running, so recovery must do the same thing: the result is lost and the outcome is `effect_unknown`. This is why the start is made durable before running, and why the model is asked to check rather than told it failed.

*Provider:* step 1 finishes with a write call; the write finishes; the process is killed before the result is recorded.

```
-- the write finished, its result was not written
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"a.ts","content":"export const a = 2"}
  8  tool.started a1/call_1 effect=write
-- at next start-up
  9  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 10  step.failed a1 crashed
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 12  execution.resumed exe_1
```

*UI:* u1 user · a1 failed crashed [write effect_unknown] · s1 synthetic. *Claim:* running, 1 crash resume(s).

*Model sees next:* u1, a1, s1.

#### 46. The process dies in the middle of a user cancel

The user pressed stop while a shell command was running. The cancel was made durable at once; the shell was sent SIGTERM and the process died before it had stopped. Without the durable request the log would look like an ordinary crash and the next start would carry on with work the user had stopped. With it, recovery finishes the cancel: the orphaned call is settled from its recorded effect class, the step closes as interrupted for `user`, the model is told, and the claim is released. Nothing is resumed.

*Provider:* step 1 finishes with a shell call; the user cancels while it runs; the process is killed during the shell's grace period.

```
-- the cancel is requested, then the process dies
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run migrate"}
  8  tool.started a1/call_1 effect=exec
  9  execution.interrupt_requested exe_1 user
-- at next start-up the cancel is finished
 10  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
-- the claim is released
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [shell effect_unknown] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the cancel is requested, then the process dies": `step.failed a1 crashed` (invalid_transition). The user's cancel is durable, so the step ends as interrupted, not as crashed.
- after "the cancel is requested, then the process dies": `execution.resumed exe_1` (invalid_transition). A cancelled execution is never resumed.
- after "the cancel is requested, then the process dies": `execution.failed exe_1 "crashed"` (invalid_transition). The execution ends as interrupted, which is what the user asked for.
- after "at next start-up the cancel is finished": `execution.resumed exe_1` (invalid_transition). Even with the step closed, the only way out is execution.interrupted for user.
- after "at next start-up the cancel is finished": `step.started a2 attempt=1` (invalid_transition). No work continues after a cancel.
- after "the claim is released": `execution.resumed exe_1` (not_found). The claim is gone; the session is idle until the user prompts again.

#### 47. The process dies between steps

The step ended and its results are durable; the next model call had not started. Nothing was lost, so recovery has nothing to settle, no step to close and nothing to tell the model: it records the resume and the loop continues with the next step.

*Provider:* step 1 finishes with a read call that succeeds; the process is killed before step 2; after restart step 2 answers.

```
-- the process dies at the boundary
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
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

#### 48. The process dies after the answer, before the claim was released

The last step ended with `stop` and nothing waits in the inbox, so the model is finished. Whether the execution may end as done is still the verification gate's decision, which recovery cannot make (it would have to run checks). So recovery resumes the execution like any other, and the loop, finding nothing left to do, goes through the gate and releases the claim. Here nothing is configured, so nothing is verified.

*Provider:* one step answers with stop; the process is killed before the claim is released; after restart the model is not called.

```
-- the answer is durable, the claim is not released
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Done."
  8  step.ended a1 finish=stop
-- at next start-up: the execution is resumed, not ended
  9  execution.resumed exe_1
-- the loop finds nothing left to do and ends it through the gate
 10  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

#### 49. The resume cap: the same execution crashes 4 times

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

#### 50. A graceful shutdown mid-step

The user quits the app while a test run is in progress. The shell is stopped the same way as on a cancel and reports its output so far; the step closes as interrupted for `shutdown`; the model is told; the claim is kept as suspended. While suspended nothing new can start or be delivered. At the next start the execution is resumed and the turn continues where it stopped.

*Provider:* step 1 finishes with a shell call; the process receives SIGTERM while it runs; after restart the model reruns the tests and answers.

```
-- the shutdown stops the step
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  tool.started a1/call_1 effect=exec
  9  execution.interrupt_requested exe_1 shutdown
 10  tool.settled a1/call_1 error "Stopped because the harness was shutting down. Output so ..."
 11  step.failed a1 interrupted:shutdown
 12  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
-- the claim is kept
 13  execution.interrupted exe_1 shutdown
 14  inbox.enqueued u2 steer "Are you there?"
-- the next start resumes the session
 15  execution.resumed exe_1
 16  inbox.delivered u2
 17  step.started a2 attempt=1
 18  tool.called a2/call_1 shell {"command":"bun test"}
 19  tool.started a2/call_1 effect=exec
 20  tool.settled a2/call_1 success "14 pass, 0 fail"
 21  step.ended a2 finish=tool_calls
 22  step.started a3 attempt=1
 23  text.ended a3 "Yes. All 14 tests pass."
 24  step.ended a3 finish=stop
 25  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed interrupted:shutdown [shell error] · s1 synthetic · u2 user · a2 completed [shell success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, u2, a2, a3.

*The reducer rejects:*
- after "the shutdown stops the step": `execution.interrupted exe_1 user` (invalid_transition). The step was interrupted for shutdown, so the execution must be too, keeping the claim.
- after "the claim is kept": `inbox.delivered u2` (invalid_transition). A suspended execution delivers nothing until it is resumed.
- after "the claim is kept": `execution.started exe_2` (invalid_transition). The suspended claim still belongs to exe_1.
- after "the claim is kept": `step.started a2 attempt=1` (invalid_transition). No step runs under a suspended claim.

#### 51. A graceful shutdown between steps

No step is open, so nothing needs closing and nothing was cut short: no marker, only the suspended claim. The next start resumes and runs the next step.

*Provider:* step 1 finishes with a read call that succeeds; SIGTERM arrives before step 2.

```
-- shutdown at the boundary
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
 11  execution.interrupt_requested exe_1 shutdown
 12  execution.interrupted exe_1 shutdown
-- the next start resumes
 13  execution.resumed exe_1
 14  step.started a2 attempt=1
 15  text.ended a2 "a is 1."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 52. Shutdown resumes do not use up the crash-resume cap

A long turn spans two clean restarts of the app, and then the process really crashes. The two resumes after a shutdown are not counted, so the crash is the first of the 3 the cap allows, and the turn is resumed. Only a resume that finds the claim still `running`, which means the previous process died, counts.

*Provider:* three steps that each call a tool; the app is quit and restarted twice between steps, then killed in the middle of the fourth step.

```
-- two clean restarts between steps
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
 11  execution.interrupt_requested exe_1 shutdown
 12  execution.interrupted exe_1 shutdown
 13  execution.resumed exe_1
 14  step.started a2 attempt=1
 15  tool.called a2/call_1 read {"path":"a.ts"}
 16  tool.started a2/call_1 effect=read
 17  tool.settled a2/call_1 success "export const a = 1"
 18  step.ended a2 finish=tool_calls
 19  execution.interrupt_requested exe_1 shutdown
 20  execution.interrupted exe_1 shutdown
 21  execution.resumed exe_1
-- the process is killed mid-step
 22  step.started a3 attempt=1
 23  text.ended a3 "Now the tests."
-- at next start-up the crash is the first one counted
 24  step.failed a3 crashed
 25  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 26  execution.resumed exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [read success] · a3 failed crashed · s1 synthetic. *Claim:* running, 1 crash resume(s).

*Model sees next:* u1, a1, a2, a3, s1.

#### 53. The process is killed while it is shutting down

The app is quit while a test run is in progress. The shutdown is made durable, the shell is asked to stop, and the process is killed before it has (a SIGKILL after the grace period). The log ends at the request. The next start does not treat this as a crash: it finishes the shutdown that was asked for, with the step interrupted for `shutdown` and the claim suspended, and then resumes as after any clean shutdown. The resume is not counted toward the crash-resume cap.

*Provider:* step 1 finishes with a shell call; SIGTERM arrives while it runs and SIGKILL follows before the command has stopped.

```
-- the shutdown is requested, then the process is killed
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  tool.started a1/call_1 effect=exec
  9  execution.interrupt_requested exe_1 shutdown
-- at next start-up the shutdown is finished, then the session resumes
 10  tool.settled a1/call_1 effect_unknown "Started, but the harness restarted before its result was ..."
 11  step.failed a1 interrupted:shutdown
 12  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 13  execution.interrupted exe_1 shutdown
 14  execution.resumed exe_1
```

*UI:* u1 user · a1 failed interrupted:shutdown [shell effect_unknown] · s1 synthetic. *Claim:* running.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the shutdown is requested, then the process is killed": `step.failed a1 crashed` (invalid_transition). The shutdown was requested, so the step ends as interrupted for shutdown.
- after "the shutdown is requested, then the process is killed": `execution.resumed exe_1` (invalid_transition). The requested shutdown is finished before anything resumes.

### Verification

#### 54. The checks pass

The model changes a file and says it is done. The harness records the workspace, runs the configured check and it passes, so the execution ends as done with the evidence. The check ran because `add.ts` differs between the snapshot the session started with and the one taken now.

*Provider:* step 1 calls write, step 2 answers; the `test` check exits 0.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- the model changes a file and says it is done
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
-- the harness runs the checks
 17  snapshot.taken w1 checks_start
 18  checks.started run=1 test
-- they pass, and the execution ends as done
 19  snapshot.taken w1 checks_end
 20  checks.finished run=1 test:passed
 21  execution.succeeded exe_1 verification=passed
```

*UI:* u1 user · a1 completed [write success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the model changes a file and says it is done": `checks.finished run=1 test:passed` (invalid_transition). A run of checks is started (durably) before it can have results.
- after "the harness runs the checks": `execution.succeeded exe_1` (invalid_transition). The execution cannot end while its checks are running.
- after "the harness runs the checks": `step.started a3 attempt=1` (invalid_transition). Nothing else happens until the run has its terminal event.

#### 55. The checks fail, the model fixes the code, and they pass

The model's first fix leaves the test failing. The run and its report are appended together: the report is an ordinary harness message at the end of history, so the next request extends the previous one. The model fixes the code, says it is done again, and the second run passes.

*Provider:* write, answer; the check exits 1; then write, answer; the check exits 0.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- the first run fails and the model is sent back
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
 17  snapshot.taken w1 checks_start
 18  checks.started run=1 test
 19  snapshot.taken w1 checks_end
 20  checks.finished run=1 test:failed
 21  synthetic.appended r1 origin=check_report "Checks run by the harness after your changes: 1 failed.\n\n..."
-- the model fixes the code and says it is done again
 22  step.started a3 attempt=1
 23  tool.called a3/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => a + b\n"}
 24  snapshot.taken w1 step_start a3
 25  tool.started a3/call_1 effect=write
 26  tool.settled a3/call_1 success "Wrote add.ts"
 27  snapshot.taken w2 step_end a3
 28  step.ended a3 finish=tool_calls
 29  step.started a4 attempt=1
 30  text.ended a4 "Now it adds."
 31  step.ended a4 finish=stop
-- the second run passes
 32  snapshot.taken w2 checks_start
 33  checks.started run=2 test
 34  snapshot.taken w2 checks_end
 35  checks.finished run=2 test:passed
 36  execution.succeeded exe_1 verification=passed
```

*UI:* u1 user · a1 completed [write success] · a2 completed · r1 synthetic · a3 completed [write success] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, r1, a3, a4.

*The reducer rejects:*
- after "the first run fails and the model is sent back": `execution.succeeded exe_1` (invalid_transition). The report is unanswered: the model has to act on it or say that it cannot.

#### 56. The checks still fail after the last allowed round

`verify.maxRounds` is 1 here: the model is sent back once. Its second attempt fails too, so the execution ends, as unresolved: the event names the failing check and the reason (`max_rounds`) and carries the evidence. The last report is appended in the same transaction so that whoever continues the session sees it; it is the one harness message that may stay unanswered.

*Provider:* write, answer; the check exits 1; write, answer; the check exits 1 again.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}],"verify":{"maxRounds":1}}`.

```
-- the first run fails and the model is sent back
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
 17  snapshot.taken w1 checks_start
 18  checks.started run=1 test
 19  snapshot.taken w1 checks_end
 20  checks.finished run=1 test:failed
 21  synthetic.appended r1 origin=check_report "Checks run by the harness after your changes: 1 failed.\n\n..."
-- the model tries again
 22  step.started a3 attempt=1
 23  tool.called a3/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => a + b\n"}
 24  snapshot.taken w1 step_start a3
 25  tool.started a3/call_1 effect=write
 26  tool.settled a3/call_1 success "Wrote add.ts"
 27  snapshot.taken w2 step_end a3
 28  step.ended a3 finish=tool_calls
 29  step.started a4 attempt=1
 30  text.ended a4 "Now it adds."
 31  step.ended a4 finish=stop
-- the second run fails too: the execution ends unresolved
 32  snapshot.taken w2 checks_start
 33  checks.started run=2 test
 34  snapshot.taken w2 checks_end
 35  checks.finished run=2 test:failed
 36  synthetic.appended r2 origin=check_report "Checks run by the harness after your changes: 1 failed.\n\n..."
 37  execution.succeeded exe_1 verification=unresolved max_rounds failing=test
```

*UI:* u1 user · a1 completed [write success] · a2 completed · r1 synthetic · a3 completed [write success] · a4 completed · r2 synthetic. *Claim:* released.

*Model sees next:* u1, a1, a2, r1, a3, a4, r2.

#### 57. The model reports that it cannot make the checks pass

After the report the model does not claim success: it calls `report_check_failure`, naming the check and the reason. That call is the acknowledgement; nothing is read out of its prose. The files did not change since the run, so the checks are not run again, and the execution ends as unresolved with what the model said.

*Provider:* write, answer; the check exits 1; the model calls report_check_failure and then answers.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- the run fails and the model is sent back
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
 17  snapshot.taken w1 checks_start
 18  checks.started run=1 test
 19  snapshot.taken w1 checks_end
 20  checks.finished run=1 test:failed
 21  synthetic.appended r1 origin=check_report "Checks run by the harness after your changes: 1 failed.\n\n..."
-- the model acknowledges the failure with the tool
 22  step.started a3 attempt=1
 23  tool.called a3/call_1 report_check_failure {"checks":["test"],"reason":"The test needs a fixture that is not in the repository."}
 24  tool.started a3/call_1 effect=read
 25  tool.settled a3/call_1 success "Recorded as unresolved: test."
 26  step.ended a3 finish=tool_calls
 27  step.started a4 attempt=1
 28  text.ended a4 "The test cannot pass without the fixture."
 29  step.ended a4 finish=stop
-- nothing changed since the run, so it stands: the execution ends unresolved
 30  snapshot.taken w1 checks_start
 31  execution.succeeded exe_1 verification=unresolved acknowledged failing=test
```

*UI:* u1 user · a1 completed [write success] · a2 completed · r1 synthetic · a3 completed [report_check_failure success] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, r1, a3, a4.

#### 58. No checks are configured

The project has no configuration file. The turn ends as done, and the event says that nothing was verified, so a client can tell this ending from one that rests on passing checks. The workspace is still recorded, so the turn can be undone.

*Provider:* step 1 calls write, step 2 answers.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; no configuration file.

```
-- the turn
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [write success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 59. Cancel while the checks run

The user cancels while the check command is running. The request is durable first; the command is stopped like a tool; the run is closed as interrupted, which says nothing about the code; the model is told and the claim is released. No result is recorded and nothing is reported.

*Provider:* write, answer; the check hangs until the user cancels.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- the checks are running
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
 17  snapshot.taken w1 checks_start
 18  checks.started run=1 test
-- the user cancels
 19  execution.interrupt_requested exe_1 user
-- the run is closed and the execution released
 20  checks.failed run=1 interrupted:user
 21  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 22  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 completed [write success] · a2 completed · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, a2, s1.

*The reducer rejects:*
- after "the user cancels": `checks.finished run=1 test:passed` (invalid_transition). Once an interrupt is requested the run can only be closed as interrupted.
- after "the user cancels": `execution.interrupted exe_1 user` (invalid_transition). The run of checks is closed before the execution is.

#### 60. The process dies while the checks run

`checks.started` was durable and the process died before any result. Recovery closes the run as crashed and resumes the execution (a crash counts toward the resume cap, so a check that kills the harness cannot be run for ever). The loop finds the model's answer still standing and no result for it, runs the checks again, and ends the execution on what they show.

*Provider:* write, answer; the process is killed while the check runs; after restart the check exits 0 and the model is not called.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- the process dies while the checks run
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote add.ts"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed add."
 16  step.ended a2 finish=stop
 17  snapshot.taken w1 checks_start
 18  checks.started run=1 test
-- at next start-up
 19  checks.failed run=1 crashed
 20  execution.resumed exe_1
-- the loop runs the checks again
 21  snapshot.taken w1 checks_start
 22  checks.started run=1 test
 23  snapshot.taken w1 checks_end
 24  checks.finished run=1 test:passed
 25  execution.succeeded exe_1 verification=passed
```

*UI:* u1 user · a1 completed [write success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the process dies while the checks run": `execution.resumed exe_1` (invalid_transition). Recovery closes the run before it records the resume.

#### 61. A queued message waits for the checks

The user queues a follow-up while the model works. "After this turn" means after the turn is done, and done is what the verification gate says, so the gate runs before the queued message is delivered, exactly as it would before the execution ends. The first run fails and the model is sent back, with the follow-up still waiting. When the checks pass, the turn ends with that evidence (`turn.ended`) and the queued message is delivered in the same append. A steer is different: it redirects the model and is delivered at once, with no checks in between. Had the turn ended unresolved (acknowledged, out of rounds, report mode), `turn.ended` would say so and the follow-up would be delivered all the same.

*Provider:* write, answer; the check exits 1; then write, answer; the check exits 0; then the answer to the queued message.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- the user queues a follow-up while the write runs; the model says it is done and the checks fail
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  inbox.enqueued u2 queue "Then add a test for negative numbers."
 12  tool.settled a1/call_1 success "Wrote add.ts"
 13  snapshot.taken w1 step_end a1
 14  step.ended a1 finish=tool_calls
 15  step.started a2 attempt=1
 16  text.ended a2 "Fixed add."
 17  step.ended a2 finish=stop
 18  snapshot.taken w1 checks_start
 19  checks.started run=1 test
 20  snapshot.taken w1 checks_end
 21  checks.finished run=1 test:failed
 22  synthetic.appended r1 origin=check_report "Checks run by the harness after your changes: 1 failed.\n\n..."
-- the model fixes the code, the checks pass, the turn ends and the follow-up is delivered
 23  step.started a3 attempt=1
 24  tool.called a3/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => a + b\n"}
 25  snapshot.taken w1 step_start a3
 26  tool.started a3/call_1 effect=write
 27  tool.settled a3/call_1 success "Wrote add.ts"
 28  snapshot.taken w2 step_end a3
 29  step.ended a3 finish=tool_calls
 30  step.started a4 attempt=1
 31  text.ended a4 "Now it adds."
 32  step.ended a4 finish=stop
 33  snapshot.taken w2 checks_start
 34  checks.started run=2 test
 35  snapshot.taken w2 checks_end
 36  checks.finished run=2 test:passed
 37  snapshot.taken w2 delivery
 38  turn.ended verification=passed
 39  inbox.delivered u2
-- the follow-up is answered; nothing changed since the checks passed
 40  step.started a5 attempt=1
 41  text.ended a5 "Added the test."
 42  step.ended a5 finish=stop
 43  snapshot.taken w2 checks_start
 44  execution.succeeded exe_1 verification=not_needed
```

*UI:* u1 user · a1 completed [write success] · a2 completed · r1 synthetic · a3 completed [write success] · a4 completed · u2 user · a5 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, r1, a3, a4, u2, a5.

*The reducer rejects:*
- after "the user queues a follow-up while the write runs; the model says it is done and the checks fail": `inbox.delivered u2` (invalid_transition). The turn has not ended: the checks failed and the model is sent back first.
- after "the user queues a follow-up while the write runs; the model says it is done and the checks fail": `turn.ended verification=passed` (invalid_transition). The report is unanswered, so the turn is not over.

#### 62. A question after a hand edit runs no check; the next turn that changes a file checks it all

The gate verifies a turn's own work. Between two turns the user edits a test by hand, then asks a question that the model answers without a tool. The workspace when that message was delivered (`delivery`) is the workspace when the turn ends, so the turn changed nothing and no check runs: the user is not shown `checks passed` for a turn that did nothing, and a hand edit that breaks a test does not send the model off to fix unfinished work it was not asked about. The edit is still unverified, and the ending says so (`not_needed` with `unverified`); the state checks are selected against does not move. The next turn changes a file, so the checks run, and they are selected from everything that is unverified: the evidence names the hand-edited file with the model's own.

*Provider:* turn 1 answers. Turn 2 (after the hand edit) answers. Turn 3 calls write, then answers; the `test` check exits 0.

*Setup:* snapshots on; the workspace holds add.ts, add.test.ts; configuration `{"checks":[{"name":"test","command":"bun test"}]}`.

```
-- a question: nothing changed, nothing to check
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  text.ended a1 "It subtracts, which looks like a bug."
  9  step.ended a1 finish=stop
 10  snapshot.taken w0 checks_start
 11  execution.succeeded exe_1 verification=not_needed
-- the user edits a test by hand, then asks again: the turn changed nothing, so no check runs, and the edit stays unverified
 12  inbox.enqueued u2 steer "Is the test right now?"
 13  execution.started exe_2
 14  snapshot.taken w1 delivery
 15  inbox.delivered u2
 16  step.started a2 attempt=1
 17  text.ended a2 "It expects 4 for 2 + 2, which is right."
 18  step.ended a2 finish=stop
 19  snapshot.taken w1 checks_start
 20  execution.succeeded exe_2 verification=not_needed
-- the next turn changes a file: the checks run on everything unverified, the hand edit included
 21  inbox.enqueued u3 steer "Fix add."
 22  execution.started exe_3
 23  snapshot.taken w1 delivery
 24  inbox.delivered u3
 25  step.started a3 attempt=1
 26  tool.called a3/call_1 write {"path":"add.ts","content":"export const add = (a: number, b: number) => a + b\n"}
 27  snapshot.taken w1 step_start a3
 28  tool.started a3/call_1 effect=write
 29  tool.settled a3/call_1 success "Wrote add.ts"
 30  snapshot.taken w2 step_end a3
 31  step.ended a3 finish=tool_calls
 32  step.started a4 attempt=1
 33  text.ended a4 "Now it adds."
 34  step.ended a4 finish=stop
 35  snapshot.taken w2 checks_start
 36  checks.started run=1 test
 37  snapshot.taken w2 checks_end
 38  checks.finished run=1 test:passed
 39  execution.succeeded exe_3 verification=passed
```

*UI:* u1 user · a1 completed · u2 user · a2 completed · u3 user · a3 completed [write success] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, a2, u3, a3, a4.

*The reducer rejects:*
- after "the user edits a test by hand, then asks again: the turn changed nothing, so no check runs, and the edit stays unverified": `checks.started run=1 test` (invalid_transition). No execution is running: checks run under a claim, when a turn that changed files would end.

### Revert

#### 63. Revert of the last turn

The user undoes the turn. The harness records the workspace as it is (so the revert itself can be undone), announces the restore, puts the files back as they were when the prompt was delivered, and records the restore together with the range that leaves history. The next request does not extend the previous one, which `history.reverted` allows.

*Provider:* one turn: write, answer. Then the user reverts it; the model is not called.

*Setup:* snapshots on; the workspace holds notes.md; no configuration file.

```
-- the turn
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"notes.md","content":"# Notes\n\n- reviewed\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote notes.md"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Added the line."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
-- the revert is announced
 18  snapshot.taken w1 restore_start
 19  revert.started fromSeq=6 target=w0 before=w1
-- the files are back and the turn has left history
 20  snapshot.taken w0 restore_end
 21  history.reverted fromSeq=6 restored=w0 changed=1
```

*UI:* u1 user excluded:reverted · a1 completed [write success] excluded:reverted · a2 completed excluded:reverted. *Claim:* released.

*Model sees next:* nothing.

*The reducer rejects:*
- after "the revert is announced": `execution.started exe_2` (invalid_transition). Nothing starts while a restore is in progress.
- after "the revert is announced": `history.reverted fromSeq=6 restored=w0 changed=1` (invalid_transition). The record must be of the restore that was announced, with its undo point.

#### 64. Revert, then undo the revert

The user reverts the turn and then changes their mind. Undoing the revert restores the workspace to the snapshot taken right before it and puts exactly the messages it excluded back into history. Only the latest revert can be undone, and only until new work starts.

*Provider:* one turn: write, answer. Then the user reverts it and undoes the revert; the model is not called.

*Setup:* snapshots on; the workspace holds notes.md; no configuration file.

```
-- the turn is reverted
1-6  opening: session.created, inbox.enqueued u1, execution.started exe_1, snapshot.taken w0 delivery, baseline.set, inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"notes.md","content":"# Notes\n\n- reviewed\n"}
  9  snapshot.taken w0 step_start a1
 10  tool.started a1/call_1 effect=write
 11  tool.settled a1/call_1 success "Wrote notes.md"
 12  snapshot.taken w1 step_end a1
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Added the line."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
 18  snapshot.taken w1 restore_start
 19  revert.started fromSeq=6 target=w0 before=w1
 20  snapshot.taken w0 restore_end
 21  history.reverted fromSeq=6 restored=w0 changed=1
-- the undo is announced
 22  snapshot.taken w0 restore_start
 23  revert.undo_started revertSeq=21 target=w1 before=w0
-- the files and the turn are back
 24  snapshot.taken w1 restore_end
 25  history.restored revertSeq=21 restored=w1 changed=1
```

*UI:* u1 user · a1 completed [write success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the turn is reverted": `revert.undo_started revertSeq=19 target=w1 before=w0` (invalid_transition). An undo names the revert it undoes by the seq of its history.reverted.
- after "the turn is reverted": `revert.undo_started revertSeq=21 target=w0 before=w0` (invalid_transition). The undo restores the snapshot taken before that revert.

### Compaction

#### 65. A compaction that is due waits for the next user message

The first turn grows the request past the early threshold. That is not urgent, so nothing happens between its steps: a compaction in the middle of a turn costs the model the thread of what it was doing. When the user's next message is delivered, the request is still over the threshold, and now is the moment: the loop compacts before it calls the model. The cut is right before the new message, so the checkpoint replaces the first turn and the message stays word for word. `compaction.started` records the cut, the mode and the prompt before the summary request is sent; `compaction.ended` freezes the checkpoint (the summary, the identifier index, the user's earlier messages verbatim). The baseline is set again, and the next request is the checkpoint, the new message and nothing else.

*Provider:* turn 1 is measured at 4,800 and 4,900 input tokens; the summary call returns a summary of the required form; turn 2 answers.

*Context window:* 10,000 tokens.

```
-- first turn: over the early threshold, and nothing is compacted in the middle of it
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
-- the next message is delivered: compact before the model is called
 15  inbox.enqueued u2 steer "Then fix it."
 16  execution.started exe_2
 17  inbox.delivered u2
 18  compaction.started c1 auto normal keepFromSeq=17
-- the checkpoint, the baseline again, and the answer
 19  compaction.ended c1 source=model
 20  baseline.set
 21  step.started a3 attempt=1
 22  text.ended a3 "Changed the expectation to 2."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [read success] · a2 completed · u2 user · c1 compaction · a3 completed. *Claim:* released.

*Model sees next:* c1, u2, a3.

*The reducer rejects:*
- after "the next message is delivered: compact before the model is called": `step.started a3 attempt=1` (invalid_transition). The compaction is open: no step starts until it has ended.
- after "the next message is delivered: compact before the model is called": `baseline.set` (invalid_transition). The baseline is set again only once the compaction has completed.

#### 66. A compaction in the middle of a long turn

One turn keeps reading files until the next request would be over the trigger. Waiting for a user message is no longer possible, so the loop compacts between two steps. The cut falls inside the turn: the last step, with its call and its result, is kept word for word, because the next model call answers it; the turn's request and its earlier steps go into the checkpoint, which quotes the request verbatim and ends by telling the model that the work was in progress and to carry on. The model continues the same turn from the checkpoint and the kept step.

*Provider:* the three reading steps are measured at 3,000, 4,000 and 6,000 input tokens; the summary call returns a summary; the model then answers.

*Context window:* 10,000 tokens.

```
-- three steps; after the third the next request is over the trigger
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"build.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "await bundle(entries)"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"bundle.ts"}
 13  tool.started a2/call_1 effect=read
 14  tool.settled a2/call_1 success "for (const entry of entries) await compile(entry)"
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 read {"path":"compile.ts"}
 18  tool.started a3/call_1 effect=read
 19  tool.settled a3/call_1 success "const cache = new Map()"
 20  step.ended a3 finish=tool_calls
-- compact between two steps, keeping the last one
 21  compaction.started c1 auto normal keepFromSeq=16
 22  compaction.ended c1 source=model
 23  baseline.set
-- the turn carries on
 24  step.started a4 attempt=1
 25  text.ended a4 "Every entry is compiled one after the other, and the cach..."
 26  step.ended a4 finish=stop
 27  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [read success] · a3 completed [read success] · c1 compaction · a4 completed. *Claim:* released.

*Model sees next:* c1, a3, a4.

*The reducer rejects:*
- after "compact between two steps, keeping the last one": `compaction.started c2 auto normal keepFromSeq=15` (invalid_range). The cut only moves forward: a later compaction cannot keep what this one replaced.

#### 67. The provider rejects a request as too large: compact aggressively and rebuild

Nobody told the engine the model's context window, so nothing was compacted ahead of time, and in the second turn the provider rejects the request. That is a fact, not an estimate: the loop compacts aggressively (trigger `overflow`) and rebuilds the request (retry rule 5). A compaction can start only at a boundary, so the rejected attempt is first closed as failed, with an empty body, and stays in the log. An aggressive compaction keeps only what fits a small budget, and here nothing does: the new prompt itself goes into the checkpoint, quoted verbatim, with the sentence that the work continues. A second rejection right after this compaction fails the execution.

*Provider:* turn 2, attempt 1 fails with context_overflow before output; the summary call returns a summary; the rebuilt call answers.

```
-- the second turn's request is rejected
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "A long explanation."
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
 10  inbox.enqueued u2 steer "Now explain the reducer."
 11  execution.started exe_2
 12  inbox.delivered u2
 13  step.started a2 attempt=1
 14  step.failed a2 provider:context_overflow
-- compact aggressively, then rebuild
 15  compaction.started c1 overflow aggressive keepFromSeq=13
 16  compaction.ended c1 source=model
 17  baseline.set
 18  step.started a3 attempt=1
 19  text.ended a3 "The reducer folds events."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · u2 user · a2 failed provider:context_overflow · c1 compaction · a3 completed. *Claim:* released.

*Model sees next:* c1, a2, a3.

#### 68. A compaction that frees too little: the hold, one aggressive attempt, then nothing more

The request is over the trigger and the loop compacts, but what must be kept is most of the context: the provider measures the first request after the compaction at almost the size before it. Compacting again at once would summarise a summary, so the policy holds: while the request still fits, the next steps are sent without a compaction, in the headroom between the trigger and the window. When a request would no longer fit at all, there is one aggressive compaction, which keeps nothing word for word. Here that frees too little as well, and nothing more is tried: the request is sent as it is. (Had the provider rejected it, the overflow rule would have ended the execution.) The loop never compacts in a circle.

*Provider:* the first step is measured at 6,000 input tokens; the step after the first compaction at 5,900, so it freed too little; the next at 7,500, which with the next result no longer fits; the step after the aggressive compaction again at 7,500; then the model answers.

*Context window:* 10,000 tokens.

```
-- over the trigger: a normal compaction, which keeps the last step
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"migrations/0001.sql"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "CREATE TABLE ledger (id INTEGER)"
 10  step.ended a1 finish=tool_calls
 11  compaction.started c1 auto normal keepFromSeq=6
 12  compaction.ended c1 source=model
 13  baseline.set
-- it freed too little: the next two requests are over the trigger and are sent anyway (the hold)
 14  step.started a2 attempt=1
 15  tool.called a2/call_1 read {"path":"migrations/0002.sql"}
 16  tool.started a2/call_1 effect=read
 17  tool.settled a2/call_1 success "ALTER TABLE ledger ADD COLUMN total"
 18  step.ended a2 finish=tool_calls
 19  step.started a3 attempt=1
 20  tool.called a3/call_1 read {"path":"migrations/0003.sql"}
 21  tool.started a3/call_1 effect=read
 22  tool.settled a3/call_1 success "CREATE INDEX ledger_total"
 23  step.ended a3 finish=tool_calls
-- the next request would not fit: one aggressive compaction, which keeps nothing
 24  compaction.started c2 auto aggressive keepFromSeq=24
 25  compaction.ended c2 source=model
 26  baseline.set
-- that freed too little too: the request is sent as it is
 27  step.started a4 attempt=1
 28  tool.called a4/call_1 read {"path":"migrations/0004.sql"}
 29  tool.started a4/call_1 effect=read
 30  tool.settled a4/call_1 success "DROP INDEX ledger_total"
 31  step.ended a4 finish=tool_calls
 32  step.started a5 attempt=1
 33  text.ended a5 "Four migrations; the last one drops the index the third o..."
 34  step.ended a5 finish=stop
 35  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · c1 compaction · a2 completed [read success] · a3 completed [read success] · c2 compaction · a4 completed [read success] · a5 completed. *Claim:* released.

*Model sees next:* c2, a4, a5.

#### 69. An invalid summary is repaired

The model's answer to the summary request does not have the required sections. The loop asks once more: it records the rejected answer and what is wrong with it (`compaction.repair_requested`), and the second request is the first one plus that answer and the request to fix it, so it still reads everything before it from the cache and can be rebuilt from the log. The second answer is valid, and the compaction ends with `source: repaired`.

*Provider:* the first step is measured at 6,000 input tokens; the summary call returns prose without the sections; the repair call returns a summary of the required form; the model then answers.

*Context window:* 10,000 tokens.

```
-- the first answer is not a summary
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  compaction.started c1 auto normal keepFromSeq=6
-- one repair is asked for
 12  compaction.repair_requested c1 attempt=2 "The user asked for a fix and some files were read."
-- the repaired summary is used
 13  compaction.ended c1 source=repaired
 14  baseline.set
 15  step.started a2 attempt=1
 16  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 17  step.ended a2 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · c1 compaction · a2 completed. *Claim:* released.

*Model sees next:* c1, a1, a2.

*The reducer rejects:*
- after "the first answer is not a summary": `compaction.ended c1 source=repaired` (invalid_transition). A compaction ends as repaired only after a repair was asked for.
- after "one repair is asked for": `compaction.repair_requested c1 attempt=3 "The user asked for a fix and some files were read."` (invalid_transition). A summary is repaired at most once.

#### 70. A summary that is still invalid: the checkpoint is built without the model

The answer to the repair request is not usable either. The loop does not ask a third time and does not give up: it builds the checkpoint without a summary. It says plainly that there is none, and carries what needs no model: the identifier index, the user's messages verbatim, the assistant's last words, and the pointer to the history tools, with which the model can read the original messages. `compaction.ended` says `source: fallback` and why, so a client can tell the user. A compaction therefore always completes, and the session is never lost to a model that cannot summarise.

*Provider:* the first step is measured at 6,000 input tokens; the summary call and the repair call both return prose without the sections; the model then answers.

*Context window:* 10,000 tokens.

```
-- the first answer and the repair are both unusable
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  compaction.started c1 auto normal keepFromSeq=6
 12  compaction.repair_requested c1 attempt=2 "The user asked for a fix and some files were read."
-- the compaction completes without a summary
 13  compaction.ended c1 source=fallback (the model's summary was unusable, also after it was asked to fix it...)
 14  baseline.set
 15  step.started a2 attempt=1
 16  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 17  step.ended a2 finish=stop
 18  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · c1 compaction · a2 completed. *Claim:* released.

*Model sees next:* c1, a1, a2.

#### 71. Cancel while the summary is being written

The user cancels while the summary call is streaming. The compaction is closed as interrupted, the marker tells the model that it was stopped, and the claim is released. Nothing about history changed: a compaction that did not complete is only a row in the log. When the user sends the next message the request is as large as before, so the loop compacts again, now at a user-message boundary: the cut cannot fall between the marker and the step it follows, so that step, the marker and the new message are kept.

*Provider:* the first step is measured at 6,000 input tokens; the summary call streams part of a summary and hangs; after the cancel, the second summary call returns a summary and the model answers.

*Context window:* 10,000 tokens.

```
-- the user cancels during the summary call
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  compaction.started c1 auto normal keepFromSeq=6
 12  execution.interrupt_requested exe_1 user
 13  compaction.failed c1 interrupted:user
 14  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 15  execution.interrupted exe_1 user
-- the next message: the compaction is made again
 16  inbox.enqueued u2 steer "Go on."
 17  execution.started exe_2
 18  inbox.delivered u2
 19  compaction.started c2 auto normal keepFromSeq=6
 20  compaction.ended c2 source=model
 21  baseline.set
 22  step.started a2 attempt=1
 23  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 24  step.ended a2 finish=stop
 25  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [read success] · c1 compaction · s1 synthetic · u2 user · c2 compaction · a2 completed. *Claim:* released.

*Model sees next:* c2, a1, s1, u2, a2.

#### 72. The process dies during a compaction

The process dies after `compaction.started` and before the summary arrived. At the next start, recovery closes the compaction as crashed and takes the execution up again (which counts as a crash resume). No step was cut short, so there is no marker. History is what it was, the loop decides again from stored state, finds the request as large as before and compacts again, under a new compaction message.

*Provider:* the first step is measured at 6,000 input tokens; the process dies before the summary call returns; after the restart the summary call returns a summary and the model answers.

*Context window:* 10,000 tokens.

```
-- the process dies with the compaction open
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  compaction.started c1 auto normal keepFromSeq=6
-- at the next start: recovery closes it, and the loop compacts again
 12  compaction.failed c1 crashed
 13  execution.resumed exe_1
 14  compaction.started c2 auto normal keepFromSeq=6
 15  compaction.ended c2 source=model
 16  baseline.set
 17  step.started a2 attempt=1
 18  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 19  step.ended a2 finish=stop
 20  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · c1 compaction · c2 compaction · a2 completed. *Claim:* released.

*Model sees next:* c2, a1, a2.

#### 73. The model's task list survives a compaction

The model keeps a task list with the `todo` tool: every call sends the whole list, and the current list is whatever the latest successful call in the log says. The tool keeps no state and changes nothing in the workspace (its effect class is `read`), so the call takes no snapshot and asks nobody. When the conversation is compacted, the call that set the list is among what the checkpoint replaces, and the model would no longer see its own list. So the checkpoint carries it: after the summary, the list as that call left it, one item per line. It is frozen in `compaction.ended` with the rest of the checkpoint. A client that folds the log still finds the list in the call's `display`.

*Provider:* turn 1: a step that sets a three-item list (measured at 4,800 input tokens), then a step that answers (4,900); the summary call returns a summary; turn 2 answers.

*Context window:* 10,000 tokens.

*Engine:* offers the real `todo` tool.

```
-- the model sets its list and answers; the request is over the early threshold
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 todo {"todos":[{"text":"Read the failing test","status":"done"},{"text":"Fix the expectation","status":"in_progress"},{"text":"Run the tests","status":"pending"}]}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "Task list updated: 1 done, 1 in progress, 1 pending.\nNow:..."
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  text.ended a2 "The expectation is wrong; fixing it is next."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
-- the next message: the compaction's checkpoint carries the list, and the model goes on from it
 15  inbox.enqueued u2 steer "Go on."
 16  execution.started exe_2
 17  inbox.delivered u2
 18  compaction.started c1 auto normal keepFromSeq=17
 19  compaction.ended c1 source=model
 20  baseline.set
 21  step.started a3 attempt=1
 22  text.ended a3 "Fixed the expectation; running the tests is next."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [todo success] · a2 completed · u2 user · c1 compaction · a3 completed. *Claim:* released.

*Model sees next:* c1, u2, a3.

#### 74. The user asks for a compaction while the session is idle

The request is far below the thresholds, so nothing would be compacted by itself; the user asks for it (`/compact`). A compaction changes history, and history changes under a claim: the session takes one for this alone. `compaction.started` records `manual` as the trigger, and from there it is the compaction of every other scenario: the same summary request, the same repair and fallback, the same checkpoint. It keeps word for word only what the next request has to answer (here the model's last answer) and a short recent tail. Then the execution ends, with no step and no check: there was no turn, so nothing of a turn's to verify. The baseline is set again when the next turn is about to send a step. Asked again right away, the engine answers that there is nothing to compact and writes nothing; asked while a turn runs, the same compaction is made at the boundary after the step in progress.

*Provider:* the turn is measured at 3,000 and 3,200 input tokens; the summary call returns a summary; the next turn answers.

*Context window:* 10,000 tokens.

```
-- a turn, far below the thresholds
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
-- the user asks: a claim of its own, the compaction, and the claim is released
 15  execution.started exe_2
 16  compaction.started c1 manual normal keepFromSeq=11
 17  compaction.ended c1 source=model
 18  execution.succeeded exe_2
-- the next turn: the baseline is set again, and the request is the checkpoint, the kept answer and the new message
 19  inbox.enqueued u2 steer "Then fix it."
 20  execution.started exe_3
 21  baseline.set
 22  inbox.delivered u2
 23  step.started a3 attempt=1
 24  text.ended a3 "Changed the expectation to 2."
 25  step.ended a3 finish=stop
 26  execution.succeeded exe_3
```

*UI:* u1 user · a1 completed [read success] · a2 completed · c1 compaction · u2 user · a3 completed. *Claim:* released.

*Model sees next:* c1, a2, u2, a3.

*The reducer rejects:*
- after "the user asks: a claim of its own, the compaction, and the claim is released": `compaction.started c2 manual normal keepFromSeq=11` (invalid_transition). No execution is running: a compaction is written under a claim.

#### 75. Old images are retired at a compaction, and at no other time

A tool result may carry an image (the `read` tool on an image file, an MCP result), and it is sent again with every later request. An image that was sent is never dropped by itself: the block that holds it would change, and the provider's prompt cache would be lost for everything after it. So images are retired where the prefix is rebuilt anyway. Here one turn reads four screenshots and the next request is over the trigger. The compaction keeps the last three steps word for word. The first step is before the cut: nothing of it is sent any more, and the checkpoint lists its image (the file, its type and size) with the sentence that reading the file again shows it again. Of the kept results, the last step's image stays, because the model has not been shown it yet, and so does the one before it (the two most recent stay); the oldest kept result keeps its stored text and loses its image, and one line is appended that says so and how to see it again. `compaction.ended` records that (`retired`: the result, how many images, the line, frozen), and every request from then on is built from the record: the turn's answer and the next turn extend the request after the compaction block for block.

*Provider:* the four reading steps are measured at 9,000, 12,000, 15,000 and 25,000 input tokens, and each result carries an image; the summary call returns a summary; the model then answers, and answers the next message.

*Context window:* 32,000 tokens.

```
-- four steps, each with an image in its result; after the fourth the next request is over the trigger
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"one.png"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "one.png: PNG image (image/png), 640x480 pixels, 11 bytes,..."
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"two.png"}
 13  tool.started a2/call_1 effect=read
 14  tool.settled a2/call_1 success "two.png: PNG image (image/png), 640x480 pixels, 11 bytes,..."
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 read {"path":"three.png"}
 18  tool.started a3/call_1 effect=read
 19  tool.settled a3/call_1 success "three.png: PNG image (image/png), 640x480 pixels, 13 byte..."
 20  step.ended a3 finish=tool_calls
 21  step.started a4 attempt=1
 22  tool.called a4/call_1 read {"path":"four.png"}
 23  tool.started a4/call_1 effect=read
 24  tool.settled a4/call_1 success "four.png: PNG image (image/png), 640x480 pixels, 12 bytes..."
 25  step.ended a4 finish=tool_calls
-- compact between two steps: three steps are kept, and the oldest of them loses its image
 26  compaction.started c1 auto normal keepFromSeq=11
 27  compaction.ended c1 source=model
 28  baseline.set
-- the turn carries on, and so does the next one: nothing about the images changes between compactions
 29  step.started a5 attempt=1
 30  text.ended a5 "The second and the third differ in the header; the fourth..."
 31  step.ended a5 finish=stop
 32  execution.succeeded exe_1
 33  inbox.enqueued u2 steer "Which one has the dialog?"
 34  execution.started exe_2
 35  inbox.delivered u2
 36  step.started a6 attempt=1
 37  text.ended a6 "four.png."
 38  step.ended a6 finish=stop
 39  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [read success] · a2 completed [read success] · a3 completed [read success] · a4 completed [read success] · c1 compaction · a5 completed · u2 user · a6 completed. *Claim:* released.

*Model sees next:* c1, a2, a3, a4, a5, u2, a6.

#### 76. What a compaction may not record about images

The record of retired images is what every later request is built from, so the reducer accepts only what can be rendered: a result among the messages the compaction keeps, that is settled and carries exactly the number of images the record says, named once. A result before the cut is not sent at all and has nothing to retire; a result without an image has nothing to lose.

*Provider:* as in the scenario before: four reading steps with an image each, then the summary call.

*Context window:* 32,000 tokens.

```
-- the compaction is open, with the cut before the second step
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"one.png"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "one.png: PNG image (image/png), 640x480 pixels, 11 bytes,..."
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 read {"path":"two.png"}
 13  tool.started a2/call_1 effect=read
 14  tool.settled a2/call_1 success "two.png: PNG image (image/png), 640x480 pixels, 11 bytes,..."
 15  step.ended a2 finish=tool_calls
 16  step.started a3 attempt=1
 17  tool.called a3/call_1 read {"path":"three.png"}
 18  tool.started a3/call_1 effect=read
 19  tool.settled a3/call_1 success "three.png: PNG image (image/png), 640x480 pixels, 13 byte..."
 20  step.ended a3 finish=tool_calls
 21  step.started a4 attempt=1
 22  tool.called a4/call_1 read {"path":"four.png"}
 23  tool.started a4/call_1 effect=read
 24  tool.settled a4/call_1 success "four.png: PNG image (image/png), 640x480 pixels, 12 bytes..."
 25  step.ended a4 finish=tool_calls
 26  compaction.started c1 auto normal keepFromSeq=11
-- the compaction ends with a record the reducer accepts, and the turn carries on
 27  compaction.ended c1 source=model
 28  baseline.set
 29  step.started a5 attempt=1
 30  text.ended a5 "The fourth has the dialog open."
 31  step.ended a5 finish=stop
 32  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [read success] · a3 completed [read success] · a4 completed [read success] · c1 compaction · a5 completed. *Claim:* released.

*Model sees next:* c1, a2, a3, a4, a5.

*The reducer rejects:*
- after "the compaction is open, with the cut before the second step": `compaction.ended c1 source=model` (invalid_transition). The first step is before the cut: it is not sent any more, so nothing of it is retired.
- after "the compaction is open, with the cut before the second step": `compaction.ended c1 source=model` (invalid_transition). The result carries one image, not two.
- after "the compaction is open, with the cut before the second step": `compaction.ended c1 source=model` (invalid_transition). A result is retired once.
- after "the compaction is open, with the cut before the second step": `compaction.ended c1 source=model` (invalid_transition). Only a step has results.

### Approval and the sandbox

#### 77. Auto mode: an edit runs and a command runs in the sandbox

The default. An edit inside the workspace runs as it is and a command runs in the sandbox (no network, writes only in the workspace and the temp directory), and nobody is asked. `tool.started` records what each ran under: the mode, the path facts the decision was made from, and for the command that it was sandboxed and with what. The command is decided and started only once the edit before it has its result: what can change something runs one at a time, in the order the model wrote it.

*Provider:* asks for a write and a command in one response, then answers.

*Approval:* mode auto; the sandbox is available; nobody is present (unattended: deny).

```
-- the edit runs, then the command, sandboxed
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
  8  tool.called a1/call_2 shell {"command":"bun test"}
  9  tool.started a1/call_1 effect=write mode=auto a.test.ts:workspace
 10  tool.settled a1/call_1 success "written"
 11  tool.started a1/call_2 effect=exec mode=auto sandboxed
 12  tool.settled a1/call_2 success "1 pass"
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "Fixed: the test passes."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [write success, shell success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 78. A command needs the network: the hint, the request, one approval, taint, and the next request asks again

A sandboxed command fails because it has no network, and its result ends with the note that says how to ask. The model runs it again with `sandbox: { network: true }`: the harness never widens the sandbox on its own, and never guesses from the error. The user is asked, allows it once, and the command runs in the sandbox with the network on. Its output is now content from outside, so the session is tainted and the user is told, once. The next request for the network asks again, and the question says why earlier approvals no longer count.

*Provider:* runs curl, runs it again asking for the network, asks for the network once more, then answers.

*Approval:* mode auto; the sandbox is available; a person is present.

```
-- the command fails in the sandbox and the result carries the hint
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"curl -s https://example.com/notes"}
  8  tool.started a1/call_1 effect=exec mode=auto sandboxed
  9  tool.settled a1/call_1 error "curl: (6) Could not resolve host: example.com\n[Exit code ..."
 10  step.ended a1 finish=tool_calls
-- the model asks for the network and the user is asked
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 shell {"command":"curl -s https://example.com/notes","sandbox":{"network":true}}
 13  approval.requested a2/call_1 "Allow network access for this command?" choices=once,session,deny
-- the user allows it once: it runs with the network, and the session is tainted
 14  approval.answered a2/call_1 once
 15  tool.started a2/call_1 effect=exec mode=auto sandboxed+network
 16  tool.settled a2/call_1 success "v2.1: faster installs"
 17  taint.noticed network-command from shell at seq 16
 18  step.ended a2 finish=tool_calls
-- the next request for the network asks again, and this time the user says no
 19  step.started a3 attempt=1
 20  tool.called a3/call_1 shell {"command":"curl -s https://example.com/next","sandbox":{"network":true}}
 21  approval.requested a3/call_1 "Allow network access for this command?" choices=once,session,deny
 22  approval.answered a3/call_1 deny
 23  tool.settled a3/call_1 error "Not run: the user declined this call."
 24  step.ended a3 finish=tool_calls
 25  step.started a4 attempt=1
 26  text.ended a4 "The notes say installs are faster."
 27  step.ended a4 finish=stop
 28  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell error] · a2 completed [shell success] · a3 completed [shell error] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3, a4.

*The reducer rejects:*
- after "the model asks for the network and the user is asked": `tool.started a2/call_1 effect=exec mode=auto sandboxed+network` (invalid_transition). A call the user was asked about starts only once they approved.
- after "the model asks for the network and the user is asked": `approval.requested a2/call_1 "Allow network access for this command?" choices=once,session,deny` (invalid_transition). A call is asked about once.
- after "the model asks for the network and the user is asked": `approval.answered a2/call_1 session remembers=session:exec-sandboxed` (invalid_transition). An answer records exactly what the chosen choice of the question remembers.
- after "the user allows it once: it runs with the network, and the session is tainted": `taint.noticed network-command from shell at seq 16` (invalid_transition). The user is told once that the session is tainted.
- after "the user allows it once: it runs with the network, and the session is tainted": `approval.answered a2/call_1 once` (invalid_transition). A question is answered once.

#### 79. Ask mode: a read runs, an edit and a command each ask

In `ask` a read runs and everything else is asked about first: the edit, with the real path it would write, and the command, which still runs in the sandbox once approved. Each question is durable before it is put, with its choices and what each would remember, and the answer is recorded before the call starts.

*Provider:* reads the test, writes it, runs the tests, then answers.

*Approval:* mode ask; the sandbox is available; a person is present.

```
-- the read runs without a question
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
  8  tool.started a1/call_1 effect=read mode=ask a.test.ts:workspace
  9  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 10  step.ended a1 finish=tool_calls
-- the edit asks and is allowed once
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
 13  approval.requested a2/call_1 "Allow write: writing /repo/a.test.ts?" choices=once,session,project,deny
 14  approval.answered a2/call_1 once
 15  tool.started a2/call_1 effect=write mode=ask a.test.ts:workspace
 16  tool.settled a2/call_1 success "written"
 17  step.ended a2 finish=tool_calls
-- the command asks and runs in the sandbox
 18  step.started a3 attempt=1
 19  tool.called a3/call_1 shell {"command":"bun test"}
 20  approval.requested a3/call_1 "Run this command in the sandbox?" choices=once,session,deny
 21  approval.answered a3/call_1 once
 22  tool.started a3/call_1 effect=exec mode=ask sandboxed
 23  tool.settled a3/call_1 success "1 pass"
 24  step.ended a3 finish=tool_calls
 25  step.started a4 attempt=1
 26  text.ended a4 "Fixed: the test passes."
 27  step.ended a4 finish=stop
 28  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [write success] · a3 completed [shell success] · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3, a4.

#### 80. A call the policy refuses

The model tries to write into a credential store. No mode but `full` allows that and nobody is asked: the call is refused, and the refusal (with the real path, links followed) is the call's result. The denial and the result are one append, so a log never holds a denied call without what the model was told.

*Provider:* asks to write ~/.ssh/authorized_keys, then answers.

*Approval:* mode auto; the sandbox is available; nobody is present (unattended: deny).

```
-- the write is refused
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"~/.ssh/authorized_keys","content":"ssh-ed25519 AAAA"}
  8  approval.denied a1/call_1 policy
  9  tool.settled a1/call_1 error "Not run: write may not write /home/user/.ssh/authorized_k..."
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  text.ended a2 "I cannot change that file."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [write error] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 81. Nobody present: a call that would ask is refused and the run goes on

A one-shot run, `--json`, an eval: nobody can answer. A call that would ask is refused at once with what it needed, the model is told, and the run goes on. Nothing waits, and no setting turns the question into a yes.

*Provider:* asks for the network on a command, then answers.

*Approval:* mode auto; the sandbox is available; nobody is present (unattended: deny).

```
-- the call is refused with the reason
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"curl -s https://example.com/notes","sandbox":{"network":true}}
  8  approval.denied a1/call_1 unattended needs=sandbox-network
  9  tool.settled a1/call_1 error "Not run: this call needs the user's approval for network ..."
 10  step.ended a1 finish=tool_calls
 11  step.started a2 attempt=1
 12  text.ended a2 "I could not reach example.com: this run has no network."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell error] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 82. Nobody present, and the run ends with the refusal

With the unattended behaviour `stop` a refusal for lack of an answer ends the run, for a run in which a refusal would hide a problem. The call is refused, what had not started does not start, the step closes and the execution ends with the cause `approval`, in one append.

*Provider:* asks for the network on a command and for a write in one response.

*Approval:* mode auto; the sandbox is available; nobody is present (unattended: stop).

```
-- the command is refused, the write behind it never starts, and the run ends
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"curl -s https://example.com/notes","sandbox":{"network":true}}
  8  tool.called a1/call_2 write {"path":"notes.md","content":"notes"}
  9  approval.denied a1/call_1 unattended needs=sandbox-network stop
 10  tool.settled a1/call_1 error "Not run: this call needs the user's approval for network ..."
 11  tool.settled a1/call_2 not_started "Not run: the response was stopped before this call starte..."
 12  step.ended a1 finish=tool_calls
 13  execution.failed exe_1 cause=approval "Stopped: a tool call needed your approval and nobody was ..."
```

*UI:* u1 user · a1 completed [shell error, write not_started]. *Claim:* released.

*Model sees next:* u1, a1.

#### 83. An approval remembered for the session, then used

The user allows commands in the sandbox for the rest of the session. What is remembered is that capability, never the command: the answer records it, stamped with its own position in the log, and the next command, a different one, runs on it without a question.

*Provider:* runs the tests, runs the linter, then answers.

*Approval:* mode ask; the sandbox is available; a person is present.

```
-- the first command asks and the user allows commands for the session
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  approval.requested a1/call_1 "Run this command in the sandbox?" choices=once,session,deny
  9  approval.answered a1/call_1 session remembers=session:exec-sandboxed
 10  tool.started a1/call_1 effect=exec mode=ask sandboxed
 11  tool.settled a1/call_1 success "1 pass"
 12  step.ended a1 finish=tool_calls
-- the next command runs on what was remembered
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 shell {"command":"bun run lint"}
 15  tool.started a2/call_1 effect=exec mode=ask sandboxed
 16  tool.settled a2/call_1 success "clean"
 17  step.ended a2 finish=tool_calls
 18  step.started a3 attempt=1
 19  text.ended a3 "The tests pass and the linter is clean."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell success] · a2 completed [shell success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3.

#### 84. A pending question is interrupted

While the question waits the turn is not stuck: the user can stop it. The interrupt withdraws the question, and the call settles as not started, like every call an interrupt reaches before it began. An answer that arrives afterwards is not taken.

*Provider:* asks for the network on a command.

*Approval:* mode auto; the sandbox is available; a person is present.

```
-- the user is asked
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"curl -s https://example.com/notes","sandbox":{"network":true}}
  8  approval.requested a1/call_1 "Allow network access for this command?" choices=once,session,deny
-- the user stops the turn instead of answering
  9  execution.interrupt_requested exe_1 user
-- the call never started, and the execution ends as interrupted
 10  tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."
 11  step.failed a1 interrupted:user
 12  synthetic.appended s1 origin=interrupt "The user stopped the previous response before it finished."
 13  execution.interrupted exe_1 user
```

*UI:* u1 user · a1 failed interrupted:user [shell not_started] · s1 synthetic. *Claim:* released.

*Model sees next:* u1, a1, s1.

*The reducer rejects:*
- after "the user stops the turn instead of answering": `approval.answered a1/call_1 once` (invalid_transition). Once an interrupt is requested the execution only winds down: the question is withdrawn.

#### 85. A crash with a pending question

The process dies while a question waits. The call is pending in the log: it was asked about and never started. Recovery settles it as not started and closes the step as crashed, like any step a process died in. The model asks again, and so the user is asked again: an answer nobody recorded was never given.

*Provider:* asks for the network on a command; after the restart asks again, then answers.

*Approval:* mode auto; the sandbox is available; a person is present.

```
-- the user is asked, and the process dies
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"curl -s https://example.com/notes","sandbox":{"network":true}}
  8  approval.requested a1/call_1 "Allow network access for this command?" choices=once,session,deny
-- at the next start-up the call is settled as not started and the claim resumed
  9  tool.settled a1/call_1 not_started "Not run: the response was stopped before this call starte..."
 10  step.failed a1 crashed
 11  synthetic.appended s1 origin=interrupt "The previous response was cut short when the harness rest..."
 12  execution.resumed exe_1
-- the model asks again, the user is asked again and allows it
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 shell {"command":"curl -s https://example.com/notes","sandbox":{"network":true}}
 15  approval.requested a2/call_1 "Allow network access for this command?" choices=once,session,deny
 16  approval.answered a2/call_1 once
 17  tool.started a2/call_1 effect=exec mode=auto sandboxed+network
 18  tool.settled a2/call_1 success "v2.1: faster installs"
 19  taint.noticed network-command from shell at seq 18
 20  step.ended a2 finish=tool_calls
 21  step.started a3 attempt=1
 22  text.ended a3 "The notes say installs are faster."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_1
```

*UI:* u1 user · a1 failed crashed [shell not_started] · s1 synthetic · a2 completed [shell success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2, a3.

#### 86. No sandbox on this machine: auto asks for every command

Where commands cannot be sandboxed, `auto` does not quietly become `full`: each command asks, the question says why the sandbox is missing and what running without it means, and what could be remembered is commands without the sandbox for this session, nothing wider. `tool.started` records that the command ran unsandboxed.

*Provider:* runs the tests, then answers.

*Approval:* mode auto; no sandbox on the machine; a person is present.

```
-- the command asks, is allowed once, and runs without the sandbox
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test"}
  8  approval.requested a1/call_1 "Run this command without the sandbox?" choices=once,session,deny
  9  approval.answered a1/call_1 once
 10  tool.started a1/call_1 effect=exec mode=auto
 11  tool.settled a1/call_1 success "1 pass"
 12  step.ended a1 finish=tool_calls
 13  step.started a2 attempt=1
 14  text.ended a2 "The test passes."
 15  step.ended a2 finish=stop
 16  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

### Replays, subagents and background work

#### 87. A replay that stays on its recording

A recorded session (a read, then an answer) is replayed against a changed system prompt. The replay is a session of its own, typed as a replay of the recording. Its baseline is the recording's with the new prompt; the recording's prompt is delivered where it arrived. The model makes the recorded call: it is answered from the recording (`replay.call matched`, then the recorded `tool.started` and the recorded result, byte for byte) and nothing runs. No snapshot is taken, no check runs, nobody is asked. When the recording's last step is replayed the execution ends, and `replay.ended` says the replay was identical.

*Provider:* as in the recording: step 1 calls read with the recorded arguments; step 2 answers.

```
-- the replay session starts with the changed baseline and the recorded prompt
  1  session.created replay of ses_other through seq 14, policy stop, changed: the system prompt
  2  execution.started exe_1
  3  baseline.set
  4  inbox.enqueued u1 steer "Fix the failing test."
  5  inbox.delivered u1
-- the model makes the recorded call and is given the recorded result
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.test.ts"}
-- the recording's answer follows, and the replay ends as identical
  8  tool.started a1/call_1 effect=read
  9  replay.call a1/call_1 matched recorded step 1 call 1
 10  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The expectation is wrong."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
 16  replay.ended identical "all 2 recorded steps replayed without a divergence"
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the replay session starts with the changed baseline and the recorded prompt": `replay.diverged arguments_differ -> /data/replays/copy (no snapshot: the copy is empty)` (invalid_transition). Under the stop policy a replay ends where it leaves the recording; it has no copy to carry on in.
- after "the model makes the recorded call and is given the recorded result": `replay.call a1/call_1 matched` (invalid_transition). A matched call names the recorded call it matched.
- after "the model makes the recorded call and is given the recorded result": `replay.call a1/call_1 diverged recorded step 1 call 1 (arguments_differ)` (invalid_transition). Only a matched call names a recorded call.
- after "the recording's answer follows, and the replay ends as identical": `replay.ended identical "again"` (invalid_transition). A replay ends once.

#### 88. A replay that leaves its recording stops there

Under the `stop` policy. The replayed model reads another file than the recording did. That call is not on the recording: it is recorded as the divergence (`replay.call diverged`, with the kind), it is not run, and it settles as not started with a text that says the replay stopped. The step closes, and the execution ends without an answer, marked as ended by the replay (`execution.failed` with `cause: replay`: nothing failed, but there is no answer to end on). `replay.ended` carries the report: where the replay left and what the recording did there.

*Provider:* step 1 calls read with other arguments than the recording's.

```
-- the model calls read with other arguments
  1  session.created replay of ses_other through seq 14, policy stop, changed: the system prompt
  2  execution.started exe_1
  3  baseline.set
  4  inbox.enqueued u1 steer "Fix the failing test."
  5  inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"b.test.ts"}
-- the call is not run, and the replay ends there
  8  replay.call a1/call_1 diverged (arguments_differ)
  9  tool.settled a1/call_1 not_started "Not run: the replay left the recording at this call and s..."
 10  step.ended a1 finish=tool_calls
 11  execution.failed exe_1 cause=replay "The replay ended: left the recording at step 1, call 1: a..."
 12  replay.ended diverged "left the recording at step 1, call 1: arguments differ"
```

*UI:* u1 user · a1 completed [read not_started]. *Claim:* released.

*Model sees next:* u1, a1.

#### 89. A replay that leaves its recording carries on in a copy

Under the `execute` policy. At the first call that is not on the recording, the recorded workspace as it was at that point is restored into a copy (`replay.diverged`: the directory and the snapshot it was restored from; here the recording has none, so the copy starts empty), and from there the replay is an ordinary turn in that copy: the call runs for real (`replay.call diverged executed`), with the sandbox and without the network where the approval layer is on, and the turn runs to its answer. The recording's workspace is never touched. `replay.ended` says the replay diverged; what the copy holds can be graded.

*Provider:* step 1 calls read with other arguments than the recording's; step 2 answers.

```
-- the model leaves the recording; the copy is made and the call runs in it
  1  session.created replay of ses_other through seq 14, policy execute, changed: the system prompt
  2  execution.started exe_1
  3  baseline.set
  4  inbox.enqueued u1 steer "Fix the failing test."
  5  inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"b.test.ts"}
  8  replay.diverged arguments_differ -> /data/replays/copy (no snapshot: the copy is empty)
  9  tool.started a1/call_1 effect=read
 10  replay.call a1/call_1 diverged (arguments_differ) executed
 11  tool.settled a1/call_1 success "expect(sub(2, 1)).toBe(1)"
 12  step.ended a1 finish=tool_calls
-- the turn runs to its answer in the copy
 13  step.started a2 attempt=1
 14  text.ended a2 "b.test.ts is fine."
 15  step.ended a2 finish=stop
 16  execution.succeeded exe_1
 17  replay.ended diverged "left the recording at step 1, call 1: arguments differ"
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the model leaves the recording; the copy is made and the call runs in it": `replay.diverged extra_call -> /data/replays/copy (no snapshot: the copy is empty)` (invalid_transition). A replay leaves its recording once.

#### 90. A subagent runs a task and its answer is the call's result

The model hands a task to a subagent. The call starts like any tool (its effect class says the step may change files); the child session is named in the parent's log (`spawn.started`) before it exists. The child runs its own loop in the same workspace with a fresh conversation. When it ends, `spawn.ended` records how, and what its model calls cost (rolled up into the parent's totals), and the call settles with the child's final answer and a reference to its session. Several such calls in one response run side by side. The subagent's turn is not verified; the parent's is.

*Provider:* step 1 calls subagent; the child answers in one step; step 2 answers.

```
-- the model asks for a subagent
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 subagent {"task":"Fix module a"}
-- the child is started and runs
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 subagent ses_other
-- the child ends; its answer is the call's result
 10  spawn.ended bg_1 completed usage=1000in/50out
 11  tool.settled a1/call_1 success "a.ts is fixed.\n\n[subagent ses_other: finished after 1 ste..."
 12  step.ended a1 finish=tool_calls
 13  step.started a2 attempt=1
 14  text.ended a2 "Module a is fixed."
 15  step.ended a2 finish=stop
-- the parent's turn ends through the gate
 16  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [subagent success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the model asks for a subagent": `spawn.started bg_1 by a1/call_1 subagent ses_other` (invalid_transition). Work is spawned by a tool call that is running: its start is durable first.
- after "the child is started and runs": `spawn.started bg_1 by a1/call_1 subagent ses_other` (duplicate_id). A piece of spawned work starts once.
- after "the child is started and runs": `spawn.ended bg_2 completed usage=1000in/50out` (not_found). Only work that is running ends.
- after "the child is started and runs": `watch.started bg_1.w1 on bg_1 "fixed" limit=1` (invalid_transition). Only a background command's output is watched: a subagent's words are its own conversation.
- after "the child ends; its answer is the call's result": `spawn.ended bg_1 completed usage=1000in/50out` (not_found). Spawned work ends once.
- after "the child ends; its answer is the call's result": `execution.succeeded exe_1 verification=left_to_parent` (invalid_transition). Only a subagent leaves the verification of its turn to the session that started it.

#### 91. The subagent's own log

The same situation from the child's side. A subagent is a real session, typed as spawned by its parent: it starts at seq 1 with a fresh conversation (the baseline and its task; nothing of the parent's history), the parent's settings and working directory, and a cache key of its own. Its task is delivered like a prompt, with a note that says who reads its answer. It ends like any turn, but without running the verification gate: its `execution.succeeded` says `left_to_parent`, because the turn of the session that started it is what gets verified, once the child's work is in. That says nothing about whether the project has checks; the parent's ending does. At the depth limit (one level by default) its tool list has no `subagent`.

*Provider:* the child answers in one step.

```
-- the child is created with its task and works
  1  session.created subagent of ses_other (bg_1, depth 1) "Fix module a"
  2  inbox.enqueued u1 steer "Fix module a\n\n(You are a subagent. Another agent gave you..."
  3  execution.started exe_1
  4  baseline.set
  5  inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "a.ts is fixed."
  8  step.ended a1 finish=stop
-- its turn ends, and the ending says who verifies it
  9  execution.succeeded exe_1 verification=left_to_parent
```

*UI:* u1 user · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

*The reducer rejects:*
- after "the child is created with its task and works": `execution.succeeded exe_1` (invalid_transition). A subagent's turn is not verified by itself: its ending cannot say that no check is configured, or anything else about checks.
- after "its turn ends, and the ending says who verifies it": `spawn.ended bg_1 completed` (not_found). The end of the child's work is recorded in its parent's log, not its own.

#### 92. A background subagent's answer arrives as a message

With `background: true` the call returns at once with the child's reference, and the model goes on. When the model has nothing more to do while the child still works, the turn does not end: the loop waits at the boundary (the checks would see the child's work half done). When the child ends, `spawn.ended` and the message that carries its answer are one append; the message is a harness message (`subagent_result`), delivered as a steer at the boundary, and the model answers it. Had the session been idle (its own turn failed, say), the message would have started a new execution.

*Provider:* step 1 calls subagent with background; step 2 says it started; the child, which read a file meanwhile, answers; step 3 reports.

```
-- the call returns at once and the model goes on
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 subagent {"task":"Fix module a","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 subagent ses_other background
 10  tool.settled a1/call_1 success "Started subagent ses_other in the background. Its answer ..."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "Started."
 14  step.ended a2 finish=stop
-- the child ends: its answer is delivered, and the model reports
 15  spawn.ended bg_1 completed usage=2000in/100out
 16  inbox.enqueued s1 steer origin=subagent_result "a.ts is fixed.\n\n[subagent ses_other: finished after 2 ste..."
 17  inbox.delivered s1
 18  step.started a3 attempt=1
 19  text.ended a3 "The subagent fixed module a."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [subagent success] · a2 completed · s1 synthetic · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, a3.

#### 93. A background command's exit wakes the idle session

The shell tool's `background` argument starts a command and returns a handle at once. The command is spawned work of the session (`spawn.started`): it runs beside the steps, in the same sandbox a foreground command would, and is stopped when the session is interrupted or closed. The turn ends while it runs. When it exits, `spawn.ended` (with the exit code) and a harness message with the end of its output (`background_command`) are one append; the session is idle, so the message starts a new execution, is delivered, and the model answers.

*Provider:* step 1 calls shell with background; step 2 answers; after the command exits, step 3 answers.

```
-- the command is started in the background and the turn ends
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 command "bun test" background
 10  tool.settled a1/call_1 success "Started in the background as bg_1."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The tests are running."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
-- the command exits; the message wakes the session
 16  spawn.ended bg_1 completed exit=0
 17  inbox.enqueued s1 steer origin=background_command "Background command bg_1 exited with code 0 after 2.5 s.\nC..."
 18  execution.started exe_2
 19  inbox.delivered s1
 20  step.started a3 attempt=1
 21  text.ended a3 "The tests pass."
 22  step.ended a3 finish=stop
 23  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [shell success] · a2 completed · s1 synthetic · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, a3.

#### 94. A background command is lost when the process dies

A background command dies with the harness process: the guard that every command has kills its process group. The session's log still says it runs. When the session is opened again, the command is recorded as lost (`spawn.ended lost`) together with a harness message that says so (`spawn_lost`). Opening a session starts nothing, so the message waits in the inbox and is delivered, before the user's next prompt, when that prompt starts the next turn.

*Provider:* step 1 calls shell with background; step 2 answers; the process dies; the user asks again; step 3 answers.

```
-- the command runs in the background; the turn ends; the process dies
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun test --watch","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 command "bun test --watch" background
 10  tool.settled a1/call_1 success "Started in the background as bg_1."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "Watching."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
-- at the next start the command is recorded as lost; the model is told with the next prompt
 16  spawn.ended bg_1 lost
 17  inbox.enqueued s1 steer origin=spawn_lost "Background command bg_1 is gone: the harness restarted wh..."
 18  inbox.enqueued u2 steer "Still watching?"
 19  execution.started exe_2
 20  inbox.delivered s1
 21  inbox.delivered u2
 22  step.started a3 attempt=1
 23  text.ended a3 "The watcher stopped when the harness restarted."
 24  step.ended a3 finish=stop
 25  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [shell success] · a2 completed · s1 synthetic · u2 user · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, u2, a3.

#### 95. A watch on a background command's output wakes the idle session when a line matches

A background command wakes the session when it exits; a server does not exit. The user, through their client, sets a watch on the running command's output: text a line must contain (or a regular expression), and how often it may fire (once by default, a bounded number at most). The watch is recorded (`watch.started`) and nothing else happens: the model is not told, and nothing starts. The model cannot ask for a watch itself: the tool list is fixed, and what a command prints must not be able to arrange for its own delivery. When the command prints a matching line, a harness message (`background_watch`) and `watch.fired` are one append: the message names the command and the watch and quotes the line inside a fence, labelled as output, which it is, not instructions; it is redacted like all command output. The message wakes the session exactly as a command's end does: the session is idle, so it starts a new execution, is delivered, and the model answers. The watch has fired as often as it may, so it is over, and the command ends later like any command.

*Provider:* step 1 calls shell with background; step 2 answers; the user sets a watch; the server prints the line; step 3 answers; the server exits; step 4 answers.

```
-- the server is started in the background and the turn ends
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run dev","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 command "bun run dev" background
 10  tool.settled a1/call_1 success "Started in the background as bg_1."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The server is starting."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
-- the user sets a watch for the line that says the server is up
 16  watch.started bg_1.w1 on bg_1 "listening on" limit=1
-- the server prints the line; the message wakes the session
 17  inbox.enqueued s1 steer origin=background_watch "Background command bg_1 printed a line that matches the w..."
 18  watch.fired bg_1.w1 on bg_1 firing=1 "Server listening on http://localhost:3000" told by s1
 19  execution.started exe_2
 20  inbox.delivered s1
 21  step.started a3 attempt=1
 22  text.ended a3 "The server is up on port 3000."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_2
-- the server exits later, like any background command
 25  spawn.ended bg_1 completed exit=0
 26  inbox.enqueued s2 steer origin=background_command "Background command bg_1 exited with code 0 after 2.5 s.\nC..."
 27  execution.started exe_3
 28  inbox.delivered s2
 29  step.started a4 attempt=1
 30  text.ended a4 "The server has stopped."
 31  step.ended a4 finish=stop
 32  execution.succeeded exe_3
```

*UI:* u1 user · a1 completed [shell success] · a2 completed · s1 synthetic · a3 completed · s2 synthetic · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, a3, s2, a4.

*The reducer rejects:*
- after "the server is started in the background and the turn ends": `watch.started bg_2.w1 on bg_2 "listening on" limit=1` (not_found). A watch is set on a command that is running.
- after "the user sets a watch for the line that says the server is up": `watch.started bg_1.w1 on bg_1 "error" limit=1` (duplicate_id). A watch is set once.
- after "the user sets a watch for the line that says the server is up": `watch.started bg_1.w2 on bg_1 "error" limit=21` (invalid_transition). A watch fires a bounded number of times.
- after "the user sets a watch for the line that says the server is up": `watch.fired bg_1.w1 on bg_1 firing=1 "Server listening on http://localhost:3000" told by s1` (not_found). A firing is the message that tells the model: the message is admitted first, in the same append.
- after "the user sets a watch for the line that says the server is up": `spawn.ended bg_1 completed exit=0` (invalid_transition). A command does not end while a watch on it could still fire: the watch is ended first, with the reason.
- after "the server prints the line; the message wakes the session": `watch.ended bg_1.w1 on bg_1 removed` (invalid_transition). A watch that fired as often as it may is over: there is nothing left to remove.
- after "the server prints the line; the message wakes the session": `watch.started bg_1.w1 on bg_1 "listening on" limit=1` (duplicate_id). A watch that is over keeps its ID.
- after "the server exits later, like any background command": `watch.started bg_1.w2 on bg_1 "listening on" limit=1` (not_found). A watch on a command that has ended is refused.

#### 96. A watch fires while a turn runs, and ends with its command

A watch can be set at any moment, also while the model works: it is the user's act, like sending a message. This one is a regular expression that ignores case and may fire three times. The command prints a matching line while a tool call of the turn runs. The message is admitted at once (one append with `watch.fired`) and, being a steer, is delivered at the next step boundary: the model reads it together with its tool's result and goes on. The watch has two firings left when the command exits. A watch is never silently gone: `watch.ended` records that it ended with its command, in the same append as `spawn.ended` and right before it, and the message about the command's end says so.

*Provider:* step 1 calls shell with background (the user sets a watch); step 2 calls read, and the build prints an error meanwhile; step 3 answers; the build exits; step 4 answers.

```
-- the build is started in the background; the user sets a watch while the turn runs
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run build --watch","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 command "bun run build --watch" background
 10  tool.settled a1/call_1 success "Started in the background as bg_1."
 11  watch.started bg_1.w1 on bg_1 /error|failed/i limit=3
 12  step.ended a1 finish=tool_calls
-- the build prints an error while a file is read; the message is delivered at the next boundary
 13  step.started a2 attempt=1
 14  tool.called a2/call_1 read {"path":"src/a.ts"}
 15  tool.started a2/call_1 effect=read
 16  inbox.enqueued s1 steer origin=background_watch "Background command bg_1 printed a line that matches the w..."
 17  watch.fired bg_1.w1 on bg_1 firing=1 "src/a.ts(3,7): error TS2322: Type 'string' is not assigna..." told by s1
 18  tool.settled a2/call_1 success "const a: number = '1'"
 19  step.ended a2 finish=tool_calls
 20  inbox.delivered s1
 21  step.started a3 attempt=1
 22  text.ended a3 "The build reports the type error on line 3 of a.ts: the v..."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_1
-- the build exits: the watch that could still fire ends with it
 25  watch.ended bg_1.w1 on bg_1 command_ended
 26  spawn.ended bg_1 completed exit=1
 27  inbox.enqueued s2 steer origin=background_command "Background command bg_1 exited with code 1 after 2.5 s.\nC..."
 28  execution.started exe_2
 29  inbox.delivered s2
 30  step.started a4 attempt=1
 31  text.ended a4 "The build stopped with the type error still in place."
 32  step.ended a4 finish=stop
 33  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [shell success] · a2 completed [read success] · s1 synthetic · a3 completed · s2 synthetic · a4 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, a3, s2, a4.

*The reducer rejects:*
- after "the build prints an error while a file is read; the message is delivered at the next boundary": `watch.fired bg_1.w1 on bg_1 firing=3 "src/a.ts(3,7): error TS2322: Type 'string' is not assigna..." told by s1` (invalid_transition). Firings are counted one by one, up to the limit.

#### 97. A watch is lost with its command when the process dies

A watch lives in the process that runs its command: the command dies with the harness (its guard kills the process group), and nothing follows its output any more. The log still says that the command runs and that a watch on it could fire. When the session is opened again, the watch is recorded as lost (`watch.ended lost`) right before its command is (`spawn.ended lost`), in one append with the harness message that tells the model that the command is gone and that the watch on it will not fire. So after a restart a watch is never just gone, and the model is not left waiting for a message that cannot come.

*Provider:* step 1 calls shell with background; step 2 answers; the user sets a watch; the process dies; the user asks again; step 3 answers.

```
-- the server runs in the background with a watch on its output; the process dies
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run dev","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 command "bun run dev" background
 10  tool.settled a1/call_1 success "Started in the background as bg_1."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The server is starting."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
 16  watch.started bg_1.w1 on bg_1 "listening on" limit=1
-- at the next start the watch and its command are recorded as lost; the model is told with the next prompt
 17  watch.ended bg_1.w1 on bg_1 lost
 18  spawn.ended bg_1 lost
 19  inbox.enqueued s1 steer origin=spawn_lost "Background command bg_1 is gone: the harness restarted wh..."
 20  inbox.enqueued u2 steer "Is it up?"
 21  execution.started exe_2
 22  inbox.delivered s1
 23  inbox.delivered u2
 24  step.started a3 attempt=1
 25  text.ended a3 "The server stopped when the harness restarted, and so did..."
 26  step.ended a3 finish=stop
 27  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [shell success] · a2 completed · s1 synthetic · u2 user · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, u2, a3.

*The reducer rejects:*
- after "at the next start the watch and its command are recorded as lost; the model is told with the next prompt": `watch.ended bg_1.w1 on bg_1 lost` (not_found). A watch ends once, and goes with its command.

#### 98. A watch whose regular expression is too slow on a line is ended

The pattern of a watch is the user's and the line is whatever the command prints, and a regular expression can backtrack: `(a+)+$` against thirty characters that almost match takes the runtime's matcher about a second, during which nothing else in the process would run. The engine therefore gives a match a budget (`WATCH_LIMITS.matchMs`, 50 ms) and makes it on a helper thread. A match that has not answered by then is given up on, and its watch is ended with the reason on record (`watch.ended too_slow`): the expression is not tried on another line. The user is told in a notice that names the budget; the model is told nothing, as it was never told of the watch. The command goes on and ends like any other, with no watch left to end with it.

*Provider:* step 1 calls shell with background; step 2 answers; the user sets a watch; the server prints a line the expression backtracks on; the server exits; step 3 answers.

```
-- the server runs in the background and the user sets a watch with a regular expression
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"bun run dev","background":true}
  8  tool.started a1/call_1 effect=exec
  9  spawn.started bg_1 by a1/call_1 command "bun run dev" background
 10  tool.settled a1/call_1 success "Started in the background as bg_1."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The server is starting."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
 16  watch.started bg_1.w1 on bg_1 /(a+)+$/ limit=5
-- the server prints a line the expression backtracks on: the match is given up on and the watch is ended
 17  watch.ended bg_1.w1 on bg_1 too_slow
-- the server exits later, like any background command: no watch is left to end with it
 18  spawn.ended bg_1 completed exit=0
 19  inbox.enqueued s1 steer origin=background_command "Background command bg_1 exited with code 0 after 2.5 s.\nC..."
 20  execution.started exe_2
 21  inbox.delivered s1
 22  step.started a3 attempt=1
 23  text.ended a3 "The server has stopped."
 24  step.ended a3 finish=stop
 25  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed [shell success] · a2 completed · s1 synthetic · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, s1, a3.

*The reducer rejects:*
- after "the server prints a line the expression backtracks on: the match is given up on and the watch is ended": `watch.ended bg_1.w1 on bg_1 removed` (invalid_transition). A watch that was ended is over: there is nothing left to remove.

### Skills, MCP servers and wake-ups

#### 99. The skill index follows the files: first given, then replaced, then withdrawn

The project has one skill. The `skill` tool is in the frozen tool list from the first baseline, with a spec that names no skill; which skills exist is told in a message. Before the first step the index is appended (the baseline never carries it). Between two turns the skill's description is edited, so the next turn starts with the index again, saying that it replaces the one before. During that turn the model's own command removes the skill, and at the next step boundary a short withdrawal is appended (its fingerprint is `null`). The baseline is never rewritten: every request is the previous one plus appended items.

*Provider:* turn 1: one step that answers. Turn 2: a step with a shell call that removes the skill's directory, then a step that answers.

*Engine:* offers skills (the `skill` tool; the project has skill files).

```
-- the first turn: the index is appended after the baseline and before the user's message
  1  session.created
  2  inbox.enqueued u1 steer "Which skills do you have?"
  3  execution.started exe_1
  4  baseline.set
  5  instruction.appended i1 source=skills "Skills you can load:\n<skills lines=\"3\">\nSkills are instru..."
  6  inbox.delivered u1
  7  step.started a1 attempt=1
  8  text.ended a1 "One: release."
  9  step.ended a1 finish=stop
 10  execution.succeeded exe_1
-- the description was edited between the turns: the next turn starts with the new index
 11  inbox.enqueued u2 steer "Remove the release skill."
 12  execution.started exe_2
 13  instruction.appended i2 source=skills "The skills have changed. This list replaces the one you w..."
 14  inbox.delivered u2
 15  step.started a2 attempt=1
 16  tool.called a2/call_1 shell {"command":"rm -r .claude/skills/release"}
 17  tool.started a2/call_1 effect=exec
 18  tool.settled a2/call_1 success ""
 19  step.ended a2 finish=tool_calls
-- the command removed the skill: at the boundary the index is withdrawn, then the model answers
 20  instruction.appended i3 source=skills "There are no skills any more. Disregard the list of skill..."
 21  step.started a3 attempt=1
 22  text.ended a3 "Removed."
 23  step.ended a3 finish=stop
 24  execution.succeeded exe_2
```

*UI:* i1 instruction · u1 user · a1 completed · i2 instruction · u2 user · a2 completed [shell success] · i3 instruction · a3 completed. *Claim:* released.

*Model sees next:* i1, u1, a1, i2, u2, a2, i3, a3.

*The reducer rejects:*
- after "the first turn: the index is appended after the baseline and before the user's message": `baseline.set` (invalid_transition). The baseline is frozen until the next compaction: the index is appended, never folded in.

#### 100. An MCP server connects late; its tool is called through the bridge, and the result taints the session

The user's configuration names an MCP server that is still starting when the first request goes out. Nothing waits for it and nothing in the request depends on it: `mcp_search` and `mcp_call` are in the frozen tool list whether or not a server exists. When the server has connected, the catalogue (its tools, by name and one-line description) is appended at the next step boundary as an instruction message; the event records beside the text which servers wrote those descriptions. The model calls the server's tool through `mcp_call`, which is a `network` call from an MCP origin: `tool.started` records that, the result's `display` records the server, the tool and that the content is untrusted, and from that result on the session is tainted, which the user is told once (`taint.noticed`). Mode `full` runs the first call without a question; a second one would now ask.

*Provider:* step 1 finishes with a read call (during which the server connects); step 2 with an `mcp_call` of `fx/echo`; step 3 answers.

*Approval:* mode full; the sandbox is available; nobody is present (unattended: deny).

*Engine:* offers MCP (`mcp_search` and `mcp_call`; the user's configuration names one server, `fx`).

```
-- the first step goes out while the server is still starting
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read mode=full a.ts:workspace
  9  tool.settled a1/call_1 success "export const a = 1"
 10  step.ended a1 finish=tool_calls
-- the server has connected: its catalogue is appended, and the model calls its tool
 11  instruction.appended i1 source=mcp "MCP tools are available:\n<mcp_tools lines=\"4\">\nMCP server..."
 12  step.started a2 attempt=1
 13  tool.called a2/call_2 mcp_call {"server":"fx","tool":"echo","arguments":{"text":"hello"}}
 14  tool.started a2/call_2 effect=network mode=full
 15  tool.settled a2/call_2 success "Result of MCP tool fx/echo (content from the server, not ..."
 16  taint.noticed mcp-tool from fx/echo at seq 15
 17  step.ended a2 finish=tool_calls
-- the model answers
 18  step.started a3 attempt=1
 19  text.ended a3 "The server said hello."
 20  step.ended a3 finish=stop
 21  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · i1 instruction · a2 completed [mcp_call success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, i1, a2, a3.

*The reducer rejects:*
- after "the server has connected: its catalogue is appended, and the model calls its tool": `baseline.set` (invalid_transition). A server that connects late is appended as a message; the tool list and the instructions stay as they were frozen.

#### 101. A wake-up fires while the session is idle

The session has finished a turn and nobody is working in it. A wake-up the user set up comes due: the scheduler hands the firing to the engine, which admits the message into the inbox under the firing's own key as its message ID, with origin `wake`, as a queued item. Delivery `wake` then starts an execution exactly as a prompt would. Nobody is present, so the turn is unattended: a call that would ask is refused, never approved by default. The model sees the message in an envelope that names its origin, and the request is the previous one plus appended items.

*Provider:* each turn: one step that finishes with stop.

*Engine:* offers wake-ups (`wake_create`, `wake_list`, `wake_cancel`).

```
-- a turn, then the session is idle
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "2"
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- the wake-up fires: its message is admitted and starts a turn
 10  inbox.enqueued msg_wk_5c3a9e21b7d4_1 queue origin=wake "[Wake-up wk_5c3a9e21b7d4 · after 5m (at 2026-11-12T09:05:..."
 11  execution.started exe_2
 12  inbox.delivered msg_wk_5c3a9e21b7d4_1
 13  step.started a2 attempt=1
 14  text.ended a2 "The build is green."
 15  step.ended a2 finish=stop
 16  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · msg_wk_5c3a9e21b7d4_1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, msg_wk_5c3a9e21b7d4_1, a2.

#### 102. A wake-up fires while a turn runs

The model is in the middle of a turn (a tool is running) when a wake-up comes due. The firing is admitted at once, as a queued item: a wake-up never steers a turn in progress. The turn carries on to its answer; then, in one append, the turn ends and the wake-up's message is delivered, and its turn runs under the same claim, as for any queued message.

*Provider:* step 1 finishes with a read call (during which the wake-up fires); step 2 answers the user; step 3 answers the wake-up.

*Engine:* offers wake-ups (`wake_create`, `wake_list`, `wake_cancel`).

```
-- the wake-up fires while the tool runs: its message waits in the inbox
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"a.ts"}
  8  tool.started a1/call_1 effect=read
  9  inbox.enqueued msg_wk_5c3a9e21b7d4_1 queue origin=wake "[Wake-up wk_5c3a9e21b7d4 · after 5m (at 2026-11-12T09:05:..."
 10  tool.settled a1/call_1 success "export const a = 1"
 11  step.ended a1 finish=tool_calls
-- the turn is answered first; then it ends and the wake-up's message is delivered
 12  step.started a2 attempt=1
 13  text.ended a2 "a is 1."
 14  step.ended a2 finish=stop
 15  turn.ended
 16  inbox.delivered msg_wk_5c3a9e21b7d4_1
 17  step.started a3 attempt=1
 18  text.ended a3 "The build is green."
 19  step.ended a3 finish=stop
 20  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed · msg_wk_5c3a9e21b7d4_1 synthetic · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, msg_wk_5c3a9e21b7d4_1, a3.

#### 103. A firing is delivered again after the process died

The engine admitted a firing, and the process died before it started the turn and before the wake store heard that the firing was delivered. The store still has the firing open, so the next process's scheduler hands it over again, with the same key. The engine finds the key in the session's log and answers that it is a duplicate: nothing is admitted a second time. The message still waits and was to start a turn, so that turn starts now. A firing is therefore delivered at least once by the store and exactly once into the conversation.

*Provider:* each turn: one step that finishes with stop.

*Engine:* offers wake-ups (`wake_create`, `wake_list`, `wake_cancel`).

```
-- a turn, then the session is idle
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "2"
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- the firing is admitted, and the process dies before anything else happens
 10  inbox.enqueued msg_wk_5c3a9e21b7d4_1 queue origin=wake "[Wake-up wk_5c3a9e21b7d4 · after 5m (at 2026-11-12T09:05:..."
-- the next process delivers the firing again: nothing is admitted, and the turn it was to start runs
 11  execution.started exe_2
 12  inbox.delivered msg_wk_5c3a9e21b7d4_1
 13  step.started a2 attempt=1
 14  text.ended a2 "The build is green."
 15  step.ended a2 finish=stop
 16  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · msg_wk_5c3a9e21b7d4_1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, msg_wk_5c3a9e21b7d4_1, a2.

*The reducer rejects:*
- after "the firing is admitted, and the process dies before anything else happens": `inbox.enqueued msg_wk_5c3a9e21b7d4_1 queue origin=wake "[Wake-up wk_5c3a9e21b7d4 · after 5m (at 2026-11-12T09:05:..."` (duplicate_id). A message ID is used once: the engine answers the redelivery as a duplicate before it writes anything.

#### 104. A webhook's firing brings untrusted content: the session is tainted before its turn starts

A webhook wake-up fires with the body of the request in its message. The body is content the harness does not control, so the admission says so in a field of the same event (`untrusted`: which wake-up, and that it carries a webhook's body); the origin is `wake_webhook`, so a client can show such messages apart. Taint is derived from the log, and this admission is a source from its own position on: the user is told once (`taint.noticed`), before the execution starts, and every call of the turn it starts is decided with untrusted content in the conversation.

*Provider:* each turn: one step that finishes with stop.

*Approval:* mode auto; the sandbox is available; nobody is present (unattended: deny).

*Engine:* offers wake-ups (`wake_create`, `wake_list`, `wake_cancel`).

```
-- a turn, then the session is idle
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "2"
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- the webhook's firing is admitted with the fact that makes it untrusted, the user is told, and the turn starts
 10  inbox.enqueued msg_wk_5c3a9e21b7d4_1 queue origin=wake_webhook "[Webhook wk_5c3a9e21b7d4 · webhook]\nThis message was not ..."
 11  taint.noticed wake-up from wk_5c3a9e21b7d4 at seq 10
 12  execution.started exe_2
 13  inbox.delivered msg_wk_5c3a9e21b7d4_1
 14  step.started a2 attempt=1
 15  text.ended a2 "The deploy went out."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · msg_wk_5c3a9e21b7d4_1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, msg_wk_5c3a9e21b7d4_1, a2.

### Agents

#### 105. A session starts as a read-only agent, and a write is refused with the reason

The user starts the session as the agent `reviewer`, whose definition allows only tools that read. The definition is read once, when the session is created: `agent.switched` records it right after `session.created` (its instructions, its restrictions, the fingerprint of the file), and the session never reads the file again. The first baseline carries the agent's instructions as its last section, so nothing about this differs in cache terms from a session without an agent, and the tool list is the same as every other session's: every tool stays offered. When the model calls `write`, the loop refuses the call before the approval layer looks at it: `approval.denied` names the agent whose restrictions refused it, with which of its rules it was, the call's effect class and a sentence a client shows the user, and the call's result is the sentence that tells the model so and what to do instead. The model reads it and answers.

*Provider:* step 1 calls write; step 2 answers.

*Engine:* offers agents (the project has agent definitions).

```
-- the session is created as the agent, and its first baseline carries the agent's instructions
  1  session.created
  2  agent.switched null
  3  inbox.enqueued u1 steer "Fix the failing test."
  4  execution.started exe_1
  5  baseline.set
  6  inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
-- the write is refused with the sentence, and the model answers
  9  approval.denied a1/call_1 policy
 10  tool.settled a1/call_1 error "Not run: you are working as the agent \"reviewer\", which m..."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "As the reviewer I may not edit files. The expectation sho..."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [write error] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the session is created as the agent, and its first baseline carries the agent's instructions": `agent.switched null` (invalid_transition). The baseline is frozen: from here a switch is announced by an instruction message.
- after "the session is created as the agent, and its first baseline carries the agent's instructions": `approval.denied a1/call_1 policy` (invalid_transition). A call is refused by the restrictions of the agent the session runs as, and that is the reviewer.
- after "the session is created as the agent, and its first baseline carries the agent's instructions": `approval.denied a1/call_1 policy` (invalid_transition). An agent's refusal says which of its rules refused the call, the call's effect class and a sentence for the user.

#### 106. The user switches the agent in the middle of a session: an appended message, never a new baseline

The session has run a turn without an agent. The user selects `reviewer`. The baseline is frozen, so nothing is rewritten: the switch is appended as an instruction message (source `agent`) that carries the agent's instructions, and `agent.switched` follows it in the same append, naming that message. The session is idle, so both are recorded the moment the user selects the agent, before any turn: a process that dies afterwards has not lost the choice. (They are the one kind of message that enters history without a running execution. A switch asked for while a turn runs is made at that turn's next step boundary.) The next request is the previous one plus that message and the user's: the whole cached prefix is kept. From the switch on every call is checked against the agent's restrictions. Then the user selects `captain`, which names another model and effort: the message says that its instructions replace the reviewer's, and `settings.changed` follows at the same boundary, which is the one thing here that costs the cache (once, as a model change always does). Switching the agent off is a one-line message whose fingerprint is `null`.

*Provider:* turn 1 answers. Turn 2 (as the reviewer): a write, refused, then an answer. Turn 3 (as the captain, on the other model): a write that runs, then an answer. Turn 4 (no agent): an answer.

*Engine:* offers agents (the project has agent definitions).

```
-- a turn without an agent
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "The expectation is wrong: 1 + 1 is 2."
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- the user selects the reviewer while the session is idle: the message and the record are written at once
 10  instruction.appended i1 source=agent "The user switched you to the agent \"reviewer\". From this ..."
 11  agent.switched i1
-- the next turn runs as the reviewer, and a write is refused
 12  inbox.enqueued u2 steer "Fix it."
 13  execution.started exe_2
 14  inbox.delivered u2
 15  step.started a2 attempt=1
 16  tool.called a2/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
 17  approval.denied a2/call_1 policy
 18  tool.settled a2/call_1 error "Not run: you are working as the agent \"reviewer\", which m..."
 19  step.ended a2 finish=tool_calls
 20  step.started a3 attempt=1
 21  text.ended a3 "As the reviewer I may not edit files."
 22  step.ended a3 finish=stop
 23  execution.succeeded exe_2
-- the user selected the captain, which names another model: the message, the record and the settings change at one boundary
 24  instruction.appended i2 source=agent "The user switched you from the agent \"reviewer\" to the ag..."
 25  agent.switched i2
 26  settings.changed model=gpt-other reasoningEffort=high
 27  inbox.enqueued u3 steer "Then prepare the release."
 28  execution.started exe_3
 29  inbox.delivered u3
 30  step.started a4 attempt=1 model=gpt-other
 31  tool.called a4/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
 32  tool.started a4/call_1 effect=write
 33  tool.settled a4/call_1 success "Wrote a.test.ts"
 34  step.ended a4 finish=tool_calls
 35  step.started a5 attempt=1 model=gpt-other
 36  text.ended a5 "Fixed the expectation on the release branch."
 37  step.ended a5 finish=stop
 38  execution.succeeded exe_3
-- the user switched the agent off: one line, and its restrictions no longer apply
 39  instruction.appended i3 source=agent "The user switched off the agent \"captain\". From this poin..."
 40  agent.switched i3
 41  inbox.enqueued u4 steer "Thanks."
 42  execution.started exe_4
 43  inbox.delivered u4
 44  step.started a6 attempt=1 model=gpt-other
 45  text.ended a6 "You are welcome."
 46  step.ended a6 finish=stop
 47  execution.succeeded exe_4
```

*UI:* u1 user · a1 completed · i1 instruction · u2 user · a2 completed [write error] · a3 completed · i2 instruction · u3 user · a4 completed [write success] · a5 completed · i3 instruction · u4 user · a6 completed. *Claim:* released.

*Model sees next:* u1, a1, i1, u2, a2, a3, i2, u3, a4, a5, i3, u4, a6.

*The reducer rejects:*
- after "the user selects the reviewer while the session is idle: the message and the record are written at once": `instruction.appended i9 source=skills "No skills are available."` (invalid_transition). Any other message enters history only under a running execution.
- after "the next turn runs as the reviewer, and a write is refused": `baseline.set` (invalid_transition). The baseline is frozen until the next compaction: a switch is appended, never folded in.
- after "the next turn runs as the reviewer, and a write is refused": `agent.switched i1` (invalid_transition). A switch follows at once the instruction message that announces it.
- after "the user switched the agent off: one line, and its restrictions no longer apply": `agent.switched null` (invalid_transition). The baseline is frozen: a switch is announced by an instruction message.

#### 107. A subagent is run as an agent the list of agents names

The `subagent` tool has an optional `agent` argument in every session: its spec is a constant that names no agent, so the tool list never depends on which agents exist. Which ones do is told in a message: a session that is offered `subagent` gets the list of agents (name, a tag for its restrictions, one line of description) appended after its baseline, and again when the list changes. The model runs a subagent as `reviewer`. The name is checked when the call runs (a wrong one is an error result with close names, and starts nothing); `spawn.started` names the agent, and the child session is created as it. The child's result comes back like any subagent's.

*Provider:* step 1 calls subagent with `agent`; the child answers in one step; step 2 answers.

*Engine:* offers agents (the project has agent definitions).

```
-- the list of agents is appended after the baseline, and the model delegates to one
  1  session.created
  2  inbox.enqueued u1 steer "Have module a reviewed."
  3  execution.started exe_1
  4  baseline.set
  5  instruction.appended i1 source=agent-index "Agents you can run a subagent as:\n<agents lines=\"4\">\nAn a..."
  6  inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 subagent {"task":"Review module a","agent":"reviewer"}
  9  tool.started a1/call_1 effect=exec
 10  spawn.started bg_1 by a1/call_1 subagent ses_other
-- the child ends; its answer is the call's result
 11  spawn.ended bg_1 completed usage=1000in/50out
 12  tool.settled a1/call_1 success "Module a is fine.\n\n[subagent ses_other: finished after 1 ..."
 13  step.ended a1 finish=tool_calls
 14  step.started a2 attempt=1
 15  text.ended a2 "The reviewer found nothing wrong in module a."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_1
```

*UI:* i1 instruction · u1 user · a1 completed [subagent success] · a2 completed. *Claim:* released.

*Model sees next:* i1, u1, a1, a2.

#### 108. The log of a subagent that runs as an agent

The same situation from the child's side. The child is created as the agent: `agent.switched` follows its `session.created` in the same append, and its own fresh baseline carries the agent's instructions. Its restrictions are the agent's combined with its parent's (the stricter of each), and a child started without `agent` by a parent that runs as an agent runs as the parent's agent, so a restricted session cannot get around its restrictions by handing the work to a child. Here the child tries to edit a file: the call is refused with the sentence, in its own log, and it answers. At the depth limit it is not offered `subagent`, so it is not given the list of agents.

*Provider:* the child calls write, which is refused, then answers.

*Engine:* offers agents (the project has agent definitions).

```
-- the child is created as the agent, is refused a write, and answers
  1  session.created subagent of ses_other (bg_1, depth 1) "Review module a"
  2  agent.switched null
  3  inbox.enqueued u1 steer "Review module a\n\n(You are a subagent. Another agent gave ..."
  4  execution.started exe_1
  5  baseline.set
  6  inbox.delivered u1
  7  step.started a1 attempt=1
  8  tool.called a1/call_1 write {"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}
  9  approval.denied a1/call_1 policy
 10  tool.settled a1/call_1 error "Not run: you are working as the agent \"reviewer\", which m..."
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "Module a is fine."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1 verification=left_to_parent
```

*UI:* u1 user · a1 completed [write error] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

### Hooks and diagnostics

#### 109. A before hook refuses a call, and the model reads why

The user's configuration has a hook that runs before every `shell` call and refuses `git push`. The hook is asked after the call's arguments were accepted and before anything else is decided about it: no approval is looked at, no question is asked, nothing starts. The call settles from `pending` as an error whose text is the hook's reason, word for word, and the hook's record (`hook.ran`: which hook, how it ran, what it answered, the text that reached the model) is written right before that result, in the same append. A hook that does not object would have left the call to the approval layer unchanged: it approves nothing. Nothing about hooks is in the request's prefix: the model learns of the hook from the result of the call it refused.

*Provider:* step 1 finishes with a shell call `git push origin main`; the hook exits 2 with its reason on stdout; step 2 answers.

*Engine:* offers hooks (the user's configuration: `{"beforeTool":[{"name":"no-push","tools":["shell"],"command":"./hooks/no-push.sh"}]}`).

```
-- the model asks to push
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 shell {"command":"git push origin main"}
-- the hook refuses: its record and the call's result are one append, and the call never starts
  8  hook.ran beforeTool a1/call_1 no-push (user) no "Pushing is not allowed here. Commit locally and tell the ..."
  9  tool.settled a1/call_1 error "This call was not run: the hook \"no-push\" refused it.\nPus..."
 10  step.ended a1 finish=tool_calls
-- the model tells the user
 11  step.started a2 attempt=1
 12  text.ended a2 "I committed locally. Pushing is not allowed here."
 13  step.ended a2 finish=stop
 14  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [shell error] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

*The reducer rejects:*
- after "the model asks to push": `hook.ran afterTool a1/call_1 no-push (user) no "A note."` (invalid_transition). An after hook applies to a call that ran, and this one never started.
- after "the model asks to push": `hook.ran beforeTool a1/call_9 no-push (user) yes` (not_found). A hook's record names a call of the open step.
- after "the model asks to push": `hook.ran beforeTool no-push (user) no "Pushing is not allowed here. Commit locally and tell the ..."` (invalid_transition). A hook that applies to a tool call names it.
- after "the model asks to push": `hook.ran stop a1/call_1 no-push (user) yes` (invalid_transition). A stop hook applies to the end of a turn, not to a call.
- after "the model asks to push": `hook.ran beforeTool a1/call_1 no-push (user) yes "Looks fine."` (invalid_transition). Only a hook that answered no has text that reached the model.
- after "the hook refuses: its record and the call's result are one append, and the call never starts": `hook.ran beforeTool a1/call_1 no-push (user) yes` (invalid_transition). A hook's record comes before the result of its call, in the step that made the call.

#### 110. An after hook adds a note to a result, stored once with it

The user's configuration has a hook that runs after every `write` of a TypeScript file. The tool runs as always (`tool.started`, then the tool). After it returned and before its result is capped and stored, the hook is run with the result and answers with a note. The note is appended after the tool's own output, which stays first, byte for byte; the whole text is then capped once and stored once in `tool.settled`, and replayed as stored from then on. The hook's record is written right before the result, in the same append. A hook can only add: it cannot change the call's arguments, the tool's output, or a result that is already in the log.

*Provider:* step 1 finishes with a write call; the hook exits 2 with its note on stdout; step 2 answers.

*Engine:* offers hooks (the user's configuration: `{"afterTool":[{"name":"prettier","tools":["write"],"paths":["**/*.ts"],"command":"./hooks/format.sh"}]}`).

```
-- the tool runs, then the hook: the result carries the tool's output and the note
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 write {"path":"src/a.ts","content":"export const a = "}
  8  tool.started a1/call_1 effect=write
  9  hook.ran afterTool a1/call_1 prettier (user) no "prettier could not format this file; run it to see why."
 10  tool.settled a1/call_1 success "Wrote src/a.ts (1 line).\n\n[Note from the hook \"prettier\"]..."
 11  step.ended a1 finish=tool_calls
-- the model reads the note in the result and answers
 12  step.started a2 attempt=1
 13  text.ended a2 "Written; the file does not parse yet."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [write success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

#### 111. A stop hook sends the model back, and at its bound the turn ends with the hook unsatisfied

The user's configuration has a stop hook and allows it one round per turn (`maxStopRounds: 1`). When the model has answered and the verification gate says the turn may end, the stop hooks are asked. The hook objects: its message is appended as a harness message (origin `stop_hook`), with the hook's record, in one append, and the model is sent back, exactly as a check report sends it back. The message must be answered: the execution cannot end on it. When the model stops again the hook is asked again and still objects, but the turn has been sent back as often as it may be (the rounds are counted from the stop messages in the log, so a restart counts the same): the turn ends, and its ending says which hooks were not satisfied (`hooks.unsatisfied`) and what each of them said this last time (`hooks.objections`), next to what the gate found. The hook's second answer sent nobody back, so it reached the user and not the model: its record has no text for the model, and the ending is where a client reads the hook's words. A stop hook never loops, and one that cannot answer lets the turn end.

*Provider:* step 1 answers; the hook exits 2 with its message; step 2 answers; the hook exits 2 again.

*Engine:* offers hooks (the user's configuration: `{"stop":[{"name":"no-scratch","command":"./hooks/no-scratch.sh"}],"maxStopRounds":1}`).

```
-- the model answers; the hook objects, and its message sends the model back
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Done."
  8  step.ended a1 finish=stop
  9  hook.ran stop no-scratch (user) no "SCRATCH.md still exists. Delete it before you finish."
 10  synthetic.appended s1 origin=stop_hook "[Stop hook 1 of at most 1] The turn cannot end yet. This ..."
-- the model stops again
 11  step.started a2 attempt=1
 12  text.ended a2 "I cannot delete SCRATCH.md: it is not mine to remove."
 13  step.ended a2 finish=stop
-- the hook still objects, at its bound: the turn ends and says so
 14  hook.ran stop no-scratch (user) no
 15  execution.succeeded exe_1 hooks unsatisfied=no-scratch
```

*UI:* u1 user · a1 completed · s1 synthetic · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, s1, a2.

*The reducer rejects:*
- after "the model answers; the hook objects, and its message sends the model back": `execution.succeeded exe_1` (invalid_transition). The stop hook's message is unanswered: the model was sent back with it.
- after "the model stops again": `execution.succeeded exe_1 hooks unsatisfied=` (invalid_transition). An ending names the stop hooks that were not satisfied only when there is one.
- after "the model stops again": `execution.succeeded exe_1 hooks unsatisfied=no-scratch,no-scratch` (invalid_transition). An ending names each unsatisfied stop hook once.
- after "the model stops again": `execution.succeeded exe_1 hooks unsatisfied=no-scratch` (invalid_transition). An ending carries what each unsatisfied stop hook said.
- after "the model stops again": `execution.succeeded exe_1 hooks unsatisfied=no-scratch` (invalid_transition). An ending carries the words of the unsatisfied stop hooks only.
- after "the hook still objects, at its bound: the turn ends and says so": `hook.ran stop no-scratch (user) yes` (invalid_transition). A hook runs under an execution: there is none.

#### 112. A language server's diagnostics follow the result of the edit that made something worse

The user's configuration names a language server for the files the model works on. When the model reads such a file the server is started in the background and shown the file; nothing waits for it. When the model then writes the file, the tool runs as always, and after it returned the server is asked what the edit made worse, for at most the configured wait. The edit adds a call to a name that does not exist: the server's one new error is appended to the tool's own output as a short note (the error the file already had is counted, not listed), before the result is capped and stored. What the server said is recorded with the result as fields (`diagnostics`: whether a note was added, how many diagnostics it lists, and per server whose configuration it is from, how it came out and the counts), never read back out of the text. The note gates nothing: the project's checks remain the authority, and a server that is slow, starting or gone adds nothing and costs at most the wait. Nothing about the server is in the request's prefix.

*Provider:* step 1 finishes with a read of `src/a.txt`; step 2 with a write of it that adds a call to an undefined name; step 3 answers.

*Engine:* offers language-server diagnostics (the user's configuration names one server, `fixture`, for `*.txt` files).

```
-- the model reads the file: its result is the file, and the server is shown it in the background
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  tool.called a1/call_1 read {"path":"src/a.txt"}
  8  tool.started a1/call_1 effect=read
  9  tool.settled a1/call_1 success "let unused = WARN(unused)\ncall(ERROR(old))\nend"
 10  step.ended a1 finish=tool_calls
-- the model writes the file: the note follows the tool's own output, and the result records what the server said
 11  step.started a2 attempt=1
 12  tool.called a2/call_1 write {"path":"src/a.txt","content":"// a line added above\nlet unused = WARN(unused)\ncall(ERROR(old))\nfresh(ERROR(fetchUser))\nend"}
 13  tool.started a2/call_1 effect=write
 14  tool.settled a2/call_1 success "Wrote src/a.txt.\n\n[Diagnostics from the language server \"..." diagnostics=fixture:compared(+1) note
 15  step.ended a2 finish=tool_calls
-- the model reads the note and answers
 16  step.started a3 attempt=1
 17  text.ended a3 "Added the call; fetchUser is not defined yet."
 18  step.ended a3 finish=stop
 19  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed [write success] · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, a2, a3.

### Slash commands and telemetry

#### 113. The user sends a slash command: the expanded text is the message, and the log says which command produced it

The project has a command file, `.claude/commands/release-notes.md`: a prompt template with `$1` and `$2`. The user types `/release-notes 1.4`. The file is read once, then: its template is expanded with what was typed, and the result is admitted as the user's message, like any prompt. In the same append `command.expanded` records where that text came from: the command's name and file, the fingerprint of the file as it was read (so the version that was used is known after the file changes), the arguments as typed, and that position 2 was used by the template and not given (it became empty text). The template also holds a command in backticks after `!` and an `@path`, which other harnesses run and read at this moment. Here nothing in a command file runs anything or reads anything: both stay in the text exactly as written, and the record lists them, for the user. The model is sent the expanded text and nothing else: there is no tool for commands, no list of them, and the request is the one a typed prompt of the same words would have made. The model can run `git log` and read the file itself, with its tools, which are decided like any call.

*Provider:* the model answers the expanded prompt.

*Engine:* offers slash commands (the project has command files).

```
-- the command is expanded and admitted: the message and the record of where it came from, in one append
  1  session.created
  2  inbox.enqueued u1 steer "Draft the release notes for version 1.4 from the commits ..."
  3  command.expanded u1 "/release-notes 1.4" (project) missing=$2 left as text: !`git log --oneline`, @docs/CHANGES.md
-- the turn runs on the expanded text
  4  execution.started exe_1
  5  baseline.set
  6  inbox.delivered u1
  7  step.started a1 attempt=1
  8  text.ended a1 "Here are the notes for 1.4. Which version came before it?"
  9  step.ended a1 finish=stop
 10  execution.succeeded exe_1
```

*UI:* u1 user (/release-notes 1.4) · a1 completed. *Claim:* released.

*Model sees next:* u1, a1.

*The reducer rejects:*
- after "the command is expanded and admitted: the message and the record of where it came from, in one append": `command.expanded u1 "/release-notes 1.4" (project) missing=$2 left as text: !`git log --oneline`, @docs/CHANGES.md` (invalid_transition). The record belongs to the admission it follows at once: it is written with it, never later.
- after "the command is expanded and admitted: the message and the record of where it came from, in one append": `command.expanded u9 "/release-notes 1.4" (project) missing=$2 left as text: !`git log --oneline`, @docs/CHANGES.md` (not_found). A command's record names a message that waits in the inbox.
- after "the turn runs on the expanded text": `command.expanded u1 "/release-notes 1.4" (project) missing=$2 left as text: !`git log --oneline`, @docs/CHANGES.md` (not_found). A delivered message is history: nothing is recorded about it afterwards.

#### 114. A command that names an agent: the session switches to it where the command's message is delivered

A command file may name an agent (`agent: reviewer`). The first thing the user types in a new session is `/review focus on the tests`. The command's text is admitted with its record, and the agent's definition is read then, once. Where the message is delivered, right before it, the session switches to the agent: no baseline is set yet, so `agent.switched` is the record alone and the first baseline carries the reviewer's instructions as its last section, exactly as for a session that was started as the reviewer. Later, while the model is answering a question, the user queues `/ship 1.4`, a command that runs under `captain`. A queued message waits for the turn in progress, and so does its switch: the reviewer answers the question as the reviewer. The switch waits in the log: `command.expanded` carries the agent's record as it was read when the command was sent, so a process that dies before the delivery and starts again makes the same switch. At the boundary where the queued message is delivered the switch is made first, as an appended instruction message and `agent.switched` (the baseline is frozen), then `settings.changed` because the captain names another model, then the turn's ending and the delivery. A command whose agent cannot be found sends nothing at all.

*Provider:* turn 1 (as the reviewer) answers. Turn 2 answers the question; the queued command's turn (as the captain, on the other model) answers.

*Engine:* offers agents (the project has agent definitions); slash commands (the project has command files).

```
-- the first message is a command that runs under the reviewer: the switch is recorded before the first baseline, which carries the agent
  1  session.created
  2  inbox.enqueued u1 steer "Review the uncommitted changes (git diff, and git diff --..."
  3  command.expanded u1 "/review focus on the tests" (project)
  4  execution.started exe_1
  5  agent.switched null
  6  baseline.set
  7  inbox.delivered u1
  8  step.started a1 attempt=1
  9  text.ended a1 "The tests do not cover the empty list."
 10  step.ended a1 finish=stop
 11  execution.succeeded exe_1
-- a question, and while it is answered the user queues a command that runs under the captain
 12  inbox.enqueued u2 steer "Which test is closest?"
 13  execution.started exe_2
 14  inbox.delivered u2
 15  step.started a2 attempt=1
 16  inbox.enqueued u3 queue "Prepare release 1.4 on a release branch."
 17  command.expanded u3 "/ship 1.4" (project)
 18  text.ended a2 "sum.test.ts."
 19  step.ended a2 finish=stop
-- where the queued command is delivered: the switch, the model change it brings, the turn's ending and the delivery
 20  instruction.appended i1 source=agent "The user switched you from the agent \"reviewer\" to the ag..."
 21  agent.switched i1
 22  settings.changed model=gpt-other reasoningEffort=high
 23  turn.ended
 24  inbox.delivered u3
 25  step.started a3 attempt=1 model=gpt-other
 26  text.ended a3 "Release 1.4 is prepared on release/1.4."
 27  step.ended a3 finish=stop
 28  execution.succeeded exe_2
```

*UI:* u1 user (/review focus on the tests) · a1 completed · u2 user · a2 completed · i1 instruction · u3 user (/ship 1.4) · a3 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, a2, i1, u3, a3.

#### 115. Live telemetry is on: the turn's log is the log it would be without, and its spans are sent as it runs

The user's own configuration turns `telemetry` on and names a collector. Nothing about the turn changes: no event is written for telemetry, no request carries anything of it, and the log is event for event the log of the same turn without it (this scenario's events are those of "One tool call, then an answer"). Beside the loop, the session's log and its request ledger are mapped to spans at the events where a span closes, with the mapping an export after the fact uses, so both give the same spans with the same IDs: the tool call when it has settled, each model call when its step has ended, the turn when the execution has. Each span is queued once and sent in the background. A collector that is slow, down or wrong costs the queue's memory and nothing else, and a project's configuration can turn the export off but never on. Message text, tool arguments and tool output are not in the spans unless the user's file asks for content.

*Provider:* step 1 streams text and one tool call; step 2 answers.

*Engine:* offers live telemetry (the user's configuration turns it on and names a collector).

```
-- the turn, as without telemetry
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
  7  text.ended a1 "Let me read the test."
  8  tool.called a1/call_1 read {"path":"a.test.ts"}
  9  tool.started a1/call_1 effect=read
 10  tool.settled a1/call_1 success "expect(add(1, 1)).toBe(3)"
 11  step.ended a1 finish=tool_calls
 12  step.started a2 attempt=1
 13  text.ended a2 "The expectation is wrong: 1 + 1 is 2."
 14  step.ended a2 finish=stop
 15  execution.succeeded exe_1
```

*UI:* u1 user · a1 completed [read success] · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, a2.

### Forks

#### 116. A fork continues from its parent's history

A session is forked at a step boundary. The fork is a session of its own (its own file, its own events from here on) whose history is the parent's up to the fork point: the first event of its own names the parent and the last inherited seq. It starts idle with an empty inbox, with the parent's baseline, settings and taint and the root session's cache key, so its first request is the parent's last request plus the new prompt. The parent is only read and may be working elsewhere meanwhile.

*Provider:* the parent answers one prompt; the fork answers another.

```
-- the parent's step is open
1-5  opening: session.created, inbox.enqueued u1, execution.started exe_1, baseline.set, inbox.delivered u1
  6  step.started a1 attempt=1
-- the parent's turn ends
  7  text.ended a1 "It adds two numbers."
  8  step.ended a1 finish=stop
  9  execution.succeeded exe_1
-- the fork is created and takes a prompt of its own
 10  session.created fork of ses_scenario through seq 9
 11  inbox.enqueued u2 steer "And subtract?"
 12  execution.started exe_2
 13  inbox.delivered u2
 14  step.started a2 attempt=1
 15  text.ended a2 "There is no subtract."
 16  step.ended a2 finish=stop
 17  execution.succeeded exe_2
```

*UI:* u1 user · a1 completed · u2 user · a2 completed. *Claim:* released.

*Model sees next:* u1, a1, u2, a2.

*The reducer rejects:*
- after "the parent's step is open": `session.created fork of ses_scenario through seq 6` (invalid_transition). A fork point is a step boundary: the history up to it must be whole.
- after "the parent's turn ends": `session.created fork of ses_scenario through seq 4` (invalid_range). A fork is folded onto its parent at exactly the seq it names.

<!-- scenarios:end -->

## What the reducer enforces

The first version of this page listed fourteen gaps (G1 to G14): sequences the loop must not write that the reducer
still accepted. G1 to G12 are closed. Each line names the rule, where it is tested, and how the fix differs from what
was proposed, if it does.

| Gap | Rule now enforced | Scenario |
| --- | --- | --- |
| G1 | `retry.scheduled` on an open step is rejected once the step has any part. After durable output the message fails first and the retry runs under a new one. | 20 |
| G2 | `retry.scheduled` is rejected for a non-retryable error, for a failed step whose own error is not a retryable provider error, and for a step that was interrupted or crashed. | 14, 23 to 25, 32 |
| G3 | A retry can name only the step in progress: the open step, or with none open the latest assistant message of this execution. Never during a compaction, never twice for the same failed message. | 20 |
| G4 | `execution.nextAttempt` is the attempt the next `step.started` must carry: the scheduled retry's after a failed message, 1 otherwise. A retry's attempt is always the previous attempt plus one. | 20 |
| G5 | A step, a compaction or an execution ends as interrupted only after `execution.interrupt_requested`, and only for its reason. After the request nothing that carries the work on is accepted. | 7 to 14, 42, 43 |
| G6 | `execution.succeeded` is rejected while anything waits in the inbox, or while a user, harness or assistant message added under this claim is unanswered. | 13, 16, 18, 20 |
| G7 | `execution.resumed` adds to `crashResumes` only when the claim was still `running`. A resume from `suspended` does not count. | 44, 45 |
| G8 | `tool.started` carries the tool's effect class. A `read` call cannot settle as `effect_unknown`, and recovery settles orphans from the recorded class. | 12, 34, 36 |
| G9 | `execution.interrupt_requested` is a durable event. Recovery that finds one finishes the interrupt and never resumes. | 38, 45 |
| G10 | `step.started` and `compaction.started` are rejected while there is no baseline. | 1 |
| G11 | An inbox item is delivered only when it is the oldest waiting item of its mode. A queued item also needs no steer waiting and a turn that has ended: `turn.ended` right before it, or nothing said under the claim yet. | 16, 18 |
| G12 | `synthetic.appended` and `instruction.appended` need a running claim. | 1 |

Where the fix is not the one proposed:

- **G4.** The pending attempt lives on the execution (`nextAttempt`) and not on the session. It survives a crash
  resume and a shutdown, because the retry was durably scheduled, and it ends with the claim.
- **G5 and G9 are one mechanism.** The proposal let a `step.failed` with `interrupted` start the wind-down. With the
  request event decided, that would leave two ways to write the same thing and two things for recovery to look for.
  The request is therefore required: `execution.interrupting` is set only by `execution.interrupt_requested`, a step
  closes as interrupted only while it is set, and `execution.interrupted` clears it. The request is accepted with a
  step open, between steps and during a compaction. The user can still type, withdraw input, rename the session and
  change its settings while an execution winds down.
- **G6 is looser in one place.** The proposal required a completed step since the claim was taken. An execution that
  added nothing the model has to answer may succeed too: the prompt was withdrawn before delivery, or the execution
  only compacted. Instruction and compaction messages do not need an answer; user and harness messages do.
- **G11** uses the same test as G6 for "would go idle", so a queued item is also held back after a failed step, a
  nudge or a delivered prompt that has no answer yet.
- **The interrupt marker is enforced too** (rule 9 below was only in the test checker). While a claim is held, a step
  that ended `interrupted` or `crashed` must be followed at once by `synthetic.appended` with origin `interrupt`.
  It is derived from the last message, so it adds no state. A fork taken between the two owes nothing.

What the reducer enforces for snapshots, checks and reverts, each with a scenario:

| Rule | Scenario |
| --- | --- |
| `checks.started` needs a running claim at a boundary, a model that has answered and no steer waiting (a queued item waits for the run). A run has one terminal event, `checks.finished` or `checks.failed`, and nothing else is accepted while it is open: no step, no delivery, no `execution.succeeded`. | 46, 51 |
| `turn.ended` needs a running claim at a boundary, a queued item waiting, no steer waiting, and a turn whose model has answered everything (an unanswered check report only when the verdict is `unresolved`). After it nothing is accepted but the delivery of that queued item. | 18, the queued-message scenario under Verification |
| `inbox.cancelled` needs an item that is waiting: a delivered prompt, or one withdrawn before, is rejected. | the withdrawn-prompt scenario under Steering |
| `session.archived` is rejected for an archived session, `session.unarchived` for one that is not. | the archive scenario under Happy paths |
| After `execution.interrupt_requested` an open run can only be closed as interrupted for that reason (`checks.failed`), before the execution is. | 51 |
| `execution.succeeded` carries what the gate found. A check report may be left unanswered only by an execution, or a turn before a queued message, that ends as `unresolved`. | 47, 48 |
| A `step_start` or `step_end` snapshot names the open step; any other snapshot names none. | 46 |
| `revert.started`, `history.reverted`, `revert.undo_started` and `history.restored` are accepted only while idle. A restore that changes files is announced first, and its record must name the announced target and undo point. Nothing starts while one is open. | 53 |
| Only the latest revert can be undone, by the `seq` of its `history.reverted`, restoring the snapshot taken before it; `execution.started` empties the list. Undoing puts back exactly the messages that revert excluded. | 54 |

What the reducer enforces for compaction, each with a scenario of the Compaction family or a test in
`test/message/reducer.test.ts`:

| Rule | Where |
| --- | --- |
| `compaction.started` needs a running claim at a boundary and a baseline. It records the cut (`keepFromSeq`), which may not lie before the cut of the compaction in force (what a checkpoint replaced stays replaced) nor after the event's own `seq` (nothing kept). The cut may lie inside the turn in progress, and inside the tail the previous compaction kept. | "A compaction in the middle of a long turn"; the reducer test "the cut is decided when a compaction starts" |
| While a compaction is open nothing else starts: no step, no delivery, no baseline, no settings change. It has one terminal event, `compaction.ended` or `compaction.failed`. | "A compaction that is due waits for the next user message" |
| `compaction.repair_requested` needs the open compaction and is accepted once. `compaction.ended` with `source: repaired` is rejected unless a repair was asked for. | "An invalid summary is repaired" |
| A compaction ends as interrupted only after `execution.interrupt_requested`, for its reason; recovery closes one a dead process left as crashed. Either way model history is unchanged. | "Cancel while the summary is being written", "The process dies during a compaction" |
| `baseline.set` is accepted again only after a compaction has completed. | "A compaction that is due waits for the next user message" |
| A revert or refusal range may hold a compaction. The compaction is then excluded like any message, and model history starts from the latest completed compaction that is not excluded; undoing the revert brings it back. | the reducer tests under "revert"; `test/engine/workspace.test.ts`, `test/engine/prefix.test.ts` |

How the loop decides (the policy is `packages/core/src/context/policy.ts`; the numbers are shares of the usable
window, which is the model's context window minus what is kept free for the answer):

1. Before every step the loop builds the request it would send and estimates its size: the provider's own count for
   the last step call when the request extends it, plus an estimate of what was appended since, plus a margin.
2. Below 65% nothing happens. From 65% a compaction is due at the next user-message boundary and not before: in the
   middle of a turn it would cost the model the thread of its work. From 80% it happens before the next step,
   wherever that is. Nobody knows the window (the provider did not say): nothing is compacted ahead of time.
3. The cut keeps the recent history that fits the tail budget word for word and never splits a step. What the next
   call answers is always kept by a normal compaction: the input that arrived since the model last spoke, or the
   last step with its results. An aggressive one keeps it only if it fits.
4. A normal compaction that would take out less than a quarter of what is in view is not made: while the request
   fits it is sent, and when it does not the compaction is aggressive at once. A compaction that did free less than
   a quarter of what it started from blocks the next one until the context has grown (the hold); if the request then
   no longer fits there is one aggressive compaction; if that frees too little as well, nothing more is tried.
5. A request the provider rejects as too large is compacted aggressively, whatever the estimate said. A second
   rejection right after such a compaction fails the execution.
6. The summary request is the step request of the part before the cut plus one prompt, both from the log. Its answer
   is bounded: the loop stops reading at twice the summary's limit, and a call is stopped at
   `compactionCallTimeoutMs` and not tried again. An unusable answer is asked for once more. After that the
   checkpoint is built without the model. Only a provider that cannot be used at all (signed out, the plan's limit,
   failing again and again) fails the execution, and history is then unchanged.

Two notes stay open on purpose:

### G13 (note). Recovering from context overflow leaves a failed row

- Rule: retry rules 2 and 5. Before output a retry is transparent, and overflow means "compact and rebuild, only
  if no output started".
- Sequence ("The provider rejects a request as too large"): `step.started a2` · `step.failed a2
  provider:context_overflow` · `compaction.started c1 overflow aggressive` · `compaction.ended` · `baseline.set` ·
  `step.started a3`. It is legal, but `compaction.started` needs a boundary, so `a2` must be closed. It is left as
  an empty failed message, and "not twice in a row" is enforced only by the loop (the policy's
  `decideAfterOverflow`).
- Not changed. The request builder already renders an assistant message with no parts as nothing, because a budget
  that runs out before output and a cancel before output leave the same row. Letting a compaction open inside an
  output-free step would cost more than it saves.

### G14 (note). An empty response has no failure shape

- Rule: retry rule 8, "One empty-response nudge, then fail."
- Sequence (scenario 28): the second empty response is `step.ended a2 finish=stop`, so the message is `completed`,
  and only `execution.failed` says why the turn stopped. A UI cannot mark that message as the failure.
- Not changed, because no UI needs it yet. If one does, add a `stepError` variant `empty` and close the second empty
  step with `step.failed`.

## Recovery at start-up

For each session `listClaimedSessions` returns, the log decides what recovery may write. The reducer accepts nothing
else.

1. **An interrupt was requested** (`execution.interrupting` is set). Finish it: settle every unsettled call, close
   the open step with `step.failed interrupted:<reason>` (or the open compaction with `compaction.failed`), append
   the marker if a step was closed, and write `execution.interrupted <reason>`. For `user` the session is now idle.
   For `shutdown` the claim is suspended; continue with case 3.
2. **The claim is `running` and no interrupt was requested.** The process crashed. Settle every unsettled call, close
   the open step with `step.failed crashed`, append the marker, then write `execution.resumed`, which counts the
   crash, or `execution.failed` when `crashResumes` has reached the cap. With no step open there is nothing to close
   and no marker. An execution with no turn (nothing was said under the claim and nothing waits: it was started only
   to make a compaction the user asked for) is not resumed: the open compaction is closed with `compaction.failed
   crashed`, and `execution.interrupt_requested user` · `execution.interrupted user` release the claim, as a clean
   shutdown of such an execution does. History is as it was.
3. **The claim is `suspended`.** The last process shut down cleanly. Write `execution.resumed`; it is not counted.

An open run of checks is closed with `checks.failed` in cases 1 and 2 (interrupted for the reason, or crashed). It
produced no result, so the gate runs the checks again when the execution is taken up; a check that kills the process
every time is stopped by the resume cap.

Recovery never writes `execution.succeeded`. A claim that is `running` with the model's answer durable and nothing
waiting looks finished, but whether it may end as done is the gate's decision, which needs the configuration and
may have to run checks. It is resumed like any other (scenario 40), and the loop ends it through the gate.

4. **No claim, and a revert is open** (`revert.started` or `revert.undo_started` without its closing event). The
   process died between announcing a restore and recording it, so the workspace is as it was, restored, or in
   between. Opening the session restores the announced target again (from the fields the event recorded: the target,
   the undo point, the paths to keep) and writes the closing event with the undo point of the first attempt. This
   happens whatever the resume mode is, and nothing starts until it is done.

An unsettled call settles from its recorded state alone: `pending` as `not_started`; `running` with effect `read`
as `error`; `running` with any other effect as `effect_unknown`. A step that was already closed as `interrupted` or
`crashed` but has no marker yet (the process died between the two) gets its marker first.

## Ambiguous rules and how the scenarios read them

1. **Where the interrupt marker goes** (cancel rule 6, "rendered into the next user message"). It is its own
   synthetic message right after the step closes, the same way for user, shutdown and crash, with different text.
   Merging it into the next user message on the wire is left to the request builder. No marker is written when
   nothing was cut short (shutdown or crash between steps).
2. **Partial text on a provider failure.** Settled. The partial text is kept, as on a cancel (cancel rule 3), so a
   failure in the middle of text counts as "after output" (scenario 20): the message fails and the model sees the
   half sentence. Tried against the live provider, a request that ends on that half sentence makes the model start
   its answer again; with a short harness note asking it to continue, it continues. The loop therefore appends a
   `synthetic.appended` with origin `continuation` between the failed message and the retry's new message.
3. **The attempt number after a crash resume or an overflow compaction.** The new step starts at attempt 1, because
   the crashed or overflowed step was closed without a retry being scheduled. Crash loops are bounded by the resume
   cap, and overflow by "once". A retry that was scheduled before the crash keeps its attempt.
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
10. **Shutdown writes the request too.** A SIGTERM handler appends `execution.interrupt_requested shutdown` before it
    stops anything. If the process is then killed before it finished, the next start completes the shutdown instead
    of counting a crash (scenario 45).

## What the loop must not do

The reducer rejects every item marked *(reducer)*, and the scenarios test it. The first three are about the order of
a durable write and a side effect, which no log can show; they are the loop's alone.

1. Run a tool before its `tool.called` is durable. If the append throws, run nothing (cancel rule 1).
2. Run a tool before its `tool.started` is durable. Otherwise a crash after the tool began leaves a `pending` call,
   which recovery settles as `not_started`, and that claim is false. Scenario 37 shows why the start must come first.
3. Record a call before its `tool_call.end`, or run a call cut off by the output limit (retry rule 6).
4. End a step while a call is unsettled, or give a step a second terminal event *(reducer)*.
5. Settle a call twice, including settling a finished call again on cancel. Settle a started call as `not_started`,
   or a call that started with effect `read` as `effect_unknown` *(reducer)*.
6. Deliver input in the middle of a step. Deliver a queued item before the turn in front of it has ended
   (`turn.ended`, which is the gate's verdict), or any item out of the order of its mode *(reducer)*.
7. Edit a stored row to steer. There is no edit event; a steer is always a new message.
8. Stop anything for a cancel or a shutdown before `execution.interrupt_requested` is durable. Keep working after
   it, start a tool after it, or end the execution with another reason or another terminal event *(reducer)*.
9. Leave out the interrupt marker after a step that was interrupted or crashed *(reducer)*.
10. Retry under the same message after output. Retry a non-retryable error, a refusal, or an interrupted or crashed
    step. Retry a message that is not the step in progress. Start a retry's new message with the wrong attempt, or
    any other step with an attempt other than 1 *(reducer)*.
11. Record a refusal as `step.failed` *(reducer)*.
12. Resume a crashed execution before every orphan is settled, the crashed step is closed and the marker is written.
    Resume after a user interrupt, or after one was requested *(reducer)*.
13. Start, deliver or step while the claim is suspended *(reducer)*.
14. Succeed while input waits, or while something the model was given has no answer *(reducer)*.
15. Start a step before the baseline is frozen, change the baseline before a compaction, or append a harness or
    instruction message without a running claim *(reducer)*.
16. Call a model other than the one the session's settings name, or change the settings while a step is open
    *(reducer)*.
17. End an execution as done without going through the gate: `execution.succeeded` always says what it rests on
    (passing checks, nothing to check, no checks configured, or failing checks left unresolved and why). Recovery
    in particular never writes it.
18. Run a check before `checks.started` is durable, run checks for an execution that was interrupted or failed, or
    write a run's results apart from what the gate decides from them. Parse the model's prose for an
    acknowledgement.
19. Rewrite or reorder history to tell the model about a failing check: the report is appended, and the next request
    extends the previous one.
20. Let the tool list depend on the configuration after the baseline is set. The acknowledgement tool is in the list
    when verification was not off at the session's first baseline, and stays as it was.
21. Stop the work because a snapshot could not be taken. The session carries on without undo and says so once
    (`snapshot.unavailable`); what snapshots leave out is recorded when it changes, not with every snapshot.
22. Restore the workspace before the restore is announced (`revert.started`) with its undo point, revert while an
    execution holds the claim *(reducer)*, or overwrite a file that was edited by hand since the target without the
    user having decided. A change that falls between two snapshots that do not bracket the harness's own work (a
    step's tools, a run of checks, a restore) was made by hand; so was one made while no snapshot could be taken.
23. Send a summary request built from anything that is not in the log: the cut and the prompt are durable
    (`compaction.started`) before the request is sent, and the rejected answer with the follow-up prompt
    (`compaction.repair_requested`) before the repair is. Render a checkpoint again: its text is frozen in
    `compaction.ended`, whatever the checkpoint code says later.
24. Ask for a summary more than twice in one compaction, wait for a summary without a bound on its length and its
    time, or fail an execution because the model could not summarise: the checkpoint is then built without it.
25. Compact while a step is open *(reducer)*, compact twice in a row because the first freed too little (the hold),
    or keep a tool result without the call it answers (a cut falls only between messages, and never inside a step
    that continued under a new message).
26. Change the tool list at a compaction. The history tools are in the list from the session's first baseline, so
    the list before a compaction, in its summary request and after it is the same.
27. Return excluded content through the history tools: a reverted or refused message can be neither found nor read,
    and a checkpoint, which is derived text, is not searched.
28. Run a call before it was decided (`decide`, from the mode, the call's effect class, the facts about its path
    arguments, the escalation the model asked for explicitly, the sandbox, the session's taint and the remembered
    approvals). Start a call the user was asked about before their approving answer, or a call that was denied
    *(reducer)*. Read a command's text, or an error's text, to decide anything: escalation is the shell call's
    `sandbox` argument and nothing else.
29. Decide or start a write while a command runs in the same session, or the other way round: a command could swap
    a link under the path that was checked. Calls that can change something (write, command, network, MCP) run one
    at a time, in the order the model wrote them, each decided when the one before it has its result. Reads run
    side by side and wait for nothing.
30. Wait for an answer when nobody is present, or turn a question into a yes by any setting. An unattended ask is a
    refusal the model reads (`approval.denied`, reason `unattended`), or with `unattended: "stop"` a refusal that
    ends the run (`execution.failed`, cause `approval`).
31. Record an answer that remembers something else than the chosen choice of the question said it would, or a
    session approval that is not stamped with the position of its own answer *(reducer)*. Ask twice about one call,
    or answer twice *(reducer)*. Remember a command or a command prefix: what is remembered is a capability.
32. Take an answer after an interrupt was requested *(reducer)*. The interrupt withdraws the question; the call
    settles as not started. A crash does the same through recovery. Nothing an unrecorded answer said is honoured.
33. Run a command unsandboxed that was decided to run sandboxed. The shell tool refuses when it cannot sandbox.
34. Store or show tool output before it was redacted, or redact it differently on a replay: the text in
    `tool.settled` is the redacted text, once.
35. Tell the user more than once that the session is tainted *(reducer)*, or clear taint by a compaction, a revert
    or a fork. Taint is derived from the log (`deriveTaint` over every tool result that started, with the path
    facts recorded at `tool.started`); only `taint.cleared`, which the user asks for, starts the fold again.
36. Run the project's checks with more than a model's command gets without a question: they run in the sandbox
    wherever commands are sandboxed, with no network and no extra directory, and where there is no sandbox they are
    not run (mode `full` aside).
