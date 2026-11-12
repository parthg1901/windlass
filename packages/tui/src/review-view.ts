/**
 * The review of a turn's diff on the screen: a full-screen view over the
 * conversation, drawn from a `ReviewScreen` (`review.ts`), with the editor a
 * comment or the overall note is written in. It also keeps what was written
 * and not sent, per turn, for as long as the session stays open here.
 *
 * For the app it is three calls: `run` (fetch the diff, show the view, and
 * say what came of it: a sentence for the conversation, a message to send),
 * `key` while it is open, and `target` to name the turn `/review` is about.
 */
import { type KeyEvent, type OptimizedBuffer, Renderable, type RenderContext, TextareaRenderable } from "@opentui/core"
import type { DiffResult } from "./backend.ts"
import { type EditorPlace, Review, ReviewScreen, reviewMessage } from "./review.ts"
import type { Theme } from "./theme.ts"
import type { OutcomeRow, Row } from "./transcript.ts"
import { clearRect, drawLine } from "./views.ts"

/** The turn a review is asked for. */
export interface ReviewTarget {
  /** `null`: the latest turn, as the engine knows it. */
  readonly executionId: string | null
  /** The turn's number as its ending row shows it; `null` when the conversation does not say. */
  readonly turn: number | null
  readonly latest: boolean
}

export interface ReviewRequest extends ReviewTarget {
  readonly sessionId: string
  readonly diff: (params: { readonly executionId?: string }) => Promise<DiffResult>
  /** What Enter does with the message right now, for the hint (`sends it`, or how it reaches an agent at work). */
  readonly delivery: () => string
}

/** What came of a review: a sentence for the conversation, and the message to send when the user sent it. */
export interface ReviewOutcome {
  readonly say: { readonly text: string; readonly tone: "dim" | "warn" | "error" } | null
  readonly message: string | null
}

/**
 * The turn `/review` is about: the one whose ending row is selected, or that
 * a selected row belongs to; with nothing selected, or with `executionId`
 * given (the turn a diff is already shown of), that turn or the latest.
 */
export function reviewTarget(rows: readonly Row[], selected: Row | null, executionId: string | null = null): ReviewTarget {
  const ended = (row: Row): row is OutcomeRow => row.kind === "outcome" && row.executionId !== null
  const latest = rows.findLast(ended)
  const at = selected === null ? -1 : rows.indexOf(selected)
  const of = executionId !== null ? rows.find((row): row is OutcomeRow => ended(row) && row.executionId === executionId) : at === -1 ? latest : (rows.slice(at).find(ended) ?? latest)
  return { executionId: of?.executionId ?? executionId, turn: of?.turn ?? null, latest: of === undefined || of === latest }
}

export class ReviewView extends Renderable {
  screen: ReviewScreen | null = null
  /** The editor of the comment being written, and of the overall note. */
  readonly editor: TextareaRenderable
  private resolve: ((how: "leave" | "send") => void) | null = null
  /** What was written and not sent, per turn, of one session. */
  private readonly kept = new Map<string, Review>()
  private keptFor: string | null = null
  private placed: EditorPlace | null = null

  constructor(
    ctx: RenderContext,
    private readonly theme: Theme,
    options: ConstructorParameters<typeof Renderable>[1],
  ) {
    super(ctx, { ...options, position: "absolute", zIndex: 95, visible: false })
    this.focusable = true
    this.editor = new TextareaRenderable(ctx, {
      id: "review-editor",
      position: "absolute",
      left: 2,
      top: 0,
      width: 10,
      height: 1,
      visible: false,
      wrapMode: "word",
      textColor: theme.foreground,
      focusedTextColor: theme.foreground,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
      cursorColor: theme.foreground,
      placeholder: "",
      keyBindings: [
        { name: "return", meta: true, action: "newline" },
        { name: "kpenter", meta: true, action: "newline" },
      ],
    })
    this.editor.onContentChange = () => this.arrange()
    this.add(this.editor)
    this.onMouseScroll = (event) => {
      const direction = event.scroll?.direction
      if (direction !== "up" && direction !== "down") return
      this.screen?.scroll(direction === "up" ? -3 : 3)
      this.requestRender()
    }
  }

  get open(): boolean {
    return this.screen !== null
  }

  /**
   * Fetches the turn's diff and, when there is something to review, shows the
   * view until the user leaves or sends. A turn that changed no file and a
   * diff that cannot be had are said in a sentence instead of an empty view.
   */
  async run(request: ReviewRequest): Promise<ReviewOutcome> {
    const what = request.turn === null ? "the latest turn" : `turn ${request.turn}`
    let result: DiffResult
    try {
      result = await request.diff(request.executionId === null ? {} : { executionId: request.executionId })
    } catch (error) {
      return { say: { text: `/review failed: ${error instanceof Error ? error.message : String(error)}`, tone: "error" }, message: null }
    }
    if (!result.available) return { say: { text: `no review of ${what}: its diff is not available: ${result.message}`, tone: "dim" }, message: null }
    if (result.files.length === 0) return { say: { text: `nothing to review: ${what} changed no file`, tone: "dim" }, message: null }
    if (this.keptFor !== request.sessionId) this.kept.clear()
    this.keptFor = request.sessionId
    const key = result.executionId ?? request.executionId ?? `${result.from}..${result.to}`
    const review = this.kept.get(key) ?? new Review({ turn: request.turn, latest: request.latest }, result.files)
    this.kept.set(key, review)
    const screen = new ReviewScreen(review)
    screen.delivery = request.delivery
    // Comments kept on other turns are easy to lose sight of once a later turn has ended.
    const others = [...this.kept.values()].filter((other) => other !== review && other.count > 0)
    if (others.length > 0) screen.notice = { text: `comments are kept on ${others.map((other) => other.what).join(", ")} too: select that turn's ending row (Alt-Up), then /review`, tone: "dim" }
    const how = await this.show(screen)
    if (how === "send") {
      this.kept.delete(key)
      return { say: null, message: reviewMessage(review) }
    }
    if (review.count === 0 && review.note === "") {
      this.kept.delete(key)
      return { say: null, message: null }
    }
    const written = review.count === 0 ? "its overall note is" : review.count === 1 ? "its comment is" : `its ${review.count} comments are`
    const again = request.latest ? "/review opens it again (once a later turn has ended: with this turn's ending row selected)" : "/review with this turn's ending row selected opens it again"
    return { say: { text: `the review of ${what} was closed without sending: ${written} kept until this session is closed · ${again}`, tone: "dim" }, message: null }
  }

  private show(screen: ReviewScreen): Promise<"leave" | "send"> {
    this.close("leave")
    this.screen = screen
    this.visible = true
    // The keys' focus leaves the input, so a paste while reading the diff does not land there unseen.
    this.focus()
    this.requestRender()
    return new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  close(how: "leave" | "send"): void {
    const resolve = this.resolve
    this.resolve = null
    this.screen = null
    this.editor.visible = false
    this.editor.blur()
    this.blur()
    this.visible = false
    this.requestRender()
    resolve?.(how)
  }

  /** A key while the view is open. `false`: the key belongs to the text being written, and the editor takes it. */
  key(key: KeyEvent): boolean {
    const screen = this.screen
    if (screen === null) return false
    const before = screen.mode
    const typed = this.editor.plainText
    // As in the input: a backslash at the end of the line goes on with a new line.
    if (before !== "browse" && (key.name === "return" || key.name === "kpenter") && !key.meta && !key.option && !key.ctrl && !key.shift && typed.endsWith("\\")) {
      this.editor.deleteCharBackward()
      this.editor.newLine()
      return true
    }
    const came = screen.key({ name: key.name, sequence: key.sequence, ctrl: key.ctrl, meta: key.meta || key.option, shift: key.shift }, typed)
    if (came === "pass") return false
    if (came === "leave" || came === "send") {
      this.close(came)
      return true
    }
    if (screen.mode !== before) this.editing(screen)
    this.arrange()
    return true
  }

  /** Hands the keys to the editor when something is being written, and takes them back after. */
  private editing(screen: ReviewScreen): void {
    if (screen.mode === "browse") {
      this.editor.visible = false
      this.focus()
      return
    }
    this.editor.setText(screen.draft)
    this.editor.gotoBufferEnd()
    this.editor.visible = true
    this.editor.focus()
  }

  private size(): { width: number; height: number } {
    return { width: this.parent?.width ?? this.width, height: this.parent?.height ?? this.height }
  }

  /** Puts the editor where the frame has room for it. */
  private arrange(): void {
    const screen = this.screen
    if (screen === null) return
    const { width, height } = this.size()
    const place = screen.frame(width, height, this.editor.plainText).editor
    const placed = this.placed
    if (place !== null && (placed === null || placed.top !== place.top || placed.left !== place.left || placed.width !== place.width || placed.height !== place.height)) {
      this.editor.top = place.top
      this.editor.left = place.left
      this.editor.width = place.width
      this.editor.height = place.height
      this.placed = place
    }
    this.requestRender()
  }

  /** The view as text at the current size, for tests. */
  text(): string {
    const screen = this.screen
    if (screen === null) return ""
    const { width, height } = this.size()
    return screen
      .frame(width, height, this.editor.plainText)
      .lines.map((line) => line.map((part) => part.text).join("").trimEnd())
      .join("\n")
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const screen = this.screen
    if (screen === null) return
    const { width, height } = this.size()
    const frame = screen.frame(width, height, this.editor.plainText)
    clearRect(buffer, this.theme, 0, 0, width, height)
    frame.lines.forEach((line, row) => drawLine(buffer, this.theme, 0, row, width, line))
    // After a resize the editor's place follows with the next frame.
    const place = frame.editor
    if (place !== null && (this.placed === null || this.placed.top !== place.top || this.placed.width !== place.width || this.placed.height !== place.height)) queueMicrotask(() => this.arrange())
  }
}
