/**
 * Exporting stored sessions as prefixlens traces: every scripted session is
 * written into a real store the way the step loop writes it, exported, and
 * checked against SPEC.md, against the ledger, and (when the sibling
 * checkout is present) against prefixlens itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRequest } from "../../src/request/build.ts"
import { requestBlocks } from "../../src/request/request.ts"
import type { SqliteStore } from "../../src/store/sqlite.ts"
import { type ExportResult, describeUnverified, exportSession } from "../../src/trace/export.ts"
import { canonicalResponsesRequest, serializeTrace, traceHash } from "../../src/trace/format.ts"
import { NOT_HARNESS, loadPrefixlens, report, withPrefixlens } from "./prefixlens.ts"
import { COMPACTION_PROMPT, type Loop, SCRIPTS, openTestStore, record } from "./sessions.ts"
import { validateTrace } from "./spec.ts"

const prefixlens = await loadPrefixlens()

let store: SqliteStore
let directory: string
const sessions = new Map<string, { loop: Loop; result: ExportResult; trace: string }>()

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-export-"))
  store = openTestStore()
  for (const script of SCRIPTS) {
    const loop = record(store, script)
    const result = exportSession(store, loop.id, { compactionPrompt: COMPACTION_PROMPT })
    sessions.set(script.name, { loop, result, trace: serializeTrace(result.records) })
  }
})

afterAll(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const session = (name: string) => sessions.get(name)!

describe("the trace format", () => {
  test("block hashes match the SPEC.md test vectors", () => {
    expect(traceHash({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862")
    expect(traceHash({ type: "custom", name: "read_file" })).toBe("5d364be90495295000470579a9553503093c9e3b7d035f94f0626e24de3693e1")
    expect(traceHash({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe(
      "da3ac0b4d79dbe28c3c6684e1e4d037992df0e519e410c56436a23ecadf5c3c1",
    )
  })

  test("a Responses body becomes tools, then instructions and leading developer items, then the other items", () => {
    const canonical = canonicalResponsesRequest({
      model: "gpt-test",
      stream: true,
      stream_options: { include_obfuscation: false },
      store: false,
      instructions: "Be brief.",
      tools: [{ type: "function", name: "read", parameters: {} }],
      input: [
        { type: "message", role: "developer", content: "Rules." },
        { type: "message", role: "user", content: "Hi", cache_control: { type: "ephemeral" } },
        { type: "message", role: "assistant", content: "Hello." },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    })
    expect(canonical.params).toEqual({ store: false })
    expect(canonical.blocks.map((block) => [block.kind, block.key])).toEqual([
      ["tool", "read"],
      ["system", undefined],
      ["system", "developer"],
      ["message", "user"],
      ["message", "assistant"],
      ["message", "function_call_output"],
    ])
    expect(canonical.blocks[1]!.content).toEqual({ type: "text", text: "Be brief." })
    expect(canonical.blocks[3]!.content).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] })
    expect(canonical.blocks[4]!.content).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello." }] })
  })
})

describe.each(SCRIPTS.map((script) => [script.name, script] as const))("%s", (name, script) => {
  test("every ledger row is rebuilt with the hashes the ledger stored, and exported full-request", () => {
    const { result, loop } = session(name)
    expect(describeUnverified(result)).toEqual([])
    expect(result.calls.length).toBe(store.readRequests(loop.id).length)
    for (const call of result.calls) {
      expect(call.request).not.toBeNull()
      if (call.record !== null) expect(call.record.fidelity).toBe("full-request")
    }
  })

  test("the trace validates against SPEC.md and reads back as the exported blocks", () => {
    const { result, trace } = session(name)
    const validation = validateTrace(trace)
    expect(validation.errors).toEqual([])
    expect(validation.redacted.size).toBe(0)
    expect(validation.records.length).toBe(result.records.length)
    validation.records.forEach((entry, index) => expect(entry.blocks).toEqual(result.records[index]!.request!.blocks as never))
  })

  test("only calls without usage are left out, and each says why", () => {
    const { result } = session(name)
    for (const call of result.calls) expect(call.record === null).toBe(call.row.usage === null)
    expect(result.skipped.map((entry) => entry.requestId)).toEqual(
      result.calls.filter((call) => call.record === null).map((call) => call.row.id),
    )
  })

  test("usage, time, model and cache affinity come from the ledger and the session; nothing else is a header", () => {
    const { result, loop } = session(name)
    const rootId = store.getProjection(loop.id)!.session.rootId
    for (const call of result.calls) {
      if (call.record === null) continue
      const usage = call.row.usage!
      expect(call.record.usage).toEqual({
        input_tokens: usage.inputTokens - usage.cachedInputTokens,
        cache_read_tokens: usage.cachedInputTokens,
        cache_write_tokens: null,
        output_tokens: usage.outputTokens,
        reasoning_tokens: usage.reasoningTokens,
      })
      expect(call.record.ts).toBe(new Date(call.row.startedAt).toISOString())
      expect(call.record.model).toBe(call.row.model)
      expect(call.record.session).toBe(loop.id)
      expect(call.record.headers).toEqual({ "session-id": rootId })
      expect(call.record.params?.tool_choice).toBeUndefined()
    }
    expect(session(name).trace).not.toMatch(/authorization|bearer|access_token|refresh_token|account/i)
  })

  test("breaks are marked exactly where a legitimate break event was appended", () => {
    const { result } = session(name)
    const marked = Object.fromEntries(
      result.calls.flatMap((call, index) => (call.breaks.length > 0 ? [[index, call.breaks]] : [])),
    )
    expect(marked).toEqual(script.breaks as never)
    for (const call of result.calls)
      expect(call.record?.x_light_harness?.prefix_break?.causes ?? []).toEqual(call.record === null ? [] : call.breaks)
  })

  test.skipIf(prefixlens === null)(
    withPrefixlens("the exported records agree block for block with what prefixlens's proxy records for the same calls"),
    () => {
      const { result, loop } = session(name)
      for (const sent of loop.sent) {
        const call = result.calls.find((candidate) => candidate.row.id === sent.row.id)!
        if (call.record === null) continue
        const proxied = prefixlens!.recorder.buildRecord({
          api: "openai-responses",
          body: sent.body,
          response: {
            usage: {
              input_tokens: sent.row.usage!.inputTokens,
              input_tokens_details: { cached_tokens: sent.row.usage!.cachedInputTokens },
              output_tokens: sent.row.usage!.outputTokens,
              output_tokens_details: { reasoning_tokens: sent.row.usage!.reasoningTokens },
            },
            complete: true,
          },
          startedAt: new Date(sent.row.startedAt),
          headers: new Headers(sent.headers),
          session: loop.id,
          lane: "main",
          recorder: "proxy",
        })
        if (typeof proxied === "string") throw new Error(proxied)
        const { tool_choice: _, ...params } = proxied.params as Record<string, unknown>
        expect(call.record.request!.blocks).toEqual((proxied.request as { blocks: never }).blocks)
        expect(call.record.params).toEqual(params as never)
        for (const field of ["model", "ts", "usage", "headers", "provider", "fidelity", "session", "lane"])
          expect((call.record as unknown as Record<string, unknown>)[field]).toEqual(proxied[field])
      }
    },
  )

  test.skipIf(prefixlens === null)(withPrefixlens("prefixlens reads the trace without errors or warnings"), () => {
    const parsed = prefixlens!.reader.parseTrace(session(name).trace)
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])
    expect(parsed.records.length).toBe(session(name).result.records.length)
  })

  test.skipIf(prefixlens === null)(
    withPrefixlens(
      script.clean
        ? "prefixlens report shows one lane and no harness-caused miss"
        : "prefixlens report shows one lane and misses only at calls marked as legitimate breaks",
    ),
    async () => {
      const file = join(directory, `${session(name).loop.id}.trace.jsonl`)
      await Bun.write(file, session(name).trace)
      const { json } = report(prefixlens!.cli, file)
      expect(json.report).toBe("prefixlens")
      expect(json.summary.lanes).toEqual(["main"])
      expect(json.summary.fidelity.usage_only).toBe(0)
      const records = session(name).result.records
      const missed = json.turns.filter((turn) => turn.status === "miss" || turn.status === "partial")
      if (script.clean) {
        expect(missed.filter((turn) => !NOT_HARNESS.has(turn.cause?.group ?? "unknown causes"))).toEqual([])
        expect(json.summary.misses).toBe(0)
      }
      for (const turn of missed) expect(records[turn.turn - 1]!.x_light_harness?.prefix_break).toBeDefined()
    },
  )
})

describe("a request that cannot be shown to be the one sent", () => {
  const fresh = (name: string) => {
    const local = openTestStore()
    const loop = record(local, SCRIPTS.find((script) => script.name === name)!)
    return { local, loop }
  }

  test("a corrupted ledger row is reported with the first differing block and exported usage-only", () => {
    const { local, loop } = fresh("multi-step turns")
    const target = local.readRequests(loop.id)[2]!
    const blocks = target.blocks.map((block, index) => (index === 4 ? { ...block, hash: "0".repeat(64) } : block))
    local.database.run("UPDATE request SET blocks = ? WHERE id = ?", [JSON.stringify(blocks), target.id])

    const result = exportSession(local, loop.id)
    expect(result.unverified).toHaveLength(1)
    const problem = result.unverified[0]!
    expect(problem).toMatchObject({ requestId: target.id, ordinal: target.ordinal, reason: "hash_mismatch" })
    expect(problem.block).toEqual({ number: 5, stored: blocks[4]!, rebuilt: target.blocks[4]! })
    expect(describeUnverified(result)[0]).toContain(`request ${target.id}`)
    expect(describeUnverified(result)[0]).toContain("block 5 of")

    const call = result.calls[2]!
    expect(call.request).toBeNull()
    expect(call.record).toMatchObject({ fidelity: "usage-only", x_light_harness: { verified: false } })
    expect(call.record!.request).toBeUndefined()
    expect(call.record!.x_light_harness!.unverified_reason).toContain("block 5")
    // The other rows are still proven, and the mixed trace is still a valid trace.
    expect(result.calls.filter((other) => other.request !== null)).toHaveLength(result.calls.length - 1)
    expect(validateTrace(serializeTrace(result.records)).errors).toEqual([])
    local.close()
  })

  test("a tampered event is reported on every later call, at the block it changed", () => {
    const { local, loop } = fresh("multi-step turns")
    const position = requestBlocks(buildRequest(local.getProjection(loop.id)!, { toolChoice: "auto" })).findIndex(
      (block) => block.kind === "input" && block.item.type === "tool_result" && block.item.callId === "call_1",
    )
    const settledSeq = local.readEvents(loop.id).find((event) => event.type === "tool.settled" && event.data.callId === "call_1")!.seq
    // The log is append-only; only a deliberate edit of the file gets past the trigger.
    local.database.run("DROP TRIGGER event_no_update")
    local.database.run("UPDATE event SET data = replace(data, 'true', 'false') WHERE session_id = ? AND seq = ?", [
      loop.id,
      settledSeq,
    ])

    expect(local.readEvents(loop.id)[settledSeq - 1]).toMatchObject({ data: { output: '{"strict": false}' } })
    const result = exportSession(local, loop.id)
    const after = result.calls.filter((call) => call.startSeq! > settledSeq)
    const before = result.calls.filter((call) => call.startSeq! < settledSeq)
    expect(after.length).toBeGreaterThan(0)
    expect(before.length).toBeGreaterThan(0)
    for (const call of before) expect(call.unverified).toBeNull()
    for (const call of after) {
      expect(call.unverified).toMatchObject({ reason: "hash_mismatch", block: { number: position + 1 } })
      expect(call.unverified!.block!.stored!.kind).toBe("input")
      expect(call.record!.fidelity).toBe("usage-only")
    }
    expect(result.unverified).toHaveLength(after.length)
    local.close()
  })

  test("an event the reducer rejects stops the rebuild, and every later call says so", () => {
    const { local, loop } = fresh("multi-step turns")
    const target = local.readEvents(loop.id).find((event) => event.type === "step.started" && event.data.messageId === "a2")!
    local.database.run("DROP TRIGGER event_no_update")
    local.database.run("UPDATE event SET data = replace(data, '\"attempt\":1', '\"attempt\":7') WHERE session_id = ? AND seq = ?", [
      loop.id,
      target.seq,
    ])
    const result = exportSession(local, loop.id)
    expect(result.calls[0]!.unverified).toBeNull()
    for (const call of result.calls.slice(1)) {
      expect(call.unverified?.reason).toBe("fold_failed")
      expect(call.unverified?.message).toContain(`event seq ${target.seq}`)
      expect(call.record!.fidelity).toBe("usage-only")
    }
    local.close()
  })

  test("a compaction call is usage-only, not a mismatch, when the compaction prompt is not given", () => {
    const { local, loop } = fresh("compaction")
    const result = exportSession(local, loop.id)
    expect(result.unverified.map((entry) => entry.reason)).toEqual(["compaction_prompt_unknown"])
    const compaction = result.calls.find((call) => call.row.purpose === "compaction")!
    expect(compaction.record).toMatchObject({ fidelity: "usage-only", hints: [{ kind: "compaction_call" }] })
    local.close()
  })

  test("a ledger written with other call options is reported, not exported as full-request", () => {
    const { local, loop } = fresh("steer during a step")
    const result = exportSession(local, loop.id, { callOptions: { textVerbosity: "low" } })
    expect(result.unverified.length).toBe(result.calls.length)
    expect(result.unverified.every((entry) => entry.reason === "hash_mismatch" && entry.block?.number === 1)).toBe(true)
    local.close()
  })
})

describe("hints", () => {
  test("a compaction marks the compaction call and the call after it", () => {
    const hints = session("compaction").result.records.map((entry) => entry.hints ?? [])
    expect(hints[2]).toEqual([{ kind: "compaction_call" }])
    expect(hints[3]).toEqual([{ kind: "compaction", detail: "compaction c1" }])
    expect(hints[0]).toEqual([])
    expect(hints[1]).toEqual([])
  })

  test("a model change is a model switch; an effort change is only in the extension field", () => {
    const records = session("settings changes").result.records
    expect(records[1]!.hints).toEqual([{ kind: "model_switch", detail: "gpt-test → gpt-other" }])
    expect(records[2]!.hints).toBeUndefined()
    expect(records[2]!.x_light_harness!.prefix_break).toEqual({ causes: ["settings"], events: [{ type: "settings.changed", seq: expect.any(Number) }] })
  })

  test("a revert and a refusal are marked in the extension field", () => {
    expect(session("revert").result.records[2]!.x_light_harness!.prefix_break!.causes).toEqual(["revert"])
    expect(session("refusal").result.records[3]!.x_light_harness!.prefix_break!.causes).toEqual(["refusal"])
  })
})

describe("serialization", () => {
  test("each block's content is written once, and the unchanged prefix is reused", () => {
    const { trace, result } = session("multi-step turns")
    const lines = trace.trim().split("\n").map((line) => JSON.parse(line))
    expect(lines[0].request.reuse).toBeUndefined()
    for (const [index, line] of lines.entries())
      if (index > 0) expect(line.request.reuse).toBe(result.records[index - 1]!.request!.blocks.length)
    const full = serializeTrace(result.records, { compact: false })
    expect(trace.length).toBeLessThan(full.length)
    expect(validateTrace(full).errors.filter((error) => !error.includes("repeats content"))).toEqual([])
  })

  test("a redacted trace keeps every hash and no content", () => {
    const { result } = session("parallel tool calls with media")
    const redacted = serializeTrace(result.records, { redact: true })
    expect(redacted).not.toContain("PNG")
    expect(redacted).not.toContain("display: flex")
    const validation = validateTrace(redacted)
    expect(validation.errors).toEqual([])
    validation.records.forEach((entry, index) =>
      expect(entry.blocks!.map((block) => block.hash)).toEqual(result.records[index]!.request!.blocks.map((block) => block.hash)),
    )
  })
})

