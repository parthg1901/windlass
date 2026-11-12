/**
 * What an agent may not do, as pure functions.
 *
 * A mode is enforced when a call is made, never by taking tools out of the
 * request: the tool list is frozen in the session's baseline, and changing
 * it would cost the whole prompt cache. So every tool stays in the list and
 * a call the agent may not make is refused with a sentence the model reads.
 *
 * The check runs before the approval layer and has two outcomes only:
 * `refuse`, or `pass` (the approval layer decides as it would without an
 * agent). There is no outcome that approves, so a definition, wherever it
 * comes from, can only take away from what the user's approval mode allows.
 * The approval mode itself can only be tightened (`effectiveApprovalMode`).
 */
import type { ToolEffect } from "../tool/tool.ts"
import { APPROVAL_MODES, type AgentApprovalMode, type AgentRestrictions, EFFECTS } from "./definition.ts"

/** The facts about a call the check needs: what the tool contract says about the tool called. */
export interface CallFacts {
  readonly name: string
  readonly effect: ToolEffect
  /** `mcp`: an MCP server provides the tool, so its declared effect is not trusted. Absent: built in. */
  readonly origin?: "builtin" | "mcp"
}

export type CallVerdict = { readonly kind: "pass" } | { readonly kind: "refuse"; readonly reason: string }

export interface CheckOptions {
  /**
   * Tools the harness itself relies on that an agent's restrictions never
   * refuse, e.g. the verification gate's acknowledgement tool
   * (`ACKNOWLEDGE_TOOL_NAME`), without which a turn with a failing check
   * could not end. Only `read` tools belong here.
   */
  readonly exempt?: readonly string[]
}

const PASS: CallVerdict = { kind: "pass" }

/** What each effect class does, for the sentences. */
const DOES: Readonly<Record<ToolEffect, string>> = { read: "only reads", write: "changes files", exec: "runs commands", network: "reaches the network" }
const DO: Readonly<Record<ToolEffect, string>> = { read: "read", write: "change files", exec: "run commands", network: "reach the network" }

/**
 * Whether the agent lets the call go on to the approval layer. The reason of
 * a refusal is the text of the call's result: it names the agent, the rule,
 * and what the model can do instead.
 */
export function checkAgentCall(agent: { readonly name: string; readonly restrictions: AgentRestrictions }, call: CallFacts, options: CheckOptions = {}): CallVerdict {
  const r = agent.restrictions
  const wanted = call.name.toLowerCase()
  if ((options.exempt ?? []).some((name) => name.toLowerCase() === wanted)) return PASS
  const after = "Carry on without it, or tell the user what you would need and why."
  if (r.deniedTools.some((name) => name.toLowerCase() === wanted))
    return { kind: "refuse", reason: `Not run: you are working as the agent "${agent.name}", which may not use the tool "${call.name}". ${after}` }
  const named = r.tools !== null && r.tools.some((name) => name.toLowerCase() === wanted)
  if (r.tools !== null && !named)
    return { kind: "refuse", reason: `Not run: you are working as the agent "${agent.name}", which may use only these tools: ${r.tools.join(", ")}. "${call.name}" is not one of them. ${after}` }
  if (r.effects !== null) {
    if (call.origin === "mcp" && !named)
      return {
        kind: "refuse",
        reason: `Not run: you are working as the agent "${agent.name}", which may use only tools that ${allowedText(r.effects)}. "${call.name}" comes from an MCP server, so what it does cannot be known; such a tool runs under this agent only when its definition names it in \`tools\`. ${after}`,
      }
    if (call.origin !== "mcp" && !r.effects.includes(call.effect))
      return { kind: "refuse", reason: `Not run: you are working as the agent "${agent.name}", which may use only tools that ${allowedText(r.effects)}. "${call.name}" ${DOES[call.effect]}. ${after}` }
  }
  return PASS
}

function allowedText(effects: readonly ToolEffect[]): string {
  if (effects.length === 0) return "it names (it allows no effect class)"
  const parts = effects.map((effect) => DO[effect])
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`
}

/**
 * The approval mode in force while an agent runs: the user's, or the
 * agent's when that is stricter. An agent asking for a looser mode is
 * ignored, and `ignored` says so for the user (once, like
 * `ResolvedApproval.ignored`). This holds for a definition from the user's
 * own directory too: the approval mode is the user's to choose, in the
 * user's settings.
 */
export function effectiveApprovalMode(user: AgentApprovalMode, agent: { readonly name: string; readonly restrictions: AgentRestrictions } | null): { readonly mode: AgentApprovalMode; readonly ignored: string | null } {
  const wanted = agent?.restrictions.approval ?? null
  if (wanted === null) return { mode: user, ignored: null }
  if (rank(wanted) <= rank(user)) return { mode: wanted, ignored: null }
  return { mode: user, ignored: `The agent "${agent!.name}" asks for approval mode "${wanted}"; the user's mode "${user}" is kept, since an agent can only tighten it.` }
}

/**
 * The restrictions of both: what a subagent gets when its parent runs under
 * restrictions and the child is started as another agent. Each field is the
 * stricter of the two, so a parent cannot escape its own restrictions by
 * handing the work to a child.
 */
export function combineRestrictions(a: AgentRestrictions, b: AgentRestrictions): AgentRestrictions {
  const effects = a.effects === null ? b.effects : b.effects === null ? a.effects : EFFECTS.filter((effect) => a.effects!.includes(effect) && b.effects!.includes(effect))
  const tools =
    a.tools === null ? b.tools : b.tools === null ? a.tools : a.tools.filter((name) => b.tools!.some((other) => other.toLowerCase() === name.toLowerCase()))
  const denied = [...a.deniedTools, ...b.deniedTools.filter((name) => !a.deniedTools.some((other) => other.toLowerCase() === name.toLowerCase()))]
  const approval = a.approval === null ? b.approval : b.approval === null ? a.approval : rank(a.approval) <= rank(b.approval) ? a.approval : b.approval
  return { effects, tools, deniedTools: denied, approval }
}

/** The names in `tools` and `deniedTools` that are not tools of the session, for a warning to the user (e.g. `Bash` from another harness, which is `shell` here). */
export function unknownToolNames(restrictions: AgentRestrictions, toolNames: readonly string[]): string[] {
  const known = new Set(toolNames.map((name) => name.toLowerCase()))
  return [...(restrictions.tools ?? []), ...restrictions.deniedTools].filter((name) => !known.has(name.toLowerCase()))
}

/** Whether the agent restricts anything at all. */
export function isRestricted(restrictions: AgentRestrictions): boolean {
  return restrictions.effects !== null || restrictions.tools !== null || restrictions.deniedTools.length > 0 || restrictions.approval !== null
}

/** The restrictions in a sentence or two, for the model (in the agent's instructions) and the user (in a listing). */
export function describeRestrictions(restrictions: AgentRestrictions): string {
  if (!isRestricted(restrictions)) return "No restrictions beyond the session's approval settings."
  const parts: string[] = []
  if (restrictions.effects !== null) parts.push(`Only tools that ${allowedText(restrictions.effects)} (effects: ${restrictions.effects.join(", ") || "none"}).`)
  if (restrictions.tools !== null) parts.push(`Only these tools: ${restrictions.tools.join(", ")}.`)
  if (restrictions.deniedTools.length > 0) parts.push(`Never these tools: ${restrictions.deniedTools.join(", ")}.`)
  if (restrictions.approval !== null) parts.push(`Approval mode at most as loose as "${restrictions.approval}".`)
  return parts.join(" ")
}

/** A word or two for a listing line: `read only`, `restricted`, or `null` for none. */
export function restrictionTag(restrictions: AgentRestrictions): string | null {
  if (!isRestricted(restrictions)) return null
  if (restrictions.effects !== null && restrictions.effects.length === 1 && restrictions.effects[0] === "read") return "read only"
  return "restricted"
}

function rank(mode: AgentApprovalMode): number {
  return APPROVAL_MODES.indexOf(mode)
}
