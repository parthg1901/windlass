/**
 * A walk through the SQLite store: append a short synthetic session, print what
 * a UI would show and what the model would be sent, then close the file,
 * reopen it and print both again.
 *
 *   bun scripts/store-demo.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type NewEvent, event } from "../packages/core/src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, RequestId, SessionId } from "../packages/core/src/id.ts"
import type { Message } from "../packages/core/src/message/message.ts"
import { openSqliteStore } from "../packages/core/src/store/sqlite.ts"
import type { Store } from "../packages/core/src/store/store.ts"

const m = (id: string) => id as MessageId
const x = (id: string) => id as ExecutionId
const c = (id: string) => id as CallId
const sessionId = "ses_demo" as SessionId
const usage = { inputTokens: 1800, cachedInputTokens: 1536, outputTokens: 120, reasoningTokens: 40 }

const directory = mkdtempSync(join(tmpdir(), "light-harness-demo-"))
const path = join(directory, "sessions.db")
console.log(`Database: ${path} (temporary, removed at exit)\n`)

let store = openSqliteStore({ path })
const append = (...events: NewEvent[]) => {
  for (const next of events) store.append(sessionId, [next])
}
const seqOf = (id: string) => store.readMessages(sessionId).find((message) => message.id === id)!.seq

const screenshot = store.putBlob(new TextEncoder().encode("\x89PNG not really an image"), "image/png")

append(
  event("session.created", {
    cwd: "/work/weather-cli",
    title: "Fix the forecast bug",
    lineage: null,
    settings: { model: "gpt-test", reasoningEffort: "medium" },
  }),
  event("baseline.set", {
    instructions: "You are a coding agent working in /work/weather-cli.",
    tools: [
      { name: "read", description: "Read a file", inputSchema: { type: "object" } },
      { name: "shell", description: "Run a command", inputSchema: { type: "object" } },
    ],
    sources: [],
  }),
)

// Turn 1: a prompt with an image, a step with two parallel tool calls, a final answer.
append(
  event("inbox.enqueued", {
    messageId: m("msg_u1"),
    origin: null,
    delivery: "steer",
    content: [
      { type: "text", text: "The forecast shows yesterday. Why?" },
      { type: "media", blob: screenshot },
    ],
  }),
  event("execution.started", { executionId: x("exe_1") }),
  event("inbox.delivered", { messageId: m("msg_u1") }),
  event("step.started", { messageId: m("msg_a1"), attempt: 1, model: "gpt-test" }),
)
store.beginRequest({
  id: "req_1" as RequestId,
  sessionId,
  messageId: m("msg_a1"),
  attempt: 1,
  purpose: "step",
  model: "gpt-test",
  provider: "fake",
  blocks: [
    { kind: "params", hash: "1".repeat(64), bytes: 120 },
    { kind: "instructions", hash: "2".repeat(64), bytes: 900 },
    { kind: "input", hash: "3".repeat(64), bytes: 300 },
  ],
})
append(
  event("reasoning.ended", { messageId: m("msg_a1"), text: "Check the date math.", providerData: { encrypted: "…" } }),
  event("text.ended", { messageId: m("msg_a1"), text: "Let me look at the date code.", providerData: null }),
  event("tool.called", {
    messageId: m("msg_a1"),
    callId: c("call_1"),
    name: "read",
    input: '{"path":"src/date.ts"}',
    providerData: null,
  }),
  event("tool.called", {
    messageId: m("msg_a1"),
    callId: c("call_2"),
    name: "shell",
    input: '{"cmd":"git log -1 --oneline"}',
    providerData: null,
  }),
  event("tool.started", { messageId: m("msg_a1"), callId: c("call_1"), effect: "read" }),
  event("tool.started", { messageId: m("msg_a1"), callId: c("call_2"), effect: "exec" }),
  event("tool.settled", {
    messageId: m("msg_a1"),
    callId: c("call_1"),
    outcome: "success",
    output: "export const today = () => new Date(Date.now() - 86_400_000)",
    truncation: null,
    attachments: [],
    display: null,
  }),
  event("tool.settled", {
    messageId: m("msg_a1"),
    callId: c("call_2"),
    outcome: "success",
    output: "a1b2c3 subtract a day for timezones",
    truncation: null,
    attachments: [],
    display: null,
  }),
  event("step.ended", { messageId: m("msg_a1"), finish: "tool_calls", usage }),
)
store.finishRequest("req_1" as RequestId, { outcome: "ok", usage, errorKind: null })
append(
  event("step.started", { messageId: m("msg_a2"), attempt: 1, model: "gpt-test" }),
  event("text.ended", {
    messageId: m("msg_a2"),
    text: "`today()` subtracts a day (commit a1b2c3). Remove the offset.",
    providerData: null,
  }),
  event("step.ended", { messageId: m("msg_a2"), finish: "stop", usage }),
  event("execution.succeeded", { executionId: x("exe_1"), verification: { status: "not_configured" } }),
)

// Turn 2: the user stops a step mid-answer, then rewinds it away.
append(
  event("inbox.enqueued", { messageId: m("msg_u2"), origin: null, delivery: "steer", content: [{ type: "text", text: "Rewrite the whole date module." }] }),
  event("execution.started", { executionId: x("exe_2") }),
  event("inbox.delivered", { messageId: m("msg_u2") }),
  event("step.started", { messageId: m("msg_a3"), attempt: 1, model: "gpt-test" }),
  // The cancel is durable before anything stops; then the visible text is flushed, the step closed and the model told.
  event("execution.interrupt_requested", { executionId: x("exe_2"), reason: "user" }),
  event("text.ended", { messageId: m("msg_a3"), text: "Sure, starting with", providerData: null }),
  event("step.failed", { messageId: m("msg_a3"), error: { kind: "interrupted", reason: "user" }, usage: null }),
  event("synthetic.appended", {
    messageId: m("msg_s1"),
    origin: "interrupt",
    content: [{ type: "text", text: "The user stopped the previous response before it finished." }],
  }),
  event("execution.interrupted", { executionId: x("exe_2"), reason: "user" }),
)
append(event("history.reverted", { fromSeq: seqOf("msg_u2"), restore: null }))

// Turn 3: compact, keeping the last answer verbatim, then continue.
append(
  event("inbox.enqueued", { messageId: m("msg_u3"), origin: null, delivery: "steer", content: [{ type: "text", text: "Just remove the offset." }] }),
  event("execution.started", { executionId: x("exe_3") }),
  event("compaction.started", { messageId: m("msg_c1"), trigger: "auto", mode: "normal", keepFromSeq: seqOf("msg_a2"), prompt: "Summarise the conversation so far.", tokensBefore: 0 }),
  event("compaction.ended", {
    messageId: m("msg_c1"),
    summary: "The forecast was off by a day because today() subtracts 24h (commit a1b2c3).",
    source: "model",
    detail: null,
    tokensAfter: 0,
    usage,
  }),
  event("inbox.delivered", { messageId: m("msg_u3") }),
  event("step.started", { messageId: m("msg_a4"), attempt: 1, model: "gpt-test" }),
  event("text.ended", { messageId: m("msg_a4"), text: "Removed the offset; the forecast now shows today.", providerData: null }),
  event("step.ended", { messageId: m("msg_a4"), finish: "stop", usage }),
  event("execution.succeeded", { executionId: x("exe_3"), verification: { status: "not_configured" } }),
)

// Waiting input stays in the inbox until a step boundary delivers it.
append(
  event("inbox.enqueued", { messageId: m("msg_u4"), origin: null, delivery: "queue", content: [{ type: "text", text: "Afterwards, add a test." }] }),
)

const first = render(store)
console.log(first)
store.close()

store = openSqliteStore({ path })
const second = render(store)
console.log("---- after closing and reopening the file ----\n")
console.log(second)
console.log(second === first ? "Both reads are identical." : "MISMATCH between the two reads!")
store.close()
rmSync(directory, { recursive: true, force: true })

function render(store: Store): string {
  const summary = store.getSession(sessionId)!
  const history = store.readModelHistory(sessionId)
  const sent = new Set(history.messages.map((message) => message.id))
  const compaction = summary.session.compaction
  const omitted = (message: Message) => {
    if (sent.has(message.id)) return ""
    if (message.excluded !== null) return ` [not sent: ${message.excluded}]`
    if (message.kind === "compaction") return " [not sent: superseded]"
    return compaction !== null && message.seq < compaction.keepFromSeq ? " [not sent: before the compaction]" : ""
  }
  const lines = [
    `Session ${sessionId} "${summary.session.title}" in ${summary.session.cwd}: ${summary.lastSeq} events, ` +
      `${summary.session.execution === null ? "idle" : `execution ${summary.session.execution.status}`}`,
    "",
    "UI view (readMessages): every message, numbered by the seq of the event that created it.",
    ...store.readMessages(sessionId).map((message) => `  ${describe(message, omitted(message))}`),
    "",
    `Model view (readModelHistory): the baseline from seq ${history.baseline?.seq} (instructions and ` +
      `${history.baseline?.tools.length} tools), then ${history.messages.length} messages, ` +
      `${compaction === null ? "in seq order" : "starting with the compaction summary and the messages it kept"}:`,
    ...history.messages.map((message, index) => `  ${index + 1}. ${describe(message, "")}`),
    "",
    `Inbox: ${store
      .readInbox(sessionId)
      .map((item) => `${item.messageId} (${item.delivery}) ${quote(item.content.map((part) => (part.type === "text" ? part.text : "[media]")).join(" "))}`)
      .join(", ") || "empty"}`,
  ]
  const last = store.lastRequest(sessionId, "step")
  if (last !== null)
    lines.push(
      `Request ledger: ${store.readRequests(sessionId).length} row(s); the last step request is ${last.id} for ` +
        `${last.messageId}: ${last.blocks.length} block hashes, outcome ${last.outcome}, ` +
        `${last.usage?.cachedInputTokens} of ${last.usage?.inputTokens} input tokens cached`,
    )
  const blob = store.getBlob(screenshot.hash)!
  lines.push(`Blob ${blob.hash.slice(0, 12)}… ${blob.mediaType}, ${blob.bytes.byteLength} bytes`, "")
  return lines.join("\n")
}

function describe(message: Message, excluded: string): string {
  const head = `#${String(message.seq).padEnd(3)} ${message.kind.padEnd(11)} ${message.id.padEnd(7)}`
  switch (message.kind) {
    case "user":
    case "synthetic":
      return `${head}${excluded} ${message.content.map((part) => (part.type === "text" ? quote(part.text) : `[${part.blob.mediaType}]`)).join(" ")}`
    case "instruction":
      return `${head}${excluded} ${message.source}: ${quote(message.text)}`
    case "compaction":
      return `${head}${excluded} ${message.status}, keeps from #${message.keepFromSeq}: ${quote(message.summary ?? "")}`
    case "assistant": {
      const status = message.status === "failed" && message.error ? `failed (${message.error.kind})` : message.status
      const parts = message.parts.map((part) => {
        if (part.type === "tool_call") {
          const result = part.state.status === "settled" ? ` -> ${part.state.outcome} ${quote(part.state.output)}` : ` (${part.state.status})`
          return `${part.name}(${part.input})${result}`
        }
        return `${part.type} ${quote(part.text)}`
      })
      return `${head}${excluded} ${status}\n${parts.map((part) => `        - ${part}`).join("\n")}`
    }
  }
}

function quote(value: string): string {
  return JSON.stringify(value.length > 70 ? `${value.slice(0, 67)}...` : value)
}
