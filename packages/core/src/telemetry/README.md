# telemetry: a session as OpenTelemetry spans

A session's log and request ledger, mapped to spans that follow the OpenTelemetry GenAI semantic conventions, and two
exporters for them: OTLP/HTTP to a collector, and OTLP/JSON to a file. Everything is derived from what the session
stored, like the prefix-cache trace in `../trace/`: after the fact by the script below, and live by the engine
(`engine/telemetry.ts`), which maps the same log with the same function as a session runs and writes nothing for
it. The module has no dependency (no OpenTelemetry SDK; the encoding is written by hand).

```
span.ts      the span model, the deterministic trace and span IDs, the attribute namespace
map.ts       mapSession: one session's events and ledger rows -> spans (pure)
tree.ts      mapSessionTree: a session with its subagents, each placed in its parent's trace
content.ts   what content export does to text: the harness's credential redaction, then a size bound
otlp.ts      the OTLP/JSON encoding (ExportTraceServiceRequest) and batching
exporter.ts  the OTLP/HTTP exporter (timeout, bounded retries, batches), the file exporter, a background queue
config.ts    the `telemetry` configuration section: validator and resolver
```

## For users

### What is exported

One **trace per execution** (a turn: from the moment the harness takes up a prompt until it ends, succeeded, failed
or interrupted). Its spans:

```
invoke_agent <brand>            the execution (INTERNAL); conversation, model, effort, outcome, the gate's verdict,
│                               the tokens of all its model calls, steps, model calls, tool calls, retries
├─ chat <model>                 one per model call, each retry attempt its own (CLIENT); usage, finish reason,
│                               attempt, whether it was retried and after what delay, the error and the
│                               provider's request ID when the call failed
├─ execute_tool <tool>          one per tool call (INTERNAL); effect class, outcome, origin, whether it ran in the
│  │                            sandbox (and with the network), whether an approval was asked, the answer, a denial
│  │                            and by what; events at the question, the answer and the start
│  └─ subagent                  spawned work (INTERNAL), with the child session's ID, its outcome, usage and merge
│     └─ invoke_agent <brand>   the child session's executions, in the same trace (with the tree export)
│        └─ ...
├─ compaction                   trigger, mode, sizes before and after, where the summary came from
│  └─ chat <model>              its summary calls
└─ checks                       a run of the project's checks: which, the verdict, the failing ones
```

Times are the timestamps the log and the ledger stored. Trace and span IDs are derived from the session ID and
positions in its log, so exporting the same session twice gives the same IDs (and the same bytes). A span whose end is
not in the log yet (a running session, or one a crash cut off) ends at the last event and carries
`windlass.span.open = true`; exporting again later sends it again, with the same ID and the real end. How a
backend treats a span sent twice differs (most keep the last); export a session once it has finished when that
matters.

**What is not exported by default:** message text (prompts, answers, reasoning), tool arguments, tool output, the
system prompt, file paths, commands, and the sentence about a failure (a span's status message), which can name
a path or quote a command. The attributes are names, numbers, classes and outcomes; a failed span has `error.type`
and the status code.

**`--content`** (or `"content": true`) adds, per the conventions' opt-in attributes:
`gen_ai.input.messages` (the prompts an execution took in), `gen_ai.output.messages` (a model call's text and tool
calls), `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, a background command's command line, and the
status message of a turn or a model call that failed. Every
text goes through the same redaction the harness applies to tool results (`approval/redact.ts`: well-known token
formats, private keys, URL passwords, `Bearer` values, and the values of the exporting process's credential-looking
environment variables), and is then cut to 4,096 characters per text (a message keeps at most 32 parts). The system
prompt and the tool definitions are never sent. Redaction has the misses `redact.ts` lists; content export is for
your own collector.

### Exporting a session

```sh
bun scripts/export-otel.ts <session-id> -o spans.jsonl                    # to a file, one OTLP/JSON body per line
bun scripts/export-otel.ts <session-id>                                   # the same lines to stdout
bun scripts/export-otel.ts <session-id> --endpoint http://localhost:4318  # to a collector's OTLP/HTTP receiver
bun scripts/export-otel.ts <session-id> --endpoint https://otel.example --header 'authorization=Bearer ${OTEL_TOKEN}'
bun scripts/export-otel.ts <session-id> --content --no-children --data-dir <dir>
```

The session may be given by a unique prefix. The export is read-only: it copies each session file as a consistent
snapshot through a read-only connection and never takes a session's lock, so it works on a running session.
Subagents are included and placed in their parent's traces (`--no-children` leaves them out); asked for a subagent,
the export reads its parent's log to place it there. `${NAME}` in a header value is read from the environment, so a
token is not typed on the command line; header values are never printed. Exit codes: 0 exported, 1 usage error or no
such session, 4 the collector did not take every span.

A collector for a quick look: the OpenTelemetry Collector with an `otlp` receiver (`http` on port 4318) and a
`debug` exporter, or any backend that accepts OTLP/HTTP with JSON bodies (Jaeger, Tempo, Honeycomb, ...). The file
output is what the collector's `otlpjsonfile` receiver reads.

### The file output

One line per batch (at most 512 spans or 1 MiB), an `ExportTraceServiceRequest`, shortened here:

```json
{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"Windlass"}}]},
 "scopeSpans":[{"scope":{"name":"Windlass/telemetry","version":"1"},"spans":[
  {"traceId":"7c0e…","spanId":"1e814b7b6e62c29c","name":"invoke_agent Windlass","kind":1,
   "startTimeUnixNano":"1794474000000000000","endTimeUnixNano":"1794474000460000000",
   "attributes":[{"key":"gen_ai.operation.name","value":{"stringValue":"invoke_agent"}},
                 {"key":"gen_ai.conversation.id","value":{"stringValue":"ses_405a…"}},
                 {"key":"gen_ai.usage.input_tokens","value":{"intValue":"2500"}},
                 {"key":"gen_ai.usage.cache_read.input_tokens","value":{"intValue":"1100"}},
                 {"key":"windlass.execution.outcome","value":{"stringValue":"succeeded"}}, …],
   "events":[],"links":[],"status":{"code":1}},
  {"traceId":"7c0e…","spanId":"6ee6829ce216af00","parentSpanId":"1e814b7b6e62c29c","name":"chat gpt-…","kind":3,
   "attributes":[{"key":"gen_ai.response.finish_reasons","value":{"arrayValue":{"values":[{"stringValue":"tool_calls"}]}}}, …]},
  {"traceId":"7c0e…","spanId":"8c0add449f350906","parentSpanId":"1e814b7b6e62c29c","name":"execute_tool read","kind":1,
   "attributes":[{"key":"windlass.tool.effect","value":{"stringValue":"read"}},
                 {"key":"windlass.approval.asked","value":{"boolValue":false}},
                 {"key":"windlass.tool.sandboxed","value":{"boolValue":false}}, …]}]}]}]}
```

Read it with `jq -c '.resourceSpans[].scopeSpans[].spans[] | {name, attributes}' spans.jsonl`.

### The `telemetry` configuration section

```json
"telemetry": {
  "enabled": true,
  "endpoint": "http://localhost:4318",
  "headers": { "authorization": "Bearer ${OTEL_TOKEN}" },
  "content": false,
  "timeoutMs": 10000
}
```

Off by default. Only the user's own configuration file may turn it on, choose the endpoint and headers, and turn
content on; a project's file may only turn it off, because a repository must not be able to send data off the
machine. `${NAME}` in a header is read from the environment when the configuration is resolved (`$$` is a `$`); a
variable that is not set is an error naming it. The section is validated and resolved here (`parseTelemetrySection`,
`resolveTelemetryConfig`) and is a key of the configuration file: with it on, the engine exports the spans of a
session's turns as they run (`docs/architecture.md`, "Slash commands and live telemetry"). The script takes its
options on the command line and does not read the section.

### The conventions

The GenAI semantic conventions are in development status and moved to
`github.com/open-telemetry/semantic-conventions-genai`; the names here were checked against its `docs/gen-ai/`
(client inference, execute tool, agent spans) on 2026-11-12.

Used as the conventions define them: `gen_ai.operation.name` (`invoke_agent`, `chat`, `execute_tool`),
`gen_ai.provider.name` (`openai`), `gen_ai.agent.name`, `gen_ai.agent.id` (a subagent's session),
`gen_ai.conversation.id` (the session), `gen_ai.request.model`, `gen_ai.response.finish_reasons`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.reasoning.output_tokens`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` (`function`;
`extension` for an MCP server's tool), `gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `error.type`; span names `{operation} {model}`,
`execute_tool {tool}`, `invoke_agent {agent}`; kinds CLIENT for model calls, INTERNAL for the rest.

Unsure, used anyway, and worth checking when the conventions settle:
- `gen_ai.request.reasoning.level` for the session's reasoning effort: listed in the inference span, its values not
  pinned down (the harness sends `low`, `medium`, ...).
- `gen_ai.usage.input_tokens` is inclusive of cached tokens here, as the provider reports it; the conventions'
  wording on whether cache reads are part of it was not conclusive in what was read.
- `invoke_agent` for the execution (the harness is the agent and the LLM drives the control flow) rather than
  `invoke_workflow`, and an in-process `invoke_agent` for a subagent, whose conventions say internal runners
  delegating to a sub-agent "should not be reported": a subagent here is a session of its own, with its own log, so
  it is reported.
- The message JSON shapes (`role`, `parts` with `type: text | tool_call | blob`, `finish_reason`) follow the
  conventions' input/output message schema as far as it was read; media is sent as a `blob` part with its type only.

Used since the engine was wired: `gen_ai.response.model` (the model that answered, from the ledger row).

Not used, deliberately: `gen_ai.response.id` (the Responses API's response ID is not stored), `server.address`,
`gen_ai.request.stream`, `gen_ai.conversation.compacted` (no definition found; compaction is a span of its own),
`gen_ai.system_instructions` and `gen_ai.tool.definitions` (the system prompt and tool list are large and frozen;
they are not content a trace needs). Everything else is in the `windlass.*` namespace (the brand's directory
name, `brand.ts`): the ledger's request ID and purpose, attempts, retry delays, the provider's request ID, HTTP
status and error code, effect classes, sandbox and approval facts, compaction, checks, spawned work.

## For the engine integrator

Live export is wired as this section describes (`engine/telemetry.ts`; `docs/architecture.md` says what it does
and what it does not). It is kept as the reasoning behind that wiring.

### Wiring live export

Live export should reuse `mapSession` rather than build spans a second way: spans derived from the log are the
record, and a live exporter that maps the log as it grows gives the same IDs as an export after the fact, so the two
never disagree. The loop needs no new writes for it.

- **Where to hook.** The engine's event stream (`engine/channel.ts`) already carries every durable event in order.
  A telemetry module subscribes to it per session (or reads `session.readEvents()` from a remembered `seq`), and
  maps the log at the points where a span closes. Spans are final at these durable events:
  - `execution.succeeded`, `execution.failed`, `execution.interrupted`: the execution and everything in it.
    Flushing here is enough for most users; it is the natural "end of a request".
  - `tool.settled`: a tool span. `spawn.ended`: a spawn span. `compaction.ended` / `compaction.failed`: a
    compaction. `checks.finished` / `checks.failed`: a run of checks.
  - A model call's span closes when its ledger row is finished (`finishRequest`), which has no event of its own; its
    finish reason arrives with `step.ended`, its retry with `retry.scheduled`. Export model calls with the step's
    terminal event (`step.ended`, `step.failed`, `step.refused`) or the next `step.started`.
  A span that is not closed must not be exported live (the after-the-fact export marks such spans open; live, wait).
  Keep a set of exported span IDs per session so each closed span is sent once.
- **Never slow or fail a turn.** Export runs off the loop: `createBackgroundExporter` is a bounded queue (oldest spans
  dropped and counted past its limit) whose `add` never waits or throws, in front of `exportOtlpHttp`, which never
  throws, times out every attempt and retries a bounded number of times. Mapping is pure but not free (it re-folds the
  log): map incrementally from the last closed execution, or at execution ends only. A collector that is down costs
  the queue's memory and nothing else. `Engine.close()` should flush with a short deadline and then drop what is left.
- **The configuration.** Two changes outside this module: add `telemetry: passed` to `baseFile` and
  `telemetry: parseTelemetrySection` to `FEATURE_SECTIONS` in `config/schema.ts` (and the type to `ConfigFile`), and
  resolve it in `createHarness` (`assembly.ts`) with `resolveTelemetryConfig(files.user?.telemetry,
  files.project?.telemetry, process.env)` from `LoadedConfig.files`, once per process (a header's `${VAR}` is read
  then). A `TelemetryConfigError` should be a notice, not a failure of the session. The `secrets` for content
  redaction are the engine's own (`ApprovalSetup.secrets`).
- **Subagents.** Live, the child's execution should be placed under the parent's spawn span: pass `placement` to
  `mapSession` for the child, with the context `mapSession` returned for the parent's spawn (`SpawnRef.context`).
  `mapSessionTree` shows the rule (the latest spawn of that child that started no later than the execution).
- **New events.** An event type the mapping has no rule for is counted in `MapResult.unknownEvents` and otherwise
  ignored. When an event is added to the schema, either give it a rule in `map.ts` or list it in `IGNORED_EVENTS`.

### What the log cannot provide today

- **The Responses API's response ID** (`gen_ai.response.id`). The provider's own ID of the request and the model
  that answered are on the ledger row since the engine was wired (`providerRequestId`, `responseModel`: the
  attributes `<namespace>.provider.request_id` and `gen_ai.response.model` of a `chat` span, for a call that
  finished as for one that failed); the response's ID is not.
- **Time to first token** (`gen_ai.response.time_to_first_chunk`): deltas are ephemeral. A ledger field for the
  first-chunk time would do.
- **When a model call's stream ended**, as an event: the ledger's `finishedAt` has it, so the chat span is right, but
  a live exporter cannot see it on the event stream.
- **A turn inside an execution.** One execution can hold several turns (a queued message is delivered under the same
  claim after `turn.ended`). The span is per execution, with `turn.ended` as span events; a span per turn would need
  the turn's start (the delivery after `turn.ended`) to be read as such, which the log allows but the conventions do
  not ask for.
- **The approval's wait** is an event pair (`approval.requested`, `approval.answered`), shown as span events and in
  `windlass.tool.wait_ms` (from the call to its start); the time a person took is the difference of the two
  events.
- **Cache writes** (`gen_ai.usage.cache_write.input_tokens`): the provider does not report them.
- **The process.** Host, process ID, harness version: not in the log. The resource has only `service.name`; live
  export can add `service.version` and `host.name` from the running process.
