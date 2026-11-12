/**
 * The directory walk of definition files: roots from the working directory
 * up to the repository root, then configured paths, then the user's
 * directory; `.md` files a few levels down; links only inside a root.
 * Internal to the module (not exported from `index.ts`); the commands module
 * keeps its own copy, since both are leaves.
 */
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { brand } from "../brand.ts"

export interface Root {
  readonly dir: string
  readonly scope: "project" | "config" | "user"
}

export function roots(input: { readonly cwd: string; readonly configDir: string; readonly extraPaths?: readonly string[] }, kind: string): Root[] {
  const cwd = resolve(input.cwd)
  const top = repositoryRoot(cwd) ?? cwd
  const project: Root[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const name of [`.${brand.directory}`, ".agents", ".claude"]) project.push({ dir: join(dir, name, kind), scope: "project" })
    if (dir === top || dirname(dir) === dir) break
  }
  const extra = (input.extraPaths ?? []).map((dir): Root => ({ dir: resolve(cwd, dir), scope: "config" }))
  const user: Root = { dir: join(resolve(input.configDir), kind), scope: "user" }
  const seen = new Set<string>()
  return [...project, ...extra, user].filter((root) => !seen.has(root.dir) && (seen.add(root.dir), true))
}

/** The `.md` files under `dir`, at most `maxDepth` levels down, in path order; links only when they stay inside `dir`. */
export function markdownFiles(dir: string, maxDepth: number, skip: (path: string, reason: string) => void): string[] {
  const realRoot = realpath(dir)
  if (realRoot === null || !isDirectory(realRoot)) return []
  const files: string[] = []
  const visited = new Set<string>()
  const walk = (current: string, depth: number) => {
    const real = realpath(current)
    if (real === null || visited.has(real)) return
    visited.add(real)
    for (const entry of listDirectory(current)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const path = join(current, entry.name)
      let target = path
      if (entry.isSymbolicLink()) {
        const resolved = realpath(path)
        if (resolved === null) {
          if (/\.md$/i.test(entry.name)) skip(path, "it cannot be read (a broken link?)")
          continue
        }
        if (!inside(resolved, realRoot)) {
          skip(path, `it is a link to ${resolved}, which is outside ${dir}; links are not followed out of the directory`)
          continue
        }
        target = resolved
      }
      if (isDirectory(target)) {
        if (depth < maxDepth) walk(path, depth + 1)
        continue
      }
      if (!/\.md$/i.test(entry.name) || entry.name.toLowerCase() === "readme.md") continue
      files.push(path)
    }
  }
  walk(dir, 1)
  return files
}

export function readBounded(file: string, maxBytes: number, what: string): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    const info = statSync(file)
    if (!info.isFile()) return { ok: false, reason: "it is not a file" }
    if (info.size > maxBytes) return { ok: false, reason: `it is ${info.size} bytes; ${what} may be at most ${maxBytes} bytes` }
    return { ok: true, text: readFileSync(file, "utf8") }
  } catch (error) {
    return { ok: false, reason: `it cannot be read: ${error instanceof Error ? error.message : String(error)}` }
  }
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
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep))
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

function repositoryRoot(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    try {
      lstatSync(join(current, ".git"))
      return current
    } catch {
      if (dirname(current) === current) return null
    }
  }
}

export function byCodeUnits(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}
