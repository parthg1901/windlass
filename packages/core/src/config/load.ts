/**
 * The impure half of loading: where the two files are, and reading them.
 *
 * - User file: `$XDG_CONFIG_HOME/<brand.directory>/config.json`, or
 *   `~/.config/<brand.directory>/config.json` when `XDG_CONFIG_HOME` is unset or
 *   not absolute (as the XDG spec says). The same path is used on macOS.
 * - Project file: `.<brand.directory>/config.json` in the working directory or
 *   the nearest parent that has one, up to and including the repository root
 *   (the nearest directory with a `.git` entry, which is a file in a worktree).
 *   Outside a repository only the working directory itself is looked at, so a
 *   stray file in a parent of an unrelated directory is never picked up.
 *
 * Both files are optional. Checks run in the project directory: the directory
 * that contains the project file, else the repository root, else the working directory.
 */
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { ApprovalSection } from "../approval/policy.ts"
import { brand } from "../brand.ts"
import { type Config, ConfigError, type ConfigFile, mergeConfigFiles, parseConfigFile, resolveConfig } from "./schema.ts"

export interface ConfigLocations {
  /** The user file's path, whether or not it exists. */
  readonly userFile: string
  /** The nearest project file, or `null` when there is none. */
  readonly projectFile: string | null
  /** Where checks run and changed paths are relative to. */
  readonly projectDir: string
}

export interface LoadedConfig extends ConfigLocations {
  readonly config: Config
  /** The files that existed and were read, user first. */
  readonly sources: readonly string[]
  /**
   * The `approval` section of each file as written, apart: the project's may
   * only tighten the user's (`resolveApprovalConfig`), so they are not merged here.
   */
  readonly approval: { readonly user: ApprovalSection | null; readonly project: ApprovalSection | null }
}

export interface LoadOptions {
  readonly cwd: string
  /** Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Default: `os.homedir()`. */
  readonly home?: string
}

/** Finds, reads, validates and merges both files. Throws `ConfigError` naming the file at fault. */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const locations = await findConfigFiles(options)
  const user = await readConfigFile(locations.userFile)
  const project = locations.projectFile === null ? null : await readConfigFile(locations.projectFile)
  return {
    ...locations,
    config: resolveConfig(mergeConfigFiles(user, project)),
    sources: [user === null ? null : locations.userFile, project === null ? null : locations.projectFile].filter((file) => file !== null),
    approval: { user: user?.approval ?? null, project: project?.approval ?? null },
  }
}

export async function findConfigFiles(options: LoadOptions): Promise<ConfigLocations> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const xdg = env.XDG_CONFIG_HOME
  const configHome = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config")
  const cwd = resolve(options.cwd)
  const repoRoot = await findRepositoryRoot(cwd)
  const projectFile = await findProjectFile(cwd, repoRoot)
  return {
    userFile: join(configHome, brand.directory, "config.json"),
    projectFile,
    projectDir: projectFile !== null ? dirname(dirname(projectFile)) : (repoRoot ?? cwd),
  }
}

/** Reads one file; `null` when it does not exist. */
export async function readConfigFile(path: string): Promise<ConfigFile | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const text = await file.text().catch((error: unknown) => {
    throw new ConfigError(path, "", `could not be read (${error instanceof Error ? error.message : String(error)})`)
  })
  return parseConfigFile(text, path)
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (await exists(join(dir, ".git"))) return dir
    if (dirname(dir) === dir) return null
  }
}

async function findProjectFile(cwd: string, repoRoot: string | null): Promise<string | null> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(dir, `.${brand.directory}`, "config.json")
    if (await Bun.file(candidate).exists()) return candidate
    if (repoRoot === null || dir === repoRoot || dirname(dir) === dir) return null
  }
}

/** Whether a path exists as a file or a directory (`Bun.file().exists()` is false for directories). */
function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}
