/**
 * Agents over the wire: the listing, a session started as one, the switch as
 * a config option, and a call an agent's restrictions refuse.
 */
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { brand } from "@windlass/core"
import { script } from "@windlass/core/testing"
import type { AgentsResult } from "../src/extensions.ts"
import { EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

const REVIEWER = "---\nname: reviewer\ndescription: Reviews a change without editing anything.\neffects: read\n---\nYou review. You do not change files.\n"
const DOCS = "---\nname: docs\ndescription: Writes documentation only.\ntools: read, write\n---\nEdit only files under docs/.\n"
const BROKEN = "---\nname: broken\n---\nNo description here.\n"

const harnesses: Harness[] = []
const roots: string[] = []
afterEach(async () => {
  const violations = harnesses.flatMap((harness) => harness.violations)
  for (const harness of harnesses.splice(0).reverse()) await harness.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  expect(violations).toEqual([])
})

/** A server whose workspace has these agent definitions, and a client that takes the harness's events. */
async function start(agents: Record<string, string>, options: Parameters<typeof startHarness>[0] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${brand.binary}-acp-agents-`)))
  roots.push(root)
  const directory = join(root, "work", ".claude", "agents")
  mkdirSync(directory, { recursive: true })
  for (const [name, content] of Object.entries(agents)) writeFileSync(join(directory, `${name}.md`), content)
  const harness = await startHarness({
    dataDir: join(root, "data"),
    clientCapabilities: { _meta: { [META.capabilities]: { events: true } } },
    ...options,
    engine: { agents: { configDir: join(root, "config") }, ...options.engine },
  })
  harnesses.push(harness)
  await harness.initialize()
  return harness
}

const request = <T>(harness: Harness, method: string, params: Record<string, unknown>) => harness.connection.agent.request(method as never, params as never) as Promise<T>
const newAs = async (harness: Harness, agent?: string) =>
  harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], ...(agent === undefined ? {} : { _meta: { [META.capabilities]: { agent } } }) })
const agentOption = (options: readonly { id: string }[] | null | undefined) => (options ?? []).find((option) => option.id === "agent") as { currentValue: string; options: { value: string; name: string }[] } | undefined
const events = (harness: Harness, type: string) => harness.ext.filter((item) => item.method === EXT.event && (item.params.event as { type: string }).type === type).map((item) => item.params.event as { data: Record<string, unknown> })

test("the agents of a directory are listed with what they may do, and a definition that cannot be used with why", async () => {
  const harness = await start({ reviewer: REVIEWER, docs: DOCS, broken: BROKEN })
  const listed = await request<AgentsResult>(harness, EXT.agents, { cwd: harness.workspace })
  expect(listed.available).toBe(true)
  expect(listed.agents.map((agent) => [agent.name, agent.scope, agent.tag])).toEqual([
    ["docs", "project", "restricted"],
    ["reviewer", "project", "read only"],
  ])
  expect(listed.agents[1]!.restrictions).toContain("Only tools that read")
  expect(listed.agents[1]!.path).toBe(join(harness.workspace, ".claude", "agents", "reviewer.md"))
  expect(listed.problems).toHaveLength(1)
  expect(listed.problems[0]).toMatchObject({ severity: "skipped", path: join(harness.workspace, ".claude", "agents", "broken.md") })
  expect(listed.problems[0]!.reason).toContain("description")
  expect(listed.current).toBeNull()
  // Neither a session nor a directory: a bad request.
  await expect(request(harness, EXT.agents, {})).rejects.toMatchObject({ code: -32602 })
})

test("a session starts as the agent session/new names: the option, the state and the record say so; an unknown one creates nothing", async () => {
  const harness = await start({ reviewer: REVIEWER, docs: DOCS })
  const created = await newAs(harness, "reviewer")
  const option = agentOption(created.configOptions)
  expect(option?.currentValue).toBe("reviewer")
  expect(option?.options.map((choice) => choice.value)).toEqual(["none", "docs", "reviewer"])
  expect(await request<{ agent: string | null }>(harness, EXT.session, { sessionId: created.sessionId })).toMatchObject({ agent: "reviewer" })
  expect((await request<AgentsResult>(harness, EXT.agents, { sessionId: created.sessionId })).current).toBe("reviewer")
  // The record reaches a client that takes the events, with the session's first ones.
  const switched = events(harness, "agent.switched")
  expect(switched).toHaveLength(1)
  expect(switched[0]!.data).toMatchObject({ from: null, to: { name: "reviewer" } })

  // A name that is no agent: refused with the engine's sentence (it suggests the near one), and no session is made.
  const before = (await harness.connection.agent.request(methods.agent.session.list, { cwd: harness.workspace })).sessions.length
  const refused = await newAs(harness, "reviwer").then(
    () => null,
    (error: { code: number; message: string; data?: Record<string, { reason?: string }> }) => error,
  )
  expect(refused?.code).toBe(-32602)
  expect(refused?.message).toContain("reviewer")
  expect(refused?.data?.[META.capabilities]?.reason).toBe("invalid_request")
  expect((await harness.connection.agent.request(methods.agent.session.list, { cwd: harness.workspace })).sessions).toHaveLength(before)

  // Without a name and without a configured default: no agent.
  const plain = await newAs(harness)
  expect(agentOption(plain.configOptions)?.currentValue).toBe("none")
})

test("the agent option switches: the record is durable first, then config_option_update names the agent in force", async () => {
  const harness = await start({ reviewer: REVIEWER, docs: DOCS })
  const { sessionId } = await newAs(harness)
  const set = (value: string) => harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "agent", value })
  expect(agentOption((await set("docs")).configOptions)?.currentValue).toBe("docs")
  await until(() => harness.of(sessionId, "config_option_update").length === 1, 5000, "the option update after the switch")
  const update = harness.of(sessionId, "config_option_update")[0] as { configOptions: { id: string }[] }
  expect(agentOption(update.configOptions)?.currentValue).toBe("docs")
  expect(events(harness, "agent.switched").map((item) => [item.data.from, (item.data.to as { name: string } | null)?.name ?? null])).toEqual([[null, "docs"]])
  // The record is on the wire before the option update that follows from it.
  const wireIndex = (match: (message: Record<string, unknown>) => boolean) => harness.wire.findIndex(match)
  const recordAt = wireIndex((message) => message.method === EXT.event && ((message.params as { event: { type: string } }).event.type === "agent.switched"))
  const updateAt = wireIndex((message) => message.method === "session/update" && (message.params as { update: { sessionUpdate: string } }).update.sessionUpdate === "config_option_update")
  expect(recordAt).toBeGreaterThan(-1)
  expect(updateAt).toBeGreaterThan(recordAt)

  expect(agentOption((await set("none")).configOptions)?.currentValue).toBe("none")
  await until(() => events(harness, "agent.switched").length === 2, 5000, "the switch to no agent")
  // An unknown agent is refused in a sentence; the session keeps what it runs as.
  await expect(set("nobody")).rejects.toMatchObject({ code: -32602 })
  expect(await request<{ agent: string | null }>(harness, EXT.session, { sessionId })).toMatchObject({ agent: null })
})

test("a call the agent's restrictions refuse is recorded as the agent's refusal, and a loaded session is switched by its open", async () => {
  const harness = await start(
    { reviewer: REVIEWER, docs: DOCS },
    { responses: [[script.toolCall("c1", "write", { path: "note.txt", content: "x" })], [script.text("I cannot write as the reviewer.")]] },
  )
  const { sessionId } = await newAs(harness, "reviewer")
  const answer = await harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Write note.txt." }] })
  expect(answer.stopReason).toBe("end_turn")
  const denied = events(harness, "approval.denied")
  expect(denied).toHaveLength(1)
  expect(denied[0]!.data).toMatchObject({ reason: "policy", agent: "reviewer", stop: false })
  expect(await Bun.file(join(harness.workspace, "note.txt")).exists()).toBe(false)
  // For a client that shows the standard updates the call failed, with the sentence the model read.
  const settled = harness.of(sessionId, "tool_call_update").findLast((update) => (update as { status?: string }).status === "failed") as { rawOutput?: { text?: string } } | undefined
  expect(JSON.stringify(settled)).toContain('working as the agent \\"reviewer\\"')

  // Closed and opened again as another agent: the open switches it, durably.
  await harness.connection.agent.request(methods.agent.session.close, { sessionId })
  const resumed = await harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [], _meta: { [META.capabilities]: { agent: "docs" } } })
  expect(agentOption(resumed.configOptions)?.currentValue).toBe("docs")
  expect(events(harness, "agent.switched").at(-1)!.data).toMatchObject({ from: "reviewer", to: { name: "docs" } })
  await harness.connection.agent.request(methods.agent.session.close, { sessionId })
  // An agent that does not exist refuses the open, and the session is not left held here.
  await expect(harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [], _meta: { [META.capabilities]: { agent: "nobody" } } })).rejects.toMatchObject({ code: -32602 })
  await harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [] })
})
