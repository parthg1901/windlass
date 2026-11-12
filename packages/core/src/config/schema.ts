/**
 * The configuration file schema and the pure half of loading: parse one file's
 * text, validate it, merge two files and apply the defaults. Nothing here
 * touches the file system (see `load.ts`).
 *
 * Every key is optional in a file. Unknown keys are errors, with a suggestion
 * when a known key is close, so a typo never silently disables a setting.
 * Sections are objects (`verify`, and later `sandbox`, `permissions`), so a new
 * section or a new key in a section is an addition that leaves existing files valid.
 *
 * Merging (`mergeConfigFiles`): the project file overrides the user file key by
 * key, recursively through sections. Lists are values, not collections: a
 * project `checks` list replaces the user's list whole. Concatenating would make
 * it impossible for a project to drop a user-level check, and would make the
 * order and name uniqueness of checks depend on two files at once.
 */
import { type AgentsConfigSection, parseAgentsSection } from "../agents/config.ts"
import { approvalSection } from "../approval/policy.ts"
import { type HookOrigin, type HooksConfigSection, parseHooksSection } from "../hooks/config.ts"
import { type LspConfigSection, parseLspSection } from "../lsp/config.ts"
import { type McpConfigSection, parseMcpSection } from "../mcp/config.ts"
import { type MemoryConfigSection, parseMemorySection } from "../memory/config.ts"
import { type SkillsConfigSection, parseSkillsSection } from "../skills/config.ts"
import { DecodeError, type Infer, type Validator, integer, nonEmptyString, oneOf, string } from "../validate.ts"
import { type WakeConfigSection, parseWakeSection } from "../wake/config.ts"

/** A configuration error, always naming the file and the path of the bad value. */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    /** Path of the bad value inside the file, e.g. `checks[1].timeoutSeconds`; empty for the file as a whole. */
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${file}${path === "" ? "" : `: ${path}`}: ${problem}`)
    this.name = "ConfigError"
  }
}

/** Shell timeouts above this are refused by the shell tool, so they are refused here first. */
export const MAX_CHECK_TIMEOUT_SECONDS = 3600
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 120
export const MAX_VERIFY_ROUNDS = 20

export const DEFAULT_VERIFY = { mode: "gate", maxRounds: 3 } as const

/**
 * What the harness does with checks.
 * - `off`: checks are never run.
 * - `report`: checks run before the turn ends and their results are recorded, but the model is never sent back.
 * - `gate`: a failing check is reported to the model, which continues until the checks pass, it reports that it
 *   cannot make them pass, or `maxRounds` reports have been sent in the turn.
 */
export const verifyMode = oneOf(["off", "report", "gate"])
export type VerifyMode = Infer<typeof verifyMode>

/** Check names appear in the report and in the acknowledgement tool's input, so they are plain identifiers. */
const checkName: Validator<string> = (input, path) => {
  const name = nonEmptyString(input, path)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
    throw new DecodeError(path, "a name of letters, digits, '_', '.' and '-', starting with a letter or digit", input)
  return name
}

const globPattern: Validator<string> = (input, path) => {
  const pattern = nonEmptyString(input, path)
  // Reserved so negation can be added later without changing what existing files mean.
  if (pattern.startsWith("!")) throw new DecodeError(path, "a glob pattern (negation with '!' is not supported)", input)
  return pattern
}

const patterns: Validator<readonly string[]> = (input, path) => {
  if (!Array.isArray(input)) throw new DecodeError(path, "array of glob patterns", input)
  if (input.length === 0) throw new DecodeError(path, "at least one glob pattern (omit `when` to run on any change)", input)
  return input.map((item, index) => globPattern(item, `${path}[${index}]`))
}

function boundedInteger(min: number, max: number): Validator<number> {
  const atLeast = integer(min)
  return (input, path) => {
    const value = atLeast(input, path)
    if (value > max) throw new DecodeError(path, `integer from ${min} to ${max}`, input)
    return value
  }
}

const checkFields = section({
  /** Shown in the report and named by the model when it reports a failure it cannot fix. Unique. */
  name: checkName,
  /** Run with `bash -c` (or `/bin/sh -c`) in the project directory. */
  command: nonEmptyString,
  timeoutSeconds: boundedInteger(1, MAX_CHECK_TIMEOUT_SECONDS),
  /** Glob patterns (Bun.Glob syntax) matched against changed paths relative to the project directory. Any match triggers the check. Omitted: any change. */
  when: patterns,
})

/** `name` and `command` are required; the rest are optional. */
function check(input: unknown, path: string) {
  const fields = checkFields(input, path)
  if (fields.name === undefined) throw new DecodeError(join(path, "name"), "a value", undefined)
  if (fields.command === undefined) throw new DecodeError(join(path, "command"), "a value", undefined)
  return { ...fields, name: fields.name, command: fields.command }
}

const checks: Validator<readonly ReturnType<typeof check>[]> = (input, path) => {
  if (!Array.isArray(input)) throw new DecodeError(path, "array", input)
  const parsed = input.map((item, index) => check(item, `${path}[${index}]`))
  parsed.forEach((item, index) => {
    const first = parsed.findIndex((other) => other.name === item.name)
    if (first !== index) throw new DecodeError(`${path}[${index}].name`, `a name not already used (checks[${first}] is "${item.name}")`, item.name)
  })
  return parsed
}

/**
 * The sections other modules define (`mcp/config.ts`, `skills/config.ts`,
 * `wake/config.ts`, `memory/config.ts`, `agents/config.ts`, `lsp/config.ts`). Each is validated by its own module,
 * which names the file and the path of a bad value, in `parseConfigFile`;
 * here they are only known keys. None of them is merged like the other keys
 * where it matters who wrote it: `load.ts` hands on both files as written.
 * `hooks` (`hooks/config.ts`) is one more, validated with whose file it is:
 * only the user's own may run a hook outside the sandbox.
 */
const FEATURE_SECTIONS = {
  mcp: parseMcpSection,
  skills: parseSkillsSection,
  wake: parseWakeSection,
  memory: parseMemorySection,
  agents: parseAgentsSection,
  lsp: parseLspSection,
} as const
const passed: Validator<unknown> = (input) => input

/** One configuration file, as written, without the sections of `FEATURE_SECTIONS`. */
const baseFile = section({
  /** Lets editors find a JSON schema. Ignored. */
  $schema: string,
  model: nonEmptyString,
  effort: nonEmptyString,
  checks,
  verify: section({ mode: verifyMode, maxRounds: boundedInteger(1, MAX_VERIFY_ROUNDS) }),
  /**
   * The approval policy (`approval/policy.ts`). Never merged like the other
   * keys: the project's section can only tighten the user's, so `load.ts`
   * hands both to `resolveApprovalConfig` and `resolveConfig` leaves it out.
   */
  approval: approvalSection,
  // Validated in `parseConfigFile`, by the modules that own them.
  mcp: passed,
  skills: passed,
  wake: passed,
  memory: passed,
  agents: passed,
  hooks: passed,
  lsp: passed,
})

/** One configuration file, as written. */
export type ConfigFile = Omit<Infer<typeof baseFile>, keyof typeof FEATURE_SECTIONS | "hooks"> & {
  /** MCP servers (`mcp/config.ts`). A server a project's file names is not started until the user approved it. */
  readonly mcp?: McpConfigSection
  /** Skills (`skills/config.ts`). */
  readonly skills?: SkillsConfigSection
  /** Wake-ups (`wake/config.ts`). A project's file can only tighten the user's. */
  readonly wake?: WakeConfigSection
  /** Memory (`memory/config.ts`). Off unless a file turns it on. */
  readonly memory?: MemoryConfigSection
  /** Agents (`agents/config.ts`). The default agent is read from the user's own file only. */
  readonly agents?: AgentsConfigSection
  /**
   * Hooks (`hooks/config.ts`): commands run before a tool call, after it and when a turn is about to end. Never
   * merged: a project's file adds hooks to the user's and replaces none, and each of its hooks runs only once the
   * user approved it (`resolveHooksConfig` is handed both files' sections).
   */
  readonly hooks?: HooksConfigSection
  /** Language servers (`lsp/config.ts`). One a project's file names or changes is not started until the user approved it. */
  readonly lsp?: LspConfigSection
}

/**
 * Validates one file's parsed JSON. Throws `DecodeError` (this file's keys) or `ConfigError` (a feature's section), without a file name in the former.
 * `origin` says whose file it is, for the one section that is validated differently for a project's (`hooks`).
 */
export function configFile(input: unknown, path: string, file = "configuration", origin: HookOrigin = "user"): ConfigFile {
  const { mcp, skills, wake, memory, agents, hooks, lsp, ...rest } = baseFile(input, path)
  return {
    ...rest,
    ...(mcp === undefined ? {} : { mcp: FEATURE_SECTIONS.mcp(mcp, file) }),
    ...(skills === undefined ? {} : { skills: FEATURE_SECTIONS.skills(skills, file) }),
    ...(wake === undefined ? {} : { wake: FEATURE_SECTIONS.wake(wake, file) }),
    ...(memory === undefined ? {} : { memory: FEATURE_SECTIONS.memory(memory, file) }),
    ...(agents === undefined ? {} : { agents: FEATURE_SECTIONS.agents(agents, file) }),
    ...(hooks === undefined ? {} : { hooks: parseHooksSection(hooks, file, origin) }),
    ...(lsp === undefined ? {} : { lsp: FEATURE_SECTIONS.lsp(lsp, file) }),
  }
}

export interface CheckConfig {
  readonly name: string
  readonly command: string
  readonly timeoutSeconds: number
  /** `null`: any changed file triggers the check. */
  readonly when: readonly string[] | null
}

/** The effective configuration: both files merged, defaults applied. */
export interface Config {
  readonly model: string | null
  readonly effort: string | null
  readonly checks: readonly CheckConfig[]
  readonly verify: { readonly mode: VerifyMode; readonly maxRounds: number }
}

/** Parses and validates one file's text. `file` is used only in error messages; `origin` is whose file it is (a project's may not say everything the user's may). */
export function parseConfigFile(text: string, file: string, origin: HookOrigin = "user"): ConfigFile {
  const parsed = parseJson(text, file)
  try {
    return configFile(parsed, "", file, origin)
  } catch (error) {
    if (error instanceof UnknownKeyError) throw new ConfigError(file, error.path, error.problem)
    if (error instanceof DecodeError) throw new ConfigError(file, error.path, error.message.slice((error.path === "" ? "value" : error.path).length + 2))
    throw error
  }
}

/** Merges two validated files: `project` wins key by key, sections merge recursively, lists replace. */
export function mergeConfigFiles(user: ConfigFile | null, project: ConfigFile | null): ConfigFile {
  return mergeObjects(user ?? {}, project ?? {}) as ConfigFile
}

/** Applies the defaults to a merged file. */
export function resolveConfig(file: ConfigFile): Config {
  return {
    model: file.model ?? null,
    effort: file.effort ?? null,
    checks: (file.checks ?? []).map((item) => ({
      name: item.name,
      command: item.command,
      timeoutSeconds: item.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
      when: item.when ?? null,
    })),
    verify: { mode: file.verify?.mode ?? DEFAULT_VERIFY.mode, maxRounds: file.verify?.maxRounds ?? DEFAULT_VERIFY.maxRounds },
  }
}

class UnknownKeyError extends DecodeError {
  readonly problem: string
  constructor(path: string, key: string, known: readonly string[]) {
    super(path, "a known key", undefined)
    const close = suggest(key, known)
    this.problem = `unknown key "${key}"${close === null ? "" : ` (did you mean "${close}"?)`}; known keys: ${known.join(", ")}`
    this.message = `${path}: ${this.problem}`
  }
}

type Shape = Record<string, Validator<unknown>>

/** A config section: every key optional, unknown keys rejected with a suggestion. */
function section<S extends Shape>(shape: S): Validator<{ readonly [K in keyof S]?: Infer<S[K]> }> {
  const known = Object.keys(shape)
  return (input, path) => {
    if (!isPlainObject(input)) throw new DecodeError(path, "object", input)
    const unknown = Object.keys(input).find((key) => !Object.hasOwn(shape, key))
    if (unknown !== undefined) throw new UnknownKeyError(join(path, unknown), unknown, known)
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, shape[key]!(value, join(path, key))]),
    ) as { readonly [K in keyof S]?: Infer<S[K]> }
  }
}

function mergeObjects(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(over)])].map((key) => {
      const a = base[key]
      const b = over[key]
      if (b === undefined) return [key, a]
      if (isPlainObject(a) && isPlainObject(b)) return [key, mergeObjects(a, b)]
      return [key, b]
    }),
  )
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ConfigError(file, "", `not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** The known key with the smallest edit distance, if it is close enough to be a likely typo. */
function suggest(key: string, known: readonly string[]): string | null {
  const scored = known
    .map((candidate) => ({ candidate, distance: editDistance(key.toLowerCase(), candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= Math.max(1, Math.floor(entry.candidate.length / 3)))
    .sort((a, b) => a.distance - b.distance)
  return scored[0]?.candidate ?? null
}

/** Optimal string alignment distance: insertions, deletions, substitutions and swaps of neighbours each cost 1. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function join(path: string, key: string) {
  return path === "" ? key : `${path}.${key}`
}
