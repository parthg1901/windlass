/**
 * The `todo` tool: the model's task list for multi-step work. See TODO-TOOL.md for the integrator.
 *
 * The model sends its whole list on every call; the call replaces the list. The tool keeps no state: the
 * current list is whatever the latest settled, successful `todo` call in the session's history says
 * (`currentTodos`), so it survives a restart, a fork, a revert and a compaction by construction. Its spec is a
 * constant (it never depends on configuration or on the list), so it can sit in the frozen tool list.
 *
 * Effect `read`: it changes nothing in the workspace, so it needs no approval, takes no snapshot, runs side by
 * side with other reads, and a call that throws settles as `error`, never `effect_unknown`.
 */
import type { Json } from "../json.ts"
import type { Message } from "../message/message.ts"
import type { Tool } from "../tool/tool.ts"
import { array, object, oneOf, safeDecode, string, integer } from "../validate.ts"
import { failure, success } from "./common.ts"

export const TODO_TOOL_NAME = "todo"

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface TodoItem {
  readonly text: string
  readonly status: TodoStatus
}

export interface TodoInput {
  readonly todos: readonly TodoItem[]
}

export const TODO_LIMITS = { maxItems: 50, maxTextLength: 200 } as const

/** What a client renders: the list as the call left it, and the counts. In `ToolResult.display` under `todo`. */
export interface TodoList {
  readonly items: readonly TodoItem[]
  readonly counts: { readonly pending: number; readonly in_progress: number; readonly done: number }
}

const DESCRIPTION = [
  "Keep a task list for work with several steps, so you and the user can see what is done and what is next.",
  "Send the whole list every time: it replaces the list you sent before. Each item is a short text and a status: pending, in_progress or done.",
  "Mark an item in_progress when you start it and done as soon as it is finished; at most one item is in_progress at a time.",
  "Skip it for a task of one or two steps. Send an empty list to clear it.",
].join(" ")

const INPUT_SCHEMA: Json = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      maxItems: TODO_LIMITS.maxItems,
      description: "The whole task list, in order. It replaces the previous one.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: TODO_LIMITS.maxTextLength, description: "What the step is, in a few words." },
          status: { type: "string", enum: [...TODO_STATUSES] },
        },
        required: ["text", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
}

export function todoTool(): Tool<TodoInput> {
  return {
    name: TODO_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    effect: "read",
    execute: async (input) => {
      const checked = checkTodos(input)
      if (!checked.ok) return failure(checked.message)
      const list = todoList(checked.items)
      return success(confirmation(list), { todo: list as unknown as Json })
    },
  }
}

/**
 * Validates a list as the model sent it. The runtime has already checked it against the schema; this adds what a
 * schema cannot say (blank text, a line break, duplicates, more than one in progress) and repeats the schema's
 * bounds so that the tool is safe when called directly. Texts are trimmed.
 */
export function checkTodos(input: unknown): { readonly ok: true; readonly items: readonly TodoItem[] } | { readonly ok: false; readonly message: string } {
  const bad = (problem: string) => ({ ok: false as const, message: `The task list was not updated: ${problem} Send the whole list again with this fixed.` })
  if (typeof input !== "object" || input === null || !Array.isArray((input as { todos?: unknown }).todos)) return bad("`todos` must be a list of items.")
  const todos = (input as { todos: unknown[] }).todos
  if (todos.length > TODO_LIMITS.maxItems) return bad(`it has ${todos.length} items; at most ${TODO_LIMITS.maxItems} are allowed. Group small steps together.`)
  const items: TodoItem[] = []
  for (const [index, raw] of todos.entries()) {
    const at = `item ${index + 1}`
    if (typeof raw !== "object" || raw === null) return bad(`${at} must be an object with \`text\` and \`status\`.`)
    const { text, status } = raw as { text?: unknown; status?: unknown }
    if (typeof text !== "string") return bad(`${at} has no \`text\`.`)
    const trimmed = text.trim()
    if (trimmed === "") return bad(`${at} has an empty text.`)
    if (/[\r\n]/.test(trimmed)) return bad(`${at} has a line break; keep each item to one line.`)
    if (trimmed.length > TODO_LIMITS.maxTextLength) return bad(`${at} is ${trimmed.length} characters long; at most ${TODO_LIMITS.maxTextLength} are allowed. Shorten it.`)
    if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) return bad(`${at} has the status ${JSON.stringify(status)}; use one of pending, in_progress, done.`)
    const first = items.findIndex((item) => item.text === trimmed)
    if (first !== -1) return bad(`${at} repeats item ${first + 1} ("${trimmed}"). Each step once.`)
    items.push({ text: trimmed, status: status as TodoStatus })
  }
  const running = items.flatMap((item, index) => (item.status === "in_progress" ? [index + 1] : []))
  if (running.length > 1) return bad(`items ${running.join(", ")} are all in_progress; at most one item is in_progress at a time.`)
  return { ok: true, items }
}

export function todoList(items: readonly TodoItem[]): TodoList {
  const count = (status: TodoStatus) => items.filter((item) => item.status === status).length
  return { items: items.map((item) => ({ text: item.text, status: item.status })), counts: { pending: count("pending"), in_progress: count("in_progress"), done: count("done") } }
}

/** The short text the model gets back. It does not repeat the list: the model has just written it. */
function confirmation(list: TodoList): string {
  const total = list.items.length
  if (total === 0) return "Task list cleared."
  if (list.counts.done === total) return `Task list updated: all ${total} done.`
  const parts = [`${list.counts.done} done`, `${list.counts.in_progress} in progress`, `${list.counts.pending} pending`]
  const now = list.items.find((item) => item.status === "in_progress")
  return `Task list updated: ${parts.join(", ")}.${now === undefined ? "" : `\nNow: ${now.text}`}`
}

const todoItemShape = object({ text: string, status: oneOf(TODO_STATUSES) })
const todoListShape = object({ items: array(todoItemShape), counts: object({ pending: integer(0), in_progress: integer(0), done: integer(0) }) })

/**
 * The current list, folded out of a session's messages: the `display` of the latest `todo` call that settled
 * with success in a message that is not excluded (reverted or refused). `null` when there is none: the model
 * never set a list, or every list it set was reverted. Pass `projection.messages` (all of them, including those
 * a compaction took out of the model's view: the list is still the list) or a model history.
 */
export function currentTodos(history: readonly Message[]): TodoList | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!
    if (message.kind !== "assistant" || message.excluded !== null) continue
    for (let part = message.parts.length - 1; part >= 0; part -= 1) {
      const call = message.parts[part]!
      if (call.type !== "tool_call" || call.name !== TODO_TOOL_NAME || call.state.status !== "settled" || call.state.outcome !== "success") continue
      const display = call.state.display
      const decoded = safeDecode(todoListShape, typeof display === "object" && display !== null && !Array.isArray(display) ? (display as Record<string, Json>).todo : undefined)
      if (decoded.ok) return decoded.value
    }
  }
  return null
}

/** The list as plain lines, for a compaction checkpoint or a text client: `[x]` done, `[>]` in progress, `[ ]` pending. */
export function renderTodos(list: TodoList): string {
  if (list.items.length === 0) return "(the task list is empty)"
  const mark: Record<TodoStatus, string> = { done: "[x]", in_progress: "[>]", pending: "[ ]" }
  return list.items.map((item) => `${mark[item.status]} ${item.text}`).join("\n")
}
