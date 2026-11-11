import { describe, expect, test } from "bun:test"
import { canonicalJson, canonicalize } from "../../src/request/canonical.ts"

describe("canonicalJson", () => {
  test("is independent of key insertion order, at every depth", () => {
    const a = { b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }
    const b = { a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}')
  })

  test("keeps array order, because order is content", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })

  test("sorts keys by UTF-16 code unit, not by locale", () => {
    // Locale-aware collation would put "a" before "B" and "é" before "z".
    expect(canonicalJson({ a: 1, B: 2, é: 3, z: 4, "": 5, "10": 6, "9": 7 })).toBe(
      '{"":5,"10":6,"9":7,"B":2,"a":1,"z":4,"é":3}',
    )
  })

  test("writes no whitespace and escapes strings as JSON does", () => {
    expect(canonicalJson({ text: 'line\n"quoted"\t\u0001 é 🙂' })).toBe(
      JSON.stringify({ text: 'line\n"quoted"\t\u0001 é 🙂' }),
    )
  })

  test("normalises numbers", () => {
    expect(canonicalJson([-0, 1.0, 1e21, 0.1, -1.5e-7])).toBe("[0,1,1e+21,0.1,-1.5e-7]")
  })

  test("omits undefined object properties, like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  test("treats null and a missing key as different", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })

  test("distinguishes values that look alike", () => {
    const values = [1, "1", true, "true", null, "null", [], {}, [[]], [{}], "", 0, false]
    expect(new Set(values.map(canonicalJson)).size).toBe(values.length)
  })

  test("throws on anything that is not JSON, naming where", () => {
    expect(() => canonicalJson({ a: [1, Number.NaN] })).toThrow("a[1]")
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError)
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError)
    expect(() => canonicalJson({ a: Symbol("s") })).toThrow(TypeError)
    expect(() => canonicalJson({ when: new Date(0) })).toThrow("when")
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(TypeError)
  })

  test("accepts objects without a prototype", () => {
    const bare = Object.assign(Object.create(null), { b: 1, a: 2 })
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}')
  })

  test("round-trips through JSON.parse", () => {
    const value = { z: [1, { b: "x", a: null }], a: "é" }
    expect(JSON.parse(canonicalJson(value))).toEqual(value)
  })

  test("canonicalize makes JSON.stringify produce the canonical text", () => {
    const value = { z: 1, a: { c: [{ y: 1, x: 2 }], b: 2 } }
    expect(JSON.stringify(canonicalize(value))).toBe(canonicalJson(value))
    expect(Object.keys(canonicalize(value) as object)).toEqual(["a", "z"])
  })
})
