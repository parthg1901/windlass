# tasks

A tiny to-do list for the terminal.

    bun src/cli.ts add "Buy milk"
    bun src/cli.ts list
    bun src/cli.ts done 1

Tasks are kept in `.tasks.json` in the current directory (`TASKS_FILE` overrides the path). `bun test` runs the
tests.
