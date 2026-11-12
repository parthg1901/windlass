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
import type { CommandsResult } from "@windlass/acp/extensions"
import { type CallId, type MessageId, brand, versionLine, versionString } from "@windlass/core"
import { agentLines, compactText, taskLines, tasksProgress } from "./agents.ts"
import { helpText, type Options, parseArgs } from "./args.ts"
import { revertable } from "./commands.ts"
import { type Line, recapLines } from "./features.ts"
import { type FeatureCommand, type FeatureIo, FeatureWatch, JsonNotices, runFeatureCommand } from "./feature-commands.ts"
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
import { BUILTIN_COMMANDS, clientCommands, commandProblemLines, helpLines, lookup, unknownCommandText, unusableCommandLines, userCommands } from "./slash.ts"
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
export const DEMO_TRACE_ENV = `${brand.envPrefix}DEMO_TRACE`

const STEER_HINT = "type to steer · /queue <message> for after this turn"

/** What a subcommand that is not a run (`fork`, `replay`) passes where a run's options are expected. */
const SUBCOMMAND_DEFAULTS: Options = {
  prompt: null,
  session: null,
  continue: false,
  model: null,
  effort: null,
  agent: null,
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
      const { serveStdio } = await import("@windlass/acp")
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
  // The TUI is opt-in until it becomes the default: `windlass tui`, or `WINDLASS_TUI=1` for an interactive `windlass` with no prompt.
  const tuiByDefault = parsed.kind === "run" && options.prompt === null && !options.interactive && options.output === "pretty" && io.stdin.isTTY && io.stdout.isTTY && io.env[`${brand.envPrefix}TUI`] === "1"
  if (parsed.kind === "tui" || tuiByDefault) return tui(io, options, demo, cwd)

  const prompt = options.prompt ?? (io.stdin.isTTY || demo !== null ? null : (await io.stdin.readAll()).trim())
  if (prompt === "") return usage(io, "the prompt on stdin is empty")
  const autoplay = demo !== null && prompt === null && !options.interactive
  const interactive = !autoplay && (prompt === null || options.interactive)
  if (interactive && options.output !== "pretty") return usage(io, `--${options.output} needs a prompt (as arguments or on stdin)`)
  if (interactive && !io.stdin.isTTY) return usage(io, "interactive mode needs a terminal on stdin")

  const engine = await engineFor(io, options, demo, interactive)
  if (engine === null) return EXIT.usage
  // A one-prompt run whose prompt is `/word` and no command file's is over before a session is opened for it: nothing
  // is sent, no session is created or resumed, and what the word could have been is said where usage errors go.
  if (!interactive && !autoplay && prompt !== null && engine.commands !== undefined) {
    const list = engine.commands.bind(engine)
    const first = await commandEntry(() => list(cwd, clientCommands()), prompt)
    if (first.kind !== "send") {
      for (const line of refusedPrompt(first)) io.stderr.write(`${line.startsWith(" ") ? "" : `${brand.binary}: `}${line}\n`)
      return EXIT.usage
    }
  }
  const screen = interactive ? new Screen({ write: (text) => io.stdout.write(text), columns: () => io.stdout.columns(), color: colorEnabled(io.stdout.isTTY, io.env) }) : null
  const sink = makeSink(io, options, autoplay, screen)
  // Keys typed while the engine starts are kept for the prompt: raw mode from now on, so nothing is echoed as if sent.
  const early = screen === null ? null : new TerminalMode(io, screen)
  early?.capture()

  let session: Session
  try {
    session = await engine.open({
      session: options.session !== null ? { kind: "resume", id: options.session } : options.continue ? { kind: "continue" } : { kind: "new" },
      cwd,
      model: options.model,
      effort: options.effort,
      agent: options.agent,
      maxSteps: options.maxSteps,
      approval: options.approval,
      unattended: options.unattended,
      // Someone can answer a question only where there is a prompt to answer it at.
      attended: interactive,
    })
  } catch (error) {
    early?.restore()
    if (!(error instanceof EngineUnavailable)) throw error
    io.stderr.write(`${brand.binary}: ${error.message}\n`)
    return exitCodeOfRefusal(error)
  }

  // `/undo` and `/redo` act on this session, when its engine can revert.
  screen?.attach(revertable(session))
  const questions = screen === null ? null : new Questions(screen)
  // A tool call that needs approval asks at the prompt, the way `/undo` asks about hand edits.
  if (questions !== null) session.setApprover?.(approverAt({ ask: (question) => questions.urgent(question) }, session))
  // What the CLI says about MCP servers and wake-ups unasked. Not in `--json`: that stream is the engine's events only.
  let watching: FeatureWatch | null = null
  const features: FeatureIo | null = options.output === "json" ? null : { out: featureOutput(sink), ask: questions === null ? null : (question, print, settle) => questions.patient(question, () => (sink instanceof PrettyRenderer ? sink.separate() : undefined, print()), settle), working: () => watching?.working === true, keep: (note) => watching?.keep(note), secrets: options.output === "pretty" && (interactive || io.stdout.isTTY) }
  const watch = features === null ? null : new FeatureWatch(session, features, { attended: interactive, secrets: options.output === "pretty" && (interactive || io.stdout.isTTY), draw: (item) => sink.event(item) })
  watching = watch
  watch?.start()
  // In `--json` the one thing of it a script has no event for is a line of the CLI's own.
  const notices = sink instanceof JsonSink ? new JsonNotices(session, (notice) => sink.line(notice)) : null
  const terminal = early
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

  const turns = new TurnWatcher(session, sink, watch ?? notices, (item) => {
    // What became of an approval's answer is on the screen: a question that stepped aside for it may come back.
    if (item.type === "approval.answered" || turnOutcomeOf(item) !== null) questions?.confirmed()
    // A turn nobody typed for (a wake-up, a watch, a background command's end) ended under the prompt: the prompt
    // gets its blank line above it again, as after a turn the user started.
    if (turnOutcomeOf(item) !== null && !control.running && screen !== null && sink instanceof PrettyRenderer) sink.beforePrompt()
  })
  const turn = async (entry: Entry): Promise<TurnOutcome | "closed" | "not_sent"> => {
    control.running = true
    // What the project's configuration asks for and the user has not answered yet is asked before the message goes.
    await watch?.beforeMessage()
    const done = turns.next()
    const command = entry.command
    if (command === undefined) await session.send(entry.text)
    else {
      // A command file that cannot be sent after all (the agent it names is gone) starts no turn: said, and nothing waits.
      const refused = await session.sendCommand!(command.name, command.args).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      if (refused !== null) {
        turns.forget()
        control.running = false
        sink.notice(`not sent: ${refused}`, "warn")
        return "not_sent"
      }
    }
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
    // Which session this is, before anything else: a new one, or the one resumed with its title and its turns.
    if (!autoplay && terminal !== null && demo === null) await sayOpened(sink as PrettyRenderer, session, resumed)
    // Its events are drawn from here on: what the open itself changed (the model) comes under the line that names it.
    turns.start()
    if (autoplay) return playDemo(session as FakeSession, (text) => turn({ text }) as Promise<TurnOutcome | "closed">, options.demoSpeed)
    if (terminal === null) {
      // A prompt that is `/name args` for a command file is sent as that command; a `/word` that is no command is
      // not sent at all, as at the interactive prompt; anything else goes as it was typed (`//word`: the text `/word`).
      const first = await commandEntry(sessionFiles(session), prompt!)
      if (first.kind !== "send") {
        // Reached only with an engine that cannot list command files before a session is open.
        for (const line of refusedPrompt(first)) sink.notice(line, "warn")
        return EXIT.usage
      }
      const outcome = await turn(first.entry)
      if (outcome === "closed") return 1
      if (outcome === "not_sent") return EXIT.usage
      // Not a failure of the work: the run was not allowed to go on (`--unattended stop`).
      return turns.stoppedForApproval ? EXIT_APPROVAL_REQUIRED : exitCodeOf(outcome)
    }
    return interactiveLoop({ terminal, renderer: sink as PrettyRenderer, session, turn, control, onCtrlC, leave, first: prompt, features: features! })
  }
  try {
    return await Promise.race([flow(), leaving.promise])
  } finally {
    // From here a Ctrl-C or SIGTERM leaves at once instead of waiting for the engine.
    control.leaving = true
    // A run that left before its session was named still reads its events to their end.
    turns.start()
    // Leaving stops background work: said before it happens, with what becomes of it.
    if (terminal !== null && sink instanceof PrettyRenderer) {
      const running = sink.runningBackground()
      if (running.length > 0)
        sink.notice(`leaving stops ${running.length === 1 ? "the background work still running" : `${running.length} background jobs still running`} (${running.join(", ")}); the agent is told when the session is next opened`, "warn")
    }
    // What was started for the user (a secret fetched, a server's state said) is finished first, briefly.
    if (watch !== null) await within(CLOSE_TIMEOUT_MS, watch.finish())
    if (notices !== null) await within(CLOSE_TIMEOUT_MS, notices.finish())
    watch?.stop()
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
    else if (terminal !== null && demo === null) io.stdout.write(resumeLine(session.id, io.stdout.columns()))
  }
}

/** Hands the run to the full-screen TUI, loaded only here. */
async function tui(io: Io, options: Options, demo: DemoScenario | null, cwd: string): Promise<number> {
  const { runTui } = await import("@windlass/tui")
  return runTui({
    cwd,
    target: options.session !== null ? { kind: "resume", id: options.session } : options.continue ? { kind: "continue" } : { kind: "new" },
    settings: { model: options.model, effort: options.effort, maxSteps: options.maxSteps, agent: options.agent },
    env: io.env,
    version: await version(),
    serverCommand: selfCommand(["acp"]),
    demo: demo === null ? null : { scenario: demo.scenario, name: demo.name, speed: options.demoSpeed, graceMs: options.demoGraceMs },
  })
}

/** The server's switch for firing wake-ups (`WAKE_ENV` in the ACP package, which this process loads only to serve). */
const WAKE_ENV = `${brand.envPrefix}WAKE`

/**
 * The engine for this run, or `null` after saying why there is none. Only a run someone sits in front of
 * (`wakes`) lets its server fire wake-ups: a one-prompt run, a listing or a subcommand would start other
 * sessions' wake-up turns and cut them short when it exits a moment later.
 */
async function engineFor(io: Io, options: Options, demo: DemoScenario | null, wakes = false): Promise<Engine | null> {
  if (io.engine !== undefined && demo === null) return io.engine()
  const env = wakes ? io.env : { ...io.env, [WAKE_ENV]: "off" }
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
    { env, stderr: (text) => io.stderr.write(text), version: await version() },
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

/** What is sent to start a turn: text as typed, or `/name args` of a command file (then `text` is the entry as typed). */
interface Entry {
  readonly text: string
  readonly command?: { readonly name: string; readonly args: string }
}

/**
 * What a prompt given on the command line is, read as the interactive line
 * reads an entry: a message (`//word` is the text `/word`), a command
 * file's text (`send`), a command of the prompt's own (`own`), or a
 * `/word` that is nothing, which is never sent: it would cost a model
 * request and name a session after a typo (`nothing`, with what to say).
 */
type FirstEntry = { readonly kind: "send"; readonly entry: Entry } | { readonly kind: "own"; readonly name: string } | { readonly kind: "nothing"; readonly lines: readonly Line[] }

/** `files`: the command files as they are now (of the session, or of its directory before one is open); `null` when they cannot be had. */
async function commandEntry(files: (() => Promise<CommandsResult>) | null, text: string): Promise<FirstEntry> {
  const found = lookup(text, [BUILTIN_COMMANDS])
  if (found.kind === "message") return { kind: "send", entry: { text: found.text } }
  if (found.kind === "command") return { kind: "own", name: found.command.name }
  const listing = files === null ? null : await files().catch(() => null)
  const again = listing === null ? found : lookup(text, [BUILTIN_COMMANDS, userCommands(listing)])
  if (again.kind === "command") return { kind: "send", entry: { text, command: { name: again.command.name, args: again.rest } } }
  const unusable = listing === null ? null : unusableCommandLines(listing, found.name)
  if (unusable !== null) return { kind: "nothing", lines: unusable }
  return { kind: "nothing", lines: [{ text: unknownCommandText(again.kind === "unknown" ? again : found), tone: "warn" }] }
}

/** What a one-prompt run says about a prompt that is no message and no command file's: one line each, for standard error. */
function refusedPrompt(first: Exclude<FirstEntry, { kind: "send" }>): string[] {
  return first.kind === "own" ? [ownCommandText(first.name)] : first.lines.map((line) => `${" ".repeat(line.indent ?? 0)}${line.text}`)
}

/** What a one-prompt run says about a prompt that is a command of the interactive prompt: there is no prompt to run it at. */
function ownCommandText(name: string): string {
  return `/${name} is a command of the interactive prompt, so nothing was sent; run \`${brand.binary}\` with no prompt (\`${brand.binary} --continue\` for the latest session) and type it there. To send a message that starts with a slash, begin it with two: //${name}`
}

/** The command files of an open session, as `commandEntry` asks for them; `null` for an engine without any. */
function sessionFiles(session: Session): (() => Promise<CommandsResult>) | null {
  const commands = session.commands
  return commands === undefined ? null : () => commands.call(session, clientCommands())
}

interface Interactive {
  readonly terminal: TerminalMode
  readonly renderer: PrettyRenderer
  readonly session: Session
  readonly turn: (entry: Entry) => Promise<TurnOutcome | "closed" | "not_sent">
  readonly control: { running: boolean }
  readonly onCtrlC: () => void
  readonly leave: (code: number) => void
  readonly first: string | null
  readonly features: FeatureIo
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
  let waiting: ((entry: Entry | null) => void) | null = null

  const steer = (message: string, queued: boolean, command?: Entry["command"]) => {
    const delivery = queued ? "queue" : "steer"
    const sent = command === undefined ? session.send(message, { delivery }) : session.sendCommand!(command.name, command.args, { delivery })
    sent.then(
      (id) => {
        if (id === null) renderer.notice("not sent: the session is not taking input right now", "warn")
      },
      (error: unknown) => renderer.notice(`not sent: ${error instanceof Error ? error.message : String(error)}`, command === undefined ? "error" : "warn"),
    )
  }
  /** The command files as they are now, or `null` when the engine has none or cannot say. */
  const commandFiles = async () => (session.commands === undefined ? null : await session.commands(clientCommands()).catch(() => null))
  /**
   * `/name` that is no command of the CLI's own: a command file's, sent through the engine (which records the file);
   * a file that cannot be used, said with why; or nothing, said with the nearest name of both.
   */
  const fileCommand = async (text: string, unknown: Extract<ReturnType<typeof lookup>, { kind: "unknown" }>) => {
    const listing = await commandFiles()
    const found = listing === null ? unknown : lookup(text, [BUILTIN_COMMANDS, userCommands(listing)])
    if (found.kind === "command") {
      const command = { name: found.command.name, args: found.rest }
      if (control.running) return steer(text.trim(), false, command)
      return waiting?.({ text: text.trim(), command })
    }
    const unusable = listing === null ? null : unusableCommandLines(listing, unknown.name)
    if (unusable !== null) return renderer.printLines(unusable)
    if (found.kind === "unknown") renderer.notice(unknownCommandText(found), "warn")
  }
  /** An entry submitted at the prompt: a message, a command of the CLI's own, a command file's, or nothing. */
  const submit = (entered: string): void => {
    {
      {
        // A `/word` is a command or nothing: an unknown one is never sent (it would cost a request and title the session).
        const found = lookup(entered, [BUILTIN_COMMANDS])
        if (found.kind === "unknown") return void fileCommand(entered, found)
        if (found.kind === "message") {
          if (control.running) return found.text.trim() === "" ? undefined : steer(found.text, false)
          return waiting?.({ text: found.text })
        }
        const name = found.command.name
        switch (name) {
          case "exit":
            if (control.running) return context.leave(0)
            return waiting?.(null)
          case "help":
            // The CLI's own commands, then the command files with where each comes from, and the ones that cannot be used.
            return void commandFiles().then((listing) => renderer.printLines([...helpLines(listing === null ? [BUILTIN_COMMANDS] : [BUILTIN_COMMANDS, userCommands(listing)]), ...(listing === null ? [] : commandProblemLines(listing))]))
          case "clear-taint":
            return void clearTaint(session, renderer, screen)
          case "approval":
            return void approvalMode(session, renderer, found.rest)
          case "diff":
            return void showDiff(session, renderer)
          case "agent":
            return void agentCommand(session, renderer, found.rest)
          case "rename":
            return void renameSession(session, renderer, found.rest)
          case "compact":
            if (found.rest !== "") return renderer.notice("/compact takes nothing after it", "warn")
            return void compactNow(session, renderer)
          case "mcp":
          case "hooks":
          case "lsp":
          case "skills":
          case "wakeups":
          case "watch":
          case "memory":
          case "remember":
          case "forget":
            return void runFeatureCommand(name as FeatureCommand, found.rest, session, context.features)
          case "stop":
            return void stopCall(session, renderer, found.rest, control.running)
          case "queue":
            if (found.rest === "") return renderer.notice("/queue needs a message, e.g. /queue then update the changelog", "warn")
            // With nothing running there is nothing to queue behind: a queued message is a prompt.
            return control.running ? steer(found.rest, true) : waiting?.({ text: found.rest })
          case "undo":
          case "redo":
            // The editor runs `/undo` and `/redo` themselves; one with words after it reaches here.
            return renderer.notice(`/${name} takes nothing after it`, "warn")
          default:
            return renderer.notice(`/${name} cannot be run here`, "warn")
        }
      }
    }
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
      case "submit":
        return submit(action.text)
    }
  })

  // The prompt given on the command line: what is sent starts the first turn; a command of the prompt's own, or a
  // `/word` that is none, is handled as if it had been typed here.
  const first = context.first === null ? null : await commandEntry(sessionFiles(session), context.first)
  let pending: Entry | null = first?.kind === "send" ? first.entry : null
  let typed: string | null = first === null || first.kind === "send" ? null : context.first
  for (;;) {
    let entry = pending
    pending = null
    if (entry === null) {
      renderer.beforePrompt()
      screen.show("› ")
      entry = await new Promise<Entry | null>((done) => {
        waiting = done
        if (typed !== null) {
          const entered = typed
          typed = null
          submit(entered)
        }
      })
      waiting = null
      if (entry === null) break
      if (entry.text.trim() === "") continue
      renderer.prompt(entry.text)
    }
    screen.show("› ", STEER_HINT)
    // The events ended under a running turn: the engine went away. Leaving is the only thing left to do.
    if ((await context.turn(entry)) === "closed") return 1
  }
  return 0
}

/** How to come back to a session, said on leaving: one line when it fits, else the command on a line of its own, so the ID is never split. */
export function resumeLine(id: string, columns: number): string {
  const command = `${brand.binary} --session ${id}`
  const one = `${brand.binary}: session ${id} · resume with: ${command}`
  return one.length < columns ? `${one}\n` : `${brand.binary}: session ${id}\n  resume with: ${command}\n`
}

/** The line the interactive mode starts with: which session, the model it runs on, and for a resumed one its title and its turns. */
async function sayOpened(renderer: PrettyRenderer, session: Session, resumed: boolean): Promise<void> {
  const described = await session.describe?.().catch(() => null)
  // The events the stream will bring are the ones after these: the renderer counts turns from the first.
  if (described != null) renderer.primeTurns(described.events)
  const hint = " · /help lists the commands"
  // Which model it runs on, and which agent it runs as, are part of which session this is.
  const model = described?.model === undefined ? "" : ` · model ${described.model}${described.effort == null ? "" : ` · effort ${described.effort}`}`
  const agent = described?.agent == null ? "" : ` · agent ${described.agent}`
  if (!resumed || described == null) return renderer.notice(`${resumed ? "resumed" : "new"} session ${session.id}${model}${agent}${hint}`)
  const title = described.title === null ? "" : ` "${truncate(flatten(described.title), 50)}"`
  const turns = `${described.turns === 1 ? "1 turn" : `${described.turns} turns`}${described.undone > 0 ? ` (${described.undone} undone)` : ""}`
  renderer.notice(`resumed session ${session.id}${title} · ${turns}${model}${agent}${hint}`)
  // Where the conversation stands, so the user knows what they are coming back to.
  renderer.printLines(recapLines(described.events))
  // The model's task list as it stands: what it was in the middle of.
  const tasks = described.tasks ?? null
  if (tasks !== null && tasks.length > 0) renderer.printLines([{ text: `Its task list (${tasksProgress(tasks)}):`, tone: "dim" }, ...taskLines(tasks, 2)])
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

/** `/agent [name|none]`: lists the agents and says which one is in force, or switches; the switch itself is shown from its event. */
async function agentCommand(session: Session, renderer: PrettyRenderer, name: string): Promise<void> {
  if (session.agents === undefined || session.setAgent === undefined) return renderer.notice("/agent is not available with this engine", "warn")
  try {
    if (name === "") return renderer.printLines(agentLines(await session.agents()))
    if (/\s/.test(name)) return renderer.notice("/agent takes one name, e.g. /agent reviewer (or /agent none)", "warn")
    const before = (await session.agents()).current
    await session.setAgent(name)
    const now = (await session.agents()).current
    // Nothing is recorded for a switch that changes nothing, so it is said here.
    if (before === now) renderer.notice(now === null ? "this session runs as no agent already" : `this session runs as the ${now} agent already`)
  } catch (error) {
    renderer.notice(`/agent: ${error instanceof Error ? error.message : String(error)}`, "warn")
  }
}

/** `/rename <title>`. */
async function renameSession(session: Session, renderer: PrettyRenderer, title: string): Promise<void> {
  if (session.rename === undefined) return renderer.notice("/rename is not available with this engine", "warn")
  if (title.trim() === "") return renderer.notice("/rename needs a title, e.g. /rename fix the login test", "warn")
  try {
    renderer.notice(`renamed: ${await session.rename(title)}`)
  } catch (error) {
    renderer.notice(`/rename failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/** `/compact`: asks for a compaction now and says what came of it: the sizes (from its events), or why nothing was compacted, or why it failed. */
async function compactNow(session: Session, renderer: PrettyRenderer): Promise<void> {
  if (session.compact === undefined) return renderer.notice("/compact is not available with this engine", "warn")
  try {
    // A compaction that was made is drawn from its events, with the sizes; what is said here is why there was none.
    const said = compactText(await session.compact())
    if (said !== null) renderer.notice(said.text, said.tone)
  } catch (error) {
    renderer.notice(`/compact failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/**
 * `/stop [<number>]`: stops one running tool call and nothing else, so the
 * turn goes on. With one call running it is that one; with several they
 * are listed, each with the number it has in this turn, and `/stop
 * <number>` stops one. What came of it is the call's own line (`■ ...
 * stopped by you`, with what it had printed); a request the engine did not
 * take is said with why.
 */
async function stopCall(session: Session, renderer: PrettyRenderer, rest: string, working: boolean): Promise<void> {
  if (session.cancelCall === undefined) return renderer.notice("/stop is not available with this engine", "warn")
  const running = renderer.runningCalls()
  const word = rest.trim()
  const listed = (): Line[] => [
    { text: `Running tool calls (${running.length}): /stop <number> stops one and the turn goes on; Ctrl-C stops the whole turn`, tone: "dim" },
    ...running.map((call): Line => ({ text: `${call.number}  ${call.name}${call.arg === "" ? "" : ` ${call.arg}`}${call.startedAt === null ? "" : ` · ${formatDuration(Math.max(0, Date.now() - call.startedAt))}`}${call.stopAsked ? " · stopping" : ""}`, tone: "plain", indent: 2 })),
  ]
  if (running.length === 0) return renderer.notice(working ? "no tool call is running right now, so there is nothing for /stop to stop; Ctrl-C stops the whole turn" : "nothing is running, so there is nothing to stop")
  let chosen = running[0]!
  if (word === "") {
    if (running.length > 1) return renderer.printLines(listed())
  } else {
    const found = /^\d+$/.test(word) ? running.find((call) => call.number === Number(word)) : undefined
    if (found === undefined) {
      renderer.notice(/^\d+$/.test(word) ? `call ${word} is not running (it has its result, or there is none with that number)` : "/stop takes the number of a running tool call, or nothing when one is running", "warn")
      return renderer.printLines(listed())
    }
    chosen = found
  }
  try {
    const result = await session.cancelCall({ messageId: chosen.messageId as MessageId, callId: chosen.callId as CallId })
    if (!result.stopped) renderer.notice(`not stopped: ${result.message ?? "the engine did not take the request"}`, "warn")
  } catch (error) {
    renderer.notice(`/stop failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/** How long a question waits for what became of the answer before it to be said, before it is put anyway. */
export const CONFIRMATION_WAIT_MS = 1500

/**
 * The questions put at the prompt, one at a time. A tool call's approval is
 * urgent: the turn waits for it, so it is put at once, and a patient question
 * that was showing (a project's MCP server, hook or language server) steps
 * aside and is put again, printed afresh, once no urgent one is left. Patient
 * questions wait for each other: the next is put when the one showing has
 * its answer and what the answer asked for is done and said, never in its
 * place and never above its confirmation. The same holds between the two
 * kinds: an urgent question waits (briefly) for what a patient answer asked
 * for to be said, and a patient question is put again only once the engine's
 * word on the urgent answer (`✓ allowed once`) has been drawn (`confirmed`).
 */
export class Questions {
  private urgentCount = 0
  private patientUp = false
  private displaced = false
  private idle: Promise<void> = Promise.resolve()
  private release: (() => void) | null = null
  /** The patient question showing or waiting last: the next one is put after it. */
  private patientLine: Promise<unknown> = Promise.resolve()
  /** What a patient answer asked for, while it is being done and said. */
  private settling: Promise<unknown> | null = null
  /** Urgent answers the engine has not confirmed on the screen yet: each ends its question's hold on the prompt. */
  private readonly unconfirmed = new Set<() => void>()

  constructor(private readonly screen: Pick<Screen, "ask">) {}

  async urgent(question: string): Promise<string | null> {
    if (this.patientUp) this.displaced = true
    if (this.urgentCount++ === 0) this.idle = new Promise((resolve) => (this.release = resolve))
    let held = true
    const done = () => {
      if (!held) return
      held = false
      this.unconfirmed.delete(done)
      if (--this.urgentCount === 0) this.release?.()
    }
    let answer: string | null = null
    try {
      if (this.settling !== null) await within(CONFIRMATION_WAIT_MS, this.settling)
      answer = await this.screen.ask(question)
      return answer
    } finally {
      // Backed out of: nothing will be said about it. Answered: until its confirmation is drawn, and never for long.
      if (answer === null) done()
      else {
        this.unconfirmed.add(done)
        const timer = setTimeout(done, CONFIRMATION_WAIT_MS) as { unref?: () => void }
        timer.unref?.()
      }
    }
  }

  /** The engine's word on the urgent answers given so far was drawn (`approval.answered`), or their turn ended. */
  confirmed(): void {
    for (const done of [...this.unconfirmed]) done()
  }

  /**
   * `settle` does what the answer asks for and says what came of it. The next patient question is put only when it
   * is done, so what became of an answer is said under its own question, never under the next one.
   */
  patient<T>(question: string, print: () => void, settle: (answer: string | null) => T | Promise<T>): Promise<T> {
    const settled = this.patientLine.then(async () => {
      const answer = await this.putPatient(question, print)
      const work = Promise.resolve().then(() => settle(answer))
      this.settling = work.catch(() => {})
      try {
        return await work
      } finally {
        this.settling = null
      }
    })
    this.patientLine = settled.catch(() => {})
    return settled
  }

  private async putPatient(question: string, print: () => void): Promise<string | null> {
    for (;;) {
      await this.idle
      print()
      this.patientUp = true
      this.displaced = false
      const answer = await this.screen.ask(question)
      this.patientUp = false
      if (answer === null && this.displaced) continue
      return answer
    }
  }
}

/** Where the feature commands print: the renderer's own lines, or plain notices for a sink without them. */
function featureOutput(sink: Sink): FeatureIo["out"] {
  if (sink instanceof PrettyRenderer) return { lines: (lines) => sink.printLines(lines), notice: (text, tone) => sink.notice(text, tone) }
  return { lines: (lines) => lines.forEach((line) => sink.notice(`${" ".repeat(line.indent ?? 0)}${line.text}`)), notice: (text, tone) => sink.notice(text, tone) }
}

/** The terminal while the interactive input is open: raw mode, bracketed paste, and the footer. */
class TerminalMode {
  private stop: (() => void) | null = null
  private restored = false
  private handler: ((data: string) => void) | null = null
  private readonly early: string[] = []

  constructor(
    private readonly io: Io,
    readonly screen: Screen,
  ) {}

  /** Starts reading keys (raw mode) before the prompt is shown: what is typed meanwhile waits for `start`. */
  capture(): void {
    if (this.stop !== null || this.restored || this.io.stdin.listen === undefined) return
    this.stop = this.io.stdin.listen((data) => (this.handler === null ? void this.early.push(data) : this.handler(data)))
  }

  start(handle: (action: EditorAction) => void): void {
    if (this.io.stdin.listen === undefined) throw new Error("interactive mode needs keyboard input")
    this.capture()
    this.handler = (data) => this.screen.input(data, handle)
    this.io.stdout.write("\x1b[?2004h")
    // Typed before the prompt was there: given to it once it waits. A line ended before raw mode began (the
    // terminal's own line editing, which also echoed it) ends with a newline, and is sent as a message.
    const early = this.early.splice(0)
    if (early.length > 0) setTimeout(() => early.forEach((chunk) => this.handler?.(chunk.replace(/\n$/, "\r"))), 0)
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

/** Feeds the session's events to the sink, once started, and resolves turn waiters when an execution ends. */
class TurnWatcher {
  private readonly finished = new Deferred<void>()
  /** Settles when the events have ended; never before `start`. */
  readonly ended: Promise<void> = this.finished.promise
  private begun = false
  private waiter: ((outcome: TurnOutcome | "closed") => void) | null = null
  private done = false
  /** Whether the latest turn was ended because a call needed approval that nobody could give. */
  stoppedForApproval = false

  constructor(
    private readonly session: Session,
    private readonly sink: Sink,
    private readonly watch: (Pick<FeatureWatch, "event"> & Partial<Pick<FeatureWatch, "takes">>) | null = null,
    /** Called with each event once the sink has drawn it. */
    private readonly drawn: ((item: EngineEvent) => void) | null = null,
  ) {}

  /** Begins reading the events (they wait until then). Idempotent. */
  start(): void {
    if (this.begun) return
    this.begun = true
    const reading = (async () => {
      for await (const item of this.session.events) this.observe(item, this.sink)
      this.done = true
      this.resolve("closed")
    })()
    reading.then(this.finished.resolve, this.finished.reject)
  }

  next(): Promise<TurnOutcome | "closed"> {
    if (this.done) return Promise.resolve("closed")
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  /** Nothing was sent after all: no turn is waited for. */
  forget(): void {
    this.waiter = null
  }

  private observe(item: EngineEvent, sink: Sink): void {
    // What the watch answers for itself (one sentence for everything of the project's that nobody approved) is not drawn here.
    if (this.watch?.takes?.(item) !== true) sink.event(item)
    this.drawn?.(item)
    this.watch?.event(item)
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
  // `--session` names sessions by the start of their ID: with the listing it narrows it to those.
  const typed = options.session
  if (typed !== null && what === "models") io.stderr.write(`${brand.binary}: --session does not apply to --models; it is ignored\n`)
  const prefix = typed === null || what === "models" ? null : typed.startsWith("ses_") || !/^[0-9a-f]+$/i.test(typed) ? typed : `ses_${typed.toLowerCase()}`
  if (prefix !== null) {
    table = table.filter(({ row }) => "id" in row && row.id.startsWith(prefix))
    if (table.length === 0 && options.output !== "json") {
      io.stdout.write(`no session in ${cwd} starts with ${prefix}\n`)
      return 0
    }
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
        // A one-shot run leaves when its turn ends; a scripted demo plays on, as the interactive mode stays.
        afterTurn: screen === null && !echoPrompts ? "exits" : "stays",
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
  reject!: (reason: unknown) => void
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
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
