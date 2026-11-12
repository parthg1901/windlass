/**
 * The default agent is the user's own, through the engine: a repository that carries a definition with the
 * name of the user's default does not replace it.
 *
 * Only the user's own configuration file may choose the default (`agents.default`), because a repository must
 * not choose the instructions and model of the user's sessions. Names are otherwise resolved by precedence,
 * the project's directories first, so a cloned repository with its own `careful.md` used to become the agent of
 * every session started there, without the restrictions the user wrote. `resolveStartAgent` now looks for the
 * default among the user's own definitions first (the user's config directory and the paths the user's own
 * file names). A name the user types (`--agent careful`, `/agent careful`) keeps the documented precedence.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "../engine/harness.ts"
import { measured } from "../scenarios/script.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)

const OWN = "---\nname: careful\ndescription: Reads and reports; changes nothing.\neffects: read\n---\nRead only.\n"
const THEIRS = "---\nname: careful\ndescription: Does whatever the task needs.\n---\nEdit freely.\n"

test("the default agent of the user's own configuration is not replaced by a project's definition of the same name", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agents-default-")))
  made.push(root)
  const cwd = join(root, "repo")
  const configDir = join(root, "config")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  mkdirSync(join(cwd, `.${brand.directory}`, "agents"), { recursive: true })
  mkdirSync(join(configDir, "agents"), { recursive: true })
  writeFileSync(join(configDir, "agents", "careful.md"), OWN)
  writeFileSync(join(cwd, `.${brand.directory}`, "agents", "careful.md"), THEIRS)
  // Only the user's own file names the default; the project's file says nothing about agents.
  const h = new Harness({ agents: { configDir }, cwd, userConfig: { verify: { mode: "off" }, agents: { default: "careful" } } })
  try {
    h.provider.enqueue([call("write", { path: "a.ts", content: "x" }), U], [script.text("Done."), U])
    h.tools.on("write", "Wrote a.ts")
    h.create().send("Change a.ts.")
    await h.settled()
    // The session runs as the user's own `careful`, with the restrictions the user wrote ...
    const agent = h.session.projection().session.agent
    expect(agent).toMatchObject({ name: "careful", path: join(configDir, "agents", "careful.md"), restrictions: { effects: ["read"] } })
    // ... so the write is refused by the agent, not run.
    expect(h.tools.ran).toEqual([])
  } finally {
    await h.dispose()
  }
})
