/**
 * The three points, put together: for each hook that applies, decide whether and how it may run
 * (`trust.ts`), run it (`HookRunner`), read its answer (`answer.ts`) and decide (`decide.ts`). Hooks of one point
 * run one after another, in configuration order (the user's, then the project's): two formatters on one file
 * must not race, and the first refusal ends a before point without running the rest.
 *
 * Each function returns what the engine needs and, as `records`, one `HookRecord` per hook that applied:
 * the facts to store durably as fields. Nothing here writes anything.
 */
import type { Json } from "../json.ts"
import type { SandboxRun, ToolResult } from "../tool/tool.ts"
import { ANSWER_LIMITS, type HookAnswer, type HookFailure, type HookProcessResult, parseAnswer } from "./answer.ts"
import type { Hook, HookOrigin, HookPoint } from "./config.ts"
import { type AppliedNotes, type BeforeDecision, type HookVerdict, type StopDecision, applyAfterNotes, beforeVerdict, decideStop } from "./decide.ts"
import { type HookEvent, hookEvent, tooLargeDetail } from "./event.ts"
import { type CallTarget, hooksFor, relativePaths } from "./match.ts"
import type { HookRunner } from "./run.ts"
import { type HookTrustContext, hookTaints, planHookRun } from "./trust.ts"

export interface HookPointContext {
  readonly runner: HookRunner
  readonly trust: HookTrustContext
  readonly cwd: string
  readonly sessionId: string
  readonly signal: AbortSignal
  /** Whether the project is untrusted as a whole (`approval.untrustedPaths` matches its configuration file). */
  readonly untrustedRepository: boolean
}

/** One hook that applied, as it should be recorded. Fields, never parsed text. */
export interface HookRecord {
  readonly point: HookPoint
  readonly hookId: string
  readonly name: string
  readonly origin: HookOrigin
  readonly fingerprint: string
  /** `skipped`: a project hook the user has not approved. `cannot_run`: it should have run and could not. */
  readonly run: { readonly kind: "ran"; readonly sandbox: SandboxRun | null } | { readonly kind: "skipped"; readonly reason: "not_approved" } | { readonly kind: "cannot_run" }
  readonly answer: HookAnswer["kind"] | "skipped"
  readonly failure: HookFailure | null
  /** Why it failed, for the user. */
  readonly detail: string | null
  readonly exitCode: number | null
  readonly durationMs: number | null
  /** The hook's own text that reached the model (a reason, a note, a message), or `null`. */
  readonly toModel: string | null
  /** What it printed on stderr, and on stdout when that was not shown to the model: for the user only. */
  readonly forUser: string
  /** What to tell the taint layer (`hookTaints`), when its text reached the model. */
  readonly taint: ReturnType<typeof hookTaints>
}

export interface ToolCallInput {
  readonly tool: string
  readonly callId: string
  /** The validated arguments, as recorded in `tool.called`. Only read. */
  readonly arguments: Json
  /** `Tool.touches(input)` of the call, or `null` when the tool names no paths. */
  readonly paths: readonly string[] | null
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * The before point. Call it after the arguments were accepted and before the approval decision: a refusal
 * then settles the call without a question. `allow` is no objection, never an approval.
 *
 * A hook is asked only about a call its event carries whole. When a value is over a limit of the event
 * (`HookEvent.omitted`: a long command, long arguments, a long list of paths) the hook is not run and its answer
 * is `failed`, so the call is refused unless the hook says `onError: "allow"`: an exit 0 from a hook that was
 * shown an empty variable is not "no objection".
 */
export async function runBeforeHooks(context: HookPointContext, hooks: readonly Hook[], call: ToolCallInput): Promise<{ readonly decision: BeforeDecision; readonly records: readonly HookRecord[] }> {
  const target = targetOf(context, call)
  const records: HookRecord[] = []
  for (const hook of hooksFor(hooks, target)) {
    const event = hookEvent({ point: "beforeTool", sessionId: context.sessionId, cwd: context.cwd, hook, tool: factsOf(call, target) })
    const { answer, record } = await runOne(context, hook, event, ANSWER_LIMITS.beforeTool, tooLargeDetail(event))
    const decision = beforeVerdict({ hook, answer })
    const toModel = decision.kind === "refuse" ? (answer.kind === "no" ? answer.text : null) : null
    records.push(finish(context, hook, record, toModel))
    if (decision.kind !== "allow") return { decision, records }
  }
  return { decision: { kind: "allow" }, records }
}

/**
 * The after point. Call it with the tool's result as `execute` returned it (and as redaction made it), before
 * the runtime caps it and before `tool.settled`: the notes are then capped, stored and replayed with it.
 */
export async function runAfterHooks(
  context: HookPointContext,
  hooks: readonly Hook[],
  call: ToolCallInput,
  result: ToolResult,
): Promise<{ readonly result: ToolResult; readonly applied: AppliedNotes; readonly records: readonly HookRecord[] }> {
  const target = targetOf(context, call)
  const verdicts: HookVerdict[] = []
  const pending: { readonly hook: Hook; readonly record: Omit<HookRecord, "toModel" | "taint">; readonly answer: HookAnswer }[] = []
  for (const hook of hooksFor(hooks, target)) {
    const event = hookEvent({ point: "afterTool", sessionId: context.sessionId, cwd: context.cwd, hook, tool: factsOf(call, target), result: { status: result.status, output: result.output } })
    const { answer, record } = await runOne(context, hook, event, ANSWER_LIMITS.afterTool)
    verdicts.push({ hook, answer })
    pending.push({ hook, record, answer })
    if (answer.kind === "interrupted") break
  }
  const applied = applyAfterNotes(result, verdicts)
  const records = pending.map(({ hook, record, answer }) => finish(context, hook, record, applied.noted.includes(hook) && answer.kind === "no" ? answer.text : null))
  return { result: applied.result, applied, records }
}

/**
 * The stop point. Call it when the turn may end by every other rule (after the verification gate said so; see
 * README.md), with the rounds already sent in this turn counted from the log (`stopRoundsSent`).
 */
export async function runStopHooks(
  context: HookPointContext,
  hooks: readonly Hook[],
  turn: { readonly roundsSent: number; readonly maxRounds: number; readonly lastText: string },
): Promise<{ readonly decision: StopDecision; readonly records: readonly HookRecord[] }> {
  const verdicts: HookVerdict[] = []
  const pending: { readonly hook: Hook; readonly record: Omit<HookRecord, "toModel" | "taint">; readonly answer: HookAnswer }[] = []
  for (const hook of hooks) {
    if (hook.point !== "stop") continue
    const event = hookEvent({ point: "stop", sessionId: context.sessionId, cwd: context.cwd, hook, round: turn.roundsSent + 1, maxRounds: turn.maxRounds, lastText: turn.lastText })
    const { answer, record } = await runOne(context, hook, event, ANSWER_LIMITS.stop)
    verdicts.push({ hook, answer })
    pending.push({ hook, record, answer })
    if (answer.kind === "interrupted") break
  }
  const decision = decideStop({ verdicts, roundsSent: turn.roundsSent, maxRounds: turn.maxRounds })
  const records = pending.map(({ hook, record, answer }) => finish(context, hook, record, decision.kind === "continue" && answer.kind === "no" ? answer.text : null))
  return { decision, records }
}

// ---------------------------------------------------------------------------------------------------------------

/** `unasked`: why the hook must not be asked with this event (the before point, a call too large to show), or `null`. */
async function runOne(context: HookPointContext, hook: Hook, event: HookEvent, limit: number, unasked: string | null = null): Promise<{ readonly answer: HookAnswer; readonly record: Omit<HookRecord, "toModel" | "taint"> }> {
  const base = { point: hook.point, hookId: hook.id, name: hook.name, origin: hook.origin, fingerprint: hook.fingerprint }
  const plan = planHookRun(hook, context.trust)
  if (plan.kind === "skip")
    return {
      // Not approved: as if it did not exist. `yes` is the answer that changes nothing at every point.
      answer: { kind: "yes" },
      record: { ...base, run: { kind: "skipped", reason: plan.reason }, answer: "skipped", failure: null, detail: null, exitCode: null, durationMs: null, forUser: "" },
    }
  const result: HookProcessResult =
    plan.kind === "cannot_run"
      ? { kind: "cannot_run", message: plan.message }
      : unasked !== null
        ? context.signal.aborted
          ? { kind: "interrupted" }
          : { kind: "cannot_run", message: unasked }
        : await context.runner({ hook, event, cwd: context.cwd, sessionId: context.sessionId, sandbox: plan.sandbox, signal: context.signal })
  const answer = parseAnswer(result, limit)
  const exited = result.kind === "exited" ? result : null
  const forUser = [exited !== null && exited.exitCode === 0 ? exited.stdout.trim() : "", "stderr" in result ? result.stderr : ""].filter((text) => text !== "").join("\n")
  return {
    answer,
    record: {
      ...base,
      run: plan.kind === "run" && result.kind !== "cannot_run" ? { kind: "ran", sandbox: plan.sandbox } : { kind: "cannot_run" },
      answer: answer.kind,
      failure: answer.kind === "failed" ? answer.failure : null,
      detail: answer.kind === "failed" ? answer.detail : null,
      exitCode: exited?.exitCode ?? null,
      durationMs: "durationMs" in result ? result.durationMs : null,
      forUser,
    },
  }
}

function finish(context: HookPointContext, hook: Hook, record: Omit<HookRecord, "toModel" | "taint">, toModel: string | null): HookRecord {
  const reachedModel = toModel !== null && toModel !== ""
  const taint = record.run.kind === "ran" ? hookTaints({ hook, ran: record.run.sandbox, reachedModel, untrustedRepository: context.untrustedRepository }) : null
  return { ...record, toModel, taint }
}

function targetOf(context: HookPointContext, call: ToolCallInput): CallTarget {
  return { tool: call.tool, paths: call.paths, cwd: context.cwd }
}

function factsOf(call: ToolCallInput, target: CallTarget) {
  return { name: call.tool, callId: call.callId, arguments: call.arguments, paths: call.paths === null ? null : relativePaths(target) }
}
