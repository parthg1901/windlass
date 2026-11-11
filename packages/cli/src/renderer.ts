/**
 * Turns a session's event stream into terminal output, one event at a time.
 *
 * Three sinks share one interface:
 * - `PrettyRenderer`: what a person watches. Streamed text as it arrives, one
 *   line per tool call start and outcome, one short line per notable event.
 * - `JsonSink`: every event as one JSON line, nothing else on stdout.
 * - `QuietSink`: only the final assistant text of each turn, for pipelines.
 */
import { type EventData, type ProviderError, type StepError, type Usage } from "@light-harness/core"
import { brand } from "./brand.ts"
import type { EngineEvent } from "./engine.ts"
import { callArgument, detailLines, errorSummary, successSummary } from "./tools.ts"
import { type Segment, type Tone, displayWidth, flatten, formatDuration, paint, plural, renderLine, seg, truncate } from "./text.ts"

export interface Sink {
  event(event: EngineEvent): void
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
  refused: "⊘",
  compact: "⇣",
  note: "·",
  prompt: "›",
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
  private status: string | null = null
  private statusDrawn = false

  constructor(private readonly options: PrettyOptions) {}

  event(event: EngineEvent): void {
    this.handle(event)
    this.drawStatus()
  }

  notice(text: string, tone: "info" | "warn" | "error" = "info"): void {
    this.line("info", [seg(text, tone === "error" ? "red" : tone === "warn" ? "yellow" : "dim")])
    this.drawStatus()
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
        this.line("info", [
          seg(`${SYMBOL.retry} `, "yellow"),
          seg(`retrying in ${formatDuration(event.data.delayMs)} (attempt ${event.data.attempt})`, "yellow"),
          seg(` · ${errorLabel(error)}: ${error.message}`, "dim"),
        ])
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
        this.setError(errorClass(event.data.error))
        this.line("info", [seg(`${SYMBOL.fail} `, "red"), seg(`compaction failed: ${stepErrorText(event.data.error)}`, "red")])
        return
      case "synthetic.appended":
        return this.syntheticAppended(event.data.origin)
      case "instruction.appended":
        this.line("info", [seg(`${SYMBOL.note} instructions updated (${event.data.source}): `, "dim"), seg(flatten(event.data.text), "dim")])
        return
      case "inbox.enqueued":
        return this.enqueued(event.data)
      case "inbox.delivered": {
        const item = this.inbox.get(event.data.messageId)
        this.inbox.delete(event.data.messageId)
        if (item === undefined || !item.midTurn) return
        this.line("info", [seg(`${SYMBOL.inbox} `, "magenta"), seg(`delivered ${item.delivery === "queue" ? "queued message" : "steer"}: `, "dim"), seg(quote(item.text))])
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
        const what = event.data.delivery === "queue" ? "now queued until the turn ends" : "now steering at the next step"
        this.line("info", [seg(`${SYMBOL.inbox} ${what}: `, "dim"), seg(quote(item?.text ?? event.data.messageId), "dim")])
        return
      }
      case "execution.started":
        this.executing = true
        this.cutOff = null
        this.turn = { start: event.time, steps: 0, usage: null, lastError: null }
        return
      case "execution.resumed": {
        const count = (this.resumes.get(event.data.executionId) ?? 0) + 1
        this.resumes.set(event.data.executionId, count)
        this.executing = true
        this.turn ??= { start: event.time, steps: 0, usage: null, lastError: null }
        const why =
          this.cutOff === "crash" ? "after the previous process stopped unexpectedly" : this.cutOff === "shutdown" ? "after a shutdown" : "an unfinished turn"
        this.cutOff = null
        this.line("info", [seg(`${SYMBOL.retry} `, "cyan"), seg(`resuming ${why}`), seg(count > 1 ? ` (resume ${count})` : "", "dim")])
        return
      }
      case "execution.succeeded": {
        const turn = this.endTurn()
        const parts = [turn === null ? null : plural(turn.steps, "step"), turn === null ? null : formatDuration(event.time - turn.start)]
        this.summary([seg(`${SYMBOL.ok} `, "green"), seg("done", ["green", "bold"]), seg(suffix(parts), "dim")], turn)
        return
      }
      case "execution.failed": {
        const turn = this.endTurn()
        const kind = turn?.lastError
        const head = [seg(`${SYMBOL.fail} `, "red"), seg(kind === null || kind === undefined ? "failed" : `failed (${kind})`, ["red", "bold"])]
        const message = flatten(event.data.message)
        // The reason a turn failed is never cut: it moves to its own wrapped lines when it does not fit.
        if (displayWidth(`✗ failed (${kind ?? ""}): ${message}`) <= this.width) this.summary([...head, seg(`: ${message}`, "red")], turn)
        else this.summary(head, turn, wrap(message, this.width - 2).map((line) => [seg(`  ${line}`, "red")]))
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
        this.summary([seg(`${SYMBOL.stop} `, "yellow"), seg("interrupted", ["yellow", "bold"]), seg(suffix([time]), "dim")], turn)
        return
      }
      case "history.reverted":
        this.line("info", [seg(`${SYMBOL.note} history rewound`, "dim")])
        return
      case "session.created":
      case "session.renamed":
      case "session.archived":
      case "session.unarchived":
      case "baseline.set":
        return
    }
  }

  private textDelta(messageId: string, text: string): void {
    const clean = sanitize(text)
    if (clean === "") return
    const buffer = this.textBuffers.get(messageId) ?? ""
    if (buffer === "") this.startStream("text")
    this.raw(clean)
    this.textBuffers.set(messageId, buffer + clean)
  }

  private textEnded(messageId: string, text: string): void {
    const clean = sanitize(text)
    const buffer = this.textBuffers.get(messageId) ?? ""
    this.textBuffers.delete(messageId)
    if (buffer === "") {
      if (clean.trim() === "") return
      this.startStream("text")
      this.raw(clean)
    } else if (clean.startsWith(buffer)) this.raw(clean.slice(buffer.length))
    else {
      // The final text is not what was streamed; show the final one in full rather than a broken mix.
      this.endLine()
      this.raw(clean)
    }
    this.endLine()
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
    const outcome = describeOutcome(call.name, data)
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
        this.setError(error.error.kind)
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

  private syntheticAppended(origin: string): void {
    switch (origin) {
      case "interrupt":
        return
      case "output_limit":
        this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("the response hit the output limit"), seg(" · asking the model to continue", "dim")])
        return
      case "empty_response":
        this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("the model returned an empty response"), seg(" · nudging it once", "dim")])
        return
      case "step_limit":
        this.line("info", [seg(`${SYMBOL.unknown} `, "yellow"), seg("step limit reached"), seg(" · asking for a final answer without tools", "dim")])
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
    const when = data.delivery === "queue" ? "queued: " : "steer: "
    const later = data.delivery === "queue" ? " · runs when this turn is done" : " · delivered at the next step"
    this.line("info", [seg(`${SYMBOL.inbox} `, "magenta"), seg(when, "dim"), seg(quote(text)), seg(later, "dim")])
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

  private setError(kind: string): void {
    if (this.turn !== null) this.turn.lastError = kind
  }

  private endTurn(): Turn | null {
    const turn = this.turn
    this.turn = null
    this.executing = false
    this.openStep = null
    this.retrying = false
    this.compacting = false
    this.running.clear()
    this.open.clear()
    this.progress.clear()
    return turn
  }

  private summary(segments: readonly Segment[], turn: Turn | null, more: readonly (readonly Segment[])[] = []): void {
    this.endLine()
    this.line("summary", segments)
    for (const line of more) this.line("summary", line)
    const usage = turn?.usage
    if (usage !== null && usage !== undefined) this.line("summary", [seg(`  ${usageText(usage)}`, "dim")])
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
    if (!this.options.live) return
    const next = this.atLineStart ? this.computeStatus() : null
    if (this.statusDrawn && next === this.status) return
    this.clearStatus()
    this.status = next
    if (next === null) return
    this.options.write(renderLine([seg(next, "dim")], this.width - 1, this.options.color))
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
      const what = this.running.size > 1 ? `${this.running.size} tools running` : `running ${call?.name ?? "tool"} ${call?.arg ?? ""}`.trimEnd()
      return `⋯ ${what}${tail}`
    }
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

  close(): void {}
}

/** Only the final assistant text of each turn on stdout; failures on stderr. */
export class QuietSink implements Sink {
  private readonly texts = new Map<string, string[]>()
  private lastMessage: string | null = null

  constructor(
    private readonly write: (text: string) => void,
    private readonly writeError: (text: string) => void,
  ) {}

  event(event: EngineEvent): void {
    switch (event.type) {
      case "execution.started":
        this.texts.clear()
        this.lastMessage = null
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
        return
      }
      case "execution.failed":
        this.writeError(`${brand.binary}: failed: ${event.data.message}\n`)
        return
      case "execution.interrupted":
        if (event.data.reason === "user") this.writeError(`${brand.binary}: interrupted\n`)
        return
    }
  }

  notice(text: string): void {
    this.writeError(`${brand.binary}: ${text}\n`)
  }

  close(): void {}
}

// ---------------------------------------------------------------- helpers

function key(messageId: string, callId: string) {
  return `${messageId}\u0000${callId}`
}

function describeOutcome(name: string, data: EventData<"tool.settled">): { symbol: string; tone: Tone; text: string } {
  switch (data.outcome) {
    case "success":
      return { symbol: SYMBOL.ok, tone: "green", text: successSummary(name, data) }
    case "error":
      return { symbol: SYMBOL.fail, tone: "red", text: errorSummary(name, data) }
    case "not_started":
      return { symbol: SYMBOL.notRun, tone: "yellow", text: "not run · stopped before it started" }
    case "effect_unknown":
      return { symbol: SYMBOL.unknown, tone: "yellow", text: "outcome unknown · it may have taken effect" }
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

export function usageText(usage: Usage): string {
  const n = (value: number) => value.toLocaleString("en-US")
  const share = usage.inputTokens === 0 ? 0 : Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
  const reasoning = usage.reasoningTokens > 0 ? ` (${n(usage.reasoningTokens)} reasoning)` : ""
  return `tokens · ${n(usage.inputTokens)} in · ${n(usage.cachedInputTokens)} cached (${share}%) · ${n(usage.outputTokens)} out${reasoning}`
}

function errorLabel(error: ProviderError): string {
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

/** Word-wraps one line of text to `width` columns; a word longer than a line is cut. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let current = ""
  for (const word of text.split(" ")) {
    const next = current === "" ? word : `${current} ${word}`
    if (displayWidth(next) <= width) current = next
    else {
      if (current !== "") out.push(current)
      current = truncate(word, width)
    }
  }
  if (current !== "") out.push(current)
  return out
}

function quote(text: string): string {
  return `"${flatten(text)}"`
}

/** Model text is printed as is, except escape sequences and other control characters a terminal would act on. */
function sanitize(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}
