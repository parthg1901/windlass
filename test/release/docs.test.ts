/**
 * The user documentation, checked against the program so that it cannot
 * drift: README.md, docs/user-guide.md and docs/troubleshooting.md.
 *
 * - Every command in a `sh` block is parsed by the program's own parser (or
 *   the build or install script's), and the ones that need no model and no
 *   sign-in are run.
 * - Every `--option` the pages name exists in `--help` (or in the build,
 *   install or login commands).
 * - The configuration keys in the user guide are the validator's, section by
 *   section; the exit codes are the help's; every environment variable the
 *   source reads is in the user guide.
 * - The turn endings the user guide gives for each interface are the ones
 *   its source draws; the data directory's table and the work directory are
 *   the paths the program keeps; the README's table of slash commands names
 *   every command of both interfaces; the troubleshooting page's
 *   configuration error lists the validator's keys.
 * - Every name that comes from `brand` (the title, the binary, directory
 *   names, environment variable prefixes) is the brand's: a rename makes this
 *   fail until the pages say the new name.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"
import { TEST_CONTEXT_WINDOW_ENV } from "../../packages/core/src/assembly.ts"
import { parseConfigFile } from "../../packages/core/src/config/schema.ts"
import { helpText, parseArgs } from "../../packages/cli/src/args.ts"
import { BUILTIN_COMMANDS } from "../../packages/cli/src/slash.ts"
import { forkUsage, replayUsage } from "../../packages/cli/src/subcommands.ts"
import { COMMANDS } from "../../packages/tui/src/commands.ts"
import { ROOT, hostTarget, parseBuildArgs } from "../../scripts/build.ts"

const PAGES = ["README.md", "docs/user-guide.md", "docs/troubleshooting.md"] as const
const text = Object.fromEntries(PAGES.map((page) => [page, readFileSync(join(ROOT, page), "utf8")])) as Record<(typeof PAGES)[number], string>
const all = Object.values(text).join("\n")
const BIN = brand.binary
const PREFIX = brand.envPrefix

/** The commands in `sh` blocks, one per line, with the page they are on. */
const commands = PAGES.flatMap((page) =>
  [...text[page].matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((block) =>
    block[1]!
      .split("\n")
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .flatMap((line) => line.split(/\s*\|\s*/))
      .map((line) => ({ page, line, words: words(line.replace(/^([A-Z_]+=\S+\s+)+/, "")) })),
  ),
)

/** Splits a command line into words, honouring quotes; `<placeholders>` become a plain word. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => (match[1] ?? match[2] ?? match[3]!).replace(/<[^>]+>/g, "x"))
}

const installFlags = [...readFileSync(join(ROOT, "scripts/install.sh"), "utf8").matchAll(/^\s+(--[a-z-]+)(?:\|[^)]*)?\)/gm)].map((match) => match[1]!)
const buildFlags = [...readFileSync(join(ROOT, "scripts/build.ts"), "utf8").matchAll(/arg === "(--[a-z-]+)"/g)].map((match) => match[1]!)
/** The options of the main command and of the `fork` and `replay` subcommands. */
const helpFlags = [helpText(), forkUsage(), replayUsage()].flatMap((usage) => [...usage.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((match) => match[1]!))
const loginFlags = ["--no-browser"]

describe("commands in the documentation", () => {
  test("there are commands to check", () => {
    expect(commands.length).toBeGreaterThan(15)
  })

  test("every command is one the program, the build script or the install script accepts", () => {
    for (const { page, line, words: [command, ...args] } of commands) {
      const where = `${page}: ${line}`
      if (command === BIN) {
        const parsed = parseArgs(args)
        expect(parsed.kind, where).not.toBe("error")
        if (parsed.kind === "login") {
          expect(["start", "finish", "status", "logout"], where).toContain(parsed.argv[0] ?? "start")
          for (const arg of parsed.argv.slice(1)) expect(loginFlags, where).toContain(arg)
        }
        continue
      }
      if (command === "bun") {
        expect(args[0], where).toBe("scripts/build.ts")
        expect(parseBuildArgs(args.slice(1), hostTarget("linux", "x64")), where).not.toHaveProperty("error")
        continue
      }
      if (command === "sh") {
        expect(args[0], where).toBe("scripts/install.sh")
        for (const arg of args.slice(1)) expect(installFlags, where).toContain(arg)
        continue
      }
      if (command === "rm") {
        for (const path of args.filter((arg) => !arg.startsWith("-"))) expect(path, where).toContain(brand.directory)
        continue
      }
      throw new Error(`${where}: a command the documentation check does not know; add how to check it`)
    }
  })

  test("the commands that need no model and no sign-in run, from a clean home", async () => {
    const home = mkdtempSync(join(tmpdir(), "release-docs-"))
    const cwd = join(home, "work")
    mkdirSync(cwd)
    const runnable = commands.filter(({ words: [command, ...args] }) => command === BIN && (args.includes("--demo") || args.includes("--help") || args.includes("--version") || args.join(" ") === "login status") && !args.includes("tui"))
    expect(runnable.length).toBeGreaterThanOrEqual(4)
    for (const { page, line, words: [, ...args] } of runnable) {
      const demo = args.includes("--demo") && !args.includes("list")
      const child = Bun.spawn([process.execPath, join(ROOT, "packages/cli/src/main.ts"), ...args, ...(demo ? ["--demo-speed", "0"] : [])], {
        cwd,
        env: { HOME: home, PATH: "/usr/bin:/bin", XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      const expected = args[0] === "login" ? 1 : 0
      expect(code, `${page}: ${line}\n${out}`).toBe(expected)
    }
  }, 60_000)

  test("every --option the pages name exists", () => {
    const known = new Set([...helpFlags, ...buildFlags, ...installFlags, ...loginFlags])
    // A slash command's own options (`/remember [--me] <text>`) are not the program's.
    for (const page of PAGES) for (const [, flag] of text[page].replace(/`\/[a-z][^`\n]*`/g, "").matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) expect(known, `${page}: ${flag}`).toContain(flag!)
  })
})

describe("the user guide against the code", () => {
  const guide = text["docs/user-guide.md"]

  /** The keys of the table whose header starts with `header`. */
  const tableKeys = (header: string) => {
    const start = guide.indexOf(`| ${header} |`)
    expect(start, header).toBeGreaterThan(-1)
    const rows = guide.slice(start).split("\n").slice(2)
    return rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).map((row) => /^\| `([^`]+)` \|/.exec(row)?.[1])
  }

  /** The keys the validator knows at `path`, from the error an unknown key gets. */
  const validatorKeys = (file: string) => {
    try {
      parseConfigFile(file, "config.json")
    } catch (error) {
      const message = (error as Error).message
      const listed = /known keys: (.*)$/.exec(message)?.[1] ?? /a known key \(([^)]*)\)/.exec(message)?.[1]
      if (listed !== undefined) return listed.split(", ")
      throw error
    }
    throw new Error(`${file} was accepted`)
  }

  test("every configuration key, section by section", () => {
    expect(tableKeys("Key")).toEqual(validatorKeys('{ "zzz": 1 }'))
    expect(tableKeys("Key in `checks[]`")).toEqual(validatorKeys('{ "checks": [{ "zzz": 1 }] }'))
    expect(tableKeys("Key in `verify`")).toEqual(validatorKeys('{ "verify": { "zzz": 1 } }'))
    expect(tableKeys("Key in `approval`")).toEqual(validatorKeys('{ "approval": { "zzz": 1 } }'))
  })

  test("the configuration error in the troubleshooting page lists the validator's keys", () => {
    const page = text["docs/troubleshooting.md"]
    const shown = /```\n {2}✗ failed\n([\s\S]*?)```/.exec(page)![1]!.replace(/\s+/g, " ")
    expect(shown).toContain(`unknown key "chekcs" (did you mean "checks"?); known keys: ${validatorKeys('{ "chekcs": [] }').join(", ")} `)
    expect(tableKeys("Key")).toEqual(validatorKeys('{ "chekcs": [] }'))
  })

  test("the example configuration is valid", () => {
    const example = /```json\n([\s\S]*?)```/.exec(guide)![1]!
    expect(() => parseConfigFile(example, "example")).not.toThrow()
  })

  test("the exit codes are the help's", () => {
    const help = helpText()
    const fromHelp = [...help.slice(help.indexOf("Exit codes:")).matchAll(/^ {2}(\d+) {2,}/gm)].map((match) => Number(match[1]))
    const fromGuide = tableKeysPlain("Code")
    expect(fromGuide.toSorted((a, b) => a - b)).toEqual(fromHelp.toSorted((a, b) => a - b))
  })

  function tableKeysPlain(header: string): number[] {
    const start = guide.indexOf(`| ${header} |`)
    const rows = guide.slice(start).split("\n").slice(2)
    return rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).map((row) => Number(/^\| (\d+) \|/.exec(row)?.[1]))
  }

  test("every environment variable the source reads is listed", () => {
    const section = guide.slice(guide.indexOf("## Environment variables"))
    const read = new Set<string>()
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8")
      for (const [, name] of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) read.add(name!)
      for (const [, name] of source.matchAll(/\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g)) read.add(name!)
      for (const [, suffix] of source.matchAll(/_ENV = `\$\{brand\.envPrefix\}([A-Z0-9_]+)`/g)) read.add(`${PREFIX}${suffix}`)
    }
    read.add(TEST_CONTEXT_WINDOW_ENV)
    expect(read.size).toBeGreaterThan(10)
    for (const name of read) expect(section, name).toContain(`\`${name}\``)
  })
})

describe("the user guide against what the program prints and keeps", () => {
  const guide = text["docs/user-guide.md"]
  const section = (title: string) => {
    const start = guide.indexOf(`\n## ${title}\n`)
    expect(start, title).toBeGreaterThan(-1)
    const end = guide.indexOf("\n## ", start + 4)
    return guide.slice(start, end === -1 ? undefined : end)
  }
  const source = (file: string) => readFileSync(join(ROOT, file), "utf8")

  test("each interface's turn endings are worded as its source words them", () => {
    const checks = section("Verification checks")
    const line = source("packages/cli/src/renderer.ts")
    const screen = source("packages/tui/src/rows.ts")
    const leftToParent = /LEFT_TO_PARENT = "([^"]+)"/.exec(source("packages/cli/src/agents.ts"))![1]!
    // [what the page shows for the line interface, for the full-screen one], and the source text each is made of.
    const rows: readonly (readonly [string, readonly string[], string, readonly string[]])[] = [
      ["✓ done · checks passed", ['done("checks passed")'], "✓ done · checks passed", ['span("✓ ", "ok"), span("done", "ok", { bold: true }), span(" · checks passed", "ok")']],
      ["✓ done · nothing to check", ['done("nothing to check")'], "○ done · checks not needed: nothing they cover changed", ['span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · checks not needed: nothing they cover changed", "dim")']],
      ["✓ done · nothing to check", ['seg(" · nothing to check", "dim")'], "○ done · nothing to check", ['span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · nothing to check", "dim")']],
      ["✓ done · no checks configured", ['done("no checks configured")'], "○ done · no checks configured", ['span("○ ", "ok"), span("done", "ok", { bold: true }), span(" · no checks configured", "dim")']],
      [`✓ done · ${leftToParent}`, ["done(LEFT_TO_PARENT)"], `○ done · ${leftToParent}`, ['span("○ ", "ok"), span("done", "ok", { bold: true }), span(` · ${LEFT_TO_PARENT}`, "dim")']],
      ["✗ stopped with failing checks: <names>", ['seg("stopped with failing checks", ["red", "bold"])'], "✗ unresolved · failing checks: <names>", ['span("✗ ", "error"), span("unresolved", "error", { bold: true }), span(` · failing checks: ${failing}`, "error")']],
    ]
    for (const [inLine, lineSource, onScreen, screenSource] of rows) {
      expect(checks).toContain(`| \`${inLine}\``)
      expect(checks).toContain(`\`${onScreen}\``)
      for (const piece of lineSource) expect(line, piece).toContain(piece)
      for (const piece of screenSource) expect(screen, piece).toContain(piece)
    }
    // The line interface draws a done turn with the ok mark; the full-screen one with ○ unless checks passed.
    expect(line).toContain("const done = (basis: string) => this.summary([seg(`${SYMBOL.ok} `, \"green\"), seg(\"done\"")
    expect(checks).not.toContain("`✓ done · no checks configured` or `✓ done · nothing to check`")
  })

  test("the sentence about defaults is with the models, not under the task list", () => {
    const sentence = "Defaults can be set in the configuration file (`model`, `effort`; see below)."
    expect(section("Models and effort")).toContain(sentence)
    expect(section("The task list")).not.toContain("configuration file")
    expect(guide.split(sentence).length - 1).toBe(1)
  })

  test("the data directory's table names what the program keeps there, and the work directory beside it", () => {
    const data = section("The data directory")
    const paths = (header: string) => {
      const start = data.indexOf(`| ${header} |`)
      expect(start, header).toBeGreaterThan(-1)
      const rows = data.slice(start).split("\n").slice(2)
      return rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).flatMap((row) => [.../`([^`]+)`/g[Symbol.matchAll](row.split("|")[1]!)].map((match) => match[1]!))
    }
    expect(paths("Path")).toEqual(["auth.json", "auth.lock", "host-id", "sessions/", "index.db", "snapshots/", "approvals/", "blobs/", "spill/", "wake/", "memory/"])
    // Each is a name the source gives a file or directory of the data directory.
    const all = sourceFiles().map((file) => readFileSync(file, "utf8")).join("\n")
    for (const name of paths("Path")) expect(all, name).toContain(`"${name.replace(/\/$/, "")}"`)
    // The work directory: `<data directory>-work`, with one directory per kind of work the program makes a place for.
    expect(data).toContain(`\`~/.local/share/${brand.directory}-work\` (\`$XDG_DATA_HOME/${brand.directory}-work\`)`)
    expect(all).toContain('`${options.dataDir.replace(/\\/+$/, "")}-work`')
    expect(paths("Path in the work directory")).toEqual(["workspaces/", "worktrees/", "replays/"])
    for (const name of paths("Path in the work directory")) expect(all, name).toMatch(new RegExp(`join\\((core\\.)?workDir, "${name.replace(/\/$/, "")}"`))
    // Deleting everything takes the work directory too.
    const remove = commands.find(({ words: [command] }) => command === "rm")!
    expect(remove.words).toContain(`~/.local/share/${brand.directory}-work`)
    expect(remove.words).toContain(`~/.local/share/${brand.directory}`)
  })
})

describe("the README's table of slash commands", () => {
  const readme = text["README.md"]
  const start = readme.indexOf("| Command | Line interface")
  const rows = readme.slice(start).split("\n").slice(2)
  const table = rows.slice(0, rows.findIndex((row) => !row.startsWith("|"))).map((row) => row.replace(/\\\|/g, "/").split("|").map((cell) => cell.trim()))
  /** The commands a row names, and whether the row says each interface has them. */
  const named = table.flatMap(([, commandCell, lineCell, screenCell]) =>
    [...commandCell!.matchAll(/`\/([a-z][a-z-]*)/g)].map((match) => ({ name: match[1]!, inLine: lineCell !== "" && !lineCell!.includes("instead"), onScreen: screenCell !== "" })),
  )

  test("it names every command of both interfaces, and says rightly which interface has each", () => {
    const line = new Map(BUILTIN_COMMANDS.commands().flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => [name, command.name] as const)))
    const screen = new Map(COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => [name, command.name] as const)))
    expect(named.length).toBeGreaterThan(20)
    for (const { name, inLine, onScreen } of named) {
      expect(line.has(name), `/${name} in the line interface`).toBe(inLine)
      expect(screen.has(name), `/${name} in the full-screen interface`).toBe(onScreen)
    }
    // Every command is in the table under its own name or an alias.
    const inTable = new Set(named.map((entry) => entry.name))
    for (const command of BUILTIN_COMMANDS.commands()) expect([command.name, ...(command.aliases ?? [])].some((name) => inTable.has(name)), `/${command.name} (line interface)`).toBe(true)
    for (const command of COMMANDS) expect([command.name, ...(command.aliases ?? [])].some((name) => inTable.has(name)), `/${command.name} (full-screen)`).toBe(true)
  })
})

describe("names from the brand", () => {
  test("the README's title is the product's name", () => {
    expect(text["README.md"].split("\n")[0]).toBe(`# ${brand.name}`)
  })

  test("the README names each alias of the binary", () => {
    for (const alias of brand.aliases) expect(text["README.md"]).toContain(`\`${alias}\``)
  })

  test("directories are the brand's", () => {
    // The data and configuration directories, and the work directory beside the data directory (`<name>-work`).
    for (const [, name] of all.matchAll(/(?:~\/\.local\/share|~\/\.config|\$XDG_DATA_HOME|\$XDG_CONFIG_HOME)\/([a-z0-9][a-z0-9_-]*)/g)) expect(name!.replace(/-work$/, "")).toBe(brand.directory)
    for (const [, where] of all.matchAll(/(~\/\.config|\$XDG_CONFIG_HOME)\/[a-z0-9_]+-work/g)) throw new Error(`the work directory is beside the data directory, not under ${where}`)
    for (const [, name] of all.matchAll(/(?<![\w/])\.([a-z][a-z0-9_-]*)\/(?:config\.json)?(?![\w.])/g)) if (name !== "local" && name !== "config") expect(name).toBe(brand.directory)
    for (const [, name] of all.matchAll(/\/tmp\/([a-z][a-z0-9_-]*)-(?:<uid>|\$\(id -u\))/g)) expect(name).toBe(brand.directory)
  })

  test("the binary's name in commands, inline code and environment variables", () => {
    const ours = /^(login|tui|acp|-[a-z]|--[a-z])/
    const others = new Set(["bun", "sh", "git", "curl", "sudo", "rm", "kill", "apt", "env", "bash", "test"])
    for (const [, span] of all.matchAll(/`([^`\n]+)`/g)) {
      const [first, second] = span!.split(/\s+/)
      if (first === undefined || second === undefined || others.has(first) || !/^[a-z][a-z0-9-]*$/.test(first)) continue
      if (ours.test(second)) expect(first, span).toBe(BIN)
    }
    for (const [, prefix] of all.matchAll(/\b([A-Z][A-Z0-9]*)_(?:TUI|TUI_DEBUG|ACP_LOG|ACP_SCRIPT|DEMO_TRACE|ENGINE_START_TIMEOUT_MS)\b/g)) expect(`${prefix}_`).toBe(PREFIX)
    for (const [name] of all.matchAll(/\b[A-Z][A-Z0-9_]*_TEST_CONTEXT_WINDOW\b/g)) expect(name).toBe(TEST_CONTEXT_WINDOW_ENV)
  })
})

function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry)
      if (entry === "node_modules") return []
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : []
    })
  return readdirSync(join(ROOT, "packages")).flatMap((pkg) => walk(join(ROOT, "packages", pkg, "src")))
}
