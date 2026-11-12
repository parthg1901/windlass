import { describe, expect, test } from "bun:test"
import { text } from "../../src/content.ts"
import { EventDecodeError, type EventRow, decodeEvent, encodeEventData, isEventType, validateEvent } from "../../src/event/decode.ts"
import { EVENT_TYPES, type EventType, type NewEvent, durableEvents, event } from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { makeProviderError } from "../../src/provider/error.ts"

const messageId = "msg_1" as MessageId
const callId = "call_1" as CallId
const executionId = "exe_1" as ExecutionId
const usage = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningTokens: 1 }

const evidence = {
  run: 1,
  afterSeq: 11,
  changedFiles: ["src/a.ts"],
  checks: [
    {
      name: "test",
      command: "bun test",
      status: "failed" as const,
      exitCode: 1,
      signal: null,
      durationMs: 420,
      files: ["src/a.ts"],
      fingerprint: "f0",
      reusedFromSeq: null,
      outputPath: "/data/spill/check-test-0a.log",
      outputBytes: 120,
      outputLines: 4,
    },
  ],
}

/** One valid example of every durable event type. Adding an event type without adding it here fails to compile. */
const examples: { [T in EventType]: NewEvent<T> } = {
  "session.created": event("session.created", {
    cwd: "/repo",
    title: null,
    lineage: null,
    settings: { model: "gpt-test", reasoningEffort: "high" },
  }),
  "settings.changed": event("settings.changed", { model: "gpt-other", reasoningEffort: null }),
  "session.renamed": event("session.renamed", { title: "Fix the bug" }),
  "session.archived": event("session.archived", {}),
  "session.unarchived": event("session.unarchived", {}),
  "baseline.set": event("baseline.set", {
    instructions: "You are a coding agent.",
    tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
    sources: [{ source: "date", fingerprint: "f".repeat(64) }],
  }),
  "instruction.appended": event("instruction.appended", {
    messageId,
    source: "date",
    text: "Today is Wednesday.",
    fingerprint: "a".repeat(64),
  }),
  "inbox.enqueued": event("inbox.enqueued", { messageId, origin: null, delivery: "steer", content: text("hello") }),
  "inbox.delivery_changed": event("inbox.delivery_changed", { messageId, delivery: "queue" }),
  "inbox.cancelled": event("inbox.cancelled", { messageId }),
  "inbox.delivered": event("inbox.delivered", { messageId }),
  "turn.ended": event("turn.ended", { verification: { status: "not_needed" } }),
  "synthetic.appended": event("synthetic.appended", {
    messageId,
    origin: "interrupt",
    content: [
      { type: "text", text: "The previous response was interrupted." },
      { type: "media", blob: { hash: "ab12", mediaType: "image/png" } },
    ],
  }),
  "execution.started": event("execution.started", { executionId }),
  "execution.resumed": event("execution.resumed", { executionId }),
  "execution.succeeded": event("execution.succeeded", {
    executionId,
    verification: { status: "unresolved", reason: "acknowledged", failing: ["test"], acknowledgement: { checks: ["test"], reason: "The fixture is missing." }, evidence },
  }),
  "execution.failed": event("execution.failed", { executionId, message: "gave up" }),
  "execution.interrupt_requested": event("execution.interrupt_requested", { executionId, reason: "shutdown" }),
  "execution.interrupted": event("execution.interrupted", { executionId, reason: "user" }),
  "step.started": event("step.started", { messageId, attempt: 1, model: "gpt-test" }),
  "step.ended": event("step.ended", { messageId, finish: "tool_calls", usage }),
  "step.failed": event("step.failed", {
    messageId,
    error: { kind: "provider", error: makeProviderError("transport", "connection reset") },
    usage: null,
  }),
  "step.refused": event("step.refused", { messageId, message: "I can't help with that.", excludeFromSeq: 3, usage }),
  "retry.scheduled": event("retry.scheduled", {
    messageId,
    attempt: 2,
    delayMs: 2000,
    error: makeProviderError("rate_limit", "slow down", { status: 429, retryAfterMs: 2000 }),
  }),
  "text.ended": event("text.ended", { messageId, text: "Done.", providerData: { phase: "final_answer" } }),
  "reasoning.ended": event("reasoning.ended", { messageId, text: "", providerData: { encrypted_content: "gAAAA" } }),
  "tool.called": event("tool.called", { messageId, callId, name: "read", input: '{"path":"a.ts"}', providerData: null }),
  "tool.started": event("tool.started", { messageId, callId, effect: "exec" }),
  "tool.settled": event("tool.settled", {
    messageId,
    callId,
    outcome: "success",
    output: "const a = 1",
    truncation: { originalBytes: 90000, originalLines: 3000, spillPath: "/tmp/out.txt" },
    attachments: [{ hash: "cd34", mediaType: "image/png" }],
    display: { exitCode: 0 },
  }),
  "compaction.started": event("compaction.started", { messageId, trigger: "auto", mode: "normal", keepFromSeq: 12, prompt: "Summarise the conversation.", tokensBefore: 180000 }),
  "compaction.repair_requested": event("compaction.repair_requested", { messageId, attempt: 2, answer: "So far", prompt: "That summary does not have the required form." }),
  "compaction.ended": event("compaction.ended", { messageId, summary: "So far: ...", source: "model", detail: null, tokensAfter: 40000, usage: null }),
  "compaction.failed": event("compaction.failed", { messageId, error: { kind: "crashed" } }),
  "snapshot.taken": event("snapshot.taken", { id: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", point: "step_start", messageId }),
  "snapshot.unavailable": event("snapshot.unavailable", { reason: "git_not_found", message: "git was not found on PATH" }),
  "snapshot.coverage": event("snapshot.coverage", {
    skipped: [
      { path: "big.bin", reason: "too_large", bytes: 3_000_000 },
      { path: "secret/", reason: "unreadable", bytes: null },
    ],
    nestedRepositories: ["vendor/lib"],
  }),
  "checks.started": event("checks.started", { run: 1, checks: ["test"] }),
  "checks.finished": event("checks.finished", { run: 1, evidence }),
  "checks.failed": event("checks.failed", { run: 1, error: { kind: "interrupted", reason: "user" } }),
  "revert.started": event("revert.started", { fromSeq: 7, target: "aaa1", before: "bbb2", keep: ["notes.md"] }),
  "history.reverted": event("history.reverted", {
    fromSeq: 7,
    restore: { target: "aaa1", before: "bbb2", after: "aaa1", changed: 2, kept: [{ path: "notes.md", reason: "hand_edited" }], keptOmitted: 0 },
  }),
  "revert.undo_started": event("revert.undo_started", { revertSeq: 20, target: "bbb2", before: "aaa1", keep: [] }),
  "history.restored": event("history.restored", { revertSeq: 20, restore: null }),
  "revert.failed": event("revert.failed", { message: "git refused: a file changed while the restore ran" }),
}

const row = (stored: NewEvent, overrides: Partial<EventRow> = {}): EventRow => ({
  sessionId: "ses_1",
  seq: 5,
  time: 1_700_000_000_000,
  type: stored.type,
  v: stored.v,
  data: encodeEventData(stored),
  ...overrides,
})

describe("durable event schema", () => {
  test("has an example for every event type", () => {
    expect(Object.keys(examples).sort()).toEqual([...EVENT_TYPES].sort())
  })

  test("every event type is at a positive integer version", () => {
    for (const type of EVENT_TYPES) expect(durableEvents[type].v).toBeGreaterThanOrEqual(1)
  })

  test("event() stamps the current version", () => {
    expect(event("inbox.delivered", { messageId })).toEqual({ type: "inbox.delivered", v: 1, data: { messageId } })
  })

  for (const type of EVENT_TYPES)
    test(`${type} survives a round trip through its stored row`, () => {
      const stored = examples[type]
      expect(decodeEvent(row(stored))).toEqual({
        ...stored,
        sessionId: "ses_1" as SessionId,
        seq: 5,
        time: 1_700_000_000_000,
      })
    })

  test("the interrupt reason has no default", () => {
    const data = JSON.stringify({ executionId })
    expect(() => decodeEvent(row(examples["execution.interrupted"], { data }))).toThrow(EventDecodeError)
    const invented = JSON.stringify({ executionId, reason: "unknown" })
    expect(() => decodeEvent(row(examples["execution.interrupted"], { data: invented }))).toThrow(EventDecodeError)
  })

  test("tool.settled accepts exactly the four outcomes", () => {
    const settle = (outcome: string) =>
      validateEvent({ type: "tool.settled", v: 1, data: { ...examples["tool.settled"].data, outcome } })
    for (const outcome of ["success", "error", "not_started", "effect_unknown"]) expect(() => settle(outcome)).not.toThrow()
    for (const outcome of ["cancelled", "interrupted", ""]) expect(() => settle(outcome)).toThrow(EventDecodeError)
  })

  test("stored data is canonical JSON", () => {
    const a = event("session.created", { cwd: "/repo", title: null, lineage: null, settings: { model: "m", reasoningEffort: null } })
    const b = event("session.created", { settings: { reasoningEffort: null, model: "m" }, lineage: null, title: null, cwd: "/repo" })
    expect(encodeEventData(a)).toBe(encodeEventData(b))
    expect(encodeEventData(a)).toBe('{"cwd":"/repo","lineage":null,"settings":{"model":"m","reasoningEffort":null},"title":null}')
  })
})

describe("decodeEvent", () => {
  const stored = examples["text.ended"]

  const reasonOf = (bad: EventRow) => {
    try {
      decodeEvent(bad)
    } catch (error) {
      if (error instanceof EventDecodeError) return error.reason
      throw error
    }
    return "decoded"
  }

  test("rejects an unknown event type", () => {
    expect(reasonOf(row(stored, { type: "text.finished" }))).toBe("unknown_type")
    expect(reasonOf(row(stored, { type: "toString" }))).toBe("unknown_type")
    expect(isEventType("text.ended")).toBe(true)
    expect(isEventType("text.delta")).toBe(false)
  })

  test("rejects a version this build does not know", () => {
    expect(reasonOf(row(stored, { v: 2 }))).toBe("unknown_version")
    expect(reasonOf(row(stored, { v: 0 }))).toBe("unknown_version")
  })

  test("rejects data that is not JSON", () => {
    expect(reasonOf(row(stored, { data: '{"messageId":' }))).toBe("invalid_json")
  })

  test("rejects data of the wrong shape, naming the field", () => {
    const missing = row(stored, { data: JSON.stringify({ messageId, text: "x" }) })
    expect(reasonOf(missing)).toBe("invalid_data")
    expect(() => decodeEvent(missing)).toThrow("data.providerData")
    const extra = row(stored, { data: JSON.stringify({ ...stored.data, partial: true }) })
    expect(() => decodeEvent(extra)).toThrow("data.partial")
    const wrongType = row(stored, { data: JSON.stringify({ ...stored.data, text: 5 }) })
    expect(() => decodeEvent(wrongType)).toThrow("data.text")
  })

  test("rejects an invalid position", () => {
    expect(reasonOf(row(stored, { seq: 0 }))).toBe("invalid_data")
    expect(reasonOf(row(stored, { seq: 1.5 }))).toBe("invalid_data")
    expect(reasonOf(row(stored, { sessionId: "" }))).toBe("invalid_data")
    expect(reasonOf(row(stored, { time: -1 }))).toBe("invalid_data")
  })

  test("rejects an empty identifier inside data", () => {
    const bad = row(stored, { data: JSON.stringify({ ...stored.data, messageId: "" }) })
    expect(() => decodeEvent(bad)).toThrow("data.messageId")
  })

  test("validateEvent returns a value detached from its input", () => {
    const input = { type: "session.renamed", v: 1, data: { title: "a" } }
    const validated = validateEvent(input)
    expect(validated).toEqual(event("session.renamed", { title: "a" }))
    expect(validated.data).not.toBe(input.data as never)
  })
})
