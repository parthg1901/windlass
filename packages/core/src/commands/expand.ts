/**
 * Expanding a command: a pure function of the template and what the user
 * typed after the command's name. Nothing is executed and nothing is read.
 *
 * In the template, in one pass from left to right:
 * - `$ARGUMENTS` is everything typed after the name, as typed (trimmed);
 * - `$1`, `$2`, ... `$10` ... is that argument (a `$` followed by digits,
 *   the whole number; `$0` is left as it is). Arguments are split at
 *   whitespace; `"..."` or `'...'` keeps spaces in one argument, and inside
 *   double quotes `\"` and `\\` stand for `"` and `\`;
 * - `$$` is one `$` (write `$$5` for a literal `$5`);
 * - any other `$` is left as it is (`$HOME` stays `$HOME`).
 * What is substituted is never scanned again, so an argument containing
 * `$2` stays `$2`.
 *
 * A positional argument that was not given becomes empty text and is listed
 * in `missing`; a client shows that before sending. A template with no
 * placeholder at all gets what the user typed appended as a last paragraph
 * (`Arguments: ...`), so arguments are never dropped silently.
 *
 * Not supported, by design: other harnesses run a command written in
 * backticks after `!` and read files named `@path` into the text when the
 * user types the slash. Here both are left as text and reported
 * (`unsupported`): a file in a repository must not run a command or read a
 * file because someone typed its name. The model sees the text and can run
 * or read the same with its tools, which go through the approval layer.
 */

export interface UnsupportedConstruct {
  readonly kind: "shell" | "include"
  /** The construct as written. */
  readonly text: string
  /** 1-based line of the template. */
  readonly line: number
  readonly reason: string
}

export interface Expansion {
  /** What is sent as the user's message. */
  readonly text: string
  /** The arguments as split. */
  readonly arguments: readonly string[]
  /** What was typed after the name, trimmed: `$ARGUMENTS`. */
  readonly raw: string
  /** 1-based positions the template uses that were not given, ascending. */
  readonly missing: readonly number[]
  /** 1-based positions given that the template does not use (only when it uses positions but not `$ARGUMENTS`). */
  readonly unused: readonly number[]
  /** The template had no placeholder and the arguments were appended. */
  readonly appended: boolean
  /** What was left as text and why, for the user. */
  readonly unsupported: readonly UnsupportedConstruct[]
  /** Anything else the user should know (an unclosed quote). */
  readonly notes: readonly string[]
}

const SHELL_REASON = "a command file does not run commands when it is used; the text is sent as it is, and the model can run it with the shell tool, which asks as usual"
const INCLUDE_REASON = "a command file does not read files into its text; the path is sent as it is, and the model can read it with its tools"

/** The constructs of other harnesses that expansion leaves as text. */
export function findUnsupported(template: string): UnsupportedConstruct[] {
  const found: UnsupportedConstruct[] = []
  template.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/!`[^`\n]*`/g)) found.push({ kind: "shell", text: match[0], line: index + 1, reason: SHELL_REASON })
    for (const match of line.matchAll(/(^|[\s("'[])@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)/g)) {
      const path = match[2]!.replace(/[.]+$/, "")
      // A path, not a mention: it has a slash, or ends in an extension.
      if (!path.includes("/") && !/\.[A-Za-z0-9]+$/.test(path)) continue
      found.push({ kind: "include", text: `@${path}`, line: index + 1, reason: INCLUDE_REASON })
    }
  })
  return found
}

/** Splits what the user typed into arguments. */
export function splitArguments(raw: string): { readonly arguments: string[]; readonly unclosed: boolean } {
  const args: string[] = []
  let current = ""
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === "\\" && (raw[index + 1] === '"' || raw[index + 1] === "\\")) {
        current += raw[index + 1]
        index += 1
      } else if (char === '"') quote = null
      else current += char
      continue
    }
    if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ""
      started = false
      continue
    }
    if (char === '"' || char === "'") quote = char
    else current += char
    started = true
  }
  if (started) args.push(current)
  return { arguments: args, unclosed: quote !== null }
}

/** Expands `template` with what the user typed after the command's name. */
export function expandTemplate(template: string, typed: string): Expansion {
  const raw = typed.trim()
  const split = splitArguments(raw)
  const args = split.arguments
  const used = new Set<number>()
  let usesAll = false
  let usesAny = false
  const text = template.replace(/\$(\$|ARGUMENTS|[1-9][0-9]*)/g, (whole, what: string) => {
    if (what === "$") return "$"
    usesAny = true
    if (what === "ARGUMENTS") {
      usesAll = true
      return raw
    }
    const position = Number(what)
    used.add(position)
    return args[position - 1] ?? ""
  })
  const appended = !usesAny && raw !== ""
  const missing = [...used].filter((position) => position > args.length).sort((a, b) => a - b)
  const unused = usesAll || used.size === 0 ? [] : args.map((_, index) => index + 1).filter((position) => !used.has(position))
  return {
    text: appended ? `${text}\n\nArguments: ${raw}` : text,
    arguments: args,
    raw,
    missing,
    unused,
    appended,
    unsupported: findUnsupported(template),
    notes: split.unclosed ? ["A quote in the arguments is not closed; the last argument runs to the end."] : [],
  }
}
