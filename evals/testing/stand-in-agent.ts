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
 *
 *   STAND_IN_MODE=solve bun evals/testing/stand-in-agent.ts --json --cwd <dir> -- <prompt>
 */
import { join } from "node:path"
import { type CallId, type EventType, type ExecutionId, type MessageId, type NewEvent, type SessionId, type EventData, event, text } from "../../packages/core/src/index.ts"
import type { EngineEvent } from "../../packages/cli/src/engine.ts"
import { parseArgs } from "../../packages/cli/src/args.ts"
import { TASKS_DIR, applySolution, listTasks, loadTask } from "../run-check.ts"

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

const sessionId = "ses_standin" as SessionId
const executionId = "exe_standin" as ExecutionId
const position = { seq: 0 }
const emit = (item: EngineEvent) => process.stdout.write(`${JSON.stringify(item)}\n`)
const durable = <T extends EventType>(type: T, data: EventData<T>) => {
  position.seq += 1
  emit({ ...(event(type, data) as NewEvent), sessionId, seq: position.seq, time: Date.now() } as EngineEvent)
}
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens, outputTokens, reasoningTokens: 0 })
const model = options.model ?? "stand-in-model"
const user = "msg_user" as MessageId
const step1 = "msg_step1" as MessageId
const step2 = "msg_step2" as MessageId

if (mode === "replay") {
  process.stdout.write(await Bun.file(process.env.STAND_IN_EVENTS ?? "").text())
  process.exit(exitWith)
}

durable("session.created", { cwd, title: null, lineage: null, settings: { model, reasoningEffort: null } })
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
  durable("execution.succeeded", { executionId })
  process.exit(exitWith)
}

/** Applies the reference solution of the task whose prompt this is. */
async function solve() {
  const ids = await listTasks()
  const tasks = await Promise.all(ids.map((id) => loadTask(id)))
  const task = tasks.find((candidate) => candidate.prompt === prompt)
  if (!task) throw new Error(`stand-in: no task in ${join(TASKS_DIR)} has this prompt`)
  await applySolution(task.id, cwd)
  return `applied the reference solution of ${task.id}`
}
