/**
 * Turns a session's event stream into terminal output, one event at a time.
 *
 * Three sinks share one interface:
 * - `PrettyRenderer`: what a person watches. Streamed text as it arrives, one
 *   line per tool call start and outcome, one short line per notable event.
 * - `JsonSink`: every event as one JSON line, nothing else on stdout.
 * - `QuietSink`: only the final assistant text of each turn, for pipelines.
 */
import { type EventData, type ProviderError, type SessionSettings, type StepError, type Usage, type VerificationOutcome, brand } from "@light-harness/core"
import type { EngineEvent } from "./engine.ts"
import { callArgument, checkLines, checksSummary, detailLines, errorSummary, fileList, successSummary, unresolvedReason } from "./tools.ts"
import { type Segment, type Tone, displayWidth, flatten, formatDuration, paint, plural, renderLine, seg, truncate, wrap } from "./text.ts"

export interface Sink {
  event(event: EngineEvent): void
  /**
   * The user pressed Ctrl-C and the CLI asked the engine to stop. The engine's
   * `execution.interrupt_requested` is what shows the stop; this only adds how
   * to leave without waiting.
   */
  interruptRequested(): void
  /** A message from the CLI itself, such as "stopping". Never on stdout in `--json` mode. */
  notice(text: string, tone?: "info" | "warn" | "error"): void
  /** Leaves the terminal tidy (no transient status line, cursor at a line start). Called before the CLI exits. */
  close(): void
}

export interface PrettyOptions {
  readonly write: (text: string) => void
  readonly color: boolean
  /** Current terminal width. Asked on every line, so a resize applies from the next line. */
  readonly columns: () => number
  /** Draw a transient status line (thinking, running tools). Only for a terminal. */
  readonly live: boolean
  /** Stream reasoning in full instead of one collapsed line. */
  readonly showReasoning: boolean
  /** Print user prompts found in the stream (`› ...`), for replays where nobody typed them here. */
  readonly echoPrompts: boolean
  /**
   * Where the transient status line goes when something else owns the bottom
   * of the terminal (the interactive input). Without it, and with `live`, the
   * renderer draws the status line itself.
   */
  readonly status?: (text: string | null) => void
}

type Block = "prompt" | "text" | "reasoning" | "info" | "summary"

interface Call {
  readonly name: string
  readonly arg: string
  startedAt: number | null
  /** The line count right after this call's start line; equal at settle time means nothing came in between. */
  after: number
}

interface Turn {
  start: number
  steps: number
  usage: Usage | null
  /** The class of the last error seen in this turn, for the failure line. */
  lastError: string | null
  /** The provider's request ID of the last failed call, for the failure line: what a bug report quotes. */
  requestId: string | null
}

interface InboxItem {
  readonly text: string
  readonly delivery: string
  /** Admitted while a turn was running (a steer or a queued follow-up), rather than as the prompt that starts one. */
  readonly midTurn: boolean
  readonly origin: string | null
}

const SYMBOL = {
  call: "▸",
  ok: "✓",
  fail: "✗",
  notRun: "○",
  unknown: "⚠",
  retry: "↻",
  inbox: "↳",
  think: "∴",
  stop: "■",
  settings: "⇄",
  refused: "⊘",
  compact: "⇣",
  note: "·",
  prompt: "›",
  undo: "↶",
  redo: "↷",
} as const

export class PrettyRenderer implements Sink {
  private atLineStart = true
  private lines = 0
  private last: Block | null = null
  private readonly textBuffers = new Map<string, string>()
  private readonly reasoningBuffers = new Map<string, string>()
  private readonly calls = new Map<string, Call>()
  private readonly running = new Set<string>()
  /** Calls whose start line is shown and that have not settled. */
  private readonly open = new Set<string>()
  private readonly progress = new Map<string, string>()
  private readonly inbox = new Map<string, InboxItem>()
  private readonly resumes = new Map<string, number>()
  private turn: Turn | null = null
  private executing = false
  private openStep: string | null = null
  private compacting = false
  private retrying = false
  /** How the previous process left the current execution, for the resume line. */
  private cutOff: "crash" | "shutdown" | null = null
  private settings: SessionSettings | null = null
  /** The instruction files of the latest baseline, so an unchanged list is not shown again. */
  private instructionFiles = ""
  /** The stop of the running execution: asked for by this CLI (with the exit hint pending), shown, or neither. */
  private stop: "hint" | "shown" | null = null
  /** The next text block continues a response that a provider error cut off. */
  private continuing = false
  private status: string | null = null
  private statusDrawn = false
  /** The run of checks in progress: which checks, and the latest progress text of the one that is running. */
  private checking: { readonly names: readonly string[]; readonly startedAt: number; progress: string | null } | null = null
  /** A failing run was reported to the model and its next step has not started: the line that says so is still owed. */
  private sentBack = 0

  constructor(private readonly options: PrettyOptions) {}

  event(event: EngineEvent): void {
    this.handle(event)
    this.drawStatus()
  }

  notice(text: string, tone: "info" | "warn" | "error" = "info"): void {
    this.line("info", [seg(text, tone === "error" ? "red" : tone === "warn" ? "yellow" : "dim")])
    this.drawStatus()
  }

  interruptRequested(): void {
    if (this.stop === "shown") {
      this.notice(`${SYMBOL.stop} still stopping… press Ctrl-C again to exit now`, "warn")
      return
    }
    this.stop = "hint"
  }

  close(): void {
    this.clearStatus()
    this.endLine()
  }

  /** Echoes a prompt as if typed: `› text`. */
  prompt(text: string): void {
    this.endLine()
    this.gap("prompt")
    const lines = text.split("\n").flatMap((line) => wrap(flatten(line), this.width - 2))
    lines.forEach((line, index) => this.writeLine([seg(index === 0 ? `${SYMBOL.prompt} ` : "  ", "dim"), seg(line, "bold")]))
  }

  /** Call before an interactive prompt is drawn: finishes the line and leaves one blank line. Returns what to write. */
  beforePrompt(): void {
    this.endLine()
    if (this.last !== null) this.raw("\n")
    this.last = "prompt"
  }

  // ---------------------------------------------------------------- events

  private handle(event: EngineEvent): void {
    switch (event.type) {
      case "text.delta":
        return this.textDelta(event.messageId, event.text)
      case "reasoning.delta":
        return this.reasoningDelta(event.messageId, event.text)
      case "tool.input.delta":
        return
      case "tool.progress":
        this.progress.set(key(event.messageId, event.callId), event.text)
        return
      case "checks.progress":
        if (this.checking !== null) this.checking.progress = event.text
        return
      case "workspace.changes":
        // The files this turn changed, right before its outcome line.
        this.lineWithArg("info", [seg(`${SYMBOL.note} changed ${plural(event.files.length, "file")}: `, "dim")], fileList(event.files, 6), [])
        return
      case "diagnostic": {
        // Something is wrong with the harness itself. It is said in full: this is what a bug report quotes.
        const what = event.kind === "prefix_violation" ? "prompt cache" : event.kind.replace(/_/g, " ")
        this.line("info", [seg(`${SYMBOL.unknown} ${what}: `, "yellow")])
        for (const line of wrap(flatten(event.message), this.width - 2)) this.line("info", [seg(`  ${line}`, "yellow")])
        return
      }
      case "text.ended":
        return this.textEnded(event.data.messageId, event.data.text)
      case "reasoning.ended":
        return this.reasoningEnded(event.data.messageId, event.data.text)
      case "tool.called":
        return this.toolCalled(event.data)
      case "tool.started": {
        const id = key(event.data.messageId, event.data.callId)
        const call = this.calls.get(id)
        if (call !== undefined) call.startedAt = event.time
        else this.calls.set(id, { name: "tool", arg: event.data.callId, startedAt: event.time, after: -1 })
        this.running.add(id)
        return
      }
      case "tool.settled":
        return this.toolSettled(event.data, event.time)
      case "step.started":
        this.openStep = event.data.messageId
        this.open.clear()
        this.retrying = false
        if (this.turn !== null) this.turn.steps += 1
        if (this.sentBack > 0) {
          // Said only now that the agent is in fact working again: a report can also be the last thing in a turn.
          this.line("info", [seg(`${SYMBOL.retry} `, "yellow"), seg("the agent is shown the failing checks and carries on"), seg(this.sentBack > 1 ? ` · round ${this.sentBack}` : "", "dim")])
          this.sentBack = -this.sentBack
        }
        return
      case "step.ended":
        this.closeStep(event.data.messageId, event.data.usage)
        return
      case "step.failed":
        this.closeStep(event.data.messageId, event.data.usage)
        return this.stepFailed(event.data.error)
      case "step.refused":
        this.closeStep(event.data.messageId, event.data.usage)
        this.setError("content_policy")
        this.line("info", [seg(`${SYMBOL.refused} `, "red"), seg("refused by the provider: ", "red"), seg(flatten(event.data.message))])
        this.line("info", [seg("  this exchange is left out of what the model sees next", "dim")])
        return
      case "retry.scheduled": {
        this.retrying = true
        const error = event.data.error
        this.setError(error.kind, error.requestId)
        const head = [seg(`${SYMBOL.retry} `, "yellow"), seg(`retrying in ${formatDuration(event.data.delayMs)} (attempt ${event.data.attempt})`, "yellow")]
        const why = `${errorLabel(error)}: ${flatten(error.message)}`
        // On a narrow terminal the reason goes on its own lines rather than being cut.
        if (displayWidth(`↻ retrying in ${formatDuration(event.data.delayMs)} (attempt ${event.data.attempt}) · ${why}`) <= this.width) this.line("info", [...head, seg(` · ${why}`, "dim")])
        else {
          this.line("info", head)
          for (const line of wrap(why, this.width - 2)) this.line("info", [seg(`  ${line}`, "dim")])
        }
        return
      }
      case "compaction.started":
        this.compacting = true
        return
      case "compaction.ended":
        this.compacting = false
        this.addUsage(event.data.usage)
        this.line("info", [seg(`${SYMBOL.compact} `, "cyan"), seg("compacted the conversation"), seg(" · older messages are now a summary for the model", "dim")])
        return
      case "compaction.failed":
        this.compacting = false
        this.setError(errorClass(event.data.error), event.data.error.kind === "provider" ? event.data.error.error.requestId : null)
        this.line("info", [seg(`${SYMBOL.fail} `, "red"), seg(`compaction failed: ${stepErrorText(event.data.error)}`, "red")])
        return
      case "synthetic.appended":
        return this.syntheticAppended(event.data.origin)
      case "instruction.appended": {
        const source = sourceLabel(event.data.source)
        if (event.data.fingerprint === null) this.line("info", [seg(`${SYMBOL.note} instructions removed: ${source}`, "dim")])
        else this.line("info", [seg(`${SYMBOL.note} instructions updated (${source}): `, "dim"), seg(flatten(event.data.text), "dim")])
        return
      }
      case "settings.changed":
        return this.settingsChanged(event.data)
      case "baseline.set": {
        const files = event.data.sources.filter((entry) => entry.source.startsWith("agents:")).map((entry) => sourceLabel(entry.source))
        const list = files.join(", ")
        if (list === this.instructionFiles) return
        this.instructionFiles = list
        if (list !== "") this.line("info", [seg(`${SYMBOL.note} instructions from ${list}`, "dim")])
        return
      }
      case "execution.interrupt_requested": {
        const hint = this.stop === "hint" ? " press Ctrl-C again to exit now" : ""
        this.stop = "shown"
        this.retrying = false
        const what = event.data.reason === "user" ? "stopping…" : "shutting down…"
        this.line("info", [seg(`${SYMBOL.stop} `, "yellow"), seg(what, "yellow"), seg(hint, "dim")])
        return
      }
      case "inbox.enqueued":
        return this.enqueued(event.data)
      case "inbox.delivered": {
        const item = this.inbox.get(event.data.messageId)
        this.inbox.delete(event.data.messageId)
        if (item === undefined || !item.midTurn) return
        this.line("info", [seg(`${SYMBOL.inbox} `, "magenta"), seg("delivered to the agent: ", "dim"), seg(quote(item.text))])
        return
      }
      case "inbox.cancelled": {
        const item = this.inbox.get(event.data.messageId)
        this.inbox.delete(event.data.messageId)
        this.line("info", [seg(`${SYMBOL.inbox} withdrawn: `, "dim"), seg(quote(item?.text ?? event.data.messageId), "dim")])
        return
      }
      case "inbox.delivery_changed": {
        const item = this.inbox.get(event.data.messageId)
        if (item !== undefined) this.inbox.set(event.data.messageId, { ...item, delivery: event.data.delivery })
        const what = event.data.delivery === "queue" ? "now queued until the current work is done" : "now delivered after the current step"
        this.line("info", [seg(`${SYMBOL.inbox} ${what}: `, "dim"), seg(quote(item?.text ?? event.data.messageId), "dim")])
        return
      }
      case "execution.started":
        this.executing = true
        this.cutOff = null
        this.turn = { start: event.time, steps: 0, usage: null, lastError: null, requestId: null }
        return
      case "execution.resumed": {
        const count = (this.resumes.get(event.data.executionId) ?? 0) + 1
        this.resumes.set(event.data.executionId, count)
        this.executing = true
        this.turn ??= { start: event.time, steps: 0, usage: null, lastError: null, requestId: null }
        const why =
          this.cutOff === "crash" ? "after the previous process stopped unexpectedly" : this.cutOff === "shutdown" ? "after a shutdown" : "an unfinished turn"
        this.cutOff = null
        this.line("info", [seg(`${SYMBOL.retry} `, "cyan"), seg(`resuming ${why}`), seg(count > 1 ? ` (resume ${count})` : "", "dim")])
        return
      }
      case "execution.succeeded": {
        const turn = this.endTurn()
        const parts = [turn === null ? null : plural(turn.steps, "step"), turn === null ? null : formatDuration(event.time - turn.start)]
        return this.succeeded(event.data.verification, parts, turn)
      }
      case "execution.failed": {
        const turn = this.endTurn()
        const kind = turn?.lastError
        const head = [seg(`${SYMBOL.fail} `, "red"), seg(kind === null || kind === undefined ? "failed" : `failed (${kind})`, ["red", "bold"])]
        const message = flatten(event.data.message)
        // The request ID is what a bug report quotes, so it is on a line of its own and never cut.
        const requestId = turn?.requestId ?? null
        const more = requestId === null ? [] : [[seg(`  request ${requestId}`, "dim")]]
        // The reason a turn failed is never cut: it moves to its own wrapped lines when it does not fit.
        if (displayWidth(`✗ failed (${kind ?? ""}): ${message}`) <= this.width) this.summary([...head, seg(`: ${message}`, "red")], turn, more)
        else this.summary(head, turn, [...wrap(message, this.width - 2).map((line) => [seg(`  ${line}`, "red")]), ...more])
        return
      }
      case "execution.interrupted": {
        const turn = this.endTurn()
        if (event.data.reason === "shutdown") {
          this.cutOff = "shutdown"
          this.summary([seg(`${SYMBOL.stop} `, "yellow"), seg("stopped for shutdown", ["yellow", "bold"]), seg(" · the turn resumes at the next start", "dim")], turn)
          return
        }
        const time = turn === null ? null : formatDuration(event.time - turn.start)
        const waiting = [...this.inbox.values()].filter((item) => item.origin === null).length
        const more = waiting === 0 ? [] : [[seg(`  ${plural(waiting, "message")} still waiting · delivered when work starts again`, "dim")]]
        this.summary([seg(`${SYMBOL.stop} `, "yellow"), seg("interrupted", ["yellow", "bold"]), seg(suffix([time]), "dim")], turn, more)
        return
      }
      case "snapshot.taken":
      case "revert.started":
      case "revert.undo_started":
        return
      case "snapshot.unavailable":
        // Once per session: the engine records it only when it changes.
        // The reason is wrapped, not cut: it says what to install or fix.
        this.line("info", [seg(`${SYMBOL.note} files cannot be restored by /undo in this session:`, "dim")])
        for (const line of wrap(flatten(event.data.message), this.width - 2)) this.line("info", [seg(`  ${line}`, "dim")])
        return
      case "snapshot.coverage": {
        const { skipped, nestedRepositories } = event.data
        if (skipped.length > 0)
          this.lineWithArg("info", [seg(`${SYMBOL.note} ${plural(skipped.length, "file")} cannot be undone (too large or unreadable): `, "dim")], fileList(skipped.map((file) => file.path), 4), [])
        if (nestedRepositories.length > 0)
          this.lineWithArg("info", [seg(`${SYMBOL.note} not tracked for undo (${plural(nestedRepositories.length, "nested repository", "nested repositories")}): `, "dim")], fileList(nestedRepositories, 4), [])
        return
      }
      case "checks.started":
        this.checking = { names: event.data.checks, startedAt: event.time, progress: null }
        return
      case "checks.finished": {
        const took = this.checking === null ? null : formatDuration(event.time - this.checking.startedAt)
        this.checking = null
        const checks = event.data.evidence.checks
        const failed = checks.some((check) => check.status !== "passed")
        this.line("info", [seg(`${failed ? SYMBOL.fail : SYMBOL.ok} `, failed ? "red" : "green"), seg(`checks: ${checksSummary(checks)}`, failed ? "red" : undefined), seg(suffix([took]), "dim")])
        for (const detail of checkLines(checks)) {
          this.lineWithArg("info", [seg(`  ${SYMBOL.fail} `, "red"), seg(detail.name, "bold"), seg(` · ${detail.status}`, "red"), seg(" · ", "dim")], detail.command, [])
          if (detail.output !== null) this.line("info", [seg(`    output: ${detail.output}`, "dim")])
        }
        return
      }
      case "checks.failed": {
        this.checking = null
        const error = event.data.error
        if (error.kind === "interrupted") this.line("info", [seg(`${SYMBOL.stop} `, "yellow"), seg("the checks were stopped before they finished", "dim")])
        else if (error.kind === "crashed") {
          this.cutOff = "crash"
          this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("the checks were cut short when the previous process stopped", "dim")])
        } else this.line("info", [seg(`${SYMBOL.fail} `, "red"), seg(`the checks could not be run: ${stepErrorText(error)}`, "red")])
        return
      }
      case "history.reverted":
      case "history.restored": {
        const undone = event.type === "history.reverted"
        const record = event.data.restore
        const head = [seg(`${undone ? SYMBOL.undo : SYMBOL.redo} `, "cyan"), seg(undone ? "went back" : "brought back")]
        if (record === null) this.line("info", [...head, seg(undone ? " · the conversation was rewound; no file was restored" : " · the conversation is as it was; no file was restored", "dim")])
        else this.line("info", [...head, seg(` · ${plural(record.changed, "file")} restored`), seg(undone ? " · /redo brings it back" : "", "dim")])
        const kept = record?.kept ?? []
        const byHand = kept.filter((item) => item.reason === "hand_edited").map((item) => item.path)
        const other = kept.filter((item) => item.reason !== "hand_edited").map((item) => item.path)
        if (byHand.length > 0) this.lineWithArg("info", [seg("  kept as you edited them: ", "dim")], fileList(byHand, 6), [])
        if (other.length > 0 || (record?.keptOmitted ?? 0) > 0)
          this.lineWithArg("info", [seg("  left alone (ignored or never recorded): ", "dim")], fileList(other, 6), [seg((record?.keptOmitted ?? 0) > 0 ? ` and ${record!.keptOmitted} more` : "", "dim")])
        return
      }
      case "revert.failed":
        this.line("info", [seg(`${SYMBOL.fail} `, "red"), seg(`the workspace could not be restored: ${flatten(event.data.message)}`, "red")])
        this.line("info", [seg("  nothing changed in the conversation", "dim")])
        return
      case "session.created":
        this.settings = event.data.settings
        return
      case "session.renamed":
      case "session.archived":
      case "session.unarchived":
        return
    }
  }

  private textDelta(messageId: string, text: string): void {
    const clean = sanitize(text)
    if (clean === "") return
    const buffer = this.textBuffers.get(messageId) ?? ""
    this.textBuffers.set(messageId, buffer + clean)
    const before = shown(buffer)
    const after = shown(buffer + clean)
    if (after === before) return
    if (before === "") this.startText()
    // Another line (a steer, a stop) came in while the text streamed: carry on below it, marked as a continuation.
    else if (this.last !== "text") this.resumeText()
    this.raw(after.slice(before.length))
  }

  private textEnded(messageId: string, text: string): void {
    const final = shown(sanitize(text))
    const streamed = shown(this.textBuffers.get(messageId) ?? "")
    this.textBuffers.delete(messageId)
    if (streamed === "") {
      if (final.trim() === "") return
      this.startText()
      this.raw(final)
    } else if (final.startsWith(streamed)) {
      if (final.length > streamed.length && this.last !== "text") this.resumeText()
      this.raw(final.slice(streamed.length))
    } else {
      // The final text is not what was streamed; show the final one in full rather than a broken mix.
      this.endLine()
      this.raw(final)
    }
    this.endLine()
  }

  /** Starts a text block; after a continuation note it is marked as picking up a sentence mid-way. */
  private startText(): void {
    this.startStream("text")
    if (this.continuing) this.raw(paint(this.options.color, "dim", "… "))
    this.continuing = false
  }

  private resumeText(): void {
    this.startStream("text")
    this.raw(paint(this.options.color, "dim", "… "))
  }

  private reasoningDelta(messageId: string, text: string): void {
    const clean = sanitize(text)
    const buffer = this.reasoningBuffers.get(messageId) ?? ""
    this.reasoningBuffers.set(messageId, buffer + clean)
    if (!this.options.showReasoning) return
    if (buffer === "") {
      this.startStream("reasoning")
      this.raw(paint(this.options.color, "dim", `${SYMBOL.think} `))
    }
    this.raw(paint(this.options.color, "dim", clean))
  }

  private reasoningEnded(messageId: string, text: string): void {
    const clean = sanitize(text)
    const buffer = this.reasoningBuffers.get(messageId) ?? ""
    this.reasoningBuffers.delete(messageId)
    if (this.options.showReasoning) {
      if (buffer === "") {
        if (clean.trim() === "") return
        this.startStream("reasoning")
        this.raw(paint(this.options.color, "dim", `${SYMBOL.think} ${clean}`))
      } else if (clean.startsWith(buffer)) this.raw(paint(this.options.color, "dim", clean.slice(buffer.length)))
      this.endLine()
      return
    }
    const excerpt = clean.split("\n").map((line) => line.replace(/\*\*|__|^#+\s*/g, "").trim()).find((line) => line !== "")
    this.line("info", [seg(`${SYMBOL.think} thought`, "dim"), seg(excerpt === undefined ? "" : ` · ${excerpt}`, "dim")])
  }

  private toolCalled(data: EventData<"tool.called">): void {
    const arg = flatten(callArgument(data.name, data.input))
    const call: Call = { name: data.name, arg, startedAt: null, after: -1 }
    this.calls.set(key(data.messageId, data.callId), call)
    this.open.add(key(data.messageId, data.callId))
    this.lineWithArg("info", [seg(`${SYMBOL.call} `, "cyan"), seg(data.name, "bold"), seg(arg === "" ? "" : " ")], arg, [])
    call.after = this.lines
  }

  private toolSettled(data: EventData<"tool.settled">, time: number): void {
    const id = key(data.messageId, data.callId)
    const call = this.calls.get(id) ?? { name: "tool", arg: data.callId, startedAt: null, after: -1 }
    this.running.delete(id)
    this.progress.delete(id)
    // The short form (no name) only when this call's start line is the last line and no other call is open.
    const adjacent = call.after === this.lines && this.open.size === 1 && this.open.has(id)
    this.open.delete(id)
    const duration = call.startedAt === null ? null : formatDuration(time - call.startedAt)
    const described = describeOutcome(call.name, data)
    // On a narrow terminal the loop-decided outcomes drop their explanation before the call's argument is cut short.
    const room = this.width - displayWidth(`  ✓ ${call.name} · ${described.text}${suffix([duration])}`)
    const outcome = !adjacent && room < 16 && described.short !== undefined ? { ...described, text: described.short } : described
    const head: Segment[] = [seg("  "), seg(`${outcome.symbol} `, outcome.tone)]
    const tail: Segment[] = [seg(outcome.text === "" ? "" : outcome.text, outcome.tone === "green" ? undefined : outcome.tone), seg(suffix([duration]), "dim")]
    if (adjacent) this.line("info", [...head, ...trimLeadingDot(tail, outcome.text)])
    else this.lineWithArg("info", [...head, seg(call.name, "bold"), seg(call.arg === "" ? "" : " ")], call.arg, [seg(" · ", "dim"), ...tail])
    for (const detail of detailLines(call.name, data)) this.line("info", [seg(`    ${detail}`, "dim")])
    if (data.truncation !== null) {
      const where = data.truncation.spillPath === null ? "" : `: ${data.truncation.spillPath}`
      this.line("info", [seg(`    output capped · ${plural(data.truncation.originalLines, "line")} in full${where}`, "dim")])
    }
  }

  private stepFailed(error: StepError): void {
    switch (error.kind) {
      case "provider":
        // A retryable failure is explained by the retry line, a final one by the failure line.
        this.setError(error.error.kind, error.error.requestId)
        return
      case "interrupted":
        return
      case "crashed":
        this.cutOff = "crash"
        this.setError("crashed")
        return
      case "internal":
        this.setError("internal")
        this.line("info", [seg(`${SYMBOL.fail} `, "red"), seg(`internal error: ${flatten(error.message)}`, "red")])
        return
    }
  }

  private settingsChanged(next: SessionSettings): void {
    const previous = this.settings
    this.settings = next
    const changes: string[] = []
    if (previous === null || previous.model !== next.model) changes.push(previous === null ? `model ${next.model}` : `model ${previous.model} → ${next.model}`)
    if (previous === null || previous.reasoningEffort !== next.reasoningEffort)
      changes.push(`effort ${previous === null ? "" : `${previous.reasoningEffort ?? "default"} → `}${next.reasoningEffort ?? "default"}`)
    this.line("info", [seg(`${SYMBOL.settings} `, "cyan"), seg(changes.join(" · ")), seg(" · from the next step", "dim")])
  }

  /** The three ways a turn ends as done: on passing checks, without any, or with checks that still fail. */
  private succeeded(verification: VerificationOutcome, parts: readonly (string | null)[], turn: Turn | null): void {
    const done = (basis: string) => this.summary([seg(`${SYMBOL.ok} `, "green"), seg("done", ["green", "bold"]), seg(` · ${basis}`, basis === "checks passed" ? "green" : "dim"), seg(suffix(parts), "dim")], turn)
    switch (verification.status) {
      case "passed":
        return done("checks passed")
      case "not_needed":
        return done("nothing to check")
      case "not_configured":
        return done("no checks configured")
      case "unresolved": {
        const head = [seg(`${SYMBOL.fail} `, "red"), seg("stopped with failing checks", ["red", "bold"]), seg(`: ${verification.failing.join(", ")}`, "red"), seg(suffix(parts), "dim")]
        // The reason is never cut: it is why "done" is not what this turn ended as.
        const why = wrap(unresolvedReason(verification), this.width - 2).map((line) => [seg(`  ${line}`, "yellow")])
        return this.summary(head, turn, why)
      }
    }
  }

  private syntheticAppended(origin: string): void {
    switch (origin) {
      case "interrupt":
        return
      case "check_report":
        // Counted here and said when the agent's next step starts (see `step.started`).
        this.sentBack = Math.abs(this.sentBack) + 1
        return
      case "continuation":
        this.continuing = true
        this.line("info", [seg(`${SYMBOL.retry} `, "yellow"), seg("asking the model to continue where it was cut off", "dim")])
        return
      case "output_limit":
        this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("output limit reached"), seg(" · asking the model to continue", "dim")])
        return
      case "empty_response":
        this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("empty response"), seg(" · nudging the model once", "dim")])
        return
      case "step_limit":
        this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("step limit reached"), seg(" · one last answer, without tools", "dim")])
        return
      default:
        this.line("info", [seg(`${SYMBOL.note} note to the model (${origin})`, "dim")])
    }
  }

  private enqueued(data: EventData<"inbox.enqueued">): void {
    const text = data.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
    const midTurn = this.executing
    this.inbox.set(data.messageId, { text, delivery: data.delivery, midTurn, origin: data.origin })
    if (data.origin !== null) {
      this.line("info", [seg(`${SYMBOL.inbox} `, "magenta"), seg(`${data.origin}: `, "dim"), seg(quote(text))])
      return
    }
    if (!midTurn) {
      if (this.options.echoPrompts) this.prompt(text)
      return
    }
    const queued = data.delivery === "queue"
    const before = [seg(`${SYMBOL.inbox} `, "magenta"), seg(queued ? "queued: " : "sent: ", "dim")]
    // The message is shortened before the explanation; on a narrow terminal the explanation is the short one.
    const full = queued ? " · the agent will see it after this turn" : " · the agent will see it after the current step"
    const fits = displayWidth(`↳ queued: ${full}`) + 16 <= this.width
    const later = fits ? full : queued ? " · after this turn" : " · after this step"
    const room = Math.max(8, this.width - displayWidth(`↳ ${queued ? "queued: " : "sent: "}${later}`) - 2)
    this.line("info", [...before, seg(`"${truncate(flatten(text), room)}"`), seg(later, "dim")])
  }

  // ---------------------------------------------------------------- turn bookkeeping

  private closeStep(messageId: string, usage: Usage | null): void {
    if (this.openStep === messageId) this.openStep = null
    // Text streamed without a closing `text.ended` (the engine dropped it) still needs its line ended.
    if (this.textBuffers.has(messageId)) {
      this.textBuffers.delete(messageId)
      this.endLine()
    }
    this.reasoningBuffers.delete(messageId)
    this.addUsage(usage)
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

  private setError(kind: string, requestId: string | null = null): void {
    if (this.turn === null) return
    this.turn.lastError = kind
    this.turn.requestId = requestId
  }

  private endTurn(): Turn | null {
    const turn = this.turn
    this.turn = null
    this.executing = false
    this.stop = null
    this.continuing = false
    this.openStep = null
    this.retrying = false
    this.compacting = false
    this.running.clear()
    this.open.clear()
    this.progress.clear()
    this.checking = null
    this.sentBack = 0
    return turn
  }

  private summary(segments: readonly Segment[], turn: Turn | null, more: readonly (readonly Segment[])[] = []): void {
    this.endLine()
    this.line("summary", segments)
    for (const line of more) this.line("summary", line)
    const usage = turn?.usage
    if (usage !== null && usage !== undefined) this.line("summary", [seg(`  ${usageText(usage, this.width - 2)}`, "dim")])
  }

  // ---------------------------------------------------------------- output

  private get width(): number {
    return Math.max(20, this.options.columns())
  }

  private startStream(kind: "text" | "reasoning"): void {
    this.endLine()
    this.gap(kind)
  }

  /** A whole line of a block, cut to the terminal width. */
  private line(kind: Block, segments: readonly Segment[]): void {
    this.endLine()
    this.gap(kind)
    this.writeLine(segments)
  }

  /** A line with one variable-length argument, which is shortened first so the parts around it stay visible. */
  private lineWithArg(kind: Block, before: readonly Segment[], arg: string, after: readonly Segment[]): void {
    const fixed = [...before, ...after].reduce((sum, part) => sum + displayWidth(flatten(part.text)), 0)
    const room = Math.max(8, this.width - fixed)
    this.line(kind, [...before, seg(truncate(arg, room)), ...after])
  }

  private writeLine(segments: readonly Segment[]): void {
    this.raw(`${renderLine(segments, this.width, this.options.color)}\n`)
  }

  private gap(kind: Block): void {
    const previous = this.last
    this.last = kind
    if (previous === null || previous === kind) return
    this.raw("\n")
  }

  private endLine(): void {
    if (!this.atLineStart) this.raw("\n")
  }

  private raw(text: string): void {
    if (text === "") return
    this.clearStatus()
    this.options.write(text)
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) this.lines += 1
    this.atLineStart = text.endsWith("\n")
  }

  // ---------------------------------------------------------------- transient status line (terminals only)

  /** Draws the status line, or redraws it when it changed. Permanent output clears it first (see `raw`). */
  private drawStatus(): void {
    if (this.options.status !== undefined) return this.options.status(this.computeStatus())
    if (!this.options.live) return
    const next = this.atLineStart ? this.computeStatus() : null
    if (this.statusDrawn && next === this.status) return
    this.clearStatus()
    this.status = next
    if (next === null) return
    // Two columns stay free for the terminal's own "^C" echo, so it lands on this line and is cleared with it.
    this.options.write(renderLine([seg(next, "dim")], this.width - 3, this.options.color))
    this.statusDrawn = true
  }

  private clearStatus(): void {
    if (!this.statusDrawn) return
    this.options.write("\r\x1b[2K")
    this.statusDrawn = false
  }

  private computeStatus(): string | null {
    if (!this.executing) return null
    if (this.running.size > 0) {
      const [first] = this.running
      const call = first === undefined ? undefined : this.calls.get(first)
      const progress = first === undefined ? undefined : this.progress.get(first)
      const tail = progress === undefined ? "" : ` · ${progress.split("\n").filter((line) => line.trim() !== "").at(-1) ?? ""}`
      if (this.stop === "shown")
        return `⋯ waiting for ${this.running.size > 1 ? `${this.running.size} tools` : `${call?.name ?? "the tool"} ${call?.arg ?? ""}`.trimEnd()} to stop`
      const what = this.running.size > 1 ? `${this.running.size} tools running` : `running ${call?.name ?? "tool"} ${call?.arg ?? ""}`.trimEnd()
      return `⋯ ${what}${tail}`
    }
    if (this.checking !== null) {
      const tail = this.checking.progress?.split("\n").filter((line) => line.trim() !== "").at(-1)
      const what = this.stop === "shown" ? "waiting for the checks to stop" : `running ${this.checking.names.length === 1 ? "check" : "checks"}: ${this.checking.names.join(", ")}`
      return `⋯ ${what}${tail === undefined || this.stop === "shown" ? "" : ` · ${tail}`}`
    }
    if (this.stop === "shown") return "⋯ stopping"
    if (this.compacting) return "⋯ compacting the conversation"
    if (this.retrying) return "⋯ waiting to retry"
    if (this.openStep !== null) {
      const reasoning = this.reasoningBuffers.get(this.openStep)
      if (reasoning !== undefined && !this.options.showReasoning) return `${SYMBOL.think} thinking`
      return "⋯ working"
    }
    return "⋯ working"
  }
}

/** Every event as one JSON line, and nothing else on stdout. */
export class JsonSink implements Sink {
  constructor(
    private readonly write: (text: string) => void,
    private readonly writeError: (text: string) => void,
  ) {}

  event(event: EngineEvent): void {
    this.write(`${JSON.stringify(event)}\n`)
  }

  notice(text: string): void {
    this.writeError(`${brand.binary}: ${text}\n`)
  }

  interruptRequested(): void {
    this.notice("stopping; press Ctrl-C again to exit now")
  }

  close(): void {}
}

/** Only the final assistant text of each turn on stdout; failures on stderr. */
export class QuietSink implements Sink {
  private readonly texts = new Map<string, string[]>()
  private lastMessage: string | null = null
  private requestId: string | null = null

  constructor(
    private readonly write: (text: string) => void,
    private readonly writeError: (text: string) => void,
  ) {}

  event(event: EngineEvent): void {
    switch (event.type) {
      case "execution.started":
        this.texts.clear()
        this.lastMessage = null
        this.requestId = null
        return
      case "text.ended": {
        if (event.data.text === "") return
        const id = event.data.messageId
        this.texts.set(id, [...(this.texts.get(id) ?? []), event.data.text])
        this.lastMessage = id
        return
      }
      case "execution.succeeded": {
        const text = this.lastMessage === null ? "" : (this.texts.get(this.lastMessage) ?? []).join("\n")
        if (text !== "") this.write(text.endsWith("\n") ? text : `${text}\n`)
        // The answer alone would read as "done"; that the checks still fail goes where failures go.
        const verification = event.data.verification
        if (verification.status === "unresolved")
          this.writeError(`${brand.binary}: stopped with failing checks: ${verification.failing.join(", ")} (${unresolvedReason(verification)})\n`)
        return
      }
      case "step.failed":
        if (event.data.error.kind === "provider") this.requestId = event.data.error.error.requestId
        return
      case "retry.scheduled":
        this.requestId = event.data.error.requestId
        return
      case "execution.failed": {
        const requestId = this.requestId === null ? "" : ` (request ${this.requestId})`
        this.writeError(`${brand.binary}: failed: ${event.data.message}${requestId}\n`)
        return
      }
      case "execution.interrupted":
        if (event.data.reason === "user") this.writeError(`${brand.binary}: interrupted\n`)
        return
    }
  }

  notice(text: string): void {
    this.writeError(`${brand.binary}: ${text}\n`)
  }

  interruptRequested(): void {
    this.notice("stopping; press Ctrl-C again to exit now")
  }

  close(): void {}
}

// ---------------------------------------------------------------- helpers

function key(messageId: string, callId: string) {
  return `${messageId}\u0000${callId}`
}

function describeOutcome(name: string, data: EventData<"tool.settled">): { symbol: string; tone: Tone; text: string; short?: string } {
  switch (data.outcome) {
    case "success":
      return { symbol: SYMBOL.ok, tone: "green", text: successSummary(name, data) }
    case "error":
      return { symbol: SYMBOL.fail, tone: "red", text: errorSummary(name, data) }
    case "not_started":
      return { symbol: SYMBOL.notRun, tone: "yellow", text: "not run · stopped before it started", short: "not run" }
    case "effect_unknown":
      return { symbol: SYMBOL.unknown, tone: "yellow", text: "outcome unknown · it may have taken effect", short: "outcome unknown" }
  }
}

/** In the compact form the summary follows the symbol directly; with no summary the duration does. */
function trimLeadingDot(tail: readonly Segment[], text: string): Segment[] {
  if (text !== "") return [...tail]
  return tail.map((part) => (part.text.startsWith(" · ") ? { ...part, text: part.text.slice(3) } : part))
}

function suffix(parts: readonly (string | null)[]): string {
  const present = parts.filter((part): part is string => part !== null && part !== "")
  return present.length === 0 ? "" : ` · ${present.join(" · ")}`
}

/** The token line of a turn; when `width` is too small for it, the short form without the cached and reasoning counts. */
export function usageText(usage: Usage, width = Number.POSITIVE_INFINITY): string {
  const n = (value: number) => value.toLocaleString("en-US")
  const share = usage.inputTokens === 0 ? 0 : Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
  const reasoning = usage.reasoningTokens > 0 ? ` (${n(usage.reasoningTokens)} reasoning)` : ""
  const full = `tokens · ${n(usage.inputTokens)} in · ${n(usage.cachedInputTokens)} cached (${share}%) · ${n(usage.outputTokens)} out${reasoning}`
  return displayWidth(full) <= width ? full : `tokens · ${n(usage.inputTokens)} in · ${share}% cached · ${n(usage.outputTokens)} out`
}

function errorLabel(error: ProviderError): string {
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
  return error.status === null ? labels[error.kind] : `${labels[error.kind]} (${error.status})`
}

function errorClass(error: StepError): string {
  switch (error.kind) {
    case "provider":
      return error.error.kind
    case "interrupted":
      return "interrupted"
    case "crashed":
      return "crashed"
    case "internal":
      return "internal"
  }
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

/** An instruction source key as a person reads it: `agents:<path>` is the file. */
function sourceLabel(source: string): string {
  return source.startsWith("agents:") ? source.slice("agents:".length) : source
}

/** The part of a text block that is printed: leading blank lines and spaces are not. */
function shown(text: string): string {
  return text.replace(/^\s+/, "")
}

function quote(text: string): string {
  return `"${flatten(text)}"`
}

/** Model text is printed as is, except escape sequences and other control characters a terminal would act on. */
function sanitize(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}
