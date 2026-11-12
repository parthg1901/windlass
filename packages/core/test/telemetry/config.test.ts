/** The `telemetry` configuration section on its own: validation, who may set what, and `${VAR}` expansion. */
import { describe, expect, test } from "bun:test"
import { ConfigError } from "../../src/config/schema.ts"
import { TelemetryConfigError, expand, parseTelemetrySection, resolveTelemetryConfig } from "../../src/telemetry/config.ts"

const parse = (value: unknown) => parseTelemetrySection(value, "user.json")

describe("parseTelemetrySection", () => {
  test("accepts every key, and nothing else", () => {
    expect(parse({ enabled: true, endpoint: "http://localhost:4318", headers: { authorization: "Bearer ${TOKEN}" }, content: false, timeoutMs: 5000 })).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318",
      headers: { authorization: "Bearer ${TOKEN}" },
      content: false,
      timeoutMs: 5000,
    })
    expect(parse({})).toEqual({})
  })

  test("names the file and the path of a bad value", () => {
    const bad: [unknown, string][] = [
      [[], "telemetry"],
      [{ endpont: "x" }, "telemetry.endpont"],
      [{ enabled: "yes" }, "telemetry.enabled"],
      [{ endpoint: "ftp://collector" }, "telemetry.endpoint"],
      [{ endpoint: "not a url" }, "telemetry.endpoint"],
      [{ headers: ["a"] }, "telemetry.headers"],
      [{ headers: { "bad header": "x" } }, "telemetry.headers.bad header"],
      [{ headers: { a: 1 } }, "telemetry.headers.a"],
      [{ headers: { a: "x\r\ny: z" } }, "telemetry.headers.a"],
      [{ timeoutMs: 5 }, "telemetry.timeoutMs"],
      [{ content: 1 }, "telemetry.content"],
    ]
    for (const [value, path] of bad) {
      let caught: unknown
      try {
        parse(value)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ConfigError)
      expect(String((caught as Error).message)).toContain("user.json")
      expect(String((caught as Error).message)).toContain(path)
    }
  })
})

describe("resolveTelemetryConfig", () => {
  const env = { TOKEN: "abc123", EMPTY: "" }

  test("off by default, and off unless the user's own file turns it on", () => {
    expect(resolveTelemetryConfig(undefined, undefined, env)).toMatchObject({ enabled: false, endpoint: null, content: false })
    // A repository cannot start telemetry or point it anywhere.
    expect(resolveTelemetryConfig(undefined, { enabled: true, endpoint: "http://evil.example" }, env).enabled).toBe(false)
  })

  test("the user's section, with the defaults and the headers expanded; the project can only turn it off", () => {
    const user = { enabled: true, endpoint: "http://localhost:4318", headers: { authorization: "Bearer ${TOKEN}", "x-cost": "$$5" } }
    expect(resolveTelemetryConfig(user, undefined, env)).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318",
      headers: { authorization: "Bearer abc123", "x-cost": "$5" },
      content: false,
      timeoutMs: 10_000,
    })
    expect(resolveTelemetryConfig({ ...user, content: true }, { content: false, endpoint: "http://other" }, env)).toMatchObject({ content: true, endpoint: "http://localhost:4318" })
    expect(resolveTelemetryConfig(user, { enabled: false }, env).enabled).toBe(false)
  })

  test("on without an endpoint, or with a variable that is not set: an error that names the variable, never a value", () => {
    expect(() => resolveTelemetryConfig({ enabled: true }, undefined, env)).toThrow(TelemetryConfigError)
    expect(() => resolveTelemetryConfig({ enabled: true, endpoint: "http://c", headers: { a: "${MISSING}" } }, undefined, env)).toThrow("telemetry.headers.a: the environment variable MISSING is not set")
    expect(() => expand("${not valid", env, "here")).toThrow('here: "${not valid" is not a variable reference')
    expect(expand("${EMPTY}x", env, "here")).toBe("x")
    expect(expand("plain $ sign", env, "here")).toBe("plain $ sign")
  })
})
