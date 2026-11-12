/**
 * The interactive line CLI as a first-time user meets it: it says which
 * session it opened (and, resumed, its title and turns), `/help` lists the
 * commands, an unknown `/word` is not sent to the model, `//` sends a message
 * that starts with a slash, and leaving says how to come back.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { createAcpEngine } from "../src/acp-engine.ts"
import { runCli } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(30_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-interactive-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const workspace = join(root, "work")
mkdirSync(workspace)

/** One interactive run on the shared data directory; `drive` types, waiting for output first. */
async function session(provider: FakeProvider, args: readonly string[], drive: (type: (keys: string) => void, waitFor: (needle: string | RegExp) => Promise<void>) => Promise<void>) {
  const engine = () => createAcpEngine({ transport: "memory", harness: { dataDir: join(root, "data"), provider, log: () => {}, engine: { discover: () => [], loadConfig: null } }, stderr: () => {} })
  const vt = new VirtualTerminal(100)
  let seen = ""
  let typer: ((data: string) => void) | null = null
  const waitFor = async (needle: string | RegExp) => {
    const deadline = Date.now() + 10_000
    while (!(typeof needle === "string" ? seen.includes(needle) : needle.test(seen))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(needle)}; screen:\n${vt.text}`)
      await Bun.sleep(5)
    }
  }
  const running = runCli(["--cwd", workspace, ...args], {
    engine,
    stdinTTY: true,
    stdoutTTY: true,
    columns: 100,
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
  await drive((keys) => typer!(keys), waitFor)
  const result = await running
  return { ...result, screen: vt.text }
}

test("the session is named on start and on leaving; /help lists commands; an unknown /word is never sent; // sends one slash", async () => {
  const provider = new FakeProvider([[script.text("Paths under /etc are config.")]])
  const first = await session(provider, [], async (type, waitFor) => {
    await waitFor(/new session ses_\w+ · \/help lists the commands/)
    type("/help\r")
    await waitFor("/undo")
    type("/hepl\r")
    await waitFor("/hepl is not a command")
    type("/etc is where configuration lives?\r")
    await waitFor("/etc is not a command")
    type("//etc is where configuration lives?\r")
    await waitFor("✓ done")
    type("\x04")
  })
  expect(first.code).toBe(0)
  const flat = first.screen.replace(/\n\s+/g, " ")
  // The help: every command, with what it does, and the keys.
  for (const line of ["/undo", "/redo", "/diff", "/approval [ask|auto|full] (/mode)", "/clear-taint", "/queue <message>", "/help", "/exit (/quit)", "Ctrl-D on an empty prompt leaves."]) expect(flat).toContain(line)
  expect(flat).toContain("/hepl is not a command, so nothing was sent; did you mean /help? (/help lists them). To send a message that starts with a slash, begin it with two: //hepl")
  // The unknown commands cost no model call; the escaped message is the only one the model saw, with one slash.
  expect(provider.requests.length).toBe(1)
  expect(JSON.stringify(provider.requests[0]!.input)).toContain("/etc is where configuration lives?")
  expect(JSON.stringify(provider.requests[0]!.input)).not.toContain("//etc")
  const id = /new session (ses_\w+)/.exec(first.screen)![1]!
  // The last line, with the terminal's wrapping undone: it holds two IDs and the binary twice, and may not fit.
  expect(first.screen.trimEnd().replaceAll("\n", "")).toEndWith(`${brand.binary}: session ${id} · resume with: ${brand.binary} --session ${id}`)

  // Resumed: its title and how many turns it has.
  const second = await session(new FakeProvider([]), ["-c"], async (type, waitFor) => {
    await waitFor("resumed session")
    type("\x04")
  })
  expect(second.screen.replace(/\n\s+/g, " ")).toContain(`resumed session ${id} "/etc is where configuration lives?" · 1 turn · /help lists the commands`)
})
