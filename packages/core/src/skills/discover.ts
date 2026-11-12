/**
 * Finds the skills of a working directory. A skill is a directory with a
 * `SKILL.md` (front matter with `name` and `description`, then the
 * instructions), possibly with supporting files next to it.
 *
 * Roots, highest precedence first:
 * 1. project directories, from the working directory up to the repository
 *    root (the nearest ancestor with a `.git` entry; outside a repository,
 *    the working directory alone, as for AGENTS.md). In each directory:
 *    `.<brand.directory>/skills`, then `.agents/skills`, then `.claude/skills`,
 *    so skills written for other harnesses work unchanged;
 * 2. extra directories from the configuration (`skills.paths`), in order;
 * 3. the user's `<config dir>/skills` (`$XDG_CONFIG_HOME/<brand.directory>/skills`).
 * The nearest definition of a name wins; the others are reported as shadowed.
 *
 * In a root, a skill directory is at most `MAX_DEPTH` levels down (so skills
 * can be grouped in folders). A directory with a `SKILL.md` is a skill and is
 * not searched further. Dot-directories and `node_modules` are not searched.
 * A symbolic link is followed only when its target is inside the root, so a
 * link cannot pull in files from elsewhere on the machine.
 *
 * Nothing here throws for a bad skill: it is skipped, with a reason for the user.
 */
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { brand } from "../brand.ts"
import { parseFrontMatter } from "./frontmatter.ts"

export const SKILL_FILE = "SKILL.md"
/** Levels below a root at which a skill directory may be. */
export const MAX_DEPTH = 3
/** A `SKILL.md` longer than this is skipped: it is loaded whole into the conversation. */
export const MAX_SKILL_BYTES = 256 * 1024
export const MAX_NAME_LENGTH = 64
export const MAX_DESCRIPTION_LENGTH = 1024

export interface SkillRoot {
  readonly dir: string
  readonly scope: "project" | "config" | "user"
}

export interface Skill {
  readonly name: string
  readonly description: string
  /** The instructions: the file after its front matter, trimmed. */
  readonly body: string
  /** Absolute path of the `SKILL.md`, as found (not resolved through links). */
  readonly path: string
  /** The skill's directory; supporting files are inside it. */
  readonly dir: string
  readonly root: SkillRoot
}

export interface SkillProblem {
  /** The `SKILL.md` or directory concerned. */
  readonly path: string
  /** `skipped`: not loaded. `shadowed`: a nearer skill has the name. `warning`: loaded, but something is off. */
  readonly severity: "skipped" | "shadowed" | "warning"
  readonly reason: string
}

export interface SkillSet {
  /** Sorted by name. */
  readonly skills: readonly Skill[]
  /** Sorted by path, then reason. */
  readonly problems: readonly SkillProblem[]
  readonly roots: readonly SkillRoot[]
}

export interface SkillDiscoveryInput {
  /** The session's working directory. */
  readonly cwd: string
  /** The harness config directory (`defaultConfigDir()` in `instructions/discover.ts`). */
  readonly configDir: string
  /** Extra roots (`skills.paths`), absolute. */
  readonly extraPaths?: readonly string[]
  /** Names to leave out (`skills.disabled`). */
  readonly disabled?: readonly string[]
}

/** The roots to search, highest precedence first. They need not exist. */
export function skillRoots(input: SkillDiscoveryInput): SkillRoot[] {
  const cwd = resolve(input.cwd)
  const top = repositoryRoot(cwd) ?? cwd
  const project: SkillRoot[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const name of [`.${brand.directory}`, ".agents", ".claude"]) project.push({ dir: join(dir, name, "skills"), scope: "project" })
    if (dir === top || dirname(dir) === dir) break
  }
  const extra = (input.extraPaths ?? []).map((dir): SkillRoot => ({ dir: resolve(cwd, dir), scope: "config" }))
  const user: SkillRoot = { dir: join(resolve(input.configDir), "skills"), scope: "user" }
  const seen = new Set<string>()
  return [...project, ...extra, user].filter((root) => !seen.has(root.dir) && (seen.add(root.dir), true))
}

export function discoverSkills(input: SkillDiscoveryInput): SkillSet {
  const roots = skillRoots(input)
  const disabled = new Set(input.disabled ?? [])
  const problems: SkillProblem[] = []
  const byName = new Map<string, Skill>()
  for (const root of roots) {
    for (const found of scanRoot(root, problems)) {
      if (disabled.has(found.name)) continue
      const winner = byName.get(found.name)
      if (winner === undefined) byName.set(found.name, found)
      else if (winner.root === root) problems.push({ path: found.path, severity: "skipped", reason: `another skill in the same directory is named "${found.name}" (${winner.path})` })
      else problems.push({ path: found.path, severity: "shadowed", reason: `the skill "${found.name}" at ${winner.path} takes precedence` })
    }
  }
  return {
    skills: [...byName.values()].sort((a, b) => byCodeUnits(a.name, b.name)),
    problems: problems.sort((a, b) => byCodeUnits(a.path, b.path) || byCodeUnits(a.reason, b.reason)),
    roots,
  }
}

/** The skills of one root, in path order. */
function scanRoot(root: SkillRoot, problems: SkillProblem[]): Skill[] {
  const realRoot = realpath(root.dir)
  if (realRoot === null || !isDirectory(realRoot)) return []
  const skills: Skill[] = []
  const visited = new Set<string>()
  const walk = (dir: string, depth: number) => {
    const real = realpath(dir)
    if (real === null || visited.has(real)) return
    visited.add(real)
    for (const entry of listDirectory(dir)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const path = join(dir, entry.name)
      const target = entry.isSymbolicLink() ? followInside(path, realRoot, problems) : path
      if (target === null || !isDirectory(target)) continue
      const file = join(path, SKILL_FILE)
      if (exists(file)) {
        const skill = readSkill(file, path, root, realRoot, problems)
        if (skill !== null) skills.push(skill)
        continue
      }
      if (depth < MAX_DEPTH) walk(path, depth + 1)
    }
  }
  walk(root.dir, 1)
  return skills
}

function readSkill(file: string, dir: string, root: SkillRoot, realRoot: string, problems: SkillProblem[]): Skill | null {
  const skip = (reason: string) => {
    problems.push({ path: file, severity: "skipped", reason })
    return null
  }
  const real = realpath(file)
  if (real === null) return skip("it cannot be read (a broken link?)")
  if (!inside(real, realRoot)) return skip(`it is a link to ${real}, which is outside ${root.dir}; links are not followed out of a skills directory`)
  let text: string
  try {
    const info = statSync(real)
    if (!info.isFile()) return skip(`${SKILL_FILE} is not a file`)
    if (info.size > MAX_SKILL_BYTES) return skip(`it is ${info.size} bytes; a skill may be at most ${MAX_SKILL_BYTES} bytes`)
    text = readFileSync(real, "utf8")
  } catch (error) {
    return skip(`it cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = parseFrontMatter(text)
  if (!parsed.ok) return skip(parsed.reason)
  const folder = dir.split(sep).pop()!
  const name = (parsed.fields.get("name") ?? "").trim() || folder
  if (name.length > MAX_NAME_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return skip(`its name ${JSON.stringify(name)} is not a name of letters, digits, '-', '_' and '.' of at most ${MAX_NAME_LENGTH} characters`)
  const description = (parsed.fields.get("description") ?? "").replace(/\s+/g, " ").trim()
  if (description === "") return skip("its front matter has no `description`, which is how the model knows when to use it")
  const warn = (reason: string) => problems.push({ path: file, severity: "warning", reason })
  if (!parsed.fields.has("name")) warn(`it has no \`name\`; the directory name "${folder}" is used`)
  else if (name !== folder) warn(`its name "${name}" differs from its directory name "${folder}"`)
  if (description.length > MAX_DESCRIPTION_LENGTH) warn(`its description is ${description.length} characters; the list of skills shows only the start`)
  if (parsed.body === "") warn("it has no instructions after the front matter")
  return { name, description, body: parsed.body, path: file, dir, root }
}

export interface SupportingFiles {
  /** Absolute paths, sorted. */
  readonly files: readonly string[]
  /** Files not listed because of the limit. */
  readonly omitted: number
}

const MAX_SUPPORTING_FILES = 100
const MAX_SUPPORTING_DEPTH = 4

/** The files next to a skill's `SKILL.md`, through links only when they stay inside the skill's directory. */
export function supportingFiles(skill: Skill): SupportingFiles {
  const realDir = realpath(skill.dir)
  if (realDir === null) return { files: [], omitted: 0 }
  const files: string[] = []
  let total = 0
  const visited = new Set<string>()
  const walk = (dir: string, depth: number) => {
    const real = realpath(dir)
    if (real === null || visited.has(real)) return
    visited.add(real)
    for (const entry of listDirectory(dir)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const path = join(dir, entry.name)
      if (dir === skill.dir && entry.name === SKILL_FILE) continue
      const target = entry.isSymbolicLink() ? followInside(path, realDir, null) : path
      if (target === null) continue
      if (isDirectory(target)) {
        if (depth < MAX_SUPPORTING_DEPTH) walk(path, depth + 1)
        continue
      }
      total += 1
      if (files.length < MAX_SUPPORTING_FILES) files.push(path)
    }
  }
  walk(skill.dir, 1)
  return { files: files.sort(byCodeUnits), omitted: total - files.length }
}

/** The target of a link when it is inside `boundary`, else `null` (and a problem, when `problems` is given). */
function followInside(path: string, boundary: string, problems: SkillProblem[] | null): string | null {
  const real = realpath(path)
  if (real === null) return null
  if (inside(real, boundary)) return real
  problems?.push({ path, severity: "skipped", reason: `it is a link to ${real}, which is outside ${boundary}; links are not followed out of a skills directory` })
  return null
}

function listDirectory(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodeUnits(a.name, b.name))
  } catch {
    return []
  }
}

function inside(path: string, boundary: string) {
  const rel = relative(boundary, path)
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..")
}

function realpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether the entry exists, a dangling link included (`readSkill` reports one). */
function exists(path: string) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function repositoryRoot(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (exists(join(current, ".git"))) return current
    if (dirname(current) === current) return null
  }
}


export function byCodeUnits(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}
