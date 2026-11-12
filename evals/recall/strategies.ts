/**
 * Context providers: what each strategy shows the model before a question.
 * Every strategy compacts the same prefix and keeps the same verbatim tail, so
 * they differ only in what stands in for the removed history:
 *
 * - `full`: nothing removed; the whole session (the ceiling).
 * - `summary`: the model-written summary alone.
 * - `checkpoint`: Part A's checkpoint without tools: summary, identifier index, verbatim user messages.
 * - `checkpoint+tools`: the same checkpoint (naming the tools) plus `history_search` and `history_read`.
 */
import { buildCheckpoint } from "../../packages/core/src/context/checkpoint.ts"
import { estimateRequest } from "../../packages/core/src/context/estimate.ts"
import { historyReadTool, historySearchTool } from "../../packages/core/src/context/history-tools.ts"
import { DEFAULT_COMPACTION_CONFIG } from "../../packages/core/src/context/policy.ts"
import { summaryPrompt, summaryRepairPrompt, validateSummary, type SummaryCheck } from "../../packages/core/src/context/summary.ts"
import { type TailChoice, chooseTail } from "../../packages/core/src/context/tail.ts"
import type { MessageId } from "../../packages/core/src/id.ts"
import type { CompactionMessage, Message } from "../../packages/core/src/message/message.ts"
import { renderMessage } from "../../packages/core/src/request/build.ts"
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"
import { type ToolSpec, specOf } from "../../packages/core/src/tool/tool.ts"
import { createStandardTools } from "../../packages/core/src/tools/index.ts"
import type { GeneratedSession } from "./generate.ts"
import { HistoryIndex } from "./history.ts"
import { LIVE_EFFORT, type ModelFn } from "./model.ts"
import { MODEL } from "./session.ts"

export type StrategyName = "full" | "summary" | "checkpoint" | "checkpoint+tools"
export const STRATEGIES: readonly StrategyName[] = ["full", "summary", "checkpoint", "checkpoint+tools"]

/** The system prompt of every evaluation request: short, and it explains the harness envelope. */
export const EVAL_INSTRUCTIONS = [
  "You are a coding agent continuing a long session with the user in a TypeScript project.",
  'Messages wrapped in <harness origin="..."> come from the harness, not from the user. A message with origin "compaction" is a checkpoint that stands in for the earlier part of the conversation, which was removed to save space.',
].join("\n")

/**
 * The harness's standard tool list, in every request: the history holds calls
 * to these tools, and the engine never drops its tool list (a compaction
 * request keeps it with tool calls switched off). Only the history tools are
 * ever run here; strategies without them send `toolChoice: "none"`.
 */
export const STANDARD_TOOLS: readonly ToolSpec[] = createStandardTools({ spillDir: "/nonexistent" }).map(specOf)

/** Tokens of verbatim history every compacting strategy keeps: enough for the final turn only. */
export const TAIL_BUDGET = 1_500

export interface Compaction {
  readonly tail: TailChoice
  readonly removed: readonly Message[]
  readonly kept: readonly Message[]
  readonly summary: string
  readonly check: SummaryCheck
  /** Requests spent on the summary (1, or 2 with a repair). */
  readonly requests: number
}

export interface StrategyContext {
  readonly name: StrategyName
  readonly input: readonly InputItem[]
  readonly tools: readonly ToolSpec[]
  /** Runs a history tool call, for the strategy that has them. */
  readonly runTool: ((name: string, input: string) => string) | null
  /** Estimated input tokens of the context alone (instructions, tools, items), before the question. */
  readonly contextTokens: number
}

export function params(cacheKey: string): ModelRequest["params"] {
  return { model: MODEL, reasoningEffort: LIVE_EFFORT, textVerbosity: null, parallelToolCalls: true, cacheKey }
}

export function render(messages: readonly Message[]): InputItem[] {
  return messages.flatMap((message) => renderMessage(message, { model: MODEL, baselineSeq: 0 }))
}

export const developer = (value: string): InputItem => ({ type: "message", role: "developer", content: [{ type: "text", text: value }] })
export const user = (value: string): InputItem => ({ type: "message", role: "user", content: [{ type: "text", text: value }] })

/**
 * Compacts the session's prefix once, the way the engine would: the tail by
 * `chooseTail`, the summary by the model from the normal request plus Part A's
 * summary prompt, with one repair request when the validator rejects it.
 */
export async function compact(session: GeneratedSession, model: ModelFn, cacheKey: string): Promise<Compaction> {
  const tail = chooseTail(session.messages, { budget: TAIL_BUDGET })
  const removed = session.messages.slice(0, tail.keepFrom)
  const kept = session.messages.slice(tail.keepFrom)
  const input = [...render(removed), developer(summaryPrompt())]
  const request = (items: readonly InputItem[]): ModelRequest => ({ params: params(cacheKey), tools: STANDARD_TOOLS, instructions: EVAL_INSTRUCTIONS, input: items, toolChoice: "none" })
  const first = await model(request(input))
  if (first.error !== null) throw new Error(`the summary request failed: ${first.error}`)
  const firstCheck = validateSummary(first.text, DEFAULT_COMPACTION_CONFIG.summaryMaxTokens)
  if (firstCheck.ok) return { tail, removed, kept, summary: first.text.trim(), check: firstCheck, requests: 1 }
  const second = await model(request([...input, ...first.output, developer(summaryRepairPrompt(firstCheck.problems))]))
  const secondCheck = validateSummary(second.text, DEFAULT_COMPACTION_CONFIG.summaryMaxTokens)
  const better = second.error === null && (secondCheck.ok || problems(secondCheck) <= problems(firstCheck))
  return better
    ? { tail, removed, kept, summary: second.text.trim(), check: secondCheck, requests: 2 }
    : { tail, removed, kept, summary: first.text.trim(), check: firstCheck, requests: 2 }
}

function problems(check: SummaryCheck) {
  return check.ok ? 0 : check.problems.length
}

export function buildContext(name: StrategyName, session: GeneratedSession, compaction: Compaction): StrategyContext {
  const finish = (input: readonly InputItem[], tools: readonly ToolSpec[], runTool: StrategyContext["runTool"]): StrategyContext => ({
    name,
    input,
    tools,
    runTool,
    contextTokens: estimateRequest({ instructions: EVAL_INSTRUCTIONS, tools, input }),
  })
  if (name === "full") return finish(render(session.messages), STANDARD_TOOLS, null)
  if (name === "summary") return finish([...render([checkpointMessage(compaction.summary)]), ...render(compaction.kept)], STANDARD_TOOLS, null)
  const tools = name === "checkpoint+tools"
  const checkpoint = buildCheckpoint({ summary: compaction.summary, earlier: compaction.removed, historyTools: tools })
  const input = [...render([checkpointMessage(checkpoint.text)]), ...render(compaction.kept)]
  if (!tools) return finish(input, STANDARD_TOOLS, null)
  const index = new HistoryIndex(session.messages)
  // The other tools are listed but not run: this session's workspace does not exist.
  const run = (tool: string, args: string) =>
    tool === historySearchTool.name || tool === historyReadTool.name
      ? index.call(tool, args)
      : `Error: ${tool} is not available while answering this question; use ${historySearchTool.name} or ${historyReadTool.name}.`
  return finish(input, [...STANDARD_TOOLS, historySearchTool, historyReadTool], run)
}

/** A completed compaction message, so the request builder renders the checkpoint exactly as the engine would. */
function checkpointMessage(summary: string): CompactionMessage {
  return {
    kind: "compaction",
    id: "msg_checkpoint" as MessageId,
    seq: 1,
    time: 0,
    excluded: null,
    trigger: "auto",
    status: "completed",
    summary,
    keepFromSeq: 1,
    usage: null,
    error: null,
    endedAt: 0,
  }
}
