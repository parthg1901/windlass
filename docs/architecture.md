# Architecture

light-harness is a coding-agent harness built around one idea: a session is an append-only log of events in SQLite,
and everything else (the messages a UI shows, the request sent to the model) is computed from that log. Every
session has a database file of its own, so the unit of the single-writer rule is the session, not the machine:
two terminals, an editor and the eval runner each work in their own sessions at once.

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
  store/          store.ts (the Store and SessionStores interfaces), schema.ts (SQLite DDL), sqlite.ts (one
                  database on bun:sqlite), sqlite-lock.ts (its single writer), directory.ts (one database per
                  session, the listing index), blobs.ts (media shared by all sessions), history-index.ts (the
                  full-text index the history tools search, built lazily in the session's own database)
  assembly.ts     createHarness: the real engine on the data directory, for the CLI and the ACP server alike
  request/        request.ts (ModelRequest and its blocks), canonical.ts, prefix.ts (hashing and the prefix check),
                  build.ts (the request builder), build-break.ts (which prefix breaks are legitimate)
  instructions/   sources, the baseline, discovery of AGENTS.md files, change detection
  provider/       provider.ts (stream events), error.ts (error taxonomy), usage.ts, openai-responses*.ts
  tool/           tool.ts (Tool, ToolContext, ToolResult), runtime.ts (one call to its terminal outcome), cap.ts
  tools/          the standard tools: read, write, edit, ls, glob, grep, shell
  context/        conversations that outgrow the context window, without I/O: estimate.ts (the size of the next
                  request), policy.ts (when to compact and how hard), tail.ts (what is kept word for word),
                  summary.ts (the summary request, its check, its bounds), checkpoint.ts (the frozen text that
                  replaces the removed history), history-tools.ts and history-search.ts (the history tools'
                  shapes, texts and search)
  engine/         the step loop: engine.ts (sessions, the drain, cancel, retries, compaction, the verification gate,
                  revert), history.ts (the history tools as the loop offers them),
                  recovery.ts (start-up recovery), replay.ts (what a replay may change, its changed baseline),
                  spawn.ts (the subagent and background tools, what is read off a child's log),
                  worktree.ts (a subagent's git worktree and the merge back), state.ts (what the loop reads off the projection),
                  workspace.ts (what it reads off the log about snapshots), constants.ts (limits and frozen texts),
                  channel.ts (the event stream), clock.ts
  snapshot/       the working tree as git tree objects in a private git directory: take, diff, restore, prune
  config/         the user and project configuration files: checks, verification mode
  verify/         which checks apply, running them, the report the model is shown, the gate decision, the evidence
  testing/        fake-provider.ts (scripted provider for tests)
  auth/           ChatGPT sign-in (owned by the model layer)
  sandbox/        the OS sandbox for commands: policy.ts (what a command may write, read and reach), bwrap.ts
                  and seatbelt.ts (Linux and macOS), detect.ts, command.ts (the policy of a command in a
                  session's workspace: its temp directory, the git hardening)
  replay/         a recorded session as a tape, the matcher, the replaying tool executor, the divergence report
  approval/       the decision layer, without I/O: decide.ts (run, run sandboxed, ask or deny), policy.ts (the
                  modes and the configuration section), paths.ts (where a path argument really points),
                  escalation.ts (the shell call's explicit `sandbox` argument, the hint), grants.ts (remembered
                  approvals), taint.ts, redact.ts, record.ts (these shapes as the log stores them, and the
                  history taint is folded from)
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
| Session | `session.created` (cwd, title, settings, and the lineage: a `fork` of a parent through a seq, a `spawn` by a parent's tool call with its depth and worktree, a `replay` of a recording with its policy and what was changed), `session.renamed`, `session.archived`, `session.unarchived`, `settings.changed` |
| Frozen prefix | `baseline.set` (instructions, tools, source fingerprints), `instruction.appended` (source, text, fingerprint) |
| Inbox | `inbox.enqueued`, `inbox.delivery_changed`, `inbox.cancelled`, `inbox.delivered`, `turn.ended` (a turn ends because a queued message waits), `synthetic.appended` |
| Execution | `execution.started`, `execution.interrupt_requested`, `execution.interrupted`, `execution.resumed`, `execution.succeeded`, `execution.failed` (`cause: "approval"` when a call nobody could approve ended the run, `cause: "replay"` when a replay ended where the model had not answered) |
| Step | `step.started`, `step.ended`, `step.failed`, `step.refused`, `retry.scheduled` |
| Model output | `text.ended`, `reasoning.ended` |
| Tools | `tool.called`, `tool.started` (with the effect class, and what the approval layer let the call run under: mode, path facts, sandbox and its extra access), `tool.settled` |
| Approval | `approval.requested` (the question, its choices and what each remembers, what it is about, how the call runs if approved, the path facts and the escalation it was decided from), `approval.answered` (the choice, the note, the approvals it created), `approval.denied` (by the policy, or because nobody was present; whether it ends the run), `taint.noticed` (the first source, the sentence the user was shown), `taint.cleared` |
| Spawned work | `spawn.started` (a subagent's child session, or a background command with its log file; the call that started it; whether it runs in the background), `spawn.ended` (completed, failed, stopped or lost; the exit code; a subagent's usage, taint and worktree merge) |
| Replay | `replay.call` (per call: matched, normalised, dropped, diverged or off the recording; whether the tool ran for real), `replay.diverged` (the copy the replay carries on in, and the snapshot it was restored from), `replay.ended` (the outcome, the reason, the report) |
| Compaction | `compaction.started` (the trigger, the mode, the cut, the frozen prompt, the size it started from), `compaction.repair_requested` (the rejected answer and the follow-up prompt), `compaction.ended` (the frozen checkpoint, where its summary came from, the size after), `compaction.failed` |
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
  "the parent's events up to `throughSeq`, then my own, starting at `throughSeq + 1`". A subagent and a replay
  inherit no events: they name the session they come from and start at `seq` 1. A range may hold a
  compaction, which is then excluded like any message: reverting to before a compaction undoes it for the model.
- A model call can be rebuilt from the log alone, a compaction's summary calls included: the cut, the prompt and the
  one repair of a compaction are fields of its events, written before the request they shape is sent.
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
    queued item waits until no steer waits and the turn before it has ended: `turn.ended`, with what the gate
    found, comes right before its delivery and nothing may come between them. Only as the first input under a claim
    does a queued item follow no turn. A waiting item can be withdrawn (`inbox.cancelled`); a delivered one cannot.
  - *Archiving.* `session.archived` is rejected for an archived session and `session.unarchived` for one that is
    not: each event records a change.
  - *Going idle.* `execution.succeeded` is rejected while input waits, or while a user, harness or assistant message
    added under the claim has no answer (the last step failed, asked for tools, or was followed by a new message).
  - *Resumes.* `execution.resumed` counts toward `crashResumes` only when the claim was still `running`, which means
    the previous process died. A resume after a clean shutdown is not counted.
  - *Settings.* A step calls the model `session.settings` names. Settings change only at a step boundary.
  - *Compaction.* A compaction starts at a boundary under a running claim and records its cut, which never lies
    before the cut of the compaction in force. It asks for one repair at most, and ends as `repaired` only after it
    did. Nothing else starts while it is open.
  - *Ranges.* A revert or refusal range starts no later than the event that makes it. It may hold a compaction; the
    compaction model history starts from is always the latest completed one that is not excluded, so an undo of the
    revert brings the checkpoint back.
  - *Checks.* A run starts only when the model has answered and no steer waits (a queued item waits for the
    run), has one terminal event, and nothing else happens while it is open. `execution.succeeded` is rejected
    while a run is open, and a check report may stay unanswered only when the execution, or the turn before a
    queued message, ends as `unresolved`.
  - *Spawned work.* `spawn.started` is written by a tool call that is running, once per piece of work, and never
    for a child that is still running; `spawn.ended` only for work that is running. A fork is created only at a
    step boundary of its parent, at exactly the seq it names.
  - *Replay.* `replay.call`, `replay.diverged` and `replay.ended` are accepted only in a replay session; a matched
    call names the recorded call it matched and only a matched call does; a replay leaves its recording once, never
    under the `stop` policy, and ends once.
  - *Reverts.* A revert and its undo happen only while no execution holds the claim. One that restores files is
    announced first (`revert.started`), nothing starts while it is open, and its record must be of the announced
    restore. Only the latest revert can be undone, until an execution starts; the undo puts back exactly the
    messages that revert excluded.
- The session state also holds what the session spawned (`spawned`: the work that is running, every child it
  ever started, and what the children's model calls cost, added up from each `spawn.ended`) and, for a replay,
  the copy it carries on in and how it ended (`replay`).
- The session state also holds what the loop decides from: the latest snapshot and what snapshots leave out; the
  workspace state checks are selected against (`verification.verified`: the first snapshot, then the state at each
  verification that passed) and the latest run of checks; and the reverts that can still be undone.
- `selectModelHistory` defines what the model sees: non-excluded messages, starting at the latest completed
  compaction that is not excluded (its checkpoint first, then the messages it kept, which may be the last steps of
  the turn in progress), together with the settings and the root session ID the
  request's parameters come from. Because every call is settled before its step ends, history is rendered as stored,
  with no repair at read time.

**Store** (`store/`)
- `append` is the only way state changes: validate, assign the next `seq`, reduce, write the changed rows, insert the
  event, all in one transaction. The interface is synchronous, so "the tool call is durable before the tool runs" is
  the order of two statements.
- One writer per database file, and the harness keeps one file per session (see "Where sessions live"). `seq` is
  dense per session and is the only ordering; IDs and timestamps never order anything.
- The request ledger stores, for each model call, the ordered block hashes of the request and the usage. It is in
  the session's own file.
- Media lives in a blob store keyed by SHA-256 that all sessions share, so a reload shows the same image and a
  block that refers to it hashes the same.
- `searchMessages` and `readMessageAt` are what the history tools use: every message that is not excluded, also the
  ones a compaction took out of the model's view, never a checkpoint. The SQLite store answers from a full-text
  index (FTS5) in the session's own database. The index is derived data, like the listing cache: nothing is written
  for it when an event is appended; a search first indexes, in one transaction, the messages that ended since the
  last search (the first search of a session indexes all of it: about 0.6 s for 16 MB of text on the development
  machine). Exclusions are not in the index: the search joins the message rows and leaves out what is excluded at
  that moment, so a revert, its undo and a refusal need no index update. Where SQLite has no FTS5, on a read-only
  connection, and when the index finds nothing (a term inside a longer word), the messages are scanned instead.
- Every failure the contract names is a `StoreError` with a code, never a raw SQLite error: `session_not_found`,
  `seq_conflict`, `request_not_pending`, `duplicate_request`, `locked` (another writer has the file open, or held the
  write lock longer than the store waits; for a session, a `SessionInUseError` that names the process),
  `schema_mismatch` (the file is from another schema version), `parent_missing` (a fork's inherited events were
  asked for and its parent's file is gone), `read_only` and `ambiguous_session`.

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
- `buildCompactionRequest(projection)` is the summary request of the open compaction: the step request of the part
  before the cut plus the frozen prompt and, after a repair was asked for, the rejected answer and the follow-up.
  It reads what it summarises from the provider's cache, and it is a function of stored state like every request.
- An assistant part that has no provider data to replay (text flushed from a response that was cut short, a part
  shown to another model than the one that wrote it, the rejected answer in a repair request) is sent with an item
  ID derived from the stored message and the part's position. The provider gives an assistant item without an ID a
  new one on every request, and never reads such an item, or anything after it, from its prompt cache (measured:
  0 of 7,631 tokens cached without the ID, 7,424 with it).

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

**Approval and the sandbox** (`approval/`, `sandbox/`, `engine/approval.ts`; for users: `docs/safety.md`)
- `decide` is pure. It is given the mode, the call's effect class and origin, the facts about its path arguments
  (`pathFact`: the real path with every link followed, and whether it lies in the workspace, in `.git` or the
  harness's project directory, outside, or in a path the sandbox hides), the escalation the model asked for with
  the shell call's `sandbox` argument, whether a sandbox exists, the session's taint, the remembered approvals and
  whether anyone is present. It never reads a command's text. The engine does the lookups and the writes.
- From the log alone: what was asked is `approval.requested` (the question as shown, word for word); what the user
  answered is `approval.answered`; what that allowed afterwards is its `grants` (a session approval is stamped with
  the answer's own `seq`, and `session.approval.grants` in the projection is their list); whether a command ran in
  the sandbox and with what is `tool.started.run.sandbox` (`null`: unsandboxed; otherwise `network` and
  `writableRoots`), next to the mode and the path facts the decision was made from.
- A call that is asked about stays `pending`; the projection's tool-call part carries the question and, once given,
  the answer (`approval`). The reducer starts such a call only after an approving answer, never starts a denied
  one, takes one question and one answer per call, and takes no answer once an interrupt was requested.
- Taint is derived, not stored: `deriveTaint` folds the tool results that started (a read's path facts, a
  command's granted network, a network or MCP tool by its class or origin: a tool declares `origin: "mcp"` or
  effect `network` and is a source with no further wiring), `taint.cleared` and compactions, in log order. The
  engine keeps that history in memory, built from the log on first use and extended with every append. A write
  outside the workspace is not a source: its result shows nothing of the file. `taint.noticed` records that the
  user was told, and is what a client shows; a fork inherits it, a revert and a compaction leave it.
- Redaction is applied by the loop to every tool result before `tool.settled` is written (the text, and every
  string of the structured `display` data), and to a check report. The values are the engine's `secrets`: by
  default the values of the process's credential-looking environment variables, read once. The file tools are
  handed the same redaction (`ToolContext.redact`), so an `edit` whose `old_string` holds a placeholder is matched
  against the file as it was shown and applied to the real text, and a placeholder in `new_string`, or in the
  content of a `write` of the same file, is written as the secret it stands for (`tools/redacted.ts`).
- The sandbox wraps a command; it spawns nothing. `createCommandSandbox` (`sandbox/command.ts`) is what the shell
  tool and the check runner use: the workspace writable, the session's temp directory as the command's `/tmp`
  (Linux) or `TMPDIR` (macOS), the repository's git directory writable when it lies outside the workspace (a
  subdirectory of a repository, a linked worktree), `hooks` and `config` of that git directory and the harness's
  project directory read-only, and with the network granted a Bun install cache inside the temp directory. The
  shell tool is told how to run through `ToolContext.sandbox` and refuses when it cannot sandbox.
- The session's temp directory is one name for commands and file tools: a path under `/tmp` given to a file tool
  is the file a sandboxed command means by it, and output too long for the model is kept in that directory, so
  the path the model is given works in a command and in `read` alike. In mode `full` commands see the machine's
  own `/tmp`, and so do the file tools.

**Snapshot, config, verify** (`snapshot/`, `config/`, `verify/`)
- `openSnapshots(cwd)` gives `take`, `changedFiles`, `diff` and `restore` on a private git directory per workspace
  that never touches the user's repository, or a typed `unavailable` (no git, an old git, no storage). A restore
  takes its own "before" snapshot, never deletes an ignored file, and reports what it left alone.
- `loadConfig` reads the user and project files with strict validation: an unknown key is an error. The
  `approval` section is the one key that is not merged: each file's section is handed on as written, and
  `resolveApprovalConfig` lets the project's only tighten the user's.
- `decideGate` is pure: finish, run these checks, report and continue, or finish unresolved. `renderReport` is the
  deterministic text the model is shown; `acknowledgeTool` is the tool (`report_check_failure`) with which the model
  says it cannot fix a failing check. An acknowledgement is that tool call, never parsed prose; a check may be
  named by its name or by the label the report shows it with.

**Engine** (`engine/`)
- `createEngine` takes everything it touches as a dependency (the stores, provider, tools, clock, ID generators,
  the jitter source, limits, the data directory, the snapshot opener, the configuration loader, the check runner),
  so tests inject fakes. `createHarness` (`assembly.ts`) is the one place the real ones are put together; the CLI
  and the ACP server both call it and write nothing to a store themselves.
- A session offers `send` (steer or queue), `start`, `interrupt`, `setSettings` (model and effort, at the next step
  boundary), `withdraw` (a prompt that was not delivered yet), `readEvents` (its stored log, for a client that
  replays history), `revert`, `undoRevert`, an event stream and `close`. Closing a session closes that session:
  its work stops as a shutdown, its store is let go of so that any process can open it, and the engine and its
  other sessions carry on.
- The engine offers `forkSession` (see "Forks"), `replaySession` (see "Replay" and `docs/replay.md`),
  `createSession`, `openSession`, `listSessions` (by directory, without archived ones and without the harness's own sessions, subagents and replays, unless
  asked), `latestSession`, `getSession`, `resolveSession` (an ID or a unique prefix), `readEvents` (of any session,
  open or not, held here or elsewhere), `archiveSession` and `unarchiveSession` (through the session's log, holding
  it only for that append), and `validateSettings`, which rejects a model the provider does not offer, naming the
  ones it does. Listing and reading open nothing and close nothing. Opening a session another process holds fails
  with `EngineError` `session_in_use`, which carries the holder's process ID and a message that says what to do.
- One step is one model call. Before every step the loop re-reads the projection and decides from stored state alone;
  it keeps no conversation state in memory. Events that are decided together are appended in one transaction.
- `tool.called` is durable when the call finishes streaming and `tool.started` right before the tool runs, both
  before any side effect. An interrupt is durable (`execution.interrupt_requested`) before anything is aborted.
- *The order of the calls of one step.* Calls the loop itself refuses are settled first. Reads are decided at
  once and run side by side. Every call that can change something (a write, a command, a network or MCP tool)
  keeps its place in one line: it is decided when the one before it in the line has its result, and runs alone.
  A call that must ask suspends itself and what is behind it in the line; reads go on. Questions are put one at a
  time, and a call is decided again when its turn to ask comes. With the approval layer off (`approval: null`, in
  tests of the loop's other rules) every call starts at once, as before.
- *Asking.* `approval.requested` is durable before the question is put. A client answers with
  `session.answer(...)`; `session.setAttended(false)` (the default until a client says otherwise) makes a call
  that would ask a refusal instead, so nothing waits. An interrupt withdraws a pending question; a steered message
  that arrives meanwhile waits in the inbox until the step is over, like any steer that arrives while tools run.
- *The project's checks* are commands from a file the repository controls, run without anyone asking for them.
  They run in the sandbox wherever the model's commands are sandboxed (`ask`, `auto`, and `full` once the session
  is tainted), with no network and no extra directory; where there is no sandbox they are not run and a `notice`
  says so. Only an untainted `full` runs them unsandboxed.
- One attempt budget per logical step; the numbers and every text the loop freezes into the log are in
  `engine/constants.ts`.
- Opening a session that still holds a claim recovers it (`engine/recovery.ts`), then resumes it.
- The event stream never slows the loop down: durable events are queued in order, and deltas a reader has not taken
  yet are merged per item.
- `Engine.close()` is the hook a process calls before it exits: every session is stopped as a shutdown, which leaves
  its execution suspended and resumable, and is let go of. If the process dies without it, a guard process kills
  the process group of every running shell command (`tools/shell.ts`), the operating system drops the session's
  lock, and whoever opens the session next recovers it.
- *Usage of a step that was cut short.* `step.failed` for an interrupted step carries the usage the provider had
  reported for its model call: always when the call had finished and its tools were stopped, and for a call
  stopped in mid-stream when the provider had sent it by then (the Responses API sends it with the final event, so
  there it is usually absent). The ledger row has the same.
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
- *The gate and a queued message.* A queued message means "after this turn", and a turn is over when the gate says
  so. The gate therefore runs before a queued message is delivered, exactly as before the execution ends: failing
  checks send the model back while the message keeps waiting. When the turn may end (passed, nothing to check,
  nothing configured, or unresolved), the loop appends `turn.ended` with that verdict together with the delivery,
  and carries on under the same claim. A steer is the opposite request (change course now) and is delivered at the
  next boundary with no checks in between. The alternative, delivering first and checking once at the very end,
  would let a turn's failures surface mixed with the next turn's changes and reported against the wrong request.
- *A check whose last pass still stands is not run again.* Each result records a fingerprint: the command, the
  timeout, the `when` patterns and the content hash of every changed file they select (`verify/fingerprint.ts`).
  A selected check is carried over instead of run when it names what it depends on (`when`), the changed files are
  known from a snapshot diff, its latest recorded result is a pass measured from the same verified state, and the
  fingerprint is the same. The carried result is in the run's evidence with `reusedFromSeq`. In doubt the check
  runs: a check without `when`, a session without snapshots, a file that cannot be read, a failed or interrupted
  result all run it. What a `when` list does not name (dependencies, ignored files, the environment) is the
  project's statement that the check does not depend on it.
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
- *Two sessions in one working directory.* Nothing prevents it; it is the user's choice. Each session records its
  own snapshots (its own refs in the workspace's private git directory), and neither's undo overwrites the other's
  work without asking. What the other session changed between this session's steps or after its turn is a change
  outside its own work, like a hand edit. What it changed while this session's own tools ran would look like this
  session's work, so when the snapshot store shows that another session recorded the directory since the point the
  undo goes back to, a step's changes count as its own only for the paths its write calls name; everything a
  command, a run of checks or a restore spans is asked about. A session that is alone in its directory is never
  asked about what its own commands changed.
- *Snapshot retention.* After each execution, and when a session is archived, the loop drops snapshots of that
  session, never one a revert or an undo could still need (`neededSnapshots` in `engine/workspace.ts`): the
  snapshot every revertable user message goes back to, everything recorded since the latest of them (an undo of
  the last turn stays exact), both ends of every undoable revert and what was recorded since, an open restore's
  ends, the latest snapshot and the ones the gate compares with. Of the rest (the snapshots around the steps and
  checks of older turns, those of history that was compacted away or reverted for good, refs a crash left
  unrecorded) a session in use keeps the newest `snapshotKeepLast` (100) and none older than `snapshotMaxAgeMs`
  (30 days); an archived session keeps none. A workspace that did not change is the same snapshot again, and one
  ref is kept for it. Only the session's own refs are touched, so sessions that share a workspace never remove
  each other's snapshots; what is needed is read after the refs are listed, so a snapshot recorded while this runs
  is safe. A revert across dropped in-between snapshots still restores; if it cannot tell its own changes from
  others' any more, it asks about every file.
- *Instruction files in directories the agent starts working in.* A tool says which paths a call touches
  (`Tool.touches`; the file tools do, a shell command does not). The directories of the calls in the session's
  history that are not reverted or refused are handed to discovery at every step boundary, so an `AGENTS.md` in a
  directory the agent has just read or written in is found there and appended once, as an `instruction.appended`
  message with its fingerprint. The baseline is never rewritten for it: the next request is the previous one plus
  appended items. The directories are derived from the log, so a restart finds the same ones.
- One model call has a wall-clock limit (`modelCallTimeoutMs`, 30 minutes by default, `0` for none). A call still
  running then fails as a `transport` error with reason `timeout` and is retried within the attempt budget. A
  compaction's summary call has a shorter one (`compactionCallTimeoutMs`, 5 minutes) and is not tried again.
- *Compaction.* Before every step the loop builds the request it would send, estimates its size from the request
  ledger (the provider's count for the last step call plus an estimate of what was appended since, with a margin)
  and asks the policy (`context/policy.ts`) with the model's context window, which the engine is told per model
  (`contextWindow`; `createHarness` takes it from the provider's model list). Below 65% of the usable window nothing
  happens; from 65% the conversation is compacted at the next user-message boundary; from 80% before the next step,
  also in the middle of a turn. Nothing of this is kept in memory: the decision is made again from stored state at
  every boundary, so "due at the next user message" needs no flag and survives a restart. Without a known window
  nothing is compacted ahead of time; a request the provider rejects as too large is compacted aggressively.
- *The cut.* `chooseTail` keeps the recent history that fits the policy's budget word for word and never splits a
  step. What the next call answers is kept by a normal compaction even over budget: the input that arrived since
  the model last spoke, or, in the middle of a turn, the last step with its results. So one very long turn keeps
  its most recent steps, and the checkpoint carries the turn's request (quoted verbatim) and a sentence telling the
  model that the work was in progress. An aggressive compaction keeps only what fits; with nothing kept, the model
  continues from the checkpoint alone. A normal compaction that could take out less than a quarter of what is in
  view (one huge tool result is the last step) is not made: the request is sent while it fits, and compacted
  aggressively at once when it does not.
- *The summary.* The summary request is the step request of the part before the cut plus one prompt, so it reads
  that part from the cache; the cut and the prompt are durable (`compaction.started`) before it is sent. This
  provider rejects `max_output_tokens`, so the answer is bounded by the loop: it stops reading at twice the
  summary's token limit and takes what arrived. A summary the model repeated is cut at its first repeated heading.
  An answer that is still not of the required form is asked for once more, with the rejected answer and what is
  wrong appended (`compaction.repair_requested`). After that, and after a call that reached its time limit, a part
  too large to summarise, a refusal or an empty answer, the compaction completes without the model: the checkpoint
  then says plainly that there is no summary and carries the identifier index, the user's messages verbatim and
  the assistant's last words. A summary that only lacks a detail or is too long within the bound is used and says
  so. Only a provider that cannot be used at all (signed out, the plan's limit, failing again and again) fails the
  execution, as it would fail a step; history is then unchanged. `compaction.ended` records which of these happened
  (`source`, `detail`) and the size after, so a client can tell the user: the CLI prints the sizes before and
  after, and for a fallback why there is no summary and what the model continues from.
- *The checkpoint* (`context/checkpoint.ts`) is rendered once, from every non-excluded message before the cut in
  the whole log, and frozen in `compaction.ended`: the summary, an index of exact identifiers (files with lines,
  commands with the outcome of each run, errors, commits, failing tests), the user's messages verbatim up to a
  budget, and the pointer to the history tools. It is never rendered again, whatever the checkpoint code becomes.
- *After a compaction* the baseline is set again (instruction updates are folded in, the tool list is the same), and
  the next request is the checkpoint and the kept messages, which render exactly as before. The request after that
  extends it. The anti-thrash rules are the policy's: a compaction that freed less than a quarter blocks the next
  until the context has grown; if the request then does not fit there is one aggressive compaction; then nothing
  more is tried.
- *What else a compaction meets.* An interrupt during the summary call closes the compaction as interrupted and
  leaves history as it was. A process that dies inside one leaves it open; recovery closes it as crashed and the
  loop decides again (the checkpoint a dead process did freeze is used, not made twice). Input that arrives during
  the summary call waits in the inbox: a steer is in the first request after the compaction, a queued message waits
  for the turn; a model or effort change is applied at the boundary after it. The verification gate is unaffected:
  it reads the whole log, not the model's view. A fork inherits the compaction with the history. A revert may go
  back before a compaction: the range excludes the compaction, model history is again what it was before that
  message (which fit the window when the message was sent), and undoing the revert brings the checkpoint back. The
  snapshot a user message goes back to is therefore kept also when the message is behind a compaction.
- *The history tools* (`history_search`, `history_read`; `engine/history.ts`) are read tools over the session's
  stored messages. They are in every session's tool list from its first baseline rather than added at the first
  compaction: the list never changes (one frozen prefix for the whole session, and the request after a compaction
  shares the tools with the ones before it), and a long session can look up an early result before anything was
  compacted. The cost is two tool descriptions in every request, cached with the rest of the prefix. A search
  finds an identifier as written, a quoted phrase, or a rough description (messages holding more of the words rank
  higher; plain words match as prefixes), names each hit's `seq` and where in the message the match is, and a read
  names the messages before and after. Reverted and refused messages are never returned, and a checkpoint is not
  searched. Their output goes through the tool runtime's one cap like any tool's. They see what the model was
  shown: a tool output that was capped when it ran is stored capped, with the path of the full output.
- *The context window in tests.* `LIGHT_HARNESS_TEST_CONTEXT_WINDOW` (the name is built from `brand`) lowers the
  window `createHarness` hands the engine, so an evaluation run compacts after tens of thousands of tokens. It can
  only lower it, the harness says so on its log, and no configuration file has a key for it.
- A diagnostic about a session (a prefix violation, an internal error, a tool that threw) is said once: as an
  ephemeral `diagnostic` event of that session's stream, which a client shows. It goes to the engine's log instead
  only when no open session can carry it. `onDiagnostic` hears every one.

## Subagents and background work

Two things run beside a session's own steps: subagents and background commands. Both are *spawned work*: recorded
in the session's log when they start (`spawn.started`) and when they end (`spawn.ended`), stopped with the session,
and reported to the model when they end. `engine/spawn.ts` has the tools and their texts; the session owns the
writes. `createHarness` switches them on (`EngineOptions.spawn`); an engine built without the option offers none.

**The tools.** Three are in a session's frozen tool list from its first baseline, with fixed specs: `subagent`
(`task`, and optionally `session`, `background`, `worktree`), `background_output` and `background_stop` (`id`). The
shell tool has a `background` argument.

**What a subagent is.** A real session (`lineage.kind = "spawn"`: its parent, the spawned work that started it, its
depth, its worktree). It starts with a fresh conversation: its own baseline (the same base prompt, the project's
instruction files discovered for its working directory, the environment, the date) and its task as its first user
message, with one line saying who reads its answer. It sees nothing of its parent's history. It runs the same loop
with the same tools, the parent's model settings, the parent's approval settings and, by default, the parent's
workspace. It has a cache key of its own. Its conversation stays: a follow-up by reference (`subagent` with
`session`) is delivered to it while it runs, and starts a new piece of work (a new `spawnId`) once it has ended.

**Decisions.**

- *Depth.* One level by default (`spawn.maxDepth`): a session a person started may spawn; its children may not. A
  session at the limit is not offered `subagent` at all (its tool list is frozen without it), and a call it makes
  anyway is refused with the reason.
- *Running side by side.* `subagent` is side-effecting for the purpose of snapshots (a step that calls it is
  bracketed, so the parent's undo covers what the child changed) but needs no decision of its own, because every
  call the child makes goes through the approval layer of its own session (`Tool.delegates`). So several calls in
  one response start at once instead of waiting in the line of calls that can change something.
- *The result.* In the foreground the call waits for the child and settles with the child's final answer and a
  reference: `[subagent <session>: finished after N steps, M tool calls]`. A child that failed, was stopped or ended
  without an answer comes back as an error result that says so and quotes its last words; never as an empty answer.
- *In the background.* The call returns at once with the reference. When the child ends, `spawn.ended` and a
  harness message (`subagent_result`) with the answer are one append; the message is a steer, delivered at the next
  step boundary. If the session is idle it starts a new execution. When the model has nothing more to do while a
  background subagent still works, **the turn does not end**: the loop waits at the boundary for the next input
  instead of running the gate, because the checks would see the child's work half done.
- *Verification.* The gate applies to the parent's turn. Children do not run it (their `execution.succeeded` says
  `not_configured`, and they are not offered the acknowledgement tool): several children each running the whole
  check suite in one workspace would mostly report each other's unfinished work, and the parent's turn is verified
  once their work is in.
- *Interrupts.* Interrupting or closing a session stops everything it spawned, after its own interrupt is durable:
  background commands are killed, children are interrupted (as by their user) and wind down by the usual rules.
  Each end is recorded (`stopped`); a background child's end waits in the inbox for the next prompt and wakes nothing.
- *Questions.* A child asks through its parent's client, or nobody. A client opts in with
  `setAttended(true, { children: true })`; the child's `approval.requested` then arrives in the parent's stream
  inside a `child.event`, shows as `approval().pending` with `child` (its session and the first line of its task),
  and is answered through the parent's `answer` (`sessionId` names the child). Without the opt-in a child's call
  that would ask is refused as unattended. A child has no approvals remembered for the session (its parent's are
  the parent's); approvals remembered for the project apply to it as to any session.
- *Taint.* A child's taint is its own while it runs. When its result is delivered, `spawn.ended.tainted` says
  whether its conversation held untrusted content, and from that event on the parent is tainted too (source kind
  `subagent`), as by any tool result.
- *Usage.* `spawn.ended.usage` is what the child's model calls cost during that piece of work; the parent's
  `spawned.usage` adds them up. They are not part of the parent's own request ledger.
- *Events for a client.* The parent's stream carries each durable event of a child as an ephemeral `child.event`
  (the child's session, the spawned work, the task's first line, the event). Nothing of it is stored in the parent:
  the child's own log is the record.

**A worktree of its own** (`worktree: true`; `engine/worktree.ts`). Only in a git repository; elsewhere the call is
refused with the reason and nothing starts. The child gets a git worktree under `<work dir>/worktrees/` on a new
branch (`<binary>/subagent-<id>`) that starts from the parent's workspace as it stands, uncommitted and untracked
files included: that state is written as one commit with a private index, so the user's index, branches, HEAD and
stash are not touched. When the child finishes, every file it changed is merged three ways into the parent's
working directory (the branch's start, the child's result, the file as it is now). All results are computed first:
if one file conflicts nothing is written, the worktree is removed, the branch is kept with the child's work as a
commit, and the result tells the model which files conflict and how to look at the work. Otherwise the files are
written (nothing is committed or staged) and the worktree and the branch are removed. Merges into one repository
run one at a time. A child that did not finish has its work committed to its branch and nothing merged. No hook of
the repository runs for any of this.

**Background commands.** `shell` with `background: true` spawns the command exactly as a foreground one (the same
sandbox decision, its own process group, the guard that kills the group when the harness process dies) and hands
it to the session, which records it and returns a handle. Its output goes to a log file in the session's temp
directory as it arrives. `background_output` shows the output so far, `background_stop` stops it. When it exits,
`spawn.ended` (with the exit code) and a harness message (`background_command`) with the end of its output are one
append, and the message wakes the session if it is idle. It has no time limit unless one is given.

**Recovery.** A session that is opened with spawned work its log says is running, and that nobody in this process
runs, lost it to a restart (`reapSpawned`). A command is recorded as `lost` (its guard killed it). A subagent is
looked at: one that had finished on its own (it was opened and ran on while its parent was gone) delivers its
answer now, and its worktree is merged now; one that was cut off has its turn ended (its claim is released as an
interrupt) and is recorded as `lost`, with what it had done committed to its branch. Either way a harness message
(`spawn_lost`, or the answer) tells the model. Opening a session starts nothing, so the message waits for the next
prompt unless the session's own turn was cut off too: then the turn is resumed and does not end before the message
is in. A worktree merge that was cut off is finished the same way: merging again is idempotent, because a file
that already holds the child's change merges to itself.

**Where the directories are.** Worktrees, a fork's copy and a replay's copy are made under the *work directory*,
`<data dir>-work` (`EngineOptions.workDir`): beside the data directory, never inside it. The sandbox hides the data
directory from commands, and commands must run in these.

## Replay

`Engine.replaySession` creates a replay session (`lineage.kind = "replay"`) and runs it; `docs/replay.md` is the
user's page. In the loop (`replayLoop`): the baseline is the recording's with the caller's overrides, set without
discovery; before each step the recording's inputs that are due are added as the messages they were; a step is the
ordinary `step`, and `runTools` hands the step's calls to the replaying executor, which matches them against the
recording together and answers each (`replay.call` is written with the call's result). While the replay is on its
recording the loop takes no snapshot, runs no check, asks nobody, adds none of its own notes (the recording's are
the notes) and never compacts. Under `stop` a call that is not on the recording settles as not started and the
execution ends, without an answer, as `execution.failed` with `cause: "replay"`. Under the policies that run
tools, the first such call restores the recorded snapshot into the copy (`replay.diverged`) and from there the
ordinary loop finishes the turn in the copy, with the approval layer forced to `auto` and nobody present. A replay
session takes no prompts and is not reverted or forked. One whose process stopped is closed as after any crash and
ended as `incomplete`; it is never taken up again.

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
- **A queued message.** The turn's answer · the gate (a run of checks, when one applies) · `snapshot.taken
  delivery` · in one append `turn.ended` with the verdict and `inbox.delivered` · the next turn's steps.
- **A compaction.** At a boundary under the claim: `compaction.started` (trigger, mode, cut, prompt, size) · the
  summary call, and for an unusable answer `compaction.repair_requested` and a second call · `compaction.ended`
  (the checkpoint, `source`, the size after) · `baseline.set` · the next `step.started`. After a rejected request:
  `step.failed` with the overflow first, then the same.
- **A withdrawn prompt.** `inbox.enqueued` · `inbox.cancelled`. It never becomes a message.
- **Archiving.** `session.archived`, appended while the session is held only for that; `session.unarchived` undoes it.
- **Instructions found on the way.** A step whose calls touch a new directory ends · `instruction.appended` for the
  `AGENTS.md` found there · the next `step.started`.
- **A subagent.** In the parent: `tool.called` · `tool.started` · `spawn.started` (the child is named before it
  exists) · the child's own log · `spawn.ended` · `tool.settled` with its answer. In the background: `tool.settled`
  at once; later, in one append, `spawn.ended` and `inbox.enqueued` (`subagent_result`), then its delivery.
- **A background command.** `tool.called` · `tool.started` · `spawn.started` · `tool.settled` with the handle;
  when it exits, in one append, `spawn.ended` and `inbox.enqueued` (`background_command`); if idle, `execution.started`.
- **A replay.** `session.created` (replay) · `execution.started` · `baseline.set` (changed) · the recording's
  prompt · per step `tool.called`, `tool.started` (when the recorded call had started), `replay.call`,
  `tool.settled` · `execution.succeeded` or `execution.failed` (`replay`) · `replay.ended`.
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

## Where sessions live

Everything is under the harness data directory (`$XDG_DATA_HOME/<brand.directory>`, by default
`~/.local/share/<brand.directory>`), which several processes share:

```
sessions/<session id>.db          one SQLite database per session (WAL, with its -wal and -shm)
sessions/<session id>.db-lock     that session's writer lock; never deleted
sessions/<session id>.db-holder   the process holding the lock, for the error message only
../<data dir>-work/               beside the data directory: workspaces/ (a fork's copy), worktrees/ (a subagent's
                                  git worktree), replays/ (a replay's copy): where sandboxed commands must run
approvals/<workspace hash>.json   approvals remembered for a project (30 days), keyed by its real path
index.db                          the listing cache; can be deleted at any time
blobs/<aa>/<sha256>               media, content-addressed
spill/                            tool output too long for the model, named by content or by call
snapshots/<workspace hash>/       one private git directory per working directory
auth.json                         the sign-in
```

Outside the data directory, because sandboxed commands must reach it and the data directory is hidden from them:
`<os temp>/<brand.directory>-<uid>/<session id>/` is the session's temp directory (mode 0700), with `.spill/`
inside it for the session's tool output kept in full. With the approval layer off, and for a session on a machine
without a sandbox, that output is in `spill/` of the data directory as before.

**Why one file per session.** The store's guarantees are per database: one writer, dense `seq`, the reducer inside
the append transaction, rebuild-from-log equals the live rows. A session is the natural unit of all four, and one
file each makes "one writer" mean "one process works in this session", which is what users expect. Nothing in the
schema changed for it; the tables are keyed by session as before.

**Who holds a session.** Creating or opening a session takes its lock (`sqlite-lock.ts`: an exclusively locked
SQLite database next to the session's) until the session is closed. The lock is the operating system's: a process
that dies holds nothing, so its sessions open normally and are recovered as after any crash. A session a live
process holds is refused with `SessionInUseError` (`EngineError` `session_in_use` from the engine), which names the
holder's process ID and says what to do: wait, stop that process, or start a new session. The ID comes from the
small `-holder` file the holder writes after taking the lock; it is information, and the lock decides. Reading a
session (listing, a client replaying history, a trace export) never takes the lock: it uses a read-only
connection, which WAL mode lets run next to the writer and which sees committed transactions only.

**Listing without opening every file.** The session files are the truth. `index.db` caches each session's summary
row, and a listing never trusts it unchecked: it reads the directory, stats each session's database and
write-ahead log, and uses a cached row only if the recorded signature (size and modification time in nanoseconds
of both files) still matches and was taken well after the files last changed. Every other session is read from
its own file, one row through a read-only connection, and the cache is updated. Writers do nothing for the index,
so there is no update a dying writer could leave undone. The signature is taken before the file is read, so a
write in between leaves the cache older than the file, never newer; a file changed within the last two seconds is
read again whatever its signature says (the rule git's index uses against coarse timestamps); several processes
refreshing at once each write rows they read themselves, with the signature they were read under, so a lost update
costs a re-read and nothing else; a process killed inside the cache's transaction leaves nothing; and a cache that
is missing, corrupt or from another version is deleted and rebuilt from the files. If it cannot be rebuilt the
listing is computed from the files alone. "The most recent session for this directory", "list by directory" and
"resolve an ID or a unique prefix" are all this listing (the prefix needs only the file names). The cost of a
listing is one `readdir` and two `stat` calls per session, plus one small read per session that changed.

**Forks.** `Engine.forkSession(id, options)` forks a session at a step boundary (the latest one by default, or the
event `throughSeq` names, which is refused when it lies inside a step). What the fork inherits, as of that point:
the history (messages, the baseline, the compaction in force), the model settings (unless it is given its own), the
title, the taint (the content came with the history: the reducer copies the noticed taint, and the decisions
derive it from the inherited results) and the root session's ID as its cache key, so its first request is its
parent's last request plus what is appended. What it does not inherit: the inbox, the claim, the snapshots, the
verification state, the undo history, and the approvals remembered for the session. An approval was given to one
line of work, and a fork is another that may go somewhere else (and may work in another directory); approvals
remembered for the project still apply.

*The workspace.* By default the fork works in the parent's working directory. That is two sessions editing the
same files, with the rules of "Two sessions in one working directory": nothing prevents it, each records its own
snapshots, and neither's undo overwrites the other's work without asking. With `workspace: { copyTo }` the fork
gets a directory of its own and works there: the workspace as it stands when the fork point is the parent's latest
state and the parent is idle (a fresh snapshot is taken for it, so hand edits are in), otherwise the snapshot that
was current at the fork point. The copy holds what a snapshot holds (no ignored files, no large untracked files,
nothing of nested repositories); its default place is `<work dir>/workspaces/<fork id>`. The fork's lineage
records the snapshot and the directory it was copied from. The parent's working directory in the inherited tool
calls and in the baseline's environment section is still the parent's; the changed directory is appended as an
instruction update at the fork's first step, like any source that changed.

Measured on the real provider: a fork of a session that had just finished, with one more prompt, sent 3,539 input
tokens in its first request and read 3,072 of them from the cache (the parent's last request: 3,500, of which
3,200 cached). The cache is tied to the `session-id` header, which is the root session's ID for both.

A fork's log is its parent's events through the fork point followed by its own, and the parent is another
file, possibly open for writing in another process. The fork reads it through a read-only connection, and only
events at or before the fork point. That is safe because those events are committed, and the log is append-only
(the schema's triggers refuse updates and deletes): whoever writes to the parent meanwhile only adds events after
them. When a fork is created, its inherited messages, baseline and compaction are copied into its own rows, so a
fork whose parent file is later missing still opens, runs and is listed; reading its inherited events then fails
with `parent_missing`, which names the parent. Creating a fork of a session that cannot be found fails the same
way. A process that dies while it forks leaves at most the copy of the workspace: the fork's session is created
in one append, so it either exists whole or is not listed.

**What sessions share.** Media is one file per blob, named by its SHA-256, written to a temporary file and then
hard-linked into place: a reader never sees half a blob, two writers of the same bytes agree, and the first media
type wins for everyone. Spill files are named by their content and written aside before a rename, or named by the
call that produced them; a run of checks writes under a directory of its session. Snapshots are per workspace, in
a git directory several sessions and processes use at once: every `take` writes objects and a ref of its own name
and never changes another session's; pruning looks only at one session's refs, waits out a lock another process
holds for a moment, and treats another process's `git gc` as the collection it wanted.

**The database of the layout before this one.** Nothing was released with it, so nothing is migrated. A harness
that finds `sessions.db` in the data directory moves it, with its lock and log files, into
`backup-single-database-<time>/` once and says so on standard error; its sessions are no longer listed.

## The only provider

The model layer talks to OpenAI's Responses API through "Sign in with ChatGPT". That flow keeps no conversation state
on the server, so the full history is sent on every call and an unchanged prefix is what makes the call cheap.

Two things about its prompt cache shape what the harness does, both measured (`docs/reference/responses-api.md`,
"Verified live"): an assistant item is read from the cache only under the item ID it was written with, which is why
the request builder derives one for parts that have none; and a prefix that was written cold is not readable at
once, for longer the more of it is new (a few seconds for a few thousand tokens, more than half a minute for
38,000). The second one means the first requests after a compaction pay for the new prefix in full; a smaller kept
tail shortens that.
