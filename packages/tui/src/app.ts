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
import { brand } from "@windlass/core"
import { BoxRenderable, type CliRenderer, type KeyEvent, TextRenderable, TextareaRenderable } from "@opentui/core"
import type { RevertPlan, RevertResult } from "@windlass/core"
import { type ApprovalAnswer, type ApprovalAsk, type ApprovalInfo, type Backend, BackendError, type BackendSession, type Delivery, type DiffResult, type ModelChoice, type OpenSettings, type OpenTarget, type Question } from "./backend.ts"
import { DockState, QUIET_MS, commandOverflows, dockLines } from "./approval.ts"
import { CLIENT_COMMANDS, COMMANDS, PALETTE_ROWS, type CommandSpec, complete, fileCommands, findFileCommand, paletteLines, parseCommand } from "./commands.ts"
import { COMMAND_SCOPE, agentProblemLines, commandProblemLines, compactText, requestsText, unusableCommandLines } from "./cli.ts"
import { COPY_NOTE, wakeAddEntry, wakeAddUsageLines, wakeCreatedLines, wakeNotFiringText, watchEntry, watchLines, changeLabel, fileList, formatDuration, hooksLines, lspLines, mcpApprovedText, mcpFailureText, mcpLines, mcpNotWaitingText, memoryAction, memoryLines, nearest, rememberArgs, skillsLines, wakeLines, webhookSecretLines, type Line } from "./cli.ts"
import { CHANGED_DURING_COMMAND, hookAsk, hookAskId, inRows, lspAskId, lspServerAsk, mcpAskId, mcpServerAsk, noteOf } from "./features.ts"
import type { CommandsResult, HookInfo, HooksStateResult, LspServerInfo, LspStateResult, McpServerInfo, McpStateResult, WakeCreateParams } from "@windlass/acp/extensions"
import { plural, truncate, width as textWidth } from "./layout.ts"
import { PANEL_WIDTH, middle, panelLines, panelWidth, shorten } from "./panel.ts"
import { type Span, type Theme, span } from "./theme.ts"
import { fileDiffLines } from "./rows.ts"
import { ReviewView, reviewTarget } from "./review-view.ts"
import { type OutcomeRow, type Row, type ToolRow, Transcript, expandable, turnDiffParams } from "./transcript.ts"
import { forkPointOfTurn } from "@windlass/acp/turns"
import { ConversationView, Dialog, type DialogSpec, LinesView, Pager } from "./views.ts"

/** What a demo offers in place of `/diff` and `/review`: its turn is a recording, with no real files behind it. */
const DEMO_DIFFS = "Its turn changed no real file; Ctrl-O on the turn's ending row shows the diffs its tool calls reported"

/** How long after a first Ctrl-C a second one exits instead of waiting for the stop. */
export const DOUBLE_INTERRUPT_MS = 2000
/** How long leaving waits for the session to close before it exits anyway. */
export const CLOSE_TIMEOUT_MS = 3000
/** Below this width the panel hides itself unless asked for. */
export const PANEL_AUTO_WIDTH = 100
const MAX_INPUT_ROWS = 8
/** The width of the key column in the help: the longest key and a space. */
const KEY_COLUMN = 33
/** The approval dock takes at most this share of the screen's rows. */
const DOCK_SHARE = 0.6
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

/**
 * A question about something the project's configuration names and the user
 * has not approved (an MCP server, a hook, a language server), as the dock
 * shows it, and what an answer does. `id` names exactly that definition.
 */
interface FeatureQuestion {
  readonly id: string
  readonly ask: ApprovalAsk
  /** What the question is about, for the status line: `the hook "lint"`. */
  readonly subject: string
  readonly answer: (allow: boolean) => Promise<void>
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
  /** The background commands the "still running" line was last said for, so a turn that ends with the same ones does not say it again. */
  private backgroundSaid = ""
  /** A demo said once in full why a command does nothing in it; later answers are short. */
  private demoExplained = false
  private leaving: Promise<number> | null = null
  private finish: ((code: number) => void) | null = null
  readonly done: Promise<number>
  private readonly history: string[] = []
  private browsing = -1
  private draft = ""
  private paletteIndex = 0
  private paletteDismissed: string | null = null
  /** The session's command files as last listed: what the palette offers after the interface's own commands. */
  private commandFiles: CommandsResult | null = null
  /** Messages held until the questions about the project's configuration are answered, and the answers being recorded. */
  private readonly featureWaiters: (() => void)[] = []
  private featureAnswering = 0
  /** Notes written with /remember before the session's memory existed (it starts with the first turn): saved once it has. */
  private keptNotes: { readonly session: BackendSession; readonly text: string; readonly scope: "user" | "project" }[] = []
  /** The entry starts with a slash: the command files were listed when it began to. */
  private typingCommand = false
  private contextWindows = new Map<string, number | null>()
  private timer: ReturnType<typeof setInterval> | null = null
  private pump: Promise<void> | null = null
  private busyCommand = false
  /** The reason the last open failed, for /reconnect. */
  private target: OpenTarget
  /** The approval question waiting for the user, and how to answer it. */
  private dock: { readonly state: DockState; readonly answer: (answer: ApprovalAnswer | null) => void; readonly feature?: FeatureQuestion } | null = null
  /**
   * What the project's configuration names and the user has not approved (an
   * MCP server, a hook, a language server), waiting for the user's answer in
   * the dock one after another; and the ones asked about.
   */
  private readonly featureQuestions: FeatureQuestion[] = []
  /** The questions whose command did not fit the dock and was printed in full above it. */
  private readonly printedCommands = new Set<string>()
  private readonly asked = new Set<string>()
  /** Failures already told, by server and reason. */
  private readonly toldFailures = new Set<string>()
  private unwatchMcp: (() => void) | null = null
  private readonly dockView: LinesView
  readonly pager: Pager
  /** The review of a turn's changes, and the turn whose diff the reader shows (r opens its review). */
  readonly review: ReviewView
  private diffTurn: { readonly executionId: string | null; readonly endSeq: number | null } | null = null
  /** When the user last typed in the input: the dock does not take the focus from someone typing. */
  private lastTyped = 0
  /** How the session's tool calls are approved, as the server last said. */
  approvalInfo: ApprovalInfo | null = null
  /**
   * Why no session is open, as a sentence, while that is so: the sign-in is
   * missing, the session is in use elsewhere, the engine went away. Leaving
   * then exits with 1 and says it, as the line CLI does.
   */
  problem: string | null = null

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
    this.dockView = new LinesView(renderer, theme, (columns, rows) => (this.dock === null ? [] : dockLines(this.dock.state, columns, rows, this.now(), !this.transcript.activity.executing)), { id: "approval", height: 0, width: "100%", visible: false })
    root.add(this.dockView)
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
    this.pager = new Pager(renderer, theme, { id: "pager", left: 0, top: 0, width: "100%", height: "100%" })
    root.add(this.pager)
    this.review = new ReviewView(renderer, theme, { id: "review", left: 0, top: 0, width: "100%", height: "100%" })
    root.add(this.review)
    this.input.focus()
    this.pager.asking = () => this.asking()

    renderer.keyInput.on("keypress", (key: KeyEvent) => this.onKey(key))
    renderer.on("resize", () => this.layout())
    options.backend.onQuestion = (question) => this.ask(question)
    options.backend.onApproval = (ask, signal) => this.approve(ask, signal)
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
    // What was asked about and told belongs to the session it was said in: another session asks again.
    this.asked.clear()
    this.printedCommands.clear()
    this.toldFailures.clear()
    this.conversation.empty = target.kind === "new" ? "starting the engine…" : "opening the session…"
    this.redraw()
    try {
      const session = await this.options.backend.open(target, this.options.cwd, this.options.settings)
      this.session = session
      this.connection = "connected"
      this.problem = null
      this.target = { kind: "resume", id: session.id }
      this.conversation.empty = this.welcome()
      this.pump = this.consume(session)
      this.unwatchMcp?.()
      const unwatch = [session.onMcp?.((state) => this.mcpChanged(session, state)), session.onHooks?.((state) => this.hooksChanged(session, state)), session.onLsp?.((state) => this.lspChanged(session, state))]
      this.unwatchMcp = () => unwatch.forEach((off) => off?.())
      this.commandFiles = null
      void this.lookAtFeatures(session)
      void this.listCommandFiles()
      void this.loadModels()
      void this.refreshApproval()
      void session.title?.().then(
        (title) => {
          if (title !== null && this.session === session) this.transcript.session.title = title
          this.redraw()
        },
        () => {},
      )
      this.suggest()
      this.redraw()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = error instanceof BackendError ? error.reason : null
      this.connection = reason === "auth_required" ? "not signed in" : "failed"
      this.conversation.empty = ""
      if (reason === "auth_required") {
        // The way forward, step by step: the sign-in is made outside, and the engine reads it again on /reconnect.
        this.problem = `${message}; run \`${brand.binary} login\` to sign in with ChatGPT, then try again`
        this.transcript.note([span(message === "not signed in" ? "not signed in" : `the sign-in cannot be used: ${message}`, "error", { bold: true })], "error", "✗", [
          [span("To sign in, run ", "dim"), span(`${brand.binary} login`, "accent"), span(" in another terminal (it opens a browser, or prints an address to open).", "dim")],
          [span("Then type ", "dim"), span("/reconnect", "accent"), span(" here: it picks the sign-in up. ", "dim"), span("/quit", "accent"), span(" leaves.", "dim")],
        ])
      } else {
        this.problem = `could not open the session: ${message}`
        this.transcript.note([span("could not open the session: ", "error", { bold: true }), span(message, "error")], "error", "✗", [
          [span("Type /reconnect to try again, /sessions to pick another session, or /quit to leave.", "dim")],
        ])
      }
      this.redraw()
      return false
    }
  }

  /**
   * As soon as a session is open: a project's hook, language server or MCP
   * server that waits for an approval is put in the dock, one question after
   * the other, before any message. The server says so too, a moment after the
   * open; this does not depend on that word arriving after the listeners are
   * in place. (The engine reads a session's MCP servers when it is first
   * asked about them, which is here.)
   */
  private async lookAtFeatures(session: BackendSession): Promise<void> {
    const hooks = await session.hooks?.().catch(() => undefined)
    if (hooks !== undefined) this.hooksChanged(session, hooks)
    const lsp = await session.lsp?.().catch(() => undefined)
    if (lsp !== undefined) this.lspChanged(session, lsp)
    const mcp = await session.mcp?.().catch(() => undefined)
    if (mcp !== undefined) this.mcpChanged(session, mcp)
  }

  private async consume(session: BackendSession): Promise<void> {
    try {
      for await (const item of session.events) {
        if ("turn" in item) this.transcript.applyTurn(item.turn)
        else {
          this.transcript.apply(item.event, item.replay)
          if (!item.replay) this.featureEvent(session, item.event)
          // Background work outlives the turn: said where the turn ends.
          const ended = item.event.type === "execution.succeeded" || item.event.type === "execution.failed" || item.event.type === "execution.interrupted"
          // Said once for the commands it names: the status line and the panel keep showing them, so the same line
          // under every later turn is noise.
          const running = [...this.transcript.background.keys()].join(", ")
          if (running === "") this.backgroundSaid = ""
          if (ended && !item.replay && running !== "" && running !== this.backgroundSaid) {
            this.backgroundSaid = running
            const ids = [...this.transcript.background.keys()]
            this.transcript.note([span(`◌ ${plural(ids.length, "background command")} still running (${ids.join(", ")}): the agent is told when ${ids.length === 1 ? "it ends" : "each ends"}; /quit stops ${ids.length === 1 ? "it" : "them"}`, "dim")], "dim", "·")
          }
        }
        this.settleDock()
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
    this.problem = `the engine is gone: ${lost}`
    Object.assign(this.transcript.activity, { executing: false, call: null, checking: null, compacting: null, retry: null, stopping: false, waiting: null })
    this.closeDock()
    this.transcript.note([span("the engine is gone: ", "error", { bold: true }), span(lost, "error")], "error", "✗", [[span(this.options.backend.restartable ? "Type /reconnect to start it again and resume this session, or /quit to leave." : "Type /quit to leave.", "dim")]])
    this.redraw()
  }

  private async switchTo(target: OpenTarget, banner?: () => void): Promise<void> {
    if (this.transcript.activity.executing) return this.say("stop the agent first (Ctrl-C), then switch sessions", "warn")
    const old = this.session
    this.session = null
    this.featureQuestions.length = 0
    this.closeDock()
    await old?.close(false)
    await this.pump
    this.transcript.reset()
    this.conversation.toBottom()
    this.conversation.selected = null
    // Said before the session's history arrives, so it stands above it.
    banner?.()
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
    if (this.review.open) {
      // A key the review does not take is text for the comment being written: its editor gets it.
      if (!this.review.key(key)) return
      return handled()
    }
    if (this.pager.open) {
      if (key.sequence === "r" && this.diffTurn !== null) {
        this.pager.close()
        void this.openReview(this.diffTurn)
      } else this.pager.key(name, key.sequence, ctrl)
      return handled()
    }
    if (ctrl && name === "c") {
      this.ctrlC()
      return handled()
    }
    const text = this.input.plainText
    const palette = this.palette()
    const dock = this.dock !== null && !this.dock.state.withdrawn ? this.dock.state : null
    if (dock !== null && dock.focused) {
      if ((name === "escape" && dock.note === null) || name === "tab") {
        dock.focused = false
        this.layout()
        return handled()
      }
      const action = dock.key(name, key.sequence, ctrl, meta, this.now())
      if (action.kind === "answer") {
        this.answerDock({ choice: action.choice, ...(action.note === null ? {} : { note: action.note }) })
        return handled()
      }
      if (action.kind === "none") {
        this.layout()
        return handled()
      }
      // Not the dock's key: it is the user's text, and goes to the input as typed.
      dock.focused = false
      this.lastTyped = this.now()
      this.layout()
      return
    }
    if (dock !== null && name === "tab" && palette.length === 0) {
      dock.focus(this.now())
      this.layout()
      return handled()
    }
    if (!ctrl && !meta && key.sequence.length === 1) this.lastTyped = this.now()
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
        // Typed in full: one of the interface's own, or exactly the command file that is chosen.
        const exact = (typed?.spec !== null && typed?.spec !== undefined) || (chosen.file !== undefined && typed?.name === chosen.name)
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
      // The label beside the input says the mode at once, not at the next event or key.
      this.layout()
      return handled()
    }
    if (ctrl && name === "x") {
      void this.stopCall()
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
    // Sent: the user is no longer typing, and a question that comes next may take the keys.
    this.lastTyped = 0
    // A message that really starts with a slash is written with two, as in the line CLI.
    if (trimmed.startsWith("//")) return this.send(text.trimStart().slice(1), this.transcript.activity.executing ? this.mode : "steer")
    const command = parseCommand(trimmed)
    if (command !== null) return void this.command(command.spec, command.name, command.rest)
    this.send(text, this.transcript.activity.executing ? this.mode : "steer")
  }

  private send(text: string, delivery: Delivery): void {
    void this.deliver(text, delivery).then((problem) => {
      if (problem !== null) this.say(problem.text, problem.tone)
    })
  }

  /** Sends a message. Resolves with `null` once the engine has taken it, or with why it was not sent. */
  private async deliver(text: string, delivery: Delivery): Promise<{ readonly text: string; readonly tone: "warn" | "error" } | null> {
    const session = this.session
    if (session === null || this.connection !== "connected")
      return {
        text:
          this.connection === "starting"
            ? "not sent: the engine is still starting; try again in a moment"
            : this.connection === "not signed in"
              ? `not sent: not signed in; run ${brand.binary} login in another terminal, then /reconnect`
              : "not sent: no session is open; /reconnect first, or /quit",
        tone: "warn",
      }
    this.conversation.toBottom()
    await this.beforeMessage(session)
    try {
      return (await session.send(text, delivery)) === null ? { text: "not sent: the session is not taking input right now", tone: "warn" } : null
    } catch (error) {
      return { text: `not sent: ${error instanceof Error ? error.message : String(error)}`, tone: "error" }
    }
  }

  /**
   * Before a message that starts a turn is sent: whatever of the project's
   * configuration waits for an approval (a hook, a language server, an MCP
   * server) is put in the dock now, if it was not when the session opened,
   * and the message goes once it is answered, so the turn starts with what
   * the user allowed.
   */
  private async beforeMessage(session: BackendSession): Promise<void> {
    if (this.transcript.activity.executing) return
    const look = async <T>(read: (() => Promise<T>) | undefined, tell: (state: T) => void) => {
      const state = read === undefined ? undefined : await read.call(session).catch(() => undefined)
      if (state !== undefined && this.session === session) tell(state)
    }
    await look(session.hooks, (state) => this.hooksChanged(session, state))
    await look(session.lsp, (state) => this.lspChanged(session, state))
    await look(session.mcp, (state) => this.mcpChanged(session, state))
    if (this.featuresSettled()) return
    this.say("your message is sent once the question below is answered")
    await new Promise<void>((resolve) => this.featureWaiters.push(resolve))
  }

  /** No question about the project's configuration waits or shows, and no answer to one is still being recorded. */
  private featuresSettled(): boolean {
    return this.featureQuestions.length === 0 && this.dock?.feature === undefined && this.featureAnswering === 0
  }

  /** Lets go of the messages that waited for those questions. */
  private releaseFeatureWaiters(): void {
    if (!this.featuresSettled() && this.session !== null && this.leaving === null) return
    for (const release of this.featureWaiters.splice(0)) release()
  }

  private ctrlC(): void {
    if (this.transcript.activity.executing && this.session !== null) {
      const now = this.now()
      if (now - this.lastInterrupt < DOUBLE_INTERRUPT_MS) {
        this.say("exiting without waiting for the stop", "warn")
        return this.exitNow(130)
      }
      // About the turn that is stopping: it stays inside the turn, above its ending row.
      if (this.transcript.activity.stopping && this.lastInterrupt !== 0) this.transcript.note([span("■ still stopping… press Ctrl-C again to exit now", "warn")], "warn", "!", [], "work")
      this.lastInterrupt = now
      this.transcript.markStopAsked()
      // A tool call's pending question goes from the screen now; it is answered `cancelled` once the stop has reached
      // the engine. A question about the project's configuration is not the turn's: it stays to be answered.
      if (this.dock !== null && this.dock.feature === undefined) this.dock.state.withdrawn = true
      this.session.interrupt()
      this.layout()
      return
    }
    // No turn to stop. A question in the dock is answered "not now", as backing out of it is in the line interface
    // (what that means is said by the answer); text being written while the question waits unanswered is cleared first.
    const dock = this.dock !== null && !this.dock.state.withdrawn ? this.dock : null
    if (dock !== null && (dock.state.focused || this.input.plainText === "")) return dock.feature === undefined ? this.closeDock() : this.answerDock({ choice: "deny" })
    if (this.input.plainText !== "") return this.setInput("")
    this.say("press Ctrl-D or type /quit to leave")
  }

  /**
   * The running tool call Ctrl-X would stop: the selected row when it is
   * one, else the only call that is running. `null` when there is none to
   * pick: nothing runs, or several do and none is selected.
   */
  private stoppable(): ToolRow | null {
    const selected = this.conversation.selectedRow()
    if (selected?.kind === "tool" && selected.phase === "running") return selected
    const running = this.transcript.runningCalls()
    return selected?.kind === "tool" || running.length !== 1 ? null : running[0]!
  }

  /**
   * Ctrl-X: stops one running tool call and nothing else, so the turn goes
   * on. What came of it is on the call's own row (`■ ... stopped by you`,
   * with what it had printed; or that it could not be stopped midway and
   * finished). A request the engine did not take is said with why.
   */
  private async stopCall(): Promise<void> {
    const session = this.session
    if (session?.cancelCall === undefined) return this.unavailable("/stop", "Ctrl-C stops the whole turn")
    const row = this.stoppable()
    if (row === null) {
      const running = this.transcript.runningCalls().length
      const selected = this.conversation.selectedRow()
      if (selected?.kind === "tool") return this.say("the selected tool call is not running, so there is nothing to stop", "warn")
      return this.say(running === 0 ? "no tool call is running, so there is nothing for Ctrl-X to stop" : `${running} tool calls are running: select one with Alt-Up or Alt-Down, then Ctrl-X stops it (Ctrl-C stops the whole turn)`, "warn")
    }
    if (row.stopAsked) return this.say("that call was already asked to stop; it ends once its tool has stopped")
    try {
      const result = await session.cancelCall({ messageId: row.messageId, callId: row.callId })
      if (!result.stopped) this.say(`not stopped: ${result.message ?? "the engine did not take the request"}`, "warn")
    } catch (error) {
      this.say(`could not stop the call: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    this.redraw()
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
    // A command is being typed: the command files are looked for again, so one added a moment ago is offered.
    const typing = text.startsWith("/")
    if (typing && !this.typingCommand) void this.listCommandFiles()
    this.typingCommand = typing
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
      case "agent":
        return session?.agents !== undefined && session.setConfig !== undefined
      case "approval":
        return session?.setConfig !== undefined && session.configChoices?.("approval") !== null && session.configChoices?.("approval") !== undefined
      case "clear-taint":
        return session?.clearTaint !== undefined
      case "diff":
      case "review":
        return session?.diff !== undefined
      case "rename":
        return session?.rename !== undefined
      case "fork":
        return session?.fork !== undefined
      case "mcp":
        return session?.mcp !== undefined
      case "hooks":
        return session?.hooks !== undefined
      case "lsp":
        return session?.lsp !== undefined
      case "skills":
        return session?.skills !== undefined
      case "wakeups":
        return session?.wakeups !== undefined
      case "watch":
        return session?.watches !== undefined && session.watchOutput !== undefined && session.unwatchOutput !== undefined
      case "memory":
      case "remember":
      case "forget":
        return session?.memory !== undefined
      case "reconnect":
        return this.connection !== "connected" && this.connection !== "starting"
      case "queue":
        return this.transcript.activity.executing
      case "stop":
        return session?.cancelCall !== undefined && this.transcript.activity.executing
      default:
        return true
    }
  }

  private palette(): CommandSpec[] {
    const text = this.input.plainText
    if (this.paletteDismissed === text || this.dialog.open) return []
    return complete(text, (spec) => this.available(spec), this.commandFiles === null ? [] : fileCommands(this.commandFiles))
  }

  /** The session's command files as they are now; `null` when the engine has none or cannot say. */
  private async listCommandFiles(): Promise<CommandsResult | null> {
    const session = this.session
    const listing = session?.commands === undefined ? null : await session.commands(CLIENT_COMMANDS).catch(() => null)
    if (session !== this.session) return null
    this.commandFiles = listing?.available === true ? listing : null
    this.layout()
    return this.commandFiles
  }

  /**
   * `/name` that is no command of the interface's own: a command file's, sent
   * through the engine (which records the file); a file that cannot be used,
   * said with why; or nothing, said with the nearest name of both.
   */
  private async fileCommand(name: string, rest: string): Promise<void> {
    const session = this.session
    const listing = await this.listCommandFiles()
    const files = listing === null ? [] : fileCommands(listing)
    const file = name === "" ? null : findFileCommand(files, name)
    if (file !== null && session?.sendCommand !== undefined) {
      if (this.connection !== "connected") return this.say("not sent: no session is open; /reconnect first, or /quit", "warn")
      this.conversation.toBottom()
      const delivery = this.transcript.activity.executing ? this.mode : "steer"
      await this.beforeMessage(session)
      return session.sendCommand(file.name, rest, delivery).then(
        (id) => {
          if (id === null) this.say("not sent: the session is not taking input right now", "warn")
        },
        (error: unknown) => this.say(`not sent: ${error instanceof Error ? error.message : String(error)}`, "warn"),
      )
    }
    const unusable = listing === null || name === "" ? null : unusableCommandLines(listing, name)
    if (unusable !== null) return this.showLines(unusable, "warn", "⚠")
    if (name === "") return this.say("type a command's name after the /; /help lists the commands", "warn")
    const close = nearest(name, [...COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]), ...files.map((command) => command.name)])
    this.say(`/${name} is not a command, so nothing was sent; ${close === null ? "/help lists the commands" : `did you mean /${close}? (/help lists them)`}. To send a message that starts with a slash, begin it with two: //${name}`, "warn")
  }

  private async command(spec: CommandSpec | null, name: string, rest: string): Promise<void> {
    if (spec === null) return this.fileCommand(name, rest)
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
        case "stop":
          if (rest !== "") return this.say("/stop takes nothing after it: it stops the selected running tool call (Alt-Up, Alt-Down), or the only one running", "warn")
          return await this.stopCall()
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
          return await this.compact(rest)
        case "agent":
          return await this.pickAgent(rest)
        case "reconnect":
          return await this.reconnect()
        case "approval":
          return await this.pickApproval(rest)
        case "clear-taint":
          return await this.clearTaint()
        case "diff":
          return await this.showDiff()
        case "review":
          return await this.openReview()
        case "rename":
          return await this.rename(rest)
        case "fork":
          return await this.fork(rest)
        case "mcp":
        case "hooks":
        case "lsp":
        case "skills":
        case "wakeups":
        case "watch":
        case "memory":
        case "remember":
        case "forget":
          return await this.featureCommand(spec.name, rest)
      }
    } finally {
      this.busyCommand = false
      this.redraw()
    }
  }

  private async revert(undo: boolean): Promise<void> {
    const command = undo ? "/undo" : "/redo"
    const session = this.session
    if (session?.revert === undefined || session.undoRevert === undefined) return this.unavailable(command)
    if (this.transcript.activity.executing) return this.say(`${command} works only while the agent is idle; stop it first (Ctrl-C)`, "warn")
    const act = (options: { dryRun?: boolean; handEdits?: "ask" | "abort" }) => (undo ? session.revert!(options) : session.undoRevert!(options))
    try {
      const preview = await act({ dryRun: true })
      if (preview.kind !== "preview") return this.say(refusal(command, preview), "warn")
      const plan = preview.plan
      this.transcript.note([span(undo ? "going back to before your last message" : "bringing back what the last /undo took away"), span(` · ${plural(plan.messages, "message")}`, "dim")], "accent", undo ? "↶" : "↷", describePlan(plan, undo))
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

  /**
   * `/fork [<turn>] [copy]`: a new session with this conversation so far (or
   * up to the end of a turn, numbered as its ending row shows), opened in
   * place of this one, which is left as it is (/sessions goes back to it).
   * While idle only: switching away would stop the running turn.
   */
  private async fork(rest: string): Promise<void> {
    const session = this.session
    if (session?.fork === undefined) return this.unavailable("/fork")
    const words = rest.trim().toLowerCase().split(/\s+/).filter((word) => word !== "")
    const copy = words.includes("copy")
    const numbers = words.filter((word) => /^\d+$/.test(word))
    if (words.some((word) => word !== "copy" && !/^\d+$/.test(word)) || numbers.length > 1)
      return this.say("/fork takes a turn number (the one on its ending row), copy (the fork works in a copy of the workspace), both, or nothing", "warn")
    if (this.transcript.activity.executing) return this.say("/fork works while the agent is idle; stop it first (Ctrl-C) or wait for the turn to end", "warn")
    // Nothing to carry over: a fork of a session without a turn would be an empty session with a borrowed title.
    if (this.transcript.turns.turns.length === 0) return this.say("/fork copies this conversation into a new session, and there is none yet: send a message first (/new starts an empty session)", "warn")
    const turn = numbers.length === 0 ? null : Number(numbers[0])
    let throughSeq: number | undefined
    if (turn !== null) {
      const point = forkPointOfTurn(this.transcript.turns.turns, turn)
      if ("problem" in point) return this.say(`/fork ${turn}: ${point.problem}`, "warn")
      throughSeq = point.throughSeq
    }
    const from = { id: session.id, title: this.transcript.session.title }
    let forked
    try {
      forked = await session.fork({ copy, ...(throughSeq === undefined ? {} : { throughSeq }) })
    } catch (error) {
      return this.say(`/fork failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    const where = forked.copiedFrom === null ? "in the same directory (both sessions change the same files)" : `in a copy of the workspace: ${forked.cwd}`
    const upTo = turn === null ? "the conversation so far" : `the conversation up to the end of turn ${turn}`
    await this.switchTo({ kind: "resume", id: forked.sessionId }, () =>
      this.transcript.note(
        [span("forked", "accent"), span(` from ${from.title === null ? from.id : `"${shorten(from.title, 40)}"`} · this is a new session with ${upTo}, ${where}`, "dim")],
        "accent",
        "⑂",
        [
          // The turn lies in what this session inherited: the fork is of the session it inherited it from.
          ...(forked.parentSessionId === from.id ? [] : [[span(`turn ${turn} is part of what this session inherited from ${forked.parentSessionId} (it is a fork itself), so the new session is a fork of that one`, "dim")]]),
          [span(`the original is unchanged: /sessions goes back to it (${from.id})`, "dim")],
          ...(forked.copiedFrom === null ? [] : [[span(COPY_NOTE, "warn")]]),
        ],
      ),
    )
  }

  private async pickSession(): Promise<void> {
    const backend = this.options.backend
    if (backend.listSessions === undefined) return this.unavailable("/sessions")
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
          // The ID first and long enough to tell a fork from its parent, which shares its title; a fork says so, and where it works when that is elsewhere.
          label: `${row.forkedFrom == null ? "" : "⑂ "}${row.title === null ? "(untitled)" : shorten(row.title, 34)}`,
          detail: [
            row.id.slice(0, 16),
            row.forkedFrom == null ? null : `fork of ${row.forkedFrom.slice(0, 12)}`,
            row.cwd === this.options.cwd ? null : `in ${middle(tilde(row.cwd, this.options.home), 30)}`,
            ago(this.now() - row.updatedAt),
            `${row.model}${row.effort === null ? "" : ` ${row.effort}`}`,
            row.archived ? "archived" : null,
          ]
            .filter((part) => part !== null)
            .join(" · "),
          current: row.id === current,
        })),
      ],
      filterable: true,
      footer: "type to filter · Enter open · Esc cancel",
      cancel: null,
      maxWidth: 120,
    })
    if (answer === null || answer === current) return
    await this.switchTo(answer === "\u0000new" ? { kind: "new" } : { kind: "resume", id: answer })
  }

  private async pickModel(): Promise<void> {
    const backend = this.options.backend
    const session = this.session
    if (backend.listModels === undefined || session?.setConfig === undefined) return this.unavailable("/model")
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
    const listing = await this.listCommandFiles()
    const files = listing === null ? [] : fileCommands(listing)
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
      ["Ctrl-X", "stop the selected running tool call (or the only one running): the turn goes on"],
      ["Ctrl-P", "show or hide the session panel"],
      ["Shift + drag", "select text with the mouse (most terminals)"],
    ]
    await this.dialog.show({
      title: "Help",
      detail: [
        ...keys.map(([key, what]) => [span(key.padEnd(KEY_COLUMN), "accent"), span(what)]),
        [],
        [span("⊡".padEnd(KEY_COLUMN), "accent"), span("on a command: it ran in the sandbox (+network, +write <dir>: the extra access it was given)")],
        [span("⊘".padEnd(KEY_COLUMN), "accent"), span("a call that was not allowed (by you, or by the approval policy)")],
        [span("Tab".padEnd(KEY_COLUMN), "accent"), span("while a question waits: move between it and your message")],
        [],
        ...COMMANDS.filter((spec) => this.available(spec) || ["undo", "redo", "compact", "queue", "rename"].includes(spec.name)).map((spec) => [
          span(`/${spec.name}${spec.args === "" ? "" : ` ${spec.args}`}`.padEnd(KEY_COLUMN), "accent"),
          span(spec.description),
          span(this.available(spec) ? "" : " (not available now)", "dim"),
        ]),
        // The command files: what each sends, and where it comes from (the file, in full).
        ...(files.length === 0 ? [] : [[], [span("Your commands", undefined, { bold: true }), span(" · command files: their text is sent as your message", "dim")]]),
        ...files.flatMap((spec) => [
          [span(`/${spec.name}${spec.args === "" ? "" : ` ${spec.args}`}`.padEnd(KEY_COLUMN), "accent"), span(spec.description)],
          [span("".padEnd(KEY_COLUMN)), span(`${COMMAND_SCOPE[spec.file!.scope]}${spec.file!.agent === null ? "" : ` · runs as the agent ${spec.file!.agent}`}: ${spec.file!.path}`, "dim")],
        ]),
        ...(listing === null ? [] : inRows(commandProblemLines(listing)).map((line) => [span(`${" ".repeat(line.indent ?? 0)}${line.text}`, line.tone === "warn" ? "warn" : "dim")])),
      ],
      items: [],
      filterable: false,
      footer: "↑↓ scroll · Esc close",
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

  // ---------------------------------------------------------------- approval

  /**
   * A tool call's approval question, in the dock above the input. It takes
   * the focus only from someone who is not typing; the text in the input is
   * never touched. Resolves with the answer, or `null` when the question is
   * withdrawn (the turn was stopped, the session closed).
   */
  private approve(ask: ApprovalAsk, signal: AbortSignal): Promise<ApprovalAnswer | null> {
    // A tool call's question cannot wait: a server's question steps aside and comes back after it.
    const feature = this.dock?.feature
    if (feature !== undefined) this.featureQuestions.unshift(feature)
    this.dock?.answer(null)
    // A subagent's question is about a call in the subagent's own conversation.
    const row = this.transcript.toolRowFor(ask)
    const quiet = this.input.plainText === "" && this.now() - this.lastTyped >= QUIET_MS && !this.dialog.open && !this.pager.open
    return new Promise((resolve) => {
      const state = new DockState(ask, row === null ? null : { name: row.name, arg: row.arg, input: row.input }, { focused: quiet, now: this.now() })
      const entry = {
        state,
        answer: (answer: ApprovalAnswer | null) => {
          if (this.dock === entry) this.dock = null
          this.layout()
          resolve(answer)
          this.nextServerQuestion()
        },
      }
      this.dock = entry
      signal.addEventListener("abort", () => entry.answer(null), { once: true })
      this.conversation.toBottom()
      this.layout()
    })
  }

  private answerDock(answer: ApprovalAnswer): void {
    this.dock?.answer(answer)
  }

  private closeDock(): void {
    this.dock?.answer(null)
  }

  /** The question was settled without this dock (the call ended, the turn ended): it goes away. */
  private settleDock(): void {
    const dock = this.dock
    if (dock === null || dock.feature !== undefined) return
    const row = this.transcript.toolRowFor(dock.state.ask)
    const stillAsked = row === null || (row.phase !== "settled" && (row.approval === null || (row.approval.state === "asked" && row.approval.live)))
    if (!stillAsked || !this.transcript.activity.executing) this.closeDock()
  }

  // ---------------------------------------------------------------- MCP servers, skills, wake-ups, memory

  /** The servers changed: a failure is told once with why; a project's server waiting for approval is put in the dock. */
  private mcpChanged(session: BackendSession, state: McpStateResult): void {
    if (this.session !== session) return
    for (const server of state.servers) {
      if (server.state === "failed" && server.error !== null && !this.toldFailures.has(`${server.name}\u0000${server.error}`)) {
        this.toldFailures.add(`${server.name}\u0000${server.error}`)
        this.transcript.note([span(mcpFailureText(server), "warn")], "warn", "!")
      }
      if (server.state === "awaiting_approval" && server.question !== null && !this.asked.has(mcpAskId(server))) {
        this.asked.add(mcpAskId(server))
        this.featureQuestions.push(this.mcpQuestion(session, server))
      }
    }
    this.nextServerQuestion()
    this.redraw()
  }

  private mcpQuestion(session: BackendSession, server: McpServerInfo): FeatureQuestion {
    return { id: mcpAskId(server), ask: mcpServerAsk(session.id, server), subject: `the MCP server "${server.name}"`, answer: (allow) => this.answerServer(session, server, allow) }
  }

  /** The hooks changed: a project's hook nobody approved yet (this definition of it) is put in the dock, with the engine's question. */
  private hooksChanged(session: BackendSession, state: HooksStateResult): void {
    if (this.session !== session) return
    for (const hook of state.hooks) {
      if (hook.state !== "awaiting_approval" || hook.question === null || this.asked.has(hookAskId(hook))) continue
      this.asked.add(hookAskId(hook))
      this.featureQuestions.push(this.hookQuestion(session, hook))
    }
    this.nextServerQuestion()
    this.redraw()
  }

  private hookQuestion(session: BackendSession, hook: HookInfo): FeatureQuestion {
    return { id: hookAskId(hook), ask: hookAsk(session.id, hook), subject: `the hook "${hook.name}"`, answer: (allow) => this.answerHook(session, hook, allow) }
  }

  private async answerHook(session: BackendSession, hook: HookInfo, allow: boolean): Promise<void> {
    if (!allow) return this.say(`the hook "${hook.name}" is not run; /hooks approve ${hook.name} asks again`)
    try {
      const approved = (await session.approveHook?.(hook.fingerprint)) ?? false
      if (approved) this.transcript.note([span(`approved: the hook "${hook.name}" runs from the next call it applies to`), span(" · /hooks shows it", "dim")], "accent", "✓")
      else this.say(`the hook "${hook.name}" no longer waits for an approval (its definition changed); /hooks shows it`, "warn")
      this.redraw()
    } catch (error) {
      this.say(`could not approve the hook "${hook.name}": ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /** The language servers changed: a project's server nobody approved yet is put in the dock. */
  private lspChanged(session: BackendSession, state: LspStateResult): void {
    if (this.session !== session) return
    for (const server of state.servers) {
      if (server.state !== "awaiting_approval" || server.question === null || this.asked.has(lspAskId(server))) continue
      this.asked.add(lspAskId(server))
      this.featureQuestions.push(this.lspQuestion(session, server))
    }
    this.nextServerQuestion()
    this.redraw()
  }

  private lspQuestion(session: BackendSession, server: LspServerInfo): FeatureQuestion {
    return { id: lspAskId(server), ask: lspServerAsk(session.id, server), subject: `the language server "${server.name}"`, answer: (allow) => this.answerLspServer(session, server, allow) }
  }

  private async answerLspServer(session: BackendSession, server: LspServerInfo, allow: boolean): Promise<void> {
    if (!allow) return this.say(`the language server "${server.name}" is not started; /lsp approve ${server.name} asks again`)
    try {
      const approved = (await session.approveLsp?.(server.name, server.question!.fingerprint)) ?? false
      if (approved) this.transcript.note([span(`approved: the language server "${server.name}" starts at the next file it serves`), span(" · /lsp shows it", "dim")], "accent", "✓")
      else this.say(`the language server "${server.name}" no longer waits for an approval (its definition changed); /lsp shows it`, "warn")
      this.redraw()
    } catch (error) {
      this.say(`could not approve the language server "${server.name}": ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /**
   * A command too long for the dock is printed in full above it, once,
   * before the question can be answered (and again when a smaller terminal
   * makes it too long): nothing of what the user is asked to let run is
   * ever out of sight.
   */
  private printWholeCommand(id: string, state: DockState): void {
    if (this.printedCommands.has(id) || !commandOverflows(state, this.renderer.width, this.dockRows())) return
    this.printedCommands.add(id)
    const question = state.ask.question
    this.transcript.note([span(`${question.title} The whole command:`, "warn")], "warn", "?", question.subject.split("\n").map((line) => [span(line, "accent")]))
    this.conversation.toBottom()
  }

  /** The most rows the dock takes of the terminal. */
  private dockRows(): number {
    return Math.max(4, Math.floor(this.renderer.height * DOCK_SHARE))
  }

  /** Asks about `question` now (a command of the user's), unless it is waiting or showing already. */
  private askFeature(question: FeatureQuestion): void {
    if (!this.featureQuestions.some((candidate) => candidate.id === question.id) && this.dock?.feature?.id !== question.id) this.featureQuestions.push(question)
    this.nextServerQuestion()
  }

  /** Puts the next question about what the project's configuration names in the dock, when the dock is free. */
  private nextServerQuestion(): void {
    const session = this.session
    if (this.dock !== null || session === null || this.leaving !== null) return this.releaseFeatureWaiters()
    const feature = this.featureQuestions.shift()
    if (feature === undefined) return this.releaseFeatureWaiters()
    const quiet = this.input.plainText === "" && this.now() - this.lastTyped >= QUIET_MS && !this.dialog.open && !this.pager.open
    const state = new DockState(feature.ask, null, { focused: quiet, now: this.now(), withNote: false, whole: true })
    this.printWholeCommand(feature.id, state)
    const entry = {
      state,
      feature,
      answer: (answer: ApprovalAnswer | null) => {
        if (this.dock !== entry) return
        this.dock = null
        this.layout()
        // `null`: it stepped aside for a tool call's question, or the session went; it is not an answer.
        if (answer !== null) {
          // What waits for the answer (a message held back) goes once the answer is recorded.
          this.featureAnswering += 1
          void feature.answer(answer.choice === "once").finally(() => {
            this.featureAnswering -= 1
            this.releaseFeatureWaiters()
          })
        }
        this.nextServerQuestion()
      },
    }
    this.dock = entry
    this.conversation.toBottom()
    this.layout()
  }

  private async answerServer(session: BackendSession, server: McpServerInfo, start: boolean): Promise<void> {
    if (!start) return this.say(`MCP server "${server.name}" not started; /mcp approve ${server.name} asks again`)
    try {
      const approved = (await session.approveMcp?.(server.name, server.question!.fingerprint)) ?? false
      if (approved) this.transcript.note([span(mcpApprovedText(server, this.transcript.activity.executing))], "accent", "✓")
      else this.say(`MCP server "${server.name}" no longer waits for an approval (its definition changed); /mcp shows it`, "warn")
      this.redraw()
    } catch (error) {
      this.say(`could not approve "${server.name}": ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /** What an event asks of the client besides showing it: a webhook wake-up's secret, once, when it is created. */
  private featureEvent(session: BackendSession, event: import("./cli.ts").EngineEvent): void {
    // The session has started: its memory exists from here on, and what `/remember` kept is saved.
    if (event.type === "baseline.set") void this.saveKeptNotes(session)
    if (event.type !== "tool.settled" || event.data.outcome !== "success") return
    const wake = (event.data.display as { wake?: { action?: unknown; id?: unknown } } | null)?.wake
    if (wake?.action !== "create" || typeof wake.id !== "string") return
    const id = wake.id
    // A server that fires no wake-ups (it was started that way): said when one is created, with where it will fire.
    void session.wakeups?.().then(
      (list) => {
        if (!list.available || list.running || this.session !== session) return
        this.say(wakeNotFiringText({ id, description: list.wakeups.find((candidate) => candidate.id === id)?.description ?? null }, session.id), "warn")
      },
      () => {},
    )
    if (session.wakeSecret === undefined) return
    void session.wakeSecret(wake.id).then(
      (secret) => {
        if (secret.secret === null || this.session !== session) return
        this.showLines(webhookSecretLines(secret, true), "accent", "⏰")
      },
      () => {},
    )
  }

  /** The notes written before the session's memory existed, saved now; what became of each is said. */
  private async saveKeptNotes(session: BackendSession): Promise<void> {
    const mine = this.keptNotes.filter((note) => note.session === session)
    if (mine.length === 0 || session.memoryChange === undefined) return
    this.keptNotes = this.keptNotes.filter((note) => note.session !== session)
    for (const note of mine) {
      const result = await session.memoryChange({ action: "remember", text: note.text, scope: note.scope }).catch((error: unknown) => ({ ok: false, id: null, message: error instanceof Error ? error.message : String(error) }))
      this.say(`your note from before the first message: ${result.message}`, result.ok ? "dim" : "warn")
    }
  }

  private showLines(lines: readonly Line[], tone: "dim" | "accent" | "warn" = "dim", symbol = "·"): void {
    const { head, detail } = noteOf(lines)
    this.transcript.note(head, tone, symbol, detail)
    this.conversation.toBottom()
    this.redraw()
  }

  /** `/mcp`, `/skills`, `/wakeups`, `/memory`, `/remember`, `/forget`: the line CLI's words, as a note in the conversation. */
  private async featureCommand(name: "mcp" | "hooks" | "lsp" | "skills" | "wakeups" | "watch" | "memory" | "remember" | "forget", rest: string): Promise<void> {
    const session = this.session
    if (session === null) return this.say(`/${name} needs an open session`, "warn")
    const missing = () => this.unavailable(`/${name}`)
    const words = rest.trim().split(/\s+/).filter((word) => word !== "")
    try {
      switch (name) {
        case "mcp": {
          if (session.mcp === undefined) return missing()
          const state = await session.mcp()
          if (words.length === 0) return this.showLines(mcpLines(state))
          if (words[0] !== "approve" || words.length !== 2) return this.say("/mcp takes nothing (the listing) or approve <server>", "warn")
          const server = state.servers.find((candidate) => candidate.name === words[1])
          if (server === undefined) return this.say(`there is no MCP server "${words[1]}" in this session; /mcp lists them`, "warn")
          if (server.state !== "awaiting_approval" || server.question === null) return this.say(mcpNotWaitingText(server))
          return this.askFeature(this.mcpQuestion(session, server))
        }
        case "hooks": {
          if (session.hooks === undefined) return missing()
          const state = await session.hooks()
          if (words.length === 0) return this.showLines(hooksLines(state))
          if (words[0] !== "approve" || words.length !== 2) return this.say("/hooks takes nothing (the listing) or approve <hook>", "warn")
          const named = state.hooks.filter((candidate) => candidate.name === words[1])
          if (named.length === 0) return this.say(`there is no hook "${words[1]}" in this session; /hooks lists them`, "warn")
          const waiting = named.filter((hook) => hook.state === "awaiting_approval" && hook.question !== null)
          if (waiting.length === 0) return this.say(`the hook "${words[1]}" does not wait for an approval: it is ${named[0]!.origin === "user" ? "your own and runs without one" : "approved already"}`)
          for (const hook of waiting) this.askFeature(this.hookQuestion(session, hook))
          return
        }
        case "lsp": {
          if (session.lsp === undefined) return missing()
          const state = await session.lsp()
          if (words.length === 0) return this.showLines(lspLines(state))
          if (words[0] !== "approve" || words.length !== 2) return this.say("/lsp takes nothing (the listing) or approve <server>", "warn")
          const server = state.servers.find((candidate) => candidate.name === words[1])
          if (server === undefined) return this.say(`there is no language server "${words[1]}" in this session; /lsp lists them`, "warn")
          if (server.state !== "awaiting_approval" || server.question === null) return this.say(`the language server "${server.name}" does not wait for an approval: it is ${server.state.replace(/_/g, " ")}`)
          return this.askFeature(this.lspQuestion(session, server))
        }
        case "skills":
          if (session.skills === undefined) return missing()
          return this.showLines(skillsLines(await session.skills()))
        case "wakeups": {
          if (session.wakeups === undefined) return missing()
          if (words.length === 0) return this.showLines(wakeLines(await session.wakeups()))
          if (words[0] === "add") return await this.addWake(session, rest.trim().slice("add".length))
          if (words.length !== 2 || (words[0] !== "cancel" && words[0] !== "secret")) return this.say("/wakeups takes nothing (the listing), add <what> (/wakeups add shows the forms), cancel <id> or secret <id>", "warn")
          if (words[0] === "secret") return this.showLines(webhookSecretLines(await session.wakeSecret!(words[1]!), false), "accent", "⏰")
          const result = await session.cancelWake!(words[1]!)
          return this.say(result.message, result.cancelled ? "dim" : "warn")
        }
        case "watch": {
          if (session.watches === undefined || session.watchOutput === undefined || session.unwatchOutput === undefined) return missing()
          const entry = watchEntry(rest)
          if ("problem" in entry) return this.say(entry.problem, "warn")
          if (entry.kind === "list") return this.showLines(watchLines(await session.watches()))
          if (entry.kind === "remove") {
            // What was removed is the session's own event (`watch.ended`); one that is over or unknown is said here.
            if (!(await session.unwatchOutput(entry.watchId))) this.say(`there is no watch ${entry.watchId} that could still fire (it has fired as often as it may, was removed, or its command ended); /watch lists them`, "warn")
            return
          }
          // A watch that was set is the session's own event (`watch.started`); a refusal is the engine's sentence.
          await session.watchOutput(entry.command, { pattern: entry.pattern, regex: entry.regex, ignoreCase: entry.ignoreCase, ...(entry.limit === null ? {} : { limit: entry.limit }) }).catch((error: unknown) => this.say(error instanceof Error ? error.message : String(error), "warn"))
          return
        }
        case "memory": {
          if (session.memory === undefined) return missing()
          const action = memoryAction(rest)
          if (action === null) return this.showLines(memoryLines(await session.memory()))
          if ("problem" in action) return this.say(action.problem, "warn")
          const result = await session.memoryChange!(action)
          return this.say(result.message, result.ok ? "dim" : "warn")
        }
        case "remember": {
          if (session.memoryChange === undefined) return missing()
          const { text, scope } = rememberArgs(rest)
          if (text === "") return this.say("/remember needs the note: /remember this repo uses pnpm (--me for a note about you, in every project)", "warn")
          const result = await session.memoryChange({ action: "remember", text, scope })
          // Memory starts with the session's first turn: the note is kept until then, never dropped.
          if (result.deferred === true) {
            this.keptNotes.push({ session, text, scope })
            return this.say(result.message)
          }
          return this.say(result.message, result.ok ? "dim" : "warn")
        }
        case "forget": {
          if (session.memoryChange === undefined) return missing()
          if (!/^m_\w+$/.test(rest.trim())) return this.say("/forget needs a note's ID, as /memory lists them: /forget m_1a2b3c4d", "warn")
          const result = await session.memoryChange({ action: "retract", id: rest.trim() })
          return this.say(result.message, result.ok ? "dim" : "warn")
        }
      }
    } catch (error) {
      this.say(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /**
   * `/wakeups add ...`: the user sets a wake-up of their own. A check's
   * command is asked about first, like any command that would run: the
   * answer is the access it runs with, or that nothing is set up. What the
   * engine refuses is said in its sentence; a webhook's address and secret
   * are shown once.
   */
  private async addWake(session: BackendSession, rest: string): Promise<void> {
    if (session.createWake === undefined) return this.unavailable("/wakeups add")
    if (rest.trim() === "") return this.showLines(wakeAddUsageLines())
    const entry = wakeAddEntry(rest, this.now())
    if ("problem" in entry) return this.say(entry.problem, "warn")
    let run: WakeCreateParams["run"]
    if (entry.check !== null) {
      const answer = await this.dialog.show({
        title: `Run this command every ${entry.check.every} until it exits 0?`,
        detail: [
          [span(entry.check.command, "accent")],
          [],
          [span("It runs in this session's directory, without the agent, each time the wake-up checks; when it exits 0 the agent is told and the wake-up is done.", "dim")],
        ],
        items: [
          { id: "sandbox", label: "Run it in the sandbox, without network", key: "s" },
          { id: "network", label: "Run it in the sandbox, with network", key: "w" },
          { id: "unsandboxed", label: "Run it outside the sandbox, with your permissions", key: "u" },
          { id: "cancel", label: "Do not set the wake-up up", key: "n" },
        ],
        filterable: false,
        footer: "↑↓ Enter · keys · Esc cancel",
        cancel: "cancel",
      })
      this.redraw()
      if (answer !== "sandbox" && answer !== "network" && answer !== "unsandboxed") return this.say("not set up: the command is not run")
      run = answer === "unsandboxed" ? { kind: "unsandboxed" } : { kind: "sandboxed", network: answer === "network", writableRoots: [] }
    }
    const result = await session.createWake({ ...entry.request, ...(run === undefined ? {} : { run }) })
    if (!result.created || result.wake === null) return this.say(result.message, "warn")
    this.showLines(wakeCreatedLines(result), "accent", "⏰")
    // A server that fires no wake-ups: said at once, with where this one will fire.
    if (!result.running) this.say(wakeNotFiringText({ id: result.wake.id, description: result.wake.description }, session.id), "warn")
    if (result.secret !== null) this.showLines(webhookSecretLines({ id: result.wake.id, url: result.url, secret: result.secret, message: null }, true), "accent", "⏰")
  }

  private async refreshApproval(): Promise<void> {
    const session = this.session
    if (session?.approval === undefined) return
    try {
      const info = await session.approval()
      if (this.session !== session) return
      this.approvalInfo = info
      if (info.taint !== null && this.transcript.session.taint === null) this.transcript.session.taint = info.taint
      if (!info.tainted) this.transcript.session.taint = null
      this.redraw()
    } catch {
      // The panel leaves the mode out.
    }
  }

  /** `/approval [ask|auto|full]`: the mode, from a picker that says what each does. */
  private async pickApproval(rest: string): Promise<void> {
    const session = this.session
    const choices = session?.configChoices?.("approval") ?? null
    if (session?.setConfig === undefined || choices === null) return this.unavailable("/approval")
    const current = this.approvalInfo?.mode ?? choices.current
    const named = rest.trim().toLowerCase()
    const chosen =
      named !== ""
        ? (choices.choices.find((choice) => choice.value === named)?.value ?? null)
        : await this.dialog.show({
            title: "Approval mode",
            // What each mode does is the point of the choice: said in full above the list, never cut.
            detail: [
              [span("When a tool call asks before it runs. Applies from the next tool call; a project's settings can only make it stricter.", "dim")],
              [],
              ...choices.choices.map((choice) => [span(`${choice.name.padEnd(13)}`, "accent"), span(choice.description ?? "")]),
            ],
            items: choices.choices.map((choice) => ({ id: choice.value, label: choice.name, current: choice.value === current, key: String(choices.choices.indexOf(choice) + 1) })),
            filterable: false,
            footer: "Enter choose · keys · Esc keeps it",
            cancel: null,
          })
    if (named !== "" && chosen === null) return this.say(`/approval takes ${choices.choices.map((choice) => choice.value).join(", ")}`, "warn")
    if (chosen === null || chosen === current) return
    try {
      await session.setConfig("approval", chosen)
      await this.refreshApproval()
      const now = this.approvalInfo?.mode ?? chosen
      this.transcript.note([span(`approval mode: ${current ?? "?"} → ${now}`), span(" · from the next tool call", "dim")], "accent", "⇄", now !== chosen ? [[span(`the project's settings keep it at ${now}`, "warn")]] : [])
    } catch (error) {
      this.say(`could not switch the approval mode: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /** `/clear-taint`, after a confirmation that says what clearing means. */
  private async clearTaint(): Promise<void> {
    const session = this.session
    if (session?.clearTaint === undefined) return this.unavailable("/clear-taint")
    const taint = this.transcript.session.taint
    if (taint === null && this.approvalInfo?.tainted !== true) return this.say("there is nothing to clear: no untrusted content is in this conversation")
    const answer = await this.dialog.show({
      title: "Trust what is in this conversation?",
      detail: [
        ...(taint === null ? [] : [[span(`Untrusted content: ${taint}`, "warn")]]),
        [span("Clearing says you trust it. From then on, network access for a command and commands outside the sandbox follow your mode and your earlier approvals again instead of asking because of it.")],
        [span("The content stays in the conversation, and the model may still act on what it says. Clear only if you read it or trust its source.", "dim")],
      ],
      items: [
        { id: "clear", label: "Yes, I trust it: clear", key: "y" },
        { id: "keep", label: "No, keep asking", key: "n" },
      ],
      filterable: false,
      footer: "Enter choose · y n · Esc keeps asking",
      cancel: "keep",
    })
    if (answer !== "clear") return this.say("the conversation stays untrusted")
    try {
      if (!(await session.clearTaint())) this.say("there was nothing to clear")
      await this.refreshApproval()
    } catch (error) {
      this.say(`/clear-taint failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /**
   * `/compact`: asks for a compaction now. One that is made is drawn from its
   * events, with the sizes; what is said here is why there was none, or why
   * it failed.
   */
  private async compact(rest: string): Promise<void> {
    const session = this.session
    if (session?.compact === undefined) return this.unavailable("/compact")
    if (rest !== "") return this.say("/compact takes nothing after it", "warn")
    try {
      const said = compactText(await session.compact())
      if (said !== null) this.say(said.text, said.tone === "warn" ? "warn" : "dim")
    } catch (error) {
      this.say(`/compact failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /**
   * `/agent [name|none]`: the agent the session runs as, from a picker that
   * says what each may do and which definitions could not be used. The
   * switch itself is shown from its event, as in a session opened again.
   */
  private async pickAgent(rest: string): Promise<void> {
    const session = this.session
    if (session?.agents === undefined || session.setConfig === undefined) return this.unavailable("/agent")
    let listed
    try {
      listed = await session.agents()
    } catch (error) {
      return this.say(`could not list the agents: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    if (!listed.available) return this.say("this engine offers no agents", "warn")
    const problems = inRows(agentProblemLines(listed))
    const named = rest.trim()
    if (named === "" && listed.agents.length === 0 && listed.current === null) {
      this.say("no agents are defined here: a definition is a Markdown file in .claude/agents (or your own agents directory) with a name, a description and what the agent may do")
      if (problems.length > 0) this.showLines(problems, "warn", "!")
      return
    }
    const current = listed.current ?? "none"
    const chosen =
      named !== ""
        ? named
        : await this.dialog.show({
            title: "Agent",
            detail: [
              [span("The agent this session runs as: its instructions, what it may do, and its model where it names one. Applies from the next step.", "dim")],
              ...problems.map((line) => [span(`${" ".repeat(line.indent ?? 0)}${line.text}`, line.tone === "warn" ? "warn" : "dim")]),
            ],
            items: [
              { id: "none", label: "no agent", detail: "the session's own instructions, without an agent's restrictions", current: current === "none" },
              ...listed.agents.map((agent) => ({
                id: agent.name,
                label: agent.name,
                detail: [agent.tag, agent.description, agent.model === null ? null : `model ${agent.model}`, agent.name === listed.default ? "default" : null].filter((part) => part !== null).join(" · "),
                current: agent.name === current,
              })),
            ],
            filterable: true,
            footer: "type to filter · Enter choose · Esc keeps it",
            cancel: null,
            maxWidth: 110,
          })
    if (chosen === null) return
    if (chosen.toLowerCase() === current.toLowerCase()) return this.say(current === "none" ? "this session runs as no agent already" : `this session runs as the ${current} agent already`)
    try {
      await session.setConfig("agent", chosen)
    } catch (error) {
      this.say(`/agent: ${error instanceof Error ? error.message : String(error)}`, "warn")
    }
  }

  /** `/rename <title>`. */
  private async rename(title: string): Promise<void> {
    const session = this.session
    if (session?.rename === undefined) return this.unavailable("/rename")
    if (title.trim() === "") return this.say("/rename needs a title, e.g. /rename fix the login test", "warn")
    try {
      this.transcript.session.title = await session.rename(title.trim())
      this.say(`renamed: ${this.transcript.session.title}`)
    } catch (error) {
      this.say(`/rename failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }

  /**
   * `/diff`: the per-file diffs of the selected step (a tool row) or turn
   * (an ending row), or else of the latest turn, in a full-screen reader.
   */
  private async showDiff(): Promise<void> {
    const session = this.session
    if (session?.diff === undefined) return this.unavailable("/diff", "", DEMO_DIFFS)
    const selected = this.conversation.selectedRow()
    // Each turn has its own diff, a turn a queued message followed too: the server is told which by the event that ended it.
    const outcome = selected?.kind === "outcome" ? selected : this.transcript.rows.findLast((row): row is OutcomeRow => row.kind === "outcome" && turnDiffParams(row) !== null)
    let result: DiffResult
    try {
      result = selected?.kind === "tool" ? await session.diff({ messageId: selected.messageId }) : outcome === undefined ? await session.diff({}) : await this.turnDiff(session, outcome)
    } catch (error) {
      return this.say(`/diff failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
    if (!result.available) return this.say(`no diff: ${result.message}`)
    if (selected?.kind !== "tool" && outcome !== undefined && outcome.serverDiff === null) {
      outcome.serverDiff = result
      this.transcript.changed(outcome)
    }
    const turn = outcome?.turn == null ? "this turn" : `turn ${outcome.turn}`
    const what = result.scope === "step" ? "this step" : turn
    if (result.files.length === 0) {
      // With nothing selected the latest turn was asked about: an earlier one is a selection away, which nothing else says.
      const earlier = result.scope === "turn" && selected?.kind !== "outcome" && (outcome?.turn ?? 1) > 1 ? ` (the latest); for an earlier turn's changes select its ending row (Alt-Up), then /diff` : ""
      return this.say(`${what} changed no file${earlier}`)
    }
    this.diffTurn = result.scope === "turn" ? { executionId: result.executionId, endSeq: outcome === undefined ? null : (turnDiffParams(outcome)?.endSeq ?? null) } : null
    await this.pager.show({
      title: `Changes of ${what}: ${plural(result.files.length, "file")} · +${result.files.reduce((sum, file) => sum + file.added, 0)} -${result.files.reduce((sum, file) => sum + file.removed, 0)}`,
      body: (columns) => {
        const lines: Span[][] = []
        const marks: number[] = []
        for (const file of result.files) {
          if (lines.length > 0) lines.push([])
          marks.push(lines.length)
          lines.push(...fileDiffLines(file, 100_000, columns))
        }
        return { lines, marks }
      },
      footer: this.diffTurn === null ? "↑↓ PgUp PgDn scroll · n p next/previous file · Esc close" : "↑↓ PgUp PgDn scroll · n p file · r review and comment · Esc close",
    })
    this.redraw()
  }

  /**
   * The diff of the turn an ending row ended, its own files only. A row whose ending the server no longer counts as
   * one (a turn cut off by a shutdown and resumed since) is asked for by its execution instead.
   */
  private async turnDiff(session: BackendSession, row: OutcomeRow): Promise<DiffResult> {
    const params = turnDiffParams(row) ?? {}
    const result = await session.diff!(params)
    if (result.available || result.reason !== "not_found" || params.endSeq === undefined || params.executionId === undefined) return result
    return session.diff!({ executionId: params.executionId })
  }

  /**
   * `/review`: the changes of the selected turn (the latest by default) line
   * by line, to comment on. Sending the review sends one ordinary message
   * made of the comments; leaving keeps them for the turn (`review-view.ts`).
   */
  private async openReview(shown: { readonly executionId: string | null; readonly endSeq: number | null } | null = null): Promise<void> {
    const session = this.session
    if (session?.diff === undefined) return this.unavailable("/review", "", DEMO_DIFFS)
    const delivery = () => (!this.transcript.activity.executing ? "sends it" : this.mode === "steer" ? "sends it into the running turn (steer)" : "queues it for after the running turn")
    const came = await this.review.run({ ...reviewTarget(this.transcript.rows, this.conversation.selectedRow(), shown), sessionId: session.id, diff: (params) => session.diff!(params), delivery, asking: () => this.asking() })
    this.input.focus()
    // A question that came up meanwhile waits for Tab: a key meant for the review must not answer it.
    if (this.dock !== null) this.dock.state.focused = false
    this.layout()
    if (came.say !== null) this.say(came.say.text, came.say.tone)
    if (came.message === null) return
    // The review's comments are let go of only once the engine has the message; until then they are kept, and a send that failed says so.
    const problem = await this.deliver(came.message, this.transcript.activity.executing ? this.mode : "steer")
    if (problem === null) return came.sent?.()
    this.say(`${problem.text} · ${came.kept ?? "the review is kept"}`, problem.tone)
  }

  /** Whether a question waits in the dock: one a full-screen view over the conversation hides. */
  private asking(): boolean {
    return this.dock !== null && !this.dock.state.withdrawn
  }

  private toggle(row: Row): void {
    if (!expandable(row)) return
    switch (row.kind) {
      case "tool": {
        if (row.subagent !== null) {
          // Its own conversation; a second expansion shows all of it when there is more than the latest part.
          row.expand = row.expand === 0 ? 1 : row.expand === 1 && row.subagent.transcript.rows.length > 12 ? 2 : 0
          if (row.expand === 1) this.fetchSubagent(row.subagent.sessionId)
          break
        }
        const full = row.expand === 1 && (row.output.split("\n").length > 24 || (row.progress?.split("\n").length ?? 0) > 24 || (typeof (row.display as { diff?: unknown } | null)?.diff === "string" && String((row.display as { diff: string }).diff).split("\n").length > 24))
        row.expand = row.expand === 0 ? 1 : full ? 2 : 0
        break
      }
      case "reasoning":
      case "user":
        row.expanded = !row.expanded
        break
      case "outcome":
        row.expanded = !row.expanded
        if (row.expanded) this.fetchDiff(row)
        break
      default:
        return
    }
    this.conversation.selected = row.id
    this.transcript.changed(row)
    this.conversation.keepInView(row)
    this.redraw()
  }

  /** A subagent's own stored log, for a row that knows nothing of its work (a session opened again). */
  private fetchSubagent(sessionId: string): void {
    const session = this.session
    const row = this.transcript.subagentRow(sessionId)
    if (session?.storedEvents === undefined || row?.subagent == null || row.subagent.transcript.rows.length > 0 || row.subagent.state === "running") return
    void session.storedEvents(sessionId).then(
      (events) => {
        if (this.session === session && this.transcript.loadSubagent(sessionId, events)) this.redraw()
      },
      (error: unknown) => this.say(`could not read the subagent's work: ${error instanceof Error ? error.message : String(error)}`, "warn"),
    )
  }

  /** The server's per-file diffs of a turn, for its expanded ending row. */
  private fetchDiff(row: OutcomeRow): void {
    const session = this.session
    if (session?.diff === undefined || turnDiffParams(row) === null || row.serverDiff !== null) return
    row.serverDiff = "loading"
    this.turnDiff(session, row).then(
      (result) => {
        row.serverDiff = result
        this.transcript.changed(row)
        this.redraw()
      },
      (error: unknown) => {
        row.serverDiff = { available: false, reason: "unavailable", message: error instanceof Error ? error.message : String(error) }
        this.transcript.changed(row)
        this.redraw()
      },
    )
  }

  // ---------------------------------------------------------------- leaving

  /** Leaves through the one door: the session closes (as a shutdown, bounded), the server stops, the terminal is put back. */
  leave(asked: number): Promise<number> {
    // Leaving without a session open is not a success: the reason is said after the TUI has gone, with status 1.
    const code = asked === 0 && this.problem !== null ? 1 : asked
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
      this.closeDock()
      const running = [...this.transcript.background.keys()]
      if (running.length > 0) this.farewell = `leaving stopped ${running.length === 1 ? "the background command" : `${running.length} background commands`} still running (${running.join(", ")}); the agent is told when the session is next opened`
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

  /** What the user should read after the screen is gone (background work that leaving stopped), or `null`. */
  farewell: string | null = null

  /** The session the TUI shows, for the line printed after it exits. */
  get sessionId(): string | null {
    return this.transcript.session.id ?? this.session?.id ?? null
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  // ---------------------------------------------------------------- drawing

  /**
   * A command the engine behind this session does not offer. In a demo that is every command that needs a model, files
   * or stored sessions: the answer says what a demo is and how to try the command for real (once in full, then in
   * short), never "this engine", which a first-time user has no word for.
   */
  private unavailable(command: string, also = "", inDemo = also): void {
    const backend = this.options.backend
    if (backend.demo !== true) return this.say(`${command} is not available here: the engine this session runs on (${backend.label}) does not offer it${also === "" ? "" : `; ${also}`}`, "warn")
    const more = inDemo === "" ? "" : ` ${inDemo}.`
    const first = !this.demoExplained
    this.demoExplained = true
    this.say(first ? `${command} does nothing in a demo: a demo replays a recorded session and has no model, files or sessions of its own.${more} To try it for real, run ${brand.binary} tui in a project of yours (${brand.binary} login first).` : `${command} does nothing in a demo.${more}`, "warn")
  }

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
    this.panel.width = panelWidth(this.renderer.width)
    const label = this.modeText()
    this.shownMode = label
    this.modeLabel.content = label
    this.modeLabel.width = textWidth(label)
    const columns = Math.max(10, this.renderer.width - textWidth(label))
    const rows = this.input.plainText.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((textWidth(line) + 1) / columns)), 0)
    const maxRows = Math.max(1, Math.min(MAX_INPUT_ROWS, Math.floor(this.renderer.height / 3)))
    this.inputRow.height = Math.max(1, Math.min(maxRows, rows))
    const palette = this.palette()
    this.hints.height = palette.length === 0 ? 1 : Math.min(palette.length, PALETTE_ROWS) + 1
    const dock = this.dock !== null && !this.dock.state.withdrawn ? this.dock : null
    if (dock?.feature !== undefined) this.printWholeCommand(dock.feature.id, dock.state)
    this.dockView.visible = dock !== null
    this.dockView.height = dock === null ? 0 : dockLines(dock.state, this.renderer.width, this.dockRows(), this.now(), !this.transcript.activity.executing).length
    this.redraw()
  }

  private modeText(): string {
    if (!this.transcript.activity.executing) return "› "
    return this.mode === "steer" ? "steer › " : "queue › "
  }

  private welcome(): string {
    return this.options.suggest === undefined ? "Type a message and press Enter. /help lists keys and commands." : "This is a demo: a recorded session, replayed without a model. Its prompt is in the input: press Enter to play it. /help lists keys."
  }

  private statusLine(columns: number): Span[] {
    const activity = this.transcript.activity
    const now = this.now()
    const parts: Span[] = []
    if (this.connection !== "connected") parts.push(span(this.connection === "starting" ? "⋯ starting the engine" : `✗ ${this.connection}`, this.connection === "starting" ? "dim" : "error"))
    else if (activity.executing) parts.push(...this.activityText(now))
    else if (this.dock?.feature !== undefined && !this.dock.state.withdrawn)
      // A question about the project's configuration waits: the session is not ready for a message until it is answered.
      parts.push(span("? ", "warn", { bold: true }), span("waiting for your answer", "warn"), span(` · ${this.dock.feature.subject}${this.dock.state.focused ? "" : " · Tab to answer"}`, "dim"))
    else parts.push(span("● ready", "dim"))
    // Work that goes on while the session's own turn waits or is over: a subagent in the background.
    const subagents = this.transcript.runningSubagents()
    if (this.connection === "connected" && subagents.length > 0 && (!activity.executing || subagents.some((view) => view.background)))
      parts.push(span(` · ${plural(subagents.length, "subagent")} at work${subagents.length === 1 ? `: ${truncate(subagents[0]!.title ?? "", 30)}` : ""}`, "accent"))
    const commands = [...this.transcript.background.entries()]
    const turn = activity.executing && activity.turnStartedAt !== null ? `turn ${formatDuration(Math.max(0, now - activity.turnStartedAt))} · ${requestsText(activity.steps, activity.summaryCalls)}` : ""
    const scrolled: Span[] = []
    if (this.conversation.scrolledAway) {
      const below = this.conversation.newBelow
      scrolled.push(span(`   ↑ scrolled${below > 0 ? ` · ${plural(below, "new line")} below` : ""} · Esc follows`, "warn"))
    }
    if (this.connection === "connected" && commands.length > 0) {
      // One command is named with as much of its text as the line has room for (at least 24 characters).
      const [id, command] = commands[0]!
      const head = ` · ◌ background ${id}: `
      const others = [...parts, ...scrolled].reduce((sum, part) => sum + textWidth(part.text), 0) + (turn === "" ? 0 : textWidth(turn) + 2)
      const room = Math.max(24, columns - others - textWidth(head))
      parts.push(span(commands.length === 1 ? `${head}${truncate(command.command, room)}` : ` · ◌ ${plural(commands.length, "background command")}`, "accent"))
    }
    parts.push(...scrolled)
    const left = parts
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
    if (activity.waiting !== null && !activity.stopping && this.dock?.state.withdrawn !== true) {
      const row = this.transcript.rows.find((candidate) => candidate.kind === "tool" && candidate.key === activity.waiting!.key) as Extract<Row, { kind: "tool" }> | undefined
      const what = row === undefined ? "a tool call" : `${row.name} ${row.arg}`.trim()
      const where = this.dock === null || this.dock.state.focused ? "" : " · Tab to answer"
      return [span("? ", "warn", { bold: true }), span("waiting for your answer", "warn"), span(` · ${truncate(what, 40)} · ${formatDuration(Math.max(0, now - activity.waiting.since))}${where}`, "dim")]
    }
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
    if (palette.length > 0) return paletteLines(palette, this.paletteIndex % palette.length, columns)
    const running = this.transcript.activity.executing
    // A running tool call can be stopped by itself: said while there is one the key would act on.
    const stoppable = running && this.session?.cancelCall !== undefined ? this.stoppable() : null
    if (stoppable !== null && !stoppable.stopAsked) {
      const what = `${stoppable.name || "this call"}${stoppable.arg === "" ? "" : ` ${stoppable.arg}`}`
      const full = `Ctrl-X stops ${what} only (the turn goes on) · Ctrl-C stops the turn · Enter ${this.mode === "steer" ? "steers" : "queues"}`
      const brief = "Ctrl-X stop this call · Ctrl-C stop the turn"
      return [[span(truncate(textWidth(full) <= columns ? full : brief, columns), "dim")]]
    }
    // The long form when it fits whole, else the short one: a hint is never cut in the middle of a key.
    const [long, short] = running
      ? this.mode === "steer"
        ? ["Enter steers the running turn (seen after the current step) · Ctrl-T: queue instead · Ctrl-C stop", "Enter steers · Ctrl-T queue · Ctrl-C stop"]
        : ["Enter queues for after this turn · Ctrl-T: steer instead · Ctrl-C stop", "Enter queues · Ctrl-T steer · Ctrl-C stop"]
      : ["Enter send · Alt-Enter new line · / commands · Ctrl-O expand · Ctrl-P panel · Ctrl-D quit", "Enter send · / commands · Ctrl-O expand · Ctrl-P panel"]
    const hint = textWidth(long) <= columns ? long : short
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
        approval: this.approvalInfo === null || !this.approvalInfo.enabled ? null : { mode: this.approvalInfo.mode, sandbox: this.approvalInfo.sandboxUnavailable === null },
        tasks: this.transcript.tasks(),
        subagents: [
          ...this.transcript.runningSubagents().map((view) => ({ title: view.title ?? view.sessionId, background: view.background, asking: view.asking })),
          ...[...this.transcript.background.entries()].map(([id, command]) => ({ title: `${id}: ${command.command}`, background: true, asking: false, kind: "command" as const })),
        ],
      },
      columns,
      rows,
    ).concat(this.options.backend.label === "acp" ? [] : [[], [span(this.options.backend.label, "dim")]])
  }
}

function describePlan(plan: RevertPlan, undo: boolean): Span[][] {
  if (plan.target === null) return [[span(`files are not restored: ${plan.unrestorable ?? "no snapshot"}`, "warn")]]
  if (plan.changes.length === 0) return [[span("no file needs to change", "dim")]]
  const describe = (status: string) => changeLabel(status, undo)
  const lines = ["modified", "mode_changed", "type_changed", "added", "deleted"].flatMap((status) => {
    const paths = plan.changes.filter((change) => change.status === status).map((change) => `${change.path}${!change.handEdited ? "" : change.editedBy?.kind === "unknown" ? ` (${CHANGED_DURING_COMMAND})` : " (changed outside this session)"}`)
    return paths.length === 0 ? [] : [[span(`${describe(status)}: `, "dim"), span(fileList(paths, 6))]]
  })
  if (plan.kept.length > 0) lines.push([span(`left alone (ignored or never recorded): ${fileList(plan.kept.map((item) => item.path), 6)}`, "dim")])
  return lines
}

function refusal(command: string, result: RevertResult): string {
  if (result.kind === "refused" && result.reason === "busy") return `${command} works only while the agent is idle; stop it first (Ctrl-C)`
  if (result.kind === "refused" && result.reason === "nothing_to_revert") return command === "/undo" ? "there is no turn to undo" : "there is nothing to redo"
  if (result.kind === "hand_edited") return "files changed outside this session in the meantime; nothing was changed"
  return `${command}: ${"message" in result ? result.message : "nothing was changed"}`
}

function tilde(path: string, home: string | null): string {
  return home !== null && home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
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
