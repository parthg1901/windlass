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
import { brand } from "@light-harness/core"
import { helpText, type Options, parseArgs } from "./args.ts"
import { revertable } from "./commands.ts"
import { type DemoScenario, findScenario, listScenarios } from "./demo/scenarios.ts"
import {
  CLOSE_TIMEOUT_MS,
  type Engine,
  type EngineEvent,
  EngineUnavailable,
  type Session,
  type TurnOutcome,
  exitCodeOf,
  turnOutcomeOf,
} from "./engine.ts"
import { type FakeSession } from "./fake-engine.ts"
import { JsonSink, PrettyRenderer, QuietSink, type Sink } from "./renderer.ts"
import { selectEngine } from "./select-engine.ts"
import { type EditorAction, Screen } from "./terminal.ts"
import { colorEnabled, displayWidth, formatDuration } from "./text.ts"

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

export async function run(io: Io): Promise<number> {
  const parsed = parseArgs(io.argv)
  switch (parsed.kind) {
    case "help":
      io.stdout.write(helpText())
      return 0
    case "version":
      io.stdout.write(`${brand.name} ${await version()}\n`)
      return 0
    case "error":
      return usage(io, parsed.message)
    case "acp": {
      // Loaded only here, so a normal run does not pay for the protocol SDK. The server builds the same harness the CLI does.
      const { serveStdio } = await import("@light-harness/acp")
      return serveStdio({ env: io.env, version: await version() })
    }
    case "list":
    case "run":
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
    })
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error
    io.stderr.write(`${brand.binary}: ${error.message}\n`)
    return 1
  }

  // `/undo` and `/redo` act on this session, when its engine can revert.
  screen?.attach(revertable(session))
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
  const flow = async (): Promise<number> => {
    if (autoplay) return playDemo(session as FakeSession, turn, options.demoSpeed)
    if (terminal === null) {
      const outcome = await turn(prompt!)
      return outcome === "closed" ? 1 : exitCodeOf(outcome)
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
  }
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

  const steer = (text: string) => {
    const queued = /^\/queue(\s|$)/.test(text.trim())
    const message = queued ? text.trim().replace(/^\/queue\s*/, "") : text
    if (message.trim() === "") return renderer.notice("/queue needs a message, e.g. /queue then update the changelog", "warn")
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
        const trimmed = action.text.trim()
        if (trimmed === "/exit" || trimmed === "/quit") {
          if (control.running) return context.leave(0)
          return waiting?.(null)
        }
        if (control.running) return trimmed === "" ? undefined : steer(action.text)
        return waiting?.(action.text)
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
      // With nothing running there is nothing to queue behind: a queued message is a prompt.
      text = /^\/queue\s/.test(text.trim()) ? text.trim().replace(/^\/queue\s*/, "") : text
      renderer.prompt(text)
    }
    screen.show("› ", STEER_HINT)
    if ((await context.turn(text)) === "closed") break
  }
  return 0
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
    if (outcome !== null) this.resolve(outcome)
  }

  private resolve(outcome: TurnOutcome | "closed"): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.(outcome)
  }
}

async function listing(io: Io, engine: Engine, what: "sessions" | "models", options: Options, cwd: string): Promise<number> {
  const flag = what === "sessions" ? "--list-sessions" : "--models"
  const table =
    what === "sessions"
      ? (await engine.listSessions?.({ cwd }))?.map((row) => ({ row, cells: [row.id, localTime(row.updatedAt), row.model, row.title ?? "(untitled)"] }))
      : (await engine.listModels?.())?.map((row) => ({
          row,
          cells: [`${row.isDefault ? "*" : " "} ${row.id}`, row.efforts.length === 0 ? "" : `effort: ${row.efforts.join(", ")}`, row.description ?? ""],
        }))
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

function usage(io: Io, message: string): number {
  io.stderr.write(`${brand.binary}: ${message}\nRun \`${brand.binary} --help\` for usage.\n`)
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
  const pkg: { version?: string } = await Bun.file(new URL("../package.json", import.meta.url)).json()
  return pkg.version ?? "0.0.0"
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
