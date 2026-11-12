/**
 * The `memory` configuration section, in the style of `config/schema.ts` (every key optional, unknown keys
 * rejected). Adding it to the configuration file is the engine's change. Memory is off unless a file turns it on.
 *
 *   "memory": { "enabled": true, "inRepository": false, "projectChars": 4000, "userChars": 2000 }
 *
 * - `enabled` (default `false`): deliver notes and offer the memory tools in new sessions.
 * - `inRepository` (default `false`): keep this project's notes in `.<brand.directory>/memory/` in the project,
 *   where they can be committed, instead of the user's data directory. Only honoured from the user's own file: a
 *   repository must not be able to move the user's notes into itself.
 * - `projectChars`, `userChars`: the delivered block's budget per scope, in characters of note lines.
 */
import { ConfigError } from "../config/schema.ts"
import { DELIVERY_LIMITS, type DeliveryLimits } from "./hygiene.ts"

export interface MemoryConfigSection {
  readonly enabled?: boolean
  readonly inRepository?: boolean
  readonly projectChars?: number
  readonly userChars?: number
}

export interface MemoryConfig {
  readonly enabled: boolean
  readonly inRepository: boolean
  readonly limits: DeliveryLimits
}

const KEYS = ["enabled", "inRepository", "projectChars", "userChars"]

/** Validates the value of the `memory` key of one file. Throws `ConfigError` naming the file and path. */
export function parseMemorySection(value: unknown, file: string): MemoryConfigSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, "memory", "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `memory.${unknown}`, `unknown key "${unknown}"; known keys: ${KEYS.join(", ")}`)
  const flag = (key: string) => {
    if (record[key] === undefined) return {}
    if (typeof record[key] !== "boolean") throw new ConfigError(file, `memory.${key}`, "expected true or false")
    return { [key]: record[key] }
  }
  const chars = (key: string) => {
    const item = record[key]
    if (item === undefined) return {}
    if (typeof item !== "number" || !Number.isInteger(item) || item < 200 || item > 50_000) throw new ConfigError(file, `memory.${key}`, "expected a whole number from 200 to 50000")
    return { [key]: item }
  }
  return { ...flag("enabled"), ...flag("inRepository"), ...chars("projectChars"), ...chars("userChars") }
}

/**
 * Applies the defaults. `user` is the user file's section and `project` the project file's: the project may turn
 * memory on or off and size it, but `inRepository` is read from the user's section only.
 */
export function resolveMemoryConfig(user: MemoryConfigSection | undefined, project: MemoryConfigSection | undefined): MemoryConfig {
  const pick = <K extends keyof MemoryConfigSection>(key: K) => project?.[key] ?? user?.[key]
  return {
    enabled: pick("enabled") ?? false,
    inRepository: user?.inRepository ?? false,
    limits: {
      user: { ...DELIVERY_LIMITS.user, ...(pick("userChars") === undefined ? {} : { maxChars: pick("userChars")! }) },
      project: { ...DELIVERY_LIMITS.project, ...(pick("projectChars") === undefined ? {} : { maxChars: pick("projectChars")! }) },
    },
  }
}
