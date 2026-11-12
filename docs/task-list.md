# The task list

For work with several steps the model keeps a task list: what is done, what it is doing now, what is left. It is
the model's own list, kept with its `todo` tool; you configure nothing and it is there in every session. It tells
you where a long turn is, and it tells the model where it was after the conversation has been compacted.
Everything on this page was run against the program with a scripted model, and once with the real one;
`test/release/feature-docs-2.test.ts` checks the limits and messages against the code.

## What you see

Each time the model sets or updates its list, `windlass` prints the list instead of a tool call:

```text
≡ tasks · 1 of 3 done
  ✓ Read the parser
  ▸ Fix the off-by-one
  ○ Run the tests
```

`✓` is done, `▸` is the one in progress, `○` is pending; when everything is done the heading reads
`≡ tasks · all 3 done`.

- **`windlass tui`** shows the same list in the conversation and keeps the current one in the panel, under
  `Tasks  1 of 3 done`.
- **`--json`** has it on the `todo` call's `tool.settled` event: `display.todo` holds the `items` (each a `text`
  and a `status` of `pending`, `in_progress` or `done`) and the `counts`.
- **An editor** gets the same from `windlass acp` ([acp.md](acp.md)).

Whether to keep a list is the model's decision. You can ask for one:

```sh
windlass "add a subtract function and a multiply function to math.ts; keep a task list while you work"
```

Asked that way, the real model set a list of three tasks, updated it twice, and ended with `≡ tasks · all 3 done`.
Its three `todo` calls were three of the turn's eight model steps.

## What the model does

Every `todo` call sends the whole list, which replaces the one before; the model is answered with a short
confirmation:

```text
Task list updated: 1 done, 1 in progress, 1 pending.
Now: Fix the off-by-one
```

A list has at most 50 tasks, each one line of at most 200 characters, and at most one task in progress. A list
that breaks a rule changes nothing and is shown as a failed call:

```text
  ✗ todo · failed · 6ms
    The task list was not updated: items 1, 2 are all in_progress; at most one item is in_progress at a time. Send the whole list again with this fixed.
```

The call changes no file and does not ask for approval, in `ask` mode either.

## It survives a resume and a compaction

The list is part of the session's log, not of the process that showed it.

- **Resume.** `windlass -c` (or `--session <id>`) shows it under the last turn, and `windlass tui -c` has it in the
  panel again:

  ```text
  Its task list (1 of 3 done):
    ✓ Read the parser
    ▸ Fix the off-by-one
    ○ Run the tests
  ```

- **Compaction.** When the older part of the conversation becomes a checkpoint (by itself, or with `/compact`),
  the model would lose sight of the call that set the list. The checkpoint therefore carries the list as it stood:

  ```text
  ## Your task list when the conversation was compacted ([x] done, [>] in progress, [ ] pending)
  [x] Read the parser
  [>] Fix the off-by-one
  [ ] Run the tests
  ```

  You still see the list as before: resumed in `windlass tui` after a `/compact`, the panel showed `1 of 3 done`.

## Not yet

<!-- NOT-YET(tasks-command): no command shows the list on demand in the line interface -->
- **Showing the list on demand.** `windlass` prints it when it changes and when a session is resumed; there is no
  `/tasks` command to print it in between. `windlass tui` always has it in the panel.
<!-- NOT-YET(tasks-edit): the user cannot edit the list -->
- **Editing it yourself.** The list is the model's. To change it, tell the model.
