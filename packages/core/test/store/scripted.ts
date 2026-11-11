/**
 * Scripted, synthetic sessions for store tests. Each script drives a real
 * store through `append`, one event at a time unless a batch is the point, so
 * that a crash test can kill the writer between any two appends.
 */
import { createHash } from "node:crypto"
import { type BlobRef, type Content, text } from "../../src/content.ts"
import { type NewEvent, type StoredEvent, type ToolOutcome, event } from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import type { AssistantMessage, Projection } from "../../src/message/message.ts"
import { makeProviderError } from "../../src/provider/error.ts"
import type { BlockHash } from "../../src/request/prefix.ts"
import type { Store } from "../../src/store/store.ts"
import type { ToolEffect } from "../../src/tool/tool.ts"

const m = (id: string) => id as MessageId
const c = (id: string) => id as CallId
const x = (id: string) => id as ExecutionId
export const usage = { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 80, reasoningTokens: 16 }

export const created = (cwd = "/work/demo", title: string | null = null) =>
  event("session.created", { cwd, title, lineage: null })
export const forked = (parent: SessionId, throughSeq: number) =>
  event("session.created", {
    cwd: "/work/demo",
    title: null,
    lineage: { kind: "fork", parentSessionId: parent, throughSeq },
  })
export const baselineSet = (instructions = "You are a coding agent working in /work/demo.") =>
  event("baseline.set", {
    instructions,
    tools: [
      { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "shell", description: "Run a command", inputSchema: { type: "object", properties: { cmd: { type: "string" } } } },
    ],
  })
export const enqueue = (
  id: string,
  value: string | Content,
  delivery: "steer" | "queue" = "steer",
  origin: string | null = null,
) => event("inbox.enqueued", { messageId: m(id), origin, delivery, content: typeof value === "string" ? text(value) : value })
export const deliver = (id: string) => event("inbox.delivered", { messageId: m(id) })
export const changeDelivery = (id: string, delivery: "steer" | "queue") =>
  event("inbox.delivery_changed", { messageId: m(id), delivery })
export const cancel = (id: string) => event("inbox.cancelled", { messageId: m(id) })
export const executionStarted = (id: string) => event("execution.started", { executionId: x(id) })
export const executionResumed = (id: string) => event("execution.resumed", { executionId: x(id) })
export const executionSucceeded = (id: string) => event("execution.succeeded", { executionId: x(id) })
export const executionFailed = (id: string, message: string) =>
  event("execution.failed", { executionId: x(id), message })
export const interruptRequested = (id: string, reason: "user" | "shutdown") =>
  event("execution.interrupt_requested", { executionId: x(id), reason })
export const executionInterrupted = (id: string, reason: "user" | "shutdown") =>
  event("execution.interrupted", { executionId: x(id), reason })
export const stepStarted = (id: string, attempt = 1) =>
  event("step.started", { messageId: m(id), attempt, model: "gpt-test" })
export const stepEnded = (id: string, finish: "stop" | "tool_calls" | "length" = "stop") =>
  event("step.ended", { messageId: m(id), finish, usage })
export const stepFailed = (id: string, error: Extract<NewEvent, { type: "step.failed" }>["data"]["error"]) =>
  event("step.failed", { messageId: m(id), error, usage: null })
export const stepRefused = (id: string, excludeFromSeq: number) =>
  event("step.refused", { messageId: m(id), message: "I can't help with that.", excludeFromSeq, usage })
export const retryScheduled = (id: string, attempt: number) =>
  event("retry.scheduled", {
    messageId: m(id),
    attempt,
    delayMs: 500 * attempt,
    error: makeProviderError("rate_limit", "Too many requests", { status: 429, retryAfterMs: 500 }),
  })
export const textEnded = (id: string, value: string) =>
  event("text.ended", { messageId: m(id), text: value, providerData: { phase: "final_answer" } })
export const reasoningEnded = (id: string, value: string) =>
  event("reasoning.ended", { messageId: m(id), text: value, providerData: { encrypted_content: "gAAAAB-synthetic" } })
export const called = (id: string, callId: string, name: string, input: string) =>
  event("tool.called", { messageId: m(id), callId: c(callId), name, input, providerData: { item_id: `fc_${callId}` } })
export const started = (id: string, callId: string, effect: ToolEffect = "read") =>
  event("tool.started", { messageId: m(id), callId: c(callId), effect })
export const settled = (id: string, callId: string, outcome: ToolOutcome, output: string, attachments: BlobRef[] = []) =>
  event("tool.settled", {
    messageId: m(id),
    callId: c(callId),
    outcome,
    output,
    truncation: null,
    attachments,
    display: null,
  })
export const synthetic = (id: string, origin: string, value: string) =>
  event("synthetic.appended", { messageId: m(id), origin, content: text(value) })
export const instruction = (id: string, source: string, value: string) =>
  event("instruction.appended", { messageId: m(id), source, text: value })
export const compactionStarted = (id: string) => event("compaction.started", { messageId: m(id), trigger: "auto" })
export const compactionEnded = (id: string, keepFromSeq: number) =>
  event("compaction.ended", {
    messageId: m(id),
    summary: "The user asked for a README fix; it was edited and the tests pass.",
    keepFromSeq,
    usage,
  })
export const compactionFailed = (id: string) =>
  event("compaction.failed", {
    messageId: m(id),
    error: { kind: "provider", error: makeProviderError("transport", "connection reset") },
  })
export const reverted = (fromSeq: number) => event("history.reverted", { fromSeq })

/** Drives one session of a store. */
export class Driver {
  constructor(
    readonly store: Store,
    readonly id: SessionId,
  ) {}

  /** Appends each event in its own transaction. */
  add(...events: NewEvent[]): StoredEvent[] {
    return events.flatMap((next) => this.store.append(this.id, [next]))
  }

  /** Appends all events in one transaction. */
  batch(...events: NewEvent[]): readonly StoredEvent[] {
    return this.store.append(this.id, events)
  }

  get projection(): Projection {
    const projection = this.store.getProjection(this.id)
    if (projection === null) throw new Error(`session ${this.id} does not exist`)
    return projection
  }

  get lastSeq() {
    return this.projection.lastSeq
  }

  seqOf(messageId: string): number {
    const found = this.projection.messages.findLast((candidate) => candidate.id === messageId)
    if (found === undefined) throw new Error(`no message ${messageId}`)
    return found.seq
  }

  /** A ledger row around a step, as the step loop writes it: begin before the call, finish after. */
  request(id: string, messageId: string, purpose: "step" | "compaction", outcome: "ok" | "error" | "aborted") {
    const blocks: BlockHash[] = [
      fakeBlock("params", "params"),
      fakeBlock("tool", "read"),
      fakeBlock("tool", "shell"),
      fakeBlock("instructions", "instructions"),
      ...this.projection.messages.map((message) => fakeBlock("input", message.id)),
    ]
    this.store.beginRequest({
      id: `${this.id}_${id}` as RequestId,
      sessionId: this.id,
      messageId: m(messageId),
      attempt: 1,
      purpose,
      model: "gpt-test",
      blocks,
    })
    this.store.finishRequest(`${this.id}_${id}` as RequestId, {
      outcome,
      usage: outcome === "aborted" ? null : usage,
      errorKind: outcome === "error" ? "rate_limit" : null,
    })
  }
}

function fakeBlock(kind: BlockHash["kind"], name: string): BlockHash {
  return { kind, hash: createHash("sha256").update(name).digest("hex"), bytes: name.length * 10 }
}

/** One complete prompt-and-answer turn, from enqueue to execution.succeeded. */
function exchange(d: Driver, n: string, prompt: string, answer: string) {
  d.add(
    enqueue(`u${n}`, prompt),
    executionStarted(`exe_${n}`),
    deliver(`u${n}`),
    stepStarted(`a${n}`),
    textEnded(`a${n}`, answer),
    stepEnded(`a${n}`),
    executionSucceeded(`exe_${n}`),
  )
}

/** A session script: drives sessions whose IDs start with `prefix` and returns the IDs it created. */
export type Script = (store: Store, prefix: string) => SessionId[]

const sid = (prefix: string, name: string) => `${prefix}_${name}` as SessionId

export const SCRIPTS: Record<string, Script> = {
  plain(store, prefix) {
    const d = new Driver(store, sid(prefix, "plain"))
    d.add(created("/work/demo", "Fix the README"), baselineSet())
    exchange(d, "1", "What does this repo do?", "It is a small CLI that prints the weather.")
    // The date changed while the session was idle: it is appended once the next execution holds the claim.
    d.add(
      enqueue("u2", "Thanks. Rename the CLI to `sky`."),
      executionStarted("exe_2"),
      instruction("i1", "date", "Today is Wednesday."),
      deliver("u2"),
      stepStarted("a2"),
      textEnded("a2", "Done: the binary is now called `sky`."),
      stepEnded("a2"),
      executionSucceeded("exe_2"),
    )
    d.add(event("session.renamed", { title: "Rename the CLI" }), event("session.archived", {}))
    d.add(event("session.unarchived", {}))
    return [d.id]
  },

  tools(store, prefix) {
    const d = new Driver(store, sid(prefix, "tools"))
    const image = store.putBlob(new TextEncoder().encode("\x89PNG synthetic screenshot"), "image/png")
    d.add(created(), baselineSet())
    d.add(
      enqueue("u1", [
        { type: "text", text: "Why does this page look broken?" },
        { type: "media", blob: image },
      ]),
      executionStarted("exe_1"),
      deliver("u1"),
      stepStarted("a1"),
      reasoningEnded("a1", "I should read both files."),
      textEnded("a1", "Let me read the two files."),
      // Two calls in parallel, settled in the other order.
      called("a1", "call_1", "read", '{"path":"index.html"}'),
      called("a1", "call_2", "read", '{"path":"style.css"}'),
      started("a1", "call_1"),
      started("a1", "call_2"),
      settled("a1", "call_2", "success", "body { display: flex }"),
      settled("a1", "call_1", "success", "<html>...</html>", [image]),
      stepEnded("a1", "tool_calls"),
    )
    d.request("r1", "a1", "step", "ok")
    // The provider reuses call_1 in the next step.
    d.add(
      stepStarted("a2"),
      called("a2", "call_1", "shell", '{"cmd":"npm test"}'),
      called("a2", "call_3", "shell", '{"cmd":"rm -rf /"}'),
      settled("a2", "call_3", "error", "Refused: this command is not allowed in this mode."),
      started("a2", "call_1", "exec"),
      settled("a2", "call_1", "error", "1 test failed"),
      stepEnded("a2", "tool_calls"),
    )
    d.request("r2", "a2", "step", "ok")
    d.add(stepStarted("a3"), textEnded("a3", "The flex rule hides the header."), stepEnded("a3"))
    d.request("r3", "a3", "step", "ok")
    d.add(executionSucceeded("exe_1"))
    return [d.id]
  },

  interrupted(store, prefix) {
    const d = new Driver(store, sid(prefix, "interrupted"))
    d.add(created(), baselineSet())
    d.add(
      enqueue("u1", "Run the full test suite."),
      executionStarted("exe_1"),
      deliver("u1"),
      stepStarted("a1"),
      textEnded("a1", "Running the tests now"),
      called("a1", "call_1", "shell", '{"cmd":"bun test"}'),
      called("a1", "call_2", "read", '{"path":"package.json"}'),
      started("a1", "call_1", "exec"),
    )
    d.request("r1", "a1", "step", "aborted")
    // The user pressed stop: the cancel is durable first, then the running call reports what it saw, the
    // pending one never began, the step closes and the model is told.
    d.add(
      interruptRequested("exe_1", "user"),
      settled("a1", "call_1", "error", "Interrupted by the user after 3s. Output so far: 12 pass"),
      settled("a1", "call_2", "not_started", "Not run: the step was interrupted before this call started."),
      stepFailed("a1", { kind: "interrupted", reason: "user" }),
      synthetic("s1", "interrupt", "The previous response was interrupted by the user."),
      executionInterrupted("exe_1", "user"),
    )
    d.add(
      enqueue("u2", "Only run the unit tests."),
      executionStarted("exe_2"),
      deliver("u2"),
      stepStarted("a2"),
      textEnded("a2", "Running the unit tests"),
    )
    // Shutdown mid-turn keeps the claim; the next start resumes it.
    d.add(
      interruptRequested("exe_2", "shutdown"),
      stepFailed("a2", { kind: "interrupted", reason: "shutdown" }),
      synthetic("s2", "interrupt", "The previous response was cut short when the harness restarted."),
      executionInterrupted("exe_2", "shutdown"),
      executionResumed("exe_2"),
      stepStarted("a3"),
      textEnded("a3", "Unit tests pass."),
      stepEnded("a3"),
      executionSucceeded("exe_2"),
    )
    return [d.id]
  },

  retried(store, prefix) {
    const d = new Driver(store, sid(prefix, "retried"))
    d.add(created(), baselineSet())
    // A retry before any output keeps the same message.
    d.add(enqueue("u1", "Summarise CHANGELOG.md"), executionStarted("exe_1"), deliver("u1"), stepStarted("a1"))
    d.request("r1", "a1", "step", "error")
    d.add(retryScheduled("a1", 2))
    d.request("r2", "a1", "step", "ok")
    d.add(textEnded("a1", "Three releases, mostly fixes."), stepEnded("a1"), executionSucceeded("exe_1"))
    // A failure after output ends the message; the retry runs under a new one.
    d.add(
      enqueue("u2", "And the breaking changes?"),
      executionStarted("exe_2"),
      deliver("u2"),
      stepStarted("a2"),
      textEnded("a2", "The breaking chan"),
      stepFailed("a2", { kind: "provider", error: makeProviderError("provider_internal", "upstream 502", { status: 502 }) }),
      retryScheduled("a2", 2),
      stepStarted("a3", 2),
      textEnded("a3", "One: the config file moved."),
      stepEnded("a3"),
      executionSucceeded("exe_2"),
    )
    return [d.id]
  },

  refused(store, prefix) {
    const d = new Driver(store, sid(prefix, "refused"))
    d.add(created(), baselineSet())
    exchange(d, "1", "List the files.", "There are three files.")
    const [delivered] = d.add(enqueue("u2", "Write something the filter rejects."), executionStarted("exe_2"), deliver("u2"))
      .slice(-1)
    d.add(
      stepStarted("a2"),
      textEnded("a2", "Sure, here"),
      stepRefused("a2", delivered!.seq),
      executionFailed("exe_2", "The provider refused the request."),
    )
    exchange(d, "3", "Never mind. What is in README.md?", "A title and an install section.")
    return [d.id]
  },

  compaction(store, prefix) {
    const d = new Driver(store, sid(prefix, "compaction"))
    d.add(created(), baselineSet())
    exchange(d, "1", "Fix the typo in README.md.", "Fixed.")
    exchange(d, "2", "Now run the tests.", "All 40 tests pass.")
    d.add(enqueue("u3", "Add a CHANGELOG entry."), executionStarted("exe_3"), compactionStarted("c1"))
    d.request("r1", "c1", "compaction", "error")
    d.add(compactionFailed("c1"), compactionStarted("c2"))
    d.request("r2", "c2", "compaction", "ok")
    d.add(compactionEnded("c2", d.seqOf("u2")))
    // The baseline may change only after a compaction.
    d.add(baselineSet("You are a coding agent working in /work/demo. Prefer small diffs."))
    d.add(deliver("u3"), stepStarted("a3"), textEnded("a3", "Added."), stepEnded("a3"), executionSucceeded("exe_3"))
    return [d.id]
  },

  revert(store, prefix) {
    const d = new Driver(store, sid(prefix, "revert"))
    d.add(created(), baselineSet())
    exchange(d, "1", "Use tabs in main.go.", "Converted to tabs.")
    exchange(d, "2", "Actually delete main.go.", "Deleted main.go.")
    d.add(reverted(d.seqOf("u2")))
    exchange(d, "3", "Rename main.go to app.go instead.", "Renamed.")
    return [d.id]
  },

  inbox(store, prefix) {
    const d = new Driver(store, sid(prefix, "inbox"))
    d.add(created(), baselineSet())
    d.add(
      enqueue("u1", "First, look at the logs.", "queue"),
      enqueue("u2", "Then fix the bug.", "queue"),
      enqueue("u3", "Oops, ignore that.", "steer"),
      enqueue("b1", "Background job 7 finished: exit 0", "queue", "background"),
      changeDelivery("u2", "steer"),
      cancel("u3"),
      executionStarted("exe_1"),
      // The steer goes first; the queued items follow one at a time, each once the session would go idle.
      deliver("u2"),
      stepStarted("a1"),
      textEnded("a1", "Fixing it."),
      stepEnded("a1"),
      deliver("u1"),
      stepStarted("a2"),
      textEnded("a2", "Logs are clean."),
      stepEnded("a2"),
      deliver("b1"),
      stepStarted("a3"),
      textEnded("a3", "And the job succeeded."),
      stepEnded("a3"),
      executionSucceeded("exe_1"),
    )
    // Waiting items stay in the inbox.
    d.add(enqueue("u4", "Later: update the docs.", "queue"))
    return [d.id]
  },

  fork(store, prefix) {
    const parent = new Driver(store, sid(prefix, "parent"))
    parent.add(created(), baselineSet())
    exchange(parent, "1", "Sketch a plan for the API.", "1. Routes 2. Handlers 3. Tests")
    const forkPoint = parent.lastSeq
    exchange(parent, "2", "Do step 1.", "Routes added.")
    const child = new Driver(store, sid(prefix, "child"))
    child.add(forked(parent.id, forkPoint))
    exchange(child, "2", "Do step 3 first.", "Tests written.")
    // A fork of a fork, at a point inside the inherited range of its parent.
    const grandchild = new Driver(store, sid(prefix, "grandchild"))
    grandchild.batch(forked(child.id, child.lastSeq), enqueue("u9", "Waiting for later.", "queue"))
    exchange(parent, "3", "Do step 2.", "Handlers added.")
    return [parent.id, child.id, grandchild.id]
  },
}
