/**
 * Skills, as the step loop offers them (`skills/` has the module).
 *
 * - The `skill` tool is in a session's frozen tool list from its first
 *   baseline, whether or not any skill exists then. Its spec is a constant.
 * - The index (which skills exist, name and description only) reaches the
 *   model as an appended message under source `skills`, at a step boundary:
 *   when there first is one, when it changes, and as a withdrawal when no
 *   skill is left. It is never part of the baseline.
 * - What discovery could not load is said to the user, never the model.
 *
 * The session's configuration decides where skills are looked for:
 * `skills.paths` is read from the user's own file only (a repository carries
 * its skills in itself and must not point the harness at other directories
 * of the machine), `skills.disabled` from both files.
 */
import type { ConfigFile } from "../config/schema.ts"
import type { AppendedSource } from "../instructions/state.ts"
import { resolveSkillsConfig } from "../skills/config.ts"
import { type SkillProblem, type SkillSet, discoverSkills } from "../skills/discover.ts"
import { SKILLS_INDEX_KEY, skillIndexSource, skillIndexUpdate } from "../skills/skill-index.ts"
import { type SkillInput, skillTool } from "../skills/tool.ts"
import type { Tool, ToolContext } from "../tool/tool.ts"

/** How an engine is told to offer skills. */
export interface SkillsSetup {
  /** The harness config directory, whose `skills` directory holds the user's own. Default: the engine's (`$XDG_CONFIG_HOME/<brand.directory>`). */
  readonly configDir?: string
  /** The home directory `~/` in `skills.paths` stands for. Default: the user's. */
  readonly home?: string
}

/** The two configuration files of a session, as written; `null` where one does not exist. */
export interface ConfigFiles {
  readonly user: ConfigFile | null
  readonly project: ConfigFile | null
}

/** Where a session's skills are looked for, besides its working directory. */
export interface SkillPlaces {
  readonly configDir: string
  readonly extraPaths: readonly string[]
  readonly disabled: readonly string[]
}

export function skillPlaces(files: ConfigFiles | null, setup: Required<Pick<SkillsSetup, "configDir">> & Pick<SkillsSetup, "home">): SkillPlaces {
  const paths = files?.user?.skills?.paths
  const disabled = [...new Set([...(files?.user?.skills?.disabled ?? []), ...(files?.project?.skills?.disabled ?? [])])]
  const resolved = resolveSkillsConfig({ ...(paths === undefined ? {} : { paths }), disabled }, setup.home)
  return { configDir: setup.configDir, extraPaths: resolved.paths, disabled: resolved.disabled }
}

/**
 * The `skill` tool of an engine. One object for every session: the spec is
 * the module's constant, and each call looks where the calling session's
 * configuration says (`placesOf`).
 */
export function engineSkillTool(placesOf: (context: ToolContext) => SkillPlaces): Tool<SkillInput> {
  const spec = skillTool({ configDir: "" })
  return { ...spec, execute: (input, context) => skillTool(placesOf(context)).execute(input, context) }
}

/** The skills of a working directory as they are now. Never throws: a place that cannot be read holds no skills. */
export function findSkills(cwd: string, places: SkillPlaces): SkillSet {
  try {
    return discoverSkills({ cwd, ...places })
  } catch (error) {
    return { skills: [], problems: [{ path: cwd, severity: "skipped", reason: `the skills could not be looked for: ${error instanceof Error ? error.message : String(error)}` }], roots: [] }
  }
}

/** The index as a source the loop appends when it changed. */
export function skillsSource(set: SkillSet): AppendedSource {
  const source = skillIndexSource(set.skills)
  return {
    key: SKILLS_INDEX_KEY,
    update: (known) => {
      const update = skillIndexUpdate(known, source)
      if (update === null) return null
      return { ...update, detail: { kind: "skills", skills: set.skills.map((skill) => ({ name: skill.name, path: skill.path })) } }
    },
  }
}

/** One line for the user about a skill that was skipped, shadowed or is off in some way. */
export function describeSkillProblem(problem: SkillProblem): string {
  const what = problem.severity === "skipped" ? "was not loaded" : problem.severity === "shadowed" ? "is hidden by another skill of the same name" : "was loaded with a warning"
  return `The skill at ${problem.path} ${what}: ${problem.reason}`
}
