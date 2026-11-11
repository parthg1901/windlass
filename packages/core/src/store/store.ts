/**
 * The store contract. Interface only; the storage track implements it on
 * SQLite (`schema.ts`).
 *
 * The interface is synchronous on purpose. There is one writer process and
 * SQLite calls are synchronous, so an append is finished when `append`
 * returns. "The tool call is durable before the tool runs" is then simply the
 * order of two statements, with no await between them to get wrong.
 */
import type { BlobRef } from "../content.ts"
import type { NewEvent, StoredEvent } from "../event/durable.ts"
import type { MessageId, RequestId, SessionId } from "../id.ts"
import type { ModelHistory } from "../message/history.ts"
import type { InboxItem, Message, Projection, SessionState } from "../message/message.ts"
import type { ProviderErrorKind } from "../provider/error.ts"
import type { Usage } from "../provider/usage.ts"
import type { BlockHash } from "../request/prefix.ts"

export type StoreErrorCode =
  /** The session does not exist (and the first event is not `session.created`). */
  | "session_not_found"
  /** `expectedSeq` did not match the session's last `seq`: something else was appended first. */
  | "seq_conflict"
  /** The ledger row named by `finishRequest` does not exist or is already finished. */
  | "request_not_pending"

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "StoreError"
  }
}

export interface AppendOptions {
  /**
   * Append only if the session's last `seq` equals this (0 for a session that
   * does not exist yet). Use it when the events were decided from state read
   * earlier and an interleaved append would make them wrong.
   */
  readonly expectedSeq?: number
}

/** What the model call was for. A compaction request is the step request plus one prompt (context rule 7). */
export type RequestPurpose = "step" | "compaction"

/** Written to the ledger before the request is sent. */
export interface RequestStart {
  readonly id: RequestId
  readonly sessionId: SessionId
  /** The assistant or compaction message the call serves. */
  readonly messageId: MessageId
  /** The attempt within the step's retry budget. Each attempt is its own ledger row. */
  readonly attempt: number
  readonly purpose: RequestPurpose
  readonly model: string
  /** `hashRequest(request)`: the ordered block hashes of exactly what was sent. */
  readonly blocks: readonly BlockHash[]
}

/** Written to the ledger when the call is over. */
export interface RequestFinish {
  /** `ok`: the stream finished. `error`: it failed. `aborted`: it was interrupted. */
  readonly outcome: "ok" | "error" | "aborted"
  /** Provider-measured usage, when the provider reported it (possible for any outcome). */
  readonly usage: Usage | null
  /** Set when `outcome` is `error`. */
  readonly errorKind: ProviderErrorKind | null
}

/**
 * One row of the request ledger: per model call, the block hashes of the
 * request plus the usage (storage rule 9). It is a trace, not a projection of
 * the event log, and it is never sent to the model.
 */
export interface RequestRecord extends RequestStart {
  /** Assigned by the store, increasing across all sessions. Orders ledger rows. */
  readonly ordinal: number
  readonly startedAt: number
  /** `null` while the call is in flight (or if the process died during it). */
  readonly finishedAt: number | null
  readonly outcome: RequestFinish["outcome"] | null
  readonly usage: Usage | null
  readonly errorKind: ProviderErrorKind | null
}

export interface StoredBlob {
  readonly hash: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

export interface SessionSummary {
  readonly session: SessionState
  readonly lastSeq: number
  readonly updatedAt: number
}

export interface Store {
  // ---- the log ----

  /**
   * Appends events to one session, all or nothing, in one `BEGIN IMMEDIATE`
   * transaction: for each event in order, validate it (`validateEvent`),
   * assign the next `seq` and the time, run `reduce`, write the changed
   * projection rows (`projectionChanges`), insert the event row.
   *
   * This is the only way any session state changes. Nothing writes projection
   * rows directly, so a projection rebuilt from the log always equals the live one.
   *
   * The first event of a new session must be `session.created`. For a fork the
   * store folds the parent's log through `lineage.throughSeq` to get the
   * starting state, and the fork's first `seq` is `throughSeq + 1`.
   *
   * Throws `EventDecodeError` (invalid event), `ReduceError` (the event would
   * break a log invariant) or `StoreError`. When it throws, nothing was written.
   */
  readonly append: (
    sessionId: SessionId,
    events: readonly NewEvent[],
    options?: AppendOptions,
  ) => readonly StoredEvent[]

  /**
   * Reads a session's log in `seq` order. For a fork this is the effective
   * log: the inherited parent events followed by its own.
   */
  readonly readEvents: (
    sessionId: SessionId,
    range?: { readonly afterSeq?: number; readonly limit?: number },
  ) => readonly StoredEvent[]

  /**
   * Calls `listener` after each successful append, synchronously, with the
   * appended events in order. A listener that throws does not undo the append.
   * Returns a function that removes the listener.
   */
  readonly subscribe: (listener: (events: readonly StoredEvent[]) => void) => () => void

  // ---- projections ----

  /** The whole projected state of a session, or `null` if it does not exist. */
  readonly getProjection: (sessionId: SessionId) => Projection | null

  readonly getSession: (sessionId: SessionId) => SessionSummary | null

  /** Sessions, most recently updated first. Archived sessions are left out unless asked for. */
  readonly listSessions: (query?: {
    readonly includeArchived?: boolean
    readonly limit?: number
  }) => readonly SessionSummary[]

  /**
   * Sessions that hold an execution claim, `running` or `suspended`. At startup
   * these are the sessions recovery must settle and then resume or fail.
   */
  readonly listClaimedSessions: () => readonly SessionSummary[]

  /**
   * Messages for a UI, in `seq` order: every kind, including excluded and
   * pre-compaction ones. Pages backwards: the `limit` messages with the highest
   * `seq` below `beforeSeq`.
   */
  readonly readMessages: (
    sessionId: SessionId,
    page?: { readonly beforeSeq?: number; readonly limit?: number },
  ) => readonly Message[]

  /**
   * History for the model, from the latest compaction. Must equal
   * `selectModelHistory(getProjection(sessionId))`. Throws `StoreError` when
   * the session does not exist.
   */
  readonly readModelHistory: (sessionId: SessionId) => ModelHistory

  /**
   * Undelivered inbox items in enqueue order. The inbox changes only through
   * `append` (`inbox.enqueued`, `inbox.delivery_changed`, `inbox.cancelled`,
   * `inbox.delivered`); there are no other inbox writes.
   */
  readonly readInbox: (sessionId: SessionId) => readonly InboxItem[]

  // ---- request ledger ----

  /** Records a model call that is about to be sent. */
  readonly beginRequest: (start: RequestStart) => RequestRecord

  /** Records how a model call ended. Throws `StoreError` unless the row exists and is unfinished. */
  readonly finishRequest: (id: RequestId, finish: RequestFinish) => RequestRecord

  /**
   * The session's most recent ledger row, optionally only of one purpose. The
   * runtime prefix check compares the next step request with the last `step` row.
   */
  readonly lastRequest: (sessionId: SessionId, purpose?: RequestPurpose) => RequestRecord | null

  /** A session's ledger rows in `ordinal` order. */
  readonly readRequests: (sessionId: SessionId) => readonly RequestRecord[]

  // ---- blobs ----

  /**
   * Stores bytes under their SHA-256 and returns the reference. Storing the
   * same bytes again is a no-op that returns the same hash.
   */
  readonly putBlob: (bytes: Uint8Array, mediaType: string) => BlobRef

  readonly getBlob: (hash: string) => StoredBlob | null

  readonly close: () => void
}

export interface OpenStoreOptions {
  /** Path of the SQLite file, or `":memory:"`. */
  readonly path: string
  /** Clock for event and ledger times, in milliseconds. Defaults to `Date.now`. Tests pass a fixed one. */
  readonly now?: () => number
}

/** The shape of the storage track's entry point, so other tracks can be written against it now. */
export type OpenStore = (options: OpenStoreOptions) => Store
