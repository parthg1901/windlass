/**
 * A child process for the tests of several harness processes at once: the
 * real assembly (`createHarness`) on a shared data directory, the standard
 * tools, real snapshots, and a scripted model.
 *
 *   bun harness-child.ts turn <dataDir> <workspace> <label> <holdMs>
 *       one turn that writes <label>-1.txt, runs a command for holdMs, writes <label>-2.txt and answers
 *   bun harness-child.ts hang <dataDir> <workspace>
 *       a turn whose command never ends; the parent kills the process
 *   bun harness-child.ts open <dataDir> <sessionId>
 *       opens the session (recovering what a dead process left) and lets the model answer
 *   bun harness-child.ts list <dataDir>
 *       prints every session with its state
 *   bun harness-child.ts snapshots <snapshotDir> <workspace> <session> <count>
 *       takes <count> snapshots of the workspace for <session>, changing a file before each and pruning its own
 *       older ones as it goes
 *
 * `turn` and `hang` print `started <sessionId>` once the first tool runs. Every mode prints one line of JSON at its end.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHarness } from "../../../src/assembly.ts"
import { EngineError } from "../../../src/engine/engine.ts"
import type { SessionId } from "../../../src/id.ts"
import { openSnapshots } from "../../../src/snapshot/index.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../../src/testing/fake-provider.ts"

const [mode, first, second, third, fourth] = process.argv.slice(2)
if (mode === undefined || first === undefined) throw new Error("usage: harness-child.ts <mode> ...")
const print = (value: unknown) => console.log(JSON.stringify(value))
const settings = { model: "gpt-test", reasoningEffort: null }

const harness = (responses: ScriptedResponse[]) =>
  createHarness({ dataDir: first, provider: new FakeProvider(responses), log: (line) => console.error(line), engine: { loadConfig: null, discover: () => [] } })

switch (mode) {
  case "turn":
  case "hang": {
    const label = third ?? "hang"
    const command = mode === "hang" ? "sleep 300" : `sleep ${Number(fourth ?? 0) / 1000}`
    const h = harness([
      [script.toolCall("call_1", "write", { path: `${label}-1.txt`, content: `${label} one\n` })],
      [script.toolCall("call_1", "shell", { command })],
      [script.toolCall("call_1", "write", { path: `${label}-2.txt`, content: `${label} two\n` })],
      [script.text(`${label} is done.`)],
    ])
    const session = h.engine.createSession({ cwd: second!, settings })
    let announced = false
    session.subscribe((item) => {
      if (item.type !== "tool.started" || announced) return
      announced = true
      console.log(`started ${session.id}`)
    })
    session.send(`Do the work of ${label}.`)
    await session.settled()
    const events = session.readEvents()
    const end = events.at(-1)!
    print({ sessionId: session.id, end: end.type, events: events.length, requests: h.sessions.read(session.id, (store) => store.readRequests(session.id).length) })
    await h.close()
    break
  }
  case "open": {
    const h = harness([[script.text("Picked up after the restart.")]])
    try {
      const before = h.engine.getSession(second as SessionId)?.lastSeq ?? 0
      const session = h.engine.openSession(second as SessionId)
      await session.settled()
      print({ ok: true, recovered: session.readEvents({ afterSeq: before }).map((item) => item.type), execution: session.projection().session.execution })
    } catch (error) {
      print({ ok: false, code: error instanceof EngineError ? error.code : null, holderPid: error instanceof EngineError ? error.holderPid : null, message: (error as Error).message })
    }
    await h.close()
    break
  }
  case "list": {
    const h = harness([])
    print(h.engine.listSessions({ includeArchived: true }).map((summary) => ({ id: summary.session.id, cwd: summary.session.cwd, lastSeq: summary.lastSeq, execution: summary.session.execution?.status ?? null })))
    await h.close()
    break
  }
  case "snapshots": {
    const snapshots = await openSnapshots(second!, { dataDir: first })
    if (snapshots.kind !== "ready") throw new Error(snapshots.message)
    const session = third!
    const taken: string[] = []
    for (let index = 0; index < Number(fourth); index += 1) {
      writeFileSync(join(second!, `${session}.txt`), `${session} ${index}\n`)
      taken.push((await snapshots.take({ session })).id)
      // Its own retention, as the engine runs it after a turn: only this session's refs, the newest three of them.
      if (index % 2 === 1) await snapshots.prune({ session, keepLast: 3, dedupe: true })
    }
    print({ session, taken, kept: (await snapshots.list({ session })).map((ref) => ref.id) })
    break
  }
  default:
    throw new Error(`unknown mode ${mode}`)
}
process.exit(0)
