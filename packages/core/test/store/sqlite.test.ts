import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { text } from "../../src/content.ts"
import { EventDecodeError } from "../../src/event/decode.ts"
import { event, type NewEvent, type StoredEvent } from "../../src/event/durable.ts"
import type { MessageId, RequestId, SessionId } from "../../src/id.ts"
import { ReduceError } from "../../src/message/reducer.ts"
import { type SqliteStore, StoreSchemaError, openSqliteStore } from "../../src/store/sqlite.ts"
import { StoreError } from "../../src/store/store.ts"
import { expectRebuildEqualsLive, expectStoreConsistent } from "./consistency.ts"
import {
  Driver,
  SCRIPTS,
  baselineSet,
  called,
  created,
  deliver,
  enqueue,
  executionStarted,
  forked,
  started,
  stepEnded,
  stepStarted,
  textEnded,
} from "./scripted.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), "lh-store-"))
  directories.push(directory)
  return join(directory, "store.db")
}

/** A fixed clock that ticks by one millisecond per reading. */
function clock(start = 1_750_000_000_000) {
  let time = start
  return () => time++
}

function open(path = ":memory:") {
  const listenerErrors: unknown[] = []
  const store = openSqliteStore({ path, now: clock(), onListenerError: (error) => listenerErrors.push(error) })
  return Object.assign(store, { listenerErrors })
}

const sid = (id: string) => id as SessionId

/** A session with a delivered prompt and an open step `a1`: seq 1..5. */
function inStep(store: SqliteStore, id = sid("ses_1")) {
  const d = new Driver(store, id)
  d.add(created(), baselineSet(), enqueue("u1", "hello"), executionStarted("exe_1"), deliver("u1"), stepStarted("a1"))
  return d
}

function counts(store: SqliteStore) {
  return Object.fromEntries(
    ["session", "event", "message", "inbox"].map((table) => [
      table,
      store.database.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n,
    ]),
  )
}

function rejection(append: () => unknown): unknown {
  try {
    append()
  } catch (error) {
    return error
  }
  throw new Error("expected the append to be rejected")
}

describe("append", () => {
  test("assigns dense seq and the store's time, and returns the stored events", () => {
    const store = openSqliteStore({ path: ":memory:", now: () => 42 })
    const stored = store.append(sid("ses_1"), [created(), baselineSet()])
    expect(stored.map((stored) => `${stored.sessionId} ${stored.seq} ${stored.time} ${stored.type}`)).toEqual([
      "ses_1 1 42 session.created",
      "ses_1 2 42 baseline.set",
    ])
    expect(store.append(sid("ses_1"), [enqueue("u1", "hi")])[0]!.seq).toBe(3)
    expect(store.readEvents(sid("ses_1"))).toEqual(stored.concat(store.readEvents(sid("ses_1"), { afterSeq: 2 })))
  })

  test("an event the reducer rejects writes nothing, even after valid events in the same batch", () => {
    const store = open()
    const d = inStep(store)
    const before = counts(store)
    const rows = store.database.query("SELECT * FROM message ORDER BY seq").all()
    // Valid text, then a second step while a1 is still open.
    const error = rejection(() => d.batch(textEnded("a1", "partial"), stepStarted("a2")))
    expect(error).toBeInstanceOf(ReduceError)
    expect((error as ReduceError).code).toBe("invalid_transition")
    expect(counts(store)).toEqual(before)
    expect(store.database.query("SELECT * FROM message ORDER BY seq").all()).toEqual(rows)
    // The writer's cached projection was not advanced either.
    d.add(textEnded("a1", "whole"), stepEnded("a1"))
    expect(expectRebuildEqualsLive(store, d.id).lastSeq).toBe(8)
  })

  test("an invalid event is rejected at the boundary and writes nothing", () => {
    const store = open()
    const d = inStep(store)
    const before = counts(store)
    const bogus = { ...textEnded("a1", "x"), data: { messageId: "a1", text: "x", providerData: null, extra: 1 } }
    expect(rejection(() => d.batch(textEnded("a1", "ok"), bogus as unknown as NewEvent))).toBeInstanceOf(EventDecodeError)
    expect(rejection(() => d.batch({ type: "future.event", v: 1, data: {} } as unknown as NewEvent))).toBeInstanceOf(
      EventDecodeError,
    )
    expect(rejection(() => store.append(sid(""), [created()]))).toBeDefined()
    expect(counts(store)).toEqual(before)
  })

  test("the first event of a new session must create it", () => {
    const store = open()
    const error = rejection(() => store.append(sid("ses_x"), [enqueue("u1", "hi")]))
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe("session_not_found")
    store.append(sid("ses_x"), [created()])
    expect((rejection(() => store.append(sid("ses_x"), [created()])) as ReduceError).code).toBe("out_of_order")
  })

  test("expectedSeq guards against an interleaved append", () => {
    const store = open()
    store.append(sid("ses_1"), [created()], { expectedSeq: 0 })
    store.append(sid("ses_1"), [baselineSet()], { expectedSeq: 1 })
    const error = rejection(() => store.append(sid("ses_1"), [enqueue("u1", "hi")], { expectedSeq: 1 }))
    expect((error as StoreError).code).toBe("seq_conflict")
    expect((rejection(() => store.append(sid("ses_2"), [created()], { expectedSeq: 3 })) as StoreError).code).toBe(
      "seq_conflict",
    )
    expect(store.append(sid("ses_1"), [], { expectedSeq: 2 })).toEqual([])
    expect(store.getSession(sid("ses_1"))!.lastSeq).toBe(2)
  })

  test("an append writes only the rows it changed", () => {
    const store = open()
    const d = new Driver(store, sid("ses_1"))
    SCRIPTS.plain!(store, "warm")
    d.add(created(), baselineSet())
    for (let turn = 0; turn < 20; turn++)
      d.add(
        enqueue(`u${turn}`, "go"),
        executionStarted(`exe_${turn}`),
        deliver(`u${turn}`),
        stepStarted(`a${turn}`),
        textEnded(`a${turn}`, "done"),
        stepEnded(`a${turn}`),
        event("execution.succeeded", { executionId: `exe_${turn}` as never, verification: { status: "not_configured" } }),
      )
    d.add(enqueue("u_last", "go"), executionStarted("exe_last"), deliver("u_last"), stepStarted("a_last"))
    const changes = () => store.database.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n
    const before = changes()
    d.add(textEnded("a_last", "streaming done"))
    // One event row, one session row (last_seq), one message row.
    expect(changes() - before).toBe(3)
  })

  test("listeners hear each committed append in order; a throwing listener does not undo it", () => {
    const store = open()
    const heard: (readonly StoredEvent[])[] = []
    const stop = store.subscribe((events) => heard.push(events))
    store.subscribe(() => {
      throw new Error("listener bug")
    })
    store.append(sid("ses_1"), [created(), baselineSet()])
    rejection(() => store.append(sid("ses_1"), [created()]))
    store.append(sid("ses_1"), [enqueue("u1", "hi")])
    expect(heard.map((events) => events.map((stored) => stored.seq))).toEqual([[1, 2], [3]])
    expect(store.listenerErrors).toHaveLength(2)
    expect(store.getSession(sid("ses_1"))!.lastSeq).toBe(3)
    stop()
    store.append(sid("ses_1"), [enqueue("u2", "hi")])
    expect(heard).toHaveLength(2)
  })
})

describe("rebuild equals live", () => {
  for (const [name, script] of Object.entries(SCRIPTS))
    test(`${name}: after every append and at the end`, () => {
      const store = open()
      const touched = new Set<SessionId>()
      store.subscribe((events) => {
        const id = events[0]!.sessionId
        touched.add(id)
        expectRebuildEqualsLive(store, id)
      })
      const ids = script(store, "t")
      expect(store.listenerErrors).toEqual([])
      expect([...touched].sort()).toEqual([...ids].sort())
      expect(expectStoreConsistent(store)).toBe(ids.length)
    })

  test("the scripts reach the states they are named for", () => {
    const store = open()
    for (const [name, script] of Object.entries(SCRIPTS)) script(store, name)
    const history = (id: string) => store.readModelHistory(sid(id)).messages.map((message) => message.id as string)
    const all = (id: string) => store.readMessages(sid(id)).map((message) => message.id as string)
    expect(history("tools_tools")).toEqual(["u1", "a1", "a2", "a3"])
    expect(history("refused_refused")).toEqual(["u1", "a1", "u3", "a3"])
    expect(all("refused_refused")).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"])
    expect(history("revert_revert")).toEqual(["u1", "a1", "u3", "a3"])
    expect(history("compaction_compaction")).toEqual(["c2", "u2", "a2", "u3", "a3"])
    expect(store.readModelHistory(sid("compaction_compaction")).baseline?.instructions).toContain("Prefer small diffs")
    expect(history("inbox_inbox")).toEqual(["u2", "a1", "u1", "a2", "b1", "a3"])
    expect(store.readInbox(sid("inbox_inbox")).map((item) => item.messageId as string)).toEqual(["u4"])
    expect(history("interrupted_interrupted")).toEqual(["u1", "a1", "s1", "u2", "a2", "s2", "a3"])
    expect(history("retried_retried")).toEqual(["u1", "a1", "u2", "a2", "a3"])
    expect(history("fork_child")).toEqual(["u1", "a1", "u2", "a2"])
    expect(store.readMessages(sid("fork_child"))[3]).toMatchObject({ id: "a2", parts: [{ text: "Tests written." }] })
    expect(store.readInbox(sid("fork_grandchild")).map((item) => item.messageId as string)).toEqual(["u9"])
    expect(store.getSession(sid("plain_plain"))!.session.title).toBe("Rename the CLI")
  })
})

describe("fork", () => {
  test("reads the parent's log through the fork point, then its own; copies messages, not events", () => {
    const store = open()
    const [parent, child, grandchild] = SCRIPTS.fork!(store, "f") as [SessionId, SessionId, SessionId]
    const throughSeq = store.getSession(child)!.session.lineage!.throughSeq
    const parentEvents = store.readEvents(parent)
    const childEvents = store.readEvents(child)
    expect(childEvents.slice(0, throughSeq)).toEqual(parentEvents.slice(0, throughSeq))
    expect(childEvents[throughSeq]).toMatchObject({ sessionId: child, seq: throughSeq + 1, type: "session.created" })
    expect(childEvents.slice(throughSeq).every((stored) => stored.sessionId === child)).toBe(true)
    const own = (id: SessionId) =>
      store.database.query<{ n: number }, [string]>("SELECT count(*) AS n FROM event WHERE session_id = ?").get(id)!.n
    expect(own(child)).toBe(childEvents.length - throughSeq)
    // The grandchild reads three segments: parent, child, itself.
    const grandEvents = store.readEvents(grandchild)
    expect(new Set(grandEvents.map((stored) => stored.sessionId))).toEqual(new Set([parent, child, grandchild]))
    expect(grandEvents.map((stored) => stored.seq)).toEqual(grandEvents.map((_, index) => index + 1))
    // Ranges cut across segments.
    expect(store.readEvents(grandchild, { afterSeq: throughSeq - 2, limit: 4 }).map((stored) => stored.seq)).toEqual([
      throughSeq - 1,
      throughSeq,
      throughSeq + 1,
      throughSeq + 2,
    ])
    // Message rows were copied into the child at creation.
    const inherited = store.readMessages(parent).filter((message) => message.seq <= throughSeq)
    expect(store.readMessages(child).slice(0, inherited.length)).toEqual(inherited)
  })

  test("a fork point must exist and be a step boundary", () => {
    const store = open()
    const d = inStep(store)
    const before = counts(store)
    for (const [parent, throughSeq] of [
      [d.id, 6],
      [d.id, 99],
      [sid("ses_missing"), 1],
    ] as const) {
      const error = rejection(() => store.append(sid("ses_fork"), [forked(parent, throughSeq)]))
      expect(error).toBeInstanceOf(ReduceError)
    }
    expect(counts(store)).toEqual(before)
    // seq 5 is the delivered prompt, a boundary.
    store.append(sid("ses_fork"), [forked(d.id, 5)])
    expect(store.getSession(sid("ses_fork"))!.lastSeq).toBe(6)
    expectRebuildEqualsLive(store, sid("ses_fork"))
  })
})

// File-backed tests fsync every commit (synchronous = FULL), so they are slow on a busy disk.
const FILE_TIMEOUT = 30_000

describe("persistence", () => {
  const snapshot = (store: SqliteStore, ids: readonly SessionId[]) => ({
    sessions: store.listSessions({ includeArchived: true }),
    claimed: store.listClaimedSessions(),
    perSession: ids.map((id) => ({
      events: store.readEvents(id),
      projection: store.getProjection(id),
      messages: store.readMessages(id),
      history: store.readModelHistory(id),
      inbox: store.readInbox(id),
      requests: store.readRequests(id),
      last: store.lastRequest(id),
    })),
  })

  test("everything reads back identically after close and reopen, and appends continue", () => {
    const path = temporaryPath()
    const first = open(path)
    const ids = Object.entries(SCRIPTS).flatMap(([name, script]) => script(first, name))
    const claimed = new Driver(first, sid("claimed"))
    claimed.add(created(), baselineSet(), enqueue("u1", "hi"), executionStarted("exe_1"), deliver("u1"))
    claimed.add(stepStarted("a1"), called("a1", "call_1", "shell", "{}"), started("a1", "call_1", "exec"))
    ids.push(claimed.id)
    const blob = first.putBlob(new Uint8Array([1, 2, 3, 4]), "application/octet-stream")
    const before = snapshot(first, ids)
    first.close()

    const second = open(path)
    expect(snapshot(second, ids)).toEqual(before)
    expect(second.getBlob(blob.hash)!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(second.listClaimedSessions().map((summary) => summary.session.id)).toContain(claimed.id)
    // The writer starts with a cold cache and folds onto rows read back from disk.
    new Driver(second, claimed.id).add(
      event("tool.settled", {
        messageId: "a1" as MessageId,
        callId: "call_1" as never,
        outcome: "effect_unknown",
        output: "The process stopped while this command was running.",
        truncation: null,
        attachments: [],
        display: null,
      }),
      event("step.failed", { messageId: "a1" as MessageId, error: { kind: "crashed" }, usage: null }),
      event("synthetic.appended", {
        messageId: "s1" as MessageId,
        origin: "interrupt",
        content: text("The previous response was cut short when the harness restarted."),
      }),
      event("execution.failed", { executionId: "exe_1" as never, message: "crashed" }),
    )
    expect(expectStoreConsistent(second)).toBe(ids.length)
    second.close()
  }, FILE_TIMEOUT)

  test("events are decoded through the boundary on read", () => {
    const path = temporaryPath()
    const store = open(path)
    const d = new Driver(store, sid("ses_1"))
    d.add(created(), baselineSet())
    store.database.run(
      "INSERT INTO event (session_id, seq, type, v, time, data) VALUES ('ses_1', 3, 'baseline.set', 9, 0, '{}')",
    )
    const error = rejection(() => store.readEvents(d.id))
    expect(error).toBeInstanceOf(EventDecodeError)
    expect((error as EventDecodeError).reason).toBe("unknown_version")
    store.close()
  }, FILE_TIMEOUT)

  test("a database from another schema version is refused", () => {
    const path = temporaryPath()
    const store = open(path)
    store.database.run("PRAGMA user_version = 99")
    store.close()
    expect(() => open(path)).toThrow(StoreSchemaError)
    // The failed open released the writer lock, and the error is the store's own, with a code.
    let error: unknown
    try {
      open(path)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StoreError)
    expect((error as StoreError).code).toBe("schema_mismatch")
  }, FILE_TIMEOUT)
})

describe("reads", () => {
  test("readMessages pages backwards from beforeSeq", () => {
    const store = open()
    SCRIPTS.plain!(store, "p")
    const id = sid("p_plain")
    const all = store.readMessages(id)
    expect(all.map((message) => message.seq)).toEqual([...all.map((message) => message.seq)].sort((a, b) => a - b))
    const last = store.readMessages(id, { limit: 2 })
    expect(last).toEqual(all.slice(-2))
    expect(store.readMessages(id, { beforeSeq: last[0]!.seq, limit: 2 })).toEqual(all.slice(-4, -2))
    expect(store.readMessages(id, { beforeSeq: all[0]!.seq })).toEqual([])
    expect(store.readMessages(sid("nope"))).toEqual([])
    expect(store.readEvents(sid("nope"))).toEqual([])
    expect(store.getProjection(sid("nope"))).toBeNull()
    expect((rejection(() => store.readModelHistory(sid("nope"))) as StoreError).code).toBe("session_not_found")
  })

  test("listSessions orders by last update and hides archived sessions unless asked", () => {
    const store = open()
    for (const name of ["a", "b", "c"]) store.append(sid(name), [created()])
    store.append(sid("a"), [baselineSet()])
    store.append(sid("b"), [event("session.archived", {})])
    const ids = (summaries: readonly { session: { id: string } }[]) => summaries.map((summary) => summary.session.id)
    expect(ids(store.listSessions())).toEqual(["a", "c"])
    expect(ids(store.listSessions({ includeArchived: true }))).toEqual(["b", "a", "c"])
    expect(ids(store.listSessions({ includeArchived: true, limit: 1 }))).toEqual(["b"])
  })

  test("listClaimedSessions finds running and suspended executions", () => {
    const store = open()
    for (const name of ["idle", "running", "suspended"])
      store.append(sid(name), [created(), baselineSet(), enqueue("u1", "hi")])
    store.append(sid("running"), [executionStarted("exe_r")])
    store.append(sid("suspended"), [
      executionStarted("exe_s"),
      event("execution.interrupt_requested", { executionId: "exe_s" as never, reason: "shutdown" }),
      event("execution.interrupted", { executionId: "exe_s" as never, reason: "shutdown" }),
    ])
    const claimed = store.listClaimedSessions()
    expect(claimed.map((summary) => [summary.session.id, summary.session.execution?.status]).sort()).toEqual([
      ["running", "running"],
      ["suspended", "suspended"],
    ])
  })
})

describe("request ledger", () => {
  const blocks = [{ kind: "params" as const, hash: "a".repeat(64), bytes: 10 }]
  const start = (id: string, session = "ses_1", purpose: "step" | "compaction" = "step") => ({
    id: id as RequestId,
    sessionId: sid(session),
    messageId: "a1" as MessageId,
    attempt: 1,
    purpose,
    model: "gpt-test",
    blocks,
  })

  test("begin, finish and look up the last request", () => {
    const store = openSqliteStore({ path: ":memory:", now: () => 7 })
    store.append(sid("ses_1"), [created()])
    store.append(sid("ses_2"), [created()])
    expect(store.lastRequest(sid("ses_1"))).toBeNull()
    const begun = store.beginRequest(start("req_1"))
    expect(begun).toEqual({
      ...start("req_1"),
      ordinal: begun.ordinal,
      startedAt: 7,
      finishedAt: null,
      outcome: null,
      usage: null,
      errorKind: null,
    })
    store.beginRequest(start("req_other", "ses_2"))
    store.beginRequest(start("req_2", "ses_1", "compaction"))
    const usage = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningTokens: 1 }
    const finished = store.finishRequest("req_1" as RequestId, { outcome: "ok", usage, errorKind: null })
    expect(finished).toMatchObject({ id: "req_1", finishedAt: 7, outcome: "ok", usage, errorKind: null })
    // The last row of any purpose, in flight or not; and the last row of one purpose.
    expect(store.lastRequest(sid("ses_1"))!.id).toBe("req_2" as RequestId)
    expect(store.lastRequest(sid("ses_1"), "step")).toEqual(finished)
    expect(store.lastRequest(sid("ses_2"), "compaction")).toBeNull()
    const ordinals = store.readRequests(sid("ses_1")).map((record) => record.ordinal)
    expect(store.readRequests(sid("ses_1")).map((record) => record.id as string)).toEqual(["req_1", "req_2"])
    expect(ordinals[1]!).toBeGreaterThan(ordinals[0]!)
    expect(store.lastRequest(sid("ses_2"))!.ordinal).toBeGreaterThan(ordinals[0]!)
    expect(store.lastRequest(sid("ses_2"))!.ordinal).toBeLessThan(ordinals[1]!)
  })

  test("finishing twice, an unknown request or an unknown session is an error", () => {
    const store = open()
    store.append(sid("ses_1"), [created()])
    store.beginRequest(start("req_1"))
    store.finishRequest("req_1" as RequestId, { outcome: "error", usage: null, errorKind: "rate_limit" })
    const again = rejection(() =>
      store.finishRequest("req_1" as RequestId, { outcome: "ok", usage: null, errorKind: null }),
    ) as StoreError
    expect(again.code).toBe("request_not_pending")
    const unknown = rejection(() =>
      store.finishRequest("req_9" as RequestId, { outcome: "ok", usage: null, errorKind: null }),
    ) as StoreError
    expect(unknown.code).toBe("request_not_pending")
    expect((rejection(() => store.beginRequest(start("req_2", "ses_missing"))) as StoreError).code).toBe(
      "session_not_found",
    )
    // A request ID names one model call: a second row with it is the store's error, not a raw SQLite one.
    const duplicate = rejection(() => store.beginRequest(start("req_1")))
    expect(duplicate).toBeInstanceOf(StoreError)
    expect((duplicate as StoreError).code).toBe("duplicate_request")
    store.append(sid("ses_2"), [created()])
    expect((rejection(() => store.beginRequest(start("req_1", "ses_2"))) as StoreError).code).toBe("duplicate_request")
    expect(store.readRequests(sid("ses_1")).map((record) => record.id as string)).toEqual(["req_1"])
    store.beginRequest(start("req_3"))
    expect(() => store.finishRequest("req_3" as RequestId, { outcome: "ok", usage: null, errorKind: "auth" })).toThrow(
      TypeError,
    )
    expect(store.lastRequest(sid("ses_1"))!.outcome).toBeNull()
  })
})

describe("blobs", () => {
  test("are content-addressed and stored once", () => {
    const store = open()
    const bytes = new TextEncoder().encode("synthetic image bytes")
    const ref = store.putBlob(bytes, "image/png")
    expect(ref).toEqual({ hash: createHash("sha256").update(bytes).digest("hex"), mediaType: "image/png" })
    // The same bytes again, even under another media type, are the same reference.
    expect(store.putBlob(new Uint8Array(bytes), "image/webp")).toEqual(ref)
    expect(store.putBlob(new Uint8Array([0]), "image/png").hash).not.toBe(ref.hash)
    expect(store.getBlob(ref.hash)).toEqual({ hash: ref.hash, mediaType: "image/png", bytes })
    expect(store.getBlob("0".repeat(64))).toBeNull()
    expect(() => store.putBlob(bytes, "")).toThrow()
  })
})
