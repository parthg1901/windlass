/**
 * Minimal runtime validation. Every type that crosses a storage boundary is
 * declared once as a validator and its TypeScript type is inferred from it, so
 * the decoder and the type cannot drift apart.
 *
 * Conventions:
 * - Objects are strict: an unknown key is an error, so a new field needs a new
 *   event version instead of slipping through unnoticed.
 * - There are no optional keys. An absent value is an explicit `null`, which
 *   keeps the stored JSON canonical.
 */
import type { Json } from "./json.ts"

/** Thrown by every validator. `path` points at the offending value, e.g. `data.parts[2].callId`. */
export class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: unknown,
  ) {
    super(`${path === "" ? "value" : path}: expected ${expected}, got ${describe(actual)}`)
    this.name = "DecodeError"
  }
}

/** Returns the validated value or throws `DecodeError`. */
export type Validator<T> = (input: unknown, path: string) => T

export type Infer<V> = V extends Validator<infer T> ? T : never

export const string: Validator<string> = (input, path) => {
  if (typeof input !== "string") throw new DecodeError(path, "string", input)
  return input
}

export const nonEmptyString: Validator<string> = (input, path) => {
  if (typeof input !== "string" || input === "") throw new DecodeError(path, "non-empty string", input)
  return input
}

export const boolean: Validator<boolean> = (input, path) => {
  if (typeof input !== "boolean") throw new DecodeError(path, "boolean", input)
  return input
}

/** A safe integer greater than or equal to `min`. */
export function integer(min = Number.MIN_SAFE_INTEGER): Validator<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min)
      throw new DecodeError(path, min === Number.MIN_SAFE_INTEGER ? "integer" : `integer >= ${min}`, input)
    return input
  }
}

/** Any JSON value, checked deeply. */
export const json: Validator<Json> = (input, path) => {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new DecodeError(path, "finite number", input)
    return input
  }
  if (Array.isArray(input)) return input.map((item, index) => json(item, `${path}[${index}]`))
  if (isPlainObject(input))
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, json(value, join(path, key))]))
  throw new DecodeError(path, "JSON value", input)
}

/** One of a fixed set of strings. */
export function oneOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return (input, path) => {
    if (typeof input !== "string" || !values.includes(input))
      throw new DecodeError(path, values.map((value) => JSON.stringify(value)).join(" | "), input)
    return input
  }
}

export function literal<const T extends string | number | boolean>(value: T): Validator<T> {
  return (input, path) => {
    if (input !== value) throw new DecodeError(path, JSON.stringify(value), input)
    return value
  }
}

export function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return (input, path) => (input === null ? null : inner(input, path))
}

export function array<T>(item: Validator<T>): Validator<readonly T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) throw new DecodeError(path, "array", input)
    return input.map((value, index) => item(value, `${path}[${index}]`))
  }
}

type Shape = Record<string, Validator<unknown>>

/** A strict object: every key in `shape` is required and no other key is allowed. */
export function object<S extends Shape>(shape: S): Validator<{ readonly [K in keyof S]: Infer<S[K]> }> {
  const keys = Object.keys(shape)
  return (input, path) => {
    if (!isPlainObject(input)) throw new DecodeError(path, "object", input)
    const unknown = Object.keys(input).find((key) => !Object.hasOwn(shape, key))
    if (unknown !== undefined) throw new DecodeError(join(path, unknown), "no such key", input[unknown])
    return Object.fromEntries(
      keys.map((key) => {
        if (!Object.hasOwn(input, key)) throw new DecodeError(join(path, key), "a value", undefined)
        return [key, shape[key]!(input[key], join(path, key))]
      }),
    ) as { readonly [K in keyof S]: Infer<S[K]> }
  }
}

/**
 * A discriminated union of strict objects. `variants` maps each value of the
 * `tag` key to the validator for that variant (which must itself validate the tag).
 */
export function variant<V extends Shape>(tag: string, variants: V): Validator<Infer<V[keyof V]>> {
  const expected = Object.keys(variants)
    .map((name) => JSON.stringify(name))
    .join(" | ")
  return (input, path) => {
    if (!isPlainObject(input)) throw new DecodeError(path, "object", input)
    const name = input[tag]
    if (typeof name !== "string" || !Object.hasOwn(variants, name)) throw new DecodeError(join(path, tag), expected, name)
    return variants[name]!(input, path) as Infer<V[keyof V]>
  }
}

/** Narrows a validated string to a branded type. The brand exists only at compile time. */
export function branded<B extends string>(inner: Validator<string> = nonEmptyString): Validator<B> {
  return (input, path) => inner(input, path) as B
}

export type DecodeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DecodeError }

/** Runs a validator without throwing. Errors that are not `DecodeError` still propagate. */
export function safeDecode<T>(validator: Validator<T>, input: unknown): DecodeResult<T> {
  try {
    return { ok: true, value: validator(input, "") }
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, error }
    throw error
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

function describe(value: unknown) {
  if (value === undefined) return "nothing"
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "object") return "object"
  if (typeof value === "string") return value.length > 40 ? `string(${value.length})` : JSON.stringify(value)
  return String(value)
}
