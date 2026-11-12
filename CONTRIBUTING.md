# Contributing

This project is a coding-agent harness in which a session is an append-only event log and everything else is
computed from it. Read `docs/architecture.md` first; `CLAUDE.md` has the rules that are easiest to break.

## Setup

```sh
bun install
bun run typecheck
bun test <path>          # the tests for what you changed
```

Bun is the only tool needed. Tests that check prompt-cache behaviour load the sibling checkout `../prefixlens`
(or `PREFIXLENS_DIR`) and are skipped, saying so, when it is absent.

## What a change must keep true

- **The request prefix only grows.** The tool list and the system prompt are frozen in a session's baseline.
  Anything that changes during a session is appended as a durable message. A tool's name, description and schema
  never depend on configuration or on what servers, skills or agents exist.
- **Stored text is never rendered again.** Tool output is capped once when produced and replayed byte for byte.
- **The log is the only way state changes.** Append events; the reducer derives state and rejects illegal
  sequences. Nothing is deleted.
- **`packages/core` has no runtime dependencies.**
- **One provider** (ChatGPT-plan sign-in through the Responses API). No API-key paths.
- **The product name is a placeholder.** Read every name from `packages/core/src/brand.ts`.

`packages/core/test/request/`, `packages/core/test/trace/prefix-gate.test.ts` and the scenarios under
`packages/core/test/scenarios/` enforce most of this.

## Where a change goes

- A new feature is a standalone module with its own tests and a README that says exactly what the engine must
  do to use it (see `packages/core/src/skills/` for the shape). It defines no durable events.
- The engine, the event schema, the reducer and the request builder (`packages/core/src/engine/`, `event/`,
  `message/reducer.ts`, `request/build.ts`) are changed by one person at a time. A change to a durable event
  updates the reducer, the request builder where the model should see it, the scenarios, and the generated
  `docs/step-loop-scenarios.md` (`bun scripts/scenario-doc.ts --write`).
- The CLI and the full-screen interface are clients of the ACP server and write nothing to a store themselves.

## Tests and fixtures

- Run the tests for what you changed; the whole suite takes several minutes.
- Fixtures are synthetic and hand-written. Never commit real session data, traces or credentials.
- Before calling user-visible work done, run it as a user would: `.claude/skills/harness-testing/SKILL.md`
  (headless) and `.claude/skills/tui-tmux-testing/SKILL.md` (the full-screen interface through tmux).
- Scripts and tests use no third-party command-line tools, global installs or elevated rights.
- Live model requests spend a ChatGPT plan allowance: use a small model at low effort and count them.

## Commits

One line, conventional style (`feat(engine): ...`, `fix(cli): ...`, `docs: ...`), no co-author lines.

## Licence

MIT; see `LICENSE`. By contributing you agree that your contribution is licensed under it.
