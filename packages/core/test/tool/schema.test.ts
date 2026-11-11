import { describe, expect, test } from "bun:test"
import { SchemaError, compileSchema } from "../../src/tool/schema.ts"

const schema = compileSchema({
  type: "object",
  description: "ignored",
  properties: {
    path: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
    ratio: { type: "number" },
    mode: { enum: ["fast", "slow"] },
    flag: { type: "boolean" },
    tags: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2 },
    nested: { type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"], additionalProperties: false },
  },
  required: ["path"],
  additionalProperties: false,
})

describe("schema validator", () => {
  test("accepts valid input, ignoring defaults", () => {
    expect(schema({ path: "a" })).toEqual([])
    expect(schema({ path: "a", limit: 10, ratio: 0.5, mode: "slow", flag: false, tags: ["x"], nested: { a: null } })).toEqual([])
  })

  test("names the offending path for each kind of problem", () => {
    expect(schema({})).toEqual([{ path: "path", message: "is required" }])
    expect(schema({ path: "" })).toEqual([{ path: "path", message: "must not be empty" }])
    expect(schema({ path: 3 })).toEqual([{ path: "path", message: "must be a string, got 3" }])
    expect(schema({ path: "a", limit: 1.5 })).toEqual([{ path: "limit", message: "must be an integer, got 1.5" }])
    expect(schema({ path: "a", limit: 0 })).toEqual([{ path: "limit", message: "must be at least 1, got 0" }])
    expect(schema({ path: "a", limit: 11 })).toEqual([{ path: "limit", message: "must be at most 10, got 11" }])
    expect(schema({ path: "a", mode: "medium" })).toEqual([{ path: "mode", message: 'must be one of "fast", "slow", got "medium"' }])
    expect(schema({ path: "a", extra: 1 })).toEqual([
      { path: "extra", message: "is not a known parameter (known: path, limit, ratio, mode, flag, tags, nested)" },
    ])
    expect(schema({ path: "a", limt: 1 })).toEqual([{ path: "limt", message: 'is not a known parameter (did you mean "limit"?)' }])
    expect(compileSchema({ type: "object", additionalProperties: false })({ a: 1 })).toEqual([
      { path: "a", message: "is not a known parameter (this tool takes none)" },
    ])
    expect(schema({ path: "a", tags: ["ok", "long"] })).toEqual([{ path: "tags[1]", message: "must have at most 3 characters" }])
    expect(schema({ path: "a", tags: ["a", "b", "c"] })).toEqual([{ path: "tags", message: "must have at most 2 items" }])
    expect(schema({ path: "a", nested: { a: 1, b: 2 } })).toEqual([
      { path: "nested.a", message: "must be a string or null, got 1" },
      { path: "nested.b", message: "is not a known parameter (known: a)" },
    ])
    expect(schema({ path: "a", "odd key": 1 })[0]!.path).toBe('"odd key"')
    expect(schema([])).toEqual([{ path: "", message: "must be an object, got an array" }])
  })

  test("counts string length in code points", () => {
    const check = compileSchema({ type: "string", maxLength: 2 })
    expect(check("😀😀")).toEqual([])
    expect(check("😀😀😀")).toHaveLength(1)
  })

  test("rejects schemas that use unsupported keywords", () => {
    expect(() => compileSchema({ type: "string", pattern: "^a" })).toThrow(SchemaError)
    expect(() => compileSchema({ type: "object", properties: { a: { oneOf: [] } } })).toThrow('schema at .properties.a: unsupported keyword "oneOf"')
    expect(() => compileSchema({ type: "date" })).toThrow(SchemaError)
  })
})
