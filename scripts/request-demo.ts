/**
 * A walk through the request builder: a short scripted session is folded
 * through the real reducer, and after each step the request the model would be
 * sent is printed block by block with its hashes, next to the prefix check the
 * runtime ledger runs. It ends with two breaks: one the harness must never
 * cause, and one it is allowed.
 *
 *   bun scripts/request-demo.ts
 *
 * Nothing here reads the clock or the disk, so the hashes are the same on every run.
 */
import { text } from "../packages/core/src/content.ts"
import { type NewEvent, type StoredEvent, event } from "../packages/core/src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../packages/core/src/id.ts"
import { agentsSource, dateSource, environmentSource } from "../packages/core/src/instructions/source.ts"
import { prepareInstructions } from "../packages/core/src/instructions/state.ts"
import type { Projection } from "../packages/core/src/message/message.ts"
import { reduce } from "../packages/core/src/message/reducer.ts"
import { type PrefixVerdict, checkPrefix } from "../packages/core/src/request/build-break.ts"
import { buildRequest } from "../packages/core/src/request/build.ts"
import { type BlockHash, hashRequest } from "../packages/core/src/request/prefix.ts"
import { type RequestBlock, type RequestParams, requestBlocks } from "../packages/core/src/request/request.ts"
import type { ToolSpec } from "../packages/core/src/tool/tool.ts"

// ---- a session log in memory ----

const sessionId = "ses_demo" as SessionId
const m = (id: string) => id as MessageId
const c = (id: string) => id as CallId
const execution = "exe_1" as ExecutionId
const usage = { inputTokens: 1800, cachedInputTokens: 1536, outputTokens: 120, reasoningTokens: 40 }

let state: Projection | null = null
/** Events appended since the last request was sent. */
let since: StoredEvent[] = []

function append(...events: NewEvent[]) {
  for (const next of events) {
    const seq = (state?.lastSeq ?? 0) + 1
    const stored: StoredEvent = { ...next, sessionId, seq, time: seq * 1000 }
    state = reduce(state, stored)
    since.push(stored)
  }
}

const projection = () => state!
const seqOf = (id: string) => projection().messages.find((message) => message.id === id)!.seq

// ---- instruction sources: plain values here; `discoverSources` reads them from disk and clock ----

const tools: ToolSpec[] = [
  { name: "shell", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "edit", description: "Replace text in a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
]
const agents = agentsSource("/work/weather-cli/AGENTS.md", "Use bun.\nRun `bun test` before you report.")
const environment = environmentSource({ cwd: "/work/weather-cli", platform: "linux", gitRepository: true })
let today = dateSource(2026, 11, 11)
let instructionIds = 0

/** What the step loop does at every step boundary: set the baseline once, afterwards append what changed. */
function prepare() {
  append(
    ...prepareInstructions(projection(), {
      prompt: "You are a coding agent working in a terminal.",
      tools,
      sources: [agents, environment, today],
      newMessageId: () => m(`ins_${++instructionIds}`),
    }),
  )
}

// ---- printing ----

const params: RequestParams = {
  model: "gpt-demo",
  reasoningEffort: "medium",
  textVerbosity: null,
  parallelToolCalls: true,
  cacheKey: sessionId,
}

const clip = (value: string, width = 64) => {
  const line = value.replaceAll("\n", " / ")
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`
}

function describe(block: RequestBlock): string {
  if (block.kind === "params") return `model ${block.params.model}, effort ${block.params.reasoningEffort}`
  if (block.kind === "tool") return `${block.tool.name}: ${block.tool.description}`
  if (block.kind === "instructions") return `"${clip(block.text, 56)}"`
  const item = block.item
  switch (item.type) {
    case "message":
      return `${item.role}: "${clip(item.content.map((part) => (part.type === "text" ? part.text : "[media]")).join(""), 52)}"`
    case "assistant_text":
      return `assistant: "${clip(item.text, 50)}"`
    case "reasoning":
      return "reasoning (provider payload, replayed verbatim)"
    case "tool_call":
      return `call ${item.callId}: ${item.name} ${clip(item.input, 36)}`
    case "tool_result":
      return `result ${item.callId}: "${clip(item.output, 44)}"`
  }
}

function row(mark: string, index: number, block: RequestBlock, hash: BlockHash) {
  return `  ${mark} ${String(index).padStart(2)}  ${block.kind.padEnd(12)}  ${hash.hash.slice(0, 10)}  ${String(hash.bytes).padStart(5)}  ${describe(block)}`
}

function verdictLine(verdict: PrefixVerdict, previous: readonly BlockHash[] | null, next: readonly BlockHash[]) {
  if (verdict.status === "first") return "prefix check: first request of the session, nothing to compare with"
  if (verdict.status === "extension")
    return `prefix check: OK  all ${previous!.length} previous blocks unchanged, ${verdict.appended} appended`
  const { index, kind, change } = verdict.comparison
  const resent = next.slice(index).reduce((total, block) => total + block.bytes, 0)
  const what = `block ${index} (${kind}) ${change}; ${resent} bytes from there on are sent uncached`
  return verdict.status === "expected_break"
    ? `prefix check: ALLOWED BREAK (${verdict.causes.join(", ")})  ${what}`
    : `prefix check: VIOLATION  ${what}`
}

let sent = 0
let previous: BlockHash[] | null = null

/** Builds and prints the request for the next step, with the ledger's prefix check against the last request sent. */
function show(heading: string, from: Projection) {
  const request = buildRequest(from, { params, toolChoice: "auto" })
  const blocks = requestBlocks(request)
  const hashes = hashRequest(request)
  const verdict = checkPrefix(previous, hashes, since)
  const unchanged = verdict.status === "extension" ? previous!.length : verdict.status === "first" ? 0 : verdict.comparison.index
  console.log(`\n${heading}`)
  console.log(`  ${"".padEnd(4)}  ${"kind".padEnd(12)}  ${"sha-256".padEnd(10)}  bytes  content`)
  if (unchanged > 0) {
    const bytes = hashes.slice(0, unchanged).reduce((total, block) => total + block.bytes, 0)
    console.log(`  = 0-${unchanged - 1}  (${unchanged} blocks, ${bytes} bytes, identical to request ${sent})`)
  }
  blocks.slice(unchanged).forEach((block, offset) => {
    const index = unchanged + offset
    const mark = verdict.status === "first" ? " " : verdict.status === "extension" ? "+" : offset === 0 ? "!" : "~"
    console.log(row(mark, index, block, hashes[index]!))
  })
  console.log(`  ${verdictLine(verdict, previous, hashes)}`)
  return { hashes, verdict }
}

/** Shows the request for the next step and records it as sent. */
function send(title: string) {
  const { hashes, verdict } = show(`Request ${sent + 1}: ${title}`, projection())
  sent += 1
  previous = hashes
  since = []
  return verdict
}

// ---- the session ----

console.log("light-harness request demo")
console.log("A request is a list of blocks: params, each tool, the instructions, each input item.")
console.log("The provider's cache reads a request cheaply only if it is the previous request plus appended blocks.")
console.log("Marks: = unchanged   + appended   ! the first block that differs   ~ after it, so no longer cached")

append(event("session.created", { cwd: "/work/weather-cli", title: null, lineage: null }))
prepare()
append(
  event("inbox.enqueued", {
    messageId: m("usr_1"),
    origin: null,
    delivery: "steer",
    content: text("The forecast command prints temperatures in Kelvin. Fix it."),
  }),
  event("execution.started", { executionId: execution }),
  event("inbox.delivered", { messageId: m("usr_1") }),
)
send("the first prompt")

append(
  event("step.started", { messageId: m("ast_1"), attempt: 1, model: params.model }),
  event("reasoning.ended", { messageId: m("ast_1"), text: "Find where the unit is chosen.", providerData: { id: "rs_1", encrypted_content: "gAAAAB…" } }),
  event("tool.called", { messageId: m("ast_1"), callId: c("call_1"), name: "read", input: '{"path":"src/forecast.ts"}', providerData: null }),
  event("tool.called", { messageId: m("ast_1"), callId: c("call_2"), name: "read", input: '{"path":"src/units.ts"}', providerData: null }),
  event("tool.started", { messageId: m("ast_1"), callId: c("call_1") }),
  event("tool.started", { messageId: m("ast_1"), callId: c("call_2") }),
  event("tool.settled", { messageId: m("ast_1"), callId: c("call_2"), outcome: "success", output: "export const toCelsius = (k: number) => k - 273.15", truncation: null, attachments: [], display: null }),
  event("tool.settled", { messageId: m("ast_1"), callId: c("call_1"), outcome: "success", output: "console.log(`${city}: ${reading.kelvin}`)", truncation: null, attachments: [], display: null }),
  event("step.ended", { messageId: m("ast_1"), finish: "tool_calls", usage }),
)
prepare()
send("after step 1 (reasoning, two parallel reads)")

append(
  event("inbox.enqueued", { messageId: m("usr_2"), origin: null, delivery: "steer", content: text("Round to one decimal place.") }),
  event("step.started", { messageId: m("ast_2"), attempt: 1, model: params.model }),
  event("tool.called", { messageId: m("ast_2"), callId: c("call_1"), name: "edit", input: '{"path":"src/forecast.ts"}', providerData: null }),
  event("tool.started", { messageId: m("ast_2"), callId: c("call_1") }),
  event("tool.settled", { messageId: m("ast_2"), callId: c("call_1"), outcome: "success", output: "Edited src/forecast.ts (1 replacement).", truncation: null, attachments: [], display: null }),
  event("step.ended", { messageId: m("ast_2"), finish: "tool_calls", usage }),
  event("inbox.delivered", { messageId: m("usr_2") }),
)
// Midnight passes while the session works: the date is appended, the baseline is not touched.
today = dateSource(2026, 11, 12)
prepare()
send("after step 2 (an edit; the provider reused call_1), a steering message, and midnight")

append(
  event("step.started", { messageId: m("ast_3"), attempt: 1, model: params.model }),
  event("text.ended", { messageId: m("ast_3"), text: "I will now run the", providerData: null }),
  event("tool.called", { messageId: m("ast_3"), callId: c("call_3"), name: "shell", input: '{"command":"bun test"}', providerData: null }),
  event("tool.settled", { messageId: m("ast_3"), callId: c("call_3"), outcome: "not_started", output: "This call was not started: the response was interrupted.", truncation: null, attachments: [], display: null }),
  event("step.failed", { messageId: m("ast_3"), error: { kind: "interrupted", reason: "user" }, usage: null }),
  event("execution.interrupted", { executionId: execution, reason: "user" }),
  event("synthetic.appended", { messageId: m("syn_1"), origin: "interrupt", content: text("Your previous response was interrupted by the user.") }),
  event("inbox.enqueued", { messageId: m("usr_3"), origin: null, delivery: "steer", content: text("Don't run the tests yet, show me the diff.") }),
  event("execution.started", { executionId: execution }),
  event("inbox.delivered", { messageId: m("usr_3") }),
)
prepare()
send("after step 3 was interrupted, with the marker and a new prompt")

// ---- a break the harness must never cause ----

console.log("\nA deliberate break: suppose the harness shortened an old tool output it had already sent.")
const rewritten: Projection = {
  ...projection(),
  messages: projection().messages.map((message) =>
    message.kind !== "assistant" || message.id !== "ast_1"
      ? message
      : {
          ...message,
          parts: message.parts.map((part) =>
            part.type === "tool_call" && part.callId === "call_2" && part.state.status === "settled"
              ? { ...part, state: { ...part.state, output: "[old output removed to save context]" } }
              : part,
          ),
        },
  ),
}
const tampered = show("Not sent: request 4 again, built from the rewritten history", rewritten).verdict

// ---- a break the harness is allowed ----

console.log("\nAn allowed break: the session is compacted, so history restarts at the checkpoint.")
append(
  event("compaction.started", { messageId: m("cmp_1"), trigger: "manual" }),
  event("compaction.ended", {
    messageId: m("cmp_1"),
    summary: "The user wants forecast temperatures in Celsius with one decimal. src/forecast.ts was edited; tests were not run.",
    keepFromSeq: seqOf("usr_3"),
    usage: null,
  }),
)
prepare()
const compacted = send("after a compaction that kept the last prompt")

append(
  event("step.started", { messageId: m("ast_4"), attempt: 1, model: params.model }),
  event("text.ended", { messageId: m("ast_4"), text: "Here is the diff: …", providerData: null }),
  event("step.ended", { messageId: m("ast_4"), finish: "stop", usage }),
)
prepare()
const resumed = send("the step after the compaction")

console.log(
  `\nSummary: ${sent} requests sent. Tampered history: ${tampered.status}. Compaction: ${compacted.status}. After it: ${resumed.status}.`,
)
