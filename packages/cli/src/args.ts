/** Command-line arguments. Parsing is pure: it returns a value or a usage error, and never touches the process. */
import { brand } from "@light-harness/core"
import { ENGINE_KINDS, type EngineKind } from "./select-engine.ts"

export interface Options {
  /** The prompt given as arguments, joined with spaces; `null` when none was given. */
  readonly prompt: string | null
  readonly session: string | null
  readonly continue: boolean
  readonly model: string | null
  readonly effort: string | null
  /** `--max-steps <n>`: model calls per turn before the final answer without tools; `null` is the engine's default. */
  readonly maxSteps: number | null
  readonly cwd: string | null
  readonly output: "pretty" | "json" | "quiet"
  readonly showReasoning: boolean
  readonly interactive: boolean
  readonly demo: string | null
  readonly demoSpeed: number
  readonly demoGraceMs: number | null
  /** `--engine`: how the real engine is reached; through ACP with a child process unless asked otherwise. */
  readonly engine: EngineKind
}

export type Parsed =
  | { readonly kind: "run"; readonly options: Options }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  /** `--list-sessions` or `--models`: print a listing from the engine and exit. */
  | { readonly kind: "list"; readonly what: "sessions" | "models"; readonly options: Options }
  /** `acp`: serve the Agent Client Protocol on stdin and stdout. */
  | { readonly kind: "acp" }
  /** `tui [options]`: the full-screen terminal interface (packages/tui). */
  | { readonly kind: "tui"; readonly options: Options }
  | { readonly kind: "error"; readonly message: string }

const VALUE_FLAGS = ["--session", "--model", "--effort", "--max-steps", "--cwd", "--demo", "--demo-speed", "--demo-grace", "--engine"] as const
type ValueFlag = (typeof VALUE_FLAGS)[number]

const SHORT: Record<string, string> = { "-h": "--help", "-v": "--version", "-c": "--continue", "-q": "--quiet", "-i": "--interactive", "-m": "--model" }

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv[0] === "acp") return argv.length === 1 ? { kind: "acp" } : error("acp takes no arguments; the client sends everything else")
  if (argv[0] === "tui") {
    const rest = parseArgs(argv.slice(1))
    if (rest.kind !== "run") return rest.kind === "list" ? error("tui does not list; run the listing without tui") : rest
    if (rest.options.prompt !== null) return error("tui takes no prompt; type it in the TUI")
    if (rest.options.output !== "pretty" || rest.options.interactive) return error("tui cannot be combined with --json, --quiet or --interactive")
    return { kind: "tui", options: rest.options }
  }
  const values: Partial<Record<ValueFlag, string>> = {}
  const flags = new Set<string>()
  const words: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--") {
      words.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith("-") || arg === "-") {
      words.push(arg)
      continue
    }
    const [rawName, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null]
    const name = SHORT[rawName] ?? rawName
    if (isValueFlag(name)) {
      const value = inline ?? argv[index + 1]
      if (inline === null) index += 1
      if (value === undefined || (inline === null && value.startsWith("-") && value !== "-")) return error(`${name} needs a value`)
      if (value === "") return error(`${name} needs a non-empty value`)
      values[name] = value
      continue
    }
    if (inline !== null) return error(`${name} does not take a value`)
    if (!["--help", "--version", "--continue", "--json", "--quiet", "--show-reasoning", "--interactive", "--list-sessions", "--models"].includes(name))
      return error(`unknown option ${rawName}`)
    flags.add(name)
  }

  if (flags.has("--help")) return { kind: "help" }
  if (flags.has("--version")) return { kind: "version" }
  if (flags.has("--json") && flags.has("--quiet")) return error("--json and --quiet cannot be combined")
  if (values["--session"] !== undefined && flags.has("--continue")) return error("--session and --continue cannot be combined")
  const speed = values["--demo-speed"] === undefined ? 1 : Number(values["--demo-speed"])
  if (!Number.isFinite(speed) || speed < 0) return error("--demo-speed must be a number of at least 0")
  const grace = values["--demo-grace"] === undefined ? null : Number(values["--demo-grace"])
  if (grace !== null && (!Number.isInteger(grace) || grace < 0)) return error("--demo-grace must be a whole number of milliseconds")
  if ((values["--demo-speed"] !== undefined || grace !== null) && values["--demo"] === undefined) return error("--demo-speed and --demo-grace only apply with --demo")
  const maxSteps = values["--max-steps"] === undefined ? null : Number(values["--max-steps"])
  if (maxSteps !== null && (!Number.isInteger(maxSteps) || maxSteps < 1)) return error("--max-steps must be a whole number of at least 1")
  const engine = values["--engine"] ?? "acp"
  if (!(ENGINE_KINDS as readonly string[]).includes(engine)) return error(`--engine must be one of: ${ENGINE_KINDS.join(", ")}`)
  if (values["--engine"] !== undefined && values["--demo"] !== undefined) return error("--engine does not apply to --demo, which plays a script without an engine")
  const output = flags.has("--json") ? "json" : flags.has("--quiet") ? "quiet" : "pretty"
  if (flags.has("--interactive") && output !== "pretty") return error("interactive mode cannot be combined with --json or --quiet")
  const listing = flags.has("--list-sessions") ? "sessions" : flags.has("--models") ? "models" : null
  if (flags.has("--list-sessions") && flags.has("--models")) return error("--list-sessions and --models cannot be combined")
  if (listing !== null && (words.length > 0 || flags.has("--interactive")))
    return error(`--${listing === "sessions" ? "list-sessions" : "models"} takes no prompt`)

  const options: Options = {
    prompt: words.length === 0 ? null : words.join(" "),
    session: values["--session"] ?? null,
    continue: flags.has("--continue"),
    model: values["--model"] ?? null,
    effort: values["--effort"] ?? null,
    maxSteps,
    cwd: values["--cwd"] ?? null,
    output,
    showReasoning: flags.has("--show-reasoning"),
    interactive: flags.has("--interactive"),
    demo: values["--demo"] ?? null,
    demoSpeed: speed,
    demoGraceMs: grace,
    engine: engine as EngineKind,
  }
  return listing === null ? { kind: "run", options } : { kind: "list", what: listing, options }
}

function isValueFlag(name: string): name is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(name)
}

function error(message: string): Parsed {
  return { kind: "error", message }
}

export function helpText(): string {
  const b = brand.binary
  return `${brand.name}: a terminal coding agent

Usage:
  ${b} [options] <prompt...>     run one prompt and exit
  echo "<prompt>" | ${b} [options]  read the prompt from stdin
  ${b} [options]                 interactive: a prompt line, then the agent's work
  ${b} acp                       serve the Agent Client Protocol on stdio (for editors)
  ${b} tui [options]             the full-screen terminal interface (preview; ${b.toUpperCase()}_TUI=1 makes
                                 it what \`${b}\` with no prompt starts)

Options:
  --session <id>         resume a session by ID, or by the start of one if it is unique
  -c, --continue         resume the most recent session in this directory
  -m, --model <name>     model to use
  --effort <level>       reasoning effort, e.g. low, medium or high
  --max-steps <n>        model calls per turn before a final answer without tools
  --cwd <dir>            working directory (default: the current one)
  --json                 write every event as one JSON line, nothing else on stdout
  -q, --quiet            print only the final answer
  --show-reasoning       show the model's reasoning instead of a one-line summary
  -i, --interactive      stay interactive after a prompt given as arguments
  --list-sessions        list the sessions in the working directory (--json: one per line)
  --models               list the models --model accepts (--json: one per line)
  -v, --version          print the version
  -h, --help             print this help

Demo (replays a scripted session; no model, no tools):
  --demo list            list the scenarios
  --demo <name|number>   play one
  --demo-speed <x>       playback speed (default 1; 0 is instant)
  --demo-grace <ms>      how long a stopped command takes to wind down

Debugging:
  --engine <how>         how the engine is reached: acp (the default: \`${b} acp\` as a child
                         process, as an editor runs it), acp-memory (the same protocol, the
                         server in this process) or direct (no protocol)

Interactive keys:
  Enter sends; end a line with \\ (or press Alt-Enter) to continue on a new line;
  Up and Down recall earlier entries, whole. Ctrl-C while the agent works stops it
  (twice within 2 s exits); Ctrl-C at the prompt clears the entry; Ctrl-D exits.

While the agent works:
  type and press Enter    sent at once; the agent sees it after the current step
  /queue <message>        held until the turn is done (its checks have run), then delivered
  /exit                   leave (the running work is stopped as a shutdown)

At the prompt, while the agent is idle:
  /undo                   go back to before your last message: the files and the
                          conversation. Shows what will change first, and asks before
                          it overwrites a file edited since by you or another session
  /redo                   bring back what the last /undo took away

Sessions are stored one file each, so several ${b} processes (and an editor) can
work at once, each in its own session. A session another process is working in
cannot be opened until that process lets go of it.

Exit codes:
  0    done
  1    failed
  2    usage error
  3    done, but the project's checks still fail and were left unresolved (the model
       reported that it cannot fix them, ran out of rounds, or checks only report).
       With --json the last event is execution.succeeded, and its
       data.verification.status is "unresolved" (with the reason and the failing checks)
  130  interrupted (Ctrl-C)
  141  output closed (a pipe reader left)
  143  terminated (SIGTERM)
`
}
