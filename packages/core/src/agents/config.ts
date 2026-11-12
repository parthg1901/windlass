/**
 * The `agents` configuration section, in the style of `config/schema.ts`
 * (every key optional, unknown keys rejected). Adding it to the
 * configuration file is the integrator's change.
 *
 *   "agents": { "paths": ["~/team-agents"], "disabled": ["old-planner"], "default": "reviewer" }
 *
 * - `paths`: extra definition directories, searched after the project's and
 *   before the user's. Absolute, or starting with `~/`.
 * - `disabled`: names to leave out wherever they are found.
 * - `default`: the agent a session a person starts runs as when none is
 *   named (`"none"` or absent: no agent). Subagents never get it.
 *
 * A project file may set `paths` and `disabled` like any section. `default`
 * is read from the user's file only: a repository choosing which agent
 * every session in it starts as would be the repository choosing the
 * instructions, model and effort the user's sessions run with.
 * `resolveAgentsConfig(user, project)` applies that, and keeps the paths the
 * user's own file names apart (`ownPaths`): the default is looked for among
 * the user's own definitions first, so that a repository cannot replace it
 * with a definition of the same name (`resolveStartAgent`).
 */
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { ConfigError } from "../config/schema.ts"
import { NO_AGENT } from "./definition.ts"

export interface AgentsConfigSection {
  readonly paths?: readonly string[]
  readonly disabled?: readonly string[]
  readonly default?: string
}

export interface AgentsConfig {
  readonly paths: readonly string[]
  /** The paths among `paths` that the user's own file names. A project's file cannot add to them. */
  readonly ownPaths: readonly string[]
  readonly disabled: readonly string[]
  /** `null`: no default agent. */
  readonly default: string | null
  /** Settings of the project file that were not applied, for the user to see once. */
  readonly ignored: readonly string[]
}

const KEYS = ["paths", "disabled", "default"]

/** Validates the value of the `agents` key of one file. Throws `ConfigError` naming the file and path. */
export function parseAgentsSection(value: unknown, file: string): AgentsConfigSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, "agents", "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `agents.${unknown}`, `unknown key "${unknown}"; known keys: ${KEYS.join(", ")}`)
  const list = (key: string, check: (item: string) => string | null) => {
    const items = record[key]
    if (items === undefined) return undefined
    if (!Array.isArray(items)) throw new ConfigError(file, `agents.${key}`, "expected an array of strings")
    return items.map((item, index) => {
      if (typeof item !== "string" || item === "") throw new ConfigError(file, `agents.${key}[${index}]`, "expected a non-empty string")
      const problem = check(item)
      if (problem !== null) throw new ConfigError(file, `agents.${key}[${index}]`, problem)
      return item
    })
  }
  const paths = list("paths", (item) => (isAbsolute(item) || item.startsWith("~/") ? null : "expected an absolute path or one starting with ~/"))
  const disabled = list("disabled", () => null)
  const fallback = record.default
  if (fallback !== undefined && (typeof fallback !== "string" || fallback.trim() === "")) throw new ConfigError(file, "agents.default", `expected an agent's name, or "${NO_AGENT}"`)
  return {
    ...(paths === undefined ? {} : { paths }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(fallback === undefined ? {} : { default: (fallback as string).trim() }),
  }
}

/** Combines the user's and the project's sections (project paths first, as nearer), applies the defaults and expands `~/`. */
export function resolveAgentsConfig(user: AgentsConfigSection | null | undefined, project: AgentsConfigSection | null = null, home: string = homedir()): AgentsConfig {
  const expand = (path: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path)
  const paths = [...new Set([...(project?.paths ?? []), ...(user?.paths ?? [])].map(expand))]
  const disabled = [...new Set([...(user?.disabled ?? []), ...(project?.disabled ?? [])])]
  const fallback = user?.default ?? null
  return {
    paths,
    ownPaths: [...new Set((user?.paths ?? []).map(expand))],
    disabled,
    default: fallback === null || fallback.toLowerCase() === NO_AGENT ? null : fallback,
    ignored: project?.default === undefined ? [] : [`agents.default "${project.default}" in the project's configuration (only the user's own configuration chooses the default agent)`],
  }
}
