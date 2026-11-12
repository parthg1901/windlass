/**
 * Subagents and background work as the loop offers them to the model: the
 * tools, their frozen texts, and what is read off a child session's log when
 * it ends. The engine (`engine.ts`) owns the sessions and the durable
 * writes; nothing here touches a store.
 *
 * The design, in short (`docs/architecture.md`, "Subagents and background work"):
 *
 * - A subagent is a real session with `lineage.kind = "spawn"`. It starts
 *   with a fresh conversation (the baseline and the task, nothing of its
 *   parent's history), runs the same loop with the same tools, and shares
 *   its parent's workspace unless it is given a git worktree.
 * - `subagent` waits for the child's answer by default; several calls in one
 *   response run side by side. With `background: true` it returns at once
 *   and the answer arrives later as a message (`subagent_result`).
 * - A command started with the shell tool's `background` argument is spawned
 *   work of the same kind: its exit arrives as a message (`background_command`).
 * - `background_output` and `background_stop` read and stop either.
 * - `subagent` takes an optional `agent`: the child then runs as that agent
 *   (`engine/agents.ts`), with its restrictions combined with its parent's.
 * - Depth: a child may itself spawn only while its depth is below the limit
 *   (one level by default), and a session at the limit is not offered the
 *   `subagent` tool at all.
 */
import { SUBAGENT_AGENT_PROPERTY } from "../agents/use.ts"
import type { StoredEvent, WorktreeRecord } from "../event/durable.ts"
import type { CallId, MessageId, SessionId } from "../id.ts"
import type { Usage } from "../provider/usage.ts"
import type { AnyTool, Tool, ToolContext, ToolResult } from "../tool/tool.ts"

export type { BackgroundCommand, BackgroundHost } from "../tool/tool.ts"
import type { MergeOutcome } from "./worktree.ts"

export const SUBAGENT_TOOL = "subagent"
export const BACKGROUND_OUTPUT_TOOL = "background_output"
export const BACKGROUND_STOP_TOOL = "background_stop"

export interface SubagentInput {
  readonly task: string
  readonly session?: string
  readonly background?: boolean
  readonly worktree?: boolean
  /** The agent the new subagent runs as, by name. Not with `session`: a subagent keeps the agent it started as. */
  readonly agent?: string
}

export interface SpawnSettings {
  /** How deep subagents may nest: 1 (the default) lets a session a person started spawn, and its children not. */
  readonly maxDepth: number
  /** Where subagents' git worktrees are made. Default `<workDir>/worktrees`, beside the data directory (which the sandbox hides). */
  readonly worktreeDir: string
}

/** The engine's side of the tools: each is carried out by the session the call belongs to. */
export interface SpawnHost {
  readonly subagent: (input: SubagentInput, context: ToolContext) => Promise<ToolResult>
  readonly output: (id: string, context: ToolContext) => Promise<ToolResult>
  readonly stop: (id: string, context: ToolContext) => Promise<ToolResult>
}

export const result = (status: ToolResult["status"], output: string, display: ToolResult["display"] = null): ToolResult => ({ status, output, truncation: null, attachments: [], display })

/** The three tools. `hostOf` finds the open session a call belongs to. */
export function spawnTools(hostOf: (sessionId: SessionId) => SpawnHost | null): { readonly subagent: AnyTool; readonly management: readonly AnyTool[] } {
  const closed = (sessionId: SessionId) => result("error", `Session ${sessionId} is not open here, so it cannot start or reach background work right now.`)
  const subagent: Tool<SubagentInput> = {
    name: SUBAGENT_TOOL,
    description:
      "Give a self-contained task to a subagent: a separate agent with the same tools and the same working directory, and a fresh conversation. It sees nothing of this conversation, only `task` and the project's instruction files, so say everything it needs: what to do, where, and what to report. Returns its final answer and its session ID. Several calls in one response run at the same time, which is the reason to use it: independent pieces of work (one per module, one per question) finish sooner, and their intermediate output stays out of this conversation. With `background` the call returns at once and the answer arrives later as a message. With `session` the text is sent as a follow-up to that earlier subagent, which still has its conversation. With `worktree` (git repositories only) it works on its own copy of the repository, and its changes are merged back when it finishes; a conflict is reported and nothing is merged.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, description: "The whole task, or the follow-up message when `session` is given." },
        session: { type: "string", minLength: 1, description: "The session ID of a subagent this session started earlier: send it `task` as a follow-up instead of starting a new one." },
        background: { type: "boolean", description: "Return at once; the answer arrives as a message when the subagent finishes." },
        worktree: { type: "boolean", description: "Give it its own git worktree, for subagents that edit the same files in parallel." },
        // The same in every session: it names no agent. Which agents exist is told in a message, and the name is checked when the call runs.
        ...SUBAGENT_AGENT_PROPERTY,
      },
      required: ["task"],
      additionalProperties: false,
    },
    // It can change files (its child can), so the step is bracketed by snapshots; its child's own calls are decided one by one.
    effect: "exec",
    delegates: true,
    execute: async (input, context) => hostOf(context.sessionId)?.subagent(input, context) ?? closed(context.sessionId),
  }
  const output: Tool<{ readonly id: string }> = {
    name: BACKGROUND_OUTPUT_TOOL,
    description:
      "Look at background work without waiting for it: for a command started with the shell tool's `background`, its output so far and whether it still runs; for a subagent, what it is doing and its latest words. `id` is the handle the start returned (or the subagent's session ID).",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
    effect: "read",
    execute: async (input, context) => hostOf(context.sessionId)?.output(input.id, context) ?? closed(context.sessionId),
  }
  const stop: Tool<{ readonly id: string }> = {
    name: BACKGROUND_STOP_TOOL,
    description: "Stop a background command or a running subagent. `id` is the handle the start returned (or the subagent's session ID). Returns what it had produced.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
    effect: "exec",
    delegates: true,
    execute: async (input, context) => hostOf(context.sessionId)?.stop(input.id, context) ?? closed(context.sessionId),
  }
  return { subagent: subagent as unknown as AnyTool, management: [output as unknown as AnyTool, stop as unknown as AnyTool] }
}

/** The frozen texts of spawned work that the loop itself writes. */
export const SPAWN_TEXT = {
  startedSubagent: (child: SessionId) =>
    `Started subagent ${child} in the background. Its answer arrives as a message when it finishes. Meanwhile \`background_output\` shows what it is doing, \`background_stop\` stops it, and \`subagent\` with \`session\` sends it a follow-up.`,
  commandLostDetail: "The harness restarted while it ran, and it was stopped with it.",
  commandLost: (id: string, command: string | null, logPath: string | null) =>
    `Background command ${id} is gone: the harness restarted while it ran, and it was stopped with it.\nCommand: ${command}${logPath === null ? "" : `\nWhat it had printed is in ${logPath}.`}`,
} as const

/** What a subagent is told besides its task: who reads its answer. */
export const SUBAGENT_NOTE =
  "(You are a subagent. Another agent gave you this task and will read only your final message, so end with a complete answer: what you did, what you found, what is left. You cannot ask it or the user a question while you work: decide what you can yourself, and say in your answer what you could not. A call that needs the user's approval may be put to the user, or refused when nobody is there to ask; either way its result tells you.)"

export function taskMessage(task: string): string {
  return `${task.trim()}\n\n${SUBAGENT_NOTE}`
}

/** A short name for a child: the first line of its task. */
export function taskTitle(task: string): string {
  const line = task.trim().split("\n")[0] ?? ""
  return line.length <= 72 ? line : `${line.slice(0, 71)}…`
}

export type SpawnOutcome = "completed" | "failed" | "stopped" | "lost"

/** What a piece of a child's work came to, read off its log. */
export interface ChildResult {
  readonly outcome: SpawnOutcome
  /** The child's final answer; empty when it never gave one. */
  readonly answer: string
  /** Why it failed or stopped, for a person. */
  readonly detail: string
  readonly steps: number
  readonly toolCalls: number
  readonly usage: Usage | null
}

export function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total
  if (total === null) return next
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  }
}

/**
 * Reads what a child did from the events of one piece of its work (from the
 * task or the follow-up on): how its last execution ended, its final answer
 * (the text of the last step that answered), and what its model calls cost.
 */
export function childResult(events: readonly StoredEvent[]): ChildResult {
  let usage: Usage | null = null
  let steps = 0
  let toolCalls = 0
  let ended: StoredEvent<"execution.succeeded" | "execution.failed" | "execution.interrupted"> | null = null
  const texts = new Map<MessageId, string[]>()
  let answer = ""
  let lastWords = ""
  for (const item of events) {
    switch (item.type) {
      case "text.ended":
        texts.set(item.data.messageId, [...(texts.get(item.data.messageId) ?? []), item.data.text])
        break
      case "tool.called":
        toolCalls += 1
        break
      case "step.ended": {
        steps += 1
        usage = addUsage(usage, item.data.usage)
        const said = (texts.get(item.data.messageId) ?? []).join("").trim()
        if (said !== "") lastWords = said
        if (item.data.finish !== "tool_calls" && said !== "") answer = said
        break
      }
      case "step.failed": {
        usage = addUsage(usage, item.data.usage)
        // What a step that was cut short had said is still what the child last said.
        const said = (texts.get(item.data.messageId) ?? []).join("").trim()
        if (said !== "") lastWords = said
        break
      }
      case "step.refused":
      case "compaction.ended":
        usage = addUsage(usage, item.data.usage)
        break
      case "execution.succeeded":
      case "execution.failed":
      case "execution.interrupted":
        ended = item
        break
      default:
        break
    }
  }
  const base = { steps, toolCalls, usage }
  if (ended === null) return { ...base, outcome: "lost", answer: lastWords, detail: "It did not finish: its work was cut off." }
  if (ended.type === "execution.succeeded") return { ...base, outcome: "completed", answer, detail: answer === "" ? "It finished without a final answer." : "It finished." }
  if (ended.type === "execution.failed") return { ...base, outcome: "failed", answer: lastWords, detail: `It failed: ${ended.data.message}` }
  return { ...base, outcome: "stopped", answer: lastWords, detail: ended.data.reason === "user" ? "It was stopped before it finished." : "It was stopped because the harness shut down." }
}

const counts = (found: ChildResult) => `${found.steps} step${found.steps === 1 ? "" : "s"}, ${found.toolCalls} tool call${found.toolCalls === 1 ? "" : "s"}`

/** The text the parent's model is given for a child's result: the answer, or plainly what went wrong, and the reference. */
export function renderChildResult(child: SessionId, found: ChildResult, merge: MergeOutcome | null, tainted: boolean): string {
  const reference = `[subagent ${child}: ${found.outcome === "completed" ? "finished" : found.outcome} after ${counts(found)}]`
  const body =
    found.outcome === "completed"
      ? found.answer === ""
        ? "The subagent finished without giving a final answer. Look at what it changed, or send it a follow-up asking for its result."
        : found.answer
      : `The subagent did not finish its task. ${found.detail}${found.answer === "" ? "" : `\n\nIts last words:\n${found.answer}`}`
  const notes = [
    ...(merge === null ? [] : [`Worktree: ${merge.message}`]),
    ...(tainted ? ["Note: its conversation holds content from a source the harness does not control, and its answer may carry that content on."] : []),
  ]
  return [body, ...notes, reference].join("\n\n")
}

/** What the model is told when a background command ends. */
export function renderCommandEnd(id: string, end: { readonly command: string; readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean; readonly stopped: string | null; readonly durationMs: number; readonly output: string; readonly logPath: string | null }): string {
  const how =
    end.stopped !== null
      ? `was stopped (${end.stopped})`
      : end.timedOut
        ? "was stopped at its time limit"
        : end.signal !== null
          ? `was killed by signal ${end.signal}`
          : `exited with code ${end.exitCode}`
  const seconds = Math.max(0, Math.round(end.durationMs / 100) / 10)
  return [
    `Background command ${id} ${how} after ${seconds} s.`,
    `Command: ${end.command}`,
    end.output.trim() === "" ? "It printed nothing." : `Output:\n${end.output.trimEnd()}`,
    ...(end.logPath === null ? [] : [`Full output: ${end.logPath}`]),
  ].join("\n")
}

export interface SpawnReference {
  readonly spawnId: string
  readonly messageId: MessageId
  readonly callId: CallId
  readonly worktree: WorktreeRecord | null
}
