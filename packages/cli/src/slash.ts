/**
 * The interactive CLI's slash commands: what an entry that starts with `/`
 * is, before anything is sent to the agent.
 *
 * An entry whose first word is `/<name>` (letters, digits, `-`, `_`, `.`,
 * and `:` between a folder and a file, as in `/frontend:test`; no second
 * `/`) is a command. A name no source knows is not sent: it would cost a
 * model request and title a new session "/<name>". The user is told it is
 * not a command, given the nearest one, and told how to send a message that
 * really starts with a slash: begin it with two (`//help` sends `/help`). An
 * entry whose first word has another slash (`/etc/hosts is wrong`) is a path
 * and goes to the agent as typed.
 *
 * Commands come from sources, looked up in order: the CLI's own first, then
 * the command files of the user and the project (`userCommands`): Markdown
 * files whose text, with what was typed after the name put in, is sent as the
 * user's message. The engine expands and records them; what is here is the
 * lookup, and the words both interfaces use about them.
 */
import type { EventData } from "@windlass/core"
import type { ClientCommand, CommandInfo, CommandsResult } from "@windlass/acp/extensions"
import type { Line } from "./features.ts"
import { splitArguments } from "../../core/src/commands/expand.ts"
import { flatten, nearest, plural, truncate } from "./text.ts"

export interface SlashCommand {
  readonly name: string
  /** What follows the name, for the help (`<message>`, `[ask|auto|full]`). */
  readonly args: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** `idle`: at the prompt only; `working`: while the agent works only; `any`: both. */
  readonly when: "idle" | "working" | "any"
  /** A command file's: the file, and where it comes from. */
  readonly file?: Pick<CommandInfo, "path" | "scope" | "agent">
}

/** Where commands come from. */
export interface CommandSource {
  /** How the help heads this source's commands. */
  readonly label: string
  commands(): readonly SlashCommand[]
}

/** The commands the line CLI itself runs. */
export const BUILTIN_COMMANDS: CommandSource = {
  label: "Commands",
  commands: () => [
    { name: "undo", args: "", description: "go back to before your last message: the files and the conversation", when: "idle" },
    { name: "redo", args: "", description: "bring back what the last /undo took away", when: "idle" },
    { name: "diff", args: "", description: "the files the last turn changed, with their diffs", when: "any" },
    { name: "agent", args: "[name|none]", description: "the agents defined here and the one this session runs as; with a name, switch to it", aliases: ["agents"], when: "any" },
    { name: "rename", args: "<title>", description: "give the session a title", when: "any" },
    { name: "compact", args: "", description: "compact the conversation now: the older part becomes a checkpoint", when: "any" },
    { name: "approval", args: "[ask|auto|full]", description: "say the approval mode, or switch it from the next tool call", aliases: ["mode"], when: "any" },
    { name: "clear-taint", args: "", description: "say you trust the untrusted content in this conversation", when: "any" },
    { name: "mcp", args: "[approve <server>]", description: "the MCP servers: state, tools, where each is defined; approve one the project names", when: "any" },
    { name: "hooks", args: "[approve <hook>]", description: "the hooks: when each runs, its command, its state, where it is defined; approve one the project names", when: "any" },
    { name: "lsp", args: "[approve <server>]", description: "the language servers that add diagnostics to edits: state, the files each serves, where it is defined; approve one the project names", aliases: ["diagnostics"], when: "any" },
    { name: "skills", args: "", description: "the skills the model can load here, and the ones that could not be loaded", when: "any" },
    { name: "wakeups", args: "[add|cancel|secret …]", description: "this session's wake-ups; add one of your own (/wakeups add shows the forms), cancel <id>, or show a webhook's secret (secret <id>)", aliases: ["wake"], when: "any" },
    { name: "watch", args: "[<id> <text>|remove <id>]", description: "tell the agent when the background command <id> prints a line with that text; with nothing, the running commands and their watches; remove <watch id> removes one", when: "any" },
    { name: "memory", args: "[confirm|reject|renew|forget <id>]", description: "the notes later sessions are given, and the ones waiting for your confirmation", when: "any" },
    { name: "remember", args: "[--me] <text>", description: "save a note for later sessions (this project; --me: about you, everywhere)", when: "any" },
    { name: "forget", args: "<id>", description: "retract a note: no later session is given it", when: "any" },
    { name: "queue", args: "<message>", description: "while the agent works: hold a message until the turn is done", when: "any" },
    { name: "stop", args: "[<number>]", description: "while the agent works: stop one running tool call and let the turn go on (with several running it lists them; Ctrl-C stops the whole turn)", when: "any" },
    { name: "help", args: "", description: "these commands and keys", when: "any" },
    { name: "exit", args: "", description: "leave (running work is stopped as a shutdown)", aliases: ["quit"], when: "any" },
  ],
}

export type Lookup =
  /** Not a command: sent to the agent as `text` (a leading `//` is one slash). */
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "command"; readonly command: SlashCommand; readonly source: CommandSource; readonly rest: string }
  /** `/<name>` that no source knows; `suggestion` is the nearest command's name, when one is close. */
  | { readonly kind: "unknown"; readonly name: string; readonly suggestion: string | null }

/** What `entry` is: a message, a command of one of `sources`, or an unknown command. */
export function lookup(entry: string, sources: readonly CommandSource[] = [BUILTIN_COMMANDS]): Lookup {
  const trimmed = entry.trimStart()
  if (trimmed.startsWith("//")) return { kind: "message", text: trimmed.slice(1) }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)(?=\s|$)([\s\S]*)$/.exec(trimmed)
  if (match === null) return { kind: "message", text: entry }
  const typed = match[1]!
  const name = typed.toLowerCase()
  const rest = match[2]!.trim()
  for (const source of sources) {
    const commands = source.commands()
    // As typed first: two command files may differ only in case.
    const command = commands.find((candidate) => candidate.name === typed) ?? commands.find((candidate) => candidate.name.toLowerCase() === name || candidate.aliases?.includes(name))
    if (command !== undefined) return { kind: "command", command, source, rest }
  }
  const names = sources.flatMap((source) => source.commands().flatMap((command) => [command.name, ...(command.aliases ?? [])]))
  return { kind: "unknown", name, suggestion: nearest(name, names) }
}

/** What the user is told about an unknown command, in one sentence. */
export function unknownCommandText(found: Extract<Lookup, { kind: "unknown" }>): string {
  const instead = found.suggestion === null ? "/help lists the commands" : `did you mean /${found.suggestion}? (/help lists them)`
  return `/${found.name} is not a command, so nothing was sent; ${instead}. To send a message that starts with a slash, begin it with two: //${found.name}`
}

/** The help: every command with what it does (a command file's with where it comes from), then the keys. */
export function helpLines(sources: readonly CommandSource[] = [BUILTIN_COMMANDS]): Line[] {
  const lines: Line[] = []
  const say = (text: string, indent = 0): Line => ({ text, tone: "dim", indent })
  for (const source of sources) {
    const commands = source.commands()
    if (commands.length === 0) continue
    lines.push(say(`${source.label}:`))
    const labels = commands.map((command) => `/${command.name}${command.args === "" ? "" : ` ${command.args}`}${command.aliases === undefined ? "" : ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`}`)
    const width = Math.max(...labels.map((label) => label.length))
    commands.forEach((command, index) => {
      lines.push({ ...say(`${labels[index]!.padEnd(width)}  ${command.description}${command.when === "idle" ? " (while the agent is idle)" : ""}`, 2), hang: width + 2 })
      // The file on a line of its own: a path is for opening, and is never cut.
      if (command.file !== undefined) lines.push(say(`${COMMAND_SCOPE[command.file.scope]}${command.file.agent === null ? "" : ` · runs as the agent ${command.file.agent}`}:`, 6), { text: command.file.path, tone: "dim", indent: 6, path: true })
    })
  }
  lines.push(
    say("Keys:"),
    say("Enter sends; Alt-Enter or a trailing \\ starts a new line; Up and Down recall earlier entries.", 2),
    say("Ctrl-C stops the agent while it works (twice within 2 s exits), and clears the entry at the prompt.", 2),
    say("Ctrl-D on an empty prompt leaves.", 2),
    say("A message that starts with a slash: begin it with two (//etc sends /etc).", 2),
  )
  return lines
}

// ---------------------------------------------------------------- command files

/** The CLI's own commands as the engine takes them: a file of one of these names is hidden, and their names count for a did-you-mean. */
export function clientCommands(source: CommandSource = BUILTIN_COMMANDS): ClientCommand[] {
  return source.commands().map((command) => ({ name: command.name, ...(command.aliases === undefined ? {} : { aliases: command.aliases }) }))
}

/** Where a command file comes from, in a few words. */
export const COMMAND_SCOPE = { project: "from this project", config: "from a directory your configuration names (commands.paths)", user: "your own, for every project" } as const

/** The command files a session has, as a source: the ones a command of the client's own does not hide. */
export function userCommands(listing: CommandsResult): CommandSource {
  const commands = listing.commands
    .filter((command) => command.hiddenBy === null)
    .map((command): SlashCommand => ({ name: command.name, args: command.argumentHint ?? "", description: command.description, when: "any", file: { path: command.path, scope: command.scope, agent: command.agent } }))
  return { label: "Your commands (command files: their text is sent as your message)", commands: () => commands }
}

/** A command file of that name that cannot be used, or one a command of the client's own hides: why, as lines for the user; `null` when there is none. */
export function unusableCommandLines(listing: CommandsResult, name: string): Line[] | null {
  const lower = name.toLowerCase()
  const problem = listing.problems.find((candidate) => candidate.severity === "skipped" && candidate.name !== null && candidate.name.toLowerCase() === lower)
  if (problem === undefined) return null
  return [
    { text: `/${problem.name} cannot be used, so nothing was sent: ${problem.reason}.`, tone: "warn" },
    { text: problem.path, tone: "warn", indent: 2, path: true },
  ]
}

/** The files `/help` says could not be used or are hidden, with why and where. */
export function commandProblemLines(listing: CommandsResult): Line[] {
  const lines: Line[] = []
  for (const problem of listing.problems) {
    const what = problem.severity === "skipped" ? "not usable" : problem.severity === "shadowed" ? "hidden" : "usable, but"
    lines.push({ text: `${problem.name === null ? "a command file" : `/${problem.name}`}: ${what}: ${problem.reason}`, tone: problem.severity === "skipped" ? "warn" : "dim", indent: 2 })
    lines.push({ text: problem.path, tone: "dim", indent: 6, path: true })
  }
  return lines.length === 0 ? [] : [{ text: "Command files with problems:", tone: "warn" }, ...lines]
}

const LEFT_AS_TEXT = {
  shell: "a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual",
  include: "a command file reads no file into its text; the agent can read it with its tools",
} as const

/**
 * What the transcript says about a message a command file produced
 * (`command.expanded`): the entry as typed, where its text came from, and
 * what expansion reported: an argument the file uses that was not given, the
 * arguments that were typed and that the file has no place for (they are
 * not in the message), and what another harness would have run or read and
 * this one left as text.
 */
export function commandSent(use: Pick<EventData<"command.expanded">, "name" | "arguments" | "path" | "scope" | "missing" | "unused" | "unsupported">, text: string | null): { readonly typed: string; readonly head: string; readonly where: string; readonly path: string; readonly notes: string[] } {
  const typed = `/${use.name}${use.arguments === "" ? "" : ` ${use.arguments}`}`
  const size = text === null ? "" : ` (${plural(text.split("\n").length, "line")})`
  const missing = use.missing.length === 0 ? [] : [`${use.missing.length === 1 ? `argument ${use.missing[0]} was` : `arguments ${use.missing.join(", ")} were`} not given: ${use.missing.length === 1 ? "it is" : "they are"} empty in the text that was sent`]
  const unused = unusedArgumentsNote(use)
  const unsupported = use.unsupported.map((construct) => `${construct.text} (line ${construct.line}) was left as text: ${LEFT_AS_TEXT[construct.kind]}`)
  return { typed, head: `the text of a command file was sent${size}`, where: COMMAND_SCOPE[use.scope], path: use.path, notes: [...missing, ...(unused === null ? [] : [unused]), ...unsupported] }
}

/**
 * The arguments that were typed after a command's name and that its file has no place for
 * (`command.expanded`'s `unused`, their positions): which ones, as typed, and that they are not in the message.
 * `null` when every argument was used.
 */
function unusedArgumentsNote(use: Pick<EventData<"command.expanded">, "arguments" | "unused">): string | null {
  if (use.unused.length === 0) return null
  const typed = splitArguments(use.arguments).arguments
  const quoted = use.unused.map((position) => typed[position - 1]).filter((argument) => argument !== undefined).map((argument) => `"${truncate(flatten(argument), 40)}"`)
  const which = `${use.unused.length === 1 ? "argument" : "arguments"} ${use.unused.join(", ")}${quoted.length === use.unused.length ? ` (${quoted.join(", ")})` : ""}`
  return use.unused.length === 1 ? `${which} was not used: the command file has no place for it, so it is not in the text that was sent` : `${which} were not used: the command file has no place for them, so they are not in the text that was sent`
}
