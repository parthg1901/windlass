/**
 * Turns the content blocks of a `session/prompt` into the one text the
 * harness stores and sends to the model. The rules are fixed so the same
 * prompt always gives the same text (and so the same cached prefix):
 *
 * - Blocks keep their order and are separated by one blank line.
 * - `text` is used as written.
 * - `resource_link` becomes one line naming what is referenced, so the model
 *   can open it with its tools: `[file: /abs/path]` for a `file:` URI, otherwise
 *   `[link: <uri>]`; the name follows in parentheses when it is not simply the
 *   file's own name.
 * - `resource` (embedded text, sent when the client attaches a file's
 *   content) becomes the same header line followed by the text in a fenced
 *   block whose fence is longer than any run of backticks inside it.
 *
 * Images, audio and binary resources are refused, matching the capabilities
 * the server advertises.
 */
import { basename } from "node:path"
import { fileURLToPath } from "node:url"
import type { ContentBlock } from "@agentclientprotocol/sdk"

export type PromptText = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }

export function promptText(blocks: readonly ContentBlock[]): PromptText {
  if (blocks.length === 0) return { ok: false, message: "the prompt is empty" }
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text)
        break
      case "resource_link":
        parts.push(reference(block.uri, block.name))
        break
      case "resource": {
        const resource = block.resource
        if (!("text" in resource)) return { ok: false, message: `binary resources are not supported (${resource.uri})` }
        parts.push(`${reference(resource.uri, null)}\n${fenced(resource.text)}`)
        break
      }
      case "image":
        return { ok: false, message: "images are not supported yet (promptCapabilities.image is false)" }
      case "audio":
        return { ok: false, message: "audio is not supported (promptCapabilities.audio is false)" }
      default:
        return { ok: false, message: `unknown content block type ${(block as { type: string }).type}` }
    }
  }
  const text = parts.join("\n\n")
  if (text.trim() === "") return { ok: false, message: "the prompt is empty" }
  return { ok: true, text }
}

function reference(uri: string, name: string | null): string {
  const path = filePath(uri)
  const head = path === null ? `[link: ${uri}]` : `[file: ${path}]`
  const ownName = path === null ? null : basename(path)
  return name === null || name === "" || name === ownName || name === uri || name === path ? head : `${head} (${name})`
}

function filePath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

/** A fenced block that cannot be closed early by backticks in its content. */
export function fenced(text: string, info = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`
}
