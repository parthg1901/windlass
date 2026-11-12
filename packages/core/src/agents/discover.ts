/**
 * Finds the agent definitions of a working directory. A definition is a
 * Markdown file, `<name>.md`, in an agents directory or a folder below it.
 *
 * Roots, highest precedence first (as for skills):
 * 1. project directories, from the working directory up to the repository
 *    root (the nearest ancestor with a `.git` entry; outside a repository,
 *    the working directory alone). In each: `.<brand.directory>/agents`,
 *    then `.agents/agents`, then `.claude/agents`;
 * 2. extra directories from the configuration (`agents.paths`), in order;
 * 3. the user's `<config dir>/agents`.
 * The nearest definition of a name wins; the others are reported as
 * shadowed and kept in `AgentSet.shadowed`. Within one root the first by
 * path wins. One use does not follow this order: the default agent is
 * looked for among the user's own definitions first (`resolveStartAgent`).
 *
 * In a root, files at most `MAX_AGENT_DEPTH` levels down are read (so definitions
 * can be grouped in folders). Dot-entries, `node_modules` and `README.md`
 * are skipped. A symbolic link is followed only when its target is inside
 * the root. Everything is sorted by UTF-16 code units.
 *
 * Nothing here throws for a bad definition: it is skipped, with a reason for
 * the user.
 */
import { sep } from "node:path"
import { MAX_AGENT_BYTES, type ParsedAgent, parseAgentDefinition } from "./definition.ts"
import { byCodeUnits, markdownFiles, readBounded, roots } from "./walk.ts"

/** Levels below a root at which a definition may be: `reviewer.md` is level 1, `team/reviewer.md` level 2. */
export const MAX_AGENT_DEPTH = 3

export interface AgentRoot {
  readonly dir: string
  /** `project`: from the repository (someone else may have written it). `config`: `agents.paths`. `user`: the user's config directory. */
  readonly scope: "project" | "config" | "user"
}

export interface AgentDefinition extends ParsedAgent {
  /** Absolute path of the file, as found (not resolved through links). */
  readonly path: string
  readonly root: AgentRoot
}

export interface AgentProblem {
  readonly path: string
  /** `skipped`: not usable. `shadowed`: a nearer definition has the name. `warning`: usable, but something is off. */
  readonly severity: "skipped" | "shadowed" | "warning"
  readonly reason: string
  /** The name the file has or would have had (from its front matter or its file name), when known. */
  readonly name: string | null
}

export interface AgentSet {
  /** Sorted by name. */
  readonly agents: readonly AgentDefinition[]
  /** Sorted by path, then reason. */
  readonly problems: readonly AgentProblem[]
  readonly roots: readonly AgentRoot[]
  /**
   * The usable definitions a nearer one of the same name hides, nearest first; each also has a `shadowed`
   * problem. Absent in a set that was not discovered (no definitions could be looked for).
   */
  readonly shadowed?: readonly AgentDefinition[]
}

export interface AgentDiscoveryInput {
  /** The session's working directory. */
  readonly cwd: string
  /** The harness config directory (`defaultConfigDir()` in `instructions/discover.ts`). */
  readonly configDir: string
  /** Extra roots (`agents.paths`, resolved), absolute. */
  readonly extraPaths?: readonly string[]
  /** Names to leave out (`agents.disabled`). */
  readonly disabled?: readonly string[]
}

/** The roots to search, highest precedence first. They need not exist. */
export function agentRoots(input: AgentDiscoveryInput): AgentRoot[] {
  return roots(input, "agents")
}

export function discoverAgents(input: AgentDiscoveryInput): AgentSet {
  const found = agentRoots(input)
  const disabled = new Set(input.disabled ?? [])
  const problems: AgentProblem[] = []
  const byName = new Map<string, AgentDefinition>()
  const shadowed: AgentDefinition[] = []
  for (const root of found) {
    for (const agent of scanRoot(root, problems)) {
      if (disabled.has(agent.name)) continue
      const winner = byName.get(agent.name)
      if (winner === undefined) byName.set(agent.name, agent)
      else if (winner.root === root) problems.push({ path: agent.path, severity: "skipped", name: agent.name, reason: `another definition in the same directory is named "${agent.name}" (${winner.path})` })
      else {
        shadowed.push(agent)
        problems.push({ path: agent.path, severity: "shadowed", name: agent.name, reason: `the agent "${agent.name}" at ${winner.path} takes precedence` })
      }
    }
  }
  return {
    agents: [...byName.values()].sort((a, b) => byCodeUnits(a.name, b.name)),
    problems: problems.sort((a, b) => byCodeUnits(a.path, b.path) || byCodeUnits(a.reason, b.reason)),
    roots: found,
    shadowed,
  }
}

function scanRoot(root: AgentRoot, problems: AgentProblem[]): AgentDefinition[] {
  const agents: AgentDefinition[] = []
  for (const file of markdownFiles(root.dir, MAX_AGENT_DEPTH, (path, reason) => problems.push({ path, severity: "skipped", name: null, reason }))) {
    const agent = readAgent(file, root, problems)
    if (agent !== null) agents.push(agent)
  }
  return agents
}

function readAgent(file: string, root: AgentRoot, problems: AgentProblem[]): AgentDefinition | null {
  const fallbackName = file.split(sep).pop()!.replace(/\.md$/i, "")
  const read = readBounded(file, MAX_AGENT_BYTES, "a definition")
  if (!read.ok) {
    problems.push({ path: file, severity: "skipped", name: fallbackName, reason: read.reason })
    return null
  }
  const parsed = parseAgentDefinition(read.text, fallbackName)
  if (!parsed.ok) {
    problems.push({ path: file, severity: "skipped", name: fallbackName, reason: parsed.reason })
    return null
  }
  for (const reason of parsed.warnings) problems.push({ path: file, severity: "warning", name: parsed.agent.name, reason })
  return { ...parsed.agent, path: file, root }
}

