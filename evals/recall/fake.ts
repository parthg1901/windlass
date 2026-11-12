/**
 * A scripted model for tests and for running the pipeline without spending
 * anything. It is an "oracle reader": it answers a question with the gold
 * answer exactly when every needle of that answer is in what it was shown,
 * and otherwise says it cannot tell. With history tools it first searches for
 * the first needle. So its recall measures what each strategy's context makes
 * available, not what a model would make of it.
 */
import { HISTORY_SEARCH } from "../../packages/core/src/context/history-tools.ts"
import { SUMMARY_SECTIONS } from "../../packages/core/src/context/summary.ts"
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"
import { JUDGE_INSTRUCTIONS } from "./evaluate.ts"
import type { Fact, GeneratedSession, Needle } from "./generate.ts"
import { hasNeedle } from "./grade.ts"
import type { ModelFn, ModelReply } from "./model.ts"

/** A summary with every section and no planted detail. */
export const GENERIC_SUMMARY = SUMMARY_SECTIONS.map(
  (section) => `## ${section.heading}\n- ${section.heading === "In progress" ? "Updating the configuration docs.\nNext step: compare docs/configuration.md with src/config/schema.ts." : "Work on the billing service."}`,
).join("\n")

export interface FakeOptions {
  readonly summary?: string
  /** What the judge says for every item. Default `true`. */
  readonly judge?: boolean
}

export function oracleModel(session: GeneratedSession, options: FakeOptions = {}): ModelFn & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  const model = async (request: ModelRequest): Promise<ModelReply> => {
    requests.push(request)
    if (request.instructions === JUDGE_INSTRUCTIONS) {
      const prompt = textOf(request.input[0]!)
      const items = JSON.parse(prompt.slice(prompt.indexOf("\n[") + 1)) as { id: string }[]
      return reply(JSON.stringify({ grades: items.map((item) => ({ id: item.id, pass: options.judge ?? true })) }))
    }
    const last = request.input[request.input.length - 1]!
    if (last.type === "message" && last.role === "developer") return reply(options.summary ?? GENERIC_SUMMARY)
    const at = request.input.findLastIndex((item) => item.type === "message" && item.role === "user")
    const question = request.input[at]
    const fact = session.facts.find((candidate) => question !== undefined && textOf(question).includes(candidate.question))
    if (fact === undefined) return reply("I cannot tell.")
    const searched = request.input.slice(at + 1).some((item) => item.type === "tool_result")
    if (request.tools.some((tool) => tool.name === HISTORY_SEARCH) && request.toolChoice === "auto" && !searched) {
      const call = { callId: `call_${requests.length}`, name: HISTORY_SEARCH, input: JSON.stringify({ query: plain(needles(fact)[0]!) }) }
      return { text: "", calls: [call], output: [{ type: "tool_call", ...call, providerData: null }], usage: null, error: null }
    }
    const shown = request.input.map(textOf).join("\n")
    return reply(needles(fact).every((needle) => hasNeedle(shown, needle)) ? fact.gold : "I cannot tell from what I have.")
  }
  return Object.assign(model, { requests })
}

function needles(fact: Fact): readonly Needle[] {
  return fact.rule.kind === "contains" ? fact.rule.all : fact.rule.mustContain
}

function plain(needle: Needle) {
  return typeof needle === "string" ? `"${needle}"` : String(needle.number)
}

function reply(text: string): ModelReply {
  return { text, calls: [], output: [{ type: "assistant_text", text, providerData: null }], usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 }, error: null }
}

function textOf(item: InputItem): string {
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
