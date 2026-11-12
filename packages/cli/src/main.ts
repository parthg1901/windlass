#!/usr/bin/env bun
/**
 * The command-line entry point: parse arguments, open a session through the
 * engine interface, send prompts, render events, and map the result to an
 * exit code. `run` takes its process dependencies as `Io` so tests can drive
 * it in-process; `main` binds them to the real process.
 *
 * Every way out goes through the same door: the engine's `close` is called and
 * waited for at most `CLOSE_TIMEOUT_MS`, the terminal is put back, and the code
 * says why (0 done, 1 failed, 2 usage, 3 done with failing checks left
 * unresolved, 130 Ctrl-C, 141 output closed, 143 SIGTERM). The one exception
 * is a second Ctrl-C within two seconds, which leaves at once after putting
 * the terminal back.
 */
import { appendFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { brand, versionLine, versionString } from "@light-harness/core"
import { helpText, type Options, parseArgs } from "./args.ts"
import { revertable } from "./commands.ts"
import { type DemoScenario, findScenario, listScenarios } from "./demo/scenarios.ts"
import {
  type ApprovalRequest,
  type Approver,
  CLOSE_TIMEOUT_MS,
  EXIT_APPROVAL_REQUIRED,
  type Engine,
  type EngineEvent,
  EngineUnavailable,
  type Session,
  type TurnOutcome,
  endedForApproval,
  exitCodeOf,
  exitCodeOfRefusal,
  turnOutcomeOf,
} from "./engine.ts"
import { type FakeSession } from "./fake-engine.ts"
import { JsonSink, PrettyRenderer, QuietSink, type Sink } from "./renderer.ts"
import { selectEngine } from "./select-engine.ts"
import { selfCommand } from "./self.ts"
import { type EditorAction, Screen } from "./terminal.ts"
import { BUILTIN_COMMANDS, helpLines, lookup, unknownCommandText } from "./slash.ts"
import { colorEnabled, displayWidth, flatten, formatDuration, truncate } from "./text.ts"

export interface Io {
  readonly argv: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly stdout: {
    write(text: string): void
    readonly isTTY: boolean
    columns(): number
    /** Subscribes to the reader going away (EPIPE). Returns the unsubscribe function. */
    onClosed?(handler: () => void): () => void
  }
  readonly stderr: { write(text: string): void }
  readonly stdin: {
    readonly isTTY: boolean
    readAll(): Promise<string>
    /** Raw keyboard input for the interactive mode: raw mode on, `onData` gets each read. Returns the function that undoes both. */
    listen?(onData: (data: string) => void): () => void
  }
  /** Subscribes to SIGINT (Ctrl-C) or SIGTERM. Returns the unsubscribe function. */
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void
  /** Leaves at once, for the second Ctrl-C. */
  exit(code: number): never
  /** An engine to use instead of selecting one (tests). */
  readonly engine?: () => Engine
  /** Where the real engine is loaded from, relative to `select-engine.ts` (tests). */
  readonly realEngineModule?: string
}

/** How long after a first Ctrl-C a second one exits instead of waiting for the stop. */
export const DOUBLE_INTERRUPT_MS = 2000

/** Exit codes for the ways out that are not a turn's outcome. */
export const EXIT = { usage: 2, interrupted: 130, outputClosed: 141, terminated: 143 } as const

/** Names a file the fake engine appends `close` and `closed` to; for tests of the exit paths. */
export const DEMO_TRACE_ENV = `${brand.binary.toUpperCase()}_DEMO_TRACE`

const STEER_HINT = "type to steer · /queue <message> for after this turn"

/** What a subcommand that is not a run (`fork`, `replay`) passes where a run's options are expected. */
const SUBCOMMAND_DEFAULTS: Options = {
  prompt: null,
  session: null,
  continue: false,
  model: null,
  effort: null,
  maxSteps: null,
  approval: null,
  unattended: null,
  cwd: null,
  output: "pretty",
  showReasoning: false,
  interactive: false,
  demo: null,
  demoSpeed: 1,
  demoGraceMs: null,
  engine: "acp",
}

export async function run(io: Io): Promise<number> {
  const parsed = parseArgs(io.argv)
  switch (parsed.kind) {
    case "help":
      io.stdout.write(helpText())
      return 0
    case "version":
      io.stdout.write(`${versionLine()}\n`)
      return 0
    case "login": {
      const { runLogin } = await import("./login.ts")
      return runLogin(parsed.argv, io)
    }
    case "error":
      return usage(io, parsed.message, io.argv[0] === "fork" || io.argv[0] === "replay" ? io.argv[0] : null)
    case "usage":
      io.stdout.write(parsed.text)
      return 0
    case "fork":
    case "replay": {
      const options = parsed.options
      const cwd = resolve(io.cwd, options.cwd ?? ".")
      if (!isDirectory(cwd)) return usage(io, `--cwd ${options.cwd}: not a directory`)
      const engine = await engineFor(io, { ...SUBCOMMAND_DEFAULTS, engine: options.engine }, null)
      if (engine === null) return EXIT.usage
      const { runFork, runReplay } = await import("./subcommands.ts")
      const subIo = { cwd, stdout: io.stdout, stderr: io.stderr, onSignal: io.onSignal }
      if (parsed.kind === "fork") return runFork(subIo, engine, parsed.options, cwd)
      return runReplay(subIo, engine, parsed.options, cwd)
    }
    case "acp": {
      // Loaded only here, so a normal run does not pay for the protocol SDK. The server builds the same harness the CLI does.
      const { serveStdio } = await import("@light-harness/acp")
      return serveStdio({ env: io.env, version: await version() })
    }
    case "list":
    case "run":
    case "tui":
      break
  }
  const options = parsed.options
  if (options.demo === "list") {
    io.stdout.write(listScenarios())
    return 0
  }
  const demo = options.demo === null ? null : findScenario(options.demo)
  if (options.demo !== null && demo === null) return usage(io, `no demo scenario named "${options.demo}"; see --demo list`)

  const cwd = resolve(io.cwd, options.cwd ?? ".")
  if (!isDirectory(cwd)) return usage(io, `--cwd ${options.cwd}: not a directory`)
  if (parsed.kind === "list") {
    const engine = await engineFor(io, options, demo)
    return engine === null ? EXIT.usage : listing(io, engine, parsed.what, options, cwd)
  }
  // The TUI is opt-in until it becomes the default: `lh tui`, or `LH_TUI=1` for an interactive `lh` with no prompt.
  const tuiByDefault = parsed.kind === "run" && options.prompt === null && !options.interactive && options.output === "pretty" && io.stdin.isTTY && io.stdout.isTTY && io.env[`${brand.binary.toUpperCase()}_TUI`] === "1"
  if (parsed.kind === "tui" || tuiByDefault) return tui(io, options, demo, cwd)

  const prompt = options.prompt ?? (io.stdin.isTTY || demo !== null ? null : (await io.stdin.readAll()).trim())
  if (prompt === "") return usage(io, "the prompt on stdin is empty")
  const autoplay = demo !== null && prompt === null && !options.interactive
  const interactive = !autoplay && (prompt === null || options.interactive)
  if (interactive && options.output !== "pretty") return usage(io, `--${options.output} needs a prompt (as arguments or on stdin)`)
  if (interactive && !io.stdin.isTTY) return usage(io, "interactive mode needs a terminal on stdin")

  const engine = await engineFor(io, options, demo)
  if (engine === null) return EXIT.usage
  const screen = interactive ? new Screen({ write: (text) => io.stdout.write(text), columns: () => io.stdout.columns(), color: colorEnabled(io.stdout.isTTY, io.env) }) : null
  const sink = makeSink(io, options, autoplay, screen)

  let session: Session
  try {
    session = await engine.open({
      session: options.session !== null ? { kind: "resume", id: options.session } : options.continue ? { kind: "continue" } : { kind: "new" },
      cwd,
      model: options.model,
      effort: options.effort,
      maxSteps: options.maxSteps,
      approval: options.approval,
      unattended: options.unattended,
      // Someone can answer a question only where there is a prompt to answer it at.
      attended: interactive,
    })
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error
    io.stderr.write(`${brand.binary}: ${error.message}\n`)
    return exitCodeOfRefusal(error)
  }

  // `/undo` and `/redo` act on this session, when its engine can revert.
  screen?.attach(revertable(session))
  // A tool call that needs approval asks at the prompt, the way `/undo` asks about hand edits.
  if (screen !== null) session.setApprover?.(approverAt(screen, session))
  const terminal = screen === null ? null : new TerminalMode(io, screen)
  const leaving = new Deferred<number>()
  const control = { running: false, lastInterrupt: 0, leaving: false }
  /** Leaves through the common door: close the engine (bounded), tidy up, exit with `code`. A second request leaves at once. */
  const leave = (code: number) => {
    if (control.leaving) return leaveNow(code)
    control.leaving = true
    leaving.resolve(code)
  }
  const leaveNow = (code: number): never => {
    sink.close()
    terminal?.restore()
    return io.exit(code)
  }
  const onCtrlC = () => {
    if (!control.running || control.leaving) return leave(EXIT.interrupted)
    const now = Date.now()
    if (now - control.lastInterrupt < DOUBLE_INTERRUPT_MS) {
      sink.notice("exiting without waiting for the stop", "warn")
      return leaveNow(EXIT.interrupted)
    }
    control.lastInterrupt = now
    session.interrupt()
    sink.interruptRequested()
  }

  const turns = new TurnWatcher(session, sink)
  const turn = async (text: string): Promise<TurnOutcome | "closed"> => {
    control.running = true
    const done = turns.next()
    await session.send(text)
    const outcome = await done
    control.running = false
    return outcome
  }

  const unsubscribe = [
    io.onSignal("SIGINT", onCtrlC),
    io.onSignal("SIGTERM", () => leave(EXIT.terminated)),
    io.stdout.onClosed?.(() => leave(EXIT.outputClosed)),
  ]
  const resumed = options.session !== null || options.continue
  const flow = async (): Promise<number> => {
    if (autoplay) return playDemo(session as FakeSession, turn, options.demoSpeed)
    // Which session this is, before anything else: a new one, or the one resumed with its title and its turns.
    if (terminal !== null && demo === null) await sayOpened(sink as PrettyRenderer, session, resumed)
    if (terminal === null) {
      const outcome = await turn(prompt!)
      if (outcome === "closed") return 1
      // Not a failure of the work: the run was not allowed to go on (`--unattended stop`).
      return turns.stoppedForApproval ? EXIT_APPROVAL_REQUIRED : exitCodeOf(outcome)
    }
    return interactiveLoop({ terminal, renderer: sink as PrettyRenderer, session, turn, control, onCtrlC, leave, first: prompt })
  }
  try {
    return await Promise.race([flow(), leaving.promise])
  } finally {
    // From here a Ctrl-C or SIGTERM leaves at once instead of waiting for the engine.
    control.leaving = true
    const closed = await within(CLOSE_TIMEOUT_MS, Promise.all([session.close(), turns.ended]))
    for (const off of unsubscribe) off?.()
    sink.close()
    // The terminal is put back before anything else is written, so nothing lands inside the input footer.
    terminal?.restore()
    if (!closed) io.stderr.write(`${brand.binary}: the engine did not stop within ${formatDuration(CLOSE_TIMEOUT_MS)}; exiting anyway\n`)
    // The engine went away on its own (its process died): said last, where it is seen.
    const lost = session.lost?.() ?? null
    if (lost !== null) io.stderr.write(`${brand.binary}: ${lost}\n`)
    // How to come back to it, as the TUI says on leaving; a one-shot run's output stays only the run's.
    else if (terminal !== null && demo === null) io.stdout.write(`${brand.binary}: session ${session.id} · resume with: ${brand.binary} --session ${session.id}\n`)
  }
}

/** Hands the run to the full-screen TUI, loaded only here. */
async function tui(io: Io, options: Options, demo: DemoScenario | null, cwd: string): Promise<number> {
  const { runTui } = await import("@light-harness/tui")
  return runTui({
    cwd,
    target: options.session !== null ? { kind: "resume", id: options.session } : options.continue ? { kind: "continue" } : { kind: "new" },
    settings: { model: options.model, effort: options.effort, maxSteps: options.maxSteps },
    env: io.env,
    version: await version(),
    serverCommand: selfCommand(["acp"]),
    demo: demo === null ? null : { scenario: demo.scenario, name: demo.name, speed: options.demoSpeed, graceMs: options.demoGraceMs },
  })
}

/** The engine for this run, or `null` after saying why there is none. */
async function engineFor(io: Io, options: Options, demo: DemoScenario | null): Promise<Engine | null> {
  if (io.engine !== undefined && demo === null) return io.engine()
  const trace = io.env[DEMO_TRACE_ENV]
  const selected = await selectEngine(
    demo === null
      ? null
      : {
          scenario: demo.scenario,
          options: {
            speed: options.demoSpeed,
            ...(options.demoGraceMs === null ? {} : { graceMs: options.demoGraceMs }),
            ...(trace === undefined || trace === "" ? {} : { trace: (line: string) => appendFileSync(trace, `${line}\n`) }),
          },
        },
    io.realEngineModule,
    options.engine,
    { env: io.env, stderr: (text) => io.stderr.write(text), version: await version() },
  )
  if (selected.kind === "engine") return selected.engine
  const why = selected.reason === null ? "" : ` (${selected.reason})`
  io.stderr.write(`${brand.binary}: the real engine is not available in this build${why}; try \`${brand.binary} --demo list\`\n`)
  return null
}

/** Plays every scripted turn, typing each scripted prompt. Stops early after a user interrupt. */
async function playDemo(session: FakeSession, turn: (text: string) => Promise<TurnOutcome | "closed">, speed: number): Promise<number> {
  let code = 0
  while (session.remaining > 0) {
    const outcome = await turn(session.nextPrompt ?? "")
    if (outcome === "closed") return 1
    code = exitCodeOf(outcome)
    if (session.remaining > 0 && speed > 0) await Bun.sleep(900 / speed)
  }
  return code
}

interface Interactive {
  readonly terminal: TerminalMode
  readonly renderer: PrettyRenderer
  readonly session: Session
  readonly turn: (text: string) => Promise<TurnOutcome | "closed">
  readonly control: { running: boolean }
  readonly onCtrlC: () => void
  readonly leave: (code: number) => void
  readonly first: string | null
}

/**
 * Prompts, runs turns, and keeps the input open while a turn runs: an entry
 * submitted then is sent to the agent at once as a steer (or held as a queued
 * message with a leading `/queue `), and the engine's admission and delivery
 * events say what became of it.
 */
async function interactiveLoop(context: Interactive): Promise<number> {
  const { terminal, renderer, session, control } = context
  const screen = terminal.screen
  let waiting: ((text: string | null) => void) | null = null

  const steer = (message: string, queued: boolean) => {
    session.send(message, { delivery: queued ? "queue" : "steer" }).then(
      (id) => {
        if (id === null) renderer.notice("not sent: the session is not taking input right now", "warn")
      },
      (error: unknown) => renderer.notice(`not sent: ${error instanceof Error ? error.message : String(error)}`, "error"),
    )
  }
  terminal.start((action) => {
    switch (action.kind) {
      case "interrupt":
        if (control.running) return context.onCtrlC()
        // At the prompt Ctrl-C clears what was typed, as in a shell.
        if (screen.entry !== "") return screen.clear()
        return renderer.notice("press Ctrl-D or type /exit to leave")
      case "eof":
        if (!control.running) waiting?.(null)
        return
      case "submit": {
        // A `/word` is a command or nothing: an unknown one is never sent (it would cost a request and title the session).
        const found = lookup(action.text, [BUILTIN_COMMANDS])
        if (found.kind === "unknown") return renderer.notice(unknownCommandText(found), "warn")
        if (found.kind === "message") {
          if (control.running) return found.text.trim() === "" ? undefined : steer(found.text, false)
          return waiting?.(found.text)
        }
        const name = found.command.name
        switch (name) {
          case "exit":
            if (control.running) return context.leave(0)
            return waiting?.(null)
          case "help":
            for (const line of helpLines([BUILTIN_COMMANDS])) renderer.notice(line)
            return
          case "clear-taint":
            return void clearTaint(session, renderer, screen)
          case "approval":
            return void approvalMode(session, renderer, found.rest)
          case "diff":
            return void showDiff(session, renderer)
          case "queue":
            if (found.rest === "") return renderer.notice("/queue needs a message, e.g. /queue then update the changelog", "warn")
            // With nothing running there is nothing to queue behind: a queued message is a prompt.
            return control.running ? steer(found.rest, true) : waiting?.(found.rest)
          case "undo":
          case "redo":
            // The editor runs `/undo` and `/redo` themselves; one with words after it reaches here.
            return renderer.notice(`/${name} takes nothing after it`, "warn")
          default:
            return renderer.notice(`/${name} cannot be run here`, "warn")
        }
      }
    }
  })

  let pending = context.first
  for (;;) {
    let text = pending
    pending = null
    if (text === null) {
      renderer.beforePrompt()
      screen.show("› ")
      text = await new Promise<string | null>((done) => {
        waiting = done
      })
      waiting = null
      if (text === null) break
      if (text.trim() === "") continue
      renderer.prompt(text)
    }
    screen.show("› ", STEER_HINT)
    // The events ended under a running turn: the engine went away. Leaving is the only thing left to do.
    if ((await context.turn(text)) === "closed") return 1
  }
  return 0
}

/** The line the interactive mode starts with: which session, and for a resumed one its title and its turns. */
async function sayOpened(renderer: PrettyRenderer, session: Session, resumed: boolean): Promise<void> {
  const described = await session.describe?.().catch(() => null)
  // The events the stream will bring are the ones after these: the renderer counts turns from the first.
  if (described != null) renderer.primeTurns(described.events)
  const hint = " · /help lists the commands"
  if (!resumed || described == null) return renderer.notice(`${resumed ? "resumed" : "new"} session ${session.id}${hint}`)
  const title = described.title === null ? "" : ` "${truncate(flatten(described.title), 50)}"`
  const turns = `${described.turns === 1 ? "1 turn" : `${described.turns} turns`}${described.undone > 0 ? ` (${described.undone} undone)` : ""}`
  renderer.notice(`resumed session ${session.id}${title} · ${turns}${hint}`)
}

/**
 * Answers a tool call's approval question at the prompt. The question itself
 * is already on the screen (the renderer shows `approval.requested`); this
 * puts the choices in place of the prompt and reads one line. The first word
 * picks the choice; anything after it is the user's note to the agent. Words
 * that pick nothing decline, and are the note: saying something else instead
 * of answering is a "no, and here is why". Backing out (Ctrl-C) stops the turn.
 */
export function approverAt(screen: Pick<Screen, "ask">, session: Pick<Session, "interrupt">): Approver {
  return async (request: ApprovalRequest) => {
    const choices = request.question.choices
    const has = (id: string) => choices.some((choice) => choice.id === id)
    const keys = [has("once") ? "[a]llow once" : null, has("session") ? "this [s]ession" : null, has("project") ? "this [p]roject" : null, "[N]o"].filter((item) => item !== null)
    // A subagent's question says whose it is where it is answered: several may be at work.
    const who = request.subagent == null ? "" : `for subagent "${truncate(flatten(request.subagent), 40)}": `
    const entry = await screen.ask(`${who}${keys.join(" · ")} › `)
    if (entry === null) {
      session.interrupt()
      return null
    }
    const [word = "", ...rest] = entry.trim().split(/\s+/)
    const note = rest.join(" ")
    const picked = ({ a: "once", y: "once", yes: "once", allow: "once", once: "once", s: "session", session: "session", p: "project", project: "project", n: "deny", no: "deny", deny: "deny", "": "deny" } as const)[word.toLowerCase()]
    if (picked === undefined) return { choice: "deny", note: entry.trim() }
    // A choice this question does not offer (nothing can be remembered for it) is answered with the nearest one that asks for less.
    const choice = has(picked) ? picked : picked === "deny" ? "deny" : "once"
    return { choice, ...(note === "" ? {} : { note }) }
  }
}

/**
 * `/clear-taint`: after a confirmation that says what clearing means, tells
 * the engine the conversation is trustworthy again; the event that follows is
 * what is shown.
 */
async function clearTaint(session: Session, renderer: PrettyRenderer, screen: Pick<Screen, "ask">): Promise<void> {
  if (session.clearTaint === undefined) return renderer.notice("/clear-taint is not available with this engine", "warn")
  renderer.notice("Clearing says you trust the untrusted content in this conversation: network access for a command and commands outside the sandbox then follow your mode and earlier approvals again. The content stays, and the model may still act on it.")
  const answer = await screen.ask("clear it? [y/N] › ")
  if (answer === null || !/^y(es)?$/i.test(answer.trim())) return renderer.notice("the conversation stays untrusted")
  try {
    if (!(await session.clearTaint())) renderer.notice("there is nothing to clear: no untrusted content is in this conversation")
  } catch (error) {
    renderer.notice(`/clear-taint failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/** `/approval [ask|auto|full]`: says the session's approval mode, or switches it from the next tool call. */
async function approvalMode(session: Session, renderer: PrettyRenderer, mode: string): Promise<void> {
  if (session.approvalMode === undefined) return renderer.notice("/approval is not available with this engine", "warn")
  const asked = mode.trim().toLowerCase()
  if (asked !== "" && !["ask", "auto", "full"].includes(asked)) return renderer.notice("/approval takes ask, auto or full", "warn")
  try {
    const state = await session.approvalMode(asked === "" ? undefined : asked)
    const kept = asked !== "" && state.mode !== asked ? ` (the project's settings keep it at ${state.mode})` : ""
    renderer.notice(`approval mode: ${state.mode ?? "off"}${asked === "" ? "" : " from the next tool call"}${kept}${state.tainted ? " · untrusted content is in the conversation (/clear-taint)" : ""}${asked === "" ? " · /approval ask|auto|full switches" : ""}`)
  } catch (error) {
    renderer.notice(`/approval failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/** `/diff`: the files the latest turn changed, each with its patch (bounded), binary files flagged. */
async function showDiff(session: Session, renderer: PrettyRenderer): Promise<void> {
  if (session.diff === undefined) return renderer.notice("/diff is not available with this engine", "warn")
  try {
    const result = await session.diff()
    if (!result.available) return renderer.notice(`no diff: ${result.message}`)
    if (result.files.length === 0) return renderer.notice("the latest turn changed no file")
    renderer.diff(result.files)
  } catch (error) {
    renderer.notice(`/diff failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/** The terminal while the interactive input is open: raw mode, bracketed paste, and the footer. */
class TerminalMode {
  private stop: (() => void) | null = null
  private restored = false

  constructor(
    private readonly io: Io,
    readonly screen: Screen,
  ) {}

  start(handle: (action: EditorAction) => void): void {
    if (this.io.stdin.listen === undefined) throw new Error("interactive mode needs keyboard input")
    this.stop = this.io.stdin.listen((data) => this.screen.input(data, handle))
    this.io.stdout.write("\x1b[?2004h")
  }

  /** Idempotent: removes the footer, turns bracketed paste and raw mode off, and lets go of stdin. */
  restore(): void {
    if (this.restored) return
    this.restored = true
    this.screen.close()
    if (this.stop === null) return
    this.io.stdout.write("\x1b[?2004l")
    this.stop()
  }
}

/** Feeds the session's events to the sink and resolves turn waiters when an execution ends. */
class TurnWatcher {
  readonly ended: Promise<void>
  private waiter: ((outcome: TurnOutcome | "closed") => void) | null = null
  private done = false
  /** Whether the latest turn was ended because a call needed approval that nobody could give. */
  stoppedForApproval = false

  constructor(session: Session, sink: Sink) {
    this.ended = (async () => {
      for await (const item of session.events) this.observe(item, sink)
      this.done = true
      this.resolve("closed")
    })()
  }

  next(): Promise<TurnOutcome | "closed"> {
    if (this.done) return Promise.resolve("closed")
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  private observe(item: EngineEvent, sink: Sink): void {
    sink.event(item)
    const outcome = turnOutcomeOf(item)
    if (outcome !== null) {
      this.stoppedForApproval = endedForApproval(item)
      this.resolve(outcome)
    }
  }

  private resolve(outcome: TurnOutcome | "closed"): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.(outcome)
  }
}

async function listing(io: Io, engine: Engine, what: "sessions" | "models", options: Options, cwd: string): Promise<number> {
  const flag = what === "sessions" ? "--list-sessions" : "--models"
  let table
  try {
    table =
      what === "sessions"
        ? (await engine.listSessions?.({ cwd }))?.map((row) => ({ row, cells: [row.id, localTime(row.updatedAt), row.model, row.title ?? "(untitled)"] }))
        : (await engine.listModels?.())?.map((row) => ({
            row,
            cells: [`${row.isDefault ? "*" : " "} ${row.id}`, row.efforts.length === 0 ? "" : `effort: ${row.efforts.join(", ")}`, row.description ?? ""],
          }))
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error
    io.stderr.write(`${brand.binary}: ${error.message}\n`)
    return exitCodeOfRefusal(error)
  }
  if (table === undefined) {
    io.stderr.write(`${brand.binary}: ${flag} is not supported by this engine\n`)
    return 1
  }
  if (options.output === "json") {
    for (const { row } of table) io.stdout.write(`${JSON.stringify(row)}\n`)
    return 0
  }
  if (table.length === 0) {
    io.stdout.write(what === "sessions" ? `no sessions in ${cwd}\n` : "no models\n")
    return 0
  }
  const widths = table[0]!.cells.map((_, column) => Math.max(...table.map((line) => displayWidth(line.cells[column]!))))
  for (const { cells } of table)
    io.stdout.write(`${cells.map((cell, column) => (column === cells.length - 1 ? cell : cell + " ".repeat(widths[column]! - displayWidth(cell)))).join("  ").trimEnd()}\n`)
  if (what === "models" && table.some(({ row }) => "isDefault" in row && row.isDefault)) io.stdout.write("\n* the default when --model is not given\n")
  return 0
}

function localTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function makeSink(io: Io, options: Options, echoPrompts: boolean, screen: Screen | null): Sink {
  const write = (text: string) => io.stdout.write(text)
  const writeError = (text: string) => io.stderr.write(text)
  switch (options.output) {
    case "json":
      return new JsonSink(write, writeError)
    case "quiet":
      return new QuietSink(write, writeError)
    case "pretty":
      return new PrettyRenderer({
        write: screen === null ? write : (text) => screen.write(text),
        color: colorEnabled(io.stdout.isTTY, io.env),
        columns: () => io.stdout.columns(),
        live: io.stdout.isTTY && screen === null,
        showReasoning: options.showReasoning,
        echoPrompts,
        ...(screen === null ? {} : { status: (text: string | null) => screen.setStatus(text) }),
      })
  }
}

function usage(io: Io, message: string, subcommand: string | null = null): number {
  io.stderr.write(`${brand.binary}: ${message}\nRun \`${brand.binary}${subcommand === null ? "" : ` ${subcommand}`} --help\` for usage.\n`)
  return EXIT.usage
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

async function version(): Promise<string> {
  return versionString()
}

/** Whether `work` finished within `ms`. */
async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms)
  })
  const finished = await Promise.race([work.then(() => true as const), timeout])
  clearTimeout(timer)
  return finished
}

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }
}

/** Binds `run` to the real process. */
export async function main(): Promise<number> {
  // A reader that goes away (`| head`) shows up as EPIPE on the next write. From then on nothing more is written there.
  let stdoutClosed = false
  const closedHandlers = new Set<() => void>()
  process.stdout.on("error", () => {
    if (stdoutClosed) return
    stdoutClosed = true
    for (const handler of closedHandlers) handler()
  })
  process.stderr.on("error", () => {})
  return run({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: {
      write: (text) => {
        if (!stdoutClosed) process.stdout.write(text)
      },
      isTTY: process.stdout.isTTY === true,
      columns: () => process.stdout.columns || Number(process.env.COLUMNS) || 80,
      onClosed: (handler) => {
        closedHandlers.add(handler)
        return () => void closedHandlers.delete(handler)
      },
    },
    stderr: { write: (text) => void process.stderr.write(text) },
    stdin: {
      isTTY: process.stdin.isTTY === true,
      readAll: () => Bun.stdin.text(),
      listen: (onData) => {
        const stdin = process.stdin
        const raw = stdin.isTTY === true
        if (raw) stdin.setRawMode(true)
        stdin.setEncoding("utf8")
        stdin.on("data", onData)
        stdin.resume()
        // Whatever else happens, a process that exits leaves the terminal as it found it.
        const restore = () => {
          if (raw) stdin.setRawMode(false)
        }
        process.once("exit", restore)
        return () => {
          stdin.off("data", onData)
          restore()
          process.off("exit", restore)
          stdin.pause()
        }
      },
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler)
      return () => void process.off(signal, handler)
    },
    exit: (code) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.exit(code)
    },
  })
}

if (import.meta.main) {
  const code = await main()
  process.exitCode = code
  // Anything still holding the event loop open (a stray timer) must not keep a finished CLI alive.
  setTimeout(() => process.exit(code), 1000).unref()
}
