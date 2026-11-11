/**
 * A child process for the crash tests: the real loop on a real store, the
 * standard tools in a temporary workspace and the scripted provider.
 *
 *   bun engine-child.ts <database> <workspace> <script> [<point> <nth>]
 *
 * It runs one prompt. With a crash point it kills itself with SIGKILL the
 * `nth` time the loop reaches that point, through the engine's injected
 * probe; without one it runs until its parent kills it.
 *
 * Scripts:
 *   normal     a read and a write in one step, a shell command, an answer
 *   retry      the first call is rate limited, so the loop waits to retry
 *   interrupt  as `normal`, and the user cancels when the first tool starts
 *   shell      one long-running shell command that records its process IDs
 */
import { join } from "node:path"
import { type ProbePoint, createEngine } from "../../../src/engine/engine.ts"
import { openSqliteStore } from "../../../src/store/sqlite.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../../src/testing/fake-provider.ts"
import { createStandardTools } from "../../../src/tools/index.ts"

const [database, workspace, name, point, nth] = process.argv.slice(2)
if (database === undefined || workspace === undefined || name === undefined) throw new Error("usage: engine-child.ts <database> <workspace> <script> [<point> <nth>]")

const normal: ScriptedResponse[] = [
  [script.text("Let me look."), script.toolCall("call_1", "read", { path: "a.txt" }), script.toolCall("call_2", "write", { path: "b.txt", content: "new\n" })],
  [script.toolCall("call_1", "shell", { command: "echo done" })],
  [script.text("All done.")],
]
const scripts: Record<string, ScriptedResponse[]> = {
  normal,
  interrupt: normal,
  retry: [[script.fail("rate_limit", { message: "Rate limit reached", status: 429, retryAfterMs: 60_000 })]],
  shell: [[script.toolCall("call_1", "shell", { command: "echo $$ > tool.pid; sleep 300 & echo $! > background.pid; wait" })]],
}
const responses = scripts[name]
if (responses === undefined) throw new Error(`no script named ${name}`)

const store = openSqliteStore({ path: database })
let reached = 0
const engine = createEngine({
  store,
  provider: new FakeProvider(responses),
  tools: createStandardTools({ spillDir: join(workspace, ".spill") }),
  dataDir: workspace,
  discover: () => [],
  log: () => {},
  hooks: {
    probe: (at: ProbePoint) => {
      if (name === "interrupt" && at === "tool.started") session.interrupt()
      if (at !== point) return
      reached += 1
      if (reached === Number(nth)) process.kill(process.pid, "SIGKILL")
    },
  },
})
const session = engine.createSession({ cwd: workspace, settings: { model: "gpt-test", reasoningEffort: null } })
session.send("Change b.txt and check it.")
await session.settled()
// Reached only when the crash point was never hit.
await engine.close()
store.close()
process.exit(3)
