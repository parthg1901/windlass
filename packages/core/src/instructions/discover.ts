/**
 * Discovery: reads the instruction sources as they are right now.
 *
 * This is the only impure module of the instructions directory. It reads the
 * filesystem and the clock, and both are injected: the directories to look in
 * and the `now` function are parameters, so a test runs it against a
 * temporary tree with a fixed time. Everything it returns is plain data for
 * the pure modules (`baseline.ts`, `state.ts`).
 *
 * AGENTS.md files, in the order the model reads them (later takes precedence):
 * 1. the user-level file, `<configDir>/AGENTS.md`;
 * 2. the files from the repository root down to the working directory, and in
 *    any further directory the session has worked in, an ancestor always
 *    before its descendants, so the nearest file comes last.
 *
 * The repository root is the nearest ancestor of the working directory that
 * has a `.git` entry. Outside a repository only the working directory itself
 * is searched: walking up to the filesystem root would pick up files that
 * have nothing to do with the project.
 */
import { brand } from "../brand.ts"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { type InstructionSource, agentsSource, dateSource, environmentSource } from "./source.ts"

export const AGENTS_FILE = "AGENTS.md"

/** Longer files are cut here, with a line saying so. An instructions file is read on every request of a session. */
export const MAX_AGENTS_CHARS = 32_768

export interface DiscoveryInput {
  /** Absolute working directory of the session. */
  readonly cwd: string
  /** The harness config directory; see `defaultConfigDir`. */
  readonly configDir: string
  /** `process.platform` in production. */
  readonly platform: string
  /** The clock. The date is taken in the machine's local time zone. */
  readonly now: () => Date
  /**
   * Further directories the session has worked in (where a tool read or wrote
   * a file). Those inside the repository contribute their AGENTS.md files too.
   */
  readonly directories?: readonly string[]
  /**
   * AGENTS.md paths the model already has (`knownAgentsFiles`). They are read
   * again wherever they are, so that an edit or a removal is noticed.
   */
  readonly known?: readonly string[]
}

/** The harness config directory: `$XDG_CONFIG_HOME/<brand.directory>`, by default `~/.config/<brand.directory>`. */
export function defaultConfigDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), brand.directory)
}

/** The current instruction sources: AGENTS.md files, then the environment block, then the date. */
export function discoverSources(input: DiscoveryInput): InstructionSource[] {
  const cwd = resolve(input.cwd)
  const root = repositoryRoot(cwd)
  const boundary = root ?? cwd
  const within = boundary.endsWith(sep) ? boundary : boundary + sep
  const directories = [cwd, ...(input.directories ?? []).map((directory) => resolve(cwd, directory))]
    .filter((directory) => directory === boundary || directory.startsWith(within))
    .flatMap((directory) => descent(boundary, directory))
  const found = [...directories.map((directory) => join(directory, AGENTS_FILE)), ...(input.known ?? [])].sort(
    (a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
  const agents = [...new Set([join(resolve(input.configDir), AGENTS_FILE), ...found])].flatMap((path) => {
    const source = path.includes("\n") ? null : readAgents(path)
    return source === null ? [] : [source]
  })
  const now = input.now()
  return [
    ...agents,
    environmentSource({ cwd, platform: input.platform, gitRepository: root !== null }),
    dateSource(now.getFullYear(), now.getMonth() + 1, now.getDate()),
  ]
}

/** The nearest ancestor of `directory` (or itself) that contains a `.git` entry, which is a file in a linked worktree. */
function repositoryRoot(directory: string): string | null {
  if (existsSync(join(directory, ".git"))) return directory
  const parent = dirname(directory)
  return parent === directory ? null : repositoryRoot(parent)
}

/** The directories from `top` down to `directory`, both included. `directory` is `top` or inside it. */
function descent(top: string, directory: string): string[] {
  return directory === top ? [top] : [...descent(top, dirname(directory)), directory]
}

function depth(path: string) {
  return path.split(sep).length
}

/** Reads one AGENTS.md. A missing, unreadable or blank file is no source. */
function readAgents(path: string): InstructionSource | null {
  let content: string
  try {
    if (!statSync(path).isFile()) return null
    content = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const source = agentsSource(path, content)
  if (source.value === "") return null
  if (source.value.length <= MAX_AGENTS_CHARS) return source
  // Cut on a whole character: a lone surrogate half would not survive UTF-8.
  const end = /[\uD800-\uDBFF]/.test(source.value[MAX_AGENTS_CHARS - 1]!) ? MAX_AGENTS_CHARS - 1 : MAX_AGENTS_CHARS
  return {
    key: source.key,
    value: `${source.value.slice(0, end).trimEnd()}\n\n[The rest of this file was left out: it is longer than ${MAX_AGENTS_CHARS} characters.]`,
  }
}
