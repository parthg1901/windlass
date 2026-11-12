// The recall evaluation with the scripted fake model. No live requests.
import { describe, expect, test } from "bun:test"
import { HISTORY_SENTENCE, INDEX_HEADING, QUOTES_HEADING } from "../../packages/core/src/context/checkpoint.ts"
import { harnessOpen } from "../../packages/core/src/request/build.ts"
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"
import { evaluate, questionText, renderReport } from "./evaluate.ts"
import { GENERIC_SUMMARY, oracleModel } from "./fake.ts"
import { FACT_TYPES, type Fact, generateSession } from "./generate.ts"
import { gradeAnswer, hasNeedle, namesToken, normalize, parseJudgeReply } from "./grade.ts"
import { HistoryIndex } from "./history.ts"
import type { ModelFn, ModelReply } from "./model.ts"
import { buildContext, compact, render } from "./strategies.ts"

const session = generateSession({ seed: 7, tokens: 40_000, facts: 12 })
const textOf = (messages: typeof session.messages) => JSON.stringify(render(messages))
const firstText = (input: readonly InputItem[]) => {
  const first = input[0]
  return first?.type === "message" ? first.content.map((part) => (part.type === "text" ? part.text : "")).join("") : ""
}
const needles = (fact: Fact) => (fact.rule.kind === "contains" ? fact.rule.all : fact.rule.mustContain)

describe("generateSession", () => {
  test("is deterministic from the seed", () => {
    expect(JSON.stringify(generateSession({ seed: 7, tokens: 40_000, facts: 12 }))).toBe(JSON.stringify(session))
    expect(JSON.stringify(generateSession({ seed: 8, tokens: 40_000, facts: 12 }))).not.toBe(JSON.stringify(session))
  })

  test("has the requested size and every fact type, spread over the session", () => {
    expect(session.tokens).toBeGreaterThan(38_000)
    expect(session.tokens).toBeLessThan(44_000)
    expect(session.facts.length).toBe(12)
    expect(new Set(session.facts.map((fact) => fact.type))).toEqual(new Set(FACT_TYPES))
    for (const position of ["early", "middle", "late"] as const) expect(session.facts.some((fact) => fact.position === position)).toBe(true)
  })

  test("plants every fact before the final turn, and never gives the answer away in the question", () => {
    const removed = session.messages.slice(0, session.finalTurn)
    const tail = session.messages.slice(session.finalTurn)
    for (const fact of session.facts) {
      const exact = needles(fact).filter((needle) => typeof needle === "string")
      for (const needle of exact) {
        expect(hasNeedle(textOf(removed), needle)).toBe(true)
        expect(hasNeedle(textOf(tail), needle)).toBe(false)
        expect(hasNeedle(fact.question, needle)).toBe(false)
      }
      expect(fact.seq).toBeLessThan(session.messages[session.finalTurn]!.seq)
    }
  })

  test("a correction's original comes first, and a distractor's decoy sits in the session too", () => {
    const correction = session.facts.find((fact) => fact.type === "correction")!
    const original = session.messages.find((message) => message.kind === "user" && JSON.stringify(message.content).includes(`use `) && message.seq < correction.seq && JSON.stringify(message.content).includes("as the"))
    expect(original).toBeDefined()
    const distractor = session.facts.find((fact) => fact.type === "distractor")!
    if (distractor.rule.kind !== "contains") throw new Error("expected a contains rule")
    for (const decoy of distractor.rule.ambiguousIf ?? []) expect(hasNeedle(textOf(session.messages), decoy)).toBe(true)
  })
})

describe("grading", () => {
  const fact = (rule: Fact["rule"]): Fact => ({ id: "f", type: "path_line", question: "q", gold: "g", rule, seq: 1, fraction: 0, position: "early" })

  test("exact identifiers, with quotes, backticks and spacing normalised", () => {
    const rule = fact({ kind: "contains", all: ["bun run e2e/smoke.ts --suite checkout", { number: 6 }] })
    expect(gradeAnswer(rule, "It was `bun run e2e/smoke.ts  --suite checkout`, exit code 6.").kind).toBe("pass")
    expect(gradeAnswer(rule, "It was bun run e2e/smoke.ts --suite checkout, exit code 16.")).toEqual({ kind: "fail", missing: ["6"] })
    expect(normalize("‘a’ “b”")).toBe('a "b"')
  })

  test("numbers match on their own, not inside other numbers", () => {
    expect(hasNeedle("line 133", { number: 133 })).toBe(true)
    expect(hasNeedle("line 1330", { number: 133 })).toBe(false)
    expect(hasNeedle("v1.133", { number: 133 })).toBe(false)
  })

  test("a look-alike in the answer sends it to the judge", () => {
    const rule = fact({ kind: "contains", all: ["billing.newTaxEngineV2"], ambiguousIf: ["billing.newTaxEngine"], rubric: "r" })
    expect(gradeAnswer(rule, "billing.newTaxEngineV2 was switched off.").kind).toBe("pass")
    expect(gradeAnswer(rule, "billing.newTaxEngineV2, not billing.newTaxEngine.")).toEqual({ kind: "judge", rubric: "r" })
    expect(namesToken("billing.newTaxEngineV2", "billing.newTaxEngine")).toBe(false)
  })

  test("a judged rule checks its keyword first", () => {
    const rule = fact({ kind: "judge", mustContain: ["token bucket"], rubric: "r" })
    expect(gradeAnswer(rule, "We picked Redis.").kind).toBe("fail")
    expect(gradeAnswer(rule, "An in-process Token Bucket, because...").kind).toBe("judge")
  })

  test("the judge's reply is read defensively", () => {
    const items = [{ id: "a", question: "", gold: "", rubric: "", answer: "" }, { id: "b", question: "", gold: "", rubric: "", answer: "" }]
    expect(parseJudgeReply('```json\n{"grades":[{"id":"a","pass":true},{"id":"c","pass":true}]}\n```', items)).toEqual(new Map([["a", true], ["b", false]]))
    expect(parseJudgeReply("no json", items)).toEqual(new Map([["a", false], ["b", false]]))
  })
})

describe("history tools over the session", () => {
  const index = new HistoryIndex(session.messages)

  test("search finds a planted value as the best hit, and read returns the message", () => {
    const preserved = session.facts.find((fact) => fact.type === "preserved_value")!
    const result = index.search({ query: `"${preserved.gold}"` })
    expect(result.hits[0]!.seq).toBe(preserved.seq)
    expect(result.hits[0]!.snippet).toContain(preserved.gold)
    const read = index.read({ seq: preserved.seq })!
    expect(read.text).toContain(preserved.gold)
    expect(read.nextOffset).toBeNull()
  })

  test("long messages are read in parts; bad calls get errors", () => {
    const long = session.messages.find((message) => message.kind === "assistant" && JSON.stringify(message).length > 4_000)!
    const first = index.read({ seq: long.seq, limit: 1_000 })!
    expect(first.text.length).toBe(1_000)
    expect(first.nextOffset).toBe(1_000)
    expect(index.call("history_read", '{"seq": 999999}')).toBe("Error: no message has seq 999999")
    expect(index.call("history_search", "{}")).toStartWith("Error:")
    expect(index.call("history_search", '{"query":"zzqqxx"}')).toBe('No earlier message matches "zzqqxx".')
  })

  test("is deterministic", () => {
    expect(index.call("history_search", '{"query":"migration failed staging"}')).toBe(new HistoryIndex(session.messages).call("history_search", '{"query":"migration failed staging"}'))
  })
})

describe("strategies", () => {
  test("each builds its context from the same compaction", async () => {
    const compaction = await compact(session, oracleModel(session), "k")
    expect(compaction.summary).toBe(GENERIC_SUMMARY)
    // The verbatim tail holds no planted fact.
    for (const fact of session.facts) expect(compaction.kept[0]!.seq).toBeGreaterThan(fact.seq)

    const full = buildContext("full", session, compaction)
    expect(full.input).toEqual(render(session.messages))
    expect(full.tools).toEqual([])

    const summary = buildContext("summary", session, compaction)
    expect(firstText(summary.input)).toStartWith(harnessOpen("compaction"))
    expect(firstText(summary.input)).not.toContain(INDEX_HEADING)

    const checkpoint = buildContext("checkpoint", session, compaction)
    const checkpointText = firstText(checkpoint.input)
    expect(checkpointText).toContain(INDEX_HEADING)
    expect(checkpointText).toContain(QUOTES_HEADING)
    expect(checkpointText).not.toContain("history_search")
    expect(checkpoint.tools).toEqual([])

    const tools = buildContext("checkpoint+tools", session, compaction)
    expect(firstText(tools.input)).toContain(HISTORY_SENTENCE)
    expect(tools.tools.map((tool) => tool.name)).toEqual(["history_search", "history_read"])
    expect(tools.runTool!("history_search", '{"query":"ledger"}')).toContain("[seq ")

    expect(summary.contextTokens).toBeLessThan(checkpoint.contextTokens)
    expect(checkpoint.contextTokens).toBeLessThan(tools.contextTokens)
    expect(tools.contextTokens).toBeLessThan(full.contextTokens / 5)
  })

  test("an invalid summary gets one repair request", async () => {
    const replies = ["just some text", GENERIC_SUMMARY]
    const requests: ModelRequest[] = []
    const model: ModelFn = async (request) => {
      requests.push(request)
      const text = replies.shift()!
      return { text, calls: [], output: [{ type: "assistant_text", text, providerData: null }], usage: null, error: null } satisfies ModelReply
    }
    const compaction = await compact(session, model, "k")
    expect(compaction.requests).toBe(2)
    expect(compaction.check.ok).toBe(true)
    const repair = requests[1]!.input
    expect(repair.length).toBe(requests[0]!.input.length + 2)
    expect(JSON.stringify(repair[repair.length - 1])).toContain("does not have the required form")
  })
})

describe("evaluate", () => {
  test("asks every question per strategy, grades, judges in one request and reports", async () => {
    const model = oracleModel(session)
    const compaction = await compact(session, model, "k")
    const report = await evaluate({ session, compaction, model, cacheKey: "k", date: "2026-11-12", live: false, modelName: "fake", effort: "-" })
    const by = Object.fromEntries(report.strategies.map((strategy) => [strategy.name, strategy]))
    expect(by.full!.recall).toBe(1)
    expect(by.summary!.recall).toBe(0)
    expect(by["checkpoint+tools"]!.recall).toBe(1)
    expect(by.checkpoint!.recall).toBeGreaterThan(by.summary!.recall)
    // Every question is a fresh request: the context plus that question only.
    const questions = model.requests.filter((request) => request.instructions !== "" && request.input.some((item) => item.type === "message" && JSON.stringify(item).includes("Quick question")))
    for (const request of questions) expect(request.input.filter((item) => item.type === "message" && JSON.stringify(item).includes("Quick question")).length).toBe(1)
    expect(report.judgeRequests).toBe(1)
    expect(report.requests).toBe(model.requests.length)
    expect(report.requests).toBeLessThanOrEqual(66)
    const total = (position: "early" | "middle" | "late") => by.full!.byPosition[position].total
    expect(total("early") + total("middle") + total("late")).toBe(12)
    const markdown = renderReport(report)
    expect(markdown).toContain("| checkpoint+tools | 100% (12/12)")
    expect(markdown).toContain("| distractor |")
    expect(questionText("Q?")).toContain("Q?")
  })

  test("a judge that rejects fails the judged answers only", async () => {
    const model = oracleModel(session, { judge: false })
    const compaction = await compact(session, model, "k")
    const report = await evaluate({ session, compaction, model, cacheKey: "k", date: "d", live: false, modelName: "fake", effort: "-", strategies: ["full"] })
    const full = report.strategies[0]!
    expect(full.byType.decision).toEqual({ pass: 0, total: 2 })
    expect(full.byType.path_line).toEqual({ pass: 2, total: 2 })
  })
})
