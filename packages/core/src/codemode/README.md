# codemode

`run_code`: the model writes a short JavaScript program that calls tools as async functions, so that many calls,
a loop and some filtering are one step instead of one model round trip each. Only what the program prints and
returns goes back to the model. Users read [docs/code-mode.md](../../../../docs/code-mode.md).

```js
const files = (await glob({ pattern: "src/**/*.ts" })).split("\n").filter(Boolean)
const counts = await Promise.all(files.map(async (path) => [path, ((await read({ path })).match(/TODO/g) ?? []).length]))
console.log(counts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3))
```

## Files

| File | What it is |
| --- | --- |
| `tool.ts` | the tool: its constant spec, `PROGRAM_TOOLS` (what a program may call, and why not the rest), the text the model is shown for each way a program ends |
| `runner.ts` | `runProgram`: the program's process, the protocol, the limits; `ProgramHost` is who makes the calls |
| `prelude.ts` | what runs in the program's process before the program: the functions as stubs, `console` as messages, the program loaded as a module so an error names its line |

No dependency: the program runs in a child `bun` (the harness's own; a compiled harness runs as Bun with
`BUN_BE_BUN=1`), one JSON message per line over its standard input and output.

## Why a child process under the sandbox

The program must be able to touch nothing by itself: every effect is a tool call, so that each one is decided,
recorded and stoppable. An in-process `vm` or `Function` cannot give that (it shares the process, its memory, its
file system access and its event loop, and an endless loop blocks the harness). A child process confined by the
OS sandbox can (`CommandSandbox.confined`, `sandbox/command.ts`): the command policy with nothing writable but the
run's own directory (the workspace is read-only too), no network, only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` and
Bun's own variables. What it can still do is read files that are not hidden, as a sandboxed command without the
network can, which is no taint source by the same decision (`docs/safety.md`). It costs about 70 ms per program
(measured on the development machine, under bubblewrap and without).

## Limits

`PROGRAM_LIMITS`: 50 calls (the next is answered as not run, without reaching the host), 60 s of the program's own
time (time while a call is out is not counted: a call has its own limits, and a question to the user may wait
long), 512 MB of resident memory of the process tree (read from `/proc` on Linux; elsewhere not measured), 1 MiB of
printed text kept (the rest is counted). The program's result is a tool result like any: the step loop caps it
once when it is produced, and it is stored and replayed byte for byte.

## How a program ends, as the model is told

| End | Status | Text |
| --- | --- | --- |
| returned | success | what it printed, then its return value (a string as it is, anything else as JSON) |
| syntax error | error | `The program did not run: SyntaxError (line N, column M): …` |
| uncaught failed call | error | which tool failed, its line, the tool's output, and how many calls had run |
| uncaught exception | error | the error, its line, and how many calls had run |
| a limit | error | which limit, and how many calls had run |
| stopped | error | who stopped it (the user, an interrupt, a shutdown), and how many calls had run |

## What the engine must do to use it (`engine/codemode.ts`)

- Put `run_code` in the frozen tool list from the first baseline, with its constant spec, whether or not an MCP
  server exists. A program is given the tools of `PROGRAM_TOOLS` the session's list has: decided when it starts,
  never by changing the list.
- Decide the program's own call without a question (`Tool.nests`): it runs confined wherever a sandbox exists;
  without one, only in an untainted `full` (where commands run unsandboxed too), and is refused anywhere else.
- Make each call of the program a call of the step (`ProgramHost.call`): `tool.called` with `parent` (the
  program's call; ID `<parent>.<n>`), durable before anything about it is decided; then the agent's restrictions,
  the approval layer, before and after hooks, the runtime, redaction, the one cap and `tool.settled`, exactly as for a
  call of the model's. Its result taints the session as a direct call's would.
- Schedule the program's call as one that changes something and names nothing (it waits for the response's earlier
  writes and commands; later ones wait for it), and the program's calls among themselves by the schedule's rules,
  in a schedule of their own.
- Stop the program's calls with it: each call's signal follows the program's call's signal, so an interrupt and a
  stop of the program's call reach them; a stop of one of them reaches only it.
- Settle the program's call after every call it made. Where the loop settles calls itself (a stop that was not
  obeyed in time, the wind-down of an interrupt, recovery after a crash), the program's calls are settled first,
  from the state the log has: none is ever run again.
- Leave the program's calls out of every request: the model sees the program's call and its result.
