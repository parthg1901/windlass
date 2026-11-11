import { describe, expect, test } from "bun:test"
import {
  DecodeError,
  array,
  branded,
  integer,
  json,
  literal,
  nullable,
  object,
  oneOf,
  safeDecode,
  string,
  variant,
} from "../src/validate.ts"

const shape = variant("kind", {
  circle: object({ kind: literal("circle"), radius: integer(0) }),
  label: object({ kind: literal("label"), text: string, tags: array(oneOf(["a", "b"])), note: nullable(string) }),
})

describe("validate", () => {
  test("returns the decoded value", () => {
    const input: unknown = { kind: "label", text: "hi", tags: ["a", "b"], note: null }
    const decoded = shape(input, "")
    expect(decoded).toEqual({ kind: "label", text: "hi", tags: ["a", "b"], note: null })
    expect(decoded).not.toBe(input as never)
  })

  test("rejects an unknown key instead of dropping it", () => {
    const result = safeDecode(shape, { kind: "circle", radius: 1, colour: "red" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toBe("colour")
  })

  test("rejects a missing key; absent values must be explicit null", () => {
    const result = safeDecode(shape, { kind: "label", text: "hi", tags: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toBe("note")
  })

  test("reports the path of a nested failure", () => {
    const result = safeDecode(object({ items: array(shape) }), { items: [{ kind: "circle", radius: -1 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe("items[0].radius: expected integer >= 0, got -1")
  })

  test("rejects an unknown variant tag", () => {
    expect(() => shape({ kind: "square" }, "")).toThrow(DecodeError)
    expect(() => shape({}, "")).toThrow(DecodeError)
    expect(() => shape({ kind: "toString" }, "")).toThrow(DecodeError)
  })

  test("integer rejects fractions, unsafe values and other types", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "1", null])
      expect(() => integer()(bad, "n")).toThrow(DecodeError)
    expect(integer()(-3, "n")).toBe(-3)
  })

  test("json accepts JSON and rejects everything else, deeply", () => {
    const value = { a: [1, "x", null, { b: true }] }
    expect(json(value, "")).toEqual(value)
    for (const bad of [undefined, Number.NaN, new Date(0), { a: [undefined] }, { a: () => 1 }, new Map()])
      expect(() => json(bad, "")).toThrow(DecodeError)
  })

  test("objects reject arrays, null and class instances", () => {
    for (const bad of [[], null, new Date(0), "x"]) expect(() => object({})(bad, "")).toThrow(DecodeError)
  })

  test("branded validates the underlying string", () => {
    const id = branded<string & { readonly __id: "thing" }>()
    expect(id("abc", "")).toBe("abc" as never)
    expect(() => id("", "")).toThrow(DecodeError)
  })

  test("safeDecode lets errors that are not DecodeError through", () => {
    expect(() =>
      safeDecode(() => {
        throw new RangeError("bug")
      }, 1),
    ).toThrow(RangeError)
  })
})
