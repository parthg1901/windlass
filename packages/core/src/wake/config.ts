/**
 * The `wake` configuration section, in the style of `config/schema.ts` (every key optional, unknown keys
 * rejected). Adding it to the configuration file is the engine's change.
 *
 *   "wake": { "enabled": true, "hourlyCeiling": 12, "maxActive": 10,
 *             "webhook": { "host": "127.0.0.1", "port": 47863, "allowExternal": false, "maxBodyBytes": 65536, "requestsPerMinute": 30 } }
 *
 * - `enabled` (default `true`): offer the tools and run the scheduler.
 * - `hourlyCeiling`: firings per session per rolling hour, 1 to 60 (default 12).
 * - `maxActive`: pending wake-ups the model may have per session, 1 to 10 (default 10).
 * - `webhook.host`, `webhook.port`, `webhook.allowExternal`: where the listener binds. Read from the user's file
 *   only: a repository must not be able to open a port on another interface. A host that is not loopback needs
 *   `allowExternal: true`, and the listener warns when it binds there.
 * - `webhook.maxBodyBytes` (at most 65536), `webhook.requestsPerMinute` (at most 30).
 *
 * A project's file can only tighten: turn wake-ups off, lower a number. Anything else it says is ignored and
 * listed in `ignored`, to be shown once.
 */
import { ConfigError } from "../config/schema.ts"
import { WAKE_LIMITS } from "./record.ts"
import { DEFAULT_WEBHOOK_PORT } from "./webhook.ts"

export interface WakeConfigSection {
  readonly enabled?: boolean
  readonly hourlyCeiling?: number
  readonly maxActive?: number
  readonly webhook?: {
    readonly host?: string
    readonly port?: number
    readonly allowExternal?: boolean
    readonly maxBodyBytes?: number
    readonly requestsPerMinute?: number
  }
}

export interface WakeConfig {
  readonly enabled: boolean
  readonly hourlyCeiling: number
  readonly maxActive: number
  readonly webhook: { readonly host: string; readonly port: number; readonly allowExternal: boolean; readonly maxBodyBytes: number; readonly requestsPerMinute: number }
  /** What the project's file asked for and did not get. */
  readonly ignored: readonly string[]
}

const KEYS = ["enabled", "hourlyCeiling", "maxActive", "webhook"]
const WEBHOOK_KEYS = ["host", "port", "allowExternal", "maxBodyBytes", "requestsPerMinute"]

/** Validates the value of the `wake` key of one file. Throws `ConfigError` naming the file and path. */
export function parseWakeSection(value: unknown, file: string): WakeConfigSection {
  const record = objectAt(value, file, "wake", KEYS)
  const webhook = record.webhook === undefined ? undefined : objectAt(record.webhook, file, "wake.webhook", WEBHOOK_KEYS)
  const whole = (at: string, item: unknown, low: number, high: number) => {
    if (item === undefined) return undefined
    if (typeof item !== "number" || !Number.isInteger(item) || item < low || item > high) throw new ConfigError(file, at, `expected a whole number from ${low} to ${high}`)
    return item
  }
  const flag = (at: string, item: unknown) => {
    if (item === undefined) return undefined
    if (typeof item !== "boolean") throw new ConfigError(file, at, "expected true or false")
    return item
  }
  if (webhook?.host !== undefined && (typeof webhook.host !== "string" || webhook.host === "")) throw new ConfigError(file, "wake.webhook.host", "expected a host name or address")
  return strip({
    enabled: flag("wake.enabled", record.enabled),
    hourlyCeiling: whole("wake.hourlyCeiling", record.hourlyCeiling, 1, WAKE_LIMITS.hourlyCeiling.max),
    maxActive: whole("wake.maxActive", record.maxActive, 1, WAKE_LIMITS.model.maxActive),
    webhook:
      webhook === undefined
        ? undefined
        : strip({
            host: webhook.host as string | undefined,
            port: whole("wake.webhook.port", webhook.port, 0, 65_535),
            allowExternal: flag("wake.webhook.allowExternal", webhook.allowExternal),
            maxBodyBytes: whole("wake.webhook.maxBodyBytes", webhook.maxBodyBytes, 1024, WAKE_LIMITS.webhook.maxBodyBytes),
            requestsPerMinute: whole("wake.webhook.requestsPerMinute", webhook.requestsPerMinute, 1, WAKE_LIMITS.webhook.requestsPerMinute),
          }),
  })
}

/** Applies the defaults; the project's section may only make things stricter. */
export function resolveWakeConfig(user: WakeConfigSection | undefined, project: WakeConfigSection | undefined): WakeConfig {
  const ignored: string[] = []
  const lower = (key: string, mine: number | undefined, theirs: number | undefined, fallback: number) => {
    const base = mine ?? fallback
    if (theirs === undefined) return base
    if (theirs > base) ignored.push(`wake.${key}: the project's ${theirs} is above the user's ${base}`)
    return Math.min(base, theirs)
  }
  for (const key of ["host", "port", "allowExternal"] as const)
    if (project?.webhook?.[key] !== undefined) ignored.push(`wake.webhook.${key}: only the user's own file can set where the listener binds`)
  if (project?.enabled === true && user?.enabled === false) ignored.push("wake.enabled: the user turned wake-ups off")
  return {
    enabled: (user?.enabled ?? true) && project?.enabled !== false,
    hourlyCeiling: lower("hourlyCeiling", user?.hourlyCeiling, project?.hourlyCeiling, WAKE_LIMITS.hourlyCeiling.default),
    maxActive: lower("maxActive", user?.maxActive, project?.maxActive, WAKE_LIMITS.model.maxActive),
    webhook: {
      host: user?.webhook?.host ?? "127.0.0.1",
      port: user?.webhook?.port ?? DEFAULT_WEBHOOK_PORT,
      allowExternal: user?.webhook?.allowExternal ?? false,
      maxBodyBytes: lower("webhook.maxBodyBytes", user?.webhook?.maxBodyBytes, project?.webhook?.maxBodyBytes, WAKE_LIMITS.webhook.maxBodyBytes),
      requestsPerMinute: lower("webhook.requestsPerMinute", user?.webhook?.requestsPerMinute, project?.webhook?.requestsPerMinute, WAKE_LIMITS.webhook.requestsPerMinute),
    },
    ignored,
  }
}

function objectAt(value: unknown, file: string, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, at, "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !keys.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `${at}.${unknown}`, `unknown key "${unknown}"; known keys: ${keys.join(", ")}`)
  return record
}

function strip<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
