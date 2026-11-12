/**
 * The `telemetry` configuration section, in the style of `config/schema.ts`
 * (every key optional, unknown keys rejected). Adding it to the
 * configuration file's known keys is the engine integrator's change
 * (README.md); until then this module validates and resolves it on its own.
 *
 *   "telemetry": {
 *     "enabled": true,
 *     "endpoint": "http://localhost:4318",
 *     "headers": { "authorization": "Bearer ${COLLECTOR_TOKEN}" },
 *     "content": false,
 *     "timeoutMs": 10000
 *   }
 *
 * - `enabled` (default `false`): export spans. Off unless a file turns it on.
 * - `endpoint`: the OTLP/HTTP collector, as a base URL or the full `/v1/traces` URL. Required when enabled.
 * - `headers`: sent with every request. `${NAME}` is replaced by the environment variable `NAME` when the
 *   configuration is resolved (`$$` is a literal `$`), so a token never has to be written in the file. A
 *   variable that is not set is an error that names the variable, never a value.
 * - `content` (default `false`): also export message text, tool arguments and tool output, redacted and bounded.
 * - `timeoutMs` (default 10000): per request to the collector.
 *
 * Who may say what: telemetry sends data off the machine, so a repository must not be able to start it,
 * point it elsewhere or widen it. Only the user's own file may turn it on, set the endpoint, the headers,
 * `content` and the timeout; the project's file may only turn it off (`"enabled": false`).
 */
import { ConfigError } from "../config/schema.ts"

export interface TelemetryConfigSection {
  readonly enabled?: boolean
  readonly endpoint?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly content?: boolean
  readonly timeoutMs?: number
}

export interface TelemetryConfig {
  readonly enabled: boolean
  /** `null` when disabled. */
  readonly endpoint: string | null
  /** With every `${NAME}` expanded. Never print these. */
  readonly headers: Readonly<Record<string, string>>
  readonly content: boolean
  readonly timeoutMs: number
}

export const DEFAULT_TELEMETRY_TIMEOUT_MS = 10_000
const KEYS = ["enabled", "endpoint", "headers", "content", "timeoutMs"]
const OFF: TelemetryConfig = { enabled: false, endpoint: null, headers: {}, content: false, timeoutMs: DEFAULT_TELEMETRY_TIMEOUT_MS }

/** Validates the value of the `telemetry` key of one file. Throws `ConfigError` naming the file and path. */
export function parseTelemetrySection(value: unknown, file: string): TelemetryConfigSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, "telemetry", "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `telemetry.${unknown}`, `unknown key "${unknown}"; known keys: ${KEYS.join(", ")}`)
  const out: { -readonly [K in keyof TelemetryConfigSection]: TelemetryConfigSection[K] } = {}
  for (const key of ["enabled", "content"] as const) {
    if (record[key] === undefined) continue
    if (typeof record[key] !== "boolean") throw new ConfigError(file, `telemetry.${key}`, "expected true or false")
    out[key] = record[key] as boolean
  }
  if (record.endpoint !== undefined) {
    if (typeof record.endpoint !== "string" || !validUrl(record.endpoint)) throw new ConfigError(file, "telemetry.endpoint", "expected an http:// or https:// URL")
    out.endpoint = record.endpoint
  }
  if (record.headers !== undefined) {
    const headers = record.headers
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) throw new ConfigError(file, "telemetry.headers", "expected an object of header names to string values")
    for (const [name, item] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new ConfigError(file, `telemetry.headers.${name}`, "not a valid header name")
      if (typeof item !== "string") throw new ConfigError(file, `telemetry.headers.${name}`, "expected a string")
      if (/[\r\n]/.test(item)) throw new ConfigError(file, `telemetry.headers.${name}`, "a header value cannot hold a line break")
    }
    out.headers = { ...(headers as Record<string, string>) }
  }
  if (record.timeoutMs !== undefined) {
    const timeout = record.timeoutMs
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) throw new ConfigError(file, "telemetry.timeoutMs", "expected a whole number from 100 to 120000")
    out.timeoutMs = timeout
  }
  return out
}

/** Why a section that validated still cannot be used. */
export class TelemetryConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TelemetryConfigError"
  }
}

/**
 * Applies the defaults and the environment. `user` is the user file's section, `project` the project
 * file's: the project can only turn telemetry off. Throws `TelemetryConfigError` when telemetry is on
 * without an endpoint, or a header names a variable that is not set.
 */
export function resolveTelemetryConfig(
  user: TelemetryConfigSection | undefined,
  project: TelemetryConfigSection | undefined,
  env: Readonly<Record<string, string | undefined>>,
): TelemetryConfig {
  if (user?.enabled !== true || project?.enabled === false) return OFF
  if (user.endpoint === undefined) throw new TelemetryConfigError("telemetry is enabled but the user configuration names no endpoint")
  const headers = Object.fromEntries(Object.entries(user.headers ?? {}).map(([name, value]) => [name, expand(value, env, `telemetry.headers.${name}`)]))
  return { enabled: true, endpoint: user.endpoint, headers, content: user.content === true, timeoutMs: user.timeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS }
}

/** `${NAME}` from the environment; `$$` is a literal `$`. Errors name the variable and the place, never a value. */
export function expand(value: string, env: Readonly<Record<string, string | undefined>>, where: string): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\{[^}]*\}?/g, (match, name: string | undefined) => {
    if (match === "$$") return "$"
    if (name === undefined) throw new TelemetryConfigError(`${where}: "${match}" is not a variable reference; write \${NAME}`)
    const found = env[name]
    if (found === undefined) throw new TelemetryConfigError(`${where}: the environment variable ${name} is not set`)
    return found
  })
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
