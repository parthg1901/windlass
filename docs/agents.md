# Agents

An agent is a way of working you define once, as a Markdown file: instructions, and optionally what it may do, a
model and a reasoning effort. A read-only reviewer, a documentation writer that may edit but not run commands, a
careful mode that asks before every edit. A session can start as an agent, you can switch a running session to
one, and the model can hand a task to a subagent that works as one. A definition can only take away: nothing in it
runs a command or lets a call through that your approval mode would stop. Everything on this page was run against
the program with a scripted model, and the parts about what a real model does with `gpt-6-luna`;
`test/release/feature-docs-2.test.ts` checks the options, keys, limits and messages against the code.

## The smallest working example

In your project, create `.windlass/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews a change without editing anything. Use for a second opinion before a commit.
effects: read
---
You are a strict code reviewer. Read the code; do not change files.
Report findings as a list, most severe first.
```

Then start a session as it:

```sh
windlass --agent reviewer "review math.ts"
```

The first lines say what the session runs as, and a call the agent may not make is not run:

```text
⇄ working as the agent reviewer (read only)
  Only tools that read (effects: read).
▸ edit math.ts
  ○ not run: the reviewer agent may not change files
```

Asked to change a line under this agent, the real model did not try the edit: it read the file and answered that
it was working as a read-only reviewer, with the change it would have made.

## Where definitions live

A definition is a file `<name>.md`. Searched in this order; when two have the same name, the first one found wins:

1. In the working directory and each directory above it, up to the repository root:
   `.windlass/agents/`, `.agents/agents/` and `.claude/agents/`. A nearer directory wins over one above it.
   Definitions written for other agents load unchanged.
2. The directories listed in `agents.paths` in a configuration file.
3. Your own agents, `~/.config/windlass/agents/` (`$XDG_CONFIG_HOME/windlass/agents/` when that is set), for
   every project.

A definition may sit up to two folders below one of these directories, so you can group them. A `README.md` there
is not read as an agent. A definition that another one of the same name hides is reported, not used:

```text
⚠ agents: The agent definition at <path> is hidden by another agent of the same name: the agent "reviewer" at <path> takes precedence
```

## The file

Front matter between two `---` lines, then the agent's instructions in Markdown.

| Front matter | Value |
|---|---|
| `name` | letters, digits, `-`, `_` and `.`, at most 64 characters; without it the file's name is used, with a warning. `none` cannot be a name: it means "no agent" |
| `description` | required: one line, shown in `/agent` and given to the model in its list of agents |
| `model` | the model the session runs with while it is this agent; without it, the session's |
| `effort` | the reasoning effort; without it, the session's |
| `effects` | what its calls may do, of `read`, `write`, `exec` and `network`, as `read, write`. `effects: read` is a read-only agent |
| `tools` | the only tools it may call, as `read, grep, glob, edit, write` |
| `disallowed-tools` | tools it may never call |
| `approval` | `ask`, `auto` or `full`: the approval mode while it is this agent, used only when stricter than yours |

Other keys (`color`, ...) are ignored. `permissionMode`, `mcpServers` and `hooks`, which other agents' definitions
use, load with a warning that they are not read: a definition here cannot loosen approval, start a server or run a
command. A tool name that is not a tool here matches nothing (`Bash` is `shell`): an agent with `tools: Bash` is
refused `shell`. A file is at most 64 KiB.

## What restrictions do

Every tool stays in the model's tool list (changing the list would cost the provider's prompt cache); a call the
agent may not make is refused when it is made, and the model is told why. The three kinds:

```text
Not run: you are working as the agent "reviewer", which may use only tools that read. "edit" changes files. Carry on without it, or tell the user what you would need and why.
Not run: you are working as the agent "docs", which may use only these tools: read, grep, glob, edit, write. "shell" is not one of them. Carry on without it, or tell the user what you would need and why.
Not run: you are working as the agent "careful", which may not use the tool "background_stop". Carry on without it, or tell the user what you would need and why.
```

You see the agent's rule on the call's row: `○ not run: the reviewer agent may not change files` in `windlass`,
`⊘ edit math.ts · not run: the reviewer agent may not change files` in `windlass tui`. In `--json` it is an
`approval.denied` event with `agent` set.

- **A call the agent allows still goes through your approval mode**, exactly as without an agent.
- **`approval` can only tighten.** With `approval: ask` in a session in `auto`, an edit asks (and in a one-shot
  run is refused for lack of someone to ask). A looser mode is not followed:
  `⚠ agents: The agent "<name>" asks for approval mode "full"; the user's mode "auto" is kept, since an agent can only tighten it.`
- **`effects: read` also refuses the `subagent` tool** (it counts as running commands), so a read-only agent
  cannot hand work to subagents. Use `disallowed-tools: write, edit` for an agent that plans and delegates.

## Starting a session as an agent

`--agent <name>` on `windlass` and `windlass tui`; `--agent none` starts without one. Interactively the session line
names it (`new session ses_… · agent reviewer`), and the panel of `windlass tui` has an `agent` field. When the
definition names a `model` or an `effort`, the session is created with them.

A name that cannot be used ends the run before anything is sent, with exit code 2:

```text
windlass: There is no agent named "reviwer". Did you mean "reviewer"? Agents: docs, reviewer.
windlass: The agent "docs" is disabled in the configuration (agents.disabled).
```

A definition that could not be loaded is refused the same way, with the reason.

### The default agent

To start every new session as an agent, name it in your own configuration file, `~/.config/windlass/config.json`:

```json
{ "agents": { "default": "careful", "paths": ["~/team-agents"], "disabled": ["old-planner"] } }
```

| Key in `agents` | Value |
|---|---|
| `paths` | more directories of definitions, absolute or starting with `~/` |
| `disabled` | names of agents to leave out, wherever they are found |
| `default` | the agent a session you start runs as when you name none. From your own file only |

`--agent none` starts one session without it. A default that does not exist fails the start instead of running
without the restrictions you chose:

```text
windlass: There is no agent named "nobody". Agents: careful, docs, reviewer. (It is the default agent, agents.default; change that, or start with the agent "none".)
```

A project's file cannot choose the default (a repository would be choosing the instructions and model of your
sessions). It is not followed, and `/agent` says so:
`not followed: agents.default "docs" in the project's configuration (only the user's own configuration chooses the default agent)`.

## Switching: /agent

`/agent` (in `windlass`; `/agents` is the same) lists the agents, marks the one in force, and then the definitions
that could not be used:

```text
Agents (this session runs as reviewer):
    docs      Writes and edits documentation only.
      restricted · <path>
  * reviewer  Reviews a change without editing anything. Use for a second opinion before a commit.
      read only · <path>
/agent <name> switches to another · /agent none switches it off
```

`/agent <name>` switches and `/agent none` switches it off. In `windlass tui`, `/agent` opens a picker. On the command
line, `--agent <name>` with `-c` or `--session` switches the resumed session. The switch applies from the model's
next step and is a line in the conversation, also when the session is opened again:

```text
⇄ agent reviewer → docs (restricted) · from the next step
  Only these tools: read, grep, glob, edit, write.
⇄ no agent: the instructions and restrictions of reviewer no longer apply · from the next step
```

A session keeps its agent when you resume it without `--agent`.

## A subagent run as an agent

When agents are defined, the model is given their names and descriptions as a message (you see
`· instructions updated (agent-index): Agents you can run a subagent as: ...`) and can set `agent` on a `subagent`
call ([subagents.md](subagents.md)):

```text
Agents you can run a subagent as:
<agents lines="4">
An agent is a role kept as a file: instructions, and sometimes a model and restrictions. To give a task to a subagent that works as one, call the subagent tool with `agent` set to its name. Without `agent` the subagent works as you do.

- docs (restricted): Writes and edits documentation only.
- reviewer (read only): Reviews a change without editing anything. Use for a second opinion before a commit.
</agents>
```

- The child works under the agent's instructions and restrictions; a call it may not make is refused as above.
- **A restricted session cannot get around its restrictions through a child.** A subagent started without `agent`
  by a session that runs as an agent runs as that agent. One started as another agent gets both sets of
  restrictions: under a parent that may never call `write`, a `docs` child was refused `write` too.
- A name the model gets wrong starts nothing:
  `The subagent was not started: There is no agent named "revewer". Did you mean "reviewer"? Agents: careful, docs, reviewer.`

## What a mid-session switch costs

The tool list and the system prompt of a session never change, so a switch is one message added to the
conversation:

```text
The user switched you from the agent "reviewer" to the agent "docs". From this point on these instructions replace those of "reviewer" (and its restrictions); everything else you were given still applies:
<agent lines="4">
...
</agent>
```

and, when you switch it off,
`The user switched off the agent "careful". From this point on its instructions and its restrictions no longer apply; carry on under your other instructions.`

- **The cache is kept.** The request after a switch is the conversation so far plus that message. Measured with
  the real model: of 5,091 input tokens in the request after a switch, 4,736 (93%) were read from the cache.
- **The earlier agent's instructions stay in the conversation**, with the statement that they are replaced. An
  agent that must never have seen another's instructions needs a new session.
- **An agent that names a `model` or `effort` changes the session's**, from the same step. Switching the agent off
  afterwards, or to an agent that names none, does not change them back: a session that started as the agent never
  had other settings, and a change of model costs the cache, so nothing is guessed. You are told each time,
  `⚠ agents: The session keeps the model "<model>", which the agent "<name>" set: switching the agent off does not put back what the session ran with before. Change the session's model or effort to use another.`
  Use `-m <model>` (or `/model` in `windlass tui`) to choose another. Settings you changed yourself while the agent
  was on are yours, and nothing is said about them.
- **The file is read when the agent is selected.** Editing the definition during the session changes nothing,
  restrictions included, until you select the agent again; then the line reads
  `⇄ the agent reviewer (restricted) was selected again with its changed definition`.

## What can go wrong

A definition that cannot be loaded is skipped whole, never half-applied, and you are told with the first turn
(`/agent` shows it at once); the model is not told:

```text
⚠ agents: The agent definition at <path> was not loaded: it does not start with front matter (a line `---`, then `name:` and `description:`, then `---`)
```

Other reasons seen: no `description`; `tools` or `effects` with nothing after it (leave the key out for no
restriction); a tool pattern such as `Bash(git:*)` (name whole tools); an effect that is not one of the four; the
name `none`.

## Not yet

<!-- NOT-YET(agents-start-warnings): the engine says these when the session is created, before a client listens -->
- **Two warnings are missed when a session starts.** That an agent's `tools` or `disallowed-tools` name a tool
  that does not exist here is said when you switch to the agent in a running session, and that a project's
  `agents.default` was not followed is listed by `/agent`; neither is printed by `windlass --agent <name> "<prompt>"`.
<!-- NOT-YET(agents-subagent-row): the line interface's subagent row -->
- **A subagent's row does not name its agent.** `▸ subagent ses_… started` reads the same with and without one;
  `--json` has it (`spawn.started`, `work.agent`).
<!-- NOT-YET(agents-model-switch): no tool lets the model change the session's agent -->
- **The model cannot switch the session's agent.** Only you can; the model can only start a subagent as one.
- **No servers or commands of its own.** A definition cannot give an agent its own MCP servers or hooks.
