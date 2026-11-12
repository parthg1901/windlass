/**
 * The side panel: the session, its token usage (the whole session and the
 * last model call, with the share read from the prompt cache), and one bar
 * per model call showing cached against uncached input, so cache behaviour is
 * readable at a glance. Every number comes from the usage the server reported
 * per call (`step.ended`, `step.failed`, `step.refused`, `compaction.ended`);
 * nothing is estimated. Bars use different glyphs for cached and uncached
 * input, so they read the same without colour.
 */
import type { Usage } from "@light-harness/core"
import { compact, plural, thousands, truncate, width } from "./layout.ts"
import { type Span, span } from "./theme.ts"
import type { Activity, CallUsage, SessionInfo } from "./transcript.ts"

export interface UsageSummary {
  readonly calls: number
  readonly total: Usage
  readonly last: CallUsage | null
  /** Cached share of all input, 0-100, or `null` with no input yet. */
  readonly cacheShare: number | null
  readonly lastCacheShare: number | null
}

export function summarize(calls: readonly CallUsage[]): UsageSummary {
  const total = calls.reduce(
    (sum, call) => ({
      inputTokens: sum.inputTokens + call.usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + call.usage.cachedInputTokens,
      outputTokens: sum.outputTokens + call.usage.outputTokens,
      reasoningTokens: sum.reasoningTokens + call.usage.reasoningTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  )
  const last = calls.at(-1) ?? null
  return { calls: calls.length, total, last, cacheShare: share(total), lastCacheShare: last === null ? null : share(last.usage) }
}

function share(usage: Usage): number | null {
  return usage.inputTokens === 0 ? null : Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
}

export interface PanelInput {
  readonly session: SessionInfo
  readonly calls: readonly CallUsage[]
  readonly activity: Activity
  readonly now: number
  readonly contextWindow: number | null
  readonly connection: string
  readonly home: string | null
  /** The approval mode, and whether commands can be sandboxed here; `null` when the server runs without the approval layer. */
  readonly approval?: { readonly mode: string | null; readonly sandbox: boolean } | null
}

export const PANEL_WIDTH = 36

export function panelLines(input: PanelInput, columns: number, rows: number): Span[][] {
  const inner = columns - 2
  const lines: Span[][] = []
  const heading = (text: string, extra: Span[] = []) => lines.push([span(text, undefined, { bold: true }), ...extra])
  const field = (name: string, value: string, role?: Span["role"]) => lines.push([span(name.padEnd(7), "dim"), span(truncate(value, inner - 7), role)])

  heading("Session")
  const session = input.session
  field("id", session.id === null ? "—" : middle(session.id, inner - 7))
  field("dir", session.cwd === null ? "—" : middle(tilde(session.cwd, input.home), inner - 7))
  field("model", session.model ?? "—")
  field("effort", session.effort ?? "default")
  field("state", stateText(input))
  // Cut at a word where it can, without a stray full stop before the ellipsis.
  if (session.title !== null && session.title !== "") field("title", shorten(session.title, inner - 7))
  const approval = input.approval ?? null
  if (approval !== null)
    lines.push([span("approval ", "dim"), span(approval.mode ?? "?", undefined, { bold: true }), span(approval.sandbox ? " · sandbox ⊡" : " · no sandbox", approval.sandbox ? "dim" : "warn")])
  if (session.taint !== null) field("trust", "untrusted · /clear-taint", "warn")
  lines.push([])

  const summary = summarize(input.calls)
  const last = summary.last?.usage ?? null
  const columnsWidth = Math.max(6, Math.floor((inner - 12) / 2))
  const row = (name: string, a: string, b: string) => lines.push([span(name.padEnd(12), "dim"), span(a.padStart(columnsWidth)), span(b.padStart(columnsWidth))])
  heading("Tokens".padEnd(12), [span("session".padStart(columnsWidth), "dim"), span("last".padStart(columnsWidth), "dim")])
  if (summary.calls === 0) lines.push([span("no model call yet", "dim")])
  else {
    row("input", thousands(summary.total.inputTokens), last === null ? "" : thousands(last.inputTokens))
    row(" cached", thousands(summary.total.cachedInputTokens), last === null ? "" : thousands(last.cachedInputTokens))
    row(" cache share", percent(summary.cacheShare), percent(summary.lastCacheShare))
    row("output", thousands(summary.total.outputTokens), last === null ? "" : thousands(last.outputTokens))
    if (summary.total.reasoningTokens > 0) row(" reasoning", thousands(summary.total.reasoningTokens), last === null ? "" : thousands(last.reasoningTokens))
    lines.push([span("calls".padEnd(12), "dim"), span(String(summary.calls).padStart(columnsWidth))])
    if (last !== null) {
      const used = last.inputTokens + last.outputTokens
      const window = input.contextWindow
      lines.push([span("context".padEnd(12), "dim"), span(window === null ? `${compact(used)} (window unknown)` : `${compact(used)} of ${compact(window)} (${Math.round((used / window) * 100)}%)`)])
    }
  }
  lines.push([])

  heading("Cache per call", [span("  █ cached ░ new", "dim")])
  const marks = [
    input.calls.some((call) => call.diagnostics.length > 0) ? "⚠ diagnostic" : null,
    input.calls.some((call) => call.kind === "compaction") ? "C compaction" : null,
    input.calls.some((call) => call.ended !== "ok" && call.diagnostics.length === 0 && call.kind !== "compaction") ? "✗ cut short" : null,
  ].filter((mark) => mark !== null)
  const legendRows = marks.length > 0 ? 1 : 0
  const room = Math.max(1, rows - lines.length - legendRows)
  const shown = input.calls.slice(-room)
  if (input.calls.length === 0) lines.push([span("bars appear after the first call", "dim")])
  if (shown.length < input.calls.length) lines[lines.length - 1] = [...lines.at(-1)!, span(` (last ${shown.length})`, "dim")]
  const max = Math.max(1, ...shown.map((call) => call.usage.inputTokens))
  const numberWidth = String(input.calls.length).length
  const bar = Math.max(4, inner - numberWidth - 1 - 2 - 6 - 5)
  for (const call of shown) lines.push(callLine(call, max, bar, numberWidth))
  if (legendRows > 0) lines.push([span(truncate(marks.join(" · "), inner), "dim")])
  return lines.slice(0, rows)
}

function callLine(call: CallUsage, max: number, bar: number, numberWidth: number): Span[] {
  const total = Math.max(call.usage.inputTokens > 0 ? 1 : 0, Math.round((call.usage.inputTokens / max) * bar))
  const cached = Math.min(total, Math.round((call.usage.cachedInputTokens / max) * bar))
  const mark = call.diagnostics.length > 0 ? "⚠" : call.kind === "compaction" ? "C" : call.ended !== "ok" ? "✗" : " "
  const shareText = percent(share(call.usage))
  return [
    span(String(call.n).padStart(numberWidth), "dim"),
    span(" "),
    span("█".repeat(cached), "cached"),
    span("░".repeat(total - cached), "uncached"),
    span(" ".repeat(bar - total)),
    span(mark, mark === "⚠" ? "warn" : mark === "✗" ? "error" : "dim"),
    span(` ${compact(call.usage.inputTokens).padStart(5)}`),
    span(` ${shareText.padStart(4)}`, "dim"),
  ]
}

function stateText(input: PanelInput): string {
  if (input.connection !== "connected") return input.connection
  const activity = input.activity
  if (!activity.executing) return "idle"
  const since = activity.turnStartedAt === null ? "" : ` · ${Math.max(0, Math.round((input.now - activity.turnStartedAt) / 1000))}s`
  return `${activity.stopping ? "stopping" : "working"}${since} · ${plural(activity.steps, "step")}`
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value}%`
}

function tilde(path: string, home: string | null): string {
  return home !== null && home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** Shortens at the last word boundary that fits (or at a character when none does), with `…`. */
export function shorten(text: string, max: number): string {
  if (width(text) <= max) return text
  const cut = truncate(text, max).slice(0, -1)
  // A cut that ends a word keeps it; otherwise back to the last space.
  const space = text[cut.length] === " " ? cut.length : cut.lastIndexOf(" ")
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:–-]+$/, "")}…`
}

/** Shortens in the middle, keeping the start and the end (the parts of an ID or path a person compares). */
export function middle(text: string, max: number): string {
  if (width(text) <= max) return text
  if (max < 5) return truncate(text, max)
  const keep = max - 1
  const start = Math.ceil(keep / 2)
  return `${text.slice(0, start)}…${text.slice(text.length - (keep - start))}`
}
