/**
 * The interactive CLI's slash commands: what an entry that starts with `/`
 * is, before anything is sent to the agent.
 *
 * An entry whose first word is `/<name>` (letters, digits, `-`, no second
 * `/`) is a command. A name no source knows is not sent: it would cost a
 * model request and title a new session "/<name>". The user is told it is
 * not a command, given the nearest one, and told how to send a message that
 * really starts with a slash: begin it with two (`//help` sends `/help`). An
 * entry whose first word has another slash (`/etc/hosts is wrong`) is a path
 * and goes to the agent as typed.
 *
 * Commands come from sources, looked up in order: the CLI's own first, then
 * whatever else is passed (user-defined commands, once there are any; such a
 * source lists its commands in the same shape and the caller runs them).
 */
import { nearest } from "./text.ts"

export interface SlashCommand {
  readonly name: string
  /** What follows the name, for the help (`<message>`, `[ask|auto|full]`). */
  readonly args: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** `idle`: at the prompt only; `working`: while the agent works only; `any`: both. */
  readonly when: "idle" | "working" | "any"
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
    { name: "approval", args: "[ask|auto|full]", description: "say the approval mode, or switch it from the next tool call", aliases: ["mode"], when: "any" },
    { name: "clear-taint", args: "", description: "say you trust the untrusted content in this conversation", when: "any" },
    { name: "queue", args: "<message>", description: "while the agent works: hold a message until the turn is done", when: "any" },
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
  const match = /^\/([A-Za-z][\w-]*)(?=\s|$)([\s\S]*)$/.exec(trimmed)
  if (match === null) return { kind: "message", text: entry }
  const name = match[1]!.toLowerCase()
  const rest = match[2]!.trim()
  for (const source of sources)
    for (const command of source.commands()) if (command.name === name || command.aliases?.includes(name)) return { kind: "command", command, source, rest }
  const names = sources.flatMap((source) => source.commands().flatMap((command) => [command.name, ...(command.aliases ?? [])]))
  return { kind: "unknown", name, suggestion: nearest(name, names) }
}

/** What the user is told about an unknown command, in one sentence. */
export function unknownCommandText(found: Extract<Lookup, { kind: "unknown" }>): string {
  const instead = found.suggestion === null ? "/help lists the commands" : `did you mean /${found.suggestion}? (/help lists them)`
  return `/${found.name} is not a command, so nothing was sent; ${instead}. To send a message that starts with a slash, begin it with two: //${found.name}`
}

/** The help: every command with what it does, then the keys. */
export function helpLines(sources: readonly CommandSource[] = [BUILTIN_COMMANDS]): string[] {
  const lines: string[] = []
  for (const source of sources) {
    const commands = source.commands()
    if (commands.length === 0) continue
    lines.push(`${source.label}:`)
    const labels = commands.map((command) => `/${command.name}${command.args === "" ? "" : ` ${command.args}`}${command.aliases === undefined ? "" : ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})`}`)
    const width = Math.max(...labels.map((label) => label.length))
    commands.forEach((command, index) => lines.push(`  ${labels[index]!.padEnd(width)}  ${command.description}${command.when === "idle" ? " (while the agent is idle)" : ""}`))
  }
  lines.push(
    "Keys:",
    "  Enter sends; Alt-Enter or a trailing \\ starts a new line; Up and Down recall earlier entries.",
    "  Ctrl-C stops the agent while it works (twice within 2 s exits), and clears the entry at the prompt.",
    "  Ctrl-D on an empty prompt leaves.",
    "  A message that starts with a slash: begin it with two (//etc sends /etc).",
  )
  return lines
}
