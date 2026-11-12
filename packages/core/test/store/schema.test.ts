import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { text } from "../../src/content.ts"
import { decodeEvent, encodeEventData } from "../../src/event/decode.ts"
import { event } from "../../src/event/durable.ts"
import type { MessageId } from "../../src/id.ts"
import { CONNECTION_PRAGMAS, SCHEMA_SQL, SCHEMA_VERSION } from "../../src/store/schema.ts"

function open() {
  const database = new Database(":memory:")
  for (const pragma of CONNECTION_PRAGMAS) database.run(pragma)
  database.run(SCHEMA_SQL)
  database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return database
}

const insertSession = (database: Database, id: string, parent: [string, string, number] | null = null) =>
  database.run(
    `INSERT INTO session (id, parent_id, parent_kind, parent_seq, cwd, last_seq, time_created, time_updated, state)
     VALUES (?, ?, ?, ?, '/repo', 0, 0, 0, '{}')`,
    [id, parent?.[0] ?? null, parent?.[1] ?? null, parent?.[2] ?? null],
  )

const insertEvent = (database: Database, sessionId: string, seq: number, data = "{}") =>
  database.run(`INSERT INTO event (session_id, seq, type, v, time, data) VALUES (?, ?, 'session.archived', 1, 0, ?)`, [
    sessionId,
    seq,
    data,
  ])

describe("SQLite schema", () => {
  test("creates the five tables on an empty database", () => {
    const database = open()
    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    // Media is not among them: it lives in the blob store that sessions share.
    expect(tables).toEqual(["event", "inbox", "message", "request", "session"])
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION)
  })

  test("the event log is append-only", () => {
    const database = open()
    insertSession(database, "ses_1")
    insertEvent(database, "ses_1", 1)
    expect(() => database.run("UPDATE event SET data = '{}' WHERE seq = 1")).toThrow("append-only")
    expect(() => database.run("DELETE FROM event")).toThrow("append-only")
    expect(database.query("SELECT count(*) AS n FROM event").get()).toEqual({ n: 1 })
  })

  test("seq is unique per session, not across sessions", () => {
    const database = open()
    insertSession(database, "ses_1")
    insertSession(database, "ses_2")
    insertEvent(database, "ses_1", 1)
    insertEvent(database, "ses_2", 1)
    expect(() => insertEvent(database, "ses_1", 1)).toThrow()
  })

  test("events and messages need their session", () => {
    const database = open()
    expect(() => insertEvent(database, "ses_missing", 1)).toThrow()
    expect(() =>
      database.run("INSERT INTO message (session_id, seq, id, kind, changed_seq, data) VALUES ('ses_missing', 1, 'm', 'user', 1, '{}')"),
    ).toThrow()
  })

  test("lineage columns are set together or not at all", () => {
    const database = open()
    insertSession(database, "ses_1")
    insertSession(database, "ses_2", ["ses_1", "fork", 12])
    expect(() =>
      database.run(
        `INSERT INTO session (id, parent_id, cwd, last_seq, time_created, time_updated, state)
         VALUES ('ses_3', 'ses_1', '/repo', 0, 0, 0, '{}')`,
      ),
    ).toThrow()
    // The parent is usually in another file, so it is named, not referenced.
    expect(() => insertSession(database, "ses_4", ["ses_missing", "fork", 1])).not.toThrow()
  })

  test("a message id is unique within a session and a fork may reuse its parent's ids", () => {
    const database = open()
    insertSession(database, "ses_1")
    insertSession(database, "ses_2", ["ses_1", "fork", 5])
    const insert = (sessionId: string, seq: number, id: string) =>
      database.run("INSERT INTO message (session_id, seq, id, kind, changed_seq, data) VALUES (?, ?, ?, 'user', ?, '{}')", [
        sessionId,
        seq,
        id,
        seq,
      ])
    insert("ses_1", 5, "msg_1")
    insert("ses_2", 5, "msg_1")
    expect(() => insert("ses_1", 6, "msg_1")).toThrow()
    expect(() => insert("ses_1", 5, "msg_2")).toThrow()
  })

  test("ledger rows are ordered by an increasing ordinal", () => {
    const database = open()
    insertSession(database, "ses_1")
    const insert = (id: string) =>
      database.run(
        `INSERT INTO request (id, session_id, message_id, attempt, purpose, model, blocks, time_started)
         VALUES (?, 'ses_1', 'msg_1', 1, 'step', 'gpt-test', '[]', 0)`,
        [id],
      )
    insert("req_1")
    insert("req_2")
    expect(() => insert("req_1")).toThrow()
    const rows = database.query<{ id: string; ordinal: number }, []>("SELECT id, ordinal FROM request ORDER BY ordinal").all()
    expect(rows.map((row) => row.id)).toEqual(["req_1", "req_2"])
    expect(rows[1]!.ordinal).toBeGreaterThan(rows[0]!.ordinal)
  })

  test("an event written with encodeEventData reads back through decodeEvent", () => {
    const database = open()
    insertSession(database, "ses_1")
    const enqueued = event("inbox.enqueued", {
      messageId: "msg_1" as MessageId,
      origin: null,
      delivery: "steer",
      content: text("héllo   \"quoted\""),
    })
    database.run("INSERT INTO event (session_id, seq, type, v, time, data) VALUES ('ses_1', 1, ?, ?, 42, ?)", [
      enqueued.type,
      enqueued.v,
      encodeEventData(enqueued),
    ])
    const row = database
      .query<{ sessionId: string; seq: number; time: number; type: string; v: number; data: string }, []>(
        "SELECT session_id AS sessionId, seq, time, type, v, data FROM event",
      )
      .get()
    expect(decodeEvent(row!)).toMatchObject({ ...enqueued, seq: 1, time: 42 })
  })
})
