/** The `lsp` section on its own: validation, defaults, examples, and which servers may start. */
import { describe, expect, test } from "bun:test"
import { ConfigError } from "../../src/config/schema.ts"
import { LSP_EXAMPLES, type LspConfigSection, lspApprovalKey, lspServerQuestion, parseLspSection, planLspServers, resolveLspConfig } from "../../src/lsp/config.ts"

const ts = { command: "typescript-language-server", args: ["--stdio"], languages: { typescript: ["**/*.ts"] } }

describe("parse and resolve", () => {
  test("defaults", () => {
    const config = resolveLspConfig(parseLspSection({ servers: { ts } }, "user.json"))
    expect(config).toEqual({
      enabled: true,
      waitMs: 1500,
      warnings: false,
      maxDiagnostics: 10,
      servers: [
        {
          name: "ts",
          command: "typescript-language-server",
          args: ["--stdio"],
          env: {},
          languages: [{ languageId: "typescript", patterns: ["**/*.ts"] }],
          rootMarkers: [],
          startupTimeoutSeconds: 30,
          initializationOptions: null,
          settings: null,
          enabled: true,
        },
      ],
    })
  })

  test("no section: nothing configured, nothing starts", () => {
    expect(resolveLspConfig(undefined).servers).toEqual([])
  })

  test("waitMs may be zero and is bounded", () => {
    expect(resolveLspConfig(parseLspSection({ waitMs: 0 }, "f")).waitMs).toBe(0)
    expect(() => parseLspSection({ waitMs: 60_000 }, "f")).toThrow("lsp.waitMs: expected integer from 0 to 5000")
  })

  test("an unknown key is rejected with a suggestion", () => {
    expect(() => parseLspSection({ servers: { ts: { ...ts, rootMarker: ["x"] } } }, "f.json")).toThrow(ConfigError)
    expect(() => parseLspSection({ servers: { ts: { ...ts, rootMarker: ["x"] } } }, "f.json")).toThrow('(did you mean "rootMarkers"?)')
  })

  test("bad values name their path", () => {
    expect(() => parseLspSection({ servers: { ts: { ...ts, languages: { typescript: [] } } } }, "f")).toThrow("lsp.servers.ts.languages.typescript")
    expect(() => parseLspSection({ servers: { ts: { ...ts, rootMarkers: ["a/b"] } } }, "f")).toThrow("a file name without a directory")
    expect(() => parseLspSection({ servers: { "bad name": ts } }, "f")).toThrow("a server name")
    expect(() => parseLspSection({ servers: { ts: { ...ts, env: { "1X": "y" } } } }, "f")).toThrow("an environment variable name")
  })

  test("a server without a command or languages fails after the merge", () => {
    expect(() => resolveLspConfig(parseLspSection({ servers: { ts: { args: [] } } }, "f"))).toThrow("needs `command`")
    expect(() => resolveLspConfig(parseLspSection({ servers: { ts: { command: "x" } } }, "f"))).toThrow("needs `languages`")
  })

  test("every documented example validates and resolves", () => {
    const config = resolveLspConfig(parseLspSection({ servers: LSP_EXAMPLES }, "examples"))
    expect(config.servers.map((server) => server.name)).toEqual(["go", "python", "rust", "typescript"])
  })
})

describe("who may start a server", () => {
  const none = () => false

  test("a server in the user's own file is the user's and may start", () => {
    const plan = planLspServers({ servers: { ts } }, undefined, none)
    expect(plan.servers).toMatchObject([{ origin: "user", approved: true }])
  })

  test("a server only the project's file names waits for approval", () => {
    const plan = planLspServers(undefined, { servers: { ts } }, none)
    expect(plan.servers).toMatchObject([{ origin: "project", approved: false }])
    const question = lspServerQuestion(plan.servers[0]!)
    expect(question.subject).toBe("typescript-language-server --stdio")
    expect(question.key).toBe(lspApprovalKey(plan.servers[0]!))
    expect(question.details[0]).toContain("runs outside the sandbox")
  })

  test("approved by its key, it may start", () => {
    const first = planLspServers(undefined, { servers: { ts } }, none).servers[0]!
    const approved = new Set([lspApprovalKey(first)])
    expect(planLspServers(undefined, { servers: { ts } }, (key) => approved.has(key)).servers[0]!.approved).toBe(true)
  })

  test("an edited definition needs approval again", () => {
    const first = planLspServers(undefined, { servers: { ts } }, none).servers[0]!
    const approved = new Set([lspApprovalKey(first)])
    const edited = planLspServers(undefined, { servers: { ts: { ...ts, args: ["--stdio", "--log-level", "4"] } } }, (key) => approved.has(key)).servers[0]!
    expect(edited.fingerprint).not.toBe(first.fingerprint)
    expect(edited.approved).toBe(false)
  })

  test("a project's file that changes one field of the user's server makes it the project's", () => {
    const user: LspConfigSection = { servers: { ts } }
    const changed = planLspServers(user, { servers: { ts: { command: "./node_modules/.bin/evil" } } }, none)
    expect(changed.servers[0]).toMatchObject({ origin: "project", approved: false, config: { command: "./node_modules/.bin/evil", args: ["--stdio"] } })
    // Restating the same value changes nothing.
    expect(planLspServers(user, { servers: { ts: { command: ts.command } } }, none).servers[0]).toMatchObject({ origin: "user", approved: true })
  })

  test("the project's file can set the global keys", () => {
    expect(planLspServers({ servers: { ts } }, { waitMs: 500, warnings: true }, none).config).toMatchObject({ waitMs: 500, warnings: true })
  })
})
