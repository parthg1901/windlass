/**
 * Runs one prompt through the step loop and prints its event stream.
 *
 *   bun scripts/engine-demo.ts                      the scripted provider: a read, an edit, an answer
 *   bun scripts/engine-demo.ts --live               then the same loop against the real model (needs a sign-in)
 *
 * Options for the live run (each live step is one request on the signed-in ChatGPT plan):
 *   --model <slug>        default gpt-6-luna
 *   --effort <level>      default low
 *   --prompt "<text>"     default: a tiny task in the temporary workspace
 *   --cwd <dir>           work in this directory instead of a temporary workspace
 *   --max-steps <n>       default 8
 *   --only-live           skip the scripted run
 *
 * Both runs use a store in a temporary directory, which is removed afterwards.
 * Durable events are printed with their `seq`; streamed deltas are collected
 * and shown once, when the item they belong to ends.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accessToken } from "../packages/core/src/auth/chatgpt.ts"
import { brand } from "../packages/core/src/brand.ts"
import { type EngineEvent, type Provider, OpenAIResponsesProvider, createEngine, createStandardTools, openSqliteStore } from "../packages/core/src/index.ts"
import { FakeProvider, script } from "../packages/core/src/testing/fake-provider.ts"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const cut = (text: string, max = 100) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** One line per durable event; `null` for deltas, which are counted instead. */
function describe(item: EngineEvent): string | null {
  if (!("seq" in item)) return null
  const head = `${String(item.seq).padStart(3)}  ${item.type}`
  switch (item.type) {
    case "session.created":
      return `${head}  ${item.data.settings.model} effort=${item.data.settings.reasoningEffort ?? "default"} cwd=${item.data.cwd}`
    case "baseline.set":
      return `${head}  ${item.data.instructions.length} chars of instructions, tools: ${item.data.tools.map((tool) => tool.name).join(" ")}`
    case "inbox.enqueued":
      return `${head}  ${item.data.delivery} "${cut(item.data.content.map((part) => (part.type === "text" ? part.text : "[media]")).join(""))}"`
    case "instruction.appended":
      return `${head}  source=${item.data.source}`
    case "synthetic.appended":
      return `${head}  origin=${item.data.origin} "${cut(item.data.content.map((part) => (part.type === "text" ? part.text : "[media]")).join(""))}"`
    case "step.started":
      return `${head}  attempt=${item.data.attempt} model=${item.data.model}`
    case "text.ended":
    case "reasoning.ended":
      return `${head}  "${cut(item.data.text)}"`
    case "tool.called":
      return `${head}  ${item.data.name} ${cut(item.data.input, 80)}`
    case "tool.started":
      return `${head}  ${item.data.callId} effect=${item.data.effect}`
    case "tool.settled":
      return `${head}  ${item.data.callId} ${item.data.outcome} "${cut(item.data.output, 70)}"`
    case "step.ended": {
      const usage = item.data.usage
      return `${head}  finish=${item.data.finish}${usage === null ? "" : `  tokens in=${usage.inputTokens} cached=${usage.cachedInputTokens} out=${usage.outputTokens}`}`
    }
    case "step.failed":
      return `${head}  ${item.data.error.kind === "provider" ? `provider:${item.data.error.error.kind} ${cut(item.data.error.error.message, 80)}` : JSON.stringify(item.data.error)}`
    case "retry.scheduled":
      return `${head}  attempt=${item.data.attempt} in ${item.data.delayMs} ms after ${item.data.error.kind}`
    case "execution.failed":
      return `${head}  "${cut(item.data.message)}"`
    case "execution.interrupt_requested":
    case "execution.interrupted":
      return `${head}  ${item.data.reason}`
    default:
      return head
  }
}

async function run(title: string, provider: Provider, options: { cwd: string; model: string; effort: string | null; prompt: string; maxSteps: number }) {
  const directory = mkdtempSync(join(tmpdir(), `${brand.binary}-engine-demo-`))
  const store = openSqliteStore({ path: join(directory, "sessions.db") })
  const engine = createEngine({ store, provider, tools: createStandardTools({ spillDir: join(directory, "spill") }), dataDir: directory })
  const session = engine.createSession({ cwd: options.cwd, settings: { model: options.model, reasoningEffort: options.effort } })
  console.log(`\n== ${title} ==`)
  console.log(`prompt: ${options.prompt}\n`)
  const started = Date.now()
  let deltas = 0
  const printing = (async () => {
    for await (const item of session.events) {
      const line = describe(item)
      if (line === null) deltas += 1
      else console.log(line)
    }
  })()
  // Ctrl-C stops the turn as the user; the loop winds down and the claim is released.
  const onInterrupt = () => session.interrupt()
  process.on("SIGINT", onInterrupt)
  session.send(options.prompt, { maxSteps: options.maxSteps })
  await session.settled()
  process.off("SIGINT", onInterrupt)
  await engine.close()
  await printing

  const steps = store.readRequests(session.id)
  console.log(`\n${steps.length} model request(s), ${deltas} streamed delta(s), ${((Date.now() - started) / 1000).toFixed(1)} s`)
  for (const [index, row] of steps.entries()) {
    const usage = row.usage
    const share = usage === null || usage.inputTokens === 0 ? "-" : `${Math.round((100 * usage.cachedInputTokens) / usage.inputTokens)}%`
    console.log(
      `  request ${index + 1}: ${row.purpose} attempt ${row.attempt} ${row.outcome}${row.errorKind === null ? "" : ` (${row.errorKind})`}, ${row.blocks.length} blocks` +
        (usage === null ? "" : `, input ${usage.inputTokens} (cached ${usage.cachedInputTokens}, ${share}), output ${usage.outputTokens}`),
    )
  }
  store.close()
  rmSync(directory, { recursive: true, force: true })
}

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), `${brand.binary}-engine-demo-ws-`))
  mkdirSync(join(directory, "src"))
  writeFileSync(join(directory, "src", "greet.ts"), 'export function greet(name: string) {\n  return "Hello, " + name\n}\n')
  writeFileSync(join(directory, "README.md"), "# demo\n\nA tiny workspace for the engine demo.\n")
  return directory
}

const PROMPT = "In src/greet.ts, make greet end its greeting with an exclamation mark. Then tell me the new return line."

if (!flag("--only-live")) {
  const cwd = workspace()
  const scripted = new FakeProvider([
    [script.reasoning("Read the file first."), script.toolCall("call_1", "read", { path: "src/greet.ts" }), script.usage({ inputTokens: 1200, outputTokens: 30 })],
    [
      script.toolCall("call_1", "edit", { path: "src/greet.ts", old_string: '"Hello, " + name', new_string: '"Hello, " + name + "!"' }),
      script.usage({ inputTokens: 1300, cachedInputTokens: 1200, outputTokens: 40 }),
    ],
    [script.text('Done. The return line is now `return "Hello, " + name + "!"`.'), script.usage({ inputTokens: 1400, cachedInputTokens: 1300, outputTokens: 20 })],
  ])
  await run("scripted provider", scripted, { cwd, model: "gpt-scripted", effort: null, prompt: PROMPT, maxSteps: 8 })
  console.log(`\nsrc/greet.ts after the run:\n${readFileSync(join(cwd, "src", "greet.ts"), "utf8")}`)
  rmSync(cwd, { recursive: true, force: true })
}

if (flag("--live") || flag("--only-live")) {
  const given = value("--cwd")
  const cwd = given ?? workspace()
  // The provider reads media from the session's own store; this demo sends none.
  const provider = new OpenAIResponsesProvider({
    accessToken,
    readBlob: () => {
      throw new Error("the demo sends no media")
    },
  })
  await run("real model", provider, {
    cwd,
    model: value("--model") ?? "gpt-6-luna",
    effort: value("--effort") ?? "low",
    prompt: value("--prompt") ?? PROMPT,
    maxSteps: Number(value("--max-steps") ?? 8),
  })
  if (given === undefined) {
    console.log(`\nsrc/greet.ts after the run:\n${readFileSync(join(cwd, "src", "greet.ts"), "utf8")}`)
    rmSync(cwd, { recursive: true, force: true })
  }
}
