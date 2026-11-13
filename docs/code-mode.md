# Code mode: programs that call tools

Some work is many small tool calls that follow from each other mechanically: read twenty files, count something in
each, change the three with the most. Done call by call, every result goes to the model and stays in the
conversation, and every round costs a model request. With `run_code` the agent writes a short JavaScript program
instead. The program calls the same tools as functions, and only what it prints and returns goes back to the model.

```js
const files = (await glob({ pattern: "src/**/*.ts" })).split("\n").filter(Boolean)
const counts = await Promise.all(files.map(async (path) => ({ path, todo: ((await read({ path })).match(/TODO/g) ?? []).length })))
console.log(counts.filter((c) => c.todo > 0).map((c) => `${c.path}: ${c.todo}`).join("\n"))
```

The tool is in every session; there is nothing to configure. The agent decides when a program is worth it. You can
ask for one ("do it with one run_code program"), and an [agent](agents.md) can leave it out with `deniedTools`.

## What a program can call

| Function | Is the tool |
| --- | --- |
| `read`, `write`, `edit`, `ls`, `glob`, `grep` | the file tools. `read` gives the program the file's own lines, without the line numbers the tool shows the agent |
| `shell` | a command, without `background` (a program cannot start work that outlives it) |
| `mcp_search`, `mcp_call` | [MCP servers](mcp.md), where any are connected |

Each function takes the tool's arguments as one object and resolves with the tool's text. A call that fails (a
command that exits non-zero, a file that is not there) rejects with an error whose `output` is the tool's text and
`status` how the call ended. The functions are also under `tools` and `functions`. Calls the program does not wait
for one by one run side by side (`Promise.all`), in the order the [schedule](architecture.md) allows: two writes of
one file never overlap, and a write never runs beside a command.

Not available to a program, by decision: subagents and background work (they outlive the program), wake-ups and
memory notes (they act later or in other sessions, and you should see each one asked for), the task list, skills,
the history tools (their text is for the agent to read), the tool that says a check cannot be fixed (that is the
agent's own word), and `run_code` itself.

## Every call is a real tool call

A program's calls are not a shortcut around the rules: each one is recorded in the session's log as a call of its
own, nested under the program's call, and goes through everything a call the agent makes directly goes through.

- **Approval.** Each call is decided by the approval mode on its own. In `ask` mode every write a program makes asks
  you, one question at a time, and a declined one rejects in the program with your note. Unattended, a call that
  would ask is refused and the program sees the refusal. The program's own call asks nothing: by itself it can
  change nothing (below).
- **Taint.** A result that counts as untrusted content when the agent fetches it directly counts the same when a
  program fetched it: an MCP tool's result taints the session ([safety.md](safety.md)), whatever the program prints.
- **Hooks and agents.** Before and after [hooks](hooks.md) apply to each call, and an agent's restrictions refuse
  each call they would refuse directly.
- **Stopping.** `/stop` on the program stops it and the call it is waiting for; stopping one of its calls stops only
  that one, and the program goes on with the result. Interrupting the turn stops everything.
- **Crashes.** If the harness dies while a program runs, the next start settles its calls from the log: one that
  had started and not finished is "may or may not have taken effect", one that had not started is "not run". The
  program is not run again; the agent is told it was cut off and looks before repeating anything.
- **Undo.** The files a program's calls changed are part of the turn, and `/undo` takes them back like any.

In the interfaces the program's call shows its code, and its calls are drawn under it, a step in:

```text
▸ run_code
  │ const a = await read({ path: "a.ts" })
  │ const b = await read({ path: "b.ts" })
  │ await write({ path: "c.ts", content: a + b })
  ▹ read a.ts
    ✓ read a.ts · 1 line · 4ms
  ▹ read b.ts
    ✓ read b.ts · 1 line · 3ms
  ▹ write c.ts
    ✓ write c.ts · created · 7 B · 5ms
  ✓ run_code · 3 tool calls · 160ms
```

## What the program itself can do

Nothing, except call those functions and compute. It runs in a process of its own under the same OS sandbox as
commands ([safety.md](safety.md)), more tightly: nothing is writable except a directory of its own that is removed
when it ends (your working directory is read-only to it too), there is no network, and it gets almost none of your
environment variables. It can read files the sandbox does not hide, as a sandboxed command can. On a machine without
the sandbox a program runs only in `--approval full` before anything untrusted entered the conversation, as commands
do there; otherwise it is refused, and the agent makes its calls directly.

## Limits

| | |
| --- | --- |
| Tool calls | 50 per program; the next one rejects as not run |
| Running time | 60 s of the program's own time; time spent waiting for its calls (and for your answers) is not counted, since each call has its own limit |
| Memory | 512 MB for its process (measured on Linux) |
| Printed text | 1 MB is kept; the result is then shortened like any tool output, with the full text saved to a file |

## When it goes wrong

The agent is told how the program ended, with the line where it did:

```text
The program did not run: SyntaxError (line 3, column 1): Unexpected return
The program stopped: the read call (line 3, column 7) failed and was not caught. Its output:
File not found: missing.ts
2 tool calls had run before that; what they did stays.
```

What the program printed before it stopped comes first. A program that ran out of time or memory says which.

`read` in a program gives at most 2000 lines, as the tool does, with a note at the end when there is more; a line
longer than 2000 characters is cut, and a file with Windows line endings comes back with plain ones. Writing such a
text back changes the file: for those, a program should use `edit` or a command.

## Is it worth it?

On the scripted model, the job above with direct calls took 4 requests and about 36,600 input tokens (the twenty
files stay in every later request); one program that did all of it took 2 requests and about 9,800. With
`gpt-6-luna` at low effort, asked to count TODO comments in twenty files and remove them from the three with the
most: told to use one program, it took 3 requests and 15,700 input tokens, against 5 requests and about 26,500
without code mode (where the model used `grep -c` and `sed`, which is a program too). Left to choose, the same model
used a shell command as often as a program, and its programs were not shorter. The tool's description costs about
380 tokens of every request.
