/**
 * The vocabulary step-loop scenarios are written in.
 *
 * A scenario is a script of the durable events the step loop must write for
 * one situation, split into phases ("the user cancels", "the process dies,
 * then at next start-up"), with what a UI and the model should see after each
 * phase. The test folds every scenario through the real reducer.
 *
 * Nothing here runs a loop. These are the target the loop is built against.
 */
import { type CallFacts, type Decision, type SandboxState, decide } from "../../src/approval/decide.ts"
import type { Escalation } from "../../src/approval/escalation.ts"
import { type Grant, type Need, stampGrants } from "../../src/approval/grants.ts"
import { type PathFact, pathFact } from "../../src/approval/paths.ts"
import type { ApprovalMode, UnattendedAction } from "../../src/approval/policy.ts"
import type { CallRun, ChoiceId } from "../../src/approval/record.ts"
import { CLEAN, type TaintSource, type TaintState, describeTaint } from "../../src/approval/taint.ts"
import type { ConfigFile } from "../../src/config/schema.ts"
import { text } from "../../src/content.ts"
import { buildCheckpoint } from "../../src/context/checkpoint.ts"
import { currentTodos, renderTodos } from "../../src/tools/todo.ts"
import { type SummaryProblem, describeProblem, summaryPrompt, summaryRepairPrompt } from "../../src/context/summary.ts"
import {
  type CompactionMode,
  type DiagnosticsRecord,
  type NewEvent,
  type RestoreRecord,
  type SnapshotPoint,
  type StepError,
  type ToolOutcome,
  type VerificationOutcome,
  HARNESS_ORIGIN,
  event,
} from "../../src/event/durable.ts"
import type { HookAnswer } from "../../src/hooks/answer.ts"
import type { Hook, HooksConfigSection } from "../../src/hooks/config.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import type { InterruptReason } from "../../src/interrupt.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import type { Exclusion, Message, Projection } from "../../src/message/message.ts"
import { type ReduceErrorCode, reduce } from "../../src/message/reducer.ts"
import { type ProviderError, type ProviderErrorKind, makeProviderError } from "../../src/provider/error.ts"
import type { ToolEffect } from "../../src/tool/tool.ts"
import type { Acknowledgement } from "../../src/verify/acknowledge.ts"
import type { VerificationEvidence } from "../../src/verify/evidence.ts"
import { renderReport } from "../../src/verify/report.ts"
import type { CheckResult } from "../../src/verify/run.ts"
import type { CheckStatus } from "../../src/verify/status.ts"

// ---------------------------------------------------------------- types

export interface Scenario {
  readonly title: string
  /** The situation, in plain words. */
  readonly description: string
  /** What the provider (and the tools, and the user) do to trigger it. */
  readonly provider: string
  /**
   * What the session runs in, for the scenarios about the workspace and the
   * checks. Without it there are no snapshots and no configuration, and the
   * log holds none of their events.
   */
  readonly setup?: Setup
  /**
   * The context window the engine is told the model has, in tokens, for the
   * scenarios about compaction. Without it nobody knows the window, and
   * history is compacted only after the provider rejects a request.
   */
  readonly contextWindow?: number
  /**
   * The approval layer the session runs under, for the scenarios about it.
   * Without it the layer is off, as in every other scenario: each call runs
   * as it is and the log holds nothing about approval.
   */
  readonly approval?: ApprovalSetting
  /**
   * Subagents and background work, for the scenarios about them. Without it
   * the engine offers none of their tools.
   */
  readonly spawn?: SpawnSetting
  /**
   * The features the engine offers the session, for the scenarios about
   * them: skills (the project has skill files), MCP servers (the user's
   * configuration names one scripted server), wake-ups. Without it the
   * engine offers none of their tools and appends nothing about them.
   */
  readonly features?: FeatureSetting
  readonly phases: readonly Phase[]
}

export interface FeatureSetting {
  readonly skills?: boolean
  readonly mcp?: boolean
  readonly wake?: boolean
  /** The real `todo` tool is among the session's tools (the scenarios' other tools are stand-ins). */
  readonly todo?: boolean
  /** The project has agent definitions (`.claude/agents/`), and the engine offers agents. */
  readonly agents?: boolean
  /** The `hooks` section of the user's own configuration file: the engine runs these hooks, which answer as the scenario says. */
  readonly hooks?: HooksConfigSection
  /** The user's configuration names one language server, which serves `*.txt` files (the scripted server), and the workspace is a real directory. */
  readonly lsp?: boolean  /** The project has command files (`.claude/commands/`), and the engine offers slash commands. */
  readonly commands?: boolean
  /** The user's own configuration turns live telemetry on, toward a collector the play stands in for. */
  readonly telemetry?: boolean
}

export interface SpawnSetting {
  /** How deep subagents may nest. Default 1. */
  readonly maxDepth?: number
}

export interface ApprovalSetting {
  /** The user's mode. Default `auto`. */
  readonly mode?: ApprovalMode
  /** What a call that would ask becomes when nobody is present. Default `deny`. */
  readonly unattended?: UnattendedAction
  /** Whether a person is there to answer. Default: nobody. */
  readonly attended?: boolean
  /** Whether commands can be sandboxed on the machine. Default: they can. */
  readonly sandbox?: "available" | "unavailable"
}

export interface Setup {
  /** The files of the workspace when the session starts, by path. Snapshots are on. */
  readonly files: Readonly<Record<string, string>>
  /** The project's configuration file. Absent: no configuration. */
  readonly config?: ConfigFile
}

/** A run of events the loop writes without anything else happening in between. */
export interface Phase {
  readonly label: string
  readonly events: readonly NewEvent[]
  /** What must hold once this phase is folded. The last phase always has one. */
  readonly expect?: Expect
  /** Events the loop must not write at the end of this phase. The reducer rejects each with the given code. */
  readonly rejects?: readonly Rejection[]
}

export interface Rejection {
  readonly event: NewEvent
  readonly code: ReduceErrorCode
  readonly why: string
}

export interface Expect {
  /** Every message in log order, as a UI would list it (see `view`). Matched as a subset per message. */
  readonly ui?: readonly Partial<MessageView>[]
  /** IDs of the messages `selectModelHistory` returns, in request order. */
  readonly history?: readonly string[]
  /** The execution claim: `null` when released. */
  readonly execution?: null | {
    readonly status: "running" | "suspended"
    readonly crashResumes: number
    /** The reason of a requested interrupt that has not completed. Defaults to `null`. */
    readonly interrupting?: InterruptReason
  }
  /** What is open (see `openLabel`): a step or compaction by message ID, `checks:<run>`, `revert`, `undo`, or `null` at a boundary. */
  readonly open?: string | null
  /** Inbox items still waiting, by message ID. */
  readonly inbox?: readonly string[]
  /** How many reverts can still be undone. */
  readonly undoable?: number
  /** Whether the session is hidden from the default listing. */
  readonly archived?: boolean
}

/** A message reduced to what a UI shows. */
export interface MessageView {
  readonly id: string
  readonly kind: Message["kind"]
  /** For assistant, compaction and failed steps: their status. Otherwise `null`. */
  readonly status: string | null
  readonly attempt: number | null
  /** The text a UI renders: user and synthetic content, or the assistant's text parts joined with "|". */
  readonly text: string
  /** One entry per tool call: `"<callId> <name> <state>"`, where state is pending, running or the outcome, followed by `(stopped by the user)` when the user asked for that one call to stop. */
  readonly calls: readonly string[]
  /** For a failed step: the error, e.g. `"interrupted:user"`, `"provider:rate_limit"`, `"crashed"`. */
  readonly error: string | null
  readonly excluded: Exclusion | null
  /** For a synthetic message: its origin. */
  readonly origin: string | null
  /** For a user message a slash command produced: the line as it was typed (`/release-notes 1.4`). */
  readonly command: string | null
}

// ---------------------------------------------------------------- ids and tools

export const m = (id: string) => id as MessageId
export const c = (id: string) => id as CallId
export const x = (id: string) => id as ExecutionId
export const SESSION = "ses_scenario" as SessionId
export const MODEL = "gpt-test"

/** The tools every scenario's baseline offers, with the effect class the loop knows them by. */
export const TOOLS = {
  read: "read",
  shell: "exec",
  write: "write",
} as const satisfies Record<string, ToolEffect>
export type ToolName = keyof typeof TOOLS

/** The attempt budget of one logical step that the retry scenarios assume (1 attempt + 4 retries). */
export const ATTEMPT_BUDGET = 5
/** How many times recovery may take up the same execution again before giving up. */
export const RESUME_CAP = 3
/** Steps per turn before the loop makes one final call with tools forbidden. */
export const STEP_LIMIT = 3

export const usage = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 10 }
/** What the provider measured for a call whose request had `inputTokens` tokens: what the compaction policy decides from. */
export const measured = (inputTokens: number) => ({ inputTokens, cachedInputTokens: inputTokens - 200, outputTokens: 50, reasoningTokens: 10 })

// ---------------------------------------------------------------- session and inbox

export const created = () =>
  event("session.created", { cwd: "/repo", title: null, lineage: null, settings: { model: MODEL, reasoningEffort: "medium" } })
/** A session other than the scenario's own: the recording a replay replays, a subagent. Only its name matters. */
export const OTHER = "ses_other" as SessionId
/**
 * The scenario's session is a fork: this is the first event of its own, after
 * the parent's events 1..`throughSeq`, which a scenario writes before it. (A
 * scenario is one log, so the parent's events carry the scenario's session ID.)
 */
export const forked = (throughSeq: number) =>
  event("session.created", { cwd: "/repo", title: null, lineage: { kind: "fork", parentSessionId: SESSION, throughSeq }, settings: { model: MODEL, reasoningEffort: "medium" } })
/** The scenario's session is a replay of the recording `OTHER` through `throughSeq`. With a policy that runs tools it works in a copy. */
export const replayCreated = (policy: "stop" | "execute-read-only" | "execute", throughSeq: number, changed: { readonly instructions: boolean; readonly tools: readonly string[]; readonly settings: boolean } = { instructions: true, tools: [], settings: false }) =>
  event("session.created", {
    cwd: policy === "stop" ? "/repo" : REPLAY_COPY,
    title: `Replay of ${OTHER}`,
    lineage: { kind: "replay", sourceSessionId: OTHER, throughSeq, policy, strict: false, changed: { ...changed, tools: [...changed.tools] } },
    settings: { model: MODEL, reasoningEffort: "medium" },
  })
/** The directory a replay carries on in after it left its recording (a stand-in for a path under the data directory). */
export const REPLAY_COPY = "/data/replays/copy"
/** The scenario's session is a subagent of `OTHER`, started by its spawned work `spawnId`. */
export const spawnedBy = (title: string, spawnId = "bg_1", depth = 1) =>
  event("session.created", { cwd: "/repo", title, lineage: { kind: "spawn", parentSessionId: OTHER, spawnId, depth, worktree: null }, settings: { model: MODEL, reasoningEffort: "medium" } })
/** A tool call of the open step started a subagent (the child session `OTHER`) or a background command. */
export const spawnStarted = (spawnId: string, id: string, callId: string, work: "subagent" | { readonly command: string; readonly logPath: string | null }, background = false) =>
  event("spawn.started", {
    spawnId,
    messageId: m(id),
    callId: c(callId),
    background,
    work: work === "subagent" ? { kind: "subagent", sessionId: OTHER, worktree: null } : { kind: "command", command: work.command, logPath: work.logPath },
  })
export const spawnEnded = (spawnId: string, outcome: "completed" | "failed" | "stopped" | "lost", detail: string, more: { readonly exitCode?: number | null; readonly steps?: number } = {}) =>
  event("spawn.ended", {
    spawnId,
    outcome,
    detail,
    exitCode: more.exitCode ?? null,
    // A subagent's cost: the scenarios' usage per step.
    usage:
      more.steps === undefined
        ? null
        : { inputTokens: usage.inputTokens * more.steps, cachedInputTokens: usage.cachedInputTokens * more.steps, outputTokens: usage.outputTokens * more.steps, reasoningTokens: usage.reasoningTokens * more.steps },
    tainted: false,
    merge: null,
  })
/** What the scenarios' watches look for, as `watch.started` records it. */
export interface WatchSetting {
  readonly pattern: string
  readonly regex?: boolean
  readonly ignoreCase?: boolean
  readonly limit?: number
}
/** The user sets a watch on the output of a running background command. */
export const watchStarted = (watchId: string, spawnId: string, watch: WatchSetting) =>
  event("watch.started", { watchId, spawnId, pattern: watch.pattern, regex: watch.regex ?? false, ignoreCase: watch.ignoreCase ?? false, limit: watch.limit ?? 1 })
/** A watch fired: the message `id`, admitted right before, tells the model, and quotes `line`. */
export const watchFired = (watchId: string, spawnId: string, firing: number, line: string, id: string) => event("watch.fired", { watchId, spawnId, firing, line, messageId: m(id) })
/** A watch that could still fire ended: the user removed it, its command ended, or the command was lost to a restart. */
export const watchEnded = (watchId: string, spawnId: string, reason: "removed" | "command_ended" | "lost") => event("watch.ended", { watchId, spawnId, reason })
/** What a replay made of one call: matched against the recorded step and call, or how it left the recording. */
export const replayCall = (id: string, callId: string, result: "matched" | "normalised" | "dropped" | "diverged" | "off_tape", more: { readonly executed?: boolean; readonly recorded?: readonly [number, number]; readonly divergence?: string } = {}) =>
  event("replay.call", {
    messageId: m(id),
    callId: c(callId),
    result,
    executed: more.executed ?? false,
    recorded: more.recorded === undefined ? null : { step: more.recorded[0], call: more.recorded[1] },
    divergence: more.divergence ?? null,
  })
export const replayDiverged = (divergence: string, snapshot: string | null = null) => event("replay.diverged", { workspace: REPLAY_COPY, snapshot, divergence })
/** The replay is over. The report itself is a stand-in here: the loop records the whole divergence report. */
export const replayEnded = (outcome: "identical" | "diverged" | "unsupported" | "incomplete", reason: string) => event("replay.ended", { outcome, reason, report: {} })

/** The user picks another model or reasoning effort. Takes effect at the next step. */
export const settingsChanged = (model: string, reasoningEffort: string | null = "medium") =>
  event("settings.changed", { model, reasoningEffort })
export const baseline = () =>
  event("baseline.set", {
    instructions: "You are a coding agent.",
    tools: Object.keys(TOOLS).map((name) => ({ name, description: `The ${name} tool`, inputSchema: { type: "object" } })),
    sources: [{ source: "date", fingerprint: fingerprintOf("Thursday, 2026-11-12") }],
  })
/** The user (origin `null`) or a harness component submits input. */
export const enqueue = (
  id: string,
  value: string,
  delivery: "steer" | "queue" = "steer",
  origin: string | null = null,
) => event("inbox.enqueued", { messageId: m(id), origin, delivery, content: text(value) })
export const deliver = (id: string) => event("inbox.delivered", { messageId: m(id) })
/** The user takes back a prompt that was not delivered yet. It never becomes a message. */
export const withdrawn = (id: string) => event("inbox.cancelled", { messageId: m(id) })
/**
 * The turn in progress may end, with what the gate found, and a queued message is delivered next. Without
 * checks there is nothing to verify, which is the plain case.
 */
export const turnEnded = (verification: VerificationOutcome = { status: "not_configured" }) => event("turn.ended", { verification })
export const archived = () => event("session.archived", {})
export const unarchived = () => event("session.unarchived", {})
/** An instruction that changed after the baseline. The fingerprint identifies the value the text carries. */
export const instruction = (id: string, source: string, value: string) =>
  event("instruction.appended", { messageId: m(id), source, text: value, fingerprint: fingerprintOf(value) })
export const synthetic = (id: string, origin: string, value: string) =>
  event("synthetic.appended", { messageId: m(id), origin, content: text(value) })

/** The structural note that the previous response was cut short (cancel rule 6). */
export const interruptMarker = (id: string, why: InterruptReason | "crash") =>
  synthetic(
    id,
    HARNESS_ORIGIN.interrupt,
    why === "user"
      ? "The user stopped the previous response before it finished."
      : "The previous response was cut short when the harness restarted.",
  )

/** The note after a model call failed with partial text already durable, so the retry continues instead of starting over. */
export const continuationNote = (id: string) =>
  synthetic(
    id,
    HARNESS_ORIGIN.continuation,
    "Your previous response was cut off by a provider error. Continue exactly where it stopped; do not repeat what you already wrote.",
  )

// ---------------------------------------------------------------- execution

export const executionStarted = (id = "exe_1") => event("execution.started", { executionId: x(id) })
export const executionResumed = (id = "exe_1") => event("execution.resumed", { executionId: x(id) })
export const executionSucceeded = (id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification: { status: "not_configured" } })
/** A subagent's execution ends: its turn is not verified by itself, and the ending says who verifies it. */
export const executionLeftToParent = (id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification: { status: "left_to_parent" } })
export const executionFailed = (message: string, id = "exe_1") =>
  event("execution.failed", { executionId: x(id), message })
/** The cancel or the shutdown signal arrives: durable before anything is stopped. */
export const interruptRequested = (reason: InterruptReason, id = "exe_1") =>
  event("execution.interrupt_requested", { executionId: x(id), reason })
export const executionInterrupted = (reason: InterruptReason, id = "exe_1") =>
  event("execution.interrupted", { executionId: x(id), reason })

/**
 * The start of every single-turn scenario: the session exists, the user's
 * prompt `u1` was admitted, the claim was taken, the baseline frozen and the
 * prompt delivered. Seq 1..5; `u1` has seq 5.
 */
export const opening = (prompt = "Fix the failing test.") => [
  created(),
  enqueue("u1", prompt),
  executionStarted(),
  baseline(),
  deliver("u1"),
]

// ---------------------------------------------------------------- steps

export const stepStarted = (id: string, attempt = 1, model = MODEL) => event("step.started", { messageId: m(id), attempt, model })
export const stepEnded = (id: string, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage })
/** A step ends whose request the provider measured at `inputTokens` tokens. */
export const stepEndedAt = (id: string, inputTokens: number, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage: measured(inputTokens) })
export const stepFailed = (id: string, error: StepError) => event("step.failed", { messageId: m(id), error, usage: null })
/**
 * The open step is closed as interrupted. `during` says where it was cut: in the model call (`"call"`, the
 * default), whose usage the provider had not reported yet, or while its tools ran (`"tools"`), after the call
 * itself had finished and reported what it cost.
 */
export const stepInterrupted = (id: string, reason: InterruptReason, during: "call" | "tools" = "call") =>
  event("step.failed", { messageId: m(id), error: { kind: "interrupted", reason }, usage: during === "tools" ? usage : null })
export const stepCrashed = (id: string) => stepFailed(id, { kind: "crashed" })
export const stepProviderFailed = (id: string, error: ProviderError) => stepFailed(id, { kind: "provider", error })
export const stepRefused = (id: string, message: string, excludeFromSeq: number) =>
  event("step.refused", { messageId: m(id), message, excludeFromSeq, usage })
export const retryScheduled = (id: string, attempt: number, error: ProviderError, delayMs = 2000) =>
  event("retry.scheduled", { messageId: m(id), attempt, delayMs, error })

export const say = (id: string, value: string) => event("text.ended", { messageId: m(id), text: value, providerData: null })
export const think = (id: string, value: string) =>
  event("reasoning.ended", { messageId: m(id), text: value, providerData: { encrypted_content: "gAAAA" } })

// ---------------------------------------------------------------- tools

export const called = (id: string, callId: string, name: ToolName | (string & {}), input: string) =>
  event("tool.called", { messageId: m(id), callId: c(callId), name, input, providerData: null })
/** The tool begins. `name` picks the effect class the loop records with the start (see `TOOLS`). */
export const toolStarted = (id: string, callId: string, name: ToolName) =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect: TOOLS[name] })
/** The start of a call under the approval layer: `run` is what the decision let it run under. */
export const startedAs = (id: string, callId: string, name: ToolName, run: CallRun) =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect: TOOLS[name], run })
/** The start of a call to a tool outside `TOOLS`, with the effect class its registry entry had when it ran. */
export const toolStartedAs = (id: string, callId: string, effect: ToolEffect) =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect })
/** The user asks for this one running call to stop; the turn goes on. Durable before the call's signal fires. */
export const cancelRequested = (id: string, callId: string) => event("tool.cancel_requested", { messageId: m(id), callId: c(callId) })
export const settled = (id: string, callId: string, outcome: ToolOutcome, output: string) =>
  event("tool.settled", {
    messageId: m(id),
    callId: c(callId),
    outcome,
    output,
    truncation: null,
    attachments: [],
    display: null,
  })

/** The result of an edit a language server was asked about: the output with the note in it, and what the servers said. */
export const settledDiagnosed = (id: string, callId: string, output: string, diagnostics: DiagnosticsRecord) =>
  event("tool.settled", { messageId: m(id), callId: c(callId), outcome: "success", output, truncation: null, attachments: [], display: null, diagnostics })

/**
 * A hook applied. `call` is the call it applied to (`[message, call]`), or
 * `null` for a stop hook. The scenarios' hooks are the user's own and run
 * with the approval layer off, so unsandboxed. `toModel` is the hook's text
 * that reached the model: the reason, the note or the message; `null` when
 * its answer sent nothing to the model. The duration is a stand-in.
 */
export function hookRan(hook: Hook, call: readonly [string, string] | null, answer: HookAnswer["kind"], toModel: string | null = null) {
  return event("hook.ran", {
    point: hook.point,
    messageId: call === null ? null : m(call[0]),
    callId: call === null ? null : c(call[1]),
    hookId: hook.id,
    name: hook.name,
    origin: hook.origin,
    fingerprint: hook.fingerprint,
    run: { kind: "ran", sandbox: null },
    answer,
    failure: null,
    detail: null,
    exitCode: answer === "yes" ? 0 : answer === "no" ? 2 : null,
    durationMs: 0,
    toModel,
    forUser: "",
    taint: null,
  })
}

/** The execution ends as done although stop hooks still objected: the turn had been sent back as often as it may be. */
export const succeededUnsatisfied = (unsatisfied: readonly string[], text = "", id = "exe_1", objections: readonly string[] = [...new Set(unsatisfied)]) =>
  event("execution.succeeded", { executionId: x(id), verification: { status: "not_configured" }, hooks: { unsatisfied: [...unsatisfied], objections: objections.map((hook) => ({ hook, text })) } })

/** A result with the structured data its tool reported for a client to show (a command's exit code). */
export const settledWith = (id: string, callId: string, outcome: ToolOutcome, output: string, display: { readonly [key: string]: number | string | null }) =>
  event("tool.settled", { messageId: m(id), callId: c(callId), outcome, output, truncation: null, attachments: [], display })

/** A call that runs and succeeds: called, started, settled. */
export const ran = (id: string, callId: string, name: ToolName, input: string, output: string) => [
  called(id, callId, name, input),
  toolStarted(id, callId, name),
  settled(id, callId, "success", output),
]

/** The texts the loop freezes into `tool.settled` when it, rather than the tool, decides the outcome. */
export const NOT_STARTED = "Not run: the response was stopped before this call started. It is safe to call it again."
export const INTERRUPTED_READ = "Stopped before it finished. Nothing was changed; it is safe to call it again."
export const EFFECT_UNKNOWN =
  "Started, but stopped before it reported a result. It may or may not have taken effect: check the current state before repeating it."
/** For a call the user stopped by itself and whose tool reported nothing. */
export const CANCELLED_READ = "Stopped by the user before it finished; the user stopped this call only, and the turn goes on. Nothing was changed."
export const CANCELLED_EFFECT_UNKNOWN =
  "Stopped by the user before it reported a result; the user stopped this call only, and the turn goes on. It may or may not have taken effect: check the current state before repeating it."
/** The line the shell tool ends its output with when the user stopped that one command. */
export const STOPPED_BY_USER = "[Stopped by the user. The command and its child processes were stopped; the output above is everything it printed before that.]"
export const CRASH_READ = "Cut short by a restart before it finished. Nothing was changed; it is safe to call it again."
export const CRASH_EFFECT_UNKNOWN =
  "Started, but the harness restarted before its result was recorded. It may or may not have taken effect: check the current state before repeating it."

// ---------------------------------------------------------------- approval

/** The home directory of the scenarios' user. */
export const HOME = "/home/user"
/** Why the scenarios' machine has no sandbox, where it has none. */
export const NO_SANDBOX = "bubblewrap (bwrap) is not installed."
/** What a sandboxed command without extra access runs with. */
export const SANDBOXED = { network: false, writableRoots: [] } as const
/** The same with the network granted. */
export const WITH_NETWORK = { network: true, writableRoots: [] } as const

/** A path argument of a call, classified as the loop classifies it in the scenarios' workspace (`/repo`). */
export const fact = (given: string): PathFact =>
  pathFact(given, { cwd: "/repo", workspace: "/repo", home: HOME, hiddenPaths: [`${HOME}/.ssh`], readlink: () => null })

/** What `tool.started` records for a call that ran: the mode, its path facts, and how a command was sandboxed (`null`: it was not). */
export const ranUnder = (mode: ApprovalMode, paths: readonly string[] = [], sandbox: CallRun["sandbox"] = null): CallRun => ({ mode, origin: "builtin", paths: paths.map(fact), sandbox })

/** The escalation a shell call asks for with its `sandbox` argument. */
export const escalate = (network: boolean, write: readonly string[] = []): Escalation => ({ network, write: write.map(fact) })

/** The session's taint after these sources, as the fold over the log gives it. */
export const taintedBy = (...sources: TaintSource[]): TaintState => (sources.length === 0 ? CLEAN : { tainted: true, since: sources[0]!.at, sources })

export interface Asked {
  readonly mode?: ApprovalMode
  readonly name: ToolName
  /** The call's path arguments. */
  readonly paths?: readonly string[]
  /** A shell call's command. */
  readonly command?: string
  readonly escalation?: Escalation
  readonly sandbox?: SandboxState
  readonly taint?: TaintState
  readonly grants?: readonly Grant[]
}

/** What the decision layer says about a call when someone is present: exactly what the loop asks it. */
export function decision(asked: Asked): Decision {
  const call: CallFacts = {
    tool: asked.name,
    effect: TOOLS[asked.name],
    origin: "builtin",
    paths: (asked.paths ?? []).map(fact),
    command: asked.command ?? null,
    escalation: asked.escalation ?? null,
  }
  return decide({
    policy: { mode: asked.mode ?? "auto", unattended: "deny", taint: "enforce" },
    call,
    sandbox: asked.sandbox ?? { available: true },
    taint: asked.taint ?? CLEAN,
    grants: asked.grants ?? [],
    present: true,
    now: 0,
    workspace: "/repo",
    home: HOME,
  })
}

/** The user is asked about a call: the question, what it is about and how the call runs when approved are the decision layer's. */
export function approvalRequested(id: string, callId: string, asked: Asked) {
  const made = decision(asked)
  if (made.kind !== "ask") throw new Error(`the decision for ${id}/${callId} is ${made.kind}, not a question`)
  return event("approval.requested", {
    messageId: m(id),
    callId: c(callId),
    mode: asked.mode ?? "auto",
    paths: (asked.paths ?? []).map(fact),
    escalation: asked.escalation ?? null,
    question: made.question,
    needs: [...made.needs],
    then: made.then,
  })
}

/**
 * The user's answer. `seq` is the position of this very event, which a
 * session approval is stamped with; `grantedAt` is a stand-in (the loop
 * records its clock).
 */
export function approvalAnswered(id: string, callId: string, asked: Asked, choice: ChoiceId, seq: number, note: string | null = null) {
  const made = decision(asked)
  if (made.kind !== "ask") throw new Error(`the decision for ${id}/${callId} is ${made.kind}, not a question`)
  const chosen = made.question.choices.find((item) => item.id === choice)
  if (chosen === undefined) throw new Error(`the question about ${id}/${callId} offers no choice ${choice}`)
  return event("approval.answered", { messageId: m(id), callId: c(callId), choice, approve: chosen.approve, note, grants: stampGrants(chosen.grants, seq, 0) })
}

/** The call is refused without a question: by the policy, or because nobody is present to answer (`needs` is what it needed). */
export const approvalDenied = (id: string, callId: string, asked: Asked, reason: "policy" | "unattended", stop = false) => {
  const made = decision(asked)
  const needs: readonly Need[] = made.kind === "ask" ? made.needs : []
  return event("approval.denied", {
    messageId: m(id),
    callId: c(callId),
    mode: asked.mode ?? "auto",
    paths: (asked.paths ?? []).map(fact),
    escalation: asked.escalation ?? null,
    reason,
    needs: [...needs],
    stop,
  })
}

/** The text the model reads for a call the policy refused, or that nobody was there to approve. */
export function refusal(asked: Asked): string {
  const made = decide({
    policy: { mode: asked.mode ?? "auto", unattended: "deny", taint: "enforce" },
    call: { tool: asked.name, effect: TOOLS[asked.name], origin: "builtin", paths: (asked.paths ?? []).map(fact), command: asked.command ?? null, escalation: asked.escalation ?? null },
    sandbox: asked.sandbox ?? { available: true },
    taint: asked.taint ?? CLEAN,
    grants: asked.grants ?? [],
    present: false,
    now: 0,
    workspace: "/repo",
    home: HOME,
  })
  if (made.kind !== "deny") throw new Error(`the decision is ${made.kind}, not a refusal`)
  return made.message
}

/** The user is told, once, that untrusted content is in the conversation: `source` is the first result that brought some in. */
export const taintNoticed = (source: TaintSource) => event("taint.noticed", { source, text: describeTaint(taintedBy(source)) })
export const taintCleared = () => event("taint.cleared", {})
/** The run ends because a call needed approval and nobody was there (`unattended: "stop"`); `refused` is what the model was told. */
export const executionStopped = (refused: string, id = "exe_1") =>
  event("execution.failed", { executionId: x(id), message: `Stopped: a tool call needed your approval and nobody was there to give it. ${refused}`, cause: "approval" })
/** What the user declined reads as. */
export const DECLINED = "Not run: the user declined this call."
/** The note a sandboxed command's output ends with when it failed the way a missing network makes commands fail. */
export const NETWORK_HINT =
  '[sandbox] This command ran in the sandbox (no network, and writes only inside the workspace and the temp directory), and its output shows an error the sandbox can cause. If it needs that access, run it again with `sandbox: { "network": true }`; the user will be asked.'

// ---------------------------------------------------------------- compaction

/** The context window of the compaction scenarios: 10,000 tokens, of which 2,000 are kept free for the answer. */
export const WINDOW = 10_000
/** The prompt a summary request appends, as the loop freezes it into `compaction.started`. */
export const SUMMARY_PROMPT = summaryPrompt()

/** A summary of the required form. */
export const SUMMARY = [
  "## Goal",
  "- Find out why the test fails and fix it.",
  "## Instructions and constraints",
  "- None.",
  "## Decisions",
  "- None.",
  "## Work completed",
  "- Read the files involved.",
  "## In progress",
  "- Looking for the wrong expectation.",
  "Next step: fix the expectation in a.test.ts.",
  "## Files",
  "- a.test.ts: read.",
  "## Commands",
  "- None.",
  "## Open questions",
  "- None.",
  "## Verbatim",
  "- None.",
].join("\n")
/** An answer that is not a summary of the required form: prose, with none of the sections. */
export const NOT_A_SUMMARY = "The user asked for a fix and some files were read."
/** What is wrong with `NOT_A_SUMMARY`, as the validator lists it. */
export const NOT_A_SUMMARY_PROBLEMS: readonly SummaryProblem[] = [
  "Goal",
  "Instructions and constraints",
  "Decisions",
  "Work completed",
  "In progress",
  "Files",
  "Commands",
  "Open questions",
  "Verbatim",
].map((heading) => ({ kind: "missing_section", heading }))

/**
 * A compaction begins. `keepFromSeq` is the cut: the first `seq` kept word
 * for word (the compaction's own `seq` when nothing is kept). `tokensBefore`
 * is a stand-in: the loop records its size estimate of the next request.
 */
export const compactionStarted = (id: string, keepFromSeq: number, trigger: "auto" | "overflow" | "manual" = "auto", mode: CompactionMode = "normal") =>
  event("compaction.started", { messageId: m(id), trigger, mode, keepFromSeq, prompt: SUMMARY_PROMPT, tokensBefore: 0 })
/** The first answer was not usable: the loop records it and what it asks the model to fix. */
export const compactionRepair = (id: string, answer: string, problems: readonly SummaryProblem[], attempt = 2) =>
  event("compaction.repair_requested", { messageId: m(id), attempt, answer, prompt: summaryRepairPrompt(problems) })
/**
 * The checkpoint a compaction freezes: the summary (or, with `null`, the
 * statement that there is none), the identifier index and the user's
 * messages verbatim, exactly as `buildCheckpoint` renders them from the
 * messages before the cut. `before` is every event of the scenario up to the
 * compaction. `inProgress`: the cut left the turn's request out of the kept tail.
 */
export function checkpoint(before: readonly NewEvent[], keepFromSeq: number, summary: string | null = SUMMARY, inProgress = false): string {
  const messages = fold(null, before).messages.filter((message) => message.excluded === null)
  const earlier = messages.filter((message) => message.seq < keepFromSeq)
  // As the loop does: the model's task list, when the call that last set it is before the cut.
  const list = currentTodos(earlier)
  const todos = list !== null && list.items.length > 0 && currentTodos(messages.filter((message) => message.seq >= keepFromSeq)) === null ? renderTodos(list) : null
  return buildCheckpoint({ summary, earlier, inProgress, todos }).text
}
/**
 * The compaction completes with its checkpoint. `tokensAfter` is a stand-in: the loop records its estimate of the
 * next request. `calls` is how many summary requests it took: one, or two when the model was asked to repair its answer.
 */
export const compactionEnded = (id: string, checkpointText: string, source: "model" | "repaired" | "fallback" = "model", detail: string | null = null, calls = source === "model" ? 1 : 2) =>
  event("compaction.ended", { messageId: m(id), summary: checkpointText, source, detail, tokensAfter: 0, usage: null, calls })
/** The compaction did not complete, after `calls` summary requests. */
export const compactionFailed = (id: string, error: StepError, calls = 1) => event("compaction.failed", { messageId: m(id), error, calls })
/** Why a compaction completed without a summary when both answers were unusable: `compaction.ended.detail`. */
export const UNUSABLE = (problems: readonly SummaryProblem[]) =>
  `the model's summary was unusable, also after it was asked to fix it: ${problems.slice(0, 2).map(describeProblem).join("; ")}${problems.length > 2 ? `; and ${problems.length - 2} more` : ""}`

// ---------------------------------------------------------------- provider errors

export const providerError = (kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number) =>
  makeProviderError(kind, message, { ...(status === undefined ? {} : { status }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
export const rateLimited = providerError("rate_limit", "Rate limit reached", 429, 3000)
export const serverError = providerError("provider_internal", "The server had an error", 500)
export const incompleteStream = providerError("incomplete_stream", "The stream ended without a terminal event")

// ---------------------------------------------------------------- folding and views

/** Folds a list of events onto `state`, assigning dense `seq` and `time = seq * 10`. */
export function fold(state: Projection | null, events: readonly NewEvent[]): Projection {
  let next = state
  for (const item of events) next = reduce(next, position(next, item))
  if (next === null) throw new Error("nothing was folded")
  return next
}

export function position(state: Projection | null, item: NewEvent) {
  const seq = (state?.lastSeq ?? 0) + 1
  return { ...item, sessionId: SESSION, seq, time: seq * 10 }
}

/** Every event of a scenario in order. */
export const allEvents = (scenario: Scenario) => scenario.phases.flatMap((phase) => phase.events)

/** What a UI shows for each message. */
export function view(projection: Projection): MessageView[] {
  return projection.messages.map((message) => {
    const common = { id: message.id as string, kind: message.kind, excluded: message.excluded }
    switch (message.kind) {
      case "user":
        return {
          ...common,
          status: null,
          attempt: null,
          text: contentText(message.content),
          calls: [],
          error: null,
          origin: null,
          command: message.command === undefined ? null : `/${message.command.name}${message.command.arguments === "" ? "" : ` ${message.command.arguments}`}`,
        }
      case "synthetic":
        return {
          ...common,
          status: null,
          attempt: null,
          text: contentText(message.content),
          calls: [],
          error: null,
          origin: message.origin,
          command: null,
        }
      case "instruction":
        return { ...common, status: null, attempt: null, text: message.text, calls: [], error: null, origin: null, command: null }
      case "compaction":
        return {
          ...common,
          status: message.status,
          attempt: null,
          text: message.summary ?? "",
          calls: [],
          error: message.error === null ? null : errorText(message.error),
          origin: null,
          command: null,
        }
      case "assistant":
        return {
          ...common,
          status: message.status,
          attempt: message.attempt,
          text: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("|"),
          calls: message.parts.flatMap((part) =>
            part.type === "tool_call"
              ? [`${part.callId} ${part.name} ${part.state.status === "settled" ? part.state.outcome : part.state.status}${part.cancel === undefined ? "" : " (stopped by the user)"}`]
              : [],
          ),
          error: message.error === null ? null : errorText(message.error),
          origin: null,
          command: null,
        }
    }
  })
}

/** What is open, as a scenario names it: the message ID of a step or compaction, `checks:<run>`, `revert` or `undo`; `null` at a boundary. */
export function openLabel(projection: Projection): string | null {
  const open = projection.session.open
  if (open === null) return null
  if (open.kind === "step" || open.kind === "compaction") return open.messageId
  return open.kind === "checks" ? `checks:${open.run}` : open.kind
}

export const historyIds = (projection: Projection) => selectModelHistory(projection).messages.map((message) => message.id as string)

function contentText(content: readonly { type: string; text?: string }[]) {
  return content.map((part) => part.text ?? "[media]").join("")
}

function errorText(error: StepError) {
  switch (error.kind) {
    case "provider":
      return `provider:${error.error.kind}`
    case "interrupted":
      return `interrupted:${error.reason}`
    case "crashed":
      return "crashed"
    case "internal":
      return "internal"
  }
}

/** A one-line rendering of an event, for the scenario index. */
export function describeEvent(item: NewEvent): string {
  const d = item.data as Record<string, unknown>
  const quote = (value: unknown) => JSON.stringify(String(value).length > 60 ? `${String(value).slice(0, 57)}...` : value)
  switch (item.type) {
    case "session.created": {
      const lineage = item.data.lineage
      if (lineage === null) return "session.created"
      if (lineage.kind === "fork") return `session.created fork of ${lineage.parentSessionId} through seq ${lineage.throughSeq}`
      if (lineage.kind === "spawn") return `session.created subagent of ${lineage.parentSessionId} (${lineage.spawnId}, depth ${lineage.depth}) ${quote(item.data.title)}`
      const changed = [...(lineage.changed.instructions ? ["the system prompt"] : []), ...lineage.changed.tools.map((tool) => `the description of ${tool}`), ...(lineage.changed.settings ? ["the model settings"] : [])]
      return `session.created replay of ${lineage.sourceSessionId} through seq ${lineage.throughSeq}, policy ${lineage.policy}, changed: ${changed.join(", ") || "nothing"}`
    }
    case "spawn.started": {
      const work = item.data.work
      return `spawn.started ${d.spawnId} by ${d.messageId}/${d.callId} ${work.kind === "subagent" ? `subagent ${work.sessionId}` : `command ${quote(work.command)}`}${d.background ? " background" : ""}`
    }
    case "watch.started":
      return `watch.started ${d.watchId} on ${d.spawnId} ${d.regex ? `/${d.pattern}/${d.ignoreCase ? "i" : ""}` : `${quote(d.pattern)}${d.ignoreCase ? " ignoring case" : ""}`} limit=${d.limit}`
    case "watch.fired":
      return `watch.fired ${d.watchId} on ${d.spawnId} firing=${d.firing} ${quote(d.line)} told by ${d.messageId}`
    case "watch.ended":
      return `watch.ended ${d.watchId} on ${d.spawnId} ${d.reason}`
    case "spawn.ended":
      return `spawn.ended ${d.spawnId} ${d.outcome}${d.exitCode === null ? "" : ` exit=${d.exitCode}`}${item.data.usage === null ? "" : ` usage=${item.data.usage.inputTokens}in/${item.data.usage.outputTokens}out`}`
    case "replay.call":
      return `replay.call ${d.messageId}/${d.callId} ${d.result}${item.data.recorded === null ? "" : ` recorded step ${item.data.recorded.step + 1} call ${item.data.recorded.call + 1}`}${d.divergence === null ? "" : ` (${d.divergence})`}${d.executed ? " executed" : ""}`
    case "replay.diverged":
      return `replay.diverged ${d.divergence} -> ${d.workspace}${d.snapshot === null ? " (no snapshot: the copy is empty)" : ` from ${d.snapshot}`}`
    case "replay.ended":
      return `replay.ended ${d.outcome} ${quote(d.reason)}`
    case "baseline.set":
      return "baseline.set"
    case "inbox.enqueued":
      return `inbox.enqueued ${d.messageId} ${d.delivery}${d.origin === null ? "" : ` origin=${d.origin}`} ${quote(contentText(item.data.content))}`
    case "command.expanded": {
      const use = item.data
      const typed = `/${use.name}${use.arguments === "" ? "" : ` ${use.arguments}`}`
      const missing = use.missing.length === 0 ? "" : ` missing=${use.missing.map((position) => `$${position}`).join(",")}`
      const left = use.unsupported.length === 0 ? "" : ` left as text: ${use.unsupported.map((construct) => construct.text).join(", ")}`
      return `command.expanded ${d.messageId} ${quote(typed)} (${use.scope})${missing}${left}`
    }
    case "synthetic.appended":
      return `synthetic.appended ${d.messageId} origin=${d.origin} ${quote(contentText(item.data.content))}`
    case "instruction.appended":
      return `instruction.appended ${d.messageId} source=${d.source} ${quote(d.text)}`
    case "step.started":
      return `step.started ${d.messageId} attempt=${d.attempt}${d.model === MODEL ? "" : ` model=${d.model}`}`
    case "settings.changed":
      return `settings.changed model=${d.model} reasoningEffort=${d.reasoningEffort}`
    case "step.ended":
      return `step.ended ${d.messageId} finish=${d.finish}`
    case "step.failed":
      return `step.failed ${d.messageId} ${errorText(item.data.error)}`
    case "step.refused":
      return `step.refused ${d.messageId} excludeFromSeq=${d.excludeFromSeq}`
    case "retry.scheduled":
      return `retry.scheduled ${d.messageId} attempt=${d.attempt} delayMs=${d.delayMs} after ${item.data.error.kind}`
    case "text.ended":
    case "reasoning.ended":
      return `${item.type} ${d.messageId} ${quote(d.text)}`
    case "tool.called":
      return `tool.called ${d.messageId}/${d.callId} ${d.name} ${d.input}`
    case "tool.started": {
      const run = item.data.run
      if (run === undefined) return `tool.started ${d.messageId}/${d.callId} effect=${d.effect}`
      const how = run.sandbox === null ? "" : ` sandboxed${run.sandbox.network ? "+network" : ""}${run.sandbox.writableRoots.length > 0 ? `+write:${run.sandbox.writableRoots.join(",")}` : ""}`
      const where = run.paths.length === 0 ? "" : ` ${run.paths.map((path) => `${path.given}:${path.place}`).join(",")}`
      return `tool.started ${d.messageId}/${d.callId} effect=${d.effect} mode=${run.mode}${how}${where}`
    }
    case "tool.cancel_requested":
      return `tool.cancel_requested ${d.messageId}/${d.callId}`
    case "approval.requested":
      return `approval.requested ${d.messageId}/${d.callId} ${quote(item.data.question.title)} choices=${item.data.question.choices.map((choice) => choice.id).join(",")}`
    case "approval.answered":
      return `approval.answered ${d.messageId}/${d.callId} ${d.choice}${item.data.grants.length === 0 ? "" : ` remembers=${item.data.grants.map((grant) => `${grant.scope}:${grant.rule.kind}`).join(",")}`}${d.note === null ? "" : ` note=${quote(d.note)}`}`
    case "approval.denied":
      return `approval.denied ${d.messageId}/${d.callId} ${d.reason}${item.data.needs.length === 0 ? "" : ` needs=${item.data.needs.map((need) => need.kind).join(",")}`}${d.stop ? " stop" : ""}`
    case "taint.noticed":
      return `taint.noticed ${item.data.source.kind} from ${item.data.source.tool} at seq ${item.data.source.at}`
    case "tool.settled": {
      const noted = item.data.diagnostics
      const servers = noted === undefined ? "" : ` diagnostics=${noted.servers.map((server) => `${server.name}:${server.outcome}${server.outcome === "compared" ? `(+${server.new})` : ""}`).join(",")}${noted.noteAdded ? " note" : ""}`
      return `tool.settled ${d.messageId}/${d.callId} ${d.outcome} ${quote(d.output)}${servers}`
    }
    case "hook.ran": {
      const record = item.data
      const where = record.callId === null ? "" : ` ${record.messageId}/${record.callId}`
      return `hook.ran ${record.point}${where} ${record.name} (${record.origin}) ${record.run.kind === "ran" ? record.answer : record.run.kind}${record.toModel === null ? "" : ` ${quote(record.toModel)}`}`
    }
    case "execution.failed":
      return `execution.failed ${d.executionId}${d.cause === undefined ? "" : ` cause=${d.cause}`} ${quote(d.message)}`
    case "execution.succeeded": {
      const outcome = item.data.verification
      const hooks = item.data.hooks === undefined ? "" : ` hooks unsatisfied=${item.data.hooks.unsatisfied.join(",")}`
      // Nothing verified is the plain case and is not spelled out with every scenario.
      if (outcome.status === "not_configured") return `execution.succeeded ${d.executionId}${hooks}`
      const detail = outcome.status === "unresolved" ? ` ${outcome.reason} failing=${outcome.failing.join(",")}` : ""
      return `execution.succeeded ${d.executionId} verification=${outcome.status}${detail}${hooks}`
    }
    case "turn.ended": {
      const outcome = item.data.verification
      const hooks = item.data.hooks === undefined ? "" : ` hooks unsatisfied=${item.data.hooks.unsatisfied.join(",")}`
      if (outcome.status === "not_configured") return `turn.ended${hooks}`
      const detail = outcome.status === "unresolved" ? ` ${outcome.reason} failing=${outcome.failing.join(",")}` : ""
      return `turn.ended verification=${outcome.status}${detail}${hooks}`
    }
    case "snapshot.taken":
      return `snapshot.taken ${d.id} ${d.point}${d.messageId === null ? "" : ` ${d.messageId}`}`
    case "snapshot.unavailable":
      return `snapshot.unavailable ${d.reason}`
    case "checks.started":
      return `checks.started run=${d.run} ${item.data.checks.join(",")}`
    case "checks.finished":
      return `checks.finished run=${d.run} ${item.data.evidence.checks.map((check) => `${check.name}:${check.status}`).join(",")}`
    case "checks.failed":
      return `checks.failed run=${d.run} ${errorText(item.data.error)}`
    case "revert.started":
      return `revert.started fromSeq=${d.fromSeq} target=${d.target} before=${d.before}`
    case "revert.undo_started":
      return `revert.undo_started revertSeq=${d.revertSeq} target=${d.target} before=${d.before}`
    case "history.reverted":
    case "history.restored": {
      const record = item.data.restore
      const range = item.type === "history.reverted" ? `fromSeq=${item.data.fromSeq}` : `revertSeq=${item.data.revertSeq}`
      return `${item.type} ${range} ${record === null ? "no files restored" : `restored=${record.target} changed=${record.changed}`}`
    }
    case "execution.interrupt_requested":
    case "execution.interrupted":
      return `${item.type} ${d.executionId} ${d.reason}`
    case "compaction.started":
      return `compaction.started ${d.messageId} ${d.trigger} ${d.mode} keepFromSeq=${d.keepFromSeq}`
    case "compaction.repair_requested":
      return `compaction.repair_requested ${d.messageId} attempt=${d.attempt} ${quote(d.answer)}`
    case "compaction.ended":
      return `compaction.ended ${d.messageId} source=${d.source}${d.detail === null ? "" : ` (${String(d.detail).length > 70 ? `${String(d.detail).slice(0, 67)}...` : d.detail})`}`
    case "compaction.failed":
      return `compaction.failed ${d.messageId} ${errorText(item.data.error)}`
    default: {
      const id = d.executionId ?? d.messageId
      return id === undefined ? item.type : `${item.type} ${id}`
    }
  }
}

// ---------------------------------------------------------------- the workspace, checks and reverts

/**
 * The workspace was recorded. `id` is a name for its contents (`w0` for the
 * files the session started with, `w1` after the first change): a real ID is
 * the hash of the tree, and the same contents always have the same one.
 */
export const snap = (point: SnapshotPoint, id: string, step: string | null = null) =>
  event("snapshot.taken", { id, point, messageId: step === null ? null : m(step) })

/** `opening()` for a session with snapshots: the workspace is recorded as `w0` before the prompt is delivered. Seq 1..6; `u1` has seq 6. */
export const openingIn = (prompt = "Fix the failing test.", workspace = "w0") => [
  created(),
  enqueue("u1", prompt),
  executionStarted(),
  snap("delivery", workspace),
  baseline(),
  deliver("u1"),
]

/** A step whose one call changes a file: the workspace is recorded right before the tool runs and right after. */
export const wrote = (id: string, input: string, output: string, from: string, to: string) => [
  stepStarted(id),
  called(id, "call_1", "write", input),
  snap("step_start", from, id),
  toolStarted(id, "call_1", "write"),
  settled(id, "call_1", "success", output),
  snap("step_end", to, id),
  stepEnded(id, "tool_calls"),
]

/** The one check the verification scenarios configure. */
export const CHECK = { name: "test", command: "bun test", timeoutSeconds: 120 } as const
/** Their configuration file. */
export const CHECKS_CONFIG: ConfigFile = { checks: [{ name: CHECK.name, command: CHECK.command }] }
/** What the failing check prints. */
export const CHECK_OUTPUT = "1 fail\n"

/** The result of the check as the runner shapes it. */
export function checkResult(status: CheckStatus, check: { readonly name: string; readonly command: string; readonly timeoutSeconds: number } = CHECK): CheckResult {
  const bytes = new TextEncoder().encode(status === "passed" || status === "interrupted" ? "" : CHECK_OUTPUT)
  const lines = bytes.length === 0 ? 0 : 1
  return {
    name: check.name,
    command: check.command,
    timeoutSeconds: check.timeoutSeconds,
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    signal: null,
    interruptedBy: null,
    startError: null,
    durationMs: 0,
    output: { totalBytes: bytes.length, totalLines: lines, path: null, savedBytes: bytes.length, source: { head: bytes, tail: bytes, tailAtLineStart: true, totalBytes: bytes.length, totalLines: lines } },
  }
}

/**
 * The record of one run of the check. `afterSeq`, `fingerprint`, `durationMs`
 * and `outputPath` are stand-ins (the loop fills in the position of
 * `checks.started`, a hash of the changed files' state, the time taken and
 * the file that keeps the output).
 */
export function evidence(run: number, status: CheckStatus, changedFiles: readonly string[]): VerificationEvidence {
  const result = checkResult(status)
  return {
    run,
    afterSeq: 0,
    changedFiles: [...changedFiles],
    checks: [
      {
        name: result.name,
        command: result.command,
        status,
        exitCode: result.exitCode,
        signal: null,
        durationMs: 0,
        files: [...changedFiles],
        fingerprint: "fingerprint",
        reusedFromSeq: null,
        outputPath: null,
        outputBytes: result.output.totalBytes,
        outputLines: result.output.totalLines,
      },
    ],
  }
}

export const checksStarted = (run: number) => event("checks.started", { run, checks: [CHECK.name] })
export const checksFinished = (run: number, status: CheckStatus, changedFiles: readonly string[]) =>
  event("checks.finished", { run, evidence: evidence(run, status, changedFiles) })
export const checksFailed = (run: number, error: StepError) => event("checks.failed", { run, error })
/** The report of a failing run, exactly as the model is shown it. */
export const checkReport = (id: string) => synthetic(id, HARNESS_ORIGIN.checkReport, renderReport([checkResult("failed")]))

/** The execution ends as done, with what the gate found. */
export const succeededWith = (verification: VerificationOutcome, id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification })
export const passed = (run: number, changedFiles: readonly string[]): VerificationOutcome => ({ status: "passed", evidence: evidence(run, "passed", changedFiles) })
export const unresolved = (
  reason: "acknowledged" | "max_rounds" | "report_mode",
  run: number,
  changedFiles: readonly string[],
  acknowledgement: Acknowledgement | null = null,
): VerificationOutcome => ({ status: "unresolved", reason, failing: [CHECK.name], acknowledgement, evidence: evidence(run, "failed", changedFiles) })

/** What a restore did: from `before` to `target`, `changed` files written or removed, nothing kept. */
export const restore = (target: string, before: string, changed: number, removed = 0): RestoreRecord => ({ target, before, after: target, written: changed - removed, removed, changed, kept: [], keptOmitted: 0 })
export const revertStarted = (fromSeq: number, target: string, before: string) => event("revert.started", { fromSeq, target, before, keep: [] })
export const historyReverted = (fromSeq: number, record: RestoreRecord | null) => event("history.reverted", { fromSeq, restore: record })
export const undoStarted = (revertSeq: number, target: string, before: string) => event("revert.undo_started", { revertSeq, target, before, keep: [] })
export const historyRestored = (revertSeq: number, record: RestoreRecord | null) => event("history.restored", { revertSeq, restore: record })
