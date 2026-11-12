// The compaction recall evaluation.
//
//   bun evals/recall/run.ts                      scripted fake model: checks the pipeline, spends nothing
//   bun evals/recall/run.ts --live               the real provider (ChatGPT sign-in), gpt-6-luna at low effort
//   options: --seed N (default 7), --tokens N (default 40000), --questions N (default 12),
//            --strategies a,b (default: all five; `full,engine` compares the ceiling with the product),
//            --out FILE (write the report as JSON), --max-requests N (default 110),
//            --pause MS (wait between the questions of a context strategy, default 0),
//            --keep DIR (keep the engine strategy's session store there, for a trace export)
//
// A live run of the four context strategies makes at most 1-2 summary requests, 12 per strategy
// without tools, up to 24 for the strategy with tools, and one judge request: 63 at most. The
// engine strategy adds 1-2 summary requests and up to 3 per question (two rounds of history tools,
// then the answer). Plus one retry per failed call, all within --max-requests. Every one spends the
// project owner's ChatGPT plan allowance. Nothing here prints, logs or writes a token or a header.

import { evaluate, renderReport } from "./evaluate.ts"
import { oracleModel } from "./fake.ts"
import { generateSession } from "./generate.ts"
import { LIVE_EFFORT, LIVE_MODEL, capped, liveModel, retryOnce } from "./model.ts"
import { STRATEGIES, type StrategyName, compact, needsSummary } from "./strategies.ts"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : Number(args[index + 1])
}
const text = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined)
const out = text("out")
const strategies = (text("strategies")?.split(",") ?? [...STRATEGIES]) as StrategyName[]
for (const name of strategies) if (!STRATEGIES.includes(name)) throw new Error(`no strategy named ${name}; there are ${STRATEGIES.join(", ")}`)

const live = flag("live")
const session = generateSession({ seed: option("seed", 7), tokens: option("tokens", 40_000), facts: option("questions", 12) })
const model = live ? retryOnce(capped(await liveModel(), option("max-requests", 110))) : capped(oracleModel(session), option("max-requests", 110))
// One cache key per run, so requests that share a prefix share the provider's cache.
const cacheKey = `recall-${crypto.randomUUID()}`

// The simulated compaction is asked for only when a strategy shows it.
const compaction = strategies.some(needsSummary) ? await compact(session, model, cacheKey) : null
const keep = text("keep")
const report = await evaluate({
  session,
  compaction,
  model,
  strategies,
  pauseMs: option("pause", 0),
  ...(keep === undefined ? {} : { engineDirectory: keep }),
  cacheKey,
  date: new Date().toISOString().slice(0, 10),
  live,
  modelName: live ? LIVE_MODEL : "oracle fake",
  effort: live ? LIVE_EFFORT : "-",
})
console.log(renderReport(report))

if (out !== undefined) await Bun.write(out, `${JSON.stringify({ report, summary: compaction?.summary ?? null }, null, 2)}\n`)
