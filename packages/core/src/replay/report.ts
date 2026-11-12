/**
 * The divergence report: where a replay left the tape, what the recording did
 * there and what the replay did instead, how much matched before, and the
 * comparisons that need no re-execution (steps, calls per tool, the final
 * answers, token usage). Rendered as compact plain text and as JSON; both are
 * deterministic for the same inputs.
 */
import type { Json } from "../json.ts"
import { type Usage, sumUsage } from "../provider/usage.ts"
import type { ArgumentChange, CallShape, Divergence, DivergenceKind, MatchStats, RecordedSide, ReplayedSide } from "./match.ts"
import type { ReplaySnapshot } from "./replay.ts"
import type { Tape } from "./tape.ts"

export interface ReplayReport {
  /**
   * - `identical`: every recorded step was replayed and matched.
   * - `diverged`: the replay left the tape (`divergence`).
   * - `unsupported`: the recording does something a replay cannot reproduce (a compaction, a revert, a refusal).
   * - `incomplete`: the replay ended for another reason (`reason`), e.g. a provider error.
   */
  readonly status: "identical" | "diverged" | "unsupported" | "incomplete"
  /** One line saying why the replay ended. */
  readonly reason: string
  readonly sessionId: string | null
  readonly divergence: Divergence | null
  /** What matched before the divergence (or in total, without one). */
  readonly matched: MatchStats
  /** Steps and calls after the divergence, when the policy ran tools for real. */
  readonly offTape: { readonly steps: number; readonly calls: number; readonly executed: number }
  readonly comparison: {
    readonly steps: { readonly recorded: number; readonly replayed: number }
    /** Every tool either side called, by name. */
    readonly callsByTool: readonly { readonly tool: string; readonly recorded: number; readonly replayed: number }[]
    /** The text of each side's last step when it answered without calling a tool; `null` otherwise. */
    readonly finalAnswer: { readonly recorded: string | null; readonly replayed: string | null }
    /** Summed over steps; `null` when that side reported none. */
    readonly usage: { readonly recorded: Usage | null; readonly replayed: Usage | null }
  }
  /** Recorded attempts cut by a fault that the replay skipped (see `Tape.skipped`). */
  readonly skippedAttempts: number
}

export function buildReport(tape: Tape, snapshot: ReplaySnapshot): ReplayReport {
  const recordedCalls = new Map<string, number>()
  for (const step of tape.steps) for (const call of step.calls) recordedCalls.set(call.name, (recordedCalls.get(call.name) ?? 0) + 1)
  const tools = [...new Set([...recordedCalls.keys(), ...Object.keys(snapshot.callsByTool)])].sort()
  const last = tape.steps.at(-1)
  const recordedUsage = tape.steps.reduce<Usage | null>((sum, step) => (step.usage === null ? sum : add(sum, step.usage)), null)
  return {
    status: status(snapshot),
    reason: reason(tape, snapshot),
    sessionId: tape.sessionId,
    divergence: snapshot.divergence,
    matched: snapshot.matched,
    offTape: snapshot.offTape,
    comparison: {
      steps: { recorded: tape.steps.length, replayed: snapshot.steps },
      callsByTool: tools.map((tool) => ({ tool, recorded: recordedCalls.get(tool) ?? 0, replayed: snapshot.callsByTool[tool] ?? 0 })),
      finalAnswer: {
        recorded: last !== undefined && last.calls.length === 0 && last.end.kind === "ended" ? last.text : null,
        replayed: snapshot.lastStep !== null && snapshot.lastStep.calls === 0 && snapshot.status !== "incomplete" ? snapshot.lastStep.text : null,
      },
      usage: { recorded: recordedUsage, replayed: snapshot.usage },
    },
    skippedAttempts: tape.skipped.length,
  }
}

export function renderReportJson(report: ReplayReport): string {
  return JSON.stringify(report, null, 2)
}

const KIND_TEXT: Record<DivergenceKind, string> = {
  arguments_differ: "arguments differ",
  different_tool: "a different tool",
  extra_call: "an extra call",
  call_instead_of_text: "a call instead of an answer",
  text_instead_of_call: "an answer instead of a call",
  missing_calls: "recorded calls not made",
  past_end: "past the end of the recording",
}

/** Compact plain text, at most about 90 columns wide. */
export function renderReport(report: ReplayReport): string {
  const lines = [`replay ${report.sessionId ?? "(no session id)"}: ${report.status.toUpperCase()}  ${report.reason}`]
  const divergence = report.divergence
  if (divergence !== null) {
    lines.push(`  recorded   ${side(divergence.recorded)}`, `  replayed   ${side(divergence.replayed)}`)
    for (const change of divergence.argumentDiff ?? []) lines.push(`  changed    ${changeText(change)}`)
  }
  const m = report.matched
  const extras = [
    `${m.normalised} normalised`,
    `${m.reordered} reordered`,
    `${m.splits} split`,
    `${m.merges} merged`,
    ...(m.dropped > 0 ? [`${m.dropped} dropped by an interrupt`] : []),
    ...(m.notStarted > 0 ? [`${m.notStarted} answered not_started`] : []),
    ...(m.effectUnknown > 0 ? [`${m.effectUnknown} answered effect_unknown`] : []),
  ]
  lines.push(`  matched${divergence === null ? "" : " before"}: ${plural(m.steps, "step")}, ${plural(m.calls, "call")} (${extras.join(", ")})`)
  if (report.offTape.steps > 0 || report.offTape.executed > 0)
    lines.push(`  off tape: ${plural(report.offTape.steps, "step")}, ${plural(report.offTape.calls, "call")}, ${report.offTape.executed} executed for real`)
  if (report.skippedAttempts > 0) lines.push(`  skipped: ${plural(report.skippedAttempts, "recorded attempt")} cut by a fault`)

  const c = report.comparison
  const rows: [string, string, string][] = [["steps", String(c.steps.recorded), String(c.steps.replayed)]]
  c.callsByTool.forEach((row, index) => rows.push([`${index === 0 ? "calls " : "      "}${row.tool}`, String(row.recorded), String(row.replayed)]))
  if (c.usage.recorded !== null || c.usage.replayed !== null) {
    rows.push(["tokens in", tokens(c.usage.recorded, "inputTokens"), tokens(c.usage.replayed, "inputTokens")])
    rows.push(["tokens out", tokens(c.usage.recorded, "outputTokens"), tokens(c.usage.replayed, "outputTokens")])
  }
  const width = Math.max(14, ...rows.map((row) => row[0].length))
  lines.push("", `  ${"".padEnd(width)}  recorded  replayed`)
  for (const [label, recorded, replayed] of rows) lines.push(`  ${label.padEnd(width)}  ${recorded.padStart(8)}  ${replayed.padStart(8)}`)
  lines.push(
    `  final answer`,
    `    recorded  ${c.finalAnswer.recorded === null ? "(none)" : quote(c.finalAnswer.recorded)}`,
    `    replayed  ${c.finalAnswer.replayed === null ? "(not reached)" : quote(c.finalAnswer.replayed)}`,
  )
  return lines.join("\n")
}

function status(snapshot: ReplaySnapshot): ReplayReport["status"] {
  if (snapshot.status === "unsupported") return "unsupported"
  if (snapshot.divergence !== null) return "diverged"
  if (snapshot.status === "finished") return "identical"
  return "incomplete"
}

function reason(tape: Tape, snapshot: ReplaySnapshot): string {
  const divergence = snapshot.divergence
  if (snapshot.status === "unsupported" && snapshot.unsupported !== null)
    return `the recording has a ${snapshot.unsupported.kind === "unsupported" ? snapshot.unsupported.what : snapshot.unsupported.kind} before step ${snapshot.unsupported.beforeStep + 1}, which a replay cannot reproduce`
  if (divergence !== null) {
    const at =
      divergence.recordedStep === null || divergence.recordedStep === divergence.replayStep
        ? `step ${divergence.replayStep + 1}`
        : `step ${divergence.replayStep + 1} (recorded step ${divergence.recordedStep + 1})`
    const call = divergence.callIndex === null ? "" : `, call ${divergence.callIndex + 1}`
    const why = snapshot.reason === null ? "" : `; stopped: ${snapshot.reason}`
    return `left the recording at ${at}${call}: ${KIND_TEXT[divergence.kind]}${why}`
  }
  if (snapshot.status === "finished") return `all ${plural(tape.steps.length, "recorded step")} replayed without a divergence`
  return snapshot.reason ?? "the replay ended before the recording did"
}

function side(value: RecordedSide | ReplayedSide): string {
  switch (value.kind) {
    case "calls":
      return value.calls.map(callText).join("; ")
    case "call":
      return callText(value.call)
    case "text":
      return `text ${quote(value.text)}`
    case "nothing":
      return `(${value.note})`
  }
}

function callText(call: CallShape): string {
  return `${call.name} ${clip(call.argumentsText, 70)}`
}

function changeText(change: ArgumentChange): string {
  const value = (json: Json | undefined) => (json === undefined ? "(absent)" : clip(JSON.stringify(json), 36))
  return `${change.path === "" ? "(arguments)" : change.path}: ${value(change.recorded)} -> ${value(change.replayed)}`
}

function quote(text: string): string {
  return clip(JSON.stringify(text), 76)
}

function clip(text: string, limit: number): string {
  const points = [...text]
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join("")}…`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function tokens(usage: Usage | null, field: "inputTokens" | "outputTokens"): string {
  return usage === null ? "-" : String(usage[field])
}

function add(a: Usage | null, b: Usage): Usage {
  return a === null ? b : sumUsage(a, b)
}
