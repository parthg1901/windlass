import { describe, expect, test } from "bun:test"
import { text } from "../../src/content.ts"
import { type NewEvent, type StoredEvent, type ToolOutcome, event } from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { projectionChanges, selectModelHistory } from "../../src/message/history.ts"
import {
  type AssistantMessage,
  type Message,
  type Projection,
  type ToolCallPart,
  baseline,
  inboxItem,
  message,
  sessionState,
} from "../../src/message/message.ts"
import { ReduceError, type ReduceErrorCode, reduce, reduceAll } from "../../src/message/reducer.ts"
import { type ProviderError, makeProviderError } from "../../src/provider/error.ts"
import type { ToolEffect } from "../../src/tool/tool.ts"

const m = (id: string) => id as MessageId
const c = (id: string) => id as CallId
const x = (id: string) => id as ExecutionId
const usage = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: 5 }

/** A session log under test. `seq` is assigned densely and `time` is `seq * 10`. */
class Log {
  state: Projection | null
  readonly events: StoredEvent[] = []

  constructor(
    readonly sessionId = "ses_1" as SessionId,
    parent: Projection | null = null,
  ) {
    this.state = parent
  }

  private position(next: NewEvent): StoredEvent {
    const seq = (this.state?.lastSeq ?? 0) + 1
    return { ...next, sessionId: this.sessionId, seq, time: seq * 10 }
  }

  apply(...events: NewEvent[]): Projection {
    for (const next of events) {
      const stored = this.position(next)
      this.state = reduce(this.state, stored)
      this.events.push(stored)
    }
    return this.state!
  }

  /** Tries an event without keeping it, and returns the reducer's error code. */
  reject(next: NewEvent): ReduceErrorCode | "accepted" {
    try {
      reduce(this.state, this.position(next))
    } catch (error) {
      if (error instanceof ReduceError) return error.code
      throw error
    }
    return "accepted"
  }

  get seq() {
    return this.state!.lastSeq
  }

  message(id: string): Message {
    const found = this.state!.messages.find((candidate) => candidate.id === id)
    if (found === undefined) throw new Error(`no message ${id}`)
    return found
  }

  assistant(id: string): AssistantMessage {
    const found = this.message(id)
    if (found.kind !== "assistant") throw new Error(`${id} is not an assistant message`)
    return found
  }

  call(id: string, callId: string): ToolCallPart {
    const part = this.assistant(id).parts.find((candidate) => candidate.type === "tool_call" && candidate.callId === callId)
    if (part?.type !== "tool_call") throw new Error(`no call ${callId}`)
    return part
  }
}

const created = event("session.created", { cwd: "/repo", title: null, lineage: null })
const baselineSet = event("baseline.set", {
  instructions: "You are a coding agent.",
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  sources: [{ source: "environment", fingerprint: "env-1" }],
})
const enqueue = (id: string, value = "hello", delivery: "steer" | "queue" = "steer", origin: string | null = null) =>
  event("inbox.enqueued", { messageId: m(id), origin, delivery, content: text(value) })
const deliver = (id: string) => event("inbox.delivered", { messageId: m(id) })
const executionStarted = (id = "exe_1") => event("execution.started", { executionId: x(id) })
const executionSucceeded = (id = "exe_1") => event("execution.succeeded", { executionId: x(id) })
const executionResumed = (id = "exe_1") => event("execution.resumed", { executionId: x(id) })
const executionFailed = (id = "exe_1") => event("execution.failed", { executionId: x(id), message: "gave up" })
const interruptRequested = (reason: "user" | "shutdown" = "user", id = "exe_1") =>
  event("execution.interrupt_requested", { executionId: x(id), reason })
const executionInterrupted = (reason: "user" | "shutdown" = "user", id = "exe_1") =>
  event("execution.interrupted", { executionId: x(id), reason })
const stepCrashed = (id: string) => event("step.failed", { messageId: m(id), error: { kind: "crashed" }, usage: null })
const stepStarted = (id: string, attempt = 1) =>
  event("step.started", { messageId: m(id), attempt, model: "gpt-test" })
const stepEnded = (id: string, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage })
const stepInterrupted = (id: string, reason: "user" | "shutdown" = "user") =>
  event("step.failed", { messageId: m(id), error: { kind: "interrupted", reason }, usage: null })
const textEnded = (id: string, value: string) =>
  event("text.ended", { messageId: m(id), text: value, providerData: null })
const reasoningEnded = (id: string, value: string) =>
  event("reasoning.ended", { messageId: m(id), text: value, providerData: { encrypted_content: "gAAAA" } })
const called = (id: string, callId: string, input = "{}") =>
  event("tool.called", { messageId: m(id), callId: c(callId), name: "read", input, providerData: null })
const started = (id: string, callId: string, effect: ToolEffect = "exec") =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect })
const settled = (id: string, callId: string, outcome: ToolOutcome = "success", output = "ok") =>
  event("tool.settled", {
    messageId: m(id),
    callId: c(callId),
    outcome,
    output,
    truncation: null,
    attachments: [],
    display: null,
  })
const synthetic = (id: string, origin = "interrupt", value = "The previous response was interrupted.") =>
  event("synthetic.appended", { messageId: m(id), origin, content: text(value) })
const instruction = (id: string, value = "Today is Thursday.", fingerprint: string | null = "date-thursday") =>
  event("instruction.appended", { messageId: m(id), source: "date", text: value, fingerprint })
const compactionStarted = (id: string) => event("compaction.started", { messageId: m(id), trigger: "auto" })
const compactionEnded = (id: string, keepFromSeq: number) =>
  event("compaction.ended", { messageId: m(id), summary: "Summary so far.", keepFromSeq, usage: null })
const reverted = (fromSeq: number) => event("history.reverted", { fromSeq })

/** A session with a delivered prompt `u1` and a running execution: seq 1..5. */
function running(): Log {
  const log = new Log()
  log.apply(created, enqueue("u1"), executionStarted(), baselineSet, deliver("u1"))
  return log
}

/** `running()` plus an open step `a1` at seq 6. */
function inStep(): Log {
  const log = running()
  log.apply(stepStarted("a1"))
  return log
}

/** A finished two-step turn, idle at the end: seq 1..15. */
function finishedTurn(): Log {
  const log = inStep()
  log.apply(
    reasoningEnded("a1", "thinking"),
    textEnded("a1", "Let me read it."),
    called("a1", "call_1", '{"path":"a.ts"}'),
    started("a1", "call_1"),
    settled("a1", "call_1", "success", "const a = 1"),
    stepEnded("a1", "tool_calls"),
    stepStarted("a2"),
    textEnded("a2", "Done."),
    stepEnded("a2"),
    executionSucceeded(),
  )
  return log
}

const ids = (messages: readonly Message[]) => messages.map((candidate) => candidate.id as string)

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe("session lifecycle", () => {
  test("session.created starts an empty, idle session", () => {
    const log = new Log()
    expect(log.apply(created)).toEqual({
      lastSeq: 1,
      updatedAt: 10,
      session: {
        id: "ses_1" as SessionId,
        cwd: "/repo",
        title: null,
        lineage: null,
        archived: false,
        createdAt: 10,
        execution: null,
        open: null,
        compaction: null,
      },
      baseline: null,
      messages: [],
      inbox: [],
    })
  })

  test("nothing can precede session.created and it cannot repeat", () => {
    const log = new Log()
    expect(log.reject(enqueue("u1"))).toBe("out_of_order")
    log.apply(created)
    expect(log.reject(created)).toBe("out_of_order")
  })

  test("seq must be dense", () => {
    const log = new Log()
    log.apply(created)
    const next = { ...enqueue("u1"), sessionId: log.sessionId, time: 0 }
    expect(() => reduce(log.state, { ...next, seq: 3 })).toThrow(ReduceError)
    expect(() => reduce(log.state, { ...next, seq: 1 })).toThrow(ReduceError)
    expect(() => reduce(null, { ...created, sessionId: log.sessionId, seq: 2, time: 0 })).toThrow(ReduceError)
    expect(reduce(log.state, { ...next, seq: 2 }).lastSeq).toBe(2)
  })

  test("an event of another session is rejected", () => {
    const log = new Log()
    log.apply(created)
    const foreign = { ...enqueue("u1"), sessionId: "ses_2" as SessionId, seq: 2, time: 0 }
    const code = (() => {
      try {
        reduce(log.state, foreign)
      } catch (error) {
        if (error instanceof ReduceError) return error.code
      }
      return "accepted"
    })()
    expect(code).toBe("wrong_session")
  })

  test("rename, archive and unarchive change only the session", () => {
    const log = new Log()
    log.apply(created)
    expect(log.apply(event("session.renamed", { title: "Fix the bug" })).session.title).toBe("Fix the bug")
    expect(log.apply(event("session.archived", {})).session.archived).toBe(true)
    expect(log.apply(event("session.unarchived", {})).session.archived).toBe(false)
    expect(log.state!.updatedAt).toBe(40)
  })
})

describe("inbox", () => {
  test("an enqueued item waits in the inbox and is not a message", () => {
    const log = new Log()
    const state = log.apply(created, enqueue("u1", "first", "queue"), enqueue("s1", "build finished", "steer", "shell"))
    expect(state.messages).toEqual([])
    expect(state.inbox).toEqual([
      { messageId: m("u1"), seq: 2, time: 20, origin: null, delivery: "queue", content: text("first") },
      { messageId: m("s1"), seq: 3, time: 30, origin: "shell", delivery: "steer", content: text("build finished") },
    ])
  })

  test("delivery turns the item into a message at the delivery seq and empties the inbox row", () => {
    const log = new Log()
    log.apply(created, enqueue("u1", "first", "queue"), enqueue("s1", "build finished", "steer", "shell"))
    const state = log.apply(
      executionStarted(),
      baselineSet,
      deliver("s1"),
      stepStarted("a1"),
      stepEnded("a1"),
      deliver("u1"),
    )
    expect(state.inbox).toEqual([])
    expect(state.messages.filter((message) => message.kind !== "assistant")).toEqual([
      {
        kind: "synthetic",
        id: m("s1"),
        seq: 6,
        time: 60,
        excluded: null,
        origin: "shell",
        content: text("build finished"),
        delivery: "steer",
      },
      { kind: "user", id: m("u1"), seq: 9, time: 90, excluded: null, content: text("first"), delivery: "queue" },
    ])
  })

  test("the delivery mode can change while the item waits", () => {
    const log = new Log()
    log.apply(created, enqueue("u1", "first", "queue"))
    const state = log.apply(event("inbox.delivery_changed", { messageId: m("u1"), delivery: "steer" }))
    expect(state.inbox[0]).toMatchObject({ delivery: "steer", seq: 2 })
    log.apply(executionStarted(), deliver("u1"))
    expect(log.message("u1")).toMatchObject({ kind: "user", delivery: "steer" })
    expect(log.reject(event("inbox.delivery_changed", { messageId: m("u1"), delivery: "queue" }))).toBe("not_found")
  })

  test("a cancelled item never becomes a message", () => {
    const log = new Log()
    log.apply(created, enqueue("u1"), enqueue("u2"), event("inbox.cancelled", { messageId: m("u1") }))
    expect(log.state!.inbox.map((item) => item.messageId)).toEqual([m("u2")])
    log.apply(executionStarted())
    expect(log.reject(deliver("u1"))).toBe("not_found")
    expect(log.reject(event("inbox.cancelled", { messageId: m("u1") }))).toBe("not_found")
  })

  test("delivery needs an execution claim", () => {
    const log = new Log()
    log.apply(created, enqueue("u1"))
    expect(log.reject(deliver("u1"))).toBe("invalid_transition")
  })

  test("delivery happens only at a step boundary, but enqueueing is always allowed", () => {
    const log = inStep()
    expect(log.reject(enqueue("u2"))).toBe("accepted")
    log.apply(enqueue("u2"))
    expect(log.reject(deliver("u2"))).toBe("invalid_transition")
    log.apply(stepEnded("a1"))
    expect(log.reject(deliver("u2"))).toBe("accepted")
  })

  test("an id cannot be reused, whether it is waiting or already a message", () => {
    const log = running()
    log.apply(enqueue("u2"))
    expect(log.reject(enqueue("u2"))).toBe("duplicate_id")
    expect(log.reject(enqueue("u1"))).toBe("duplicate_id")
    expect(log.reject(stepStarted("u1"))).toBe("duplicate_id")
    expect(log.reject(stepStarted("u2"))).toBe("duplicate_id")
    expect(log.reject(synthetic("u1"))).toBe("duplicate_id")
  })
})

describe("execution claim", () => {
  test("started takes the claim and succeeded releases it", () => {
    const log = new Log()
    log.apply(created, executionStarted())
    expect(log.state!.session.execution).toEqual({
      id: x("exe_1"),
      status: "running",
      crashResumes: 0,
      startedSeq: 2,
      nextAttempt: 1,
      interrupting: null,
    })
    expect(log.reject(executionStarted("exe_2"))).toBe("invalid_transition")
    expect(log.apply(executionSucceeded()).session.execution).toBeNull()
    expect(log.reject(executionSucceeded())).toBe("not_found")
  })

  test("terminal events must name the claimed execution", () => {
    const log = new Log()
    log.apply(created, executionStarted())
    expect(log.reject(executionSucceeded("exe_other"))).toBe("not_found")
    expect(log.reject(interruptRequested("user", "exe_other"))).toBe("not_found")
    log.apply(interruptRequested("user"))
    expect(log.reject(executionInterrupted("user", "exe_other"))).toBe("not_found")
  })

  test("a user interrupt releases the claim; a shutdown keeps it suspended", () => {
    const user = new Log()
    user.apply(created, executionStarted(), interruptRequested("user"), executionInterrupted("user"))
    expect(user.state!.session.execution).toBeNull()

    const shutdown = new Log()
    shutdown.apply(created, executionStarted(), interruptRequested("shutdown"), executionInterrupted("shutdown"))
    expect(shutdown.state!.session.execution).toMatchObject({ status: "suspended", crashResumes: 0, interrupting: null })
    expect(shutdown.reject(executionStarted("exe_2"))).toBe("invalid_transition")
    expect(shutdown.reject(stepStarted("a1"))).toBe("invalid_transition")
    expect(shutdown.reject(executionSucceeded())).toBe("invalid_transition")
    expect(shutdown.reject(interruptRequested("user"))).toBe("invalid_transition")
  })

  test("only a resume after a crash counts toward the crash-resume cap", () => {
    const log = new Log()
    log.apply(created, executionStarted())
    // A clean shutdown suspends the claim; resuming it is not a crash.
    log.apply(interruptRequested("shutdown"), executionInterrupted("shutdown"), executionResumed())
    expect(log.state!.session.execution).toEqual({
      id: x("exe_1"),
      status: "running",
      crashResumes: 0,
      startedSeq: 2,
      nextAttempt: 1,
      interrupting: null,
    })
    log.apply(interruptRequested("shutdown"), executionInterrupted("shutdown"), executionResumed())
    expect(log.state!.session.execution).toMatchObject({ status: "running", crashResumes: 0 })
    // After a crash the claim is still "running"; recovery resuming it is counted.
    log.apply(executionResumed())
    expect(log.state!.session.execution).toMatchObject({ status: "running", crashResumes: 1 })
    log.apply(executionResumed())
    expect(log.state!.session.execution).toMatchObject({ status: "running", crashResumes: 2 })
  })

  test("a suspended execution can be failed instead of resumed", () => {
    const log = new Log()
    log.apply(created, executionStarted(), interruptRequested("shutdown"), executionInterrupted("shutdown"))
    log.apply(executionFailed())
    expect(log.state!.session.execution).toBeNull()
  })

  test("an execution cannot end while a step is open", () => {
    const log = inStep()
    expect(log.reject(executionSucceeded())).toBe("invalid_transition")
    expect(log.reject(executionInterrupted("user"))).toBe("invalid_transition")
    expect(log.reject(executionResumed())).toBe("invalid_transition")
    log.apply(interruptRequested("user"))
    expect(log.reject(executionInterrupted("user"))).toBe("invalid_transition")
  })
})

describe("steps", () => {
  test("a step needs a claim and a boundary", () => {
    const log = new Log()
    log.apply(created, baselineSet)
    expect(log.reject(stepStarted("a1"))).toBe("invalid_transition")
    log.apply(executionStarted(), stepStarted("a1"))
    expect(log.state!.session.open).toEqual({ kind: "step", messageId: m("a1") })
    expect(log.reject(stepStarted("a2"))).toBe("invalid_transition")
  })

  test("a completed two-step turn projects to the expected messages", () => {
    const log = finishedTurn()
    expect(log.seq).toBe(16)
    expect(log.state!.session).toMatchObject({ execution: null, open: null })
    expect(ids(log.state!.messages)).toEqual(["u1", "a1", "a2"])
    expect(log.assistant("a1")).toEqual({
      kind: "assistant",
      id: m("a1"),
      seq: 6,
      time: 60,
      excluded: null,
      model: "gpt-test",
      attempt: 1,
      status: "completed",
      parts: [
        { type: "reasoning", text: "thinking", providerData: { encrypted_content: "gAAAA" } },
        { type: "text", text: "Let me read it.", providerData: null },
        {
          type: "tool_call",
          callId: c("call_1"),
          name: "read",
          input: '{"path":"a.ts"}',
          providerData: null,
          state: {
            status: "settled",
            outcome: "success",
            output: "const a = 1",
            truncation: null,
            attachments: [],
            display: null,
          },
        },
      ],
      finish: "tool_calls",
      usage,
      error: null,
      refusal: null,
      lastRetry: null,
      endedAt: 120,
    })
    expect(log.assistant("a2")).toMatchObject({ seq: 13, status: "completed", finish: "stop", endedAt: 150 })
  })

  test("a step has exactly one terminal event", () => {
    const log = inStep()
    log.apply(stepEnded("a1"))
    expect(log.reject(stepEnded("a1"))).toBe("invalid_transition")
    expect(log.reject(stepInterrupted("a1"))).toBe("invalid_transition")
    expect(log.reject(textEnded("a1", "late"))).toBe("invalid_transition")
    expect(log.reject(called("a1", "call_9"))).toBe("invalid_transition")
  })

  test("output must belong to the open step", () => {
    const log = inStep()
    expect(log.reject(textEnded("a0", "x"))).toBe("invalid_transition")
    expect(log.reject(textEnded("u1", "x"))).toBe("invalid_transition")
    expect(log.reject(stepEnded("a0"))).toBe("invalid_transition")
  })

  test("a step cannot end while a tool call is unsettled", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), called("a1", "call_2"), started("a1", "call_1"), settled("a1", "call_1"))
    expect(log.reject(stepEnded("a1", "tool_calls"))).toBe("invalid_transition")
    expect(log.reject(stepInterrupted("a1"))).toBe("invalid_transition")
    expect(log.reject(event("step.refused", { messageId: m("a1"), message: "no", excludeFromSeq: 6, usage: null }))).toBe(
      "invalid_transition",
    )
    log.apply(interruptRequested("user"), settled("a1", "call_2", "not_started", "Not started: the step was interrupted."))
    expect(log.reject(stepInterrupted("a1"))).toBe("accepted")
  })

  test("a failed step keeps its output and records the error", () => {
    const log = inStep()
    const error = { kind: "provider", error: makeProviderError("usage_limit", "limit reached") } as const
    log.apply(textEnded("a1", "partial"), event("step.failed", { messageId: m("a1"), error, usage: null }))
    expect(log.assistant("a1")).toMatchObject({
      status: "failed",
      error,
      parts: [{ type: "text", text: "partial" }],
      excluded: null,
      endedAt: 80,
    })
    expect(log.state!.session.open).toBeNull()
  })

  test("messages enter history only at a step boundary", () => {
    const log = inStep()
    expect(log.reject(synthetic("s1"))).toBe("invalid_transition")
    expect(log.reject(instruction("i1"))).toBe("invalid_transition")
    expect(log.reject(compactionStarted("c1"))).toBe("invalid_transition")
    expect(log.reject(baselineSet)).toBe("invalid_transition")
    log.apply(stepEnded("a1"))
    expect(log.reject(synthetic("s1"))).toBe("accepted")
    expect(log.reject(instruction("i1"))).toBe("accepted")
  })
})

describe("tool-call state machine", () => {
  const outcomes: ToolOutcome[] = ["success", "error", "not_started", "effect_unknown"]

  test("a call starts pending, with its input exactly as the model wrote it", () => {
    const log = inStep()
    log.apply(called("a1", "call_1", '{"path": "a.ts", '))
    expect(log.call("a1", "call_1")).toEqual({
      type: "tool_call",
      callId: c("call_1"),
      name: "read",
      input: '{"path": "a.ts", ',
      providerData: null,
      state: { status: "pending" },
    })
  })

  test("a pending call settles only as not_started or error", () => {
    for (const outcome of outcomes) {
      const log = inStep()
      log.apply(called("a1", "call_1"))
      const allowed = outcome === "not_started" || outcome === "error"
      expect(log.reject(settled("a1", "call_1", outcome))).toBe(allowed ? "accepted" : "invalid_transition")
    }
  })

  test("a running call settles only as success, error or effect_unknown", () => {
    for (const effect of ["write", "exec", "network"] as const)
      for (const outcome of outcomes) {
        const log = inStep()
        log.apply(called("a1", "call_1"), started("a1", "call_1", effect))
        expect(log.call("a1", "call_1").state).toEqual({ status: "running", effect })
        const allowed = outcome !== "not_started"
        expect(log.reject(settled("a1", "call_1", outcome))).toBe(allowed ? "accepted" : "invalid_transition")
      }
  })

  test("a running read-only call has no unknown effect: it settles only as success or error", () => {
    for (const outcome of outcomes) {
      const log = inStep()
      log.apply(called("a1", "call_1"), started("a1", "call_1", "read"))
      const allowed = outcome === "success" || outcome === "error"
      expect(log.reject(settled("a1", "call_1", outcome))).toBe(allowed ? "accepted" : "invalid_transition")
    }
  })

  test("the effect class comes from tool.started, not from the tool's name", () => {
    const log = inStep()
    // `called` names the tool "read"; what counts is the class the start recorded.
    log.apply(called("a1", "call_1"), started("a1", "call_1", "network"))
    expect(log.reject(settled("a1", "call_1", "effect_unknown"))).toBe("accepted")
  })

  test("a call settles exactly once and cannot restart", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), started("a1", "call_1"))
    expect(log.reject(started("a1", "call_1"))).toBe("invalid_transition")
    log.apply(settled("a1", "call_1", "effect_unknown", "The command was started; its outcome is unknown."))
    expect(log.call("a1", "call_1").state).toMatchObject({
      status: "settled",
      outcome: "effect_unknown",
      output: "The command was started; its outcome is unknown.",
    })
    for (const outcome of outcomes) expect(log.reject(settled("a1", "call_1", outcome))).toBe("invalid_transition")
    expect(log.reject(started("a1", "call_1"))).toBe("invalid_transition")
  })

  test("the settled output is stored exactly as given", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), started("a1", "call_1"))
    const truncation = { originalBytes: 90_000, originalLines: 3_000, spillPath: "/tmp/spill.txt" }
    log.apply(
      event("tool.settled", {
        messageId: m("a1"),
        callId: c("call_1"),
        outcome: "success",
        output: "head\n[... 2990 lines omitted ...]\ntail\n",
        truncation,
        attachments: [{ hash: "ab12", mediaType: "image/png" }],
        display: { exitCode: 0 },
      }),
    )
    expect(log.call("a1", "call_1").state).toEqual({
      status: "settled",
      outcome: "success",
      output: "head\n[... 2990 lines omitted ...]\ntail\n",
      truncation,
      attachments: [{ hash: "ab12", mediaType: "image/png" }],
      display: { exitCode: 0 },
    })
  })

  test("unknown calls are rejected", () => {
    const log = inStep()
    expect(log.reject(started("a1", "call_1"))).toBe("not_found")
    expect(log.reject(settled("a1", "call_1", "error"))).toBe("not_found")
  })

  test("a call id cannot repeat inside one assistant message", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"))
    expect(log.reject(called("a1", "call_1"))).toBe("duplicate_id")
  })

  test("the same provider call id in a later step is a different call", () => {
    const log = inStep()
    log.apply(
      called("a1", "call_1", '{"path":"a.ts"}'),
      started("a1", "call_1"),
      settled("a1", "call_1", "success", "first result"),
      stepEnded("a1", "tool_calls"),
      stepStarted("a2"),
      called("a2", "call_1", '{"path":"b.ts"}'),
    )
    expect(log.call("a2", "call_1").state).toEqual({ status: "pending" })
    expect(log.call("a1", "call_1").state).toMatchObject({ status: "settled", output: "first result" })
    log.apply(started("a2", "call_1"), settled("a2", "call_1", "error", "second result"))
    expect(log.call("a1", "call_1").state).toMatchObject({ outcome: "success", output: "first result" })
    expect(log.call("a2", "call_1").state).toMatchObject({ outcome: "error", output: "second result" })
    // The earlier step is closed, so its call can no longer be touched through the shared id.
    expect(log.reject(settled("a1", "call_1", "error"))).toBe("invalid_transition")
  })

  test("parallel calls settle independently and in any order", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), called("a1", "call_2"), called("a1", "call_3"))
    log.apply(started("a1", "call_2"), started("a1", "call_1"))
    log.apply(settled("a1", "call_1", "success", "one"), settled("a1", "call_3", "not_started", "three"))
    log.apply(settled("a1", "call_2", "error", "two"))
    const states = log.assistant("a1").parts.map((part) => (part.type === "tool_call" ? part.state : null))
    expect(states).toMatchObject([
      { outcome: "success", output: "one" },
      { outcome: "error", output: "two" },
      { outcome: "not_started", output: "three" },
    ])
  })
})

describe("cancel and recovery", () => {
  test("a cancelled step keeps partial text, settles every call and ends once", () => {
    const log = inStep()
    log.apply(
      called("a1", "call_1"),
      called("a1", "call_2"),
      started("a1", "call_1"),
      // The user cancels here: the request is durable, the visible partial text is flushed, calls are settled.
      interruptRequested("user"),
      textEnded("a1", "Running the"),
      settled("a1", "call_1", "error", "Interrupted. Output so far: ..."),
      settled("a1", "call_2", "not_started", "Not started: the step was interrupted."),
      stepInterrupted("a1"),
      synthetic("s1"),
      executionInterrupted("user"),
    )
    expect(log.assistant("a1")).toMatchObject({ status: "failed", error: { kind: "interrupted", reason: "user" } })
    expect(log.state!.session).toMatchObject({ execution: null, open: null })
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["u1", "a1", "s1"])
    expect(log.message("s1")).toMatchObject({ kind: "synthetic", origin: "interrupt", delivery: null })
  })

  test("crash orphans are settled by recovery before the execution resumes", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), called("a1", "call_2"), started("a1", "call_1"))
    // The process dies. At the next start the claim is still running and the step is open.
    expect(log.state!.session).toMatchObject({ execution: { status: "running" }, open: { messageId: m("a1") } })
    expect(log.reject(executionResumed())).toBe("invalid_transition")
    log.apply(
      settled("a1", "call_1", "effect_unknown", "Started before a crash; outcome unknown."),
      settled("a1", "call_2", "not_started", "Not started."),
      stepCrashed("a1"),
    )
    // The model is told before anything else happens.
    expect(log.reject(executionResumed())).toBe("invalid_transition")
    log.apply(synthetic("s1"), executionResumed())
    expect(log.assistant("a1")).toMatchObject({ status: "failed", error: { kind: "crashed" } })
    expect(log.state!.session.execution).toMatchObject({ status: "running", crashResumes: 1 })
    expect(log.reject(stepStarted("a2"))).toBe("accepted")
  })
})

describe("interrupts", () => {
  /** Every event the loop could write at this point that would carry the work on. */
  const work = (open: boolean): NewEvent[] => [
    ...(open
      ? [reasoningEnded("a1", "more"), called("a1", "call_9"), started("a1", "call_1"), stepEnded("a1")]
      : [stepStarted("a2"), compactionStarted("c1"), deliver("u2"), instruction("i1"), synthetic("s9", "check")]),
    event("retry.scheduled", {
      messageId: m("a1"),
      attempt: 2,
      delayMs: 0,
      error: makeProviderError("rate_limit", "slow down"),
    }),
    executionSucceeded(),
    executionFailed(),
    executionResumed(),
    interruptRequested("user"),
    interruptRequested("shutdown"),
  ]

  test("a request is accepted with a step open, between steps and during a compaction, but only under a running claim", () => {
    expect(inStep().reject(interruptRequested("user"))).toBe("accepted")
    expect(running().reject(interruptRequested("shutdown"))).toBe("accepted")
    const compacting = running()
    compacting.apply(compactionStarted("c1"))
    expect(compacting.reject(interruptRequested("user"))).toBe("accepted")
    const idle = finishedTurn()
    expect(idle.reject(interruptRequested("user"))).toBe("invalid_transition")
  })

  test("after a request with a step open, only winding down is accepted", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), enqueue("u2"), interruptRequested("user"))
    expect(log.state!.session.execution).toMatchObject({ status: "running", interrupting: "user" })
    for (const next of work(true)) expect(log.reject(next), next.type).toBe("invalid_transition")
    expect(log.reject(stepInterrupted("a1", "user"))).toBe("invalid_transition") // call_1 is unsettled
    expect(log.reject(textEnded("a1", "partial"))).toBe("accepted")
    expect(log.reject(settled("a1", "call_1", "not_started"))).toBe("accepted")
    log.apply(settled("a1", "call_1", "not_started"))
    expect(log.reject(stepInterrupted("a1", "shutdown"))).toBe("invalid_transition")
    expect(log.reject(stepCrashed("a1"))).toBe("invalid_transition")
    log.apply(stepInterrupted("a1", "user"))
    for (const next of work(false)) expect(log.reject(next), next.type).toBe("invalid_transition")
    expect(log.reject(executionInterrupted("user"))).toBe("invalid_transition") // the marker is owed
    log.apply(synthetic("s1"))
    for (const next of work(false)) expect(log.reject(next), next.type).toBe("invalid_transition")
    expect(log.reject(executionInterrupted("shutdown"))).toBe("invalid_transition")
    log.apply(executionInterrupted("user"))
    expect(log.state!.session.execution).toBeNull()
    expect(log.state!.inbox.map((item) => item.messageId)).toEqual([m("u2")])
  })

  test("the user can still type, rename and withdraw input while the execution winds down", () => {
    const log = inStep()
    log.apply(enqueue("u2"), interruptRequested("user"))
    for (const next of [
      enqueue("u3"),
      event("inbox.delivery_changed", { messageId: m("u2"), delivery: "queue" }),
      event("inbox.cancelled", { messageId: m("u2") }),
      event("session.renamed", { title: "x" }),
      event("session.archived", {}),
    ])
      expect(log.reject(next), next.type).toBe("accepted")
  })

  test("between steps the request is followed by an optional marker and the release", () => {
    const log = inStep()
    log.apply(stepEnded("a1", "tool_calls"), interruptRequested("user"))
    for (const next of work(false)) expect(log.reject(next), next.type).toBe("invalid_transition")
    expect(log.reject(executionInterrupted("user"))).toBe("accepted")
    log.apply(synthetic("s1"), executionInterrupted("user"))
    expect(log.state!.session.execution).toBeNull()
  })

  test("a step or a compaction ends as interrupted only for a requested interrupt, and an execution too", () => {
    const step = inStep()
    expect(step.reject(stepInterrupted("a1", "user"))).toBe("invalid_transition")
    const compaction = running()
    compaction.apply(compactionStarted("c1"))
    const interrupted = (reason: "user" | "shutdown") =>
      event("compaction.failed", { messageId: m("c1"), error: { kind: "interrupted", reason } })
    expect(compaction.reject(interrupted("user"))).toBe("invalid_transition")
    compaction.apply(interruptRequested("shutdown"))
    expect(compaction.reject(interrupted("user"))).toBe("invalid_transition")
    expect(compaction.reject(compactionEnded("c1", 5))).toBe("invalid_transition")
    expect(compaction.reject(event("compaction.failed", { messageId: m("c1"), error: { kind: "crashed" } }))).toBe(
      "invalid_transition",
    )
    compaction.apply(interrupted("shutdown"), executionInterrupted("shutdown"))
    expect(compaction.state!.session.execution).toMatchObject({ status: "suspended" })
    const boundary = running()
    expect(boundary.reject(executionInterrupted("user"))).toBe("invalid_transition")
  })

  test("recovery after a crash during a cancel can only finish the cancel", () => {
    const log = inStep()
    log.apply(called("a1", "call_1"), started("a1", "call_1", "exec"), interruptRequested("user"))
    // The process dies here. The next start sees the request.
    expect(log.reject(executionResumed())).toBe("invalid_transition")
    log.apply(settled("a1", "call_1", "effect_unknown"))
    expect(log.reject(stepCrashed("a1"))).toBe("invalid_transition")
    log.apply(stepInterrupted("a1", "user"), synthetic("s1"))
    expect(log.reject(executionResumed())).toBe("invalid_transition")
    expect(log.reject(executionFailed())).toBe("invalid_transition")
    log.apply(executionInterrupted("user"))
    expect(log.state!.session).toMatchObject({ execution: null, open: null })
  })

  test("a crash during a shutdown is finished as a shutdown and its resume is not counted", () => {
    const log = inStep()
    log.apply(interruptRequested("shutdown"))
    log.apply(stepInterrupted("a1", "shutdown"), synthetic("s1"), executionInterrupted("shutdown"), executionResumed())
    expect(log.state!.session.execution).toMatchObject({ status: "running", crashResumes: 0, interrupting: null })
  })

  test("a cut-short step is followed by the interrupt marker and by nothing else", () => {
    const crashed = inStep()
    crashed.apply(stepCrashed("a1"))
    for (const next of [stepStarted("a2"), executionResumed(), executionFailed(), synthetic("s1", "check"), instruction("i1")])
      expect(crashed.reject(next), next.type).toBe("invalid_transition")
    expect(crashed.reject(enqueue("u2"))).toBe("accepted")
    crashed.apply(synthetic("s1"))
    expect(crashed.reject(stepStarted("a2"))).toBe("accepted")
    expect(crashed.reject(executionFailed())).toBe("accepted")
  })

  test("a step that failed for another reason owes no marker", () => {
    for (const error of [
      { kind: "internal", message: "bug" },
      { kind: "provider", error: makeProviderError("provider_internal", "500") },
    ] as const) {
      const log = inStep()
      log.apply(event("step.failed", { messageId: m("a1"), error, usage: null }))
      expect(log.reject(stepStarted("a2"))).toBe("accepted")
    }
  })

  test("a fork taken between a cut-short step and its marker owes nothing", () => {
    const parent = inStep()
    parent.apply(stepCrashed("a1"))
    const fork = new Log("ses_2" as SessionId, parent.state)
    fork.apply(
      event("session.created", {
        cwd: "/repo",
        title: null,
        lineage: { kind: "fork", parentSessionId: "ses_1" as SessionId, throughSeq: parent.seq },
      }),
      enqueue("u2"),
      executionStarted("exe_2"),
    )
    expect(fork.reject(deliver("u2"))).toBe("accepted")
  })
})

describe("going idle", () => {
  test("an execution succeeds only when nothing waits in the inbox", () => {
    for (const delivery of ["steer", "queue"] as const) {
      const log = inStep()
      log.apply(stepEnded("a1"), enqueue("u2", "more", delivery))
      expect(log.reject(executionSucceeded())).toBe("invalid_transition")
      log.apply(event("inbox.cancelled", { messageId: m("u2") }))
      expect(log.reject(executionSucceeded())).toBe("accepted")
    }
  })

  test("an execution succeeds only after the model answered what it was given", () => {
    const delivered = running()
    expect(delivered.reject(executionSucceeded())).toBe("invalid_transition") // u1 has no answer
    const tools = inStep()
    tools.apply(called("a1", "call_1"), settled("a1", "call_1", "error"), stepEnded("a1", "tool_calls"))
    expect(tools.reject(executionSucceeded())).toBe("invalid_transition") // the model has not seen the result
    const failed = inStep()
    failed.apply(event("step.failed", { messageId: m("a1"), error: { kind: "internal", message: "bug" }, usage: null }))
    expect(failed.reject(executionSucceeded())).toBe("invalid_transition")
    expect(failed.reject(executionFailed())).toBe("accepted")
    const nudged = inStep()
    nudged.apply(stepEnded("a1"), synthetic("s1", "empty_response"))
    expect(nudged.reject(executionSucceeded())).toBe("invalid_transition") // the nudge has no answer
    for (const finish of ["stop", "length"] as const) {
      const answered = inStep()
      answered.apply(textEnded("a1", "Done."), stepEnded("a1", finish))
      expect(answered.reject(executionSucceeded())).toBe("accepted")
    }
  })

  test("an execution that added nothing to answer may succeed", () => {
    const log = new Log()
    log.apply(created, baselineSet, enqueue("u1"), executionStarted(), event("inbox.cancelled", { messageId: m("u1") }))
    expect(log.reject(executionSucceeded())).toBe("accepted")
    // An instruction or a compaction is not something the model has to answer.
    const turn = finishedTurn()
    turn.apply(executionStarted("exe_2"), instruction("i1"), compactionStarted("c1"), compactionEnded("c1", 15))
    expect(turn.reject(executionSucceeded("exe_2"))).toBe("accepted")
  })
})

describe("delivery order", () => {
  test("items of one mode are delivered in the order they were admitted", () => {
    const log = running()
    log.apply(enqueue("u2"), enqueue("u3"), enqueue("u4"))
    expect(log.reject(deliver("u3"))).toBe("invalid_transition")
    log.apply(deliver("u2"))
    expect(log.reject(deliver("u4"))).toBe("invalid_transition")
    log.apply(deliver("u3"), deliver("u4"))
    expect(ids(log.state!.messages)).toEqual(["u1", "u2", "u3", "u4"])
  })

  test("a steer is delivered at any boundary; a queued item only when the session would go idle and no steer waits", () => {
    const log = inStep()
    log.apply(enqueue("q1", "later", "queue"), enqueue("u2", "now", "steer"))
    log.apply(called("a1", "call_1"), settled("a1", "call_1", "error"), stepEnded("a1", "tool_calls"))
    expect(log.reject(deliver("q1"))).toBe("invalid_transition")
    log.apply(deliver("u2"))
    expect(log.reject(deliver("q1"))).toBe("invalid_transition") // u2 is not answered
    log.apply(stepStarted("a2"), stepEnded("a2", "tool_calls"))
    expect(log.reject(deliver("q1"))).toBe("invalid_transition") // the model asked for tools
    log.apply(stepStarted("a3"), textEnded("a3", "Done."), stepEnded("a3"), enqueue("u3", "wait", "steer"))
    expect(log.reject(deliver("q1"))).toBe("invalid_transition") // a steer waits
    log.apply(deliver("u3"), stepStarted("a4"), stepEnded("a4"))
    expect(log.reject(deliver("q1"))).toBe("accepted")
  })

  test("switching an item's mode moves it to the other line at its original place", () => {
    const log = running()
    log.apply(enqueue("q1", "a", "queue"), enqueue("u2", "b", "steer"))
    log.apply(event("inbox.delivery_changed", { messageId: m("q1"), delivery: "steer" }))
    expect(log.reject(deliver("u2"))).toBe("invalid_transition")
    expect(log.reject(deliver("q1"))).toBe("accepted")
  })

  test("a queued prompt admitted while idle is delivered when the next execution starts", () => {
    const log = finishedTurn()
    log.apply(enqueue("q1", "next", "queue"), executionStarted("exe_2"))
    expect(log.reject(deliver("q1"))).toBe("accepted")
  })
})

describe("what a step needs", () => {
  test("no step and no compaction starts before the baseline is set", () => {
    const log = new Log()
    log.apply(created, enqueue("u1"), executionStarted(), deliver("u1"))
    expect(log.reject(stepStarted("a1"))).toBe("invalid_transition")
    expect(log.reject(compactionStarted("c1"))).toBe("invalid_transition")
    log.apply(baselineSet)
    expect(log.reject(stepStarted("a1"))).toBe("accepted")
    expect(log.reject(compactionStarted("c1"))).toBe("accepted")
  })

  test("harness and instruction messages are appended only under a running claim", () => {
    const idle = finishedTurn()
    expect(idle.reject(synthetic("s1"))).toBe("invalid_transition")
    expect(idle.reject(instruction("i1"))).toBe("invalid_transition")
    const suspended = running()
    suspended.apply(interruptRequested("shutdown"), executionInterrupted("shutdown"))
    expect(suspended.reject(synthetic("s1"))).toBe("invalid_transition")
    expect(suspended.reject(instruction("i1"))).toBe("invalid_transition")
    const claimed = running()
    expect(claimed.reject(synthetic("s1", "check"))).toBe("accepted")
    expect(claimed.reject(instruction("i1"))).toBe("accepted")
  })
})

describe("retries", () => {
  const rateLimit = makeProviderError("rate_limit", "slow down", { status: 429, retryAfterMs: 2000 })

  test("before output, the retry continues under the same message", () => {
    const log = inStep()
    log.apply(event("retry.scheduled", { messageId: m("a1"), attempt: 2, delayMs: 2000, error: rateLimit }))
    expect(log.assistant("a1")).toMatchObject({
      status: "running",
      attempt: 2,
      lastRetry: { attempt: 2, delayMs: 2000, error: rateLimit, time: 70 },
    })
    expect(log.state!.session.open).toEqual({ kind: "step", messageId: m("a1") })
    log.apply(textEnded("a1", "ok"), stepEnded("a1"))
    expect(log.assistant("a1")).toMatchObject({ status: "completed", attempt: 2 })
    expect(ids(log.state!.messages)).toEqual(["u1", "a1"])
  })

  test("after output, the message fails and the retry runs under a new one", () => {
    const log = inStep()
    const died = makeProviderError("incomplete_stream", "stream ended early")
    log.apply(
      textEnded("a1", "partial"),
      event("step.failed", { messageId: m("a1"), error: { kind: "provider", error: died }, usage: null }),
      event("retry.scheduled", { messageId: m("a1"), attempt: 2, delayMs: 2000, error: died }),
      stepStarted("a2", 2),
      textEnded("a2", "complete"),
      stepEnded("a2"),
    )
    expect(log.assistant("a1")).toMatchObject({ status: "failed", attempt: 1, lastRetry: { attempt: 2 } })
    expect(log.assistant("a2")).toMatchObject({ status: "completed", attempt: 2, lastRetry: null })
  })

  test("a completed or refused step cannot be retried", () => {
    const completed = inStep()
    completed.apply(stepEnded("a1"))
    const retry = event("retry.scheduled", { messageId: m("a1"), attempt: 2, delayMs: 0, error: rateLimit })
    expect(completed.reject(retry)).toBe("invalid_transition")
    const refused = inStep()
    refused.apply(event("step.refused", { messageId: m("a1"), message: "no", excludeFromSeq: 6, usage: null }))
    expect(refused.reject(retry)).toBe("invalid_transition")
  })

  const retry = (id: string, attempt: number, error: ProviderError = rateLimit) =>
    event("retry.scheduled", { messageId: m(id), attempt, delayMs: 0, error })
  const providerFailed = (id: string, error: ProviderError) =>
    event("step.failed", { messageId: m(id), error: { kind: "provider", error }, usage: null })
  const serverError = makeProviderError("provider_internal", "server error", { status: 500 })

  test("a retry carries the next attempt and names an assistant message", () => {
    const log = inStep()
    expect(log.reject(retry("a1", 3))).toBe("invalid_transition")
    expect(log.reject(retry("a1", 1 + 1))).toBe("accepted")
    log.apply(retry("a1", 2))
    expect(log.reject(retry("a1", 2))).toBe("invalid_transition")
    expect(log.reject(retry("a1", 4))).toBe("invalid_transition")
    expect(log.reject(retry("u1", 2))).toBe("invalid_transition")
    expect(log.reject(retry("zz", 2))).toBe("not_found")
  })

  test("after durable output of any kind the retry cannot stay under the same message", () => {
    for (const output of [textEnded("a1", "partial"), reasoningEnded("a1", "thinking"), called("a1", "call_1")]) {
      const log = inStep()
      log.apply(output)
      expect(log.reject(retry("a1", 2))).toBe("invalid_transition")
    }
  })

  test("only retryable provider errors are retried", () => {
    for (const kind of ["auth", "usage_limit", "content_policy", "invalid_request", "context_overflow"] as const) {
      const error = makeProviderError(kind, "no")
      expect(inStep().reject(retry("a1", 2, error))).toBe("invalid_transition")
      if (kind === "content_policy") continue
      const failed = inStep()
      failed.apply(providerFailed("a1", error))
      // Neither with the step's own error nor dressed up as a retryable one.
      expect(failed.reject(retry("a1", 2, error))).toBe("invalid_transition")
      expect(failed.reject(retry("a1", 2))).toBe("invalid_transition")
    }
    for (const kind of ["rate_limit", "provider_internal", "transport", "incomplete_stream"] as const) {
      const error = makeProviderError(kind, "try again")
      expect(inStep().reject(retry("a1", 2, error))).toBe("accepted")
      const failed = inStep()
      failed.apply(textEnded("a1", "partial"), providerFailed("a1", error))
      expect(failed.reject(retry("a1", 2, error))).toBe("accepted")
    }
  })

  test("a step that crashed or failed inside the harness is not retried", () => {
    for (const error of [{ kind: "crashed" }, { kind: "internal", message: "bug" }] as const) {
      const log = inStep()
      log.apply(event("step.failed", { messageId: m("a1"), error, usage: null }))
      expect(log.reject(retry("a1", 2))).toBe("invalid_transition")
    }
  })

  test("only the step in progress can be retried", () => {
    const log = inStep()
    log.apply(textEnded("a1", "partial"), providerFailed("a1", serverError), retry("a1", 2, serverError))
    // The retry is scheduled once; the new message takes over the budget.
    expect(log.reject(retry("a1", 3, serverError))).toBe("invalid_transition")
    log.apply(stepStarted("a2", 2))
    expect(log.reject(retry("a1", 3, serverError))).toBe("invalid_transition")
    expect(log.reject(retry("a2", 3, serverError))).toBe("accepted")
    log.apply(textEnded("a2", "partial again"), providerFailed("a2", serverError))
    expect(log.reject(retry("a1", 3, serverError))).toBe("invalid_transition")
    log.apply(retry("a2", 3, serverError), stepStarted("a3", 3), stepEnded("a3"))
    expect(log.reject(retry("a2", 4, serverError))).toBe("invalid_transition")
    expect(log.reject(retry("a3", 4, serverError))).toBe("invalid_transition")
  })

  test("a failed step of an earlier execution cannot be retried", () => {
    const log = inStep()
    log.apply(
      textEnded("a1", "partial"),
      providerFailed("a1", serverError),
      event("execution.failed", { executionId: x("exe_1"), message: "gave up" }),
    )
    expect(log.reject(retry("a1", 2, serverError))).toBe("invalid_transition")
    log.apply(enqueue("u2"), executionStarted("exe_2"))
    expect(log.reject(retry("a1", 2, serverError))).toBe("invalid_transition")
  })

  test("a retry cannot be scheduled while a compaction is open", () => {
    const log = inStep()
    log.apply(textEnded("a1", "partial"), providerFailed("a1", serverError), compactionStarted("c1"))
    expect(log.reject(retry("a1", 2, serverError))).toBe("invalid_transition")
  })

  test("the attempt of a new step is the scheduled retry's, and 1 otherwise", () => {
    const log = running()
    expect(log.reject(stepStarted("a1", 2))).toBe("invalid_transition")
    log.apply(stepStarted("a1"), textEnded("a1", "partial"), providerFailed("a1", serverError))
    expect(log.reject(stepStarted("a2", 2))).toBe("invalid_transition")
    log.apply(retry("a1", 2, serverError))
    expect(log.state!.session.execution).toMatchObject({ nextAttempt: 2 })
    expect(log.reject(stepStarted("a2", 1))).toBe("invalid_transition")
    expect(log.reject(stepStarted("a2", 3))).toBe("invalid_transition")
    log.apply(stepStarted("a2", 2))
    expect(log.state!.session.execution).toMatchObject({ nextAttempt: 1 })
    log.apply(stepEnded("a2", "tool_calls"))
    expect(log.reject(stepStarted("a3", 2))).toBe("invalid_transition")
    expect(log.reject(stepStarted("a3", 1))).toBe("accepted")
  })

  test("a scheduled retry survives a crash resume, and ends with the execution", () => {
    const log = inStep()
    log.apply(textEnded("a1", "partial"), providerFailed("a1", serverError), retry("a1", 2, serverError))
    log.apply(event("execution.resumed", { executionId: x("exe_1") }))
    expect(log.reject(stepStarted("a2", 1))).toBe("invalid_transition")
    expect(log.reject(stepStarted("a2", 2))).toBe("accepted")
    log.apply(event("execution.failed", { executionId: x("exe_1") , message: "gave up" }), enqueue("u2"), executionStarted("exe_2"))
    expect(log.reject(stepStarted("a2", 2))).toBe("invalid_transition")
    expect(log.reject(stepStarted("a2", 1))).toBe("accepted")
  })
})

describe("refusal", () => {
  const refused = (id: string, excludeFromSeq: number) =>
    event("step.refused", { messageId: m(id), message: "I can't help with that.", excludeFromSeq, usage: null })

  test("a refused step stays in the log and leaves model history, with the range that led to it", () => {
    const log = finishedTurn()
    log.apply(enqueue("u2", "something disallowed"), executionStarted("exe_2"), deliver("u2"), stepStarted("a3"))
    const deliveredSeq = log.message("u2").seq
    log.apply(textEnded("a3", "I can't"), refused("a3", deliveredSeq))
    expect(log.assistant("a3")).toMatchObject({
      status: "refused",
      refusal: "I can't help with that.",
      excluded: "refused",
      parts: [{ type: "text", text: "I can't" }],
    })
    expect(log.message("u2").excluded).toBe("refused")
    expect(ids(log.state!.messages)).toEqual(["u1", "a1", "a2", "u2", "a3"])
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["u1", "a1", "a2"])
    expect(log.state!.session.open).toBeNull()
  })

  test("the range may cover only the refused message itself", () => {
    const log = inStep()
    log.apply(refused("a1", 6))
    expect(log.message("u1").excluded).toBeNull()
    expect(log.message("a1").excluded).toBe("refused")
  })

  test("the range must include the refused message and stay inside the log", () => {
    const log = inStep()
    expect(log.reject(refused("a1", 7))).toBe("invalid_range")
    expect(log.reject(refused("a1", 1))).toBe("accepted")
  })

  test("a content-policy failure cannot be recorded as an ordinary failure", () => {
    const log = inStep()
    const error = { kind: "provider", error: makeProviderError("content_policy", "refused") } as const
    expect(log.reject(event("step.failed", { messageId: m("a1"), error, usage: null }))).toBe("invalid_transition")
  })
})

describe("baseline and instructions", () => {
  test("the baseline freezes instructions and tools with the seq that set them", () => {
    const log = running()
    expect(log.state!.baseline).toEqual({ seq: 4, ...baselineSet.data })
  })

  test("the baseline records what the model was given per instruction source, each source once", () => {
    const log = new Log()
    log.apply(created)
    const sources = [
      { source: "agents:/repo/AGENTS.md", fingerprint: "f1" },
      { source: "date", fingerprint: "f2" },
    ]
    const twice = event("baseline.set", { instructions: "x", tools: [], sources: [...sources, { source: "date", fingerprint: "f3" }] })
    expect(log.reject(twice)).toBe("duplicate_id")
    expect(log.apply(event("baseline.set", { instructions: "x", tools: [], sources })).baseline!.sources).toEqual(sources)
  })

  test("the baseline cannot change until a compaction has completed", () => {
    const log = finishedTurn()
    const changed = event("baseline.set", { instructions: "New prompt.", tools: [], sources: [] })
    expect(log.reject(changed)).toBe("invalid_transition")
    log.apply(executionStarted("exe_2"), compactionStarted("c1"))
    expect(log.reject(changed)).toBe("invalid_transition")
    log.apply(compactionEnded("c1", 13))
    expect(log.apply(changed).baseline).toEqual({ seq: log.seq, instructions: "New prompt.", tools: [], sources: [] })
    expect(log.reject(changed)).toBe("invalid_transition")
  })

  test("an appended instruction is a message with its text frozen", () => {
    const log = finishedTurn()
    log.apply(executionStarted("exe_2"), instruction("i1", "Today is Thursday."))
    expect(log.message("i1")).toEqual({
      kind: "instruction",
      id: m("i1"),
      seq: 18,
      time: 180,
      excluded: null,
      source: "date",
      text: "Today is Thursday.",
      fingerprint: "date-thursday",
    })
    // A removal notice carries no fingerprint.
    log.apply(instruction("i2", "The date is no longer given.", null))
    expect(log.message("i2")).toMatchObject({ source: "date", fingerprint: null })
    expect(log.state!.baseline).toEqual({ seq: 4, ...baselineSet.data })
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["u1", "a1", "a2", "i1", "i2"])
  })
})

describe("compaction", () => {
  /** finishedTurn (u1@5, a1@6, a2@13), then a completed compaction c1 that keeps from a2. */
  function compacted(): Log {
    const log = finishedTurn()
    log.apply(executionStarted("exe_2"), compactionStarted("c1"), compactionEnded("c1", 13), executionSucceeded("exe_2"))
    return log
  }

  test("a compaction is open like a step until it ends", () => {
    const log = finishedTurn()
    expect(log.reject(compactionStarted("c1"))).toBe("invalid_transition")
    log.apply(executionStarted("exe_2"), compactionStarted("c1"))
    expect(log.state!.session.open).toEqual({ kind: "compaction", messageId: m("c1") })
    expect(log.reject(stepStarted("a3"))).toBe("invalid_transition")
    expect(log.reject(executionSucceeded("exe_2"))).toBe("invalid_transition")
    expect(log.reject(compactionEnded("a2", 13))).toBe("invalid_transition")
  })

  test("model history becomes the checkpoint, then the kept messages, then what follows", () => {
    const log = compacted()
    expect(log.state!.session.compaction).toEqual({ messageId: m("c1"), seq: 18, keepFromSeq: 13 })
    expect(log.message("c1")).toMatchObject({
      kind: "compaction",
      status: "completed",
      summary: "Summary so far.",
      keepFromSeq: 13,
      endedAt: 190,
    })
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["c1", "a2"])
    log.apply(enqueue("u2"), executionStarted("exe_3"), deliver("u2"))
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["c1", "a2", "u2"])
    // Nothing was deleted: the UI still has every message.
    expect(ids(log.state!.messages)).toEqual(["u1", "a1", "a2", "c1", "u2"])
  })

  test("a failed compaction leaves model history unchanged", () => {
    const log = finishedTurn()
    const before = ids(selectModelHistory(log.state!).messages)
    log.apply(
      executionStarted("exe_2"),
      compactionStarted("c1"),
      interruptRequested("user", "exe_2"),
      event("compaction.failed", { messageId: m("c1"), error: { kind: "interrupted", reason: "user" } }),
    )
    expect(log.message("c1")).toMatchObject({ status: "failed", summary: null, keepFromSeq: null })
    expect(log.state!.session).toMatchObject({ compaction: null, open: null })
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(before)
  })

  test("a second compaction replaces the first as the start of history", () => {
    const log = compacted()
    log.apply(enqueue("u2"), executionStarted("exe_3"), deliver("u2"), compactionStarted("c2"))
    const u2 = log.message("u2").seq
    log.apply(compactionEnded("c2", u2))
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["c2", "u2"])
  })

  test("keepFromSeq must lie after the previous compaction and not after this one", () => {
    const log = compacted()
    log.apply(executionStarted("exe_3"), compactionStarted("c2"))
    const own = log.message("c2").seq
    expect(log.reject(compactionEnded("c2", 18))).toBe("invalid_range")
    expect(log.reject(compactionEnded("c2", own + 1))).toBe("invalid_range")
    expect(log.reject(compactionEnded("c2", 19))).toBe("accepted")
    // Keeping nothing: history is the checkpoint alone.
    log.apply(compactionEnded("c2", own))
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["c2"])
  })

  test("excluded messages stay excluded inside the kept range", () => {
    const log = finishedTurn()
    log.apply(reverted(13), executionStarted("exe_2"), compactionStarted("c1"), compactionEnded("c1", 6))
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["c1", "a1"])
  })
})

describe("revert", () => {
  test("marks every message from the given seq and removes them from model history", () => {
    const log = finishedTurn()
    log.apply(reverted(13))
    expect(log.state!.messages.map((candidate) => candidate.excluded)).toEqual([null, null, "reverted"])
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["u1", "a1"])
    expect(ids(log.state!.messages)).toEqual(["u1", "a1", "a2"])
  })

  test("messages written after a revert are visible again", () => {
    const log = finishedTurn()
    log.apply(reverted(5), enqueue("u2"), executionStarted("exe_2"), deliver("u2"))
    expect(ids(selectModelHistory(log.state!).messages)).toEqual(["u2"])
  })

  test("needs an idle session", () => {
    const log = running()
    expect(log.reject(reverted(5))).toBe("invalid_transition")
  })

  test("the range must be inside the log and after the latest compaction", () => {
    const log = finishedTurn()
    expect(log.reject(reverted(log.seq + 1))).toBe("invalid_range")
    log.apply(executionStarted("exe_2"), compactionStarted("c1"), compactionEnded("c1", 13), executionSucceeded("exe_2"))
    expect(log.reject(reverted(13))).toBe("invalid_range")
    expect(log.reject(reverted(18))).toBe("invalid_range")
    expect(log.reject(reverted(19))).toBe("accepted")
  })

  test("a refused message stays refused when it is later reverted", () => {
    const log = inStep()
    log.apply(
      event("step.refused", { messageId: m("a1"), message: "no", excludeFromSeq: 6, usage: null }),
      event("execution.failed", { executionId: x("exe_1"), message: "refused" }),
      reverted(5),
    )
    expect(log.state!.messages.map((candidate) => candidate.excluded)).toEqual(["reverted", "refused"])
  })
})

describe("fork", () => {
  const forkCreated = (throughSeq: number) =>
    event("session.created", {
      cwd: "/repo",
      title: "Fork",
      lineage: { kind: "fork", parentSessionId: "ses_1" as SessionId, throughSeq },
    })

  test("a fork continues the parent's history at the next seq", () => {
    const parent = finishedTurn()
    const atStepBoundary = reduceAll(parent.events.slice(0, 12))!
    const child = new Log("ses_2" as SessionId, atStepBoundary)
    const state = child.apply(forkCreated(12))
    expect(state.lastSeq).toBe(13)
    expect(state.session).toMatchObject({
      id: "ses_2" as SessionId,
      title: "Fork",
      lineage: { kind: "fork", parentSessionId: "ses_1" as SessionId, throughSeq: 12 },
      execution: null,
      open: null,
    })
    expect(ids(state.messages)).toEqual(["u1", "a1"])
    expect(state.baseline).toEqual(atStepBoundary.baseline)
    expect(state.inbox).toEqual([])
    child.apply(enqueue("u2", "another direction"), executionStarted("exe_9"), deliver("u2"))
    expect(ids(selectModelHistory(child.state!).messages)).toEqual(["u1", "a1", "u2"])
    expect(child.message("u2").seq).toBe(16)
    // The parent is untouched.
    expect(ids(parent.state!.messages)).toEqual(["u1", "a1", "a2"])
  })

  test("a fork does not inherit the parent's waiting input or its claim", () => {
    const parent = running()
    parent.apply(enqueue("u2"))
    const child = new Log("ses_2" as SessionId, parent.state)
    const state = child.apply(forkCreated(6))
    expect(state.inbox).toEqual([])
    expect(state.session.execution).toBeNull()
    expect(parent.state!.inbox).toHaveLength(1)
  })

  test("a fork inherits the latest compaction", () => {
    const parent = finishedTurn()
    parent.apply(executionStarted("exe_2"), compactionStarted("c1"), compactionEnded("c1", 13), executionSucceeded("exe_2"))
    const child = new Log("ses_2" as SessionId, parent.state)
    child.apply(forkCreated(parent.seq))
    expect(ids(selectModelHistory(child.state!).messages)).toEqual(["c1", "a2"])
  })

  test("a fork must sit on its parent at exactly throughSeq, at a step boundary", () => {
    const parent = finishedTurn()
    expect(new Log("ses_2" as SessionId, parent.state).reject(forkCreated(3))).toBe("invalid_range")
    expect(new Log("ses_2" as SessionId, null).reject(forkCreated(16))).toBe("invalid_range")
    const other = { ...parent.state!, session: { ...parent.state!.session, id: "ses_x" as SessionId } }
    expect(new Log("ses_2" as SessionId, other).reject(forkCreated(16))).toBe("invalid_range")
    const midStep = reduceAll(parent.events.slice(0, 7))!
    expect(new Log("ses_2" as SessionId, midStep).reject(forkCreated(7))).toBe("invalid_transition")
  })

  test("a fork of a fork folds the same way", () => {
    const parent = finishedTurn()
    const child = new Log("ses_2" as SessionId, parent.state)
    child.apply(forkCreated(16), enqueue("u2"), executionStarted("exe_2"), deliver("u2"), executionFailed("exe_2"))
    const grandchild = new Log("ses_3" as SessionId, child.state)
    grandchild.apply(
      event("session.created", {
        cwd: "/repo",
        title: null,
        lineage: { kind: "fork", parentSessionId: "ses_2" as SessionId, throughSeq: child.seq },
      }),
    )
    expect(ids(grandchild.state!.messages)).toEqual(["u1", "a1", "a2", "u2"])
    expect(grandchild.seq).toBe(child.seq + 1)
  })
})

describe("reducer properties", () => {
  test("it never mutates the state or the event it is given", () => {
    const log = new Log()
    const source = finishedTurn()
    for (const stored of source.events) log.state = reduce(deepFreeze(log.state), deepFreeze(stored))
    expect(log.state).toEqual(source.state)
  })

  test("folding the same log again gives an equal projection", () => {
    const log = finishedTurn()
    log.apply(reverted(13), enqueue("u2"), executionStarted("exe_2"), compactionStarted("c1"), compactionEnded("c1", 6))
    expect(reduceAll(log.events)).toEqual(log.state)
    expect(reduceAll([])).toBeNull()
  })

  test("the projection survives a JSON round trip through its validators", () => {
    const log = finishedTurn()
    log.apply(
      enqueue("u2", "more", "queue"),
      enqueue("s1", "wake", "steer", "timer"),
      executionStarted("exe_2"),
      compactionStarted("c1"),
      compactionEnded("c1", 13),
      stepStarted("a3"),
      called("a3", "call_1"),
      started("a3", "call_1"),
    )
    const stored = JSON.parse(JSON.stringify(log.state)) as Projection
    expect(stored.messages.map((candidate) => message(candidate, "message"))).toEqual([...log.state!.messages])
    expect(stored.inbox.map((item) => inboxItem(item, "inbox"))).toEqual([...log.state!.inbox])
    expect(sessionState(stored.session, "session")).toEqual(log.state!.session)
    expect(baseline(stored.baseline, "baseline")).toEqual(log.state!.baseline!)
  })

  test("untouched parts of the state keep their identity", () => {
    const log = inStep()
    const before = log.state!
    const after = log.apply(textEnded("a1", "hi"))
    expect(after.session).toBe(before.session)
    expect(after.baseline).toBe(before.baseline)
    expect(after.inbox).toBe(before.inbox)
    expect(after.messages[0]).toBe(before.messages[0]!)
    expect(after.messages[1]).not.toBe(before.messages[1]!)
    const enqueued = log.apply(enqueue("u2"))
    expect(enqueued.messages).toBe(after.messages)
    expect(enqueued.session).toBe(after.session)
  })

  test("projectionChanges reports exactly the rows an event touched", () => {
    const log = inStep()
    const before = log.state!
    expect(projectionChanges(before, log.apply(textEnded("a1", "hi")))).toEqual({
      session: null,
      baseline: undefined,
      messages: [log.message("a1")],
      inbox: [],
      inboxRemoved: [],
    })

    const enqueuedFrom = log.state!
    const enqueued = log.apply(enqueue("u2"))
    expect(projectionChanges(enqueuedFrom, enqueued)).toMatchObject({
      session: null,
      messages: [],
      inbox: [{ messageId: m("u2") }],
      inboxRemoved: [],
    })

    const changedFrom = log.state!
    const changed = log.apply(event("inbox.delivery_changed", { messageId: m("u2"), delivery: "queue" }))
    expect(projectionChanges(changedFrom, changed)).toMatchObject({
      inbox: [{ messageId: m("u2"), delivery: "queue" }],
      inboxRemoved: [],
    })

    const endedFrom = log.state!
    const ended = log.apply(stepEnded("a1"))
    const endedChanges = projectionChanges(endedFrom, ended)
    expect(endedChanges.session).toBe(ended.session)
    expect(ids(endedChanges.messages)).toEqual(["a1"])

    const deliveredFrom = log.state!
    const delivered = log.apply(deliver("u2"))
    expect(projectionChanges(deliveredFrom, delivered)).toMatchObject({
      session: null,
      messages: [{ id: m("u2"), kind: "user" }],
      inbox: [],
      inboxRemoved: [m("u2")],
    })

    const idle = log.apply(stepStarted("a2"), stepEnded("a2"), executionSucceeded())
    const revertedState = log.apply(reverted(6))
    const revertChanges = projectionChanges(idle, revertedState)
    expect(ids(revertChanges.messages)).toEqual(["a1", "u2", "a2"])
    expect(revertChanges.session).toBeNull()
  })

  test("projectionChanges from nothing returns everything, and reports a baseline change", () => {
    const log = new Log()
    log.apply(created, enqueue("u1"), executionStarted())
    const before = log.state!
    const after = log.apply(baselineSet)
    expect(projectionChanges(before, after).baseline).toBe(after.baseline)
    expect(projectionChanges(null, after)).toEqual({
      session: after.session,
      baseline: after.baseline,
      messages: after.messages,
      inbox: after.inbox,
      inboxRemoved: [],
    })
  })

  test("applying the reported changes row by row rebuilds the projection", () => {
    // A minimal stand-in for the store's tables, to show the changes are sufficient.
    const source = finishedTurn()
    source.apply(reverted(13), enqueue("u2"), enqueue("u3"), event("inbox.cancelled", { messageId: m("u2") }))
    const rows = { session: null as unknown, baseline: null as unknown, messages: new Map(), inbox: new Map() }
    let previous: Projection | null = null
    for (const stored of source.events) {
      const next = reduce(previous, stored)
      const changes = projectionChanges(previous, next)
      if (changes.session !== null) rows.session = changes.session
      if (changes.baseline !== undefined) rows.baseline = changes.baseline
      for (const changed of changes.messages) rows.messages.set(changed.id, changed)
      for (const item of changes.inbox) rows.inbox.set(item.messageId, item)
      for (const removed of changes.inboxRemoved) rows.inbox.delete(removed)
      previous = next
    }
    const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq
    expect(rows.session).toEqual(source.state!.session)
    expect(rows.baseline).toEqual(source.state!.baseline)
    expect([...rows.messages.values()].sort(bySeq)).toEqual([...source.state!.messages])
    expect([...rows.inbox.values()].sort(bySeq)).toEqual([...source.state!.inbox])
  })
})
