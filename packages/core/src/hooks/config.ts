/**
 * The `hooks` configuration section, in the style of `config/schema.ts` (every key optional, unknown keys
 * rejected). Adding it to the configuration file is the engine's change; until then this validator is used on
 * its own.
 *
 *   "hooks": {
 *     "beforeTool": [{ "name": "no-push", "tools": ["shell"], "command": "./scripts/hooks/no-push.sh" }],
 *     "afterTool":  [{ "name": "format", "tools": ["edit", "write"], "paths": ["**\/*.ts"], "command": "bunx prettier --write \"$<PREFIX>_HOOK_PATHS\" >/dev/null" }],
 *     "stop":       [{ "name": "no-todo-file", "command": "test ! -e TODO.tmp || { echo 'Remove TODO.tmp first.'; exit 2; }" }],
 *     "maxStopRounds": 3
 *   }
 *
 * A hook:
 * - `command` (required): run with `bash -c` (or `/bin/sh -c`) in the working directory. See README.md for
 *   what it is given and how it answers.
 * - `name`: shown to the model and the user. Default: the point and its position, e.g. `beforeTool[0]`.
 * - `tools` (before and after only): tool names, `*` matching any run of characters (`mcp__*`). Default: every tool.
 * - `paths` (before and after only): glob patterns (Bun.Glob, as the checks' `when`) matched against the paths the
 *   call names, relative to the working directory. A hook with `paths` applies only to calls that name a path
 *   (the file tools); a shell command never matches it.
 * - `timeoutSeconds`: 1 to 300. Default 10 for before and after, 60 for stop.
 * - `onError` (before only): `"refuse"` (the default) or `"allow"`: what happens to the call when the hook
 *   cannot answer (timed out, crashed, answered garbage, could not run).
 * - `sandbox` (the user's file only): `false` runs the hook outside the sandbox, with the user's full rights and
 *   the network. A project's file that says so is an error: a repository never chooses to leave the sandbox.
 *
 * `maxStopRounds` (1 to 10, default 3): how many times per turn stop hooks may send the model back. A project's
 * file can only lower the user's number.
 */
import { createHash } from "node:crypto"
import { canonicalJson } from "../request/canonical.ts"
import { ConfigError } from "../config/schema.ts"

export type HookPoint = "beforeTool" | "afterTool" | "stop"
export const HOOK_POINTS: readonly HookPoint[] = ["beforeTool", "afterTool", "stop"]

/** Whose file a hook comes from. A user's hook is the user's own; a project's hook needs the user's approval. */
export type HookOrigin = "user" | "project"

export const HOOK_LIMITS = {
  /** Hooks per point per file. */
  maxHooks: 32,
  timeoutSeconds: { min: 1, max: 300, beforeDefault: 10, afterDefault: 10, stopDefault: 60 },
  maxStopRounds: { min: 1, max: 10, default: 3 },
  maxCommandLength: 8192,
  maxNameLength: 64,
  maxPatterns: 64,
} as const

export interface HookEntry {
  readonly name?: string
  readonly tools?: readonly string[]
  readonly paths?: readonly string[]
  readonly command: string
  readonly timeoutSeconds?: number
  readonly onError?: "refuse" | "allow"
  readonly sandbox?: boolean
}

export interface HooksConfigSection {
  readonly beforeTool?: readonly HookEntry[]
  readonly afterTool?: readonly HookEntry[]
  readonly stop?: readonly HookEntry[]
  readonly maxStopRounds?: number
}

/** One hook with its defaults applied. */
export interface Hook {
  /** Stable within one configuration: `<origin>.<point>[<index>]`. */
  readonly id: string
  readonly point: HookPoint
  readonly origin: HookOrigin
  readonly name: string
  /** `null`: every tool. Always `null` for `stop`. */
  readonly tools: readonly string[] | null
  /** `null`: any call, with or without paths. Always `null` for `stop`. */
  readonly paths: readonly string[] | null
  readonly command: string
  readonly timeoutSeconds: number
  /** What a call gets when a before hook cannot answer. `"allow"` for after and stop hooks, where it means nothing. */
  readonly onError: "refuse" | "allow"
  /** `false` only for a user's hook that asked to run outside the sandbox. */
  readonly sandbox: boolean
  /** SHA-256 of everything that decides what the hook runs and when (not its name). See `trust.ts`. */
  readonly fingerprint: string
}

export interface HooksConfig {
  /** The user's hooks first, then the project's, each in file order. */
  readonly beforeTool: readonly Hook[]
  readonly afterTool: readonly Hook[]
  readonly stop: readonly Hook[]
  readonly maxStopRounds: number
  /** What the project's file asked for and did not get, to be shown once. */
  readonly ignored: readonly string[]
}

export const NO_HOOKS: HooksConfig = { beforeTool: [], afterTool: [], stop: [], maxStopRounds: HOOK_LIMITS.maxStopRounds.default, ignored: [] }

const KEYS = ["beforeTool", "afterTool", "stop", "maxStopRounds"]
const ENTRY_KEYS: Record<HookPoint, readonly string[]> = {
  beforeTool: ["name", "tools", "paths", "command", "timeoutSeconds", "onError", "sandbox"],
  afterTool: ["name", "tools", "paths", "command", "timeoutSeconds", "sandbox"],
  stop: ["name", "command", "timeoutSeconds", "sandbox"],
}

/**
 * Validates the value of the `hooks` key of one file. `origin` says whose file it is: only the user's may set
 * `sandbox: false`. Throws `ConfigError` naming the file and path.
 */
export function parseHooksSection(value: unknown, file: string, origin: HookOrigin): HooksConfigSection {
  const record = objectAt(value, file, "hooks", KEYS)
  const section: { -readonly [K in keyof HooksConfigSection]: HooksConfigSection[K] } = {}
  for (const point of HOOK_POINTS) {
    const list = record[point]
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new ConfigError(file, `hooks.${point}`, "expected an array of hooks")
    if (list.length > HOOK_LIMITS.maxHooks) throw new ConfigError(file, `hooks.${point}`, `at most ${HOOK_LIMITS.maxHooks} hooks`)
    section[point] = list.map((item, index) => parseEntry(item, file, `hooks.${point}[${index}]`, point, origin))
    const names = section[point]!.map((entry) => entry.name).filter((name) => name !== undefined)
    names.forEach((name, index) => {
      if (names.indexOf(name) !== index) throw new ConfigError(file, `hooks.${point}`, `the name "${name}" is used twice`)
    })
  }
  if (record.maxStopRounds !== undefined) section.maxStopRounds = whole(file, "hooks.maxStopRounds", record.maxStopRounds, HOOK_LIMITS.maxStopRounds.min, HOOK_LIMITS.maxStopRounds.max)
  return section
}

function parseEntry(value: unknown, file: string, at: string, point: HookPoint, origin: HookOrigin): HookEntry {
  const record = objectAt(value, file, at, ENTRY_KEYS[point])
  const command = record.command
  if (typeof command !== "string" || command.trim() === "") throw new ConfigError(file, `${at}.command`, "expected a non-empty command")
  if (command.length > HOOK_LIMITS.maxCommandLength) throw new ConfigError(file, `${at}.command`, `at most ${HOOK_LIMITS.maxCommandLength} characters`)
  if (command.includes("\0")) throw new ConfigError(file, `${at}.command`, "a command cannot contain a NUL character")
  const entry: { -readonly [K in keyof HookEntry]: HookEntry[K] } = { command }
  if (record.name !== undefined) {
    const name = record.name
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.length > HOOK_LIMITS.maxNameLength)
      throw new ConfigError(file, `${at}.name`, `expected a name of letters, digits, '_', '.' and '-' (at most ${HOOK_LIMITS.maxNameLength})`)
    entry.name = name
  }
  if (record.tools !== undefined) entry.tools = patternList(file, `${at}.tools`, record.tools, (item) => (/^[A-Za-z0-9_.*-]+$/.test(item) ? null : "expected a tool name with letters, digits, '_', '.', '-' and '*'"))
  if (record.paths !== undefined)
    entry.paths = patternList(file, `${at}.paths`, record.paths, (item) => {
      if (item.startsWith("!")) return "negation with '!' is not supported"
      if (item.startsWith("/")) return "expected a pattern relative to the working directory"
      return null
    })
  if (record.timeoutSeconds !== undefined) entry.timeoutSeconds = whole(file, `${at}.timeoutSeconds`, record.timeoutSeconds, HOOK_LIMITS.timeoutSeconds.min, HOOK_LIMITS.timeoutSeconds.max)
  if (record.onError !== undefined) {
    if (record.onError !== "refuse" && record.onError !== "allow") throw new ConfigError(file, `${at}.onError`, 'expected "refuse" or "allow"')
    entry.onError = record.onError
  }
  if (record.sandbox !== undefined) {
    if (typeof record.sandbox !== "boolean") throw new ConfigError(file, `${at}.sandbox`, "expected true or false")
    if (origin === "project" && record.sandbox === false)
      throw new ConfigError(file, `${at}.sandbox`, "only the user's own configuration file can run a hook outside the sandbox")
    entry.sandbox = record.sandbox
  }
  return entry
}

/**
 * Both files' hooks with the defaults applied: the user's first, then the project's. Lists are not merged key
 * by key like the rest of the configuration: a project adds hooks, it never replaces or removes the user's.
 */
export function resolveHooksConfig(user: HooksConfigSection | undefined, project: HooksConfigSection | undefined): HooksConfig {
  const ignored: string[] = []
  const hooks = (point: HookPoint) => [...build(user, "user", point), ...build(project, "project", point)]
  const base = user?.maxStopRounds ?? HOOK_LIMITS.maxStopRounds.default
  const theirs = project?.maxStopRounds
  if (theirs !== undefined && theirs > base) ignored.push(`hooks.maxStopRounds: the project's ${theirs} is above the user's ${base}`)
  return { beforeTool: hooks("beforeTool"), afterTool: hooks("afterTool"), stop: hooks("stop"), maxStopRounds: theirs === undefined ? base : Math.min(base, theirs), ignored }
}

function build(section: HooksConfigSection | undefined, origin: HookOrigin, point: HookPoint): Hook[] {
  return (section?.[point] ?? []).map((entry, index) => {
    const timeoutSeconds = entry.timeoutSeconds ?? (point === "stop" ? HOOK_LIMITS.timeoutSeconds.stopDefault : HOOK_LIMITS.timeoutSeconds.beforeDefault)
    const shape = {
      point,
      tools: point === "stop" ? null : (entry.tools ?? null),
      paths: point === "stop" ? null : (entry.paths ?? null),
      command: entry.command,
      timeoutSeconds,
      onError: point === "beforeTool" ? (entry.onError ?? "refuse") : ("allow" as const),
      // A project's hook is always sandboxed (the validator refuses `false` from it).
      sandbox: origin === "project" ? true : (entry.sandbox ?? true),
    }
    return { id: `${origin}.${point}[${index}]`, origin, name: entry.name ?? `${point}[${index}]`, ...shape, fingerprint: hookFingerprint(shape) }
  })
}

/**
 * The fingerprint of what a hook runs and when: the point, the matchers, the command, the timeout and the
 * error behaviour, as canonical JSON, hashed. The name is left out: renaming a hook changes nothing it does.
 */
export function hookFingerprint(hook: Pick<Hook, "point" | "tools" | "paths" | "command" | "timeoutSeconds" | "onError" | "sandbox">): string {
  const value = { point: hook.point, tools: hook.tools, paths: hook.paths, command: hook.command, timeoutSeconds: hook.timeoutSeconds, onError: hook.onError, sandbox: hook.sandbox }
  return `hook-sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
}

function patternList(file: string, at: string, value: unknown, check: (item: string) => string | null): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError(file, at, "expected a non-empty array of patterns (omit the key to match everything)")
  if (value.length > HOOK_LIMITS.maxPatterns) throw new ConfigError(file, at, `at most ${HOOK_LIMITS.maxPatterns} patterns`)
  return value.map((item, index) => {
    if (typeof item !== "string" || item === "") throw new ConfigError(file, `${at}[${index}]`, "expected a non-empty string")
    const problem = check(item)
    if (problem !== null) throw new ConfigError(file, `${at}[${index}]`, problem)
    return item
  })
}

function whole(file: string, at: string, item: unknown, low: number, high: number): number {
  if (typeof item !== "number" || !Number.isInteger(item) || item < low || item > high) throw new ConfigError(file, at, `expected a whole number from ${low} to ${high}`)
  return item
}

function objectAt(value: unknown, file: string, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, at, "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !keys.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `${at}.${unknown}`, `unknown key "${unknown}"; known keys: ${keys.join(", ")}`)
  return record
}
