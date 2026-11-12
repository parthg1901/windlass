/**
 * The strategy that measures the product: the generated session is loaded
 * into a real session store, the real engine compacts it, and every question
 * is asked through the real loop with the real history tools.
 *
 * 1. Load. The session's messages become a valid event log (prompts
 *    delivered under executions, steps with their calls settled), in a store
 *    file of its own. The baseline is the harness's own system prompt and
 *    the tool list the engine offers: the standard tools and the history tools.
 * 2. Compact. A short user message is sent through the engine, which is told
 *    a context window small enough that the request is over the trigger. The
 *    loop does what it does for any session: chooses the tail, asks the model
 *    for the summary (repairing or falling back as needed) and freezes the
 *    checkpoint. The model's reply to that short message is canned, so the
 *    only model calls here are the summary's.
 * 3. Ask. Each question is asked in a fork of the compacted session, so every
 *    question starts from the same state and shares its prompt-cache prefix.
 *    The model may call `history_search` and `history_read`, which run
 *    against the fork's stored messages (the engine's full-text index); the
 *    other tools are listed, as in the product, but refuse to run: the
 *    session's workspace does not exist.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { estimateRequest } from "../../packages/core/src/context/estimate.ts"
import { HISTORY_READ, HISTORY_SEARCH } from "../../packages/core/src/context/history-tools.ts"
import { NOTE_TEXT } from "../../packages/core/src/engine/constants.ts"
import { createEngine } from "../../packages/core/src/engine/engine.ts"
import { HARNESS_ORIGIN, type NewEvent, type StoredEvent, event } from "../../packages/core/src/event/durable.ts"
import type { ExecutionId, MessageId, SessionId } from "../../packages/core/src/id.ts"
import { buildBaseline } from "../../packages/core/src/instructions/baseline.ts"
import type { Message } from "../../packages/core/src/message/message.ts"
import { makeProviderError } from "../../packages/core/src/provider/error.ts"
import type { Provider, StreamEvent } from "../../packages/core/src/provider/provider.ts"
import { buildRequest } from "../../packages/core/src/request/build.ts"
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"
import { type SqliteStore, openSqliteStore } from "../../packages/core/src/store/sqlite.ts"
import { historyReadTool, historySearchTool } from "../../packages/core/src/context/history-tools.ts"
import type { AnyTool, ToolEffect } from "../../packages/core/src/tool/tool.ts"
import { createStandardTools } from "../../packages/core/src/tools/index.ts"
import type { GeneratedSession } from "./generate.ts"
import { LIVE_EFFORT, type ModelFn } from "./model.ts"
import { MODEL } from "./session.ts"

/**
 * The context window the engine is told, chosen so that a 40,000-token
 * session is over the trigger and a normal compaction keeps about as much
 * history word for word as the other strategies do (about 1,500 tokens).
 */
export const ENGINE_WINDOW = 30_600
/** Model calls per question before the loop makes a last one without tools: two rounds of history tools, then the answer. */
export const ENGINE_MAX_STEPS = 2
/** What is sent to make the engine compact, and the canned reply to it. */
export const COMPACT_PROMPT = "Hold on before you continue: I have a few quick questions about the work so far."
export const COMPACT_REPLY = "Go ahead."

const SETTINGS = { model: MODEL, reasoningEffort: LIVE_EFFORT }
const CWD = "/workspace/ledgerline"
const EFFECTS: Record<string, ToolEffect> = { read: "read", grep: "read", glob: "read", ls: "read", shell: "exec", edit: "write", write: "write" }

/** The standard tools as the model is told about them, with executors that refuse: the fictional workspace is not there. */
function listedTools(): AnyTool[] {
  return createStandardTools({ spillDir: "/nonexistent" }).map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        effect: "read",
        execute: async () => ({
          status: "error",
          output: `${tool.name} is not available while answering this question; use ${HISTORY_SEARCH} or ${HISTORY_READ}.`,
          truncation: null,
          attachments: [],
          display: null,
        }),
      }) as unknown as AnyTool,
  )
}

/**
 * The generated messages as the events of a session: one execution, every
 * user message delivered into it at a step boundary (a generated turn may end
 * on a tool call, which only a steer may follow), every step with its calls
 * started and settled. When the session ends on a tool call the execution is
 * closed the way a user's cancel closes it, marker included; otherwise it
 * succeeds. Message IDs are the generator's; the `seq` the store assigns is
 * the events', so a message's `seq` in the store is not the generator's.
 */
export function sessionEvents(messages: readonly Message[], tools: readonly AnyTool[]): NewEvent[] {
  const events: NewEvent[] = [
    event("session.created", { cwd: CWD, title: "recall evaluation", lineage: null, settings: SETTINGS }),
    event("baseline.set", buildBaseline({ tools: [...tools, historySearchTool, historyReadTool], sources: [] })),
  ]
  const execution = "exe_recall_history" as ExecutionId
  let started = false
  for (const message of messages) {
    if (message.kind === "user") {
      events.push(event("inbox.enqueued", { messageId: message.id, origin: null, delivery: "steer", content: message.content }))
      if (!started) events.push(event("execution.started", { executionId: execution }))
      started = true
      events.push(event("inbox.delivered", { messageId: message.id }))
      continue
    }
    if (message.kind !== "assistant") throw new Error(`a generated session holds user messages and steps, not ${message.kind}`)
    if (!started) throw new Error("a generated session starts with a user message")
    events.push(event("step.started", { messageId: message.id, attempt: 1, model: message.model }))
    for (const part of message.parts) {
      if (part.type === "text") events.push(event("text.ended", { messageId: message.id, text: part.text, providerData: part.providerData }))
      if (part.type !== "tool_call" || part.state.status !== "settled") continue
      events.push(
        event("tool.called", { messageId: message.id, callId: part.callId, name: part.name, input: part.input, providerData: part.providerData }),
        event("tool.started", { messageId: message.id, callId: part.callId, effect: EFFECTS[part.name] ?? "read" }),
        event("tool.settled", { messageId: message.id, callId: part.callId, outcome: part.state.outcome, output: part.state.output, truncation: null, attachments: [], display: null }),
      )
    }
    events.push(event("step.ended", { messageId: message.id, finish: message.finish ?? "stop", usage: null }))
  }
  const last = messages.at(-1)
  if (!started) return events
  if (last?.kind === "assistant" && last.finish !== "tool_calls") return [...events, event("execution.succeeded", { executionId: execution, verification: { status: "not_configured" } })]
  // The model was still at work: the session is at rest only once that is stopped, which the model is told.
  return [
    ...events,
    event("execution.interrupt_requested", { executionId: execution, reason: "user" }),
    event("synthetic.appended", { messageId: "msg_recall_stopped" as MessageId, origin: HARNESS_ORIGIN.interrupt, content: [{ type: "text", text: NOTE_TEXT.interruptedByUser }] }),
    event("execution.interrupted", { executionId: execution, reason: "user" }),
  ]
}

/**
 * A provider that answers from a `ModelFn`, so the evaluation's request
 * budget, retry and scripted fake all apply to the engine's calls. A model
 * function that throws (the request budget is spent) is reported to `failed`
 * and ends the call with an error the loop does not retry.
 */
function providerOf(model: ModelFn, canned: () => boolean, failed: (error: unknown) => void): Provider {
  const stream = async function* (request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const summary = request.toolChoice === "none" && request.input.at(-1)?.type === "message" && (request.input.at(-1) as { role?: string }).role === "developer"
    if (canned() && !summary) {
      // The reply to the message that made the engine compact: nothing is asked of the model.
      yield { type: "text.end", text: COMPACT_REPLY, providerData: null }
      yield { type: "finish", reason: "stop" }
      return
    }
    const reply = await model(request).catch((error: unknown) => {
      failed(error)
      return null
    })
    if (signal.aborted) return
    if (reply === null) {
      yield { type: "error", error: makeProviderError("invalid_request", "the evaluation stopped this call") }
      return
    }
    if (reply.error !== null) {
      yield { type: "error", error: makeProviderError("invalid_request", reply.error) }
      return
    }
    for (const item of reply.output) {
      if (item.type === "reasoning") yield { type: "reasoning.end", text: item.text, providerData: item.providerData }
      if (item.type === "assistant_text") yield { type: "text.end", text: item.text, providerData: item.providerData }
      if (item.type === "tool_call") yield { type: "tool_call.end", callId: item.callId, name: item.name, input: item.input, providerData: item.providerData }
    }
    if (reply.usage !== null) yield { type: "usage", usage: reply.usage }
    yield { type: "finish", reason: reply.calls.length > 0 ? "tool_calls" : "stop" }
  }
  return { id: "recall-evaluation", stream }
}

export interface EngineAnswer {
  readonly factId: string
  readonly answer: string
  /** Everything the model was shown for this question: the request it answered from, tool results included. */
  readonly shown: string
  readonly toolCalls: number
  readonly inputTokens: number | null
  readonly cachedTokens: number | null
  readonly requests: number
}

export interface EngineCompaction {
  readonly trigger: string
  readonly mode: string
  readonly source: string
  readonly detail: string | null
  readonly tokensBefore: number
  readonly tokensAfter: number
  /** Messages before the cut, and tokens of the context after it (estimated). */
  readonly removedMessages: number
  readonly contextTokens: number
  /** Model calls the summary took (1; 2 with a repair). */
  readonly requests: number
  readonly checkpoint: string
}

export interface EngineRun {
  readonly compaction: EngineCompaction
  readonly answers: readonly EngineAnswer[]
  /** The store file that holds the session and its forks, closed: for a look at the log or a trace export. Removed by `dispose` unless the caller named the directory. */
  readonly database: string
  readonly sessionId: SessionId
  readonly dispose: () => void
}

export interface EngineOptions {
  readonly session: GeneratedSession
  readonly model: ModelFn
  readonly question: (text: string) => string
  /** Where the store file goes. Default: a temporary directory, removed by `dispose`. */
  readonly directory?: string
  readonly window?: number
  /** Called with each answer as it arrives. */
  readonly onAnswer?: (answer: EngineAnswer) => void
}

/** Loads, compacts and asks. Throws when the engine did not compact: then the number would not be about compaction. */
export async function runEngine(options: EngineOptions): Promise<EngineRun> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "lh-recall-"))
  const database = join(directory, "recall.db")
  const store = openSqliteStore({ path: database })
  const tools = listedTools()
  let phase: "compact" | "ask" = "compact"
  let counter = 0
  /** What the model function threw, if it did: the run stops there. */
  const thrown: unknown[] = []
  const stopped = () => {
    if (thrown.length > 0) throw thrown[0]
  }
  const engine = createEngine({
    store,
    provider: providerOf(
      options.model,
      () => phase === "compact",
      (error) => thrown.push(error),
    ),
    tools,
    dataDir: directory,
    snapshots: null,
    loadConfig: null,
    discover: () => [],
    contextWindow: () => options.window ?? ENGINE_WINDOW,
    log: (line) => process.stderr.write(`${line}\n`),
  })
  /** Removes what the run left on disk, unless the caller chose where to keep it. */
  const dispose = () => {
    if (options.directory === undefined) rmSync(directory, { recursive: true, force: true })
  }
  try {
    const sessionId = "ses_recall_parent" as SessionId
    store.append(sessionId, sessionEvents(options.session.messages, tools))
    const parent = engine.openSession(sessionId)
    parent.send(COMPACT_PROMPT)
    await parent.settled()
    stopped()
    const log = store.readEvents(sessionId)
    const compaction = describeCompaction(store, sessionId, log)
    await parent.close()
    phase = "ask"

    const throughSeq = store.getSession(sessionId)!.lastSeq
    const answers: EngineAnswer[] = []
    for (const fact of options.session.facts) {
      const forkId = `ses_recall_fork_${String(++counter).padStart(2, "0")}` as SessionId
      store.append(forkId, [event("session.created", { cwd: CWD, title: fact.id, lineage: { kind: "fork", parentSessionId: sessionId, throughSeq }, settings: SETTINGS })])
      const fork = engine.openSession(forkId)
      fork.send(options.question(fact.question), { maxSteps: ENGINE_MAX_STEPS })
      await fork.settled()
      stopped()
      const projection = fork.projection()
      const own = projection.messages.filter((message) => message.seq > throughSeq)
      const steps = own.filter((message) => message.kind === "assistant")
      const last = steps.at(-1)
      const said = last?.kind === "assistant" ? last.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") : ""
      const failed = store.readEvents(forkId, { afterSeq: throughSeq }).findLast((item) => item.type === "execution.failed")
      const first = steps.find((message) => message.kind === "assistant" && message.usage !== null)
      const answer: EngineAnswer = {
        factId: fact.id,
        answer: failed?.type === "execution.failed" ? `[error: ${failed.data.message}]` : said,
        shown: buildRequest(projection, { toolChoice: "auto" }).input.map(itemText).join("\n"),
        toolCalls: steps.reduce((sum, message) => sum + (message.kind === "assistant" ? message.parts.filter((part) => part.type === "tool_call").length : 0), 0),
        inputTokens: first?.kind === "assistant" ? (first.usage?.inputTokens ?? null) : null,
        cachedTokens: first?.kind === "assistant" ? (first.usage?.cachedInputTokens ?? null) : null,
        requests: store.readRequests(forkId).length,
      }
      answers.push(answer)
      options.onAnswer?.(answer)
      await fork.close()
    }
    await engine.close()
    // Let go of the file: whoever reads the sessions next (a test, the trace exporter) opens it.
    store.close()
    return { compaction, answers, database, sessionId, dispose }
  } catch (error) {
    await engine.close().catch(() => {})
    store.close()
    dispose()
    throw error
  }
}

function describeCompaction(store: SqliteStore, sessionId: SessionId, log: readonly StoredEvent[]): EngineCompaction {
  const started = log.findLast((item): item is StoredEvent<"compaction.started"> => item.type === "compaction.started")
  const ended = log.findLast((item): item is StoredEvent<"compaction.ended"> => item.type === "compaction.ended")
  if (started === undefined || ended === undefined) {
    const failure = log.findLast((item) => item.type === "execution.failed")
    throw new Error(`the engine did not compact the session${failure?.type === "execution.failed" ? `: ${failure.data.message}` : ""}`)
  }
  const projection = store.getProjection(sessionId)!
  return {
    trigger: started.data.trigger,
    mode: started.data.mode,
    source: ended.data.source,
    detail: ended.data.detail,
    tokensBefore: started.data.tokensBefore,
    tokensAfter: ended.data.tokensAfter,
    removedMessages: projection.messages.filter((message) => message.seq < started.data.keepFromSeq && message.kind !== "compaction").length,
    contextTokens: estimateRequest(buildRequest(projection, { toolChoice: "auto" })),
    requests: store.readRequests(sessionId).filter((row) => row.purpose === "compaction").length,
    checkpoint: ended.data.summary,
  }
}

function itemText(item: InputItem): string {
  switch (item.type) {
    case "message":
      return item.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    case "assistant_text":
    case "reasoning":
      return item.text
    case "tool_call":
      return item.input
    case "tool_result":
      return item.output
  }
}
