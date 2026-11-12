/**
 * A compaction that cannot fit does not cost two summary calls.
 *
 * A normal compaction keeps what the next call answers whatever the budget
 * (`chooseTail`, `mandatory: "always"`): in the middle of a turn, the last
 * step with its results. When that step is most of the window (here an
 * 11,000-token read in a 14,000-token window: usable 11,200, trigger 8,960),
 * the request after a normal compaction is still too large, the policy says
 * `now` again at the next boundary, and the compaction made there is
 * aggressive: two summary calls for one compaction's worth of room.
 *
 * Everything needed to see it coming is known before the first summary
 * call: the tail's size, what no compaction removes, and the bounds of the
 * summary and the checkpoint. `compact$` (`engine.ts`) predicts the size
 * after and compacts aggressively at once when a normal compaction could
 * not fit.
 *
 * A summary call is a model request that is no step: it writes no
 * `step.started`. How many were made is on the compaction's own ending
 * (`compaction.ended.calls`, `compaction.failed.calls`), retries and the
 * repair included, so a client that counts a turn's steps can say how many
 * model requests the turn made: its `step.started` events plus the `calls`
 * of its compactions.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type ScriptItem, script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"
import { SUMMARY } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const WINDOW = 14_000

function fileText(name: string, tokens: number): string {
  const line = (index: number) => `export const ${name}_${index} = compute_${name}(${index}, "value ${index} of ${name}")`
  const each = estimateTokens(`${line(100)}\n`)
  return Array.from({ length: Math.ceil(tokens / each) }, (_, index) => line(index)).join("\n")
}
const usageOf = (request: ModelRequest, output = 40) => script.usage({ inputTokens: estimateRequest(request), cachedInputTokens: 0, outputTokens: output, reasoningTokens: 0 })
const isSummary = (request: ModelRequest) => request.toolChoice === "none" && request.input.at(-1)?.type === "message"
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

/** Four small reads, one very large one, then the answer; the model summarises whenever asked. */
async function run(h: Harness) {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "big.ts"]
  for (const [index, path] of files.entries()) h.tools.on("read", fileText(`m${index}`, path === "big.ts" ? 11_000 : 1_500))
  let next = 0
  const respond = (request: ModelRequest): readonly ScriptItem[] => {
    if (isSummary(request)) return [script.text(SUMMARY), usageOf(request, 300)]
    if (next < files.length) return [script.toolCall(`call_${next}`, "read", { path: files[next++]! }), usageOf(request)]
    return [script.text("They all export constants."), usageOf(request)]
  }
  h.provider.enqueue(...Array.from({ length: 20 }, () => respond))
  h.create().send("Read a.ts, b.ts, c.ts, d.ts and big.ts and tell me what they export.", { maxSteps: 20 })
  await h.settled()
  expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
}

describe("a compaction whose kept tail cannot fit the window", () => {
  test("one compaction, one summary call: the loop sees beforehand that the kept last step does not fit", async () => {
    const h = new Harness({ contextWindow: WINDOW })
    try {
      await run(h)
      const started = of(h, "compaction.started")
      const ended = of(h, "compaction.ended")
      expect(h.provider.requests.filter(isSummary)).toHaveLength(1)
      expect(started.map((item) => item.data.mode)).toEqual(["aggressive"])
      // It made room: the request after it fits the usable window with the estimator's margin.
      expect(ended[0]!.data.tokensAfter * 1.25).toBeLessThan(WINDOW * 0.8)
    } finally {
      await h.dispose()
    }
  })

  test("the log tells steps from summary calls: one step.started per step, and each compaction's ending says how many summary calls it took", async () => {
    const h = new Harness({ contextWindow: WINDOW })
    try {
      await run(h)
      const steps = of(h, "step.started").length
      const summaries = of(h, "compaction.ended").reduce((sum, item) => sum + (item.data.calls ?? 0), 0)
      expect(summaries).toBe(of(h, "compaction.started").length + of(h, "compaction.repair_requested").length)
      expect(steps + summaries).toBe(h.provider.requests.length)
      const ledger = h.store.readRequests(h.session.id)
      expect(ledger.filter((row) => row.purpose === "compaction")).toHaveLength(summaries)
      expect(ledger.filter((row) => row.purpose === "step")).toHaveLength(steps)
    } finally {
      await h.dispose()
    }
  })

  test("a summary call the provider failed and the loop sent again is counted: no event but the ending says so", async () => {
    const h = new Harness({ contextWindow: WINDOW })
    try {
      let failed = false
      const files = ["a.ts", "b.ts", "c.ts", "d.ts", "big.ts"]
      for (const [index, path] of files.entries()) h.tools.on("read", fileText(`m${index}`, path === "big.ts" ? 11_000 : 1_500))
      let next = 0
      const respond = (request: ModelRequest): readonly ScriptItem[] => {
        if (isSummary(request)) {
          if (!failed) {
            failed = true
            return [script.fail("provider_internal", { message: "The provider is overloaded" })]
          }
          return [script.text(SUMMARY), usageOf(request, 300)]
        }
        if (next < files.length) return [script.toolCall(`call_${next}`, "read", { path: files[next++]! }), usageOf(request)]
        return [script.text("They all export constants."), usageOf(request)]
      }
      h.provider.enqueue(...Array.from({ length: 20 }, () => respond))
      h.create().send("Read a.ts, b.ts, c.ts, d.ts and big.ts and tell me what they export.", { maxSteps: 20 })
      await h.settled()
      expect(h.log().at(-1)).toMatchObject({ type: "execution.succeeded" })
      expect(of(h, "compaction.started")).toHaveLength(1)
      expect(of(h, "compaction.repair_requested")).toEqual([])
      expect(of(h, "compaction.ended").map((item) => item.data.calls)).toEqual([2])
      expect(of(h, "step.started").length + 2).toBe(h.provider.requests.length)
    } finally {
      await h.dispose()
    }
  })
})
