# commands

A slash command is a Markdown file whose body is a prompt template: type `/release-notes 1.4` and the template,
with `1.4` put in, is sent as your message. Nothing in a command file runs anything or reads anything when you type
it: expansion is a pure function of the template and what you typed.

The module itself imports only `brand`, `config/schema.ts` (`ConfigError`), `instructions/source.ts`
(`fingerprint`) and `skills/frontmatter.ts`, and defines no durable event. The engine offers it to clients
(`engine/commands.ts`: `EngineSession.commands`, `findCommand`, `expandCommand`, `sendCommand`, and
`Engine.listCommands`) and records which command produced a message (`command.expanded`); the configuration file
has the `commands` section. Commands are the user's side of the conversation: the model is never given a list of
them.

| File | What |
| --- | --- |
| `discover.ts` (`walk.ts`) | roots, precedence, names from paths, malformed files, unsupported constructs found |
| `expand.ts` | splitting arguments and expanding a template; what is left as text |
| `lookup.ts` | reading a typed entry, lookup with built-ins first and a did-you-mean, the listing |
| `config.ts` | the `commands` configuration section |

## For users

### Where commands live

Highest precedence first (`commandRoots`), as for skills and agents:

1. In each directory from the working directory up to the repository root: `.<brand.directory>/commands`,
   `.agents/commands`, `.claude/commands`.
2. `commands.paths` from the configuration, in order.
3. Your `<config dir>/commands`.

The file's path below its directory is the name: `release-notes.md` is `/release-notes`, `frontend/test.md` is
`/frontend:test` (two folders deep at most). Name segments are letters, digits, `-`, `_` and `.`. The nearest
command of a name wins, the others are listed as shadowed. A client's own commands (`/undo`, `/model`, ...) always
win over a file of the same name; the listing says which files are hidden that way.

### The format

The front matter is optional. Keys: `description` (default: the template's first line), `argument-hint` (shown in
the palette), `agent` (switch to that agent, see below). Other keys are ignored; `allowed-tools` and `model` are
reported as not read, because a command cannot grant tools or change the model (name an `agent` that does).

`.claude/commands/release-notes.md`:

```markdown
---
description: Draft release notes for a version from the commits since the previous one
argument-hint: <version> [previous-version]
---
Draft the release notes for version $1.

Look at the commits since $2 (if no previous version is given, since the latest tag) with git log, group them
into Added, Changed and Fixed, and write one line per user-visible change. Leave out refactors and test-only
commits. Do not edit any file: show me the notes.
```

`/release-notes 1.4 1.3` sends that text with `1.4` and `1.3` in place; `/release-notes 1.4` leaves `$2` empty and
the client says argument 2 was not given.

`.claude/commands/review.md`, run under an agent:

```markdown
---
description: Review the uncommitted changes as a strict reviewer
agent: reviewer
---
Review the uncommitted changes (git diff, and git diff --staged). $ARGUMENTS
```

`.claude/commands/frontend/test.md` (`/frontend:test`), no front matter:

```markdown
Run the frontend tests in packages/web with bun test $ARGUMENTS and fix what fails. Do not change the tests
themselves unless one is clearly wrong; say so first.
```

### Expansion

| In the template | Becomes |
| --- | --- |
| `$ARGUMENTS` | everything typed after the name, as typed (trimmed) |
| `$1`, `$2`, ... `$10` | that argument; `$` and digits are read as one number |
| `$$` | one `$`: write `$$5` for a literal `$5`, `$$1` for a literal `$1` |
| any other `$` | itself (`$HOME`, `$0`, a lone `$`) |

Arguments are split at whitespace; `"two words"` and `'two words'` are one argument, and inside double quotes `\"`
and `\\` stand for `"` and `\`. A quote that is not closed runs to the end, with a note. Substituted text is never
expanded again. A position the template uses that was not given becomes empty text and is reported (`missing`); an
argument the template does not use is reported (`unused`). A template with no placeholder at all gets what you typed
appended as a last paragraph, `Arguments: ...`, so nothing you type is dropped.

**Not supported, on purpose.** Other harnesses run a command written as `` !`git status` `` and read a file named
`@src/app.ts` into the text when you type the slash. Here both are left in the text exactly as written, and the
listing and the expansion report them: a file that came with a repository must not run a command or read a file on
your machine because you typed its name. The model reads the text, and can run or read the same thing with its
tools, which go through the approval layer like any call. (`@name` without a slash or an extension, an e-mail
address and a lone `@` are not reported.)

### Typing

1. `/name args`: a client's own command first, then a command file.
2. An unknown name is not sent: `There is no command /deplyo. Did you mean /deploy? To send it to the model as text,
   start it with //.` A command whose file is broken says why.
3. `//etc is odd` is sent as the text `/etc is odd`. A first word that cannot be a command name
   (`/usr/bin/env is missing`) is sent as text.

## For the integrator

The engine is wired (`docs/architecture.md`, "Slash commands and live telemetry"). What is left is the clients':
the ACP server and the two interfaces. Where this section says to call the module's functions, the server calls
the session instead: `session.commands(builtins)` for the listing, `session.expandCommand(name, args)` for a
preview, and `session.sendCommand(entry.name, entry.args, { delivery })` to send, which does steps 2 and 3 below
and the recording in one call and throws `EngineError` `invalid_request`, with the sentence to show, when
nothing was sent.

### Where expansion happens

In the ACP server, not in each client: ACP v1 has the shape for it. The server advertises the commands with a
`session/update` of kind `available_commands_update` (`availableCommands: [{ name, description, input: { hint } }]`,
from `listCommands(set, [])` without hidden names) after `session/new` and `session/load` and whenever discovery
changes (the server may rediscover at each prompt; it is a few `readdir` calls). A client sends `/name args` as the
prompt text, and the server, before admitting the prompt:

1. `parseSlash(text)`. `null`: an ordinary prompt. `text`: admit `entry.text` as the prompt.
2. `lookupCommand(discoverCommands({ cwd, configDir, extraPaths, disabled }), entry.name)` with no built-ins (the
   client has handled its own before sending). `unknown` or `broken`: reject the prompt with `message` as the error;
   **no request is sent to the model**. A client that wants to send such text on purpose sends `//...`.
3. `command`: `expandCommand(command, entry.args)`; admit `expansion.text` as the user's message. When
   `command.agent` is set, look it up with the agents module (`findAgent`); a miss rejects the prompt with its
   message; otherwise the switch (agents README, "Switching") is applied at the boundary where this message is
   delivered, before it.

### What to record

The expanded text is what the model sees and what the log keeps as the user's content (`inbox.enqueued.content`,
unchanged). Which command produced it is a field, never parsed back: a new event `command.expanded`, in the same
transaction as that `inbox.enqueued`, data `{ messageId, name, path, scope, fingerprint, arguments: raw string,
missing: number[], unused: number[], unsupported: [{ kind, text, line }] }` (`unused`: the positions of the arguments
that were typed and are not in the message, because the template names other positions and has no `$ARGUMENTS`;
the record has it so that a transcript, also a replayed one, can say what was left out). `fingerprint` is `CommandDefinition.fingerprint`, the
SHA-256 of the file's text, so the version that was used is known after the file changes. `inbox.enqueued.origin`
stays `null`: it is the user's message. The reducer can fold the event onto the message for the transcript.

### What clients show

- In the transcript: the line as typed (`/release-notes 1.4`), with the source path, and the expanded text folded
  under it; from the `command.expanded` event, so a replayed session shows the same. `missing`, `unused` and `unsupported` as
  one dim line each ("argument 2 was not given", "argument 3 (`extra`) is not used by the command and was not sent",
  "`` !`git status` `` was left as text").
- An extension request `<prefix>/commands` → `listCommands(set, clientBuiltins)` (`commands` and `problems`,
  hidden and shadowed entries included) for a `/commands` listing, and `<prefix>/expand_command { sessionId,
  name, args }` → the `Expansion`, without sending, for a palette preview that warns about `missing` before Enter.

### CLI and TUI

- **Lookup order** in both: (1) the client's built-ins and aliases; (2) anything else that `parseSlash` reads as a
  command goes to the server, which expands it or rejects it (above). Today the line CLI sends an unknown
  `/whatever` to the model as text and spends a request; with the server's rejection it is shown the
  did-you-mean instead, which the CLI prints as an error line, offering `//` to send it as text.
- **TUI**: `parseCommand` in `packages/tui/src/commands.ts` accepts only `[a-z-]*`, so `/frontend:test` and
  `/release-notes2` are not commands to it; widen it to `[A-Za-z0-9][A-Za-z0-9._:-]*` (the `parseSlash` rule) and,
  for a name that is not a built-in, send the entry as the prompt instead of showing "unknown command". The palette
  (`complete`) adds the advertised commands after the built-ins, with their `argument-hint` as `args`, and does not
  list a command a built-in hides.
- **CLI**: `sessionCommand` handles `/undo` and `/redo` only; leave that, and let everything else go to the server as
  above.

### Configuration

`commands` is a section of the configuration file (`config/schema.ts`), validated by `parseCommandsSection`;
`resolveCommandsConfig` applies the defaults and expands `~/`. The engine reads both files' sections: the
project's `paths` first, then the user's, and a name either file disables is left out (a command only produces a
message the user sends).

## Demo

`bun scripts/agents-demo.ts` (shared with agents) copies `examples/commands/` into a temporary project with a
shadowed and a broken command, and prints the listing with a built-in collision, expansions with all argument forms
and a missing one, a typo with its did-you-mean, and a template with the unsupported constructs left as text.
