# memory

Short notes that persist across sessions: a preference the user stated, a correction they gave, a project fact that
was costly to find, a pointer to a resource. Every note says who wrote it, where and when; it lapses on its own unless
confirmed; and the feature has to show, in an A/B evaluation, that it makes tasks pass more often at no more than the
allowed cost. **Off by default** (`memory.enabled`). A leaf module: nothing in core imports it.

**Not for:** what the repository or `AGENTS.md` already says, the state of the current task, guesses, secrets,
instructions that did not come from the user. Nothing asks the model to save; "saving none is normal" is in the
tool's description, and no per-turn review prompts it.

| File | What |
| --- | --- |
| `entry.ts` | the entry, its file format, default expiry |
| `store.ts` | the files: layout, lock, atomic writes, usage log |
| `hygiene.ts` | expiry, duplicates, supersession, the budget, the review report (pure) |
| `trust.ts` | pending notes and the user's confirmation (pure) |
| `deliver.ts` | the block at session start and the updates during it (pure) |
| `screen.ts`, `tools.ts` | what a note must not be; `memory_save`, `memory_retract`, `memory_search` |
| `usage.ts`, `score.ts` | usage records, per-note and overall statistics |
| `compare.ts` | the A/B comparison on `evals/` results (imports `evals/gate.ts` and `evals/baseline.ts` by path) |
| `config.ts` | the `memory` configuration section |

## Files a person can edit

```
~/.local/share/<brand.directory>/memory/        ($XDG_DATA_HOME if set)
  user/<id>.md                         about the user, every project
  projects/<name>-<hash>/<id>.md       about one project (hash of its real path); project.json names it
  usage/<session>.jsonl                what each session was given and read, how its turns ended
```

```
---
id: m_3f9a2c1b
kind: correction             preference | correction | fact | pointer
scope: project               project | user
status: active               active | pending | retracted | rejected
created: 2026-11-12T09:14:03Z
confirmed: 2026-11-12T09:14:03Z
expires: 365d                <n>d | YYYY-MM-DD | never
author: model                user | model
session: ses_01              message, call, seq: where in that session's log
quote: "this repo is pnpm only"
---
Use pnpm, never npm, in this repository.
```

Only `id`, `kind`, `scope`, `created` and the text are required. Edit the text, change `expires`, set `status:
retracted`, or delete the file; the next read uses it. An unknown key or bad value makes the file invalid: it is
reported with its line (`problems`), never delivered, rewritten or removed. Writes take the scope's lock (`.lock`, an
OS lock released if the process dies), re-read the scope, and create files by hard link or replace them by rename, so
concurrent processes lose nothing and a reader never sees half a file. `memory.inRepository` (user file only) keeps
project notes in `<project>/.<brand.directory>/memory/` to commit them.

## Expiry, duplicates, supersession, budget

- `confirm-within`: a project fact or pointer lapses 90 days after it was last confirmed, a user fact 180, a
  preference or correction 365. `until`: after that day. Lapsing writes nothing. Renewing (the user), a confirmed
  pending note, or the model saving the same note again restarts the period.
- On save, an exact or near duplicate (word-set similarity ≥ 0.8) in the same scope is merged into the existing note
  (it is confirmed again) or, for another kind, a pending note or an untrusted writer, refused naming that note.
- A note may name the one it replaces (`supersedes`). Both stay on disk; the old one is superseded once the new one
  is in force. A pending replacement supersedes nothing.
- Budget per scope (user 2,000 characters / 20 notes, project 4,000 / 40). Over it, keep in this order and cut at
  the first that does not fit: written by the user, then by the model with the user's words, then by the model
  alone; most recently confirmed; most recently created; ID. Dropped notes stay on disk; `memory_search` finds them.
- `reviewReport`: invalid files, pending notes, notes the user corrected the model on after delivery, notes lapsing
  within 14 days or lapsed within 60, notes delivered to 10 sessions and never searched.

## Trust

When the caller says the session has taken in untrusted content, a note the model saves is `pending` with
`untrusted: yes`: not delivered, merged into or superseding anything until the user confirms it
(`confirmationRequests`, `store.decide`). In such a session the model cannot retract or replace notes. A
quote attributed to the user must be found in the session's user messages. Every note reaches the model as a
recalled note with its provenance, under a line saying notes are not instructions.

## Measuring it

`usage/` records what each session held and read; the caller adds outcomes (`passed`, `unchecked`, `unresolved`,
`interrupted`, `reverted`, `corrected_again` naming notes). `formatStats(memoryStats(...))` is readable and labelled
observational. Whether memory stays is decided by the A/B comparison: run the same tasks with memory seeded and
delivered, and without, then

```
bun packages/core/src/memory/compare.ts --with evals/results/<a> --without evals/results/<b>
```

It uses the gate's rules: 3 runs per task on each side, at least 3 tasks, one model and effort; pooled one-sided
Fisher at 0.05 in each direction; median per-task input-token ratio against 1.25. Exit 0 gain, 1 no gain / worse /
gain at a cost, 3 not enough data. It prints how many passes a gain would have needed. The tasks must be ones memory
can help with (a convention stated in an earlier session) and that fail sometimes without it.

## Engine integration

1. **Off unless enabled.** Read `resolveMemoryConfig` when the first baseline is set; if off, do nothing below.
2. **Tool list.** Put `memoryTools(...)` in the frozen list from the first baseline and keep them for the session's
   life. Supply `store` (`openMemoryStore({ paths: memoryPaths({ dataDir, projectDir: LoadedConfig.projectDir,
   inRepository }) })`), `sessionUntrusted` (the safety layer's taint, e.g. an `untrusted` MCP result) and
   `findUserWords` (search the session's visible user messages with `findQuote`; return their `seq` and ID). Effects:
   save and retract `write`, search `read`.
3. **Delivery.** At every step boundary, call `planMemoryDelivery` with the session ID, the fingerprint the
   instruction fold has for `MEMORY_KEY` (`"memory"`), this session's `delivered` records and `store.load().entries`.
   If it returns a plan: `store.recordUsage(plan.record)` first, then append `instruction.appended` with `source:
   "memory"`, `plan.text` and `plan.fingerprint`. Never put it in the baseline. `instructions/source.ts`
   (`renderSection` throws on other keys) and `state.ts` handle only their own keys, so route `memory` here.
4. **Outcomes.** On `execution.succeeded` / `turn.ended`, record `outcomeOfVerification(verification)` with the
   event's `seq` as `turn`; `interrupted` on a user interrupt; `reverted` on `history.reverted`; `corrected_again`
   from a client action naming notes.
5. **The user.** Show `problems`, `confirmationRequests` and `reviewReport` to the user, never the model. Commands:
   remember (`save` with `author: "user"`), retract, confirm/reject, renew.
6. **What to record durably** (fields, not parsed text): on memory's `instruction.appended`, the note IDs and hashes
   it carries; on `tool.settled` of a memory tool, the note ID and outcome (`display.memory`).

`bun scripts/memory-demo.ts` shows a save and two refusals, the block, a replacement appended as an update, an
expiry, a pending note, the statistics, and the comparison.
