/**
 * grep: ripgrep when it is installed, a pure implementation otherwise. Both
 * produce the same records in the same order (files in directory-walk order,
 * each directory's entries sorted by name; lines in file order), feed them to
 * the same collector and the same formatter, so the output format and the
 * cap are identical. Both search hidden files, do not read `.gitignore`, skip
 * `.git` and `node_modules` directories, skip binary files and do not follow
 * symbolic links. They differ only in regular expression dialect at the edges
 * (Rust regex versus JavaScript regex with the `u` flag).
 */
import { basename, dirname, join } from "node:path"
import type { Tool } from "../tool/tool.ts"
import { SKIPPED_DIRECTORIES, cutLine, displayPath, errorCode, failure, looksBinary, resolvePath, success, walkFiles, statPath, placeName } from "./common.ts"

export interface GrepInput {
  readonly pattern: string
  readonly path?: string
  readonly glob?: string
  readonly context?: number
  readonly ignore_case?: boolean
}

export interface GrepOptions {
  /** Path of the `rg` binary, or `null` to always use the pure implementation. Default: `rg` from PATH. */
  readonly ripgrep?: string | null
}

const MAX_MATCHES = 250
const MAX_LINE_CHARS = 300
const BINARY_SAMPLE = 8192

/** One output line: a match, or a context line around one. `path` is relative to the search root. */
interface Record {
  readonly path: string
  readonly line: number
  readonly text: string
  readonly match: boolean
}

interface Search {
  readonly root: string
  /** Set when `path` is a file: the search covers only it. */
  readonly file: string | null
  readonly pattern: string
  readonly glob: string | null
  readonly context: number
  readonly ignoreCase: boolean
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

export function grepTool(options: GrepOptions = {}): Tool<GrepInput> {
  const ripgrep = options.ripgrep === undefined ? Bun.which("rg") : options.ripgrep
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression. Prints matching lines as `path:line:text` (context lines as `path-line-text`, groups separated by `--`), files sorted by path. Searches hidden files, skips `.git`, `node_modules` and binary files, and does not read `.gitignore`.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Regular expression to search for." },
        path: { type: "string", minLength: 1, description: "File or directory to search. Default: the working directory." },
        glob: { type: "string", minLength: 1, description: "Only search files matching this glob: `*.ts` matches file names, `src/**/*.ts` matches paths relative to `path`." },
        context: { type: "integer", minimum: 0, maximum: 10, description: "Lines of context to show before and after each match. Default 0." },
        ignore_case: { type: "boolean", description: "Match case-insensitively. Default false." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "read",
    touches: (input) => [input.path ?? "."],
    execute: async (input, context) => {
      const target = resolvePath(context.cwd, input.path ?? ".")
      const shown = displayPath(context.cwd, target)
      const info = await statPath(target)
      if (info instanceof Error) {
        if (errorCode(info) === "ENOENT") return failure(`Path not found: ${shown}`)
        return failure(`Cannot search ${shown}: ${info.message}`)
      }
      const search: Search = {
        root: info.isDirectory() ? target : dirname(target),
        file: info.isDirectory() ? null : target,
        pattern: input.pattern,
        glob: input.glob ?? null,
        context: input.context ?? 0,
        ignoreCase: input.ignore_case ?? false,
      }
      const collector = createCollector()
      const outcome = ripgrep === null ? await searchPure(search, collector.add, context.signal) : await searchRipgrep(ripgrep, search, collector.add, context.signal)
      if (!outcome.ok) return failure(outcome.error)
      const lines = format(collector.records, search.context, (path) => displayPath(context.cwd, join(search.root, path)))
      const display = { matches: collector.matches, files: collector.files, engine: ripgrep === null ? "pure" : "ripgrep" }
      if (context.signal.aborted) return failure(`${lines === "" ? "" : `${lines}\n\n`}[Search interrupted; results are incomplete.]`, display)
      if (collector.matches === 0) return success(`No matches for ${JSON.stringify(input.pattern)} in ${placeName(shown)}.`, display)
      const more =
        collector.matches > MAX_MATCHES
          ? `\n\n[Showing the first ${MAX_MATCHES} of ${collector.matches} matching lines. Narrow the pattern, path or glob.]`
          : ""
      return success(`${lines}${more}`, display)
    },
  }
}

/** Keeps records up to the match limit and counts the rest. Both engines feed it in the same order. */
function createCollector() {
  const records: Record[] = []
  const files = new Set<string>()
  let matches = 0
  return {
    records,
    get matches() {
      return matches
    },
    get files() {
      return files.size
    },
    add(record: Record) {
      if (record.match) {
        matches += 1
        files.add(record.path)
      }
      if (matches > MAX_MATCHES) return
      records.push({ ...record, text: cutLine(record.text, MAX_LINE_CHARS) })
    },
  }
}

function format(records: readonly Record[], context: number, show: (path: string) => string): string {
  const out: string[] = []
  let previous: Record | null = null
  for (const record of records) {
    if (context > 0 && previous !== null && (previous.path !== record.path || previous.line + 1 !== record.line)) out.push("--")
    out.push(`${show(record.path)}${record.match ? ":" : "-"}${record.line}${record.match ? ":" : "-"}${record.text}`)
    previous = record
  }
  return out.join("\n")
}

async function searchRipgrep(rg: string, search: Search, add: (record: Record) => void, signal: AbortSignal): Promise<Outcome> {
  const args = [rg, "--json", "--sort", "path", "--no-config", "--no-ignore", "--hidden", "--no-follow"]
  for (const name of SKIPPED_DIRECTORIES) args.push("--glob", `!${name}`)
  if (search.glob !== null) args.push("--glob", search.glob)
  if (search.ignoreCase) args.push("--ignore-case")
  if (search.context > 0) args.push("--context", String(search.context))
  args.push("--regexp", search.pattern, "--", search.file ?? ".")
  const child = Bun.spawn(args, { cwd: search.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const stop = () => child.kill("SIGKILL")
  signal.addEventListener("abort", stop, { once: true })
  const stderr = new Response(child.stderr).text()
  const decoder = new TextDecoder()
  let buffered = ""
  let sawRecord = false
  const handle = (line: string) => {
    if (line === "") return
    const message = JSON.parse(line) as RgMessage
    if (message.type !== "match" && message.type !== "context") return
    const path = textOf(message.data.path).replace(/^\.\//, "")
    sawRecord = true
    add({
      path: search.file === null ? path : relativeName(search.file),
      line: message.data.line_number ?? 0,
      text: textOf(message.data.lines).replace(/\r?\n$/, ""),
      match: message.type === "match",
    })
  }
  for await (const chunk of child.stdout) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    lines.forEach(handle)
  }
  handle(buffered)
  const code = await child.exited
  signal.removeEventListener("abort", stop)
  if (signal.aborted || code !== 2 || sawRecord) return { ok: true }
  const message = (await stderr).trim()
  return { ok: false, error: message.includes("regex parse error") ? `Invalid regular expression:\n${message}` : `grep failed: ${message}` }
}

interface RgText {
  readonly text?: string
  readonly bytes?: string
}

type RgMessage =
  | { readonly type: "match" | "context"; readonly data: { readonly path: RgText; readonly lines: RgText; readonly line_number: number | null } }
  | { readonly type: "begin" | "end" | "summary" }

function textOf(value: RgText): string {
  if (value.text !== undefined) return value.text
  return Buffer.from(value.bytes ?? "", "base64").toString("utf8")
}

async function searchPure(search: Search, add: (record: Record) => void, signal: AbortSignal): Promise<Outcome> {
  const regex = compileRegex(search.pattern, search.ignoreCase)
  if (regex instanceof Error) return { ok: false, error: `Invalid regular expression: ${regex.message}` }
  const glob = search.glob === null ? null : globMatcher(search.glob)
  const searchFile = async (absolute: string, path: string) => {
    const file = Bun.file(absolute)
    if (looksBinary(new Uint8Array(await file.slice(0, BINARY_SAMPLE).arrayBuffer()))) return
    const lines = (await file.text()).split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    const hits = lines.flatMap((line, index) => (regex.test(stripCr(line)) ? [index] : []))
    const shown = new Set(hits.flatMap((hit) => range(Math.max(0, hit - search.context), Math.min(lines.length - 1, hit + search.context))))
    const isHit = new Set(hits)
    for (const index of [...shown].sort((a, b) => a - b)) add({ path, line: index + 1, text: stripCr(lines[index]!), match: isHit.has(index) })
  }
  if (search.file !== null) {
    await searchFile(search.file, relativeName(search.file))
    return { ok: true }
  }
  await walkFiles(
    search.root,
    (name) => (SKIPPED_DIRECTORIES as readonly string[]).includes(name),
    async (path) => {
      if (signal.aborted) return false
      if (glob === null || glob(path)) await searchFile(join(search.root, path), path)
      return true
    },
  )
  return { ok: true }
}

function compileRegex(pattern: string, ignoreCase: boolean): RegExp | Error {
  try {
    return new RegExp(pattern, ignoreCase ? "iu" : "u")
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** ripgrep's rule: a glob without `/` matches the file name at any depth, one with `/` matches the path. */
function globMatcher(pattern: string): (path: string) => boolean {
  const glob = new Bun.Glob(pattern.replace(/^\//, ""))
  if (!pattern.includes("/")) return (path) => glob.match(path.slice(path.lastIndexOf("/") + 1))
  return (path) => glob.match(path)
}

function relativeName(file: string) {
  return basename(file)
}

function stripCr(line: string) {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}
