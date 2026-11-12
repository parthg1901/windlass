/**
 * The store's central invariant, as a reusable assertion: folding a session's
 * stored log through the reducer gives exactly the stored projection rows.
 * Every feature that appends events must keep `expectRebuildEqualsLive` true.
 */
import { expect } from "bun:test"
import { forkOf } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import type { Projection } from "../../src/message/message.ts"
import { reduceAll } from "../../src/message/reducer.ts"
import { canonicalJson } from "../../src/request/canonical.ts"
import type { SqliteStore } from "../../src/store/sqlite.ts"

/** Asserts that the session's rows equal the rebuild from its log, byte for byte. Returns the rebuild. */
export function expectRebuildEqualsLive(store: SqliteStore, sessionId: SessionId): Projection {
  const events = store.readEvents(sessionId)
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
  const rebuilt = reduceAll(events)
  if (rebuilt === null) throw new Error(`session ${sessionId} has no events`)
  expect(rebuilt.session.id).toBe(sessionId)

  // Through the store's typed reads.
  expect(store.getProjection(sessionId)).toStrictEqual(rebuilt)
  expect(store.getSession(sessionId)).toStrictEqual({
    session: rebuilt.session,
    lastSeq: rebuilt.lastSeq,
    updatedAt: rebuilt.updatedAt,
  })
  expect(store.readMessages(sessionId)).toStrictEqual(rebuilt.messages)
  expect(store.readInbox(sessionId)).toStrictEqual(rebuilt.inbox)
  expect(store.readModelHistory(sessionId)).toStrictEqual(selectModelHistory(rebuilt))

  // Through the raw rows, so the typed columns cannot drift from the JSON.
  const database = store.database
  const session = rebuilt.session
  expect(database.query("SELECT * FROM session WHERE id = ?").get(sessionId)).toEqual({
    id: sessionId,
    parent_id: forkOf(session.lineage)?.parentSessionId ?? null,
    parent_kind: forkOf(session.lineage)?.kind ?? null,
    parent_seq: forkOf(session.lineage)?.throughSeq ?? null,
    cwd: session.cwd,
    title: session.title,
    archived: session.archived ? 1 : 0,
    execution_id: session.execution?.id ?? null,
    execution_status: session.execution?.status ?? null,
    last_seq: rebuilt.lastSeq,
    time_created: session.createdAt,
    time_updated: rebuilt.updatedAt,
    state: canonicalJson(session),
    baseline: rebuilt.baseline === null ? null : canonicalJson(rebuilt.baseline),
  })
  expect(
    database.query("SELECT seq, id, kind, excluded, data FROM message WHERE session_id = ? ORDER BY seq").all(sessionId),
  ).toEqual(
    rebuilt.messages.map((message) => ({
      seq: message.seq,
      id: message.id,
      kind: message.kind,
      excluded: message.excluded,
      data: canonicalJson(message),
    })),
  )
  expect(
    database.query("SELECT message_id, seq, delivery, data FROM inbox WHERE session_id = ? ORDER BY seq").all(sessionId),
  ).toEqual(
    rebuilt.inbox.map((item) => ({
      message_id: item.messageId,
      seq: item.seq,
      delivery: item.delivery,
      data: canonicalJson(item),
    })),
  )
  // A fork stores only its own events; the inherited ones stay in the parent.
  const own = database
    .query<{ seq: number }, [string]>("SELECT seq FROM event WHERE session_id = ? ORDER BY seq")
    .all(sessionId)
    .map((row) => row.seq)
  const first = (forkOf(session.lineage)?.throughSeq ?? 0) + 1
  expect(own).toEqual(Array.from({ length: rebuilt.lastSeq - first + 1 }, (_, index) => first + index))
  return rebuilt
}

/** `expectRebuildEqualsLive` for every session in the database. Returns how many sessions were checked. */
export function expectStoreConsistent(store: SqliteStore): number {
  const ids = store.database
    .query<{ id: string }, []>("SELECT id FROM session ORDER BY rowid")
    .all()
    .map((row) => row.id as SessionId)
  for (const id of ids) expectRebuildEqualsLive(store, id)
  return ids.length
}
