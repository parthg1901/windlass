/**
 * What the step loop needs around the approval layer (`approval/`), which is
 * pure: the lookups and the writes. The facts a decision is made from, the
 * project's remembered approvals on disk, and what happens to a tool's output
 * before it is stored (the sandbox hint, the redaction).
 *
 * Nothing here decides anything: `decide` does, from what this file hands it.
 */
import { mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { type CallFacts } from "../approval/decide.ts"
import { type Escalation, escalationFacts, escalationRequest, sandboxHint } from "../approval/escalation.ts"
import { type Grant, PROJECT_GRANT_TTL_MS, grant } from "../approval/grants.ts"
import { type PathContext, type PathFact, isWithin, pathFact } from "../approval/paths.ts"
import { type ApprovalPolicy, type ApprovalSection, type ResolvedApproval, resolveApprovalConfig } from "../approval/policy.ts"
import { type CallRun, type SandboxRunRecord } from "../approval/record.ts"
import { redact, redactPieces } from "../approval/redact.ts"
import { CLEAN, type TaintState } from "../approval/taint.ts"
import type { Json } from "../json.ts"
import { type CommandSandbox, createCommandSandbox } from "../sandbox/command.ts"
import { defaultHiddenPaths, isCredentialName } from "../sandbox/policy.ts"
import type { AnyTool, RedactedText, TempDirectory } from "../tool/tool.ts"
import { tempPath } from "../tools/common.ts"
import { array, object, safeDecode, string } from "../validate.ts"

/**
 * How an engine is told to apply the approval layer. Everything has a
 * default that is safe on a user's machine; tests pass their own.
 */
export interface ApprovalSetup {
  /** The sandbox commands run in. Default: `createCommandSandbox()`, which probes this machine once. */
  readonly sandbox?: CommandSandbox
  /**
   * The user's own settings where no file gives them: what a command-line
   * flag of the process says. A session's own choice (`setApproval`) goes on
   * top; the project file can only tighten the result.
   */
  readonly user?: ApprovalSection
  /**
   * Values removed from every tool output wherever they occur. Default: the
   * values of this process's environment variables whose names look like
   * credentials (`isCredentialName`), read once, when the engine is made.
   */
  readonly secrets?: readonly string[]
  /** Where the approvals remembered for a project are kept. Default: `<dataDir>/approvals`. */
  readonly grantsDir?: string
  readonly home?: string
}

/** The setup with its defaults applied; the sandbox is made on first use. */
export interface Approvals {
  readonly sandbox: () => CommandSandbox
  readonly user: ApprovalSection | null
  readonly secrets: readonly string[]
  readonly grantsDir: string
  readonly home: string
  readonly hiddenPaths: readonly string[]
  /** The harness's own directories whose files are the session's and not a credential store: tool output kept in full. */
  readonly trustedRoots: readonly string[]
}

export function resolveApprovals(setup: ApprovalSetup, dataDir: string, spillDir: string): Approvals {
  const home = setup.home ?? homedir()
  let sandbox = setup.sandbox ?? null
  return {
    sandbox: () => (sandbox ??= createCommandSandbox({ home })),
    user: setup.user ?? null,
    secrets: setup.secrets ?? environmentSecrets(process.env),
    grantsDir: setup.grantsDir ?? join(dataDir, "approvals"),
    home,
    // The data directory is hidden whatever the environment says it is: a test's or a caller's own is hidden too.
    hiddenPaths: [...new Set([...defaultHiddenPaths({ home }), dataDir])],
    trustedRoots: [spillDir],
  }
}

/** The values of the environment variables whose names look like credentials. */
export function environmentSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  return [...new Set(Object.entries(env).flatMap(([name, value]) => (value !== undefined && value !== "" && isCredentialName(name) ? [value] : [])))]
}

/** The effective policy: the user's settings (file, then the process's flags, then the session's own choice), tightened by the project's. */
export function effectivePolicy(sections: { readonly file: ApprovalSection | null; readonly process: ApprovalSection | null; readonly session: ApprovalSection | null; readonly project: ApprovalSection | null }): ResolvedApproval {
  return resolveApprovalConfig({ ...sections.file, ...sections.process, ...sections.session }, sections.project)
}

// ---------------------------------------------------------------- facts

const readlink = (path: string) => {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

export interface FactContext {
  readonly cwd: string
  /** The session's temp directory, when sandboxed commands of this session use one. */
  readonly temp: TempDirectory | undefined
  readonly approvals: Approvals
}

/**
 * The directory the approvals of what a project's configuration file names
 * are kept under: its hooks, its MCP servers, its language servers. It is
 * the project's own directory, where the file is, and not the directory a
 * session happens to work in:
 *
 * - a session started in a subdirectory of the project reads the same file,
 *   so it is under the same approvals;
 * - a session in a worktree of the harness's own (a subagent with
 *   `worktree`, and whatever works in that worktree after it) reads the
 *   worktree's copy of the file. It is the same project, so the directory
 *   is the one the worktree's stands for in the repository it belongs to.
 *
 * An approval is the user's answer about a project. Were it kept under the
 * working directory, a choice the model makes (a worktree, a subdirectory)
 * would move a session out from under it: a hook the user approved would be
 * skipped as "not approved", and the call it guards would run.
 */
export function projectApprovalHome(input: { readonly cwd: string; readonly projectDir: string | null; readonly worktree: { readonly path: string; readonly repository: string } | null }): string {
  const own = realWorkspace(input.projectDir ?? input.cwd)
  if (input.worktree === null) return own
  const inside = relative(realWorkspace(input.worktree.path), own)
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return own
  return realWorkspace(join(input.worktree.repository, inside))
}

/** The session's working directory with links followed, or as given when it does not exist. */
export function realWorkspace(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

function pathContext(context: FactContext): PathContext {
  return { cwd: context.cwd, workspace: context.cwd, home: context.approvals.home, hiddenPaths: context.approvals.hiddenPaths, readlink }
}

/**
 * Classifies one path of a call. A path under the temp directory's alias is
 * the file a command means by it. Two places are the session's own although
 * they lie outside the workspace: its temp directory, which its sandboxed
 * commands write anyway, and the harness's files of tool output kept in
 * full. Their content is what the session's own commands produced, so they
 * neither ask nor taint.
 */
export function classify(given: string, context: FactContext): PathFact {
  const fact = pathFact(tempPath(context.temp, given, context.cwd), pathContext(context))
  const real = fact.real
  if (real === null || fact.place === "workspace" || fact.place === "protected") return { ...fact, given }
  const own = [...(context.temp === undefined ? [] : [context.temp.dir]), ...context.approvals.trustedRoots].map(realWorkspace)
  return own.some((root) => isWithin(root, real)) ? { given, real, place: "workspace", relative: null } : { ...fact, given }
}

/** What `decide` is told about one call, or the reason its arguments cannot be decided on. */
export function callFacts(tool: AnyTool, input: Json, context: FactContext): { readonly facts: CallFacts } | { readonly invalid: string } {
  const record = fields(input) ?? {}
  const touched = (() => {
    try {
      return (tool.touches as ((input: unknown) => readonly string[]) | undefined)?.(input) ?? []
    } catch {
      return []
    }
  })()
  const paths = touched.filter((path) => typeof path === "string" && path !== "").map((path) => classify(path, context))
  let escalation: Escalation | null = null
  if (tool.effect === "exec") {
    const asked = safeDecode(escalationRequest, record.sandbox)
    if (!asked.ok) return { invalid: `the \`sandbox\` argument is not valid: ${asked.error.message}` }
    if (asked.value !== null) escalation = escalationFacts({ network: asked.value.network, write: asked.value.write.map((path) => tempPath(context.temp, path, context.cwd)) }, pathContext(context))
  }
  // What the tool says about this very call. A tool's own code must never keep a call from being decided.
  const said = <T>(read: ((input: never) => T) | undefined, fallback: T): T => {
    try {
      return read === undefined ? fallback : (read as (input: unknown) => T)(input)
    } catch {
      return fallback
    }
  }
  const subject = said(tool.subject, tool.name)
  // Only a built-in tool is believed, and only about a class that changes something: an MCP server's tool is asked
  // about by name whatever it says. A call that changes only records runs no command, whatever its input carries.
  const changed = typeof tool.changes === "function" ? said(tool.changes, null) : (tool.changes ?? null)
  const records = changed === "records" && (tool.effect === "write" || tool.effect === "exec") && (tool.origin ?? "builtin") === "builtin"
  const cautions = said(tool.cautions, [] as readonly string[]).filter((line) => typeof line === "string" && line !== "")
  return {
    facts: {
      tool: typeof subject === "string" && subject !== "" ? subject : tool.name,
      effect: tool.effect,
      origin: tool.origin ?? "builtin",
      paths,
      command: tool.effect === "exec" && !records && typeof record.command === "string" ? record.command : null,
      escalation: records ? null : escalation,
      ...(records ? { changes: "records" as const } : {}),
      ...(cautions.length === 0 ? {} : { cautions }),
    },
  }
}

/** What `tool.started` records for a call the decision let run. */
export function runRecord(policy: ApprovalPolicy, facts: CallFacts, sandbox: SandboxRunRecord | null): CallRun {
  return { mode: policy.mode, origin: facts.origin, paths: [...facts.paths], sandbox }
}

// ---------------------------------------------------------------- project grants

const grantFile = object({ workspace: string, grants: array(grant) })

function grantPath(dir: string, workspace: string) {
  return join(dir, `${new Bun.CryptoHasher("sha256").update(workspace).digest("hex").slice(0, 32)}.json`)
}

/**
 * The approvals remembered for the project at `workspace` (its real path)
 * that have not expired. They live in the user's data directory, which a
 * sandboxed command cannot see, never in the repository.
 */
export function readProjectGrants(dir: string, workspace: string, now: number): Grant[] {
  try {
    const decoded = safeDecode(grantFile, JSON.parse(readFileSync(grantPath(dir, workspace), "utf8")))
    if (!decoded.ok || decoded.value.workspace !== workspace) return []
    return decoded.value.grants.filter((item) => item.scope === "project" && now - item.grantedAt < PROJECT_GRANT_TTL_MS)
  } catch {
    return []
  }
}

/** Adds project approvals to the project's file: written aside and renamed, so a reader never sees half of it. */
export function addProjectGrants(dir: string, workspace: string, added: readonly Grant[], now: number): void {
  const kept = readProjectGrants(dir, workspace, now)
  const known = new Set(kept.map((item) => JSON.stringify(item.rule)))
  const grants = [...kept, ...added.filter((item) => item.scope === "project" && !known.has(JSON.stringify(item.rule)))]
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = grantPath(dir, workspace)
  const aside = `${path}.${process.pid}.tmp`
  writeFileSync(aside, JSON.stringify({ workspace, grants }, null, 2), { mode: 0o600 })
  renameSync(aside, path)
}

// ---------------------------------------------------------------- output

/** The settled output of a tool as the loop is about to record it. */
export interface Output {
  readonly output: string
  readonly display: Json | null
}

/**
 * What happens to a tool's output before it is stored, in this order: the
 * note for a sandboxed command that failed in a way the sandbox causes, then
 * the redaction of the text and of every string in the structured data a
 * client shows. Deterministic: the same output and the same secrets give
 * the same bytes, and what is stored is what is replayed.
 */
export function finishOutput(result: Output, run: CallRun | undefined, effect: string | undefined, secrets: readonly string[], temp?: TempDirectory): Output {
  const code = fields(result.display)?.exitCode
  const exitCode = typeof code === "number" ? code : null
  const hint =
    effect === "exec" && run !== undefined && run.sandbox !== null ? sandboxHint({ sandboxed: true, network: run.sandbox.network, exitCode, output: result.output }) : null
  const output = hint === null ? result.output : `${result.output}${result.output.endsWith("\n") ? "" : "\n"}${hint.note}`
  return { output: redact(aliased(output, temp), secrets).text, display: redactJson(result.display, secrets) }
}

/** A JSON value as an object's fields, or `null` when it is not an object. */
function fields(value: Json | null): { readonly [key: string]: Json } | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { readonly [key: string]: Json }) : null
}

/**
 * A text with every path inside the session's temp directory written under
 * the directory's alias: the name sandboxed commands know it by, and the one
 * the file tools take. The path of an output kept in full is the usual case.
 */
export function aliased(text: string, temp: TempDirectory | undefined): string {
  if (temp === undefined || temp.alias === null) return text
  return text.split(`${temp.dir}/`).join(`${temp.alias}/`)
}

/** Every string in a JSON value, redacted. Keys are left alone. */
export function redactJson(value: Json | null, secrets: readonly string[]): Json | null {
  if (typeof value === "string") return redact(value, secrets).text
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets)) as Json
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item as Json, secrets)])) as Json
  return value
}

/** The redaction a tool is handed (`ToolContext.redact`). */
export function redactor(secrets: readonly string[]): (text: string) => readonly RedactedText[] {
  return (text) => redactPieces(text, secrets)
}

export { CLEAN, type TaintState }
