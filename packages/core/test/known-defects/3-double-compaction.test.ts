/**
 * Known defect 3: one compaction becomes two summary calls in one turn.
 *
 * Observed: 18,566 → 13,063 tokens (a normal compaction that kept a large last
 * step), then at once 13,062 → 5,546 (an aggressive one). Reproduced here
 * with the scripted provider measuring each request as the estimator counts
 * it, and a 14,000-token window (usable 11,200, trigger 8,960): a few
 * 1,500-token reads, then one 11,000-token read in the middle of the turn.
 *
 * The chain: `engine.ts` `LiveSession.loop` → `beforeStep` → `policy.ts`
 * `decideCompaction` says `now`, `normal` (no compaction yet) → `compact`:
 * `chooseTail(view, { budget, mandatory: "always" })` keeps the last step
 * (the 11,000-token result) whatever the budget; it removes more than a
 * quarter of the view, so the "less than a quarter" escape (the
 * `plan.otherwise` branch) is not taken, and the summary call is made. The
 * size after (`tokensAfter`, computed from `tail.keptTokens` after the call)
 * is still over the usable window, so at the next boundary `decideCompaction`
 * says `now` again; that normal compaction could free less than a quarter
 * (only the checkpoint is before the cut), the request does not fit, and the
 * `otherwise` branch turns it aggressive: a second summary call.
 *
 * Everything needed to see it coming is known before the first summary call:
 * `tail.keptTokens`, the fixed tokens, and the summary and checkpoint bounds
 * (`summaryMaxTokens`, `checkpointExtraMaxTokens`). The smallest fix: in
 * `compact`, for a normal compaction with `plan.otherwise`, predict the size
 * after (fixed + bounds + kept, as `tokensAfter` is computed) and when that
 * does not fit the usable window, go aggressive at once, as the
 * less-than-a-quarter branch already does. (Whether "does not fit" or "over
 * the trigger" is the test is the owner's call: over the trigger but inside
 * the window is today one normal compaction followed by sending, which is
 * fine.) It could affect: the long-session and compaction tests that count
 * compactions by mode; a model that would have answered its last result
 * gets it only through the summary.
 *
 * The second part of the report, the turn's ending counting "4 steps" where
 * 6 model requests were made, is a client's count: `packages/cli/src/renderer.ts`
 * adds one per `step.started` (and `packages/tui/src/transcript.ts` the
 * same), and summary calls write no `step.started`. The log does say how many
 * summary calls there were: one per `compaction.started` plus one per
 * `compaction.repair_requested`, and the request ledger has a row with
 * `purpose: "compaction"` per call. The last test pins that a client can
 * count both from the log alone; it holds today.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type ScriptItem, script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "../engine/harness.ts"
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

describe("known defect 3: a normal compaction that cannot get under the window is followed at once by an aggressive one", () => {
  test.failing("one compaction, one summary call: the policy sees beforehand that the kept last step does not fit", async () => {
    const h = new Harness({ contextWindow: WINDOW })
    try {
      await run(h)
      const started = of(h, "compaction.started")
      const ended = of(h, "compaction.ended")
      console.log(`defect 3: ${started.map((item, index) => `${item.data.mode} ${item.data.tokensBefore} → ${ended[index]?.data.tokensAfter}`).join(", ")}`)
      expect(h.provider.requests.filter(isSummary)).toHaveLength(1)
      expect(started.map((item) => item.data.mode)).toEqual(["aggressive"])
    } finally {
      await h.dispose()
    }
  })

  // Holds today: what a client needs to count summary calls apart from steps is in the log.
  test("the log tells steps from summary calls: one step.started per step, one compaction.started (plus repairs) per summary call", async () => {
    const h = new Harness({ contextWindow: WINDOW })
    try {
      await run(h)
      const steps = of(h, "step.started").length
      const summaries = of(h, "compaction.started").length + of(h, "compaction.repair_requested").length
      expect(steps + summaries).toBe(h.provider.requests.length)
      const ledger = h.store.readRequests(h.session.id)
      expect(ledger.filter((row) => row.purpose === "compaction")).toHaveLength(summaries)
      expect(ledger.filter((row) => row.purpose === "step")).toHaveLength(steps)
    } finally {
      await h.dispose()
    }
  })
})
