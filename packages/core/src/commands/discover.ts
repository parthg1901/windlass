/**
 * Finds the slash commands of a working directory. A command is a Markdown
 * file whose body is a prompt template: `release-notes.md` is
 * `/release-notes`, `frontend/test.md` is `/frontend:test`.
 *
 *   ---
 *   description: Draft release notes for a version
 *   argument-hint: <version> [previous-version]
 *   ---
 *   Write the release notes for version $1 ...
 *
 * The front matter is optional (the skills module's parser reads it when the
 * file starts with `---`). Roots, highest precedence first, as for skills
 * and agents: `.<brand.directory>/commands`, `.agents/commands`,
 * `.claude/commands` in each directory from the working directory up to the
 * repository root; `commands.paths`; the user's `<config dir>/commands`. The
 * nearest definition of a name wins; the others are reported as shadowed.
 *
 * Nothing here throws for a bad file: it is skipped, with a reason for the
 * user. Constructs that other harnesses execute at expansion time (a command
 * in backticks after `!`, an `@path` include) are found here too and
 * reported: they are never executed (`expand.ts`).
 */
import { relative, sep } from "node:path"
import { fingerprint } from "../instructions/source.ts"
import { parseFrontMatter } from "../skills/frontmatter.ts"
import { type UnsupportedConstruct, findUnsupported } from "./expand.ts"
import { type Root, byCodeUnits, markdownFiles, readBounded, roots } from "./walk.ts"

/** Folder levels below a root: `test.md` is level 1, `frontend/test.md` level 2 (`/frontend:test`). */
export const MAX_COMMAND_DEPTH = 3
/** A template longer than this is skipped: it becomes a user message. */
export const MAX_COMMAND_BYTES = 64 * 1024
export const MAX_COMMAND_NAME_LENGTH = 64
/** A description taken from the template's first line is cut here. */
export const MAX_DERIVED_DESCRIPTION = 100

export type CommandRoot = Root

export interface CommandDefinition {
  /** Path segments below the root joined with `:`, without `.md`: `frontend:test`. */
  readonly name: string
  readonly description: string
  /** Whether `description` was taken from the template's first line (the file has none). */
  readonly derivedDescription: boolean
  /** What the arguments are, for a palette: `<version> [previous]`. `null`: none given. */
  readonly argumentHint: string | null
  /** The agent the command runs under (`agent:` in the front matter); resolved by the integrator. */
  readonly agent: string | null
  /** The prompt template: the file after its front matter, trimmed. */
  readonly template: string
  /** What `expandCommand` leaves as text and reports. */
  readonly unsupported: readonly UnsupportedConstruct[]
  /** SHA-256 of the file's text as read: which version of the command produced a message. */
  readonly fingerprint: string
  /** Absolute path of the file, as found. */
  readonly path: string
  readonly root: CommandRoot
}

export interface CommandProblem {
  readonly path: string
  /** `skipped`: not usable. `shadowed`: a nearer command, or a client's built-in, has the name. `warning`: usable, but something is off. */
  readonly severity: "skipped" | "shadowed" | "warning"
  readonly reason: string
  /** The command's name, when the file got as far as having one. */
  readonly name: string | null
}

export interface CommandSet {
  /** Sorted by name. */
  readonly commands: readonly CommandDefinition[]
  /** Sorted by path, then reason. */
  readonly problems: readonly CommandProblem[]
  readonly roots: readonly CommandRoot[]
}

export interface CommandDiscoveryInput {
  readonly cwd: string
  /** The harness config directory (`defaultConfigDir()` in `instructions/discover.ts`). */
  readonly configDir: string
  /** Extra roots (`commands.paths`, resolved), absolute. */
  readonly extraPaths?: readonly string[]
  /** Names to leave out (`commands.disabled`). */
  readonly disabled?: readonly string[]
}

export function commandRoots(input: CommandDiscoveryInput): CommandRoot[] {
  return roots(input, "commands")
}

export function discoverCommands(input: CommandDiscoveryInput): CommandSet {
  const found = commandRoots(input)
  const disabled = new Set(input.disabled ?? [])
  const problems: CommandProblem[] = []
  const byName = new Map<string, CommandDefinition>()
  for (const root of found) {
    const files = markdownFiles(root.dir, MAX_COMMAND_DEPTH, (path, reason) => problems.push({ path, severity: "skipped", name: null, reason }))
    for (const file of files) {
      const command = readCommand(file, root, problems)
      if (command === null || disabled.has(command.name)) continue
      const winner = byName.get(command.name)
      if (winner === undefined) byName.set(command.name, command)
      else problems.push({ path: command.path, severity: "shadowed", name: command.name, reason: `the command /${command.name} at ${winner.path} takes precedence` })
    }
  }
  return {
    commands: [...byName.values()].sort((a, b) => byCodeUnits(a.name, b.name)),
    problems: problems.sort((a, b) => byCodeUnits(a.path, b.path) || byCodeUnits(a.reason, b.reason)),
    roots: found,
  }
}

/** Keys of other harnesses' commands that would do something here if they were read. */
const NOT_READ: Readonly<Record<string, string>> = {
  "allowed-tools": "`allowed-tools` is not read here: a command cannot grant tools; name an `agent` whose restrictions fit instead",
  allowedTools: "`allowedTools` is not read here: a command cannot grant tools; name an `agent` whose restrictions fit instead",
  model: "`model` is not read here: a command does not change the session's model; name an `agent` that sets one instead",
  name: "`name` is not read here: a command's name is its file's path (`frontend/test.md` is /frontend:test)",
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function readCommand(file: string, root: CommandRoot, problems: CommandProblem[]): CommandDefinition | null {
  const segments = relative(root.dir, file).replace(/\.md$/i, "").split(sep)
  const name = segments.join(":")
  const skip = (reason: string, known: string | null = name) => {
    problems.push({ path: file, severity: "skipped", name: known, reason })
    return null
  }
  const bad = segments.find((segment) => !SEGMENT.test(segment))
  if (bad !== undefined) return skip(`its name ${JSON.stringify(bad)} (from the file's path) is not letters, digits, '-', '_' and '.', starting with a letter or digit`, null)
  if (name.length > MAX_COMMAND_NAME_LENGTH) return skip(`its name /${name} is longer than ${MAX_COMMAND_NAME_LENGTH} characters`)
  const read = readBounded(file, MAX_COMMAND_BYTES, "a command")
  if (!read.ok) return skip(read.reason)
  const text = read.text.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
  let fields: ReadonlyMap<string, string> = new Map()
  let template = text.trim()
  if (text.split("\n", 1)[0]!.trimEnd() === "---") {
    const parsed = parseFrontMatter(text)
    if (!parsed.ok) return skip(parsed.reason)
    fields = parsed.fields
    template = parsed.body
  }
  if (template === "") return skip("it has no prompt text after its front matter")
  const warn = (reason: string) => problems.push({ path: file, severity: "warning", name, reason })
  for (const key of Object.keys(NOT_READ)) if (fields.has(key)) warn(NOT_READ[key]!)
  const given = (fields.get("description") ?? "").replace(/\s+/g, " ").trim()
  const firstLine = template.split("\n").find((line) => line.trim() !== "")!.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim()
  const description = given !== "" ? given : cut(firstLine, MAX_DERIVED_DESCRIPTION)
  const hint = (fields.get("argument-hint") ?? fields.get("argumentHint") ?? "").replace(/\s+/g, " ").trim()
  const agent = (fields.get("agent") ?? "").trim()
  if (agent !== "" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) return skip(`its \`agent\` ${JSON.stringify(agent)} is not an agent's name`)
  const unsupported = findUnsupported(template)
  for (const construct of unsupported) warn(`line ${construct.line}: ${construct.text} is left as text: ${construct.reason}`)
  return {
    name,
    description,
    derivedDescription: given === "",
    argumentHint: hint === "" ? null : hint,
    agent: agent === "" ? null : agent,
    template,
    unsupported,
    fingerprint: fingerprint(text),
    path: file,
    root,
  }
}

function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`
}
