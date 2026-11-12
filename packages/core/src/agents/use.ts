/**
 * Using an agent, in the three places it can be used. All pure (nothing is
 * read or written; paths are only compared): the engine passes in what it
 * read and appends what comes back.
 *
 * (a) A new session started as an agent: `agentRecord` is recorded with the
 *     session; `agentSource` is one section of its first baseline (key
 *     `AGENT_KEY`), the last source; `agentSettings` gives the model and
 *     effort the session is created with.
 * (b) A subagent run as an agent: `childAgent` is the child's record (its
 *     restrictions combined with the parent's), its baseline carries
 *     `agentSource(child)`, and `agentSettings` starts from the parent's
 *     settings. The name comes from the call's `agent` argument and is
 *     checked with `findAgent` when the call runs.
 * (c) A switch in the middle of a session: the baseline is frozen, so
 *     `agentSwitch` gives the instruction message to append (the new
 *     agent's instructions, replacing the previous agent's from that point)
 *     and the restrictions apply to every call decided after it. A model or
 *     effort change is the existing settings change at the same boundary.
 *
 * What a session was given is the record, never the file: an edit of the
 * file during the session changes nothing until the user selects the agent
 * again (otherwise a session could widen its own restrictions by editing
 * its definition). After a compaction the new baseline is built from the
 * record too.
 */
import { resolve, sep } from "node:path"
import { fingerprint } from "../instructions/source.ts"
import { type Infer, type Validator, array, nonEmptyString, nullable, object, oneOf, string } from "../validate.ts"
import { APPROVAL_MODES, type AgentRestrictions, NO_AGENT } from "./definition.ts"
import type { AgentDefinition, AgentRoot, AgentSet } from "./discover.ts"
import { combineRestrictions, describeRestrictions, isRestricted } from "./restrictions.ts"

/** The instruction source key of the active agent's instructions, in a baseline and in a switch message. */
export const AGENT_KEY = "agent"

const restrictionsValidator: Validator<AgentRestrictions> = object({
  effects: nullable(array(oneOf(["read", "write", "exec", "network"] as const))),
  tools: nullable(array(nonEmptyString)),
  deniedTools: array(nonEmptyString),
  approval: nullable(oneOf(APPROVAL_MODES)),
})

/**
 * What a session (or a child) runs as, as the log should store it: the
 * definition as it was when it was selected, so the session never depends
 * on the file again. Suggested schema for a durable field
 * (`event/durable.ts` can use this validator as is).
 */
export const agentRecord = object({
  name: nonEmptyString,
  /** The file it came from, for the user. */
  path: nonEmptyString,
  scope: oneOf(["project", "config", "user"] as const),
  /** `definitionFingerprint` of the file's content when it was selected. */
  definition: nonEmptyString,
  /** The value of the `agent` instruction source: what the model is given (`agentSource`). */
  instructions: string,
  /** The restrictions in force: the definition's, combined with a parent's for a child. */
  restrictions: restrictionsValidator,
  model: nullable(nonEmptyString),
  effort: nullable(nonEmptyString),
})
export type AgentRecord = Infer<typeof agentRecord>

/** The record of a session that runs as `agent`. */
export function agentRecordOf(agent: AgentDefinition, restrictions: AgentRestrictions = agent.restrictions): AgentRecord {
  return {
    name: agent.name,
    path: agent.path,
    scope: agent.root.scope,
    definition: agent.fingerprint,
    instructions: agentInstructions(agent, restrictions),
    restrictions,
    model: agent.model,
    effort: agent.effort,
  }
}

/** The agent's instructions as the model is given them: who it is working as, its restrictions, then the definition's body. */
export function agentInstructions(agent: Pick<AgentDefinition, "name" | "description" | "body" | "path">, restrictions: AgentRestrictions): string {
  const lines = [
    `You are working as the agent "${agent.name}" (defined in ${agent.path}): ${agent.description}`,
    `Restrictions: ${describeRestrictions(restrictions)}${isRestricted(restrictions) ? " A call outside them is refused with the reason, not run." : ""}`,
  ]
  const body = agent.body.replace(/\r\n?/g, "\n").trim()
  return body === "" ? lines.join("\n") : `${lines.join("\n")}\n\n${body}`
}

/** The instruction source of a record, for a baseline: `{ key: "agent", value }`. */
export function agentSource(record: AgentRecord): { readonly key: string; readonly value: string } {
  return { key: AGENT_KEY, value: record.instructions }
}

/**
 * The section that shows the agent's instructions to the model, in a
 * baseline and in a switch message alike. `instructions/source.ts` must
 * render `AGENT_KEY` exactly so (`<agent lines="N">`); see the README.
 */
export function renderAgentSection(value: string): string {
  return [`<agent lines="${value.split("\n").length}">`, value, "</agent>"].join("\n")
}

/**
 * The message to append when the user switches the agent of a running
 * session, as `instruction.appended` with source `AGENT_KEY` and this
 * `fingerprint` (of the new instructions; `null` when switched off), or
 * `null` when nothing changes (the same agent, the same definition).
 */
export function agentSwitch(current: AgentRecord | null, next: AgentRecord | null): { readonly text: string; readonly fingerprint: string | null } | null {
  if (next === null) {
    if (current === null) return null
    return {
      text: `The user switched off the agent "${current.name}". From this point on its instructions and its restrictions no longer apply; carry on under your other instructions.`,
      fingerprint: null,
    }
  }
  if (current !== null && current.name === next.name && current.instructions === next.instructions && sameRestrictions(current.restrictions, next.restrictions)) return null
  const notice =
    current === null
      ? `The user switched you to the agent "${next.name}". From this point on these instructions apply, in addition to the instructions you already have:`
      : current.name === next.name
        ? `The definition of the agent "${next.name}" changed and the user selected it again. From this point on this version replaces the one you were given before:`
        : `The user switched you from the agent "${current.name}" to the agent "${next.name}". From this point on these instructions replace those of "${current.name}" (and its restrictions); everything else you were given still applies:`
  return { text: `${notice}\n${renderAgentSection(next.instructions)}`, fingerprint: fingerprint(next.instructions) }
}

function sameRestrictions(a: AgentRestrictions, b: AgentRestrictions) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The model settings of the session, as `event/durable.ts` stores them (`sessionSettings`). */
export interface ModelSettings {
  readonly model: string
  readonly reasoningEffort: string | null
}

/**
 * The settings a session runs with as `agent`: the agent's model and effort
 * where it names them, `base` (the session's own, or the parent's) where it
 * does not. With `offered` (the provider's models, from `validateSettings`'s
 * source), a model it does not offer is not used: `base.model` is kept and a
 * note says so. Starting a session as such an agent should rather fail with
 * that note; a switch or a subagent carries on with the note shown.
 */
export function agentSettings(
  agent: Pick<AgentRecord, "name" | "model" | "effort"> | null,
  base: ModelSettings,
  offered?: readonly string[],
): { readonly settings: ModelSettings; readonly changed: boolean; readonly notes: readonly string[] } {
  if (agent === null) return { settings: base, changed: false, notes: [] }
  const notes: string[] = []
  let model = base.model
  if (agent.model !== null) {
    if (offered === undefined || offered.includes(agent.model)) model = agent.model
    else notes.push(`The agent "${agent.name}" asks for the model "${agent.model}", which is not offered (${offered.join(", ") || "none"}); "${base.model}" is used.`)
  }
  const settings: ModelSettings = { model, reasoningEffort: agent.effort ?? base.reasoningEffort }
  return { settings, changed: settings.model !== base.model || settings.reasoningEffort !== base.reasoningEffort, notes }
}

/**
 * The record of a subagent. `chosen` is the agent the call named (already
 * found with `findAgent`), or `null` for none.
 * - none, under a parent without an agent: `null`, a general subagent;
 * - none, under a parent that runs as an agent: the parent's record, so a
 *   restricted session cannot hand work to an unrestricted child;
 * - an agent: its record, with its restrictions combined with the parent's.
 */
export function childAgent(parent: AgentRecord | null, chosen: AgentDefinition | null): AgentRecord | null {
  if (chosen === null) return parent
  return agentRecordOf(chosen, parent === null ? chosen.restrictions : combineRestrictions(parent.restrictions, chosen.restrictions))
}

export type AgentLookup = { readonly ok: true; readonly agent: AgentDefinition } | { readonly ok: false; readonly message: string }

/**
 * An agent by name, exactly or else ignoring case. The message of a miss
 * says why (a definition of that name that could not be used, a disabled
 * one) or suggests close names, and lists what there is; it is fit for the
 * model (a `subagent` call's error) and for the user alike.
 */
export function findAgent(set: AgentSet, name: string, disabled: readonly string[] = []): AgentLookup {
  const wanted = name.trim()
  const agent = set.agents.find((candidate) => candidate.name === wanted) ?? set.agents.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase())
  if (agent !== undefined) return { ok: true, agent }
  if (disabled.includes(wanted)) return { ok: false, message: `The agent "${wanted}" is disabled in the configuration (agents.disabled).` }
  const broken = set.problems.find((problem) => problem.severity === "skipped" && problem.name !== null && problem.name.toLowerCase() === wanted.toLowerCase())
  if (broken !== undefined) return { ok: false, message: `The agent "${wanted}" (${broken.path}) cannot be used: ${broken.reason}.` }
  if (set.agents.length === 0) return { ok: false, message: `There is no agent named ${JSON.stringify(wanted)}. No agents are defined.` }
  const close = didYouMean(wanted, set.agents.map((candidate) => candidate.name))
  const all = set.agents.map((candidate) => candidate.name)
  const listing = all.length <= 30 ? all.join(", ") : `${all.slice(0, 30).join(", ")} and ${all.length - 30} more`
  return { ok: false, message: `There is no agent named ${JSON.stringify(wanted)}.${close.length > 0 ? ` Did you mean ${close.map((c) => JSON.stringify(c)).join(" or ")}?` : ""} Agents: ${listing}.` }
}

/**
 * The agent a session a person starts runs as: `requested` (a name, or
 * `"none"`), else the configured default, else none. Fails closed: a named
 * or default agent that cannot be found is an error for the user, never a
 * session that silently runs without the restrictions they asked for.
 *
 * A requested name is found by precedence, as everywhere (`findAgent`): the
 * user typed it here, for this directory. The default is different. Only
 * the user's own file names it, for every directory, so it is looked for
 * among the user's own definitions first (`ownDefinition`): a repository
 * that carries a definition of the same name does not replace it, and one
 * of the user's own that cannot be used fails the start instead of giving
 * way to the repository's. Only a name of which the user has no definition
 * at all is found by precedence (a default kept in the project itself).
 */
export function resolveStartAgent(
  set: AgentSet,
  requested: string | null | undefined,
  config: { readonly default: string | null; readonly disabled?: readonly string[]; /** `AgentsConfig.ownPaths`. */ readonly ownPaths?: readonly string[] },
): { readonly ok: true; readonly agent: AgentDefinition | null } | { readonly ok: false; readonly message: string } {
  const name = requested ?? config.default
  if (name === null || name.trim().toLowerCase() === NO_AGENT) return { ok: true, agent: null }
  if (requested !== undefined && requested !== null) return findAgent(set, name, config.disabled)
  const fix = ` (It is the default agent, agents.default; change that, or start with the agent "${NO_AGENT}".)`
  const own = ownDefinition(set, name, config.ownPaths ?? [])
  if (own !== null) return own.ok ? own : { ok: false, message: `${own.message}${fix}` }
  const found = findAgent(set, name, config.disabled)
  return found.ok ? found : { ok: false, message: `${found.message}${fix}` }
}

/**
 * The definition of `name` among the user's own: those of the user's config
 * directory and of the paths the user's own file names (`ownPaths`,
 * absolute), never a project directory's or a path only a project's file
 * names. Exactly or else ignoring case, the nearest first. `null`: the user
 * has none of that name. A miss with a message: the user has one and it
 * could not be used.
 */
export function ownDefinition(set: AgentSet, name: string, ownPaths: readonly string[]): AgentLookup | null {
  const wanted = name.trim()
  const named = new Set(ownPaths.map((path) => resolve(path)))
  const isOwn = (root: AgentRoot) => root.scope === "user" || (root.scope === "config" && named.has(root.dir))
  // In precedence order: for one name, the definition in `agents` is nearer than those in `shadowed`.
  const mine = [...set.agents, ...(set.shadowed ?? [])].filter((agent) => isOwn(agent.root))
  const agent = mine.find((candidate) => candidate.name === wanted) ?? mine.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase())
  if (agent !== undefined) return { ok: true, agent }
  const dirs = set.roots.filter(isOwn).map((root) => `${root.dir}${sep}`)
  const broken = set.problems.find((problem) => problem.severity === "skipped" && problem.name !== null && problem.name.toLowerCase() === wanted.toLowerCase() && dirs.some((dir) => problem.path.startsWith(dir)))
  return broken === undefined ? null : { ok: false, message: `The agent "${wanted}" (${broken.path}) cannot be used: ${broken.reason}.` }
}

/**
 * The property the `subagent` tool's input schema gains (`engine/spawn.ts`),
 * the same in every session: it names no agent, and the names are checked
 * when the call runs. The model learns the names from the agent index.
 */
export const SUBAGENT_AGENT_PROPERTY = {
  agent: {
    type: "string",
    minLength: 1,
    description:
      "Run the subagent as one of the agents the list of agents names: it gets that agent's instructions, model and restrictions. Without it, the subagent works as you do.",
  },
} as const

/** Close names, by edit distance or containment, at most three. */
export function didYouMean(name: string, names: readonly string[]): string[] {
  const lower = name.toLowerCase()
  return names
    .map((candidate) => ({ name: candidate, distance: distance(lower, candidate.toLowerCase()) }))
    .filter((entry) => lower !== "" && (entry.distance <= Math.max(2, Math.floor(entry.name.length / 3)) || entry.name.toLowerCase().includes(lower) || lower.includes(entry.name.toLowerCase())))
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 3)
    .map((entry) => entry.name)
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]!
}
