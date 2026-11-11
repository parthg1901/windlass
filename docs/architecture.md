# Architecture

light-harness is a coding-agent harness built around one idea: a session is an append-only log of events in SQLite,
and everything else (the messages a UI shows, the request sent to the model) is computed from that log.

This page describes the contracts in `packages/core`. They were written before the implementations so that storage,
the model layer, the tools and the step loop can be built in parallel against them.

## Package layout

```
packages/core/src
  validate.ts   tiny runtime validators; every stored type is declared once and its TypeScript type is inferred
  id.ts         branded IDs: SessionId, MessageId, ExecutionId, RequestId, CallId
  content.ts    text and media parts; BlobRef into the content-addressed blob table
  interrupt.ts  the abort token with an explicit InterruptReason
  event/        durable.ts (the event schema), ephemeral.ts (streaming deltas), decode.ts (the SQLite boundary)
  message/      message.ts (projection types), reducer.ts (state + event -> state), history.ts (model view, row diff)
  store/        store.ts (the Store interface), schema.ts (SQLite DDL)
  request/      request.ts (ModelRequest and its blocks), canonical.ts, prefix.ts (hashing and the prefix check)
  provider/     provider.ts (stream events), error.ts (error taxonomy), usage.ts
  tool/         tool.ts (Tool, ToolContext, ToolResult)
  testing/      fake-provider.ts (scripted provider for tests)
  auth/         ChatGPT sign-in (owned by the model layer)
```

Naming: a lowercase export such as `message` or `usage` is a validator; the PascalCase export of the same name is its
type. Dependencies point one way: `event` knows nothing about `message`, `store` or the step loop; `provider` and
`tool` know nothing about sessions.

## Single-owner files

Three places are changed by one owner at a time, never in parallel branches. Other tracks ask for changes.

| File | Why |
| --- | --- |
| `event/durable.ts` and `message/reducer.ts` | A new event must be folded by the reducer and rendered by the request builder. The exhaustive `switch` makes a missed case a compile error, but only if both change together. |
| The request builder (to be written) | It alone decides what bytes the model sees. Two people changing it independently is how prefix breaks appear. |
| The step loop (to be written) | It owns the order of durable writes around a model call and its tools. |

## What each contract guarantees

**Events** (`event/`)
- Each durable event records one fact and carries a version. Objects are strict: an unknown field, type or version
  is an error on read, never something to skip.
- Only boundaries are stored. Streaming deltas are ephemeral; the event that ends an item carries its whole value.
- Text the model will see (tool output, instructions, the interrupt marker, the compaction summary) is frozen in the
  event when it is written and never rendered again.
- An interruption always has a reason (`user` or `shutdown`). There is no default, in the schema or in the abort token.
- Nothing is deleted. Revert and refusal are ranges of `seq` that set a flag; compaction is a marker; a fork is
  "the parent's events up to `throughSeq`, then my own, starting at `throughSeq + 1`".

**Reducer and projection** (`message/`)
- `reduce(state, event)` is pure and is the only code that turns events into state. The store runs it inside the
  append transaction, so an event it rejects is never written. Rebuilding from the log always equals the live rows.
- It rejects sequences that would break the log: a gap in `seq`; a message added in the middle of a step; a delivered
  prompt or a step without an execution claim; a tool call settled twice; a step ended while a call is unsettled.
- A tool call is `pending`, then optionally `running`, then `settled` exactly once. From `pending` it can settle as
  `not_started` or `error`; from `running` as `success`, `error` or `effect_unknown`.
- Tool calls are keyed by (assistant message, provider call ID), because providers reuse call IDs.
- `selectModelHistory` defines what the model sees: non-excluded messages, starting at the latest completed
  compaction (its summary first, then the messages it kept). Because every call is settled before its step ends,
  history is rendered as stored, with no repair at read time.

**Store** (`store/`)
- `append` is the only way state changes: validate, assign the next `seq`, reduce, write the changed rows, insert the
  event, all in one transaction. The interface is synchronous, so "the tool call is durable before the tool runs" is
  the order of two statements.
- One writer process. `seq` is dense per session and is the only ordering; IDs and timestamps never order anything.
- The request ledger stores, for each model call, the ordered block hashes of the request and the usage.
- Media lives in a blob table keyed by SHA-256, so a reload shows the same image and a block that refers to it hashes the same.

**Request** (`request/`)
- A request is an ordered list of blocks: parameters, each tool, the instructions, each input item. Everything in a
  request is in exactly one block except `toolChoice`, which is not part of the provider's cached prefix.
- `canonicalJson` gives one byte sequence per value regardless of key order. A block's hash is the SHA-256 of that.
- `comparePrefix` answers the question the cache cares about: is this request the previous one plus appended
  blocks? If not, it names the first changed block. The runtime ledger and the CI gate use the same function.
- The system prompt and tool list are stored in the log (`baseline.set`) and change only after a compaction. Anything
  else that changes is appended as a message.

**Provider** (`provider/`)
- `stream(request, signal)` yields normalised events and ends with exactly one `finish` or `error`. Failures are
  classified, not thrown. On abort the stream just stops.
- Every error has a kind, and the kind fixes whether it may be retried: rate limit, provider failure, transport and
  incomplete stream are; auth, usage limit, content policy, invalid request and context overflow are not.
- Provider-owned payloads (encrypted reasoning, item phase) travel as opaque `providerData` and are replayed verbatim.
- A provider does not retry and does not change the request. The step loop owns the single attempt budget.

**Tool** (`tool/`)
- A tool declares an effect class (`read`, `write`, `exec`, `network`). Sandbox and approval decisions use the class.
- A tool returns the text for the model once. After `tool.settled` is written that text is replayed byte for byte;
  `truncation` records that it was capped and where the full output is.
- The context carries the abort signal with its reason. A tool that is aborted returns what it observed.

## The only provider

The model layer talks to OpenAI's Responses API through "Sign in with ChatGPT". That flow keeps no conversation state
on the server, so the full history is sent on every call and an unchanged prefix is what makes the call cheap.
