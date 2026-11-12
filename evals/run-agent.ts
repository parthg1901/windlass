/**
 * Runs the agent on eval tasks the way a user would: a fresh copy of the task's workspace, the CLI started once with
 * the task's prompt in `--json` mode, Ctrl-C (SIGINT) at the time limit and a kill after a grace period, then the
 * task's grader on whatever the agent left behind. Every metric comes from the JSONL event stream, never from text.
 *
 *   bun evals/run-agent.ts [task-id ...] [--all] [--model <slug>] [--effort <level>] [--repeat N] [--concurrency N]
 *                          [--keep] [--out <dir>] [--cli "<command>"] [--timeout <s>] [--grace <s>] [--db <path>] [--no-classify]
 *
 * A task with several prompts is one session: each later prompt is sent with `--session <id>` once the previous
 * turn's process has exited. After each run the session is exported and its cache misses classified (classify.ts).
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EVENT_TYPES, EventDecodeError, type EphemeralEventType, type StepError, type ToolOutcome, type Usage, validateEvent } from "../packages/core/src/index.ts"
import { brand } from "../packages/core/src/brand.ts"
import type { EngineEvent } from "../packages/cli/src/engine.ts"
import { type CacheClassification, classifySession, sessionDatabase, skipped } from "./classify.ts"
import { type GradeResult, type Task, grade, listTasks, loadTask, prepareWorkspace } from "./run-check.ts"

const REPO = resolve(import.meta.dir, "..")
/** The CLI as a user of this checkout would start it. */
export const DEFAULT_CLI = ["bun", join(REPO, "packages/cli/src/main.ts")]
export const RESULTS_DIR = join(import.meta.dir, "results")

/** How the agent's tool calls are approved in an eval: the default mode, and a refusal instead of a question. */
export const UNATTENDED_FLAGS = ["--approval", "auto", "--unattended", "deny"] as const

// A `Record` over the union, so a new ephemeral event type fails to compile here until it is listed.
const EPHEMERAL: Record<EphemeralEventType, true> = {
  "text.delta": true,
  "reasoning.delta": true,
  "tool.input.delta": true,
  "tool.progress": true,
  "checks.progress": true,
  "workspace.changes": true,
  diagnostic: true,
  notice: true,
}
const OUTCOMES = ["success", "error", "not_started", "effect_unknown"] as const satisfies readonly ToolOutcome[]

export interface RunOptions {
  readonly tasks: readonly string[]
  readonly model?: string | null
  readonly effort?: string | null
  readonly repeat?: number
  readonly concurrency?: number
  readonly keep?: boolean
  /** Where results.json and the raw streams go. Default: a timestamped directory under evals/results/. */
  readonly out?: string
  /** The command that starts the agent; the runner appends `--json --cwd <dir> --approval auto --unattended deny --max-steps <n> [--model] [--effort] -- <prompt>`. */
  readonly cli?: readonly string[]
  /** Overrides every task's `timeoutSeconds`. */
  readonly timeoutSeconds?: number
  /** How long after SIGINT the agent may take to stop before it is killed. Default 15 s. */
  readonly graceSeconds?: number
  /** Extra environment for the agent process. */
  readonly env?: Record<string, string>
  /** Called with each finished row, e.g. to print progress. */
  readonly onResult?: (result: RunResult) => void
  /** Where to export traces from: the harness data directory (one file per session), or a single database file. Default: the CLI's data directory, under the agent's `XDG_DATA_HOME`. */
  readonly database?: string
  /** Export and classify each run's cache misses (default true; skipped visibly when prefixlens is absent). */
  readonly classify?: boolean
}

export interface StepUsage {
  readonly messageId: string
  readonly input: number
  readonly cached: number
  readonly output: number
}

export interface ToolTally {
  calls: number
  success: number
  error: number
  not_started: number
  effect_unknown: number
  /** Called but never settled in the stream. */
  unsettled: number
}

export interface Anomaly {
  readonly kind:
    | "cache-drop"
    | "effect-unknown"
    | "not-started"
    | "unsettled-tool"
    | "no-execution-end"
    | "over-step-limit"
    | "malformed-event"
    /** prefixlens found a miss the harness caused (classify.ts). */
    | "avoidable-miss"
    /** A trace record was exported usage-only: the request rebuilt from the log is not what was sent. */
    | "usage-only-record"
  readonly detail: string
  /**
   * `cache-drop` only: whether the cache classification explains the drop (a provider-side miss, an expired entry,
   * a declared break, or no miss beyond prefixlens's tolerance). `null` until classified, or when it could not be.
   */
  readonly explained?: boolean | null
}

export interface Metrics {
  readonly sessionId: string | null
  readonly events: number
  /** Logical model calls: `step.started` with attempt 1 (a retry is not a new step). */
  readonly steps: number
  /** Every `step.started`, retries included. */
  readonly modelCalls: number
  readonly toolCalls: number
  readonly tools: Record<string, ToolTally>
  readonly toolOutcomes: Record<ToolOutcome | "unsettled", number>
  readonly retries: number
  readonly retriesByKind: Record<string, number>
  /** The last `execution.*` terminal event, or `null` when the stream has none. */
  readonly end: "succeeded" | "failed" | "interrupted" | null
  readonly interruptReason: string | null
  /** What the harness's verification gate found when the last execution succeeded (`not_configured`, `passed`, ...). */
  readonly verification: string | null
  readonly failureMessage: string | null
  /** The class of the last step error (`provider:rate_limit`, `interrupted:user`, `crashed`, `internal`, `refused`). */
  readonly errorClass: string | null
  readonly tokens: { readonly input: number; readonly cached: number; readonly output: number; readonly reasoning: number }
  /** cached / input, `null` with no input. */
  readonly cachedShare: number | null
  readonly perStep: readonly StepUsage[]
  /** Event types this runner does not know, with counts. Never an error: the schema is still growing. */
  readonly unknownEvents: Record<string, number>
  readonly malformed: number
  readonly anomalies: Anomaly[]
}

export interface TurnResult {
  readonly prompt: number
  readonly exitCode: number | null
  readonly signal: string | null
  readonly wallMs: number
  readonly timedOut: boolean
  readonly killed: boolean
}

export interface RunResult {
  readonly task: string
  readonly attempt: number
  readonly pass: boolean
  readonly reason: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly wallMs: number
  /** The runner hit the time limit and sent SIGINT. */
  readonly timedOut: boolean
  /** The agent did not stop within the grace period after SIGINT and was killed. */
  readonly killed: boolean
  /** The task's time limit in seconds (or the `--timeout` override), for judging how far over a killed run went. */
  readonly timeoutSeconds: number
  /** One entry per prompt sent; a multi-turn run stops sending at the first turn that did not end on its own. */
  readonly turns: readonly TurnResult[]
  /** How many prompts the task has; fewer turns than this means the run stopped early. */
  readonly prompts: number
  readonly maxSteps: number
  readonly overStepLimit: boolean
  /** One-word summary for the table: passed, failed, timeout, killed, crashed, error. */
  readonly status: string
  readonly metrics: Metrics
  /** The run's prompt-cache misses, explained (classify.ts). */
  readonly cache: CacheClassification
  readonly traceFile: string | null
  readonly eventsFile: string
  readonly stderrFile: string
  /** Where the finished workspace is, or `null` once deleted. */
  readonly workspace: string | null
}

export interface Report {
  readonly startedAt: string
  /** The checkout the runs were taken at, for the baseline; `dirty` when it had uncommitted changes. `null` outside git. */
  readonly commit?: { readonly sha: string; readonly dirty: boolean } | null
  readonly cli: readonly string[]
  readonly model: string | null
  readonly effort: string | null
  readonly out: string
  readonly totals: Totals
  readonly results: readonly RunResult[]
}

export interface Totals {
  readonly runs: number
  readonly passed: number
  readonly passRate: number
  readonly medianWallMs: number
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedShare: number | null
  readonly anomalies: number
  /** Over classified runs: misses prefixlens attributes to the provider, to declared breaks, and to the harness. */
  readonly cache: { readonly classified: number; readonly providerSide: number; readonly intentional: number; readonly avoidable: number; readonly unfaithful: number }
}

export async function runAgent(options: RunOptions): Promise<Report> {
  const startedAt = new Date().toISOString()
  const out = resolve(options.out ?? join(RESULTS_DIR, startedAt.replace(/[:.]/g, "-")))
  await mkdir(join(out, "runs"), { recursive: true })
  const tasks = await Promise.all(options.tasks.map((id) => loadTask(id)))
  const jobs = tasks.flatMap((task) => Array.from({ length: options.repeat ?? 1 }, (_, index) => ({ task, attempt: index + 1 })))
  const root = await mkdtemp(join(tmpdir(), "lh-agent-"))
  const results: RunResult[] = []
  try {
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!
        const result = await runOne(job.task, job.attempt, root, out, options)
        results.push(result)
        options.onResult?.(result)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, jobs.length)) }, worker))
  } finally {
    if (!options.keep) await rm(root, { recursive: true, force: true })
  }
  results.sort((a, b) => jobs.findIndex((job) => job.task.id === a.task && job.attempt === a.attempt) - jobs.findIndex((job) => job.task.id === b.task && job.attempt === b.attempt))
  const report: Report = {
    startedAt,
    commit: commitOf(),
    cli: options.cli ?? DEFAULT_CLI,
    model: options.model ?? null,
    effort: options.effort ?? null,
    out,
    totals: totalsOf(results),
    results,
  }
  await Bun.write(join(out, "results.json"), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

function commitOf() {
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO, stdout: "pipe", stderr: "ignore" })
  if (sha.exitCode !== 0) return null
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: REPO, stdout: "pipe", stderr: "ignore" })
  return { sha: sha.stdout.toString().trim(), dirty: status.stdout.toString().trim() !== "" }
}

async function runOne(task: Task, attempt: number, root: string, out: string, options: RunOptions): Promise<RunResult> {
  const name = `${task.id}-${attempt}`
  const eventsFile = join(out, "runs", `${name}.jsonl`)
  const stderrFile = join(out, "runs", `${name}.stderr.log`)
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const prepared = await prepareWorkspace(task.id, dir).then(
    () => null,
    (error: unknown) => String(error instanceof Error ? error.message : error),
  )
  if (prepared !== null) {
    await Promise.all([Bun.write(eventsFile, ""), Bun.write(stderrFile, `${prepared}\n`)])
    if (!options.keep) await rm(dir, { recursive: true, force: true })
    const metrics = computeMetrics("", task.maxSteps)
    return {
      task: task.id,
      attempt,
      pass: false,
      reason: `setup failed: ${prepared}`,
      exitCode: null,
      signal: null,
      wallMs: 0,
      timedOut: false,
      killed: false,
      timeoutSeconds: options.timeoutSeconds ?? task.timeoutSeconds,
      turns: [],
      prompts: task.prompts.length,
      maxSteps: task.maxSteps,
      overStepLimit: false,
      status: "error",
      metrics,
      cache: skipped("setup failed"),
      traceFile: null,
      eventsFile,
      stderrFile,
      workspace: options.keep ? dir : null,
    }
  }

  const agent = await runTurns(task, dir, eventsFile, stderrFile, options)
  const counted = computeMetrics(agent.stdout, task.maxSteps)
  const graded: GradeResult = await grade(task.id, dir).catch((error: unknown) => ({ pass: false, message: `grader error: ${String(error)}` }))
  if (!options.keep) await rm(dir, { recursive: true, force: true })
  const traceFile = join(out, "runs", `${name}.trace.jsonl`)
  const cache =
    options.classify === false
      ? skipped("classification turned off")
      : await classifySession(counted.sessionId, { database: options.database ?? sessionDatabase({ ...process.env, ...options.env }), traceFile }).catch((error: unknown) =>
          skipped(`classification failed: ${String(error)}`, "error"),
        )
  const metrics = { ...counted, anomalies: explainAnomalies(counted, cache) }
  const last = agent.turns.at(-1)!
  const stoppedEarly = agent.turns.length < task.prompts.length
  const status = graded.pass ? "passed" : agent.killed ? "killed" : agent.timedOut ? "timeout" : metrics.end === null || stoppedEarly ? "crashed" : "failed"
  return {
    task: task.id,
    attempt,
    pass: graded.pass,
    reason: graded.message,
    exitCode: last.exitCode,
    signal: last.signal,
    wallMs: agent.turns.reduce((total, turn) => total + turn.wallMs, 0),
    timedOut: agent.timedOut,
    killed: agent.killed,
    timeoutSeconds: options.timeoutSeconds ?? task.timeoutSeconds,
    turns: agent.turns,
    prompts: task.prompts.length,
    maxSteps: task.maxSteps,
    overStepLimit: metrics.steps > task.maxSteps,
    status,
    metrics,
    cache,
    traceFile: cache.status === "skipped" ? null : traceFile,
    eventsFile,
    stderrFile,
    workspace: options.keep ? dir : null,
  }
}

/**
 * Marks each `cache-drop` explained or not, and adds an anomaly per avoidable miss and per usage-only record. A drop
 * is matched to prefixlens's verdict by the step's message ID; a drop prefixlens does not count as a miss (it lost
 * no more than its tolerance) is explained too.
 */
export function explainAnomalies(metrics: Metrics, cache: CacheClassification): Anomaly[] {
  const classified = cache.status === "classified"
  const marked = metrics.anomalies.map((anomaly): Anomaly => {
    if (anomaly.kind !== "cache-drop") return anomaly
    if (!classified) return { ...anomaly, explained: null }
    const messageId = /\(message ([^)]+)\)/.exec(anomaly.detail)?.[1]
    const verdicts = cache.misses.filter((miss) => miss.messageId === messageId)
    const avoidable = verdicts.find((miss) => miss.verdict === "avoidable")
    if (avoidable) return { ...anomaly, explained: false, detail: `${anomaly.detail}: unexplained, ${avoidable.cause}` }
    const reason = verdicts[0]?.verdict ?? "no miss beyond tolerance"
    return { ...anomaly, explained: true, detail: `${anomaly.detail}: explained, ${reason}` }
  })
  return [
    ...marked,
    ...cache.misses.filter((miss) => miss.verdict === "avoidable").map((miss): Anomaly => ({ kind: "avoidable-miss", detail: `trace call ${miss.turn}: ${miss.cause}: ${miss.summary}` })),
    ...cache.unfaithful.map((record): Anomaly => ({ kind: "usage-only-record", detail: `trace call ${record.turn}${record.messageId ? ` (message ${record.messageId})` : ""}: ${record.reason}` })),
  ]
}

/**
 * Sends the task's prompts one turn at a time. Every later turn resumes the first turn's session with `--session`,
 * without `--model` or `--effort` (the session keeps them; passing them again would record a settings change). The
 * time limit covers the whole run: each turn gets what is left of it.
 */
async function runTurns(task: Task, dir: string, eventsFile: string, stderrFile: string, options: RunOptions) {
  const writer = Bun.file(eventsFile).writer()
  const stderr: string[] = []
  const turns: TurnResult[] = []
  const output: string[] = []
  const budgetMs = (options.timeoutSeconds ?? task.timeoutSeconds) * 1000
  try {
    for (const [index, prompt] of task.prompts.entries()) {
      const sessionId = index === 0 ? null : sessionOf(output.join(""))
      if (index > 0 && sessionId === null) break
      const spent = turns.reduce((total, turn) => total + turn.wallMs, 0)
      // Every turn runs under the task's step limit: the loop then makes one last call without tools instead of going on.
      const limit = ["--max-steps", String(task.maxSteps)]
      const flags = [...limit, ...(index === 0 ? [...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--effort", options.effort] : [])] : ["--session", sessionId!])]
      const turn = await runProcess(prompt, flags, dir, Math.max(1000, budgetMs - spent), writer, options)
      output.push(turn.stdout)
      stderr.push(task.prompts.length > 1 ? `--- turn ${index + 1}\n${turn.stderr}` : turn.stderr)
      turns.push({ prompt: index + 1, exitCode: turn.exitCode, signal: turn.signal, wallMs: turn.wallMs, timedOut: turn.timedOut, killed: turn.killed })
      // A turn that was stopped, crashed or failed ends the run: a user would not type the next prompt either.
      if (turn.timedOut || turn.killed || turn.exitCode !== 0) break
    }
  } finally {
    await writer.end()
    await Bun.write(stderrFile, stderr.join(""))
  }
  return { stdout: output.join(""), turns, timedOut: turns.some((turn) => turn.timedOut), killed: turns.some((turn) => turn.killed) }
}

/** The session ID of the first event that has one. */
function sessionOf(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    const value = parseJson(line)
    if (typeof value === "object" && value !== null && "sessionId" in value && typeof value.sessionId === "string") return value.sessionId
  }
  return null
}

/** Starts the agent for one prompt, streams stdout to the events file, and stops it like a user would when time is up. */
async function runProcess(prompt: string, flags: readonly string[], dir: string, timeoutMs: number, writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>, options: RunOptions) {
  // Said explicitly, on every turn: an eval runs with nobody to answer, in the default mode. A call that would ask is
  // refused and the agent goes on (`deny`), so a run never waits, and the refusal is in the events for whoever reads them.
  const cmd = [...(options.cli ?? DEFAULT_CLI), "--json", "--cwd", dir, ...UNATTENDED_FLAGS, ...flags, "--", prompt]
  const started = performance.now()
  const proc = Bun.spawn(cmd, {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options.env },
  })
  const state = { timedOut: false, killed: false }
  const graceMs = (options.graceSeconds ?? 15) * 1000
  const killTimer = { id: null as ReturnType<typeof setTimeout> | null }
  const interruptTimer = setTimeout(() => {
    state.timedOut = true
    proc.kill("SIGINT")
    killTimer.id = setTimeout(() => {
      state.killed = true
      proc.kill("SIGKILL")
    }, graceMs)
  }, timeoutMs)

  const chunks: string[] = []
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      writer.write(chunk.value)
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
  })()
  const stderr = new Response(proc.stderr).text()
  await proc.exited
  const wallMs = Math.round(performance.now() - started)
  clearTimeout(interruptTimer)
  if (killTimer.id !== null) clearTimeout(killTimer.id)
  // A tool process the agent left running may still hold the pipe open; do not wait for it forever.
  await Promise.race([pump, Bun.sleep(2000)])
  await reader.cancel().catch(() => {})
  await writer.flush()
  const stderrText = await Promise.race([stderr, Bun.sleep(500).then(() => "")])
  return { stdout: chunks.join("") + decoder.decode(), stderr: stderrText, exitCode: proc.exitCode, signal: proc.signalCode === null ? null : String(proc.signalCode), wallMs, ...state }
}

/** Every metric of one run, from its raw `--json` output. Tolerates unknown, malformed and truncated lines. */
export function computeMetrics(jsonl: string, maxSteps: number): Metrics {
  const tools: Record<string, ToolTally> = {}
  const calls = new Map<string, { name: string; settled: boolean }>()
  const toolOutcomes: Record<ToolOutcome | "unsettled", number> = { success: 0, error: 0, not_started: 0, effect_unknown: 0, unsettled: 0 }
  const retriesByKind: Record<string, number> = {}
  const unknownEvents: Record<string, number> = {}
  const perStep: StepUsage[] = []
  const anomalies: Anomaly[] = []
  const tokens = { input: 0, cached: 0, output: 0, reasoning: 0 }
  const m = { events: 0, steps: 0, modelCalls: 0, retries: 0, malformed: 0, sessionId: null as string | null, executions: 0, ended: 0 }
  const end = { kind: null as Metrics["end"], reason: null as string | null, message: null as string | null, errorClass: null as string | null, verification: null as string | null }

  const addUsage = (messageId: string, usage: Usage | null) => {
    if (usage === null) return
    tokens.input += usage.inputTokens
    tokens.cached += usage.cachedInputTokens
    tokens.output += usage.outputTokens
    tokens.reasoning += usage.reasoningTokens
    perStep.push({ messageId, input: usage.inputTokens, cached: usage.cachedInputTokens, output: usage.outputTokens })
  }

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    const item = parseLine(line)
    if (item.kind === "unknown") {
      unknownEvents[item.type] = (unknownEvents[item.type] ?? 0) + 1
      continue
    }
    if (item.kind === "malformed") {
      m.malformed += 1
      anomalies.push({ kind: "malformed-event", detail: item.reason })
      continue
    }
    const event = item.event
    m.events += 1
    if ("sessionId" in event && m.sessionId === null) m.sessionId = event.sessionId
    switch (event.type) {
      case "step.started":
        m.modelCalls += 1
        if (event.data.attempt === 1) m.steps += 1
        break
      case "step.ended":
        addUsage(event.data.messageId, event.data.usage)
        break
      case "step.failed":
        addUsage(event.data.messageId, event.data.usage)
        end.errorClass = stepErrorClass(event.data.error)
        break
      case "step.refused":
        addUsage(event.data.messageId, event.data.usage)
        end.errorClass = "refused"
        break
      case "compaction.ended":
        addUsage(event.data.messageId, event.data.usage)
        break
      case "retry.scheduled":
        m.retries += 1
        retriesByKind[event.data.error.kind] = (retriesByKind[event.data.error.kind] ?? 0) + 1
        break
      case "tool.called": {
        calls.set(`${event.data.messageId}/${event.data.callId}`, { name: event.data.name, settled: false })
        const tally = (tools[event.data.name] ??= { calls: 0, success: 0, error: 0, not_started: 0, effect_unknown: 0, unsettled: 0 })
        tally.calls += 1
        break
      }
      case "tool.settled": {
        const call = calls.get(`${event.data.messageId}/${event.data.callId}`)
        const name = call?.name ?? "(unknown)"
        if (call) call.settled = true
        const tally = (tools[name] ??= { calls: 0, success: 0, error: 0, not_started: 0, effect_unknown: 0, unsettled: 0 })
        tally[event.data.outcome] += 1
        toolOutcomes[event.data.outcome] += 1
        if (event.data.outcome === "effect_unknown") anomalies.push({ kind: "effect-unknown", detail: `${name} call ${event.data.callId} settled as effect_unknown` })
        if (event.data.outcome === "not_started") anomalies.push({ kind: "not-started", detail: `${name} call ${event.data.callId} settled as not_started` })
        break
      }
      case "execution.started":
        m.executions += 1
        break
      case "execution.succeeded":
        m.ended += 1
        end.kind = "succeeded"
        end.verification = event.data.verification.status
        break
      case "execution.failed":
        m.ended += 1
        end.kind = "failed"
        end.message = event.data.message
        break
      case "execution.interrupted":
        m.ended += 1
        end.kind = "interrupted"
        end.reason = event.data.reason
        break
    }
  }

  for (const [key, call] of calls) {
    if (call.settled) continue
    toolOutcomes.unsettled += 1
    tools[call.name]!.unsettled += 1
    anomalies.push({ kind: "unsettled-tool", detail: `${call.name} call ${key.split("/")[1]} was never settled` })
  }
  perStep.forEach((step, index) => {
    const previous = perStep[index - 1]
    if (previous && step.cached < previous.cached)
      anomalies.push({ kind: "cache-drop", detail: `step ${index + 1} (message ${step.messageId}): cached input fell from ${previous.cached} to ${step.cached}` })
  })
  if (end.kind === null) anomalies.push({ kind: "no-execution-end", detail: "the stream has no execution.succeeded, execution.failed or execution.interrupted" })
  else if (m.ended < m.executions) anomalies.push({ kind: "no-execution-end", detail: `${m.executions} executions started, ${m.ended} ended` })
  if (m.steps > maxSteps) anomalies.push({ kind: "over-step-limit", detail: `${m.steps} steps, limit ${maxSteps}` })

  return {
    sessionId: m.sessionId,
    events: m.events,
    steps: m.steps,
    modelCalls: m.modelCalls,
    toolCalls: calls.size,
    tools,
    toolOutcomes,
    retries: m.retries,
    retriesByKind,
    end: end.kind,
    interruptReason: end.reason,
    verification: end.verification,
    failureMessage: end.message,
    errorClass: end.errorClass,
    tokens,
    cachedShare: tokens.input === 0 ? null : tokens.cached / tokens.input,
    perStep,
    unknownEvents,
    malformed: m.malformed,
    anomalies,
  }
}

type Parsed = { kind: "event"; event: EngineEvent } | { kind: "unknown"; type: string } | { kind: "malformed"; reason: string }

/** The one place a line of agent output becomes a typed event. Durable events are checked against the core schema. */
function parseLine(line: string): Parsed {
  const value = parseJson(line)
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string")
    return { kind: "malformed", reason: `not an event: ${line.slice(0, 80)}` }
  const type = value.type
  if (type in EPHEMERAL) return { kind: "event", event: value as EngineEvent }
  if (!(EVENT_TYPES as readonly string[]).includes(type)) return { kind: "unknown", type }
  const record = value as { type: string; v: unknown; data: unknown }
  try {
    validateEvent({ type, v: typeof record.v === "number" ? record.v : 0, data: record.data })
  } catch (error) {
    if (error instanceof EventDecodeError && error.reason === "unknown_version") return { kind: "unknown", type: `${type}@v${String(record.v)}` }
    return { kind: "malformed", reason: `${type}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { kind: "event", event: value as EngineEvent }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function stepErrorClass(error: StepError) {
  switch (error.kind) {
    case "provider":
      return `provider:${error.error.kind}`
    case "interrupted":
      return `interrupted:${error.reason}`
    case "crashed":
    case "internal":
      return error.kind
  }
}

export function totalsOf(results: readonly RunResult[]): Totals {
  const sum = (pick: (result: RunResult) => number) => results.reduce((total, result) => total + pick(result), 0)
  const walls = results.map((result) => result.wallMs).sort((a, b) => a - b)
  const middle = Math.floor(walls.length / 2)
  const median = walls.length === 0 ? 0 : walls.length % 2 ? walls[middle]! : Math.round((walls[middle - 1]! + walls[middle]!) / 2)
  const input = sum((result) => result.metrics.tokens.input)
  const cached = sum((result) => result.metrics.tokens.cached)
  const output = sum((result) => result.metrics.tokens.output)
  const passed = results.filter((result) => result.pass).length
  return {
    runs: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    medianWallMs: median,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
    cachedShare: input === 0 ? null : cached / input,
    anomalies: sum((result) => result.metrics.anomalies.length),
    cache: {
      classified: results.filter((result) => result.cache.status === "classified").length,
      providerSide: sum((result) => result.cache.providerSide),
      intentional: sum((result) => result.cache.intentional),
      avoidable: sum((result) => result.cache.avoidable),
      unfaithful: sum((result) => result.cache.unfaithful.length),
    },
  }
}

/** One row per run, then the totals. Plain text: it goes to a terminal or a CI log. */
export function formatTable(report: Report): string {
  const head = ["task", "#", "result", "exit", "end", "wall", "steps", "tools", "retry", "in", "cached", "out", "anomalies"]
  const rows = report.results.map((result) => {
    const metrics = result.metrics
    // A drop prefixlens explained is shown as `cache-drop(ok)`, one it could not as `cache-drop(?)`.
    const kinds = [...new Set(metrics.anomalies.map((anomaly) => (anomaly.kind !== "cache-drop" ? anomaly.kind : anomaly.explained === true ? "cache-drop(ok)" : anomaly.explained === false ? "cache-drop" : "cache-drop(?)")))]
    return [
      result.task,
      String(result.attempt),
      result.status,
      result.exitCode === null ? (result.signal ?? "-") : String(result.exitCode),
      metrics.end === "interrupted" ? `interrupted:${metrics.interruptReason}` : metrics.end === "failed" && metrics.errorClass ? `failed:${metrics.errorClass}` : (metrics.end ?? "none"),
      seconds(result.wallMs),
      `${metrics.steps}/${result.maxSteps}`,
      String(metrics.toolCalls),
      String(metrics.retries),
      count(metrics.tokens.input),
      percent(metrics.cachedShare),
      count(metrics.tokens.output),
      kinds.join(",") || "-",
    ]
  })
  const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)))
  const line = (cells: readonly string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()
  const totals = report.totals
  const failures = report.results.filter((result) => !result.pass).map((result) => `  ${result.task}#${result.attempt}: ${result.reason}`)
  return [
    line(head),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
    "",
    `passed ${totals.passed}/${totals.runs} (${percent(totals.passRate)})  median wall ${seconds(totals.medianWallMs)}  tokens ${count(totals.totalTokens)} (in ${count(totals.inputTokens)}, out ${count(totals.outputTokens)})  cached ${percent(totals.cachedShare)}  anomalies ${totals.anomalies}`,
    totals.cache.classified === 0
      ? `cache misses: not classified (${report.results.find((result) => result.cache.reason !== null)?.cache.reason ?? "no runs"})`
      : `cache misses (${totals.cache.classified}/${totals.runs} runs classified): ${totals.cache.providerSide} provider-side, ${totals.cache.intentional} intentional, ${totals.cache.avoidable} avoidable; ${totals.cache.unfaithful} usage-only records`,
    ...(failures.length > 0 ? ["", "failures:", ...failures] : []),
    "",
    `results: ${join(report.out, "results.json")}`,
  ].join("\n")
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`
}

function count(tokens: number) {
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(0)}k` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function percent(share: number | null) {
  return share === null ? "-" : `${Math.round(share * 100)}%`
}

/** Splits a `--cli` command line into argv, honouring single and double quotes. */
export function splitCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!)
}

const USAGE = `usage: bun evals/run-agent.ts [task-id ...] [--all] [--model <slug>] [--effort <level>] [--repeat N]
         [--concurrency N] [--keep] [--out <dir>] [--cli "<command>"] [--timeout <s>] [--grace <s>]
         [--db <path>] [--no-classify]`

export async function parseRunnerArgs(argv: readonly string[]): Promise<RunOptions | string> {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const ids: string[] = []
  const valueFlags = ["--model", "--effort", "--repeat", "--concurrency", "--out", "--cli", "--timeout", "--grace", "--db"]
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (valueFlags.includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined) return `${arg} needs a value`
      values.set(arg, value)
      index += 1
      continue
    }
    if (arg === "--all" || arg === "--keep" || arg === "--no-classify") {
      flags.add(arg)
      continue
    }
    if (arg.startsWith("-")) return `unknown option ${arg}`
    ids.push(arg)
  }
  const known = await listTasks()
  const unknown = ids.filter((id) => !known.includes(id))
  if (unknown.length > 0) return `unknown task ${unknown.join(", ")}; tasks: ${known.join(", ")}`
  const tasks = flags.has("--all") ? known : ids
  if (tasks.length === 0) return `name some tasks or pass --all; tasks: ${known.join(", ")}`
  const numbers: Record<string, number | undefined> = {}
  for (const flag of ["--repeat", "--concurrency", "--timeout", "--grace"]) {
    const raw = values.get(flag)
    if (raw === undefined) continue
    const value = Number(raw)
    const seconds = flag === "--timeout" || flag === "--grace"
    const valid = Number.isFinite(value) && (seconds ? value > 0 || (flag === "--grace" && value === 0) : Number.isInteger(value) && value >= 1)
    if (!valid) return `${flag} must be ${seconds ? "a positive number of seconds" : "a whole number of at least 1"}`
    numbers[flag] = value
  }
  const cli = values.get("--cli")
  return {
    tasks,
    model: values.get("--model") ?? null,
    effort: values.get("--effort") ?? null,
    repeat: numbers["--repeat"] ?? 1,
    concurrency: numbers["--concurrency"] ?? 1,
    keep: flags.has("--keep"),
    ...(values.has("--out") ? { out: values.get("--out") } : {}),
    ...(values.has("--db") ? { database: resolve(values.get("--db")!) } : {}),
    ...(flags.has("--no-classify") ? { classify: false } : {}),
    // The agent starts in its workspace, so a script path given relative to here is made absolute.
    ...(cli === undefined ? {} : { cli: splitCommand(cli).map((word) => (!word.startsWith("-") && existsSync(word) ? resolve(word) : word)) }),
    ...(numbers["--timeout"] === undefined ? {} : { timeoutSeconds: numbers["--timeout"] }),
    ...(numbers["--grace"] === undefined ? {} : { graceSeconds: numbers["--grace"] }),
  }
}

if (import.meta.main) {
  const options = await parseRunnerArgs(process.argv.slice(2))
  if (typeof options === "string") {
    console.error(`${options}\n${USAGE}`)
    process.exit(2)
  }
  console.error(`running ${options.tasks.length} task(s) × ${options.repeat} with ${(options.cli ?? DEFAULT_CLI).join(" ")} (${brand.name})`)
  const report = await runAgent({
    ...options,
    onResult: (result) => console.error(`  ${result.status.padEnd(7)} ${result.task}#${result.attempt} ${seconds(result.wallMs)}: ${result.reason}`),
  })
  console.log(formatTable(report))
  if (options.keep) console.log(`workspaces kept: ${report.results.map((result) => result.workspace).join(" ")}`)
  process.exit(report.totals.passed === report.totals.runs ? 0 : 1)
}
