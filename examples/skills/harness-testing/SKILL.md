---
name: harness-testing
description: How to test Windlass like a user, headless, without spending model calls unless they are needed. Use before calling a feature done, when a change needs proof beyond unit tests, when a live ChatGPT-plan request is needed, or when sign-in fails.
---

# Testing Windlass headless

Unit tests prove the pieces; this proves the product. Run the real entry points end to end and read the output as a user would. Work from the cheapest check to the most expensive and stop as soon as one fails.

## Rules

- The only provider is ChatGPT plan usage (Sign in with ChatGPT). No API keys, no other providers.
- Live requests spend the owner's plan allowance. Use the scripted fake provider or `--demo` for anything that does not need a real model, and keep live prompts tiny.
- Never print, log or commit tokens. `auth.json` lives in the data directory, outside the repository.
- Never commit real session databases or transcripts. Fixtures are small, synthetic and hand-written.
- Run tests from a package directory (`cd packages/core && bun test test/<area>`), and only the tests of what you changed while others work in the same tree. `bun run typecheck` covers the whole repository; errors in files you did not touch are someone else's work in progress.

## The ladder, cheapest first

1. **Focused tests.** `bun test test/<area>` in the package. Tests use real temporary directories and real child processes, never mocks of the thing under test.
2. **The demo scripts** (`scripts/*-demo.ts`, for example `bun scripts/engine-demo.ts`, `bun scripts/tools-demo.ts`). Each prints what the model would see for one subsystem; read it, do not just check the exit code.
3. **The CLI with the fake engine.** `bun packages/cli/src/main.ts --demo list`, then `--demo <name> --demo-speed 0`. No sign-in, no model calls; shows rendering, interrupts and exit paths.
4. **One live prompt.** `bun packages/cli/src/main.ts --cwd <scratch dir> --model <slug> --effort low "<tiny prompt>"`. Add `--json` to get one event per line for checking with a script. Exit codes: 0 done, 1 failed, 3 unresolved (the verification gate did not pass), 130 interrupted.
5. **Real tasks.** `bun evals/run-agent.ts <task-id> --model <slug>` for one task, `--all --effort low --out <dir outside the repo>` for the suite (about ten tasks, a few minutes, about sixty requests).

Use a scratch working directory outside the repository for anything that runs the agent, and delete it afterwards.

## Sign-in

```sh
bun scripts/login.ts status   # account, scopes, minutes until the access token expires
bun scripts/login.ts ping     # lists models, then one tiny request with usage
```

On a remote machine the sign-in redirect goes to the browser's own computer: `bun scripts/login.ts start`, the owner approves and copies the full callback URL, then `bun scripts/login.ts finish <file with the URL>`. Ask for the URL through a secret prompt, never in chat.

## Reading results

- A step that read fewer cached tokens than the one before is not automatically a harness bug. Export the session (`bun scripts/export-trace.ts <session-id> -o <file>`) and check whether every request was the previous one plus appended items; if it was, the miss is the provider's.
- A failed task is not always the agent's fault. Read the task prompt against the grader's reason before blaming either.
- Known behaviour of the live API, and the probes for it, are in `reference/live-api.md`.

## Gotchas

- Do not stop a background helper with `pkill -f <its command line>` from a shell whose own command line contains the same text: it kills the shell too. Kill by PID.
- When a test starts child processes, check afterwards that none is left (`ps -eo pid,args | grep <name>`).
