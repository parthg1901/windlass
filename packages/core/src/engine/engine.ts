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
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { AgentDefinition } from "../agents/discover.ts"
import type { CommandDefinition } from "../commands/discover.ts"
import { type BuiltinCommand, type CommandListing, type CommandLookup, listCommands, lookupCommand } from "../commands/lookup.ts"
import { NO_AGENT } from "../agents/definition.ts"
import { type CallVerdict, checkAgentCall, effectiveApprovalMode, unknownToolNames } from "../agents/restrictions.ts"
import { AGENT_KEY, type AgentRecord, agentRecordOf, agentSettings, agentSource, agentSwitch, childAgent, findAgent, resolveStartAgent } from "../agents/use.ts"
import { type Decision, type RunDecision, type SandboxState, decide } from "../approval/decide.ts"
import { type Grant, stampGrants } from "../approval/grants.ts"
import type { McpRegistry } from "../mcp/registry.ts"
import type { SkillSet } from "../skills/discover.ts"
import type { ApprovalPolicy, ApprovalSection, ResolvedApproval } from "../approval/policy.ts"
import type { CallMatch, Divergence } from "../replay/match.ts"
import { type Replay, type ReplayWorkspace, createReplay } from "../replay/replay.ts"
import { type Tape, tapeFromEvents } from "../replay/tape.ts"
import { type CallRun, type ChoiceId, TaintHistory, inheritableTaint } from "../approval/record.ts"
import { redact, unfinishedSecret } from "../approval/redact.ts"
import { type TaintState, deriveTaint, describeTaint } from "../approval/taint.ts"
import { approvedNote, declinedMessage } from "../approval/texts.ts"
import { brand } from "../brand.ts"
import { type LoadedConfig, loadConfig, loadConfigSync } from "../config/load.ts"
import type { CheckConfig } from "../config/schema.ts"
import { text } from "../content.ts"
import { buildCheckpoint } from "../context/checkpoint.ts"
import { ITEM_OVERHEAD, REQUEST_OVERHEAD, type SizeEstimate, estimateNextInput, estimateTokens, estimateTool, estimatorMargin } from "../context/estimate.ts"
import { HISTORY_READ, HISTORY_SEARCH } from "../context/history-tools.ts"
import { type CompactionConfig, type CompactionDecision, DEFAULT_COMPACTION_CONFIG, decideAfterOverflow, decideCompaction, tailBudget } from "../context/policy.ts"
import { type ResolvedSummary, resolveSummary, summaryOutputCapChars, summaryPrompt, summaryRepairPrompt } from "../context/summary.ts"
import { chooseTail } from "../context/tail.ts"
import {
  type CompactionMode,
  type DiagnosticsRecord,
  type EventData,
  type HookEnding,
  type NewEvent,
  type ReplayPolicyKind,
  type WorktreeRecord,
  type RestoreRecord,
  type SessionSettings,
  type SnapshotPoint,
  type StoredEvent,
  type UntrustedInput,
  type VerificationOutcome,
  HARNESS_ORIGIN,
  KEPT_LIMIT,
  WATCH_LIMITS,
  event,
  forkOf,
} from "../event/durable.ts"
import type { EphemeralEvent } from "../event/ephemeral.ts"
import { type CallId, type ExecutionId, type MessageId, type RequestId, type SessionId, newId } from "../id.ts"
import { NO_HOOKS, type HooksConfig } from "../hooks/config.ts"
import { stopRoundsSent } from "../hooks/decide.ts"
import { type HookPointContext, type HookRecord, type ToolCallInput, runAfterHooks, runBeforeHooks, runStopHooks } from "../hooks/points.ts"
import { type HookRunner, createHookRunner } from "../hooks/run.ts"
import { type DiscoveryInput, discoverSources } from "../instructions/discover.ts"
import type { InstructionSource } from "../instructions/source.ts"
import { type AppendedSource, detectAppendedChanges, instructionState, knownAgentsFiles, prepareInstructions } from "../instructions/state.ts"
import { type CallStop, type Interrupt, type InterruptReason, callStopReasonOf, createCallStop, createInterrupt, interruptReasonOf } from "../interrupt.ts"
import type { Json } from "../json.ts"
import type { LspPlan } from "../lsp/config.ts"
import type { LspNotice } from "../lsp/registry.ts"
import { selectModelHistory } from "../message/history.ts"
import { type AssistantMessage, type Projection, type ToolCallPart, hasSideEffect, watchInForce } from "../message/message.ts"
import { reduce } from "../message/reducer.ts"
import { type ProviderError, makeProviderError } from "../provider/error.ts"
import type { FinishReason, Provider, ResponseFacts, StreamEvent } from "../provider/provider.ts"
import { type Usage, sumUsage } from "../provider/usage.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import { type PrefixVerdict, checkPrefix } from "../request/build-break.ts"
import { CHECKPOINT_ORIGIN, type CallOptions, HARNESS_CLOSE, buildCompactionRequest, buildRequest, harnessOpen } from "../request/build.ts"
import { canonicalJson } from "../request/canonical.ts"
import { type BlockHash, hashRequest } from "../request/prefix.ts"
import type { ModelRequest } from "../request/request.ts"
import type { ChangeStatus } from "../snapshot/diff.ts"
import { type KeptPath, type SnapshotId, type SnapshotUnavailable, exportSnapshot, openSnapshots } from "../snapshot/index.ts"
import { StoreLockedError } from "../store/sqlite-lock.ts"
import { type AppendOptions, type RequestPurpose, type SessionQuery, type SessionStores, type SessionSummary, type Store, StoreError, sharedSessionStores } from "../store/store.ts"
import { resolvePath } from "../tools/common.ts"
import { currentTodos, renderTodos } from "../tools/todo.ts"
import { type Authorization, type ToolCall, type ToolCallOutcome, type ToolRuntime, createToolRuntime } from "../tool/runtime.ts"
import type { AnyTool, BackgroundCommand, TempDirectory, ToolContext, ToolEffect, ToolResult } from "../tool/tool.ts"
import { ACKNOWLEDGE_TOOL_NAME, acknowledgeTool } from "../verify/acknowledge.ts"
import { type VerificationEvidence, buildEvidence } from "../verify/evidence.ts"
import { fingerprintCheck, reusablePass } from "../verify/fingerprint.ts"
import { type GateInput, decideGate } from "../verify/gate.ts"
import { renderReport } from "../verify/report.ts"
import { type CheckResult, type RunCheckOptions, runChecks } from "../verify/run.ts"
import { selectChecks } from "../verify/select.ts"
import { type ApprovalSetup, type Approvals, type FactContext, addProjectGrants, aliased, callFacts, effectivePolicy, environmentSecrets, finishOutput, readProjectGrants, realWorkspace, redactor, resolveApprovals, runRecord } from "./approval.ts"
import { type AgentListing, type AgentPlaces, type AgentsSetup, agentIndexAppended, agentPlaces, describeAgentProblem, findAgents } from "./agents.ts"
import { SessionTrace, type TelemetrySetup, type TelemetryState, TelemetryHub } from "./telemetry.ts"
import { type CommandExpansion, type CommandPlaces, type CommandsSetup, type SentCommand, commandPlaces, commandUseOf, expandNamed, findCommands } from "./commands.ts"
import { type EngineEvent, EventChannel } from "./channel.ts"
import { type Clock, systemClock } from "./clock.ts"
import {
  COMPACTION_TEXT,
  ENGINE_LIMITS,
  MANUAL_COMPACTION_TEXT,
  type EngineLimits,
  FAILURE_TEXT,
  INCOMPLETE_STREAM,
  NOTE_TEXT,
  NOTICE_TEXT,
  TOOL_TEXT,
  failureText,
  modelCallTimedOut,
  retryDelayMs,
} from "./constants.ts"
import { historyTools } from "./history.ts"
import { type HooksSetup, type HooksState, approvedHooks, failedHookNotice, hasHooks, hookGrant, hookQuestions, hookRan, sessionHooks, skippedHookNotice } from "./hooks.ts"
import { type HeldRegistry, LspHub, type LspSetup, type LspState, diagnosticsOf, lspGrant, offersDiagnostics, planLanguageServers, readDocument, servesFile, skippedLspServerNotice } from "./lsp.ts"
import { McpHub, type McpServerPlan, type McpSetup, type McpState, type SessionServers, catalogueAppended, engineMcpTools, planServers, serverGrant, serverQuestion, sessionServers, skippedServerNotice } from "./mcp.ts"
import { type MemorySetup, engineMemoryTools, memoryOutcome, memorySource, openSessionMemory, sessionMemoryConfig } from "./memory.ts"
import type { MemoryConfig } from "../memory/config.ts"
import type { MemoryStore } from "../memory/store.ts"
import { type WakeApi, WakeRuntime, type WakeSetup, engineWakeTools, readUserWakeSection, runAllowedNow, sessionWakeConfig } from "./wake.ts"
import type { WakeConfig, WakeConfigSection } from "../wake/config.ts"
import type { Firing } from "../wake/record.ts"
import type { DeliverResult } from "../wake/scheduler.ts"
import { type ConfigFiles, type SkillPlaces, type SkillsSetup, describeSkillProblem, engineSkillTool, findSkills, skillPlaces, skillsSource } from "./skills.ts"
import { recover } from "./recovery.ts"
import { DEFAULT_NORMALISERS, REPLAY_TEXT, type ReplayOutcome, type ReplayRequest, type ReplayRun, changedBaseline, snapshotAtDivergence } from "./replay.ts"
import {
  type ChildResult,
  SPAWN_TEXT,
  SUBAGENT_TOOL,
  type SpawnSettings,
  type SubagentInput,
  childResult,
  type WatchPattern,
  renderChildResult,
  renderCommandEnd,
  renderWatchFired,
  result as toolResult,
  spawnTools,
  taskMessage,
  taskTitle,
  watchMatcher,
  watchedLine,
} from "./spawn.ts"
import { type MergeOutcome, createWorktree, mergeWorktree, removeWorktree, salvageWorktree, worktreeBranch } from "./worktree.ts"
import {
  CANCELLED,
  STOPPED,
  acknowledgementThisTurn,
  atInputBoundary,
  claimOf,
  compactionOutcome,
  currentTurn,
  completedStepSinceCompaction,
  latestSpoken,
  note,
  notedThisTurn,
  openStep,
  owesMarker,
  ranSideEffectsSince,
  refusedTurnStart,
  repeatsItself,
  turnless,
  reportsThisTurn,
  saysNothing,
  settleUnsettled,
  settledBy,
  spawnedWorkEndedThisTurn,
  stepsThisTurn,
  turnBeginning,
  turnInput,
  turnStartSeq,
  workedThisTurn,
  wouldGoIdle,
} from "./state.ts"
import {
  type OpenSnapshots,
  type OwnPaths,
  type WorkspaceSnapshots,
  coverageOf,
  firstDelivery,
  changedInOwnWork,
  editedOutside,
  neededSnapshots,
  snapshotsAfter,
  snapshotsSinceDelivery,
  turnRanges,
} from "./workspace.ts"

// ---------------------------------------------------------------- options

/** Generators for the IDs the loop creates. Tests inject counters. */
export interface EngineIds {
  readonly session: () => SessionId
  readonly message: () => MessageId
  readonly execution: () => ExecutionId
  readonly request: () => RequestId
  /** The handle of a piece of spawned work (a background command, a run of a subagent). */
  readonly spawn: () => string
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
  /** `tool.cancel_requested` is durable; the call's signal has not fired yet. */
  | "call.cancel_requested"
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
  /** A fork's copy of the workspace is made (when it gets one); its session does not exist yet. */
  | "fork.copied"
  /** `spawn.started` is durable; the child session does not exist yet, or the command is running. */
  | "spawn.started"
  /** A subagent's worktree merge is computed; no file of the parent's workspace was written. */
  | "merge.computed"
  /** The first file of a worktree merge was written. */
  | "merge.writing"
  /** A replay left its recording: the copy of the workspace is made and `replay.diverged` is durable; no tool ran in it yet. */
  | "replay.diverged"

export interface EngineHooks {
  readonly probe?: (point: ProbePoint, sessionId: SessionId) => void
}

/** Something the engine noticed that is not part of any session's log. Shown or logged, never stored. */
export interface Diagnostic {
  /**
   * `skills`, `mcp`, `wake`, `memory`, `agents`, `hooks`, `lsp` and `telemetry` are about those features and are for
   * the user to read, never the model: a skill that could not be loaded, a server of the project's that waits for
   * approval, a note file that is invalid, an agent definition that was skipped or names a tool that does not exist,
   * a hook that was skipped, failed or was left unsatisfied, a language server that gave an edit no diagnostics and
   * why, a telemetry section that turns export on and cannot be used. `history` is for the user too: a fork's
   * inherited events cannot be read because the file they are in is gone, so only its own part is shown.
   */
  readonly kind: "prefix_violation" | "internal_error" | "tool_crashed" | "listener_failed" | "skills" | "mcp" | "wake" | "memory" | "agents" | "hooks" | "lsp" | "telemetry" | "history"
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
     * - `unknown_effort`: the model does not offer the reasoning effort; the message names the ones it accepts.
     * - `invalid_request`: what was asked for cannot be done as asked (a fork point inside a step, a replay of a
     *   recording without a step, a prompt for a replay session); the message says why.
     */
    readonly code: "session_not_found" | "ambiguous_session" | "session_in_use" | "closed" | "unknown_model" | "unknown_effort" | "invalid_request",
    message: string,
    readonly holderPid: number | null = null,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

/** One model the provider offers, as `EngineOptions.listModels` reports it. */
export interface ModelOffer {
  readonly id: string
  /** The reasoning efforts the model accepts. Absent or empty: not known, and an effort is not checked. */
  readonly efforts?: readonly string[]
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
  /**
   * Where the directories sessions work in are made when the harness makes
   * them: a fork's copy of a workspace (`workspaces/`), a subagent's git
   * worktree (`worktrees/`), a replay's copy (`replays/`). Defaults to
   * `<dataDir>-work`, beside the data directory and never inside it: the
   * sandbox hides the data directory from commands, and commands must run
   * in these.
   */
  readonly workDir?: string
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
   * The models the provider offers, each by its name or with the reasoning
   * efforts it accepts, for `validateSettings`, `setSettings` and the check
   * the loop makes before it sends a request. Without it, or when the
   * listing fails, a model and an effort are not checked before the first call.
   */
  readonly listModels?: () => Promise<readonly (string | ModelOffer)[]>
  /**
   * `loadConfig` without waiting, for the two things that cannot wait for an
   * execution to read the files: how a session's calls are decided, asked
   * before its first turn (`EngineSession.approval`), and the agent a new
   * session starts as. Defaults to the configuration files when
   * `loadConfig` is the default too; with a `loadConfig` of the caller's and
   * none here (or `null`), nothing is read that way.
   */
  readonly loadConfigSync?: ((cwd: string) => SessionConfig) | null
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
  /**
   * Subagents and background work: the `subagent`, `background_output` and
   * `background_stop` tools in every new session's tool list, and the shell
   * tool's `background` argument carried out. Without it (or `null`) the
   * engine offers none of them. `createHarness` switches it on.
   */
  readonly spawn?: Partial<SpawnSettings> | null
  /**
   * Writes a recorded snapshot of a working directory into another
   * directory: what a fork with a workspace of its own and a replay that
   * runs tools start from. Defaults to the snapshot module's, on
   * `<dataDir>/snapshots`.
   */
  readonly exportSnapshot?: (workspace: string, snapshot: string, into: string) => Promise<{ readonly files: number } | SnapshotUnavailable>
  /**
   * Skills: the `skill` tool in every new session's tool list, and the index
   * of the skills that exist appended to the conversation when it changes
   * (`engine/skills.ts`). Without it (or `null`) the engine offers neither.
   * `createHarness` switches it on.
   */
  readonly skills?: SkillsSetup | null
  /**
   * MCP servers: `mcp_search` and `mcp_call` in every new session's tool
   * list, the configured servers started in the background, and their
   * catalogue appended to the conversation when it changes (`engine/mcp.ts`).
   * Without it (or `null`) the engine offers none of it and starts no
   * server. `createHarness` switches it on.
   */
  readonly mcp?: McpSetup | null
  /**
   * Wake-ups: `wake_create`, `wake_list` and `wake_cancel` in the tool list
   * of every new session a person starts while wake-ups are enabled, and,
   * with `run`, the scheduler and the webhook listener in this process
   * (`engine/wake.ts`). Without it (or `null`) the engine offers none of it.
   * `createHarness` switches the tools on; a long-lived process asks for `run`.
   */
  readonly wake?: WakeSetup | null
  /**
   * Memory, behind its flag (`engine/memory.ts`): for a session a person
   * starts while `memory.enabled` is on in its configuration, the memory
   * tools in its tool list, the notes appended to the conversation, and the
   * outcome of each turn recorded. With the flag off, and without this
   * option (or `null`), nothing of memory exists. `createHarness` passes it,
   * so the flag alone decides.
   */
  readonly memory?: MemorySetup | null
  /**
   * Agents (`engine/agents.ts`): a session can be started as one, switched
   * to one, and can run a subagent as one; the list of agents is appended
   * to the conversation of a session that is offered `subagent`. Without it
   * (or `null`) the engine offers none: the `subagent` tool's `agent`
   * argument, which is in its spec whatever this says, is answered with
   * that. `createHarness` switches it on.
   */
  readonly agents?: AgentsSetup | null
  /**
   * Slash commands (`engine/commands.ts`): a client can list the command
   * files of a session's working directory, look one up, expand it, and
   * send its expansion as the user's message, which the log then says came
   * from that command. Nothing of it reaches the model but the expanded
   * text. Without it (or `null`) the engine offers none. `createHarness`
   * switches it on.
   */
  readonly commands?: CommandsSetup | null
  /**
   * Hooks (`engine/hooks.ts`): the commands a session's configuration names
   * under `hooks` are run before a tool call, after it and when a turn is
   * about to end. Without it (or `null`) no hook is ever run, whatever the
   * configuration says. `createHarness` switches it on. (`hooks`, above, is
   * the engine's own probe for tests.)
   */
  readonly commandHooks?: HooksSetup | null
  /**
   * Language-server diagnostics (`engine/lsp.ts`): the servers a session's
   * configuration names under `lsp` are started when the agent reads or
   * edits a file they serve, and what an edit made worse is added to its
   * result. Without it (or `null`) no server is ever started.
   * `createHarness` switches it on.
   */
  readonly lsp?: LspSetup | null
  /**
   * Live telemetry (`engine/telemetry.ts`): for a session whose user
   * configuration turns `telemetry` on, the spans of its turns (the turn,
   * each model call, each tool call, spawned work, compactions, runs of
   * checks) are sent to the collector that configuration names as the
   * session runs, through a background queue: a collector that is slow,
   * down or wrong costs the queue's memory and nothing else. Nothing is
   * written to the log for it. Without it (or `null`) nothing is ever
   * exported live, whatever the configuration says. `createHarness`
   * switches it on, and the configuration alone then decides.
   */
  readonly telemetry?: TelemetrySetup | null
}

/** How a session is forked. */
export interface ForkOptions {
  /** The last event of the parent the fork inherits, which must be a step boundary. Default: the latest boundary of the parent's log. */
  readonly throughSeq?: number
  /** The fork's model settings. Default: the parent's at the fork point. */
  readonly settings?: SessionSettings
  /** Default: the parent's title. */
  readonly title?: string | null
  /**
   * `shared` (the default): the fork works in the parent's working
   * directory, as two sessions in one directory do. `{ copyTo }`: the
   * workspace is written into a directory of the fork's own and the fork
   * works there: the workspace as it stands when the fork point is the
   * parent's latest state and the parent is idle, otherwise the snapshot
   * that was current at the fork point. Default directory:
   * `<workDir>/workspaces/<fork id>`.
   */
  readonly workspace?: "shared" | { readonly copyTo?: string }
}

/** The configuration an execution runs under: the checks and where they run, and the files' approval sections. */
export type SessionConfig = Pick<LoadedConfig, "config" | "projectDir"> & Partial<Pick<LoadedConfig, "approval" | "files">>

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
  /**
   * The question that waits for an answer, if one does. `child` is set when
   * it is a subagent's question that this session's client answers: the
   * subagent's session and the first line of its task, to label it with.
   */
  readonly pending: {
    readonly messageId: MessageId
    readonly callId: CallId
    readonly question: Extract<Decision, { kind: "ask" }>["question"]
    readonly child?: { readonly sessionId: SessionId; readonly title: string }
  } | null
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
/**
 * Who changed a file a revert would overwrite, outside the session's own
 * work.
 * - `outside`: nothing of any session ran when it changed: the user, or
 *   another program.
 * - `session`: it changed while another session's own tools, checks or
 *   restore ran in the same directory, by that session's snapshots.
 *   `sessionId` is that session, or `null` when more than one session's
 *   work spans the change. (The user may have changed it too.)
 * - `unknown`: it cannot be told. The file changed while this session's own
 *   command, checks or restore ran and another session was recording the
 *   same directory, in none of whose own work the change shows; or the
 *   snapshots in between are gone. It may be this session's own change.
 */
export type EditedBy = { readonly kind: "outside" } | { readonly kind: "session"; readonly sessionId: SessionId | null } | { readonly kind: "unknown" }

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
  /**
   * Every file the restore writes or removes, and whether it was changed
   * outside this session's own work after `target` was taken (`handEdited`:
   * the restore asks before it overwrites one). `editedBy` says who that
   * was, as far as the snapshots tell; it is there exactly when the file
   * is `handEdited`.
   */
  readonly changes: readonly { readonly path: string; readonly status: ChangeStatus; readonly handEdited: boolean; readonly editedBy?: EditedBy }[]
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
/** One page of the session listing (`Engine.listSessionsPage`). */
export interface SessionPage {
  readonly sessions: readonly SessionSummary[]
  /** What to pass as `cursor` for the page after this one; `null` when there is none. */
  readonly nextCursor: string | null
}

export type ResumeMode =
  /** Resume the claim and start working at once. The default. */
  | "start"
  /** Resume the claim (`execution.resumed`) but do no work until `start()` or `send()`. */
  | "claim"
  /** Leave a suspended claim suspended until `start()` or `send()`. */
  | "wait"

/** Input a harness component admits into a session's inbox under an ID of its own choosing (`EngineSession.admit`). */
export interface Admission {
  /**
   * The ID the message will have. It is the admission's idempotency key: an
   * ID this session's log has already admitted (delivered, waiting or
   * withdrawn) is a duplicate and nothing is written.
   */
  readonly messageId: MessageId
  /** The harness component it comes from (`HARNESS_ORIGIN.wake`, ...). The model sees it in an envelope that names it. */
  readonly origin: string
  /** The message, frozen: it is stored as given and never rendered again. */
  readonly text: string
  /**
   * Whether it starts work when the session is idle. Either way it waits
   * behind the turn in progress (inbox delivery `queue`): a harness
   * component never steers a turn.
   */
  readonly start: boolean
  /** Set when the text carries content from outside the harness: a taint source, recorded with the admission. */
  readonly untrusted?: UntrustedInput
}

/** The files one ended turn changed (`Engine.turnChanges`). */
export interface TurnChanges {
  /** The `seq` of the event that ended the turn. */
  readonly endSeq: number
  readonly executionId: ExecutionId
  /** Paths relative to the session's working directory; `null` when no snapshot can tell. */
  readonly files: readonly string[] | null
}

/** What a compaction the user asked for came to (`EngineSession.compact`). */
export type CompactResult =
  /** Done: the older part of the conversation is a checkpoint now. The sizes are the estimates `compaction.started` and `compaction.ended` record. */
  | { readonly kind: "compacted"; readonly tokensBefore: number; readonly tokensAfter: number; readonly source: "model" | "repaired" | "fallback"; readonly detail: string | null }
  /** Nothing was written: there is nothing worth compacting, and `message` says why, for the user. */
  | { readonly kind: "nothing"; readonly message: string }
  /** It did not complete (an interrupt, a provider that cannot be used, the session closed). History is unchanged; `message` says why. */
  | { readonly kind: "failed"; readonly message: string }

export interface SendOptions {
  /** `steer` (the default) is delivered at the next step boundary; `queue` once the session would otherwise go idle. */
  readonly delivery?: "steer" | "queue"
  /** The step limit of the turn this input starts, instead of the engine's. */
  readonly maxSteps?: number
}

/** What a client asks a watch on a background command's output to look for. */
export interface OutputWatchRequest {
  /** Text a line must contain, or with `regex` a regular expression (JavaScript's) a line must match. */
  readonly pattern: string
  readonly regex?: boolean
  readonly ignoreCase?: boolean
  /** How often it may fire. Default 1; at most `WATCH_LIMITS.maxFirings`. */
  readonly limit?: number
}

/** A watch as it was set (`watch.started`), and how often it fired at once, on output the command had already printed. */
export interface OutputWatchSet {
  readonly watchId: string
  readonly spawnId: string
  readonly pattern: string
  readonly regex: boolean
  readonly ignoreCase: boolean
  readonly limit: number
  readonly fired: number
}

/** One of the three things a session runs for the user besides the model's tools, as `EngineSession.onFeatureChange` names them. */
export type SessionFeature = "mcp" | "hooks" | "lsp"

export interface EngineSession {
  readonly id: SessionId
  /**
   * Every event of this session from the moment it was created or opened, in
   * order: durable events as they are appended (recovery's first), ephemeral
   * deltas as they arrive. One consumer. It ends after `close`. A consumer
   * that falls behind never slows the loop down; see `channel.ts`.
   */
  readonly events: AsyncIterable<EngineEvent>
  /**
   * A further consumer, called synchronously with each event from now on.
   * Returns the unsubscribe function. The first one is also given, at once
   * and in order, the diagnostics the session said while nobody was
   * subscribed (a warning about the agent it was created as, said before
   * its creator had the session in hand): they are in no log to read back.
   */
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
   * The slash commands of the session's working directory as they are now:
   * the usable ones, the ones a client's own command hides (`builtins`: the
   * client's commands and their aliases), and what discovery could not use
   * or found shadowed (for a `/commands` listing and a palette). `null`
   * when the engine offers no commands.
   */
  readonly commands: (builtins?: readonly BuiltinCommand[]) => CommandListing | null
  /**
   * Looks a typed name up: a client's own command first, then a command
   * file, exactly and then ignoring case. An unknown name comes back with
   * the close names and the sentence to show (`There is no command /deplyo.
   * Did you mean /deploy? ...`); a file that cannot be used with why.
   * `null` when the engine offers no commands.
   */
  readonly findCommand: (name: string, builtins?: readonly BuiltinCommand[]) => CommandLookup | null
  /**
   * What `/name args` would send, without sending it: the command and its
   * expansion (the text, the positions that were not given, what was left
   * as text and why), or why there is nothing to send. For a palette's
   * preview. `null` when the engine offers no commands.
   */
  readonly expandCommand: (name: string, args: string, builtins?: readonly BuiltinCommand[]) => CommandExpansion | null
  /**
   * `send` for a slash command: the command file of that name is read now,
   * its template is expanded with `args` (what was typed after the name),
   * and the expanded text is admitted as the user's message; `command.expanded`
   * records, in the same append, which file produced it. Nothing in the
   * file is run or read: a command in backticks after `!` and an `@path`
   * stay in the text as written, and the expansion returned here says so
   * for the user. A command that names an `agent` switches the session to
   * it at the boundary where the message is delivered, right before it.
   * Throws `EngineError` `invalid_request`, with the sentence to show the
   * user, and writes nothing, so no request is sent: when there is no such
   * command (it suggests close names), its file cannot be used, its agent
   * cannot be found, or the engine offers no commands.
   */
  readonly sendCommand: (name: string, args: string, options?: SendOptions) => SentCommand & { readonly messageId: MessageId }
  /**
   * Starts working if there is something to do and nothing is running: takes
   * the claim when input waits, or takes up a claim that is suspended or was
   * recovered without being started.
   */
  readonly start: () => void
  /** Asks the running execution to stop, as the user. The request is durable before anything stops. A no-op when idle. */
  readonly interrupt: () => void
  /**
   * Sets a watch on the output of a background command that is running:
   * the model is told, without polling, when the command prints a line that
   * matches. `id` is the command's handle (`spawn.started.spawnId`; the
   * running ones are `projection().session.spawned.running`).
   *
   * The watch is recorded (`watch.started`) and looks at the command's
   * output a line at a time: at once at what is still in memory of what it
   * already printed, then at each further line. A match is a harness
   * message (`background_watch`) admitted in one append with `watch.fired`:
   * it says which command and watch, and quotes the line inside a fence
   * labelled as output, redacted like all command output. It is delivered
   * at the next step boundary and wakes the session if it is idle, exactly
   * as the command's end does. The watch fires at most `limit` times, then
   * ends. One that could still fire when its command ends, or when the
   * command is lost to a restart, is recorded as ended with that reason
   * (`watch.ended`), and the message about the command says so.
   *
   * This is the user's to ask for, through a client: the model has no tool
   * for it, because the tool list is fixed and a command's own output must
   * not be able to arrange for its delivery.
   *
   * Throws `EngineError` `invalid_request`, with the sentence to show the
   * user, and writes nothing: when no such command is running (it ended, or
   * never existed), when `id` names a subagent, when the pattern is empty,
   * too long, has a line break or is not a regular expression, when `limit`
   * is out of range, or when the command already has
   * `WATCH_LIMITS.perCommand` watches that can still fire.
   */
  readonly watchOutput: (id: string, watch: OutputWatchRequest) => OutputWatchSet
  /**
   * Removes a watch that could still fire (`watch.ended`, `removed`).
   * Returns whether there was one: `false` for a watch that has fired as
   * often as it may, has ended, or is unknown.
   */
  readonly unwatchOutput: (watchId: string) => boolean
  /**
   * Stops one running tool call, as the user, and nothing else: the turn
   * goes on. The request is durable first (`tool.cancel_requested`), then
   * the call's own abort signal fires with a reason that says the user
   * stopped this call (`callStopReasonOf(signal) === "call"`). The call
   * settles like any running call, the step carries on with its other calls,
   * and the model reads the result:
   * - a command (`exec`): its process group is stopped, and the result is
   *   what it had printed and a line that says the user stopped it;
   * - a subagent call: the child is interrupted as by its user, and the
   *   result says that it was stopped and quotes its last words;
   * - a read, or a write that cannot be stopped midway: it finishes, and its
   *   result is the ordinary one;
   * - a tool that reports nothing within the stop grace period
   *   (`toolStopGraceMs`), or throws while it is being stopped: the result
   *   follows from the effect class the call started with (`error` for a
   *   read, `effect_unknown` otherwise) and says that the user stopped it.
   *
   * `messageId` names the step when a client has it; without it the call is
   * looked for in the step in progress. `sessionId` names a subagent of this
   * session whose call it is. Returns whether the request was taken: `false`
   * when that call is not running (it has not started, already has its
   * result, or was already asked to stop), when the turn is being
   * interrupted (everything stops then), or in a replay, whose calls are
   * answered from its recording.
   */
  readonly cancelCall: (target: { readonly callId: CallId; readonly messageId?: MessageId; readonly sessionId?: SessionId }) => boolean
  /**
   * Changes the model or the reasoning effort. Takes effect at the next step
   * boundary. Throws `EngineError` (`unknown_model`, `unknown_effort`) when
   * the provider's listing is known and does not offer them: nothing is
   * written and nothing is sent.
   */
  readonly setSettings: (settings: SessionSettings) => void
  /**
   * Sets the session's title (`session.renamed`), at any time. Returns the
   * title as stored: trimmed, with line breaks as spaces. Throws
   * `EngineError` `invalid_request` for a title that is empty.
   */
  readonly rename: (title: string) => string
  /**
   * Compacts the conversation because the user asks: the older part of the
   * model's view is replaced by a checkpoint, exactly as an automatic
   * compaction does it (the same summary request, repair, fallback and
   * events; `compaction.started.trigger` is `manual`), keeping word for
   * word only what the next request has to answer and a short recent tail.
   * It happens at a step boundary: while a turn runs, at the boundary after
   * the step in progress (the turn then carries on from the checkpoint);
   * while idle, under an execution of its own that ends as soon as the
   * checkpoint is written, with no step and no checks. The baseline is set
   * again when the next step is about to be sent. Resolves when it is done,
   * with the sizes before and after; with `nothing` and the reason, and
   * nothing written, when there is nothing worth compacting; with `failed`
   * when it could not complete.
   */
  readonly compact: () => Promise<CompactResult>
  /**
   * The agent the session runs as, or will from its next step on when a
   * switch was asked for and is not applied yet; `null`: none. What the log
   * records is `projection().session.agent`, changed by `agent.switched`.
   */
  readonly agent: () => AgentRecord | null
  /**
   * The agents that can be selected here as they are now, with what
   * discovery could not use and the configured default (for an `/agents`
   * listing). `null` when the engine offers no agents.
   */
  readonly agents: () => AgentListing | null
  /**
   * Switches the session to the agent of that name, or to none with
   * `"none"`. The definition is read now, once, and is what the session
   * runs as until the next switch. While the session is idle the switch is
   * recorded at once (so a crash cannot lose it): before the session's
   * first baseline as the record alone, and the baseline will carry the
   * agent's instructions; later as an appended instruction message and the
   * record. While a turn runs it is made at the next step boundary. Either
   * way `settings.changed` follows at the same boundary when the agent names
   * another model or effort. Returns the record selected.
   * Throws `EngineError` `invalid_request` with a message for the user when
   * there is no such agent (it suggests close names), the engine offers no
   * agents, or the session is a subagent or a replay, which keep what they
   * started as.
   */
  readonly setAgent: (name: string) => AgentRecord | null
  /**
   * Admits input from a harness component (a wake-up's firing) under the
   * message ID it is given. `duplicate`: the session's log already has that
   * ID as an admitted input, so this is a redelivery and nothing was
   * written. Otherwise the input waits in the inbox as a queued item, with
   * its origin, and with `start` work begins if the session is idle (or a
   * suspended execution resumes), unattended unless a client said it attends.
   */
  readonly admit: (input: Admission) => "admitted" | "duplicate"
  /**
   * Withdraws a prompt that was admitted and not delivered yet
   * (`inbox.cancelled`): it never reaches the model. Returns whether it was
   * still waiting; a prompt already delivered, or unknown, is left alone.
   */
  readonly withdraw: (messageId: MessageId) => boolean
  /** The session's stored state. */
  readonly projection: () => Projection
  /**
   * The session's stored events in `seq` order: its whole log, or the part
   * after `afterSeq`. What a client replays to show history. For a fork
   * whose parent's file is gone the inherited events cannot be had: its own
   * events (from its `session.created`) are returned, and the session says
   * once, in a `diagnostic` of kind `history`, what is not shown and which
   * file is missing. The fork's state and what the model sees are whole.
   */
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
   *
   * `children: true` says that this client also answers the questions of
   * the session's subagents: they then arrive as `child.event` items
   * carrying the subagent's `approval.requested`, show as `approval().pending`
   * with `child` set, and are answered through this session's `answer`.
   * Without it a subagent has nobody to ask, whoever watches its parent.
   */
  readonly setAttended: (present: boolean, options?: { readonly children?: boolean }) => void
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
   * it) or offers no such choice. A subagent's question is answered here
   * too; `sessionId` names the subagent (without it the call is looked for
   * in this session first, then in its subagents).
   */
  readonly answer: (target: { readonly messageId: MessageId; readonly callId: CallId; readonly sessionId?: SessionId }, reply: { readonly choice: ChoiceId; readonly note?: string | null }) => boolean
  /** The user says the conversation is trustworthy again (`taint.cleared`). Returns whether the session was tainted. */
  readonly clearTaint: () => boolean
  /**
   * The skills of the session's working directory as they are now, with what
   * discovery could not load (for a `/skills` listing). `null` when the
   * engine offers no skills.
   */
  readonly skills: () => SkillSet | null
  /**
   * The session's MCP servers: the started ones as their registries report
   * them, and the project's servers that wait for the user's approval. As of
   * the configuration the latest execution read; `null` when the engine
   * offers no MCP servers.
   */
  readonly mcp: () => McpState | null
  /**
   * The user approves a server the project's configuration names, by its
   * name (and, to be exact about which definition, the fingerprint the
   * question showed). The approval is remembered for the project and the
   * server starts at once; its tools reach the model with the catalogue at
   * the next step boundary. Returns whether such a server was waiting.
   */
  readonly approveMcpServer: (name: string, fingerprint?: string) => boolean
  /**
   * The session's hooks: the ones in force (the user's, then the project's)
   * and the project's hooks that wait for the user's approval, each with the
   * question to put, word for word. As of the configuration the latest
   * execution read, or, before the first one, as the files are now. `null`
   * when the engine runs no hooks.
   */
  readonly hooks: () => HooksState | null
  /**
   * The user approves a hook the project's configuration names, by the
   * fingerprint the question showed. The approval is remembered for the
   * project, for exactly that definition of the hook, and the hook runs
   * from the next call it applies to. Returns whether such a hook was waiting.
   */
  readonly approveHook: (fingerprint: string) => boolean
  /**
   * The session's language servers: the ones that were started, as their
   * registry reports them, and the project's servers that wait for the
   * user's approval. `null` only when the engine offers no diagnostics. A
   * session whose configuration names no server that could give any (none
   * is named, diagnostics are off, or it is a replay) has a state with
   * `configured: false` and both lists empty.
   */
  readonly lsp: () => LspState | null
  /**
   * The user approves a language server the project's configuration names,
   * by its name (and, to be exact about which definition, the fingerprint
   * the question showed). The approval is remembered for the project and
   * the server starts at the next file it serves. Returns whether such a
   * server was waiting.
   */
  readonly approveLspServer: (name: string, fingerprint?: string) => boolean
  /**
   * One listener for the three: it is called with `mcp`, `hooks` or `lsp`
   * when what `mcp()`, `hooks()` or `lsp()` would return has changed since
   * the listener was added or last called (a server started, failed or
   * stopped, one waits for approval or was approved, the configuration a
   * turn read names other hooks or servers), so a client need not look
   * again on a timer. Two things do not call it: the countdown to an MCP
   * server's next attempt (`retryInMs`), which changes with the clock, and
   * anything after the session was closed. A session whose configuration
   * has not been read yet is taken to have no hooks and no language
   * servers; reading it (a turn starts, or a client asks) calls the
   * listener if it has some. The listener is called in the middle of the
   * change: it should take note and return. Returns the function that
   * removes it.
   */
  readonly onFeatureChange: (listener: (feature: SessionFeature) => void) => () => void
  /**
   * The session's memory, for a client that shows the notes, what waits for
   * the user's confirmation and the review report, and lets the user save,
   * retract, confirm and renew notes (`memory/README.md`, "The user"):
   * its settings and the store of the user's notes and the project's.
   * `null` when the engine offers no memory or the flag is off here.
   * Before the session's first turn it answers from the configuration
   * files as they are now, as the first turn will: a note the user saves
   * then is saved, and nothing reaches the model before that turn's own
   * delivery.
   */
  readonly memory: () => { readonly config: MemoryConfig; readonly store: MemoryStore } | null
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
  /**
   * Creates a session. Its baseline is frozen when its first execution starts.
   *
   * `agent` is the agent it starts as, by name; `"none"` is no agent; absent
   * (or `null`) is the default of the user's own configuration
   * (`agents.default`), if any. The session is created as that agent: its
   * `session.created` has the agent's model and effort where it names them,
   * `agent.switched` follows in the same append, and its first baseline will
   * carry the agent's instructions. Throws `EngineError` and creates nothing
   * when the agent cannot be found or used (`invalid_request`, with a message
   * that suggests close names), or when the provider's listing is known and
   * does not offer the model or the effort (`unknown_model`, `unknown_effort`).
   */
  readonly createSession: (input: { readonly cwd: string; readonly settings: SessionSettings; readonly title?: string | null; readonly agent?: string | null }) => EngineSession
  /**
   * The agents a session in `cwd` could run as, as they are now: the
   * definitions, what could not be used (skipped, shadowed, warnings) and
   * the configured default. Reads the directories and the configuration
   * files; opens nothing. `null` when the engine offers no agents.
   */
  readonly listAgents: (cwd: string) => AgentListing | null
  /**
   * The slash commands a session in `cwd` could use, as they are now, with
   * the ones a client's own command hides and what discovery could not use
   * or found shadowed. Reads the directories and the configuration files;
   * opens nothing. `null` when the engine offers no commands.
   */
  readonly listCommands: (cwd: string, builtins?: readonly BuiltinCommand[]) => CommandListing | null
  /**
   * Opens an existing session. If it holds a claim from a process that died
   * or shut down, it is recovered here, and what happens next is `resume`.
   */
  readonly openSession: (id: SessionId, options?: { readonly resume?: ResumeMode }) => EngineSession
  /**
   * Forks a session at a step boundary into a new session with a file of
   * its own: the parent's history up to that point is its history, and it
   * is typed as a fork in its log. It inherits the parent's baseline,
   * settings, compaction and taint as of that point and the root session's
   * cache key; it starts idle, with an empty inbox and no approvals of its
   * own. The parent is only read, so it may be working in this or another
   * process meanwhile. See `ForkOptions` for the workspace.
   */
  readonly forkSession: (id: SessionId, options?: ForkOptions) => Promise<EngineSession>
  /**
   * Replays a recorded session against a changed baseline: creates a replay
   * session, runs the real model through the loop, and answers every tool
   * call that is on the recording from the recording. See `ReplayRequest`.
   * Rejects with `invalid_request` when the recording cannot be replayed at all.
   */
  readonly replaySession: (id: SessionId, request?: ReplayRequest) => Promise<ReplayRun>
  /** The most recently updated session whose working directory is `cwd`. Never a subagent or a replay. */
  readonly latestSession: (cwd: string) => SessionSummary | null
  /**
   * Sessions, most recently updated first, whoever has them open: by working
   * directory when `cwd` is given, without archived ones unless asked, and
   * without subagents and replays unless asked (`includeSpawned`).
   * Reading only; nothing is opened, held or closed.
   */
  readonly listSessions: (query?: SessionQuery) => readonly SessionSummary[]
  /**
   * The same listing a page at a time: at most `limit` sessions (all of
   * them without one) after the session `cursor` stands for, and the cursor
   * of the page after it, `null` when this was the last. A cursor is the
   * place of the page's last session in the order (when it was last
   * updated, then its ID), so it needs nothing kept between two calls and
   * is not moved by sessions that arrive meanwhile: they are newer, sort
   * before it, and are in no later page; no session is listed twice. A
   * session that is worked in between two pages moves to the front, where a
   * new listing has it. Throws `invalid_request` for a cursor this method
   * did not give.
   */
  readonly listSessionsPage: (query?: SessionQuery & { readonly cursor?: string | null }) => SessionPage
  /** One session's summary, or `null`. Works for a session another process holds. */
  readonly getSession: (id: SessionId) => SessionSummary | null
  /** The session an ID or a unique prefix of one names. Throws `session_not_found` or `ambiguous_session`. */
  readonly resolveSession: (idOrPrefix: string) => SessionId
  /**
   * A session's stored events in `seq` order, without opening it: the log a
   * client replays to show a session it loads. Works for a session another
   * process is working in (it shows what is committed). For a fork whose
   * parent's file is gone a range that reaches into the inherited events
   * throws `invalid_request`, in a sentence that names the parent and the
   * file; `afterSeq` at its fork point reads its own.
   */
  readonly readEvents: (id: SessionId, range?: { readonly afterSeq?: number; readonly limit?: number }) => readonly StoredEvent[]
  /**
   * The files each ended turn of a stored session changed, oldest first,
   * worked out from the snapshots its log records: what differs between the
   * workspace when the turn's input was delivered and the last snapshot
   * before it ended. One entry per turn, keyed by the `seq` of the event
   * that ended it (`turn.ended`, or the execution's terminal event), so a
   * turn that ended because a queued message waited has its own list.
   * `files` is `null` when no snapshot can tell. Each turn that changed
   * something costs a tree comparison, so only the latest `last` turns
   * (default 50) are looked at. Works for any session, open or not.
   */
  readonly turnChanges: (id: SessionId, options?: { readonly last?: number }) => Promise<readonly TurnChanges[]>
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
   * provider offers, when `settings.model` is not one of them, and with
   * `unknown_effort`, naming the efforts the model accepts, when it does not
   * offer `settings.reasoningEffort`. Resolves when both are offered, and
   * also when the engine has no listing or the listing cannot be fetched:
   * then the first model call says what is wrong. The listing is kept, and
   * `createSession` and `setSettings` refuse the same things from it.
   */
  readonly validateSettings: (settings: SessionSettings) => Promise<void>
  /**
   * The wake-ups of this data directory, for a client that lists, creates
   * and cancels them and shows a webhook's secret (never to the model).
   * `null` when the engine offers no wake-ups. Opens the shared store on
   * first use.
   */
  readonly wake: () => WakeApi | null
  /**
   * The collectors live telemetry has sent to in this process, each with
   * what waits to be sent, what was dropped, taken and not taken (header
   * values are never part of it). Empty until a session's configuration
   * turns telemetry on; `null` when the engine exports none.
   */
  readonly telemetry: () => readonly TelemetryState[] | null
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
  readonly dataDir: string
  readonly workDir: string
  /** Subagents and background work; `null` when the build offers none. */
  readonly spawn: SpawnSettings | null
  /** The `subagent` tool, and the tools that read and stop background work. In the runtime always. */
  readonly spawning: { readonly subagent: AnyTool; readonly management: readonly AnyTool[] }
  /** The names of the tools whose calls need no decision and run side by side (`Tool.delegates`). */
  readonly delegating: ReadonlySet<string>
  /** The names of the tools whose result changes without a call of the model's (`Tool.varies`): the identical-call guard does not apply to them. */
  readonly varying: ReadonlySet<string>
  readonly exportSnapshot: (workspace: string, snapshot: string, into: string) => Promise<{ readonly files: number } | SnapshotUnavailable>
  /** Skills: the tool and where the user's own are kept. `null` when the build offers none. */
  readonly skills: { readonly tool: AnyTool; readonly configDir: string; readonly home: string | undefined } | null
  /** MCP: the bridge tools and the registries of the configured servers. `null` when the build offers none. */
  readonly mcp: { readonly tools: readonly AnyTool[]; readonly hub: McpHub } | null
  /** Hooks: what runs a hook's command. `null` when the build runs none. */
  readonly hooks: { readonly runner: HookRunner } | null
  /** Language servers: the registries of the working directories sessions work in. `null` when the build offers no diagnostics. */
  readonly lsp: { readonly hub: LspHub } | null
  /** Where the approvals remembered for a project are kept, also with the approval layer off. */
  readonly grantsDir: string
  /**
   * Wake-ups: the tools, the user's own settings, and the process's store
   * (with its scheduler and listener when this process fires wake-ups),
   * opened on first use. `null` when the build offers none.
   */
  readonly wake: { readonly tools: readonly AnyTool[]; readonly user: WakeConfigSection | undefined; readonly runtime: () => WakeRuntime } | null
  /** Memory: the tools. `null` when the build offers none. Whether a session has them is its configuration's flag. */
  readonly memory: { readonly tools: readonly AnyTool[]; readonly setup: MemorySetup } | null
  /** Agents: where the user's own definitions are kept. `null` when the build offers none. */
  readonly agents: { readonly configDir: string; readonly home: string | undefined } | null
  /** Live telemetry: the queues in front of the collectors sessions send to. `null` when the build exports none. */
  readonly telemetry: TelemetryHub | null
  /** Slash commands: where the user's own command files are kept. `null` when the build offers none. */
  readonly commands: { readonly configDir: string; readonly home: string | undefined } | null
  /** By tool name: the tools that come from an MCP server (`Tool.origin`), whose declared effect an agent's restrictions do not trust. */
  readonly origins: ReadonlyMap<string, "builtin" | "mcp">
  /** Reads the configuration that applies in a directory without waiting; `null` when nothing can be read that way. */
  readonly loadConfigSync: ((cwd: string) => SessionConfig) | null
  /** The provider's models as they were last listed; `null` before the first listing, or without one. */
  readonly offered: () => readonly ModelOffer[] | null
  /** Lists the provider's models and keeps the listing; the last one when that fails. `null`: nobody knows. */
  readonly listOffered: (() => Promise<readonly ModelOffer[] | null>) | null
}

export function createEngine(options: EngineOptions): Engine {
  const clock = options.clock ?? systemClock
  const log = options.log ?? ((line: string) => console.error(line))
  const spillDir = options.spillDir ?? join(options.dataDir, "spill")
  const workDir = options.workDir ?? `${options.dataDir.replace(/\/+$/, "")}-work`
  // A build that brings its own tool of that name keeps it.
  const acknowledge = options.tools.find((tool) => tool.name === ACKNOWLEDGE_TOOL_NAME) ?? (acknowledgeTool() as unknown as AnyTool)
  const stores = "append" in options.store ? sharedSessionStores(options.store) : options.store
  // The history tools read the store of the session that calls them. A build that brings its own tool of one of those names keeps it.
  const history = historyTools((sessionId) => core.sessions.get(sessionId)?.history ?? null).filter((tool) => !options.tools.some((other) => other.name === tool.name))
  // The tools of spawned work are carried out by the session that calls them. A build that brings its own tool of one of those names keeps it.
  const spawning = spawnTools((sessionId) => core.sessions.get(sessionId) ?? null)
  const own = [spawning.subagent, ...spawning.management].filter((tool) => !options.tools.some((other) => other.name === tool.name))
  // The tools of the features an engine may offer are carried out for the session that calls them. As above, a
  // build that brings its own tool of one of those names keeps it.
  const mine = (tools: readonly AnyTool[]) => tools.filter((tool) => !options.tools.some((other) => other.name === tool.name))
  // Where the user's own skills are kept. A caller that supplies the instruction sources itself (`discover`: a
  // test, a fixture) and names no directory gets none from this machine's configuration either: a directory under
  // the data directory, which holds no skills, stands in.
  const skillsDir = options.skills?.configDir ?? (options.discover === undefined ? configDirectory() : join(options.dataDir, "no-user-config"))
  const skill = engineSkillTool((context) => core.sessions.get(context.sessionId)?.skillPlaces() ?? { configDir: skillsDir, extraPaths: [], disabled: [] }) as unknown as AnyTool
  const bridge = engineMcpTools((context) => core.sessions.get(context.sessionId)?.mcpServers() ?? null)
  // Wake-ups: one store per process, opened when something first needs it; the user's own file configures it.
  const wakeUser = options.wake == null ? undefined : (options.wake.config ?? (options.loadConfig === undefined ? readUserWakeSection(configDirectory()).section : undefined))
  let wakeRuntime: WakeRuntime | null = null
  const wakeOf = (): WakeRuntime => {
    if (wakeRuntime !== null) return wakeRuntime
    if (options.wake == null) throw new Error("this engine offers no wake-ups")
    wakeRuntime = new WakeRuntime({
      dataDir: options.dataDir,
      setup: options.wake,
      config: sessionWakeConfig(null, wakeUser),
      sandbox: core.approvals === null ? null : core.approvals.sandbox,
      secrets: () => core.approvals?.secrets ?? [],
      deliver: (firing) => deliverFiring(firing),
      currentRun: (wake) => {
        if (core.approvals === null) return null
        const live = core.sessions.get(wake.sessionId as SessionId)
        if (live !== undefined) return runAllowedNow(wake, live.commandsNow())
        // Not open here (closed, open in another process, or not opened since a restart): decided as it would be
        // if it were, from what is stored. The policy is the one an execution of the session would run under: the
        // user's file and the project's for its working directory, the process's own settings, and the mode of the
        // agent it runs as. Only a choice a client made for the open session (`setApproval`) is not known here.
        try {
          const id = wake.sessionId as SessionId
          const { summary, history } = core.stores.read(id, (store) => ({ summary: store.getSession(id), history: taintHistoryOf(store, id) }))
          if (summary === null) return { refused: "its session no longer exists" }
          const config = core.loadConfigSync === null ? null : core.loadConfigSync(summary.session.cwd)
          const resolved = effectivePolicy({ file: config?.approval?.user ?? null, process: core.approvals.user, session: null, project: config?.approval?.project ?? null }).policy
          const agent = summary.session.agent ?? null
          const mode = agent === null || agent.restrictions.approval === null ? resolved.mode : effectiveApprovalMode(resolved.mode, agent).mode
          // Untrusted content the session itself told the user about counts too: where this process cannot read the
          // configuration the session ran under, the record of the notice is what is left of it.
          const tainted = resolved.taint === "enforce" && (deriveTaint(history.entries, { untrustedPaths: resolved.untrustedPaths }).tainted || summary.session.approval?.taint != null)
          return runAllowedNow(wake, { mode, tainted })
        } catch (error) {
          return { refused: `its session or its configuration could not be read: ${describe(error)}` }
        }
      },
      warn: (message) => core.report({ kind: "wake", sessionId: null, message }),
      sessionOf: (sessionId) => {
        const id = sessionId as SessionId
        // Open here: its own state says where it works, what its configuration allows and what it has taken in.
        const live = core.sessions.get(id)
        let state: SessionSummary["session"]
        let seq: number
        try {
          if (live !== undefined) ({ session: state, lastSeq: seq } = live.projection())
          else {
            const summary = core.stores.read(id, (store) => store.getSession(id))
            if (summary === null) return { refused: `There is no session ${sessionId}.` }
            ;({ session: state, lastSeq: seq } = summary)
          }
        } catch (error) {
          return { refused: error instanceof StoreError && error.code === "session_not_found" ? `There is no session ${sessionId}.` : `The session ${sessionId} could not be read: ${describe(error)}` }
        }
        const lineage = state.lineage
        if (lineage?.kind === "spawn" || lineage?.kind === "replay")
          return { refused: `The session ${sessionId} is ${lineage.kind === "spawn" ? "a subagent" : "a replay"}: a wake-up is for a session a person started.` }
        if (state.archived) return { refused: `The session ${sessionId} is archived: a wake-up could never be delivered to it.` }
        if (live !== undefined) return { cwd: state.cwd, enabled: live.wakeConfig()?.enabled ?? false, tainted: live.commandsNow()?.tainted ?? false, seq }
        // Not open here: its files are read as an execution of it would read them; what it has taken in is decided when a check runs.
        let files: ConfigFiles | null = null
        try {
          files = core.loadConfigSync === null ? null : (core.loadConfigSync(state.cwd).files ?? null)
        } catch (error) {
          return { refused: `The configuration of the session ${sessionId} could not be read: ${describe(error)}` }
        }
        return { cwd: state.cwd, enabled: sessionWakeConfig(files, wakeUser).enabled, tainted: state.approval?.taint != null, seq }
      },
    })
    return wakeRuntime
  }
  const wakeToolset = engineWakeTools({
    runtime: wakeOf,
    now: () => (options.wake?.clock ?? { now: Date.now }).now(),
    tainted: (context) => core.sessions.get(context.sessionId)?.commandsNow()?.tainted ?? false,
    seqOf: (context) => core.sessions.get(context.sessionId)?.projection().lastSeq ?? null,
    configOf: (context) => core.sessions.get(context.sessionId)?.wakeConfig() ?? null,
  })
  const memoryToolset = engineMemoryTools({
    storeOf: (context) => core.sessions.get(context.sessionId)?.memoryStore() ?? null,
    untrusted: (context) => core.sessions.get(context.sessionId)?.commandsNow()?.tainted ?? false,
    projectionOf: (context) => core.sessions.get(context.sessionId)?.projection() ?? null,
    now: () => new Date(clock.now()),
  })
  const features = mine([skill, bridge.search as unknown as AnyTool, bridge.call as unknown as AnyTool, ...wakeToolset, ...memoryToolset])
  // The provider's models, as last listed: what settings are checked against without another request.
  let offered: readonly ModelOffer[] | null = null
  const listOffered = async (): Promise<readonly ModelOffer[] | null> => {
    const listed = await options.listModels!().catch(() => null)
    if (listed !== null && listed.length > 0) offered = listed.map((entry) => (typeof entry === "string" ? { id: entry } : entry))
    return offered
  }
  const runnable = [...options.tools.filter((tool) => tool !== acknowledge), ...history, ...own, ...features, acknowledge]
  // What runs a hook's command: the caller's, or the module's runner with the engine's sandbox and redaction, made when
  // the first hook runs (the sandbox probes the machine once, on first use).
  let hookRunner: HookRunner | null = options.commandHooks?.runner ?? null
  const runHook: HookRunner = (request) =>
    (hookRunner ??= createHookRunner({ spillDir: join(spillDir, "hooks"), ...(core.approvals === null ? {} : { sandbox: core.approvals.sandbox() }), secrets: () => core.approvals?.secrets ?? [] }))(request)
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
      spawn: options.ids?.spawn ?? (() => `bg_${randomBytes(4).toString("hex")}`),
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
    dataDir: options.dataDir,
    workDir,
    spawn: options.spawn == null ? null : { maxDepth: options.spawn.maxDepth ?? 1, worktreeDir: options.spawn.worktreeDir ?? join(workDir, "worktrees") },
    spawning: {
      subagent: runnable.find((tool) => tool.name === SUBAGENT_TOOL)!,
      management: spawning.management.map((tool) => runnable.find((other) => other.name === tool.name)!),
    },
    delegating: new Set(runnable.filter((tool) => tool.delegates === true).map((tool) => tool.name)),
    varying: new Set(runnable.filter((tool) => tool.varies === true).map((tool) => tool.name)),
    exportSnapshot: options.exportSnapshot ?? ((workspace, snapshot, into) => exportSnapshot(workspace, snapshot, into, { dataDir: join(options.dataDir, "snapshots") })),
    skills: options.skills == null ? null : { tool: runnable.find((tool) => tool.name === skill.name)!, configDir: skillsDir, home: options.skills.home },
    mcp:
      options.mcp == null
        ? null
        : {
            tools: [bridge.search, bridge.call].map((tool) => runnable.find((other) => other.name === tool.name)!),
            hub: new McpHub(options.mcp, (server, message) => core.report({ kind: "mcp", sessionId: null, message: `${server}: ${message}` })),
          },
    hooks: options.commandHooks == null ? null : { runner: runHook },
    lsp: options.lsp == null ? null : { hub: new LspHub(options.lsp) },
    grantsDir: options.approval?.grantsDir ?? join(options.dataDir, "approvals"),
    wake: options.wake == null ? null : { tools: wakeToolset.map((tool) => runnable.find((other) => other.name === tool.name)!), user: wakeUser, runtime: wakeOf },
    memory: options.memory == null ? null : { tools: memoryToolset.map((tool) => runnable.find((other) => other.name === tool.name)!), setup: options.memory },
    // As for skills: a caller that supplies the instruction sources itself and names no directory reads none of this machine's.
    agents: options.agents == null ? null : { configDir: options.agents.configDir ?? (options.discover === undefined ? configDirectory() : join(options.dataDir, "no-user-config")), home: options.agents.home },
    telemetry: options.telemetry == null ? null : new TelemetryHub(options.telemetry),
    // As for skills and agents: a caller that supplies the instruction sources itself and names no directory reads none of this machine's.
    commands: options.commands == null ? null : { configDir: options.commands.configDir ?? (options.discover === undefined ? configDirectory() : join(options.dataDir, "no-user-config")), home: options.commands.home },
    origins: new Map(runnable.flatMap((tool) => (tool.origin === undefined ? [] : [[tool.name, tool.origin] as const]))),
    loadConfigSync: options.loadConfigSync !== undefined ? options.loadConfigSync : options.loadConfig === undefined ? (cwd) => loadConfigSync({ cwd }) : null,
    offered: () => offered,
    listOffered: options.listModels === undefined ? null : listOffered,
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

  /** Opens a session that is not open here, repairing what a dead process left (see `recover`). */
  const open = (id: SessionId, resume: ResumeMode): LiveSession => {
    const store = storeErrors(() => core.stores.open(id))
    const session = new LiveSession(core, id, store)
    core.sessions.set(id, session)
    try {
      session.recover(resume)
    } catch (error) {
      core.sessions.delete(id)
      store.close()
      throw error
    }
    return session
  }

  /**
   * Hands a wake-up's firing to its session (`wake/README.md`, "The deliver
   * callback"): the session is opened if it is not open here, the message
   * is admitted under the firing's key, and with delivery `wake` a turn
   * starts. A session this opens only for that is let go of again once it
   * is idle, unless a client took it in the meantime.
   */
  const deliverFiring = async (firing: Firing): Promise<DeliverResult> => {
    if (closing !== null) return { kind: "retry", reason: "this process is shutting down" }
    const id = firing.sessionId as SessionId
    let session = core.sessions.get(id)
    const borrowed = session === undefined
    if (session === undefined) {
      const summary = core.stores.get(id)
      if (summary === null) return { kind: "rejected", reason: "its session no longer exists" }
      if (summary.session.archived) return { kind: "rejected", reason: "its session is archived" }
      try {
        // Nothing of the session's own is started by opening it: only the firing starts work, if it is to.
        session = open(id, "wait")
      } catch (error) {
        if (error instanceof EngineError && error.code === "session_in_use") return { kind: "retry", reason: error.message }
        if (error instanceof EngineError && error.code === "session_not_found") return { kind: "rejected", reason: "its session no longer exists" }
        throw error
      }
    }
    try {
      if (session.projection().session.replay !== undefined) return { kind: "rejected", reason: "its session is a replay, which takes no input" }
      const webhook = firing.source === "webhook"
      const outcome = session.admit({
        messageId: firing.key as MessageId,
        origin: webhook ? HARNESS_ORIGIN.wakeWebhook : HARNESS_ORIGIN.wake,
        text: firing.text,
        start: firing.delivery === "wake",
        ...(firing.untrusted ? { untrusted: { kind: "wake" as const, wakeId: firing.wakeId, carries: webhook ? ("webhook_body" as const) : ("check_output" as const) } } : {}),
      })
      return { kind: outcome }
    } finally {
      if (borrowed) session.letGoWhenIdle()
    }
  }
  // A process that fires wake-ups starts doing so now, not when a session first asks for a tool.
  if (options.wake?.run === true) wakeOf()

  return {
    createSession: (input) => {
      assertOpen()
      // Decided before anything exists: an agent that cannot be used, or settings the provider does not offer, create nothing.
      const start = startAs(core, input)
      const id = core.ids.session()
      const store = storeErrors(() => core.stores.create(id))
      const session = new LiveSession(core, id, store)
      try {
        session.write([
          event("session.created", { cwd: input.cwd, title: input.title ?? null, lineage: null, settings: start.settings }),
          // The session starts as the agent: recorded with it, before its first baseline, which will carry the instructions.
          ...(start.agent === null ? [] : [event("agent.switched", { messageId: null, from: null, to: start.agent })]),
        ])
      } catch (error) {
        store.close()
        throw error
      }
      session.agentDecided = start.decided
      core.sessions.set(id, session)
      for (const warning of start.warnings) session.say("agents", warning)
      return session
    },
    listAgents: (cwd) => {
      if (core.agents === null) return null
      const places = agentPlaces(configFilesNow(core, cwd).files, core.agents)
      return { ...findAgents(cwd, places), default: places.default, ignored: places.ignored }
    },
    listCommands: (cwd, builtins = []) => {
      if (core.commands === null) return null
      return listCommands(findCommands(cwd, commandPlaces(configFilesNow(core, cwd).files, { configDir: core.commands.configDir, ...(core.commands.home === undefined ? {} : { home: core.commands.home }) })), builtins)
    },
    openSession: (id, options$ = {}) => {
      assertOpen()
      const live = core.sessions.get(id)
      // A session the scheduler opened to deliver a firing is the caller's from here on.
      if (live !== undefined) return live.keep()
      return open(id, options$.resume ?? "start")
    },
    forkSession: async (id, fork = {}) => {
      assertOpen()
      return forkSession(core, id, fork)
    },
    replaySession: async (id, request = {}) => {
      assertOpen()
      return replaySession(core, id, request)
    },
    latestSession: (cwd) => listed(core, { cwd, limit: 1 })[0] ?? null,
    listSessions: (query) => listed(core, query),
    listSessionsPage: (query = {}) => {
      const { cursor, limit, ...rest } = query
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new EngineError("invalid_request", `a page holds at least one session: ${String(limit)} is not a page size`)
      const after = cursor == null ? null : pagePlace(cursor)
      // The order is total (two sessions updated in the same millisecond are told apart by ID), so a place in it is a cursor.
      const all = [...listed(core, rest)].sort((a, b) => b.updatedAt - a.updatedAt || (a.session.id < b.session.id ? 1 : a.session.id > b.session.id ? -1 : 0))
      const remaining = after === null ? all : all.filter((summary) => summary.updatedAt < after.updatedAt || (summary.updatedAt === after.updatedAt && summary.session.id < after.id))
      const sessions = limit === undefined ? remaining : remaining.slice(0, limit)
      const last = sessions.at(-1)
      return { sessions, nextCursor: last === undefined || sessions.length === remaining.length ? null : `${last.updatedAt}:${last.session.id}` }
    },
    getSession: (id) => core.stores.get(id),
    resolveSession: (idOrPrefix) => storeErrors(() => core.stores.resolve(idOrPrefix)),
    readEvents: (id, range) => storeErrors(() => core.stores.read(id, (store) => store.readEvents(id, range))),
    turnChanges: async (id, range = {}) => {
      const summary = core.stores.get(id)
      if (summary === null) throw new EngineError("session_not_found", `session ${id} does not exist`)
      // A fork whose parent's file is gone has the turns of its own: the inherited ones were the parent's, with the parent's snapshots.
      const turns = turnRanges(storeErrors(() => core.stores.read(id, (store) => eventsWithoutMissingParent(store, id)))).slice(-(range.last ?? 50))
      // Opened only when a turn has two different snapshots to compare.
      let opened: Promise<WorkspaceSnapshots | null> | null = null
      const snapshots = () =>
        (opened ??= core.openSnapshots === null ? Promise.resolve(null) : core.openSnapshots(summary.session.cwd).then((store) => ("reason" in store ? null : store), () => null))
      const changes: TurnChanges[] = []
      for (const turn of turns) {
        const executionId = turn.executionId as ExecutionId
        if (turn.from === null || turn.to === null) changes.push({ endSeq: turn.endSeq, executionId, files: null })
        else if (turn.from === turn.to) changes.push({ endSeq: turn.endSeq, executionId, files: [] })
        else changes.push({ endSeq: turn.endSeq, executionId, files: (await (await snapshots())?.changedFiles(turn.from as SnapshotId, turn.to as SnapshotId).catch(() => null)) ?? null })
      }
      return changes
    },
    archiveSession: (id) => setArchived(id, true),
    unarchiveSession: (id) => setArchived(id, false),
    validateSettings: async (settings) => {
      if (options.listModels === undefined) return
      const models = await listOffered()
      const problem = models === null ? null : settingsProblem(settings, models)
      if (problem !== null) throw problem
    },
    wake: () => (core.wake === null ? null : core.wake.runtime()),
    telemetry: () => core.telemetry?.state() ?? null,
    close: () => {
      closing ??= (async () => {
        // First nothing new arrives: no firing is delivered, no check runs, the listener is gone.
        await wakeRuntime?.quiesce().catch(() => {})
        await Promise.all([...core.sessions.values()].map((session) => session.close()))
        // Every server the sessions had started is stopped once no session can call one any more.
        await core.mcp?.hub.stop()
        // So is every language server, with its process group.
        await core.lsp?.hub.stop()
        // The spans that are still queued are sent, for a short while at most: a collector that does not answer holds nothing up.
        await core.telemetry?.close()
        wakeRuntime?.close()
      })()
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
  /** `manual`: the user asked for it (`EngineSession.compact`). */
  readonly trigger: "auto" | "overflow" | "manual"
  readonly mode: CompactionMode
  /** Tokens of history to keep word for word (`chooseTail`). */
  readonly tailBudget: number
  /** The size estimate of the request that set it off. */
  readonly tokensBefore: number
  /**
   * For a normal compaction that turns out not to be worth its summary call,
   * because what must be kept is most of the context: whether the request
   * still fits the window (then a compaction that would take out almost
   * nothing is not made), the usable window the request after it is
   * measured against, and the budget of the aggressive compaction that is
   * made instead when a normal one cannot help.
   */
  readonly otherwise?: { readonly fits: boolean; readonly usable: number; readonly aggressiveBudget: number }
}

type StepResult =
  /** The step is closed; the loop decides what comes next. */
  | "continue"
  /** The execution's terminal event was written. */
  | "done"

/**
 * What the gate found: as a step, or the turn may end with `verification` and a queued message is waiting to be
 * delivered. `hooks`: the stop hooks that still objected when the turn had been sent back as often as it may be.
 */
type GateResult = StepResult | TurnEnding

/** How a turn that may end ends: what the gate found, and the stop hooks that were left unsatisfied. */
interface TurnEnding {
  readonly verification: VerificationOutcome
  readonly hooks?: HookEnding
}

/** What the user is told about an agent's settings. */
const AGENT_TEXT = {
  /** `kept`: the settings the agent `left` named that the session still runs with; `next`: the agent it switched to, `null` for none. */
  settingsKept: (left: string, kept: readonly string[], next: string | null) =>
    `The session keeps ${kept.join(" and ")}, which the agent "${left}" set: ${next === null ? "switching the agent off" : `the agent "${next}" names none, and switching to it`} does not put back what the session ran with before. Change the session's model or effort to use another.`,
}

/** What the user is told about history that cannot be read. */
const HISTORY_TEXT = {
  /** `reason`: the store's words, which name the session the history was inherited from and the file that is missing. */
  inheritedMissing: (reason: string) =>
    `The part of this conversation from before the fork cannot be shown: ${reason}. The session still has it, so the model sees it and the session goes on; only what happened since the fork is listed.`,
}

/** How many diagnostics said to nobody a session keeps for its first listener. */
const UNHEARD_DIAGNOSTICS = 64

const isSteer = (item: { readonly delivery: "steer" | "queue" }) => item.delivery === "steer"
/** The events that end an execution's work in a process: done, failed, or interrupted (a shutdown keeps the claim, and still ends the run). */
const isEnding = (item: StoredEvent): item is StoredEvent<"execution.succeeded"> | StoredEvent<"execution.failed"> | StoredEvent<"execution.interrupted"> =>
  item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted"

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

/** The directory, inside a session's temp directory, of tool output kept in full. */
const SPILL_IN_TEMP = ".spill"

/** What `authorize` resolves with when an interrupt ended its wait: the runtime sees the abort and reports the call as not started. */
const WITHDRAWN: Authorization = { kind: "refuse", output: "" }

/** A restore that `restoreTo` is asked for: a revert to before a message, or the undo of the latest revert. */
type RestoreRequest =
  | { readonly kind: "revert"; readonly fromSeq: number; readonly messageId: MessageId; readonly messages: number }
  | { readonly kind: "undo"; readonly revertSeq: number; readonly fromSeq: number; readonly messages: number }

/** A piece of spawned work this process runs: a background command, or one run of a subagent. */
interface LiveSpawn {
  readonly spawnId: string
  readonly background: boolean
  readonly child: LiveSession | null
  /** Where in the child's log this piece of its work begins. */
  readonly fromSeq: number
  /** A subagent that was lost to a restart and is being looked at: its end is on its way, as a message. */
  readonly lost?: boolean
  readonly command: BackgroundCommand | null
  /** Who asked for it to stop, once someone did: an interrupt of this session, its shutdown, the stop tool, or the user stopping the call that waits for it. */
  stopping: "interrupt" | "shutdown" | "tool" | "call" | null
  /** What the model is told about its end, once that is recorded. */
  result: string | null
  /** The watches on a command's output that this process follows, by watch: how to stop following. */
  readonly watches: Map<string, () => void>
  /** Resolves when its end is recorded. */
  readonly done: Promise<void>
}

const STOPPED_BY = { interrupt: "this session was interrupted", shutdown: "the harness shut down", tool: "it was asked to stop", call: "the user stopped this call" } as const

/** The replay a session is, while it runs. Lost with the process: a replay is not taken up again. */
interface Director {
  readonly replay: Replay
  readonly sourceId: SessionId
  /** The events of the recording, for the snapshot a divergence restores. */
  readonly source: readonly StoredEvent[]
  readonly baseline: EventData<"baseline.set">
  /** The copy the replay runs tools in once it left the recording; `null` for the `stop` policy. */
  readonly copy: string | null
  /** Whether the copy's directory was made for this replay: one it never used is removed again. */
  readonly copyMade: boolean
  /** Whether the copy holds the recorded workspace: from the divergence on. */
  live: boolean
  /** The request overrides the model settings, so the recording's own changes of them are not replayed. */
  readonly keepSettings: boolean
  readonly maxSteps: number
  /** How many calls of the step in progress the tape was asked about. */
  asked: number
  readonly resolve: (outcome: ReplayOutcome) => void
}

class LiveSession implements EngineSession {
  private readonly channel = new EventChannel()
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly outbox: EngineEvent[] = []
  private publishing = false
  /**
   * Set from the moment the run of this process writes its execution's
   * ending until that run has let go (`drain`): the ending, and whatever is
   * published after it, reaches readers only then, in order. So a reader
   * that acts on a turn's ending the moment it sees it (an undo, a
   * compaction, a switch of agent) finds the session idle, however many
   * turns of the event loop the loop takes to return.
   */
  private holding = false
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
  /** How to stop each call of the step in progress by itself, by call: fires its signal and starts its grace period. */
  private readonly callStops = new Map<string, () => void>()
  /** The history taint is derived from, built from the log on first use and kept up with every append. A cache of a pure function of the log. */
  private taintHistory: TaintHistory | null = null
  /** The notices already shown in this process, so each is said once. */
  private readonly noticed = new Set<string>()
  /** The diagnostics said while nobody was subscribed, for the first listener that is (`subscribe`). Bounded: a session read only through `events` never takes them. */
  private readonly unheard: EphemeralEvent[] = []
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
  /** Whether the client of this session also answers the questions of its subagents. */
  private childQuestions = false
  /** The spawned work this process runs, by its ID. */
  private readonly spawns = new Map<string, LiveSpawn>()
  /** Ends of spawned work that are still being recorded. Awaited before the session is let go of. */
  private readonly ending = new Set<Promise<void>>()
  /** The child sessions this session started or opened here. Closed with it. */
  private readonly children = new Set<LiveSession>()
  /** Wakes the loop while it waits at a boundary for a subagent's result. */
  private arrival: (() => void) | null = null
  /** The replay this session is, while it runs. */
  private director: Director | null = null
  /** The MCP servers this session holds in the engine's hub, by name, with the key each is let go of by. */
  private readonly mcpHeld = new Map<string, { readonly key: string; readonly registry: McpRegistry; readonly unwatch: () => void }>()
  /** The MCP servers the configuration of the latest execution names, and which of them may start. */
  private mcpPlan: readonly McpServerPlan[] = []
  /** The session's servers as its bridge tools and its catalogue read them. Rebuilt when the held servers change. */
  private mcpBackend: SessionServers | null = null
  /** Whether the servers were read from a configuration in this process: an execution's, or the files as they were when a client first asked. */
  private mcpRead = false
  /** The hooks the configuration of the latest execution names: the user's, then the project's. */
  private hookConfig: HooksConfig = NO_HOOKS
  /** The fingerprints of the project's hooks the user approved, as the remembered approvals had them when the configuration was read. */
  private hookApproved: ReadonlySet<string> = new Set()
  /** Whether the hooks were read from a configuration in this process: an execution's, or the files as they were when a client first asked. */
  private hooksRead = false
  /** The records of the hooks that applied to calls of the step in progress and are not in the log yet, by call. */
  private readonly hookRecords = new Map<string, NewEvent<"hook.ran">[]>()
  /** The language servers the configuration of the latest execution names, and the registry this session holds for them. */
  private lspPlan: LspPlan | null = null
  private lspHeld: HeldRegistry | null = null
  private lspRead = false
  /** Who hears that the MCP servers, the hooks or the language servers changed (`onFeatureChange`). */
  private readonly featureListeners = new Set<(feature: SessionFeature) => void>()
  /** Each of the three as the listeners last heard of it (`featureKey`); set when the first listener is added. */
  private readonly featureSeen: Record<SessionFeature, string> = { mcp: "", hooks: "", lsp: "" }
  /** The text a file had before the write call that is about to change it, by call: what an edit's diagnostics are compared with. `null`: it did not exist. */
  private readonly lspBefore = new Map<string, { readonly path: string; readonly text: string | null }>()
  /** What the language servers said about the calls of the step in progress whose results are not recorded yet, by call. */
  private readonly lspSaid = new Map<string, DiagnosticsRecord>()
  /**
   * Whether the agent this session starts as is decided: when it was
   * created here with its configuration readable, or once its first
   * execution has looked. Until then the default agent of the user's
   * configuration still applies (`startAgent`).
   */
  agentDecided = false
  /** A switch of agent that was asked for and waits for a step boundary: the record to switch to, `null` for none. */
  private pendingAgent: AgentRecord | null | undefined = undefined
  /** Live telemetry of this session: its log as it grows, mapped to spans. `null`: off (not offered, not configured, switched off, or failed). */
  private trace: SessionTrace | null = null
  /** The configuration `trace` was made for: another one (another collector, content on or off) makes another. */
  private traceKey: string | null = null
  /** Whether an execution of this process has read the configuration, or it was looked at ahead of one. */
  private configRead = false
  /** The settings the loop last checked against the provider's listing, so each is checked once. */
  private checkedSettings: string | null = null
  /** Compactions the user asked for that wait for a step boundary: who to tell when it is done. */
  private compactRequests: ((result: CompactResult) => void)[] = []

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
    // What was said before anyone listened is this listener's to hear: once, and before anything newer.
    for (const item of this.unheard.splice(0)) {
      try {
        entry(item)
      } catch (error) {
        this.core.report({ kind: "listener_failed", sessionId: this.id, message: describe(error), cause: error })
      }
    }
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
    if (this.projection().session.replay !== undefined) throw new EngineError("invalid_request", REPLAY_TEXT.noPrompts)
    const messageId = this.core.ids.message()
    if (options.maxSteps !== undefined) this.turnLimits.set(messageId, options.maxSteps)
    this.write([event("inbox.enqueued", { messageId, origin: null, delivery: options.delivery ?? "steer", content: text(value) })])
    this.start()
    return messageId
  }

  queue = (value: string, options: Omit<SendOptions, "delivery"> = {}) => this.send(value, { ...options, delivery: "queue" })

  // ---- slash commands ----

  commands = (builtins: readonly BuiltinCommand[] = []): CommandListing | null => (this.core.commands === null ? null : listCommands(this.commandSet(), builtins))

  findCommand = (name: string, builtins: readonly BuiltinCommand[] = []): CommandLookup | null => (this.core.commands === null ? null : lookupCommand(this.commandSet(), name, builtins))

  expandCommand = (name: string, args: string, builtins: readonly BuiltinCommand[] = []): CommandExpansion | null => (this.core.commands === null ? null : expandNamed(this.commandSet(), name, args, builtins))

  sendCommand = (name: string, args: string, options: SendOptions = {}): SentCommand & { readonly messageId: MessageId } => {
    this.assertOpen()
    const projection = this.projection()
    if (projection.session.replay !== undefined) throw new EngineError("invalid_request", REPLAY_TEXT.noPrompts)
    if (this.core.commands === null) throw new EngineError("invalid_request", "this engine offers no slash commands")
    // The client has run its own commands before it sends: here a name is a command file's, or nothing.
    const found = expandNamed(this.commandSet(), name, args)
    if (found.kind !== "command") throw new EngineError("invalid_request", found.kind === "builtin" ? `/${found.name} is a command of the client's own` : found.message)
    const { command, expansion } = found
    // The agent the command runs under is looked up before anything is written: a miss sends nothing.
    const agent = command.agent === null ? null : this.commandAgent(command, projection)
    const messageId = this.core.ids.message()
    if (options.maxSteps !== undefined) this.turnLimits.set(messageId, options.maxSteps)
    // The user chose an agent with the command: the default of the configuration no longer applies.
    if (agent !== null) this.agentDecided = true
    // One append: the message never waits without the record of where its text came from, nor without the agent it
    // switches the session to where it is delivered. That switch is the log's to keep, not this process's.
    this.write([
      event("inbox.enqueued", { messageId, origin: null, delivery: options.delivery ?? "steer", content: text(expansion.text) }),
      event("command.expanded", { messageId, ...commandUseOf(command, expansion), ...(agent === null ? {} : { agent }) }),
    ])
    this.start()
    return { messageId, command, expansion }
  }

  /** The commands of this session's working directory as they are now. */
  private commandSet() {
    const commands = this.core.commands
    const places: CommandPlaces = commandPlaces(this.files(), { configDir: commands?.configDir ?? configDirectory(), ...(commands?.home === undefined ? {} : { home: commands.home }) })
    return findCommands(this.projection().session.cwd, places)
  }

  /** The definition of the agent a command names, read now, once. Throws with the sentence for the user when it cannot be used. */
  private commandAgent(command: CommandDefinition, projection: Projection): AgentRecord {
    const under = `The command /${command.name} (${command.path}) runs under the agent "${command.agent}"`
    if (this.core.agents === null) throw new EngineError("invalid_request", `${under}, and this engine offers no agents.`)
    if (projection.session.lineage?.kind === "spawn") throw new EngineError("invalid_request", `${under}, and a subagent keeps the agent it started as.`)
    const places = this.agentPlaces()
    const found = findAgent(findAgents(projection.session.cwd, places), command.agent!, places.disabled)
    if (!found.ok) throw new EngineError("invalid_request", `${under}. ${found.message}`)
    return agentRecordOf(found.agent)
  }

  admit = (input: Admission): "admitted" | "duplicate" => {
    this.assertOpen()
    if (this.projection().session.replay !== undefined) throw new EngineError("invalid_request", REPLAY_TEXT.noPrompts)
    if (this.admitted(input.messageId)) {
      // A redelivery. If the process before this one died between the admission and the start it was to make, the
      // message still waits and the work is started now; `start` does nothing when it is under way or nothing waits.
      if (input.start && this.projection().inbox.some((item) => item.messageId === input.messageId)) this.start()
      return "duplicate"
    }
    // The fact that makes it untrusted is a field of the admission itself: one event, so never one without the other.
    this.write([event("inbox.enqueued", { messageId: input.messageId, origin: input.origin, delivery: "queue", content: text(input.text), ...(input.untrusted === undefined ? {} : { untrusted: input.untrusted }) })])
    // Untrusted content is in the session from here on: the user is told now, and the turn it starts is decided under it.
    if (input.untrusted !== undefined) this.noticeTaint()
    if (input.start) this.start()
    return "admitted"
  }

  /**
   * Whether the log has admitted input under this ID: as a message, as an
   * item that waits, or as one that was withdrawn (which the projection
   * forgets, and a redelivery must still not bring back).
   */
  private admitted(messageId: MessageId): boolean {
    const projection = this.projection()
    if (projection.messages.some((message) => message.id === messageId) || projection.inbox.some((item) => item.messageId === messageId)) return true
    // A fork looks at its own events: what it inherited of its parent's inbox is the delivered messages, which are its rows.
    return ownEvents(this.store, this.id).some((item) => item.type === "inbox.enqueued" && item.data.messageId === messageId)
  }

  /** Whether the session was opened here only to hand it a wake-up's firing, and nobody else has taken it since. */
  private borrowed = false

  /** A client asked for this session: it stays open until the client closes it. */
  keep(): this {
    this.borrowed = false
    return this
  }

  /** Opened only for a firing: the session is let go of once its work is done, so that any process can open it again. */
  letGoWhenIdle(): void {
    this.borrowed = true
    void this.settled().then(() => {
      if (this.borrowed && this.run === null && this.closing === null) void this.close()
    })
  }

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
    // What the provider is known not to offer is refused here: nothing is written, and no request is spent on it.
    const models = this.core.offered()
    const problem = models === null ? null : settingsProblem(settings, models)
    if (problem !== null) throw problem
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

  readEvents = (range?: { readonly afterSeq?: number; readonly limit?: number }): readonly StoredEvent[] => {
    try {
      return this.store.readEvents(this.id, range)
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== "parent_missing") throw error
      // A fork whose parent's file is gone: its own events are what there is to read. The user is told, once, what is not shown.
      this.say("history", HISTORY_TEXT.inheritedMissing(error.message))
      return this.store.readEvents(this.id, { ...range, afterSeq: Math.max(range?.afterSeq ?? 0, forkOf(this.projection().session.lineage)?.throughSeq ?? 0) })
    }
  }

  settled = async (): Promise<void> => {
    while (this.run !== null || this.restoring !== null) await (this.run?.done ?? this.restoring?.catch(() => {}))
  }

  setAttended = (present: boolean, options: { readonly children?: boolean } = {}): void => {
    this.attended = present
    if (options.children !== undefined) this.childQuestions = options.children
    // A subagent asks through its parent's client, or nobody.
    for (const child of this.children) child.setAttended(present && this.childQuestions, { children: this.childQuestions })
  }

  setApproval = (section: ApprovalSection): void => {
    this.override = { ...this.override, ...section }
    for (const child of this.children) child.setApproval(section)
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
      pending: pending === null ? this.childQuestion() : { messageId: pending.messageId, callId: pending.callId, question: pending.asked.question },
    }
  }

  /** The question of a subagent that this session's client is to answer, labelled with the subagent it is from. */
  private childQuestion(): NonNullable<ApprovalState["pending"]> | null {
    for (const child of this.children) {
      const pending = child.closing === null ? (child.approval()?.pending ?? null) : null
      if (pending === null) continue
      return pending.child === undefined ? { ...pending, child: { sessionId: child.id, title: child.projection().session.title ?? child.id } } : pending
    }
    return null
  }

  answer = (target: { readonly messageId: MessageId; readonly callId: CallId; readonly sessionId?: SessionId }, reply: { readonly choice: ChoiceId; readonly note?: string | null }): boolean => {
    this.assertOpen()
    const approvals = this.core.approvals
    const pending = this.question
    const mine = target.sessionId === undefined || target.sessionId === this.id
    if (!mine || pending === null || pending.messageId !== target.messageId || pending.callId !== target.callId) {
      // Not this session's question: one of its subagents', asked through this session's client.
      if (target.sessionId === this.id) return false
      return [...this.children].some((child) => child.closing === null && child.answer(target, reply))
    }
    if (approvals === null) return false
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

  rename = (title: string): string => {
    this.assertOpen()
    const next = title.replace(/\s+/g, " ").trim()
    if (next === "") throw new EngineError("invalid_request", "a session's title cannot be empty")
    if (this.projection().session.title !== next) this.write([event("session.renamed", { title: next })])
    return next
  }

  compact = async (): Promise<CompactResult> => {
    this.assertOpen()
    const projection = this.projection()
    if (projection.session.replay !== undefined) return { kind: "nothing", message: MANUAL_COMPACTION_TEXT.replay }
    if (this.restoring !== null) return { kind: "failed", message: MANUAL_COMPACTION_TEXT.reverting }
    if (this.run === null) {
      // Idle: said at once when there is nothing to do, so that no execution is started for it.
      const worth = await this.worthCompacting()
      if (worth.kind !== "plan") return worth
      if (this.closing !== null) return { kind: "failed", message: MANUAL_COMPACTION_TEXT.closed }
    }
    const done = new Promise<CompactResult>((resolve) => this.compactRequests.push(resolve))
    // A turn that runs compacts at its next boundary. Otherwise an execution is started (or a suspended one taken
    // up) whose first boundary does: a compaction is written under a claim, like everything that changes history.
    if (this.run === null && this.restoring === null) {
      const execution = this.projection().session.execution
      if (execution === null) {
        const executionId = this.core.ids.execution()
        this.write([event("execution.started", { executionId })])
        this.launch(executionId)
      } else this.start()
    }
    return done
  }

  /**
   * Whether a compaction the user asks for would take enough out of the
   * model's view, and the plan of one that would. It keeps what the next
   * request has to answer and, where the window is known, the short tail an
   * aggressive compaction keeps: the user asked for room.
   */
  private async worthCompacting(): Promise<{ readonly kind: "plan"; readonly plan: CompactionPlan } | Extract<CompactResult, { kind: "nothing" }>> {
    const start = this.projection()
    if (start.baseline === null) return { kind: "nothing", message: MANUAL_COMPACTION_TEXT.nothingYet }
    const window = await this.contextWindow(start.session.settings.model)
    const projection = this.projection()
    const prepared = this.prepare(projection, "auto")
    const budget = window === null ? 0 : this.aggressiveBudget(prepared, window)
    const tail = chooseTail(selectModelHistory(projection).messages, { budget, mandatory: "always" })
    if (tail.nothingToRemove) return { kind: "nothing", message: MANUAL_COMPACTION_TEXT.nothingToRemove }
    const minimum = this.core.limits.manualCompactionMinTokens
    if (tail.removedTokens < minimum) return { kind: "nothing", message: MANUAL_COMPACTION_TEXT.tooSmall(Math.round(tail.removedTokens), minimum) }
    return { kind: "plan", plan: { trigger: "manual", mode: "normal", tailBudget: budget, tokensBefore: this.measure(prepared).total } }
  }

  /**
   * At a step boundary, under the claim: makes the compaction the user
   * asked for and tells whoever asked. Returns what the loop does next:
   * `done` when the execution's terminal event was written.
   */
  private async compactOnRequest(run: Run): Promise<"compacted" | "nothing" | "done"> {
    const waiting = this.compactRequests.splice(0)
    const answer = (result: CompactResult) => {
      for (const resolve of waiting) resolve(result)
    }
    try {
      const worth = await this.worthCompacting()
      if (run.interrupt.signal.aborted) {
        answer({ kind: "failed", message: MANUAL_COMPACTION_TEXT.interrupted })
        this.finishInterrupt(run)
        return "done"
      }
      if (worth.kind !== "plan") {
        answer(worth)
        return "nothing"
      }
      const outcome = await this.compact$(run, worth.plan)
      const made = this.projection().messages.findLast((message) => message.kind === "compaction")
      if (outcome === "compacted" && made?.kind === "compaction" && made.status === "completed")
        answer({ kind: "compacted", tokensBefore: made.tokensBefore, tokensAfter: made.tokensAfter ?? 0, source: made.source ?? "model", detail: made.detail })
      else if (outcome === "nothing") answer({ kind: "nothing", message: MANUAL_COMPACTION_TEXT.nothingToRemove })
      else answer({ kind: "failed", message: run.interrupt.signal.aborted ? MANUAL_COMPACTION_TEXT.interrupted : MANUAL_COMPACTION_TEXT.ended(lastExecutionFailure(ownEvents(this.store, this.id)) ?? "the summary could not be had") })
      return outcome
    } catch (error) {
      answer({ kind: "failed", message: MANUAL_COMPACTION_TEXT.ended(describe(error)) })
      throw error
    }
  }

  agent = (): AgentRecord | null => (this.pendingAgent !== undefined ? this.pendingAgent : (this.projection().session.agent ?? null))

  agents = (): AgentListing | null => {
    if (this.core.agents === null) return null
    const places = this.agentPlaces()
    return { ...findAgents(this.projection().session.cwd, places), default: places.default, ignored: places.ignored }
  }

  setAgent = (name: string): AgentRecord | null => {
    this.assertOpen()
    const projection = this.projection()
    if (projection.session.replay !== undefined) throw new EngineError("invalid_request", "a replay session runs as its recording did: its agent is not switched")
    if (projection.session.lineage?.kind === "spawn") throw new EngineError("invalid_request", "a subagent keeps the agent it started as")
    if (this.core.agents === null) throw new EngineError("invalid_request", "this engine offers no agents")
    let next: AgentRecord | null = null
    if (name.trim().toLowerCase() !== NO_AGENT) {
      const places = this.agentPlaces()
      const found = findAgent(findAgents(projection.session.cwd, places), name, places.disabled)
      if (!found.ok) throw new EngineError("invalid_request", found.message)
      next = agentRecordOf(found.agent)
    }
    this.pendingAgent = next
    this.agentDecided = true
    // The session is idle: the switch is recorded now, so that it is in the log whatever happens to this process.
    // Before the first baseline that is the record alone, and the baseline will carry the agent; after it, the
    // message that tells the model and the record. While a turn runs (or a claim waits to be taken up again), the
    // loop makes the switch at its next step boundary.
    if (this.run === null && this.restoring === null && projection.session.open === null && projection.session.execution === null) this.applyAgentSwitch()
    return next
  }

  /** Where this session's agents are looked for, and what its configuration says about them. */
  private agentPlaces(): AgentPlaces {
    const agents = this.core.agents
    return agentPlaces(this.files(), { configDir: agents?.configDir ?? configDirectory(), ...(agents?.home === undefined ? {} : { home: agents.home }) })
  }

  /**
   * Makes the switch that waits: `agent.switched`, and, once the baseline is
   * frozen, the instruction message that tells the model, in one append;
   * then the agent's model and effort, as a settings change at the same
   * boundary. It is made at a step boundary: by `setAgent` itself while
   * nothing is being worked on, by the loop while a turn runs.
   */
  private applyAgentSwitch(): void {
    const next = this.pendingAgent
    this.pendingAgent = undefined
    if (next === undefined) return
    const projection = this.projection()
    const current = projection.session.agent ?? null
    const from = current?.name ?? null
    if (projection.baseline === null) {
      if (canonicalJson(current) === canonicalJson(next)) return
      this.write([event("agent.switched", { messageId: null, from, to: next })])
    } else {
      const update = agentSwitch(current, next)
      // The same agent with the same definition: nothing to tell the model, nothing to record.
      if (update === null) return
      const messageId = this.core.ids.message()
      this.write([
        event("instruction.appended", { messageId, source: AGENT_KEY, text: update.text, fingerprint: update.fingerprint }),
        event("agent.switched", { messageId, from, to: next }),
      ])
    }
    if (next !== null) {
      for (const warning of agentWarnings(this.core, next)) this.say("agents", warning)
      const models = this.core.offered()
      const settings = agentSettings(next, this.projection().session.settings, models?.map((model) => model.id))
      for (const note of settings.notes) this.say("agents", note)
      const problem = !settings.changed || models === null ? null : settingsProblem(settings.settings, models)
      if (problem !== null) this.say("agents", `The agent "${next.name}" was selected with the session's own settings: ${problem.message}.`)
      else if (settings.changed) this.changeSettings(settings.settings)
    }
    this.saySettingsKept(current, next)
  }

  /**
   * Tells the user what stays of the agent the session just left. An agent
   * that names a model or an effort changes the session's, and leaving it
   * does not change them back: what the session ran with before is not
   * always in its log (one that started as the agent never had other
   * settings), and a change of model costs the provider's cache, so the
   * engine does not guess. It says so each time, since the user asked for
   * the switch each time.
   */
  private saySettingsKept(left: AgentRecord | null, next: AgentRecord | null): void {
    if (left === null) return
    const settings = this.projection().session.settings
    const kept = [
      ...(left.model !== null && settings.model === left.model && (next === null || next.model === null) ? [`the model "${left.model}"`] : []),
      ...(left.effort !== null && settings.reasoningEffort === left.effort && (next === null || next.effort === null) ? [`the reasoning effort "${left.effort}"`] : []),
    ]
    if (kept.length === 0) return
    this.core.report({ kind: "agents", sessionId: this.id, message: AGENT_TEXT.settingsKept(left.name, kept, next?.name ?? null) })
  }

  /**
   * The agent a session a person started runs as when nobody chose one: the
   * default of the user's configuration, looked up when the first execution
   * has read it, for a session whose creation could not decide (its
   * configuration could not be read then, or another process created it and
   * it never ran). Returns why the execution cannot start, or `null`.
   */
  private startAgent(): string | null {
    const projection = this.projection()
    // A command that waits with an agent is the user's choice of one, also for a process that did not see it sent.
    const undecided =
      this.core.agents !== null && !this.agentDecided && projection.baseline === null && projection.session.lineage === null && projection.session.agent === undefined && !projection.inbox.some((item) => item.agent !== undefined)
    this.agentDecided = true
    if (!undecided) return null
    const places = this.agentPlaces()
    const chosen = resolveStartAgent(findAgents(projection.session.cwd, places), null, places)
    if (!chosen.ok) return FAILURE_TEXT.agent(chosen.message)
    if (chosen.agent === null) return null
    const record = agentRecordOf(chosen.agent)
    const models = this.core.offered()
    const settings = agentSettings(record, projection.session.settings, models?.map((model) => model.id))
    const problem = settings.notes[0] ?? (models === null ? null : (settingsProblem(settings.settings, models)?.message ?? null))
    if (problem !== null) return FAILURE_TEXT.agent(problem)
    this.write([event("agent.switched", { messageId: null, from: null, to: record })])
    if (settings.changed) this.changeSettings(settings.settings)
    for (const warning of agentWarnings(this.core, record)) this.say("agents", warning)
    return null
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
    const item: EphemeralEvent = { type: "diagnostic", sessionId: this.id, kind: diagnostic.kind, message: diagnostic.message }
    // Nobody is subscribed (the session is being created or opened, or its client is changing): kept for the next one.
    if (this.listeners.size === 0 && this.unheard.length < UNHEARD_DIAGNOSTICS) this.unheard.push(item)
    this.ephemeral(item)
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
    if (this.core.memory !== null) this.recordOutcomes(stored)
    // Live telemetry reads what was appended; it never waits and never throws.
    this.trace?.observe(stored)
    const run = this.run
    for (const item of stored) {
      // The ending of the execution this process is working on: it is durable now, and shown once the session is idle here.
      if (run !== null && isEnding(item) && item.data.executionId === run.executionId) this.holding = true
      this.publish(item)
    }
    // Input arrived: a loop that waits at a boundary for it carries on.
    if (this.arrival !== null && stored.some((item) => item.type === "inbox.enqueued")) this.arrival()
    return stored
  }

  /** Hands an event to every consumer, in the order events were produced even when a listener produces more. */
  private publish(item: EngineEvent): void {
    this.outbox.push(item)
    this.pump()
  }

  /** Publishes what waits, unless a listener is being called (it goes on when that returns) or an ending is held back. */
  private pump(): void {
    if (this.publishing) return
    this.publishing = true
    try {
      while (!this.holding) {
        const next = this.outbox.shift()
        if (next === undefined) break
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
   * Stops one running call and nothing else. Like an interrupt, the request
   * is durable before anything stops; unlike one, the execution goes on.
   */
  cancelCall = (target: { readonly callId: CallId; readonly messageId?: MessageId; readonly sessionId?: SessionId }): boolean => {
    if (target.sessionId !== undefined && target.sessionId !== this.id) {
      const child = [...this.children].find((candidate) => candidate.id === target.sessionId)
      return child === undefined ? false : child.cancelCall({ callId: target.callId, ...(target.messageId === undefined ? {} : { messageId: target.messageId }) })
    }
    const run = this.run
    if (run === null || this.closing !== null || run.interrupt.signal.aborted || this.director !== null) return false
    const projection = this.projection()
    const execution = projection.session.execution
    if (execution === null || execution.id !== run.executionId || execution.status !== "running" || execution.interrupting !== null) return false
    const step = openStep(projection)
    if (step === null || (target.messageId !== undefined && target.messageId !== step.id)) return false
    const part = step.parts.find((candidate) => candidate.type === "tool_call" && candidate.callId === target.callId)
    if (part?.type !== "tool_call" || part.state.status !== "running" || part.cancel !== undefined) return false
    const stop = this.callStops.get(callKey(step.id, target.callId))
    // A call the log says is running and this process does not run was settled from here already (its tool came back late).
    if (stop === undefined) return false
    this.write([event("tool.cancel_requested", { messageId: step.id, callId: target.callId })])
    this.probe("call.cancel_requested")
    stop()
    return true
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
    // What the session spawned stops with it: its subagents and its background commands.
    this.stopSpawned(reason === "user" ? "interrupt" : "shutdown")
    return true
  }

  private async shutdown(): Promise<void> {
    try {
      // A restore in progress is finished, not cut: it is short, and half of one helps nobody.
      // (No await when there is none: the interrupt below must be requested in this very turn of the event loop.)
      if (this.restoring !== null) await this.restoring.catch(() => {})
      // Nothing the session spawned outlives it here: a command dies with the process anyway, and a subagent has nobody to answer to.
      this.stopSpawned("shutdown")
      if (this.run !== null) {
        // `shutdown` keeps the claim for the next start, which takes the turn up again. An execution that has no
        // turn (it was started only to make a compaction the user asked for) leaves nothing to take up: it is
        // stopped as a user's stop stops it, the claim is released, and history is as it was.
        this.requestInterrupt(turnless(this.projection()) ? "user" : "shutdown")
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
      // The ends of spawned work are recorded, and the subagents let go of, before the session is.
      while (this.ending.size > 0) await Promise.all([...this.ending]).catch(() => {})
      await Promise.all([...this.children].map((child) => child.close())).catch(() => {})
      await this.retaining?.catch(() => {})
      // What closed and was not mapped yet is handed to the queue, and the queue is sent: nothing waits for the collector.
      this.trace?.settle(true)
      this.trace = null
      // Its servers are let go of: one that no other session uses is stopped.
      this.releaseMcp()
      this.releaseLsp()
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
    // A compaction the dead process left open is closed with the summary requests it had sent, which the ledger knows.
    const closing = recovery.events.map((item) => (item.type === "compaction.failed" ? event("compaction.failed", { ...item.data, calls: this.summaryCalls(item.data.messageId) }) : item))
    if (closing.length > 0) this.write(closing, { expectedSeq: projection.lastSeq })
    // What the log says was spawned and nobody here runs was lost with the process that ran it.
    this.reapSpawned()
    if (projection.session.replay !== undefined && this.director === null) {
      // A replay is not taken up again: the process that ran it is gone, and so is where it stood on the tape.
      if (recovery.claim !== "none") this.write([event("execution.failed", { executionId: claimOf(this.projection()).id, message: REPLAY_TEXT.ended(REPLAY_TEXT.crashed), cause: "replay" })])
      if (this.projection().session.replay?.ended === null)
        this.write([event("replay.ended", { outcome: "incomplete", reason: REPLAY_TEXT.crashed, report: { status: "incomplete", reason: REPLAY_TEXT.crashed } })])
      return
    }
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
      if (await this.configure(run)) await (this.director === null ? this.loop(run) : this.replayLoop(run, this.director))
    } catch (error) {
      this.abandon(run, error)
    } finally {
      this.concludeReplay()
      this.run = null
      // A compaction that was asked for and never reached a boundary (the turn failed or was stopped first) is not
      // made behind the user's back later: whoever asked is told.
      const unmade = this.compactRequests.splice(0)
      if (unmade.length > 0) {
        const message = this.closing !== null ? MANUAL_COMPACTION_TEXT.closed : run.interrupt.signal.aborted ? MANUAL_COMPACTION_TEXT.interrupted : MANUAL_COMPACTION_TEXT.ended(lastExecutionFailure(ownEvents(this.store, this.id)) ?? "the turn ended first")
        for (const resolve of unmade) resolve({ kind: "failed", message })
      }
      this.retain()
      // The session is idle here now: the ending that was held back is shown, before anything new starts.
      this.holding = false
      this.pump()
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
    // A replay reads nothing of the workspace: no checks, and the approval settings are its own.
    const load = this.director === null ? this.core.loadConfig : null
    const asAgent = (): boolean => {
      // A replay runs as its recording did. Anything else that never chose an agent gets the user's default now.
      const refused = this.director === null ? this.startAgent() : null
      if (refused === null) return true
      this.write([event("execution.failed", { executionId: run.executionId, message: refused })])
      return false
    }
    if (load === null) {
      this.config = null
      this.configRead = true
      this.announcePolicy()
      // No configuration, no hooks and no language servers: what an earlier execution read is let go of.
      this.attachHooks()
      this.attachLsp()
      this.attachTelemetry()
      return asAgent()
    }
    // Only what reads the files is a configuration problem. Anything that fails after them (the store, a server
    // that cannot be attached) is the harness's own failure and is reported as that, in its own words.
    let loaded: SessionConfig
    try {
      loaded = await load(this.projection().session.cwd)
    } catch (error) {
      if (run.interrupt.signal.aborted) this.finishInterrupt(run)
      else this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.config(describe(error)) })])
      return false
    }
    this.config = loaded
    this.configRead = true
    this.announcePolicy()
    // The servers this configuration names are started now, in the background: nothing waits for one here.
    this.attachMcp()
    // Its hooks apply from this turn's first call, and its language servers start at the first file they serve.
    this.attachHooks()
    this.attachLsp()
    // Its telemetry section decides whether this turn's spans are exported as it runs, and where to.
    this.attachTelemetry()
    return run.interrupt.signal.aborted ? true : asAgent()
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
      // A switch of agent that was asked for is made here: the instruction message that tells the model is appended
      // at a boundary, under the claim. (A replay runs as its recording did.)
      if (this.pendingAgent !== undefined && this.director === null) this.applyAgentSwitch()
      // A compaction the user asked for is made here, at the boundary, before anything else is decided: the turn
      // in progress carries on from the checkpoint, and an execution started only for it ends right after.
      if (this.compactRequests.length > 0 && this.director === null) {
        if ((await this.compactOnRequest(run)) === "done") return
        continue
      }

      // A replay that left its recording and then had to stop (a call its policy does not run) ends here.
      const replayed = this.director?.replay
      if (replayed !== undefined && (replayed.status === "stopped" || replayed.status === "incomplete")) return this.endReplayRun(run, replayed.report().reason)

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
          const outcome = decision.kind === "now" ? await this.compact$(run, { trigger: "overflow", mode: decision.mode, tailBudget: decision.tailBudget, tokensBefore: this.measure(rejected).total }) : "nothing"
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
      if (idle && before.inbox.length === 0 && this.awaitsSubagents()) {
        // The model has nothing more to do and its background subagents are still at work in the workspace: the turn
        // is not over, and the checks would see their work half done. The loop waits here for the next result (or
        // for anything else that arrives), and then decides again.
        await this.arrived(signal)
        continue
      }
      let ended: TurnEnding | null = null
      if (idle && !before.inbox.some(isSteer) && (before.inbox.length === 0 || latest !== undefined)) {
        const verdict = await this.gate(run)
        if (verdict === "done") return
        if (verdict === "continue") continue
        ended = verdict
      }

      // A step follows. The workspace is recorded first when input is about to enter history, so that a later
      // revert to before that input has a state to go back to, including what the user changed by hand since.
      if (this.core.openSnapshots !== null && (before.inbox.some(isSteer) || ended !== null || (idle && before.inbox.length > 0))) {
        await this.snapshot("delivery")
        if (signal.aborted) return this.finishInterrupt(run)
      }
      // The first step of an execution gives servers that are still starting a bounded moment, so that a one-prompt
      // run has the catalogue in its first request. (No await when none is starting: the loop goes straight on.)
      if (this.serversToAwait(run)) {
        await this.awaitServers(run)
        if (signal.aborted) return this.finishInterrupt(run)
      }
      // Read again: input may have arrived, or been withdrawn, while the gate ran and the snapshot was taken.
      let waiting = this.projection()
      const steers = waiting.inbox.filter(isSteer)
      const queued = waiting.inbox.find((item) => !isSteer(item))
      const follows = latestSpoken(waiting) !== undefined
      // Steers at any boundary, oldest first. One queued item only when the turn before it ended, or as the first input.
      const handover = steers.length === 0 && queued !== undefined && (ended !== null || !follows) ? queued : undefined
      // The turn may end and what waited behind it is gone: nothing follows, so the gate decides again, now alone.
      if (ended !== null && steers.length === 0 && handover === undefined) continue
      // A command that names an agent switches the session to it here, where its message is delivered and right
      // before it: the record alone before the first baseline (which then carries the agent), a message after it.
      // The agent waits with the message in the inbox, so a process that was started again makes the same switch.
      const arriving = steers.length > 0 ? steers : handover === undefined ? [] : [handover]
      const commanded = arriving.flatMap((item) => item.agent ?? [])
      if (commanded.length > 0 && this.director === null) {
        this.pendingAgent = commanded.at(-1)!
        this.applyAgentSwitch()
        waiting = this.projection()
      }
      // Instructions first, then the waiting input, so the request carries both. A replay's instructions are its recording's.
      // The agent the session runs as is a section of a baseline that is being built (the first, and the one after
      // a compaction, from the record and never from the file). Between them it is not among the sources: a switch
      // is its own message, and the fold of the instruction state follows it by itself.
      const building = waiting.baseline === null || (waiting.session.compaction?.seq ?? 0) > waiting.baseline.seq
      const runsAs = waiting.session.agent ?? null
      const prepared = waiting.session.replay !== undefined ? [] : prepareInstructions(waiting, {
        ...(this.core.prompt === undefined ? {} : { prompt: this.core.prompt }),
        tools: this.offeredTools(waiting),
        sources: [
          ...this.core.discover({
            cwd: waiting.session.cwd,
            known: knownAgentsFiles(instructionState(selectModelHistory(waiting))),
            directories: this.workedDirectories(waiting),
          }),
          ...(building && runsAs !== null ? [agentSource(runsAs)] : []),
        ],
        newMessageId: ids.message,
      })
      if (prepared.length > 0) this.write(prepared)
      // What is never in the baseline (the skill index, the MCP catalogue) is appended when it changed. Read after
      // the baseline is in place: a baseline set just now carries none of it, so it is given in full.
      if (waiting.session.replay === undefined) {
        const current = this.projection()
        const appended = detectAppendedChanges(instructionState(selectModelHistory(current)), this.appendedSources(current), ids.message)
        if (appended.length > 0) this.write(appended)
      }
      if (steers.length > 0) this.write(steers.map((item) => event("inbox.delivered", { messageId: item.messageId })))
      else if (handover !== undefined)
        // The end of the turn and the delivery it makes room for are one decision, so one append.
        this.write([
          ...(ended !== null && follows ? [event("turn.ended", { verification: ended.verification, ...(ended.hooks === undefined ? {} : { hooks: ended.hooks }) })] : []),
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
      // An effort the model does not offer is refused here, before a request is spent on it. (No await once these
      // settings were looked at: the loop goes straight on.)
      const checking = this.settingsToCheck(ready.session.settings)
      if (checking !== null) {
        const unusable = await checking
        if (signal.aborted) return this.finishInterrupt(run)
        if (unusable !== null) {
          this.write([event("execution.failed", { executionId: run.executionId, message: FAILURE_TEXT.settings(unusable) })])
          return
        }
      }
      // How large would this request be? The policy decides from the estimate whether history is compacted first.
      const window = await this.contextWindow(ready.session.settings.model)
      if (signal.aborted) return this.finishInterrupt(run)
      const next = this.prepare(this.projection(), toolChoice)
      const decision = window === null ? null : this.beforeStep(next, window)
      if (window !== null && decision?.kind === "now") {
        const outcome = await this.compact$(run, {
          trigger: decision.trigger,
          mode: decision.mode,
          tailBudget: decision.tailBudget,
          tokensBefore: this.measure(next).total,
          otherwise: { fits: decision.share <= 1, usable: this.usableWindow(window), aggressiveBudget: this.aggressiveBudget(next, window) },
        })
        if (outcome === "done") return
        // The baseline is set again and the request rebuilt at the top of the loop.
        if (outcome === "compacted") continue
        // Nothing could be taken out: the request is sent as it is.
      }
      if ((await this.step(run, next)) === "done") return
    }
  }

  /**
   * The check of `settings` against the provider's listing, when they were
   * not looked at yet and a listing can be had: resolves with what is wrong
   * (an effort the model does not offer) or `null`. `null` at once when
   * there is nothing to wait for. Only the effort is refused here: a model
   * the listing lacks may still be one the provider serves.
   */
  private settingsToCheck(settings: SessionSettings): Promise<string | null> | null {
    const key = `${settings.model}\u0000${settings.reasoningEffort ?? ""}`
    if (this.checkedSettings === key || this.director !== null || settings.reasoningEffort === null) return null
    const list = this.core.listOffered
    const known = this.core.offered()
    if (known === null && list === null) return null
    return (known !== null ? Promise.resolve(known) : list!()).then((models) => {
      this.checkedSettings = key
      const problem = models === null ? null : settingsProblem(settings, models)
      return problem !== null && problem.code === "unknown_effort" ? problem.message : null
    })
  }

  // ---- the context window ----

  /**
   * The context window of `model`, asked for once per engine. `null` when
   * nobody knows it: then nothing is compacted ahead of time.
   */
  private async contextWindow(model: string): Promise<number | null> {
    // A replay is never compacted: a compaction is something a recording cannot be compared across.
    if (this.director !== null) return null
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

  /** The part of a window of this size a request may fill: the window less what is kept free for the answer. */
  private usableWindow(window: number): number {
    const { contextWindow, reservedOutput } = this.windowInput(window)
    return contextWindow - reservedOutput
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

  /** The model call finished: run what it asked for, close the step, and, in a replay, tell the tape what the step was. */
  private async finishStep(
    run: Run,
    messageId: MessageId,
    toolChoice: ModelRequest["toolChoice"],
    reason: FinishReason,
    call: ModelCall,
  ): Promise<StepResult> {
    const director = this.director
    if (director !== null) director.asked = 0
    const closed = await this.closeStep(run, messageId, toolChoice, reason, call)
    if (director === null || closed !== "continue") return closed
    const message = this.assistant(messageId)
    if (message.status !== "completed") return closed
    const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call")
    // Calls that were written and never handed to the tape (a response cut at the output limit) cannot be compared.
    if (calls.length !== director.asked) director.replay.fail("a response of the replay was cut at the output limit")
    else
      director.replay.endStep({
        text: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        calls: calls.map((part) => ({ name: part.name, input: part.input })),
        usage: message.usage,
      })
    return closed
  }

  private async closeStep(
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
      // On the tape the recording's own notes are the model's notes.
      const told = (call.cutOff || calls.length > 0) && !this.onTape()
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
      const onTape = this.onTape()
      const tracked = this.core.openSnapshots !== null && this.mayChangeFiles(calls, toolChoice) && !onTape
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
      // Also when the replay left its recording during these tools: its `step_start` was taken as it went live.
      if (tracked || (onTape && !this.onTape() && this.core.openSnapshots !== null)) {
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
    if (saysNothing(message) && !current.inbox.some((item) => item.delivery === "steer") && !this.onTape()) {
      // A response with no text and no call (nothing at all, or only reasoning) says nothing. It gets one nudge.
      // A second one in a row fails the execution (retry rule 8), unless the turn has work in it: then the model
      // has nothing to add, and the turn ends as any turn ends, through the gate.
      const previous = current.messages.at(-2)
      const nudged = previous?.kind === "synthetic" && previous.delivery === null && previous.origin === HARNESS_ORIGIN.emptyResponse
      if (nudged && workedThisTurn(current)) {
        this.write([ended])
        this.probe("step.closed")
        // The turn will end as done with nothing said last: the user is told why there is no answer to read.
        this.ephemeral({ type: "notice", sessionId: this.id, kind: "no_closing_answer", message: NOTICE_TEXT.noClosingAnswer })
        return "continue"
      }
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
    const begun = store.beginRequest({
      id: requestId,
      sessionId: this.id,
      messageId,
      attempt: input.attempt,
      purpose: input.purpose,
      model: request.params.model,
      provider: provider.id,
      blocks: input.blocks,
    })
    this.trace?.request(begun)

    let usage: Usage | null = null
    let partialText = ""
    let whole = ""
    let end: ModelEnd | null = null
    /** What the provider said about the response it finished: for the ledger, not for history. */
    let response: ResponseFacts | null = null
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
            response = item.response ?? null
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
    const finished = store.finishRequest(requestId, {
      // A call the loop itself cut at the output bound did not finish: it was stopped.
      outcome: overran ? "aborted" : end.type === "finish" ? "ok" : end.type === "error" ? "error" : "aborted",
      usage,
      errorKind: end.type === "error" ? end.error.kind : null,
      // The provider's own ID of the request: of a call that finished, and of one that failed with a response.
      providerRequestId: (end.type === "error" ? end.error.requestId : response?.requestId) ?? null,
      responseModel: response?.model ?? null,
    })
    this.trace?.request(finished)
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
    // Each call has a signal of its own: it follows the execution's, and the user can fire it for that call alone.
    const stops = new Map<CallId, CallStop>(calls.map((call) => [call.callId, createCallStop(signal)]))
    const stopOf = (call: ToolCallPart) => stops.get(call.callId)!
    /** Ends the wait for a call whose tool did not come back within the grace period after the user stopped it. */
    const giveUp = new Map<CallId, () => void>()
    const graces: AbortController[] = []
    const refuse = (call: ToolCallPart, output: string) =>
      this.write([
        event("tool.settled", { messageId, callId: call.callId, outcome: "error", output, truncation: null, attachments: [], display: null }),
      ])
    this.decided.clear()
    this.hookRecords.clear()
    this.lspBefore.clear()
    this.lspSaid.clear()
    // The agent the session runs as, as of this step: a switch is made at a boundary, never between two calls.
    const runsAs = before.session.agent ?? null
    /** A call the agent may not make: refused before anything about it is decided, and recorded as the agent's refusal. */
    const refuseAsAgent = (call: ToolCallPart, agent: AgentRecord, verdict: Extract<CallVerdict, { kind: "refuse" }>) =>
      this.write([
        event("approval.denied", { messageId, callId: call.callId, mode: approvals === null ? "full" : this.policy().policy.mode, paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: agent.name, refusal: verdict.refusal }),
        event("tool.settled", { messageId, callId: call.callId, outcome: "error", output: verdict.reason, truncation: null, attachments: [], display: null }),
      ])
    const place = this.tempContext()
    // Output kept in full goes into the session's own temp directory, where its sandboxed commands can read it too.
    // A credential's value that has only begun to arrive is held back until the rest is there (a value with a line
    // break in it arrives in parts), so a command's progress never shows the first half of one.
    const extras =
      approvals === null
        ? {}
        : {
            ...place,
            ...(place.temp === undefined ? {} : { spillDir: join(place.temp.dir, SPILL_IN_TEMP) }),
            redact: redactor(approvals.secrets),
            unfinishedSecret: (text: string) => unfinishedSecret(text, approvals.secrets),
          }
    const request = (call: ToolCallPart): ToolCall => ({
      name: call.name,
      argumentsText: call.input,
      context: {
        sessionId: this.id,
        messageId,
        callId: call.callId,
        cwd: before.session.cwd,
        signal: stopOf(call).signal,
        progress: (update) => {
          if (!abandoned.has(call.callId)) this.ephemeral({ type: "tool.progress", sessionId: this.id, messageId, callId: call.callId, text: update.text })
        },
        ...extras,
        // A tool that starts work in the background hands it to this session, which records it and stops it with itself.
        ...(this.core.spawn === null ? {} : { background: { command: (work: BackgroundCommand) => this.backgroundCommand(messageId, call.callId, work) } }),
      },
    })
    // In a replay the calls of the step are matched against the recording together, once, and each is answered from there.
    const director = this.director
    const plan = director === null ? null : director.replay.beginStep(calls.map(request))
    if (director !== null) director.asked = calls.length
    const matchOf = (call: ToolCallPart): CallMatch | undefined => plan?.matches[calls.indexOf(call)]
    const recorded = (call: ToolCallPart) => {
      const match = matchOf(call)
      return match?.kind === "matched" || match?.kind === "dropped"
    }

    // Hooks and language servers have a say only where the session's configuration names some: without them a call
    // is decided and run exactly as an engine without either would. (A replay runs as its recording did.)
    const before$ = director === null && (this.hookConfig.beforeTool.length > 0 || this.lspHeld !== null)
    const after$ = director === null && (this.hookConfig.afterTool.length > 0 || this.lspHeld !== null)

    /** One call, from its decision to its recorded result. */
    const launch = (call: ToolCallPart): Promise<void> => {
      const match = matchOf(call)
      // A recorded call started with the class the recording has for it, whatever this build's tools are.
      const effect = effects.get(call.name) ?? (match?.kind === "matched" ? match.recorded.started?.effect : undefined)
      const key = callKey(messageId, call.callId)
      unsettled.add(call.callId)
      const gaveUp = new Promise<void>((resolve) => giveUp.set(call.callId, resolve))
      const run$ = (hooks: Parameters<ToolRuntime["run"]>[1]) =>
        plan === null ? runtime.run(request(call), hooks).then((outcome) => ({ outcome, executed: true })) : plan.run(calls.indexOf(call), request(call), hooks)
      const work = run$(
          {
            // With before hooks or language servers the decision has more to it; without them it is the approval layer's alone, as ever.
            ...(before$
              ? { authorize: (tool: AnyTool, input: Json) => this.decideCall(run, messageId, call, tool, input) }
              : approvals === null
                ? {}
                : { authorize: (tool: AnyTool, input: Json) => this.authorize(run, messageId, call, tool, input) }),
            // After the tool ran and before its result is capped and stored: the after hooks' notes, then the diagnostics of an edit.
            ...(after$ ? { afterExecute: (tool: AnyTool, input: Json, result: ToolResult) => this.afterTool(run, messageId, call, tool, input, result) } : {}),
            // Synchronous, right before the tool runs: the start is durable before any side effect.
            onStart: () => {
              if (effect === undefined) throw new Error(`tool ${call.name} started without an effect class`)
              const ran = this.decided.get(key)?.run
              this.write([event("tool.started", { messageId, callId: call.callId, effect, ...(ran === undefined ? {} : { run: ran }) })])
              this.probe("tool.started")
            },
          },
        )
        .then(({ outcome: result, executed }) => {
          this.probe("tool.finished")
          // A tool that came back after its grace period was already settled from its effect class.
          if (abandoned.has(call.callId)) return
          // The interrupt reached it while it waited for an answer: it never began, and the wind-down settles it.
          // (In a replay a call may also be answered as never started: the recording's own, or the replay stopping.)
          if (result.kind === "not_started" && (plan === null || signal.aborted)) return
          unsettled.delete(call.callId)
          const decided = this.decided.get(key)
          this.decided.delete(key)
          const settlement = this.settlement(result, effect, stopOf(call).signal)
          // The note for a failure the sandbox causes, then the redaction: what is stored is what is replayed.
          const shown = approvals === null ? settlement : { ...settlement, ...finishOutput(settlement, decided?.run, effect, approvals.secrets, place.temp) }
          // The hooks that applied to the call are recorded with what they decided, and what the language servers said with the result their note is in.
          const hooks = this.hookRecords.get(key) ?? []
          const diagnostics = this.lspSaid.get(key)
          this.hookRecords.delete(key)
          this.lspSaid.delete(key)
          this.lspBefore.delete(key)
          this.write([
            ...(decided?.before ?? []),
            ...hooks,
            ...(match === undefined ? [] : [replayCall(messageId, call.callId, match, executed)]),
            event("tool.settled", { messageId, callId: call.callId, ...shown, ...(diagnostics === undefined ? {} : { diagnostics }) }),
          ])
          this.probe("tool.settled")
          if (decided?.stop != null) this.stopping ??= decided.stop
          this.noticeTaint()
        })
        .catch((error: unknown) => {
          unsettled.delete(call.callId)
          if (!failure.failed) failure.error = error
          failure.failed = true
        })
        .finally(() => stopOf(call).release())
      // The step goes on when the call has its result: its tool's, or the one written for a tool that did not stop in time.
      return Promise.race([work, gaveUp])
    }

    /**
     * `cancelCall` for a call of this step: fires the call's own signal, and
     * gives its tool the grace period an interrupt gives every tool. A tool
     * that has not come back by then is settled from the effect class it
     * started with, and whatever it returns later is dropped.
     */
    const cancel = (call: ToolCallPart) => {
      stopOf(call).cancel()
      const timer = new AbortController()
      graces.push(timer)
      void clock.sleep(limits.toolStopGraceMs, timer.signal).then(() => {
        // Over meanwhile, or the whole turn is being interrupted: the wind-down settles what is left.
        if (timer.signal.aborted || signal.aborted || !unsettled.has(call.callId)) return
        const key = callKey(messageId, call.callId)
        const step = openStep(this.projection())
        const part = step?.id === messageId ? step.parts.find((candidate) => candidate.type === "tool_call" && candidate.callId === call.callId) : undefined
        if (part?.type !== "tool_call" || part.state.status !== "running") return
        abandoned.add(call.callId)
        unsettled.delete(call.callId)
        try {
          // The hooks that had finished for the call are on record before its result, as when an interrupt settles it.
          this.write([...(this.hookRecords.get(key) ?? []), settledBy(messageId, part, CANCELLED)])
          this.probe("tool.settled")
          this.noticeTaint()
        } catch (error) {
          if (!failure.failed) failure.error = error
          failure.failed = true
        }
        this.decided.delete(key)
        this.hookRecords.delete(key)
        this.lspSaid.delete(key)
        this.lspBefore.delete(key)
        giveUp.get(call.callId)?.()
      })
    }
    for (const call of calls) this.callStops.set(callKey(messageId, call.callId), () => cancel(call))

    try {
      /** The line of calls that can change something: each starts when the one before it has its result. */
      let line: Promise<void> | null = null
      const running = calls.flatMap((call, index): Promise<void>[] => {
        // Once an interrupt is requested nothing new starts; the call is settled as not started below.
        if (failure.failed || signal.aborted) return []
        // A call the recording has is answered by the recording, also where the recording's loop refused it.
        if (recorded(call)) return [launch(call)]
        if (toolChoice === "none") return refuse(call, TOOL_TEXT.toolsDisabled) && []
        if (index >= limits.maxToolCallsPerStep) return refuse(call, TOOL_TEXT.tooManyCalls(limits.maxToolCallsPerStep)) && []
        // A tool whose result changes by itself (`Tool.varies`) is asked again however often it answered the same.
        if (!this.core.varying.has(call.name) && repeatsItself(before, { messageId, callId: call.callId, name: call.name, input: call.input })) return refuse(call, TOOL_TEXT.identicalCall) && []
        const effect = effects.get(call.name)
        // The agent's restrictions come before the approval layer, and only take away: a call they let through is
        // decided exactly as without an agent. (A tool nobody knows is answered by the runtime, as always.)
        if (runsAs !== null && effect !== undefined) {
          const verdict = checkAgentCall(runsAs, { name: call.name, effect, origin: this.core.origins.get(call.name) ?? "builtin" }, { exempt: [ACKNOWLEDGE_TOOL_NAME] })
          if (verdict.kind === "refuse") return refuseAsAgent(call, runsAs, verdict) && []
        }
        // A read changes nothing, and a tool nobody knows is refused before it could: both go at once. So does a
        // call that hands its work to a subagent: several of them in one response are meant to run side by side.
        if (approvals === null || effect === undefined || effect === "read" || this.core.delegating.has(call.name)) return [launch(call)]
        // The first of the line starts here and now, so that with nothing to wait for the calls start in the order written.
        const previous = line
        const next: Promise<void> = previous === null ? launch(call) : previous.then(() => (failure.failed || signal.aborted || this.stopping !== null ? undefined : launch(call)))
        line = next
        return [next]
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
    } finally {
      // Whatever happened, nothing of this step can be stopped by itself any more, and no grace period is left running.
      this.callStops.clear()
      for (const timer of graces) timer.abort()
      for (const stop of stops.values()) stop.release()
    }
    this.decided.clear()
    if (failure.failed) throw failure.error
  }

  // ---- spawned work: subagents and background commands ----

  /** Whether the replay is still on its recording: nothing runs, nothing is recorded about a workspace, and the recording's notes are the notes. */
  private onTape(): boolean {
    return this.director !== null && !this.director.live
  }

  /** Whether a background subagent of this session is still at work here. */
  private awaitsSubagents(): boolean {
    // Also one that a restart cut off and that is being looked at right now: a turn that is taken up again does
    // not end before the model was told what became of the work it had handed out.
    return [...this.spawns.values()].some((live) => (live.lost === true || (live.child !== null && live.background)) && live.result === null)
  }

  /** Resolves when input arrives in the inbox, or the execution is interrupted. */
  private arrived(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.arrival = null
        signal.removeEventListener("abort", done)
        resolve()
      }
      this.arrival = done
      if (signal.aborted) return done()
      signal.addEventListener("abort", done, { once: true })
    })
  }

  /** How deep in a chain of subagents this session is: 0 for one a person started. */
  private depth(): number {
    const lineage = this.projection().session.lineage
    return lineage?.kind === "spawn" ? lineage.depth : 0
  }

  private track(work: Promise<void>): void {
    const done = work
      .catch((error: unknown) => this.core.report({ kind: "internal_error", sessionId: this.id, message: `spawned work could not be ended: ${describe(error)}`, cause: error }))
      .finally(() => this.ending.delete(done))
    this.ending.add(done)
  }

  /** Starts working again if the session is idle: a result arrived for it. */
  private wake(): void {
    if (this.closing !== null) return
    try {
      this.start()
    } catch (error) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: describe(error), cause: error })
    }
  }

  /** Stops everything this session spawned that still runs: its subagents and its background commands. */
  private stopSpawned(reason: "interrupt" | "shutdown"): void {
    for (const live of this.spawns.values()) {
      if (live.result !== null) continue
      live.stopping ??= reason
      if (live.command !== null) void live.command.stop().catch(() => {})
      else live.child?.interrupt()
    }
  }

  /**
   * Records the end of spawned work and, when the model is to be told
   * outside a tool result, the message that tells it, in one append.
   */
  private spawnEnded(spawnId: string, data: Omit<EventData<"spawn.ended">, "spawnId">, message: { readonly origin: string; readonly text: string } | null): void {
    try {
      // A watch that could still fire is never silently gone: it ends here, with the reason, in the same append.
      const reason = data.outcome === "lost" ? ("lost" as const) : ("command_ended" as const)
      this.write([
        ...this.watching(spawnId).map((watch) => event("watch.ended", { watchId: watch.watchId, spawnId, reason })),
        event("spawn.ended", { spawnId, ...data }),
        ...(message === null ? [] : [event("inbox.enqueued", { messageId: this.core.ids.message(), origin: message.origin, delivery: "steer" as const, content: text(message.text) })]),
      ])
      for (const unfollow of [...(this.spawns.get(spawnId)?.watches.values() ?? [])]) unfollow()
      // A subagent's taint is this session's from here on.
      this.noticeTaint()
    } catch (error) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `the end of spawned work ${spawnId} could not be recorded: ${describe(error)}`, cause: error })
    }
  }

  /** The watches on a running command's output that can still fire, as the log has them. */
  private watching(spawnId: string) {
    return (this.projection().session.spawned?.running.find((entry) => entry.spawnId === spawnId)?.watches ?? []).filter(watchInForce)
  }

  watchOutput = (id: string, request: OutputWatchRequest): OutputWatchSet => {
    this.assertOpen()
    const refuse = (message: string): never => {
      throw new EngineError("invalid_request", message)
    }
    const live = this.findSpawn(id)
    const entry = live === undefined ? undefined : this.projection().session.spawned?.running.find((candidate) => candidate.spawnId === live.spawnId)
    if (live === undefined || entry === undefined || live.result !== null) {
      const running = [...this.spawns.values()].flatMap((candidate) => (candidate.command !== null && candidate.result === null ? [candidate.spawnId] : []))
      return refuse(`No background command ${id} is running, so its output cannot be watched: a watch is set while the command runs.${running.length === 0 ? "" : ` Running: ${running.join(", ")}.`}`)
    }
    const command = live.command
    if (command === null) return refuse(`${id} is a subagent. Only the output of a background command can be watched.`)
    if (live.stopping !== null) return refuse(`Background command ${live.spawnId} is being stopped, so its output is not watched any more.`)
    const follow = command.lines
    if (follow === undefined) return refuse(`The output of background command ${live.spawnId} cannot be followed, so it cannot be watched.`)
    const watch: WatchPattern = { pattern: request.pattern, regex: request.regex === true, ignoreCase: request.ignoreCase === true }
    const matcher = watchMatcher(watch)
    if ("problem" in matcher) return refuse(`The watch was not set. ${matcher.problem}`)
    const limit = request.limit ?? 1
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WATCH_LIMITS.maxFirings) return refuse(`The watch was not set. A watch fires between 1 and ${WATCH_LIMITS.maxFirings} times, not ${limit}.`)
    const watches = entry.watches ?? []
    if (watches.filter(watchInForce).length >= WATCH_LIMITS.perCommand)
      return refuse(`The watch was not set. Background command ${live.spawnId} already has ${WATCH_LIMITS.perCommand} watches that can still fire; remove one first.`)
    // Its ID is its place among the command's watches: the same from the log alone.
    const watchId = `${live.spawnId}.w${watches.length + 1}`
    this.write([event("watch.started", { watchId, spawnId: live.spawnId, ...watch, limit })])

    const state = { fired: 0, over: false }
    let unfollow = () => {}
    const end = () => {
      state.over = true
      unfollow()
      live.watches.delete(watchId)
    }
    live.watches.set(watchId, end)
    // The lines still in memory are looked at before this returns, so `end` may be called before `unfollow` is the real one.
    unfollow = follow((line) => {
      // A command that is being stopped reports its end, not what it printed on the way down.
      if (state.over || live.stopping !== null || live.result !== null || this.closing !== null) return
      if (!matcher.matches(line)) return
      state.fired += 1
      if (state.fired >= limit) end()
      try {
        this.watchFired(live.spawnId, command.command, watchId, watch, state.fired, limit, line)
      } catch (error) {
        end()
        this.core.report({ kind: "internal_error", sessionId: this.id, message: `a firing of watch ${watchId} could not be recorded: ${describe(error)}`, cause: error })
      }
    })
    if (state.over) unfollow()
    return { watchId, spawnId: live.spawnId, ...watch, limit, fired: state.fired }
  }

  unwatchOutput = (watchId: string): boolean => {
    this.assertOpen()
    const entry = this.projection().session.spawned?.running.find((candidate) => (candidate.watches ?? []).some((watch) => watch.watchId === watchId && watchInForce(watch)))
    if (entry === undefined) return false
    this.write([event("watch.ended", { watchId, spawnId: entry.spawnId, reason: "removed" })])
    this.spawns.get(entry.spawnId)?.watches.get(watchId)?.()
    return true
  }

  /**
   * A watch fired: the message that tells the model and the record of the
   * firing are one append, and the message wakes the session exactly as a
   * command's end does. The line is the command's output: it is shown
   * redacted like any, inside a fence, and said to be output.
   */
  private watchFired(spawnId: string, command: string, watchId: string, watch: WatchPattern, firing: number, limit: number, line: string): void {
    const secrets = this.core.approvals?.secrets
    const show = (value: string) => (secrets === undefined ? value : redact(aliased(value, this.tempContext().temp), secrets).text)
    const shown = show(line)
    const messageId = this.core.ids.message()
    this.write([
      event("inbox.enqueued", { messageId, origin: HARNESS_ORIGIN.backgroundWatch, delivery: "steer" as const, content: text(show(renderWatchFired(spawnId, { command, watch, firing, limit, line: shown }))) }),
      event("watch.fired", { watchId, spawnId, firing, line: watchedLine(shown), messageId }),
    ])
    this.wake()
  }

  /** `ToolContext.background.command`: takes over a command the shell tool just started. */
  private backgroundCommand(messageId: MessageId, callId: CallId, work: BackgroundCommand): { readonly id: string } {
    const spawnId = this.core.ids.spawn()
    try {
      this.write([event("spawn.started", { spawnId, messageId, callId, background: true, work: { kind: "command", command: work.command, logPath: work.logPath } })])
    } catch (error) {
      // It cannot be recorded (the session is being interrupted): it must not run unrecorded.
      void work.stop().catch(() => {})
      throw error
    }
    this.probe("spawn.started")
    let finish = () => {}
    const live: LiveSpawn = { spawnId, background: true, child: null, fromSeq: 0, command: work, stopping: null, result: null, watches: new Map(), done: new Promise<void>((resolve) => (finish = resolve)) }
    this.spawns.set(spawnId, live)
    this.track(
      work.exited.then((end) => {
        const stopped = live.stopping
        const secrets = this.core.approvals?.secrets
        const rendered = renderCommandEnd(spawnId, { ...end, command: work.command, stopped: stopped === null ? null : STOPPED_BY[stopped], logPath: work.logPath, watches: this.watching(spawnId) })
        // Its output is tool output: what the model is shown of it is redacted like any other.
        const shown = secrets === undefined ? rendered : redact(aliased(rendered, this.tempContext().temp), secrets).text
        live.result = shown
        this.spawnEnded(
          spawnId,
          { outcome: stopped === null ? "completed" : "stopped", detail: shown.split("\n")[0] ?? "", exitCode: end.exitCode, usage: null, tainted: false, merge: null },
          // The stop tool's own result says how it ended.
          stopped === "tool" ? null : { origin: HARNESS_ORIGIN.backgroundCommand, text: shown },
        )
        this.spawns.delete(spawnId)
        finish()
        if (stopped === null) this.wake()
      }),
    )
    return { id: spawnId }
  }

  /** The `subagent` tool: starts a child session on a task, or sends a follow-up to one, and waits for its answer unless it runs in the background. */
  async subagent(input: SubagentInput, context: ToolContext): Promise<ToolResult> {
    const settings = this.core.spawn
    if (settings === null) return toolResult("error", "Subagents are not available here.")
    if (context.signal.aborted) return toolResult("error", "Not started: the session was interrupted.")
    const projection = this.projection()
    if (input.session !== undefined) {
      if (input.agent !== undefined) return toolResult("error", "Not sent: a subagent keeps the agent it started as, so `agent` cannot be given together with `session`. Send the follow-up without `agent`, or start a new subagent as that agent.")
      return this.followUp(input, context, projection)
    }
    const depth = this.depth()
    if (depth >= settings.maxDepth)
      return toolResult("error", `Not started: a subagent ${settings.maxDepth === 1 ? "cannot start subagents of its own" : `at depth ${depth} cannot start another (the limit is ${settings.maxDepth} levels)`}. Do the work yourself.`)
    // The agent it runs as: the one the call names, looked up now (a wrong name starts nothing), with its
    // restrictions combined with this session's; without a name, this session's own agent, so that a restricted
    // session cannot hand its work to an unrestricted child.
    let chosen: AgentDefinition | null = null
    if (input.agent !== undefined) {
      if (this.core.agents === null) return toolResult("error", "The subagent was not started: agents are not available here. Call subagent without `agent`.")
      const places = this.agentPlaces()
      const found = findAgent(findAgents(projection.session.cwd, places), input.agent, places.disabled)
      if (!found.ok) return toolResult("error", `The subagent was not started: ${found.message}`)
      chosen = found.agent
    }
    const runsAs = childAgent(projection.session.agent ?? null, chosen)
    const models = this.core.offered()
    const asked = chosen === null ? null : agentSettings(runsAs, projection.session.settings, models?.map((model) => model.id))
    for (const note of asked?.notes ?? []) this.say("agents", note)
    // An effort the agent names that the model does not offer is not sent: the child then runs with this session's settings.
    const usable = asked !== null && (models === null || settingsProblem(asked.settings, models) === null)
    if (asked !== null && !usable) this.say("agents", `The agent "${runsAs!.name}" names settings the provider does not offer; its subagent runs with this session's.`)
    const childSettings = asked !== null && usable ? asked.settings : projection.session.settings
    const childId = this.core.ids.session()
    const spawnId = this.core.ids.spawn()
    const title = taskTitle(input.task)
    let worktree: WorktreeRecord | null = null
    let cwd = projection.session.cwd
    if (input.worktree === true) {
      const made = await createWorktree({ cwd, directory: join(settings.worktreeDir, childId), branch: worktreeBranch(childId) })
      if ("error" in made) return toolResult("error", `The subagent was not started: ${made.error}`)
      worktree = made.worktree
      cwd = made.cwd
    }
    const background = input.background === true
    const discard = async (why: unknown) => {
      if (worktree !== null) await removeWorktree(worktree, { keepBranch: false })
      return toolResult("error", `The subagent was not started: ${describe(why)}`)
    }
    if (context.signal.aborted) return discard(callStopReasonOf(context.signal) === "call" ? "the user stopped this call" : "the session was interrupted")
    try {
      // Write-ahead: the parent's log names the child before the child exists.
      this.write([event("spawn.started", { spawnId, messageId: context.messageId, callId: context.callId, background, work: { kind: "subagent", sessionId: childId, worktree, ...(runsAs === null ? {} : { agent: runsAs.name }) } })])
    } catch (error) {
      return discard(error)
    }
    this.probe("spawn.started")
    let child: LiveSession
    try {
      const store = storeErrors(() => this.core.stores.create(childId))
      child = new LiveSession(this.core, childId, store)
      try {
        child.write([
          event("session.created", { cwd, title, lineage: { kind: "spawn", parentSessionId: this.id, spawnId, depth: depth + 1, worktree }, settings: childSettings }),
          // What it runs as is recorded with it, before its first baseline, which carries the instructions.
          ...(runsAs === null ? [] : [event("agent.switched", { messageId: null, from: null, to: runsAs })]),
        ])
        child.agentDecided = true
      } catch (error) {
        store.close()
        throw error
      }
      this.core.sessions.set(childId, child)
    } catch (error) {
      this.spawnEnded(spawnId, { outcome: "failed", detail: `It could not be started: ${describe(error)}`, exitCode: null, usage: null, tainted: false, merge: null }, null)
      return discard(error)
    }
    return this.runChild({ spawnId, child, title, worktree, background, message: taskMessage(input.task) }, context)
  }

  /** A follow-up message to a subagent this session started earlier: delivered to it while it runs, or the start of new work when it has ended. */
  private async followUp(input: SubagentInput, context: ToolContext, projection: Projection): Promise<ToolResult> {
    const spawned = projection.session.spawned
    const children = spawned?.children ?? []
    const named = input.session!
    const matches = children.includes(named as SessionId) ? [named as SessionId] : children.filter((id) => id.startsWith(named))
    const childId = matches[0]
    if (childId === undefined || matches.length > 1)
      return toolResult("error", `This session has ${matches.length > 1 ? "more than one" : "no"} subagent ${named}.${children.length === 0 ? " It has started none." : ` Its subagents: ${children.join(", ")}.`}`)
    const running = spawned?.running.find((entry) => entry.sessionId === childId)
    if (running !== undefined) {
      const child = this.spawns.get(running.spawnId)?.child
      if (child == null || child.closing !== null) return toolResult("error", `Subagent ${childId} cannot be reached right now.`)
      child.send(input.task)
      return toolResult(
        "success",
        `Sent to subagent ${childId}, which is still working: it reads the message at its next step. Its answer arrives ${running.background ? "as a message when it finishes" : "as the result of the call that started it"}.`,
        { subagent: { sessionId: childId, spawnId: running.spawnId, followUp: true } },
      )
    }
    let child = this.core.sessions.get(childId)
    try {
      if (child === undefined) {
        child = this.openChild(childId)
        child.recover("wait")
      }
    } catch (error) {
      return toolResult("error", `Subagent ${childId} cannot be opened: ${describe(error)}`)
    }
    const state = child.projection().session
    const lineage = state.lineage
    if (lineage?.kind !== "spawn" || lineage.parentSessionId !== this.id) return toolResult("error", `Session ${childId} is not a subagent of this session.`)
    if (lineage.worktree !== null && !existsSync(lineage.worktree.path))
      return toolResult("error", `Subagent ${childId} worked in a worktree of its own, which was removed when it finished. Start a new subagent for further work.`)
    if (child.working || state.execution !== null) return toolResult("error", `Subagent ${childId} is busy.`)
    const spawnId = this.core.ids.spawn()
    const background = input.background === true
    try {
      this.write([event("spawn.started", { spawnId, messageId: context.messageId, callId: context.callId, background, work: { kind: "subagent", sessionId: childId, worktree: null } })])
    } catch (error) {
      return toolResult("error", `The follow-up was not sent: ${describe(error)}`)
    }
    return this.runChild({ spawnId, child, title: state.title ?? taskTitle(input.task), worktree: null, background, message: input.task }, context)
  }

  /** Opens a child session of this one for writing, without recovering or resuming it. */
  private openChild(childId: SessionId): LiveSession {
    const store = storeErrors(() => this.core.stores.open(childId))
    const child = new LiveSession(this.core, childId, store)
    this.core.sessions.set(childId, child)
    return child
  }

  /**
   * One piece of a subagent's work, from its message to its recorded end.
   * In the foreground the call waits for it, and its end is the call's
   * result; in the background the call returns at once and the end arrives
   * as a message that wakes this session.
   */
  private async runChild(
    work: { readonly spawnId: string; readonly child: LiveSession; readonly title: string; readonly worktree: WorktreeRecord | null; readonly background: boolean; readonly message: string },
    context: ToolContext,
  ): Promise<ToolResult> {
    const { spawnId, child } = work
    this.children.add(child)
    // It asks through this session's client, or nobody; it runs under this session's approval settings.
    child.setAttended(this.attended && this.childQuestions, { children: this.childQuestions })
    if (this.override !== null) child.setApproval(this.override)
    const fromSeq = child.projection().lastSeq
    const forward = child.subscribe((item) => {
      if ("seq" in item) this.ephemeral({ type: "child.event", sessionId: this.id, child: child.id, spawnId, title: work.title, event: item })
    })
    let finish = () => {}
    const live: LiveSpawn = { spawnId, background: work.background, child, fromSeq, command: null, stopping: null, result: null, watches: new Map(), done: new Promise<void>((resolve) => (finish = resolve)) }
    this.spawns.set(spawnId, live)
    const display = { subagent: { sessionId: child.id, spawnId, title: work.title, background: work.background } }

    const ended = (async () => {
      try {
        child.send(work.message)
        await child.settled()
      } finally {
        forward()
      }
      let found = childResult(child.readEvents({ afterSeq: fromSeq }))
      // Stopped on request is said as that, whatever the child's log makes of the interrupt.
      if (live.stopping !== null && found.outcome !== "completed") found = { ...found, outcome: "stopped", detail: `It was stopped before it finished: ${STOPPED_BY[live.stopping]}.` }
      const tainted = child.approval()?.taint.tainted ?? false
      const merge = work.worktree === null ? null : await this.finishWorktree(work.worktree, work.title, found.outcome === "completed")
      const shown = renderChildResult(child.id, found, merge, tainted)
      live.result = shown
      return { found, merge, tainted, shown }
    })()
    const record = (end: { readonly found: ChildResult; readonly merge: MergeOutcome | null; readonly tainted: boolean; readonly shown: string }, message: { readonly origin: string; readonly text: string } | null) => {
      const { found, merge } = end
      this.spawnEnded(
        spawnId,
        {
          outcome: found.outcome,
          detail: found.detail,
          exitCode: null,
          usage: found.usage,
          tainted: end.tainted,
          merge: merge === null ? null : { status: merge.status, branch: merge.branch, commit: merge.commit, files: [...merge.files], conflicts: [...merge.conflicts], kept: merge.kept },
        },
        message,
      )
      this.spawns.delete(spawnId)
      finish()
    }
    const lost = (error: unknown) => {
      const found: ChildResult = { outcome: "failed", answer: "", detail: `It failed: ${describe(error)}`, steps: 0, toolCalls: 0, usage: null }
      return { found, merge: null, tainted: false, shown: renderChildResult(child.id, found, null, false) }
    }

    if (!work.background) {
      const stop = () => {
        // The turn was interrupted, or the user stopped this one call: either way the child stops as by its user.
        live.stopping ??= callStopReasonOf(context.signal) === "call" ? "call" : "interrupt"
        child.interrupt()
      }
      if (context.signal.aborted) stop()
      else context.signal.addEventListener("abort", stop, { once: true })
      const end = await ended.catch(lost)
      context.signal.removeEventListener("abort", stop)
      record(end, null)
      return toolResult(end.found.outcome === "completed" ? "success" : "error", end.shown, { subagent: { ...display.subagent, outcome: end.found.outcome, steps: end.found.steps, toolCalls: end.found.toolCalls } })
    }
    this.track(
      ended.catch(lost).then((end) => {
        const stopped = live.stopping
        // The stop tool's own result says how it ended.
        record(end, stopped === "tool" ? null : { origin: HARNESS_ORIGIN.subagentResult, text: end.shown })
        if (stopped === null) this.wake()
      }),
    )
    return toolResult("success", SPAWN_TEXT.startedSubagent(child.id), display)
  }

  /** What becomes of a subagent's worktree when its work ends: merged into this workspace when it finished, kept on its branch otherwise. */
  private finishWorktree(worktree: WorktreeRecord, title: string, completed: boolean): Promise<MergeOutcome> {
    const work = completed
      ? mergeWorktree(worktree, { title, probe: (point) => this.probe(point === "computed" ? "merge.computed" : "merge.writing") })
      : salvageWorktree(worktree, title)
    return work.catch(
      (error: unknown): MergeOutcome => ({ status: "failed", branch: worktree.branch, commit: null, files: [], conflicts: [], kept: true, message: `Its worktree could not be merged or removed (${describe(error)}); nothing was changed in this workspace.` }),
    )
  }

  private findSpawn(id: string): LiveSpawn | undefined {
    const all = [...this.spawns.values()]
    return all.find((live) => live.spawnId === id) ?? all.find((live) => live.child?.id === id) ?? all.find((live) => live.child?.id.startsWith(id) === true)
  }

  private noSuchSpawn(id: string): ToolResult {
    const running = [...this.spawns.values()].map((live) => (live.child === null ? live.spawnId : live.child.id))
    return toolResult("error", `No background work ${id} is running.${running.length === 0 ? "" : ` Running: ${running.join(", ")}.`} Work that has ended delivered its result as a message, or as the result of the call that started it.`)
  }

  /** The `background_output` tool. */
  async output(id: string, _context: ToolContext): Promise<ToolResult> {
    const live = this.findSpawn(id)
    if (live === undefined) return this.noSuchSpawn(id)
    if (live.command !== null) {
      const secrets = this.core.approvals?.secrets
      const printed = live.command.output()
      const shown = secrets === undefined ? printed : redact(aliased(printed, this.tempContext().temp), secrets).text
      return toolResult("success", `${live.spawnId} is still running.\n${shown.trim() === "" ? "It has printed nothing yet." : `Output so far:\n${shown.trimEnd()}`}`, { background: live.spawnId, running: true })
    }
    const child = live.child!
    const found = childResult(child.readEvents({ afterSeq: live.fromSeq }))
    // Its words may carry on what its own conversation holds: when that is untrusted content, the result says so,
    // and this session is tainted from this result on, as it would be by the child's answer when it ends.
    const tainted = found.answer !== "" && child.commandsNow()?.tainted === true
    return toolResult(
      "success",
      `Subagent ${child.id} is still working: ${found.steps} step${found.steps === 1 ? "" : "s"}, ${found.toolCalls} tool call${found.toolCalls === 1 ? "" : "s"} so far.${found.answer === "" ? "" : `\n\nIts latest words:\n${found.answer}`}`,
      { subagent: { sessionId: child.id, spawnId: live.spawnId, ...(tainted ? { tainted: true } : {}) }, running: true },
    )
  }

  /** The `background_stop` tool. */
  async stop(id: string, _context: ToolContext): Promise<ToolResult> {
    const live = this.findSpawn(id)
    if (live === undefined) return this.noSuchSpawn(id)
    live.stopping ??= "tool"
    if (live.command !== null) void live.command.stop().catch(() => {})
    else live.child!.interrupt()
    await live.done
    return toolResult("success", live.result ?? `${id} was stopped.`, live.command !== null ? { background: live.spawnId, running: false } : { subagent: { sessionId: live.child!.id, spawnId: live.spawnId }, running: false })
  }

  /**
   * What the log says this session spawned and nobody here runs was lost
   * with the process that ran it. A command died with that process (its
   * guard killed it). A subagent is looked at: one that had finished on its
   * own delivers its answer now; one that was cut off has its turn ended, so
   * that nothing takes it up half done. Either way the model is told.
   */
  private reapSpawned(): void {
    const running = this.projection().session.spawned?.running ?? []
    for (const entry of running) {
      if (this.spawns.has(entry.spawnId)) continue
      if (entry.kind === "command") {
        this.spawnEnded(
          entry.spawnId,
          { outcome: "lost", detail: SPAWN_TEXT.commandLostDetail, exitCode: null, usage: null, tainted: false, merge: null },
          { origin: HARNESS_ORIGIN.spawnLost, text: SPAWN_TEXT.commandLost(entry.spawnId, entry.command, entry.logPath, (entry.watches ?? []).filter(watchInForce)) },
        )
        continue
      }
      // Held here, as work in progress, until its end is recorded.
      let finish = () => {}
      const live: LiveSpawn = { spawnId: entry.spawnId, background: entry.background, child: null, fromSeq: 0, lost: true, command: null, stopping: null, result: null, watches: new Map(), done: new Promise<void>((resolve) => (finish = resolve)) }
      this.spawns.set(entry.spawnId, live)
      this.track(
        this.reapChild(entry.spawnId, entry.sessionId!, entry.worktree).finally(() => {
          this.spawns.delete(entry.spawnId)
          finish()
        }),
      )
    }
  }

  private async reapChild(spawnId: string, childId: SessionId, worktree: WorktreeRecord | null): Promise<void> {
    let found: ChildResult = { outcome: "lost", answer: "", detail: "It was never started: the harness restarted first.", steps: 0, toolCalls: 0, usage: null }
    let tainted = false
    let title = childId as string
    try {
      const summary = this.core.stores.get(childId)
      if (summary !== null) {
        title = summary.session.title ?? title
        let cut = false
        if (summary.session.execution !== null) {
          // Cut off with this session, or shut down with it. Its turn is ended here.
          const open = this.core.sessions.get(childId)
          const child = open ?? this.openChild(childId)
          cut = child.endClaim()
          if (open === undefined) await child.close()
        }
        const events = this.core.stores.read(childId, (store) => store.readEvents(childId))
        const started = events.findLastIndex((item) => item.type === "execution.started")
        found = childResult(started === -1 ? events : events.slice(started))
        if (cut || found.outcome !== "completed") found = { ...found, outcome: "lost", detail: "It was cut off when the harness restarted." }
        tainted = this.core.stores.get(childId)?.session.approval?.taint != null
      }
    } catch (error) {
      found = { ...found, outcome: "lost", detail: `It was lost when the harness restarted, and its session cannot be read: ${describe(error)}` }
    }
    const merge = worktree === null ? null : await this.finishWorktree(worktree, title, found.outcome === "completed")
    this.spawnEnded(
      spawnId,
      {
        outcome: found.outcome,
        detail: found.detail,
        exitCode: null,
        usage: found.usage,
        tainted,
        merge: merge === null ? null : { status: merge.status, branch: merge.branch, commit: merge.commit, files: [...merge.files], conflicts: [...merge.conflicts], kept: merge.kept },
      },
      { origin: found.outcome === "completed" ? HARNESS_ORIGIN.subagentResult : HARNESS_ORIGIN.spawnLost, text: renderChildResult(childId, found, merge, tainted) },
    )
  }

  /**
   * Ends a claim that nobody works on, as an interrupt by the session's
   * user: for a subagent whose parent lost it. Returns whether there was one.
   */
  endClaim(): boolean {
    if (this.run !== null) return false
    this.recover("wait")
    const execution = this.projection().session.execution
    if (execution === null) return false
    if (execution.status === "suspended") this.write([event("execution.resumed", { executionId: execution.id })])
    this.write([event("execution.interrupt_requested", { executionId: execution.id, reason: "user" })])
    // Recovery finishes a requested interrupt: the marker and the release.
    this.recover("wait")
    return true
  }

  // ---- replay ----

  /**
   * Makes this (new) session the replay of a recording and starts it. The
   * replay asks nobody and runs nothing outside the sandbox: its approval
   * settings are its own, whatever the user's are.
   */
  beginReplay(setup: { readonly sourceId: SessionId; readonly tape: Tape; readonly source: readonly StoredEvent[]; readonly baseline: EventData<"baseline.set">; readonly request: ReplayRequest; readonly policy: ReplayPolicyKind; readonly copy: string | null; readonly copyMade: boolean }): Promise<ReplayOutcome> {
    const { tape, request, copy } = setup
    let resolveOutcome: (outcome: ReplayOutcome) => void = () => {}
    const done = new Promise<ReplayOutcome>((resolve) => (resolveOutcome = resolve))
    const originals = [...new Set([resolve(tape.cwd), ...(existsSync(tape.cwd) ? [realpathSync(tape.cwd)] : [])])].filter((path) => path !== "/")
    const swap = (value: string, from: readonly string[], to: string) => from.reduce((mapped, path) => (path === to ? mapped : mapped.split(path).join(to)), value)
    const workspace: ReplayWorkspace | null =
      copy === null
        ? null
        : {
            cwd: copy,
            runtime: this.core.runtime,
            prepare: (divergence) => this.leaveTape(divergence),
            // A path the model writes as the recording's workspace means the copy, and the copy is named as the recording's workspace again.
            mapArguments: (value) => swap(value, originals, copy),
            mapOutput: (value) => swap(value, [copy, ...(existsSync(copy) ? [realpathSync(copy)] : [])], tape.cwd),
          }
    const replay = createReplay(tape, {
      tools: this.core.runtime.tools,
      strict: request.strict === true,
      normalisers: request.normalisers ?? DEFAULT_NORMALISERS,
      policy: setup.policy === "stop" || workspace === null ? { kind: "stop" } : { kind: setup.policy, workspace },
    })
    this.director = {
      replay,
      sourceId: setup.sourceId,
      source: setup.source,
      baseline: setup.baseline,
      copy,
      copyMade: setup.copyMade,
      live: false,
      keepSettings: request.model !== undefined || request.effort !== undefined,
      maxSteps: request.maxSteps ?? tape.steps.length + 10,
      asked: 0,
      resolve: resolveOutcome,
    }
    this.attended = false
    this.override = { mode: "auto", unattended: "deny" }
    const executionId = this.core.ids.execution()
    this.write([event("execution.started", { executionId })])
    this.launch(executionId)
    return done
  }

  /**
   * The replay loop: before each step the recording's inputs that are due
   * are added as the messages they were, then one model call is made and its
   * calls are answered from the recording (`runTools`). It ends when the
   * recording does, when the model leaves it under the `stop` policy, or
   * where the recording does something a replay cannot reproduce. Once the
   * model has left the recording under a policy that runs tools, the replay
   * is an ordinary turn in the copy of the workspace, and the ordinary loop
   * finishes it: its step limit, its checks, its ending.
   */
  private async replayLoop(run: Run, director: Director): Promise<void> {
    const signal = run.interrupt.signal
    const replay = director.replay
    if (this.projection().baseline === null) this.write([event("baseline.set", director.baseline)])
    for (let made = 0; ; made += 1) {
      this.probe("step.boundary")
      if (signal.aborted) return this.finishInterrupt(run)
      if (replay.status === "on_tape") this.deliverRecorded(director, replay.takeInputs())
      if (replay.status === "off_tape") return this.loop(run)
      if (replay.status === "on_tape" && made >= director.maxSteps) replay.fail(`gave up after ${made} model calls: the recording has ${replay.tape.steps.length} steps`)
      if (replay.status !== "on_tape") return this.endReplayRun(run, replay.report().reason)
      if ((await this.step(run, this.prepare(this.projection(), "auto"))) === "done") return
    }
  }

  /** Adds the recording's inputs to history as what they were: the user's messages, the harness's notes, instruction updates, settings. */
  private deliverRecorded(director: Director, inputs: ReturnType<Replay["takeInputs"]>): void {
    const ids = this.core.ids
    for (const input of inputs) {
      switch (input.kind) {
        case "message": {
          const messageId = ids.message()
          // A user's message goes through the inbox, as it did; a harness message is appended where it was.
          if (input.from === "user")
            this.write([event("inbox.enqueued", { messageId, origin: null, delivery: "steer", content: input.content }), event("inbox.delivered", { messageId })])
          else this.write([event("synthetic.appended", { messageId, origin: input.origin ?? "harness", content: input.content })])
          break
        }
        case "instruction":
          this.write([event("instruction.appended", { messageId: ids.message(), source: input.source, text: input.text, fingerprint: input.fingerprint })])
          break
        case "settings":
          if (!director.keepSettings) this.changeSettings(input.settings)
          break
        // The first baseline is the replay's own, changed; a later one follows a compaction, where the replay has stopped.
        case "baseline":
        case "unsupported":
          break
      }
    }
  }

  /**
   * Ends the execution of a replay that is over. Where the model has
   * answered, it ends as any turn does (nothing was verified); where it has
   * not (the replay stopped at a call, or the recording itself ends there),
   * the execution has no answer to end on and says so.
   */
  private endReplayRun(run: Run, reason: string): void {
    const projection = this.projection()
    if (wouldGoIdle(projection) && projection.inbox.length === 0) this.write([event("execution.succeeded", { executionId: run.executionId, verification: { status: "not_configured" } })])
    else this.write([event("execution.failed", { executionId: run.executionId, message: REPLAY_TEXT.ended(reason), cause: "replay" })])
  }

  /**
   * The replay left its recording under a policy that runs tools: the
   * recorded workspace, as it was at that point, is restored into the copy,
   * and from here the session works there. Called once, before the first
   * tool runs for real.
   */
  private async leaveTape(divergence: Divergence): Promise<void> {
    const director = this.director
    if (director === null || director.copy === null) throw new Error("the replay has no copy of the workspace")
    const step = divergence.recordedStep === null ? undefined : director.replay.tape.steps[divergence.recordedStep]
    const snapshot = snapshotAtDivergence(director.source, step?.seq ?? null)
    if (snapshot !== null) {
      const exported = await this.core.exportSnapshot(director.replay.tape.cwd, snapshot, director.copy)
      if ("kind" in exported) throw new Error(exported.message)
    }
    this.write([event("replay.diverged", { workspace: director.copy, snapshot, divergence: divergence.kind })])
    director.live = true
    this.probe("replay.diverged")
    // The step in progress is the first whose tools run for real. Whether to bracket it with snapshots was decided
    // while the replay was still on its recording (nothing ran then), so its `step_start` is taken here: the copy as
    // it was restored, before the first tool touches it. Its `step_end` follows the tools (`closeStep`).
    const inProgress = openStep(this.projection())
    if (inProgress !== null && this.core.openSnapshots !== null) await this.snapshot("step_start", inProgress.id)
    // The copy's own configuration: its checks run there when the turn ends, in the sandbox like its commands.
    const load = this.core.loadConfig
    if (load !== null) this.config = await load(director.copy).catch(() => null)
  }

  /** Records how the replay ended and hands the outcome to whoever started it. Called when its execution is over, however that came about. */
  private concludeReplay(): void {
    const director = this.director
    if (director === null) return
    this.director = null
    const replay = director.replay
    // A replay that never left its recording ran no tool: the directory made for its copy was never written to.
    // (`rmdir` removes an empty directory only, so nothing a caller put there is ever lost.)
    if (!director.live && director.copy !== null && director.copyMade) {
      try {
        rmdirSync(director.copy)
      } catch {
        // Not empty, or already gone: left as it is.
      }
    }
    try {
      const projection = this.projection()
      // It did not end by itself: an interrupt, a provider failure, a failure of the loop.
      if (replay.status === "on_tape" || (replay.status === "off_tape" && projection.session.execution !== null) || (replay.status === "off_tape" && !wouldBeDone(projection)))
        replay.fail(lastFailure(projection) ?? REPLAY_TEXT.interrupted)
      const report = replay.report()
      if (projection.session.replay?.ended === null)
        this.write([event("replay.ended", { outcome: report.status, reason: report.reason, report: JSON.parse(JSON.stringify(report)) as Json })])
      const requests = this.store.readRequests(this.id)
      director.resolve({
        sessionId: this.id,
        sourceSessionId: director.sourceId,
        report,
        workspace: director.live ? director.copy : null,
        usage: requests.reduce<Usage | null>((sum, row) => addUsage(sum, row.usage), null),
        requests: requests.length,
      })
    } catch (error) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `the replay's end could not be recorded: ${describe(error)}`, cause: error })
      director.resolve({ sessionId: this.id, sourceSessionId: director.sourceId, report: replay.report(), workspace: director.live ? director.copy : null, usage: null, requests: 0 })
    }
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
    if (tool.delegates === true) {
      // Nothing to decide here: what the subagent does is decided call by call in its own session.
      this.decided.set(key, { run: runRecord(this.policy().policy, facts, null), before: [], stop: null })
      return { kind: "run" }
    }
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
    const config = this.currentConfig()
    const resolved = effectivePolicy({
      file: config?.approval?.user ?? null,
      process: this.core.approvals?.user ?? null,
      session: this.override,
      project: config?.approval?.project ?? null,
    })
    // The agent the session runs as can only tighten the mode, whoever wrote its definition.
    const agent = this.store.getProjection(this.id)?.session.agent ?? null
    if (agent === null || agent.restrictions.approval === null) return resolved
    const tightened = effectiveApprovalMode(resolved.policy.mode, agent)
    if (tightened.ignored !== null) this.say("agents", tightened.ignored)
    return tightened.mode === resolved.policy.mode ? resolved : { ...resolved, policy: { ...resolved.policy, mode: tightened.mode } }
  }

  /**
   * The configuration this session's decisions are made under. An execution
   * reads it when it starts; before the first one of this process it is
   * read here, once and without waiting, so that a client that asks how
   * calls are decided before the first turn is told what the files say. A
   * file that cannot be read says so when the execution starts, as always.
   */
  private currentConfig(): SessionConfig | null {
    if (this.configRead || this.director !== null) return this.config
    this.configRead = true
    const load = this.core.loadConfigSync
    if (load === null) return this.config
    try {
      this.config = load(this.projection().session.cwd)
    } catch {
      this.config = null
    }
    return this.config
  }

  private sandboxState(): SandboxState {
    const state = this.core.approvals!.sandbox().state
    return state.available ? { available: true } : { available: false, reason: state.reason }
  }

  /**
   * The session's taint, derived from its log: the fold of `approval/taint.ts`
   * over every tool result, clearing and compaction in it. A fork's log is
   * its own events, after what its first event carries of the history it
   * inherited: the parent's file is never read for it.
   */
  private taint(policy: ApprovalPolicy): TaintState {
    this.taintHistory ??= taintHistoryOf(this.store, this.id)
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
  private notice(kind: Extract<EphemeralEvent, { type: "notice" }>["kind"], message: string): void {
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

  /** What `tool.settled` records for an outcome of the runtime. `signal` is the call's own. */
  private settlement(result: ToolCallOutcome, effect: ToolEffect | undefined, signal: AbortSignal) {
    if (result.kind !== "crashed") return result.settlement
    // A tool that threw while it was being stopped reported nothing: the outcome follows from its effect class,
    // and the text says who stopped it (an interrupt of the turn, or the user stopping this one call).
    if (signal.aborted) {
      const base = { truncation: null, attachments: [], display: null }
      const texts = callStopReasonOf(signal) === "call" ? CANCELLED : STOPPED
      return effect === "read"
        ? { ...base, outcome: "error" as const, output: texts.read }
        : { ...base, outcome: "effect_unknown" as const, output: texts.effectUnknown }
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
   *    aggressive straight away (it does not). Nor is one whose result is
   *    known beforehand not to fit: the size after it is predicted from what
   *    cannot be removed, the bounds of the summary and the checkpoint, and
   *    the tail it would keep, and when the policy would find that too large
   *    for the window at the next boundary, the compaction is aggressive at
   *    once, so the turn pays for one summary call and not for two.
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
  private async compact$(run: Run, plan: CompactionPlan): Promise<"compacted" | "nothing" | "done"> {
    const { limits, clock, ids, compaction: config } = this.core
    const signal = run.interrupt.signal
    const start = this.projection()
    const view = selectModelHistory(start).messages
    let mode = plan.mode
    let tail = chooseTail(view, { budget: plan.tailBudget, mandatory: mode === "aggressive" ? "if_fits" : "always" })
    if (mode === "normal" && plan.otherwise !== undefined) {
      // What must be kept (one large tool result, say) is most of the context: a normal compaction would cost a
      // summary call and free too little. While the request still fits, nothing is done; when it does not, the
      // compaction is aggressive at once instead of after a normal one that could not have helped.
      const freesTooLittle = tail.removedTokens < config.minFreedRatio * (tail.removedTokens + tail.keptTokens)
      if (freesTooLittle && plan.otherwise.fits) return "nothing"
      // Or it frees enough and what it keeps is still too much. The request after it is known before the summary
      // is asked for, up to the size of the checkpoint: it cannot fit when it is larger than the usable window with
      // the summary and the checkpoint at their bounds, and the policy will find it too large at the next boundary,
      // whatever the checkpoint's size, when what is kept alone is, as an estimate with its margin. Either way a
      // normal compaction would be followed at once by an aggressive one, for a second summary call; that one is
      // made now instead.
      const largest = this.sizeAfterCompaction(start.baseline, config.summaryMaxTokens + config.checkpointExtraMaxTokens, tail.keptTokens)
      const smallest = this.sizeAfterCompaction(start.baseline, 0, tail.keptTokens)
      const cannotFit = largest > plan.otherwise.usable || smallest + estimatorMargin(smallest) > plan.otherwise.usable
      if (freesTooLittle || cannotFit) {
        mode = "aggressive"
        tail = chooseTail(view, { budget: plan.otherwise.aggressiveBudget, mandatory: "if_fits" })
      }
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
        event("compaction.failed", { messageId, error: { kind: "provider", error }, calls: attempt - 1 }),
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
    // The model's task list is the latest `todo` call's; when that call is being removed, the checkpoint carries the
    // list. A later call in the kept tail says it there, and an empty list says nothing.
    const list = currentTodos(earlier)
    const todos = list !== null && list.items.length > 0 && currentTodos(now.messages.filter((message) => message.seq >= keepFromSeq)) === null ? renderTodos(list) : null
    // The request is not in the kept tail. That is work in progress only while something is still unanswered: a
    // compaction the user asks for after the model's answer cut a turn that is over.
    const checkpoint = buildCheckpoint({ summary: chosen.summary, earlier, inProgress: tail.midTurn && !wouldGoIdle(start), todos })
    const tokensAfter = this.sizeAfterCompaction(baseline, checkpoint.tokens, tail.keptTokens)
    // Every summary request counted up `attempt`: the retries of one that failed and the repair are requests too.
    this.write([event("compaction.ended", { messageId, summary: checkpoint.text, source: chosen.source, detail: chosen.detail, tokensAfter, usage, calls: attempt - 1 })])
    this.probe("compaction.ended")
    return "compacted"
  }

  /** How many summary requests the ledger has for a compaction: one row per request, written before it is sent. */
  private summaryCalls(messageId: MessageId): number {
    return this.store.readRequests(this.id).filter((row) => row.purpose === "compaction" && row.messageId === messageId).length
  }

  /**
   * The estimated size of the first request after a compaction: what no
   * compaction removes (the instructions and the tool list of `baseline`),
   * the checkpoint in its envelope, and the kept tail. With the checkpoint
   * at its bounds it is the largest that request can be, known before the
   * summary is asked for.
   */
  private sizeAfterCompaction(baseline: Projection["baseline"], checkpointTokens: number, keptTokens: number): number {
    const envelope = estimateTokens(`${harnessOpen(CHECKPOINT_ORIGIN)}\n\n${HARNESS_CLOSE}`)
    const fixed = baseline === null ? 0 : estimateTokens(baseline.instructions) + baseline.tools.reduce((sum, tool) => sum + estimateTool(tool), 0)
    return REQUEST_OVERHEAD + fixed + ITEM_OVERHEAD + envelope + checkpointTokens + keptTokens
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
   * a user's cancel still leaves the marker (unless the execution had no
   * turn, `turnless`), a shutdown at a boundary cut nothing short and
   * leaves none. `usage` is what the provider reported for
   * the open step's model call, when it reported anything before the stop.
   */
  private finishInterrupt(run: Run, partialText = "", usage: Usage | null = null, stopHooks: readonly NewEvent<"hook.ran">[] = []): void {
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
      // The hooks that had finished for a call the interrupt reached first are still on record, before the call is settled.
      const unsettled = new Set(step.parts.flatMap((part) => (part.type === "tool_call" && part.state.status !== "settled" ? [callKey(step.id, part.callId as CallId)] : [])))
      for (const [key, records] of this.hookRecords) if (unsettled.has(key)) events.push(...records.filter((record) => record.data.point !== "afterTool" || this.callRunning(step, record.data.callId)))
      events.push(...settleUnsettled(step, STOPPED), event("step.failed", { messageId: step.id, error, usage }))
      cutShort = true
    }
    this.hookRecords.clear()
    const open = projection.session.open
    if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error, calls: this.summaryCalls(open.messageId) }))
    // A run of checks that was stopped says nothing about the code.
    if (open?.kind === "checks") events.push(event("checks.failed", { run: open.run, error }))
    // The stop hooks that had answered when the interrupt came are on record too.
    events.push(...stopHooks)
    // The marker tells the model that its turn was cut short. An execution without a turn (a compaction the user
    // asked for, and nothing else) has none to tell about: the conversation stays as it was.
    if (cutShort || (reason === "user" && !turnless(projection)))
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
      if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error: failure, calls: this.summaryCalls(open.messageId) }))
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
    const lineage = projection.session.lineage
    const depth = lineage?.kind === "spawn" ? lineage.depth : 0
    const offered =
      baseline === null
        ? // A subagent's turn is not verified (its parent's is), so it has nothing to acknowledge.
          this.config !== null && this.config.config.verify.mode !== "off" && depth === 0
        : baseline.tools.some((tool) => tool.name === ACKNOWLEDGE_TOOL_NAME)
    const spawn = this.core.spawn
    // The tools of spawned work, like the acknowledgement tool, are in the list or not from the first baseline on. A
    // session at the depth limit is not offered `subagent`: it could only be refused.
    const spawning =
      baseline !== null
        ? [this.core.spawning.subagent, ...this.core.spawning.management].filter((tool) => baseline.tools.some((known) => known.name === tool.name))
        : spawn === null
          ? []
          : [...this.core.spawning.management, ...(depth < spawn.maxDepth ? [this.core.spawning.subagent] : [])]
    // The tools of the features an engine may offer, by the same rule: in the list or not from the first baseline
    // on, and their specs never change. Skills and MCP are offered to every session, whether or not a skill or a
    // server exists yet, so that one appearing later needs no change of the list.
    const kept = (tools: readonly AnyTool[], first: boolean) => (baseline !== null ? tools.filter((tool) => baseline.tools.some((known) => known.name === tool.name)) : first ? tools : [])
    // Wake-ups are offered to a session a person started while they are enabled: a subagent has nobody to wake for.
    const features = [
      ...kept(this.core.skills === null ? [] : [this.core.skills.tool], true),
      ...kept(this.core.mcp?.tools ?? [], true),
      ...kept(this.core.wake?.tools ?? [], depth === 0 && (this.wakeConfig()?.enabled ?? false)),
      // Memory is behind its flag: off unless the configuration read for this execution turns it on.
      ...kept(this.core.memory?.tools ?? [], depth === 0 && this.memoryConfig().enabled),
    ]
    // The history tools are in every list this build freezes: see `history.ts` for why they are there from the start.
    const own = new Set(
      [this.core.spawning.subagent, ...this.core.spawning.management, ...(this.core.skills === null ? [] : [this.core.skills.tool]), ...(this.core.mcp?.tools ?? []), ...(this.core.wake?.tools ?? []), ...(this.core.memory?.tools ?? [])].map((tool) => tool.name),
    )
    const tools = [...this.core.tools.filter((tool) => !own.has(tool.name)), ...this.core.history, ...spawning, ...features]
    return offered ? [...tools, this.core.acknowledge] : tools
  }

  // ---- what is appended, never in the baseline: skills, the MCP catalogue ----

  /** Whether the session's frozen tool list has the tool: what a feature offers a session follows its list, never the reverse. */
  private offers(projection: Projection, tool: string): boolean {
    return projection.baseline?.tools.some((known) => known.name === tool) ?? false
  }

  /** The two configuration files the execution in progress (or the latest one) read, or, before the first one, as they are now. */
  private files() {
    return this.currentConfig()?.files ?? null
  }

  /** Where this session's skills are looked for besides its working directory. */
  skillPlaces(): SkillPlaces {
    const skills = this.core.skills
    return skillPlaces(this.files(), { configDir: skills?.configDir ?? configDirectory(), ...(skills?.home === undefined ? {} : { home: skills.home }) })
  }

  skills = (): SkillSet | null => (this.core.skills === null ? null : findSkills(this.projection().session.cwd, this.skillPlaces()))

  /**
   * The sources that are appended when they changed, as they are now: the
   * skill index and the MCP catalogue, each only for a session whose frozen
   * tool list has the tool to act on it.
   */
  private appendedSources(projection: Projection): AppendedSource[] {
    const sources: AppendedSource[] = []
    if (this.core.skills !== null && this.offers(projection, this.core.skills.tool.name)) {
      const set = findSkills(projection.session.cwd, this.skillPlaces())
      // What could not be loaded is the user's to read, once; the model is told about the skills that exist.
      for (const problem of set.problems) this.say("skills", describeSkillProblem(problem))
      sources.push(skillsSource(set))
    }
    const mcp = this.core.mcp
    if (mcp !== null && mcp.tools.every((tool) => this.offers(projection, tool.name))) sources.push(catalogueAppended(this.mcpServers().servers()))
    // The list of agents, for a session that can run a subagent as one.
    if (this.core.agents !== null && this.offers(projection, SUBAGENT_TOOL)) {
      const set = findAgents(projection.session.cwd, this.agentPlaces())
      for (const problem of set.problems) this.say("agents", describeAgentProblem(problem))
      sources.push(agentIndexAppended(set))
    }
    const notes = this.memoryStore(projection)
    if (notes !== null)
      sources.push(memorySource({ session: this.id, store: notes, config: this.memoryConfig(), now: new Date(this.core.clock.now()), problem: (message) => this.say("memory", message) }))
    return sources
  }

  /** Says something about a feature to the user, once per process. */
  say(kind: "skills" | "mcp" | "wake" | "memory" | "agents" | "hooks" | "lsp" | "telemetry" | "history", message: string): void {
    if (this.noticed.has(`${kind}:${message}`)) return
    this.noticed.add(`${kind}:${message}`)
    this.core.report({ kind, sessionId: this.id, message })
  }

  // ---- memory ----

  /** This session's memory settings, from the configuration its latest execution read. Off without one. */
  memoryConfig(): MemoryConfig {
    return sessionMemoryConfig(this.files())
  }

  /** The store of this session's notes, opened on first use and again when the configuration moves it. */
  private notes: { readonly key: string; readonly store: MemoryStore } | null = null

  /**
   * The session's notes, or `null` when memory does not exist for it: the
   * engine offers none, the flag is off now, or its frozen tool list was
   * set without the memory tools (the flag was off then, or it is a subagent).
   *
   * A session that has no baseline yet has no list to follow. The loop takes
   * it to have no memory: nothing is delivered and nothing is recorded before
   * the list is frozen. With `ahead`, the answer is the one the first
   * baseline will give, by the rule it freezes the list with
   * (`offeredTools`): a session a person started, with the flag on in the
   * files as they are now.
   */
  memoryStore(projection: Projection = this.projection(), ahead = false): MemoryStore | null {
    const memory = this.core.memory
    if (memory === null) return null
    const offered =
      projection.baseline === null
        ? ahead && projection.session.lineage?.kind !== "spawn" && projection.session.replay === undefined
        : memory.tools.every((tool) => this.offers(projection, tool.name))
    if (!offered) return null
    const config = this.memoryConfig()
    if (!config.enabled) return null
    const projectDir = this.config?.projectDir ?? projection.session.cwd
    const key = `${projectDir}\u0000${config.inRepository}`
    if (this.notes?.key !== key)
      this.notes = { key, store: openSessionMemory({ dataDir: this.core.dataDir, projectDir, config, now: () => new Date(this.core.clock.now()), ...(memory.setup.newId === undefined ? {} : { newId: memory.setup.newId }) }) }
    return this.notes.store
  }

  memory = (): { readonly config: MemoryConfig; readonly store: MemoryStore } | null => {
    // Also before the first turn: the user's own note is saved then, and is in the block the first turn is given.
    const store = this.memoryStore(this.projection(), true)
    return store === null ? null : { config: this.memoryConfig(), store }
  }

  /** Records, in memory's usage log, how a turn ended: what the per-note statistics and the A/B comparison are computed from. */
  private recordOutcomes(stored: readonly StoredEvent[]): void {
    for (const item of stored) {
      const outcome = memoryOutcome(item)
      if (outcome === null) continue
      try {
        this.memoryStore()?.recordUsage({ type: "outcome", session: this.id, at: new Date(this.core.clock.now()).toISOString(), turn: item.seq, outcome, entries: null, note: null })
      } catch (error) {
        // A usage log that cannot be written costs a statistic, never the turn.
        this.say("memory", `An outcome could not be recorded in memory's usage log: ${describe(error)}`)
      }
    }
  }

  // ---- wake-ups ----

  /** This session's wake-up settings: the user's, tightened by the project's file. `null` when the engine offers no wake-ups. */
  wakeConfig(): WakeConfig | null {
    return this.core.wake === null ? null : sessionWakeConfig(this.files(), this.core.wake.user)
  }

  /** What the approval layer lets this session's commands have right now: the mode, and whether untrusted content is in the conversation. `null` when the layer is off. */
  commandsNow(): { readonly mode: ApprovalPolicy["mode"]; readonly tainted: boolean } | null {
    if (this.core.approvals === null) return null
    const policy = this.policy().policy
    return { mode: policy.mode, tainted: policy.taint === "enforce" && this.taint(policy).tainted }
  }

  // ---- MCP servers ----

  /** This session's servers, as its bridge tools and its catalogue read them. */
  mcpServers(): SessionServers {
    this.mcpBackend ??= sessionServers(new Map([...this.mcpHeld].map(([name, held]) => [name, held.registry])), this.mcpPlan.filter((plan) => plan.config.enabled && !plan.approved))
    return this.mcpBackend
  }

  mcp = (): McpState | null => {
    if (this.core.mcp === null) return null
    // Before the first turn of this process the files are read here, as they are now: a project's server can be
    // approved, and the user's own are starting, before the first request is built. (A replay names no servers.)
    if (!this.mcpRead && this.director === null && this.projection().session.replay === undefined) this.attachMcp()
    return this.mcpNow()
  }

  /** The servers as the configuration that was read last has them: none before one was read. */
  private mcpNow(): McpState {
    return { servers: this.mcpServers().status(), awaiting: this.mcpPlan.filter((plan) => plan.config.enabled && !plan.approved).map(serverQuestion) }
  }

  // ---- what a client is told changed ----

  onFeatureChange = (listener: (feature: SessionFeature) => void): (() => void) => {
    const entry = (feature: SessionFeature) => listener(feature)
    // Nothing is compared while nobody listens: the first listener starts from the state as it is now.
    if (this.featureListeners.size === 0) for (const feature of ["mcp", "hooks", "lsp"] as const) this.featureSeen[feature] = this.featureKey(feature)
    this.featureListeners.add(entry)
    return () => {
      this.featureListeners.delete(entry)
    }
  }

  /**
   * What `mcp()`, `hooks()` or `lsp()` would return, as a string to compare,
   * without reading a configuration that was not read yet (a session is
   * taken to have no servers and no hooks until then), and without
   * the countdown to a server's next attempt.
   */
  private featureKey(feature: SessionFeature): string {
    switch (feature) {
      case "mcp": {
        const state = this.core.mcp === null ? null : this.mcpNow()
        return JSON.stringify(state === null ? null : { servers: state.servers.map(({ retryInMs: _countdown, ...server }) => server), awaiting: state.awaiting })
      }
      case "hooks":
        return JSON.stringify(this.core.hooks === null ? null : { config: this.hookConfig, awaiting: hookQuestions(this.hookConfig, this.hookApproved) })
      case "lsp":
        return JSON.stringify(this.core.lsp === null ? null : this.lspNow())
    }
  }

  /** Something that one of the three reads has changed: the listeners are told if what it returns did. */
  private featureChanged(feature: SessionFeature): void {
    if (this.featureListeners.size === 0 || this.closing !== null) return
    const key = this.featureKey(feature)
    if (key === this.featureSeen[feature]) return
    this.featureSeen[feature] = key
    for (const listener of [...this.featureListeners]) {
      try {
        listener(feature)
      } catch (error) {
        this.core.report({ kind: "listener_failed", sessionId: this.id, message: describe(error), cause: error })
      }
    }
  }

  approveMcpServer = (name: string, fingerprint?: string): boolean => {
    this.assertOpen()
    // What waits is what `mcp()` says waits: before the first turn that reads the files as they are now.
    if (this.mcp() === null) return false
    const plan = this.mcpPlan.find((item) => item.config.name === name && !item.approved && item.config.enabled && (fingerprint === undefined || item.fingerprint === fingerprint))
    if (plan === undefined) return false
    const now = this.core.clock.now()
    addProjectGrants(this.core.grantsDir, realWorkspace(this.projection().session.cwd), [serverGrant(plan, now)], now)
    this.attachMcp()
    return true
  }

  /**
   * Takes hold of the servers the configuration names and may start, and lets
   * go of the ones it no longer names. A server the project's file names
   * and the user has not approved is not started: the user is told, once.
   * A subagent in its parent's directory shares its parent's servers.
   */
  private attachMcp(): void {
    const mcp = this.core.mcp
    if (mcp === null || this.closing !== null) return
    this.mcpRead = true
    const cwd = this.projection().session.cwd
    let plans: McpServerPlan[]
    try {
      plans = planServers(this.files(), readProjectGrants(this.core.grantsDir, realWorkspace(cwd), this.core.clock.now()), this.core.clock.now())
    } catch (error) {
      this.say("mcp", `The MCP servers of the configuration could not be read: ${describe(error)}`)
      return
    }
    this.mcpPlan = plans
    const wanted = new Map(plans.filter((plan) => plan.config.enabled && plan.approved).map((plan) => [plan.config.name, plan]))
    const acquired = new Map<string, { readonly key: string; readonly registry: McpRegistry; readonly unwatch: () => void }>()
    for (const [name, plan] of wanted) {
      const held = mcp.hub.acquire(plan.config, cwd)
      if (held !== null) acquired.set(name, { ...held, unwatch: held.registry.onStatus(() => this.featureChanged("mcp")) })
    }
    // Taken before the old ones are let go of, so a server both configurations name is never stopped in between.
    for (const held of this.mcpHeld.values()) {
      held.unwatch()
      mcp.hub.release(held.key)
    }
    this.mcpHeld.clear()
    for (const [name, held] of acquired) this.mcpHeld.set(name, held)
    this.mcpBackend = null
    this.featureChanged("mcp")
    for (const plan of plans) {
      if (!plan.config.enabled || plan.approved) continue
      const question = serverQuestion(plan)
      this.say("mcp", skippedServerNotice(question))
    }
  }

  private releaseMcp(): void {
    for (const held of this.mcpHeld.values()) {
      held.unwatch()
      this.core.mcp?.hub.release(held.key)
    }
    this.mcpHeld.clear()
    this.mcpBackend = null
  }

  // ---- hooks ----

  hooks = (): HooksState | null => {
    if (this.core.hooks === null) return null
    if (!this.hooksRead) this.attachHooks()
    return { config: this.hookConfig, awaiting: hookQuestions(this.hookConfig, this.hookApproved) }
  }

  approveHook = (fingerprint: string): boolean => {
    this.assertOpen()
    if (this.core.hooks === null) return false
    if (!this.hooksRead) this.attachHooks()
    if (!hookQuestions(this.hookConfig, this.hookApproved).some((question) => question.fingerprint === fingerprint)) return false
    const now = this.core.clock.now()
    addProjectGrants(this.core.grantsDir, realWorkspace(this.projection().session.cwd), [hookGrant(fingerprint, now)], now)
    this.hookApproved = new Set([...this.hookApproved, fingerprint])
    this.featureChanged("hooks")
    return true
  }

  /**
   * Reads the hooks the configuration names and which of the project's the
   * user approved. A project's hook nobody approved is not run: the user is
   * told, once. A replay runs none: it runs as its recording did.
   */
  private attachHooks(): void {
    try {
      this.readHooks()
    } finally {
      this.featureChanged("hooks")
    }
  }

  private readHooks(): void {
    this.hooksRead = true
    this.hookConfig = NO_HOOKS
    this.hookApproved = new Set()
    if (this.core.hooks === null || this.director !== null) return
    let config: HooksConfig
    try {
      config = sessionHooks(this.files())
    } catch (error) {
      this.say("hooks", `The hooks of the configuration could not be read: ${describe(error)}`)
      return
    }
    this.hookConfig = config
    for (const ignored of config.ignored) this.say("hooks", `The project's configuration asks for more than yours allows and was not followed: ${ignored}.`)
    if (!hasHooks(config)) return
    const now = this.core.clock.now()
    this.hookApproved = approvedHooks(readProjectGrants(this.core.grantsDir, realWorkspace(this.projection().session.cwd), now), now)
    for (const question of hookQuestions(config, this.hookApproved)) this.say("hooks", skippedHookNotice(question))
  }

  /** What a hook is run with at any of its points: how it may run under the policy in force, and where. */
  private hookContext(run: Run): HookPointContext {
    const approvals = this.core.approvals
    const policy = approvals === null ? null : this.policy().policy
    return {
      runner: this.core.hooks!.runner,
      trust: {
        // With the approval layer off every call runs as it is, and so does a hook.
        mode: policy?.mode ?? "full",
        tainted: policy !== null && policy.taint === "enforce" && this.taint(policy).tainted,
        sandboxAvailable: approvals !== null && approvals.sandbox().state.available,
        isApproved: (hook) => this.hookApproved.has(hook.fingerprint),
      },
      cwd: this.projection().session.cwd,
      sessionId: this.id,
      signal: run.interrupt.signal,
      untrustedRepository: this.untrustedProject(),
    }
  }

  /** Whether the project's configuration file is content the user marked untrusted (`approval.untrustedPaths`): what it chose to run is then a taint source. */
  private untrustedProject(): boolean {
    const config = this.config
    if (this.core.approvals === null || config === null || (config.files?.project ?? null) === null) return false
    const patterns = this.policy().policy.untrustedPaths
    if (patterns.length === 0) return false
    const own = join(`.${brand.directory}`, "config.json")
    const inside = relative(realWorkspace(this.projection().session.cwd), join(config.projectDir, own))
    // A project file above the working directory is matched as the project names it.
    const path = inside.startsWith("..") ? own : inside
    return patterns.some((pattern) => new Bun.Glob(pattern).match(path))
  }

  /** A call as a hook is told about it: the validated arguments, and the paths the tool says it touches. */
  private hookCall(call: ToolCallPart, tool: AnyTool, input: Json): ToolCallInput {
    const touches = this.core.touches.get(tool.name)
    let paths: readonly string[] | null = null
    if (touches !== undefined) {
      try {
        paths = touches(input)
      } catch {
        // Arguments the tool itself will refuse name nothing.
        paths = []
      }
    }
    return { tool: tool.name, callId: call.callId, arguments: input, paths }
  }

  /** Keeps the records of the hooks that applied to a call until its result is written, and tells the user about the ones that failed. */
  private keepHookRecords(messageId: MessageId, callId: CallId, records: readonly HookRecord[]): void {
    if (records.length === 0) return
    const key = callKey(messageId, callId)
    this.hookRecords.set(key, [...(this.hookRecords.get(key) ?? []), ...records.map((record) => hookRan(record, { messageId, callId }))])
    this.tellHookFailures(records)
  }

  private tellHookFailures(records: readonly HookRecord[]): void {
    for (const record of records) {
      // What became of the call is the hook's own choice (`onError`): the notice says which.
      const hook = record.point === "beforeTool" ? this.hookConfig.beforeTool.find((candidate) => candidate.id === record.hookId) : undefined
      const notice = failedHookNotice(record, hook?.onError)
      if (notice !== null) this.say("hooks", notice)
    }
  }

  /** Whether a call of the step has started and has no result yet: the state an after hook's record is written in. */
  private callRunning(step: AssistantMessage, callId: CallId | null): boolean {
    return step.parts.some((part) => part.type === "tool_call" && part.callId === callId && part.state.status === "running")
  }

  /**
   * Decides one call where hooks or language servers have a say: the before
   * hooks first (one that objects settles the call with its reason, and no
   * question is asked), then the approval layer, unchanged: a hook that
   * does not object approves nothing. For a write the language servers will
   * be asked about, the file's text is read once the call may run.
   */
  private async decideCall(run: Run, messageId: MessageId, call: ToolCallPart, tool: AnyTool, input: Json): Promise<Authorization> {
    const hooks = this.hookConfig.beforeTool
    if (hooks.length > 0) {
      const outcome = await runBeforeHooks(this.hookContext(run), hooks, this.hookCall(call, tool, input))
      this.keepHookRecords(messageId, call.callId, outcome.records)
      // The interrupt reached it while a hook ran: the runtime sees the abort and reports the call as not started.
      if (outcome.decision.kind === "interrupted" || run.interrupt.signal.aborted) return WITHDRAWN
      if (outcome.decision.kind === "refuse") return { kind: "refuse", output: outcome.decision.output }
    }
    const decided: Authorization = this.core.approvals === null ? { kind: "run" } : await this.authorize(run, messageId, call, tool, input)
    if (decided.kind === "run" && tool.effect === "write" && this.lspPlan !== null && this.lspHeld !== null) {
      const path = this.servedPath(tool, input, this.lspPlan)
      const document = path === null ? "unreadable" : readDocument(path)
      if (path !== null && document !== "unreadable") this.lspBefore.set(callKey(messageId, call.callId), { path, text: document === "missing" ? null : document.text })
    }
    return decided
  }

  /**
   * What follows a tool's result before it is capped and stored: the notes
   * of the after hooks, then the diagnostics of an edit, which are about
   * the file as the hooks left it. The tool's own output stays first, byte
   * for byte. Nothing here may fail the call: whatever goes wrong, the
   * result goes on as far as it got.
   */
  private async afterTool(run: Run, messageId: MessageId, call: ToolCallPart, tool: AnyTool, input: Json, result: ToolResult): Promise<ToolResult> {
    let noted = result
    try {
      const hooks = this.hookConfig.afterTool
      if (hooks.length > 0) {
        // A hook is shown the result as the model will be shown it: redacted. What it adds goes after the tool's own text.
        const secrets = this.core.approvals?.secrets
        const shown = secrets === undefined ? result : { ...result, output: redact(result.output, secrets).text }
        const outcome = await runAfterHooks(this.hookContext(run), hooks, this.hookCall(call, tool, input), shown)
        this.keepHookRecords(messageId, call.callId, outcome.records)
        const added = outcome.result.output.slice(shown.output.length)
        if (added !== "") noted = { ...result, output: `${result.output}${added}` }
        for (const hook of outcome.applied.dropped) this.say("hooks", `The note of the hook "${hook.name}" was left out: the notes on one result are bounded together.`)
      }
      noted = await this.diagnose(run, callKey(messageId, call.callId), tool, input, noted)
    } catch (error) {
      this.core.report({ kind: "internal_error", sessionId: this.id, message: `what follows a tool's result failed: ${describe(error)}`, cause: error })
    }
    return noted
  }

  // ---- language servers ----

  lsp = (): LspState | null => {
    if (this.core.lsp === null) return null
    if (!this.lspRead) this.attachLsp()
    return this.lspNow()
  }

  /** The language servers as the configuration that was read last has them: none before one was read. */
  private lspNow(): LspState {
    const held = this.lspHeld
    return held === null ? { configured: false, servers: [], awaiting: [] } : { configured: true, servers: held.registry.status(), awaiting: held.registry.awaitingApproval() }
  }

  approveLspServer = (name: string, fingerprint?: string): boolean => {
    this.assertOpen()
    if (this.core.lsp === null) return false
    if (!this.lspRead) this.attachLsp()
    const held = this.lspHeld
    const question = held?.registry.awaitingApproval().find((item) => item.name === name && (fingerprint === undefined || item.fingerprint === fingerprint))
    if (held === null || question === undefined) return false
    const now = this.core.clock.now()
    addProjectGrants(this.core.grantsDir, realWorkspace(this.projection().session.cwd), [lspGrant(question.key, now)], now)
    held.registry.approve(question.key)
    return true
  }

  /**
   * Takes hold of the registry of this working directory and
   * configuration, and lets go of the one an earlier configuration named.
   * Nothing starts here: a server starts at the first file it serves. A
   * server the project's file names and the user has not approved is never
   * started: the user is told, once. A replay starts none.
   */
  /**
   * Live telemetry as the configuration this execution read says: on, for
   * the collector the user's own file names, unless the project's file
   * turns it off. The session's log so far is read once when it starts (or
   * when the collector or the content setting changed): what is closed in
   * it is not sent again, an execution that is taken up again is. A section
   * that turns telemetry on and cannot be used (no endpoint, a header that
   * names a variable that is not set) is said to the user once; the turn
   * runs as without telemetry.
   */
  private attachTelemetry(): void {
    const hub = this.core.telemetry
    if (hub === null) return
    const plan = this.director !== null ? ({ kind: "off" } as const) : hub.plan(this.config?.files ?? null)
    if (plan.kind !== "on") {
      if (plan.kind === "unusable") this.say("telemetry", `Telemetry is not exported: ${plan.message}.`)
      this.trace?.settle(true)
      this.trace = null
      this.traceKey = null
      return
    }
    const key = hub.key(plan.config)
    if (this.trace !== null && !this.trace.failed && this.traceKey === key) return
    this.trace?.settle(true)
    this.trace = null
    this.traceKey = null
    try {
      const lineage = this.projection().session.lineage
      const parent = lineage?.kind === "spawn" ? this.core.sessions.get(lineage.parentSessionId) : undefined
      const placement = parent?.trace?.placementOf(this.id)
      this.trace = new SessionTrace(
        {
          sessionId: this.id,
          exporter: hub.exporter(plan.config),
          content: plan.config.content,
          // What content export redacts is what the harness redacts from a tool's result.
          secrets: this.core.approvals?.secrets ?? environmentSecrets(process.env),
          ...(placement === undefined ? {} : { placement }),
          mapDelayMs: hub.mapDelayMs,
          onFailure: (message) => this.say("telemetry", `Telemetry stopped for this session: its spans could not be derived (${message}).`),
        },
        { events: ownEvents(this.store, this.id), requests: this.store.readRequests(this.id) },
      )
      this.traceKey = key
    } catch (error) {
      this.say("telemetry", `Telemetry is not exported: ${describe(error)}.`)
    }
  }

  private attachLsp(): void {
    try {
      this.readLsp()
    } finally {
      this.featureChanged("lsp")
    }
  }

  private readLsp(): void {
    this.lspRead = true
    const lsp = this.core.lsp
    const previous = this.lspHeld
    const drop = () => {
      previous?.release()
      this.lspHeld = null
      this.lspPlan = null
    }
    if (lsp === null || this.closing !== null || this.director !== null) return drop()
    const cwd = this.projection().session.cwd
    let plan: LspPlan | null
    try {
      const now = this.core.clock.now()
      const files = this.files()
      plan = files?.user?.lsp === undefined && files?.project?.lsp === undefined ? null : planLanguageServers(files, readProjectGrants(this.core.grantsDir, realWorkspace(cwd), now), now)
    } catch (error) {
      this.say("lsp", `The language servers of the configuration could not be read: ${describe(error)}`)
      return drop()
    }
    if (!offersDiagnostics(plan)) return drop()
    // Why an edit got no diagnostics is the user's to read, once per server and reason; the model is told nothing.
    const held = lsp.hub.acquire(plan, cwd, (notice: LspNotice) => this.say("lsp", notice.message), () => this.featureChanged("lsp"))
    // Taken before the old one is let go of, so a registry both configurations name is never stopped in between.
    previous?.release()
    this.lspHeld = held
    this.lspPlan = held === null ? null : plan
    for (const question of held?.registry.awaitingApproval() ?? [])
      this.say("lsp", skippedLspServerNotice(question))
  }

  private releaseLsp(): void {
    this.lspHeld?.release()
    this.lspHeld = null
    this.lspPlan = null
  }

  /** The one file a call names, when a configured server serves it: absolute. `null` otherwise. */
  private servedPath(tool: AnyTool, input: Json, plan: LspPlan): string | null {
    const touches = this.core.touches.get(tool.name)
    if (touches === undefined) return null
    let paths: readonly string[]
    try {
      paths = touches(input)
    } catch {
      return null
    }
    const [given] = paths
    if (paths.length !== 1 || typeof given !== "string" || given === "") return null
    const cwd = this.projection().session.cwd
    const absolute = resolvePath(cwd, given)
    return servesFile(plan, cwd, absolute) ? absolute : null
  }

  /**
   * The language servers' part of what follows a tool's result. A file that
   * was read is shown to its servers, which never waits. For an edit that
   * succeeded, the servers are asked what it made worse, within their
   * bound, and the note they give is added after the result; what they
   * said is kept for the result's record. An error result, a call that
   * names no file a server serves and a shell command get nothing.
   */
  private async diagnose(run: Run, key: string, tool: AnyTool, input: Json, result: ToolResult): Promise<ToolResult> {
    const held = this.lspHeld
    const plan = this.lspPlan
    const before = this.lspBefore.get(key)
    this.lspBefore.delete(key)
    if (held === null || plan === null || result.status !== "success") return result
    if (tool.effect === "read") {
      const path = this.servedPath(tool, input, plan)
      const document = path === null ? "unreadable" : readDocument(path)
      if (path !== null && typeof document !== "string") held.registry.observe(path, document.text)
      return result
    }
    if (before === undefined) return result
    // Read after the hooks ran: a formatter may have rewritten the file, and the note is about what the agent sees next.
    const after = readDocument(before.path)
    if (typeof after === "string") return result
    const outcome = await held.registry.diagnose({ path: before.path, before: before.text, after: after.text, signal: run.interrupt.signal })
    const record = diagnosticsOf(outcome, plan, this.untrustedProject())
    if (record !== null) this.lspSaid.set(key, record)
    return outcome.note === null ? result : { ...result, output: `${result.output}\n\n${outcome.note}` }
  }

  /** The execution whose first step already waited for the servers. */
  private serversAwaited: ExecutionId | null = null

  /** Whether this boundary should give starting servers a moment: once per execution, and only when one has not answered yet. */
  private serversToAwait(run: Run): boolean {
    const mcp = this.core.mcp
    if (mcp === null || this.serversAwaited === run.executionId || this.director !== null) return false
    this.serversAwaited = run.executionId
    return mcp.hub.startWaitMs > 0 && this.mcpHeld.size > 0 && this.mcpServers().starting()
  }

  private async awaitServers(run: Run): Promise<void> {
    const stopped = abortedOnce(run.interrupt.signal)
    try {
      await Promise.race([this.mcpServers().settled(this.core.mcp!.hub.startWaitMs), stopped.promise])
    } finally {
      stopped.dispose()
    }
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
    // A replay's working directory is the recording's until it has a copy of its own: nothing there is recorded or restored.
    if (this.projection().session.replay !== undefined && this.director?.live !== true) return null
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
   * Tells whoever watches which files this turn changed, right before it
   * ends: the difference between the snapshot taken when its input was
   * delivered and the latest one. A turn that ends because a queued message
   * waits says its own files, and the turn after it its own. For display;
   * the snapshot IDs are the record (`Engine.turnChanges` reads them back).
   */
  private async announceChanges(): Promise<void> {
    if (this.core.openSnapshots === null) return
    const projection = this.projection()
    const to = projection.session.workspace.snapshot?.id
    const claim = claimOf(projection)
    const events = this.store.readEvents(this.id, { afterSeq: claim.startedSeq })
    const began = turnBeginning(projection)
    const from = began === undefined ? firstDelivery(events, 0) : snapshotsSinceDelivery(events, began.seq).target
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
   * - this turn changed no file: done, without a check. The gate verifies a
   *   turn's own work, so a question that was answered, or a turn that put
   *   back what it changed, runs nothing, whatever the user edited by hand
   *   or undid before it. What changed outside the turn stays unverified
   *   (`not_needed` says so) and is checked with the next turn that changes a file;
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
    // A subagent's turn is not verified: its parent's turn is, once the subagent's work is in. (Several subagents
    // each running the project's whole check suite in one workspace would mostly report each other's half-done work.)
    const child = this.projection().session.lineage?.kind === "spawn"
    const loaded = child ? null : this.config
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
      // A subagent's ending says who verifies its work; any other session's, that nothing was there to verify it with.
      return signal.aborted ? interrupted() : this.finish(run, child ? { status: "left_to_parent" } : { status: "not_configured" })
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
    // Checks run for a turn that changed files, and only for one. Which ones then is decided from everything that
    // is unverified, the turn's own changes or not: a check that runs cannot tell whose change it reads.
    if (!this.turnChangedFiles(state, current)) {
      await this.announceChanges()
      if (signal.aborted) return interrupted()
      return this.finish(run, selected.length === 0 ? { status: "not_needed" } : { status: "not_needed", unverified: true })
    }
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
  private async finish(run: Run, verification: VerificationOutcome, before: readonly NewEvent[] = []): Promise<GateResult> {
    // The gate says the turn may end: the stop hooks are asked now, and only now. A steer redirects the model, so
    // the turn is not ending; a subagent's turn is its parent's to hold; an execution without an answer has no turn.
    const state = this.projection()
    const answered = latestSpoken(state)
    let records: NewEvent<"hook.ran">[] = []
    let unsatisfied: HookEnding | undefined
    if (this.hookConfig.stop.length > 0 && this.core.hooks !== null && !state.inbox.some(isSteer) && state.session.lineage?.kind !== "spawn" && answered?.kind === "assistant") {
      const lastText = answered.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      const outcome = await runStopHooks(this.hookContext(run), this.hookConfig.stop, { roundsSent: stopRoundsSent(currentTurn(state)), maxRounds: this.hookConfig.maxStopRounds, lastText })
      records = outcome.records.map((record) => hookRan(record, null))
      this.tellHookFailures(outcome.records)
      const decision = outcome.decision
      if (decision.kind === "interrupted" || run.interrupt.signal.aborted) {
        // The hooks that had answered are on record; the turn winds down as after any interrupt.
        if (!run.interrupt.signal.aborted) throw new Error("a stop hook reported an interrupt nobody asked for")
        this.finishInterrupt(run, "", null, records)
        return "done"
      }
      if (decision.kind === "continue") {
        // The model is sent back: the message is frozen here, with the records of the hooks that said so.
        this.write([...before, ...records, note(this.core.ids.message(), HARNESS_ORIGIN.stopHook, decision.message)])
        return "continue"
      }
      if (decision.kind === "end_unsatisfied") {
        // What they said this last time is sent to nobody; the ending carries it, so that a client can say why the turn ended this way.
        unsatisfied = { unsatisfied: [...new Set(decision.hooks.map((hook) => hook.name))], objections: decision.objections.map(({ hook, text }) => ({ hook: hook.name, text })) }
        this.core.report({ kind: "hooks", sessionId: this.id, message: decision.notice })
      }
    }
    const inbox = this.projection().inbox
    if (inbox.length > 0) {
      if (before.length + records.length > 0) this.write([...before, ...records])
      return inbox.some(isSteer) ? "continue" : { verification, ...(unsatisfied === undefined ? {} : { hooks: unsatisfied }) }
    }
    this.probe("execution.ending")
    this.write([...before, ...records, event("execution.succeeded", { executionId: run.executionId, verification, ...(unsatisfied === undefined ? {} : { hooks: unsatisfied }) })])
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
        spillDir: confined === undefined ? join(this.core.spillDir, "checks", this.id) : join(this.tempContext().temp?.dir ?? this.core.spillDir, SPILL_IN_TEMP, "checks"),
        signal,
        ...(confined === undefined ? {} : { sandbox: confined }),
        progress: (name, value) => this.ephemeral({ type: "checks.progress", sessionId: this.id, run: number, check: name, text: value }),
        // A check's output is tool output: what is shown while it runs and what is kept in full are redacted too.
        ...(this.core.approvals === null ? {} : { redact: redactor(this.core.approvals.secrets), unfinishedSecret: (value: string) => unfinishedSecret(value, this.core.approvals!.secrets) }),
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
    const report = () => note(this.core.ids.message(), HARNESS_ORIGIN.checkReport, secrets === undefined ? renderReport(results) : redact(aliased(renderReport(results), this.tempContext().temp), secrets).text)
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
   * Whether the turn in progress changed the workspace: it differs from the
   * snapshot taken when the turn's input was delivered. `current` is the
   * workspace now. A change made during the turn by someone else (the user,
   * by hand) counts as the turn's: the two cannot be told apart, and in
   * doubt the checks run. So does everything since the last verification
   * when the turn was told that spawned work ended: a background command or
   * subagent works outside the steps, also between turns. Without snapshots
   * the stand-in is whether a call that can change files ran in the turn.
   */
  private turnChangedFiles(projection: Projection, current: string | null): boolean {
    if (spawnedWorkEndedThisTurn(projection)) return true
    const claim = claimOf(projection)
    const began = turnBeginning(projection)?.seq ?? claim.startedSeq
    if (current !== null) {
      // The delivery snapshot is the last thing recorded about the workspace before the input entered history.
      const delivery = snapshotsSinceDelivery(this.store.readEvents(this.id, { afterSeq: claim.startedSeq }), began).target
      if (delivery !== null) return delivery !== current
    }
    return ranSideEffectsSince(projection, began, this.core.effects)
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
    // A replay's working directory is the recording's, or a throwaway copy: there is nothing of its own to restore.
    if (projection.session.replay !== undefined) return Promise.resolve({ kind: "refused", reason: "nothing_to_revert", message: "a replay session is not reverted" })
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
    // A fork has the snapshots of its own events: the ones of the history it inherited are its parent's, so a
    // revert to before an inherited message rewinds the conversation and restores no file.
    const since = snapshotsSinceDelivery(ownEvents(this.store, this.id), target.seq)
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
      .then((own) => editedOutside(store, timeline, dry.before, own))
      .catch(() => null)
    // Which of those another session changed: only looked for when one of them is in the plan.
    const theirs = edited !== null && dry.changes.some((change) => edited.has(change.path)) ? await this.othersWorkSince(store, sinceSeq, dry.before) : new Map<SessionId, ReadonlySet<string>>()
    const editedBy = (path: string): EditedBy | null => {
      if (edited === null) return { kind: "unknown" }
      const where = edited.get(path)
      if (where === undefined) return null
      const sessions = [...theirs].filter(([, paths]) => paths.has(path)).map(([id]) => id)
      if (sessions.length > 0) return { kind: "session", sessionId: sessions.length === 1 ? sessions[0]! : null }
      return where === "between" ? { kind: "outside" } : { kind: "unknown" }
    }
    const changes = dry.changes.map((change) => {
      const by = editedBy(change.path)
      return { path: change.path, status: change.status, handEdited: by !== null, ...(by === null ? {} : { editedBy: by }) }
    })
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
    const since = this.sinceTime(sinceSeq)
    const others = (await store.list()).some((ref) => ref.session !== this.id && ref.takenAt >= since)
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

  /** When the event at `sinceSeq` was written, a little earlier: the snapshot store's clock and the log's are the same one, read a moment apart. */
  private sinceTime(sinceSeq: number): number {
    return (this.store.readEvents(this.id, { afterSeq: sinceSeq - 1, limit: 1 })[0]?.time ?? 0) - 1000
  }

  /**
   * What each other session that recorded this working directory since the
   * event at `sinceSeq` changed in its own work, by its own log and
   * snapshots: the paths a revert plan says that session changed. A session
   * whose log or snapshots cannot be read is left out (what it changed then
   * counts as changed by nobody known). Empty when this session is alone.
   */
  private async othersWorkSince(store: WorkspaceSnapshots, sinceSeq: number, now: string): Promise<Map<SessionId, ReadonlySet<string>>> {
    const found = new Map<SessionId, ReadonlySet<string>>()
    if (store.list === undefined) return found
    const since = this.sinceTime(sinceSeq)
    const others = new Set((await store.list().catch(() => [])).flatMap((ref) => (ref.session !== this.id && ref.takenAt >= since ? [ref.session as SessionId] : [])))
    for (const id of others) {
      try {
        const events = this.core.stores.read(id, (other) => other.readEvents(id))
        const paths = await changedInOwnWork(store, events, since, now)
        if (paths.size > 0) found.set(id, paths)
      } catch {
        // Its log is gone or a snapshot of it was dropped: nothing is known of what it changed.
      }
    }
    return found
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
    // A file the target does not have was removed; every other change wrote one. A client says which, never "restored" for both.
    const changes = result?.changes ?? []
    const removed = changes.filter((change) => change.status === "deleted").length
    const restore: RestoreRecord = {
      target: open.target,
      before: open.before,
      after,
      written: changes.length - removed,
      removed,
      changed: changes.length,
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

/**
 * A session's own events: for a fork, the ones from its fork point on,
 * `session.created` first. The events before that are its parent's, in
 * another file that may be gone; what a fork needs of them at run time was
 * copied into it when it was made (its message rows, its baseline, the
 * taint entries in `session.created`), so nothing the loop does reads them.
 */
function ownEvents(store: Store, id: SessionId): readonly StoredEvent[] {
  return store.readEvents(id, { afterSeq: forkOf(store.getSession(id)?.session.lineage ?? null)?.throughSeq ?? 0 })
}

/** A session's whole log, or, for a fork whose parent's file is gone, the part of it that is the fork's own. */
function eventsWithoutMissingParent(store: Store, id: SessionId): readonly StoredEvent[] {
  try {
    return store.readEvents(id)
  } catch (error) {
    if (error instanceof StoreError && error.code === "parent_missing") return ownEvents(store, id)
    throw error
  }
}

/** The history a session's taint is derived from, built from its own events: a fork's begins with what it carries of its parent's. */
function taintHistoryOf(store: Store, id: SessionId): TaintHistory {
  const history = new TaintHistory()
  for (const item of ownEvents(store, id)) {
    if (item.type === "session.created" && item.data.inherited !== undefined) history.seed(item.data.inherited.taint)
    history.add(item)
  }
  return history
}

/** Why the latest execution of a log failed, in its own words; `null` when it did not. */
function lastExecutionFailure(events: readonly StoredEvent[]): string | null {
  const last = events.findLast((item) => item.type === "execution.failed" || item.type === "execution.succeeded" || item.type === "execution.interrupted")
  return last?.type === "execution.failed" ? last.data.message : null
}

/** What is wrong with `settings`, going by the provider's listing: a model it does not offer, or an effort that model does not. */
function settingsProblem(settings: SessionSettings, models: readonly ModelOffer[]): EngineError | null {
  if (models.length === 0) return null
  const model = models.find((entry) => entry.id === settings.model)
  if (model === undefined) return new EngineError("unknown_model", `model ${settings.model} is not available; choose one of: ${models.map((entry) => entry.id).join(", ")}`)
  const efforts = model.efforts ?? []
  if (settings.reasoningEffort === null || efforts.length === 0 || efforts.includes(settings.reasoningEffort)) return null
  return new EngineError("unknown_effort", `model ${settings.model} does not offer the reasoning effort "${settings.reasoningEffort}"; it accepts: ${efforts.join(", ")}`)
}

/** The configuration files that apply in `cwd` as they are now, read without waiting; `error` when they cannot be read. */
function configFilesNow(core: Core, cwd: string): { readonly files: ConfigFiles | null; readonly error: string | null } {
  if (core.loadConfigSync === null) return { files: null, error: null }
  try {
    return { files: core.loadConfigSync(cwd).files ?? null, error: null }
  } catch (error) {
    return { files: null, error: describe(error) }
  }
}

/** What the user should know about an agent that was selected: restrictions that name tools this build does not have. */
function agentWarnings(core: Core, agent: AgentRecord): string[] {
  const unknown = unknownToolNames(agent.restrictions, [...core.effects.keys()])
  return unknown.length === 0 ? [] : [`The agent "${agent.name}" (${agent.path}) names ${unknown.length === 1 ? "a tool" : "tools"} that ${unknown.length === 1 ? "does" : "do"} not exist here, which therefore ${unknown.length === 1 ? "restricts" : "restrict"} nothing: ${unknown.join(", ")}.`]
}

/**
 * What a new session starts as: the agent the caller names, else the
 * default of the user's own configuration, else none; and the settings it
 * is created with (the agent's model and effort where it names them).
 * Throws before anything exists: a named or default agent that cannot be
 * found is an error for the user, never a session that runs without the
 * restrictions they asked for, and so are settings the provider's listing
 * is known not to offer.
 */
function startAs(core: Core, input: { readonly cwd: string; readonly settings: SessionSettings; readonly agent?: string | null }): { readonly settings: SessionSettings; readonly agent: AgentRecord | null; readonly decided: boolean; readonly warnings: readonly string[] } {
  const models = core.offered()
  const usable = (settings: SessionSettings) => {
    const problem = models === null ? null : settingsProblem(settings, models)
    if (problem !== null) throw problem
    return settings
  }
  const asked = input.agent === undefined || input.agent === null ? null : input.agent.trim()
  const none = asked !== null && asked.toLowerCase() === NO_AGENT
  if (core.agents === null) {
    if (asked !== null && !none) throw new EngineError("invalid_request", `this engine offers no agents, so a session cannot start as "${asked}"`)
    return { settings: usable(input.settings), agent: null, decided: true, warnings: [] }
  }
  const config = configFilesNow(core, input.cwd)
  if (config.error !== null) {
    // The first execution fails with the configuration's error, as it always has. A session that was asked to start
    // as an agent is not created without it; one that was not looks for the default when that execution has read the files.
    if (asked !== null && !none) throw new EngineError("invalid_request", `the session cannot start as the agent "${asked}": ${FAILURE_TEXT.config(config.error)}`)
    return { settings: usable(input.settings), agent: null, decided: none, warnings: [] }
  }
  const places = agentPlaces(config.files, core.agents)
  const chosen = resolveStartAgent(findAgents(input.cwd, places), asked, places)
  if (!chosen.ok) throw new EngineError("invalid_request", chosen.message)
  // What the project's file asked for and may not: said as a sentence, since nothing else is on the line with it.
  const ignored = places.ignored.map((entry) => `Not followed: ${entry}.`)
  if (chosen.agent === null) return { settings: usable(input.settings), agent: null, decided: true, warnings: ignored }
  const record = agentRecordOf(chosen.agent)
  const settings = agentSettings(record, input.settings, models?.map((model) => model.id))
  if (settings.notes.length > 0) throw new EngineError("unknown_model", settings.notes.join(" "))
  return { settings: usable(settings.settings), agent: record, decided: true, warnings: [...ignored, ...agentWarnings(core, record)] }
}

/**
 * The sessions a listing shows. Subagents and replays are sessions the
 * harness made for itself: they are left out unless asked for, so that the
 * latest session of a directory is never one of them. (Each is reached from
 * the session it comes from: a parent's `spawned.children`, a replay's own ID.)
 */
function listed(core: Core, query: SessionQuery = {}): readonly SessionSummary[] {
  if (query.includeSpawned === true) return core.stores.list(query)
  const { limit, ...rest } = query
  const own = core.stores.list(rest).filter((summary) => summary.session.lineage?.kind !== "spawn" && summary.session.lineage?.kind !== "replay")
  return limit === undefined ? own : own.slice(0, limit)
}

/** The place in the listing a page cursor stands for: when its last session was updated, and that session's ID. */
function pagePlace(cursor: string): { readonly updatedAt: number; readonly id: string } {
  const match = /^(\d{1,16}):([A-Za-z0-9_-]+)$/.exec(cursor)
  if (match === null) throw new EngineError("invalid_request", `${JSON.stringify(cursor)} is not a cursor of the session listing`)
  return { updatedAt: Number(match[1]), id: match[2]! }
}

/** What `replay.call` records for one call of a replayed step. */
function replayCall(messageId: MessageId, callId: CallId, match: CallMatch, executed: boolean): NewEvent<"replay.call"> {
  const base = { messageId, callId, executed }
  switch (match.kind) {
    case "matched":
      return event("replay.call", { ...base, result: match.via === "exact" ? "matched" : "normalised", recorded: { step: match.recordedStep, call: match.recorded.index }, divergence: null })
    case "dropped":
      return event("replay.call", { ...base, result: "dropped", recorded: null, divergence: null })
    case "diverged":
      return event("replay.call", { ...base, result: "diverged", recorded: null, divergence: match.divergence.kind })
    case "off_tape":
      return event("replay.call", { ...base, result: "off_tape", recorded: null, divergence: null })
  }
}

/** Whether the session's latest execution ended with the model's answer. */
function wouldBeDone(projection: Projection): boolean {
  const last = projection.messages.findLast((message) => message.kind === "assistant" || message.kind === "user" || message.kind === "synthetic")
  return last?.kind === "assistant" && last.status === "completed" && last.finish !== "tool_calls"
}

/** Why the session's latest step failed, for a person; `null` when it did not. */
function lastFailure(projection: Projection): string | null {
  const last = projection.messages.findLast((message) => message.kind === "assistant")
  if (last?.kind !== "assistant" || last.status !== "failed" || last.error === null) return null
  const error = last.error
  if (error.kind === "provider") return `the provider failed: ${error.error.message}`
  if (error.kind === "interrupted") return REPLAY_TEXT.interrupted
  return error.kind === "internal" ? `the harness failed: ${error.message}` : REPLAY_TEXT.crashed
}

/**
 * The session a fork point belongs to. A fork's log begins with its
 * parent's events through its own fork point, under the same numbers: a
 * point there is a point of the parent's log (or of the parent's parent's),
 * and forking the fork at it is forking that session at it. A point of the
 * fork's own part, or no point (the latest boundary), is the fork's.
 */
function forkPointOwner(core: Core, id: SessionId, throughSeq: number | undefined, cannot: (message: string) => string): SessionId {
  if (throughSeq === undefined) return id
  let owner = id
  for (;;) {
    const summary = core.stores.get(owner)
    // The history that holds the point is in a file that is gone: said in the store's words, which name the file.
    if (summary === null && owner !== id) storeErrors(() => core.stores.read(id, (store) => store.readEvents(id, { limit: 1 })), cannot)
    const fork = forkOf(summary?.session.lineage ?? null)
    if (fork === null || throughSeq > fork.throughSeq) return owner
    owner = fork.parentSessionId
  }
}

/**
 * Forks a session at a step boundary (`Engine.forkSession`). The parent is
 * read through whatever holds it, never written: every event up to the fork
 * point is committed and the log is append-only, so the fork's inherited
 * history is the same whoever writes to the parent meanwhile. The parent is
 * the session the point belongs to (`forkPointOwner`): for a point a fork
 * inherited, the session it inherited it from.
 */
async function forkSession(core: Core, askedId: SessionId, options: ForkOptions): Promise<LiveSession> {
  const cannot = (message: string) => `session ${askedId} cannot be forked: ${message}`
  const sourceId = forkPointOwner(core, askedId, options.throughSeq, cannot)
  const events = storeErrors(() => core.stores.read(sourceId, (store) => store.readEvents(sourceId)), cannot)
  let state: Projection | null = null
  let point: Projection | null = null
  // What taint is derived from, folded along: the fork carries the part up to its fork point in its own first event.
  const taint = new TaintHistory()
  let entriesAtPoint = 0
  for (const item of events) {
    if (options.throughSeq !== undefined && item.seq > options.throughSeq) break
    state = reduce(state, item)
    taint.add(item)
    // A boundary: nothing is open, so the history up to here is whole.
    if (state.session.open === null) {
      point = state
      entriesAtPoint = taint.entries.length
    }
  }
  const carried = inheritableTaint(taint.entries.slice(0, entriesAtPoint))
  if (state === null || point === null) throw new EngineError("session_not_found", `session ${sourceId} does not exist`)
  if (options.throughSeq !== undefined && point.lastSeq !== options.throughSeq)
    throw new EngineError(
      "invalid_request",
      `seq ${options.throughSeq} of session ${sourceId} is ${options.throughSeq > state.lastSeq ? "past its end" : "inside a step"}: a session is forked at a step boundary (the nearest one before it is seq ${point.lastSeq})`,
    )
  if (point.session.replay !== undefined) throw new EngineError("invalid_request", "a replay session is not forked: replay the recording again instead")
  const id = core.ids.session()
  let cwd = point.session.cwd
  let copied: { readonly snapshot: string | null; readonly from: string } | undefined
  if (options.workspace !== undefined && options.workspace !== "shared") {
    const into = resolve(options.workspace.copyTo ?? join(core.workDir, "workspaces", id))
    // The workspace as it stands when the fork point is the parent's latest state and nothing works in it; otherwise as it was recorded then.
    const atEnd = point.lastSeq === events.at(-1)!.seq && point.session.execution === null
    let snapshot = point.session.workspace.snapshot?.id ?? null
    if (atEnd && core.openSnapshots !== null) {
      const store = await core.openSnapshots(cwd).catch(() => null)
      if (store !== null && !("reason" in store)) snapshot = (await store.take({ session: id })).id
    }
    if (snapshot === null)
      throw new EngineError("invalid_request", `no snapshot of ${cwd} was recorded at seq ${point.lastSeq}, so the fork cannot be given a copy of the workspace as it was then; fork into the same workspace instead`)
    const exported = await core.exportSnapshot(cwd, snapshot, into)
    if ("kind" in exported) throw new EngineError("invalid_request", `the workspace could not be copied for the fork: ${exported.message}`)
    copied = { snapshot, from: cwd }
    cwd = into
  }
  core.probe?.("fork.copied", id)
  const store = storeErrors(() => core.stores.create(id))
  const session = new LiveSession(core, id, store)
  try {
    session.write([
      event("session.created", {
        cwd,
        title: options.title === undefined ? point.session.title : options.title,
        lineage: { kind: "fork", parentSessionId: sourceId, throughSeq: point.lastSeq, ...(copied === undefined ? {} : { copied }) },
        settings: options.settings ?? point.session.settings,
        // Copied, like the messages: the fork decides its calls without its parent's file.
        ...(carried.length === 0 ? {} : { inherited: { taint: carried } }),
      }),
    ])
  } catch (error) {
    store.close()
    throw error
  }
  core.sessions.set(id, session)
  return session
}

/** Starts the replay of a recorded session (`Engine.replaySession`). */
async function replaySession(core: Core, sourceId: SessionId, request: ReplayRequest): Promise<ReplayRun> {
  const all = storeErrors(() => core.stores.read(sourceId, (store) => store.readEvents(sourceId)), (message) => `session ${sourceId} cannot be replayed: ${message}`)
  const source = request.throughSeq === undefined ? all : all.filter((item) => item.seq <= request.throughSeq!)
  const last = source.at(-1)
  if (last === undefined) throw new EngineError("session_not_found", `session ${sourceId} has no event to replay`)
  const policy = request.policy ?? "stop"
  const prepared = (() => {
    try {
      const tape = tapeFromEvents(source)
      return { tape, ...changedBaseline(source, tape.settings, request) }
    } catch (error) {
      throw new EngineError("invalid_request", `session ${sourceId} cannot be replayed: ${describe(error)}`)
    }
  })()
  const id = core.ids.session()
  const copy = policy === "stop" ? null : resolve(request.workspace ?? join(core.workDir, "replays", id))
  const copyMade = copy !== null && !existsSync(copy)
  if (copy !== null) mkdirSync(copy, { recursive: true })
  const store = storeErrors(() => core.stores.create(id))
  const session = new LiveSession(core, id, store)
  try {
    session.write([
      event("session.created", {
        // Until it leaves the recording a replay works nowhere; then in its copy. The `stop` policy never has one.
        cwd: copy ?? prepared.tape.cwd,
        title: `Replay of ${sourceId}`,
        lineage: { kind: "replay", sourceSessionId: sourceId, throughSeq: last.seq, policy, strict: request.strict === true, changed: prepared.changed },
        settings: prepared.settings,
      }),
    ])
    core.sessions.set(id, session)
    const done = session.beginReplay({ sourceId, tape: prepared.tape, source, baseline: prepared.baseline, request, policy, copy, copyMade })
    return { session, done }
  } catch (error) {
    core.sessions.delete(id)
    store.close()
    throw error instanceof EngineError ? error : new EngineError("invalid_request", `session ${sourceId} cannot be replayed: ${describe(error)}`)
  }
}

/** The harness config directory, where the user-level AGENTS.md lives: `$XDG_CONFIG_HOME/<brand.directory>`. */
function configDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), brand.directory)
}

/**
 * Turns the store's refusals to hand out a session, or its history, into the
 * engine's own errors, which a client shows as they are worded. `missing`
 * says what could not be done for want of a fork's inherited history; the
 * store's message names the session it was inherited from and the file.
 */
function storeErrors<T>(work: () => T, missing: (message: string) => string = (message) => message): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof StoreLockedError) throw new EngineError("session_in_use", error.message, error.holderPid)
    if (error instanceof StoreError && (error.code === "session_not_found" || error.code === "ambiguous_session")) throw new EngineError(error.code, error.message)
    if (error instanceof StoreError && error.code === "parent_missing") throw new EngineError("invalid_request", missing(error.message))
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
    const events = store.readEvents(id, { afterSeq: forkOf(projection.session.lineage)?.throughSeq ?? 0 })
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
  return sumUsage(total, next)
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
