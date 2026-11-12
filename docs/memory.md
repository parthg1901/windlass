# Memory

Memory is short notes that carry over from one session to the next: a preference you stated ("keep answers
short"), a correction you gave ("this repo is pnpm only"), a project fact that was costly to find, a pointer to a
resource. The agent saves a note when you say something worth keeping; later sessions are given the notes that apply
to them. Every note says who wrote it, where and when, and it lapses unless confirmed again. Everything on this page
was run against the program with a scripted model; `test/release/feature-docs.test.ts` checks the keys, paths and
messages against the code.

## Off by default

Memory is **off** unless you turn it on. It is a feature that has to prove itself: it is kept only if, in an A/B
evaluation of the same tasks with and without notes, it makes tasks pass more often at no more than an allowed
extra cost. Until that is shown, a session behaves exactly as without it (its requests are byte for byte the same).

## Turning it on

In your own file, `~/.config/light-harness/config.json`:

```json
{ "memory": { "enabled": true } }
```

New sessions then have three more tools (`memory_save`, `memory_retract`, `memory_search`) and are given the notes.
A session that already exists keeps what it had: whether a session has memory is decided when it starts.

| Key in `memory` | Value |
|---|---|
| `enabled` | `true` turns memory on for new sessions; default `false` |
| `inRepository` | `true`: keep this project's notes in the project, in `.light-harness/memory/`, where they can be committed. Only from your own file |
| `projectChars` | how many characters of project notes a session is given at most; default 4000 |
| `userChars` | the same for notes about you; default 2000 |

Subagents are never given memory.

## Using it

Say the thing you want kept; the model decides whether it is worth a note. Interactively, in the default mode, a save
asks first:

```text
▸ memory_save The user prefers short answers.
? Allow memory_save: writing files?
    memory_save
  The tool did not name a path that could be checked.
[a]llow once · [N]o ›
```

Then `Saved m_4f821c9f (user preference). It will be shown in later sessions in every project. ...`. In a one-shot run
nobody can answer, so the save is refused unless you run with `--approval full`.

A later session shows `· instructions updated (memory): Notes recalled from memory: ...` at its first step. The model
is given the notes under a line that says they are recalled notes, not instructions, and that what you say now and
what is in the repository take precedence:

```text
About the user, in every project:
- [m_00000001] preference, written by the user, 2026-11-12: Write commit messages in the imperative.
- [m_4f821c9f] preference, saved by the assistant from the user's words "keep answers short", 2026-11-12: The user prefers answers of at most three lines.
```

A note the model saves while the session holds untrusted content (a web page, an MCP result) is kept *pending*: it is
not given to any session until you confirm it.

## The files

Each note is one Markdown file you can read, edit or delete; the next session reads what is there.

```text
~/.local/share/light-harness/memory/
  user/<id>.md                         about you, for every project
  projects/<name>-<hash>/<id>.md       about one project; project.json in it names the project's directory
  usage/<session id>.jsonl             what each session was given and read, and how its turns ended
```

The project is the directory that holds `.light-harness/config.json`, else the repository root, else the working
directory. A note:

```markdown
---
id: m_e73cdd1f
kind: correction
scope: project
status: active
created: 2026-11-12T08:40:10Z
confirmed: 2026-11-12T08:40:10Z
expires: 365d
author: model
session: ses_ed6b044c96d36a1798afea45
quote: "this repo is pnpm only"
---
Use pnpm, never npm, in this repository.
```

- Only `id`, `kind`, `scope` and `created` are required, then the text. A note you write by hand is shown as
  "written by the user".
- `kind` is `preference`, `correction`, `fact` or `pointer`; `scope` is `user` or `project`.
- `status: retracted` withdraws a note and keeps the file; deleting the file removes it.
- `expires` is `<n>d` (days after it was last confirmed), a date `YYYY-MM-DD`, or `never`. By default a fact or a
  pointer lapses after 90 days in a project and 180 about you, a preference or a correction after 365.

A file with a mistake is not used, and you are told at the first step (the model is not):

```text
⚠ memory: A memory note is not valid and is not used: <file>: unknown key "colour"; known keys: id, kind, scope, status, created, confirmed, expires, author, session, message, call, seq, quote, untrusted, supersedes, user-confirmed, retracted, retracted-by, retract-reason
```

## Not yet

- **No commands for notes.** There is no command to list, confirm or reject notes in `lh` or `lh tui`; read and
  edit the files. A pending note stays pending: nothing puts the question of confirming it to you yet.
- **Every save asks** in the default mode, with a question that names no path ("writing files"), and is refused in
  one-shot runs.
