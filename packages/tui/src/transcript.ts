/**
 * The TUI's view model: a session's event stream folded into rows (what the
 * conversation shows), the activity of the turn in progress (what the status
 * line says), the inbox items not delivered yet, the session's settings, and
 * the usage of every model call (what the side panel shows).
 *
 * Pure and synchronous: `apply` takes one event at a time, in arrival order,
 * live or replayed, and never touches a terminal. The wording follows the
 * line-based CLI's renderer, so both clients say the same things.
 */
import { type DiffResult, type TurnNotification, deriveTitle } from "@windlass/acp/extensions"
import { type TurnInfo, TurnTracker } from "@windlass/acp/turns"
import { type EventData, type Json, type ProviderError, type StepError, type Usage, type VerificationOutcome, describeNeed } from "@windlass/core"
import { type EngineEvent, callArgument, wakeMessageSummary, checkLines, checksSummary, fileList, unresolvedReason } from "./cli.ts"
import { plural, sanitize, thousands } from "./layout.ts"
import { type Role, type Span, span } from "./theme.ts"

export type ToolPhase = "writing" | "called" | "running" | "settled"

interface RowBase {
  readonly id: number
  /** Bumped on every change, so a laid-out row is reused until it changes. */
  version: number
  /** From a `session/load` replay rather than live. */
  readonly replay: boolean
  /**
   * The event number the row belongs to: the latest stored event when it was
   * added (a user's message: its delivery). `-1` for the TUI's own lines,
   * which `/undo` never takes back.
   */
  seq: number
  /** The reverts (`history.reverted` seqs) that took this row's turn out of the conversation and were not undone since. */
  readonly undoneBy: Set<number>
}

export interface UserRow extends RowBase {
  readonly kind: "user"
  readonly text: string
  /** The turn this message started, numbered as the user counts turns; `null` for a steer or a queued follow-up's own row. */
  turn: number | null
  /** How a message sent while the agent worked reached it; `null` for the prompt that started a turn. */
  readonly delivered: "steer" | "queue" | null
}

export interface TextRow extends RowBase {
  readonly kind: "text"
  readonly messageId: string
  text: string
  streaming: boolean
  /** Picks up a response a provider error cut short. */
  readonly continuation: boolean
}

export interface ReasoningRow extends RowBase {
  readonly kind: "reasoning"
  readonly messageId: string
  text: string
  streaming: boolean
  expanded: boolean
}

export interface ToolRow extends RowBase {
  readonly kind: "tool"
  readonly key: string
  readonly messageId: string
  name: string
  input: string
  arg: string
  phase: ToolPhase
  outcome: "success" | "error" | "not_started" | "effect_unknown" | null
  output: string
  display: Json | null
  truncation: EventData<"tool.settled">["truncation"]
  progress: string | null
  /** Event times, for the duration on the row. */
  startedAt: number | null
  settledAt: number | null
  /** Local clock when it started running, for the live duration. */
  runningSince: number | null
  /** 0 collapsed, 1 expanded, 2 expanded without the output cap. */
  expand: 0 | 1 | 2
  /**
   * How a command ran (`tool.started`'s `run`): in the sandbox with what
   * extra access, `null` without the sandbox, `undefined` when not recorded
   * (no approval layer, or not started).
   */
  sandbox: { readonly network: boolean; readonly writableRoots: readonly string[] } | null | undefined
  /** The call's approval: asked (and how it was answered), or refused without a question. */
  approval: ToolApproval | null
  /** A `subagent` call's subagent, once it started: its activity, from the events its parent forwards. */
  subagent: SubagentView | null
}

/** A subagent as its parent's tool row shows it. */
export interface SubagentView {
  readonly sessionId: string
  readonly spawnId: string
  readonly background: boolean
  /** The first line of its task. */
  title: string | null
  /** Its own conversation: its steps, tool rows and answer, folded from its forwarded events like any session's. */
  readonly transcript: Transcript
  state: "running" | "completed" | "failed" | "stopped" | "lost"
  /** Why it ended, when it did not simply finish. */
  detail: string | null
  /** A question of its own waits for the user. */
  asking: boolean
  /** Its steps (model calls) that ended, whatever they reported. */
  steps: number
}

export type ToolApproval =
  /** Asked; `live` while the question waits for this user. */
  | { readonly state: "asked"; readonly title: string; readonly live: boolean }
  | { readonly state: "allowed"; readonly title: string; readonly choice: string; readonly note: string | null }
  | { readonly state: "declined"; readonly title: string; readonly note: string | null }
  /** Refused without a question: by the policy, or because nobody was present (`stop`: the run ended with it). */
  | { readonly state: "denied"; readonly reason: "policy" | "unattended"; readonly needs: readonly string[]; readonly stop: boolean }

export interface NoticeRow extends RowBase {
  readonly kind: "notice"
  symbol: string
  tone: Role
  text: Span[]
  detail: Span[][]
  /** A notice that is part of the agent's work (a retry, a check) rather than about the session. */
  readonly group: "work" | "session"
}

export interface OutcomeRow extends RowBase {
  readonly kind: "outcome"
  readonly outcome: "succeeded" | "unresolved" | "failed" | "interrupted" | "shutdown"
  readonly verification: VerificationOutcome | null
  readonly steps: number
  readonly durationMs: number | null
  readonly usage: Usage | null
  readonly message: string | null
  readonly errorKind: string | null
  readonly requestId: string | null
  /** The execution this ended, for its per-file diffs. */
  readonly executionId: string | null
  /** `null`: the server did not say (a replayed turn, or no snapshot could tell). */
  changedFiles: readonly string[] | null
  /** The per-file diffs the server sent for this turn, once asked for (`/diff`, or expanding the row). */
  serverDiff: DiffResult | "loading" | null
  /** The diffs of the edits this turn made, per path, as the tools reported them. */
  readonly diffs: ReadonlyMap<string, readonly string[]>
  /** Paths written whole (no diff from the tool). */
  readonly written: ReadonlySet<string>
  /** Messages still waiting after an interrupt. */
  readonly waiting: number
  expanded: boolean
  /** The turn this ended, numbered as the user counts turns (what `/fork <turn>` takes). */
  readonly turn: number | null
}

export interface DebugRow extends RowBase {
  readonly kind: "debug"
  readonly text: string
}

export type Row = UserRow | TextRow | ReasoningRow | ToolRow | NoticeRow | OutcomeRow | DebugRow

/** A message admitted while the agent works and not delivered yet. */
export interface PendingItem {
  readonly messageId: string
  readonly text: string
  delivery: "steer" | "queue"
}

/** One model call and the tokens it reported. */
export interface CallUsage {
  readonly n: number
  readonly messageId: string
  readonly model: string | null
  readonly kind: "step" | "compaction"
  readonly usage: Usage
  /** Diagnostics the server reported about this call (a broken prompt-cache prefix). */
  readonly diagnostics: readonly string[]
  readonly ended: "ok" | "failed" | "refused"
}

/** What the agent is doing right now. Times are the local clock, for live durations. */
export interface Activity {
  executing: boolean
  turnStartedAt: number | null
  steps: number
  call: { readonly messageId: string; readonly since: number; readonly model: string; readonly attempt: number } | null
  checking: { readonly names: readonly string[]; readonly since: number; progress: string | null } | null
  compacting: { readonly since: number; repairing: boolean } | null
  retry: { readonly until: number; readonly attempt: number } | null
  stopping: boolean
  /** A tool call's approval question waits for the user (live only): the call, and since when. */
  waiting: { readonly key: string; readonly since: number } | null
}

export interface SessionInfo {
  id: string | null
  cwd: string | null
  title: string | null
  model: string | null
  effort: string | null
  /** Untrusted content is in the conversation: where it came from, in a sentence. */
  taint: string | null
  /** A fork: the session it was forked from. */
  forkedFrom?: string | null
  /** A fork: how many of `calls` it inherited from its parent (the model calls before the fork point). */
  inheritedCalls?: number
}

interface Turn {
  readonly start: number
  steps: number
  usage: Usage | null
  lastError: string | null
  requestId: string | null
  changedFiles: readonly string[] | null
  readonly diffs: Map<string, string[]>
  readonly written: Set<string>
}

const SYMBOL = {
  ok: "✓",
  fail: "✗",
  unknown: "⚠",
  retry: "↻",
  inbox: "↳",
  stop: "■",
  settings: "⇄",
  refused: "⊘",
  compact: "⇣",
  note: "·",
  undo: "↶",
  redo: "↷",
  check: "⋯",
} as const

/** Known event types this model does not show; anything else is new to this client (a debug row). */
const SILENT = new Set(["tool.input.delta", "snapshot.taken", "revert.started", "revert.undo_started", "session.archived", "session.unarchived", "inbox.delivery_changed"])

export class Transcript {
  readonly rows: Row[] = []
  readonly pending: PendingItem[] = []
  readonly calls: CallUsage[] = []
  readonly session: SessionInfo = { id: null, cwd: null, title: null, model: null, effort: null, taint: null, forkedFrom: null, inheritedCalls: 0 }
  readonly activity: Activity = blankActivity()
  /** Bumped on every change. */
  version = 0
  /** Types of events this client did not recognise, with how often they came. */
  readonly unknown = new Map<string, number>()

  private nextId = 1
  private readonly openText = new Map<string, TextRow>()
  private readonly openReasoning = new Map<string, ReasoningRow>()
  private readonly tools = new Map<string, ToolRow>()
  /** The rows of the `subagent` calls whose subagent started, by the subagent's session. */
  private readonly children = new Map<string, ToolRow>()
  /** Background commands still running, by spawn ID: what they run and where their output is (this machine's path). */
  readonly background = new Map<string, { readonly command: string; readonly logPath: string | null; readonly since: number }>()
  private readonly checks = new Map<number, { row: NoticeRow; startedAt: number }>()
  private readonly compactions = new Map<string, { row: NoticeRow; tokensBefore: number; model: string | null }>()
  private readonly inboxText = new Map<string, { text: string; delivery: "steer" | "queue"; midTurn: boolean }>()
  private readonly resumes = new Map<string, number>()
  private readonly stepModels = new Map<string, string>()
  private readonly callDiagnostics = new Map<string, string[]>()
  /** Diagnostics reported between calls: they are about the request of the call that starts next. */
  private diagnosticsForNext: string[] = []
  private turn: Turn | null = null
  private cutOff: "crash" | "shutdown" | null = null
  private continuing = false
  private sentBack = 0
  private stopAsked = false
  /** The stop line that tells how to exit at once; the hint goes once the turn has ended. */
  private stopRow: NoticeRow | null = null
  /** The session's turns as the user counts them, for `/undo`, `/redo` and `/fork <turn>`. */
  turns = new TurnTracker()
  /** The latest stored event applied: what a row added now belongs to. */
  private lastSeq = 0
  /** The rows of user messages not delivered yet, by message: their delivery is where `/undo` cuts. */
  private readonly userRows = new Map<string, UserRow>()
  private instructionFiles = ""

  constructor(private readonly now: () => number = Date.now) {}

  /** The user asked to stop: the stop line says how to leave without waiting. */
  markStopAsked(): void {
    this.stopAsked = true
  }

  /** A line from the TUI itself (a command's answer, an error), in the conversation. */
  note(text: string | Span[], tone: Role = "dim", symbol: string = SYMBOL.note, detail: Span[][] = []): NoticeRow {
    const row = this.add<NoticeRow>({ kind: "notice", symbol, tone, text: typeof text === "string" ? [span(text, tone === "dim" ? "dim" : undefined)] : text, detail, group: "session" }, false)
    row.seq = -1
    return row
  }

  /** Forgets everything: another session is about to be shown. */
  reset(): void {
    this.rows.length = 0
    this.pending.length = 0
    this.calls.length = 0
    Object.assign(this.session, { id: null, cwd: null, title: null, model: null, effort: null, taint: null, forkedFrom: null, inheritedCalls: 0 })
    Object.assign(this.activity, blankActivity())
    for (const map of [this.background, this.openText, this.openReasoning, this.tools, this.children, this.checks, this.compactions, this.inboxText, this.resumes, this.stepModels, this.callDiagnostics]) map.clear()
    this.diagnosticsForNext = []
    this.turn = null
    this.cutOff = null
    this.continuing = false
    this.sentBack = 0
    this.stopAsked = false
    this.instructionFiles = ""
    this.turns = new TurnTracker()
    this.lastSeq = 0
    this.userRows.clear()
    this.version += 1
  }

  /** The expandable row the user acts on with no other selection: the latest one. */
  latestExpandable(): Row | null {
    return this.rows.findLast((row) => expandable(row)) ?? null
  }

  apply(event: EngineEvent, replay = false): void {
    this.version += 1
    let redone: readonly TurnInfo[] = []
    if ("seq" in event && event.seq > this.lastSeq) {
      this.lastSeq = event.seq
      // Read before the tracker forgets that they were undone.
      if (event.type === "history.restored") redone = this.turns.turns.filter((turn) => turn.undoneBy.has(event.data.revertSeq))
      this.turns.add(event)
    }
    this.redone = redone
    this.handle(event, replay)
  }

  /** The turns the `history.restored` being applied brings back. */
  private redone: readonly TurnInfo[] = []

  /** How a turn ended, as the server says after its events (`<prefix>/turn`): the files it changed, also for a replayed turn. */
  applyTurn(turn: TurnNotification): void {
    const row = this.rows.findLast((candidate): candidate is OutcomeRow => candidate.kind === "outcome" && candidate.executionId === turn.executionId)
    if (row === undefined || row.changedFiles !== null || turn.changedFiles === null) return
    this.touch(row, () => (row.changedFiles = turn.changedFiles))
  }

  /** The tool row of a call, if shown. */
  toolRowOf(messageId: string, callId: string): ToolRow | null {
    return this.tools.get(key(messageId, callId)) ?? null
  }

  /** The row of the call a question is about: one of this session's, or one in a subagent's own transcript. */
  toolRowFor(ask: { readonly messageId: string; readonly callId: string; readonly subagentSessionId?: string | null }): ToolRow | null {
    if (ask.subagentSessionId == null) return this.toolRowOf(ask.messageId, ask.callId)
    return this.children.get(ask.subagentSessionId)?.subagent?.transcript.toolRowOf(ask.messageId, ask.callId) ?? null
  }

  /** The `subagent` row of a subagent's session, if it started here. */
  subagentRow(sessionId: string): ToolRow | null {
    return this.children.get(sessionId) ?? null
  }

  /**
   * A subagent's stored log, read for a row that knows nothing of it (a
   * session opened again: what the parent forwarded live is not stored).
   * Shown as history. Returns whether there was such a row to fill.
   */
  loadSubagent(sessionId: string, events: readonly EngineEvent[]): boolean {
    const row = this.children.get(sessionId)
    const view = row?.subagent ?? null
    if (row === undefined || view === null || view.transcript.rows.length > 0) return false
    this.touch(row, () => {
      for (const item of events) {
        view.transcript.apply(item, true)
        if (item.type === "step.ended" || item.type === "step.failed" || item.type === "step.refused") view.steps += 1
      }
    })
    return true
  }

  /** The subagents still at work, oldest first: in the foreground or the background. */
  runningSubagents(): SubagentView[] {
    return [...this.children.values()].flatMap((row) => (row.subagent !== null && row.subagent.state === "running" ? [row.subagent] : []))
  }

  private handle(event: EngineEvent, replay: boolean): void {
    switch (event.type) {
      case "text.delta":
        return this.textDelta(event.messageId, event.text, replay)
      case "reasoning.delta":
        return this.reasoningDelta(event.messageId, event.text, replay)
      case "tool.input.delta":
        return this.inputDelta(event.messageId, event.callId, event.name, event.input, replay)
      case "tool.progress": {
        const row = this.tools.get(key(event.messageId, event.callId))
        if (row !== undefined) this.touch(row, () => (row.progress = sanitize(event.text)))
        return
      }
      case "checks.progress": {
        const checking = this.activity.checking
        if (checking !== null) checking.progress = sanitize(event.text)
        return
      }
      case "workspace.changes":
        if (this.turn !== null) this.turn.changedFiles = event.files
        return
      case "diagnostic": {
        const what = event.kind === "prefix_violation" ? "prompt cache" : event.kind.replace(/_/g, " ")
        this.notice(SYMBOL.unknown, "warn", [span(`${what}: `, "warn"), span(sanitize(event.message))], [], replay, "work")
        const call = this.activity.call
        if (event.kind !== "prefix_violation" && call !== null) this.callDiagnostics.set(call.messageId, [...(this.callDiagnostics.get(call.messageId) ?? []), event.kind])
        else this.diagnosticsForNext.push(event.kind)
        return
      }
      case "spawn.started": {
        const work = event.data.work
        if (work.kind === "command") {
          // Only work started while this client watches runs here: one in the stored history (a parent's, for a fork, or
          // an earlier process's) ended with that process, and the log says so when the session is opened there.
          if (!replay) this.background.set(event.data.spawnId, { command: work.command, logPath: work.logPath, since: "time" in event ? event.time : this.now() })
          // Where its output is, as this machine names the file: the call's own output gives the sandbox's name for it.
          this.notice("◌", "dim", [span(`background ${event.data.spawnId} · `, "dim"), span(oneLine(work.command))], work.logPath === null ? [] : [[span("output: ", "dim"), span(work.logPath)]], replay, "work")
          return
        }
        if (work.kind !== "subagent") return
        const row = this.tools.get(key(event.data.messageId, event.data.callId)) ?? this.toolRow(event.data.messageId, event.data.callId, "subagent", "", replay)
        const view: SubagentView = { sessionId: work.sessionId, spawnId: event.data.spawnId, background: event.data.background, title: null, transcript: new Transcript(this.now), state: "running", detail: null, asking: false, steps: 0 }
        this.touch(row, () => (row.subagent = view))
        this.children.set(work.sessionId, row)
        return
      }
      case "spawn.ended": {
        const command = this.background.get(event.data.spawnId)
        if (command !== undefined) {
          this.background.delete(event.data.spawnId)
          const outcome = event.data.outcome
          const how = outcome === "completed" ? `exited with code ${event.data.exitCode}` : outcome === "stopped" ? (/shut down|shutdown/.test(event.data.detail) ? "stopped: the session closed" : "stopped") : outcome
          const ok = outcome === "completed" && event.data.exitCode === 0
          this.notice(ok ? "✓" : "■", ok ? "ok" : "warn", [span(`background ${event.data.spawnId} ${how}`, ok ? undefined : "warn")], [], replay, "work")
          return
        }
        const row = [...this.children.values()].find((candidate) => candidate.subagent?.spawnId === event.data.spawnId)
        if (row === undefined || row.subagent === null) return
        const view = row.subagent
        this.touch(row, () => {
          view.state = event.data.outcome
          view.detail = event.data.outcome === "completed" ? null : sanitize(event.data.detail)
          view.asking = false
        })
        if (this.activity.waiting?.key === row.key) this.activity.waiting = null
        return
      }
      case "child.event": {
        const row = this.children.get(event.child)
        if (row === undefined || row.subagent === null) return
        const view = row.subagent
        const inner = event.event
        this.touch(row, () => {
          view.title ??= sanitize(event.title)
          view.transcript.apply(inner, replay)
          if (inner.type === "step.ended" || inner.type === "step.failed" || inner.type === "step.refused") view.steps += 1
          if (inner.type === "approval.requested") view.asking = !replay
          if (inner.type === "approval.answered" || inner.type === "approval.denied" || inner.type === "execution.interrupt_requested") view.asking = false
        })
        // The subagent's question waits for this user: the status line says so, as for one of the session's own.
        if (inner.type === "approval.requested" && !replay) this.activity.waiting = { key: row.key, since: this.now() }
        if ((inner.type === "approval.answered" || inner.type === "approval.denied" || inner.type === "execution.interrupt_requested") && this.activity.waiting?.key === row.key) this.activity.waiting = null
        return
      }
      case "session.created":
        this.session.id = event.sessionId
        this.session.cwd = event.data.cwd
        this.session.title = event.data.title
        this.session.model = event.data.settings.model
        this.session.effort = event.data.settings.reasoningEffort
        // A fork's log starts with its parent's: the model calls before this point were the parent's.
        this.session.forkedFrom = event.data.lineage?.kind === "fork" ? event.data.lineage.parentSessionId : null
        this.session.inheritedCalls = event.data.lineage?.kind === "fork" ? this.calls.length : 0
        return
      case "session.renamed":
        this.session.title = event.data.title
        return
      case "settings.changed": {
        const previous = { model: this.session.model, effort: this.session.effort }
        this.session.model = event.data.model
        this.session.effort = event.data.reasoningEffort
        const changes: string[] = []
        if (previous.model !== event.data.model) changes.push(previous.model === null ? `model ${event.data.model}` : `model ${previous.model} → ${event.data.model}`)
        if (previous.effort !== event.data.reasoningEffort) changes.push(`effort ${previous.effort ?? "default"} → ${event.data.reasoningEffort ?? "default"}`)
        if (changes.length > 0) this.notice(SYMBOL.settings, "accent", [span(changes.join(" · ")), span(" · from the next step", "dim")], [], replay, "session")
        return
      }
      case "text.ended":
        return this.textEnded(event.data.messageId, event.data.text, replay)
      case "reasoning.ended":
        return this.reasoningEnded(event.data.messageId, event.data.text, replay)
      case "tool.called":
        return this.toolCalled(event.data, replay)
      case "tool.started": {
        const row = this.tools.get(key(event.data.messageId, event.data.callId)) ?? this.toolRow(event.data.messageId, event.data.callId, "tool", "", replay)
        const run = event.data.run
        this.touch(row, () => {
          row.phase = "running"
          row.startedAt = event.time
          row.runningSince = this.now()
          if (run !== undefined) row.sandbox = run.sandbox
        })
        return
      }
      case "tool.settled": {
        const data = event.data
        const row = this.tools.get(key(data.messageId, data.callId)) ?? this.toolRow(data.messageId, data.callId, "tool", "", replay)
        this.touch(row, () => {
          row.phase = "settled"
          row.outcome = data.outcome
          row.output = sanitize(data.output)
          row.display = data.display
          row.truncation = data.truncation
          row.settledAt = event.time
          row.progress = null
          if (row.approval?.state === "asked") row.approval = { ...row.approval, live: false }
        })
        if (this.activity.waiting?.key === row.key) this.activity.waiting = null
        this.recordChange(row)
        return
      }
      case "approval.requested": {
        const data = event.data
        const row = this.tools.get(key(data.messageId, data.callId)) ?? this.toolRow(data.messageId, data.callId, "tool", "", replay)
        // A replayed question is history: it was answered (or settled by recovery) long ago and is never put again.
        this.touch(row, () => (row.approval = { state: "asked", title: sanitize(data.question.title), live: !replay }))
        if (!replay) this.activity.waiting = { key: row.key, since: this.now() }
        return
      }
      case "approval.answered": {
        const data = event.data
        const row = this.tools.get(key(data.messageId, data.callId))
        if (this.activity.waiting?.key === key(data.messageId, data.callId)) this.activity.waiting = null
        if (row === undefined) return
        const title = row.approval?.state === "asked" ? row.approval.title : ""
        const note = data.note === null ? null : sanitize(data.note)
        this.touch(row, () => (row.approval = data.approve ? { state: "allowed", title, choice: data.choice, note } : { state: "declined", title, note }))
        return
      }
      case "approval.denied": {
        const data = event.data
        const row = this.tools.get(key(data.messageId, data.callId)) ?? this.toolRow(data.messageId, data.callId, "tool", "", replay)
        this.touch(row, () => (row.approval = { state: "denied", reason: data.reason, needs: data.needs.map(describeNeed), stop: data.stop }))
        return
      }
      case "taint.noticed":
        this.session.taint = sanitize(event.data.text)
        this.notice(
          SYMBOL.unknown,
          "warn",
          [span("untrusted content is in the conversation: ", "warn", { bold: true }), span(sanitize(event.data.text), "warn")],
          [
            [span("From here on, anything that can send data out (network access for a command, a command outside the sandbox) asks again, and earlier approvals for it no longer apply.", "dim")],
            [span("/clear-taint", "accent"), span(" when you trust what is there", "dim")],
          ],
          replay,
          "session",
        )
        return
      case "taint.cleared":
        this.session.taint = null
        this.notice(SYMBOL.note, "dim", [span("the conversation is trusted again (/clear-taint): approvals apply as before", "dim")], [], replay, "session")
        return
      case "notice": {
        const what = event.kind === "sandbox_unavailable" ? "no sandbox" : event.kind === "approval_ignored" ? "a project setting was not followed" : event.kind === "checks_not_run" ? "checks not run" : String(event.kind).replace(/_/g, " ")
        const [first = "", ...rest] = sanitize(event.message)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
        this.notice(SYMBOL.unknown, "warn", [span(`${what}: `, "warn", { bold: true }), span(first, "warn")], rest.map((line) => [span(line, "dim")]), replay, "session")
        return
      }
      case "step.started":
        this.activity.call = { messageId: event.data.messageId, since: this.now(), model: event.data.model, attempt: event.data.attempt }
        this.activity.retry = null
        this.activity.steps += 1
        this.stepModels.set(event.data.messageId, event.data.model)
        if (this.diagnosticsForNext.length > 0) {
          this.callDiagnostics.set(event.data.messageId, [...(this.callDiagnostics.get(event.data.messageId) ?? []), ...this.diagnosticsForNext])
          this.diagnosticsForNext = []
        }
        if (this.turn !== null) this.turn.steps += 1
        if (this.sentBack > 0) {
          this.notice(SYMBOL.retry, "warn", [span("the agent is shown the failing checks and carries on"), span(this.sentBack > 1 ? ` · round ${this.sentBack}` : "", "dim")], [], replay, "work")
          this.sentBack = -this.sentBack
        }
        return
      case "step.ended":
        return this.closeStep(event.data.messageId, event.data.usage, "ok")
      case "step.failed":
        this.closeStep(event.data.messageId, event.data.usage, "failed")
        return this.stepFailed(event.data.error, replay)
      case "step.refused":
        this.closeStep(event.data.messageId, event.data.usage, "refused")
        this.setError("content_policy")
        this.notice(SYMBOL.refused, "error", [span("refused by the provider: ", "error"), span(sanitize(event.data.message))], [[span("this exchange is left out of what the model sees next", "dim")]], replay, "work")
        return
      case "retry.scheduled": {
        const error = event.data.error
        this.setError(error.kind, error.requestId)
        this.activity.retry = { until: this.now() + event.data.delayMs, attempt: event.data.attempt }
        this.activity.call = null
        this.notice(SYMBOL.retry, "warn", [span(`retrying in ${seconds(event.data.delayMs)} (attempt ${event.data.attempt})`, "warn"), span(` · ${errorLabel(error)}: ${sanitize(error.message)}`, "dim")], [], replay, "work")
        return
      }
      case "compaction.started": {
        this.activity.compacting = { since: this.now(), repairing: false }
        const row = this.notice(SYMBOL.compact, "accent", [span("compacting the conversation…"), span(event.data.trigger === "manual" ? " · asked for" : event.data.trigger === "overflow" ? " · the request was too large" : "", "dim")], [], replay, "work")
        this.compactions.set(event.data.messageId, { row, tokensBefore: event.data.tokensBefore, model: this.session.model })
        return
      }
      case "compaction.repair_requested":
        if (this.activity.compacting !== null) this.activity.compacting.repairing = true
        return
      case "compaction.ended": {
        this.activity.compacting = null
        const open = this.compactions.get(event.data.messageId)
        this.compactions.delete(event.data.messageId)
        if (event.data.usage !== null) this.record(event.data.messageId, event.data.usage, "compaction", "ok", open?.model ?? this.session.model)
        this.addUsage(event.data.usage)
        const before = open?.tokensBefore ?? 0
        const sizes = before > 0 && event.data.tokensAfter > 0 ? ` · about ${thousands(before)} → ${thousands(event.data.tokensAfter)} tokens` : ""
        const fallback = event.data.source === "fallback"
        const text = [span(fallback ? "compacted the conversation without a summary" : "compacted the conversation", fallback ? "warn" : undefined), span(sizes, "dim")]
        const detail = fallback
          ? [[span(`Why: ${event.data.detail ?? "the model produced no usable summary"}.`, "warn")], [span("The model continues from a list of the files, commands and errors so far and your own messages, and can search the full conversation.", "dim")]]
          : [[span("Earlier messages are now a checkpoint; the model can still search them.", "dim")], ...(event.data.detail === null ? [] : [[span(`Note: ${event.data.detail}.`, "dim")]])]
        if (open === undefined) this.notice(SYMBOL.compact, fallback ? "warn" : "accent", text, detail, replay, "work")
        else this.touch(open.row, () => Object.assign(open.row, { tone: fallback ? "warn" : "accent", text, detail }))
        return
      }
      case "compaction.failed": {
        this.activity.compacting = null
        const open = this.compactions.get(event.data.messageId)
        this.compactions.delete(event.data.messageId)
        this.setError(errorClass(event.data.error), event.data.error.kind === "provider" ? event.data.error.error.requestId : null)
        const text = [span(`compaction failed: ${stepErrorText(event.data.error)}`, "error")]
        if (open === undefined) this.notice(SYMBOL.fail, "error", text, [], replay, "work")
        else this.touch(open.row, () => Object.assign(open.row, { symbol: SYMBOL.fail, tone: "error", text }))
        return
      }
      case "synthetic.appended":
        return this.synthetic(event.data.origin, replay)
      case "instruction.appended": {
        const source = sourceLabel(event.data.source)
        if (event.data.fingerprint === null) this.notice(SYMBOL.note, "dim", [span(`instructions removed: ${source}`, "dim")], [], replay, "work")
        else this.notice(SYMBOL.note, "dim", [span(`instructions updated (${source}): `, "dim"), span(oneLine(event.data.text), "dim")], [], replay, "work")
        return
      }
      case "baseline.set": {
        const list = event.data.sources.filter((entry) => entry.source.startsWith("agents:")).map((entry) => sourceLabel(entry.source)).join(", ")
        if (list === this.instructionFiles) return
        this.instructionFiles = list
        if (list !== "") this.notice(SYMBOL.note, "dim", [span(`instructions from ${list}`, "dim")], [], replay, "session")
        return
      }
      case "execution.interrupt_requested": {
        this.activity.stopping = true
        this.activity.retry = null
        const hint = this.stopAsked && !replay ? " · press Ctrl-C again to exit now" : ""
        const row = this.notice(SYMBOL.stop, "warn", [span(event.data.reason === "user" ? "stopping…" : "shutting down…", "warn"), span(hint, "dim")], [], replay, "work")
        if (hint !== "") this.stopRow = row
        return
      }
      case "inbox.enqueued":
        return this.enqueued(event.data, replay)
      case "inbox.delivered": {
        const item = this.inboxText.get(event.data.messageId)
        this.inboxText.delete(event.data.messageId)
        const at = this.pending.findIndex((entry) => entry.messageId === event.data.messageId)
        const pending = at === -1 ? null : this.pending.splice(at, 1)[0]!
        // A prompt's row was added when it was admitted; it belongs where it became part of the conversation.
        const shown = this.userRows.get(event.data.messageId)
        this.userRows.delete(event.data.messageId)
        if (shown !== undefined) {
          shown.seq = event.seq
          shown.turn = this.turns.turns.at(-1)?.number ?? null
        }
        if (item === undefined || !item.midTurn) return
        const turnOfQueued = this.turns.turns.findLast((turn) => turn.messageSeq === event.seq)?.number ?? null
        this.add<UserRow>({ kind: "user", text: item.text, delivered: pending?.delivery ?? item.delivery, turn: turnOfQueued }, replay)
        return
      }
      case "inbox.cancelled": {
        const item = this.inboxText.get(event.data.messageId)
        this.inboxText.delete(event.data.messageId)
        const at = this.pending.findIndex((entry) => entry.messageId === event.data.messageId)
        if (at !== -1) this.pending.splice(at, 1)
        this.notice(SYMBOL.inbox, "dim", [span("withdrawn: ", "dim"), span(`"${oneLine(item?.text ?? event.data.messageId)}"`, "dim", { strike: true })], [], replay, "session")
        return
      }
      case "turn.ended": {
        const verification = event.data.verification
        const next = span(" · on to the queued message", "dim")
        if (verification.status === "passed") this.notice(SYMBOL.ok, "ok", [span("checks passed", "ok"), next], [], replay, "work")
        else if (verification.status === "unresolved")
          this.notice(SYMBOL.fail, "error", [span("failing checks left unresolved", "error", { bold: true }), span(`: ${verification.failing.join(", ")}`, "error"), next], [[span(unresolvedReason(verification), "warn")]], replay, "work")
        else this.notice(SYMBOL.ok, "dim", [span(verification.status === "not_needed" ? "nothing to check" : verification.status === "left_to_parent" ? "checks left to the session that started it" : "no checks configured", "dim"), next], [], replay, "work")
        return
      }
      case "execution.started":
        this.beginTurn(event.time)
        this.cutOff = null
        return
      case "execution.resumed": {
        const count = (this.resumes.get(event.data.executionId) ?? 0) + 1
        this.resumes.set(event.data.executionId, count)
        if (this.turn === null) this.beginTurn(event.time)
        const why = this.cutOff === "crash" ? "after the previous process stopped unexpectedly" : this.cutOff === "shutdown" ? "after a shutdown" : "an unfinished turn"
        this.cutOff = null
        this.notice(SYMBOL.retry, "accent", [span(`resuming ${why}`), span(count > 1 ? ` (resume ${count})` : "", "dim")], [], replay, "work")
        return
      }
      case "execution.succeeded": {
        const turn = this.endTurn()
        const unresolved = event.data.verification.status === "unresolved"
        this.outcome(unresolved ? "unresolved" : "succeeded", turn, event.time, { verification: event.data.verification, executionId: event.data.executionId }, replay)
        return
      }
      case "execution.failed": {
        const turn = this.endTurn()
        // Ended because a call needed approval and nobody could give it (`unattended: stop`): not an error of the work.
        if (event.data.cause === "approval" && turn !== null) turn.lastError = "approval needed"
        this.outcome("failed", turn, event.time, { message: sanitize(event.data.message), executionId: event.data.executionId }, replay)
        return
      }
      case "execution.interrupted": {
        const turn = this.endTurn()
        if (event.data.reason === "shutdown") this.cutOff = "shutdown"
        this.outcome(event.data.reason === "shutdown" ? "shutdown" : "interrupted", turn, event.time, { executionId: event.data.executionId }, replay)
        return
      }
      case "snapshot.unavailable":
        this.notice(SYMBOL.note, "dim", [span("files cannot be restored by /undo in this session:", "dim")], [[span(sanitize(event.data.message), "dim")]], replay, "session")
        return
      case "snapshot.coverage": {
        const { skipped, nestedRepositories } = event.data
        if (skipped.length > 0) this.notice(SYMBOL.note, "dim", [span(`${plural(skipped.length, "file")} cannot be undone (too large or unreadable): `, "dim"), span(fileList(skipped.map((file) => file.path), 4), "dim")], [], replay, "session")
        if (nestedRepositories.length > 0)
          this.notice(SYMBOL.note, "dim", [span(`not tracked for undo (${plural(nestedRepositories.length, "nested repository", "nested repositories")}): `, "dim"), span(fileList(nestedRepositories, 4), "dim")], [], replay, "session")
        return
      }
      case "checks.started": {
        this.activity.checking = { names: event.data.checks, since: this.now(), progress: null }
        const row = this.notice(SYMBOL.check, "dim", [span(`running ${event.data.checks.length === 1 ? "check" : "checks"}: ${event.data.checks.join(", ")}`, "dim")], [], replay, "work")
        this.checks.set(event.data.run, { row, startedAt: event.time })
        return
      }
      case "checks.finished": {
        this.activity.checking = null
        const open = this.checks.get(event.data.run)
        this.checks.delete(event.data.run)
        const row = open?.row
        const startedAt = open?.startedAt
        const checks = event.data.evidence.checks
        const failed = checks.some((check) => check.status !== "passed")
        const took = startedAt === undefined ? "" : ` · ${seconds(event.time - startedAt)}`
        const text = [span(`checks: ${checksSummary(checks)}`, failed ? "error" : "ok"), span(took, "dim")]
        const detail = checkLines(checks).flatMap((line) => [
          [span(`${SYMBOL.fail} `, "error"), span(line.name, undefined, { bold: true }), span(` · ${line.status}`, "error"), span(` · ${line.command}`, "dim")],
          ...(line.output === null ? [] : [[span(`  output: ${line.output}`, "dim")]]),
        ])
        if (row === undefined) this.notice(failed ? SYMBOL.fail : SYMBOL.ok, failed ? "error" : "ok", text, detail, replay, "work")
        else this.touch(row, () => Object.assign(row, { symbol: failed ? SYMBOL.fail : SYMBOL.ok, tone: failed ? "error" : "ok", text, detail }))
        return
      }
      case "checks.failed": {
        this.activity.checking = null
        const row = this.checks.get(event.data.run)?.row
        this.checks.delete(event.data.run)
        const error = event.data.error
        if (error.kind === "crashed") this.cutOff = "crash"
        const [symbol, tone, text]: [string, Role, string] =
          error.kind === "interrupted"
            ? [SYMBOL.stop, "warn", "the checks were stopped before they finished"]
            : error.kind === "crashed"
              ? [SYMBOL.unknown, "warn", "the checks were cut short when the previous process stopped"]
              : [SYMBOL.fail, "error", `the checks could not be run: ${stepErrorText(error)}`]
        if (row === undefined) this.notice(symbol, tone, [span(text, tone)], [], replay, "work")
        else this.touch(row, () => Object.assign(row, { symbol, tone, text: [span(text, tone)] }))
        return
      }
      case "history.reverted":
      case "history.restored": {
        const undone = event.type === "history.reverted"
        const record = event.data.restore
        // The rows of the turns it takes out of the conversation, or puts back: they look undone until a /redo.
        if (event.type === "history.reverted") {
          for (const row of this.rows)
            if (row.seq >= event.data.fromSeq && row.seq < event.seq) this.touch(row, () => row.undoneBy.add(event.seq))
        } else {
          const revert = event.data.revertSeq
          for (const row of this.rows) if (row.undoneBy.has(revert)) this.touch(row, () => row.undoneBy.delete(revert))
        }
        const turns = undone ? this.turns.turns.filter((turn) => turn.undoneBy.has(event.seq)) : this.redone
        const which = turnsLabel(turns)
        const head = which === null ? (undone ? "went back" : "brought back") : undone ? `undone: ${which} · out of the conversation` : `redone: ${which} · back in the conversation`
        const what =
          record === null
            ? undone
              ? " · no file was restored · /redo brings it back"
              : " · no file was restored"
            : ` · ${plural(record.changed, "file")} ${undone ? "restored · /redo brings it back" : "as the turn left them"}`
        const kept = record?.kept ?? []
        const byHand = kept.filter((item) => item.reason === "hand_edited").map((item) => item.path)
        const other = kept.filter((item) => item.reason !== "hand_edited").map((item) => item.path)
        const detail = [
          ...(byHand.length > 0 ? [[span(`${undone ? "left as they are now, the outside changes and the agent's both" : "left as they are now, with the outside changes"}: ${fileList(byHand, 6)}`, "dim")]] : []),
          ...(other.length > 0 || (record?.keptOmitted ?? 0) > 0 ? [[span(`left alone (ignored or never recorded): ${fileList(other, 6)}${(record?.keptOmitted ?? 0) > 0 ? ` and ${record!.keptOmitted} more` : ""}`, "dim")]] : []),
        ]
        this.notice(undone ? SYMBOL.undo : SYMBOL.redo, "accent", [span(head), span(what, "dim")], detail, replay, "session")
        return
      }
      case "revert.failed":
        this.notice(SYMBOL.fail, "error", [span(`the workspace could not be restored: ${sanitize(event.data.message)}`, "error")], [[span("nothing changed in the conversation", "dim")]], replay, "session")
        return
      default: {
        const type = (event as { type: string }).type
        if (SILENT.has(type)) return
        this.unknown.set(type, (this.unknown.get(type) ?? 0) + 1)
        this.add<DebugRow>({ kind: "debug", text: `${type} ${oneLine(JSON.stringify((event as { data?: unknown }).data ?? event)).slice(0, 300)}` }, replay)
      }
    }
  }

  // ---------------------------------------------------------------- streams

  private textDelta(messageId: string, text: string, replay: boolean): void {
    const clean = sanitize(text)
    if (clean === "") return
    let row = this.openText.get(messageId)
    if (row === undefined) {
      if (clean.trim() === "") return
      row = this.add<TextRow>({ kind: "text", messageId, text: "", streaming: true, continuation: this.continuing }, replay)
      this.continuing = false
      this.openText.set(messageId, row)
    }
    const target = row
    this.touch(target, () => (target.text = (target.text + clean).replace(/^\s+/, "")))
  }

  private textEnded(messageId: string, text: string, replay: boolean): void {
    const final = sanitize(text).replace(/^\s+/, "").replace(/\s+$/, "")
    const row = this.openText.get(messageId)
    this.openText.delete(messageId)
    if (row === undefined) {
      if (final === "") return
      this.add<TextRow>({ kind: "text", messageId, text: final, streaming: false, continuation: this.continuing }, replay)
      this.continuing = false
      return
    }
    this.touch(row, () => {
      row.text = final
      row.streaming = false
    })
  }

  private reasoningDelta(messageId: string, text: string, replay: boolean): void {
    let row = this.openReasoning.get(messageId)
    if (row === undefined) {
      row = this.add<ReasoningRow>({ kind: "reasoning", messageId, text: "", streaming: true, expanded: false }, replay)
      this.openReasoning.set(messageId, row)
    }
    const target = row
    this.touch(target, () => (target.text += sanitize(text)))
  }

  private reasoningEnded(messageId: string, text: string, replay: boolean): void {
    const row = this.openReasoning.get(messageId)
    this.openReasoning.delete(messageId)
    const clean = sanitize(text).trim()
    if (row === undefined) {
      if (clean === "") return
      this.add<ReasoningRow>({ kind: "reasoning", messageId, text: clean, streaming: false, expanded: false }, replay)
      return
    }
    this.touch(row, () => {
      row.text = clean === "" ? row.text : clean
      row.streaming = false
    })
  }

  private inputDelta(messageId: string, callId: string, name: string, input: string, replay: boolean): void {
    const id = key(messageId, callId)
    const row = this.tools.get(id) ?? this.toolRow(messageId, callId, name, "", replay)
    this.touch(row, () => {
      row.name = name
      row.input += input
    })
  }

  private toolCalled(data: EventData<"tool.called">, replay: boolean): void {
    const id = key(data.messageId, data.callId)
    const row = this.tools.get(id) ?? this.toolRow(data.messageId, data.callId, data.name, data.input, replay)
    this.touch(row, () => {
      row.name = data.name
      row.input = data.input
      row.arg = oneLine(callArgument(data.name, data.input))
      if (row.phase === "writing") row.phase = "called"
    })
  }

  private toolRow(messageId: string, callId: string, name: string, input: string, replay: boolean): ToolRow {
    const row = this.add<ToolRow>(
      {
        kind: "tool",
        key: key(messageId, callId),
        messageId,
        name,
        input,
        arg: input === "" ? "" : oneLine(callArgument(name, input)),
        phase: "writing",
        outcome: null,
        output: "",
        display: null,
        truncation: null,
        progress: null,
        startedAt: null,
        settledAt: null,
        runningSince: null,
        expand: 0,
        sandbox: undefined,
        approval: null,
        subagent: null,
      },
      replay,
    )
    this.tools.set(row.key, row)
    return row
  }

  /** What a settled call changed, for the turn's per-file diffs. */
  private recordChange(row: ToolRow): void {
    const turn = this.turn
    if (turn === null || row.outcome !== "success") return
    const display = asObject(row.display)
    const path = typeof display?.path === "string" ? display.path : pathArgument(row.input)
    if (path === null) return
    if (row.name === "edit" && typeof display?.diff === "string") turn.diffs.set(path, [...(turn.diffs.get(path) ?? []), display.diff])
    else if (row.name === "write") turn.written.add(path)
  }

  // ---------------------------------------------------------------- inbox

  private enqueued(data: EventData<"inbox.enqueued">, replay: boolean): void {
    const text = data.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
    const midTurn = this.activity.executing
    this.inboxText.set(data.messageId, { text, delivery: data.delivery, midTurn })
    // A wake-up's message is not something the user typed: which wake-up, why, and the message it was set up with.
    if (data.origin === "wake" || data.origin === "wake_webhook") {
      const summary = wakeMessageSummary(text, data.origin)
      this.notice("⏰", "accent", [span(summary.head, "accent")], summary.message === null ? [] : [[span(sanitize(summary.message))]], replay, "session")
      return
    }
    if (data.origin !== null) {
      this.notice(SYMBOL.inbox, "dim", [span(`${data.origin}: `, "dim"), span(`"${oneLine(text)}"`)], [], replay, "work")
      return
    }
    // The title the server derives for a session without one: the first line of its first message.
    if (this.session.title === null) this.session.title = deriveTitle(sanitize(text))
    if (!midTurn) {
      this.userRows.set(data.messageId, this.add<UserRow>({ kind: "user", text: sanitize(text), delivered: null, turn: null }, replay))
      return
    }
    this.pending.push({ messageId: data.messageId, text: sanitize(text), delivery: data.delivery })
  }

  // ---------------------------------------------------------------- turns

  private beginTurn(time: number): void {
    this.turn = { start: time, steps: 0, usage: null, lastError: null, requestId: null, changedFiles: null, diffs: new Map(), written: new Set() }
    Object.assign(this.activity, blankActivity(), { executing: true, turnStartedAt: this.now() })
  }

  private endTurn(): Turn | null {
    const turn = this.turn
    this.turn = null
    Object.assign(this.activity, blankActivity())
    this.continuing = false
    this.sentBack = 0
    this.stopAsked = false
    const stop = this.stopRow
    this.stopRow = null
    if (stop !== null) this.touch(stop, () => (stop.text = stop.text.slice(0, 1)))
    // Anything still open belongs to the turn that ended.
    for (const row of this.openText.values()) this.touch(row, () => (row.streaming = false))
    for (const row of this.openReasoning.values()) this.touch(row, () => (row.streaming = false))
    this.openText.clear()
    this.openReasoning.clear()
    return turn
  }

  private outcome(outcome: OutcomeRow["outcome"], turn: Turn | null, time: number, extra: { verification?: VerificationOutcome; message?: string; executionId?: string }, replay: boolean): void {
    const waiting = outcome === "interrupted" ? this.pending.length : 0
    this.add<OutcomeRow>(
      {
        kind: "outcome",
        outcome,
        verification: extra.verification ?? null,
        steps: turn?.steps ?? 0,
        durationMs: turn === null ? null : time - turn.start,
        usage: turn?.usage ?? null,
        message: extra.message ?? null,
        errorKind: turn?.lastError ?? null,
        requestId: turn?.requestId ?? null,
        executionId: extra.executionId ?? null,
        changedFiles: turn?.changedFiles ?? null,
        serverDiff: null,
        diffs: turn?.diffs ?? new Map(),
        written: turn?.written ?? new Set(),
        waiting,
        expanded: false,
        turn: this.turns.turns.findLast((candidate) => candidate.endSeq === this.lastSeq)?.number ?? null,
      },
      replay,
    )
  }

  private closeStep(messageId: string, usage: Usage | null, ended: CallUsage["ended"]): void {
    if (this.activity.call?.messageId === messageId) this.activity.call = null
    const text = this.openText.get(messageId)
    if (text !== undefined) {
      this.touch(text, () => (text.streaming = false))
      this.openText.delete(messageId)
    }
    const reasoning = this.openReasoning.get(messageId)
    if (reasoning !== undefined) {
      this.touch(reasoning, () => (reasoning.streaming = false))
      this.openReasoning.delete(messageId)
    }
    if (usage !== null) this.record(messageId, usage, "step", ended, this.stepModels.get(messageId) ?? this.session.model)
    this.addUsage(usage)
  }

  private record(messageId: string, usage: Usage, kind: CallUsage["kind"], ended: CallUsage["ended"], model: string | null): void {
    const diagnostics = this.callDiagnostics.get(messageId) ?? []
    this.callDiagnostics.delete(messageId)
    this.calls.push({ n: this.calls.length + 1, messageId, model, kind, usage, diagnostics, ended })
  }

  private addUsage(usage: Usage | null): void {
    if (usage === null || this.turn === null) return
    const sum = this.turn.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    this.turn.usage = {
      inputTokens: sum.inputTokens + usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    }
  }

  private stepFailed(error: StepError, replay: boolean): void {
    switch (error.kind) {
      case "provider":
        return this.setError(error.error.kind, error.error.requestId)
      case "interrupted":
        return
      case "crashed":
        this.cutOff = "crash"
        return this.setError("crashed")
      case "internal":
        this.setError("internal")
        this.notice(SYMBOL.fail, "error", [span(`internal error: ${sanitize(error.message)}`, "error")], [], replay, "work")
    }
  }

  private setError(kind: string, requestId: string | null = null): void {
    if (this.turn === null) return
    this.turn.lastError = kind
    this.turn.requestId = requestId
  }

  private synthetic(origin: string, replay: boolean): void {
    switch (origin) {
      case "interrupt":
        return
      case "check_report":
        this.sentBack = Math.abs(this.sentBack) + 1
        return
      case "continuation":
        this.continuing = true
        return void this.notice(SYMBOL.retry, "warn", [span("asking the model to continue where it was cut off", "dim")], [], replay, "work")
      case "output_limit":
        return void this.notice(SYMBOL.unknown, "warn", [span("output limit reached"), span(" · asking the model to continue", "dim")], [], replay, "work")
      case "empty_response":
        return void this.notice(SYMBOL.unknown, "warn", [span("empty response"), span(" · nudging the model once", "dim")], [], replay, "work")
      case "step_limit":
        return void this.notice(SYMBOL.unknown, "warn", [span("step limit reached"), span(" · one last answer, without tools", "dim")], [], replay, "work")
      default:
        return void this.notice(SYMBOL.note, "dim", [span(`note to the model (${origin})`, "dim")], [], replay, "work")
    }
  }

  // ---------------------------------------------------------------- rows

  private notice(symbol: string, tone: Role, text: Span[], detail: Span[][], replay: boolean, group: NoticeRow["group"]): NoticeRow {
    return this.add<NoticeRow>({ kind: "notice", symbol, tone, text, detail, group }, replay)
  }

  private add<R extends Row>(fields: Omit<R, "id" | "version" | "replay" | "seq" | "undoneBy">, replay: boolean): R {
    const row = { ...fields, id: this.nextId++, version: 0, replay, seq: this.lastSeq, undoneBy: new Set<number>() } as unknown as R
    this.rows.push(row)
    this.version += 1
    return row
  }

  private touch<R extends Row>(row: R, change: () => void): void {
    change()
    row.version += 1
    this.version += 1
  }

  /** Re-lays-out a row after a change made outside `apply` (expanding it). */
  changed(row: Row): void {
    row.version += 1
    this.version += 1
  }
}

/** Whether `/undo` took the row's turn out of the conversation (and no `/redo` put it back). */
export function isUndoneRow(row: Row): boolean {
  return row.undoneBy.size > 0
}

/** Turns as the user sees them named: `turn 3 "fix the test"`, `turns 2 to 4`; `null` for none. */
export function turnsLabel(turns: readonly TurnInfo[]): string | null {
  if (turns.length === 0) return null
  if (turns.length === 1) {
    const turn = turns[0]!
    return `turn ${turn.number}${turn.prompt === "" ? "" : ` "${oneLine(turn.prompt).slice(0, 40)}${oneLine(turn.prompt).length > 40 ? "…" : ""}"`}`
  }
  return `turns ${turns[0]!.number} to ${turns.at(-1)!.number}`
}

export function expandable(row: Row): boolean {
  return row.kind === "tool" || row.kind === "reasoning" || row.kind === "outcome" || (row.kind === "notice" && row.detail.length > 2)
}

function blankActivity(): Activity {
  return { executing: false, turnStartedAt: null, steps: 0, call: null, checking: null, compacting: null, retry: null, stopping: false, waiting: null }
}

function key(messageId: string, callId: string): string {
  return `${messageId}/${callId}`
}

export function oneLine(text: string): string {
  return sanitize(text).replace(/\s*\n\s*/g, " ⏎ ")
}

function seconds(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

export function asObject(value: Json | null | undefined): Record<string, Json> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : null
}

function pathArgument(input: string): string | null {
  try {
    const value: unknown = JSON.parse(input)
    return typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string" ? (value as { path: string }).path : null
  } catch {
    return null
  }
}

function sourceLabel(source: string): string {
  return source.startsWith("agents:") ? source.slice("agents:".length) : source
}

export function errorLabel(error: ProviderError): string {
  if (error.kind === "transport" && error.reason === "stalled") return "the connection stalled"
  if (error.kind === "transport" && error.reason === "timeout") return "the model call took too long"
  const labels: Record<ProviderError["kind"], string> = {
    rate_limit: "rate limited",
    provider_internal: "server error",
    transport: "network error",
    incomplete_stream: "the stream ended early",
    auth: "not signed in",
    usage_limit: "usage limit reached",
    content_policy: "refused",
    invalid_request: "invalid request",
    context_overflow: "context too long",
  }
  const label = labels[error.kind] ?? error.kind
  return error.status === null ? label : `${label} (${error.status})`
}

function errorClass(error: StepError): string {
  return error.kind === "provider" ? error.error.kind : error.kind
}

function stepErrorText(error: StepError): string {
  switch (error.kind) {
    case "provider":
      return `${errorLabel(error.error)}: ${error.error.message}`
    case "interrupted":
      return `interrupted (${error.reason})`
    case "crashed":
      return "the process stopped unexpectedly"
    case "internal":
      return error.message
  }
}
