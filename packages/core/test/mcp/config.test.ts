/** The `mcp` configuration section and the lenient argument check. */
import { describe, expect, test } from "bun:test"
import { ConfigError } from "../../src/config/schema.ts"
import { BASE_ENV, expandVariables, parseMcpSection, resolveMcpConfig, serverEnvironment, toolAllowed } from "../../src/mcp/config.ts"
import { checkArguments } from "../../src/mcp/schema.ts"

describe("the mcp section", () => {
  test("applies the defaults and sorts servers by name", () => {
    const config = resolveMcpConfig(
      parseMcpSection({ servers: { zeta: { url: "https://example.com/mcp" }, alpha: { command: "alpha-mcp", args: ["--stdio"] } } }, "config.json"),
    )
    expect(config.servers.map((server) => server.name)).toEqual(["alpha", "zeta"])
    expect(config.servers[0]).toEqual({
      name: "alpha",
      transport: { kind: "stdio", command: "alpha-mcp", args: ["--stdio"], cwd: null, env: {} },
      tools: { allow: null, deny: [] },
      timeoutSeconds: 60,
      startupTimeoutSeconds: 30,
      untrusted: true,
      enabled: true,
      protocol: "auto",
    })
    expect(config.servers[1]!.transport).toEqual({ kind: "http", url: "https://example.com/mcp", headers: {} })
    expect(resolveMcpConfig(undefined).servers).toEqual([])
  })

  test("rejects unknown keys with a suggestion, naming the file and path", () => {
    expect(() => parseMcpSection({ servers: { a: { command: "x", timeoutSecond: 5 } } }, "/p/config.json")).toThrow(
      new ConfigError("/p/config.json", "mcp.servers.a.timeoutSecond", 'unknown key "timeoutSecond" (did you mean "timeoutSeconds"?); known keys: command, args, cwd, env, url, headers, tools, timeoutSeconds, startupTimeoutSeconds, untrusted, enabled, protocol'),
    )
    expect(() => parseMcpSection({ server: {} }, "f")).toThrow(/did you mean "servers"/)
  })

  test("rejects bad values", () => {
    expect(() => parseMcpSection({ servers: { "bad name": { command: "x" } } }, "f")).toThrow(/mcp.servers.bad name/)
    expect(() => parseMcpSection({ servers: { a: { url: "ftp://example.com" } } }, "f")).toThrow(/an http or https URL/)
    expect(() => parseMcpSection({ servers: { a: { command: "x", timeoutSeconds: 0 } } }, "f")).toThrow(/integer from 1 to 3600/)
    expect(() => parseMcpSection({ servers: { a: { command: "x", env: { "BAD-NAME": "1" } } } }, "f")).toThrow(/environment variable name/)
    expect(() => parseMcpSection({ servers: { a: { command: "x", protocol: "old" } } }, "f")).toThrow(/"auto" \| "modern" \| "legacy"/)
  })

  test("a server is started or reached, not both and not neither", () => {
    expect(() => resolveMcpConfig({ servers: { a: { command: "x", url: "https://e.com" } } }, "f")).toThrow(/has both `command` and `url`/)
    expect(() => resolveMcpConfig({ servers: { a: {} } }, "f")).toThrow(/needs `command`/)
    expect(() => resolveMcpConfig({ servers: { a: { url: "https://e.com", env: {} } } }, "f")).toThrow(/mcp.servers.a.env: applies only to a server started by `command`/)
    expect(() => resolveMcpConfig({ servers: { a: { command: "x", headers: {} } } }, "f")).toThrow(/applies only to a server reached by `url`/)
  })

  test("the environment: base variables, then env with ${NAME} expanded", () => {
    const parent = { PATH: "/bin", HOME: "/h", SECRET: "s", TOKEN: "t" }
    expect(serverEnvironment({ API_TOKEN: "${TOKEN}", PLAIN: "a$b ${TOKEN}x" }, parent)).toEqual({
      ok: true,
      env: { PATH: "/bin", HOME: "/h", API_TOKEN: "t", PLAIN: "a$b tx" },
    })
    expect(serverEnvironment({ A: "${NOPE}" }, parent)).toEqual({ ok: false, missing: "NOPE" })
    expect(expandVariables("Bearer ${TOKEN}", parent)).toEqual({ ok: true, value: "Bearer t" })
    expect(BASE_ENV).not.toContain("SSH_AUTH_SOCK")
  })

  test("allow and deny patterns", () => {
    expect(toolAllowed("delete_repo", { allow: null, deny: ["delete_*"] })).toBe(false)
    expect(toolAllowed("get_repo", { allow: null, deny: ["delete_*"] })).toBe(true)
    expect(toolAllowed("get.repo", { allow: ["get.*"], deny: [] })).toBe(true)
    expect(toolAllowed("getXrepo", { allow: ["get.repo"], deny: [] })).toBe(false)
  })
})

describe("the argument check", () => {
  const issues = (schema: unknown, value: unknown) => checkArguments(schema as never, value as never).map((issue) => `${issue.path}: ${issue.message}`)

  test("enforces the common keywords", () => {
    const schema = {
      type: "object",
      properties: {
        n: { type: "integer", minimum: 1, exclusiveMaximum: 10, multipleOf: 2 },
        s: { type: "string", maxLength: 3, pattern: "^a" },
        list: { type: "array", items: { enum: ["x", "y"] }, uniqueItems: true },
        tuple: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
        c: { const: 3 },
      },
      required: ["n"],
      additionalProperties: false,
    }
    expect(issues(schema, { n: 10, s: "bcde", list: ["x", "x", "z"], tuple: [1, "a"], c: 4 })).toEqual([
      "n: must be less than 10, got 10",
      "s: must have at most 3 characters",
      "s: must match the pattern ^a",
      "list: must not contain the same item twice",
      'list[2]: must be one of "x", "y", got the string "z"',
      "tuple[0]: must be a string, got number 1",
      'tuple[1]: must be a number, got the string "a"',
      "c: must be 3, got number 4",
    ])
    expect(issues(schema, { n: 3 })).toEqual(["n: must be a multiple of 2, got 3"])
    expect(issues(schema, {})).toEqual(["n: is required"])
  })

  test("follows local $ref, explains a failed anyOf by its closest branch, and ignores what it does not know", () => {
    const schema = {
      $defs: { point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
      type: "object",
      properties: {
        at: { $ref: "#/$defs/point" },
        remote: { $ref: "https://example.com/schema.json" },
        either: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }] },
        date: { type: "string", format: "date", "x-custom": true },
      },
    }
    expect(issues(schema, { at: {}, remote: 42, either: { id: "1" }, date: "not a date" })).toEqual(["at.x: is required", 'either.id: must be an integer, got the string "1"'])
    expect(issues(schema, { either: 5 })).toEqual(["either: must match at least one of the allowed shapes"])
    expect(issues({ oneOf: [{ type: "number" }, { type: "integer" }] }, 2)).toEqual([": matches more than one of the allowed shapes; it must match exactly one"])
    expect(issues(true, { anything: 1 })).toEqual([])
    expect(issues({ not: { type: "null" } }, null)).toEqual([": is a value the schema does not allow"])
  })

  test("stops at its budget instead of running away on a hostile schema", () => {
    const loop = { $defs: { a: { allOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/a" }] } }, $ref: "#/$defs/a" }
    const started = performance.now()
    expect(issues(loop, 1)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
