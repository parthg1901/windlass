import { readdir } from "node:fs/promises"
import type { Tool } from "../tool/tool.ts"
import { byCodeUnits, displayPath, errorCode, failure, resolvePath, success, statPath } from "./common.ts"

export interface LsInput {
  readonly path?: string
}

const MAX_ENTRIES = 1000

export function lsTool(): Tool<LsInput> {
  return {
    name: "ls",
    description:
      "List the entries of one directory (not recursive), sorted by name. Directories end with `/`, symbolic links with `@`. To find files by name across a tree, use glob.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Directory path, absolute or relative to the working directory. Default: the working directory." },
      },
      additionalProperties: false,
    },
    effect: "read",
    touches: (input) => [input.path ?? "."],
    execute: async (input, context) => {
      const path = resolvePath(context.cwd, input.path ?? ".")
      const shown = displayPath(context.cwd, path)
      const info = await statPath(path)
      if (info instanceof Error) {
        if (errorCode(info) === "ENOENT") return failure(`Directory not found: ${shown}`)
        return failure(`Cannot list ${shown}: ${info.message}`)
      }
      if (!info.isDirectory()) return failure(`${shown} is a file, not a directory. Use read to read it.`)
      const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      if (entries instanceof Error) return failure(`Cannot list ${shown}: ${entries.message}`)
      if (entries.length === 0) return success(`${shown === "." ? "The working directory" : shown} is empty.`, { path: shown, entries: 0 })
      const names = entries
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`)
        .sort(byCodeUnits)
      const listed = names.slice(0, MAX_ENTRIES).join("\n")
      const more = names.length > MAX_ENTRIES ? `\n\n[Showing ${MAX_ENTRIES} of ${names.length} entries. Use glob to narrow the listing.]` : ""
      return success(`${listed}${more}`, { path: shown, entries: names.length })
    },
  }
}
