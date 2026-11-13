# Working in this repository

Windlass is a coding agent for the terminal. A session is an append-only event log in SQLite, and everything else
(messages, the request sent to the model) is computed from it. Start with `docs/architecture.md`.

## Rules that are easy to break

- **The product's name lives in one file.** Read every name, binary name, alias and directory name from
  `packages/core/src/brand.ts`. Never type the name in code, tests or protocol identifiers.
- **One provider.** ChatGPT-plan sign-in through OpenAI's Responses API. Do not add API-key paths or other providers.
- **The repository is public.** Push only to `origin`, and never anything private: no session data, traces, tokens or
  personal details. Do not add other remotes. A release happens only by pushing a version tag
  (`.github/workflows/release.yml`, `docs/releasing.md`), and only Parth pushes tags: never create or push one. The
  npm packages (`scripts/npm.ts`) are published only by that workflow on Parth's tag, or by Parth by hand: never run
  `npm publish` or `scripts/npm.ts publish`, and never `npm login`.
- **Commits:** one line, conventional style (`feat(engine): ...`), no AI attribution or co-author lines. Say what
  changed for someone reading the log later. No merge commits: rebase and fast-forward. In a checkout shared with
  others, never `git add -A`; commit with an explicit path list: `git commit -m "..." -- <paths>`.
- **The request prefix only grows.** The tool list and system prompt are frozen in a session's baseline and change
  only at a compaction. Anything that changes during a session (instructions, catalogues, notices) is appended as a
  durable message with its text stored. A new tool goes into the frozen list from the first baseline; a tool's spec
  must not depend on configuration or on what servers or skills exist. `packages/core/test/request/` and
  `packages/core/test/trace/prefix-gate.test.ts` enforce this.
- **Stored text is never re-rendered.** Tool output is capped once when produced and replayed byte for byte.
- **The log is the only way state changes.** Append events; the reducer derives state and rejects illegal sequences.
  Do not write to the store around it. Nothing is deleted.
- **The core files change one branch at a time:** `packages/core/src/event/`, `message/reducer.ts`,
  `request/build.ts`, `engine/`. A new feature is a standalone module with its own tests and a README saying what
  the engine must do to use it.
- **Zero runtime dependencies in `packages/core`.** `packages/acp` uses the ACP SDK; `packages/tui` uses OpenTUI.
- **No third-party CLIs, global installs or sudo** in scripts or tests.
- **Fixtures are synthetic and hand-written.** Never commit real session data, traces, or credentials.
- **Tests wait for events, not time, and say what they start.** Use `waitFor` from `@windlass/core/testing`, never a
  fixed sleep; a test file that starts any process is named `*.e2e.test.ts` and sets `setDefaultTimeout(E2E_TIMEOUT_MS)`.
  `test/release/test-waits.test.ts` and `test/unit-preload.ts` enforce this (CONTRIBUTING.md, "Tests and fixtures").

## Layout

```
packages/core   engine, store, reducer, request builder, provider, tools, sandbox, approval, snapshot,
                verify, context (compaction), replay, trace export, config, auth, mcp, skills, agents,
                hooks, lsp, commands, wake-ups, memory, telemetry
packages/acp    Agent Client Protocol v1 server and the shared client
packages/cli    line interface (an ACP client); subcommands acp, tui
packages/tui    full-screen interface (an ACP client)
evals/          tasks, runner, regression gate, baseline, recall and replay suites
scripts/        sign-in helper, demos, trace exporter, replay, build
docs/           user guide, architecture, scenarios (generated), safety, acp, references
```

Memory, hooks, language servers and telemetry are off until configured.

## Commands

```sh
bun packages/cli/src/main.ts --help                 # the CLI from source
bun packages/cli/src/main.ts --demo list            # scripted sessions, no model
bun packages/cli/src/main.ts tui --demo 1           # the full-screen interface on a scripted session
bun scripts/login.ts status                         # sign-in state (never prints tokens)
bun test <path>                                     # run the tests for what you changed, not the whole suite
bun run test:unit                                   # the tests that start no process (CI runs this and test:e2e)
bun run typecheck
bun scripts/scenario-doc.ts --write                 # regenerate docs/step-loop-scenarios.md
bun evals/run-agent.ts <task...> --model gpt-6-luna --effort low --out <dir outside the repo>
bun evals/gate.ts <dir> --hard-only
bun scripts/export-trace.ts <session-id> -o <file>  # then: bunx prefixlens report <file> --all
```

Live model requests spend a ChatGPT plan allowance: keep prompts small, use `gpt-6-luna` at low effort, and count
the requests. Never print, log or commit tokens.

## Testing like a user

Two skills hold the procedures. Read the relevant one before testing. When a run shows that a step is wrong or a
rule is missing, fix that line in place: a rule that still holds and changes what an agent does, with its reason,
and no dates, stories or one-off numbers.

- `.claude/skills/harness-testing/SKILL.md` — headless: a demo, a scripted model, the live model, eval results,
  sign-in.
- `.claude/skills/tui-tmux-testing/SKILL.md` — the full-screen interface through tmux.

## Changing the event log

When you add or change a durable event: update the reducer (its `switch` is exhaustive), the request builder if the
model should see it, the scenarios under `packages/core/test/scenarios/`, and regenerate the scenarios document.
Keep three properties true: rebuilding state from the log equals the stored rows; every request extends the
previous one except at a compaction, revert, refusal or settings change; the engine reproduces each scenario's
event sequence.
