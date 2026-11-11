/**
 * Canonical JSON: one byte sequence per JSON value, whatever order its keys
 * were inserted in. Block hashes are taken over this form.
 *
 * Rules:
 * - Object keys are sorted by UTF-16 code unit, the same on every machine.
 * - No whitespace.
 * - Numbers and strings are written as `JSON.stringify` writes them, so `-0`
 *   becomes `0` and `1.0` becomes `1`.
 * - An object property whose value is `undefined` is omitted, as `JSON.stringify` does.
 * - Anything else that is not JSON throws: `NaN`, `Infinity`, `undefined` in an
 *   array, `bigint`, functions, symbols, and objects that are not plain
 *   (`Date`, `Map`, class instances). Silently coercing them would let two
 *   different requests hash the same.
 */
import type { Json } from "../json.ts"

export function canonicalJson(value: unknown): string {
  return write(value, "")
}

/**
 * Returns a deep copy with every object's keys in canonical order, so that
 * `JSON.stringify(canonicalize(value)) === canonicalJson(value)`. A provider
 * uses this to make the bytes it sends match the bytes that were hashed.
 */
export function canonicalize(value: unknown): Json {
  return JSON.parse(canonicalJson(value)) as Json
}

function write(value: unknown, path: string): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${at(path)}: ${value} is not representable in JSON`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => write(item, `${path}[${index}]`)).join(",")}]`
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${at(path)}: only plain objects are representable in canonical JSON`)
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${write(record[key], path === "" ? key : `${path}.${key}`)}`)
    return `{${members.join(",")}}`
  }
  throw new TypeError(`${at(path)}: ${typeof value} is not representable in JSON`)
}

function at(path: string) {
  return path === "" ? "value" : path
}
