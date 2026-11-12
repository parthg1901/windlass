/**
 * The checkpoint: the frozen text that stands in for the removed history. The
 * engine stores it as `compaction.ended.summary`, and the request builder
 * shows it to the model inside `<harness origin="compaction">`.
 *
 * It has four parts, in this order:
 * 1. the model-written summary (`summary.ts`);
 * 2. an index of exact identifiers that summaries tend to mangle, extracted
 *    mechanically from the removed messages: file paths (with line numbers
 *    where the text gave them), commands with the outcome of each run, error
 *    lines, commit hashes and failing test names;
 * 3. the user's own messages, quoted verbatim, newest first until the budget
 *    is spent, then printed oldest first;
 * 4. one sentence saying that the full earlier conversation is available
 *    through `history_search` and `history_read`.
 *
 * When the model could not produce a usable summary (`summary: null`), the
 * checkpoint is built without one: a plain statement that there is none, the
 * last things the assistant said before the cut, and the index and the
 * quotes with the summary's budget added to theirs. It needs no model, so a
 * compaction can always complete.
 *
 * When the kept tail does not hold the latest user message (the cut fell
 * inside the turn in progress), `inProgress` adds one sentence telling the
 * model to carry on instead of starting over.
 *
 * Everything but the summary is deterministic and bounded, so the same inputs
 * always give byte-identical text and the size is known before the model is
 * asked. Pass every non-excluded message before the cut from the whole log,
 * not only the model's current view: the index and the quotes then cover
 * earlier compactions too, without parsing an older checkpoint back.
 */
import type { Message } from "../message/message.ts"
import { parseArguments } from "../tool/args.ts"
import { estimateTokens } from "./estimate.ts"
import { HISTORY_READ, HISTORY_SEARCH, messagePieces } from "./history-tools.ts"

export interface CheckpointLimits {
  /** Tokens of the identifier index. */
  readonly indexTokens: number
  /** Tokens of the quoted user messages. */
  readonly userTokens: number
  /** Tokens of one quoted user message; longer ones are cut in the middle. */
  readonly perUserMessageTokens: number
  /** Characters of one index entry. */
  readonly entryChars: number
  /** Entries per category before the token budget applies. */
  readonly perCategory: Readonly<Record<IdentifierKind, number>>
}

/** Together at most `DEFAULT_COMPACTION_CONFIG.checkpointExtraMaxTokens`, with room for headings. */
export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  indexTokens: 1_500,
  userTokens: 1_900,
  perUserMessageTokens: 400,
  entryChars: 160,
  perCategory: { files: 40, commands: 25, errors: 15, commits: 10, tests: 20 },
}

export type IdentifierKind = "files" | "commands" | "errors" | "commits" | "tests"

export const IDENTIFIER_KINDS: readonly IdentifierKind[] = ["files", "commands", "errors", "commits", "tests"]

/** The extracted identifiers per kind, oldest first. */
export type IdentifierIndex = Readonly<Record<IdentifierKind, readonly string[]>>

export interface Checkpoint {
  readonly text: string
  readonly tokens: number
  readonly index: IdentifierIndex
  /** `seq` of the user messages quoted. */
  readonly quoted: readonly number[]
  /** How many user messages did not fit. */
  readonly unquoted: number
}

export interface CheckpointInput {
  /** The model-written summary, or `null` when none could be produced: the checkpoint then says so and carries more of the mechanical parts. */
  readonly summary: string | null
  /** Every non-excluded message before the cut, in `seq` order. Compaction messages are ignored. */
  readonly earlier: readonly Message[]
  readonly limits?: CheckpointLimits
  /** Whether the session offers `history_search` and `history_read`, so the last sentence may name them. Default `true`. */
  readonly historyTools?: boolean
  /** Whether the work was in progress and the request is not in the kept tail (`TailChoice.midTurn`). Default `false`. */
  readonly inProgress?: boolean
}

export const CHECKPOINT_HEADER = "Checkpoint of the earlier conversation, which was compacted to save space."
export const INDEX_HEADING = "## Exact identifiers from the earlier conversation (extracted mechanically)"
export const QUOTES_HEADING = "## The user's messages, verbatim (oldest first)"
export const HISTORY_SENTENCE = `The full earlier conversation is still stored: ${HISTORY_SEARCH} finds text in it, and ${HISTORY_READ} reads a message in full by its seq. When you need a detail or a reason from before this checkpoint that is not written here, look it up with them rather than guessing or saying that you cannot tell.`
export const NO_SUMMARY_STATEMENT =
  "No summary of the earlier conversation could be produced, so nothing here says what the work means or where it stands. What follows was extracted mechanically from it."
export const NO_SUMMARY_ADVICE = `Before you rely on anything from the earlier conversation, look it up with ${HISTORY_SEARCH} and ${HISTORY_READ}.`
export const LAST_WORDS_HEADING = "## The assistant's last messages before this checkpoint (verbatim, oldest first)"
export const CONTINUE_SENTENCE =
  "The work was in progress when this checkpoint was taken. Continue it from where it stood; do not start over, and do not ask the user to repeat what is quoted above."

/** With no summary, its token budget goes to the mechanical parts. */
export const FALLBACK_CHECKPOINT_LIMITS: CheckpointLimits = {
  ...DEFAULT_CHECKPOINT_LIMITS,
  indexTokens: 2_500,
  userTokens: 2_600,
}
/** Tokens of the assistant's last words in a checkpoint without a summary. */
const LAST_WORDS_TOKENS = 600

export function buildCheckpoint(input: CheckpointInput): Checkpoint {
  const tools = input.historyTools !== false
  const limits = input.limits ?? (input.summary === null ? FALLBACK_CHECKPOINT_LIMITS : DEFAULT_CHECKPOINT_LIMITS)
  const messages = input.earlier.filter((message) => message.kind !== "compaction")
  const index = extractIdentifiers(messages, limits)
  const quotes = quoteUserMessages(messages, limits, tools)
  const text = [
    CHECKPOINT_HEADER,
    ...(input.summary === null ? [NO_SUMMARY_STATEMENT, lastWords(messages)] : [input.summary.trim()]),
    renderIndex(index),
    quotes.text,
    input.inProgress === true ? CONTINUE_SENTENCE : "",
    tools ? (input.summary === null ? `${HISTORY_SENTENCE} ${NO_SUMMARY_ADVICE}` : HISTORY_SENTENCE) : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n")
  return { text, tokens: estimateTokens(text), index, quoted: quotes.quoted, unquoted: quotes.unquoted }
}

/** The last pieces of text the assistant wrote, newest first until the budget is spent, printed oldest first. */
function lastWords(messages: readonly Message[]): string {
  const said = messages.flatMap((message) =>
    message.kind === "assistant" ? messagePieces(message).flatMap((piece) => (piece.role === "assistant" ? [{ seq: message.seq, text: piece.text.trim() }] : [])) : [],
  )
  const chosen: string[] = []
  let spent = estimateTokens(LAST_WORDS_HEADING)
  for (const entry of said.reverse()) {
    const block = `[seq ${entry.seq}] ${clip(entry.text, 1_200)}`
    const cost = estimateTokens(block) + 1
    if (spent + cost > LAST_WORDS_TOKENS) break
    spent += cost
    chosen.unshift(block)
  }
  return chosen.length === 0 ? "" : [LAST_WORDS_HEADING, ...chosen].join("\n")
}

// ---- the identifier index ----

interface Seen {
  readonly first: number
  last: number
  /** Seen where the user or the model named it (a tool's arguments, a message), not only in tool output. */
  strong: boolean
  /** For commands: the outcome of each run, in order. */
  readonly outcomes: string[]
}

/**
 * Extracts identifiers from messages, deterministically. Within each kind,
 * when there are too many, entries the user or the model named themselves
 * (in a message or in a tool's arguments) win over entries seen only in tool
 * output, which is mostly noise such as search results; within each group the
 * most recently seen win. The result lists them in order of first appearance,
 * and the whole index fits `indexTokens`.
 */
export function extractIdentifiers(messages: readonly Message[], limits: CheckpointLimits = DEFAULT_CHECKPOINT_LIMITS): IdentifierIndex {
  const found = Object.fromEntries(IDENTIFIER_KINDS.map((kind) => [kind, new Map<string, Seen>()])) as Record<IdentifierKind, Map<string, Seen>>
  let clock = 0
  const note = (kind: IdentifierKind, raw: string, strong: boolean, outcome?: string) => {
    const value = clip(raw.trim(), limits.entryChars)
    if (value === "") return
    clock += 1
    const seen = found[kind].get(value)
    if (seen === undefined) found[kind].set(value, { first: clock, last: clock, strong, outcomes: outcome === undefined ? [] : [outcome] })
    else {
      seen.last = clock
      seen.strong ||= strong
      if (outcome !== undefined) seen.outcomes.push(outcome)
    }
  }

  for (const message of messages) {
    if (message.kind === "assistant" && message.status !== "running" && message.status !== "refused") {
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue
        const args = parseArguments(part.input)
        const fields = args.ok && args.value !== null && typeof args.value === "object" && !Array.isArray(args.value) ? args.value : {}
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value !== "string") continue
          if (PATH_KEYS.has(key)) note("files", value, true)
          if (COMMAND_KEYS.has(key) && part.state.status === "settled") note("commands", value, true, commandOutcome(part.state.outcome, part.state.output))
        }
      }
    }
    for (const piece of messagePieces(message))
      scanText(piece.text, piece.role === "tool" || piece.role === "user", (kind, value) => note(kind, value, piece.role !== "tool"))
  }

  const chosen = IDENTIFIER_KINDS.map((kind) => {
    const entries = [...found[kind].entries()]
      .sort((a, b) => Number(b[1].strong) - Number(a[1].strong) || b[1].last - a[1].last)
      .slice(0, limits.perCategory[kind])
    return entries.map(([value, seen]) => ({ kind, value: kind === "commands" ? renderCommand(value, seen.outcomes) : value, seen }))
  }).flat()
  // Drop entries until the index fits its budget: tool-output-only ones first, the least recently seen first.
  const byRecency = [...chosen].sort((a, b) => Number(a.seen.strong) - Number(b.seen.strong) || a.seen.last - b.seen.last)
  const kept = new Set(chosen)
  for (const entry of byRecency) {
    if (estimateTokens(renderIndex(group(kept))) <= limits.indexTokens) break
    kept.delete(entry)
  }
  return group(kept)
}

function group(entries: Iterable<{ kind: IdentifierKind; value: string; seen: Seen }>): IdentifierIndex {
  const list = [...entries]
  return Object.fromEntries(
    IDENTIFIER_KINDS.map((kind) => [
      kind,
      list
        .filter((entry) => entry.kind === kind)
        .sort((a, b) => a.seen.first - b.seen.first)
        .map((entry) => entry.value),
    ]),
  ) as Record<IdentifierKind, string[]>
}

const LABELS: Record<IdentifierKind, string> = {
  files: "Files",
  commands: "Commands (outcome of each run, in order)",
  errors: "Errors",
  commits: "Commits",
  tests: "Failing tests",
}

export function renderIndex(index: IdentifierIndex): string {
  const sections = IDENTIFIER_KINDS.filter((kind) => index[kind].length > 0).map(
    (kind) => `${LABELS[kind]}:\n${index[kind].map((entry) => `- ${entry}`).join("\n")}`,
  )
  return sections.length === 0 ? "" : [INDEX_HEADING, ...sections].join("\n")
}

const PATH_KEYS = new Set(["path", "file", "file_path", "filePath", "filename"])
const COMMAND_KEYS = new Set(["command", "cmd"])

function commandOutcome(outcome: string, output: string): string {
  if (outcome === "not_started") return "not run"
  if (outcome === "effect_unknown") return "outcome unknown"
  const status = /\[(Exit code (-?\d+)|Timed out[^\]]*|Killed by signal (\w+)|Interrupted[^\]]*)\]\s*$/.exec(output)
  if (status === null) return outcome === "success" ? "exit 0" : "error"
  if (status[2] !== undefined) return `exit ${status[2]}`
  if (status[3] !== undefined) return `signal ${status[3]}`
  return status[1]!.startsWith("Timed out") ? "timed out" : "interrupted"
}

/** `` `bun test` → exit 1 ×2, exit 0 ``: runs of the same outcome are collapsed. */
function renderCommand(command: string, outcomes: readonly string[]): string {
  const runs: { outcome: string; count: number }[] = []
  for (const outcome of outcomes) {
    const last = runs[runs.length - 1]
    if (last?.outcome === outcome) last.count += 1
    else runs.push({ outcome, count: 1 })
  }
  const shown = runs.length > 6 ? [{ outcome: "…", count: 1 }, ...runs.slice(-5)] : runs
  const list = shown.map((run) => (run.count === 1 ? run.outcome : `${run.outcome} ×${run.count}`)).join(", ")
  return `\`${command}\`${list === "" ? "" : ` → ${list}`}`
}

const URL = /\bhttps?:\/\/\S+/g
const PATH = /(?<![\w./:@-])(?:~\/|\.{1,2}\/|\/)?(?:[\w@+-][\w.@+-]*\/)+[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?(?![\w/])/g
const COMMIT = /(?<![\w-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w-])/g
const ERROR_LINE = /\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception)\b:|\berror(?:\[[\w-]+\])?:|\berror TS\d+|\bpanicked\b|^\s*(?:FATAL|fatal|ERROR)\b/
const FAILING_TEST = /^\s*(?:\(fail\)|✗|×|✕|--- FAIL:|FAILED|not ok \d+)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/

function scanText(text: string, outputLike: boolean, note: (kind: IdentifierKind, value: string) => void) {
  const plain = text.replace(URL, " ")
  for (const match of plain.matchAll(PATH)) {
    // "src/a.ts line 42" and "src/a.ts, line 42" are recorded as "src/a.ts:42".
    const line = /^,?\s+(?:at\s+|on\s+)?line\s+(\d+)\b/.exec(plain.slice(match.index + match[0].length))
    note("files", line === null || match[0].includes(":") ? match[0] : `${match[0]}:${line[1]}`)
  }
  for (const match of plain.matchAll(COMMIT)) note("commits", match[0])
  if (!outputLike) return
  for (const line of plain.split("\n")) {
    const test = FAILING_TEST.exec(line)
    if (test !== null) note("tests", test[1]!)
    if (ERROR_LINE.test(line)) note("errors", line)
  }
}

function clip(value: string, chars: number) {
  return value.length <= chars ? value : `${value.slice(0, chars - 1)}…`
}

// ---- the user's messages ----

function quoteUserMessages(messages: readonly Message[], limits: CheckpointLimits, tools: boolean) {
  const users = messages.flatMap((message) => {
    if (message.kind !== "user") return []
    const text = messagePieces(message)
      .map((piece) => piece.text)
      .join("")
      .trim()
    return text === "" ? [] : [{ seq: message.seq, text: shorten(text, message.seq, limits.perUserMessageTokens, tools) }]
  })
  const chosen: typeof users = []
  let spent = estimateTokens(QUOTES_HEADING)
  for (const user of [...users].reverse()) {
    const block = quote(user)
    const cost = estimateTokens(block) + 1
    if (spent + cost > limits.userTokens) break
    spent += cost
    chosen.unshift(user)
  }
  const unquoted = users.length - chosen.length
  if (chosen.length === 0) return { text: "", quoted: [], unquoted }
  const note =
    unquoted === 0 ? [] : [
          `(${unquoted} earlier user message${unquoted === 1 ? " is" : "s are"} not quoted here${tools ? `; ${HISTORY_SEARCH} finds ${unquoted === 1 ? "it" : "them"}` : ""}.)`,
        ]
  return { text: [QUOTES_HEADING, ...note, ...chosen.map(quote)].join("\n"), quoted: chosen.map((user) => user.seq), unquoted }
}

function quote(user: { seq: number; text: string }) {
  return `[seq ${user.seq}]\n${user.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`
}

/** Cuts the middle of a long message, saying how much was left out and where the whole is. */
function shorten(text: string, seq: number, maxTokens: number, tools: boolean) {
  if (estimateTokens(text) <= maxTokens) return text
  const chars = Math.max(200, Math.floor(maxTokens * 3.2))
  const head = text.slice(0, Math.floor(chars * 0.6))
  const tail = text.slice(text.length - Math.floor(chars * 0.4))
  const where = tools ? `; ${HISTORY_READ} seq ${seq} has the whole message` : ""
  return `${head}\n[… ${text.length - head.length - tail.length} characters left out${where} …]\n${tail}`
}
