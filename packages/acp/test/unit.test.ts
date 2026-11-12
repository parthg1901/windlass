import { expect, test } from "bun:test"
import { type EngineEvent, brand } from "@windlass/core"
import * as schemas from "../node_modules/@agentclientprotocol/sdk/dist/v1/schema/zod.gen.js"
import { lastWords } from "../src/client.ts"
import { META } from "../src/extensions.ts"
import { silentLogger } from "../src/log.ts"
import { fenced, promptText } from "../src/prompt.ts"
import { parseHunks, toolTitle } from "../src/tools.ts"
import { type Output, Translator } from "../src/translate.ts"

const M = "msg_1"
let seq = 0
function durable(type: string, data: Record<string, unknown>): EngineEvent {
  seq += 1
  return { type, v: 1, data, sessionId: "ses_1", seq, time: 1_700_000_000_000 } as unknown as EngineEvent
}

function translator(options: { notices?: boolean } = {}) {
  return new Translator({
    sessionId: "ses_1",
    cwd: "/work",
    log: silentLogger,
    notices: options.notices ?? false,
    compaction: false,
    contextWindow: () => null,
    echo: () => false,
  })
}

function updates(outputs: Output[]) {
  return outputs.flatMap((output) => (output.type === "update" ? [output.update] : []))
}

test("outcomes ACP has no status for are failed, say so in the title and the content, and carry the outcome", () => {
  const t = translator()
  t.translate(durable("tool.called", { messageId: M, callId: "c1", name: "shell", input: '{"command":"make deploy"}', providerData: null }))
  t.translate(durable("tool.called", { messageId: M, callId: "c2", name: "read", input: '{"path":"a.ts"}', providerData: null }))
  t.translate(durable("tool.started", { messageId: M, callId: "c1", effect: "exec" }))
  const unknown = updates(
    t.translate(
      durable("tool.settled", {
        messageId: M,
        callId: "c1",
        outcome: "effect_unknown",
        output: "Started, but stopped before it reported a result. It may or may not have taken effect: check the current state before repeating it.",
        truncation: null,
        attachments: [],
        display: null,
      }),
    ),
  )[0] as Record<string, unknown>
  expect(unknown.status).toBe("failed")
  expect(unknown.title).toBe("`make deploy` (outcome unknown)")
  expect((unknown._meta as Record<string, unknown>)[META.outcome]).toBe("effect_unknown")
  expect(JSON.stringify(unknown.content)).toContain("Outcome unknown. Started, but stopped")
  const notStarted = updates(
    t.translate(
      durable("tool.settled", {
        messageId: M,
        callId: "c2",
        outcome: "not_started",
        output: "Not run: the response was stopped before this call started. It is safe to call it again.",
        truncation: null,
        attachments: [],
        display: null,
      }),
    ),
  )[0] as Record<string, unknown>
  expect(notStarted.title).toBe("Read a.ts (not started)")
  expect(JSON.stringify(notStarted.content)).toContain("Not started. Not run:")
  for (const update of [unknown, notStarted]) schemas.zSessionUpdate.parse(update)
})

test("stop reasons follow how the execution ended", () => {
  const ends = (events: [string, Record<string, unknown>][]) => {
    const t = translator()
    return events.flatMap(([type, data]) => t.translate(durable(type, data))).flatMap((output) => {
      if (output.type !== "end") return []
      const { turn: _, ...end } = output.end
      return [end]
    })
  }
  const start: [string, Record<string, unknown>] = ["execution.started", { executionId: "exe_1" }]
  expect(ends([start, ["step.ended", { messageId: M, finish: "length", usage: null }], ["execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" } }]])).toEqual([
    { kind: "stop", stopReason: "max_tokens" },
  ])
  expect(ends([start, ["step.refused", { messageId: M, message: "No.", excludeFromSeq: 1, usage: null }], ["execution.failed", { executionId: "exe_1", message: "The provider refused the request." }]])).toEqual([
    { kind: "stop", stopReason: "refusal" },
  ])
  expect(ends([start, ["execution.failed", { executionId: "exe_1", message: "The step limit was reached and the model kept asking for tools." }]])).toEqual([
    { kind: "failed", message: "The step limit was reached and the model kept asking for tools.", providerError: null },
  ])
  expect(ends([start, ["execution.interrupted", { executionId: "exe_1", reason: "user" }]])).toEqual([{ kind: "stop", stopReason: "cancelled" }])
})

test("a retry after streamed text starts a new ACP message instead of appending to the abandoned one", () => {
  const t = translator({ notices: true })
  const first = updates(t.translate({ type: "text.delta", sessionId: "ses_1", messageId: M, text: "Hel" } as EngineEvent))
  const notice = updates(
    t.translate(
      durable("retry.scheduled", {
        messageId: M,
        attempt: 2,
        delayMs: 1500,
        error: { kind: "transport", retryable: true, message: "connection reset", status: null, code: null, retryAfterMs: null, requestId: null, reason: "connection" },
      }),
    ),
  )
  t.translate(durable("step.started", { messageId: M, attempt: 2, model: "m" }))
  const second = updates(t.translate({ type: "text.delta", sessionId: "ses_1", messageId: M, text: "Hello" } as EngineEvent))
  const ended = updates(t.translate(durable("text.ended", { messageId: M, text: "Hello world", providerData: null })))
  expect(first[0]).toMatchObject({ messageId: `${M}:t0` })
  expect(notice[0]).toMatchObject({ sessionUpdate: "notice", severity: "warning", title: "The model call failed; retrying in 2 seconds (attempt 2)" })
  expect(second[0]).toMatchObject({ messageId: `${M}:t1`, content: { text: "Hello" } })
  expect(ended).toEqual([{ sessionUpdate: "agent_message_chunk", messageId: `${M}:t1`, content: { type: "text", text: " world" } }])
})

test("unknown event types are ignored", () => {
  expect(translator().translate(durable("something.new", { x: 1 }))).toEqual([])
})

test("prompt text is deterministic", () => {
  const blocks = [
    { type: "text" as const, text: "Look:" },
    { type: "resource_link" as const, uri: "file:///w/src/a.ts", name: "a.ts" },
    { type: "resource_link" as const, uri: "https://example.com/spec", name: "The spec" },
    { type: "resource" as const, resource: { uri: "file:///w/b.md", text: "has ``` inside" } },
  ]
  const expected = "Look:\n\n[file: /w/src/a.ts]\n\n[link: https://example.com/spec] (The spec)\n\n[file: /w/b.md]\n````\nhas ``` inside\n````"
  expect(promptText(blocks)).toEqual({ ok: true, text: expected })
  expect(promptText(blocks)).toEqual(promptText(blocks))
  expect(promptText([])).toMatchObject({ ok: false })
  expect(promptText([{ type: "resource", resource: { uri: "file:///x.png", blob: "AAAA" } }])).toMatchObject({ ok: false })
  expect(fenced("a")).toBe("```\na\n```")
})

test("diff hunks become old and new text with the first changed line", () => {
  const diff = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", "@@ -10,2 +10,3 @@", " ten", "+ten and a half", " eleven"].join("\n")
  expect(parseHunks(diff)).toEqual([
    { oldText: "one\ntwo\nthree", newText: "one\nTWO\nthree", firstChangedLine: 2 },
    { oldText: "ten\neleven", newText: "ten\nten and a half\neleven", firstChangedLine: 11 },
  ])
})

test("titles name the action and its most useful argument", () => {
  expect(toolTitle("edit", null)).toBe("Edit")
  expect(toolTitle("grep", { pattern: "TODO", path: "src", glob: "*.ts" })).toBe('Search "TODO" in src (*.ts)')
  expect(toolTitle("shell", { command: "bun test\n--watch" })).toBe("`bun test …`")
  expect(toolTitle("mystery", { what: "thing" })).toBe("mystery thing")
})

test("a dead server's last words: its own error line, else the message of an uncaught error, never the runtime's banner", () => {
  expect(lastWords([`${brand.binary} acp info: starting`, `${brand.binary} acp error: the data directory is not writable`])).toBe("the data directory is not writable")
  const dump = ["1 | throw new Error('boom')", "          ^", "error: boom", "      at /x/[eval]:1:11", "", "Bun v1.4.0 (Linux arm64)"]
  expect(lastWords(dump)).toBe("boom")
  expect(lastWords(["TypeError: undefined is not a function", "    at main (a.ts:3:1)", "Bun v1.4.0 (Linux arm64)"])).toBe("TypeError: undefined is not a function")
  expect(lastWords(["something odd happened", "Bun v1.4.0 (Linux arm64)"])).toBe("something odd happened")
  expect(lastWords(["Bun v1.4.0 (Linux arm64)"])).toBeNull()
  expect(lastWords([])).toBeNull()
})
