/**
 * What a client needs to offer commands: reading a typed entry, finding the
 * command with a did-you-mean for a typo, and a listing.
 *
 * The lookup order for an entry that starts with `/`:
 * 1. the client's own built-in commands (and their aliases): a built-in
 *    always wins, and a command file with its name is listed as hidden;
 * 2. the commands found by `discoverCommands`;
 * 3. otherwise it is an unknown command: not sent, and the user is told the
 *    close names. An entry that starts with `//` is text: sent with one `/`
 *    taken off. An entry whose first word is not a command name at all
 *    (`/usr/bin/env is missing`) is text too.
 */
import type { CommandDefinition, CommandProblem, CommandSet } from "./discover.ts"
import { type Expansion, expandTemplate } from "./expand.ts"
import { byCodeUnits } from "./walk.ts"

/** A client's own command, as `packages/tui/src/commands.ts` lists them. */
export interface BuiltinCommand {
  readonly name: string
  readonly aliases?: readonly string[]
}

export type SlashEntry =
  /** A command name and what follows it. `name` is empty for a lone `/`. */
  | { readonly kind: "command"; readonly name: string; readonly args: string }
  /** Text that starts with `/` on purpose: `//etc is odd` is sent as `/etc is odd`. */
  | { readonly kind: "text"; readonly text: string }

/** What a typed entry is, or `null` when it is an ordinary message. */
export function parseSlash(entry: string): SlashEntry | null {
  const trimmed = entry.trim()
  if (!trimmed.startsWith("/")) return null
  if (trimmed.startsWith("//")) return { kind: "text", text: trimmed.slice(1) }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._:-]*)?(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match === null) return null
  return { kind: "command", name: match[1] ?? "", args: (match[2] ?? "").trim() }
}

export type CommandLookup =
  | { readonly kind: "builtin"; readonly name: string }
  | { readonly kind: "command"; readonly command: CommandDefinition }
  /** A file with that name exists but could not be used. */
  | { readonly kind: "broken"; readonly name: string; readonly message: string }
  | { readonly kind: "unknown"; readonly name: string; readonly suggestions: readonly string[]; readonly message: string }

/** Finds a typed name: built-ins first, then commands, exactly and then ignoring case. */
export function lookupCommand(set: CommandSet, typed: string, builtins: readonly BuiltinCommand[] = []): CommandLookup {
  const name = typed.replace(/^\//, "").trim()
  const lower = name.toLowerCase()
  const builtin = builtins.find((b) => b.name.toLowerCase() === lower || (b.aliases ?? []).some((alias) => alias.toLowerCase() === lower))
  if (builtin !== undefined) return { kind: "builtin", name: builtin.name }
  const command = set.commands.find((c) => c.name === name) ?? set.commands.find((c) => c.name.toLowerCase() === lower)
  if (command !== undefined) return { kind: "command", command }
  const broken = set.problems.find((p) => p.severity === "skipped" && p.name !== null && p.name.toLowerCase() === lower)
  if (broken !== undefined) return { kind: "broken", name, message: `The command /${broken.name} (${broken.path}) cannot be used: ${broken.reason}.` }
  const names = [...builtins.map((b) => b.name), ...set.commands.map((c) => c.name)]
  const suggestions = name === "" ? [] : closeNames(name, names)
  const head = name === "" ? "Type a command's name after the /." : `There is no command /${name}.`
  const hint = suggestions.length > 0 ? ` Did you mean ${suggestions.map((s) => `/${s}`).join(" or ")}?` : ""
  return { kind: "unknown", name, suggestions, message: `${head}${hint} To send it to the model as text, start it with //.` }
}

/** Expands a found command with what was typed after it. */
export function expandCommand(command: Pick<CommandDefinition, "template">, args: string): Expansion {
  return expandTemplate(command.template, args)
}

export interface ListedCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint: string | null
  readonly agent: string | null
  readonly path: string
  readonly scope: CommandDefinition["root"]["scope"]
  /** The built-in that takes the name, when one does: the command cannot be run as `/<name>`. */
  readonly hiddenBy: string | null
}

export interface CommandListing {
  /** Usable and hidden commands, sorted by name. */
  readonly commands: readonly ListedCommand[]
  /** The set's problems plus one `shadowed` entry per command a built-in hides, sorted by path. */
  readonly problems: readonly CommandProblem[]
}

/** The listing a client shows for `/commands` or in its palette. */
export function listCommands(set: CommandSet, builtins: readonly BuiltinCommand[] = []): CommandListing {
  const taken = new Map<string, string>()
  for (const b of builtins) for (const name of [b.name, ...(b.aliases ?? [])]) taken.set(name.toLowerCase(), b.name)
  const commands = set.commands.map((c): ListedCommand => ({
    name: c.name,
    description: c.description,
    argumentHint: c.argumentHint,
    agent: c.agent,
    path: c.path,
    scope: c.root.scope,
    hiddenBy: taken.get(c.name.toLowerCase()) ?? null,
  }))
  const hidden = commands
    .filter((c) => c.hiddenBy !== null)
    .map((c): CommandProblem => ({ path: c.path, severity: "shadowed", name: c.name, reason: `the client's built-in /${c.hiddenBy} takes the name /${c.name}; rename the file to use it` }))
  return {
    commands,
    problems: [...set.problems, ...hidden].sort((a, b) => byCodeUnits(a.path, b.path) || byCodeUnits(a.reason, b.reason)),
  }
}

/** Close names, by edit distance, prefix or containment, at most three. */
function closeNames(name: string, names: readonly string[]): string[] {
  const lower = name.toLowerCase()
  return [...new Set(names)]
    .map((candidate) => ({ name: candidate, distance: distance(lower, candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(entry.name.length / 3)) || entry.name.toLowerCase().includes(lower) || lower.includes(entry.name.toLowerCase()))
    .sort((a, b) => a.distance - b.distance || byCodeUnits(a.name, b.name))
    .slice(0, 3)
    .map((entry) => entry.name)
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]!
}
