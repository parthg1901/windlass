# agents

An agent (also called a mode) is a role kept as a Markdown file: a name, a one-line description, optionally a model,
a reasoning effort and restrictions, and a body that is its instructions. A session can start as an agent, a
subagent can be run as one, and the user can switch the agent of a running session. A definition is data: nothing
in it runs anything, and what an agent changes, and when, is recorded.

A leaf module: nothing in core imports it, and it defines no durable events (it lists below what to record). It
imports only `brand`, `validate`, `config/schema.ts` (`ConfigError`), `instructions/source.ts` (`fingerprint`),
`skills/frontmatter.ts` and the tool contract's types.

| File | What |
| --- | --- |
| `definition.ts` | one file's front matter and body, the restrictions as data, the definition's fingerprint |
| `discover.ts` (`walk.ts`) | roots, precedence, the walk, shadowed and malformed definitions |
| `restrictions.ts` | allow or refuse a call, the approval mode an agent can only tighten, combining a parent's and a child's |
| `use.ts` | what a session or child records, its baseline section, the switch message, settings, lookup by name |
| `agent-index.ts` | the list of agents for the model (sorted, bounded, fingerprinted) and what to append |
| `config.ts` | the `agents` configuration section |

## For users

### Where definitions live

Highest precedence first (`agentRoots`):

1. In each directory from the working directory up to the repository root (nearest `.git`; outside a repository
   the working directory alone): `.<brand.directory>/agents`, `.agents/agents`, `.claude/agents`.
2. `agents.paths` from the configuration, in order.
3. Your `<config dir>/agents` (`$XDG_CONFIG_HOME/<brand.directory>/agents`, by default `~/.config/<brand.directory>/agents`).

A definition is `<name>.md`, directly in one of those directories or up to two folders below it (for grouping).
`README.md`, dot-entries and `node_modules` are not read; a symbolic link is followed only when it stays inside
its directory. The nearest definition of a name wins and the others are listed as *shadowed*. Order is by UTF-16
code units, the same on every machine.

### The format

```markdown
---
name: reviewer
description: Reviews a change for correctness and risk without editing anything. Use for a second opinion before a commit.
effects: read
disallowed-tools: background_stop
approval: ask
---
You are a strict code reviewer. Read the diff and the code around it; do not change files.
Report findings as a list, most severe first: file and line, what is wrong, how it fails.
Say plainly when you found nothing.
```

```markdown
---
name: release-captain
description: Prepares a release branch: bumps versions, updates the changelog, runs the checks.
model: gpt-6-sol
effort: high
tools: read, grep, glob, edit, write, shell
---
Work on a branch named release/<version>. Never push and never tag; the user does that.
```

```markdown
---
name: docs
description: Writes and edits documentation only.
tools:
  - read
  - grep
  - glob
  - edit
  - write
---
Edit only files under docs/ and README files. If code must change, say what and stop.
```

| Key | Meaning |
| --- | --- |
| `name` | Letters, digits, `-`, `_`, `.`; at most 64. Default: the file name. `none` is reserved (it means "no agent"). |
| `description` | Required. One line for the user's listing and the model's list of agents. |
| `model` | The model the session runs with. Absent or `inherit`: the session's (or the parent's). |
| `effort` (or `reasoning-effort`) | The reasoning effort. Absent or `inherit`: the session's. |
| `effects` | The effect classes its calls may have: `read`, `write`, `exec`, `network`. `effects: read` is read-only. |
| `tools` | The only tools it may call (names compared ignoring case). `*` or absent: any. |
| `disallowed-tools` (or `disallowedTools`) | Tools it may never call. |
| `approval` | `ask`, `auto` or `full`: applies only when stricter than your approval mode. |

Lists are written `a, b`, `[a, b]` or as `- a` lines. Unknown keys are ignored (`color`, ...), so definitions
written for other harnesses load; `permissionMode`, `mcpServers` and `hooks` are reported as not read, because a
definition here cannot loosen approval, start a server or run a command. Tool names of other harnesses that are not
tools here (`Bash` is `shell`) are restrictions that match nothing; the integrator warns about them
(`unknownToolNames`).

A definition is **skipped, with the reason**, never half-loaded: no front matter, front matter not closed, a line
that is not `key: value`, a duplicated key, an unclosed quote, no `description`, a bad or reserved name, an unknown
effect, an unknown approval mode, an empty restriction (`tools:` with nothing: write no key for no restriction), a
tool pattern such as `Bash(git:*)`, both spellings of one key, a model or effort that is not a single word, a file
over 64 KiB. Skipping is the safe failure: an agent you believe is read-only never runs with every tool because of
a typo. Warnings that do not skip it: no `name`, a name unlike the file's, a description over 1024 characters, no
body, a key of another harness that is not read.

### What restrictions do

Every tool stays offered to the model; a call the agent may not make is refused when it is made, and the model reads
why, e.g. `Not run: you are working as the agent "reviewer", which may use only tools that read. "edit" changes
files. Carry on without it, or tell the user what you would need and why.` A call the agent allows still goes
through the approval layer exactly as without an agent: **a definition can only take away**, whether it is yours or
the repository's. `approval: full` in a definition never loosens `ask`. An MCP tool's effect cannot be known, so
under an `effects` restriction it runs only when `tools` names it.

## What "using an agent" means, and what it costs

The tool list and the system prompt are frozen in a session's baseline, so an agent never changes either in the
middle of a session.

**(a) A new session started as an agent.** Its instructions are a section of the session's first baseline (source
key `agent`, the last source, after the AGENTS.md files, the environment and the date):

```
<agent lines="4">
You are working as the agent "reviewer" (defined in /repo/.claude/agents/reviewer.md): Reviews a change ...
Restrictions: Only tools that read (effects: read). Never these tools: background_stop. Approval mode at most as loose as "ask". A call outside them is refused with the reason, not run.

You are a strict code reviewer. ...
</agent>
```

Its model and effort are the session's settings from `session.created` on. Nothing about this differs in cache
terms from a session without an agent.

**(b) A subagent run as an agent.** The `subagent` tool gains one optional property, `agent` (a string, no enum,
the same in every session: `SUBAGENT_AGENT_PROPERTY`). The model learns which agents exist from an appended index
message (below), and the name is checked when the call runs; a typo is an error result with a did-you-mean. The
child's own fresh baseline carries the agent's section; its settings are the agent's model and effort, else the
parent's. Its restrictions are the agent's **combined with the parent's** (the stricter of each), and a child started
without `agent` by a parent that runs as an agent runs as the parent's agent: a restricted session cannot get around
its restrictions by handing the work to a child.

**(c) A switch in the middle of a session.** The baseline cannot change, so a switch is an appended
`instruction.appended` message with source `agent` (`agentSwitch`):

```
The user switched you from the agent "planner" to the agent "reviewer". From this point on these instructions replace those of "planner" (and its restrictions); everything else you were given still applies:
<agent lines="4">
...
</agent>
```

Switching off: `The user switched off the agent "reviewer". From this point on its instructions and its restrictions
no longer apply; carry on under your other instructions.` (fingerprint `null`). The restrictions apply to every call
decided after the switch; a model or effort change is the existing `settings.changed` at the same step boundary.

**Cost.** A switch to an agent with the session's model and effort keeps the whole cached prefix: the next request
is the previous one plus the switch message, which is the only new input. The previous agent's instructions stay in
the conversation (they are history, and the message says they are replaced). An agent with a different model or
effort costs what `/model` costs: the cache is per model and settings, so the next request is read without the cache
once, and cached again from then on. A switch never rebuilds the baseline; only a compaction does, and the new
baseline carries the agent in force then (from the record, not the file).

**The file is read once.** What a session runs as is the record taken when the agent was selected: its
instructions, restrictions and fingerprint. Editing the file during the session changes nothing until the user
selects the agent again (then the message says the definition changed). Otherwise a session could widen its own
restrictions by editing its definition with `write`.

## The index (for subagents)

```
Agents you can run a subagent as:
<agents lines="5">
An agent is a role kept as a file: instructions, and sometimes a model and restrictions. To give a task to a subagent that works as one, call the subagent tool with `agent` set to its name. Without `agent` the subagent works as you do.

- docs (restricted): Writes and edits documentation only.
- reviewer (read only): Reviews a change for correctness and risk without editing anything. ...
</agents>
```

Sorted by name, each description on one line and cut at 300 characters, 6000 characters in all; agents past that are
named without descriptions, then counted. A change is `The agents have changed. This list replaces the one you were
given before:` plus the new list; when none are left, a one-line withdrawal with fingerprint `null`. Editing an
agent's body changes nothing in the index; editing a name, description or restriction tag, or adding or removing an
agent, appends an update.

## Configuration

A new section, `agents` (`parseAgentsSection`, `resolveAgentsConfig`):

```json
{ "agents": { "paths": ["~/team-agents"], "disabled": ["old-planner"], "default": "reviewer" } }
```

`paths` are absolute or start with `~/`; `disabled` leaves names out wherever they are found; `default` is the agent a
session you start runs as when you name none (`none` or absent: no agent; subagents never get it). `default` is read
from your own configuration only: a project file setting it is reported in `ignored`, since it would let a repository
choose the instructions and model of every session started in it. A default that cannot be found fails the start
with the reason (`resolveStartAgent`), rather than starting a session without the restrictions you chose.

## For the integrator

### Engine (the spine pass)

1. **Durable record.** One new event, `agent.switched`, data `{ messageId: MessageId | null, from: string | null,
   to: AgentRecord | null }` (`agentRecord` in `use.ts` is the validator, ready for `event/durable.ts`). The reducer
   folds it into `projection.session.agent: AgentRecord | null`. Written:
   - at session creation, in the same transaction as `session.created` and before the first `baseline.set`, with
     `messageId: null` (`from: null`) for a session started as an agent, a child included;
   - for a switch, in the same transaction as the `instruction.appended` it announces, with that message's ID.
   `AgentRecord` holds the name, path, scope, `definition` (the definition's fingerprint), `instructions` (the
   source value), the restrictions in force, model and effort. A fork inherits it with the history. Nothing reads
   the file again for the session.
2. **Starting a session.** `createSession({ agent?: string })`: `discoverAgents({ cwd, configDir, extraPaths,
   disabled })`, then `resolveStartAgent(set, requested, config)`; on failure reject with the message. Settings:
   `agentSettings(record, requestedOrDefaultSettings, offeredModels)`; a non-empty `notes` should reject the start
   (the user asked for that agent). The first baseline's sources are `[...discoverSources(...), agentSource(record)]`.
3. **Instruction source key `agent`.** `instructions/source.ts` must render it: in `tag()`, `if (key === "agent")
   return { name: "agent", attribute: "" }`, and add `agent` to `HEADER`'s first alternation
   (`(environment|date|agent)`), so `parseSections` reads it back. `renderAgentSection` here produces the same text.
   `notice()` needs no case: the engine appends the switch text from `agentSwitch`, not through `renderUpdate`.
   Never pass `agentSource` to `prepareInstructions` between compactions (that would re-render it as an AGENTS.md
   style "replaced" message on every boundary where it differs); add it to `sources` only when a baseline is being
   built (the first, and after a compaction, from `projection.session.agent`). `instructionState` then tracks the
   `agent` key by itself, from the baseline's fingerprint and the switch messages.
4. **Switching.** `session.setAgent(name | "none")`: look up with `findAgent`, build `agentRecordOf(agent)`; at the
   next step boundary under a running execution (as for any instruction message; a switch while idle waits for the
   next execution's first boundary) append `agent.switched` + `instruction.appended { source: "agent", text,
   fingerprint }` from `agentSwitch(current, next)`, and, when `agentSettings(next, current settings).changed`,
   `settings.changed` at the same boundary. `agentSwitch` returning `null` means append nothing. Switching to
   `none` appends the withdrawal with fingerprint `null`. The session's settings before the switch are not
   restored on switching off; the user changes them with `/model`.
5. **Enforcing restrictions.** In the step loop, before the approval decision of each call (with the calls the loop
   itself refuses, which are settled first): `checkAgentCall(session.agent, { name, effect: tool.effect, origin:
   tool.origin }, { exempt: [ACKNOWLEDGE_TOOL_NAME] })`. `refuse` settles the call as not started with `reason` as
   its output; record it as `approval.denied` with a new `reason: "agent"` (and `stop: false`), so the log says
   which rule refused it. `pass` goes on to `decide` unchanged. The approval mode passed to `decide` is
   `effectiveApprovalMode(policy.mode, session.agent).mode`; show `ignored` once as a diagnostic. An unknown tool
   name (`checkAgentCall` gets the model's raw name) is refused by the allowlist, which is what it should be.
6. **Subagents.** `engine/spawn.ts`: add `SUBAGENT_AGENT_PROPERTY` to the `subagent` input schema (optional) and
   `agent?: string` to `SubagentInput`, for every session from its first baseline (a tool's spec must not depend on
   what agents exist). When the call runs: `findAgent(discoverAgents({ cwd: child cwd, ... }), input.agent)`; a miss
   is an error result with its message and starts nothing. `childAgent(parent.agent, found)` is the child's record
   (written with its `session.created`, as in 2); `agentSettings(child, parent settings, offered)` its settings (a
   note is shown, not fatal); its baseline gets `agentSource(child)`. `agent` on a follow-up (`session`) is
   refused: a child keeps the agent it started as. `spawn.started` can carry the agent's name for display.
7. **The index.** At every step boundary of a session that is offered `subagent`:
   `agentIndexUpdate(state.get(AGENT_INDEX_KEY), agentIndexSource(discoverAgents(...).agents))`, appended as
   `instruction.appended` with source `AGENT_INDEX_KEY` (`"agent-index"`, deliberately not `agents:`). As for the
   skills index, `state.ts` withdraws only `agents:` keys and `renderSection` does not know this key; the engine
   routes it here. Keep it out of the baseline.
8. **Problems.** `AgentSet.problems`, `unknownToolNames(record.restrictions, toolNames)` and `agentSettings` notes
   go to the user (a `diagnostic`, the `/agents` listing), never to the model.
9. **Configuration.** Add `agents` to `configFile` with `parseAgentsSection`, and resolve with
   `resolveAgentsConfig(user, project)` rather than `mergeConfigFiles`, as `approval` is.

### ACP server

The server already exposes model, effort and approval as select config options (`docs/acp.md`; approval holds
the `mode` category), so the agent is a fourth one rather than an ACP session mode:
- a select option `agent`, values `none` plus one per agent (`value` = name, `name` = name, `description`), with the
  current one from `projection.session.agent`, on `session/new`, `session/load` and `session/resume`. A shadowed or
  broken definition is not a value; the listing extension below shows them.
- `session/new` takes the starting agent in `_meta[<META_NAMESPACE>].agent` (absent: the configured default; a
  failed `resolveStartAgent` is `-32602` with its message).
- `session/set_config_option` with `agent` is the switch (4); the server sends `config_option_update` when the
  `agent.switched` event is durable, not when the request arrives (with the model and effort options too when the
  switch changed them).
- An extension request `<prefix>/agents` → `{ agents: [{ name, description, path, scope, model, effort,
  restrictions, tag }], problems }` for a client's `/agents` listing (problems include shadowed entries).
- The `agent.switched` event is forwarded with the other events to a client that opted in to events.

### CLI and TUI

- `--agent <name>` on the command line and `/agent <name|none>` (no argument: list them) in both clients; the TUI
  palette lists agents as the arguments of `/agent`. Show the active agent in the status line and the switch as a
  line in the transcript (from the event, so a replayed session shows it too). A refusal by an agent reads as the
  model reads it.

## Demo

`bun scripts/agents-demo.ts` builds a temporary project with the example definitions (`examples/agents/`), a
shadowed and a broken one, and prints what discovery found, the index message, a refused call, a subagent's
combined restrictions and a mid-session switch (and the commands side, see `../commands/README.md`).
