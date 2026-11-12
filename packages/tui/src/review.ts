/**
 * Reviewing a turn's diff: the changed files, their patches line by line under
 * a cursor, the user's comments on lines, and the one message the comments
 * become when the review is sent.
 *
 * Everything here is client state and plain values: no engine, no terminal,
 * no clock. `Review` is what the user has written about one turn; a
 * `ReviewScreen` is one visit to it (where the cursor's line is on screen,
 * what is being typed) and turns keys into changes and a size into the lines
 * to draw. `review-view.ts` puts it on the screen.
 */
import type { DiffFile } from "@windlass/acp/extensions"
import { plural, sanitize, truncate, truncateLine, width as textWidth, wrapLine } from "./layout.ts"
import { type Span, span } from "./theme.ts"

/** The mark of a line, or a file, that has a comment. */
export const COMMENT_MARK = "◆"
/** The longest quoted line a message carries; the rest is said to be cut. */
const QUOTE_LIMIT = 240

export type ReviewLineKind = "file" | "hunk" | "added" | "removed" | "context" | "note"

/** One row of the review: a file's own line, a hunk header, a line of a patch, or a sentence about what is not shown. */
export interface ReviewLine {
  readonly kind: ReviewLineKind
  /** Its file's place in the diff. */
  readonly file: number
  /** Its hunk in the file, counted from 0; `null` outside the hunks. */
  readonly hunk: number | null
  /** The line's number in the file before the turn (removed and unchanged lines). */
  readonly oldLine: number | null
  /** The line's number in the file after the turn (added and unchanged lines). */
  readonly newLine: number | null
  /** The line's text as the patch has it, without its sign; a file's path; a hunk header; a note's sentence. */
  readonly text: string
}

/** A comment and what it is on: a line (numbered in the new file, or in the old file for a removed line) or the file as a whole. */
export interface ReviewComment {
  readonly path: string
  readonly on: "added" | "removed" | "context" | "file"
  readonly line: number | null
  /** The line's text, as it was commented on. */
  readonly quote: string | null
  readonly text: string
}

/** The turn a review is of, as the user counts turns; `turn` is `null` when the conversation does not number it. */
export interface ReviewOf {
  readonly turn: number | null
  /** It was the latest turn that ended when the review was opened. */
  readonly latest: boolean
}

const BEFORE_HUNKS = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** The rows of one file: its own line, then its patch line by line, or why there is none. */
export function fileLines(file: DiffFile, index: number): ReviewLine[] {
  const row = (kind: ReviewLineKind, text: string, hunk: number | null = null, oldLine: number | null = null, newLine: number | null = null): ReviewLine => ({ kind, file: index, hunk, oldLine, newLine, text })
  const lines = [row("file", file.path)]
  const whole = "a comment on the file's line above is about the file as a whole"
  if (file.binary) lines.push(row("note", `binary file: it has no lines to show or comment on; ${whole}`))
  else if (file.omitted) lines.push(row("note", `its patch was left out: the diff of this turn is too large (the patch budget ran out before this file); ${whole}`))
  else if (file.patch === null) lines.push(row("note", `no patch came with this file; ${whole}`))
  else {
    let hunk = -1
    let oldLine = 0
    let newLine = 0
    for (const raw of file.patch.replace(/\n+$/, "").split("\n")) {
      const header = BEFORE_HUNKS.exec(raw)
      if (header !== null) {
        hunk += 1
        oldLine = Number(header[1])
        newLine = Number(header[2])
        lines.push(row("hunk", raw, hunk))
      } else if (hunk === -1) {
        // The `diff --git`, index, mode and file-name headers say nothing the file's own line does not.
      } else if (raw.startsWith("\\")) lines.push(row("note", "the line above has no newline at its end", hunk))
      else if (raw.startsWith("+")) lines.push(row("added", raw.slice(1), hunk, null, newLine++))
      else if (raw.startsWith("-")) lines.push(row("removed", raw.slice(1), hunk, oldLine++, null))
      else lines.push(row("context", raw.slice(1), hunk, oldLine++, newLine++))
    }
    if (hunk === -1) lines.push(row("note", `no line of the file changed${file.status === "mode_changed" ? ": only its mode did" : file.status === "type_changed" ? ": only its type did" : " (an empty file, or only its mode)"}; ${whole}`))
    if (file.truncated) lines.push(row("note", `cut here: the change to this file is larger than the per-file limit, so the rest is not shown; ${whole}`))
  }
  return lines
}

/** Where a comment is, in words: `src/add.ts, line 2 (added)`, `notes.md, line 4 of the old file (removed)`, `logo.png (the file as a whole)`. */
export function placeText(comment: Pick<ReviewComment, "path" | "on" | "line">): string {
  if (comment.on === "file") return `${comment.path} (the file as a whole)`
  if (comment.on === "removed") return `${comment.path}, line ${comment.line} of the old file (removed)`
  return `${comment.path}, line ${comment.line} (${comment.on === "added" ? "added" : "unchanged"})`
}

/** What the user has written about one turn's diff: comments on lines and files, and an overall note. */
export class Review {
  readonly lines: readonly ReviewLine[]
  private readonly byKey = new Map<string, ReviewComment>()
  /** The overall note, sent above the comments when it is not empty. */
  note = ""
  /** The row the cursor is on: always one a comment can go on (a file's line or a line of a patch). */
  cursor = 0
  /** Counts the changes to the comments, for whoever keeps a layout of them. */
  version = 0
  private deleted: { readonly index: number; readonly comment: ReviewComment } | null = null
  private hunks: number[] | null = null

  constructor(
    readonly of: ReviewOf,
    readonly files: readonly DiffFile[],
  ) {
    this.lines = files.flatMap((file, index) => fileLines(file, index))
    // The first changed line, where there is one: the first thing to read.
    this.cursor = this.hunkStops()[0] ?? 0
  }

  /** The turn in words: `turn 2`, or `the latest turn` when the conversation does not number it. */
  get what(): string {
    return this.of.turn === null ? "the latest turn" : `turn ${this.of.turn}`
  }

  get count(): number {
    return this.byKey.size
  }

  /** Can the cursor stop on this row (and a comment go on it). */
  stop(index: number): boolean {
    const kind = this.lines[index]?.kind
    return kind !== undefined && kind !== "hunk" && kind !== "note"
  }

  private key(index: number): string {
    const line = this.lines[index]!
    const path = this.files[line.file]!.path
    return line.kind === "file" ? `${path}\u0000file` : line.kind === "removed" ? `${path}\u0000old\u0000${line.oldLine}` : `${path}\u0000new\u0000${line.newLine}`
  }

  commentAt(index: number = this.cursor): ReviewComment | null {
    return this.stop(index) ? (this.byKey.get(this.key(index)) ?? null) : null
  }

  /** The comments on one file, its own and its lines'. */
  commentsOn(file: number): number {
    const path = this.files[file]?.path
    return [...this.byKey.values()].filter((comment) => comment.path === path).length
  }

  /** The comments in the order of the diff. */
  ordered(): ReviewComment[] {
    return this.lines.flatMap((_, index) => this.commentAt(index) ?? [])
  }

  /** Writes, replaces or (with nothing but spaces) removes the comment on the cursor's row. Says what came of it. */
  setComment(text: string): "saved" | "deleted" | "nothing" {
    const index = this.cursor
    const trimmed = text.replace(/\s+$/, "").replace(/^(\s*\n)+/, "")
    if (trimmed.trim() === "") return this.deleteComment() === null ? "nothing" : "deleted"
    const line = this.lines[index]!
    const on = line.kind as ReviewComment["on"]
    this.byKey.set(this.key(index), { path: this.files[line.file]!.path, on, line: on === "file" ? null : on === "removed" ? line.oldLine : line.newLine, quote: on === "file" ? null : line.text, text: trimmed })
    this.version += 1
    return "saved"
  }

  /** Removes the comment on the cursor's row; `restoreComment` brings the last one removed back. */
  deleteComment(): ReviewComment | null {
    const comment = this.commentAt()
    if (comment === null) return null
    this.byKey.delete(this.key(this.cursor))
    this.deleted = { index: this.cursor, comment }
    this.version += 1
    return comment
  }

  /** Puts back the comment removed last, where it was, unless another was written there since. Moves the cursor to it. */
  restoreComment(): boolean {
    const deleted = this.deleted
    if (deleted === null || this.byKey.has(this.key(deleted.index))) return false
    this.byKey.set(this.key(deleted.index), deleted.comment)
    this.deleted = null
    this.cursor = deleted.index
    this.version += 1
    return true
  }

  // ---------------------------------------------------------------- moving

  /** Moves by rows the cursor can stop on; stays at the ends. Returns whether it moved. */
  move(by: number): boolean {
    const step = by < 0 ? -1 : 1
    let at = this.cursor
    for (let left = Math.abs(by); left > 0; left -= 1) {
      let next = at + step
      while (next >= 0 && next < this.lines.length && !this.stop(next)) next += step
      if (next < 0 || next >= this.lines.length) break
      at = next
    }
    const moved = at !== this.cursor
    this.cursor = at
    return moved
  }

  toStart(): void {
    this.cursor = 0
  }

  toEnd(): void {
    this.cursor = this.lines.findLastIndex((_, index) => this.stop(index))
  }

  /** Where each hunk is entered: its first changed line. */
  private hunkStops(): number[] {
    if (this.hunks !== null) return this.hunks
    const stops: number[] = []
    let open = false
    let any = -1
    const close = () => {
      if (open && any !== -1) stops.push(any)
      open = false
      any = -1
    }
    this.lines.forEach((line, index) => {
      if (line.kind === "hunk" || line.kind === "file") {
        close()
        open = line.kind === "hunk"
      } else if (open && (line.kind === "added" || line.kind === "removed")) {
        stops.push(index)
        open = false
      } else if (open && any === -1 && this.stop(index)) any = index
    })
    close()
    this.hunks = stops
    return stops
  }

  /** To the next (1) or previous (-1) hunk's first changed line, across files. */
  moveHunk(direction: 1 | -1): boolean {
    return this.jump(this.hunkStops(), direction)
  }

  /** To the next file's line, or back to this file's and then the one before. */
  moveFile(direction: 1 | -1): boolean {
    return this.jump(this.lines.flatMap((line, index) => (line.kind === "file" ? [index] : [])), direction)
  }

  private jump(stops: readonly number[], direction: 1 | -1): boolean {
    const to = direction === 1 ? stops.find((stop) => stop > this.cursor) : stops.findLast((stop) => stop < this.cursor)
    if (to === undefined) return false
    this.cursor = to
    return true
  }
}

/**
 * The message a review becomes: one ordinary message from the user, read by
 * the model and shown in the conversation as it is. Per comment: where it is
 * (the path; the line's number in the new file, or in the old file for a
 * removed line, said so), the line quoted, and the comment under it.
 */
export function reviewMessage(review: Review, note: string = review.note): string {
  const comments = review.ordered()
  const files = new Set(comments.map((comment) => comment.path)).size
  const where = review.of.turn === null ? "the latest turn" : `turn ${review.of.turn}${review.of.latest ? " (the latest turn)" : ""}`
  const lines = [`Review of the changes in ${where}: ${plural(comments.length, "comment")} on ${plural(files, "file")}.`]
  const overall = note.trim()
  if (overall !== "") lines.push("", ...(overall.includes("\n") ? ["Overall:", ...overall.split("\n").map((line) => `   ${line}`.trimEnd())] : [`Overall: ${overall}`]))
  comments.forEach((comment, index) => {
    lines.push("", `${index + 1}. ${placeText(comment)}`)
    if (comment.quote !== null) lines.push(`   > ${quoted(comment.quote)}`.trimEnd())
    lines.push(...comment.text.split("\n").map((line) => `   ${line}`.trimEnd()))
  })
  return lines.join("\n")
}

function quoted(text: string): string {
  const line = text.replace(/\s+$/, "")
  if (line === "") return "(an empty line)"
  return line.length <= QUOTE_LIMIT ? line : `${line.slice(0, QUOTE_LIMIT)}… (the line is cut here: it has ${(line.length - QUOTE_LIMIT).toLocaleString("en-US")} more characters)`
}

// ---------------------------------------------------------------- the screen

/** A key as the screen reads it. */
export interface ReviewKey {
  readonly name: string
  readonly sequence: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
}

/** Where the text being written goes on the screen. */
export interface EditorPlace {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

export interface ReviewFrame {
  /** The whole screen, one entry per row. */
  readonly lines: Span[][]
  /** `null` while nothing is being written. */
  readonly editor: EditorPlace | null
}

interface Laid {
  readonly columns: number
  readonly version: number
  readonly lines: Span[][]
  /** Per row of the review: its first line in `lines`, and how many it takes with its comment. */
  readonly start: number[]
  readonly height: number[]
}

/** What the file's line says after the path: `new file · +2 -0`, `binary`, `patch left out`. */
function about(file: DiffFile): string {
  const status = file.status === "added" ? "new file" : file.status === "deleted" ? "deleted" : file.status === "modified" ? "" : file.status.replace(/_/g, " ")
  const stat = file.binary ? "binary" : file.omitted ? "patch left out" : file.patch === null ? "no patch" : `+${file.added} -${file.removed}`
  return [status, stat].filter((part) => part !== "").join(" · ")
}

const MAX_EDITOR_ROWS = 6
const MAX_FILE_ROWS = 5

/**
 * One visit to a review. `browse`: the cursor moves and comments are opened;
 * `comment`: the comment on the cursor's row is being written; `send`: the
 * message is shown for a last look while the overall note is written.
 */
export class ReviewScreen {
  mode: "browse" | "comment" | "send" = "browse"
  /** What the editor starts with when a mode that has one begins. */
  draft = ""
  /** A sentence about the last key, shown until the next one. */
  notice: { readonly text: string; readonly tone: "dim" | "warn" } | null = null
  /** What Enter does with the message, for the hint: `sends it`, or how it reaches an agent at work. */
  delivery: () => string = () => "sends it"
  private first = 0
  private previewFirst = 0
  private laid: Laid | null = null
  private body = 10
  private widths: { old: number; new: number } | null = null

  constructor(readonly review: Review) {}

  /**
   * A key. `typed` is what the editor holds. `pass`: the key is the editor's
   * (text being written); `leave` and `send` end the visit.
   */
  key(key: ReviewKey, typed: string): "handled" | "pass" | "leave" | "send" {
    const { name, sequence, ctrl } = key
    const enter = (name === "return" || name === "kpenter") && !key.meta && !ctrl && !key.shift
    const cancel = name === "escape" || (ctrl && name === "c")
    const review = this.review
    if (this.mode === "comment") {
      if (cancel) {
        this.mode = "browse"
        this.notice = { text: review.commentAt() === null ? "no comment was written" : "the comment is as it was", tone: "dim" }
        return "handled"
      }
      if (!enter) return "pass"
      const came = review.setComment(typed)
      this.mode = "browse"
      this.notice = came === "saved" ? null : { text: came === "deleted" ? "the comment was deleted (it was left empty) · u brings it back" : "no comment was written", tone: "dim" }
      return "handled"
    }
    if (this.mode === "send") {
      if (name === "pageup" || name === "pagedown") {
        this.previewFirst += (name === "pageup" ? -1 : 1) * Math.max(1, this.body - 1)
        return "handled"
      }
      if (!cancel && !enter) return "pass"
      review.note = typed.trim()
      if (enter) return "send"
      this.mode = "browse"
      return "handled"
    }
    this.notice = null
    const say = (text: string, tone: "dim" | "warn" = "dim") => void (this.notice = { text, tone })
    if (cancel || sequence === "q") return "leave"
    if (name === "up" || sequence === "k") review.move(-1)
    else if (name === "down" || sequence === "j") review.move(1)
    else if (name === "pageup" || sequence === "b") this.page(-1)
    else if (name === "pagedown" || sequence === " ") this.page(1)
    else if (name === "home" || sequence === "g") review.toStart()
    else if (name === "end" || sequence === "G") review.toEnd()
    else if (sequence === "]") review.moveHunk(1) || say("this is the last hunk")
    else if (sequence === "[") review.moveHunk(-1) || say("this is the first hunk")
    else if (sequence === "n") review.moveFile(1) || say("this is the last file")
    else if (sequence === "p") review.moveFile(-1) || say("this is the first file")
    else if (sequence === "c" || sequence === "e" || enter) {
      this.draft = review.commentAt()?.text ?? ""
      this.mode = "comment"
    } else if (sequence === "d" || sequence === "x" || name === "delete") {
      if (review.deleteComment() === null) say("there is no comment on this line to delete")
      else say("the comment was deleted · u brings it back")
    } else if (sequence === "u") {
      if (!review.restoreComment()) say("there is no deleted comment to bring back")
    } else if (sequence === "s") {
      if (review.count === 0) say("there is no comment to send yet: c writes one on the line under the cursor", "warn")
      else {
        this.draft = review.note
        this.previewFirst = 0
        this.mode = "send"
      }
    }
    return "handled"
  }

  /** Moves the cursor by `lines` rows of the screen (the wheel). */
  scroll(lines: number): void {
    if (this.mode === "send") this.previewFirst += lines
    else if (this.mode === "browse") this.review.move(lines)
  }

  /** A screenful up or down: to the row nearest a screenful away. */
  private page(direction: 1 | -1): void {
    const laid = this.laid
    const review = this.review
    if (laid === null) return void review.move(direction * 10)
    const target = laid.start[review.cursor]! + direction * Math.max(1, this.body - 1)
    const stops = review.lines.flatMap((_, index) => (review.stop(index) ? [index] : []))
    const to = direction === 1 ? (stops.find((index) => laid.start[index]! >= target) ?? stops.at(-1)!) : (stops.findLast((index) => laid.start[index]! <= target) ?? stops[0]!)
    review.cursor = to
  }

  // ---------------------------------------------------------------- drawing

  /** The screen at a size. `typed` is what the editor holds, which decides how many rows it gets. */
  frame(columns: number, rows: number, typed = ""): ReviewFrame {
    return this.mode === "send" ? this.sendFrame(columns, rows, typed) : this.browseFrame(columns, rows, typed)
  }

  private browseFrame(columns: number, rows: number, typed: string): ReviewFrame {
    const review = this.review
    const current = review.lines[review.cursor]!.file
    const files = review.files
    const added = files.reduce((sum, file) => sum + file.added, 0)
    const removed = files.reduce((sum, file) => sum + file.removed, 0)
    const top: Span[][] = [
      truncateLine(
        [
          span(`Review of ${review.what}`, undefined, { bold: true }),
          span(" · ", "dim"),
          review.count === 0 ? span("no comments yet", "dim") : span(`${COMMENT_MARK} ${plural(review.count, "comment")}`, "accent", { bold: true }),
          span(` · ${plural(files.length, "file")} · +${added} -${removed}`, "dim"),
        ],
        columns,
      ),
    ]
    // The files: a few rows, the cursor's file among them.
    const listRows = Math.min(files.length, Math.max(1, Math.min(MAX_FILE_ROWS, Math.floor((rows - 8) / 4))))
    const listFirst = Math.max(0, Math.min(current - Math.floor(listRows / 2), files.length - listRows))
    for (let index = listFirst; index < listFirst + listRows; index += 1) {
      const file = files[index]!
      const here = index === current
      const says = about(file)
      const count = review.commentsOn(index)
      const tail = `${says === "" ? "" : ` · ${says}`}${count === 0 ? "" : `  ${COMMENT_MARK} ${count}`}`
      top.push(
        truncateLine(
          [span(here ? "▸ " : "  ", "accent"), span(truncate(file.path, Math.max(8, columns - 2 - textWidth(tail))), here ? undefined : "dim", { bold: here }), span(says === "" ? "" : ` · ${says}`, "dim"), span(count === 0 ? "" : `  ${COMMENT_MARK} ${count}`, "accent")],
          columns,
        ),
      )
    }
    top.push(rule(`file ${current + 1} of ${files.length}`, columns))

    const bottom: Span[][] = []
    let editor: EditorPlace | null = null
    if (this.notice !== null) bottom.push(truncateLine([span(this.notice.text, this.notice.tone)], columns))
    const editing = this.mode === "comment"
    const editorRows = editing ? editorHeight(typed, columns, rows) : 0
    if (editing) {
      const line = review.lines[review.cursor]!
      const on = line.kind as ReviewComment["on"]
      const place = placeText({ path: files[line.file]!.path, on, line: on === "removed" ? line.oldLine : line.newLine })
      bottom.push(rule(`${review.commentAt() === null ? "comment on" : "edit the comment on"} ${place}`, columns))
      for (let row = 0; row < editorRows; row += 1) bottom.push([span(row === 0 ? "› " : "  ", "accent")])
    }
    const hasComment = review.commentAt() !== null
    bottom.push(
      hint(
        editing
          ? [`Enter save${hasComment ? " (empty: delete it)" : ""} · Alt-Enter new line · Esc cancel`, "Enter save · Esc cancel"]
          : [
              `↑↓ line · [ ] hunk · n p file · c ${hasComment ? "edit · d delete" : "comment"} · s send${review.count === 0 ? "" : ` (${review.count})`} · Esc leave, comments kept`,
              `↑↓ [ ] n p move · c ${hasComment ? "edit · d delete" : "comment"} · s send · Esc leave`,
              `c ${hasComment ? "edit · d delete" : "comment"} · s send · Esc leave`,
            ],
        columns,
      ),
    )

    const body = Math.max(1, rows - top.length - bottom.length)
    this.body = body
    const laid = this.layout(columns)
    this.reveal(laid, body)
    const cursorLines = this.rowLines(review.cursor, columns, true)
    const cursorStart = laid.start[review.cursor]!
    const lines = [...top]
    for (let row = 0; row < body; row += 1) {
      const at = this.first + row
      lines.push(at >= cursorStart && at < cursorStart + cursorLines.length ? cursorLines[at - cursorStart]! : (laid.lines[at] ?? []))
    }
    if (editing) editor = { top: lines.length + bottom.length - 1 - editorRows, left: 2, width: Math.max(1, columns - 2), height: editorRows }
    lines.push(...bottom)
    return { lines: lines.slice(0, Math.max(0, rows)), editor }
  }

  private sendFrame(columns: number, rows: number, typed: string): ReviewFrame {
    const review = this.review
    const message = reviewMessage(review, typed)
    const files = new Set(review.ordered().map((comment) => comment.path)).size
    const editorRows = editorHeight(typed, columns, rows)
    const body = Math.max(1, rows - 4 - editorRows)
    this.body = body
    // The message as it will be sent, each line wrapped under its own indentation.
    const preview = message.split("\n").flatMap((line) => wrapLine([span(" "), span(sanitize(line))], columns, [span(` ${/^\s*/.exec(line)![0]}`)]))
    this.previewFirst = Math.max(0, Math.min(Math.max(0, preview.length - body), this.previewFirst))
    const shown = preview.length <= body ? "" : ` · lines ${this.previewFirst + 1}-${Math.min(preview.length, this.previewFirst + body)} of ${preview.length} · PgUp PgDn`
    const lines: Span[][] = [
      truncateLine([span("Send this review to the agent?", undefined, { bold: true }), span(` · ${COMMENT_MARK} ${plural(review.count, "comment")}`, "accent", { bold: true }), span(` on ${plural(files, "file")} of ${review.what}`, "dim")], columns),
      rule(`the message, as it will be sent${shown}`, columns),
    ]
    for (let row = 0; row < body; row += 1) lines.push(preview[this.previewFirst + row] ?? [])
    lines.push(rule("an overall note, if you want one: it goes above the comments", columns))
    const top = lines.length
    for (let row = 0; row < editorRows; row += 1) lines.push([span(row === 0 ? "› " : "  ", "accent")])
    lines.push(hint([`Enter ${this.delivery()} · Alt-Enter new line · Esc back to the review`, `Enter ${this.delivery()} · Esc back`, "Enter send · Esc back"], columns))
    return { lines: lines.slice(0, Math.max(0, rows)), editor: { top, left: 2, width: Math.max(1, columns - 2), height: editorRows } }
  }

  /** Every row at a width, without the cursor: laid out again only when the width or a comment changed. */
  private layout(columns: number): Laid {
    const review = this.review
    if (this.laid !== null && this.laid.columns === columns && this.laid.version === review.version) return this.laid
    const lines: Span[][] = []
    const start: number[] = []
    const height: number[] = []
    review.lines.forEach((line, index) => {
      if (line.kind === "file" && index > 0) lines.push([])
      const own = this.rowLines(index, columns, false)
      start.push(lines.length)
      height.push(own.length)
      lines.push(...own)
    })
    this.laid = { columns, version: review.version, lines, start, height }
    return this.laid
  }

  /** Scrolls so the cursor's row, with its comment, is on the screen, a little away from the edges where there is room. */
  private reveal(laid: Laid, body: number): void {
    const start = laid.start[this.review.cursor]!
    const height = Math.min(laid.height[this.review.cursor]!, body)
    const margin = Math.max(0, Math.min(2, Math.floor((body - height) / 2)))
    if (start - margin < this.first) this.first = start - margin
    else if (start + height + margin > this.first + body) this.first = start + height + margin - body
    this.first = Math.max(0, Math.min(Math.max(0, laid.lines.length - body), this.first))
  }

  private numberWidths(): { old: number; new: number } {
    if (this.widths !== null) return this.widths
    let old = 1
    let fresh = 1
    for (const line of this.review.lines) {
      if (line.oldLine !== null) old = Math.max(old, String(line.oldLine).length)
      if (line.newLine !== null) fresh = Math.max(fresh, String(line.newLine).length)
    }
    this.widths = { old, new: fresh }
    return this.widths
  }

  /** One row of the review as screen lines: the cursor's and the comment's marks, the line numbers (old, new), the sign and the text; its comment under it. */
  private rowLines(index: number, columns: number, cursor: boolean): Span[][] {
    const review = this.review
    const line = review.lines[index]!
    if (line.kind === "hunk") return wrapLine([span("   "), span(sanitize(line.text), "hunk")], columns, [span("     ")])
    if (line.kind === "note") return wrapLine([span("   "), span(line.text, "dim")], columns, [span("   ")])
    const comment = review.commentAt(index)
    const marks = [span(cursor ? "▌" : " ", "accent"), span(comment === null ? " " : COMMENT_MARK, "accent"), span(" ")]
    let out: Span[][]
    let under = 3
    if (line.kind === "file") {
      const says = about(review.files[line.file]!)
      out = wrapLine([...marks, span(line.text, cursor ? "selected" : undefined, { bold: true }), span(says === "" ? "" : ` · ${says}`, "dim")], columns, [span("     ")])
    } else {
      const widths = this.numberWidths()
      const numbers = `${String(line.oldLine ?? "").padStart(widths.old)} ${String(line.newLine ?? "").padStart(widths.new)}`
      under = 3 + textWidth(numbers) + 2
      const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
      out = wrapLine([...marks, span(numbers, cursor ? "selected" : "dim"), span(" "), span(`${sign}${sanitize(line.text)}`, line.kind === "context" ? "dim" : line.kind)], columns, [span(" ".repeat(under))])
    }
    if (comment !== null)
      comment.text.split("\n").forEach((text, at) => {
        out.push(...wrapLine([span(" ".repeat(under)), span(at === 0 ? "╰ " : "  ", "accent"), span(sanitize(text), undefined, { bold: true })], columns, [span(" ".repeat(under + 2))]))
      })
    // The cursor's mark runs down every line the row takes: its wrapped text and its comment.
    return cursor ? out.map((row, at) => (at === 0 || row[0] === undefined || !row[0].text.startsWith(" ") ? row : [span("▌", "accent"), { ...row[0], text: row[0].text.slice(1) }, ...row.slice(1)])) : out
  }
}

/** A line across the screen with a label in it. */
function rule(label: string, columns: number): Span[] {
  const text = truncate(`─ ${label} `, Math.max(1, columns))
  return [span(text, "dim"), span("─".repeat(Math.max(0, columns - textWidth(text))), "border")]
}

/** The longest of the hints that fits whole: a hint is never cut in the middle of a key. */
function hint(forms: readonly string[], columns: number): Span[] {
  const fits = forms.find((form) => textWidth(form) <= columns) ?? forms.at(-1)!
  return [span(truncate(fits, columns), "dim")]
}

/** The rows the editor takes for what it holds: one per wrapped line, up to a few. */
function editorHeight(typed: string, columns: number, rows: number): number {
  const room = Math.max(4, columns - 2)
  const wanted = typed.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((textWidth(line) + 1) / room)), 0)
  return Math.max(1, Math.min(wanted, MAX_EDITOR_ROWS, Math.max(1, Math.floor(rows / 4))))
}
