/** The `wake` configuration section: strict parsing, defaults, and a project that can only tighten. */
import { describe, expect, test } from "bun:test"
import { ConfigError } from "../../src/config/schema.ts"
import { parseWakeSection, resolveWakeConfig } from "../../src/wake/config.ts"

describe("parsing", () => {
  test("every key, and unknown keys and bad values are errors naming the path", () => {
    expect(parseWakeSection({ enabled: true, hourlyCeiling: 6, maxActive: 3, webhook: { host: "127.0.0.1", port: 9000, allowExternal: false, maxBodyBytes: 4096, requestsPerMinute: 10 } }, "u.json")).toEqual({
      enabled: true,
      hourlyCeiling: 6,
      maxActive: 3,
      webhook: { host: "127.0.0.1", port: 9000, allowExternal: false, maxBodyBytes: 4096, requestsPerMinute: 10 },
    })
    expect(() => parseWakeSection({ ceiling: 1 }, "u.json")).toThrow(ConfigError)
    expect(() => parseWakeSection({ ceiling: 1 }, "u.json")).toThrow('unknown key "ceiling"')
    expect(() => parseWakeSection({ hourlyCeiling: 61 }, "u.json")).toThrow("expected a whole number from 1 to 60")
    expect(() => parseWakeSection({ webhook: { maxBodyBytes: 1_000_000 } }, "u.json")).toThrow("expected a whole number from 1024 to 65536")
    expect(() => parseWakeSection({ webhook: { tls: true } }, "u.json")).toThrow('unknown key "tls"')
    expect(() => parseWakeSection([], "u.json")).toThrow("expected an object")
  })
})

describe("resolving", () => {
  test("defaults", () => {
    expect(resolveWakeConfig(undefined, undefined)).toEqual({
      enabled: true,
      hourlyCeiling: 12,
      maxActive: 10,
      webhook: { host: "127.0.0.1", port: 47_863, allowExternal: false, maxBodyBytes: 65_536, requestsPerMinute: 30 },
      ignored: [],
    })
  })

  test("a project may lower limits and turn wake-ups off, never loosen or move the listener", () => {
    const resolved = resolveWakeConfig(
      { enabled: false, hourlyCeiling: 6 },
      { enabled: true, hourlyCeiling: 30, maxActive: 2, webhook: { host: "0.0.0.0", allowExternal: true, requestsPerMinute: 5 } },
    )
    expect(resolved.enabled).toBe(false)
    expect(resolved.hourlyCeiling).toBe(6)
    expect(resolved.maxActive).toBe(2)
    expect(resolved.webhook).toMatchObject({ host: "127.0.0.1", allowExternal: false, requestsPerMinute: 5 })
    expect(resolved.ignored).toEqual([
      "wake.webhook.host: only the user's own file can set where the listener binds",
      "wake.webhook.allowExternal: only the user's own file can set where the listener binds",
      "wake.enabled: the user turned wake-ups off",
      "wake.hourlyCeiling: the project's 30 is above the user's 6",
    ])
    expect(resolveWakeConfig(undefined, { enabled: false }).enabled).toBe(false)
  })
})
