# Slash commands

A slash command of your own is a prompt you keep as a file: type `/release-notes 1.4` and the file's text, with
`1.4` put in, is sent as your message. It saves typing the same instructions again, and a repository can carry the
ones its team uses. A command file is text and nothing more: typing its name runs no command and reads no file.
Everything on this page was run against the program with a scripted model; `test/release/feature-docs-3.e2e.test.ts`
checks the paths, keys and messages against the code, and runs the examples.

## The smallest working example

In your project, create `.windlass/commands/release-notes.md`:

```markdown
---
description: Draft release notes for a version from the commits since the previous one
argument-hint: <version> [previous-version]
---
Draft the release notes for version $1.

Look at the commits since $2 (if no previous version is given, since the latest tag), and write one line per
user-visible change. Do not edit any file: show me the notes.
```

Then type its name at the prompt of `windlass` or `windlass tui`, or give it as a one-prompt run:

```sh
windlass "/release-notes 1.4 1.3"
```

You see which file the message came from, then the agent's work on the text with `1.4` and `1.3` in place:

```text
· /release-notes 1.4 1.3 · the text of a command file was sent (4 lines)
  from this project:
    /home/me/proj/.windlass/commands/release-notes.md
```

## Where commands live

Searched in this order; when two commands have the same name, the first one found wins:

1. In the working directory and each directory above it, up to the repository root:
   `.windlass/commands/`, `.agents/commands/` and `.claude/commands/`. Commands written for other agents work
   unchanged.
2. The directories listed in `commands.paths` in a configuration file.
3. Your own commands, `~/.config/windlass/commands/` (`$XDG_CONFIG_HOME/windlass/commands/` when that is set), for
   every project.

A file's path below one of these directories is its name: `release-notes.md` is `/release-notes`, and
`frontend/test.md` is `/frontend:test`. A file may sit up to two folders deep (`a/b/deep.md` is `/a:b:deep`). Each part of a name is letters,
digits, `-`, `_` and `.`, and a whole name is at most 64 characters.

**The program's own commands always win.** A file named `undo.md` never replaces `/undo`: it is listed as hidden,
with the advice to rename it.

## The file

The text of the file is the prompt. Front matter between two `---` lines is optional:

| Front matter | Value |
|---|---|
| `description` | one line, shown in `/help`; without it the first line of the text is used |
| `argument-hint` | what to type after the name, shown beside it in `/help` and in the list `windlass tui` shows as you type |
| `agent` | the agent the session switches to when the command is used ([agents.md](agents.md)) |

Other keys are ignored. `allowed-tools` and `model`, which other agents' command files use, are reported as not
read: a command cannot grant tools or change the model. Name an `agent` that does. A file is at most 64 KiB.

A command that names an agent switches the session to it before the message is sent:

```markdown
---
description: Review the uncommitted changes as a strict reviewer
agent: reviewer
---
Review the uncommitted changes. $ARGUMENTS
```

If there is no such agent, nothing is sent:
`not sent: The command /ghost (<path>) runs under the agent "nobody". There is no agent named "nobody". Agents: reviewer.`

## Arguments

| In the text | Becomes |
|---|---|
| `$ARGUMENTS` | everything you typed after the name |
| `$1`, `$2`, ... | that argument |
| `$$` | one `$`: write `$$5` for a literal `$5` |
| any other `$` | itself (`$HOME`, a lone `$`) |

Arguments are split at spaces; `"two words"` in quotes is one argument. An argument the text uses and you did not
give becomes empty, and you are told:

```text
· /release-notes 1.4 · the text of a command file was sent (4 lines)
  from this project:
    /home/me/proj/.windlass/commands/release-notes.md
  ⚠ argument 2 was not given: it is empty in the text that was sent
```

A text with no `$1` or `$ARGUMENTS` in it gets what you typed added as a last paragraph, `Arguments: ...`, so
nothing you type is dropped. A text that names positions and has no `$ARGUMENTS` has no place for an argument
beyond them: `/release-notes 1.4 1.3 extra` sends the text without `extra`, and both interfaces say so under the
message:

```text
  ⚠ argument 3 ("extra") was not used: the command file has no place for it, so it is not in the text that was sent
```

## What is not supported, on purpose

Other agents run a command written as `` !`git status` `` and read a file named `@src/app.ts` into the text when
you type the slash. Here both stay in the text exactly as written: a file that came with a repository must not run
a command or read a file on your machine because you typed its name. The agent reads the text and can do the same
with its tools, which go through the approval rules like any call. You are told each time the command is used:

```text
  ⚠ !`git status` (line 1) was left as text: a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual
  ⚠ @src/app.ts (line 2) was left as text: a command file reads no file into its text; the agent can read it with its tools
```

## Configuration

Both keys are optional, in the `commands` section of a configuration file:

```json
{ "commands": { "paths": ["~/team-commands"], "disabled": ["old-deploy"] } }
```

| Key in `commands` | Value |
|---|---|
| `paths` | more directories of commands, absolute or starting with `~/` |
| `disabled` | names of commands to leave out, wherever they are found (a namespaced one as `frontend:test`) |

## Listing them: /help

`/help` (in `windlass` and `windlass tui`) lists your commands after the program's own, each with its description, its
`argument-hint` and the file it comes from: this project, a directory `commands.paths` names, or your own. In
`windlass tui` they are also in the list that opens as you type `/`. Below them `/help` lists the command files with
problems: one hidden by a nearer file of the same name or by a built-in command, one that cannot be used and why,
and one that is usable but has a key or a construct that is not read.

```text
Your commands (command files: their text is sent as your message):
  /frontend:test                               Run the frontend tests in packages/web with bun test $ARGUMENTS and fix what fails.
      from this project:
      /home/me/proj/.windlass/commands/frontend/test.md
  /release-notes <version> [previous-version]  Draft release notes for a version from the commits since the previous one
      from this project:
      /home/me/proj/.windlass/commands/release-notes.md
Command files with problems:
  /broken: not usable: line 3 of the front matter is not `key: value`: "no colon here"
      /home/me/proj/.windlass/commands/broken.md
  /undo: hidden: the client's built-in /undo takes the name /undo; rename the file to use it
      /home/me/proj/.windlass/commands/undo.md
```

(The problems are the last lines `/help` prints, after the keys.)

## A name that is not a command

At the prompt a first word of `/` and a name is always taken as a command, and one that is not a command is never
sent to the model:

```text
/relese-notes is not a command, so nothing was sent; did you mean /release-notes? (/help lists them). To send a message that starts with a slash, begin it with two: //relese-notes
/broken cannot be used, so nothing was sent: line 3 of the front matter is not `key: value`: "no colon here".
```

`//etc is odd` sends the message `/etc is odd`. A first word that cannot be a command's name, such as a path
(`/usr/bin/env is missing`), is sent as typed.

A one-prompt run follows the same rule: `windlass "/relese-notes 1.4"` prints the sentence on standard error, sends
nothing and exits with 2.

## Not yet

- **No command of the program's own from a one-prompt run.** `windlass "/undo"` sends nothing, says that `/undo`
  is a command of the interactive prompt, and exits with 2; the program's commands exist at the prompt of an
  interactive session.
- **Running commands and reading files** from a command file, as described above, is deliberately left out and is
  not planned.
