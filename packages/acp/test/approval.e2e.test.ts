/**
 * Approval over the protocol: a tool call's question is a
 * `session/request_permission` the client answers, the mode is a config
 * option, nobody waits when the client says nobody is there, taint is said
 * once, and a loaded session shows an asked-and-answered call as history.
 * The real tools and the real sandbox, with a scripted model.
 */
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { createCommandSandbox } from "@windlass/core"
import { script } from "@windlass/core/testing"
import { APPROVAL_META, EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness } from "./helpers.ts"

const NS = META.capabilities
const sandboxed = createCommandSandbox().state.available

/**
 * A directory outside every workspace, and not under /tmp: the harness's
 * workspaces here are in /tmp, where a path beside the workspace means the
 * session's own temp directory (commands see nothing else of /tmp).
 */
const elsewhere = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-acp-outside-")))
afterAll(() => rmSync(elsewhere, { recursive: true, force: true }))

let h: Harness | null = null
afterEach(async () => {
  rmSync(join(elsewhere, "outside.txt"), { force: true })
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const outside = () => join(elsewhere, "outside.txt")
const writeOutside = (callId = "c1") => script.toolCall(callId, "write", { path: outside(), content: "outside\n" })

test("a call that asks is a permission request with the question's choices; the selected one is recorded and the call runs", async () => {
  h = await startHarness({ responses: [[writeOutside()], [script.text("Written.")]], onPermission: () => ({ outcome: { outcome: "selected", optionId: "once" }, _meta: { [NS]: { note: "just this one" } } }) })
  await h.initialize()
  const sessionId = await h.newSession()
  expect((await prompt(h, sessionId, "Write it.")).stopReason).toBe("end_turn")
  const [asked] = h.permissions
  expect(asked?.toolCall.title).toBe(`Allow write: writing ${outside()}?`)
  expect(asked?.options.map((option) => [option.optionId, option.kind])).toEqual([
    ["once", "allow_once"],
    ["session", "allow_always"],
    ["project", "allow_always"],
    ["deny", "reject_once"],
  ])
  expect(asked?.options[1]?.name).toBe(`Allow for this session (remembers writes by file tools under ${dirname(outside())}, for the rest of this session)`)
  const meta = (asked?._meta?.[NS] as Record<string, { question: { subject: string }; then: unknown }>)[APPROVAL_META]!
  expect(meta.question.subject).toBe(outside())
  expect(meta.then).toEqual({ kind: "run" })
  // The request names the call the client already shows.
  const calls = h.of(sessionId, "tool_call") as { toolCallId: string }[]
  expect(asked?.toolCall.toolCallId).toBe(calls[0]?.toolCallId)
  expect(readFileSync(outside(), "utf8")).toBe("outside\n")
  const events = h.backend.engine.readEvents(sessionId as never)
  expect(events.flatMap((item) => (item.type === "approval.answered" ? [[item.data.choice, item.data.approve, item.data.note]] : []))).toEqual([["once", true, "just this one"]])
  const final = (h.of(sessionId, "tool_call_update") as { rawOutput?: { output: string } }[]).find((update) => update.rawOutput !== undefined)
  expect(final?.rawOutput?.output).toStartWith("The user approved this call with a note: just this one\n\n")
})

test("a client that cancels the request, or has no answer, declines: the call does not run and the model is told", async () => {
  h = await startHarness({ responses: [[writeOutside()], [script.text("Not written.")]] })
  await h.initialize()
  const sessionId = await h.newSession()
  expect((await prompt(h, sessionId, "Write it.")).stopReason).toBe("end_turn")
  expect(h.permissions).toHaveLength(1)
  expect(existsSync(outside())).toBe(false)
  expect(JSON.stringify(h.provider.calls[1]!.request.input)).toContain("Not run: the user declined this call.")
})

test("an unattended client is never asked: the call is refused, and with `stop` the prompt is answered with approval_required", async () => {
  h = await startHarness({ responses: [[writeOutside()], [script.text("Refused.")], [writeOutside()]] })
  await h.initialize()
  const first = await h.connection.agent.request(methods.agent.session.new, { cwd: h.workspace, mcpServers: [], _meta: { [NS]: { attended: false } } })
  expect((await prompt(h, first.sessionId, "Write it.")).stopReason).toBe("end_turn")
  expect(h.permissions).toEqual([])
  expect(JSON.stringify(h.provider.calls[1]!.request.input)).toContain("this run has no one to approve it")

  const second = await h.connection.agent.request(methods.agent.session.new, { cwd: h.workspace, mcpServers: [], _meta: { [NS]: { attended: false, unattended: "stop" } } })
  await expect(prompt(h, second.sessionId, "Write it.")).rejects.toMatchObject({ code: -32603, data: { [NS]: { reason: "approval_required" } } })
  expect(h.permissions).toEqual([])
  expect(existsSync(outside())).toBe(false)
})

test("the mode is a config option and an extension request; what the client set is what decisions use", async () => {
  h = await startHarness({ responses: [[script.toolCall("c1", "write", { path: "in.txt", content: "x" })], [script.text("Done.")]], onPermission: () => ({ outcome: { outcome: "selected", optionId: "deny" } }) })
  await h.initialize()
  const created = await h.connection.agent.request(methods.agent.session.new, { cwd: h.workspace, mcpServers: [], _meta: { [NS]: { approval: "auto" } } })
  const sessionId = created.sessionId
  expect(created.configOptions?.find((option) => option.id === "approval")).toMatchObject({ currentValue: "auto", category: "mode" })
  const changed = await h.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "approval", value: "ask" })
  expect(changed.configOptions.find((option) => option.id === "approval")?.currentValue).toBe("ask")
  await expect(h.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "approval", value: "yolo" })).rejects.toMatchObject({ code: -32602 })
  const state = await h.connection.agent.request<Record<string, unknown>>(EXT.approval, { sessionId })
  expect(state).toMatchObject({ enabled: true, mode: "ask", unattended: "deny", attended: true, tainted: false, ignored: [] })
  // In `ask` an edit inside the workspace asks too.
  expect((await prompt(h, sessionId, "Write it.")).stopReason).toBe("end_turn")
  expect(h.permissions.map((request) => request.toolCall.title)).toEqual([`Allow write: writing ${join(h.workspace, "in.txt")}?`])
  expect(existsSync(join(h.workspace, "in.txt"))).toBe(false)
  await expect(h.connection.agent.request(methods.agent.session.new, { cwd: h.workspace, mcpServers: [], _meta: { [NS]: { approval: "everything" } } })).rejects.toMatchObject({ code: -32602 })
})

test.skipIf(!sandboxed)("a command runs in the sandbox; a read outside the workspace taints, the client is told once, and clearing it is a request", async () => {
  h = await startHarness({
    responses: [
      [script.toolCall("c1", "shell", { command: `echo inside > made.txt; echo x > ${elsewhere}/escaped.txt; echo $?` })],
      [script.toolCall("c1", "read", { path: join(elsewhere, "note.txt") })],
      [script.text("Done.")],
    ],
    clientCapabilities: { session: { notices: {} } },
  })
  await Bun.write(join(elsewhere, "note.txt"), "from outside\n")
  await h.initialize()
  const sessionId = await h.newSession()
  expect((await prompt(h, sessionId, "Go.")).stopReason).toBe("end_turn")
  expect(readFileSync(join(h.workspace, "made.txt"), "utf8")).toBe("inside\n")
  expect(existsSync(join(elsewhere, "escaped.txt"))).toBe(false)
  const taints = h.ext.filter((note) => note.method === EXT.taint).map((note) => note.params)
  expect(taints).toMatchObject([{ sessionId, tainted: true, source: { kind: "outside-file", tool: "read" } }])
  expect(String(taints[0]!.text)).toContain("is in this conversation and may contain instructions aimed at the model")
  expect((h.of(sessionId) as { sessionUpdate: string; title?: string }[]).filter((update) => update.sessionUpdate === "notice").map((update) => update.title)).toEqual(["Untrusted content is in this conversation"])
  expect(await h.connection.agent.request<{ cleared: boolean }>(EXT.clearTaint, { sessionId })).toEqual({ cleared: true })
  expect(await h.connection.agent.request<{ cleared: boolean }>(EXT.clearTaint, { sessionId })).toEqual({ cleared: false })
  expect(h.ext.filter((note) => note.method === EXT.taint).at(-1)?.params).toMatchObject({ tainted: false })
})

test("a loaded session replays an asked-and-answered call as history and asks nothing", async () => {
  const first = await startHarness({ responses: [[writeOutside()], [script.text("Written.")]], onPermission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) })
  await first.initialize()
  const sessionId = await first.newSession()
  await prompt(first, sessionId, "Write it.")
  await first.close({ keep: true })

  h = await startHarness({ dataDir: first.dataDir, clientCapabilities: { _meta: { [NS]: { events: true } } } })
  await h.initialize()
  await h.connection.agent.request(methods.agent.session.load, { sessionId, cwd: first.workspace, mcpServers: [] })
  expect(h.permissions).toEqual([])
  // The call is shown with its final status, as any call is.
  const finals = (h.of(sessionId, "tool_call_update") as { status?: string; rawOutput?: unknown }[]).filter((update) => update.rawOutput !== undefined)
  expect(finals.map((update) => update.status)).toEqual(["completed"])
  // A client that takes the harness's events gets the question and the answer, marked as a replay.
  const replayed = h.ext.filter((note) => note.method === EXT.event && ["approval.requested", "approval.answered"].includes((note.params.event as { type: string }).type))
  expect(replayed.map((note) => [(note.params.event as { type: string }).type, note.params.replay])).toEqual([
    ["approval.requested", true],
    ["approval.answered", true],
  ])
})
