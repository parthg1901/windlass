/**
 * Checks a model's arguments against an MCP tool's input schema before they
 * are sent, so a mistake comes back as an error the model can fix instead of
 * a round trip to the server.
 *
 * The harness's own validator (`tool/schema.ts`) rejects every keyword it does
 * not enforce, which is right for schemas the harness writes. MCP schemas are
 * written by servers and may use any JSON Schema 2020-12 keyword, so this one
 * is lenient: it enforces the common keywords and ignores the rest (`format`,
 * `patternProperties`, `dependentSchemas` ...). The server validates again;
 * this check only has to catch what a model typically gets wrong, and must
 * never refuse arguments the server would accept.
 *
 * Enforced: `type`, `enum`, `const`, `properties`, `required`,
 * `additionalProperties`, `items` (and the draft-07 tuple form), `prefixItems`,
 * `minItems`, `maxItems`, `uniqueItems`, `minimum`, `maximum`,
 * `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`,
 * `maxLength`, `pattern`, `minProperties`, `maxProperties`, `allOf`, `anyOf`,
 * `oneOf`, `not`, `if`/`then`/`else`, boolean schemas, and `$ref` to a JSON
 * pointer inside the same schema (`#/$defs/...`). A `$ref` to anything else is
 * not followed (never fetched) and accepts any value.
 *
 * A server's schema is untrusted input, so the work is bounded: a budget of
 * schema nodes per check, and a depth limit for `$ref` chains.
 */
import type { Json } from "../json.ts"
import { isObject } from "./protocol.ts"

export interface ArgumentIssue {
  /** Where the problem is, e.g. `labels[1]`; empty for the arguments object itself. */
  readonly path: string
  readonly message: string
}

const NODE_BUDGET = 20_000
const MAX_DEPTH = 64

export function checkArguments(schema: Json, value: Json): ArgumentIssue[] {
  const state = { budget: NODE_BUDGET, root: schema }
  const issues: ArgumentIssue[] = []
  check(schema, value, "", 0, state, issues)
  return issues
}

interface State {
  budget: number
  readonly root: Json
}

function check(schema: Json, value: Json, path: string, depth: number, state: State, issues: ArgumentIssue[]): void {
  state.budget -= 1
  // Out of budget or too deep: accept rather than refuse, the server checks again.
  if (state.budget < 0 || depth > MAX_DEPTH) return
  if (schema === true || schema === undefined) return
  if (schema === false) {
    issues.push({ path, message: "is not allowed here" })
    return
  }
  if (!isObject(schema)) return
  const s = schema as { readonly [key: string]: Json }

  if (typeof s.$ref === "string") {
    const target = resolveRef(state.root, s.$ref)
    if (target !== undefined) check(target, value, path, depth + 1, state, issues)
  }

  const types = readTypes(s.type)
  if (types !== null && !types.some((type) => hasType(value, type))) {
    issues.push({ path, message: `must be ${types.map(article).join(" or ")}, got ${describe(value)}` })
    return
  }
  if (Array.isArray(s.enum) && !s.enum.some((option) => sameJson(option, value))) {
    issues.push({ path, message: `must be one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${describe(value)}` })
    return
  }
  if (Object.hasOwn(s, "const") && !sameJson(s.const!, value)) {
    issues.push({ path, message: `must be ${JSON.stringify(s.const)}, got ${describe(value)}` })
    return
  }

  if (typeof value === "number") checkNumber(s, value, path, issues)
  if (typeof value === "string") checkString(s, value, path, issues)
  if (Array.isArray(value)) checkArray(s, value, path, depth, state, issues)
  if (isObject(value)) checkObject(s, value as { readonly [key: string]: Json }, path, depth, state, issues)

  if (Array.isArray(s.allOf)) for (const branch of s.allOf) check(branch, value, path, depth + 1, state, issues)
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const results = s.anyOf.map((branch) => attempt(branch, value, path, depth, state))
    if (!results.some((result) => result.length === 0)) issues.push(...closest(results, path, "must match at least one of the allowed shapes"))
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const results = s.oneOf.map((branch) => attempt(branch, value, path, depth, state))
    const matching = results.filter((result) => result.length === 0).length
    if (matching === 0) issues.push(...closest(results, path, "must match exactly one of the allowed shapes"))
    if (matching > 1) issues.push({ path, message: "matches more than one of the allowed shapes; it must match exactly one" })
  }
  if (s.not !== undefined && attempt(s.not, value, path, depth, state).length === 0) issues.push({ path, message: "is a value the schema does not allow" })
  if (s.if !== undefined) {
    const branch = attempt(s.if, value, path, depth, state).length === 0 ? s.then : s.else
    if (branch !== undefined) check(branch, value, path, depth + 1, state, issues)
  }
}

function attempt(schema: Json, value: Json, path: string, depth: number, state: State): ArgumentIssue[] {
  const issues: ArgumentIssue[] = []
  check(schema, value, path, depth + 1, state, issues)
  return issues
}

/** For a failed choice, the issues of the branch that came closest, so the message says what to change. */
function closest(results: ArgumentIssue[][], path: string, fallback: string): ArgumentIssue[] {
  // A branch that failed on the value's own type says nothing about what to change, so it ranks last.
  const wrongType = (issues: ArgumentIssue[]) => issues.length > 0 && issues.every((issue) => issue.path === path && issue.message.startsWith("must be "))
  const best = [...results].sort((a, b) => Number(wrongType(a)) - Number(wrongType(b)) || a.length - b.length)[0]!
  if (best.length === 0 || wrongType(best)) return [{ path, message: fallback }]
  return best
}

function checkNumber(s: { readonly [key: string]: Json }, value: number, path: string, issues: ArgumentIssue[]) {
  if (typeof s.minimum === "number" && value < s.minimum) issues.push({ path, message: `must be at least ${s.minimum}, got ${value}` })
  if (typeof s.maximum === "number" && value > s.maximum) issues.push({ path, message: `must be at most ${s.maximum}, got ${value}` })
  if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum)
    issues.push({ path, message: `must be greater than ${s.exclusiveMinimum}, got ${value}` })
  if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum)
    issues.push({ path, message: `must be less than ${s.exclusiveMaximum}, got ${value}` })
  if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
    const ratio = value / s.multipleOf
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) issues.push({ path, message: `must be a multiple of ${s.multipleOf}, got ${value}` })
  }
}

function checkString(s: { readonly [key: string]: Json }, value: string, path: string, issues: ArgumentIssue[]) {
  const length = [...value].length
  if (typeof s.minLength === "number" && length < s.minLength)
    issues.push({ path, message: s.minLength === 1 ? "must not be empty" : `must have at least ${s.minLength} characters` })
  if (typeof s.maxLength === "number" && length > s.maxLength) issues.push({ path, message: `must have at most ${s.maxLength} characters` })
  if (typeof s.pattern === "string") {
    const pattern = compilePattern(s.pattern)
    if (pattern !== null && !pattern.test(value)) issues.push({ path, message: `must match the pattern ${s.pattern}` })
  }
}

function checkArray(s: { readonly [key: string]: Json }, value: readonly Json[], path: string, depth: number, state: State, issues: ArgumentIssue[]) {
  if (typeof s.minItems === "number" && value.length < s.minItems) issues.push({ path, message: `must have at least ${s.minItems} items` })
  if (typeof s.maxItems === "number" && value.length > s.maxItems) issues.push({ path, message: `must have at most ${s.maxItems} items` })
  if (s.uniqueItems === true && value.some((item, index) => value.findIndex((other) => sameJson(other, item)) !== index))
    issues.push({ path, message: "must not contain the same item twice" })
  // 2020-12: `prefixItems` then `items` for the rest. Draft-07: `items` as an array is the tuple form.
  const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : []
  const rest = Array.isArray(s.items) ? (s.additionalItems ?? true) : (s.items ?? true)
  value.forEach((item, index) => check(index < prefix.length ? prefix[index]! : rest, item, `${path}[${index}]`, depth + 1, state, issues))
}

function checkObject(
  s: { readonly [key: string]: Json },
  value: { readonly [key: string]: Json },
  path: string,
  depth: number,
  state: State,
  issues: ArgumentIssue[],
) {
  const properties = isObject(s.properties) ? (s.properties as { readonly [key: string]: Json }) : {}
  const keys = Object.keys(value)
  if (Array.isArray(s.required))
    for (const key of s.required) if (typeof key === "string" && !Object.hasOwn(value, key)) issues.push({ path: join(path, key), message: "is required" })
  if (typeof s.minProperties === "number" && keys.length < s.minProperties) issues.push({ path, message: `must have at least ${s.minProperties} properties` })
  if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) issues.push({ path, message: `must have at most ${s.maxProperties} properties` })
  // Keys that `patternProperties` would cover are left alone: this check does not evaluate patterns for keys.
  const patterned = isObject(s.patternProperties) ? Object.keys(s.patternProperties).flatMap((p) => compilePattern(p) ?? []) : []
  for (const key of keys) {
    if (Object.hasOwn(properties, key)) {
      check(properties[key]!, value[key]!, join(path, key), depth + 1, state, issues)
      continue
    }
    if (patterned.some((pattern) => pattern.test(key))) continue
    if (s.additionalProperties === false) issues.push({ path: join(path, key), message: unknownKeyMessage(key, Object.keys(properties)) })
    else if (s.additionalProperties !== undefined && s.additionalProperties !== true)
      check(s.additionalProperties, value[key]!, join(path, key), depth + 1, state, issues)
  }
}

function resolveRef(root: Json, ref: string): Json | undefined {
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  let node: Json | undefined = root
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(node)) node = node[Number(key)]
    else if (isObject(node)) node = (node as { readonly [key: string]: Json })[key]
    else return undefined
    if (node === undefined) return undefined
  }
  return node
}

const patterns = new Map<string, RegExp | null>()

/** A JSON Schema pattern as a regular expression, or `null` when JavaScript cannot compile it (then it is not enforced). */
function compilePattern(source: string): RegExp | null {
  if (!patterns.has(source)) {
    let compiled: RegExp | null
    try {
      compiled = new RegExp(source, "u")
    } catch {
      compiled = null
    }
    if (patterns.size > 1000) patterns.clear()
    patterns.set(source, compiled)
  }
  return patterns.get(source)!
}

const TYPE_NAMES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"])

function readTypes(type: Json | undefined): string[] | null {
  if (typeof type === "string") return TYPE_NAMES.has(type) ? [type] : null
  if (Array.isArray(type)) {
    const names = type.filter((name): name is string => typeof name === "string" && TYPE_NAMES.has(name))
    return names.length === 0 ? null : names
  }
  return null
}

function hasType(value: Json, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "object":
      return isObject(value)
    case "array":
      return Array.isArray(value)
    case "null":
      return value === null
    default:
      return true
  }
}

function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameJson(item, b[index]!))
  if (isObject(a) && isObject(b)) {
    const left = a as { readonly [key: string]: Json }
    const right = b as { readonly [key: string]: Json }
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key]!, right[key]!))
  }
  return false
}

function unknownKeyMessage(key: string, known: readonly string[]): string {
  const close = known.filter((name) => editDistance(name.toLowerCase(), key.toLowerCase()) <= Math.max(1, Math.floor(name.length / 3)))
  if (close.length === 1) return `is not a known parameter (did you mean "${close[0]}"?)`
  if (known.length === 0) return "is not a known parameter (this tool takes none)"
  return `is not a known parameter (known: ${known.join(", ")})`
}

/** Optimal string alignment distance: insertions, deletions, substitutions and swaps of neighbours each cost 1. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}

function describe(value: Json): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  if (typeof value === "string") return value.length > 40 ? `a string (${JSON.stringify(value.slice(0, 40))}…)` : `the string ${JSON.stringify(value)}`
  return `${typeof value} ${String(value)}`
}

function article(type: string) {
  return type === "integer" || type === "object" || type === "array" ? `an ${type}` : type === "null" ? "null" : `a ${type}`
}

function join(path: string, key: string) {
  return path === "" ? key : `${path}.${key}`
}
