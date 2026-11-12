# Dogfood kit

A repeatable pass of the product used the way a developer would use it, on a real repository, with the live model.
Run it after every change that a user could notice. Findings go in the owner's notes, not in this repository.

The kit uses prefixlens (`/home/ubuntu/projects/prefixlens`), a real TypeScript/Bun project (about 26 commits,
203 tests in about 4 s, `tsc --noEmit` in about 1 s). The source repository is only cloned, never changed.

## Files

| File | What |
|---|---|
| `setup.ts` | makes a throwaway workspace: clones the source, removes the clone's `origin`, installs from the lockfile, writes the project configuration with the real checks, optionally plants a seeded bug, commits all of it so the tree starts clean, and prints the commands to start the harness there |
| `calls.ts` | counts the live requests (and tokens) per session for the workspaces of a pass, read-only, counts only |
| `tsconfig.json` | so `bunx tsc --noEmit -p evals/dogfood/tsconfig.json` checks the two scripts |

```sh
bun evals/dogfood/setup.ts --seeds                         # the seeded bugs
bun evals/dogfood/setup.ts --out "$W/clean"                # a clean workspace
bun evals/dogfood/setup.ts --out "$W/bug" --seed usage-bug # with the seeded bug committed
bun evals/dogfood/calls.ts --cwd "$W/clean" --cwd "$W/bug" # requests spent so far in those workspaces
rm -rf "$W"                                                # when done
```

The configuration it writes (`.<brand.directory>/config.json` in the clone) sets `gpt-6-luna`, `low`, the gate with
three rounds, and two checks: `test` (`bun test`) and `types` (`bun run typecheck`). Both run in the sandbox; the
proxy tests, which listen on localhost, pass there.

Sessions land in the normal data directory. `calls.ts --since <minutes>` counts every session there, including other
agents' sessions on a shared machine: prefer `--cwd`.

## Budget and rules

- About 60 live requests for a full pass (the 2026-11-12 pass spent 59). Always `--model gpt-6-luna --effort low`,
  short prompts, one live run at a time.
- An unknown slash command in the line interface (`/help`, `/foo`) is sent to the model and costs a request.
- An effort the model does not accept (`--effort ultra` on `gpt-6-luna`) is sent anyway and costs a request.
- Never print or copy the sign-in. For a "not signed in" test, use a throwaway `XDG_DATA_HOME`.
- Drive the line interface and the full-screen interface through a private tmux server (`tmux -L <name>`), kill by
  PID, remove the socket afterwards. See `.claude/skills/tui-tmux-testing/SKILL.md`.

## The tasks

Each says the workspace, how to run it, and how a person judges the result. Read the output as a first-time user:
is it clear what the agent did, what changed, whether checks ran, what it cost, and how to carry on?

1. **Answer a question** (clean, one-shot).
   `"What does the --tolerance option of 'prefixlens report' do, and where is its default value set? Answer briefly with file:line references; do not change anything."`
   Good: names `src/analyze.ts` (default `?? 128`) and the help text in `src/cli.ts`; no file changed; ends
   `✓ done · nothing to check`. About 3 requests.

2. **Follow-up in a resumed session** (same workspace, `-c`, one-shot).
   `"Add a one-line comment above the line where that default is set, saying what unit it is in."`
   Good: it knows what "that default" is without being told again; one line added; `✓ checks: 2 passed`;
   `✓ done · checks passed`. About 3 requests.

3. **Fix a seeded bug** (`--seed usage-bug`, one-shot with `--json`).
   `"Some normalizeUsage tests for OpenAI fail. Find the bug in src/ and fix it; do not change the tests."`
   Good: the diff is exactly `input_tokens: total` back to `input_tokens: total - cached` in `src/usage.ts`; no test
   file touched; the last JSON line is `execution.succeeded` with `verification.status` `"passed"`. About 7 requests.

4. **A change whose check fails first** (clean, interactive line mode).
   `"Change the default --tolerance of prefixlens report from 128 to 64 tokens, in the code and the help text. Keep it small."`
   The test `losses within the tolerance count as hits` in `test/analyze.test.ts` assumes 128, so the gate fails:
   good is `✗ checks: 1 failed`, `↻ the agent is shown the failing checks and carries on`, then a test change that
   keeps the test's intent (an explicit `toleranceTokens: 128`) and `✓ done · checks passed`. Bad: deleting the test
   or reverting the change. About 12 requests.

5. **Undo** (right after task 4, at the prompt). `/diff`, then `/undo`, then `git status` in the workspace (clean),
   `/redo` (the five files are back), then edit one of them by hand and `/undo` again: it must ask
   (`overwrite them? [y]es · [k]eep mine · [N]o`) and `k` must keep the hand edit. No request.

6. **Rename across files** (clean, one-shot with `-q`).
   `"Rename the exported function promptTokens (src/usage.ts) to totalPromptTokens everywhere it is used, including tests. Nothing else."`
   Good: `grep -rn "promptTokens" src test | grep -v totalPromptTokens` is empty; six files change (`analyze.ts`,
   `cli.ts`, `index.ts`, `pricing.ts`, `usage.ts`, `test/trace.test.ts`); exit 0. About 5 requests.

7. **A command the sandbox restricts** (clean; once interactive, once one-shot with `--unattended stop`).
   `"Run: curl -sS -m 5 https://registry.npmjs.org/typescript/latest -o /dev/null -w '%{http_code}' . If the sandbox blocks the network, ask for network access with the sandbox argument."`
   Interactive: the first run fails in the sandbox with the `[sandbox]` note, the agent asks, the question shows
   the command and the choices; `a` runs it (`⊡ +network`, `200`) and the untrusted-content notice follows.
   One-shot: `○ not run: ... nobody is here to give it`, exit 4. About 3 + 2 requests.

8. **Several steps with a steer** (clean, full-screen interface).
   `"Add a --json flag to 'prefixlens adapters' that prints one JSON object per adapter per line (name, fidelity, description, defaultPath, diagnoses). Add one test in test/cli.test.ts. Keep it small."`
   While it works, steer: `"Also mention the new flag in the HELP text in src/cli.ts."` Good: `↳ steered into the
   turn`, the help text mentions `--json`, a new test passes, `✓ done · checks passed`, the panel's `calls` row
   matches the steps. Then `/diff`, `/undo`, and a resize to 80 columns (no line wider than 80). About 11 requests.

9. **The approval dock** (same full-screen session).
   `"Run exactly: curl -sS -m 5 https://registry.npmjs.org/typescript/latest -o /dev/null -w '%{http_code}' with the shell tool argument sandbox: {\"network\": true} on the first try."`
   Good: the dock opens with `[a] [s] [n] [m]` (no `[p]` for the network); `m` and a note decline it; the row is
   `⊘ ... not allowed by you` with the note; the agent stops. Then Ctrl-D: the exit line names the session and the
   resume command; `tui -c` shows the conversation again. About 2 requests.

10. **Edges** (no or one request each).
    - Not a git repository: a directory with one file `math.ts` (`add` subtracts): `"math.ts: add() subtracts. Fix it; nothing else."`, then `-c` (interactive) and `/undo` must restore it.
    - No sign-in: `XDG_DATA_HOME=<empty dir>` with a prompt, with `--models`, and with `tui`.
    - A typo in a flag (`--modle`), a model that does not exist (`--model gpt-9-nope`), an effort the model does not offer.
    - Ctrl-C with text typed at the prompt, during a running command (`sleep 25`), and at an empty prompt.
    - Two terminals on one session: `-c` (and `tui -c`) while another process holds it.
    - A very long paste: a 200-line, 110 KB message by bracketed paste; it must arrive as one message.

## Reading the results

- `bun evals/dogfood/calls.ts --cwd <workspace>...` for the requests spent.
- `--json` runs: the last line is `execution.succeeded` (or `execution.failed`); `checks.finished` carries each
  check's status, duration and the path of its full output.
- A cache share of 0% on one step in the middle of a turn is usually the provider's lag on a quick follow-up (see the
  harness-testing skill), not the harness.
