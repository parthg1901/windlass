import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { script } from "@windlass/core/testing"
import { EXT, META } from "../src/extensions.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

let h: Harness | null = null
afterEach(async () => {
  // Every message the agent wrote in the test validates against the SDK's schema for its method.
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

async function open(responses: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness(responses)
  await h.initialize()
  return { harness: h, sessionId: await h.newSession() }
}

function prompt(harness: Harness, sessionId: string, text: string, meta?: Record<string, unknown>) {
  return harness.connection.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
    ...(meta === undefined ? {} : { _meta: meta }),
  })
}

test("a turn with reasoning, a tool call and text streams in order and ends with end_turn", async () => {
  const { harness, sessionId } = await open({
    responses: [
      [script.reasoning("Look at the file first."), script.toolCall("call_1", "read", { path: "notes.txt", offset: 1 }), script.usage({ inputTokens: 900, cachedInputTokens: 800, outputTokens: 40, reasoningTokens: 12 })],
      [script.text("The file says hello."), script.usage({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 10 })],
    ],
  })
  await Bun.write(join(harness.workspace, "notes.txt"), "hello\nworld\n")
  const response = await prompt(harness, sessionId, "What does notes.txt say?")
  expect(response.stopReason).toBe("end_turn")

  const kinds = harness.of(sessionId).map((update) => update.sessionUpdate)
  // Reasoning, then the call (created while its arguments stream, then completed with them), then the answer.
  expect(kinds.indexOf("agent_thought_chunk")).toBeLessThan(kinds.indexOf("tool_call"))
  expect(kinds.lastIndexOf("tool_call_update")).toBeLessThan(kinds.indexOf("agent_message_chunk"))
  const thought = harness.of(sessionId, "agent_thought_chunk").map((update) => (update as { content: { text: string } }).content.text).join("")
  expect(thought).toBe("Look at the file first.")
  const text = harness.of(sessionId, "agent_message_chunk").map((update) => (update as { content: { text: string } }).content.text).join("")
  expect(text).toBe("The file says hello.")

  const created = harness.of(sessionId, "tool_call")
  expect(created).toHaveLength(1)
  const callId = (created[0] as { toolCallId: string }).toolCallId
  expect(callId).toMatch(/^msg_.+\/call_1$/)
  const calls = harness.of(sessionId).filter((update) => "toolCallId" in update && update.toolCallId === callId)
  const statuses = calls.map((update) => (update as { status?: string }).status).filter((status) => status !== undefined)
  expect(statuses).toEqual(["pending", "pending", "in_progress", "completed"])
  const described = calls.find((update) => update.sessionUpdate === "tool_call_update" && (update as { rawInput?: unknown }).rawInput !== undefined) as Record<string, unknown>
  expect(described.title).toBe("Read notes.txt")
  expect(described.kind).toBe("read")
  expect(described.rawInput).toEqual({ path: "notes.txt", offset: 1 })
  expect(described.locations).toEqual([{ path: join(harness.workspace, "notes.txt"), line: 1 }])
  const done = calls.at(-1) as Record<string, unknown>
  expect(done.content).toEqual([{ type: "content", content: { type: "text", text: "2 lines" } }])
  expect((done._meta as Record<string, unknown>)[META.outcome]).toBe("success")
  expect((done.rawOutput as { output: string }).output).toContain("hello")

  // Per-step usage with the cache counts, and the context use against the model's window.
  const usage = harness.ext.filter((note) => note.method === EXT.usage).map((note) => note.params.usage)
  expect(usage).toEqual([
    { inputTokens: 900, cachedInputTokens: 800, outputTokens: 40, reasoningTokens: 12 },
    { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 10, reasoningTokens: 0 },
  ])
  expect(harness.of(sessionId, "usage_update").at(-1)).toEqual({ sessionUpdate: "usage_update", used: 1010, size: 200_000 })
  const states = harness.ext.filter((note) => note.method === EXT.state).map((note) => [note.params.state, note.params.stopReason])
  expect(states).toEqual([["running", undefined], ["idle", "end_turn"]])
})

test("parallel tool calls in one response each get their own entity and final status", async () => {
  const { harness, sessionId } = await open({
    responses: [
      [script.toolCall("call_a", "ls", {}), script.toolCall("call_b", "glob", { pattern: "*.txt" }), script.toolCall("call_c", "shell", { command: "echo parallel" })],
      [script.text("Three things done.")],
    ],
  })
  await Bun.write(join(harness.workspace, "a.txt"), "a")
  expect((await prompt(harness, sessionId, "look around")).stopReason).toBe("end_turn")
  const created = harness.of(sessionId, "tool_call") as { toolCallId: string; kind: string }[]
  expect(created.map((call) => call.toolCallId.split("/")[1])).toEqual(["call_a", "call_b", "call_c"])
  expect(new Set(created.map((call) => call.toolCallId.split("/")[0])).size).toBe(1)
  const final = (id: string) =>
    (harness.of(sessionId).filter((update) => "toolCallId" in update && update.toolCallId === id && "rawOutput" in update).at(-1) ?? null) as Record<string, unknown> | null
  for (const call of created) expect(final(call.toolCallId)?.status).toBe("completed")
  const titles = harness.of(sessionId, "tool_call_update").flatMap((update) => ((update as { title?: string }).title === undefined ? [] : [(update as { title: string }).title]))
  expect(titles).toEqual(["List .", "Find files *.txt", "`echo parallel`"])
  const shell = final(created[2]!.toolCallId)!
  expect((shell.content as { content: { text: string } }[])[0]!.content.text).toBe("```\nparallel\n```")
  expect(created.map((call) => call.kind)).toEqual(["read", "search", "execute"])
})

test("an edit is shown as a diff of the lines it changed, at the line it changed", async () => {
  const { harness, sessionId } = await open({
    responses: [
      [script.toolCall("call_1", "edit", { path: "src/math.ts", old_string: "return a - b", new_string: "return a + b" })],
      [script.text("Fixed the sign.")],
    ],
  })
  const file = join(harness.workspace, "src", "math.ts")
  await Bun.write(file, "// math\n\nexport function add(a: number, b: number) {\n  return a - b\n}\n")
  expect((await prompt(harness, sessionId, "fix add")).stopReason).toBe("end_turn")
  expect(await Bun.file(file).text()).toContain("return a + b")
  const done = harness.of(sessionId, "tool_call_update").at(-1) as Record<string, unknown>
  expect(done.status).toBe("completed")
  expect(done.content).toEqual([
    {
      type: "diff",
      path: file,
      oldText: "// math\n\nexport function add(a: number, b: number) {\n  return a - b\n}",
      newText: "// math\n\nexport function add(a: number, b: number) {\n  return a + b\n}",
    },
  ])
  expect(done.locations).toEqual([{ path: file, line: 4 }])
  const created = harness.of(sessionId, "tool_call")[0] as Record<string, unknown>
  expect(created.kind).toBe("edit")
})

test("a new file is a diff from nothing", async () => {
  const { harness, sessionId } = await open({
    responses: [[script.toolCall("call_1", "write", { path: "hello.txt", content: "hi\n" })], [script.text("Written.")]],
  })
  expect((await prompt(harness, sessionId, "write it")).stopReason).toBe("end_turn")
  const done = harness.of(sessionId, "tool_call_update").at(-1) as Record<string, unknown>
  expect(done.content).toEqual([{ type: "diff", path: join(harness.workspace, "hello.txt"), oldText: null, newText: "hi\n" }])
})

test("a prompt sent while the session works steers it, and both prompts end with the execution", async () => {
  const { harness, sessionId } = await open({
    responses: [
      [script.toolCall("call_1", "shell", { command: "sleep 0.5; echo slow" })],
      [script.text("Done, and noted your second message.")],
    ],
  })
  const first = prompt(harness, sessionId, "run the slow thing")
  await until(() => harness.of(sessionId, "tool_call_update").some((update) => (update as { status?: string }).status === "in_progress"), 5000, "the command to start")
  let firstDone = false
  void first.then(() => (firstDone = true))
  const second = prompt(harness, sessionId, "also: be brief")
  const [a, b] = await Promise.all([first, second])
  expect(a.stopReason).toBe("end_turn")
  expect(b.stopReason).toBe("end_turn")
  expect(firstDone).toBe(true)
  // The steer reached the model in the step after the command, in the same execution.
  expect(harness.provider.requests).toHaveLength(2)
  expect(JSON.stringify(harness.provider.requests[1])).toContain("also: be brief")
  expect(harness.ext.filter((note) => note.method === EXT.state && note.params.state === "running")).toHaveLength(1)
  // The client sent both prompts itself, so neither is echoed back.
  expect(harness.of(sessionId, "user_message_chunk")).toEqual([])
})

test("the extension methods: models, steer and queue, and queue delivery on session/prompt", async () => {
  const { harness, sessionId } = await open({
    responses: [
      [script.toolCall("call_1", "shell", { command: "sleep 0.4" })],
      [script.text("First answer.")],
      [script.text("Answer to the queued message.")],
      [script.text("Answer to the meta-queued prompt.")],
    ],
  })
  const models = await harness.connection.agent.request<{ defaultModel: string; models: { id: string; efforts: string[]; contextWindow: number | null }[] }>(EXT.models, {})
  expect(models.defaultModel).toBe("test-model")
  expect(models.models.map((model) => model.id)).toEqual(["test-model", "other-model"])
  expect(models.models[0]!.efforts).toEqual(["low", "medium", "high"])

  const first = prompt(harness, sessionId, "start")
  await until(() => harness.of(sessionId, "tool_call_update").some((update) => (update as { status?: string }).status === "in_progress"), 5000, "the command to start")
  const steered = await harness.connection.agent.request<{ messageId: string }>(EXT.steer, { sessionId, prompt: [{ type: "text", text: "steered note" }] })
  const queued = await harness.connection.agent.request<{ messageId: string }>(EXT.queue, { sessionId, prompt: [{ type: "text", text: "queued follow-up" }] })
  expect(steered.messageId).toMatch(/^msg_/)
  expect(queued.messageId).toMatch(/^msg_/)
  expect((await first).stopReason).toBe("end_turn")
  // The queued message waited for the answer to the turn before it, then got its own.
  expect(harness.provider.requests).toHaveLength(3)
  expect(JSON.stringify(harness.provider.requests[1])).toContain("steered note")
  expect(JSON.stringify(harness.provider.requests[1])).not.toContain("queued follow-up")
  expect(JSON.stringify(harness.provider.requests[2])).toContain("queued follow-up")
  // Input admitted through the extensions is shown where it landed.
  const echoed = harness.of(sessionId, "user_message_chunk") as { messageId: string; content: { text: string } }[]
  expect(echoed.map((update) => [update.messageId, update.content.text])).toEqual([
    [steered.messageId, "steered note"],
    [queued.messageId, "queued follow-up"],
  ])

  expect((await prompt(harness, sessionId, "meta queued", { [META.delivery]: "queue" })).stopReason).toBe("end_turn")
  expect(JSON.stringify(harness.provider.requests[3])).toContain("meta queued")
})

test("model and effort are config options; a change is applied at the next boundary and reported", async () => {
  const { harness, sessionId } = await open({ responses: [[script.text("ok")]] })
  const changed = await harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "effort", value: "high" })
  expect(changed.configOptions.find((option) => option.id === "effort")).toMatchObject({ currentValue: "high", category: "thought_level" })
  const model = await harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "other-model" })
  // other-model takes no effort, so the effort falls back to the model's default.
  expect(model.configOptions.map((option) => [option.id, option.currentValue])).toEqual([
    ["model", "other-model"],
    ["effort", "default"],
    ["approval", "auto"],
  ])
  await expect(harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "nope" })).rejects.toMatchObject({ code: -32602 })
  await expect(harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "colour", value: "red" })).rejects.toMatchObject({ code: -32602 })
  expect((await prompt(harness, sessionId, "hi")).stopReason).toBe("end_turn")
  expect(JSON.stringify(harness.provider.requests[0])).toContain("other-model")
  const updates = harness.of(sessionId, "config_option_update") as { configOptions: { id: string; currentValue: string }[] }[]
  expect(updates.at(-1)!.configOptions.map((option) => option.currentValue)).toEqual(["other-model", "default", "auto"])
})

test("reaching the step limit ends the turn with max_turn_requests", async () => {
  const { harness, sessionId } = await open({
    engine: { limits: { stepLimit: 1 } },
    responses: [[script.toolCall("call_1", "ls", {})], [script.text("Out of steps; here is where I got to.")]],
  })
  expect((await prompt(harness, sessionId, "explore")).stopReason).toBe("max_turn_requests")
})

test("prompt content: resource links and embedded text are turned into the prompt text; images are refused", async () => {
  const { harness, sessionId } = await open({ responses: [[script.text("Seen.")]] })
  const file = join(harness.workspace, "a.ts")
  await harness.connection.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [
      { type: "text", text: "Compare these." },
      { type: "resource_link", uri: `file://${file}`, name: "a.ts" },
      { type: "resource", resource: { uri: `file://${join(harness.workspace, "b.ts")}`, text: "const b = 1\n", mimeType: "text/typescript" } },
    ],
  })
  const sent = JSON.stringify(harness.provider.requests[0])
  expect(sent).toContain(JSON.stringify(`Compare these.\n\n[file: ${file}]\n\n[file: ${join(harness.workspace, "b.ts")}]\n\`\`\`\nconst b = 1\n\`\`\``).slice(1, -1))
  await expect(
    harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
  ).rejects.toMatchObject({ code: -32602 })
  await expect(harness.connection.agent.request(methods.agent.session.prompt, { sessionId: "ses_unknown", prompt: [{ type: "text", text: "x" }] })).rejects.toMatchObject({
    code: -32002,
  })
})
