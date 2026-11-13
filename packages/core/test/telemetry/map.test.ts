/**
 * A session as OpenTelemetry spans, on sessions the real loop wrote with the
 * scripted provider: the span tree, the attributes, the IDs, and what is
 * (not) exported as content. Plus hand-written logs for what the loop's
 * hand-moved clock cannot show (durations) and for event types the mapping
 * does not know.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import type { RequestRecord } from "../../src/store/store.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { boundedText } from "../../src/telemetry/content.ts"
import { type LogEvent, type MapOptions, type SessionInput, mapSession } from "../../src/telemetry/map.ts"
import { NAMESPACE, type Span, attr } from "../../src/telemetry/span.ts"
import { mapSessionTree } from "../../src/telemetry/tree.ts"
import { brand } from "../../src/brand.ts"
import { FakeWorkspace, Harness, type HarnessOptions, converse, removeHarnessDirectories } from "../engine/harness.ts"
import { CHECKS_CONFIG, SUMMARY, measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 40, reasoningTokens: 8 })
const SECRET = "hunter2-very-secret-value"

const sandbox = (): CommandSandbox => ({
  state: { available: true },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
})
const approval = (): ApprovalSetup => ({ sandbox: sandbox(), secrets: [SECRET], home: "/home/user" })

function inputOf(h: Harness, id: string = h.session.id): SessionInput {
  return { sessionId: id, events: h.store.readEvents(id as SessionId), requests: h.store.readRequests(id as SessionId) }
}

/** Runs a session, then hands the harness to `check` before it is disposed. */
async function session(run: (h: Harness) => Promise<void>, check: (h: Harness) => void | Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness(options)
  try {
    await run(h)
    await check(h)
  } finally {
    await h.dispose()
  }
}

const named = (spans: readonly Span[], prefix: string) => spans.filter((span) => span.name.startsWith(prefix))
const parentOf = (spans: readonly Span[], span: Span) => spans.find((other) => other.spanId === span.parentSpanId) ?? null
const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "gen_ai.system_instructions", attr("spawn.command")]
const contentKeys = (spans: readonly Span[]) => spans.flatMap((span) => Object.keys(span.attributes).filter((key) => CONTENT_KEYS.includes(key)))

describe("a plain turn", () => {
  test("one trace: the execution, and under it the model call with the GenAI attributes, the usage and the finish reason", () =>
    session(
      async (h) => {
        h.provider.enqueue([script.text("Four."), U])
        h.create().send("What is two plus two?")
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        expect(result.unknownEvents).toEqual({})
        expect(result.stepsWithoutLedger).toBe(0)
        const [execution, chat, ...rest] = result.spans
        expect(rest).toEqual([])
        expect(execution!.name).toBe(`invoke_agent ${brand.name}`)
        expect(execution!.parentSpanId).toBeNull()
        expect(execution!.kind).toBe("internal")
        expect(execution!.attributes).toMatchObject({
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": brand.name,
          "gen_ai.conversation.id": h.session.id,
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-test",
          "gen_ai.request.reasoning.level": "medium",
          "gen_ai.usage.input_tokens": 1200,
          "gen_ai.usage.output_tokens": 40,
          "gen_ai.usage.cache_read.input_tokens": 1000,
          [attr("execution.outcome")]: "succeeded",
          [attr("verification.status")]: "not_configured",
          [attr("execution.steps")]: 1,
          [attr("execution.model_calls")]: 1,
          [attr("execution.tool_calls")]: 0,
        })
        expect(execution!.status).toEqual({ code: "ok" })
        expect(execution!.open).toBe(false)
        expect(chat!.name).toBe("chat gpt-test")
        expect(chat!.kind).toBe("client")
        expect(chat!.traceId).toBe(execution!.traceId)
        expect(chat!.parentSpanId).toBe(execution!.spanId)
        expect(chat!.attributes).toMatchObject({
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-test",
          "gen_ai.usage.input_tokens": 1200,
          "gen_ai.usage.output_tokens": 40,
          "gen_ai.usage.cache_read.input_tokens": 1000,
          "gen_ai.usage.reasoning.output_tokens": 8,
          "gen_ai.response.finish_reasons": ["stop"],
          [attr("request.purpose")]: "step",
          [attr("request.attempt")]: 1,
          [attr("request.outcome")]: "ok",
          [attr("request.retried")]: false,
        })
        expect(chat!.attributes[attr("request.id")]).toBe(h.store.readRequests(h.session.id)[0]!.id)
        expect(NAMESPACE).toMatch(/^[a-z0-9_]+$/)
      },
    ))

  test("the IDs are derived from the session and the log: the same session exported twice, or from a reopened store, gives the same spans", () =>
    session(
      async (h) => {
        h.provider.enqueue([script.text("One."), U])
        h.create().send("First.")
        await h.settled()
        h.provider.enqueue([script.text("Two."), U])
        h.session.send("Second.")
        await h.settled()
      },
      (h) => {
        const first = mapSession(inputOf(h))
        const second = mapSession(inputOf(h))
        expect(second).toEqual(first)
        // Two turns, two traces; every ID has the OTLP length, none repeats.
        const executions = named(first.spans, "invoke_agent")
        expect(executions).toHaveLength(2)
        expect(new Set(first.spans.map((span) => span.traceId)).size).toBe(2)
        expect(new Set(first.spans.map((span) => span.spanId)).size).toBe(first.spans.length)
        for (const span of first.spans) {
          expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
          expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
        }
        h.kill()
        h.restartForLog()
        expect(mapSession(inputOf(h))).toEqual(first)
      },
    ))

  test("no content by default: no message text, no tool arguments, no tool output anywhere", () =>
    session(
      async (h) => {
        h.tools.on("read", `token=${SECRET}`)
        h.provider.enqueue([script.toolCall("call_1", "read", { path: "secret.txt" }), U], [script.text("The token is hidden."), U])
        h.create().send("Read secret.txt and tell me what is in it.")
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        expect(contentKeys(result.spans)).toEqual([])
        const text = JSON.stringify(result.spans)
        for (const fragment of ["secret.txt", SECRET, "The token is hidden", "tell me what"]) expect(text).not.toContain(fragment)
      },
    ))
})

describe("tools and approval", () => {
  test("a tool span per call, under the execution: its effect, outcome, sandbox, and the question that was asked and how it was answered", () =>
    session(
      async (h) => {
        h.provider.enqueue([script.toolCall("call_1", "write", { path: "/etc/motd", content: "x" }), U], [script.toolCall("call_2", "shell", { command: "bun test" }), U], [script.text("Done."), U])
        h.tools.on("write", "written")
        h.tools.on("shell", "1 pass")
        const live = h.create()
        live.send("Change the motd, then run the tests.")
        const asked = (await h.seen((item) => item.type === "approval.requested")) as StoredEvent<"approval.requested">
        expect(live.answer({ messageId: asked.data.messageId as MessageId, callId: asked.data.callId as CallId }, { choice: "once" })).toBe(true)
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        const [write, shell] = named(result.spans, "execute_tool")
        const execution = named(result.spans, "invoke_agent")[0]!
        expect(parentOf(result.spans, write!)).toBe(execution)
        expect(write!.name).toBe("execute_tool write")
        expect(write!.attributes).toMatchObject({
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "write",
          "gen_ai.tool.call.id": "call_1",
          "gen_ai.tool.type": "function",
          [attr("tool.effect")]: "write",
          [attr("tool.outcome")]: "success",
          [attr("tool.sandboxed")]: false,
          [attr("approval.mode")]: "auto",
          [attr("approval.asked")]: true,
          [attr("approval.choice")]: "once",
          [attr("approval.approved")]: true,
        })
        expect(write!.events.map((event) => event.name)).toEqual(["approval.requested", "approval.answered", "tool.started"])
        expect(write!.status).toEqual({ code: "ok" })
        expect(shell!.attributes).toMatchObject({
          [attr("tool.effect")]: "exec",
          [attr("tool.sandboxed")]: true,
          [attr("sandbox.network")]: false,
          [attr("approval.asked")]: false,
          [attr("tool.outcome")]: "success",
        })
        expect(shell!.attributes[attr("approval.choice")]).toBeUndefined()
        expect(execution.attributes[attr("execution.tool_calls")]).toBe(2)
      },
      { approval: approval(), attended: true },
    ))

  test("a call nobody could approve: denied, and settled as an error", () =>
    session(
      async (h) => {
        h.provider.enqueue([script.toolCall("call_1", "write", { path: "/etc/motd", content: "x" }), U], [script.text("I could not."), U])
        h.tools.on("write", "written")
        h.create().send("Change the motd.")
        await h.settled()
      },
      (h) => {
        const [write] = named(mapSession(inputOf(h)).spans, "execute_tool")
        expect(write!.attributes).toMatchObject({ [attr("approval.approved")]: false, [attr("approval.denied_by")]: "unattended", [attr("tool.outcome")]: "error", "error.type": "error" })
        expect(write!.status.code).toBe("error")
        expect(write!.events.map((event) => event.name)).toEqual(["approval.denied"])
      },
      { approval: approval() },
    ))
})

describe("a retry", () => {
  test("each attempt is a model call span: the failed one with the error, the provider's request ID and the delay; the retry after it", () =>
    session(
      async (h) => {
        h.provider.enqueue([script.fail("provider_internal", { status: 500, requestId: "req_provider_1", message: "upstream broke" })], [script.text("ok"), U])
        h.create().send("Go.")
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        const calls = named(result.spans, "chat")
        expect(calls).toHaveLength(2)
        const [failed, retried] = calls
        expect(failed!.attributes).toMatchObject({
          [attr("request.attempt")]: 1,
          [attr("request.outcome")]: "error",
          [attr("request.retried")]: true,
          [attr("retry.delay_ms")]: h.clock.slept[0]!,
          "error.type": "provider_internal",
          [attr("provider.request_id")]: "req_provider_1",
          [attr("provider.http_status")]: 500,
          [attr("provider.retryable")]: true,
        })
        // What the provider said is text: the span says how the call failed as a class, and the words only with content.
        expect(failed!.status).toEqual({ code: "error" })
        expect(JSON.stringify(result.spans)).not.toContain("upstream broke")
        const withContent = named(mapSession(inputOf(h), { content: true }).spans, "chat")[0]!
        expect(withContent.status).toEqual({ code: "error", message: "upstream broke" })
        expect(retried!.attributes).toMatchObject({ [attr("request.attempt")]: 2, [attr("request.outcome")]: "ok", [attr("request.retried")]: false, "gen_ai.response.finish_reasons": ["stop"] })
        expect(retried!.attributes["error.type"]).toBeUndefined()
        const execution = named(result.spans, "invoke_agent")[0]!
        expect(execution.attributes).toMatchObject({ [attr("execution.retries")]: 1, [attr("execution.steps")]: 1, [attr("execution.model_calls")]: 2 })
      },
    ))

  test("a retry after the failed step had output: the retry runs under a new message, and every ledger row is still one span", () =>
    session(
      async (h) => {
        h.tools.on("read", "1", "1")
        h.provider.enqueue([script.text("Reading."), script.toolCall("call_1", "read", { path: "a.ts" }), script.fail("transport", { message: "connection reset" })], [script.toolCall("call_1", "read", { path: "a.ts" }), U], [script.text("ok"), U])
        h.create().send("Go.")
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        expect(result.stepsWithoutLedger).toBe(0)
        const calls = named(result.spans, "chat")
        expect(calls.map((span) => [span.attributes[attr("request.attempt")], span.attributes[attr("request.outcome")], span.attributes["error.type"] ?? null, span.attributes[attr("request.retried")]])).toEqual([
          [1, "error", "transport", true],
          [2, "ok", null, false],
          [1, "ok", null, false],
        ])
        expect(calls[0]!.attributes[attr("provider.transport_reason")]).toBe("connection")
        // The call of the failed attempt started as its arguments ended, before the failure, and ran to its result; the retry's call is a span of its own.
        expect(named(result.spans, "execute_tool").map((span) => span.attributes[attr("tool.outcome")])).toEqual(["success", "success"])
      },
    ))
})

describe("a compaction", () => {
  test("a compaction span under the execution, with its summary call under it and the sizes before and after", () =>
    session(
      async (h) => {
        h.tools.on("read", "export const big = 1")
        h.provider.enqueue([script.toolCall("call_1", "read", { path: "big.ts" }), script.usage(measured(6000))], [script.text(SUMMARY)], [script.text("Read it."), script.usage(measured(1300))])
        h.create().send("Read big.ts.")
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        const [compaction] = named(result.spans, "compaction")
        expect(compaction).toBeDefined()
        const execution = named(result.spans, "invoke_agent")[0]!
        expect(parentOf(result.spans, compaction!)).toBe(execution)
        expect(compaction!.attributes).toMatchObject({ [attr("compaction.trigger")]: "auto", [attr("compaction.mode")]: "normal", [attr("compaction.source")]: "model" })
        expect(compaction!.attributes[attr("compaction.tokens_before")]).toBeGreaterThan(compaction!.attributes[attr("compaction.tokens_after")] as number)
        const summaryCalls = result.spans.filter((span) => span.attributes[attr("request.purpose")] === "compaction")
        expect(summaryCalls).toHaveLength(1)
        expect(parentOf(result.spans, summaryCalls[0]!)).toBe(compaction!)
        expect(named(result.spans, "chat").filter((span) => span.parentSpanId === execution.spanId)).toHaveLength(2)
      },
      { contextWindow: 10_000 },
    ))
})

describe("a run of checks", () => {
  test("a checks span with the verdict and the failing checks; the execution says what the gate decided", () =>
    session(
      async (h) => {
        h.tools.on("write", (input) => (h.workspace!.files.set(String(input.path), String(input.content)), "written"), (input) => (h.workspace!.files.set(String(input.path), String(input.content)), "written"))
        h.checks.on("test", "failed", "passed")
        h.provider.enqueue([script.toolCall("call_1", "write", { path: "a.ts", content: "2" }), U], [script.text("Changed."), U], [script.toolCall("call_2", "write", { path: "a.ts", content: "3" }), U], [script.text("Fixed."), U])
        h.create().send("Change a.ts.")
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h))
        const runs = named(result.spans, "checks")
        expect(runs.map((span) => [span.attributes[attr("checks.verdict")], span.attributes[attr("checks.failing")], span.status.code])).toEqual([
          ["failed", ["test"], "error"],
          ["passed", [], "ok"],
        ])
        expect(runs[0]!.attributes[attr("checks.names")]).toEqual(["test"])
        expect(named(result.spans, "invoke_agent")[0]!.attributes[attr("verification.status")]).toBe("passed")
      },
      { workspace: new FakeWorkspace({ "a.ts": "1" }), config: CHECKS_CONFIG },
    ))
})

describe("a subagent", () => {
  test("the spawn span under the tool call; the child's execution in the parent's trace under it, linked from it; the child's own calls under that", () =>
    session(
      async (h) => {
        converse(h.provider, {
          "Fix it": [[script.toolCall("call_1", "subagent", { task: "Fix module a" }), U], [script.text("It is fixed."), U]],
          "Fix module a": [[script.text("a.ts is fixed."), U]],
        })
        h.create().send("Fix it.")
        await h.settled()
      },
      (h) => {
        const parentId = h.session.id
        const childId = h.store.readEvents(parentId).find((item) => item.type === "spawn.started")!
        const child = ((childId as StoredEvent<"spawn.started">).data.work as { sessionId: string }).sessionId
        const read = (id: string) => (h.store.getSession(id as SessionId) === null ? null : inputOf(h, id))
        const tree = mapSessionTree(read, parentId)
        expect(tree.sessions).toEqual([parentId, child])
        expect(tree.missing).toEqual([])
        const spawn = tree.spans.find((span) => span.name === "subagent")!
        const tool = parentOf(tree.spans, spawn)!
        expect(tool.name).toBe("execute_tool subagent")
        expect(spawn.attributes).toMatchObject({ [attr("spawn.kind")]: "subagent", [attr("spawn.outcome")]: "completed", "gen_ai.agent.id": child, [attr("spawn.background")]: false })
        const childExecution = tree.spans.find((span) => span.sessionId === child && span.name.startsWith("invoke_agent"))!
        expect(childExecution.traceId).toBe(spawn.traceId)
        expect(childExecution.parentSpanId).toBe(spawn.spanId)
        expect(childExecution.attributes).toMatchObject({ "gen_ai.conversation.id": child, [attr("parent.session_id")]: parentId })
        expect(spawn.links).toEqual([{ traceId: childExecution.traceId, spanId: childExecution.spanId, attributes: { "gen_ai.conversation.id": child } }])
        const childCall = tree.spans.find((span) => span.sessionId === child && span.name.startsWith("chat"))!
        expect(childCall.parentSpanId).toBe(childExecution.spanId)
        // One trace for the whole turn, the child's work included.
        expect(new Set(tree.spans.map((span) => span.traceId)).size).toBe(1)

        // Asked for the child alone, the export reads up its lineage and puts it in the same place.
        const alone = mapSessionTree(read, child)
        expect(alone.sessions).toEqual([child])
        expect(alone.spans).toEqual(tree.spans.filter((span) => span.sessionId === child))
        // Without its parent's log, the child's turns are traces of their own that name the parent.
        const orphaned = mapSessionTree((id) => (id === parentId ? null : read(id)), child)
        const own = orphaned.spans.find((span) => span.name.startsWith("invoke_agent"))!
        expect(own.parentSpanId).toBeNull()
        expect(own.attributes[attr("parent.session_id")]).toBe(parentId)
        // --no-children leaves the child out.
        expect(mapSessionTree(read, parentId, { children: false }).sessions).toEqual([parentId])
      },
      { spawn: {} },
    ))
})

describe("content, when asked for", () => {
  const options = (more: Partial<MapOptions> = {}): MapOptions => ({ content: true, secrets: [SECRET], ...more })

  test("message text, tool arguments and output are exported in the conventions' shapes, with credentials redacted", () =>
    session(
      async (h) => {
        h.tools.on("read", `token=${SECRET}\nkey=sk-abcdefghijklmnopqrstuvwxyz0123`)
        h.provider.enqueue([script.toolCall("call_1", "read", { path: "notes.txt", note: SECRET }), U], [script.text(`It holds ${SECRET}.`), U])
        h.create().send(`Read notes.txt; my password is ${SECRET}.`)
        await h.settled()
      },
      (h) => {
        const result = mapSession(inputOf(h), options())
        const text = JSON.stringify(result.spans)
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123")
        expect(text).toContain("[REDACTED:env]")
        expect(text).toContain("[REDACTED:openai-key]")
        const [tool] = named(result.spans, "execute_tool")
        expect(JSON.parse(tool!.attributes["gen_ai.tool.call.arguments"] as string)).toEqual({ path: "notes.txt", note: "[REDACTED:env]" })
        expect(tool!.attributes["gen_ai.tool.call.result"]).toBe("token=[REDACTED:env]\nkey=[REDACTED:openai-key]")
        const execution = named(result.spans, "invoke_agent")[0]!
        expect(JSON.parse(execution.attributes["gen_ai.input.messages"] as string)).toEqual([{ role: "user", parts: [{ type: "text", content: "Read notes.txt; my password is [REDACTED:env]." }] }])
        const [first, last] = named(result.spans, "chat")
        expect(JSON.parse(first!.attributes["gen_ai.output.messages"] as string)).toEqual([
          { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "read", arguments: '{"path":"notes.txt","note":"[REDACTED:env]"}' }], finish_reason: "tool_calls" },
        ])
        expect(JSON.parse(last!.attributes["gen_ai.output.messages"] as string)).toEqual([{ role: "assistant", parts: [{ type: "text", content: "It holds [REDACTED:env]." }], finish_reason: "stop" }])
      },
    ))

  test("content is bounded: a long output is cut, after redaction, with a marker that says how much is missing", () =>
    session(
      async (h) => {
        h.tools.on("read", `${SECRET}${"x".repeat(500)}`)
        h.provider.enqueue([script.toolCall("call_1", "read", { path: "big.txt" }), U], [script.text("Long."), U])
        h.create().send("Read big.txt.")
        await h.settled()
      },
      (h) => {
        const [tool] = named(mapSession(inputOf(h), options({ maxContentChars: 40 })).spans, "execute_tool")
        const result = tool!.attributes["gen_ai.tool.call.result"] as string
        const redacted = `[REDACTED:env]${"x".repeat(500)}`
        expect(result).toBe(`${redacted.slice(0, 40)}…[truncated ${redacted.length - 40} chars]`)
      },
    ))
})

// ---------------------------------------------------------------- hand-written logs

const S = "ses_handwritten"
let seq = 0
const at = (type: string, time: number, data: Record<string, unknown>): LogEvent => ({ type, seq: ++seq, time, data })
const row = (fields: Partial<Record<keyof RequestRecord, unknown>>): RequestRecord =>
  ({ id: "req_1", sessionId: S, messageId: "msg_1", attempt: 1, purpose: "step", model: "gpt-x", blocks: [], ordinal: 1, startedAt: 1010, finishedAt: 1090, outcome: "ok", usage: null, errorKind: null, ...fields }) as RequestRecord

describe("hand-written logs", () => {
  test("times are the stored ones: the tool's span from its call to its result, with the wait before it started; an open execution ends at the last event", () => {
    seq = 0
    const events = [
      at("session.created", 900, { cwd: "/w", title: null, lineage: null, settings: { model: "gpt-x", reasoningEffort: null } }),
      at("execution.started", 1000, { executionId: "exe_1" }),
      at("step.started", 1010, { messageId: "msg_1", attempt: 1, model: "gpt-x" }),
      at("tool.called", 1100, { messageId: "msg_1", callId: "c1", name: "shell", input: "{}", providerData: null }),
      at("tool.started", 1150, { messageId: "msg_1", callId: "c1", effect: "exec" }),
      at("tool.settled", 1400, { messageId: "msg_1", callId: "c1", outcome: "success", output: "", truncation: null, attachments: [], display: null }),
      at("step.ended", 1500, { messageId: "msg_1", finish: "tool_calls", usage: null }),
      at("execution.succeeded", 1600, { executionId: "exe_1", verification: { status: "not_configured" } }),
      at("execution.started", 2000, { executionId: "exe_2" }),
      at("step.started", 2010, { messageId: "msg_2", attempt: 1, model: "gpt-x" }),
    ]
    const result = mapSession({ sessionId: S, events, requests: [row({}), row({ id: "req_2", messageId: "msg_2", ordinal: 2, startedAt: 2010, finishedAt: null, outcome: null })] })
    const [first, call, tool, second, open] = result.spans
    expect([first!.startMs, first!.endMs, first!.open]).toEqual([1000, 1600, false])
    expect([call!.startMs, call!.endMs]).toEqual([1010, 1090])
    expect([tool!.startMs, tool!.endMs, tool!.attributes[attr("tool.wait_ms")]]).toEqual([1100, 1400, 50])
    // The tool list is not hard-coded: a tool span without the run facts is still a tool span.
    expect(tool!.attributes["gen_ai.tool.name"]).toBe("shell")
    expect([second!.startMs, second!.endMs, second!.open, second!.attributes[attr("span.open")]]).toEqual([2000, 2010, true, true])
    expect([open!.attributes[attr("request.outcome")], open!.open]).toEqual(["in_flight", true])
    expect(result.stepsWithoutLedger).toBe(0)
  })

  test("without content, nothing a failure says in words is exported: a configuration error, a harness failure, a tool's error text, what the user was told", () => {
    seq = 0
    const PATH = "/srv/example-project/settings/config.json"
    const events = [
      at("session.created", 900, { cwd: "/w", title: null, lineage: null, settings: { model: "gpt-x", reasoningEffort: null } }),
      // A configuration error: the sentence names the file and the key.
      at("execution.started", 1000, { executionId: "exe_1" }),
      at("execution.failed", 1010, { executionId: "exe_1", message: `${PATH}: hooks.beforeTool[0].comand: unknown key "comand"` }),
      // A call that was refused and a tool that failed: the reason and the output name the path; then the harness itself fails.
      at("execution.started", 2000, { executionId: "exe_2" }),
      at("step.started", 2010, { messageId: "msg_1", attempt: 1, model: "gpt-x" }),
      at("tool.called", 2100, { messageId: "msg_1", callId: "c1", name: "write", input: JSON.stringify({ path: PATH, content: "EXAMPLE_VALUE_123" }), providerData: null }),
      at("approval.denied", 2110, { messageId: "msg_1", callId: "c1", reason: "unattended", mode: "auto", stop: true, sentence: `Nobody is here to approve writing ${PATH}.` }),
      at("hook.ran", 2120, { point: "beforeTool", messageId: "msg_1", callId: "c1", name: "guard", detail: `it could not read ${PATH}`, forUser: `cat: ${PATH}: No such file`, toModel: null }),
      at("tool.settled", 2130, { messageId: "msg_1", callId: "c1", outcome: "error", output: `Not run: writing ${PATH} needs approval.`, truncation: null, attachments: [], display: null }),
      at("taint.noticed", 2140, { source: { kind: "file", path: PATH }, text: `The session read ${PATH}.` }),
      at("snapshot.unavailable", 2150, { reason: "error", message: `git could not write ${PATH}` }),
      at("step.failed", 2200, { messageId: "msg_1", error: { kind: "internal", message: `EACCES: permission denied, open '${PATH}'` }, usage: null }),
      at("execution.failed", 2300, { executionId: "exe_2", message: `This run ended: it needs the user's approval for writing ${PATH}.`, cause: "approval" }),
      // A provider error: what the provider said may quote the request.
      at("execution.started", 3000, { executionId: "exe_3" }),
      at("step.started", 3010, { messageId: "msg_2", attempt: 1, model: "gpt-x" }),
      at("step.failed", 3100, { messageId: "msg_2", error: { kind: "provider", error: { kind: "invalid_request", retryable: false, message: `Invalid input: ${PATH}`, status: 400, code: "invalid_value", retryAfterMs: null, requestId: "req_p" } }, usage: null }),
      at("execution.failed", 3200, { executionId: "exe_3", message: `The provider refused the request: Invalid input: ${PATH}` }),
    ]
    const requests = [
      row({ id: "req_1", messageId: "msg_1", ordinal: 1, startedAt: 2010, finishedAt: 2200, outcome: "error", errorKind: "internal" }),
      row({ id: "req_2", messageId: "msg_2", ordinal: 2, startedAt: 3010, finishedAt: 3100, outcome: "error", errorKind: "invalid_request" }),
    ]
    const without = mapSession({ sessionId: S, events, requests })
    const sent = JSON.stringify(without.spans)
    for (const piece of [PATH, "example-project", "config.json", "comand", "EXAMPLE_VALUE_123", "EACCES", "Nobody is here", "Invalid input", "approval for writing"]) expect(sent).not.toContain(piece)
    // No span has a status message, and every failed one still says how it failed, as a class.
    expect(without.spans.filter((span) => span.status.message !== undefined)).toEqual([])
    const kinds = without.spans.filter((span) => span.status.code === "error").map((span) => [span.name.split(" ")[0], span.attributes["error.type"]])
    expect(kinds).toEqual([
      ["invoke_agent", "failed"],
      ["invoke_agent", "approval"],
      ["chat", "internal"],
      ["execute_tool", "error"],
      ["invoke_agent", "failed"],
      ["chat", "invalid_request"],
    ])
    expect(named(without.spans, "chat")[1]!.attributes).toMatchObject({ [attr("provider.http_status")]: 400, [attr("provider.error_code")]: "invalid_value", [attr("provider.request_id")]: "req_p" })
    // With content the sentences are there, redacted and bounded like every other text.
    const withContent = mapSession({ sessionId: S, events, requests }, { content: true, secrets: ["example-project"], maxContentChars: 60 })
    const shown = (message: string) => boundedText(message, ["example-project"], 60)
    expect(withContent.spans.filter((span) => span.status.code === "error").map((span) => span.status.message)).toEqual([
      shown(`${PATH}: hooks.beforeTool[0].comand: unknown key "comand"`),
      shown(`This run ended: it needs the user's approval for writing ${PATH}.`),
      shown(`EACCES: permission denied, open '${PATH}'`),
      // A tool's error text is its result, under its own attribute.
      undefined,
      shown(`The provider refused the request: Invalid input: ${PATH}`),
      "Invalid input: /srv/[REDACTED:env]/settings/config.json",
    ])
    expect(shown(`${PATH}: hooks.beforeTool[0].comand: unknown key "comand"`)).toBe("/srv/[REDACTED:env]/settings/config.json: hooks.beforeTool[0…[truncated 30 chars]")
    expect(named(withContent.spans, "execute_tool")[0]!.attributes["gen_ai.tool.call.result"]).toBe(shown(`Not run: writing ${PATH} needs approval.`))
  })

  test("event types the mapping does not know are counted, never an error, and the rest is mapped as usual", () => {
    seq = 0
    const events = [
      at("session.created", 900, { cwd: "/w", title: null, lineage: null, settings: { model: "gpt-x", reasoningEffort: null } }),
      at("execution.started", 1000, { executionId: "exe_1" }),
      at("future.event", 1001, { anything: [1, 2, 3] }),
      at("future.event", 1002, {}),
      at("another.new_one", 1003, {}),
      at("snapshot.taken", 1004, { id: "t", point: "delivery", messageId: null }),
      at("execution.failed", 1100, { executionId: "exe_1", message: `failed with ${SECRET}` }),
    ]
    const result = mapSession({ sessionId: S, events, requests: [] }, { secrets: [SECRET] })
    expect(result.unknownEvents).toEqual({ "future.event": 2, "another.new_one": 1 })
    expect(result.spans).toHaveLength(1)
    // The failure's sentence is content: without it the span has the class and the code.
    expect(result.spans[0]!.status).toEqual({ code: "error" })
    expect(result.spans[0]!.attributes["error.type"]).toBe("failed")
    expect(mapSession({ sessionId: S, events, requests: [] }, { secrets: [SECRET], content: true }).spans[0]!.status).toEqual({ code: "error", message: "failed with [REDACTED:env]" })
  })
})
