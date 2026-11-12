/** Command-line arguments. Parsing is pure: it returns a value or a usage error, and never touches the process. */
import { brand } from "@windlass/core"
import { ENGINE_KINDS, type EngineKind } from "./select-engine.ts"
import { nearest } from "./text.ts"
import { type ForkOptions, type ReplayOptions, parseSubcommand } from "./subcommands.ts"

export interface Options {
  /** The prompt given as arguments, joined with spaces; `null` when none was given. */
  readonly prompt: string | null
  readonly session: string | null
  readonly continue: boolean
  readonly model: string | null
  readonly effort: string | null
  /** `--agent <name>`: the agent the session runs as (`none`: no agent); `null`: the configured default, or what a resumed session runs as. */
  readonly agent: string | null
  /** `--max-steps <n>`: model calls per turn before the final answer without tools; `null` is the engine's default. */
  readonly maxSteps: number | null
  /** `--approval <ask|auto|full>`: when a tool call asks before it runs; `null` is the configuration's (default `auto`). */
  readonly approval: "ask" | "auto" | "full" | null
  /** `--unattended <deny|stop>`: what a call that would ask becomes when nobody can answer; `null` is the configuration's (default `deny`). */
  readonly unattended: "deny" | "stop" | null
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
  /** `login [start|finish|status|logout]`: the ChatGPT sign-in (`./login.ts` parses the rest). */
  | { readonly kind: "login"; readonly argv: readonly string[] }
  /** `tui [options]`: the full-screen terminal interface (packages/tui). */
  | { readonly kind: "tui"; readonly options: Options }
  /** `fork [<session>] [options]`: a new session with another's conversation so far. */
  | { readonly kind: "fork"; readonly options: ForkOptions }
  /** `replay [<session>] [options]`: the model again on a recorded session, answered from the recording. */
  | { readonly kind: "replay"; readonly options: ReplayOptions }
  /** A subcommand's own `--help`. */
  | { readonly kind: "usage"; readonly text: string }
  | { readonly kind: "error"; readonly message: string }

const VALUE_FLAGS = ["--session", "--model", "--effort", "--agent", "--max-steps", "--approval", "--unattended", "--cwd", "--demo", "--demo-speed", "--demo-grace", "--engine"] as const
const APPROVAL_MODES = ["ask", "auto", "full"] as const
const UNATTENDED_ACTIONS = ["deny", "stop"] as const
type ValueFlag = (typeof VALUE_FLAGS)[number]

const BOOLEAN_FLAGS = ["--help", "--version", "--continue", "--json", "--quiet", "--show-reasoning", "--interactive", "--list-sessions", "--models"] as const

const SHORT: Record<string, string> = { "-h": "--help", "-v": "--version", "-c": "--continue", "-q": "--quiet", "-i": "--interactive", "-m": "--model" }

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv[0] === "acp") return argv.length === 1 ? { kind: "acp" } : error("acp takes no arguments; the client sends everything else")
  if (argv[0] === "login") return { kind: "login", argv: argv.slice(1) }
  if (argv[0] === "fork" || argv[0] === "replay") {
    const sub = parseSubcommand(argv)
    if (sub.kind === "help") return { kind: "usage", text: sub.text }
    return sub
  }
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
    if (!(BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      const close = rawName.startsWith("--") ? nearest(rawName, [...BOOLEAN_FLAGS, ...VALUE_FLAGS]) : null
      return error(`unknown option ${rawName}${close === null ? "" : `; did you mean ${close}?`}`)
    }
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
  const approval = values["--approval"] ?? null
  if (approval !== null && !(APPROVAL_MODES as readonly string[]).includes(approval)) return error(`--approval must be one of: ${APPROVAL_MODES.join(", ")}`)
  const unattended = values["--unattended"] ?? null
  if (unattended !== null && !(UNATTENDED_ACTIONS as readonly string[]).includes(unattended)) return error(`--unattended must be one of: ${UNATTENDED_ACTIONS.join(", ")}`)
  if ((approval !== null || unattended !== null) && values["--demo"] !== undefined) return error("--approval and --unattended do not apply to --demo, which runs no tools")
  if (values["--agent"] !== undefined && values["--demo"] !== undefined) return error("--agent does not apply to --demo, which plays a script")
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
    agent: values["--agent"] ?? null,
    maxSteps,
    approval: approval as Options["approval"],
    unattended: unattended as Options["unattended"],
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

/**
 * The ways to run the program, one row each: what is typed, then what it
 * does, in a column that starts after the longest row whatever the binary
 * is called, with the lines that continue a description under its first.
 */
function usageRows(b: string): string {
  const rows: readonly (readonly [string, readonly string[]])[] = [
    [`${b} [options] <prompt...>`, ["run one prompt and exit"]],
    [`echo "<prompt>" | ${b} [options]`, ["read the prompt from stdin"]],
    [`${b} [options]`, ["interactive: a prompt line, then the agent's work"]],
    [`${b} acp`, ["serve the Agent Client Protocol on stdio (for editors)"]],
    [`${b} login [start]`, ["sign in with ChatGPT: opens a browser when there is one,", "otherwise prints the address and asks for the page you", "ended on (pasted, not shown)"]],
    [`${b} login finish`, ["finish a sign-in started elsewhere from the pasted address"]],
    [`${b} login status`, ["who is signed in and until when (never the tokens)"]],
    [`${b} login logout`, ["forget the saved sign-in on this machine"]],
    [`${b} tui [options]`, [`the full-screen terminal interface (${brand.envPrefix}TUI=1 makes it`, `what \`${b}\` with no prompt starts)`]],
    [`${b} fork [<session>]`, ["a new session with the conversation so far, to try another", "way without changing the original; --turn <n> forks after", `turn n (\`${b} fork --help\`)`]],
    [`${b} replay [<session>]`, ["the model again on a recorded session, every tool call", "answered from the recording: where does a changed prompt,", "tool description or model change what it does", `(\`${b} replay --help\`)`]],
  ]
  const width = Math.max(...rows.map(([typed]) => typed.length))
  return rows.flatMap(([typed, lines]) => lines.map((line, index) => `  ${(index === 0 ? typed : "").padEnd(width)}  ${line}`)).join("\n")
}

export function helpText(): string {
  const b = brand.binary
  const short = brand.aliases.map((alias) => `; \`${alias}\` is short for \`${b}\``).join("")
  return `${brand.name}: a terminal coding agent${short}

Usage:
${usageRows(b)}

Options:
  --session <id>         resume a session by ID, or by the start of one if it is unique
  -c, --continue         resume the most recent session in this directory
  -m, --model <name>     model to use
  --effort <level>       reasoning effort, e.g. low, medium or high
  --agent <name>         the agent the session runs as: its instructions, what it may do,
                         and its model where it names one (none: no agent). A resumed
                         session is switched to it. /agent lists the ones defined here
  --max-steps <n>        model calls per turn before a final answer without tools
  --approval <mode>      when a tool call asks before it runs (default: auto)
                           ask   reads run; every edit, command and network call asks
                           auto  edits in the working directory run, and commands run in
                                 a sandbox (no network, writes only there and in a temp
                                 directory); anything that needs more asks
                           full  everything runs with your full permissions and nothing
                                 asks. For a container or a machine with nothing to lose
  --unattended <what>    what a call that would ask becomes when nobody can answer: a
                         one-shot run, --json, a pipe (default: deny)
                           deny  the call is refused, the agent is told and goes on
                           stop  the call is refused and the run ends, exit code 4
  --cwd <dir>            working directory (default: the current one)
  --json                 write every event as one JSON line, nothing else on stdout; after
                         each turn a "cli.summary" line: outcome, steps, time, tokens,
                         cached share
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
  /stop [<number>]        stop one running tool call and let the turn go on; with several
                          running, /stop alone lists them by number
  /watch <id> <text>      tell the agent when the background command <id> prints a
                          line with that text; /watch lists the watches, and
                          /watch remove <id> removes one
  /exit                   leave (the running work is stopped as a shutdown)

When a tool call needs your approval (interactive mode):
  the question shows the command or path and what each answer remembers. Answer with
  a (allow once), s (allow for this session), p (allow in this project), or n (no);
  words after the letter go to the agent as your note. Ctrl-C stops the turn instead.
  Nothing is ever remembered for a command line, only for a capability, such as
  network access for sandboxed commands in this session.
  /clear-taint            after a web page, an MCP result or a file from outside the
                          working directory entered the conversation, anything that can
                          send data out asks again; this says you trust what is there
  /approval [ask|auto|full]  says the approval mode, or switches it from the next tool call
  Commands that ran in the sandbox are marked ⊡ (with +network or +write <dir> when they
  were given more); one that ran without it says "no sandbox".

At the prompt (/help lists every command; a /word that is not one is never sent, and
//text sends a message that starts with a slash):
  /undo                   go back to before your last message: the files and the
                          conversation. Shows what will change first, and asks before
                          it overwrites a file edited since by you or another session
  /redo                   bring back what the last /undo took away
  /diff                   the files the last turn changed, with their diffs
  /agent [name|none]      the agents defined here and the one the session runs as; with a
                          name, switch to it (from the next step)
  /rename <title>         give the session a title
  /compact                compact the conversation now: the older part becomes a
                          checkpoint; says the sizes, or why there was nothing to compact
  /mcp [approve <name>]   the MCP servers: state, tools, where each is defined; a server
                          this project's configuration names is asked about first
  /hooks [approve <name>] the hooks: when each runs, its command, its state (in force,
                          waiting for your approval, failed and why), where it is defined
  /lsp [approve <name>]   the language servers that add diagnostics to the agent's edits:
                          state, the files each serves, where it is defined
  /skills                 the skills the model can load here, and the ones that failed
  /wakeups [add|cancel|secret …]  this session's wake-ups; add one of your own
                          (/wakeups add shows the forms), cancel one, a webhook's secret
  /memory, /remember <text>, /forget <id>  notes for later sessions (memory is off
                          unless turned on; /memory says how)

Sessions are stored one file each, so several ${b} processes (and an editor) can
work at once, each in its own session. A session another process is working in
cannot be opened until that process lets go of it.

Exit codes:
  0    done (with --unattended deny, also when calls were refused for lack of
       approval: the ending says how many; --unattended stop exits 4 instead)
  1    failed
  2    usage error: an unknown option, a wrong value, an unknown model or session ID
  3    done, but the project's checks still fail and were left unresolved (the model
       reported that it cannot fix them, ran out of rounds, or checks only report).
       With --json the turn's last event is execution.succeeded, and its
       data.verification.status is "unresolved" (with the reason and the failing checks)
  4    stopped: a tool call needed your approval and nobody was there to give it
       (--unattended stop)
  130  interrupted (Ctrl-C)
  141  output closed (a pipe reader left)
  143  terminated (SIGTERM)
`
}
