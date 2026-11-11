/** Parsing the argument text a model produced for a tool call. */
import type { Json } from "../json.ts"

export type ParsedArguments =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly problem: string; readonly excerpt: string }

const EXCERPT_CHARS = 200

/**
 * Parses argument text as JSON. Text that is empty or only whitespace is read
 * as `{}`, because some models send nothing for a tool whose parameters are
 * all optional. Never throws.
 */
export function parseArguments(text: string): ParsedArguments {
  if (text.trim() === "") return { ok: true, value: {} }
  const parsed = tryParse(text)
  if (parsed.ok) return parsed
  return { ok: false, problem: parsed.problem, excerpt: excerpt(text) }
}

/**
 * Whether argument text looks like valid JSON that was cut off: it ends inside
 * a string, or with objects or arrays still open, and has no other error. The
 * step loop uses this to tell arguments cut by an output limit (never executed,
 * retry rule 6) from arguments that are simply malformed.
 */
export function looksTruncated(text: string): boolean {
  const body = text.trim()
  if (body === "" || tryParse(body).ok) return false
  const open: string[] = []
  let inString = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (inString) {
      if (char === "\\") index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") open.push(char)
    else if (char === "}" || char === "]") {
      if (open.pop() !== (char === "}" ? "{" : "[")) return false
      if (open.length === 0 && body.slice(index + 1).trim() !== "") return false
    }
  }
  return inString || open.length > 0
}

/** The first characters of `text`, cut on a code point boundary, with the length of what was left out. */
export function excerpt(text: string, limit = EXCERPT_CHARS): string {
  const points = [...text]
  if (points.length <= limit) return text
  return `${points.slice(0, limit).join("")}… (${points.length - limit} more characters)`
}

function tryParse(text: string): { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly problem: string } {
  try {
    return { ok: true, value: JSON.parse(text) as Json }
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
}
