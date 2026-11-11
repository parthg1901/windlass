/**
 * Replay end to end, without a model: a scripted session is stored as the
 * recording, read back as a tape, and replayed twice against a changed
 * system prompt. Once the model behaves exactly as recorded; once its third
 * step runs a different test command. Nothing is executed in either run: every
 * matched call is answered from the tape.
 *
 *   bun scripts/replay-demo.ts          plain-text reports
 *   bun scripts/replay-demo.ts --json   the reports as JSON as well
 */
import { text } from "../packages/core/src/content.ts"
import type { SessionId } from "../packages/core/src/id.ts"
import { type BuildRequest, renderReport, renderReportJson, responsesFromTape, runReplay, tapeFromStore } from "../packages/core/src/replay/index.ts"
import type { Tape } from "../packages/core/src/replay/tape.ts"
import type { InputItem } from "../packages/core/src/request/request.ts"
import { openSqliteStore } from "../packages/core/src/store/sqlite.ts"
import { FakeProvider, type ScriptItem, script } from "../packages/core/src/testing/fake-provider.ts"
import type { AnyTool, ToolEffect } from "../packages/core/src/tool/tool.ts"
import { severalSteps } from "../packages/core/test/scenarios/happy.ts"
import { allEvents } from "../packages/core/test/scenarios/script.ts"

const json = process.argv.includes("--json")

// The recording: the "several steps in one turn" scenario, appended to a real (in-memory) store.
const store = openSqliteStore({ path: ":memory:", now: () => 1_700_000_000_000 })
const sessionId = "ses_demo" as SessionId
store.append(sessionId, allEvents(severalSteps))
const tape = tapeFromStore(store, sessionId)
store.close()

console.log(`Recording ${sessionId}: ${severalSteps.title.toLowerCase()}, ${tape.steps.length} steps`)
for (const step of tape.steps) {
  const calls = step.calls.map((call) => `${call.name} ${call.input} -> ${JSON.stringify(call.settlement.output)}`)
  console.log(`  step ${step.index + 1}  ${calls.length > 0 ? calls.join("; ") : `answers ${JSON.stringify(step.text)}`}`)
}

// Tools are never run here (policy `stop`); the executor only needs their names and effect classes.
const tools = (["read", "write", "shell"] as const).map(
  (name): AnyTool => ({
    name,
    description: `The ${name} tool`,
    inputSchema: { type: "object" },
    effect: ({ read: "read", write: "write", shell: "exec" } as const satisfies Record<string, ToolEffect>)[name],
    execute: async () => {
      throw new Error(`${name} must not run during this replay`)
    },
  }),
)

// The changed harness: a new system prompt. The real request builder would render this; a stand-in does here.
const buildRequest: BuildRequest = (conversation, context) => ({
  params: { model: context.tape.settings.model, reasoningEffort: null, textVerbosity: null, parallelToolCalls: true, cacheKey: null },
  tools: context.tape.baseline?.tools ?? [],
  instructions: "You are a coding agent. Run the narrowest test that covers your change.",
  input: conversation.flatMap((entry): InputItem[] => {
    if (entry.kind === "output") return [entry.item]
    if (entry.input.kind === "message") return [{ type: "message", role: entry.input.from === "user" ? "user" : "developer", content: entry.input.content }]
    if (entry.input.kind === "instruction") return [{ type: "message", role: "developer", content: text(entry.input.text) }]
    return []
  }),
  toolChoice: "auto",
})

async function replay(title: string, recording: Tape, overrides: Record<number, readonly ScriptItem[]>) {
  const provider = new FakeProvider(responsesFromTape(recording, overrides))
  const run = await runReplay({ tape: recording, provider, buildRequest, replay: { tools } })
  console.log(`\n=== ${title} (${provider.calls.length} model calls) ===\n`)
  console.log(renderReport(run.report))
  if (json) console.log(`\n${renderReportJson(run.report)}`)
}

await replay("Replay 1: the model behaves as recorded", tape, {})
await replay("Replay 2: the third step runs a narrower test", tape, {
  2: [
    script.text("Run only the changed test."),
    script.toolCall("call_1", "shell", { command: "bun test a.test.ts" }),
    script.usage({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 60, reasoningTokens: 12 }),
  ],
})
