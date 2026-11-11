/**
 * A rough performance check, skipped unless asked for:
 *
 *   STORE_PERF=1 bun test packages/core/test/store/perf.test.ts
 *
 * Times 10,000 single-event appends to one long session, on a file (each
 * commit fsyncs, `synchronous = FULL`) and in memory (CPU only), and checks
 * that the cost of an append does not grow with the session's length.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NewEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { expectRebuildEqualsLive } from "./consistency.ts"
import {
  baselineSet,
  called,
  created,
  deliver,
  enqueue,
  executionStarted,
  executionSucceeded,
  settled,
  started,
  stepEnded,
  stepStarted,
  textEnded,
} from "./scripted.ts"

const APPENDS = 10_000

/** An endless realistic session: each turn is a prompt, a step with two tool calls, and a final answer. */
function* session(): Generator<NewEvent> {
  yield created()
  yield baselineSet()
  for (let turn = 0; ; turn++) {
    const t = (name: string) => `${name}${turn}`
    yield enqueue(t("u"), `Prompt ${turn}: change line ${turn} of src/app.ts`)
    yield executionStarted(t("exe_"))
    yield deliver(t("u"))
    yield stepStarted(t("a"))
    yield textEnded(t("a"), "Reading the file first.")
    yield called(t("a"), "call_1", "read", `{"path":"src/app.ts","line":${turn}}`)
    yield called(t("a"), "call_2", "shell", '{"cmd":"git diff --stat"}')
    yield started(t("a"), "call_1")
    yield started(t("a"), "call_2", "exec")
    yield settled(t("a"), "call_1", "success", "x".repeat(2000))
    yield settled(t("a"), "call_2", "success", " src/app.ts | 2 +-")
    yield stepEnded(t("a"), "tool_calls")
    yield stepStarted(t("b"))
    yield textEnded(t("b"), "Done.")
    yield stepEnded(t("b"))
    yield executionSucceeded(t("exe_"))
  }
}

function run(path: string) {
  const store = openSqliteStore({ path })
  const id = "ses_perf" as SessionId
  const events = session()
  const marks: number[] = []
  const startedAt = performance.now()
  for (let index = 0; index < APPENDS; index++) {
    if (index % 1000 === 0) marks.push(performance.now())
    store.append(id, [events.next().value!])
  }
  const total = performance.now() - startedAt
  marks.push(performance.now())
  const perThousand = marks.slice(1).map((mark, index) => mark - marks[index]!)
  const messages = store.readMessages(id).length
  const rebuildStartedAt = performance.now()
  expectRebuildEqualsLive(store, id)
  const rebuild = performance.now() - rebuildStartedAt
  store.close()
  return { total, perThousand, messages, rebuild }
}

function report(label: string, result: ReturnType<typeof run>) {
  console.log(
    `${label}: ${APPENDS} appends in ${(result.total / 1000).toFixed(2)} s ` +
      `(${((result.total * 1000) / APPENDS).toFixed(0)} µs each), ${result.messages} messages; ` +
      `ms per 1000: ${result.perThousand.map((ms) => ms.toFixed(0)).join(" ")}; ` +
      `rebuild + check ${(result.rebuild / 1000).toFixed(2)} s`,
  )
}

describe.skipIf(!Bun.env.STORE_PERF)("performance", () => {
  test("in memory: the cost of an append does not grow with the session", () => {
    const result = run(":memory:")
    report("memory", result)
    // Linear growth in the reducer's array copies is fine; quadratic writes would show as a large ratio.
    expect(result.perThousand.at(-1)!).toBeLessThan(result.perThousand[0]! * 4 + 50)
  }, 300_000)

  test("on a file with synchronous = FULL", () => {
    const directory = mkdtempSync(join(tmpdir(), "lh-store-perf-"))
    try {
      report("file", run(join(directory, "store.db")))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 600_000)
})
