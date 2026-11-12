/**
 * What the TUI needs from the engine, whichever way it is reached: the
 * harness's own ACP server in a child process (`acp-client.ts`), or the
 * CLI's scripted demo engine (`demo-backend.ts`). Optional members are
 * features a backend may lack; the TUI says so instead of offering them.
 */
import type { RevertResult } from "@light-harness/core"
import type { EngineEvent } from "./cli.ts"

export type Delivery = "steer" | "queue"

export type OpenTarget = { readonly kind: "new" } | { readonly kind: "resume"; readonly id: string } | { readonly kind: "continue" }

export interface OpenSettings {
  readonly model: string | null
  readonly effort: string | null
  readonly maxSteps: number | null
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
}

/** A question the agent asks (today the hand-edit question of an undo; tool approvals later), and its choices. */
export interface Question {
  readonly title: string
  readonly detail: readonly string[]
  readonly options: readonly { readonly id: string; readonly label: string; readonly kind: "allow" | "reject" | "other" }[]
}

export type QuestionHandler = (question: Question) => Promise<string | null>

export interface StreamItem {
  readonly event: EngineEvent
  /** Part of the stored history a `session/load` replays. */
  readonly replay: boolean
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
  /** Stops the running turn (reason `user`). */
  interrupt(): void
  revert?(options: RevertOptions): Promise<RevertResult>
  undoRevert?(options: RevertOptions): Promise<RevertResult>
  /** Switches the model or the effort from the next step boundary. */
  setConfig?(id: "model" | "effort", value: string): Promise<void>
  /** Compacts the conversation now, when the server offers it. */
  compact?(): Promise<void>
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
