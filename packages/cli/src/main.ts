#!/usr/bin/env bun
/**
 * The command-line entry point: parse arguments, open a session through the
 * engine interface, send prompts, render events, and map the result to an
 * exit code. `run` takes its process dependencies as `Io` so tests can drive
 * it in-process; `main` binds them to the real process.
 */
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { brand } from "./brand.ts"
import { helpText, type Options, parseArgs } from "./args.ts"
import { findScenario, listScenarios } from "./demo/scenarios.ts"
import { type Engine, EngineUnavailable, type EngineEvent, type Session, type TurnOutcome, exitCodeOf, turnOutcomeOf } from "./engine.ts"
import { FakeEngine, type FakeSession } from "./fake-engine.ts"
import { JsonSink, PrettyRenderer, QuietSink, type Sink } from "./renderer.ts"
import { colorEnabled } from "./text.ts"

export interface Io {
  readonly argv: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly stdout: { write(text: string): void; readonly isTTY: boolean; columns(): number }
  readonly stderr: { write(text: string): void }
  readonly stdin: { readonly isTTY: boolean; readAll(): Promise<string> }
  /** Subscribes to Ctrl-C (SIGINT). Returns the unsubscribe function. */
  onInterrupt(handler: () => void): () => void
  /** Leaves at once, for the second Ctrl-C. */
  exit(code: number): never
  /** The real engine; `undefined` in this build. */
  readonly engine?: () => Engine
}

/** How long after a first Ctrl-C a second one exits instead of waiting for the stop. */
export const DOUBLE_INTERRUPT_MS = 2000

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

  const prompt = options.prompt ?? (io.stdin.isTTY || demo !== null ? null : (await io.stdin.readAll()).trim())
  if (prompt === "") return usage(io, "the prompt on stdin is empty")
  const autoplay = demo !== null && prompt === null && !options.interactive
  const interactive = !autoplay && (prompt === null || options.interactive)
  if (interactive && options.output !== "pretty") return usage(io, `--${options.output} needs a prompt (as arguments or on stdin)`)
  if (interactive && !io.stdin.isTTY) return usage(io, "interactive mode needs a terminal on stdin")

  const sink = makeSink(io, options, autoplay)
  const engine = demo === null ? io.engine?.() : new FakeEngine(demo.scenario, { speed: options.demoSpeed, ...(options.demoGraceMs === null ? {} : { graceMs: options.demoGraceMs }) })
  if (engine === undefined) {
    io.stderr.write(`${brand.binary}: the engine is not part of this build yet. Try \`${brand.binary} --demo list\`.\n`)
    return 1
  }

  let session: Session
  try {
    session = await engine.open({
      session: options.session !== null ? { kind: "resume", id: options.session } : options.continue ? { kind: "continue" } : { kind: "new" },
      cwd,
      model: options.model,
      effort: options.effort,
    })
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error
    io.stderr.write(`${brand.binary}: ${error.message}\n`)
    return 1
  }

  const turns = new TurnWatcher(session, sink)
  const control = { running: false, lastInterrupt: 0 }
  const onCtrlC = () => {
    if (!control.running) return io.exit(130)
    const now = Date.now()
    if (now - control.lastInterrupt < DOUBLE_INTERRUPT_MS) {
      sink.notice("exiting without waiting for the stop", "warn")
      return io.exit(130)
    }
    control.lastInterrupt = now
    session.interrupt()
    sink.notice("■ stopping… press Ctrl-C again to exit now", "warn")
  }
  const turn = async (text: string): Promise<TurnOutcome | "closed"> => {
    control.running = true
    const done = turns.next()
    await session.send(text)
    const outcome = await done
    control.running = false
    return outcome
  }

  const unsubscribe = io.onInterrupt(onCtrlC)
  try {
    if (autoplay) return await playDemo(session as FakeSession, turn, options.demoSpeed)
    if (!interactive) {
      const outcome = await turn(prompt!)
      return outcome === "closed" ? 1 : exitCodeOf(outcome)
    }
    return await interactiveLoop(sink as PrettyRenderer, turn, control, onCtrlC, prompt)
  } finally {
    unsubscribe()
    await session.close()
    await turns.ended
  }
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

async function interactiveLoop(
  renderer: PrettyRenderer,
  turn: (text: string) => Promise<TurnOutcome | "closed">,
  control: { running: boolean },
  onCtrlC: () => void,
  first: string | null,
): Promise<number> {
  const stdin = process.stdin
  const rl = createInterface({ input: stdin, output: process.stdout, terminal: true, historySize: 1000, prompt: "› " })
  const lines: string[] = []
  let pasteTimer: ReturnType<typeof setTimeout> | null = null
  let submit: ((text: string | null) => void) | null = null

  const reset = () => {
    lines.length = 0
    rl.setPrompt("› ")
  }
  rl.on("line", (line) => {
    lines.push(line)
    // Lines that arrive together are one paste; a line ending in a backslash continues on the next.
    if (pasteTimer !== null) clearTimeout(pasteTimer)
    pasteTimer = setTimeout(() => {
      pasteTimer = null
      const lastLine = lines[lines.length - 1] ?? ""
      if (lastLine.endsWith("\\")) {
        lines[lines.length - 1] = lastLine.slice(0, -1)
        rl.setPrompt("… ")
        rl.prompt()
        return
      }
      const text = lines.join("\n")
      reset()
      submit?.(text)
    }, 12)
  })
  rl.on("SIGINT", () => {
    if (control.running) return onCtrlC()
    // At the prompt Ctrl-C clears what was typed, as in a shell.
    const continued = lines.length > 0
    reset()
    rl.write(null, { ctrl: true, name: "e" })
    rl.write(null, { ctrl: true, name: "u" })
    if (continued) {
      process.stdout.write("\n")
      rl.prompt()
    }
  })
  rl.on("close", () => submit?.(null))

  const read = () =>
    new Promise<string | null>((done) => {
      submit = (text) => {
        submit = null
        done(text)
      }
      renderer.beforePrompt()
      rl.prompt()
    })

  try {
    let pending = first
    for (;;) {
      const text = pending ?? (await read())
      pending = null
      if (text === null) break
      if (text.trim() === "") continue
      if (text.trim() === "/exit" || text.trim() === "/quit") break
      // While the agent works the terminal is in its normal mode, so Ctrl-C arrives as SIGINT.
      rl.pause()
      if (stdin.isTTY) stdin.setRawMode(false)
      await turn(text)
      if (stdin.isTTY) stdin.setRawMode(true)
      rl.resume()
    }
    return 0
  } finally {
    rl.close()
    process.stdout.write("\n")
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

function makeSink(io: Io, options: Options, echoPrompts: boolean): Sink {
  const write = (text: string) => io.stdout.write(text)
  const writeError = (text: string) => io.stderr.write(text)
  switch (options.output) {
    case "json":
      return new JsonSink(write, writeError)
    case "quiet":
      return new QuietSink(write, writeError)
    case "pretty":
      return new PrettyRenderer({
        write,
        color: colorEnabled(io.stdout.isTTY, io.env),
        columns: () => io.stdout.columns(),
        live: io.stdout.isTTY,
        showReasoning: options.showReasoning,
        echoPrompts,
      })
  }
}

function usage(io: Io, message: string): number {
  io.stderr.write(`${brand.binary}: ${message}\nRun \`${brand.binary} --help\` for usage.\n`)
  return 2
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

/** Binds `run` to the real process. */
export async function main(): Promise<number> {
  return run({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: {
      write: (text) => void process.stdout.write(text),
      isTTY: process.stdout.isTTY === true,
      columns: () => process.stdout.columns || Number(process.env.COLUMNS) || 80,
    },
    stderr: { write: (text) => void process.stderr.write(text) },
    stdin: { isTTY: process.stdin.isTTY === true, readAll: () => Bun.stdin.text() },
    onInterrupt: (handler) => {
      process.on("SIGINT", handler)
      return () => void process.off("SIGINT", handler)
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
