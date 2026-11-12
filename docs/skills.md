# Skills

A skill is a set of instructions for one kind of task, kept as a file: how to write this project's release notes,
how to run its slow test suite, how to commit in a shared checkout. The model is told which skills exist (a name and
a one-line description each) and loads the whole skill when a task calls for it, so long instructions cost nothing
until they are needed. Everything on this page was run against the program with a scripted model;
`test/release/feature-docs.test.ts` checks the paths, keys and messages against the code.

## The smallest working example

In your project, create `.light-harness/skills/release-notes/SKILL.md`:

```markdown
---
name: release-notes
description: How to write release notes for this project. Use when asked for release notes or a changelog entry.
---
Write one line per change, newest first, in the past tense.
```

Then give `lh` a task in that project:

```sh
lh "write release notes for the last three commits"
```

At the first step you see `· instructions updated (skills): Skills you can load: ...`, and when the model decides the
skill applies, `▸ skill release-notes`, then its work. Nothing else is needed: skills are on in every session.

## Where skills live

Searched in this order; when two skills have the same name, the first one found wins:

1. In the working directory and each directory above it, up to the repository root (outside a repository, the
   working directory alone): `.light-harness/skills/`, `.agents/skills/` and `.claude/skills/`. Skills written for
   other agents work unchanged.
2. The directories listed in `skills.paths` in your own configuration file.
3. Your own skills, `~/.config/light-harness/skills/` (`$XDG_CONFIG_HOME/light-harness/skills/` when that is set),
   for every project.

Each skill is a directory holding a `SKILL.md`. It may sit up to three levels below one of these directories, so you
can group skills in folders; directories whose names start with `.`, and `node_modules`, are skipped. Other files in
a skill's directory are its supporting files: the model is given their paths when it loads the skill.

## The file

`SKILL.md` starts with front matter between two `---` lines, then the instructions in Markdown.

| Front matter | Value |
|---|---|
| `name` | letters, digits, `-`, `_` and `.`, at most 64 characters; without it the directory's name is used |
| `description` | required: one line that says what the skill is for and when to use it; this is what the model decides on |

Other keys (`license`, `allowed-tools`, ...) are ignored. A file is at most 256 KiB.

## Configuration

Both keys are optional, in the `skills` section of a configuration file:

```json
{ "skills": { "paths": ["~/team-skills"], "disabled": ["old-release-process"] } }
```

| Key in `skills` | Value |
|---|---|
| `paths` | more directories of skills, absolute or starting with `~/`. Read from your own file only: in a project's file it is ignored, without a message |
| `disabled` | names of skills to leave out, wherever they are found; from either file |

## What the model sees

The skill index is given to the model as a message, at the first step and again whenever a skill is added or
removed or a name or description changes:

```text
Skills you can load:
<skills lines="3">
Skills are instructions for particular kinds of task, kept as files. When a task matches a skill's description, load the skill with the skill tool (by name) before you start, and follow it.

- release-notes: How to write release notes for this project. Use when asked for release notes or a changelog entry.
</skills>
```

The `skill` tool returns the file's body as it is when it is called, so editing the instructions of a skill takes
effect at its next load without a new index. A name the model gets wrong is answered with a suggestion:

```text
There is no skill named "relese-notes". Did you mean "release-notes"? Skills: release-notes.
```

Whether the model loads a skill is its decision, made from the description: write the description as "what it is
for. Use when ...".

## What can go wrong

A skill that cannot be loaded is skipped, and you are told once, at the first step (the model is not told):

```text
⚠ skills: The skill at <path> was not loaded: it does not start with front matter (a line `---`, then `name:` and `description:`, then `---`)
```

Other reasons it names: the front matter is not closed, a line that is not `key: value`, a duplicated key, no
`description`, a name with other characters, a file over 256 KiB. A skill whose name a nearer one already has is
left out the same way: `⚠ skills: The skill at <path> is hidden by another skill of the same name: ...`.

## Not yet

There is no command to list skills: `/skills` is a command in neither interface (the line interface sends it to the
model as a message). To see which skills the model was given, read the `· instructions updated (skills)` line, or run a
one-shot with `--json` and look at the `instruction.appended` event whose `source` is `skills`.
