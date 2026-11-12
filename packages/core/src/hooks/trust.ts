/**
 * Whose hook may run, and how. Pure.
 *
 * - A hook from the user's own configuration file is the user's: it runs without a question.
 * - A hook from a project's configuration file is a command the repository asks to run. It runs only after the
 *   user approved that exact hook: its fingerprint (`config.ts`, `hookFingerprint`) covers the point, the
 *   matchers, the command, the timeout and the error behaviour, so a hook that is edited, or moved to another
 *   point, needs approval again. Until then it is not run at all, and the work goes on as if it did not exist
 *   (the user is told it was skipped). Approvals are the user's, kept in the user's data directory, never in
 *   the repository.
 *
 * How a hook that may run is run, by the same rule as the model's own commands and the project's checks:
 * - in the sandbox, with no network and no extra directory, in `ask` and `auto`, and in `full` once the
 *   session is tainted (the hook is handed text the model wrote);
 * - unsandboxed in `full` while the session is untainted;
 * - a user's hook with `sandbox: false` always runs unsandboxed: the user chose to give it their rights;
 * - where the machine has no sandbox: a user's hook runs unsandboxed (it is the user's own command, like a
 *   git hook; the model's commands would ask and then run unsandboxed too), and a project's hook cannot run,
 *   which is a failure with the point's safe outcome (a project's checks are not run there either).
 */
import type { ApprovalMode } from "../approval/policy.ts"
import type { SandboxRun } from "../tool/tool.ts"
import type { Hook, HooksConfig } from "./config.ts"

export interface HookTrustContext {
  readonly mode: ApprovalMode
  readonly tainted: boolean
  readonly sandboxAvailable: boolean
  /** Whether the user approved this project hook (by `hook.fingerprint`). Never asked for a user's hook. */
  readonly isApproved: (hook: Hook) => boolean
}

export type HookRunPlan =
  /** `sandbox: null` runs it unsandboxed. */
  | { readonly kind: "run"; readonly sandbox: SandboxRun | null }
  /** A project hook the user has not approved: not run, as if it did not exist. */
  | { readonly kind: "skip"; readonly reason: "not_approved" }
  /** It should run and cannot: the point's safe outcome for a failure applies. */
  | { readonly kind: "cannot_run"; readonly message: string }

const OFFLINE: SandboxRun = { network: false, writableRoots: [] }

export function planHookRun(hook: Hook, context: HookTrustContext): HookRunPlan {
  if (hook.origin === "project" && !context.isApproved(hook)) return { kind: "skip", reason: "not_approved" }
  if (hook.origin === "user" && !hook.sandbox) return { kind: "run", sandbox: null }
  const sandboxed = context.mode !== "full" || context.tainted
  if (!sandboxed) return { kind: "run", sandbox: null }
  if (context.sandboxAvailable) return { kind: "run", sandbox: OFFLINE }
  if (hook.origin === "user") return { kind: "run", sandbox: null }
  return { kind: "cannot_run", message: "a project's hook runs only in the sandbox, and this machine has none" }
}

/** One project hook waiting for the user's approval, with the question to put. */
export interface HookApprovalRequest {
  readonly hook: Hook
  readonly fingerprint: string
  /** Shown to the user word for word; record it in the question event as shown. */
  readonly question: string
}

/**
 * The project's hooks the user has not approved, in configuration order. The engine asks about them when an
 * execution starts (where the configuration is read), one question per hook.
 */
export function pendingHookApprovals(config: HooksConfig, isApproved: (hook: Hook) => boolean): HookApprovalRequest[] {
  return [...config.beforeTool, ...config.afterTool, ...config.stop]
    .filter((hook) => hook.origin === "project" && !isApproved(hook))
    .map((hook) => ({ hook, fingerprint: hook.fingerprint, question: approvalQuestion(hook) }))
}

const POINT_WORDS: Record<Hook["point"], string> = {
  beforeTool: "before a tool call runs, and can refuse the call",
  afterTool: "after a tool call has its result, and can add a note to the result",
  stop: "when a turn is about to end, and can send the agent back to work",
}

export function approvalQuestion(hook: Hook): string {
  const lines = [`This project's configuration asks to run a hook "${hook.name}" ${POINT_WORDS[hook.point]}:`, "", `    ${hook.command.split("\n").join("\n    ")}`, ""]
  if (hook.point !== "stop")
    lines.push(`It applies to ${hook.tools === null ? "every tool" : `the tools ${hook.tools.join(", ")}`}${hook.paths === null ? "" : `, for paths matching ${hook.paths.join(", ")}`}.`)
  lines.push(`It runs in the sandbox with no network (outside it only in the full mode), for at most ${hook.timeoutSeconds} seconds each time. Allow it for this project? If the hook is changed, you will be asked again.`)
  return lines.join("\n")
}

/**
 * What the taint layer should be told about a hook whose text reached the model (a refusal reason, a note, a
 * message that sent the model back). A hook's output is content the harness does not control, judged like a
 * command's output:
 * - a hook that ran in the sandbox without network: not a source, as a sandboxed offline command is not;
 * - a user's hook with `sandbox: false`: a source (`network-command`-like: it ran with the network by a grant);
 * - a project's hook when the repository is untrusted (`approval.untrustedPaths` matches the project's
 *   configuration file, e.g. `["**"]`): a source, like an untrusted file;
 * - any hook run unsandboxed because the mode is `full`: not a source, the same stated gap as commands in `full`.
 */
export function hookTaints(input: {
  readonly hook: Pick<Hook, "origin" | "sandbox">
  readonly ran: SandboxRun | null
  readonly reachedModel: boolean
  readonly untrustedRepository: boolean
}): "hook-network" | "hook-untrusted-project" | null {
  if (!input.reachedModel) return null
  // Hooks never get the network in the sandbox; only a user's `sandbox: false` hook is given it, by the user.
  if (input.ran === null ? input.hook.origin === "user" && !input.hook.sandbox : input.ran.network) return "hook-network"
  if (input.hook.origin === "project" && input.untrustedRepository) return "hook-untrusted-project"
  return null
}
