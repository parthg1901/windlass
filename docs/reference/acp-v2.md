# ACP v2 reference for Windlass

This page is what an engineer needs to expose the Windlass core as an Agent Client Protocol (ACP) v2 agent over
stdio, and to build the harness's own CLI client on the same protocol. It was written on 2026-11-11.

**Sources and how they are cited**

| Tag | Source |
| --- | --- |
| `S:Name` | Definition `Name` in `schema/v2/schema.json` of `@agentclientprotocol/sdk` 2.5.0 (checkout `/home/ubuntu/projects/acp-typescript-sdk`, commit `74c7833`, generated from schema `v2.0.0-alpha.14`). A line number is given for the main shapes, e.g. `S:PromptRequest@7251`. |
| `U:Name` | Definition `Name` in `schema/v2/schema.unstable.json` (same checkout). |
| `meta` / `meta.u` | `schema/v2/meta.json` / `schema/v2/meta.unstable.json` (the method-name tables). |
| `sdk:path:line` | A file in the SDK checkout. |
| `doc:page#anchor` | `https://agentclientprotocol.com/protocol/v2/<page>.md`, read on 2026-11-11. |
| `mig` | `https://agentclientprotocol.com/protocol/v2/migration.md` (v1 to v2 guide). |
| `core:path` | `packages/core/src/<path>` in this repo. |

Anything marked **(inferred)** is my reading or recommendation, not stated by a source.

**Stability warning.** ACP v2 as a whole is a draft. The SDK README says both v2 entrypoints "remain experimental" and
"the v2 wire protocol and these SDK APIs may change incompatibly in any release" (`sdk:README.md`, "Experimental ACP
v2"). The migration guide says to "gate v2 support behind explicit version negotiation and feature flags until it
stabilizes" (`mig#scope-stable-v2-and-draft-features`). "Stable" below means "in `schema.json`", not "frozen". The
public site also has a `/protocol/v2/draft/` set of pages that is ahead of the SDK (it adds `subagent_update`,
`session_message` as stable updates); this page follows the SDK and the `/protocol/v2/` pages.

---

## 1. Transport and lifecycle

### 1.1 Framing over stdio (`doc:transports#stdio`)

- The client launches the agent as a subprocess. Agent reads JSON-RPC 2.0 from stdin, writes to stdout. UTF-8.
- One JSON object per line, delimited by `\n`; a message **MUST NOT** contain an embedded newline.
- stdout carries nothing but ACP messages. Logs go to stderr.
- **No batches.** A JSON array is rejected with one `-32600` response with `id: null` (`doc:transports#no-batches`).
- Request IDs are an integer or string and **MUST NOT** be `null`; each side picks its own IDs, so the same ID may be in
  flight in both directions (`S:RequestId`).
- Order: transports deliver in send order; receivers apply a session's `session/update` notifications in receive order
  (`doc:transports#message-order`).
- After `initialize` succeeds the agent may send requests and notifications at any time, even with no client request
  pending (`doc:transports#message-timing`).
- Shutdown: the client closes the agent's stdin. End of input ends the connection; its sessions stop being active; the
  agent **SHOULD** exit once its work is finished or stopped. The client may then SIGTERM/SIGKILL. Unanswered requests
  count as failed on both sides (`doc:transports#shutdown`).

### 1.2 Before initialization (`doc:initialization#before-initialization-completes`, `doc:error`)

- The client **MUST NOT** send anything but `initialize` first. The agent rejects other requests with `-32600` and
  ignores notifications. The agent **MUST NOT** send anything before its `initialize` response.
- A failed `initialize` leaves the connection uninitialized; the client may retry.
- The client **MAY** repeat `initialize` any number of times before its first other request (one at a time); the latest
  success is authoritative. `initialize` after any other request gets `-32600`.
- The SDK enforces all of this for you (`sdk:src/v2/acp.ts:648`, `agentInitializationGuard`).

### 1.3 `initialize` (client to agent)

Request `S:InitializeRequest@6397`:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | integer (uint16) | Latest version the client supports. Read first; missing/non-integer is `-32602`. |
| `info` | `Implementation` `{ name, title?, version }` | Required. |
| `capabilities?` | `ClientCapabilities` | Default `{}`. |
| `_meta?` | object | |

`S:ClientCapabilities@6438` has exactly two standard groups:
- `auth?.terminal?: {}`: the client can rerun the configured agent command in an interactive terminal (enables
  `type: "terminal"` auth methods).
- `elicitation?: { form?: {}, url?: {} }`: each mode is supported only when its key is a non-null object. Unlike MCP,
  `{}` for `elicitation` advertises no mode (`doc:initialization#elicitation`).

Response `S:InitializeResponse@2791`:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | integer | Highest version the agent supports that is `<=` the request. |
| `info` | `Implementation` | Required. |
| `capabilities?` | `AgentCapabilities` | Default `{}`. |
| `authMethods?` | `AuthMethod[]` | Non-empty means the agent **MUST** implement `auth/login` and `auth/logout`. |

`S:AgentCapabilities@2874`: `session?: SessionCapabilities`, `auth?: AgentAuthCapabilities` (extensions only; does not
advertise login/logout). `S:SessionCapabilities@2910`:

| Field | Meaning when a non-null object |
| --- | --- |
| *(the `session` object itself)* | Baseline: `session/new`, `session/list`, `session/resume`, `session/close`, `session/prompt`, `session/cancel`, `session/update`. All seven are required if `session` is present. |
| `prompt.image` / `prompt.audio` / `prompt.embeddedContext` | Prompt may carry `image` / `audio` / `resource` blocks. `text` and `resource_link` are always allowed. |
| `mcp.stdio` / `mcp.http` | MCP transports accepted in `mcpServers`. |
| `delete` | `session/delete` exists. |
| `additionalDirectories` | `additionalDirectories` accepted on `session/new` and `session/resume`. |
| `systemPrompt` (+ `mode.override`) | `systemPrompt` accepted in `append` mode (and `override`). |

All support markers are objects: `{}` = supported, omitted or `null` = unsupported (`mig#support-markers-are-objects-not-booleans`).
Receivers ignore unknown capability fields. An agent **MUST NOT** send `capabilities.session: { "_meta": ... }` unless
it supports all seven baseline methods (`doc:extensibility#advertising-custom-capabilities`).

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":2,"info":{"name":"windlass-cli","version":"0.1.0"},"capabilities":{"auth":{"terminal":{}},"elicitation":{"url":{}}}}}
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":2,"info":{"name":"windlass","version":"0.1.0"},"capabilities":{"session":{"prompt":{"image":{},"embeddedContext":{}},"mcp":{"stdio":{},"http":{}}}},"authMethods":[{"type":"agent","methodId":"chatgpt","name":"Sign in with ChatGPT"}]}}
```

### 1.4 Protocol version handling (`doc:initialization#version-negotiation`)

- The version is one integer, a major version, bumped only for breaking changes (`S:ProtocolVersion`). SDK constant
  `PROTOCOL_VERSION = 2` (`sdk:src/v2/schema/index.ts:235`).
- Agent selects the highest supported version `<=` requested. If none, reject with `-32022` and
  `data: { requested, supported: [...] }` (`S:UnsupportedProtocolVersionErrorData`). A client asking for v1 from a
  v2-only agent gets exactly this.
- If the requested version is newer than the selected one, the agent **MUST** ignore params it cannot parse rather
  than reject.
- The client checks the returned version and disconnects if unsupported.
- To serve v1 and v2 on one binary, the SDK has `agentProtocolRouter().withV1(a1).withV2(a2).connect(stream)`
  (`sdk:src/protocol-router.ts:308`, used in `sdk:src/examples/dual-version-agent.ts:202`). Windlass only needs v2
  **(inferred)**: our only planned client is our own.

### 1.5 Authentication (`doc:authentication`)

`S:AuthMethod@3222` is a tagged union on `type`:

| `type` | Shape | Flow |
| --- | --- | --- |
| `"agent"` (`S:AuthMethodAgent@3379`) | `{ methodId, name, description? }` | Client calls `auth/login { methodId }`. The agent runs the flow. |
| `"terminal"` (`S:AuthMethodTerminal`) | `{ methodId, name, description?, args?: string[], env?: {name,value}[] }` | Client reruns the agent's own launch command plus `args`/`env` in an interactive terminal; exit 0 = success. Client **MUST NOT** call `auth/login` with it. Only advertise if the client sent `capabilities.auth.terminal`. |
| `"_..."` | custom | |

Methods (both client to agent; `meta`):

| Method | Params | Result | Errors |
| --- | --- | --- | --- |
| `auth/login` | `S:LoginAuthRequest@6570` `{ methodId, _meta? }` | `{}` (`S:LoginAuthResponse`) | `-32602` unknown or terminal method; `-32000` login failed/abandoned; `-32800` cancelled by `$/cancel_request` |
| `auth/logout` | `S:LogoutAuthRequest` `{ _meta? }` | `{}` | |

Rules:
- While auth is required, any request except `initialize`, `auth/login`, `auth/logout` may fail with `-32000`.
- `auth/login` may stay pending while the user completes an interactive flow.
- After `auth/logout`, what happens to running sessions is unspecified (`doc:authentication#active-sessions`).
- An auth failure after a prompt was inserted is not a prompt error: respond with the `messageId`, then report
  `state_update` idle with `stopReason: "error"` and `error.code: -32000`
  (`doc:authentication#authentication-failures-during-session-work`).

**How an OAuth browser sign-in (ChatGPT) should be advertised and run.** Advertise one `type: "agent"` method. On
`auth/login`, keep the request pending and either:
1. run the flow yourself: start the local callback listener and open the system browser, then answer `{}` when tokens
   are stored. The doc names this explicitly: "The Agent can run that flow itself, for example by opening a local
   browser" (`doc:authentication#agent-handled-authentication`); or
2. if the client advertised `elicitation.url`, send `elicitation/create` in `url` mode scoped to the login request with
   `requestId` = the `auth/login` request's id, pointing at the authorize URL, and answer `auth/login` when the
   callback lands. Optionally send `elicitation/complete` with the `elicitationId` when done
   (`doc:elicitation#url-mode`). URL mode "is not a substitute for authorizing the Client's access to the Agent", but
   the agent "can still use it during `auth/login` to sign in to its own provider".

Credentials or tokens obtained through URL mode **MUST NOT** be sent back to the client (`doc:elicitation#url-mode`).
Form mode **MUST NOT** be used for secrets. Option 2 works over SSH where the agent cannot open a browser; option 1
does not **(inferred)**. A `type: "terminal"` method (`args: ["login"]`) is a third option our own CLI can support
**(inferred)**.

---

## 2. Every stable v2 method and notification

Direction: `meta.agentMethods` are handled by the agent (client to agent); `meta.clientMethods` are handled by the
client (agent to client); `$/cancel_request` goes both ways (`meta`).

| Method | Kind | Direction | Params / result definitions |
| --- | --- | --- | --- |
| `initialize` | request | C→A | `InitializeRequest` / `InitializeResponse` (§1.3) |
| `auth/login` | request | C→A | §1.5 |
| `auth/logout` | request | C→A | §1.5 |
| `session/new` | request | C→A | `NewSessionRequest@6607` / `NewSessionResponse@3437` |
| `session/resume` | request | C→A | `ResumeSessionRequest@6930` / `ResumeSessionResponse@4010` |
| `session/list` | request | C→A | `ListSessionsRequest@6871` / `ListSessionsResponse@3909` |
| `session/close` | request | C→A | `CloseSessionRequest@7059` / `{}` |
| `session/delete` | request | C→A | `DeleteSessionRequest@6907` / `{}`; needs `session.delete` |
| `session/set_config_option` | request | C→A | `SetSessionConfigOptionRequest@7144` / `{ configOptions }` |
| `session/prompt` | request | C→A | `PromptRequest@7251` / `PromptResponse@4107` |
| `session/cancel` | notification | C→A | `CancelSessionNotification@7697` |
| `tool_call/cancel` | request | C→A | `CancelToolCallRequest@7082` / `{}` |
| `terminal/cancel` | request | C→A | `CancelTerminalRequest@7113` / `{}` |
| `session/update` | notification | A→C | `UpdateSessionNotification@4367` (§3) |
| `session/request_permission` | request | A→C | `RequestPermissionRequest@198` / `RequestPermissionResponse` (§5) |
| `elicitation/create` | request | A→C | `CreateElicitationRequest@1790` / `CreateElicitationResponse@7501` (§5) |
| `elicitation/complete` | notification | A→C | `CompleteElicitationNotification@6221` `{ elicitationId }` |
| `$/cancel_request` | notification | both | `CancelRequestNotification@7720` `{ requestId }` |

Every params object also accepts `_meta?` (omitted below). "`?`" means optional; most optional fields also accept
`null` with the same meaning as omission unless stated.

### 2.1 `session/new`

Params: `cwd` (absolute path, required; relative is `-32602`), `additionalDirectories?: AbsolutePath[]`,
`mcpServers?: McpServer[]`, `systemPrompt?: { mode: "append"|"override"|"_...", content: ContentBlock[] }`
(`S:SystemPrompt@6823`; text blocks only, non-empty; only if advertised).

`S:McpServer@6657`: `{ type:"stdio", name, command: AbsolutePath, args?, env?: {name,value}[] }` or
`{ type:"http", name, url, headers?: {name,value}[] }`. Names unique; unadvertised transport or v1 `sse` is `-32602`
(`doc:session-setup#mcp-servers`). The SDK helper `assertSupportedMcpServers(servers, caps.session?.mcp)` does the
check (`sdk:src/v2/acp.ts:790`).

Result: `sessionId`, `configOptions?: SessionConfigOption[]`, `availableCommands?: AvailableCommand[]`. Senders use an
array, never `null`. If the session has options or commands the response **MUST** include them, because it replaces
the client's lists (`doc:session-setup#initial-session-state`). New sessions are `idle` until a `state_update` says
otherwise. Agents **SHOULD NOT** send session-scoped requests before this response.

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/home/u/proj","mcpServers":[]}}
{"jsonrpc":"2.0","id":1,"result":{"sessionId":"ses_01H","configOptions":[{"type":"select","configId":"model","name":"Model","category":"model","currentValue":"gpt-5","options":[{"value":"gpt-5","name":"GPT-5"}]}],"availableCommands":[{"type":"command","name":"compact","description":"Compact the context now"}]}}
```

### 2.2 `session/resume`

Params: `sessionId`, `cwd` (must be the session's cwd; may be rejected `-32602` otherwise), `additionalDirectories?`
(complete new list), `mcpServers?` (complete set; do not restore old ones), `replayFrom?: ReplayFrom`, `systemPrompt?`.
`S:ReplayFrom@6999` = `{ type: "start" }` or `{ type: "_..." }`. Unsupported or malformed cursor: `-32602`, never a
silent substitute.

Result: `{ configOptions?, availableCommands? }`. Before the result the agent **MUST** send, in order: the replay (only
if `replayFrom` was given), current `terminal_update`/`tool_call_update` for each background item the replay did not
cover, then one current `state_update`. It **SHOULD** also send a current `session_info_update` and **MAY** send a
current `usage_update` (`S:ResumeSessionResponse@4010`, `doc:session-setup#current-state-synchronization`). Unknown or
deleted session: `-32002` with `data.sessionId`. Resuming an already active session re-synchronizes it. Details in §6.

```json
{"jsonrpc":"2.0","id":2,"method":"session/resume","params":{"sessionId":"ses_01H","cwd":"/home/u/proj","replayFrom":{"type":"start"}}}
... session/update notifications (replay) ...
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_01H","update":{"sessionUpdate":"state_update","state":"idle","stopReason":"end_turn"}}}
{"jsonrpc":"2.0","id":2,"result":{}}
```

### 2.3 `session/list`

Params: `cwd?` (exact match, not subdirectories), `cursor?` (opaque). Result `S:ListSessionsResponse@3909`:
`sessions: SessionInfo[]`, `nextCursor?` (absent or `null` = last page; `""` is a valid cursor). `S:SessionInfo@3944`:
`{ sessionId, cwd, additionalDirectories?, title?, updatedAt? (RFC 3339), _meta? }`. Bad cursor: `-32602`
(`doc:error#invalid-parameters`).

```json
{"jsonrpc":"2.0","id":3,"method":"session/list","params":{"cwd":"/home/u/proj"}}
{"jsonrpc":"2.0","id":3,"result":{"sessions":[{"sessionId":"ses_01H","cwd":"/home/u/proj","title":"Fix tests","updatedAt":"2026-11-11T10:00:00Z"}]}}
```

### 2.4 `session/close`

Params `{ sessionId }`. The agent cancels ongoing work as if `session/cancel`, **also stops background work**, answers
pending permission requests and elicitations of the session with `$/cancel_request`, answers prompts not yet inserted
with `-32800` (inserted ones succeed), and sends the final updates and the idle `state_update` with
`stopReason: "cancelled"` **before** the `{}` response if foreground work was active. After the response, nothing more
for that session on this connection. Unknown or inactive session: **SHOULD** succeed; clients treat `-32002` as
success (`S:CloseSessionRequest@7059`, `doc:session-setup#closing-active-sessions`). Closing does not discard the
session.

### 2.5 `session/delete` (needs `session.delete`)

Params `{ sessionId }`, result `{}`. Removes it from `session/list`; an active session is closed first; later requests
for it, including `session/resume`, get `-32002`. Deleting an unknown session **SHOULD** succeed (`mig#method-changes`,
`doc:error#unknown-sessions`).

### 2.6 `session/set_config_option`

Params `S:SetSessionConfigOptionRequest@7144`: `{ sessionId, configId, type: "id", value: string }` or
`{ sessionId, configId, type: "boolean", value: boolean }` or `{ type: "_...", value: any }`. Result:
`{ configOptions }`, the full list. Unknown `configId`, bad value or mismatched `type`: `-32602`, config unchanged.
Required for any agent that advertises config options.

`S:SessionConfigOption@3478`: `{ configId, name, description?, category?, type: "select", currentValue, options }` or
`{ ..., type: "boolean", currentValue: boolean }`. `options` is a flat `{ value, name, description? }[]` or groups
`{ groupId, name, options }[]`. `category` ∈ `mode | model | model_config | thought_level | _...` is UX only. Session
modes from v1 are now a `select` with `category: "mode"`.

```json
{"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":"ses_01H","configId":"model","type":"id","value":"gpt-5"}}
```

### 2.7 `session/prompt` and `session/cancel`

See §4. `PromptRequest`: `{ sessionId, prompt: ContentBlock[] }` (non-empty). `PromptResponse`: `{ messageId }`
(required). `session/cancel`: `{ sessionId }`; ignored for a session that is not active.

### 2.8 `tool_call/cancel` and `terminal/cancel`

Params `{ sessionId, toolCallId }` / `{ sessionId, terminalId }`, result `{}`. The client may send it only while the
entity advertises `capabilities.cancel` (on `tool_call_update` / `terminal_update`). The response means "accepted", not
"stopped". The agent confirms with a final `tool_call_update` (normally `cancelled`; `completed`/`failed` if it won the
race) or a `terminal_update` with `exitStatus`. Unknown, final or not cancellable: `-32602`. Neither changes the
foreground state. Cancelling a terminal stops the process but does not change the status of a tool call that
references it (`S:CancelToolCallRequest@7082`, `S:CancelTerminalRequest@7113`). The SDK answers both with `-32602`
automatically if you register no handler (`sdk:src/v2/acp.ts:612`).

### 2.9 `$/cancel_request` (`doc:cancellation`)

`{ requestId }` names a request the **sender** issued. The receiver **MAY** cancel, **MUST** still send exactly one
response, ignores unknown or answered IDs. A cancelled request is answered with the method's cancellation result where
one exists (an inserted prompt's `messageId`; permission outcome `cancelled`; elicitation action `cancel`), otherwise
`-32800`. Internal cancellation (timeouts, shutdown) uses the same responses.

### 2.10 Error codes (`S:ErrorCode@4168`, `doc:error`)

`-32700` parse, `-32600` invalid request (also pre-init and late `initialize`), `-32601` method not found (also a
capability-gated method you did not advertise), `-32602` invalid params, `-32603` internal, `-32800` request cancelled,
`-32000` auth required, `-32002` resource not found (sessions: `data: { sessionId }`, a **MUST**), `-32022` unsupported
protocol version. Implementation errors **SHOULD** avoid `-32768..-32000` and `-32899..-32800`. SDK factories:
`RequestError.invalidParams`, `.methodNotFound`, `.internalError`, `.requestCancelled`, `.authRequired`,
`.sessionNotFound(sessionId)`, `.unsupportedProtocolVersion` (`sdk:src/core/jsonrpc.ts:1469-1590`).

---

## 3. `session/update` in full

Envelope `S:UpdateSessionNotification@4367`: `{ sessionId, update: SessionUpdate, _meta? }`. `S:SessionUpdate@4398` is
discriminated by `update.sessionUpdate`. A per-notification `_meta` goes in `params._meta`; per-entity metadata in
`update._meta` (§8.2).

**Entity model** (`doc:prompt-lifecycle#entity-ids`). Messages, tool calls, terminals, plans and compactions are
entities keyed by **(type, id)**. IDs are unique per type per session, never reused for another entity of that type.
User, agent and thought messages are three separate types even though they all use `messageId`. The first update or
chunk for an unseen ID creates the entity with defaults and **fixes its timeline position**; later updates patch in
place without moving it, even after `idle`. Clients must not drop a chunk for an unknown ID.

**Patch semantics** for upserts: omitted = unchanged, `null` = clear/reset to default, value = replace; arrays replace
whole (`[]` or `null` clears); top-level `_meta` is a key-level patch (§8.2).

| `sessionUpdate` | Definition | Fields (required in bold) |
| --- | --- | --- |
| `user_message_chunk` | `S:ContentChunk@4914` | **`messageId`**, **`content: ContentBlock`** (appends) |
| `user_message` | `S:UserMessage@4943` | **`messageId`**, `content?: ContentBlock[]` (replaces), `_meta?` (patch) |
| `agent_message_chunk` | `S:ContentChunk` | **`messageId`**, **`content`** |
| `agent_message` | `S:AgentMessage` | **`messageId`**, `content?`, `_meta?` |
| `agent_thought_chunk` | `S:ContentChunk` | **`messageId`**, **`content`** |
| `agent_thought` | `S:AgentThought` | **`messageId`**, `content?`, `_meta?` |
| `state_update` | `S:StateUpdate@5392` | **`state`**: `running` / `idle` / `requires_action` / `_...`; `background?`; idle adds `stopReason?`, and `error?` when `stopReason: "error"` |
| `tool_call_update` | `S:ToolCallUpdate@327` | **`toolCallId`**, `name?`, `title?`, `kind?`, `status?`, `content?`, `locations?`, `rawInput?`, `rawOutput?`, `capabilities?`, `_meta?` |
| `tool_call_content_chunk` | `S:ToolCallContentChunk@5492` | **`toolCallId`**, **`content: ToolCallContent`** (appends one item) |
| `terminal_update` | `S:TerminalUpdate@5625` | **`terminalId`**, `command?`, `cwd?`, `output?: { data: base64 }` (replacement snapshot), `exitStatus?: { exitCode?, signal? }`, `size?: { cols, rows }`, `capabilities?`, `_meta?` |
| `terminal_output_chunk` | `S:TerminalOutputChunk@5711` | **`terminalId`**, **`data`** (independently base64-encoded bytes, appended) |
| `plan_update` | `S:PlanUpdate@5914` | **`plan`**: `{ type: "items", planId, entries: PlanEntry[] }` (complete list, replaces) |
| `available_commands_update` | `S:AvailableCommandsUpdate` | **`availableCommands: AvailableCommand[]`** (complete list) |
| `config_option_update` | `S:ConfigOptionUpdate@5956` | **`configOptions: SessionConfigOption[]`** (complete list) |
| `session_info_update` | `S:SessionInfoUpdate@5977` | `title?`, `updatedAt?`, `_meta?` (patch) |
| `usage_update` | `S:UsageUpdate@6022` | **`used`** (tokens in context), **`size`** (context window), `cost?: { amount, currency }` (patch) |
| `notice` | `S:Notice@6084` | **`severity`**: `info`/`warning`/`error`/`_...`, **`title`** (non-empty), `description?` |
| `compaction_update` | `S:CompactionUpdate@6149` | **`compactionId`**, **`status`**: `in_progress`/`completed`/`failed`/`cancelled`, `summary?: ContentBlock[]`, `error?: string`, `_meta?` |
| `compaction_summary_chunk` | `S:CompactionSummaryChunk@6192` | **`compactionId`**, **`content: ContentBlock`** |
| `_...` | custom | `sessionUpdate` beginning with `_` |

There is **no** `tool_call`, `plan`, or `current_mode_update` in v2 (removed, `mig#session-update-variant-changes`).

### 3.1 Messages (`doc:prompt-lifecycle#message-ids`)

- Every chunk and update carries `messageId`.
- Order per `messageId`: an update with `content` replaces everything accumulated (including chunks); a chunk appends to
  whatever is current; an update without `content` changes only other fields. Example: `agent_message [A]`, chunk `B`
  gives `[A,B]`; then `agent_message [C]` gives `[C]`.
- A chunk's `_meta` is chunk-scoped (not a patch).

```json
{"sessionUpdate":"agent_message_chunk","messageId":"m7.0","content":{"type":"text","text":" Let me check"}}
{"sessionUpdate":"agent_thought","messageId":"m7.r0","content":[{"type":"text","text":"Inspect the loop first."}]}
```

### 3.2 Tool calls (`doc:tool-calls`)

The first `tool_call_update` for a `toolCallId` creates it with defaults: `status: "pending"`, `kind: "other"`,
`content` and `locations` empty, `title`, `name`, `rawInput`, `rawOutput` unset. Send `title` (and `name`) on the first
update.

`S:ToolKind@424`: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`,
`_...` (unknown is shown as `other`).

`S:ToolCallStatus@484`: `pending` (not started: input streaming, awaiting approval, scheduled), `in_progress`, `paused`
(started, not running, will resume), `completed`, `failed`, `cancelled`, `_...` (unknown shown as in progress). Final
statuses are `completed`/`failed`/`cancelled`. Statuses never go back to `pending`. Work that continues after a final
status needs a new tool call. When foreground work ends (done, cancelled or failed), the agent **SHOULD** give each of
its unfinished tool calls a final status.

`S:ToolCallContent@524` (items of `content`):
- `{ type: "content", content: ContentBlock }`: text, image, resource.
- `{ type: "diff", changes: DiffChange[], patch?: { format: "git_patch", text } }` (`S:Diff@1531`).
  `S:DiffChange@1234`: `{ operation: "add"|"delete"|"modify", path }` or `{ operation: "move"|"copy", oldPath, path }`,
  plus `fileType?` (`text`/`binary`/`directory`/`symlink`) and `mimeType?`. `changes` is authoritative; `patch` is
  `diff --git` text with **absolute paths everywhere** and **SHOULD** be provided when feasible.
- `{ type: "terminal", terminalId }`: display anchor only; state arrives through `terminal_update` and
  `terminal_output_chunk`, in either order relative to the anchor.
- `{ type: "_..." }`.

`S:ToolCallLocation`: `{ path: AbsolutePath, line?: integer >= 1 }`. `capabilities?: { cancel?: {} }` enables
`tool_call/cancel`. `rawInput`/`rawOutput`: any JSON; `null` clears.

```json
{"sessionUpdate":"tool_call_update","toolCallId":"m7/call_1","name":"apply_patch","title":"Edit src/a.ts","kind":"edit","status":"pending","rawInput":{"path":"/home/u/proj/src/a.ts"},"locations":[{"path":"/home/u/proj/src/a.ts","line":12}]}
{"sessionUpdate":"tool_call_update","toolCallId":"m7/call_1","status":"completed","content":[{"type":"diff","changes":[{"operation":"modify","path":"/home/u/proj/src/a.ts","fileType":"text"}],"patch":{"format":"git_patch","text":"diff --git /home/u/proj/src/a.ts /home/u/proj/src/a.ts\n--- /home/u/proj/src/a.ts\n+++ /home/u/proj/src/a.ts\n@@ ..."}}]}
{"sessionUpdate":"terminal_update","terminalId":"t1","command":"bun test","cwd":"/home/u/proj","exitStatus":{"exitCode":0}}
```

`git_patch` rules (`S:DiffPatchFormat`): every path absolute, including `rename from/to` and `copy from/to`; **no**
`a/`/`b/` prefixes; `/dev/null` for the missing side of an add or delete; Git-style quoting; each unquoted path equals
the matching `changes` path; no commit metadata or mail envelope. So `git diff` output must be rewritten before use.

### 3.3 State and background work (`doc:prompt-lifecycle#session-states`, `#background-work`)

- `running`: foreground work in progress. `idle`: none (background may continue). `requires_action`: the foreground
  workflow as a whole is blocked on the user.
- **MUST** report `running` (or `requires_action`) when foreground work starts and `idle` when it ends; **SHOULD**
  include `stopReason` on that idle. After `requires_action`, **MUST** report `running` when progress resumes. Two
  consecutive turns have an idle boundary between them.
- Snapshots are idempotent; a repeated idle is not a new completion.
- `background?: BackgroundWork[]` (`S:BackgroundWork@5033`): `{ type: "terminal", terminalId }` or
  `{ type: "tool_call", toolCallId }`. Omitted = not reported (not "nothing running"); `[]` = nothing. Once you report
  it, include it on **every** `state_update`. Announce each item (its `terminal_update`/`tool_call_update`) before the
  first list that names it, and finalize it before the list that drops it. Process-backed work is listed as its
  terminal only. `session/cancel` does not touch listed work; `session/close` does.

Stop reasons (`S:IdleStateUpdate@5187`): `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`,
`error` (+ `error: { code, message, data? }`), `_...`. `cancelled` means the user or client chose to stop, never a
limit or failure.

### 3.4 Plans, commands, info, usage, notices, compaction

- **Plan**: `{ type: "items", planId, entries }`, `S:PlanEntry@5797` = `{ content, priority: high|medium|low|_..., status: pending|in_progress|completed|cancelled|_... }`.
  Send the complete list each time. Plan `_meta` is not a patch.
- **Commands** `S:AvailableCommand@3755`: `{ type: "command", name (no "/", no whitespace, unique), description, input?: { type: "text", hint } }`.
  The user invokes one by typing `/name ...` in a prompt (`doc:slash-commands`). A locally handled command still uses
  the full lifecycle: insertion, then `running`, then `idle(end_turn)` (`doc:prompt-lifecycle#work-boundaries-and-local-commands`).
- **Session info**: `title`, `updatedAt` (RFC 3339), `_meta` patch. Send a current one on resume.
- **Usage**: `used`/`size` are the current context tokens and window; `cost` is cumulative (patch). There is **no
  stable field for input/output/cache token counts**; see §7 `U:Usage`.
- **Notice**: live only, never replayed, may be ignored; **MUST NOT** carry anything needed for correctness. Use it for
  recovered failures such as a retried model call (`doc:prompt-lifecycle#failures`).
- **Compaction**: one entity per compaction. A single `compaction_update` with `status: "completed"` suffices. `summary`
  is user-displayable retained summary, not "Compaction completed" and not hidden prompt framing. It does not tell the
  client to drop earlier history. Compactions are replayed.

---

## 4. The prompt turn

### 4.1 Content blocks a client may send (`S:ContentBlock@624`, `doc:content`)

| `type` | Shape | Gate |
| --- | --- | --- |
| `text` | `{ text, annotations? }` | always (agents **MUST** support) |
| `resource_link` | `{ name, uri, title?, description?, icons?, mimeType?, size?, annotations? }` | always |
| `image` | `{ data: base64, mimeType, uri?, annotations? }` | `session.prompt.image` |
| `audio` | `{ data: base64, mimeType, annotations? }` | `session.prompt.audio` |
| `resource` | `{ resource: { uri, text, mimeType? } \| { uri, blob: base64, mimeType? }, annotations? }` | `session.prompt.embeddedContext` |
| `_...` | custom | custom capability in `capabilities.session.prompt._meta` |

An empty `prompt` array may be rejected `-32602`. A block that is neither baseline nor advertised, or not understood,
**MUST** be rejected `-32602` without inserting (`doc:prompt-lifecycle#1-user-message`). `Annotations` =
`{ audience?: Role[], lastModified?, priority?: 0..1 }`.

### 4.2 What the response means: acceptance = insertion

This is the biggest change from v1 (`doc:prompt-lifecycle#2-prompt-accepted`, `S:PromptResponse@4107`).

- `session/prompt` stays pending **until the user message is inserted** into the conversation, then returns
  `{ messageId }`. It does **not** wait for the turn to finish. "Receipt, queueing, and assigning an ID are not
  insertion."
- Once inserted, the agent **MUST NOT** return an error, even if work fails or `$/cancel_request` arrives first.
- The agent **MUST** also emit `user_message` (or chunks) with the same `messageId`, never before insertion. Order
  relative to the response is not fixed; clients reconcile by ID.
- Completion is reported only by `state_update` idle with a stop reason.
- Rejected before insertion (hook, validation, auth, early failure): JSON-RPC error, no user-message updates.
  `$/cancel_request` before insertion: `-32800`.
- Insertion is not a durability promise; if retained and replayed, the message keeps its ID.

### 4.3 Prompts during active work (`doc:prompt-lifecycle#prompts-during-active-work`)

Clients **MAY** prompt in any state. The agent inserts right away **or holds it** and inserts later, in receive order.
"What inserting during active work means, such as steering the current turn or starting the next one, is up to the
Agent." Agents **MUST NOT** reject a prompt only because work is active. A held prompt's response stays pending until
insertion; the client can withdraw it with `$/cancel_request`; `session/cancel` and `session/close` answer held prompts
with `-32800`. "Future capabilities may let Agents advertise steering or queueing behavior." There is no standard
per-prompt steer/queue choice today.

### 4.4 A complete turn

```
C→A  session/prompt {id:5, sessionId, prompt:[{type:"text",text:"fix the test"}]}
A→C  session/update state_update {state:"running"}             (may precede insertion)
A→C  result {id:5, messageId:"u12"}                             (after insertion)
A→C  session/update user_message {messageId:"u12", content:[...]}
A→C  session/update agent_thought_chunk / agent_message_chunk ...
A→C  session/update tool_call_update {toolCallId, status:"pending", ...}
A→C  session/request_permission {id:"p1", ...}  +  state_update {state:"requires_action"}
C→A  result {id:"p1", outcome:{outcome:"selected", optionId:"allow-once"}}
A→C  state_update {state:"running"} ; tool_call_update in_progress ... completed
A→C  session/update usage_update {used, size}
A→C  session/update state_update {state:"idle", stopReason:"end_turn"}
```

Failure after insertion: idle with `stopReason: "error"` and `error`, after giving unfinished tool calls `failed`
(`doc:prompt-lifecycle#failures`). Clients detect a dead process or lost connection themselves.

### 4.5 Cancellation, both sides (`doc:prompt-lifecycle#cancellation`)

`session/cancel { sessionId }` covers the foreground work and the prompts received **before it** that are not yet
inserted. A prompt received after it is unaffected. Listed background work keeps running.

Agent **MUST**:
1. Answer every covered held prompt with `-32800`. Already inserted prompts keep their successful `messageId`.
2. Stop waiting for that work's pending `session/request_permission` requests and treat them as not approved;
   **SHOULD** send `$/cancel_request` for each so the client dismisses the prompt. Same for elicitations
   (`doc:elicitation#session-cancellation`).
3. **SHOULD** stop model requests and tool invocations of that work as soon as possible.
4. Send any content and tool-call updates (final statuses, normally `cancelled`) **before** the final idle.
5. Then send `state_update { state: "idle", stopReason: "cancelled" }`, if foreground work was active when the cancel
   took effect. If idle, nothing is required.
6. Catch abort exceptions from the provider library and report `cancelled`, **not** `error`.
7. Ignore late permission or elicitation answers instead of resuming the cancelled work.

Client **SHOULD** mark its non-final, non-background tool calls `cancelled` locally right away (a display hint that
the agent's updates override), **SHOULD** still accept tool-call updates after the cancel, and **MAY** answer pending
permission requests of the cancelled work with `cancelled` without waiting for `$/cancel_request`.

---

## 5. Permissions and elicitation

### 5.1 `session/request_permission` (A→C)

Params `S:RequestPermissionRequest@198`: `sessionId`, `title` (required prompt text, does not retitle anything),
`description?`, `subject?`, `options: PermissionOption[]` (at least one).

`S:RequestPermissionSubject@253`:
- `{ type: "tool_call", toolCall: ToolCallUpdate }`: the client applies `toolCall` exactly like a `tool_call_update`, in
  order, before showing the prompt; a first-seen ID creates the tool call.
- `{ type: "command", command, cwd: AbsolutePath, toolCallId?, terminalId? }`: allow means the **agent** runs it.
- `{ type: "_..." }`.

`S:PermissionOption@1723`: `{ optionId (unique in request), name, kind }`. `S:PermissionOptionKind@1760`: `allow_once`,
`allow_always`, `reject_once`, `reject_always`, `_...`.

Response `S:RequestPermissionOutcome@7394`: `{ outcome: { outcome: "selected", optionId } }` or
`{ outcome: { outcome: "cancelled" } }` (cancelled work, dismissed, or declined by policy). An `optionId` that was not
offered, or an unknown outcome, **MUST** be treated as not approved. After `cancelled` the agent **MUST NOT** proceed.

**"Allow always"** is expressed only as an option whose `kind` is `allow_always`. **The agent owns the remembered
decision**: it stores it, chooses its scope (tool, command, directory) and lifetime, and applies it by not asking
again. Clients **SHOULD NOT** infer scope from `kind`; the agent **SHOULD** state the scope in the option `name` and
not apply it beyond that (`doc:tool-calls#permission-options`, `#security`). Automatic approval **SHOULD NOT** allow a
request with an absent or unknown subject unless the user's policy allows everything.

State: while blocked on the answer, **SHOULD** report `requires_action`; **MUST** report `running` when progress
resumes. A permission request for background work does not change the state and **SHOULD** reference the listed item.

```json
{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"ses_01H","title":"Run bun test?","subject":{"type":"command","command":"bun test","cwd":"/home/u/proj","toolCallId":"m7/call_2"},"options":[{"optionId":"once","name":"Allow once","kind":"allow_once"},{"optionId":"always","name":"Always allow `bun test` in this project","kind":"allow_always"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}
{"jsonrpc":"2.0","id":"p1","result":{"outcome":{"outcome":"selected","optionId":"always"}}}
```

SDK: `client.request(methods.client.session.requestPermission, params, { cancellationSignal, stopWaitingOnCancel: true })`
sends `$/cancel_request` on abort and rejects at once with `-32800`; the late answer is dropped
(`sdk:src/core/jsonrpc.ts:76-107`, used in `sdk:src/examples/dual-version-agent.ts:365`).

### 5.2 `elicitation/create` (A→C) and `elicitation/complete`

Params `S:CreateElicitationRequest@1790`: `message` plus one mode, and exactly one scope:
- scope: `{ sessionId, toolCallId? }` (session) or `{ requestId }` (tied to a pending client-to-agent request, e.g.
  `auth/login`, outside any session). This union is closed.
- `mode: "form"`, `requestedSchema: { type: "object", title?, description?, properties: { [k]: string|number|integer|boolean|array schema }, required? }`
  (`S:ElicitationSchema`). Single-select = string with `enum` or `oneOf: [{ const, title }]`; multi-select = `array`.
- `mode: "url"`, `elicitationId`, `url`.

Only use a mode the client advertised. Never fall back from URL to form for something sensitive.

Response `S:CreateElicitationResponse@7501`: `{ action: "accept", content?: { [k]: value } }`, `{ action: "decline" }`,
`{ action: "cancel" }`, or `_...` (unknown is handled as `cancel`). For URL mode, `accept` only means the user agreed to
open the URL. `elicitation/complete { elicitationId }` (notification, A→C) **MAY** follow when the external step is
done; it is not a state update.

```json
{"jsonrpc":"2.0","id":"e1","method":"elicitation/create","params":{"requestId":1,"mode":"url","elicitationId":"el-1","url":"https://auth.openai.com/oauth/authorize?...","message":"Sign in with ChatGPT"}}
{"jsonrpc":"2.0","id":"e1","result":{"action":"accept"}}
{"jsonrpc":"2.0","method":"elicitation/complete","params":{"elicitationId":"el-1"}}
```

---

## 6. Session persistence

What the agent must do (`doc:session-setup#session-lifecycle`, `#resuming-sessions`, `#replay-contents`):

- **Active vs existing.** A session exists until the agent discards it. It is *active on a connection* from a
  successful `session/new` or `session/resume` until `session/close` or connection end. Session-scoped requests on an
  inactive session get `-32002` with `data.sessionId`. When a connection ends the agent **MAY** continue or cancel the
  work; a later resume reports the result in its state snapshot. Whether a session may be active on two connections is
  up to the agent.
- **resume** is mandatory with `session` and replaces v1 `session/load`. Without `replayFrom` it **MUST NOT** replay
  history. With `{ type: "start" }` it **MUST** replay all retained history as ordinary `session/update`s before
  responding, then synchronize state (§2.2).
- **Replay contents.** Same updates and semantics as live: messages, tool calls, terminals, plans, compactions. You may
  send each entity's current state instead of its history (a whole `agent_message` instead of chunks, a terminal
  `output` snapshot). A replayed tool call whose work is not running **SHOULD** have a final status. **Not replayed**:
  historical `state_update`, notices, pending permission requests and elicitations. Historical `usage_update`,
  `session_info_update`, `config_option_update`, `available_commands_update` need not be replayed (send current ones).
- **IDs on replay.** A user message inserted by `session/prompt` **MUST** keep the `messageId` that prompt returned,
  even after an agent restart. Other entity IDs **SHOULD** be preserved. Clients rebuild from a full replay rather than
  merge by ID.
- **Chunked replay** of a message **MUST** start with an update for that ID with `content: []`. Replay applies `_meta`
  as a patch; remove stale keys with `null` or send `_meta: null` first.
- **Pending interactions.** If the connection loss made a pending permission or elicitation unusable, the agent
  **SHOULD** re-establish it or resolve the wait safely.
- **list** is mandatory with `session`; only sessions the agent still has.
- **close**: §2.4. **delete**: §2.5 (optional).

For Windlass: the log is complete and nothing is deleted, so replay is a fold of the projection
(`core:message/message.ts`) into updates, one entity per message part **(inferred)**. Because replay may send current
state only, no streaming deltas are needed **(inferred)**.

---

## 7. Unstable methods relevant to this harness

Import from `@agentclientprotocol/sdk/experimental/v2/unstable` to get these; every definition is marked
"**UNSTABLE** ... may be removed or changed at any point". Negotiating v2 does not enable them; each needs its own
capability (`doc:extensibility#experimental-features-and-negotiation`). Use one entrypoint for agent and client
(`sdk:README.md`, "Choose a protocol entrypoint").

| Method | Dir | Capability | Params → result |
| --- | --- | --- | --- |
| `session/fork` | C→A | `session.fork: {}` | `U:ForkSessionRequest@8585` `{ sessionId, cwd, additionalDirectories?, mcpServers?, systemPrompt? }` → `U:ForkSessionResponse@4618` `{ sessionId, configOptions?, availableCommands? }`. Fork is active once answered. **No message/point parameter**; the RFD only anticipates "an optional message ID" later (`rfds/session-fork.md`). |
| `session/status` | C→A | `session.status: {}` | `{ sessionId }` → `{ status: "open"\|"saved"\|_..., state?: StateUpdate }` (`U:SessionStatusResponse@4687`). No side effects; unknown session `-32002`; unknown status is read as `saved`. |
| `session/set_title` | C→A | `session.title: {}` | `{ sessionId, title }` → `{ title }` (stored, maybe normalized). Session need not be active. After success, do not auto-retitle (`U:SetSessionTitleRequest@8712`). |
| `session/archive`, `session/unarchive` | C→A | `session.archive: {}` | `{ sessionId }` → `{}`. Archiving an active session closes it first. Adds `session/list` param `archived?: "exclude"\|"include"\|"only"` and `SessionInfo.archived?: boolean` (required when advertised) (`U:ArchiveSessionRequest@8643`). |
| `providers/list` | C→A | `capabilities.providers: {}` | `{}` → `{ providers: { providerId, supported: LlmProtocol[], required, current?: { apiType, baseUrl } }[] }` (`U:ListProvidersResponse@3767`). |
| `providers/set` | C→A | same | `{ providerId, apiType, baseUrl, headers?: {[k]:string} }` → `{}` (`U:SetProviderRequest@8081`). |
| `providers/disable` | C→A | same | `{ providerId }` → `{}`; not for `required` providers. |
| `auth/status` | C→A | `capabilities.auth.status: {}` | `{}` → `{ state: "authenticated"\|"unauthenticated"\|"not_required"\|"unknown"\|_..., accounts?: { label, active?, name?, email?, organization? }[] }` (`U:AuthStatusResponse@3941`). **MUST NOT** fail with `-32000`. |
| `auth/status_update` | A→C notif | same | same fields as the `auth/status` result (`U:AuthStatusUpdateNotification@7605`). |
| `mcp/message` | both | `session.mcp.acp: {}` | MCP over the ACP channel. Request `{ serverId, requestId, method, params? }` → `{ result }` or `{ error: { code, message, data? } }`; notification form for subscriptions. Server config `{ type: "acp", name, serverId }` (`U:MessageMcpRequest@2656`, `U:McpServerAcp@8376`). |
| `proxy/initialize`, `proxy/successor` | conductor↔proxy | n/a | Proxy chains: `proxy/initialize` has `InitializeRequest` shape; `proxy/successor` wraps `{ method, params?, _meta? }` (`U:InitializeProxyRequest@9727`, `U:ProxySuccessorRequest@9737`). Not needed by Windlass **(inferred)**. |

Unstable additions to stable shapes that matter here:
- `IdleStateUpdate.usage?: U:Usage@5247` = `{ totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens? }`,
  "for the foreground work that just completed, not cumulative". This is the only ACP-defined place for cache counts.
- `state: "unknown"` (`U:UnknownStateUpdate@5516`): the agent cannot observe foreground activity.
- `subagent_update` (`U:SubagentUpdate@7402`): sent on the parent session, announces and updates an owned child session:
  `{ sessionId (child), title?, description?, capabilities?: { cancel?: {} }, state?: StateUpdate, cwd?, additionalDirectories?, _meta? }`.
  The first one must precede any message bearing the child's ID; child events are then delivered without a separate
  resume. `BackgroundWork` gains `{ type: "subagent", sessionId }`.
- `session_message` / `session_message_chunk` (`U:SessionMessage@7475`): inter-session messages with
  `senderSessionId`, `recipientSessionId` and cross-references.
- `plan_update` content gains `{ type: "file", planId, uri }` and `{ type: "markdown", planId, content }`, plus
  `plan_removed { planId }` (`U:PlanRemoved@7059`).

Caveats: the public `/protocol/v2/draft/` pages already list `subagent_update` and `session_message` as "Draft only"
update variants, so these shapes are moving. Treat every unstable shape as pinned to SDK 2.5.0 **(inferred)**.

---

## 8. Extensibility

### 8.1 Custom methods and notifications (`doc:extensibility#extension-methods`)

- Any method name starting with `_` is an extension. Names starting with `$/` are protocol-level. **All other names are
  reserved for ACP.**
- Naming: reverse-DNS of a domain you control, then `/`: `_com.example/<name>` for methods and enum values,
  `com.example/<name>` for `_meta` keys and capability entries (MCP's convention).
- Unknown custom **request**: respond `-32601`. Unknown **notification**: ignore.
- Advertise extensions as `_meta` entries in capability objects, never as new properties:
  `capabilities._meta` for cross-cutting ones, a nested object's `_meta` (e.g. `capabilities.session.prompt._meta`) for
  scoped ones. Both sides advertise under the same key.
- Custom enum or union values start with `_` (e.g. `stopReason: "_dev.example/budget"`, `sessionUpdate: "_dev.example/x"`).
  Non-underscore unknown values are reserved for ACP. Closed unions (no custom values): `ElicitationSchema.type`,
  embedded resource contents, select `options`, elicitation scope.
- **Never** add custom fields at the root of a spec type. Use `_meta`.
- A malformed value for a known discriminator is an error, not an unknown variant. A request that cannot be served
  without understanding an unknown variant is `-32602`.

### 8.2 `_meta` (`doc:extensibility#the-_meta-field`, `#metadata-patches`)

- `{ [key: string]: unknown }`; any other value is treated as omitted. Reserved root keys: `traceparent`, `tracestate`
  (W3C Trace Context), `baggage`. Other unprefixed keys and `*.agentclientprotocol/*` are reserved for ACP.
- On the upsert updates (`tool_call_update` including a permission subject's `toolCall`, `terminal_update`,
  `user_message`, `agent_message`, `agent_thought`, `session_info_update`, `compaction_update`) the top-level `_meta` is
  a **key-level patch**: omit = unchanged; `null` = clear all; object = per key, `null` removes the key, any other value
  replaces that key whole (no deep merge). `{}` changes nothing. A key cannot store literal `null`; wrap it.
- Everywhere else (requests, responses, chunks, content items, `plan_update`) `_meta` describes only its own object,
  and `null` values are ordinary data. Data about a single notification goes in `params._meta`.

### 8.3 Extensions Windlass needs (proposed, all **inferred**)

`<ns>` is a reverse-DNS prefix the project controls; it has to be chosen (open question). Advertise each under
`capabilities._meta["<ns>/<feature>"]` in the `initialize` response.

| Harness feature | ACP support | Proposed shape |
| --- | --- | --- |
| Steer a running session | Partly native: a prompt sent while running may be inserted at once (§4.3). | Default: deliver as `steer`. Per prompt: `PromptRequest._meta["<ns>/delivery"] = "steer" \| "queue"`. |
| Queue a message | Partly native: a held prompt (response pending until insertion; `$/cancel_request` withdraws it). | `_meta["<ns>/delivery"]: "queue"`. Changing a waiting item: `_<ns>/inbox/set_delivery { sessionId, requestId \| messageId, delivery }`. |
| Show the waiting inbox | none | `user_message` cannot be used before insertion (it **MUST NOT** precede insertion). Use `session_info_update._meta["<ns>/inbox"]` (whole list per key) or a custom `_<ns>/inbox` update. |
| Revert | none | `_<ns>/session/revert { sessionId, messageId }` → `{}`; then `agent_message`/`user_message` `_meta["<ns>/excluded"]: "reverted"` patches on the affected entities. |
| Manual compaction | Native via command: advertise `availableCommands: [{ type:"command", name:"compact", ... }]`; `/compact` in a prompt is a local command; progress through `compaction_update`. | Optional `_<ns>/session/compact { sessionId }` for non-chat callers. |
| Fork (at a point) | `session/fork` (unstable) forks the whole session only. | `ForkSessionRequest._meta["<ns>/throughMessageId"]`, or a custom `_<ns>/session/fork`. |
| List subagents | `subagent_update` (unstable) announces children on the parent. | Use it if adopted; else `_<ns>/session/subagents { sessionId } → { sessions: SessionInfo[] }`. |
| Token usage and cache stats | `usage_update` (context used/size, cost); unstable `IdleStateUpdate.usage` (per turn, includes `cachedReadTokens`). | Per step: `usage_update._meta["<ns>/step"] = { messageId, inputTokens, cachedInputTokens, outputTokens, reasoningTokens }`. Cache-prefix diagnostics (`comparePrefix`): `_<ns>/session/cache_report`. |
| Refusal exclusion range | none | `_meta` patch `"<ns>/excluded": "refused"` on the affected messages. |
| Retry progress | `notice` (warning) | plus `session_info_update._meta["<ns>/retry"]` (set, then `null`), which is what the opencode adapter does with its own key (`translate.ts:265-275` in the cross-check snapshot). |

---

## 9. What changed from v1 to v2 for an agent (`mig`)

1. `session/prompt` returns `{ messageId }` at insertion; the turn result moved to `state_update` idle + `stopReason`.
2. `state_update` (`running`/`idle`/`requires_action`) is mandatory, including for local commands and agent-initiated
   work. Resume must send a current snapshot.
3. `messageId` required on every message chunk; new whole-message upserts `user_message`/`agent_message`/`agent_thought`.
4. `tool_call` removed; `tool_call_update` is the create-or-patch upsert; new `tool_call_content_chunk`.
5. **Client file system and terminal methods removed**: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
   `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill`, and the `fs`/`terminal` client
   capabilities. Tools run on the agent; client-side resources come in as MCP servers. The new `terminal` content and
   `terminal_update` are agent-owned display state only.
6. Diffs: `oldText`/`newText` replaced by `changes` + optional `git_patch` with absolute paths.
7. `session/load` removed; `session/resume` with `replayFrom` does both; `list`, `resume`, `close` are baseline (no
   markers); `session/close` cancels like `session/cancel` and also stops background work.
8. Modes removed (`session/set_mode`, `modes`, `current_mode_update`): use a config option with `category: "mode"`;
   `id` → `configId`, `group` → `groupId`; `set_config_option` needs `type`.
9. `authenticate` → `auth/login`, `logout` → `auth/logout`; both required iff `authMethods` is non-empty; method `id` →
   `methodId`; `type` required.
10. Initialize: `clientInfo`/`agentInfo` → `info` (required), `clientCapabilities`/`agentCapabilities` →
    `capabilities`; prompt and MCP capabilities move under `capabilities.session`; booleans become `{}` markers.
11. Permission requests: required `title`, optional `subject` (`tool_call` or `command`).
12. Plans: `plan_update` with `planId` and `type: "items"`.
13. MCP configs need `type`; `sse` removed; `stdio` is now a capability.
14. Open enums everywhere with `_` for custom values; top-level `_meta` on upserts is a key-level patch.
15. Request IDs cannot be `null`; no batches; `-32601`, `-32002` + `data.sessionId`, and pre-init `-32600` became MUST.

---

## 10. Mapping between the harness core and ACP

All of this section is **(inferred)** design; event names and fields are from `core:event/durable.ts`,
`core:event/ephemeral.ts`, `core:message/message.ts`.

### 10.1 ID scheme

| ACP entity | Harness source | Proposed ACP ID |
| --- | --- | --- |
| user message | `inbox.enqueued.messageId` (becomes the message's ID on delivery) | the `MessageId` as is |
| agent message | one per `text` part of an assistant message | `${messageId}:${partIndex}` |
| agent thought | one per `reasoning` part | `${messageId}:${partIndex}` (separate ID space from agent messages) |
| tool call | `(messageId, callId)`; providers reuse call IDs | `${messageId}/${callId}` (ACP needs uniqueness per session) |
| compaction | compaction message `messageId` | the `MessageId` |

One ACP agent message per text part, not per assistant message, because an entity's timeline position is fixed by its
first update; a single message spanning text, then tools, then more text would render the later text before the tool
calls. These IDs are deterministic, so they survive replay and restart.

### 10.2 Core events → ACP

| Core event | ACP output |
| --- | --- |
| `session.created` | No update; it is the `session/new` (or `session/fork`) response. `cwd` → `SessionInfo.cwd`. |
| `session.renamed` | `session_info_update { title }` |
| `session.archived` / `session.unarchived` | Unstable: backs `session/archive`/`unarchive` and `SessionInfo.archived`. No live update variant. |
| `baseline.set` | none |
| `instruction.appended` | none (not user-visible) |
| `inbox.enqueued` | none on the wire. The pending `session/prompt` stays unanswered (a held prompt). Optional inbox `_meta` (§8.3). |
| `inbox.delivery_changed` | none (extension) |
| `inbox.cancelled` | the pending `session/prompt` gets `-32800` |
| `inbox.delivered` | **Insertion**: answer `session/prompt` `{ messageId }` and emit `user_message { messageId, content }`. |
| `synthetic.appended` | none by default. If shown: `user_message` with `_meta["<ns>/origin"]`. Agent-initiated work needs no synthetic user message. |
| `execution.started` | `state_update { state: "running" }` |
| `execution.resumed` | `state_update { state: "running" }` (after restart recovery) |
| `execution.succeeded` | `state_update { state: "idle", stopReason }`: `end_turn`, or `max_tokens` if the last step ended `finish: "length"`, or `refusal` if it was refused |
| `execution.failed` | `state_update { state: "idle", stopReason: "error", error: { code, message } }` (`-32000` for an auth `providerError`) |
| `execution.interrupted` (`user`) | final tool-call statuses, then `state_update { state: "idle", stopReason: "cancelled" }` |
| `execution.interrupted` (`shutdown`) | nothing: the connection ends; a later resume reports the state |
| `step.started` | none (entities are created lazily by the first delta) |
| `step.ended` | `usage_update { used, size }` (+ `_meta` step usage) |
| `step.failed` | nothing by itself; the execution's terminal event decides the stop reason |
| `step.refused` | `agent_message` with the refusal text; idle `refusal` if the execution ends |
| `retry.scheduled` | `notice { severity: "warning", title }` |
| `text.ended` | `agent_message { messageId, content: [{type:"text", text}] }` (authoritative, repairs missed deltas) |
| `reasoning.ended` | `agent_thought { messageId, content: [...] }` |
| `tool.called` | `tool_call_update { toolCallId, name, title, kind, status: "pending", rawInput: parsed input }` |
| `tool.started` | `tool_call_update { status: "in_progress" }` |
| `tool.settled` | `tool_call_update { status, content, rawOutput }`: `success`→`completed`, `error`→`failed`, `not_started`→`cancelled`, `effect_unknown`→`failed` + `_meta["<ns>/outcome"]: "effect_unknown"`. `display` → `diff`/`terminal` content; `attachments` → `image` content. |
| `compaction.started` | `compaction_update { compactionId, status: "in_progress" }` |
| `compaction.ended` | `compaction_update { status: "completed", summary: [{type:"text", text: summary}] }`. Check that the summary holds no hidden prompt framing. |
| `compaction.failed` | `compaction_update { status: "failed" \| "cancelled" (interrupted), error }` |
| `history.reverted` | none (extension, §8.3) |
| ephemeral `text.delta` | `agent_message_chunk { messageId, content: {type:"text", text} }` |
| ephemeral `reasoning.delta` | `agent_thought_chunk` |
| ephemeral `tool.input.delta` | first one: `tool_call_update { toolCallId, name, status: "pending" }`; later ones may be dropped |
| ephemeral `tool.progress` | `tool_call_update { content: [{type:"content", content:{type:"text", text}}] }` (replaces, matching "replaces the previous progress text") |

Core events with **no ACP equivalent**: `baseline.set`, `instruction.appended`, `inbox.enqueued` (as a visible item),
`inbox.delivery_changed`, `synthetic.appended` (as a distinct kind), `step.started`, `step.failed` (per step, as
opposed to per turn), the `excludeFromSeq` range of `step.refused`, `retry.scheduled` (only as a non-durable notice),
`history.reverted`, `execution.interrupted` with reason `shutdown`, the `effect_unknown` tool outcome, per-step usage
with cache tokens (stable), `session.archived`/`unarchived` in stable, and fork `lineage.throughSeq`.

### 10.3 ACP client requests → core operations

| ACP request | Core operation |
| --- | --- |
| `initialize` | none; build capabilities from config |
| `auth/login` / `auth/logout` | ChatGPT sign-in flow / clear stored tokens (`core:auth/`) |
| `session/new` | append `session.created { cwd, title: null, lineage: null }`; the baseline is set before the first step |
| `session/resume` | read the projection; replay if asked; snapshot state from the execution claim (claim with no terminal event = `running`) |
| `session/list` | store query over sessions (non-archived), `updatedAt` from the last event `time` |
| `session/prompt` | append `inbox.enqueued { messageId: new, origin: null, delivery: "steer" (or `_meta`), content }`, wake the execution; answer at `inbox.delivered` |
| `session/cancel` | `inbox.cancelled` for every undelivered item received before the cancel; interrupt with reason `user` |
| `$/cancel_request` on a held prompt | `inbox.cancelled` for that item |
| `session/close` | as `session/cancel` plus stop background work; then detach |
| `session/delete` | conflicts with "nothing is deleted" (`docs/architecture.md`); don't advertise `session.delete` until decided |
| `session/set_config_option` | change model or reasoning effort for later steps (no durable event exists for it yet) |
| `tool_call/cancel` | abort one tool call; needs a per-call abort token the core does not have yet; only advertise `capabilities.cancel` when it exists |
| `terminal/cancel` | kill one background process |
| `session/fork` (unstable) | append `session.created { lineage: { kind: "fork", parentSessionId, throughSeq } }` in a new session |
| `session/set_title` (unstable) | `session.renamed` |
| `session/archive` / `unarchive` (unstable) | `session.archived` / `session.unarchived` (+ close if active) |
| `session/status` (unstable) | read only: in-memory = `open`, else `saved` |
| `/compact` prompt | `compaction.started { trigger: "manual" }` |

---

## 11. Using the SDK on the agent side

### 11.1 What to import and call (`sdk:src/v2/acp.ts`; the stable file `sdk:src/v2/stable/acp.ts` is generated from it)

- Package entry `@agentclientprotocol/sdk/experimental/v2` (stable v2 features) or `.../experimental/v2/unstable` (adds
  fork, status, set_title, archive, providers, auth/status, mcp/message) (`sdk:package.json` `exports`). The default
  import is v1. Peer deps: `zod` (`^3.25.76 || ^4`); `@modelcontextprotocol/server` is optional.
- `agent({ name })` → `AgentApp` (`:3039`). Register handlers with `.onRequest(methods.agent.X, handler)` and
  `.onNotification(methods.agent.session.cancel, handler)`. Params are parsed with the generated Zod schemas before the
  handler runs; a thrown `RequestError` becomes a JSON-RPC error. You **must** register `initialize`.
- Handler context `AgentRequestContext` (`:2145`): `{ method, params, signal, client: AgentContext, requestId }`.
  `signal` aborts on `$/cancel_request` (requests) or connection close (notifications).
- `ctx.client.notify(methods.client.session.update, { sessionId, update })` and `ctx.client.request(...)` send to the
  client. Both wait until initialization is done (`:1024`).
- `methods` (`:827`): `methods.agent.{initialize, auth.login, session.new, ...}`,
  `methods.client.{session.update, session.requestPermission, elicitation.create, elicitation.complete}`.
- `ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>)` (`:106`) builds the stdio
  `Stream`. `app.connect(stream)` returns `AgentConnection { client, initialized, signal, closed, close() }`.
- `onConnect(conn => ...)` gives you `conn.client` for traffic outside any request, such as background updates
  (`:3138`).
- Custom methods: `.onRequest("_ns/method", parser, handler)` where `parser` is a Zod schema or `{ parse }` or a
  function (`sdk:src/core/app-handlers.ts:16`); unknown custom names without a parser throw at registration.
- Guards on unions: `ContentBlock.isText(b)`, `CreateElicitationResponse.isAccept(r)` and so on.
- `RequestError.*` (§2.10), `assertSupportedMcpServers` (`:790`), `PROTOCOL_VERSION`.
- Outgoing values you build are type-checked field by field; custom variants need a `_` tag (`sdk:README.md`).

### 11.2 Skeleton (Bun, stdio)

```ts
import { Readable, Writable } from "node:stream"
import { agent, methods, ndJsonStream, RequestError, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2"

const sessions = new Map<string, { cwd: string; active: boolean }>()

const app = agent({ name: "windlass" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    info: { name: "windlass", version: "0.1.0" },
    capabilities: { session: { prompt: { image: {} } } },
    authMethods: [{ type: "agent", methodId: "chatgpt", name: "Sign in with ChatGPT" }],
  }))
  .onRequest(methods.agent.auth.login, async ({ signal }) => { await signInWithChatGPT(signal) })
  .onRequest(methods.agent.auth.logout, () => { signOut() })
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = core.createSession(params.cwd)            // appends session.created
    sessions.set(sessionId, { cwd: params.cwd, active: true })
    return { sessionId }
  })
  .onRequest(methods.agent.session.list, () => ({ sessions: core.listSessions() }))
  .onRequest(methods.agent.session.resume, async ({ params, client }) => {
    const s = sessions.get(params.sessionId)
    if (!s) throw RequestError.sessionNotFound(params.sessionId)
    for (const update of params.replayFrom ? core.replay(params.sessionId) : [])
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update })
    await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "state_update", ...core.state(params.sessionId) } })
    s.active = true
    return {}
  })
  .onRequest(methods.agent.session.close, async ({ params }) => { await core.close(params.sessionId) })
  // Resolves only at inbox.delivered; the turn's outcome goes out as state_update.
  .onRequest(methods.agent.session.prompt, ({ params, client, signal }) =>
    core.enqueue(params.sessionId, params.prompt, { signal, emit: (update) =>
      client.notify(methods.client.session.update, { sessionId: params.sessionId, update }) }))
  .onNotification(methods.agent.session.cancel, async ({ params }) => { await core.interrupt(params.sessionId, "user") })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)
await app.connect(stream).closed
```

`core.*`, `signInWithChatGPT` and `signOut` are placeholders. The stream setup copies
`sdk:src/examples/dual-version-agent.ts:198-202`; that it runs unchanged under Bun is **(inferred)**, as is the
alternative of wrapping `Bun.stdin.stream()` and `Bun.stdout`.

Pitfall shown by the SDK's own example: a prompt handler's return value is sent as the response *after* the handler
returns, so the example defers the turn's first notifications with `setTimeout(0)` so that the response goes out first
(`sdk:src/examples/dual-version-agent.ts:258-264`). Order is not required by the spec, but our CLI is simpler if it
holds.

### 11.3 Testing without a subprocess

- **Direct app pairing**: `agentApp.connect(clientApp)` or `client().connectWith(agentApp, async (ctx) => ...)`. No
  stream, no subprocess (`sdk:src/v2/acp.ts`, `AgentApp.connect` overloads; documented for tests in
  `sdk:MIGRATION_0.26_0.27.md`, "Direct App Connections for Tests"). The client still has to send `initialize` itself
  (`sdk:src/v2/acp.test.ts:1434-1440`).
- **In-memory wire**: two `TransformStream<AnyMessage>` crossed into two `Stream`s, as `memoryStreamPair()` does at
  `sdk:src/v2/acp.test.ts:103-117`. Use it to assert raw message order (e.g. replay, then `state_update`, then the
  resume response) or to play a hand-written peer (`respondToNextRequest`, same file, `:119`).
- **Client helpers for assertions**: `ctx.buildSession(cwd).start()` → `ActiveSession` (`:1626`, `:1721`) with
  `prompt(text)`, `nextUpdate()` (idle comes back as a `stop` message), `readTextUntilIdle()` (`:2009`),
  `setConfigOption`, `cancelToolCall`, `background`. The harness CLI can use the same API.
- `sdk:src/test-support/` (`test-agent.ts`, `streams.ts`) targets v1 only; `streams.ts` has generic byte-stream helpers
  (`streamFromChunks`, `collectStream`) usable for ndjson framing tests.
- The SDK tests run on vitest; ours run on `bun test`. Nothing in the SDK API ties tests to vitest **(inferred)**.

---

## 12. Cross-check notes (opencode `packages/cli/src/acp/`, read only)

That adapter imports the default `@agentclientprotocol/sdk` entry, which is **v1**: it sends `tool_call` and
`messageId` only where v1 allows, so it is not a model for v2 wire shapes. What carries over: permission options
`once`/`always`/`reject` mapped to `allow_once`/`allow_always`/`reject_once` with the agent remembering "always"
(`permission.ts:40-73`); usage from the last step's total and the model's context limit into `usage_update` with
USD cost (`turn.ts:340-360`); retry status as a namespaced key on `session_info_update._meta`, cleared with `null`
(`translate.ts:265-275`); compaction mapped to `compaction_update` in_progress/completed/cancelled
(`compaction.ts:118-130`); child sessions projected with a parent ID in `_meta` (`child.ts:23-41`).

---

## Open questions

1. **Steer vs queue default.** ACP leaves it to the agent whether a prompt sent while running is inserted at once
   (steer) or held (queue). Which should a bare `session/prompt` mean for us, and do we accept the `_meta` delivery
   flag?
2. **Insertion point.** This page maps insertion to `inbox.delivered`, so a steered prompt's response waits for the
   next step boundary. Is that latency acceptable to the CLI, or should the CLI rely on `user_message` instead?
3. **Extension namespace.** Which reverse-DNS domain does the project control for `_meta` keys and `_`-methods?
4. **`session/delete`** contradicts "nothing is deleted". Leave unadvertised, or implement as hide?
5. **Unstable surface.** Do we import `experimental/v2/unstable` (fork, set_title, archive, status, `IdleStateUpdate.usage`
   with cache counts, `subagent_update`) and accept churn, or stay on stable plus extensions?
6. **Config option changes** (model, reasoning effort) have no durable event; should they get one so resume reports
   the right `currentValue`?
7. **Per-tool cancel** (`tool_call/cancel`) needs a per-call abort token in `ToolContext`; is that wanted in the core?
8. **Shutdown interruptions**: the core keeps the claim on `shutdown`; on next start, recovery resumes the execution
   with no client attached. Confirm that a later `session/resume` reporting `running` is the intended behaviour.
9. **Bun compatibility** of `ndJsonStream` with `node:stream` web adapters is untested here.
