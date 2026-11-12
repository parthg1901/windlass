/** The slash commands, and completion for a partly typed one. */

export interface CommandSpec {
  readonly name: string
  /** What follows the name, for the palette (`<message>`). */
  readonly args: string
  readonly description: string
  readonly aliases?: readonly string[]
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
  { name: "skills", args: "", description: "the skills the model can load here, and the ones that could not be loaded" },
  { name: "wakeups", args: "[cancel|secret <id>]", description: "this session's wake-ups; cancel one, or show a webhook's secret", aliases: ["wake"] },
  { name: "memory", args: "[confirm|reject|renew|forget <id>]", description: "the notes later sessions are given, and the ones waiting for your confirmation" },
  { name: "remember", args: "[--me] <text>", description: "save a note for later sessions (this project; --me: about you, everywhere)" },
  { name: "forget", args: "<id>", description: "retract a note: no later session is given it" },
  { name: "rename", args: "<title>", description: "give the session a title" },
  { name: "queue", args: "<message>", description: "hold a message until the running turn is done" },
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

/** The command an entry is, or `null` when it is a message. A lone `/` or an unknown name is an unknown command. */
export function parseCommand(entry: string): ParsedCommand | null {
  const match = /^\/([a-z-]*)(?:\s+([\s\S]*))?$/i.exec(entry.trim())
  if (match === null) return null
  const name = match[1]!.toLowerCase()
  const spec = COMMANDS.find((command) => command.name === name || command.aliases?.includes(name)) ?? null
  return { spec, name, rest: (match[2] ?? "").trim() }
}

/**
 * The commands a partly typed entry could be: only while the entry is a
 * single line that starts with `/` and has no space yet. `available` filters
 * out commands the session cannot run (no undo in a demo, no compaction when
 * the server does not offer it).
 */
export function complete(entry: string, available: (spec: CommandSpec) => boolean): CommandSpec[] {
  if (!/^\/[a-z-]*$/i.test(entry)) return []
  const typed = entry.slice(1).toLowerCase()
  return COMMANDS.filter((command) => available(command) && (command.name.startsWith(typed) || (command.aliases ?? []).some((alias) => alias.startsWith(typed))))
}
