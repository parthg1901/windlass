import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { Tool } from "../tool/tool.ts"
import { displayPath, failure, resolvePath, success } from "./common.ts"

export interface WriteInput {
  readonly path: string
  readonly content: string
}

export function writeTool(): Tool<WriteInput> {
  return {
    name: "write",
    description:
      "Create a file or replace its whole content. Parent directories are created as needed. To change part of an existing file, use edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "File path, absolute or relative to the working directory." },
        content: { type: "string", description: "The complete new content of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    effect: "write",
    touches: (input) => [input.path],
    execute: async (input, context) => {
      const path = resolvePath(context.cwd, input.path)
      const shown = displayPath(context.cwd, path)
      const before = await stat(path).catch(() => null)
      if (before?.isDirectory()) return failure(`${shown} is a directory; give a file path.`)
      const parent = await mkdir(dirname(path), { recursive: true }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      if (parent !== null) return failure(`Cannot create the directory for ${shown}: ${parent}`)
      const written = await Bun.write(path, input.content).then(
        (bytes) => bytes,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )
      if (written instanceof Error) return failure(`Cannot write ${shown}: ${written.message}`)
      const lines = input.content === "" ? 0 : input.content.split("\n").length - (input.content.endsWith("\n") ? 1 : 0)
      return success(`${before === null ? "Created" : "Overwrote"} ${shown} (${lines} ${lines === 1 ? "line" : "lines"}, ${written} bytes).`, {
        path: shown,
        created: before === null,
        bytes: written,
      })
    },
  }
}
