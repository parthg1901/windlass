/**
 * What the terminal clients say about agents, the model's task list, a
 * compaction the user asked for and a turn's model requests. Pure: both the
 * line CLI and the full-screen interface render these words, so they say the
 * same things.
 */
import type { AgentsResult, CompactResult, TaskItem } from "@windlass/acp/extensions"
import { type AgentRecord, type Json, describeRestrictions, restrictionTag } from "@windlass/core"
import { type Line, type LineTone, pathLine } from "./features.ts"
import { plural } from "./text.ts"

const line = (text: string, tone: LineTone = "plain", indent = 0): Line => ({ text, tone, indent })

/** The name of the tool the model keeps its task list with (`TODO_TOOL_NAME` in the engine). */
export const TASK_TOOL = "todo"

/**
 * What a call's row says when the restrictions of the agent the session
 * runs as refused it: that it was refused and by whom, and under it why, in
 * the engine's own sentence about the agent's rule (`refusal.text` of
 * `approval.denied`: `The agent "reviewer" may use only tools that read.
 * "write" changes files.`). Nothing is worked out here from the tool's
 * name. The same shape as a hook's refusal, so both read as what they are:
 * a call somebody did not let run, never a failure.
 */
export function agentRefused(agent: string, refusal: { readonly text: string }): { readonly head: string; readonly reason: string } {
  return { head: `refused by the ${agent} agent`, reason: refusal.text }
}

/** The switch of the agent a session runs as, for the transcript: the line, and what the new agent may do. */
export function agentSwitchText(from: string | null, to: AgentRecord | null): { readonly head: string; readonly detail: string | null } {
  if (to === null) return { head: from === null ? "no agent" : `no agent: the instructions and restrictions of ${from} no longer apply`, detail: null }
  const tag = restrictionTag(to.restrictions)
  const what = `${to.name}${tag === null ? "" : ` (${tag})`}`
  const head = from === null ? `working as the agent ${what}` : from === to.name ? `the agent ${what} was selected again with its changed definition` : `agent ${from} → ${what}`
  return { head, detail: tag === null ? null : describeRestrictions(to.restrictions) }
}

/** `/agent` without a name: the agents, which one is in force, how to switch, and the definitions that could not be used. */
export function agentLines(result: AgentsResult): Line[] {
  if (!result.available) return [line("this engine offers no agents", "dim")]
  const lines: Line[] = []
  const current = result.current
  if (result.agents.length === 0) lines.push(line("No agents are defined here. A definition is a Markdown file in .claude/agents (or the user's agents directory): a name, a description, and what the agent may do.", "dim"))
  else {
    lines.push(line(current === null ? "Agents (this session runs as no agent):" : `Agents (this session runs as ${current}):`, "bold"))
    const width = Math.max(...result.agents.map((agent) => agent.name.length))
    for (const agent of result.agents) {
      const marks = [agent.tag, agent.model === null ? null : `model ${agent.model}${agent.effort === null ? "" : ` ${agent.effort}`}`, agent.name === result.default ? "the default for new sessions" : null].filter((part) => part !== null)
      // The description wraps in its own column, after the names.
      lines.push({ ...line(`${agent.name === current ? "*" : " "} ${agent.name.padEnd(width)}  ${agent.description}`, agent.name === current ? "accent" : "plain", 2), hang: width + 4 })
      if (marks.length > 0) lines.push(line(marks.join(" · "), "dim", 6))
      lines.push(pathLine(agent.path, "dim", 6))
    }
    lines.push(line(current === null ? "/agent <name> switches to one" : "/agent <name> switches to another · /agent none switches it off", "dim"))
  }
  // The one in force stays in force when its file is gone: the session runs as the definition it was given.
  if (current !== null && !result.agents.some((agent) => agent.name === current)) lines.push(line(`This session runs as ${current}, whose definition is no longer among them; it keeps the one it was given.`, "warn"))
  lines.push(...agentProblemLines(result))
  return lines
}

/** The definitions that could not be used as written, and the project settings about agents that were not followed. */
export function agentProblemLines(result: Pick<AgentsResult, "problems" | "ignored">): Line[] {
  const lines: Line[] = []
  if (result.problems.length > 0) lines.push(line("Definitions with problems:", "warn"))
  for (const problem of result.problems) {
    const what = problem.severity === "skipped" ? "not loaded" : problem.severity === "shadowed" ? "hidden by another agent of the same name" : "loaded, with a warning"
    // The file on a line of its own, whole; then what is wrong with it.
    lines.push(pathLine(problem.path, problem.severity === "skipped" ? "warn" : "dim", 2))
    lines.push(line(`${what}: ${problem.reason}`, problem.severity === "skipped" ? "warn" : "dim", 4))
  }
  for (const ignored of result.ignored) lines.push(line(`not followed: ${ignored}`, "warn", 2))
  return lines
}

/** The task list in a `todo` call's result (`display.todo`), or `null` when it carries none. */
export function tasksOf(display: Json | null): readonly TaskItem[] | null {
  if (typeof display !== "object" || display === null || Array.isArray(display)) return null
  const todo = (display as Record<string, Json>).todo
  if (typeof todo !== "object" || todo === null || Array.isArray(todo)) return null
  const items = (todo as Record<string, Json>).items
  if (!Array.isArray(items)) return null
  const tasks: TaskItem[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null
    const { text, status } = item as Record<string, Json>
    if (typeof text !== "string" || (status !== "pending" && status !== "in_progress" && status !== "done")) return null
    tasks.push({ text, status })
  }
  return tasks
}

/** How far a task list is, in a few words: `2 of 5 done`, `all 3 done`, `cleared`. */
export function tasksProgress(tasks: readonly TaskItem[]): string {
  if (tasks.length === 0) return "cleared"
  const done = tasks.filter((task) => task.status === "done").length
  return done === tasks.length ? `all ${tasks.length} done` : `${done} of ${tasks.length} done`
}

/** The mark of a task by its status: done, in progress, pending. */
export const TASK_MARK = { done: "✓", in_progress: "▸", pending: "○" } as const

/** A task list as a checklist, one line per task. */
export function taskLines(tasks: readonly TaskItem[], indent = 0): Line[] {
  return tasks.map((task) => line(`${TASK_MARK[task.status]} ${task.text}`, task.status === "done" ? "dim" : task.status === "in_progress" ? "bold" : "plain", indent))
}

/**
 * A turn's model requests: its steps, and the summary calls of its
 * compactions (model requests that are no steps) when it made any.
 */
export function requestsText(steps: number, summaryCalls: number): string {
  return summaryCalls === 0 ? plural(steps, "step") : `${plural(steps, "step")} + ${plural(summaryCalls, "summary call")}`
}

/** What `/compact` came to when it did not compact, in the engine's sentence; `null` when it did (its own line, from its events, has the sizes). */
export function compactText(result: CompactResult): { readonly text: string; readonly tone: "info" | "warn" } | null {
  // Nothing to compact is no event and no problem: one short sentence, the engine's first without its asides.
  if (result.kind === "nothing") return { text: firstSentence(result.message), tone: "info" }
  if (result.kind === "failed") return { text: result.message, tone: "warn" }
  return null
}

/** The first sentence of `text`, without what it says in parentheses. */
export function firstSentence(text: string): string {
  const plain = text.replace(/\s*\([^)]*\)/g, "").trim()
  const end = plain.search(/[.!?](\s|$)/)
  return end === -1 ? plain : plain.slice(0, end + 1)
}

/** The hint under "nothing to check" when files the checks cover changed outside the turn. */
export const UNVERIFIED_HINT =
  "Files the checks cover changed outside this turn (edited by hand, an undo, or an earlier turn that ended with its checks failing) and were not checked. They are, with everything else, at the end of the next turn that changes a file."

/** What a subagent's ending says about its checks. */
export const LEFT_TO_PARENT = "its checks are left to its parent's turn"
