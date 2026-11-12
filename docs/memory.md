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

In your own file, `~/.config/windlass/config.json`:

```json
{ "memory": { "enabled": true } }
```

New sessions then have three more tools (`memory_save`, `memory_retract`, `memory_search`) and are given the notes.
A session that already exists keeps what it had: whether a session has memory is decided when it starts.

| Key in `memory` | Value |
|---|---|
| `enabled` | `true` turns memory on for new sessions; default `false` |
| `inRepository` | `true`: keep this project's notes in the project, in `.windlass/memory/`, where they can be committed. Only from your own file |
| `projectChars` | how many characters of project notes a session is given at most; default 4000 |
| `userChars` | the same for notes about you; default 2000 |

Subagents are never given memory.

## Using it

Say the thing you want kept; the model decides whether it is worth a note. In the default mode (`auto`) and in `full`
a save runs without a question, in a one-shot run too: a note is one of the program's own records, not a file of
your workspace, and saving one sends nothing anywhere ([safety.md](safety.md)).

```text
▸ memory_save The user prefers short answers.
  ✓ Saved m_4f821c9f (user preference). It will be shown in later sessions in every project. ...
```

Retracting a note (`memory_retract`) is decided the same way. Only the `ask` mode, where every change asks, asks
about either:

```text
▸ memory_save The user prefers short answers.
? Allow memory_save: changing Windlass's own records?
    memory_save
  It changes only what Windlass keeps for itself (wake-ups, notes): no file of the workspace, and nothing is sent anywhere.
[a]llow once · this [s]ession · this [p]roject · [N]o ›
```

and in a one-shot run with `--approval ask` nobody can answer, so the save is refused.

A later session shows `· instructions updated (memory): Notes recalled from memory: ...` at its first step (the
session that saved the note shows the same line at its next step, or `Memory changed during this session: ...`
when it already had notes). The model is given the notes under a line that says they are recalled notes, not
instructions, and that what you say now and what is in the repository take precedence:

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
~/.local/share/windlass/memory/
  user/<id>.md                         about you, for every project
  projects/<name>-<hash>/<id>.md       about one project; project.json in it names the project's directory
  usage/<session id>.jsonl             what each session was given and read, and how its turns ended
```

The project is the directory that holds `.windlass/config.json`, else the repository root, else the working
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

## Commands

In `windlass` and `windlass tui`, for a session that has memory:

| Command | What it does |
|---|---|
| `/memory` | the notes in force (who wrote each, when, when it lapses), the ones not in force, the notes waiting for your confirmation, files with mistakes, and what is about to lapse |
| `/memory confirm <id>`, `/memory reject <id>` | decide on a pending note: confirmed, later sessions are given it; rejected, none is |
| `/memory renew <id>` | the note is still true: it is confirmed today, which restarts its lapse period |
| `/remember <text>` | save a note as you, for this project; `/remember --me <text>` saves one about you, for every project. It is "written by the user" |
| `/forget <id>` (or `/memory forget <id>`) | retract a note: no later session is given it; the file is kept with `status: retracted` |

When memory is off, `/memory` says so and how to turn it on; a session started while it was off has none, so it also
says to start a new session.

A session reads its notes when its first turn starts. Before your first message `/memory` says so and asks you to
send a message first. A `/remember` typed then is not lost: it is kept, saved as soon as your first message is
sent, and reported after that turn (`your note from before the first message: Saved m_… (fact, for this project)
...`). If you leave without sending a message it is not saved, and `windlass` prints the note's text so that you
still have it. An editor does the same with `_windlass/memory` and `_windlass/memory_change`
([acp.md](acp.md)).

## Not yet

- **Pending notes are not put to you unasked.** `/memory` lists them; nothing asks at the prompt when one is saved.
