/** Command-line arguments. Parsing is pure: it returns a value or a usage error, and never touches the process. */
import { brand } from "./brand.ts"

export interface Options {
  /** The prompt given as arguments, joined with spaces; `null` when none was given. */
  readonly prompt: string | null
  readonly session: string | null
  readonly continue: boolean
  readonly model: string | null
  readonly effort: string | null
  readonly cwd: string | null
  readonly output: "pretty" | "json" | "quiet"
  readonly showReasoning: boolean
  readonly interactive: boolean
  readonly demo: string | null
  readonly demoSpeed: number
  readonly demoGraceMs: number | null
}

export type Parsed =
  | { readonly kind: "run"; readonly options: Options }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string }

const VALUE_FLAGS = ["--session", "--model", "--effort", "--cwd", "--demo", "--demo-speed", "--demo-grace"] as const
type ValueFlag = (typeof VALUE_FLAGS)[number]

const SHORT: Record<string, string> = { "-h": "--help", "-v": "--version", "-c": "--continue", "-q": "--quiet", "-i": "--interactive", "-m": "--model" }

export function parseArgs(argv: readonly string[]): Parsed {
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
    if (!["--help", "--version", "--continue", "--json", "--quiet", "--show-reasoning", "--interactive"].includes(name))
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
  const output = flags.has("--json") ? "json" : flags.has("--quiet") ? "quiet" : "pretty"
  if (flags.has("--interactive") && output !== "pretty") return error("interactive mode cannot be combined with --json or --quiet")

  return {
    kind: "run",
    options: {
      prompt: words.length === 0 ? null : words.join(" "),
      session: values["--session"] ?? null,
      continue: flags.has("--continue"),
      model: values["--model"] ?? null,
      effort: values["--effort"] ?? null,
      cwd: values["--cwd"] ?? null,
      output,
      showReasoning: flags.has("--show-reasoning"),
      interactive: flags.has("--interactive"),
      demo: values["--demo"] ?? null,
      demoSpeed: speed,
      demoGraceMs: grace,
    },
  }
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

Options:
  --session <id>         resume a session by ID
  -c, --continue         resume the most recent session in this directory
  -m, --model <name>     model to use
  --effort <level>       reasoning effort, e.g. low, medium or high
  --cwd <dir>            working directory (default: the current one)
  --json                 write every event as one JSON line, nothing else on stdout
  -q, --quiet            print only the final answer
  --show-reasoning       show the model's reasoning instead of a one-line summary
  -i, --interactive      stay interactive after a prompt given as arguments
  -v, --version          print the version
  -h, --help             print this help

Demo (replays a scripted session; no model, no tools):
  --demo list            list the scenarios
  --demo <name|number>   play one
  --demo-speed <x>       playback speed (default 1; 0 is instant)
  --demo-grace <ms>      how long a stopped command takes to wind down

Interactive keys:
  Enter sends; end a line with \\ to continue it on the next one; Up and Down recall
  earlier prompts. Ctrl-C while the agent works stops it (twice within 2 s exits);
  Ctrl-C at the prompt clears the line; Ctrl-D exits.

Exit codes: 0 done, 1 failed, 2 usage error, 130 interrupted.
`
}
