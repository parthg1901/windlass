/**
 * Where a path argument really points, decided without touching the file
 * system: the caller passes `readlink` (for example a wrapper of
 * `fs.readlinkSync` that returns null on any error), so the resolution is a
 * pure function of it and tests use a map.
 *
 * The path is first resolved the way the file tools resolve it
 * (`tools/common.ts` `resolvePath`: `~`, then `path.resolve` against the
 * working directory, which removes `..` lexically), because that string is
 * what the tool opens. The result is then resolved component by component
 * like the kernel does, following every symbolic link, including links in
 * parent directories and links whose targets contain `..`. Components that do
 * not exist are kept as they are, so a file a write would create resolves to
 * where it would be created.
 *
 * The check happens before the tool runs. A process running at the same time
 * (a sandboxed command, which can write the workspace) could replace a
 * directory with a link in between; see the README.
 */
import { join, posix, resolve } from "node:path"
import { brand } from "../brand.ts"

/** The target of a symbolic link, or null when `path` is not a link (or does not exist). */
export type Readlink = (path: string) => string | null

/**
 * - `workspace`: inside the workspace.
 * - `protected`: inside the workspace's `.git` directory or the harness's project directory
 *   (`.<brand.directory>`): writes there change what runs later outside the sandbox (hooks)
 *   or the harness's own settings.
 * - `outside`: anywhere else, or a path that could not be resolved (a link loop).
 * - `hidden`: inside a path the sandbox hides (credential stores, the harness's data).
 */
export type PathPlace = "workspace" | "protected" | "outside" | "hidden"

export interface PathFact {
  /** As the model gave it. */
  readonly given: string
  /** Absolute, with every link followed; null when resolution failed. */
  readonly real: string | null
  readonly place: PathPlace
  /** Relative to the real workspace with `/` separators, when `place` is `workspace` or `protected`. */
  readonly relative: string | null
}

export interface PathContext {
  /** The session's working directory (absolute). Relative paths resolve against it. */
  readonly cwd: string
  /** The workspace root (absolute; resolved through links here). */
  readonly workspace: string
  readonly home: string
  /** The sandbox policy's hidden paths (`defaultHiddenPaths()`), absolute. */
  readonly hiddenPaths: readonly string[]
  readonly readlink: Readlink
}

/** Links followed before giving up, as Linux does (ELOOP). */
export const MAX_LINKS = 40

/** Classifies one path argument. */
export function pathFact(given: string, context: PathContext): PathFact {
  const real = realPath(lexicalPath(context.cwd, given, context.home), context.readlink)
  if (real === null) return { given, real, place: "outside", relative: null }
  const workspace = realPath(context.workspace, context.readlink) ?? context.workspace
  const hidden = context.hiddenPaths.flatMap((path) => [path, realPath(path, context.readlink)]).filter((path) => path !== null)
  if (hidden.some((root) => isWithin(root, real))) return { given, real, place: "hidden", relative: null }
  if (!isWithin(workspace, real)) return { given, real, place: "outside", relative: null }
  const relative = posix.relative(workspace, real)
  return { given, real, place: protectedRoots(workspace).some((root) => isWithin(root, real)) ? "protected" : "workspace", relative }
}

/** The directories inside a workspace whose writes ask in `auto`. */
export function protectedRoots(workspace: string): string[] {
  return [join(workspace, ".git"), join(workspace, `.${brand.directory}`)]
}

/** What `resolvePath` in the file tools gives, with the home directory passed in. */
export function lexicalPath(cwd: string, path: string, home: string): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return join(home, path.slice(2))
  return resolve(cwd, path)
}

/** Resolves an absolute path through every symbolic link, component by component. Null after `MAX_LINKS` links. */
export function realPath(absolute: string, readlink: Readlink): string | null {
  let pending = absolute.split("/")
  let resolved: string[] = []
  let links = 0
  while (pending.length > 0) {
    const [part, ...rest] = pending as [string, ...string[]]
    pending = rest
    if (part === "" || part === ".") continue
    if (part === "..") {
      resolved = resolved.slice(0, -1)
      continue
    }
    const target = readlink(`/${[...resolved, part].join("/")}`)
    if (target === null) {
      resolved = [...resolved, part]
      continue
    }
    links += 1
    if (links > MAX_LINKS) return null
    if (target.startsWith("/")) resolved = []
    pending = [...target.split("/"), ...pending]
  }
  return `/${resolved.join("/")}`
}

/** Whether `path` is `root` or inside it. Both absolute and normalised. */
export function isWithin(root: string, path: string): boolean {
  if (root === "/") return true
  return path === root || path.startsWith(`${root}/`)
}
