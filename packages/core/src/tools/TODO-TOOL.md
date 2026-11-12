# The `todo` tool, for the integrator

`todo.ts` exports `todoTool()`, a standard tool with a constant spec. It is wired: `createStandardTools`
(`tools/index.ts`) has it, so it is in every session's frozen tool list from the first baseline, and a compaction's
checkpoint carries the list (`engine.ts`, `compact`; `context/checkpoint.ts`, `todos`). What follows is the contract
as it was written for that wiring; the part about clients is still to do.

## What it does

The model sends its whole task list on every call; the call replaces the list:

```json
{ "todos": [
  { "text": "Read the parser", "status": "done" },
  { "text": "Fix the off-by-one", "status": "in_progress" },
  { "text": "Run the tests", "status": "pending" }
] }
```

At most 50 items, each one line of at most 200 characters (trimmed), no item twice, at most one `in_progress`. A
bad list is an `error` result that says what to fix ("items 1, 3 are all in_progress; at most one ..."), and
changes nothing. A good one returns a short confirmation (it does not repeat the list: the model just wrote it):

```
Task list updated: 1 done, 1 in progress, 1 pending.
Now: Fix the off-by-one
```

and `display: { todo: { items: [{ text, status }...], counts: { pending, in_progress, done } } }`.

## Where it goes

- **The frozen tool list**: from a session's first baseline, always, for the session's life (also across a
  compaction), like the history tools. Its name, description and schema never depend on configuration or on the
  list, so the tool block's hash is the same in every session. Do not add it only once a task looks long: that
  would change the list mid-session. Sorted with the rest by `sortTools`.
- **Effect `read`**: it changes nothing in the workspace, so the approval layer runs it without a question in every
  mode (a `read` with no paths has no needs), the loop takes no snapshot around a step that only has it, it runs
  side by side with other reads, and a crash settles as `error`, never `effect_unknown`. It is not a taint source
  (no paths, no network).
- **`createStandardTools`** (`tools/index.ts`) is the natural place: `todoTool()` takes no options.

## State: none outside the log

The current list is the `display.todo` of the latest `todo` call that settled with `success` in a message that is
not excluded. `currentTodos(messages)` folds it (`null` when the model never set one). Because it is a fold over
the log:

- **restart, resume**: the same messages, the same list;
- **fork**: the child inherits the messages up to the fork, so it starts with the parent's list at that point;
- **revert, refusal**: an excluded call does not count; the list goes back to the one before it;
- **compaction**: the projection keeps every message, so a client folding `projection.messages` still shows the
  list. The model, though, no longer sees the call once a compaction cut it away. **The checkpoint should carry the
  latest list**: when `context/checkpoint.ts` renders a checkpoint, add `renderTodos(currentTodos(messages before
  the cut))` as a short section ("Your task list when the conversation was compacted:", then lines like
  `[x] Read the parser`, `[>] Fix the off-by-one`, `[ ] Run the tests`) when the list is not `null` and the latest
  todo call is before the cut. It is frozen in `compaction.ended` with the rest of the checkpoint. That is a change
  to the context track's file.

## What clients render

A checklist from `display.todo.items` in order: done checked, in progress highlighted, pending unchecked, with the
counts. Show it on each `todo` result (the ACP client can map it to an ACP `plan` update: `in_progress` and
`pending` map directly, `done` to `completed`; all items with the same priority), and keep the latest one visible
(the TUI's side panel, the CLI after each change). On reopening a session, `currentTodos(projection.messages)` gives
the list to show before anything new arrives.

## What the system prompt might say

Nothing is required: the description tells the model how to use it. If the base prompt has a section on working
style, one sentence is enough, and it must be in the baseline from the start like the rest of the prompt: "For work
with several steps, keep a task list with the todo tool and update it as you go."
