/**
 * Turns a session's event stream into terminal output, one event at a time.
 *
 * Three sinks share one interface:
 * - `PrettyRenderer`: what a person watches. Streamed text as it arrives, one
 *   line per tool call start and outcome, one short line per notable event.
 * - `JsonSink`: every event as one JSON line, nothing else on stdout.
 * - `QuietSink`: only the final assistant text of each turn, for pipelines.
 */
import { type EventData, type ProviderError, type SessionSettings, type StepError, type Usage, type VerificationOutcome, brand, describeNeed } from "@light-harness/core"
import type { EngineEvent } from "./engine.ts"
import type { DiffFile } from "@light-harness/acp/extensions"
import { callArgument, checkLines, checksSummary, detailLines, errorSummary, fileList, successSummary, unresolvedReason } from "./tools.ts"
import { type Segment, type Tone, displayWidth, flatten, formatBytes, formatDuration, hardWrap, paint, plural, renderLine, seg, truncate, wrap } from "./text.ts"

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

/** The two ways on after a run stopped for an approval nobody could give (`--unattended stop`), in the user guide's words. */
export const STOPPED_FOR_APPROVAL = `To go on, run it interactively (\`${brand.binary} -i "<prompt>"\`, or \`${brand.binary}\` with no prompt) and answer the question when it comes, or choose what such a call becomes when nobody can answer: --unattended deny (the call is refused, the agent is told and carries on) or another --approval mode.`

/** The rows of a subagent's answer shown under its call; the agent reads all of it. */
const SUBAGENT_ANSWER_ROWS = 3

/** A prompt echoed in more rows than this is shown as its first `PROMPT_HEAD` rows and a count. */
const PROMPT_ROWS = 12
const PROMPT_HEAD = 6

interface Call {
  readonly name: string
  readonly arg: string
  startedAt: number | null
  /** The line count right after this call's start line; equal at settle time means nothing came in between. */
  after: number
  /** How a command ran (`tool.started`'s `run.sandbox`): in the sandbox with what extra access, `null` without it; absent when not recorded. */
  sandbox?: { readonly network: boolean; readonly writableRoots: readonly string[] } | null
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
  /** The compaction in progress: the size it started from, and whether the model was asked to fix its summary. */
  private compacting: { readonly tokensBefore: number; repairing: boolean } | null = null
  private retrying = false
  /** How the previous process left the current execution, for the resume line. */
  private cutOff: "crash" | "shutdown" | null = null
  private settings: SessionSettings | null = null
  /** The instruction files of the latest baseline, so an unchanged list is not shown again. */
  private instructionFiles = ""
  /** The stop of the running execution: asked for by this CLI (with the exit hint pending), shown, or neither. */
  private stop: "hint" | "shown" | null = null
  /** The call whose approval question waits for the user's answer. */
  private asking: string | null = null
  /** The next text block continues a response that a provider error cut off. */
  private continuing = false
  private status: string | null = null
  private statusDrawn = false
  /** The run of checks in progress: which checks, and the latest progress text of the one that is running. */
  private checking: { readonly names: readonly string[]; readonly startedAt: number; progress: string | null } | null = null
  /** A failing run was reported to the model and its next step has not started: the line that says so is still owed. */
  private sentBack = 0
  /**
   * The spawned work that is running, by its ID: a subagent (with what was
   * seen of it so far: its task, its steps and its tool calls) or a
   * background command. A child's tool calls are one indented line each when
   * they settle; its steps are counted, in the status line and on the line
   * that ends it.
   */
  private readonly spawned = new Map<
    string,
    { readonly kind: "subagent" | "command"; readonly label: string; readonly startedAt: number; title: string | null; steps: number; tools: number; asking: boolean; readonly calls: Map<string, { readonly name: string; readonly arg: string }> }
  >()

  constructor(private readonly options: PrettyOptions) {}

  event(event: EngineEvent): void {
    this.handle(event)
    this.drawStatus()
  }

  /** A line from the CLI itself: never cut, wrapped under itself when it does not fit. */
  notice(text: string, tone: "info" | "warn" | "error" = "info"): void {
    const color = tone === "error" ? "red" : tone === "warn" ? "yellow" : "dim"
    const lead = text.slice(0, text.length - text.trimStart().length)
    const [first = "", ...rest] = wrap(text, this.width)
    this.line("info", [seg(first, color)])
    for (const line of wrap(rest.join(" "), this.width - lead.length - 2)) this.line("info", [seg(`${lead}  ${line}`, color)])
    this.drawStatus()
  }

  /** `/diff`: each file with its status and line counts, then its patch with added and removed lines coloured. */
  diff(files: readonly DiffFile[]): void {
    for (const file of files) {
      const status = file.status === "modified" ? "" : ` · ${file.status.replace(/_/g, " ")}`
      this.line("info", [seg(file.path, "bold"), seg(`${status}${file.binary || file.patch === null ? "" : ` · +${file.added} -${file.removed}`}`, "dim")])
      if (file.binary) this.line("info", [seg("  binary file: no diff shown", "dim")])
      else if (file.omitted) this.line("info", [seg("  not shown: the turn's diff is too large", "dim")])
      for (const text of (file.patch ?? "").split("\n")) {
        if (text === "" || /^(diff --git |index |new file mode |deleted file mode )/.test(text)) continue
        const tone = text.startsWith("+++") || text.startsWith("---") ? "dim" : text.startsWith("+") ? "green" : text.startsWith("-") ? "red" : text.startsWith("@@") ? "cyan" : "dim"
        // A diff is never reflowed: its spaces are the indentation it shows.
        for (const line of hardWrap(sanitize(text), this.width - 2)) this.line("info", [seg(`  ${line}`, tone)])
      }
      if (file.truncated) this.line("info", [seg("  … cut: the change is larger than the per-file limit", "dim")])
    }
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

  /** Echoes a prompt as if typed: `› text`. A long one (a large paste) is its first lines and a count of the rest. */
  prompt(text: string): void {
    this.endLine()
    this.gap("prompt")
    const source = text.split("\n")
    const lines: string[] = []
    // Wrapped only as far as is shown: a 100 KB paste is not laid out to be thrown away.
    for (const line of source) {
      if (lines.length > PROMPT_ROWS) break
      lines.push(...wrap(flatten(line), this.width - 2))
    }
    const cut = lines.length > PROMPT_ROWS
    const shown = cut ? lines.slice(0, PROMPT_HEAD) : lines
    shown.forEach((line, index) => this.writeLine([seg(index === 0 ? `${SYMBOL.prompt} ` : "  ", "dim"), seg(line, "bold")]))
    if (cut) this.writeLine([seg(`  … ${plural(source.length, "line")}, ${formatBytes(new TextEncoder().encode(text).length)} in all; the agent gets all of it`, "dim")])
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
      case "child.event":
        return this.childEvent(event.spawnId, event.title, event.event)
      case "spawn.started": {
        const work = event.data.work
        const where = [...(event.data.background ? ["in the background"] : []), ...(work.kind === "subagent" && work.worktree !== null ? ["in its own worktree"] : [])]
        if (work.kind === "subagent") {
          const label = `subagent ${shortId(work.sessionId)}`
          this.spawned.set(event.data.spawnId, { kind: "subagent", label, startedAt: event.time, title: null, steps: 0, tools: 0, asking: false, calls: new Map() })
          this.line("info", [seg(`  ${SYMBOL.call} `, "cyan"), seg(label, "bold"), seg(` started${where.length === 0 ? "" : ` ${where.join(", ")}`}`, "dim")])
        } else {
          const label = `background ${event.data.spawnId}`
          this.spawned.set(event.data.spawnId, { kind: "command", label, startedAt: event.time, title: null, steps: 0, tools: 0, asking: false, calls: new Map() })
          this.lineWithArg("info", [seg(`  ${SYMBOL.call} `, "cyan"), seg(label, "bold"), seg(" · ", "dim")], flatten(work.command), [])
        }
        return
      }
      case "spawn.ended": {
        const known = this.spawned.get(event.data.spawnId)
        this.spawned.delete(event.data.spawnId)
        const { outcome, merge } = event.data
        const label = known?.label ?? `background work ${event.data.spawnId}`
        const failed = outcome === "failed" || (known?.kind === "command" && outcome === "completed" && event.data.exitCode !== 0)
        const [symbol, tone] = outcome === "completed" ? (failed ? [SYMBOL.fail, "red" as const] : [SYMBOL.ok, "green" as const]) : outcome === "failed" ? [SYMBOL.fail, "red" as const] : outcome === "stopped" ? [SYMBOL.stop, "yellow" as const] : [SYMBOL.unknown, "yellow" as const]
        const word = known?.kind === "command" ? (outcome === "completed" ? `exited with code ${event.data.exitCode}` : outcome) : outcome === "completed" ? "finished" : outcome
        const counted = known?.kind === "subagent" && known.steps + known.tools > 0 ? `${plural(known.steps, "step")}, ${plural(known.tools, "tool call")}` : null
        const tokens = event.data.usage === null ? null : `${compactTokens(event.data.usage.inputTokens + event.data.usage.outputTokens)} tokens`
        const took = known === undefined ? null : formatDuration(event.time - known.startedAt)
        this.line("info", [seg(`  ${symbol} `, tone), seg(label, "bold"), seg(` ${word}`, failed ? "red" : undefined), seg(suffix([counted, tokens, took]), "dim")])
        // Why, when it did not simply finish; and what became of its worktree.
        if (outcome !== "completed" && known?.kind !== "command") for (const line of wrap(flatten(event.data.detail), this.width - 4)) this.line("info", [seg(`    ${line}`, "dim")])
        if (merge !== null) {
          if (merge.status === "merged") this.lineWithArg("info", [seg(`    merged ${plural(merge.files.length, "file")} into the workspace: `, "dim")], fileList(merge.files, 4), [])
          else if (merge.status === "conflicts") {
            this.lineWithArg("info", [seg(`    ${SYMBOL.unknown} not merged, conflicts in: `, "yellow")], fileList(merge.conflicts, 4), [])
            this.uncut("info", `    its work is on branch ${merge.branch}; nothing was changed in the workspace`, "dim")
          } else if (merge.kept) this.uncut("info", `    not merged; its work is on branch ${merge.branch}`, "dim")
        }
        if (event.data.tainted) this.line("info", [seg(`    ${SYMBOL.unknown} its result may carry untrusted content`, "yellow")])
        return
      }
      case "replay.call":
        return
      case "replay.diverged":
        this.line("info", [seg(`${SYMBOL.note} replay left its recording (${event.data.divergence.replaceAll("_", " ")}) · continuing in a copy`, "dim")])
        this.uncut("info", `  ${event.data.workspace}`, "dim")
        return
      case "replay.ended": {
        const outcome = event.data.outcome
        this.line("info", [seg(`${outcome === "identical" ? SYMBOL.ok : outcome === "diverged" ? SYMBOL.unknown : SYMBOL.fail} `, outcome === "identical" ? "green" : outcome === "diverged" ? "yellow" : "red"), seg(`replay ${outcome}`), seg(` · ${flatten(event.data.reason)}`, "dim")])
        return
      }
      case "workspace.changes":
        // The files this turn changed, right before its outcome line.
        this.lineWithArg("info", [seg(`${SYMBOL.note} changed ${plural(event.files.length, "file")}: `, "dim")], fileList(event.files, 6), [])
        return
      case "diagnostic": {
        // Something is wrong with the harness itself. It is said in full: this is what a bug report quotes.
        const what = event.kind === "prefix_violation" ? "prompt cache" : event.kind.replace(/_/g, " ")
        return this.headed(what, [flatten(event.message)])
      }
      case "notice": {
        const what = event.kind === "sandbox_unavailable" ? "no sandbox" : event.kind === "approval_ignored" ? "project setting not followed" : "checks not run"
        return this.headed(what, event.message.split("\n").map(flatten))
      }
      case "approval.requested": {
        // The question, in full: what would run and what each answer means. The choices are asked for at the prompt.
        const question = event.data.question
        this.asking = key(event.data.messageId, event.data.callId)
        this.line("info", [seg("? ", ["yellow", "bold"]), seg(flatten(question.title), "bold")])
        for (const part of question.subject.split("\n")) for (const line of hardWrap(sanitize(part), this.width - 4)) this.line("info", [seg(`    ${line}`)])
        for (const detail of question.details) for (const line of wrap(flatten(detail), this.width - 2)) this.line("info", [seg(`  ${line}`, "dim")])
        for (const choice of question.choices)
          if (choice.remembers !== null) for (const line of wrap(`${choice.label} remembers ${flatten(choice.remembers)}`, this.width - 2)) this.line("info", [seg(`  ${line}`, "dim")])
        this.drawStatus()
        return
      }
      case "approval.answered": {
        this.asking = null
        const note = event.data.note === null ? "" : ` · your note: ${flatten(event.data.note)}`
        const kept = event.data.grants.length === 0 ? "" : event.data.choice === "project" ? ", remembered for this project" : ", remembered for this session"
        if (event.data.approve) this.line("info", [seg(`${SYMBOL.ok} `, "green"), seg(`allowed${event.data.choice === "once" ? " once" : kept}${note}`, "dim")])
        else this.line("info", [seg(`${SYMBOL.notRun} `, "yellow"), seg(`not allowed${note}`, "dim")])
        this.drawStatus()
        return
      }
      case "approval.denied": {
        // Refused without a question. An unattended run says so: nothing waited, and this is what became of the call.
        const needs = event.data.needs.map(describeNeed)
        const why =
          event.data.reason === "unattended"
            ? `needs approval for ${needs.join(", ")}; nobody is here to give it, so it was refused${event.data.stop ? " and the run ends (--unattended stop)" : " (--unattended deny)"}`
            : "refused by the approval policy"
        wrap(`not run: ${why}`, this.width - 2).forEach((line, index) => this.line("info", [seg(index === 0 ? `${SYMBOL.notRun} ` : "  ", "yellow"), seg(line, "yellow")]))
        return
      }
      case "taint.noticed":
        this.line("info", [seg(`${SYMBOL.unknown} untrusted content: `, "yellow")])
        for (const line of wrap(`${flatten(event.data.text)} From here on, anything that can send data out asks again, and earlier approvals for it no longer apply. /clear-taint says you trust what is there.`, this.width - 2))
          this.line("info", [seg(`  ${line}`, "yellow")])
        return
      case "taint.cleared":
        this.line("info", [seg(`${SYMBOL.note} the conversation is trusted again (/clear-taint)`, "dim")])
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
        if (event.data.run !== undefined) this.calls.get(id)!.sandbox = event.data.run.sandbox
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
        this.compacting = { tokensBefore: event.data.tokensBefore, repairing: false }
        return
      case "compaction.repair_requested":
        if (this.compacting !== null) this.compacting.repairing = true
        return
      case "compaction.ended": {
        const before = this.compacting?.tokensBefore ?? 0
        this.compacting = null
        this.addUsage(event.data.usage)
        // The sizes are the harness's estimates of the next request, before and after.
        const sizes = before > 0 && event.data.tokensAfter > 0 ? ` · about ${count(before)} → ${count(event.data.tokensAfter)} tokens` : ""
        if (event.data.source === "fallback") {
          // No summary could be had. The session carries on; the user is told what the model now works from.
          this.line("info", [seg(`${SYMBOL.compact} `, "yellow"), seg("compacted the conversation without a summary", "yellow"), seg(sizes, "dim")])
          for (const line of wrap(`Why: ${event.data.detail ?? "the model produced no usable summary"}.`, this.width - 2)) this.line("info", [seg(`  ${line}`, "yellow")])
          for (const line of wrap("The model continues from a list of the files, commands and errors so far and your own messages, and can search the full conversation.", this.width - 2))
            this.line("info", [seg(`  ${line}`, "dim")])
          return
        }
        this.line("info", [seg(`${SYMBOL.compact} `, "cyan"), seg("compacted the conversation"), seg(sizes, "dim")])
        for (const line of wrap("Earlier messages are now a checkpoint; the model can still search them.", this.width - 2)) this.line("info", [seg(`  ${line}`, "dim")])
        if (event.data.detail !== null) for (const line of wrap(`Note: ${event.data.detail}.`, this.width - 2)) this.line("info", [seg(`  ${line}`, "dim")])
        return
      }
      case "compaction.failed":
        this.compacting = null
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
      case "turn.ended": {
        // The turn before a queued message is over. What it rests on is said as it would be at the end of the
        // execution, when that is worth a line: checks that passed, or failing ones that were left as they are.
        const verification = event.data.verification
        const next = seg(" · on to the queued message", "dim")
        if (verification.status === "passed") this.line("info", [seg(`${SYMBOL.ok} `, "green"), seg("checks passed", "green"), next])
        if (verification.status === "unresolved") {
          this.line("info", [seg(`${SYMBOL.fail} `, "red"), seg("failing checks left unresolved", ["red", "bold"]), seg(`: ${verification.failing.join(", ")}`, "red"), next])
          for (const line of wrap(unresolvedReason(verification), this.width - 2)) this.line("info", [seg(`  ${line}`, "yellow")])
        }
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
        // Not a failure of the work: a call needed an approval nobody could give, and the run was not to go on without it.
        if (event.data.cause === "approval") {
          const time = turn === null ? null : formatDuration(event.time - turn.start)
          const head = [seg(`${SYMBOL.stop} `, "yellow"), seg("stopped for your approval", ["yellow", "bold"]), seg(suffix([turn === null ? null : plural(turn.steps, "step"), time]), "dim")]
          const why = wrap(`A tool call needed your approval and nobody was here to give it (--unattended stop). ${STOPPED_FOR_APPROVAL}`, this.width - 2)
          this.summary(head, turn, why.map((line) => [seg(`  ${line}`, "dim")]))
          return
        }
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
          if (detail.output !== null) this.pathLines("    full output:", detail.output)
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
    // A subagent's answer is prose, said in a few whole lines under its row; its task was said when it started.
    if (call.name === "subagent" && data.outcome === "success" && data.output.trim() !== "") {
      this.line("info", [seg("  "), seg(`${SYMBOL.ok} `, "green"), seg("subagent", "bold"), seg(" answered", undefined), seg(suffix([duration]), "dim")])
      // The reference line the harness adds for the model (`[subagent ses_…: finished after …]`) repeats the line above.
      const answer = data.output.replace(/\n*\[subagent [^\]\n]*\]\s*$/, "")
      for (const line of excerpt(answer, this.width - 4, SUBAGENT_ANSWER_ROWS)) this.line("info", [seg(`    ${line}`, "dim")])
      return
    }
    const described = describeOutcome(call.name, data)
    // On a narrow terminal the loop-decided outcomes drop their explanation before the call's argument is cut short.
    const room = this.width - displayWidth(`  ✓ ${call.name} · ${described.text}${suffix([duration])}`)
    const outcome = !adjacent && room < 16 && described.short !== undefined ? { ...described, text: described.short } : described
    const head: Segment[] = [seg("  "), seg(`${outcome.symbol} `, outcome.tone)]
    const tail: Segment[] = [seg(outcome.text === "" ? "" : outcome.text, outcome.tone === "green" ? undefined : outcome.tone), ...sandboxMark(call), seg(suffix([duration]), "dim")]
    if (adjacent) this.line("info", [...head, ...trimLeadingDot(tail, outcome.text)])
    else this.lineWithArg("info", [...head, seg(call.name, "bold"), seg(call.arg === "" ? "" : " ")], call.arg, [seg(" · ", "dim"), ...tail])
    for (const detail of detailLines(call.name, data)) this.line("info", [seg(`    ${detail}`, "dim")])
    if (data.truncation !== null) {
      const spill = data.truncation.spillPath
      if (spill === null) this.line("info", [seg(`    output capped · ${plural(data.truncation.originalLines, "line")} in full`, "dim")])
      else this.pathLines(`    output capped · ${plural(data.truncation.originalLines, "line")} in full:`, spill)
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

  /**
   * A warning with a heading: `⚠ <what>: <first line>`, wrapped under itself,
   * then the other lines indented. Blank lines are left out.
   */
  private headed(what: string, parts: readonly string[]): void {
    const [first = "", ...rest] = parts.map((part) => part.trim()).filter((part) => part !== "")
    wrap(`${what}: ${first}`.trimEnd(), this.width - 2).forEach((line, index) => this.line("info", [seg(index === 0 ? `${SYMBOL.unknown} ` : "  ", "yellow"), seg(line, "yellow")]))
    for (const part of rest) for (const line of wrap(part, this.width - 2)) this.line("info", [seg(`  ${line}`, "yellow")])
  }

  /**
   * Something happened in a subagent. Compactly, indented under the call
   * that started it: the task once, each tool call in one line when it
   * settles (`↳ subagent 1a2b ✓ read a.txt · 12 lines`), and a question it
   * asks in full, since it waits for the user. Its steps are a running count
   * in the status line and on the line that ends it.
   */
  private childEvent(spawnId: string, title: string, event: EngineEvent): void {
    const child = this.spawned.get(spawnId)
    if (child === undefined) return
    if (child.title === null) {
      child.title = title
      this.lineWithArg("info", [seg(`    ${child.label}: `, "dim")], flatten(title), [])
    }
    if (event.type === "step.ended") child.steps += 1
    if (event.type === "tool.called") {
      child.tools += 1
      child.calls.set(key(event.data.messageId, event.data.callId), { name: event.data.name, arg: flatten(callArgument(event.data.name, event.data.input)) })
    }
    if (event.type === "tool.settled") {
      const id = key(event.data.messageId, event.data.callId)
      const call = child.calls.get(id) ?? { name: "tool", arg: "" }
      child.calls.delete(id)
      const outcome = describeOutcome(call.name, event.data)
      this.lineWithArg(
        "info",
        [seg(`    ${SYMBOL.inbox} ${child.label} `, "dim"), seg(`${outcome.symbol} `, outcome.tone), seg(call.name, "bold"), seg(call.arg === "" ? "" : " ")],
        call.arg,
        outcome.text === "" ? [] : [seg(" · ", "dim"), seg(outcome.text, outcome.tone === "green" ? "dim" : outcome.tone)],
      )
    }
    if (event.type === "approval.requested") {
      child.asking = true
      // A question waits for the user: said in full (what would run, what each answer remembers), wrapped, never cut.
      const question = event.data.question
      wrap(`? ${child.label} asks: ${flatten(question.title)}`, this.width - 6).forEach((line, index) => this.line("info", [seg(`    ${index === 0 ? "" : "  "}${line}`, ["yellow", "bold"])]))
      for (const part of question.subject.split("\n")) for (const line of hardWrap(sanitize(part), this.width - 8)) this.line("info", [seg(`        ${line}`)])
      for (const detail of question.details) for (const line of wrap(flatten(detail), this.width - 6)) this.line("info", [seg(`      ${line}`, "dim")])
      for (const choice of question.choices)
        if (choice.remembers !== null) for (const line of wrap(`${choice.label} remembers ${flatten(choice.remembers)}`, this.width - 6)) this.line("info", [seg(`      ${line}`, "dim")])
    }
    if (event.type === "approval.answered") {
      const note = event.data.note === null ? "" : ` · your note: ${flatten(event.data.note)}`
      this.line("info", [seg(`    ${event.data.approve ? SYMBOL.ok : SYMBOL.notRun} `, event.data.approve ? "green" : "yellow"), seg(`${child.label}: ${event.data.approve ? (event.data.choice === "once" ? "allowed once" : "allowed") : "not allowed"}${note}`, "dim")])
    }
    if (event.type === "approval.answered" || event.type === "tool.settled" || event.type === "step.failed") child.asking = false
  }

  private enqueued(data: EventData<"inbox.enqueued">): void {
    const text = data.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
    const midTurn = this.executing
    this.inbox.set(data.messageId, { text, delivery: data.delivery, midTurn, origin: data.origin })
    // The end of spawned work was just said on its own line; what the model is sent about it is that line's detail.
    if (data.origin === "background_command" || data.origin === "subagent_result" || data.origin === "spawn_lost") {
      this.line("info", [seg(`  ${SYMBOL.inbox} `, "magenta"), seg(midTurn ? "its result is sent to the agent after the current step" : "its result is sent to the agent, which carries on", "dim")])
      return
    }
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
    this.compacting = null
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

  /**
   * A label, then a path on a line of its own: a path is for copying, so it is
   * never cut or broken by the renderer. Indented under the label when it fits
   * the width, otherwise from the first column, where the terminal's own wrap
   * keeps it in one piece for most terminals' copy.
   */
  private pathLines(label: string, path: string): void {
    this.line("info", [seg(label, "dim")])
    const indent = label.length - label.trimStart().length + 2
    this.uncut("info", displayWidth(path) + indent <= this.width ? `${" ".repeat(indent)}${path}` : path, "dim")
  }

  /** A whole line that is never shortened, whatever the terminal width. */
  private uncut(kind: Block, text: string, tone?: Tone): void {
    this.endLine()
    this.gap(kind)
    this.raw(`${paint(this.options.color, tone, flatten(text))}\n`)
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
    // Not hung: the turn waits for the user.
    if (this.asking !== null && this.stop !== "shown") return "? waiting for your answer · Ctrl-C stops the turn"
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
    // Subagents at work: what each has done so far, in one line.
    const children = [...this.spawned.values()].filter((entry) => entry.kind === "subagent")
    if (children.length > 0 && this.stop !== "shown") {
      const asking = children.find((entry) => entry.asking)
      if (asking !== undefined) return `? ${asking.label} waits for your answer · Ctrl-C stops the turn`
      return `⋯ ${children.map((entry) => `${entry.label}: ${plural(entry.steps, "step")}, ${plural(entry.tools, "tool")}`).join(" · ")}`
    }
    if (this.checking !== null) {
      const tail = this.checking.progress?.split("\n").filter((line) => line.trim() !== "").at(-1)
      const what = this.stop === "shown" ? "waiting for the checks to stop" : `running ${this.checking.names.length === 1 ? "check" : "checks"}: ${this.checking.names.join(", ")}`
      return `⋯ ${what}${tail === undefined || this.stop === "shown" ? "" : ` · ${tail}`}`
    }
    if (this.stop === "shown") return "⋯ stopping"
    if (this.compacting !== null) return this.compacting.repairing ? "⋯ compacting the conversation · asking the model to fix its summary" : "⋯ compacting the conversation"
    if (this.retrying) return "⋯ waiting to retry"
    if (this.openStep !== null) {
      const reasoning = this.reasoningBuffers.get(this.openStep)
      if (reasoning !== undefined && !this.options.showReasoning) return `${SYMBOL.think} thinking`
      return "⋯ working"
    }
    return "⋯ working"
  }
}

/**
 * The CLI's own line after a turn's ending event in `--json` mode: what the
 * pretty output's last lines say (steps, time, tokens, the cached share), so a
 * script need not add the events up. Not an engine event: its type is the
 * CLI's (`cli.summary`), and it is never stored.
 */
export interface JsonSummary {
  readonly type: "cli.summary"
  readonly sessionId: string
  readonly executionId: string
  /** `stopped`: a call needed an approval nobody could give (`--unattended stop`, exit code 4). */
  readonly outcome: "succeeded" | "unresolved" | "failed" | "stopped" | "interrupted"
  /** Model calls the turn made (steps that started). */
  readonly steps: number
  readonly durationMs: number
  readonly usage: Usage | null
  /** `cachedInputTokens / inputTokens`, 0 to 1; `null` without usage. */
  readonly cachedShare: number | null
}

/** Every event as one JSON line, then a `cli.summary` line after each turn, and nothing else on stdout. */
export class JsonSink implements Sink {
  private turn: { start: number; steps: number; usage: Usage | null } | null = null

  constructor(
    private readonly write: (text: string) => void,
    private readonly writeError: (text: string) => void,
  ) {}

  event(event: EngineEvent): void {
    this.write(`${JSON.stringify(event)}\n`)
    this.tally(event)
  }

  private tally(event: EngineEvent): void {
    switch (event.type) {
      case "execution.started":
        this.turn = { start: event.time, steps: 0, usage: null }
        return
      case "execution.resumed":
        this.turn ??= { start: event.time, steps: 0, usage: null }
        return
      case "step.started":
        if (this.turn !== null) this.turn.steps += 1
        return
      case "step.ended":
      case "step.failed":
      case "step.refused":
      case "compaction.ended":
        return this.add(event.data.usage)
      case "execution.succeeded":
      case "execution.failed":
      case "execution.interrupted": {
        const turn = this.turn
        this.turn = null
        const outcome =
          event.type === "execution.succeeded"
            ? event.data.verification.status === "unresolved"
              ? "unresolved"
              : "succeeded"
            : event.type === "execution.failed"
              ? event.data.cause === "approval"
                ? "stopped"
                : "failed"
              : "interrupted"
        const usage = turn?.usage ?? null
        const summary: JsonSummary = {
          type: "cli.summary",
          sessionId: event.sessionId,
          executionId: event.data.executionId,
          outcome,
          steps: turn?.steps ?? 0,
          durationMs: turn === null ? 0 : Math.max(0, event.time - turn.start),
          usage,
          cachedShare: usage === null || usage.inputTokens === 0 ? null : Math.round((usage.cachedInputTokens / usage.inputTokens) * 1000) / 1000,
        }
        this.write(`${JSON.stringify(summary)}\n`)
        return
      }
    }
  }

  private add(usage: Usage | null): void {
    if (usage === null || this.turn === null) return
    const sum = this.turn.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    this.turn.usage = {
      inputTokens: sum.inputTokens + usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
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
        if (event.data.cause === "approval") {
          this.writeError(`${brand.binary}: stopped for your approval: a tool call needed it and nobody was here to give it (--unattended stop). ${STOPPED_FOR_APPROVAL}\n`)
          return
        }
        const requestId = this.requestId === null ? "" : ` (request ${this.requestId})`
        this.writeError(`${brand.binary}: failed: ${event.data.message}${requestId}\n`)
        return
      }
      case "execution.interrupted":
        if (event.data.reason === "user") this.writeError(`${brand.binary}: interrupted\n`)
        return
      case "turn.ended": {
        const verification = event.data.verification
        if (verification.status === "unresolved")
          this.writeError(`${brand.binary}: failing checks left unresolved before the queued message: ${verification.failing.join(", ")} (${unresolvedReason(verification)})\n`)
        return
      }
      case "diagnostic":
        // Something is wrong with the harness itself: said where failures go, since the engine says it nowhere else.
        this.writeError(`${brand.binary}: ${event.kind.replace(/_/g, " ")}: ${event.message}\n`)
        return
      case "approval.denied":
        // Nothing waited: an unattended run says what became of a call that would have asked.
        if (event.data.reason === "unattended")
          this.writeError(`${brand.binary}: a tool call was not run: it needs approval for ${event.data.needs.map(describeNeed).join(", ")}, and nobody is here to give it (--unattended ${event.data.stop ? "stop" : "deny"})\n`)
        return
      case "notice":
        this.writeError(`${brand.binary}: ${event.message.split("\n").join(" ")}\n`)
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

/**
 * Prose shortened to at most `rows` rows of `width`: wrapped at words, and
 * when there is more, the last row ends with `…` after a whole word.
 */
export function excerpt(text: string, width: number, rows: number): string[] {
  const wrapped = wrap(flatten(text.trim()).replace(/( ⏎ )+/g, " "), width)
  if (wrapped.length <= rows) return wrapped
  const shown = wrapped.slice(0, rows)
  let last = shown[rows - 1]!
  while (displayWidth(`${last} …`) > width && last.includes(" ")) last = last.slice(0, last.lastIndexOf(" "))
  shown[rows - 1] = `${last} …`
  return shown
}

/** In the compact form the summary follows the symbol directly; with no summary the duration does. */
function trimLeadingDot(tail: readonly Segment[], text: string): Segment[] {
  if (text !== "") return [...tail]
  return tail.map((part) => (part.text.startsWith(" · ") ? { ...part, text: part.text.slice(3) } : part))
}

/** A session ID short enough to say on a line: its prefix and the first eight characters after it. */
function shortId(id: string): string {
  const at = id.indexOf("_")
  return at === -1 ? id.slice(0, 12) : id.slice(0, at + 9)
}

/** A token count as a person reads it: `940`, `12.3k`, `1.2M`. */
function compactTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 100_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function suffix(parts: readonly (string | null)[]): string {
  const present = parts.filter((part): part is string => part !== null && part !== "")
  return present.length === 0 ? "" : ` · ${present.join(" · ")}`
}

/** A token count as a person reads it: `41,200`. */
function count(value: number): string {
  return value.toLocaleString("en-US")
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

/**
 * How a command ran, kept small: ` ⊡` in the sandbox, with the extra access
 * spelled out (` ⊡ +network`, ` ⊡ +write /opt/cache`); ` · no sandbox` for a
 * command that ran without it. Nothing when the run was not recorded.
 */
function sandboxMark(call: Call): Segment[] {
  const sandbox = call.sandbox
  if (sandbox === undefined) return []
  if (sandbox === null) return call.name === "shell" ? [seg(" · no sandbox", "yellow")] : []
  const extra = [sandbox.network ? "+network" : null, ...sandbox.writableRoots.map((root) => `+write ${root}`)].filter((part) => part !== null)
  return [seg(` ⊡${extra.length === 0 ? "" : ` ${extra.join(" ")}`}`, extra.length === 0 ? "dim" : "yellow")]
}
