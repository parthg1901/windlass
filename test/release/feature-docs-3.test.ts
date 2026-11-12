/**
 * The feature pages docs/commands.md and docs/telemetry.md, checked against
 * the program in the manner of feature-docs.test.ts, and the passages of the
 * other feature pages that say what a run prints, run here:
 *
 * - Every command in a `sh` block is one the program or the export script
 *   accepts; every `json` block is a valid configuration file; each "Key in
 *   ..." table lists exactly the keys the validators know; limits, directories
 *   and the example command file are the code's.
 * - Every quoted message is made of text found in the program's source.
 * - The examples are run with the scripted model in a throwaway home: command
 *   files (expansion, arguments, what is left as text, a namespaced name, an
 *   agent that does not exist, what a one-prompt run does with a mistyped
 *   name), telemetry (a turn's spans at a collector on this machine, content,
 *   what a project's file can and cannot do, a collector that is down, the
 *   export script).
 * - What docs/forks.md, agents.md, hooks.md, mcp.md, diagnostics.md and
 *   wake-ups.md say a run prints (a fork of a fork and a fork without its
 *   original, the warnings of a session's start, a subagent's row, a refused
 *   call, a session that leaves an agent, a failing hook under `onError:
 *   "allow"`, a turn that ends with a stop hook unsatisfied, what a one-prompt
 *   run says about a project's hook and servers, a wake-up it cannot fire) is
 *   printed by such a run.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"
import { MAX_COMMAND_BYTES, MAX_COMMAND_DEPTH, MAX_COMMAND_NAME_LENGTH, commandRoots, discoverCommands } from "../../packages/core/src/commands/discover.ts"
import { expandCommand } from "../../packages/core/src/commands/lookup.ts"
import { parseConfigFile } from "../../packages/core/src/config/schema.ts"
import { DEFAULT_TELEMETRY_TIMEOUT_MS } from "../../packages/core/src/telemetry/config.ts"
import { NAMESPACE } from "../../packages/core/src/telemetry/span.ts"
import { helpText, parseArgs } from "../../packages/cli/src/args.ts"
import { BUILTIN_COMMANDS } from "../../packages/cli/src/slash.ts"
import { COMMANDS } from "../../packages/tui/src/commands.ts"

const ROOT = join(import.meta.dir, "..", "..")
const PAGES = ["docs/commands.md", "docs/telemetry.md"] as const
type Page = (typeof PAGES)[number]
const text = Object.fromEntries(PAGES.map((page) => [page, readFileSync(join(ROOT, page), "utf8")])) as Record<Page, string>
const all = Object.values(text).join("\n")
const BIN = brand.binary
const DIR = brand.directory
const SCRIPT_ENV = `${brand.envPrefix}ACP_SCRIPT`
const EXPORT_SCRIPT = "scripts/export-otel.ts"

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
/** The source as its string literals read: escapes undone. The export script is a program the telemetry page documents. */
const SOURCE_TEXT = [...sourceFiles(), join(ROOT, EXPORT_SCRIPT)]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n")
  .replace(/\\`/g, "`")
  .replace(/\\"/g, '"')
  .replace(/\\n/g, "\n")

// A throwaway home for every run: its own data and configuration directories, no sign-in, the scripted model.
const root = mkdtempSync(join(tmpdir(), "feature-docs-3-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let homes = 0

interface Home {
  readonly dir: string
  readonly work: string
  /** Writes a file below the home, making its directories. */
  readonly write: (path: string, content: string) => string
  /** The user's own configuration file. */
  readonly userConfig: (config: unknown) => void
  /** The project's configuration file. */
  readonly projectConfig: (config: unknown) => void
  /** Runs the program in the workspace with a scripted model (`responses`), or with none. */
  readonly run: (args: readonly string[], responses?: readonly unknown[][] | null, env?: Record<string, string>) => Promise<{ out: string; err: string; code: number; flat: string }>
  readonly dataDir: string
}

function home(): Home {
  const dir = join(root, `h${++homes}`)
  const work = join(dir, "work")
  mkdirSync(join(work, ".git"), { recursive: true })
  const write = (path: string, content: string) => {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    return file
  }
  let scripts = 0
  return {
    dir,
    work,
    write,
    dataDir: join(dir, "data", DIR),
    userConfig: (config) => void write(`config/${DIR}/config.json`, JSON.stringify(config)),
    projectConfig: (config) => void write(`work/.${DIR}/config.json`, JSON.stringify(config)),
    run: async (args, responses = null, env = {}) => {
      const script = responses === null ? null : write(`script-${++scripts}.json`, JSON.stringify({ responses }))
      const child = Bun.spawn([process.execPath, join(ROOT, "packages/cli/src/main.ts"), ...args], {
        cwd: work,
        env: {
          HOME: dir,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CONFIG_HOME: join(dir, "config"),
          NO_COLOR: "1",
          COLUMNS: "200",
          ...(script === null ? {} : { [SCRIPT_ENV]: script }),
          ...env,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill("SIGKILL"), 50_000)
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      clearTimeout(timer)
      // What was printed as one line: a sentence is wrapped to the terminal, and a path sits on a line of its own.
      return { out, err, code, flat: `${out}\n${err}`.replace(/\s+/g, " ") }
    },
  }
}

const say = (words: string) => [{ type: "text", text: words }]
const call = (callId: string, name: string, input: unknown) => [{ type: "tool_call", callId, name, input }]
/** The events of a `--json` run. */
const events = (out: string) =>
  out
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { type: string; sessionId?: string; data?: Record<string, unknown> })
const sessions = async (at: Home) => (await at.run(["--list-sessions"])).out.split("\n").flatMap((line) => /^(ses_[0-9a-f]+)/.exec(line)?.[1] ?? [])

describe("commands and configuration on the two pages", () => {
  test("every command is one the program or the export script accepts", () => {
    const lines = PAGES.flatMap((page) => blocks(page, "sh").flatMap((body) => body.split("\n").map((line) => line.trim()).filter((line) => line !== "")).map((line) => ({ page, line, words: words(line) })))
    expect(lines.length).toBeGreaterThanOrEqual(6)
    const usage = /const USAGE = "([^"]+)"|const USAGE = `([^`]+)`/.exec(readFileSync(join(ROOT, EXPORT_SCRIPT), "utf8"))
    const scriptOptions = new Set([...readFileSync(join(ROOT, EXPORT_SCRIPT), "utf8").matchAll(/^\s+"?([a-z-]+)"?: \{ type: "(?:string|boolean)"/gm)].map((match) => `--${match[1]}`))
    expect(usage, "the export script has a usage line").not.toBeNull()
    for (const { page, line, words: [command, ...args] } of lines) {
      const where = `${page}: ${line}`
      if (command === BIN) {
        expect(parseArgs(args).kind, where).not.toBe("error")
        continue
      }
      expect([command, args[0]], where).toEqual(["bun", EXPORT_SCRIPT])
      for (const arg of args.slice(1).filter((arg) => arg.startsWith("--"))) expect(scriptOptions, where).toContain(arg)
    }
    // Every option the telemetry page's table gives the script is one it takes, and the table leaves none out.
    const table = [...text["docs/telemetry.md"].matchAll(/^\| `(--[a-z-]+|-o)[ `]/gm)].map((match) => match[1]!)
    expect(table.toSorted()).toEqual(["--content", "--data-dir", "--endpoint", "--header", "--no-children", "-o"])
    for (const option of table) if (option !== "-o") expect(scriptOptions, option).toContain(option)
    expect(readFileSync(join(ROOT, EXPORT_SCRIPT), "utf8")).toContain('out: { type: "string", short: "o" }')
  })

  test("every --option of the program the pages name exists, and /help is a command of both interfaces", () => {
    const known = new Set([...helpText().matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((match) => match[1]!))
    // The export script's options are checked above; the commands page names none of the program's but in commands.
    const prose = text["docs/commands.md"].replace(/```json\n[\s\S]*?```/g, "")
    for (const [, flag] of prose.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) expect(known, flag).toContain(flag!)
    for (const commandsOf of [COMMANDS, BUILTIN_COMMANDS.commands()]) {
      expect(commandsOf.some((command) => command.name === "help")).toBe(true)
      expect(commandsOf.some((command) => command.name === "undo")).toBe(true)
    }
  })

  test("every json block is a valid configuration file, and each table of keys is the validator's", () => {
    const configs = PAGES.flatMap((page) => blocks(page, "json").map((body) => ({ page, body })))
    expect(configs.length).toBeGreaterThanOrEqual(3)
    for (const { page, body } of configs) expect(() => parseConfigFile(body, page), `${page}:\n${body}`).not.toThrow()
    const tableKeys = (page: Page, header: string) => {
      const start = text[page].indexOf(`| ${header} |`)
      expect(start, `${page}: ${header}`).toBeGreaterThan(-1)
      const rows = text[page].slice(start).split("\n").slice(2)
      return rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).map((row) => /^\| `([^`]+)` \|/.exec(row)?.[1])
    }
    const message = (file: string, origin: "user" | "project" = "user") => {
      try {
        parseConfigFile(file, "config.json", origin)
      } catch (error) {
        return (error as Error).message
      }
      return ""
    }
    const validatorKeys = (file: string) => /known keys: (.*)$/.exec(message(file))![1]!.split(", ")
    expect(tableKeys("docs/commands.md", "Key in `commands`")).toEqual(validatorKeys('{ "commands": { "zzz": 1 } }'))
    expect(tableKeys("docs/telemetry.md", "Key in `telemetry`")).toEqual(validatorKeys('{ "telemetry": { "zzz": 1 } }'))
    // The mistakes the telemetry page quotes.
    const telemetry = text["docs/telemetry.md"]
    const unknown = 'telemetry.endpont: unknown key "endpont"; known keys: enabled, endpoint, headers, content, timeoutMs'
    expect(telemetry).toContain(unknown)
    expect(message('{ "telemetry": { "enabled": true, "endpont": "x" } }')).toEndWith(unknown)
    const address = "telemetry.endpoint: expected an http:// or https:// URL"
    expect(telemetry).toContain(address)
    expect(message('{ "telemetry": { "endpoint": "localhost:4318" } }')).toEndWith(address)
    // The timeout's range and default.
    expect(telemetry).toContain(`100 to 120000; default ${DEFAULT_TELEMETRY_TIMEOUT_MS} |`)
    expect(message('{ "telemetry": { "timeoutMs": 99 } }')).toContain("from 100 to 120000")
    expect(message('{ "telemetry": { "timeoutMs": 120001 } }')).toContain("from 100 to 120000")
    expect(message('{ "telemetry": { "timeoutMs": 100 } }')).toBe("")
    // A project's file is read whatever it says; what it may not do is not followed (run below).
    expect(message('{ "telemetry": { "enabled": true, "endpoint": "http://localhost:4318", "content": true } }', "project")).toBe("")
  })

  test("the command directories are the ones discovery searches, in its order, and the limits are the code's", () => {
    const cwd = mkdtempSync(join(root, "roots-"))
    const page = text["docs/commands.md"]
    const roots = commandRoots({ cwd, configDir: join(cwd, "config") })
    const projectNames = roots.filter((found) => found.scope === "project").map((found) => found.dir.slice(cwd.length + 1))
    expect(projectNames[0]).toBe(`.${DIR}/commands`)
    expect(page).toContain(projectNames.map((name) => `\`${name}/\``).join(", ").replace(/, ([^,]*)$/, " and $1"))
    expect(roots.at(-1)).toEqual({ dir: join(cwd, "config", "commands"), scope: "user" })
    expect(page).toContain(`\`~/.config/${DIR}/commands/\` (\`$XDG_CONFIG_HOME/${DIR}/commands/\` when that is set)`)
    const extra = commandRoots({ cwd, configDir: join(cwd, "config"), extraPaths: ["/team"] }).map((found) => found.scope)
    expect(extra.indexOf("config")).toBeGreaterThan(extra.lastIndexOf("project"))
    expect(extra.indexOf("config")).toBeLessThan(extra.indexOf("user"))
    expect(page).toContain(`a whole name is at most ${MAX_COMMAND_NAME_LENGTH} characters`)
    expect(page).toContain(`A file is at most ${MAX_COMMAND_BYTES / 1024} KiB`)
    expect(MAX_COMMAND_DEPTH).toBe(3)
    expect(page).toContain("A file may sit up to two folders deep (`a/b/deep.md` is `/a:b:deep`)")
  })

  test("the example command files load, and the arguments table is what expansion does", () => {
    const cwd = mkdtempSync(join(root, "example-"))
    const [notes, review] = blocks("docs/commands.md", "markdown")
    const put = (path: string, content: string) => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true })
      writeFileSync(join(cwd, path), content)
    }
    put(`.${DIR}/commands/release-notes.md`, notes!)
    put(`.${DIR}/commands/review.md`, review!)
    put(`.${DIR}/commands/a/b/deep.md`, "Deep.\n")
    put(`.${DIR}/commands/a/b/c/deeper.md`, "Deeper.\n")
    put(`.${DIR}/commands/price.md`, "It costs $$5, $HOME and $ alone; all of it: $ARGUMENTS\n")
    put(`.${DIR}/commands/plain.md`, "Explain the last error.\n")
    const set = discoverCommands({ cwd, configDir: join(cwd, "config") })
    expect(set.problems).toEqual([])
    expect(set.commands.map((command) => command.name)).toEqual(["a:b:deep", "plain", "price", "release-notes", "review"])
    const named = (name: string) => set.commands.find((command) => command.name === name)!
    expect(named("release-notes")).toMatchObject({ argumentHint: "<version> [previous-version]", agent: null, derivedDescription: false })
    expect(named("review").agent).toBe("reviewer")
    expect(named("plain")).toMatchObject({ description: "Explain the last error.", derivedDescription: true })
    // $1 and $2, quotes, a missing argument, $$, any other $, $ARGUMENTS, and a text without a placeholder.
    expect(expandCommand(named("release-notes"), '"1.4 beta" 1.3').text).toContain("version 1.4 beta.\n\nLook at the commits since 1.3 (")
    expect(expandCommand(named("release-notes"), "1.4")).toMatchObject({ missing: [2] })
    expect(expandCommand(named("price"), "a  b").text).toBe("It costs $5, $HOME and $ alone; all of it: a  b")
    expect(expandCommand(named("plain"), "the build one").text).toBe("Explain the last error.\n\nArguments: the build one")
  })
})

describe("quoted program messages", () => {
  const MESSAGES: readonly { readonly page: Page; readonly quote: string; readonly pieces: readonly string[] }[] = [
    { page: "docs/commands.md", quote: "· /release-notes 1.4 1.3 · the text of a command file was sent (4 lines)", pieces: ["the text of a command file was sent"] },
    { page: "docs/commands.md", quote: "from this project:", pieces: ["from this project"] },
    { page: "docs/commands.md", quote: "⚠ argument 2 was not given: it is empty in the text that was sent", pieces: ["argument ", " not given: ", " empty in the text that was sent"] },
    {
      page: "docs/commands.md",
      quote: "⚠ !`git status` (line 1) was left as text: a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual",
      pieces: [") was left as text: ", "a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual"],
    },
    {
      page: "docs/commands.md",
      quote: "⚠ @src/app.ts (line 2) was left as text: a command file reads no file into its text; the agent can read it with its tools",
      pieces: [") was left as text: ", "a command file reads no file into its text; the agent can read it with its tools"],
    },
    {
      page: "docs/commands.md",
      quote: 'not sent: The command /ghost (<path>) runs under the agent "nobody". There is no agent named "nobody". Agents: reviewer.',
      pieces: ["not sent: ", "The command /", " runs under the agent ", "There is no agent named ", " Agents: "],
    },
    { page: "docs/commands.md", quote: "Your commands (command files: their text is sent as your message):", pieces: ["Your commands (command files: their text is sent as your message)"] },
    { page: "docs/commands.md", quote: "Command files with problems:", pieces: ["Command files with problems:"] },
    {
      page: "docs/commands.md",
      quote: "/undo: hidden: the client's built-in /undo takes the name /undo; rename the file to use it",
      pieces: ["hidden", "the client's built-in /", " takes the name /", "; rename the file to use it"],
    },
    { page: "docs/commands.md", quote: '/broken: not usable: line 3 of the front matter is not `key: value`: "no colon here"', pieces: ["not usable", " of the front matter is not `key: value`: "] },
    {
      page: "docs/commands.md",
      quote: "/relese-notes is not a command, so nothing was sent; did you mean /release-notes? (/help lists them). To send a message that starts with a slash, begin it with two: //relese-notes",
      pieces: [" is not a command, so nothing was sent; ", "did you mean /", "? (/help lists them)", " To send a message that starts with a slash, begin it with two: //"],
    },
    { page: "docs/commands.md", quote: "/broken cannot be used, so nothing was sent: line 3 of the front matter is not `key: value`", pieces: [" cannot be used, so nothing was sent: ", " of the front matter is not `key: value`"] },
    {
      page: "docs/telemetry.md",
      quote: "⚠ telemetry: Telemetry is not exported: telemetry.headers.authorization: the environment variable OTEL_TOKEN is not set.",
      pieces: ["Telemetry is not exported: ", "telemetry.headers.", "the environment variable ", " is not set"],
    },
    {
      page: "docs/telemetry.md",
      quote: "⚠ telemetry: Telemetry is not exported: telemetry is enabled but the user configuration names no endpoint.",
      pieces: ["Telemetry is not exported: ", "telemetry is enabled but the user configuration names no endpoint"],
    },
    { page: "docs/telemetry.md", quote: "ses_…: 4 spans in 1 trace(s) from 1 session(s) -> spans.jsonl (1 line(s))", pieces: [" spans in ", " trace(s) from ", " session(s)", " line(s))"] },
    { page: "docs/telemetry.md", quote: "0 sent, 4 failed", pieces: [" sent, ", " failed"] },
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
      if (rest.replace(/[\s.,:;()?`'"\[\]⚠·>-]/g, "").length > 45) problems.push(`${page}: too much of the quote is not checked (${rest.trim()})`)
    }
    expect(problems).toEqual([])
  })

  test("the pages have a Not yet section, name this file as their check, and use the brand's names", () => {
    for (const page of PAGES) {
      expect(text[page], page).toContain("\n## Not yet\n")
      expect(text[page], page).toContain("`test/release/feature-docs-3.test.ts`")
    }
    for (const [, name] of all.matchAll(/(?:~\/\.config|\$XDG_CONFIG_HOME)\/([a-z0-9][a-z0-9_-]*)\//g)) expect(name).toBe(DIR)
    for (const [, name] of all.matchAll(/(?<![\w/~])\.([a-z][a-z0-9_-]*)\/(?:config\.json|commands\/)/g)) if (!["agents", "claude"].includes(name!)) expect(name).toBe(DIR)
    const ours = /^(tui|acp|-[a-z]|--[a-z]|")/
    for (const [, span] of all.matchAll(/`([^`\n]+)`/g)) {
      const [first, second] = span!.split(/\s+/)
      if (first === undefined || second === undefined || first === "bun" || !/^[a-z][a-z0-9-]*$/.test(first)) continue
      if (ours.test(second)) expect(first, span).toBe(BIN)
    }
    // The span names and the namespace of the program's own attributes on the telemetry page.
    expect(text["docs/telemetry.md"]).toContain(`invoke_agent ${brand.name}`)
    for (const [, prefix] of text["docs/telemetry.md"].matchAll(/`([a-z]+)\.(?:execution|tool)\.[a-z_.]+`/g)) expect(prefix).toBe(NAMESPACE)
  })
})

describe("command files, run (docs/commands.md)", () => {
  const notes = blocks("docs/commands.md", "markdown")[0]!
  const project = () => {
    const at = home()
    at.write(`work/.${DIR}/commands/release-notes.md`, notes)
    at.write(`work/.${DIR}/commands/frontend/test.md`, "Run the frontend tests in packages/web with bun test $ARGUMENTS and fix what fails.\n")
    at.write(`work/.${DIR}/commands/status.md`, "Here is the status: !`git status`\nRead @src/app.ts and say what it does.\n")
    at.write(`work/.${DIR}/commands/broken.md`, "---\ndescription: broken\nno colon here\n---\nBody.\n")
    at.write(`work/.${DIR}/commands/ghost.md`, "---\ndescription: Ask someone who is not there\nagent: nobody\n---\nReview.\n")
    at.write(`work/.${DIR}/agents/reviewer.md`, "---\nname: reviewer\ndescription: Reviews.\neffects: read\n---\nReview.\n")
    return at
  }
  const sent = (out: string) => events(out).find((event) => event.type === "inbox.enqueued")!.data!.content as { text: string }[]

  test("a command's text is sent with the arguments in place, and the run says which file it came from and what was not given", async () => {
    const at = project()
    const both = await at.run(["/release-notes 1.4 1.3"], [say("Drafted.")])
    expect(both.code).toBe(0)
    expect(both.flat).toContain("· /release-notes 1.4 1.3 · the text of a command file was sent (4 lines) from this project: ")
    expect(both.flat).toContain(`.${DIR}/commands/release-notes.md`)
    expect(both.flat).not.toContain("was not given")
    const one = await at.run(["/release-notes 1.4"], [say("Drafted.")])
    expect(one.flat).toContain("⚠ argument 2 was not given: it is empty in the text that was sent")
    const json = await at.run(["--json", "/release-notes 1.4 1.3"], [say("Drafted.")])
    expect(sent(json.out)[0]!.text).toStartWith("Draft the release notes for version 1.4.\n\nLook at the commits since 1.3 (")
    expect(events(json.out).find((event) => event.type === "command.expanded")!.data).toMatchObject({ name: "release-notes", scope: "project", arguments: "1.4 1.3", missing: [] })
  }, 60_000)

  test("a namespaced name, and what is left as text on purpose", async () => {
    const at = project()
    const nested = await at.run(["--json", "/frontend:test --watch"], [say("Ran.")])
    expect(sent(nested.out)[0]!.text).toBe("Run the frontend tests in packages/web with bun test --watch and fix what fails.")
    const left = await at.run(["/status"], [say("Read.")])
    expect(left.flat).toContain("⚠ !`git status` (line 1) was left as text: a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual")
    expect(left.flat).toContain("⚠ @src/app.ts (line 2) was left as text: a command file reads no file into its text; the agent can read it with its tools")
    const json = await at.run(["--json", "/status"], [say("Read.")])
    expect(sent(json.out)[0]!.text).toBe("Here is the status: !`git status`\nRead @src/app.ts and say what it does.")
  }, 60_000)

  test("a command that names an agent that does not exist sends nothing", async () => {
    const at = project()
    const ghost = await at.run(["/ghost"], [say("Never.")])
    expect(ghost.code).toBe(2)
    expect(ghost.flat).toContain("not sent: The command /ghost")
    expect(ghost.flat).toContain('runs under the agent "nobody". There is no agent named "nobody". Agents: reviewer.')
    expect(ghost.flat).not.toContain("Never.")
  }, 60_000)

  test("a one-prompt run sends nothing for a mistyped name, an unusable file and a built-in's name, and a doubled slash sends one", async () => {
    const page = text["docs/commands.md"]
    expect(page).toContain("**No command of the program's own from a one-prompt run.**")
    const at = project()
    // The same sentences as at the prompt of an interactive session, on standard error, and the run exits with 2.
    const refused: readonly (readonly [string, string])[] = [
      ["/relese-notes 1.4", "/relese-notes is not a command, so nothing was sent; did you mean /release-notes? (/help lists them). To send a message that starts with a slash, begin it with two: //relese-notes"],
      ["/broken", '/broken cannot be used, so nothing was sent: line 3 of the front matter is not `key: value`: "no colon here".'],
      ["/undo", "/undo is a command of the interactive prompt, so nothing was sent;"],
    ]
    for (const [typed, sentence] of refused) {
      const run = await at.run(["--json", typed], [say("Never.")])
      expect(run.code, typed).toBe(2)
      expect(run.err, typed).toContain(sentence)
      expect(run.out, typed).toBe("")
    }
    const doubled = await at.run(["--json", "//etc is odd"], [say("Answered.")])
    expect(doubled.code).toBe(0)
    expect(sent(doubled.out)).toEqual([{ type: "text", text: "/etc is odd" }] as never)
    expect(events(doubled.out).some((event) => event.type === "command.expanded")).toBe(false)
    expect(page).toContain("**An argument the text does not use is not reported.**")
    const extra = await at.run(["/release-notes 1.4 1.3 extra"], [say("Drafted.")])
    expect(extra.flat).not.toMatch(/extra was|unused|not used/)
  }, 90_000)
})

describe("telemetry, run (docs/telemetry.md)", () => {
  type Attribute = { key: string; value: Record<string, unknown> }
  type Span = { name: string; traceId: string; parentSpanId?: string; attributes: Attribute[] }
  type Body = { resourceSpans: { resource: { attributes: Attribute[] }; scopeSpans: { spans: Span[] }[] }[] }
  const received: { path: string; type: string | null; authorization: string | null; body: Body }[] = []
  const collector = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ path: new URL(request.url).pathname, type: request.headers.get("content-type"), authorization: request.headers.get("authorization"), body: (await request.json()) as Body })
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  })
  afterAll(() => collector.stop(true))
  const endpoint = `http://127.0.0.1:${collector.port}`
  const spans = (bodies: readonly Body[]) => bodies.flatMap((body) => body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
  const keys = (span: Span) => span.attributes.map((attribute) => attribute.key)
  const CONTENT = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]
  const turn = [
    [...call("call_1", "read", { path: "a.ts" }), { type: "usage", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 20 }],
    [...say("a is 1."), { type: "usage", inputTokens: 1300, cachedInputTokens: 1100, outputTokens: 10 }],
  ]
  /** Runs the turn and waits for what the collector got from it. */
  const exported = async (at: Home, env: Record<string, string> = {}) => {
    at.write("work/a.ts", "export const a = 1\n")
    received.length = 0
    const run = await at.run(["what is a in a.ts?"], turn, env)
    expect(run.code, run.err).toBe(0)
    await Bun.sleep(300)
    return { run, got: [...received] }
  }

  test("on in the user's file: one trace, the four spans the page shows, to /v1/traces, without content", async () => {
    const page = text["docs/telemetry.md"]
    const at = home()
    at.userConfig({ telemetry: { enabled: true, endpoint } })
    const { run, got } = await exported(at)
    expect(run.flat).not.toContain("elemetry")
    expect(got.map((request) => [request.path, request.type])).toEqual([["/v1/traces", "application/json"]])
    const all = spans(got.map((request) => request.body))
    const model = /chat (\S+)/.exec(all.find((span) => span.name.startsWith("chat "))!.name)![1]!
    expect(all.map((span) => span.name)).toEqual([`invoke_agent ${brand.name}`, `chat ${model}`, "execute_tool read", `chat ${model}`])
    expect(new Set(all.map((span) => span.traceId)).size).toBe(1)
    expect(all.filter((span) => span.parentSpanId === undefined).map((span) => span.name)).toEqual([`invoke_agent ${brand.name}`])
    // The tree the page draws is these four, in this order.
    const drawn = blocks("docs/telemetry.md", "text")[0]!.split("\n").filter((line) => line !== "").map((line) => /^[├└─ ]*((?:invoke_agent|chat|execute_tool) \S+)/.exec(line)![1]!)
    expect(drawn).toEqual([`invoke_agent ${brand.name}`, "chat gpt-6.1-sol", "execute_tool read", "chat gpt-6.1-sol"])
    // No text of the user's, and the attributes the page names.
    for (const span of all) for (const key of CONTENT) expect(keys(span), `${span.name} ${key}`).not.toContain(key)
    expect(JSON.stringify(got)).not.toContain("what is a in a.ts")
    expect(JSON.stringify(got)).not.toContain("export const a")
    const named = [...page.matchAll(/`((?:gen_ai|[a-z]+)\.[a-z_.]+[a-z])`/g)].map((match) => match[1]!).filter((name) => !CONTENT.includes(name) && !name.startsWith("telemetry.") && !name.endsWith(".md") && !name.endsWith(".json") && !name.endsWith(".jsonl") && !name.endsWith(".ts"))
    expect(named.length).toBeGreaterThanOrEqual(6)
    const sentKeys = new Set([...all.flatMap(keys), ...got.flatMap((request) => request.body.resourceSpans.flatMap((resource) => resource.resource.attributes.map((attribute) => attribute.key)))])
    for (const name of named) expect(sentKeys, name).toContain(name)
    expect(sentKeys).toContain("host.name")
    expect(page).toContain("the machine's host name")
  }, 60_000)

  test("content adds the four attributes the page lists; a header's ${NAME} comes from the environment, and an unset one stops export with a sentence", async () => {
    const at = home()
    at.userConfig({ telemetry: { enabled: true, endpoint, content: true, headers: { authorization: "Bearer ${OTEL_TOKEN}" } } })
    const { got } = await exported(at, { OTEL_TOKEN: "synthetic-token" })
    expect(got.map((request) => request.authorization)).toEqual(["Bearer synthetic-token"])
    const all = spans(got.map((request) => request.body))
    const withKey = (key: string) => all.filter((span) => keys(span).includes(key)).map((span) => span.name.split(" ")[0])
    expect(withKey("gen_ai.input.messages")).toEqual(["invoke_agent"])
    expect(withKey("gen_ai.output.messages")).toEqual(["chat", "chat"])
    expect(withKey("gen_ai.tool.call.arguments")).toEqual(["execute_tool"])
    expect(withKey("gen_ai.tool.call.result")).toEqual(["execute_tool"])
    expect(JSON.stringify(got)).toContain("what is a in a.ts?")
    for (const key of CONTENT) expect(text["docs/telemetry.md"]).toContain(`| \`${key}\` |`)
    const unset = await exported(at)
    expect(unset.got).toEqual([])
    expect(unset.run.flat).toContain("⚠ telemetry: Telemetry is not exported: telemetry.headers.authorization: the environment variable OTEL_TOKEN is not set.")
  }, 60_000)

  test("a project's file can turn export off and nothing else; on without an address is said; a collector that is down changes nothing", async () => {
    const page = text["docs/telemetry.md"]
    expect(page).toContain("In a project's file `enabled: true`, an `endpoint` and `content` are read and not followed, without a message")
    // Off in the user's file, on in the project's: nothing is sent and nothing is said.
    const asked = home()
    asked.projectConfig({ telemetry: { enabled: true, endpoint, content: true } })
    const quiet = await exported(asked)
    expect(quiet.got).toEqual([])
    expect(quiet.run.flat).not.toContain("elemetry")
    // On in the user's file: the project cannot move the address or add content, and can turn it off.
    const moved = home()
    moved.userConfig({ telemetry: { enabled: true, endpoint } })
    moved.projectConfig({ telemetry: { endpoint: "http://127.0.0.1:9", content: true } })
    const kept = await exported(moved)
    expect(spans(kept.got.map((request) => request.body)).length).toBe(4)
    expect(JSON.stringify(kept.got)).not.toContain("gen_ai.input.messages")
    moved.projectConfig({ telemetry: { enabled: false } })
    expect((await exported(moved)).got).toEqual([])
    // On without an address.
    const nowhere = home()
    nowhere.userConfig({ telemetry: { enabled: true } })
    expect((await exported(nowhere)).run.flat).toContain("⚠ telemetry: Telemetry is not exported: telemetry is enabled but the user configuration names no endpoint.")
    // Nobody listens at the address: the turn ends as usual and nothing is said.
    const down = home()
    down.userConfig({ telemetry: { enabled: true, endpoint: "http://127.0.0.1:9", timeoutMs: 500 } })
    const ended = await exported(down)
    expect(ended.run.flat).toContain("✓ done")
    expect(ended.run.flat).not.toContain("elemetry")
  }, 120_000)

  test("the export script writes a finished session to a file and to a collector, with the exit codes the page gives", async () => {
    const at = home()
    await exported(at)
    const [id] = await sessions(at)
    const script = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, EXPORT_SCRIPT, ...args, "--data-dir", at.dataDir], { cwd: ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: at.dir, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { out, err, code }
    }
    const database = join(at.dataDir, "sessions", `${id}.db`)
    const before = readFileSync(database)
    const file = join(at.dir, "spans.jsonl")
    const written = await script(id!.slice(0, 12), "-o", file)
    expect(written.code, written.err).toBe(0)
    expect(written.err).toContain(`${id}: 4 spans in 1 trace(s) from 1 session(s) -> ${file} (1 line(s))`)
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(spans(lines.map((line) => JSON.parse(line) as Body)).length).toBe(4)
    expect(readFileSync(database).equals(before)).toBe(true)
    received.length = 0
    const posted = await script(id!, "--endpoint", endpoint)
    expect(posted.code, posted.err).toBe(0)
    expect(posted.err).toContain("4 sent, 0 failed")
    expect(spans(received.map((request) => request.body)).length).toBe(4)
    const withContent = await script(id!, "--content", "--no-children")
    expect(withContent.out).toContain("gen_ai.tool.call.result")
    const refused = await script(id!, "--endpoint", "http://127.0.0.1:9")
    expect(refused.code).toBe(4)
    expect(refused.err).toContain("0 sent, 4 failed")
    expect((await script("ses_0000")).code).toBe(1)
    expect((await script()).code).toBe(1)
    expect(text["docs/telemetry.md"]).toContain("exits with 0 when everything was\nexported, 1 for a usage error or a session that does not exist, and 4 when the collector did not take every span")
  }, 120_000)
})

describe("what the other pages say a run prints", () => {
  const page = (path: string) => readFileSync(join(ROOT, path), "utf8")

  test("docs/forks.md: a fork is forked at a point it inherited; without its original it runs, and is not forked or replayed", async () => {
    const forks = page("docs/forks.md")
    expect(forks).toContain("## A fork of a fork, and a fork without its original")
    expect(forks).not.toContain("Internal error")
    const at = home()
    expect((await at.run(["what does a.txt say"], [say("It says one.")])).code).toBe(0)
    const [original] = await sessions(at)
    expect((await at.run(["-c", "and again"], [say("It says one.")])).code).toBe(0)
    const first = JSON.parse((await at.run(["fork", "--json"])).out) as { sessionId: string }
    // At a turn the fork inherited: forked, and recorded as a fork of the session that turn belongs to.
    const inherited = await at.run(["fork", first.sessionId, "--turn", "1", "--json"])
    expect(inherited.code, inherited.err).toBe(0)
    const second = JSON.parse(inherited.out) as { sessionId: string }
    const created = await at.run(["--session", second.sessionId, "--json", "go on"], [say("Going on.")])
    expect(created.code, created.err).toBe(0)
    // The original's file is moved away.
    const store = join(at.dataDir, "sessions")
    mkdirSync(join(at.dir, "gone"))
    for (const file of readdirSync(store).filter((name) => name.startsWith(original!))) renameSync(join(store, file), join(at.dir, "gone", file))
    expect(await sessions(at)).toContain(first.sessionId)
    const message = await at.run(["--session", first.sessionId, "go on"], [say("Going on.")])
    expect(message.code, message.err).toBe(0)
    expect(message.flat).toContain("⚠ history: The part of this conversation from before the fork cannot be shown: the history inherited from session")
    expect(message.flat).toContain("is missing. The session still has it, so the model sees it and the session goes on; only what happened since the fork is listed.")
    expect(message.flat).toContain("Going on.")
    const forked = await at.run(["fork", first.sessionId])
    expect(forked.code).toBe(2)
    expect(forked.err).toContain(`${BIN}: session ${first.sessionId} cannot be forked: the history inherited from session ${original} cannot be read: `)
    const replayed = await at.run(["replay", first.sessionId], [say("Going on.")])
    expect(replayed.code).toBe(2)
    expect(replayed.err).toContain(`${BIN}: session ${first.sessionId} cannot be replayed: the history inherited from session ${original} cannot be read: `)
  }, 120_000)

  test("docs/agents.md: the warnings of a session's start, a refused call, a subagent's row, and a session that leaves an agent", async () => {
    const at = home()
    at.write(`work/.${DIR}/agents/reviewer.md`, blocks_("docs/agents.md", "markdown")[0]!)
    at.write(`work/.${DIR}/agents/docs.md`, "---\nname: docs\ndescription: Writes and edits documentation only.\ntools: read, grep, glob, edit, write, Bash\nmodel: gpt-6-luna\n---\nWrite documentation.\n")
    at.projectConfig({ agents: { default: "docs" } })
    at.write("work/math.ts", "export const add = (a, b) => a - b\n")
    const edit = call("c1", "edit", { path: "math.ts", old_string: "a - b", new_string: "a + b" })
    // The example at the top of the page, and the refusal's row.
    const reviewer = await at.run(["--agent", "reviewer", "review math.ts"], [edit, say("I could not edit.")])
    expect(reviewer.flat).toContain("⇄ working as the agent reviewer (read only) Only tools that read (effects: read).")
    expect(reviewer.flat).toContain('▸ edit math.ts ⊘ refused by the reviewer agent The agent "reviewer" may use only tools that read. "edit" changes files.')
    expect(reviewer.flat).toContain(`⚠ agents: Not followed: agents.default "docs" in the project's configuration (only the user's own configuration chooses the default agent).`)
    expect(readFileSync(join(at.work, "math.ts"), "utf8")).toContain("a - b")
    // A tool that does not exist here, said at the start of a one-prompt run; a tool its list leaves out.
    const docs = await at.run(["--agent", "docs", "list the files"], [call("c1", "shell", { command: "ls" }), say("I could not.")])
    expect(docs.flat).toContain('⚠ agents: The agent "docs" (')
    expect(docs.flat).toContain(") names a tool that does not exist here, which therefore restricts nothing: Bash.")
    expect(docs.flat).toContain('⊘ refused by the docs agent The agent "docs" may use only these tools: read, grep, glob, edit, write, Bash. "shell" is not one of them.')
    // Leaving the agent that set the model keeps the model, and says so.
    const left = await at.run(["-c", "--agent", "none", "carry on"], [say("Carrying on.")])
    expect(left.flat).toContain("⇄ no agent: the instructions and restrictions of docs no longer apply")
    expect(left.flat).toContain('⚠ agents: The session keeps the model "gpt-6-luna", which the agent "docs" set: switching the agent off does not put back what the session ran with before. Change the session\'s model or effort to use another.')
    expect((await at.run(["--list-sessions"])).out.split("\n")[0]).toContain("gpt-6-luna")
    // A subagent run as an agent: its row names the agent, and its call is refused by that agent.
    const parent = await at.run(["--approval", "full", "--agent", "none", "have a reviewer look"], [call("c1", "subagent", { task: "Review math.ts.", agent: "reviewer" }), edit, say("The subtraction is wrong."), say("Reviewed.")])
    expect(parent.code, parent.err).toBe(0)
    expect(parent.flat).toMatch(/▸ subagent ses_[0-9a-f]+ started as the agent reviewer/)
    expect(parent.flat).toContain('refused by the reviewer agent The agent "reviewer" may use only tools that read.')
    const unknown = await at.run(["--agent", "reviwer", "x"], [say("Never.")])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain(`${BIN}: There is no agent named "reviwer". Did you mean "reviewer"? Agents: docs, reviewer.`)
  }, 120_000)

  test("docs/hooks.md: a refused call's row, a failing hook under onError allow, and a turn that ends with a stop hook unsatisfied", async () => {
    const at = home()
    at.userConfig({
      hooks: {
        beforeTool: [
          { name: "no-push", tools: ["shell"], command: "case \"$" + `${brand.envPrefix}HOOK_COMMAND` + "\" in *'git push'*) echo 'Pushing is not allowed here. Commit locally and tell the user.'; exit 2;; esac" },
          { name: "watcher", tools: ["read"], command: "exit 1", onError: "allow" },
          { name: "broken", tools: ["ls"], command: "exit 1" },
        ],
        stop: [{ name: "no-scratch", command: "if [ -e SCRATCH.md ]; then echo 'SCRATCH.md still exists. Delete it before you finish.'; exit 2; fi" }],
        maxStopRounds: 2,
      },
    })
    at.write("work/a.txt", "one\n")
    at.write("work/SCRATCH.md", "")
    const run = await at.run(["do the things"], [call("c1", "shell", { command: "git push origin main" }), call("c2", "read", { path: "a.txt" }), call("c3", "ls", {}), say("All done."), say("All done again."), say("All done, third.")])
    expect(run.code, run.err).toBe(0)
    expect(run.flat).toContain('▸ shell git push origin main ⊘ refused by the hook "no-push" Pushing is not allowed here. Commit locally and tell the user.')
    expect(run.flat).toContain('⚠ hook: The hook "watcher" (before a tool call) could not answer: it exited with code 1; a hook answers with 0 or 2. The call went on without its answer, since the hook says `onError: "allow"`.')
    expect(run.flat).toContain("✓ read a.txt")
    expect(run.flat).toContain('⚠ hook: The hook "broken" (before a tool call) could not answer: it exited with code 1; a hook answers with 0 or 2. A call it must allow is refused while it fails, unless the hook says `onError: "allow"`.')
    expect(run.flat).toContain('refused: the hook "broken" must allow it and could not answer (it exited with code 1; a hook answers with 0 or 2)')
    expect(run.flat).toContain('↻ the stop hook "no-scratch" did not let the turn end · the agent is sent back with what it said')
    expect(run.flat).toContain('⚠ hook: The turn ended although the stop hook "no-scratch" still objected: the agent was sent back 2 times already, the most a turn allows.')
    expect(run.flat).toContain('⚠ ended with the stop hook "no-scratch" unsatisfied · ')
    expect(run.flat).not.toContain("✓ done")
    expect(page("docs/hooks.md")).toContain("`⚠ ended with the stop hook \"<name>\" unsatisfied · ...` in place of `✓ done · ...`")
  }, 120_000)

  test("docs/hooks.md, mcp.md, diagnostics.md: a one-prompt run says in one sentence that a project's hook and servers were not run, and how to approve them", async () => {
    const at = home()
    at.projectConfig({
      mcp: { servers: { tracker: { command: "tracker-mcp", args: ["serve"] } } },
      hooks: { beforeTool: [{ name: "no-push", tools: ["shell"], command: "exit 0" }] },
      lsp: { servers: { notes: { command: "notes-language-server", languages: { plaintext: ["**/*.txt"] } } } },
    })
    const run = await at.run(["hello"], [say("Hello.")])
    expect(run.code, run.err).toBe(0)
    expect(run.flat).toContain(`not run: 1 hook, 1 language server and 1 MCP server that this project's configuration names and you have not approved. To approve them, run \`${brand.binary}\` in this directory and answer the questions it asks; the approval is remembered for this project.`)
    // One sentence stands for the engine's own about each, which an interactive session shows and --json carries.
    expect(run.flat).not.toContain("only after you approve it")
    const json = await at.run(["--json", "-c", "again"], [say("Hello.")])
    for (const sentence of [
      `This project's configuration names the MCP server \\"tracker\\" (tracker-mcp serve). It was not started: a server a project names runs only after you approve it.`,
      `This project's configuration asks to run the hook \\"no-push\\" before a tool call (exit 0). It is not run: a hook a project names runs only after you approve it.`,
      `This project's configuration names the language server \\"notes\\" (notes-language-server). It was not started: a server a project names runs only after you approve it.`,
    ])
      expect(json.out).toContain(sentence)
    // Before a session's first message (an interactive session, not run here): what the page says, in the client's words.
    expect(page("docs/mcp.md")).toContain("**Before the first message.**")
    expect(SOURCE_TEXT).toContain("waiting for your approval: not started")
    expect(page("docs/memory.md")).toContain("A `/remember` typed then is not lost")
    expect(SOURCE_TEXT).toContain("The note is kept and saved as soon as your first message is sent (it is not saved if you leave before sending one)")
  }, 60_000)

  test("docs/wake-ups.md: a wake-up created in a one-prompt run is followed by the notice that it does not fire there", async () => {
    const at = home()
    const run = await at.run(["in a minute, remind me to look at the canary"], [call("c1", "wake_create", { message: "Look at the canary.", trigger: "after", seconds: 60 }), say("Set.")])
    expect(run.code, run.err).toBe(0)
    expect(run.flat).toContain("▸ wake_create Look at the canary.")
    expect(run.flat).toMatch(/✓ Created wake-up wk_[0-9a-f]+: after 1m \(at /)
    expect(run.flat).toMatch(/Wake-up wk_[0-9a-f]+ \(after 1m \(at [^)]+\)\) was created, but this run does not fire wake-ups: it ends with its turn\./)
    expect(run.flat).toContain(`the next time ${brand.name} runs interactively on this machine (\`${BIN}\` with no prompt, \`${BIN} tui\`, or an editor).`)
    const [id] = await sessions(at)
    expect(run.flat).toContain(`\`${BIN} --session ${id}\` opens this session: /wakeups lists it there, and /wakeups cancel wk_`)
    // It is cancelled again, so that nothing is left to fire.
    const wake = /wake-up (wk_[0-9a-f]+)/.exec(run.flat)![1]!
    expect((await at.run(["-c", "cancel it"], [call("c1", "wake_cancel", { id: wake }), say("Cancelled.")])).code).toBe(0)
  }, 60_000)
})

/** The fenced blocks of any page with the given language. */
function blocks_(path: string, language: string): string[] {
  return [...readFileSync(join(ROOT, path), "utf8").matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]!)
}
