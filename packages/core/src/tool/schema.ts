/**
 * A small JSON Schema validator for tool input. It supports the subset the
 * tools use and rejects any other keyword when a schema is compiled, so a tool
 * cannot declare a constraint that is silently not enforced.
 *
 * Supported: `type` (a name or a list of names), `properties`, `required`,
 * `additionalProperties` (boolean or schema), `enum`, `items`, `minimum`,
 * `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`. `description`,
 * `default` and `title` are accepted and ignored: the runtime does not apply
 * defaults, so a tool reads an absent optional value as "use the default".
 */
import type { Json } from "../json.ts"

export interface SchemaIssue {
  /** Where the problem is, e.g. `edits[2].path`. Empty for the arguments object itself. */
  readonly path: string
  readonly message: string
}

export type SchemaCheck = (value: Json) => SchemaIssue[]

const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const
type TypeName = (typeof TYPES)[number]

const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "description",
  "default",
  "title",
])

/** Thrown by `compileSchema` when a schema uses something this validator does not support. */
export class SchemaError extends Error {
  constructor(path: string, message: string) {
    super(`${path === "" ? "schema" : `schema at ${path}`}: ${message}`)
    this.name = "SchemaError"
  }
}

/** Compiles a schema once into a check that returns every issue it finds (in document order). */
export function compileSchema(schema: Json): SchemaCheck {
  const node = compile(schema, "")
  return (value) => {
    const issues: SchemaIssue[] = []
    node(value, "", issues)
    return issues
  }
}

type Node = (value: Json, path: string, issues: SchemaIssue[]) => void

function compile(schema: Json, at: string): Node {
  if (schema === true) return () => {}
  if (!isObject(schema)) throw new SchemaError(at, "a schema must be an object")
  const unknown = Object.keys(schema).find((key) => !KEYWORDS.has(key))
  if (unknown !== undefined) throw new SchemaError(at, `unsupported keyword "${unknown}"`)

  const types = readTypes(schema.type, at)
  const enumValues = schema.enum === undefined ? null : readEnum(schema.enum, at)
  const minimum = readNumber(schema, "minimum", at)
  const maximum = readNumber(schema, "maximum", at)
  const minLength = readNumber(schema, "minLength", at)
  const maxLength = readNumber(schema, "maxLength", at)
  const minItems = readNumber(schema, "minItems", at)
  const maxItems = readNumber(schema, "maxItems", at)
  const properties = readProperties(schema.properties, at)
  const required = readRequired(schema.required, at)
  const additional = readAdditional(schema.additionalProperties, at)
  const items = schema.items === undefined ? null : compile(schema.items, `${at}.items`)

  return (value, path, issues) => {
    if (types !== null && !types.some((type) => hasType(value, type))) {
      issues.push({ path, message: `must be ${types.map(article).join(" or ")}, got ${describe(value)}` })
      return
    }
    if (enumValues !== null && !enumValues.some((option) => sameJson(option, value))) {
      issues.push({ path, message: `must be one of ${enumValues.map((v) => JSON.stringify(v)).join(", ")}, got ${describe(value)}` })
      return
    }
    if (typeof value === "number") {
      if (minimum !== null && value < minimum) issues.push({ path, message: `must be at least ${minimum}, got ${value}` })
      if (maximum !== null && value > maximum) issues.push({ path, message: `must be at most ${maximum}, got ${value}` })
    }
    if (typeof value === "string") {
      const length = [...value].length
      if (minLength !== null && length < minLength)
        issues.push({ path, message: minLength === 1 ? "must not be empty" : `must have at least ${minLength} characters` })
      if (maxLength !== null && length > maxLength) issues.push({ path, message: `must have at most ${maxLength} characters` })
    }
    if (Array.isArray(value)) {
      if (minItems !== null && value.length < minItems) issues.push({ path, message: `must have at least ${minItems} items` })
      if (maxItems !== null && value.length > maxItems) issues.push({ path, message: `must have at most ${maxItems} items` })
      if (items !== null) value.forEach((item, index) => items(item, `${path}[${index}]`, issues))
    }
    if (isObject(value)) {
      for (const key of required) if (!Object.hasOwn(value, key)) issues.push({ path: join(path, key), message: "is required" })
      for (const [key, child] of Object.entries(value)) {
        const property = properties.get(key)
        if (property !== undefined) property(child, join(path, key), issues)
        else if (additional === false) issues.push({ path: join(path, key), message: "is not a known parameter" })
        else if (additional !== true) additional(child, join(path, key), issues)
      }
    }
  }
}

function readTypes(type: Json | undefined, at: string): TypeName[] | null {
  if (type === undefined) return null
  const list = Array.isArray(type) ? type : [type]
  return list.map((name) => {
    if (typeof name !== "string" || !(TYPES as readonly string[]).includes(name))
      throw new SchemaError(at, `unsupported type ${JSON.stringify(name)}`)
    return name as TypeName
  })
}

function readEnum(values: Json, at: string): readonly Json[] {
  if (!Array.isArray(values) || values.length === 0) throw new SchemaError(at, "enum must be a non-empty array")
  return values
}

function readNumber(schema: { readonly [key: string]: Json }, key: string, at: string): number | null {
  const value = schema[key]
  if (value === undefined) return null
  if (typeof value !== "number") throw new SchemaError(at, `${key} must be a number`)
  return value
}

function readProperties(properties: Json | undefined, at: string): Map<string, Node> {
  if (properties === undefined) return new Map()
  if (!isObject(properties)) throw new SchemaError(at, "properties must be an object")
  return new Map(Object.entries(properties).map(([key, child]) => [key, compile(child, join(`${at}.properties`, key))]))
}

function readRequired(required: Json | undefined, at: string): string[] {
  if (required === undefined) return []
  if (!Array.isArray(required) || !required.every((key) => typeof key === "string"))
    throw new SchemaError(at, "required must be an array of strings")
  return required as string[]
}

function readAdditional(additional: Json | undefined, at: string): boolean | Node {
  if (additional === undefined || additional === true) return true
  if (additional === false) return false
  return compile(additional, `${at}.additionalProperties`)
}

function hasType(value: Json, type: TypeName): boolean {
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
  }
}

function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameJson(item, b[index]!))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key]!, b[key]!))
  }
  return false
}

function isObject(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function article(type: TypeName) {
  return type === "integer" || type === "object" || type === "array" ? `an ${type}` : type === "null" ? "null" : `a ${type}`
}

function describe(value: Json): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  if (typeof value === "string") return value.length > 40 ? `a string of ${value.length} characters` : JSON.stringify(value)
  return String(value)
}

function join(path: string, key: string) {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
  if (path === "") return segment
  return segment.startsWith('"') ? `${path}[${segment}]` : `${path}.${segment}`
}
