/**
 * The `Store` on `bun:sqlite`.
 *
 * - The event table is the source of truth. `session`, `message` and `inbox`
 *   rows are written only by `append`, in the same `BEGIN IMMEDIATE`
 *   transaction as the events, from `projectionChanges(previous, next)`.
 * - The writer keeps the last projection of recently appended sessions in
 *   memory, because `projectionChanges` compares by identity: the previous
 *   projection must be the object `reduce` returned, never a copy. Before each
 *   append the cached `lastSeq` is checked against the row and the projection
 *   is reloaded from rows if they differ.
 * - Reads (`getProjection`, `readMessages`, ...) always read rows, never the
 *   writer's cache, so they show exactly what is durable.
 * - `getProjection` is what the step loop calls several times per step, so it
 *   does not read every row every time: it keeps the rows it last read for a
 *   session, decoded, with the `last_seq` they were read at, and brings them
 *   up to date from the rows that changed since. Every row says when it last
 *   changed (`message.changed_seq`, written by `append` with the row), and
 *   rows change only inside an append, which always moves `last_seq`. So an
 *   unchanged `last_seq` means unchanged rows, and otherwise the session
 *   row, the inbox and the message rows with a later `changed_seq` are read
 *   again. The cost of a read is then what the last appends changed, not the
 *   length of the log. `readMessages` and `readModelHistory` read every row
 *   they return, each time; the tests compare all three with a rebuild from
 *   the log.
 * - One writer per file, enforced at open by `acquireWriterLock`
 *   (`sqlite-lock.ts`): a second writer gets `StoreLockedError` at once.
 *   Other connections that touch the file (a reader, the sqlite3 shell) can
 *   hold SQLite's write lock briefly; a write waits for it at most
 *   `busyTimeoutMs` and then throws `StoreError` `locked`, having written nothing.
 * - No raw SQLite error leaves a write for a condition the contract names: a
 *   lock that is not released is `locked`, a reused request ID is
 *   `duplicate_request`, a file from another schema version is `schema_mismatch`.
 * - A fork whose parent is not in this file reads the inherited part of its
 *   log through `parentLog` (the session directory supplies it: the parent is
 *   another file). Only events at or before the fork point are ever asked
 *   for. They are committed and the log is append-only, so they never change,
 *   whoever is writing to the parent in the meantime.
 * - Media is not in the database: `putBlob` and `getBlob` go to a `BlobStore`
 *   (`blobs.ts`), which sessions and processes share.
 * - `readOnly` opens the file without the writer lock and without changing
 *   it, next to whoever writes it: WAL readers do not block the writer and
 *   see only committed transactions. Every write then throws `read_only`.
 */
import { Database, SQLiteError } from "bun:sqlite"
import { decodeEvent, encodeEventData, validateEvent } from "../event/decode.ts"
import type { NewEvent, StoredEvent } from "../event/durable.ts"
import { messageId, requestId, sessionId as sessionIdValidator, type SessionId } from "../id.ts"
import { type ModelHistory, projectionChanges } from "../message/history.ts"
import {
  type Message,
  type Projection,
  baseline,
  inboxItem,
  message,
  sessionState,
} from "../message/message.ts"
import { ReduceError, reduce } from "../message/reducer.ts"
import { providerErrorKind } from "../provider/error.ts"
import { usage } from "../provider/usage.ts"
import { canonicalJson } from "../request/canonical.ts"
import { blockHashes } from "../request/prefix.ts"
import {
  type Validator,
  integer,
  nonEmptyString,
  nullable,
  object,
  oneOf,
  optional,
} from "../validate.ts"
import { type BlobStore, createFileBlobStore, createMemoryBlobStore } from "./blobs.ts"
import { createHistoryIndex } from "./history-index.ts"
import { CONNECTION_PRAGMAS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts"
import { acquireWriterLock, isBusy } from "./sqlite-lock.ts"
import {
  type AppendOptions,
  type OpenStore,
  type OpenStoreOptions,
  type RequestFinish,
  type RequestRecord,
  type RequestStart,
  type SessionSummary,
  type Store,
  FIRST_PROMPT_CHARS,
  StoreError,
} from "./store.ts"

export { StoreLockedError } from "./sqlite-lock.ts"

export interface SqliteStoreOptions extends OpenStoreOptions {
  /**
   * How long a write waits for SQLite's write lock when some other
   * connection holds it, before it throws `StoreError` `locked`. Default 5000 ms.
   */
  readonly busyTimeoutMs?: number
  /** Called when a `subscribe` listener throws. Defaults to `console.error`. The append stays committed. */
  readonly onListenerError?: (error: unknown) => void
  /** Where media goes. Defaults to memory for a store in memory, and to the directory `<path>-blobs` for a file. */
  readonly blobs?: BlobStore
  /**
   * Reads the effective log of a session that is not in this file: the parent
   * of a fork, when every session has its own file. Returns its events with
   * `seq` in `(afterSeq, afterSeq + limit]`, in order, and throws `StoreError`
   * `parent_missing` when that session cannot be found. Without it a parent
   * must be in this file.
   */
  readonly parentLog?: (sessionId: SessionId, range: { readonly afterSeq: number; readonly limit: number }) => readonly StoredEvent[]
  /** Open without the writer lock and without writing anything, next to the process that writes the file. */
  readonly readOnly?: boolean
  /** Search messages by scanning them, without the full-text index: what a SQLite build without FTS5 does. For tests. */
  readonly disableFullTextSearch?: boolean
}

export interface SqliteStore extends Store {
  /** The connection, for tests and diagnostics. Never write through it: only `append` changes session state. */
  readonly database: Database
  /** Whether `searchMessages` uses the full-text index; `false` when this SQLite build has no FTS5 or the store only reads. */
  readonly fullTextSearch: () => boolean
}

/** The database was created by a different schema version, or is not a store database. A `StoreError` with code `schema_mismatch`. */
export class StoreSchemaError extends StoreError {
  constructor(message: string) {
    super("schema_mismatch", message)
    this.name = "StoreSchemaError"
  }
}

/** Runs a write and reports a lock that was not released in time as the store's own error. */
function writing<T>(what: string, write: () => T): T {
  try {
    return write()
  } catch (error) {
    if (isBusy(error))
      throw new StoreError("locked", `${what}: the database is locked by another writer; nothing was written`, { cause: error })
    throw error
  }
}

/** How many sessions' projections the writer keeps in memory. A miss only costs a reload from rows. */
const CACHED_SESSIONS = 32

export const openSqliteStore = (options: SqliteStoreOptions): SqliteStore => {
  const now = options.now ?? Date.now
  const onListenerError = options.onListenerError ?? ((error: unknown) => console.error("store listener failed:", error))
  const inMemory = options.path === ":memory:" || options.path === ""
  const readOnly = options.readOnly === true
  const lock = inMemory || readOnly ? null : acquireWriterLock(options.path)
  const database = readOnly
    ? openReader(options.path, options.busyTimeoutMs ?? 5000)
    : openDatabase(options.path, inMemory, options.busyTimeoutMs ?? 5000, lock)
  const sql = prepare(database)
  const blobs = options.blobs ?? (inMemory ? createMemoryBlobStore() : createFileBlobStore(`${options.path}-blobs`))
  const writable = (what: string) => {
    if (readOnly) throw new StoreError("read_only", `${what}: ${options.path} is open for reading only`)
  }
  const history = createHistoryIndex(database, { readOnly, decodeMessage, ...(options.disableFullTextSearch ? { disableFullText: true } : {}) })
  const cache = new Map<SessionId, Projection>()
  /** What `getProjection` last read of each session, by rows: see `readProjection`. */
  const read = new Map<string, ReadState>()
  const listeners = new Set<(events: readonly StoredEvent[]) => void>()

  const remember = (id: SessionId, projection: Projection) => {
    cache.delete(id)
    cache.set(id, projection)
    if (cache.size > CACHED_SESSIONS) cache.delete(cache.keys().next().value!)
  }

  /** Every row of a session, read and decoded. */
  const loadProjection = (id: string): Projection | null => {
    const row = sql.session.get(id)
    if (row === null) return null
    return {
      lastSeq: row.last_seq,
      updatedAt: row.time_updated,
      session: decodeJson(sessionState, row.state, `session ${id} state`),
      baseline: row.baseline === null ? null : decodeJson(baseline, row.baseline, `session ${id} baseline`),
      messages: sql.messages.all(id, Number.MAX_SAFE_INTEGER, -1).map((data) => decodeMessage(id, data.data)),
      inbox: sql.inbox.all(id).map((data) => decodeJson(inboxItem, data.data, `session ${id} inbox item`)),
    }
  }

  /**
   * The session's state from its rows, reading only the rows that changed
   * since the last read. All of it is read inside one transaction, so a
   * reader beside a writer sees one committed state and never half of two.
   */
  const readProjection = database.transaction((id: string): Projection | null => {
    const row = sql.session.get(id)
    if (row === null) {
      read.delete(id)
      return null
    }
    const known = read.get(id)
    // Rows change only inside an append, and an append always moves `last_seq`.
    if (known !== undefined && known.projection.lastSeq === row.last_seq) return known.projection
    if (known === undefined || known.projection.lastSeq > row.last_seq) {
      const projection = loadProjection(id)!
      remembered(id, { projection, state: row.state, baseline: row.baseline })
      return projection
    }
    const previous = known.projection
    const changed = sql.changedMessages.all(id, previous.lastSeq).map((data) => decodeMessage(id, data.data))
    const projection: Projection = {
      lastSeq: row.last_seq,
      updatedAt: row.time_updated,
      // The same text is the same state: the object decoded from it stands.
      session: row.state === known.state ? previous.session : decodeJson(sessionState, row.state, `session ${id} state`),
      baseline: row.baseline === known.baseline ? previous.baseline : row.baseline === null ? null : decodeJson(baseline, row.baseline, `session ${id} baseline`),
      messages: changed.length === 0 ? previous.messages : mergeBySeq(previous.messages, changed),
      inbox: sql.inbox.all(id).map((data) => decodeJson(inboxItem, data.data, `session ${id} inbox item`)),
    }
    remembered(id, { projection, state: row.state, baseline: row.baseline })
    return projection
  })

  const remembered = (id: string, state: ReadState) => {
    read.delete(id)
    read.set(id, state)
    if (read.size > CACHED_SESSIONS) read.delete(read.keys().next().value!)
  }

  /** The projection the next append folds onto: the cached object when it is current, else rows. */
  const current = (id: SessionId, lastSeq: number): Projection => {
    const cached = cache.get(id)
    if (cached !== undefined && cached.lastSeq === lastSeq) return cached
    const loaded = loadProjection(id)
    if (loaded === null || loaded.lastSeq !== lastSeq) throw new Error(`session ${id} changed while it was being read`)
    return loaded
  }

  /** The state a new session's first event folds onto: the parent at `throughSeq` for a fork, else nothing. */
  const startingState = (first: NewEvent): Projection | null => {
    if (first.type !== "session.created" || first.data.lineage?.kind !== "fork") return null
    const parent = first.data.lineage.parentSessionId
    const through = first.data.lineage.throughSeq
    // The reducer rejects a fork whose parent is missing or shorter than `throughSeq`.
    const inherited =
      sql.head.get(parent) === null && options.parentLog !== undefined
        ? options.parentLog(parent, { afterSeq: 0, limit: through })
        : readEvents(parent, { limit: through })
    let state: Projection | null = null
    for (const event of inherited) state = reduce(state, event)
    return state
  }

  const write = (previous: Projection | null, next: Projection, events: readonly StoredEvent[]) => {
    const changes = projectionChanges(previous, next)
    const id = next.session.id
    // Rows hold canonical JSON, so a row written live and one rebuilt from the log are the same bytes.
    if (previous === null) sql.insertSession.run(...sessionColumns(next))
    if (previous !== null && changes.session !== null) sql.updateSession.run(...sessionStateColumns(next), id)
    if (previous !== null && changes.session === null) sql.touchSession.run(next.lastSeq, next.updatedAt, id)
    if (previous !== null && changes.baseline !== undefined)
      sql.updateBaseline.run(changes.baseline === null ? null : canonicalJson(changes.baseline), id)
    for (const changed of changes.messages)
      sql.upsertMessage.run(id, changed.seq, changed.id, changed.kind, changed.excluded, next.lastSeq, canonicalJson(changed))
    for (const item of changes.inbox) sql.upsertInbox.run(id, item.messageId, item.seq, item.delivery, canonicalJson(item))
    for (const removed of changes.inboxRemoved) sql.deleteInbox.run(id, removed)
    for (const event of events) sql.insertEvent.run(id, event.seq, event.type, event.v, event.time, encodeEventData(event))
  }

  const appendTransaction = database.transaction(
    (id: SessionId, events: readonly NewEvent[], options: AppendOptions) => {
      const head = sql.head.get(id)
      const lastSeq = head?.last_seq ?? 0
      if (options.expectedSeq !== undefined && options.expectedSeq !== lastSeq)
        throw new StoreError("seq_conflict", `session ${id} is at seq ${lastSeq}, not ${options.expectedSeq}`)
      const first = events[0]
      if (first === undefined) return null
      if (head === null && first.type !== "session.created")
        throw new StoreError("session_not_found", `session ${id} does not exist`)
      const previous = head === null ? null : current(id, lastSeq)
      let state = previous ?? startingState(first)
      const stored = events.map((event) => {
        const next: StoredEvent = { ...event, sessionId: id, seq: (state?.lastSeq ?? 0) + 1, time: clock() }
        state = reduce(state, next)
        return next
      })
      // A turn that ended for a queued item and that item's delivery are one decision: committed apart, a process
      // that died between them would leave a log whose only legal next event is the delivery, which recovery does
      // not make.
      const handover = state!.session.open?.kind === "handover" ? state!.session.open : null
      if (handover !== null)
        throw new ReduceError("invalid_transition", `the turn ended for queued item ${handover.messageId}: its delivery is in the same append`, stored.at(-1)!)
      write(previous, state!, stored)
      return { stored, state: state! }
    },
  )

  const clock = () => integer(0)(now(), "the store clock")

  const append: Store["append"] = (id, events, options = {}) => {
    sessionIdValidator(id, "sessionId")
    writable(`append to session ${id}`)
    // Validation is pure, so it runs before the transaction is opened.
    const validated = events.map((event) => validateEvent(event))
    const result = writing(`append to session ${id}`, () => appendTransaction.immediate(id, validated, options))
    if (result === null) return []
    remember(id, result.state)
    for (const listener of [...listeners]) {
      try {
        listener(result.stored)
      } catch (error) {
        onListenerError(error)
      }
    }
    return result.stored
  }

  const readEvents: Store["readEvents"] = (id, range = {}) => {
    const segments = lineage(sql, id, options.parentLog !== undefined)
    const afterSeq = range.afterSeq ?? 0
    let remaining = range.limit ?? Number.POSITIVE_INFINITY
    const events: StoredEvent[] = []
    for (const segment of segments) {
      if (remaining <= 0) break
      const from = Math.max(segment.after, afterSeq)
      if (segment.foreign) {
        // The inherited part, from the parent's own file: nothing past the fork point is asked for.
        if (from >= segment.through) continue
        const inherited = options.parentLog!(segment.id as SessionId, { afterSeq: from, limit: Math.min(remaining, segment.through - from) })
        events.push(...inherited)
        remaining -= inherited.length
        continue
      }
      const limit = remaining === Number.POSITIVE_INFINITY ? -1 : remaining
      const rows = sql.events.all(segment.id, from, segment.through, limit)
      for (const row of rows) events.push(decodeEvent(row))
      remaining -= rows.length
    }
    return events
  }

  const summary = (row: SessionRow): SessionSummary => ({
    session: decodeJson(sessionState, row.state, `session ${row.id} state`),
    lastSeq: row.last_seq,
    updatedAt: row.time_updated,
    firstPrompt: firstPrompt(row.id),
  })

  /** The beginning of the user's first prompt: the first user message in view, else the first one that waits. */
  const firstPrompt = (id: string): string | null => {
    const said = sql.firstUserMessage.get(id)
    const first = said === null ? null : decodeMessage(id, said.data)
    const content =
      first?.kind === "user"
        ? first.content
        : sql.inbox
            .all(id)
            .map((data) => decodeJson(inboxItem, data.data, `session ${id} inbox item`))
            .find((item) => item.origin === null)?.content
    if (content === undefined) return null
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .slice(0, FIRST_PROMPT_CHARS)
  }

  const readModelHistory: Store["readModelHistory"] = (id) => {
    const row = sql.session.get(id)
    if (row === null) throw new StoreError("session_not_found", `session ${id} does not exist`)
    const session = decodeJson(sessionState, row.state, `session ${id} state`)
    const history = {
      rootId: session.rootId,
      settings: session.settings,
      baseline: row.baseline === null ? null : decodeJson(baseline, row.baseline, `session ${id} baseline`),
    }
    const compaction = session.compaction
    const visible = sql.visibleMessages.all(id, compaction?.keepFromSeq ?? 0).map((data) => decodeMessage(id, data.data))
    if (compaction === null) return { ...history, messages: visible } satisfies ModelHistory
    const checkpoint = sql.messageById.get(id, compaction.messageId)
    if (checkpoint === null) throw new Error(`compaction message ${compaction.messageId} is missing`)
    return { ...history, messages: [decodeMessage(id, checkpoint.data), ...visible] } satisfies ModelHistory
  }

  const beginRequest: Store["beginRequest"] = (start) => {
    const checked = requestStart(start, "request")
    writable(`begin request ${checked.id}`)
    if (sql.head.get(checked.sessionId) === null)
      throw new StoreError("session_not_found", `session ${checked.sessionId} does not exist`)
    const row = writing(`begin request ${checked.id}`, () => {
      try {
        return sql.insertRequest.get(
          checked.id,
          checked.sessionId,
          checked.messageId,
          checked.attempt,
          checked.purpose,
          checked.model,
          checked.provider,
          JSON.stringify(checked.blocks),
          clock(),
        )
      } catch (error) {
        // `request.id` is the only unique column an insert can collide on (`ordinal` is assigned).
        if (error instanceof SQLiteError && error.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new StoreError("duplicate_request", `request ${checked.id} is already in the ledger`, { cause: error })
        throw error
      }
    })
    return requestRecord(row!)
  }

  const finishRequest: Store["finishRequest"] = (id, finish) => {
    const checked = requestFinish(finish, "finish")
    writable(`finish request ${id}`)
    if ((checked.outcome === "error") !== (checked.errorKind !== null))
      throw new TypeError("errorKind is set exactly when the outcome is error")
    const row = writing(`finish request ${id}`, () =>
      sql.finishRequest.get(
        clock(),
        checked.outcome,
        checked.errorKind,
        checked.usage?.inputTokens ?? null,
        checked.usage?.cachedInputTokens ?? null,
        checked.usage?.outputTokens ?? null,
        checked.usage?.reasoningTokens ?? null,
        checked.usage?.cacheWriteTokens ?? null,
        checked.usage?.cacheWrite12hTokens ?? null,
        checked.providerRequestId ?? null,
        checked.responseModel ?? null,
        id,
      ),
    )
    if (row === null) throw new StoreError("request_not_pending", `request ${id} does not exist or is already finished`)
    return requestRecord(row)
  }

  return {
    database,
    append,
    readEvents,
    subscribe: (listener) => {
      // Wrapped so that subscribing the same function twice gives two independent subscriptions.
      const entry = (events: readonly StoredEvent[]) => listener(events)
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
    getProjection: (id) => readProjection(id),
    getSession: (id) => {
      const row = sql.session.get(id)
      return row === null ? null : summary(row)
    },
    listSessions: (query = {}) => sql.listSessions.all(query.includeArchived ? 1 : 0, query.limit ?? -1).map(summary),
    listClaimedSessions: () => sql.claimedSessions.all().map(summary),
    readMessages: (id, page = {}) =>
      sql.messages
        .all(id, page.beforeSeq ?? Number.MAX_SAFE_INTEGER, page.limit ?? -1)
        .map((row) => decodeMessage(id, row.data)),
    readModelHistory,
    readInbox: (id) => sql.inbox.all(id).map((row) => decodeJson(inboxItem, row.data, `session ${id} inbox item`)),
    searchMessages: (id, input) => history.search(id, input),
    readMessageAt: (id, seq) => history.messageAt(id, seq),
    fullTextSearch: history.fullText,
    beginRequest,
    finishRequest,
    lastRequest: (id, purpose) => {
      const row = purpose === undefined ? sql.lastRequest.get(id) : sql.lastRequestOf.get(id, purpose)
      return row === null ? null : requestRecord(row)
    },
    readRequests: (id) => sql.requests.all(id).map(requestRecord),
    putBlob: (bytes, mediaType) => blobs.put(bytes, mediaType),
    getBlob: (hash) => blobs.get(hash),
    close: () => {
      listeners.clear()
      cache.clear()
      read.clear()
      database.close()
      lock?.close()
    },
  }
}

openSqliteStore satisfies OpenStore

function openDatabase(path: string, inMemory: boolean, busyTimeoutMs: number, lock: Database | null): Database {
  const database = new Database(path, { create: true })
  try {
    for (const pragma of CONNECTION_PRAGMAS) database.run(pragma)
    database.run(`PRAGMA busy_timeout = ${integer(0)(busyTimeoutMs, "busyTimeoutMs")}`)
    const mode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode
    if (!inMemory && mode !== "wal") throw new StoreSchemaError(`${path} could not be switched to WAL (got ${mode})`)
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    if (version === 0)
      database
        .transaction(() => {
          database.run(SCHEMA_SQL)
          database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        })
        .immediate()
    else if (version !== SCHEMA_VERSION)
      throw new StoreSchemaError(`${path} has schema version ${version}; this build uses version ${SCHEMA_VERSION}`)
    return database
  } catch (error) {
    database.close()
    lock?.close()
    throw error
  }
}

/**
 * A connection that only reads, for a file some other store may be writing.
 * It takes no lock, creates nothing and changes no setting of the database;
 * a file that is not a store database of this schema version is refused.
 */
function openReader(path: string, busyTimeoutMs: number): Database {
  let database: Database
  try {
    database = new Database(path, { readonly: true })
  } catch (error) {
    if (error instanceof SQLiteError && error.code === "SQLITE_CANTOPEN") throw new StoreError("session_not_found", `${path} does not exist`, { cause: error })
    throw error
  }
  try {
    database.run(`PRAGMA busy_timeout = ${integer(0)(busyTimeoutMs, "busyTimeoutMs")}`)
    const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    if (version !== SCHEMA_VERSION)
      throw new StoreSchemaError(`${path} has schema version ${version}; this build uses version ${SCHEMA_VERSION}`)
    return database
  } catch (error) {
    database.close()
    if (error instanceof SQLiteError && (error.code === "SQLITE_NOTADB" || error.code === "SQLITE_CORRUPT"))
      throw new StoreSchemaError(`${path} is not a store database`)
    throw error
  }
}

/** A session's state as `getProjection` last read it, with the texts of the two rows it decodes only when they change. */
interface ReadState {
  readonly projection: Projection
  readonly state: string
  readonly baseline: string | null
}

/** `messages` (in `seq` order) with each of `changed` (in `seq` order) in the place of the message of its `seq`, or added. */
function mergeBySeq(messages: readonly Message[], changed: readonly Message[]): Message[] {
  const merged = [...messages]
  for (const message of changed) {
    const last = merged.at(-1)
    if (last === undefined || message.seq > last.seq) {
      merged.push(message)
      continue
    }
    // The first message whose seq is not below this one's.
    let low = 0
    let high = merged.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (merged[middle]!.seq < message.seq) low = middle + 1
      else high = middle
    }
    if (merged[low]?.seq === message.seq) merged[low] = message
    else merged.splice(low, 0, message)
  }
  return merged
}

interface SessionRow {
  readonly id: string
  readonly parent_id: string | null
  readonly parent_seq: number | null
  readonly last_seq: number
  readonly time_updated: number
  readonly state: string
  readonly baseline: string | null
}

interface RequestRow {
  readonly ordinal: number
  readonly id: string
  readonly session_id: string
  readonly message_id: string
  readonly attempt: number
  readonly purpose: string
  readonly model: string
  readonly provider: string
  readonly blocks: string
  readonly time_started: number
  readonly time_finished: number | null
  readonly outcome: string | null
  readonly error_kind: string | null
  readonly input_tokens: number | null
  readonly cached_input_tokens: number | null
  readonly output_tokens: number | null
  readonly reasoning_tokens: number | null
  readonly cache_write_tokens: number | null
  readonly cache_write_12h_tokens: number | null
  readonly provider_request_id: string | null
  readonly response_model: string | null
}

interface EventSqlRow {
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly v: number
  readonly data: string
}

type Data = { readonly data: string }

function prepare(database: Database) {
  const sessionColumns = "id, parent_id, parent_seq, last_seq, time_updated, state, baseline"
  return {
    head: database.query<{ last_seq: number }, [string]>("SELECT last_seq FROM session WHERE id = ?"),
    session: database.query<SessionRow, [string]>(`SELECT ${sessionColumns} FROM session WHERE id = ?`),
    lineage: database.query<{ parent_id: string | null; parent_seq: number | null }, [string]>(
      "SELECT parent_id, parent_seq FROM session WHERE id = ?",
    ),
    listSessions: database.query<SessionRow, [number, number]>(
      `SELECT ${sessionColumns} FROM session WHERE archived <= ? ORDER BY time_updated DESC, rowid DESC LIMIT ?`,
    ),
    claimedSessions: database.query<SessionRow, []>(
      `SELECT ${sessionColumns} FROM session WHERE execution_id IS NOT NULL ORDER BY time_updated DESC, rowid DESC`,
    ),
    insertSession: database.query<
      unknown,
      [
        string,
        string | null,
        string | null,
        number | null,
        string,
        number,
        string | null,
        number,
        string | null,
        string | null,
        number,
        number,
        string,
        string | null,
      ]
    >(
      `INSERT INTO session (id, parent_id, parent_kind, parent_seq, cwd, time_created, title, archived, execution_id,
         execution_status, last_seq, time_updated, state, baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateSession: database.query<unknown, [string | null, number, string | null, string | null, number, number, string, string]>(
      `UPDATE session SET title = ?, archived = ?, execution_id = ?, execution_status = ?, last_seq = ?, time_updated = ?,
         state = ?
       WHERE id = ?`,
    ),
    touchSession: database.query<unknown, [number, number, string]>(
      "UPDATE session SET last_seq = ?, time_updated = ? WHERE id = ?",
    ),
    updateBaseline: database.query<unknown, [string | null, string]>("UPDATE session SET baseline = ? WHERE id = ?"),
    insertEvent: database.query<unknown, [string, number, string, number, number, string]>(
      "INSERT INTO event (session_id, seq, type, v, time, data) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    events: database.query<EventSqlRow, [string, number, number, number]>(
      `SELECT session_id AS sessionId, seq, time, type, v, data FROM event
       WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
    ),
    upsertMessage: database.query<unknown, [string, number, string, string, string | null, number, string]>(
      `INSERT INTO message (session_id, seq, id, kind, excluded, changed_seq, data) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, seq) DO UPDATE SET id = excluded.id, kind = excluded.kind,
         excluded = excluded.excluded, changed_seq = excluded.changed_seq, data = excluded.data`,
    ),
    // The messages an append wrote after the session was at `last_seq`, in seq order.
    changedMessages: database.query<Data, [string, number]>("SELECT data FROM message WHERE session_id = ? AND changed_seq > ? ORDER BY seq"),
    // The `limit` messages with the highest seq below `beforeSeq`, returned in seq order.
    messages: database.query<Data, [string, number, number]>(
      `SELECT data FROM (SELECT seq, data FROM message WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?)
       ORDER BY seq`,
    ),
    visibleMessages: database.query<Data, [string, number]>(
      `SELECT data FROM message WHERE session_id = ? AND excluded IS NULL AND kind != 'compaction' AND seq >= ?
       ORDER BY seq`,
    ),
    messageById: database.query<Data, [string, string]>("SELECT data FROM message WHERE session_id = ? AND id = ?"),
    firstUserMessage: database.query<Data, [string]>("SELECT data FROM message WHERE session_id = ? AND kind = 'user' AND excluded IS NULL ORDER BY seq LIMIT 1"),
    inbox: database.query<Data, [string]>("SELECT data FROM inbox WHERE session_id = ? ORDER BY seq"),
    upsertInbox: database.query<unknown, [string, string, number, string, string]>(
      `INSERT INTO inbox (session_id, message_id, seq, delivery, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, message_id) DO UPDATE SET delivery = excluded.delivery, data = excluded.data`,
    ),
    deleteInbox: database.query<unknown, [string, string]>("DELETE FROM inbox WHERE session_id = ? AND message_id = ?"),
    insertRequest: database.query<RequestRow, [string, string, string, number, string, string, string, string, number]>(
      `INSERT INTO request (id, session_id, message_id, attempt, purpose, model, provider, blocks, time_started)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ),
    finishRequest: database.query<
      RequestRow,
      [number, string, string | null, number | null, number | null, number | null, number | null, number | null, number | null, string | null, string | null, string]
    >(
      `UPDATE request SET time_finished = ?, outcome = ?, error_kind = ?, input_tokens = ?, cached_input_tokens = ?,
         output_tokens = ?, reasoning_tokens = ?, cache_write_tokens = ?, cache_write_12h_tokens = ?,
         provider_request_id = ?, response_model = ?
       WHERE id = ? AND outcome IS NULL RETURNING *`,
    ),
    lastRequest: database.query<RequestRow, [string]>(
      "SELECT * FROM request WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
    ),
    lastRequestOf: database.query<RequestRow, [string, string]>(
      "SELECT * FROM request WHERE session_id = ? AND purpose = ? ORDER BY ordinal DESC LIMIT 1",
    ),
    requests: database.query<RequestRow, [string]>("SELECT * FROM request WHERE session_id = ? ORDER BY ordinal"),
  }
}

/**
 * The pieces of a session's effective log, root first. A fork's own events
 * are its rows after `parent_seq`; before that it reads its parent's log
 * through `parent_seq`, which may itself be a fork. Inherited events keep the
 * parent's `sessionId`, which is what lets `reduceAll` fold the effective log.
 */
function lineage(sql: ReturnType<typeof prepare>, id: string, foreignParents: boolean) {
  const segments: { id: string; after: number; through: number; foreign: boolean }[] = []
  let next: string | null = id
  let through = Number.MAX_SAFE_INTEGER
  while (next !== null) {
    const row = sql.lineage.get(next)
    if (row === null) {
      if (segments.length === 0) return []
      // The parent lives in another file: everything up to the fork point comes from there, its own ancestors included.
      if (foreignParents) {
        segments.push({ id: next, after: 0, through, foreign: true })
        break
      }
      throw new StoreError("parent_missing", `session ${segments.at(-1)!.id} names a parent ${next} that does not exist`)
    }
    segments.push({ id: next, after: row.parent_seq ?? 0, through, foreign: false })
    through = row.parent_seq ?? 0
    next = row.parent_id
  }
  return segments.reverse()
}

/** The session columns that change with `SessionState`, in `updateSession` order. */
function sessionStateColumns(projection: Projection) {
  const session = projection.session
  return [
    session.title,
    session.archived ? 1 : 0,
    session.execution?.id ?? null,
    session.execution?.status ?? null,
    projection.lastSeq,
    projection.updatedAt,
    canonicalJson(session),
  ] as const
}

/** Every column of a new session row, in `insertSession` order. */
function sessionColumns(projection: Projection) {
  const session = projection.session
  const fork = session.lineage?.kind === "fork" ? session.lineage : null
  return [
    session.id,
    // Only a fork reads a parent's log. A subagent and a replay name the session they come from in their state.
    fork?.parentSessionId ?? null,
    fork?.kind ?? null,
    fork?.throughSeq ?? null,
    session.cwd,
    session.createdAt,
    ...sessionStateColumns(projection),
    projection.baseline === null ? null : canonicalJson(projection.baseline),
  ] as const
}

function decodeJson<T>(validator: Validator<T>, text: string, what: string): T {
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new Error(`${what} is not JSON`, { cause: error })
    }
  })()
  return validator(parsed, what)
}

function decodeMessage(id: string, text: string): Message {
  return decodeJson(message, text, `session ${id} message`)
}

const requestPurpose = oneOf(["step", "compaction"])

const requestStart = object({
  id: requestId,
  sessionId: sessionIdValidator,
  messageId,
  attempt: integer(1),
  purpose: requestPurpose,
  model: nonEmptyString,
  provider: nonEmptyString,
  blocks: blockHashes,
}) satisfies Validator<RequestStart>

const requestFinish = object({
  outcome: oneOf(["ok", "error", "aborted"]),
  usage: nullable(usage),
  errorKind: nullable(providerErrorKind),
  providerRequestId: optional(nullable(nonEmptyString)),
  responseModel: optional(nullable(nonEmptyString)),
}) satisfies Validator<RequestFinish>

function requestRecord(row: RequestRow): RequestRecord {
  const what = `request ${row.id}`
  return {
    ordinal: row.ordinal,
    ...requestStart(
      {
        id: row.id,
        sessionId: row.session_id,
        messageId: row.message_id,
        attempt: row.attempt,
        purpose: row.purpose,
        model: row.model,
        provider: row.provider,
        blocks: JSON.parse(row.blocks),
      },
      what,
    ),
    startedAt: row.time_started,
    finishedAt: row.time_finished,
    outcome: nullable(oneOf(["ok", "error", "aborted"]))(row.outcome, `${what}.outcome`),
    usage:
      row.input_tokens === null
        ? null
        : usage(
            {
              inputTokens: row.input_tokens,
              cachedInputTokens: row.cached_input_tokens,
              outputTokens: row.output_tokens,
              reasoningTokens: row.reasoning_tokens,
              ...(row.cache_write_tokens === null ? {} : { cacheWriteTokens: row.cache_write_tokens }),
              ...(row.cache_write_12h_tokens === null ? {} : { cacheWrite12hTokens: row.cache_write_12h_tokens }),
            },
            `${what}.usage`,
          ),
    errorKind: nullable(providerErrorKind)(row.error_kind, `${what}.errorKind`),
    providerRequestId: row.provider_request_id,
    responseModel: row.response_model,
  }
}

