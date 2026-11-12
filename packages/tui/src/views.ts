/**
 * The renderables the TUI draws itself. Each one lays out its own lines with
 * `layout.ts` and paints only what is visible, so a conversation of thousands
 * of rows costs no more per frame than one screenful.
 *
 * The conversation keeps its own scroll position in lines. While it follows
 * (the default) it shows the bottom as output arrives; scrolling up stops
 * following and keeps the view where the user put it however much arrives;
 * reaching the bottom again, or Esc, follows again.
 */
import { type OptimizedBuffer, Renderable, type RenderContext } from "@opentui/core"
import { truncate, width as textWidth, wrapText } from "./layout.ts"
import { type LayoutContext, gapBefore, isLive, layoutRow, pendingLines } from "./rows.ts"
import { type Line, type Span, type Theme, span } from "./theme.ts"
import { type Row, type Transcript, expandable } from "./transcript.ts"

/** Paints one line of spans at (x, y), clipped to `max` columns. Returns the columns used. */
export function drawLine(buffer: OptimizedBuffer, theme: Theme, x: number, y: number, max: number, line: Line): number {
  let used = 0
  for (const part of line) {
    if (used >= max || part.text === "") continue
    const w = textWidth(part.text)
    const text = used + w > max ? truncate(part.text, max - used) : part.text
    const paint = theme.paint(part)
    buffer.drawText(text, x + used, y, paint.fg, theme.background, paint.attributes)
    used += Math.min(w, textWidth(text))
  }
  return used
}

export function clearRect(buffer: OptimizedBuffer, theme: Theme, x: number, y: number, w: number, h: number): void {
  if (w <= 0 || h <= 0) return
  buffer.fillRect(x, y, w, h, theme.background)
}

interface Laid {
  readonly row: Row
  readonly start: number
  readonly height: number
  readonly lines: Span[][]
}

/** The columns left of every row: the selection marker. */
const GUTTER = 2

export class ConversationView extends Renderable {
  private readonly cache = new Map<number, { version: number; width: number; tick: number; lines: Span[][] }>()
  private laid: Laid[] = []
  private total = 0
  private laidFor = { version: -1, width: -1, tick: -1, debug: false, pending: -1 }
  /** First visible line. */
  private firstLine = 0
  follow = true
  /** Lines that arrived below the view since the user scrolled away from the bottom. */
  private unseen = 0
  selected: number | null = null
  debug = false

  constructor(
    ctx: RenderContext,
    private readonly transcript: Transcript,
    private readonly theme: Theme,
    private readonly now: () => number,
    options: ConstructorParameters<typeof Renderable>[1],
  ) {
    super(ctx, options)
    this.onMouseScroll = (event) => {
      const direction = event.scroll?.direction
      if (direction === "up") this.scrollBy(-3)
      else if (direction === "down") this.scrollBy(3)
    }
    this.onMouseDown = (event) => {
      const row = this.rowAt(event.y - this.y)
      if (row === null || !expandable(row)) return
      this.selected = row.id
      this.onToggle?.(row)
    }
  }

  /** Called when a row is clicked or toggled from the keyboard. */
  onToggle: ((row: Row) => void) | null = null

  get scrolledAway(): boolean {
    return !this.follow
  }

  get newBelow(): number {
    return this.unseen
  }

  scrollBy(lines: number): void {
    this.layout()
    const max = Math.max(0, this.total - this.height)
    this.firstLine = Math.max(0, Math.min(max, (this.follow ? max : this.firstLine) + lines))
    this.follow = this.firstLine >= max
    if (this.follow) this.unseen = 0
    this.requestRender()
  }

  page(direction: 1 | -1): void {
    this.scrollBy(direction * Math.max(1, this.height - 2))
  }

  toBottom(): void {
    this.follow = true
    this.unseen = 0
    this.requestRender()
  }

  toTop(): void {
    this.layout()
    this.follow = this.total <= this.height
    this.firstLine = 0
    this.requestRender()
  }

  /** Moves the selection to the previous (-1) or next (1) expandable row and scrolls it into view. */
  select(direction: 1 | -1): Row | null {
    this.layout()
    const candidates = this.laid.filter((entry) => expandable(entry.row) && entry.height > 0)
    if (candidates.length === 0) return null
    const at = candidates.findIndex((entry) => entry.row.id === this.selected)
    const next = at === -1 ? (direction === -1 ? candidates.length - 1 : 0) : Math.max(0, Math.min(candidates.length - 1, at + direction))
    const entry = candidates[next]!
    this.selected = entry.row.id
    this.reveal(entry)
    this.requestRender()
    return entry.row
  }

  selectedRow(): Row | null {
    return this.selected === null ? null : (this.transcript.rows.find((row) => row.id === this.selected) ?? null)
  }

  /** After a row changed size (expanded), keeps its first line where it was on screen. */
  keepInView(row: Row): void {
    this.layout()
    const entry = this.laid.find((candidate) => candidate.row.id === row.id)
    if (entry !== undefined) this.reveal(entry)
  }

  private reveal(entry: Laid): void {
    const max = Math.max(0, this.total - this.height)
    if (entry.start < this.firstLine) this.firstLine = entry.start
    else if (entry.start + Math.min(entry.height, this.height) > this.firstLine + this.height) this.firstLine = Math.min(max, entry.start + Math.min(entry.height, this.height) - this.height)
    else if (this.follow) this.firstLine = max
    this.follow = this.firstLine >= max
  }

  private rowAt(y: number): Row | null {
    const line = this.firstLine + y
    const entry = this.laid.find((candidate) => line >= candidate.start && line < candidate.start + candidate.height)
    return entry?.row ?? null
  }

  /** Lays out every row that changed since the last frame; reuses the rest. */
  private layout(): void {
    // One column stays free on the right, between the text and the panel's border.
    const columns = Math.max(10, this.width - GUTTER - 1)
    const transcript = this.transcript
    const live = transcript.rows.some(isLive)
    // Live rows (a running call's duration) are laid out again as the clock moves on, four times a second.
    const tick = live ? Math.floor(this.now() / 250) : 0
    const pendingKey = transcript.pending.length * 1000 + transcript.pending.reduce((sum, item) => sum + item.text.length + (item.delivery === "queue" ? 1 : 0), 0)
    const same = this.laidFor.version === transcript.version && this.laidFor.width === columns && this.laidFor.tick === tick && this.laidFor.debug === this.debug && this.laidFor.pending === pendingKey
    if (same) return
    const before = this.total
    const sameWidth = this.laidFor.width === columns
    const context: LayoutContext = { now: this.now(), debug: this.debug, color: this.theme.color }
    const laid: Laid[] = []
    let line = 0
    let previous: Row | null = null
    for (const row of transcript.rows) {
      const cached = this.cache.get(row.id)
      const rowTick = isLive(row) ? tick : 0
      const lines = cached !== undefined && cached.version === row.version && cached.width === columns && cached.tick === rowTick && row.kind !== "debug" ? cached.lines : layoutRow(row, columns, context)
      if (cached === undefined || cached.lines !== lines) this.cache.set(row.id, { version: row.version, width: columns, tick: rowTick, lines })
      if (lines.length === 0) continue
      const withGap = gapBefore(row, previous) ? [[], ...lines] : lines
      laid.push({ row, start: line, height: withGap.length, lines: withGap })
      line += withGap.length
      previous = row
    }
    const pending = pendingLines(transcript.pending, columns)
    if (pending.length > 0) {
      const lines = [[], ...pending]
      laid.push({ row: { kind: "debug", id: -1, version: 0, replay: false, text: "" }, start: line, height: lines.length, lines })
      line += lines.length
    }
    this.laid = laid
    this.total = line
    this.laidFor = { version: transcript.version, width: columns, tick, debug: this.debug, pending: pendingKey }
    if (!this.follow && this.total > before && sameWidth) this.unseen += this.total - before
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.layout()
    const height = this.height
    const max = Math.max(0, this.total - height)
    if (this.follow) this.firstLine = max
    this.firstLine = Math.min(this.firstLine, max)
    clearRect(buffer, this.theme, this.x, this.y, this.width, height)
    // The first entry that reaches into the view, found by binary search.
    let low = 0
    let high = this.laid.length - 1
    while (low < high) {
      const mid = (low + high) >> 1
      const entry = this.laid[mid]!
      if (entry.start + entry.height <= this.firstLine) low = mid + 1
      else high = mid
    }
    for (let index = low; index < this.laid.length; index += 1) {
      const entry = this.laid[index]!
      if (entry.start >= this.firstLine + height) break
      const selected = entry.row.id === this.selected
      entry.lines.forEach((line, offset) => {
        const y = entry.start + offset - this.firstLine
        if (y < 0 || y >= height) return
        const blank = line.length === 0 && offset === 0 && entry.lines.length > 1
        if (selected && !blank) drawLine(buffer, this.theme, this.x, this.y + y, GUTTER, [span("▌", "accent")])
        drawLine(buffer, this.theme, this.x + GUTTER, this.y + y, this.width - GUTTER, line)
      })
    }
    // Wrapped, so a hint longer than the column is read whole rather than cut by the panel.
    if (this.total === 0) wrapText([span(this.empty, "dim")], Math.max(10, this.width - GUTTER - 1)).slice(0, height).forEach((line, row) => drawLine(buffer, this.theme, this.x + GUTTER, this.y + row, this.width - GUTTER, line))
  }

  /** What the view says before anything happened. */
  empty = ""

  /** The whole conversation as text at the current width, for tests and the transcript dump. */
  text(): string {
    this.layout()
    return this.laid.flatMap((entry) => entry.lines.map((line) => line.map((part) => part.text).join("").trimEnd())).join("\n")
  }
}

/** Lines drawn as they are, clipped: the panel, the status line, the hints. */
export class LinesView extends Renderable {
  lines: Span[][] = []
  /** A left border, for the side panel. */
  border = false

  constructor(
    ctx: RenderContext,
    private readonly theme: Theme,
    private readonly source: (columns: number, rows: number) => Span[][],
    options: ConstructorParameters<typeof Renderable>[1],
  ) {
    super(ctx, options)
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    clearRect(buffer, this.theme, this.x, this.y, this.width, this.height)
    const left = this.border ? 2 : 0
    const lines = this.source(this.width - left, this.height)
    for (let y = 0; y < this.height; y += 1) {
      if (this.border) drawLine(buffer, this.theme, this.x, this.y + y, 1, [span("│", "border")])
      const line = lines[y]
      if (line !== undefined) drawLine(buffer, this.theme, this.x + left, this.y + y, this.width - left, line)
    }
  }
}

export interface DialogItem {
  readonly id: string
  readonly label: string
  readonly detail?: string
  /** A key that picks this item at once (`y`, `1`). */
  readonly key?: string
  readonly current?: boolean
}

export interface DialogSpec {
  readonly title: string
  readonly detail: readonly Span[][]
  readonly items: readonly DialogItem[]
  /** Typing narrows the items. */
  readonly filterable: boolean
  readonly footer: string
  /** Chosen with Esc or Ctrl-C; `null` to just close. */
  readonly cancel: string | null
}

/**
 * A modal list: a question with its choices, a picker, the help. Keyboard
 * driven (Up, Down, Enter, Esc, the items' keys, typing to filter). It is
 * drawn over the conversation and never touches the input, so what the user
 * was typing is there when it closes.
 */
export class Dialog extends Renderable {
  spec: DialogSpec | null = null
  index = 0
  filter = ""
  private resolve: ((id: string | null) => void) | null = null

  constructor(
    ctx: RenderContext,
    private readonly theme: Theme,
    options: ConstructorParameters<typeof Renderable>[1],
  ) {
    super(ctx, { ...options, position: "absolute", zIndex: 100, visible: false })
  }

  get open(): boolean {
    return this.spec !== null
  }

  show(spec: DialogSpec): Promise<string | null> {
    this.close(null)
    this.spec = spec
    this.filter = ""
    const current = spec.items.findIndex((item) => item.current === true)
    this.index = Math.max(0, current)
    this.visible = true
    this.requestRender()
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  close(answer: string | null): void {
    const resolve = this.resolve
    this.resolve = null
    this.spec = null
    this.visible = false
    this.requestRender()
    resolve?.(answer)
  }

  items(): readonly DialogItem[] {
    const spec = this.spec
    if (spec === null) return []
    if (this.filter === "") return spec.items
    const wanted = this.filter.toLowerCase()
    return spec.items.filter((item) => `${item.label} ${item.detail ?? ""} ${item.id}`.toLowerCase().includes(wanted))
  }

  /** Handles a key while open. Returns whether it was used. */
  key(name: string, sequence: string, ctrl: boolean, meta: boolean): boolean {
    const spec = this.spec
    if (spec === null) return false
    const items = this.items()
    if (name === "escape" || (ctrl && name === "c")) {
      this.close(spec.cancel)
      return true
    }
    if (name === "up" || (ctrl && name === "p")) this.index = Math.max(0, this.index - 1)
    else if (name === "down" || (ctrl && name === "n") || name === "tab") this.index = Math.min(Math.max(0, items.length - 1), this.index + 1)
    else if (name === "pageup") this.index = Math.max(0, this.index - 10)
    else if (name === "pagedown") this.index = Math.min(Math.max(0, items.length - 1), this.index + 10)
    else if (name === "return" || name === "enter" || name === "kpenter") {
      const item = items[this.index]
      if (item !== undefined) this.close(item.id)
      return true
    } else if (name === "backspace" && spec.filterable) {
      this.filter = this.filter.slice(0, -1)
      this.index = 0
    } else if (!ctrl && !meta && sequence.length === 1 && sequence >= " ") {
      const keyed = spec.filterable ? undefined : spec.items.find((item) => item.key !== undefined && item.key.toLowerCase() === sequence.toLowerCase())
      if (keyed !== undefined) {
        this.close(keyed.id)
        return true
      }
      if (spec.filterable) {
        this.filter += sequence
        this.index = 0
      }
    }
    this.requestRender()
    return true
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const spec = this.spec
    if (spec === null) return
    const parent = this.parent
    const screenWidth = parent?.width ?? this.width
    const screenHeight = parent?.height ?? this.height
    const w = Math.max(20, Math.min(screenWidth - 2, 76))
    const items = this.items()
    const inner = w - 4
    const detail = spec.detail.flatMap((line) => wrapSpans(line, inner))
    const room = Math.max(3, screenHeight - 4 - detail.length - 4)
    const visible = Math.min(items.length, room)
    const first = Math.max(0, Math.min(this.index - Math.floor(visible / 2), items.length - visible))
    const h = Math.min(screenHeight, detail.length + Math.max(1, visible) + 4 + (spec.filterable ? 1 : 0) + (detail.length > 0 ? 1 : 0))
    const x = Math.max(0, Math.floor((screenWidth - w) / 2))
    const y = Math.max(0, Math.floor((screenHeight - h) / 3))
    clearRect(buffer, this.theme, x, y, w, h)
    const border = (row: number, left: string, fill: string, right: string, title = "") => {
      const label = title === "" ? "" : ` ${truncate(title, w - 6)} `
      drawLine(buffer, this.theme, x, y + row, w, [span(`${left}${fill}`, "border"), span(label, undefined, { bold: true }), span(`${fill.repeat(Math.max(0, w - 3 - textWidth(label)))}${right}`, "border")])
    }
    border(0, "╭", "─", "╮", spec.title)
    for (let row = 1; row < h - 1; row += 1) {
      drawLine(buffer, this.theme, x, y + row, 1, [span("│", "border")])
      drawLine(buffer, this.theme, x + w - 1, y + row, 1, [span("│", "border")])
    }
    border(h - 1, "╰", "─", "╯", spec.footer)
    let row = 1
    for (const line of detail) drawLine(buffer, this.theme, x + 2, y + row++, inner, line)
    if (detail.length > 0) row += 1
    if (spec.filterable) drawLine(buffer, this.theme, x + 2, y + row++, inner, [span("filter: ", "dim"), span(this.filter), span("▏", "dim")])
    if (items.length === 0) drawLine(buffer, this.theme, x + 2, y + row, inner, [span(spec.filterable && this.filter !== "" ? "nothing matches" : "nothing to choose", "dim")])
    for (let index = first; index < first + visible; index += 1) {
      const item = items[index]!
      const chosen = index === this.index
      const keyLabel = item.key === undefined ? "" : `[${item.key}] `
      const line: Span[] = [
        span(chosen ? "› " : "  ", "accent"),
        span(keyLabel, "dim"),
        span(item.label, chosen ? "selected" : undefined, { bold: chosen }),
        span(item.current === true ? " (current)" : "", "dim"),
        span(item.detail === undefined ? "" : `  ${item.detail}`, "dim"),
      ]
      drawLine(buffer, this.theme, x + 2, y + row++, inner, line)
    }
  }
}

function wrapSpans(line: Span[], columns: number): Span[][] {
  // Dialog detail is short prose; wrapping it word by word is enough.
  const text = line.map((part) => part.text).join("")
  if (textWidth(text) <= columns) return [line]
  const role = line.find((part) => part.role !== undefined)?.role
  const words = text.split(" ")
  const out: Span[][] = []
  let current = ""
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`
    if (textWidth(next) <= columns) current = next
    else {
      if (current !== "") out.push([span(current, role)])
      current = truncate(word, columns)
    }
  }
  if (current !== "") out.push([span(current, role)])
  return out
}

export interface PagerSpec {
  readonly title: string
  /** The body at a width; `marks` are the line numbers sections start at (one per file), for n and p. */
  readonly body: (columns: number) => { readonly lines: Span[][]; readonly marks: readonly number[] }
  readonly footer: string
}

/**
 * A full-screen reader over the conversation: the per-file diff view.
 * Up, Down, PageUp, PageDown, Home, End scroll; n and p jump to the next and
 * previous file; Esc or q closes. Like the dialog, it never touches the input.
 */
export class Pager extends Renderable {
  spec: PagerSpec | null = null
  first = 0
  private laid: { columns: number; lines: Span[][]; marks: readonly number[] } | null = null
  private resolve: (() => void) | null = null

  constructor(
    ctx: RenderContext,
    private readonly theme: Theme,
    options: ConstructorParameters<typeof Renderable>[1],
  ) {
    super(ctx, { ...options, position: "absolute", zIndex: 90, visible: false })
  }

  get open(): boolean {
    return this.spec !== null
  }

  show(spec: PagerSpec): Promise<void> {
    this.close()
    this.spec = spec
    this.first = 0
    this.laid = null
    this.visible = true
    this.requestRender()
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  close(): void {
    const resolve = this.resolve
    this.resolve = null
    this.spec = null
    this.laid = null
    this.visible = false
    this.requestRender()
    resolve?.()
  }

  key(name: string, sequence: string, ctrl: boolean): void {
    const laid = this.layout()
    if (laid === null) return
    const page = Math.max(1, this.bodyHeight() - 1)
    // The last file can be brought to the top, so n reaches every file.
    const max = Math.max(0, laid.lines.length - this.bodyHeight(), laid.marks.at(-1) ?? 0)
    if (name === "escape" || sequence === "q" || (ctrl && name === "c")) return this.close()
    if (name === "up" || sequence === "k") this.first -= 1
    else if (name === "down" || sequence === "j" || name === "return") this.first += 1
    else if (name === "pageup" || sequence === "b") this.first -= page
    else if (name === "pagedown" || sequence === " ") this.first += page
    else if (name === "home" || sequence === "g") this.first = 0
    else if (name === "end" || sequence === "G") this.first = max
    else if (sequence === "n") this.first = laid.marks.find((mark) => mark > this.first) ?? this.first
    else if (sequence === "p") this.first = laid.marks.findLast((mark) => mark < this.first) ?? 0
    this.first = Math.max(0, Math.min(max, this.first))
    this.requestRender()
  }

  /** The body as text at the current width, for tests. */
  text(): string {
    return (this.layout()?.lines ?? []).map((line) => line.map((part) => part.text).join("").trimEnd()).join("\n")
  }

  private bodyHeight(): number {
    return Math.max(1, (this.parent?.height ?? this.height) - 2)
  }

  private layout(): { columns: number; lines: Span[][]; marks: readonly number[] } | null {
    const spec = this.spec
    if (spec === null) return null
    const columns = Math.max(10, (this.parent?.width ?? this.width) - 2)
    if (this.laid === null || this.laid.columns !== columns) this.laid = { columns, ...spec.body(columns) }
    return this.laid
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const spec = this.spec
    const laid = this.layout()
    if (spec === null || laid === null) return
    const w = this.parent?.width ?? this.width
    const h = this.parent?.height ?? this.height
    clearRect(buffer, this.theme, 0, 0, w, h)
    const body = this.bodyHeight()
    const shown = laid.lines.length === 0 ? "" : ` · lines ${this.first + 1}-${Math.min(laid.lines.length, this.first + body)} of ${laid.lines.length}`
    drawLine(buffer, this.theme, 0, 0, w, [span(truncate(spec.title, Math.max(4, w - textWidth(shown))), undefined, { bold: true }), span(shown, "dim")])
    for (let row = 0; row < body; row += 1) {
      const line = laid.lines[this.first + row]
      if (line !== undefined) drawLine(buffer, this.theme, 1, 1 + row, w - 1, line)
    }
    drawLine(buffer, this.theme, 0, h - 1, w, [span(truncate(spec.footer, w), "dim")])
  }
}
