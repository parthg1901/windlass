/** The `hooks` configuration section: validation, defaults, the order of the two files, and fingerprints. */
import { describe, expect, test } from "bun:test"
import { ConfigError } from "../../src/config/schema.ts"
import { HOOK_LIMITS, hookFingerprint, parseHooksSection, resolveHooksConfig } from "../../src/hooks/config.ts"
import { hooks } from "./helpers.ts"

const parse = (value: unknown, origin: "user" | "project" = "user") => parseHooksSection(value, "config.json", origin)
const problem = (value: unknown, origin: "user" | "project" = "user") => {
  try {
    parse(value, origin)
  } catch (error) {
    if (error instanceof ConfigError) return `${error.path}: ${error.problem}`
    throw error
  }
  throw new Error("expected a ConfigError")
}

describe("validation", () => {
  test("a full section is accepted as written", () => {
    const section = {
      beforeTool: [{ name: "no-push", tools: ["shell"], command: "exit 0", timeoutSeconds: 5, onError: "allow" as const }],
      afterTool: [{ tools: ["edit", "write"], paths: ["**/*.ts"], command: "true" }],
      stop: [{ name: "clean", command: "true" }],
      maxStopRounds: 2,
    }
    expect(parse(section)).toEqual(section)
  })

  test("unknown keys, at the top and in a hook, are errors naming the path", () => {
    expect(problem({ beforeTools: [] })).toBe('hooks.beforeTools: unknown key "beforeTools"; known keys: beforeTool, afterTool, stop, maxStopRounds')
    expect(problem({ beforeTool: [{ command: "x", match: "git" }] })).toStartWith('hooks.beforeTool[0].match: unknown key "match"')
    // A stop hook has no tools or paths, and only a before hook has onError.
    expect(problem({ stop: [{ command: "x", tools: ["shell"] }] })).toStartWith('hooks.stop[0].tools: unknown key "tools"')
    expect(problem({ afterTool: [{ command: "x", onError: "allow" }] })).toStartWith('hooks.afterTool[0].onError: unknown key "onError"')
  })

  test("bad values", () => {
    expect(problem({ beforeTool: {} })).toBe("hooks.beforeTool: expected an array of hooks")
    expect(problem({ beforeTool: [{}] })).toBe("hooks.beforeTool[0].command: expected a non-empty command")
    expect(problem({ beforeTool: [{ command: "  " }] })).toBe("hooks.beforeTool[0].command: expected a non-empty command")
    expect(problem({ beforeTool: [{ command: "x", tools: [] }] })).toStartWith("hooks.beforeTool[0].tools: expected a non-empty array")
    expect(problem({ beforeTool: [{ command: "x", tools: ["she ll"] }] })).toStartWith("hooks.beforeTool[0].tools[0]: expected a tool name")
    expect(problem({ beforeTool: [{ command: "x", paths: ["!a"] }] })).toBe("hooks.beforeTool[0].paths[0]: negation with '!' is not supported")
    expect(problem({ beforeTool: [{ command: "x", paths: ["/etc/*"] }] })).toBe("hooks.beforeTool[0].paths[0]: expected a pattern relative to the working directory")
    expect(problem({ beforeTool: [{ command: "x", timeoutSeconds: 0 }] })).toBe("hooks.beforeTool[0].timeoutSeconds: expected a whole number from 1 to 300")
    expect(problem({ beforeTool: [{ command: "x", timeoutSeconds: 1.5 }] })).toBe("hooks.beforeTool[0].timeoutSeconds: expected a whole number from 1 to 300")
    expect(problem({ beforeTool: [{ command: "x", onError: "ignore" }] })).toBe('hooks.beforeTool[0].onError: expected "refuse" or "allow"')
    expect(problem({ beforeTool: [{ command: "x", name: "has space" }] })).toStartWith("hooks.beforeTool[0].name: expected a name")
    expect(problem({ stop: [{ command: "a", name: "x" }, { command: "b", name: "x" }] })).toBe('hooks.stop: the name "x" is used twice')
    expect(problem({ maxStopRounds: 11 })).toBe("hooks.maxStopRounds: expected a whole number from 1 to 10")
    expect(problem({ stop: [{ command: "x".repeat(HOOK_LIMITS.maxCommandLength + 1) }] })).toBe(`hooks.stop[0].command: at most ${HOOK_LIMITS.maxCommandLength} characters`)
  })

  test("only the user's own file can run a hook outside the sandbox", () => {
    expect(parse({ stop: [{ command: "x", sandbox: false }] }, "user")).toEqual({ stop: [{ command: "x", sandbox: false }] })
    expect(problem({ stop: [{ command: "x", sandbox: false }] }, "project")).toBe("hooks.stop[0].sandbox: only the user's own configuration file can run a hook outside the sandbox")
    // Saying the default is harmless.
    expect(parse({ stop: [{ command: "x", sandbox: true }] }, "project")).toEqual({ stop: [{ command: "x", sandbox: true }] })
  })
})

describe("resolving", () => {
  test("defaults, ids and names", () => {
    const config = hooks({ user: { beforeTool: [{ command: "a" }], stop: [{ command: "s", name: "clean" }] } })
    expect(config.beforeTool[0]).toMatchObject({ id: "user.beforeTool[0]", name: "beforeTool[0]", tools: null, paths: null, timeoutSeconds: 10, onError: "refuse", sandbox: true, origin: "user" })
    expect(config.stop[0]).toMatchObject({ id: "user.stop[0]", name: "clean", timeoutSeconds: 60, onError: "allow" })
    expect(config.maxStopRounds).toBe(3)
  })

  test("the user's hooks come first, then the project's: a project adds hooks and never replaces the user's", () => {
    const config = hooks({ user: { stop: [{ command: "mine", name: "mine" }] }, project: { stop: [{ command: "theirs", name: "theirs" }] } })
    expect(config.stop.map((hook) => [hook.id, hook.origin])).toEqual([
      ["user.stop[0]", "user"],
      ["project.stop[0]", "project"],
    ])
  })

  test("a project can lower maxStopRounds, not raise it, and is told", () => {
    expect(hooks({ user: { maxStopRounds: 5 }, project: { maxStopRounds: 2 } }).maxStopRounds).toBe(2)
    const raised = hooks({ user: { maxStopRounds: 2 }, project: { maxStopRounds: 9 } })
    expect(raised.maxStopRounds).toBe(2)
    expect(raised.ignored).toEqual(["hooks.maxStopRounds: the project's 9 is above the user's 2"])
    expect(resolveHooksConfig(undefined, undefined)).toEqual({ beforeTool: [], afterTool: [], stop: [], maxStopRounds: 3, ignored: [] })
  })
})

describe("fingerprints", () => {
  const base = { point: "beforeTool" as const, tools: ["shell"], paths: null, command: "./check.sh", timeoutSeconds: 10, onError: "refuse" as const, sandbox: true }

  test("the same hook has the same fingerprint, whatever its name or key order", () => {
    const a = hooks({ project: { beforeTool: [{ name: "a", tools: ["shell"], command: "./check.sh" }] } }).beforeTool[0]!
    const b = hooks({ project: { beforeTool: [{ command: "./check.sh", tools: ["shell"], name: "b" }] } }).beforeTool[0]!
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).toBe(hookFingerprint(base))
    expect(a.fingerprint).toMatch(/^hook-sha256:[0-9a-f]{64}$/)
  })

  test("everything that changes what runs, or when, changes it", () => {
    const fingerprint = hookFingerprint(base)
    for (const change of [
      { command: "./check.sh --all" },
      { tools: ["shell", "edit"] },
      { tools: null },
      { paths: ["src/**"] },
      { timeoutSeconds: 11 },
      { onError: "allow" as const },
      { point: "afterTool" as const },
    ])
      expect(hookFingerprint({ ...base, ...change })).not.toBe(fingerprint)
  })
})
