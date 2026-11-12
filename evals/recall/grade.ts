/**
 * Grading an answer against a planted fact. Exact identifiers are checked
 * without a model; a model judge is asked only where meaning matters (the
 * reason for a decision, or an answer that also names a look-alike).
 */
import type { Fact, Needle } from "./generate.ts"

export type Verdict =
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly missing: readonly string[] }
  /** The deterministic part passed; a judge must decide with this rubric. */
  | { readonly kind: "judge"; readonly rubric: string }

/** Quotes, backticks and whitespace vary between answers without changing them. */
export function normalize(text: string): string {
  return text
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function hasNeedle(answer: string, needle: Needle): boolean {
  const text = normalize(answer)
  if (typeof needle !== "string") return new RegExp(`(?<![\\d.])${needle.number}(?![\\d])`).test(text)
  return text.toLowerCase().includes(normalize(needle).toLowerCase())
}

/** A needle named as a whole token: `billing.newTaxEngine` is not named by `billing.newTaxEngineV2`. */
export function namesToken(answer: string, needle: Needle): boolean {
  if (typeof needle !== "string") return hasNeedle(answer, needle)
  const escaped = normalize(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`, "i").test(normalize(answer))
}

export function gradeAnswer(fact: Fact, answer: string): Verdict {
  const rule = fact.rule
  const required = rule.kind === "contains" ? rule.all : rule.mustContain
  const missing = required.filter((needle) => !hasNeedle(answer, needle)).map(describe)
  if (missing.length > 0) return { kind: "fail", missing }
  if (rule.kind === "judge") return { kind: "judge", rubric: rule.rubric }
  const ambiguous = (rule.ambiguousIf ?? []).some((needle) => namesToken(answer, needle))
  if (ambiguous) return rule.rubric === undefined ? { kind: "fail", missing: [] } : { kind: "judge", rubric: rule.rubric }
  return { kind: "pass" }
}

function describe(needle: Needle) {
  return typeof needle === "string" ? needle : String(needle.number)
}

export interface JudgeItem {
  readonly id: string
  readonly question: string
  readonly gold: string
  readonly rubric: string
  readonly answer: string
}

/** One request grades every pending item; the judge answers with one JSON object. */
export function judgePrompt(items: readonly JudgeItem[]): string {
  return [
    "You grade answers to questions about an earlier coding session. For each item, decide whether the answer meets the rubric. The gold answer shows what is correct; wording may differ, but every point of the rubric must be there and nothing in the answer may contradict it.",
    'Reply with only a JSON object: {"grades": [{"id": "<id>", "pass": true or false}]}, one entry per item, in the same order.',
    "",
    JSON.stringify(
      items.map((item) => ({ id: item.id, question: item.question, gold: item.gold, rubric: item.rubric, answer: item.answer })),
      null,
      1,
    ),
  ].join("\n")
}

/** Reads the judge's reply. Items it does not grade, or a reply that is not JSON, count as failed. */
export function parseJudgeReply(reply: string, items: readonly JudgeItem[]): Map<string, boolean> {
  const grades = new Map<string, boolean>(items.map((item) => [item.id, false]))
  const body = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (body === undefined) return grades
  const parsed = safeJson(body)
  const list = parsed !== null && typeof parsed === "object" && "grades" in parsed && Array.isArray(parsed.grades) ? parsed.grades : []
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue
    const { id, pass } = entry as { id?: unknown; pass?: unknown }
    if (typeof id === "string" && grades.has(id)) grades.set(id, pass === true)
  }
  return grades
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
