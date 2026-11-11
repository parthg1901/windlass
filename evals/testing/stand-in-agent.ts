#!/usr/bin/env bun
/**
 * A scripted stand-in for the CLI, so the agent runner can be tested before the real engine exists. It takes the
 * CLI's own arguments (parsed by the CLI's parser), writes a plausible `--json` event stream built from the core
 * event types, and behaves as `STAND_IN_MODE` says:
 *
 * - `solve`   (default) finds the task whose prompt it was given, applies its reference solution, succeeds.
 * - `nothing` answers without touching the workspace, succeeds.
 * - `hang`    starts a step and waits; on SIGINT it stops like the CLI does (step failed, execution interrupted, 130).
 * - `stubborn` like `hang`, but ignores SIGINT, so only a kill stops it.
 * - `crash`   starts a tool call and exits with `STAND_IN_EXIT` (default 3) without ending the execution.
 * - `replay`  writes the lines of the file named by `STAND_IN_EVENTS` verbatim and exits with `STAND_IN_EXIT` (default 0).
 * - `scripted` writes the scripted trace session named by `STAND_IN_SCRIPT` (packages/core/test/trace/sessions.ts) into
 *   the CLI's real session database under `XDG_DATA_HOME`, the way the step loop would, and prints its events. With
 *   `STAND_IN_BUILDER=broken` the requests are built with a builder that stamps the call number into the
 *   instructions, so the ledger holds hashes the exporter cannot rebuild.
 *
 * With `--session <id>` (a later turn of a multi-turn task) the stand-in continues that session: in `solve` mode it
 * applies the reference solution only on the task's last prompt and just answers the earlier ones.
 *
 *   STAND_IN_MODE=solve bun evals/testing/stand-in-agent.ts --json --cwd <dir> -- <prompt>
 */
import { join } from "node:path"
import { type CallId, type EventType, type ExecutionId, type MessageId, type NewEvent, type SessionId, type EventData, event, text } from "../../packages/core/src/index.ts"
import type { EngineEvent } from "../../packages/cli/src/engine.ts"
import { parseArgs } from "../../packages/cli/src/args.ts"
import { TASKS_DIR, applySolution, listTasks, loadTask } from "../run-check.ts"
import { sessionDatabase } from "../classify.ts"

const parsed = parseArgs(process.argv.slice(2))
if (parsed.kind !== "run" || parsed.options.output !== "json" || parsed.options.prompt === null || parsed.options.cwd === null) {
  process.stderr.write("stand-in: needs --json --cwd <dir> and a prompt\n")
  process.exit(2)
}
const options = parsed.options
const cwd = options.cwd!
const prompt = options.prompt!
const mode = process.env.STAND_IN_MODE ?? "solve"
const exitWith = Number(process.env.STAND_IN_EXIT ?? (mode === "crash" ? 3 : 0))

const sessionId = (options.session ?? "ses_standin") as SessionId
const executionId = `exe_standin${options.session === null ? "" : `_${process.pid}`}` as ExecutionId
const position = { seq: 0 }
const emit = (item: EngineEvent) => process.stdout.write(`${JSON.stringify(item)}\n`)
const durable = <T extends EventType>(type: T, data: EventData<T>) => {
  position.seq += 1
  emit({ ...(event(type, data) as NewEvent), sessionId, seq: position.seq, time: Date.now() } as EngineEvent)
}
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens, outputTokens, reasoningTokens: 0 })
const model = options.model ?? "stand-in-model"
// A later turn gets its own IDs, so the runner sees its calls and steps as new ones.
const turnTag = options.session === null ? "" : `_${process.pid}`
const user = `msg_user${turnTag}` as MessageId
const step1 = `msg_step1${turnTag}` as MessageId
const step2 = `msg_step2${turnTag}` as MessageId

if (mode === "replay") {
  process.stdout.write(await Bun.file(process.env.STAND_IN_EVENTS ?? "").text())
  process.exit(exitWith)
}

if (mode === "scripted") {
  await scripted(process.env.STAND_IN_SCRIPT ?? "multi-step turns", process.env.STAND_IN_BUILDER === "broken")
  process.exit(exitWith)
}

const resumed = options.session !== null
if (!resumed) durable("session.created", { cwd, title: null, lineage: null, settings: { model, reasoningEffort: null } })
durable("inbox.enqueued", { messageId: user, origin: null, delivery: "steer", content: text(prompt) })
durable("execution.started", { executionId })
durable("baseline.set", {
  instructions: "You are a stand-in agent.",
  tools: [{ name: "shell", description: "Run a command", inputSchema: { type: "object" } }],
  sources: [],
})
durable("inbox.delivered", { messageId: user })
durable("step.started", { messageId: step1, attempt: 1, model })

if (mode === "hang" || mode === "stubborn") {
  emit({ type: "reasoning.delta", sessionId, messageId: step1, text: "Thinking about it" })
  process.on("SIGINT", () => {
    if (mode === "stubborn") return
    durable("step.failed", { messageId: step1, error: { kind: "interrupted", reason: "user" }, usage: null })
    durable("execution.interrupted", { executionId, reason: "user" })
    process.exit(130)
  })
  setInterval(() => {}, 60_000)
} else if (mode === "crash") {
  durable("tool.called", { messageId: step1, callId: "call_1" as CallId, name: "shell", input: '{"command":"bun test"}', providerData: null })
  durable("tool.started", { messageId: step1, callId: "call_1" as CallId, effect: "exec" })
  process.stderr.write("stand-in: simulated crash\n")
  process.exit(exitWith)
} else {
  const call = "call_1" as CallId
  const solving = mode === "solve"
  const command = solving ? "apply the reference solution" : "ls"
  emit({ type: "tool.input.delta", sessionId, messageId: step1, callId: call, name: "shell", input: `{"command":"${command}"}` })
  durable("tool.called", { messageId: step1, callId: call, name: "shell", input: JSON.stringify({ command }), providerData: null })
  durable("tool.started", { messageId: step1, callId: call, effect: solving ? "exec" : "read" })
  const output = solving ? await solve() : "(listing)"
  durable("tool.settled", { messageId: step1, callId: call, outcome: "success", output, truncation: null, attachments: [], display: null })
  durable("step.ended", { messageId: step1, finish: "tool_calls", usage: usage(1200, 0, 80) })
  durable("step.started", { messageId: step2, attempt: 1, model })
  // One transient failure before any output of the second step, so retries show up in the metrics.
  durable("retry.scheduled", {
    messageId: step2,
    attempt: 2,
    delayMs: 0,
    error: { kind: "rate_limit", retryable: true, message: "slow down", status: 429, code: null, retryAfterMs: null, requestId: null },
  })
  durable("step.started", { messageId: step2, attempt: 2, model })
  emit({ type: "text.delta", sessionId, messageId: step2, text: "Done." })
  durable("text.ended", { messageId: step2, text: solving ? "Done." : "I looked around and changed nothing.", providerData: null })
  durable("step.ended", { messageId: step2, finish: "stop", usage: usage(1400, 1152, 40) })
  durable("execution.succeeded", { executionId, verification: { status: "not_configured" } })
  process.exit(exitWith)
}

/** Applies the reference solution of the task whose (last) prompt this is. An earlier prompt of a multi-turn task is only answered. */
async function solve() {
  const ids = await listTasks()
  const tasks = await Promise.all(ids.map((id) => loadTask(id)))
  const task = tasks.find((candidate) => candidate.prompts.includes(prompt))
  if (!task) throw new Error(`stand-in: no task in ${join(TASKS_DIR)} has this prompt`)
  if (task.prompts.at(-1) !== prompt) return `noted turn ${task.prompts.indexOf(prompt) + 1} of ${task.id}`
  await applySolution(task.id, cwd)
  return `applied the reference solution of ${task.id}`
}

/** Records a scripted trace session in the real session database and prints its log as the CLI's `--json` would. */
async function scripted(name: string, broken: boolean) {
  const { mkdirSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  const { openSqliteStore } = await import("../../packages/core/src/store/sqlite.ts")
  const { buildRequest } = await import("../../packages/core/src/request/build.ts")
  const { Loop, SCRIPTS, fixedClock } = await import("../../packages/core/test/trace/sessions.ts")
  const script = SCRIPTS.find((candidate) => candidate.name === name)
  if (!script) throw new Error(`stand-in: no scripted session ${name}`)
  const path = sessionDatabase()
  mkdirSync(dirname(path), { recursive: true })
  const store = openSqliteStore({ path, now: fixedClock() })
  const calls = { count: 0 }
  const builder: typeof buildRequest = (projection, buildOptions) => {
    const request = buildRequest(projection, buildOptions)
    calls.count += 1
    return { ...request, instructions: `${request.instructions}\nCall ${calls.count}.` }
  }
  const loop = new Loop(store, `ses_${name.replace(/[^a-z]+/g, "_")}_${process.pid}` as SessionId, broken ? builder : undefined)
  script.run(loop)
  for (const stored of store.readEvents(loop.id)) process.stdout.write(`${JSON.stringify(stored)}\n`)
  store.close()
}
