# Architecture

light-harness is a coding-agent harness built around one idea: a session is an append-only log of events in SQLite,
and everything else (the messages a UI shows, the request sent to the model) is computed from that log.

This page describes the contracts in `packages/core`: the event schema, the reducer that folds it, and what the
store, the request builder, the provider and the tools promise each other. The step loop (`engine/`) is built on
them; `docs/step-loop-scenarios.md` is its specification, and `test/engine/conformance.test.ts` drives the loop
through every scenario in it.

Two things make a turn's work checkable and undoable, and both are recorded in the same log. The workspace is
recorded as snapshots around everything that can change it, so any turn can be diffed and reverted. And a turn ends
as done only through the verification gate: the harness runs the project's declared checks itself and takes the
result as a fact, instead of asking the model whether it verified its work.

## Package layout

```
packages/core/src
  validate.ts     tiny runtime validators; every stored type is declared once and its TypeScript type is inferred
  id.ts           branded IDs: SessionId, MessageId, ExecutionId, RequestId, CallId
  content.ts      text and media parts; BlobRef into the content-addressed blob table
  interrupt.ts    the abort token with an explicit InterruptReason
  event/          durable.ts (the event schema), ephemeral.ts (streaming deltas), decode.ts (the SQLite boundary)
  message/        message.ts (projection types), reducer.ts (state + event -> state), history.ts (model view, row diff)
  store/          store.ts (the Store interface), schema.ts (SQLite DDL), sqlite.ts (the store on bun:sqlite)
  request/        request.ts (ModelRequest and its blocks), canonical.ts, prefix.ts (hashing and the prefix check),
                  build.ts (the request builder), build-break.ts (which prefix breaks are legitimate)
  instructions/   sources, the baseline, discovery of AGENTS.md files, change detection
  provider/       provider.ts (stream events), error.ts (error taxonomy), usage.ts, openai-responses*.ts
  tool/           tool.ts (Tool, ToolContext, ToolResult), runtime.ts (one call to its terminal outcome), cap.ts
  tools/          the standard tools: read, write, edit, ls, glob, grep, shell
  engine/         the step loop: engine.ts (sessions, the drain, cancel, retries, the verification gate, revert),
                  recovery.ts (start-up recovery), state.ts (what the loop reads off the projection),
                  workspace.ts (what it reads off the log about snapshots), constants.ts (limits and frozen texts),
                  channel.ts (the event stream), clock.ts
  snapshot/       the working tree as git tree objects in a private git directory: take, diff, restore, prune
  config/         the user and project configuration files: checks, verification mode
  verify/         which checks apply, running them, the report the model is shown, the gate decision, the evidence
  testing/        fake-provider.ts (scripted provider for tests)
  auth/           ChatGPT sign-in (owned by the model layer)
  sandbox/        built by its own track on top of these contracts
```

Naming: a lowercase export such as `message` or `usage` is a validator; the PascalCase export of the same name is its
type. Dependencies point one way: `event` knows nothing about `message`, `store` or the step loop; `provider` and
`tool` know nothing about sessions.

Entry points: `@light-harness/core` exports the contracts, the SQLite store, the Responses provider, the request
builder, instructions, the tool runtime, the standard tools and `brand`. Subpaths: `/store/sqlite`,
`/provider/openai-responses` (with the wire-level pieces), `/request`, `/instructions`, `/tools`, `/engine`, `/auth/chatgpt`,
`/testing` (the fake provider) and `/testing/scenarios` (the step-loop scenarios and their vocabulary).

## Single-owner files

Three places are changed by one owner at a time, never in parallel branches. Other tracks ask for changes.

| File | Why |
| --- | --- |
| `event/durable.ts` and `message/reducer.ts` | A new event must be folded by the reducer and rendered by the request builder. The exhaustive `switch` and the `SCOPE` table make a missed case a compile error, but only if both change together. |
| `request/build.ts` | It alone decides what bytes the model sees. Two people changing it independently is how prefix breaks appear. |
| `engine/engine.ts` (the step loop) | It owns the order of durable writes around a model call and its tools. |

## Durable events

| Group | Events |
| --- | --- |
| Session | `session.created` (cwd, title, lineage, settings), `session.renamed`, `session.archived`, `session.unarchived`, `settings.changed` |
| Frozen prefix | `baseline.set` (instructions, tools, source fingerprints), `instruction.appended` (source, text, fingerprint) |
| Inbox | `inbox.enqueued`, `inbox.delivery_changed`, `inbox.cancelled`, `inbox.delivered`, `synthetic.appended` |
| Execution | `execution.started`, `execution.interrupt_requested`, `execution.interrupted`, `execution.resumed`, `execution.succeeded`, `execution.failed` |
| Step | `step.started`, `step.ended`, `step.failed`, `step.refused`, `retry.scheduled` |
| Model output | `text.ended`, `reasoning.ended` |
| Tools | `tool.called`, `tool.started` (with the effect class), `tool.settled` |
| Compaction | `compaction.started`, `compaction.ended`, `compaction.failed` |
| Workspace | `snapshot.taken` (ID, the point it was taken at, the step it belongs to), `snapshot.unavailable`, `snapshot.coverage` (files and nested repositories snapshots leave out) |
| Verification | `checks.started`, `checks.finished` (the evidence), `checks.failed`; the gate's outcome is on `execution.succeeded` |
| History ranges | `revert.started`, `history.reverted` (with the record of the restore), `revert.undo_started`, `history.restored`, `revert.failed` |

Nothing has been released, so every event is at version 1. From the first release on, a change to an event's data
is a new version with a decoder for the old one.

## What each contract guarantees

**Events** (`event/`)
- Each durable event records one fact and carries a version. Objects are strict: an unknown field, type or version
  is an error on read, never something to skip.
- Only boundaries are stored. Streaming deltas are ephemeral; the event that ends an item carries its whole value.
- Text the model will see (tool output, instructions, the interrupt marker, the compaction summary) is frozen in the
  event when it is written and never rendered again.
- What the harness needs to know later is a field, never something parsed back out of that text: the fingerprint of
  each instruction source, the effect class of a started tool, the model and effort of the session.
- An interruption always has a reason (`user` or `shutdown`). There is no default, in the schema or in the abort token.
- Nothing is deleted. Revert and refusal are ranges of `seq` that set a flag; compaction is a marker; a fork is
  "the parent's events up to `throughSeq`, then my own, starting at `throughSeq + 1`".
- What happened to the workspace is recorded as snapshot IDs, never as file lists. From `snapshot.taken` events
  alone: a step changed what differs between its `step_start` and `step_end` snapshots (a step without them could
  not change files; one that was cut short has no `step_end`, and the next snapshot bounds it); a turn changed what
  differs between the `delivery` snapshot before its input and the turn's last snapshot; the snapshot current when
  a message was sent is the `delivery` snapshot right before its `inbox.delivered`. The IDs belong to the private
  git directory of the session's working directory (`session.created.cwd`).
- `execution.succeeded` says what "done" rests on: `passed` with the evidence, `not_needed` (nothing the checks
  cover changed), `not_configured`, or `unresolved` with the failing checks, the reason (`acknowledged`,
  `max_rounds`, `report_mode`) and the evidence. A client shows these as different endings.

**Reducer and projection** (`message/`)
- `reduce(state, event)` is pure and is the only code that turns events into state. The store runs it inside the
  append transaction, so an event it rejects is never written. Rebuilding from the log always equals the live rows.
- It rejects every sequence the step loop must not write. The list, with a scenario and a rejection test for each,
  is in `docs/step-loop-scenarios.md`. In short:
  - *Shape of the log.* `seq` is dense. A message enters history only at a step boundary and only under a running
    execution claim. A step and a compaction need a baseline. A step has one terminal event, after all its calls
    have settled.
  - *Tool calls.* A call is `pending`, then optionally `running`, then `settled` exactly once. From `pending` it
    settles as `not_started` or `error`; from `running` as `success`, `error` or `effect_unknown`. `tool.started`
    records the tool's effect class, and a `read` call never settles as `effect_unknown`. Calls are keyed by
    (assistant message, provider call ID), because providers reuse call IDs.
  - *Retries.* `retry.scheduled` is accepted only for a retryable provider error and only for the step in progress:
    on the open step before it has any durable output (the retry is transparent), or on the latest message of the
    execution after it failed with that kind of error (the retry runs under a new message). Attempts count up by
    one, and `execution.nextAttempt` is the attempt the next `step.started` must carry.
  - *Interrupts.* A cancel or a shutdown is first recorded as `execution.interrupt_requested`. From then on only
    events that wind the execution down are accepted: flushing visible text, settling calls, closing the open step
    or compaction as interrupted for that reason, the interrupt marker, and `execution.interrupted` for that reason.
    A step that ended `interrupted` or `crashed` must be followed at once by the interrupt marker.
  - *Inbox.* Items are delivered oldest first within their mode. A steer is delivered at any step boundary. A
    queued item waits until no steer waits and the session would otherwise go idle.
  - *Going idle.* `execution.succeeded` is rejected while input waits, or while a user, harness or assistant message
    added under the claim has no answer (the last step failed, asked for tools, or was followed by a new message).
  - *Resumes.* `execution.resumed` counts toward `crashResumes` only when the claim was still `running`, which means
    the previous process died. A resume after a clean shutdown is not counted.
  - *Settings.* A step calls the model `session.settings` names. Settings change only at a step boundary.
  - *Ranges.* Revert and refusal ranges never reach back past the latest compaction.
  - *Checks.* A run starts only when the session would otherwise go idle, has one terminal event, and nothing else
    happens while it is open. `execution.succeeded` is rejected while a run is open, and a check report may stay
    unanswered only when the execution ends as `unresolved`.
  - *Reverts.* A revert and its undo happen only while no execution holds the claim. One that restores files is
    announced first (`revert.started`), nothing starts while it is open, and its record must be of the announced
    restore. Only the latest revert can be undone, until an execution starts; the undo puts back exactly the
    messages that revert excluded.
- The session state also holds what the loop decides from: the latest snapshot and what snapshots leave out; the
  workspace state checks are selected against (`verification.verified`: the first snapshot, then the state at each
  verification that passed) and the latest run of checks; and the reverts that can still be undone.
- `selectModelHistory` defines what the model sees: non-excluded messages, starting at the latest completed
  compaction (its summary first, then the messages it kept), together with the settings and the root session ID the
  request's parameters come from. Because every call is settled before its step ends, history is rendered as stored,
  with no repair at read time.

**Store** (`store/`)
- `append` is the only way state changes: validate, assign the next `seq`, reduce, write the changed rows, insert the
  event, all in one transaction. The interface is synchronous, so "the tool call is durable before the tool runs" is
  the order of two statements.
- One writer process. `seq` is dense per session and is the only ordering; IDs and timestamps never order anything.
- The request ledger stores, for each model call, the ordered block hashes of the request and the usage.
- Media lives in a blob table keyed by SHA-256, so a reload shows the same image and a block that refers to it hashes the same.
- Every failure the contract names is a `StoreError` with a code, never a raw SQLite error: `session_not_found`,
  `seq_conflict`, `request_not_pending`, `duplicate_request`, `locked` (another writer has the file open, or held the
  write lock longer than the store waits) and `schema_mismatch` (the file is from another schema version).

**Request** (`request/`)
- A request is an ordered list of blocks: parameters, each tool, the instructions, each input item. Everything in a
  request is in exactly one block except `toolChoice`, which is not part of the provider's cached prefix.
- `canonicalJson` gives one byte sequence per value regardless of key order. A block's hash is the SHA-256 of that.
- `comparePrefix` answers the question the cache cares about: is this request the previous one plus appended
  blocks? If not, it names the first changed block. The runtime ledger and the CI gate use the same function.
- `buildRequest(projection, options)` is a pure function of stored state. The parameters block comes from the log
  too: the model and the reasoning effort are `session.settings`, and the cache key is the ID of the root of the
  session's fork chain, so a fork's first request is its parent's request. A caller cannot pass another model.
- The system prompt and tool list are stored in the log (`baseline.set`) and change only after a compaction. Anything
  else that changes is appended as a message.
- A request may fail to extend the previous one only after `compaction.ended`, `history.reverted`, `step.refused` or
  `settings.changed`. `checkPrefix` takes the events appended since the previous request and reports any other
  break as a violation. A check report is an appended message and breaks nothing; a revert is one of the four.

**Instructions** (`instructions/`)
- The baseline is the base system prompt followed by one section per source (AGENTS.md files, the environment, the
  date). `baseline.set` records, next to the text, the fingerprint of each source's value.
- A source that changes later is appended as an `instruction.appended` message with its new text and fingerprint
  (`null` when the source is gone). It is appended under a running execution: a change noticed while the session is
  idle is written when the next execution starts.
- What the model currently has per source is a fold over those fingerprints in the model's view of the log. Nothing
  reads rendered text back, so a reverted, refused or compacted-away message is detected again by itself.

**Provider** (`provider/`)
- `stream(request, signal)` yields normalised events and ends with exactly one `finish` or `error`. Failures are
  classified, not thrown. On abort the stream just stops.
- Every error has a kind, and the kind fixes whether it may be retried: rate limit, provider failure, transport and
  incomplete stream are; auth, usage limit, content policy, invalid request and context overflow are not.
- An error carries the provider's request ID as `requestId` when a response supplied one; the message never contains
  it. A `transport` error has a `reason`: `connection` (could not send, or the connection broke) or `stalled`
  (nothing arrived within the idle timeout).
- Provider-owned payloads (encrypted reasoning, item phase) travel as opaque `providerData` and are replayed verbatim.
- A provider does not retry and does not change the request. The step loop owns the single attempt budget.

**Tool** (`tool/`)
- A tool declares an effect class (`read`, `write`, `exec`, `network`). Sandbox and approval decisions use the class,
  and the step loop records it in `tool.started`.
- A tool returns the text for the model once. After `tool.settled` is written that text is replayed byte for byte;
  `truncation` records that it was capped and where the full output is.
- The context carries the abort signal with its reason. A tool that is aborted returns what it observed.
- The context carries `putBlob`, which stores bytes in the blob table and returns the reference a tool lists in its
  result's `attachments`. The tool runtime supplies it from its options (`store.putBlob`), so a tool never sees the store.

**Snapshot, config, verify** (`snapshot/`, `config/`, `verify/`)
- `openSnapshots(cwd)` gives `take`, `changedFiles`, `diff` and `restore` on a private git directory per workspace
  that never touches the user's repository, or a typed `unavailable` (no git, an old git, no storage). A restore
  takes its own "before" snapshot, never deletes an ignored file, and reports what it left alone.
- `loadConfig` reads the user and project files with strict validation: an unknown key is an error.
- `decideGate` is pure: finish, run these checks, report and continue, or finish unresolved. `renderReport` is the
  deterministic text the model is shown; `acknowledgeTool` is the tool (`report_check_failure`) with which the model
  says it cannot fix a failing check. An acknowledgement is that tool call, never parsed prose; a check may be
  named by its name or by the label the report shows it with.

**Engine** (`engine/`)
- `createEngine` takes everything it touches as a dependency (store, provider, tools, clock, ID generators, the
  jitter source, limits, the data directory, the snapshot opener, the configuration loader, the check runner), so
  tests inject fakes. A session offers `send` (steer or queue), `start`, `interrupt`, `setSettings`, `revert`,
  `undoRevert`, an event stream and `close`. `validateSettings` rejects a model the provider does not offer, naming
  the ones it does.
- One step is one model call. Before every step the loop re-reads the projection and decides from stored state alone;
  it keeps no conversation state in memory. Events that are decided together are appended in one transaction.
- `tool.called` is durable when the call finishes streaming and `tool.started` right before the tool runs, both
  before any side effect. An interrupt is durable (`execution.interrupt_requested`) before anything is aborted.
- One attempt budget per logical step; the numbers and every text the loop freezes into the log are in
  `engine/constants.ts`.
- Opening a session that still holds a claim recovers it (`engine/recovery.ts`), then resumes it.
- The event stream never slows the loop down: durable events are queued in order, and deltas a reader has not taken
  yet are merged per item.
- `Engine.close()` is the hook a process calls before it exits: every session is stopped as a shutdown, which leaves
  its execution suspended and resumable. If the process dies without it, a guard process kills the process group of
  every running shell command (`tools/shell.ts`).
- *Snapshots.* One is taken, and recorded, where the workspace can have changed: before input is delivered (always:
  it is what a revert to before that input restores, and it captures what the user changed by hand in between);
  right before the tools of a step run and right after them, when at least one of its calls has a side-effecting
  class; around a run of checks; around a restore. A step with no call, or only `read` calls, takes none. What
  snapshots leave out (`snapshot.coverage`) is recorded when it changes. A snapshot that cannot be taken never
  stops the work: `snapshot.unavailable` is written once per change and the session carries on without undo.
- *The verification gate.* The configuration is read when an execution starts, so a change takes effect at the next
  turn. When the execution would otherwise succeed, the loop snapshots the workspace, diffs it against the state at
  the last verification that passed, selects the checks whose `when` patterns match, and runs them
  (`checks.started` is durable first; an interrupt stops them like tools). The results and the decision are one
  append: `checks.finished` with the terminal event, or with the report that sends the model back. The turn ends
  unresolved when the model acknowledges the failure with the tool, after `maxRounds` reports, or in `report` mode,
  where the model is shown the failure and not sent back. Without snapshots nobody knows which files changed, so
  every check runs after a turn in which a side-effecting call ran. A configuration that cannot be loaded fails the
  execution before anything is sent.
- *The acknowledgement tool* is in a session's frozen tool list when verification was not off as its first baseline
  was set, whether or not a check is configured, and the list keeps it or lacks it from then on (also across a
  compaction), so a configuration change never changes the list. The tool runtime always has it.
- *Revert.* `revert()` returns the session to the state before a user message (by default the latest): it looks
  (a dry run of the restore, and which of those files were changed outside the harness's own work since), records
  the workspace as it is, announces the restore, restores, and records the result with `history.reverted`. Files
  edited by hand since are never overwritten silently: the default is to stop and report them, and the caller
  chooses to overwrite (the undo point keeps them) or to keep them. A target with no snapshot rewinds the
  conversation only, and says so. `undoRevert()` restores the snapshot taken before the latest revert and puts its
  messages back. Both work only while idle; a session opened with a restore still open finishes it.
- One model call has a wall-clock limit (`modelCallTimeoutMs`, 30 minutes by default, `0` for none). A call still
  running then fails as a `transport` error with reason `timeout` and is retried within the attempt budget.
- A diagnostic about a session (a prefix violation, an internal error, a tool that threw) is also an ephemeral
  `diagnostic` event of that session's stream, so a client can show it.

## How the loop writes the common sequences

These are the shapes the scenarios spell out event by event.

- **A turn.** `inbox.enqueued` · `execution.started` · `baseline.set` (first turn only) · `inbox.delivered` · for
  each step `step.started`, the output events, `tool.started` and `tool.settled` per call, `step.ended` ·
  `execution.succeeded`.
- **A cancel or a shutdown.** `execution.interrupt_requested`, written the moment the abort fires · the visible
  partial text · one `tool.settled` per unsettled call · `step.failed` as interrupted · the interrupt marker ·
  `execution.interrupted`. A `user` interrupt releases the claim; a `shutdown` keeps it suspended for the next start.
- **A provider failure.** Before durable output: `retry.scheduled` and the next attempt under the same message.
  After output: `step.failed` · `retry.scheduled` · a `continuation` note asking the model to carry on where it
  stopped · `step.started` under a new message with the scheduled attempt.
- **A model or effort change.** `settings.changed` at a step boundary; the next `step.started` names the new model.
- **Recovery at start-up.** For each claimed session: finish a requested interrupt, or close the crashed step (and
  an open run of checks) and write `execution.resumed`, or resume a suspended claim. Recovery never ends an
  execution as done; the loop does, through the gate. A revert whose restore was announced and not recorded is
  finished. The exact procedure is in `docs/step-loop-scenarios.md`.
- **A turn that changes files, with checks.** `snapshot.taken delivery` · `inbox.delivered` · per step that can
  change files `snapshot.taken step_start` before its tools and `snapshot.taken step_end` after them · the answer ·
  `snapshot.taken checks_start` · `checks.started` · `snapshot.taken checks_end` · then in one append
  `checks.finished` with `execution.succeeded` (passed), or with `synthetic.appended check_report` and the loop
  carries on.
- **A revert.** While idle: `snapshot.taken restore_start` · `revert.started` (target, undo point) · the restore ·
  `snapshot.taken restore_end` · `history.reverted` with the record. Its undo is the same shape with
  `revert.undo_started` and `history.restored`.

## The only provider

The model layer talks to OpenAI's Responses API through "Sign in with ChatGPT". That flow keeps no conversation state
on the server, so the full history is sent on every call and an unchanged prefix is what makes the call cheap.
