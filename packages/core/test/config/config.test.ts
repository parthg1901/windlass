import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../../src/brand.ts"
import { ConfigError, findConfigFiles, loadConfig, mergeConfigFiles, parseConfigFile, resolveConfig } from "../../src/config/index.ts"
import { loadConfigSync } from "../../src/config/load.ts"

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wl-config-")))
  created.push(dir)
  return dir
}

function write(path: string, content: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content))
}

const projectFile = (dir: string) => join(dir, `.${brand.directory}`, "config.json")

function layout() {
  const root = tempDir()
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(join(repo, "packages", "app", "src"), { recursive: true })
  mkdirSync(home, { recursive: true })
  return { root, home, repo, userFile: join(home, ".config", brand.directory, "config.json") }
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error("expected a ConfigError")
}

describe("defaults", () => {
  test("no files: no model, no checks, gate mode with three rounds", async () => {
    const { home, repo } = layout()
    const loaded = await loadConfig({ cwd: repo, home, env: {} })
    expect(loaded.config).toEqual({ model: null, effort: null, checks: [], verify: { mode: "gate", maxRounds: 3 } })
    expect(loaded.sources).toEqual([])
    expect(loaded.projectFile).toBeNull()
    expect(loaded.projectDir).toBe(repo)
  })

  test("a check gets the default timeout and runs on any change", () => {
    const config = resolveConfig(parseConfigFile(JSON.stringify({ checks: [{ name: "test", command: "bun test" }] }), "f"))
    expect(config.checks).toEqual([{ name: "test", command: "bun test", timeoutSeconds: 120, when: null }])
  })
})

describe("locations", () => {
  test("user file under XDG_CONFIG_HOME when absolute, else ~/.config", async () => {
    const { home, repo, root } = layout()
    expect((await findConfigFiles({ cwd: repo, home, env: {} })).userFile).toBe(join(home, ".config", brand.directory, "config.json"))
    expect((await findConfigFiles({ cwd: repo, home, env: { XDG_CONFIG_HOME: join(root, "xdg") } })).userFile).toBe(
      join(root, "xdg", brand.directory, "config.json"),
    )
    expect((await findConfigFiles({ cwd: repo, home, env: { XDG_CONFIG_HOME: "relative" } })).userFile).toBe(
      join(home, ".config", brand.directory, "config.json"),
    )
  })

  test("the nearest project file between the working directory and the repository root wins", async () => {
    const { home, repo } = layout()
    const deep = join(repo, "packages", "app", "src")
    write(projectFile(repo), { model: "root" })
    expect(await findConfigFiles({ cwd: deep, home, env: {} })).toMatchObject({ projectFile: projectFile(repo), projectDir: repo })
    write(projectFile(join(repo, "packages", "app")), { model: "app" })
    const nearer = await loadConfig({ cwd: deep, home, env: {} })
    expect(nearer.projectDir).toBe(join(repo, "packages", "app"))
    expect(nearer.config.model).toBe("app")
  })

  test("the walk stops at the repository root; outside a repository only the working directory is looked at", async () => {
    const { root, home, repo } = layout()
    write(projectFile(root), { model: "above the repo" })
    expect((await findConfigFiles({ cwd: repo, home, env: {} })).projectFile).toBeNull()
    const plain = join(root, "plain", "sub")
    mkdirSync(plain, { recursive: true })
    write(projectFile(join(root, "plain")), { model: "parent" })
    expect(await findConfigFiles({ cwd: plain, home, env: {} })).toMatchObject({ projectFile: null, projectDir: plain })
    write(projectFile(plain), { model: "here" })
    expect((await loadConfig({ cwd: plain, home, env: {} })).config.model).toBe("here")
  })

  test("a .git file (a worktree) marks the repository root", async () => {
    const { root, home } = layout()
    const worktree = join(root, "wt")
    write(join(worktree, ".git"), "gitdir: elsewhere\n")
    mkdirSync(join(worktree, "src"), { recursive: true })
    write(projectFile(worktree), { effort: "high" })
    expect(await findConfigFiles({ cwd: join(worktree, "src"), home, env: {} })).toMatchObject({ projectDir: worktree })
  })
})

describe("merge", () => {
  test("project overrides user key by key; sections merge; lists replace", async () => {
    const { home, repo, userFile } = layout()
    write(userFile, {
      model: "user-model",
      effort: "low",
      checks: [{ name: "lint", command: "eslint ." }, { name: "test", command: "npm test" }],
      verify: { mode: "report", maxRounds: 5 },
    })
    write(projectFile(repo), { model: "project-model", checks: [{ name: "test", command: "bun test" }], verify: { mode: "gate" } })
    const loaded = await loadConfig({ cwd: repo, home, env: {} })
    expect(loaded.sources).toEqual([userFile, projectFile(repo)])
    expect(loaded.config).toEqual({
      model: "project-model",
      effort: "low",
      checks: [{ name: "test", command: "bun test", timeoutSeconds: 120, when: null }],
      verify: { mode: "gate", maxRounds: 5 },
    })
  })

  test("an empty project list removes the user's checks", () => {
    const user = parseConfigFile(JSON.stringify({ checks: [{ name: "lint", command: "eslint ." }] }), "user")
    const project = parseConfigFile(JSON.stringify({ checks: [] }), "project")
    expect(resolveConfig(mergeConfigFiles(user, project)).checks).toEqual([])
    expect(resolveConfig(mergeConfigFiles(user, null)).checks).toHaveLength(1)
  })
})

describe("validation errors name the file and the path", () => {
  const cases: [string, string, string][] = [
    ["not JSON", "{ model: 1 }", "f.json: not valid JSON ("],
    ["not an object", "[]", "f.json: expected object, got array"],
    ["model type", `{"model": 3}`, "f.json: model: expected non-empty string, got 3"],
    ["empty effort", `{"effort": ""}`, `f.json: effort: expected non-empty string, got ""`],
    ["unknown top-level key, close", `{"modle": "x"}`, `f.json: modle: unknown key "modle" (did you mean "model"?); known keys: $schema, model, effort, checks, verify`],
    ["unknown key, nothing close", `{"sandbox": {}}`, `f.json: sandbox: unknown key "sandbox"; known keys: $schema, model, effort, checks, verify`],
    ["unknown verify key", `{"verify": {"maxRound": 2}}`, `f.json: verify.maxRound: unknown key "maxRound" (did you mean "maxRounds"?); known keys: mode, maxRounds`],
    ["bad mode", `{"verify": {"mode": "gated"}}`, `f.json: verify.mode: expected "off" | "report" | "gate", got "gated"`],
    ["maxRounds zero", `{"verify": {"maxRounds": 0}}`, "f.json: verify.maxRounds: expected integer >= 1, got 0"],
    ["maxRounds too large", `{"verify": {"maxRounds": 21}}`, "f.json: verify.maxRounds: expected integer from 1 to 20, got 21"],
    ["checks not a list", `{"checks": {}}`, "f.json: checks: expected array, got object"],
    ["check not an object", `{"checks": ["bun test"]}`, `f.json: checks[0]: expected object, got "bun test"`],
    ["check without name", `{"checks": [{"command": "x"}]}`, "f.json: checks[0].name: expected a value, got nothing"],
    ["check without command", `{"checks": [{"name": "x"}]}`, "f.json: checks[0].command: expected a value, got nothing"],
    [
      "bad check name",
      `{"checks": [{"name": "unit tests", "command": "x"}]}`,
      `f.json: checks[0].name: expected a name of letters, digits, '_', '.' and '-', starting with a letter or digit, got "unit tests"`,
    ],
    [
      "duplicate check name",
      `{"checks": [{"name": "t", "command": "a"}, {"name": "t", "command": "b"}]}`,
      `f.json: checks[1].name: expected a name not already used (checks[0] is "t"), got "t"`,
    ],
    [
      "unknown check key",
      `{"checks": [{"name": "t", "command": "a", "timeout": 5}]}`,
      `f.json: checks[0].timeout: unknown key "timeout"; known keys: name, command, timeoutSeconds, when`,
    ],
    [
      "check key typo",
      `{"checks": [{"name": "t", "command": "a", "timeoutSecond": 5}]}`,
      `f.json: checks[0].timeoutSecond: unknown key "timeoutSecond" (did you mean "timeoutSeconds"?); known keys: name, command, timeoutSeconds, when`,
    ],
    ["timeout not an integer", `{"checks": [{"name": "t", "command": "a", "timeoutSeconds": 1.5}]}`, "f.json: checks[0].timeoutSeconds: expected integer >= 1, got 1.5"],
    ["timeout too long", `{"checks": [{"name": "t", "command": "a", "timeoutSeconds": 3601}]}`, "f.json: checks[0].timeoutSeconds: expected integer from 1 to 3600, got 3601"],
    ["empty command", `{"checks": [{"name": "t", "command": ""}]}`, `f.json: checks[0].command: expected non-empty string, got ""`],
    ["when not a list", `{"checks": [{"name": "t", "command": "a", "when": "*.ts"}]}`, `f.json: checks[0].when: expected array of glob patterns, got "*.ts"`],
    [
      "when empty",
      `{"checks": [{"name": "t", "command": "a", "when": []}]}`,
      "f.json: checks[0].when: expected at least one glob pattern (omit `when` to run on any change), got array",
    ],
    [
      "when negated",
      `{"checks": [{"name": "t", "command": "a", "when": ["src/**", "!src/gen/**"]}]}`,
      `f.json: checks[0].when[1]: expected a glob pattern (negation with '!' is not supported), got "!src/gen/**"`,
    ],
  ]
  for (const [name, text, message] of cases)
    test(name, () => {
      const error = errorOf(() => parseConfigFile(text, "f.json"))
      expect(error.message).toStartWith(message)
      expect(error.file).toBe("f.json")
    })

  test("$schema is accepted and ignored", () => {
    expect(resolveConfig(parseConfigFile(`{"$schema": "https://example.invalid/schema.json"}`, "f")).checks).toEqual([])
  })

  test("loading reports the file that is wrong", async () => {
    const { home, repo, userFile } = layout()
    write(userFile, { model: "fine" })
    write(projectFile(repo), { verify: { mode: "always" } })
    const error = await loadConfig({ cwd: repo, home, env: {} }).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).file).toBe(projectFile(repo))
    expect((error as ConfigError).path).toBe("verify.mode")
    write(projectFile(repo), {})
    write(userFile, "{")
    expect(loadConfig({ cwd: repo, home, env: {} })).rejects.toThrow(`${userFile}: not valid JSON`)
  })
})

describe("the sections of other modules", () => {
  test("mcp, skills, wake and memory are accepted, each validated by its own module", () => {
    const file = parseConfigFile(
      JSON.stringify({
        mcp: { servers: { docs: { command: "docs-server", args: ["stdio"] } } },
        skills: { paths: ["~/team-skills"], disabled: ["old"] },
        wake: { enabled: true, hourlyCeiling: 6 },
        memory: { enabled: true },
      }),
      "f.json",
    )
    expect(file.mcp?.servers?.docs?.command).toBe("docs-server")
    expect(file.skills).toEqual({ paths: ["~/team-skills"], disabled: ["old"] })
    expect(file.wake).toEqual({ enabled: true, hourlyCeiling: 6 })
    expect(file.memory).toEqual({ enabled: true })
    // They are not part of the merged configuration: the engine reads them from the files, apart.
    expect(Object.keys(resolveConfig(file)).sort()).toEqual(["checks", "effort", "model", "verify"])
  })

  const cases: [string, unknown, string][] = [
    ["an unknown key in mcp", { mcp: { server: {} } }, 'f.json: mcp.server: unknown key "server" (did you mean "servers"?)'],
    ["an unknown key in a server", { mcp: { servers: { a: { comand: "x" } } } }, 'f.json: mcp.servers.a.comand: unknown key "comand"'],
    ["a relative skills path", { skills: { paths: ["team"] } }, "f.json: skills.paths[0]: expected an absolute path or one starting with ~/"],
    ["an unknown key in skills", { skills: { path: [] } }, 'f.json: skills.path: unknown key "path"'],
    ["a wake ceiling out of range", { wake: { hourlyCeiling: 600 } }, "f.json: wake.hourlyCeiling: expected a whole number from 1 to 60"],
    ["memory.enabled that is not a flag", { memory: { enabled: "yes" } }, "f.json: memory.enabled: expected true or false"],
    ["a section that is not an object", { memory: [] }, "f.json: memory: expected an object"],
  ]
  for (const [name, content, message] of cases)
    test(name, () => {
      const error = errorOf(() => parseConfigFile(JSON.stringify(content), "f.json"))
      expect(error.message).toStartWith(message)
      expect(error.file).toBe("f.json")
    })

  test("both files are handed on as written, apart", async () => {
    const { home, repo, userFile } = layout()
    write(userFile, { mcp: { servers: { mine: { command: "mine" } } }, wake: { hourlyCeiling: 6 } })
    write(projectFile(repo), { mcp: { servers: { theirs: { command: "theirs" } } }, wake: { hourlyCeiling: 30 }, memory: { enabled: true } })
    const loaded = await loadConfig({ cwd: repo, home, env: {} })
    expect(Object.keys(loaded.files.user?.mcp?.servers ?? {})).toEqual(["mine"])
    expect(Object.keys(loaded.files.project?.mcp?.servers ?? {})).toEqual(["theirs"])
    expect(loaded.files.user?.wake?.hourlyCeiling).toBe(6)
    expect(loaded.files.project?.memory?.enabled).toBe(true)
    expect((await loadConfig({ cwd: home, home, env: {} })).files.project).toBeNull()
  })

  test("a server that is neither started nor reached is an error of the file that names it", async () => {
    const { home, repo, userFile } = layout()
    write(userFile, {})
    write(projectFile(repo), { mcp: { servers: { broken: { timeoutSeconds: 5 } } } })
    expect(loadConfig({ cwd: repo, home, env: {} })).rejects.toThrow(`${projectFile(repo)}: mcp.servers.broken: needs \`command\``)
  })
})

describe("the agents section, and loading without waiting", () => {
  test("agents is accepted and validated by its own module, and is not part of the merged configuration", () => {
    const file = parseConfigFile(JSON.stringify({ agents: { paths: ["~/team-agents"], disabled: ["old"], default: "reviewer" } }), "f.json")
    expect(file.agents).toEqual({ paths: ["~/team-agents"], disabled: ["old"], default: "reviewer" })
    expect(Object.keys(resolveConfig(file)).sort()).toEqual(["checks", "effort", "model", "verify"])
    expect(errorOf(() => parseConfigFile(JSON.stringify({ agents: { defualt: "x" } }), "f.json")).message).toStartWith('f.json: agents.defualt: unknown key "defualt"')
    expect(errorOf(() => parseConfigFile(JSON.stringify({ agents: { paths: ["team"] } }), "f.json")).message).toStartWith("f.json: agents.paths[0]: expected an absolute path or one starting with ~/")
  })

  test("loadConfigSync reads what loadConfig reads: the same files, the same result, the same errors", async () => {
    const { home, repo, userFile } = layout()
    const inside = join(repo, "packages", "app", "src")
    for (const cwd of [repo, inside, home]) expect(loadConfigSync({ cwd, home, env: {} })).toEqual(await loadConfig({ cwd, home, env: {} }))
    write(userFile, { model: "gpt-a", approval: { mode: "ask" }, agents: { default: "reviewer" }, checks: [{ name: "test", command: "bun test" }] })
    write(projectFile(repo), { effort: "low", approval: { mode: "full" }, skills: { disabled: ["x"] } })
    for (const cwd of [repo, inside, home]) expect(loadConfigSync({ cwd, home, env: {} })).toEqual(await loadConfig({ cwd, home, env: {} }))
    expect(loadConfigSync({ cwd: inside, home, env: {} })).toMatchObject({ projectDir: repo, approval: { user: { mode: "ask" }, project: { mode: "full" } }, files: { user: { agents: { default: "reviewer" } } } })
    expect(loadConfigSync({ cwd: repo, home, env: { XDG_CONFIG_HOME: join(home, "xdg") } }).files.user).toBeNull()
    write(projectFile(repo), "{ not json")
    const asynchronous = await loadConfig({ cwd: repo, home, env: {} }).catch((error: unknown) => error as ConfigError)
    expect(errorOf(() => loadConfigSync({ cwd: repo, home, env: {} })).message).toBe((asynchronous as ConfigError).message)
  })
})

describe("the commands and telemetry sections", () => {
  test("both are accepted, each validated by its own module, and neither is part of the merged configuration", () => {
    const file = parseConfigFile(
      JSON.stringify({
        commands: { paths: ["~/team-commands"], disabled: ["old-deploy"] },
        telemetry: { enabled: true, endpoint: "http://localhost:4318", headers: { authorization: "Bearer ${COLLECTOR_TOKEN}" }, content: false, timeoutMs: 2000 },
      }),
      "f.json",
    )
    expect(file.commands).toEqual({ paths: ["~/team-commands"], disabled: ["old-deploy"] })
    expect(file.telemetry).toEqual({ enabled: true, endpoint: "http://localhost:4318", headers: { authorization: "Bearer ${COLLECTOR_TOKEN}" }, content: false, timeoutMs: 2000 })
    expect(Object.keys(resolveConfig(file)).sort()).toEqual(["checks", "effort", "model", "verify"])
  })

  test("a bad value names the file and the path", () => {
    expect(errorOf(() => parseConfigFile(JSON.stringify({ commands: { paths: ["team"] } }), "f.json")).message).toBe("f.json: commands.paths[0]: expected an absolute path or one starting with ~/")
    expect(errorOf(() => parseConfigFile(JSON.stringify({ telemetry: { endpoint: "localhost:4318" } }), "f.json")).message).toBe("f.json: telemetry.endpoint: expected an http:// or https:// URL")
    expect(errorOf(() => parseConfigFile(JSON.stringify({ telemetry: { file: "spans.jsonl" } }), "f.json")).message).toStartWith('f.json: telemetry.file: unknown key "file"')
  })

  test("both files are handed on apart: the project's telemetry section is the project's to be read as such", async () => {
    const { home, repo, userFile } = layout()
    write(userFile, { telemetry: { enabled: true, endpoint: "http://localhost:4318" }, commands: { disabled: ["a"] } })
    write(projectFile(repo), { telemetry: { enabled: false }, commands: { disabled: ["b"] } })
    const loaded = await loadConfig({ cwd: repo, home, env: {} })
    expect(loaded.files.user?.telemetry).toEqual({ enabled: true, endpoint: "http://localhost:4318" })
    expect(loaded.files.project?.telemetry).toEqual({ enabled: false })
    expect(loaded.files.user?.commands).toEqual({ disabled: ["a"] })
    expect(loaded.files.project?.commands).toEqual({ disabled: ["b"] })
  })
})

describe("the hooks and lsp sections", () => {
  test("both are accepted, each validated by its own module, and neither is part of the merged configuration", () => {
    const file = parseConfigFile(
      JSON.stringify({
        hooks: { beforeTool: [{ name: "no-push", tools: ["shell"], command: "exit 0" }], maxStopRounds: 2 },
        lsp: { waitMs: 800, servers: { python: { command: "pyright-langserver", args: ["--stdio"], languages: { python: ["**/*.py"] } } } },
      }),
      "f.json",
    )
    expect(file.hooks).toEqual({ beforeTool: [{ name: "no-push", tools: ["shell"], command: "exit 0" }], maxStopRounds: 2 })
    expect(file.lsp?.servers?.python?.command).toBe("pyright-langserver")
    expect(Object.keys(resolveConfig(file)).sort()).toEqual(["checks", "effort", "model", "verify"])
    expect(errorOf(() => parseConfigFile(JSON.stringify({ hooks: { beforeTol: [] } }), "f.json")).message).toStartWith('f.json: hooks.beforeTol: unknown key "beforeTol"')
    expect(errorOf(() => parseConfigFile(JSON.stringify({ lsp: { waitMs: 9000 } }), "f.json")).message).toStartWith("f.json: lsp.waitMs: ")
  })

  test("only the user's own file may run a hook outside the sandbox: the project's file is validated as the project's", async () => {
    const { home, repo, userFile } = layout()
    const outside = { hooks: { afterTool: [{ command: "true", sandbox: false }] } }
    expect(parseConfigFile(JSON.stringify(outside), "f.json").hooks?.afterTool?.[0]?.sandbox).toBe(false)
    expect(errorOf(() => parseConfigFile(JSON.stringify(outside), "f.json", "project")).message).toContain("only the user's own configuration file can run a hook outside the sandbox")
    write(userFile, outside)
    expect((await loadConfig({ cwd: repo, home, env: {} })).files.user?.hooks).toEqual(outside.hooks)
    write(projectFile(repo), outside)
    const refused = `${projectFile(repo)}: hooks.afterTool[0].sandbox: only the user's own configuration file can run a hook outside the sandbox`
    expect(loadConfig({ cwd: repo, home, env: {} })).rejects.toThrow(refused)
    expect(errorOf(() => loadConfigSync({ cwd: repo, home, env: {} })).message).toBe(refused)
  })

  test("both files' hooks are handed on apart, and a language server without a command is an error of the file that names it", async () => {
    const { home, repo, userFile } = layout()
    write(userFile, { hooks: { stop: [{ command: "exit 0" }] } })
    write(projectFile(repo), { hooks: { stop: [{ command: "exit 2" }] } })
    const loaded = await loadConfig({ cwd: repo, home, env: {} })
    expect(loaded.files.user?.hooks?.stop).toEqual([{ command: "exit 0" }])
    expect(loaded.files.project?.hooks?.stop).toEqual([{ command: "exit 2" }])
    write(projectFile(repo), { lsp: { servers: { go: { languages: { go: ["**/*.go"] } } } } })
    const missing = `${projectFile(repo)}: lsp.servers.go: needs \`command\`, the language server to start`
    expect(loadConfig({ cwd: repo, home, env: {} })).rejects.toThrow(missing)
    expect(errorOf(() => loadConfigSync({ cwd: repo, home, env: {} })).message).toBe(missing)
  })
})
