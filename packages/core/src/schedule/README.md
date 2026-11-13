# Scheduling the calls of one response

Which tool calls of one model response may run at the same time. Pure and dependency-free: the caller says what
each call is, and `CallSchedule` says when it starts.

## Rules

A call waits for the earlier calls of the same response it conflicts with, and for nothing else. Calls that
conflict therefore run in the order the model wrote them; the rest run side by side.

| Footprint | Calls | Conflicts with |
| --- | --- | --- |
| `none` | reads, subagent calls (`Tool.delegates`), tools nobody knows, network tools of the harness's own | nothing |
| `files` | a write or an edit that names its paths (`Tool.touches`) | `files` that overlap, `command`, `unknown` |
| `command` | a command (`exec`), an MCP server's tool (it runs outside the sandbox, whatever it declares) | `files`, `unknown` |
| `unknown` | a write that names no path (records-only tools such as memory and wake-ups) | `files`, `command`, `unknown` |

Two paths overlap when they are one path or one lies inside the other, by the path the tool opens or by the path
with every link followed. A path whose links could not be followed meets every path.

Why commands run beside each other: the model asked for them in one response, before it saw any of their results,
so it treats them as independent. Why a command and a write never overlap: a command can change the file a write
was decided about, or put a link in its way, between the decision and the write.

## What the engine must do to use it

- Build a `PathKey` for each path a write names the way approval resolves it (`engine/approval.ts` `pathKey`: the
  temp alias, `~`, the working directory, then every link) and a `Footprint` with `footprintOf`.
- Add the calls in model order, as each one's arguments finish streaming. `add` starts the call synchronously when
  nothing is in its way, so calls with nothing to wait for start in the order added; `onWait` says that it waits.
- In `start`, check again whether anything new may still start (an interrupt, a failed response, a run that an
  unanswerable question ended) when the call had to wait: a call that does not start is settled as not started
  by whoever closes the step.
- A call is done, for what waits behind it, when the promise `start` returned settles, whether it succeeded or not.
- Decide each call when its turn comes, not when it is added.
