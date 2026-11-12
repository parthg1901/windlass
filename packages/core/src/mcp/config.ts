/**
 * The `mcp` configuration section, in the style of `config/schema.ts`: every
 * key optional, unknown keys rejected with a suggestion, defaults applied in
 * one place. This module only defines the section; adding it to the
 * configuration file (`configFile` in `config/schema.ts`) is the engine's change.
 *
 *   "mcp": {
 *     "servers": {
 *       "github": {
 *         "command": "github-mcp-server",
 *         "args": ["stdio"],
 *         "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
 *         "tools": { "deny": ["delete_*"] },
 *         "timeoutSeconds": 60
 *       },
 *       "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *     }
 *   }
 *
 * A server is started (`command`) or reached (`url`), never both. A started
 * server's environment is not the harness's: it gets the few variables a
 * program needs to run (`BASE_ENV`) and what `env` names. `${NAME}` in an
 * `env` or `headers` value is replaced from the harness's environment when the
 * server starts; a missing variable makes that server fail with a message
 * that names it, without affecting the others.
 */
import { ConfigError } from "../config/schema.ts"
import { isCredentialName } from "../sandbox/policy.ts"
import { DecodeError, type Validator, boolean, nonEmptyString, oneOf, string } from "../validate.ts"
import { editDistance } from "./schema.ts"

export const DEFAULT_CALL_TIMEOUT_SECONDS = 60
export const MAX_CALL_TIMEOUT_SECONDS = 3600
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 30
export const MAX_STARTUP_TIMEOUT_SECONDS = 600

/** What a started server inherits from the harness's environment when it is set. Everything else must be named in `env`. */
export const BASE_ENV: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]

export type McpTransportConfig =
  | {
      readonly kind: "stdio"
      readonly command: string
      readonly args: readonly string[]
      /** Relative to the session's working directory. `null`: the working directory. */
      readonly cwd: string | null
      /** As written, before `${NAME}` is expanded. */
      readonly env: Readonly<Record<string, string>>
    }
  | { readonly kind: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>> }

export interface McpServerConfig {
  /** The key in `servers`. Shown to the model as the server part of `server/tool`. */
  readonly name: string
  readonly transport: McpTransportConfig
  /** Tool name patterns (`*` matches any run of characters). `allow: null` allows every tool; `deny` wins over `allow`. */
  readonly tools: { readonly allow: readonly string[] | null; readonly deny: readonly string[] }
  /** Limit for one tool call. */
  readonly timeoutSeconds: number
  /** Limit for starting, negotiating and listing tools. */
  readonly startupTimeoutSeconds: number
  /** Whether results are content the harness does not control. Default `true`. */
  readonly untrusted: boolean
  readonly enabled: boolean
  /** `auto` detects the server's protocol era; `modern` or `legacy` skips the probe. */
  readonly protocol: "auto" | "modern" | "legacy"
}

export interface McpConfig {
  /** Sorted by name. */
  readonly servers: readonly McpServerConfig[]
}

/** Server names appear in tool calls and in the catalogue, so they are plain identifiers. */
const serverName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

const stringList: Validator<readonly string[]> = (input, path) => {
  if (!Array.isArray(input)) throw new DecodeError(path, "array of strings", input)
  return input.map((item, index) => string(item, `${path}[${index}]`))
}

const patternList: Validator<readonly string[]> = (input, path) => {
  if (!Array.isArray(input)) throw new DecodeError(path, "array of tool name patterns", input)
  return input.map((item, index) => nonEmptyString(item, `${path}[${index}]`))
}

const stringMap: Validator<Readonly<Record<string, string>>> = (input, path) => {
  if (!isPlainObject(input)) throw new DecodeError(path, "object of strings", input)
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, string(value, join(path, key))]))
}

const envMap: Validator<Readonly<Record<string, string>>> = (input, path) => {
  const map = stringMap(input, path)
  const bad = Object.keys(map).find((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  if (bad !== undefined) throw new DecodeError(join(path, bad), "an environment variable name", bad)
  return map
}

function boundedInteger(min: number, max: number): Validator<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max)
      throw new DecodeError(path, `integer from ${min} to ${max}`, input)
    return input
  }
}

const url: Validator<string> = (input, path) => {
  const value = nonEmptyString(input, path)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new DecodeError(path, "an http or https URL", input)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DecodeError(path, "an http or https URL", input)
  return value
}

const serverFields = section({
  command: nonEmptyString,
  args: stringList,
  cwd: nonEmptyString,
  env: envMap,
  url,
  headers: stringMap,
  tools: section({ allow: patternList, deny: patternList }),
  timeoutSeconds: boundedInteger(1, MAX_CALL_TIMEOUT_SECONDS),
  startupTimeoutSeconds: boundedInteger(1, MAX_STARTUP_TIMEOUT_SECONDS),
  untrusted: boolean,
  enabled: boolean,
  protocol: oneOf(["auto", "modern", "legacy"]),
})

type ServerFields = ReturnType<typeof serverFields>

const servers: Validator<Readonly<Record<string, ServerFields>>> = (input, path) => {
  if (!isPlainObject(input)) throw new DecodeError(path, "object of servers by name", input)
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (!serverName.test(name)) throw new DecodeError(join(path, name), "a server name of letters, digits, '_', '.' and '-', at most 64 characters", name)
      return [name, serverFields(value, join(path, name))]
    }),
  )
}

/** The `mcp` section as written in one file. */
export const mcpConfigSection = section({ servers })
export type McpConfigSection = ReturnType<typeof mcpConfigSection>

/**
 * Validates the value of the `mcp` key of one file. Throws `ConfigError`
 * naming the file and the path of the bad value (inside the section, prefixed `mcp.`).
 * A server's start-or-reach fields are checked after merging (`resolveMcpConfig`),
 * so a project file may change one field of a user-level server.
 */
export function parseMcpSection(value: unknown, file: string): McpConfigSection {
  try {
    return mcpConfigSection(value, "mcp")
  } catch (error) {
    if (error instanceof UnknownKeyError) throw new ConfigError(file, error.path, error.problem)
    if (error instanceof DecodeError) throw new ConfigError(file, error.path, error.message.slice(error.path.length + 2))
    throw error
  }
}

/** Applies the defaults to a merged section and checks each server is either started or reached. */
export function resolveMcpConfig(section: McpConfigSection | undefined, file = "configuration"): McpConfig {
  const entries = Object.entries(section?.servers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    servers: entries.map(([name, fields]) => ({
      name,
      transport: transportOf(name, fields, file),
      tools: { allow: fields.tools?.allow ?? null, deny: fields.tools?.deny ?? [] },
      timeoutSeconds: fields.timeoutSeconds ?? DEFAULT_CALL_TIMEOUT_SECONDS,
      startupTimeoutSeconds: fields.startupTimeoutSeconds ?? DEFAULT_STARTUP_TIMEOUT_SECONDS,
      untrusted: fields.untrusted ?? true,
      enabled: fields.enabled ?? true,
      protocol: fields.protocol ?? "auto",
    })),
  }
}

function transportOf(name: string, fields: ServerFields, file: string): McpTransportConfig {
  const path = `mcp.servers.${name}`
  if (fields.command !== undefined && fields.url !== undefined)
    throw new ConfigError(file, path, "has both `command` and `url`; a server is either started or reached")
  if (fields.command !== undefined) {
    if (fields.headers !== undefined) throw new ConfigError(file, `${path}.headers`, "applies only to a server reached by `url`")
    return { kind: "stdio", command: fields.command, args: fields.args ?? [], cwd: fields.cwd ?? null, env: fields.env ?? {} }
  }
  if (fields.url !== undefined) {
    const misplaced = (["args", "cwd", "env"] as const).find((key) => fields[key] !== undefined)
    if (misplaced !== undefined) throw new ConfigError(file, `${path}.${misplaced}`, "applies only to a server started by `command`")
    return { kind: "http", url: fields.url, headers: fields.headers ?? {} }
  }
  throw new ConfigError(file, path, "needs `command` (a server to start) or `url` (a server to reach)")
}

/**
 * Replaces `${NAME}` with the variable's value. Returns the name of the first
 * variable that is not set instead, so the server's failure can name it.
 */
export function expandVariables(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly missing: string } {
  let missing: string | null = null
  const expanded = value.replace(new RegExp(VARIABLE.source, VARIABLE.flags), (_, name: string) => {
    const found = env[name]
    if (found === undefined) missing ??= name
    return found ?? ""
  })
  return missing === null ? { ok: true, value: expanded } : { ok: false, missing }
}

/** `${NAME}` in a value: the user's variable `NAME`. */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * The user's variables that `${NAME}` in a server's `env` or `headers` values reads, in order of first appearance,
 * each with the keys whose values it goes into. Values only: a key is the name the server sees, chosen by whoever
 * wrote the definition.
 */
export function variablesRead(values: Readonly<Record<string, string>>): { readonly name: string; readonly into: readonly string[] }[] {
  const read = new Map<string, string[]>()
  for (const [key, value] of Object.entries(values))
    for (const match of value.matchAll(new RegExp(VARIABLE.source, VARIABLE.flags))) {
      const into = read.get(match[1]!) ?? []
      if (!into.includes(key)) into.push(key)
      read.set(match[1]!, into)
    }
  return [...read].map(([name, into]) => ({ name, into }))
}

/**
 * The lines of an approval question that say what a server is given: the names it sees (`env` of a started
 * server, `headers` of one reached by URL), every variable of the user's environment whose value goes into them,
 * and which of those look like credentials (`isCredentialName`). Never a value. The language servers' question
 * uses it too.
 */
export function variableLines(values: Readonly<Record<string, string>>, kind: "env" | "headers"): string[] {
  const keys = Object.keys(values)
  if (keys.length === 0) return []
  const list = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`)
  const given = kind === "env" ? `It is given these environment variables: ${keys.join(", ")}.` : `It is sent these headers: ${keys.join(", ")}.`
  const read = variablesRead(values)
  if (read.length === 0) return [given, "Their values are written in the configuration; none is taken from your environment."]
  const lines = [given, `Values from your environment go into them: ${read.map((variable) => `${variable.name} into ${list(variable.into)}`).join("; ")}.`]
  const credentials = read.map((variable) => variable.name).filter(isCredentialName)
  if (credentials.length > 0) {
    const where = kind === "env" ? "to this server" : "to this address"
    lines.push(
      credentials.length === 1
        ? `${credentials[0]} looks like a credential: approving gives its value ${where}.`
        : `${list(credentials)} look like credentials: approving gives their values ${where}.`,
    )
  }
  return lines
}

/** The environment of a started server: the base variables that are set, then its own `env`, expanded. */
export function serverEnvironment(
  env: Readonly<Record<string, string>>,
  parent: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly env: Record<string, string> } | { readonly ok: false; readonly missing: string } {
  const result: Record<string, string> = {}
  for (const key of BASE_ENV) if (parent[key] !== undefined) result[key] = parent[key]!
  for (const [key, raw] of Object.entries(env)) {
    const expanded = expandVariables(raw, parent)
    if (!expanded.ok) return expanded
    result[key] = expanded.value
  }
  return { ok: true, env: result }
}

/** Whether a tool passes the server's `allow` and `deny` lists. */
export function toolAllowed(name: string, tools: McpServerConfig["tools"]): boolean {
  const matches = (pattern: string) => new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(name)
  if (tools.deny.some(matches)) return false
  return tools.allow === null || tools.allow.some(matches)
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

class UnknownKeyError extends DecodeError {
  readonly problem: string
  constructor(path: string, key: string, known: readonly string[]) {
    super(path, "a known key", undefined)
    const close = known
      .map((candidate) => ({ candidate, distance: editDistance(key.toLowerCase(), candidate.toLowerCase()) }))
      .filter((entry) => entry.distance <= Math.max(1, Math.floor(entry.candidate.length / 3)))
      .sort((a, b) => a.distance - b.distance)[0]
    this.problem = `unknown key "${key}"${close === undefined ? "" : ` (did you mean "${close.candidate}"?)`}; known keys: ${known.join(", ")}`
    this.message = `${path}: ${this.problem}`
  }
}

type Shape = Record<string, Validator<unknown>>
type Inferred<V> = V extends Validator<infer T> ? T : never

/** A config section: every key optional, unknown keys rejected with a suggestion (as in `config/schema.ts`). */
function section<S extends Shape>(shape: S): Validator<{ readonly [K in keyof S]?: Inferred<S[K]> }> {
  const known = Object.keys(shape)
  return (input, path) => {
    if (!isPlainObject(input)) throw new DecodeError(path, "object", input)
    const unknown = Object.keys(input).find((key) => !Object.hasOwn(shape, key))
    if (unknown !== undefined) throw new UnknownKeyError(join(path, unknown), unknown, known)
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, shape[key]!(value, join(path, key))])) as {
      readonly [K in keyof S]?: Inferred<S[K]>
    }
  }
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function join(path: string, key: string) {
  return path === "" ? key : `${path}.${key}`
}
