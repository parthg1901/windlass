/**
 * The narrow interface between the command-line interface and the engine (the
 * step loop and the store behind it). The CLI needs nothing else from the
 * engine, so wiring the real one in means implementing these types.
 *
 * Everything the CLI shows comes from `Session.events`: the durable events the
 * engine appends and the ephemeral deltas it streams, in arrival order. The
 * CLI never asks the engine whether a turn is running; it reads that from the
 * `execution.*` events, the same way a reload of the log would.
 *
 * ## For the author of `real-engine.ts`
 *
 * The CLI loads `packages/cli/src/real-engine.ts` with a dynamic import and
 * calls its export `createRealEngine()` once, with no arguments, when a run is
 * not a `--demo` (see `select-engine.ts`). Everything per run arrives through
 * `Engine.open` and the optional listing methods. If the module is missing or
 * its import throws, the CLI prints one line and exits with code 2.
 *
 * What the CLI relies on, beyond the types below:
 * - `open` resolves once the session can take input; its recovery events, if
 *   any, are the first items of `events`.
 * - `send` may be called while an execution runs (steering). It must admit the
 *   item at once (`inbox.enqueued` with the given delivery) and resolve; the
 *   step loop delivers it later (`inbox.delivered`). A turn ends for the CLI
 *   only at `execution.succeeded`, `execution.failed` or `execution.interrupted`.
 * - `interrupt` must write `execution.interrupt_requested` (reason `user`)
 *   promptly: the CLI's "stopping" feedback is that event.
 * - `close` is called exactly once on every exit path (normal end, Ctrl-C at
 *   the prompt, SIGTERM, a closed stdout pipe), and the CLI waits for it for
 *   at most `CLOSE_TIMEOUT_MS` before exiting anyway. Anything still running
 *   is stopped as a `shutdown`, and `events` ends.
 * - `revert` and `undoRevert` are what `/undo` and `/redo` call. An engine
 *   that leaves them out has no undo, and the commands say so.
 */
import type { AgentsResult, CancelCallResult, ClientCommand, CommandsResult, CompactResult, TaskItem } from "@windlass/acp/extensions"
import type { DiffResult, ForkResult, HooksStateResult, LspStateResult, McpStateResult, MemoryChangeParams, MemoryChangeResult, MemoryStateResult, ReplayParams, ReplayResult, SkillsResult, WakeListResult, WakeSecretResult, WatchSetResult, WatchesResult } from "@windlass/acp/extensions"
import type { TurnEvent } from "@windlass/acp/turns"
import { brand } from "@windlass/core"
import type { CallId, ChoiceId, EphemeralEvent, HandEditPolicy, MessageId, Question, RevertOptions, RevertPlan, RevertResult, SessionId, StoredEvent } from "@windlass/core"

/** One item of a session's event stream. Durable and ephemeral type names are disjoint, so `type` tells them apart. */
export type EngineEvent = StoredEvent | EphemeralEvent

/**
 * What `/undo` and `/redo` ask when the restore would overwrite files edited
 * by hand: how to treat them, or `null` to change nothing.
 */
export type HandEditQuestion = (plan: RevertPlan) => Promise<HandEditPolicy | null>

/** The engine's `RevertOptions`, where `handEdits: "ask"` puts `confirm` to the user when it comes to that. */
export interface SessionRevertOptions extends Omit<RevertOptions, "handEdits"> {
  readonly handEdits?: HandEditPolicy | "ask"
  /** With `handEdits: "ask"`: asked once the engine finds files edited by hand that the restore would overwrite. */
  readonly confirm?: HandEditQuestion
}

/** The question about one tool call that waits for the user's answer (`approval.requested`). */
export interface ApprovalRequest {
  readonly messageId: MessageId
  readonly callId: CallId
  readonly question: Question
  /** Set when one of the session's subagents asks: its label (the first line of its task). The call is the subagent's. */
  readonly subagent?: string | null
}

/**
 * Answers an approval question: one of its choices, with a note if the user
 * wrote one, or `null` when the user backed out of it. Backing out stops the
 * turn: the question is withdrawn and the call does not run.
 */
export type Approver = (request: ApprovalRequest) => Promise<{ readonly choice: ChoiceId; readonly note?: string } | null>

/** What the CLI suggests when the saved sign-in is missing or rejected. */
export const SIGN_IN_ADVICE = `run \`${brand.binary} login\` to sign in with ChatGPT, then try again`

/**
 * A sign-in problem as one sentence with the way forward: `not signed in; run
 * \`windlass login\` ...`. `message` is the engine's own wording (which may repeat
 * the advice, or carry the provider's prefix); `what` says what could not be
 * done, for a command that is not a session (`--models`).
 */
export function signInSentence(message: string, what: string | null = null): string {
  return `${signInReason(message)}${what === null ? "" : `, so ${what}`}; ${SIGN_IN_ADVICE}`
}

/** The engine's sign-in problem without its advice: `not signed in`, `token request failed (400 invalid_grant): ...`. */
export function signInReason(message: string): string {
  const reason = message
    .replace(/^no usable access token:\s*/i, "")
    .replace(/\s*(Run the sign-in first|To sign in, .*)\.?\s*$/i, "")
    .replace(/[.\s]+$/, "")
  return reason === "" ? "not signed in" : reason.charAt(0).toLowerCase() + reason.slice(1)
}

/** Which session to work in. */
export type SessionTarget =
  /** A new session. */
  | { readonly kind: "new" }
  /** A named session (`--session <id>`). */
  | { readonly kind: "resume"; readonly id: string }
  /** The most recently used session in the working directory (`--continue`). */
  | { readonly kind: "continue" }

export interface OpenRequest {
  readonly session: SessionTarget
  /** Absolute working directory. */
  readonly cwd: string
  /** `null` keeps the session's or the configuration's default. */
  readonly model: string | null
  /** Provider-interpreted reasoning effort such as `"low"` or `"high"`; `null` keeps the default. */
  readonly effort: string | null
  /**
   * `--agent <name>`: the agent the session runs as (`none`: no agent). A new
   * session starts as it; a resumed one is switched to it. `null`: a new
   * session's is the configured default, a resumed one keeps its own.
   */
  readonly agent?: string | null
  /**
   * `--max-steps <n>`: the most model calls one turn may make before the loop
   * asks for a final answer without tools (the `step_limit` note). A whole
   * number of at least 1; `null` keeps the engine's default.
   */
  readonly maxSteps: number | null
  /** `--approval <mode>`: `ask`, `auto` or `full`; `null` keeps the configuration's (default `auto`). */
  readonly approval?: "ask" | "auto" | "full" | null
  /** `--unattended <deny|stop>`: what a call that would ask becomes when nobody can answer; `null` keeps the configuration's (default `deny`). */
  readonly unattended?: "deny" | "stop" | null
  /** Whether a person is at this terminal to answer questions: the interactive mode. A one-shot run, `--json` and a pipe are unattended, which is the default. */
  readonly attended?: boolean
}

/** How a message sent with `Session.send` reaches the model; the `delivery` of its `inbox.enqueued`. */
export type SendDelivery = "steer" | "queue"

export interface SendOptions {
  /**
   * - `steer` (the default): delivered at the next step boundary of the running
   *   execution, or starts one when the session is idle.
   * - `queue`: delivered only when the session would otherwise go idle.
   */
  readonly delivery?: SendDelivery
}

/** One row of `--list-sessions`. */
export interface SessionSummary {
  readonly id: SessionId
  readonly title: string | null
  readonly cwd: string
  /** Milliseconds since the Unix epoch of the session's latest event. */
  readonly updatedAt: number
  /** The session's current model (`settings.model`). */
  readonly model: string
}

/** One row of `--models`. */
export interface ModelInfo {
  readonly id: string
  /** A short description for the listing, or `null`. */
  readonly description: string | null
  /** Reasoning efforts `--effort` accepts for this model; empty when it has none. */
  readonly efforts: readonly string[]
  /** Whether a new session uses this model when `--model` is not given. */
  readonly isDefault: boolean
}

export interface Engine {
  /**
   * Opens or creates a session. If the session holds an execution claim from a
   * process that died or shut down, the engine recovers it here and the
   * recovery's events (`step.failed` crashed, `execution.resumed`, ...) are the
   * first items of `events`.
   */
  open(request: OpenRequest): Promise<Session>
  /**
   * `--list-sessions`: sessions whose working directory is `cwd`, most recently
   * used first. Optional: without it the flag reports that this engine cannot list sessions.
   */
  listSessions?(request: { readonly cwd: string }): Promise<readonly SessionSummary[]>
  /** `--models`: the models `--model` accepts. Optional, like `listSessions`. */
  listModels?(): Promise<readonly ModelInfo[]>
  /**
   * The command files a session in `cwd` would have, without opening one: what a one-prompt run looks at before it
   * opens a session for a prompt that is `/word`. `builtins`: the client's own commands, which hide a file of the
   * same name. Optional: without it the prompt is looked at once the session is open.
   */
  commands?(cwd: string, builtins: readonly ClientCommand[]): Promise<CommandsResult>
  /** `fork`: a new session with another's conversation up to a step boundary. Optional: without it the subcommand says this engine cannot fork. */
  fork?(request: ForkRequest): Promise<ForkOutcome>
  /** `replay`: replays a recorded session; `progress` gets the replay session's events as they happen, and `cancel` ends it as incomplete. */
  replay?(request: ReplayCommand, progress: ReplayProgress): Promise<ReplayResult>
}

/** A fork that was made, and the session the request named (`ForkResult.parentSessionId` is the one it was made from, which is another when the fork point lies in what the named session inherited). */
export interface ForkOutcome extends ForkResult {
  readonly named: string
}

/** What `fork` forks. `session` is an ID or a unique start of one; `null` is the latest session in `cwd`. */
export interface ForkRequest {
  readonly cwd: string
  readonly session: string | null
  readonly throughSeq: number | null
  /** After this turn (counted from 1, as the user sees turns), instead of `throughSeq`. */
  readonly turn?: number | null
  /** `null`: the fork shares the parent's working directory. `{ copyTo }`: a copy of its own (`null`: the default place). */
  readonly copy: { readonly copyTo: string | null } | null
  readonly model: string | null
  readonly effort: string | null
  readonly title: string | null
}

/** What `replay` replays, and how. */
export interface ReplayCommand {
  readonly cwd: string
  readonly session: string | null
  readonly params: Omit<ReplayParams, "sessionId" | "ref">
}

export interface ReplayProgress {
  /** The replay session started; `cancel` ends the replay as incomplete. */
  readonly started: (replaySessionId: string, sourceSessionId: string, cancel: () => void) => void
  readonly event: (event: EngineEvent) => void
}

export interface Session {
  readonly id: SessionId
  /**
   * Every event of this session from the moment it was opened, in arrival
   * order. One consumer. Ends after `close`.
   */
  readonly events: AsyncIterable<EngineEvent>
  /**
   * Admits a user message (`inbox.enqueued`). When the session is idle the
   * engine starts an execution for it; while one runs, the message waits for
   * its delivery point (see `SendOptions`). Resolves with the inbox item's
   * message ID once it is admitted, or `null` when it was not.
   */
  send(text: string, options?: SendOptions): Promise<MessageId | null>
  /**
   * The command files of the user and the project, as they are now, with the
   * ones that cannot be used. `builtins`: the client's own commands, which
   * hide a file of the same name. Optional: an engine without it has none.
   */
  commands?(builtins: readonly ClientCommand[]): Promise<CommandsResult>
  /**
   * `send` for `/name args` of a command file: its text, with `args` put in,
   * is admitted as the user's message, and the log records the file
   * (`command.expanded`, which follows the admission). Rejects, with the
   * sentence to show, when nothing was sent: no such file, one that cannot
   * be used, an agent it names that does not exist.
   */
  sendCommand?(name: string, args: string, options?: SendOptions): Promise<MessageId | null>
  /** Asks the running execution to stop with reason `user`. A no-op when nothing runs. */
  interrupt(): void
  /**
   * `/stop`: stops one running tool call and nothing else; the turn goes on, and the call's result says what
   * came of it. Resolves with whether the request was taken, and why not when it was not.
   */
  cancelCall?(target: { readonly messageId: MessageId; readonly callId: CallId }): Promise<CancelCallResult>
  /** `/undo`: goes back to before a user message (the latest by default), files and conversation. Only while idle. */
  revert?(options?: SessionRevertOptions): Promise<RevertResult>
  /** `/redo`: undoes the latest revert. Only while idle. */
  undoRevert?(options?: Omit<SessionRevertOptions, "messageId">): Promise<RevertResult>
  /**
   * Who answers the session's approval questions. Without one (and always in
   * an unattended run) a question is declined. Optional: an engine without
   * the approval layer never asks.
   */
  setApprover?(approver: Approver | null): void
  /** `/clear-taint`: the user says the conversation is trustworthy again. Resolves with whether it was tainted. */
  clearTaint?(): Promise<boolean>
  /** `/approval [mode]`: the session's approval mode (`ask`, `auto`, `full`), after switching to `mode` when given, and whether it is tainted. */
  approvalMode?(mode?: string): Promise<{ readonly mode: string | null; readonly tainted: boolean; readonly taint: string | null }>
  /** `/diff`: the files the latest turn changed, with bounded per-file patches. */
  diff?(): Promise<DiffResult>
  /** `/mcp`: the session's MCP servers. */
  mcp?(): Promise<McpStateResult>
  /** The user starts a server the project's configuration names (exactly that definition). */
  approveMcp?(name: string, fingerprint: string): Promise<boolean>
  /** Called whenever the session's MCP servers change (one started, failed, waits for approval). Returns the unsubscribe function. */
  onMcp?(listener: (state: McpStateResult) => void): () => void
  /** `/hooks`: the session's hooks, with their state and where each is defined. */
  hooks?(): Promise<HooksStateResult>
  /** The user allows a hook the project's configuration names (exactly that definition). */
  approveHook?(fingerprint: string): Promise<boolean>
  /** Called whenever the session's hooks change (the configuration was read, one waits for approval or was approved). Returns the unsubscribe function. */
  onHooks?(listener: (state: HooksStateResult) => void): () => void
  /** `/lsp`: the session's language servers, with their state and the files they serve. */
  lsp?(): Promise<LspStateResult>
  /** The user allows a language server the project's configuration names (exactly that definition). */
  approveLsp?(name: string, fingerprint: string): Promise<boolean>
  /** Called whenever the session's language servers change (one started, failed, waits for approval). Returns the unsubscribe function. */
  onLsp?(listener: (state: LspStateResult) => void): () => void
  /** `/skills`. */
  skills?(): Promise<SkillsResult>
  /** `/wakeups`, `/wakeups cancel <id>`, `/wakeups secret <id>`. A secret is for the user's eyes only. */
  wakeups?(): Promise<WakeListResult>
  cancelWake?(id: string): Promise<{ readonly cancelled: boolean; readonly message: string }>
  wakeSecret?(id: string): Promise<WakeSecretResult>
  /**
   * `/watch`: sets a watch on the output of a running background command (rejects with the engine's sentence when
   * it refuses), removes one, and lists the running commands with their watches.
   */
  watchOutput?(command: string, watch: { readonly pattern: string; readonly regex?: boolean; readonly ignoreCase?: boolean; readonly limit?: number }): Promise<WatchSetResult>
  unwatchOutput?(watchId: string): Promise<boolean>
  watches?(): Promise<WatchesResult>
  /** `/memory`, and the user's own changes to notes (`/remember`, `/forget`, `/memory confirm|reject|renew`). */
  memory?(): Promise<MemoryStateResult>
  memoryChange?(params: Omit<MemoryChangeParams, "sessionId">): Promise<MemoryChangeResult>
  /** `/agent`: the agents the session can run as, the one in force, and the definitions that could not be used. */
  agents?(): Promise<AgentsResult>
  /** `/agent <name>`: switches the session to that agent (`none`: to none). What happened arrives as the `agent.switched` event. */
  setAgent?(name: string): Promise<void>
  /** `/rename <title>`: gives the session a title; resolves with it as stored. */
  rename?(title: string): Promise<string>
  /** `/compact`: compacts the conversation now; resolves when it is done with what came of it. */
  compact?(): Promise<CompactResult>
  /** What the interactive mode says when it opens the session: its title and its turns (`/undo` keeps their count, marked undone). */
  describe?(): Promise<SessionDescription>
  /** Stops anything still running (as a shutdown) and ends `events`. */
  close(): Promise<void>
  /**
   * Why `events` ended without `close`, as a sentence for the user: the
   * engine went away (its process died). `null` while all is well. Engines
   * in this process never lose their sessions and leave it out.
   */
  lost?(): string | null
}

export interface SessionDescription {
  readonly title: string | null
  readonly turns: number
  /** Of `turns`, the ones `/undo` took back. */
  readonly undone: number
  /** The stored log, from which the turns were counted: what `/undo` and `/redo` then name. */
  readonly events: readonly TurnEvent[]
  /** The agent the session runs as; `null` (or absent): none. */
  readonly agent?: string | null
  /** The model's task list as it stands; `null` (or absent): it has none. */
  readonly tasks?: readonly TaskItem[] | null
}

/** How long the CLI waits for `Session.close` before it exits anyway. */
export const CLOSE_TIMEOUT_MS = 3000

/**
 * The terminal state of a turn, read from its `execution.*` event.
 * `unresolved` is an execution that ended as done although the project's
 * checks still fail (`execution.succeeded` whose `verification.status` is
 * `unresolved`): the model said it cannot fix them, ran out of rounds, or the
 * checks only report. It is not a success a script should build on.
 */
export type TurnOutcome = "succeeded" | "unresolved" | "failed" | "interrupted"

/** The exit code of a turn that ended with failing checks left unresolved. Distinct from done (0) and failed (1). */
export const EXIT_UNRESOLVED = 3

/**
 * The exit code of a run that was ended because a tool call needed approval
 * and nobody was there to give it (`--unattended stop`). Distinct from a
 * failure (1): nothing went wrong, the run was not allowed to go on.
 */
export const EXIT_APPROVAL_REQUIRED = 4

/** Whether an event ends a turn because a call needed approval that nobody could give. */
export function endedForApproval(event: EngineEvent): boolean {
  return event.type === "execution.failed" && event.data.cause === "approval"
}

/** The process exit code for a turn's outcome. */
export function exitCodeOf(outcome: TurnOutcome): number {
  switch (outcome) {
    case "succeeded":
      return 0
    case "unresolved":
      return EXIT_UNRESOLVED
    case "failed":
      return 1
    case "interrupted":
      return 130
  }
}

/** The outcome an event ends a turn with, or `null` when it does not end one. */
export function turnOutcomeOf(event: EngineEvent): TurnOutcome | null {
  switch (event.type) {
    case "execution.succeeded":
      return event.data.verification.status === "unresolved" ? "unresolved" : "succeeded"
    case "execution.failed":
      return "failed"
    case "execution.interrupted":
      return "interrupted"
    default:
      return null
  }
}

/**
 * Raised by `open` (and the one-off commands) when the engine cannot do what
 * was asked in this environment (no sign-in, no store, a session in use).
 * `usage`: what was asked for is wrong (an unknown model, an ambiguous
 * session ID), which exits with the usage code.
 */
export class EngineUnavailable extends Error {
  constructor(
    message: string,
    readonly kind: "usage" | "auth" | null = null,
  ) {
    super(message)
    this.name = "EngineUnavailable"
  }
}

/** The exit code for a refusal: 2 when the arguments were wrong, 1 otherwise. */
export function exitCodeOfRefusal(error: EngineUnavailable): number {
  return error.kind === "usage" ? 2 : 1
}
