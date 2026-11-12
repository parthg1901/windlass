import { readdir } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { OUTPUT_LIMITS } from "../tool/cap.ts"
import type { Tool } from "../tool/tool.ts"
import { byCodeUnits, cutLine, shownPath, errorCode, failure, looksBinary, toolPath, success, statPath } from "./common.ts"

export interface ReadInput {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

const DEFAULT_LIMIT = 2000
const MAX_LINE_CHARS = 2000
/** The page stays inside the runtime cap, so read output is never spilled: the file itself is the full output. */
const PAGE_BYTES = OUTPUT_LIMITS.maxBytes - 1024
const PAGE_LINES = OUTPUT_LIMITS.maxLines - 2
const BINARY_SAMPLE = 8192

export function readTool(): Tool<ReadInput> {
  return {
    name: "read",
    description:
      "Read a text file. Each line is prefixed with its line number and a tab. Returns up to 2000 lines from `offset` (fewer when lines are long; the end of the output says how to continue). Lines longer than 2000 characters are cut.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "File path, absolute or relative to the working directory." },
        offset: { type: "integer", minimum: 1, description: "Line number to start at (1-based). Default 1." },
        limit: { type: "integer", minimum: 1, maximum: DEFAULT_LIMIT, description: "Maximum number of lines to return. Default 2000." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "read",
    touches: (input) => [input.path],
    execute: async (input, context) => {
      const path = toolPath(context, input.path)
      const shown = shownPath(context, path)
      const info = await statPath(path)
      if (info instanceof Error) {
        if (errorCode(info) === "ENOENT") return failure(`File not found: ${shown}${await suggestions(path)}`)
        return failure(`Cannot read ${shown}: ${info.message}`)
      }
      if (info.isDirectory()) return failure(`${shown} is a directory. Use ls to list it.`)
      const file = Bun.file(path)
      if (looksBinary(new Uint8Array(await file.slice(0, BINARY_SAMPLE).arrayBuffer())))
        return failure(`Cannot read ${shown}: it looks like a binary file (${info.size} bytes).`)
      const offset = input.offset ?? 1
      const page = await readPage(file.stream(), offset, input.limit ?? DEFAULT_LIMIT)
      if (page.totalLines === 0) return success("(empty file)", { path: shown, lines: 0 })
      if (offset > page.totalLines)
        return failure(`offset ${offset} is past the end of ${shown}, which has ${page.totalLines} lines.`)
      const last = offset + page.lines.length - 1
      const width = String(last).length
      const body = page.lines.map((line, index) => `${String(offset + index).padStart(width, " ")}\t${line}`).join("\n")
      const footer =
        last < page.totalLines ? `\n\n[Showing lines ${offset}-${last} of ${page.totalLines}. Call read with offset ${last + 1} to continue.]` : ""
      return success(`${body}${footer}`, { path: shown, offset, lines: page.lines.length, totalLines: page.totalLines })
    },
  }
}

/** Reads the lines of one page and counts every line, keeping only the page in memory. */
async function readPage(stream: ReadableStream<Uint8Array>, offset: number, limit: number) {
  const decoder = new TextDecoder()
  const lines: string[] = []
  let lineNumber = 1
  let current: Uint8Array[] = []
  let currentBytes = 0
  let currentLength = 0
  let pageBytes = 0
  let collecting = offset === 1
  let sawBytes = false
  let endsWithNewline = false
  const keep = MAX_LINE_CHARS * 4 + 4

  const finishLine = () => {
    if (collecting) {
      const text = decoder.decode(concat(current)).replace(/\r$/, "")
      const line = currentLength > keep ? `${text.slice(0, MAX_LINE_CHARS)}... [line cut, ${currentLength} bytes long]` : cutLine(text, MAX_LINE_CHARS)
      const cost = Buffer.byteLength(line) + String(lineNumber).length + 2
      if (lines.length >= limit || lines.length >= PAGE_LINES || pageBytes + cost > PAGE_BYTES) collecting = false
      else {
        lines.push(line)
        pageBytes += cost
      }
    }
    current = []
    currentBytes = 0
    currentLength = 0
    lineNumber += 1
    if (lineNumber === offset) collecting = true
  }

  for await (const chunk of stream) {
    if (chunk.length === 0) continue
    sawBytes = true
    endsWithNewline = chunk[chunk.length - 1] === 0x0a
    let start = 0
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
      append(chunk.subarray(start, index))
      finishLine()
      start = index + 1
    }
    append(chunk.subarray(start))
  }
  if (sawBytes && !endsWithNewline) finishLine()
  return { lines, totalLines: lineNumber - 1 }

  function append(bytes: Uint8Array) {
    currentLength += bytes.length
    if (!collecting || currentBytes >= keep) return
    const part = bytes.subarray(0, keep - currentBytes)
    current.push(part.slice())
    currentBytes += part.length
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  return Buffer.concat(parts)
}

/** Names in the parent directory that look like what was meant, for a "did you mean". */
async function suggestions(path: string): Promise<string> {
  const name = basename(path).toLowerCase()
  const stem = name.replace(/\.[^.]*$/, "")
  const entries = await readdir(dirname(path)).catch(() => [])
  const similar = entries
    .filter((entry) => {
      const lower = entry.toLowerCase()
      return lower === name || lower.replace(/\.[^.]*$/, "") === stem || (stem.length >= 3 && lower.startsWith(stem))
    })
    .sort(byCodeUnits)
    .slice(0, 5)
  if (similar.length === 0) return ""
  return `. Similar names in the same directory: ${similar.join(", ")}`
}
