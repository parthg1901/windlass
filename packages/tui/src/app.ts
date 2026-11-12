/**
 * The full-screen TUI: the conversation, the session panel, the turn status,
 * the input with its mode, the command palette, and the dialogs, wired to a
 * backend (the ACP client, or the scripted demo engine).
 *
 * Screen, top to bottom:
 *   conversation (scrollable)                 │ panel (toggle, hidden when narrow)
 *   status: what the agent does now, or where the view is scrolled to
 *   input: mode label, the text being written (grows to a few lines)
 *   hints, or the matching commands while a `/command` is typed
 *
 * Keys follow the line-based CLI where it has them: Enter sends, Alt-Enter
 * (or a trailing backslash, or Ctrl-J) starts a new line, Up and Down recall
 * whole entries, the first Ctrl-C while the agent works stops it and a second
 * within two seconds exits at once, Ctrl-C at the prompt clears it, Ctrl-D on
 * an empty prompt leaves.
 */
import { BoxRenderable, type CliRenderer, type KeyEvent, TextRenderable, TextareaRenderable } from "@opentui/core"
import type { RevertPlan, RevertResult } from "@light-harness/core"
import { type Backend, BackendError, type BackendSession, type Delivery, type ModelChoice, type OpenSettings, type OpenTarget, type Question } from "./backend.ts"
import { COMMANDS, type CommandSpec, complete, parseCommand } from "./commands.ts"
import { fileList, formatDuration } from "./cli.ts"
import { plural, truncate, width as textWidth } from "./layout.ts"
import { PANEL_WIDTH, panelLines } from "./panel.ts"
import { type Span, type Theme, span } from "./theme.ts"
import { type Row, Transcript, expandable } from "./transcript.ts"
import { ConversationView, Dialog, type DialogSpec, LinesView } from "./views.ts"

/** How long after a first Ctrl-C a second one exits instead of waiting for the stop. */
export const DOUBLE_INTERRUPT_MS = 2000
/** How long leaving waits for the session to close before it exits anyway. */
export const CLOSE_TIMEOUT_MS = 3000
/** Below this width the panel hides itself unless asked for. */
export const PANEL_AUTO_WIDTH = 100
const MAX_INPUT_ROWS = 8
const HISTORY_LIMIT = 200

export interface AppOptions {
  readonly backend: Backend
  readonly theme: Theme
  readonly cwd: string
  readonly target: OpenTarget
  readonly settings: OpenSettings
  readonly debug: boolean
  readonly home: string | null
  readonly now?: () => number
  /** Leaves at once (the second Ctrl-C). Tests replace it. */
  readonly exitNow?: (code: number) => void
  /** The prompt a scripted demo turn starts with, put in the input for the user to send. */
  readonly suggest?: () => string | null
  /** Ticks for live durations; `false` in tests, which render on demand. */
  readonly ticking?: boolean
}

type Connection = "starting" | "connected" | "disconnected" | "not signed in" | "failed"

export class App {
  readonly transcript: Transcript
  readonly conversation: ConversationView
  readonly input: TextareaRenderable
  readonly dialog: Dialog
  private readonly panel: LinesView
  private readonly status: LinesView
  private readonly hints: LinesView
  private readonly modeLabel: TextRenderable
  /** What the mode label shows; `TextRenderable.content` is styled text and cannot be compared with a string. */
  private shownMode = ""
  private readonly inputRow: BoxRenderable
  private readonly now: () => number
  private session: BackendSession | null = null
  private connection: Connection = "starting"
  private mode: Delivery = "steer"
  private panelChoice: "auto" | "shown" | "hidden" = "auto"
  private lastInterrupt = 0
  private leaving: Promise<number> | null = null
  private finish: ((code: number) => void) | null = null
  readonly done: Promise<number>
  private readonly history: string[] = []
  private browsing = -1
  private draft = ""
  private paletteIndex = 0
  private paletteDismissed: string | null = null
  private contextWindows = new Map<string, number | null>()
  private timer: ReturnType<typeof setInterval> | null = null
  private pump: Promise<void> | null = null
  private busyCommand = false
  /** The reason the last open failed, for /reconnect. */
  private target: OpenTarget

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: AppOptions,
  ) {
    this.now = options.now ?? Date.now
    this.target = options.target
    this.transcript = new Transcript(this.now)
    const theme = options.theme
    this.done = new Promise((resolve) => {
      this.finish = resolve
    })

    const root = new BoxRenderable(renderer, { id: "root", flexDirection: "column", width: "100%", height: "100%" })
    renderer.root.add(root)
    const main = new BoxRenderable(renderer, { id: "main", flexDirection: "row", flexGrow: 1, width: "100%" })
    root.add(main)
    this.conversation = new ConversationView(renderer, this.transcript, theme, this.now, { id: "conversation", flexGrow: 1, height: "100%" })
    this.conversation.empty = "starting the engine…"
    this.conversation.debug = options.debug
    this.conversation.onToggle = (row) => this.toggle(row)
    main.add(this.conversation)
    this.panel = new LinesView(renderer, theme, (columns, rows) => this.panelContent(columns, rows), { id: "panel", width: PANEL_WIDTH, height: "100%", flexShrink: 0 })
    this.panel.border = true
    main.add(this.panel)
    this.status = new LinesView(renderer, theme, (columns) => [this.statusLine(columns)], { id: "status", height: 1, width: "100%" })
    root.add(this.status)
    this.inputRow = new BoxRenderable(renderer, { id: "input-row", flexDirection: "row", width: "100%", height: 1 })
    root.add(this.inputRow)
    this.modeLabel = new TextRenderable(renderer, { id: "mode", content: "› ", width: 2, height: 1, fg: theme.foreground })
    this.inputRow.add(this.modeLabel)
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      flexGrow: 1,
      height: "100%",
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
    this.input.onContentChange = () => this.inputChanged()
    this.inputRow.add(this.input)
    this.hints = new LinesView(renderer, theme, (columns) => this.hintLines(columns), { id: "hints", height: 1, width: "100%" })
    root.add(this.hints)
    this.dialog = new Dialog(renderer, theme, { id: "dialog", left: 0, top: 0, width: "100%", height: "100%" })
    root.add(this.dialog)
    this.input.focus()

    renderer.keyInput.on("keypress", (key: KeyEvent) => this.onKey(key))
    renderer.on("resize", () => this.layout())
    options.backend.onQuestion = (question) => this.ask(question)
    options.backend.onLog = (line, level) => this.serverLog(line, level)
    this.layout()
    if (options.ticking !== false)
      this.timer = setInterval(() => {
        if (!this.transcript.activity.executing && this.connection === "connected") return
        this.renderer.requestRender()
      }, 250)
  }

  /** Opens the first session. Resolves once it is open, or the failure is shown. */
  async start(): Promise<void> {
    await this.openSession(this.target)
  }

  // ---------------------------------------------------------------- sessions

  private async openSession(target: OpenTarget): Promise<boolean> {
    this.connection = "starting"
    this.conversation.empty = target.kind === "new" ? "starting the engine…" : "opening the session…"
    this.redraw()
    try {
      const session = await this.options.backend.open(target, this.options.cwd, this.options.settings)
      this.session = session
      this.connection = "connected"
      this.target = { kind: "resume", id: session.id }
      this.conversation.empty = this.welcome()
      this.pump = this.consume(session)
      void this.loadModels()
      this.suggest()
      this.redraw()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = error instanceof BackendError ? error.reason : null
      this.connection = reason === "auth_required" ? "not signed in" : "failed"
      this.conversation.empty = ""
      this.transcript.note([span(reason === "auth_required" ? "not signed in: " : "could not open the session: ", "error", { bold: true }), span(message, "error")], "error", "✗", [
        [span(reason === "auth_required" ? "Sign in, then type /reconnect (or /quit to leave)." : "Type /reconnect to try again, /sessions to pick another session, or /quit to leave.", "dim")],
      ])
      this.redraw()
      return false
    }
  }

  private async consume(session: BackendSession): Promise<void> {
    try {
      for await (const item of session.events) {
        this.transcript.apply(item.event, item.replay)
        if (!this.transcript.activity.executing) this.suggestIfIdle()
        // The mode label next to the input follows the turn starting and ending.
        if (this.modeText() !== this.shownMode) this.layout()
        this.renderer.requestRender()
      }
    } catch (error) {
      this.transcript.note(`the event stream failed: ${error instanceof Error ? error.message : String(error)}`, "error", "✗")
    }
    if (this.session !== session) return
    const lost = session.lost()
    if (lost === null) return
    this.connection = "disconnected"
    Object.assign(this.transcript.activity, { executing: false, call: null, checking: null, compacting: null, retry: null, stopping: false })
    this.transcript.note([span("the engine is gone: ", "error", { bold: true }), span(lost, "error")], "error", "✗", [[span(this.options.backend.restartable ? "Type /reconnect to start it again and resume this session, or /quit to leave." : "Type /quit to leave.", "dim")]])
    this.redraw()
  }

  private async switchTo(target: OpenTarget): Promise<void> {
    if (this.transcript.activity.executing) return this.say("stop the agent first (Ctrl-C), then switch sessions", "warn")
    const old = this.session
    this.session = null
    await old?.close(false)
    await this.pump
    this.transcript.reset()
    this.conversation.toBottom()
    this.conversation.selected = null
    await this.openSession(target)
  }

  private async reconnect(): Promise<void> {
    if (this.connection === "connected") return this.say("the engine is running; nothing to reconnect", "dim")
    const backend = this.options.backend
    if (backend.restart === undefined && this.connection === "disconnected") return this.say("this engine cannot be started again; /quit and start again", "warn")
    this.session = null
    this.transcript.reset()
    if (this.connection === "disconnected") await backend.restart?.().catch((error: unknown) => this.say(`could not start the engine: ${error instanceof Error ? error.message : String(error)}`, "error"))
    await this.openSession(this.target)
  }

  private async loadModels(): Promise<void> {
    const backend = this.options.backend
    if (backend.listModels === undefined || this.contextWindows.size > 0) return
    try {
      const listed = await backend.listModels()
      for (const model of listed.models) this.contextWindows.set(model.id, model.contextWindow)
      this.renderer.requestRender()
    } catch {
      // The panel shows "window unknown"; the model picker reports the error when it is opened.
    }
  }

  // ---------------------------------------------------------------- input

  private onKey(key: KeyEvent): void {
    const name = key.name
    const ctrl = key.ctrl
    const meta = key.meta || key.option
    const handled = () => {
      key.preventDefault()
      key.stopPropagation()
      this.redraw()
    }
    if (this.dialog.open) {
      this.dialog.key(name, key.sequence, ctrl, meta)
      return handled()
    }
    if (ctrl && name === "c") {
      this.ctrlC()
      return handled()
    }
    const text = this.input.plainText
    const palette = this.palette()
    if (palette.length > 0) {
      if (name === "up" || name === "down") {
        this.paletteIndex = (this.paletteIndex + (name === "up" ? -1 : 1) + palette.length) % palette.length
        return handled()
      }
      if (name === "tab") {
        this.setInput(`/${palette[this.paletteIndex % palette.length]!.name}${palette[this.paletteIndex % palette.length]!.args === "" ? "" : " "}`)
        return handled()
      }
      if (name === "escape") {
        this.paletteDismissed = text
        return handled()
      }
      if ((name === "return" || name === "kpenter") && !meta) {
        const chosen = palette[this.paletteIndex % palette.length]!
        const typed = parseCommand(text)
        const exact = typed?.spec !== null && typed?.spec !== undefined
        if (!exact && chosen.args !== "") {
          this.setInput(`/${chosen.name} `)
          return handled()
        }
        this.submit(exact ? text : `/${chosen.name}`)
        return handled()
      }
    }
    if ((name === "return" || name === "kpenter") && !meta && !ctrl && !key.shift) {
      if (text.endsWith("\\")) {
        // As in the line-based CLI: a trailing backslash continues on a new line.
        this.input.deleteCharBackward()
        this.input.newLine()
        return handled()
      }
      this.submit(text)
      return handled()
    }
    if (name === "up" && !meta && !ctrl && !key.shift && this.input.logicalCursor.row === 0 && this.history.length > 0) {
      this.recall(-1)
      return handled()
    }
    if (name === "down" && !meta && !ctrl && !key.shift && this.input.logicalCursor.row >= this.input.lineCount - 1 && this.browsing !== -1) {
      this.recall(1)
      return handled()
    }
    if (name === "pageup" || name === "pagedown") {
      this.conversation.page(name === "pageup" ? -1 : 1)
      return handled()
    }
    if (meta && (name === "up" || name === "down")) {
      this.conversation.select(name === "up" ? -1 : 1)
      return handled()
    }
    if (ctrl && (name === "home" || name === "end")) {
      if (name === "home") this.conversation.toTop()
      else this.conversation.toBottom()
      return handled()
    }
    if (ctrl && name === "o") {
      const row = this.conversation.selectedRow() ?? this.transcript.latestExpandable()
      if (row !== null) this.toggle(row)
      return handled()
    }
    if (ctrl && name === "t") {
      this.mode = this.mode === "steer" ? "queue" : "steer"
      return handled()
    }
    if (ctrl && name === "p") {
      this.panelChoice = this.panelVisible() ? "hidden" : "shown"
      this.layout()
      return handled()
    }
    if (ctrl && name === "l") {
      this.renderer.requestRender()
      return handled()
    }
    if (ctrl && name === "d" && text === "") {
      if (!this.transcript.activity.executing) void this.leave(0)
      return handled()
    }
    if (name === "escape") {
      if (this.conversation.selected !== null) this.conversation.selected = null
      else this.conversation.toBottom()
      return handled()
    }
  }

  private submit(text: string): void {
    const trimmed = text.trim()
    if (trimmed === "") return
    this.remember(text)
    this.setInput("")
    const command = parseCommand(trimmed)
    if (command !== null) return void this.command(command.spec, command.name, command.rest)
    this.send(text, this.transcript.activity.executing ? this.mode : "steer")
  }

  private send(text: string, delivery: Delivery): void {
    const session = this.session
    if (session === null || this.connection !== "connected") return this.say(this.connection === "starting" ? "the engine is still starting; try again in a moment" : "not connected: /reconnect first, or /quit", "warn")
    this.conversation.toBottom()
    session.send(text, delivery).then(
      (id) => {
        if (id === null) this.say("not sent: the session is not taking input right now", "warn")
      },
      (error: unknown) => this.say(`not sent: ${error instanceof Error ? error.message : String(error)}`, "error"),
    )
  }

  private ctrlC(): void {
    if (this.transcript.activity.executing && this.session !== null) {
      const now = this.now()
      if (now - this.lastInterrupt < DOUBLE_INTERRUPT_MS) {
        this.say("exiting without waiting for the stop", "warn")
        return this.exitNow(130)
      }
      if (this.transcript.activity.stopping && this.lastInterrupt !== 0) this.say("■ still stopping… press Ctrl-C again to exit now", "warn")
      this.lastInterrupt = now
      this.transcript.markStopAsked()
      this.session.interrupt()
      return
    }
    if (this.input.plainText !== "") return this.setInput("")
    this.say("press Ctrl-D or type /quit to leave")
  }

  private remember(text: string): void {
    if (this.history.at(-1) !== text) this.history.push(text)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    this.browsing = -1
    this.draft = ""
  }

  private recall(direction: -1 | 1): void {
    if (this.browsing === -1) {
      if (direction === 1) return
      this.draft = this.input.plainText
      this.browsing = this.history.length
    }
    const next = this.browsing + direction
    if (next < 0) return
    if (next >= this.history.length) {
      this.browsing = -1
      this.setInput(this.draft)
      return
    }
    this.browsing = next
    this.setInput(this.history[next]!)
  }

  private setInput(text: string): void {
    this.input.setText(text)
    this.input.gotoBufferEnd()
    this.inputChanged()
  }

  private inputChanged(): void {
    const text = this.input.plainText
    if (this.paletteDismissed !== null && this.paletteDismissed !== text) this.paletteDismissed = null
    this.paletteIndex = Math.min(this.paletteIndex, Math.max(0, this.palette().length - 1))
    this.layout()
  }

  /** In a demo the scripted prompt waits in the input, so a press of Enter plays the next turn. */
  private suggest(): void {
    const prompt = this.options.suggest?.() ?? null
    if (prompt !== null && this.input.plainText === "") this.setInput(prompt)
  }

  private suggestIfIdle(): void {
    if (this.options.suggest !== undefined) this.suggest()
  }

  // ---------------------------------------------------------------- commands

  private available(spec: CommandSpec): boolean {
    const session = this.session
    const backend = this.options.backend
    switch (spec.name) {
      case "undo":
      case "redo":
        return session?.revert !== undefined
      case "sessions":
        return backend.listSessions !== undefined
      case "model":
        return backend.listModels !== undefined && session?.setConfig !== undefined
      case "compact":
        return session?.compact !== undefined
      case "reconnect":
        return this.connection !== "connected" && this.connection !== "starting"
      case "queue":
        return this.transcript.activity.executing
      default:
        return true
    }
  }

  private palette(): CommandSpec[] {
    const text = this.input.plainText
    if (this.paletteDismissed === text || this.dialog.open) return []
    return complete(text, (spec) => this.available(spec))
  }

  private async command(spec: CommandSpec | null, name: string, rest: string): Promise<void> {
    if (spec === null) return this.say(`unknown command /${name}; /help lists them`, "warn")
    if (this.busyCommand && spec.name !== "quit" && spec.name !== "help") return this.say(`/${spec.name} waits for the command before it`, "warn")
    this.busyCommand = true
    try {
      switch (spec.name) {
        case "quit":
          return void this.leave(0)
        case "help":
          return void (await this.help())
        case "panel":
          this.panelChoice = this.panelVisible() ? "hidden" : "shown"
          return this.layout()
        case "debug":
          this.conversation.debug = !this.conversation.debug
          return this.say(this.conversation.debug ? `debug: events this client does not know are shown (${this.transcript.unknown.size} kinds so far)` : "debug: off")
        case "queue":
          if (rest === "") return this.say("/queue needs a message, e.g. /queue then update the changelog", "warn")
          return this.send(rest, this.transcript.activity.executing ? "queue" : "steer")
        case "undo":
        case "redo":
          return await this.revert(spec.name === "undo")
        case "sessions":
          return await this.pickSession()
        case "new":
          return await this.switchTo({ kind: "new" })
        case "model":
          return await this.pickModel()
        case "compact":
          if (this.session?.compact === undefined) return this.say("compaction on request is not offered by this server", "warn")
          this.say("compacting…")
          return await this.session.compact().catch((error: unknown) => this.say(`/compact failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
        case "reconnect":
          return await this.reconnect()
      }
    } finally {
      this.busyCommand = false
      this.redraw()
    }
  }

  private async revert(undo: boolean): Promise<void> {
    const command = undo ? "/undo" : "/redo"
    const session = this.session
    if (session?.revert === undefined || session.undoRevert === undefined) return this.say(`${command} is not available with this engine (${this.options.backend.label})`, "warn")
    if (this.transcript.activity.executing) return this.say(`${command} works only while the agent is idle; stop it first (Ctrl-C)`, "warn")
    const act = (options: { dryRun?: boolean; handEdits?: "ask" | "abort" }) => (undo ? session.revert!(options) : session.undoRevert!(options))
    try {
      const preview = await act({ dryRun: true })
      if (preview.kind !== "preview") return this.say(refusal(command, preview), "warn")
      const plan = preview.plan
      this.transcript.note([span(undo ? "going back to before your last message" : "bringing back what the last /undo took away"), span(` · ${plural(plan.messages, "message")}`, "dim")], "accent", undo ? "↶" : "↷", describePlan(plan))
      this.redraw()
      const byHand = plan.changes.filter((change) => change.handEdited)
      if (byHand.length === 0 && plan.target === null && undo) {
        const answer = await this.dialog.show({
          title: "Undo without restoring files?",
          detail: [[span(`Files are not restored: ${plan.unrestorable ?? "no snapshot"}.`)], [span("The conversation goes back; the files stay as they are.", "dim")]],
          items: [
            { id: "rewind", label: "Rewind the conversation only", key: "y" },
            { id: "cancel", label: "Change nothing", key: "n" },
          ],
          filterable: false,
          footer: "Enter choose · Esc cancel",
          cancel: "cancel",
        })
        if (answer !== "rewind") return this.say("nothing was changed")
      }
      const result = await act({ handEdits: "ask" })
      if (result.kind === "hand_edited") return this.say("nothing was changed")
      if (result.kind === "refused") return this.say(refusal(command, result), "warn")
      if (result.kind === "failed" && result.plan === null) return this.say(result.message, "error")
    } catch (error) {
      this.say(`${command} failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  private async pickSession(): Promise<void> {
    const backend = this.options.backend
    if (backend.listSessions === undefined) return this.say(`listing sessions is not available with this engine (${backend.label})`, "warn")
    let sessions
    try {
      sessions = await backend.listSessions(this.options.cwd)
    } catch (error) {
      return this.say(`could not list the sessions: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    const current = this.session?.id ?? null
    const answer = await this.dialog.show({
      title: `Sessions in ${truncate(this.options.cwd, 40)}`,
      detail: sessions.length === 0 ? [[span("No session yet in this directory.", "dim")]] : [],
      items: [
        { id: "\u0000new", label: "+ new session" },
        ...sessions.map((row) => ({
          id: row.id,
          label: truncate(row.title ?? "(untitled)", 34),
          detail: `${ago(this.now() - row.updatedAt)} · ${row.model}${row.effort === null ? "" : ` ${row.effort}`}${row.archived ? " · archived" : ""} · ${row.id.slice(0, 12)}`,
          current: row.id === current,
        })),
      ],
      filterable: true,
      footer: "type to filter · Enter open · Esc cancel",
      cancel: null,
    })
    if (answer === null || answer === current) return
    await this.switchTo(answer === "\u0000new" ? { kind: "new" } : { kind: "resume", id: answer })
  }

  private async pickModel(): Promise<void> {
    const backend = this.options.backend
    const session = this.session
    if (backend.listModels === undefined || session?.setConfig === undefined) return this.say(`choosing a model is not available with this engine (${backend.label})`, "warn")
    let models: readonly ModelChoice[]
    try {
      models = (await backend.listModels()).models
    } catch (error) {
      return this.say(`could not list the models: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    for (const model of models) this.contextWindows.set(model.id, model.contextWindow)
    const currentModel = this.transcript.session.model
    const chosen = await this.dialog.show({
      title: "Model",
      detail: [[span("Applies from the next step, also in the middle of a turn.", "dim")]],
      items: models.map((model) => ({
        id: model.id,
        label: model.id,
        detail: [model.name === model.id ? null : model.name, model.contextWindow === null ? null : `${Math.round(model.contextWindow / 1000)}k context`, model.isDefault ? "default" : null].filter((part) => part !== null).join(" · "),
        current: model.id === currentModel,
      })),
      filterable: true,
      footer: "Enter choose · Esc cancel",
      cancel: null,
    })
    if (chosen === null) return
    const model = models.find((candidate) => candidate.id === chosen)!
    const currentEffort = this.transcript.session.effort
    const effort =
      model.efforts.length === 0
        ? "default"
        : await this.dialog.show({
            title: `Reasoning effort for ${model.id}`,
            detail: [],
            items: [
              { id: "default", label: "default", detail: model.defaultEffort === null ? "the model's own" : `the model's own (${model.defaultEffort})`, current: currentEffort === null },
              ...model.efforts.map((value) => ({ id: value, label: value, current: currentEffort === value && model.id === currentModel })),
            ],
            filterable: false,
            footer: "Enter choose · Esc keeps the effort",
            cancel: null,
          })
    try {
      if (model.id !== currentModel) await session.setConfig("model", model.id)
      if (effort !== null && effort !== (currentEffort ?? "default")) await session.setConfig("effort", effort)
    } catch (error) {
      this.say(`could not switch: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  private async help(): Promise<void> {
    const keys: [string, string][] = [
      ["Enter", "send (while the agent works: steer, or queue with Ctrl-T)"],
      ["Alt-Enter, Ctrl-J, \\ at the end", "new line"],
      ["Up, Down", "earlier entries (on the first or last line)"],
      ["Ctrl-T", "while the agent works: steer the running turn ⇄ queue for after it"],
      ["Ctrl-C", "stop the agent (twice within 2 s: exit now); at the prompt: clear it"],
      ["Ctrl-D", "leave, on an empty prompt"],
      ["PageUp, PageDown, wheel", "scroll; Esc or Ctrl-End follows the output again"],
      ["Alt-Up, Alt-Down", "select a tool call, thought or turn ending"],
      ["Ctrl-O, click", "expand or collapse it (twice on a tool call: its full output)"],
      ["Ctrl-P", "show or hide the session panel"],
      ["Shift + drag", "select text with the mouse (most terminals)"],
    ]
    await this.dialog.show({
      title: "Help",
      detail: [
        ...keys.map(([key, what]) => [span(key.padEnd(26), "accent"), span(what)]),
        [],
        ...COMMANDS.filter((spec) => this.available(spec) || ["undo", "redo", "compact", "queue"].includes(spec.name)).map((spec) => [
          span(`/${spec.name}${spec.args === "" ? "" : ` ${spec.args}`}`.padEnd(26), "accent"),
          span(spec.description),
          span(this.available(spec) ? "" : " (not available now)", "dim"),
        ]),
      ],
      items: [],
      filterable: false,
      footer: "Esc close",
      cancel: null,
    })
  }

  /** The agent's question (the hand-edit question of an undo; tool approvals later) as a dialog. */
  private async ask(question: Question): Promise<string | null> {
    const keys = new Map<string, string>()
    const items = question.options.map((option, index) => {
      const key = option.kind === "reject" && !keys.has("n") ? "n" : option.kind === "allow" && index === 0 && !keys.has("y") ? "y" : String(index + 1)
      keys.set(key, option.id)
      return { id: option.id, label: option.label, key }
    })
    const cancel = question.options.find((option) => option.kind === "reject")?.id ?? null
    const answer = await this.dialog.show({ title: question.title, detail: question.detail.map((line) => [span(line)]), items, filterable: false, footer: "↑↓ Enter · keys · Esc cancel", cancel })
    this.redraw()
    return answer
  }

  private toggle(row: Row): void {
    if (!expandable(row)) return
    switch (row.kind) {
      case "tool": {
        const full = row.expand === 1 && (row.output.split("\n").length > 24 || (row.progress?.split("\n").length ?? 0) > 24 || (typeof (row.display as { diff?: unknown } | null)?.diff === "string" && String((row.display as { diff: string }).diff).split("\n").length > 24))
        row.expand = row.expand === 0 ? 1 : full ? 2 : 0
        break
      }
      case "reasoning":
      case "outcome":
        row.expanded = !row.expanded
        break
      default:
        return
    }
    this.conversation.selected = row.id
    this.transcript.changed(row)
    this.conversation.keepInView(row)
    this.redraw()
  }

  // ---------------------------------------------------------------- leaving

  /** Leaves through the one door: the session closes (as a shutdown, bounded), the server stops, the terminal is put back. */
  leave(code: number): Promise<number> {
    if (this.leaving !== null) {
      this.exitNow(code)
      return this.leaving
    }
    this.leaving = (async () => {
      this.connection = this.connection === "connected" ? "disconnected" : this.connection
      this.status.lines = []
      this.redraw()
      const session = this.session
      this.session = null
      await within(CLOSE_TIMEOUT_MS, (async () => {
        await session?.close(true)
        await this.options.backend.stop()
      })())
      this.dispose()
      this.finish?.(code)
      return code
    })()
    return this.leaving
  }

  private exitNow(code: number): void {
    this.dispose()
    if (this.options.exitNow !== undefined) return this.options.exitNow(code)
    this.finish?.(code)
  }

  /** The session the TUI shows, for the line printed after it exits. */
  get sessionId(): string | null {
    return this.transcript.session.id ?? this.session?.id ?? null
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  // ---------------------------------------------------------------- drawing

  private say(text: string, tone: "dim" | "warn" | "error" = "dim"): void {
    this.transcript.note([span(text, tone === "dim" ? "dim" : tone)], tone, tone === "error" ? "✗" : tone === "warn" ? "!" : "·")
    this.redraw()
  }

  private serverLog(line: string, level: "warn" | "error" | "info"): void {
    if (level === "info") return
    this.transcript.note([span("engine: ", "dim"), span(line, level === "error" ? "error" : "dim")], level === "error" ? "error" : "dim", level === "error" ? "✗" : "·")
    this.renderer.requestRender()
  }

  redraw(): void {
    this.renderer.requestRender()
  }

  private panelVisible(): boolean {
    const columns = this.renderer.width
    if (this.panelChoice === "hidden") return false
    if (this.panelChoice === "shown") return columns >= 60
    return columns >= PANEL_AUTO_WIDTH
  }

  /** Sizes that depend on the content: the input's height, the panel, the mode label. */
  layout(): void {
    const visible = this.panelVisible()
    this.panel.visible = visible
    const label = this.modeText()
    this.shownMode = label
    this.modeLabel.content = label
    this.modeLabel.width = textWidth(label)
    const columns = Math.max(10, this.renderer.width - textWidth(label))
    const rows = this.input.plainText.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((textWidth(line) + 1) / columns)), 0)
    const maxRows = Math.max(1, Math.min(MAX_INPUT_ROWS, Math.floor(this.renderer.height / 3)))
    this.inputRow.height = Math.max(1, Math.min(maxRows, rows))
    const palette = this.palette()
    this.hints.height = palette.length === 0 ? 1 : Math.min(palette.length, 6)
    this.redraw()
  }

  private modeText(): string {
    if (!this.transcript.activity.executing) return "› "
    return this.mode === "steer" ? "steer › " : "queue › "
  }

  private welcome(): string {
    return this.options.suggest === undefined ? "Type a message and press Enter. /help lists keys and commands." : "Demo: the scripted prompt is in the input; press Enter to play the turn. /help lists keys."
  }

  private statusLine(columns: number): Span[] {
    const activity = this.transcript.activity
    const now = this.now()
    const parts: Span[] = []
    if (this.connection !== "connected") parts.push(span(this.connection === "starting" ? "⋯ starting the engine" : `✗ ${this.connection}`, this.connection === "starting" ? "dim" : "error"))
    else if (activity.executing) parts.push(...this.activityText(now))
    else parts.push(span("● ready", "dim"))
    if (this.conversation.scrolledAway) {
      const below = this.conversation.newBelow
      parts.push(span(`   ↑ scrolled${below > 0 ? ` · ${plural(below, "new line")} below` : ""} · Esc follows`, "warn"))
    }
    const left = parts
    const turn = activity.executing && activity.turnStartedAt !== null ? `turn ${formatDuration(Math.max(0, now - activity.turnStartedAt))} · ${plural(activity.steps, "step")}` : ""
    const right = [span(turn, "dim")]
    const used = left.reduce((sum, part) => sum + textWidth(part.text), 0)
    const rightWidth = textWidth(turn)
    if (rightWidth === 0 || used + rightWidth + 2 > columns) return left
    return [...left, span(" ".repeat(columns - used - rightWidth)), ...right]
  }

  private activityText(now: number): Span[] {
    const activity = this.transcript.activity
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(now / 100) % 10]!
    const running = this.transcript.rows.filter((row) => row.kind === "tool" && row.phase === "running") as Extract<Row, { kind: "tool" }>[]
    if (activity.stopping) {
      const waiting = running.length > 0 ? ` · waiting for ${running.length === 1 ? running[0]!.name : `${running.length} tools`} to stop` : ""
      return [span(`${spinner} stopping`, "warn"), span(waiting, "dim")]
    }
    if (running.length > 0) {
      const first = running[0]!
      const since = Math.min(...running.map((row) => row.runningSince ?? now))
      const what = running.length === 1 ? `running ${first.name} ${first.arg}` : `${running.length} tools running: ${running.map((row) => row.name).join(", ")}`
      return [span(`${spinner} `, "accent"), span(truncate(what, 60)), span(` · ${formatDuration(now - since)}`, "dim")]
    }
    if (activity.checking !== null) {
      const tail = activity.checking.progress?.split("\n").filter((line) => line.trim() !== "").at(-1)
      return [span(`${spinner} `, "accent"), span(`running checks: ${activity.checking.names.join(", ")}`), span(` · ${formatDuration(now - activity.checking.since)}${tail === undefined ? "" : ` · ${truncate(tail, 30)}`}`, "dim")]
    }
    if (activity.compacting !== null) return [span(`${spinner} `, "accent"), span(activity.compacting.repairing ? "compacting · asking the model to fix its summary" : "compacting the conversation"), span(` · ${formatDuration(now - activity.compacting.since)}`, "dim")]
    if (activity.retry !== null) return [span(`${spinner} `, "warn"), span(`waiting to retry (attempt ${activity.retry.attempt})`), span(` · ${formatDuration(Math.max(0, activity.retry.until - now))}`, "dim")]
    if (activity.call !== null) {
      const thinking = this.transcript.rows.findLast((row) => row.kind === "reasoning" && row.streaming && row.messageId === activity.call!.messageId)
      const writing = this.transcript.rows.findLast((row) => row.kind === "tool" && row.phase === "writing" && row.messageId === activity.call!.messageId)
      const doing = writing !== undefined ? `writing a ${(writing as { name: string }).name} call` : thinking !== undefined ? "thinking" : "model call"
      return [span(`${spinner} `, "accent"), span(doing), span(` · ${activity.call.model}${activity.call.attempt > 1 ? ` · attempt ${activity.call.attempt}` : ""} · ${formatDuration(now - activity.call.since)}`, "dim")]
    }
    return [span(`${spinner} `, "accent"), span("working")]
  }

  private hintLines(columns: number): Span[][] {
    const palette = this.palette()
    if (palette.length > 0) {
      const index = this.paletteIndex % palette.length
      const shown = palette.slice(Math.max(0, Math.min(index - 2, palette.length - 6)), Math.max(0, Math.min(index - 2, palette.length - 6)) + 6)
      return shown.map((spec) => {
        const chosen = spec === palette[index]
        return [span(chosen ? "› " : "  ", "accent"), span(`/${spec.name}`, chosen ? "selected" : "accent"), span(spec.args === "" ? "" : ` ${spec.args}`, "dim"), span(`  ${spec.description}`, "dim")]
      })
    }
    const running = this.transcript.activity.executing
    const narrow = columns < 80
    const hint = running
      ? this.mode === "steer"
        ? narrow
          ? "Enter steers · Ctrl-T queue · Ctrl-C stop"
          : "Enter steers the running turn (seen after the current step) · Ctrl-T: queue instead · Ctrl-C stop"
        : narrow
          ? "Enter queues · Ctrl-T steer · Ctrl-C stop"
          : "Enter queues for after this turn · Ctrl-T: steer instead · Ctrl-C stop"
      : narrow
        ? "Enter send · / commands · Ctrl-P panel"
        : "Enter send · Alt-Enter new line · / commands · Ctrl-O expand · Ctrl-P panel · Ctrl-D quit"
    return [[span(truncate(hint, columns), "dim")]]
  }

  private panelContent(columns: number, rows: number): Span[][] {
    const model = this.transcript.session.model
    return panelLines(
      {
        session: { ...this.transcript.session, id: this.transcript.session.id ?? this.session?.id ?? null, cwd: this.transcript.session.cwd ?? this.options.cwd },
        calls: this.transcript.calls,
        activity: this.transcript.activity,
        now: this.now(),
        contextWindow: model === null ? null : (this.contextWindows.get(model) ?? null),
        connection: this.connection === "connected" ? "connected" : this.connection,
        home: this.options.home,
      },
      columns,
      rows,
    ).concat(this.options.backend.label === "acp" ? [] : [[], [span(this.options.backend.label, "dim")]])
  }
}

function describePlan(plan: RevertPlan): Span[][] {
  if (plan.target === null) return [[span(`files are not restored: ${plan.unrestorable ?? "no snapshot"}`, "warn")]]
  if (plan.changes.length === 0) return [[span("no file needs to change", "dim")]]
  const describe = (status: string) => (status === "added" ? "restored" : status === "deleted" ? "removed" : "changed back")
  const lines = ["modified", "mode_changed", "type_changed", "added", "deleted"].flatMap((status) => {
    const paths = plan.changes.filter((change) => change.status === status).map((change) => `${change.path}${change.handEdited ? " (edited by hand)" : ""}`)
    return paths.length === 0 ? [] : [[span(`${describe(status)}: `, "dim"), span(fileList(paths, 6))]]
  })
  if (plan.kept.length > 0) lines.push([span(`left alone (ignored or never recorded): ${fileList(plan.kept.map((item) => item.path), 6)}`, "dim")])
  return lines
}

function refusal(command: string, result: RevertResult): string {
  if (result.kind === "refused" && result.reason === "busy") return `${command} works only while the agent is idle; stop it first (Ctrl-C)`
  if (result.kind === "refused" && result.reason === "nothing_to_revert") return command === "/undo" ? "there is no turn to undo" : "there is nothing to redo"
  if (result.kind === "hand_edited") return "files were edited by hand in the meantime; nothing was changed"
  return `${command}: ${"message" in result ? result.message : "nothing was changed"}`
}

function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "?"
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`
  return `${Math.round(ms / 86_400_000)} d ago`
}

async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms)
  })
  const finished = await Promise.race([work.then(() => true as const, () => true as const), timeout])
  clearTimeout(timer)
  return finished
}

export type { DialogSpec }
