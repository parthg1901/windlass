/** The `todo` tool: a constant spec, validation with messages for the model, the display data, and the fold. */
import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { CallId, MessageId } from "../../src/id.ts"
import type { Message, ToolCallPart } from "../../src/message/message.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { noBlobStore, specOf } from "../../src/tool/tool.ts"
import { TODO_LIMITS, TODO_TOOL_NAME, checkTodos, currentTodos, renderTodos, todoList, todoTool } from "../../src/tools/todo.ts"
import { context, removeTempDirs, tempDir } from "./helpers.ts"

afterEach(removeTempDirs)

function runtime() {
  const root = tempDir()
  const run = createToolRuntime({ tools: [todoTool()], spillDir: join(root, "spill"), putBlob: noBlobStore })
  return (args: unknown) => run.run({ name: TODO_TOOL_NAME, argumentsText: typeof args === "string" ? args : JSON.stringify(args), context: context(root) })
}

describe("the spec", () => {
  test("is a constant: the same on every call, whatever the list", async () => {
    const before = JSON.stringify(specOf(todoTool()))
    const call = runtime()
    await call({ todos: [{ text: "a", status: "in_progress" }] })
    expect(JSON.stringify(specOf(todoTool()))).toBe(before)
    expect(todoTool().name).toBe("todo")
    expect(todoTool().effect).toBe("read")
  })

  test("its schema compiles in the runtime, which rejects what the schema can say", async () => {
    const call = runtime()
    expect((await call({ todos: [{ text: "a", status: "started" }] })).kind).toBe("refused")
    expect((await call({ todos: [{ text: "a" }] })).kind).toBe("refused")
    expect((await call({ todos: Array.from({ length: TODO_LIMITS.maxItems + 1 }, (_, index) => ({ text: `step ${index}`, status: "pending" })) })).kind).toBe("refused")
    expect((await call({ todos: [{ text: "x".repeat(TODO_LIMITS.maxTextLength + 1), status: "pending" }] })).kind).toBe("refused")
  })
})

describe("validation", () => {
  const items = (...list: [string, string][]) => ({ todos: list.map(([text, status]) => ({ text, status })) })
  const message = (input: unknown) => {
    const checked = checkTodos(input)
    if (checked.ok) throw new Error("expected a problem")
    return checked.message
  }

  test("a good list is accepted, trimmed", () => {
    expect(checkTodos(items([" Read the parser ", "done"], ["Fix the bug", "in_progress"], ["Run the tests", "pending"]))).toEqual({
      ok: true,
      items: [
        { text: "Read the parser", status: "done" },
        { text: "Fix the bug", status: "in_progress" },
        { text: "Run the tests", status: "pending" },
      ],
    })
    expect(checkTodos({ todos: [] })).toEqual({ ok: true, items: [] })
  })

  test("at most one item in progress", () => {
    expect(message(items(["a", "in_progress"], ["b", "pending"], ["c", "in_progress"]))).toBe(
      "The task list was not updated: items 1, 3 are all in_progress; at most one item is in_progress at a time. Send the whole list again with this fixed.",
    )
  })

  test("clear messages for what a schema cannot say, and the bounds when called directly", () => {
    expect(message(items(["   ", "pending"]))).toContain("item 1 has an empty text.")
    expect(message(items(["a\nb", "pending"]))).toContain("item 1 has a line break")
    expect(message(items(["Fix it", "done"], ["Fix it ", "pending"]))).toContain('item 2 repeats item 1 ("Fix it")')
    expect(message(items(["a", "doing"]))).toContain('item 1 has the status "doing"; use one of pending, in_progress, done.')
    expect(message({ todos: Array.from({ length: 51 }, (_, index) => ({ text: `s${index}`, status: "pending" })) })).toContain("it has 51 items; at most 50")
    expect(message(items(["x".repeat(201), "pending"]))).toContain("201 characters long; at most 200")
    expect(message({ todos: "a, b" })).toContain("`todos` must be a list")
    expect(message({ todos: [null] })).toContain("item 1 must be an object")
  })

  test("a bad list through the tool is an error result the model reads, and changes nothing", async () => {
    const outcome = await runtime()(items(["a", "in_progress"], ["b", "in_progress"]))
    expect(outcome.kind).toBe("completed")
    expect(outcome.settlement).toMatchObject({ outcome: "error", display: null })
    expect(outcome.settlement.output).toStartWith("The task list was not updated: items 1, 2 are all in_progress")
  })
})

describe("the result", () => {
  test("a short confirmation for the model and the list for a client", async () => {
    const outcome = await runtime()({ todos: [{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }, { text: "Test", status: "pending" }] })
    expect(outcome.settlement).toEqual({
      outcome: "success",
      output: "Task list updated: 1 done, 1 in progress, 1 pending.\nNow: Fix",
      truncation: null,
      attachments: [],
      display: {
        todo: {
          items: [
            { text: "Read", status: "done" },
            { text: "Fix", status: "in_progress" },
            { text: "Test", status: "pending" },
          ],
          counts: { pending: 1, in_progress: 1, done: 1 },
        },
      },
    })
  })

  test("all done, and cleared", async () => {
    const call = runtime()
    expect((await call({ todos: [{ text: "a", status: "done" }, { text: "b", status: "done" }] })).settlement.output).toBe("Task list updated: all 2 done.")
    expect((await call({ todos: [] })).settlement.output).toBe("Task list cleared.")
  })

  test("renderTodos for a checkpoint or a text client", () => {
    expect(renderTodos(todoList([{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }, { text: "Test", status: "pending" }]))).toBe("[x] Read\n[>] Fix\n[ ] Test")
    expect(renderTodos(todoList([]))).toBe("(the task list is empty)")
  })
})

describe("the fold", () => {
  let seq = 0
  const settled = (input: unknown, outcome: "success" | "error", display: unknown): ToolCallPart => ({
    type: "tool_call",
    callId: `call_${(seq += 1)}` as CallId,
    name: TODO_TOOL_NAME,
    input: JSON.stringify(input),
    providerData: null,
    state: { status: "settled", outcome, output: "", truncation: null, attachments: [], display: display as never },
  })
  const assistant = (parts: ToolCallPart[], excluded: "reverted" | "refused" | null = null): Message => ({
    kind: "assistant",
    id: `msg_${(seq += 1)}` as MessageId,
    seq,
    time: 0,
    excluded,
    model: "m",
    attempt: 1,
    status: "completed",
    parts,
    finish: "tool_calls",
    usage: null,
    error: null,
    refusal: null,
    lastRetry: null,
    endedAt: 0,
  })
  const list = (...items: [string, "pending" | "in_progress" | "done"][]) => ({ todo: todoList(items.map(([text, status]) => ({ text, status }))) })

  test("the latest successful call wins; failed calls and other tools are ignored", () => {
    const history = [
      assistant([settled({}, "success", list(["a", "in_progress"], ["b", "pending"]))]),
      assistant([settled({}, "success", list(["a", "done"], ["b", "in_progress"])), settled({}, "error", null)]),
      assistant([{ ...settled({}, "success", { other: true }), name: "read" }]),
    ]
    expect(currentTodos(history)).toEqual(list(["a", "done"], ["b", "in_progress"]).todo)
    // Within one message the later call wins.
    expect(currentTodos([assistant([settled({}, "success", list(["first", "pending"])), settled({}, "success", list(["second", "pending"]))])])?.items[0]?.text).toBe("second")
  })

  test("a reverted call does not count: the list goes back to the one before it", () => {
    const history = [assistant([settled({}, "success", list(["a", "in_progress"]))]), assistant([settled({}, "success", list(["a", "done"]))], "reverted")]
    expect(currentTodos(history)).toEqual(list(["a", "in_progress"]).todo)
  })

  test("no list yet, a cleared list, and a display that is not a list", () => {
    expect(currentTodos([])).toBeNull()
    expect(currentTodos([assistant([settled({}, "success", list())])])).toEqual({ items: [], counts: { pending: 0, in_progress: 0, done: 0 } })
    expect(currentTodos([assistant([settled({}, "success", { todo: { items: "x" } })])])).toBeNull()
  })

  test("the fold reads what the tool itself returned", async () => {
    const outcome = await runtime()({ todos: [{ text: "Ship", status: "in_progress" }] })
    const part = settled({}, "success", outcome.settlement.display)
    expect(currentTodos([assistant([part])])).toEqual(list(["Ship", "in_progress"]).todo)
  })
})
