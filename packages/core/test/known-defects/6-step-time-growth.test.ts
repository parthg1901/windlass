/**
 * Known defect 6 (a measurement, not a `test.failing`): the time of a step
 * grows with the length of the log.
 *
 * Reported from `test/engine/long-session.test.ts`: the median time per
 * model call went from about 92 ms at 531K tokens of history to 232 ms at
 * 2M, with the scripted provider, so it is the harness's own work.
 *
 * This drives one session the same way (turns of 9,000-token reads, a
 * 128,000-token window, compactions as they come) and wraps the session's
 * store, in place, with timers: every store method the engine calls is
 * counted and timed per model call. It prints, for the first and the last
 * quarter of the calls, the median time between calls and where it went.
 * Only a generous bound is asserted.
 *
 * What it shows (see the report; numbers on the loaded two-core machine):
 * `getProjection` dominates and grows linearly with the log. The engine
 * reads the projection through `LiveSession.projection()` (`engine.ts`),
 * which calls `store.getProjection` (`store/sqlite.ts`, `loadProjection`):
 * every message row of the session, compacted away or not, is read and
 * decoded through the validators (`decodeMessage`) on every call, and the
 * loop calls it several times per step (the top of `loop`, `waiting`,
 * `ready`, `prepare`, `closeStep`, `assistant`, `authorize`'s fact context,
 * `grants`, `noticeTaint`, every `write` that checks `expectedSeq`, …).
 * The cost per call is O(all messages ever written), and the number of calls
 * per step is constant, so the time per step is O(log length) although the
 * model's view is bounded by the window.
 *
 * Set `<BRAND>_DEFECT6_TOKENS` (the name built from `brand`) for a longer run.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { createEngine } from "../../src/engine/engine.ts"
import type { ExecutionId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import { dateSource } from "../../src/instructions/source.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider } from "../../src/testing/fake-provider.ts"
import { estimateMessage, estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type ScriptItem, script } from "../../src/testing/fake-provider.ts"
import { ManualClock, ScriptedTools } from "../engine/harness.ts"
import { SUMMARY } from "../scenarios/script.ts"

const directory = mkdtempSync(join(tmpdir(), "lh-defect-6-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const WINDOW = 128_000
const TARGET = Number(process.env[`${brand.binary.toUpperCase()}_DEFECT6_TOKENS`] ?? 400_000)
const FILE_TOKENS = 9_000
const READS_PER_TURN = [6, 12, 3, 9]

function fileText(name: string, tokens: number): string {
  const line = (index: number) => `export const ${name}_${index} = compute_${name}(${index}, "value ${index} of ${name}")`
  const each = estimateTokens(`${line(100)}\n`)
  return Array.from({ length: Math.ceil(tokens / each) }, (_, index) => line(index)).join("\n")
}
const usageOf = (request: ModelRequest, output = 60) => script.usage({ inputTokens: estimateRequest(request), cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0 })
const isSummary = (request: ModelRequest) => request.toolChoice === "none" && request.input.at(-1)?.type === "message" && (request.input.at(-1) as { role?: string }).role === "developer"
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

interface Interval {
  /** Wall-clock ms since the previous model call. */
  readonly ms: number
  /** Per store method: [calls, ms] in this interval. */
  readonly store: Record<string, [number, number]>
  readonly messages: number
  readonly events: number
  readonly summary: boolean
}

describe("known defect 6: the time of a step grows with the log", () => {
  test(
    "measures where the time between model calls goes, early and late in a long session",
    async () => {
      // The engine as the test harness builds it, on a store whose methods are timed: the engine copies the
      // store's methods when it is made, so the timers go in first.
      const clock = new ManualClock()
      const real = openSqliteStore({ path: join(directory, "store.db"), now: () => clock.now() })
      let current: Record<string, [number, number]> = {}
      const timed = { ...real } as unknown as Record<string, unknown>
      for (const [name, original] of Object.entries(real)) {
        if (typeof original !== "function") continue
        timed[name] = (...args: unknown[]) => {
          const start = performance.now()
          try {
            return (original as (...a: unknown[]) => unknown)(...args)
          } finally {
            const entry = (current[name] ??= [0, 0])
            entry[0] += 1
            entry[1] += performance.now() - start
          }
        }
      }
      const provider = new FakeProvider()
      const tools = new ScriptedTools()
      const counters = { session: 0, message: 0, execution: 0, request: 0, spawn: 0 }
      const engine = createEngine({
        store: timed as unknown as typeof real,
        provider,
        tools: tools.list(),
        dataDir: directory,
        workDir: join(directory, "work"),
        clock,
        random: () => 0,
        limits: { modelCallTimeoutMs: 0, compactionCallTimeoutMs: 0 },
        contextWindow: () => WINDOW,
        snapshots: null,
        approval: null,
        loadConfig: null,
        prompt: "You are a coding agent.",
        discover: () => [dateSource(2026, 11, 12)],
        ids: {
          session: () => `ses_${++counters.session}` as SessionId,
          message: () => `msg_${++counters.message}` as MessageId,
          execution: () => `exe_${++counters.execution}` as ExecutionId,
          request: () => `req_${++counters.request}` as RequestId,
          spawn: () => `bg_${++counters.spawn}`,
        },
        log: () => {},
        strict: true,
      })
      try {
        const intervals: Interval[] = []
        let last = performance.now()
        let plan: { reads: string[]; answer: string } = { reads: [], answer: "" }
        let calls = 0
        const session = engine.createSession({ cwd: "/repo", settings: { model: "gpt-test", reasoningEffort: "medium" } })
        const respond = (request: ModelRequest): readonly ScriptItem[] => {
          const now = performance.now()
          const projection = real.getProjection(session.id)!
          intervals.push({ ms: now - last, store: current, messages: projection.messages.length, events: projection.lastSeq, summary: isSummary(request) })
          current = {}
          calls += 1
          const answer: readonly ScriptItem[] = isSummary(request)
            ? [script.text(SUMMARY), usageOf(request, 400)]
            : plan.reads.length > 0
              ? [script.toolCall(`call_${calls}`, "read", { path: plan.reads.shift()! }), usageOf(request)]
              : [script.text(plan.answer), usageOf(request)]
          last = performance.now()
          return answer
        }
        let history = 0
        let turns = 0
        let file = 0
        while (history < TARGET) {
          turns += 1
          const reads = Array.from({ length: READS_PER_TURN[(turns - 1) % READS_PER_TURN.length]! }, () => `src/module-${file++}.ts`)
          for (const path of reads) tools.on("read", fileText(`m${path.match(/\d+/)![0]}`, FILE_TOKENS))
          plan = { reads, answer: `Turn ${turns} done.` }
          provider.enqueue(...Array.from({ length: reads.length + 4 }, () => respond))
          session.send(`Turn ${turns}: read ${reads.join(", ")}.`, { maxSteps: 50 })
          await session.settled()
          expect(real.readEvents(session.id).at(-1)).toMatchObject({ type: "execution.succeeded" })
          history = session.projection().messages.filter((message) => message.kind !== "compaction").reduce((sum, message) => sum + estimateMessage(message), 0)
        }

        // The first interval includes the session's creation; leave it out.
        const steps = intervals.slice(1).filter((item) => !item.summary)
        const quarter = Math.max(1, Math.floor(steps.length / 4))
        const describe = (label: string, part: readonly Interval[]) => {
          const methods = new Map<string, { calls: number; ms: number }>()
          for (const item of part)
            for (const [name, [count, ms]] of Object.entries(item.store)) {
              const entry = methods.get(name) ?? { calls: 0, ms: 0 }
              methods.set(name, { calls: entry.calls + count, ms: entry.ms + ms })
            }
          const total = part.reduce((sum, item) => sum + item.ms, 0)
          const top = [...methods].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5)
          return [
            `  ${label}: ${part.length} calls at ${part[0]!.events}-${part.at(-1)!.events} events, ${part[0]!.messages}-${part.at(-1)!.messages} messages; median ${median(part.map((item) => item.ms)).toFixed(1)} ms per call`,
            `    store time ${((top.reduce((sum, [, entry]) => sum + entry.ms, 0) / total) * 100).toFixed(0)}% of the interval: ${top.map(([name, entry]) => `${name} ${(entry.calls / part.length).toFixed(1)}x ${(entry.ms / part.length).toFixed(1)} ms`).join(", ")}`,
          ]
        }
        const early = steps.slice(0, quarter)
        const late = steps.slice(-quarter)
        console.log(
          [
            `defect 6: ${turns} turns, ${history.toLocaleString("en")} tokens of history, ${intervals.length} model calls`,
            ...describe("first quarter", early),
            ...describe("last quarter", late),
          ].join("\n"),
        )
        // Generous: on the development machine a call takes a small fraction of this, even late.
        expect(median(late.map((item) => item.ms))).toBeLessThan(5_000)
      } finally {
        await engine.close()
        real.close()
      }
    },
    { timeout: 600_000 },
  )
})
