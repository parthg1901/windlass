/**
 * Subagents over the protocol. A client that answers permission requests
 * answers for the session's subagents too: a subagent's question is a
 * `session/request_permission` on the parent session that names the
 * subagent, and the answer reaches the subagent through its parent. Every
 * durable event of a subagent is forwarded: as `child.event` inside
 * `<prefix>/event` to a client that takes the events, as `<prefix>/child`
 * to any other. Real tools, a scripted model shared by parent and child.
 */
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { script } from "@windlass/core/testing"
import { APPROVAL_META, EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness } from "./helpers.ts"

const NS = META.capabilities
/** Outside every workspace, and not under /tmp (a path beside a /tmp workspace is the session's own temp directory). */
const elsewhere = mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-acp-child-"))
afterAll(() => rmSync(elsewhere, { recursive: true, force: true }))

let h: Harness | null = null
afterEach(async () => {
  rmSync(join(elsewhere, "note.txt"), { force: true })
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

const outside = () => join(elsewhere, "note.txt")
/** The parent hands the task to a subagent; the subagent writes outside the workspace (which asks), then both answer. */
const responses = () => [
  [script.toolCall("p1", "subagent", { task: "Write the note outside\nPut it in the shared directory." })],
  [script.toolCall("w1", "write", { path: outside(), content: "note\n" })],
  [script.text("Written.")],
  [script.text("The subagent wrote it.")],
]
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const childOf = (harness: Harness, sessionId: string) => {
  const started = harness.backend.engine.readEvents(sessionId as never).find((item) => item.type === "spawn.started")
  if (started?.type !== "spawn.started" || started.data.work.kind !== "subagent") throw new Error("no subagent started")
  return { sessionId: started.data.work.sessionId as string, toolCallId: `${started.data.messageId}/${started.data.callId}` }
}

test("a subagent's question is put on the parent session, labelled with the subagent; the answer reaches the subagent and its call runs", async () => {
  h = await startHarness({ responses: responses(), onPermission: () => ({ outcome: { outcome: "selected", optionId: "once" }, _meta: { [NS]: { note: "fine" } } }) })
  await h.initialize()
  const sessionId = await h.newSession()
  expect((await prompt(h, sessionId, "Get the note written.")).stopReason).toBe("end_turn")
  const child = childOf(h, sessionId)

  expect(h.permissions).toHaveLength(1)
  const asked = h.permissions[0]!
  expect(asked.sessionId).toBe(sessionId)
  expect(asked.toolCall.title).toBe(`Subagent "Write the note outside": Allow write: writing ${outside()}?`)
  const meta = (asked._meta?.[NS] as Record<string, { subagent: unknown; messageId: string; callId: string }>)[APPROVAL_META]!
  expect(meta.subagent).toEqual({ sessionId: child.sessionId, title: "Write the note outside", spawnId: expect.any(String), toolCallId: child.toolCallId })
  // The call is the subagent's: its ID names the subagent's session, never one of the parent's calls.
  expect(asked.toolCall.toolCallId).toBe(`${child.sessionId}/${meta.messageId}/${meta.callId}`)
  const text = (asked.toolCall.content?.[0] as { content: { text: string } }).content.text
  expect(text).toContain("Asked by a subagent working on: Write the note outside")

  expect(readFileSync(outside(), "utf8")).toBe("note\n")
  const childLog = h.backend.engine.readEvents(child.sessionId as never)
  expect(childLog.flatMap((item) => (item.type === "approval.answered" ? [[item.data.choice, item.data.note]] : []))).toEqual([["once", "fine"]])
  expect(h.backend.engine.readEvents(sessionId as never).some((item) => item.type === "approval.answered")).toBe(false)

  // A client without the harness's events hears the subagent's events as <prefix>/child, with the parent's call.
  const forwarded = h.ext.filter((note) => note.method === EXT.child)
  expect(forwarded.length).toBeGreaterThan(5)
  expect(forwarded[0]!.params).toMatchObject({ sessionId, childSessionId: child.sessionId, title: "Write the note outside", toolCallId: child.toolCallId })
  const types = forwarded.map((note) => (note.params.event as { type: string }).type)
  expect(types).toContain("approval.requested")
  expect(types.at(-1)).toBe("execution.succeeded")
  // Only the subagent's own events, never wrapped twice.
  expect(forwarded.every((note) => (note.params.event as { sessionId: string }).sessionId === child.sessionId)).toBe(true)
})

test("a client that takes the events gets child.event in <prefix>/event and no <prefix>/child; a declined question is the subagent's refusal", async () => {
  h = await startHarness({ responses: responses(), clientCapabilities: { _meta: { [NS]: { events: true } } }, onPermission: () => ({ outcome: { outcome: "selected", optionId: "deny" } }) })
  await h.initialize()
  const sessionId = await h.newSession()
  await prompt(h, sessionId, "Get the note written.")
  const child = childOf(h, sessionId)
  expect(existsSync(outside())).toBe(false)
  expect(h.ext.some((note) => note.method === EXT.child)).toBe(false)
  const wrapped = h.ext.filter((note) => note.method === EXT.event && (note.params.event as { type: string }).type === "child.event")
  expect(wrapped.length).toBeGreaterThan(5)
  expect(wrapped.map((note) => (note.params.event as { event: { type: string } }).event.type)).toContain("approval.requested")
  expect(h.backend.engine.readEvents(child.sessionId as never).flatMap((item) => (item.type === "approval.answered" ? [item.data.choice] : []))).toEqual(["deny"])
})

test("nobody to ask: with attended false, or children false, the subagent's call is refused as unattended and nothing is put to the client", async () => {
  for (const meta of [{ attended: false }, { children: false }]) {
    h = await startHarness({ responses: responses(), onPermission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) })
    await h.initialize()
    const { sessionId } = await h.connection.agent.request(methods.agent.session.new, { cwd: h.workspace, mcpServers: [], _meta: { [NS]: meta } })
    await prompt(h, sessionId, "Get the note written.")
    const child = childOf(h, sessionId)
    expect(h.permissions).toEqual([])
    expect(existsSync(outside())).toBe(false)
    expect(h.backend.engine.readEvents(child.sessionId as never).flatMap((item) => (item.type === "approval.denied" ? [item.data.reason] : []))).toEqual(["unattended"])
    const violations = h.violations
    await h.close()
    h = null
    expect(violations).toEqual([])
  }
})

test("a cancel while a subagent's question waits withdraws it: the subagent's call does not start and no refusal is recorded", async () => {
  let release: (() => void) | null = null
  h = await startHarness({
    responses: responses(),
    onPermission: () =>
      new Promise((resolve) => {
        release = () => resolve({ outcome: { outcome: "cancelled" } })
      }),
  })
  await h.initialize()
  const sessionId = await h.newSession()
  const turn = prompt(h, sessionId, "Get the note written.")
  const deadline = Date.now() + 5000
  while (h.permissions.length === 0 && Date.now() < deadline) await Bun.sleep(5)
  expect(h.permissions).toHaveLength(1)
  await h.connection.agent.notify(methods.agent.session.cancel, { sessionId })
  // As a client does: the pending request is answered `cancelled` after the cancel.
  while (!h.backend.engine.readEvents(sessionId as never).some((item) => item.type === "execution.interrupt_requested")) await Bun.sleep(5)
  release!()
  expect((await turn).stopReason).toBe("cancelled")
  const child = childOf(h, sessionId)
  const log = h.backend.engine.readEvents(child.sessionId as never)
  expect(log.some((item) => item.type === "approval.answered")).toBe(false)
  expect(existsSync(outside())).toBe(false)
})
