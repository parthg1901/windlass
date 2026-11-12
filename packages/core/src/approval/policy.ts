/**
 * The approval policy a user chooses, and its configuration section.
 *
 * The section is validated here in the style of `config/schema.ts` (every key
 * optional, unknown keys rejected) so the integration can add it to
 * `configFile` as `approval: approvalSection`. It must NOT be merged with
 * `mergeConfigFiles`: a project file lives in the repository, which may come
 * from someone else, so it may only tighten what the user chose. Use
 * `resolveApprovalConfig(user, project)` instead.
 */
import { DecodeError, type Infer, type Validator, nonEmptyString, oneOf } from "../validate.ts"

/**
 * - `ask`: reads run; every write, command, network and MCP call asks.
 * - `auto`: reads, workspace edits and sandboxed commands run; anything that
 *   needs to leave the sandbox asks. Without a sandbox, commands ask.
 * - `full`: everything runs unsandboxed. Explicit opt-in, for containers and CI.
 *
 * Ordered from strictest to loosest.
 */
export const approvalModes = ["ask", "auto", "full"] as const
export const approvalMode = oneOf(approvalModes)
export type ApprovalMode = Infer<typeof approvalMode>

/**
 * What a decision that would ask becomes when no one is present to answer.
 * Neither choice runs the call: to run more unattended, choose a looser mode.
 * - `deny`: the call is refused with a reason the model sees, and the run goes on.
 * - `stop`: the call is refused and the run ends (an eval where a refusal would hide a problem).
 */
export const unattendedAction = oneOf(["deny", "stop"])
export type UnattendedAction = Infer<typeof unattendedAction>

/**
 * - `enforce`: untrusted content in the conversation makes outbound calls ask (see `taint.ts`).
 * - `off`: untrusted content changes nothing. Only for a throwaway container with nothing worth stealing.
 */
export const taintEnforcement = oneOf(["enforce", "off"])
export type TaintEnforcement = Infer<typeof taintEnforcement>

export const DEFAULT_APPROVAL: ApprovalPolicy = { mode: "auto", unattended: "deny", taint: "enforce", untrustedPaths: [] }

/** The effective policy. */
export interface ApprovalPolicy {
  readonly mode: ApprovalMode
  readonly unattended: UnattendedAction
  readonly taint: TaintEnforcement
  /**
   * Glob patterns (Bun.Glob syntax), relative to the workspace, of files whose
   * content is untrusted even though they are inside it: vendored or
   * downloaded code. `["**"]` treats the whole workspace as untrusted, for
   * reviewing a repository from someone else.
   */
  readonly untrustedPaths: readonly string[]
}

const KEYS = ["mode", "unattended", "taint", "untrustedPaths"] as const

const globList: Validator<readonly string[]> = (input, path) => {
  if (!Array.isArray(input)) throw new DecodeError(path, "array of glob patterns", input)
  return input.map((item, index) => {
    const pattern = nonEmptyString(item, `${path}[${index}]`)
    if (pattern.startsWith("!")) throw new DecodeError(`${path}[${index}]`, "a glob pattern (negation with '!' is not supported)", pattern)
    return pattern
  })
}

/** The `approval` section of a configuration file, as written. */
export const approvalSection: Validator<ApprovalSection> = (input, path) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new DecodeError(path, "object", input)
  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !(KEYS as readonly string[]).includes(key))
  if (unknown !== undefined) throw new DecodeError(join(path, unknown), `a known key (${KEYS.join(", ")})`, unknown)
  return {
    ...(record.mode === undefined ? {} : { mode: approvalMode(record.mode, join(path, "mode")) }),
    ...(record.unattended === undefined ? {} : { unattended: unattendedAction(record.unattended, join(path, "unattended")) }),
    ...(record.taint === undefined ? {} : { taint: taintEnforcement(record.taint, join(path, "taint")) }),
    ...(record.untrustedPaths === undefined ? {} : { untrustedPaths: globList(record.untrustedPaths, join(path, "untrustedPaths")) }),
  }
}

export interface ApprovalSection {
  readonly mode?: ApprovalMode
  readonly unattended?: UnattendedAction
  readonly taint?: TaintEnforcement
  readonly untrustedPaths?: readonly string[]
}

export interface ResolvedApproval {
  readonly policy: ApprovalPolicy
  /** Project settings that would have loosened the user's policy and were ignored, for the UI to show once. */
  readonly ignored: readonly string[]
}

/**
 * Combines the user's section (user file, or a command-line flag, which counts
 * as the user's) with the project's. The project can only tighten: the
 * stricter mode, `stop` over `deny`, `enforce` over `off`, and the union of
 * untrusted paths (a list that only adds taint, so it does not replace).
 */
export function resolveApprovalConfig(user: ApprovalSection | null, project: ApprovalSection | null): ResolvedApproval {
  const base: ApprovalPolicy = {
    mode: user?.mode ?? DEFAULT_APPROVAL.mode,
    unattended: user?.unattended ?? DEFAULT_APPROVAL.unattended,
    taint: user?.taint ?? DEFAULT_APPROVAL.taint,
    untrustedPaths: user?.untrustedPaths ?? DEFAULT_APPROVAL.untrustedPaths,
  }
  if (project === null) return { policy: base, ignored: [] }
  const ignored = [
    project.mode !== undefined && modeRank(project.mode) > modeRank(base.mode) ? `mode "${project.mode}" (the user's is "${base.mode}")` : null,
    project.unattended === "deny" && base.unattended === "stop" ? `unattended "deny" (the user's is "stop")` : null,
    project.taint === "off" && base.taint === "enforce" ? `taint "off" (the user's is "enforce")` : null,
  ].filter((item) => item !== null)
  return {
    policy: {
      mode: project.mode !== undefined && modeRank(project.mode) < modeRank(base.mode) ? project.mode : base.mode,
      unattended: project.unattended === "stop" ? "stop" : base.unattended,
      taint: project.taint === "enforce" ? "enforce" : base.taint,
      untrustedPaths: [...new Set([...base.untrustedPaths, ...(project.untrustedPaths ?? [])])],
    },
    ignored,
  }
}

/** 0 for the strictest mode. */
export function modeRank(mode: ApprovalMode): number {
  return approvalModes.indexOf(mode)
}

function join(path: string, key: string) {
  return path === "" ? key : `${path}.${key}`
}
