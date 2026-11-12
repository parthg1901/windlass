/**
 * The `skills` configuration section, in the style of `config/schema.ts`
 * (every key optional, unknown keys rejected). Adding it to the configuration
 * file is the engine's change.
 *
 *   "skills": { "paths": ["~/team-skills"], "disabled": ["old-release-process"] }
 *
 * - `paths`: extra skill directories, searched after the project's and before
 *   the user's. Absolute, or starting with `~/`.
 * - `disabled`: skill names to leave out wherever they are found.
 */
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { ConfigError } from "../config/schema.ts"

export interface SkillsConfigSection {
  readonly paths?: readonly string[]
  readonly disabled?: readonly string[]
}

export interface SkillsConfig {
  readonly paths: readonly string[]
  readonly disabled: readonly string[]
}

const KEYS = ["paths", "disabled"]

/** Validates the value of the `skills` key of one file. Throws `ConfigError` naming the file and path. */
export function parseSkillsSection(value: unknown, file: string): SkillsConfigSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, "skills", "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `skills.${unknown}`, `unknown key "${unknown}"; known keys: ${KEYS.join(", ")}`)
  const list = (key: string, check: (item: string) => string | null) => {
    const items = record[key]
    if (items === undefined) return undefined
    if (!Array.isArray(items)) throw new ConfigError(file, `skills.${key}`, "expected an array of strings")
    return items.map((item, index) => {
      if (typeof item !== "string" || item === "") throw new ConfigError(file, `skills.${key}[${index}]`, "expected a non-empty string")
      const problem = check(item)
      if (problem !== null) throw new ConfigError(file, `skills.${key}[${index}]`, problem)
      return item
    })
  }
  const paths = list("paths", (item) => (isAbsolute(item) || item.startsWith("~/") ? null : "expected an absolute path or one starting with ~/"))
  const disabled = list("disabled", () => null)
  return { ...(paths === undefined ? {} : { paths }), ...(disabled === undefined ? {} : { disabled }) }
}

/** Applies the defaults and expands `~/`. */
export function resolveSkillsConfig(section: SkillsConfigSection | undefined, home: string = homedir()): SkillsConfig {
  return {
    paths: (section?.paths ?? []).map((path) => (path.startsWith("~/") ? join(home, path.slice(2)) : path)),
    disabled: section?.disabled ?? [],
  }
}
