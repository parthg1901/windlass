# Architecture

Windlass is a coding-agent harness built around one idea: a session is an append-only log of events in SQLite,
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
  interrupt.ts    the abort token with an explicit InterruptReason, and the token of one tool call
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
  tools/          the standard tools: read, write, edit, ls, glob, grep, shell, todo
  context/        conversations that outgrow the context window, without I/O: estimate.ts (the size of the next
                  request), policy.ts (when to compact and how hard), tail.ts (what is kept word for word),
                  summary.ts (the summary request, its check, its bounds), checkpoint.ts (the frozen text that
                  replaces the removed history), history-tools.ts and history-search.ts (the history tools'
                  shapes, texts and search)
  engine/         the step loop: engine.ts (sessions, the drain, cancel, retries, compaction, the verification gate,
                  revert), history.ts (the history tools as the loop offers them),
                  recovery.ts (start-up recovery), replay.ts (what a replay may change, its changed baseline),
                  spawn.ts (the subagent and background tools, what is read off a child's log),
                  worktree.ts (a subagent's git worktree and the merge back), skills.ts, mcp.ts, wake.ts, memory.ts,
                  agents.ts, hooks.ts and lsp.ts (those seven modules as the loop offers them), commands.ts (slash
                  commands as clients are offered them), telemetry.ts (the live exporter: a session's log mapped to
                  spans as it grows), state.ts (what the loop reads off the projection),
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
  skills/         skill files: discovery, the index text, the `skill` tool, the `skills` configuration section
  mcp/            MCP servers behind two bridge tools: both protocol eras, the two transports, the registry, the
                  catalogue text, the `mcp` configuration section
  wake/           wake-ups: the record and its limits, cron, the shared store, the scheduler, the check runner, the
                  webhook listener, the tools, the `wake` configuration section
  memory/         notes across sessions: the files, expiry and budget, trust, delivery, the tools, usage and scores,
                  the `memory` configuration section
  agents/         agents (modes): definitions as files, discovery, restrictions, the list for the model, what using
                  one means, the `agents` configuration section
  hooks/          hooks: the `hooks` configuration section and each hook's fingerprint, which hooks apply to a call,
                  the answer format, the decision per point and every text the model is shown, who may run and how,
                  the event a hook is given, the runner
  lsp/            language-server diagnostics: the `lsp` configuration section, the server process and its JSON-RPC
                  connection, one LSP session, the before/after comparison, the note, the registry
  commands/       slash commands: discovery of command files, expansion of a template with what was typed, lookup
                  with a did-you-mean, the listing, the `commands` configuration section
  telemetry/      a session as OpenTelemetry spans: the mapping from the log and the ledger, the OTLP/JSON encoding,
                  the HTTP and file exporters, the background queue, the `telemetry` configuration section
```

Naming: a lowercase export such as `message` or `usage` is a validator; the PascalCase export of the same name is its
type. Dependencies point one way: `event` knows nothing about `message`, `store` or the step loop; `provider` and
`tool` know nothing about sessions.

Entry points: `@windlass/core` exports the contracts, the SQLite store, the Responses provider, the request
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
| Session | `session.created` (cwd, title, settings, and the lineage: a `fork` of a parent through a seq, a `spawn` by a parent's tool call with its depth and worktree, a `replay` of a recording with its policy and what was changed; for a fork also `inherited`, what it needs at run time of the events it inherited: the entries taint is derived from), `session.renamed`, `session.archived`, `session.unarchived`, `settings.changed` |
| Frozen prefix | `baseline.set` (instructions, tools, source fingerprints), `instruction.appended` (source, text, fingerprint; for the sources that are never in the baseline, `detail`: the servers whose descriptions an MCP catalogue carries, the notes a memory message makes the model hold, the skills an index lists, the agents a list names), `agent.switched` (the agent the session runs as from here on, as the definition was when it was selected; before the first baseline, or right after the instruction message that announces it) |
| Inbox | `inbox.enqueued` (with `untrusted` when a wake-up's firing carries a webhook's body or a networked check's output), `command.expanded` (the message admitted right before it was produced by a slash command: the command's name and file, the fingerprint of the file as it was read, the arguments, the positions that were not given, what was left as text), `inbox.delivery_changed`, `inbox.cancelled`, `inbox.delivered`, `turn.ended` (a turn ends because a queued message waits), `synthetic.appended` |
| Execution | `execution.started`, `execution.interrupt_requested`, `execution.interrupted`, `execution.resumed`, `execution.succeeded` (with what the gate found, and `hooks.unsatisfied` with `hooks.objections`, their last words, when stop hooks still objected at their bound; `turn.ended` carries the same), `execution.failed` (`cause: "approval"` when a call nobody could approve ended the run, `cause: "replay"` when a replay ended where the model had not answered) |
| Step | `step.started`, `step.ended`, `step.failed`, `step.refused`, `retry.scheduled` |
| Model output | `text.ended`, `reasoning.ended` |
| Tools | `tool.called`, `tool.started` (with the effect class, and what the approval layer let the call run under: mode, path facts, sandbox and its extra access), `tool.cancel_requested` (the user asked for this one running call to stop; the turn goes on), `tool.settled` (for an edit a language server was asked about also `diagnostics`: whether a note was added, how many diagnostics it lists, and per server whose configuration it is from, how it came out and the counts) |
| Hooks | `hook.ran` (one per hook that applied: the point, the call for a before or after hook, which hook and whose, how it ran, what it answered, the text that reached the model, what it printed for the user, and whether that text is a taint source) |
| Approval | `approval.requested` (the question, its choices and what each remembers, what it is about, how the call runs if approved, the path facts and the escalation it was decided from), `approval.answered` (the choice, the note, the approvals it created), `approval.denied` (by the policy, or because nobody was present; whether it ends the run; `agent` when the policy that refused it is the restrictions of the agent the session runs as, then with `refusal`: which rule, the call's effect class, a sentence for the user), `taint.noticed` (the first source, the sentence the user was shown), `taint.cleared` |
| Spawned work | `spawn.started` (a subagent's child session and the agent it runs as, or a background command with its log file; the call that started it; whether it runs in the background), `spawn.ended` (completed, failed, stopped or lost; the exit code; a subagent's usage, taint and worktree merge), `watch.started` (the user's watch on a running command's output: text or a regular expression a line must match, and how often it may fire), `watch.fired` (the line, the count, and the message that tells the model), `watch.ended` (a watch that could still fire ended: removed, with its command, or lost with it) |
| Replay | `replay.call` (per call: matched, normalised, dropped, diverged or off the recording; whether the tool ran for real), `replay.diverged` (the copy the replay carries on in, and the snapshot it was restored from), `replay.ended` (the outcome, the reason, the report) |
| Compaction | `compaction.started` (the trigger: `auto`, `overflow`, or `manual` when the user asked; the mode, the cut, the frozen prompt, the size it started from), `compaction.repair_requested` (the rejected answer and the follow-up prompt), `compaction.ended` (the frozen checkpoint, where its summary came from, the size after, and `calls`: how many summary requests it took, retries and the repair included), `compaction.failed` (with `calls` too) |
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
- `execution.succeeded` says what "done" rests on: `passed` with the evidence, `not_needed` (the turn changed no
  file, or nothing the checks cover changed; with `unverified` when files the checks cover did change outside the
  turn and were therefore not checked), `not_configured`, `left_to_parent` (the session is a subagent: its turn is not
  verified by itself, its parent's turn is; it says nothing about whether checks exist), or `unresolved` with
  the failing checks, the reason (`acknowledged`, `max_rounds`, `report_mode`) and the evidence. A client shows
  these as different endings.
- A summary call is a model request that is no step: it writes no `step.started`. The model requests of a turn
  are its `step.started` events plus the `calls` of the `compaction.ended` and `compaction.failed` events in it.

**Reducer and projection** (`message/`)
- `reduce(state, event)` is pure and is the only code that turns events into state. The store runs it inside the
  append transaction, so an event it rejects is never written. Rebuilding from the log always equals the live rows.
- It rejects every sequence the step loop must not write. The list, with a scenario and a rejection test for each,
  is in `docs/step-loop-scenarios.md`. In short:
  - *Shape of the log.* `seq` is dense. A message enters history only at a step boundary and only under a running execution claim (the one exception is the message that announces a switch of agent, which
    the user also makes between two turns). A step and a compaction need a baseline. A step has one terminal event, after all its calls
    have settled.
  - *Tool calls.* A call is `pending`, then optionally `running`, then `settled` exactly once. From `pending` it
    settles as `not_started` or `error`; from `running` as `success`, `error` or `effect_unknown`. `tool.started`
    records the tool's effect class, and a `read` call never settles as `effect_unknown`. Calls are keyed by
    (assistant message, provider call ID), because providers reuse call IDs. `tool.cancel_requested` (the user
    stops one call) is accepted only for a call of the open step that is `running`, once, under a running claim
    and while no interrupt is requested; it is recorded on the call (`cancel`) and changes nothing about how the
    call may settle.
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
  - *Watches.* `watch.started` names a background command that is running (never a subagent, never work that
    has ended), an ID no watch has, and a limit of at most `WATCH_LIMITS.maxFirings`; a command has at most
    `WATCH_LIMITS.perCommand` watches that can still fire. `watch.fired` counts up by one, never past the limit,
    and names the `background_watch` message admitted right before it (the two are one append). `watch.ended`
    is accepted only for a watch that could still fire. `spawn.ended` is rejected for a command while a watch on
    it could still fire: the watch is ended first, with the reason, so none is ever silently gone.
  - *Replay.* `replay.call`, `replay.diverged` and `replay.ended` are accepted only in a replay session; a matched
    call names the recorded call it matched and only a matched call does; a replay leaves its recording once, never
    under the `stop` policy, and ends once.
  - *Agents.* `agent.switched` names the agent the session ran as before. Without a message it is accepted only
    while no baseline is set (the first baseline then carries the agent's instructions); with one, only right
    after that message, which must be an instruction message of source `agent`. That message and the switch need a step boundary
    and no claim: they are written the moment the user switches while the session is idle, and at the next
    boundary of a turn that runs. A call is refused in an agent's name only by the agent the session runs as.
  - *Hooks.* `hook.ran` needs a running claim. A before or after hook's record names a call of the open step
    that has no result yet (an after hook's, one that started); a stop hook's names none and is written at a
    boundary. A record says `skipped` exactly when the hook did not run for want of the user's approval, and only
    a hook that answered no has text that reached the model. While an interrupt is wound down the records of the
    hooks that had finished are still accepted. An ending names unsatisfied stop hooks only when there is one,
    each once, and carries what each of them said and nobody else's words. The message a stop hook sends the model back with is a harness message like any other: it must be
    answered before the execution can end.
  - *Commands.* `command.expanded` names a message of the user's that waits in the inbox and follows its
    admission at once (the two are one append): never a harness component's message, never one admitted earlier,
    never one that was delivered. The message carries the record from its delivery on (`command`), so a transcript
    built from the rows and one built from the log say the same.
  - *Who verifies.* The ending of a subagent's turn (`execution.succeeded`, `turn.ended`) says `left_to_parent`
    and nothing else, and no other session's ending says it.
  - *Forks.* Only a fork's `session.created` carries `inherited`, and what it carries lies at or before the
    fork point.
  - *Reverts.* A revert and its undo happen only while no execution holds the claim. One that restores files is
    announced first (`revert.started`), nothing starts while it is open, and its record must be of the announced
    restore. Only the latest revert can be undone, until an execution starts; the undo puts back exactly the
    messages that revert excluded.
- The session state also holds what the session spawned (`spawned`: the work that is running, with the watches
  set on a command's output and how often each fired, every child it
  ever started, and what the children's model calls cost, added up from each `spawn.ended`) and, for a replay,
  the copy it carries on in and how it ended (`replay`).
- The session state also holds what the loop decides from: the latest snapshot and what snapshots leave out; the
  workspace state checks are selected against (`verification.verified`: the first snapshot, then the state at each
  verification that passed or found nothing to check; it does not move when a turn ends with unverified changes
  left outside it) and the latest run of checks; the reverts that can still be undone; and the agent the session
  runs as (`agent`), which a fork inherits.
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
- `getProjection` is what the step loop reads several times per step, so its cost must not grow with the log. It
  keeps the rows it last read for a session, decoded, with the `last_seq` they were read at. Every message row
  says when it last changed (`message.changed_seq`, written by `append` with the row), and rows change only
  inside an append, which always moves `last_seq`: an unchanged `last_seq` means unchanged rows, and otherwise
  the session row, the inbox and the message rows that changed since are read again, in one read transaction.
  What it returns is always what the rows say; `test/store/projection-read.test.ts` compares it, after every
  event of every scenario, with a connection that reads every row and with the rebuild from the log.
  (Measured with the scripted provider on the loaded two-core development machine, at 2M tokens of history: the
  state reads of one model call took 787 ms before and 1 ms after; the median time per call went from 659 ms
  to 138 ms.)
- The request ledger stores, for each model call, the ordered block hashes of the request, the usage (with what
  the provider says it wrote to its cache, when it says), the name of the provider that served it
  (`Provider.id`: the signed-in Responses provider, or a scripted one) and what the response said about itself,
  when it did: the provider's own ID of the request (`providerRequestId`, of a call that finished and of one that
  failed) and the model that answered (`responseModel`). It is in the session's own file.
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
- A session's summary (`getSession`, a listing) carries `firstPrompt`: the beginning of the first thing the user
  said, from the session's own message rows (or, before anything was delivered, the prompt that waits). It is
  what a client names a session by that nobody titled, and it is kept in the listing cache with the summary.

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
  date, and last the instructions of the agent the session runs as, when it runs as one). `baseline.set` records,
  next to the text, the fingerprint of each source's value.
- A source that changes later is appended as an `instruction.appended` message with its new text and fingerprint
  (`null` when the source is gone). It is appended under a running execution: a change noticed while the session is
  idle is written when the next execution starts.
- What the model currently has per source is a fold over those fingerprints in the model's view of the log. Nothing
  reads rendered text back, so a reverted, refused or compacted-away message is detected again by itself.
- Four sources are never part of the baseline: the skill index (`skills`), the MCP catalogue (`mcp`), memory
  (`memory`) and the list of agents (`agent-index`). What they say depends on things outside the session (a file is edited, a server connects), so each
  reaches the model only as appended messages: once when it first has something to say, again when its fingerprint
  changes, and as a one-line withdrawal with fingerprint `null`. Their modules write the texts; `AppendedSource` and
  `detectAppendedChanges` (`instructions/state.ts`) route the keys through the same fold. A baseline set after a
  compaction carries none of them, so the first boundary after it gives each again in full. `renderSection` refuses
  their keys, so none can be folded into a baseline by mistake.

**Provider** (`provider/`)
- `stream(request, signal)` yields normalised events and ends with exactly one `finish` or `error`. Failures are
  classified, not thrown. On abort the stream just stops.
- Every error has a kind, and the kind fixes whether it may be retried: rate limit, provider failure, transport and
  incomplete stream are; auth, usage limit, content policy, invalid request and context overflow are not.
- An error carries the provider's request ID as `requestId` when a response supplied one; the message never contains
  it. A `finish` carries the same ID and the model that answered (`response`), when the provider gave them: facts
  for the ledger and a trace, never part of history. A `transport` error has a `reason`: `connection` (could not send, or the connection broke) or `stalled`
  (nothing arrived within the idle timeout).
- Provider-owned payloads (encrypted reasoning, item phase) travel as opaque `providerData` and are replayed verbatim.
- `Usage` keeps what the provider says it wrote to its prompt cache (`cacheWriteTokens`, and the part with the
  12-hour lifetime) exactly when the provider reported the figure, zero included; a missing figure is not zero.
  `step.ended`, the ledger and the trace export (`cache_write_tokens`, `cache_write_12h_tokens`, and `billing:
  "subscription"` for a call the signed-in provider served) carry it.
- A provider does not retry and does not change the request. The step loop owns the single attempt budget.

**Tool** (`tool/`)
- A tool declares an effect class (`read`, `write`, `exec`, `network`). Sandbox and approval decisions use the class,
  and the step loop records it in `tool.started`.
- A tool returns the text for the model once. After `tool.settled` is written that text is replayed byte for byte;
  `truncation` records that it was capped and where the full output is.
- Between a tool's return and the cap there is one step in which the caller may append to the result
  (`RunHooks.afterExecute`): it is given the tool, the validated input and the result, and what it returns begins
  with the tool's output byte for byte. The engine uses it for the notes of after hooks and, after them, the
  diagnostics of an edit. The result is still capped once and stored once (a tool that capped itself keeps what
  is added after its capped text), and the step is not taken for a tool that threw, was refused or never started.
- The context carries the abort signal with its reason. The signal is the call's own (`createCallStop`): it
  follows the execution's, and can be fired for that call alone. `callStopReasonOf(signal)` says which: `user`
  or `shutdown` when the turn is interrupted, `call` when the user stopped this call and the turn goes on. A
  tool that is aborted returns what it observed, and says who stopped it: the shell ends its output with
  `[Interrupted by the user. ...]` or `[Stopped by the user. ...]`. A tool that cannot stop midway finishes.
- A background command hands the session its output a line at a time (`BackgroundCommand.lines`): the lines
  still in memory, then each further line as it completes, as the log holds them (redacted where the output
  is). That is what a watch reads; the command is never polled.
- The context carries `putBlob`, which stores bytes in the blob table and returns the reference a tool lists in its
  result's `attachments`. The tool runtime supplies it from its options (`store.putBlob`), so a tool never sees the store.
- A tool that stands for many says which one a call means (`Tool.subject`: `mcp_call` names the server's tool, so an
  approval is asked about and remembered for `github/create_issue`, never for the bridge), and a tool whose call
  acts later says so for the question (`Tool.cautions`: `wake_create`).
- A tool whose calls change less than its class says declares it (`Tool.changes: "records"`: `wake_cancel`,
  `memory_save`, `memory_retract` change only records the harness keeps for itself). The class stays `write`
  (a crash is still `effect_unknown`, the step is still bracketed by snapshots); the approval layer reads the
  declaration. It is not part of the tool's spec.

**Approval and the sandbox** (`approval/`, `sandbox/`, `engine/approval.ts`; for users: `docs/safety.md`)
- `decide` is pure. It is given the mode, the call's effect class and origin, the facts about its path arguments
  (`pathFact`: the real path with every link followed, and whether it lies in the workspace, in `.git` or the
  harness's project directory, outside, or in a path the sandbox hides), the escalation the model asked for with
  the shell call's `sandbox` argument, whether a sandbox exists, the session's taint, the remembered approvals and
  whether anyone is present. It never reads a command's text. The engine does the lookups and the writes.
- A call that changes only the harness's own records (`Tool.changes`) is no file write: there is no path to
  check and nothing a sandbox would contain. It runs without a question in `auto` and `full`, attended or not,
  and `ask`, where every change asks, asks about it as that (need `records`, remembered by tool).
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
  engine keeps that history in memory, built from the session's own events on first use and extended with every append
  (a fork's own events begin with the entries its `session.created` carries of the history it inherited, so its
  parent's file is never read for it). A write
  outside the workspace is not a source: its result shows nothing of the file. Two sources say what they are
  themselves, in a field: an MCP bridge call's result records in `display.mcp` whether it holds content an untrusted
  server wrote (it is a source when it does, so a call to a server the user's file marks as trusted, or one refused
  before anything was sent, is not), and an admitted input records `untrusted` (a wake-up's firing with a webhook's
  body or a networked check's output), which is a source from the admission on. A third is `background_output` showing a running subagent's words:
  its `display.subagent.tainted` says the subagent's conversation was tainted then, and the result is a source
  like the subagent's answer. Two more are records, not results: a hook's
  `hook.ran` says in `taint` when its text reached the model and the hook ran with the network by the user's
  grant, or is a project's in a repository the user marked untrusted; and a result's `diagnostics.untrusted` says
  the note in it holds the messages of a language server the project chose, in such a repository. `taint.noticed` records that the
  user was told, and is what a client shows; a fork inherits it, a revert and a compaction leave it.
- Redaction is applied by the loop to every tool result before `tool.settled` is written (the text, and every
  string of the structured `display` data), and to a check report. A check's own output is redacted as it
  arrives, like a command's (`RunCheckOptions.redact`): its progress and the file that keeps it in full hold
  the placeholders, and that file is named by the hash of the redacted output. The values are the engine's `secrets`: by
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
  `resolveApprovalConfig` lets the project's only tighten the user's. The sections `mcp`, `skills`, `wake`,
  `memory`, `agents`, `hooks`, `lsp`, `commands` and `telemetry` are validated by the modules that own them, and `LoadedConfig.files` hands on both files
  apart, because for each of them it matters who wrote a value (see "Skills, MCP servers, wake-ups, memory and
  agents", "Hooks and language-server diagnostics" and "Slash commands and live telemetry"). The project's file is validated as the project's:
  only the user's own may run a hook outside the sandbox. `loadConfigSync` is the same loader without a turn of the event loop, for the two things that cannot
  wait for an execution to read the files: how a session's calls are decided, asked before its first turn, and
  the agent a new session starts as.
- `decideGate` is pure: finish, run these checks, report and continue, or finish unresolved. `renderReport` is the
  deterministic text the model is shown; `acknowledgeTool` is the tool (`report_check_failure`) with which the model
  says it cannot fix a failing check. An acknowledgement is that tool call, never parsed prose; a check may be
  named by its name or by the label the report shows it with.

**Engine** (`engine/`)
- `createEngine` takes everything it touches as a dependency (the stores, provider, tools, clock, ID generators,
  the jitter source, limits, the data directory, the snapshot opener, the configuration loader, the check runner),
  so tests inject fakes. `createHarness` (`assembly.ts`) is the one place the real ones are put together; the CLI
  and the ACP server both call it and write nothing to a store themselves.
- A session offers `send` (steer or queue), `admit` (input from a harness component under a message ID it is
  given: a reused ID is a duplicate and writes nothing), `start`, `interrupt`, `setSettings` (model and effort, at the next step
  boundary), `withdraw` (a prompt that was not delivered yet), `readEvents` (its stored log, for a client that
  replays history), `revert`, `undoRevert`, `rename` (`session.renamed`, at any time), `compact` (a compaction
  the user asks for, see "Compaction"), `setAgent`, `agent` and `agents` (see "Agents"), `hooks`, `approveHook`,
  `lsp`, `approveLspServer` and `onFeatureChange` (see "Hooks and language-server diagnostics"), `commands`, `findCommand`,
  `expandCommand` and `sendCommand` (see "Slash commands and live telemetry"), an event stream and
  `close`. Closing a session closes that session:
  its work stops as a shutdown, its store is let go of so that any process can open it, and the engine and its
  other sessions carry on.
- The engine offers `forkSession` (see "Forks"), `replaySession` (see "Replay" and `docs/replay.md`),
  `createSession`, `openSession`, `listSessions` and `listSessionsPage` (by directory, without archived ones and without the harness's own sessions, subagents and replays, unless
  asked), `latestSession`, `getSession`, `resolveSession` (an ID or a unique prefix), `readEvents` (of any session,
  open or not, held here or elsewhere), `archiveSession` and `unarchiveSession` (through the session's log, holding
  it only for that append), `turnChanges` (the files each ended turn of a stored session changed, from its
  snapshots, one entry per `turn.ended` or terminal event), `listAgents`, `listCommands`, `telemetry` (the
  collectors live telemetry has sent to, with what waits and what was dropped, taken and not taken), and `validateSettings`, which rejects a
  model the provider does not offer, naming the ones it does, and a reasoning effort the model does not offer,
  naming the ones it accepts. The listing it fetched is kept: `createSession` and `setSettings` refuse the same
  settings from it without a request, and before a step is sent the loop checks the effort once more (fetching
  the listing if nobody has), so an effort a model lacks ends the execution with the sentence instead of costing
  a request and an HTTP 400. Listing and reading open nothing and close nothing. Opening a session another process holds fails
  with `EngineError` `session_in_use`, which carries the holder's process ID and a message that says what to do.
- One step is one model call. Before every step the loop re-reads the projection and decides from stored state alone;
  it keeps no conversation state in memory. Reading the state costs what the last appends changed, not the
  length of the log (see `getProjection` under "Store"), so the time of a step does not grow with the session. Events that are decided together are appended in one transaction.
- `tool.called` is durable when the call finishes streaming and `tool.started` right before the tool runs, both
  before any side effect. An interrupt is durable (`execution.interrupt_requested`) before anything is aborted.
- *Stopping one call.* `session.cancelCall({ callId, messageId?, sessionId? })` stops one running call as the
  user and lets the turn go on (`sessionId` names a subagent whose call it is). `tool.cancel_requested` is
  durable first; then that call's signal fires with the reason `call`, and the tool has the grace period an
  interrupt gives every tool (`toolStopGraceMs`). The execution is not interrupted: the call settles like any
  running call, the step continues with its other calls (the next call in the line starts), and the model reads
  the result in its next request, where nothing else says that a call was stopped. What the result is, by what
  the tool could do about it:
  - a command (`exec`): the shell stops the process group and returns what was printed and a line that says the
    user stopped it, so the call settles as `error` with that output;
  - a subagent call: the child is interrupted as by its own user and winds down by the usual rules; `spawn.ended`
    says `stopped`, and the call settles as `error` with a result that says the user stopped this call and
    quotes the child's last words. The child's conversation stays;
  - a read, or a write (one rename), which cannot be stopped midway: the tool finishes and the call settles with
    its ordinary result. The request stays on record with the call;
  - any tool that reports nothing in time, or throws while it is being stopped: the loop settles the call from
    the effect class it started with, as it does for a call an interrupt reached (`error` for a `read`,
    `effect_unknown` otherwise), with a text that says the user stopped this call; what the tool returns later
    is dropped. An MCP call (`network`) observes the abort: the bridge cancels the request, and the call settles
    as `error` with the bridge's text, which says the server may or may not have finished the work.

  It is refused (it returns `false` and writes nothing) for a call that has not started (a question about it is
  declined instead, and a call waiting in the line cannot be stopped ahead of its turn), one that has its
  result, one already asked to stop, while the turn is being interrupted (everything stops then), and in a
  replay. An interrupt after the request winds the call down by the interrupt's rules.
- *The identical-call guard.* A call is refused, without running, when the two calls before it in the turn were
  the same call (same tool, same arguments) and gave the same result (`repeatsItself`, `engine/state.ts`): the
  model is going in a circle. A tool whose result changes without any call of the model's says so with
  `Tool.varies`, and the guard leaves it alone: `background_output` (a command that printed nothing new for a
  while is polled again, and a subagent's state moves by itself), `wake_list` (wake-ups fire and expire by the
  clock), `mcp_search` and `mcp_call` (a server elsewhere may answer differently, and one that was starting is
  there a moment later). `varies` is a property of the tool like its effect class, not of its spec: the name,
  the description and the schema the model is sent are the same with it. The step limit still bounds the turn.
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
- *A session is idle when its reader sees the turn's ending.* `execution.succeeded`, `execution.failed` and
  `execution.interrupted` are durable the moment they are written, and are delivered to the stream and to
  listeners once the run that wrote them has let go of the session (with everything published after them, in
  order). A client that sees the ending and at once asks for something that needs an idle session (`revert`,
  `undoRevert`, `compact`, `setAgent`, a new prompt) is therefore never refused as busy, however many turns of the
  event loop the loop takes to return (`test/engine/idle-at-ending.test.ts`).
- `Engine.close()` is the hook a process calls before it exits: every session is stopped as a shutdown, which leaves
  its execution suspended and resumable, and is let go of (an execution that has no turn, a compaction the user
  asked for while idle, is ended instead: see "Compaction", *On request*). If the process dies without it, a guard process kills
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
  turn. When the execution would otherwise succeed, the loop snapshots the workspace and asks first whether this
  turn changed it: whether it differs from the `delivery` snapshot taken when the turn's input entered history. A
  turn that changed nothing runs no check and ends as `not_needed`, whatever happened before it. That is the rule
  that keeps a question from running the whole suite after the user edited a file by hand or undid a turn: the
  user is not shown "checks passed" for a turn that did nothing, and a hand edit that breaks a test does not send
  the model off to fix work it was not asked about. When the turn did change files, the loop diffs the workspace
  against the state at the last verification that passed, selects the checks whose `when` patterns match, and runs
  them (`checks.started` is durable first; an interrupt stops them like tools). Which checks run is decided from
  everything that is unverified, the turn's own changes or not: a check reads the whole workspace and cannot tell
  whose change it is looking at. The results and the decision are one append: `checks.finished` with the terminal
  event, or with the report that sends the model back. The turn ends unresolved when the model acknowledges the
  failure with the tool, after `maxRounds` reports, or in `report` mode, where the model is shown the failure and
  not sent back. A configuration that cannot be loaded fails the execution before anything is sent, and says so; anything else
  that fails as an execution starts (the store, say) is reported as the harness's own failure, in its own
  words, never as a configuration problem.
- *What "this turn" is, and what stays unverified.* A turn begins with the first input delivered under an
  execution, and again with every queued message; a steer redirects the turn it arrives in and begins none, so
  what the turn changed before it still counts. A subagent's changes are its parent's turn's: they happen while a
  call of the parent runs, or, for a background subagent, before the turn can end. A change someone else made
  during the turn (the user, by hand) counts as the turn's too: the two cannot be told apart, and in doubt the
  checks run. A turn that was told that spawned work ended (a background command exited, a background subagent
  finished or was lost) is checked for everything since the last verification: that work runs outside the steps,
  also between two turns, and its exit is the first moment anyone can verify it. A turn that changes a file and
  puts it back changed nothing. When a turn changed nothing while files the checks cover differ from the verified
  state (a hand edit, an undo, an earlier turn that ended unresolved), its `not_needed` says `unverified`, and
  `verification.verified` does not move: those changes are checked, with everything else, at the end of the next
  turn that changes a file. Without snapshots the stand-in for "the turn changed files" is whether a call that
  can change them ran in the turn, and then every check applies.
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
  the workspace as it is, announces the restore, restores, and records the result with `history.reverted`. The
  record a revert and its undo return and store counts the files the restore wrote (`written`) apart from the ones
  it removed (`removed`: they did not exist in the snapshot it went back to); `changed` is both. Files
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
- *Who changed a file the restore asks about.* Each such file in a revert's plan says who it was, as far as the
  snapshots tell (`changes[].editedBy`, set exactly when `handEdited` is): `outside` when nothing of any
  session ran as it changed, so the user or another program; `session` with the other session's ID when it
  changed inside that session's own work, read off that session's log and snapshots (`changedInOwnWork`; the
  ID is `null` when the work of more than one session spans the change); `unknown` when it cannot be told: the
  file changed while this session's own command ran and another session was recording the directory, in none
  of whose own work it shows, or the snapshots in between are gone. A client words its question from that
  instead of calling every such file edited by hand.
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
  view (one huge tool result is the last step) is not made: the request is sent while it fits, and compacted aggressively at once when it does not. Nor is
  one made whose result is known beforehand not to fit: before the summary is asked for, the loop predicts the
  request after it (what no compaction removes, the kept tail, and the summary and the checkpoint at their
  bounds), and when that is larger than the usable window, or the kept tail alone is as the policy will judge
  it (an estimate with its margin), the compaction is aggressive at once. A normal one would have been
  followed at the next boundary by an aggressive one: two summary calls for one compaction's worth of room.
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
  (`source`, `detail`), the size after and how many summary requests it took (`calls`), so a client can tell the user: the CLI prints the sizes before and
  after, and for a fallback why there is no summary and what the model continues from.
- *The checkpoint* (`context/checkpoint.ts`) is rendered once, from every non-excluded message before the cut in
  the whole log, and frozen in `compaction.ended`: the summary, an index of exact identifiers (files with lines,
  commands with the outcome of each run, errors, commits, failing tests), the user's messages verbatim up to a
  budget, and the pointer to the history tools. It is never rendered again, whatever the checkpoint code becomes.
- *On request.* `EngineSession.compact()` makes the same compaction because the user asks (`trigger: manual`): the
  same summary request, repair, fallback and events. It keeps word for word what the next request has to answer
  and, where the window is known, the short tail an aggressive compaction keeps. It happens at a step boundary
  under a claim: while a turn runs, at the boundary after the step in progress, and the turn carries on from the
  checkpoint; while idle, under an execution of its own that ends right after `compaction.ended` with no step and
  no check (there was no turn, so the gate finds nothing of a turn's to verify), the baseline being set again when
  the next turn is about to send a step. It resolves with the sizes before and after, or with `nothing` and the
  reason, and writes nothing, when there is nothing worth compacting: no conversation yet, only what the next
  request needs in view, or fewer than `manualCompactionMinTokens` (2,000) tokens to take out, which a checkpoint
  would not undercut. A request that never reaches a boundary because the turn failed or was stopped first is
  answered with `failed`, never made later behind the user's back. The execution of an idle session's compaction
  is not a turn (`turnless` in `engine/state.ts`: nothing was said under its claim and nothing waits), and an
  interrupted one leaves nothing behind: the compaction fails as interrupted, no marker is left for the model, so
  the conversation is as it was, and the claim is released. That holds for a shutdown too: the session is closed
  while the summary is being written, the interrupt is requested and recorded with the reason `user`, not
  `shutdown`, because `shutdown` means a claim kept for the next start and there is no turn to take up. A process
  that was killed instead ends the same way at the next start: recovery (`engine/recovery.ts`) closes the open
  compaction as crashed and releases the claim with the same two events, where any other execution would be
  resumed. The next request for a compaction starts an execution of its own.
- *The task list.* The model's task list is the `display` of its latest successful `todo` call (`tools/todo.ts`;
  nothing is stored outside the log). When a compaction removes that call from the model's view, the checkpoint
  carries the list as the call left it, after the summary.
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
- *The context window in tests.* `WINDLASS_TEST_CONTEXT_WINDOW` (the name is built from `brand`) lowers the
  window `createHarness` hands the engine, so an evaluation run compacts after tens of thousands of tokens. It can
  only lower it, the harness says so on its log, and no configuration file has a key for it.
- A diagnostic about a session (a prefix violation, an internal error, a tool that threw) is said once: as an
  ephemeral `diagnostic` event of that session's stream, which a client shows. It goes to the engine's log instead
  only when no open session can carry it. `onDiagnostic` hears every one. A diagnostic said while nobody is
  subscribed to the session (while `createSession` or `openSession` runs, before the caller has the session in
  hand: a warning about the agent it starts as, a project's `agents.default` that is not followed) is kept, up to
  64 of them, and handed to the first `subscribe` listener when it subscribes, before anything newer. The `events`
  stream holds every event from the session's creation and needs none of that.

## Subagents and background work

Two things run beside a session's own steps: subagents and background commands. Both are *spawned work*: recorded
in the session's log when they start (`spawn.started`) and when they end (`spawn.ended`), stopped with the session,
and reported to the model when they end. `engine/spawn.ts` has the tools and their texts; the session owns the
writes. `createHarness` switches them on (`EngineOptions.spawn`); an engine built without the option offers none.

**The tools.** Three are in a session's frozen tool list from its first baseline, with fixed specs: `subagent`
(`task`, and optionally `session`, `background`, `worktree`, `agent`), `background_output` and `background_stop`
(`id`). The shell tool has a `background` argument. Watching a command's output and stopping one call are not
tools: a client asks the engine for them (`watchOutput`, `cancelCall`).

**What a subagent is.** A real session (`lineage.kind = "spawn"`: its parent, the spawned work that started it, its
depth, its worktree). It starts with a fresh conversation: its own baseline (the same base prompt, the project's
instruction files discovered for its working directory, the environment, the date) and its task as its first user
message, with one line saying who reads its answer. It sees nothing of its parent's history. It runs the same loop
with the same tools, the parent's model settings (or its agent's, when it runs as one that names them), the
parent's approval settings and, by default, the parent's workspace. It has a cache key of its own. Its conversation stays: a follow-up by reference (`subagent` with
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
- *Verification.* The gate applies to the parent's turn. Children do not run it (their `execution.succeeded` says `left_to_parent`, whatever the project configures, and they are not offered the acknowledgement tool): several children each running the whole
  check suite in one workspace would mostly report each other's unfinished work, and the parent's turn is verified
  once their work is in.
- *Stopping the call.* A call that waits for a subagent can be stopped by itself (`cancelCall`): the child is
  interrupted, its work is recorded as `stopped`, and the call's result says that the user stopped this call.
  The parent's turn goes on.
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
  whether its conversation held untrusted content, and from that event on the parent is tainted too (source kind `subagent`), as by any tool result. The same
  holds earlier when the parent looks: `background_output` showing the latest words of a child whose
  conversation is tainted is a source from that result on.
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

**Watches on a command's output.** A background command wakes the session when it exits, and a server or a
file watcher does not exit. `session.watchOutput(id, { pattern, regex?, ignoreCase?, limit? })` sets a watch
on a running command: text a line must contain, or a regular expression a line must match, and how often it
may fire (once by default, `WATCH_LIMITS.maxFirings` at most; a command has at most `WATCH_LIMITS.perCommand`
watches that can still fire). `session.unwatchOutput(watchId)` removes one.

- *Who asks.* The user, through a client, as with an interrupt or a stop of one call. The model cannot: the
  tool list is final, so there is no argument for it to pass, and a convention inside a command's text would
  change what a tool's input means without its description saying so. It is also the safer owner: a watch
  turns a command's output into a message that starts a turn, and neither the model nor the command's own
  output should be able to arrange that. The model is not told that a watch was set; it is told when it fires.
- *What it looks at.* The command's output a line at a time (`BackgroundCommand.lines`), as the log holds it:
  first what is still in memory of what the command already printed (the last 64 KiB), so a line that came
  before the watch was set is not missed, then each further line as it completes. A line longer than 16 KiB is
  matched on its beginning. Nothing is polled, and nothing is kept for a command nobody watches.
- *A firing.* A harness message (`background_watch`) and `watch.fired` are one append. The message names the
  command and the watch, says how many firings are left, and quotes the matching line (cut at
  `WATCH_LIMITS.lineChars` characters) inside a fence longer than any run of backticks in the line, labelled
  `output` and introduced as output of the command, not instructions. The text is redacted like all command
  output and frozen in the event. It is a steer: delivered at the next step boundary, and it wakes the session
  if it is idle, exactly as the command's end does. A command that is being stopped reports its end, not what
  it prints on the way down.
- *Its end.* A watch is over when it has fired `limit` times. One that could still fire is ended on record
  (`watch.ended`): `removed` by the user; `command_ended` when its command ends, in the same append and right
  before `spawn.ended`, and the message about the command's end says that the watch had not fired; `lost` when
  the harness restarted (see Recovery). The reducer rejects a command's end while a watch on it could still fire.
- *Refusals.* `watchOutput` throws `EngineError` `invalid_request`, with a sentence for the user, and writes
  nothing: no such command runs (it ended, or is unknown), the ID names a subagent, the pattern is empty, has
  a line break, is longer than `WATCH_LIMITS.patternChars` or is not a regular expression, the limit is out of
  range, or the command has its fill of watches.

A watch lives in the process that runs its command, so it does not outlive that process, and neither does the
command.

**Recovery.** A session that is opened with spawned work its log says is running, and that nobody in this process
runs, lost it to a restart (`reapSpawned`). A command is recorded as `lost` (its guard killed it), and each
watch on it that could still fire is recorded as `lost` right before it, in the same append; the message that
tells the model that the command is gone says that the watch will not fire. A subagent is
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

## Skills, MCP servers, wake-ups, memory and agents

Five modules that were built apart (`skills/`, `mcp/`, `wake/`, `memory/`, `agents/`; each has a README) and are
wired into the loop by one file each in `engine/`. They have one rule in common, which is the reason they exist in this form:
**nothing they bring changes a session's frozen prefix.** Their tools have constant specs and are in the tool list
from the first baseline or never; what changes during a session (which skills exist, which servers are connected
and what they offer, which notes apply, which agents exist and which one the session runs as) is appended as a
message with its text stored. `EngineOptions.skills`, `mcp`, `wake`, `memory` and `agents` switch each on;
`createHarness` passes all five, and an engine built without one offers nothing of it.

| Feature | Tools in the frozen list | When | Appended source |
| --- | --- | --- | --- |
| Skills | `skill` | every session, whether or not a skill exists | `skills`: the index |
| MCP | `mcp_search`, `mcp_call` | every session, whether or not a server is configured | `mcp`: the catalogue |
| Wake-ups | `wake_create`, `wake_list`, `wake_cancel` | a session a person started, while `wake.enabled` (default on) | none: firings arrive through the inbox |
| Memory | `memory_save`, `memory_retract`, `memory_search` | a session a person started, while `memory.enabled` (default **off**) | `memory`: the notes |
| Agents | none of its own: `subagent` has an optional `agent` argument in every session | every session | `agent-index`: the list of agents, for a session whose list has `subagent`; `agent`: a switch |

"When" is decided once, as the first baseline is set, like the acknowledgement tool: the list keeps the tools or
lacks them from then on, also across a compaction and whatever the configuration says later. Skills and MCP are
unconditional so that every session of a build has the same list and a skill or a server that appears later needs
no change of it. A feature acts only for a session whose list has its tools: an index, a catalogue or notes are
never given to a model that has no tool to act on them. The tool list of a session of the real harness has 20
tools with verification on and memory off (the seven file and shell tools and `todo`, two history tools, three for
spawned work, the acknowledgement tool, and the six of skills, MCP and wake-ups); memory adds three. It is about
3,300 tokens of every request by the harness's estimate (`bun scripts/tool-block.ts` prints it per tool). The list
is meant to be final: `wake_create` is described in under 400 tokens, with each trigger's reference in the answer
to a call that is not valid instead of in every request.

**Skills** (`engine/skills.ts`). At every step boundary the skills of the session's working directory are
discovered (a few `readdir` and `stat` calls and one read per skill file) and the index is appended when its
fingerprint differs from what the model has. Nothing is cached: measured on a loaded two-core machine, discovery
takes 0.2 ms with no skill, 1.7 ms with 20 and 9 ms with 100 (agents cost the same), against a step that is a
model call of seconds; a cache keyed on sizes and modification times would still read every directory and stat
every file, and would miss an edit on a file system with coarse timestamps. So: editing a description, adding or removing a skill appends; editing a
body does not, and the next `skill` call returns the new body. What discovery could not load goes to the user as a
`diagnostic` of kind `skills`, once, never to the model; `EngineSession.skills()` gives a client the skills and the
problems. `skills.paths` is read from the user's own file only (a repository carries its skills in itself and
must not point the harness at other directories); `skills.disabled` from both files.

**MCP servers** (`engine/mcp.ts`). The engine has one hub with one registry per distinct server (its
configuration and, for a started one, the directory it starts in), shared by the sessions whose configuration
names it, started when the first of them reads its configuration and stopped when the last lets go or the engine
closes. Starting never blocks: the registry connects in the background, and a server that is ready later is
appended later. The first step of an execution alone gives servers that have never answered a bounded moment
(`McpSetup.startWaitMs`, 1.5 s), so that a one-prompt run has the catalogue in its first request.

- *The call.* `mcp_call` is a `network` tool with origin `mcp`. The approval layer decides it: in `ask` and
  `auto` it is asked about by the server's tool (`Allow the MCP tool github/create_issue?`), and the answer can be
  remembered for that tool, for the session or the project; nobody present, it is refused; `full` runs it until the
  session is tainted. `mcp_search` is a read.
- *What is recorded.* `tool.settled.display.mcp` holds the kind (call or search), the servers whose text is in the
  output, the tool, whether that text is untrusted, and the outcome (`result`, `tool_error`, `failed`, `refused`).
  The catalogue's `instruction.appended.detail` names each server with its number of tools and whether it is
  untrusted. Taint reads the first; nothing is parsed out of text.
- *Taint.* A bridge result that says `untrusted` is a source (kind `mcp-tool`, named by the server's tool). The catalogue is not: it is one line per tool, given to every session at its start, and a warning that is always
  on teaches people to ignore it. A search (`mcp_search`) is not one either for what the catalogue carries: the
  names, descriptions and input schemas a server declares for its tools, with or without `includeSchema`, so
  that looking a tool up does not change how its call is decided (a one-prompt run in `full` can search and
  call a tool of an untrusted server). A search is a source only for text the catalogue never carries: a
  server's notes and the error text of a server that is unavailable. That its descriptions are server-written is on record for a stricter policy.
- *A project's server.* A server named by the user's own file starts. One the project's file names, or changes in
  any way, does not: opening a repository must not run a command, or send the user's environment to an address,
  that the repository chose. It waits for the user's approval, which is a remembered approval for the project like
  any other (`approval/grants.ts`: a `tool` rule `mcp-server:<name>:<fingerprint>` in
  `approvals/<workspace hash>.json`, 30 days), for exactly this definition of the server: the fingerprint is of its
  merged configuration, so an edited command is asked about again. `EngineSession.mcp()` lists the started servers
  and the ones that wait, with the words of the question and the command as an argument list (`argv`, one string
  per argument as the definition has them; `null` for a server reached at an address), so a client shows it with
  `quotedCommand` and never reads the configuration file again to find where an argument ends;
  `approveMcpServer(name, fingerprint)` records the approval and starts the server. Both work before a session's
  first message, like `hooks()` and `lsp()`: asked before an execution has read the configuration, `mcp()` reads
  the files as they are now (`loadConfigSync`), so the servers that may start are starting and a project's server
  can be approved before the first request is built; the tool list is the same either way, and the catalogue
  still arrives as an appended message. The notice the engine
  itself says about a server that waits shows the same: the whole command, each argument quoted, never cut. The question is not tied to a tool call, so it is not an `approval.requested`
  event: the session's log does not change when a server starts, only when its catalogue is appended. Until a
  client puts the question, the user is told by a `diagnostic` of kind `mcp`, and a call that names the server is
  answered with why it went nowhere. There is no unattended default.

**Wake-ups** (`engine/wake.ts`). A firing is delivered through `EngineSession.admit`: `inbox.enqueued` with the
firing's own key as the message ID, origin `wake` (or `wake_webhook`), delivery `queue`, and with delivery `wake`
a start as `send` makes it. The key makes a redelivery a duplicate: the engine looks it up in the session's log
(messages, the inbox, and withdrawn items) and writes nothing; if the message still waits and was to start a turn,
the turn starts then. The scheduler's `deliver` opens a session that is not open in the process (held elsewhere:
retry; archived, gone or a replay: the wake-up fails), and lets go of it again when its turn is over unless a
client opened it meanwhile.

- *Which processes fire.* Every process that offers the tools can create, list and cancel: wake-ups are records
  in a store all processes of a data directory share. The scheduler and the webhook listener run only in a
  process that asks for them (`EngineOptions.wake.run`): the `acp` stdio server does (`packages/acp/src/stdio.ts`),
  from its start and not from its first session, unless its environment says `<BINARY>_WAKE=off`. It is the
  long-lived process: an editor, the terminal interface and an interactive command line keep it for as long as
  they run. Several may run at once: each firing is delivered by exactly one of them (the store's leases), the
  listener's port belongs to whichever bound it first, and the others carry on (`test/engine/wake-servers.test.ts`
  runs two). An engine used directly, and the in-process transport, do not fire. A client that starts the server
  for one prompt should set the variable to `off`: its server would otherwise start other sessions' wake-up turns
  and cut them short when it exits (they stay resumable, and resume when their session is next opened). What a
  process that does not fire sets up fires in the next one that does.
- *Shutdown.* `Engine.close()` stops the listener and the scheduler first, then the sessions, then the MCP
  servers and the language servers, then sends the spans live telemetry still holds (for a short while at most),
  then closes the wake store.
- *Approval.* `wake_create` is an `exec` tool with the shell's `command` and `sandbox` in its input, so it is
  decided exactly as that command would be; the question adds that it acts later, unattended, and how often. What
  the call ran under becomes the most the wake-up's check may run with. Before each run the scheduler asks what
  the session's commands may have now (`runAllowedNow`): sandboxed and offline once the session holds untrusted content, the recorded run otherwise, never more. A
  session that is not open in the process that runs the check (closed, open elsewhere, not opened since a
  restart) is decided as an open one would be, from what is stored: the policy of the user's file and the
  project's for its working directory, the process's own settings and its agent's mode, the taint derived from
  its log under that policy, and the taint it noticed itself. Only a choice a client made for the open session
  is not known there. A check's output is redacted as it arrives, so its `on_change` fingerprint is of the
  redacted output.
- *Taint.* A firing with a webhook's body, or the output of a check that had the network or no sandbox, is
  admitted with `untrusted`, and the user is told (`taint.noticed`) before the execution it starts.
- *A wake-up the user creates.* `Engine.wake().create(request)` creates one for a session as the user (author
  `user`): the trigger and limits as the module takes them, validated by the module with the bounds it gives a
  user (`WAKE_LIMITS.user`, wider than the model's). What a client may not say the engine fills in: the
  session's working directory for a check, whether the session holds untrusted content, and where in its log it
  was. For a check the user chooses the access (`run`); without a choice it is the sandbox, offline. It is the
  most the check ever runs with, narrowed when it runs like a model's. Refused with a sentence for the user: a
  session that does not exist, is archived, is a subagent or a replay, or whose configuration turns wake-ups
  off. The scheduler and the listener are told at once. Listing, cancelling and a webhook's secret are the
  store's (`wake().store`).
- *Configuration.* The store, scheduler and listener are one per process, so the user's own file configures them.
  A project's file tightens per session: it turns the tools off and lowers the model's limit of pending wake-ups.
  Its lower hourly ceiling is not applied.

**Memory** (`engine/memory.ts`), behind `memory.enabled`. With the flag off as the first baseline is set, nothing
of it exists for the session, then or later, and its requests are byte for byte those of an engine without memory
(a test holds this). With it on: the notes are appended under source `memory` (the block, then updates for what
this session changes), each delivery is recorded in memory's usage log before the message is appended, and the
outcome of each turn is recorded from `execution.succeeded`, `turn.ended`, a user's interrupt and
`history.reverted`. The model's quote of the user is looked up in the session's own visible user messages. A
subagent is not offered memory. `EngineSession.memory()` gives a client the store, also before the session's
first turn: with no baseline yet it answers by the rule the first baseline freezes the tool list with (a session a
person started, the flag on in the files as they are now), so a note the user saves before the first message is
saved at once. The loop itself follows only a frozen list, so nothing is delivered or recorded earlier for it. The A/B comparison that decides
whether memory stays reads evaluation results and lives in `evals/memory-compare.ts`; core imports nothing from
`evals/`.

**Agents** (`engine/agents.ts`; `agents/README.md` has the format and the texts). An agent is a role kept as a
Markdown file: instructions, and optionally a model, an effort and restrictions.

- *What never changes.* The tool list and the system prompt. Every tool stays offered whatever the agent allows.
- *Starting as one.* `createSession({ agent })`: a name, `"none"`, or nothing, which means the default of the
  user's own configuration (`agents.default`; a project's file cannot choose it). The definition is read once,
  then: `agent.switched` follows `session.created` in the same append with the record (the instructions, the
  restrictions in force, the fingerprint of the file, its model and effort), the session's settings are the
  agent's where it names them, and the first baseline carries the agent's instructions as its last section
  (source `agent`). An agent that cannot be found, or names a model the provider's listing lacks, creates
  nothing. The session never reads the file again: otherwise it could widen its own restrictions with `write`.
- *Switching.* `setAgent(name | "none")` reads the definition. While the session is idle the switch is recorded
  at once, so a process that dies afterwards has not lost it; while a turn runs it is made at the next step
  boundary. Either way, once a baseline is frozen, it is an instruction message of source `agent` (the new
  instructions, saying what they replace; a one-line withdrawal with fingerprint `null` for "none") and `agent.switched` naming that message, in one append (the one message that may enter history without a running execution), and then `settings.changed` when the agent names another model or effort. A switch to an agent on the session's own settings keeps the whole cached prefix. After a
  compaction the new baseline carries the agent in force, from the record.
- *Restrictions.* Before a call is decided (after the calls the loop itself refuses, and with or without the
  approval layer) `checkAgentCall` looks at the tool's name, effect class and origin. A call the agent may not
  make is settled as an error with the sentence the model reads, and recorded as `approval.denied` with `agent`
  set and `refusal`: the rule that refused it (`denied_tool`, `not_listed`, `effect`, `mcp_tool`), the effect
  class the tool declares, and the rule as a sentence about the agent, which a client shows the user as it is
  instead of working the reason out from the tool's name. Anything else goes on to the approval layer unchanged, so a definition can only take away. The approval
  mode in force is the user's or the agent's, whichever is stricter. The acknowledgement tool is exempt.
- *Subagents.* `subagent` takes `agent`; the name is looked up when the call runs (a miss is an error result
  with close names and starts nothing). The child is created as the agent, with its restrictions combined with
  its parent's; a child started without `agent` by a parent that runs as an agent runs as the parent's.
- *The list.* A session whose tool list has `subagent` is given the agents that exist as an appended message
  (source `agent-index`), again when the list changes, and a withdrawal when none is left.
- *For clients.* `Engine.listAgents(cwd)`, `EngineSession.agents()`, `agent()` and `setAgent()`. Problems
  (a definition that was skipped or shadowed, a restriction that names a tool that does not exist, a model that
  is not offered, a project's `agents.default`) are `diagnostic` events of kind `agents`.

## Hooks and language-server diagnostics

Two more modules that were built apart (`hooks/`, `lsp/`; each has a README) and are wired into the loop by
`engine/hooks.ts` and `engine/lsp.ts`. Neither brings a tool, and neither has anything in a request's prefix:
which hooks and servers exist is configuration the model is never told. What they say reaches the model inside
something that is appended anyway: the result of a call, or a harness message. `EngineOptions.commandHooks` and
`lsp` switch them on; `createHarness` passes both. **With no hook and no language server configured a session's
requests and its log are byte for byte those of an engine without either** (`test/engine/hooks.test.ts` holds
this): the two call sites below are not even entered, so a call is decided, run and capped exactly as before.

**The three points of a hook.** The configuration is read when an execution starts, so a change takes effect at the
next turn. Hooks of a point run one after another, the user's first, then the project's.

- *Before a call is decided.* After the calls the loop itself refuses and the agent's restrictions, in the
  runtime's `authorize`, before the approval layer: the before hooks that apply to the call are run with its
  validated arguments. The first that objects settles the call from `pending` as an error with its reason (no
  question is asked, nothing starts); one that cannot answer refuses too, unless it says `onError: "allow"`. The
  user is told of a hook that could not answer by a `diagnostic` of kind `hooks` that says what became of the call:
  that it is refused while the hook fails, or, under `onError: "allow"`, that it went on without the answer. A
  hook that does not object approves nothing: the approval layer decides next, unchanged. The order rules of a
  step hold: a read's hooks run when the read is decided, a side-effecting call's when its turn in the line comes.
- *After a tool ran.* In the runtime's `afterExecute`, before the cap: each after hook that applies is shown the
  result as the model will be shown it (redacted) and may add a note after the tool's own output. A hook that
  fails adds nothing. Then the language servers (below). A refused or denied call, and a tool that threw, have none.
- *When a turn may end.* After the verification gate said so (`finish`), also when a queued message waits behind
  the turn: the stop hooks are asked. One that objects sends the model back with its message, a harness message of
  origin `stop_hook`, appended with the records and with whatever the gate was about to write (a run's
  `checks.finished`) in one append. The rounds are counted from those messages in the log (`stopRoundsSent`),
  never kept in memory. At `maxStopRounds` the turn ends anyway: its ending carries `hooks.unsatisfied` and
  `hooks.objections` (what each of those hooks said this last time, which was sent to nobody, so the `hook.ran`
  of that round has no text for the model and the ending is where a client reads the hook's words), and the
  user is told by a `diagnostic` of kind `hooks`. A stop hook that cannot answer lets the turn end. Gate first,
  then hooks: a turn the gate sends back is not asked about, and after a stop hook's round that changed files the
  gate runs again before the hooks do. A subagent's turn runs no stop hooks (its parent's turn does, as with the
  checks), nor does an execution that has no answer to end on.

**What is recorded.** One `hook.ran` per hook that applied, in the append of what it decided: before the
`tool.settled` of its call, with the stop message, or with the turn's ending. A project's hook nobody approved is
recorded as `skipped`. An interrupt reaches a running hook through the execution's signal (its process group is
killed); the call is then `not_started`, a result goes on without the notes not yet given, and the wind-down
writes the records of the hooks that had finished before it settles the calls.

**How a hook runs.** Through the checks' runner, so in its own process group, with a timeout, and with its
output redacted as it arrives (`hooks/run.ts`). Like the model's own commands: in the sandbox, offline, in `ask`
and `auto` and in `full` once the session is tainted; a user's hook with `sandbox: false` always outside it; a
project's hook never where there is no sandbox (for a before hook that refuses the call). With the approval layer
off a hook runs as it is, as every call does.

**Language servers** (`engine/lsp.ts`). The engine has one hub with one registry per working directory and
configuration, shared by the sessions that work there, created when the first of them reads its configuration
and stopped when the last lets go or the engine closes. Creating one starts nothing: a server starts, in the
background, at the first file it serves.

- *After a read* of a file a server serves, the file's text from disk is shown to the server (`observe`), which
  never waits: the diagnostics from before the next edit are then ready when it comes.
- *After an edit.* For a `write`-class call that names one file a server serves: once the call may run, the
  file's text is read (`null`: it does not exist); after the tool returned successfully, and after the after
  hooks (a formatter may have rewritten the file), the text is read again and the servers are asked what the
  edit made worse (`diagnose`). That returns within `lsp.waitMs` whatever the servers do; the loop adds no wait
  and never asks twice. A note, when there is one, follows the tool's output and the hooks' notes after a blank
  line. `tool.settled.diagnostics` records what the servers said. Why an edit got none (still starting, too
  slow, crashed, not approved) is a `diagnostic` of kind `lsp`, once per server and reason; the model is told nothing.
- The note gates nothing. The verification gate runs as before, whatever notes were shown.

**A project's hook and a project's server.** As with a project's MCP server: what the user's own file names
runs; what the project's file names (a hook; a server it names or changes in any field) waits for the user's
approval of exactly that definition, remembered for the project like any approval (`approval/grants.ts`: a
`tool` rule, `hook:<fingerprint>` or `lsp-server:<name>:<fingerprint>`, in `approvals/<workspace hash>.json`, 30
days). The question is not about a tool call, so it is not an `approval.requested` event and nothing waits for
it: until a client puts it, the hook is skipped (and recorded as skipped) and the server is not started, the
user is told once by a `diagnostic`, and nothing of it reaches the model. `EngineSession.hooks()` gives the hooks
in force and the ones that wait, each with the question word for word; `approveHook(fingerprint)` records the
approval, in force from the next call. What the user is told about a hook or a server that waits shows its
command whole: a hook's as it is written, every line of it (a line a shell reads has no argument list), a
server's with each argument quoted (`quotedCommand`), and a language server's question carries `argv` as an MCP
server's does. `lsp()` gives the started servers and the ones that wait;
`approveLspServer(name, fingerprint)` records the approval, and the server starts at the next file it serves.
`lsp()` is `null` only for an engine that offers no diagnostics; a session whose configuration names no server
that could give any has a state that says so (`configured: false`).

**Being told of a change.** `EngineSession.onFeatureChange(listener)` is one listener for the MCP servers, the
hooks and the language servers: it is called with `mcp`, `hooks` or `lsp` when what `mcp()`, `hooks()` or `lsp()`
would return has changed, so a client does not look again on a timer. The registries say when a server's state
moved (`McpRegistry.onStatus`, `LspRegistryOptions.onStatus`), the session says when it read a configuration or
recorded an approval, and the session compares what the getter returns with what the listeners last heard, so a
turn that reads the same configuration again says nothing. The countdown to an MCP server's next attempt is not
a change. Until a session's configuration is read it is taken to have no servers, no hooks and no language servers.

## Slash commands and live telemetry

Two more modules that were built apart (`commands/`, `telemetry/`; each has a README) and are wired in by
`engine/commands.ts` and `engine/telemetry.ts`. Neither brings a tool, neither has anything in a request's
prefix, and the model is told about neither. `EngineOptions.commands` and `telemetry` switch them on;
`createHarness` passes both. **With no command sent and no `telemetry` section that turns export on, a session's
requests, its log and its ledger are byte for byte those of an engine without either**
(`test/engine/telemetry.test.ts` holds this, and that telemetry which is on writes nothing either).

**Slash commands** (`engine/commands.ts`). A command is a Markdown file whose body is a prompt template
(`.<brand.directory>/commands`, `.agents/commands`, `.claude/commands` up to the repository root, then
`commands.paths`, then the user's own). It is the user's side of the conversation: what it produces is a user
message, and the model sees that message and nothing else.

- *For clients.* `Engine.listCommands(cwd, builtins)` and `EngineSession.commands(builtins)`: the usable
  commands, the ones a client's own command hides, and what discovery skipped or found shadowed.
  `findCommand(name, builtins)`: a client's own command first, then a file, exactly and then ignoring case; an
  unknown name comes back with the close names and the sentence to show. `expandCommand(name, args)`: what would
  be sent, with the positions that were not given and what was left as text, without sending (a palette's
  preview). `sendCommand(name, args, options)`: `send` for a command. All of them read the directories as they
  are at that moment; nothing is cached, as for skills.
- *What is recorded.* `sendCommand` reads the file once, expands its template with what was typed, and appends
  `inbox.enqueued` (the expanded text, origin `null`: it is the user's message) and `command.expanded` in one
  append. The expanded text is stored once, as the message's content, and is what every request renders; where
  it came from is fields (the name, the file, the fingerprint of the file as it was read, the arguments, the
  positions that became empty text, what was left as text), never parsed back out of the text. The reducer puts
  the record on the inbox item and on the user message, so a transcript shows the line as typed.
- *Nothing in a command file runs or reads anything.* Expansion is a pure function of the template and the
  arguments. A command in backticks after `!` and an `@path`, which other harnesses run and read when the slash
  is typed, stay in the text exactly as written; the expansion a client is handed and the record both list
  them, for the user. The model can run or read the same thing with its tools, which are decided like any call.
- *A command that cannot be used sends nothing.* An unknown name, a file that could not be loaded, an agent that
  does not exist: `sendCommand` throws `invalid_request` with the sentence for the user, writes no event and
  starts no execution, so no request is spent.
- *A command that names an agent.* The definition is read when the command is sent (a miss sends nothing). The
  session switches to it at the boundary where the command's message is delivered, right before it, by the
  rules of any switch: before the first baseline the record alone (the baseline then carries the agent), later
  the instruction message and `agent.switched`, then `settings.changed` when the agent names another model. A
  queued command's switch waits with its message: the turn in progress ends as the agent it ran as. It waits
  in the log, not in the process: `command.expanded` carries the agent's record (`agent`, the definition as it
  was read when the command was sent), the waiting inbox item has it, and the loop reads it from there where
  the item is delivered. A process that dies before the delivery and starts again therefore makes the same
  switch, from the same definition, whatever became of the agent's file; a command that is withdrawn takes its
  switch along. The delivered message keeps the command's record without the agent, which `agent.switched` has.
- *Configuration.* `commands.paths` (the project's first, then the user's) and `commands.disabled` (either
  file's) are read from both files: a command only ever produces a message the user sends.

**Live telemetry** (`engine/telemetry.ts`). For a session whose configuration turns `telemetry` on, the spans
of its turns are sent to an OTLP/HTTP collector as it runs. Nothing is written for it: spans are derived from
the log and the request ledger by the mapping an export after the fact uses (`telemetry/map.ts`), so a span sent
live and one exported later have the same IDs and say the same (`test/engine/telemetry.test.ts` compares them).

- *Who may turn it on.* The section is read when an execution starts, as the module requires
  (`resolveTelemetryConfig`): only the user's own file turns it on, names the endpoint and the headers and asks
  for content; a project's file can only turn it off, because a repository must not be able to send data off
  the machine. A header's `${NAME}` is read from the environment. A section that turns it on and cannot be used
  (no endpoint, a variable that is not set) is a `diagnostic` of kind `telemetry`, said once; the turn runs.
- *What is sent, and when.* The session keeps the part of its log that still has something open (the execution
  in progress, and an earlier one whose background work still runs), without the text a span does not carry,
  and the ledger rows of it as `callModel` writes them. At the events where a span closes (`tool.settled`,
  `spawn.ended`, a compaction's or a run of checks' ending, a step's ending, a retry, the next step, the turn's
  and the execution's ending) that window is mapped and every span that is closed and was not sent before is
  queued, once. A model call's span waits until its ledger row is finished and the log says what became of the
  call (its finish reason, or that it was retried). An execution's ending maps and sends at once, and cuts the
  window; in the middle of a turn mapping is put off by a moment (`mapDelayMs`, 1 s) so that a step with many
  calls is mapped once, and the queue is sent within `flushIntervalMs` (5 s).
- *A subagent's turn* is placed under its parent's spawn span, in the parent's trace, when the parent is
  traced: the child asks the parent's window where the spawned work that started it is.
- *The collector never slows or fails a turn.* Queueing never waits and never throws; sending runs off the loop
  through the module's background exporter, one request at a time, each with a timeout and bounded retries; a
  queue that is full drops its oldest spans and counts them (`Engine.telemetry()` shows the counts, never a
  header's value). A failure in the mapping itself switches telemetry off for that session and is said once.
  `Engine.close()` sends what is queued and waits for it `closeDeadlineMs` (2 s) at most; then requests in
  flight are cut and what is left is dropped.
- *Content* (prompts, answers, tool arguments and output) stays out unless the user's file says
  `"content": true`; then it is redacted with the engine's own secrets, as a tool's result is, and bounded.
- *What a model call's span has that the log alone could not give:* the provider's own ID of the request and
  the model that answered, from the ledger row (above), for a call that finished as for one that failed.
- *What it does not do.* A session that is opened again sends nothing of the turns that ended before; an
  execution a shutdown suspended and a later process resumed is, as in the export after the fact, one span up to
  the shutdown and spans without a parent after it.

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
ordinary loop finishes the turn in the copy, with the approval layer forced to `auto` and nobody present. The
step in which that happens is bracketed like any step that can change files: its `step_start` snapshot is taken
as the replay goes live (the copy as restored, before the first tool runs for real) and its `step_end` after its
tools, so the replay's log says what that step changed. A replay that never leaves its recording ran nothing:
the directory that was made for its copy is removed again (only when the replay made it, and only if it is empty). A replay
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
  An execution without a turn (a compaction asked for while idle) gets no marker, and a shutdown ends it as `user`.
- **One call stopped.** `tool.cancel_requested`, written before that call's signal fires · the call's
  `tool.settled` (what its tool observed, or the outcome its effect class gives) · the step's other calls and
  its `step.ended`, as ever · the next `step.started`. No interrupt, no marker.
- **A watch firing.** In one append `inbox.enqueued` (`background_watch`, a steer) and `watch.fired` · if the
  session is idle `execution.started` · `inbox.delivered` at the boundary · the model's steps.
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
- **A source that is never in the baseline.** At a boundary, after the baseline when one is set there:
  `instruction.appended` with source `skills`, `mcp`, `memory` or `agent-index` (the first text, a replacement, or
  a withdrawal with fingerprint `null`) · the delivery of waiting input · `step.started`.
- **A session that starts as an agent.** `session.created` (with the agent's model and effort) · `agent.switched`
  (no message) · later `baseline.set`, whose last source is `agent`. A call the agent may not make:
  `tool.called` · `approval.denied` (`agent`) · `tool.settled` (`error`, the sentence), in one append.
- **A switch of agent.** While idle, when the user makes it; in a turn, at the top of its next boundary:
  `instruction.appended` (source `agent`) · `agent.switched` (that message) · `settings.changed` when the agent
  names another model or effort · (in a turn) the delivery of waiting input.
- **An empty response.** `step.ended stop` with nothing said · the nudge (`synthetic.appended empty_response`)
  · the next step. A second empty response in a row: when a call of the turn has its result, `step.ended` and
  the turn ends through the gate (the user is told by a `notice` of kind `no_closing_answer`); when the turn
  did nothing, `step.ended` · `execution.failed`.
- **A subagent's own log.** `session.created` (spawn) · the task as its first input · its steps ·
  `execution.succeeded` with `left_to_parent`.
- **A compaction on request.** While idle: `execution.started` · `compaction.started` (`manual`) ·
  `compaction.ended` · `execution.succeeded` (`not_needed`); the `baseline.set` comes with the next turn. While a
  turn runs: the same two compaction events at the boundary after the step in progress, then `baseline.set` and
  the next step.
- **A turn that changed nothing.** The answer · `snapshot.taken checks_start` · `execution.succeeded` with
  `not_needed` (and `unverified` when files the checks cover changed outside the turn). No `checks.started`.
- **An MCP call.** `tool.called` · the approval layer's decision (a question by the server's tool, or a refusal) ·
  `tool.started` (`network`, origin `mcp`) · `tool.settled` (`display.mcp`: server, tool, untrusted, outcome) ·
  `taint.noticed` the first time such a result is untrusted.
- **A call a hook refuses.** `tool.called` · `hook.ran` (`beforeTool`, `no`) · `tool.settled` (`error`, the
  reason), the last two in one append. No `tool.started`. A hook that did not object: its `hook.ran` (`yes`) is
  written with the call's `tool.settled`, after the tool ran or after the approval layer refused it.
- **A result with a hook's note or a server's.** `tool.called` · `tool.started` · the tool · the after hooks ·
  the language servers · in one append `hook.ran` per after hook and `tool.settled` (the tool's output, the
  notes, the diagnostics note; `diagnostics` when a server was asked).
- **A stop hook's round.** The answer · the gate · in one append what the gate wrote (`checks.finished`),
  `hook.ran` (`stop`, `no`) and `synthetic.appended stop_hook` · the next step. At the bound: `hook.ran` ·
  `execution.succeeded` (or, with a queued message, `turn.ended`) with `hooks.unsatisfied`.
- **A slash command.** In one append `inbox.enqueued` (the expanded text, origin `null`) and `command.expanded`
  (that message, with the agent's record when the command names one) · if idle `execution.started` · where it is delivered, when the command names an agent, the
  switch (`agent.switched`, after its instruction message once a baseline is set, then `settings.changed` when
  the agent names another model) · `turn.ended` when it was queued behind a turn · `inbox.delivered` · the
  turn's steps. A command that cannot be used: nothing.
- **A wake-up's firing.** `inbox.enqueued` (the firing's key as the message ID, origin `wake` or `wake_webhook`,
  delivery `queue`, `untrusted` when it carries outside content) · `taint.noticed` when that is new · if idle and
  the delivery is `wake`, `execution.started` · `inbox.delivered` · the turn's steps. While a turn runs: the item
  waits, then `turn.ended` and `inbox.delivered` in one append. Delivered again: nothing.
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
approvals/<workspace hash>.json   approvals remembered for a project (30 days), keyed by its real path; also the
                                  approvals of the MCP servers, the hooks and the language servers the
                                  project's file names
wake/                             the wake-ups of every session: one SQLite file all processes share, the owners' locks
memory/                           notes (user/, projects/<name>-<hash>/) and the usage log; only with memory enabled
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
"resolve an ID or a unique prefix" are all this listing (the prefix needs only the file names). The cost of a listing is one `readdir` and two `stat` calls per session, plus one small read per session that
changed. That read brings the summary and, with it, the beginning of the user's first prompt (`firstPrompt`),
which the cache keeps under the same rules: a session nobody titled is named from the listing itself, and no
session's log is opened for a title.

**A page at a time.** `Engine.listSessionsPage({ ...query, limit, cursor })` gives at most `limit` sessions and
the cursor of the page after them. The cursor is a place in the listing's order (when the page's last session
was updated, then its ID, which makes the order total), so nothing is kept between two calls: each page is the
listing as it is now, from that place on. A session that arrives meanwhile is newer, sorts before the cursor,
and is in no later page; nothing is listed twice. A session that is worked in between two pages moves to the
front, where a new listing has it.

**Forks.** `Engine.forkSession(id, options)` forks a session at a step boundary (the latest one by default, or the
event `throughSeq` names, which is refused when it lies inside a step). What the fork inherits, as of that point:
the history (messages, the baseline, the compaction in force), the model settings (unless it is given its own), the
title, the taint (the content came with the history: the reducer copies the noticed taint, and the decisions derive it from the entries of the inherited results that the fork's `session.created` carries) and the root session's ID as its cache key, so its first request is its
parent's last request plus what is appended. What it does not inherit: the inbox, the claim, the snapshots, the
verification state, the undo history, and the approvals remembered for the session. An approval was given to one
line of work, and a fork is another that may go somewhere else (and may work in another directory); approvals
remembered for the project still apply.

*A point a fork inherited.* A fork's log begins with its parent's events through its fork point, under the same
numbers, so an event there is the parent's event. Forking a fork at such a point (`throughSeq` at or before the
fork's own fork point) forks the session the point belongs to, found by walking the lineage: the new session's
lineage names that session, it starts with that session's settings and title as of the point, and with `shared` it
works in that session's directory. A point in the fork's own part, and the default, fork the fork.

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
them. When a fork is created, what it needs of that history at run time is copied into it: its inherited messages,
baseline and compaction into its own rows, and the entries its taint is derived from into its `session.created`
(`inherited.taint`: the entries since the conversation was last declared trustworthy that can be a source under
some policy). Nothing the loop does reads the parent afterwards: the taint fold, the lookup of an admitted
input, a revert and `turnChanges` read the fork's own events (a revert to before an inherited message rewinds
the conversation and restores no file: the snapshots of that history are the parent's). So a fork whose parent
file is later missing still opens, runs and is listed; only reading its inherited events then fails in the store,
with `parent_missing`, which names the parent and the file. The engine turns that into words for whoever asked.
An open session's `readEvents` (what a client replays when it loads the session) returns the fork's own events,
from its `session.created`, and the session says once what is not shown and which file is missing, as a
`diagnostic` of kind `history`; said before the client subscribes, it is kept for it. `Engine.readEvents(id)`,
which has no session to say it through, throws `invalid_request` with the store's sentence when the range reaches
into the inherited part. Forking such a fork again is not possible, at any point: a fork is folded onto the whole
log up to its point, and `forkSession` refuses with `invalid_request`, `session <id> cannot be forked: the
history inherited from session <parent> cannot be read: <file> is missing`. A replay of it is refused the same
way. No `StoreError` about a fork's parent reaches a client as it is. Creating a fork of a session that cannot be
found fails with `session_not_found`. A process that dies while it forks leaves at most the copy of the workspace: the fork's session is created
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
