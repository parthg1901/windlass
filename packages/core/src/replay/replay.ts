/**
 * A replay in progress: the tape cursor, the replaying tool executor and the
 * numbers the report is built from.
 *
 * The executor has the shape of the real tool runtime (`ToolRuntime`), so the
 * step loop can be handed either. On a match it returns the recorded outcome
 * without running anything; it calls `onStart` exactly when the recorded call
 * had started, so the loop writes the same `tool.started` / `tool.settled`
 * pair it would write for a real run. On a mismatch it follows the policy:
 *
 * - `stop` (default): nothing runs. The call and every later call settle
 *   `not_started` with a note, `status` becomes `stopped`, `onStop` fires,
 *   and the loop should end the replay.
 * - `execute-read-only`: a `read` tool runs for real in the override
 *   workspace; anything else stops as above.
 * - `execute`: the tool runs for real in the override workspace, for use in a
 *   throwaway copy.
 *
 * Safety. A policy that may execute requires `workspace`: a directory that is
 * not the recorded session's workspace, not inside it and not around it,
 * and the tool runtime to run in it. The check runs when the replay is
 * created, on real paths, and the policy type makes `workspace` mandatory, so
 * there is no configuration that runs a tool against the original workspace
 * by default. Every real run gets `cwd` replaced by the override. A
 * side-effecting call whose arguments name the original workspace by its
 * absolute path is refused and stops the replay. What this cannot stop is a
 * shell command that finds its way out by itself (`cd ..`); confining that is
 * the sandbox's job, and an `execute` replay should run inside it.
 */
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { InterruptReason } from "../interrupt.ts"
import type { Usage } from "../provider/usage.ts"
import { parseArguments } from "../tool/args.ts"
import type { RunHooks, ToolCall, ToolCallOutcome, ToolRuntime } from "../tool/runtime.ts"
import type { AnyTool } from "../tool/tool.ts"
import { type CallMatch, type Divergence, type MatchOptions, type MatchStats, TapeMatcher } from "./match.ts"
import { type ReplayReport, buildReport } from "./report.ts"
import type { Tape, TapeCall, TapeInput } from "./tape.ts"

export interface ReplayWorkspace {
  /** Absolute path of the throwaway copy the tools run in. */
  readonly cwd: string
  /** A tool runtime for that copy. Its `tools` decide each call's effect class. */
  readonly runtime: ToolRuntime
}

export type ReplayPolicy =
  | { readonly kind: "stop" }
  | { readonly kind: "execute-read-only"; readonly workspace: ReplayWorkspace }
  | { readonly kind: "execute"; readonly workspace: ReplayWorkspace }

export interface ReplayOptions extends MatchOptions {
  /** The replayed build's tools. Used for `executor.tools` and to describe recorded refusals. */
  readonly tools: readonly AnyTool[]
  /** What to do when the model leaves the tape. Defaults to `stop`. */
  readonly policy?: ReplayPolicy
  /** Called once, when the replay stops at a divergence (or at a call it refuses to run). */
  readonly onStop?: (divergence: Divergence) => void
}

/**
 * - `on_tape`: every step so far matched.
 * - `off_tape`: the tape was left and the policy runs tools for real.
 * - `stopped`: the tape was left and the replay ends here.
 * - `finished`: every recorded step was replayed, or off tape, the model answered.
 * - `unsupported`: the recording does something here a replay cannot reproduce.
 * - `incomplete`: the driver gave up (`fail`).
 */
export type ReplayStatus = "on_tape" | "off_tape" | "stopped" | "finished" | "unsupported" | "incomplete"

/** What the loop observed of one replayed step. */
export interface ObservedStep {
  readonly text: string
  /** Every call of the step, in the order the model made them. */
  readonly calls: readonly { readonly name: string; readonly input: string }[]
  readonly usage: Usage | null
}

export interface EndOfStep {
  /** `continue`: make the next model call. `stop`: end the replay; `replay.report()` says why. */
  readonly action: "continue" | "stop"
  /** Set when the recorded step was cut by an interrupt here: the loop closes the step as interrupted for this reason. */
  readonly interrupted: InterruptReason | null
}

export interface Replay {
  readonly tape: Tape
  readonly executor: ToolRuntime
  readonly status: ReplayStatus
  readonly divergence: Divergence | null
  /** Inputs to add to history before the next step. Stops with `unsupported` at a compaction, revert or refusal. */
  readonly takeInputs: () => TapeInput[]
  readonly endStep: (observed: ObservedStep) => EndOfStep
  /** The driver gives up for a reason of its own (a provider error, a step cap). */
  readonly fail: (reason: string) => void
  readonly snapshot: () => ReplaySnapshot
  readonly report: () => ReplayReport
}

/** The raw numbers of a replay, for the report. */
export interface ReplaySnapshot {
  readonly status: ReplayStatus
  readonly reason: string | null
  readonly divergence: Divergence | null
  readonly matched: MatchStats
  readonly steps: number
  readonly callsByTool: Readonly<Record<string, number>>
  readonly lastStep: { readonly text: string; readonly calls: number } | null
  readonly usage: Usage | null
  readonly offTape: { readonly steps: number; readonly calls: number; readonly executed: number }
  readonly unsupported: TapeInput | null
}

export const STOPPED_OUTPUT = "Not run: the replay left the recording at this call and stopped."
const DROPPED_OUTPUT = "Not run: the user interrupted before this call started."

export function createReplay(tape: Tape, options: ReplayOptions): Replay {
  const policy = options.policy ?? { kind: "stop" }
  const workspace = policy.kind === "stop" ? null : checkWorkspace(tape.cwd, policy)
  const matcher = new TapeMatcher(tape, options)
  const toolNames = new Set(options.tools.map((tool) => tool.name))
  const effects = new Map((workspace?.runtime.tools ?? options.tools).map((tool) => [tool.name, tool.effect]))
  let status: ReplayStatus = tape.steps.length === 0 ? "finished" : "on_tape"
  let reason: string | null = null
  let unsupported: TapeInput | null = null
  let stopDivergence: Divergence | null = null
  const counts = { steps: 0, callsByTool: {} as Record<string, number>, offSteps: 0, offCalls: 0, executed: 0 }
  let lastStep: ReplaySnapshot["lastStep"] = null
  let usage: Usage | null = null

  const stop = (divergence: Divergence, why: string | null = null) => {
    if (status === "stopped") return
    status = "stopped"
    reason = why
    stopDivergence = divergence
    options.onStop?.(divergence)
  }

  const answer = async (match: CallMatch, call: ToolCall, hooks: RunHooks): Promise<ToolCallOutcome> => {
    if (match.kind === "matched") return recordedOutcome(match.recorded, toolNames, hooks)
    if (match.kind === "dropped") return notStarted(DROPPED_OUTPUT)
    if (match.kind === "diverged" && policy.kind === "stop") stop(match.divergence)
    if (match.kind === "diverged" && status === "on_tape") status = "off_tape"
    if (status === "stopped" || workspace === null) return notStarted(STOPPED_OUTPUT)
    const effect = effects.get(call.name) ?? null
    // An unknown tool is refused by the runtime before anything runs.
    if (policy.kind === "execute-read-only" && effect !== null && effect !== "read") {
      stop(matcher.divergence!, `${call.name} has effect ${effect}; execute-read-only runs only read tools`)
      return notStarted(STOPPED_OUTPUT)
    }
    if (effect !== null && effect !== "read" && namesOriginal(call.argumentsText, tape.cwd)) {
      stop(matcher.divergence!, `${call.name} names the original workspace ${tape.cwd} in its arguments`)
      return notStarted(STOPPED_OUTPUT)
    }
    counts.executed += 1
    return workspace.runtime.run({ ...call, context: { ...call.context, cwd: workspace.cwd } }, hooks)
  }

  const snapshot = (): ReplaySnapshot => ({
    status,
    reason,
    divergence: matcher.divergence ?? stopDivergence,
    matched: matcher.matched,
    steps: counts.steps,
    callsByTool: { ...counts.callsByTool },
    lastStep,
    usage,
    offTape: { steps: counts.offSteps, calls: counts.offCalls, executed: counts.executed },
    unsupported,
  })

  const runAll: ToolRuntime["runAll"] = (calls, hooks = {}) => {
    const matches = matcher.matchCalls(calls.map((call) => ({ name: call.name, argumentsText: call.argumentsText })))
    return Promise.all(matches.map((match, index) => answer(match, calls[index]!, { onStart: () => hooks.onStart?.(index) })))
  }

  return {
    tape,
    executor: {
      tools: options.tools,
      runAll,
      // A single call is a step of its own to the matcher; give a step's calls to `runAll` together.
      run: async (call, hooks = {}) => (await runAll([call], { onStart: () => hooks.onStart?.() }))[0]!,
    },
    get status() {
      return status
    },
    get divergence() {
      return matcher.divergence
    },
    takeInputs: () => {
      if (status !== "on_tape" && status !== "finished") return []
      const due = matcher.takeInputs()
      const blocked = due.findIndex((input) => input.kind === "unsupported")
      if (blocked === -1) return due
      status = "unsupported"
      unsupported = due[blocked]!
      return due.slice(0, blocked)
    },
    endStep: (observed) => {
      counts.steps += 1
      for (const call of observed.calls) counts.callsByTool[call.name] = (counts.callsByTool[call.name] ?? 0) + 1
      lastStep = { text: observed.text, calls: observed.calls.length }
      if (observed.usage !== null) usage = addUsage(usage, observed.usage)
      const wasOff = status === "off_tape"
      const verdict = matcher.endStep({ calls: observed.calls.length, text: observed.text })
      if (wasOff) {
        counts.offSteps += 1
        counts.offCalls += observed.calls.length
      }
      if (status === "stopped" || status === "unsupported" || status === "incomplete")
        return { action: "stop", interrupted: null }
      if (verdict.kind === "diverged") {
        if (policy.kind === "stop") stop(verdict.divergence)
        else status = observed.calls.length > 0 ? "off_tape" : "finished"
        return { action: status === "off_tape" ? "continue" : "stop", interrupted: null }
      }
      if (verdict.kind === "off_tape") {
        if (observed.calls.length > 0) return { action: "continue", interrupted: null }
        status = "finished"
        return { action: "stop", interrupted: null }
      }
      const interrupted = verdict.interrupted ? "user" : null
      if (verdict.kind === "finished") {
        status = "finished"
        return { action: "stop", interrupted }
      }
      return { action: "continue", interrupted }
    },
    fail: (why) => {
      status = "incomplete"
      reason = why
    },
    snapshot,
    report: () => buildReport(tape, snapshot()),
  }
}

/** The recorded settlement as the runtime would have returned it, calling `onStart` iff the recorded call started. */
function recordedOutcome(call: TapeCall, toolNames: ReadonlySet<string>, hooks: RunHooks): ToolCallOutcome {
  const settlement = call.settlement
  const base = { output: settlement.output, truncation: settlement.truncation, attachments: settlement.attachments, display: settlement.display }
  if (call.started !== null) hooks.onStart?.()
  switch (settlement.outcome) {
    case "not_started":
      return { kind: "not_started", settlement: { ...base, outcome: "not_started" } }
    case "effect_unknown":
      return { kind: "crashed", error: new Error("replayed: the recorded call settled effect_unknown"), settlement: { ...base, outcome: "effect_unknown" } }
    case "success":
      return { kind: "completed", settlement: { ...base, outcome: "success" } }
    case "error":
      if (call.started !== null) return { kind: "completed", settlement: { ...base, outcome: "error" } }
      // Refused before it ran. The reason is not stored; it is reconstructed for display only.
      return {
        kind: "refused",
        reason: !toolNames.has(call.name) ? "unknown_tool" : parseArguments(call.input).ok ? "invalid_arguments" : "malformed_arguments",
        settlement: { ...base, outcome: "error" },
      }
  }
}

function notStarted(output: string): ToolCallOutcome {
  return { kind: "not_started", settlement: { outcome: "not_started", output, truncation: null, attachments: [], display: null } }
}

/**
 * The override must be an existing absolute directory that neither is, nor
 * contains, nor lies inside the original workspace, compared on real paths
 * (symlinks resolved) when the original exists on this machine.
 */
function checkWorkspace(original: string, policy: Exclude<ReplayPolicy, { kind: "stop" }>): ReplayWorkspace {
  const workspace = (policy as { workspace?: ReplayWorkspace }).workspace
  if (workspace === undefined || workspace === null)
    throw new Error(`replay policy ${policy.kind} needs an explicit workspace override; only stop runs without one`)
  if (!isAbsolute(workspace.cwd)) throw new Error(`the replay workspace ${workspace.cwd} must be an absolute path`)
  if (!existsSync(workspace.cwd)) throw new Error(`the replay workspace ${workspace.cwd} does not exist`)
  const copy = realpathSync(workspace.cwd)
  const originals = [resolve(original), ...(existsSync(original) ? [realpathSync(original)] : [])]
  for (const path of originals)
    if (overlaps(copy, path) || overlaps(resolve(workspace.cwd), path))
      throw new Error(`the replay workspace ${workspace.cwd} overlaps the recorded workspace ${original}; use a copy elsewhere`)
  return workspace
}

function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const path = relative(parent, child)
    return path === "" || (!path.startsWith("..") && !isAbsolute(path))
  }
  return inside(a, b) || inside(b, a)
}

function namesOriginal(argumentsText: string, original: string): boolean {
  const paths = [resolve(original), ...(existsSync(original) ? [realpathSync(original)] : [])]
  return paths.some((path) => path !== "/" && argumentsText.includes(path))
}

function addUsage(a: Usage | null, b: Usage): Usage {
  if (a === null) return b
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}
