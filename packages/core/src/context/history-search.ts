/**
 * The search and the read behind the history tools, without storage: how a
 * query is split into terms, how terms become a full-text query, where in a
 * message a hit is and what its snippet says, and a plain scan that needs no
 * index. The store (`store/history-index.ts`) finds the matching messages
 * with SQLite's full-text search and comes here for everything else; where
 * that search is not available, or finds nothing, the scan answers.
 *
 * Everything here is pure and deterministic.
 */
import type { Message } from "../message/message.ts"
import {
  HISTORY_LIMITS,
  type HistoryReadInput,
  type HistoryReadOutput,
  type HistoryRole,
  type HistorySearchHit,
  type HistorySearchInput,
  type HistorySearchOutput,
  type MessagePiece,
  messagePieces,
  messageRole,
} from "./history-tools.ts"

/** One thing a query asks for: a word, or a quoted phrase that must match as written. Lower case. */
export interface QueryTerm {
  readonly text: string
  readonly phrase: boolean
}

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from had has have how i in is it its me my of on or our that the this to was we were what when where which who why with you your".split(" "),
)

/** The terms of a query: quoted phrases first, then the remaining words without the ones that say nothing. No duplicates. */
export function queryTerms(query: string): QueryTerm[] {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((match) => ({ text: match[1]!.trim().toLowerCase(), phrase: true }))
  const words = query
    .replace(/"[^"]*"/g, " ")
    .replace(/"/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./:@+#~-]+/u)
    .map((word) => word.replace(/^[.:/+-]+|[.:,;+-]+$/g, ""))
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word))
    .map((word) => ({ text: word, phrase: false }))
  const unique = new Map([...phrases, ...words].filter((term) => term.text !== "").map((term) => [term.text, term]))
  return [...unique.values()]
}

/**
 * The terms as an FTS5 query. Every term is a quoted string, so nothing in it
 * is read as query syntax; the tokenizer splits an identifier such as
 * `src/config/schema.ts` into a phrase of its parts, which matches the same
 * identifier in the text. A plain word of three letters or more matches as a
 * prefix (`fail` finds `failed` and `failing`). `all` asks for every term,
 * `any` for at least one. `null` when no term has anything a tokenizer keeps.
 */
export function ftsQuery(terms: readonly QueryTerm[], mode: "all" | "any"): string | null {
  const parts = terms
    .filter((term) => /[\p{L}\p{N}]/u.test(term.text))
    .map((term) => `"${term.text.replace(/"/g, '""')}"${!term.phrase && term.text.length >= 3 && /^[\p{L}\p{N}]+$/u.test(term.text) ? "*" : ""}`)
  return parts.length === 0 ? null : parts.join(mode === "all" ? " AND " : " OR ")
}

/** Where each piece of a message starts in the text `history_read` returns for it (`messageReadText`). */
export function pieceOffsets(pieces: readonly MessagePiece[]): number[] {
  const offsets: number[] = []
  let at = 0
  for (const piece of pieces) {
    offsets.push(at)
    at += piece.text.length + 2
  }
  return offsets
}

/**
 * The hit for a message that matched: the piece that holds the first term
 * found (in the order given, so pass the terms most telling first), the
 * snippet around that term, and where it is in the message's text. `only`
 * restricts it to pieces of one role, and `piece` to one piece. A message
 * that matched through the tokenizer alone (a phrase written with other
 * separators) falls back to the start of its first eligible piece.
 */
export function locateHit(message: Message, terms: readonly QueryTerm[], only?: { readonly role?: HistoryRole; readonly piece?: number }): HistorySearchHit | null {
  const pieces = messagePieces(message)
  const offsets = pieceOffsets(pieces)
  const eligible = pieces
    .map((piece, index) => ({ piece, index, lower: piece.text.toLowerCase() }))
    .filter((entry) => (only?.role === undefined || entry.piece.role === only.role) && (only?.piece === undefined || entry.index === only.piece))
  if (eligible.length === 0) return null
  for (const term of terms) {
    for (const entry of eligible) {
      const at = entry.lower.indexOf(term.text)
      if (at !== -1) return hit(message, entry.piece, offsets[entry.index]!, at, term.text.length)
    }
  }
  const first = eligible[0]!
  return hit(message, first.piece, offsets[first.index]!, 0, 0)
}

function hit(message: Message, piece: MessagePiece, pieceOffset: number, at: number, length: number): HistorySearchHit {
  const width = HISTORY_LIMITS.snippetChars
  const start = Math.max(0, Math.min(at - Math.floor((width - length) / 3), piece.text.length - width))
  const end = Math.min(piece.text.length, start + width)
  const snippet = `${start > 0 ? "…" : ""}${piece.text.slice(start, end).replace(/\s+/g, " ").trim()}${end < piece.text.length ? "…" : ""}`
  return { seq: message.seq, role: piece.role, tool: piece.tool, snippet, offset: pieceOffset + at }
}

/**
 * The search without an index: every message is scanned for the terms as
 * substrings. Rarer terms weigh more and a quoted phrase weighs as much as
 * three words; ties are in `seq` order. It also finds what a tokenizer
 * cannot: a term inside a longer word. `messages` are the session's stored
 * messages; excluded ones, checkpoints and a step still running are skipped.
 */
export function scanSearch(messages: readonly Message[], input: HistorySearchInput): HistorySearchOutput {
  const terms = queryTerms(input.query)
  const limit = Math.min(input.limit ?? HISTORY_LIMITS.defaultHits, HISTORY_LIMITS.maxHits)
  const documents = messages
    .filter((message) => message.excluded === null && message.kind !== "compaction")
    .map((message) => ({
      message,
      lower: messagePieces(message)
        .filter((piece) => input.role === undefined || piece.role === input.role)
        .map((piece) => piece.text.toLowerCase()),
    }))
    .filter((document) => document.lower.length > 0)
  const holds = (document: (typeof documents)[number], term: QueryTerm) => document.lower.some((text) => text.includes(term.text))
  const weight = new Map(
    terms.map((term) => {
      const frequency = documents.filter((document) => holds(document, term)).length
      return [term.text, Math.log(1 + documents.length / (1 + frequency)) * (term.phrase ? 3 : 1)]
    }),
  )
  const scored = documents.flatMap((document) => {
    const found = terms.filter((term) => holds(document, term))
    if (found.length === 0) return []
    const best = [...found].sort((a, b) => weight.get(b.text)! - weight.get(a.text)!)
    return [{ document, score: found.reduce((sum, term) => sum + weight.get(term.text)!, 0), best }]
  })
  scored.sort((a, b) => b.score - a.score || a.document.message.seq - b.document.message.seq)
  const hits = scored.slice(0, limit).flatMap(({ document, best }) => {
    const found = locateHit(document.message, best, input.role === undefined ? undefined : { role: input.role })
    return found === null ? [] : [found]
  })
  return { query: input.query, hits, matched: scored.length }
}

/** What `history_read` returns for a stored message, with the messages around it. */
export function readHistory(message: Message, neighbours: { readonly previousSeq: number | null; readonly nextSeq: number | null }, input: HistoryReadInput): HistoryReadOutput {
  const whole = messagePieces(message)
    .map((piece) => piece.text)
    .join("\n\n")
  const offset = Math.min(input.offset ?? 0, whole.length)
  const limit = Math.min(input.limit ?? HISTORY_LIMITS.defaultReadChars, HISTORY_LIMITS.maxReadChars)
  const text = whole.slice(offset, offset + limit)
  const end = offset + text.length
  return {
    seq: message.seq,
    role: messageRole(message),
    tool: null,
    text,
    offset,
    totalChars: whole.length,
    nextOffset: end < whole.length ? end : null,
    previousSeq: neighbours.previousSeq,
    nextSeq: neighbours.nextSeq,
  }
}

/** Whether a stored message can be read or searched: not excluded, not a checkpoint, and not a step that is still running. */
export function readable(message: Message): boolean {
  return message.excluded === null && message.kind !== "compaction" && !(message.kind === "assistant" && (message.status === "running" || message.status === "refused"))
}
