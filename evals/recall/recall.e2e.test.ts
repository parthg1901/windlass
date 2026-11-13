// The recall evaluation with the scripted fake model. No live requests.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionId } from "../../packages/core/src/id.ts"
import { buildRequest } from "../../packages/core/src/request/build.ts"
import { openSqliteStore } from "../../packages/core/src/store/sqlite.ts"
import { createStandardTools } from "../../packages/core/src/tools/index.ts"
import { exportSession } from "../../packages/core/src/trace/export.ts"
import { expectRebuildEqualsLive } from "../../packages/core/test/store/consistency.ts"
import { COMPACT_PROMPT, runEngine, sessionEvents } from "./engine.ts"
import { HISTORY_SENTENCE, INDEX_HEADING, QUOTES_HEADING } from "../../packages/core/src/context/checkpoint.ts"
import { harnessOpen } from "../../packages/core/src/request/build.ts"
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"
import { evaluate, questionText, renderReport } from "./evaluate.ts"
import { GENERIC_SUMMARY, oracleModel } from "./fake.ts"
import { FACT_TYPES, type Fact, generateSession } from "./generate.ts"
import { gradeAnswer, hasNeedle, namesToken, normalize, parseJudgeReply } from "./grade.ts"
import { HistoryIndex } from "./history.ts"
import { type ModelFn, type ModelReply, capped } from "./model.ts"
import { STANDARD_TOOLS, buildContext, compact, render } from "./strategies.ts"
import { E2E_TIMEOUT_MS } from "../../packages/core/src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

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
    expect(full.tools).toEqual(STANDARD_TOOLS)

    const summary = buildContext("summary", session, compaction)
    expect(firstText(summary.input)).toStartWith(harnessOpen("compaction"))
    expect(firstText(summary.input)).not.toContain(INDEX_HEADING)

    const checkpoint = buildContext("checkpoint", session, compaction)
    const checkpointText = firstText(checkpoint.input)
    expect(checkpointText).toContain(INDEX_HEADING)
    expect(checkpointText).toContain(QUOTES_HEADING)
    expect(checkpointText).not.toContain("history_search")
    expect(checkpoint.tools).toEqual(STANDARD_TOOLS)

    const tools = buildContext("checkpoint+tools", session, compaction)
    expect(firstText(tools.input)).toContain(HISTORY_SENTENCE)
    expect(tools.tools.map((tool) => tool.name)).toEqual([...STANDARD_TOOLS.map((tool) => tool.name), "history_search", "history_read"])
    expect(tools.runTool!("history_search", '{"query":"ledger"}')).toContain("[seq ")
    expect(tools.runTool!("read", '{"path":"src/a.ts"}')).toStartWith("Error: read is not available")

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

describe("the engine strategy: the real engine, a real store, the real history tools", () => {
  const scratch: string[] = []
  afterAll(() => {
    for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
  })
  const place = () => {
    const directory = mkdtempSync(join(tmpdir(), "wl-recall-test-"))
    scratch.push(directory)
    return directory
  }

  test("the generated session loads as a valid log: every message in order, at rest, and the projection is what the log says", () => {
    const store = openSqliteStore({ path: ":memory:" })
    const id = "ses_loaded" as SessionId
    const tools = createStandardTools({ spillDir: "/nonexistent" })
    store.append(id, sessionEvents(session.messages, tools))
    const projection = expectRebuildEqualsLive(store, id)
    // The generator's messages, then the marker that the last step (a tool call) was stopped.
    expect(projection.messages.slice(0, session.messages.length).map((message) => [message.kind, message.id])).toEqual(session.messages.map((message) => [message.kind, message.id]))
    expect(projection.messages.slice(session.messages.length).map((message) => message.kind)).toEqual(["synthetic"])
    expect(projection.session).toMatchObject({ execution: null, open: null, compaction: null })
    // What the model would be sent is what the context strategies render, item for item, plus that marker.
    const request = buildRequest(projection, { toolChoice: "auto" })
    expect(request.input.slice(0, -1)).toEqual(render(session.messages))
    expect(request.tools.map((tool) => tool.name)).toEqual(["edit", "glob", "grep", "history_read", "history_search", "ls", "read", "shell", "todo", "write"])
    store.close()
  })

  test("the engine compacts the session once, and every question is answered in a fork of the compacted session through the loop", async () => {
    const model = oracleModel(session)
    const directory = place()
    const run = await runEngine({ session, model, question: questionText, directory })
    try {
      // The engine's own decision and its own checkpoint: the policy at a user-message boundary, a normal compaction, the model's summary.
      expect(run.compaction).toMatchObject({ trigger: "auto", mode: "normal", source: "model", detail: null, requests: 1 })
      expect(run.compaction.removedMessages).toBeGreaterThan(130)
      expect(run.compaction.tokensBefore).toBeGreaterThan(38_000)
      expect(run.compaction.tokensAfter).toBeLessThan(8_000)
      expect(run.compaction.checkpoint).toContain(GENERIC_SUMMARY)
      expect(run.compaction.checkpoint).toContain(INDEX_HEADING)
      expect(run.compaction.checkpoint).toContain(HISTORY_SENTENCE)
      // Twelve answers, each from its own fork: a search with the real tool, then the answer.
      expect(run.answers.map((answer) => [answer.requests, answer.toolCalls])).toEqual(session.facts.map(() => [2, 1]))
      for (const [index, fact] of session.facts.entries()) {
        const answer = run.answers[index]!
        expect(answer.factId).toBe(fact.id)
        expect(answer.answer).toBe(fact.gold)
        // What the tool returned is the engine's own rendering of a hit in a stored message.
        expect(answer.shown).toMatch(/\d+ messages? match(es)? .*; showing \d+, best first\.\n\[seq \d+/)
      }
      // The model was asked for one summary and for the questions, never for the reply to the message that set the compaction off.
      const summaries = model.requests.filter((request) => request.toolChoice === "none")
      expect(summaries).toHaveLength(1)
      expect(model.requests).toHaveLength(1 + 24)
      expect(JSON.stringify(summaries[0]!.input)).not.toContain(COMPACT_PROMPT)

      // The store holds the session and twelve forks of it, each at rest, each equal to its log.
      const store = openSqliteStore({ path: run.database })
      try {
        const sessions = store.listSessions().map((summary) => summary.session)
        expect(sessions).toHaveLength(13)
        const forks = sessions.filter((entry) => entry.lineage !== null)
        expect(forks).toHaveLength(12)
        for (const fork of forks) {
          expect(fork.lineage).toMatchObject({ parentSessionId: run.sessionId })
          expect(fork.rootId).toBe(run.sessionId)
          expect(fork.execution).toBeNull()
          expect(fork.compaction).toEqual(sessions.find((entry) => entry.id === run.sessionId)!.compaction)
        }
        // Every fork's first request is the compacted session's request plus the question: one cached prefix for all twelve.
        const first = forks.map((fork) => store.readRequests(fork.id)[0]!.blocks.map((block) => block.hash))
        const shared = first[0]!.slice(0, -1)
        for (const blocks of first) expect(blocks.slice(0, -1)).toEqual(shared)
        // And every request of the session and its forks can be rebuilt from the log, the summary request too.
        for (const entry of sessions) expect(exportSession(store, entry.id).unverified).toEqual([])
      } finally {
        store.close()
      }
    } finally {
      run.dispose()
    }
  }, 60_000)

  test("a summary the model cannot write still leaves a session the questions can be asked in", async () => {
    const model = oracleModel(session, { summary: "I cannot summarise this." })
    const run = await runEngine({ session, model, question: questionText })
    try {
      expect(run.compaction).toMatchObject({ source: "fallback", requests: 2 })
      expect(run.compaction.checkpoint).toContain("No summary of the earlier conversation could be produced")
      // The history tools still reach everything.
      expect(run.answers.filter((answer, index) => answer.answer === session.facts[index]!.gold)).toHaveLength(12)
    } finally {
      run.dispose()
    }
  }, 60_000)

  test("a spent request budget stops the run at once instead of being retried", async () => {
    const model = capped(oracleModel(session), 4)
    const started = performance.now()
    await expect(runEngine({ session, model, question: questionText })).rejects.toThrow("request budget of 4 spent")
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(model.used()).toBe(4)
  }, 60_000)

  test("evaluate reports it next to the others, with the engine's compaction and without a simulated one when none is needed", async () => {
    const model = oracleModel(session)
    const report = await evaluate({ session, compaction: null, model, cacheKey: "k", date: "2026-11-12", live: false, modelName: "fake", effort: "-", strategies: ["full", "engine"] })
    expect(report.strategies.map((strategy) => [strategy.name, strategy.recall, strategy.requests])).toEqual([
      ["full", 1, 12],
      ["engine", 1, 25],
    ])
    expect(report.summary).toBeNull()
    expect(report.engine).toMatchObject({ source: "model", mode: "normal" })
    expect(report.requests).toBe(12 + 25 + 1)
    expect(model.requests).toHaveLength(report.requests)
    const markdown = renderReport(report)
    expect(markdown).toContain("Engine compaction (engine): auto, normal")
    expect(markdown).toContain("| engine | 100% (12/12)")
    expect(markdown).not.toContain("Simulated compaction")
    // A context strategy that needs the simulated compaction says so when it was not made.
    await expect(evaluate({ session, compaction: null, model, cacheKey: "k", date: "d", live: false, modelName: "fake", effort: "-", strategies: ["checkpoint"] })).rejects.toThrow("needs the compaction")
  }, 60_000)
})

describe("evaluate", () => {
  test("asks every question per strategy, grades, judges in one request and reports", async () => {
    const model = oracleModel(session)
    const compaction = await compact(session, model, "k")
    const report = await evaluate({ session, compaction, model, cacheKey: "k", date: "2026-11-12", live: false, modelName: "fake", effort: "-", strategies: ["full", "summary", "checkpoint", "checkpoint+tools"] })
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
