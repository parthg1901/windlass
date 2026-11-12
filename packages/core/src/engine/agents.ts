/**
 * Agents, as the step loop offers them (`agents/` has the module).
 *
 * - An agent never changes a session's frozen prefix. A session that starts
 *   as one has its instructions as the last section of its first baseline
 *   (source `agent`); a switch in the middle of a session is an appended
 *   instruction message; `agent.switched` records which definition is in
 *   force, as it was when it was selected.
 * - Every tool stays in the list. A call the agent may not make is refused
 *   by the loop before the approval layer decides it, with a sentence the
 *   model reads, and recorded as an `approval.denied` that names the agent.
 * - The `subagent` tool has an optional `agent` argument in every session
 *   (its spec names no agent). Which agents exist is told in a message under
 *   source `agent-index`, to the sessions whose tool list has `subagent`:
 *   when there first are some, when the list changes, and as a withdrawal.
 * - What discovery could not load is said to the user, never the model.
 *
 * The session's configuration decides where definitions are looked for
 * (`agents.paths`, `agents.disabled`) and which agent a session a person
 * starts runs as when none is named (`agents.default`, read from the user's
 * own file only).
 */
import { type AgentsConfig, resolveAgentsConfig } from "../agents/config.ts"
import type { AgentRestrictions } from "../agents/definition.ts"
import { type AgentProblem, type AgentSet, discoverAgents } from "../agents/discover.ts"
import { combineRestrictions } from "../agents/restrictions.ts"
import { AGENT_INDEX_KEY, agentIndexSource, agentIndexUpdate } from "../agents/agent-index.ts"
import type { AppendedSource } from "../instructions/state.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to offer agents. */
export interface AgentsSetup {
  /**
   * The harness config directory, whose `agents` directory holds the user's
   * own. Default: the engine's (`$XDG_CONFIG_HOME/<brand.directory>`); with
   * `EngineOptions.discover` injected, none, so that an engine whose
   * instruction sources a test supplies reads nothing of this machine's.
   */
  readonly configDir?: string
  /** The home directory `~/` in `agents.paths` stands for. Default: the user's. */
  readonly home?: string
}

/** Where a session's agents are looked for besides its working directory, and what its configuration says about them. */
export interface AgentPlaces extends AgentsConfig {
  readonly configDir: string
}

export function agentPlaces(files: ConfigFiles | null, setup: Required<Pick<AgentsSetup, "configDir">> & Pick<AgentsSetup, "home">): AgentPlaces {
  return { ...resolveAgentsConfig(files?.user?.agents, files?.project?.agents ?? null, setup.home), configDir: setup.configDir }
}

/** The agents of a working directory as they are now. Never throws: a place that cannot be read holds no agents. */
export function findAgents(cwd: string, places: AgentPlaces): AgentSet {
  try {
    return discoverAgents({ cwd, configDir: places.configDir, extraPaths: places.paths, disabled: places.disabled })
  } catch (error) {
    return { agents: [], problems: [{ path: cwd, severity: "skipped", reason: `the agents could not be looked for: ${error instanceof Error ? error.message : String(error)}`, name: null }], roots: [] }
  }
}

/**
 * Whether a subagent that runs under `child` is held to everything `parent`
 * is held to: combining the two gives nothing stricter than the child's own.
 * True for a child that was started while its parent ran as this agent (it
 * was given the parent's restrictions then) and for any child of a parent
 * that restricts nothing. False for a child started before its parent was
 * switched to a stricter agent: work handed to it would get around the
 * parent's restrictions, so a follow-up to it is refused (`followUp`).
 */
export function heldToParent(parent: AgentRestrictions, child: AgentRestrictions): boolean {
  const both = combineRestrictions(parent, child)
  const same = (a: readonly string[] | null, b: readonly string[] | null): boolean => {
    if (a === null || b === null) return a === b
    const names = new Set(b.map((name) => name.toLowerCase()))
    return new Set(a.map((name) => name.toLowerCase())).size === names.size && a.every((name) => names.has(name.toLowerCase()))
  }
  return same(both.effects, child.effects) && same(both.tools, child.tools) && same(both.deniedTools, child.deniedTools) && both.approval === child.approval
}

/** The list of agents as a source the loop appends when it changed. */
export function agentIndexAppended(set: AgentSet): AppendedSource {
  const source = agentIndexSource(set.agents)
  return {
    key: AGENT_INDEX_KEY,
    update: (known) => {
      const update = agentIndexUpdate(known, source)
      if (update === null) return null
      return { ...update, detail: { kind: "agents", agents: set.agents.map((agent) => ({ name: agent.name, path: agent.path })) } }
    },
  }
}

/**
 * One line for the user about a definition that was skipped, shadowed or is
 * off in some way.
 *
 * `inForce` is the agent the session runs as, when it runs as one. A session
 * that started as the default agent runs as the user's own definition of
 * that name, also where a project defines the name too: by the order of
 * discovery the project's is the nearer one and the user's is "shadowed",
 * and yet the user's is the one in force for this session. Saying that it
 * "is hidden" would be the opposite of what is in force, so the line says
 * which definition the session runs as and why, and what the other one of
 * that name is used for (`nearer`: the definition discovery prefers).
 */
export function describeAgentProblem(problem: AgentProblem, inForce: { readonly name: string; readonly path: string } | null = null, nearer: string | null = null): string {
  if (problem.severity === "shadowed" && inForce !== null && inForce.path === problem.path)
    return `This session runs as the agent "${inForce.name}" defined in ${problem.path}: it is your own definition, and the agent a session starts as by default (agents.default) is always one of your own.${
      nearer === null ? "" : ` The definition of the same name at ${nearer} is not in force here; it is the one a switch to "${inForce.name}" or a subagent run as "${inForce.name}" gets.`
    }`
  const what = problem.severity === "skipped" ? "was not loaded" : problem.severity === "shadowed" ? "is hidden by another agent of the same name" : "was loaded with a warning"
  return `The agent definition at ${problem.path} ${what}: ${problem.reason}`
}

/** What a client lists for `/agents`: the definitions, what could not be used, and the configured default. */
export interface AgentListing extends AgentSet {
  /** The agent a session a person starts here runs as when none is named; `null`: none. */
  readonly default: string | null
  /** Settings of the project's file that were not followed (it cannot choose the default agent). */
  readonly ignored: readonly string[]
}
