/**
 * What the TUI needs from the engine, whichever way it is reached: the
 * harness's own ACP server in a child process (`acp-client.ts`), or the
 * CLI's scripted demo engine (`demo-backend.ts`). Optional members are
 * features a backend may lack; the TUI says so instead of offering them.
 */
import type { ApprovalAnswer, ApprovalAsk } from "@windlass/acp/client"
import type { AgentsResult, ClientCommand, CommandsResult, CompactResult } from "@windlass/acp/extensions"
import type { DiffResult, HooksStateResult, LspStateResult, McpStateResult, MemoryChangeParams, MemoryChangeResult, MemoryStateResult, SkillsResult, TurnNotification, WakeListResult, WakeSecretResult } from "@windlass/acp/extensions"
import type { RevertResult } from "@windlass/core"
import type { EngineEvent } from "./cli.ts"

export type { AgentsResult, ApprovalAnswer, ApprovalAsk, CompactResult, DiffResult, HooksStateResult, LspStateResult, McpStateResult, MemoryStateResult, SkillsResult, TurnNotification, WakeListResult, WakeSecretResult }

export type Delivery = "steer" | "queue"

/** A fork that was made: where it works, and from what. */
export interface ForkInfo {
  readonly sessionId: string
  readonly cwd: string
  /** The directory the copy was made from; `null` when the fork shares the original's. */
  readonly copiedFrom: string | null
  readonly title: string | null
}

export type OpenTarget = { readonly kind: "new" } | { readonly kind: "resume"; readonly id: string } | { readonly kind: "continue" }

export interface OpenSettings {
  readonly model: string | null
  readonly effort: string | null
  readonly maxSteps: number | null
  /** The agent a new session starts as, and a resumed one is switched to (`none`: no agent); `null` or absent: the default, or its own. */
  readonly agent?: string | null
}

export interface ModelChoice {
  readonly id: string
  readonly name: string
  readonly efforts: readonly string[]
  readonly defaultEffort: string | null
  readonly contextWindow: number | null
  readonly isDefault: boolean
}

export interface SessionChoice {
  readonly id: string
  readonly title: string | null
  readonly cwd: string
  readonly updatedAt: number
  readonly model: string
  readonly effort: string | null
  readonly archived: boolean
  /** A fork: the session it was forked from. */
  readonly forkedFrom?: string | null
}

/** A question the agent asks besides tool approvals (the hand-edit question of an undo), and its choices. */
export interface Question {
  readonly title: string
  readonly detail: readonly string[]
  readonly options: readonly { readonly id: string; readonly label: string; readonly kind: "allow" | "reject" | "other" }[]
}

export type QuestionHandler = (question: Question) => Promise<string | null>

/** Answers a tool call's approval question, or `null` to cancel it. `signal` aborts when the question is withdrawn (the turn was stopped). */
export type ApprovalHandler = (ask: ApprovalAsk, signal: AbortSignal) => Promise<ApprovalAnswer | null>

/** One item of a session's stream: a harness event, or how a turn ended (`<prefix>/turn`, which carries the files it changed). */
export type StreamItem =
  | {
      readonly event: EngineEvent
      /** Part of the stored history a `session/load` replays. */
      readonly replay: boolean
    }
  | { readonly turn: TurnNotification; readonly replay: boolean }

/** How the session's tool calls are approved (`<prefix>/approval`). */
export interface ApprovalInfo {
  /** `false`: the server runs without the approval layer. */
  readonly enabled: boolean
  readonly mode: string | null
  readonly tainted: boolean
  /** Where the untrusted content came from, in a sentence; `null` when not tainted. */
  readonly taint: string | null
  readonly sandboxUnavailable: { readonly reason: string; readonly remedy: string | null } | null
}

/** A choice of a select config option (the approval modes, with what each does). */
export interface ConfigChoice {
  readonly value: string
  readonly name: string
  readonly description: string | null
}

export interface RevertOptions {
  readonly dryRun?: boolean
  readonly handEdits?: "ask" | "abort" | "overwrite" | "keep"
}

export interface BackendSession {
  readonly id: string
  readonly cwd: string
  /** Every event of the session from the moment it was opened. Ends when the session is closed or the server is gone. */
  readonly events: AsyncIterable<StreamItem>
  /** Admits a message; resolves with its message ID once admitted, `null` when it was not. */
  send(text: string, delivery: Delivery): Promise<string | null>
  /** The user's and the project's command files as they are now, with the ones that cannot be used; `builtins`: the interface's own commands, which hide a file of the same name. */
  commands?(builtins: readonly ClientCommand[]): Promise<CommandsResult>
  /**
   * `send` for `/name args` of a command file: its text, with `args` put in, is admitted as the user's message
   * and the log records the file. Rejects, with the sentence to show, when nothing was sent.
   */
  sendCommand?(name: string, args: string, delivery: Delivery): Promise<string | null>
  /** Stops the running turn (reason `user`). */
  interrupt(): void
  revert?(options: RevertOptions): Promise<RevertResult>
  undoRevert?(options: RevertOptions): Promise<RevertResult>
  /** Switches the model, the effort or the agent from the next step boundary, or the approval mode from the next tool call. */
  setConfig?(id: "model" | "effort" | "approval" | "agent", value: string): Promise<void>
  /** The agents the session can run as, the one in force, and the definitions that could not be used. */
  agents?(): Promise<AgentsResult>
  /** The choices of a select config option and its current value, as the server last reported them. */
  configChoices?(id: string): { readonly current: string | null; readonly choices: readonly ConfigChoice[] } | null
  /** How tool calls are approved here. */
  approval?(): Promise<ApprovalInfo>
  /** The user trusts what is in the conversation again. Resolves with whether it was tainted. */
  clearTaint?(): Promise<boolean>
  /** The files a turn (`executionId`, the latest by default) or a step (`messageId`) changed, with per-file patches. */
  diff?(params: { readonly executionId?: string; readonly messageId?: string }): Promise<DiffResult>
  /** The session's title as the server has it (its own, or derived from the first message). */
  title?(): Promise<string | null>
  /** Renames the session, when the server offers it; resolves with the title as stored. */
  rename?(title: string): Promise<string>
  /** Compacts the conversation now, when the server offers it; resolves when it is done with what came of it. */
  compact?(): Promise<CompactResult>
  /** Another session's stored log (a subagent's, to show its work), also of one this client did not open. */
  storedEvents?(sessionId: string): Promise<readonly EngineEvent[]>
  /** A new session with this one's conversation so far (`copy`: in a copy of the workspace). Nothing is opened. */
  /** `throughSeq`: after that event (a turn's end) instead of after the latest step. */
  fork?(options: { readonly copy: boolean; readonly throughSeq?: number }): Promise<ForkInfo>
  /** The session's MCP servers, and the user's approval of one the project names. */
  mcp?(): Promise<McpStateResult>
  approveMcp?(name: string, fingerprint: string): Promise<boolean>
  /** Called when the servers change (started, failed, waiting for approval). Returns the unsubscribe function. */
  onMcp?(listener: (state: McpStateResult) => void): () => void
  /** The session's hooks, the user's approval of one the project names, and a listener for when they change. */
  hooks?(): Promise<HooksStateResult>
  approveHook?(fingerprint: string): Promise<boolean>
  onHooks?(listener: (state: HooksStateResult) => void): () => void
  /** The session's language servers, the user's approval of one the project names, and a listener for when they change. */
  lsp?(): Promise<LspStateResult>
  approveLsp?(name: string, fingerprint: string): Promise<boolean>
  onLsp?(listener: (state: LspStateResult) => void): () => void
  skills?(): Promise<SkillsResult>
  wakeups?(): Promise<WakeListResult>
  cancelWake?(id: string): Promise<{ readonly cancelled: boolean; readonly message: string }>
  /** A webhook wake-up's URL and secret: for the user's eyes only. */
  wakeSecret?(id: string): Promise<WakeSecretResult>
  memory?(): Promise<MemoryStateResult>
  memoryChange?(params: Omit<MemoryChangeParams, "sessionId">): Promise<MemoryChangeResult>
  /** Lets go of the session; with `shutdown`, running work stops as a shutdown and resumes at the next open. */
  close(shutdown: boolean): Promise<void>
  /** Why the events ended without `close` (the server went away), as a sentence; `null` while all is well. */
  lost(): string | null
}

export interface Backend {
  /** Shown in the panel: how the engine is reached. */
  readonly label: string
  open(target: OpenTarget, cwd: string, settings: OpenSettings): Promise<BackendSession>
  listSessions?(cwd: string): Promise<SessionChoice[]>
  listModels?(): Promise<{ readonly defaultModel: string; readonly models: readonly ModelChoice[] }>
  /** Who answers the agent's questions. Set by the app before the first open. */
  onQuestion: QuestionHandler
  /** Who answers tool calls' approval questions. Set by the app before the first open. */
  onApproval: ApprovalHandler
  /** Lines the server logged (its warnings and errors), never written to the terminal directly. */
  onLog: (line: string, level: "warn" | "error" | "info") => void
  /** Can the connection be made again after the server went away. */
  readonly restartable: boolean
  /** Starts a fresh server after the old one died. */
  restart?(): Promise<void>
  stop(): Promise<void>
}

/** A failure the user can act on, as one sentence (not signed in, a session in use, the server gone). */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message)
    this.name = "BackendError"
  }
}
