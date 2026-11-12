/**
 * A very long session stays usable (the exit test of the context phase).
 *
 * One session is driven through many scripted turns in which the model reads
 * large files, until the history the conversation went through passes
 * 500,000 tokens, with a context window of 128,000 tokens told to the engine
 * (usable 102,400 after the output reserve; compaction due from 66,560 at a
 * user message and from 81,920 in the middle of a turn). The scripted
 * provider "measures" each request as the estimator counts it, as the
 * compaction tests do, so the policy works on numbers that agree with each
 * other. No live request is made.
 *
 * After it: several compactions happened and each ended with a checkpoint
 * the next request starts from; no request was larger than the usable
 * window; every step request extended the previous one except right after
 * a compaction (read from the ledger by the attribution, which also rebuilds
 * every request from the log and checks it against the ledger); rebuilding
 * state from the log equals the stored rows; `history_search` finds an
 * identifier planted in the first turn; and the session opens again in a
 * fresh engine, in bounded time, and carries on. The log size, the database
 * size and the time per step are printed once; only generous bounds are
 * asserted, so a slow two-core machine does not make the test flaky.
 *
 * Measured on the two-core development machine (2026-11-12): 531,000 tokens of
 * history in 10 turns, 397 events, 79 model calls, 9 compactions (4 in the
 * middle of a turn), a 7.9 MB database, the largest request 72,300 tokens,
 * 92 ms median per model call, reopened in 38 ms; about 12 s in all. At
 * 2,000,000 tokens: 1,475 events, 37 compactions, 19.6 MB, 232 ms median per
 * call (the time of a step grows with the length of the log), reopened in
 * 100 ms; about 100 s.
 *
 * Size. By default the session goes past 500,000 tokens. `<BRAND>_LONG_SESSION_TOKENS`
 * (the name is built from `brand`) sets another target, for a quicker run or a
 * bigger one; the assertions that need the full size are kept whatever the target.
 *
 * Only the engine's public API is used (through the test harness): the tool
 * list and the number of events are whatever the engine makes them.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { estimateMessage, estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type ScriptItem, script } from "../../src/testing/fake-provider.ts"
import { attributeSession } from "../../src/trace/attribution.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const WINDOW = 128_000
/** As the engine computes it: the window minus the output reserve (the smaller of 32,000 and a fifth of the window). */
const USABLE = WINDOW - Math.min(32_000, Math.floor(WINDOW / 5))
const FULL_TARGET = 500_000
const TARGET = Number(process.env[`${brand.binary.toUpperCase()}_LONG_SESSION_TOKENS`] ?? FULL_TARGET)
/** Tokens of one file the model reads, as the estimator counts them. Under the tool output cap of 50 KB. */
const FILE_TOKENS = 9_000
/** Reads per turn, in a cycle: a 12-read turn (about 108,000 tokens) cannot fit and is compacted in its middle. */
const READS_PER_TURN = [6, 12, 3, 9]
const PLANTED = "QX-ledger-7731-quokka"

/** File content of about `tokens` tokens that no other file shares. The very first file carries the planted identifier. */
function fileText(name: string, tokens: number, planted = false): string {
  const line = (index: number) => `export const ${name}_${index} = compute_${name}(${index}, "value ${index} of ${name}")`
  const each = estimateTokens(`${line(100)}\n`)
  const lines = Array.from({ length: Math.ceil(tokens / each) }, (_, index) => line(index))
  if (planted) lines.splice(40, 0, `// the cache ledger id is ${PLANTED}; keep it`)
  return lines.join("\n")
}

const usageOf = (request: ModelRequest, output = 60) =>
  script.usage({ inputTokens: estimateRequest(request), cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0 })
const isSummary = (request: ModelRequest) => {
  const last = request.input.at(-1)
  return request.toolChoice === "none" && last?.type === "message" && last.role === "developer"
}
const ofType = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]

describe("a very long session", () => {
  test(
    `goes past ${TARGET.toLocaleString("en")} tokens of history through repeated compactions and stays usable`,
    async () => {
      const h = new Harness({ contextWindow: WINDOW })
      try {
        // ---- the model: reads the files of the turn one after the other, then answers; summarises when asked.
        let plan: { reads: string[]; answer: string; search: string | null } = { reads: [], answer: "", search: null }
        let calls = 0
        let summaries = 0
        const stepTimes: number[] = []
        let last = performance.now()
        const respond = (request: ModelRequest): readonly ScriptItem[] => {
          const now = performance.now()
          stepTimes.push(now - last)
          last = now
          calls += 1
          if (isSummary(request)) {
            summaries += 1
            return [script.text(SUMMARY), usageOf(request, 400)]
          }
          if (plan.search !== null) {
            const query = plan.search
            plan.search = null
            return [script.toolCall(`call_${calls}`, "history_search", { query }), usageOf(request)]
          }
          const path = plan.reads.shift()
          if (path !== undefined) return [script.toolCall(`call_${calls}`, "read", { path }), usageOf(request)]
          return [script.text(plan.answer), usageOf(request)]
        }
        const enqueue = (count: number) => h.provider.enqueue(...Array.from({ length: count }, () => respond))

        // ---- the turns
        const session = h.create()
        let history = 0
        let turns = 0
        let file = 0
        while (history < TARGET) {
          turns += 1
          const reads = Array.from({ length: READS_PER_TURN[(turns - 1) % READS_PER_TURN.length]! }, () => `src/module-${file++}.ts`)
          for (const path of reads) {
            const index = Number(path.match(/\d+/)![0])
            h.tools.on("read", fileText(`m${index}`, FILE_TOKENS, index === 0))
          }
          plan = { reads, answer: `Turn ${turns}: the ${reads.length} modules export constants.`, search: null }
          enqueue(reads.length + 4)
          session.send(`Turn ${turns}: read ${reads.join(", ")} and say what they export.`, { maxSteps: 50 })
          await h.settled()
          expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
          history = h.session.projection().messages.filter((message) => message.kind !== "compaction").reduce((sum, message) => sum + estimateMessage(message), 0)
        }

        // ---- a last turn: the model looks up what the first turn read.
        plan = { reads: [], answer: `The ledger id is ${PLANTED}.`, search: PLANTED }
        enqueue(4)
        session.send("What was the cache ledger id in the very first file you read?", { maxSteps: 5 })
        await h.settled()

        const events = h.log()
        const rows = h.store.readRequests(h.session.id)
        expect(h.diagnostics).toEqual([])

        // ---- several compactions, each ending with a checkpoint the next step request starts from.
        const started = ofType(events, "compaction.started")
        const ended = ofType(events, "compaction.ended")
        expect(started.length).toBeGreaterThanOrEqual(TARGET >= FULL_TARGET ? 4 : 1)
        // Both kinds happened: at a user message, and in the middle of a long turn.
        const projection = h.session.projection()
        const midTurn = started.filter((item) => projection.messages.find((message) => message.seq === item.data.keepFromSeq)?.kind === "assistant")
        if (TARGET >= FULL_TARGET) expect(midTurn.length).toBeGreaterThanOrEqual(1)
        expect(ofType(events, "compaction.failed")).toEqual([])
        expect(ended.map((item) => item.data.messageId)).toEqual(started.map((item) => item.data.messageId))
        for (const item of ended) expect(item.data.summary.length).toBeGreaterThan(SUMMARY.length)
        // ---- no request was larger than the usable window.
        const sizes = h.provider.requests.map((request) => estimateRequest(request))
        const largest = Math.max(...sizes)
        expect(largest).toBeLessThanOrEqual(USABLE)

        // ---- every step request extends the previous one except right after a compaction; every request is the log's.
        const attribution = attributeSession(events, rows)
        expect(attribution.foldFailure).toBeNull()
        expect(attribution.calls.filter((call) => !call.verified).map((call) => `${call.number}: ${call.unverified}`)).toEqual([])
        const steps = attribution.calls.filter((call) => call.purpose === "step" && call.comparedWith !== null)
        const rebuilt = steps.filter((call) => call.prefix.status !== "extension")
        expect(rebuilt.map((call) => (call.prefix.status === "rebuilt" ? call.prefix.causes.join(",") : call.prefix.status))).toEqual(started.map(() => "compaction"))
        // Each of those starts from the checkpoint: the first input item, new to the model.
        for (const call of rebuilt) expect(call.fresh.find((block) => block.source !== "params" && block.source !== "tool" && block.source !== "instructions")?.source).toBe("checkpoint")

        // ---- rebuilding state from the log equals the stored rows.
        h.verify()

        // ---- history_search finds what the first turn read, by the identifier.
        const search = ofType(events, "tool.settled").at(-1)!.data
        expect(search.outcome).toBe("success")
        expect(search.output).toContain(PLANTED)
        const firstTurnStep = h.session.projection().messages.find((message) => message.kind === "assistant")!
        expect(search.output).toContain(`seq ${firstTurnStep.seq}`)

        // ---- the numbers, once.
        const database = ["", "-wal", "-shm"].map((suffix) => join(h.dataDir, `store.db${suffix}`)).filter(existsSync).reduce((sum, path) => sum + statSync(path).size, 0)
        const totalHistory = h.session.projection().messages.filter((message) => message.kind !== "compaction").reduce((sum, message) => sum + estimateMessage(message), 0)
        const sorted = [...stepTimes].sort((a, b) => a - b)
        const slowest = sorted.at(-1)!
        const median = sorted[Math.floor(sorted.length / 2)]!

        // ---- a fresh engine opens the session and carries on.
        await h.dispose()
        const reopening = performance.now()
        h.boot()
        const reopened = h.open()
        const reopenMs = performance.now() - reopening
        plan = { reads: [], answer: "Still here.", search: null }
        enqueue(3)
        const before = h.provider.requests.length
        const resumed = performance.now()
        reopened.send("Are you still there?")
        await h.settled()
        const resumedMs = performance.now() - resumed
        expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
        expect(h.provider.requests.length).toBe(before + 1)
        // It extends the last request before the restart: the reopened session sends from the same prefix.
        const afterRows = h.store.readRequests(h.session.id)
        const lastTwo = attributeSession(h.log(), afterRows).calls.slice(-1)[0]!
        expect(lastTwo.prefix.status).toBe("extension")
        h.verify()

        console.log(
          [
            `long session: ${turns + 2} turns, ${history.toLocaleString("en")} tokens of history after the last read turn (${totalHistory.toLocaleString("en")} with the lookup), window ${WINDOW.toLocaleString("en")} (usable ${USABLE.toLocaleString("en")})`,
            `  ${events.length.toLocaleString("en")} events, ${rows.length} model calls (${summaries} summary calls), ${started.length} compactions (${[...Map.groupBy(started, (item) => `${item.data.trigger}/${item.data.mode}`)].map(([kind, list]) => `${list.length} ${kind}`).join(", ")}; ${midTurn.length} in the middle of a turn)`,
            `  database ${(database / 1e6).toFixed(1)} MB; largest request ${largest.toLocaleString("en")} tokens (estimated)`,
            `  time per model call: median ${median.toFixed(0)} ms, slowest ${slowest.toFixed(0)} ms (call ${stepTimes.indexOf(slowest) + 1} of ${stepTimes.length}), all ${(stepTimes.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s`,
            `  reopen in a fresh engine ${reopenMs.toFixed(0)} ms; the next turn ${resumedMs.toFixed(0)} ms`,
          ].join("\n"),
        )
        // Generous bounds: on the development machine these are a small fraction of them.
        expect(reopenMs).toBeLessThan(15_000)
        expect(slowest).toBeLessThan(20_000)
        if (TARGET >= FULL_TARGET) expect(history).toBeGreaterThanOrEqual(FULL_TARGET)
      } finally {
        await h.dispose()
      }
    },
    { timeout: 300_000 },
  )
})
