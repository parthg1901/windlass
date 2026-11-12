/**
 * The front matter of a `SKILL.md`: a YAML block between `---` lines at the
 * top of the file. Only the subset skills use is read, strictly where a
 * mistake would change meaning and forgivingly where it would not:
 *
 * - top-level `key: value` pairs; a value may be plain, single- or
 *   double-quoted, a block scalar (`|` or `>`, with `-` or `+`), or a plain
 *   value continued on more-indented lines;
 * - nested blocks under a key (`metadata:` with indented lines, lists) are
 *   accepted and skipped, since nothing here reads them;
 * - comments, blank lines, CRLF line endings and a byte-order mark are fine;
 * - an unknown key is ignored (skills written for other harnesses carry
 *   `license`, `allowed-tools`, `metadata` ...).
 *
 * Strict: the block must open on the first line and be closed; a top-level
 * line must be `key: value`; a key may not appear twice; quotes must close.
 * Each failure is a message for the user, never an exception.
 */

export type FrontMatter = { readonly ok: true; readonly fields: ReadonlyMap<string, string>; readonly body: string } | { readonly ok: false; readonly reason: string }

export function parseFrontMatter(text: string): FrontMatter {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")
  if (lines[0]?.trimEnd() !== "---") return { ok: false, reason: "it does not start with front matter (a line `---`, then `name:` and `description:`, then `---`)" }
  const end = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."))
  if (end === -1) return { ok: false, reason: "its front matter is not closed with a line `---`" }
  const fields = new Map<string, string>()
  const block = lines.slice(1, end)
  let index = 0
  while (index < block.length) {
    const line = block[index]!
    const lineNumber = index + 2
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1
      continue
    }
    if (/^\s/.test(line)) return { ok: false, reason: `line ${lineNumber} of the front matter is indented but follows no key` }
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line)
    if (match === null) return { ok: false, reason: `line ${lineNumber} of the front matter is not \`key: value\`: ${JSON.stringify(line.slice(0, 80))}` }
    const key = match[1]!
    if (fields.has(key)) return { ok: false, reason: `the front matter has the key \`${key}\` twice (line ${lineNumber})` }
    const raw = (match[2] ?? "").trim()
    // The lines that belong to this key: everything more indented than a top-level line, blank lines included.
    let next = index + 1
    while (next < block.length && (block[next]!.trim() === "" || /^\s/.test(block[next]!))) next += 1
    const continuation = block.slice(index + 1, next)
    const value = readValue(raw, continuation, lineNumber)
    if (!value.ok) return value
    fields.set(key, value.value)
    index = next
  }
  return { ok: true, fields, body: lines.slice(end + 1).join("\n").trim() }
}

function readValue(raw: string, continuation: readonly string[], lineNumber: number): { ok: true; value: string } | { ok: false; reason: string } {
  const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(raw)
  if (block !== null) return { ok: true, value: blockScalar(continuation, block[1] === ">", block[2] ?? "") }
  if (raw.startsWith('"')) {
    const joined = [raw, ...continuation.map((line) => line.trim())].join(" ")
    const close = findDoubleQuoteEnd(joined)
    if (close === -1) return { ok: false, reason: `the double-quoted value on line ${lineNumber} is not closed` }
    if (!/^\s*(#.*)?$/.test(joined.slice(close + 1))) return { ok: false, reason: `there is text after the quoted value on line ${lineNumber}` }
    return { ok: true, value: unescapeDouble(joined.slice(1, close)) }
  }
  if (raw.startsWith("'")) {
    const joined = [raw, ...continuation.map((line) => line.trim())].join(" ")
    const close = findSingleQuoteEnd(joined)
    if (close === -1) return { ok: false, reason: `the single-quoted value on line ${lineNumber} is not closed` }
    if (!/^\s*(#.*)?$/.test(joined.slice(close + 1))) return { ok: false, reason: `there is text after the quoted value on line ${lineNumber}` }
    return { ok: true, value: joined.slice(1, close).replace(/''/g, "'") }
  }
  const plain = stripComment(raw)
  if (plain === "") {
    // A nested block (a map or a list) or nothing: not a text value.
    return { ok: true, value: "" }
  }
  // A plain value may continue on more-indented lines; YAML folds them with spaces.
  const rest = continuation.map((line) => stripComment(line.trim())).filter((line) => line !== "")
  return { ok: true, value: [plain, ...rest].join(" ") }
}

function blockScalar(lines: readonly string[], folded: boolean, chomp: string): string {
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length))
  const body = lines.map((line) => (line.trim() === "" ? "" : line.slice(Number.isFinite(indent) ? indent : 0)))
  while (body.length > 0 && body[body.length - 1] === "" && chomp !== "+") body.pop()
  const text = folded ? fold(body) : body.join("\n")
  return chomp === "-" || chomp === "" ? text.replace(/\n+$/, "") : text
}

/** `>`: lines of one paragraph are joined with spaces; blank lines separate paragraphs. */
function fold(lines: readonly string[]): string {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line === "") {
      paragraphs.push(current.join(" "))
      current = []
    } else current.push(line)
  }
  paragraphs.push(current.join(" "))
  return paragraphs.join("\n").replace(/^\n+/, "")
}

function stripComment(text: string): string {
  // ` #` starts a comment in a plain value; a `#` inside a word does not.
  const at = text.search(/(^|\s)#/)
  return (at === -1 ? text : text.slice(0, at)).trim()
}

function findDoubleQuoteEnd(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1
    else if (text[index] === '"') return index
  }
  return -1
}

function findSingleQuoteEnd(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] !== "'") continue
    if (text[index + 1] === "'") index += 1
    else return index
  }
  return -1
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, code: string) => {
    if (code.startsWith("u") && code.length === 5) return String.fromCharCode(Number.parseInt(code.slice(1), 16))
    return code === "n" ? "\n" : code === "t" ? "\t" : code === "0" ? "\0" : code
  })
}
