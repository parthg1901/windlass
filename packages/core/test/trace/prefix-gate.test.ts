/**
 * The prefix gate: the harness's own test suite fails if any request
 * rewrites the prefix of the request before it.
 *
 * Every scripted multi-step session is recorded into a store the way the step
 * loop records it, exported, and each consecutive pair of verified requests
 * goes through prefixlens's `assertPrefixStable`. A pair may break the prefix
 * only when a legitimate break event (compaction, revert, refusal, settings
 * change) was appended between the two calls, and only as far as that event
 * reaches; see src/trace/gate.ts.
 *
 * Two sessions recorded with a deliberately broken request builder show that
 * the gate fails, and that its message names the changed block.
 */
import { describe, expect, test } from "bun:test"
import { type BuildOptions, buildRequest } from "../../src/request/build.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { exportSession } from "../../src/trace/export.ts"
import { type PrefixPair, prefixPairs } from "../../src/trace/gate.ts"
import type { Projection } from "../../src/message/message.ts"
import { loadPrefixlens, withPrefixlens } from "./prefixlens.ts"
import { COMPACTION_PROMPT, SCRIPTS, type StepBuilder, type TraceScript, openTestStore, record } from "./sessions.ts"

const prefixlens = await loadPrefixlens()

/** Records `script` with `builder`, exports it (rebuilding with the same builder), and runs the gate over every pair. */
function gate(script: TraceScript, builder?: StepBuilder) {
  const store = openTestStore()
  const loop = record(store, script, builder)
  const result = exportSession(store, loop.id, { compactionPrompt: COMPACTION_PROMPT, ...(builder ? { buildStep: builder } : {}) })
  store.close()
  const pairs = prefixPairs(result)
  const failures = pairs.flatMap((pair) => {
    try {
      prefixlens!.test.assertPrefixStable(pair.previous.request, pair.next.request, options(pair))
      return []
    } catch (error) {
      return [{ pair, message: error instanceof Error ? error.message : String(error) }]
    }
  })
  return { result, pairs, failures }
}

const options = (pair: PrefixPair) => ({ provider: "openai" as const, ...(pair.allowBreak ? { allowBreak: pair.allowBreak } : {}) })

const multiStep = SCRIPTS

describe.skipIf(prefixlens === null)(withPrefixlens("prefix gate"), () => {
  test.each(multiStep.map((script) => [script.name, script] as const))("%s keeps its prefix between every pair of requests", (_, script) => {
    const { result, pairs, failures } = gate(script)
    // A request that cannot be shown to be the one sent cannot be gated, so it fails the gate too.
    expect(result.unverified).toEqual([])
    expect(pairs.length).toBe(result.calls.length - 1)
    expect(failures.map((failure) => failure.message)).toEqual([])
  })

  test.each(multiStep.filter((script) => !script.clean).map((script) => [script.name, script] as const))(
    "%s breaks the prefix only where it is allowed to, and needs the allowance there",
    (_, script) => {
      const { pairs } = gate(script)
      for (const pair of pairs) {
        const bare = prefixlens!.test.explainPrefixDiff(pair.previous.request, pair.next.request, { provider: "openai" })
        expect({ pair: pair.next.row.id, stable: bare.stable }).toEqual({ pair: pair.next.row.id, stable: pair.allowBreak === undefined })
      }
    },
  )

  test("a revert or refusal may not change the tools or instructions", () => {
    const { pairs } = gate(SCRIPTS.find((script) => script.name === "revert")!)
    const reverted = pairs.find((pair) => pair.causes.includes("revert"))!
    // The revert's own declaration: prefixlens's "revert" reason keeps the tools and system prompt by default.
    expect(reverted.allowBreak).toEqual({ reason: "revert" })
    expect(reverted.allowBreak).toEqual({ reason: reverted.next.declared[0]!.reason })
    const next = { ...reverted.next.request, blocks: reverted.next.request.blocks.toReversed() }
    expect(() => prefixlens!.test.assertPrefixStable(reverted.previous.request, next, options(reverted))).toThrow(
      "a break was allowed (revert) only after block",
    )
  })

  test("seeded bug: the tool list in another order on the second request", () => {
    const reorder: StepBuilder = (projection: Projection, build: BuildOptions): ModelRequest => {
      const request = buildRequest(projection, build)
      return request.input.length > 1 ? { ...request, tools: request.tools.toReversed() } : request
    }
    const { result, failures } = gate(SCRIPTS.find((script) => script.name === "multi-step turns")!, reorder)
    // The ledger was written by the same builder, so the export proves these are the requests that were sent.
    expect(result.unverified).toEqual([])
    expect(failures).toHaveLength(1)
    const failure = failures[0]!
    expect(failure.pair.next.row.id).toBe(result.calls[1]!.row.id)
    expect(failure.message).toContain("prefix not stable: tool order changed")
    expect(failure.message).toContain('first changed block: 1 of 4 (tool "read", now tool "shell")')
    console.log(`seeded tool-order bug, gate message:\n${failure.message}`)
  })

  test("seeded bug: an earlier tool output rewritten on replay", () => {
    // Truncates every tool output but the latest, as a builder that shortens old outputs on replay would.
    const truncate: StepBuilder = (projection: Projection, build: BuildOptions): ModelRequest => {
      const request = buildRequest(projection, build)
      const latest = request.input.findLastIndex((item) => item.type === "tool_result")
      return {
        ...request,
        input: request.input.map((item, index) =>
          item.type === "tool_result" && index < latest ? { ...item, output: `${item.output.slice(0, 8)}…` } : item,
        ),
      }
    }
    const { result, failures } = gate(SCRIPTS.find((script) => script.name === "multi-step turns")!, truncate)
    expect(result.unverified).toEqual([])
    expect(failures).toHaveLength(1)
    const failure = failures[0]!
    expect(failure.pair.next.row.id).toBe(result.calls[2]!.row.id)
    // Tools read and shell, the instructions, then u1, the reasoning, the text, the call and its output: block 8.
    expect(failure.message).toContain("first changed block: 8 of")
    expect(failure.message).toContain("function_call_output")
    console.log(`seeded replay bug, gate message:\n${failure.message}`)
  })
})
