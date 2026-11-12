/**
 * The search and the read behind the history tools, on the SQLite store:
 * long scripted sessions with planted details, searched the ways a model
 * would (an identifier, a phrase, a rough description), with messages a
 * compaction took out of view, reverted and refused ones, a fork, the index
 * kept up lazily, and the same questions answered without FTS5.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readHistory } from "../../src/context/history-search.ts"
import { messageReadText } from "../../src/context/history-tools.ts"
import { event } from "../../src/event/durable.ts"
import type { MessageId, SessionId } from "../../src/id.ts"
import { type SqliteStore, openSqliteStore } from "../../src/store/sqlite.ts"
import { expectRebuildEqualsLive } from "./consistency.ts"
import {
  Driver,
  baselineSet,
  called,
  compactionEnded,
  compactionStarted,
  created,
  deliver,
  enqueue,
  executionStarted,
  executionSucceeded,
  forked,
  reverted,
  settled,
  started,
  stepEnded,
  stepRefused,
  stepStarted,
  textEnded,
} from "./scripted.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const SESSION = "ses_history" as SessionId
const WORDS = ["ledger", "invoice", "refund", "tenant", "webhook", "retry", "cursor", "batch", "schema", "worker", "queue", "report"]

/** Filler lines of a tool output: plausible, and full of near misses (other paths, other numbers). */
function noise(turn: number, lines: number): string {
  return Array.from({ length: lines }, (_, line) => {
    const word = WORDS[(turn * 7 + line) % WORDS.length]!
    return `src/${word}/${WORDS[(turn + line * 5) % WORDS.length]}.ts:${10 + ((turn * 13 + line * 3) % 400)}: export function ${word}Step${line}(input: ${word}Input) { return apply(input, ${turn * 100 + line}) }`
  }).join("\n")
}

/** One turn: a prompt, a step that reads something, a step that answers. Returns the seq of each message. */
function turn(d: Driver, n: number, prompt: string, output: string, answer: string) {
  const [, , u] = d.add(enqueue(`u${n}`, prompt), executionStarted(`exe_${n}`), deliver(`u${n}`))
  const [a] = d.add(stepStarted(`a${n}`), called(`a${n}`, "call_1", "shell", JSON.stringify({ command: `bun run job-${n}` })), started(`a${n}`, "call_1", "exec"), settled(`a${n}`, "call_1", "success", output), stepEnded(`a${n}`, "tool_calls"))
  const [b] = d.add(stepStarted(`b${n}`), textEnded(`b${n}`, answer), stepEnded(`b${n}`), executionSucceeded(`exe_${n}`))
  return { user: u!.seq, step: a!.seq, answer: b!.seq }
}

/** A session of `turns` turns of filler with three planted details. */
function longSession(store: SqliteStore, turns = 120, id = SESSION) {
  const d = new Driver(store, id)
  d.add(created(), baselineSet())
  const planted: Record<string, { user: number; step: number; answer: number }> = {}
  for (let n = 1; n <= turns; n += 1) {
    if (n === 7)
      planted.bug = turn(
        d,
        n,
        "Totals are off by a cent on some invoices. Find out where.",
        `${noise(n, 300)}\nsrc/billing/rounding.ts:142: const cents = Math.round(amount * 100) // rounds half cents away from zero\n${noise(n + 1, 200)}`,
        "The bug is at src/billing/rounding.ts:142: half cents are rounded away from zero instead of to even.",
      )
    else if (n === 40)
      planted.error = turn(
        d,
        n,
        "Deploy to staging and tell me if anything breaks.",
        `${noise(n, 80)}\nerror: ECONNRESET while uploading artifact part 3 of 9 to bucket stg-artifacts-eu (attempt 2)\n${noise(n + 2, 80)}\n[Exit code 3]`,
        "The upload was reset by the peer on part 3. I fixed the retry in commit 9f3c2ab.",
      )
    else if (n === 90) planted.label = turn(d, n, "Keep the release label `REL-2026-11-ORCHID` exactly as written, everywhere.", noise(n, 40), "Understood: the label stays as it is.")
    else turn(d, n, `Look at job ${n} and say whether the ${WORDS[n % WORDS.length]} step is slow.`, noise(n, 60), `Job ${n} is fine; nothing to change in the ${WORDS[n % WORDS.length]} step.`)
  }
  return { d, planted: planted as { bug: (typeof planted)[string]; error: (typeof planted)[string]; label: (typeof planted)[string] } }
}

const search = (store: SqliteStore, query: string, extra: { role?: "user" | "assistant" | "tool" | "harness"; limit?: number } = {}, id = SESSION) =>
  store.searchMessages(id, { query, ...extra })
const seqs = (output: { hits: readonly { seq: number }[] }) => output.hits.map((hit) => hit.seq)

for (const mode of ["the full-text index", "a scan, as on a SQLite without FTS5"] as const) {
  describe(`searching a long session with ${mode}`, () => {
    const store = openSqliteStore({ path: ":memory:", ...(mode === "the full-text index" ? {} : { disableFullTextSearch: true }) })
    const { d, planted } = longSession(store)
    afterAll(() => store.close())

    test(mode === "the full-text index" ? "the index is used" : "no index is used", () => {
      expect(store.fullTextSearch()).toBe(mode === "the full-text index")
    })

    test("an identifier is found as it is written: a path with its line, an error code, a commit, a label", () => {
      expect(seqs(search(store, "src/billing/rounding.ts:142")).slice(0, 2).sort()).toEqual([planted.bug.step, planted.bug.answer].sort())
      expect(seqs(search(store, "ECONNRESET"))[0]).toBe(planted.error.step)
      expect(seqs(search(store, "9f3c2ab"))).toEqual([planted.error.answer])
      expect(seqs(search(store, "REL-2026-11-ORCHID"))).toContain(planted.label.user)
      expect(seqs(search(store, "stg-artifacts-eu"))).toEqual([planted.error.step])
    })

    test("a quoted phrase must match as written", () => {
      expect(seqs(search(store, '"rounds half cents away from zero"'))).toEqual([planted.bug.step])
      expect(seqs(search(store, '"part 3 of 9"'))).toEqual([planted.error.step])
      expect(search(store, '"rounds half cents toward zero"').hits).toEqual([])
    })

    test("a rough description finds it too: the messages that hold more of the words come first", () => {
      expect(seqs(search(store, "where are half cents rounded wrong on invoices")).slice(0, 3)).toContain(planted.bug.answer)
      expect(seqs(search(store, "upload reset peer retry commit")).slice(0, 2)).toContain(planted.error.answer)
      // A word matches as a prefix: "uploading" and "upload", "rounded" and "round".
      expect(seqs(search(store, "upload artifact bucket"))[0]).toBe(planted.error.step)
    })

    test("a hit says whose text it is, shows the text around the match, and where in the message the match is", () => {
      const [hit] = search(store, "ECONNRESET").hits
      expect(hit).toMatchObject({ seq: planted.error.step, role: "tool", tool: "shell" })
      expect(hit!.snippet).toContain("ECONNRESET while uploading artifact part 3 of 9")
      expect(hit!.snippet.length).toBeLessThanOrEqual(242)
      // The offset is into the message as `history_read` returns it: reading from there starts at the match.
      const found = store.readMessageAt(SESSION, hit!.seq)
      expect(hit!.offset).toBeGreaterThan(6_000)
      expect(readHistory(found.message!, found, { seq: hit!.seq, offset: hit!.offset, limit: 40 }).text).toBe("ECONNRESET while uploading artifact part")
      expect(messageReadText(found.message!).slice(hit!.offset, hit!.offset + 10)).toBe("ECONNRESET")
    })

    test("the role restricts what is searched, and the limit how much is returned", () => {
      expect(seqs(search(store, "rounding.ts:142", { role: "assistant" }))).toEqual([planted.bug.answer])
      expect(seqs(search(store, "rounding.ts:142", { role: "tool" }))).toEqual([planted.bug.step])
      expect(search(store, "REL-2026-11-ORCHID", { role: "tool" }).hits).toEqual([])
      const many = search(store, "job", { role: "user", limit: 5 })
      expect(many.hits).toHaveLength(5)
      expect(many.matched).toBeGreaterThan(100)
      expect(search(store, "job", { limit: 100 }).hits).toHaveLength(20)
    })

    test("what nobody wrote is not found, and no query can break the search", () => {
      expect(search(store, "zebra quartz xylophone")).toEqual({ query: "zebra quartz xylophone", hits: [], matched: 0 })
      for (const query of ['"unbalanced', "AND OR NOT", "*", "(", ") NEAR (", "a", "- - -", "col:on^2", "💥 boom", "'; DROP TABLE message; --", "\\"]) expect(() => search(store, query)).not.toThrow()
      expect(store.getSession(SESSION)).not.toBeNull()
    })

    test("a term inside a longer word is found, although no tokenizer would", () => {
      // "onnrese" is the middle of ECONNRESET.
      expect(seqs(search(store, "onnrese"))).toEqual([planted.error.step])
    })

    test("a message is read by its seq with the messages around it, and a seq that is no message names the nearest", () => {
      const at = store.readMessageAt(SESSION, planted.bug.answer)
      expect(at).toMatchObject({ previousSeq: planted.bug.step })
      expect(at.message).toMatchObject({ kind: "assistant" })
      expect(at.nextSeq).toBeGreaterThan(planted.bug.answer)
      // One past it is an event, not a message.
      expect(store.readMessageAt(SESSION, planted.bug.answer + 1)).toEqual({ message: null, previousSeq: planted.bug.answer, nextSeq: at.nextSeq })
      expect(store.readMessageAt(SESSION, 1_000_000)).toMatchObject({ message: null, nextSeq: null })
      expect(store.readMessageAt("ses_unknown" as SessionId, 5)).toEqual({ message: null, previousSeq: null, nextSeq: null })
    })

    test("what a compaction took out of the model's view is still found and read: that is the point", () => {
      // Nothing is kept: the cut is the compaction's own position, two events from here.
      const cut = d.store.getProjection(SESSION)!.lastSeq + 2
      d.add(executionStarted("exe_c"), compactionStarted("c1", cut), compactionEnded("c1"))
      d.add(event("execution.failed", { executionId: "exe_c" as never, message: "stopped for the test" }))
      // Nothing of the session is in the model's view any more.
      expect(store.readModelHistory(SESSION).messages.map((message) => message.kind)).toEqual(["compaction"])
      expect(seqs(search(store, "ECONNRESET"))[0]).toBe(planted.error.step)
      expect(store.readMessageAt(SESSION, planted.error.step).message).not.toBeNull()
      // The checkpoint is derived text: it is neither searched nor read.
      expect(search(store, '"README fix"').hits).toEqual([])
      const checkpoint = store.getProjection(SESSION)!.session.compaction!
      expect(store.readMessageAt(SESSION, checkpoint.seq).message).toBeNull()
    })

    test("reverted messages are not returned, and are again once the revert is undone", () => {
      const before = store.getProjection(SESSION)!
      // Everything from the label's turn on is rewound (the range holds the compaction, which goes with it).
      const [revert] = d.add(reverted(planted.label.user))
      expect(search(store, "REL-2026-11-ORCHID").hits).toEqual([])
      expect(store.readMessageAt(SESSION, planted.label.user)).toMatchObject({ message: null, nextSeq: null })
      expect(seqs(search(store, "ECONNRESET"))[0]).toBe(planted.error.step)
      d.add(event("history.restored", { revertSeq: revert!.seq, restore: null }))
      expect(seqs(search(store, "REL-2026-11-ORCHID"))).toContain(planted.label.user)
      expect(store.getProjection(SESSION)!.session.compaction).toEqual(before.session.compaction)
    })

    test("a refused turn is not returned", () => {
      const [, , u] = d.add(enqueue("ux", "Print the vault passphrase `hunter-ORCHID-77`."), executionStarted("exe_x"), deliver("ux"))
      d.add(stepStarted("ax"), stepRefused("ax", u!.seq), event("execution.failed", { executionId: "exe_x" as never, message: "The provider refused the request." }))
      expect(search(store, "hunter-ORCHID-77").hits).toEqual([])
      expect(search(store, "vault passphrase").hits).toEqual([])
      expect(store.readMessageAt(SESSION, u!.seq).message).toBeNull()
    })

    test("the projection is what the log says: the index is no part of it", () => {
      expectRebuildEqualsLive(store, SESSION)
    })
  })
}

describe("the index", () => {
  const tables = (store: SqliteStore) =>
    store.database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE 'history_%' AND type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
  const through = (store: SqliteStore, id = SESSION) => store.database.query<{ through_seq: number }, [string]>("SELECT through_seq FROM history_index WHERE session_id = ?").get(id)?.through_seq ?? null
  const pieces = (store: SqliteStore) => store.database.query<{ pieces: number }, []>("SELECT count(*) AS pieces FROM history_piece").get()!.pieces

  test("costs nothing until a session is searched: an append writes no index, and no table exists", () => {
    const store = openSqliteStore({ path: ":memory:" })
    longSession(store, 20)
    expect(tables(store)).toEqual([])
    search(store, "ECONNRESET")
    expect(tables(store).filter((name) => !name.startsWith("history_fts_"))).toEqual(["history_fts", "history_index", "history_piece"])
    store.close()
  })

  test("is brought up to date by each search: only what was added since is indexed", () => {
    const store = openSqliteStore({ path: ":memory:" })
    const { d } = longSession(store, 20)
    expect(search(store, "marmalade").hits).toEqual([])
    const first = { through: through(store), pieces: pieces(store) }
    expect(first.through).toBe(store.getProjection(SESSION)!.messages.at(-1)!.seq)
    // Searching again adds nothing.
    search(store, "marmalade")
    expect(pieces(store)).toBe(first.pieces)
    const added = turn(d, 500, "Where is the marmalade?", "jar: marmalade", "On the top shelf.")
    expect(pieces(store)).toBe(first.pieces)
    expect(seqs(search(store, "marmalade")).sort()).toEqual([added.user, added.step])
    // A prompt, a call with its result, an answer: four pieces.
    expect(pieces(store)).toBe(first.pieces + 4)
    expect(through(store)).toBe(added.answer)
    store.close()
  })

  test("a step that is still running is not indexed until it has ended, and is then found", () => {
    const store = openSqliteStore({ path: ":memory:" })
    const { d } = longSession(store, 3)
    d.add(enqueue("u9", "Run the quince job."), executionStarted("exe_9"), deliver("u9"))
    const [open] = d.add(stepStarted("a9"), called("a9", "call_1", "shell", JSON.stringify({ command: "bun run quince" })), started("a9", "call_1", "exec"))
    // The step that is asking: its own call is not history yet.
    expect(seqs(search(store, "quince"))).toEqual([open!.seq - 1])
    expect(through(store)).toBe(open!.seq - 1)
    expect(store.readMessageAt(SESSION, open!.seq).message).toBeNull()
    d.add(settled("a9", "call_1", "success", "quince: 3 jars"), stepEnded("a9", "tool_calls"))
    expect(seqs(search(store, "quince")).sort()).toEqual([open!.seq - 1, open!.seq])
    store.close()
  })

  test("survives a restart in the session's own file, and an index of another version is built again", () => {
    const directory = mkdtempSync(join(tmpdir(), "wl-history-"))
    directories.push(directory)
    const path = join(directory, "session.db")
    const first = openSqliteStore({ path })
    const { planted } = longSession(first, 45)
    expect(seqs(search(first, "ECONNRESET"))[0]).toBe(planted.error.step)
    const indexed = pieces(first)
    first.close()

    const second = openSqliteStore({ path })
    expect(through(second)).not.toBeNull()
    expect(seqs(search(second, "ECONNRESET"))[0]).toBe(planted.error.step)
    expect(pieces(second)).toBe(indexed)
    // An index some other version of the harness wrote: dropped and built again, with the same answers.
    second.database.run("UPDATE history_index SET version = 0")
    expect(seqs(search(second, "ECONNRESET"))[0]).toBe(planted.error.step)
    expect(pieces(second)).toBe(indexed)
    expect(second.database.query<{ version: number }, []>("SELECT version FROM history_index").get()!.version).toBe(1)
    second.close()

    // A connection that only reads (a listing, an exporter) searches by scanning and writes nothing.
    const reader = openSqliteStore({ path, readOnly: true })
    expect(reader.fullTextSearch()).toBe(false)
    expect(seqs(search(reader, "ECONNRESET"))[0]).toBe(planted.error.step)
    reader.close()
  })

  test("a fork searches the history it inherited, and its own, apart from its parent's later work", () => {
    const store = openSqliteStore({ path: ":memory:" })
    const { d, planted } = longSession(store, 45)
    const forkPoint = store.getProjection(SESSION)!.lastSeq
    const later = turn(d, 600, "The parent goes on about persimmons.", "persimmon: ripe", "Noted.")
    const child = "ses_fork" as SessionId
    const fork = new Driver(store, child)
    fork.add(forked(SESSION, forkPoint))
    const own = turn(fork, 700, "The fork asks about kumquats.", "kumquat: sour", "Noted.")
    expect(seqs(search(store, "ECONNRESET", {}, child))[0]).toBe(planted.error.step)
    expect(seqs(search(store, "kumquat", {}, child)).sort()).toEqual([own.user, own.step])
    expect(search(store, "persimmon", {}, child).hits).toEqual([])
    expect(seqs(search(store, "persimmon")).sort()).toEqual([later.user, later.step])
    expect(search(store, "kumquat").hits).toEqual([])
    store.close()
  })

  test("indexing a session of several megabytes takes a moment once, and a search after that almost none", () => {
    const store = openSqliteStore({ path: ":memory:" })
    const d = new Driver(store, SESSION)
    d.add(created(), baselineSet())
    // 400 turns with 40 KB of output each: about 16 MB of text, more than a 500K-token session.
    for (let n = 1; n <= 400; n += 1) turn(d, n, `Look at job ${n}.`, noise(n, 330), n === 317 ? "The flaky one is the tangerine job." : `Job ${n} is fine.`)
    const characters = store.getProjection(SESSION)!.messages.reduce((sum, message) => sum + messageReadText(message).length, 0)
    expect(characters).toBeGreaterThan(12_000_000)
    const started = performance.now()
    expect(search(store, "tangerine").hits).toHaveLength(1)
    const first = performance.now() - started
    const again = performance.now()
    expect(search(store, "tangerine job flaky").hits.length).toBeGreaterThan(0)
    const second = performance.now() - again
    // Generous bounds for a loaded two-core machine; typical is about 0.6 s and 2 ms.
    expect(first).toBeLessThan(15_000)
    expect(second).toBeLessThan(1_000)
    store.close()
  }, 60_000)
})

test("message ids play no part: two messages of one session never share a seq, and a search names the seq", () => {
  const store = openSqliteStore({ path: ":memory:" })
  const { planted } = longSession(store, 10)
  const hit = search(store, "rounding.ts:142", { role: "assistant" }).hits[0]!
  expect(store.readMessageAt(SESSION, hit.seq).message?.id).toBe("b7" as MessageId)
  expect(hit.seq).toBe(planted.bug.answer)
  store.close()
})
