/**
 * Slash commands, as the engine offers them to its clients (`commands/` has
 * the module).
 *
 * - A command is the user's side of the conversation: a Markdown file whose
 *   template, with what the user typed put in, is sent as the user's
 *   message. The model is never told which commands exist, no tool is added
 *   for them and nothing of them is in a request's prefix.
 * - Expansion is a pure function of the file's text and the typed
 *   arguments. What other harnesses run or read at that moment (a command in
 *   backticks after `!`, an `@path`) stays in the text as written and is
 *   reported to the user: with the expansion, and in the record.
 * - The message a command produced is admitted like any prompt, and
 *   `command.expanded` is written in the same append: which file, which
 *   version of it (its fingerprint), the arguments, what was missing, which
 *   arguments the template had no place for, and what was left as text. The expanded text is stored once, as the
 *   message's content.
 *
 * The session's configuration decides where command files are looked for
 * besides the working directory (`commands.paths`) and which names are left
 * out (`commands.disabled`); both files are read for both.
 */
import { type CommandsConfig, resolveCommandsConfig } from "../commands/config.ts"
import { type CommandDefinition, type CommandSet, discoverCommands } from "../commands/discover.ts"
import type { Expansion } from "../commands/expand.ts"
import { type BuiltinCommand, type CommandLookup, expandCommand, lookupCommand } from "../commands/lookup.ts"
import type { CommandUse } from "../event/durable.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to offer slash commands. */
export interface CommandsSetup {
  /**
   * The harness config directory, whose `commands` directory holds the
   * user's own. Default: the engine's (`$XDG_CONFIG_HOME/<brand.directory>`);
   * with `EngineOptions.discover` injected, none, so that an engine whose
   * instruction sources a test supplies reads nothing of this machine's.
   */
  readonly configDir?: string
  /** The home directory `~/` in `commands.paths` stands for. Default: the user's. */
  readonly home?: string
}

/** Where a session's commands are looked for besides its working directory, and which names are left out. */
export interface CommandPlaces extends CommandsConfig {
  readonly configDir: string
}

/** The project's extra directories first, then the user's, as for agents; a name either file leaves out is left out. */
export function commandPlaces(files: ConfigFiles | null, setup: Required<Pick<CommandsSetup, "configDir">> & Pick<CommandsSetup, "home">): CommandPlaces {
  const user = files?.user?.commands
  const project = files?.project?.commands
  const section = { paths: [...new Set([...(project?.paths ?? []), ...(user?.paths ?? [])])], disabled: [...new Set([...(user?.disabled ?? []), ...(project?.disabled ?? [])])] }
  const resolved = resolveCommandsConfig(section, setup.home)
  return { paths: [...new Set(resolved.paths)], disabled: resolved.disabled, configDir: setup.configDir }
}

/** The commands of a working directory as they are now. Never throws: a place that cannot be read holds no commands. */
export function findCommands(cwd: string, places: CommandPlaces): CommandSet {
  try {
    return discoverCommands({ cwd, configDir: places.configDir, extraPaths: places.paths, disabled: places.disabled })
  } catch (error) {
    return { commands: [], problems: [{ path: cwd, severity: "skipped", reason: `the commands could not be looked for: ${error instanceof Error ? error.message : String(error)}`, name: null }], roots: [] }
  }
}

/**
 * A typed name looked up and, when it is a command file's, expanded with
 * what was typed after it: what a palette previews, and what `sendCommand`
 * sends. Nothing is sent by looking.
 */
export type CommandExpansion =
  /** The command and its expansion: `expansion.text` is the message, `missing`, `unused`, `unsupported` and `notes` are for the user. */
  | { readonly kind: "command"; readonly command: CommandDefinition; readonly expansion: Expansion }
  /** A command of the client's own takes the name; the client runs it. */
  | Extract<CommandLookup, { kind: "builtin" }>
  /** A file with that name exists and cannot be used; `message` says why. */
  | Extract<CommandLookup, { kind: "broken" }>
  /** No such command; `message` says so, with the close names, and how to send the text as it is. */
  | Extract<CommandLookup, { kind: "unknown" }>

export function expandNamed(set: CommandSet, name: string, args: string, builtins: readonly BuiltinCommand[] = []): CommandExpansion {
  const found = lookupCommand(set, name, builtins)
  return found.kind === "command" ? { kind: "command", command: found.command, expansion: expandCommand(found.command, args) } : found
}

/** What the log keeps about a message a command produced (`command.expanded`). */
export function commandUseOf(command: CommandDefinition, expansion: Expansion): CommandUse {
  return {
    name: command.name,
    path: command.path,
    scope: command.root.scope,
    fingerprint: command.fingerprint,
    arguments: expansion.raw,
    missing: [...expansion.missing],
    unused: [...expansion.unused],
    unsupported: expansion.unsupported.map((construct) => ({ kind: construct.kind, text: construct.text, line: construct.line })),
  }
}

/** What `EngineSession.sendCommand` returns: the message that was admitted, the command it came from, and what expansion reported. */
export interface SentCommand {
  readonly command: CommandDefinition
  readonly expansion: Expansion
}
