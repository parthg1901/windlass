# Telemetry

`windlass` can send what a session does to an OpenTelemetry collector as it runs: one trace per turn, with a span for
each model call and each tool call. It is for seeing where a turn's time and tokens went in the tools you already
use for traces. It is **off** unless you turn it on, it sends to the one address you name and nowhere else, and by
default it sends no text of yours: no prompt, no answer, no file path, no command. Everything on this page was run
against the program with a scripted model and a collector on the same machine;
`test/release/feature-docs-3.test.ts` checks the keys and messages against the code, and runs the examples.

## The smallest working example

In your own configuration file, `~/.config/windlass/config.json`:

```json
{ "telemetry": { "enabled": true, "endpoint": "http://localhost:4318" } }
```

Then work as usual:

```sh
windlass "what is a in a.ts?"
```

Nothing new is printed. The collector at that address receives the turn's spans as OTLP over HTTP with JSON
bodies, posted to `/v1/traces` (give the base address, or the whole `/v1/traces` address). Any collector or backend
that accepts that will do.

## Only your own file can turn it on

Telemetry sends data off the machine, so a repository must not be able to start it, point it somewhere else or
widen it.

| In | What it can do |
|---|---|
| your own file, `~/.config/windlass/config.json` | turn export on, name the address and the headers, turn `content` on |
| a project's file, `.windlass/config.json` | only turn it off for that project: `{ "telemetry": { "enabled": false } }` |

In a project's file `enabled: true`, an `endpoint` and `content` are read and not followed, without a message: with
export off in your file nothing is sent, and with it on the spans go to your address, without content unless your
file says so.

## The keys

| Key in `telemetry` | Value |
|---|---|
| `enabled` | `true` exports the spans of every session's turns; default `false` |
| `endpoint` | the collector, an `http://` or `https://` address. Required when enabled |
| `headers` | HTTP headers sent with every request, for example a token |
| `content` | `true` also sends text (below); default `false` |
| `timeoutMs` | how long one request to the collector may take, 100 to 120000; default 10000 |

`${NAME}` in a header's value is replaced by that variable from the environment `windlass` runs in, so a token does
not have to be written in the file:

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://otel.example.com",
    "headers": { "authorization": "Bearer ${OTEL_TOKEN}" }
  }
}
```

## What a turn's spans are

One trace per turn. For a turn that read one file and answered, the collector gets four spans:

```text
invoke_agent Windlass      the turn: session, model, how it ended, its steps, model calls, tool calls and tokens
├─ chat gpt-6.1-sol        a model call: tokens in, out and read from the cache, why it stopped, its attempt
├─ execute_tool read       a tool call: its effect class, how it ended, whether it ran in the sandbox or was asked about
└─ chat gpt-6.1-sol        the next model call
```

A subagent's turns are in its parent's trace, under the call that started it; a compaction and a run of the
project's checks have spans of their own. The names follow OpenTelemetry's conventions for generative AI
(`gen_ai.operation.name`, `gen_ai.usage.input_tokens`, `gen_ai.tool.name`, ...), which are still changing; what the
conventions have no name for is under `windlass.` (`windlass.execution.outcome`, `windlass.tool.effect`, ...).
Each request also says which program sent it: `service.name`, its version, and the machine's host name.

The session's ID is on every span (`gen_ai.conversation.id`), so a trace leads back to the session, and exporting
the same session again gives the same trace and span IDs.

## Content is off by default

Without `content` the attributes are names, numbers, classes and outcomes: tool names, token counts, durations,
how a call ended. With `"content": true` in your own file these are added:

| Attribute | On | What |
|---|---|---|
| `gen_ai.input.messages` | the turn | the messages the turn took in (your prompt) |
| `gen_ai.output.messages` | each model call | the model's text and the tool calls it asked for |
| `gen_ai.tool.call.arguments` | each tool call | the arguments: paths, commands, the text of an edit |
| `gen_ai.tool.call.result` | each tool call | the tool's output: file contents, command output |

Text goes through the same redaction as tool results (well-known token formats, private keys, passwords in
addresses) and each text is cut at 4,096 characters. Redaction misses things: turn `content` on only for a
collector of your own. The system prompt and the tool definitions are never sent.

## What can go wrong

Export never holds up a turn or fails it.

- **The collector is down or slow.** The turn runs and ends as usual and nothing is said; the spans that could not
  be sent are dropped.
- **A header names a variable that is not set**, or export is on without an address. Nothing is exported, and you
  are told when the turn starts:

  ```text
  ⚠ telemetry: Telemetry is not exported: telemetry.headers.authorization: the environment variable OTEL_TOKEN is not set.
  ⚠ telemetry: Telemetry is not exported: telemetry is enabled but the user configuration names no endpoint.
  ```

- **A mistake in the file** fails the turn before anything is sent, naming the file and the key, like any
  configuration error: `telemetry.endpont: unknown key "endpont"; known keys: enabled, endpoint, headers, content, timeoutMs`,
  or `telemetry.endpoint: expected an http:// or https:// URL`.

## Exporting a finished session

A session's spans are derived from what it stored, so one that ran with export off can be exported later. From a
checkout of the repository:

```sh
bun scripts/export-otel.ts <session-id> -o spans.jsonl
bun scripts/export-otel.ts <session-id> --endpoint http://localhost:4318
bun scripts/export-otel.ts <session-id> --endpoint https://otel.example.com --header 'authorization=Bearer ${OTEL_TOKEN}'
bun scripts/export-otel.ts <session-id> --content --no-children
```

| Option | What |
|---|---|
| `<session-id>` | the session, or the start of its ID if it is unique |
| `-o <file>` | write to a file, one OTLP/JSON request per line; without `-o` and `--endpoint` the lines go to standard output |
| `--endpoint <url>` | send to a collector instead |
| `--header name=value` | a header for the collector; `${NAME}` in the value is read from the environment |
| `--content` | include text, as `content` above |
| `--no-children` | leave the session's subagents out |
| `--data-dir <dir>` | where the sessions are, when not the usual data directory |

It reads the session and changes nothing. It says what it did
(`ses_…: 4 spans in 1 trace(s) from 1 session(s) -> spans.jsonl (1 line(s))`) and exits with 0 when everything was
exported, 1 for a usage error or a session that does not exist, and 4 when the collector did not take every span
(`0 sent, 4 failed`). The script takes its options from the command line and does not read the `telemetry` section.

## Not yet

- **No command shows whether export is working.** A collector that is down is silent in the session; look at the
  collector, or export the session with the script, which reports what was sent.
- **Traces only.** No metrics and no logs are exported.
- **No per-project address.** A project's file can only turn export off; there is no way to send one project's
  sessions to another collector than the one in your own file.
- **The export script is not part of the installed program.** It runs from a checkout with `bun`.
