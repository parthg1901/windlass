/**
 * The `lsp` configuration section, in the style of `config/schema.ts` and
 * `mcp/config.ts`: every key optional, unknown keys rejected with a
 * suggestion, defaults applied in one place. This module only defines the
 * section; adding it to the configuration file (`FEATURE_SECTIONS` in
 * `config/schema.ts`) is the engine's change.
 *
 *   "lsp": {
 *     "waitMs": 1500,
 *     "servers": {
 *       "typescript": {
 *         "command": "typescript-language-server", "args": ["--stdio"],
 *         "languages": { "typescript": ["**\/*.ts"], "typescriptreact": ["**\/*.tsx"] },
 *         "rootMarkers": ["tsconfig.json", "package.json"]
 *       }
 *     }
 *   }
 *
 * There is no built-in list of servers that start by themselves: a server runs
 * only when a configuration file names it. `LSP_EXAMPLES` are entries for
 * common servers that a user copies into their own file.
 *
 * Who may start a server is decided by `planLspServers`: a server the user's
 * own file defines is the user's; one the project's file names or changes in
 * any way waits for the user's approval of exactly that definition (its
 * fingerprint), as MCP servers do.
 */
import { createHash } from "node:crypto"
import { ConfigError, mergeConfigFiles } from "../config/schema.ts"
import type { Json } from "../json.ts"
import { BASE_ENV, variableLines } from "../mcp/config.ts"
import { DecodeError, type Validator, boolean, nonEmptyString, string } from "../validate.ts"
import { NOTE_LIMITS } from "./note.ts"

export { BASE_ENV }

export const LSP_LIMITS = {
  /** How long a file tool's result may wait for diagnostics. `0` turns the note off. */
  waitMs: { default: 1500, min: 0, max: 5000 },
  startupTimeoutSeconds: { default: 30, min: 1, max: 300 },
  maxDiagnostics: NOTE_LIMITS.maxItems,
} as const

export interface LspServerConfig {
  /** The key in `servers`; shown to the model in the note's heading. */
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  /** As written, before `${NAME}` is expanded. The child gets `BASE_ENV` and these, nothing else. */
  readonly env: Readonly<Record<string, string>>
  /** Language ID (sent in `didOpen`) to the glob patterns of the files it applies to, relative to the working directory. Sorted by language ID. */
  readonly languages: readonly { readonly languageId: string; readonly patterns: readonly string[] }[]
  /** File names whose directory is a workspace root: the nearest one above the edited file, inside the working directory. Empty: the working directory. */
  readonly rootMarkers: readonly string[]
  readonly startupTimeoutSeconds: number
  /** Sent as `initializationOptions`. */
  readonly initializationOptions: Json | null
  /** What `workspace/configuration` is answered from, by dotted section (`python.analysis`). */
  readonly settings: Json | null
  readonly enabled: boolean
}

export interface LspConfig {
  readonly enabled: boolean
  readonly waitMs: number
  /** Report new warnings too, not only new errors. */
  readonly warnings: boolean
  readonly maxDiagnostics: number
  /** Sorted by name. */
  readonly servers: readonly LspServerConfig[]
}

const serverName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const languageId = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/

const stringList: Validator<readonly string[]> = (input, path) => {
  if (!Array.isArray(input)) throw new DecodeError(path, "array of strings", input)
  return input.map((item, index) => string(item, `${path}[${index}]`))
}

const nonEmptyList: Validator<readonly string[]> = (input, path) => {
  if (!Array.isArray(input) || input.length === 0) throw new DecodeError(path, "non-empty array of strings", input)
  return input.map((item, index) => nonEmptyString(item, `${path}[${index}]`))
}

const fileNames: Validator<readonly string[]> = (input, path) => {
  const names = stringList(input, path)
  names.forEach((name, index) => {
    if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new DecodeError(`${path}[${index}]`, "a file name without a directory", name)
  })
  return names
}

const envMap: Validator<Readonly<Record<string, string>>> = (input, path) => {
  if (!isPlainObject(input)) throw new DecodeError(path, "object of strings", input)
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new DecodeError(join(path, key), "an environment variable name", key)
      return [key, string(value, join(path, key))]
    }),
  )
}

const languages: Validator<Readonly<Record<string, readonly string[]>>> = (input, path) => {
  if (!isPlainObject(input) || Object.keys(input).length === 0) throw new DecodeError(path, "object of language IDs to file patterns", input)
  return Object.fromEntries(
    Object.entries(input).map(([id, patterns]) => {
      if (!languageId.test(id)) throw new DecodeError(join(path, id), "a language ID such as typescript or python", id)
      return [id, nonEmptyList(patterns, join(path, id))]
    }),
  )
}

const jsonObject: Validator<Json> = (input, path) => {
  if (!isPlainObject(input)) throw new DecodeError(path, "object", input)
  return input as Json
}

function boundedInteger(min: number, max: number): Validator<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) throw new DecodeError(path, `integer from ${min} to ${max}`, input)
    return input
  }
}

const serverFields = section({
  command: nonEmptyString,
  args: stringList,
  env: envMap,
  languages,
  rootMarkers: fileNames,
  startupTimeoutSeconds: boundedInteger(LSP_LIMITS.startupTimeoutSeconds.min, LSP_LIMITS.startupTimeoutSeconds.max),
  initializationOptions: jsonObject,
  settings: jsonObject,
  enabled: boolean,
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

/** The `lsp` section as written in one file. */
export const lspConfigSection = section({
  enabled: boolean,
  waitMs: boundedInteger(LSP_LIMITS.waitMs.min, LSP_LIMITS.waitMs.max),
  warnings: boolean,
  maxDiagnostics: boundedInteger(LSP_LIMITS.maxDiagnostics.min, LSP_LIMITS.maxDiagnostics.max),
  servers,
})
export type LspConfigSection = ReturnType<typeof lspConfigSection>

/**
 * Validates the value of the `lsp` key of one file. Throws `ConfigError`
 * naming the file and the path of the bad value (prefixed `lsp.`). A server's
 * required fields are checked after merging (`resolveLspConfig`), so a project
 * file may change one field of a user's server (and that change needs approval).
 */
export function parseLspSection(value: unknown, file: string): LspConfigSection {
  try {
    return lspConfigSection(value, "lsp")
  } catch (error) {
    if (error instanceof UnknownKeyError) throw new ConfigError(file, error.path, error.problem)
    if (error instanceof DecodeError) throw new ConfigError(file, error.path, error.message.slice(error.path.length + 2))
    throw error
  }
}

/** Applies the defaults to a merged section and checks each server has a command and languages. */
export function resolveLspConfig(section: LspConfigSection | undefined, file = "configuration"): LspConfig {
  const entries = Object.entries(section?.servers ?? {}).sort(([a], [b]) => compare(a, b))
  return {
    enabled: section?.enabled ?? true,
    waitMs: section?.waitMs ?? LSP_LIMITS.waitMs.default,
    warnings: section?.warnings ?? false,
    maxDiagnostics: section?.maxDiagnostics ?? LSP_LIMITS.maxDiagnostics.default,
    servers: entries.map(([name, fields]) => resolveServer(name, fields, file)),
  }
}

function resolveServer(name: string, fields: ServerFields, file: string): LspServerConfig {
  const path = `lsp.servers.${name}`
  if (fields.command === undefined) throw new ConfigError(file, path, "needs `command`, the language server to start")
  if (fields.languages === undefined) throw new ConfigError(file, path, "needs `languages`, the language IDs it serves and their file patterns")
  return {
    name,
    command: fields.command,
    args: fields.args ?? [],
    env: fields.env ?? {},
    languages: Object.entries(fields.languages)
      .sort(([a], [b]) => compare(a, b))
      .map(([id, patterns]) => ({ languageId: id, patterns })),
    rootMarkers: fields.rootMarkers ?? [],
    startupTimeoutSeconds: fields.startupTimeoutSeconds ?? LSP_LIMITS.startupTimeoutSeconds.default,
    initializationOptions: fields.initializationOptions ?? null,
    settings: fields.settings ?? null,
    enabled: fields.enabled ?? true,
  }
}

/** The server's definition as stable JSON (keys sorted): what its fingerprint is computed over. */
export function serverDefinitionText(config: LspServerConfig): string {
  return stableJson(config as unknown as Json)
}

/** Identifies one definition of a server; any change to any field (the name included) is a new fingerprint. */
export function lspServerFingerprint(config: LspServerConfig): string {
  return createHash("sha256").update(serverDefinitionText(config), "utf8").digest("hex").slice(0, 16)
}

/** One server of a session's configuration and whether it may be started. */
export interface LspServerPlan {
  readonly config: LspServerConfig
  /** `user`: the user's own file defines it and the project's leaves it alone. `project`: the project's file names or changes it. */
  readonly origin: "user" | "project"
  readonly fingerprint: string
  /** Always for a user's server; for a project's, once the user approved this fingerprint. */
  readonly approved: boolean
}

export interface LspPlan {
  readonly config: LspConfig
  readonly servers: readonly LspServerPlan[]
}

/**
 * The merged configuration and which servers may start. `isApproved` is the
 * lookup of a remembered approval by `lspApprovalKey` (the approval store's
 * job). The merge is the configuration loader's own (`mergeConfigFiles`: key
 * by key, lists replace), so a project's file can change one field of a
 * user's server, which makes it the project's.
 */
export function planLspServers(
  user: LspConfigSection | undefined,
  project: LspConfigSection | undefined,
  isApproved: (key: string) => boolean,
  file = "configuration",
): LspPlan {
  const own = new Map<string, string>()
  for (const [name, fields] of Object.entries(user?.servers ?? {})) {
    try {
      own.set(name, serverDefinitionText(resolveServer(name, fields, file)))
    } catch {
      // Incomplete in the user's file: whatever completes it comes from the project.
    }
  }
  const merged = (mergeConfigFiles(user === undefined ? null : ({ lsp: user } as never), project === undefined ? null : ({ lsp: project } as never)) as { lsp?: LspConfigSection }).lsp
  const config = resolveLspConfig(merged, file)
  return {
    config,
    servers: config.servers.map((server) => {
      const fingerprint = lspServerFingerprint(server)
      const origin = own.get(server.name) === serverDefinitionText(server) ? "user" : "project"
      const plan = { config: server, origin, fingerprint } as const
      return { ...plan, approved: origin === "user" || isApproved(lspApprovalKey(plan)) }
    }),
  }
}

/**
 * What an approval of a project's server is remembered by: the name and the
 * fingerprint, so an edited definition is a new question. Stored as a project
 * grant like an MCP server's (`{ kind: "tool", tool: <this key> }`).
 */
export function lspApprovalKey(plan: Pick<LspServerPlan, "config" | "fingerprint">): string {
  return `lsp-server:${plan.config.name}:${plan.fingerprint}`
}

/** What a client shows for a project's server that waits for approval. */
export interface LspServerQuestion {
  readonly name: string
  readonly fingerprint: string
  readonly key: string
  /** The command with its arguments joined by spaces: what approving it runs. */
  readonly subject: string
  /** The command and each of its arguments, one string each, as the definition has them: what a client shows (`quotedCommand`). */
  readonly argv: readonly string[]
  readonly details: readonly string[]
}

export function lspServerQuestion(plan: LspServerPlan): LspServerQuestion {
  const server = plan.config
  const files = server.languages.flatMap((language) => language.patterns)
  return {
    name: server.name,
    fingerprint: plan.fingerprint,
    key: lspApprovalKey(plan),
    subject: [server.command, ...server.args].join(" "),
    argv: [server.command, ...server.args],
    details: [
      `This project's configuration names the language server "${server.name}", started by running that command when the agent edits ${files.join(", ")}. It runs outside the sandbox, with your permissions.`,
      ...variableLines(server.env, "env"),
      "Its diagnostics are added as a short note to the agent's edits. Approving it is remembered for this project for exactly this definition of the server.",
    ],
  }
}

/**
 * Entries for common servers, to copy into your own configuration file. None
 * of them is used unless a file names it. Each assumes the server is installed
 * and on PATH.
 */
export const LSP_EXAMPLES: Readonly<Record<string, NonNullable<LspConfigSection["servers"]>[string]>> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: {
      typescript: ["**/*.ts", "**/*.mts", "**/*.cts"],
      typescriptreact: ["**/*.tsx"],
      javascript: ["**/*.js", "**/*.mjs", "**/*.cjs"],
      javascriptreact: ["**/*.jsx"],
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: { python: ["**/*.py", "**/*.pyi"] },
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg"],
    settings: { python: { analysis: { diagnosticMode: "openFilesOnly" } } },
  },
  go: {
    command: "gopls",
    args: [],
    languages: { go: ["**/*.go"] },
    rootMarkers: ["go.work", "go.mod"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    languages: { rust: ["**/*.rs"] },
    rootMarkers: ["Cargo.toml"],
    startupTimeoutSeconds: 120,
  },
}

/** JSON with object keys sorted, for fingerprints. */
export function stableJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item as Json)).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, Json>)[key]!)}`)
      .join(",")}}`
  return JSON.stringify(value)
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

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}

type Shape = Record<string, Validator<unknown>>
type Inferred<V> = V extends Validator<infer T> ? T : never

function section<S extends Shape>(shape: S): Validator<{ readonly [K in keyof S]?: Inferred<S[K]> }> {
  const known = Object.keys(shape)
  return (input, path) => {
    if (!isPlainObject(input)) throw new DecodeError(path, "object", input)
    const unknown = Object.keys(input).find((key) => !Object.hasOwn(shape, key))
    if (unknown !== undefined) throw new UnknownKeyError(join(path, unknown), unknown, known)
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, shape[key]!(value, join(path, key))])) as { readonly [K in keyof S]?: Inferred<S[K]> }
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

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}
