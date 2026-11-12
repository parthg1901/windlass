// The compaction recall evaluation.
//
//   bun evals/recall/run.ts                      scripted fake model: checks the pipeline, spends nothing
//   bun evals/recall/run.ts --live               the real provider (ChatGPT sign-in), gpt-6-luna at low effort
//   options: --seed N (default 7), --tokens N (default 40000), --questions N (default 12),
//            --out FILE (write the report as JSON), --max-requests N (default 66)
//
// A live run of the defaults makes at most 1-2 summary requests, 12 per strategy without tools,
// up to 24 for the strategy with tools, and one judge request: 63 at most. Every one spends the
// project owner's ChatGPT plan allowance. Nothing here prints, logs or writes a token or a header.

import { evaluate, renderReport } from "./evaluate.ts"
import { oracleModel } from "./fake.ts"
import { generateSession } from "./generate.ts"
import { LIVE_EFFORT, LIVE_MODEL, capped, liveModel } from "./model.ts"
import { compact } from "./strategies.ts"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : Number(args[index + 1])
}
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined

const live = flag("live")
const session = generateSession({ seed: option("seed", 7), tokens: option("tokens", 40_000), facts: option("questions", 12) })
const model = capped(live ? await liveModel() : oracleModel(session), option("max-requests", 66))
// One cache key per run, so requests that share a prefix share the provider's cache.
const cacheKey = `recall-${crypto.randomUUID()}`

const compaction = await compact(session, model, cacheKey)
const report = await evaluate({
  session,
  compaction,
  model,
  cacheKey,
  date: new Date().toISOString().slice(0, 10),
  live,
  modelName: live ? LIVE_MODEL : "oracle fake",
  effort: live ? LIVE_EFFORT : "-",
})
console.log(renderReport(report))
console.log(`requests made: ${model.used()}`)
if (out !== undefined) await Bun.write(out, `${JSON.stringify({ report, summary: compaction.summary }, null, 2)}\n`)
