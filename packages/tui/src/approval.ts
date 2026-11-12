/**
 * The approval dock: a tool call's approval question, shown above the input
 * while the turn waits for the user. It is not a modal: what the user is
 * typing stays in the input, untouched, and the dock takes keys only while it
 * has the focus. It takes the focus by itself only when the input is empty
 * and the user has not typed for a moment, and even then a key that is not
 * one of its own goes to the input. Tab moves between the input and the dock.
 *
 * Answers, all by keyboard: the question's choices (`a` once, `s` session,
 * `p` project, `n` no) and "no, with a note" (`m`), which opens a one-line
 * note for the agent. Up, Down and Enter work too. Esc goes back to the
 * input (or from the note back to the choices); Ctrl-C stops the turn, which
 * answers the question `cancelled`.
 *
 * Pure: `dockLines` lays the dock out at a width, `DockState.key` turns a key
 * into an action. The app draws the lines and carries the actions out.
 */
import type { ApprovalAsk } from "@light-harness/acp/client"
import { describeNeed } from "@light-harness/core"
import { plural, sanitize, truncate, wrapLine, width as textWidth } from "./layout.ts"
import { type Span, span } from "./theme.ts"

/** How long a dock that took the focus by itself ignores Enter and its letter keys: a key already on its way was meant for the input. */
export const ARMING_MS = 400
/** The dock takes the focus by itself only after this long without a key in the input. */
export const QUIET_MS = 1200
/** The longest note, in characters. */
const NOTE_LIMIT = 2000

export interface DockItem {
  readonly choice: string
  readonly label: string
  readonly remembers: string | null
  readonly key: string
  /** "No, with a note": opens the note before it answers. */
  readonly withNote: boolean
}

export type DockAction =
  /** Nothing to do (the key was handled, or ignored). */
  | { readonly kind: "none" }
  /** The key is not the dock's: give it to the input, which takes the focus. */
  | { readonly kind: "to_input" }
  | { readonly kind: "answer"; readonly choice: string; readonly note: string | null }

export class DockState {
  readonly items: readonly DockItem[]
  index = 0
  /** The note being written, or `null` while the choices are shown. */
  note: string | null = null
  focused: boolean
  /** The user stopped the turn: the question is off the screen and waits to be withdrawn. */
  withdrawn = false
  private armedAt: number

  constructor(
    readonly ask: ApprovalAsk,
    /** The tool and its argument, as the conversation shows the call. */
    readonly tool: { readonly name: string; readonly arg: string } | null,
    options: { readonly focused: boolean; readonly now: number },
  ) {
    const letters: Record<string, string> = { once: "a", session: "s", project: "p", deny: "n" }
    const choices = ask.question.choices
    this.items = [
      ...choices.map((choice, index) => ({ choice: choice.id, label: sanitize(choice.label), remembers: choice.remembers === null ? null : sanitize(choice.remembers), key: letters[choice.id] ?? String(index + 1), withNote: false })),
      ...(choices.some((choice) => choice.id === "deny") ? [{ choice: "deny", label: "Don't allow, and tell the agent why…", remembers: null, key: "m", withNote: true }] : []),
    ]
    this.focused = options.focused
    this.armedAt = options.focused ? options.now + ARMING_MS : options.now
  }

  /** The dock takes the focus (Tab, or a click): armed at once, the user chose to answer. */
  focus(now: number): void {
    this.focused = true
    this.armedAt = now
  }

  /** Handles a key while the dock has the focus. */
  key(name: string, sequence: string, ctrl: boolean, meta: boolean, now: number): DockAction {
    const armed = now >= this.armedAt
    const printable = !ctrl && !meta && sequence.length === 1 && sequence >= " " && name !== "return" && name !== "tab"
    if (this.note !== null) {
      if (name === "escape") this.note = null
      else if (name === "return" || name === "kpenter" || name === "enter") return { kind: "answer", choice: "deny", note: this.note.trim() === "" ? null : this.note.trim() }
      else if (name === "backspace") this.note = this.note.slice(0, -1)
      else if (ctrl && name === "u") this.note = ""
      else if (ctrl && name === "w") this.note = this.note.replace(/\S+\s*$/, "")
      else if (printable && this.note.length < NOTE_LIMIT) this.note += sequence
      return { kind: "none" }
    }
    if (name === "up" || (ctrl && name === "p")) {
      this.index = Math.max(0, this.index - 1)
      return { kind: "none" }
    }
    if (name === "down" || (ctrl && name === "n")) {
      this.index = Math.min(this.items.length - 1, this.index + 1)
      return { kind: "none" }
    }
    if (name === "return" || name === "kpenter" || name === "enter") return armed ? this.pick(this.items[this.index]!) : { kind: "none" }
    if (printable) {
      const keyed = this.items.find((item) => item.key === sequence.toLowerCase())
      // A letter that is not the dock's, or one typed before the dock was armed, is the user's text.
      if (keyed === undefined || !armed) return { kind: "to_input" }
      return this.pick(keyed)
    }
    return { kind: "none" }
  }

  private pick(item: DockItem): DockAction {
    if (item.withNote) {
      this.index = this.items.indexOf(item)
      this.note = ""
      return { kind: "none" }
    }
    return { kind: "answer", choice: item.choice, note: null }
  }
}

/** The dock as lines at `columns`, at most `rows` of them (details are dropped first, the choices never). */
export function dockLines(state: DockState, columns: number, rows: number, now: number): Span[][] {
  const ask = state.ask
  const question = ask.question
  const inner = Math.max(10, columns - 2)
  // A subagent's question says which one asks: the first line of its task.
  const who = ask.subagent === null ? "" : ` subagent: ${truncate(sanitize(ask.subagent), Math.max(12, Math.floor(columns / 3)))} `
  const title = truncate(sanitize(question.title), Math.max(10, columns - 6 - textWidth(who)))
  const rule = Math.max(0, columns - 4 - textWidth(title) - textWidth(who))
  const head: Span[] = [span("─ ", "warn"), span("? ", "warn", { bold: true }), span(title, undefined, { bold: true }), span(` ${"─".repeat(Math.max(0, rule - 1))}`, "warn"), span(who, "accent", { bold: true })]

  const subject = sanitize(question.subject)
    .split("\n")
    .filter((line) => line.trim() !== "")
  const toolName = state.tool?.name ?? null
  const what: Span[][] = subject.length === 0 ? [] : wrapLine([span("  "), span(toolName === null ? "" : `${toolName}  `, undefined, { bold: true }), span(subject[0]!, "accent")], columns, [span("    ")]).slice(0, 2)
  if (subject.length > 1) what.push([span(`    … and ${plural(subject.length - 1, "more line")}`, "dim")])
  const needs = ask.needs.map(describeNeed)
  const why = needs.length === 0 ? [] : wrapLine([span("  why: ", "dim"), span(needs.length === 1 ? needs[0]! : `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}`)], columns, [span("       ")])
  const runs = ask.then.kind === "run_sandboxed" ? runsText(ask.then) : [span("  runs: ", "dim"), span("without the sandbox, with your permissions", "warn")]
  const runLine = ask.then.kind === "run" && !needs.some((need) => need.includes("command")) ? [] : [runs]
  const details = question.details.flatMap((detail) => wrapLine([span(`  ${sanitize(detail)}`, "dim")], columns, [span("  ")]))

  const choiceLines: Span[][] = []
  if (state.note === null)
    state.items.forEach((item, index) => {
      const chosen = state.focused && index === state.index
      const line: Span[] = [span(chosen ? "› " : "  ", "accent"), span(`[${item.key}] `, "dim"), span(item.label, chosen ? "selected" : undefined, { bold: chosen }), span(item.remembers === null ? "" : `  remembers ${item.remembers}`, "dim")]
      choiceLines.push(...wrapLine(line, columns, [span("        ")]).slice(0, 2))
    })
  else {
    choiceLines.push([span("  Don't allow. Your note to the agent:", "warn")])
    const shown = state.note.length === 0 ? "" : state.note
    const room = inner - 4
    choiceLines.push([span("  › ", "accent"), span(textWidth(shown) > room ? `…${shown.slice(-(room - 1))}` : shown), span("▏", "accent")])
  }
  const footer = state.note !== null
    ? [span(columns < 80 ? "  Enter sends the refusal · Esc back" : "  Enter sends the refusal with your note · Esc back to the choices · Ctrl-C stops the turn", "dim")]
    : state.focused
      ? [span(columns < 80 ? `  ↑↓ Enter · ${state.items.map((item) => item.key).join(" ")} · Esc · Ctrl-C stops` : `  ↑↓ Enter · ${state.items.map((item) => item.key).join(" ")} · Esc back to your message · Ctrl-C stops the turn`, "dim")]
      : [span("  Tab", "warn", { bold: true }), span(columns < 80 ? " answers it · your message stays" : " answers the question · your message stays as it is · Ctrl-C stops the turn", "warn")]

  // Never more than `rows`: the details go first, then the why and how, never the title, the subject or the choices.
  const fixed = 1 + what.length + choiceLines.length + 1
  const room = Math.max(0, rows - fixed)
  const optional = [...why, ...runLine, ...details]
  const body = optional.slice(0, room)
  if (body.length < optional.length && room > 0) body[body.length - 1] = [span(`  … ${plural(optional.length - body.length + 1, "more line")} (a wider or taller terminal shows them)`, "dim")]
  return [head, ...what, ...body, ...choiceLines, footer].map((line) => clip(line, columns)).slice(0, Math.max(1, rows))
}

function runsText(then: { readonly network: boolean; readonly writableRoots: readonly string[] }): Span[] {
  const extra = [then.network ? "network access" : null, ...then.writableRoots.map((root) => `writes under ${root}`)].filter((part) => part !== null)
  return [span("  runs: ", "dim"), span("in the sandbox ⊡"), span(extra.length === 0 ? " · no network" : ` · with ${extra.join(" and ")}`, extra.length === 0 ? "dim" : "warn")]
}

function clip(line: Span[], columns: number): Span[] {
  let left = columns
  const out: Span[] = []
  for (const part of line) {
    if (left <= 0) break
    const w = textWidth(part.text)
    out.push(w <= left ? part : { ...part, text: truncate(part.text, left) })
    left -= Math.min(w, left)
  }
  return out
}
