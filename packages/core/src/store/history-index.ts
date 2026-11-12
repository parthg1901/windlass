/**
 * Full-text search over a session's stored messages, for the history tools.
 *
 * The index is derived data, like the session listing's cache: it is built
 * from the `message` rows, never read by the reducer, and can be dropped at
 * any time. It lives in the session's own database, in three tables this file
 * creates on first use:
 *
 *   history_fts     an FTS5 table without content (the text is already in the
 *                   message rows and in the log; a third copy would be waste)
 *   history_piece   one row per indexed piece of a message (its text, one
 *                   tool call's input, one tool call's result): which message,
 *                   which piece, whose it is. Its id is the FTS row's id.
 *   history_index   per session: how far the index reaches, and its version
 *
 * How it stays in step with the log: lazily. Nothing is done when an event
 * is appended, so a session that never searches pays nothing, and the append
 * path stays what it was. A search first indexes, in one transaction, every
 * message created since the last search that can no longer change: messages
 * only ever enter at the end of the log, and only the newest one can still be
 * running (the step that is asking), so "every finished message after the
 * last indexed one, up to the first that is still running" is everything.
 * The first search of a long session indexes all of it once (about 20 ms per
 * megabyte of text); every later one only what was added.
 *
 * Exclusions are not in the index. A revert, its undo and a refusal only flip
 * a flag on message rows, so the search joins the `message` table and leaves
 * out what is excluded at the moment it is asked.
 *
 * The tokenizer splits text at everything that is not a letter or a digit,
 * so `src/config/schema.ts:42` is the token run `src config schema ts 42`
 * and is found as that phrase; plain words match as prefixes. What a
 * tokenizer cannot find (a term inside a longer word), and everything when
 * this SQLite build has no FTS5 or the connection is read-only, is found by
 * scanning the messages (`scanSearch`): slower, and needs nothing.
 */
import type { Database } from "bun:sqlite"
import { ftsQuery, locateHit, queryTerms, readable, scanSearch } from "../context/history-search.ts"
import { HISTORY_LIMITS, type HistoryRole, type HistorySearchHit, type HistorySearchInput, type HistorySearchOutput, messagePieces } from "../context/history-tools.ts"
import type { Message } from "../message/message.ts"

/** Bump when the tables, the tokenizer or what is indexed changes: an index of another version is dropped and built again. */
export const HISTORY_INDEX_VERSION = 1

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS history_index (
  session_id  TEXT PRIMARY KEY,
  through_seq INTEGER NOT NULL,
  version     INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS history_piece (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  piece      INTEGER NOT NULL,
  role       TEXT NOT NULL,
  tool       TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS history_piece_message ON history_piece (session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='', tokenize="unicode61 remove_diacritics 2");
`

/** How many matching pieces one query looks at before it ranks by message. */
const CANDIDATES = 400

export interface MessageAt {
  /** The readable message created at that `seq`, or `null` when there is none (no message, an excluded one, a checkpoint, a running step). */
  readonly message: Message | null
  /** The nearest readable messages before and after that `seq`. */
  readonly previousSeq: number | null
  readonly nextSeq: number | null
}

export interface HistoryIndexOptions {
  /** A connection that must not write: every search scans. */
  readonly readOnly: boolean
  readonly decodeMessage: (sessionId: string, data: string) => Message
  /** Switches the full-text index off, as on a SQLite build without FTS5. For tests. */
  readonly disableFullText?: boolean
}

export interface HistoryIndex {
  readonly search: (sessionId: string, input: HistorySearchInput) => HistorySearchOutput
  readonly messageAt: (sessionId: string, seq: number) => MessageAt
  /** Whether searches use the full-text index (`false`: every search scans). Decided at the first search. */
  readonly fullText: () => boolean
}

export function createHistoryIndex(database: Database, options: HistoryIndexOptions): HistoryIndex {
  /** `null` until the first search tried to create the tables. */
  let available: boolean | null = options.readOnly || options.disableFullText === true ? false : null
  const decode = (sessionId: string, row: { data: string }) => options.decodeMessage(sessionId, row.data)

  const readableRows = database.query<{ seq: number; data: string }, [string, number]>(
    "SELECT seq, data FROM message WHERE session_id = ? AND seq > ? AND kind != 'compaction' ORDER BY seq",
  )
  const rowAt = database.query<{ data: string }, [string, number]>("SELECT data FROM message WHERE session_id = ? AND seq = ? AND excluded IS NULL AND kind != 'compaction'")
  // A step that is still running (or was refused) has nothing to read; it is at most the newest message.
  const before = database.query<{ seq: number; data: string }, [string, number]>(
    "SELECT seq, data FROM message WHERE session_id = ? AND seq < ? AND excluded IS NULL AND kind != 'compaction' ORDER BY seq DESC LIMIT 4",
  )
  const after = database.query<{ seq: number; data: string }, [string, number]>(
    "SELECT seq, data FROM message WHERE session_id = ? AND seq > ? AND excluded IS NULL AND kind != 'compaction' ORDER BY seq LIMIT 4",
  )
  const visible = database.query<{ data: string }, [string]>("SELECT data FROM message WHERE session_id = ? AND excluded IS NULL AND kind != 'compaction' ORDER BY seq")

  const prepare = (): boolean => {
    if (available !== null) return available
    try {
      database.run(TABLES_SQL)
      available = true
    } catch {
      // This SQLite build has no FTS5 (or the file cannot take the tables): the scan answers instead.
      available = false
    }
    return available
  }

  /** Brings the session's index up to its last finished message. One transaction; a crash inside it leaves the index as it was. */
  const update = database.transaction((sessionId: string) => {
    const state = database.query<{ through_seq: number; version: number }, [string]>("SELECT through_seq, version FROM history_index WHERE session_id = ?").get(sessionId)
    if (state !== null && state.version !== HISTORY_INDEX_VERSION) {
      // Rows of a table without content cannot be taken out one session at a time: every session's index goes and is built again on its next search.
      database.run("DROP TABLE history_fts")
      database.run("DELETE FROM history_piece")
      database.run("DELETE FROM history_index")
      database.run(TABLES_SQL)
    }
    const from = state !== null && state.version === HISTORY_INDEX_VERSION ? state.through_seq : 0
    const addPiece = database.query<{ id: number }, [string, number, number, string, string | null]>(
      "INSERT INTO history_piece (session_id, seq, piece, role, tool) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    const addText = database.query<unknown, [number, string]>("INSERT INTO history_fts (rowid, text) VALUES (?, ?)")
    let through = from
    for (const row of readableRows.all(sessionId, from)) {
      const message = decode(sessionId, row)
      // Still running: it, and anything after it, is indexed by a later search.
      if (message.kind === "assistant" && message.status === "running") break
      messagePieces(message).forEach((piece, index) => {
        if (piece.text === "") return
        const added = addPiece.get(sessionId, message.seq, index, piece.role, piece.tool)!
        addText.run(added.id, piece.text)
      })
      through = message.seq
    }
    if (through !== from || state === null || state.version !== HISTORY_INDEX_VERSION)
      database.run("INSERT INTO history_index (session_id, through_seq, version) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET through_seq = excluded.through_seq, version = excluded.version", [
        sessionId,
        through,
        HISTORY_INDEX_VERSION,
      ])
  })

  const scan = (sessionId: string, input: HistorySearchInput) => scanSearch(visible.all(sessionId).map((row) => decode(sessionId, row)), input)

  const search = (sessionId: string, input: HistorySearchInput): HistorySearchOutput => {
    if (!prepare()) return scan(sessionId, input)
    const terms = queryTerms(input.query)
    const any = ftsQuery(terms, "any")
    if (any === null) return scan(sessionId, input)
    const limit = Math.min(input.limit ?? HISTORY_LIMITS.defaultHits, HISTORY_LIMITS.maxHits)
    try {
      update.immediate(sessionId)
      const role = input.role ?? null
      const pieces = database.query<{ seq: number; piece: number; rank: number }, [string, string, string | null, string | null, number]>(
        `SELECT p.seq AS seq, p.piece AS piece, bm25(history_fts) AS rank
         FROM history_fts JOIN history_piece p ON p.id = history_fts.rowid
         JOIN message m ON m.session_id = p.session_id AND m.seq = p.seq
         WHERE history_fts MATCH ? AND p.session_id = ? AND m.excluded IS NULL AND (? IS NULL OR p.role = ?)
         ORDER BY rank LIMIT ?`,
      )
      const count = database.query<{ matched: number }, [string, string, string | null, string | null]>(
        `SELECT count(DISTINCT p.seq) AS matched
         FROM history_fts JOIN history_piece p ON p.id = history_fts.rowid
         JOIN message m ON m.session_id = p.session_id AND m.seq = p.seq
         WHERE history_fts MATCH ? AND p.session_id = ? AND m.excluded IS NULL AND (? IS NULL OR p.role = ?)`,
      )
      // Messages that hold every term come first, then the ones that hold some; within each, the best-ranked piece decides.
      const all = terms.length > 1 ? ftsQuery(terms, "all") : null
      const ranked = [...(all === null ? [] : pieces.all(all, sessionId, role, role, CANDIDATES)), ...pieces.all(any, sessionId, role, role, CANDIDATES)]
      const best = new Map<number, number>()
      for (const row of ranked) if (!best.has(row.seq)) best.set(row.seq, row.piece)
      const matched = count.get(any, sessionId, role, role)?.matched ?? 0
      if (matched === 0) return scan(sessionId, input)
      const hits = [...best].slice(0, limit).flatMap(([seq, piece]): HistorySearchHit[] => {
        const row = rowAt.get(sessionId, seq)
        if (row === null) return []
        const found = locateHit(decode(sessionId, row), terms, { piece, ...(input.role === undefined ? {} : { role: input.role as HistoryRole }) })
        return found === null ? [] : [found]
      })
      return { query: input.query, hits, matched }
    } catch {
      // A query the tokenizer cannot take, or an index that cannot be written right now: the scan needs neither.
      return scan(sessionId, input)
    }
  }

  const messageAt = (sessionId: string, seq: number): MessageAt => {
    const row = rowAt.get(sessionId, seq)
    const found = row === null ? null : decode(sessionId, row)
    const nearest = (rows: readonly { seq: number; data: string }[]) => rows.find((candidate) => readable(decode(sessionId, candidate)))?.seq ?? null
    return {
      message: found !== null && readable(found) ? found : null,
      previousSeq: nearest(before.all(sessionId, seq)),
      nextSeq: nearest(after.all(sessionId, seq)),
    }
  }

  return { search, messageAt, fullText: () => prepare() }
}
