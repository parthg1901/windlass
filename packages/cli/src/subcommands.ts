/**
 * `fork` and `replay`: one-off subcommands that act on a stored session and
 * exit. Both go through the engine like everything else (`<prefix>/fork`
 * and `<prefix>/replay` on the ACP path) and name the session the way
 * `--session` does: an ID, a unique start of one, or nothing for the latest
 * session in the working directory.
 *
 * Parsing is pure and returns a value or a usage error; `runFork` and
 * `runReplay` print and return the exit code.
 */
import { parseArgs as parseFlags } from "node:util"
import type { ForkResult, ReplayParams, ReplayResult } from "@windlass/acp/extensions"
import { brand } from "@windlass/core"
import { type Engine, type EngineEvent, EngineUnavailable, exitCodeOfRefusal } from "./engine.ts"
import { ENGINE_KINDS, type EngineKind } from "./select-engine.ts"
import { COPY_NOTE } from "./features.ts"
import { flatten, nearest, plural, truncate } from "./text.ts"
import { callArgument } from "./tools.ts"

export interface ForkOptions {
  readonly session: string | null
  readonly throughSeq: number | null
  /** `--turn <n>`: fork after the session's turn `n`, counted from 1 as the user sees turns. */
  readonly turn: number | null
  readonly copy: { readonly copyTo: string | null } | null
  readonly model: string | null
  readonly effort: string | null
  readonly title: string | null
  readonly cwd: string | null
  readonly json: boolean
  readonly engine: EngineKind
}

export interface ReplayOptions {
  readonly session: string | null
  /** File paths, read when the command runs. */
  readonly systemPrompt: string | null
  readonly toolDescriptions: readonly { readonly tool: string; readonly file: string }[]
  readonly model: string | null
  readonly effort: string | null
  readonly policy: "stop" | "execute-read-only" | "execute"
  readonly strict: boolean
  readonly throughSeq: number | null
  readonly workspace: string | null
  readonly cwd: string | null
  readonly json: boolean
  readonly quiet: boolean
  readonly engine: EngineKind
}

export type SubcommandParsed =
  | { readonly kind: "fork"; readonly options: ForkOptions }
  | { readonly kind: "replay"; readonly options: ReplayOptions }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string }

const POLICIES = ["stop", "execute-read-only", "execute"] as const

export function forkUsage(): string {
  const b = brand.binary
  return `Usage: ${b} fork [<session>] [options]

Starts a new session with the conversation of <session> so far (an ID, or the start
of one; the most recent session in this directory when left out). The original is
not changed; the fork is a session of its own that you continue with --session.

Options:
  --turn <n>         fork after turn <n> of the session instead of after its latest
                     step: 1 is its first prompt, as the TUI numbers turns on their
                     ending rows (one that /undo took back cannot be forked at)
  --through <n>      the precise form: fork after event <n> of the session (a step
                     boundary)
  --copy             the fork works in a copy of the workspace instead of the same
                     directory (made under the harness's work directory)
  --copy-to <dir>    the same, in <dir> (an absolute path that does not exist yet)
  -m, --model <name> the fork's model (default: the session's)
  --effort <level>   the fork's reasoning effort (default: the session's; default
                     for the model's own)
  --title <text>     the fork's title (default: the session's)
  --cwd <dir>        the directory whose latest session is forked
  --json             print the new session as JSON
`
}

export function replayUsage(): string {
  const b = brand.binary
  return `Usage: ${b} replay [<session>] [options]

Runs the model again on a recorded session (an ID, or the start of one; the most
recent session in this directory when left out) and answers every tool call it
makes as recorded from the recording, so nothing runs while the model does what it
did. The first call it makes differently is where the behaviour changed. Calls the
model for real: it costs about as many requests as the session had steps.

Options:
  --system-prompt <file>              replace the base system prompt
  --tool-description <tool>=<file>    replace one tool's description (repeatable)
  -m, --model <name>                  replay with another model
  --effort <level>                    replay with another effort (default: the model's)
  --policy stop|execute-read-only|execute
                                      at the first call that is not on the recording:
                                      stop there (default, nothing runs), run read-only
                                      tools in a copy of the workspace, or finish the
                                      turn in a copy with real tools
  --strict                            compare arguments exactly and keep step boundaries
  --through <n>                       replay the recording only up to event <n>
  --workspace <dir>                   where the copy is made (the policies that run tools)
  --cwd <dir>                         the directory whose latest session is replayed
  --json                              print the outcome and the report as JSON
  -q, --quiet                         print only the report, no progress

With nothing changed it shows how much the model varies by itself: run it a few times
before reading anything into a change. Exit code 0 when the replay ran (identical or
diverged), 1 when it could not be compared, 2 for a usage error.
`
}

const COMMON = {
  model: { type: "string", short: "m" },
  effort: { type: "string" },
  through: { type: "string" },
  cwd: { type: "string" },
  json: { type: "boolean" },
  engine: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const

export function parseSubcommand(argv: readonly string[]): SubcommandParsed {
  const command = argv[0]
  if (command !== "fork" && command !== "replay") return { kind: "error", message: `unknown subcommand ${String(command)}` }
  const parsed = (() => {
    try {
      return parseFlags({
        args: [...argv.slice(1)],
        allowPositionals: true,
        strict: true,
        options:
          command === "fork"
            ? { ...COMMON, copy: { type: "boolean" }, "copy-to": { type: "string" }, title: { type: "string" }, turn: { type: "string" } }
            : { ...COMMON, "system-prompt": { type: "string" }, "tool-description": { type: "string", multiple: true }, policy: { type: "string" }, strict: { type: "boolean" }, workspace: { type: "string" }, quiet: { type: "boolean", short: "q" } },
      })
    } catch (error) {
      return (error instanceof Error ? error.message : String(error)).replace(/\. To specify a positional argument.*$/s, "")
    }
  })()
  if (typeof parsed === "string") {
    // A mistyped option is named with the one that was probably meant.
    const unknown = /^Unknown option '(--[^']+)'$/.exec(parsed)?.[1]
    const known = Object.keys(command === "fork" ? { ...COMMON, copy: 0, "copy-to": 0, title: 0, turn: 0 } : { ...COMMON, "system-prompt": 0, "tool-description": 0, policy: 0, strict: 0, workspace: 0, quiet: 0 }).map((name) => `--${name}`)
    const close = unknown === undefined ? null : nearest(unknown, known)
    return { kind: "error", message: unknown === undefined ? `${command}: ${parsed}` : `${command}: unknown option ${unknown}${close === null ? "" : `; did you mean ${close}?`}` }
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>
  if (values.help === true) return { kind: "help", text: command === "fork" ? forkUsage() : replayUsage() }
  if (parsed.positionals.length > 1) return { kind: "error", message: `${command} takes one session, not ${parsed.positionals.length} (${parsed.positionals.join(" ")})` }
  const text = (key: string) => {
    const value = values[key]
    return typeof value === "string" && value !== "" ? value : null
  }
  const through = text("through")
  if (through !== null && !/^[1-9]\d*$/.test(through)) return { kind: "error", message: `${command}: --through takes an event number, such as 12` }
  const engine = text("engine") ?? "acp"
  if (!(ENGINE_KINDS as readonly string[]).includes(engine)) return { kind: "error", message: `--engine must be one of: ${ENGINE_KINDS.join(", ")}` }
  const shared = { session: parsed.positionals[0] ?? null, model: text("model"), effort: text("effort"), throughSeq: through === null ? null : Number(through), cwd: text("cwd"), json: values.json === true, engine: engine as EngineKind }
  if (command === "fork") {
    const copyTo = text("copy-to")
    if (copyTo !== null && !copyTo.startsWith("/")) return { kind: "error", message: "fork: --copy-to takes an absolute path" }
    const turn = text("turn")
    if (turn !== null && !/^[1-9]\d*$/.test(turn)) return { kind: "error", message: "fork: --turn takes a turn number, such as 3" }
    if (turn !== null && through !== null) return { kind: "error", message: "fork: --turn and --through cannot be combined; --turn names a turn, --through an event" }
    return { kind: "fork", options: { ...shared, turn: turn === null ? null : Number(turn), copy: values.copy === true || copyTo !== null ? { copyTo } : null, title: text("title") } }
  }
  const policy = text("policy") ?? "stop"
  if (!(POLICIES as readonly string[]).includes(policy)) return { kind: "error", message: `replay: --policy is one of ${POLICIES.join(", ")}` }
  const descriptions: { tool: string; file: string }[] = []
  for (const entry of (values["tool-description"] as string[] | undefined) ?? []) {
    const at = entry.indexOf("=")
    if (at <= 0 || at === entry.length - 1) return { kind: "error", message: `replay: --tool-description takes <tool>=<file>, not ${entry}` }
    descriptions.push({ tool: entry.slice(0, at), file: entry.slice(at + 1) })
  }
  if (values.json === true && values.quiet === true) return { kind: "error", message: "replay: --json and --quiet cannot be combined" }
  return {
    kind: "replay",
    options: {
      ...shared,
      systemPrompt: text("system-prompt"),
      toolDescriptions: descriptions,
      policy: policy as ReplayOptions["policy"],
      strict: values.strict === true,
      workspace: text("workspace"),
      quiet: values.quiet === true,
    },
  }
}

export interface SubcommandIo {
  readonly cwd: string
  readonly stdout: { write(text: string): void }
  readonly stderr: { write(text: string): void }
  readonly onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => () => void
}

/** `fork`: forks and says how to continue in the fork. */
export async function runFork(io: SubcommandIo, engine: Engine, options: ForkOptions, cwd: string): Promise<number> {
  if (engine.fork === undefined) return fail(io, "fork is not available with this engine")
  let forked: ForkResult
  try {
    forked = await engine.fork({ cwd, session: options.session, throughSeq: options.throughSeq, turn: options.turn, copy: options.copy, model: options.model, effort: options.effort, title: options.title })
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error
    return fail(io, error.message, exitCodeOfRefusal(error))
  }
  if (options.json) {
    io.stdout.write(`${JSON.stringify(forked)}\n`)
    return 0
  }
  const b = brand.binary
  const title = forked.title === null ? "" : ` "${truncate(flatten(forked.title), 60)}"`
  const where =
    forked.copiedFrom === null
      ? `It works in the same directory as the original, ${forked.cwd}: both sessions change the same files.`
      : `It works in a copy of ${forked.copiedFrom}: ${forked.cwd}\n${COPY_NOTE}`
  io.stdout.write(
    [
      `Forked ${forked.parentSessionId} ${options.turn !== null ? `after turn ${options.turn} (event ${forked.throughSeq})` : options.throughSeq === null ? "after its latest step" : `after event ${forked.throughSeq}`}.`,
      `New session: ${forked.sessionId}${title} (${forked.model}${forked.effort === null ? "" : `, effort ${forked.effort}`}), with the conversation so far; the original is unchanged.`,
      where,
      "",
      "Continue in the fork:",
      `  ${b} --session ${forked.sessionId} "<your next message>"`,
      `  ${b} tui --session ${forked.sessionId}`,
      "",
    ].join("\n"),
  )
  return 0
}

/** `replay`: replays, shows the progress on stderr, prints the report. */
export async function runReplay(io: SubcommandIo, engine: Engine, options: ReplayOptions, cwd: string): Promise<number> {
  if (engine.replay === undefined) return fail(io, "replay is not available with this engine")
  const params = await replayParams(options)
  if (typeof params === "string") {
    io.stderr.write(`${brand.binary}: ${params}\nRun \`${brand.binary} replay --help\` for usage.\n`)
    return 2
  }
  const progress = options.json || options.quiet ? null : new ReplayProgressLines((text) => io.stderr.write(text))
  let cancel: (() => void) | null = null
  let interrupts = 0
  const off = io.onSignal("SIGINT", () => {
    interrupts += 1
    if (interrupts === 1 && cancel !== null) {
      io.stderr.write(`${brand.binary}: stopping the replay (it ends as incomplete)…\n`)
      return cancel()
    }
    process.exit(130)
  })
  let result: ReplayResult
  try {
    result = await engine.replay(
      { cwd, session: options.session, params },
      {
        started: (replaySessionId, sourceSessionId, stop) => {
          cancel = stop
          progress?.started(replaySessionId, sourceSessionId)
        },
        event: (event) => progress?.event(event),
      },
    )
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error
    return fail(io, error.message, exitCodeOfRefusal(error))
  } finally {
    off()
  }
  if (options.json) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    io.stdout.write(`${result.text}\n\n`)
    if (result.comparison !== null) io.stdout.write(`${result.comparison}\n\n`)
    const usage = result.usage === null ? "" : `, ${result.usage.inputTokens} tokens in of which ${result.usage.cachedInputTokens} cached, ${result.usage.outputTokens} out`
    io.stdout.write(`  replay session  ${result.sessionId}  (${plural(result.requests, "model call")}${usage})\n`)
    if (result.workspace !== null) io.stdout.write(`  workspace       ${result.workspace}  (the copy the replay carried on in; delete it when you are done)\n`)
  }
  return result.report.status === "identical" || result.report.status === "diverged" ? 0 : 1
}

/** The replay's options with the files read, or a usage problem. */
async function replayParams(options: ReplayOptions): Promise<Omit<ReplayParams, "sessionId" | "ref"> | string> {
  let systemPrompt: string | undefined
  if (options.systemPrompt !== null) {
    if (!(await Bun.file(options.systemPrompt).exists())) return `--system-prompt ${options.systemPrompt}: no such file`
    systemPrompt = await Bun.file(options.systemPrompt).text()
  }
  const toolDescriptions: Record<string, string> = {}
  for (const { tool, file } of options.toolDescriptions) {
    if (!(await Bun.file(file).exists())) return `--tool-description ${tool}=${file}: no such file`
    toolDescriptions[tool] = (await Bun.file(file).text()).trim()
  }
  return {
    policy: options.policy,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(options.toolDescriptions.length === 0 ? {} : { toolDescriptions }),
    ...(options.model === null ? {} : { model: options.model }),
    ...(options.effort === null ? {} : { effort: options.effort === "default" ? null : options.effort }),
    ...(options.strict ? { strict: true } : {}),
    ...(options.throughSeq === null ? {} : { throughSeq: options.throughSeq }),
    ...(options.workspace === null ? {} : { workspace: options.workspace }),
  }
}

/**
 * One line per call the replay makes, as it is matched against the
 * recording: `step 2 · write a.txt · as recorded`. The replay's text is
 * not shown here; the report compares the final answers.
 */
export class ReplayProgressLines {
  private step = 0
  private readonly calls = new Map<string, { name: string; input: string }>()

  constructor(private readonly write: (text: string) => void) {}

  started(replaySessionId: string, sourceSessionId: string): void {
    this.write(`replaying ${sourceSessionId} as ${replaySessionId}\n`)
  }

  event(event: EngineEvent): void {
    switch (event.type) {
      case "step.started":
        this.step += 1
        return
      case "tool.called":
        this.calls.set(`${event.data.messageId}/${event.data.callId}`, { name: event.data.name, input: event.data.input })
        return
      case "replay.call": {
        const call = this.calls.get(`${event.data.messageId}/${event.data.callId}`)
        const what = call === undefined ? "a call" : `${call.name} ${truncate(flatten(callArgument(call.name, call.input)), 60)}`.trim()
        const result =
          event.data.result === "matched"
            ? "as recorded"
            : event.data.result === "normalised"
              ? "as recorded (normalised)"
              : event.data.result === "dropped"
                ? "dropped"
                : event.data.result === "diverged"
                  ? `differs from the recording${event.data.divergence === null ? "" : ` (${event.data.divergence.replaceAll("_", " ")})`}`
                  : event.data.executed
                    ? "not on the recording · ran in the copy"
                    : "not on the recording"
        this.write(`  step ${this.step} · ${what} · ${result}\n`)
        return
      }
      case "replay.diverged":
        this.write(`  left the recording: carrying on in a copy of the workspace, ${event.data.workspace}\n  ${COPY_NOTE}\n`)
        return
      case "step.failed": {
        const error = event.data.error as { readonly kind?: string; readonly message?: string }
        this.write(`  step ${this.step} failed: ${truncate(flatten(error.message ?? error.kind ?? "unknown error"), 120)}\n`)
        return
      }
      default:
        return
    }
  }
}

function fail(io: SubcommandIo, message: string, code = 1): number {
  io.stderr.write(`${brand.binary}: ${message}\n`)
  return code
}
