/**
 * The interactive terminal: a line editor that stays usable while the agent
 * works, drawn as a footer below the output.
 *
 * Everything the renderer prints goes through `Screen.write`, which lifts the
 * footer (the transient status line and the input), writes the permanent
 * output, and draws the footer again below it. The output may end mid-line
 * (text still streaming); the footer then sits on the next row and is lifted
 * back to that exact column before more output follows. The terminal cursor
 * rests in the input, where the user types.
 *
 * The editor keeps whole entries: an entry may span several lines (Alt-Enter,
 * a trailing backslash, or a paste), and Up and Down recall it whole.
 *
 * Two entries are not handed on as input: `/undo` and `/redo` act on the
 * session (`commands.ts`). The editor runs them itself, prints what they say
 * above the input, and, when one asks a question, shows the question as the
 * prompt and gives it the next entry as the answer.
 */
import { type CommandIo, runSessionCommand, sessionCommand } from "./commands.ts"
import { type Segment, displayWidth, renderLine, renderWrapped, seg, stripAnsi, truncate } from "./text.ts"

export interface ScreenOptions {
  readonly write: (text: string) => void
  readonly columns: () => number
  readonly color: boolean
}

export type EditorAction =
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "interrupt" }
  | { readonly kind: "eof" }

const ESC = "\x1b"
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

export class Screen {
  /** Display width of the output written since its last newline. */
  private partial = 0
  private drawn: { rows: number; cursorRow: number; belowPartial: boolean } | null = null
  private status: string | null = null
  private visible = false
  private scheduled = false
  private closed = false
  // The editor.
  private buffer = ""
  private cursor = 0
  private prompt = "› "
  private hint = ""
  private readonly history: string[] = []
  /** Position while browsing the history: `history.length` is the entry being written. */
  private browsing = 0
  private draft = ""
  private pasting = false
  private pasted = ""
  /** A command's question that is waiting for its answer: the next entry (or a Ctrl-C) goes to it. */
  private asking: { readonly answer: (text: string | null) => void; readonly prompt: string; readonly hint: string } | null = null
  /** The command that is running, so that a second one waits its turn. */
  private command: Promise<void> = Promise.resolve()

  constructor(private readonly options: ScreenOptions) {}

  // ---------------------------------------------------------------- output

  /** Permanent output. The footer is lifted first and drawn again after. */
  write(text: string): void {
    if (text === "" || this.closed) return
    this.lift()
    this.options.write(text)
    const newline = text.lastIndexOf("\n")
    const tail = stripAnsi(newline === -1 ? text : text.slice(newline + 1))
    this.partial = newline === -1 ? this.partial + displayWidth(tail) : displayWidth(tail)
    this.schedule()
  }

  /** The transient status line shown above the input (`null` hides it). */
  setStatus(text: string | null): void {
    if (text === this.status) return
    this.status = text
    this.schedule()
  }

  /** Shows the input with a prompt and, while it is empty, a dim hint. */
  show(prompt: string, hint = ""): void {
    this.prompt = prompt
    this.hint = hint
    this.visible = true
    this.redraw()
  }

  /** Removes the footer from the screen, for good. Call before the process exits. */
  close(): void {
    if (this.closed) return
    this.lift()
    if (this.partial > 0) this.options.write("\n")
    this.partial = 0
    this.closed = true
  }

  // ---------------------------------------------------------------- input

  /**
   * Feeds raw terminal input. `handle` is called for each action the moment
   * its key is read, so it sees the input as it was then (Ctrl-C followed by
   * more keys in one read clears the entry before those keys apply).
   */
  input(data: string, handle: (action: EditorAction) => void): void {
    let rest = data
    while (rest !== "") {
      if (this.pasting) {
        const end = rest.indexOf(PASTE_END)
        this.pasted += end === -1 ? rest : rest.slice(0, end)
        if (end === -1) break
        this.pasting = false
        this.insert(this.pasted.replace(/\r\n?/g, "\n").replace(/\t/g, "  "))
        this.pasted = ""
        rest = rest.slice(end + PASTE_END.length)
        continue
      }
      if (rest.startsWith(PASTE_START)) {
        this.pasting = true
        rest = rest.slice(PASTE_START.length)
        continue
      }
      // Several characters with a line break in one read is a paste from a terminal without bracketed paste.
      if (rest.length > 1 && /^[^\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]+$/.test(rest) && /[\r\n]/.test(rest.slice(0, -1))) {
        const submit = /\r$/.test(rest) && !/\\\r$/.test(rest)
        this.insert((submit ? rest.slice(0, -1) : rest).replace(/\r\n?/g, "\n").replace(/\t/g, "  "))
        if (submit) {
          const action = this.enter()
          if (action !== null) this.dispatch(action, handle)
        }
        break
      }
      const token = nextToken(rest)
      rest = rest.slice(token.length)
      const action = this.key(token)
      if (action !== null) this.dispatch(action, handle)
    }
    this.redraw()
  }

  /** Hands an action on, unless it answers a command's question or is itself a command. */
  private dispatch(action: EditorAction, handle: (action: EditorAction) => void): void {
    const asking = this.asking
    if (asking !== null) {
      // Ctrl-C and Ctrl-D back out of the question; they do not reach the turn or leave the program.
      this.asking = null
      this.show(asking.prompt, asking.hint)
      return asking.answer(action.kind === "submit" ? action.text : null)
    }
    const command = action.kind === "submit" ? sessionCommand(action.text) : null
    if (command === null) return handle(action)
    const io: CommandIo = {
      // What a command says is never cut: a line that does not fit is wrapped.
      print: (line) => this.write(`${renderWrapped(line, Math.max(10, this.options.columns()) - 1, this.options.color).join("\n")}\n`),
      ask: (question) =>
        new Promise((answer) => {
          this.asking = { answer, prompt: this.prompt, hint: this.hint }
          this.show(question)
        }),
    }
    this.command = this.command.then(() => runSessionCommand(command, io))
  }

  /** Resolves when no `/undo` or `/redo` is running. */
  commandsSettled(): Promise<void> {
    return this.command
  }

  /** What is typed in the input now. */
  get entry(): string {
    return this.buffer
  }

    /** Empties the input (Ctrl-C at the prompt). */
  clear(): void {
    this.buffer = ""
    this.cursor = 0
    this.browsing = this.history.length
    this.redraw()
  }

  private key(token: string): EditorAction | null {
    switch (token) {
      case "\r":
        return this.enter()
      case "\n":
      case `${ESC}\r`:
      case `${ESC}\n`:
        this.insert("\n")
        return null
      case "\x03":
        return { kind: "interrupt" }
      case "\x04":
        if (this.buffer === "") return { kind: "eof" }
        this.deleteForward()
        return null
      case "\x7f":
      case "\b":
        if (this.cursor > 0) this.replace(this.cursor - previousLength(this.buffer, this.cursor), this.cursor, "")
        return null
      case `${ESC}[3~`:
        this.deleteForward()
        return null
      case `${ESC}[D`:
      case `${ESC}OD`:
      case "\x02":
        this.cursor -= previousLength(this.buffer, this.cursor)
        return null
      case `${ESC}[C`:
      case `${ESC}OC`:
      case "\x06":
        this.cursor += nextLength(this.buffer, this.cursor)
        return null
      case `${ESC}[A`:
      case `${ESC}OA`:
      case "\x10":
        this.vertical(-1)
        return null
      case `${ESC}[B`:
      case `${ESC}OB`:
      case "\x0e":
        this.vertical(1)
        return null
      case `${ESC}[H`:
      case `${ESC}OH`:
      case `${ESC}[1~`:
      case "\x01":
        this.cursor = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1
        return null
      case `${ESC}[F`:
      case `${ESC}OF`:
      case `${ESC}[4~`:
      case "\x05": {
        const end = this.buffer.indexOf("\n", this.cursor)
        this.cursor = end === -1 ? this.buffer.length : end
        return null
      }
      case "\x15": {
        // At the start of a line it joins the line to the one above, so repeated presses clear a multi-line entry.
        const lineStart = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1
        this.replace(lineStart === this.cursor && lineStart > 0 ? lineStart - 1 : lineStart, this.cursor, "")
        return null
      }
      case "\x0b": {
        const end = this.buffer.indexOf("\n", this.cursor)
        this.replace(this.cursor, end === -1 ? this.buffer.length : end, "")
        return null
      }
      case "\x17":
      case `${ESC}\x7f`:
        this.replace(wordStart(this.buffer, this.cursor), this.cursor, "")
        return null
      case `${ESC}b`:
      case `${ESC}[1;5D`:
      case `${ESC}[1;3D`:
        this.cursor = wordStart(this.buffer, this.cursor)
        return null
      case `${ESC}f`:
      case `${ESC}[1;5C`:
      case `${ESC}[1;3C`:
        this.cursor = wordEnd(this.buffer, this.cursor)
        return null
      case "\t":
        this.insert("  ")
        return null
      default:
        // Other control keys and escape sequences do nothing; everything else is text.
        if (token.startsWith(ESC) || /^[\x00-\x1f\x7f]$/.test(token)) return null
        this.insert(token)
        return null
    }
  }

  private enter(): EditorAction | null {
    // A line that ends in a backslash continues on the next one.
    if (this.buffer.slice(0, this.cursor).endsWith("\\") && this.cursor === this.buffer.length) {
      this.replace(this.cursor - 1, this.cursor, "\n")
      return null
    }
    const text = this.buffer
    if (text.trim() !== "" && this.history.at(-1) !== text) this.history.push(text)
    this.buffer = ""
    this.cursor = 0
    this.browsing = this.history.length
    this.draft = ""
    return { kind: "submit", text }
  }

  /** Up and Down move between the lines of a multi-line entry, and past its first or last line through the history. */
  private vertical(direction: -1 | 1): void {
    const lineStart = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1
    const column = this.cursor - lineStart
    if (direction === -1 && lineStart > 0) {
      const previousStart = this.buffer.lastIndexOf("\n", lineStart - 2) + 1
      this.cursor = Math.min(previousStart + column, lineStart - 1)
      return
    }
    const lineEnd = this.buffer.indexOf("\n", this.cursor)
    if (direction === 1 && lineEnd !== -1) {
      const nextEnd = this.buffer.indexOf("\n", lineEnd + 1)
      this.cursor = Math.min(lineEnd + 1 + column, nextEnd === -1 ? this.buffer.length : nextEnd)
      return
    }
    const target = this.browsing + direction
    if (target < 0 || target > this.history.length) return
    if (this.browsing === this.history.length) this.draft = this.buffer
    this.browsing = target
    this.buffer = target === this.history.length ? this.draft : this.history[target]!
    this.cursor = this.buffer.length
  }

  private insert(text: string): void {
    this.replace(this.cursor, this.cursor, text)
  }

  private deleteForward(): void {
    if (this.cursor < this.buffer.length) this.replace(this.cursor, this.cursor + nextLength(this.buffer, this.cursor), "")
  }

  private replace(from: number, to: number, text: string): void {
    this.buffer = this.buffer.slice(0, from) + text + this.buffer.slice(to)
    this.cursor = from + text.length
  }

  // ---------------------------------------------------------------- drawing

  private schedule(): void {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    // Streamed text arrives in many small writes; the footer is drawn once they settle.
    setImmediate(() => {
      this.scheduled = false
      this.redraw()
    })
  }

  private redraw(): void {
    if (this.closed) return
    this.lift()
    if (!this.visible) return
    const cols = Math.max(10, this.options.columns())
    let out = ""
    let rows = 0
    const belowPartial = this.partial > 0
    if (belowPartial) out += "\r\n"
    if (this.status !== null) {
      out += `${renderLine([seg(this.status, "dim")], cols - 1, this.options.color)}\r\n`
      rows += 1
    }
    const lines = this.buffer.split("\n")
    const promptWidth = displayWidth(this.prompt)
    const indent = " ".repeat(promptWidth)
    const hint = truncate(this.hint, cols - promptWidth - 1)
    let cursorRow = 0
    let cursorCol = 0
    let offset = 0
    lines.forEach((line, index) => {
      const lead: Segment = seg(index === 0 ? this.prompt : indent, "dim")
      const body = index === 0 && this.buffer === "" && hint !== "" ? [lead, seg(hint, "dim")] : [lead, seg(line)]
      const width = promptWidth + displayWidth(line)
      const text = body.map((part) => paintSegment(part, this.options.color)).join("")
      out += text
      // A line that exactly fills its last row leaves the cursor pending at the edge; move it to the next row so
      // every line takes floor(width / cols) + 1 rows and the cursor arithmetic below holds.
      const hintWidth = index === 0 && this.buffer === "" ? displayWidth(hint) : 0
      const drawnWidth = Math.max(width, promptWidth + hintWidth)
      if (drawnWidth > 0 && drawnWidth % cols === 0) out += " \b"
      if (this.cursor >= offset && this.cursor <= offset + line.length) {
        const before = promptWidth + displayWidth(line.slice(0, this.cursor - offset))
        cursorRow = rows + Math.floor(before / cols)
        cursorCol = before % cols
      }
      rows += Math.floor(drawnWidth / cols) + 1
      offset += line.length + 1
      if (index < lines.length - 1) out += "\r\n"
    })
    const up = rows - 1 - cursorRow
    out += `${up > 0 ? `${ESC}[${up}A` : ""}\r${cursorCol > 0 ? `${ESC}[${cursorCol}C` : ""}`
    this.options.write(out)
    this.drawn = { rows, cursorRow, belowPartial }
  }

  /** Removes the footer and puts the cursor back where the permanent output ends. */
  private lift(): void {
    const drawn = this.drawn
    if (drawn === null) return
    this.drawn = null
    const cols = Math.max(10, this.options.columns())
    let out = `${drawn.cursorRow > 0 ? `${ESC}[${drawn.cursorRow}A` : ""}\r`
    const column = this.partial % cols
    // Back to the end of a partial output line. One that exactly fills its row continues at the start of the next.
    if (drawn.belowPartial && column > 0) out += `${ESC}[1A${ESC}[${column}C`
    this.options.write(`${out}${ESC}[J`)
  }
}

function paintSegment(part: Segment, color: boolean): string {
  return renderLine([part], Number.MAX_SAFE_INTEGER, color)
}

/** The next key or character of raw terminal input. */
function nextToken(data: string): string {
  if (data.startsWith(ESC)) {
    const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(data)
    if (csi !== null) return csi[0]
    if (/^\x1bO./.test(data)) return data.slice(0, 3)
    if (data.length > 1) return data.slice(0, 1 + (data.codePointAt(1)! > 0xffff ? 2 : 1))
    return ESC
  }
  const code = data.codePointAt(0)!
  return data.slice(0, code > 0xffff ? 2 : 1)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function previousLength(text: string, index: number): number {
  if (index <= 0) return 0
  let last = 1
  for (const { segment } of graphemes.segment(text.slice(0, index))) last = segment.length
  return last
}

function nextLength(text: string, index: number): number {
  if (index >= text.length) return 0
  const first = graphemes.segment(text.slice(index))[Symbol.iterator]().next()
  return first.done ? 1 : first.value.segment.length
}

function wordStart(text: string, index: number): number {
  let at = index
  while (at > 0 && /\s/.test(text[at - 1]!)) at -= 1
  while (at > 0 && !/\s/.test(text[at - 1]!)) at -= 1
  return at
}

function wordEnd(text: string, index: number): number {
  let at = index
  while (at < text.length && /\s/.test(text[at]!)) at += 1
  while (at < text.length && !/\s/.test(text[at]!)) at += 1
  return at
}
