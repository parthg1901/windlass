# Dogfood kit

A repeatable pass of the product used the way a developer would use it, on a real repository, with the live model.
Run it after every change that a user could notice. Keep findings out of this repository.

The kit uses prefixlens (a checkout beside this repository at `../prefixlens`, or `--source <repo>`), a real TypeScript/Bun project (about 26 commits,
203 tests in about 4 s, `tsc --noEmit` in about 1 s). The source repository is only cloned, never changed.

## Files

| File | What |
|---|---|
| `setup.ts` | makes a throwaway workspace: clones the source, removes the clone's `origin`, installs from the lockfile, writes the project configuration with the real checks, optionally plants a seeded bug, commits all of it so the tree starts clean, and prints the commands to start the harness there |
| `calls.ts` | counts the live requests (and tokens) per session for the workspaces of a pass, read-only, counts only; with `--cwd` it also counts the sessions descended from them (subagents, also in worktrees; forks, also in copies; replays), which work outside the workspace |
| `events.ts` | prints a session's durable events one per line (`--type compaction`, `--full`), read-only: what the log says happened, next to what a client showed |
| `mcp-server.ts` | a small stdio MCP server written as a user would (handshake protocol, two tools whose answers the model cannot guess: `shelf_code`, `inventory`); `--log <file>` records every request it receives |
| `mcp-config.ts` | adds (or `--remove`s) that server in a user's config home (`--user <dir>`, used with `XDG_CONFIG_HOME=<dir>`) or a workspace's project config (`--project <dir>`); `--trusted` sets `"untrusted": false` |
| `make-image.ts` | writes a synthetic PNG (`--pattern halves`, `digit` or `shapes`) with an answer a person can check |
| `hooks-config.ts` | adds (or `--remove`s) four hooks (`no-push`, `no-env`, `house-rule`, `no-scratch`) and optionally a language server (`--lsp <langserver.js>`, run with `node`) in a user's config home or a workspace's project config; `--marker <word>` ends one hook's command with a 190-character word that ends in the marker, to check that an approval question shows the whole command |
| `otel-collector.ts` | a local stand-in for an OpenTelemetry collector: appends every request it receives to a file; `--check <file> <word>...` counts each word in what was received and lists the attribute keys |
| `webhook.ts` | sends one signed request to a webhook wake-up (the secret from `WAKE_SECRET` or standard input, never printed); `--bad` signs wrongly, `--repeat` sends it twice, `--github` signs as GitHub does |
| `tsconfig.json` | so `bunx tsc --noEmit -p evals/dogfood/tsconfig.json` checks the scripts |

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

- About 60 live requests for tasks 1 to 10 (the first 2026-11-12 pass spent 59); about 160 for tasks 11 to 21 (the
  second pass spent 160, replays and subagents included); about 170 for tasks 22 to 33 (the third pass spent 172); about 115 for tasks 34 to 41 (the fourth pass spent 115).
  Always `--model gpt-6-luna --effort low`, short prompts, one live run at a time.
- An unknown slash command (`/foo`) and an effort the model does not accept (`--effort ultra` on `gpt-6-luna`)
  cost nothing any more: both are refused before anything is sent.
- The source repository moves. When `setup.ts --seed` says the file "no longer has the expected text", read the
  file in a clean clone and update `SEEDS` (the third pass had to).
- The README's interactive commands (the program with no arguments, and `tui`) name no model: in a directory
  without a project configuration they run on the account's default model. Add `--model gpt-6-luna --effort low`
  when following the README (the fourth pass spent 15 requests on the default model before noticing).
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
   Good: the diff is exactly `input_tokens: total - (writes ?? 0)` back to `input_tokens: total - cached - (writes
   ?? 0)` in `src/usage.ts`; no test file touched; the last JSON line is `execution.succeeded` with
   `verification.status` `"passed"`. About 7 requests when the first fix is right; 23 when the gate sends the agent
   back once (`✗ checks: 1 failed`, `↻ the agent is shown the failing checks and carries on`, then `✓ done · checks
   passed`), which is the "failing check" case of task 22.

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

## The second pass: features beyond the basics (tasks 11 to 21)

Set up once: `W=<empty parent>`, `bun evals/dogfood/setup.ts --out $W/c1/repo`, and a throwaway config home
`C=<dir>` used as `XDG_CONFIG_HOME=$C` (the sign-in stays in the data directory). Interactive runs go through a private
tmux server. Wait for the line interface's first `›` before typing: text typed while it starts sits unsent in the
prompt and looks sent (task 21).

11. **Compaction across turns** (clean, one-shot, with the test context window set to 20000: the variable's name is
    `TEST_CONTEXT_WINDOW_ENV` in `packages/core/src/assembly.ts`, built from `brand.envPrefix`). Four `-c` turns: `"Remember the codeword PELICAN-42;
    I will ask for it later. Now read src/usage.ts and tell me in two sentences what normalizeUsage does. Change
    nothing."`, then read `src/analyze.ts`, then `src/cli.ts` (this one compacts: `⇣ compacted the conversation ·
    about 12,185 → 5,499 tokens`), then `"What was the codeword I gave you at the very start, and on what line of
    src/usage.ts did normalizeUsage start?"`. Good: `history_search` then `history_read`, `PELICAN-42` and line 12.
    Then `-c` interactive and `tui -c` on the same session: what does a resumed session show? About 13 requests.
12. **Compaction inside one turn** (same window, TUI then one-shot). `"Read src/analyze.ts, then src/diff.ts, then
    src/trace.ts, one at a time (not in parallel). Then tell me in one sentence each what they are for. Change
    nothing."` Read the compaction rows and `events.ts <id> --type compaction`: how many summary calls, and does the
    ending's step count say what was spent? About 6 requests each.
13. **Forks** (no request to make them). `windlass fork <id>`, `windlass fork <id> --through <n>` (find step boundaries with
    `events.ts`: a user has no way to), `windlass fork <id> --copy`, `/fork` in the TUI and `/sessions` there. Continue each
    with one question about the conversation (`"What was the codeword?"`) and, in the copy, one edit: are the project's
    checks able to run in the copy (no `node_modules`, no `.git`)? About 4 requests.
14. **Replay** of a recorded edit (record: `"In src/analyze.ts, add a one-line comment above the line where the
    default tolerance (128) is set, saying what unit it is in. Nothing else."`), then `windlass replay <id>` under `stop`,
    `--policy execute-read-only`, and `--policy execute --system-prompt <file>` (a prompt that says to run `bun test`
    before editing). Compare with `docs/replay.md` and with `bun scripts/replay.ts <id>`. About 15 requests.
15. **Subagents** (one-shot, then interactive line mode, then TUI). Foreground: `"Use a subagent to count how many test
    files are in test/ and what the largest one is."` (15, `adapters.test.ts`). Background: `"Start a subagent in the
    background (background: true) to list the exported functions of src/usage.ts. While it works, tell me the package
    name from package.json."` Approval: a subagent that must run the curl of task 7 with `sandbox: {"network": true}`
    (the question names the subagent; `a`). Worktree: `"Use a subagent with a worktree of its own (worktree: true) to
    add the line // added by a subagent at the very top of src/usage.ts."` then `/undo`. Interrupt: `"Use a foreground
    subagent to run the shell command: sleep 41 && echo finished."`, Ctrl-C once `pgrep -x sleep` shows it; nothing
    may be left running. In the TUI: Alt-Up to the subagent row, Ctrl-O. About 30 requests.
16. **Background commands** (interactive). `"Start this in the background (shell with background: true): for i in
    $(seq 1 300); do echo tick $i; sleep 1; done. Then run sleep 5 in the foreground, then read the background
    command's output so far, then stop it."`; then one left running across Ctrl-C (`sleep 301` in the background,
    `sleep 31` in the foreground); then one left running at the end of a turn and Ctrl-D. Check with `pgrep -a -x
    sleep` after each. About 10 requests.
17. **MCP**: `bun evals/dogfood/mcp-config.ts --user $C --log <log file>`, then `"What is the shelf code of 'bolts' in the
    warehouse? Use the MCP tool. One line."` one-shot (refused), with `--approval full` (untrusted server: refused
    too, see the skill), with `--trusted` and `--approval full` (answers `WH-F0239`), interactively (the question,
    `s`, a second item without a question) and in the TUI (the dock). Then `--project <workspace>` instead: what
    does the user see, and can they approve it? The log file shows what the server received. About 20 requests.
18. **Skills**: a workspace skill (`.claude/skills/release-note/SKILL.md`: start with `RN-7731`, end with `Signed: the
    release bot`), a user skill in `$C/<brand.directory>/skills/poem` (three lines ending in `OTTER`), a broken one
    (front matter not closed), and the workspace skill's body and description edited between two interactive turns
    (`RN-9999` must appear in the second). About 12 requests.
19. **Wake-ups** (interactive line mode and TUI): `"In one minute from now, remind me to stretch. Set a wake-up for it,
    then end your turn."` and wait two minutes. Then cancel every wake-up you made (`wake_cancel`), interactively:
    a pending one would fire into your session, at a cost, once a process runs the scheduler. About 8 requests.
20. **Images**: `bun evals/dogfood/make-image.ts img1.png --pattern shapes` (and `--pattern digit` as `img2.png`) in
    the workspace, under names that give nothing away: `"Look at img1.png with the read tool. What shapes and colours
    does it show, and where? Two sentences."` Good: a yellow circle top left, a green square bottom right; a 7. About
    5 requests.
21. **Edges and the built executable**: `--session` with an ambiguous, a wrong and a short prefix; `--unattended deny`
    with the curl of task 7; Ctrl-C while the answer streams (`"Without tools, write a 600-word essay about prompt
    caching."`); two interactive sessions in one workspace editing one file, then `/undo` in the first; text typed
    before the line interface shows `›`. Then `bun scripts/build.ts`, copy `dist/windlass-linux-arm64` out of the
    repository, and repeat a one-shot, `tui` with `/fork`, `fork --json`, and `--models` with an empty
    `XDG_DATA_HOME` (a crash: does it name source lines?). Time `--version` and the TUI's `● ready` against the
    source, and say the machine's load (`uptime`) with the numbers. About 10 requests.

## The third pass: the fixes as a user sees them, and the newer features (tasks 22 to 33)

Set up as for the second pass (`$W/c1/repo` clean, `$W/b1/repo` with `--seed usage-bug`, a throwaway config home `$C`
used as `XDG_CONFIG_HOME=$C`). Each entry says what a good run shows; the words in quotes are the program's.

22. **The basics again** (line interface, then the full-screen one). One prompt with a failing check (task 3 in
    `$W/b1/repo`). Interactive: `/help` (a list), `/hlep` and `/foo bar` (`is not a command, so nothing was sent`),
    the comment of task 14, a follow-up (`"Now reword that comment to say 'in tokens (not bytes)'."`), `/diff`,
    `/undo` (`↶ undone: turn 2 "…" · out of the conversation`), `/redo`, `/undo` again, then a hand edit
    (`echo "// hand edit" >> src/pricing.ts`) and `"What is the package name in package.json? One line, change
    nothing."`: no check may run and the ending must say the files were not checked. Ctrl-D, then `-c`: `resumed
    session … · 3 turns (1 undone)` and the last two turns. No request: `--modle`, `--models` and a prompt with an
    empty `XDG_DATA_HOME`, `--effort ultra`, `--model gpt-9-nope`, `--agent nope`. About 35 requests.
23. **Agents**. `.claude/agents/reviewer.md` in the workspace and `$C/<brand.directory>/agents/auditor.md` (both
    `effects: read`; the auditor's instructions: start every answer with `AUDIT:`), and one with its front matter not
    closed. `--agent reviewer "Add the comment '// reviewed' as the first line of src/pricing.ts. If the write tool
    is refused, try the shell: echo '// reviewed' > note.txt. Then say in one line what happened."` (both `○ not run:
    the reviewer agent may not …`, nothing changed); `--agent auditor` with a question (`AUDIT:`); `"Use a subagent
    run as the agent auditor (agent: \"auditor\") with the task: create the file audit.txt containing the word done,
    then report whether you could. …"` from a session without an agent; `/agent`, `/agent reviewer`, `/agent none`,
    `/agent reviwer` at the prompt and the picker in the full-screen interface. Also ask the reviewer for a
    `wake_create` check and a background `shell`: both must be refused. About 20 requests.
24. **The task list** (the test context window at 20000). `"Keep a task list with these four items and work through
    them one at a time, updating the list as you go: 1) read src/usage.ts and note its exported functions, 2) read
    src/pricing.ts …, 3) read src/diff.ts …, 4) write EXPORTS.md listing all three files' exports."` Good: `≡ tasks`
    after each step, two compactions in the turn with the list right after each, an ending such as `14 steps + 2
    summary calls`, and after Ctrl-D and `-c` (and `tui -c`) `Its task list (all 4 done):`. Then `/undo` of a
    task-list turn in the full-screen interface: the panel's `Tasks` section goes with it. About 25 requests.
25. **`/rename`, `/compact`**. `/rename Tolerance comment` then `--list-sessions`; `/compact` in a short session
    (`Not compacted: only about …` or `There is nothing to compact: …`) and in the session of task 24 with the test
    window; Ctrl-D while `⋯ compacting the conversation` shows, then `-c`: what does the next start say and do?
26. **MCP again** (`mcp-config.ts --user $C`, then `--remove` and `--project <workspace>`). One prompt with
    `--approval full` against the server at its default trust (answers `WH-F0239`, then the untrusted-content
    notice); interactively `s` at the question and a second item (it asks again: the first result tainted the
    session; the second `s` holds); the project's server: the question, `y` during the turn, `"Try again now."`,
    `/mcp`. Then give the project's server one argument longer than the terminal is wide, ending in a marker
    (`…mcp-server.ts${IFS}--log${IFS}<log>;echo${IFS}TAIL-MARKER>/dev/null` under `bash -c`), and read the
    question in both interfaces: is the marker on screen? Answer `n`. About 15 requests.
27. **Wake-ups** (interactive). Task 19's reminder and two minutes' wait (`⏰ wake-up wk_…: it fired`); `"Create a
    webhook wake-up with the message 'a deploy finished', and another wake-up that fires every 10 minutes with the
    message 'check the build'. Then end your turn."`; `WAKE_SECRET=… bun evals/dogfood/webhook.ts <URL> --bad` (401),
    `--repeat` (202 then 401) and the turn it starts (tainted); `/wakeups`, `/wakeups secret <id>`, `/wakeups
    cancel <id>` for each. Then the reminder as one prompt: nothing may fire, also 75 seconds later; cancel it with
    `--session <id> "Cancel every wake-up of this session with wake_cancel. One line."` About 12 requests.
28. **Hooks** (in `$C/<brand.directory>/config.json`; the format is in `packages/core/src/hooks/README.md`): a
    `beforeTool` hook on `shell` that refuses `git push`, an `afterTool` hook on `edit` and `write` that exits 2
    with a house rule, a `stop` hook that refuses while `SCRATCH.md` exists, `maxStopRounds` 2. `"Run 'git push
    origin main' with the shell tool exactly once and tell me in one line what happened."` and `"Do exactly this and
    nothing more: 1) write SCRATCH.md containing the word tmp. 2) write greet.py with: def greet(name: str) -> str
    returning a greeting, and a last line that calls gret(42) (yes, misspelled, on purpose). Then give a one-line
    answer."` Read the screen for what the user is told (the refusal, the note, why the turn went on) and
    `events.ts <id> --full` for what the model was told. Then one hook in the project's file: the notice, and
    whether anything can approve it. About 8 requests.
29. **Diagnostics** (a language server already on the machine; install nothing): pyright from the uv cache as
    `node <…>/pyright/dist/langserver.index.js --stdio` under `lsp.servers.python` in `$C`. Interactively, two
    edits of `greet.py` made with the edit tool (say so: the model appends with the shell otherwise, and a shell
    edit gets no diagnostics): the first misses (`⚠ lsp: … did not give diagnostics within 1500 ms`), the second
    adds the note. `events.ts <id> --type tool.settled --full` shows `diagnostics` and `waitedMs`. About 8 requests.
30. **Skills and memory**. Task 18's `release-note` skill as one prompt (`RN-7731` … `Signed: the release bot`).
    `{ "memory": { "enabled": true } }` in `$C`: `"Remember for later sessions: this repository uses bun only,
    never npm. Save it as a memory note, then answer in one line."` as one prompt; then interactively `/remember
    <text>` and `/memory` before the first message and after it; `/forget <id>` for every note the pass made (they
    are kept in the real data directory). About 5 requests.
31. **Forks and replay**. `fork <id> --turn 1`, `--turn 2` on an undone turn (refused, with the turns listed),
    `--turn 9`, and with a data directory that holds only a copy of the session's files and no sign-in (it must
    still fork). One question to the fork. `replay <id>` of a two-step session under `stop`. About 6 requests.
32. **A subagent with a background command, and an image**. `"Use a subagent with this task: start 'sleep 13 &&
    echo bg-finished' in the background (shell with background: true), then run 'echo fg' in the foreground, then
    wait for the background command to end, read its output and report it. Tell me what it reported, in one line."`
    (`pgrep -a -x sleep` afterwards: nothing), and task 20's image. About 12 requests.
33. **The built executable**. `bun scripts/build.ts`, copy `dist/<brand.binary>-linux-arm64` to a directory outside
    the repository under the binary's name and link its short name to it; from there: `--version` under both names,
    `--models` with an empty `XDG_DATA_HOME`, a mistyped option, `fork --turn 3 --json`, `--demo list`, a one-prompt
    edit with the checks (`--cwd`), `tui` with the hooks of task 28, and the network question of task 9 with a URL
    150 characters long ending in a marker, in both interfaces: the whole command must be on screen. About 20 requests.

## The fourth pass: the README as a stranger, a project's own configuration, and what was left (tasks 34 to 41)

Set up: `$W/c1/repo` clean, `$W/h1/repo` and `$W/h2/repo` clean with `hooks-config.ts --project` (below), a tiny
project of your own for the README (`src/add.ts` whose `add` subtracts, `src/add.test.ts`, `git init`), and one
throwaway config home per configuration (`XDG_CONFIG_HOME=<dir>` inline on every command). `<binary>` below is
`brand.binary`.

34. **The README from the top.** `bun scripts/build.ts`, `sh scripts/install.sh --bin-dir <throwaway>/bin
    --no-profile` (never the default directory), `--version` under both names, `--demo list`, the showcase demo,
    the one-task quickstart in the tiny project, then the interactive one in tmux: a message, a steer while it
    works, `/queue <message>`, `/diff`, `/undo`, Ctrl-C during the model call and during `sleep 27`, Ctrl-D, `-c`;
    then `tui`. Note every place where what happens differs from the README's words, and read `--help` line by
    line. About 25 requests.
35. **Command files** (`docs/commands.md`). In the workspace `.<brand.directory>/commands/echo-args.md` (front
    matter with `description` and `argument-hint`; text: `Without using any tool, reply with exactly this one line
    and nothing else: FIRST=$1 SECOND=$2 ALL=$ARGUMENTS PRICE=$$5 HOME=$HOME`), `.claude/commands/frontend/test.md`
    (`NAMESPACED-OK`), a `broken.md` (a front-matter line without a colon), an `undo.md`; in the config home
    `commands/standup.md` (with a `` !`git status` `` line and an `@src/usage.ts` line) and an `echo-args.md` of the
    same name as the project's. One prompt: `'/echo-args one "two words" three'` (good: `FIRST=one SECOND=two words
    ALL=one "two words" three PRICE=$5 HOME=$HOME`). At the prompt: `/help`, `/ech-args x`, `/broken`,
    `/echo-args solo` (the warning about argument 2), `/frontend:test extra words`, `/standup` (two `left as text`
    warnings). About 6 requests.
36. **A project's hooks and language server.** `bun evals/dogfood/hooks-config.ts --project <workspace> --marker
    TAIL-MARKER --lsp <pyright's langserver.index.js from the uv cache> --wait-ms 4000`, committed. One prompt
    (every hook named as skipped, and how to approve). Line interface at 80 columns: each question, the marker on
    screen before answering, `y` to each one at a time (read which question each `approved:` line follows),
    `/hooks`, `/lsp`. Then `"Do exactly this, in order, one step at a time: 1) run 'git push origin main' with the
    shell tool once. 2) write SCRATCH.md containing the word tmp, using the write tool. 3) write greet.py using the
    write tool with: def greet(name: str) -> str returning a greeting, and a last line that calls gret(42)
    (misspelled on purpose; keep it). Then answer in one line what happened in each step."` (the refusal, two
    notes, the stop hook, the file removed), and a second edit of `greet.py` with the edit tool (`2 new
    diagnostics from python`). The full-screen interface on a fresh copy of the workspace (`cp -a`): is anything
    asked before the first message? Then change the marker (an edited hook) and open both interfaces again.
    From a subdirectory: `cd <workspace>/src` and the first two steps as one prompt (the hooks hold; read the
    ending's words after the stop hook). About 20 requests.
37. **A subagent in a worktree under the guard hooks** (the approved workspace of task 36, one prompt). `"Use a
    subagent with a worktree of its own (worktree: true) and this task: '1) run git push origin main with the shell
    tool once. 2) write the file .env containing A=1 with the write tool. 3) write note.txt containing hi with the
    write tool. Do not retry anything refused. Report exactly what each step returned.' Then tell me in one line
    per step what it reported."` Good: both refusals name their hook, `merged 1 file into the workspace: note.txt`,
    no worktree or branch left (`git worktree list`, `git branch`). About 6 requests.
38. **A project's MCP server before the first message** (`mcp-config.ts --project`). Line interface: the question
    comes at the start; `n`, then `/mcp approve warehouse`, `y`, `/mcp` (`running · 2 tools`), and task 17's
    question as the FIRST message (the answer `WH-F0239` in that turn; Ctrl-C at the tool's question once, then
    `"Try again now."` and `a`). Full-screen interface on a fresh copy: `/mcp`, `/mcp approve warehouse`. About 6
    requests.
39. **Agents and a follow-up**. `{ "agents": { "default": "careful" } }` and `agents/careful.md` (`Start every
    answer with the word USER-CAREFUL:`) in the config home; `.claude/agents/careful.md` (`PROJECT-CAREFUL:`) and
    `.claude/agents/planner.md` (`disallowed-tools: write, edit`) in the workspace. `"What is 2+2? One short line,
    no tools."` with no option (`USER-CAREFUL`), `--agent careful` (`PROJECT-CAREFUL`) and `--agent none`
    (neither): read what the screen says about which definition is in force. Then interactively with `--agent
    none`: a subagent that writes `sub1.txt` and reports its session ID; `/agent planner`; `"Send a follow-up to
    the subagent <id> …: create the file sub2.txt …. If that is refused, start a new subagent with the same
    task."` Good: the follow-up is refused, the new subagent runs as the planner and cannot write. About 10
    requests.
40. **What a user does while the agent works** (line interface, then the full-screen one with `{ "memory": {
    "enabled": true } }` in the config home, a workspace skill and a user skill).
    - A merge conflict: `"Use a subagent with a worktree of its own (worktree: true) and this task: first run
      'sleep 21' with the shell tool, then with the edit tool replace the first line of README.md with '# from the
      subagent' and also write the file other.txt containing hi. …"`; once `pgrep -a -x sleep` shows it, change
      the first line of `README.md` by hand. Good: `⚠ not merged, conflicts in: README.md`, the branch kept,
      the hand edit intact. Then `/undo`: is the hand edit kept, and is anything asked?
    - The same without a subagent: `"Run 'sleep 9' with the shell tool, then answer with the word done. Touch no
      file."`, a hand edit and a new file of your own during the sleep, then read the `· changed` line and `/undo`.
    - Full screen: `/skills`, `/memory`, `/wakeups`, `/remember <text>` before the first message; three reads with
      a steer and (Ctrl-T) a queued message; task 19's reminder and the firing; `/compact` typed during `sleep 19`
      and again when idle; Ctrl-C during task 15's `sleep 41` subagent (`pgrep`: nothing left); a second process
      on the open session (`--session <id> "Reply OK."`: refused, naming the pid); `/forget <id>`.
    About 30 requests.
41. **Forks of forks, replay under `execute`, telemetry.** `fork <id> --turn 1` on a session whose first turn was
    followed by a queued message (it must fork; the fourth pass got `seq … is inside a step`), `fork <id>` while a
    process holds the session, a fork of that fork, `fork <that> --copy --json`, and one prompt with an edit in
    the copy (exit 3: no `node_modules` there). Task 14's recording, then `replay <id> --policy execute --effort
    low --system-prompt <file saying to run 'echo PRE-EDIT' before editing>`: the report, the `compared on what
    it did` part and the copy it names (delete it). Telemetry: `bun evals/dogfood/otel-collector.ts --out <file>`
    (stop it by PID), `{ "telemetry": { "enabled": true, "endpoint": "<the address it printed>" } }` in a config
    home, one prompt that names a command, a path, a text and a subagent's command by unusual words, then
    `otel-collector.ts --check <file> <the words> /tmp/ <the workspace's name>`: every count must be 0. About 25
    requests.

The client commands for stopping one running call and for watching a background command's output were not in
`/help` when the fourth pass ran: try them when they are.

## Reading the results

- `bun evals/dogfood/calls.ts --cwd <workspace>...` for the requests spent.
- `--json` runs: the last line is `execution.succeeded` (or `execution.failed`); `checks.finished` carries each
  check's status, duration and the path of its full output.
- A cache share of 0% on one step in the middle of a turn is usually the provider's lag on a quick follow-up (see the
  harness-testing skill), not the harness.
