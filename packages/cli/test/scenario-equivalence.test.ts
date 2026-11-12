/**
 * Every scripted scenario of the step loop (`@light-harness/core/testing/scenarios`,
 * the same scripts the demo plays) through the protocol: its log is stored,
 * loaded over ACP by a client that asks for the harness's events, and what
 * arrives is rendered by the CLI's own sinks. The pretty output and the
 * `--json` stream must be byte for byte what the same log gives read
 * directly from the engine. Together with `paths.test.ts`, which plays live
 * turns through both paths, this covers every event type the CLI renders.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ClientConnection, type Stream, client, methods } from "@agentclientprotocol/sdk"
import { EXT, META, type Served, serve, silentLogger } from "@light-harness/acp"
import { type Harness, type NewEvent, type SessionId, type StoredEvent, createHarness } from "@light-harness/core"
import { FakeProvider } from "@light-harness/core/testing"
import { families } from "@light-harness/core/testing/scenarios"
import type { EngineEvent } from "../src/engine.ts"
import { JsonSink } from "../src/renderer.ts"
import { render } from "./helpers.ts"

const scenarios = Object.values(families).flat()
let root = ""
let harness: Harness
let served: Served
let connection: ClientConnection
const received = new Map<string, { event: EngineEvent; replay?: boolean }[]>()

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lh-scenarios-")))
  harness = createHarness({ dataDir: join(root, "data"), provider: new FakeProvider([]), log: () => {}, engine: { loadConfig: null, discover: () => [], snapshots: null } })
  // The wire as `lh acp` has it: every message copied as JSON.
  const wire = () => new TransformStream<object, object>({ transform: (message, controller) => controller.enqueue(JSON.parse(JSON.stringify(message))) })
  const toClient = wire()
  const toAgent = wire()
  served = serve(harness, { writable: toClient.writable, readable: toAgent.readable } as unknown as Stream, { log: silentLogger })
  connection = client({ name: "equivalence" })
    .onNotification(EXT.event, (raw) => raw as { sessionId: string; event: EngineEvent; replay?: boolean }, ({ params }) => {
      received.set(params.sessionId, [...(received.get(params.sessionId) ?? []), params])
    })
    .onNotification("*", () => {})
    .connect({ writable: toAgent.writable, readable: toClient.readable } as unknown as Stream)
})

afterAll(async () => {
  connection.close()
  served.connection.close()
  await served.done
  await harness.close()
  rmSync(root, { recursive: true, force: true })
})

const json = (events: readonly EngineEvent[]) => {
  let out = ""
  const sink = new JsonSink(
    (text) => {
      out += text
    },
    () => {},
  )
  for (const item of events) sink.event(item)
  return out
}

describe("every scripted scenario, through the protocol and directly", () => {
  test("the client asks for the events", async () => {
    const init = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { _meta: { [META.capabilities]: { events: true, updates: false } } } })
    expect((init.agentCapabilities?._meta?.[META.capabilities] as { notifications: string[] }).notifications).toContain(EXT.event)
  })

  for (const [index, scenario] of scenarios.entries()) {
    test(scenario.title, async () => {
      const id = `ses_scenario${String(index).padStart(4, "0")}` as SessionId
      const events = scenario.phases.flatMap((phase) => phase.events) as NewEvent[]
      // The scenario's log, stored as a session whose process has gone: what `--session` or an editor finds.
      const store = harness.sessions.create(id)
      store.append(id, events)
      store.close()
      const direct = harness.engine.readEvents(id)
      const cwd = (events[0] as { data: { cwd: string } }).data.cwd
      await connection.agent.request(methods.agent.session.load, { sessionId: id, cwd, mcpServers: [] }).catch(() => null)
      const replayed = (received.get(id) ?? []).filter((note) => note.replay === true).map((note) => note.event)
      expect(replayed.length).toBe(direct.length)
      expect(json(replayed)).toBe(json(direct))
      expect(render(replayed)).toBe(render(direct as StoredEvent[]))
      await connection.agent.request(methods.agent.session.close, { sessionId: id }).catch(() => null)
    })
  }
})
