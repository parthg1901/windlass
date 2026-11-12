/**
 * Hooks, as the step loop offers them (`hooks/` has the module).
 *
 * - A hook is a command from a configuration file. Nothing of it is in a
 *   request: no tool, no spec and no system-prompt text depends on which
 *   hooks exist, so the hook set never touches the frozen prefix. What a
 *   hook says to the model is part of something that is appended anyway:
 *   the result of the call it refused, a note after a result, a harness
 *   message that sends the model back.
 * - Before a call is decided (after the agent's restrictions, before the
 *   approval layer) the before hooks that apply are run; the first that
 *   objects settles the call as an error with its reason, and a hook that
 *   does not object approves nothing: the approval layer decides next.
 * - After a tool ran and before its result is capped and stored, the after
 *   hooks that apply may each add a note (`tool/runtime.ts`, `afterExecute`).
 * - When the verification gate says the turn may end, the stop hooks are
 *   asked; one that objects sends the model back with its message, at most
 *   `maxStopRounds` times per turn, counted from the log.
 * - Each hook that applied is recorded as `hook.ran`, in the append of what
 *   it decided.
 *
 * **Whose hook may run.** A hook of the user's own file runs. A hook the
 * project's file names does not until the user approved exactly that hook:
 * the approval is a remembered approval for the project like an MCP
 * server's (`approval/grants.ts`: a `tool` rule that names the hook's
 * fingerprint, under the data directory, 30 days), so an edited hook is a
 * new question. Until then the hook is skipped and the user is told once.
 * Nobody present, nothing is asked and nothing of the project's runs.
 */
import { type Grant, type GrantRule, PROJECT_GRANT_TTL_MS } from "../approval/grants.ts"
import { type HookRecordData, type NewEvent, event } from "../event/durable.ts"
import { type Hook, type HooksConfig, NO_HOOKS, resolveHooksConfig } from "../hooks/config.ts"
import type { HookRecord } from "../hooks/points.ts"
import type { HookRunner } from "../hooks/run.ts"
import { STDERR_KEPT_CHARS } from "../hooks/run.ts"
import { pendingHookApprovals } from "../hooks/trust.ts"
import type { CallId, MessageId } from "../id.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to run hooks. Everything has a default; tests pass their own. */
export interface HooksSetup {
  /**
   * Runs one hook's command. Default: the module's runner
   * (`createHookRunner`), with the engine's sandbox and its redaction.
   */
  readonly runner?: HookRunner
}

/** What a client shows for a project's hook that waits for the user's approval. */
export interface HookQuestion {
  readonly name: string
  readonly point: Hook["point"]
  /** Identifies this definition of the hook: what `approveHook` takes, and what the approval is remembered for. */
  readonly fingerprint: string
  /** The command, whole and word for word: what approving it runs. A line (or several) a shell reads, so it has no argument list. */
  readonly command: string
  /** The whole question as the module words it, for a client that shows it as it is. */
  readonly question: string
}

/** The hooks of a session, for a client to show. */
export interface HooksState {
  /** The hooks in force: the user's first, then the project's, per point, with the stop bound. */
  readonly config: HooksConfig
  /** The project's hooks that wait for the user's approval and are not run. */
  readonly awaiting: readonly HookQuestion[]
}

const PREFIX = "hook:"

/** The rule a remembered approval of a project's hook is stored as. */
export function hookGrantRule(fingerprint: string): GrantRule {
  return { kind: "tool", tool: `${PREFIX}${fingerprint}` }
}

/** The grant an approval of a project's hook writes, for `addProjectGrants`. */
export function hookGrant(fingerprint: string, now: number): Grant {
  return { scope: "project", rule: hookGrantRule(fingerprint), at: null, grantedAt: now }
}

/** The fingerprints of the project's hooks the user approved, from the project's remembered approvals. */
export function approvedHooks(grants: readonly Grant[], now: number): Set<string> {
  return new Set(
    grants.flatMap((item) => (item.scope === "project" && item.rule.kind === "tool" && item.rule.tool.startsWith(PREFIX) && now - item.grantedAt < PROJECT_GRANT_TTL_MS ? [item.rule.tool.slice(PREFIX.length)] : [])),
  )
}

/** The hooks a session's configuration names: the user's, then the project's. Throws `ConfigError`. */
export function sessionHooks(files: ConfigFiles | null): HooksConfig {
  const user = files?.user?.hooks
  const project = files?.project?.hooks
  return user === undefined && project === undefined ? NO_HOOKS : resolveHooksConfig(user, project)
}

/** Whether a configuration names a hook at all. */
export function hasHooks(config: HooksConfig): boolean {
  return config.beforeTool.length + config.afterTool.length + config.stop.length > 0
}

/** The questions about the project's hooks nobody approved yet, in configuration order. */
export function hookQuestions(config: HooksConfig, approved: ReadonlySet<string>): HookQuestion[] {
  return pendingHookApprovals(config, (hook) => approved.has(hook.fingerprint)).map((pending) => ({
    name: pending.hook.name,
    point: pending.hook.point,
    fingerprint: pending.fingerprint,
    command: pending.hook.command,
    question: pending.question,
  }))
}

/** One hook that applied, as the log records it. `call` is the call it applied to; `null` for a stop hook. */
export function hookRan(record: HookRecord, call: { readonly messageId: MessageId; readonly callId: CallId } | null): NewEvent<"hook.ran"> {
  const data: HookRecordData = {
    point: record.point,
    messageId: call?.messageId ?? null,
    callId: call?.callId ?? null,
    hookId: record.hookId,
    name: record.name,
    origin: record.origin,
    fingerprint: record.fingerprint,
    run: record.run.kind === "ran" ? { kind: "ran", sandbox: record.run.sandbox === null ? null : { network: record.run.sandbox.network, writableRoots: [...record.run.sandbox.writableRoots] } } : record.run,
    answer: record.answer,
    failure: record.failure,
    detail: record.detail,
    exitCode: record.exitCode,
    durationMs: record.durationMs === null ? null : Math.max(0, Math.round(record.durationMs)),
    toModel: record.toModel,
    // For the user: the end of it, at most what the runner keeps of stderr.
    forUser: record.forUser.length > STDERR_KEPT_CHARS ? record.forUser.slice(-STDERR_KEPT_CHARS) : record.forUser,
    taint: record.taint,
  }
  return event("hook.ran", data)
}

const POINT_WORDS: Record<Hook["point"], string> = { beforeTool: "before a tool call", afterTool: "after a tool call", stop: "when a turn is about to end" }

/**
 * What the user is told, once, about a project's hook that is not run. The command is shown whole and word for
 * word, every line of it: a command cut where the notice ran out of room hides its end, which is where what it
 * does to the machine is. (A hook's command is a line a shell reads, not an argument list: nothing is quoted.)
 */
export function skippedHookNotice(question: HookQuestion): string {
  return `This project's configuration asks to run the hook "${question.name}" ${POINT_WORDS[question.point]} (${question.command}). It is not run: a hook a project names runs only after you approve it.`
}

/**
 * What the user is told about a hook that could not answer, or `null` for one that did. `onError` is what the
 * hook's definition says becomes of a call when a before hook fails: the sentence says what happened to this call.
 */
export function failedHookNotice(record: HookRecord, onError: Hook["onError"] = "refuse"): string | null {
  if (record.answer !== "failed") return null
  const consequence =
    record.point === "beforeTool"
      ? onError === "allow"
        ? "The call went on without its answer, since the hook says `onError: \"allow\"`."
        : "A call it must allow is refused while it fails, unless the hook says `onError: \"allow\"`."
      : record.point === "afterTool"
        ? "Nothing was added to the result."
        : "The turn ended as it would have without it."
  return `The hook "${record.name}" (${POINT_WORDS[record.point]}) could not answer: ${record.detail ?? record.failure ?? "it failed"}. ${consequence}`
}
