/**
 * The step loop: takes a prompt, calls the model, runs tools, and handles
 * cancel, retries and crash recovery. `docs/step-loop-scenarios.md` is its
 * specification, and the reducer rejects every sequence it must not write.
 *
 * SINGLE-OWNER FILE. It owns the order of durable writes around a model call
 * and its tools.
 *
 * How it is built:
 *
 * - One step is one model call. Before every step the loop re-reads the
 *   projection and decides what to do from stored state alone (`state.ts`).
 *   Nothing about the conversation lives in memory, so a process that
 *   restarts decides what the one before it would have decided.
 * - Events that are decided together are appended together, in one
 *   transaction: a failed step with its retry and the note that asks the
 *   model to continue; an interrupted step with its marker and the release.
 *   A crash can therefore never fall between two halves of one decision.
 * - A side effect follows its durable record, never the other way round:
 *   `tool.called` is appended when the call finishes streaming, `tool.started`
 *   inside the runtime's `onStart`, synchronously, right before the tool runs.
 * - An interrupt is appended (`execution.interrupt_requested`) before
 *   anything is aborted. From then on the loop only winds down.
 * - Every await is followed by a check of the abort signal before anything
 *   that carries the work on is appended.
 * - The workspace is recorded as snapshot IDs around everything that can
 *   change it: before input is delivered, around the tools of a step that has
 *   a call with a side effect, around a run of checks, around a restore. A
 *   snapshot that cannot be taken never stops the work: the session carries
 *   on without undo and says so once (`snapshot.unavailable`).
 * - An execution ends as done only through the verification gate (`gate`):
 *   the harness runs the project's configured checks itself, and the events
 *   that record a run are appended together with what the gate decided from
 *   it (the report that sends the model back, or the terminal event).
 * - A revert announces its restore (`revert.started`) before it touches a
 *   file, so a session opened after a crash finishes it instead of guessing.
 * - Before every step the size of the request it would send is estimated
 *   from the request ledger (the provider's own count for the last call plus
 *   an estimate of what was appended since), and the compaction policy
 *   (`context/policy.ts`) says whether to compact first. A compaction can
 *   happen between any two steps, also in the middle of a turn. Everything
 *   its summary request is built from is durable before the request is sent
 *   (`compaction.started`), and it always completes: with the model's
 *   summary, with the one it wrote when asked to repair it, or with a
 *   checkpoint built without the model.
 */
import { statSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { type Decision, type RunDecision, type SandboxState, decide } from "../approval/decide.ts"
import { type Grant, stampGrants } from "../approval/grants.ts"
import type { ApprovalPolicy, ApprovalSection, ResolvedApproval } from "../approval/policy.ts"
import { type CallRun, type ChoiceId, TaintHistory } from "../approval/record.ts"
import { redact } from "../approval/redact.ts"
import { type TaintState, deriveTaint, describeTaint } from "../approval/taint.ts"
import { approvedNote, declinedMessage } from "../approval/texts.ts"
import { brand } from "../brand.ts"
import { type LoadedConfig, loadConfig } from "../config/load.ts"
import type { CheckConfig } from "../config/schema.ts"
import { text } from "../content.ts"
import { buildCheckpoint } from "../context/checkpoint.ts"
import { ITEM_OVERHEAD, REQUEST_OVERHEAD, type SizeEstimate, estimateNextInput, estimateTokens, estimateTool } from "../context/estimate.ts"
import { HISTORY_READ, HISTORY_SEARCH } from "../context/history-tools.ts"
import { type CompactionConfig, type CompactionDecision, DEFAULT_COMPACTION_CONFIG, decideAfterOverflow, decideCompaction, tailBudget } from "../context/policy.ts"
import { type ResolvedSummary, resolveSummary, summaryOutputCapChars, summaryPrompt, summaryRepairPrompt } from "../context/summary.ts"
import { chooseTail } from "../context/tail.ts"
import {
  type CompactionMode,
  type NewEvent,
  type RestoreRecord,
  type SessionSettings,
  type SnapshotPoint,
  type StoredEvent,
  type VerificationOutcome,
  HARNESS_ORIGIN,
  KEPT_LIMIT,
  event,
} from "../event/durable.ts"
import type { EphemeralEvent } from "../event/ephemeral.ts"
import { type CallId, type ExecutionId, type MessageId, type RequestId, type SessionId, newId } from "../id.ts"
import { type DiscoveryInput, discoverSources } from "../instructions/discover.ts"
import type { InstructionSource } from "../instructions/source.ts"
import { instructionState, knownAgentsFiles, prepareInstructions } from "../instructions/state.ts"
import { type Interrupt, type InterruptReason, createInterrupt, interruptReasonOf } from "../interrupt.ts"
import type { Json } from "../json.ts"
import { selectModelHistory } from "../message/history.ts"
import { type AssistantMessage, type Projection, type ToolCallPart, hasSideEffect } from "../message/message.ts"
import { type ProviderError, makeProviderError } from "../provider/error.ts"
import type { FinishReason, Provider, StreamEvent } from "../provider/provider.ts"
import type { Usage } from "../provider/usage.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import { type PrefixVerdict, checkPrefix } from "../request/build-break.ts"
import { CHECKPOINT_ORIGIN, type CallOptions, HARNESS_CLOSE, buildCompactionRequest, buildRequest, harnessOpen } from "../request/build.ts"
import { canonicalJson } from "../request/canonical.ts"
import { type BlockHash, hashRequest } from "../request/prefix.ts"
import type { ModelRequest } from "../request/request.ts"
import type { ChangeStatus } from "../snapshot/diff.ts"
import { type KeptPath, type SnapshotId, type SnapshotUnavailable, openSnapshots } from "../snapshot/index.ts"
import { StoreLockedError } from "../store/sqlite-lock.ts"
import { type AppendOptions, type RequestPurpose, type SessionQuery, type SessionStores, type SessionSummary, type Store, StoreError, sharedSessionStores } from "../store/store.ts"
import { resolvePath } from "../tools/common.ts"
import { type Authorization, type ToolCallOutcome, type ToolRuntime, createToolRuntime } from "../tool/runtime.ts"
import type { AnyTool, TempDirectory, ToolEffect } from "../tool/tool.ts"
import { ACKNOWLEDGE_TOOL_NAME, acknowledgeTool } from "../verify/acknowledge.ts"
import { type VerificationEvidence, buildEvidence } from "../verify/evidence.ts"
import { fingerprintCheck, reusablePass } from "../verify/fingerprint.ts"
import { type GateInput, decideGate } from "../verify/gate.ts"
import { renderReport } from "../verify/report.ts"
import { type CheckResult, type RunCheckOptions, runChecks } from "../verify/run.ts"
import { selectChecks } from "../verify/select.ts"
import { type ApprovalSetup, type Approvals, type FactContext, addProjectGrants, callFacts, effectivePolicy, finishOutput, readProjectGrants, realWorkspace, redactor, resolveApprovals, runRecord } from "./approval.ts"
import { type EngineEvent, EventChannel } from "./channel.ts"
import { type Clock, systemClock } from "./clock.ts"
import {
  COMPACTION_TEXT,
  ENGINE_LIMITS,
  type EngineLimits,
  FAILURE_TEXT,
  INCOMPLETE_STREAM,
  NOTE_TEXT,
  TOOL_TEXT,
  failureText,
  modelCallTimedOut,
  retryDelayMs,
} from "./constants.ts"
import { historyTools } from "./history.ts"
import { recover } from "./recovery.ts"
import {
  STOPPED,
  acknowledgementThisTurn,
  atInputBoundary,
  claimOf,
  compactionOutcome,
  completedStepSinceCompaction,
  latestSpoken,
  note,
  notedThisTurn,
  openStep,
  owesMarker,
  ranSideEffectsSince,
  refusedTurnStart,
  repeatsItself,
  reportsThisTurn,
  saysNothing,
  settleUnsettled,
  stepsThisTurn,
  turnInput,
  turnStartSeq,
  wouldGoIdle,
} from "./state.ts"
import {
  type OpenSnapshots,
  type OwnPaths,
  type WorkspaceSnapshots,
  coverageOf,
  firstDelivery,
  handEditedPaths,
  neededSnapshots,
  snapshotsAfter,
  snapshotsSinceDelivery,
} from "./workspace.ts"

// ---------------------------------------------------------------- options

/** Generators for the IDs the loop creates. Tests inject counters. */
export interface EngineIds {
  readonly session: () => SessionId
  readonly message: () => MessageId
  readonly execution: () => ExecutionId
  readonly request: () => RequestId
}

/**
 * Named moments in the loop at which an injected `probe` is called,
 * synchronously. A crash test kills the process inside one; a scenario test
 * acts on the session at exactly that moment. Production passes no probe.
 */
export type ProbePoint =
  /** The claim was taken or resumed; nothing else happened yet. */
  | "execution.claimed"
  /** Between steps, before the loop decides what to do next. */
  | "step.boundary"
  /** `step.started` is durable; the request has not been sent. */
  | "step.started"
  /** One piece of model output (`text.ended`, `reasoning.ended`, `tool.called`) is durable. */
  | "model.output"
  /** `approval.requested` is durable; nobody has answered. */
  | "approval.requested"
  /** `tool.started` is durable; the tool is about to run. */
  | "tool.started"
  /** A tool returned; its result is not yet written. */
  | "tool.finished"
  /** `tool.settled` is durable. */
  | "tool.settled"
  /** The step's terminal event is durable. */
  | "step.closed"
  /** `retry.scheduled` is durable; the wait has not begun. */
  | "retry.scheduled"
  /** `execution.interrupt_requested` is durable; nothing was stopped yet. */
  | "interrupt.requested"
  /** The loop found nothing left to do; the claim is not yet released. */
  | "execution.ending"
  /** `checks.started` is durable; no check has run. */
  | "checks.started"
  /** The checks returned; their results are not yet written. */
  | "checks.finished"
  /** `compaction.started` is durable; the summary request has not been sent. */
  | "compaction.started"
  /** `compaction.ended` is durable; the baseline has not been set again. */
  | "compaction.ended"
  /** `revert.started` (or `revert.undo_started`) is durable; no file was restored. */
  | "revert.started"
  /** The workspace is restored; the event that closes the revert is not yet written. */
  | "revert.restored"

export interface EngineHooks {
  readonly probe?: (point: ProbePoint, sessionId: SessionId) => void
}

/** Something the engine noticed that is not part of any session's log. Shown or logged, never stored. */
export interface Diagnostic {
  readonly kind: "prefix_violation" | "internal_error" | "tool_crashed" | "listener_failed"
  readonly sessionId: SessionId | null
  readonly message: string
  readonly cause?: unknown
}

/** A step request did not extend the previous one and no event explains it: a bug in the harness. */
export class PrefixViolationError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly verdict: Extract<PrefixVerdict, { status: "violation" }>,
  ) {
    const { index, kind, change } = verdict.comparison
    super(`session ${sessionId}: the next request does not extend the previous one (${kind} block ${index} ${change}) and no event allows that`)
    this.name = "PrefixViolationError"
  }
}

export class EngineError extends Error {
  constructor(
    /**
     * - `session_not_found`: there is no such session.
     * - `ambiguous_session`: an ID prefix names more than one session.
     * - `session_in_use`: another live process holds the session; `holderPid` names it when it could be told.
     * - `closed`: the engine or the session was closed.
     * - `unknown_model`: the provider does not offer the model.
     */
    readonly code: "session_not_found" | "ambiguous_session" | "session_in_use" | "closed" | "unknown_model",
    message: string,
    readonly holderPid: number | null = null,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

export interface EngineOptions {
  /**
   * Where sessions are stored. `SessionStores` gives every session a store of
   * its own, held while the session is open here (the session directory:
   * one file per session). A single `Store` holds every session, which is
   * what tests and tools use; it stays open when the engine closes.
   */
  readonly store: Store | SessionStores
  readonly provider: Provider
  /** Every tool of every session. Their specs are frozen into each session's baseline. */
  readonly tools: readonly AnyTool[]
  /** The harness data directory. Tool output that is too long for the model is written under it. */
  readonly dataDir: string
  /** Where capped tool output goes. Defaults to `<dataDir>/spill`. */
  readonly spillDir?: string
  /** Defaults to the system clock. */
  readonly clock?: Clock
  /** Defaults to random IDs (`newId`). */
  readonly ids?: Partial<EngineIds>
  /** The source of retry jitter, in [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number
  readonly limits?: Partial<EngineLimits>
  /** The base system prompt. Defaults to the harness's own. */
  readonly prompt?: string
  /**
   * Reads the instruction sources as they are now. Defaults to
   * `discoverSources` with the harness config directory (named from `brand`),
   * this platform and the engine's clock.
   */
  readonly discover?: (input: Pick<DiscoveryInput, "cwd" | "known" | "directories">) => InstructionSource[]
  /** Call settings that are the same for every request of this build. */
  readonly call?: CallOptions
  /**
   * Called once when a model call is rejected for its credentials, before the
   * step fails: refresh the sign-in and resolve `true` if the call is worth
   * sending again.
   */
  readonly refreshAuth?: () => Promise<boolean>
  readonly hooks?: EngineHooks
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void
  /** One line per diagnostic. Defaults to standard error. */
  readonly log?: (line: string) => void
  /**
   * Throw `PrefixViolationError` when a request breaks the cached prefix with
   * no event that allows it. Tests set this; a user's session reports the
   * violation and carries on.
   */
  readonly strict?: boolean
  /**
   * Opens the snapshots of a session's working directory. Defaults to the
   * snapshot module with its private git directories under
   * `<dataDir>/snapshots`. `null` switches snapshots off: nothing is recorded
   * about the workspace and a revert rewinds the conversation only.
   */
  readonly snapshots?: OpenSnapshots | null
  /**
   * Loads the configuration that applies in a working directory: the checks,
   * the verification mode, and the directory checks run in. Called when an
   * execution starts, so a change takes effect at the next turn. Defaults to
   * `loadConfig` (the user and project files). `null` means no configuration:
   * nothing is verified.
   */
  readonly loadConfig?: ((cwd: string) => Promise<SessionConfig>) | null
  /**
   * The approval layer: what decides, before every tool call, whether it
   * runs, runs in the sandbox, asks the user or is refused, and what redacts
   * tool output. Defaults to the safe setup for a user's machine: mode
   * `auto`, the sandbox this machine has, nobody present until a client says
   * so. `null` switches the layer off: every call runs as it is and nothing
   * about approval is recorded. That is for tests of the loop's other rules.
   */
  readonly approval?: ApprovalSetup | null
  /** Runs checks. Defaults to the verification module's runner, which uses the shell tool. */
  readonly runChecks?: (checks: readonly CheckConfig[], options: RunCheckOptions) => Promise<CheckResult[]>
  /**
   * The models the provider offers, for `validateSettings`. Without it, or
   * when the listing fails, a model is not checked before the first call.
   */
  readonly listModels?: () => Promise<readonly string[]>
  /**
   * The context window of a model, in input tokens, or `null` when nobody
   * knows. Asked once per model. The compaction policy measures the next
   * request against it before every step. Without it, or when it is `null`
   * or cannot be had, nothing is compacted ahead of time: only a request the
   * provider rejects as too large is.
   */
  readonly contextWindow?: (model: string) => number | null | Promise<number | null>
  /** The compaction policy's numbers, where they differ from `DEFAULT_COMPACTION_CONFIG`. */
  readonly compaction?: Partial<CompactionConfig>
}

/** The configuration an execution runs under: the checks and where they run, and the files' approval sections. */
export type SessionConfig = Pick<LoadedConfig, "config" | "projectDir"> & Partial<Pick<LoadedConfig, "approval">>

/** How a session's tool calls are decided right now, for a client to show. */
export interface ApprovalState {
  /** The policy in force: the user's settings, tightened by the project's. */
  readonly policy: ApprovalPolicy
  /** Project settings that would have loosened the user's policy and were not followed. */
  readonly ignored: readonly string[]
  readonly sandbox: CommandSandbox["state"]
  /** Whether someone is there to answer a question (`setAttended`). */
  readonly attended: boolean
  /** The session's taint, derived from its log. */
  readonly taint: TaintState
  /** The question that waits for an answer, if one does. */
  readonly pending: { readonly messageId: MessageId; readonly callId: CallId; readonly question: Extract<Decision, { kind: "ask" }>["question"] } | null
}

/** What to do with files that were edited by hand after the point a restore goes back to. */
export type HandEditPolicy =
  /** Change nothing and report them (`hand_edited`). The default. */
  | "abort"
  /** Restore them too. Nothing is lost: the snapshot taken before the restore keeps them, and undoing the revert brings them back. */
  | "overwrite"
  /** Leave them as they are and restore everything else. */
  | "keep"

export interface RevertOptions {
  /** The user message to go back to: the session returns to the state before it. Defaults to the latest one (the last turn). */
  readonly messageId?: MessageId
  /** Report what would happen and change nothing. */
  readonly dryRun?: boolean
  readonly handEdits?: HandEditPolicy
}

/** What a revert, or the undo of one, does or would do. */
export interface RevertPlan {
  /** The range of history that leaves (or, for an undo, re-enters) the model's view starts here. */
  readonly fromSeq: number
  /** The user message the session goes back to before; `null` for an undo. */
  readonly messageId: MessageId | null
  /** How many messages leave or re-enter the model's view. */
  readonly messages: number
  /** The snapshot the workspace is restored to, or `null` when no file is restored. */
  readonly target: string | null
  /** Why no file is restored, when `target` is `null`. */
  readonly unrestorable: string | null
  /** Every file the restore writes or removes, and whether it was edited by hand after `target` was taken. */
  readonly changes: readonly { readonly path: string; readonly status: ChangeStatus; readonly handEdited: boolean }[]
  /** Paths the restore leaves alone whatever happens: ignored files, nested repositories, files no snapshot captured. */
  readonly kept: readonly KeptPath[]
}

export type RevertResult =
  /**
   * Nothing was looked at. `busy`: an execution or another revert is in
   * progress (a revert happens only while idle). `compacted` is no longer
   * given: a revert may go back before a compaction, which it then undoes.
   */
  | { readonly kind: "refused"; readonly reason: "busy" | "nothing_to_revert" | "not_found" | "compacted"; readonly message: string }
  /** The answer to a dry run. */
  | { readonly kind: "preview"; readonly plan: RevertPlan }
  /** Files edited by hand would be overwritten and no policy was given. Nothing changed. */
  | { readonly kind: "hand_edited"; readonly plan: RevertPlan }
  /** Done. `restore` is the record written to the log; `null` when the conversation was rewound and no file restored. */
  | { readonly kind: "reverted"; readonly plan: RevertPlan; readonly restore: RestoreRecord | null }
  /** The workspace could not be restored. History is unchanged. */
  | { readonly kind: "failed"; readonly plan: RevertPlan | null; readonly message: string }

/** What happens to a held claim when its session is opened. Recovery of a crashed claim always runs. */
export type ResumeMode =
  /** Resume the claim and start working at once. The default. */
  | "start"
  /** Resume the claim (`execution.resumed`) but do no work until `start()` or `send()`. */
  | "claim"
  /** Leave a suspended claim suspended until `start()` or `send()`. */
  | "wait"

export interface SendOptions {
  /** `steer` (the default) is delivered at the next step boundary; `queue` once the session would otherwise go idle. */
  readonly delivery?: "steer" | "queue"
  /** The step limit of the turn this input starts, instead of the engine's. */
  readonly maxSteps?: number
}

export interface EngineSession {
  readonly id: SessionId
  /**
   * Every event of this session from the moment it was created or opened, in
   * order: durable events as they are appended (recovery's first), ephemeral
   * deltas as they arrive. One consumer. It ends after `close`. A consumer
   * that falls behind never slows the loop down; see `channel.ts`.
   */
  readonly events: AsyncIterable<EngineEvent>
  /** A further consumer, called synchronously with each event from now on. Returns the unsubscribe function. */
  readonly subscribe: (listener: (event: EngineEvent) => void) => () => void
  /**
   * Admits a prompt into the inbox. If nothing is running an execution
   * starts (or a suspended one resumes); otherwise the prompt is delivered
   * at the next step boundary. Returns the ID the message will have.
   */
  readonly send: (value: string, options?: SendOptions) => MessageId
  /** `send` with `delivery: "queue"`: delivered only once the turn in progress has its answer. */
  readonly queue: (value: string, options?: Omit<SendOptions, "delivery">) => MessageId
  /**
   * Starts working if there is something to do and nothing is running: takes
   * the claim when input waits, or takes up a claim that is suspended or was
   * recovered without being started.
   */
  readonly start: () => void
  /** Asks the running execution to stop, as the user. The request is durable before anything stops. A no-op when idle. */
  readonly interrupt: () => void
  /** Changes the model or the reasoning effort. Takes effect at the next step boundary. */
  readonly setSettings: (settings: SessionSettings) => void
  /**
   * Withdraws a prompt that was admitted and not delivered yet
   * (`inbox.cancelled`): it never reaches the model. Returns whether it was
   * still waiting; a prompt already delivered, or unknown, is left alone.
   */
  readonly withdraw: (messageId: MessageId) => boolean
  /** The session's stored state. */
  readonly projection: () => Projection
  /** The session's stored events in `seq` order: its whole log, or the part after `afterSeq`. What a client replays to show history. */
  readonly readEvents: (range?: { readonly afterSeq?: number; readonly limit?: number }) => readonly StoredEvent[]
  /**
   * Returns the session to the state before a user message (by default the
   * latest one): the workspace is restored from the snapshot that was current
   * when that message was delivered, and the message and everything after it
   * leave the model's history. Only while idle. Files edited by hand since
   * are never overwritten silently (see `HandEditPolicy`), and the revert
   * can be undone with `undoRevert` until new work starts.
   */
  readonly revert: (options?: RevertOptions) => Promise<RevertResult>
  /** Undoes the latest revert: the workspace as it was right before it, and its messages back in history. Only while idle. */
  readonly undoRevert: (options?: Omit<RevertOptions, "messageId">) => Promise<RevertResult>
  /**
   * Says whether a person is there to answer questions. Nobody is until a
   * client says so: a call that would ask is then refused (or ends the run,
   * as the policy's `unattended` says) and nothing ever waits.
   */
  readonly setAttended: (present: boolean) => void
  /**
   * The user's own approval settings for this session, as a command-line
   * flag or a client's control gives them. They go on top of the user's
   * file; the project's file can still only tighten the result. Applies from
   * the next decision. Not stored: a client says it again when it opens the session.
   */
  readonly setApproval: (section: ApprovalSection) => void
  /** How calls are decided right now; `null` when the approval layer is off. */
  readonly approval: () => ApprovalState | null
  /**
   * Answers the pending question about a call with one of its choices, and
   * a note if the user wrote one. Returns whether it was taken: `false` when
   * that question is not pending (it was answered, or an interrupt withdrew
   * it) or offers no such choice.
   */
  readonly answer: (target: { readonly messageId: MessageId; readonly callId: CallId }, reply: { readonly choice: ChoiceId; readonly note?: string | null }) => boolean
  /** The user says the conversation is trustworthy again (`taint.cleared`). Returns whether the session was tainted. */
  readonly clearTaint: () => boolean
  /** Whether an execution is being worked on in this process. */
  readonly working: boolean
  /** Resolves once no execution and no revert is being worked on in this process. */
  readonly settled: () => Promise<void>
  /**
   * A graceful shutdown of this session, and of nothing else: work in
   * progress is stopped as a `shutdown`, which leaves the execution suspended
   * and resumable, `events` ends, and the session is let go of, so that this
   * or another process can open it again. The engine and its other sessions
   * carry on. Safe to call more than once.
   */
  readonly close: () => Promise<void>
}

export interface Engine {
  /** Creates a session. Its baseline is frozen when its first execution starts. */
  readonly createSession: (input: { readonly cwd: string; readonly settings: SessionSettings; readonly title?: string | null }) => EngineSession
  /**
   * Opens an existing session. If it holds a claim from a process that died
   * or shut down, it is recovered here, and what happens next is `resume`.
   */
  readonly openSession: (id: SessionId, options?: { readonly resume?: ResumeMode }) => EngineSession
  /** The most recently updated session whose working directory is `cwd`. */
  readonly latestSession: (cwd: string) => SessionSummary | null
  /**
   * Sessions, most recently updated first, whoever has them open: by working
   * directory when `cwd` is given, without archived ones unless asked.
   * Reading only; nothing is opened, held or closed.
   */
  readonly listSessions: (query?: SessionQuery) => readonly SessionSummary[]
  /** One session's summary, or `null`. Works for a session another process holds. */
  readonly getSession: (id: SessionId) => SessionSummary | null
  /** The session an ID or a unique prefix of one names. Throws `session_not_found` or `ambiguous_session`. */
  readonly resolveSession: (idOrPrefix: string) => SessionId
  /**
   * A session's stored events in `seq` order, without opening it: the log a
   * client replays to show a session it loads. Works for a session another
   * process is working in (it shows what is committed).
   */
  readonly readEvents: (id: SessionId, range?: { readonly afterSeq?: number; readonly limit?: number }) => readonly StoredEvent[]
  /**
   * Hides a session from the default listing (`session.archived`). A session
   * open in this engine is closed first, as `EngineSession.close` does. The
   * workspace snapshots that no revert or undo of it could still restore are
   * dropped. Archiving an archived session does nothing. Rejects with
   * `session_in_use` when another process holds the session.
   */
  readonly archiveSession: (id: SessionId) => Promise<void>
  /** Puts an archived session back in the default listing (`session.unarchived`). Does nothing for one that is not archived. */
  readonly unarchiveSession: (id: SessionId) => Promise<void>
  /**
   * Checks settings before a session is created with them or switched to
   * them: rejects with `EngineError` `unknown_model`, naming the models the
   * provider offers, when `settings.model` is not one of them. Resolves when
   * the model is offered, and also when the engine has no listing or the
   * listing cannot be fetched: then the first model call says what is wrong.
   */
  readonly validateSettings: (settings: SessionSettings) => Promise<void>
  /**
   * The hook a process calls before it exits, for whatever reason it controls
   * (a normal end, SIGINT, SIGTERM, an uncaught error): every session is
   * closed as a shutdown, which stops every tool and waits for it. Safe to
   * call more than once; every call resolves when the shutdown is complete.
   * Each session's own store is closed with it; a single `Store` passed as
   * `store`, or the `SessionStores` themselves, stay open: they belong to
   * whoever opened them.
   */
  readonly close: () => Promise<void>
}

// ---------------------------------------------------------------- engine

interface Core {
  readonly stores: SessionStores
  readonly provider: Provider
  readonly runtime: ToolRuntime
  readonly effects: ReadonlyMap<string, ToolEffect>
  /** By tool name: the paths a call says it touches (`Tool.touches`). */
  readonly touches: ReadonlyMap<string, (input: unknown) => readonly string[]>
  readonly tools: readonly AnyTool[]
  /** The tool the model reports an unfixable check failure with. In the runtime always; in a session's tool list when verification was on at its baseline. */
  readonly acknowledge: AnyTool
  /** `history_search` and `history_read`: in the runtime and in every session's tool list. */
  readonly history: readonly AnyTool[]
  /** The context window of each model asked about so far; `null` when it is not known. */
  readonly windows: Map<string, number | null>
  readonly contextWindow: ((model: string) => number | null | Promise<number | null>) | undefined
  readonly compaction: CompactionConfig
  readonly spillDir: string
  readonly openSnapshots: OpenSnapshots | null
  readonly loadConfig: ((cwd: string) => Promise<SessionConfig>) | null
  /** The approval layer with its defaults applied; `null` when it is off. */
  readonly approvals: Approvals | null
  readonly runChecks: (checks: readonly CheckConfig[], options: RunCheckOptions) => Promise<CheckResult[]>
  readonly clock: Clock
  readonly ids: EngineIds
  readonly random: () => number
  readonly limits: EngineLimits
  readonly prompt: string | undefined
  readonly discover: (input: Pick<DiscoveryInput, "cwd" | "known" | "directories">) => InstructionSource[]
  readonly call: CallOptions
  readonly refreshAuth: (() => Promise<boolean>) | undefined
  readonly probe: ((point: ProbePoint, sessionId: SessionId) => void) | undefined
  readonly strict: boolean
  readonly report: (diagnostic: Diagnostic) => void
  readonly sessions: Map<SessionId, LiveSession>
}

export function createEngine(options: EngineOptions): Engine {
  const clock = options.clock ?? systemClock
  const log = options.log ?? ((line: string) => console.error(line))
  const spillDir = options.spillDir ?? join(options.dataDir, "spill")
  // A build that brings its own tool of that name keeps it.
  const acknowledge = options.tools.find((tool) => tool.name === ACKNOWLEDGE_TOOL_NAME) ?? (acknowledgeTool() as unknown as AnyTool)
  const stores = "append" in options.store ? sharedSessionStores(options.store) : options.store
  // The history tools read the store of the session that calls them. A build that brings its own tool of one of those names keeps it.
  const history = historyTools((sessionId) => core.sessions.get(sessionId)?.history ?? null).filter((tool) => !options.tools.some((other) => other.name === tool.name))
  const runnable = [...options.tools.filter((tool) => tool !== acknowledge), ...history, acknowledge]
  const core: Core = {
    stores,
    provider: options.provider,
    runtime: createToolRuntime({ tools: runnable, spillDir, putBlob: stores.putBlob }),
    effects: new Map(runnable.map((tool) => [tool.name, tool.effect])),
    touches: new Map(runnable.flatMap((tool) => (tool.touches === undefined ? [] : [[tool.name, tool.touches as (input: unknown) => readonly string[]] as const]))),
    tools: options.tools.filter((tool) => tool !== acknowledge),
    acknowledge,
    history,
    windows: new Map(),
    contextWindow: options.contextWindow,
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...options.compaction },
    spillDir,
    openSnapshots: options.snapshots === undefined ? (cwd) => openSnapshots(cwd, { dataDir: join(options.dataDir, "snapshots") }) : options.snapshots,
    loadConfig: options.loadConfig === undefined ? (cwd) => loadConfig({ cwd }) : options.loadConfig,
    approvals: options.approval === null ? null : resolveApprovals(options.approval ?? {}, options.dataDir, spillDir),
    runChecks: options.runChecks ?? runChecks,
    clock,
    ids: {
      session: options.ids?.session ?? (() => newId("session")),
      message: options.ids?.message ?? (() => newId("message")),
      execution: options.ids?.execution ?? (() => newId("execution")),
      request: options.ids?.request ?? (() => newId("request")),
    },
    random: options.random ?? Math.random,
    limits: { ...ENGINE_LIMITS, ...options.limits },
    prompt: options.prompt,
    discover:
      options.discover ??
      ((input) => discoverSources({ ...input, configDir: configDirectory(), platform: process.platform, now: () => new Date(clock.now()) })),
    call: options.call ?? {},
    refreshAuth: options.refreshAuth,
    probe: options.hooks?.probe,
    strict: options.strict ?? false,
    report: (diagnostic) => {
      options.onDiagnostic?.(diagnostic)
      // Said once: to the clients of the session, as an event of its stream, or, when no open session can carry
      // it, as a line of the log.
      const live = diagnostic.sessionId === null ? undefined : core.sessions.get(diagnostic.sessionId)
      if (live !== undefined && live.diagnosed(diagnostic)) return
      log(`[engine] ${diagnostic.kind}${diagnostic.sessionId === null ? "" : ` in ${diagnostic.sessionId}`}: ${diagnostic.message}`)
    },
    sessions: new Map(),
  }
  let closing: Promise<void> | null = null
  const assertOpen = () => {
    if (closing !== null) throw new EngineError("closed", "the engine is closed")
  }
  /** Sets or clears the archived flag through the session's own log, holding the session only for that append. */
  const setArchived = async (id: SessionId, archived: boolean): Promise<void> => {
    assertOpen()
    // A session open here is let go of first: its work stops as a shutdown and stays resumable.
    await core.sessions.get(id)?.close()
    const store = storeErrors(() => core.stores.open(id))
    try {
      const summary = store.getSession(id)
      if (summary === null) throw new EngineError("session_not_found", `session ${id} does not exist`)
      if (summary.session.archived === archived) return
      store.append(id, [event(archived ? "session.archived" : "session.unarchived", {})])
      if (archived) await retainSnapshots(core, store, id, "archived").catch(() => {})
    } finally {
      store.close()
    }
  }

  return {
    createSession: (input) => {
      assertOpen()
      const id = core.ids.session()
      const store = storeErrors(() => core.stores.create(id))
      const session = new LiveSession(core, id, store)
      try {
        session.write([event("session.created", { cwd: input.cwd, title: input.title ?? null, lineage: null, settings: input.settings })])
      } catch (error) {
        store.close()
        throw error
      }
      core.sessions.set(id, session)
      return session
    },
    openSession: (id, open = {}) => {
      assertOpen()
      const live = core.sessions.get(id)
      if (live !== undefined) return live
      const store = storeErrors(() => core.stores.open(id))
      const session = new LiveSession(core, id, store)
      core.sessions.set(id, session)
      try {
        session.recover(open.resume ?? "start")
      } catch (error) {
        core.sessions.delete(id)
        store.close()
        throw error
      }
      return session
    },
    latestSession: (cwd) => core.stores.list({ cwd, limit: 1 })[0] ?? null,
    listSessions: (query) => core.stores.list(query),
    getSession: (id) => core.stores.get(id),
    resolveSession: (idOrPrefix) => storeErrors(() => core.stores.resolve(idOrPrefix)),
    readEvents: (id, range) => storeErrors(() => core.stores.read(id, (store) => store.readEvents(id, range))),
    archiveSession: (id) => setArchived(id, true),
    unarchiveSession: (id) => setArchived(id, false),
    validateSettings: async (settings) => {
      if (options.listModels === undefined) return
      const models = await options.listModels().catch(() => null)
      if (models === null || models.length === 0 || models.includes(settings.model)) return
      throw new EngineError("unknown_model", `model ${settings.model} is not available; choose one of: ${models.join(", ")}`)
    },
    close: () => {
      closing ??= Promise.all([...core.sessions.values()].map((session) => session.close())).then(() => {})
      return closing
    },
  }
}

// ---------------------------------------------------------------- one session

/** One execution being worked on in this process: its claim and its abort token (cancel rule 2). */
interface Run {
  readonly executionId: ExecutionId
  readonly interrupt: Interrupt
  done: Promise<void>
}

type ModelEnd =
  | { readonly type: "finish"; readonly reason: FinishReason }
  | { readonly type: "error"; readonly error: ProviderError }
  /** The call was interrupted. The stream stopped without a terminal event. */
  | { readonly type: "aborted" }

interface ModelCall {
  readonly end: ModelEnd
  readonly usage: Usage | null
  /** Text of an item that was still streaming when the call ended. Kept when the call did not finish (cancel rule 3). */
  readonly partialText: string
  /** Whether a tool call's arguments were still streaming when the call ended. Such a call is never recorded or run. */
  readonly cutOff: boolean
  /** The text of the response, for a compaction call, which records no output events. */
  readonly text: string
  /** The loop stopped reading because the output passed the bound it was given (a summary that does not end). */
  readonly overran: boolean
}

/** A request as the loop is about to send it, with the state it was built from. */
interface Prepared {
  readonly projection: Projection
  readonly request: ModelRequest
  readonly blocks: readonly BlockHash[]
}

/** What a compaction is asked to do: the policy's decision, as far as the loop acts on it. */
interface CompactionPlan {
  readonly trigger: "auto" | "overflow"
  readonly mode: CompactionMode
  /** Tokens of history to keep word for word (`chooseTail`). */
  readonly tailBudget: number
  /** The size estimate of the request that set it off. */
  readonly tokensBefore: number
  /**
   * For a normal compaction that turns out to have almost nothing to take
   * out, because what must be kept is most of the context: whether the
   * request still fits the window (then nothing is done), and the budget of
   * the aggressive compaction that is made instead when it does not.
   */
  readonly otherwise?: { readonly fits: boolean; readonly aggressiveBudget: number }
}

type StepResult =
  /** The step is closed; the loop decides what comes next. */
  | "continue"
  /** The execution's terminal event was written. */
  | "done"

/** What the gate found: as a step, or the turn may end with `verification` and a queued message is waiting to be delivered. */
type GateResult = StepResult | { readonly verification: VerificationOutcome }

const isSteer = (item: { readonly delivery: "steer" | "queue" }) => item.delivery === "steer"

/** What the approval layer decided for one call of the step in progress, kept until its result is recorded. */
interface Decided {
  /** What `tool.started` records, for a call that runs. */
  readonly run: CallRun | undefined
  /** Appended together with the call's result: the record of a denial. */
  readonly before: readonly NewEvent[]
  /** The denial's text, when it ends the run (the unattended behaviour `stop`). */
  readonly stop: string | null
}

/** The question that waits for the user's answer. */
interface PendingQuestion {
  readonly messageId: MessageId
  readonly callId: CallId
  readonly asked: Extract<Decision, { kind: "ask" }>
  readonly resolve: (answer: { readonly approve: boolean; readonly note: string | null } | null) => void
}

const callKey = (messageId: MessageId, callId: CallId) => `${messageId}/${callId}`

/** What `authorize` resolves with when an interrupt ended its wait: the runtime sees the abort and reports the call as not started. */
const WITHDRAWN: Authorization = { kind: "refuse", output: "" }

/** A restore that `restoreTo` is asked for: a revert to before a message, or the undo of the latest revert. */
type RestoreRequest =
  | { readonly kind: "revert"; readonly fromSeq: number; readonly messageId: MessageId; readonly messages: number }
  | { readonly kind: "undo"; readonly revertSeq: number; readonly fromSeq: number; readonly messages: number }

class LiveSession implements EngineSession {
  private readonly channel = new EventChannel()
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly outbox: EngineEvent[] = []
  private publishing = false
  private run: Run | null = null
  /** A settings change asked for while a step was open. It is not history yet, only a request. */
  private pendingSettings: SessionSettings | null = null
  /** Step limits callers set for the turns their inputs start. Lost with the process, like any option. */
  private readonly turnLimits = new Map<MessageId, number>()
  /** Input arrived while the drain was ending (a user's cancel winding down, or just released), or during a revert: start again when it is gone. */
  private restart = false
  private closing: Promise<void> | null = null
  /** The configuration the execution in progress runs under, read when it started. `null`: nothing is verified. */
  private config: SessionConfig | null = null
  /** Whether a person is there to answer questions. Nobody is until a client says so. */
  private attended = false
  /** The user's approval settings for this session, as a client gave them. */
  private override: ApprovalSection | null = null
  /** The question that waits for an answer. One at a time. */
  private question: PendingQuestion | null = null
  /** The questions asked so far, as a chain: each waits for the one before it. */
  private asking: Promise<void> = Promise.resolve()
  /** What was decided for the calls of the step in progress that have no recorded result yet. */
  private readonly decided = new Map<string, Decided>()
  /** Set when a call that nobody could approve ends the run: the denial's text. */
  private stopping: string | null = null
  /** The history taint is derived from, built from the log on first use and kept up with every append. A cache of a pure function of the log. */
  private taintHistory: TaintHistory | null = null
  /** The notices already shown in this process, so each is said once. */
  private readonly noticed = new Set<string>()
  /** The snapshots of the session's working directory, opened on first use. */
  private snapshotStore: Promise<WorkspaceSnapshots | SnapshotUnavailable> | null = null
  /** A revert, an undo of one or a preview of either that is in progress. The session is idle and must stay so until it ends. */
  private restoring: Promise<unknown> | null = null

  /** Retention of this session's snapshots that is still running. Awaited before the session is let go of. */
  private retaining: Promise<void> | null = null
  /** The directories each settled step's tool calls touched, by message. A cache of a pure function of the log. */
  private readonly touched = new Map<MessageId, readonly string[]>()
  /** What no compaction can remove, in tokens: the instructions and the tool list of the baseline set at `seq`. A cache of a pure function of the log. */
  private fixed: { readonly seq: number; readonly tokens: number } | null = null

  constructor(
    private readonly core: Core,
    readonly id: SessionId,
    /** This session's store, held for writing from the moment it was created or opened until `close`. */
    private readonly store: Store,
  ) {}

  // ---- the public surface ----

  get events(): AsyncIterable<EngineEvent> {
    return this.channel
  }

  get working(): boolean {
    return this.run !== null
  }

  /** What the history tools search and read: this session's stored messages. */
  get history(): Pick<Store, "searchMessages" | "readMessageAt"> {
    return this.store
  }

  subscribe = (listener: (event: EngineEvent) => void) => {
    const entry = (item: EngineEvent) => listener(item)
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  projection = (): Projection => {
    const projection = this.store.getProjection(this.id)
    if (projection === null) throw new EngineError("session_not_found", `session ${this.id} does not exist`)
    return projection
  }

  send = (value: string, options: SendOptions = {}): MessageId => {
    this.assertOpen()
    const messageId = this.core.ids.message()
    if (options.maxSteps !== undefined) this.turnLimits.set(messageId, options.maxSteps)
    this.write([event("inbox.enqueued", { messageId, origin: null, delivery: options.delivery ?? "steer", content: text(value) })])
    this.start()
    return messageId
  }

  queue = (value: string, options: Omit<SendOptions, "delivery"> = {}) => this.send(value, { ...options, delivery: "queue" })

  start = (): void => {
    this.assertOpen()
    const projection = this.projection()
    const execution = projection.session.execution
    if (this.restoring !== null) {
      // A revert happens while idle and nothing may start under it: the input waits until it is done.
      if (execution !== null || projection.inbox.length > 0) this.restart = true
      return
    }
    if (this.run !== null) {
      // Input that arrives while the drain is on its way out starts the next execution once it is gone: the user
      // cancelled and then asked for more, or the claim was released a moment ago and the drain has not returned yet.
      if ((execution === null || execution.interrupting === "user") && projection.inbox.length > 0) this.restart = true
      return
    }
    if (execution === null) {
      if (projection.inbox.length === 0) return
      const executionId = this.core.ids.execution()
      this.write([event("execution.started", { executionId })])
      this.launch(executionId)
      return
    }
    if (execution.interrupting !== null || projection.session.open !== null || owesMarker(projection)) {
      // A claim nobody is working on that was never repaired (it was opened with `wait` after this check ran).
      this.recover("wait")
      return this.start()
    }
    if (execution.status === "suspended") this.write([event("execution.resumed", { executionId: execution.id })])
    this.launch(execution.id)
  }

  interrupt = (): void => {
    this.requestInterrupt("user")
  }

  setSettings = (settings: SessionSettings): void => {
    this.assertOpen()
    // A request in flight was built from the settings it started with: the change waits for the boundary.
    if (this.projection().session.open !== null) this.pendingSettings = settings
    else this.changeSettings(settings)
  }

  withdraw = (messageId: MessageId): boolean => {
    this.assertOpen()
    if (!this.projection().inbox.some((item) => item.messageId === messageId)) return false
    this.write([event("inbox.cancelled", { messageId })])
    this.turnLimits.delete(messageId)
    return true
  }

  readEvents = (range?: { readonly afterSeq?: number; readonly limit?: number }): readonly StoredEvent[] => this.store.readEvents(this.id, range)

  settled = async (): Promise<void> => {
    while (this.run !== null || this.restoring !== null) await (this.run?.done ?? this.restoring?.catch(() => {}))
  }

  setAttended = (present: boolean): void => {
    this.attended = present
  }

  setApproval = (section: ApprovalSection): void => {
    this.override = { ...this.override, ...section }
  }

  approval = (): ApprovalState | null => {
    const approvals = this.core.approvals
    if (approvals === null) return null
    const { policy, ignored } = this.policy()
    const pending = this.question
    return {
      policy,
      ignored,
      sandbox: approvals.sandbox().state,
      attended: this.attended,
      taint: this.taint(policy),
      pending: pending === null ? null : { messageId: pending.messageId, callId: pending.callId, question: pending.asked.question },
    }
  }

  answer = (target: { readonly messageId: MessageId; readonly callId: CallId }, reply: { readonly choice: ChoiceId; readonly note?: string | null }): boolean => {
    this.assertOpen()
    const approvals = this.core.approvals
    const pending = this.question
    if (approvals === null || pending === null || pending.messageId !== target.messageId || pending.callId !== target.callId) return false
    const chosen = pending.asked.question.choices.find((choice) => choice.id === reply.choice)
    const projection = this.projection()
    // An interrupt that was requested first wins: the question is withdrawn and the call does not start.
    if (chosen === undefined || projection.session.execution?.interrupting != null) return false
    const now = this.core.clock.now()
    // Stamped with the position of this very answer: an approval counts from where it was given.
    const grants: Grant[] = stampGrants(chosen.grants, projection.lastSeq + 1, now)
    const note = reply.note == null || reply.note.trim() === "" ? null : reply.note.trim()
    this.write([event("approval.answered", { messageId: pending.messageId, callId: pending.callId, choice: chosen.id, approve: chosen.approve, note, grants })], { expectedSeq: projection.lastSeq })
    if (grants.some((item) => item.scope === "project")) {
      try {
        addProjectGrants(approvals.grantsDir, realWorkspace(projection.session.cwd), grants, now)
      } catch (error) {
        // The answer stands for this call; what could not be kept is asked again next time.
        this.core.report({ kind: "internal_error", sessionId: this.id, message: `the approval could not be remembered for the project: ${describe(error)}`, cause: error })
      }
    }
    pending.resolve({ approve: chosen.approve, note })
    return true
  }

  clearTaint = (): boolean => {
    this.assertOpen()
    if (this.core.approvals === null) return false
    // What the log says is tainted is said first, so that the clearing has something to clear.
    this.noticeTaint()
    if (this.projection().session.approval?.taint == null) return false
    this.write([event("taint.cleared", {})])
    return true
  }

  revert = (options: RevertOptions = {}): Promise<RevertResult> => this.whileIdle(() => this.revertTo(options))

  undoRevert = (options: Omit<RevertOptions, "messageId"> = {}): Promise<RevertResult> => this.whileIdle(() => this.undoLatestRevert(options))

  /**
   * Shows a diagnostic about this session to whoever reads its events.
   * Returns whether it could: a closed session has no readers, and a failing
   * listener is not told about its own failure through the listeners.
   */
  diagnosed(diagnostic: Diagnostic): boolean {
    if (this.closing !== null || diagnostic.kind === "listener_failed") return false
    this.ephemeral({ type: "diagnostic", sessionId: this.id, kind: diagnostic.kind, message: diagnostic.message })
    return true
  }

  close = (): Promise<void> => {
    this.closing ??= this.shutdown()
    return this.closing
  }

  // ---- writing and publishing ----

  /** Appends to the session's log and publishes what was appended. The only way this session's state changes. */
  write(events: readonly NewEvent[], options?: AppendOptions): readonly StoredEvent[] {
    const stored = this.store.append(this.id, events, options)
    if (this.taintHistory !== null) for (const item of stored) this.taintHistory.add(item)
    for (const item of stored) this.publish(item)
    return stored
  }

  /** Hands an event to every consumer, in the order events were produced even when a listener produces more. */
  private publish(item: EngineEvent): void {
    this.outbox.push(item)
    if (this.publishing) return
    this.publishing = true
    try {
      for (let next = this.outbox.shift(); next !== undefined; next = this.outbox.shift()) {
        this.channel.push(next)
        for (const listener of [...this.listeners]) {
          try {
            listener(next)
          } catch (error) {
            this.core.report({ kind: "listener_failed", sessionId: this.id, message: describe(error), cause: error })
          }
        }
      }
    } finally {
      this.publishing = false
    }
  }

  private ephemeral(item: EphemeralEvent): void {
    this.publish(item)
  }

  private probe(point: ProbePoint): void {
    this.core.probe?.(point, this.id)
  }

  private assertOpen(): void {
    if (this.closing !== null) throw new EngineError("closed", `session ${this.id} is closed`)
  }

  // ---- starting, stopping, recovering ----

  private launch(executionId: ExecutionId): void {
    const run: Run = { executionId, interrupt: createInterrupt(), done: Promise.resolve() }
    this.run = run
    run.done = this.drain(run)
  }

  /**
   * Makes the interrupt durable, then aborts (cancel rule 2, "What the loop
   * must not do" 8). The first request wins. Returns whether it was this one.
   */
  private requestInterrupt(reason: InterruptReason): boolean {
    const run = this.run
    if (run === null) return false
    const execution = this.projection().session.execution
    if (execution === null || execution.id !== run.executionId || execution.status !== "running" || execution.interrupting !== null)
      return false
    this.write([event("execution.interrupt_requested", { executionId: execution.id, reason })])
    this.probe("interrupt.requested")
    run.interrupt.interrupt(reason)
    return true
  }

  private async shutdown(): Promise<void> {
    try {
      // A restore in progress is finished, not cut: it is short, and half of one helps nobody.
      // (No await when there is none: the interrupt below must be requested in this very turn of the event loop.)
      if (this.restoring !== null) await this.restoring.catch(() => {})
      if (this.run !== null) {
        this.requestInterrupt("shutdown")
        await this.settled()
        return
      }
      // A claim this process took up and never worked on is suspended, so the next start resumes it uncounted.
      const projection = this.store.getProjection(this.id)
      const execution = projection?.session.execution ?? null
      if (projection && execution?.status === "running" && execution.interrupting === null && projection.session.open === null)
        this.write([
          event("execution.interrupt_requested", { executionId: execution.id, reason: "shutdown" }),
          event("execution.interrupted", { executionId: execution.id, reason: "shutdown" }),
        ])
    } catch (error) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `closing failed: ${describe(error)}`, cause: error })
    } finally {
      await this.retaining?.catch(() => {})
      this.channel.end()
      this.listeners.clear()
      this.core.sessions.delete(this.id)
      // The session is let go of: this or another process can open it now.
      try {
        this.store.close()
      } catch (error) {
        this.core.report({ kind: "internal_error", sessionId: null, message: `closing the store of ${this.id} failed: ${describe(error)}`, cause: error })
      }
    }
  }

  /**
   * Repairs what a process that is gone left unfinished, then resumes it as
   * `mode` says: a claim that nobody is working on (see `recovery.ts`), or a
   * revert whose restore was announced and never recorded, which is finished
   * whatever the mode is, because the workspace may be half restored.
   */
  recover(mode: ResumeMode): void {
    const projection = this.projection()
    const open = projection.session.open
    if (projection.session.execution === null && (open?.kind === "revert" || open?.kind === "undo")) {
      if (this.restoring === null) this.exclusive(() => this.completeRestore(null)).catch(() => {})
      return
    }
    const recovery = recover(projection, { crashResumeCap: this.core.limits.crashResumeCap, newMessageId: this.core.ids.message })
    if (recovery.events.length > 0) this.write(recovery.events, { expectedSeq: projection.lastSeq })
    if (recovery.claim === "none" || mode === "wait") return
    const execution = claimOf(this.projection())
    if (recovery.claim === "suspended") this.write([event("execution.resumed", { executionId: execution.id })])
    if (mode === "start") this.launch(execution.id)
  }

  private changeSettings(settings: SessionSettings): void {
    const current = this.projection().session.settings
    if (current.model === settings.model && current.reasoningEffort === settings.reasoningEffort) return
    this.write([event("settings.changed", settings)])
  }

  // ---- the drain ----

  private async drain(run: Run): Promise<void> {
    try {
      // The caller that started the execution returns first.
      await Promise.resolve()
      this.probe("execution.claimed")
      if (await this.configure(run)) await this.loop(run)
    } catch (error) {
      this.abandon(run, error)
    } finally {
      this.run = null
      this.retain()
      const again = this.restart && this.closing === null
      this.restart = false
      if (again) {
        try {
          this.start()
        } catch (error) {
          this.core.report({ kind: "internal_error", sessionId: this.id, message: describe(error), cause: error })
        }
      }
    }
  }

  /**
   * Reads the configuration this execution runs under. A change to the
   * files takes effect here, at the next turn, never in the middle of one. A
   * file that cannot be read or is invalid fails the execution before
   * anything is sent: carrying on would silently switch the checks off.
   */
  private async configure(run: Run): Promise<boolean> {
    const load = this.core.loadConfig
    if (load === null) {
      this.config = null
      this.announcePolicy()
      return true
    }
    try {
      this.config = await load(this.projection().session.cwd)
      this.announcePolicy()
      return true
    } catch (error) {
      if (run.interrupt.signal.aborted) this.finishInterrupt(run)
      else this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.config(describe(error)) })])
      return false
    }
  }

  /** Works until the execution has its terminal event: succeeded, failed or interrupted. */
  private async loop(run: Run): Promise<void> {
    const { limits, ids } = this.core
    const signal = run.interrupt.signal
    for (;;) {
      this.probe("step.boundary")
      if (signal.aborted) return this.finishInterrupt(run)
      if (this.pendingSettings !== null) {
        const settings = this.pendingSettings
        this.pendingSettings = null
        this.changeSettings(settings)
      }

      const before = this.projection()
      const latest = latestSpoken(before)
      if (latest?.kind === "assistant" && latest.status === "failed") {
        // The only failed step the loop leaves unanswered is one the provider rejected as too large: compact, then
        // rebuild the request (retry rule 5). A compaction that was cut short (a crash, an interrupt) is made again.
        const overflowed = latest.error?.kind === "provider" && latest.error.error.kind === "context_overflow"
        if (!overflowed) {
          this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.internal("the last step failed and was not retried") })])
          return
        }
        if ((before.session.compaction?.seq ?? 0) < latest.seq) {
          const window = await this.contextWindow(before.session.settings.model)
          if (signal.aborted) return this.finishInterrupt(run)
          const rejected = this.prepare(before, "auto")
          const decision = this.afterOverflow(rejected, window)
          const outcome = decision.kind === "now" ? await this.compact(run, { trigger: "overflow", mode: decision.mode, tailBudget: decision.tailBudget, tokensBefore: this.measure(rejected).total }) : "nothing"
          if (outcome === "done") return
          if (outcome === "nothing") {
            // Nothing is left to take out, or the request built right after an aggressive compaction was rejected too.
            this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.overflow })])
            return
          }
          continue
        }
      }

      // The model has answered and no steer redirects it: whether the turn may end is the gate's decision. That
      // holds when a queued message waits behind the turn too: "after this turn" means after it is done, and done
      // is what the gate says. Only a queued message that is the first input under the claim follows no turn.
      const idle = wouldGoIdle(before)
      let ended: VerificationOutcome | null = null
      if (idle && !before.inbox.some(isSteer) && (before.inbox.length === 0 || latest !== undefined)) {
        const verdict = await this.gate(run)
        if (verdict === "done") return
        if (verdict === "continue") continue
        ended = verdict.verification
      }

      // A step follows. The workspace is recorded first when input is about to enter history, so that a later
      // revert to before that input has a state to go back to, including what the user changed by hand since.
      if (this.core.openSnapshots !== null && (before.inbox.some(isSteer) || ended !== null || (idle && before.inbox.length > 0))) {
        await this.snapshot("delivery")
        if (signal.aborted) return this.finishInterrupt(run)
      }
      // Read again: input may have arrived, or been withdrawn, while the gate ran and the snapshot was taken.
      const waiting = this.projection()
      const steers = waiting.inbox.filter(isSteer)
      const queued = waiting.inbox.find((item) => !isSteer(item))
      const follows = latestSpoken(waiting) !== undefined
      // Steers at any boundary, oldest first. One queued item only when the turn before it ended, or as the first input.
      const handover = steers.length === 0 && queued !== undefined && (ended !== null || !follows) ? queued : undefined
      // The turn may end and what waited behind it is gone: nothing follows, so the gate decides again, now alone.
      if (ended !== null && steers.length === 0 && handover === undefined) continue
      // Instructions first, then the waiting input, so the request carries both.
      const prepared = prepareInstructions(waiting, {
        ...(this.core.prompt === undefined ? {} : { prompt: this.core.prompt }),
        tools: this.offeredTools(waiting),
        sources: this.core.discover({
          cwd: waiting.session.cwd,
          known: knownAgentsFiles(instructionState(selectModelHistory(waiting))),
          directories: this.workedDirectories(waiting),
        }),
        newMessageId: ids.message,
      })
      if (prepared.length > 0) this.write(prepared)
      if (steers.length > 0) this.write(steers.map((item) => event("inbox.delivered", { messageId: item.messageId })))
      else if (handover !== undefined)
        // The end of the turn and the delivery it makes room for are one decision, so one append.
        this.write([
          ...(ended !== null && follows ? [event("turn.ended", { verification: ended })] : []),
          event("inbox.delivered", { messageId: handover.messageId }),
        ])

      const ready = this.projection()
      const input = turnInput(ready)
      const limit = (input === undefined ? undefined : this.turnLimits.get(input.id)) ?? limits.stepLimit
      const steps = stepsThisTurn(ready)
      let forbidden = notedThisTurn(ready, HARNESS_ORIGIN.stepLimit)
      if (forbidden && steps > limit + 2) {
        // The final call may not use tools, and a provider that ignores that could go round for ever.
        this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.stepLimitIgnored })])
        return
      }
      if (!forbidden && steps >= limit) {
        this.write([note(ids.message(), HARNESS_ORIGIN.stepLimit, NOTE_TEXT.stepLimit)])
        forbidden = true
      }
      // The tool list stays; only the choice changes, which is not part of the cached prefix.
      const toolChoice = forbidden ? "none" : "auto"
      // How large would this request be? The policy decides from the estimate whether history is compacted first.
      const window = await this.contextWindow(ready.session.settings.model)
      if (signal.aborted) return this.finishInterrupt(run)
      const next = this.prepare(this.projection(), toolChoice)
      const decision = window === null ? null : this.beforeStep(next, window)
      if (window !== null && decision?.kind === "now") {
        const outcome = await this.compact(run, {
          trigger: decision.trigger,
          mode: decision.mode,
          tailBudget: decision.tailBudget,
          tokensBefore: this.measure(next).total,
          otherwise: { fits: decision.share <= 1, aggressiveBudget: this.aggressiveBudget(next, window) },
        })
        if (outcome === "done") return
        // The baseline is set again and the request rebuilt at the top of the loop.
        if (outcome === "compacted") continue
        // Nothing could be taken out: the request is sent as it is.
      }
      if ((await this.step(run, next)) === "done") return
    }
  }

  // ---- the context window ----

  /**
   * The context window of `model`, asked for once per engine. `null` when
   * nobody knows it: then nothing is compacted ahead of time.
   */
  private async contextWindow(model: string): Promise<number | null> {
    const windows = this.core.windows
    const known = windows.get(model)
    // No await when it is known: the loop goes straight on.
    if (known !== undefined) return known
    const asked = this.core.contextWindow === undefined ? null : await Promise.resolve(this.core.contextWindow(model)).catch(() => null)
    const window = asked !== null && Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : null
    windows.set(model, window)
    return window
  }

  /** The request the next step sends, built from stored state. */
  private prepare(projection: Projection, toolChoice: ModelRequest["toolChoice"]): Prepared {
    const request = buildRequest(projection, { ...this.core.call, toolChoice })
    return { projection, request, blocks: hashRequest(request) }
  }

  /**
   * How many input tokens `prepared` will be: the provider's own count for
   * the last step call, when this request extends it, plus an estimate of
   * what was appended since; otherwise an estimate of all of it.
   */
  private measure(prepared: Prepared): SizeEstimate {
    const last = this.store.lastRequest(this.id, "step")
    const measured = last !== null && last.outcome === "ok" && last.usage !== null ? { blocks: last.blocks, usage: last.usage } : null
    return estimateNextInput(prepared.request, measured, prepared.blocks)
  }

  /** Tokens no compaction can remove: the instructions and the tool list of the baseline in force. */
  private fixedTokens(prepared: Prepared): number {
    const seq = prepared.projection.baseline?.seq ?? 0
    if (this.fixed?.seq !== seq)
      this.fixed = { seq, tokens: estimateTokens(prepared.request.instructions) + prepared.request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) }
    return this.fixed.tokens
  }

  /** What the policy is told about the window: its size and the part kept free for the answer. */
  private windowInput(window: number | null) {
    // With no known window the only thing known is that the rejected request was too large.
    if (window === null) return { contextWindow: Number.MAX_SAFE_INTEGER, reservedOutput: 0 }
    return { contextWindow: window, reservedOutput: Math.min(this.core.limits.reservedOutputTokens, Math.floor(window / 5)) }
  }

  /** Tokens of history an aggressive compaction keeps word for word in a window of this size. */
  private aggressiveBudget(prepared: Prepared, window: number): number {
    const { contextWindow, reservedOutput } = this.windowInput(window)
    return tailBudget(Math.floor((contextWindow - reservedOutput) * this.core.compaction.aggressiveTargetRatio), this.fixedTokens(prepared), this.core.compaction)
  }

  /** The policy's decision before a step: send the request, or compact first. */
  private beforeStep(prepared: Prepared, window: number): CompactionDecision {
    return decideCompaction({
      ...this.windowInput(window),
      estimate: this.measure(prepared),
      fixedTokens: this.fixedTokens(prepared),
      lastCompaction: compactionOutcome(prepared.projection),
      atUserBoundary: atInputBoundary(prepared.projection),
      config: this.core.compaction,
    })
  }

  /** The policy's decision after the provider rejected `prepared` as too large: compact aggressively, or give up. */
  private afterOverflow(prepared: Prepared, window: number | null): CompactionDecision {
    const compaction = prepared.projection.session.compaction
    const checkpoint = compaction === null ? undefined : prepared.projection.messages.findLast((message) => message.id === compaction.messageId)
    return decideAfterOverflow({
      ...this.windowInput(window),
      estimate: this.measure(prepared),
      fixedTokens: this.fixedTokens(prepared),
      lastCompaction: compactionOutcome(prepared.projection),
      completedStepSinceCompaction: completedStepSinceCompaction(prepared.projection),
      lastCompactionWasOverflow: checkpoint?.kind === "compaction" && checkpoint.trigger === "overflow",
      config: this.core.compaction,
    })
  }

  /** One logical step: a model call with its single attempt budget (retry rule 1), then its tools. */
  private async step(run: Run, prepared: Prepared): Promise<StepResult> {
    const { limits, clock, ids } = this.core
    const signal = run.interrupt.signal
    const { projection: start, request, blocks } = prepared
    const toolChoice = request.toolChoice
    this.checkPrefix(start, blocks)
    const messageId = ids.message()
    let attempt = claimOf(start).nextAttempt
    this.write([event("step.started", { messageId, attempt, model: start.session.settings.model })])
    this.probe("step.started")

    let refreshed = false
    for (;;) {
      // A retry resends the same request unchanged.
      const call = await this.callModel(run, { messageId, attempt, request, blocks, purpose: "step" })
      if (call.end.type === "aborted") {
        this.finishInterrupt(run, call.partialText, call.usage)
        return "done"
      }
      if (call.end.type === "finish") return this.finishStep(run, messageId, toolChoice, call.end.reason, call)

      const error = call.end.error
      const message = this.assistant(messageId)
      // The partial text the user saw is kept, as on a cancel; partial reasoning and arguments are dropped.
      const flush = call.partialText === "" ? [] : [event("text.ended", { messageId, text: call.partialText, providerData: null })]
      const hasOutput = message.parts.length > 0 || flush.length > 0
      // A call that was recorded never started: tools run only after the response finishes.
      const closing = [...flush, ...settleUnsettled(message, STOPPED)]
      const failed = event("step.failed", { messageId, error: { kind: "provider", error }, usage: call.usage })
      const giveUp = (reason: string) => event("execution.failed", { executionId: run.executionId, message: reason })

      if (error.kind === "content_policy") {
        const refused = event("step.refused", {
          messageId,
          message: error.message,
          excludeFromSeq: refusedTurnStart(this.projection(), message),
          usage: call.usage,
        })
        this.write([...closing, refused, giveUp(FAILURE_TEXT.refused)])
        return "done"
      }
      if (error.kind === "auth" && !hasOutput && !refreshed && this.core.refreshAuth !== undefined) {
        refreshed = true
        const usable = await this.core.refreshAuth().catch(() => false)
        if (signal.aborted) {
          this.finishInterrupt(run, "", call.usage)
          return "done"
        }
        if (usable) continue
      }
      if (error.retryable && attempt < limits.attemptBudget) {
        const delayMs = retryDelayMs(limits, attempt, error, this.core.random)
        const retry = event("retry.scheduled", { messageId, attempt: attempt + 1, delayMs, error })
        // Before durable output the retry is transparent. After it the message fails, and the retry runs under a new
        // message that the model is asked to continue from (retry rule 2).
        this.write(hasOutput ? [...closing, failed, retry, note(ids.message(), HARNESS_ORIGIN.continuation, NOTE_TEXT.continuation)] : [retry])
        this.probe("retry.scheduled")
        await clock.sleep(delayMs, signal)
        if (signal.aborted) {
          this.finishInterrupt(run, "", call.usage)
          return "done"
        }
        if (hasOutput) return "continue"
        attempt += 1
        continue
      }
      if (error.kind === "context_overflow" && !hasOutput && this.afterOverflow(prepared, this.core.windows.get(start.session.settings.model) ?? null).kind === "now") {
        // Closed here; the loop compacts at the boundary and rebuilds the request.
        this.write([failed])
        this.probe("step.closed")
        return "continue"
      }
      const reason = error.retryable
        ? FAILURE_TEXT.budget(attempt, error)
        : error.kind === "context_overflow"
          ? FAILURE_TEXT.overflow
          : failureText(error)
      this.write([...closing, failed, giveUp(reason)])
      return "done"
    }
  }

  /** The model call finished: run what it asked for and close the step. */
  private async finishStep(
    run: Run,
    messageId: MessageId,
    toolChoice: ModelRequest["toolChoice"],
    reason: FinishReason,
    call: ModelCall,
  ): Promise<StepResult> {
    const ids = this.core.ids
    const message = this.assistant(messageId)
    const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call")
    const usage = call.usage

    if (reason === "length") {
      // A call cut off by the output limit was never recorded and never runs (retry rule 6). Calls that did end
      // are not run either: the response they belong to is incomplete.
      const told = call.cutOff || calls.length > 0
      this.write([
        ...settleUnsettled(message, STOPPED),
        event("step.ended", { messageId, finish: "length", usage }),
        ...(told ? [note(ids.message(), HARNESS_ORIGIN.outputLimit, NOTE_TEXT.outputLimit)] : []),
      ])
      this.probe("step.closed")
      return "continue"
    }

    if (calls.length > 0) {
      // A step is bracketed by two snapshots exactly when one of its calls can change files: a step of reads
      // changes nothing, and the snapshot before it is still the workspace.
      const tracked = this.core.openSnapshots !== null && this.mayChangeFiles(calls, toolChoice)
      if (tracked) {
        await this.snapshot("step_start", messageId)
        if (run.interrupt.signal.aborted) {
          this.finishInterrupt(run, "", usage)
          return "done"
        }
      }
      await this.runTools(run, message, calls, toolChoice)
      const stopped = this.stopping
      this.stopping = null
      if (run.interrupt.signal.aborted) {
        // The model call itself finished: what it cost is known, though its tools were cut short.
        this.finishInterrupt(run, "", usage)
        return "done"
      }
      if (stopped !== null) {
        // A call needed approval, nobody was there, and the policy says the run ends there (`unattended: "stop"`).
        // What had not started yet does not start; the step closes and the execution ends, in one append.
        this.write([
          ...settleUnsettled(this.assistant(messageId), STOPPED),
          event("step.ended", { messageId, finish: "tool_calls", usage }),
          event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.approvalStop(stopped), cause: "approval" }),
        ])
        return "done"
      }
      if (tracked) {
        await this.snapshot("step_end", messageId)
        if (run.interrupt.signal.aborted) {
          this.finishInterrupt(run, "", usage)
          return "done"
        }
      }
      // A step that ran tools asked for tools, whatever the provider called its finish.
      this.write([event("step.ended", { messageId, finish: "tool_calls", usage })])
      this.probe("step.closed")
      return "continue"
    }

    const ended = event("step.ended", { messageId, finish: "stop", usage })
    const current = this.projection()
    if (saysNothing(message) && !current.inbox.some((item) => item.delivery === "steer")) {
      // A response with no text and no call (nothing at all, or only reasoning) says nothing. It gets one nudge;
      // a second one in a row fails the execution (retry rule 8).
      const previous = current.messages.at(-2)
      const nudged = previous?.kind === "synthetic" && previous.delivery === null && previous.origin === HARNESS_ORIGIN.emptyResponse
      if (nudged) {
        this.write([ended, event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.emptyTwice })])
        return "done"
      }
      this.write([ended, note(ids.message(), HARNESS_ORIGIN.emptyResponse, NOTE_TEXT.emptyResponse)])
      this.probe("step.closed")
      return "continue"
    }
    this.write([ended])
    this.probe("step.closed")
    return "continue"
  }

  /**
   * Streams one model call: deltas are published as they arrive, each
   * finished item is appended at its end, and the ledger row is closed.
   * A compaction call records no output events; its text is returned.
   */
  private async callModel(
    run: Run,
    input: {
      readonly messageId: MessageId
      readonly attempt: number
      readonly request: ModelRequest
      readonly blocks: readonly BlockHash[]
      readonly purpose: RequestPurpose
      /** The wall-clock limit of this call, instead of a step's. */
      readonly limitMs?: number
      /**
       * Stop reading once the text passes this many characters, and take what
       * arrived as the answer, cut short. The bound on a summary: this
       * provider takes no output limit in the request.
       */
      readonly maxOutputChars?: number
    },
  ): Promise<ModelCall> {
    const { provider, ids } = this.core
    const store = this.store
    const signal = run.interrupt.signal
    const { messageId, request } = input
    const step = input.purpose === "step"
    const requestId = ids.request()
    store.beginRequest({
      id: requestId,
      sessionId: this.id,
      messageId,
      attempt: input.attempt,
      purpose: input.purpose,
      model: request.params.model,
      blocks: input.blocks,
    })

    let usage: Usage | null = null
    let partialText = ""
    let whole = ""
    let end: ModelEnd | null = null
    const streaming = new Set<string>()
    const threw = (error: unknown): ModelEnd => ({
      type: "error",
      error: makeProviderError("provider_internal", `The provider failed: ${describe(error)}`),
    })

    // The request is stopped by an interrupt, and by the wall-clock limit of one call: a call that never ends
    // must not hold a turn for ever.
    const limitMs = input.limitMs ?? this.core.limits.modelCallTimeoutMs
    let overran = false
    const request$ = new AbortController()
    const forward = () => request$.abort(signal.reason)
    if (signal.aborted) forward()
    else signal.addEventListener("abort", forward, { once: true })
    const timer = new AbortController()
    const deadline: Promise<typeof TIMED_OUT> = limitMs > 0 ? this.core.clock.sleep(limitMs, timer.signal).then(() => TIMED_OUT) : new Promise<never>(() => {})
    let timedOut = false

    let iterator: AsyncIterator<StreamEvent> | null = null
    try {
      iterator = provider.stream(request, request$.signal)[Symbol.asyncIterator]()
    } catch (error) {
      end = threw(error)
    }
    // A provider that does not stop on abort must not hold the cancel up: the loop stops waiting for it.
    const stopped = abortedOnce(signal)
    try {
      while (iterator !== null && end === null) {
        // Only the provider's own failure is caught here: an error in what follows is the harness's and must surface.
        const next = await Promise.race([iterator.next().catch((error: unknown) => ({ failed: error })), stopped.promise, deadline])
        if (next === ABORTED) break
        if (next === TIMED_OUT) {
          if (signal.aborted) break
          timedOut = true
          end = { type: "error", error: makeProviderError("transport", modelCallTimedOut(limitMs), { reason: "timeout" }) }
          request$.abort()
          break
        }
        if ("failed" in next) {
          if (!signal.aborted) end = threw(next.failed)
          break
        }
        if (next.done || signal.aborted) break
        const item = next.value
        switch (item.type) {
          case "text.delta":
            partialText += item.text
            if (step) this.ephemeral({ type: "text.delta", sessionId: this.id, messageId, text: item.text })
            if (input.maxOutputChars !== undefined && whole.length + partialText.length > input.maxOutputChars) {
              // A summary that does not end: what arrived is the answer, cut here.
              overran = true
              end = { type: "finish", reason: "length" }
              request$.abort()
            }
            break
          case "text.end":
            partialText = ""
            whole += item.text
            if (step) {
              this.write([event("text.ended", { messageId, text: item.text, providerData: item.providerData })])
              this.probe("model.output")
            }
            break
          case "reasoning.delta":
            if (step) this.ephemeral({ type: "reasoning.delta", sessionId: this.id, messageId, text: item.text })
            break
          case "reasoning.end":
            if (step) {
              this.write([event("reasoning.ended", { messageId, text: item.text, providerData: item.providerData })])
              this.probe("model.output")
            }
            break
          case "tool_call.delta":
            streaming.add(item.callId)
            if (step)
              this.ephemeral({
                type: "tool.input.delta",
                sessionId: this.id,
                messageId,
                callId: item.callId as CallId,
                name: item.name,
                input: item.input,
              })
            break
          case "tool_call.end":
            streaming.delete(item.callId)
            if (step) {
              // Durable before anything runs; if this append throws, nothing runs (cancel rule 1).
              this.write([
                event("tool.called", { messageId, callId: item.callId as CallId, name: item.name, input: item.input, providerData: item.providerData }),
              ])
              this.probe("model.output")
            }
            break
          case "usage":
            usage = item.usage
            break
          case "finish":
            end = { type: "finish", reason: item.reason }
            break
          case "error":
            end = { type: "error", error: item.error }
            break
        }
      }
    } finally {
      stopped.dispose()
      timer.abort()
      signal.removeEventListener("abort", forward)
      // Stops the request when the loop stopped reading first. After an abort or the time limit the provider is not waited for.
      const closed = iterator?.return?.().catch(() => {})
      if (!signal.aborted && !timedOut && !overran) await closed
    }
    // No terminal event and nobody aborted: the stream broke.
    end ??= signal.aborted ? { type: "aborted" } : { type: "error", error: makeProviderError("incomplete_stream", INCOMPLETE_STREAM) }
    store.finishRequest(requestId, {
      // A call the loop itself cut at the output bound did not finish: it was stopped.
      outcome: overran ? "aborted" : end.type === "finish" ? "ok" : end.type === "error" ? "error" : "aborted",
      usage,
      errorKind: end.type === "error" ? end.error.kind : null,
    })
    return { end, usage, partialText, cutOff: streaming.size > 0, text: whole, overran }
  }

  /**
   * Runs the step's calls and settles each exactly once, in the order they
   * finish. Returns when every call is settled, or, after an interrupt, when
   * the tools have stopped or their grace period is over; what is still
   * unsettled then is settled by `finishInterrupt` from its recorded state.
   *
   * The order (with the approval layer on; without it every call starts at once):
   *
   * 1. Calls the loop itself refuses (tools forbidden, too many calls, the
   *    identical-call guard) are settled first, in call order.
   * 2. Calls of class `read` are decided at once, in call order, and those
   *    that may run start at once and run side by side.
   * 3. Every other call (a write, a command, a network or MCP tool) keeps its
   *    place in one line: it is decided when the one before it in the line
   *    has its result, and runs alone in the line. So a write is never
   *    decided or started while a command runs (a command could swap a link
   *    under the path that was checked), and side effects happen in the order
   *    the model wrote them.
   * 4. A call that must ask is suspended, and only it: reads go on, and the
   *    line waits behind it, because what comes later in the line was written
   *    to happen after it. Questions are asked one at a time, in the order
   *    their calls reached them; a call is decided again when its turn to
   *    ask comes, since an answer given meanwhile may cover it.
   * 5. A decision is made from the state at the moment it is made: the taint
   *    and the approvals as the log has them then.
   * 6. An interrupt withdraws a pending question: the call settles as not
   *    started, like every call the interrupt reached before it began.
   */
  private async runTools(
    run: Run,
    message: AssistantMessage,
    calls: readonly ToolCallPart[],
    toolChoice: ModelRequest["toolChoice"],
  ): Promise<void> {
    const { runtime, limits, clock, effects } = this.core
    const approvals = this.core.approvals
    const signal = run.interrupt.signal
    const before = this.projection()
    const messageId = message.id
    const unsettled = new Set<CallId>()
    const abandoned = new Set<CallId>()
    const failure: { error?: unknown; failed: boolean } = { failed: false }
    const refuse = (call: ToolCallPart, output: string) =>
      this.write([
        event("tool.settled", { messageId, callId: call.callId, outcome: "error", output, truncation: null, attachments: [], display: null }),
      ])
    this.decided.clear()
    const extras = approvals === null ? {} : { ...this.tempContext(), redact: redactor(approvals.secrets) }

    /** One call, from its decision to its recorded result. */
    const launch = (call: ToolCallPart): Promise<void> => {
      const effect = effects.get(call.name)
      const key = callKey(messageId, call.callId)
      unsettled.add(call.callId)
      return runtime
        .run(
          {
            name: call.name,
            argumentsText: call.input,
            context: {
              sessionId: this.id,
              messageId,
              callId: call.callId,
              cwd: before.session.cwd,
              signal,
              progress: (update) => {
                if (!abandoned.has(call.callId)) this.ephemeral({ type: "tool.progress", sessionId: this.id, messageId, callId: call.callId, text: update.text })
              },
              ...extras,
            },
          },
          {
            ...(approvals === null ? {} : { authorize: (tool: AnyTool, input: Json) => this.authorize(run, messageId, call, tool, input) }),
            // Synchronous, right before the tool runs: the start is durable before any side effect.
            onStart: () => {
              if (effect === undefined) throw new Error(`tool ${call.name} started without an effect class`)
              const ran = this.decided.get(key)?.run
              this.write([event("tool.started", { messageId, callId: call.callId, effect, ...(ran === undefined ? {} : { run: ran }) })])
              this.probe("tool.started")
            },
          },
        )
        .then((result) => {
          this.probe("tool.finished")
          // A tool that came back after its grace period was already settled from its effect class.
          if (abandoned.has(call.callId)) return
          // The interrupt reached it while it waited for an answer: it never began, and the wind-down settles it.
          if (result.kind === "not_started") return
          unsettled.delete(call.callId)
          const decided = this.decided.get(key)
          this.decided.delete(key)
          const settlement = this.settlement(result, effect, signal)
          // The note for a failure the sandbox causes, then the redaction: what is stored is what is replayed.
          const shown = approvals === null ? settlement : { ...settlement, ...finishOutput(settlement, decided?.run, effect, approvals.secrets) }
          this.write([...(decided?.before ?? []), event("tool.settled", { messageId, callId: call.callId, ...shown })])
          this.probe("tool.settled")
          if (decided?.stop != null) this.stopping ??= decided.stop
          this.noticeTaint()
        })
        .catch((error: unknown) => {
          unsettled.delete(call.callId)
          if (!failure.failed) failure.error = error
          failure.failed = true
        })
    }

    /** The line of calls that can change something: each starts when the one before it has its result. */
    let line: Promise<void> = Promise.resolve()
    const running = calls.flatMap((call, index): Promise<void>[] => {
      // Once an interrupt is requested nothing new starts; the call is settled as not started below.
      if (failure.failed || signal.aborted) return []
      if (toolChoice === "none") return refuse(call, TOOL_TEXT.toolsDisabled) && []
      if (index >= limits.maxToolCallsPerStep) return refuse(call, TOOL_TEXT.tooManyCalls(limits.maxToolCallsPerStep)) && []
      if (repeatsItself(before, { messageId, callId: call.callId, name: call.name, input: call.input })) return refuse(call, TOOL_TEXT.identicalCall) && []
      const effect = effects.get(call.name)
      // A read changes nothing, and a tool nobody knows is refused before it could: both go at once.
      if (approvals === null || effect === undefined || effect === "read") return [launch(call)]
      line = line.then(() => (failure.failed || signal.aborted || this.stopping !== null ? undefined : launch(call)))
      return [line]
    })

    const all = Promise.all(running)
    await untilAborted(all, signal)
    if (signal.aborted && unsettled.size > 0) {
      // Cooperative: the tools saw the abort. Give them time to stop and report what they observed.
      const timer = new AbortController()
      await Promise.race([all, clock.sleep(limits.toolStopGraceMs, timer.signal)])
      timer.abort()
      for (const callId of unsettled) abandoned.add(callId)
    }
    this.decided.clear()
    if (failure.failed) throw failure.error
  }

  // ---- approval ----

  /**
   * Decides one call, right before it would start: it runs, runs in the
   * sandbox, is refused, or the user is asked and the call waits for the
   * answer. Everything a decision rests on is recorded: with `tool.started`
   * for a call that runs, as `approval.requested` and `approval.answered`
   * around a question, as `approval.denied` with the refusal.
   */
  private async authorize(run: Run, messageId: MessageId, call: ToolCallPart, tool: AnyTool, input: Json): Promise<Authorization> {
    const approvals = this.core.approvals
    if (approvals === null) return { kind: "run" }
    const signal = run.interrupt.signal
    const key = callKey(messageId, call.callId)
    const context = this.factContext()
    const known = callFacts(tool, input, context)
    if ("invalid" in known) return { kind: "refuse", output: `Invalid arguments for ${tool.name}: ${known.invalid}\nFix them and call ${tool.name} again.` }
    const facts = known.facts
    const workspace = realWorkspace(context.cwd)
    const decideNow = (present = this.attended) => {
      const policy = this.policy().policy
      const decision = decide({ policy, call: facts, sandbox: this.sandboxState(), taint: this.taint(policy), grants: this.grants(workspace), present, now: this.core.clock.now(), workspace, home: approvals.home })
      return { policy, decision }
    }
    const allow = (policy: ApprovalPolicy, how: RunDecision, note?: string): Authorization => {
      const sandbox = how.kind === "run_sandboxed" ? { network: how.network, writableRoots: [...how.writableRoots] } : null
      this.decided.set(key, { run: runRecord(policy, facts, sandbox), before: [], stop: null })
      return { kind: "run", sandbox, ...(note === undefined ? {} : { note }) }
    }
    const record = (policy: ApprovalPolicy) => ({ messageId, callId: call.callId, mode: policy.mode, paths: [...facts.paths], escalation: facts.escalation })

    let { policy, decision } = decideNow()
    if (decision.kind === "ask") {
      // One question at a time. While this call waited for its turn, an answer may have covered what it needs.
      const done = await this.questionTurn(signal)
      try {
        if (signal.aborted) return WITHDRAWN
        ;({ policy, decision } = decideNow())
        if (decision.kind === "ask") {
          const asked = decision
          this.write([event("approval.requested", { ...record(policy), question: asked.question, needs: [...asked.needs], then: asked.then })])
          this.probe("approval.requested")
          const answer = await this.answerTo({ messageId, callId: call.callId, asked }, signal)
          if (answer === null) return WITHDRAWN
          return answer.approve ? allow(policy, asked.then, answer.note === null ? undefined : approvedNote(answer.note)) : { kind: "refuse", output: declinedMessage(answer.note) }
        }
      } finally {
        done()
      }
    }
    if (decision.kind === "deny") {
      // The same call with someone present: whether it was the policy that refused, or the empty chair.
      const attended = decideNow(true).decision
      const denied = event("approval.denied", {
        ...record(policy),
        reason: attended.kind === "ask" ? "unattended" : "policy",
        needs: attended.kind === "ask" ? [...attended.needs] : [],
        stop: decision.stop,
      })
      this.decided.set(key, { run: undefined, before: [denied], stop: decision.stop ? decision.message : null })
      return { kind: "refuse", output: decision.message }
    }
    return allow(policy, decision)
  }

  /** Waits for this call's turn to ask, and returns what ends the turn. An interrupt does not wait. */
  private async questionTurn(signal: AbortSignal): Promise<() => void> {
    const previous = this.asking
    let done = () => {}
    this.asking = new Promise<void>((resolve) => {
      done = resolve
    })
    await untilAborted(previous, signal)
    return done
  }

  /** Resolves with the user's answer to the question that was just recorded, or with `null` when an interrupt withdrew it. */
  private answerTo(question: Omit<PendingQuestion, "resolve">, signal: AbortSignal): Promise<{ readonly approve: boolean; readonly note: string | null } | null> {
    return new Promise((resolve) => {
      const settle = (answer: { readonly approve: boolean; readonly note: string | null } | null) => {
        signal.removeEventListener("abort", withdraw)
        this.question = null
        resolve(answer)
      }
      const withdraw = () => settle(null)
      this.question = { ...question, resolve: settle }
      if (signal.aborted) return settle(null)
      signal.addEventListener("abort", withdraw, { once: true })
    })
  }

  /** The policy in force: the user's settings (their file, the process's flags, this session's own choice), tightened by the project's file. */
  private policy(): ResolvedApproval {
    return effectivePolicy({
      file: this.config?.approval?.user ?? null,
      process: this.core.approvals?.user ?? null,
      session: this.override,
      project: this.config?.approval?.project ?? null,
    })
  }

  private sandboxState(): SandboxState {
    const state = this.core.approvals!.sandbox().state
    return state.available ? { available: true } : { available: false, reason: state.reason }
  }

  /** The session's taint, derived from its log: the fold of `approval/taint.ts` over every tool result, clearing and compaction in it. */
  private taint(policy: ApprovalPolicy): TaintState {
    if (this.taintHistory === null) {
      const history = new TaintHistory()
      for (const item of this.store.readEvents(this.id)) history.add(item)
      this.taintHistory = history
    }
    return deriveTaint(this.taintHistory.entries, { untrustedPaths: policy.untrustedPaths })
  }

  /** The approvals that may cover a call: this session's, from its log, and the project's, from the user's data directory. */
  private grants(workspace: string): Grant[] {
    return [...(this.projection().session.approval?.grants ?? []), ...readProjectGrants(this.core.approvals!.grantsDir, workspace, this.core.clock.now())]
  }

  /**
   * The session's temp directory as the tools see it, when commands can be
   * sandboxed here. Its alias (`/tmp` under bubblewrap) holds only where
   * commands run sandboxed as a rule: in `full` they see the machine's own
   * `/tmp`, and the file tools must then mean that one too.
   */
  private tempContext(): { readonly temp?: TempDirectory } {
    const approvals = this.core.approvals
    if (approvals === null || !approvals.sandbox().state.available) return {}
    const temp = approvals.sandbox().temp(this.id)
    return { temp: this.policy().policy.mode === "full" ? { dir: temp.dir, alias: null } : temp }
  }

  private factContext(): FactContext {
    return { cwd: this.projection().session.cwd, temp: this.tempContext().temp, approvals: this.core.approvals! }
  }

  /**
   * Tells the user, once, that the session became tainted and from what:
   * `taint.noticed`, written when the taint derived from the log is not yet
   * on record. The decisions never read this record; they derive.
   */
  private noticeTaint(): void {
    if (this.core.approvals === null) return
    const policy = this.policy().policy
    if (policy.taint !== "enforce" || this.projection().session.approval?.taint != null) return
    const taint = this.taint(policy)
    const first = taint.sources[0]
    if (!taint.tainted || first === undefined) return
    this.write([event("taint.noticed", { source: first, text: describeTaint(taint) })])
  }

  /** Says once per process what the user should know about how this session's tools run. */
  private notice(kind: "sandbox_unavailable" | "approval_ignored" | "checks_not_run", message: string): void {
    if (this.noticed.has(`${kind}:${message}`)) return
    this.noticed.add(`${kind}:${message}`)
    this.ephemeral({ type: "notice", sessionId: this.id, kind, message })
  }

  /** When an execution starts under the configuration just read: what is missing or was not followed, and taint that is not on record yet. */
  private announcePolicy(): void {
    const approvals = this.core.approvals
    if (approvals === null) return
    const { policy, ignored } = this.policy()
    const state = approvals.sandbox().state
    if (!state.available && policy.mode !== "full")
      this.notice(
        "sandbox_unavailable",
        `Commands cannot be sandboxed on this machine: ${state.reason}${state.remedy === null ? "" : `\n${state.remedy}`}\nUntil then every command asks before it runs${this.attended ? "" : ", and with nobody there to ask it is refused"}.`,
      )
    if (ignored.length > 0)
      this.notice("approval_ignored", `The project's configuration asks for a looser approval policy than yours and was not followed: ${ignored.join("; ")}. A project file can only make the policy stricter.`)
    this.noticeTaint()
  }

  /**
   * How the project's checks run. They are commands from a configuration
   * file the repository controls, and the harness runs them without anyone
   * asking for them, so they get what a command of the model gets without a
   * question and no more: the sandbox, with no network and no extra
   * directory, wherever the model's own commands are sandboxed (`ask` and
   * `auto`; `full` once the session is tainted). Where those would have to
   * ask because there is no sandbox, the checks are not run at all, and the
   * user is told. Only `full` runs them unsandboxed.
   */
  private checkRunner(): { readonly blocked: string } | { readonly sandbox: NonNullable<RunCheckOptions["sandbox"]> | undefined } {
    const approvals = this.core.approvals
    if (approvals === null) return { sandbox: undefined }
    const policy = this.policy().policy
    const confined = policy.mode !== "full" || (policy.taint === "enforce" && this.taint(policy).tainted)
    if (!confined) return { sandbox: undefined }
    const state = approvals.sandbox().state
    if (!state.available) return { blocked: state.reason }
    return { sandbox: { sandbox: approvals.sandbox(), run: { network: false, writableRoots: [] }, sessionId: this.id } }
  }

  /** What `tool.settled` records for an outcome of the runtime. */
  private settlement(result: ToolCallOutcome, effect: ToolEffect | undefined, signal: AbortSignal) {
    if (result.kind !== "crashed") return result.settlement
    // A tool that threw while it was being stopped reported nothing: the outcome follows from its effect class.
    if (signal.aborted) {
      const base = { truncation: null, attachments: [], display: null }
      return effect === "read"
        ? { ...base, outcome: "error" as const, output: STOPPED.read }
        : { ...base, outcome: "effect_unknown" as const, output: STOPPED.effectUnknown }
    }
    this.core.report({ kind: "tool_crashed", sessionId: this.id, message: describe(result.error), cause: result.error })
    return result.settlement
  }

  /**
   * One compaction: replaces the older part of the model's view by a
   * checkpoint and keeps the recent part word for word.
   *
   * 1. The cut. `chooseTail` keeps as much recent history as the plan's
   *    budget allows, never splitting a step. It may fall inside the turn in
   *    progress: then the turn's recent steps stay and the checkpoint carries
   *    its request and where the work stands. A normal compaction that would
   *    take out less than a quarter of what is in view is not made: either
   *    nothing happens (the request still fits) or the compaction is
   *    aggressive straight away (it does not).
   * 2. `compaction.started` records the cut, the mode, the size and the
   *    prompt before anything is sent, so the summary request is a function
   *    of the log.
   * 3. The summary request is the step request of the part before the cut
   *    plus that prompt, so it reads that part from the cache. Its answer is
   *    bounded: the stream is cut at twice the summary's limit and the call at
   *    `compactionCallTimeoutMs`.
   * 4. An answer that is not usable (`resolveSummary`) is asked for once
   *    more: the rejected answer and what to fix are recorded
   *    (`compaction.repair_requested`) and appended to the request.
   * 5. It always completes. When there is still no usable summary (invalid
   *    twice, empty, a call that did not end, a part too large to summarise,
   *    a refusal), the checkpoint is built without the model: the identifier
   *    index, the user's messages verbatim and a statement that there is no
   *    summary. Only a provider that cannot be used at all (signed out, the
   *    plan's limit, failing again and again) fails the execution, as it
   *    would fail a step; history is then unchanged.
   *
   * The checkpoint text is rendered once, here, and frozen in
   * `compaction.ended`. Returns `nothing` when there is nothing before the
   * cut to take out, and nothing was written.
   */
  private async compact(run: Run, plan: CompactionPlan): Promise<"compacted" | "nothing" | "done"> {
    const { limits, clock, ids, compaction: config } = this.core
    const signal = run.interrupt.signal
    const start = this.projection()
    const view = selectModelHistory(start).messages
    let mode = plan.mode
    let tail = chooseTail(view, { budget: plan.tailBudget, mandatory: mode === "aggressive" ? "if_fits" : "always" })
    if (mode === "normal" && plan.otherwise !== undefined && tail.removedTokens < config.minFreedRatio * (tail.removedTokens + tail.keptTokens)) {
      // What must be kept (one large tool result, say) is most of the context: a normal compaction would cost a
      // summary call and free too little. While the request still fits, nothing is done; when it does not, the
      // compaction is aggressive at once instead of after a normal one that could not have helped.
      if (plan.otherwise.fits) return "nothing"
      mode = "aggressive"
      tail = chooseTail(view, { budget: plan.otherwise.aggressiveBudget, mandatory: "if_fits" })
    }
    if (tail.nothingToRemove) return "nothing"
    const messageId = ids.message()
    // Nothing kept: the cut is the compaction's own position in the log.
    const keepFromSeq = tail.keepFromSeq ?? start.lastSeq + 1
    this.write(
      [event("compaction.started", { messageId, trigger: plan.trigger, mode, keepFromSeq, prompt: summaryPrompt(), tokensBefore: Math.round(plan.tokensBefore) })],
      { expectedSeq: start.lastSeq },
    )
    this.probe("compaction.started")

    const failed = (error: ProviderError, reason: string): "done" => {
      this.write([
        event("compaction.failed", { messageId, error: { kind: "provider", error } }),
        event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.compaction(reason) }),
      ])
      return "done"
    }
    let usage: Usage | null = null
    let attempt = 1
    /** The first answer, once a repair was asked for. */
    let first: ResolvedSummary | null = null
    let repairing = false
    /** The summary to use and where it is from, or why there is none. */
    let chosen: { readonly summary: string | null; readonly source: "model" | "repaired" | "fallback"; readonly detail: string | null } | null = null

    while (chosen === null) {
      // Built from the log: the cut, the prompt and, the second time, the rejected answer with the request to fix it.
      const request = buildCompactionRequest(this.projection(), this.core.call)
      const blocks = hashRequest(request)
      /** What came back: text (cut short when the loop stopped reading), or why there is none. `final`: not worth asking again. */
      let answer: { readonly text: string; readonly complete: boolean; readonly final: string | null } | null = null
      for (let tries = 1; answer === null; tries += 1) {
        const call = await this.callModel(run, {
          messageId,
          attempt,
          request,
          blocks,
          purpose: "compaction",
          limitMs: limits.compactionCallTimeoutMs,
          maxOutputChars: summaryOutputCapChars(config.summaryMaxTokens),
        })
        // Every call is its own ledger row: the attempts of this compaction count up across retries and the repair.
        attempt += 1
        usage = addUsage(usage, call.usage)
        if (call.end.type === "aborted") {
          this.finishInterrupt(run)
          return "done"
        }
        const written = call.text + call.partialText
        if (call.end.type === "finish") {
          answer = { text: written, complete: !call.overran && call.end.reason !== "length", final: null }
          break
        }
        const error = call.end.error
        // A call that did not end is not asked again (another one would take as long); what it had written may still be a whole summary.
        if (error.kind === "transport" && error.reason === "timeout") answer = { text: written, complete: false, final: COMPACTION_TEXT.timedOut(limits.compactionCallTimeoutMs) }
        else if (error.kind === "context_overflow") answer = { text: "", complete: false, final: COMPACTION_TEXT.tooLarge }
        else if (error.kind === "content_policy") answer = { text: "", complete: false, final: COMPACTION_TEXT.refused }
        else if (error.retryable && tries < limits.attemptBudget) {
          // The log has no retry event for a compaction; the ledger row of each attempt is its record.
          await clock.sleep(retryDelayMs(limits, tries, error, this.core.random), signal)
          if (signal.aborted) {
            this.finishInterrupt(run)
            return "done"
          }
        } else return failed(error, error.retryable ? FAILURE_TEXT.budget(tries, error) : failureText(error))
      }

      const resolved = resolveSummary(answer.text, config.summaryMaxTokens, { complete: answer.complete })
      if (resolved.ok) {
        chosen = { summary: resolved.text, source: repairing ? "repaired" : "model", detail: resolved.salvaged ? COMPACTION_TEXT.repeated : null }
        break
      }
      if (repairing || answer.final !== null || resolved.text === "") {
        chosen = this.settle(first, resolved, repairing, answer.final ?? (resolved.text === "" ? COMPACTION_TEXT.empty : COMPACTION_TEXT.invalid(resolved.problems)))
        break
      }
      // One repair: the answer (its first copy, when the model repeated itself) and what is wrong with it.
      first = resolved
      repairing = true
      this.write([event("compaction.repair_requested", { messageId, attempt, answer: resolved.text, prompt: summaryRepairPrompt(resolved.problems) })])
    }

    const now = this.projection()
    const baseline = now.baseline
    // Every message before the cut that is not excluded, from the whole log: the index and the quotes cover earlier compactions too.
    const earlier = now.messages.filter((message) => message.excluded === null && message.seq < keepFromSeq)
    const checkpoint = buildCheckpoint({ summary: chosen.summary, earlier, inProgress: tail.midTurn })
    const envelope = estimateTokens(`${harnessOpen(CHECKPOINT_ORIGIN)}\n\n${HARNESS_CLOSE}`)
    const fixed = baseline === null ? 0 : estimateTokens(baseline.instructions) + baseline.tools.reduce((sum, tool) => sum + estimateTool(tool), 0)
    const tokensAfter = REQUEST_OVERHEAD + fixed + ITEM_OVERHEAD + envelope + checkpoint.tokens + tail.keptTokens
    this.write([event("compaction.ended", { messageId, summary: checkpoint.text, source: chosen.source, detail: chosen.detail, tokensAfter, usage })])
    this.probe("compaction.ended")
    return "compacted"
  }

  /**
   * What a compaction uses when no answer was valid: the better of the two
   * answers if it is merely too long or lacks a detail (it has every section
   * once, in order, and is bounded), otherwise no summary at all.
   */
  private settle(first: ResolvedSummary | null, second: ResolvedSummary, repaired: boolean, why: string) {
    const usable = (answer: ResolvedSummary | null): answer is Extract<ResolvedSummary, { ok: false }> => answer !== null && !answer.ok && answer.usable
    // The repaired answer wins a tie: it is the one that was asked to be right.
    const candidates = [
      ...(usable(second) ? [{ answer: second, source: repaired ? ("repaired" as const) : ("model" as const) }] : []),
      ...(usable(first) ? [{ answer: first, source: "model" as const }] : []),
    ].sort((a, b) => a.answer.problems.length - b.answer.problems.length)
    const best = candidates[0]
    if (best === undefined) return { summary: null, source: "fallback" as const, detail: why }
    return { summary: best.answer.text, source: best.source, detail: COMPACTION_TEXT.flawed(best.answer.problems) }
  }

  /**
   * Winds the execution down after a requested interrupt, in one append:
   * the visible partial text, one terminal result for every unsettled call,
   * the step closed as interrupted, the marker for the model, the release
   * (cancel rules 3, 4 and 6). With no step open there is nothing to close;
   * a user's cancel still leaves the marker, a shutdown at a boundary cut
   * nothing short and leaves none. `usage` is what the provider reported for
   * the open step's model call, when it reported anything before the stop.
   */
  private finishInterrupt(run: Run, partialText = "", usage: Usage | null = null): void {
    const reason = interruptReasonOf(run.interrupt.signal)
    if (reason === null) throw new Error("the execution is not interrupted")
    const projection = this.projection()
    const execution = claimOf(projection)
    const error = { kind: "interrupted", reason } as const
    const events: NewEvent[] = []
    let cutShort = owesMarker(projection)
    const step = openStep(projection)
    if (step !== null) {
      if (partialText !== "") events.push(event("text.ended", { messageId: step.id, text: partialText, providerData: null }))
      events.push(...settleUnsettled(step, STOPPED), event("step.failed", { messageId: step.id, error, usage }))
      cutShort = true
    }
    const open = projection.session.open
    if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error }))
    // A run of checks that was stopped says nothing about the code.
    if (open?.kind === "checks") events.push(event("checks.failed", { run: open.run, error }))
    if (cutShort || reason === "user")
      events.push(
        note(this.core.ids.message(), HARNESS_ORIGIN.interrupt, reason === "user" ? NOTE_TEXT.interruptedByUser : NOTE_TEXT.interruptedByRestart),
      )
    events.push(event("execution.interrupted", { executionId: execution.id, reason }))
    this.write(events)
    // A call that had started counts as a result, also when it was cut short.
    this.noticeTaint()
  }

  /**
   * The loop itself failed (a bug, a storage error). Closes what is open as
   * an internal failure and releases the claim, so the session is usable
   * again; if even that cannot be written, the claim stays and the next
   * start recovers it as a crash.
   */
  private abandon(run: Run, error: unknown): void {
    this.core.report({ kind: "internal_error", sessionId: this.id, message: describe(error), cause: error })
    try {
      const projection = this.projection()
      const execution = projection.session.execution
      if (execution === null || execution.id !== run.executionId || execution.status !== "running") return
      if (execution.interrupting !== null) {
        if (!run.interrupt.signal.aborted) run.interrupt.interrupt(execution.interrupting)
        return this.finishInterrupt(run)
      }
      const failure = { kind: "internal", message: describe(error) } as const
      const events: NewEvent[] = []
      const step = openStep(projection)
      if (step !== null) events.push(...settleUnsettled(step, STOPPED), event("step.failed", { messageId: step.id, error: failure, usage: null }))
      const open = projection.session.open
      if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error: failure }))
      if (open?.kind === "checks") events.push(event("checks.failed", { run: open.run, error: failure }))
      if (owesMarker(projection)) events.push(note(this.core.ids.message(), HARNESS_ORIGIN.interrupt, NOTE_TEXT.interruptedByRestart))
      events.push(event("execution.failed", { executionId: execution.id, message: FAILURE_TEXT.internal(describe(error)) }))
      this.write(events)
    } catch (second) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `could not close the failed execution: ${describe(second)}`, cause: second })
    }
  }

  // ---- the workspace ----

  /**
   * The tool list a baseline built now freezes: the build's tools, the
   * history tools, and the acknowledgement tool. The acknowledgement tool is
   * in it when verification was not off as the session's first baseline was
   * set, whether or not a check is configured yet, and it stays as it was
   * from then on: a baseline rebuilt after a compaction keeps the decision,
   * so a configuration change in the middle of a session never changes the list.
   */
  private offeredTools(projection: Projection): readonly AnyTool[] {
    const baseline = projection.baseline
    const offered =
      baseline === null
        ? this.config !== null && this.config.config.verify.mode !== "off"
        : baseline.tools.some((tool) => tool.name === ACKNOWLEDGE_TOOL_NAME)
    // The history tools are in every list this build freezes: see `history.ts` for why they are there from the start.
    const tools = [...this.core.tools, ...this.core.history]
    return offered ? [...tools, this.core.acknowledge] : tools
  }

  /** Whether one of the calls this step will run can change files, going by its tool's effect class. */
  private mayChangeFiles(calls: readonly ToolCallPart[], toolChoice: ModelRequest["toolChoice"]): boolean {
    if (toolChoice === "none") return false
    return calls.slice(0, this.core.limits.maxToolCallsPerStep).some((call) => {
      const effect = this.core.effects.get(call.name)
      return effect !== undefined && hasSideEffect(effect)
    })
  }

  /** The snapshots of the working directory, opened on first use. `null` when they are off or cannot be had, which is recorded once. */
  private async snapshots(): Promise<WorkspaceSnapshots | null> {
    const open = this.core.openSnapshots
    if (open === null) return null
    this.snapshotStore ??= open(this.projection().session.cwd).catch(
      (error: unknown): SnapshotUnavailable => ({ kind: "unavailable", reason: "storage_failed", message: describe(error) }),
    )
    const store = await this.snapshotStore
    if (!("reason" in store)) return store
    this.untracked(store.reason, store.message)
    return null
  }

  /** Records that no snapshot can be taken from here on. Once per change: a session that already says so for this reason says nothing more. */
  private untracked(reason: SnapshotUnavailable["reason"] | "snapshot_failed", message: string): void {
    if (this.projection().session.workspace.unavailable?.reason === reason) return
    this.write([event("snapshot.unavailable", { reason, message })])
  }

  /**
   * Takes a snapshot of the workspace and records it, with what it left out
   * when that changed. Returns its ID, or `null` when there is none: a
   * failure never stops the work, it only costs the undo.
   */
  private async snapshot(point: SnapshotPoint, messageId: MessageId | null = null): Promise<string | null> {
    const store = await this.snapshots()
    if (store === null) return null
    const taken = await store.take({ session: this.id }).catch((error: unknown) => describe(error))
    if (typeof taken === "string") {
      this.untracked("snapshot_failed", taken)
      return null
    }
    const coverage = coverageOf(taken)
    const known = this.projection().session.workspace
    const same = canonicalJson(coverage) === canonicalJson({ skipped: known.skipped, nestedRepositories: known.nestedRepositories })
    this.write([event("snapshot.taken", { id: taken.id, point, messageId }), ...(same ? [] : [event("snapshot.coverage", coverage)])])
    return taken.id
  }

  /**
   * Tells whoever watches which files this execution changed, right before
   * it ends: the difference between the snapshot taken when its first input
   * arrived and the latest one. For display; the snapshot IDs are the record.
   */
  private async announceChanges(): Promise<void> {
    if (this.core.openSnapshots === null) return
    const projection = this.projection()
    const to = projection.session.workspace.snapshot?.id
    const from = firstDelivery(this.store.readEvents(this.id, { afterSeq: claimOf(projection).startedSeq }), 0)
    if (to === undefined || from === null || from === to) return
    const store = await this.snapshots()
    const files = await store?.changedFiles(from as SnapshotId, to as SnapshotId).catch(() => null)
    if (files !== undefined && files !== null && files.length > 0) this.ephemeral({ type: "workspace.changes", sessionId: this.id, from, to, files })
  }

  /**
   * Drops the snapshots of this session that the retention policy no longer
   * keeps, in the background, after an execution: never one a revert or an
   * undo could still restore (`neededSnapshots`). A failure costs disk
   * space, nothing else, and is tried again after the next execution.
   */
  private retain(): void {
    if (this.snapshotStore === null || this.retaining !== null || this.closing !== null) return
    const done = retainSnapshots(this.core, this.store, this.id, "active", this.snapshotStore)
      .catch(() => {})
      .finally(() => {
        if (this.retaining === done) this.retaining = null
      })
    this.retaining = done
  }

  /**
   * The directories the session has worked in: where its tool calls read or
   * wrote, going by what each tool says a call touches. Instruction files
   * (AGENTS.md) there are discovered at the next step boundary and appended
   * once, as messages; the frozen baseline is never rewritten. Derived from
   * the calls in the log that are not reverted or refused, so a restart
   * finds the same directories, and a revert forgets the ones only it visited.
   */
  private workedDirectories(projection: Projection): string[] {
    const cwd = projection.session.cwd
    const directories = new Set<string>()
    for (const message of projection.messages) {
      if (message.kind !== "assistant" || message.excluded !== null || message.status === "running") continue
      let touched = this.touched.get(message.id)
      if (touched === undefined) {
        touched = message.parts.flatMap((part) => (part.type === "tool_call" ? this.directoriesOf(part, cwd) : []))
        this.touched.set(message.id, touched)
      }
      for (const directory of touched) directories.add(directory)
    }
    return [...directories].sort()
  }

  /** The directories one call touched: none for a call that never began, or whose tool names no path. */
  private directoriesOf(call: ToolCallPart, cwd: string): string[] {
    const touches = this.core.touches.get(call.name)
    if (touches === undefined || call.state.status !== "settled" || call.state.outcome === "not_started") return []
    try {
      return touches(JSON.parse(call.input)).flatMap((path) => {
        if (typeof path !== "string" || path === "") return []
        const absolute = resolvePath(cwd, path)
        // A directory is itself; a file, or a path that is not there, stands for the directory it is in.
        const info = statSync(absolute, { throwIfNoEntry: false })
        return [info?.isDirectory() ? absolute : dirname(absolute)]
      })
    } catch {
      // Arguments the tool itself refused name nothing.
      return []
    }
  }

  // ---- the verification gate ----

  /**
   * Decides whether the execution may end as done, now that the model has
   * answered and nothing waits. The harness runs the project's checks itself
   * and takes the result as a fact:
   *
   * - no checks configured, or verification off: done, and the event says nothing was verified;
   * - nothing the checks cover changed since they last passed: done;
   * - the checks pass: done, with the evidence;
   * - they fail: the report is appended as a harness message and the model
   *   carries on, until they pass, the model reports with the acknowledgement
   *   tool that it cannot fix them, or it was sent back `maxRounds` times.
   *   Then the execution ends as unresolved, with the reason and the evidence.
   *
   * Everything it decides from is stored state: the latest run of this turn,
   * the reports already sent, the acknowledgement, the snapshots.
   */
  private async gate(run: Run): Promise<GateResult> {
    const signal = run.interrupt.signal
    const loaded = this.config
    const interrupted = (): StepResult => {
      this.finishInterrupt(run)
      return "done"
    }
    const runner = loaded === null || loaded.config.verify.mode === "off" || loaded.config.checks.length === 0 ? null : this.checkRunner()
    if (runner !== null && "blocked" in runner)
      this.notice(
        "checks_not_run",
        `The project's checks were not run: they are commands from the project's configuration, they run only in the sandbox in this mode, and the sandbox is unavailable (${runner.blocked}). Mode full runs them without it.`,
      )
    if (loaded === null || runner === null || "blocked" in runner) {
      await this.announceChanges()
      return signal.aborted ? interrupted() : this.finish(run, { status: "not_configured" })
    }

    // The workspace as it is now: what the checks run against.
    const current = await this.snapshot("checks_start")
    if (signal.aborted) return interrupted()
    const state = this.projection()
    // A steer redirects the model, so nothing is decided now. A queued message waits for this very decision.
    if (state.inbox.some(isSteer) || !wouldGoIdle(state)) return "continue"
    const recorded = state.session.verification.latest
    const latest = recorded !== null && recorded.seq > turnStartSeq(state) ? recorded : null
    const changed = await this.changedSinceVerified(state, current, loaded.projectDir)
    if (signal.aborted) return interrupted()
    // Without a snapshot diff nobody knows which files changed, so every check applies.
    const selected = changed.files === null ? (changed.any ? loaded.config.checks : []) : selectChecks(loaded.config.checks, changed.files)
    const input: GateInput = {
      mode: loaded.config.verify.mode,
      maxRounds: loaded.config.verify.maxRounds,
      selected: selected.map((check) => check.name),
      latest: latest?.evidence.checks ?? [],
      changedSinceLatest:
        latest !== null && (current !== null && latest.snapshot !== null ? current !== latest.snapshot : ranSideEffectsSince(state, latest.seq, this.core.effects)),
      reportsSent: reportsThisTurn(state).length,
      acknowledgement: acknowledgementThisTurn(state),
    }
    const decision = decideGate(input)
    switch (decision.kind) {
      case "run_checks":
        return this.check(run, { loaded, checks: selected, files: changed.files ?? [], filesKnown: changed.files !== null, number: (latest?.run ?? 0) + 1, input })
      case "report_and_continue": {
        // The model stopped again without changing a file and without saying it cannot fix them: the same report again.
        const previous = reportsThisTurn(state).at(-1)
        if (previous === undefined)
          return this.check(run, { loaded, checks: selected, files: changed.files ?? [], filesKnown: changed.files !== null, number: (latest?.run ?? 0) + 1, input })
        this.write([event("synthetic.appended", { messageId: this.core.ids.message(), origin: HARNESS_ORIGIN.checkReport, content: previous.content })])
        return "continue"
      }
      case "finish": {
        await this.announceChanges()
        if (signal.aborted) return interrupted()
        // The latest run of this turn still describes the workspace and nothing in it failed, or nothing needed checking.
        const passed = latest !== null && !input.changedSinceLatest && latest.evidence.checks.every((check) => check.status === "passed")
        return this.finish(run, passed ? { status: "passed", evidence: latest.evidence } : { status: "not_needed" })
      }
      case "finish_unresolved": {
        if (latest === null) throw new Error("the gate left checks unresolved that never ran")
        await this.announceChanges()
        if (signal.aborted) return interrupted()
        return this.finish(run, this.unresolved(decision, input, latest.evidence))
      }
    }
  }

  /**
   * Ends the execution as done with what the gate found, unless input waits:
   * then only `before` is appended (a finished run of checks and its report
   * stay on record). A steer that arrived in the meantime redirects the
   * model, so nothing ended and the loop delivers it. A queued message was
   * waiting for exactly this: the turn may end with `verification`, and the
   * loop writes that (`turn.ended`) together with the delivery.
   */
  private finish(run: Run, verification: VerificationOutcome, before: readonly NewEvent[] = []): GateResult {
    const inbox = this.projection().inbox
    if (inbox.length > 0) {
      if (before.length > 0) this.write(before)
      return inbox.some(isSteer) ? "continue" : { verification }
    }
    this.probe("execution.ending")
    this.write([...before, event("execution.succeeded", { executionId: run.executionId, verification })])
    return "done"
  }

  private unresolved(
    decision: Extract<ReturnType<typeof decideGate>, { kind: "finish_unresolved" }>,
    input: GateInput,
    evidence: VerificationEvidence,
  ): VerificationOutcome {
    return {
      status: "unresolved",
      reason: decision.reason,
      failing: decision.failing,
      acknowledgement: decision.reason === "acknowledged" ? input.acknowledgement : null,
      evidence,
    }
  }

  /**
   * One run of checks. `checks.started` is durable before the first command
   * runs; the results and what the gate decides from them are appended
   * together, so a crash can never leave a finished run without its
   * consequence. Checks are stopped by an interrupt like tools are.
   *
   * A selected check is not run when its last pass still stands: it names
   * what it depends on, and every changed file it depends on is byte for
   * byte what it was when it passed (`reusablePass`). Its result is carried
   * into this run's evidence, marked as carried. In doubt, a check runs.
   */
  private async check(
    run: Run,
    work: {
      readonly loaded: SessionConfig
      /** Every check that applies, in the configuration's order. */
      readonly checks: readonly CheckConfig[]
      readonly files: readonly string[]
      /** Whether `files` comes from a snapshot diff. Without one nobody knows which files changed, and nothing is carried over. */
      readonly filesKnown: boolean
      readonly number: number
      readonly input: GateInput
    },
  ): Promise<GateResult> {
    const signal = run.interrupt.signal
    const { loaded, files, number } = work
    const interrupted = (): StepResult => {
      this.finishInterrupt(run)
      return "done"
    }
    const fingerprints = Object.fromEntries(await Promise.all(work.checks.map(async (item) => [item.name, await fingerprintCheck(item, files, loaded.projectDir)] as const)))
    if (signal.aborted) return interrupted()
    const before = this.projection()
    if (before.inbox.some(isSteer)) return "continue"
    const { latest: recorded, verified } = before.session.verification
    const carried = work.checks.flatMap((item) => {
      const fromSeq = reusablePass({
        check: item,
        fingerprint: fingerprints[item.name] ?? "",
        changedFilesKnown: work.filesKnown,
        // Both runs measured the changed files from the same verified state: no run passed as a whole, and nothing was declared verified, in between.
        sameBaseline: recorded !== null && verified !== null && verified.seq < recorded.seq,
        latest: recorded === null ? null : { seq: recorded.seq, checks: recorded.evidence.checks },
      })
      return fromSeq === null ? [] : [{ check: item, fromSeq }]
    })
    // A run names at least one check. Should every pass still stand, the run that recorded them did not count as
    // passed, which nothing explains: run them all.
    const reused = carried.length === work.checks.length ? [] : carried
    const checks = work.checks.filter((item) => !reused.some((entry) => entry.check === item))
    const runner = this.checkRunner()
    const confined = "sandbox" in runner ? runner.sandbox : undefined
    const [started] = this.write([event("checks.started", { run: number, checks: checks.map((item) => item.name) })])
    this.probe("checks.started")

    const running = this.core
      .runChecks(checks, {
        cwd: loaded.projectDir,
        // Per session: a check's output is written under a working name first, and two sessions may run the same check at once.
        spillDir: join(this.core.spillDir, "checks", this.id),
        signal,
        ...(confined === undefined ? {} : { sandbox: confined }),
        progress: (name, value) => this.ephemeral({ type: "checks.progress", sessionId: this.id, run: number, check: name, text: value }),
      })
      .then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      )
    await untilAborted(running, signal)
    if (signal.aborted) {
      // Cooperative, as with tools: the command saw the abort. Give it time to stop before the run is closed as interrupted.
      const timer = new AbortController()
      await Promise.race([running, this.core.clock.sleep(this.core.limits.toolStopGraceMs, timer.signal)])
      timer.abort()
      return interrupted()
    }
    const outcome = await running
    if ("error" in outcome) throw outcome.error
    this.probe("checks.finished")
    // Files a check itself wrote (a cache, a report) are part of this snapshot, so they never count as the model's change.
    await this.snapshot("checks_end")
    if (signal.aborted) return interrupted()

    const results = outcome.results
    const evidence = buildEvidence({ run: number, afterSeq: started!.seq, changedFiles: files, checks: work.checks, results, fingerprints, reused })
    const finished = event("checks.finished", { run: number, evidence })
    const after = this.projection()
    const input: GateInput = { ...work.input, latest: evidence.checks, changedSinceLatest: false, reportsSent: reportsThisTurn(after).length, acknowledgement: acknowledgementThisTurn(after) }
    const decision = decideGate(input)
    if (decision.kind === "finish" || decision.kind === "finish_unresolved") {
      // The execution is about to end: say what it changed. Nothing the decision rests on can change meanwhile
      // except input arriving, which `finish` looks for.
      await this.announceChanges()
      if (signal.aborted) return interrupted()
    }
    // A check's output is tool output: what the model is shown of it is redacted like any other.
    const secrets = this.core.approvals?.secrets
    const report = () => note(this.core.ids.message(), HARNESS_ORIGIN.checkReport, secrets === undefined ? renderReport(results) : redact(renderReport(results), secrets).text)
    switch (decision.kind) {
      case "finish":
        return this.finish(run, { status: "passed", evidence }, [finished])
      case "report_and_continue":
        this.write([finished, report()])
        return "continue"
      case "finish_unresolved":
        // What the model was not yet shown is appended for whoever continues; an acknowledged failure it already knows.
        return this.finish(run, this.unresolved(decision, input, evidence), [finished, ...(decision.reason === "acknowledged" ? [] : [report()])])
      case "run_checks":
        // A result says it was interrupted although the execution was not: nothing is known, and the gate asks again.
        this.write([finished])
        return "continue"
    }
  }

  /**
   * The files changed since the last verification that passed, relative to
   * the directory checks run in. `files` is `null` when no snapshot diff can
   * say; `any` is then whether a call that can change files ran since.
   */
  private async changedSinceVerified(projection: Projection, current: string | null, projectDir: string): Promise<{ readonly files: string[] | null; readonly any: boolean }> {
    const verified = projection.session.verification.verified
    const store = current === null ? null : await this.snapshots()
    if (store !== null && current !== null && verified !== null && verified.snapshot !== null) {
      if (verified.snapshot === current) return { files: [], any: false }
      const files = await (async () => {
        // Snapshot paths are relative to the session's working directory, `when` patterns to the project directory above it.
        const inside = relative(await realpath(projectDir).catch(() => projectDir), store.workspace)
        const prefix = inside === "" || inside.startsWith("..") ? "" : `${inside.split(sep).join("/")}/`
        return (await store.changedFiles(verified.snapshot as SnapshotId, current as SnapshotId)).map((path) => prefix + path)
      })().catch(() => null)
      if (files !== null) return { files, any: files.length > 0 }
    }
    return { files: null, any: ranSideEffectsSince(projection, verified?.seq ?? 0, this.core.effects) }
  }

  // ---- revert and its undo ----

  /** Runs `work` only if the session is idle, and keeps it idle meanwhile. */
  private whileIdle(work: () => Promise<RevertResult>): Promise<RevertResult> {
    this.assertOpen()
    const projection = this.projection()
    if (this.run !== null || this.restoring !== null || projection.session.execution !== null || projection.session.open !== null)
      return Promise.resolve({ kind: "refused", reason: "busy", message: "the session can be reverted only while it is idle" })
    return this.exclusive(work)
  }

  /** Holds the session for a restore: nothing starts until `work` is over, and input that arrived meanwhile starts then. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const done = (async () => {
      try {
        return await work()
      } catch (error) {
        this.core.report({ kind: "internal_error", sessionId: this.id, message: `the revert failed: ${describe(error)}`, cause: error })
        throw error
      } finally {
        this.restoring = null
        const again = this.restart && this.closing === null
        this.restart = false
        if (again) {
          try {
            this.start()
          } catch (error) {
            this.core.report({ kind: "internal_error", sessionId: this.id, message: describe(error), cause: error })
          }
        }
      }
    })()
    this.restoring = done
    return done
  }

  private async revertTo(options: RevertOptions): Promise<RevertResult> {
    const projection = this.projection()
    const refused = (reason: Extract<RevertResult, { kind: "refused" }>["reason"], message: string): RevertResult => ({ kind: "refused", reason, message })
    const target =
      options.messageId === undefined
        ? projection.messages.findLast((message) => message.kind === "user" && message.excluded === null)
        : projection.messages.findLast((message) => message.id === options.messageId)
    if (target === undefined)
      return options.messageId === undefined ? refused("nothing_to_revert", "there is no turn to go back before") : refused("not_found", `there is no message ${options.messageId}`)
    if (target.kind !== "user" || target.excluded !== null) return refused("not_found", `message ${target.id} is not a user message in the model's history`)
    // A target before a compaction is fine: the range then holds that compaction, and model history goes back to
    // what it was before it (which fit the window when the target was delivered).
    const since = snapshotsSinceDelivery(this.store.readEvents(this.id), target.seq)
    const messages = projection.messages.filter((message) => message.seq >= target.seq && message.excluded === null).length
    return this.restoreTo({ kind: "revert", fromSeq: target.seq, messageId: target.id, messages }, since.target, since.timeline, options, since.timeline[0]?.seq ?? target.seq)
  }

  private async undoLatestRevert(options: Omit<RevertOptions, "messageId">): Promise<RevertResult> {
    const last = this.projection().session.reverts.at(-1)
    if (last === undefined) return { kind: "refused", reason: "nothing_to_revert", message: "there is no revert to undo" }
    // Whatever changed since that revert's restore was changed by hand: nothing else ran.
    const timeline = last.after === null ? [] : [{ id: last.after, point: "restore_end" as const }, ...snapshotsAfter(this.store.readEvents(this.id, { afterSeq: last.seq }), last.seq)]
    return this.restoreTo({ kind: "undo", revertSeq: last.seq, fromSeq: last.fromSeq, messages: last.excluded.length }, last.before, timeline, options, last.seq)
  }

  /**
   * Restores the workspace to `target` and records it with the change to
   * history, or says what would happen. Order of the real thing: look (a dry
   * run, and which of the files it would write were edited by hand since),
   * record the workspace as it is (the undo point), announce the restore
   * durably, restore, record the result together with the change to history.
   */
  private async restoreTo(
    request: RestoreRequest,
    target: string | null,
    timeline: readonly { readonly id: string; readonly point: SnapshotPoint; readonly messageId?: MessageId | null }[],
    options: Omit<RevertOptions, "messageId">,
    /** The `seq` the timeline starts at: since then another session may have worked in the same directory. */
    sinceSeq: number,
  ): Promise<RevertResult> {
    const base = { fromSeq: request.fromSeq, messageId: request.kind === "revert" ? request.messageId : null, messages: request.messages }
    const store = target === null ? null : await this.snapshots()
    if (target === null || store === null) {
      const unrestorable =
        target === null
          ? request.kind === "revert"
            ? "no snapshot of the workspace was taken at that point"
            : "that revert restored no file"
          : `snapshots are unavailable${this.core.openSnapshots === null ? "" : `: ${this.projection().session.workspace.unavailable?.message ?? "the snapshot store could not be opened"}`}`
      const plan: RevertPlan = { ...base, target: null, unrestorable, changes: [], kept: [] }
      // Undoing a revert that restored files restores them too, or does not happen at all.
      if (request.kind === "undo" && target !== null) return { kind: "failed", plan, message: `the revert cannot be undone: ${unrestorable}` }
      if (options.dryRun) return { kind: "preview", plan }
      this.write([
        request.kind === "revert"
          ? event("history.reverted", { fromSeq: request.fromSeq, restore: null })
          : event("history.restored", { revertSeq: request.revertSeq, restore: null }),
      ])
      return { kind: "reverted", plan, restore: null }
    }

    const dry = await store.restore(target as SnapshotId, { session: this.id, dryRun: true }).catch((error: unknown) => describe(error))
    if (typeof dry === "string") return { kind: "failed", plan: null, message: `the workspace cannot be restored: ${dry}` }
    // When the snapshots in between cannot be compared any more, every file counts as possibly edited by hand.
    const edited = await this.ownPathsSince(store, sinceSeq)
      .then((own) => handEditedPaths(store, timeline, dry.before, own))
      .then(
        (paths) => new Set(paths),
        () => null,
      )
    const changes = dry.changes.map((change) => ({ path: change.path, status: change.status, handEdited: edited === null || edited.has(change.path) }))
    const plan: RevertPlan = { ...base, target, unrestorable: null, changes, kept: dry.kept }
    if (dry.kind === "blocked") return { kind: "failed", plan, message: dry.message ?? "git refused the restore" }
    if (options.dryRun) return { kind: "preview", plan }
    const byHand = changes.filter((change) => change.handEdited).map((change) => change.path)
    const policy = options.handEdits ?? "abort"
    if (byHand.length > 0 && policy === "abort") return { kind: "hand_edited", plan }

    const before = await this.snapshot("restore_start")
    if (before === null) return { kind: "failed", plan, message: "the workspace could not be recorded before the restore, so nothing was changed" }
    const keep = policy === "keep" ? byHand : []
    this.write([
      request.kind === "revert"
        ? event("revert.started", { fromSeq: request.fromSeq, target, before, keep })
        : event("revert.undo_started", { revertSeq: request.revertSeq, target, before, keep }),
    ])
    this.probe("revert.started")
    return this.completeRestore(plan)
  }

  /**
   * Whether another session recorded the same working directory since the
   * event at `sinceSeq`, and if so, which paths each stretch of this
   * session's own work wrote itself. Two sessions may work in one directory
   * (that is the user's choice), and then a file that changed while this
   * session's tools ran is not necessarily this session's: only what its
   * calls say they wrote is. A step that ran a command, a run of checks and
   * a restore name no paths, so everything they span counts as possibly the
   * other session's, and the restore asks. `undefined` when this session is
   * alone in the directory: then its own work is all its own, as always.
   */
  private async ownPathsSince(store: WorkspaceSnapshots, sinceSeq: number): Promise<OwnPaths | undefined> {
    if (store.list === undefined) return undefined
    const since = this.store.readEvents(this.id, { afterSeq: sinceSeq - 1, limit: 1 })[0]?.time ?? 0
    // A little before: the two clocks are the same one, read a moment apart.
    const others = (await store.list()).some((ref) => ref.session !== this.id && ref.takenAt >= since - 1000)
    if (!others) return undefined
    const projection = this.projection()
    const cwd = projection.session.cwd
    return (from) => {
      const none = new Set<string>()
      if (from.point !== "step_start" || from.messageId === null || from.messageId === undefined) return none
      const message = projection.messages.findLast((candidate) => candidate.id === from.messageId)
      if (message?.kind !== "assistant") return none
      const own = new Set<string>()
      for (const part of message.parts) {
        if (part.type !== "tool_call" || part.state.status === "pending" || (part.state.status === "settled" && part.state.outcome === "not_started")) continue
        const effect = part.state.status === "running" ? part.state.effect : this.core.effects.get(part.name)
        if (effect === "read") continue
        const touches = this.core.touches.get(part.name)
        // A call that can change anything (a command), or that does not say what it writes: nothing in this step is surely its own.
        if (effect !== "write" || touches === undefined) return none
        try {
          for (const path of touches(JSON.parse(part.input))) own.add(relative(cwd, resolvePath(cwd, path)).split(sep).join("/"))
        } catch {
          return none
        }
      }
      return own
    }
  }

  /**
   * Carries out the restore that the open `revert.started` or
   * `revert.undo_started` announced, from the fields that event recorded, and
   * closes it. A session opened with one still open (the process died in the
   * middle) calls this too: restoring again is harmless, and the undo point
   * is the one recorded before the first attempt.
   */
  private async completeRestore(planned: RevertPlan | null): Promise<RevertResult> {
    const projection = this.projection()
    const open = projection.session.open
    if (open === null || (open.kind !== "revert" && open.kind !== "undo")) throw new Error("no revert is open")
    const plan: RevertPlan = planned ?? {
      fromSeq: open.kind === "revert" ? open.fromSeq : (projection.session.reverts.at(-1)?.fromSeq ?? 1),
      messageId: null,
      messages: 0,
      target: open.target,
      unrestorable: null,
      changes: [],
      kept: [],
    }
    const failed = (message: string): RevertResult => {
      this.write([event("revert.failed", { message })])
      return { kind: "failed", plan, message }
    }
    const store = await this.snapshots()
    if (store === null) return failed("snapshots are unavailable, so the workspace was not restored")
    const target = open.target as SnapshotId
    const kept = new Set(open.keep)
    const result = await (async () => {
      if (kept.size === 0) return store.restore(target, { session: this.id })
      // Everything the restore would write except what is kept, asked again so that a second attempt restores what is left.
      const paths = (await store.restore(target, { session: this.id, dryRun: true })).changes.map((change) => change.path).filter((path) => !kept.has(path))
      return paths.length === 0 ? null : store.restore(target, { session: this.id, paths })
    })().catch((error: unknown) => describe(error))
    if (typeof result === "string") return failed(`the workspace could not be restored: ${result}`)
    if (result?.kind === "blocked") return failed(result.message ?? "git refused the restore; nothing was changed")
    this.probe("revert.restored")
    const after = await this.snapshot("restore_end")
    const left = [...(result?.kept ?? []), ...open.keep.map((path) => ({ path, reason: "hand_edited" as const }))]
    const restore: RestoreRecord = {
      target: open.target,
      before: open.before,
      after,
      changed: result?.changes.length ?? 0,
      kept: left.slice(0, KEPT_LIMIT),
      keptOmitted: Math.max(0, left.length - KEPT_LIMIT),
    }
    this.write([
      open.kind === "revert"
        ? event("history.reverted", { fromSeq: open.fromSeq, restore })
        : event("history.restored", { revertSeq: open.revertSeq, restore }),
    ])
    return { kind: "reverted", plan, restore }
  }

  /**
   * The runtime prefix check (context rule 1): the request about to be sent
   * must be the previous step request plus appended blocks, unless an event
   * appended since allows a break. A violation is a bug in the harness; it
   * is reported, and thrown only in strict mode.
   */
  private checkPrefix(projection: Projection, blocks: readonly BlockHash[]): void {
    const store = this.store
    const last = store.lastRequest(this.id, "step")
    if (last === null) return
    const served = projection.messages.findLast((message) => message.id === last.messageId)
    const since = served === undefined ? [] : store.readEvents(this.id, { afterSeq: served.seq })
    const verdict = checkPrefix(last.blocks, blocks, since)
    if (verdict.status !== "violation") return
    const violation = new PrefixViolationError(this.id, verdict)
    this.core.report({ kind: "prefix_violation", sessionId: this.id, message: violation.message, cause: violation })
    if (this.core.strict) throw violation
  }

  private assistant(messageId: MessageId): AssistantMessage {
    const message = this.projection().messages.findLast((candidate) => candidate.id === messageId)
    if (message?.kind !== "assistant") throw new Error(`step ${messageId} has no assistant message`)
    return message
  }
}

/** The harness config directory, where the user-level AGENTS.md lives: `$XDG_CONFIG_HOME/<brand.directory>`. */
function configDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), brand.directory)
}

/** Turns the store's refusals to hand out a session into the engine's own errors. */
function storeErrors<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof StoreLockedError) throw new EngineError("session_in_use", error.message, error.holderPid)
    if (error instanceof StoreError && (error.code === "session_not_found" || error.code === "ambiguous_session")) throw new EngineError(error.code, error.message)
    throw error
  }
}

/**
 * The retention policy for a session's workspace snapshots.
 *
 * Never removed: every snapshot a revert or an undo of the session could
 * still restore or needs to tell hand edits apart (`neededSnapshots`). Of the
 * rest (the snapshots around steps and checks of older turns, those of
 * history that was compacted away or reverted for good, refs that a crash
 * left unrecorded), a session in use keeps the newest `snapshotKeepLast` and
 * none older than `snapshotMaxAgeMs`; an archived session keeps none. A
 * workspace that did not change is recorded as the same snapshot again and
 * again, and one ref is kept for it.
 *
 * Only this session's refs are looked at, so sessions that share a workspace
 * (and its private git directory) never remove each other's snapshots, and
 * objects stay while any session's ref reaches them. What is needed is read
 * after the refs are listed, so a snapshot recorded while this runs is
 * either not in the list or already protected.
 */
async function retainSnapshots(
  core: Core,
  store: Store,
  id: SessionId,
  mode: "active" | "archived",
  opened?: Promise<WorkspaceSnapshots | SnapshotUnavailable>,
): Promise<void> {
  if (core.openSnapshots === null) return
  const session = store.getSession(id)?.session
  if (session === undefined) return
  // A session that never recorded a snapshot has none to drop, and no reason to set up storage for its directory.
  if (opened === undefined && session.verification.verified === null && session.workspace.snapshot === null) return
  const snapshots = await (opened ?? core.openSnapshots(session.cwd))
  if ("reason" in snapshots || snapshots.prune === undefined) return
  const needed = (): SnapshotId[] => {
    const projection = store.getProjection(id)
    if (projection === null) return []
    // A fork's own events: the snapshots of its inherited history belong to its parent.
    const events = store.readEvents(id, { afterSeq: projection.session.lineage?.throughSeq ?? 0 })
    return neededSnapshots(projection, events) as SnapshotId[]
  }
  await snapshots.prune({
    session: id,
    protect: needed,
    dedupe: true,
    gc: "auto",
    ...(mode === "archived" ? { keepLast: 0 } : { keepLast: core.limits.snapshotKeepLast, olderThanMs: core.limits.snapshotMaxAgeMs }),
  })
}

/** The usage of several calls that served one thing, added up; `null` when none reported any. */
function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total
  if (total === null) return next
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  }
}

const ABORTED = Symbol("aborted")
const TIMED_OUT: unique symbol = Symbol("timed out")

/** A promise that resolves with `ABORTED` when the signal aborts. `dispose` removes its listener. */
function abortedOnce(signal: AbortSignal): { readonly promise: Promise<typeof ABORTED>; readonly dispose: () => void } {
  let dispose = () => {}
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) return resolve(ABORTED)
    const done = () => resolve(ABORTED)
    signal.addEventListener("abort", done, { once: true })
    dispose = () => signal.removeEventListener("abort", done)
  })
  return { promise, dispose }
}

/** Waits for `promise`, or for the abort, whichever is first, and leaves no listener behind. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
    void promise.then(done)
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
