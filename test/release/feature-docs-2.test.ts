/**
 * The feature pages docs/agents.md, hooks.md, diagnostics.md and task-list.md,
 * checked against the program so that they cannot drift, in the manner of
 * feature-docs.test.ts:
 *
 * - Every command in a `sh` block is parsed by the program's own parser, every
 *   `--option` exists in `--help`, and every `/command` is one an interface
 *   knows, or one a page says does not exist (which must stay so).
 * - Every `json` block is a valid configuration file (or, for a hook's event,
 *   has the shape the program writes), and each "Key in ..." table lists
 *   exactly the keys the validators know, in their order.
 * - Limits, directories, environment variables and the example definition are
 *   the code's.
 * - Every quoted message is made of text found in the program's source.
 * - Each "Not yet" carries a marker comment, and the ones that say something
 *   is missing fail once it exists, so the page is updated with it.
 * - The module pages users also read (the READMEs of hooks, lsp and agents,
 *   and TODO-TOOL.md) quote the edit tool's result as it is printed and say
 *   what the clients do today.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_AGENT_BYTES, MAX_AGENT_NAME_LENGTH, parseAgentDefinition } from "../../packages/core/src/agents/definition.ts"
import { MAX_AGENT_DEPTH, agentRoots } from "../../packages/core/src/agents/discover.ts"
import { brand } from "../../packages/core/src/brand.ts"
import { parseConfigFile } from "../../packages/core/src/config/schema.ts"
import { ANSWER_LIMITS } from "../../packages/core/src/hooks/answer.ts"
import { HOOK_LIMITS, HOOK_POINTS } from "../../packages/core/src/hooks/config.ts"
import { EVENT_LIMITS, HOOK_ENV_PREFIX, hookEvent } from "../../packages/core/src/hooks/event.ts"
import { LSP_LIMITS } from "../../packages/core/src/lsp/config.ts"
import { NOTE_LIMITS } from "../../packages/core/src/lsp/note.ts"
import { TODO_LIMITS, TODO_TOOL_NAME } from "../../packages/core/src/tools/todo.ts"
import { helpText, parseArgs } from "../../packages/cli/src/args.ts"
import { BUILTIN_COMMANDS } from "../../packages/cli/src/slash.ts"
import { COMMANDS } from "../../packages/tui/src/commands.ts"

const ROOT = join(import.meta.dir, "..", "..")
const PAGES = ["docs/agents.md", "docs/hooks.md", "docs/diagnostics.md", "docs/task-list.md"] as const
type Page = (typeof PAGES)[number]
const text = Object.fromEntries(PAGES.map((page) => [page, readFileSync(join(ROOT, page), "utf8")])) as Record<Page, string>
const all = Object.values(text).join("\n")
const BIN = brand.binary
const DIR = brand.directory

/** The fenced blocks of a page with the given language. */
const blocks = (page: Page, language: string) => [...text[page].matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]!)

/** Splits a command line into words, honouring quotes; `<placeholders>` become a plain word. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => (match[1] ?? match[2] ?? match[3]!).replace(/<[^>]+>/g, "x"))
}

function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry)
      if (entry === "node_modules") return []
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : []
    })
  return readdirSync(join(ROOT, "packages")).flatMap((pkg) => walk(join(ROOT, "packages", pkg, "src")))
}
const FILES = sourceFiles()
const read = (file: string) => readFileSync(file, "utf8")
const SOURCE = FILES.map(read).join("\n")
/** The source as its string literals read: escapes undone. */
const SOURCE_TEXT = SOURCE.replace(/\\`/g, "`").replace(/\\"/g, '"').replace(/\\n/g, "\n")
/** The source of the three clients: the protocol server, the line interface and the full-screen interface. */
const clientFiles = () => FILES.filter((file) => ["packages/acp/src", "packages/cli/src", "packages/tui/src"].some((dir) => file.startsWith(join(ROOT, dir))))

/** A hook's event as the page shows it, not a configuration file. */
const isHookEvent = (body: string) => body.includes('"version": 1')

describe("commands", () => {
  const commands = PAGES.flatMap((page) =>
    blocks(page, "sh")
      .flatMap((body) => body.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")))
      .map((line) => ({ page, line, words: words(line) })),
  )

  test("every command is one the program accepts", () => {
    expect(commands.length).toBeGreaterThanOrEqual(2)
    for (const { page, line, words: [command, ...args] } of commands) {
      expect(command, `${page}: ${line}`).toBe(BIN)
      expect(parseArgs(args).kind, `${page}: ${line}`).not.toBe("error")
    }
  })

  test("the agent a command names is given to the session", () => {
    const parsed = parseArgs(["--agent", "reviewer", "review math.ts"])
    expect(parsed).toMatchObject({ kind: "run", options: { agent: "reviewer", prompt: "review math.ts" } })
  })

  test("every --option the pages name exists", () => {
    const known = new Set([...helpText().matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((match) => match[1]!))
    for (const page of PAGES) {
      // A server's own arguments in a json block are not options of the program.
      const prose = text[page].replace(/```json\n[\s\S]*?```/g, "")
      for (const [, flag] of prose.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) expect(known, `${page}: ${flag}`).toContain(flag!)
    }
    for (const short of ["-c, --continue"]) expect(helpText()).toContain(short)
  })

  test("every /command the pages name is one an interface knows, or is said not to exist", () => {
    const tui = new Set(COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]))
    const line = new Set(BUILTIN_COMMANDS.commands().flatMap((command) => [command.name, ...(command.aliases ?? [])]))
    // The pages say these do not exist ("Not yet"). When one does, its page is out of date.
    const missing: Readonly<Record<string, Page>> = { tasks: "docs/task-list.md" }
    const named = new Set<string>()
    for (const page of PAGES)
      for (const [, name] of text[page].matchAll(/`\/([a-z][a-z-]*)(?: [a-z]+)?`/g)) {
        named.add(name!)
        if (missing[name!] !== undefined) continue
        expect(tui.has(name!) || line.has(name!), `${page}: /${name}`).toBe(true)
      }
    for (const [name, page] of Object.entries(missing)) {
      expect(named, `${page} says there is no /${name}`).toContain(name)
      expect(tui.has(name) || line.has(name), `/${name} is a command now: update ${page}`).toBe(false)
    }
    // docs/agents.md: /agent in both interfaces, /agents the same command.
    for (const commandsOf of [COMMANDS, BUILTIN_COMMANDS.commands()]) expect(commandsOf.find((command) => command.name === "agent")?.aliases).toContain("agents")
    expect(line.has("compact") && tui.has("compact")).toBe(true)
  })
})

describe("configuration", () => {
  test("every json block is a valid configuration file", () => {
    const configs = PAGES.flatMap((page) => blocks(page, "json").filter((body) => !isHookEvent(body)).map((body) => ({ page, body })))
    expect(configs.length).toBeGreaterThanOrEqual(5)
    for (const { page, body } of configs) expect(() => parseConfigFile(body, page), `${page}:\n${body}`).not.toThrow()
  })

  /** The keys of the table whose header starts with `| <header> |` on `page`. */
  const tableKeys = (page: Page, header: string) => {
    const start = text[page].indexOf(`| ${header} |`)
    expect(start, `${page}: ${header}`).toBeGreaterThan(-1)
    const rows = text[page].slice(start).split("\n").slice(2)
    return rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).map((row) => /^\| `([^`]+)` \|/.exec(row)?.[1])
  }

  /** The keys the validators know, from the error an unknown key gets. */
  const validatorKeys = (file: string) => {
    try {
      parseConfigFile(file, "config.json")
    } catch (error) {
      const listed = /known keys: (.*)$/.exec((error as Error).message)?.[1]
      if (listed !== undefined) return listed.split(", ")
      throw error
    }
    throw new Error(`${file} was accepted`)
  }

  test("each table of keys is the validator's, in its order", () => {
    expect(tableKeys("docs/agents.md", "Key in `agents`")).toEqual(validatorKeys('{ "agents": { "zzz": 1 } }'))
    expect(tableKeys("docs/hooks.md", "Key in `hooks`")).toEqual(validatorKeys('{ "hooks": { "zzz": 1 } }'))
    // A hook before a call takes every key; the other two points take fewer (the page says which).
    expect(tableKeys("docs/hooks.md", "Key in a hook")).toEqual(validatorKeys('{ "hooks": { "beforeTool": [{ "zzz": 1 }] } }'))
    expect(validatorKeys('{ "hooks": { "afterTool": [{ "zzz": 1 }] } }')).not.toContain("onError")
    expect(validatorKeys('{ "hooks": { "stop": [{ "zzz": 1 }] } }')).toEqual(["name", "command", "timeoutSeconds", "sandbox"])
    expect(tableKeys("docs/diagnostics.md", "Key in `lsp`")).toEqual(validatorKeys('{ "lsp": { "zzz": 1 } }'))
    expect(tableKeys("docs/diagnostics.md", "Key in a server")).toEqual(validatorKeys('{ "lsp": { "servers": { "x": { "zzz": 1 } } } }'))
  })

  test("the mistakes the pages quote get the quoted messages", () => {
    const message = (file: string, origin?: "user" | "project") => {
      try {
        if (origin === undefined) parseConfigFile(file, "config.json")
        else parseConfigFile(file, "config.json", origin)
      } catch (error) {
        return (error as Error).message
      }
      return ""
    }
    const unknown = 'hooks.beforeTool[0].comand: unknown key "comand"; known keys: name, tools, paths, command, timeoutSeconds, onError, sandbox'
    expect(text["docs/hooks.md"]).toContain(unknown)
    expect(message('{ "hooks": { "beforeTool": [{ "name": "x", "comand": "true" }] } }')).toEndWith(unknown)
    const outside = "only the user's own configuration file can run a hook outside the sandbox"
    expect(text["docs/hooks.md"]).toContain(outside)
    expect(message('{ "hooks": { "stop": [{ "command": "true", "sandbox": false }] } }', "project")).toContain(outside)
    expect(message('{ "hooks": { "stop": [{ "command": "true", "sandbox": false }] } }', "user")).toBe("")
  })

  test("the numbers the pages give are the code's", () => {
    const agents = text["docs/agents.md"]
    expect(agents).toContain(`at most ${MAX_AGENT_NAME_LENGTH} characters`)
    expect(agents).toContain(`A file is at most ${MAX_AGENT_BYTES / 1024} KiB`)
    expect(MAX_AGENT_DEPTH).toBe(3)
    expect(agents).toContain("up to two folders below")

    const hooks = text["docs/hooks.md"]
    const t = HOOK_LIMITS.timeoutSeconds
    expect(hooks).toContain(`| \`timeoutSeconds\` | ${t.min} to ${t.max}; default ${t.beforeDefault} before and after a call, ${t.stopDefault} at the end of a turn |`)
    expect(t.afterDefault).toBe(t.beforeDefault)
    const rounds = HOOK_LIMITS.maxStopRounds
    expect(hooks).toContain(`${rounds.min} to ${rounds.max}; default ${rounds.default} |`)
    expect(ANSWER_LIMITS.afterTool).toBe(ANSWER_LIMITS.beforeTool)
    expect(hooks).toContain(`cut at ${ANSWER_LIMITS.beforeTool.toLocaleString("en")} characters, a stop message at ${ANSWER_LIMITS.stop.toLocaleString("en")}`)
    expect(hooks).toContain(`the first ${EVENT_LIMITS.output / 1024} KiB of the output`)
    expect(hooks).toContain(`${EVENT_LIMITS.lastText / 1024} KiB at most`)
    expect([...HOOK_POINTS]).toEqual(["beforeTool", "afterTool", "stop"])

    const lsp = text["docs/diagnostics.md"]
    const wait = LSP_LIMITS.waitMs
    expect(lsp).toContain(`${wait.min} to ${wait.max} milliseconds; default ${wait.default}`)
    expect(lsp).toContain(`at most \`waitMs\` (${wait.default / 1000} seconds by default)`)
    expect(lsp).toContain(`within ${wait.default} ms of an edit`)
    const items = LSP_LIMITS.maxDiagnostics
    expect(lsp).toContain(`| \`maxDiagnostics\` | diagnostics listed per edit, ${items.min} to ${items.max}; default ${items.default} |`)
    expect(lsp).toContain(`(${items.default} by default) and ${NOTE_LIMITS.maxChars.toLocaleString("en")} characters`)
    const startup = LSP_LIMITS.startupTimeoutSeconds
    expect(lsp).toContain(`${startup.min} to ${startup.max}; default ${startup.default} |`)

    const tasks = text["docs/task-list.md"]
    expect(tasks).toContain(`at most ${TODO_LIMITS.maxItems} tasks, each one line of at most ${TODO_LIMITS.maxTextLength} characters`)
    expect(tasks).toContain(`\`${TODO_TOOL_NAME}\` tool`)
  })
})

describe("agents against the code", () => {
  test("the definition directories are the ones discovery searches, in its order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "feature-docs-2-"))
    try {
      const roots = agentRoots({ cwd, configDir: join(cwd, "config") })
      const projectNames = roots.filter((root) => root.scope === "project").map((root) => root.dir.slice(cwd.length + 1))
      expect(projectNames[0]).toBe(`.${DIR}/agents`)
      expect(text["docs/agents.md"]).toContain(projectNames.map((name) => `\`${name}/\``).join(", ").replace(/, ([^,]*)$/, " and $1"))
      expect(roots.at(-1)).toEqual({ dir: join(cwd, "config", "agents"), scope: "user" })
      expect(text["docs/agents.md"]).toContain(`\`~/.config/${DIR}/agents/\` (\`$XDG_CONFIG_HOME/${DIR}/agents/\` when that is set)`)
      const extra = agentRoots({ cwd, configDir: join(cwd, "config"), extraPaths: ["/team"] }).map((root) => root.scope)
      expect(extra.indexOf("config")).toBeGreaterThan(extra.lastIndexOf("project"))
      expect(extra.indexOf("config")).toBeLessThan(extra.indexOf("user"))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("the example definition loads as a read-only agent, and the table's keys are the ones read", () => {
    const example = blocks("docs/agents.md", "markdown")[0]!
    const parsed = parseAgentDefinition(example, "reviewer")
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.warnings).toEqual([])
    expect(parsed.agent).toMatchObject({ name: "reviewer", model: null, restrictions: { effects: ["read"], tools: null, deniedTools: [], approval: null } })

    const start = text["docs/agents.md"].indexOf("| Front matter |")
    const rows = text["docs/agents.md"].slice(start).split("\n").slice(2)
    const keys = rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).map((row) => /^\| `([^`]+)` \|/.exec(row)![1]!)
    expect(keys).toEqual(["name", "description", "model", "effort", "effects", "tools", "disallowed-tools", "approval"])
    const full = parseAgentDefinition(
      "---\nname: full\ndescription: Every key.\nmodel: gpt-6-luna\neffort: low\neffects: read, write\ntools: read, edit\ndisallowed-tools: write\napproval: ask\n---\nBody.\n",
      "full",
    )
    if (!full.ok) throw new Error(full.reason)
    expect(full.warnings).toEqual([])
    expect(full.agent).toMatchObject({ model: "gpt-6-luna", effort: "low", restrictions: { effects: ["read", "write"], tools: ["read", "edit"], deniedTools: ["write"], approval: "ask" } })

    // The keys of other harnesses the page names load with a warning; an unknown one is ignored without one.
    for (const key of ["permissionMode", "mcpServers", "hooks"]) {
      const foreign = parseAgentDefinition(`---\nname: x\ndescription: X.\n${key}: y\n---\nBody.\n`, "x")
      expect(foreign.ok && foreign.warnings.some((warning) => warning.includes(`\`${key}\` is not read here`)), key).toBe(true)
    }
    const ignored = parseAgentDefinition("---\nname: x\ndescription: X.\ncolor: blue\n---\nBody.\n", "x")
    expect(ignored.ok && ignored.warnings.length === 0).toBe(true)
    // The reasons under "What can go wrong".
    const refused = (frontMatter: string) => {
      const result = parseAgentDefinition(`---\n${frontMatter}\n---\nBody.\n`, "x")
      return result.ok ? "" : result.reason
    }
    expect(refused("name: x")).toContain("no `description`")
    expect(refused("name: x\ndescription: X.\ntools:")).toContain("`tools` is empty")
    expect(refused("name: x\ndescription: X.\ntools: Bash(git:*)")).toContain("name whole tools")
    expect(refused("name: x\ndescription: X.\neffects: delete")).toContain("is not an effect class")
    expect(refused("name: none\ndescription: X.")).toContain('"none" cannot be an agent\'s name')
    const unnamed = parseAgentDefinition("---\ndescription: X.\n---\nBody.\n", "careful")
    expect(unnamed.ok && unnamed.agent.name === "careful" && unnamed.warnings.length === 1).toBe(true)
  })
})

describe("hooks against the code", () => {
  const page = text["docs/hooks.md"]

  test("the event the page shows has the shape the program writes", () => {
    const shown = JSON.parse(blocks("docs/hooks.md", "json").find(isHookEvent)!) as Record<string, unknown>
    const common = { sessionId: "ses_f302da68932bfa62e9957753", cwd: "/home/me/proj", hook: { name: "no-push", origin: "user" as const } }
    const call = { name: "shell", callId: "c2", arguments: { command: "echo hi" }, paths: null }
    const before = hookEvent({ ...common, point: "beforeTool", tool: call })
    expect(shown).toEqual(JSON.parse(before.stdin))

    const after = JSON.parse(hookEvent({ ...common, point: "afterTool", tool: call, result: { status: "success", output: "hi\n" } }).stdin) as { result: unknown }
    expect(page).toContain(`\`"result": ${spaced(after.result)}\``)
    const stop = JSON.parse(hookEvent({ ...common, point: "stop", round: 1, maxRounds: 3, lastText: "All done." }).stdin) as { turn: unknown }
    expect(page).toContain(`\`"turn": ${spaced(stop.turn)}\``)
  })

  /** JSON as the page writes it: a space inside the braces and after each colon and comma. */
  function spaced(value: unknown): string {
    if (typeof value !== "object" || value === null) return JSON.stringify(value)
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${spaced(item)}`).join(", ")} }`
  }

  test("the environment variables are the ones a hook is given", () => {
    expect(HOOK_ENV_PREFIX).toBe(`${brand.envPrefix}HOOK_`)
    const common = { sessionId: "ses_1", cwd: "/w", hook: { name: "h", origin: "user" as const } }
    const given = new Set([
      ...Object.keys(hookEvent({ ...common, point: "afterTool", tool: { name: "shell", callId: "c", arguments: { command: "ls" }, paths: ["a.ts"] }, result: { status: "success", output: "" } }).env),
      ...Object.keys(hookEvent({ ...common, point: "stop", round: 1, maxRounds: 3, lastText: "" }).env),
    ])
    const named = new Set([...page.matchAll(/\b([A-Z]+_HOOK_[A-Z_]+)\b/g)].map((match) => match[1]!))
    expect([...named].sort()).toEqual([...given].sort())
  })
})

describe("quoted program messages", () => {
  /**
   * The program's messages the pages quote: the quote exactly as the page has it, and the pieces of it that are
   * the program's own text, each of which must be in the source. What is left of a quote once its pieces and
   * placeholders are taken out is what differs from run to run (names, numbers) and must stay short.
   */
  const MESSAGES: readonly { readonly page: Page; readonly quote: string; readonly pieces: readonly string[] }[] = [
    // agents
    { page: "docs/agents.md", quote: "⇄ working as the agent reviewer (read only)", pieces: ["working as the agent ", "read only"] },
    { page: "docs/agents.md", quote: "Only tools that read (effects: read).", pieces: ["Only tools that ", "(effects: "] },
    { page: "docs/agents.md", quote: "○ not run: the reviewer agent may not change files", pieces: ["not run: ", " may not change files"] },
    { page: "docs/agents.md", quote: "⊘ edit math.ts · not run: the reviewer agent may not change files", pieces: ["not run: ", " may not change files"] },
    {
      page: "docs/agents.md",
      quote: '⚠ agents: The agent definition at <path> is hidden by another agent of the same name: the agent "reviewer" at <path> takes precedence',
      pieces: ["The agent definition at ", "is hidden by another agent of the same name", "the agent ", " takes precedence"],
    },
    {
      page: "docs/agents.md",
      quote: 'Not run: you are working as the agent "reviewer", which may use only tools that read. "edit" changes files. Carry on without it, or tell the user what you would need and why.',
      pieces: ["Not run: you are working as the agent ", ", which may use only tools that ", "changes files", "Carry on without it, or tell the user what you would need and why."],
    },
    {
      page: "docs/agents.md",
      quote: 'Not run: you are working as the agent "docs", which may use only these tools: read, grep, glob, edit, write. "shell" is not one of them.',
      pieces: ["Not run: you are working as the agent ", ", which may use only these tools: ", " is not one of them."],
    },
    {
      page: "docs/agents.md",
      quote: 'Not run: you are working as the agent "careful", which may not use the tool "background_stop".',
      pieces: ["Not run: you are working as the agent ", ", which may not use the tool "],
    },
    {
      page: "docs/agents.md",
      quote: '⚠ agents: The agent "<name>" asks for approval mode "full"; the user\'s mode "auto" is kept, since an agent can only tighten it.',
      pieces: [" asks for approval mode ", "; the user's mode ", " is kept, since an agent can only tighten it."],
    },
    { page: "docs/agents.md", quote: "new session ses_… · agent reviewer", pieces: ["new session ", " · agent "] },
    { page: "docs/agents.md", quote: 'There is no agent named "reviwer". Did you mean "reviewer"? Agents: docs, reviewer.', pieces: ["There is no agent named ", " Did you mean ", " Agents: "] },
    { page: "docs/agents.md", quote: 'The agent "docs" is disabled in the configuration (agents.disabled).', pieces: [" is disabled in the configuration (agents.disabled)."] },
    {
      page: "docs/agents.md",
      quote: '(It is the default agent, agents.default; change that, or start with the agent "none".)',
      pieces: ["(It is the default agent, agents.default; change that, or start with the agent "],
    },
    {
      page: "docs/agents.md",
      quote: 'not followed: agents.default "docs" in the project\'s configuration (only the user\'s own configuration chooses the default agent)',
      pieces: ["not followed: ", "agents.default ", " in the project's configuration (only the user's own configuration chooses the default agent)"],
    },
    { page: "docs/agents.md", quote: "Agents (this session runs as reviewer):", pieces: ["Agents (this session runs as "] },
    { page: "docs/agents.md", quote: "/agent <name> switches to another · /agent none switches it off", pieces: ["/agent <name> switches to another · /agent none switches it off"] },
    { page: "docs/agents.md", quote: "⇄ agent reviewer → docs (restricted) · from the next step", pieces: ["agent ", " → ", "restricted", " · from the next step"] },
    { page: "docs/agents.md", quote: "Only these tools: read, grep, glob, edit, write.", pieces: ["Only these tools: "] },
    {
      page: "docs/agents.md",
      quote: "⇄ no agent: the instructions and restrictions of reviewer no longer apply · from the next step",
      pieces: ["no agent: the instructions and restrictions of ", " no longer apply", " · from the next step"],
    },
    { page: "docs/agents.md", quote: "· instructions updated (agent-index): Agents you can run a subagent as: ...", pieces: ["instructions updated (", "agent-index", "Agents you can run a subagent as:"] },
    {
      page: "docs/agents.md",
      quote: "An agent is a role kept as a file: instructions, and sometimes a model and restrictions. To give a task to a subagent that works as one, call the subagent tool with `agent` set to its name. Without `agent` the subagent works as you do.",
      pieces: ["An agent is a role kept as a file: instructions, and sometimes a model and restrictions. To give a task to a subagent that works as one, call the subagent tool with `agent` set to its name. Without `agent` the subagent works as you do."],
    },
    {
      page: "docs/agents.md",
      quote: 'The subagent was not started: There is no agent named "revewer". Did you mean "reviewer"? Agents: careful, docs, reviewer.',
      pieces: ["The subagent was not started: ", "There is no agent named ", " Did you mean ", " Agents: "],
    },
    {
      page: "docs/agents.md",
      quote: 'The user switched you from the agent "reviewer" to the agent "docs". From this point on these instructions replace those of "reviewer" (and its restrictions); everything else you were given still applies:',
      pieces: ["The user switched you from the agent ", " to the agent ", ". From this point on these instructions replace those of ", " (and its restrictions); everything else you were given still applies:"],
    },
    {
      page: "docs/agents.md",
      quote: 'The user switched off the agent "careful". From this point on its instructions and its restrictions no longer apply; carry on under your other instructions.',
      pieces: ["The user switched off the agent ", ". From this point on its instructions and its restrictions no longer apply; carry on under your other instructions."],
    },
    {
      page: "docs/agents.md",
      quote: "⇄ the agent reviewer (restricted) was selected again with its changed definition",
      pieces: ["the agent ", " was selected again with its changed definition"],
    },
    {
      page: "docs/agents.md",
      quote: "⚠ agents: The agent definition at <path> was not loaded: it does not start with front matter (a line `---`, then `name:` and `description:`, then `---`)",
      pieces: ["The agent definition at ", "was not loaded", "it does not start with front matter (a line `---`, then `name:` and `description:`, then `---`)"],
    },
    // hooks
    { page: "docs/hooks.md", quote: 'This call was not run: the hook "no-push" refused it.', pieces: ["This call was not run: the hook ", " refused it"] },
    { page: "docs/hooks.md", quote: 'This call was not run: the hook "no-env-files" refused it.', pieces: ["This call was not run: the hook ", " refused it"] },
    { page: "docs/hooks.md", quote: '[Note from the hook "no-todo"]', pieces: ["[Note from the hook "] },
    { page: "docs/hooks.md", quote: "[Stop hook 1 of at most 3] The turn cannot end yet.", pieces: ["[Stop hook ", " of at most ", "] The turn cannot end yet."] },
    { page: "docs/hooks.md", quote: 'The hook "no-scratch" says:', pieces: ["The hook ", " says:"] },
    { page: "docs/hooks.md", quote: 'This call was not run: the hook "<name>" refused it and gave no reason.', pieces: ["This call was not run: the hook ", " refused it", " and gave no reason"] },
    {
      page: "docs/hooks.md",
      quote: '⚠ hooks: The hook "<name>" (before a tool call) could not answer: it exited with code 1; a hook answers with 0 or 2. A call it must allow is refused while it fails, unless the hook says `onError: "allow"`.',
      pieces: ["before a tool call", " could not answer: ", "it exited with code ", "; a hook answers with 0 or ", 'A call it must allow is refused while it fails, unless the hook says `onError: "allow"`.'],
    },
    { page: "docs/hooks.md", quote: "could not answer: it did not answer within 1 second.", pieces: ["could not answer: ", "it did not answer within "] },
    { page: "docs/hooks.md", quote: "(after a tool call) could not answer: it exited with code 3; a hook answers with 0 or 2. Nothing was added to the result.", pieces: ["after a tool call", "could not answer: ", "it exited with code ", "; a hook answers with 0 or ", "Nothing was added to the result."] },
    {
      page: "docs/hooks.md",
      quote: "(when a turn is about to end) could not answer: it exited with code 9; a hook answers with 0 or 2. The turn ended as it would have without it.",
      pieces: ["when a turn is about to end", "could not answer: ", "it exited with code ", "; a hook answers with 0 or ", "The turn ended as it would have without it."],
    },
    {
      page: "docs/hooks.md",
      quote: 'This call was not run: the hook "<name>" (from the user\'s configuration) must allow it and could not answer: it exited with code 1; a hook answers with 0 or 2. Do not try to work around the hook; tell the user it is failing.',
      pieces: ["This call was not run: the hook ", "the user's configuration", " must allow it and could not answer: ", "Do not try to work around the hook; tell the user it is failing."],
    },
    {
      page: "docs/hooks.md",
      quote: "[Stop hook 2 of at most 2] The turn cannot end yet. This is the last time: if you stop again, the turn ends with the hook unsatisfied.",
      pieces: ["[Stop hook ", "] The turn cannot end yet.", " This is the last time: if you stop again, the turn ends with the hook unsatisfied."],
    },
    {
      page: "docs/hooks.md",
      quote: '⚠ hooks: The turn ended although the stop hook "<name>" still objected: the agent was sent back 2 times already, the most a turn allows.',
      pieces: ["The turn ended although ", "the stop hook", " still objected: the agent was sent back ", " already, the most a turn allows."],
    },
    {
      page: "docs/hooks.md",
      quote: '⚠ hooks: This project\'s configuration asks to run the hook "<name>" before a tool call (<command>). It is not run: a hook a project names runs only after you approve it.',
      pieces: ["This project's configuration asks to run the hook ", "before a tool call", "It is not run: a hook a project names runs only after you approve it."],
    },
    {
      page: "docs/hooks.md",
      quote: "⚠ hooks: The project's configuration asks for more than yours allows and was not followed: hooks.maxStopRounds: the project's 9 is above the user's 3.",
      pieces: ["The project's configuration asks for more than yours allows and was not followed: ", "hooks.maxStopRounds: the project's ", " is above the user's "],
    },
    // diagnostics
    {
      page: "docs/diagnostics.md",
      quote: '[Diagnostics from the language server "typescript" for math.ts after this edit: 1 new error]',
      pieces: ["[Diagnostics from the language server ", " after this edit: "],
    },
    {
      page: "docs/diagnostics.md",
      quote: "These are the language server's diagnostics for this file after the edit; the 1 it already had is not listed, and the project's checks remain the authority.",
      pieces: ["These are the language server's diagnostics for this file after the edit; ", " it already had ", "not listed, and the project's checks remain the authority."],
    },
    {
      page: "docs/diagnostics.md",
      quote: "diagnostics it already had are not listed, and the project's checks remain the authority.",
      pieces: ["diagnostics it already had are", "not listed, and the project's checks remain the authority."],
    },
    { page: "docs/diagnostics.md", quote: "... and 27 more new diagnostics not listed.", pieces: ["... and ", " more new ", "diagnostics", " not listed."] },
    { page: "docs/diagnostics.md", quote: "after this edit: 1 new error, 1 new warning]", pieces: ["after this edit: ", "new "] },
    {
      page: "docs/diagnostics.md",
      quote: '⚠ lsp: The language server "<name>" did not give diagnostics within 1500 ms of an edit, so the edit got none. This is said once; it may keep happening if the server is slow.',
      pieces: ["The language server ", " did not give diagnostics within ", " ms of an edit, so the edit got none. This is said once; it may keep happening if the server is slow."],
    },
    {
      page: "docs/diagnostics.md",
      quote: '⚠ lsp: The language server "<name>" was still starting when an edit needed its diagnostics; the edit got none. Later edits get them once it is ready.',
      pieces: ["The language server ", " was still starting when an edit needed its diagnostics; the edit got none. Later edits get them once it is ready."],
    },
    {
      page: "docs/diagnostics.md",
      quote: '⚠ lsp: The language server "<name>" could not be started: could not start "<command>": Executable not found in $PATH: "<command>". Edits get no diagnostics from it; it is tried again at the next edit after 1 s.',
      pieces: ["The language server ", " could not be started: ", "could not start ", "Edits get no diagnostics from it; it is tried again at the next edit after "],
    },
    {
      page: "docs/diagnostics.md",
      quote: '⚠ lsp: The language server "<name>" stopped (the server process exited with code 3; it wrote: ...). Edits get no diagnostics until it is started again, at the next edit after 1 s.',
      pieces: ["The language server ", " stopped (", "the server process exited with code ", "it wrote: ", "Edits get no diagnostics until it is started again, at the next edit after "],
    },
    {
      page: "docs/diagnostics.md",
      quote: '⚠ lsp: This project\'s configuration names the language server "<name>" (<command and arguments>). It was not started: a server a project names runs only after you approve it.',
      pieces: ["This project's configuration names the language server ", "It was not started: a server a project names runs only after you approve it."],
    },
    {
      page: "docs/diagnostics.md",
      quote: '⚠ lsp: The language server "<name>" from this project\'s configuration is not started: it waits for your approval.',
      pieces: ["The language server ", " from this project's configuration is not started: it waits for your approval."],
    },
    // the task list
    { page: "docs/task-list.md", quote: "≡ tasks · 1 of 3 done", pieces: ["≡ ", "tasks", " of ", " done"] },
    { page: "docs/task-list.md", quote: "≡ tasks · all 3 done", pieces: ["≡ ", "tasks", "all ", " done"] },
    { page: "docs/task-list.md", quote: "Tasks  1 of 3 done", pieces: ["Tasks", " done"] },
    { page: "docs/task-list.md", quote: "Task list updated: 1 done, 1 in progress, 1 pending.", pieces: ["Task list updated: ", " done, ", " in progress, ", " pending."] },
    { page: "docs/task-list.md", quote: "Now: Fix the off-by-one", pieces: ["Now: "] },
    {
      page: "docs/task-list.md",
      quote: "The task list was not updated: items 1, 2 are all in_progress; at most one item is in_progress at a time. Send the whole list again with this fixed.",
      pieces: ["The task list was not updated: ", " are all in_progress; at most one item is in_progress at a time.", " Send the whole list again with this fixed."],
    },
    { page: "docs/task-list.md", quote: "Its task list (1 of 3 done):", pieces: ["Its task list ("] },
    {
      page: "docs/task-list.md",
      quote: "## Your task list when the conversation was compacted ([x] done, [>] in progress, [ ] pending)",
      pieces: ["## Your task list when the conversation was compacted ([x] done, [>] in progress, [ ] pending)"],
    },
  ]

  test("each quote is on its page, and its pieces are the program's text", () => {
    const problems: string[] = []
    for (const { page, quote, pieces } of MESSAGES) {
      if (!text[page].includes(quote)) problems.push(`${page} no longer quotes: ${quote}`)
      let rest = quote.replace(/<[^>]+>/g, "").replace(/\bses_[0-9a-f…]+/g, "")
      for (const piece of pieces) {
        if (!quote.includes(piece)) problems.push(`${page}: "${piece}" is not part of the quote ${quote}`)
        if (!SOURCE_TEXT.includes(piece)) problems.push(`${page}: "${piece}" is not in the program's source (quoted: ${quote})`)
        rest = rest.replace(piece.replace(/<[^>]+>/g, ""), "")
      }
      if (rest.replace(/[\s.,:;()?`'"\[\]↳⚠⇄○⊘≡·→]/g, "").length > 45) problems.push(`${page}: too much of the quote is not checked (${rest.trim()})`)
    }
    expect(problems).toEqual([])
  })

  test("every line a page shows as the program's output is covered by a quote", () => {
    // What a `text` block shows that is not a quoted message: the examples' own content (a task, a path, a diff line).
    const own = /^([✓▸○] |\* |docs |(restricted|read only) · <path>|- (docs|reviewer) |<\/?agents?[ >]|\.\.\.$|\[[x> ]\] |math\.ts:|1:export |Edited math\.ts|Do not leave TODO|Files named \.env|SCRATCH\.md still|Pushing is not allowed|✗ )/
    const uncovered: string[] = []
    for (const page of PAGES)
      for (const body of blocks(page, "text"))
        for (const line of body.split("\n")) {
          const shown = line.trim()
          if (shown === "" || own.test(shown)) continue
          if (!MESSAGES.some((message) => message.page === page && (shown.includes(message.quote) || message.quote.includes(shown)))) uncovered.push(`${page}: ${shown}`)
        }
    expect(uncovered).toEqual([])
  })
})

describe("what the pages say is not there yet", () => {
  test("each Not yet section marks its sentences for whoever adds the feature", () => {
    const markers: Readonly<Record<Page, readonly string[]>> = {
      "docs/agents.md": ["agents-start-warnings", "agents-subagent-row", "agents-model-switch"],
      "docs/hooks.md": [],
      "docs/diagnostics.md": [],
      "docs/task-list.md": ["tasks-command", "tasks-edit"],
    }
    for (const page of PAGES) {
      const section = text[page].slice(text[page].indexOf("\n## Not yet\n"))
      expect(section.startsWith("\n## Not yet\n"), `${page} has a Not yet section`).toBe(true)
      expect([...section.matchAll(/<!-- NOT-YET\(([a-z-]+)\): [^>]+ -->/g)].map((match) => match[1]!)).toEqual([...markers[page]])
    }
  })

  test("both interfaces approve a project's hook and language server, list them, and show what they did", () => {
    expect(text["docs/hooks.md"]).toContain("**Approving a project's hook.**")
    expect(text["docs/hooks.md"]).toContain("`/hooks approve <hook>`")
    expect(text["docs/diagnostics.md"]).toContain("**Approving a project's server.**")
    expect(text["docs/diagnostics.md"]).toContain("`/lsp approve <server>`")
    // The engine offers both approvals and the clients call them.
    const engine = read(join(ROOT, "packages/core/src/engine/engine.ts"))
    expect(engine).toMatch(/\bapproveHook = \(/)
    expect(engine).toMatch(/\bapproveLspServer = \(/)
    const clients = clientFiles().map(read).join("\n")
    expect(clients).toMatch(/approveHook\b/)
    expect(clients).toMatch(/approveLspServer\b/)
    // The commands the pages name, with the arguments they name, in both interfaces.
    for (const commandsOf of [COMMANDS, BUILTIN_COMMANDS.commands()]) {
      expect(commandsOf.find((command) => command.name === "hooks")?.args).toBe("[approve <hook>]")
      expect(commandsOf.find((command) => command.name === "lsp")?.args).toBe("[approve <server>]")
    }
    // What a hook did and what an edit got are read by the clients, and are in --json as the pages say.
    expect(text["docs/hooks.md"]).toContain("**Seeing what a hook did.**")
    expect(text["docs/diagnostics.md"]).toContain("**Seeing the note.**")
    expect(clients).toMatch(/hook\.ran|forUser/)
    const durable = read(join(ROOT, "packages/core/src/event/durable.ts"))
    for (const field of ["toModel", "forUser", "noteAdded", "unsatisfied"]) expect(SOURCE, field).toContain(field)
    expect(durable).toContain('"hook.ran"')
  })

  test("the warnings of a session's start are said before a client listens (agents-start-warnings)", () => {
    expect(text["docs/agents.md"]).toContain("**Two warnings are missed when a session starts.**")
    // The engine says them while it creates the session; a client subscribes after. When that changes, the page does.
    expect(read(join(ROOT, "packages/core/src/engine/engine.ts"))).toContain('for (const warning of start.warnings) session.say("agents", warning)')
  })

  test("a subagent's row does not name its agent, and no tool switches the session's agent (agents-subagent-row, agents-model-switch)", () => {
    expect(text["docs/agents.md"]).toContain("**A subagent's row does not name its agent.**")
    for (const file of FILES.filter((path) => path.startsWith(join(ROOT, "packages/cli/src")))) expect(/work\.agent\b/.test(read(file)), `${file} shows a subagent's agent: update docs/agents.md`).toBe(false)
    expect(SOURCE).toMatch(/work: \{[^}]*agent/)
    expect(text["docs/agents.md"]).toContain("**The model cannot switch the session's agent.**")
    // setAgent is the user's switch; a tool that called it would be the model's.
    for (const file of FILES.filter((path) => path.startsWith(join(ROOT, "packages/core/src/tools")) || path.endsWith("engine/spawn.ts")))
      expect(/setAgent\(/.test(read(file)), `${file} lets the model switch the agent: update docs/agents.md`).toBe(false)
  })
})

describe("the module pages for integrators, where users read them too", () => {
  const page = (path: string) => read(join(ROOT, path))
  /** What the edit tool answers for one replacement on one line, as its source builds it. */
  const edited = (path: string, line: number) => `Edited ${path}: replaced 1 occurrence (line ${line}).`

  test("the hooks page: a hook's stderr is in its record and shown by both interfaces, and the edit result is the tool's", () => {
    const hooks = page("packages/core/src/hooks/README.md")
    expect(hooks).not.toContain("it is shown to you")
    expect(hooks).toContain("the\n`forUser` field of the `hook.ran` event")
    expect(hooks).toContain("Both interfaces show what a hook printed")
    // Both interfaces read the field.
    for (const dir of ["packages/cli/src", "packages/tui/src"])
      expect(clientFiles().filter((file) => file.includes(dir)).some((file) => /forUser/.test(read(file))), `${dir} shows what a hook printed`).toBe(true)
    expect(hooks).toContain(`${edited("src/a.ts", 1)}\n\n[Note from the hook "prettier"]`)
    expect(hooks).not.toMatch(/Edited [^\n]*\(1 change\)/)
    expect(read(join(ROOT, "packages/core/src/tools/edit.ts"))).toContain("return success(`Edited ${shown}: replaced ${count} (${linesLabel(newLines)}).`")
  })

  test("the diagnostics page quotes the edit result as the tool prints it", () => {
    const lsp = page("packages/core/src/lsp/README.md")
    expect(lsp).toContain(`${edited("src/app.ts", 12)}\n\n[Diagnostics from the language server "typescript" for src/app.ts after this edit: 2 new errors]`)
    expect(lsp).not.toMatch(/Edited [^\n]*\(1 change\)/)
    // The same form as the page for users.
    expect(text["docs/diagnostics.md"]).toContain(edited("math.ts", 1))
  })

  test("the task list's page says the clients show the list, which they do", () => {
    const todo = page("packages/core/src/tools/TODO-TOOL.md")
    expect(todo).not.toContain("still to do")
    expect(todo).toContain("The part about clients is done too")
    expect(todo).toContain("≡ tasks · 1 of 3 done")
    // Each interface draws the list from the tool's result (`display.todo`, read by `tasksOf`).
    for (const file of ["packages/cli/src/renderer.ts", "packages/tui/src/transcript.ts"]) expect(read(join(ROOT, file)), file).toContain("tasksOf(")
  })

  test("the agents page says which problems a session's start misses, and that the clients are built", () => {
    const agents = page("packages/core/src/agents/README.md")
    expect(agents).not.toContain("(still to do)")
    expect(agents).toContain("## For the clients (done)")
    expect(agents).toContain("They are not\n  all delivered when a session starts.")
    // Said while the session is created, before a client subscribes (the same fact docs/agents.md marks).
    expect(read(join(ROOT, "packages/core/src/engine/engine.ts"))).toContain('for (const warning of start.warnings) session.say("agents", warning)')
    // The clients' part: the option, the listing and the command exist.
    expect(read(join(ROOT, "packages/acp/src/server.ts"))).toContain('agent: "agent"')
    expect(read(join(ROOT, "packages/acp/src/extensions.ts"))).toContain("agents: `${prefix}/agents`")
    expect(helpText()).toContain("--agent <name>")
    for (const commandsOf of [COMMANDS, BUILTIN_COMMANDS.commands()]) expect(commandsOf.some((command) => command.name === "agent")).toBe(true)
  })
})

describe("names against the code", () => {
  test("directories and the binary are the brand's", () => {
    for (const [, name] of all.matchAll(/(?:~\/\.config|\$XDG_CONFIG_HOME)\/([a-z0-9][a-z0-9_-]*)\//g)) expect(name).toBe(DIR)
    for (const [, name] of all.matchAll(/(?<![\w/~])\.([a-z][a-z0-9_-]*)\/(?:config\.json|agents\/)/g)) if (!["agents", "claude"].includes(name!)) expect(name).toBe(DIR)
    const ours = /^(tui|acp|-[a-z]|--[a-z])/
    for (const [, span] of all.matchAll(/`([^`\n]+)`/g)) {
      const [first, second] = span!.split(/\s+/)
      if (first === undefined || second === undefined || !/^[a-z][a-z0-9-]*$/.test(first)) continue
      if (ours.test(second)) expect(first, span).toBe(BIN)
    }
  })

  test("the pages name this file as their check", () => {
    for (const page of PAGES) expect(text[page], page).toContain("`test/release/feature-docs-2.test.ts`")
  })
})
