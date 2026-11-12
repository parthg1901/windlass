# Working in this repository

A coding-agent harness: a session is an append-only event log in SQLite, and everything else (messages, the request sent to the model) is computed from it. Start with `docs/architecture.md`.

## Rules that are easy to break

- **The product's name lives in one file.** Read every name, binary name, alias and directory name from `packages/core/src/brand.ts`. Never type the name in code, tests or protocol identifiers.
- **One provider.** ChatGPT-plan sign-in through OpenAI's Responses API. Do not add API-key paths or other providers.
- **Nothing is published.** Local commits only. Never push, add a remote, or publish a package.
- **Commits:** one line, conventional style (`feat(engine): ...`), no AI attribution or co-author lines. Say what changed for someone reading the log later: no agent or branch names, no planning words (pass, wave, prep, leaf, spine), no finding numbers. No merge commits: rebase and fast-forward. In a checkout shared with other agents, never `git add -A`; commit with an explicit path list: `git commit -m "..." -- <paths>`.
- **The request prefix only grows.** The tool list and system prompt are frozen in a session's baseline and change only at a compaction. Anything that changes during a session (instructions, catalogues, notices) is appended as a durable message with its text stored. A new tool goes into the frozen list from the first baseline; a tool's spec must not depend on configuration or on what servers or skills exist. `packages/core/test/request/` and `packages/core/test/trace/prefix-gate.test.ts` enforce this.
- **Stored text is never re-rendered.** Tool output is capped once when produced and replayed byte for byte.
- **The log is the only way state changes.** Append events; the reducer derives state and rejects illegal sequences. Do not write to the store around it. Nothing is deleted.
- **The spine has one owner at a time:** `packages/core/src/event/`, `message/reducer.ts`, `request/build.ts`, `engine/`. Features are built as standalone modules with a README for the integrator, then wired in during one pass.
- **Zero runtime dependencies in `packages/core`.** `packages/acp` uses the ACP SDK; `packages/tui` uses OpenTUI.
- **No third-party CLIs, global installs or sudo** in scripts or tests.
- **Fixtures are synthetic and hand-written.** Never commit real session data, traces, or credentials.

## Layout

```
packages/core   engine, store, reducer, request builder, provider, tools, sandbox, approval,
                snapshot, verify, context (compaction), replay, trace export, config, auth
                mcp, skills, wake (wired in; wake-ups fire only where the engine is told to run them),
                memory (wired, off by default)
                agents and the todo tool (wired in)
                hooks and lsp (language-server diagnostics), wired in; both off until configured
                commands (slash commands) and telemetry (OpenTelemetry export), wired in; telemetry off until the user's own file turns it on
packages/acp    Agent Client Protocol v1 server and the shared client
packages/cli    line-based CLI (an ACP client); subcommands acp, tui
packages/tui    full-screen interface (an ACP client)
evals/          tasks, runner, regression gate, baseline, recall and replay suites
scripts/        sign-in helper, demos, trace exporter, replay, build
docs/           architecture, scenarios (generated), safety, acp, replay, references
```

## Commands

```sh
bun packages/cli/src/main.ts --help                 # the CLI from source
bun packages/cli/src/main.ts --demo list            # scripted sessions, no model
bun packages/cli/src/main.ts tui --demo 1           # the full-screen interface on a scripted session
bun scripts/login.ts status                         # sign-in state (never prints tokens)
bun test <path>                                     # run the tests for what you changed, not the whole suite
bun run typecheck
bun scripts/scenario-doc.ts --write                 # regenerate docs/step-loop-scenarios.md
bun evals/run-agent.ts <task...> --model gpt-6-luna --effort low --out <dir outside the repo>
bun evals/gate.ts <dir> --hard-only
bun scripts/export-trace.ts <session-id> -o <file>  # then: bunx prefixlens report <file> --all
```

Live model requests spend the owner's ChatGPT plan allowance: keep prompts small, use `gpt-6-luna` at low effort, and count the requests. Never print, log or commit tokens.

## Testing like a user

Two skills hold the procedures and the problems found so far. Read the relevant one before testing, and add to it when a run teaches something:

- `.claude/skills/harness-testing/SKILL.md` — headless: sign-in, real tasks, reading eval results.
- `.claude/skills/tui-tmux-testing/SKILL.md` — the full-screen interface through tmux.

## Changing the spine

When you add or change a durable event: update the reducer (its `switch` is exhaustive), the request builder if the model should see it, the scenarios under `packages/core/test/scenarios/`, and regenerate the scenarios document. Keep three properties true: rebuilding state from the log equals the stored rows; every request extends the previous one except at a compaction, revert, refusal or settings change; the engine reproduces each scenario's event sequence.
