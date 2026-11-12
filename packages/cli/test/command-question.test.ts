/**
 * The question about a command a project's configuration names (an MCP
 * server) at the line CLI's prompt, in a terminal
 * of 80 columns: the whole command is shown, wrapped and never cut, each
 * argument quoted so that its boundaries are unambiguous, and its end is on
 * the screen before the question can be answered.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { quotedCommand } from "@windlass/acp/extensions"
import { brand } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { loadConfig, loadConfigSync } from "../../core/src/config/load.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import { hardWrap, wrapWhole } from "../src/text.ts"
import { runCli } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(60_000)

const QUICK = { startWaitMs: 0, probeMs: 300, graceMs: 500, backoff: { initialMs: 200, maxMs: 400, stableMs: 60_000 }, dropAfterMs: 200 }
let root = ""
let saved: string | undefined
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-command-")))
  saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, "config")
})
afterAll(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = saved
  rmSync(root, { recursive: true, force: true })
})

let count = 0
function workspace(project: unknown): string {
  const dir = join(root, `work${++count}`)
  mkdirSync(join(dir, `.${brand.directory}`), { recursive: true })
  writeFileSync(join(dir, `.${brand.directory}`, "config.json"), JSON.stringify(project))
  return dir
}

/** One word of 190 characters and more that ends in a marker: what a command can hide where nobody looks. */
const LONG = `/opt/tools/serve\${IFS}--log\${IFS}${"a/very/long/path/".repeat(12)};echo\${IFS}TAIL-MARKER>/dev/null`
/** Text without its whitespace: a command wrapped over several rows reads as one run of characters. */
const squeezed = (text: string) => text.replace(/\s+/g, "")

async function interactive(cwd: string, provider: FakeProvider, drive: (type: (keys: string) => void, waitFor: (needle: string | RegExp) => Promise<void>, screen: () => string) => Promise<void>) {
  const vt = new VirtualTerminal(80)
  let seen = ""
  let typer: ((data: string) => void) | null = null
  const waitFor = async (needle: string | RegExp, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!(typeof needle === "string" ? seen.includes(needle) : needle.test(seen))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(needle)}; screen:\n${vt.text}`)
      await Bun.sleep(5)
    }
  }
  const running = runCli(["--cwd", cwd], {
    engine: () =>
      createAcpEngine({
        transport: "memory",
        harness: { dataDir: join(root, `data-${count}`), provider, log: () => {}, engine: { discover: () => [], mcp: QUICK, loadConfig: (dir: string) => loadConfig({ cwd: dir }), loadConfigSync: (dir: string) => loadConfigSync({ cwd: dir }) } },
        stderr: () => {},
      }),
    stdinTTY: true,
    stdoutTTY: true,
    columns: 80,
    env: { NO_COLOR: "1" },
    keys: (type) => {
      typer = type
    },
    onWrite: (text) => {
      seen += text
      vt.write(text)
    },
  })
  await waitFor("› ")
  await drive((keys) => typer!(keys), waitFor, () => vt.text)
  return running
}

describe("at 80 columns", () => {
  test("a project's MCP server: the whole command with its one long argument in quotes, its end on the screen before the answer", async () => {
    const cwd = workspace({ mcp: { servers: { theirs: { command: "bash", args: ["-c", `${LONG} and more`] } } } })
    let before = ""
    const run = await interactive(cwd, new FakeProvider([[script.text("Hello.")]]), async (type, waitFor, screen) => {
      type("hello\r")
      await waitFor('? Start the MCP server "theirs" that this project\'s configuration names?')
      await waitFor("[y] start it · [N] not now")
      // What the user has in front of them when they are asked: nothing has been answered yet.
      before = screen()
      type("n\r")
      await waitFor("not started; /mcp approve theirs asks again")
      await waitFor("✓ done")
      type("\x04")
    })
    expect(run.code).toBe(0)
    const question = before.slice(before.indexOf("? Start the MCP server"))
    // One argument, in quotes, to its last character: the marker and what follows it.
    expect(squeezed(question)).toContain(squeezed(`bash -c '${LONG} and more'`))
    expect(question).toContain("TAIL-MARKER>/dev/null and more'")
    // Nothing of the question is cut.
    expect(question).not.toContain("…")
    for (const row of question.split("\n")) expect(row.length).toBeLessThanOrEqual(80)
  })

})

describe("the words", () => {
  test("an argument is quoted when it could be read as several, or as something else than text", () => {
    expect(quotedCommand(["tracker-mcp", "--stdio"])).toBe("tracker-mcp --stdio")
    expect(quotedCommand(["bash", "-c", "a b"])).toBe("bash -c 'a b'")
    expect(quotedCommand(["sh", "-c", "echo 'hi'; rm -rf $HOME"])).toBe(`sh -c 'echo '\\''hi'\\''; rm -rf $HOME'`)
    expect(quotedCommand(["run", ""])).toBe("run ''")
  })

  test("prose wraps at words and a word wider than the row is broken, never cut; a command is broken where the row ends", () => {
    const word = "x".repeat(25)
    expect(wrapWhole(`defined in ${word} here`, 10)).toEqual(["defined in", "x".repeat(10), "x".repeat(10), "xxxxx here"])
    expect(wrapWhole(`defined in ${word} here`, 10).join("").replace(/ /g, "")).toBe(`definedin${word}here`)
    expect(hardWrap("a  b".repeat(4), 6).join("")).toBe("a  b".repeat(4))
  })
})
