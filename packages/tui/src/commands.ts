/** The slash commands, and completion for a partly typed one: the interface's own, then the user's and the project's command files. */
import type { CommandsResult } from "@windlass/acp/extensions"

export interface CommandSpec {
  readonly name: string
  /** What follows the name, for the palette (`<message>`). */
  readonly args: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** A command file's (its text is sent as the user's message): the file, and where it comes from. */
  readonly file?: { readonly path: string; readonly scope: "project" | "config" | "user"; readonly agent: string | null }
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "undo", args: "", description: "go back to before your last message: files and conversation" },
  { name: "redo", args: "", description: "bring back what the last /undo took away" },
  { name: "sessions", args: "", description: "switch to or resume another session in this directory" },
  { name: "model", args: "", description: "choose the model and its reasoning effort" },
  { name: "new", args: "", description: "start a new session" },
  { name: "fork", args: "[<turn>] [copy]", description: "continue in a new session with this conversation so far, or up to a turn (the number on its ending row); copy: in a copy of the workspace" },
  { name: "agent", args: "[name|none]", description: "choose the agent this session runs as: its instructions and what it may do", aliases: ["agents"] },
  { name: "compact", args: "", description: "compact the conversation now: the older part becomes a checkpoint" },
  { name: "approval", args: "[ask|auto|full]", description: "when tool calls ask before they run", aliases: ["mode"] },
  { name: "clear-taint", args: "", description: "say you trust the untrusted content in the conversation" },
  { name: "diff", args: "", description: "per-file diffs of the selected step or turn (the latest by default)" },
  { name: "mcp", args: "[approve <server>]", description: "the MCP servers: state, tools, where each is defined; approve one the project names" },
  { name: "hooks", args: "[approve <hook>]", description: "the hooks: when each runs, its command, its state, where it is defined; approve one the project names" },
  { name: "lsp", args: "[approve <server>]", description: "the language servers that add diagnostics to edits: state, the files each serves, where it is defined; approve one the project names", aliases: ["diagnostics"] },
  { name: "skills", args: "", description: "the skills the model can load here, and the ones that could not be loaded" },
  { name: "wakeups", args: "[add <what>|cancel <id>|secret <id>]", description: "this session's wake-ups; add one of your own (/wakeups add shows the forms), cancel one, or show a webhook's secret", aliases: ["wake"] },
  { name: "watch", args: "[<command id> <text> | remove <watch id>]", description: "tell the agent when a background command prints a line with that text; with nothing, the running commands and their watches", aliases: ["watches"] },
  { name: "memory", args: "[confirm|reject|renew|forget <id>]", description: "the notes later sessions are given, and the ones waiting for your confirmation" },
  { name: "remember", args: "[--me] <text>", description: "save a note for later sessions (this project; --me: about you, everywhere)" },
  { name: "forget", args: "<id>", description: "retract a note: no later session is given it" },
  { name: "rename", args: "<title>", description: "give the session a title" },
  { name: "queue", args: "<message>", description: "hold a message until the running turn is done" },
  { name: "stop", args: "", description: "stop the selected running tool call (or the only one running) and let the turn go on (Ctrl-X)" },
  { name: "panel", args: "", description: "show or hide the session panel (Ctrl-P)" },
  { name: "debug", args: "", description: "show or hide events this client does not know" },
  { name: "reconnect", args: "", description: "start the engine again and reopen this session" },
  { name: "help", args: "", description: "keys and commands" },
  { name: "quit", args: "", description: "leave (running work stops as a shutdown and resumes later)", aliases: ["exit"] },
]

export interface ParsedCommand {
  readonly spec: CommandSpec | null
  readonly name: string
  readonly rest: string
}

/**
 * The command an entry is, or `null` when it is a message. A name is letters,
 * digits, `-`, `_`, `.`, and `:` between a folder and a file (`/frontend:test`),
 * as the engine reads one. `spec` is the interface's own command of that name;
 * `null` for any other name (a command file's, or none: `name` is as typed) and
 * for a lone `/`.
 */
export function parseCommand(entry: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)?(?:\s+([\s\S]*))?$/.exec(entry.trim())
  if (match === null) return null
  const typed = match[1] ?? ""
  const name = typed.toLowerCase()
  const spec = COMMANDS.find((command) => command.name === name || command.aliases?.includes(name)) ?? null
  return { spec, name: spec === null ? typed : name, rest: (match[2] ?? "").trim() }
}

/** The interface's own commands as the engine takes them: a file of one of these names is hidden, and their names count for a did-you-mean. */
export const CLIENT_COMMANDS = COMMANDS.map((command) => ({ name: command.name, ...(command.aliases === undefined ? {} : { aliases: command.aliases }) }))

/** The command files a session has, as commands: the ones a command of the interface's own does not hide. */
export function fileCommands(listing: CommandsResult): CommandSpec[] {
  return listing.commands.filter((command) => command.hiddenBy === null).map((command) => ({ name: command.name, args: command.argumentHint ?? "", description: command.description, file: { path: command.path, scope: command.scope, agent: command.agent } }))
}

/** The command file an entry names: as typed first (two files may differ only in case), then whatever the case. */
export function findFileCommand(files: readonly CommandSpec[], name: string): CommandSpec | null {
  return files.find((command) => command.name === name) ?? files.find((command) => command.name.toLowerCase() === name.toLowerCase()) ?? null
}

/**
 * The commands a partly typed entry could be: only while the entry is a
 * single line that starts with `/` and has no space yet. `available` filters
 * out commands the session cannot run (no undo in a demo, no compaction when
 * the server does not offer it). The command files (`files`) come after the
 * interface's own.
 */
export function complete(entry: string, available: (spec: CommandSpec) => boolean, files: readonly CommandSpec[] = []): CommandSpec[] {
  if (!/^\/[A-Za-z0-9._:-]*$/.test(entry)) return []
  const typed = entry.slice(1).toLowerCase()
  return [
    ...COMMANDS.filter((command) => available(command) && (command.name.startsWith(typed) || (command.aliases ?? []).some((alias) => alias.startsWith(typed)))),
    ...files.filter((command) => command.name.toLowerCase().startsWith(typed)),
  ]
}
