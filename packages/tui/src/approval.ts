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
import type { ApprovalAsk } from "@windlass/acp/client"
import { describeNeed } from "@windlass/core"
import { mcpArguments } from "./cli.ts"
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
  /**
   * The subject is a command the user is asked to let run (a project's MCP
   * server, hook or language server): the dock shows all of it, wrapped and
   * never cut, and no call's row in the conversation repeats it.
   */
  readonly whole: boolean
  private armedAt: number

  constructor(
    readonly ask: ApprovalAsk,
    /** The tool and its argument, as the conversation shows the call; `input`: its arguments as written. */
    readonly tool: { readonly name: string; readonly arg: string; readonly input?: string } | null,
    options: { readonly focused: boolean; readonly now: number; readonly withNote?: boolean; readonly whole?: boolean },
  ) {
    this.whole = options.whole === true
    const letters: Record<string, string> = { once: "a", session: "s", project: "p", deny: "n" }
    const choices = ask.question.choices
    this.items = [
      ...choices.map((choice, index) => ({ choice: choice.id, label: sanitize(choice.label), remembers: choice.remembers === null ? null : sanitize(choice.remembers), key: letters[choice.id] ?? String(index + 1), withNote: false })),
      ...(options.withNote !== false && choices.some((choice) => choice.id === "deny") ? [{ choice: "deny", label: "Don't allow, and tell the agent why…", remembers: null, key: "m", withNote: true }] : []),
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

/** Every line of a command the user is asked about, wrapped at `columns` and never cut: a word wider than the dock is broken across lines. */
export function commandLines(state: DockState, columns: number): Span[][] {
  return sanitize(state.ask.question.subject)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => wrapLine([span("  "), span(line, "accent")], columns, [span("  ")]))
}

/** The lines of the dock that are always there besides the subject: its title, the choices (or the note), and the keys. */
function fixedRows(state: DockState, columns: number): number {
  return 1 + choiceLines(state, columns).length + 1
}

/**
 * Whether a command the user is asked about does not fit the dock at this
 * size: the dock then shows its beginning and says that the whole of it is
 * above, where the app prints it before the question can be answered.
 */
export function commandOverflows(state: DockState, columns: number, rows: number): boolean {
  return state.whole && commandLines(state, columns).length > Math.max(1, rows - fixedRows(state, columns))
}

function choiceLines(state: DockState, columns: number): Span[][] {
  const inner = Math.max(10, columns - 2)
  const lines: Span[][] = []
  if (state.note === null)
    state.items.forEach((item, index) => {
      const chosen = state.focused && index === state.index
      const line: Span[] = [span(chosen ? "› " : "  ", "accent"), span(`[${item.key}] `, "dim"), span(item.label, chosen ? "selected" : undefined, { bold: chosen }), span(item.remembers === null ? "" : `  remembers ${item.remembers}`, "dim")]
      lines.push(...wrapLine(line, columns, [span("        ")]).slice(0, 2))
    })
  else {
    lines.push([span("  Don't allow. Your note to the agent:", "warn")])
    const shown = state.note.length === 0 ? "" : state.note
    const room = inner - 4
    lines.push([span("  › ", "accent"), span(textWidth(shown) > room ? `…${shown.slice(-(room - 1))}` : shown), span("▏", "accent")])
  }
  return lines
}

/**
 * The dock as lines at `columns`, at most `rows` of them (details are dropped first, the choices never).
 * `idle`: no turn is running, so Ctrl-C has no turn to stop: it answers the question "not now".
 */
export function dockLines(state: DockState, columns: number, rows: number, now: number, idle = false): Span[][] {
  const ask = state.ask
  const question = ask.question
  // A subagent's question says which one asks: the first line of its task.
  const who = ask.subagent === null ? "" : ` subagent: ${truncate(sanitize(ask.subagent), Math.max(12, Math.floor(columns / 3)))} `
  const title = truncate(sanitize(question.title), Math.max(10, columns - 6 - textWidth(who)))
  const rule = Math.max(0, columns - 4 - textWidth(title) - textWidth(who))
  const head: Span[] = [span("─ ", "warn"), span("? ", "warn", { bold: true }), span(title, undefined, { bold: true }), span(` ${"─".repeat(Math.max(0, rule - 1))}`, "warn"), span(who, "accent", { bold: true })]

  const subject = sanitize(question.subject)
    .split("\n")
    .filter((line) => line.trim() !== "")
  const toolName = state.tool?.name ?? null
  // A tool call's subject is on its row in the conversation too, so two lines of it do here. A command the user is
  // asked to let run is nowhere else: all of it, or its beginning and where the whole of it is.
  let what: Span[][]
  if (state.whole) {
    what = commandLines(state, columns)
    const room = Math.max(1, rows - fixedRows(state, columns))
    if (what.length > room) what = [...what.slice(0, Math.max(0, room - 1)), [span(`  … ${plural(what.length - Math.max(0, room - 1), "more line")} of the command do not fit here: the whole of it is printed above, to its end`, "warn")]]
  } else {
    what = subject.length === 0 ? [] : wrapLine([span("  "), span(toolName === null ? "" : `${toolName}  `, undefined, { bold: true }), span(subject[0]!, "accent")], columns, [span("    ")]).slice(0, 2)
    if (subject.length > 1) what.push([span(`    … and ${plural(subject.length - 1, "more line")}`, "dim")])
  }
  // An MCP call: the title names the server's tool; what the user decides on is what would leave the machine.
  const sent = toolName === "mcp_call" && state.tool?.input !== undefined ? mcpArguments(state.tool.input) : null
  if (sent !== null) what.push(...wrapLine([span("  sends: ", "dim"), span(sanitize(sent))], columns, [span("    ")]).slice(0, 4))
  const needs = ask.needs.map(describeNeed)
  const why = needs.length === 0 ? [] : wrapLine([span("  why: ", "dim"), span(needs.length === 1 ? needs[0]! : `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}`)], columns, [span("       ")])
  const runs = ask.then.kind === "run_sandboxed" ? runsText(ask.then) : [span("  runs: ", "dim"), span("without the sandbox, with your permissions", "warn")]
  const runLine = ask.then.kind === "run" && !needs.some((need) => need.includes("command")) ? [] : [runs]
  const details = question.details.flatMap((detail) => wrapLine([span(`  ${sanitize(detail)}`, "dim")], columns, [span("  ")]))

  const choices = choiceLines(state, columns)
  const keys = state.items.map((item) => item.key).join(" ")
  const footer = state.note !== null
    ? [span(columns < 80 ? "  Enter sends the refusal · Esc back" : "  Enter sends the refusal with your note · Esc back to the choices · Ctrl-C stops the turn", "dim")]
    : state.focused
      ? [span(columns < 80 ? `  ↑↓ Enter · ${keys} · Esc · Ctrl-C ${idle ? "not now" : "stops"}` : `  ↑↓ Enter · ${keys} · Esc back to your message · Ctrl-C ${idle ? "answers not now" : "stops the turn"}`, "dim")]
      : [span("  Tab", "warn", { bold: true }), span(columns < 80 ? " answers it · your message stays" : ` answers the question · your message stays as it is${idle ? "" : " · Ctrl-C stops the turn"}`, "warn")]

  // Never more than `rows`: the details go first, then the why and how, never the title, the subject or the choices.
  const fixed = 1 + what.length + choices.length + 1
  const room = Math.max(0, rows - fixed)
  const optional = [...why, ...runLine, ...details]
  const body = optional.slice(0, room)
  if (body.length < optional.length && room > 0) body[body.length - 1] = [span(`  … ${plural(optional.length - body.length + 1, "more line")} (a wider or taller terminal shows them)`, "dim")]
  return [head, ...what, ...body, ...choices, footer].map((line) => clip(line, columns)).slice(0, Math.max(1, rows))
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
