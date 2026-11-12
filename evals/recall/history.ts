/**
 * `history_search` and `history_read` for the evaluation, over a generated
 * session held in memory: a simple deterministic text search. The engine's
 * implementation over the event log comes later and uses the same shapes and
 * renderers from `packages/core/src/context/history-tools.ts`.
 */
import {
  HISTORY_LIMITS,
  HISTORY_READ,
  HISTORY_SEARCH,
  type HistoryReadInput,
  type HistoryReadOutput,
  type HistorySearchHit,
  type HistorySearchInput,
  type HistorySearchOutput,
  messagePieces,
  messageReadText,
  messageRole,
  parseHistoryReadInput,
  parseHistorySearchInput,
  renderReadOutput,
  renderSearchOutput,
} from "../../packages/core/src/context/history-tools.ts"
import type { Message } from "../../packages/core/src/message/message.ts"

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from had has have how i in is it its me my of on or our that the this to was we were what when where which who why with you your".split(" "),
)

export class HistoryIndex {
  private readonly documents: { message: Message; text: string; lower: string }[]

  constructor(messages: readonly Message[]) {
    this.documents = messages
      .filter((message) => message.excluded === null && message.kind !== "compaction")
      .map((message) => {
        const text = messageReadText(message)
        return { message, text, lower: text.toLowerCase() }
      })
  }

  search(input: HistorySearchInput): HistorySearchOutput {
    const terms = queryTerms(input.query)
    const limit = input.limit ?? HISTORY_LIMITS.defaultHits
    const documents = this.documents.filter((document) => input.role === undefined || roles(document.message).includes(input.role))
    // Rarer terms weigh more; a quoted phrase weighs as much as three words.
    const weight = new Map(
      terms.map((term) => {
        const frequency = documents.filter((document) => document.lower.includes(term.text)).length
        return [term.text, Math.log(1 + documents.length / (1 + frequency)) * (term.phrase ? 3 : 1)]
      }),
    )
    const scored = documents.flatMap((document) => {
      const found = terms.filter((term) => document.lower.includes(term.text))
      if (found.length === 0) return []
      const score = found.reduce((sum, term) => sum + weight.get(term.text)!, 0)
      const best = [...found].sort((a, b) => weight.get(b.text)! - weight.get(a.text)!)[0]!
      return [{ document, score, best }]
    })
    scored.sort((a, b) => b.score - a.score || a.document.message.seq - b.document.message.seq)
    const hits = scored.slice(0, limit).map(({ document, best }): HistorySearchHit => hit(document.message, best.text))
    return { query: input.query, hits, matched: scored.length }
  }

  read(input: HistoryReadInput): HistoryReadOutput | null {
    const document = this.documents.find((candidate) => candidate.message.seq === input.seq)
    if (document === undefined) return null
    const offset = Math.min(input.offset ?? 0, document.text.length)
    const limit = input.limit ?? HISTORY_LIMITS.defaultReadChars
    const text = document.text.slice(offset, offset + limit)
    const end = offset + text.length
    return {
      seq: document.message.seq,
      role: messageRole(document.message),
      tool: null,
      text,
      offset,
      totalChars: document.text.length,
      nextOffset: end < document.text.length ? end : null,
    }
  }

  /** Runs one tool call by name and argument text, returning the tool result text. */
  call(name: string, input: string): string {
    if (name === HISTORY_SEARCH) {
      const parsed = parseHistorySearchInput(input)
      return parsed.ok ? renderSearchOutput(this.search(parsed.value)) : `Error: ${parsed.problem}`
    }
    if (name === HISTORY_READ) {
      const parsed = parseHistoryReadInput(input)
      if (!parsed.ok) return `Error: ${parsed.problem}`
      const output = this.read(parsed.value)
      return output === null ? `Error: no message has seq ${parsed.value.seq}` : renderReadOutput(output)
    }
    return `Error: unknown tool ${name}`
  }
}

function queryTerms(query: string) {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((match) => ({ text: match[1]!.toLowerCase(), phrase: true }))
  const words = query
    .replace(/"[^"]*"/g, " ")
    .toLowerCase()
    .split(/[^\w./:@+-]+/)
    .map((word) => word.replace(/^[.:-]+|[.:-]+$/g, ""))
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word))
    .map((word) => ({ text: word, phrase: false }))
  const unique = new Map([...phrases, ...words].map((term) => [term.text, term]))
  return [...unique.values()]
}

function roles(message: Message) {
  return messagePieces(message).map((piece) => piece.role)
}

/** The snippet comes from the piece that holds the best term, centred on its first occurrence. */
function hit(message: Message, term: string): HistorySearchHit {
  const pieces = messagePieces(message)
  const piece = pieces.find((candidate) => candidate.text.toLowerCase().includes(term)) ?? pieces[0]!
  const at = piece.text.toLowerCase().indexOf(term)
  const width = HISTORY_LIMITS.snippetChars
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), piece.text.length - width))
  const end = Math.min(piece.text.length, start + width)
  const snippet = `${start > 0 ? "…" : ""}${piece.text.slice(start, end).replace(/\s+/g, " ")}${end < piece.text.length ? "…" : ""}`
  return { seq: message.seq, role: piece.role, tool: piece.tool, snippet }
}
