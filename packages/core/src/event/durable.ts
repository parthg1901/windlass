/**
 * The durable event schema: every fact a session can record, versioned.
 *
 * SINGLE-OWNER FILE. Other tracks ask the spine owner for a new event type
 * rather than adding one, because every event must be handled by the reducer
 * in `message/reducer.ts` and by the request builder.
 *
 * Rules every event follows:
 * - It records one irreducible fact. State that can be derived by folding the
 *   log (which message is running, what the latest compaction is) lives in the
 *   projection, not in events.
 * - Only boundaries are durable. Streaming deltas are ephemeral (`ephemeral.ts`);
 *   the durable event carries the complete value.
 * - Text that the model will see is frozen in the event at write time and is
 *   never rendered again (storage rule 4).
 * - Nothing is deleted. Revert, compaction and fork are ranges of `seq`.
 * - What the harness did to the workspace is recorded as snapshot IDs, never
 *   as file lists: the snapshot store answers "what changed" from two IDs.
 *
 * Nothing has been released and no stored session exists yet, so every event
 * is at version 1 and its shape was still changed in place. From the first
 * release on, changing an event's data shape means bumping its `v`, keeping a
 * decoder for the old version, and converting old to new in `decodeEvent`.
 * Adding a value to an enum or adding a new event type needs no version bump.
 */
import { agentRecord } from "../agents/use.ts"
import { grant } from "../approval/grants.ts"
import { approvalMode } from "../approval/policy.ts"
import { callRun, choiceId, storedEscalation, storedNeed, storedPathFact, storedQuestion, storedRunDecision, storedTaintSource } from "../approval/record.ts"
import { blobRef, content } from "../content.ts"
import { callId, executionId, messageId, sessionId, type SessionId } from "../id.ts"
import { interruptReason } from "../interrupt.ts"
import { providerError } from "../provider/error.ts"
import { usage } from "../provider/usage.ts"
import { toolEffect, toolSpec, truncation } from "../tool/tool.ts"
import { acknowledgement } from "../verify/acknowledge.ts"
import { verificationEvidence } from "../verify/evidence.ts"
import {
  type Infer,
  type Validator,
  array,
  integer,
  json,
  literal,
  boolean,
  nonEmptyString,
  nullable,
  object,
  oneOf,
  optional,
  string,
  variant,
} from "../validate.ts"

/**
 * How an inbox item reaches the model.
 * - `steer`: at the next step boundary, while the session is still working.
 * - `queue`: only once the session would otherwise go idle, one item at a time.
 */
export const delivery = oneOf(["steer", "queue"])
export type Delivery = Infer<typeof delivery>

/** What a replay does when the replayed model leaves the recording. */
export const replayPolicy = oneOf(["stop", "execute-read-only", "execute"])
export type ReplayPolicyKind = Infer<typeof replayPolicy>

/**
 * A git worktree a spawned session works in instead of its parent's
 * workspace: the directory, the branch that was created for it, and the
 * commit the branch started from (the parent's workspace as it was then).
 */
export const worktreeRecord = object({ path: nonEmptyString, branch: nonEmptyString, base: nonEmptyString, repository: nonEmptyString })
export type WorktreeRecord = Infer<typeof worktreeRecord>

/**
 * Where a session came from.
 * - `fork`: its history is its parent's. It owns no copy of it: its log is
 *   the parent's events 1..`throughSeq` followed by its own events, which
 *   start at `throughSeq + 1`. `copied` is set when the fork works in a
 *   directory of its own: the snapshot of the parent's workspace that was
 *   restored into its `cwd` (`null`: the directory was copied as it stood),
 *   and the parent's working directory.
 * - `spawn`: a subagent. It was started by a tool call of `parentSessionId`
 *   (the spawned work `spawnId` in the parent's log) with a fresh
 *   conversation: it inherits nothing of the parent's history. `depth` is 1
 *   for a child of a session a person started. `worktree` is the git
 *   worktree it works in, when it does not share the parent's workspace.
 * - `replay`: a replay of the recorded session `sourceSessionId` through its
 *   event `throughSeq`, against a baseline that differs from the recording's
 *   in what `changed` names (the system prompt text, the descriptions of the
 *   listed tools, the model settings). `policy` and `strict` are how it was
 *   run. Its history is its own; it starts at `seq` 1.
 */
export const lineage = variant("kind", {
  fork: object({
    kind: literal("fork"),
    parentSessionId: sessionId,
    throughSeq: integer(1),
    copied: optional(object({ snapshot: nullable(nonEmptyString), from: nonEmptyString })),
  }),
  spawn: object({ kind: literal("spawn"), parentSessionId: sessionId, spawnId: nonEmptyString, depth: integer(1), worktree: nullable(worktreeRecord) }),
  replay: object({
    kind: literal("replay"),
    sourceSessionId: sessionId,
    throughSeq: integer(1),
    policy: replayPolicy,
    strict: boolean,
    changed: object({ instructions: boolean, tools: array(nonEmptyString), settings: boolean }),
  }),
})
export type Lineage = Infer<typeof lineage>

/** The lineage of a session that inherits a parent's log, or `null`: only a fork reads events it does not own. */
export function forkOf(value: Lineage | null): Extract<Lineage, { kind: "fork" }> | null {
  return value?.kind === "fork" ? value : null
}

/**
 * The model settings a session's requests are sent with. They are part of the
 * provider's cached prefix (the request's `params` block), so they are stored
 * in the log: set when the session is created and changed only by
 * `settings.changed`, at a step boundary.
 * - `model`: the model every step of the session calls.
 * - `reasoningEffort`: provider-interpreted effort such as `"low"` or `"high"`; `null` is the model's default.
 */
export const sessionSettings = object({ model: nonEmptyString, reasoningEffort: nullable(nonEmptyString) })
export type SessionSettings = Infer<typeof sessionSettings>

export const finishReason = oneOf(["stop", "tool_calls", "length"])

/**
 * The one terminal result of a tool call (cancel rule 4).
 * - `success`: it ran and succeeded.
 * - `error`: it failed, or it was refused before running (malformed arguments,
 *   unknown tool, disallowed in this mode), or it was stopped and its outcome was observed.
 * - `not_started`: it never began, because the step was interrupted first. Safe to call again.
 * - `effect_unknown`: it began a side effect and nobody observed how it ended
 *   (crash, or a kill that returned nothing). The model must inspect before repeating it.
 */
export const toolOutcome = oneOf(["success", "error", "not_started", "effect_unknown"])
export type ToolOutcome = Infer<typeof toolOutcome>

/**
 * What the model was last given for one instruction source. `source` is the
 * source's stable key (`environment`, `date`, `agents:<path>`), and
 * `fingerprint` identifies the value it had (the instructions module uses the
 * SHA-256 of the value). Change detection compares fingerprints and never
 * reads rendered text back.
 */
export const instructionFingerprint = object({ source: nonEmptyString, fingerprint: nonEmptyString })
export type InstructionFingerprint = Infer<typeof instructionFingerprint>

/**
 * What an appended instruction message carries, for the sources whose text
 * is not the harness's or the user's own, recorded as fields beside the text
 * so that nothing has to be read back out of it:
 * - `mcp`: the catalogue. Its tool names and descriptions were written by
 *   the listed servers; `untrusted` is whether the server's content counts
 *   as content the harness does not control.
 * - `memory`: the notes the model holds once the message is in its history,
 *   each by its ID and the hash of the line it was shown as.
 * - `skills`: the skills the index lists, each with the file it comes from.
 * - `agents`: the agents the list of agents names (source `agent-index`), each
 *   with the file that defines it.
 */
export const instructionDetail = variant("kind", {
  mcp: object({ kind: literal("mcp"), servers: array(object({ name: nonEmptyString, tools: integer(0), untrusted: boolean })) }),
  memory: object({ kind: literal("memory"), notes: array(object({ id: nonEmptyString, hash: nonEmptyString })) }),
  skills: object({ kind: literal("skills"), skills: array(object({ name: nonEmptyString, path: nonEmptyString })) }),
  agents: object({ kind: literal("agents"), agents: array(object({ name: nonEmptyString, path: nonEmptyString })) }),
})
export type InstructionDetail = Infer<typeof instructionDetail>

/**
 * Why an admitted input is content the harness does not control: the firing
 * of a wake-up that carries a webhook's body, or the output of a check that
 * ran with the network or without the sandbox. The session counts as having
 * taken in untrusted content from the admission on (`approval/taint.ts`), so
 * the turn the input starts is decided under that from its first call.
 */
export const untrustedInput = object({ kind: literal("wake"), wakeId: nonEmptyString, carries: oneOf(["webhook_body", "check_output"]) })
export type UntrustedInput = Infer<typeof untrustedInput>

/** Why a step or a compaction did not complete. */
export const stepError = variant("kind", {
  /** The model call failed with a classified provider error. */
  provider: object({ kind: literal("provider"), error: providerError }),
  /** The execution was interrupted while this step was open. */
  interrupted: object({ kind: literal("interrupted"), reason: interruptReason }),
  /** The process died while this step was open; recorded by recovery at the next start. */
  crashed: object({ kind: literal("crashed") }),
  /** The harness itself failed (a bug, a storage error). */
  internal: object({ kind: literal("internal"), message: string }),
})
export type StepError = Infer<typeof stepError>

/** How hard a compaction cuts: see `compaction.started`. */
export const compactionMode = oneOf(["normal", "aggressive"])
export type CompactionMode = Infer<typeof compactionMode>

/**
 * A workspace snapshot: the hash of the git tree the snapshot module recorded
 * in its private repository. Equal IDs mean equal workspace contents.
 */
export const snapshotId = nonEmptyString

/**
 * The moment a snapshot was taken at. Every pair the harness brackets its own
 * work with is named, so a change that falls between two snapshots that are
 * not such a pair was made by someone else (the user, by hand).
 * - `delivery`: right before input is delivered. The state a revert to before that input restores.
 * - `step_start` / `step_end`: around the tools of one step. Taken only for a
 *   step with a call that can change files; `messageId` names the step.
 * - `checks_start` / `checks_end`: around one run of the configured checks.
 * - `restore_start` / `restore_end`: around a restore (a revert, or the undo of one).
 */
export const snapshotPoint = oneOf(["delivery", "step_start", "step_end", "checks_start", "checks_end", "restore_start", "restore_end"])
export type SnapshotPoint = Infer<typeof snapshotPoint>

/** A file a snapshot left out, so it can be neither diffed nor restored. `bytes` is its size when it was too large. */
export const skippedFile = object({ path: string, reason: oneOf(["too_large", "unreadable"]), bytes: nullable(integer(0)) })
export type SkippedFile = Infer<typeof skippedFile>

/** Why no snapshot can be taken. The first four are the snapshot module's; `snapshot_failed` is a snapshot that threw. */
export const snapshotUnavailableReason = oneOf(["git_not_found", "git_too_old", "workspace_invalid", "storage_failed", "snapshot_failed"])

/**
 * What a restore did to the workspace.
 * - `target`: the snapshot that was restored.
 * - `before`: the workspace just before the restore. Restoring it undoes the restore.
 * - `after`: the workspace just after it; equal to `target` unless something was kept. `null` when it could not be taken.
 * - `changed`: how many files the restore wrote or removed.
 * - `kept`: paths the restore left as they were, and why: ignored, in a nested
 *   repository or never captured (the snapshot module's reasons), or edited by
 *   hand since and kept on request. At most `KEPT_LIMIT` are listed; `keptOmitted` counts the rest.
 */
export const restoreRecord = object({
  target: snapshotId,
  before: snapshotId,
  after: nullable(snapshotId),
  changed: integer(0),
  kept: array(object({ path: string, reason: oneOf(["ignored", "nested_repository", "not_captured", "hand_edited"]) })),
  keptOmitted: integer(0),
})
export type RestoreRecord = Infer<typeof restoreRecord>
export const KEPT_LIMIT = 200

/**
 * What the verification gate found when an execution ended as done.
 * - `not_configured`: verification is off, or no check is configured. Nothing was verified.
 * - `not_needed`: checks are configured and none applied: nothing they cover
 *   changed since the last verification that passed.
 * - `passed`: every check that applied passed; `evidence` is that run.
 * - `unresolved`: checks still fail and the execution ended anyway. `reason`
 *   says why it was allowed to: the model reported with the acknowledgement
 *   tool that it cannot fix them (`acknowledgement` is what it said), the
 *   model had been sent back `maxRounds` times, or the mode is `report`, which
 *   never sends the model back.
 */
export const verificationOutcome = variant("status", {
  not_configured: object({ status: literal("not_configured") }),
  not_needed: object({ status: literal("not_needed") }),
  passed: object({ status: literal("passed"), evidence: verificationEvidence }),
  unresolved: object({
    status: literal("unresolved"),
    reason: oneOf(["acknowledged", "max_rounds", "report_mode"]),
    failing: array(nonEmptyString),
    acknowledgement: nullable(acknowledgement),
    evidence: verificationEvidence,
  }),
})
export type VerificationOutcome = Infer<typeof verificationOutcome>

/**
 * The `origin` of the messages the step loop appends with `synthetic.appended`.
 * Any other non-empty string is a valid origin too (a background command, a
 * wake-up); these are the ones the loop and the reducer agree on.
 */
export const HARNESS_ORIGIN = {
  /**
   * The marker that the previous response was cut short. It must directly
   * follow a step that ended `interrupted` or `crashed`, and it is the only
   * harness message accepted while an interrupt is being wound down.
   */
  interrupt: "interrupt",
  /**
   * After a model call failed with partial text already durable: the note
   * that asks the model to continue from where it stopped instead of starting
   * over. Appended between the failed message and the retry's new message.
   */
  continuation: "continuation",
  /** The response hit the output limit while a tool call was being written, so that call never ran. */
  outputLimit: "output_limit",
  /** The single nudge after an empty response. */
  emptyResponse: "empty_response",
  /** The step limit was reached; the next call is the last and runs without tools. */
  stepLimit: "step_limit",
  /**
   * The report of a run of checks that did not pass, as the model is shown
   * it. In `gate` mode the model is sent back to fix them. When the execution
   * ends unresolved in the same append (`report` mode, or the last allowed
   * round), it is the one harness message that may be left unanswered.
   */
  checkReport: "check_report",
  /** A background command of the session ended: how, and the end of its output. Delivered through the inbox. */
  backgroundCommand: "background_command",
  /** A subagent that ran in the background ended: its final answer, or how it failed. Delivered through the inbox. */
  subagentResult: "subagent_result",
  /** Spawned work that the harness could not keep (it restarted) or stopped itself (an interrupt). Delivered through the inbox. */
  spawnLost: "spawn_lost",
  /** A wake-up fired (a time came, a check passed or changed), or the notice that one stopped. Delivered through the inbox. */
  wake: "wake",
  /** A wake-up fired because a signed webhook request arrived; the message may carry the request's body. Delivered through the inbox. */
  wakeWebhook: "wake_webhook",
} as const

function define<const V extends number, D>(v: V, data: Validator<D>) {
  return { v, data }
}

const empty = object({})

/** Every durable event type: its current version and the validator for its data. */
export const durableEvents = {
  // ---- session lifecycle ----

  /**
   * A session exists. Always the first event of a session's own log. For a
   * fork, `lineage` names the parent and the last inherited `seq`, and this
   * event's `seq` is `throughSeq + 1`; a subagent and a replay start at 1. `settings` is the model and reasoning
   * effort the session starts with; a fork states its own, which may be the
   * parent's.
   */
  "session.created": define(
    1,
    object({ cwd: nonEmptyString, title: nullable(string), lineage: nullable(lineage), settings: sessionSettings }),
  ),
  /**
   * The session's model or reasoning effort changed, from here on. Accepted
   * only at a step boundary, with or without a running execution, and only if
   * something actually changes. The next request's `params` block differs
   * from the previous request's: a legitimate break of the cached prefix,
   * which `checkPrefix` is told about through this event.
   */
  "settings.changed": define(1, sessionSettings),
  /** The session's title was set. */
  "session.renamed": define(1, object({ title: string })),
  /**
   * The session was hidden from the default list. Nothing is deleted from its
   * log; the workspace snapshots no revert or undo of it could still restore
   * are dropped. Rejected for a session that is already archived.
   */
  "session.archived": define(1, empty),
  /** The session was restored to the default list. Rejected for a session that is not archived. */
  "session.unarchived": define(1, empty),

  // ---- frozen request prefix ----

  /**
   * The system prompt and tool list every request uses from here on, with
   * their text frozen (context rule 2). Recorded before the session's first
   * step and again only after a compaction, which is the one place the prefix
   * may change. `sources` lists the instruction sources folded into
   * `instructions`, each with the fingerprint of the value it had; a source
   * appears at most once.
   */
  "baseline.set": define(
    1,
    object({ instructions: string, tools: array(toolSpec), sources: array(instructionFingerprint) }),
  ),
  /**
   * An instruction that changed after the baseline (the date, an edited
   * AGENTS.md, a skill list) became part of history as a new message, with its
   * text frozen here (context rule 3). `source` names what it describes so a
   * later compaction can fold the newest text per source into the next
   * baseline. `fingerprint` identifies the value `text` gives the model for
   * that source; `null` means the message tells the model the source is gone.
   * `detail` is set for the sources that are never part of the baseline (the
   * MCP catalogue, the skill index, memory): what the text carries, as fields.
   */
  "instruction.appended": define(
    1,
    object({ messageId, source: nonEmptyString, text: string, fingerprint: nullable(nonEmptyString), detail: optional(instructionDetail) }),
  ),
  /**
   * The agent the session runs as changed: a role kept as a file, with
   * instructions, restrictions and sometimes a model (`agents/`). `to` is the
   * definition as it was when it was selected (its instructions, the
   * restrictions in force, its fingerprint), so the session never reads the
   * file again; `null` switches the agent off. `from` names the agent before.
   *
   * Written in two places. With `messageId: null`, before the session's
   * first baseline: the session starts as the agent, whose instructions are
   * then a section of that baseline (a subagent started as an agent, or
   * under a parent that runs as one, has it from its creation). Otherwise at
   * a step boundary, right after the `instruction.appended` message (source
   * `agent`) that gives the model the new instructions, and `messageId` is
   * that message: the baseline is frozen, so a switch is an appended message.
   * From this event on every call is checked against `to.restrictions`
   * before the approval layer decides it.
   */
  "agent.switched": define(1, object({ messageId: nullable(messageId), from: nullable(nonEmptyString), to: nullable(agentRecord) })),

  // ---- inbox ----

  /**
   * Input was admitted and is waiting to be delivered. `messageId` is the ID
   * the message will have once delivered. `origin` is `null` when the user
   * wrote it; otherwise it names the harness component that produced it
   * (a finished background command, a wake-up) and the item is synthetic.
   * `untrusted` is set when the content came from outside the harness (a
   * webhook's body, a networked check's output): a taint source, recorded
   * with the admission.
   */
  "inbox.enqueued": define(1, object({ messageId, origin: nullable(nonEmptyString), delivery, content, untrusted: optional(untrustedInput) })),
  /** A waiting item was switched between steer and queue. */
  "inbox.delivery_changed": define(1, object({ messageId, delivery })),
  /** A waiting item was withdrawn before delivery. It never becomes a message. */
  "inbox.cancelled": define(1, object({ messageId })),
  /**
   * A waiting item became a message in history, at a step boundary
   * (cancel rule 8). The item leaves the inbox in the same transaction. A
   * queued item that follows a turn is delivered right after that turn's
   * `turn.ended`.
   */
  "inbox.delivered": define(1, object({ messageId })),
  /**
   * The turn in progress has its answer and the verification gate let it
   * end, but a queued message waits, so the execution carries on with that
   * message instead of ending: the next event is its `inbox.delivered`.
   * `verification` is what `execution.succeeded` would have said, so a turn
   * says what "done" rests on whether or not something was queued behind it.
   * A queued message waits for this; a steer never does.
   */
  "turn.ended": define(1, object({ verification: verificationOutcome })),
  /**
   * The harness itself added a message to history at a step boundary, without
   * going through the inbox: the marker that the previous response was
   * interrupted (cancel rule 6), the single empty-response nudge, a check
   * result. `origin` names the kind; see `HARNESS_ORIGIN` for the ones the
   * step loop writes.
   */
  "synthetic.appended": define(1, object({ messageId, origin: nonEmptyString, content })),

  // ---- execution ----

  /**
   * The write-ahead claim: this process started working on the session. A
   * session with a claim and no terminal event after a restart was cut off by
   * a crash and is recovered.
   */
  "execution.started": define(1, object({ executionId })),
  /**
   * A new process took up a claimed execution again. When the claim was still
   * `running`, the previous process crashed, and the resume counts toward the
   * crash-resume cap (`crashResumes`); when it was `suspended` by a clean
   * shutdown, it does not.
   */
  "execution.resumed": define(1, object({ executionId })),
  /**
   * The session ran until it had nothing left to do: the inbox is empty and
   * the model has answered everything it was given. Releases the claim.
   * `verification` is what the gate found at that point, so "done" always
   * says what it rests on: passing checks, no checks, or failing checks that
   * were left unresolved and why.
   */
  "execution.succeeded": define(1, object({ executionId, verification: verificationOutcome })),
  /**
   * The execution gave up (a non-retryable error, attempts exhausted).
   * Releases the claim. `cause` is `approval` when it was ended because a call
   * needed the user's approval and nobody was there to give it (the
   * unattended behaviour `stop`), and `replay` when a replay session's
   * replay ended where the model had not answered (it left the recording, or
   * the recording itself ends there): not a failure of anything, but the
   * execution has no answer to end on. Absent for every other failure.
   */
  "execution.failed": define(1, object({ executionId, message: string, cause: optional(oneOf(["approval", "replay"])) })),
  /**
   * An interrupt was asked for: the user cancelled, or the process is shutting
   * down. Written the moment the abort fires, before any tool has stopped, so
   * a crash in the middle of stopping cannot turn a cancel back into work.
   * From here until `execution.interrupted` with the same `reason`, only
   * events that wind the execution down are accepted: flushing visible text,
   * settling calls, closing the open step or compaction as interrupted, and
   * the interrupt marker. Recovery that finds a requested interrupt finishes
   * it the same way and never resumes the work.
   */
  "execution.interrupt_requested": define(1, object({ executionId, reason: interruptReason })),
  /**
   * The execution was interrupted, as asked for by the
   * `execution.interrupt_requested` before it. `reason` is explicit and has no
   * default: `user` releases the claim, `shutdown` keeps it for the next start.
   */
  "execution.interrupted": define(1, object({ executionId, reason: interruptReason })),

  // ---- step: one model call ----

  /**
   * A model call began under assistant message `messageId`. `attempt` counts
   * within the step's single retry budget: a retry before any durable output
   * keeps the same message, while a retry after output starts a new message
   * with the next `attempt` (retry rule 2). `model` is the model that is
   * called, which is always the session's current `settings.model`; it is
   * repeated here so that a reader of the event stream needs no projection.
   */
  "step.started": define(1, object({ messageId, attempt: integer(1), model: nonEmptyString })),
  /** The model call completed. Every tool call of the step was settled before this. */
  "step.ended": define(1, object({ messageId, finish: finishReason, usage: nullable(usage) })),
  /**
   * The step ended without completing: provider failure, interruption, crash
   * or harness error. The single terminal event of the step; every tool call
   * was settled before it. Output recorded so far stays in history.
   */
  "step.failed": define(1, object({ messageId, error: stepError, usage: nullable(usage) })),
  /**
   * The provider refused. The step stays in the log, but every message from
   * `excludeFromSeq` up to this event is excluded from model history, so the
   * refused content cannot trip the filter again (retry rule 7). A compaction
   * in that range is excluded with it: its checkpoint may quote what was
   * refused, and history goes back to what it was before it. `message` is
   * the refusal text for display.
   */
  "step.refused": define(
    1,
    object({ messageId, message: string, excludeFromSeq: integer(1), usage: nullable(usage) }),
  ),
  /**
   * A retry of the model call was scheduled after `error`. `attempt` is the
   * number of the attempt that will run after `delayMs`.
   */
  "retry.scheduled": define(1, object({ messageId, attempt: integer(2), delayMs: integer(0), error: providerError })),

  // ---- model output ----

  /**
   * The model finished a piece of text; `text` is the whole piece. Also written
   * for the visible partial text of an interrupted step (cancel rule 3).
   */
  "text.ended": define(1, object({ messageId, text: string, providerData: nullable(json) })),
  /**
   * The model finished a reasoning item. `text` is the readable summary;
   * `providerData` is the provider's opaque payload, replayed verbatim. Partial
   * reasoning is never recorded.
   */
  "reasoning.ended": define(1, object({ messageId, text: string, providerData: nullable(json) })),

  // ---- tools ----

  /**
   * The model asked for a tool call. Written before anything runs; if this
   * write fails, nothing runs (cancel rule 1). `input` is the argument text
   * exactly as the model produced it. Keyed by `(messageId, callId)` because
   * providers reuse call IDs across steps.
   */
  "tool.called": define(
    1,
    object({ messageId, callId, name: nonEmptyString, input: string, providerData: nullable(json) }),
  ),
  /**
   * The tool began executing. From here a side effect may have happened, so a
   * call that is started but never settled is settled as `effect_unknown` (or
   * `error`), never as `not_started`. `effect` is the tool's effect class at
   * the moment it started: a `read` call has no side effect and can never
   * settle as `effect_unknown`, and crash recovery settles an orphan from this
   * field, never from the tool registry of the build that restarts.
   *
   * `run` is what the approval layer let the call run under: the mode, where
   * the tool comes from, the path facts the decision was made from, and for
   * a command whether it runs in the sandbox (`sandbox: null`: it does not)
   * and with which extra access. Taint is derived from these facts, never
   * from the disk again. Absent when the approval layer is off.
   */
  "tool.started": define(1, object({ messageId, callId, effect: toolEffect, run: optional(callRun) })),

  // ---- approval ----

  /**
   * The user is asked whether a call may run. Recorded with everything the
   * decision was made from and everything the question shows: the mode, the
   * path facts and the escalation the model asked for, the question with its
   * choices and what each remembers, what the question is about (`needs`),
   * and how the call runs if the answer approves (`then`). The call stays
   * `pending`. One question per call.
   */
  "approval.requested": define(
    1,
    object({
      messageId,
      callId,
      mode: approvalMode,
      paths: array(storedPathFact),
      escalation: nullable(storedEscalation),
      question: storedQuestion,
      needs: array(storedNeed),
      then: storedRunDecision,
    }),
  ),
  /**
   * The user's answer to the question of this call: the choice, a note if
   * they wrote one, and the approvals the choice created (`grants`, stamped
   * with this event's own `seq`). Session grants apply from here on; project
   * grants are also kept in the user's data directory, where later sessions
   * of the project read them. An approving answer is followed by
   * `tool.started`, a declining one by `tool.settled` with the refusal.
   */
  "approval.answered": define(1, object({ messageId, callId, choice: choiceId, approve: boolean, note: nullable(string), grants: array(grant) })),
  /**
   * The call was refused without anyone being asked: by the policy
   * (`policy`), or because it needed approval and nobody was present
   * (`unattended`; `needs` is what it needed). `agent` is set when the
   * policy that refused it is the restrictions of the agent the session runs
   * as, and names that agent: they are checked before the approval layer, so
   * `paths` is empty (nothing about the call was looked at) and `mode` is
   * the mode in force then. `stop`: the run ends with it.
   * The call's `tool.settled` follows in the same append, with the text the
   * model sees.
   */
  "approval.denied": define(
    1,
    object({
      messageId,
      callId,
      mode: approvalMode,
      paths: array(storedPathFact),
      escalation: nullable(storedEscalation),
      reason: oneOf(["policy", "unattended"]),
      needs: array(storedNeed),
      stop: boolean,
      agent: optional(nonEmptyString),
    }),
  ),
  /**
   * The session became tainted: content from a source the harness does not
   * control is in the conversation. `source` is the first such result and
   * `text` the sentence the user is shown, once. From here on anything that
   * can send data out asks again. Derived state is not stored: this records
   * that the user was told, and what.
   */
  "taint.noticed": define(1, object({ source: storedTaintSource, text: string })),
  /** The user said the conversation is trustworthy again. Taint is derived from the log after this event only. */
  "taint.cleared": define(1, empty),
  /**
   * The call's one terminal result. `output` is the text for the model, capped
   * once when produced and replayed byte for byte, including the text that
   * explains a `not_started` or `effect_unknown` outcome.
   */
  "tool.settled": define(
    1,
    object({
      messageId,
      callId,
      outcome: toolOutcome,
      output: string,
      truncation: nullable(truncation),
      attachments: array(blobRef),
      display: nullable(json),
    }),
  ),

  // ---- spawned work: subagents and background commands ----

  /**
   * Work that runs beside the session's own steps began: a subagent (a child
   * session) or a shell command started in the background. Written by the
   * tool call `(messageId, callId)` that started it, before the child
   * session exists and right after the command was spawned. `background`:
   * the call returned at once and the result arrives later as a message;
   * otherwise the call itself waits for it (subagents only). A follow-up
   * message to a child that has ended starts new work with a new `spawnId`
   * for the same child session. `agent` names the agent a new subagent runs
   * as, for display; the child's own log has the record.
   */
  "spawn.started": define(
    1,
    object({
      spawnId: nonEmptyString,
      messageId,
      callId,
      background: boolean,
      work: variant("kind", {
        command: object({ kind: literal("command"), command: string, logPath: nullable(string) }),
        subagent: object({ kind: literal("subagent"), sessionId, worktree: nullable(worktreeRecord), agent: optional(nonEmptyString) }),
      }),
    }),
  ),
  /**
   * Spawned work ended. `outcome`: `completed` (the command exited, with
   * `exitCode`; the child's execution succeeded), `failed` (the child's
   * execution failed, or the work could not be started), `stopped` (on
   * request: the stop tool, or an interrupt of this session, which stops
   * everything it spawned) or `lost` (the harness restarted while it ran).
   * `detail` is one sentence for a person. For a subagent, `usage` is what
   * its model calls cost during this piece of work (rolled up into this
   * session's totals), `tainted` whether its conversation holds untrusted
   * content (this session is tainted from here on, as by a tool result),
   * and `merge` what became of its worktree: merged into this workspace
   * (`files` changed), left on its branch because of `conflicts`, or
   * nothing to merge.
   */
  "spawn.ended": define(
    1,
    object({
      spawnId: nonEmptyString,
      outcome: oneOf(["completed", "failed", "stopped", "lost"]),
      detail: string,
      exitCode: nullable(integer()),
      usage: nullable(usage),
      tainted: boolean,
      merge: nullable(
        object({
          status: oneOf(["merged", "conflicts", "nothing", "failed"]),
          branch: nonEmptyString,
          commit: nullable(nonEmptyString),
          files: array(string),
          conflicts: array(string),
          kept: boolean,
        }),
      ),
    }),
  ),

  // ---- replay ----

  /**
   * In a replay session: what became of one call of the replayed model.
   * `matched`: it is a call of the recording (same tool, same arguments) and
   * got the recorded result; `normalised`: the same, equal only after the
   * replay's normalisers; `dropped`: made in a step the recording's user cut
   * short, beyond the calls the recording kept; `diverged`: the call that
   * left the recording (`divergence` is its kind); `off_tape`: made after
   * that. `executed`: the tool ran for real, in the replay's copy of the
   * workspace. `recorded` names the recorded step and call (0-based) of a
   * match. Written right before the call's `tool.settled`.
   */
  "replay.call": define(
    1,
    object({
      messageId,
      callId,
      result: oneOf(["matched", "normalised", "dropped", "diverged", "off_tape"]),
      executed: boolean,
      recorded: nullable(object({ step: integer(0), call: integer(0) })),
      divergence: nullable(nonEmptyString),
    }),
  ),
  /**
   * The replay left the recording and carries on in a copy of the workspace:
   * `workspace` is the directory, restored from `snapshot` of the recorded
   * session's working directory (`null`: none was recorded at that point and
   * the copy starts empty). From here the session's tools run for real, in
   * that directory.
   */
  "replay.diverged": define(1, object({ workspace: nonEmptyString, snapshot: nullable(nonEmptyString), divergence: nonEmptyString })),
  /**
   * The replay is over. `outcome`: `identical` (every recorded step was
   * replayed and matched), `diverged` (it left the recording), `unsupported`
   * (the recording does something a replay cannot reproduce) or `incomplete`
   * (it ended for another reason: a provider error, an interrupt, a crash).
   * `reason` is one line; `report` is the divergence report as JSON.
   */
  "replay.ended": define(1, object({ outcome: oneOf(["identical", "diverged", "unsupported", "incomplete"]), reason: string, report: json })),

  // ---- compaction ----

  /**
   * A compaction began under compaction message `messageId`, and everything
   * its summary request is built from is recorded here, so that request can
   * be rebuilt from the log like any other.
   * - `trigger`: `auto` (the size estimate of the next request crossed the
   *   policy's threshold), `overflow` (the provider rejected a request as too
   *   large) or `manual`.
   * - `mode`: how hard. `normal` aims for the policy's target; `aggressive`
   *   (after an overflow, or when a normal one freed too little) keeps a much
   *   shorter tail. The policy needs it the next time it decides.
   * - `keepFromSeq`: the cut. Model-visible messages from this `seq` on are
   *   kept word for word; what is visible before it is what the summary
   *   request shows the model. Equal to this event's own `seq` when nothing
   *   is kept. It may lie inside the turn in progress.
   * - `prompt`: the one prompt the summary request appends to the step
   *   request of the part before the cut, frozen.
   * - `tokensBefore`: the size (input tokens) the next request was estimated
   *   at when this was decided: what the compaction started from.
   */
  "compaction.started": define(
    1,
    object({
      messageId,
      trigger: oneOf(["auto", "manual", "overflow"]),
      mode: compactionMode,
      keepFromSeq: integer(1),
      prompt: string,
      tokensBefore: integer(0),
    }),
  ),
  /**
   * The model's answer to the summary request was not usable, and it is
   * asked once more: from ledger attempt `attempt` on, the summary request is
   * the first one plus `answer` (the rejected answer as it is replayed, cut
   * at the output bound) and `prompt` (what to fix), both frozen here. At
   * most one per compaction.
   */
  "compaction.repair_requested": define(1, object({ messageId, attempt: integer(2), answer: string, prompt: string })),
  /**
   * The compaction produced its checkpoint. From now on model history is
   * `summary` (the whole checkpoint text, rendered once and frozen here: the
   * summary, the identifier index, the user's messages verbatim) followed by
   * the messages from the `keepFromSeq` of `compaction.started` on. Earlier
   * messages stay in the log, in the UI and within reach of the history tools.
   * - `source`: where the summary part came from. `model`: the first answer;
   *   `repaired`: the answer to the repair request; `fallback`: no usable
   *   summary could be had, and the checkpoint was built without the model
   *   (index, verbatim user messages and a statement that there is no summary).
   * - `detail`: for a person, why it is a fallback, or what is still wrong
   *   with a summary that was used anyway; `null` when there is nothing to say.
   * - `tokensAfter`: the size the next request is estimated at with the
   *   checkpoint in place. `tokensBefore - tokensAfter` is what was freed.
   */
  "compaction.ended": define(
    1,
    object({
      messageId,
      summary: string,
      source: oneOf(["model", "repaired", "fallback"]),
      detail: nullable(string),
      tokensAfter: integer(0),
      usage: nullable(usage),
    }),
  ),
  /** The compaction did not complete. Model history is unchanged. */
  "compaction.failed": define(1, object({ messageId, error: stepError })),

  // ---- workspace snapshots ----

  /**
   * The workspace was recorded as snapshot `id` at this moment. `messageId`
   * names the open step for `step_start` and `step_end` and is `null`
   * otherwise. From these events alone: a step changed what differs between
   * its `step_start` and `step_end` (a step without them could not change
   * files; a step cut short has no `step_end`, and the next snapshot in the
   * log bounds it); a turn changed what differs between the `delivery`
   * snapshot before its input and the last snapshot of the turn; and the
   * snapshot current when a message was delivered is the `delivery` snapshot
   * right before its `inbox.delivered`.
   */
  "snapshot.taken": define(1, object({ id: snapshotId, point: snapshotPoint, messageId: nullable(messageId) })),
  /**
   * No snapshot can be taken from here on, so the session works without undo
   * until a later `snapshot.taken`. Written once per change, not per attempt.
   */
  "snapshot.unavailable": define(1, object({ reason: snapshotUnavailableReason, message: string })),
  /**
   * What snapshots leave out, from here on: files too large or unreadable
   * (they cannot be undone) and directories holding their own git repository
   * (nothing inside them is tracked). Written when the set changes, not with
   * every snapshot.
   */
  "snapshot.coverage": define(1, object({ skipped: array(skippedFile), nestedRepositories: array(string) })),

  // ---- verification ----

  /**
   * The harness began run `run` of the project's checks (1 for the first run
   * of a turn), because the session would otherwise go idle. Its `seq` is the
   * position in the log the checks ran at. Nothing else happens until the
   * run's terminal event, `checks.finished` or `checks.failed`.
   */
  "checks.started": define(1, object({ run: integer(1), checks: array(nonEmptyString) })),
  /** Every check of the run has a result. `evidence` is the record of them. */
  "checks.finished": define(1, object({ run: integer(1), evidence: verificationEvidence })),
  /**
   * The run did not produce results: the execution was interrupted, the
   * process died (recorded by recovery), or the harness failed. It says
   * nothing about the code, and the gate treats it as if the checks had not run.
   */
  "checks.failed": define(1, object({ run: integer(1), error: stepError })),

  // ---- history ranges and the workspace that goes with them ----

  /**
   * A revert to the state before `fromSeq` began, and its restore is about to
   * run: the write-ahead record of it. `target` is the snapshot the workspace
   * is restored to, `before` the workspace as it is now (the undo point), and
   * `keep` the paths edited by hand since `target` that the user chose to
   * keep. A session that is opened with a revert still open finishes it from
   * these fields. Accepted only while idle.
   */
  "revert.started": define(1, object({ fromSeq: integer(1), target: snapshotId, before: snapshotId, keep: array(string) })),
  /**
   * The user rewound the session: every message from `fromSeq` up to this
   * event is excluded from model history. The rows stay. A compaction in
   * that range is excluded like any message, and model history then starts
   * from the latest compaction that is not excluded: reverting to before a
   * compaction undoes it for the model. `restore` is what
   * happened to the workspace: `null` when no file was restored (no snapshot
   * was current at that point), otherwise the record of the restore that
   * `revert.started` announced.
   */
  "history.reverted": define(1, object({ fromSeq: integer(1), restore: nullable(restoreRecord) })),
  /**
   * The undo of the revert recorded at `revertSeq` began: the workspace is
   * about to be restored to `target`, the snapshot taken before that revert.
   * `before` is the workspace now. The write-ahead record, like `revert.started`.
   */
  "revert.undo_started": define(1, object({ revertSeq: integer(1), target: snapshotId, before: snapshotId, keep: array(string) })),
  /**
   * The revert recorded at `revertSeq` was undone: the messages it excluded
   * are part of model history again. `restore` is what happened to the
   * workspace, as in `history.reverted`.
   */
  "history.restored": define(1, object({ revertSeq: integer(1), restore: nullable(restoreRecord) })),
  /** The open revert, or undo of one, could not restore the workspace. Nothing changed in history. */
  "revert.failed": define(1, object({ message: string })),
} as const

export type EventType = keyof typeof durableEvents

export const EVENT_TYPES = Object.keys(durableEvents) as EventType[]

export type EventData<T extends EventType = EventType> = Infer<(typeof durableEvents)[T]["data"]>

/** An event as a caller hands it to the store: the fact, without its position in the log. */
export type NewEvent<T extends EventType = EventType> = {
  [K in T]: { readonly type: K; readonly v: (typeof durableEvents)[K]["v"]; readonly data: EventData<K> }
}[T]

/** Where an event sits in a session's log. Assigned by the store when it appends. */
export interface EventPosition {
  readonly sessionId: SessionId
  /** Dense per session, starting at 1 (or at `throughSeq + 1` for a fork). The only ordering key. */
  readonly seq: number
  /** Milliseconds since the Unix epoch, from the store's clock at append. For display, never for ordering. */
  readonly time: number
}

/** An event as it exists in the log. */
export type StoredEvent<T extends EventType = EventType> = NewEvent<T> & EventPosition

/** Builds an event at its current version. */
export function event<T extends EventType>(type: T, data: EventData<T>): NewEvent<T> {
  return { type, v: durableEvents[type].v, data } as NewEvent<T>
}
