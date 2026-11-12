/** The `memory` configuration section: off by default, strict keys, and a repository cannot move the user's notes into itself. */
import { describe, expect, test } from "bun:test"
import { ConfigError } from "../../src/config/schema.ts"
import { parseMemorySection, resolveMemoryConfig } from "../../src/memory/config.ts"
import { DELIVERY_LIMITS } from "../../src/memory/hygiene.ts"

describe("memory configuration", () => {
  test("off by default", () => {
    expect(resolveMemoryConfig(undefined, undefined)).toEqual({ enabled: false, inRepository: false, limits: DELIVERY_LIMITS })
  })

  test("parses known keys and rejects unknown ones and bad values", () => {
    expect(parseMemorySection({ enabled: true, projectChars: 3000 }, "f.json")).toEqual({ enabled: true, projectChars: 3000 })
    expect(() => parseMemorySection({ enable: true }, "f.json")).toThrow(ConfigError)
    expect(() => parseMemorySection({ enabled: "yes" }, "f.json")).toThrow("memory.enabled: expected true or false")
    expect(() => parseMemorySection({ userChars: 10 }, "f.json")).toThrow("from 200 to 50000")
    expect(() => parseMemorySection([], "f.json")).toThrow("expected an object")
  })

  test("the project file overrides the user's, except inRepository, which only the user's file can set", () => {
    const config = resolveMemoryConfig({ enabled: true, userChars: 1000 }, { enabled: false, inRepository: true, projectChars: 900 })
    expect(config).toEqual({
      enabled: false,
      inRepository: false,
      limits: { user: { ...DELIVERY_LIMITS.user, maxChars: 1000 }, project: { ...DELIVERY_LIMITS.project, maxChars: 900 } },
    })
    expect(resolveMemoryConfig({ inRepository: true }, undefined).inRepository).toBe(true)
  })
})
