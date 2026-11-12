import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { Tool } from "../tool/tool.ts"
import { hasPlaceholder, placeholders, redactedView, restore } from "./redacted.ts"
import { shownPath, failure, toolPath, success } from "./common.ts"

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
      const path = toolPath(context, input.path)
      const shown = shownPath(context, path)
      const before = await stat(path).catch(() => null)
      if (before?.isDirectory()) return failure(`${shown} is a directory; give a file path.`)
      // Content that holds a redaction placeholder, for a file whose secrets the model was shown as placeholders: the
      // placeholders are written as the secrets they stand for, or, when they do not line up, nothing is written.
      let content = input.content
      let restored = 0
      if (before !== null && context.redact !== undefined && hasPlaceholder(input.content)) {
        const view = redactedView(await Bun.file(path).text().catch(() => ""), context.redact)
        if (view.redacted) {
          const secrets = view.pieces.filter((piece) => piece.kind !== null).map((piece) => ({ placeholder: piece.text, original: piece.original }))
          const written = placeholders(input.content)
          const lineUp = written.length === secrets.length && written.every((placeholder, index) => placeholder === secrets[index]!.placeholder)
          const result = lineUp ? restore(input.content, secrets) : null
          if (result === null || "unknown" in result)
            return failure(
              `Not written: the content has ${written.length} redaction ${written.length === 1 ? "placeholder" : "placeholders"} and ${shown} has ${secrets.length} redacted ${secrets.length === 1 ? "secret" : "secrets"}, or they are in another order. Writing it would replace real secrets with placeholders. Change the file with edit instead (leave the lines with placeholders as they are), or write content with every placeholder exactly where it was.`,
            )
          content = result.text
          restored = result.restored
        }
      }
      const parent = await mkdir(dirname(path), { recursive: true }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      if (parent !== null) return failure(`Cannot create the directory for ${shown}: ${parent}`)
      const written = await Bun.write(path, content).then(
        (bytes) => bytes,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )
      if (written instanceof Error) return failure(`Cannot write ${shown}: ${written.message}`)
      const lines = input.content === "" ? 0 : input.content.split("\n").length - (input.content.endsWith("\n") ? 1 : 0)
      const kept = restored === 0 ? "" : ` ${restored === 1 ? "The redaction placeholder in the content was written as the secret it stands for in the file." : `The ${restored} redaction placeholders in the content were written as the secrets they stand for in the file.`}`
      return success(`${before === null ? "Created" : "Overwrote"} ${shown} (${lines} ${lines === 1 ? "line" : "lines"}, ${written} bytes).${kept}`, {
        path: shown,
        created: before === null,
        bytes: written,
      })
    },
  }
}
