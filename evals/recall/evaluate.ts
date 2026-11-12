/**
 * The evaluation loop. For each strategy, every question is asked in a fresh
 * request made of the strategy's context plus the question; the strategy with
 * history tools may make one round of tool calls (several in parallel) before
 * it must answer. The `engine` strategy is not asked here: the real engine
 * compacts the session in a real store and answers each question through its
 * own loop (`engine.ts`). Answers are graded without a model where possible;
 * the rest go to one batched judge request at the end.
 */
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"
import { type FactType, FACT_TYPES, type GeneratedSession, type Position } from "./generate.ts"
import { type JudgeItem, gradeAnswer, hasNeedle, judgePrompt, parseJudgeReply } from "./grade.ts"
import { type EngineCompaction, runEngine } from "./engine.ts"
import type { ModelFn } from "./model.ts"
import { type Compaction, EVAL_INSTRUCTIONS, STRATEGIES, type StrategyContext, type StrategyName, buildContext, params, user } from "./strategies.ts"

export const JUDGE_INSTRUCTIONS = "You are a strict, fair grader. Reply with JSON only."

/** Tool rounds the history strategy may use per question before it must answer. */
export const MAX_TOOL_ROUNDS = 1

export function questionText(question: string) {
  return `Quick question before you continue: ${question} Answer in one or two sentences, with exact names, paths, commands and values. If you cannot tell from what you have, say so.`
}

export interface AnswerRecord {
  readonly factId: string
  readonly type: FactType
  readonly position: Position
  readonly answer: string
  readonly pass: boolean
  readonly judged: boolean
  /** Whether every exact needle of the gold answer was present in what the model was shown (context and tool results). */
  readonly present: boolean
  readonly toolCalls: number
  /** Measured input tokens of the first request for this question, when the model reported them. */
  readonly inputTokens: number | null
  /** Of those, how many the provider read from its prompt cache, when it said. */
  readonly cachedTokens: number | null
  readonly requests: number
}

export interface StrategyResult {
  readonly name: StrategyName
  readonly contextTokens: number
  readonly answers: readonly AnswerRecord[]
  readonly recall: number
  readonly presence: number
  readonly byType: Readonly<Partial<Record<FactType, { pass: number; total: number }>>>
  readonly byPosition: Readonly<Record<Position, { pass: number; total: number }>>
  readonly meanInputTokens: number | null
  /** How many questions' first request read something from the prompt cache, of those that reported usage. */
  readonly cacheHits: { readonly hit: number; readonly of: number }
  readonly requests: number
}

export interface Report {
  readonly date: string
  readonly model: string
  readonly effort: string
  readonly live: boolean
  readonly session: {
    readonly seed: number
    readonly messages: number
    readonly tokens: number
    readonly removedMessages: number
    readonly removedTokens: number
    readonly keptTokens: number
    readonly facts: number
  }
  /** The simulated compaction the context strategies share; `null` when none of them ran. */
  readonly summary: { readonly tokens: number; readonly valid: boolean; readonly problems: readonly string[]; readonly requests: number } | null
  /** What the engine's own compaction did, when the `engine` strategy ran. */
  readonly engine: Omit<EngineCompaction, "checkpoint"> | null
  readonly strategies: readonly StrategyResult[]
  readonly judgeRequests: number
  readonly requests: number
}

export interface EvaluateOptions {
  readonly session: GeneratedSession
  /** The simulated compaction, for the strategies that need it; `null` when only `full` and `engine` run. */
  readonly compaction: Compaction | null
  readonly model: ModelFn
  readonly strategies?: readonly StrategyName[]
  readonly cacheKey: string
  readonly date: string
  readonly live: boolean
  readonly modelName: string
  readonly effort: string
  /** Waits between questions of one strategy, in milliseconds: a prompt-cache entry is not readable the moment it was written. Default 0. */
  readonly pauseMs?: number
  /** Where the engine strategy keeps its session store (kept for a trace export). Default: a temporary directory that is removed. */
  readonly engineDirectory?: string
}

export async function evaluate(options: EvaluateOptions): Promise<Report> {
  const session = options.session
  const pending: (JudgeItem & { strategy: StrategyName })[] = []
  const raw: { name: StrategyName; contextTokens: number; answers: AnswerRecord[]; extraRequests: number }[] = []
  let engine: EngineCompaction | null = null
  /** Grades one answer and files it; judged ones wait for the batched judge. */
  const record = (name: StrategyName, fact: (typeof session.facts)[number], asked: { answer: string; shown: string; toolCalls: number; inputTokens: number | null; cachedTokens: number | null; requests: number }): AnswerRecord => {
    const verdict = gradeAnswer(fact, asked.answer)
    if (verdict.kind === "judge") pending.push({ id: `${name}/${fact.id}`, strategy: name, question: fact.question, gold: fact.gold, rubric: verdict.rubric, answer: asked.answer })
    const needles = fact.rule.kind === "contains" ? fact.rule.all : fact.rule.mustContain
    return {
      factId: fact.id,
      type: fact.type,
      position: fact.position,
      answer: asked.answer,
      pass: verdict.kind === "pass",
      judged: verdict.kind === "judge",
      present: needles.every((needle) => hasNeedle(asked.shown, needle)),
      toolCalls: asked.toolCalls,
      inputTokens: asked.inputTokens,
      cachedTokens: asked.cachedTokens,
      requests: asked.requests,
    }
  }
  for (const name of options.strategies ?? STRATEGIES) {
    if (name === "engine") {
      // The product: a real store, the engine's compaction, the real history tools.
      const run = await runEngine({
        session,
        model: options.model,
        question: questionText,
        ...(options.engineDirectory === undefined ? {} : { directory: options.engineDirectory }),
        // Progress, as counts and the ungraded verdict only: a run that is stopped early still says how far it got.
        onAnswer: (answer) => {
          if (!options.live) return
          const verdict = gradeAnswer(session.facts.find((fact) => fact.id === answer.factId)!, answer.answer).kind
          process.stderr.write(`engine ${answer.factId}: ${verdict}, ${answer.requests} request(s), ${answer.toolCalls} tool call(s)\n`)
        },
      })
      engine = run.compaction
      const answers = run.answers.map((answer) => record(name, session.facts.find((fact) => fact.id === answer.factId)!, answer))
      run.dispose()
      raw.push({ name, contextTokens: run.compaction.contextTokens, answers, extraRequests: run.compaction.requests })
      continue
    }
    const context = buildContext(name, session, options.compaction)
    const answers: AnswerRecord[] = []
    for (const [index, fact] of session.facts.entries()) {
      if (index > 0 && (options.pauseMs ?? 0) > 0) await Bun.sleep(options.pauseMs!)
      answers.push(record(name, fact, await ask(options.model, context, questionText(fact.question), `${options.cacheKey}-${name}`)))
    }
    raw.push({ name, contextTokens: context.contextTokens, answers, extraRequests: 0 })
  }

  let judgeRequests = 0
  const grades = new Map<string, boolean>()
  if (pending.length > 0) {
    judgeRequests = 1
    const reply = await options.model({
      params: params(`${options.cacheKey}-judge`),
      tools: [],
      instructions: JUDGE_INSTRUCTIONS,
      input: [user(judgePrompt(pending))],
      toolChoice: "none",
    })
    for (const [id, pass] of parseJudgeReply(reply.text, pending)) grades.set(id, pass)
  }

  const strategies = raw.map(({ name, contextTokens, answers, extraRequests }) => {
    const graded = answers.map((answer) => (answer.judged ? { ...answer, pass: grades.get(`${name}/${answer.factId}`) === true } : answer))
    return summarise(name, contextTokens, graded, extraRequests)
  })
  const simulated = options.compaction
  return {
    date: options.date,
    model: options.modelName,
    effort: options.effort,
    live: options.live,
    session: {
      seed: session.seed,
      messages: session.messages.length,
      tokens: session.tokens,
      removedMessages: simulated?.removed.length ?? 0,
      removedTokens: simulated?.tail.removedTokens ?? 0,
      keptTokens: simulated?.tail.keptTokens ?? 0,
      facts: session.facts.length,
    },
    summary:
      simulated === null
        ? null
        : {
            tokens: simulated.check.tokens,
            valid: simulated.check.ok,
            problems: simulated.check.ok ? [] : simulated.check.problems.map((problem) => problem.kind),
            requests: simulated.requests,
          },
    engine: engine === null ? null : withoutCheckpoint(engine),
    strategies,
    judgeRequests,
    requests: (simulated?.requests ?? 0) + strategies.reduce((sum, strategy) => sum + strategy.requests, 0) + judgeRequests,
  }
}

function withoutCheckpoint(compaction: EngineCompaction): Omit<EngineCompaction, "checkpoint"> {
  const { checkpoint: _, ...rest } = compaction
  return rest
}

/** One question in a fresh request; with history tools, one round of calls first. */
async function ask(model: ModelFn, context: StrategyContext, question: string, cacheKey: string) {
  const base = (input: readonly InputItem[], toolChoice: ModelRequest["toolChoice"]): ModelRequest => ({
    params: params(cacheKey),
    tools: context.tools,
    instructions: EVAL_INSTRUCTIONS,
    input,
    toolChoice,
  })
  let input: InputItem[] = [...context.input, user(question)]
  let reply = await model(base(input, context.runTool === null ? "none" : "auto"))
  const inputTokens = reply.usage?.inputTokens ?? null
  const cachedTokens = reply.usage?.cachedInputTokens ?? null
  let requests = 1
  let toolCalls = 0
  for (let round = 0; round < MAX_TOOL_ROUNDS && context.runTool !== null && reply.calls.length > 0; round += 1) {
    const results = reply.calls.map((call): InputItem => ({ type: "tool_result", callId: call.callId, output: context.runTool!(call.name, call.input), attachments: [] }))
    toolCalls += reply.calls.length
    input = [...input, ...reply.output, ...results]
    // The last round forbids tools, so the model has to answer.
    reply = await model(base(input, round + 1 >= MAX_TOOL_ROUNDS ? "none" : "auto"))
    requests += 1
  }
  const shown = input.map(itemText).join("\n")
  return { answer: reply.error === null ? reply.text : `[error: ${reply.error}]`, toolCalls, inputTokens, cachedTokens, requests, shown }
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

function summarise(name: StrategyName, contextTokens: number, answers: readonly AnswerRecord[], extraRequests: number): StrategyResult {
  const share = (list: readonly AnswerRecord[], key: "pass" | "present") => (list.length === 0 ? 0 : list.filter((answer) => answer[key]).length / list.length)
  const count = (list: readonly AnswerRecord[]) => ({ pass: list.filter((answer) => answer.pass).length, total: list.length })
  const measured = answers.flatMap((answer) => (answer.inputTokens === null ? [] : [answer.inputTokens]))
  return {
    name,
    contextTokens,
    answers,
    recall: share(answers, "pass"),
    presence: share(answers, "present"),
    byType: Object.fromEntries(
      FACT_TYPES.filter((type) => answers.some((answer) => answer.type === type)).map((type) => [type, count(answers.filter((answer) => answer.type === type))]),
    ),
    byPosition: {
      early: count(answers.filter((answer) => answer.position === "early")),
      middle: count(answers.filter((answer) => answer.position === "middle")),
      late: count(answers.filter((answer) => answer.position === "late")),
    },
    meanInputTokens: measured.length === 0 ? null : Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length),
    cacheHits: { hit: answers.filter((answer) => (answer.cachedTokens ?? 0) > 0).length, of: answers.filter((answer) => answer.cachedTokens !== null).length },
    requests: answers.reduce((sum, answer) => sum + answer.requests, 0) + extraRequests,
  }
}

/** The report as Markdown tables. */
export function renderReport(report: Report): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`
  const cell = (value: { pass: number; total: number } | undefined) => (value === undefined || value.total === 0 ? "-" : `${value.pass}/${value.total}`)
  const lines = [
    `Date ${report.date}; model \`${report.model}\`, effort \`${report.effort}\`; ${report.live ? "live" : "scripted fake model"}.`,
    `Session: seed ${report.session.seed}, ${report.session.messages} messages, about ${report.session.tokens} tokens of history. ${report.session.facts} questions.`,
    ...(report.summary === null
      ? []
      : [
          `Simulated compaction (summary, checkpoint, checkpoint+tools): removes ${report.session.removedMessages} messages (about ${report.session.removedTokens} tokens), keeps about ${report.session.keptTokens} tokens verbatim; summary of about ${report.summary.tokens} tokens, ${report.summary.valid ? "valid" : `invalid (${report.summary.problems.join(", ")})`}, ${report.summary.requests} request(s).`,
        ]),
    ...(report.engine === null
      ? []
      : [
          `Engine compaction (engine): ${report.engine.trigger}, ${report.engine.mode}; removes ${report.engine.removedMessages} messages; about ${report.engine.tokensBefore} → ${report.engine.tokensAfter} tokens; summary source \`${report.engine.source}\`${report.engine.detail === null ? "" : ` (${report.engine.detail})`}, ${report.engine.requests} request(s).`,
        ]),
    "",
    "| Strategy | Recall | Early | Middle | Late | Gold present in what the model saw | Context tokens (estimated) | Input tokens per question (measured) | Questions that read from the cache | Tool calls | Requests |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.strategies.map(
      (strategy) =>
        `| ${strategy.name} | ${pct(strategy.recall)} (${strategy.answers.filter((answer) => answer.pass).length}/${strategy.answers.length}) | ${cell(strategy.byPosition.early)} | ${cell(strategy.byPosition.middle)} | ${cell(strategy.byPosition.late)} | ${pct(strategy.presence)} | ${strategy.contextTokens} | ${strategy.meanInputTokens ?? "-"} | ${strategy.cacheHits.of === 0 ? "-" : `${strategy.cacheHits.hit}/${strategy.cacheHits.of}`} | ${strategy.answers.reduce((sum, answer) => sum + answer.toolCalls, 0)} | ${strategy.requests} |`,
    ),
    "",
    `| Fact type | ${report.strategies.map((strategy) => strategy.name).join(" | ")} |`,
    `| --- | ${report.strategies.map(() => "---").join(" | ")} |`,
    ...FACT_TYPES.filter((type) => report.strategies.some((strategy) => strategy.byType[type] !== undefined)).map(
      (type) => `| ${type} | ${report.strategies.map((strategy) => cell(strategy.byType[type])).join(" | ")} |`,
    ),
    "",
    `Requests: ${report.requests} in total (simulated summary ${report.summary?.requests ?? 0}, strategies ${report.strategies.reduce((sum, strategy) => sum + strategy.requests, 0)}, judge ${report.judgeRequests}).`,
  ]
  return lines.join("\n")
}
