/** Helpers shared by the standard tools. */
import { type Stats } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Json } from "../json.ts"
import type { ToolResult } from "../tool/tool.ts"

/** Options shared by every standard tool. */
export interface ToolOptions {
  /** Where output that is too long for the model is written in full. */
  readonly spillDir: string
}

/** Resolves a path from the model against the session's working directory. `~` means the home directory. */
export function resolvePath(cwd: string, path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return resolve(cwd, path)
}

/** How a path is shown to the model: relative to the working directory when inside it, absolute otherwise. */
export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute)
  if (rel === "") return "."
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute
  return sep === "/" ? rel : rel.split(sep).join("/")
}

export function success(output: string, display: Json | null = null): ToolResult {
  return { status: "success", output, truncation: null, attachments: [], display }
}

export function failure(output: string, display: Json | null = null): ToolResult {
  return { status: "error", output, truncation: null, attachments: [], display }
}

/** A display path as a place in a sentence: "." reads as "the working directory". */
export function placeName(shown: string) {
  return shown === "." ? "the working directory" : shown
}

/** `stat`, with a failure returned as an `Error` instead of thrown. */
export function statPath(path: string): Promise<Stats | Error> {
  return stat(path).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
}

/** The error code of a Node file system error, if it is one. */
export function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null
}

/** Compares by UTF-16 code units, the same on every machine and locale. */
export function byCodeUnits(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Whether a sample of a file's bytes looks binary: it contains a NUL byte. */
export function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0)
}

/** Directories never descended into by glob and grep unless the pattern names them. */
export const SKIPPED_DIRECTORIES = [".git", "node_modules"] as const

/**
 * Walks a directory tree in sorted order and calls `visit` with each regular
 * file's path relative to `root` (with `/` separators). Symbolic links are not
 * followed. `skip` decides which directories are not entered. Returning
 * `false` from `visit` stops the walk.
 */
export async function walkFiles(
  root: string,
  skip: (name: string) => boolean,
  visit: (relativePath: string) => boolean | Promise<boolean>,
): Promise<void> {
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => byCodeUnits(a.name, b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!skip(entry.name) && !(await walk(join(dir, entry.name), rel))) return false
        continue
      }
      if (entry.isFile() && !(await visit(rel))) return false
    }
    return true
  }
  await walk(root, "")
}

/** Cuts a line to about `max` UTF-16 code units, never inside a surrogate pair, and says how long it was. */
export function cutLine(line: string, max: number): string {
  if (line.length <= max) return line
  const end = isHighSurrogate(line.charCodeAt(max - 1)) ? max - 1 : max
  return `${line.slice(0, end)}... [line cut, ${line.length} characters long]`
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}
