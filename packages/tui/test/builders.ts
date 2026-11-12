/** Hand-written events and listings shared by the tests of agents, the task list, `/rename`, `/compact` and the turn endings. */
import type { AgentsResult } from "@windlass/acp/extensions"
import { type AgentRecord, type CallId, type ExecutionId, type MessageId, type NewEvent, event } from "@windlass/core"

export const m = (id: string) => id as MessageId
export const c = (id: string) => id as CallId
export const x = (id: string) => id as ExecutionId
export const flat = (frame: string) => frame.replace(/\s+/g, " ")

export const REVIEWER: AgentRecord = {
  name: "reviewer",
  path: "/work/.claude/agents/reviewer.md",
  scope: "project",
  definition: "f".repeat(64),
  instructions: "You review.",
  restrictions: { effects: ["read"], tools: null, deniedTools: [], approval: null },
  model: null,
  effort: null,
}
export const AGENTS: AgentsResult = {
  available: true,
  agents: [
    { name: "docs", description: "Writes documentation only.", path: "/work/.claude/agents/docs.md", scope: "project", model: null, effort: null, restrictions: "Only these tools: read, write.", tag: "restricted" },
    { name: "reviewer", description: "Reviews a change without editing anything.", path: "/work/.claude/agents/reviewer.md", scope: "project", model: null, effort: null, restrictions: "Only tools that read (effects: read).", tag: "read only" },
  ],
  problems: [{ path: "/work/.claude/agents/broken.md", severity: "skipped", reason: "its front matter has no `description`", name: "broken" }],
  default: null,
  ignored: [],
  current: null,
}
export const started = (id = "exe_1") => event("execution.started", { executionId: x(id) })
export const step = (id: string) => [event("step.started", { messageId: m(id), attempt: 1, model: "gpt-test" }), event("step.ended", { messageId: m(id), finish: "stop", usage: null })] as const
export const succeeded = (verification: NewEvent<"execution.succeeded">["data"]["verification"], id = "exe_1") => event("execution.succeeded", { executionId: x(id), verification })
export const call = (id: string, callId: string, name: string, input: object) => event("tool.called", { messageId: m(id), callId: c(callId), name, input: JSON.stringify(input), providerData: null })
export const settle = (id: string, callId: string, outcome: "success" | "error", output: string, display: NewEvent<"tool.settled">["data"]["display"] = null) =>
  event("tool.settled", { messageId: m(id), callId: c(callId), outcome, output, truncation: null, attachments: [], display })
export type Task = { text: string; status: "pending" | "in_progress" | "done" }
export const todo = (items: readonly Task[]) => ({
  todo: { items: [...items], counts: { pending: items.filter((item) => item.status === "pending").length, in_progress: items.filter((item) => item.status === "in_progress").length, done: items.filter((item) => item.status === "done").length } },
})
export const TASKS: Task[] = [
  { text: "Read the code", status: "done" },
  { text: "Fix the bug", status: "in_progress" },
  { text: "Run the tests", status: "pending" },
]
