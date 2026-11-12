import { isAbsolute, join } from "node:path"
import type { Tool } from "../tool/tool.ts"
import { SKIPPED_DIRECTORIES, shownPath, errorCode, failure, toolPath, success, walkFiles, statPath, placeName } from "./common.ts"

export interface GlobInput {
  readonly pattern: string
  readonly path?: string
}

const MAX_RESULTS = 1000

export function globTool(): Tool<GlobInput> {
  return {
    name: "glob",
    description:
      "Find files whose path matches a glob pattern, such as `**/*.ts` or `src/**/test_*.py`. The pattern is matched against paths relative to `path`; `*` does not cross `/`, so use `**/` to search subdirectories. Results are sorted by path. `.git` and `node_modules` are skipped unless the pattern names them.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Glob pattern relative to `path`. Supports *, **, ?, [abc] and {a,b}." },
        path: { type: "string", minLength: 1, description: "Directory to search in. Default: the working directory." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "read",
    touches: (input) => [input.path ?? "."],
    execute: async (input, context) => {
      if (isAbsolute(input.pattern)) return failure("pattern must be relative; put the directory to search in `path`.")
      const root = toolPath(context, input.path ?? ".")
      const shown = shownPath(context, root)
      const info = await statPath(root)
      if (info instanceof Error) {
        if (errorCode(info) === "ENOENT") return failure(`Directory not found: ${shown}`)
        return failure(`Cannot search ${shown}: ${info.message}`)
      }
      if (!info.isDirectory()) return failure(`${shown} is a file, not a directory.`)
      const pattern = input.pattern.replace(/^(\.\/)+/, "")
      const glob = new Bun.Glob(pattern)
      const named = SKIPPED_DIRECTORIES.filter((name) => pattern.includes(name))
      const matches: string[] = []
      let total = 0
      await walkFiles(
        root,
        (name) => (SKIPPED_DIRECTORIES as readonly string[]).includes(name) && !(named as readonly string[]).includes(name),
        (rel) => {
          if (!glob.match(rel)) return true
          total += 1
          if (matches.length < MAX_RESULTS) matches.push(shownPath(context, join(root, rel)))
          return true
        },
      )
      if (total === 0) return success(`No files match ${input.pattern} in ${placeName(shown)}.`, { matches: 0 })
      const more = total > MAX_RESULTS ? `\n\n[Showing the first ${MAX_RESULTS} of ${total} files. Use a narrower pattern or path.]` : ""
      return success(`${matches.join("\n")}${more}`, { matches: total })
    },
  }
}
