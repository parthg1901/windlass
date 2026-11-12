/**
 * Which hooks apply to a call. Pure.
 *
 * A tool pattern is a name in which `*` matches any run of characters (`*`, `mcp__*`, `history_*`); nothing
 * else is special. Path patterns are Bun.Glob patterns, as the checks' `when`, matched against the paths the
 * call names relative to the working directory with `/` separators (`Tool.touches`, resolved by the caller). A
 * hook with path patterns applies when any of the call's paths matches one; a call that names no path (a shell
 * command) never matches such a hook. A path outside the working directory is matched as its absolute path:
 * a pattern that starts with `**\/` reaches it (`**\/.env` guards every `.env`), one that names a directory of
 * the workspace (`src/**`) does not.
 */
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Hook } from "./config.ts"

export interface CallTarget {
  readonly tool: string
  /** The paths the call names (absolute, or relative to `cwd`), or `null` when the tool names none. */
  readonly paths: readonly string[] | null
  readonly cwd: string
}

export function toolMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name
  const parts = pattern.split("*")
  const first = parts[0]!
  const last = parts[parts.length - 1]!
  if (!name.startsWith(first) || name.length < first.length + last.length || !name.endsWith(last)) return false
  let at = first.length
  for (const middle of parts.slice(1, -1)) {
    const found = name.indexOf(middle, at)
    if (found === -1 || found + middle.length > name.length - last.length) return false
    at = found + middle.length
  }
  return true
}

/** The call's paths as path patterns see them: relative with `/` inside the working directory, absolute outside. */
export function relativePaths(target: CallTarget): readonly string[] {
  return (target.paths ?? []).map((path) => {
    const absolute = resolve(target.cwd, path)
    const rel = relative(target.cwd, absolute)
    if (rel === "") return "."
    if (rel.startsWith("..") || isAbsolute(rel)) return absolute
    return sep === "/" ? rel : rel.split(sep).join("/")
  })
}

export function hookApplies(hook: Hook, target: CallTarget): boolean {
  if (hook.point === "stop") return false
  if (hook.tools !== null && !hook.tools.some((pattern) => toolMatches(pattern, target.tool))) return false
  if (hook.paths === null) return true
  const paths = relativePaths(target)
  if (paths.length === 0) return false
  const globs = hook.paths.map((pattern) => new Bun.Glob(pattern))
  return paths.some((path) => globs.some((glob) => glob.match(path)))
}

/** The hooks of one point that apply to a call, in configuration order. */
export function hooksFor(hooks: readonly Hook[], target: CallTarget): Hook[] {
  return hooks.filter((hook) => hookApplies(hook, target))
}
