/**
 * A subagent at the interactive prompt, headless: the CLI in this process
 * on the ACP client with the server in memory, a scripted model shared by
 * parent and child, and keys typed into the input. The subagent's question
 * is shown in full and asked at the prompt with its label; the answer
 * reaches the subagent; its tool calls are indented lines under the call
 * that started it.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, script } from "@windlass/core/testing"
import { createAcpEngine } from "../src/acp-engine.ts"
import { runCli } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(30_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-child-")))
/** Outside every workspace, and not under /tmp (a path beside a /tmp workspace is the session's own temp directory). */
const elsewhere = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-cli-child-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

test("a subagent's question is asked at the prompt with its label, the answer reaches it, and its calls show indented", async () => {
  const workspace = join(root, "work")
  mkdirSync(workspace)
  const note = join(elsewhere, "note.txt")
  const provider = new FakeProvider([
    [script.toolCall("p1", "subagent", { task: "Write the note outside\nIn the shared directory." })],
    [script.toolCall("w1", "ls", {}), script.toolCall("w2", "write", { path: note, content: "note\n" })],
    [script.text("Written.")],
    [script.text("The subagent wrote it.")],
  ])
  const engine = () => createAcpEngine({ transport: "memory", harness: { dataDir: join(root, "data"), provider, log: () => {}, engine: { discover: () => [], loadConfig: null } }, stderr: () => {} })
  const vt = new VirtualTerminal(100)
  let seen = ""
  let typer: ((data: string) => void) | null = null
  const waitFor = async (needle: string | RegExp, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!(typeof needle === "string" ? seen.includes(needle) : needle.test(seen))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(needle)}; screen:\n${vt.text}`)
      await Bun.sleep(10)
    }
  }
  const running = runCli(["-i", "--cwd", workspace, "Get the note written."], {
    engine,
    stdinTTY: true,
    stdoutTTY: true,
    // Wide enough that the question's first line is one line also for a long temporary directory (/private/var/tmp/... on macOS).
    columns: 140,
    env: { NO_COLOR: "1" },
    keys: (type) => {
      typer = type
    },
    onWrite: (text) => {
      seen += text
      vt.write(text)
    },
  })
  await waitFor('for subagent "Write the note outside": [a]llow once')
  typer!("a\r")
  await waitFor(/done/)
  await waitFor("› ")
  typer!("/exit\r")
  const result = await running
  expect(result.code).toBe(0)
  expect(readFileSync(note, "utf8")).toBe("note\n")

  const text = result.out
  const label = /subagent (\w+) started/.exec(text)![1]!
  // The question in full, indented under the subagent: what it asks, the path verbatim, what each answer remembers.
  expect(text).toContain(`? subagent ${label} asks: Allow write: writing ${note}?`)
  expect(text).toContain(`        ${note}`)
  expect(text).toContain("remembers writes by file tools under")
  expect(text).toContain(`✓ subagent ${label}: allowed once`)
  // Each of its calls is one indented line; then the line that ends it.
  expect(text).toMatch(new RegExp(`    ↳ subagent ${label} ✓ ls \\.`))
  expect(text).toMatch(new RegExp(`    ↳ subagent ${label} ✓ write ${note.replaceAll(".", "\\.")} · created`))
  expect(text).toMatch(new RegExp(`✓ subagent ${label} finished · 2 steps, 2 tool calls`))
  expect(text).toContain("The subagent wrote it.")
  // Its answer under the call, whole words, without the reference line the parent's model gets.
  expect(text).toMatch(/  ✓ subagent answered · \S+\n    Written\.\n/)
  expect(text).not.toContain("[subagent ses_")
})
