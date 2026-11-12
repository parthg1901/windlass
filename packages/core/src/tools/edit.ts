import type { Tool } from "../tool/tool.ts"
import { shownPath, errorCode, failure, toolPath, success, statPath } from "./common.ts"

export interface EditInput {
  readonly path: string
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean
}

const CONTEXT_LINES = 3
const MAX_DIFF_LINES = 400

export function editTool(): Tool<EditInput> {
  return {
    name: "edit",
    description:
      "Replace exact text in an existing file. `old_string` must match the file exactly, including whitespace and indentation, and must occur exactly once unless `replace_all` is true. Include enough surrounding lines to make it unique. Read the file first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "File path, absolute or relative to the working directory." },
        old_string: { type: "string", minLength: 1, description: "The exact text to replace." },
        new_string: { type: "string", description: "The text to put in its place." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one. Default false." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    effect: "write",
    touches: (input) => [input.path],
    execute: async (input, context) => {
      const path = toolPath(context, input.path)
      const shown = shownPath(context, path)
      const info = await statPath(path)
      if (info instanceof Error) {
        if (errorCode(info) === "ENOENT") return failure(`File not found: ${shown}. Use write to create a file.`)
        return failure(`Cannot edit ${shown}: ${info.message}`)
      }
      if (info.isDirectory()) return failure(`${shown} is a directory; give a file path.`)
      if (input.old_string === input.new_string) return failure("old_string and new_string are identical; there is nothing to change.")
      const before = await Bun.file(path).text()
      const crlf = !before.includes(input.old_string) && before.includes("\r\n") && input.old_string.includes("\n")
      const oldText = crlf ? toCrlf(input.old_string) : input.old_string
      const newText = crlf ? toCrlf(input.new_string) : input.new_string
      const occurrences = findAll(before, oldText)
      if (occurrences.length === 0) return failure(`old_string was not found in ${shown}.${nearMatch(before, input.old_string)}`)
      const starts = lineStarts(before)
      if (occurrences.length > 1 && input.replace_all !== true)
        return failure(
          `old_string occurs ${occurrences.length} times in ${shown} (on ${linesLabel(occurrences.map((index) => lineOf(starts, index) + 1))}). Include more surrounding lines to make it unique, or set replace_all to true to replace every occurrence.`,
        )
      const after = replaceAt(before, occurrences, oldText.length, newText)
      await Bun.write(path, after)
      const newStarts = lineStarts(after)
      const newLines = occurrences.map((index, k) => lineOf(newStarts, index + k * (newText.length - oldText.length)) + 1)
      const count = occurrences.length === 1 ? "1 occurrence" : `${occurrences.length} occurrences`
      return success(`Edited ${shown}: replaced ${count} (${linesLabel(newLines)}).`, {
        path: shown,
        replacements: occurrences.length,
        diff: unifiedDiff(shown, before, occurrences, oldText.length, newText),
      })
    },
  }
}

function findAll(text: string, search: string): number[] {
  const found: number[] = []
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) found.push(index)
  return found
}

function replaceAt(text: string, occurrences: readonly number[], length: number, replacement: string): string {
  const parts: string[] = []
  let from = 0
  for (const index of occurrences) {
    parts.push(text.slice(from, index), replacement)
    from = index + length
  }
  parts.push(text.slice(from))
  return parts.join("")
}

function toCrlf(text: string) {
  return text.replace(/\r?\n/g, "\r\n")
}

function linesLabel(lines: readonly number[]): string {
  const unique = [...new Set(lines)]
  const shown = unique.slice(0, 10).join(", ")
  const more = unique.length > 10 ? `, and ${unique.length - 10} more` : ""
  return `${unique.length === 1 ? "line" : "lines"} ${shown}${more}`
}

/** Explains a miss when the text is there apart from indentation or trailing whitespace. */
function nearMatch(text: string, search: string): string {
  const normalize = (line: string) => line.trim().replace(/\s+/g, " ")
  const wanted = search.split(/\r?\n/).map(normalize)
  while (wanted.length > 1 && wanted[wanted.length - 1] === "") wanted.pop()
  const lines = text.split(/\r?\n/).map(normalize)
  const at = lines.findIndex((_, start) => wanted.every((line, offset) => lines[start + offset] === line))
  if (wanted.every((line) => line === "") || at === -1)
    return " It must match the file exactly, including whitespace and indentation. Read the file to see its current content."
  return ` Text that differs from it only in whitespace starts at line ${at + 1}; read the file and copy the text exactly.`
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1)
  return starts
}

/** Index of the line (0-based) that contains character `index`. */
function lineOf(starts: readonly number[], index: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid]! <= index) low = mid
    else high = mid - 1
  }
  return low
}

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

interface Change {
  /** First changed line of the original (0-based) and the lines it replaces. */
  readonly oldStart: number
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
}

/** A unified diff of the replacements, built from where they are rather than by diffing the whole file. */
function unifiedDiff(path: string, before: string, occurrences: readonly number[], length: number, replacement: string): string {
  const starts = lineStarts(before)
  const original = splitLines(before)
  const segmentEnd = (line: number) => (line + 1 < starts.length ? starts[line + 1]! : before.length)

  // Group replacements by the original lines they touch; a match that ends in a newline also touches the next line.
  const groups: { first: number; last: number; members: number[] }[] = []
  for (const index of occurrences) {
    const first = lineOf(starts, index)
    const last = lineOf(starts, Math.min(index + length, Math.max(before.length - 1, 0)))
    const group = groups[groups.length - 1]
    if (group !== undefined && first <= group.last) {
      group.last = Math.max(group.last, last)
      group.members.push(index)
    } else groups.push({ first, last, members: [index] })
  }

  const changes = groups.flatMap((group): Change[] => {
    const from = starts[group.first]!
    const segment = before.slice(from, segmentEnd(group.last))
    const updated = replaceAt(segment, group.members.map((index) => index - from), length, replacement)
    const oldLines = splitLines(segment)
    const newLines = splitLines(updated)
    let head = 0
    while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1
    let tail = 0
    while (
      tail < oldLines.length - head &&
      tail < newLines.length - head &&
      oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
    )
      tail += 1
    if (head === oldLines.length && head === newLines.length) return []
    return [
      {
        oldStart: group.first + head,
        oldLines: oldLines.slice(head, oldLines.length - tail),
        newLines: newLines.slice(head, newLines.length - tail),
      },
    ]
  })

  const out = [`--- a/${path}`, `+++ b/${path}`]
  let delta = 0
  let index = 0
  while (index < changes.length) {
    // A hunk takes every following change whose context touches the previous one.
    let end = index
    while (
      end + 1 < changes.length &&
      changes[end + 1]!.oldStart - (changes[end]!.oldStart + changes[end]!.oldLines.length) <= CONTEXT_LINES * 2
    )
      end += 1
    const first = changes[index]!
    const last = changes[end]!
    const oldFrom = Math.max(0, first.oldStart - CONTEXT_LINES)
    const oldTo = Math.min(original.length, last.oldStart + last.oldLines.length + CONTEXT_LINES)
    const body: string[] = []
    let cursor = oldFrom
    let hunkDelta = 0
    for (const change of changes.slice(index, end + 1)) {
      for (; cursor < change.oldStart; cursor += 1) body.push(` ${original[cursor]}`)
      body.push(...change.oldLines.map((line) => `-${line}`), ...change.newLines.map((line) => `+${line}`))
      cursor += change.oldLines.length
      hunkDelta += change.newLines.length - change.oldLines.length
    }
    for (; cursor < oldTo; cursor += 1) body.push(` ${original[cursor]}`)
    const oldCount = oldTo - oldFrom
    const newCount = oldCount + hunkDelta
    const range = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`
    out.push(`@@ -${range(oldFrom, oldCount)} +${range(oldFrom + delta, newCount)} @@`, ...body)
    delta += hunkDelta
    index = end + 1
  }
  if (out.length <= MAX_DIFF_LINES) return out.join("\n")
  return [...out.slice(0, MAX_DIFF_LINES), `... (${out.length - MAX_DIFF_LINES} more diff lines)`].join("\n")
}
