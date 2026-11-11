# evals

End-to-end tasks for testing the agent the way a user would: a small workspace, a prompt typed in a natural voice,
and a grader that checks the finished workspace.

```
evals/
  grader.ts          helpers for graders (pass/fail, run a command, compare with the original workspace)
  run-check.ts       copy a workspace, run setup, optionally apply the reference solution, grade
  graders.test.ts    every untouched workspace fails its grader; every reference solution passes
  tasks/<id>/
    task.json        { id, title, prompt, tags, timeoutSeconds, maxSteps, setup? }
    workspace/       the project the agent starts in
    check.ts         the grader: bun check.ts <finished-workspace>, exit 0 = pass, prints one line
    solve.ts         reference solution: bun solve.ts <workspace> (or solution.patch, applied with patch -p1)
```

Run one task by hand: `bun evals/run-check.ts <id>` (expect FAIL) and `bun evals/run-check.ts <id> --solve`
(expect PASS); `--keep` leaves the workspace in the temp directory. Run all graders with `bun test evals`.
An agent runner should reuse `prepareWorkspace(id)` and `grade(id, dir)` from `run-check.ts`.

## Workspace conventions

- A file stored as `name.in` is copied into the workspace as `name`. Test files (`*.test.ts`) are stored this way so
  the repository's own `bun test` does not pick up the deliberately failing tests.
- `setup` is an argv run in the copied workspace before the agent starts. Use it for anything large or generated;
  generated files are never committed (see `.gitignore`).
- `.git` and `node_modules` in a finished workspace are ignored by graders.

## Adding a task

1. Create `tasks/<id>/` with the files above. `id` in `task.json` must equal the directory name.
2. Write the prompt as a user would type it: say what they want, not how to do it.
3. The grader judges the outcome, not the method. It must fail on the untouched workspace and on a plausible wrong
   answer (hard-coding, editing the tests instead of the code, touching files it should not), and must never need
   the network. Prefer hidden inputs the agent has not seen over checking the exact diff.
4. Write the reference solution and run `bun test evals`.

## The rule

Every workspace is synthetic and hand-written for this purpose: a few small files, no code copied from real
projects or other repositories, no secrets or real personal data, no dependencies beyond Bun's built-ins.
