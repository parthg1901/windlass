/**
 * What a call needs beyond what its mode allows, and the remembered approvals
 * (grants) that cover those needs.
 *
 * A grant names a capability, never a command: "network for sandboxed
 * commands in this session", "writes under /home/u/.cache/pip", "the tool
 * web_fetch". Command prefixes are not offered: telling whether `npm test`
 * and `npm test; curl …` are "the same command" needs a shell parser, and
 * the point of this layer is not to guess what command text does.
 *
 * Grants are plain data (`grant` validates them) for the integration to store:
 * session grants in the session log, project grants in the user's data
 * directory keyed by the project's real path (never in the repository's
 * config file, which someone else may have written, and which a sandboxed
 * command can write; the data directory is hidden from the sandbox).
 */
import { type Infer, integer, literal, nonEmptyString, nullable, object, oneOf, variant } from "../validate.ts"
import { isWithin } from "./paths.ts"
import type { TaintState } from "./taint.ts"

export type Need =
  /** `ask` mode: running a command in the sandbox. */
  | { readonly kind: "exec-sandboxed" }
  /** No sandbox on this machine (or taint in `full`): running a command with the user's full permissions. */
  | { readonly kind: "exec-unsandboxed" }
  /** A sandboxed command with the network on. */
  | { readonly kind: "sandbox-network" }
  /** A sandboxed command writing under `path` (real), outside the workspace. */
  | { readonly kind: "sandbox-write"; readonly path: string }
  /**
   * A file tool writing `path` (real; null when the tool named no path).
   * `root` is what a remembered approval would cover (null: nothing can be
   * remembered). `protectedRoot` is the protected directory containing the
   * path, if any: only a grant inside it covers the path.
   */
  | { readonly kind: "write"; readonly path: string | null; readonly root: string | null; readonly protectedRoot: string | null }
  /** A file tool reading inside a hidden path. Never remembered. */
  | { readonly kind: "read-hidden"; readonly path: string }
  /** A network or MCP tool, by name. */
  | { readonly kind: "tool"; readonly tool: string }
  /** `ask` mode: a tool that changes only the harness's own records (`Tool.changes`), by name. */
  | { readonly kind: "records"; readonly tool: string }

export const grantRule = variant("kind", {
  "exec-sandboxed": object({ kind: literal("exec-sandboxed") }),
  "exec-unsandboxed": object({ kind: literal("exec-unsandboxed") }),
  "sandbox-network": object({ kind: literal("sandbox-network") }),
  "sandbox-write": object({ kind: literal("sandbox-write"), root: nonEmptyString }),
  write: object({ kind: literal("write"), root: nonEmptyString }),
  tool: object({ kind: literal("tool"), tool: nonEmptyString }),
  records: object({ kind: literal("records"), tool: nonEmptyString }),
})
export type GrantRule = Infer<typeof grantRule>

export const grantScope = oneOf(["session", "project"])
export type GrantScope = Infer<typeof grantScope>

/** A remembered approval. */
export const grant = object({
  scope: grantScope,
  rule: grantRule,
  /** Session grants: the session log position (`seq`) of the approval. Project grants: null. */
  at: nullable(integer(0)),
  /** Milliseconds since the epoch. Project grants expire `PROJECT_GRANT_TTL_MS` after it. */
  grantedAt: integer(0),
})
export type Grant = Infer<typeof grant>

/** A choice's grants before the integration stamps them with when they were given. */
export interface GrantTemplate {
  readonly scope: GrantScope
  readonly rule: GrantRule
}

export const PROJECT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Needs whose approval lets data leave the machine. Taint invalidates their earlier grants. */
export function isOutbound(need: Need | GrantRule): boolean {
  return need.kind === "exec-unsandboxed" || need.kind === "sandbox-network" || need.kind === "tool"
}

/** The scopes a need can be remembered at; `[]` means once only. */
export function rememberableScopes(need: Need): readonly GrantScope[] {
  if (need.kind === "read-hidden") return []
  if (need.kind === "write") return need.root === null ? [] : ["session", "project"]
  if (need.kind === "sandbox-write" || need.kind === "tool" || need.kind === "records") return ["session", "project"]
  return ["session"]
}

/** The rule that remembering `need` stores. Null when it cannot be remembered. */
export function ruleFor(need: Need): GrantRule | null {
  if (need.kind === "read-hidden") return null
  if (need.kind === "write") return need.root === null ? null : { kind: "write", root: need.root }
  if (need.kind === "sandbox-write") return { kind: "sandbox-write", root: need.path }
  if (need.kind === "tool") return { kind: "tool", tool: need.tool }
  if (need.kind === "records") return { kind: "records", tool: need.tool }
  return { kind: need.kind }
}

/** Whether some grant in `grants` covers `need` now, given the session's taint. */
export function isCovered(need: Need, grants: readonly Grant[], taint: TaintState, now: number): boolean {
  return grants.some((item) => applies(item, taint, now) && covers(item.rule, need))
}

/**
 * A project grant applies until it expires; a session grant for the rest of
 * the session. While the session is tainted, an outbound grant applies only if
 * it was given in this session after the taint began: the user then saw the
 * question with the warning that untrusted content is present.
 */
export function applies(item: Grant, taint: TaintState, now: number): boolean {
  if (item.scope === "project" && now - item.grantedAt >= PROJECT_GRANT_TTL_MS) return false
  if (!taint.tainted || !isOutbound(item.rule)) return true
  return item.scope === "session" && item.at !== null && taint.since !== null && item.at > taint.since
}

function covers(rule: GrantRule, need: Need): boolean {
  if (need.kind === "write")
    return (
      rule.kind === "write" &&
      need.path !== null &&
      isWithin(rule.root, need.path) &&
      (need.protectedRoot === null || isWithin(need.protectedRoot, rule.root))
    )
  if (need.kind === "sandbox-write") return rule.kind === "sandbox-write" && isWithin(rule.root, need.path)
  if (need.kind === "tool") return rule.kind === "tool" && rule.tool === need.tool
  if (need.kind === "records") return rule.kind === "records" && rule.tool === need.tool
  if (need.kind === "read-hidden") return false
  return rule.kind === need.kind
}

/** Turns the templates of the choice the user picked into grants to store. `at` is the approval's log position. */
export function stampGrants(templates: readonly GrantTemplate[], at: number, now: number): Grant[] {
  return templates.map((template) => ({ scope: template.scope, rule: template.rule, at: template.scope === "session" ? at : null, grantedAt: now }))
}
