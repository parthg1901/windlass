/**
 * The agent index: what the model is told about the agents it can run a
 * subagent as, name and description only (and a tag for a read-only one).
 * An instruction source, appended when it first has something to say and
 * again only when its fingerprint changes, never part of the frozen prefix,
 * exactly as the skill index (`skills/skill-index.ts`).
 *
 * Only a session that is offered the `subagent` tool is given it: the model
 * cannot switch its own agent (that is the user's choice), so for a session
 * at the depth limit the list would be noise.
 *
 * Pure and bounded: sorted by name, each description on one line of at most
 * `maxDescriptionChars`, the whole text at most `maxChars`; agents that do
 * not fit are named without descriptions, then counted.
 */
import { fingerprint } from "../instructions/source.ts"
import type { AgentRestrictions } from "./definition.ts"
import { byCodeUnits } from "./walk.ts"
import { restrictionTag } from "./restrictions.ts"

/** The `source` of the instruction messages that carry the index. Not `agents:...`, which is the prefix of AGENTS.md files. */
export const AGENT_INDEX_KEY = "agent-index"

export interface AgentIndexLimits {
  readonly maxChars: number
  readonly maxDescriptionChars: number
}

export const AGENT_INDEX_LIMITS: AgentIndexLimits = { maxChars: 6000, maxDescriptionChars: 300 }

const INTRO =
  "An agent is a role kept as a file: instructions, and sometimes a model and restrictions. To give a task to a subagent that works as one, call the subagent tool with `agent` set to its name. Without `agent` the subagent works as you do."

type Entry = { readonly name: string; readonly description: string; readonly restrictions: AgentRestrictions }

/** The index body, or `null` when there are no agents. */
export function renderAgentIndex(agents: readonly Entry[], limits: AgentIndexLimits = AGENT_INDEX_LIMITS): string | null {
  if (agents.length === 0) return null
  const sorted = [...agents].sort((a, b) => byCodeUnits(a.name, b.name))
  const lines = sorted.map((agent) => {
    const tag = restrictionTag(agent.restrictions)
    return `- ${agent.name}${tag === null ? "" : ` (${tag})`}: ${cut(agent.description.replace(/\s+/g, " ").trim(), limits.maxDescriptionChars)}`
  })
  const text = (listed: number, named: number) => {
    const parts = [INTRO, "", ...lines.slice(0, listed)]
    const names = sorted.slice(listed, listed + named).map((agent) => agent.name)
    const rest = sorted.length - listed - named
    if (names.length > 0) parts.push(`Also available, without descriptions here: ${names.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`)
    else if (rest > 0) parts.push(`And ${rest} more agents not listed here.`)
    return parts.join("\n")
  }
  let listed = sorted.length
  while (listed > 0 && text(listed, 0).length > limits.maxChars && text(listed, sorted.length - listed).length > limits.maxChars) listed -= 1
  let named = sorted.length - listed
  while (named > 0 && text(listed, named).length > limits.maxChars) named -= 1
  return text(listed, named)
}

/** The index as an instruction source, or `null` when there are no agents. */
export function agentIndexSource(agents: readonly Entry[], limits?: AgentIndexLimits): { readonly key: string; readonly value: string } | null {
  const value = renderAgentIndex(agents, limits)
  return value === null ? null : { key: AGENT_INDEX_KEY, value }
}

/**
 * What to append so the model's list matches `source`, given the
 * fingerprint of the list it was last given (`null`/`undefined`: none, or it
 * was told there are none). `null` when nothing changed. The engine stores
 * the text and fingerprint in an `instruction.appended` event with source
 * `AGENT_INDEX_KEY`.
 */
export function agentIndexUpdate(
  known: string | null | undefined,
  source: { readonly value: string } | null,
): { readonly text: string; readonly fingerprint: string | null } | null {
  if (source === null) {
    if (known === null || known === undefined) return null
    return { text: "There are no agents any more. Disregard the list of agents you were given before; a subagent can no longer be given `agent`.", fingerprint: null }
  }
  const current = fingerprint(source.value)
  if (current === known) return null
  const notice = known === null || known === undefined ? "Agents you can run a subagent as:" : "The agents have changed. This list replaces the one you were given before:"
  return { text: `${notice}\n${[`<agents lines="${source.value.split("\n").length}">`, source.value, "</agents>"].join("\n")}`, fingerprint: current }
}

function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`
}
