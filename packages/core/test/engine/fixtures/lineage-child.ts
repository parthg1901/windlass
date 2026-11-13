/**
 * A child process for the crash tests of forks, replays and spawned work:
 * the real assembly (`createHarness`) on a data directory, the real tools,
 * a scripted model. It kills itself with SIGKILL at a named point.
 *
 *   bun lineage-child.ts <data> <workspace> <script>
 *
 * Scripts:
 *   fork        one turn, then a fork with a copy of the workspace; dies when the copy is made and the fork's session is not
 *   replay      one recorded turn, then its replay; dies when the replay's second call has settled
 *   background  a background command and a background subagent that runs a command; dies while both run
 *   merge       a subagent in a git worktree that changes two files; dies when the merge has written the first
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createHarness } from "../../../src/assembly.ts"
import type { ProbePoint } from "../../../src/engine/engine.ts"
import type { SessionId } from "../../../src/id.ts"
import { responsesFromTape } from "../../../src/replay/fake.ts"
import { tapeFromEvents } from "../../../src/replay/tape.ts"
import type { ModelRequest } from "../../../src/request/request.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../../src/testing/fake-provider.ts"
import { waitFor } from "../../../src/testing/wait.ts"

const [data, workspace, name] = process.argv.slice(2)
if (data === undefined || workspace === undefined || name === undefined) throw new Error("usage: lineage-child.ts <data> <workspace> <script>")

const call = (tool: string, input: Record<string, unknown>, callId = "call_1") => script.toolCall(callId, tool, input as never)
const say = (value: string): ScriptedResponse => [script.text(value)]
const firstPrompt = (request: ModelRequest) => {
  const first = request.input.find((item) => item.type === "message" && item.role === "user")
  return first?.type === "message" && first.content[0]?.type === "text" ? first.content[0].text : ""
}
/** The model per conversation: a session and its subagents are told apart by their first prompt. */
function converse(scripts: Record<string, ScriptedResponse[]>): ScriptedResponse[] {
  const next: ScriptedResponse = (request, index) => {
    const key = Object.keys(scripts).find((candidate) => firstPrompt(request).startsWith(candidate))
    const response = key === undefined ? undefined : scripts[key]!.shift()
    if (response === undefined) return [script.hang()]
    return typeof response === "function" ? response(request, index) : response
  }
  return Array.from({ length: 40 }, () => next)
}

const die = () => process.kill(process.pid, "SIGKILL")
let armed = false
let reached = 0
const provider = new FakeProvider()
const harness = createHarness({
  dataDir: data,
  provider,
  log: () => {},
  engine: {
    approval: null,
    loadConfig: null,
    discover: () => [],
    hooks: {
      probe: (point: ProbePoint) => {
        if (name === "fork" && point === "fork.copied") die()
        if (name === "merge" && point === "merge.writing") die()
        if (name === "replay" && armed && point === "tool.settled" && ++reached === 2) die()
      },
    },
  },
})
const engine = harness.engine
const session = engine.createSession({ cwd: workspace, settings: { model: "gpt-test", reasoningEffort: null } })
await Bun.write(join(data, "parent.id"), session.id)

if (name === "fork") {
  provider.enqueue([call("write", { path: "b.txt", content: "new\n" })], say("Wrote b.txt."))
  session.send("Change b.txt.")
  await session.settled()
  await engine.forkSession(session.id, { workspace: { copyTo: join(data, "..", "fork-copy") } })
} else if (name === "replay") {
  provider.enqueue([call("read", { path: "a.txt" })], [call("write", { path: "b.txt", content: "new\n" })], say("Done."))
  session.send("Read a.txt and change b.txt.")
  await session.settled()
  provider.enqueue(...responsesFromTape(tapeFromEvents(session.readEvents())))
  armed = true
  const run = await engine.replaySession(session.id, { systemPrompt: "Changed." })
  await Bun.write(join(data, "replay.id"), run.session.id as SessionId)
  await run.done
} else if (name === "background") {
  provider.enqueue(
    ...converse({
      "Start both": [[call("shell", { command: "echo $$ > command.pid; exec sleep 300", background: true })], [call("subagent", { task: "Run the long job", background: true })], say("Both are running.")],
      "Run the long job": [[script.text("Starting the job."), call("shell", { command: "echo $$ > child.pid; exec sleep 300" })]],
    }),
  )
  session.send("Start both.")
  // Both run: the background command, and the subagent's own command (its call is recorded as started before it
  // runs). The parent has answered and ended its step; its execution stays open while the subagent works.
  await waitFor(
    () =>
      existsSync(join(workspace, "command.pid")) &&
      existsSync(join(workspace, "child.pid")) &&
      session.readEvents().findLastIndex((item) => item.type === "step.ended") >
        session.readEvents().findIndex((item) => item.type === "text.ended" && item.data.text === "Both are running."),
    { timeoutMs: 30_000, intervalMs: 20, what: "both to run and the parent to have answered" },
  )
  die()
} else if (name === "merge") {
  provider.enqueue(
    ...converse({
      "Fix both": [[call("subagent", { task: "Change both files", worktree: true })], say("Merged.")],
      "Change both files": [[call("write", { path: "a.txt", content: "alpha changed\n" }, "call_1"), call("write", { path: "b.txt", content: "new\n" }, "call_2")], say("Changed both.")],
    }),
  )
  session.send("Fix both files in a worktree.")
  await session.settled()
} else throw new Error(`no script named ${name}`)
// Reached only when the crash point was never hit.
await harness.close()
process.exit(3)
